'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { refreshProductReportIncremental, buildSql, __sql__, __test__ } = require('./productReportIncremental');
const { refreshProductReportIfDue } = require('./productReportRefresh');

const NOW = new Date('2026-10-16T05:00:00Z'); // 12:00 ngay 16/10 theo lich VN
const FULL_TODAY = new Date('2026-10-15T17:30:00Z'); // 00:30 ngay 16/10 VN
const FULL_YESTERDAY = new Date('2026-10-14T17:30:00Z');

function fakeClient({ failOn = null, counts = {} } = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (failOn && sql === failOn) throw new Error('boom');
      if (sql === __sql__.UPSERT_STATE_SQL) return { rows: [{ version: '7', computed_at: NOW }], rowCount: 1 };
      return { rowCount: counts[sql] || 0, rows: [] };
    },
    release: () => {}
  };
}
function fakePool(client, { state, gate } = {}) {
  return {
    query: async sql => {
      if (sql === __sql__.READ_STATE_SQL) return { rows: state ? [state] : [] };
      if (sql === __sql__.GATE_SQL) return { rows: [gate || { invoices_changed: false, returns_changed: false, customers_changed: false }] };
      throw new Error('cau khong mong doi: ' + sql);
    },
    connect: async () => client
  };
}
const STATE_TODAY = { customer_window_end: '2026-10-16', computed_at: new Date('2026-10-16T04:55:00Z'), last_full_at: FULL_TODAY, version: '6' };

test('tat co => khong dong vao DB; thieu migration 0055 => bo qua', async () => {
  assert.deepEqual(await refreshProductReportIncremental({ query: async () => { throw new Error('khong duoc'); } }, { enabled: false }), { skipped: 'disabled' });
  for (const code of ['42P01', '42703']) {
    const pool = { query: async () => { throw Object.assign(new Error('x'), { code }); } };
    assert.deepEqual(await refreshProductReportIncremental(pool, { enabled: true, now: () => NOW }), { skipped: 'migration-missing' });
  }
  const pool = { query: async () => { throw new Error('db down'); } };
  await assert.rejects(() => refreshProductReportIncremental(pool, { enabled: true, now: () => NOW }), /db down/);
});

test('decideHeavy: chua co moc / sang ngay moi / co chung tu moi => nang; con lai => nhe', () => {
  const { decideHeavy } = __test__;
  const quiet = { invoices_changed: false, returns_changed: false, customers_changed: false };
  assert.equal(decideHeavy(null, null, NOW).heavy, true);
  assert.equal(decideHeavy({ last_full_at: null }, null, NOW).heavy, true);
  assert.deepEqual(decideHeavy({ last_full_at: FULL_YESTERDAY }, quiet, NOW), { heavy: true, reason: 'sang-ngay-moi' });
  for (const key of Object.keys(quiet)) {
    assert.deepEqual(decideHeavy({ last_full_at: FULL_TODAY, customer_window_end: '2026-10-16' }, { ...quiet, [key]: true }, NOW), { heavy: true, reason: 'co-chung-tu-moi' });
  }
  assert.deepEqual(decideHeavy({ last_full_at: FULL_TODAY, customer_window_end: '2026-10-16' }, quiet, NOW), { heavy: false, reason: 'khong-doi' });
  // Con dong orders_90d NULL (vua ap migration 0067 / ma moi do luot nhe them) => nang du khong co chung tu moi.
  assert.deepEqual(decideHeavy({ last_full_at: FULL_TODAY, customer_window_end: '2026-10-16' }, { ...quiet, orders_missing: true }, NOW), { heavy: true, reason: 'thieu-so-don' });
  assert.deepEqual(decideHeavy({ last_full_at: FULL_TODAY, customer_window_end: '2026-10-16' }, { ...quiet, orders_missing: false }, NOW), { heavy: false, reason: 'khong-doi' });
  assert.match(__sql__.GATE_SQL, /EXISTS \(SELECT 1 FROM product_report WHERE orders_90d IS NULL\) AS orders_missing/);
});

test('luot NHE (khong co chung tu moi) tu chuyen thanh NANG khi con dong chua co SL don', async () => {
  const client = fakeClient();
  const gate = { invoices_changed: false, returns_changed: false, customers_changed: false, orders_missing: true };
  const result = await refreshProductReportIncremental(fakePool(client, { state: STATE_TODAY, gate }), { enabled: true, now: () => NOW, log: () => {} });
  assert.equal(result.mode, 'heavy');
  assert.equal(result.reason, 'thieu-so-don');
  assert.ok(client.calls.some(c => c.sql === __sql__.fillCustomers));
});

