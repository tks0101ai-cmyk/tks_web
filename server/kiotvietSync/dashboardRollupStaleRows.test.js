'use strict';

// Hoi quy 2026-11-06: phieu tra "Đã trả" da vao daily_product_sales roi bi doi sang "Đã hủy" thi nhom
// (ngay, ma hang) bien mat khoi ket qua tinh lai nen dong cu (am) o lai mai -> "SL ban 30 ngay" cua
// TVPAMS am gap doi. Rollup phai XOA dong khong con trong ket qua tinh lai (trong cua so ngay dang tinh).

const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { refreshDashboardRollups } = require('./dashboardRollupRefresh');

// Cot ngay luu "gio treo tuong VN gan nhan UTC": n ngay truoc (lich VN), 10h sang.
const vnDay = (daysAgo) =>
  `(((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ${daysAgo} + time '10:00')::timestamp AT TIME ZONE 'UTC')`;

async function makeDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE invoices(branch text, id bigint, purchase_date timestamptz, total numeric, raw jsonb);
    CREATE TABLE invoice_details(branch text, invoice_id bigint, product_id bigint, quantity numeric, price numeric, discount numeric, raw jsonb);
    CREATE TABLE returns(branch text, id bigint, return_date timestamptz, raw jsonb);
    CREATE TABLE return_details(branch text, return_id bigint, product_id bigint, quantity numeric, price numeric, raw jsonb);
    CREATE TABLE purchases(branch text, id bigint, purchase_date timestamptz);
    CREATE TABLE purchase_details(branch text, purchase_id bigint, product_id bigint);
    CREATE TABLE daily_invoice_summary(branch text, sale_date date, revenue numeric, invoice_count int, cancelled_count int, updated_at timestamptz DEFAULT now(), PRIMARY KEY(branch, sale_date));
    CREATE TABLE daily_product_sales(branch text, sale_date date, product_id bigint, qty numeric, revenue numeric, updated_at timestamptz DEFAULT now(), PRIMARY KEY(branch, sale_date, product_id));
    CREATE TABLE product_first_purchase(branch text, product_id bigint, first_purchase_date timestamptz, updated_at timestamptz DEFAULT now(), PRIMARY KEY(branch, product_id));
  `);
  return db;
}

// PGlite khong co rowCount nhu pg.Pool.
const poolOf = (db) => ({
  query: async (sql, params) => {
    const r = await db.query(sql, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }
});

const rollup = (db, windowDays = 400) => refreshDashboardRollups(poolOf(db), {
  windowDays, includeFirstPurchase: false, log: () => {}, getConfiguredBranches: () => [{ branch: 'hanoi' }]
});

const salesRows = async (db) => (await db.query(
  `SELECT branch, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - sale_date AS days_ago, product_id::int AS product_id, qty::float8 AS qty
     FROM daily_product_sales ORDER BY branch, sale_date, product_id`)).rows;

test('phieu tra Đã trả -> Đã hủy: dong am cu trong daily_product_sales bi xoa o luot tinh lai', async () => {
  const db = await makeDb();
  await db.exec(`
    INSERT INTO returns VALUES ('hanoi', 1, ${vnDay(5)}, '{"statusValue":"Đã trả"}'), ('hanoi', 2, ${vnDay(4)}, '{"statusValue":"Đã trả"}');
    INSERT INTO return_details VALUES ('hanoi', 1, 77, 1950, 6000, '{"subTotal":11700000}'), ('hanoi', 2, 77, 1950, 6000, '{"subTotal":11700000}');`);
  await rollup(db);
  assert.deepEqual((await salesRows(db)).map(r => [r.days_ago, r.qty]), [[5, -1950], [4, -1950]]);

  await db.exec(`UPDATE returns SET raw = '{"statusValue":"Đã hủy"}' WHERE id = 1`);
  await rollup(db);
  assert.deepEqual((await salesRows(db)).map(r => [r.days_ago, r.qty]), [[4, -1950]],
    'phieu da huy khong con duoc tinh; chi con phieu Đã trả');
});

test('hoa don bi huy sau khi da vao rollup cung bi go khoi daily_product_sales', async () => {
  const db = await makeDb();
  await db.exec(`
    INSERT INTO invoices VALUES ('hanoi', 10, ${vnDay(3)}, 100, '{"statusValue":"Hoàn thành"}');
    INSERT INTO invoice_details VALUES ('hanoi', 10, 88, 5, 20, 0, '{}');`);
  await rollup(db);
  assert.equal((await salesRows(db)).length, 1);

  await db.exec(`UPDATE invoices SET raw = '{"statusValue":"Đã hủy"}' WHERE id = 10`);
  await rollup(db);
  assert.deepEqual(await salesRows(db), []);
});

test('chi xoa trong cua so ngay dang tinh va dung co so dang tinh; dong ngoai cua so/co so khac duoc giu', async () => {
  const db = await makeDb();
  await db.exec(`
    INSERT INTO daily_product_sales(branch, sale_date, product_id, qty, revenue) VALUES
      ('hanoi',  (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 3,  1, -5, -5),
      ('hanoi',  (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 30, 2, -7, -7),
      ('saigon', (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 3,  3, -9, -9)`);
  await rollup(db, 7); // cua so nong 7 ngay: chi dong 3 ngay truoc cua Ha Noi la "mo coi" can xoa
  assert.deepEqual((await salesRows(db)).map(r => [r.branch, r.product_id]), [['hanoi', 2], ['saigon', 3]]);
});
