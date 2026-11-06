'use strict';

// Chay SQL THAT cua migration 0075 + job expectedRefresh + expectedRepository tren PGlite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { refreshExpected, requestExpectedRefresh, __test__ } = require('./expectedRefresh');
const { createExpectedRepository } = require('./expectedRepository');

const migration = file => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8');
const MIGRATIONS = ['0018_product_report.sql', '0053_product_containers.sql', '0072_product_container_unit_price_cny.sql', '0075_product_container_expected.sql', '0078_product_container_expected_prices.sql', '0086_product_container_other_note.sql'];
const quiet = () => {};

async function setup() {
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(migration(file));
  const pool = {
    query: (sql, params) => db.query(sql, params),
    connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} })
  };
  return { db, pool };
}

const LINE = `INSERT INTO product_container_lines
  (sheet_name, sheet_order, container_row, source_row, product_code, product_key, container_name, status, status_label, eta, color, sale_note, ordered_by, units_per_package, package_count, quantity)
  VALUES `;

async function seed(db) {
  await db.exec(`
    INSERT INTO product_report (product_code, product_name) VALUES ('SKU1', 'Ao thun'), ('Sku2', 'Quan jean');
    ${LINE}
      ('YIWU', 0, 1, 2, 'SKU1', 'sku1', 'CONT A', 1, '1.Chưa có lịch', 'DK THÁNG 10 BỐC', 'Đỏ', 'Gấp', 'An', 10, 5, 50),
      ('YIWU', 0, 1, 3, 'SKU2', 'sku2', 'CONT A', 1, '1.Chưa có lịch', 'DK THÁNG 10 BỐC', '', '', 'Bình', NULL, NULL, 7),
      ('SD', 1, 1, 2, 'NONAME', 'noname', 'CONT B', 3, '3.Đã bốc', '', '', '', '', 2, 4, 8.5);`);
}

test('CONT TKS1 keeps source and repeated rows through refresh/read; names use report and unchanged rows are not rewritten', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    await db.exec(`${LINE}
      ('CONT TKS1', 6, 2, 3, 'sku1', 'sku1', 'CONT TKS1', 1, '1.Chưa có lịch', '', '', '', '', 12, 15.3, 184),
      ('CONT TKS1', 6, 2, 4, 'sku1', 'sku1', 'CONT TKS1', 1, '1.Chưa có lịch', '', '', '', '', NULL, NULL, 2.5),
      ('CONT TKS1', 6, 5, 6, 'NONAME', 'noname', 'CONT TKS1', 4, '4.Đã về', '', '', '', '', NULL, NULL, 10);`);
    assert.equal((await refreshExpected(pool, { log: quiet })).written, 6);
    const repo = createExpectedRepository({ pool });
    const result = await repo.getExpected();
    assert.deepEqual(result.rows.map(r => r.sheetName), ['YIWU', 'YIWU', 'SD', 'CONT TKS1', 'CONT TKS1', 'CONT TKS1']);
    assert.deepEqual(result.rows.slice(3).map(r => [r.productName, r.quantity, r.scheduleLabel]), [
      ['Ao thun', 184, '1.Chưa có lịch'], ['Ao thun', 2.5, '1.Chưa có lịch'], ['', 10, '4.Đã về']
    ]);
    assert.equal(result.rows[3].packageCount, 15.3);
    const before = (await db.query('SELECT sheet_name, source_row, ctid::text AS tuple FROM product_container_expected ORDER BY sheet_order, source_row')).rows;
    const unchanged = await refreshExpected(pool, { log: quiet });
    assert.deepEqual([unchanged.status, unchanged.written, unchanged.deleted, unchanged.version], ['unchanged', 0, 0, 1]);
    assert.deepEqual((await db.query('SELECT sheet_name, source_row, ctid::text AS tuple FROM product_container_expected ORDER BY sheet_order, source_row')).rows, before);
  } finally { await db.close(); }
});

test('lan dau ghi du dong, ghep Lich = B + 1 dau cach + C (C rong khong thua dau cach), ten SP tu product_report', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    const result = await refreshExpected(pool, { log: quiet });
    assert.equal(result.status, 'updated');
    assert.equal(result.written, 3);
    const { rows } = await db.query('SELECT source_row, sheet_name, schedule_label, product_name FROM product_container_expected ORDER BY sheet_order, source_row');
    assert.deepEqual(rows.map(r => r.schedule_label), ['1.Chưa có lịch DK THÁNG 10 BỐC', '1.Chưa có lịch DK THÁNG 10 BỐC', '3.Đã bốc']);
    assert.deepEqual(rows.map(r => r.product_name), ['Ao thun', 'Quan jean', '']);
    const state = (await db.query('SELECT version::int AS version, row_count FROM product_container_expected_state')).rows[0];
    assert.deepEqual(state, { version: 1, row_count: 3 });
  } finally { await db.close(); }
});

