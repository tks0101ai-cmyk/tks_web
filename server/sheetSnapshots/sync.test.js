'use strict';
process.env.JWT_SECRET ||= 'test-secret';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

// Chay SQL THAT cua migration 0064 + 0077 + job dong bo (sync.js) + createMeasureSheet tren PGlite.
// (2026-10-30: 2 nguon stock_locations_hn / stock_locations_sg da go cung module Vi tri hang doc Google Sheets; chi con CAN DO.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { SOURCES, refreshSource, startSheetSnapshotSchedule, __test__ } = require('./sync');
const { createMeasureSheet } = require('../shipment/measureSheet');

const MIGRATION = ['0064_sheet_snapshots.sql', '0077_invoice_price_audit.sql']
  .map(name => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', name), 'utf8')).join('\n');
const MEASURES = SOURCES.find(source => source.id === 'shipping_measures');
const quiet = { info() {}, error() {} };
const measureHeader = ['MÃ SP', 'TÊN SP', 'Mô tả', 'SL/T', 'Cân nặng', 'D', 'R', 'C', '', '', '', '', '', '', 'Cước 1 Sp\n(465/m³, 1367đ/kg)'];
const measureRow = (cells, freight) => [...cells, '', '', '', '', '', '', freight];

// Nguon co cau hinh gia de khong phu thuoc .env.
const withId = source => ({ ...source, spreadsheetId: () => 'fixture' });
const measures = withId(MEASURES);

async function setup() {
  const db = new PGlite();
  await db.exec(MIGRATION);
  const pool = { query: (sql, params) => db.query(sql, params), connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} }) };
  return { db, pool };
}

function sheet(valuesByTitle) {
  const reads = [];
  return {
    reads,
    listSheetTitles: async () => Object.keys(valuesByTitle),
    getValues: async (title, options) => { reads.push({ title, options }); return valuesByTitle[title]; }
  };
}

let clock = Date.parse('2026-10-17T03:00:00Z');
const at = minutes => () => new Date(clock + minutes * 60 * 1000);
const mrow = (code, perCarton, kg = 1) => measureRow([code, 'Hàng ' + code, '', perCarton, kg, 10, 10, 10], 5);
const codes = async pool => (await pool.query('SELECT code_key, per_carton FROM shipping_measures ORDER BY code_key')).rows.map(row => [row.code_key, Number(row.per_carton)]);

test('chi con nguon CAN DO: da go 2 nguon Vi tri hang cu (stock_locations_hn / stock_locations_sg)', () => {
  assert.deepEqual(SOURCES.map(source => source.id), ['shipping_measures']);
  assert.equal(SOURCES.some(source => /stock_locations/.test(source.id)), false);
  assert.equal(SOURCES.some(source => source.table === 'stock_location_lines'), false);
});

test('lan dau ghi du lieu, lan hai khong doi thi 0 dong ghi; sua/xoa/them dong chi dong do doi', async () => {
  __test__.pendingShrink.clear();
  const { pool } = await setup();
  const rows = [measureHeader, mrow('A1', 10), mrow('A2', 20), mrow('A1', 99)]; // A1 trung: lay hang dau
  const first = await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': rows }), now: at(0), logger: quiet });
  assert.deepEqual([first.status, first.inserted, first.deleted], ['updated', 2, 0]);

  const same = await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': rows }), now: at(10), logger: quiet });
  assert.deepEqual([same.status, same.inserted, same.deleted], ['unchanged', 0, 0]);

  const edited = [measureHeader, mrow('A1', 10), mrow('A2', 25), mrow('A3', 30)];
  const changed = await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': edited }), now: at(20), logger: quiet });
  assert.deepEqual([changed.status, changed.inserted, changed.deleted], ['updated', 2, 1]);
  assert.deepEqual(await codes(pool), [['a1', 10], ['a2', 25], ['a3', 30]]);
});

test('cho phep ten tab khac hoa/thuong va doc o che do UNFORMATTED_VALUE', async () => {
  __test__.pendingShrink.clear();
  const { pool } = await setup();
  const client = sheet({ 'cân đo': [measureHeader, mrow('A', 1)] });
  const result = await refreshSource(measures, { pool, client, now: at(0), logger: quiet });
  assert.equal(result.status, 'updated');
  assert.deepEqual(client.reads, [{ title: 'cân đo', options: { valueRenderOption: 'UNFORMATTED_VALUE' } }]);
});

