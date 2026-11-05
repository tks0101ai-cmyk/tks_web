'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getProductReport, getProductReportCustomers, PRODUCT_REPORT_PRICE_KEYS, __test__
} = require('./productReportRepository');

test('getProductReport chi giu ma dang kinh doanh o it nhat mot co so, ke ca het ton/chua ban', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const fs = require('node:fs');
  const path = require('node:path');
  const db = new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0018_product_report.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0057_product_report_branch_columns.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0063_product_report_price_columns.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0067_product_report_bc_chung.sql'), 'utf8'));
    await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0053_product_containers.sql'), 'utf8'));
    await db.exec(`
      CREATE TABLE products (branch text, code text, is_active boolean);
      INSERT INTO products VALUES
        ('hanoi', 'ACTIVE', true), ('saigon', 'ACTIVE', true),
        ('hanoi', 'SG_ONLY', false), ('saigon', 'SG_ONLY', true),
        ('hanoi', 'STOPPED', false), ('saigon', 'STOPPED', false),
        ('hanoi', 'UNKNOWN', null);
      INSERT INTO product_report (product_code, product_name) VALUES
        ('ACTIVE', 'Active'), ('SG_ONLY', 'Active SG'),
        ('STOPPED', 'Stopped'), ('UNKNOWN', 'Unknown'), ('MISSING', 'Missing');
    `);
    const result = await getProductReport({ pool: db });
    assert.deepEqual(result.rows.map(row => row.code), ['ACTIVE', 'SG_ONLY', 'UNKNOWN']);
    assert.equal(result.rows[0].availableToSell, 0);
    assert.equal(result.rows[0].revenue90d, 0);
    // Dong chua duoc tinh lai sau migration 0057: cot theo co so la NULL -> null / chuoi rong, khong gia thanh 0.
    assert.equal(result.rows[0].availableHanoi, null);
    assert.equal(result.rows[0].availableSaigon, null);
    assert.equal(result.rows[0].descriptionHanoi, '');
    assert.equal(result.rows[0].descriptionSaigon, '');
    assert.equal(result.rows[0].priceHanoi, null);
    assert.equal(result.rows[0].priceSaigon, null);
    // Migration 0067: cot chua tinh lai la null, so ngay dut khong co dong trong product_stockout_days la 0.
    assert.equal(result.rows[0].qtySold30dHanoi, null);
    assert.equal(result.rows[0].orders90d, null);
    assert.equal(result.rows[0].stockoutDaysHanoi, 0);
    assert.equal(result.rows[0].stockoutDaysSaigon, 0);

    // Trang thai moi phai co hieu luc ca khi snapshot ban dem chua duoc tinh lai.
    await db.exec("UPDATE products SET is_active = false WHERE code = 'ACTIVE'");
    const updated = await getProductReport({ pool: db });
    assert.deepEqual(updated.rows.map(row => row.code), ['SG_ONLY', 'UNKNOWN']);
  } finally {
    await db.close();
  }
});

test('mapRow chuyen doi cot Postgres (snake_case, string so) sang camelCase (number)', () => {
  const row = __test__.mapRow({
    product_code: 'SP001',
    product_name: 'San pham 1',
    stock_hanoi: '10',
    stock_saigon: '5',
    available_to_sell: '12',
    qty_sold_30d: '3',
    revenue_90d: '900000',
    customer_count_90d: '2',
    top_customer_revenue_90d: '500000',
    top_customer_name: 'Nguyen Van A',
    top_customer_share: '0.5555',
    available_hanoi: '7',
    available_saigon: '-2',
    description_hanoi: 'T50 # 30/9 # 1T -37200',
    description_saigon: null,
    price_hanoi: '12000',
    price_saigon: null,
    qty_sold_30d_hanoi: '2',
    qty_sold_30d_saigon: '1',
    orders_30d: '4',
    orders_90d: '9',
    stockout_days_hanoi: '3',
    stockout_days_saigon: null,
    computed_at: '2026-09-23T00:05:00.000Z'
  });
  assert.deepEqual(row, {
    code: 'SP001', name: 'San pham 1', stockHanoi: 10, stockSaigon: 5, availableToSell: 12,
    availableHanoi: 7, availableSaigon: -2, descriptionHanoi: 'T50 # 30/9 # 1T -37200', descriptionSaigon: '',
    priceHanoi: 12000, priceSaigon: null,
    qtySold30dHanoi: 2, qtySold30dSaigon: 1, orders30d: 4, orders90d: 9, stockoutDaysHanoi: 3, stockoutDaysSaigon: 0,
    qtySold30d: 3, revenue90d: 900000, customerCount90d: 2, topCustomerRevenue90d: 500000,
    topCustomerName: 'Nguyen Van A', topCustomerShare: 0.5555, computedAt: '2026-09-23T00:05:00.000Z'
  });
});