test('lan hai ghi 0 dong, version giu nguyen; doi nguon thi chi ghi dong doi / them / xoa dong mat', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    await refreshExpected(pool, { log: quiet });
    const second = await refreshExpected(pool, { log: quiet });
    assert.equal(second.status, 'unchanged');
    assert.equal(second.written, 0);
    assert.equal(second.deleted, 0);
    assert.equal(second.version, 1);

    await db.exec(`UPDATE product_container_lines SET quantity = 60 WHERE source_row = 2 AND sheet_name = 'YIWU'`);
    const third = await refreshExpected(pool, { log: quiet });
    assert.equal(third.written, 1);
    assert.equal(third.version, 2);

    await db.exec(`DELETE FROM product_container_lines WHERE sheet_name = 'SD'; ${LINE} ('YIWU', 0, 4, 9, 'SKU1', 'sku1', 'CONT C', 2, '2.Chưa bốc', '', '', '', '', NULL, NULL, 1);`);
    const fourth = await refreshExpected(pool, { log: quiet });
    assert.equal(fourth.deleted, 1);
    assert.equal(fourth.written, 1);
    assert.equal(fourth.version, 3);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM product_container_expected')).rows[0].n, 3);

    // Doi ten SP trong product_report cung duoc bat kip.
    await db.exec(`UPDATE product_report SET product_name = 'Ao thun moi' WHERE product_code = 'SKU1'`);
    const fifth = await refreshExpected(pool, { log: quiet });
    assert.equal(fifth.written, 3 - 1); // 2 dong SKU1 (YIWU 2 va 9)
    assert.equal(fifth.version, 4);
  } finally { await db.close(); }
});

test('chot an toan: nguon rong thi giu nguyen bang dang co; bang rong + nguon rong thi khong loi', async () => {
  const { db, pool } = await setup();
  try {
    const first = await refreshExpected(pool, { log: quiet });
    assert.equal(first.status, 'unchanged');
    await seed(db);
    await refreshExpected(pool, { log: quiet });
    await db.exec('DELETE FROM product_container_lines');
    const result = await refreshExpected(pool, { log: quiet });
    assert.equal(result.status, 'empty-source');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM product_container_expected')).rows[0].n, 3);
  } finally { await db.close(); }
});

test('thieu migration 0075: requestExpectedRefresh nuot loi 42P01, loi khac cung khong nem ra', async () => {
  const CONFIG = require('../config');
  const previous = CONFIG.SUPABASE_DB_URL;
  CONFIG.SUPABASE_DB_URL = 'postgres://fixture';
  const db = new PGlite();
  try {
    const pool = { query: (s, p) => db.query(s, p), connect: async () => ({ query: (s, p) => db.query(s, p), release() {} }) };
    assert.equal(await requestExpectedRefresh(pool, { log: quiet }), null);
    const broken = { query() {}, connect: async () => ({ query: async () => { throw Object.assign(new Error('boom'), { code: 'XX000' }); }, release() {} }) };
    const originalError = console.error;
    console.error = quiet;
    try { assert.equal(await requestExpectedRefresh(broken, { log: quiet }), null); } finally { console.error = originalError; }
  } finally { CONFIG.SUPABASE_DB_URL = previous; await db.close(); }
});

test('repository: doc theo thu tu sheet, so la number, filters theo thu tu xuat hien, cache theo version, thieu bang => rong', async () => {
  const { db, pool } = await setup();
  try {
    const repo = createExpectedRepository({ pool });
    assert.deepEqual((await repo.getExpected()).rows, []);
    await seed(db);
    await refreshExpected(pool, { log: quiet });
    const data = await repo.getExpected();
    assert.equal(data.rows.length, 3);
    assert.equal(data.rows[0].productName, 'Ao thun');
    assert.equal(data.rows[0].quantity, 50);
    assert.equal(data.rows[1].unitsPerPackage, null);
    assert.equal(data.rows[2].quantity, 8.5);
    assert.deepEqual(data.filters, { containers: ['CONT A', 'CONT B'], statuses: ['1.Chưa có lịch', '3.Đã bốc'] });
    assert.equal(data.meta.rowCount, 3);
    assert.equal(data.meta.version, '1');
    assert.ok(data.meta.computedAt);
    // Cache: cung phien ban => cung doi tuong dong.
    assert.equal((await repo.getExpected()).rows, data.rows);
  } finally { await db.close(); }

  const bare = new PGlite();
  try {
    assert.deepEqual((await createExpectedRepository({ pool: bare }).getExpected()).meta, { computedAt: null, version: null, rowCount: 0 });
  } finally { await bare.close(); }
});

