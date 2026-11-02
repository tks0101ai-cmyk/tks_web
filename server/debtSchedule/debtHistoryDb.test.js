'use strict';

// Lich su 7 ngay cua khach + sua trang thai ngay cu (SQL that tren PGlite).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createDebtScheduleRepository } = require('./debtScheduleRepository');

const MIGRATION = ['0047_debt_schedule_report.sql', '0048_debt_penalty.sql', '0050_debt_cycle_manual_refresh.sql', '0051_debt_penalty_ledger.sql', '0052_debt_reward_months.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8')).join(' ');

function poolFor(db) {
  return {
    query: (sql, params) => db.query(sql, params),
    connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} })
  };
}

const DATES = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const manager = { id: 'm1', hoTen: 'Quản lý A' };
const target = { branch: 'hanoi', customerId: '1', user: manager };

// Khach 1 no cham 500k ca 5 ngay (phien 1..5); 28..31/10 da chot so phat, 01/11 la ngay dang mo.
async function setup({ sealed = DATES.slice(0, 4) } = {}) {
  const db = new PGlite();
  await db.exec(`CREATE TABLE customers (branch TEXT, id BIGINT, code TEXT, name TEXT, debt NUMERIC, raw JSONB, PRIMARY KEY (branch, id));`);
  await db.exec(MIGRATION);
  await db.exec(`INSERT INTO customers VALUES ('hanoi', 1, 'KH1', 'Khách Một', 500000, '{"groups":"Lan"}'),
    ('hanoi', 2, 'KH2', 'Khách Hai', 0, '{"groups":"Lan"}')`);
  for (const [i, date] of DATES.entries()) {
    await db.exec(`INSERT INTO debt_cycle_runs (cycle_date, taken_at) VALUES ('${date}', '${date}T08:00:00Z');
      INSERT INTO debt_cycle_customers (cycle_date, branch, customer_id, current_debt, overdue_debt, overdue_streak)
        VALUES ('${date}', 'hanoi', 1, 500000, 500000, ${i + 1});`);
  }
  for (const date of sealed) {
    const streak = DATES.indexOf(date) + 1;
    const amount = [25000, 25000, 50000, 100000, 150000][streak - 1];
    await db.exec(`INSERT INTO debt_penalty_cycles (cycle_date) VALUES ('${date}');
      INSERT INTO debt_penalty_daily (cycle_date, branch, customer_id, sale, customer_code, customer_name, overdue_debt, overdue_streak, amount, status)
        VALUES ('${date}', 'hanoi', 1, 'Lan', 'KH1', 'Khách Một', 500000, ${streak}, ${amount}, 'Chưa xử lý')`);
  }
  return { db, repo: createDebtScheduleRepository({ pool: poolFor(db) }) };
}

const ledger = db => db.query('SELECT cycle_date::text AS d, overdue_streak AS s, amount::int AS a FROM debt_penalty_daily ORDER BY cycle_date')
  .then(r => r.rows.map(row => [row.d, row.s, row.a]));
const streaks = db => db.query('SELECT overdue_streak AS s FROM debt_cycle_customers WHERE customer_id = 1 ORDER BY cycle_date')
  .then(r => r.rows.map(row => row.s));

test('listCustomerHistory tra 5 ngay cu -> moi voi phien, phat theo quy che va tong', async () => {
  const { db, repo } = await setup();
  try {
    const history = await repo.listCustomerHistory({ branch: 'hanoi', customerId: '1' });
    assert.equal(history.customer.customerName, 'Khách Một');
    assert.deepEqual(history.days.map(d => d.cycleDate), DATES);
    assert.deepEqual(history.days.map(d => d.overdueStreak), [1, 2, 3, 4, 5]);
    assert.deepEqual(history.days.map(d => d.penalty), [25000, 25000, 50000, 100000, 150000]);
    assert.equal(history.totalPenalty, 350000);
    assert.ok(history.days.every(d => d.rewardFinalized === false && d.status === 'Chưa xử lý'));
  } finally { await db.close(); }
});

test('khach khong co dong o mot ban chot -> present=false, khong phat; khach la 404', async () => {
  const { db, repo } = await setup();
  try {
    await db.exec(`DELETE FROM debt_cycle_customers WHERE cycle_date = '2026-10-29'`);
    const history = await repo.listCustomerHistory({ branch: 'hanoi', customerId: '1' });
    assert.equal(history.days[1].present, false);
    assert.equal(history.days[1].penalty, null);
    await assert.rejects(repo.listCustomerHistory({ branch: 'hanoi', customerId: '99' }), error => error.statusCode === 404);
    await assert.rejects(repo.listCustomerHistory({ branch: 'xx', customerId: '1' }), error => error.statusCode === 400);
  } finally { await db.close(); }
});

