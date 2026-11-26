'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PGlite } = require('@electric-sql/pglite');
const { refreshVatSnapshot, sources, validateRecords } = require('./sync');
const { sourceKey, createSnapshotReader } = require('./source');
const config = require('../vatDraft/vatDraftConfig');

function fixture() {
  const records = {};
  for (const source of sources()) {
    let rows;
    if (String(source.sheetId) === String(config.gopVatSheet.sheetId)) {
      const header = Array(16).fill('');
      for (const [name, letter] of Object.entries(config.gopVatColumns)) header[letter.charCodeAt(0) - 65] = name;
      header[0] = 'CTY';
      const row = Array(16).fill('');
      Object.assign(row, { 0: 'CTY A', 1: 'SP1', 3: 'VAT1', 4: 'VAT product', 6: 'Cái', 8: '1,000', 9: '10', 14: '700' });
      rows = [header, row];
    } else if (String(source.sheetId) === String(config.khopMaSheet.sheetId)) {
      const header = Array(11).fill('');
      for (const [name, letter] of Object.entries(config.khopMaColumns)) header[letter.charCodeAt(0) - 65] = name;
      rows = [Array(11).fill(''), header, ['SP1', 'Product', '', '', '', '', '', '', '', 'VAT1', 'VAT product']];
    } else rows = [['TRẠNG THÁI', 'CONT', 'mã kiot', 'tên kiot', ''], ['1. Chờ khai', 'C1', 'SP1', 'Product', '20']];
    records[sourceKey(source)] = rows;
  }
  return records;
}
async function database() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(require('node:path').join(__dirname, '../db/migrations/0146_vat_sheet_snapshot.sql'), 'utf8'));
  return db;
}
test('worker persists complete bundle, gates concurrent refresh and manual cooldown', async () => {
  const db = await database();
  try {
    const records = fixture();
    let calls = 0;
    const readValues = async source => { calls++; return records[sourceKey(source)]; };
    const results = await Promise.all([refreshVatSnapshot({ pool: db, readValues, pause: async () => {} }), refreshVatSnapshot({ pool: db, readValues, pause: async () => {} })]);
    assert.deepEqual(results.map(r => r.status).sort(), ['not-due', 'updated']);
    assert.equal(calls, sources().length);
    const reader = createSnapshotReader({ pool: db });
    assert.equal((await reader.get()).stale, false);
    await reader.get({ forceRefresh: true });
    assert.equal((await refreshVatSnapshot({ pool: db, readValues })).status, 'not-due');
    assert.equal(calls, sources().length);
  } finally { await db.close(); }
});
test('failed/formula refresh retains previous stock and persists retry backoff', async () => {
  const db = await database();
  try {
    const records = fixture();
    const readValues = async source => records[sourceKey(source)];
    assert.equal((await refreshVatSnapshot({ pool: db, readValues, pause: async () => {} })).status, 'updated');
    const before = (await db.query('SELECT records FROM vat_sheet_snapshot')).rows[0].records;
    await db.query("UPDATE vat_sheet_snapshot SET next_attempt_at = now() - interval '1 second'");
    records[sourceKey({ spreadsheetId: config.spreadsheetId, ...config.gopVatSheet })][1][14] = '#REF!';
    assert.equal((await refreshVatSnapshot({ pool: db, readValues, pause: async () => {} })).status, 'failed');
    const after = (await db.query('SELECT * FROM vat_sheet_snapshot')).rows[0];
    assert.deepEqual(after.records, before);
    assert.equal(after.failures, 1);
    assert.ok(new Date(after.next_attempt_at) > new Date());
    assert.equal((await createSnapshotReader({ pool: db }).get()).stale, true);
    await createSnapshotReader({ pool: db }).get({ forceRefresh: true });
    assert.equal((await refreshVatSnapshot({ pool: db, readValues })).status, 'not-due');
  } finally { await db.close(); }
});
test('validation rejects source loss and malformed stock instead of replacing snapshot', () => {
  const data = fixture();
  assert.doesNotThrow(() => validateRecords(data));
  const previous = JSON.parse(JSON.stringify(data));
  const key = sourceKey({ spreadsheetId: config.spreadsheetId, ...config.gopVatSheet });
  previous[key].push(...Array.from({ length: 8 }, () => previous[key][1]));
  assert.throws(() => validateRecords(data, previous), { code: 'VAT_SOURCE_SHRINK' });
  data[key][1][8] = 'bad';
  assert.throws(() => validateRecords(data), { code: 'VAT_SOURCE_NUMBER' });
});

