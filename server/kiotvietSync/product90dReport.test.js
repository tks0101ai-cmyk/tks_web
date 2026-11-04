'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const job = require('./product90dReport');

const NOW = new Date('2026-11-04T03:00:00Z');
const migration = () => fs.readFileSync(path.join(__dirname, '../db/migrations/0106_product_90d_report.sql'), 'utf8');
const quiet = () => {};
const poolFrom = db => ({ connect: async () => ({ query: (s, p) => db.query(s, p), release() {} }) });

async function setup() {
  const db = new PGlite();
  await db.exec(`
    CREATE TABLE products (branch text, id bigint, code text, name text, raw jsonb DEFAULT '{}', synced_at timestamptz, is_active boolean, PRIMARY KEY(branch,id));
    CREATE TABLE customers (branch text, id bigint, name text, raw jsonb DEFAULT '{}', PRIMARY KEY(branch,id));
    CREATE TABLE invoices (branch text, id bigint, code text, purchase_date timestamptz, customer_id bigint, status int, raw jsonb, PRIMARY KEY(branch,id));
    CREATE TABLE invoice_details (branch text, invoice_id bigint, line_no int, product_id bigint, quantity numeric, price numeric, discount numeric, raw jsonb);
    CREATE TABLE returns (branch text, id bigint, return_date timestamptz, customer_id bigint, status int, raw jsonb, PRIMARY KEY(branch,id));
    CREATE TABLE return_details (branch text, return_id bigint, line_no int, product_id bigint, quantity numeric, price numeric, raw jsonb);
    INSERT INTO products VALUES
      ('hanoi',1,'SP1','Tên hiện tại','{}',now()), ('saigon',1,'sp1','Tên SG','{}',now()),
      ('saigon',2,'SGONLY','Chỉ SG','{}',now()), ('hanoi',3,'ZERO','Ngừng bán','{"isActive":false}',now());
    INSERT INTO customers VALUES ('hanoi',1,'Khách A','{"isActive":false}'), ('saigon',1,'  KHÁCH   A  ','{}'),
      ('hanoi',2,'Khách B','{}'), ('hanoi',3,'Khách C','{}'), ('hanoi',4,'Khách D','{}');
  `);
  await db.exec(migration());
  return db;
}

async function invoice(db, { branch = 'hanoi', id, day, customer = 1, qty = 1, revenue = 100, status = 'Hoàn thành', line = 1, subtotal = true }) {
  await db.query(`INSERT INTO invoices VALUES ($1,$2,$3,$4,$5,1,$6) ON CONFLICT DO NOTHING`,
    [branch, id, 'HD' + id, day + 'T23:59:59Z', customer, JSON.stringify({ statusValue: status, customerName: 'Tên cũ' })]);
  await db.query(`INSERT INTO invoice_details VALUES ($1,$2,$3,1,$4,$5,0,$6)`,
    [branch, id, line, qty, revenue / qty, JSON.stringify(subtotal ? { subTotal: revenue } : {})]);
}

