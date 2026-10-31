'use strict';

// Co so du lieu Vi tri hang moi ("VT Ha Noi" / "VT Sai Gon", migration 0095).
// SL kho + canh bao KHONG luu: luon tinh tu ghi chu bang public/shared/carton.js. Ten SP + SL KiotViet doc theo ma tu `products`.
// Moi thao tac ghi chay trong 1 giao dich co khoa advisory theo co so, kem ban ghi stock_position_history cung giao dich.
const { getPool } = require('../db/pool');
const carton = require('../public/shared/carton.js');
const { stripTelegramId } = require('../dashboard/saleName');
const { parseImportWorkbook } = require('./stockPositionsImport');
const { ACTION_LABELS, FIELD_LABELS, summaryText } = require('./stockPositionsHistoryLabels');
const { announceChanged } = require('./stockPositionsEvents');

const BRANCH_CODES = Object.freeze(['HN', 'SG']);
const DB_BRANCH = Object.freeze({ HN: 'hanoi', SG: 'saigon' });
const PRODUCT_TTL_MS = 60 * 1000; // SL KiotViet co the cham vai phut (giam tai doc products.raw)
const MAX = Object.freeze({ code: 60, notes: 500, arrivalDate: 60, location: 100 });
const HISTORY_MAX = 1000;
const HISTORY_EXPORT_MAX = 50000;
const ERROR_LIMIT = 50;
const STOCK_OUT_ERROR_LIMIT = 500;
const NORMALIZE_ACTOR = 'Chuẩn hóa ghi chú';
const MERGE_ACTOR = 'Gộp dòng trùng';
const MODES = Object.freeze(['replace', 'add']);

function fail(statusCode, code, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, code }, extra);
}

const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const normalizeCode = value => String(value ?? '').replace(/\s+/gu, '').toLocaleUpperCase('vi');
const lower = value => normalizeCode(value).toLocaleLowerCase('vi');
// Vị trí chuẩn hóa: bỏ mọi khoảng trắng và viết hoa ("a 05" -> "A05"); dùng khi nhập liệu và khi so trùng.
const normalizeLocation = value => String(value ?? '').replace(/\s+/gu, '').toLocaleUpperCase('vi');
const keyOf = (code, location) => `${lower(code)}|${normalizeLocation(location)}`;
// Bo dau tieng Viet + hoa/thuong + khoang trang de so khop tu khoa.
const foldText = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase().replace(/\s+/gu, ' ').trim();
const isoOf = value => (value instanceof Date ? value : new Date(value)).toISOString();

// Ngay loc xoa lich su: rong -> null; dung dang yyyy-mm-dd va la ngay that.
function dateParam(value, field) {
  const text = clean(value);
  if (!text) return null;
  const valid = /^\d{4}-\d{2}-\d{2}$/u.test(text) && Number.isFinite(Date.parse(text + 'T00:00:00Z')) && new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) === text;
  if (!valid) throw fail(400, 'VALIDATION', 'Ngày không hợp lệ (cần dạng yyyy-mm-dd).', { field });
  return text;
}

function assertBranch(branch) {
  if (!BRANCH_CODES.includes(branch)) throw fail(400, 'INVALID_BRANCH', 'Cơ sở phải là HN hoặc SG.');
  return branch;
}

function assertScope(ctx, branch) {
  if (ctx.scope && !ctx.scope.includes(branch)) throw fail(403, 'BRANCH_OUT_OF_SCOPE', 'Cơ sở yêu cầu không thuộc phạm vi đang chọn.');
}

function actorOf(ctx) {
  const user = ctx.user || {};
  return { id: user.id === undefined || user.id === null ? null : String(user.id), name: stripTelegramId(user.hoTen || user.username || '') };
}

function textField(body, field, label) {
  const value = field === 'code' ? normalizeCode(body[field]) : clean(body[field]);
  if (value.length > MAX[field]) throw fail(400, 'VALIDATION', `${label} tối đa ${MAX[field]} ký tự.`, { field });
  return value;
}

// Vị trí: kiểm độ dài như trường văn bản rồi chuẩn hóa.
function locationField(body) {
  return normalizeLocation(textField(body, 'location', 'Vị trí'));
}

function validNotes(body) {
  const notes = carton.normalizeStoredNote(clean(body.notes));
  if (notes.length > MAX.notes) throw fail(400, 'VALIDATION', `Ghi chú tối đa ${MAX.notes} ký tự.`, { field: 'notes' });
  return notes;
}

// Ghi chu doc duoc nhung tong bang 0 (rong, "Het hang", "1Tx50 - 50") = het hang => tu xoa dong.
const isEmptyNote = notes => { const spec = carton.parseSpec(notes); return Boolean(spec && spec.quantity === 0); };

// Cong don 2 ghi chu (import "Bo sung them SL"): gop quy cach, cong phan tru le. null neu mot ben sai dinh dang.
function mergeNotes(current, added) {
  const a = carton.parseSpec(carton.normalizeStoredNote(current));
  const b = carton.parseSpec(carton.normalizeStoredNote(added));
  if (!a || !b) return null;
  const terms = [...a.terms, ...b.terms];
  if (!terms.length) return '';
  const loose = a.loose + b.loose;
  const annotation = [a.annotation, b.annotation].filter(Boolean).join(' ');
  const text = terms.map(t => t.cartons + 'T x ' + t.perCarton + (t.suffix || '')).join(' + ') + (loose > 0 ? ' - ' + loose : '') + (annotation ? ' ' + annotation : '');
  return carton.normalizeNote(text);
}

// Co so ma giao dich dang giu khoa (lockBranch) -> phat tin hieu "da doi" sau COMMIT, khong phat khi ROLLBACK.
const touchedBranches = new WeakMap();

function announceTouched(client) {
  const branches = touchedBranches.get(client);
  touchedBranches.delete(client);
  if (!branches) return;
  for (const branch of branches) {
    try { announceChanged(branch); } catch (error) { console.error('[stock-positions] khong phat duoc tin hieu doi:', error.message); }
  }
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    announceTouched(client);
    return result;
  } catch (error) {
    touchedBranches.delete(client);
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const lockBranch = (client, branch) => {
  const branches = touchedBranches.get(client) || touchedBranches.set(client, new Set()).get(client);
  branches.add(branch);
  return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['stock_positions:' + branch]);
};

const ON_HAND_SQL = `
  SELECT p.code, p.name, COALESCE(SUM((inv->>'onHand')::numeric), 0)::float8 AS on_hand
  FROM products p
  LEFT JOIN LATERAL jsonb_array_elements(COALESCE(p.raw->'inventories', '[]'::jsonb)) inv ON true
  WHERE p.branch = $1 AND upper(regexp_replace(p.code, '\\s+', '', 'g')) = ANY($2::text[])
  GROUP BY p.code, p.name`;

// Tra khong phan biet hoa/thuong de chuan hoa ma nhap tay / import ve ma KiotViet (khong dung duoc index nen chi goi luc ghi).
const RESOLVE_SQL = `SELECT code, name FROM products WHERE branch = $1 AND lower(regexp_replace(code, '\\s+', '', 'g')) = ANY($2::text[])`;

