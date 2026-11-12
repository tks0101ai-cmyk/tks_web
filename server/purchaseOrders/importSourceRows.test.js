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

test('negative prepaid freight survives the import after migration 0115', async () => {
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

test('an impossible calendar date is reported, not silently rolled over', () => {
  const a = [];
  // Date.UTC(2026,1,31) tu thanh 03/03/2026 — ban chup phai bao chu khong doi ngay.
  assert.equal(parseListedAt('31/02/2026', 2026, a, 'D7'), null);
  assert.deepEqual(a.map(x => [x.rowKey, x.reason]), [['D7', 'NGAY_KHONG_TON_TAI']]);
  assert.equal(parseListedAt('29/02/2024', 2026, a, 'D8').toISOString().slice(0, 10), '2024-02-29', 'nam nhuan that van nhan');
  assert.equal(parseListedAt('31/13/2026', 2026, a, 'D9'), null, 'thang 13 khong khop khuon dang');
});

test('the key sequence is pushed past the imported keys so the next key is free', async () => {
  const db = await freshDb();
  try {
    const file = fixture([row({ rowKey: 'D00001' }), row({ rowKey: 'D00141' }), row({ rowKey: 'D00141.01' })]);
    const out = await importSourceRows({ pool: wrap(db), file, logger: { log() {} } });
    assert.equal(out.keySeq, 141, 'khoa goc lon nhat la D00141, nhanh .01 khong tinh rieng');
    // Khoa cap tiep theo phai la D00142: truoc khi sua, nextval tra 1 -> D00001 da ton tai.
    const next = 'D' + String((await db.query("SELECT nextval('purchase_order_key_seq')::int AS v")).rows[0].v).padStart(5, '0');
    assert.equal(next, 'D00142');
    assert.equal(await count(db, `SELECT count(*) FROM purchase_orders WHERE row_key='${next}'`), 0);
  } finally { await db.close(); }
});

test('a repeated active source key is ignored by the partial active-row index', async () => {
  const db = await freshDb();
  try {
    const file = fixture([row(), row({ productName: 'Băng dính trùng' })]);
    const out = await importSourceRows({ pool: wrap(db), file, logger: { log() {} } });
    assert.equal(out.inserted, 1);
    assert.equal(await count(db, "SELECT count(*) FROM purchase_orders WHERE row_key='D00001' AND deleted_at IS NULL"), 1);
  } finally { await db.close(); }
});

test('the sequence is never pulled back below a key already issued', async () => {
  const db = await freshDb();
  try {
    await db.query("SELECT setval('purchase_order_key_seq', 900)");
    const out = await importSourceRows({ pool: wrap(db), file: fixture([row({ rowKey: 'D00005' })]), logger: { log() {} } });
    assert.equal(out.keySeq, 900, 'khong tai su dung khoa da phat');
  } finally { await db.close(); }
});

test('imported containers carry the same name_key the service writes, so duplicate names stay blocked', async () => {
  const db = await freshDb();
  try {
    const { normalizeName } = require('./containerNames');
    const file = fixture([row({ cont: 'CONT BẾP GA' })], [{ name: 'CONT BẾP GA', status: '2.Chưa bốc' }]);
    await importSourceRows({ pool: wrap(db), file, logger: { log() {} } });
    const cont = (await db.query('SELECT name,name_key FROM product_containers')).rows[0];
    assert.equal(cont.name_key, normalizeName('CONT BẾP GA'));
    // Dung duong ghi cua web: ten tuong duong phai vap UNIQUE(name_key).
    await assert.rejects(
      db.query('INSERT INTO product_containers(name,name_key) VALUES($1,$2)', ['cont  bếp ga', normalizeName('cont  bếp ga')]),
      /duplicate key|unique/i
    );
  } finally { await db.close(); }
});

test('a container already on the database is reused instead of duplicated by the import', async () => {
  const db = await freshDb();
  try {
    // Dong cu con mang name_key kieu lower(btrim) tu lan nap truoc.
    await db.query("INSERT INTO product_containers(name,name_key,status) VALUES('CONT BẾP GA','cont bếp ga',1)");
    const file = fixture([row({ cont: 'CONT BẾP GA' })], [{ name: 'CONT BẾP GA', status: '4.Đã về' }]);
    await importSourceRows({ pool: wrap(db), file, logger: { log() {} } });
    const conts = (await db.query('SELECT id,name_key,status FROM product_containers')).rows;
    assert.equal(conts.length, 1, 'khong tao ban trung');
    assert.equal(conts[0].status, 4, 'trang thai lay theo ban chup');
    assert.equal(conts[0].name_key, require('./containerNames').normalizeName('CONT BẾP GA'), 'key cu duoc dua ve chuan');
    assert.equal(await count(db, `SELECT count(*) FROM purchase_orders WHERE container_id=${conts[0].id}`), 1);
  } finally { await db.close(); }
});

test('two legacy containers that normalize to one name stop the import instead of merging', async () => {
  const db = await freshDb();
  try {
    await db.query("INSERT INTO product_containers(name,name_key,status) VALUES('CONT BẾP GA','cont bếp ga',1),('CONT BẾPGA','cont bếpga',2)");
    const file = fixture([row({ cont: 'CONT BẾP GA' })], [{ name: 'CONT BẾP GA', status: '4.Đã về' }]);
    await assert.rejects(importSourceRows({ pool: wrap(db), file, logger: { log() {} } }), /CONTAINER_NAME_AMBIGUOUS|ten tuong duong/);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), 0, 'khong ghi dong nao');
    assert.equal(await count(db, 'SELECT count(*) FROM product_containers'), 2, 'khong gop, khong doi ten');
  } finally { await db.close(); }
});