test('luot NANG: nap khach vao bang tam, ghi khac biet ca 2 bang, danh dau last_full_at, 1 giao dich', async () => {
  const client = fakeClient({ counts: { [__sql__.UPDATE_PRODUCTS_SQL]: 3 } });
  const pool = fakePool(client, { state: STATE_TODAY, gate: { invoices_changed: true, returns_changed: false, customers_changed: false } });
  const logs = [];
  const result = await refreshProductReportIncremental(pool, { enabled: true, now: () => NOW, log: m => logs.push(m) });

  assert.deepEqual(client.calls.map(c => c.sql), [
    'BEGIN',
    __sql__.ADVISORY_LOCK_SQL,
    "SET LOCAL work_mem = '32MB'",
    "SET LOCAL statement_timeout = '60s'",
    ...__sql__.CREATE_STAGE_SQL,
    __sql__.fillCustomers,
    __sql__.fillProductsHeavy,
    __sql__.DELETE_CUSTOMERS_SQL, __sql__.UPDATE_CUSTOMERS_SQL, __sql__.INSERT_CUSTOMERS_SQL,
    __sql__.DELETE_PRODUCTS_SQL, __sql__.UPDATE_PRODUCTS_SQL, __sql__.INSERT_PRODUCTS_SQL,
    __sql__.UPSERT_STATE_SQL,
    'COMMIT'
  ]);
  const upsert = client.calls.find(c => c.sql === __sql__.UPSERT_STATE_SQL);
  assert.deepEqual(upsert.params, [true, true], 'changed=true (3 dong doi), heavy=true');
  assert.equal(result.mode, 'heavy');
  assert.equal(result.reason, 'co-chung-tu-moi');
  assert.equal(result.changed, true);
  assert.equal(result.version, 7);
  assert.match(logs[0], /heavy/);
});

test('luot NHE: khong dung toi phan nang/khach, doc khach lon nhat tu bang that, khong co thay doi => version giu nguyen', async () => {
  const client = fakeClient();
  const result = await refreshProductReportIncremental(fakePool(client, { state: STATE_TODAY }), { enabled: true, now: () => NOW, log: () => {} });
  const sqls = client.calls.map(c => c.sql);
  assert.equal(result.mode, 'light');
  assert.ok(sqls.includes(__sql__.fillProductsLight));
  assert.ok(!sqls.includes(__sql__.fillCustomers));
  assert.ok(![__sql__.DELETE_CUSTOMERS_SQL, __sql__.UPDATE_CUSTOMERS_SQL, __sql__.INSERT_CUSTOMERS_SQL].some(sql => sqls.includes(sql)));
  assert.deepEqual(client.calls.find(c => c.sql === __sql__.UPSERT_STATE_SQL).params, [false, false]);
  assert.equal(result.changed, false);
  assert.match(__sql__.fillProductsLight, /FROM product_report_customers\b/);
  assert.match(__sql__.fillProductsHeavy, /FROM pr_customers_new\b/);
});

test('loi giua chung => ROLLBACK, khong ghi state, nem loi', async () => {
  const client = fakeClient({ failOn: __sql__.INSERT_PRODUCTS_SQL });
  await assert.rejects(
    () => refreshProductReportIncremental(fakePool(client, { state: STATE_TODAY }), { enabled: true, now: () => NOW, log: () => {} }),
    /boom/
  );
  const sqls = client.calls.map(c => c.sql);
  assert.ok(sqls.includes('ROLLBACK'));
  assert.ok(!sqls.includes('COMMIT'));
  assert.ok(!sqls.includes(__sql__.UPSERT_STATE_SQL));
});