test('chua den han hoac khoa dang giu thi KHONG goi Google', async () => {
  __test__.pendingShrink.clear();
  const { db, pool } = await setup();
  await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': [measureHeader, mrow('A', 1)] }), now: at(0), logger: quiet });
  let reads = 0;
  const spy = { listSheetTitles: async () => { reads++; return ['CÂN ĐO']; }, getValues: async () => [] };
  const early = await refreshSource(measures, { pool, client: spy, now: at(1), logger: quiet });
  assert.equal(early.status, 'not-due');
  const busyPool = { connect: async () => ({ query: async (sql, params) => (sql.includes('pg_try_advisory_lock') ? { rows: [{ locked: false }] } : db.query(sql, params)), release() {} }) };
  assert.equal((await refreshSource(measures, { pool: busyPool, client: spy, now: at(60), logger: quiet })).status, 'busy');
  assert.equal(reads, 0);
});

test('loi Google/sheet mat: giu nguyen du lieu cu, ghi thong bao an toan (khong lo chi tiet) va mo khoa', async () => {
  __test__.pendingShrink.clear();
  const { db, pool } = await setup();
  await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': [measureHeader, mrow('A', 1)] }), now: at(0), logger: quiet });
  const boom = { listSheetTitles: async () => { throw Object.assign(new Error('secret token abc'), { code: 403 }); }, getValues: async () => [] };
  assert.equal((await refreshSource(measures, { pool, client: boom, now: at(20), logger: quiet })).status, 'failed');
  const missing = await refreshSource(measures, { pool, client: sheet({ 'Khác': [] }), now: at(40), logger: quiet });
  assert.equal(missing.status, 'failed');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM shipping_measures')).rows[0].n, 1);
  const state = (await db.query('SELECT last_error, last_success_at FROM sheet_snapshot_sync WHERE source = $1', ['shipping_measures'])).rows[0];
  assert.ok(state.last_error && !/secret/.test(state.last_error));
  // Khoa advisory da duoc nha: lan chay sau van lay duoc khoa; thanh cong thi xoa loi.
  const retry = await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': [measureHeader, mrow('A', 2)] }), now: at(60), logger: quiet });
  assert.equal(retry.status, 'updated');
  assert.equal((await db.query('SELECT last_error FROM sheet_snapshot_sync WHERE source = $1', ['shipping_measures'])).rows[0].last_error, null);
});

test('so dong tut >30%: giu ban cu o lan dau, chi chap nhan khi lan doc ke tiep cho cung ket qua', async () => {
  __test__.pendingShrink.clear();
  const { pool } = await setup();
  const big = [measureHeader, ...Array.from({ length: 10 }, (_, index) => mrow(`C${index}`, 1))];
  await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': big }), now: at(0), logger: quiet });
  const small = [measureHeader, mrow('C0', 1)];
  const held = await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': small }), now: at(20), logger: quiet });
  assert.equal(held.status, 'held');
  assert.equal((await codes(pool)).length, 10);
  const accepted = await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': small }), now: at(40), logger: quiet });
  assert.equal(accepted.status, 'updated');
  assert.equal((await codes(pool)).length, 1);
});

test('CAN DO: luu m3/kg moi cai, lay hang dau khi trung ma, doc lai qua createMeasureSheet', async () => {
  __test__.pendingShrink.clear();
  const { pool } = await setup();
  const values = [measureHeader, measureRow(['10GFED', 'Đèn', '', 280, 30.5, 81, 60, 70], 384), measureRow(['10gfed', 'Trùng', '', 1, 1, 1, 1, 1], 5), measureRow(['THIEU', '', '', 10, 5, 40, 30, ''], '')];
  const client = sheet({ 'CÂN ĐO': values });
  const first = await refreshSource(measures, { pool, client, now: at(0), logger: quiet });
  assert.deepEqual([first.status, first.inserted], ['updated', 2]);
  assert.deepEqual(client.reads, [{ title: 'CÂN ĐO', options: { valueRenderOption: 'UNFORMATTED_VALUE' } }]);
  assert.equal((await refreshSource(measures, { pool, client, now: at(10), logger: quiet })).status, 'unchanged');
  const stored = await pool.query('SELECT code_key, freight_per_unit FROM shipping_measures ORDER BY code_key');
  assert.deepEqual(stored.rows, [{ code_key: '10gfed', freight_per_unit: '384' }, { code_key: 'thieu', freight_per_unit: null }]);
  const lookup = await createMeasureSheet({ getDb: () => pool, now: () => clock }).lookup(['10GFED', 'thieu', 'khong']);
  assert.deepEqual([...lookup.keys()].sort(), ['10gfed', 'thieu']);
  const lamp = lookup.get('10gfed');
  assert.equal(lamp.perCarton, 280);
  assert.ok(Math.abs(lamp.m3PerUnit - (81 * 60 * 70 / 1e6) / 280) < 1e-12);
  assert.ok(Math.abs(lamp.kgPerUnit - 30.5 / 280) < 1e-12);
  assert.deepEqual([lookup.get('thieu').m3PerUnit, lookup.get('thieu').missingVolume, lookup.get('thieu').kgPerUnit], [null, true, 0.5]);
});