// Giu cho cua cac don "Dang nhat" (order_pick_assignments.status = 'picking', 0096) theo vi tri: 1 truy van gop cho ca bang.
// Chi chi dinh 'picking' giu cho; 'confirmed' da tru thung that, 'cancelled' da tra. Cung cong thuc voi pickAssignmentsService.heldByPosition (khong loai tru don nao).
const HELD_SQL = `
  SELECT l.position_id, COALESCE(SUM(l.reserved_qty), 0)::float8 AS held
  FROM order_pick_lines l JOIN order_pick_assignments a ON a.id = l.assignment_id
  WHERE a.status = 'picking' AND a.branch = $1 AND l.position_id = ANY($2::bigint[])
  GROUP BY l.position_id`;

// Ma don "Dang boc" dang chi dinh vao tung vi tri (ke ca dong giu 0): cac dong nay KHONG duoc xoa (xoa tay, ve 0, import Thay the),
// vi phieu boc tro thang vao id dong — xoa roi thi luc xac nhan Da boc bao "vi tri khong con ton tai".
const HOLDERS_SQL = `
  SELECT l.position_id, array_agg(DISTINCT a.order_code ORDER BY a.order_code) AS orders
  FROM order_pick_lines l JOIN order_pick_assignments a ON a.id = l.assignment_id
  WHERE a.status = 'picking' AND a.branch = $1 AND l.position_id = ANY($2::bigint[])
  GROUP BY l.position_id`;

const BASE_COLUMNS = 'id, branch, code, name, notes, arrival_date, location, version, updated_by_name, updated_at';
const ROW_COLUMNS = BASE_COLUMNS + ', format_ack';

const historySql = `INSERT INTO stock_position_history (branch, position_id, code, location, action, field, old_value, new_value, summary, actor_user_id, actor_name)
  SELECT $1, t.position_id, t.code, t.location, t.action, t.field, t.old_value, t.new_value, t.summary::jsonb, $2, $3
  FROM unnest($4::bigint[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[])
    AS t(position_id, code, location, action, field, old_value, new_value, summary)`;

// entries: [{positionId, code, location, action, field, oldValue, newValue, summary}]. Ghi cung giao dich voi thao tac (client).
async function writeHistory(client, branch, actor, entries) {
  if (!entries.length) return;
  const col = pick => entries.map(pick);
  await client.query(historySql, [branch, actor.id, actor.name,
    col(e => e.positionId ?? null), col(e => e.code ?? ''), col(e => e.location ?? ''), col(e => e.action),
    col(e => e.field ?? null), col(e => e.oldValue ?? null), col(e => e.newValue ?? null),
    col(e => (e.summary === undefined ? null : JSON.stringify(e.summary)))]);
}

async function removeRow(client, branch, actor, row, action, extra = {}) {
  await client.query('DELETE FROM stock_positions WHERE id = $1', [row.id]);
  await writeHistory(client, branch, actor, [{ positionId: row.id, code: row.code, location: row.location, action, field: 'notes', oldValue: row.notes, newValue: extra.newValue ?? null, summary: extra.summary }]);
}

