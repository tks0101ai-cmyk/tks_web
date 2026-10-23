'use strict';

// Nguon du lieu Bao cao kinh doanh. Thang DA CHOT (co dong business_monthly_state) doc
// tu bang 0036; thang CHUA chot (thang hien tai, hoac thang vua qua khi job chua kip chot /
// chua backfill) tinh truc tiep bang CUNG cau SQL cua job. Ket qua cache ttlMs (mac dinh
// 60s) theo kieu STALE-WHILE-REVALIDATE (nhu kiotOrdersRepository): het ttl thi tra NGAY ban
// cu va lam moi o nen (single-flight, loi thi giu ban cu + ghi log); chi lan tai dau tien (chua
// co ban nao) moi phai cho vi tinh live 1 thang mat ~1-2s. Cac thang live duoc tai TUAN TU
// (tranh don IO len Supabase). refreeze() xoa cache; tai nen bat dau truoc do khong duoc ghi de.
// Luon gop HN + SG.
//
// THANG HIEN TAI (migration 0068): job nen businessCurrentMonthRefresh.js tinh san cung cau SQL vao
// business_current_month_*; khi state.month = thang hien tai va computed_at chua qua currentMonthMaxAgeMs
// (mac dinh 30 phut) thi live() / linesFor doc bang do thay vi chay SQL nang. Thieu bang / qua han / loi
// => lui ve live() nhu cu (fail-soft). Job bao thay doi qua onBusinessCurrentMonthChanged => xoa cache.

const { getPool } = require('../db/pool');
const sql = require('./businessMonthlySql');
const { customerLevelFromEmail } = require('../invoicePriceAudit/priceAuditRules');
const { FIRST_MONTH, UNGROUPED_SALE, NO_TEAM, PRICE_LEVEL_LABELS, nameKey, monthKey, addMonths, monthsBetween, vnToday, dayOfMonth, parseClosedMonth } = require('./businessMonths');
const { freezeMonth, rebuildSaleTable } = require('../kiotvietSync/businessMonthlyRefresh');
const { onBusinessCurrentMonthChanged } = require('../kiotvietSync/businessCurrentMonthRefresh');

const num = v => Number(v) || 0;
const MONTHLY_TABLES = new Set(['business_monthly_state', 'business_monthly_customer_sales',
  'business_monthly_product_sales', 'business_monthly_sale_sales', 'business_monthly_customer_product_sales', 'sale_teams',
  'business_current_month_state', 'business_current_month_customer_sales', 'business_current_month_customer_product_sales']);
