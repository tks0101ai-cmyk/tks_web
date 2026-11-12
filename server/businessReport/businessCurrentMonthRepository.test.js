'use strict';

// Repository doc doanh so thang hien tai tu bang tinh san (migration 0068) va lui ve live() khi can.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { seed } = require('./testFixtures');
const { createRepository } = require('./businessReportRepository');
const job = require('../kiotvietSync/businessCurrentMonthRefresh');

const MIGRATION = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0068_business_current_month.sql'), 'utf8');
const NOW = new Date('2026-10-06T03:00:00Z');
const MIN = 60 * 1000;
const quiet = () => {};
const MONTHS = ['2026-09-01', '2026-10-01'];

const OCTOBER_EXTRA = `
  INSERT INTO invoices VALUES ('hanoi', 105, 'HD5', '2026-10-05 10:00:00+00', 50, 1, '{"statusValue":"Hoàn thành","customerCode":"KH1","customerName":"Chị A"}');
  INSERT INTO invoice_details VALUES ('hanoi', 105, 1, 11, 1, 50, 0, '{"productCode":"SP2","subTotal":50}');
  INSERT INTO invoices VALUES ('saigon', 301, 'HD6', '2026-10-04 10:00:00+00', 300, 1, '{"statusValue":"Hoàn thành","customerCode":"KH1","customerName":"Anh B"}');
  INSERT INTO invoice_details VALUES ('saigon', 301, 1, 10, 3, 100, 0, '{"productCode":"SP1","subTotal":300}');
  INSERT INTO invoices VALUES ('hanoi', 106, 'HD7', '2026-10-03 10:00:00+00', 60, 1, '{"statusValue":"Hoàn thành"}');
  INSERT INTO invoice_details VALUES ('hanoi', 106, 1, 11, 1, 60, 0, '{"productCode":"SP2","subTotal":60}');
  INSERT INTO returns VALUES ('hanoi', 202, 'TH2', '2026-10-05 09:00:00+00', 20, 1, '{"statusValue":"Đã trả","customerCode":"KH1"}');
  INSERT INTO return_details VALUES ('hanoi', 202, 1, 10, 1, 20, '{"productCode":"SP1","subTotal":20}');`;

// Pool PGlite ghi lai moi truy van de biet thang 10 co di qua cau live (customer_by_name) hay khong.
function spyPool(db) {
  const calls = [];
  const run = (text, params) => { calls.push({ text: String(text), params }); return db.query(text, params); };
  return {
    calls, query: run, connect: async () => ({ query: run, release() {} }),
    liveOctoberQueries: () => calls.filter(c => /customer_by_name/.test(c.text) && c.params && c.params[1] === '2026-10-01').length
  };
}

async function setup({ migrate = true } = {}) {
  job.__test__.resetState();
  const db = new PGlite();
  await seed(db);
  if (migrate) await db.exec(MIGRATION);
  await db.exec(OCTOBER_EXTRA);
  return { db, pool: spyPool(db) };
}

const jobOptions = (at = NOW.getTime()) => ({ now: () => at, log: quiet, minIntervalMs: 0 });
const key = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
const october = snap => ({
  customers: snap.customers.filter(r => r.month === '2026-10-01')
    .map(r => [r.branch, r.customerCode, r.customerName, r.netRevenue]).sort(key),
  products: snap.products.filter(r => r.month === '2026-10-01')
    .map(r => [r.productCode, r.productName, r.netRevenue, r.netQty]).sort(key)
});
const octoberUsers = snap => snap.customers.filter(r => r.month === '2026-10-01').length;

