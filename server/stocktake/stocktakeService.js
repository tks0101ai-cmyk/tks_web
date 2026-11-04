'use strict';

// Kiem ke (doi chieu), migration 0105. So dem tinh truc tiep tu don dat hang cua khach "TEAM..." trong khoang ngay
// cua dot (ca don da huy) + phan sua tren web; ton/gia von la ton hien tai cua products. Dong dot -> chup ket qua.
// Moi lenh ghi: 1 giao dich, khoa dong + so version (lech -> 409 kem ban moi), ghi stocktake_history cung giao dich.
const { getPool } = require('../db/pool');
const { stripTelegramId } = require('../dashboard/saleName');
const { codeKey, buildBoard, toResults, deriveColumns, totalsOf } = require('./stocktakeCompute');
const { PASTE_COLUMNS, normalizeValue, parseVnNumber, foldName, columnValue, sameValue } = require('../public/stocktake/stocktakePaste');
const Status = require('../public/stocktake/stocktakeStatus');
const { announceChanged } = require('./stocktakeEvents');

const BRANCHES = Object.freeze(['hanoi', 'saigon']);
const CACHE_TTL_MS = 60 * 1000; // ton KiotViet dong bo moi 10 phut, 1 phut cache khong lam cham them
const MAX = Object.freeze({ name: 120, text: 200, note: 1000, print: 50 });
const MAX_QUANTITY = 1e9;
const MAX_PASTE_ROWS = 10000;
// Cot dan -> bang dich + truong trong ban ghi da shape.
const NOTE_FIELDS = Object.freeze({ statusText: 'statusText', reasonText: 'reasonText', printPage: 'printPage', printTime: 'printTime', prevDiffManual: 'prevDiffManual', otherDiffManual: 'otherDiffManual' });
const TAG_FIELDS = Object.freeze({ cluster: 'cluster', combo: 'isCombo' });
const EMPTY_NOTE = Object.freeze({ statusText: '', reasonText: '', printPage: '', printTime: '', recheckEmployeeId: null, recheckName: '', prevDiffManual: null, otherDiffManual: null });
const EMPTY_TAG = Object.freeze({ cluster: '', isCombo: false });

// Nguoi kiem lai dan vao: khop dung 1 nhan su cung co so (so ten bo dau) -> gan id; khong -> giu chu.
function recheckOf(value, employees) {
  if (!value) return { recheckEmployeeId: null, recheckName: '' };
  const matches = employees.filter(e => foldName(e.name) === foldName(value));
  return matches.length === 1 ? { recheckEmployeeId: matches[0].id, recheckName: '' } : { recheckEmployeeId: null, recheckName: value };
}

function nextRecord(column, before, value, employees) {
  if (TAG_FIELDS[column]) {
    const base = { cluster: before ? before.cluster : '', isCombo: Boolean(before && before.isCombo) };
    return { ...base, [TAG_FIELDS[column]]: column === 'combo' ? Boolean(value) : value };
  }
  const base = {};
  for (const key of Object.keys(EMPTY_NOTE)) base[key] = before && before[key] !== undefined ? before[key] : EMPTY_NOTE[key];
  if (column === 'recheck') return { ...base, ...recheckOf(value, employees) };
  return { ...base, [NOTE_FIELDS[column]]: value };
}

function sameRecord(column, before, next) {
  const empty = TAG_FIELDS[column] ? EMPTY_TAG : EMPTY_NOTE;
  return Object.keys(empty).every(key => (before && before[key] !== undefined ? before[key] : empty[key]) === next[key]);
}

function fail(statusCode, code, message, extra = {}) {
  return Object.assign(new Error(message), { statusCode, code }, extra);
}

const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const isoOf = value => (value ? (value instanceof Date ? value : new Date(value)).toISOString() : null);
const dateOf = value => (value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10));

function actorOf(ctx) {
  const user = ctx.user || {};
  return { id: user.id === undefined || user.id === null ? null : String(user.id), name: stripTelegramId(user.hoTen || user.username || '') };
}

function assertScope(ctx, branch) {
  if (ctx.scope && !ctx.scope.includes(branch)) throw fail(403, 'BRANCH_OUT_OF_SCOPE', 'Cơ sở của đợt kiểm kê không thuộc phạm vi đang chọn.');
}

function assertNotCancelled(session) {
  if (session.cancelled) throw fail(409, 'STOCKTAKE_CANCELLED', 'Đợt kiểm kê đã bị hủy, không sửa được. Khôi phục đợt trước nếu cần sửa.');
}

function textOf(body, field, label, max = MAX.text) {
  const value = clean(body[field]);
  if (value.length > max) throw fail(400, 'VALIDATION', `${label} tối đa ${max} ký tự.`, { field });
  return value;
}

// Trang thai moi phai la ten chuan theo co so (stocktakeStatus.js) hoac trong (= Chua XL).
const statusInvalid = branch => `Trạng thái phải là một trong: ${Status.optionsFor(branch).map(option => option.label).join(', ')}.`;

function dateField(value, field, label) {
  const text = clean(value);
  const valid = /^\d{4}-\d{2}-\d{2}$/u.test(text) && Number.isFinite(Date.parse(text + 'T00:00:00Z'))
    && new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) === text;
  if (!valid) throw fail(400, 'VALIDATION', `${label} không hợp lệ (cần dạng yyyy-mm-dd).`, { field });
  return text;
}

// So chenh dan tay (co the am, le). '' / null = xoa (dung so tu lay).
function diffOf(value, field) {
  if (value === null || value === '') return null;
  const n = parseVnNumber(value);
  if (n === null || Math.abs(n) > MAX_QUANTITY) throw fail(400, 'VALIDATION', 'Số chênh phải là số.', { field });
  return n;
}

function quantityOf(value, field = 'quantity') {
  const n = Number(value);
  if (value === '' || value === null || !Number.isFinite(n) || n < 0 || n > MAX_QUANTITY) {
    throw fail(400, 'VALIDATION', 'Số lượng phải là số không âm.', { field });
  }
  return n;
}

const versionOf = value => (value === undefined || value === null || value === '' ? null : Number(value));

// Don dat hang cua khach "TEAM..." (ten tren KiotViet), ngay dat theo gio VN trong [date_from, date_to].
// So luong lay tu raw (co the le) truoc cot INTEGER.
const TEAM_LINES_SQL = `
  SELECT o.id AS order_id, d.line_no, o.code AS order_code, COALESCE(o.raw->>'statusValue', '') AS order_status,
         btrim(COALESCE(NULLIF(c.name, ''), o.raw->>'customerName', '')) AS team,
         btrim(COALESCE(o.raw->>'description', '')) AS zone,
         btrim(COALESCE(d.raw->>'note', '')) AS spec,
         COALESCE(NULLIF(d.raw->>'productCode', ''), p.code, '') AS product_code,
         COALESCE(NULLIF(d.raw->>'productName', ''), p.name, '') AS product_name,
         COALESCE((d.raw->>'quantity')::numeric, d.quantity, 0)::float8 AS quantity
  FROM orders o
  LEFT JOIN customers c ON c.branch = o.branch AND c.id = o.customer_id
  JOIN order_details d ON d.branch = o.branch AND d.order_id = o.id
  LEFT JOIN products p ON p.branch = d.branch AND p.id = d.product_id
  WHERE o.branch = $1
    AND (o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date BETWEEN $2::date AND $3::date
    AND upper(btrim(COALESCE(NULLIF(c.name, ''), o.raw->>'customerName', ''))) LIKE 'TEAM%'
  ORDER BY o.id, d.line_no`;