test('SQL tang dan: cua so gom hom nay (30 ngay = today-29..today, 90 ngay = today-89..today), nguon cat tu REFRESH_SQL', () => {
  const today = buildSql({ includeToday: true });
  const legacy = buildSql({ includeToday: false });
  assert.match(today.fillProductsHeavy, /dps\.sale_date >= vn_today\.today - 29 AND dps\.sale_date <= vn_today\.today\b(?! - )/);
  assert.match(today.fillProductsHeavy, /dps\.sale_date >= vn_today\.today - 89 AND dps\.sale_date <= vn_today\.today\b(?! - )/);
  assert.equal((today.fillCustomers.match(/\(vn_today\.today - 89\)::timestamp/g) || []).length, 2, 'hoa don + phieu tra');
  assert.equal((today.fillCustomers.match(/\(\(vn_today\.today \+ 1\)::timestamp AT TIME ZONE 'UTC'\)/g) || []).length, 2);
  // Cung cau nhung cua so cu (ket thuc hom qua) phai giu nguyen dinh nghia cua luot chot dem.
  assert.match(legacy.fillProductsHeavy, /vn_today\.today - 30 AND dps\.sale_date <= vn_today\.today - 1/);
  assert.match(legacy.fillCustomers, /\(vn_today\.today - 90\)::timestamp/);
  // Cung dinh nghia hoa don hop le / tra hang / tru phieu tam nhu luong chot dem.
  assert.match(today.fillCustomers, /!= 'Đã hủy'/);
  assert.match(today.fillCustomers, /r\.raw->>'statusValue' = 'Đã trả'/);
  assert.match(today.fillProductsHeavy, /\(raw->>'statusValue'\) = 'Phiếu tạm'/);
});

test('SQL tang dan: chi giu ma dang kinh doanh, xep hang on dinh, ghi khac biet khong TRUNCATE', () => {
  const all = Object.values(__sql__).flat().join('\n');
  assert.match(__sql__.fillProductsHeavy, /p\.is_active IS NOT FALSE/);
  assert.match(__sql__.fillProductsHeavy, /ORDER BY revenue DESC, customer_key/);
  assert.doesNotMatch(all, /TRUNCATE/i);
  assert.match(__sql__.UPDATE_PRODUCTS_SQL, /IS DISTINCT FROM/);
  assert.match(__sql__.UPDATE_CUSTOMERS_SQL, /IS DISTINCT FROM/);
  assert.match(__sql__.UPSERT_STATE_SQL, /product_report_state\.version \+ CASE WHEN \$1::boolean THEN 1 ELSE 0 END/);
});

test('IfDue che do tang dan: da chay phan nang hom nay => bo qua; chua => chay; chua migrate => luong cu', async () => {
  const stateQuery = rows => async sql => {
    if (sql === __sql__.READ_STATE_SQL) { if (rows instanceof Error) throw rows; return { rows }; }
    throw new Error('khong mong doi: ' + sql.slice(0, 40));
  };
  assert.deepEqual(
    await refreshProductReportIfDue({ query: stateQuery([{ last_full_at: FULL_TODAY, customer_window_end: '2026-10-16' }]) }, { incremental: true, now: () => NOW, log: () => {} }),
    { skipped: true }
  );
  // Chua co state => chay luot tang dan (khong TRUNCATE).
  const client = fakeClient();
  const pool = { query: async sql => (sql === __sql__.READ_STATE_SQL ? { rows: [] } : { rows: [{}] }), connect: async () => client };
  const result = await refreshProductReportIfDue(pool, { incremental: true, now: () => NOW, log: () => {} });
  assert.equal(result.skipped, false);
  assert.equal(result.mode, 'heavy');
  assert.ok(!client.calls.some(c => /TRUNCATE/i.test(c.sql)));
  // Thieu bang state => roi xuong luong chot dem cu (TRUNCATE).
  const legacyClient = fakeClient();
  const legacyPool = {
    query: async sql => {
      if (sql === __sql__.READ_STATE_SQL) throw Object.assign(new Error('missing'), { code: '42P01' });
      return { rows: [{ last_computed_at: null }] };
    },
    connect: async () => legacyClient
  };
  const legacy = await refreshProductReportIfDue(legacyPool, { incremental: true, now: () => NOW, log: () => {} });
  assert.equal(legacy.skipped, false);
  assert.ok(legacyClient.calls.some(c => /TRUNCATE/i.test(c.sql)));
});

