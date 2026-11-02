'use strict';

// Tinh lai so phat thang dang mo: ham thuan + SQL that (migration 0047-0051) tren PGlite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { takeDebtCycleSnapshot } = require('./debtCycleSnapshot');
const { createDebtScheduleRepository } = require('./debtScheduleRepository');
const { recalcLedger, recalcPenaltyLedger, monthBounds } = require('./debtPenaltyRecalc');

const MIGRATION = ['0047_debt_schedule_report.sql', '0048_debt_penalty.sql', '0050_debt_cycle_manual_refresh.sql', '0051_debt_penalty_ledger.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8')).join(' ');

const BASE_SCHEMA = `
  CREATE TABLE customers (branch TEXT, id BIGINT, code TEXT, name TEXT, debt NUMERIC, raw JSONB, PRIMARY KEY (branch, id));
  CREATE TABLE invoices (branch TEXT, id BIGINT, customer_id BIGINT, purchase_date TIMESTAMPTZ, total NUMERIC, raw JSONB);
  CREATE TABLE returns (branch TEXT, id BIGINT, customer_id BIGINT, return_date TIMESTAMPTZ, total NUMERIC, raw JSONB);
`;

function poolFor(db) {
  return {
    query: (sql, params) => db.query(sql, params),
    connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} })
  };
}

const noAverages = async () => ({ branches: [], codes: [], values: [] });
const at15 = date => new Date(`${date}T08:00:00Z`);
const snapshot = (pool, date) => takeDebtCycleSnapshot(pool, date, { takenAt: at15(date), log: () => {}, loadAverages: noAverages });
const user = { id: 'u1', hoTen: 'Quản lý A' };
const quiet = { log: () => {}, now: new Date('2026-08-13T03:00:00Z') };

const L = (cycleDate, customerId, over = {}) => ({
  cycleDate, branch: 'hanoi', customerId, sale: 'Lan', overdue: 900000, overdueStreak: 1, amount: 25000, isManual: false, status: 'Chưa xử lý', ...over
});

test('recalcLedger: "Đã xử lý" bị xóa, ngày liền kề sau đó là phiên 1, chuỗi đứt khi thiếu ngày', () => {
  const cycleDates = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'];
  const rows = [
    L('2026-08-01', '1', { overdueStreak: 1, amount: 25000 }),
    L('2026-08-02', '1', { overdueStreak: 2, amount: 25000, status: 'Đã xử lý', isManual: true }),
    L('2026-08-03', '1', { overdueStreak: 3, amount: 50000 }),
    L('2026-08-04', '1', { overdueStreak: 4, amount: 100000 }),
    // khách 2 thiếu ngày 08-03 -> đứt chuỗi, 08-04 là phiên 1
    L('2026-08-02', '2', { overdueStreak: 5, amount: 150000 }),
    L('2026-08-04', '2', { overdueStreak: 6, amount: 200000 }),
    // "Bỏ qua" vẫn cộng dồn: không đổi
    L('2026-08-01', '3', { overdueStreak: 1, amount: 25000, status: 'Bỏ qua' }),
    L('2026-08-02', '3', { overdueStreak: 2, amount: 25000 }),
    // nợ lẻ < 400k luôn 25k, streak 0
    L('2026-08-01', '4', { overdue: 100000, overdueStreak: 0, amount: 25000 }),
    // dòng cũ từng là số tay: không còn phạt tay nên amount cũng về mức quy chế, streak tính lại
    L('2026-08-01', '5', { overdueStreak: 1, amount: 25000 }),
    L('2026-08-02', '5', { overdueStreak: 7, amount: 33000, isManual: true })
  ];
  const changes = recalcLedger({ rows, cycleDates });
  const pick = (date, id) => changes.find(c => c.row.cycleDate === date && c.row.customerId === id);
  assert.equal(pick('2026-08-02', '1').action, 'delete');
  assert.deepEqual(pick('2026-08-03', '1').after, { amount: 25000, streak: 1 });
  assert.deepEqual(pick('2026-08-04', '1').after, { amount: 25000, streak: 2 });
  assert.deepEqual(pick('2026-08-02', '2').after, { amount: 25000, streak: 1 });
  assert.deepEqual(pick('2026-08-04', '2').after, { amount: 25000, streak: 1 });
  assert.equal(pick('2026-08-01', '3'), undefined);
  assert.equal(pick('2026-08-02', '3'), undefined);
  assert.equal(pick('2026-08-01', '4'), undefined);
  assert.deepEqual(pick('2026-08-02', '5').after, { amount: 25000, streak: 2 });
});

