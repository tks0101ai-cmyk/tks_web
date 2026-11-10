'use strict';

// Bang "Khach hang theo san pham" (muc 4 tab Hang hoa): du lieu that tu PGlite (product_report + product_report_customers
// + product_report_state) qua dung SQL cua repository. Kiem tra cong thuc tang truong, ranh gioi -50%, nhom loc,
// % cua SP khong doi theo bo loc, sap xep NULL cuoi, phan trang, validate, xuat file.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const repo = require('./productCustomerGrowthRepository');

const migration = name => fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8');

async function setup({ state = 'ready' } = {}) {
  const db = new PGlite();
  await db.exec(migration('0018_product_report.sql'));
  await db.exec(migration('0023_product_report_customers.sql'));
  // 0055 can bang invoices/returns/customers; test chi can cac cot ma 0108 them vao nen dung DDL toi thieu.
  await db.exec(`CREATE TABLE product_report_state (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), computed_at TIMESTAMPTZ NOT NULL, version BIGINT NOT NULL DEFAULT 1, last_full_at TIMESTAMPTZ)`);
  await db.exec(migration('0108_product_customer_periods.sql'));
  if (state === 'ready') {
    await db.exec(`INSERT INTO product_report_state (id, computed_at, version, customer_window_end)
      VALUES (1, '2026-11-05T19:00:05.123Z', 7, '2026-11-05')`);
  } else if (state === 'no-window') {
    await db.exec(`INSERT INTO product_report_state (id, computed_at, version) VALUES (1, '2026-11-05T19:00:05.123Z', 7)`);
  }
  return db;
}

async function products(db) {
  await db.exec(`INSERT INTO product_report (product_code, product_name) VALUES
    ('SP1', 'Bình giữ nhiệt Lock'), ('SP2', 'Cốc sứ'), ('SP3', 'Ấm đun nước')`);
}

