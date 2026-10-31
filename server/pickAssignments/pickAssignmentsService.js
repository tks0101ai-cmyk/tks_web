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
const { tx } = require('../stockPositions/stockPositionsService');
const kiotData = require('./pickKiotData');

const {
  withTransaction, lockBranch, writeHistory, removeRow, fail, assertBranch, assertScope, actorOf,
  lower, normalizeLocation, isEmptyNote, isoOf, ROW_COLUMNS
} = tx;

const STATUS = Object.freeze({ PICKING: 'picking', CONFIRMED: 'confirmed', CANCELLED: 'cancelled' });
// Ly do huy ghi trong order_pick_history.summary.reason (khong can migration). 'kiot_cancelled': don bi huy tren Kiot — giao
// dien hien "Chua boc" thay vi "Da huy" (latestStatuses bo dong nay khoi ban do).
const CANCEL_REASON = Object.freeze({ MANUAL: 'manual', REASSIGN: 'reassign', KIOT: 'kiot_cancelled' });
// Nguoi thuc hien cua cac chuyen trang thai tu dong theo Kiot (lich su ghi ten nay).
const KIOT_CTX = Object.freeze({ user: Object.freeze({ id: null, hoTen: 'Hệ thống (KiotViet)', username: 'kiot-sync' }) });
const MAX_ALLOCATIONS = 500;
// Ma canh bao chi dinh (cung chuoi voi orderLifecycleService.WARNING).
const PICK_WARNING = Object.freeze({ KIOT_DIFF: 'PICK_KIOT_DIFF', ORDER_DIFF: 'PICK_ORDER_DIFF' });
const AVAILABILITY_ERROR = /vượt số lượng khả dụng/u;

// Don dat truoc 31/10/2026 (gio VN) khong canh bao Lech Kiot / Lech SL trong don. Ngay don lay tu snapshot, thieu thi lay ngay chi dinh.
const PICK_WARNING_SINCE = Date.parse('2026-10-31T00:00:00+07:00');
function isWarnableOrder(head) {
  const vn = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(head.order_date || '').trim()); // 'dd/mm/yyyy HH:mm' (gio VN)
  const at = vn ? Date.parse(`${vn[3]}-${vn[2].padStart(2, '0')}-${vn[1].padStart(2, '0')}T00:00:00+07:00`)
    : (Date.parse(head.order_date || '') || (head.assigned_at ? new Date(head.assigned_at).getTime() : NaN));
  return !Number.isFinite(at) || at >= PICK_WARNING_SINCE;
}

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

// Nguon don mac dinh: trang thai tu bang gop Vong doi don hang + dong hang tu don Kiot (khong tin du lieu tu trinh duyet).
async function defaultLoadOrder({ branch, orderCode }) {
  const kiot = require('../shipment/kiotOrdersRepository').kiotOrders;
  const lifecycle = require('../shipment/orderLifecycleService');
  const row = await lifecycle.findMergedOrder(branch, orderCode, { kiot });
  if (!row) return null;
  const detail = await kiot.readOrderDetail({ branch, code: row.orderCode });
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
    sellerPhone: detail.sellerPhone || await kiotData.readSellerPhone(tx.DB_BRANCH[branch], detail.sellerId),
    note: detail.note || row.note || '',
    lines: detail.lines
  };
}