test('mapRow: cot theo co so NULL (chua tinh lai sau migration 0057) -> null/chuoi rong, so 0 that van la 0', () => {
  const pending = __test__.mapRow({ product_code: 'SP003', product_name: 'SP3', available_hanoi: null, available_saigon: undefined });
  assert.equal(pending.availableHanoi, null);
  assert.equal(pending.availableSaigon, null);
  assert.equal(pending.descriptionHanoi, '');
  assert.equal(pending.descriptionSaigon, '');
  const zero = __test__.mapRow({ product_code: 'SP004', product_name: 'SP4', available_hanoi: '0', available_saigon: 0 });
  assert.equal(zero.availableHanoi, 0);
  assert.equal(zero.availableSaigon, 0);
});

test('mapRow tra ve topCustomerShare null neu khong co du lieu (thay vi NaN/0)', () => {
  const row = __test__.mapRow({
    product_code: 'SP002', product_name: 'SP2', stock_hanoi: 0, stock_saigon: 0, available_to_sell: 0,
    qty_sold_30d: 0, revenue_90d: 0, customer_count_90d: 0, top_customer_revenue_90d: 0,
    top_customer_name: null, top_customer_share: null, computed_at: null
  });
  assert.equal(row.topCustomerShare, null);
  assert.equal(row.topCustomerName, '');
});

test('getProductReport doc bang product_report va tinh computedAt = moc gan nhat', async () => {
  const pool = {
    calls: [],
    query: async function (sql) {
      this.calls.push(sql);
      return {
        rows: [
          { product_code: 'A', product_name: 'A', stock_hanoi: 1, stock_saigon: 0, available_to_sell: 1, qty_sold_30d: 0, revenue_90d: 0, customer_count_90d: 0, top_customer_revenue_90d: 0, top_customer_name: null, top_customer_share: null, computed_at: '2026-09-23T00:05:00.000Z' },
          { product_code: 'B', product_name: 'B', stock_hanoi: 1, stock_saigon: 0, available_to_sell: 1, qty_sold_30d: 0, revenue_90d: 0, customer_count_90d: 0, top_customer_revenue_90d: 0, top_customer_name: null, top_customer_share: null, computed_at: '2026-09-23T00:06:00.000Z' }
        ]
      };
    }
  };
  const result = await getProductReport({ pool });
  // 1 cau doc state (chua co migration 0055 => luong cu) + dong bao cao + tong CONT + hang van chuyen + YC dieu chuyen.
  assert.equal(pool.calls.length, 5);
  assert.match(pool.calls[0], /FROM product_report_state/);
  assert.match(pool.calls[1], /FROM product_report\s/);
  assert.equal(result.rows.length, 2);
  assert.equal(result.computedAt, '2026-09-23T00:06:00.000Z');
});

test('getProductReport tra computedAt = null neu bang rong', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const result = await getProductReport({ pool });
  assert.deepEqual(result.rows, []);
  assert.equal(result.computedAt, null);
  assert.equal(result.containerSync.available, false);
});

test('getProductReportCustomers tra khach xep giam dan theo doanh so, share = khach / tong cac khach', async () => {
  const pool = {
    calls: [],
    query: async function (sql, params) {
      this.calls.push({ sql, params });
      return {
        rows: [
          { customer_name: 'KH A', revenue: '600000' },
          { customer_name: 'KH B', revenue: '300000' },
          { customer_name: 'Khách lẻ', revenue: '100000' }
        ]
      };
    }
  };
  const result = await getProductReportCustomers({ code: ' sp001 ', pool });

  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /FROM product_report_customers/);
  assert.match(pool.calls[0].sql, /product_key = lower\(btrim\(\$1\)\)/);
  assert.match(pool.calls[0].sql, /ORDER BY revenue DESC/);
  assert.deepEqual(pool.calls[0].params, [' sp001 ']);
  assert.equal(result.code, 'sp001');
  assert.equal(result.totalRevenue, 1000000);
  assert.equal(result.customerCount, 3);
  assert.deepEqual(result.rows, [
    { customerName: 'KH A', revenue: 600000, revenue1_30d:null, revenue31_60d:null, revenue61_90d:null, share: 0.6 },
    { customerName: 'KH B', revenue: 300000, revenue1_30d:null, revenue31_60d:null, revenue61_90d:null, share: 0.3 },
    { customerName: 'Khách lẻ', revenue: 100000, revenue1_30d:null, revenue31_60d:null, revenue61_90d:null, share: 0.1 }
  ]);
  assert.ok(Math.abs(result.rows.reduce((sum, row) => sum + row.share, 0) - 1) < 1e-9);
});

test('getProductReportCustomers tra rows rong (khong loi) neu ma hang chua co du lieu khach', async () => {
  const pool = { query: async () => ({ rows: [] }) };
  const result = await getProductReportCustomers({ code: 'XYZ', pool });
  assert.deepEqual(result, { code: 'XYZ', totalRevenue: 0, customerCount: 0, periods: [], rows: [] });
});

