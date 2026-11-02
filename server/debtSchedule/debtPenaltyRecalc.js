'use strict';

// Tinh lai SO PHAT cong no cua THANG DANG MO theo quy tac moi: "Da xu ly" = khong phat, chuoi phien lien
// tiep reset ve 0 (chu ky >= 400k ke tiep la phien 1). "Bo qua" giu nguyen (van phat, cong don).
//
//   node debtSchedule/debtPenaltyRecalc.js            (DRY-RUN: chi in bang diff theo sale, khong ghi)
//   node debtSchedule/debtPenaltyRecalc.js --apply    (ghi trong 1 transaction, co bang sao luu)
//
// Pham vi: thang cua ban chot MOI NHAT (debt_cycle_runs). KHONG dung toi debt_reward_months (thang da chot).
// 1) debt_penalty_daily cua thang: dong status 'Da xu ly' bi xoa (phat 0); streak tinh lai theo chuoi
//    ngay lien ke (khach khong co dong o chu ky lien truoc = chuoi dut); moi dong con lai duoc tinh lai
//    amount = suggestedPenalty(overdue, streak) (da bo phat tay 2026-11-02 nen so tay cu cung ve muc quy che).
//    Chu ky ngay truoc thang (gan nhat) chi doc de lay streak/trang thai dau chuoi, khong sua.
// 2) debt_cycle_customers (chi giu 7 ngay): chay lai applyOverdueStreaks theo thu tu cho cac chu ky co
//    chu ky truoc trong DB, de cot overdue_streak khop. Chu ky dau cua cua so giu nguyen.
// Gioi han: so phat chi co dong amount > 0 nen khach "so tay = 0" giua chuoi coi nhu dut chuoi.
// Chay lai nhieu lan ra cung ket qua (lan 2 khong con thay doi -> khong ghi gi, khong tao sao luu).

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (e) { /* dotenv tuy chon */ }
}

const { getPool } = require('../db/pool');
const { suggestedPenalty, RESOLVED_STATUS, customerKeyOf } = require('./debtScheduleRules');
const { applyOverdueStreaks } = require('./debtCycleSnapshot');
const { vnDateKey, addDaysToKey } = require('../kiotvietSync/vnTime');

const MONTH_RUN_SQL = `SELECT MAX(cycle_date)::text AS open_date FROM debt_cycle_runs`;

const SEALED_CYCLES_SQL = `SELECT cycle_date::text AS cycle_date FROM debt_penalty_cycles
  WHERE cycle_date >= $1::date AND cycle_date < $2::date ORDER BY cycle_date`;

const SEED_CYCLE_SQL = `SELECT MAX(cycle_date)::text AS cycle_date FROM debt_penalty_cycles WHERE cycle_date < $1::date`;

const LEDGER_ROWS_SQL = `SELECT cycle_date::text AS cycle_date, branch, customer_id::text AS customer_id, sale, customer_code,
    customer_name, overdue_debt, overdue_streak, amount, is_manual, status
  FROM debt_penalty_daily WHERE cycle_date >= $1::date AND cycle_date < $2::date ORDER BY cycle_date, branch, customer_id`;

const RUNS_SQL = `SELECT cycle_date::text AS cycle_date, refreshed_at FROM debt_cycle_runs
  WHERE cycle_date >= $1::date AND cycle_date < $2::date ORDER BY cycle_date`;

const SNAPSHOT_STREAKS_SQL = `SELECT cycle_date::text AS cycle_date, branch, customer_id::text AS customer_id, overdue_debt, overdue_streak
  FROM debt_cycle_customers WHERE cycle_date >= $1::date AND cycle_date < $2::date`;

const DELETE_SQL = `DELETE FROM debt_penalty_daily d USING unnest($1::date[], $2::text[], $3::bigint[]) AS t(cycle_date, branch, customer_id)
  WHERE d.cycle_date = t.cycle_date AND d.branch = t.branch AND d.customer_id = t.customer_id`;

