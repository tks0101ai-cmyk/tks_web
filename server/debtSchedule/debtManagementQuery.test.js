'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queryDebtManagement, filterDebtCustomers } = require('./debtManagementQuery');
const exportService = require('../dashboard/exportService');

function customer(index, extra = {}) {
  return {
    customerKey: `hanoi:${index}`, customerId: String(index), branch: index % 2 ? 'HN' : 'SG', branchCode: index % 2 ? 'hanoi' : 'saigon',
    customerName: `Khách ${String(index).padStart(3, '0')}`, sale: index % 3 ? 'Lan' : 'Minh', saleTeam: index % 4 ? 'Team A' : '',
    paymentSchedule: String(index % 2 ? 7 : 15), scheduleDays: index % 2 ? 7 : 15,
    currentDebt: index * 1000, overdueDebt: index % 5 ? 0 : index * 100, inScheduleDebt: 0,
    currentDebtToSalesRatio: null, overdueToSalesRatio: null, alertCodes: index % 5 ? [] : ['overdue'],
    overdueStreak: 0, previousPenaltyAmount: null, penaltyAmount: 0,
    saleFeedback: index === 42 ? 'Hẹn thứ sáu' : '', managerFeedback: '',
    workflowStatus: index % 7 ? 'Chưa xử lý' : 'Đã xử lý', needsAction: !(index % 5) && !!(index % 7),
    canEditStatus: true, canEditSaleFeedback: false, ...extra
  };
}

function debtPayload(count = 250) {
  return {
    available: true, cycleDate: '2026-11-08', access: { status: true, saleFeedback: false, managerFeedback: false, schedule: false, refresh: false },
    kpi: { totalCurrentDebt: 1, totalOverdueDebt: 2, actionCustomerCount: 3, overdueToSalesRatio: 0 },
    customers: Array.from({ length: count }, (_, i) => customer(i + 1))
  };
}

test('phân trang trên toàn bộ kết quả lọc: tổng/summary theo kết quả, KPI + chu kỳ + quyền giữ nguyên, không sửa đầu vào', () => {
  const debt = debtPayload();
  const before = JSON.stringify(debt);
  const page2 = queryDebtManagement(debt, { page: '2', pageSize: '100', debtSale: 'Lan' });
  const lan = debt.customers.filter(row => row.sale === 'Lan');
  assert.equal(page2.totalRows, lan.length);
  assert.equal(page2.page, 2);
  assert.equal(page2.pageSize, 100);
  assert.equal(page2.customers.length, lan.length - 100);
  assert.deepEqual(page2.customers.map(row => row.customerKey), lan.slice(100).map(row => row.customerKey));
  assert.equal(page2.summary.customerCount, lan.length);
  assert.equal(page2.summary.currentDebt, lan.reduce((sum, row) => sum + row.currentDebt, 0));
  assert.equal(page2.summary.needsActionCount, lan.filter(row => row.needsAction).length);
  assert.deepEqual(page2.kpi, debt.kpi, 'KPI vẫn của toàn chu kỳ');
  assert.equal(page2.cycleDate, '2026-11-08', 'giữ phiên bản chu kỳ để ghi');
  assert.deepEqual(page2.access, debt.access);
  assert.equal(JSON.stringify(debt), before, 'payload cache dùng chung không bị sửa');
});

test('trang vượt quá bị kẹp về trang cuối, kết quả rỗng về trang 1', () => {
  const debt = debtPayload(150);
  const last = queryDebtManagement(debt, { page: '99', pageSize: '100' });
  assert.equal(last.page, 2);
  assert.equal(last.customers.length, 50);
  const empty = queryDebtManagement(debt, { page: '5', pageSize: '100', q: 'khong-co-ai-ten-nay-zzz' });
  assert.equal(empty.totalRows, 0);
  assert.equal(empty.page, 1);
  assert.deepEqual(empty.customers, []);
});

