'use strict';

// Kiem ke (doi chieu), migration 0103. So dem tinh truc tiep tu don dat hang cua khach "TEAM..." trong khoang ngay
// cua dot (ca don da huy) + phan sua tren web; ton/gia von la ton hien tai cua products. Dong dot -> chup ket qua.
// Moi lenh ghi: 1 giao dich, khoa dong + so version (lech -> 409 kem ban moi), ghi stocktake_history cung giao dich.
const { getPool } = require('../db/pool');
const { stripTelegramId } = require('../dashboard/saleName');
const { codeKey, buildBoard, toResults } = require('./stocktakeCompute');
const { announceChanged } = require('./stocktakeEvents');

const BRANCHES = Object.freeze(['hanoi', 'saigon']);
const CACHE_TTL_MS = 60 * 1000; // ton KiotViet dong bo moi 10 phut, 1 phut cache khong lam cham them
const MAX = Object.freeze({ name: 120, text: 200, note: 1000 });
const MAX_QUANTITY = 1e9;

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

function textOf(body, field, label, max = MAX.text) {
  const value = clean(body[field]);
  if (value.length > max) throw fail(400, 'VALIDATION', `${label} tối đa ${max} ký tự.`, { field });
  return value;
}

function dateField(value, field, label) {
  const text = clean(value);
  const valid = /^\d{4}-\d{2}-\d{2}$/u.test(text) && Number.isFinite(Date.parse(text + 'T00:00:00Z'))
    && new Date(text + 'T00:00:00Z').toISOString().slice(0, 10) === text;
  if (!valid) throw fail(400, 'VALIDATION', `${label} không hợp lệ (cần dạng yyyy-mm-dd).`, { field });
  return text;
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

// stock_positions dung ma co so 'HN'/'SG'; dong sua gan nhat truoc = "vi tri kho gan nhat".
const POSITIONS_SQL = `
  SELECT code, location, arrival_date FROM stock_positions
  WHERE branch = $1 ORDER BY updated_at DESC, id DESC`;
const POSITION_BRANCH = Object.freeze({ hanoi: 'HN', saigon: 'SG' });

const SESSION_COLUMNS = `id, branch, name, date_from, date_to, status, source, version, created_by_name, created_at, closed_by_name, closed_at`;
const EDIT_COLUMNS = `id, order_id, line_no, product_code, team, zone, spec, quantity::float8 AS quantity, removed, version, updated_by_name, updated_at`;
const NOTE_COLUMNS = `product_code, status_text, reason_text, recheck_employee_id, version, updated_by_name, updated_at`;
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
  createdByName: row.created_by_name || '',
  createdAt: isoOf(row.created_at),
  closedByName: row.closed_by_name || '',
  closedAt: isoOf(row.closed_at)
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
  reasonText: row.reason_text,
  recheckEmployeeId: row.recheck_employee_id === null ? null : Number(row.recheck_employee_id),
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

  async function withTransaction(work, sessionId) {
    const client = await getDb().connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      if (sessionId) {
        try { announce(sessionId); } catch (error) { console.error('[stocktake] khong phat duoc tin hieu doi:', error.message); }
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
    if (session.status !== 'open') throw fail(409, 'STOCKTAKE_CLOSED', 'Đợt kiểm kê đã đóng, không sửa được nữa.');
    return session;
  }

  async function listSessions(ctx) {
    const scope = ctx.scope || BRANCHES;
    const { rows } = await getDb().query(
      `SELECT ${SESSION_COLUMNS} FROM stocktake_sessions WHERE branch = ANY($1::text[]) ORDER BY date_to DESC, id DESC`, [scope]);
    return { sessions: rows.map(shapeSession) };
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
      const { rows } = await client.query(
        `INSERT INTO stocktake_sessions (branch, name, date_from, date_to, created_by_user_id, created_by_name)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${SESSION_COLUMNS}`, [branch, name, dateFrom, dateTo, actor.id, actor.name]);
      const session = shapeSession(rows[0]);
      await writeHistory(client, session, actor, '', 'session_create', undefined, { name, dateFrom, dateTo });
      return { session };
    });
  }

  // Ket qua dot da dong gan nhat truoc dot nay (nguon "KK truoc sai").
  async function previousResults(db, session) {
    const prev = (await db.query(
      `SELECT id FROM stocktake_sessions WHERE branch = $1 AND status = 'closed' AND id <> $2 AND date_to <= $3::date
       ORDER BY date_to DESC, id DESC LIMIT 1`, [session.branch, session.id, session.dateFrom])).rows[0];
    if (!prev) return { previousSessionId: null, previous: [] };
    const { rows } = await db.query(`SELECT product_code, diff_qty::float8 AS diff_qty FROM stocktake_session_results WHERE session_id = $1`, [prev.id]);
    return { previousSessionId: Number(prev.id), previous: rows.map(row => ({ code: row.product_code, diffQty: Number(row.diff_qty) })) };
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
  async function loadInputs(db, session, { fresh = false } = {}) {
    if (fresh) {
      cache.delete('products:' + session.branch);
      cache.delete('positions:' + session.branch);
    }
    const [lines, edits, products, positions, tags, notes, prev] = await Promise.all([
      db.query(TEAM_LINES_SQL, [session.branch, session.dateFrom, session.dateTo]).then(r => r.rows.map(row => ({
        orderId: Number(row.order_id), lineNo: row.line_no, orderCode: row.order_code, orderStatus: row.order_status,
        team: row.team, zone: row.zone, spec: row.spec, productCode: row.product_code, productName: row.product_name, quantity: Number(row.quantity)
      }))),
      db.query(`SELECT ${EDIT_COLUMNS} FROM stocktake_line_edits WHERE session_id = $1`, [session.id]).then(r => r.rows.map(shapeEdit)),
      cached('products:' + session.branch, () => db.query(PRODUCTS_SQL, [session.branch]).then(r => r.rows.map(row => ({
        code: row.code, name: row.name, stock: Number(row.stock), cost: Number(row.cost)
      })))),
      cached('positions:' + session.branch, () => db.query(POSITIONS_SQL, [POSITION_BRANCH[session.branch]]).then(r => r.rows.map(row => ({
        code: row.code, location: row.location, arrivalDate: row.arrival_date
      })))),
      db.query(`SELECT ${TAG_COLUMNS} FROM stocktake_product_tags WHERE branch = $1`, [session.branch]).then(r => r.rows.map(shapeTag)),
      db.query(`SELECT ${NOTE_COLUMNS} FROM stocktake_code_notes WHERE session_id = $1`, [session.id]).then(r => r.rows.map(shapeNote)),
      previousResults(db, session)
    ]);
    return { lines, edits, products, positions, tags, notes, ...prev };
  }

  // Dot da dong: doc ban chup, ghi chu va tag van hien (khong co dong dem chi tiet).
  async function closedBoard(db, session) {
    const [results, tags, notes, prev] = await Promise.all([
      db.query(`SELECT product_code, name, counted::float8 AS counted, stock::float8 AS stock, cost::float8 AS cost,
                       diff_qty::float8 AS diff_qty, diff_value::float8 AS diff_value
                FROM stocktake_session_results WHERE session_id = $1 ORDER BY product_code`, [session.id]).then(r => r.rows),
      db.query(`SELECT ${TAG_COLUMNS} FROM stocktake_product_tags WHERE branch = $1`, [session.branch]).then(r => r.rows.map(shapeTag)),
      db.query(`SELECT ${NOTE_COLUMNS} FROM stocktake_code_notes WHERE session_id = $1`, [session.id]).then(r => r.rows.map(shapeNote)),
      previousResults(db, session)
    ]);
    const tagByCode = new Map(tags.map(tag => [tag.code, tag]));
    const noteByCode = new Map(notes.map(note => [note.code, note]));
    const prevByCode = new Map(prev.previous.map(item => [item.code, item.diffQty]));
    const rows = results.map(row => {
      const tag = tagByCode.get(row.product_code);
      return {
        code: row.product_code, name: row.name, inKiot: true, counted: Number(row.counted), stock: Number(row.stock), cost: Number(row.cost),
        diffQty: Number(row.diff_qty), diffValue: Number(row.diff_value), forgotten: false,
        cluster: (tag && tag.cluster) || '', clusterDiff: null, isCombo: Boolean(tag && tag.isCombo), tagVersion: tag ? tag.version : null,
        prevDiff: prevByCode.has(row.product_code) ? prevByCode.get(row.product_code) : null,
        latestPosition: null, note: noteByCode.get(row.product_code) || null, lines: []
      };
    });
    const clusterSum = new Map();
    for (const row of rows) if (row.cluster) clusterSum.set(row.cluster.toUpperCase(), (clusterSum.get(row.cluster.toUpperCase()) || 0) + row.diffQty);
    for (const row of rows) if (row.cluster) row.clusterDiff = clusterSum.get(row.cluster.toUpperCase());
    const totals = rows.reduce((sum, row) => {
      sum.codes += 1;
      if (row.diffQty !== 0) sum.mismatched += 1;
      sum.diffValue += row.diffValue;
      return sum;
    }, { codes: 0, mismatched: 0, forgotten: 0, diffValue: 0 });
    return { rows, totals, previousSessionId: prev.previousSessionId };
  }

  async function getBoard(ctx, id) {
    const db = getDb();
    const session = await readSession(db, ctx, id);
    const [board, employees] = await Promise.all([
      session.status === 'closed'
        ? closedBoard(db, session)
        : loadInputs(db, session).then(inputs => ({ ...buildBoard(inputs), previousSessionId: inputs.previousSessionId })),
      loadEmployees(db)
    ]);
    // Goi y Trang thai / Chi tiet ly do: cac gia tri da dung trong dot.
    const suggestions = { status: new Set(), reason: new Set() };
    for (const row of board.rows) {
      if (row.note && row.note.statusText) suggestions.status.add(row.note.statusText);
      if (row.note && row.note.reasonText) suggestions.reason.add(row.note.reasonText);
    }
    return {
      session, ...board, employees,
      suggestions: { status: [...suggestions.status].sort(), reason: [...suggestions.reason].sort() }
    };
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
    }, sessionId);
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
    }, sessionId);
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
      const reasonText = body.reasonText === undefined ? (before ? before.reasonText : '') : textOf(body, 'reasonText', 'Chi tiết lý do', MAX.note);
      let recheckEmployeeId = before ? before.recheckEmployeeId : null;
      if (body.recheckEmployeeId !== undefined) {
        recheckEmployeeId = body.recheckEmployeeId === null || body.recheckEmployeeId === '' ? null : Number(body.recheckEmployeeId);
        if (recheckEmployeeId !== null) {
          const found = (await client.query('SELECT 1 FROM hr_employees WHERE id = $1 AND is_active', [recheckEmployeeId])).rows[0];
          if (!found) throw fail(400, 'VALIDATION', 'Không tìm thấy nhân sự kiểm lại.', { field: 'recheckEmployeeId' });
        }
      }
      const { rows } = await client.query(
        `INSERT INTO stocktake_code_notes (session_id, product_code, status_text, reason_text, recheck_employee_id, updated_by_user_id, updated_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (session_id, product_code) DO UPDATE SET status_text = EXCLUDED.status_text, reason_text = EXCLUDED.reason_text,
           recheck_employee_id = EXCLUDED.recheck_employee_id, version = stocktake_code_notes.version + 1,
           updated_by_user_id = EXCLUDED.updated_by_user_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()
         RETURNING ${NOTE_COLUMNS}`, [session.id, productCode, statusText, reasonText, recheckEmployeeId, actor.id, actor.name]);
      const note = shapeNote(rows[0]);
      await writeHistory(client, session, actor, productCode, 'note', before, note);
      return { note };
    }, sessionId);
  }

  // Cum SP / Combo giu qua cac dot theo co so; sessionId chi de bao tin hieu cho bang dang mo.
  async function saveTag(ctx, sessionId, code, body = {}) {
    const actor = actorOf(ctx);
    const productCode = codeKey(code);
    if (!productCode) throw fail(400, 'VALIDATION', 'Thiếu mã hàng.');
    return withTransaction(async client => {
      const session = await readSession(client, ctx, sessionId);
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
    }, sessionId);
  }

  async function codeHistory(ctx, sessionId, code) {
    const db = getDb();
    const session = await readSession(db, ctx, sessionId);
    const productCode = codeKey(code);
    // Tag (Cum SP / Combo) giu qua cac dot nen lay ca lich su tag cua ma o dot khac.
    const { rows } = await db.query(
      `SELECT id, session_id, action, before, after, actor_name, created_at FROM stocktake_history
       WHERE product_code = $1 AND (session_id = $2 OR (action = 'tag' AND branch = $3))
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
          `INSERT INTO stocktake_session_results (session_id, product_code, name, counted, stock, cost, diff_qty, diff_value)
           SELECT $1, r.code, r.name, r.counted, r.stock, r.cost, r.diff_qty, r.diff_value
           FROM jsonb_to_recordset($2::jsonb) AS r(code text, name text, counted numeric, stock numeric, cost numeric, diff_qty numeric, diff_value numeric)`,
          [session.id, JSON.stringify(results.map(r => ({ code: r.code, name: r.name || '', counted: r.counted, stock: r.stock, cost: r.cost, diff_qty: r.diffQty, diff_value: r.diffValue })))]);
      }
      const { rows } = await client.query(
        `UPDATE stocktake_sessions SET status = 'closed', version = version + 1, closed_by_user_id = $2, closed_by_name = $3, closed_at = now()
         WHERE id = $1 RETURNING ${SESSION_COLUMNS}`, [session.id, actor.id, actor.name]);
      const closed = shapeSession(rows[0]);
      await writeHistory(client, closed, actor, '', 'session_close', undefined, { codes: results.length, mismatched: results.filter(r => r.diffQty !== 0).length });
      return { session: closed };
    }, sessionId);
  }

  return { listSessions, createSession, getBoard, saveLine, addLine, saveNote, saveTag, codeHistory, closeSession };
}

module.exports = { createStockTakeService, TEAM_LINES_SQL, fail, ...createStockTakeService() };