test('getProductReportCustomers dat share = null neu tong doanh so = 0 (tranh chia cho 0)', async () => {
  const pool = { query: async () => ({ rows: [{ customer_name: 'KH A', revenue: '0' }] }) };
  const result = await getProductReportCustomers({ code: 'A', pool });
  assert.equal(result.rows[0].share, null);
  assert.equal(result.totalRevenue, 0);
});

test('getProductReportCustomers nem loi 400 neu thieu ma hang', async () => {
  const pool = { query: async () => { throw new Error('khong duoc goi DB'); } };
  await assert.rejects(
    () => getProductReportCustomers({ code: '   ', pool }),
    (error) => error.statusCode === 400 && /mã hàng/i.test(error.message)
  );
  await assert.rejects(() => getProductReportCustomers({ pool }), (error) => error.statusCode === 400);
});


test('Điều chuyển SG uses the existing DB transit source per normalized code', async () => {
  const pool = { query: async (sql, params) => {
    if (sql.includes('-- in-transit:')) {
      assert.deepEqual(params, ['Đã xác nhận NCC']);
      return {rows:[{product_key:'sku-01',qty:'175.5'}]};
    }
    if (sql.includes('FROM product_report')) return {rows:[{product_code:'SKU-01',stock_hanoi:10,stock_saigon:20,available_to_sell:25}]};
    return {rows:[]};
  }};
  const result = await getProductReport({pool});
  assert.equal(result.rows[0].inTransit,175.5);
  assert.equal(result.rows[0].availableToSell,200.5);
});

test('YC dieu chuyen: cong vao Tong co ban + Tong ton thuc, ngay can dat / ngay 2 mien doi theo; SQL loc Phieu tam + hanoi + KH010020', async () => {
  const seen = [];
  const pool = { query: async (sql, params) => {
    if (sql.includes('-- transfer-request:')) {
      seen.push({ sql, params });
      return { rows: [{ product_key: 'sku-01', qty: '40' }] };
    }
    if (sql.includes('-- in-transit:')) return { rows: [{ product_key: 'sku-01', qty: '10' }] };
    if (sql.includes('FROM product_report')) {
      return { rows: [
        { product_code: 'SKU-01', stock_hanoi: 100, stock_saigon: 50, available_to_sell: 120, qty_sold_30d: 300 },
        { product_code: 'SKU-02', stock_hanoi: 1, stock_saigon: 1, available_to_sell: 2, qty_sold_30d: 0 }
      ] };
    }
    return { rows: [] };
  } };
  const [a, b] = (await getProductReport({ pool })).rows;
  assert.equal(a.transferRequest, 40);
  assert.equal(a.availableToSell, 170, '120 + Dieu chuyen SG 10 + YC dieu chuyen 40');
  assert.equal(a.totalStock, 200, '100 + 50 + 10 + 40');
  assert.equal(a.daysBothBranches, 17, '170 * 30 / 300');
  assert.equal(b.transferRequest, 0);
  assert.equal(b.availableToSell, 2);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].params, ['hanoi', 'Phiếu tạm', 'KH010020']);
  assert.match(seen[0].sql, /\(raw->>'statusValue'\) = \$2/);
  assert.match(seen[0].sql, /customerCode' = \$3/);
});

test('YC dieu chuyen: cache 60 giay theo bo doc va FAIL-SOFT (loi DB => 0, bao cao van doc duoc)', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  let transferCalls = 0;
  let failing = false;
  const pool = { query: async (sql) => {
    if (sql.includes('-- transfer-request:')) {
      transferCalls += 1;
      if (failing) throw new Error('boom');
      return { rows: [{ product_key: 'sku-01', qty: '5' }] };
    }
    if (sql.includes('FROM product_report_state')) return { rows: [{ version: '1', computed_at: '2026-10-21T00:00:00Z' }] };
    if (sql.includes('FROM product_report pr')) return { rows: [{ product_code: 'SKU-01', available_to_sell: 1 }] };
    return { rows: [] };
  } };
  let clock = 0;
  const reader = createProductReportReader({ pool, now: () => clock });
  assert.equal((await reader.read()).rows[0].transferRequest, 5);
  clock = 30 * 1000; await reader.read();
  assert.equal(transferCalls, 1, 'trong 60 giay khong doc lai');
  clock = 61 * 1000; failing = true;
  const after = await reader.read();
  assert.equal(transferCalls, 2);
  assert.equal(after.rows[0].transferRequest, 0, 'loi DB => Map rong => 0');
  assert.equal(after.rows[0].availableToSell, 1);
});

