'use strict';

// Sua so phien / so phat da chot lech trang thai thuc (planHistoryRepair + applyPlan tren PGlite).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { planHistoryRepair, readInputs, applyPlan } = require('./debtHistoryRepair');

const MIGRATION = ['0047_debt_schedule_report.sql', '0048_debt_penalty.sql', '0050_debt_cycle_manual_refresh.sql', '0051_debt_penalty_ledger.sql', '0052_debt_reward_months.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8')).join(' ');

const DATES = ['2026-11-06', '2026-11-07', '2026-11-08', '2026-11-09'];

// Khach 1 no cham 500k ca 4 ngay; 07 va 08 da danh dau "Da xu ly" nhung so phat/phien con theo trang thai cu (dung ca loi that).
async function setupStale() {
  const db = new PGlite();
  await db.exec(`CREATE TABLE customers (branch TEXT, id BIGINT, code TEXT, name TEXT, debt NUMERIC, raw JSONB, PRIMARY KEY (branch, id));`);
  await db.exec(MIGRATION);
  await db.exec(`INSERT INTO customers VALUES ('hanoi', 1, 'KH1', 'Khách Một', 500000, '{"groups":"Lan"}')`);
  for (const [i, date] of DATES.entries()) {
    await db.exec(`INSERT INTO debt_cycle_runs (cycle_date, taken_at) VALUES ('${date}', '${date}T08:00:00Z');
      INSERT INTO debt_cycle_customers (cycle_date, branch, customer_id, current_debt, overdue_debt, overdue_streak)
        VALUES ('${date}', 'hanoi', 1, 500000, 500000, ${i + 1});`);
  }
  await db.exec(`INSERT INTO debt_cycle_feedback (cycle_date, branch, customer_id, status)
    VALUES ('2026-11-07', 'hanoi', 1, 'Đã xử lý'), ('2026-11-08', 'hanoi', 1, 'Đã xử lý')`);
  // 06..08 da chot so; 09 la ngay dang mo. Dong phat 07 va 08 con 'Chua xu ly' (stale).
  await db.exec(`INSERT INTO debt_penalty_cycles (cycle_date) VALUES ('2026-11-06'), ('2026-11-07'), ('2026-11-08');
    INSERT INTO debt_penalty_daily (cycle_date, branch, customer_id, sale, customer_code, customer_name, overdue_debt, overdue_streak, amount, status) VALUES
      ('2026-11-06', 'hanoi', 1, 'Lan', 'KH1', 'Khách Một', 500000, 1, 25000, 'Chưa xử lý'),
      ('2026-11-07', 'hanoi', 1, 'Lan', 'KH1', 'Khách Một', 500000, 2, 25000, 'Chưa xử lý'),
      ('2026-11-08', 'hanoi', 1, 'Lan', 'KH1', 'Khách Một', 500000, 3, 50000, 'Chưa xử lý')`);
  return db;
}

test('replay: Da xu ly ngay 07, 08 -> xoa dong phat 07 va 08, phien 08 = 1, phien 09 = 1', async () => {
  const db = await setupStale();
  try {
    const plan = planHistoryRepair(await readInputs(db));
    assert.deepEqual(plan.ledgerFixes.map(f => [f.cycleDate, f.action]), [['2026-11-07', 'delete'], ['2026-11-08', 'delete']]);
    assert.deepEqual(plan.streakFixes.map(f => [f.cycleDate, f.from, f.to]), [['2026-11-08', 3, 1], ['2026-11-09', 4, 1]]);

    await applyPlan(db, plan);
    const ledger = (await db.query('SELECT cycle_date::text AS d, amount::int AS a FROM debt_penalty_daily ORDER BY cycle_date')).rows;
    assert.deepEqual(ledger.map(r => [r.d, r.a]), [['2026-11-06', 25000]]);
    assert.deepEqual((await db.query('SELECT overdue_streak AS s FROM debt_cycle_customers ORDER BY cycle_date')).rows.map(r => r.s), [1, 2, 1, 1]);
    // Chay lai: khong con gi can sua.
    const again = planHistoryRepair(await readInputs(db));
    assert.deepEqual(again, { streakFixes: [], ledgerFixes: [] });
  } finally { await db.close(); }
});

test('replay: dong phat sai streak/so tien duoc cap nhat; dong bi mat khong tu chen', async () => {
  const db = await setupStale();
  try {
    // Khong co Da xu ly; xoa dong 07 (bi mat), dong 08 con streak 3 / 50k nhung chuoi dung phai la 3 -> sua streak 06 de lech.
    await db.exec(`DELETE FROM debt_cycle_feedback; DELETE FROM debt_penalty_daily WHERE cycle_date = '2026-11-07';
      UPDATE debt_cycle_customers SET overdue_streak = cycle_date - DATE '2026-11-05';
      UPDATE debt_penalty_daily SET amount = 25000 WHERE cycle_date = '2026-11-08'`);
    const plan = planHistoryRepair(await readInputs(db));
    assert.deepEqual(plan.ledgerFixes.map(f => [f.cycleDate, f.action, f.amount]), [['2026-11-08', 'update', 50000]]);
    await applyPlan(db, plan);
    const rows = (await db.query('SELECT cycle_date::text AS d, amount::int AS a FROM debt_penalty_daily ORDER BY cycle_date')).rows;
    assert.deepEqual(rows.map(r => [r.d, r.a]), [['2026-11-06', 25000], ['2026-11-08', 50000]]);
  } finally { await db.close(); }
});

test('ngay chua chot so khong bi ghi vao so phat, chi sua chuoi phien', () => {
  const plan = planHistoryRepair({
    runs: ['2026-11-07', '2026-11-08'], sealed: new Set(),
    snapshots: [
      { cycleDate: '2026-11-07', branch: 'hanoi', customerId: '1', overdue: 500000, streak: 1, status: 'Đã xử lý' },
      { cycleDate: '2026-11-08', branch: 'hanoi', customerId: '1', overdue: 500000, streak: 2, status: 'Chưa xử lý' }
    ],
    ledger: []
  });
  assert.deepEqual(plan.ledgerFixes, []);
  assert.deepEqual(plan.streakFixes.map(f => [f.cycleDate, f.from, f.to]), [['2026-11-08', 2, 1]]);
});
