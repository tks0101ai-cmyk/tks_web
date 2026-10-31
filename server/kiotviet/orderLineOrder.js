'use strict';

// SAP DONG HANG DON DAT HANG THEO THU TU THAT CUA KIOTVIET. Public API tra `orderDetails` theo productId tang dan;
// thu tu that (man hinh + ban in Kiot) = Id dong tang dan, chi doc duoc qua API noi bo (kiotInternalClient).
// Dung o MOT cho: truoc khi ghi order_details (line_no) khi dong bo, va truoc khi PUT don tu kiotOrderEditor.
// Fail-soft: chua cau hinh / loi mang / dong khong khop -> giu nguyen thu tu Public API.
const { createKiotInternalClient, credentialsFor } = require('./kiotInternalClient');

const RECENT_DAYS = 45;          // don cu hon khong con in -> khong goi API noi bo khi backfill
const CONCURRENCY = 4;
const COOLDOWN_MS = 10 * 60 * 1000; // dang nhap/goi loi -> nghi 10 phut roi moi thu lai

const num = v => Number(v);
const detailsOf = order => (Array.isArray(order.orderDetails) ? order.orderDetails : null);

/**
 * HAM THUAN. Sap `details` (Public API) theo `lines` (API noi bo, da theo Id tang dan), ghep theo (productId, SL).
 * Tra mang moi; null neu khong ghep duoc tron ven (so dong lech, thieu dong...).
 */
function orderDetailsByKiotLines(details, lines) {
  if (!Array.isArray(details) || !Array.isArray(lines) || details.length !== lines.length) return null;
  const pool = details.map(detail => ({ detail, used: false }));
  const out = [];
  for (const line of lines) {
    const hit = pool.find(item => !item.used && num(item.detail.productId) === line.productId
      && Math.abs(num(item.detail.quantity) - line.quantity) < 1e-6)
      || pool.find(item => !item.used && num(item.detail.productId) === line.productId);
    if (!hit) return null;
    hit.used = true;
    out.push(hit.detail);
  }
  return out;
}

function isRecent(order, now) {
  const at = Date.parse(order.purchaseDate || order.createdDate || '');
  return !Number.isFinite(at) || now - at <= RECENT_DAYS * 86400000;
}

/**
 * @param {object} [options]
 * @param {function} [options.clientFor] (branch) -> client co fetchOrderLines, hoac null khi chua cau hinh.
 */
function createOrderLineSorter({ clientFor, now = Date.now, log = console } = {}) {
  const clients = new Map();
  const pausedUntil = new Map();
  const defaultClientFor = branch => {
    if (!clients.has(branch)) {
      const creds = credentialsFor(branch);
      clients.set(branch, creds ? createKiotInternalClient(creds) : null);
    }
    return clients.get(branch);
  };
  const getClient = clientFor || defaultClientFor;

  /** Sap lai orderDetails cua 1 don (tra don moi, hoac chinh don do neu khong sap duoc). */
  async function sortOrder(branch, order, { force = false } = {}) {
    const details = detailsOf(order);
    if (!details || details.length < 2 || (!force && !isRecent(order, now()))) return order;
    if ((pausedUntil.get(branch) || 0) > now()) return order;
    const client = getClient(branch);
    if (!client || order.id == null) return order;
    try {
      const sorted = orderDetailsByKiotLines(details, await client.fetchOrderLines(order.id));
      if (!sorted) {
        log.warn(`[OrderLineOrder] ${branch} ${order.code}: dong API noi bo khong khop Public API, giu thu tu cu.`);
        return order;
      }
      return { ...order, orderDetails: sorted };
    } catch (error) {
      pausedUntil.set(branch, now() + COOLDOWN_MS);
      log.warn(`[OrderLineOrder] ${branch}: tam dung 10 phut — ${error.message}`);
      return order;
    }
  }

  async function sortOrders(branch, orders) {
    const out = orders.slice();
    let next = 0;
    const worker = async () => {
      while (next < out.length) {
        const i = next++;
        out[i] = await sortOrder(branch, out[i]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, out.length) }, worker));
    return out;
  }

  return { sortOrder, sortOrders };
}

const defaultSorter = createOrderLineSorter();

module.exports = { orderDetailsByKiotLines, createOrderLineSorter, defaultSorter, RECENT_DAYS };
