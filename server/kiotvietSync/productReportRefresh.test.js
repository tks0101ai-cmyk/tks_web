'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  refreshProductReport, refreshProductReportIfDue, startProductReportSchedule, __sql__, __test__
} = require('./productReportRefresh');

function fakeClient(insertRowCount = 7) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql === TRUNCATE_SQL) return {};
      return { rowCount: insertRowCount };
    },
    release: () => {}
  };
}

const TRUNCATE_SQL = 'TRUNCATE product_report, product_report_customers';

function fakePool(client) {
  return { connect: async () => client, query: async () => ({ rows: [] }) };
}

test('refreshProductReport chay dung trinh tu BEGIN/TRUNCATE/INSERT/COMMIT trong 1 transaction', async () => {
  const client = fakeClient(42);
  const pool = fakePool(client);
  const logs = [];
  const result = await refreshProductReport(pool, { log: (m) => logs.push(m) });

  assert.deepEqual(client.calls.map((c) => c.sql.split('\n')[0].trim() || c.sql), [
    'BEGIN', TRUNCATE_SQL, __sql__.REFRESH_SQL.split('\n')[0].trim() || __sql__.REFRESH_SQL, 'COMMIT'
  ]);
  assert.deepEqual(client.calls[2].params, [['hanoi', 'saigon']]);
  assert.equal(result.rowCount, 42);
  assert.match(logs[0], /42/);
});

