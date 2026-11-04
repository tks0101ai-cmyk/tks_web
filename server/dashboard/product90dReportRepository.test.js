'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { getProduct90dReport, getProduct90dReportForExport, SORT_COLUMNS, PERIODS } = require('./product90dReportRepository');

const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/0106_product_90d_report.sql'), 'utf8');

async function setup({ withState = true } = {}) {
  const db = new PGlite();
  await db.exec(migration);
  if (withState) {
    await db.exec(`INSERT INTO product_90d_report_state
      (id, as_of_date, window_start, window_end, computed_at, row_count, version)
      VALUES (1, '2026-11-04', '2026-08-06', '2026-11-03', '2026-11-03T19:00:05.123Z', 6, 7)`);
  }
  return db;
}

// product_key = ma hang viet thuong (giong job). Chi dat cac cot can thiet; cot khac lay mac dinh cua migration.
async function put(db, code, name, values = {}) {
  const cols = ['product_key', 'product_code', 'product_name', ...Object.keys(values)];
  const params = [code.toLowerCase(), code, name, ...Object.values(values).map(v => (typeof v === 'object' && v !== null ? JSON.stringify(v) : v))];
  await db.query(`INSERT INTO product_90d_report (${cols.join(',')}) VALUES (${params.map((_, i) => '$' + (i + 1)).join(',')})`, params);
}

async function seed(db) {
  await put(db, 'SP1', 'Bình giữ nhiệt Lock', {
    qty_1_90d: 10.5, revenue_1_90d: 1050000.25, avg_price_1_90d: 100000.0238, customer_count_1_90d: 3, invoice_count_1_90d: 4,
    qty_1_30d: -2, revenue_1_30d: -200000, avg_price_1_30d: 100000,
    top_customers_1_90d: [
      { name: 'Khách A', share: 0.6, revenue: 630000, quantity: 6 },
      { name: 'Khách B', share: 0.3, revenue: 315000, quantity: 3 },
      { name: 'Khách C', share: 0.05, revenue: 52500, quantity: 0.5 },
      { name: 'Khách D', share: 0.05, revenue: 52500.25, quantity: 1 }
    ]
  });
  await put(db, 'SP2', 'Đặng Mỹ Thọ cốc', { qty_1_90d: 0, revenue_1_90d: 0, avg_price_1_90d: null, qty_1_30d: 7, revenue_1_30d: 700 });
  await put(db, 'SP3', 'Ấm đun nước', { qty_1_90d: 5, revenue_1_90d: 500, avg_price_1_90d: 100, qty_1_30d: 7, revenue_1_30d: 900 });
  await put(db, 'SP4', 'Khay nhựa', { qty_1_90d: 5, revenue_1_90d: 400, avg_price_1_90d: 80, qty_1_30d: 1, revenue_1_30d: 100 });
  await put(db, 'SP5', 'Chén sứ', { qty_1_90d: 8, revenue_1_90d: 800, avg_price_1_90d: null });
  await put(db, 'SP6', 'Dĩa nhựa', { qty_1_90d: 2, revenue_1_90d: 20, avg_price_1_90d: 10 });
}

test('mac dinh: sap xep theo ma hang, state + 4 ky tinh tu as_of_date, kieu du lieu NUMERIC/NULL/0/am/le giu nguyen', async () => {
  const db = await setup();
  try {
    await seed(db);
    const data = await getProduct90dReport({ pool: db });
    assert.equal(data.available, true);
    assert.deepEqual(data.state, {
      asOfDate: '2026-11-04', windowStart: '2026-08-06', windowEnd: '2026-11-03',
      computedAt: '2026-11-03T19:00:05.123Z', rowCount: 6, version: 7
    });
    assert.deepEqual(data.periods, [
      { key: '61_90d', label: 'T.trc nữa', from: '2026-08-06', to: '2026-09-04' },
      { key: '31_60d', label: 'T.trc', from: '2026-09-05', to: '2026-10-04' },
      { key: '1_30d', label: 'T.này', from: '2026-10-05', to: '2026-11-03' },
      { key: '1_90d', label: '90 ngày', from: '2026-08-06', to: '2026-11-03' }
    ]);
    assert.equal(data.periods[3].from, data.state.windowStart);
    assert.equal(data.periods[3].to, data.state.windowEnd);
    assert.equal(data.totalRows, 6);
    assert.equal(data.page, 1);
    assert.equal(data.pageSize, 50);
    assert.deepEqual(data.rows.map(r => r.product_code), ['SP1', 'SP2', 'SP3', 'SP4', 'SP5', 'SP6']);
    const [sp1, sp2] = data.rows;
    assert.equal(sp1.product_name, 'Bình giữ nhiệt Lock');
    assert.equal(sp1.qty_1_90d, 10.5);
    assert.equal(sp1.revenue_1_90d, 1050000.25);
    assert.equal(sp1.avg_price_1_90d, 100000.0238);
    assert.equal(sp1.qty_1_30d, -2);
    assert.equal(sp1.revenue_1_30d, -200000);
    assert.equal(sp1.customer_count_1_90d, 3);
    assert.equal(sp1.invoice_count_1_90d, 4);
    assert.equal(sp2.qty_1_90d, 0, 'so 0 giu nguyen 0');
    assert.equal(sp2.avg_price_1_90d, null, 'NULL khong thanh 0');
    assert.equal(sp2.avg_price_61_90d, null);
    assert.equal(sp2.qty_61_90d, 0);
    assert.deepEqual(sp2.top_customers_1_90d, []);
    // Day du khoa cua moi hang: 2 + 4 ky x 6 cot, khong lo khoa ky thuat product_key.
    assert.equal(Object.keys(sp1).length, 26);
    assert.equal('product_key' in sp1, false);
  } finally { await db.close(); }
});

