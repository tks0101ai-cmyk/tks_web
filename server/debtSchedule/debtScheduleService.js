'use strict';

// Dung payload `debtManagement` (tab Cong no cua /api/dashboard) tu ban chot 15:00 + lich TT
// hien tai + phan hoi cua chu ky. Quyen sua tung cot tinh theo nguoi xem.

const { hasFeature } = require('../auth/featureRegistry');
const { branchLabelToCode } = require('../branch/branches');
const { buildCustomerRow, buildDebtReport, customerKeyOf, BRANCH_SHORT, UNGROUPED_SALE } = require('./debtScheduleRules');
const { vnDateKey } = require('../kiotvietSync/vnTime');
const debtScheduleRepository = require('./debtScheduleRepository');
const debtAgingRepository = require('./debtAgingRepository');

const DEBT_ACCESS_FEATURES = Object.freeze({
  saleFeedback: 'reports.debt.saleFeedback',
  managerFeedback: 'reports.debt.managerFeedback',
  status: 'reports.debt.edit',
  schedule: 'reports.debt.schedule',
  refresh: 'reports.debt.refresh'
});

function debtAccessFor(viewer) {
  const access = {};
  for (const [name, feature] of Object.entries(DEBT_ACCESS_FEATURES)) access[name] = hasFeature(viewer, feature);
  return access;
}

/** Chuoi on dinh mo ta quyen sua (dua vao khoa cache ket qua dashboard). */
function debtAccessTag(viewer) {
  const access = debtAccessFor(viewer);
  return Object.keys(DEBT_ACCESS_FEATURES).map(name => (access[name] ? '1' : '0')).join('');
}

/** @param {string[]} branchLabels - co so vat ly dang hien thi (BRANCHES.*) */
async function buildDebtManagement(branchLabels, viewer, {
  repository = debtScheduleRepository.getDebtScheduleRepository(), cycleDate
} = {}) {
  const branches = branchLabels.map(label => branchLabelToCode(label)).filter(Boolean);
  const access = debtAccessFor(viewer);
  try {
    const { cycle, rows, amountsByCustomer } = await repository.readReport(branches, cycleDate);
    const customers = cycle
      ? rows.map(row => buildCustomerRow(row, {
        cycleDate: cycle.cycleDate,
        anchorDate: cycle.refreshedAt ? vnDateKey(cycle.refreshedAt) : undefined,
        dailyAmounts: amountsByCustomer.get(`${row.branch}:${row.customerId}`) || [],
        access
      }))
      : [];
    const enriched = repository.attachSaleTeams ? await repository.attachSaleTeams(customers) : customers;
    return buildDebtReport({ cycle, customers: enriched, access });
  } catch (error) {
    // Xuat ban chot cu: ngay sai/het han phai bao loi ro rang, khong tra bang rong.
    if (cycleDate && error.statusCode) throw error;
    console.error('[debtSchedule] Khong doc duoc cong no:', error.message);
    return buildDebtReport({ cycle: null, customers: [], access, dataWarnings: [`Không tải được công nợ: ${error.message}`] });
  }
}

/**
 * Bang "Tuoi no theo hoa don" (so song, khong theo ban chot 15:00) cho cac co so (ma hanoi/saigon).
 * Chi doc bang da tinh san (debtAgingRefresh.js). Thu tu mac dinh: co so, ten khach.
 */
async function buildDebtAging(branches, { repository = debtAgingRepository.getDebtAgingRepository() } = {}) {
  let data;
  try {
    data = await repository.readAging(branches);
  } catch (error) {
    // Chua ap migration 0059: bang rong + canh bao, khong 503.
    if (error && error.code === '42P01') return { available: false, asOfDay: null, refreshedAt: null, customersSyncedAt: null, customers: [] };
    throw error;
  }
  const { state, rows } = data;
  const customers = rows.map(row => ({
    ...row,
    customerKey: customerKeyOf(row.branchCode, row.customerId),
    branch: BRANCH_SHORT[row.branchCode] || row.branchCode,
    sale: row.sale || UNGROUPED_SALE,
    paymentSchedule: String(row.scheduleDays)
  })).sort((a, b) => a.branch.localeCompare(b.branch) || a.customerName.localeCompare(b.customerName, 'vi'));
  return {
    available: Boolean(state),
    asOfDay: state ? state.asOfDay : null,
    refreshedAt: state ? state.refreshedAt : null,
    customersSyncedAt: state ? state.customersSyncedAt : null,
    customers: repository.attachSaleTeams ? await repository.attachSaleTeams(customers) : customers
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

/**
 * Hop chi tiet 1 dong "Kiem tra cong no": hoa don Hoan thanh cua khach trong khoang ngay no tuong duong
 * (tu ngay het no toi nay) + cac so tinh san cua dong do. `branches` = ma co so nguoi xem duoc phep.
 */
async function buildDebtAgingInvoices(branches, { branch, customerId }, { repository = debtAgingRepository.getDebtAgingRepository() } = {}) {
  const branchCode = String(branch || '').trim();
  const id = String(customerId || '').trim();
  if (!branchCode || !/^\d+$/.test(id)) throw httpError(400, 'Thiếu cơ sở hoặc mã khách.');
  if (!branches.includes(branchCode)) throw httpError(403, 'Bạn không có quyền xem cơ sở này.');
  let data;
  try {
    data = await repository.readCustomerInvoices(branchCode, id);
  } catch (error) {
    // Chua ap migration 0059: khong co dong tuoi no nao -> 404 nhu khach khong ton tai.
    if (error && error.code === '42P01') throw httpError(404, 'Chưa có số liệu tuổi nợ của khách này.');
    throw error;
  }
  const { customer, invoices } = data;
  if (!customer) throw httpError(404, 'Không tìm thấy khách trong bảng tuổi nợ.');
  return {
    customerName: customer.customerName,
    branch: BRANCH_SHORT[customer.branchCode] || customer.branchCode,
    currentDebt: customer.currentDebt,
    payoffDay: customer.payoffDay,
    beyondHistory: customer.beyondHistory,
    equivalentDays: customer.equivalentDays,
    remainingDays: customer.remainingDays,
    scheduleDays: customer.scheduleDays,
    invoices: invoices.map(invoice => ({ ...invoice, customerName: customer.customerName, amount: invoice.total })),
    total: invoices.reduce((sum, invoice) => sum + invoice.total, 0),
    truncated: invoices.length >= debtAgingRepository.INVOICE_LIST_LIMIT
  };
}

module.exports = { DEBT_ACCESS_FEATURES, debtAccessFor, debtAccessTag, buildDebtManagement, buildDebtAging, buildDebtAgingInvoices };
