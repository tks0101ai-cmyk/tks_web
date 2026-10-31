'use strict';

// Ghi NGUOC len don dat hang KiotViet (PUT /orders/{id}) tu hop "Chi dinh vi tri": xoa dong hang va sua so luong.
// Nguon API: "KiotViet Public API user manual" muc 2.5.4 (Cap nhat dat hang) -- PUT thay TOAN BO don bang body gui len, nen:
//   1. Doc don hien tai (GET /orders/{id}) roi dung lai moi truong (khach, nhan vien, giam gia, ghi chu, giao hang, phu thu...),
//      chi doi `orderDetails`. Khong bao gio dung du lieu tu trinh duyet de ghi len Kiot.
//   2. Ghi xong DOC LAI don va doi chieu (dong hang, tien, thanh toan, phu thu...). Lech -> tu dong PUT lai ban goc (khoi phuc).
//   3. Doi chieu dat → upsert don vao DB cuc bo (cung ham cua dong bo) de dashboard thay ngay, khong cho job dong bo.
// Moi thao tac ghi nhat ky vao order_kiot_edit_log (fail-soft neu chua ap migration 0102) va chay tuan tu theo don.
const { tx } = require('../stockPositions/stockPositionsService');

const { fail, DB_BRANCH } = tx;
const lower = value => String(value ?? '').trim().toLowerCase();
const isVat = code => lower(code).startsWith('vat');
const same = (a, b) => (Number(a) || 0) === (Number(b) || 0) || Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1e-6;
const clean = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

function enabled(env = process.env) {
  return String(env.KIOT_ORDER_WRITE_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
}

function detailOf(line) {
  return clean({
    productId: line.productId, productCode: line.productCode, productName: line.productName,
    quantity: line.quantity, price: line.price, discount: line.discount, discountRatio: line.discountRatio, note: line.note
  });
}

/** HAM THUAN. Body PUT = don hien tai + danh sach dong moi (dong VAT* va moi truong khac giu nguyen). */
function buildBody(order, details) {
  const payment = Array.isArray(order.payments) ? order.payments.find(p => p && p.accountId != null) : null;
  const surcharges = Array.isArray(order.invoiceOrderSurcharges) ? order.invoiceOrderSurcharges : [];
  return clean({
    purchaseDate: order.purchaseDate,
    branchId: order.branchId,
    soldById: order.soldById,
    discount: order.discount,
    description: order.description,
    method: order.method,
    totalPayment: order.totalPayment,
    accountId: payment ? payment.accountId : undefined,
    makeInvoice: false,
    saleChannelId: order.saleChannelId,
    customer: order.customerId ? clean({ id: order.customerId, code: order.customerCode, name: order.customerName }) : undefined,
    orderDelivery: order.orderDelivery || undefined,
    surchages: surcharges.length ? surcharges.map(s => clean({ id: s.surchargeId ?? s.id, price: s.price ?? s.surValue })) : undefined,
    orderDetails: details.map(detailOf)
  });
}

const goodsLines = details => details.filter(line => !isVat(line.productCode));

/** HAM THUAN. Xoa moi dong cua ma hang; loi 400 neu khong co ma do hoac don se het dong hang. */
function planRemoval(details, productCode) {
  const key = lower(productCode);
  if (!details.some(line => lower(line.productCode) === key && !isVat(line.productCode))) {
    throw fail(400, 'VALIDATION', `Mã hàng ${productCode || '(trống)'} không có trong đơn Kiot.`);
  }
  const next = details.filter(line => lower(line.productCode) !== key || isVat(line.productCode));
  if (!goodsLines(next).length) {
    throw fail(400, 'LAST_LINE', 'Không thể xóa dòng hàng cuối cùng của đơn. Hãy hủy đơn trên KiotViet nếu cần.');
  }
  return next;
}

/**
 * HAM THUAN. Dat SL cua tung ma ({ ma hang: SL }). Ma co nhieu dong Kiot -> gop thanh MOT dong o vi tri dong dau
 * (gia/chiet khau binh quan theo SL neu khac nhau, ghi chu gop). Tra danh sach dong moi.
 */
function planQuantities(details, quantities) {
  let next = details.map(line => ({ ...line }));
  for (const [code, value] of Object.entries(quantities || {})) {
    const key = lower(code);
    const qty = Number(value);
    if (typeof value === 'boolean' || value === null || value === '' || !Number.isSafeInteger(qty) || qty <= 0) {
      throw fail(400, 'VALIDATION', `${code}: số lượng phải là số chiếc nguyên dương.`, { field: 'needs' });
    }
    const rows = next.filter(line => lower(line.productCode) === key && !isVat(line.productCode));
    if (!rows.length) throw fail(400, 'VALIDATION', `Mã hàng ${code || '(trống)'} không có trong đơn Kiot.`, { field: 'needs' });
    const [first] = rows;
    if (rows.length > 1) {
      const total = rows.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0) || 1;
      const avg = field => Math.round(rows.reduce((sum, row) => sum + (Number(row[field]) || 0) * (Number(row.quantity) || 0), 0) / total * 100) / 100;
      const notes = [...new Set(rows.map(row => String(row.note || '').trim()).filter(Boolean))];
      const equal = rows.every(row => same(row.price, first.price) && same(row.discount, first.discount));
      if (!equal) { first.price = avg('price'); first.discount = avg('discount'); first.discountRatio = undefined; }
      if (notes.length) first.note = notes.join('; ');
    }
    first.quantity = qty;
    next = next.filter(line => line === first || lower(line.productCode) !== key || isVat(line.productCode));
  }
  return next;
}