test('recalcLedger: dòng seed (chu kỳ ngày trước tháng) chỉ đọc, không sửa; seed "Đã xử lý" reset chuỗi', () => {
  const cycleDates = ['2026-07-31', '2026-08-01'];
  const rows = [
    L('2026-07-31', '1', { overdueStreak: 4, amount: 100000 }),
    L('2026-08-01', '1', { overdueStreak: 9, amount: 200000 }),
    L('2026-07-31', '2', { overdueStreak: 4, amount: 100000, status: 'Đã xử lý' }),
    L('2026-08-01', '2', { overdueStreak: 5, amount: 150000 })
  ];
  const changes = recalcLedger({ rows, cycleDates, seedDate: '2026-07-31' });
  assert.equal(changes.length, 2);
  assert.ok(changes.every(c => c.row.cycleDate === '2026-08-01'));
  assert.deepEqual(changes.find(c => c.row.customerId === '1').after, { amount: 150000, streak: 5 });
  assert.deepEqual(changes.find(c => c.row.customerId === '2').after, { amount: 25000, streak: 1 });
});

test('recalcLedger idempotent: kết quả tính lại không còn thay đổi', () => {
  const cycleDates = ['2026-08-01', '2026-08-02'];
  const rows = [L('2026-08-01', '1', { overdueStreak: 1 }), L('2026-08-02', '1', { overdueStreak: 2 })];
  assert.deepEqual(recalcLedger({ rows, cycleDates }), []);
});

test('monthBounds', () => {
  assert.deepEqual(monthBounds('2026-12-15'), { start: '2026-12-01', end: '2027-01-01' });
  assert.deepEqual(monthBounds('2026-02-28'), { start: '2026-02-01', end: '2026-03-01' });
});

async function setup() {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(MIGRATION);
  await db.exec(`INSERT INTO customers VALUES
    ('hanoi', 1, 'KH1', 'Khách Một', 900000, '{"groups":"Lan"}'),
    ('hanoi', 3, 'KH3', 'Khách Ba', 900000, '{"groups":"Lan"}'),
    ('saigon', 1, 'KH1', 'Khách Một SG', 900000, '{"groups":"Mai"}');`);
  const pool = poolFor(db);
  const repository = createDebtScheduleRepository({ pool });
  await snapshot(pool, '2026-08-10');
  await repository.saveStatus({ branch: 'hanoi', customerId: '1', status: 'Đã xử lý', user });
  await snapshot(pool, '2026-08-11');
  await snapshot(pool, '2026-08-12');
  // Sổ phạt đã chốt cũ (quy tắc cũ): HN1 "Đã xử lý" vẫn bị phạt, streak sai ở các ngày sau.
  await db.exec(`
    INSERT INTO debt_penalty_cycles (cycle_date) VALUES ('2026-08-10'), ('2026-08-11');
    INSERT INTO debt_penalty_daily (cycle_date, branch, customer_id, sale, overdue_debt, overdue_streak, amount, is_manual, status) VALUES
      ('2026-08-10', 'hanoi', 1, 'Lan', 900000, 1, 25000, false, 'Đã xử lý'),
      ('2026-08-11', 'hanoi', 1, 'Lan', 900000, 2, 25000, false, 'Chưa xử lý'),
      ('2026-08-11', 'hanoi', 3, 'Lan', 900000, 1, 40000, true, 'Đã xử lý'),
      ('2026-08-10', 'saigon', 1, 'Mai', 900000, 1, 25000, false, 'Chưa xử lý'),
      ('2026-08-11', 'saigon', 1, 'Mai', 900000, 5, 150000, false, 'Chưa xử lý');
    UPDATE debt_cycle_customers SET overdue_streak = 9 WHERE cycle_date >= '2026-08-11';`);
  return { db, pool };
}