test('lọc hàng chờ/team/lịch/trạng thái + tìm gần đúng trên mọi trường, facet liên kết tính trên toàn bộ', () => {
  const debt = debtPayload();
  const overdue = queryDebtManagement(debt, { page: '1', debtQueue: 'overdue', debtTeam: 'Chưa có team' });
  assert.ok(overdue.totalRows > 0);
  assert.ok(overdue.customers.every(row => row.overdueDebt > 0 && !row.saleTeam));
  const status = queryDebtManagement(debt, { page: '1', debtStatus: 'Đã xử lý', debtSchedule: '7' });
  assert.ok(status.customers.every(row => row.workflowStatus === 'Đã xử lý' && row.paymentSchedule === '7'));
  const feedback = queryDebtManagement(debt, { page: '1', q: 'hen thu sau' });
  assert.deepEqual(feedback.customers.map(row => row.customerKey), ['hanoi:42'], 'tìm cả phản hồi, không dấu');
  const linked = queryDebtManagement(debt, { page: '1', debtSale: 'Minh' });
  assert.deepEqual(linked.filters.sales, ['Lan', 'Minh'], 'facet sale bỏ qua chính bộ lọc sale');
  assert.deepEqual(linked.filters.schedules, ['7', '15'], 'lịch TT sắp theo số');
  assert.deepEqual(linked.filters.teams, ['Chưa có team', 'Team A']);
  const unknownQueue = queryDebtManagement(debt, { page: '1', debtQueue: "x' OR 1=1" });
  assert.equal(unknownQueue.totalRows, debt.customers.length, 'giá trị lạ = Tất cả, không lỗi');
});

test('sắp xếp nhiều lớp theo whitelist, NULL cuối, khóa lạ bị bỏ qua, thứ tự ổn định', () => {
  const debt = debtPayload(30);
  debt.customers[3].currentDebt = null;
  const sorted = queryDebtManagement(debt, { page: '1', sorts: JSON.stringify([{ key: 'sale', dir: 'asc' }, { key: 'currentDebt', dir: 'desc' }, { key: 'constructor', dir: 'asc' }]) });
  const rows = sorted.customers;
  const lan = rows.filter(row => row.sale === 'Lan');
  assert.equal(rows[0].sale, 'Lan');
  assert.equal(lan.at(-1).currentDebt, null, 'NULL cuối trong nhóm');
  const values = lan.slice(0, -1).map(row => row.currentDebt);
  assert.deepEqual(values, values.slice().sort((a, b) => b - a));
  const branch = queryDebtManagement(debt, { page: '1', sorts: JSON.stringify([{ key: 'branchLabel', dir: 'desc' }]) });
  assert.equal(branch.customers[0].branch, 'SG');
  const plain = queryDebtManagement(debt, { page: '1', sorts: 'not json' });
  assert.deepEqual(plain.customers.map(row => row.customerKey), debt.customers.map(row => row.customerKey), 'không sort = thứ tự gốc');
});

test('xuất file dùng cùng bộ lọc với bảng phân trang (đủ mọi trang, không chỉ trang đang xem)', async () => {
  const debt = debtPayload();
  const context = { debtQueue: 'all', debtSale: 'Lan', debtSchedule: '7', debtSearch: 'Khách 1' };
  const screen = queryDebtManagement(debt, { page: '1', pageSize: '10', debtQueue: 'all', debtSale: 'Lan', debtSchedule: '7', q: 'Khách 1' });
  const dataset = await exportService.__test__.buildFixedDataset('debt.management', { dashboard: { debtManagement: debt }, branch: 'Hà Nội' }, context);
  const rows = dataset.worksheets.flatMap(sheet => sheet.rows);
  assert.ok(screen.totalRows > screen.customers.length, 'kết quả nhiều hơn một trang');
  assert.equal(rows.length, screen.totalRows);
  const expected = filterDebtCustomers(debt.customers, { queue: 'all', sale: 'Lan', schedule: '7', q: 'Khách 1' }).map(row => row.customerName).sort();
  assert.deepEqual(rows.map(row => row.customerName).sort(), expected);
});