// ---- SQL ghi khac biet tren Postgres that (PGlite) ----
async function diffFixture() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  const migrations = path.join(__dirname, '../db/migrations');
  await db.exec(fs.readFileSync(path.join(migrations, '0018_product_report.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '0023_product_report_customers.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '0057_product_report_branch_columns.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '0063_product_report_price_columns.sql'), 'utf8'));
  await db.exec(fs.readFileSync(path.join(migrations, '0067_product_report_bc_chung.sql'), 'utf8'));
  // Chi cau CREATE TABLE cua 0055 (cac index cua no can bang hoa don/khach cua DB that).
  const m55 = fs.readFileSync(path.join(migrations, '0055_product_report_state.sql'), 'utf8');
  await db.exec(m55.slice(m55.indexOf('CREATE TABLE'), m55.indexOf(');', m55.indexOf('CREATE TABLE')) + 2));
  await db.exec(fs.readFileSync(path.join(migrations, '0108_product_customer_periods.sql'), 'utf8'));
  for (const statement of __sql__.CREATE_STAGE_SQL) await db.exec(statement.replace(' ON COMMIT DROP', '')); // PGlite tu commit tung cau
  return db;
}
const ROW = (code, over = {}) => ({
  product_code: code, product_name: 'SP ' + code, stock_hanoi: 10, stock_saigon: 5, available_to_sell: 15, qty_sold_30d: 3,
  revenue_90d: 900000, customer_count_90d: 2, top_customer_revenue_90d: 500000, top_customer_name: 'KH A', top_customer_share: 0.5555555555,
  available_hanoi: 10, available_saigon: 5, description_hanoi: 'T50 # 30/9 | HN', description_saigon: 'T50 # 16/10 | SG',
  price_hanoi: 12000, price_saigon: 12500,
  qty_sold_30d_hanoi: 2, qty_sold_30d_saigon: 1, orders_30d: 4, orders_90d: 9,
  ...over
});
async function stage(db, rows) {
  await db.exec('DELETE FROM pr_new');
  for (const r of rows) {
    await db.query(`INSERT INTO pr_new (product_code, product_name, stock_hanoi, stock_saigon, available_to_sell, qty_sold_30d, revenue_90d,
      customer_count_90d, top_customer_revenue_90d, top_customer_name, top_customer_share,
      available_hanoi, available_saigon, description_hanoi, description_saigon, price_hanoi, price_saigon,
      qty_sold_30d_hanoi, qty_sold_30d_saigon, orders_30d, orders_90d, computed_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())`,
    [r.product_code, r.product_name, r.stock_hanoi, r.stock_saigon, r.available_to_sell, r.qty_sold_30d, r.revenue_90d,
      r.customer_count_90d, r.top_customer_revenue_90d, r.top_customer_name, r.top_customer_share,
      r.available_hanoi, r.available_saigon, r.description_hanoi, r.description_saigon, r.price_hanoi, r.price_saigon,
      r.qty_sold_30d_hanoi, r.qty_sold_30d_saigon, r.orders_30d, r.orders_90d]);
  }
}
async function applyProducts(db) {
  return {
    deleted: (await db.query(__sql__.DELETE_PRODUCTS_SQL)).affectedRows,
    updated: (await db.query(__sql__.UPDATE_PRODUCTS_SQL)).affectedRows,
    inserted: (await db.query(__sql__.INSERT_PRODUCTS_SQL)).affectedRows
  };
}

test('ghi khac biet product_report (SQL that): chi dong doi bi cham, dong y het giu nguyen ctid va computed_at', async () => {
  const db = await diffFixture();
  try {
    await stage(db, [ROW('A'), ROW('B'), ROW('C')]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 3 });
    const before = (await db.query('SELECT product_code, ctid::text AS ctid, computed_at::text AS at FROM product_report ORDER BY 1')).rows;

    // Y het => 0 dong ghi, ctid + computed_at khong doi.
    await stage(db, [ROW('A'), ROW('B'), ROW('C')]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 0 });
    assert.deepEqual((await db.query('SELECT product_code, ctid::text AS ctid, computed_at::text AS at FROM product_report ORDER BY 1')).rows, before);

    // B doi ton, C mat (khong con kinh doanh), D moi.
    await stage(db, [ROW('A'), ROW('B', { stock_hanoi: 99 }), ROW('D')]);
    assert.deepEqual(await applyProducts(db), { deleted: 1, updated: 1, inserted: 1 });
    const after = (await db.query('SELECT product_code, stock_hanoi::text AS s, ctid::text AS ctid FROM product_report ORDER BY 1')).rows;
    assert.deepEqual(after.map(r => r.product_code), ['A', 'B', 'D']);
    assert.equal(after.find(r => r.product_code === 'B').s, '99');
    assert.equal(after.find(r => r.product_code === 'A').ctid, before.find(r => r.product_code === 'A').ctid, 'dong A khong bi ghi lai');

    // NULL vs gia tri: IS DISTINCT FROM phai nhan ra top_customer_name doi tu NULL sang chu.
    await stage(db, [ROW('A', { top_customer_name: null, top_customer_share: null }), ROW('B', { stock_hanoi: 99 }), ROW('D')]);
    assert.equal((await applyProducts(db)).updated, 1);
    await stage(db, [ROW('A'), ROW('B', { stock_hanoi: 99 }), ROW('D')]);
    assert.equal((await applyProducts(db)).updated, 1);
  } finally { await db.close(); }
});