function createStockPositionsService({ getDb = getPool, now = () => Date.now() } = {}) {
  const productCache = new Map(); // nhanh -> Map(code -> {at, product|null})

  async function loadProducts(db, branch, codes) {
    const cache = productCache.get(branch) || productCache.set(branch, new Map()).get(branch);
    const stale = [...new Set(codes)].filter(code => {
      const hit = cache.get(code);
      return !hit || now() - hit.at > PRODUCT_TTL_MS;
    });
    if (stale.length) {
      const found = new Map();
      try {
        for (const row of (await db.query(ON_HAND_SQL, [DB_BRANCH[branch], stale.map(normalizeCode)])).rows) found.set(normalizeCode(row.code), { name: clean(row.name), onHand: Number(row.on_hand) });
      } catch (error) {
        console.error('[StockPositions] products lookup failed:', error.code || error.message);
        return new Map(); // khong tra duoc SL Kiot: de trong, khong lam hong bang
      }
      for (const code of stale) cache.set(code, { at: now(), product: found.get(normalizeCode(code)) || null });
    }
    return new Map(codes.map(code => [code, cache.get(code)?.product || null]));
  }

  async function resolveCodes(db, branch, codes) {
    const keys = [...new Set(codes.map(lower).filter(Boolean))];
    const map = new Map();
    if (!keys.length) return map;
    for (const row of (await db.query(RESOLVE_SQL, [DB_BRANCH[branch], keys])).rows) map.set(lower(row.code), { code: normalizeCode(row.code), name: clean(row.name) });
    return map;
  }

  // Chua ap migration 0096 thi khong co bang giu cho: tra Map rong (Co the boc = SL kho). to_regclass khong gay loi nen an toan ca khi db la client dang trong giao dich.
  let heldTablesReady = false;
  async function heldByPosition(db, branch, ids) {
    const held = new Map();
    if (!ids.length) return held;
    if (!heldTablesReady) {
      const probe = (await db.query(`SELECT to_regclass('order_pick_lines') IS NOT NULL AND to_regclass('order_pick_assignments') IS NOT NULL AS ready`)).rows[0];
      heldTablesReady = Boolean(probe && probe.ready);
      if (!heldTablesReady) return held;
    }
    for (const row of (await db.query(HELD_SQL, [branch, ids])).rows) held.set(Number(row.position_id), Number(row.held));
    return held;
  }

  // Map id dong -> [ma don Dang boc]. Fail-soft nhu heldByPosition khi chua ap migration 0096.
  async function holdersByPosition(db, branch, ids) {
    const holders = new Map();
    if (!ids.length) return holders;
    if (!heldTablesReady) {
      const probe = (await db.query(`SELECT to_regclass('order_pick_lines') IS NOT NULL AND to_regclass('order_pick_assignments') IS NOT NULL AS ready`)).rows[0];
      heldTablesReady = Boolean(probe && probe.ready);
      if (!heldTablesReady) return holders;
    }
    for (const row of (await db.query(HOLDERS_SQL, [branch, ids])).rows) holders.set(Number(row.position_id), row.orders);
    return holders;
  }

  async function assertNotHeld(client, row) {
    const orders = (await holdersByPosition(client, row.branch, [Number(row.id)])).get(Number(row.id));
    if (orders && orders.length) {
      throw fail(409, 'POSITION_HELD', `Dòng này đang được đơn Đang bốc ${orders.join(', ')} chỉ định nên không xóa được. Hãy chỉ định lại hoặc hủy bốc đơn đó trước.`, { orders });
    }
  }

  function shape(row, product, held = 0) {
    const spec = product ? carton.parseSpec(row.notes) : null;
    const rawWarnings = carton.warnings(row.notes, { unknownCode: !product });
    return {
      id: Number(row.id),
      code: normalizeCode(row.code),
      name: clean(product ? product.name : row.name),
      // Dữ liệu seed/cũ chưa qua validNotes: chuẩn hóa cả khi đọc để bảng và Excel dùng cùng dạng gộp.
      notes: product ? carton.normalizeStoredNote(row.notes) : clean(row.notes),
      arrivalDate: clean(row.arrival_date),
      location: row.location,
      quantity: spec ? spec.quantity : null,
      held,
      available: spec ? Math.max(0, spec.quantity - held) : null,
      kiotQuantity: product ? product.onHand : null,
      // Cảnh báo gốc tính từ ghi chú; dòng đã "Đã sửa" (format_ack) thì warnings rỗng để không đếm/lọc là cảnh báo.
      acknowledged: Boolean(row.format_ack),
      rawWarnings: rawWarnings,
      warnings: row.format_ack ? [] : rawWarnings,
      updatedByName: row.updated_by_name,
      updatedAt: isoOf(row.updated_at),
      version: row.version
    };
  }

  async function shapeOne(db, row) {
    const product = (await loadProducts(db, row.branch, [row.code])).get(row.code);
    return shape(row, product);
  }

  async function list(ctx, branch) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const db = getDb();
    const rows = (await db.query(`SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 ORDER BY id`, [branch])).rows;
    const products = await loadProducts(db, branch, rows.map(row => row.code));
    const held = await heldByPosition(db, branch, rows.map(row => Number(row.id)));
    return { branch, rows: rows.map(row => shape(row, products.get(row.code), held.get(Number(row.id)) || 0)) };
  }

  // Goi y ma hang khi go o "Them dong": khop dau/giua ma (bo khoang trang, khong phan biet hoa thuong) hoac trong ten; ma bat dau bang tu khoa xep truoc.
  async function suggestCodes(ctx, branch, query) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const term = clean(query).slice(0, 60);
    if (!term) return { items: [] };
    const escape = value => value.replace(/[\\%_]/gu, '\\$&');
    const codeTerm = escape(lower(term));
    const { rows } = await getDb().query(
      `SELECT code, name FROM products
       WHERE branch = $1 AND (lower(regexp_replace(code, '\\s+', '', 'g')) LIKE '%' || $2 || '%' ESCAPE '\\' OR name ILIKE '%' || $3 || '%' ESCAPE '\\')
       ORDER BY (lower(regexp_replace(code, '\\s+', '', 'g')) LIKE $2 || '%' ESCAPE '\\') DESC, code
       LIMIT 12`,
      [DB_BRANCH[branch], codeTerm, escape(term)]);
    return { items: rows.map(row => ({ code: normalizeCode(row.code), name: clean(row.name) })) };
  }

  const FIELD_COLUMN = { notes: 'notes', arrivalDate: 'arrival_date', location: 'location' };
  const fieldChanges = (row, next) => ['notes', 'arrivalDate', 'location']
    .filter(field => next[field] !== undefined && next[field] !== row[FIELD_COLUMN[field]])
    .map(field => ({ field, oldValue: row[FIELD_COLUMN[field]], newValue: next[field] }));

  // Dong da co cung (ma, vi tri) (khong phan biet hoa/thuong); exceptId bo qua chinh dong dang sua.
  async function findSamePosition(client, branch, code, location, exceptId = null) {
    const { rows } = await client.query(
      `SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 AND lower(regexp_replace(code, '\\s+', '', 'g')) = $2 AND upper(regexp_replace(location, '\\s+', '', 'g')) = $3
         AND ($4::bigint IS NULL OR id <> $4) ORDER BY id LIMIT 1 FOR UPDATE`,
      [branch, lower(code), normalizeLocation(location), exceptId]);
    return rows[0] || null;
  }

  async function create(ctx, branch, body = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const code = textField(body, 'code', 'Mã hàng');
    if (!code) throw fail(400, 'VALIDATION', 'Vui lòng nhập mã hàng.', { field: 'code' });
    const notes = validNotes(body);
    if (isEmptyNote(notes)) throw fail(400, 'VALIDATION', 'Ghi chú phải có số lượng lớn hơn 0.', { field: 'notes' });
    const arrivalDate = textField(body, 'arrivalDate', 'Ngày về');
    const location = locationField(body);
    const actor = actorOf(ctx);
    const db = getDb();
    let merged = false;
    const id = await withTransaction(db, async client => {
      await lockBranch(client, branch);
      const product = (await resolveCodes(client, branch, [code])).get(lower(code));
      const finalCode = product ? product.code : code;
      // Da co dong cung ma + vi tri: tu cong ghi chu vao dong do (Ngay ve lay theo lan nhap moi neu co).
      const same = await findSamePosition(client, branch, finalCode, location);
      if (same) {
        const added = mergeNotes(same.notes, notes);
        if (added === null) throw fail(400, 'VALIDATION', 'Ghi chú sai định dạng nên không cộng được vào dòng sẵn có. Hãy sửa lại ghi chú.', { field: 'notes' });
        const nextDate = arrivalDate || same.arrival_date;
        await client.query(
          `UPDATE stock_positions SET notes = $2, arrival_date = $3, version = version + 1, updated_by_user_id = $4, updated_by_name = $5, updated_at = now() WHERE id = $1`,
          [same.id, added, nextDate, actor.id, actor.name]);
        const changes = fieldChanges(same, { notes: added, arrivalDate: nextDate });
        await writeHistory(client, branch, actor, changes.map(change => ({ positionId: same.id, code: same.code, location: same.location, action: 'edit', ...change, summary: { merged: true, added: notes } })));
        merged = true;
        return same.id;
      }
      const { rows } = await client.query(
        `INSERT INTO stock_positions (branch, code, name, notes, arrival_date, location, updated_by_user_id, updated_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [branch, finalCode, product ? product.name : '', notes, arrivalDate, location, actor.id, actor.name]);
      await writeHistory(client, branch, actor, [{ positionId: rows[0].id, code: finalCode, location, action: 'create', newValue: notes, summary: { notes, arrivalDate, location } }]);
      return rows[0].id;
    });
    productCache.get(branch)?.delete(code);
    const row = (await db.query(`SELECT ${ROW_COLUMNS} FROM stock_positions WHERE id = $1`, [id])).rows[0];
    return { row: await shapeOne(db, row), merged };
  }

  // Doc 1 dong de sua (khoa dong), kiem tra pham vi co so + version.
  async function lockRow(client, ctx, id, version) {
    if (!Number.isInteger(id) || id < 1) throw fail(400, 'VALIDATION', 'Mã dòng không hợp lệ.');
    const head = (await client.query('SELECT branch FROM stock_positions WHERE id = $1', [id])).rows[0];
    if (!head) throw fail(404, 'NOT_FOUND', 'Không tìm thấy dòng vị trí (có thể đã bị xóa).');
    assertScope(ctx, head.branch);
    await lockBranch(client, head.branch);
    const row = (await client.query(`SELECT ${ROW_COLUMNS} FROM stock_positions WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'Không tìm thấy dòng vị trí (có thể đã bị xóa).');
    if (version !== undefined && version !== null && Number(version) !== row.version) {
      throw fail(409, 'VERSION_CONFLICT', 'Dòng đã bị người khác sửa. Dữ liệu mới nhất đã được tải lại.', { latest: await shapeOne(client, row) });
    }
    return row;
  }

  async function update(ctx, id, body = {}) {
    const actor = actorOf(ctx);
    const db = getDb();
    return withTransaction(db, async client => {
      const row = await lockRow(client, ctx, id, body.version);
      const next = {};
      const knownProduct = (await resolveCodes(client, row.branch, [row.code])).has(lower(row.code));
      if (body.notes !== undefined) next.notes = knownProduct ? validNotes(body) : textField(body, 'notes', 'Ghi chú');
      if (body.arrivalDate !== undefined) next.arrivalDate = textField(body, 'arrivalDate', 'Ngày về');
      if (body.location !== undefined) next.location = locationField(body);
      const changes = fieldChanges(row, next);
      if (!changes.length) return { row: await shapeOne(client, row) };
      const merged = { notes: next.notes ?? row.notes, arrivalDate: next.arrivalDate ?? row.arrival_date, location: next.location ?? row.location };
      if (next.location !== undefined && await findSamePosition(client, row.branch, row.code, merged.location, row.id)) {
        throw fail(409, 'DUPLICATE_POSITION', 'Mã hàng này đã có ở vị trí đó. Hãy dùng Thêm dòng để cộng vào dòng sẵn có.', { field: 'location' });
      }
      if (knownProduct && next.notes !== undefined && isEmptyNote(merged.notes)) {
        await assertNotHeld(client, row);
        if (!body.confirmEmpty) throw fail(409, 'WOULD_AUTO_DELETE', 'Số lượng về 0 nên dòng sẽ bị xóa. Xác nhận để tiếp tục.');
        await removeRow(client, row.branch, actor, row, 'auto_delete', { newValue: merged.notes });
        return { deleted: true, id: Number(row.id) };
      }
      const { rows } = await client.query(
        `UPDATE stock_positions SET notes = $2, arrival_date = $3, location = $4, version = version + 1,
           updated_by_user_id = $5, updated_by_name = $6, updated_at = now() WHERE id = $1 RETURNING ${ROW_COLUMNS}`,
        [row.id, merged.notes, merged.arrivalDate, merged.location, actor.id, actor.name]);
      await writeHistory(client, row.branch, actor, changes.map(change => ({ positionId: row.id, code: row.code, location: merged.location, action: 'edit', ...change })));
      return { row: await shapeOne(client, rows[0]) };
    });
  }

  // Tru SL (vd 3T x 100 tru 200 -> 1T x 100). Ve 0 thi tu xoa dong. Dung cho luong nhat hang ve sau.
  async function deduct(ctx, id, body = {}) {
    const quantity = Number(body.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) throw fail(400, 'VALIDATION', 'Số lượng trừ phải lớn hơn 0.', { field: 'quantity' });
    const actor = actorOf(ctx);
    return withTransaction(getDb(), async client => {
      const row = await lockRow(client, ctx, id, body.version);
      if (!(await resolveCodes(client, row.branch, [row.code])).has(lower(row.code))) {
        throw fail(400, 'NOT_DEDUCTIBLE', 'Mã hàng chưa có trên KiotViet nên không tự động trừ số lượng được.');
      }
      const spec = carton.parseSpec(row.notes);
      if (!spec || spec.empty) throw fail(400, 'NOT_DEDUCTIBLE', 'Ghi chú không đọc được hoặc đã hết hàng nên không trừ được.');
      const result = carton.deduct(spec, quantity);
      if (!result) throw fail(400, 'VALIDATION', 'Số lượng trừ vượt quá số lượng hiện có (' + spec.quantity + ').', { field: 'quantity' });
      if (isEmptyNote(result.text)) {
        await assertNotHeld(client, row);
        await removeRow(client, row.branch, actor, row, 'auto_delete', { newValue: result.text, summary: { deducted: quantity } });
        return { deleted: true, id: Number(row.id) };
      }
      const { rows } = await client.query(
        `UPDATE stock_positions SET notes = $2, version = version + 1, updated_by_user_id = $3, updated_by_name = $4, updated_at = now()
         WHERE id = $1 RETURNING ${ROW_COLUMNS}`, [row.id, result.text, actor.id, actor.name]);
      await writeHistory(client, row.branch, actor, [{ positionId: row.id, code: row.code, location: row.location, action: 'deduct', field: 'notes', oldValue: row.notes, newValue: result.text, summary: { deducted: quantity } }]);
      return { row: await shapeOne(client, rows[0]) };
    });
  }

  async function remove(ctx, id, version) {
    const actor = actorOf(ctx);
    return withTransaction(getDb(), async client => {
      const row = await lockRow(client, ctx, id, version);
      await assertNotHeld(client, row);
      await removeRow(client, row.branch, actor, row, 'delete');
      return { deleted: true, id: Number(row.id) };
    });
  }

  // Bat/tat co "Da sua" (xac nhan canh bao). Khong doi du lieu nen khong doi updated_at/nguoi sua cuoi, chi tang version (khoa lac quan).
  async function acknowledge(ctx, id, body = {}) {
    if (typeof body.acknowledged !== 'boolean') throw fail(400, 'VALIDATION', 'Thiếu trạng thái Đã sửa (true/false).', { field: 'acknowledged' });
    const actor = actorOf(ctx);
    return withTransaction(getDb(), async client => {
      const row = await lockRow(client, ctx, id, body.version);
      if (Boolean(row.format_ack) === body.acknowledged) return { row: await shapeOne(client, row) };
      const product = (await loadProducts(client, row.branch, [row.code])).get(row.code);
      const warnings = carton.warnings(row.notes, { unknownCode: !product });
      if (body.acknowledged && !warnings.length) throw fail(409, 'NOTHING_TO_ACK', 'Dòng này không có cảnh báo nên không cần đánh dấu Đã sửa.');
      const { rows } = await client.query(`UPDATE stock_positions SET format_ack = $2, version = version + 1 WHERE id = $1 RETURNING ${ROW_COLUMNS}`, [row.id, body.acknowledged]);
      await writeHistory(client, row.branch, actor, [{ positionId: row.id, code: row.code, location: row.location, action: body.acknowledged ? 'ack' : 'unack', summary: { warnings, notes: row.notes } }]);
      return { row: await shapeOne(client, rows[0]) };
    });
  }

  // positionId (tuy chon): chi lay lich su cua mot dong; gia tri khong phai so nguyen duong thi bo qua nhu `before`.
  async function history(ctx, branch, { limit, before, positionId } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const size = Math.min(HISTORY_MAX, Math.max(1, Number.parseInt(limit, 10) || 200));
    const beforeId = Number.parseInt(before, 10);
    const rowId = Number.parseInt(positionId, 10);
    const { rows } = await getDb().query(
      `SELECT id, created_at, branch, position_id, code, location, action, field, old_value, new_value, summary, actor_name
       FROM stock_position_history WHERE branch = $1 AND ($2::bigint IS NULL OR id < $2) AND ($4::bigint IS NULL OR position_id = $4)
       ORDER BY id DESC LIMIT $3`,
      [branch, Number.isInteger(beforeId) && beforeId > 0 ? beforeId : null, size, Number.isInteger(rowId) && rowId > 0 ? rowId : null]);
    return {
      rows: rows.map(r => ({
        id: Number(r.id), createdAt: isoOf(r.created_at), branch: r.branch, positionId: r.position_id === null ? null : Number(r.position_id),
        code: r.code, location: r.location, action: r.action, field: r.field, oldValue: r.old_value, newValue: r.new_value, summary: r.summary, actorName: r.actor_name
      })),
      nextBefore: rows.length === size ? Number(rows[rows.length - 1].id) : null
    };
  }

  // Toan bo lich su cua co so (xuat Excel): loc hanh dong o SQL, loc tu khoa (khong dau, khong phan biet hoa/thuong) o day.
  // Doc toi da HISTORY_EXPORT_MAX dong moi nhat; truncated=true neu con dong cu hon bi bo.
  async function historyAll(ctx, branch, { action, q } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const actionCode = clean(action);
    const params = [branch];
    let where = 'branch = $1';
    if (actionCode) { params.push(actionCode); where += ' AND action = $2'; }
    params.push(HISTORY_EXPORT_MAX + 1);
    const { rows } = await getDb().query(
      `SELECT id, created_at, branch, position_id, code, location, action, field, old_value, new_value, summary, actor_name
       FROM stock_position_history WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`, params);
    const truncated = rows.length > HISTORY_EXPORT_MAX;
    const needle = foldText(q);
    const entries = rows.slice(0, HISTORY_EXPORT_MAX).map(r => ({
      id: Number(r.id), createdAt: isoOf(r.created_at), branch: r.branch, positionId: r.position_id === null ? null : Number(r.position_id),
      code: r.code, location: r.location, action: r.action, field: r.field, oldValue: r.old_value, newValue: r.new_value, summary: r.summary, actorName: r.actor_name
    }));
    const matches = entry => foldText([entry.actorName, entry.code, entry.location, ACTION_LABELS[entry.action], FIELD_LABELS[entry.field] || entry.field,
      entry.oldValue, entry.newValue, summaryText(entry.summary)].join(' ')).includes(needle);
    return { rows: needle ? entries.filter(matches) : entries, truncated };
  }

  // Xoa lich su cua MOT co so theo khoang ngay (gio VN, gom ca 2 dau; trong = khong gioi han). Trigger chi cho DELETE khi
  // giao dich dat app.history_purge = 'on'. Xong ghi 1 dong 'history_purged' (nam ngoai pham vi vua xoa) lam dau vet.
  async function purgeHistory(ctx, branch, { from, to } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    const fromDay = dateParam(from, 'from');
    const toDay = dateParam(to, 'to');
    if (fromDay && toDay && fromDay > toDay) throw fail(400, 'VALIDATION', 'Từ ngày phải trước hoặc bằng Đến ngày.', { field: 'from' });
    const actor = actorOf(ctx);
    return withTransaction(getDb(), async client => {
      await lockBranch(client, branch);
      await client.query(`SELECT set_config('app.history_purge', 'on', true)`);
      const { rows } = await client.query(
        `DELETE FROM stock_position_history WHERE branch = $1
           AND ($2::date IS NULL OR created_at >= $2::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
           AND ($3::date IS NULL OR created_at < ($3::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
         RETURNING id`, [branch, fromDay, toDay]);
      await client.query(`SELECT set_config('app.history_purge', 'off', true)`);
      const summary = { deleted: rows.length, from: fromDay, to: toDay };
      await writeHistory(client, branch, actor, [{ action: 'history_purged', summary }]);
      return summary;
    });
  }

  // ---- Import file Excel/CSV (4 cot: Ma hang, Ghi chu, Ngay ve, Vi tri) ----

  // Thuan tuy: tu dong file + dong hien co + bang tra ma -> ke hoach them/doi/xoa/loi.
  function planImport(mode, fileRows, existing, resolved, holders = new Map()) {
    const errors = [];
    const skipped = [];
    const unchangedRows = [];
    const adds = [];
    const updates = [];
    const unchangedIds = [];
    let skippedEmpty = 0;
    const byKey = new Map();
    for (const row of existing) if (!byKey.has(keyOf(row.code, row.location))) byKey.set(keyOf(row.code, row.location), row);
    const entries = new Map(); // (ma, vi tri) -> dong da gop (dong trung trong file tu cong ghi chu)
    const touched = new Set();
    for (const [sourceIndex, line] of fileRows.entries()) {
      const invalid = message => { skippedEmpty += 1; skipped.push({ ...line, sourceIndexes: [sourceIndex], message }); };
      const code = normalizeCode(line.code);
      if (!code) { invalid('Thiếu mã hàng.'); continue; }
      const product = resolved.get(lower(code));
      const location = normalizeLocation(line.location);
      const notes = carton.normalizeStoredNote(clean(line.notes));
      if (notes.length > MAX.notes || code.length > MAX.code || location.length > MAX.location || clean(line.arrivalDate).length > MAX.arrivalDate) {
        invalid('Dữ liệu quá dài (mã ≤ 60, ghi chú ≤ 500, ngày về ≤ 60, vị trí ≤ 100 ký tự).'); continue;
      }
      const spec = carton.parseSpec(notes);
      // Free-form notes are imported with warnings; an unreadable quantity is not zero.
      if (product && spec && spec.quantity === 0) { skippedEmpty += 1; skipped.push({ ...line, notes, sourceIndexes: [sourceIndex] }); continue; }
      const finalCode = product ? product.code : code;
      const key = keyOf(finalCode, location);
      const arrivalDate = clean(line.arrivalDate);
      const earlier = entries.get(key);
      if (earlier) {
        const sum = mergeNotes(earlier.notes, notes)
          ?? carton.normalizeStoredNote([earlier.notes, notes].filter(Boolean).join(' + '));
        earlier.sourceIndexes.push(sourceIndex);
        earlier.notes = sum;
        earlier.arrivalDate = arrivalDate || earlier.arrivalDate;
        earlier.name = (product ? product.name : clean(line.name)) || earlier.name;
        continue;
      }
      entries.set(key, { sourceIndexes: [sourceIndex], row: line.row, code: finalCode, name: product ? product.name : clean(line.name), notes, arrivalDate, location });
    }
    for (const entry of entries.values()) {
      const { row, notes, arrivalDate, location } = entry;
      const current = byKey.get(keyOf(entry.code, location));
      if (!current) { adds.push(entry); continue; }
      touched.add(current.id);
      let nextNotes = notes;
      let nextDate = arrivalDate;
      let nextLocation = location;
      const nextName = resolved.has(lower(entry.code)) ? entry.name : entry.name || clean(current.name);
      if (mode === 'add') {
        nextNotes = mergeNotes(current.notes, notes)
          ?? carton.normalizeStoredNote([clean(current.notes), notes].filter(Boolean).join(' + '));
        nextDate = arrivalDate || clean(current.arrival_date);
        nextLocation = location; // khop khong phan biet hoa/thuong/khoang trang: ghi lai theo dang chuan
      }
      if (nextNotes === current.notes && nextDate === current.arrival_date && nextLocation === current.location && nextName === current.name && entry.code === current.code) {
        unchangedIds.push(current.id);
        unchangedRows.push(entry);
      }
      else updates.push({ sourceIndexes: entry.sourceIndexes, id: current.id, code: entry.code, name: nextName, notes: nextNotes, arrivalDate: nextDate, location: nextLocation, row, before: current });
    }
    // Thay toan bo: dong hien co khong nam trong file bi xoa (ke ca dong trung ma + vi tri thua).
    // Dong dang duoc don Dang boc chi dinh thi giu lai (bao trong "bo qua"), khong xoa.
    const deletes = [];
    let keptHeld = 0;
    if (mode === 'replace' && entries.size > 0) {
      for (const row of existing) {
        if (touched.has(row.id)) continue;
        const orders = holders.get(Number(row.id));
        if (!orders || !orders.length) { deletes.push(row); continue; }
        keptHeld += 1;
        skipped.push({ row: null, code: row.code, name: row.name, notes: row.notes, arrivalDate: row.arrival_date, location: row.location, sourceIndexes: [],
          message: `Giữ lại, không xóa: đang được đơn Đang bốc ${orders.join(', ')} chỉ định.` });
      }
    }
    return { adds, updates, deletes, unchangedRows, skipped, unchanged: unchangedIds.length, skippedEmpty, keptHeld, errors };
  }

  const countsOf = plan => ({ added: plan.adds.length, updated: plan.updates.length, deleted: plan.deletes.length, unchanged: plan.unchanged, skippedEmpty: plan.skippedEmpty, keptHeld: plan.keptHeld || 0, errors: plan.errors.length });

  // Full draft: source indexes link normalized/merged operations back to original inputs.
  function previewOf(plan, resolved, inputRows) {
    const view = (kind, entry, before) => {
      const spec = carton.parseSpec(clean(entry.notes));
      return {
        kind, row: entry.row ?? null, code: entry.code, name: clean(entry.name), notes: clean(entry.notes),
        arrivalDate: clean(entry.arrivalDate ?? entry.arrival_date), location: clean(entry.location),
        cartons: spec ? spec.cartons : null, quantity: spec ? spec.quantity : null,
        sourceIndexes: entry.sourceIndexes || [],
        warnings: kind === 'delete' ? [] : carton.warnings(entry.notes, { unknownCode: !resolved.has(lower(entry.code)) }),
        ...(entry.message ? { message: entry.message } : {}),
        ...(before ? { before: { notes: clean(before.notes), arrivalDate: clean(before.arrival_date), location: clean(before.location) } } : {})
      };
    };
    const rows = [
      ...plan.adds.map(entry => view('add', entry)),
      ...plan.updates.map(entry => view('update', entry, entry.before)),
      ...plan.deletes.map(entry => view('delete', entry)),
      ...plan.unchangedRows.map(entry => view('unchanged', entry)),
      ...plan.skipped.map(entry => view('skipped', entry)),
      ...plan.errors.map(entry => view('error', entry))
    ];
    return { rows, rowsTotal: rows.length, inputRows };
  }

  async function importFile(ctx, branch, { mode, commit = false, buffer, fileName = '', inputRows } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    if (!MODES.includes(mode)) throw fail(400, 'VALIDATION', 'Chế độ import phải là replace hoặc add.', { field: 'mode' });
    if (!buffer || !buffer.length) throw fail(400, 'IMPORT_FILE_REQUIRED', 'Vui lòng chọn file Excel hoặc CSV.');
    if (inputRows !== undefined && (!Array.isArray(inputRows) || inputRows.some(line => !line || typeof line !== 'object' || Array.isArray(line)
      || ['code', 'name', 'notes', 'arrivalDate', 'location'].some(field => line[field] !== undefined && typeof line[field] !== 'string')))) {
      throw fail(400, 'IMPORT_INVALID_ROWS', 'Danh sách dòng import không hợp lệ.');
    }
    const fileRows = (inputRows === undefined ? parseImportWorkbook(buffer, { fileName, now: new Date(now()) }) : inputRows).map(line => ({
      row: Number.isSafeInteger(line.row) && line.row > 0 ? line.row : null,
      code: String(line.code ?? ''), name: String(line.name ?? ''), notes: String(line.notes ?? ''),
      arrivalDate: String(line.arrivalDate ?? ''), location: String(line.location ?? '')
    }));
    if (!fileRows.length) throw fail(400, 'IMPORT_EMPTY_FILE', 'Danh sách import cần ít nhất một dòng dữ liệu.');
    const actor = actorOf(ctx);
    const db = getDb();
    const run = async client => {
      const existing = (await client.query(`SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 ORDER BY id`, [branch])).rows;
      const resolved = await resolveCodes(client, branch, fileRows.map(line => line.code));
      const holders = mode === 'replace' ? await holdersByPosition(client, branch, existing.map(row => Number(row.id))) : new Map();
      return { plan: planImport(mode, fileRows, existing, resolved, holders), resolved };
    };
    const response = (plan, extra = {}) => ({ mode, commit: Boolean(commit), counts: countsOf(plan), errors: plan.errors.slice(0, ERROR_LIMIT), ...extra });
    if (!commit) { const { plan, resolved } = await run(db); return response(plan, previewOf(plan, resolved, fileRows)); }

    return withTransaction(db, async client => {
      await lockBranch(client, branch);
      const { plan, resolved } = await run(client);
      const summaryAction = mode === 'replace' ? 'import_replace' : 'import_add';
      const entries = [{ action: summaryAction, summary: { file: fileName, ...countsOf(plan) } }];
      if (plan.adds.length) {
        const col = pick => plan.adds.map(pick);
        const { rows } = await client.query(
          `INSERT INTO stock_positions (branch, code, name, notes, arrival_date, location, updated_by_user_id, updated_by_name)
           SELECT $1, t.code, t.name, t.notes, t.arrival_date, t.location, $2, $3
           FROM unnest($4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS t(code, name, notes, arrival_date, location)
           RETURNING id, code, location, notes`,
          [branch, actor.id, actor.name, col(a => a.code), col(a => a.name), col(a => a.notes), col(a => a.arrivalDate), col(a => a.location)]);
        for (const r of rows) entries.push({ positionId: r.id, code: r.code, location: r.location, action: 'create', newValue: r.notes });
      }
      if (plan.updates.length) {
        const col = pick => plan.updates.map(pick);
        await client.query(
          `UPDATE stock_positions p SET code = u.code, notes = u.notes, arrival_date = u.arrival_date, location = u.location, name = u.name, version = p.version + 1,
             updated_by_user_id = $2, updated_by_name = $3, updated_at = now()
           FROM unnest($1::bigint[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[]) AS u(id, notes, arrival_date, location, name, code) WHERE p.id = u.id`,
          [col(u => u.id), actor.id, actor.name, col(u => u.notes), col(u => u.arrivalDate), col(u => u.location), col(u => u.name), col(u => u.code)]);
        for (const u of plan.updates) {
          if (u.code !== u.before.code) entries.push({ positionId: u.id, code: u.code, location: u.location, action: 'edit', field: 'code', oldValue: u.before.code, newValue: u.code });
          if (u.name !== u.before.name) entries.push({ positionId: u.id, code: u.code, location: u.location, action: 'edit', field: 'name', oldValue: u.before.name, newValue: u.name });
          for (const change of fieldChanges(u.before, { notes: u.notes, arrivalDate: u.arrivalDate, location: u.location })) {
            entries.push({ positionId: u.id, code: u.code, location: u.location, action: 'edit', ...change });
          }
        }
      }
      if (plan.deletes.length) {
        await client.query('DELETE FROM stock_positions WHERE id = ANY($1::bigint[])', [plan.deletes.map(r => r.id)]);
        for (const r of plan.deletes) entries.push({ positionId: r.id, code: r.code, location: r.location, action: 'delete', field: 'notes', oldValue: r.notes });
      }
      await writeHistory(client, branch, actor, entries);
      productCache.delete(branch);
      return response(plan, { imported: true });
    });
  }

  // ---- Xuat kho tu file Excel/CSV (3 cot: Ma hang, Ghi chu so thung, Vi tri; Ngay ve neu co thi bo qua) ----

  // Thuan tuy: tu dong file + dong hien co + gioi han giu cho -> ke hoach tru. Dong sai thi bo qua, dong dung van tru.
  // Dong trung (ma, vi tri) trong file xu ly TUAN TU theo thu tu file tren ghi chu dang con lai: moi dong tru theo dung quy cach cua no,
  // dong nao tru qua so con lai (da tru cac dong truoc) thi bi bo qua rieng; tong da tru khong bao gio vuot ton.
  function planStockOut(fileRows, existing, held) {
    const byKey = new Map(); // (ma, vi tri) -> cac dong luu tru (du lieu dau co the trung), theo id
    for (const row of existing) {
      const key = keyOf(row.code, row.location);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ row, notes: row.notes, deducted: 0, fileRows: [] });
    }
    const errors = [];
    let applied = 0;
    for (const line of fileRows) {
      const reject = message => errors.push({ row: line.row, code: clean(line.code), location: clean(line.location), notes: clean(line.notes), message });
      const code = normalizeCode(line.code);
      const location = normalizeLocation(line.location);
      if (!code) { reject('Thiếu mã hàng.'); continue; }
      if (!location) { reject('Thiếu vị trí.'); continue; }
      const spec = carton.parseSpec(carton.normalizeStoredNote(clean(line.notes)));
      const quantity = spec && !spec.empty ? spec.quantity : 0;
      if (!spec || !Number.isSafeInteger(quantity) || quantity <= 0) { reject('Ghi chú sai định dạng hoặc không có số lượng (vd 1T x 50).'); continue; }
      const candidates = byKey.get(keyOf(code, location));
      if (!candidates) { reject('Không có dòng nào cùng mã hàng và vị trí trong cơ sở này.'); continue; }
      let target = null;
      let result = null;
      let available = 0;
      let reason = '';
      for (const candidate of candidates) {
        const current = carton.parseSpec(candidate.notes);
        if (!current || current.empty) { reason = reason || 'Ghi chú của dòng đang lưu không đọc được hoặc đã hết hàng nên không trừ được.'; continue; }
        const free = Math.max(0, current.quantity - (held.get(Number(candidate.row.id)) || 0));
        available += free;
        // Phan giu cho cua phieu boc "Dang boc" khong duoc xuat: chi tru toi da SL co the boc.
        if (quantity > free) continue;
        const deducted = carton.deduct(current, quantity);
        if (deducted) { target = candidate; result = deducted; break; }
      }
      if (!target) {
        reject(reason && !available ? reason : `Số lượng xuất ${quantity} vượt quá số lượng có thể xuất (${available}).`);
        continue;
      }
      target.notes = result.text;
      target.deducted += quantity;
      target.fileRows.push(line.row);
      applied += 1;
    }
    const changed = [...byKey.values()].flat().filter(entry => entry.deducted > 0).map(entry => ({ ...entry, removed: isEmptyNote(entry.notes) }));
    return { changed, errors, applied, total: changed.reduce((sum, entry) => sum + entry.deducted, 0) };
  }

  // Tru so luong theo file. Mot buoc: doc file -> ap dung ngay (khong co buoc xem truoc), tra ve ket qua + danh sach dong bo qua.
  async function stockOutFile(ctx, branch, { buffer, fileName = '' } = {}) {
    assertBranch(branch);
    assertScope(ctx, branch);
    if (!buffer || !buffer.length) throw fail(400, 'IMPORT_FILE_REQUIRED', 'Vui lòng chọn file Excel hoặc CSV.');
    const fileRows = parseImportWorkbook(buffer, { fileName, now: new Date(now()), requireArrivalDate: false });
    const actor = actorOf(ctx);
    return withTransaction(getDb(), async client => {
      await lockBranch(client, branch);
      const existing = (await client.query(`SELECT ${ROW_COLUMNS} FROM stock_positions WHERE branch = $1 ORDER BY id FOR UPDATE`, [branch])).rows;
      const held = await heldByPosition(client, branch, existing.map(row => Number(row.id)));
      const plan = planStockOut(fileRows, existing, held);
      const kept = plan.changed.filter(entry => !entry.removed);
      const removed = plan.changed.filter(entry => entry.removed);
      if (kept.length) {
        const col = pick => kept.map(pick);
        await client.query(
          `UPDATE stock_positions p SET notes = u.notes, version = p.version + 1, updated_by_user_id = $2, updated_by_name = $3, updated_at = now()
           FROM unnest($1::bigint[], $4::text[]) AS u(id, notes) WHERE p.id = u.id`,
          [col(e => e.row.id), actor.id, actor.name, col(e => e.notes)]);
      }
      if (removed.length) await client.query('DELETE FROM stock_positions WHERE id = ANY($1::bigint[])', [removed.map(e => e.row.id)]);
      await writeHistory(client, branch, actor, plan.changed.map(entry => ({
        positionId: entry.row.id, code: entry.row.code, location: entry.row.location, action: 'stock_out', field: 'notes',
        oldValue: entry.row.notes, newValue: entry.removed ? null : entry.notes,
        summary: { deducted: entry.deducted, removed: entry.removed, fileName, fileRows: entry.fileRows }
      })));
      if (plan.changed.length) productCache.delete(branch);
      else touchedBranches.delete(client); // khong doi gi thi khong phat tin hieu "da doi"
      return {
        fileName,
        counts: { fileRows: fileRows.length, applied: plan.applied, updated: kept.length, deleted: removed.length, skipped: plan.errors.length, quantity: plan.total },
        errors: plan.errors.slice(0, STOCK_OUT_ERROR_LIMIT),
        errorsTruncated: plan.errors.length > STOCK_OUT_ERROR_LIMIT
      };
    });
  }

  /* Chuẩn hóa hàng loạt ghi chú đã lưu (số trần 60 -> 1T x 60, gộp cộng dồn, thống nhất ký hiệu) bằng đúng hàm của VT.
     Mỗi dòng đổi: version + 1 và 1 dòng lịch sử 'edit' (người sửa = NORMALIZE_ACTOR). Không xóa dòng, không đụng dòng đã chuẩn.
     dryRun (mặc định) chỉ đếm và trả mẫu. Chạy lại an toàn (idempotent). */
  async function normalizeAllNotes({ branch, dryRun = true } = {}) {
    assertBranch(branch);
    const db = getDb();
    return withTransaction(db, async client => {
      await lockBranch(client, branch);
      const { rows } = await client.query(`SELECT ${BASE_COLUMNS} FROM stock_positions WHERE branch = $1 ORDER BY id FOR UPDATE`, [branch]);
      const changed = rows.map(row => ({ row, next: carton.normalizeStoredNote(row.notes) })).filter(({ row, next }) => next !== row.notes);
      if (!dryRun && changed.length) {
        const actor = { id: null, name: NORMALIZE_ACTOR };
        for (const { row, next } of changed) {
          await client.query('UPDATE stock_positions SET notes = $2, version = version + 1, updated_by_user_id = NULL, updated_by_name = $3, updated_at = now() WHERE id = $1', [row.id, next, actor.name]);
        }
        await writeHistory(client, branch, actor, changed.map(({ row, next }) => ({ positionId: row.id, code: row.code, location: row.location, action: 'edit', field: 'notes', oldValue: row.notes, newValue: next, summary: { normalized: true } })));
      }
      return { branch, scanned: rows.length, changed: changed.length, dryRun, sample: changed.slice(0, 20).map(({ row, next }) => ({ code: row.code, location: row.location, from: row.notes, to: next })) };
    });
  }

  /* Gộp các dòng đã lưu trùng (mã, vị trí) (dữ liệu đầu sao từ Google Sheets không có ràng buộc UNIQUE) thành 1 dòng:
     giữ dòng id nhỏ nhất, cộng dồn ghi chú bằng mergeNotes (Ngày về lấy dòng mới nhất có giá trị), xóa các dòng còn lại,
     ghi lịch sử 'edit' + 'delete'. Nhóm có ghi chú sai định dạng hoặc dòng đang được phiếu bốc giữ chỗ thì bỏ qua và báo lại.
     dryRun (mặc định) chỉ đếm. Chạy lại an toàn (idempotent). */
  async function mergeDuplicateRows({ branch, dryRun = true } = {}) {
    assertBranch(branch);
    const db = getDb();
    return withTransaction(db, async client => {
      await lockBranch(client, branch);
      const { rows } = await client.query(`SELECT ${BASE_COLUMNS} FROM stock_positions WHERE branch = $1 ORDER BY id FOR UPDATE`, [branch]);
      const groups = new Map();
      for (const row of rows) {
        const key = keyOf(row.code, row.location);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row);
      }
      const dupGroups = [...groups.values()].filter(group => group.length > 1);
      const doomedIds = dupGroups.flatMap(group => group.slice(1).map(row => Number(row.id)));
      const referenced = new Set();
      if (doomedIds.length && (await client.query(`SELECT to_regclass('order_pick_lines') IS NOT NULL AS ready`)).rows[0].ready) {
        for (const r of (await client.query('SELECT DISTINCT position_id FROM order_pick_lines WHERE position_id = ANY($1::bigint[])', [doomedIds])).rows) referenced.add(Number(r.position_id));
      }
      const plan = [];
      const skipped = [];
      for (const group of dupGroups) {
        const [keep, ...rest] = group;
        let notes = keep.notes;
        let failed = false;
        for (const row of rest) {
          const sum = mergeNotes(notes, row.notes);
          if (sum === null) { failed = true; break; }
          notes = sum;
        }
        if (failed) { skipped.push({ code: keep.code, location: keep.location, reason: 'Ghi chú sai định dạng' }); continue; }
        if (rest.some(row => referenced.has(Number(row.id)))) { skipped.push({ code: keep.code, location: keep.location, reason: 'Đang có phiếu bốc dùng dòng trùng' }); continue; }
        const arrivalDate = [...group].reverse().map(row => clean(row.arrival_date)).find(Boolean) || '';
        plan.push({ keep, rest, notes, arrivalDate });
      }
      if (!dryRun && plan.length) {
        const actor = { id: null, name: MERGE_ACTOR };
        const entries = [];
        for (const { keep, rest, notes, arrivalDate } of plan) {
          await client.query('UPDATE stock_positions SET notes = $2, arrival_date = $3, version = version + 1, updated_by_user_id = NULL, updated_by_name = $4, updated_at = now() WHERE id = $1', [keep.id, notes, arrivalDate, actor.name]);
          await client.query('DELETE FROM stock_positions WHERE id = ANY($1::bigint[])', [rest.map(row => row.id)]);
          entries.push({ positionId: keep.id, code: keep.code, location: keep.location, action: 'edit', field: 'notes', oldValue: keep.notes, newValue: notes, summary: { duplicatesMerged: rest.length } });
          for (const row of rest) entries.push({ positionId: row.id, code: row.code, location: row.location, action: 'delete', field: 'notes', oldValue: row.notes, summary: { mergedInto: Number(keep.id) } });
        }
        await writeHistory(client, branch, actor, entries);
        productCache.delete(branch);
      }
      return {
        branch, scanned: rows.length, groups: plan.length, removed: plan.reduce((sum, p) => sum + p.rest.length, 0), skipped, dryRun,
        sample: plan.slice(0, 20).map(p => ({ code: p.keep.code, location: p.keep.location, from: [p.keep, ...p.rest].map(row => row.notes), to: p.notes }))
      };
    });
  }

  return { list, suggestCodes, create, update, deduct, remove, acknowledge, history, historyAll, purgeHistory, importFile, stockOutFile, normalizeAllNotes, mergeDuplicateRows };
}

// `tx`: helper giao dich dung chung cho module khac can tru/cong thung that trong cung giao dich + khoa co so (pickAssignments).
const tx = Object.freeze({
  withTransaction, lockBranch, writeHistory, removeRow, fail, assertBranch, assertScope, actorOf, lower, normalizeLocation,
  isEmptyNote, isoOf, ROW_COLUMNS: BASE_COLUMNS, BRANCH_CODES, DB_BRANCH
});

module.exports = { createStockPositionsService, mergeNotes, keyOf, normalizeLocation, tx, ...createStockPositionsService() };
