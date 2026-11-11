'use strict';

const { getPool } = require('../db/pool');
const { addMonths } = require('../businessReport/businessMonths');
const { vnDateKey, vnMinutesOfDay, addDaysToKey } = require('../kiotvietSync/vnTime');
const businessSql = require('../businessReport/businessMonthlySql');
const { createDebtScheduleRepository } = require('./debtScheduleRepository');
const { buildCustomerRow } = require('./debtScheduleRules');
const { RULE_VERSION, customerPoints, buildRewardBoard, saleOf, saleKey } = require('./debtRewardRules');

const BRANCHES = ['hanoi', 'saigon'];
function error(statusCode, message, code) { return Object.assign(new Error(message), { statusCode, code }); }
function validateMonth(month, now) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > vnDateKey(now).slice(0, 7)) {
    throw error(400, 'Tháng thưởng không hợp lệ (YYYY-MM, không vượt tháng hiện tại).', 'INVALID_REWARD_MONTH');
  }
  return month;
}

// Same branch/code canonical identity as Business Report, selecting the newest
// active record before deduplication so an inactive duplicate cannot hide it.
const DIRECTORY_SQL = `SELECT DISTINCT ON (c.branch, btrim(c.code)) c.branch, btrim(c.code) AS code, c.name,
    COALESCE(NULLIF(btrim(c.raw->>'groups'), ''), 'Chưa phân nhóm') AS sale_name
  FROM customers c
  WHERE btrim(COALESCE(c.code, '')) <> ''
    AND COALESCE(c.raw->>'isActive', c.raw->>'IsActive', 'true') <> 'false'
  ORDER BY c.branch, btrim(c.code), c.id DESC`;
// Cung 1 khach (cung ten) bi phat o ca 2 co so trong 1 ngay chi tinh muc cao nhat o 1 co so:
// cong trong tung co so truoc (hiem khi trung ten), roi lay co so cao nhat (bang nhau -> hanoi).
// Khach thieu ten khong gop nhau (khoa du phong theo co so + id). So chot goc khong doi.
const DAYS_SQL = `WITH per_branch AS (
    SELECT p.cycle_date, p.branch, p.sale,
      COALESCE(NULLIF(lower(regexp_replace(normalize(btrim(p.customer_name), NFKC), '\\s+', ' ', 'g')), ''),
        p.branch || ':' || p.customer_id) AS customer_key,
      SUM(p.amount) AS amount, COUNT(*)::int AS customers
    FROM debt_penalty_daily p
    JOIN customers c ON c.branch = p.branch AND c.id = p.customer_id
    WHERE p.cycle_date >= $1::date AND p.cycle_date < $2::date
      AND COALESCE(c.raw->>'isActive', c.raw->>'IsActive', 'true') <> 'false'
    GROUP BY p.cycle_date, p.branch, p.sale, customer_key
  ), best AS (
    SELECT DISTINCT ON (cycle_date, sale, customer_key) cycle_date, branch, sale, amount, customers
    FROM per_branch
    ORDER BY cycle_date, sale, customer_key, amount DESC, branch
  )
  SELECT cycle_date::text AS cycle_date, branch, sale, SUM(customers)::int AS customers, SUM(amount) AS amount
  FROM best GROUP BY cycle_date, branch, sale ORDER BY cycle_date`;
const CYCLES_SQL = `SELECT cycle_date::text AS cycle_date FROM debt_penalty_cycles
  WHERE cycle_date >= $1::date AND cycle_date < $2::date ORDER BY cycle_date`;
const MONTHS_SQL = `SELECT to_char(month, 'YYYY-MM') AS month FROM debt_reward_months ORDER BY month DESC`;

// Bảng thưởng/phạt đã tính (chưa lọc cơ sở) giữ ngắn hạn: nhiều người mở cùng lúc chỉ tính 1 lần (log 11/11/2026: 5–19
// request /penalty-board chạy song song, mỗi cái 5–16 s và làm event loop đứng 1–2 s).
const BOARD_CACHE_MS = 30 * 1000;