test('daysToOrder = (Tong co ban + Chua boc + Da boc) * 30 / SL ban 30 ngay, lam tron 1 so le; null khi khong tinh duoc', () => {
  const { daysToOrder } = __test__;
  assert.equal(daysToOrder(799, 3000, 0, 3500), 32.6); // 3799 * 30 / 3500 = 32,56...
  assert.equal(daysToOrder(0, 0, 0, 10), 0);
  assert.equal(daysToOrder(-2800, 1500, 3500, 4200), 15.7); // am van tinh dung, khong ep ve 0
  assert.equal(daysToOrder(-9000, 0, 0, 30), -9000);
  assert.equal(daysToOrder(7, 0, 0, 3), 70, 'nhan truoc roi chia: 7 / 3 * 30 se ra 70.00000000000001');
  assert.equal(daysToOrder(100, 0, 0, 0), null, 'khong ban duoc ngay nao (chia cho 0) => null, khong Infinity/NaN');
  assert.equal(daysToOrder(100, null, 5, 10), null, 'chua co snapshot CONT => null');
  assert.equal(daysToOrder(100, 5, null, 10), null);
  assert.equal(daysToOrder(100, 0, 0, -3), null);
});

test('hang bao cao tra them Co ban/Mo ta theo co so, Tong ton thuc + DC va Ngay can dat (cung cho route va xuat file)', async () => {
  const pool = { query: async (sql) => {
    if (sql.includes('-- in-transit:')) return { rows: [{ product_key: 'sku-01', qty: '500' }, { product_key: 'sku-02', qty: '0.4' }] };
    if (sql.includes('FROM product_report')) {
      return { rows: [
        { product_code: 'SKU-01', stock_hanoi: 799, stock_saigon: 200, available_to_sell: 150, qty_sold_30d: 3500,
          available_hanoi: 100, available_saigon: 50, description_hanoi: 'T50 # 30/9', description_saigon: null },
        { product_code: 'SKU-02', stock_hanoi: 16, stock_saigon: 0, available_to_sell: 7, qty_sold_30d: 0,
          available_hanoi: null, available_saigon: null, description_hanoi: null, description_saigon: null }
      ] };
    }
    return { rows: [] };
  } };
  const [first, second] = (await getProductReport({ pool })).rows;
  assert.equal(first.availableHanoi, 100);
  assert.equal(first.availableSaigon, 50);
  assert.equal(first.inTransit, 500);
  assert.equal(first.availableToSell, 650, 'co ban HN + co ban SG + dieu chuyen');
  assert.equal(first.availableToSell, first.availableHanoi + first.availableSaigon + first.inTransit);
  assert.equal(first.totalStock, 1499, 'ton thuc HN + ton thuc SG + dieu chuyen');
  assert.equal(first.descriptionHanoi, 'T50 # 30/9');
  assert.equal(first.descriptionSaigon, '');
  assert.equal(first.unloadedQty, null, 'chua co snapshot CONT');
  assert.equal(first.daysToOrder, null, 'chua co snapshot CONT => khong tinh Ngay can dat');
  assert.equal(second.availableHanoi, null);
  assert.equal(second.totalStock, 16.4, 'lam tron 3 so le, khong ra 16.400000000000002');
  assert.equal(second.daysToOrder, null);
});