const UPDATE_SQL = `UPDATE debt_penalty_daily d SET overdue_streak = t.streak, amount = t.amount
  FROM unnest($1::date[], $2::text[], $3::bigint[], $4::int[], $5::numeric[]) AS t(cycle_date, branch, customer_id, streak, amount)
  WHERE d.cycle_date = t.cycle_date AND d.branch = t.branch AND d.customer_id = t.customer_id`;

const SLOW_DEBT_THRESHOLD = 400000;

/** Chuoi phien theo quy tac moi, tu chua de khong phu thuoc nextOverdueStreak: <400k -> 0; phien truoc 'Da xu ly' -> coi 0. */
function streakAfter(overdue, previousStreak, previousStatus) {
  if (!((Number(overdue) || 0) >= SLOW_DEBT_THRESHOLD)) return 0;
  const previous = previousStatus === RESOLVED_STATUS ? 0 : Math.max(0, Math.trunc(Number(previousStreak) || 0));
  return previous + 1;
}

/** 'YYYY-MM-01' va ngay dau thang sau cua thang chua dateKey. */
function monthBounds(dateKey) {
  const start = `${dateKey.slice(0, 7)}-01`;
  let next = addDaysToKey(start, 31);
  next = `${next.slice(0, 7)}-01`;
  return { start, end: next };
}

/**
 * Ham thuan: tinh lai so phat. `rows` = dong debt_penalty_daily (ca dong "seed" cua chu ky ngay truoc
 * thang, chi doc), `cycleDates` = cac chu ky da chot theo thu tu tang (gom ca ngay seed), `seedDate` =
 * ngay seed hoac null. Tra ve cac thay doi {action: 'delete'|'update', before, after} chi cho dong trong thang.
 */
function recalcLedger({ rows, cycleDates, seedDate = null }) {
  const byDate = new Map();
  for (const row of rows) {
    if (!byDate.has(row.cycleDate)) byDate.set(row.cycleDate, new Map());
    byDate.get(row.cycleDate).set(customerKeyOf(row.branch, row.customerId), row);
  }
  // Trang thai SAU tinh lai cua dong chu ky truoc: { streak, status } (dong bi xoa -> streak 0, status Da xu ly).
  let previous = new Map();
  const changes = [];
  for (const date of cycleDates) {
    const current = new Map();
    const dayRows = byDate.get(date) || new Map();
    for (const [key, row] of dayRows) {
      const before = { amount: Number(row.amount) || 0, streak: Number(row.overdueStreak) || 0 };
      if (date === seedDate) { current.set(key, { streak: before.streak, status: row.status }); continue; }
      if (row.status === RESOLVED_STATUS) {
        current.set(key, { streak: 0, status: RESOLVED_STATUS });
        changes.push({ action: 'delete', row, before, after: { amount: 0, streak: 0 } });
        continue;
      }
      const prev = previous.get(key);
      const streak = streakAfter(Number(row.overdue) || 0, prev ? prev.streak : 0, prev ? prev.status : undefined);
      const amount = suggestedPenalty(Number(row.overdue) || 0, streak);
      current.set(key, { streak, status: row.status });
      if (streak !== before.streak || amount !== before.amount) {
        changes.push({ action: 'update', row, before, after: { amount, streak } });
      }
    }
    previous = current;
  }
  return changes;
}

function toLedgerRow(row) {
  return {
    cycleDate: row.cycle_date, branch: row.branch, customerId: row.customer_id, sale: row.sale || '', customerCode: row.customer_code,
    customerName: row.customer_name, overdue: Number(row.overdue_debt) || 0, overdueStreak: Number(row.overdue_streak) || 0,
    amount: Number(row.amount) || 0, isManual: Boolean(row.is_manual), status: row.status || ''
  };
}