test('Top 3 khach: cat ve dung 3 phan tu, dung du lieu hong -> mang rong', async () => {
  const db = await setup();
  try {
    await seed(db);
    await put(db, 'BAD', 'Hong', { top_customers_1_90d: { not: 'array' } });
    const rows = (await getProduct90dReport({ pool: db, q: 'sp1' })).rows;
    assert.deepEqual(rows[0].top_customers_1_90d, [
      { name: 'Khách A', share: 0.6, revenue: 630000, quantity: 6 },
      { name: 'Khách B', share: 0.3, revenue: 315000, quantity: 3 },
      { name: 'Khách C', share: 0.05, revenue: 52500, quantity: 0.5 }
    ]);
    const bad = (await getProduct90dReport({ pool: db, q: 'hong' })).rows[0];
    assert.deepEqual(bad.top_customers_1_90d, []);
  } finally { await db.close(); }
});

test('tim kiem co dau / khong dau / nhieu tu tren ma + ten, ap dung truoc phan trang', async () => {
  const db = await setup();
  try {
    await seed(db);
    const read = params => getProduct90dReport({ pool: db, ...params });
    assert.deepEqual((await read({ q: 'dang my tho' })).rows.map(r => r.product_code), ['SP2']);
    assert.deepEqual((await read({ q: 'Đặng Mỹ' })).rows.map(r => r.product_code), ['SP2']);
    assert.deepEqual((await read({ q: 'am dun' })).rows.map(r => r.product_code), ['SP3']);
    assert.deepEqual((await read({ q: 'sp4' })).rows.map(r => r.product_code), ['SP4']);
    assert.deepEqual((await read({ q: 'nhua' })).rows.map(r => r.product_code).sort(), ['SP4', 'SP6']);
    const total = await read({ q: 'nhua', pageSize: '1', page: '2' });
    assert.equal(total.totalRows, 2, 'tong tinh tren toan bo ket qua loc');
    assert.equal(total.rows.length, 1);
    const none = await read({ q: 'khongtontai', page: '9' });
    assert.equal(none.available, true, 'tim khong ra van la available:true voi 0 dong');
    assert.equal(none.totalRows, 0);
    assert.equal(none.page, 1);
    assert.deepEqual(none.rows, []);
    assert.equal(none.state.version, 7);
    // Ky tu dac biet / injection chi la tu khoa, khong thanh SQL.
    assert.equal((await read({ q: "sp1'; DROP TABLE product_90d_report; --" })).totalRows, 0);
    assert.equal((await read({})).totalRows, 6, 'bang con nguyen');
  } finally { await db.close(); }
});

