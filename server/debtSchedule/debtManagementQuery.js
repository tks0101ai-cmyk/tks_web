'use strict';

// Loc / tim / sap xep / phan trang bang "Danh sach thao tac" (tab Cong no) tren may chu (2026-11-08).
// Dau vao la payload `debtManagement` DA phan quyen (co so, cot sua theo nguoi xem); ham nay khong sua
// object dau vao (payload dashboard nam trong cache dung chung). KPI/bieu do van tinh tren toan bo
// chu ky; `summary` la tong cua ket qua sau loc. Xuat file dung CUNG ham loc filterDebtCustomers.

const { pageRows, sortRows, searchRows, rowText } = require('../shared/tablePage');

const QUEUES = new Set(['all', 'needsAction', 'currentDebt', 'overdue']);
const NO_TEAM = 'Chưa có team';
const text = value => (typeof value === 'string' ? value.trim() : '');

// Khoa sap xep = DEBT_SORT_FIELDS o public/index.html (thu tu cot cua bang).
const SORT_CATALOG = Object.freeze({
  branchLabel: row => row.branch || '—',
  customerName: row => row.customerName,
  sale: row => row.sale,
  saleTeam: row => row.saleTeam,
  scheduleDays: row => row.scheduleDays,
  currentDebt: row => row.currentDebt,
  overdueDebt: row => row.overdueDebt,
  inScheduleDebt: row => row.inScheduleDebt,
  currentDebtToSalesRatio: row => row.currentDebtToSalesRatio,
  overdueToSalesRatio: row => row.overdueToSalesRatio,
  alertCodes: row => (row.alertCodes || []).join(','),
  overdueStreak: row => row.overdueStreak,
  previousPenaltyAmount: row => row.previousPenaltyAmount,
  penaltyAmount: row => row.penaltyAmount,
  saleFeedback: row => row.saleFeedback,
  managerFeedback: row => row.managerFeedback,
  workflowStatus: row => row.workflowStatus
});

/** Bo loc thong nhat giua man hinh va file xuat. `skip` bo qua 1 bo loc de tinh lua chon lien ket. */
function filterDebtCustomers(customers, filters = {}, skip = '') {
  const queue = QUEUES.has(filters.queue) ? filters.queue : 'all';
  const team = text(filters.team);
  const sale = text(filters.sale);
  const schedule = text(filters.schedule);
  const status = text(filters.status);
  const matched = (Array.isArray(customers) ? customers : []).filter(customer => {
    if (skip !== 'queue') {
      if (queue === 'needsAction' && !customer.needsAction) return false;
      if (queue === 'currentDebt' && !(Number(customer.currentDebt) > 0)) return false;
      if (queue === 'overdue' && !(Number(customer.overdueDebt) > 0)) return false;
    }
    if (skip !== 'team' && team && (customer.saleTeam || NO_TEAM) !== team) return false;
    if (skip !== 'sale' && sale && customer.sale !== sale) return false;
    if (skip !== 'schedule' && schedule && String(customer.paymentSchedule) !== schedule) return false;
    if (skip !== 'status' && status && customer.workflowStatus !== status) return false;
    return true;
  });
  const q = text(filters.q);
  return q ? searchRows(matched, { q }, { searchText: rowText }).rows : matched;
}

function readFilters(query = {}) {
  const str = value => (typeof value === 'string' ? value : '');
  return {
    queue: str(query.debtQueue), team: str(query.debtTeam), sale: str(query.debtSale),
    schedule: str(query.debtSchedule), status: str(query.debtStatus), q: str(query.q)
  };
}

function distinct(rows, valueOf, compare) {
  return [...new Set(rows.map(valueOf).filter(value => value !== undefined && value !== null && value !== ''))].sort(compare);
}

/**
 * @param {object} debt  payload debtManagement (khong bi sua)
 * @param {object} query page, pageSize, sorts, q, debtQueue, debtTeam, debtSale, debtSchedule, debtStatus
 */
function queryDebtManagement(debt, query = {}) {
  const all = (debt && Array.isArray(debt.customers)) ? debt.customers : [];
  const filters = readFilters(query);
  const rows = filterDebtCustomers(all, filters);
  const page = pageRows(sortRows(rows, query.sorts, SORT_CATALOG), query);
  const sum = key => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const vi = (a, b) => String(a).localeCompare(String(b), 'vi', { sensitivity: 'base' });
  return {
    ...debt,
    ...page,
    customers: page.rows,
    summary: {
      customerCount: rows.length,
      currentDebt: sum('currentDebt'),
      overdueDebt: sum('overdueDebt'),
      needsActionCount: rows.filter(row => row.needsAction).length
    },
    // Lua chon lien ket: moi bo loc lay tu ket qua cua CAC BO LOC KHAC (giong filter-links.js tren man hinh).
    filters: {
      teams: distinct(filterDebtCustomers(all, filters, 'team'), row => row.saleTeam || NO_TEAM, vi),
      sales: distinct(filterDebtCustomers(all, filters, 'sale'), row => row.sale, vi),
      schedules: distinct(filterDebtCustomers(all, filters, 'schedule'), row => row.paymentSchedule, (a, b) => Number(a) - Number(b))
    },
    search: { requestedCodes: [], missingCodes: [] }
  };
}

module.exports = { filterDebtCustomers, queryDebtManagement, SORT_CATALOG, NO_TEAM };