/** Gop thay doi theo sale: tong phat truoc / sau, so khach bi xoa / doi. */
function summarizeBySale(changes, rows) {
  const bySale = new Map();
  const entry = (sale) => {
    const name = sale || 'Chưa phân nhóm';
    if (!bySale.has(name)) bySale.set(name, { sale: name, before: 0, after: 0, deleted: 0, changed: 0 });
    return bySale.get(name);
  };
  for (const row of rows) entry(row.sale).before += row.amount;
  for (const row of rows) entry(row.sale).after += row.amount;
  for (const change of changes) {
    const item = entry(change.row.sale);
    item.after += change.after.amount - change.before.amount;
    if (change.action === 'delete') item.deleted += 1; else item.changed += 1;
  }
  return Array.from(bySale.values())
    .filter(item => item.deleted || item.changed)
    .sort((a, b) => (a.after - a.before) - (b.after - b.before) || a.sale.localeCompare(b.sale, 'vi'));
}

function backupSuffix(now) {
  return vnDateKey(now).replace(/-/g, '');
}

async function freeTableName(client, base) {
  for (let n = 1; n < 50; n++) {
    const name = n === 1 ? base : `${base}_${n}`;
    const { rows } = await client.query('SELECT to_regclass($1) AS t', [name]);
    if (!rows[0].t) return name;
  }
  throw new Error(`Khong tim duoc ten bang sao luu trong cho: ${base}`);
}

/** Chay lai applyOverdueStreaks theo thu tu cho cac chu ky co chu ky truoc; tra ve so dong doi. */
async function recalcSnapshotStreaks(client, { start, end }) {
  const { rows: runs } = await client.query(RUNS_SQL, [start, end]);
  if (!runs.length) return { cycles: [], changed: 0 };
  const { rows: before } = await client.query(SNAPSHOT_STREAKS_SQL, [start, end]);
  const { rows: earlier } = await client.query('SELECT 1 FROM debt_cycle_runs WHERE cycle_date < $1::date LIMIT 1', [runs[0].cycle_date]);
  const cycles = [];
  runs.forEach((run, i) => {
    if (i === 0 && !earlier.length) return; // chu ky dau cua cua so, khong co chu ky truoc trong DB
    cycles.push(run);
  });
  for (const run of cycles) {
    await applyOverdueStreaks(client, run.cycle_date, run.refreshed_at ? vnDateKey(new Date(run.refreshed_at)) : undefined);
  }
  const { rows: after } = await client.query(SNAPSHOT_STREAKS_SQL, [start, end]);
  const old = new Map(before.map(r => [`${r.cycle_date}|${r.branch}|${r.customer_id}`, Number(r.overdue_streak) || 0]));
  const changed = after.filter(r => old.get(`${r.cycle_date}|${r.branch}|${r.customer_id}`) !== (Number(r.overdue_streak) || 0)).length;
  return { cycles: cycles.map(run => run.cycle_date), changed, before, after };
}

