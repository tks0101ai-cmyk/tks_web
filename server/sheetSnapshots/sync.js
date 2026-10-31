'use strict';

// ==========================================
// SHEET SNAPSHOTS — doc Google Sheets THEO CHU KY roi ghi vao Postgres; web chi doc bang DB.
//   shipping_measures : sheet "CAN DO" -> shipping_measures
// (2026-10-30: 2 nguon stock_locations_hn / stock_locations_sg doc sheet "Vi tri HN" / "Vi tri SG" da go cung module Vi tri hang cu;
//  bang stock_location_lines con trong DB nhung khong con job nao ghi.)
// Khuon theo productContainers/sync.js: khoa advisory chung giua cac instance, cong "chua den han"
// luu o DB (khoi dong lai khong don Sheets), GHI KHAC BIET (sheet khong doi => 0 dong ghi), chot an
// toan khi so dong tut manh, loi giu nguyen ban thanh cong gan nhat va chi ghi thong bao an toan.
// ==========================================

const CONFIG = require('../config');
const { getPool } = require('../db/pool');
const { createReadOnlyClient } = require('../sheets/sheetsClient');
const { parseMeasureRows, normalizeHeader } = require('../shipment/measureSheet');

const SHRINK_GUARD_RATIO = 0.7;
const SAFE_ERROR = 'Không đọc hoặc lưu được dữ liệu từ Google Sheets. Đang giữ lần đồng bộ thành công gần nhất.';
const HELD_ERROR = 'Số dòng giảm mạnh bất thường; đang chờ xác nhận ở lần đọc kế tiếp. Giữ nguyên bản thành công gần nhất.';

function findSheetTitle(titles, wanted) {
  return titles.find(title => title === wanted) ||
    titles.find(title => normalizeHeader(title) === normalizeHeader(wanted));
}

function missingSheet(wanted) {
  const error = new Error(`Không tìm thấy sheet ${wanted}.`);
  error.code = 'SNAPSHOT_SHEET_MISSING';
  return error;
}

const measureSource = {
  id: 'shipping_measures',
  lockKey: 20531103,
  intervalMs: 5 * 60 * 1000,
  spreadsheetId: () => CONFIG.SHIPPING_MEASURE_SPREADSHEET_ID,
  table: 'shipping_measures',
  keyCols: ['code_key'],
  scope: null,
  async read(client) {
    const title = findSheetTitle(await client.listSheetTitles(), CONFIG.SHIPPING_MEASURE_SHEET);
    if (!title) throw missingSheet(CONFIG.SHIPPING_MEASURE_SHEET);
    const values = await client.getValues(title, { valueRenderOption: 'UNFORMATTED_VALUE' });
    const table = parseMeasureRows(values);
    const rows = [...table].map(([codeKey, entry]) => ({
      code_key: codeKey, per_carton: entry.perCarton, m3_per_unit: entry.m3PerUnit, kg_per_unit: entry.kgPerUnit,
      freight_per_unit: entry.freightPerUnit
    }));
    rows.freightError = table.freightError;
    return rows;
  },
  // Loi rieng cot O (cuoc) luu cung luot thanh cong; chi job Kiem tra gia ban doc cot nay (migration 0077).
  successState: rows => ({ sql: 'UPDATE sheet_snapshot_sync SET freight_error = $2 WHERE source = $1', value: rows.freightError || null })
};

const SOURCES = [measureSource];

// Trang thai "cho xac nhan so dong tut" theo nguon, nam trong bo nho tien trinh (giong productContainers).
const pendingShrink = new Map();

const fingerprint = rows => JSON.stringify(rows);

function stageSql(source) {
  const keyMatch = alias => source.keyCols.map(col => `n.${col} = ${alias}.${col}`).join(' AND ');
  const scope = source.scope ? `l.${source.scope.col} = $1 AND ` : '';
  return {
    create: `CREATE TEMP TABLE sheet_snapshot_stage (LIKE ${source.table}) ON COMMIT DROP`,
    fill: `INSERT INTO sheet_snapshot_stage SELECT * FROM jsonb_populate_recordset(NULL::${source.table}, $1::jsonb)`,
    count: source.scope
      ? `SELECT count(*)::int AS n FROM ${source.table} WHERE ${source.scope.col} = $1`
      : `SELECT count(*)::int AS n FROM ${source.table}`,
    // ROW(n.*) so sanh ca dong cung kieu bang nen numeric 1.0 = 1.
    remove: `DELETE FROM ${source.table} l WHERE ${scope}NOT EXISTS (
      SELECT 1 FROM sheet_snapshot_stage n WHERE ${keyMatch('l')} AND ROW(n.*) IS NOT DISTINCT FROM ROW(l.*))`,
    insert: `INSERT INTO ${source.table} SELECT n.* FROM sheet_snapshot_stage n WHERE NOT EXISTS (
      SELECT 1 FROM ${source.table} l WHERE ${keyMatch('l')})`
  };
}