test('Da xu ly o ngay giua: ngay do het phat, cac ngay sau reset phien, so phat da chot cap nhat', async () => {
  const { db, repo } = await setup();
  try {
    const result = await repo.saveHistoricalStatus({ ...target, cycleDate: '2026-10-30', status: 'Đã xử lý' });
    assert.equal(result.changed, true);
    assert.equal(result.recalculatedDays, 2);
    assert.deepEqual(await streaks(db), [1, 2, 3, 1, 2]);
    // 30/10 het phat (xoa dong), 31/10 phien 1 = 25k; 01/11 dang mo nen khong co dong so.
    assert.deepEqual(await ledger(db), [['2026-10-28', 1, 25000], ['2026-10-29', 2, 25000], ['2026-10-31', 1, 25000]]);
    const history = await repo.listCustomerHistory({ branch: 'hanoi', customerId: '1' });
    assert.deepEqual(history.days.map(d => d.penalty), [25000, 25000, 0, 25000, 25000]);
    assert.equal(history.days[2].status, 'Đã xử lý');
    assert.equal(history.days[2].statusBy, 'Quản lý A');
    const log = (await db.query(`SELECT cycle_date::text AS d, field, old_value, new_value FROM debt_feedback_history`)).rows;
    assert.deepEqual(log, [{ d: '2026-10-30', field: 'status', old_value: 'Chưa xử lý', new_value: 'Đã xử lý' }]);
  } finally { await db.close(); }
});

test('doi nguoc ve Chua xu ly: chen lai dong so phat va noi lai chuoi; sua cung gia tri khong doi gi', async () => {
  const { db, repo } = await setup();
  try {
    await repo.saveHistoricalStatus({ ...target, cycleDate: '2026-10-30', status: 'Đã xử lý' });
    const same = await repo.saveHistoricalStatus({ ...target, cycleDate: '2026-10-30', status: 'Đã xử lý' });
    assert.equal(same.changed, false);
    await repo.saveHistoricalStatus({ ...target, cycleDate: '2026-10-30', status: 'Chưa xử lý' });
    assert.deepEqual(await streaks(db), [1, 2, 3, 4, 5]);
    assert.deepEqual(await ledger(db), [['2026-10-28', 1, 25000], ['2026-10-29', 2, 25000], ['2026-10-30', 3, 50000], ['2026-10-31', 4, 100000]]);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_feedback_history')).rows[0].n, 2);
  } finally { await db.close(); }
});

test('Bo qua giu nguyen chuoi va so phat cac ngay sau', async () => {
  const { db, repo } = await setup();
  try {
    await repo.saveHistoricalStatus({ ...target, cycleDate: '2026-10-29', status: 'Bỏ qua' });
    assert.deepEqual(await streaks(db), [1, 2, 3, 4, 5]);
    assert.deepEqual((await ledger(db)).map(row => row[2]), [25000, 25000, 50000, 100000]);
  } finally { await db.close(); }
});

test('sua ngay chua chot so (ngay dang mo) chi doi chuoi trong ban chot, khong ghi so phat', async () => {
  const { db, repo } = await setup();
  try {
    const result = await repo.saveHistoricalStatus({ ...target, cycleDate: '2026-11-01', status: 'Đã xử lý' });
    assert.equal(result.recalculatedDays, 0);
    assert.equal((await ledger(db)).length, 4);
  } finally { await db.close(); }
});

test('thang da chot thuong/phat: lich su danh dau rewardFinalized, van sua duoc va tinh lai chuoi + so phat; ban thuong da chot khong doi', async () => {
  const { db, repo } = await setup();
  try {
    await db.exec(`INSERT INTO debt_reward_months (month, rule_version, result) VALUES ('2026-10-01', 'v', '{}')`);
    const history = await repo.listCustomerHistory({ branch: 'hanoi', customerId: '1' });
    assert.deepEqual(history.days.map(d => d.rewardFinalized), [true, true, true, true, false]);
    assert.ok(history.days.every(d => !('locked' in d)));
    const result = await repo.saveHistoricalStatus({ ...target, cycleDate: '2026-10-29', status: 'Đã xử lý' });
    assert.equal(result.changed, true);
    assert.equal((await db.query(`SELECT status FROM debt_cycle_feedback WHERE cycle_date = '2026-10-29'`)).rows[0].status, 'Đã xử lý');
    // 29/10 het phat (xoa dong); 30/10 phien 1, 31/10 phien 2 = 25k moi ngay.
    assert.deepEqual(await ledger(db), [['2026-10-28', 1, 25000], ['2026-10-30', 1, 25000], ['2026-10-31', 2, 25000]]);
    assert.equal((await db.query(`SELECT result::text AS r FROM debt_reward_months`)).rows[0].r, '{}');
  } finally { await db.close(); }
});

test('ngay ngoai 7 ban chot, ngay sai dinh dang, trang thai la, khach khong co o ngay do deu bi tu choi', async () => {
  const { db, repo } = await setup();
  try {
    await assert.rejects(repo.saveHistoricalStatus({ ...target, cycleDate: '2026-09-01', status: 'Đã xử lý' }), error => error.statusCode === 404);
    await assert.rejects(repo.saveHistoricalStatus({ ...target, cycleDate: 'abc', status: 'Đã xử lý' }), error => error.statusCode === 400);
    await assert.rejects(repo.saveHistoricalStatus({ ...target, cycleDate: '2026-10-30', status: 'Đang xử lý' }), error => error.statusCode === 400);
    await assert.rejects(repo.saveHistoricalStatus({ ...target, customerId: '2', cycleDate: '2026-10-30', status: 'Đã xử lý' }), error => error.statusCode === 404);
    await db.exec(`UPDATE customers SET raw = '{"isActive":false}' WHERE id = 1`);
    await assert.rejects(repo.saveHistoricalStatus({ ...target, cycleDate: '2026-10-30', status: 'Đã xử lý' }), error => error.statusCode === 404);
    assert.deepEqual(await streaks(db), [1, 2, 3, 4, 5]);
  } finally { await db.close(); }
});
