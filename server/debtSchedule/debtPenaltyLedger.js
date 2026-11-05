'use strict';

// So phat cong no theo ngay (migration 0051). Chu ky DANG MO (ban chot 15:00 moi nhat) van sua
// duoc tien phat / trang thai toi 14:59 hom sau, CHOT SO truoc reset 15:00: moi chu ky cu duoc ghi
// vao debt_penalty_daily (giu vinh vien, dong bang ten sale) roi danh dau o debt_penalty_cycles.
// Bang tong cong cac ngay da chot tu so nay, CONG THEM tien phat dang mo tinh truc tiep (debtRewardService).
//
// Tien phat tung khach tinh bang CHINH buildCustomerRow cua man hinh (so Quan ly dien tay >
// "Da xu ly" = 0 > muc goi y theo quy che) nen so chot khop so da thay tren bang khach.

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (e) { /* dotenv tuy chon */ }
}

const { getPool } = require('../db/pool');
const { buildCustomerRow } = require('./debtScheduleRules');
const { vnDateKey, vnMinutesOfDay, addDaysToKey } = require('../kiotvietSync/vnTime');
const { createDebtScheduleRepository } = require('./debtScheduleRepository');

const BRANCH_CODES = Object.freeze(['hanoi', 'saigon']);
// readReport(cycleDate) chi doc duoc 7 ban chot gan nhat (xem CYCLE_HISTORY_DAYS o repository).
const READABLE_RUNS = 7;

// Chu ky chua chot so, tru ban chot moi nhat (chu ky dang mo).
const PENDING_SQL = `
  WITH recent AS (SELECT cycle_date FROM debt_cycle_runs ORDER BY cycle_date DESC LIMIT ${READABLE_RUNS})
  SELECT r.cycle_date::text AS cycle_date
  FROM recent r
  WHERE r.cycle_date < (SELECT MAX(cycle_date) FROM debt_cycle_runs)
    AND NOT EXISTS (SELECT 1 FROM debt_penalty_cycles c WHERE c.cycle_date = r.cycle_date)
  ORDER BY r.cycle_date`;

const INSERT_SQL = `
  INSERT INTO debt_penalty_daily
    (cycle_date, branch, customer_id, sale, customer_code, customer_name, overdue_debt, overdue_streak, amount, is_manual, status)
  SELECT $1::date, t.branch, t.customer_id, t.sale, t.code, t.name, t.overdue, t.streak, t.amount, t.manual, t.status
  FROM unnest($2::text[], $3::bigint[], $4::text[], $5::text[], $6::text[], $7::numeric[], $8::int[], $9::numeric[], $10::boolean[], $11::text[])
    AS t(branch, customer_id, sale, code, name, overdue, streak, amount, manual, status)`;

/** Cac khach bi phat (> 0) cua chu ky cycleDate, tinh nhu man hinh Cong no. */
async function penalizedCustomers(repository, cycleDate) {
  const { cycle, rows, amountsByCustomer } = await repository.readReport(BRANCH_CODES, cycleDate);
  if (!cycle) return [];
  return rows
    .map(row => buildCustomerRow(row, {
      cycleDate: cycle.cycleDate,
      anchorDate: cycle.refreshedAt ? vnDateKey(cycle.refreshedAt) : undefined,
      dailyAmounts: amountsByCustomer.get(`${row.branch}:${row.customerId}`) || []
    }))
    .filter(customer => customer.penaltyAmount > 0);
}

/**
 * Chot so phat cua mot chu ky: xoa + ghi lai cac dong amount > 0 va danh dau, trong 1 transaction
 * (chay lai nhieu lan van ra cung ket qua).
 */
