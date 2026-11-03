'use strict';

// Nap MOT LAN tab "KIEM KE HN T10" (dot 3/10/2026) thanh dot da dong: dot dau tien tren web co "KK truoc sai".
// SL Chenh lay nguyen tu sheet (da sua tay sau kiem lai), khong tinh lai. Cum SP chi nap khi >= 2 ma cung cum
// Nap them tab "KIEM SG" (dot SG cung ngay), tu noi doi chieu cheo voi dot T10.
// (cum 1 ma khong co nghia), Combo nap theo o danh dau; tag san co tren web khong bi ghi de.
const { getPool } = require('../db/pool');
const { readSheetValuesById } = require('../sheets/sheetsClient');
const { stripTelegramId } = require('../dashboard/saleName');
const { codeKey } = require('./stocktakeCompute');
const { announceChanged } = require('./stocktakeEvents');

const SPREADSHEET_ID = '1hbYPE1t7vTkpheKdmYpLkD9OyUH4GADcP4xZEoTeF1M';
// KIEM SG la IMPORTRANGE tu file "KIEM KE SG" (service account khong doc duoc file goc) -> doc ban da keo ve trong file HN.
const SOURCES = Object.freeze({
  t10: Object.freeze({ spreadsheetId: SPREADSHEET_ID, sheetId: 1784846530, branch: 'hanoi', name: 'Kiểm kê HN T10 (sheet)', date: '2026-10-03', label: 'T10 Hà Nội' }),
  sg: Object.freeze({ spreadsheetId: SPREADSHEET_ID, sheetId: 1469990159, branch: 'saigon', name: 'Kiểm kê SG T10 (sheet)', date: '2026-10-03', label: 'KIỂM SG' })
});
const T10_SOURCE = Object.freeze({ spreadsheetId: SOURCES.t10.spreadsheetId, sheetId: SOURCES.t10.sheetId });

const fold = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase().replace(/\s+/gu, ' ').trim();
// Tieu de da bo dau -> truong. Khong co trong tab thi truong do rong.
const LAYOUTS = Object.freeze({
  t10: Object.freeze({
    code: 'ma sp', name: 'ten hang', counted: 'tong kiem', stock: 'ton kiot', diffQty: 'sl chenh', diffValue: 'gia tri chenh',
    statusText: 'trang thai', reasonText: 'chi tiet ly do', printPage: 'trang in', printTime: 'gio in', recheck: 'nguoi kiem lai',
    prevDiff: 'kk truoc sai', cluster: 'cum sp', combo: 'combo', cost: 'gia von'
  }),
  sg: Object.freeze({
    code: 'ma sp', name: 'ten hang', cost: 'gia von', counted: 'tong kiem', stock: 'ton kiot', diffQty: 'sl chenh', diffValue: 'gia tri chenh',
    recheck: 'chac chan thua', prevDiff: 'kk truoc sai', reasonText: 'ly do', statusText: 'ly do so bo', printPage: 'trang in'
  })
});
const REQUIRED = ['code', 'counted', 'stock', 'diffQty'];

// So tu sheet: so that (UNFORMATTED_VALUE) hoac chuoi "1,234" / "-62,930,000".
const numberOf = value => {
  if (typeof value === 'number') return value;
  const n = Number(String(value ?? '').replace(/[,\s]/gu, ''));
  return Number.isFinite(n) ? n : 0;
};
const text = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const optionalNumber = value => (text(value) === '' ? null : numberOf(value));

