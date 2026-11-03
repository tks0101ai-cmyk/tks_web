'use strict';

// Chi dinh vi tri hang cho don (trang Vong doi don hang) — migration 0096.
//   picking   = Dang nhat: giu cho tren dong vi tri (stock_positions), CHUA doi ghi chu thung.
//   confirmed = Xac nhan nhat: tru thung that (stock_position_history action 'pick').
//   cancelled = Huy nhat: tra giu cho (Huy chi ap dung cho 'picking'). 'confirmed' chi doi duoc bang chi dinh lai (assign reassign):
//   hoan thung da tru (action 'pick_revert') roi huy luot cu + tao luot Dang nhat moi trong 1 giao dich.
// Moi thao tac ghi chay trong 1 giao dich co khoa advisory theo co so (cung khoa voi stockPositionsService) + FOR UPDATE
// cac dong vi tri theo id, nen khong the chi dinh/tru vuot ton khi nhieu nguoi cung thao tac.
// Ton kha dung cua vi tri = SL (tinh tu ghi chu, carton.parseSpec) - tong giu cho (reserved_qty) cua cac chi dinh 'picking' o DON KHAC.
const { getPool } = require('../db/pool');
const carton = require('../public/shared/carton.js');
const rules = require('../public/shared/pick-rules.js');
const { makeAllocationSnapshot, allocationMatches, deductAllocation } = require('./pickAssignmentSnapshot');
const { makeOrderSnapshot } = require('./pickOrderSnapshot');
const { tx, createStockPositionsService } = require('../stockPositions/stockPositionsService');
const kiotData = require('./pickKiotData');
const { timedOperation, timedQuery } = require('../lib/requestTiming');

const {
  withTransaction: runTransaction, lockBranch: acquireBranchLock, writeHistory, removeRow, fail, assertBranch, assertScope, actorOf,
  lower, normalizeLocation, isEmptyNote, isoOf, ROW_COLUMNS
} = tx;

const withTransaction = (pool, work) => timedOperation('pickTransaction', () => runTransaction({
  connect: () => timedOperation('pickPool', () => pool.connect())
}, work));
const lockBranch = (client, branch) => timedOperation('pickLock', () => acquireBranchLock(client, branch));

const STATUS = Object.freeze({ PICKING: 'picking', CONFIRMED: 'confirmed', CANCELLED: 'cancelled' });
// Ly do huy ghi trong order_pick_history.summary.reason (khong can migration). 'kiot_cancelled': don bi huy tren Kiot — giao
// dien hien "Chua boc" thay vi "Da huy" (latestStatuses bo dong nay khoi ban do).
const CANCEL_REASON = Object.freeze({ MANUAL: 'manual', REASSIGN: 'reassign', KIOT: 'kiot_cancelled' });
// Ly do bo dong chi dinh (order_pick_history action 'prune', 0103): xoa bang nut "Xoa dong" / ma khong con tren don Kiot da dong bo.
const PRUNE_REASON = Object.freeze({ LINE_REMOVED: 'line_removed', KIOT_MISSING: 'kiot_line_missing' });
// Nguoi thuc hien cua cac chuyen trang thai tu dong theo Kiot (lich su ghi ten nay).
const KIOT_CTX = Object.freeze({ user: Object.freeze({ id: null, hoTen: 'Hệ thống (KiotViet)', username: 'kiot-sync' }) });
const MAX_ALLOCATIONS = 500;
const AVAILABILITY_ERROR = /vượt số lượng khả dụng/u;

const codeKey = value => String(value ?? '').trim().toLowerCase();
const num = value => (value === null || value === undefined ? null : Number(value));

function quantityErrors(order) {
  const errors = [];
  const totals = new Map();
  for (const line of Array.isArray(order.lines) ? order.lines : []) {
    const key = codeKey(line.productCode);
    if (!key || line.isService || key.startsWith('vat')) continue;
    const qty = Number(line.quantity);
    const total = (totals.get(key) || 0) + qty;
    if (!Number.isSafeInteger(qty) || qty <= 0 || !Number.isSafeInteger(total)) {
      errors.push(`${line.productCode}: số lượng nhặt phải là số chiếc nguyên dương trong giới hạn cho phép.`);
    }
    totals.set(key, total);
  }
  return errors;
}

/**
 * Dong don Kiot -> dong chi dinh: bo dong dich vu (VAT*), GOP theo ma hang (khong phan biet hoa/thuong).
 * Gia / chiet khau: cung gia thi giu nguyen, khac gia thi binh quan theo so luong. Ghi chu dong: gop cac ghi chu khac nhau (ngan cach "; ").
 */
function mergeOrderLines(lines) {
  const merged = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const key = codeKey(line.productCode);
    if (!key || line.isService || key.startsWith('vat')) continue;
    const quantity = Number(line.quantity) || 0;
    if (quantity <= 0) continue;
    const price = Number(line.price) || 0;
    const discount = Number(line.discount) || 0;
    const hit = merged.get(key);
    if (!hit) {
      merged.set(key, { productCode: String(line.productCode).trim(), productName: String(line.productName || '').trim(), quantity, price, discount, note: String(line.note || '').trim(), _p: price * quantity, _d: discount * quantity, _same: true });
    } else {
      hit.quantity += quantity;
      hit._same = hit._same && hit.price === price && hit.discount === discount;
      hit._p += price * quantity;
      hit._d += discount * quantity;
      if (!hit.productName && line.productName) hit.productName = String(line.productName).trim();
      // Ghi chú từng dòng Kiot (vd "15th", "full vat"): gộp các ghi chú khác nhau của cùng mã, bỏ trùng.
      const extra = String(line.note || '').trim();
      if (extra && !hit.note.split('; ').includes(extra)) hit.note = hit.note ? hit.note + '; ' + extra : extra;
    }
  }
  return [...merged.values()].map(({ _p, _d, _same, ...line }) => (_same ? line
    : { ...line, price: Math.round(_p / line.quantity * 100) / 100, discount: Math.round(_d / line.quantity * 100) / 100 }));
}

/**
 * SL can nhat do nguoi dung sua tay: `needs` { ma hang: SL } (ma thieu = SL Kiot). Tra { lines, order }:
 *  - lines: dong da gop theo ma voi `quantity` = SL can nhat (ma sua kem `kiotQuantity` = SL Kiot) — dung de kiem tra phan bo;
 *  - order: don dung de lap snapshot — moi ma co SL sua khac SL Kiot thi cac dong Kiot cua ma do gop thanh MOT dong (gia binh quan) o vi tri dong dau.
 * SL phai la so nguyen duong trong gioi han; ma khong co trong don -> loi 400.
 */