test('doc tu bang tinh san cho ra dung so cua live(): khach, khach le, HN+SG, ma hang; thang 10 khong chay cau live', async () => {
  const { db, pool } = await setup();
  try {
    // Chua co state => lui ve live().
    const liveRepo = createRepository({ pool, now: () => NOW, onCurrentMonthChanged: () => () => {} });
    const liveSnap = await liveRepo.snapshot();
    assert.ok(pool.liveOctoberQueries() >= 2, 'chua tinh san => thang 10 tinh live');
    assert.ok(octoberUsers(liveSnap) >= 3);
    const liveTop = await liveRepo.customerProducts({ branch: 'hanoi', customerCode: 'KH1', months: MONTHS });
    const liveBuyers = await liveRepo.productCustomers({ productCode: 'SP2', months: MONTHS });

    await job.refreshBusinessCurrentMonth(pool, jobOptions());
    pool.calls.length = 0;
    const repo = createRepository({ pool, now: () => NOW, onCurrentMonthChanged: () => () => {} });
    const tableSnap = await repo.snapshot();
    assert.deepEqual(october(tableSnap), october(liveSnap));
    assert.equal(pool.liveOctoberQueries(), 0, 'thang 10 doc tu bang, khong chay cau live');
    assert.deepEqual(await repo.customerProducts({ branch: 'hanoi', customerCode: 'KH1', months: MONTHS }), liveTop);
    assert.deepEqual(await repo.productCustomers({ productCode: 'SP2', months: MONTHS }), liveBuyers);
    assert.equal(pool.liveOctoberQueries(), 0, '/detail thang 10 cung doc bang');
    assert.ok(pool.calls.some(c => /FROM business_current_month_customer_product_sales\s+WHERE month = \$1::date AND/.test(c.text)),
      '/detail truy van thang vao bang khach x ma (khong tai ca thang)');
  } finally { await db.close(); }
});

test('khach / ma hang ngung hoat dong van bi loai khi doc tu bang (loc luc doc)', async () => {
  const { db, pool } = await setup();
  try {
    await job.refreshBusinessCurrentMonth(pool, jobOptions());
    await db.exec(`UPDATE products SET is_active = false WHERE code = 'SP2'; UPDATE customers SET raw = '{"isActive":false}' WHERE code = 'KH2'`);
    const snap = await createRepository({ pool, now: () => NOW, onCurrentMonthChanged: () => () => {} }).snapshot();
    assert.equal(snap.products.some(r => r.month === '2026-10-01' && r.productCode === 'SP2'), false);
    assert.ok(snap.products.some(r => r.month === '2026-10-01' && r.productCode === 'SP1'));
  } finally { await db.close(); }
});

test('thieu migration 0068: bao cao van chay bang live(), khong loi', async () => {
  const { db, pool } = await setup({ migrate: false });
  try {
    const repo = createRepository({ pool, now: () => NOW, onCurrentMonthChanged: () => () => {} });
    const snap = await repo.snapshot();
    assert.ok(octoberUsers(snap) >= 3);
    assert.ok(pool.liveOctoberQueries() >= 2);
    const top = await repo.customerProducts({ branch: 'hanoi', customerCode: 'KH1', months: MONTHS });
    assert.ok(top.length > 0);
    // Co migration nhung chua chay job (khong co state) => cung lui ve live().
    await db.exec(MIGRATION);
    pool.calls.length = 0;
    const again = await createRepository({ pool, now: () => NOW, onCurrentMonthChanged: () => () => {} }).snapshot();
    assert.deepEqual(october(again), october(snap));
    assert.ok(pool.liveOctoberQueries() >= 2);
  } finally { await db.close(); }
});

