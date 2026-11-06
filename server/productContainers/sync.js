'use strict';
const { createHash, randomUUID } = require('node:crypto');
const CONFIG = require('../config');
const { getPool } = require('../db/pool');
const { createReadOnlyClient } = require('../sheets/sheetsClient');
const { SHEET_NAMES, INTERVAL_MS, parseContainerSheet } = require('./parser');
const { invalidateContainerDetails } = require('./repository');
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
const { requestExpectedRefresh } = require('./expectedRefresh');
const LOCK_KEY = 20531015;
const SAFE_ERROR = `Không đọc hoặc lưu được đủ ${SHEET_NAMES.length} sheet CONT. Giữ nguyên bản thành công gần nhất.`;

// GHI KHAC BIET (mau LEFT JOIN/NOT EXISTS rut ra tu su co IO 2026-09-28): nap sheet vao bang tam roi chi
// XOA dong da mat/doi va CHEN dong moi. Sheet khong doi => 0 dong ghi, `version` giu nguyen. Client so
// `version` de quyet dinh tai lai ca bao cao hang hoa (10,9K dong) nen chu ky 10 phut chi bat moi nguoi
// xem tai lai khi noi dung THAT SU doi. Ten bang tam KHONG bat dau bang 'product_container_lines'.
// ROW(n.*) so sanh ca dong cung kieu bang nen numeric 1.0 = 1.
const CREATE_STAGE_SQL = 'CREATE TEMP TABLE container_lines_stage (LIKE product_container_lines) ON COMMIT DROP';
const FILL_STAGE_SQL = `INSERT INTO container_lines_stage
  SELECT * FROM jsonb_populate_recordset(NULL::product_container_lines,$1::jsonb)`;
const COUNT_LINES_SQL = 'SELECT count(*)::int AS n FROM product_container_lines';
const DELETE_STALE_SQL = `DELETE FROM product_container_lines l WHERE NOT EXISTS (
  SELECT 1 FROM container_lines_stage n
  WHERE n.sheet_name = l.sheet_name AND n.source_row = l.source_row AND ROW(n.*) IS NOT DISTINCT FROM ROW(l.*))`;
const INSERT_MISSING_SQL = `INSERT INTO product_container_lines
  SELECT n.* FROM container_lines_stage n WHERE NOT EXISTS (
    SELECT 1 FROM product_container_lines l WHERE l.sheet_name = n.sheet_name AND l.source_row = n.source_row)`;
const SYNC_META_SQL = `SELECT (version IS NULL) AS first_run, (warnings IS DISTINCT FROM $1::jsonb) AS warnings_changed
  FROM product_container_sync WHERE singleton = true`;
const UPDATE_SYNC_SQL = `UPDATE product_container_sync SET
  version = CASE WHEN $1::boolean THEN $2::uuid ELSE version END,
  last_success_at=$3, last_attempt_at=$4, last_error=NULL, warnings=$5::jsonb WHERE singleton=true`;

// CHOT AN TOAN: sheet dang sua do / bi xoa nham co the lam so dong tut manh; ban chup moi giam hon
// 30% so voi bang hien tai chi duoc nhan khi 2 lan doc LIEN TIEP cho dung cung ket qua. Trang thai
// cho xac nhan nam trong bo nho tien trinh (1 instance); nhieu instance thi xac nhan cham hon chu
// khong sai: instance khac chua tung thay ung vien nen se giu bang cu them 1 vong.
const SHRINK_GUARD_RATIO = 0.7;
const HELD_ERROR = 'Số dòng CONT giảm mạnh bất thường; đang chờ xác nhận ở lần đọc kế tiếp. Giữ nguyên bản thành công gần nhất.';
let pendingShrink = null;
const fingerprint = (lines, warnings) =>
  createHash('sha1').update(JSON.stringify({ lines, warnings })).digest('hex');