function applyNeeds(order, lines, needs) {
  if (needs === undefined || needs === null) return { lines, order };
  if (typeof needs !== 'object' || Array.isArray(needs)) throw fail(400, 'VALIDATION', 'Số lượng cần nhặt không hợp lệ.', { field: 'needs' });
  const wanted = new Map();
  for (const [code, value] of Object.entries(needs)) {
    const key = codeKey(code);
    const line = lines.find(item => codeKey(item.productCode) === key);
    if (!line) throw fail(400, 'VALIDATION', `Mã hàng ${code || '(trống)'} không có trong đơn.`, { field: 'needs' });
    const qty = Number(value);
    if (typeof value === 'boolean' || value === null || value === '' || !Number.isSafeInteger(qty) || qty <= 0) {
      throw fail(400, 'VALIDATION', `${line.productCode}: số lượng cần nhặt phải là số chiếc nguyên dương.`, { field: 'needs' });
    }
    if (qty !== line.quantity) wanted.set(key, qty);
  }
  if (!wanted.size) return { lines, order };
  const edited = lines.map(line => (wanted.has(codeKey(line.productCode)) ? { ...line, quantity: wanted.get(codeKey(line.productCode)), kiotQuantity: line.quantity } : line));
  const placed = new Set();
  const orderLines = [];
  for (const raw of Array.isArray(order.lines) ? order.lines : []) {
    const key = codeKey(raw.productCode);
    if (!wanted.has(key)) { orderLines.push(raw); continue; }
    if (placed.has(key)) continue;
    placed.add(key);
    orderLines.push({ ...raw, ...edited.find(line => codeKey(line.productCode) === key) });
  }
  return { lines: edited, order: { ...order, lines: orderLines } };
}

/**
 * Ma hang nguoi dung bo khoi chi dinh (nut "Xoa dong" trong hop, KHONG sua don Kiot): `removed` [ma hang]. Tra { lines, order } da bo
 * moi dong cua cac ma do (ca dong Kiot chua gop trong order.lines, de snapshot / phieu in khong con ma). Ma khong co trong don -> 400;
 * bo het moi dong -> 400.
 */
function applyRemovals(order, lines, removed) {
  if (removed === undefined || removed === null) return { lines, order };
  if (!Array.isArray(removed)) throw fail(400, 'VALIDATION', 'Danh sách mã bỏ không hợp lệ.', { field: 'removed' });
  const drop = new Set();
  for (const code of removed) {
    const key = codeKey(code);
    if (!key || !lines.some(line => codeKey(line.productCode) === key)) throw fail(400, 'VALIDATION', `Mã hàng ${code || '(trống)'} không có trong đơn.`, { field: 'removed' });
    drop.add(key);
  }
  if (!drop.size) return { lines, order };
  const kept = lines.filter(line => !drop.has(codeKey(line.productCode)));
  if (!kept.length) throw fail(400, 'VALIDATION', 'Đơn phải còn ít nhất một dòng hàng cần nhặt.', { field: 'removed' });
  const orderLines = (Array.isArray(order.lines) ? order.lines : []).filter(line => !drop.has(codeKey(line.productCode)));
  return { lines: kept, order: { ...order, lines: orderLines } };
}

// Nguon don mac dinh: trang thai tu bang gop Vong doi don hang + dong hang tu don Kiot (khong tin du lieu tu trinh duyet).
async function defaultLoadOrder({ branch, orderCode }) {
  const kiot = require('../shipment/kiotOrdersRepository').kiotOrders;
  const lifecycle = require('../shipment/orderLifecycleService');
  const row = await lifecycle.findPickingOrder(branch, orderCode, { kiot });
  if (!row) return null;
  const detail = await kiot.readPickingDetail({ branch, code: row.orderCode });
  return {
    branch,
    orderCode: row.orderCode,
    customerName: row.customerName || detail.customerName || '',
    saleName: row.saleName || detail.seller || '',
    saleTelegramId: row.saleTelegramId || '',
    orderDate: row.orderDate || detail.date || '',
    status: { code: row.summary.code, label: row.summary.label },
    invoiceDiscount: Number(detail.discount) || 0,
    customerPhone: detail.customerPhone || '',
    customerAddress: detail.customerAddress || '',
    sellerPhone: detail.sellerPhone || await timedOperation('sellerPhone',()=>kiotData.readSellerPhone(tx.DB_BRANCH[branch], detail.sellerId)),
    note: detail.note || row.note || '',
    lines: detail.lines
  };
}

