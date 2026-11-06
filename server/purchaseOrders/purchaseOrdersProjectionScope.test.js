'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { ensurePurchaseSchema } = require('../db/ensurePurchaseSchema');
const { projectContainers } = require('./purchaseOrdersProjection');

function wrap(db) {
  return { connect: async () => ({
    query: async (sql, params) => (/CREATE |ALTER |DROP |^--/.test(sql) ? (await db.exec(sql), { rowCount: 0 }) : db.query(sql, params)),
    release() {}
  }) };
}
// projectContainers luon chay trong transaction cua service — ban chieu la TEMP
// TABLE ... ON COMMIT DROP nen ngoai transaction se bi bo ngay sau khi tao.
const client = db => ({ query: (sql, params) => (/CREATE TEMP|^--/.test(sql) ? db.exec(sql).then(() => ({ rowCount: 0 })) : db.query(sql, params)) });
async function project(db) {
  await db.exec('BEGIN');
  try { await projectContainers(client(db)); await db.exec('COMMIT'); }
  catch (error) { await db.exec('ROLLBACK').catch(() => {}); throw error; }
}

// Read model dung chung do cac migration cu tao ra; ensurePurchaseSchema khong ap chung.
// 0018 tao product_report — expectedRefresh.STAGE_SQL doc bang nay.
const BASE = ['0018_product_report.sql', '0053_product_containers.sql', '0072_product_container_unit_price_cny.sql',
  '0075_product_container_expected.sql', '0078_product_container_expected_prices.sql', '0086_product_container_other_note.sql'];
async function baseDb() {
  const fs = require('node:fs'), path = require('node:path');
  const db = new PGlite();
  await db.exec("CREATE TABLE schema_migrations(filename text primary key);INSERT INTO schema_migrations VALUES('0109_stocktake_previous_cancel.sql')");
  for (const name of BASE) await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8'));
  await ensurePurchaseSchema({ pool: wrap(db), logger: { log() {} } });
  return db;
}

async function seeded({ ownsAll = false } = {}) {
  const db = await baseDb();
  await db.query('UPDATE purchase_settings SET projection_owns_all=$1 WHERE id=1', [ownsAll]);
  // Mot cont Thu mua so huu, va mot dong cho xep chua xep cont.
  const { rows } = await db.query(`INSERT INTO product_containers(name,name_key,status) VALUES('CONT 10-5V','cont 10-5v',4) RETURNING id`);
  await db.query(`INSERT INTO purchase_orders(row_key,root_key,container_id,product_code,product_name,qty_per_carton,carton_count)
                  VALUES('D00001','D00001',$1,'AC305','Băng dính',10,5)`, [rows[0].id]);
  await db.query(`INSERT INTO purchase_orders(row_key,root_key,container_id,product_code,product_name,qty_per_carton,carton_count)
                  VALUES('D00002','D00002',NULL,'TH808','Thùng nhựa',2,8)`);
  // Read model cu: mot dong cung cont ma Thu mua so huu, mot dong cont khac,
  // mot dong hang doi cua sheet khac.
  const legacy = (sheet, order, cont, code) =>
    db.query(`INSERT INTO product_container_lines(sheet_name,sheet_order,container_row,source_row,product_code,product_key,container_name,status,status_label,quantity)
              VALUES($1,$2,1,$2,$3,lower($3),$4,4,'4.Đã về',1)`, [sheet, order, code, cont]);
  await legacy('VK-DUNG', 901, 'CONT 10-5V', 'OLD1');
  await legacy('YIWU', 902, 'CONT 7-8Y', 'OLD2');
  await legacy('GDONG', 903, 'CONT CHỜ XẾP', 'OLD3');
  return db;
}
const names = async db => (await db.query('SELECT sheet_name,container_name,product_code FROM product_container_lines ORDER BY sheet_name,product_code')).rows
  .map(r => `${r.sheet_name}/${r.container_name}/${r.product_code}`);

test('partial scope replaces only the containers purchase owns and leaves other sheets alone', async () => {
  const db = await seeded({ ownsAll: false });
  try {
    await project(db);
    const out = await names(db);
    // Dong VK-DUNG cua CONT 10-5V bi thay the vi Thu mua so huu cont do.
    assert.ok(!out.some(x => x.startsWith('VK-DUNG/')), 'cont Thu mua so huu: ban cu phai bi thay');
    assert.ok(out.includes('THU MUA/CONT 10-5V/AC305'), 'ban moi phai co mat');
    // Cont cua sheet khac va hang doi cu giu nguyen.
    assert.ok(out.includes('YIWU/CONT 7-8Y/OLD2'), 'cont sheet khac phai con');
    assert.ok(out.includes('GDONG/CONT CHỜ XẾP/OLD3'), 'hang doi cu phai con');
    // Hang doi cua Thu mua khong day sang — tranh dem doi voi hang doi cu.
    assert.ok(!out.some(x => x.includes('TH808')), 'dong cho xep cua Thu mua khong vao read model dung chung');
    assert.equal(out.length, 3);
  } finally { await db.close(); }
});

test('full scope makes purchase the only source and clears every other sheet', async () => {
  const db = await seeded({ ownsAll: true });
  try {
    await project(db);
    const out = await names(db);
    assert.ok(out.every(x => x.startsWith('THU MUA/')), 'khong con dong cua sheet nao khac: ' + out.join(' | '));
    assert.ok(out.includes('THU MUA/CONT 10-5V/AC305'));
    // Toan phan thi hang doi cua Thu mua moi duoc day sang.
    assert.ok(out.includes('THU MUA/CONT CHỜ XẾP/TH808'));
    assert.equal(out.length, 2);
  } finally { await db.close(); }
});

test('the default scope is partial so a deploy cannot silently wipe the legacy read model', async () => {
  const db = await baseDb();
  try {
    assert.equal((await db.query('SELECT projection_owns_all FROM purchase_settings WHERE id=1')).rows[0].projection_owns_all, false);
  } finally { await db.close(); }
});

test('a purchase row removed from the snapshot drops out of the shared read model', async () => {
  const db = await seeded({ ownsAll: false });
  try {
    await project(db);
    assert.ok((await names(db)).includes('THU MUA/CONT 10-5V/AC305'));
    await db.query("UPDATE purchase_orders SET deleted_at=now() WHERE row_key='D00001'");
    await project(db);
    const out = await names(db);
    assert.ok(!out.some(x => x.includes('AC305')), 'dong da xoa mem phai bien khoi read model');
    assert.ok(out.includes('YIWU/CONT 7-8Y/OLD2'), 'khong duoc keo theo dong cua sheet khac');
  } finally { await db.close(); }
});
