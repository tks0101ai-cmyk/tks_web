'use strict';

// Sua so phien (debt_cycle_customers.overdue_streak) va so phat da chot (debt_penalty_daily) bi LECH TRANG THAI THUC
// do hai lan sua trang thai lich su cua cung khach chay song song (loi da va bang khoa advisory trong saveHistoricalStatus).
// Trang thai thuc = debt_cycle_feedback.status. Chay lai (replay) chuoi theo dung quy che cua ban chot 15:00:
//   streak ngay i = nextOverdueStreak(no qua han, streak ngay i-1, trang thai ngay i-1)   (ngay dau cua cua so giu nguyen)
//   phat ngay i   = dayPenalty(no qua han, streak, trang thai)                            (Da xu ly = 0)
//
//   node debtSchedule/debtHistoryRepair.js            (DRY-RUN: chi in cac dong se doi, khong ghi)
//   node debtSchedule/debtHistoryRepair.js --apply    (ghi trong 1 transaction, co bang sao luu debt_penalty_daily)
//
// Chi sua ngay con trong debt_cycle_customers (7-8 ban chot gan nhat). Khong dung toi debt_reward_months. Chi XOA / CAP NHAT
// dong phat DA CO, khong tu chen dong moi: so qua han luc chot co the khac so luu (vd doi lich TT sau do) nen khong kiem chung duoc.
// Chay lai nhieu lan ra cung ket qua (lan 2 khong con dong nao lech -> khong ghi gi).

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (e) { /* dotenv tuy chon */ }
}

const { nextOverdueStreak } = require('./debtScheduleRules');
const { dayPenalty } = require('./debtHistoryCascade');

/**
 * Ham thuan. `runs` = cycle_date tu cu den moi; `sealed` = Set cycle_date da chot so phat;
 * `snapshots` = [{ cycleDate, branch, customerId, overdue, streak, status }]; `ledger` = dong debt_penalty_daily
 * [{ cycleDate, branch, customerId, overdue, streak, amount, status }].
 * Tra ve { streakFixes, ledgerFixes } — ledgerFixes: { action: 'update' | 'delete', ... } (chi dong phat da ton tai).
 */
function planHistoryRepair({ runs, sealed, snapshots, ledger }) {
  const byCustomer = new Map();
  for (const row of snapshots) {
    const key = `${row.branch}:${row.customerId}`;
    if (!byCustomer.has(key)) byCustomer.set(key, new Map());
    byCustomer.get(key).set(row.cycleDate, row);
  }
  const ledgerByKey = new Map(ledger.map(row => [`${row.cycleDate}|${row.branch}:${row.customerId}`, row]));
  const streakFixes = [];
  const ledgerFixes = [];
  for (const [key, days] of byCustomer) {
    let previous = null;
    for (const cycleDate of runs) {
      const row = days.get(cycleDate);
      if (!row) { previous = null; continue; }
      const streak = previous === null ? row.streak : nextOverdueStreak(row.overdue, previous.streak, previous.status);
      if (streak !== row.streak) {
        streakFixes.push({ cycleDate, branch: row.branch, customerId: row.customerId, from: row.streak, to: streak });
      }
      if (sealed.has(cycleDate)) {
        const amount = dayPenalty(row.overdue, streak, row.status);
        const existing = ledgerByKey.get(`${cycleDate}|${key}`);
        if (existing && amount > 0) {
          const same = Number(existing.amount) === amount && existing.streak === streak
            && existing.status === row.status && Number(existing.overdue) === row.overdue;
          if (!same) ledgerFixes.push({ action: 'update', cycleDate, branch: row.branch, customerId: row.customerId, overdue: row.overdue, streak, amount, status: row.status, had: Number(existing.amount) });
        } else if (existing) {
          ledgerFixes.push({ action: 'delete', cycleDate, branch: row.branch, customerId: row.customerId, had: Number(existing.amount) });
        }
      }
      previous = { streak, status: row.status };
    }
  }
  return { streakFixes, ledgerFixes };
}