function createPickAssignmentsService({ getDb = getPool, loadOrder = defaultLoadOrder,
  loadSellerPhone = loadOrder === defaultLoadOrder ? kiotData.loadSellerPhone : null,
  // Them / sua ghi chu / xoa dong VT ngay trong hop Chi dinh vi tri: di qua service VT (khoa co so, lich su, SSE trang VT).
  stockPositions = createStockPositionsService({ getDb }) } = {}) {
  // ---------- Doc / dinh dang ----------

  async function readAssignment(db, id, { inTransaction = false, supplementPhone = true } = {}) {
    const head = (await db.query('SELECT * FROM order_pick_assignments WHERE id = $1', [id])).rows[0];
    if (!head) return null;
    // Older snapshots have no seller contact: supplement the print response without rewriting history.
    const snapshot = {...(head.order_snapshot || {})};
    const loadLines = () => db.query('SELECT * FROM order_pick_lines WHERE assignment_id = $1 ORDER BY id', [id]);
    const loadHistory = () => db.query('SELECT created_at, action, actor_name, summary FROM order_pick_history WHERE assignment_id = $1 ORDER BY id', [id]);
    let lines, history;
    if (inTransaction) {
      // Conflict responses run under locks. Read only persisted snapshot data;
      // never call Kiot or start competing queries on the transaction client.
      lines = (await loadLines()).rows;
      history = (await loadHistory()).rows;
    } else {
      const [lineResult, historyResult] = await Promise.all([loadLines(), loadHistory(),
        supplementPhone && !snapshot.sellerPhone && loadSellerPhone
          ? timedOperation('sellerPhone',async()=>{snapshot.sellerPhone=await loadSellerPhone(db,head.branch,head.order_code);})
          : Promise.resolve()]);
      lines = lineResult.rows;
      history = historyResult.rows;
    }
    const at = value => (value ? isoOf(value) : null);
    return {
      id: Number(head.id),
      branch: head.branch,
      orderCode: head.order_code,
      status: head.status,
      version: head.version,
      assignedByName: head.assigned_by_name,
      assignedAt: at(head.assigned_at),
      confirmedByName: head.confirmed_by_name || null,
      confirmedAt: at(head.confirmed_at),
      cancelledByName: head.cancelled_by_name || null,
      cancelledAt: at(head.cancelled_at),
      snapshot,
      lines: lines.map(line => ({
        id: Number(line.id),
        productCode: line.product_code,
        positionId: Number(line.position_id),
        location: line.location,
        plannedQty: num(line.planned_qty),
        reservedQty: num(line.reserved_qty),
        stCartons: num(line.st_cartons),
        stText: line.st_text,
        pickedQty: num(line.picked_qty),
        specBefore: line.spec_before,
        specAfter: line.spec_after
      })),
      history: history.map(row => ({ at: isoOf(row.created_at), action: row.action, actorName: row.actor_name, summary: row.summary || null }))
    };
  }

  async function readLatestId(db, branch, orderCode) {
    const row = (await db.query(
      'SELECT id FROM order_pick_assignments WHERE branch = $1 AND lower(btrim(order_code)) = $2 ORDER BY id DESC LIMIT 1',
      [branch, codeKey(orderCode)])).rows[0];
    return row ? Number(row.id) : null;
  }

  async function readLatest(db, branch, orderCode, options) {
    const id = await readLatestId(db, branch, orderCode);
    return id === null ? null : readAssignment(db, id, options);
  }

  // Giu cho hien co theo vi tri: chi chi dinh 'picking' cua DON KHAC (exceptOrder bo qua chinh don dang xem/chi dinh).
  async function heldByPosition(db, branch, positionIds, exceptOrder) {
    const held = new Map();
    if (!positionIds.length) return held;
    const { rows } = await db.query(
      `SELECT l.position_id, COALESCE(SUM(l.reserved_qty), 0) AS held
         FROM order_pick_lines l JOIN order_pick_assignments a ON a.id = l.assignment_id
        WHERE a.status = 'picking' AND a.branch = $1 AND l.position_id = ANY($2::bigint[])
          AND lower(btrim(a.order_code)) <> $3
        GROUP BY l.position_id`,
      [branch, positionIds, codeKey(exceptOrder)]);
    for (const row of rows) held.set(Number(row.position_id), Number(row.held));
    return held;
  }

  function shapeCandidate(row, held) {
    const spec = carton.parseSpec(row.notes);
    const onHand = spec ? spec.quantity : null;
    return {
      positionId: Number(row.id),
      code: row.code,
      name: row.name,
      location: row.location,
      notes: row.notes,
      version: row.version,
      onHand,
      held,
      available: onHand === null ? null : Math.max(0, onHand - held),
      warnings: carton.warnings(row.notes)
    };
  }

  function orderView(order, lines) {
    const validationErrors = quantityErrors(order);
    return {
      branch: order.branch,
      orderCode: order.orderCode,
      customerName: order.customerName,
      saleName: order.saleName,
      saleTelegramId: order.saleTelegramId,
      orderDate: order.orderDate,
      status: order.status,
      eligible: validationErrors.length === 0, // chi dinh o MOI trang thai vong doi
      validationErrors,
      lines
    };
  }

  async function requireOrder(branch, orderCode) {
    const order = await timedOperation('pickOrder',()=>loadOrder({ branch, orderCode }));
    if (!order) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đơn hàng này.');
    return { order, lines: mergeOrderLines(order.lines) };
  }

  function cleanOrderCode(value) {
    const code = typeof value === 'string' ? value.trim() : '';
    if (!code || code.length > 100) throw fail(400, 'VALIDATION', 'Thiếu hoặc sai mã đơn hàng.', { field: 'orderCode' });
    return code;
  }

  // ---------- API ----------

  // Dong don (da gop theo ma) + cac vi tri ung vien kem ton kha dung, va chi dinh moi nhat cua don (neu co).
  async function candidates(ctx, { branch, orderCode } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const code = cleanOrderCode(orderCode);
    const { order, lines } = await requireOrder(branch, code);
    const db = getDb();
    const keys = [...new Set(lines.map(line => codeKey(line.productCode)))];
    const rows = keys.length
      ? (await timedQuery(db,'pickPositions',`SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 AND lower(btrim(code)) = ANY($2::text[]) ORDER BY id`, [branch, keys])).rows
      : [];
    const held = await timedOperation('pickHeld',()=>heldByPosition(db, branch, rows.map(row => Number(row.id)), order.orderCode));
    const byCode = {};
    for (const key of keys) byCode[key] = [];
    for (const row of rows) byCode[codeKey(row.code)].push(shapeCandidate(row, held.get(Number(row.id)) || 0));
    // loadOrder already spent this request's contact-lookup budget. Reuse its
    // result for old snapshots rather than waiting on a second cold lookup.
    const assignment = await readLatest(db, branch, order.orderCode, {supplementPhone:false});
    if (assignment && !assignment.snapshot.sellerPhone && order.sellerPhone) assignment.snapshot.sellerPhone = order.sellerPhone;
    return { order: orderView(order, lines), candidates: byCode, assignment };
  }

  // Snapshot sau khi bo cac ma `isGone`: phieu in va canh bao Lech SL khong con ma da xoa; tinh lai tong tien khi snapshot du gia.
  function pruneSnapshot(snapshot, isGone) {
    const lines = (Array.isArray(snapshot && snapshot.lines) ? snapshot.lines : []).filter(line => !isGone(codeKey(line.productCode)));
    try { return makeOrderSnapshot({ ...snapshot, lines }); } catch (error) { return { ...snapshot, lines }; }
  }

  /* Bo dong chi dinh cua ma hang KHONG CON tren don Kiot khoi chi dinh 'picking' (chi dinh moi nhat cua don, hoac dung `id`).
     Hop chi dinh chi ve theo dong don Kiot nen cac dong nay bi AN, nhung van giu cho vi tri: Vi tri hang chan xoa dong VT
     ("dang duoc don Dang boc chi dinh") va luc don Hoan thanh se tru thung cua ma da bo. 'confirmed' khong dong toi (thung da tru,
     chi Chi dinh lai moi hoan). Giao dich rieng, khoa co so nhu assign. Tra so dong da bo. */
  async function pruneAssignment(db, { branch, orderCode, id }, isGone, actor, reason) {
    return withTransaction(db, async client => {
      await lockBranch(client, branch);
      const head = (await client.query(id
        ? `SELECT * FROM order_pick_assignments WHERE id = $1 AND status = 'picking' FOR UPDATE`
        : `SELECT * FROM order_pick_assignments WHERE branch = $1 AND lower(btrim(order_code)) = $2 AND status = 'picking' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      id ? [id] : [branch, codeKey(orderCode)])).rows[0];
      if (!head) return 0;
      const stale = (await client.query('SELECT id, product_code, position_id, location, planned_qty FROM order_pick_lines WHERE assignment_id = $1 ORDER BY id', [head.id])).rows
        .filter(line => isGone(codeKey(line.product_code)));
      if (!stale.length) return 0;
      await client.query('DELETE FROM order_pick_lines WHERE id = ANY($1::bigint[])', [stale.map(line => line.id)]);
      await client.query(
        `UPDATE order_pick_assignments SET order_snapshot = $2::jsonb, version = version + 1, updated_at = now() WHERE id = $1`,
        [head.id, JSON.stringify(pruneSnapshot(head.order_snapshot, isGone))]);
      // Lich su fail-soft: chua ap migration 0103 (CHECK chua co 'prune') thi van bo dong, chi khong ghi lich su.
      await client.query('SAVEPOINT pick_prune_history');
      try {
        await client.query(
          `INSERT INTO order_pick_history (assignment_id, branch, order_code, action, summary, actor_user_id, actor_name) VALUES ($1, $2, $3, 'prune', $4::jsonb, $5, $6)`,
          [head.id, head.branch, head.order_code, JSON.stringify({ reason, lines: stale.map(line => ({ productCode: line.product_code, positionId: Number(line.position_id), location: line.location, quantity: Number(line.planned_qty) })) }), actor.id, actor.name]);
        await client.query('RELEASE SAVEPOINT pick_prune_history');
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT pick_prune_history');
        if (!error || error.code !== '23514') throw error;
      }
      return stale.length;
    });
  }

  // ---------- Sua VT (stock_positions) trong hop Chi dinh vi tri — can ca shipment.pick va stockLocationsV2.edit (kiem o route) ----------

  /* Pham vi sua: chi dong VT cua cac ma hang trong don (dong don Kiot da gop), dung co so cua don; don Da boc thi hop chi xem -> 409.
     options truyen cho stockPositionsService: excludeOrder = chinh don nay (giu cho cua don nay khong chan sua/xoa, client tu bat
     "chua luu" de Cap nhat chi dinh & In lai); don Dang boc KHAC van duoc bao ve (BELOW_HELD / HELD_SPEC_CONFLICT / POSITION_HELD). */
  async function positionScope(ctx, { branch, orderCode } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const code = cleanOrderCode(orderCode);
    const { order, lines } = await requireOrder(branch, code);
    const keys = new Set(lines.map(line => codeKey(line.productCode)));
    const latest = (await getDb().query(
      'SELECT status FROM order_pick_assignments WHERE branch = $1 AND lower(btrim(order_code)) = $2 ORDER BY id DESC LIMIT 1',
      [branch, codeKey(order.orderCode)])).rows[0];
    if (latest && latest.status === STATUS.CONFIRMED) throw fail(409, 'INVALID_STATE', 'Đơn đã bốc nên không sửa vị trí trong hộp chỉ định.');
    return {
      keys,
      options: { branch, allowRow: row => keys.has(codeKey(row.code)), excludeOrder: order.orderCode, source: { orderCode: order.orderCode } }
    };
  }

  function positionVersion(value) {
    const version = Number(value);
    if (value === undefined || value === null || value === '' || !Number.isInteger(version)) throw fail(400, 'VALIDATION', 'Thiếu phiên bản (version) của dòng vị trí.', { field: 'version' });
    return version;
  }

  // Them vi tri cho ma trong don: body { branch, orderCode, productCode, location, notes }. Trung (ma, vi tri) thi cong don ghi chu.
  // Tra { row, merged } cua stockPositionsService.create.
  async function createPosition(ctx, body = {}) {
    const { keys, options } = await positionScope(ctx, body);
    const productCode = typeof body.productCode === 'string' ? body.productCode.trim() : '';
    if (!productCode || !keys.has(codeKey(productCode))) throw fail(400, 'VALIDATION', 'Mã hàng không có trong đơn.', { field: 'productCode' });
    return stockPositions.create(ctx, body.branch, { code: productCode, location: body.location, notes: body.notes, arrivalDate: '' }, { source: options.source });
  }

  // Sua ghi chu so thung: body { branch, orderCode, notes, version, confirmEmpty? }. Chi chuyen notes (khong doi Ngay ve / Vi tri o day).
  async function updatePosition(ctx, id, body = {}) {
    const { options } = await positionScope(ctx, body);
    if (typeof body.notes !== 'string') throw fail(400, 'VALIDATION', 'Thiếu ghi chú số thùng.', { field: 'notes' });
    const version = positionVersion(body.version);
    return stockPositions.update(ctx, id, { notes: body.notes, version, confirmEmpty: body.confirmEmpty === true }, { ...options, checkHeld: true });
  }

  async function removePosition(ctx, id, { branch, orderCode, version } = {}) {
    const { options } = await positionScope(ctx, { branch, orderCode });
    return stockPositions.remove(ctx, id, positionVersion(version), options);
  }

  async function get(ctx, { branch, orderCode } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    return { assignment: await readLatest(getDb(), branch, cleanOrderCode(orderCode)) };
  }

  // Trang thai chi dinh MOI NHAT cua moi don: Map 'HN|ma don chu thuong' -> picking|confirmed|cancelled (cot pickStatus cua danh sach).
  // Don khong co chi dinh = "Chua boc" (khong co khoa); chi dinh bi huy (tay hoac do Kiot huy don) hien "Da huy".
  // Fail-soft: chua ap migration 0096 hoac loi DB thi tra Map rong, danh sach Vong doi van chay binh thuong.
  async function latestStatuses() {
    const map = new Map();
    try {
      const { rows } = await getDb().query(
        `SELECT DISTINCT ON (a.branch, lower(btrim(a.order_code))) a.branch, lower(btrim(a.order_code)) AS code_key, a.status
           FROM order_pick_assignments a ORDER BY a.branch, lower(btrim(a.order_code)), a.id DESC`);
      for (const row of rows) map.set(`${row.branch}|${row.code_key}`, row.status);
    } catch (error) {
      if (error && error.code !== '42P01') console.error('[PickAssignments] status lookup failed:', error.code || error.message);
    }
    return map;
  }

  function parseAllocations(body, lines) {
    const raw = Array.isArray(body.allocations) ? body.allocations : null;
    if (!raw) throw fail(400, 'VALIDATION', 'Chưa chỉ định vị trí nào.', { field: 'allocations' });
    if (raw.length > MAX_ALLOCATIONS) throw fail(400, 'VALIDATION', 'Quá nhiều dòng chỉ định.', { field: 'allocations' });
    const lineIndex = new Map(lines.map((line, index) => [codeKey(line.productCode), index]));
    const perLine = lines.map(() => new Map()); // dong don -> Map(positionId -> qty)
    for (const item of raw) {
      const index = lineIndex.get(codeKey(item && item.productCode));
      const positionId = Number(item && item.positionId);
      const qty = Number(item && item.qty);
      if (index === undefined) throw fail(400, 'VALIDATION', `Mã hàng ${item && item.productCode ? item.productCode : '(trống)'} không có trong đơn.`, { field: 'allocations' });
      if (!Number.isInteger(positionId) || positionId < 1) throw fail(400, 'VALIDATION', 'Mã dòng vị trí không hợp lệ.', { field: 'allocations' });
      if (!Number.isSafeInteger(qty) || qty <= 0) throw fail(400, 'VALIDATION', 'Số lượng chỉ định phải là số chiếc nguyên dương.', { field: 'allocations' });
      const total = (perLine[index].get(positionId) || 0) + qty;
      if (!Number.isSafeInteger(total)) throw fail(400, 'VALIDATION', 'Tổng số lượng vượt giới hạn cho phép.', { field: 'allocations' });
      perLine[index].set(positionId, total);
    }
    return perLine;
  }

  async function assign(ctx, body = {}) {
    const branch = body.branch;
    assertBranch(branch);
    assertScope(ctx, branch);
    const orderCode = cleanOrderCode(body.orderCode);
    const { order: kiotOrder, lines: kiotLines } = await requireOrder(branch, orderCode);
    if (!kiotLines.length) throw fail(400, 'VALIDATION', 'Đơn không có dòng hàng cần nhặt.');
    const invalidQuantities = quantityErrors(kiotOrder);
    if (invalidQuantities.length) throw fail(400, 'VALIDATION', invalidQuantities.join('; '), { field: 'allocations' });
    // Bo dong / SL can nhat sua tay chi luu trong ban chi dinh (snapshot + phieu in), KHONG sua don Kiot.
    const kept = applyRemovals(kiotOrder, kiotLines, body.removed);
    const needed = applyNeeds(kept.order, kept.lines, body.needs);
    const { order } = kept;
    const lines = needed.lines;
    const perLine = parseAllocations(body, lines);
    const actor = actorOf(ctx);
    const reassign = body.reassign === true;
    const snapshot = makeOrderSnapshot(needed.order);
    const db = getDb();
    let assignmentId;
    try {
      assignmentId = await withTransaction(db, async client => {
        await lockBranch(client, branch);
        const active = (await client.query(
          `SELECT id, status, version FROM order_pick_assignments WHERE branch = $1 AND lower(btrim(order_code)) = $2 AND status IN ('picking', 'confirmed') LIMIT 1 FOR UPDATE`,
          [branch, codeKey(order.orderCode)])).rows[0];
        if (active) {
          if (!reassign) throw fail(409, 'ALREADY_ASSIGNED', 'Đơn này đã được chỉ định vị trí. Hãy hủy nhặt rồi chỉ định lại.');
          // In lai / chi dinh lai = huy luot cu (Dang nhat: tra giu cho; Da nhat: hoan thung da tru) + luot moi trong CUNG giao dich:
          // loi o buoc sau thi luot cu van giu nguyen.
          if (body.version !== undefined && body.version !== null && Number(body.version) !== active.version) {
            throw fail(409, 'VERSION_CONFLICT', 'Chỉ định đã bị người khác thay đổi. Hãy tải lại.', { latest: await readAssignment(client, Number(active.id), {inTransaction:true}) });
          }
          const wasConfirmed = active.status === STATUS.CONFIRMED;
          if (wasConfirmed) await revertConfirmed(client, { id: active.id, branch, order_code: order.orderCode }, actor);
          await client.query(
            `UPDATE order_pick_assignments SET status = 'cancelled', version = version + 1, cancelled_by_user_id = $2, cancelled_by_name = $3, cancelled_at = now(), updated_at = now() WHERE id = $1`,
            [active.id, actor.id, actor.name]);
          await client.query(
            `INSERT INTO order_pick_history (assignment_id, branch, order_code, action, summary, actor_user_id, actor_name) VALUES ($1, $2, $3, 'cancel', $4::jsonb, $5, $6)`,
            [active.id, branch, order.orderCode, JSON.stringify({ reverted: wasConfirmed, reason: CANCEL_REASON.REASSIGN }), actor.id, actor.name]);
        }

        const ids = [...new Set(perLine.flatMap(map => [...map.keys()]))].sort((a, b) => a - b);
        const positions = (await client.query(
          `SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE`, [branch, ids])).rows;
        if (positions.length !== ids.length) throw fail(400, 'VALIDATION', 'Có vị trí không tồn tại (có thể đã bị xóa). Hãy tải lại.', { field: 'allocations' });
        const held = await heldByPosition(client, branch, ids, order.orderCode);
        const byId = new Map(positions.map(row => [Number(row.id), row]));
        const locations = positions.map(row => {
          const spec = carton.parseSpec(row.notes);
          const onHand = spec ? spec.quantity : null;
          return { id: String(row.id), code: row.code, location: row.location, available: onHand === null ? null : Math.max(0, onHand - (held.get(Number(row.id)) || 0)), perCarton: spec && spec.perCarton ? spec.perCarton : 0 };
        });
        const allocations = perLine.map(map => [...map].map(([id, quantity]) => ({ id: String(id), quantity })));
        // allowMismatch: người dùng đã xác nhận cảnh báo thiếu/thừa hàng; vẫn chặn vượt khả dụng của từng vị trí.
        const errors = rules.validate(lines, locations, allocations, { allowMismatch: body.allowMismatch === true });
        if (errors.length) {
          if (errors.every(message => AVAILABILITY_ERROR.test(message))) throw fail(409, 'INSUFFICIENT_AVAILABLE', errors.join('; '));
          throw fail(400, 'VALIDATION', errors.join('; '), { field: 'allocations' });
        }

        const head = (await client.query(
          `INSERT INTO order_pick_assignments (branch, order_code, status, order_snapshot, assigned_by_user_id, assigned_by_name)
           VALUES ($1, $2, 'picking', $3::jsonb, $4, $5) RETURNING id`,
          [branch, order.orderCode, JSON.stringify(snapshot), actor.id, actor.name])).rows[0];
        let total = 0;
        const insertLines = [];
        for (const [lineIndex, map] of perLine.entries()) {
          for (const [positionId, qty] of map) {
            const row = byId.get(positionId);
            const spec = carton.parseSpec(row.notes);
            const allocationSnapshot = makeAllocationSnapshot(row, qty);
            if (!allocationSnapshot) throw fail(400, 'VALIDATION', `Không lập được quy cách nhặt cho mã ${row.code}.`);
            total += qty;
            insertLines.push({ line_order:insertLines.length, product_code:lines[lineIndex].productCode, position_id:positionId, location:row.location,
              qty, st_cartons:spec && carton.stFor(spec, qty) ? carton.stFor(spec, qty).cartons : null,
              st_text:spec ? carton.pickText(spec, qty) : null, allocation_snapshot:allocationSnapshot });
          }
        }
        if (insertLines.length) await timedQuery(client,'pickInsertLines',
          `INSERT INTO order_pick_lines (assignment_id, product_code, position_id, location, planned_qty, reserved_qty, st_cartons, st_text, allocation_snapshot)
           SELECT $1, l.product_code, l.position_id, l.location, l.qty, l.qty, l.st_cartons, l.st_text, l.allocation_snapshot
             FROM jsonb_to_recordset($2::jsonb) AS l(product_code text, position_id bigint, location text,
               qty numeric, st_cartons numeric, st_text text, allocation_snapshot jsonb, line_order integer)
            ORDER BY l.line_order`,[head.id,JSON.stringify(insertLines)]);
        await client.query(
          `INSERT INTO order_pick_history (assignment_id, branch, order_code, action, summary, actor_user_id, actor_name)
           VALUES ($1, $2, $3, 'assign', $4::jsonb, $5, $6)`,
          [head.id, branch, order.orderCode, JSON.stringify({ lines: lines.length, positions: ids.length, quantity: total }), actor.id, actor.name]);
        return Number(head.id);
      });
    } catch (error) {
      if (error && error.code === '23505') throw fail(409, 'ALREADY_ASSIGNED', 'Đơn này đã được chỉ định vị trí. Hãy hủy nhặt rồi chỉ định lại.');
      throw error;
    }
    return { assignment: await readAssignment(db, assignmentId, {supplementPhone:false}) };
  }

  // Khoa + doc 1 chi dinh de doi trang thai: kiem pham vi co so, version (409 kem ban moi nhat) va trang thai hien tai.
  async function lockAssignment(client, ctx, id, version, allowed) {
    if (!Number.isInteger(id) || id < 1) throw fail(400, 'VALIDATION', 'Mã chỉ định không hợp lệ.');
    const head = (await client.query('SELECT branch FROM order_pick_assignments WHERE id = $1', [id])).rows[0];
    if (!head) throw fail(404, 'NOT_FOUND', 'Không tìm thấy chỉ định vị trí.');
    assertScope(ctx, head.branch);
    await lockBranch(client, head.branch);
    const row = (await client.query('SELECT * FROM order_pick_assignments WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'Không tìm thấy chỉ định vị trí.');
    if (version === undefined || version === null || !Number.isInteger(Number(version))) throw fail(400, 'VALIDATION', 'Thiếu phiên bản (version) của chỉ định.', { field: 'version' });
    if (Number(version) !== row.version) {
      throw fail(409, 'VERSION_CONFLICT', 'Chỉ định đã bị người khác thay đổi. Dữ liệu mới nhất đã được tải lại.', { latest: await readAssignment(client, id, {inTransaction:true}) });
    }
    if (!allowed.includes(row.status)) {
      throw fail(409, 'INVALID_STATE', `Chỉ định đang ở trạng thái "${row.status}", không thực hiện được thao tác này.`, { latest: await readAssignment(client, id, {inTransaction:true}) });
    }
    return row;
  }

  async function lockPositions(client, branch, jobs) {
    const ids = jobs.map(job => Number(job.position_id)).sort((a, b) => a - b);
    const rows = ids.length
      ? (await client.query(`SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 AND id = ANY($2::bigint[]) ORDER BY id FOR UPDATE`, [branch, ids])).rows
      : [];
    return new Map(rows.map(row => [Number(row.id), row]));
  }

  const stockChanged = (job, why) => fail(409, 'STOCK_CHANGED', `Vị trí ${job.location || '(không tên)'} của mã ${job.product_code} ${why}. Hãy kiểm tra Vị trí hàng rồi hủy nhặt và chỉ định lại.`);

  // Hoan tac 1 dong da tru: khoi phuc dung chuoi cu neu ghi chu chua bi doi tiep, khong thi cong tra so da nhat; dong da bi
  // tu xoa (het hang) duoc tao lai (hoac cong vao dong cung ma + vi tri vua duoc nhap lai).
  async function revertJob(client, head, actor, job, row) {
    const picked = Number(job.picked_qty);
    const summary = { orderCode: head.order_code, assignmentId: Number(head.id), restored: picked };
    const update = async (target, notes, extra) => {
      await client.query(
        `UPDATE stock_positions SET notes = $2, version = version + 1, updated_by_user_id = $3, updated_by_name = $4, updated_at = now() WHERE id = $1`,
        [target.id, notes, actor.id, actor.name]);
      await writeHistory(client, head.branch, actor, [{ positionId: target.id, code: target.code, location: target.location, action: 'pick_revert', field: 'notes', oldValue: target.notes, newValue: notes, summary: { ...summary, ...extra } }]);
    };
    if (row) {
      if (row.notes === job.spec_after) return update(row, job.spec_before, { exact: true });
      const spec = carton.parseSpec(row.notes);
      if (!spec) throw stockChanged(job, 'có ghi chú sai định dạng nên không cộng trả được số đã nhặt');
      return update(row, carton.restore(spec, picked).text, { exact: false });
    }
    const snapshot = job.position_snapshot || {};
    const same = (await client.query(
      `SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 AND lower(btrim(code)) = $2
         AND upper(regexp_replace(location, '\\s+', '', 'g')) = $3 ORDER BY id LIMIT 1 FOR UPDATE`,
      [head.branch, lower(snapshot.code || job.product_code), normalizeLocation(snapshot.location ?? job.location)])).rows[0];
    if (same) {
      const spec = carton.parseSpec(same.notes);
      if (!spec) throw stockChanged(job, 'đã được nhập lại với ghi chú sai định dạng nên không cộng trả được');
      return update(same, carton.restore(spec, picked).text, { exact: false, recreated: false });
    }
    // Chi khoi phuc nguyen chuoi cu khi chinh luot xac nhan nay da lam het hang (spec_after rong).
    const notes = isEmptyNote(job.spec_after) ? job.spec_before : carton.restore(carton.parseSpec('') || { terms: [], loose: 0 }, picked).text;
    const { rows } = await client.query(
      `INSERT INTO stock_positions (branch, code, name, notes, arrival_date, location, updated_by_user_id, updated_by_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [head.branch, snapshot.code || job.product_code, snapshot.name || '', notes, snapshot.arrivalDate || '', snapshot.location ?? job.location, actor.id, actor.name]);
    await writeHistory(client, head.branch, actor, [{ positionId: rows[0].id, code: snapshot.code || job.product_code, location: snapshot.location ?? job.location, action: 'pick_revert', field: 'notes', oldValue: null, newValue: notes, summary: { ...summary, recreated: true } }]);
  }

  // Hoan toan bo thung da tru cua chi dinh 'confirmed' (dung trong giao dich cua assign reassign; da giu khoa co so).
  async function revertConfirmed(client, head, actor) {
    const jobs = (await client.query('SELECT * FROM order_pick_lines WHERE assignment_id = $1 AND picked_qty IS NOT NULL ORDER BY position_id', [head.id])).rows;
    const positions = await lockPositions(client, head.branch, jobs);
    for (const job of jobs) await revertJob(client, head, actor, job, positions.get(Number(job.position_id)));
  }

  async function confirm(ctx, id, body = {}) {
    const actor = actorOf(ctx);
    const db = getDb();
    await withTransaction(db, async client => {
      const head = await lockAssignment(client, ctx, id, body.version, [STATUS.PICKING]);
      const jobs = (await client.query('SELECT * FROM order_pick_lines WHERE assignment_id = $1 ORDER BY position_id', [id])).rows;
      const positions = await lockPositions(client, head.branch, jobs);
      // Ton that do don hang tru: nguoi sua (lich su VT + cot Nguoi sua cuoi) la MA DON; ten nguoi bam that nam trong summary
      // (rong khi job Kiot tu dong, actor.id === null). order_pick_history van ghi nguoi bam.
      const stockActor = { id: actor.id, name: head.order_code };
      const summary = { orderCode: head.order_code, assignmentId: Number(head.id), confirmedBy: actor.id === null ? '' : actor.name };
      for (const job of jobs) {
        const row = positions.get(Number(job.position_id));
        if (!row) throw stockChanged(job, 'không còn tồn tại');
        const spec = carton.parseSpec(row.notes);
        if (!spec || spec.empty) throw stockChanged(job, 'đã hết hàng hoặc ghi chú sai định dạng');
        const planned = Number(job.planned_qty);
        if (!Number.isSafeInteger(planned) || planned <= 0 ||
            !allocationMatches(job.allocation_snapshot, row) || job.allocation_snapshot.plannedQty !== planned) {
          throw stockChanged(job, 'đã đổi mã/vị trí/quy cách hoặc phiếu cũ thiếu dấu vết để xác nhận an toàn');
        }
        const result = deductAllocation(job.allocation_snapshot, row);
        if (!result) throw stockChanged(job, `không còn đủ ${planned} để nhặt (hiện ${spec.quantity})`);
        const snapshot = { code: row.code, name: row.name, notes: row.notes, arrivalDate: row.arrival_date, location: row.location };
        if (isEmptyNote(result.text)) {
          await removeRow(client, head.branch, stockActor, row, 'auto_delete', { newValue: result.text, summary: { ...summary, picked: planned } });
        } else {
          await client.query(
            `UPDATE stock_positions SET notes = $2, version = version + 1, updated_by_user_id = $3, updated_by_name = $4, updated_at = now() WHERE id = $1`,
            [row.id, result.text, stockActor.id, stockActor.name]);
          await writeHistory(client, head.branch, stockActor, [{ positionId: row.id, code: row.code, location: row.location, action: 'pick', field: 'notes', oldValue: row.notes, newValue: result.text, summary: { ...summary, picked: planned } }]);
        }
        await client.query(
          `UPDATE order_pick_lines SET picked_qty = $2, spec_before = $3, spec_after = $4, position_snapshot = $5::jsonb WHERE id = $1`,
          [job.id, planned, row.notes, result.text, JSON.stringify(snapshot)]);
      }
      await client.query(
        `UPDATE order_pick_assignments SET status = 'confirmed', version = version + 1, confirmed_by_user_id = $2, confirmed_by_name = $3, confirmed_at = now(), updated_at = now() WHERE id = $1`,
        [id, actor.id, actor.name]);
      await client.query(
        `INSERT INTO order_pick_history (assignment_id, branch, order_code, action, summary, actor_user_id, actor_name) VALUES ($1, $2, $3, 'confirm', $4::jsonb, $5, $6)`,
        [id, head.branch, head.order_code, JSON.stringify({ positions: jobs.length }), actor.id, actor.name]);
    });
    return { assignment: await readAssignment(db, id) };
  }

  // `options.reason` (CANCEL_REASON) chi do may chu truyen — khong doc tu body de client khong gia mao "Kiot huy".
  async function cancel(ctx, id, body = {}, options = {}) {
    const reason = options.reason || CANCEL_REASON.MANUAL;
    const actor = actorOf(ctx);
    const db = getDb();
    await withTransaction(db, async client => {
      const head = await lockAssignment(client, ctx, id, body.version, [STATUS.PICKING, STATUS.CONFIRMED]);
      // Da boc la trang thai cuoi: khong huy / hoan tac duoc (thung da tru that). Chi 'picking' moi huy duoc (tra giu cho).
      if (head.status === STATUS.CONFIRMED) {
        throw fail(409, 'ALREADY_CONFIRMED', 'Đơn đã bốc xong, không hủy được nữa.', { latest: await readAssignment(client, id, {inTransaction:true}) });
      }
      await client.query(
        `UPDATE order_pick_assignments SET status = 'cancelled', version = version + 1, cancelled_by_user_id = $2, cancelled_by_name = $3, cancelled_at = now(), updated_at = now() WHERE id = $1`,
        [id, actor.id, actor.name]);
      await client.query(
        `INSERT INTO order_pick_history (assignment_id, branch, order_code, action, summary, actor_user_id, actor_name) VALUES ($1, $2, $3, 'cancel', $4::jsonb, $5, $6)`,
        [id, head.branch, head.order_code, JSON.stringify({ reverted: false, reason }), actor.id, actor.name]);
    });
    return { assignment: await readAssignment(db, id) };
  }

  // Doi trang thai tu cot "Trang thai boc" cua Vong doi don hang: CHI Dang boc -> Da boc (confirm: tru thung that) hoac
  // Dang boc -> Da huy (cancel: tra giu cho). Da boc la trang thai cuoi (khong qua day). Dat lai ve chinh trang thai da co thi
  // tra nguyen ket qua (idempotent, bam 2 lan khong tru thung 2 lan). Khoa lac quan theo version cua chi dinh moi nhat.
  async function setStatus(ctx, body = {}) {
    const branch = body.branch;
    assertBranch(branch);
    assertScope(ctx, branch);
    const orderCode = cleanOrderCode(body.orderCode);
    const target = body.status;
    if (target !== STATUS.CONFIRMED && target !== STATUS.CANCELLED) {
      throw fail(400, 'VALIDATION', 'Chỉ chuyển được từ "Đang bốc" sang "Đã bốc" hoặc "Đã hủy".', { field: 'status' });
    }
    const latest = await readLatest(getDb(), branch, orderCode);
    if (!latest) throw fail(409, 'INVALID_STATE', 'Đơn chưa được chỉ định bốc nên không đổi được trạng thái bốc.');
    if (latest.status === target) return { assignment: latest };
    if (latest.status !== STATUS.PICKING) {
      throw fail(409, 'INVALID_STATE', `Đơn đang ở trạng thái bốc "${latest.status}", chỉ đơn "Đang bốc" mới đổi được.`, { latest });
    }
    return target === STATUS.CONFIRMED
      ? confirm(ctx, latest.id, { version: latest.version })
      : cancel(ctx, latest.id, { version: latest.version });
  }

  // Tu dong theo Kiot (chay dinh ky, xem pickKiotReconcileJob.js): chi dong 'picking'.
  //   Kiot "Hoan thanh" -> confirm (luc nay moi tru thung); Kiot "Da huy" -> huy chi dinh + tra giu cho (hien "Da huy").
  // 'confirmed' khong bao gio bi dong toi. Doc trang thai tu bang orders DA DONG BO (khong goi API Kiot). Idempotent:
  // dung version cua chi dinh, nguoi khac vua doi tay (VERSION_CONFLICT / INVALID_STATE) thi bo qua luot nay.
  // Bo dong chi dinh cua ma khong con tren don Kiot da dong bo (xoa dong thang tren Kiot, hoac nut "Xoa dong" bo duoc tren Kiot
  // nhung chua bo duoc chi dinh). Don chua co dong nao trong DB / co dong khong xac dinh duoc ma thi khong dong vao.
  async function pruneMissingFromKiot(db, active, result) {
    const byBranch = new Map();
    for (const row of active) {
      if (!tx.BRANCH_CODES.includes(row.branch)) continue;
      if (!byBranch.has(row.branch)) byBranch.set(row.branch, []);
      byBranch.get(row.branch).push(row);
    }
    if (!byBranch.size) return;
    const assigned = new Map(); // id chi dinh -> Set(ma hang chu thuong)
    for (const row of (await db.query(
      `SELECT DISTINCT assignment_id, lower(btrim(product_code)) AS product_key FROM order_pick_lines WHERE assignment_id = ANY($1::bigint[])`,
      [active.map(row => Number(row.id))])).rows) {
      const id = Number(row.assignment_id);
      if (!assigned.has(id)) assigned.set(id, new Set());
      assigned.get(id).add(row.product_key);
    }
    for (const [branch, rows] of byBranch) {
      const onKiot = await kiotData.readKiotLineKeys(db, branch, rows.map(row => row.order_code));
      for (const row of rows) {
        const present = onKiot.get(codeKey(row.order_code));
        if (!present || !present.size) continue;
        const isGone = key => !present.has(key);
        if (![...(assigned.get(Number(row.id)) || [])].some(isGone)) continue;
        try {
          result.pruned += await pruneAssignment(db, { branch, id: Number(row.id) }, isGone, actorOf(KIOT_CTX), PRUNE_REASON.KIOT_MISSING);
        } catch (error) {
          result.failed.push({ id: Number(row.id), branch, orderCode: row.order_code, outcome: 'prune', code: (error && error.code) || 'ERROR', message: error && error.message });
        }
      }
    }
  }

  async function reconcileWithKiot() {
    const result = { checked: 0, confirmed: 0, cancelled: 0, pruned: 0, skipped: 0, failed: [] };
    const db = getDb();
    const readActive = async () => (await db.query(`SELECT id, branch, order_code, version FROM order_pick_assignments WHERE status = 'picking' ORDER BY id`)).rows;
    let active;
    try {
      active = await readActive();
    } catch (error) {
      if (error && error.code === '42P01') return result; // chua ap migration 0096
      throw error;
    }
    // Bo dong cua ma da xoa khoi don TRUOC khi tu xac nhan Da boc, de khong tru thung cua ma khong con trong don.
    await pruneMissingFromKiot(db, active, result);
    if (result.pruned) active = await readActive(); // version da tang
    result.checked = active.length;
    const byBranch = new Map();
    for (const row of active) {
      if (!byBranch.has(row.branch)) byBranch.set(row.branch, []);
      byBranch.get(row.branch).push(row);
    }
    for (const [branch, rows] of byBranch) {
      const statuses = await kiotData.readKiotStatuses(db, branch, rows.map(row => row.order_code));
      for (const row of rows) {
        const outcome = kiotData.kiotOutcome(statuses.get(codeKey(row.order_code)));
        if (!outcome) continue;
        try {
          if (outcome === 'completed') {
            await confirm(KIOT_CTX, Number(row.id), { version: row.version });
            result.confirmed += 1;
          } else {
            await cancel(KIOT_CTX, Number(row.id), { version: row.version }, { reason: CANCEL_REASON.KIOT });
            result.cancelled += 1;
          }
        } catch (error) {
          if (error && (error.code === 'VERSION_CONFLICT' || error.code === 'INVALID_STATE')) { result.skipped += 1; continue; }
          result.failed.push({ id: Number(row.id), branch, orderCode: row.order_code, outcome, code: (error && error.code) || 'ERROR', message: error && error.message });
        }
      }
    }
    return result;
  }

  return { candidates, get, assign, confirm, cancel, setStatus, reconcileWithKiot, latestStatuses, createPosition, updatePosition, removePosition };
}

module.exports = { createPickAssignmentsService, mergeOrderLines, applyRemovals, applyNeeds, STATUS, CANCEL_REASON, PRUNE_REASON, ...createPickAssignmentsService() };