test('blank stock cells stay unknown while optional lookup #N/A does not invalidate usable stock', () => {
  const data = fixture();
  const key = sourceKey({ spreadsheetId: config.spreadsheetId, ...config.gopVatSheet });
  const unknown = [...data[key][1]];
  unknown[3] = 'VAT2'; unknown[8] = ''; unknown[14] = ''; unknown[4] = '#N/A';
  data[key].push(unknown);
  assert.doesNotThrow(() => validateRecords(data));
  const { parseStockSnapshot, defaultStockConfig, lookupVatStock } = require('../vatRequests/stockSource');
  const stock = parseStockSnapshot(data[key], data[sourceKey({spreadsheetId:config.spreadsheetId,...config.khopMaSheet})], defaultStockConfig());
  assert.equal(lookupVatStock(stock,'VAT2').available,null);
});
test('all default VAT consumers share one DB read and the worker snapshot age, never Google', async () => {
  const db = await database();
  try {
    let googleReads = 0, databaseReads = 0;
    const data = fixture();
    await refreshVatSnapshot({ pool: db, readValues: async tab => { googleReads++; return data[sourceKey(tab)]; }, pause: async () => {} });
    const pool = { query(sql, args) { if (sql.startsWith('SELECT')) databaseReads++; return db.query(sql, args); } };
    const master = require('../vatDraft/sheetsSource').createMasterDataSource({ pool });
    const lookup = require('../vatLookup/lookupSource').createLookupSource({ pool });
    const stockModule = require('../vatRequests/stockSource');
    const stock = stockModule.createStockSource({ pool });
    const results = await Promise.all([master.get(), lookup.get(), stock.get()]);
    assert.equal(databaseReads, 1);
    assert.equal(googleReads, sources().length);
    assert.equal(new Set(results.map(snapshot => snapshot.loadedAt)).size, 1);
    const paired = stockModule.lookupVatStock(results[2], 'sp1');
    assert.equal(paired.actual, 1000);
    assert.equal(paired.available, 700);
    assert.equal(paired.byCompany[0].company, 'CTY A');
    assert.equal(results[0].stockRows[0].tonCoTheNhap, 700);
    assert.ok(results[1].products.length);
    await master.refresh(); await lookup.refresh();
    assert.equal(googleReads, sources().length);
  } finally { await db.close(); }
});

test('expired worker lease can be recovered and an obsolete worker cannot publish', async () => {
  const db = await database();
  try {
    await db.query("UPDATE vat_sheet_snapshot SET lease_token = '00000000-0000-0000-0000-000000000001', lease_until = now() - interval '1 second'");
    const data = fixture();
    assert.equal((await refreshVatSnapshot({ pool: db, readValues: async tab => data[sourceKey(tab)], pause: async () => {} })).status, 'updated');
    await db.query("UPDATE vat_sheet_snapshot SET next_attempt_at = now() - interval '1 second'");
    let first = true;
    const result = await refreshVatSnapshot({ pool: db, pause: async () => {}, readValues: async tab => {
      if (first) {
        first = false;
        await db.query("UPDATE vat_sheet_snapshot SET lease_token = '00000000-0000-0000-0000-000000000002'");
      }
      return data[sourceKey(tab)];
    } });
    assert.equal(result.status, 'lease-lost');
  } finally { await db.close(); }
});


test('worker preserves intermediary fallback and publishes provenance to all consumers', async () => {
  const db = await database();
  try {
    const data = fixture(), tabs = sources(), calls = [];
    const gop = tabs.find(tab => String(tab.sheetId) === String(config.gopVatSheet.sheetId));
    const result = await refreshVatSnapshot({ pool: db, pause: async () => {}, readValues: async tab => {
      calls.push(sourceKey(tab));
      if (sourceKey(tab) === sourceKey(gop)) return [['#REF!']];
      if (sourceKey(tab) === sourceKey(gop.fallbackSource)) return data[sourceKey(gop)];
      return data[sourceKey(tab)];
    } });
    assert.equal(result.status, 'updated');
    assert.ok(calls.includes(sourceKey(gop.fallbackSource)));
    const pool = { query: (sql, args) => db.query(sql, args) };
    const consumers = [require('../vatDraft/sheetsSource').createMasterDataSource({ pool }),
      require('../vatLookup/lookupSource').createLookupSource({ pool }),
      require('../vatRequests/stockSource').createStockSource({ pool })];
    for (const source of consumers) assert.deepEqual((await source.get()).fallbackTabs, ['Gộp VAT']);
    const before = (await db.query('SELECT records, loaded_at FROM vat_sheet_snapshot')).rows[0];
    await db.query("UPDATE vat_sheet_snapshot SET next_attempt_at = now() - interval '1 second'");
    assert.equal((await refreshVatSnapshot({ pool: db, pause: async () => {}, readValues: async () => [['#REF!']] })).status, 'failed');
    const after = (await db.query('SELECT records, loaded_at FROM vat_sheet_snapshot')).rows[0];
    assert.deepEqual(after, before);
  } finally { await db.close(); }
});
