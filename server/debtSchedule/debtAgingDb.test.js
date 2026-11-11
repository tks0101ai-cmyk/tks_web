'use strict';

// Chay SQL THAT cua migration 0059 + job tinh san (debtAgingRefresh) + doc (debtAgingRepository) tren PGlite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { refreshDebtAging } = require('./debtAgingRefresh');
const { createDebtAgingRepository } = require('./debtAgingRepository');
const { buildDebtAging, buildDebtAgingInvoices } = require('./debtScheduleService');

const MIGRATION = ['0047_debt_schedule_report.sql', '0059_debt_aging.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8')).join('\n');

const BASE_SCHEMA = `
  CREATE TABLE customers (branch TEXT, id BIGINT, code TEXT, name TEXT, debt NUMERIC, raw JSONB,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (branch, id));
  CREATE TABLE invoices (branch TEXT, id BIGINT, customer_id BIGINT, purchase_date TIMESTAMPTZ, total NUMERIC, raw JSONB,
    code TEXT, sold_by_id BIGINT);
  CREATE TABLE staff (branch TEXT, id BIGINT, name TEXT);
  CREATE TABLE returns (branch TEXT, id BIGINT, customer_id BIGINT, return_date TIMESTAMPTZ, total NUMERIC, raw JSONB);
`;

// 17/10/2026 10:00 gio VN.
const NOW = Date.parse('2026-10-17T03:00:00Z');
const quiet = () => {};

async function setup() {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(MIGRATION);
  const pool = {
    query: (sql, params) => db.query(sql, params),
    connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} })
  };
  return { db, pool, repo: createDebtAgingRepository({ pool, now: () => NOW }) };
}

async function seed(db) {
  await db.exec(`
    INSERT INTO customers (branch, id, code, name, debt, raw, synced_at) VALUES
      ('hanoi', 1, 'KH1', 'Anh Bình', 600, '{"groups":"Duy Thái"}', '2026-10-17T02:40:00Z'),
      ('hanoi', 2, 'KH2', 'Chị An', 0, '{"groups":"Duy Thái"}', '2026-10-17T02:30:00Z'),
      ('hanoi', 3, 'KH3', 'Ngừng', 900, '{"isActive":false}', '2026-10-17T02:30:00Z'),
      ('saigon', 1, 'KMN1', 'Anh Sài', 50, '{}', '2026-10-17T02:50:00Z');
    INSERT INTO debt_payment_schedules (branch, customer_id, schedule_days) VALUES ('hanoi', 1, 5);
    -- gio VN gan nhan UTC: 2026-10-15 23:30 "UTC" la ngay 15/10 theo VN.
    INSERT INTO invoices VALUES
      ('hanoi', 10, 1, '2026-10-17T08:00:00Z', 100, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 11, 1, '2026-10-15T23:30:00Z', 200, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 12, 1, '2026-10-12T09:00:00Z', 5000, '{"statusValue":"Đã hủy"}'),
      ('hanoi', 13, 1, '2026-10-10T09:00:00Z', 300, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 14, 2, '2026-10-16T09:00:00Z', 999, '{"statusValue":"Hoàn thành"}'),
      ('saigon', 15, 1, '2026-10-16T09:00:00Z', 80, '{"statusValue":"Hoàn thành"}');
    INSERT INTO returns VALUES ('hanoi', 20, 1, '2026-10-16T09:00:00Z', 500, '{"statusValue":"Đã trả"}');`);
}

test('aging reads hide newly inactive and deleted customers before the next refresh, including invoice details', async () => {
  const { db, pool, repo } = await setup();
  try {
    await seed(db);
    await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    await db.exec(`UPDATE customers SET raw = '{"isActive":false}' WHERE branch='hanoi' AND id=1;
      UPDATE customers SET raw = '{"IsActive":false}' WHERE branch='hanoi' AND id=2;`);
    assert.deepEqual((await repo.readAging(['hanoi', 'saigon'])).rows.map(row => row.branchCode + ':' + row.customerId), ['saigon:1']);
    for (const id of ['1', '2']) {
      assert.deepEqual(await repo.readCustomerInvoices('hanoi', id), { customer: null, invoices: [] });
      await assert.rejects(buildDebtAgingInvoices(['hanoi'], { branch: 'hanoi', customerId: id }, { repository: repo }), { statusCode: 404 });
    }
    await db.exec(`UPDATE customers SET raw = '{"isActive":true,"IsActive":false}' WHERE branch='hanoi' AND id=1;
      DELETE FROM customers WHERE branch='saigon' AND id=1;`);
    repo.clearCache();
    assert.deepEqual((await repo.readAging(['hanoi', 'saigon'])).rows.map(row => row.branchCode + ':' + row.customerId), ['hanoi:1']);
    assert.deepEqual(await repo.readCustomerInvoices('saigon', '1'), { customer: null, invoices: [] });
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_aging_customers')).rows[0].n, 3);
  } finally { await db.close(); }
});