async function refreshSource(source, {
  pool = getPool(), client, now = () => new Date(), logger = console
} = {}) {
  const spreadsheetId = source.spreadsheetId();
  if (!spreadsheetId) return { status: 'disabled' };
  const sheetsClient = client || createReadOnlyClient(source.spreadsheetId, source.id);
  const sql = stageSql(source);
  const connection = await pool.connect();
  let locked = false;
  let transaction = false;
  let attempted = false;
  let brokenConnection = null;
  let nextAttemptAt = null;
  const started = Date.now();
  try {
    const lock = await connection.query('SELECT pg_try_advisory_lock($1) AS locked', [source.lockKey]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { status: 'busy' };
    const { rows: stateRows } = await connection.query(
      'SELECT last_attempt_at, last_success_at FROM sheet_snapshot_sync WHERE source = $1', [source.id]);
    const attemptAt = now();
    const previous = new Date(stateRows[0]?.last_attempt_at || stateRows[0]?.last_success_at || 0).getTime();
    if (previous && attemptAt.getTime() - previous < source.intervalMs) {
      return { status: 'not-due', nextAttemptAt: previous + source.intervalMs };
    }
    nextAttemptAt = attemptAt.getTime() + source.intervalMs;
    attempted = true;
    await connection.query(`INSERT INTO sheet_snapshot_sync (source, last_attempt_at) VALUES ($1, $2)
      ON CONFLICT (source) DO UPDATE SET last_attempt_at = EXCLUDED.last_attempt_at`, [source.id, attemptAt]);

    const rows = await source.read(sheetsClient);

    await connection.query('BEGIN'); transaction = true;
    await connection.query(sql.create);
    await connection.query(sql.fill, [JSON.stringify(rows)]);
    const countParams = source.scope ? [source.scope.value] : [];
    const previousRows = Number((await connection.query(sql.count, countParams)).rows[0]?.n) || 0;
    if (previousRows > 0 && rows.length < previousRows * SHRINK_GUARD_RATIO) {
      const candidate = fingerprint(rows);
      if (pendingShrink.get(source.id) !== candidate) {
        pendingShrink.set(source.id, candidate);
        await connection.query('ROLLBACK'); transaction = false;
        await connection.query('UPDATE sheet_snapshot_sync SET last_error = $2 WHERE source = $1', [source.id, HELD_ERROR]);
        logger.error('[SheetSnapshots] Held abnormal shrink', { source: source.id, previousRows, rows: rows.length });
        return { status: 'held', previousRows, rowCount: rows.length, nextAttemptAt };
      }
    }
    pendingShrink.delete(source.id);
    const removed = (await connection.query(sql.remove, source.scope ? [source.scope.value] : [])).rowCount || 0;
    const inserted = (await connection.query(sql.insert)).rowCount || 0;
    await connection.query(
      'UPDATE sheet_snapshot_sync SET last_success_at = $2, last_error = NULL WHERE source = $1', [source.id, now()]);
    if (source.successState) {
      const extra = source.successState(rows);
      await connection.query(extra.sql, [source.id, extra.value]);
    }
    await connection.query('COMMIT'); transaction = false;
    const changed = removed + inserted > 0;
    logger.info(changed ? '[SheetSnapshots] Updated' : '[SheetSnapshots] Unchanged',
      { source: source.id, rows: rows.length, inserted, deleted: removed, durationMs: Date.now() - started });
    return { status: changed ? 'updated' : 'unchanged', rowCount: rows.length, inserted, deleted: removed, nextAttemptAt };
  } catch (error) {
    if (transaction) {
      try { await connection.query('ROLLBACK'); } catch (rollbackError) { brokenConnection = rollbackError; }
      transaction = false;
    }
    if (attempted && !brokenConnection) {
      // Thieu migration / loi Google khong duoc lam sap server hay lo chi tiet request/auth.
      await connection.query('UPDATE sheet_snapshot_sync SET last_error = $2 WHERE source = $1', [source.id, SAFE_ERROR]).catch(() => {});
    }
    logger.error('[SheetSnapshots] Refresh failed', { source: source.id, code: error.code || 'SOURCE_OR_DATABASE_FAILURE', durationMs: Date.now() - started });
    return { status: 'failed', nextAttemptAt };
  } finally {
    try {
      if (locked && !brokenConnection) await connection.query('SELECT pg_advisory_unlock($1)', [source.lockKey]);
    } catch (unlockError) {
      brokenConnection = unlockError;
      logger.error('[SheetSnapshots] Discarding connection after lock release failure.');
    } finally {
      // Khong tra ve pool mot phien co trang thai khoa/transaction khong ro.
      connection.release(brokenConnection || undefined);
    }
  }
}

function startSheetSnapshotSchedule({
  sources = SOURCES, refresh = refreshSource,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, now = Date.now, logger = console
} = {}) {
  let stopped = false;
  const timers = new Map();
  const loops = sources.filter(source => source.spreadsheetId()).map(source => {
    let running = false;
    const tick = async () => {
      if (running || stopped) return;
      running = true;
      let result;
      try { result = await refresh(source); }
      catch { logger.error('[SheetSnapshots] Scheduler failed; will retry next cycle.', { source: source.id }); }
      finally {
        running = false;
        if (!stopped) {
          const delay = result?.nextAttemptAt ? Math.max(1, result.nextAttemptAt - now()) : source.intervalMs;
          const timer = setTimeoutFn(tick, delay);
          timer.unref?.();
          timers.set(source.id, timer);
        }
      }
    };
    return tick();
  });
  return {
    ready: Promise.all(loops),
    stop() { stopped = true; timers.forEach(timer => clearTimeoutFn(timer)); }
  };
}

module.exports = { SOURCES, refreshSource, startSheetSnapshotSchedule, __test__: { pendingShrink } };