const PRODUCTS_SQL = `
  SELECT p.code, p.name,
         COALESCE((SELECT SUM((inv->>'onHand')::numeric) FROM jsonb_array_elements(COALESCE(p.raw->'inventories', '[]'::jsonb)) inv), 0)::float8 AS stock,
         COALESCE((SELECT ROUND(AVG((inv->>'cost')::numeric)) FROM jsonb_array_elements(COALESCE(p.raw->'inventories', '[]'::jsonb)) inv), 0)::float8 AS cost
  FROM products p
  WHERE p.branch = $1`;

const SESSION_COLUMNS = `id, branch, name, date_from, date_to, status, source, version, counterpart_session_id, created_by_name, created_at, closed_by_name, closed_at,
  previous_session_id, cancelled_at, cancelled_by_name, cancel_reason, reloaded_at, reloaded_by_name`;
const MAX_CANCEL_REASON = 500;
const EDIT_COLUMNS = `id, order_id, line_no, product_code, team, zone, spec, quantity::float8 AS quantity, removed, version, updated_by_name, updated_at`;
const NOTE_COLUMNS = `product_code, status_text, status_color, reason_text, recheck_employee_id, recheck_name, print_page, print_time,
  prev_diff_manual::float8 AS prev_diff_manual, other_diff_manual::float8 AS other_diff_manual, version, updated_by_name, updated_at`;
const TAG_COLUMNS = `product_code, cluster, is_combo, version, updated_by_name, updated_at`;

const shapeSession = row => ({
  id: Number(row.id),
  branch: row.branch,
  name: row.name,
  dateFrom: dateOf(row.date_from),
  dateTo: dateOf(row.date_to),
  status: row.status,
  source: row.source,
  version: row.version,
  counterpartSessionId: row.counterpart_session_id === null || row.counterpart_session_id === undefined ? null : Number(row.counterpart_session_id),
  createdByName: row.created_by_name || '',
  createdAt: isoOf(row.created_at),
  closedByName: row.closed_by_name || '',
  closedAt: isoOf(row.closed_at),
  // Chon tay dot KK truoc (0109); null = tu dong.
  previousSessionId: row.previous_session_id === null || row.previous_session_id === undefined ? null : Number(row.previous_session_id),
  cancelled: Boolean(row.cancelled_at),
  cancelledAt: isoOf(row.cancelled_at),
  cancelledByName: row.cancelled_by_name || '',
  cancelReason: row.cancel_reason || '',
  reloadedAt: isoOf(row.reloaded_at),
  reloadedByName: row.reloaded_by_name || ''
});
const shapeEdit = row => ({
  id: Number(row.id),
  orderId: row.order_id === null ? null : Number(row.order_id),
  lineNo: row.line_no,
  productCode: row.product_code,
  team: row.team,
  zone: row.zone,
  spec: row.spec,
  quantity: row.quantity === null ? null : Number(row.quantity),
  removed: row.removed,
  version: row.version,
  updatedByName: row.updated_by_name || '',
  updatedAt: isoOf(row.updated_at)
});
const shapeNote = row => ({
  code: row.product_code,
  statusText: row.status_text,
  statusColor: row.status_color || '',
  reasonText: row.reason_text,
  recheckEmployeeId: row.recheck_employee_id === null ? null : Number(row.recheck_employee_id),
  recheckName: row.recheck_name || '',
  printPage: row.print_page || '',
  printTime: row.print_time || '',
  prevDiffManual: row.prev_diff_manual === null || row.prev_diff_manual === undefined ? null : Number(row.prev_diff_manual),
  otherDiffManual: row.other_diff_manual === null || row.other_diff_manual === undefined ? null : Number(row.other_diff_manual),
  version: row.version,
  updatedByName: row.updated_by_name || '',
  updatedAt: isoOf(row.updated_at)
});
const shapeTag = row => ({
  code: row.product_code,
  cluster: row.cluster,
  isCombo: row.is_combo,
  version: row.version,
  updatedByName: row.updated_by_name || '',
  updatedAt: isoOf(row.updated_at)
});

// Bao "<ten> vua sua luc HH:mm" + ban moi nhat de giao dien cho xem truoc khi luu lai.
function conflict(latest) {
  const at = latest && latest.updatedAt
    ? new Date(latest.updatedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })
    : '';
  const who = (latest && latest.updatedByName) || 'Người khác';
  return fail(409, 'STOCKTAKE_CONFLICT', `${who} vừa sửa${at ? ' lúc ' + at : ''}. Xem bản mới rồi lưu lại.`, { latest });
}

function checkVersion(current, expected, shape) {
  const want = versionOf(expected);
  if (!current) {
    if (want) throw conflict(null);
    return;
  }
  if (want === null || want !== current.version) throw conflict(shape(current));
}