test('ghi khac biet: 4 cot theo co so (co ban HN/SG, mo ta HN/SG) - NULL sau migration 0057 duoc ghi bu, doi mo ta/co ban thi cap nhat dung dong do', async () => {
  const db = await diffFixture();
  try {
    const NOT_RECOMPUTED = { available_hanoi: null, available_saigon: null, description_hanoi: null, description_saigon: null, price_hanoi: null, price_saigon: null };
    await stage(db, [ROW('A', NOT_RECOMPUTED), ROW('B', NOT_RECOMPUTED)]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 2 });

    // Luot dau sau migration: dong cu (NULL) khac gia tri moi => ghi bu ca hai dong, sau do y het => 0 dong ghi.
    await stage(db, [ROW('A'), ROW('B')]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 2, inserted: 0 });
    await stage(db, [ROW('A'), ROW('B')]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 0 });

    // Sua mo ta tren KiotViet (mot co so) / phieu tam doi co ban SG => dung 2 dong bi cham.
    await stage(db, [ROW('A', { description_hanoi: 'T50 # 17/10 | HN' }), ROW('B', { available_saigon: 2 })]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 2, inserted: 0 });
    // Mo ta bi xoa (NULL) cung la mot thay doi that.
    await stage(db, [ROW('A', { description_hanoi: null }), ROW('B', { available_saigon: 2 })]);
    assert.equal((await applyProducts(db)).updated, 1);
    // Doi don gia tren KiotViet (mot co so) cung chi cham dung dong do; gia SG bo trong (NULL) la mot thay doi that.
    await stage(db, [ROW('A', { description_hanoi: null, price_hanoi: 13000 }), ROW('B', { available_saigon: 2, price_saigon: null })]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 2, inserted: 0 });
    await stage(db, [ROW('A', { description_hanoi: null, price_hanoi: 13000 }), ROW('B', { available_saigon: 2, price_saigon: null })]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 0 });
    const row = (await db.query(`SELECT available_hanoi::float8 AS ah, available_saigon::float8 AS asg, description_hanoi AS dh, description_saigon AS ds,
      price_hanoi::float8 AS ph, price_saigon::float8 AS ps FROM product_report WHERE product_code = 'A'`)).rows[0];
    assert.deepEqual(row, { ah: 10, asg: 5, dh: null, ds: 'T50 # 16/10 | SG', ph: 13000, ps: 12500 });
  } finally { await db.close(); }
});

test('SQL that (PGlite): luot nhe ghi DUNG VI TRI 4 cot theo co so; co ban HN + co ban SG = available_to_sell; mo ta theo co so', async () => {
  const db = await diffFixture();
  try {
    await db.exec(`
      CREATE TABLE products (branch text, id bigint, code text, name text, is_active boolean, raw jsonb, base_price numeric);
      CREATE TABLE orders (branch text, id bigint, raw jsonb);
      CREATE TABLE order_details (branch text, order_id bigint, product_id bigint, quantity numeric, raw jsonb);
      CREATE TABLE daily_product_sales (branch text, product_id bigint, sale_date date, qty numeric, revenue numeric);
      INSERT INTO products VALUES
        ('hanoi', 1, 'A', 'Sp A', true, '{"description":"T50 # HN","inventories":[{"onHand":7,"cost":12000}]}', 99999),
        ('saigon', 1, 'A', 'Sp A', true, '{"description":"T50 # SG","inventories":[{"onHand":3.25,"cost":12500}]}', 99999),
        ('hanoi', 2, 'B', 'Sp B', true, '{"inventories":[{"onHand":4}]}', NULL),
        ('hanoi', 3, 'C', 'Sp C', false, '{"inventories":[{"onHand":9}]}', 100);
      INSERT INTO orders VALUES ('hanoi', 10, '{"statusValue":"Phiếu tạm"}'), ('saigon', 20, '{"statusValue":"Phiếu tạm"}');
      INSERT INTO order_details VALUES ('hanoi', 10, 1, 2, '{}'), ('saigon', 20, 1, 1, '{}');`);
    await db.query(__sql__.fillProductsLight, [['hanoi', 'saigon']]);
    const read = async () => (await db.query(`SELECT product_code, stock_hanoi::float8 AS sh, stock_saigon::float8 AS ss, available_to_sell::float8 AS av,
      available_hanoi::float8 AS ah, available_saigon::float8 AS asg, description_hanoi AS dh, description_saigon AS ds,
      price_hanoi::float8 AS ph, price_saigon::float8 AS ps FROM pr_new ORDER BY product_code`)).rows;
    const rows = await read();
    assert.deepEqual(rows, [
      { product_code: 'A', sh: 7, ss: 3.25, av: 7.25, ah: 5, asg: 2.25, dh: 'T50 # HN', ds: 'T50 # SG', ph: 12000, ps: 12500 },
      { product_code: 'B', sh: 4, ss: 0, av: 4, ah: 4, asg: 0, dh: null, ds: null, ph: 0, ps: null } // ma C ngung kinh doanh bi loai
    ]);
    rows.forEach(row => assert.equal(row.ah + row.asg, row.av, 'co ban HN + co ban SG = available_to_sell (' + row.product_code + ')'));
    // Chay lai y het => khong dong nao bi ghi lai.
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 2 });
    await db.exec('DELETE FROM pr_new');
    await db.query(__sql__.fillProductsLight, [['hanoi', 'saigon']]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 0 });
  } finally { await db.close(); }
});