test('dry-run không ghi gì; báo cáo diff theo sale', async () => {
  const { db, pool } = await setup();
  try {
    const result = await recalcPenaltyLedger(pool, { ...quiet, apply: false });
    assert.equal(result.month, '2026-08');
    assert.equal(result.applied, false);
    const lan = result.bySale.find(item => item.sale === 'Lan');
    // Lan: trước 25k + 25k + 40k = 90k; sau: HN1 08-10 xóa, HN1 08-11 streak 1 (25k), HN3 xóa -> 25k
    assert.deepEqual([lan.before, lan.after, lan.deleted, lan.changed], [90000, 25000, 2, 1]);
    const mai = result.bySale.find(item => item.sale === 'Mai');
    assert.deepEqual([mai.before, mai.after], [175000, 50000]);
    assert.equal((await db.query('SELECT SUM(amount)::int AS s FROM debt_penalty_daily')).rows[0].s, 265000);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_cycle_customers WHERE overdue_streak = 9')).rows[0].n, 6);
    assert.equal((await db.query("SELECT to_regclass('debt_penalty_daily_backup_20260813') AS t")).rows[0].t, null);
  } finally { await db.close(); }
});

test('--apply: ghi 1 transaction + bảng sao lưu, đồng bộ overdue_streak bản chốt, chạy lại không đổi', async () => {
  const { db, pool } = await setup();
  try {
    const result = await recalcPenaltyLedger(pool, { ...quiet, apply: true });
    assert.equal(result.backup, 'debt_penalty_daily_backup_20260813');
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_penalty_daily_backup_20260813')).rows[0].n, 5);
    const rows = (await db.query(`SELECT cycle_date::text AS d, branch, customer_id::int AS id, overdue_streak AS streak, amount::int AS amount
      FROM debt_penalty_daily ORDER BY cycle_date, branch, customer_id`)).rows;
    assert.deepEqual(rows, [
      { d: '2026-08-10', branch: 'saigon', id: 1, streak: 1, amount: 25000 },
      { d: '2026-08-11', branch: 'hanoi', id: 1, streak: 1, amount: 25000 },
      { d: '2026-08-11', branch: 'saigon', id: 1, streak: 2, amount: 25000 }
    ]);
    // Bản chốt 08-11: HN1 sau "Đã xử lý" 08-10 = phiên 1; SG1 = 2. 08-12: HN1 = 2, SG1 = 3.
    const streaks = (await db.query(`SELECT cycle_date::text AS d, branch, overdue_streak AS streak
      FROM debt_cycle_customers WHERE customer_id = 1 ORDER BY cycle_date, branch`)).rows;
    assert.deepEqual(streaks.map(r => `${r.d}:${r.branch}:${r.streak}`), [
      '2026-08-10:hanoi:1', '2026-08-10:saigon:1', '2026-08-11:hanoi:1', '2026-08-11:saigon:2', '2026-08-12:hanoi:2', '2026-08-12:saigon:3'
    ]);
    assert.ok(result.snapshotBackup);

    const again = await recalcPenaltyLedger(pool, { ...quiet, apply: true });
    assert.deepEqual(again.changes, []);
    assert.equal(again.backup, null);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_penalty_daily')).rows[0].n, 3);
  } finally { await db.close(); }
});

test('không đụng tháng khác', async () => {
  const { db, pool } = await setup();
  try {
    await db.exec(`INSERT INTO debt_penalty_daily (cycle_date, branch, customer_id, sale, overdue_debt, overdue_streak, amount, status)
      VALUES ('2026-07-20', 'hanoi', 1, 'Lan', 900000, 3, 50000, 'Đã xử lý')`);
    await recalcPenaltyLedger(pool, { ...quiet, apply: true });
    assert.equal((await db.query("SELECT COUNT(*)::int AS n FROM debt_penalty_daily WHERE cycle_date = '2026-07-20'")).rows[0].n, 1);
  } finally { await db.close(); }
});