test('bang qua han (> 30 phut) hoac lech thang => lui ve live() voi dung so hien tai', async () => {
  const { db, pool } = await setup();
  try {
    await job.refreshBusinessCurrentMonth(pool, jobOptions());
    // Hoa don moi sau khi job chay xong: bang cu khong co, live() co.
    await db.exec(`INSERT INTO invoices VALUES ('hanoi', 107, 'HD8', '2026-10-05 12:00:00+00', 1000, 1, '{"statusValue":"Hoàn thành","customerCode":"KH1","customerName":"Chị A"}')`);
    const fresh = await createRepository({ pool, now: () => new Date(NOW.getTime() + 29 * MIN), onCurrentMonthChanged: () => () => {} }).snapshot();
    const kh1 = snap => snap.customers.find(r => r.month === '2026-10-01' && r.branch === 'hanoi' && r.customerCode === 'KH1').netRevenue;
    assert.equal(kh1(fresh), 530, 'con han => so tinh san (chua thay HD8)');
    pool.calls.length = 0;
    const stale = await createRepository({ pool, now: () => new Date(NOW.getTime() + 31 * MIN), onCurrentMonthChanged: () => () => {} }).snapshot();
    assert.equal(kh1(stale), 1530, 'qua han => tinh live, thay HD8');
    assert.ok(pool.liveOctoberQueries() >= 2);
    // Lech thang: state noi thang 9 nhung dang la thang 10.
    await db.exec(`UPDATE business_current_month_state SET month = '2026-09-01', computed_at = '${NOW.toISOString()}'`);
    pool.calls.length = 0;
    const mismatch = await createRepository({ pool, now: () => NOW, onCurrentMonthChanged: () => () => {} }).snapshot();
    assert.equal(kh1(mismatch), 1530);
    assert.ok(pool.liveOctoberQueries() >= 2);
  } finally { await db.close(); }
});

test('loi doc bang tinh san (khong phai thieu bang) => lui ve live(), khong nem loi', async () => {
  const { db, pool } = await setup();
  const original = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await job.refreshBusinessCurrentMonth(pool, jobOptions());
    await db.exec('ALTER TABLE business_current_month_customer_sales RENAME COLUMN net_revenue TO net_revenue_old');
    const snap = await createRepository({ pool, now: () => NOW, onCurrentMonthChanged: () => () => {} }).snapshot();
    assert.ok(octoberUsers(snap) >= 3);
    assert.ok(logs.some(line => /business-report/.test(line)));
  } finally { console.error = original; await db.close(); }
});

// 12/11/2026: job đổi bảng => snapshot ĐÁNH DẤU CŨ (không xóa trắng): lần đọc ngay sau trả bản cũ (người dùng không phải chờ
// tải lại 8–11 s), bản mới nạp nền và có ngay sau đó — vẫn không phải chờ hết 60 s.
test('job doi bang => repository tra ban cu ngay va lam moi nen (khong cho het 60s), con khong doi thi giu cache', async () => {
  const { db, pool } = await setup();
  try {
    await job.refreshBusinessCurrentMonth(pool, jobOptions());
    const repo = createRepository({ pool, now: () => NOW });
    const kh1 = async () => (await repo.snapshot()).customers
      .find(r => r.month === '2026-10-01' && r.branch === 'hanoi' && r.customerCode === 'KH1').netRevenue;
    assert.equal(await kh1(), 530);
    await db.exec(`INSERT INTO invoices VALUES ('hanoi', 107, 'HD8', '2026-10-05 12:00:00+00', 1000, 1, '{"statusValue":"Hoàn thành","customerCode":"KH1","customerName":"Chị A"}')`);
    assert.equal(await kh1(), 530, 'chua chay job: van cache cu trong 60s');
    const idle = await job.refreshBusinessCurrentMonth(pool, jobOptions(NOW.getTime() + MIN));
    assert.equal(idle.changed, true);
    assert.equal(await kh1(), 530, 'job ghi bang => tra ngay ban cu, khong bat cho tai lai');
    let fresh = 530;
    for (let i = 0; i < 200 && fresh !== 1530; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      fresh = await kh1();
    }
    assert.equal(fresh, 1530, 'ban moi nap nen co ngay sau do (khong cho het 60s)');
    const calls = pool.calls.length;
    await job.refreshBusinessCurrentMonth(pool, jobOptions(NOW.getTime() + 2 * MIN));
    assert.equal(await kh1(), 1530);
    assert.ok(pool.calls.length > calls);
  } finally { await db.close(); }
});