test('all catalog products, strict successful statuses, three exact periods, merged names and invoice deduplication', async () => {
  const db = await setup();
  try {
    await invoice(db, { id: 1, day: '2026-08-06', qty: 2, revenue: 200 }); // -90
    await invoice(db, { id: 2, day: '2026-09-04', qty: 3, revenue: 300 }); // -61
    await invoice(db, { id: 3, day: '2026-09-05', qty: 4, revenue: 400 }); // -60
    await invoice(db, { id: 4, day: '2026-10-04', qty: 5, revenue: 500 }); // -31
    await invoice(db, { id: 5, day: '2026-10-05', qty: 6, revenue: 600 }); // -30
    await invoice(db, { id: 6, day: '2026-11-03', qty: 7, revenue: 700 }); // -1
    await invoice(db, { id: 6, day: '2026-11-03', qty: 1, revenue: 100, line: 2 });
    await invoice(db, { branch: 'saigon', id: 6, day: '2026-11-03', qty: 1.5, revenue: 150 });
    await invoice(db, { id: 7, day: '2026-08-05', qty: 999 }); // -91 excluded
    await invoice(db, { id: 8, day: '2026-11-04', qty: 999 }); // today excluded
    await invoice(db, { id: 9, day: '2026-11-03', qty: 999, status: 'Đang xử lý' });
    await invoice(db, { id: 10, day: '2026-11-03', qty: 999, status: 'Đã hủy' });
    await db.exec(`INSERT INTO returns VALUES ('hanoi',1,'2026-11-03 00:00:00+00',1,1,'{"statusValue":"Đã trả"}');
      INSERT INTO return_details VALUES ('hanoi',1,1,1,2,100,'{"subTotal":200}');
      INSERT INTO returns VALUES ('hanoi',2,'2026-11-03 00:00:00+00',1,1,'{"statusValue":"Phiếu tạm"}');
      INSERT INTO return_details VALUES ('hanoi',2,1,1,999,100,'{}');`);
    const result = await job.refreshProduct90dReport(poolFrom(db), { now: () => NOW, log: quiet });
    assert.equal(result.rowCount, 3);
    const rows = (await db.query('SELECT * FROM product_90d_report ORDER BY product_key')).rows;
    const p = rows.find(r => r.product_key === 'sp1');
    assert.equal(p.product_name, 'Tên hiện tại');
    assert.equal(p.qty_61_90d, '5');
    assert.equal(p.qty_31_60d, '9');
    assert.equal(p.qty_1_30d, '13.5');
    assert.equal(p.qty_1_90d, '27.5');
    assert.equal(p.revenue_1_90d, '2750');
    assert.equal(Number(p.avg_price_1_90d), 100);
    assert.equal(p.customer_count_1_90d, '1');
    assert.equal(p.invoice_count_1_30d, '3');
    assert.equal(p.invoice_count_1_90d, '7');
    assert.equal(p.top_customers_1_90d.length, 1);
    assert.equal(p.top_customers_1_90d[0].revenue, 2750);
    assert.equal(p.top_customers_1_90d[0].share, 1);
    assert.equal(p.top_customers_1_90d[0].quantity, 27.5);
    for (const r of rows.filter(r => r.product_key !== 'sp1')) {
      assert.equal(r.qty_1_90d, '0'); assert.equal(r.customer_count_1_90d, '0');
      assert.equal(r.avg_price_1_90d, null); assert.deepEqual(r.top_customers_1_90d, []);
    }
    const state = (await db.query('SELECT window_start::text, window_end::text, row_count FROM product_90d_report_state')).rows[0];
    assert.deepEqual(state, { window_start: '2026-08-06', window_end: '2026-11-03', row_count: '3' });
    await db.exec(migration()); // replay migration preserves populated report
    assert.equal((await db.query('SELECT count(*)::int AS n FROM product_90d_report')).rows[0].n, 3);
  } finally { await db.close(); }
});

test('top three ranks NET revenue with shares of ALL customers, not just the top three; fallback discounts and return-only customers', async () => {
  const db = await setup();
  try {
    for (const [id, revenue] of [[1, 400], [2, 300], [3, 200], [4, 100]]) {
      await invoice(db, { id, day: '2026-11-01', customer: id, qty: 1, revenue, subtotal: false });
    }
    await db.exec(`UPDATE invoice_details SET discount=50 WHERE invoice_id=1;
      INSERT INTO returns VALUES ('hanoi',1,'2026-11-02',1,1,'{"statusValue":"Đã trả"}');
      INSERT INTO return_details VALUES ('hanoi',1,1,1,1,200,'{}');
      INSERT INTO returns VALUES ('hanoi',2,'2026-09-01',4,1,'{"statusValue":"Đã trả"}');
      INSERT INTO return_details VALUES ('hanoi',2,1,1,1,100,'{}');`);
    await job.refreshProduct90dReport(poolFrom(db), { now: () => NOW, log: quiet });
    const p = (await db.query("SELECT * FROM product_90d_report WHERE product_key='sp1'")).rows[0];
    assert.equal(p.revenue_1_30d, '750');
    assert.equal(p.customer_count_1_30d, '4');
    assert.equal(p.invoice_count_1_30d, '4');
    assert.deepEqual(p.top_customers_1_30d.map(c => [c.name, c.revenue]), [['Khách B', 300], ['Khách C', 200], ['Khách A', 150]]);
    assert.equal(p.top_customers_1_30d[0].share, 0.4);
    assert.equal(p.customer_count_61_90d, '0');
    assert.equal(p.invoice_count_61_90d, '0');
    assert.equal(p.revenue_61_90d, '-100');
  } finally { await db.close(); }
});