// Qua nguong nay ke tu lan tinh gan nhat thi bang thang hien tai bi coi la cu => tinh live.
const CURRENT_MONTH_MAX_AGE_MS = 30 * 60 * 1000;
function missingMonthlyRelation(error) {
  if (error.code !== '42P01') return false;
  const relation = /relation "(?:[^".]+\.)?([^".]+)" does not exist/.exec(error.message || '');
  return !!relation && MONTHLY_TABLES.has(relation[1]);
}

// Doc cung snapshot cho state/bang chot va cap truy van live; khong giu khoa nguon.
async function readSnapshotQueries(pool, queries) {
  const client = await pool.connect();
  let failure;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const results = [];
    for (const [text, params] of queries) {
      await client.query('SAVEPOINT business_report_read');
      try {
        results.push({ status: 'fulfilled', value: await client.query(text, params) });
        await client.query('RELEASE SAVEPOINT business_report_read');
      } catch (error) {
        if (!missingMonthlyRelation(error)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT business_report_read');
        await client.query('RELEASE SAVEPOINT business_report_read');
        results.push({ status: 'rejected', reason: error });
      }
    }
    return results;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    let rollbackError;
    try { await client.query('ROLLBACK'); } catch (error) {
      rollbackError = error;
      if (!failure) throw error;
    } finally { client.release(rollbackError); }
  }
}

// Cache 1 gia tri bat dong bo theo kieu stale-while-revalidate.
//   get()            : con han -> ban cu; het han -> tra ngay ban cu + lam moi nen; chua co -> cho tai.
//   get({ wait:true }): nhu get() nhung het han thi CHO ban moi (dung khi chinh no la tai nen cua cache khac,
//                      de ban moi that su moi chu khong mang them ban cu).
//   clear()          : bo ban + tai dang do; tai bat dau truoc clear() khong duoc ghi vao cache nua.
function createSwrCache({ load, now, ttlMs, label }) {
  let entry = null;    // { at, value }
  let inflight = null; // Promise dang tai (dung chung, tranh dam dong)
  let generation = 0;

  function reload() {
    if (inflight) return inflight;
    const myGeneration = generation;
    const promise = Promise.resolve().then(load).then(value => {
      if (myGeneration === generation) entry = { at: now().getTime(), value };
      return value;
    });
    const tracked = promise.finally(() => { if (inflight === tracked) inflight = null; });
    inflight = tracked;
    return tracked;
  }

  function get({ wait = false } = {}) {
    if (entry && now().getTime() - entry.at < ttlMs) return Promise.resolve(entry.value);
    if (!entry || wait) return reload();
    reload().catch(error => console.error(`[business-report] lam moi nen ${label} that bai, giu ban cu:`, error));
    return Promise.resolve(entry.value);
  }

  function clear() {
    generation += 1;
    entry = null;
    inflight = null;
  }

  return { get, clear };
}

function createRepository({
  pool = getPool(), now = () => new Date(), ttlMs = 60 * 1000, legacyLevels = false,
  freeze = freezeMonth, rebuildSale = rebuildSaleTable,
  currentMonthMaxAgeMs = CURRENT_MONTH_MAX_AGE_MS, onCurrentMonthChanged = onBusinessCurrentMonthChanged
} = {}) {
  const liveCaches = new Map(); // month -> cache SWR cua {customers, customerProducts}

  // Bang thang hien tai con dung duoc khong: state.month = month va computed_at chua qua han.
  // Thieu bang (42P01) / bat ky loi doc nao => false (lui ve live), khong lam hong bao cao.
  function isCurrentMonthFresh(state, month) {
    if (!state || state.month !== month || !state.computed_at) return false;
    const age = now().getTime() - new Date(state.computed_at).getTime();
    return Number.isFinite(age) && age <= currentMonthMaxAgeMs;
  }

  const CURRENT_STATE_SQL = `SELECT to_char(month, 'YYYY-MM-DD') AS month, computed_at FROM business_current_month_state WHERE id = 1`;
  async function readCurrentMonthState(month) {
    try {
      const { rows } = await pool.query(CURRENT_STATE_SQL);
      return isCurrentMonthFresh(rows[0], month);
    } catch (error) {
      if (!missingMonthlyRelation(error)) console.error('[business-report] doc state thang hien tai that bai, tinh live:', error.message);
      return false;
    }
  }

  // Doc {customers, customerProducts} cua thang hien tai tu bang tinh san, cung dang voi live().
  // null = khong dung duoc (thieu bang / qua han / lech thang / loi) => goi live().
  async function readCurrentMonthTables(month) {
    // Hai truy van du lieu chi tra dong khi state con tuoi, tranh keo du lieu cu qua mang.
    const fresh = `EXISTS (SELECT 1 FROM business_current_month_state s WHERE s.id = 1 AND s.month = $1::date
      AND s.computed_at >= $2::timestamptz)`;
    const threshold = new Date(now().getTime() - currentMonthMaxAgeMs).toISOString();
    let results;
    try {
      results = await readSnapshotQueries(pool, [
        [CURRENT_STATE_SQL],
        [`SELECT branch, customer_code, customer_name, invoice_amount, return_amount, net_revenue, invoice_count, return_count
            FROM business_current_month_customer_sales WHERE month = $1::date AND ${fresh}
            ORDER BY branch, customer_code`, [month, threshold]],
        [`SELECT branch, customer_code, product_code, product_name, net_revenue, net_qty
            FROM business_current_month_customer_product_sales WHERE month = $1::date AND ${fresh}
            ORDER BY branch, customer_code, product_code`, [month, threshold]]
      ]);
    } catch (error) {
      console.error('[business-report] doc bang thang hien tai that bai, tinh live:', error.message);
      return null;
    }
    if (results.some(r => r.status === 'rejected')) return null;
    const [state, customers, customerProducts] = results.map(r => r.value);
    if (!isCurrentMonthFresh(state.rows[0], month)) return null;
    return { customers: customers.rows, customerProducts: customerProducts.rows };
  }

  function live(month, options) {
    let cache = liveCaches.get(month);
    if (!cache) {
      cache = createSwrCache({
        now, ttlMs, label: `thang ${month}`,
        load: async () => {
          const instant = now();
          if (month === monthKey(vnToday(instant))) {
            const precomputed = await readCurrentMonthTables(month);
            if (precomputed) return precomputed;
          }
          // Cot thoi gian luu gio VN nhung gan nhan UTC.
          const cutoff = month === monthKey(vnToday(instant))
            ? new Date(instant.getTime() + 7 * 60 * 60 * 1000).toISOString().replace('Z', '')
            : addMonths(month, 1);
          const params = [sql.BRANCH_CODES, month, cutoff];
          return readSnapshotQueries(pool, [
            [sql.CUSTOMER_MONTH_SELECT_SQL, params],
            [sql.CUSTOMER_PRODUCT_MONTH_SELECT_SQL, params]
          ]).then(results => {
            const failed = results.find(r => r.status === 'rejected');
            if (failed) throw failed.reason;
            const [c, cp] = results.map(r => r.value);
            return { customers: c.rows, customerProducts: cp.rows };
          });
        }
      });
      liveCaches.set(month, cache);
    }
    return cache.get(options);
  }

  async function load() {
    const today = vnToday(now());
    const currentMonth = monthKey(today);
    const months = monthsBetween(FIRST_MONTH, currentMonth);
    // Cho tat ca truy van xong de loi khac khong bi che boi migration chua co.
    const results = await readSnapshotQueries(pool, [
      [`SELECT to_char(month, 'YYYY-MM-DD') AS month, group_hash FROM business_monthly_state`],
      [`SELECT to_char(month, 'YYYY-MM-DD') AS month, branch, customer_code, customer_name, net_revenue
                  FROM business_monthly_customer_sales WHERE month >= $1::date`, [FIRST_MONTH]],
      [`SELECT to_char(month, 'YYYY-MM-DD') AS month, product_code, product_name, net_revenue, net_qty
                  FROM business_monthly_product_sales WHERE month >= $1::date`, [FIRST_MONTH]],
      [`SELECT to_char(month, 'YYYY-MM-DD') AS month, sale_name, net_revenue
                  FROM business_monthly_sale_sales WHERE month >= $1::date`, [FIRST_MONTH]],
      ['SELECT 1 FROM business_monthly_customer_product_sales LIMIT 0'],
      [`SELECT DISTINCT ON (branch, btrim(code)) branch, btrim(code) AS code, name,
                         COALESCE(NULLIF(btrim(raw->>'groups'), ''), $1) AS sale_name,
                         ${legacyLevels ? "COALESCE(btrim(COALESCE(raw->>'email', raw->>'Email')), '')" : "''::text"} AS email,
                         COALESCE(raw->>'isActive', raw->>'IsActive', 'true') <> 'false' AS is_active
                  FROM customers WHERE btrim(COALESCE(code, '')) <> ''
                  ORDER BY branch, btrim(code), id DESC`, [UNGROUPED_SALE]],
      ['SELECT sale_name, team_name FROM sale_teams'],
      // Ma hang ngung kinh doanh o MOI co so co san pham do: khong dua vao bang xep hang ma hang.
      [`SELECT lower(btrim(code)) AS code FROM products WHERE btrim(COALESCE(code, '')) <> ''
                  GROUP BY lower(btrim(code)) HAVING bool_and(is_active IS FALSE)`]
    ]);
    let missingMigration = false;
    const values = results.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      if (index < 5 && missingMonthlyRelation(result.reason)) {
        missingMigration = true;
        return { rows: [] };
      }
      // sale_teams chua migrate: moi sale thuoc 'Chua co team', bao cao van chay.
      if (index === 6 && missingMonthlyRelation(result.reason)) return { rows: [] };
      // Truy van ma hang ngung kinh doanh chi la bo loc: loi thi bo qua, bao cao van chay.
      if (index === 7) return { rows: [] };
      throw result.reason;
    });
    const [state, frozenCustomers, frozenProducts, frozenSales, , directory, teams, inactiveProducts] = values;
    // Chi tinh khach/ma hang dang hoat dong; khach khong co trong danh ba van giu (khach le, du lieu cu).
    const inactiveCustomerKeys = new Set(directory.rows.filter(r => r.is_active === false)
      .map(r => JSON.stringify([r.branch, r.code])));
    directory.rows = directory.rows.filter(r => r.is_active !== false);
    const inactiveProductCodes = new Set(inactiveProducts.rows.map(r => r.code));
    // Schema chua du: bo state de khong tron lich su chot thieu bang.
    if (missingMigration) state.rows = [];
    const frozenMonths = state.rows.map(r => r.month).filter(m => m < currentMonth).sort();
    const pending = new Set(state.rows.filter(r => !/^[a-f0-9]{32}$/.test(r.group_hash || '')).map(r => r.month));
    const frozen = new Set(frozenMonths);
    const customers = frozenCustomers.rows.filter(r => frozen.has(r.month)
      && !inactiveCustomerKeys.has(JSON.stringify([r.branch, String(r.customer_code || '').trim()]))).map(r => ({
      month: r.month, branch: r.branch, customerCode: r.customer_code, customerName: r.customer_name, netRevenue: num(r.net_revenue)
    }));
    const products = frozenProducts.rows.filter(r => frozen.has(r.month)
      && !inactiveProductCodes.has(String(r.product_code || '').trim().toLowerCase())).map(r => ({
      month: r.month, productCode: r.product_code, productName: r.product_name, netRevenue: num(r.net_revenue), netQty: num(r.net_qty)
    }));
    for (const month of months.filter(m => !frozen.has(m))) {
      // Tai nen cua snapshot: cho ban live MOI (wait) de snapshot moi khong mang ban live cu.
      const data = await live(month, { wait: true });
      for (const r of data.customers.filter(row => !inactiveCustomerKeys.has(JSON.stringify([row.branch, String(row.customer_code || '').trim()])))) customers.push({ month, branch: r.branch, customerCode: r.customer_code, customerName: r.customer_name, netRevenue: num(r.net_revenue) });
      const byCode = new Map();
      for (const r of data.customerProducts) {
        if (inactiveProductCodes.has(String(r.product_code || '').trim().toLowerCase())) continue;
        const p = byCode.get(r.product_code) || { month, productCode: r.product_code, productName: r.product_name, netRevenue: 0, netQty: 0 };
        p.netRevenue += num(r.net_revenue); p.netQty += num(r.net_qty);
        if (r.product_name) p.productName = r.product_name;
        byCode.set(r.product_code, p);
      }
      products.push(...byCode.values());
    }
    const sales = frozenSales.rows.filter(r => frozen.has(r.month) && !pending.has(r.month)).map(r => ({ month: r.month, saleName: r.sale_name, netRevenue: num(r.net_revenue) }));
    // State cu chua du hash: giu doanh so khach da chot, gom nhom hien tai.
    const directoryGroups = new Map(directory.rows.map(r => [JSON.stringify([r.branch, r.code]), r.sale_name]));
    const fallback = new Map();
    for (const row of customers.filter(r => pending.has(r.month))) {
      const saleName = directoryGroups.get(JSON.stringify([row.branch, row.customerCode])) || UNGROUPED_SALE;
      const key = JSON.stringify([row.month, saleName]);
      const total = fallback.get(key) || { month: row.month, saleName, netRevenue: 0 };
      total.netRevenue += row.netRevenue;
      fallback.set(key, total);
    }
    sales.push(...fallback.values());
    return {
      today, currentMonth, day: dayOfMonth(today), months, frozenMonths,
      notReady: missingMigration || months.some(m => m < currentMonth && (!frozen.has(m) || pending.has(m))),
      customers, products,
      sales,
      teams: teams.rows.map(r => ({ saleName: r.sale_name, teamName: r.team_name })),
      directory: directory.rows.map(r => ({ branch: r.branch, code: r.code, name: r.name || '', saleName: r.sale_name,
        priceLevel: legacyLevels ? PRICE_LEVEL_LABELS[customerLevelFromEmail(r.email)] : PRICE_LEVEL_LABELS.large })),
      computedAt: now().toISOString()
    };
  }

  const snapshotCache = createSwrCache({ load, now, ttlMs, label: 'snapshot' });
  const snapshot = () => snapshotCache.get();

  // Job vua doi bang thang hien tai: bo cache snapshot + live cua thang hien tai (cac thang cu giu nguyen
  // de khong phai tinh lai SQL nang).
  onCurrentMonthChanged(() => {
    snapshotCache.clear();
    const month = monthKey(vnToday(now()));
    const cache = liveCaches.get(month);
    if (cache) cache.clear();
    liveCaches.delete(month);
  });

  async function linesFor(months, where, params, mapKey) {
    const snap = await snapshot();
    const frozen = new Set(snap.frozenMonths);
    const totals = new Map();
    const add = (row) => {
      const key = mapKey(row);
      const t = totals.get(key) || { ...row, revenue: 0, qty: 0 };
      t.revenue += num(row.net_revenue); t.qty += num(row.net_qty);
      totals.set(key, t);
    };
    const frozenList = months.filter(m => frozen.has(m));
    if (frozenList.length) {
      const { rows } = await pool.query(`SELECT branch, customer_code, product_code, product_name, net_revenue, net_qty
        FROM business_monthly_customer_product_sales
        WHERE month = ANY($1::date[]) AND ${where}`, [frozenList, ...params]);
      rows.forEach(add);
    }
    for (const m of months.filter(x => !frozen.has(x) && x >= FIRST_MONTH && x <= snap.currentMonth)) {
      // Thang hien tai: truy van thang vao bang khach x ma da tinh san (co index), khong tai ca thang len RAM.
      if (m === snap.currentMonth && await readCurrentMonthState(m)) {
        try {
          const { rows } = await pool.query(`SELECT branch, customer_code, product_code, product_name, net_revenue, net_qty
            FROM business_current_month_customer_product_sales
            WHERE month = $1::date AND ${where}`, [m, ...params]);
          rows.forEach(add);
          continue;
        } catch (error) {
          if (!missingMonthlyRelation(error)) console.error('[business-report] doc chi tiet thang hien tai that bai, tinh live:', error.message);
        }
      }
      const data = await live(m);
      data.customerProducts.filter(r => matches(r, where, params)).forEach(add);
    }
    return [...totals.values()].sort((a, b) => b.revenue - a.revenue);
  }

  // Loc dong live tuong ung voi menh de WHERE cua bang chot (2 dang duy nhat ben duoi).
  function matches(r, where, params) {
    if (where.startsWith('branch')) return r.branch === params[0] && r.customer_code === params[1];
    return r.product_code === params[0];
  }

  async function customerProducts({ branch, customerCode, months }) {
    const rows = await linesFor(months, 'branch = $2 AND customer_code = $3', [branch, customerCode], r => r.product_code);
    return rows.map(r => ({ productCode: r.product_code, productName: r.product_name, revenue: r.revenue, qty: r.qty }));
  }

  async function productCustomers({ productCode, months }) {
    const rows = await linesFor(months, 'product_code = $2', [productCode], r => `${r.branch}:${r.customer_code}`);
    return rows.map(r => ({ branch: r.branch, customerCode: r.customer_code, revenue: r.revenue, qty: r.qty }));
  }

  async function refreeze(monthParam) {
    const month = parseClosedMonth(monthParam, now());
    const result = await freeze(pool, month, { log: console.log });
    await rebuildSale(pool);
    snapshotCache.clear();
    for (const cache of liveCaches.values()) cache.clear();
    liveCaches.clear();
    return result;
  }

  // Gan sale vao team (teamName rong = bo khoi team -> 'Chua co team'). Ten sale / team khop khong phan
  // biet hoa/thuong; giu cach viet da co trong sale_teams de khong sinh 2 team trung ten.
  async function setSaleTeam(saleName, teamName) {
    const client = await pool.connect();
    let team = String(teamName == null ? '' : teamName).trim();
    let sale = String(saleName).trim();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('SELECT sale_name, team_name FROM sale_teams');
      const saleKey = nameKey(sale);
      const teamKey = nameKey(team);
      const existing = rows.filter(r => nameKey(r.sale_name) === saleKey);
      if (existing.length) sale = existing[0].sale_name;
      const sameTeam = rows.find(r => nameKey(r.team_name) === teamKey);
      if (sameTeam) team = sameTeam.team_name;
      if (existing.length) await client.query('DELETE FROM sale_teams WHERE sale_name = ANY($1::text[])', [existing.map(r => r.sale_name)]);
      if (teamKey && teamKey !== nameKey(NO_TEAM)) {
        await client.query('INSERT INTO sale_teams (sale_name, team_name) VALUES ($1, $2)', [sale, team]);
      } else team = NO_TEAM;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    snapshotCache.clear();
    require('../debtSchedule/debtScheduleRepository').getDebtScheduleRepository().bumpVersion();
    require('../kiotvietSync/dashboardRollupEvents').dashboardRollupEvents.emit('updated', { at: Date.now() });
    return { saleName: sale, team };
  }

  return { snapshot, customerProducts, productCustomers, refreeze, setSaleTeam };
}

module.exports = { createRepository };