async function recalcPenaltyLedger(pool, { apply = false, now = new Date(), log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [{ open_date: openDate }] } = await client.query(MONTH_RUN_SQL);
    if (!openDate) { await client.query('ROLLBACK'); return { openDate: null, month: null, changes: [], bySale: [], applied: false }; }
    const bounds = monthBounds(openDate);
    const { rows: cycleRows } = await client.query(SEALED_CYCLES_SQL, [bounds.start, bounds.end]);
    const { rows: [{ cycle_date: seedDate }] } = await client.query(SEED_CYCLE_SQL, [bounds.start]);
    const cycleDates = [...(seedDate ? [seedDate] : []), ...cycleRows.map(row => row.cycle_date)];
    const { rows: rawRows } = await client.query(LEDGER_ROWS_SQL, [seedDate || bounds.start, bounds.end]);
    const rows = rawRows.map(toLedgerRow);
    const changes = recalcLedger({ rows, cycleDates, seedDate });
    const monthRows = rows.filter(row => row.cycleDate >= bounds.start);
    const bySale = summarizeBySale(changes, monthRows);

    let backup = null;
    let snapshotBackup = null;
    if (apply && changes.length) {
      backup = await freeTableName(client, `debt_penalty_daily_backup_${backupSuffix(now)}`);
      await client.query(`CREATE TABLE ${backup} AS SELECT * FROM debt_penalty_daily WHERE cycle_date >= $1::date AND cycle_date < $2::date`, [bounds.start, bounds.end]);
      const deletes = changes.filter(change => change.action === 'delete');
      const updates = changes.filter(change => change.action === 'update');
      if (deletes.length) {
        await client.query(DELETE_SQL, [deletes.map(c => c.row.cycleDate), deletes.map(c => c.row.branch), deletes.map(c => c.row.customerId)]);
      }
      if (updates.length) {
        await client.query(UPDATE_SQL, [updates.map(c => c.row.cycleDate), updates.map(c => c.row.branch), updates.map(c => c.row.customerId),
          updates.map(c => c.after.streak), updates.map(c => c.after.amount)]);
      }
    }

    // Cot overdue_streak cua cac ban chot con giu: dry-run van chay trong transaction roi ROLLBACK de dem thay doi.
    const snapshot = await recalcSnapshotStreaks(client, bounds);
    if (apply && snapshot.changed) {
      snapshotBackup = await freeTableName(client, `debt_cycle_customers_streak_backup_${backupSuffix(now)}`);
      await client.query(`CREATE TABLE ${snapshotBackup} (cycle_date DATE, branch TEXT, customer_id BIGINT, overdue_debt NUMERIC, overdue_streak INTEGER)`);
      await client.query(`INSERT INTO ${snapshotBackup}
        SELECT * FROM unnest($1::date[], $2::text[], $3::bigint[], $4::numeric[], $5::int[])`, [
        snapshot.before.map(r => r.cycle_date), snapshot.before.map(r => r.branch), snapshot.before.map(r => r.customer_id),
        snapshot.before.map(r => r.overdue_debt), snapshot.before.map(r => r.overdue_streak)]);
    }

    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    const result = {
      openDate, month: bounds.start.slice(0, 7), changes, bySale, applied: apply, backup, snapshotBackup,
      snapshotCycles: snapshot.cycles, snapshotChanged: snapshot.changed
    };
    log(formatReport(result));
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const money = value => Number(value).toLocaleString('en-US');

function formatReport(result) {
  if (!result.month) return '[debtPenaltyRecalc] Chua co ban chot cong no nao.';
  const lines = [`[debtPenaltyRecalc] Thang ${result.month} (chu ky mo ${result.openDate}) — ${result.applied ? 'APPLY' : 'DRY-RUN (khong ghi)'}`];
  if (!result.bySale.length) lines.push('  So phat: khong co thay doi.');
  for (const item of result.bySale) {
    lines.push(`  ${item.sale}: ${money(item.before)} -> ${money(item.after)} (${item.after - item.before >= 0 ? '+' : ''}${money(item.after - item.before)}), xoa ${item.deleted} dong, doi ${item.changed} dong`);
  }
  const totalBefore = result.bySale.reduce((sum, item) => sum + item.before, 0);
  const totalAfter = result.bySale.reduce((sum, item) => sum + item.after, 0);
  lines.push(`  Tong (cac sale co doi): ${money(totalBefore)} -> ${money(totalAfter)}`);
  lines.push(`  Ban chot con giu: ${result.snapshotChanged} dong doi overdue_streak (chu ky ${result.snapshotCycles.join(', ') || '-'}).`);
  if (result.backup) lines.push(`  Sao luu: ${result.backup}${result.snapshotBackup ? `, ${result.snapshotBackup}` : ''}`);
  if (!result.applied) lines.push('  Them --apply de ghi.');
  return lines.join('\n');
}

async function main() {
  const apply = process.argv.includes('--apply');
  await recalcPenaltyLedger(getPool(), { apply });
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[debtPenaltyRecalc] That bai: ${error.message}`);
    process.exitCode = 1;
  }).finally(() => getPool().end && getPool().end());
}

module.exports = { recalcPenaltyLedger, recalcLedger, summarizeBySale, monthBounds, formatReport };