const SNAPSHOT_SQL = `SELECT dc.cycle_date::text AS cycle_date, dc.branch, dc.customer_id::text AS customer_id, dc.overdue_debt, dc.overdue_streak,
    COALESCE(f.status, 'Chưa xử lý') AS status
  FROM debt_cycle_customers dc
  LEFT JOIN debt_cycle_feedback f ON f.cycle_date = dc.cycle_date AND f.branch = dc.branch AND f.customer_id = dc.customer_id`;

async function readInputs(db) {
  const [runs, sealed, snapshots, ledger] = await Promise.all([
    db.query('SELECT cycle_date::text AS cycle_date FROM debt_cycle_runs ORDER BY cycle_date'),
    db.query('SELECT cycle_date::text AS cycle_date FROM debt_penalty_cycles'),
    db.query(SNAPSHOT_SQL),
    db.query('SELECT cycle_date::text AS cycle_date, branch, customer_id::text AS customer_id, overdue_debt, overdue_streak, amount, status FROM debt_penalty_daily')
  ]);
  return {
    runs: runs.rows.map(row => row.cycle_date),
    sealed: new Set(sealed.rows.map(row => row.cycle_date)),
    snapshots: snapshots.rows.map(row => ({
      cycleDate: row.cycle_date, branch: row.branch, customerId: row.customer_id,
      overdue: Number(row.overdue_debt) || 0, streak: Number(row.overdue_streak) || 0, status: row.status
    })),
    ledger: ledger.rows.map(row => ({
      cycleDate: row.cycle_date, branch: row.branch, customerId: row.customer_id,
      overdue: Number(row.overdue_debt) || 0, streak: Number(row.overdue_streak) || 0, amount: Number(row.amount) || 0, status: row.status
    }))
  };
}

async function applyPlan(client, plan) {
  for (const fix of plan.streakFixes) {
    await client.query(
      'UPDATE debt_cycle_customers SET overdue_streak = $4 WHERE cycle_date = $1::date AND branch = $2 AND customer_id = $3::bigint',
      [fix.cycleDate, fix.branch, fix.customerId, fix.to]
    );
  }
  for (const fix of plan.ledgerFixes) {
    if (fix.action === 'delete') {
      await client.query(
        'DELETE FROM debt_penalty_daily WHERE cycle_date = $1::date AND branch = $2 AND customer_id = $3::bigint',
        [fix.cycleDate, fix.branch, fix.customerId]
      );
      continue;
    }
    await client.query(
      `UPDATE debt_penalty_daily SET overdue_debt = $4, overdue_streak = $5, amount = $6, is_manual = false, status = $7
       WHERE cycle_date = $1::date AND branch = $2 AND customer_id = $3::bigint`,
      [fix.cycleDate, fix.branch, fix.customerId, fix.overdue, fix.streak, fix.amount, fix.status]
    );
  }
}

async function main() {
  const { getPool } = require('../db/pool');
  const apply = process.argv.includes('--apply');
  const pool = getPool();
  try {
    const plan = planHistoryRepair(await readInputs(pool));
    console.log(`Chuoi phien lech: ${plan.streakFixes.length} dong; so phat da chot lech: ${plan.ledgerFixes.length} dong.`);
    console.table(plan.streakFixes.slice(0, 100));
    console.table(plan.ledgerFixes.slice(0, 100));
    const delta = plan.ledgerFixes.reduce((sum, fix) => sum + ((fix.action === 'update' ? fix.amount : 0) - fix.had), 0);
    console.log(`Tong tien phat thay doi: ${delta}d.`);
    if (!apply) { console.log('DRY-RUN: khong ghi gi. Them --apply de ghi.'); return; }
    if (!plan.streakFixes.length && !plan.ledgerFixes.length) { console.log('Khong co gi can sua.'); return; }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const backup = `debt_penalty_daily_backup_repair_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
      await client.query(`CREATE TABLE ${backup} AS SELECT * FROM debt_penalty_daily`);
      await applyPlan(client, plan);
      await client.query('COMMIT');
      console.log(`Da ghi. Sao luu: ${backup}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exit(1); });
}

module.exports = { planHistoryRepair, readInputs, applyPlan };