function createStockTakeService({ getDb = getPool, now = () => Date.now(), announce = announceChanged } = {}) {
  const cache = new Map(); // key -> { at, value }

  async function cached(key, load) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_TTL_MS) return hit.value;
    const value = await load();
    cache.set(key, { at: now(), value });
    return value;
  }

  // by: ma trinh duyet gui lenh (X-Stocktake-Client) — kem trong tin hieu de chinh trinh duyet do khong tai lai bang lan nua.
  async function withTransaction(work, sessionId, by) {
    const client = await getDb().connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      if (sessionId) {
        try { announce(sessionId, by); } catch (error) { console.error('[stocktake] khong phat duoc tin hieu doi:', error.message); }
      }
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function writeHistory(client, session, actor, productCode, action, before, after) {
    await client.query(
      `INSERT INTO stocktake_history (session_id, branch, product_code, action, before, after, actor_user_id, actor_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [session ? session.id : null, session.branch, productCode || '', action,
        before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), actor.id, actor.name]);
  }

  async function readSession(db, ctx, id, { lock = false } = {}) {
    if (!Number.isInteger(id) || id < 1) throw fail(400, 'VALIDATION', 'Mã đợt kiểm kê không hợp lệ.');
    const row = (await db.query(`SELECT ${SESSION_COLUMNS} FROM stocktake_sessions WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id])).rows[0];
    if (!row) throw fail(404, 'NOT_FOUND', 'Không tìm thấy đợt kiểm kê.');
    assertScope(ctx, row.branch);
    return shapeSession(row);
  }

  // Khoa dot (chan dong dot giua chung) va bao loi neu dot da dong.
  async function openSessionForWrite(client, ctx, id) {
    const session = await readSession(client, ctx, id, { lock: true });
    assertNotCancelled(session);
    if (session.status !== 'open') throw fail(409, 'STOCKTAKE_CLOSED', 'Đợt kiểm kê đã đóng, không sửa được nữa.');
    return session;
  }

  // includeCancelled: chi route cho Quan ly bat (xem lai / khoi phuc dot da huy).
  async function listSessions(ctx, { includeCancelled = false } = {}) {
    const scope = ctx.scope || BRANCHES;
    const { rows } = await getDb().query(
      `SELECT ${SESSION_COLUMNS} FROM stocktake_sessions WHERE branch = ANY($1::text[])${includeCancelled ? '' : ' AND cancelled_at IS NULL'}
       ORDER BY date_to DESC, id DESC`, [scope]);
    // Co so da nap tu sheet (ke ca dot da huy): an nut "Nap ... tu sheet" vi moi tab chi nap 1 lan.
    const imported = await getDb().query(
      `SELECT DISTINCT branch FROM stocktake_sessions WHERE source = 'sheet_import' AND branch = ANY($1::text[]) ORDER BY branch`, [scope]);
    return { sessions: rows.map(shapeSession), importedBranches: imported.rows.map(row => row.branch) };
  }

  async function createSession(ctx, body = {}) {
    const branch = clean(body.branch);
    if (!BRANCHES.includes(branch)) throw fail(400, 'INVALID_BRANCH', 'Cơ sở phải là hanoi hoặc saigon.', { field: 'branch' });
    assertScope(ctx, branch);
    const name = textOf(body, 'name', 'Tên đợt', MAX.name);
    if (!name) throw fail(400, 'VALIDATION', 'Cần nhập tên đợt.', { field: 'name' });
    const dateFrom = dateField(body.dateFrom, 'dateFrom', 'Từ ngày');
    const dateTo = dateField(body.dateTo, 'dateTo', 'Đến ngày');
    if (dateTo < dateFrom) throw fail(400, 'VALIDATION', 'Đến ngày phải sau hoặc bằng Từ ngày.', { field: 'dateTo' });
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const counterpartId = await counterpartOf(client, ctx, branch, body.counterpartSessionId);
      const previousId = await previousOf(client, ctx, { id: null, branch, dateFrom }, body.previousSessionId);
      const { rows } = await client.query(
        `INSERT INTO stocktake_sessions (branch, name, date_from, date_to, created_by_user_id, created_by_name, counterpart_session_id, previous_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${SESSION_COLUMNS}`, [branch, name, dateFrom, dateTo, actor.id, actor.name, counterpartId, previousId]);
      const session = shapeSession(rows[0]);
      await writeHistory(client, session, actor, '', 'session_create', undefined, { name, dateFrom, dateTo, counterpartSessionId: counterpartId, previousSessionId: previousId });
      return { session };
    });
  }

  async function updateSession(ctx, sessionId, body = {}) {
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      if (versionOf(body.version) !== session.version) throw fail(409, 'STOCKTAKE_CONFLICT', 'Đợt kiểm kê vừa được cập nhật. Tải lại rồi thử lại.', { latest: session });
      // Chi doi truong co trong body: doi doi chieu khong xoa KK truoc va nguoc lai.
      const has = field => Object.hasOwn(body, field);
      if (!has('counterpartSessionId') && !has('previousSessionId')) throw fail(400, 'VALIDATION', 'Không có gì để cập nhật.');
      const counterpartId = has('counterpartSessionId') ? await counterpartOf(client, ctx, session.branch, body.counterpartSessionId) : session.counterpartSessionId;
      const previousId = has('previousSessionId') ? await previousOf(client, ctx, session, body.previousSessionId) : session.previousSessionId;
      const { rows } = await client.query(
        `UPDATE stocktake_sessions SET counterpart_session_id = $2, previous_session_id = $3, version = version + 1 WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
        [session.id, counterpartId, previousId]);
      const updated = shapeSession(rows[0]);
      const before = {};
      const after = {};
      if (has('counterpartSessionId')) { before.counterpartSessionId = session.counterpartSessionId; after.counterpartSessionId = counterpartId; }
      if (has('previousSessionId')) { before.previousSessionId = session.previousSessionId; after.previousSessionId = previousId; }
      await writeHistory(client, updated, actor, '', 'session_update', before, after);
      return { session: updated };
    }, sessionId, ctx.clientId);
  }

  // Dot doi chieu phai thuoc co so kia; null = bo doi chieu.
  async function counterpartOf(db, ctx, branch, value) {
    if (value === undefined || value === null || value === '') return null;
    const id = Number(value);
    const row = Number.isInteger(id) ? (await db.query('SELECT id, branch, cancelled_at FROM stocktake_sessions WHERE id = $1', [id])).rows[0] : null;
    if (!row || row.branch === branch) throw fail(400, 'INVALID_COUNTERPART', 'Đợt đối chiếu phải là một đợt của cơ sở kia.', { field: 'counterpartSessionId' });
    if (row.cancelled_at) throw fail(400, 'INVALID_COUNTERPART', 'Đợt đối chiếu đã bị hủy.', { field: 'counterpartSessionId' });
    // Dat doi chieu sang co so ngoai pham vi nguoi dung bi chan (doc van mo).
    assertScope(ctx, row.branch);
    return id;
  }

  // Dot KK truoc chon tay: cung co so, da dong, chua huy, khac chinh no; null = tu dong. Khong rang buoc ngay.
  async function previousOf(db, ctx, session, value) {
    if (value === undefined || value === null || value === '') return null;
    const id = Number(value);
    const row = Number.isInteger(id) && id > 0
      ? (await db.query('SELECT id, branch, status, cancelled_at FROM stocktake_sessions WHERE id = $1', [id])).rows[0] : null;
    const invalid = message => fail(400, 'INVALID_PREVIOUS', message, { field: 'previousSessionId' });
    if (!row || row.branch !== session.branch) throw invalid('Đợt KK trước phải là một đợt cùng cơ sở.');
    if (session.id !== null && Number(row.id) === session.id) throw invalid('Đợt KK trước không thể là chính đợt này.');
    if (row.status !== 'closed') throw invalid('Đợt KK trước phải là đợt đã đóng.');
    if (row.cancelled_at) throw invalid('Đợt KK trước đã bị hủy.');
    return id;
  }

  // SL chenh tung ma cua dot doi chieu: da dong -> ban chup, dang mo -> tinh truc tiep (khong lay tiep doi chieu cua no).
  async function counterpartResults(db, session) {
    if (!session.counterpartSessionId) return { counterpartInfo: null, counterpart: [] };
    const row = (await db.query(`SELECT ${SESSION_COLUMNS} FROM stocktake_sessions WHERE id = $1`, [session.counterpartSessionId])).rows[0];
    if (!row) return { counterpartInfo: null, counterpart: [] };
    const other = shapeSession(row);
    const counterpartInfo = { id: other.id, name: other.name, branch: other.branch, status: other.status, cancelled: other.cancelled };
    if (other.cancelled) return { counterpartInfo, counterpart: [] };
    if (other.status === 'closed') {
      const { rows } = await db.query(`SELECT product_code, diff_qty::float8 AS diff_qty FROM stocktake_session_results WHERE session_id = $1`, [other.id]);
      return { counterpartInfo, counterpart: rows.map(r => ({ code: r.product_code, diffQty: Number(r.diff_qty) })) };
    }
    const board = buildBoard(await loadInputs(db, other, { withCounterpart: false }));
    return { counterpartInfo, counterpart: board.rows.map(r => ({ code: r.code, diffQty: r.diffQty })) };
  }

  // Dot KK truoc cua dot nay: chon tay (con dung duoc) hoac tu dong = dot da dong gan nhat cung co so, chua huy,
  // ket thuc truoc ngay bat dau. manualInvalid: co chon tay nhung dot do da huy / khong con hop le -> dang dung tu dong.
  async function previousSessionOf(db, session) {
    let manualInvalid = false;
    if (session.previousSessionId) {
      const picked = (await db.query(
        `SELECT id, name FROM stocktake_sessions WHERE id = $1 AND branch = $2 AND status = 'closed' AND cancelled_at IS NULL AND id <> $3`,
        [session.previousSessionId, session.branch, session.id])).rows[0];
      if (picked) return { id: Number(picked.id), name: picked.name, mode: 'manual', manualInvalid: false };
      manualInvalid = true;
    }
    const prev = (await db.query(
      `SELECT id, name FROM stocktake_sessions WHERE branch = $1 AND status = 'closed' AND cancelled_at IS NULL AND id <> $2 AND date_to <= $3::date
       ORDER BY date_to DESC, id DESC LIMIT 1`, [session.branch, session.id, session.dateFrom])).rows[0];
    return { id: prev ? Number(prev.id) : null, name: prev ? prev.name : '', mode: 'auto', manualInvalid };
  }

  // Thong tin dot doi chieu (mot dong, khong tinh ket qua).
  async function counterpartInfoOf(db, session) {
    if (!session.counterpartSessionId) return null;
    const row = (await db.query('SELECT id, name, branch, status, cancelled_at FROM stocktake_sessions WHERE id = $1', [session.counterpartSessionId])).rows[0];
    return row ? { id: Number(row.id), name: row.name, branch: row.branch, status: row.status, cancelled: Boolean(row.cancelled_at) } : null;
  }

  // Ket qua dot da dong gan nhat truoc dot nay (nguon "KK truoc sai").
  async function previousResults(db, session) {
    const info = await previousSessionOf(db, session);
    if (info.id === null) return { previousSessionId: null, previousInfo: info, previous: [] };
    const { rows } = await db.query(`SELECT product_code, diff_qty::float8 AS diff_qty FROM stocktake_session_results WHERE session_id = $1`, [info.id]);
    return { previousSessionId: info.id, previousInfo: info, previous: rows.map(row => ({ code: row.product_code, diffQty: Number(row.diff_qty) })) };
  }

  async function loadEmployees(db) {
    const { rows } = await db.query(
      `SELECT id, ho_ten, branch FROM hr_employees
       WHERE is_active AND COALESCE(employment_status, 'active') = 'active' AND btrim(ho_ten) <> ''
       ORDER BY ho_ten`);
    return rows.map(row => ({ id: Number(row.id), name: row.ho_ten, branch: row.branch }));
  }

  // Du lieu dau vao cua bo tinh cho dot dang mo.
  // fresh: bo cache (dong dot phai chup ton dung luc dong).
  async function loadInputs(db, session, { fresh = false, withCounterpart = true, withPrevious = true } = {}) {
    if (fresh) {
      cache.delete('products:' + session.branch);
    }
    const [lines, edits, products, tags, notes, prev, other] = await Promise.all([
      db.query(TEAM_LINES_SQL, [session.branch, session.dateFrom, session.dateTo]).then(r => r.rows.map(row => ({
        orderId: Number(row.order_id), lineNo: row.line_no, orderCode: row.order_code, orderStatus: row.order_status,
        team: row.team, zone: row.zone, spec: row.spec, productCode: row.product_code, productName: row.product_name, quantity: Number(row.quantity)
      }))),
      db.query(`SELECT ${EDIT_COLUMNS} FROM stocktake_line_edits WHERE session_id = $1`, [session.id]).then(r => r.rows.map(shapeEdit)),
      cached('products:' + session.branch, () => db.query(PRODUCTS_SQL, [session.branch]).then(r => r.rows.map(row => ({
        code: row.code, name: row.name, stock: Number(row.stock), cost: Number(row.cost)
      })))),
      db.query(`SELECT ${TAG_COLUMNS} FROM stocktake_product_tags WHERE branch = $1`, [session.branch]).then(r => r.rows.map(shapeTag)),
      db.query(`SELECT ${NOTE_COLUMNS} FROM stocktake_code_notes WHERE session_id = $1`, [session.id]).then(r => r.rows.map(shapeNote)),
      withPrevious ? previousResults(db, session) : { previousSessionId: null, previousInfo: null, previous: [] },
      withCounterpart ? counterpartResults(db, session) : { counterpartInfo: null, counterpart: [] }
    ]);
    return { lines, edits, products, tags, notes, ...prev, ...other };
  }

  // Dot da dong: doc ban chup, ghi chu va tag van hien (khong co dong dem chi tiet).
  async function closedBoard(db, session) {
    const sheetImport = session.source === 'sheet_import';
    const [results, tags, notes, prev, other] = await Promise.all([
      db.query(`SELECT product_code, name, counted::float8 AS counted, stock::float8 AS stock, cost::float8 AS cost,
                       diff_qty::float8 AS diff_qty, diff_value::float8 AS diff_value,
                       prev_diff::float8 AS prev_diff, other_diff::float8 AS other_diff
                FROM stocktake_session_results WHERE session_id = $1 ORDER BY product_code`, [session.id]).then(r => r.rows),
      db.query(`SELECT ${TAG_COLUMNS} FROM stocktake_product_tags WHERE branch = $1`, [session.branch]).then(r => r.rows.map(shapeTag)),
      db.query(`SELECT ${NOTE_COLUMNS} FROM stocktake_code_notes WHERE session_id = $1`, [session.id]).then(r => r.rows.map(shapeNote)),
      // Chi dot nap tu sheet moi can fallback tinh truc tiep; dot web dung ban chup nguyen trang (NULL giu NULL).
      sheetImport ? previousResults(db, session) : previousSessionOf(db, session).then(info => ({ previousSessionId: info.id, previousInfo: info, previous: [] })),
      sheetImport ? counterpartResults(db, session) : counterpartInfoOf(db, session).then(info => ({ counterpartInfo: info, counterpart: [] }))
    ]);
    const tagByCode = new Map(tags.map(tag => [tag.code, tag]));
    const noteByCode = new Map(notes.map(note => [note.code, note]));
    const prevByCode = new Map(prev.previous.map(item => [item.code, item.diffQty]));
    const otherByCode = new Map(other.counterpart.map(item => [item.code, item.diffQty]));
    const rows = results.map(row => {
      const tag = tagByCode.get(row.product_code);
      const note = noteByCode.get(row.product_code) || null;
      // Ban chup luu L/M luc dong; dot nap tu sheet chua co M -> lay tu dot doi chieu.
      const prevStored = row.prev_diff === null ? (prevByCode.has(row.product_code) ? prevByCode.get(row.product_code) : null) : Number(row.prev_diff);
      const otherStored = row.other_diff === null ? (otherByCode.has(row.product_code) ? otherByCode.get(row.product_code) : null) : Number(row.other_diff);
      return {
        code: row.product_code, name: row.name, inKiot: true, counted: Number(row.counted), stock: Number(row.stock), cost: Number(row.cost),
        // Ban chup khong giu dong dem: khong ai dem (tong kiem 0) ma co ton = Quen KK.
        diffQty: Number(row.diff_qty), diffValue: Number(row.diff_value), forgotten: Number(row.counted) === 0 && Number(row.stock) !== 0,
        cluster: (tag && tag.cluster) || '', isCombo: Boolean(tag && tag.isCombo), tagVersion: tag ? tag.version : null,
        prevDiff: prevStored, prevDiffAuto: prevStored, prevDiffManual: Boolean(note && note.prevDiffManual !== null),
        otherDiff: otherStored, otherDiffAuto: otherStored, otherDiffManual: Boolean(note && note.otherDiffManual !== null),
        note, lines: []
      };
    });
    deriveColumns(rows);
    return { rows, totals: totalsOf(rows), previousSessionId: prev.previousSessionId, previousSession: prev.previousInfo, counterpart: other.counterpartInfo };
  }

  async function getBoard(ctx, id) {
    const db = getDb();
    const session = await readSession(db, ctx, id);
    const [board, employees] = await Promise.all([
      session.status === 'closed'
        ? closedBoard(db, session)
        : loadInputs(db, session).then(inputs => ({
          ...buildBoard(inputs), previousSessionId: inputs.previousSessionId, previousSession: inputs.previousInfo, counterpart: inputs.counterpartInfo
        })),
      loadEmployees(db)
    ]);
    // Goi y Chi tiet ly do: cac gia tri da dung trong dot (Trang thai nay la danh sach co dinh, xem stocktakeStatus.js).
    const reasons = new Set();
    for (const row of board.rows) {
      if (row.note && row.note.reasonText) reasons.add(row.note.reasonText);
    }
    return { session, ...board, employees, suggestions: { reason: [...reasons].sort() } };
  }

  // Sua dong dem goc (orderId + lineNo) hoac dong tay (editId). Gia tri null = giu goc.
  async function saveLine(ctx, sessionId, body = {}) {
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      const editId = body.editId === undefined || body.editId === null ? null : Number(body.editId);
      let current;
      let source = null;
      if (editId !== null) {
        current = (await client.query(`SELECT ${EDIT_COLUMNS} FROM stocktake_line_edits WHERE id = $1 AND session_id = $2 FOR UPDATE`, [editId, session.id])).rows[0];
        if (!current) throw fail(404, 'NOT_FOUND', 'Không tìm thấy dòng đếm.');
      } else {
        const orderId = Number(body.orderId);
        const lineNo = Number(body.lineNo);
        if (!Number.isInteger(orderId) || !Number.isInteger(lineNo)) throw fail(400, 'VALIDATION', 'Thiếu dòng đếm cần sửa.');
        source = (await client.query(`SELECT * FROM (${TEAM_LINES_SQL}) t WHERE order_id = $4 AND line_no = $5`,
          [session.branch, session.dateFrom, session.dateTo, orderId, lineNo])).rows[0];
        if (!source) throw fail(404, 'NOT_FOUND', 'Dòng đếm không thuộc đơn TEAM của đợt này.');
        current = (await client.query(`SELECT ${EDIT_COLUMNS} FROM stocktake_line_edits WHERE session_id = $1 AND order_id = $2 AND line_no = $3 FOR UPDATE`,
          [session.id, orderId, lineNo])).rows[0];
      }
      checkVersion(current, body.version, shapeEdit);

      const before = current ? shapeEdit(current) : null;
      const next = {
        productCode: before ? before.productCode : null, team: before ? before.team : null, zone: before ? before.zone : null,
        spec: before ? before.spec : null, quantity: before ? before.quantity : null, removed: before ? before.removed : false
      };
      if (body.productCode !== undefined) next.productCode = codeKey(body.productCode) || null;
      for (const [field, label] of [['team', 'Team'], ['zone', 'Khu'], ['spec', 'Quy cách']]) {
        if (body[field] !== undefined) next[field] = body[field] === null ? null : textOf(body, field, label);
      }
      if (body.quantity !== undefined) next.quantity = body.quantity === null ? null : quantityOf(body.quantity);
      if (body.removed !== undefined) next.removed = Boolean(body.removed);
      if (editId !== null && (!next.productCode || next.quantity === null)) throw fail(400, 'VALIDATION', 'Dòng thêm tay cần mã hàng và số lượng.');

      const params = [next.productCode, next.team, next.zone, next.spec, next.quantity, next.removed, actor.id, actor.name];
      const saved = current
        ? (await client.query(
          `UPDATE stocktake_line_edits SET product_code = $1, team = $2, zone = $3, spec = $4, quantity = $5, removed = $6,
             version = version + 1, updated_by_user_id = $7, updated_by_name = $8, updated_at = now()
           WHERE id = $9 RETURNING ${EDIT_COLUMNS}`, [...params, current.id])).rows[0]
        : (await client.query(
          `INSERT INTO stocktake_line_edits (session_id, order_id, line_no, product_code, team, zone, spec, quantity, removed, updated_by_user_id, updated_by_name)
           VALUES ($9, $10, $11, $1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${EDIT_COLUMNS}`,
          [...params, session.id, Number(body.orderId), Number(body.lineNo)])).rows[0];
      const after = shapeEdit(saved);
      const code = after.productCode || (before && before.productCode) || codeKey(source && source.product_code);
      await writeHistory(client, session, actor, code, 'line_edit', before || { original: source && {
        team: source.team, zone: source.zone, spec: source.spec, quantity: Number(source.quantity), productCode: codeKey(source.product_code)
      } }, after);
      return { edit: after };
    }, sessionId, ctx.clientId);
  }

  async function addLine(ctx, sessionId, body = {}) {
    const actor = actorOf(ctx);
    const productCode = codeKey(body.productCode);
    if (!productCode) throw fail(400, 'VALIDATION', 'Cần nhập mã hàng.', { field: 'productCode' });
    const quantity = quantityOf(body.quantity);
    const team = textOf(body, 'team', 'Team');
    const zone = textOf(body, 'zone', 'Khu');
    const spec = textOf(body, 'spec', 'Quy cách');
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      const { rows } = await client.query(
        `INSERT INTO stocktake_line_edits (session_id, product_code, team, zone, spec, quantity, updated_by_user_id, updated_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${EDIT_COLUMNS}`,
        [session.id, productCode, team, zone, spec, quantity, actor.id, actor.name]);
      const edit = shapeEdit(rows[0]);
      await writeHistory(client, session, actor, productCode, 'line_add', undefined, edit);
      return { edit };
    }, sessionId, ctx.clientId);
  }

  async function saveNote(ctx, sessionId, code, body = {}) {
    const actor = actorOf(ctx);
    const productCode = codeKey(code);
    if (!productCode) throw fail(400, 'VALIDATION', 'Thiếu mã hàng.');
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      const current = (await client.query(`SELECT ${NOTE_COLUMNS} FROM stocktake_code_notes WHERE session_id = $1 AND product_code = $2 FOR UPDATE`,
        [session.id, productCode])).rows[0];
      checkVersion(current, body.version, shapeNote);
      const before = current ? shapeNote(current) : null;
      const statusText = body.statusText === undefined ? (before ? before.statusText : '') : textOf(body, 'statusText', 'Trạng thái');
      // Giu nguyen chu cu (dot nap tu sheet) thi khong kiem; doi thi phai la ten chuan.
      if (statusText !== (before ? before.statusText : '') && !Status.isValid(statusText, session.branch)) {
        throw fail(400, 'VALIDATION', statusInvalid(session.branch), { field: 'statusText' });
      }
      // Mau hien thi tinh tu chu trang thai (Status.colorOf); cot status_color chi giu gia tri cu, bo qua statusColor gui len.
      const statusColor = before ? before.statusColor : '';
      const reasonText = body.reasonText === undefined ? (before ? before.reasonText : '') : textOf(body, 'reasonText', 'Chi tiết lý do', MAX.note);
      const printPage = body.printPage === undefined ? (before ? before.printPage : '') : textOf(body, 'printPage', 'Trang in', MAX.print);
      const printTime = body.printTime === undefined ? (before ? before.printTime : '') : textOf(body, 'printTime', 'Giờ in', MAX.print);
      const prevDiffManual = body.prevDiffManual === undefined ? (before ? before.prevDiffManual : null) : diffOf(body.prevDiffManual, 'prevDiffManual');
      const otherDiffManual = body.otherDiffManual === undefined ? (before ? before.otherDiffManual : null) : diffOf(body.otherDiffManual, 'otherDiffManual');
      let recheckEmployeeId = before ? before.recheckEmployeeId : null;
      let recheckName = before ? before.recheckName : '';
      if (body.recheckName !== undefined) {
        // Go tay ten nguoi kiem lai (thuong la biet danh "THAI KHO"): khop dung 1 nhan su cung co so thi gan id.
        const typed = textOf(body, 'recheckName', 'Người kiểm lại');
        const employees = typed ? (await loadEmployees(client)).filter(e => e.branch === session.branch) : [];
        ({ recheckEmployeeId, recheckName } = recheckOf(typed, employees));
      } else if (body.recheckEmployeeId !== undefined) {
        recheckName = '';
        recheckEmployeeId = body.recheckEmployeeId === null || body.recheckEmployeeId === '' ? null : Number(body.recheckEmployeeId);
        if (recheckEmployeeId !== null) {
          const found = (await client.query('SELECT 1 FROM hr_employees WHERE id = $1 AND is_active', [recheckEmployeeId])).rows[0];
          if (!found) throw fail(400, 'VALIDATION', 'Không tìm thấy nhân sự kiểm lại.', { field: 'recheckEmployeeId' });
        }
      }
      const { rows } = await client.query(
        `INSERT INTO stocktake_code_notes (session_id, product_code, status_text, reason_text, recheck_employee_id, updated_by_user_id, updated_by_name,
           print_page, print_time, prev_diff_manual, other_diff_manual, status_color, recheck_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (session_id, product_code) DO UPDATE SET status_text = EXCLUDED.status_text, status_color = EXCLUDED.status_color,
           reason_text = EXCLUDED.reason_text,
           recheck_employee_id = EXCLUDED.recheck_employee_id, recheck_name = EXCLUDED.recheck_name, print_page = EXCLUDED.print_page, print_time = EXCLUDED.print_time,
           prev_diff_manual = EXCLUDED.prev_diff_manual, other_diff_manual = EXCLUDED.other_diff_manual, version = stocktake_code_notes.version + 1,
           updated_by_user_id = EXCLUDED.updated_by_user_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()
         RETURNING ${NOTE_COLUMNS}`, [session.id, productCode, statusText, reasonText, recheckEmployeeId, actor.id, actor.name,
          printPage, printTime, prevDiffManual, otherDiffManual, statusColor, recheckName]);
      const note = shapeNote(rows[0]);
      await writeHistory(client, session, actor, productCode, 'note', before, note);
      return { note };
    }, sessionId, ctx.clientId);
  }

  // Cum SP / Combo giu qua cac dot theo co so; sessionId chi de bao tin hieu cho bang dang mo.
  async function saveTag(ctx, sessionId, code, body = {}) {
    const actor = actorOf(ctx);
    const productCode = codeKey(code);
    if (!productCode) throw fail(400, 'VALIDATION', 'Thiếu mã hàng.');
    return withTransaction(async client => {
      const session = await readSession(client, ctx, sessionId);
      assertNotCancelled(session);
      const current = (await client.query(`SELECT ${TAG_COLUMNS} FROM stocktake_product_tags WHERE branch = $1 AND product_code = $2 FOR UPDATE`,
        [session.branch, productCode])).rows[0];
      checkVersion(current, body.version, shapeTag);
      const before = current ? shapeTag(current) : null;
      const cluster = body.cluster === undefined ? (before ? before.cluster : '') : textOf(body, 'cluster', 'Cụm SP');
      const isCombo = body.isCombo === undefined ? Boolean(before && before.isCombo) : Boolean(body.isCombo);
      const { rows } = await client.query(
        `INSERT INTO stocktake_product_tags (branch, product_code, cluster, is_combo, updated_by_user_id, updated_by_name)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (branch, product_code) DO UPDATE SET cluster = EXCLUDED.cluster, is_combo = EXCLUDED.is_combo,
           version = stocktake_product_tags.version + 1, updated_by_user_id = EXCLUDED.updated_by_user_id,
           updated_by_name = EXCLUDED.updated_by_name, updated_at = now()
         RETURNING ${TAG_COLUMNS}`, [session.branch, productCode, cluster, isCombo, actor.id, actor.name]);
      const tag = shapeTag(rows[0]);
      await writeHistory(client, session, actor, productCode, 'tag', before, tag);
      return { tag };
    }, sessionId, ctx.clientId);
  }

  // Khoa dong cum/combo cua cac ma (cung thu tu ma) va doc lai: saveTag cua phien khac cung co so chi khoa dong nay, doc khong khoa thi ghi de mat.
  async function lockTags(client, branch, codes) {
    if (!codes.length) return new Map();
    const { rows } = await client.query(
      `SELECT ${TAG_COLUMNS} FROM stocktake_product_tags WHERE branch = $1 AND product_code = ANY($2::text[]) ORDER BY product_code FOR UPDATE`,
      [branch, [...new Set(codes)].sort()]);
    return new Map(rows.map(shapeTag).map(tag => [tag.code, tag]));
  }

  // Lich su sua tren bang: action 'paste' (co san trong CHECK; truoc day dung cho Dan cot), 1 dong moi (ma, cot).
  async function insertPasteHistory(client, session, actor, items) {
    if (!items.length) return;
    await client.query(
      `INSERT INTO stocktake_history (session_id, branch, product_code, action, before, after, actor_user_id, actor_name)
       SELECT $1, $2, r.code, 'paste', r.before, r.after, $4, $5 FROM jsonb_to_recordset($3::jsonb) AS r(code text, before jsonb, after jsonb)`,
      [session.id, session.branch, JSON.stringify(items), actor.id, actor.name]);
  }

  // Sua tren bang (go / dan khoi / xoa / keo / hoan tac): nhieu (ma, cot) trong 1 giao dich.
  // expected khac gia tri hien tai -> conflicts (khong ghi o do); thieu expected = khong kiem.
  async function saveCells(ctx, sessionId, body = {}) {
    const input = Array.isArray(body.cells) ? body.cells : null;
    if (!input || !input.length || input.length > MAX_PASTE_ROWS) throw fail(400, 'VALIDATION', `Cần từ 1 đến ${MAX_PASTE_ROWS} ô.`, { field: 'cells' });
    for (const cell of input) {
      if (!Object.hasOwn(PASTE_COLUMNS, String((cell && cell.column) || ''))) throw fail(400, 'VALIDATION', 'Cột sửa không hợp lệ.', { field: 'column' });
    }
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      // Chi can tap ma cua dot (khong can KK truoc / doi chieu): bot 3 truy van moi lan sua.
      const inputs = await loadInputs(client, session, { withCounterpart: false, withPrevious: false });
      const known = new Set([...buildBoard(inputs).rows.map(r => r.code), ...inputs.products.map(p => codeKey(p.code))]);
      const allEmployees = await loadEmployees(client);
      const employees = allEmployees.filter(e => e.branch === session.branch);
      const names = new Map(allEmployees.map(e => [e.id, e.name]));
      const nameOf = id => names.get(id) || '';
      const notes = new Map(inputs.notes.map(note => [note.code, note]));
      const tagCodes = input.filter(cell => Object.hasOwn(TAG_FIELDS, cell.column)).map(cell => codeKey(cell.code)).filter(code => known.has(code));
      const tags = await lockTags(client, session.branch, tagCodes);
      const skipped = { notFound: 0, invalid: 0, unchanged: 0 };
      // (ma, cot) lap trong 1 lan gui: giu o cuoi, vi tri theo lan gap dau.
      const latest = new Map();
      for (const cell of input) {
        const code = codeKey(cell.code);
        if (!code || !known.has(code)) { skipped.notFound += 1; continue; }
        latest.set(code + '\u0000' + cell.column, { code, column: cell.column, value: cell.value, expected: cell.expected, check: Object.hasOwn(cell, 'expected') });
      }
      const applied = [];
      const conflicts = [];
      const byStore = { note: new Map(), tag: new Map() };
      for (const cell of latest.values()) {
        const parsed = normalizeValue(cell.column, cell.value);
        if (!parsed.ok) { skipped.invalid += 1; continue; }
        const kind = Object.hasOwn(TAG_FIELDS, cell.column) ? 'tag' : 'note';
        const original = (kind === 'tag' ? tags : notes).get(cell.code) || null;
        const entry = byStore[kind].get(cell.code) || { code: cell.code, before: original, next: original, columns: [] };
        const valueOf = record => columnValue(cell.column, kind === 'note' ? record : null, kind === 'tag' ? record : null, nameOf);
        const current = valueOf(entry.next);
        if (cell.check && !sameValue(cell.column, current, cell.expected)) { conflicts.push({ code: cell.code, column: cell.column, current }); continue; }
        // Trang thai: chi ten chuan theo co so hoac trong; gui lai dung chu cu (khong doi) thi de sameRecord tinh unchanged.
        if (cell.column === 'statusText' && parsed.value !== current && !Status.isValid(parsed.value, session.branch)) { skipped.invalid += 1; continue; }
        const next = nextRecord(cell.column, entry.next, parsed.value, employees);
        if (sameRecord(cell.column, entry.next, next)) { skipped.unchanged += 1; continue; }
        entry.next = next;
        entry.columns.push(cell.column);
        byStore[kind].set(cell.code, entry);
        applied.push({ code: cell.code, column: cell.column, before: current, after: valueOf(next) });
      }
      const noteChanges = [...byStore.note.values()];
      const tagChanges = [...byStore.tag.values()];
      // Tra lai ban ghi vua luu (kem version / nguoi sua) de trang cap nhat tai cho, khong phai tai lai ca bang.
      const savedNotes = noteChanges.length ? await upsertNotes(client, session.id, noteChanges, actor) : [];
      const savedTags = tagChanges.length ? await upsertTags(client, session.branch, tagChanges, actor) : [];
      await insertPasteHistory(client, session, actor, [...noteChanges, ...tagChanges].flatMap(entry =>
        entry.columns.map(column => ({ code: entry.code, before: entry.before, after: { column, source: 'cells', ...entry.next } }))));
      return { applied, conflicts, skipped, notes: savedNotes, tags: savedTags };
    }, sessionId, ctx.clientId);
  }

  async function upsertNotes(client, sessionId, changes, actor) {
    const { rows } = await client.query(
      `INSERT INTO stocktake_code_notes (session_id, product_code, status_text, reason_text, print_page, print_time, recheck_employee_id, recheck_name,
                                         prev_diff_manual, other_diff_manual, updated_by_user_id, updated_by_name)
       SELECT $1, r.code, r."statusText", r."reasonText", r."printPage", r."printTime", r."recheckEmployeeId", r."recheckName",
              r."prevDiffManual", r."otherDiffManual", $3, $4
       FROM jsonb_to_recordset($2::jsonb) AS r(code text, "statusText" text, "reasonText" text, "printPage" text, "printTime" text,
            "recheckEmployeeId" bigint, "recheckName" text, "prevDiffManual" numeric, "otherDiffManual" numeric)
       ON CONFLICT (session_id, product_code) DO UPDATE SET status_text = EXCLUDED.status_text, reason_text = EXCLUDED.reason_text,
         print_page = EXCLUDED.print_page, print_time = EXCLUDED.print_time, recheck_employee_id = EXCLUDED.recheck_employee_id,
         recheck_name = EXCLUDED.recheck_name, prev_diff_manual = EXCLUDED.prev_diff_manual, other_diff_manual = EXCLUDED.other_diff_manual,
         version = stocktake_code_notes.version + 1, updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_by_name = EXCLUDED.updated_by_name, updated_at = now()
       RETURNING ${NOTE_COLUMNS}`,
      [sessionId, JSON.stringify(changes.map(c => ({ code: c.code, ...c.next }))), actor.id, actor.name]);
    return rows.map(shapeNote);
  }

  async function upsertTags(client, branch, changes, actor) {
    const { rows } = await client.query(
      `INSERT INTO stocktake_product_tags (branch, product_code, cluster, is_combo, updated_by_user_id, updated_by_name)
       SELECT $1, r.code, r.cluster, r."isCombo", $3, $4 FROM jsonb_to_recordset($2::jsonb) AS r(code text, cluster text, "isCombo" boolean)
       ON CONFLICT (branch, product_code) DO UPDATE SET cluster = EXCLUDED.cluster, is_combo = EXCLUDED.is_combo,
         version = stocktake_product_tags.version + 1, updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_by_name = EXCLUDED.updated_by_name, updated_at = now()
       RETURNING ${TAG_COLUMNS}`,
      [branch, JSON.stringify(changes.map(c => ({ code: c.code, ...c.next }))), actor.id, actor.name]);
    return rows.map(shapeTag);
  }

  async function codeHistory(ctx, sessionId, code) {
    const db = getDb();
    const session = await readSession(db, ctx, sessionId);
    const productCode = codeKey(code);
    // Tag (Cum SP / Combo) giu qua cac dot nen lay ca lich su tag cua ma o dot khac.
    const { rows } = await db.query(
      `SELECT id, session_id, action, before, after, actor_name, created_at FROM stocktake_history
       WHERE product_code = $1 AND (session_id = $2 OR (action = 'tag' AND branch = $3)
              OR (action = 'paste' AND branch = $3 AND after->>'column' IN ('cluster', 'combo')))
       ORDER BY id DESC LIMIT 200`, [productCode, session.id, session.branch]);
    return {
      history: rows.map(row => ({
        id: Number(row.id), sessionId: row.session_id === null ? null : Number(row.session_id), action: row.action,
        before: row.before, after: row.after, actorName: row.actor_name, createdAt: isoOf(row.created_at)
      }))
    };
  }

  // Dong dot: chup bang doi chieu (ton/chenh luc dong) de dot cu khong troi theo ton moi.
  async function closeSession(ctx, sessionId, body = {}) {
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      if (versionOf(body.version) !== session.version) throw fail(409, 'STOCKTAKE_CONFLICT', 'Đợt kiểm kê vừa được cập nhật. Tải lại rồi thử lại.', { latest: session });
      const inputs = await loadInputs(client, session, { fresh: true });
      const results = toResults(buildBoard(inputs));
      if (results.length) {
        await client.query(
          `INSERT INTO stocktake_session_results (session_id, product_code, name, counted, stock, cost, diff_qty, diff_value, prev_diff, other_diff)
           SELECT $1, r.code, r.name, r.counted, r.stock, r.cost, r.diff_qty, r.diff_value, r.prev_diff, r.other_diff
           FROM jsonb_to_recordset($2::jsonb) AS r(code text, name text, counted numeric, stock numeric, cost numeric, diff_qty numeric, diff_value numeric, prev_diff numeric, other_diff numeric)`,
          [session.id, JSON.stringify(results.map(r => ({ code: r.code, name: r.name || '', counted: r.counted, stock: r.stock, cost: r.cost,
            diff_qty: r.diffQty, diff_value: r.diffValue, prev_diff: r.prevDiff, other_diff: r.otherDiff })))]);
      }
      const { rows } = await client.query(
        `UPDATE stocktake_sessions SET status = 'closed', version = version + 1, closed_by_user_id = $2, closed_by_name = $3, closed_at = now()
         WHERE id = $1 RETURNING ${SESSION_COLUMNS}`, [session.id, actor.id, actor.name]);
      const closed = shapeSession(rows[0]);
      // Ghi dot KK truoc da dung luc dong: nguon "dot da dong phu thuoc" khi huy dot do.
      await writeHistory(client, closed, actor, '', 'session_close', undefined, {
        codes: results.length, mismatched: results.filter(r => r.diffQty !== 0).length, previousSessionId: inputs.previousSessionId
      });
      return { session: closed };
    }, sessionId, ctx.clientId);
  }

  // Huy dot (dang mo hoac da dong): an khoi danh sach, chi doc, khong dung lam KK truoc / doi chieu. Khong xoa vat ly.
  async function cancelSession(ctx, sessionId, body = {}) {
    const actor = actorOf(ctx);
    const reason = clean(body.reason);
    if (!reason) throw fail(400, 'VALIDATION', 'Cần nhập lý do hủy đợt.', { field: 'reason' });
    if (reason.length > MAX_CANCEL_REASON) throw fail(400, 'VALIDATION', `Lý do tối đa ${MAX_CANCEL_REASON} ký tự.`, { field: 'reason' });
    return withTransaction(async client => {
      const session = await readSession(client, ctx, sessionId, { lock: true });
      assertNotCancelled(session);
      if (versionOf(body.version) !== session.version) throw fail(409, 'STOCKTAKE_CONFLICT', 'Đợt kiểm kê vừa được cập nhật. Tải lại rồi thử lại.', { latest: session });
      const { rows } = await client.query(
        `UPDATE stocktake_sessions SET cancelled_at = now(), cancelled_by_user_id = $2, cancelled_by_name = $3, cancel_reason = $4, version = version + 1
         WHERE id = $1 RETURNING ${SESSION_COLUMNS}`, [session.id, actor.id, actor.name, reason]);
      const cancelled = shapeSession(rows[0]);
      await writeHistory(client, cancelled, actor, '', 'session_cancel', { status: session.status }, { reason });
      return { session: cancelled };
    }, sessionId, ctx.clientId);
  }

  // Khoi phuc: dot tro lai dung trang thai mo / dong nhu truoc khi huy.
  async function restoreSession(ctx, sessionId, body = {}) {
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const session = await readSession(client, ctx, sessionId, { lock: true });
      if (!session.cancelled) throw fail(409, 'STOCKTAKE_NOT_CANCELLED', 'Đợt kiểm kê chưa bị hủy.');
      if (versionOf(body.version) !== session.version) throw fail(409, 'STOCKTAKE_CONFLICT', 'Đợt kiểm kê vừa được cập nhật. Tải lại rồi thử lại.', { latest: session });
      const { rows } = await client.query(
        `UPDATE stocktake_sessions SET cancelled_at = NULL, cancelled_by_user_id = NULL, cancelled_by_name = NULL, cancel_reason = '', version = version + 1
         WHERE id = $1 RETURNING ${SESSION_COLUMNS}`, [session.id]);
      const restored = shapeSession(rows[0]);
      await writeHistory(client, restored, actor, '', 'session_restore', { reason: session.cancelReason, cancelledByName: session.cancelledByName }, { status: restored.status });
      return { session: restored };
    }, sessionId, ctx.clientId);
  }

  // Dot dang dung dot nay: lam KK truoc (dot mo: tinh lai theo quy tac hien tai; dot dong: theo lich su luc dong)
  // hoac lam doi chieu. Dung cho hop xac nhan Huy / Nap lai.
  async function dependents(ctx, sessionId) {
    const db = getDb();
    const session = await readSession(db, ctx, sessionId);
    const brief = row => ({ id: Number(row.id), name: row.name, branch: row.branch, status: row.status });
    const open = (await db.query(
      `SELECT ${SESSION_COLUMNS} FROM stocktake_sessions WHERE branch = $1 AND status = 'open' AND cancelled_at IS NULL AND id <> $2
       ORDER BY date_to DESC, id DESC`, [session.branch, session.id])).rows.map(shapeSession);
    const asPrevious = [];
    for (const other of open) {
      const info = await previousSessionOf(db, other);
      if (info.id === session.id) asPrevious.push({ ...brief(other), mode: info.mode, changes: true });
    }
    const closed = (await db.query(
      `SELECT DISTINCT s.id, s.name, s.branch, s.status, s.date_to FROM stocktake_history h JOIN stocktake_sessions s ON s.id = h.session_id
       WHERE h.action = 'session_close' AND h.after->>'previousSessionId' = $1::text AND s.cancelled_at IS NULL AND s.id <> $2
       ORDER BY s.date_to DESC, s.id DESC`, [String(session.id), session.id])).rows;
    for (const row of closed) asPrevious.push({ ...brief(row), mode: 'snapshot', changes: false });
    const asCounterpart = (await db.query(
      `SELECT id, name, branch, status FROM stocktake_sessions WHERE counterpart_session_id = $1 AND cancelled_at IS NULL ORDER BY date_to DESC, id DESC`,
      [session.id])).rows.map(row => ({ ...brief(row), changes: row.status === 'open' }));
    return { previousOf: asPrevious, counterpartOf: asCounterpart };
  }

  return {
    listSessions, createSession, updateSession, getBoard, saveLine, addLine, saveNote, saveTag, saveCells, codeHistory, closeSession,
    cancelSession, restoreSession, dependents
  };
}

module.exports = { createStockTakeService, TEAM_LINES_SQL, fail, ...createStockTakeService() };