// ---- Bo doc theo phien ban (product_report_state, migration 0055) ----
async function versionedFixture() {
  const { PGlite } = require('@electric-sql/pglite');
  const fs = require('node:fs');
  const path = require('node:path');
  const migrations = path.join(__dirname, '../db/migrations');
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(migrations, '0018_product_report.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '0057_product_report_branch_columns.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '0067_product_report_bc_chung.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '0053_product_containers.sql'), 'utf8'));
  const m55 = fs.readFileSync(path.join(migrations, '0055_product_report_state.sql'), 'utf8');
  await db.exec(m55.slice(m55.indexOf('CREATE TABLE'), m55.indexOf(');', m55.indexOf('CREATE TABLE')) + 2));
  await db.exec(`INSERT INTO product_report (product_code, product_name, stock_hanoi, available_to_sell, available_hanoi, available_saigon, qty_sold_30d, description_hanoi)
      VALUES ('A','Sp A',10,10,10,0,30,'Mo ta A'),('B','Sp B',5,5,NULL,NULL,0,NULL);
    INSERT INTO product_report_state (id, computed_at, version) VALUES (1, '2026-10-16T05:00:00Z', 3);
    UPDATE product_container_sync SET version='00000000-0000-4000-8000-000000000001', last_success_at=now();
    INSERT INTO product_container_lines(sheet_name,sheet_order,container_row,source_row,product_code,product_key,container_name,status,status_label,quantity)
    VALUES ('YIWU',0,1,2,'A','a','CONT A',2,'2.Chưa bốc',40);`);
  const calls = [];
  const pool = { query: (sql, args) => { calls.push(sql); return db.query(sql, args); } };
  return { db, pool, calls };
}
const reads = (calls, pattern) => calls.filter(sql => pattern.test(sql)).length;

test('bo doc theo phien ban: chi keo 10,9K dong ve khi version doi; tong CONT chi doc lai khi version CONT doi', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  const { db, pool, calls } = await versionedFixture();
  try {
    const reader = createProductReportReader({ pool, now: () => 1000 });
    const first = await reader.read();
    assert.equal(first.reportVersion, '3');
    assert.equal(new Date(first.computedAt).toISOString(), '2026-10-16T05:00:00.000Z');
    assert.deepEqual(first.rows.map(r => r.code), ['A', 'B']);
    assert.equal(first.rows[0].unloadedQty, 40);
    assert.equal(first.rows[0].availableHanoi, 10);
    assert.equal(first.rows[0].descriptionHanoi, 'Mo ta A');
    assert.equal(first.rows[0].daysToOrder, 50, '(10 + 40 + 0) * 30 / 30');
    assert.equal(first.rows[1].availableHanoi, null);
    assert.equal(first.rows[1].daysToOrder, null);
    assert.equal(reads(calls, /FROM product_report pr\b/), 1);
    assert.equal(reads(calls, /jsonb_object_agg/), 1);
    // Tuy y sua ket qua tra ve khong lam ban cache.
    first.rows[0].name = 'DA SUA';
    first.rows[0].availableToSell += 1000;

    const second = await reader.read();
    assert.equal(reads(calls, /FROM product_report pr\b/), 1, 'cung version => khong doc lai bang bao cao');
    assert.equal(reads(calls, /jsonb_object_agg/), 1, 'cung version CONT => khong doc lai tong CONT');
    assert.equal(second.rows[0].name, 'Sp A');
    assert.equal(second.rows[0].availableToSell, 10);

    // Version bao cao doi => doc lai bang bao cao, KHONG doc lai tong CONT.
    await db.exec("UPDATE product_report SET stock_hanoi = 77 WHERE product_code='A'; UPDATE product_report_state SET version = 4, computed_at = '2026-10-16T05:07:00Z'");
    const third = await reader.read();
    assert.equal(third.reportVersion, '4');
    assert.equal(third.rows[0].stockHanoi, 77);
    assert.equal(reads(calls, /FROM product_report pr\b/), 2);
    assert.equal(reads(calls, /jsonb_object_agg/), 1);

    // Version CONT doi => doc lai tong CONT.
    await db.exec("UPDATE product_container_sync SET version='00000000-0000-4000-8000-000000000002'; UPDATE product_container_lines SET quantity = 90");
    const fourth = await reader.read();
    assert.equal(fourth.rows[0].unloadedQty, 90);
    assert.equal(reads(calls, /jsonb_object_agg/), 2);
  } finally { await db.close(); }
});

test('bo doc theo phien ban: hang van chuyen cache theo TTL 60 giay, ban dau chua co CONT thi unloaded/loaded = null', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  const { db, pool, calls } = await versionedFixture();
  try {
    let clock = 0;
    const reader = createProductReportReader({ pool, now: () => clock });
    await reader.read();
    const transitReads = () => reads(calls, /order_suppliers/);
    const first = transitReads();
    clock = 30 * 1000; await reader.read();
    assert.equal(transitReads(), first, 'trong 60 giay khong doc lai');
    clock = 61 * 1000; await reader.read();
    assert.equal(transitReads(), first + 1, 'qua 60 giay doc lai mot lan');

    await db.exec('UPDATE product_container_sync SET version = NULL, last_success_at = NULL');
    const noContainers = await createProductReportReader({ pool }).read();
    assert.equal(noContainers.rows[0].unloadedQty, null);
    assert.equal(noContainers.rows[0].loadedQty, null);
  } finally { await db.close(); }
});

test('nhieu nguoi doc cung luc luc cache trong: chi keo bang bao cao 1 lan, moi nguoi van nhan ban rieng', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  const { db, pool, calls } = await versionedFixture();
  try {
    const reader = createProductReportReader({ pool, now: () => 1000 });
    const results = await Promise.all([reader.read(), reader.read(), reader.read(), reader.read(), reader.read()]);

    assert.equal(reads(calls, /FROM product_report pr\b/), 1, '5 nguoi cung luc => chi 1 lan keo bang bao cao');
    assert.equal(reads(calls, /product_report_state WHERE id = 1/), 1, 'chi 1 lan doc phien ban');
    assert.equal(reads(calls, /jsonb_object_agg/), 1, 'chi 1 lan doc tong CONT');
    assert.equal(reads(calls, /order_suppliers/) <= 2, true, 'hang van chuyen khong bi doc lai theo so nguoi');
    results.forEach((result) => {
      assert.equal(result.reportVersion, '3');
      assert.deepEqual(result.rows.map(r => r.code), ['A', 'B']);
    });

    // routes.js gan de data.rows de an cot gia theo quyen: nguoi nay sua khong duoc anh huong nguoi khac.
    assert.notEqual(results[0], results[1]);
    assert.notEqual(results[0].rows, results[1].rows);
    assert.notEqual(results[0].rows[0], results[1].rows[0]);
    results[0].rows[0].name = 'DA SUA';
    results[0].rows = [];
    assert.equal(results[1].rows.length, 2);
    assert.equal(results[1].rows[0].name, 'Sp A');

    // Xong luot gop thi lan doc sau phai thay du lieu moi, khong ket o ket qua cu.
    await db.exec("UPDATE product_report SET stock_hanoi = 77 WHERE product_code='A'; UPDATE product_report_state SET version = 4");
    const next = await reader.read();
    assert.equal(next.reportVersion, '4');
    assert.equal(next.rows[0].stockHanoi, 77);
    assert.equal(reads(calls, /FROM product_report pr\b/), 2);
  } finally { await db.close(); }
});