async function refreshContainers({
  pool = getPool(), spreadsheetId = CONFIG.PRODUCT_CONTAINER_SPREADSHEET_ID,
  client = createReadOnlyClient(() => spreadsheetId, 'Hàng dự kiến'),
  now = () => new Date(), logger = console, force = false
} = {}) {
  if (!spreadsheetId) return { status: 'disabled' };
  const connection = await pool.connect();
  let locked = false;
  let transaction = false;
  let attempted = false;
  let brokenConnection = null;
  let nextAttemptAt = null;
  const started = Date.now();
  try {
    const lock = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { status: 'busy' };
    const purchaseTable = await connection.query("SELECT to_regclass('purchase_settings') AS name");
    // Chi nhuong quyen cho Thu mua khi nguon ghi la web VA Thu mua da noi vao he
    // thong (integration_enabled, migration 0117). O che do cach ly, Thu mua ghi
    // that nhung khong so huu read model, nen job nay VAN PHAI chay: neu dung thi
    // ca workbook (7 sheet + cont lich su) khong con duoc cap nhat.
    if(purchaseTable.rows[0]?.name){const mode=await connection.query('SELECT source_mode,integration_enabled FROM purchase_settings WHERE id=1');if(mode.rows[0]?.source_mode==='web'&&mode.rows[0]?.integration_enabled===true)return {status:'web-source'};}

    const { rows } = await connection.query('SELECT last_attempt_at,last_success_at FROM product_container_sync WHERE singleton = true');
    const attemptAt = now();
    // Also gate on attempts, so restarts after a failed first run cannot hammer
    // Sheets. This same persisted gate serializes staggered server instances.
    const previous = new Date(rows[0]?.last_attempt_at || rows[0]?.last_success_at || 0).getTime();
    if (!force && previous && attemptAt.getTime() - previous < INTERVAL_MS) return { status: 'not-due', nextAttemptAt:previous + INTERVAL_MS };
    nextAttemptAt = attemptAt.getTime() + INTERVAL_MS;
    attempted = true;
    await connection.query('UPDATE product_container_sync SET last_attempt_at=$1 WHERE singleton=true',[attemptAt]);
    const titles = await client.listSheetTitles();
    if (SHEET_NAMES.some(title => !titles.includes(title))) throw new Error('CONTAINER_SHEET_MISSING');
    // All calls settle before releasing the shared lock, including failures.
    const reads = await Promise.allSettled(SHEET_NAMES.map(async (sheetName) => {
      const pair = await Promise.allSettled([
        client.getValues(sheetName,{valueRenderOption:'UNFORMATTED_VALUE',cellRange:'A:X'}),
        client.getValues(sheetName,{valueRenderOption:'FORMATTED_VALUE',cellRange:'A:X'})
      ]);
      if (pair.some(result => result.status === 'rejected')) throw new Error('CONTAINER_SHEET_READ_FAILED');
      return parseContainerSheet(sheetName,pair[0].value,pair[1].value);
    }));
    if (reads.some(result=>result.status==='rejected')) throw new Error('CONTAINER_SOURCE_READ_FAILED');
    const parsed = reads.map(result=>result.value);
    const warnings = parsed.flatMap(sheet=>sheet.warnings);
    const lines = parsed.flatMap((sheet,sheetOrder)=>sheet.rows.map(row=>({
      sheet_name:row.sheetName,sheet_order:sheetOrder,container_row:row.containerRow,source_row:row.sourceRow,
      product_code:row.productCode,product_key:row.productKey,container_name:row.containerName,
      status:row.status,status_label:row.statusLabel,eta:row.eta,color:row.color,sale_note:row.saleNote,other_note:row.otherNote,
      ordered_by:row.orderedBy,listed_at:row.listedAt,units_per_package:row.unitsPerPackage,
      package_count:row.packageCount,quantity:row.quantity,vietnam_price:row.vietnamPrice,unit_price_cny:row.unitPriceCny
    })));
    await connection.query('BEGIN'); transaction = true;
    await connection.query(CREATE_STAGE_SQL);
    await connection.query(FILL_STAGE_SQL,[JSON.stringify(lines)]);
    const previousRows = Number((await connection.query(COUNT_LINES_SQL)).rows[0]?.n) || 0;
    if (previousRows > 0 && lines.length < previousRows * SHRINK_GUARD_RATIO) {
      const candidate = fingerprint(lines,warnings);
      if (pendingShrink !== candidate) {
        pendingShrink = candidate;
        await connection.query('ROLLBACK'); transaction = false;
        await connection.query('UPDATE product_container_sync SET last_error=$1 WHERE singleton=true',[HELD_ERROR]);
        logger.error('[ProductContainers] Held abnormal shrink', { previousRows, rows:lines.length, durationMs:Date.now()-started });
        return { status:'held',previousRows,rowCount:lines.length,nextAttemptAt };
      }
    }
    pendingShrink = null;
    const deleted = (await connection.query(DELETE_STALE_SQL)).rowCount || 0;
    const inserted = (await connection.query(INSERT_MISSING_SQL)).rowCount || 0;
    const meta = (await connection.query(SYNC_META_SQL,[JSON.stringify(warnings)])).rows[0] || {};
    const changed = deleted + inserted > 0 || meta.first_run === true || meta.warnings_changed === true;
    const version = randomUUID();
    await connection.query(UPDATE_SYNC_SQL,[changed,version,now(),attemptAt,JSON.stringify(warnings)]);
    await connection.query('COMMIT'); transaction = false;
    invalidateContainerDetails(pool);
    dashboardRollupEvents.emit('containersChanged', { at: Date.now() });
    logger.info(changed ? '[ProductContainers] Updated' : '[ProductContainers] Unchanged', {
      durationMs:Date.now()-started, inserted, deleted, rows:lines.length,
      sheets:SHEET_NAMES.map((sheetName,index)=>({sheetName,rows:parsed[index].rows.length,skipped:parsed[index].warnings.length})), ...(changed ? { version } : {})
    });
    return { status:changed ? 'updated' : 'unchanged',...(changed ? { version } : {}),rowCount:lines.length,inserted,deleted,nextAttemptAt };
  } catch (error) {
    if (transaction) {
      try { await connection.query('ROLLBACK'); }
      catch (rollbackError) { brokenConnection = rollbackError; }
      transaction = false;
    }
    if (attempted && !brokenConnection) {
      // Missing migration must not crash server startup or expose raw SQL/auth.
      await connection.query('UPDATE product_container_sync SET last_error=$1 WHERE singleton=true',[SAFE_ERROR]).catch(()=>{});
    }
    logger.error('[ProductContainers] Refresh failed', {code:error.code || 'SOURCE_OR_DATABASE_FAILURE',durationMs:Date.now()-started});
    return { status:'failed',nextAttemptAt };
  } finally {
    try {
      if (locked && !brokenConnection) await connection.query('SELECT pg_advisory_unlock($1)',[LOCK_KEY]);
    } catch (unlockError) {
      brokenConnection = unlockError;
      logger.error('[ProductContainers] Discarding connection after lock release failure.');
    } finally {
      // Never return a session with an unknown advisory-lock/transaction state
      // to the pool. pg destroys it when release receives an error.
      connection.release(brokenConnection || undefined);
    }
  }
}