test('tinh san tu bang chung: bo hoa don huy, khong tru tra hang, bo khach ngung hoat dong; web chi doc', async () => {
  const { db, pool, repo } = await setup();
  try {
    await seed(db);
    const result = await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    assert.equal(result.customers, 3);
    assert.equal(result.written, 3);
    const report = await buildDebtAging(['hanoi', 'saigon'], { repository: repo });
    assert.equal(report.available, true);
    assert.equal(report.asOfDay, '2026-10-17');
    assert.equal(report.customersSyncedAt, '2026-10-17T02:50:00.000Z');
    assert.deepEqual(report.customers.map(row => row.customerKey), ['hanoi:1', 'hanoi:2', 'saigon:1']);
    const binh = report.customers[0];
    assert.equal(binh.branch, 'HN');
    assert.equal(binh.payoffDay, '2026-10-10');
    assert.equal(binh.equivalentDays, 8);
    assert.equal(binh.remainingDays, -3);
    assert.equal(binh.sale, 'Duy Thái');
    assert.equal(binh.paymentSchedule, '5');
    assert.equal(binh.hasStoredSchedule, true);
    // lich 5 ngay (13..17/10): 100 + 200 trong lich -> qua han 300.
    assert.equal(binh.overdueDebt, 300);
    assert.equal(report.customers[1].payoffDay, null);
    const sai = report.customers[2];
    assert.equal(sai.sale, 'Chưa phân nhóm');
    assert.equal(sai.payoffDay, '2026-10-16');
    assert.equal(sai.equivalentDays, 2);
    assert.equal(sai.remainingDays, -1);
  } finally { await db.close(); }
});

test('luot khong doi ghi 0 dong; doi no / khach ngung thi chi ghi phan khac va xoa dong thua', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    const first = await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    const idle = await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    assert.deepEqual([idle.written, idle.deleted, idle.changed], [0, 0, false]);
    assert.equal(idle.version, first.version);
    await db.exec(`UPDATE customers SET debt = 10 WHERE branch = 'saigon';
      UPDATE customers SET raw = '{"isActive":false}' WHERE branch = 'hanoi' AND id = 2;`);
    const next = await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    assert.deepEqual([next.written, next.deleted, next.changed], [1, 1, true]);
    assert.equal(next.version, first.version + 1);
    const rows = (await db.query('SELECT branch, customer_id::text AS id, current_debt::int AS debt FROM debt_aging_customers ORDER BY branch, customer_id')).rows;
    assert.deepEqual(rows, [{ branch: 'hanoi', id: '1', debt: 600 }, { branch: 'saigon', id: '1', debt: 10 }]);
  } finally { await db.close(); }
});

test('sang ngay moi: ngay no tuong duong tang, con han giam', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    await refreshDebtAging(pool, { now: () => NOW + 86400000, log: quiet });
    const row = (await db.query(`SELECT equivalent_days, remaining_days FROM debt_aging_customers WHERE branch = 'hanoi' AND customer_id = 1`)).rows[0];
    assert.deepEqual(row, { equivalent_days: 9, remaining_days: -4 });
  } finally { await db.close(); }
});

test('loc co so + cache doc 60 giay; chua chay job thi available=false', async () => {
  const { db, pool, repo } = await setup();
  try {
    await seed(db);
    const empty = await buildDebtAging(['saigon'], { repository: createDebtAgingRepository({ pool, now: () => NOW }) });
    assert.equal(empty.available, false);
    await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    const first = await buildDebtAging(['saigon'], { repository: repo });
    assert.deepEqual(first.customers.map(row => row.customerKey), ['saigon:1']);
    await db.exec(`UPDATE customers SET debt = 10 WHERE branch = 'saigon'`);
    await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    assert.equal((await buildDebtAging(['saigon'], { repository: repo })).customers[0].currentDebt, 50);
    repo.clearCache();
    assert.equal((await buildDebtAging(['saigon'], { repository: repo })).customers[0].currentDebt, 10);
  } finally { await db.close(); }
});