test('sap xep tren toan bo truoc phan trang, NULL luon cuoi o ca 2 chieu, tie-break theo ma hang', async () => {
  const db = await setup();
  try {
    await seed(db);
    const codes = params => getProduct90dReport({ pool: db, ...params }).then(d => d.rows.map(r => r.product_code));
    // avg_price_1_90d: SP1 100000.0238, SP3 100, SP4 80, SP6 10, SP2/SP5 NULL.
    assert.deepEqual(await codes({ sort: 'avg_price_1_90d', dir: 'desc' }), ['SP1', 'SP3', 'SP4', 'SP6', 'SP2', 'SP5']);
    assert.deepEqual(await codes({ sort: 'avg_price_1_90d', dir: 'asc' }), ['SP6', 'SP4', 'SP3', 'SP1', 'SP2', 'SP5']);
    // Hoa bang: qty_1_30d SP2=SP3=7 -> ma hang tang dan, SP5/SP6 mac dinh 0 nam giua (khong NULL).
    assert.deepEqual(await codes({ sort: 'qty_1_30d', dir: 'desc' }), ['SP2', 'SP3', 'SP4', 'SP5', 'SP6', 'SP1']);
    // Sap xep toan cuc roi moi cat trang.
    const p1 = await getProduct90dReport({ pool: db, sort: 'avg_price_1_90d', dir: 'desc', pageSize: '2', page: '1' });
    const p3 = await getProduct90dReport({ pool: db, sort: 'avg_price_1_90d', dir: 'desc', pageSize: '2', page: '3' });
    assert.deepEqual(p1.rows.map(r => r.product_code), ['SP1', 'SP3']);
    assert.deepEqual(p3.rows.map(r => r.product_code), ['SP2', 'SP5']);
    assert.equal(p3.totalRows, 6);
    // Ten hang va ma hang giam dan.
    assert.deepEqual(await codes({ sort: 'product_code', dir: 'desc' }), ['SP6', 'SP5', 'SP4', 'SP3', 'SP2', 'SP1']);
    // Trang vuot cuoi bi kep ve trang cuoi.
    const beyond = await getProduct90dReport({ pool: db, pageSize: '4', page: '99' });
    assert.equal(beyond.page, 2);
    assert.deepEqual(beyond.rows.map(r => r.product_code), ['SP5', 'SP6']);
    // Khong chon cot + co tu khoa: xep theo do khop (nguyen cum / nhieu tu truoc).
    const rel = await getProduct90dReport({ pool: db, q: 'nhua' });
    assert.equal(rel.sort, 'relevance');
    assert.deepEqual(rel.rows.map(r => r.product_code), ['SP4', 'SP6']);
  } finally { await db.close(); }
});

test('thieu dong state -> available:false (khong phai loi), kem hang cung cap thi van khong lo ra', async () => {
  const db = await setup({ withState: false });
  try {
    await seed(db);
    assert.deepEqual(await getProduct90dReport({ pool: db }), { available: false, rows: [], totalRows: 0 });
    assert.deepEqual(await getProduct90dReport({ pool: db, q: 'sp1' }), { available: false, rows: [], totalRows: 0 });
  } finally { await db.close(); }
});

test('state co nhung bang rong -> available:true, 0 dong', async () => {
  const db = await setup();
  try {
    const data = await getProduct90dReport({ pool: db });
    assert.equal(data.available, true);
    assert.equal(data.totalRows, 0);
    assert.deepEqual(data.rows, []);
  } finally { await db.close(); }
});

test('tham so khong hop le -> 400 truoc khi cham DB', async () => {
  const bad = [
    { q: 'x'.repeat(201) }, { q: ['a'] }, { q: 5 },
    { sort: 'password' }, { sort: 'top_customers_1_90d' }, { sort: 'product_key' }, { sort: '' }, { sort: ['qty_1_90d'] },
    { sort: 'qty_1_90d; DROP TABLE x' }, { sort: 'qty_1_90d desc' },
    { dir: 'up' }, { dir: 'DESC' }, { dir: ['asc'] },
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: 'abc' }, { page: '' }, { page: ['1'] },
    { pageSize: '0' }, { pageSize: '201' }, { pageSize: 'x' }
  ];
  for (const params of bad) {
    await assert.rejects(() => getProduct90dReport(params), { statusCode: 400 }, JSON.stringify(params));
  }
  // Gioi han bien dung duoc chap nhan (khong cham DB: pool gia).
  const pool = { query: async () => ({ rows: [] }) };
  assert.equal((await getProduct90dReport({ pool, q: 'x'.repeat(200), pageSize: '200' })).available, false);
});