test('CAN DO: cot O sai tieu de -> van dong bo m3/kg, cuoc NULL, ghi freight_error; sua lai thi xoa loi', async () => {
  __test__.pendingShrink.clear();
  const { pool } = await setup();
  const badHeader = [...measureHeader]; badHeader[14] = 'Ghi chú';
  const rows = [measureRow(['10GFED', 'Đèn', '', 280, 30.5, 81, 60, 70], 384)];
  const first = await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': [badHeader, ...rows] }), now: at(0), logger: quiet });
  assert.equal(first.status, 'updated');
  const stored = await pool.query('SELECT code_key, per_carton, freight_per_unit FROM shipping_measures');
  assert.deepEqual(stored.rows, [{ code_key: '10gfed', per_carton: '280', freight_per_unit: null }]);
  const state = (await pool.query("SELECT last_success_at, last_error, freight_error FROM sheet_snapshot_sync WHERE source = 'shipping_measures'")).rows[0];
  assert.ok(state.last_success_at);
  assert.equal(state.last_error, null);
  assert.match(state.freight_error, /cột O/);
  await refreshSource(measures, { pool, client: sheet({ 'CÂN ĐO': [measureHeader, ...rows] }), now: at(10), logger: quiet });
  const fixed = (await pool.query("SELECT freight_error FROM sheet_snapshot_sync WHERE source = 'shipping_measures'")).rows[0];
  assert.equal(fixed.freight_error, null);
  assert.equal((await pool.query('SELECT freight_per_unit FROM shipping_measures')).rows[0].freight_per_unit, '384');
});

test('khong cau hinh spreadsheet thi bo qua, khong ket noi DB', async () => {
  let connected = 0;
  const result = await refreshSource({ ...measures, spreadsheetId: () => null }, { pool: { connect: async () => { connected++; } }, logger: quiet });
  assert.equal(result.status, 'disabled');
  assert.equal(connected, 0);
});

test('scheduler chay moi nguon rieng theo intervalMs, bo nguon chua cau hinh, co the dung', async () => {
  const calls = [];
  const timers = [];
  let cleared = 0;
  const unconfigured = { ...measures, id: 'khac', spreadsheetId: () => null };
  const runtime = startSheetSnapshotSchedule({
    sources: [measures, unconfigured],
    refresh: async source => { calls.push(source.id); },
    setTimeoutFn: (callback, ms) => { timers.push({ callback, ms }); return { unref() {} }; },
    clearTimeoutFn: () => { cleared++; },
    logger: quiet
  });
  await runtime.ready;
  assert.deepEqual(calls, ['shipping_measures']);
  assert.deepEqual(timers.map(timer => timer.ms), [measures.intervalMs]);
  await timers[0].callback();
  assert.equal(calls.length, 2);
  runtime.stop();
  assert.equal(cleared, 1);
});

test('scheduler tiep tuc theo nextAttemptAt da luu thay vi cho tron mot chu ky', async () => {
  let delay;
  const runtime = startSheetSnapshotSchedule({
    sources: [measures], now: () => 1000,
    refresh: async () => ({ status: 'not-due', nextAttemptAt: 1600 }),
    setTimeoutFn: (callback, ms) => { delay = ms; return {}; }, clearTimeoutFn() {}, logger: quiet
  });
  await runtime.ready;
  assert.equal(delay, 600);
  runtime.stop();
});