test('luot doc gop bi loi: moi nguoi cung luc nhan loi, lan doc sau thu lai duoc', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  const { db, pool, calls } = await versionedFixture();
  try {
    let failNext = true;
    const flaky = {
      query: (sql, args) => {
        if (failNext && /FROM product_report pr\b/.test(sql)) {
          failNext = false;
          return Promise.reject(new Error('DB tam loi'));
        }
        return pool.query(sql, args);
      }
    };
    const reader = createProductReportReader({ pool: flaky, now: () => 1000 });
    const settled = await Promise.allSettled([reader.read(), reader.read(), reader.read()]);
    settled.forEach((item) => {
      assert.equal(item.status, 'rejected');
      assert.equal(item.reason.message, 'DB tam loi');
    });

    const retried = await reader.read();
    assert.deepEqual(retried.rows.map(r => r.code), ['A', 'B']);
    assert.equal(reads(calls, /FROM product_report pr\b/), 1, 'lan loi khong toi DB, lan thu lai toi DB dung 1 lan');
  } finally { await db.close(); }
});

test('chua co product_report_state: luong cu cung gop luot doc va tra ban rieng cho tung nguoi', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  const { db, pool, calls } = await versionedFixture();
  try {
    await db.exec(`DROP TABLE product_report_state;
      CREATE TABLE products (code text, branch text, is_active boolean);
      INSERT INTO products VALUES ('A','hanoi',true),('B','hanoi',true);`);
    const reader = createProductReportReader({ pool, now: () => 1000 });
    const [first, second] = await Promise.all([reader.read(), reader.read()]);
    assert.equal(reads(calls, /FROM product_report pr\b/), 1, '2 nguoi cung luc => chi 1 lan keo bang bao cao');
    assert.equal(first.reportVersion, null);
    assert.deepEqual(first.rows.map(r => r.code), ['A', 'B']);
    assert.notEqual(first.rows, second.rows);
    assert.notEqual(first.rows[0], second.rows[0]);
  } finally { await db.close(); }
});

test('getProductReportVersion tra phien ban hoac null (chua migrate/loi), khong nem loi', async () => {
  const { getProductReportVersion } = require('./productReportRepository');
  const { db, pool } = await versionedFixture();
  try {
    assert.equal(await getProductReportVersion({ pool }), '3');
    await db.exec('DELETE FROM product_report_state');
    assert.equal(await getProductReportVersion({ pool }), null);
    assert.equal(await getProductReportVersion({ pool: { query: async () => { throw Object.assign(new Error('x'), { code: '42P01' }); } } }), null);
    assert.equal(await getProductReportVersion({ pool: { query: async () => { throw new Error('db down'); } } }), null);
  } finally { await db.close(); }
});

test('bang state rong (chua tung chay tang dan) => luong cu loc is_active luc doc, reportVersion = null', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  const { db, pool } = await versionedFixture();
  try {
    await db.exec(`DELETE FROM product_report_state;
      CREATE TABLE products (branch text, code text, is_active boolean);
      INSERT INTO products VALUES ('hanoi','A',true),('hanoi','B',false),('saigon','B',false);`);
    const result = await createProductReportReader({ pool }).read();
    assert.equal(result.reportVersion, null);
    assert.deepEqual(result.rows.map(r => r.code), ['A']);
  } finally { await db.close(); }
});

// ---- Migration 0067: cot BC CHUNG (SL 30 theo co so, SL don, ngay dut) + cot suy ra ----
test('PRODUCT_REPORT_PRICE_KEYS: don gia + gia tri co ban cua hai co so', () => {
  assert.deepEqual([...PRODUCT_REPORT_PRICE_KEYS], ['priceHanoi', 'priceSaigon', 'availableValueHanoi', 'availableValueSaigon']);
});