test('the source sheet and row are recorded, and summarised per sheet', async () => {
  const db = await freshDb();
  try {
    const file = fixture([
      row({ rowKey: 'D00001', sheet: 'YIWU', row: 12 }),
      row({ rowKey: 'D00002', sheet: 'YIWU', row: 13 }),
      row({ rowKey: 'D00003', sheet: 'CONT TKS1', row: 4 })
    ]);
    const out = await importSourceRows({ pool: wrap(db), file, logger: { log() {} } });
    assert.deepEqual(out.bySheet, { YIWU: 2, 'CONT TKS1': 1 });
    const rows = (await db.query('SELECT row_key,source_sheet,source_row FROM purchase_orders ORDER BY row_key')).rows;
    assert.deepEqual(rows.map(r => [r.row_key, r.source_sheet, Number(r.source_row)]),
      [['D00001', 'YIWU', 12], ['D00002', 'YIWU', 13], ['D00003', 'CONT TKS1', 4]]);
  } finally { await db.close(); }
});

test('a snapshot without source fields still loads, leaving the source null', async () => {
  const db = await freshDb();
  try {
    const out = await importSourceRows({ pool: wrap(db), file: fixture([row()]), logger: { log() {} } });
    assert.deepEqual(out.bySheet, { '(khong ro nguon)': 1 });
    const r = (await db.query('SELECT source_sheet,source_row FROM purchase_orders')).rows[0];
    assert.equal(r.source_sheet, null);
    assert.equal(r.source_row, null);
  } finally { await db.close(); }
});

test('the same source position twice in one file stops the import before writing', async () => {
  const db = await freshDb();
  try {
    const file = fixture([row({ rowKey: 'D00001', sheet: 'SD', row: 7 }), row({ rowKey: 'D00002', sheet: 'SD', row: 7 })]);
    await assert.rejects(importSourceRows({ pool: wrap(db), file, logger: { log() {} } }),
      error => error.code === 'SOURCE_POSITION_DUPLICATE' && /SD#7/.test(error.message));
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), 0, 'khong ghi dong nao');
  } finally { await db.close(); }
});

test('the database refuses the same source position across two imports', async () => {
  const db = await freshDb();
  try {
    const pool = wrap(db), logger = { log() {} };
    await importSourceRows({ pool, file: fixture([row({ rowKey: 'D00001', sheet: 'GDONG', row: 9 })]), logger });
    // Index 0118 la chot cuoi: dong tay cung vi tri nguon phai bi tu choi.
    await assert.rejects(
      db.query("INSERT INTO purchase_orders(row_key,root_key,product_code,product_name,qty_per_carton,carton_count,source_sheet,source_row) VALUES('D00009','D00009','X','Hang X',1,1,'GDONG',9)"),
      /duplicate key|unique/i
    );
    // Hai dong khong co nguon thi khong bi rang buoc.
    await db.query("INSERT INTO purchase_orders(row_key,root_key,product_code,product_name,qty_per_carton,carton_count) VALUES('D00010','D00010','X','Hang X',1,1),('D00011','D00011','Y','Hang Y',1,1)");
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), 3);
  } finally { await db.close(); }
});