const moneyKeys = ['discount', 'totalPayment'];

/** HAM THUAN. Doi chieu don doc lai voi dong hang du kien + cac truong khong duoc doi. Tra danh sach loi (rong = dat). */
function verifyAfter(before, after, expected) {
  const problems = [];
  const got = Array.isArray(after.orderDetails) ? after.orderDetails : [];
  if (got.length !== expected.length) problems.push(`số dòng hàng ${got.length} ≠ ${expected.length} dự kiến`);
  const pool = got.map(line => ({ line, used: false }));
  for (const want of expected) {
    const hit = pool.find(item => !item.used && lower(item.line.productCode) === lower(want.productCode)
      && same(item.line.quantity, want.quantity) && same(item.line.price, want.price)
      && same(item.line.discount, want.discount) && String(item.line.note || '') === String(want.note || ''));
    if (!hit) problems.push(`dòng ${want.productCode} (SL ${want.quantity}) không khớp sau khi ghi`);
    else hit.used = true;
  }
  for (const key of ['soldById', 'customerId', 'branchId']) {
    if (String(before[key] ?? '') !== String(after[key] ?? '')) problems.push(`${key} bị đổi`);
  }
  // Giam gia theo % do Kiot tinh lai theo tong moi nen khong doi chieu so tien giam; totalPayment (khach da tra) khong duoc doi.
  for (const key of moneyKeys) {
    if (key === 'discount' && Number(before.discountRatio) > 0) continue;
    if (!same(before[key], after[key])) problems.push(`${key} bị đổi (${before[key]} → ${after[key]})`);
  }
  if (String(before.description || '') !== String(after.description || '')) problems.push('ghi chú đơn bị đổi');
  if (String(before.statusValue || before.status || '') !== String(after.statusValue || after.status || '')) problems.push('trạng thái đơn bị đổi');
  const payments = order => (Array.isArray(order.payments) ? order.payments : []);
  if (payments(before).length !== payments(after).length
    || !same(payments(before).reduce((s, p) => s + (Number(p.amount) || 0), 0), payments(after).reduce((s, p) => s + (Number(p.amount) || 0), 0))) {
    problems.push('thanh toán của đơn bị đổi');
  }
  const surcharges = order => (Array.isArray(order.invoiceOrderSurcharges) ? order.invoiceOrderSurcharges : []);
  if (surcharges(before).length !== surcharges(after).length) problems.push('phụ thu của đơn bị đổi');
  if (JSON.stringify(before.orderDelivery?.receiver ?? null) !== JSON.stringify(after.orderDelivery?.receiver ?? null)
    || JSON.stringify(before.orderDelivery?.address ?? null) !== JSON.stringify(after.orderDelivery?.address ?? null)) {
    problems.push('thông tin giao hàng bị đổi');
  }
  return problems;
}

// Thong diep loi Kiot: "HTTP 400: {"responseStatus":{"message":"..."}}" -> phan message de nguoi dung doc duoc.
function kiotMessage(error) {
  const text = String(error && error.message || '');
  const match = /"message"\s*:\s*"([^"]+)"/.exec(text);
  return match ? match[1] : text.replace(/^HTTP \d+:\s*/, '').slice(0, 200) || 'không rõ lỗi';
}

