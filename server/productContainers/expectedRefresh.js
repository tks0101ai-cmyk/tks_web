'use strict';

// Tinh san bang "Du kien hang ve" (migration 0075, tab Hang hoa) tu product_container_lines
// (snapshot sheet CONT do sync.js dong bo) + ten SP tu product_report. KHONG goi Google Sheets.
// Web (/api/expected-arrivals) chi DOC bang ket qua.
//
// Chay sau moi luot dong bo CONT thanh cong (updated / unchanged, 10 phut) nen ten SP moi cua
// product_report cung duoc bat kip trong toi da 1 chu ky.
// Ghi KHAC BIET (bai hoc su co IO 2026-09-28): nap nguon vao bang tam roi chi XOA dong da mat va
// UPSERT dong moi/doi (IS DISTINCT FROM); nguon khong doi => 0 dong ghi, `version` giu nguyen.
// CHOT AN TOAN: nguon tra 0 dong ma bang dang co du lieu thi KHONG xoa sach (sheet loi / dang sua).
//
// Chay tay: node productContainers/expectedRefresh.js

const { getPool } = require('../db/pool');

// Khoa advisory (muc giao dich) rieng cho job nay, khac LOCK_KEY 20531015 cua sync.js.
const LOCK_KEY = 20531073;

const VALUE_COLUMNS = ['sheet_order', 'container_row', 'container_name', 'status', 'status_label', 'eta', 'schedule_label',
  'product_code', 'product_key', 'product_name', 'color', 'sale_note', 'other_note', 'ordered_by', 'listed_at', 'units_per_package', 'package_count', 'unit_price_cny', 'vietnam_price', 'quantity'];
const COLUMNS = ['sheet_name', 'source_row', ...VALUE_COLUMNS];

// Ten SP: product_report 1 dong / ma hang (gom ca 2 co so) nen ten da on dinh; min() chi phong khi
// khoa chuan hoa lower(btrim()) trung nhau giua 2 ma khac hoa/thuong. Khong co => ''.
const STAGE_SQL = `
  CREATE TEMP TABLE expected_stage ON COMMIT DROP AS
  SELECT l.sheet_name, l.source_row, l.sheet_order, l.container_row, l.container_name, l.status, l.status_label, l.eta,
         btrim(concat_ws(' ', NULLIF(btrim(l.status_label), ''), NULLIF(btrim(l.eta), ''))) AS schedule_label,
         l.product_code, l.product_key, COALESCE(n.product_name, '') AS product_name,
         l.color, l.sale_note, l.other_note, l.ordered_by, l.listed_at, l.units_per_package, l.package_count,
         l.unit_price_cny, l.vietnam_price, l.quantity
  FROM product_container_lines l
  LEFT JOIN (SELECT lower(btrim(product_code)) AS product_key, min(product_name) AS product_name
             FROM product_report GROUP BY 1) n ON n.product_key = l.product_key`;

const COUNT_STAGE_SQL = 'SELECT count(*)::int AS n FROM expected_stage';
const COUNT_TARGET_SQL = 'SELECT count(*)::int AS n FROM product_container_expected';

const DELETE_SQL = `
  DELETE FROM product_container_expected t WHERE NOT EXISTS (
    SELECT 1 FROM expected_stage s WHERE s.sheet_name = t.sheet_name AND s.source_row = t.source_row)`;

// LEFT JOIN + IS DISTINCT FROM o SELECT: dong khong doi khong toi INSERT nen khong sinh WAL.
const UPSERT_SQL = `
  INSERT INTO product_container_expected (${COLUMNS.join(', ')})
  SELECT ${COLUMNS.map(column => `s.${column}`).join(', ')}
  FROM expected_stage s
  LEFT JOIN product_container_expected t ON t.sheet_name = s.sheet_name AND t.source_row = s.source_row
  WHERE t.sheet_name IS NULL
     OR (${VALUE_COLUMNS.map(column => `t.${column}`).join(', ')}) IS DISTINCT FROM (${VALUE_COLUMNS.map(column => `s.${column}`).join(', ')})
  ON CONFLICT (sheet_name, source_row) DO UPDATE SET
    ${VALUE_COLUMNS.map(column => `${column} = EXCLUDED.${column}`).join(',\n    ')}`;

// $1 co doi noi dung khong; chi ghi dong trang thai khi co doi / doi phien ban nguon / doi so dong.
const STATE_SQL = `
  INSERT INTO product_container_expected_state (id, version, source_version, computed_at, row_count)
  VALUES (1, CASE WHEN $1::boolean THEN 1 ELSE 0 END,
          (SELECT version FROM product_container_sync WHERE singleton = true), now(),
          (SELECT count(*)::int FROM product_container_expected))
  ON CONFLICT (id) DO UPDATE SET
    version = product_container_expected_state.version + CASE WHEN $1::boolean THEN 1 ELSE 0 END,
    source_version = EXCLUDED.source_version, computed_at = now(), row_count = EXCLUDED.row_count
  WHERE $1::boolean
     OR product_container_expected_state.source_version IS DISTINCT FROM EXCLUDED.source_version
     OR product_container_expected_state.row_count IS DISTINCT FROM EXCLUDED.row_count`;