test('daysOfCover = so luong * 30 / SL ban 30 ngay, lam tron 1 so le; mau so <= 0 hoac null => null', () => {
  const { daysOfCover } = __test__;
  assert.equal(daysOfCover(100, 2000), 1.5);
  assert.equal(daysOfCover(7, 3), 70, 'nhan truoc roi chia');
  assert.equal(daysOfCover(-30, 10), -90, 'am van tinh dung');
  assert.equal(daysOfCover(0, 10), 0);
  assert.equal(daysOfCover(10, 0), null);
  assert.equal(daysOfCover(10, -1), null);
  assert.equal(daysOfCover(10, null), null);
  assert.equal(daysOfCover(null, 10), null);
});

function mockPool(rows, transit = []) {
  return { query: async (sql) => {
    if (sql.includes('FROM product_report_state')) return { rows: [] };
    if (sql.includes('-- in-transit:')) return { rows: transit };
    if (sql.includes('FROM product_report')) return { rows };
    return { rows: [] };
  } };
}

test('compose: gia tri co ban, ngay HN / SG + DC / 2 mien, tang truong don (null khi thieu ve hoac mau so <= 0, giu so am)', async () => {
  const full = {
    product_code: 'SKU-01', stock_hanoi: 799, stock_saigon: 200, available_to_sell: 150, qty_sold_30d: 3500,
    qty_sold_30d_hanoi: 2000, qty_sold_30d_saigon: 1500, orders_30d: 30, orders_90d: 60,
    available_hanoi: 100, available_saigon: 50, price_hanoi: 12000, price_saigon: 12500,
    stockout_days_hanoi: 4, stockout_days_saigon: 9
  };
  const negative = {
    product_code: 'SKU-02', available_to_sell: -2, qty_sold_30d: 0, qty_sold_30d_hanoi: 0, qty_sold_30d_saigon: 10,
    orders_30d: 5, orders_90d: 0, available_hanoi: -4, available_saigon: 2, price_hanoi: 1000, price_saigon: null
  };
  const pending = { product_code: 'SKU-03', available_to_sell: 5, qty_sold_30d: 10 }; // moi ap migration: moi cot moi deu NULL
  const result = await getProductReport({ pool: mockPool([full, negative, pending], [{ product_key: 'sku-01', qty: '500' }]) });
  const [a, b, c] = result.rows;
  assert.equal(a.availableValueHanoi, 1200000);
  assert.equal(a.availableValueSaigon, 625000);
  assert.equal(a.daysHanoi, 1.5, '100 * 30 / 2000');
  assert.equal(a.daysSaigonTransit, 11, '(500 + 50) * 30 / 1500');
  assert.equal(a.availableToSell, 650);
  assert.equal(a.daysBothBranches, 5.6, '650 * 30 / 3500 = 5,57');
  assert.equal(a.ordersGrowth, 0.5, '30 * 3 / 60 - 1');
  assert.equal(a.stockoutDaysHanoi, 4);
  assert.equal(a.stockoutDaysSaigon, 9);

  assert.equal(b.availableValueHanoi, -4000, 'co ban am van ra gia tri am, khong loc');
  assert.equal(b.availableValueSaigon, null, 'thieu don gia SG');
  assert.equal(b.daysHanoi, null, 'khong ban duoc ngay nao');
  assert.equal(b.daysSaigonTransit, 6, '(0 + 2) * 30 / 10');
  assert.equal(b.daysBothBranches, null);
  assert.equal(b.ordersGrowth, null, 'SL don 90 ngay = 0');

  for (const key of ['qtySold30dHanoi', 'qtySold30dSaigon', 'orders30d', 'orders90d', 'availableValueHanoi', 'availableValueSaigon',
    'daysHanoi', 'daysSaigonTransit', 'ordersGrowth']) {
    assert.equal(c[key], null, key + ' null khi dong chua tinh lai');
  }
  assert.equal(c.daysBothBranches, 15, 'cot nay chi can SL 30 ngay tong da co: 5 * 30 / 10');
  assert.equal(c.stockoutDaysHanoi, 0);
  assert.equal(c.stockoutDaysSaigon, 0);
});

test('bo doc join product_stockout_days theo lower(btrim(ma)), thieu dong => 0', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  const { db, pool } = await versionedFixture();
  try {
    await db.exec("INSERT INTO product_stockout_days (product_key, product_code, days_hanoi, days_saigon) VALUES ('a', 'a ', 3, 7);");
    const versioned = await createProductReportReader({ pool }).read();
    const [a, b] = versioned.rows;
    assert.deepEqual([a.stockoutDaysHanoi, a.stockoutDaysSaigon], [3, 7]);
    assert.deepEqual([b.stockoutDaysHanoi, b.stockoutDaysSaigon], [0, 0]);

    // Luong cu (chua co state) cung join.
    await db.exec(`DELETE FROM product_report_state;
      CREATE TABLE products (branch text, code text, is_active boolean);
      INSERT INTO products VALUES ('hanoi','A',true),('hanoi','B',true);`);
    const legacy = await createProductReportReader({ pool }).read();
    assert.equal(legacy.reportVersion, null);
    assert.deepEqual(legacy.rows.map(r => [r.code, r.stockoutDaysHanoi, r.stockoutDaysSaigon]), [['A', 3, 7], ['B', 0, 0]]);
  } finally { await db.close(); }
});