function createKiotOrderEditor({
  getDb = () => require('../db/pool').getPool(),
  getBranchConfig = dbBranch => require('../kiotvietSync/config').getConfiguredBranches({ warn: () => {} }).find(item => item.branch === dbBranch),
  createClient = require('./kiotVietApiClient').createKiotVietClient,
  persistOrder = async (db, dbBranch, order) => {
    const entity = require('../kiotvietSync/entities/orders');
    await tx.withTransaction(db, client => entity.upsertPage(client, dbBranch, [order]));
  },
  isEnabled = enabled,
  // Public API tra dong theo productId: sap lai theo thu tu that truoc khi PUT, neu khong PUT se ghi de thu tu sale da nhap.
  sortLines = (dbBranch, order) => require('./orderLineOrder').defaultSorter.sortOrder(dbBranch, order, { force: true })
} = {}) {
  const queues = new Map();
  // Tuan tu theo don: hai nguoi cung sua mot don khong the doc-sua-ghi chong len nhau.
  function serial(key, work) {
    const run = (queues.get(key) || Promise.resolve()).catch(() => {}).then(work);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }

  async function log(db, branch, orderCode, action, summary, actor) {
    try {
      await db.query(
        'INSERT INTO order_kiot_edit_log (branch, order_code, action, summary, actor_user_id, actor_name) VALUES ($1, $2, $3, $4::jsonb, $5, $6)',
        [branch, orderCode, action, JSON.stringify(summary), actor && actor.id != null ? String(actor.id) : null, (actor && actor.name) || '']);
    } catch (error) {
      if (error && error.code !== '42P01') console.error('[KiotOrderEditor] log failed:', error.code || error.message);
      else console.warn('[KiotOrderEditor] chua ap migration 0102, bo qua nhat ky.');
    }
  }

  async function edit({ branch, orderCode, action, plan, actor }) {
    if (!isEnabled()) throw fail(403, 'KIOT_WRITE_DISABLED', 'Tính năng ghi ngược lên KiotViet đang tắt (KIOT_ORDER_WRITE_ENABLED=false).');
    const dbBranch = DB_BRANCH[branch];
    const config = dbBranch && getBranchConfig(dbBranch);
    if (!config) throw fail(424, 'KIOT_NOT_CONFIGURED', 'Chưa cấu hình tài khoản KiotViet cho cơ sở này.');
    const db = getDb();
    const row = (await db.query('SELECT id FROM orders WHERE branch = $1 AND lower(btrim(code)) = $2 LIMIT 1', [dbBranch, lower(orderCode)])).rows[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng này trong dữ liệu KiotViet.');
    return serial(`${dbBranch}|${lower(orderCode)}`, async () => {
      const client = createClient({ ...config, requestOptions: { maxRetries: 2, timeoutMs: 20000 } });
      const id = row.id;
      let before;
      try { before = await client.fetchOrderById(id); } catch (error) {
        throw fail(424, 'KIOT_READ_FAILED', `Không đọc được đơn từ KiotViet: ${kiotMessage(error)}`);
      }
      before = await sortLines(dbBranch, before);
      const current = Array.isArray(before.orderDetails) ? before.orderDetails : [];
      const next = plan(current);
      const changed = JSON.stringify(next.map(detailOf)) !== JSON.stringify(current.map(detailOf));
      if (!changed) return { changed: false, order: before };
      const originalBody = buildBody(before, current);
      const body = buildBody(before, next);
      try { await client.updateOrder(id, body); } catch (error) {
        throw fail(422, 'KIOT_REJECTED', `KiotViet không cho sửa đơn này: ${kiotMessage(error)}`);
      }
      let after;
      let problems;
      try {
        after = await client.fetchOrderById(id);
        problems = verifyAfter(before, after, next.map(detailOf));
      } catch (error) {
        problems = [`không đọc lại được đơn để đối chiếu (${kiotMessage(error)})`];
      }
      if (problems.length) {
        // Khoi phuc cung phai duoc DOC LAI doi chieu: neu Kiot bo qua mot truong (vd ghi chu dong) thi PUT ban goc cung mat truong do.
        let restored = false;
        try {
          await client.updateOrder(id, originalBody);
          restored = !verifyAfter(before, await client.fetchOrderById(id), current.map(detailOf)).length;
        } catch (error) { /* bao ben duoi */ }
        await log(db, branch, orderCode, 'rollback', { problems, restored, attempted: action }, actor);
        console.error('[KiotOrderEditor] verify failed', branch, orderCode, problems, 'restored=' + restored);
        throw fail(409, restored ? 'KIOT_VERIFY_FAILED' : 'KIOT_ROLLBACK_FAILED',
          (restored ? 'KiotViet ghi không đúng nên đã khôi phục đơn về như cũ. ' : 'KiotViet ghi không đúng và KHÔNG khôi phục được tự động, hãy kiểm tra đơn trên Kiot ngay. ')
          + problems.join('; ') + '.');
      }
      await log(db, branch, orderCode, action.type, {
        ...action.summary, before: current.map(detailOf), after: next.map(detailOf)
      }, actor);
      try { await persistOrder(db, dbBranch, after); } catch (error) {
        console.error('[KiotOrderEditor] khong cap nhat duoc DB cuc bo (job dong bo se bu):', error.message);
      }
      return { changed: true, order: after };
    });
  }

  return {
    enabled: isEnabled,
    removeLine: ({ branch, orderCode, productCode, actor }) => edit({
      branch, orderCode, actor,
      action: { type: 'remove_line', summary: { productCode } },
      plan: details => planRemoval(details, productCode)
    }),
    setQuantities: ({ branch, orderCode, quantities, actor }) => edit({
      branch, orderCode, actor,
      action: { type: 'set_quantity', summary: { quantities } },
      plan: details => planQuantities(details, quantities)
    })
  };
}

module.exports = { createKiotOrderEditor, buildBody, planRemoval, planQuantities, verifyAfter, kiotMessage, enabled };
