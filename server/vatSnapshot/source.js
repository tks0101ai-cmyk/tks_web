'use strict';

const { getPool } = require('../db/pool');
const FRESH_MS = 5 * 60 * 1000;
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
const readers = new WeakMap();
const sourceKey = source => `${source.spreadsheetId}:${source.sheetId}`;
function unavailable() {
  return Object.assign(new Error('Dữ liệu VAT chưa sẵn sàng hoặc đã quá cũ. Kiểm tra worker đồng bộ VAT.'),
    { code: 'VAT_SNAPSHOT_UNAVAILABLE', statusCode: 503 });
}

function createSnapshotReader({ pool, now = Date.now } = {}) {
  let cached = null, pending = null, expires = 0;
  async function get({ forceRefresh = false } = {}) {
    if (forceRefresh) {
      // Coalesce refresh buttons across all users/processes; failures must respect worker backoff.
      try { await pool.query(`UPDATE vat_sheet_snapshot SET next_attempt_at = now()
        WHERE id = 1 AND last_error IS NULL
          AND (lease_until IS NULL OR lease_until < now())
          AND (last_attempt_at IS NULL OR last_attempt_at < now() - interval '60 seconds')
          AND next_attempt_at > now()`); }
      catch (error) { if (error.code === '42P01') throw unavailable(); throw error; }
      expires = 0;
    }
    if (!cached || now() >= expires) {
      if (!pending) pending = (async () => {
        // Probe only the small state once cached; pull the heavy raw bundle only when it changes.
        let result = await pool.query(cached
          ? 'SELECT loaded_at, last_error FROM vat_sheet_snapshot WHERE id = 1'
          : 'SELECT records, loaded_at, last_error FROM vat_sheet_snapshot WHERE id = 1');
        let row = result.rows[0] || {};
        if (cached && new Date(row.loaded_at).getTime() !== new Date(cached.loaded_at).getTime()) {
          result = await pool.query('SELECT records, loaded_at, last_error FROM vat_sheet_snapshot WHERE id = 1');
          row = result.rows[0] || {};
        } else if (cached) row = { ...cached, ...row };
        cached = row; expires = now() + 10000; return cached;
      })()
        .finally(() => { pending = null; });
      try { await pending; }
      catch (error) { if (error.code === '42P01') throw unavailable(); throw error; }
    }
    const loadedAt = cached.loaded_at ? new Date(cached.loaded_at).getTime() : NaN;
    if (!cached.records || !Number.isFinite(loadedAt) || now() - loadedAt > MAX_AGE_MS) throw unavailable();
    return { records: cached.records, loadedAt, stale: !!cached.last_error || now() - loadedAt > FRESH_MS };
  }
  return { get, clear() { expires = 0; } };
}
function snapshotReader(pool = getPool()) {
  if (!readers.has(pool)) readers.set(pool, createSnapshotReader({ pool }));
  return readers.get(pool);
}
function recordsFor(snapshot, source) {
  const rows = snapshot.records[sourceKey(source)];
  if (!Array.isArray(rows)) throw unavailable();
  return rows;
}
function createParsedSource(parse, { pool } = {}) {
  let parsed, version, seeded;
  return {
    async get(options) {
      if (seeded) return seeded;
      const snapshot = await snapshotReader(pool).get(options);
      if (version !== snapshot.loadedAt) { parsed = parse(snapshot); version = snapshot.loadedAt; }
      return { ...parsed, loadedAt: snapshot.loadedAt, stale: snapshot.stale, fallbackTabs: snapshot.records.__fallbackTabs || [] };
    },
    refresh() { return this.get({ forceRefresh: true }); },
    set(data) { seeded = { ...data, loadedAt: Date.now(), stale: false }; },
    clear() { parsed = undefined; version = undefined; seeded = undefined; }
  };
}
module.exports = { FRESH_MS, MAX_AGE_MS, sourceKey, unavailable, recordsFor, createSnapshotReader, snapshotReader, createParsedSource };
