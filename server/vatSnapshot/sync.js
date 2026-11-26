'use strict';

const { randomUUID } = require('node:crypto');
const { getPool } = require('../db/pool');
const CONFIG = require('../config');
const { readSheetValuesById } = require('../sheets/sheetsClient');
const vatConfig = require('../vatDraft/vatDraftConfig');
const { parseMasterData, fetchSheetRecordsWithFallback } = require('../vatDraft/sheetsSource');
const { defaultLookupConfig, parseLookupRecords, isFormulaErrorSheet } = require('../vatLookup/lookupSource');
const { defaultStockConfig } = require('../vatRequests/stockSource');
const { sourceKey, FRESH_MS } = require('./source');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function sources() {
  const lookup = defaultLookupConfig();
  const stock = defaultStockConfig();
  const list = Object.entries(lookup.sheets).map(([key, tab]) => ({ spreadsheetId: lookup.spreadsheetId, ...tab, fallbackSource: lookup.fallbackSheets[key], minColumns: key === 'gop' ? 15 : key === 'khop' ? 11 : 0, label: { gop: 'Gộp VAT', khop: 'Khớp mã', dkve: 'DK VỀ' }[key] }));
  // ORDER VAT may use separate workbooks/tabs; preserve those configured sources.
  for (const tab of [{ ...stock.stockSheet, fallbackSource: stock.stockFallbackSheet, label: 'Tồn VAT' }, { ...stock.mappingSheet, fallbackSource: stock.mappingFallbackSheet, label: 'Khớp mã' }]) {
    if (!list.some(s => sourceKey(s) === sourceKey(tab))) list.push({ ...tab });
  }
  return list;
}
function validateRecords(records, previous) {
  for (const tab of sources()) {
    const rows = records[sourceKey(tab)];
    const minimum = String(tab.sheetId) === String(defaultLookupConfig().sheets.dkve.sheetId) ? 1 : 2;
    if (!Array.isArray(rows) || rows.length < minimum) throw Object.assign(Error('Empty VAT source'), { code: 'VAT_SOURCE_EMPTY' });
    // Formula errors must never turn into a valid zero-stock snapshot.
    // Optional lookup/name cells can legitimately contain #N/A. Reject whole-tab formula
    // failures here; required numeric stock cells are validated separately below.
    if (isFormulaErrorSheet(rows)) {
      throw Object.assign(Error('VAT formula error'), { code: 'VAT_SOURCE_FORMULA' });
    }
    const old = previous && previous[sourceKey(tab)];
    const nonblank = values => values.filter(row => row.some(cell => String(cell ?? '').trim())).length;
    if (old && nonblank(rows) < nonblank(old) * .7) throw Object.assign(Error('VAT source shrank'), { code: 'VAT_SOURCE_SHRINK' });
  }
  const raw = tab => records[sourceKey({ spreadsheetId: vatConfig.spreadsheetId, ...tab })];
  const master = parseMasterData(raw(vatConfig.gopVatSheet), raw(vatConfig.khopMaSheet));
  if (master.errors.length || !master.stockRows.length || !master.mappingRows.length) {
    throw Object.assign(Error('Invalid VAT master'), { code: 'VAT_SOURCE_COLUMNS' });
  }
  const lookup = defaultLookupConfig();
  parseLookupRecords(Object.fromEntries(Object.entries(lookup.sheets)
    .map(([key, tab]) => [key, records[sourceKey({ spreadsheetId: lookup.spreadsheetId, ...tab })]])));
  // Validate both numeric stock columns for every identified VAT row; blanks remain unknown.
  const { toFloatOrNone } = require('../vatDraft/normalization');
  for (const row of raw(vatConfig.gopVatSheet).slice(1)) {
    if (!String(row[3] || '').trim()) continue;
    for (const i of [8, 14]) if (String(row[i] ?? '').trim() && toFloatOrNone(row[i]) === null) {
      throw Object.assign(Error('Invalid VAT stock'), { code: 'VAT_SOURCE_NUMBER' });
    }
  }
}

async function refreshVatSnapshot({ pool = getPool(), readValues = readSheetValuesById, pause = wait, now = Date.now } = {}) {
  const token = randomUUID();
  const claim = await pool.query(`UPDATE vat_sheet_snapshot
    SET lease_token = $1, lease_until = now() + interval '5 minutes', last_attempt_at = now()
    WHERE id = 1 AND next_attempt_at <= now() AND (lease_until IS NULL OR lease_until < now())
    RETURNING records, failures`, [token]);
  if (!claim.rows.length) return { status: 'not-due' };
  try {
    const records = {}, metadataCache = new Map();
    const nextByWorkbook = new Map();
    // Sequential reads and one metadata request per workbook in a refresh cycle.
    for (const tab of sources()) {
      const result = await fetchSheetRecordsWithFallback({
        source: tab, fallbackSource: tab.fallbackSource, sheetName: tab.label,
        minColumns: tab.minColumns || 0,
        logger: null,
        readValues: source => readValues(source, { metadataCache, beforeRequest: async () => {
          const remaining = (nextByWorkbook.get(source.spreadsheetId) || 0) - now();
          if (remaining > 0) await pause(remaining);
          nextByWorkbook.set(source.spreadsheetId, now() + 1000);
        } })
      });
      records[sourceKey(tab)] = result.records;
      if (result.usedFallback) (records.__fallbackTabs ||= []).push(tab.label);

    }
    validateRecords(records, claim.rows[0].records);
    const result = await pool.query(`UPDATE vat_sheet_snapshot SET records = $2::jsonb, loaded_at = now(),
      next_attempt_at = now() + interval '5 minutes', lease_token = NULL, lease_until = NULL,
      failures = 0, last_error = NULL WHERE id = 1 AND lease_token = $1 RETURNING id`, [token, JSON.stringify(records)]);
    return { status: result.rows.length ? 'updated' : 'lease-lost' };
  } catch (error) {
    // Do not expose sheet content, connection strings or service-account details in logs/state.
    const status = error.status || error.response?.status || (typeof error.code === 'number' ? error.code : null);
    const code = /^VAT_SOURCE_[A-Z_]+$/.test(String(error.code)) ? error.code
      : [403, 404, 429, 500, 502, 503, 504].includes(status) ? `VAT_SOURCE_HTTP_${status}` : 'VAT_SYNC_FAILED';
    const failures = Number(claim.rows[0].failures) + 1;
    const delay = Math.min(60 * 60 * 1000, FRESH_MS * (2 ** Math.min(failures - 1, 4))) + Math.floor(Math.random() * 1000);
    await pool.query(`UPDATE vat_sheet_snapshot SET lease_token = NULL, lease_until = NULL,
      failures = $2, last_error = $4, next_attempt_at = now() + $3 * interval '1 millisecond'
      WHERE id = 1 AND lease_token = $1`, [token, failures, delay, code]);
    return { status: 'failed', code };
  }
}
function startVatSnapshotSchedule() {
  let running = false, stopped = false;
  async function tick() {
    if (running || stopped || !CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON || !CONFIG.SUPABASE_DB_URL) return;
    running = true;
    try {
      const result = await refreshVatSnapshot();
      if (result.status === 'failed') console.warn(`[VatSnapshot] ${result.code}; retaining previous snapshot`);
    } catch (_) { console.warn('[VatSnapshot] VAT_SYNC_UNAVAILABLE'); }
    finally { running = false; }
  }
  const timer = setInterval(tick, 15000);
  timer.unref?.();
  tick();
  return { stop() { stopped = true; clearInterval(timer); } };
}
module.exports = { sources, validateRecords, refreshVatSnapshot, startVatSnapshotSchedule };
