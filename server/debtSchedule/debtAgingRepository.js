'use strict';

// DOC bang ket qua "Tuoi no theo hoa don" (migration 0059) — da tinh san boi debtAgingRefresh.js
// sau moi luot dong bo KiotViet; o day khong tinh toan gi, chi SELECT.
//
// Cache: giu ket qua theo co so trong 60 giay; job tinh xong co thay doi thi xoa cache ngay
// (onDebtAgingChanged, cung 1 instance nhu toan codebase).

const { getPool } = require('../db/pool');
const { onDebtAgingChanged } = require('./debtAgingRefresh');
// Ten nhan vien ban tren Kiot co hau to "- <ID Telegram>": chi hien phan ten (saleName.js).
const { saleNameSql } = require('../dashboard/saleName');

const BRANCH_CODES = Object.freeze(['hanoi', 'saigon']);
const CACHE_TTL_MS = 60 * 1000;
const INVOICE_LIST_LIMIT = 500;

const STATE_SQL = `SELECT as_of_day::text AS as_of_day, refreshed_at, customers_synced_at, version
  FROM debt_aging_state WHERE id = 1`;

// Thu tu mac dinh: co so, ten khach (sap lai theo tieng Viet o service).
const ROWS_SQL = `
  SELECT branch, customer_id::text AS customer_id, customer_code, customer_name, sale, schedule_days,
         has_stored_schedule, current_debt::text AS current_debt, overdue_debt::text AS overdue_debt,
         payoff_day::text AS payoff_day, beyond_history, equivalent_days, remaining_days
  FROM debt_aging_customers
  WHERE branch = ANY($1::text[])
    AND EXISTS (SELECT 1 FROM customers c
      WHERE c.branch = debt_aging_customers.branch AND c.id = debt_aging_customers.customer_id
        AND COALESCE(c.raw->>'isActive', c.raw->>'IsActive', 'true') <> 'false')`;

// 1 dong khach da tinh san (de dung khoang ngay + the chi so cua hop chi tiet hoa don).
const CUSTOMER_SQL = `
  SELECT branch, customer_id::text AS customer_id, customer_code, customer_name, sale, schedule_days,
         has_stored_schedule, current_debt::text AS current_debt, overdue_debt::text AS overdue_debt,
         payoff_day::text AS payoff_day, beyond_history, equivalent_days, remaining_days
  FROM debt_aging_customers
  WHERE branch = $1 AND customer_id = $2::bigint
    AND EXISTS (SELECT 1 FROM customers c
      WHERE c.branch = debt_aging_customers.branch AND c.id = debt_aging_customers.customer_id
        AND COALESCE(c.raw->>'isActive', c.raw->>'IsActive', 'true') <> 'false')`;

// Hoa don Hoan thanh cua khach tu ngay het no ($3, gio VN) toi nay. purchase_date luu gio VN gan nhan UTC
// (giong AMOUNTS_SQL o debtAgingRefresh.js) -> moc = ngay::timestamp AT TIME ZONE 'UTC'.
const INVOICES_SQL = `
  SELECT i.code, to_char(i.purchase_date AT TIME ZONE 'UTC', 'DD/MM/YYYY HH24:MI') AS purchase_date,
         ${saleNameSql(`COALESCE(NULLIF(i.raw->>'soldByName', ''), s.name, '')`)} AS seller,
         COALESCE(i.total, 0)::text AS total
  FROM invoices i
  LEFT JOIN staff s ON s.branch = i.branch AND s.id = i.sold_by_id
  WHERE i.branch = $1 AND i.customer_id = $2::bigint
    AND i.purchase_date >= ($3::date::timestamp AT TIME ZONE 'UTC')
    AND i.raw->>'statusValue' = 'Hoàn thành'
  ORDER BY i.purchase_date DESC, i.id DESC
  LIMIT ${INVOICE_LIST_LIMIT}`;

function mapRow(row) {
  return {
    branchCode: row.branch,
    customerId: row.customer_id,
    customerCode: row.customer_code,
    customerName: row.customer_name || row.customer_code || `Khách #${row.customer_id}`,
    sale: row.sale,
    scheduleDays: Number(row.schedule_days),
    hasStoredSchedule: Boolean(row.has_stored_schedule),
    currentDebt: Number(row.current_debt) || 0,
    overdueDebt: Number(row.overdue_debt) || 0,
    payoffDay: row.payoff_day || null,
    beyondHistory: Boolean(row.beyond_history),
    equivalentDays: row.equivalent_days === null || row.equivalent_days === undefined ? null : Number(row.equivalent_days),
    remainingDays: row.remaining_days === null || row.remaining_days === undefined ? null : Number(row.remaining_days)
  };
}