function createDebtRewardService({ pool = getPool(), repository = createDebtScheduleRepository({ pool }), now = () => new Date(),
  boardCacheMs = BOARD_CACHE_MS } = {}) {
  const scoresCache = new Map();
  // key tháng yêu cầu ('' = tháng của chu kỳ hiện tại) -> { at, version, pending, promise }.
  const boardCache = new Map();
  function clearScores() { scoresCache.clear(); boardCache.clear(); }
  // Mọi lần ghi công nợ (trạng thái, lịch TT, bản chốt mới) đều bumpVersion -> bảng đã giữ hết hiệu lực ngay.
  const versioned = typeof repository.getVersion === 'function';
  const repositoryVersion = () => (versioned ? repository.getVersion() : 0);
  let ownBumps = 0; // bumpVersion do chính loadScores (nạp lại điểm), không phải ghi công nợ.

  async function loadScores(month, { db = pool, fresh = false, frozenRequired = false } = {}) {
    const cached = scoresCache.get(month);
    if (!fresh && cached && now().getTime() - cached.at < 60000) return cached.rows;
    const start = month + '-01';
    const end = addMonths(start, 1);
    const frozen = await db.query('SELECT 1 FROM business_monthly_state WHERE month = $1::date', [start]);
    if (frozenRequired && !frozen.rows.length) throw error(503, 'Chưa chốt doanh số tháng cũ, sẽ thử lại.', 'REWARD_SALES_PENDING');
    let statistics;
    if (frozen.rows.length) {
      statistics = await db.query(`SELECT branch, customer_code, customer_name, invoice_count, net_revenue
        FROM business_monthly_customer_sales WHERE month = $1::date`, [start]);
    } else {
      // Source timestamps represent Vietnam wall time labelled UTC, as in Business Report.
      const instant = now();
      const cutoff = month === vnDateKey(instant).slice(0, 7)
        ? new Date(instant.getTime() + 7 * 3600000).toISOString().replace('Z', '') : end;
      statistics = await db.query(businessSql.CUSTOMER_MONTH_SELECT_SQL, [BRANCHES, start, cutoff]);
    }
    const directory = await db.query(DIRECTORY_SQL);
    const stats = new Map(statistics.rows.map(row => [`${row.branch}:${row.customer_code}`, row]));
    const records = directory.rows.map(row => {
      const key = `${row.branch}:${row.code}`;
      const amounts = stats.get(key) || {};
      stats.delete(key);
      return { ...row, ...amounts, code: row.code, name: row.name || amounts.customer_name || row.code };
    });
    // Only current active customer identities belong to debt rewards. Unmatched
    // sales can belong to an inactive/deleted customer and must not re-enter as unassigned.
    const sales = new Map();
    for (const record of records) {
      const sale = saleOf(record.sale_name);
      const key = saleKey(sale);
      if (!sales.has(key)) sales.set(key, { sale, points: 0, branches: [], scoreCustomers: [] });
      const row = sales.get(key);
      const invoiceCount = Number(record.invoice_count) || 0;
      const netRevenue = Number(record.net_revenue) || 0;
      const points = customerPoints(invoiceCount, netRevenue);
      row.points += points.points;
      row.branches = [...new Set([...row.branches, record.branch])];
      row.scoreCustomers.push({ branch: record.branch, code: record.code, name: record.name, invoiceCount, netRevenue, ...points });
    }
    const rows = [...sales.values()];
    if (db === pool && !fresh) {
      // Customer groups are live. Refresh the debt row cache at the same boundary so
      // points and this cycle's penalties cannot be attributed to different sales.
      repository.bumpVersion();
      ownBumps += 1;
      scoresCache.set(month, { at: now().getTime(), rows });
    }
    return rows;
  }

  async function buildMonth(month, { db = pool, cycle = null, closing = false } = {}) {
    const start = month + '-01';
    const end = addMonths(start, 1);
    const [sales, penaltiesResult, cycleDays] = await Promise.all([
      loadScores(month, { db, fresh: closing, frozenRequired: closing }),
      db.query(DAYS_SQL, [start, end]), db.query(CYCLES_SQL, [start, end])
    ]);
    // Cached points are immutable input; debt metrics must never mutate cached entries.
    const entries = sales.map(row => ({ ...row, branches: [...row.branches], scoreCustomers: [...row.scoreCustomers] }));
    const penalties = penaltiesResult.rows.map(row => ({ sale: row.sale, branch: row.branch,
      cycleDate: row.cycle_date, amount: Number(row.amount), customers: row.customers, live: false }));
    const open = !closing && cycle && cycle.cycleDate.slice(0, 7) === month;
    const known = new Set(cycleDays.rows.map(row => row.cycle_date));
    const lastDate = [...known].sort().at(-1) || null;
    let report = null;
    let liveDate = null;
    if (open) {
      report = await repository.readReport(BRANCHES);
      if (!report.cycle || report.cycle.cycleDate !== cycle.cycleDate) throw error(409, 'Chu kỳ công nợ vừa thay đổi, vui lòng tải lại.', 'DEBT_CYCLE_CHANGED');
    } else if (closing && lastDate) {
      try { report = await repository.readReport(BRANCHES, lastDate); }
      catch (e) { if (e.statusCode !== 404) throw e; }
    }
    if (report && report.cycle) {
      // Debt metrics and the open cycle's penalties are live; sealed days come from the ledger.
      // Same customer name in both branches counts once (highest amount, tie -> hanoi), as in DAYS_SQL.
      const liveBest = new Map();
      for (const source of report.rows) {
        const customer = buildCustomerRow(source, { cycleDate: report.cycle.cycleDate,
          anchorDate: report.cycle.refreshedAt ? vnDateKey(report.cycle.refreshedAt) : undefined,
          dailyAmounts: report.amountsByCustomer.get(`${source.branch}:${source.customerId}`) || [] });
        if (open && !known.has(report.cycle.cycleDate) && customer.penaltyAmount > 0) {
          const name = String(customer.customerName || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
          const key = `${saleKey(customer.sale)}|${name || customer.branchCode + ':' + customer.customerId}`;
          const best = liveBest.get(key);
          if (!best || customer.penaltyAmount > best.amount || (customer.penaltyAmount === best.amount && customer.branchCode === 'hanoi' && best.branch !== 'hanoi')) {
            liveBest.set(key, { sale: customer.sale, branch: customer.branchCode, amount: customer.penaltyAmount });
          }
        }
        let entry = entries.find(row => saleKey(row.sale) === saleKey(customer.sale));
        if (!entry) { entry = { sale: saleOf(customer.sale), points: 0, branches: [], scoreCustomers: [] }; entries.push(entry); }
        entry.branches = [...new Set([...entry.branches, customer.branchCode])];
        entry.customerCount = (entry.customerCount || 0) + 1;
        entry.totalCurrentDebt = (entry.totalCurrentDebt || 0) + customer.currentDebt;
        entry.totalOverdue = (entry.totalOverdue || 0) + customer.overdueDebt;
        entry.totalAverage = (entry.totalAverage || 0) + Math.max(0, customer.averageSales || 0);
        entry.actionCount = (entry.actionCount || 0) + Number(customer.needsAction);
      }
      const liveDays = new Map();
      for (const item of liveBest.values()) {
        const key = `${saleKey(item.sale)}|${item.branch}`;
        const day = liveDays.get(key) || { sale: item.sale, branch: item.branch, cycleDate: report.cycle.cycleDate, amount: 0, customers: 0, live: true };
        day.amount += item.amount;
        day.customers += 1;
        liveDays.set(key, day);
      }
      penalties.push(...liveDays.values());
      if (liveDays.size) liveDate = report.cycle.cycleDate;
    }
    const to = open ? (known.has(cycle.cycleDate) ? cycle.cycleDate : addDaysToKey(cycle.cycleDate,-1)) : addDaysToKey(end, -1);
    const missingDays = [];
    for (let day = start; day <= to; day = addDaysToKey(day, 1)) if (!known.has(day)) missingDays.push(day);
    const from = [...known].sort()[0] || null;
    const board = buildRewardBoard({ sales: entries, penalties, lastDate: liveDate || lastDate });
    for (const row of board.rows) {
      row.debtMetricsAvailable = Boolean(report && report.cycle);
      if (!row.debtMetricsAvailable) {
        row.customerCount = row.scoreCustomers.length;
        row.totalCurrentDebt = row.totalOverdue = row.overdueRatio = row.actionCount = null;
      }
    }
    return { month, openCycleDate: open ? cycle.cycleDate : null, lastPenaltyDate: liveDate || lastDate, status: 'provisional', closedAt: null, ruleVersion: RULE_VERSION,
      ...board, coverage: { from, to, missingDays, complete: missingDays.length === 0 },
      days: penalties.filter(day => !day.live).map(day => ({ cycleDate: day.cycleDate, sale: day.sale,
        penalizedCustomers: day.customers, amount: day.amount, branch: day.branch })) };
  }

  // Bảng đầy đủ HN + SG (xếp hạng toàn cục) của tháng yêu cầu; readBoard lọc cơ sở và gắn team (team đổi là thấy ngay).
  async function computeBoard(month) {
    const [cycle, savedMonths] = await Promise.all([
      repository.readCurrentCycle(),
      pool.query(MONTHS_SQL).then(result => result.rows.map(row => row.month))
    ]);
    const selected = month || (cycle && cycle.cycleDate.slice(0, 7));
    const months = [...new Set([...(cycle ? [cycle.cycleDate.slice(0, 7)] : []), ...savedMonths])].sort().reverse();
    if (!selected) return { month: null, openCycleDate: null, days: [], rows: [], summary: null,
      status: 'provisional', coverage: { from: null, to: null, missingDays: [], complete: false }, months, ruleVersion: RULE_VERSION, closedAt: null };
    const saved = await pool.query('SELECT result, finalized_at FROM debt_reward_months WHERE month = $1::date', [selected + '-01']);
    let board;
    if (saved.rows.length) board = { ...saved.rows[0].result, status: 'finalized', closedAt: new Date(saved.rows[0].finalized_at).toISOString() };
    else {
      if (!cycle || cycle.cycleDate.slice(0, 7) !== selected) throw error(404, 'Chưa có kết quả thưởng đã chốt của tháng này.', 'REWARD_MONTH_NOT_FOUND');
      board = await buildMonth(selected, { cycle });
    }
    return { ...board, months };
  }

  // Dùng chung 1 lần tính cho các request trùng (kể cả đang tính dở); giữ boardCacheMs nếu version công nợ không đổi.
  // Lỗi không được giữ: request sau tính lại.
  function sharedBoard(month) {
    const key = month || '';
    const hit = boardCache.get(key);
    if (hit && (hit.pending || (now().getTime() - hit.at < boardCacheMs && hit.version === repositoryVersion()))) return hit.promise;
    // Version lấy TRƯỚC khi tính, cộng các lần bump do chính loadScores trong lúc tính: ghi công nợ xen giữa thì
    // version lệch -> bảng này không được giữ. Request tới khi đang tính luôn dùng chung lần tính đó.
    const startVersion = repositoryVersion(), startOwn = ownBumps;
    const entry = { at: 0, version: startVersion, pending: true, promise: null };
    entry.promise = computeBoard(month).then(value => {
      Object.assign(entry, { pending: false, at: now().getTime(), version: versioned ? startVersion + ownBumps - startOwn : 0 });
      return value;
    }, failure => {
      if (boardCache.get(key) === entry) boardCache.delete(key);
      throw failure;
    });
    boardCache.set(key, entry);
    return entry.promise;
  }

  async function readBoard({ month, branches = BRANCHES } = {}) {
    if (month !== undefined) validateMonth(month, now());
    const board = await sharedBoard(month);
    // Bảng dùng chung CHỈ ĐỌC: lọc cơ sở tạo mảng mới, attachSaleTeams tạo dòng mới, không sửa dòng gốc.
    return { ...board, rows: await require('./saleTeams').attachSaleTeams(board.rows.filter(row => row.branches.some(branch => branches.includes(branch))), pool),
      days: board.days.filter(day => !day.branch || branches.includes(day.branch)) };
  }

  async function finalizeMonthOnce(month) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      // A transaction-level advisory lock prevents two server instances closing one month.
      await client.query('SELECT pg_advisory_xact_lock(5262, $1::int)', [Number(month.replace('-', ''))]);
      const saved = await client.query('SELECT 1 FROM debt_reward_months WHERE month = $1::date', [month + '-01']);
      if (saved.rows.length) { await client.query('COMMIT'); return false; }
      const pending = await client.query(`SELECT 1 FROM debt_cycle_runs r WHERE r.cycle_date >= $1::date AND r.cycle_date < $2::date
        AND NOT EXISTS (SELECT 1 FROM debt_penalty_cycles c WHERE c.cycle_date = r.cycle_date) LIMIT 1`, [month + '-01', addMonths(month + '-01', 1)]);
      if (pending.rows.length) throw error(503, 'Chưa chốt hết sổ phạt tháng cũ, sẽ thử lại.', 'REWARD_PENALTY_PENDING');
      const board = await buildMonth(month, { db: client, closing: true });
      const result = await client.query(`INSERT INTO debt_reward_months(month, rule_version, finalized_at, result)
        VALUES ($1::date, $2, $3::timestamptz, $4::jsonb) ON CONFLICT (month) DO NOTHING RETURNING month`,
      [month + '-01', RULE_VERSION, now().toISOString(), JSON.stringify(board)]);
      await client.query('COMMIT');
      return result.rows.length > 0;
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  }

  async function finalizeMonth(month) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await finalizeMonthOnce(month); }
      catch (e) { if (e.code !== '40001' || attempt === 2) throw e; }
    }
  }

  async function finalizePendingMonths({ onClosed } = {}) {
    const cycle = await repository.readCurrentCycle();
    const instant = now();
    const today = vnDateKey(instant);
    if (!cycle || cycle.cycleDate > today || (cycle.cycleDate === today && vnMinutesOfDay(instant) < 900)) return [];
    const currentMonth = cycle.cycleDate.slice(0, 7);
    const candidates = await pool.query(`SELECT DISTINCT to_char(cycle_date, 'YYYY-MM') AS month
      FROM (SELECT cycle_date FROM debt_penalty_cycles UNION SELECT cycle_date FROM debt_cycle_runs) d
      WHERE cycle_date < $1::date AND NOT EXISTS
        (SELECT 1 FROM debt_reward_months m WHERE m.month = date_trunc('month', d.cycle_date)::date) ORDER BY month`, [currentMonth + '-01']);
    const done = [];
    const failures = [];
    for (const row of candidates.rows) {
      try {
        if (await finalizeMonth(row.month)) {
          boardCache.clear(); // Tháng vừa chốt: bảng tạm tính đang giữ không còn đúng.
          done.push(row.month);
          if (onClosed) onClosed(row.month);
        }
      } catch (e) { failures.push(e); }
    }
    if (failures.length) throw failures[0];
    return done;
  }
  return { readBoard, finalizePendingMonths, clearScores };
}

let singleton;
function getDebtRewardService() {
  if (!singleton) singleton = createDebtRewardService({ repository: require('./debtScheduleRepository').getDebtScheduleRepository() });
  return singleton;
}
module.exports = { createDebtRewardService, getDebtRewardService, validateMonth };