test('ghi khac biet: 4 cot BC CHUNG (SL 30 theo co so, SL don) - NULL sau migration 0067 duoc ghi bu, doi thi cap nhat dung dong do', async () => {
  const db = await diffFixture();
  try {
    const NOT_RECOMPUTED = { qty_sold_30d_hanoi: null, qty_sold_30d_saigon: null, orders_30d: null, orders_90d: null };
    await stage(db, [ROW('A', NOT_RECOMPUTED), ROW('B', NOT_RECOMPUTED)]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 2 });
    await stage(db, [ROW('A'), ROW('B')]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 2, inserted: 0 });
    await stage(db, [ROW('A'), ROW('B')]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 0 });
    await stage(db, [ROW('A', { qty_sold_30d_saigon: 5 }), ROW('B', { orders_90d: 10 })]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 2, inserted: 0 });
    const a = (await db.query(`SELECT qty_sold_30d_hanoi::float8 AS qh, qty_sold_30d_saigon::float8 AS qs, orders_30d::float8 AS o30, orders_90d::float8 AS o90
      FROM product_report WHERE product_code = 'A'`)).rows[0];
    assert.deepEqual(a, { qh: 2, qs: 5, o30: 4, o90: 9 });
  } finally { await db.close(); }
});

// Schema + du lieu toi thieu (xem bcChungFixture trong productReportRefresh.test.js): ma A co id khac nhau o hai co so.
async function seedBcChung(db) {
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
    INSERT INTO products VALUES
      ('hanoi', 1, 'A', 'Sp A', true, '{}', 1000), ('saigon', 11, 'A', 'Sp A', true, '{}', 1100),
      ('hanoi', 2, 'B', 'Sp B', true, '{}', 500);
    INSERT INTO customers VALUES
      ('hanoi', 1, 'C1', 'KH 1', '{}'), ('hanoi', 2, 'C2', 'KH ngung', '{"isActive":false}'), ('saigon', 1, 'C1', 'KH 1', '{}');
    INSERT INTO daily_product_sales VALUES
      ('hanoi', 1, ${dayDate(3)}, 5, 50), ('hanoi', 1, ${dayDate(45)}, 9, 90), ('saigon', 11, ${dayDate(10)}, 2, 20),
      ('hanoi', 1, ${dayDate(0)}, 4, 40);
    INSERT INTO invoices VALUES
      ('hanoi', 100, 1, ${day(5)}, '{"statusValue":"Hoàn thành"}'),
      ('saigon', 100, 1, ${day(15)}, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 101, 1, ${day(10)}, '{"statusValue":"Đã hủy"}'),
      ('hanoi', 102, 2, ${day(20)}, '{"statusValue":"Hoàn thành"}'),
      ('saigon', 200, 1, ${day(40)}, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 103, 1, ${day(100)}, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 104, 1, ${day(0)}, '{"statusValue":"Hoàn thành"}');
    INSERT INTO invoice_details VALUES
      ('hanoi', 100, 1, 2, 1000, 0, '{}'), ('hanoi', 100, 1, 1, 1000, 0, '{}'),
      ('saigon', 100, 11, 1, 1100, 0, '{}'),
      ('hanoi', 101, 1, 4, 1000, 0, '{}'),
      ('hanoi', 102, 1, 1, 1000, 0, '{}'),
      ('saigon', 200, 11, 3, 1100, 0, '{}'),
      ('hanoi', 103, 1, 1, 1000, 0, '{}'),
      ('hanoi', 104, 1, 1, 1000, 0, '{}');
    INSERT INTO returns VALUES ('hanoi', 300, 1, ${day(3)}, '{"statusValue":"Đã trả"}');
    INSERT INTO return_details VALUES ('hanoi', 300, 1, 1, 1000, '{}');`);
}

test('SQL that (PGlite): luot NANG ghi SL ban 30 ngay theo co so (gom hom nay) + SL don theo ma hang, nap qua bang tam pr_orders_new', async () => {
  const db = await diffFixture();
  try {
    await seedBcChung(db);
    await db.query(__sql__.fillCustomers, [['hanoi', 'saigon']]);
    const orders = (await db.query('SELECT product_key, orders_30d::float8 AS o30, orders_90d::float8 AS o90 FROM pr_orders_new ORDER BY 1')).rows;
    // 30 ngay (today-29..today): HN#100, SG#100, HN#102, HN#104 (hom nay) = 4; 90 ngay: them SG#200 = 5.
    // HN#101 da huy, HN#103 qua 90 ngay, dong tra hang khong tinh; khach ngung (HN#102) van tinh.
    assert.deepEqual(orders, [{ product_key: 'a', o30: 4, o90: 5 }]);
    const customers = (await db.query('SELECT customer_key FROM pr_customers_new ORDER BY 1')).rows;
    assert.deepEqual(customers.map(row => row.customer_key), ['name:kh 1'], 'khach ngung hoat dong van bi loai khoi bang khach');

    await db.query(__sql__.fillProductsHeavy, [['hanoi', 'saigon']]);
    const rows = (await db.query(`SELECT product_code, qty_sold_30d::float8 AS q, qty_sold_30d_hanoi::float8 AS qh, qty_sold_30d_saigon::float8 AS qs,
      orders_30d::float8 AS o30, orders_90d::float8 AS o90 FROM pr_new ORDER BY product_code`)).rows;
    assert.deepEqual(rows, [
      { product_code: 'A', q: 11, qh: 9, qs: 2, o30: 4, o90: 5 }, // HN: 5 (3 ngay truoc) + 4 (hom nay); SG: 2
      { product_code: 'B', q: 0, qh: 0, qs: 0, o30: 0, o90: 0 } // luot nang luon COALESCE ve 0, khong bao gio ket o NULL
    ]);
    assert.match(__sql__.fillProductsHeavy, /FROM pr_customers_new\b/);
  } finally { await db.close(); }
});

test('SQL that (PGlite): luot NHE tinh lai SL 30 theo co so nhung GIU gia tri cu cua SL don; ma moi do luot nhe them co SL don NULL', async () => {
  const db = await diffFixture();
  try {
    await seedBcChung(db);
    await db.query(__sql__.fillCustomers, [['hanoi', 'saigon']]);
    await db.query(__sql__.fillProductsHeavy, [['hanoi', 'saigon']]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 0, inserted: 2 });
    // Luot nang truoc do ghi SL don; sau do co ban them 1 san pham moi (chi luot nhe thay) va A ban them o SG.
    await db.exec(`UPDATE product_report SET orders_30d = 40, orders_90d = 90 WHERE product_code = 'A';
      INSERT INTO products VALUES ('hanoi', 3, 'C', 'Sp C', true, '{}', 700);
      INSERT INTO daily_product_sales VALUES ('saigon', 11, (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1, 6, 60);`);
    await db.exec('DELETE FROM pr_new');
    await db.query(__sql__.fillProductsLight, [['hanoi', 'saigon']]);
    const rows = (await db.query(`SELECT product_code, qty_sold_30d_hanoi::float8 AS qh, qty_sold_30d_saigon::float8 AS qs,
      orders_30d::float8 AS o30, orders_90d::float8 AS o90 FROM pr_new ORDER BY product_code`)).rows;
    assert.deepEqual(rows, [
      { product_code: 'A', qh: 9, qs: 8, o30: 40, o90: 90 }, // SL 30 SG cap nhat (2 + 6), SL don giu nguyen
      { product_code: 'B', qh: 0, qs: 0, o30: 0, o90: 0 },
      { product_code: 'C', qh: 0, qs: 0, o30: null, o90: null } // chua tung qua luot nang
    ]);
    assert.deepEqual(await applyProducts(db), { deleted: 0, updated: 1, inserted: 1 });
    // Dong C (orders_90d NULL) la thu dieu kien "thieu-so-don" cua cong quet dung de keo luot nang ke tiep.
    assert.equal((await db.query('SELECT EXISTS (SELECT 1 FROM product_report WHERE orders_90d IS NULL) AS missing')).rows[0].missing, true);
    // Luot nang ke tiep dien orders cho C => het NULL.
    await db.exec('DELETE FROM pr_new; DELETE FROM pr_orders_new; DELETE FROM pr_customers_new');
    await db.query(__sql__.fillCustomers, [['hanoi', 'saigon']]);
    await db.query(__sql__.fillProductsHeavy, [['hanoi', 'saigon']]);
    await applyProducts(db);
    assert.equal((await db.query('SELECT EXISTS (SELECT 1 FROM product_report WHERE orders_90d IS NULL) AS missing')).rows[0].missing, false);
    const a = (await db.query("SELECT orders_30d::float8 AS o30, orders_90d::float8 AS o90 FROM product_report WHERE product_code = 'A'")).rows[0];
    assert.deepEqual(a, { o30: 4, o90: 5 }, 'luot nang tinh lai dung, khong giu so cu');
  } finally { await db.close(); }
});

test('ghi khac biet product_report_customers + state (SQL that): version chi tang khi co dong doi', async () => {
  const db = await diffFixture();
  try {
    const put = async (rows) => {
      await db.exec('DELETE FROM pr_customers_new');
      for (const [pk, ck, name, revenue] of rows) {
        await db.query('INSERT INTO pr_customers_new (product_key, customer_key, customer_name, revenue) VALUES ($1,$2,$3,$4)', [pk, ck, name, revenue]);
      }
      return {
        deleted: (await db.query(__sql__.DELETE_CUSTOMERS_SQL)).affectedRows,
        updated: (await db.query(__sql__.UPDATE_CUSTOMERS_SQL)).affectedRows,
        inserted: (await db.query(__sql__.INSERT_CUSTOMERS_SQL)).affectedRows
      };
    };
    assert.deepEqual(await put([['a', 'code:1', 'KH 1', 100], ['a', 'code:2', 'KH 2', 50]]), { deleted: 0, updated: 0, inserted: 2 });
    assert.deepEqual(await put([['a', 'code:1', 'KH 1', 100], ['a', 'code:2', 'KH 2', 50]]), { deleted: 0, updated: 0, inserted: 0 });
    assert.deepEqual(await put([['a', 'code:1', 'KH 1', 120], ['b', 'name:x', 'X', 7]]), { deleted: 1, updated: 1, inserted: 1 });

    const v1 = (await db.query(__sql__.UPSERT_STATE_SQL, [true, true])).rows[0];
    assert.equal(Number(v1.version), 1);
    const v2 = (await db.query(__sql__.UPSERT_STATE_SQL, [false, false])).rows[0];
    assert.equal(Number(v2.version), 1, 'khong doi => version giu nguyen');
    const v3 = (await db.query(__sql__.UPSERT_STATE_SQL, [true, false])).rows[0];
    assert.equal(Number(v3.version), 2);
    const state = (await db.query('SELECT last_full_at IS NOT NULL AS has_full FROM product_report_state')).rows[0];
    assert.equal(state.has_full, true, 'luot nhe khong xoa moc last_full_at');
  } finally { await db.close(); }
});

test('period backfill gate and persisted window are required', () => {
  assert.equal(__test__.decideHeavy({...STATE_TODAY, customer_window_end: null}, {}, NOW).heavy, true);
  assert.equal(__test__.decideHeavy({...STATE_TODAY, customer_window_end: '2026-10-16'}, {periods_missing:true}, NOW).heavy, true);
  assert.match(__sql__.UPDATE_CUSTOMERS_SQL, /revenue_31_60d/);
});

test('SQL period subdivisions update even when total revenue is unchanged; identical snapshots do not write', async () => {
  const db = await diffFixture();
  try {
    await db.exec(`INSERT INTO product_report_customers (product_key,customer_key,customer_name,revenue,revenue_1_30d,revenue_31_60d,revenue_61_90d)
      VALUES ('a','name:a','A',100,100,0,0);
      INSERT INTO pr_customers_new (product_key,customer_key,customer_name,revenue,revenue_1_30d,revenue_31_60d,revenue_61_90d)
      VALUES ('a','name:a','A',100,0,-10,110)`);
    assert.equal((await db.query(__sql__.UPDATE_CUSTOMERS_SQL)).affectedRows,1);
    assert.equal((await db.query(__sql__.UPDATE_CUSTOMERS_SQL)).affectedRows,0);
    const r = (await db.query('SELECT revenue::float8 AS total,revenue_31_60d::float8 AS middle FROM product_report_customers')).rows[0];
    assert.deepEqual(r,{total:100,middle:-10});
  } finally { await db.close(); }
});