const VERSION_SQL = 'SELECT version::text AS version FROM product_container_expected_state WHERE id = 1';

let running = null;
let rerunRequested = false;

/** Tinh lai + ghi khac biet. Goi trung luc dang chay trong tien trinh -> chay them 1 luot sau (khong chong luot). */
async function refreshExpected(pool = getPool(), { log = console.log } = {}) {
  if (running) {
    rerunRequested = true;
    return running;
  }
  running = (async () => {
    let result;
    do {
      rerunRequested = false;
      result = await refreshOnce(pool, { log });
    } while (rerunRequested);
    return result;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

async function refreshOnce(pool, { log }) {
  const startedAt = Date.now();
  const client = pool.connect ? await pool.connect() : pool;
  let result;
  try {
    await client.query('BEGIN');
    // Same writer lock as the cont sync and canonical purchase transactions.
    await client.query('SELECT pg_advisory_xact_lock($1)', [20531015]);
    const lock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [LOCK_KEY]);
    if (!lock.rows[0] || lock.rows[0].locked !== true) {
      await client.query('ROLLBACK');
      return { status: 'busy', rows: 0, written: 0, deleted: 0, changed: false };
    }
    await client.query(STAGE_SQL);
    const purchaseTable=await client.query("SELECT to_regclass('purchase_settings') AS name");
    if(purchaseTable.rows[0]?.name){
      const mode=await client.query('SELECT source_mode,integration_enabled FROM purchase_settings WHERE id=1');
      // Cung dieu kien voi sync.js: o che do cach ly, Du kien hang ve khong lay ten
      // tu purchase_orders vi ban Thu mua luc do la du lieu dang thu nghiem.
      if(mode.rows[0]?.source_mode==='web'&&mode.rows[0]?.integration_enabled===true)await client.query("UPDATE expected_stage s SET product_name=o.product_name FROM purchase_orders o WHERE s.sheet_name='THU MUA' AND s.source_row=o.id");
    }
    const staged = Number((await client.query(COUNT_STAGE_SQL)).rows[0].n) || 0;
    const existing = Number((await client.query(COUNT_TARGET_SQL)).rows[0].n) || 0;
    if (staged === 0 && existing > 0) {
      // Chot an toan: nguon rong (loi / dang sua) thi giu nguyen bang dang co.
      await client.query('ROLLBACK');
      result = { status: 'empty-source', rows: 0, written: 0, deleted: 0, changed: false };
    } else {
      const deleted = (await client.query(DELETE_SQL)).rowCount || 0;
      const written = (await client.query(UPSERT_SQL)).rowCount || 0;
      const changed = written + deleted > 0;
      await client.query(STATE_SQL, [changed]);
      const version = Number((await client.query(VERSION_SQL)).rows[0]?.version);
      await client.query('COMMIT');
      result = { status: changed ? 'updated' : 'unchanged', rows: staged, written, deleted, changed, version };
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    if (client !== pool && client.release) client.release();
  }
  log(`[ProductContainerExpected] ${result.status}: ${result.rows} dong, ghi ${result.written}, xoa ${result.deleted} (${Date.now() - startedAt} ms)`);
  return result;
}

/** Lam moi nen, nuot loi (dung cho hook sau dong bo CONT). */
function requestExpectedRefresh(pool = getPool(), { log = console.log } = {}) {
  // Chua cau hinh DB (test/dev) hoac pool gia: khong lam gi.
  if (!pool || typeof pool.query !== 'function' || !require('../config').SUPABASE_DB_URL) return Promise.resolve(null);
  return refreshExpected(pool, { log }).catch(error => {
    // Chua ap migration 0075 (42P01) hoac 0078 (42703, thieu cot gia) -> bo qua yen lang (giong cac job tinh san khac).
    if (error && (error.code === '42P01' || error.code === '42703')) return null;
    console.error('[ProductContainerExpected] Loi tinh bang du kien hang ve:', error && error.message);
    return null;
  });
}

module.exports = { refreshExpected, requestExpectedRefresh, __test__: { UPSERT_SQL, STATE_SQL, STAGE_SQL, VALUE_COLUMNS } };

if (require.main === module) {
  refreshExpected()
    .then(result => { console.log(result); return getPool().end(); })
    .catch(error => { console.error(error); process.exitCode = 1; });
}
