'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { ensurePurchaseSchema } = require('../db/ensurePurchaseSchema');
const { importSourceRows, parseListedAt, statusOf } = require('./importSourceRows');

function wrap(db) {
  return { connect: async () => ({
    query: async (sql, params) => (/CREATE |ALTER |DROP |^--/.test(sql) ? (await db.exec(sql), { rowCount: 0 }) : db.query(sql, params)),
    release() {}
  }) };
}
async function freshDb() {
  const db = new PGlite();
  await db.exec("CREATE TABLE schema_migrations(filename text primary key);INSERT INTO schema_migrations VALUES('0109_stocktake_previous_cancel.sql')");
  await ensurePurchaseSchema({ pool: wrap(db), logger: { log() {} } });
  return db;
}
const count = async (db, sql) => Number((await db.query(sql)).rows[0].count);
function fixture(rows, conts) {
  const file = path.join(os.tmpdir(), 'purchase-src-' + rows.length + '-' + Math.abs(rows[0].rowKey.length * 7) + '.json');
  fs.writeFileSync(file, JSON.stringify({ conts: conts || [{ name: 'CONT CHỜ XẾP', status: '1.Chưa có lịch' }, { name: 'CONT 10-5V', status: '4.Đã về' }], rows }));
  return file;
}
const row = (over = {}) => Object.assign({
  rowKey: 'D00001', cont: 'CONT 10-5V', code: 'AC305', name: 'Băng dính',
  qtyPerCarton: 100, cartonCount: 10, unitPriceCny: 1.5, fxRate: 3650
}, over);

test('listed date: infers the year, keeps an explicit one, takes the first of a double entry', () => {
  const a = [];
  assert.equal(parseListedAt('24/09', 2026, a, 'D1').toISOString().slice(0, 10), '2026-09-24');
  assert.equal(parseListedAt('09/10/2026', 2026, a, 'D2').toISOString().slice(0, 10), '2026-10-09');
  assert.equal(a.length, 0, 'hai ca tren khong phai bat thuong');
  // O nguon co 13 dong ghi hai ngay dinh nhau; lay ngay dau va ghi lai de bao cao.
  assert.equal(parseListedAt('28/10+29/10', 2026, a, 'D3').toISOString().slice(0, 10), '2026-10-28');
  assert.equal(parseListedAt('6/10+10/10', 2026, a, 'D4').toISOString().slice(0, 10), '2026-10-06');
  assert.deepEqual(a.map(x => x.rowKey), ['D3', 'D4']);
  assert.equal(parseListedAt('', 2026, a, 'D5'), null);
  assert.equal(parseListedAt('khong phai ngay', 2026, a, 'D6'), null);
  assert.equal(a.at(-1).rowKey, 'D6', 'o khong doc duoc cung phai duoc ghi lai');
});

test('container status comes from the numeric prefix of the source label', () => {
  assert.equal(statusOf('1.Chưa có lịch'), 1);
  assert.equal(statusOf('3.Đã bốc'), 3);
  assert.equal(statusOf('4.Đã về'), 4);
  assert.equal(statusOf('khong ro'), 1, 'khong doc duoc thi ve chua co lich');
});

test('the sheet queue container becomes a null link instead of a fake container', async () => {
  const db = await freshDb();
  try {
    const file = fixture([row(), row({ rowKey: 'D00002', cont: 'CONT CHỜ XẾP' })]);
    const out = await importSourceRows({ pool: wrap(db), file, logger: { log() {} } });
    assert.equal(out.inserted, 2);
    assert.equal(out.queued, 1);
    // Chi cont that duoc tao — khong co dong nao ten "CONT CHO XEP".
    assert.equal(await count(db, 'SELECT count(*) FROM product_containers'), 1);
    assert.equal(await count(db, "SELECT count(*) FROM product_containers WHERE name LIKE '%CHỜ XẾP%'"), 0);
    assert.equal(await count(db, "SELECT count(*) FROM purchase_orders WHERE row_key='D00002' AND container_id IS NULL"), 1);
  } finally { await db.close(); }
});

test('negative prepaid freight survives the import after migration 0114', async () => {
  const db = await freshDb();
  try {
    const file = fixture([row({ freightPrepaid: -1101 })]);
    await importSourceRows({ pool: wrap(db), file, logger: { log() {} } });
    assert.equal(Number((await db.query('SELECT freight_prepaid FROM purchase_orders')).rows[0].freight_prepaid), -1101);
  } finally { await db.close(); }
});

test('rows breaking a column rule abort the whole import before anything is written', async () => {
  const db = await freshDb();
  try {
    const file = fixture([row(), row({ rowKey: 'D00002', cartonCount: 0 })]);
    await assert.rejects(importSourceRows({ pool: wrap(db), file, logger: { log() {} } }), /SOURCE_ROWS_INVALID|khong hop le/);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), 0, 'khong ghi dong nao');
  } finally { await db.close(); }
});

test('a second import needs --replace, and refuses once the write source is web', async () => {
  const db = await freshDb();
  try {
    const pool = wrap(db), logger = { log() {} }, file = fixture([row()]);
    await importSourceRows({ pool, file, logger });
    await assert.rejects(importSourceRows({ pool, file, logger }), /PURCHASE_NOT_EMPTY|dang co 1 dong/);
    const replaced = await importSourceRows({ pool, file, logger, replace: true });
    assert.equal(replaced.inserted, 1);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), 1, 'thay the chu khong nhan doi');

    await db.query("UPDATE purchase_settings SET source_mode='web' WHERE id=1");
    await assert.rejects(importSourceRows({ pool, file, logger, replace: true }), /PURCHASE_SOURCE_IS_WEB|Nguon ghi dang la web/);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), 1, 'khong xoa gi khi bi chan');
  } finally { await db.close(); }
});

test('a dry run reports the same shape without touching the database', async () => {
  const db = await freshDb();
  try {
    const file = fixture([row(), row({ rowKey: 'D00002', cont: 'CONT CHỜ XẾP', listedAt: '28/10+29/10' })]);
    const out = await importSourceRows({ pool: wrap(db), file, logger: { log() {} }, dryRun: true });
    assert.equal(out.rows, 2);
    assert.equal(out.queued, 1);
    assert.equal(out.containers, 1);
    assert.deepEqual(out.anomalies.map(a => a.rowKey), ['D00002']);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), 0);
  } finally { await db.close(); }
});
