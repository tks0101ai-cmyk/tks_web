'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { ensurePurchaseSchema } = require('../db/ensurePurchaseSchema');
const { seedSampleData, removeSampleData, ROWS, KEY_MIN, KEY_MAX } = require('./seedSampleData');

// Cung cach noi PGlite nhu ensurePurchaseSchema.test.js: exec cho DDL, query cho con lai.
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

test('sample data lands in the reserved key range and stays out of the real reconciliation range', async () => {
  const db = await freshDb();
  try {
    const pool = wrap(db), logger = { log() {} };
    const result = await seedSampleData({ pool, logger });
    assert.equal(result.rows, ROWS.length);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), ROWS.length);
    // Moi dong mau phai nam trong dai danh rieng, khong dong nao ra ngoai.
    const outside = await count(db, `SELECT count(*) FROM purchase_orders WHERE split_part(row_key,'.',1) NOT BETWEEN '${KEY_MIN}' AND '${KEY_MAX}'`);
    assert.equal(outside, 0, 'khong dong mau nao ra ngoai dai D90001-D99999');
    // Cont mau deu co tien to nhan biet duoc.
    assert.equal(await count(db, "SELECT count(*) FROM product_containers WHERE name NOT LIKE 'MẪU — %'"), 0);
  } finally { await db.close(); }
});

test('seeding does not switch the write source and leaves no immutable audit trail', async () => {
  const db = await freshDb();
  try {
    await seedSampleData({ pool: wrap(db), logger: { log() {} } });
    // Nguon ghi phai con la Sheets — seed khong duoc cham purchase_settings.
    assert.equal((await db.query('SELECT source_mode FROM purchase_settings')).rows[0].source_mode, 'sheets');
    // Khong dat purchase.operation_id nen trigger capture thoat som: khong co ban ghi
    // audit nao. Day la dieu kien de go lai duoc, vi audit Thu mua la bat bien.
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_operation_rows'), 0);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_operations'), 0);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_history'), 0);
  } finally { await db.close(); }
});

test('removing sample data restores an empty module and repeated runs stay idempotent', async () => {
  const db = await freshDb();
  try {
    const pool = wrap(db), logger = { log() {} };
    await seedSampleData({ pool, logger });
    // Chay lai khong tao ban trung.
    assert.equal((await seedSampleData({ pool, logger })).rows, 0);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), ROWS.length);
    const removed = await removeSampleData({ pool, logger });
    assert.equal(removed.rows, ROWS.length);
    assert.equal(await count(db, 'SELECT count(*) FROM purchase_orders'), 0);
    assert.equal(await count(db, 'SELECT count(*) FROM product_containers'), 0);
    // Go lan hai khong loi va khong xoa gi them.
    assert.equal((await removeSampleData({ pool, logger })).rows, 0);
  } finally { await db.close(); }
});

test('removing sample data never touches rows outside the reserved range', async () => {
  const db = await freshDb();
  try {
    const pool = wrap(db), logger = { log() {} };
    await seedSampleData({ pool, logger });
    // Mot dong "that" va mot cont "that" nam canh du lieu mau.
    await db.query(`INSERT INTO product_containers(name,name_key,status) VALUES('Cont that','cont that',2)`);
    await db.query(`INSERT INTO purchase_orders(row_key,root_key,product_code,product_name,qty_per_carton,carton_count)
                    VALUES('D00123','D00123','REAL','Hang that',10,5)`);
    await removeSampleData({ pool, logger });
    assert.equal(await count(db, "SELECT count(*) FROM purchase_orders WHERE row_key='D00123'"), 1, 'dong that con nguyen');
    assert.equal(await count(db, "SELECT count(*) FROM product_containers WHERE name='Cont that'"), 1, 'cont that con nguyen');
  } finally { await db.close(); }
});