test('FAIL-SOFT: chua ap migration 0067 (khong co bang product_stockout_days, 42P01) => van doc duoc, ngay dut = 0', async () => {
  const { createProductReportReader } = require('./productReportRepository');
  const { db, pool } = await versionedFixture();
  try {
    await db.exec('DROP TABLE product_stockout_days');
    // Nhanh co state (doc theo phien ban).
    const versioned = await createProductReportReader({ pool }).read();
    assert.deepEqual(versioned.rows.map(r => r.code), ['A', 'B']);
    assert.deepEqual(versioned.rows.map(r => [r.stockoutDaysHanoi, r.stockoutDaysSaigon]), [[0, 0], [0, 0]]);
    // Nhanh legacy (khong co state).
    await db.exec(`DELETE FROM product_report_state;
      CREATE TABLE products (branch text, code text, is_active boolean);
      INSERT INTO products VALUES ('hanoi','A',true);`);
    const legacy = await createProductReportReader({ pool }).read();
    assert.deepEqual(legacy.rows.map(r => [r.code, r.stockoutDaysHanoi, r.stockoutDaysSaigon]), [['A', 0, 0]]);
  } finally { await db.close(); }
});

test('FAIL-SOFT chi nuot 42P01: loi khac van duoc nem ra', async () => {
  const pool = { query: async (sql) => {
    if (sql.includes('FROM product_report_state')) return { rows: [] };
    if (sql.includes('product_stockout_days')) throw Object.assign(new Error('permission denied'), { code: '42501' });
    return { rows: [] };
  } };
  await assert.rejects(() => getProductReport({ pool }), /permission denied/);
});

test('customer periods derive from saved end, preserve signed zero/null and do not fabricate missing snapshots', async () => {
  const row={customer_name:'A',revenue:'100',revenue_1_30d:'0',revenue_31_60d:'-10',revenue_61_90d:'110',customer_window_end:'2026-03-01'};
  const pool={query:async()=>({rows:[row]})};
  const result=await getProductReportCustomers({code:'A',pool});
  assert.deepEqual(result.periods,[
    {key:'1_30d',label:'T.này',from:'2026-01-31',to:'2026-03-01'},
    {key:'31_60d',label:'T.trước',from:'2026-01-01',to:'2026-01-30'},
    {key:'61_90d',label:'T.trước nữa',from:'2025-12-02',to:'2025-12-31'}
  ]);
  assert.deepEqual([result.rows[0].revenue1_30d,result.rows[0].revenue31_60d,result.rows[0].revenue61_90d],[0,-10,110]);
  row.revenue_31_60d=null;
  assert.equal((await getProductReportCustomers({code:'A',pool})).rows[0].revenue31_60d,null);
  row.customer_window_end=null;
  const missing=await getProductReportCustomers({code:'A',pool});
  assert.deepEqual(missing.periods,[]);
  assert.equal(missing.rows[0].revenue1_30d,null);
});

test('SQL customer snapshot reads saved dates with rows and returns dates even for an empty product', async () => {
  const fs=require('node:fs');
  const path=require('node:path');
  const {PGlite}=require('@electric-sql/pglite');
  const db=new PGlite();
  try {
    await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0023_product_report_customers.sql'),'utf8'));
    await db.exec('CREATE TABLE product_report_state (id smallint PRIMARY KEY, customer_window_end date)');
    await db.exec('ALTER TABLE product_report_state DROP COLUMN customer_window_end');
    await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0108_product_customer_periods.sql'),'utf8'));
    await db.exec("INSERT INTO product_report_customers VALUES ('a','name:a','A',100,0,-10,110)");
    let result=await getProductReportCustomers({code:'A',pool:db});
    assert.deepEqual(result.periods,[]);
    assert.equal(result.rows[0].revenue1_30d,null);
    await db.exec("INSERT INTO product_report_state VALUES (1,'2026-03-01')");
    result=await getProductReportCustomers({code:'A',pool:db});
    assert.equal(result.periods[0].to,'2026-03-01');
    assert.equal(result.rows[0].revenue31_60d,-10);
    result=await getProductReportCustomers({code:'EMPTY',pool:db});
    assert.equal(result.periods[0].to,'2026-03-01');
    assert.deepEqual(result.rows,[]);
    await db.exec(fs.readFileSync(path.join(__dirname,'../db/rollbacks/0108_product_customer_periods.down.sql'),'utf8'));
  } finally {await db.close();}
});