test('0078: gia tri ngay len / don gia CNY / gia VN di tu nguon, doi gia thi ghi lai dung 1 dong, status duoc map', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    await db.exec(`UPDATE product_container_lines SET listed_at = '15/10', unit_price_cny = 12.5, vietnam_price = 99000 WHERE sheet_name = 'YIWU' AND source_row = 2`);
    assert.equal((await refreshExpected(pool, { log: quiet })).written, 3);
    const repo = createExpectedRepository({ pool });
    const data = await repo.getExpected();
    assert.deepEqual([data.rows[0].status, data.rows[0].listedAt, data.rows[0].unitPriceCny, data.rows[0].vietnamPrice], [1, '15/10', 12.5, 99000]);
    assert.deepEqual([data.rows[1].listedAt, data.rows[1].unitPriceCny, data.rows[1].vietnamPrice], ['', null, null]);
    assert.equal(data.rows[2].status, 3);
    assert.equal((await refreshExpected(pool, { log: quiet })).written, 0);

    await db.exec(`UPDATE product_container_lines SET vietnam_price = 100000 WHERE sheet_name = 'YIWU' AND source_row = 2`);
    const changed = await refreshExpected(pool, { log: quiet });
    assert.deepEqual([changed.written, changed.version], [1, 2]);
    await db.exec(`UPDATE product_container_lines SET unit_price_cny = 13 WHERE sheet_name = 'YIWU' AND source_row = 3`);
    assert.equal((await refreshExpected(pool, { log: quiet })).written, 1);
  } finally { await db.close(); }
});

test('0078: VALUE_COLUMNS co 3 cot moi nen diff-write bat duoc doi', () => {
  for (const column of ['listed_at', 'unit_price_cny', 'vietnam_price']) {
    assert.ok(__test__.VALUE_COLUMNS.includes(column), column);
    assert.ok(__test__.STAGE_SQL.includes(`l.${column}`), column);
    assert.ok(__test__.UPSERT_SQL.includes(`t.${column}`), column);
  }
});

test('repository fail-soft khi chua ap 0078 (42703): doc cot cu, gia = null; refresh nuot 42703', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    await refreshExpected(pool, { log: quiet });
    await db.exec('ALTER TABLE product_container_expected DROP COLUMN listed_at, DROP COLUMN unit_price_cny, DROP COLUMN vietnam_price');
    const data = await createExpectedRepository({ pool }).getExpected();
    assert.equal(data.rows.length, 3);
    assert.deepEqual([data.rows[0].status, data.rows[0].listedAt, data.rows[0].unitPriceCny, data.rows[0].vietnamPrice], [1, '', null, null]);
    assert.equal(data.rows[0].quantity, 50);

    const CONFIG = require('../config');
    const previous = CONFIG.SUPABASE_DB_URL;
    CONFIG.SUPABASE_DB_URL = 'postgres://fixture';
    try { assert.equal(await requestExpectedRefresh(pool, { log: quiet }), null); } finally { CONFIG.SUPABASE_DB_URL = previous; }
  } finally { await db.close(); }
});


test('0086 other_note survives refresh/read and changing it writes only the changed row', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    await db.exec("UPDATE product_container_lines SET other_note = 'Ghi chú G' WHERE product_code = 'SKU1'");
    await refreshExpected(pool, { log: quiet });
    const repo = createExpectedRepository({ pool });
    assert.equal((await repo.getExpected()).rows[0].otherNote, 'Ghi chú G');
    await db.exec("UPDATE product_container_lines SET other_note = 'Đổi ghi chú' WHERE product_code = 'SKU1'");
    assert.equal((await refreshExpected(pool, { log: quiet })).written, 1);
    assert.equal((await repo.getExpected()).rows[0].otherNote, 'Đổi ghi chú');
    assert.equal((await refreshExpected(pool, { log: quiet })).written, 0);
  } finally { await db.close(); }
});

test('legacy purchase settings without 0117 keep both CONT and expected refresh working', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    await db.exec("CREATE TABLE purchase_settings (id integer PRIMARY KEY, source_mode text); INSERT INTO purchase_settings VALUES (1, 'sheets')");
    const { refreshContainers } = require('./sync');
    const { SHEET_NAMES } = require('./parser');
    const result = await refreshContainers({pool, spreadsheetId:'fixture', force:true, client:{listSheetTitles:async()=>SHEET_NAMES, getValues:async()=>[]}, logger:{info(){},error(){}}});
    assert.equal(result.status, 'held'); // source read succeeded; empty snapshot held by shrink guard
    assert.equal((await refreshExpected(pool, {log:quiet})).rows, 3);
  } finally { await db.close(); }
});