async function finalizePenaltyCycle(pool, cycleDate, { repository = createDebtScheduleRepository({ pool }) } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize with edits (which take FOR SHARE on the run) before reading amounts.
    await client.query('SELECT cycle_date FROM debt_cycle_runs WHERE cycle_date=$1::date FOR UPDATE',[cycleDate]);
    const sealed=await client.query('SELECT 1 FROM debt_penalty_cycles WHERE cycle_date=$1::date',[cycleDate]);
    if(sealed.rows.length) {
      const existing=await client.query('SELECT COUNT(*)::int AS customers, COALESCE(SUM(amount),0) AS amount FROM debt_penalty_daily WHERE cycle_date=$1::date',[cycleDate]);
      await client.query('COMMIT');
      return {cycleDate,customers:existing.rows[0].customers,amount:Number(existing.rows[0].amount)};
    }
    const customers = await penalizedCustomers(repository, cycleDate);
    await client.query('DELETE FROM debt_penalty_daily WHERE cycle_date = $1::date', [cycleDate]);
    if (customers.length) {
      await client.query(INSERT_SQL, [
        cycleDate,
        customers.map(c => c.branchCode),
        customers.map(c => c.customerId),
        customers.map(c => c.sale),
        customers.map(c => c.customerCode),
        customers.map(c => c.customerName),
        customers.map(c => c.overdueDebt),
        customers.map(c => c.overdueStreak),
        customers.map(c => c.penaltyAmount),
        customers.map(() => false),
        customers.map(c => c.workflowStatus)
      ]);
    }
    await client.query(
      `INSERT INTO debt_penalty_cycles (cycle_date) VALUES ($1::date)
       ON CONFLICT (cycle_date) DO UPDATE SET finalized_at = now()`,
      [cycleDate]
    );
    await client.query('COMMIT');
    return { cycleDate, customers: customers.length, amount: customers.reduce((sum, c) => sum + c.penaltyAmount, 0) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// 14:59 VN closes the cycle dated yesterday; missed runs catch up before 15:00 reset.
async function finalizePenaltyBeforeReset(pool, {now=new Date(),repository=createDebtScheduleRepository({pool}),beforeReset=false}={}) {
  const cycle=await repository.readCurrentCycle();
  if(!cycle) return null;
  const today=vnDateKey(now);
  const minute=vnMinutesOfDay(now);
  const target=minute>=900?today:addDaysToKey(today,-1);
  const advancing=beforeReset && cycle.cycleDate<target;
  if(cycle.cycleDate>=today || (!advancing && minute<899)) return null;
  const sealed=await pool.query('SELECT 1 FROM debt_penalty_cycles WHERE cycle_date=$1::date',[cycle.cycleDate]);
  if(sealed.rows.length) return null;
  return finalizePenaltyCycle(pool,cycle.cycleDate,{repository});
}

/** Chot so moi chu ky cu con thieu (khong gom chu ky dang mo). Loi 1 chu ky chi log, khong chan cac chu ky sau. */
async function finalizePendingPenaltyCycles(pool, { log = console.log, repository } = {}) {
  const { rows } = await pool.query(PENDING_SQL);
  const done = [];
  for (const row of rows) {
    try {
      const result = await finalizePenaltyCycle(pool, row.cycle_date, repository ? { repository } : {});
      log(`[debtPenaltyLedger] Chot so phat ${row.cycle_date}: ${result.customers} khach, ${result.amount}d.`);
      done.push(result);
    } catch (error) {
      log(`[debtPenaltyLedger] Loi chot so phat ${row.cycle_date}: ${error.message}`);
    }
  }
  return done;
}

// Chay tay: chot so phat cho moi chu ky cu con thieu — dung ngay sau khi migrate 0051 (backfill).
async function main() {
  const done = await finalizePendingPenaltyCycles(getPool());
  console.log(`[debtPenaltyLedger] Hoan tat: ${done.length} chu ky.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[debtPenaltyLedger] That bai: ${error.message}`);
    process.exitCode = 1;
  }).finally(() => getPool().end && getPool().end());
}

module.exports = { finalizePenaltyCycle, finalizePendingPenaltyCycles, finalizePenaltyBeforeReset, __sql__: { PENDING_SQL, INSERT_SQL } };