test('REFRESH_SQL luu lai customer_agg vao product_report_customers trong CUNG 1 cau lenh (quet 90 ngay 1 lan)', () => {
  const sql = __sql__.REFRESH_SQL;
  assert.match(sql, /INSERT INTO product_report_customers\s*\(product_key, customer_key, customer_name, revenue, revenue_1_30d, revenue_31_60d, revenue_61_90d\)/);
  assert.match(sql, /FROM customer_agg/);
  // Ca 2 bang cung doc customer_agg => phai la CTE, khong quet lai invoice_details lan nua.
  assert.equal((sql.match(/FROM invoice_details/g) || []).length, 1);
  assert.match(sql, /INSERT INTO product_report \(/);
});

test('REFRESH_SQL tru hang khach tra khoi doanh so rong cua khach (khop revenue_90d) va chan ty le > 100%', () => {
  const sql = __sql__.REFRESH_SQL;
  assert.match(sql, /FROM return_details rd/);
  assert.match(sql, /r\.raw->>'statusValue' = 'Đã trả'/);
  assert.match(sql, /-\(CASE/, 'dong tra hang la dong AM');
  assert.match(sql, /HAVING SUM\(amount\) > 0/);
  assert.match(sql, /LEAST\(1, /);
});

test('REFRESH_SQL: Ton co ban = ton HN + ton SG - Dat hang PHIEU TAM (quy tac 2026-10-06, khong cong hang dang van chuyen)', () => {
  const sql = __sql__.REFRESH_SQL;
  // Chi Phieu tam bi tru (khong con 'Đang xử lý' / 'Đã xác nhận').
  // Khop nguyen van dieu kien cua idx_orders_phieu_tam (khong boc COALESCE) de dung duoc index rieng.
  assert.match(sql, /\(raw->>'statusValue'\) = 'Phiếu tạm'/);
  assert.doesNotMatch(sql, /COALESCE\(o\.raw->>'statusValue'/, 'COALESCE lam mat index idx_orders_phieu_tam');
  assert.doesNotMatch(sql, /statusValue', ''\) IN \(/, 'khong con loc nhieu trang thai (IN (...)) cho don dat hang');
  assert.match(sql, /hn\.on_hand \+ COALESCE\(sg\.on_hand, 0\) - COALESCE\(po\.qty, 0\),/);
  // Hang dang van chuyen (order_suppliers) khong con tinh vao ton co the ban.
  assert.doesNotMatch(sql, /in_transit|order_suppliers|tr\.qty/);
  // Chi 1 tham so ($1 = danh sach co so).
  assert.equal(/\$2/.test(sql), false);
});

test('refreshProductReport ROLLBACK va nem loi neu INSERT that bai', async () => {
  const calls = [];
  const client = {
    calls,
    query: async (sql) => {
      calls.push(sql);
      if (sql === __sql__.REFRESH_SQL) throw new Error('boom');
      return {};
    },
    release: () => {}
  };
  await assert.rejects(() => refreshProductReport(fakePool(client), { log: () => {} }), /boom/);
  assert.ok(calls.includes('ROLLBACK'));
});

test('refreshProductReportIfDue bo qua neu da tinh cho ngay VN hom nay', async () => {
  const now = new Date('2026-09-23T10:00:00Z'); // 17h VN cung ngay
  const pool = {
    query: async () => ({ rows: [{ last_computed_at: new Date('2026-09-23T00:05:00Z') }] })
  };
  const result = await refreshProductReportIfDue(pool, { now: () => now, log: () => {} });
  assert.deepEqual(result, { skipped: true });
});

test('refreshProductReportIfDue tinh lai neu chua tinh cho ngay VN hom nay', async () => {
  const now = new Date('2026-09-23T00:03:00Z'); // dau ngay VN moi (07h VN)
  const client = fakeClient(10);
  const pool = {
    query: async (sql) => {
      if (sql.includes('MAX(computed_at)')) return { rows: [{ last_computed_at: new Date('2026-09-21T20:00:00Z') }] };
      return { rows: [] };
    },
    connect: async () => client
  };
  const result = await refreshProductReportIfDue(pool, { now: () => now, log: () => {} });
  assert.deepEqual(result, { skipped: false, rowCount: 10 });
});

test('refreshProductReportIfDue tinh lai neu bang con trong (chua tung tinh)', async () => {
  const client = fakeClient(3);
  const pool = { query: async () => ({ rows: [{ last_computed_at: null }] }), connect: async () => client };
  const result = await refreshProductReportIfDue(pool, { now: () => new Date(), log: () => {} });
  assert.deepEqual(result, { skipped: false, rowCount: 3 });
});

test('startProductReportSchedule dang ky interval va chay ngay 1 lan luc boot', async () => {
  let scheduledFn;
  let scheduledMs;
  let immediateFn;
  const setIntervalFn = (fn, ms) => { scheduledFn = fn; scheduledMs = ms; return 'handle-product-report'; };
  const scheduleImmediate = (fn) => { immediateFn = fn; };
  const client = fakeClient(5);
  const pool = { query: async () => ({ rows: [{ last_computed_at: null }] }), connect: async () => client };

  const handle = startProductReportSchedule(pool, { intervalMs: 5000, setIntervalFn, scheduleImmediate, log: () => {} });

  assert.equal(handle, 'handle-product-report');
  assert.equal(scheduledMs, 5000);
  assert.equal(typeof immediateFn, 'function');
  assert.equal(typeof scheduledFn, 'function');

  await immediateFn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(client.calls.some((c) => c.sql === 'BEGIN'), 'phai tinh ngay 1 lan luc boot');
});

test('vnDateKey tra ve ngay lich VN (UTC+7), khong phai ngay UTC', () => {
  // 2026-09-22T18:30:00Z = 2026-09-23 01:30 VN -> da sang ngay moi theo lich VN.
  assert.equal(__test__.vnDateKey(new Date('2026-09-22T18:30:00Z')), '2026-09-23');
  assert.equal(__test__.vnDateKey(new Date('2026-09-22T10:00:00Z')), '2026-09-22');
});

// ---- Co ban / Mo ta THEO TUNG CO SO (migration 0057) ----
test('REFRESH_SQL ghi them Co ban HN/SG va Mo ta HN/SG; tong hai cot co ban = available_to_sell (cung nguon phieu tam)', () => {
  const sql = __sql__.REFRESH_SQL;
  assert.match(sql, /available_hanoi, available_saigon, description_hanoi, description_saigon, price_hanoi, price_saigon,\s+qty_sold_30d_hanoi, qty_sold_30d_saigon, orders_30d, orders_90d, computed_at/);
  assert.match(sql, /hn\.on_hand - COALESCE\(po\.qty_hanoi, 0\),\s+COALESCE\(sg\.on_hand, 0\) - COALESCE\(po\.qty_saigon, 0\),\s+hn\.description,\s+sg\.description,\s+hn\.price,\s+sg\.price,\s+COALESCE\(s30\.qty_hanoi, 0\),\s+COALESCE\(s30\.qty_saigon, 0\),\s+COALESCE\(oc\.orders_30d, 0\),\s+COALESCE\(oc\.orders_90d, 0\),\s+now\(\)/);
  // Van chi 1 lan quet phieu tam: tach theo co so bang FILTER, khong them truy van thu hai.
  assert.equal((sql.match(/FROM orders/g) || []).length, 1);
  assert.match(sql, /FILTER \(WHERE d\.branch = 'hanoi'\)/);
  assert.match(sql, /FILTER \(WHERE d\.branch = 'saigon'\)/);
  // Mo ta chi con tab/xuong dong coi nhu trong (btrim mac dinh chi cat dau cach).
  assert.equal((sql.match(/NULLIF\(btrim\(p\.raw->>'description', E' \\t\\r\\n'\), ''\) AS description/g) || []).length, 2);
});

test('SQL that (PGlite): phieu tam tach dung theo co so, tong = HN + SG, chi tinh Phieu tam; mo ta cat tab/xuong dong', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const R = __sql__.REFRESH_SQL;
  const cut = (from, to) => R.slice(R.indexOf(from), R.indexOf(to, R.indexOf(from) + 1)).trim().replace(/,$/, '');
  const pending = cut('pending_orders AS (', '  sales_30d AS (');
  const hnProducts = cut('hn_products AS (', '  sg_products AS (');
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE products (branch text, id bigint, code text, name text, raw jsonb, base_price numeric);
      CREATE TABLE orders (branch text, id bigint, raw jsonb);
      CREATE TABLE order_details (branch text, order_id bigint, product_id bigint, quantity numeric, raw jsonb);
      INSERT INTO products VALUES
        ('hanoi', 1, 'A', 'A', '{"description":"  T50 # 30/9 | VAT+3200đ\\n"}'),
        ('saigon', 1, 'A', 'A', '{"description":"\\n\\t "}'),
        ('hanoi', 2, 'B', 'B', '{}');
      INSERT INTO orders VALUES
        ('hanoi', 10, '{"statusValue":"Phiếu tạm"}'), ('saigon', 20, '{"statusValue":"Phiếu tạm"}'),
        ('hanoi', 11, '{"statusValue":"Hoàn thành"}');
      INSERT INTO order_details VALUES
        ('hanoi', 10, 1, 5, '{}'), ('saigon', 20, 1, 3, '{"productCode":"A"}'),
        ('hanoi', 11, 2, 9, '{}'), ('hanoi', 10, 2, 2, '{}');`);
    const rows = (await db.query(`WITH ${pending} SELECT * FROM pending_orders ORDER BY product_key`, [['hanoi', 'saigon']])).rows;
    assert.deepEqual(rows, [
      { product_key: 'a', qty: 8, qty_hanoi: 5, qty_saigon: 3 },
      { product_key: 'b', qty: 2, qty_hanoi: 2, qty_saigon: 0 } // don Hoan thanh (9) khong bi tru
    ]);
    const products = (await db.query(`WITH ${hnProducts} SELECT code, description, price::float8 AS price FROM hn_products ORDER BY code`)).rows;
    // Don gia = products.base_price cua co so; thieu gia coi nhu 0 (ma hang do Ha Noi quyet dinh).
    assert.deepEqual(products, [{ code: 'A', description: 'T50 # 30/9 | VAT+3200đ', price: 0 }, { code: 'B', description: null, price: 0 }]);
    const blank = (await db.query(`SELECT NULLIF(btrim(raw->>'description', ${__sql__.DESCRIPTION_TRIM_CHARS}), '') AS d FROM products WHERE branch = 'saigon'`)).rows;
    assert.deepEqual(blank, [{ d: null }], 'mo ta chi gom tab/xuong dong/dau cach coi nhu khong co');
  } finally { await db.close(); }
});

test('refreshProductReportIfDue: da tinh hom nay nhung con dong chua co cot theo co so (vua ap 0057) => tinh lai ngay', async () => {
  const now = new Date('2026-09-23T10:00:00Z');
  const client = fakeClient(9);
  const pool = {
    query: async (sql) => {
      assert.match(sql, /bool_or\(available_hanoi IS NULL OR price_hanoi IS NULL\s+OR qty_sold_30d_hanoi IS NULL OR orders_90d IS NULL\)/);
      return { rows: [{ last_computed_at: new Date('2026-09-23T00:05:00Z'), needs_branch_columns: true }] };
    },
    connect: async () => client
  };
  assert.deepEqual(await refreshProductReportIfDue(pool, { now: () => now, log: () => {} }), { skipped: false, rowCount: 9 });
  // Da du cot (khong con NULL) => van bo qua nhu cu.
  const settled = { query: async () => ({ rows: [{ last_computed_at: new Date('2026-09-23T00:05:00Z'), needs_branch_columns: false }] }) };
  assert.deepEqual(await refreshProductReportIfDue(settled, { now: () => now, log: () => {} }), { skipped: true });
});

// Schema + du lieu toi thieu de chay NGUYEN REFRESH_SQL tren Postgres that (PGlite). Moc ngay tinh bang SQL theo
// lich VN cua may chay test nen khong phu thuoc ngay hien tai. Dung chung cho productReportIncremental.test.js (copy).
async function bcChungFixture() {
  const { PGlite } = require('@electric-sql/pglite');
  const fs = require('node:fs');
  const path = require('node:path');
  const migrations = path.join(__dirname, '../db/migrations');
  const db = new PGlite();
  for (const file of ['0018_product_report.sql', '0023_product_report_customers.sql', '0057_product_report_branch_columns.sql',
    '0063_product_report_price_columns.sql', '0067_product_report_bc_chung.sql']) {
    await db.exec(fs.readFileSync(path.join(migrations, file), 'utf8'));
  }
  await db.exec('CREATE TABLE product_report_state (id smallint PRIMARY KEY, computed_at timestamptz, version bigint, last_full_at timestamptz)');
  await db.exec(fs.readFileSync(path.join(migrations, '0108_product_customer_periods.sql'), 'utf8'));
  const day = (n) => `(((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ${n})::timestamp AT TIME ZONE 'UTC' + interval '2 hours')`;
  const dayDate = (n) => `((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ${n})`;
  await db.exec(`
    CREATE TABLE products (branch text, id bigint, code text, name text, is_active boolean, raw jsonb, base_price numeric);
    CREATE TABLE orders (branch text, id bigint, raw jsonb);
    CREATE TABLE order_details (branch text, order_id bigint, product_id bigint, quantity numeric, raw jsonb);
    CREATE TABLE daily_product_sales (branch text, product_id bigint, sale_date date, qty numeric, revenue numeric);
    CREATE TABLE customers (branch text, id bigint, code text, name text, raw jsonb);
    CREATE TABLE invoices (branch text, id bigint, customer_id bigint, purchase_date timestamptz, raw jsonb);
    CREATE TABLE invoice_details (branch text, invoice_id bigint, product_id bigint, quantity numeric, price numeric, discount numeric, raw jsonb);
    CREATE TABLE returns (branch text, id bigint, customer_id bigint, return_date timestamptz, raw jsonb);
    CREATE TABLE return_details (branch text, return_id bigint, product_id bigint, quantity numeric, price numeric, raw jsonb);
    -- Ma A: id khac nhau o hai co so (HN 1, SG 11); ma B chi co o HN va khong ban gi.
    INSERT INTO products VALUES
      ('hanoi', 1, 'A', 'Sp A', true, '{}', 1000), ('saigon', 11, 'A', 'Sp A', true, '{}', 1100),
      ('hanoi', 2, 'B', 'Sp B', true, '{}', 500);
    INSERT INTO customers VALUES
      ('hanoi', 1, 'C1', 'KH 1', '{}'), ('hanoi', 2, 'C2', 'KH ngung', '{"isActive":false}'), ('saigon', 1, 'C1', 'KH 1', '{}');
    -- SL ban theo ngay: HN 5 (3 ngay truoc) + 9 (45 ngay truoc, ngoai cua so 30), SG 2 (10 ngay truoc).
    INSERT INTO daily_product_sales VALUES
      ('hanoi', 1, ${dayDate(3)}, 5, 50), ('hanoi', 1, ${dayDate(45)}, 9, 90), ('saigon', 11, ${dayDate(10)}, 2, 20);
    INSERT INTO invoices VALUES
      ('hanoi', 100, 1, ${day(5)}, '{"statusValue":"Hoàn thành"}'),    -- 30d + 90d (2 dong cung hoa don => 1 don)
      ('saigon', 100, 1, ${day(15)}, '{"statusValue":"Hoàn thành"}'),  -- trung id voi HN nhung khac co so => don khac
      ('hanoi', 101, 1, ${day(10)}, '{"statusValue":"Đã hủy"}'),       -- huy => khong tinh
      ('hanoi', 102, 2, ${day(20)}, '{"statusValue":"Hoàn thành"}'),   -- khach ngung hoat dong: van tinh SL don
      ('saigon', 200, 1, ${day(40)}, '{"statusValue":"Hoàn thành"}'),  -- chi trong 90 ngay
      ('hanoi', 103, 1, ${day(100)}, '{"statusValue":"Hoàn thành"}');  -- ngoai cua so 90 ngay
    INSERT INTO invoice_details VALUES
      ('hanoi', 100, 1, 2, 1000, 0, '{}'), ('hanoi', 100, 1, 1, 1000, 0, '{}'),
      ('saigon', 100, 11, 1, 1100, 0, '{}'),
      ('hanoi', 101, 1, 4, 1000, 0, '{}'),
      ('hanoi', 102, 1, 1, 1000, 0, '{}'),
      ('saigon', 200, 11, 3, 1100, 0, '{}'),
      ('hanoi', 103, 1, 1, 1000, 0, '{}');
    INSERT INTO returns VALUES ('hanoi', 300, 1, ${day(3)}, '{"statusValue":"Đã trả"}');
    INSERT INTO return_details VALUES ('hanoi', 300, 1, 1, 1000, '{}');`);
  return db;
}

test('SQL that (PGlite): REFRESH_SQL ghi SL ban 30 ngay theo co so + SL don 30/90 ngay theo MA HANG (khong huy, khong tinh tra hang, tinh ca khach ngung)', async () => {
  const db = await bcChungFixture();
  try {
    await db.query(__sql__.REFRESH_SQL, [['hanoi', 'saigon']]);
    const rows = (await db.query(`SELECT product_code, qty_sold_30d::float8 AS q, qty_sold_30d_hanoi::float8 AS qh, qty_sold_30d_saigon::float8 AS qs,
      orders_30d::float8 AS o30, orders_90d::float8 AS o90 FROM product_report ORDER BY product_code`)).rows;
    assert.deepEqual(rows, [
      // 30 ngay: HN#100 (5 ngay), SG#100 (15 ngay), HN#102 (20 ngay) = 3; 90 ngay: them SG#200 (40 ngay) = 4.
      { product_code: 'A', q: 7, qh: 5, qs: 2, o30: 3, o90: 4 },
      { product_code: 'B', q: 0, qh: 0, qs: 0, o30: 0, o90: 0 } // khong ban => 0 (khong NULL)
    ]);
    // Khach ngung hoat dong (C2) van bi loai khoi bang khach nhu truoc, hoa don cua ho khong lam rot dong dem don.
    const customers = (await db.query('SELECT customer_key FROM product_report_customers WHERE product_key = $1 ORDER BY 1', ['a'])).rows;
    assert.deepEqual(customers.map(row => row.customer_key), ['name:kh 1']);
  } finally { await db.close(); }
});

test('refreshProductReportIfDue: chua ap migration 0057 (42703) => doc moc thoi gian bang cau cu, hanh vi khong doi', async () => {
  const now = new Date('2026-09-23T10:00:00Z');
  const queries = [];
  const pool = {
    query: async (sql) => {
      queries.push(sql);
      if (sql.includes('available_hanoi')) throw Object.assign(new Error('column "available_hanoi" does not exist'), { code: '42703' });
      return { rows: [{ last_computed_at: new Date('2026-09-23T00:05:00Z') }] };
    }
  };
  assert.deepEqual(await refreshProductReportIfDue(pool, { now: () => now, log: () => {} }), { skipped: true });
  assert.equal(queries.length, 2);
  assert.doesNotMatch(queries[1], /available_hanoi/);
  // Loi khac 42703 van duoc nem ra, khong bi nuot.
  await assert.rejects(() => refreshProductReportIfDue({ query: async () => { throw new Error('db down'); } }, { now: () => now, log: () => {} }), /db down/);
});

test('SQL that (PGlite): doi ten khach/hang tren bang chu => product_report_customers ra TEN MOI; 2 khach khac ma cung ten gop 1 dong', async () => {
  const db = await bcChungFixture();
  try {
    // Hoa don da ghi ten cu trong raw; sau do doi ten tren bang chu (HN#1, SG#1 va them khach C3 khac ma, cung ten sai hoa/khoang trang).
    await db.exec(`
      UPDATE invoices SET raw = raw || '{"customerName":"KH Cu"}'::jsonb;
      UPDATE customers SET name = 'KH Moi' WHERE id = 1;
      INSERT INTO customers VALUES ('hanoi', 3, 'C3', 'kh   MOI', '{}');
      UPDATE invoices SET customer_id = 3 WHERE branch = 'hanoi' AND id = 100;`);
    await db.query(__sql__.REFRESH_SQL, [['hanoi', 'saigon']]);
    const rows = (await db.query('SELECT customer_key, customer_name FROM product_report_customers WHERE product_key = $1', ['a'])).rows;
    assert.equal(rows.length, 1, 'cung ten (chuan hoa) khac ma = 1 khach');
    assert.equal(rows[0].customer_key, 'name:kh moi');
    assert.match(rows[0].customer_name, /^kh +moi$/i);
    assert.doesNotMatch(rows[0].customer_name, /Cu/);
  } finally { await db.close(); }
});

test('SQL rolling periods: exact 30-day boundaries, signed returns, sum and persisted VN end in both modes', async () => {
  const incremental = require('./productReportIncremental');
  for (const includeToday of [false, true]) {
    const db = await bcChungFixture();
    try {
      await db.exec('DELETE FROM invoice_details; DELETE FROM invoices; DELETE FROM return_details; DELETE FROM returns;');
      const endOffset = includeToday ? 0 : 1;
      const at = n => `(((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ${n + endOffset})::timestamp AT TIME ZONE 'UTC')`;
      for (const [id, day] of [0,29,30,59,60,89,90,-1].entries()) {
        await db.exec(`INSERT INTO invoices VALUES ('hanoi', ${id}, 1, ${at(day)}, '{}');
          INSERT INTO invoice_details VALUES ('hanoi', ${id}, 1, 1, ${day === 90 || day === -1 ? 10000 : 100}, 0, '{}');`);
      }
      await db.exec(`INSERT INTO returns VALUES ('hanoi', 1, 1, ${at(30)}, '{"statusValue":"Đã trả"}');
        INSERT INTO return_details VALUES ('hanoi', 1, 1, 1, 250, '{}');`);
      if (includeToday) {
        for (const statement of incremental.__sql__.CREATE_STAGE_SQL) await db.exec(statement.replace(' ON COMMIT DROP',''));
        await db.query(incremental.__sql__.fillCustomers, [['hanoi','saigon']]);
        await db.query(incremental.__sql__.INSERT_CUSTOMERS_SQL);
        await db.query(incremental.__sql__.UPSERT_STATE_SQL, [true,true]);
      } else await db.query(__sql__.REFRESH_SQL, [['hanoi','saigon']]);
      const row = (await db.query(`SELECT revenue::float8 AS total, revenue_1_30d::float8 AS p1,
        revenue_31_60d::float8 AS p2, revenue_61_90d::float8 AS p3 FROM product_report_customers WHERE product_key='a'`)).rows[0];
      assert.deepEqual(row, {total:350,p1:200,p2:-50,p3:200});
      assert.equal(row.p1+row.p2+row.p3,row.total);
      const state = (await db.query(`SELECT customer_window_end = (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - ${endOffset} AS correct FROM product_report_state`)).rows[0];
      assert.equal(state.correct,true);
    } finally { await db.close(); }
  }
});