test('xuat file: doc TOAN BO dong (khong gioi han 200/trang), cung luat tim + sap xep voi man hinh', async () => {
  const db = await setup();
  try {
    await seed(db);
    for (let i = 0; i < 230; i += 1) await put(db, `ZZ${String(i).padStart(3, '0')}`, `Hàng phụ ${i}`, { qty_1_90d: i });
    const all = await getProduct90dReportForExport({ pool: db });
    assert.equal(all.available, true);
    assert.equal(all.totalRows, 236);
    assert.equal(all.rows.length, 236, 'khong cat theo trang');
    assert.deepEqual(all.rows.slice(0, 2).map(r => r.product_code), ['SP1', 'SP2']);
    assert.equal(all.state.asOfDate, '2026-11-04');
    assert.equal(all.periods.length, 4);
    assert.equal(Object.keys(all.rows[0]).length, 26);
    assert.equal(all.rows[0].qty_1_30d, -2);
    assert.equal(all.rows[1].avg_price_1_90d, null);
    // Tim + sap xep giong getProduct90dReport (khong dau, do khop, NULL cuoi).
    const nhua = await getProduct90dReportForExport({ pool: db, q: 'nhua' });
    assert.equal(nhua.sort, 'relevance');
    assert.deepEqual(nhua.rows.map(r => r.product_code), (await getProduct90dReport({ pool: db, q: 'nhua' })).rows.map(r => r.product_code));
    const sorted = await getProduct90dReportForExport({ pool: db, q: 'sp', sort: 'avg_price_1_90d', dir: 'desc' });
    assert.deepEqual(sorted.rows.map(r => r.product_code), ['SP1', 'SP3', 'SP4', 'SP6', 'SP2', 'SP5']);
    const none = await getProduct90dReportForExport({ pool: db, q: 'khongtontai' });
    assert.equal(none.available, true);
    assert.deepEqual(none.rows, []);
    // Vuot tran -> loi 413 ro rang, khong cat ngam.
    await assert.rejects(() => getProduct90dReportForExport({ pool: db, maxRows: 10 }), { statusCode: 413, code: 'EXPORT_TOO_MANY_ROWS' });
    assert.equal((await getProduct90dReportForExport({ pool: db, q: 'sp', maxRows: 6 })).rows.length, 6);
    await assert.rejects(() => getProduct90dReportForExport({ pool: db, sort: 'product_key' }), { statusCode: 400 });
    await assert.rejects(() => getProduct90dReportForExport({ pool: db, q: 'x'.repeat(201) }), { statusCode: 400 });
  } finally { await db.close(); }
});

test('xuat file: thieu state -> available:false; SQL chi doc + tham so hoa', async () => {
  const db = await setup({ withState: false });
  try {
    await seed(db);
    assert.deepEqual(await getProduct90dReportForExport({ pool: db }), { available: false, rows: [], totalRows: 0 });
  } finally { await db.close(); }
  const captured = [];
  const pool = { query: async (sql, values) => { captured.push({ sql, values }); return { rows: [] }; } };
  await getProduct90dReportForExport({ pool, q: "x'; DROP TABLE t; --", sort: 'qty_1_30d', dir: 'asc' });
  assert.ok(!captured[0].sql.includes('DROP TABLE'));
  assert.ok(/^\s*WITH/.test(captured[0].sql) && !/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i.test(captured[0].sql));
  assert.match(captured[0].sql, /ORDER BY f\.qty_1_30d ASC NULLS LAST, f\.product_code ASC, f\.product_key ASC LIMIT \$\d+::int/);
});

test('SQL tham so hoa: tu khoa/trang/so dong di qua tham so, ten cot sap xep chi lay tu danh sach trang', async () => {
  const captured = [];
  const pool = { query: async (sql, values) => { captured.push({ sql, values }); return { rows: [] }; } };
  const evil = "x'; DROP TABLE product_90d_report; --";
  await getProduct90dReport({ pool, q: evil, sort: 'qty_1_30d', dir: 'asc', page: '2', pageSize: '10' });
  const { sql, values } = captured[0];
  assert.ok(!sql.includes('DROP TABLE'), 'tu khoa khong duoc noi vao SQL');
  assert.ok(!sql.includes(evil));
  assert.ok(values.some(v => typeof v === 'string' && v.includes('drop')), 'tu khoa nam trong tham so');
  assert.ok(values.includes(2) && values.includes(10));
  assert.match(sql, /ORDER BY f\.qty_1_30d ASC NULLS LAST, f\.product_code ASC, f\.product_key ASC/);
  assert.ok(/^\s*WITH/.test(sql) && !/\b(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP)\b/i.test(sql), 'chi SELECT');
  assert.equal(SORT_COLUMNS.length, 22);
  assert.deepEqual(PERIODS.map(p => p.key), ['61_90d', '31_60d', '1_30d', '1_90d']);
});