function fail(statusCode, code, message) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** Mang 2 chieu cua tab -> { rows: [{code, name, counted, stock, cost, diffQty, diffValue, statusText, reasonText, recheck, cluster, isCombo}] }. */
function parseSheet(values, layout) {
  const header = (values[0] || []).map(fold);
  const col = {};
  for (const [field, name] of Object.entries(layout)) {
    const index = header.indexOf(name);
    if (index !== -1) col[field] = index;
  }
  const missing = REQUIRED.filter(field => col[field] === undefined);
  if (missing.length) throw fail(400, 'SHEET_FORMAT', `Tab kiểm kê thiếu cột: ${missing.map(f => layout[f]).join(', ')}.`);
  const cell = (row, field) => (col[field] === undefined ? '' : row[col[field]]);

  const byCode = new Map();
  for (const row of values.slice(1)) {
    const code = codeKey(cell(row, 'code'));
    if (!code || byCode.has(code)) continue; // dong tong (khong ma) / ma lap lai: giu dong dau
    const diffQty = numberOf(cell(row, 'diffQty'));
    const cost = numberOf(cell(row, 'cost'));
    byCode.set(code, {
      code,
      name: text(cell(row, 'name')),
      counted: numberOf(cell(row, 'counted')),
      stock: numberOf(cell(row, 'stock')),
      cost,
      diffQty,
      diffValue: col.diffValue === undefined ? Math.round(diffQty * cost) : numberOf(cell(row, 'diffValue')),
      statusText: text(cell(row, 'statusText')).slice(0, 200),
      reasonText: text(cell(row, 'reasonText')).slice(0, 1000),
      printPage: text(cell(row, 'printPage')).slice(0, 50),
      printTime: text(cell(row, 'printTime')).slice(0, 50),
      prevDiff: col.prevDiff === undefined ? null : optionalNumber(cell(row, 'prevDiff')),
      recheck: text(cell(row, 'recheck')),
      cluster: text(cell(row, 'cluster')).slice(0, 200),
      isCombo: Boolean(text(cell(row, 'combo')))
    });
  }
  const rows = [...byCode.values()];
  const clusterSize = new Map();
  for (const row of rows) if (row.cluster) clusterSize.set(fold(row.cluster), (clusterSize.get(fold(row.cluster)) || 0) + 1);
  for (const row of rows) if (row.cluster && clusterSize.get(fold(row.cluster)) < 2) row.cluster = '';
  return { rows };
}

const parseT10 = values => parseSheet(values, LAYOUTS.t10);
const parseSg = values => parseSheet(values, LAYOUTS.sg);