function startContainerSchedule({
  spreadsheetId = CONFIG.PRODUCT_CONTAINER_SPREADSHEET_ID, refresh = refreshContainers,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = Date.now, logger = console,
  // Tinh lai bang "Du kien hang ve" (0075) sau moi luot dong bo CONT co ket qua; test truyen ham gia.
  afterRefresh = () => requestExpectedRefresh()
} = {}) {
  if (!spreadsheetId) return { ready:Promise.resolve(),stop(){} };
  let running = false;
  let stopped = false;
  let timer;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    let result;
    try {
      result = await refresh({spreadsheetId});
      // Loi cua job tinh san khong duoc lam hong lich dong bo CONT (result van giu de dat lich ke tiep).
      if (result && (result.status === 'updated' || result.status === 'unchanged')) {
        try { await afterRefresh(result); }
        catch { logger.error('[ProductContainers] Expected-arrivals refresh failed; will retry next cycle.'); }
      }
    }
    catch { logger.error('[ProductContainers] Scheduler failed; will retry next cycle.'); }
    finally {
      running = false;
      if (!stopped) {
        const delay = result?.nextAttemptAt ? Math.max(1,result.nextAttemptAt-now()) : INTERVAL_MS;
        timer = setTimeoutFn(tick,delay);
        timer.unref?.();
      }
    }
  };
  const ready = tick();
  return {ready,stop(){stopped=true;if(timer)clearTimeoutFn(timer);}};
}
module.exports = { refreshContainers, startContainerSchedule, __sql__: { CREATE_STAGE_SQL, FILL_STAGE_SQL, DELETE_STALE_SQL, INSERT_MISSING_SQL, UPDATE_SYNC_SQL }, __test__: { resetPendingShrink() { pendingShrink = null; } } };