async function activeFixture(db) {
  await db.exec(`INSERT INTO products (branch,id,code,name,raw,synced_at,is_active) VALUES
    ('hanoi',10,'GONE','Ngừng HN','{}',now(),false), ('saigon',10,'gone','Ngừng SG','{}',now(),false),
    ('hanoi',11,'MIX','HN đã xóa','{}',now(),false), ('saigon',11,'MIX','SG đang bán','{}',now(),true),
    ('hanoi',12,'NULLACT','HN null','{}',now(),NULL), ('hanoi',13,'HNOK','HN đang bán','{}',now(),true);`);
}
async function lineFor(db, { branch = 'hanoi', id, productId, day = '2026-11-01', revenue = 100 }) {
  await db.query(`INSERT INTO invoices VALUES ($1,$2,$3,$4,1,1,$5)`,
    [branch, id, 'HD' + id, day + 'T10:00:00Z', JSON.stringify({ statusValue: 'Hoàn thành' })]);
  await db.query(`INSERT INTO invoice_details VALUES ($1,$2,1,$3,1,$4,0,$5)`,
    [branch, id, productId, revenue, JSON.stringify({ subTotal: revenue })]);
}

test('catalog only has active products: inactive-only codes and their sales/returns are excluded', async () => {
  const db = await setup();
  try {
    await activeFixture(db);
    await lineFor(db, { id: 101, productId: 10, revenue: 500 }); // GONE (inactive both branches)
    await lineFor(db, { branch: 'saigon', id: 102, productId: 10, revenue: 700 });
    await db.exec(`INSERT INTO returns VALUES ('hanoi',50,'2026-11-02',1,1,'{"statusValue":"Đã trả"}');
      INSERT INTO return_details VALUES ('hanoi',50,1,10,1,50,'{"subTotal":50}');`);
    await lineFor(db, { id: 103, productId: 13, revenue: 300 });
    const result = await job.refreshProduct90dReport(poolFrom(db), { now: () => NOW, log: quiet });
    const keys = (await db.query('SELECT product_key FROM product_90d_report ORDER BY product_key')).rows.map(r => r.product_key);
    assert.deepEqual(keys, ['hnok', 'mix', 'nullact', 'sgonly', 'sp1', 'zero']);
    assert.equal(result.rowCount, 6);
    assert.equal((await db.query("SELECT revenue_1_90d FROM product_90d_report WHERE product_key='hnok'")).rows[0].revenue_1_90d, '300');
    assert.equal((await db.query('SELECT sum(revenue_1_90d)::text AS s FROM product_90d_report')).rows[0].s, '300');
  } finally { await db.close(); }
});