// (product_key, customer_key, ten, revenue 90 ngay, r1 = T.nay, r2 = T.truoc, r3 = T.truoc nua)
async function pair(db, key, customer, revenue, r1, r2, r3) {
  await db.query(
    `INSERT INTO product_report_customers (product_key, customer_key, customer_name, revenue, revenue_1_30d, revenue_31_60d, revenue_61_90d)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [key, 'name:' + customer.toLowerCase(), customer, revenue, r1, r2, r3]);
}

async function seed(db) {
  await products(db);
  await pair(db, 'sp1', 'Khách A', 200, 40, 60, 100);           // prior 160, 4*40 = 160 -> dung -50% -> drop
  await pair(db, 'sp1', 'Khách B', 210, 10, 100, 100);          // -90% -> check
  await pair(db, 'sp1', 'Khách C', 400, 300, 50, 50);           // +500% -> up
  await pair(db, 'sp1', 'Khách mới D', 70, 70, 0, 0);           // prior 0, T.nay > 0 -> new
  await pair(db, 'sp1', 'Khách E', 0, 0, 0, 0);                 // prior 0, T.nay 0 -> khong nhom
  await pair(db, 'sp1', 'Khách F', 100, 0, 50, 50);             // -100% -> lost
  await pair(db, 'sp1', 'Khách thiếu kỳ', 30, null, null, null); // ky chua tinh -> khong nhom
  await pair(db, 'sp2', 'Khách H', 15, 5, 5, 5);                // 0% -> up
  await pair(db, 'sp2', 'Khách trả hàng', 20, 10, -50, 20);     // prior -30 <= 0, T.nay > 0 -> new
  await pair(db, 'zz', 'Khách mồ côi', 999, 1, 1, 1);           // khong co trong product_report -> bi loai
}

const names = data => data.rows.map(r => r.customerName);
const byName = (data, name) => data.rows.find(r => r.customerName === name);

test('mac dinh: state + 3 ky + summary, 9 dong (bo cap mo coi) xep DS 90 ngay giam dan', async () => {
  const db = await setup();
  try {
    await seed(db);
    const data = await repo.getProductCustomerGrowth({ pool: db });
    assert.equal(data.available, true);
    assert.deepEqual(data.state, { customerWindowEnd: '2026-11-05', computedAt: '2026-11-05T19:00:05.123Z', version: 7 });
    assert.deepEqual(data.periods.map(p => p.key), ['1_30d', '31_60d', '61_90d']);
    assert.equal(data.periods[0].from, '2026-10-07');
    assert.equal(data.periods[0].to, '2026-11-05');
    assert.deepEqual(data.summary, { totalRows: 9, lostRows: 1, checkRows: 1 });
    assert.equal(data.page, 1);
    assert.equal(data.pageSize, 50);
    assert.equal(data.sort, 'revenue');
    assert.equal(data.dir, 'desc');
    assert.deepEqual(data.sorts, [{ sort: 'revenue', dir: 'desc' }]);
    assert.deepEqual(names(data), ['Khách C', 'Khách B', 'Khách A', 'Khách F', 'Khách mới D', 'Khách thiếu kỳ', 'Khách trả hàng', 'Khách H', 'Khách E']);
    const c = data.rows[0];
    assert.equal(c.productCode, 'SP1');
    assert.equal(c.productName, 'Bình giữ nhiệt Lock');
    assert.equal(c.revenue, 400);
    assert.equal(c.revenue1_30d, 300);
    assert.equal(c.revenue31_60d, 50);
    assert.equal(c.revenue61_90d, 50);
  } finally { await db.close(); }
});

test('cong thuc tang truong va ranh gioi: dung -50% la vang (drop); -90% cam (check); -100% do (lost); base <= 0 la Moi hoac trong', async () => {
  const db = await setup();
  try {
    await seed(db);
    const data = await repo.getProductCustomerGrowth({ pool: db });
    const state = name => byName(data, name).growthState;
    const growth = name => byName(data, name).growth;
    assert.equal(growth('Khách A'), -0.5);
    assert.equal(state('Khách A'), 'drop', 'dung -50% khong phai check');
    assert.equal(growth('Khách B'), -0.9);
    assert.equal(state('Khách B'), 'check');
    assert.equal(growth('Khách F'), -1);
    assert.equal(state('Khách F'), 'lost');
    assert.equal(growth('Khách C'), 5);
    assert.equal(state('Khách C'), 'up');
    assert.equal(growth('Khách H'), 0, '0% thuoc Dang tang');
    assert.equal(state('Khách H'), 'up');
    assert.equal(growth('Khách mới D'), null);
    assert.equal(state('Khách mới D'), 'new');
    assert.equal(state('Khách trả hàng'), 'new', 'tong hai ky truoc am van la Moi neu T.nay > 0');
    assert.equal(growth('Khách E'), null);
    assert.equal(state('Khách E'), null);
    const missing = byName(data, 'Khách thiếu kỳ');
    assert.equal(missing.revenue1_30d, null, 'NULL khong thanh 0');
    assert.equal(missing.growth, null);
    assert.equal(missing.growthState, null);
  } finally { await db.close(); }
});

test('ba muc mau: T.nay <= 0 la lost, -100%..-50% la check, dung -50% la drop; T.nay am (tra hang) cung la lost', async () => {
  const db = await setup();
  try {
    await products(db);
    await pair(db, 'sp3', 'Khách Zero', 100, 0, 100, 100);   // prior 200, T.nay 0 -> -100% -> lost
    await pair(db, 'sp3', 'Khách Âm', 90, -5, 50, 50);        // prior 100, T.nay am -> lost
    await pair(db, 'sp3', 'Khách 51', 200, 49, 100, 100);     // 4*49 = 196 < 200 -> -51% -> check (cam)
    await pair(db, 'sp3', 'Khách 50', 200, 50, 100, 100);     // 4*50 = 200 khong < 200 -> dung -50% -> drop (vang)
    await pair(db, 'sp3', 'Khách 10', 200, 90, 100, 100);     // -10% -> drop
    const data = await repo.getProductCustomerGrowth({ product: 'am dun', pool: db });
    const state = name => byName(data, name).growthState;
    assert.equal(state('Khách Zero'), 'lost');
    assert.equal(byName(data, 'Khách Zero').growth, -1);
    assert.equal(state('Khách Âm'), 'lost');
    assert.ok(byName(data, 'Khách Âm').growth < -1, 'T.nay am -> tang truong < -100%');
    assert.equal(state('Khách 51'), 'check');
    assert.equal(state('Khách 50'), 'drop');
    assert.equal(byName(data, 'Khách 50').growth, -0.5);
    assert.equal(state('Khách 10'), 'drop');
    assert.deepEqual(data.summary, { totalRows: 5, lostRows: 2, checkRows: 1 });
    assert.deepEqual(names(await repo.getProductCustomerGrowth({ product: 'am dun', growth: 'lost', sort: 'growth', dir: 'asc', pool: db })),
      ['Khách Âm', 'Khách Zero']);
    assert.deepEqual(names(await repo.getProductCustomerGrowth({ product: 'am dun', growth: 'check', pool: db })), ['Khách 51']);
    assert.deepEqual(new Set(names(await repo.getProductCustomerGrowth({ product: 'am dun', growth: 'drop', pool: db }))), new Set(['Khách 50', 'Khách 10']));
  } finally { await db.close(); }
});

test('nhom loc loai tru nhau; summary va checkRows theo bo loc', async () => {
  const db = await setup();
  try {
    await seed(db);
    const run = growth => repo.getProductCustomerGrowth({ growth, pool: db });
    const check = await run('check');
    assert.deepEqual(names(check), ['Khách B']);
    assert.deepEqual(check.summary, { totalRows: 1, lostRows: 0, checkRows: 1 });
    const lost = await run('lost');
    assert.deepEqual(names(lost), ['Khách F']);
    assert.deepEqual(lost.summary, { totalRows: 1, lostRows: 1, checkRows: 0 });
    const drop = await run('drop');
    assert.deepEqual(names(drop), ['Khách A']);
    assert.deepEqual(drop.summary, { totalRows: 1, lostRows: 0, checkRows: 0 });
    assert.deepEqual(names(await run('up')), ['Khách C', 'Khách H']);
    assert.deepEqual(names(await run('new')), ['Khách mới D', 'Khách trả hàng']);
    assert.equal((await run('all')).summary.totalRows, 9);
  } finally { await db.close(); }
});

test('loc san pham / khach (khong dau); % cua SP tinh tren tat ca khach cua san pham, khong doi theo bo loc', async () => {
  const db = await setup();
  try {
    await seed(db);
    const filtered = await repo.getProductCustomerGrowth({ product: 'binh giu', growth: 'check', pool: db });
    assert.deepEqual(names(filtered), ['Khách B']);
    // Tong DS cua SP1 = 200 + 210 + 400 + 70 + 0 + 100 + 30 = 1010, bo loc khong lam doi mau so.
    assert.ok(Math.abs(byName(filtered, 'Khách B').share - 210 / 1010) < 1e-12);
    const byCustomer = await repo.getProductCustomerGrowth({ customer: 'tra hang', pool: db });
    assert.deepEqual(names(byCustomer), ['Khách trả hàng']);
    assert.ok(Math.abs(byCustomer.rows[0].share - 20 / 35) < 1e-12, 'SP2 tong 15 + 20 = 35');
    const none = await repo.getProductCustomerGrowth({ product: 'khongtontai', pool: db });
    assert.equal(none.available, true);
    assert.deepEqual(none.rows, []);
    assert.deepEqual(none.summary, { totalRows: 0, lostRows: 0, checkRows: 0 });
    const sp2Only = await repo.getProductCustomerGrowth({ product: 'coc su', pool: db });
    assert.deepEqual(new Set(names(sp2Only)), new Set(['Khách H', 'Khách trả hàng']));
  } finally { await db.close(); }
});

test('sap xep theo tang truong: NULL luon cuoi o ca hai chieu; sap theo cot chu', async () => {
  const db = await setup();
  try {
    await seed(db);
    const asc = await repo.getProductCustomerGrowth({ sort: 'growth', dir: 'asc', pool: db });
    assert.deepEqual(names(asc).slice(0, 5), ['Khách F', 'Khách B', 'Khách A', 'Khách H', 'Khách C']);
    assert.deepEqual(new Set(names(asc).slice(5)), new Set(['Khách mới D', 'Khách E', 'Khách thiếu kỳ', 'Khách trả hàng']));
    const desc = await repo.getProductCustomerGrowth({ sort: 'growth', dir: 'desc', pool: db });
    assert.deepEqual(names(desc).slice(0, 5), ['Khách C', 'Khách H', 'Khách A', 'Khách B', 'Khách F']);
    assert.equal(desc.sort, 'growth');
    const text = await repo.getProductCustomerGrowth({ sort: 'product_code', pool: db });
    assert.equal(text.dir, 'asc', 'cot chu mac dinh tang dan');
    assert.equal(text.rows[0].productCode, 'SP1');
    assert.equal(text.rows.at(-1).productCode, 'SP2');
  } finally { await db.close(); }
});

test('sap xep nhieu cap: khach hang roi % cua SP; thu tu cap quyet dinh; NULL van cuoi', async () => {
  const db = await setup();
  try {
    await products(db);
    // Khach A co 3 san pham, khach B co 2. share: SP1 A .25 / B .75; SP2 A .75 / B .25; SP3 A 1.
    await pair(db, 'sp1', 'Khách A', 100, 10, 10, 10);
    await pair(db, 'sp1', 'Khách B', 300, 10, 10, 10);
    await pair(db, 'sp2', 'Khách A', 300, 10, 10, 10);
    await pair(db, 'sp2', 'Khách B', 100, 10, 10, 10);
    await pair(db, 'sp3', 'Khách A', 200, 10, 10, 10);
    const pairs = data => data.rows.map(r => r.productCode + '/' + r.customerName);
    const asc = await repo.getProductCustomerGrowth({ sorts: 'customer_name:asc,share:asc', pool: db });
    assert.deepEqual(pairs(asc), ['SP1/Khách A', 'SP2/Khách A', 'SP3/Khách A', 'SP2/Khách B', 'SP1/Khách B']);
    assert.deepEqual(asc.sorts, [{ sort: 'customer_name', dir: 'asc' }, { sort: 'share', dir: 'asc' }]);
    assert.equal(asc.sort, 'customer_name', 'sort/dir cu = cap dau');
    assert.equal(asc.dir, 'asc');
    const desc = await repo.getProductCustomerGrowth({ sorts: 'customer_name:asc,share:desc', pool: db });
    assert.deepEqual(pairs(desc), ['SP3/Khách A', 'SP2/Khách A', 'SP1/Khách A', 'SP1/Khách B', 'SP2/Khách B']);
    const swapped = await repo.getProductCustomerGrowth({ sorts: 'share:desc,customer_name:asc', pool: db });
    assert.deepEqual(pairs(swapped), ['SP3/Khách A', 'SP2/Khách A', 'SP1/Khách B', 'SP1/Khách A', 'SP2/Khách B'],
      'doi thu tu cap (share truoc, khach sau) -> ket qua khac');
  } finally { await db.close(); }
  const db2 = await setup();
  try {
    await seed(db2);
    const byProduct = await repo.getProductCustomerGrowth({ sorts: 'product_code:asc,revenue:asc', pool: db2 });
    assert.deepEqual(names(byProduct),
      ['Khách E', 'Khách thiếu kỳ', 'Khách mới D', 'Khách F', 'Khách A', 'Khách B', 'Khách C', 'Khách H', 'Khách trả hàng']);
    const nullLast = await repo.getProductCustomerGrowth({ sorts: 'product_code:desc,growth:asc', pool: db2 });
    assert.equal(nullLast.rows[0].productCode, 'SP2');
    assert.equal(nullLast.rows[0].customerName, 'Khách H', 'SP2: H 0% truoc, "Khach tra hang" (growth NULL) cuoi nhom SP2');
    assert.equal(nullLast.rows[1].customerName, 'Khách trả hàng');
  } finally { await db2.close(); }
});

test('sorts uu tien hon sort/dir; khong co sorts thi sort/dir cu chay nhu truoc; mac dinh tra sorts = DS giam dan', async () => {
  const db = await setup();
  try {
    await seed(db);
    const both = await repo.getProductCustomerGrowth({ sort: 'growth', dir: 'asc', sorts: 'revenue:asc', pool: db });
    assert.equal(both.rows[0].customerName, 'Khách E', 'sorts thang: DS tang dan, Khach E co DS 0');
    assert.deepEqual(both.sorts, [{ sort: 'revenue', dir: 'asc' }]);
    const legacy = await repo.getProductCustomerGrowth({ sort: 'growth', dir: 'asc', pool: db });
    assert.equal(legacy.rows[0].customerName, 'Khách F');
    assert.deepEqual(legacy.sorts, [{ sort: 'growth', dir: 'asc' }]);
    const def = await repo.getProductCustomerGrowth({ pool: db });
    assert.deepEqual(def.sorts, [{ sort: 'revenue', dir: 'desc' }]);
    const text = await repo.getProductCustomerGrowth({ sort: 'product_code', pool: db });
    assert.deepEqual(text.sorts, [{ sort: 'product_code', dir: 'asc' }], 'cot chu mac dinh tang dan');
    const empty = await repo.getProductCustomerGrowth({ sorts: '', pool: db });
    assert.deepEqual(empty.sorts, [{ sort: 'revenue', dir: 'desc' }], 'sorts rong = khong co sorts');
  } finally { await db.close(); }
});

test('sorts khong hop le -> 400, khong cham DB; xuat file cung luat va cung thu tu', async () => {
  const noDb = { query: () => { throw new Error('khong duoc cham DB'); } };
  const bad = [
    'revenue', 'revenue:up', 'nope:asc', 'revenue:asc,revenue:desc', 'revenue:asc:x', 'revenue:asc,', ',revenue:asc',
    'product_name:asc,customer_name:asc,revenue:asc,share:asc,growth:asc', 'constructor:asc', 'x'.repeat(201),
    ['revenue:asc'], 5, { revenue: 'asc' }
  ];
  for (const sorts of bad) {
    await assert.rejects(repo.getProductCustomerGrowth({ sorts, pool: noDb }), error => error.statusCode === 400, JSON.stringify(sorts));
    await assert.rejects(repo.getProductCustomerGrowthForExport({ sorts, pool: noDb }), error => error.statusCode === 400, JSON.stringify(sorts));
    assert.throws(() => repo.validateFilters({ sorts }), { statusCode: 400 }, JSON.stringify(sorts));
  }
  assert.doesNotThrow(() => repo.validateFilters({ sorts: 'customer_name:asc,share:desc' }));
  assert.doesNotThrow(() => repo.validateFilters({ sorts: 'product_name:asc,customer_name:asc,revenue:asc,share:asc' }), 'dung 4 cap la hop le');
  assert.equal(repo.MAX_SORT_LEVELS, 4);
  const db = await setup();
  try {
    await seed(db);
    const data = await repo.getProductCustomerGrowthForExport({ sorts: 'product_code:desc,revenue:desc', pool: db });
    assert.deepEqual(names(data), ['Khách trả hàng', 'Khách H', 'Khách C', 'Khách B', 'Khách A', 'Khách F', 'Khách mới D', 'Khách thiếu kỳ', 'Khách E']);
    assert.deepEqual(data.sorts, [{ sort: 'product_code', dir: 'desc' }, { sort: 'revenue', dir: 'desc' }]);
  } finally { await db.close(); }
});

test('phan trang: kep ve trang cuoi, tong khong doi', async () => {
  const db = await setup();
  try {
    await seed(db);
    const page = await repo.getProductCustomerGrowth({ page: 3, pageSize: 4, pool: db });
    assert.equal(page.page, 3);
    assert.equal(page.rows.length, 1);
    assert.equal(page.summary.totalRows, 9);
    const clamped = await repo.getProductCustomerGrowth({ page: 99, pageSize: 4, pool: db });
    assert.equal(clamped.page, 3);
    assert.deepEqual(names(clamped), names(page));
  } finally { await db.close(); }
});

test('validate: tham so sai -> 400, khong cham DB', async () => {
  const bad = [
    { growth: 'xxx' }, { growth: 5 }, { sort: 'revenue; DROP TABLE x' }, { sort: 'constructor' }, { dir: 'up' },
    { product: 'x'.repeat(201) }, { customer: ['a', 'b'] }, { pageSize: '201' }, { pageSize: '0' }, { page: '0' }, { page: '1.5' }
  ];
  for (const args of bad) {
    await assert.rejects(repo.getProductCustomerGrowth({ ...args, pool: { query: () => { throw new Error('khong duoc cham DB'); } } }),
      error => error.statusCode === 400, JSON.stringify(args));
  }
  assert.throws(() => repo.validateFilters({ growth: 'xxx' }), { statusCode: 400 });
  assert.doesNotThrow(() => repo.validateFilters({ product: 'a', customer: '', growth: 'check', sort: 'growth', dir: 'asc' }));
  assert.doesNotThrow(() => repo.validateFilters({ growth: 'lost' }));
  assert.doesNotThrow(() => repo.validateFilters({}));
});

test('chua co state / chua tinh cua so khach -> available:false', async () => {
  for (const state of ['none', 'no-window']) {
    const db = await setup({ state });
    try {
      await seed(db);
      const data = await repo.getProductCustomerGrowth({ pool: db });
      assert.deepEqual(data, { available: false, rows: [], summary: { totalRows: 0, lostRows: 0, checkRows: 0 } }, state);
    } finally { await db.close(); }
  }
});

test('xuat file: toan bo dong theo bo loc + sap xep, tran dong -> 413 EXPORT_TOO_MANY_ROWS', async () => {
  const db = await setup();
  try {
    await seed(db);
    const all = await repo.getProductCustomerGrowthForExport({ pool: db });
    assert.equal(all.available, true);
    assert.equal(all.rows.length, 9);
    assert.deepEqual(all.summary, { totalRows: 9, lostRows: 1, checkRows: 1 });
    assert.equal(all.periods.length, 3);
    const check = await repo.getProductCustomerGrowthForExport({ growth: 'check', sort: 'growth', dir: 'asc', pool: db });
    assert.deepEqual(names(check), ['Khách B']);
    await assert.rejects(repo.getProductCustomerGrowthForExport({ maxRows: 3, pool: db }),
      error => error.statusCode === 413 && error.code === 'EXPORT_TOO_MANY_ROWS' && /thu hẹp/.test(error.message));
    const empty = await repo.getProductCustomerGrowthForExport({ product: 'khongtontai', pool: db });
    assert.equal(empty.available, true);
    assert.deepEqual(empty.rows, []);
  } finally { await db.close(); }
  const none = await setup({ state: 'none' });
  try {
    assert.equal((await repo.getProductCustomerGrowthForExport({ pool: none })).available, false);
  } finally { await none.close(); }
});