test('chua ap migration 0059 -> bang rong, khong loi', async () => {
  const report = await buildDebtAging(['hanoi'], {
    repository: { readAging: async () => { const error = new Error('relation does not exist'); error.code = '42P01'; throw error; } }
  });
  assert.equal(report.available, false);
  assert.deepEqual(report.customers, []);
});

test('hop chi tiet: hoa don Hoan thanh tu ngay het no toi nay, moi nhat truoc; chan co so ngoai quyen', async () => {
  const { db, pool, repo } = await setup();
  try {
    await seed(db);
    await db.exec(`INSERT INTO staff VALUES ('hanoi', 7, 'Nguyễn Hiền - 123456');
      UPDATE invoices SET code = 'HD' || id, sold_by_id = 7 WHERE branch = 'hanoi' AND id IN (10, 11);
      UPDATE invoices SET code = 'HD' || id, raw = raw || '{"soldByName":"Lê Nam"}' WHERE branch = 'hanoi' AND id IN (12, 13, 14);`);
    await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    const detail = await buildDebtAgingInvoices(['hanoi', 'saigon'], { branch: 'hanoi', customerId: '1' }, { repository: repo });
    // payoffDay 10/10: lay HD10 (17/10), HD11 (15/10 VN), HD13 (10/10); bo HD12 (da huy), bo khach khac.
    assert.deepEqual(detail.invoices.map(row => row.code), ['HD10', 'HD11', 'HD13']);
    assert.deepEqual(detail.invoices.map(row => row.amount), [100, 200, 300]);
    assert.equal(detail.invoices[0].seller, 'Nguyễn Hiền');
    assert.equal(detail.invoices[2].seller, 'Lê Nam');
    assert.equal(detail.invoices[0].date, '17/10/2026 08:00');
    assert.equal(detail.invoices[0].customerName, 'Anh Bình');
    assert.equal(detail.total, 600);
    assert.deepEqual([detail.currentDebt, detail.equivalentDays, detail.remainingDays, detail.scheduleDays, detail.branch], [600, 8, -3, 5, 'HN']);
    // Khach het no: khong co khoang -> danh sach rong.
    const clear = await buildDebtAgingInvoices(['hanoi'], { branch: 'hanoi', customerId: '2' }, { repository: repo });
    assert.equal(clear.payoffDay, null);
    assert.deepEqual(clear.invoices, []);
    await assert.rejects(buildDebtAgingInvoices(['saigon'], { branch: 'hanoi', customerId: '1' }, { repository: repo }), { statusCode: 403 });
    await assert.rejects(buildDebtAgingInvoices(['hanoi'], { branch: 'hanoi', customerId: 'x' }, { repository: repo }), { statusCode: 400 });
    await assert.rejects(buildDebtAgingInvoices(['hanoi'], { branch: 'hanoi', customerId: '999' }, { repository: repo }), { statusCode: 404 });
  } finally { await db.close(); }
});

test('doc dong thoi dung chung 1 luot DB; clearCache giua luc doc thi ket qua cu khong duoc giu', async () => {
  const { db, pool } = await setup();
  try {
    await seed(db);
    await refreshDebtAging(pool, { now: () => NOW, log: quiet });
    let reads = 0;
    const counted = { query: (sql, params) => { if (/FROM debt_aging_customers/i.test(sql)) reads++; return pool.query(sql, params); } };
    const repo = createDebtAgingRepository({ pool: counted, now: () => NOW });
    const [a, b, c] = await Promise.all([repo.readAging(['hanoi', 'saigon']), repo.readAging(['saigon', 'hanoi']), repo.readAging(['hanoi', 'saigon'])]);
    assert.equal(reads, 1, 'request trung luc cache trong chi doc 1 lan');
    assert.equal(a, b); assert.equal(b, c);
    const loading = repo.readAging(['hanoi']);
    repo.clearCache();
    await loading;
    await repo.readAging(['hanoi']);
    assert.equal(reads, 3, 'ket qua doc truoc clearCache khong duoc giu');
  } finally { await db.close(); }
});