function createStocktakeSheetImport({ getDb = getPool, readValues = readSheetValuesById, announce = announceChanged } = {}) {
  async function importSheet(ctx, body = {}) {
    const key = body.source === undefined || body.source === '' ? 't10' : String(body.source);
    const source = Object.hasOwn(SOURCES, key) ? SOURCES[key] : null;
    if (!source) throw fail(400, 'VALIDATION', 'Nguồn sheet không hợp lệ (t10 hoặc sg).');
    const branch = source.branch;
    if (ctx.scope && !ctx.scope.includes(branch)) throw fail(403, 'BRANCH_OUT_OF_SCOPE', `Cơ sở ${branch === 'hanoi' ? 'Hà Nội' : 'Sài Gòn'} không thuộc phạm vi đang chọn.`);
    const sourceRef = `sheet:${source.spreadsheetId}:${source.sheetId}`;
    const values = await readValues({ spreadsheetId: source.spreadsheetId, sheetId: source.sheetId }, { valueRenderOption: 'UNFORMATTED_VALUE' });
    const { rows } = parseSheet(values, LAYOUTS[key]);
    if (!rows.length) throw fail(400, 'SHEET_EMPTY', 'Tab kiểm kê không có dòng mã hàng nào.');
    const user = ctx.user || {};
    const actor = { id: user.id === undefined || user.id === null ? null : String(user.id), name: stripTelegramId(user.hoTen || user.username || '') };
    const name = text(body.name) || source.name;

    const client = await getDb().connect();
    try {
      await client.query('BEGIN');
      if ((await client.query('SELECT 1 FROM stocktake_sessions WHERE source_ref = $1', [sourceRef])).rows[0]) {
        throw fail(409, 'ALREADY_IMPORTED', `Số liệu ${source.label} đã được nạp trước đó.`);
      }
      const session = (await client.query(
        `INSERT INTO stocktake_sessions (branch, name, date_from, date_to, status, source, source_ref, created_by_user_id, created_by_name,
                                         closed_by_user_id, closed_by_name, closed_at)
         VALUES ($1, $2, $3, $3, 'closed', 'sheet_import', $4, $5, $6, $5, $6, now()) RETURNING id`,
        [branch, name, source.date, sourceRef, actor.id, actor.name])).rows[0];
      const sessionId = Number(session.id);
      const payload = JSON.stringify(rows);
      await client.query(
        `INSERT INTO stocktake_session_results (session_id, product_code, name, counted, stock, cost, diff_qty, diff_value, prev_diff)
         SELECT $1, r.code, r.name, r.counted, r.stock, r.cost, r."diffQty", r."diffValue", r."prevDiff"
         FROM jsonb_to_recordset($2::jsonb) AS r(code text, name text, counted numeric, stock numeric, cost numeric, "diffQty" numeric, "diffValue" numeric, "prevDiff" numeric)`,
        [sessionId, payload]);
      // Nguoi kiem lai: giu nguyen chu trong sheet (thuong la biet danh "THAI KHO"); khop duoc dung 1 nhan su dang lam
      // theo ho ten (khong phan biet hoa/thuong) thi gan them id.
      const notes = await client.query(
        `INSERT INTO stocktake_code_notes (session_id, product_code, status_text, reason_text, print_page, print_time, recheck_employee_id, recheck_name, updated_by_user_id, updated_by_name)
         SELECT $1, r.code, r."statusText", r."reasonText", r."printPage", r."printTime",
                (SELECT CASE WHEN count(*) = 1 THEN min(e.id) END FROM hr_employees e
                 WHERE e.is_active AND r.recheck <> '' AND lower(btrim(e.ho_ten)) = lower(r.recheck)),
                r.recheck, $3, $4
         FROM jsonb_to_recordset($2::jsonb) AS r(code text, "statusText" text, "reasonText" text, "printPage" text, "printTime" text, recheck text)
         WHERE r."statusText" <> '' OR r."reasonText" <> '' OR r.recheck <> '' OR r."printPage" <> '' OR r."printTime" <> ''`,
        [sessionId, payload, actor.id, actor.name]);
      const tags = await client.query(
        `INSERT INTO stocktake_product_tags (branch, product_code, cluster, is_combo, updated_by_user_id, updated_by_name)
         SELECT $1, r.code, r.cluster, r."isCombo", $3, $4
         FROM jsonb_to_recordset($2::jsonb) AS r(code text, cluster text, "isCombo" boolean)
         WHERE r.cluster <> '' OR r."isCombo"
         ON CONFLICT (branch, product_code) DO NOTHING`,
        [branch, payload, actor.id, actor.name]);
      // Dot nap cua co so kia (neu da co) <-> dot nay, chi dien o con trong.
      const other = (await client.query(
        `SELECT id FROM stocktake_sessions WHERE source = 'sheet_import' AND branch <> $1 ORDER BY id DESC LIMIT 1`, [branch])).rows[0];
      const counterpartSessionId = other ? Number(other.id) : null;
      if (counterpartSessionId) {
        await client.query(
          `UPDATE stocktake_sessions SET counterpart_session_id = CASE WHEN id = $1 THEN $2::bigint ELSE $1::bigint END
           WHERE id IN ($1, $2) AND counterpart_session_id IS NULL`, [sessionId, counterpartSessionId]);
      }
      const summary = { codes: rows.length, mismatched: rows.filter(r => r.diffQty !== 0).length, notes: notes.rowCount, tags: tags.rowCount, counterpartSessionId };
      await client.query(
        `INSERT INTO stocktake_history (session_id, branch, action, after, actor_user_id, actor_name) VALUES ($1, $2, 'sheet_import', $3, $4, $5)`,
        [sessionId, branch, JSON.stringify({ ...summary, sourceRef }), actor.id, actor.name]);
      await client.query('COMMIT');
      try { announce(sessionId); } catch { /* chi la tin hieu tai lai */ }
      return { sessionId, ...summary };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return { importSheet, importT10: (ctx, body = {}) => importSheet(ctx, { ...body, source: 't10' }) };
}

module.exports = { parseSheet, parseT10, parseSg, createStocktakeSheetImport, SOURCES, T10_SOURCE, LAYOUTS, ...createStocktakeSheetImport() };