function createPickAssignmentsService({ getDb = getPool, loadOrder = defaultLoadOrder,
  loadSellerPhone = loadOrder === defaultLoadOrder ? kiotData.loadSellerPhone : null,
  // Ghi nguoc len don Kiot (xoa dong / sua SL can nhat). Chi bat o duong that; test truyen loadOrder rieng thi khong cham Kiot
  // (assign() giu cach cu: SL sua chi luu trong ban chi dinh).
  orderEditor = loadOrder === defaultLoadOrder ? require('../kiotviet/kiotOrderEditor').createKiotOrderEditor() : null } = {}) {
  // ---------- Doc / dinh dang ----------

  async function readAssignment(db, id) {
    const head = (await db.query('SELECT * FROM order_pick_assignments WHERE id = $1', [id])).rows[0];
    if (!head) return null;
    // Older snapshots have no seller contact: supplement the print response without rewriting history.
    const snapshot = {...(head.order_snapshot || {})};
    if (!snapshot.sellerPhone && loadSellerPhone) snapshot.sellerPhone = await loadSellerPhone(db, head.branch, head.order_code);
    const lines = (await db.query('SELECT * FROM order_pick_lines WHERE assignment_id = $1 ORDER BY id', [id])).rows;
    const history = (await db.query('SELECT created_at, action, actor_name, summary FROM order_pick_history WHERE assignment_id = $1 ORDER BY id', [id])).rows;
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

  async function readLatest(db, branch, orderCode) {
    const id = await readLatestId(db, branch, orderCode);
    return id === null ? null : readAssignment(db, id);
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
    const order = await loadOrder({ branch, orderCode });
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
      ? (await db.query(`SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 AND lower(btrim(code)) = ANY($2::text[]) ORDER BY id`, [branch, keys])).rows
      : [];
    const held = await heldByPosition(db, branch, rows.map(row => Number(row.id)), order.orderCode);
    const byCode = {};
    for (const key of keys) byCode[key] = [];
    for (const row of rows) byCode[codeKey(row.code)].push(shapeCandidate(row, held.get(Number(row.id)) || 0));
    return { order: orderView(order, lines), candidates: byCode, assignment: await readLatest(db, branch, order.orderCode) };
  }

  // Xoa dong hang (moi dong cua ma) khoi chinh don Kiot. Chi dinh dang co (Dang nhat/Da nhat) KHONG bi dong vao: don lech Kiot
  // nen hien canh bao "Lech SL boc" va nguoi dung luu lai chi dinh (Dang nhat) hoac Chi dinh lai (Da boc) de bo vi tri cua ma da xoa.
  async function removeLine(ctx, { branch, orderCode, productCode } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const code = cleanOrderCode(orderCode);
    const product = typeof productCode === 'string' ? productCode.trim() : '';
    if (!product) throw fail(400, 'VALIDATION', 'Thiếu mã hàng cần xóa.', { field: 'productCode' });
    if (!orderEditor) throw fail(424, 'KIOT_WRITE_UNAVAILABLE', 'Máy chủ chưa hỗ trợ ghi ngược lên KiotViet.');
    const result = await orderEditor.removeLine({ branch, orderCode: code, productCode: product, actor: actorOf(ctx) });
    return { changed: result.changed, assignment: await readLatest(getDb(), branch, code) };
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
    let { order, lines: kiotLines } = await requireOrder(branch, orderCode);
    if (!kiotLines.length) throw fail(400, 'VALIDATION', 'Đơn không có dòng hàng cần nhặt.');
    const invalidQuantities = quantityErrors(order);
    if (invalidQuantities.length) throw fail(400, 'VALIDATION', invalidQuantities.join('; '), { field: 'allocations' });
    let needed = applyNeeds(order, kiotLines, body.needs);
    let lines = needed.lines;
    let perLine = parseAllocations(body, lines);
    const actor = actorOf(ctx);
    // SL cần nhặt sửa tay → GHI LÊN ĐƠN KIOT (chỉ khi đúng đường thật), rồi đọc lại đơn: từ đây SL trên Kiot = SL cần nhặt,
    // snapshot không còn dòng "lệch Kiot". Kiot từ chối/ghi sai → ném lỗi, chưa tạo chỉ định nào.
    const edited = lines.filter(line => line.kiotQuantity !== undefined);
    if (edited.length && orderEditor) {
      await orderEditor.setQuantities({ branch, orderCode: order.orderCode, actor,
        quantities: Object.fromEntries(edited.map(line => [line.productCode, line.quantity])) });
      ({ order, lines: kiotLines } = await requireOrder(branch, orderCode));
      const rechecked = quantityErrors(order);
      if (rechecked.length) throw fail(400, 'VALIDATION', rechecked.join('; '), { field: 'allocations' });
      needed = { lines: kiotLines, order };
      lines = kiotLines;
      perLine = parseAllocations(body, lines);
    }
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
            throw fail(409, 'VERSION_CONFLICT', 'Chỉ định đã bị người khác thay đổi. Hãy tải lại.', { latest: await readAssignment(client, Number(active.id)) });
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
        for (const [lineIndex, map] of perLine.entries()) {
          for (const [positionId, qty] of map) {
            const row = byId.get(positionId);
            const spec = carton.parseSpec(row.notes);
            const allocationSnapshot = makeAllocationSnapshot(row, qty);
            if (!allocationSnapshot) throw fail(400, 'VALIDATION', `Không lập được quy cách nhặt cho mã ${row.code}.`);
            total += qty;
            await client.query(
              `INSERT INTO order_pick_lines (assignment_id, product_code, position_id, location, planned_qty, reserved_qty, st_cartons, st_text, allocation_snapshot)
               VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8::jsonb)`,
              [head.id, lines[lineIndex].productCode, positionId, row.location, qty, spec && carton.stFor(spec, qty) ? carton.stFor(spec, qty).cartons : null, spec ? carton.pickText(spec, qty) : null, JSON.stringify(allocationSnapshot)]);
          }
        }
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
    return { assignment: await readAssignment(db, assignmentId) };
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
      throw fail(409, 'VERSION_CONFLICT', 'Chỉ định đã bị người khác thay đổi. Dữ liệu mới nhất đã được tải lại.', { latest: await readAssignment(client, id) });
    }
    if (!allowed.includes(row.status)) {
      throw fail(409, 'INVALID_STATE', `Chỉ định đang ở trạng thái "${row.status}", không thực hiện được thao tác này.`, { latest: await readAssignment(client, id) });
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
        throw fail(409, 'ALREADY_CONFIRMED', 'Đơn đã bốc xong, không hủy được nữa.', { latest: await readAssignment(client, id) });
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
  async function reconcileWithKiot() {
    const result = { checked: 0, confirmed: 0, cancelled: 0, skipped: 0, failed: [] };
    const db = getDb();
    let active;
    try {
      active = (await db.query(`SELECT id, branch, order_code, version FROM order_pick_assignments WHERE status = 'picking' ORDER BY id`)).rows;
    } catch (error) {
      if (error && error.code === '42P01') return result; // chua ap migration 0096
      throw error;
    }
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

  /* Canh bao chi dinh (don Dang boc / Da boc), tinh cho MOI chi dinh hoat dong (so it) tu snapshot + dong vi tri + don Kiot hien tai:
       PICK_ORDER_DIFF — tong SL chon theo vi tri (order_pick_lines) khac SL can nhat cua ma trong snapshot (dong do da xac nhan luu);
       PICK_KIOT_DIFF  — SL can nhat (snapshot, co the da sua tay) khac SL ma do tren don Kiot hien tai; tu het khi Kiot sua khop va dong bo.
     Tra Map 'HN|ma don chu thuong' -> [ma canh bao] (chi don co canh bao). Fail-soft: loi DB tra Map rong, danh sach van chay. */
  async function pickWarnings() {
    const out = new Map();
    try {
      const db = getDb();
      const heads = (await db.query(
        `SELECT id, branch, order_code, order_snapshot->'lines' AS snapshot_lines, order_snapshot->>'orderDate' AS order_date, assigned_at
           FROM order_pick_assignments WHERE status IN ('picking', 'confirmed')`)).rows.filter(isWarnableOrder);
      if (!heads.length) return out;
      const picked = new Map(); // id chi dinh -> Map(ma hang chu thuong -> tong SL chon)
      const { rows } = await db.query(
        `SELECT assignment_id, lower(btrim(product_code)) AS product_key, SUM(planned_qty)::float8 AS quantity
           FROM order_pick_lines WHERE assignment_id = ANY($1::bigint[]) GROUP BY assignment_id, lower(btrim(product_code))`,
        [heads.map(head => Number(head.id))]);
      for (const row of rows) {
        const id = Number(row.assignment_id);
        if (!picked.has(id)) picked.set(id, new Map());
        picked.get(id).set(row.product_key, Number(row.quantity));
      }
      const needOf = head => {
        const need = new Map(); // ma hang chu thuong -> { productCode, quantity }
        for (const line of Array.isArray(head.snapshot_lines) ? head.snapshot_lines : []) {
          const key = codeKey(line.productCode);
          if (!key) continue;
          const hit = need.get(key);
          need.set(key, { productCode: hit ? hit.productCode : String(line.productCode).trim(), quantity: (hit ? hit.quantity : 0) + (Number(line.quantity) || 0) });
        }
        return need;
      };
      const add = (head, code) => {
        const key = `${head.branch}|${codeKey(head.order_code)}`;
        const list = out.get(key) || [];
        if (!list.includes(code)) out.set(key, [...list, code]);
      };
      const byBranch = new Map();
      for (const head of heads) {
        if (!tx.BRANCH_CODES.includes(head.branch)) continue;
        const need = needOf(head), have = picked.get(Number(head.id)) || new Map();
        if ([...need].some(([key, line]) => Math.abs(line.quantity - (have.get(key) || 0)) > 1e-6)) add(head, PICK_WARNING.ORDER_DIFF);
        if (!byBranch.has(head.branch)) byBranch.set(head.branch, []);
        byBranch.get(head.branch).push({ head, need });
      }
      for (const [branch, items] of byBranch) {
        const ordered = await kiotData.readKiotQuantities(db, branch, items.map(item => item.head.order_code));
        for (const { head, need } of items) {
          const kiotLines = ordered.get(codeKey(head.order_code));
          if (!kiotLines) continue; // chua co don tren Kiot (DB chua dong bo): khong ket luan
          if (kiotData.diffQuantities(need, kiotLines).length) add(head, PICK_WARNING.KIOT_DIFF);
        }
      }
    } catch (error) {
      if (error && error.code !== '42P01') console.error('[PickAssignments] warning lookup failed:', error.code || error.message);
      return new Map();
    }
    return out;
  }

  return { candidates, get, assign, removeLine, confirm, cancel, setStatus, reconcileWithKiot, pickWarnings, latestStatuses };
}

module.exports = { createPickAssignmentsService, mergeOrderLines, applyNeeds, PICK_WARNING, STATUS, CANCEL_REASON, ...createPickAssignmentsService() };