test('catalog keeps a code active in one branch only (name from the active row) and treats is_active NULL as active', async () => {
  const db = await setup();
  try {
    await activeFixture(db);
    await lineFor(db, { branch: 'saigon', id: 201, productId: 11, revenue: 250 });
    await job.refreshProduct90dReport(poolFrom(db), { now: () => NOW, log: quiet });
    const mix = (await db.query("SELECT product_code, product_name, revenue_1_90d FROM product_90d_report WHERE product_key='mix'")).rows[0];
    assert.equal(mix.product_name, 'SG đang bán');
    assert.equal(mix.product_code, 'MIX');
    assert.equal(mix.revenue_1_90d, '250');
    const nullAct = (await db.query("SELECT product_name FROM product_90d_report WHERE product_key='nullact'")).rows[0];
    assert.equal(nullAct.product_name, 'HN null');
    // Both branches active: Hanoi name still wins, as before.
    assert.equal((await db.query("SELECT product_name FROM product_90d_report WHERE product_key='sp1'")).rows[0].product_name, 'Tên hiện tại');
  } finally { await db.close(); }
});

test('rows stored for a code that later becomes inactive are deleted by the next refresh', async () => {
  const db = await setup();
  try {
    await activeFixture(db);
    await db.exec("UPDATE products SET is_active=true WHERE code IN ('GONE','gone')");
    const pool = poolFrom(db);
    await lineFor(db, { id: 301, productId: 10, revenue: 400 });
    const first = await job.refreshProduct90dReport(pool, { now: () => NOW, log: quiet });
    assert.equal(first.rowCount, 7);
    assert.equal((await db.query("SELECT revenue_1_90d FROM product_90d_report WHERE product_key='gone'")).rows[0].revenue_1_90d, '400');
    await db.exec("UPDATE products SET is_active=false WHERE code IN ('GONE','gone')");
    const second = await job.refreshProduct90dReport(pool, { now: () => NOW, log: quiet });
    assert.equal(second.rowCount, 6);
    assert.equal(second.deleted, 1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM product_90d_report WHERE product_key='gone'")).rows[0].n, 0);
    assert.equal((await db.query('SELECT row_count FROM product_90d_report_state')).rows[0].row_count, '6');
  } finally { await db.close(); }
});

test('scheduler respects 02:00 Vietnam, runs once daily, catches up and preserves last good report on failure', async () => {
  const db = await setup();
  try {
    const pool = poolFrom(db);
    const refresh = (date, force = false) => job.refreshProduct90dReport(pool, { now: () => new Date(date), force, log: quiet });
    assert.equal((await refresh('2026-11-03T18:59:59Z')).skipped, 'before-02:00');
    assert.equal((await refresh('2026-11-03T19:00:00Z')).rowCount, 3);
    assert.equal((await refresh('2026-11-04T12:00:00Z')).skipped, 'already-current');
    assert.equal((await refresh('2026-11-04T18:59:00Z')).skipped, 'before-02:00');
    await db.exec(`UPDATE products SET name='Mới' WHERE code='SP1';
      CREATE FUNCTION fail_report() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_report BEFORE UPDATE ON product_90d_report FOR EACH ROW EXECUTE FUNCTION fail_report();`);
    await assert.rejects(refresh('2026-11-05T03:00:00Z'), /test failure/);
    assert.equal((await db.query("SELECT product_name FROM product_90d_report WHERE product_key='sp1'")).rows[0].product_name, 'Tên hiện tại');
    assert.equal((await db.query('SELECT window_end::text FROM product_90d_report_state')).rows[0].window_end, '2026-11-03');
    await db.exec('DROP TRIGGER fail_report ON product_90d_report');
    assert.equal((await refresh('2026-11-05T03:00:00Z')).rowCount, 3);
    assert.equal((await db.query('SELECT window_end::text FROM product_90d_report_state')).rows[0].window_end, '2026-11-04');
  } finally { await db.close(); }
});

test('exact NUMERIC decimals, zero denominators, status fallbacks, and unchanged snapshot makes no data writes', async () => {
  const db = await setup();
  try {
    await invoice(db, { id: 1, day: '2026-11-01', qty: 0.1, revenue: 0.1 });
    await invoice(db, { id: 2, day: '2026-11-01', qty: 0.2, revenue: 0.2 });
    await db.exec(`UPDATE invoices SET raw='{}' WHERE id=1;
      INSERT INTO returns VALUES ('hanoi',1,'2026-11-02',1,1,'{}');
      INSERT INTO return_details VALUES ('hanoi',1,1,1,0.3,1,'{"subTotal":0.3}');`);
    const pool = poolFrom(db);
    await job.refreshProduct90dReport(pool, { now: () => NOW, log: quiet });
    const p = (await db.query("SELECT * FROM product_90d_report WHERE product_key='sp1'")).rows[0];
    assert.equal(Number(p.qty_1_30d), 0);
    assert.equal(Number(p.revenue_1_30d), 0);
    assert.equal(p.avg_price_1_30d, null);
    assert.equal(p.top_customers_1_30d[0].share, null);
    assert.equal(p.invoice_count_1_30d, '2');
    const repeat = await job.refreshProduct90dReport(pool, { now: () => NOW, log: quiet });
    assert.equal(repeat.changed, 0);
    assert.equal(repeat.deleted, 0);
    await db.exec("DELETE FROM products WHERE code='ZERO'");
    const removed = await job.refreshProduct90dReport(pool, { now: () => NOW, log: quiet });
    assert.equal(removed.rowCount, 2);
    assert.equal(removed.deleted, 1);
  } finally { await db.close(); }
});

test('schedule starts catch-up, registers minute timer, contains missing migration and skips busy transactions', async () => {
  const db = await setup();
  try {
    const immediate = [], timers = [], errors = [];
    const pool = poolFrom(db);
    const handle = job.startProduct90dReportSchedule(pool, {
      now: () => NOW, log: e => errors.push(e), scheduleImmediate: fn => immediate.push(fn),
      setIntervalFn: (fn, ms) => { timers.push({ fn, ms }); return 'timer'; }
    });
    assert.equal(handle, 'timer'); assert.equal(timers[0].ms, 60000);
    await immediate[0]();
    await timers[0].fn();
    assert.equal((await db.query('SELECT version::int FROM product_90d_report_state')).rows[0].version, 1);
    // The lock belongs to another DB connection in production; exercise the
    // failed acquisition boundary while using the real DB for everything else.
    const busyPool = { connect: async () => ({ query: (sql,p) => sql.includes('pg_try_advisory')
      ? { rows: [{ locked: false }] } : db.query(sql,p), release() {} }) };
    assert.deepEqual(await job.refreshProduct90dReport(busyPool, { now: () => NOW, log: quiet }), { skipped: 'busy' });
    assert.equal((await db.query('SELECT version::int FROM product_90d_report_state')).rows[0].version, 1);
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/rollbacks/0106_product_90d_report.down.sql'), 'utf8'));
    await timers[0].fn();
    assert.equal(errors.filter(e => e.includes('Lỗi')).length, 0);
  } finally { await db.close(); }
});

test('migration exposes 26 business columns plus key, keeps all measures NUMERIC, and revokes public API access', async () => {
  const db = await setup();
  try {
    const columns = (await db.query("SELECT column_name,data_type FROM information_schema.columns WHERE table_name='product_90d_report'")).rows;
    assert.equal(columns.length, 27);
    assert.equal(columns.filter(c => c.data_type === 'numeric').length, 20);
    assert.equal(columns.filter(c => c.data_type === 'jsonb').length, 4);
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE reporting_readonly;
      GRANT ALL ON product_90d_report,product_90d_report_state TO anon,authenticated,reporting_readonly;`);
    await db.exec(migration());
    const permissions = (await db.query(`SELECT role, has_table_privilege(role,'product_90d_report','SELECT') AS can_read
      FROM unnest(ARRAY['anon','authenticated','reporting_readonly']) AS role`)).rows;
    assert.ok(permissions.every(r => r.can_read === false));
    assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE relname='product_90d_report'")).rows[0].relrowsecurity, true);
    await assert.rejects(db.exec(`INSERT INTO product_90d_report_state VALUES (2,'2026-11-04','2026-08-06','2026-11-03',now(),0,1)`), /check constraint/);
  } finally { await db.close(); }
});