function queryDebtAging(data, query = {}) {
  const { pageRows, sortRows, searchRows, rowText, scalarCatalog } = require('../shared/tablePage');
  const all = data.customers || [];
  const filter = (skip = '') => searchRows(all.filter(row =>
    (skip === 'team' || !query.team || row.saleTeam === query.team) &&
    (skip === 'sale' || !query.sale || row.sale === query.sale) &&
    (skip === 'schedule' || !query.schedule || row.paymentSchedule === query.schedule)), query,
  { searchText: rowText, code: row => row.customerCode }).rows;
  const rows = filter();
  const catalog = scalarCatalog(all);
  const aliases = { 'co-so': 'branch', 'khach-hang': 'customerName', 'sale-team': 'saleTeam', 'lich-tt': 'scheduleDays', 'no-hien-tai': 'currentDebt', 'no-qua-han': 'overdueDebt', 'ngay-het-no': 'payoffDay', 'ngay-no-tuong-duong': 'equivalentDays', 'con-han': 'remainingDays' };
  for (const [key, field] of Object.entries(aliases)) catalog[key] = row => row[field];
  const page = pageRows(sortRows(rows, query.sorts, catalog), query);
  const options = (skip, key) => [...new Set(filter(skip).map(row => row[key]).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b), 'vi', { numeric: true }));
  return { ...data, ...page, customers: page.rows,
    summary: { currentDebt: rows.reduce((sum, row) => sum + (Number(row.currentDebt) || 0), 0), overdueDebt: rows.reduce((sum, row) => sum + (Number(row.overdueDebt) || 0), 0) },
    filters: { teams: options('team', 'saleTeam'), sales: options('sale', 'sale'), schedules: options('schedule', 'paymentSchedule') },
    search: { requestedCodes: [], missingCodes: [] } };
}

function createDebtAgingRepository({ pool = getPool(), now = Date.now } = {}) {
  const cache = new Map(); // branchesKey -> { expiresAt, data }

  /** { state: { asOfDay, refreshedAt, customersSyncedAt } | null, rows: [...] } */
  async function readAging(branches) {
    const scope = (branches || []).filter(code => BRANCH_CODES.includes(code));
    const key = scope.slice().sort().join(',');
    const cached = cache.get(key);
    if (cached && now() < cached.expiresAt) return cached.data;
    const [state, rows] = await Promise.all([pool.query(STATE_SQL), pool.query(ROWS_SQL, [scope])]);
    const stateRow = state.rows[0];
    const data = {
      state: stateRow ? {
        asOfDay: stateRow.as_of_day,
        refreshedAt: stateRow.refreshed_at ? new Date(stateRow.refreshed_at).toISOString() : null,
        customersSyncedAt: stateRow.customers_synced_at ? new Date(stateRow.customers_synced_at).toISOString() : null
      } : null,
      rows: rows.rows.map(mapRow)
    };
    cache.set(key, { expiresAt: now() + CACHE_TTL_MS, data });
    return data;
  }

  /** { customer: dong tuoi no | null, invoices: [{ code, date, seller, total }] } — khong cache (chi mo khi bam dong). */
  async function readCustomerInvoices(branch, customerId) {
    const customer = (await pool.query(CUSTOMER_SQL, [branch, customerId])).rows[0];
    if (!customer) return { customer: null, invoices: [] };
    const mapped = mapRow(customer);
    // No <= 0: khong co ngay het no -> khong co khoang hoa don de liet ke.
    if (!mapped.payoffDay) return { customer: mapped, invoices: [] };
    const result = await pool.query(INVOICES_SQL, [branch, customerId, mapped.payoffDay]);
    return {
      customer: mapped,
      invoices: result.rows.map(row => ({
        code: row.code || '',
        date: row.purchase_date || '',
        seller: row.seller || '',
        total: Number(row.total) || 0
      }))
    };
  }

  return { attachSaleTeams: rows => require('./saleTeams').attachSaleTeams(rows, pool), readAging, readCustomerInvoices, clearCache: () => cache.clear() };
}

let defaultRepository = null;

function getDebtAgingRepository() {
  if (!defaultRepository) {
    defaultRepository = createDebtAgingRepository();
    onDebtAgingChanged(() => defaultRepository.clearCache());
  }
  return defaultRepository;
}

module.exports = { createDebtAgingRepository, getDebtAgingRepository, queryDebtAging, INVOICE_LIST_LIMIT };
