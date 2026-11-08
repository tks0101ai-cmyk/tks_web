'use strict';

// GET /api/dashboard?view=<tab>: route chi doc/tinh/tra phan cua tab duoc chon
// (xem dashboard/dashboardViews.js). Test chay THANG handler cuoi cua route (bo
// qua requireAuth/resolveBranch vi day la ranh gioi khac, da co test rieng).

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

// routes.js destructure getDashboardData luc nap -> phai thay TRUOC khi require routes.
const dashboardData = require('../dashboard/dashboardData');
const calls = [];
let nextDebtManagement = null;
dashboardData.getDashboardData = async (filters, branch, viewer, options) => {
  calls.push({ filters, branch, viewer, options });
  return {
    updatedAt: 'x',
    filters: { invoices: { label: '30 ngày' } },
    kpi: {},
    invoices: { periodRevenue: 1 },
    debtManagement: nextDebtManagement || { available: true }
  };
};

const router = require('../routes');

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  return res;
}

function dashboardHandler() {
  const layer = router.stack.find(item => item.route && item.route.path === '/api/dashboard' && item.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const ALL_PERMISSIONS = [
  'reports.overview', 'reports.products', 'reports.invoices', 'reports.business', 'reports.debt'
];

function request(query, permissions = ALL_PERMISSIONS) {
  return { query, branch: 'Hà Nội', user: { permissions } };
}

test('khong co view: ca 3 tab nhu cu (khong truyen options.views), payload duoc cat theo quyen', async () => {
  calls.length = 0;
  const res = fakeRes();
  await dashboardHandler()(request({ days: '30' }, ['reports.invoices']), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options, undefined);
  assert.deepEqual(Object.keys(res.body).sort(), ['filters', 'invoices', 'kpi', 'updatedAt']);
});

test('view=invoices: truyen views=[invoices] xuong getDashboardData', async () => {
  calls.length = 0;
  const res = fakeRes();
  await dashboardHandler()(request({ view: 'invoices', days: '30', inMode: 'days', inDays: '7' }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].options, { views: ['invoices'] });
  assert.equal(calls[0].filters.invoices.days, '7');
  assert.equal(res.body.invoices.periodRevenue, 1);
});

test('chi con bo loc invoices: pr*/np*/ni*/cu* cua tab Hang hoa va Khach hang cu bi bo qua', async () => {
  calls.length = 0;
  await dashboardHandler()(request({
    inMode: 'days', inDays: '7', prMode: 'days', prDays: '30',
    niMode: 'range', niFrom: '2026-07-01', niTo: '2026-07-31', npMode: 'all', cuMode: 'all',
    // or*/rt* la bo loc cua 2 bang Dat hang / Tra hang da bo o tab Hoa don (2026-10-01): khong con duoc doc.
    orMode: 'days', orDays: '90',
    rtMode: 'all'
  }), fakeRes());
  assert.deepEqual(Object.keys(calls[0].filters), ['invoices']);
  assert.equal('orders' in calls[0].filters, false, 'orMode/... khong con duoc phan tich');
  assert.equal('returns' in calls[0].filters, false, 'rtMode/... khong con duoc phan tich');
});

test('view co nhieu tab: cach nhau dau phay, chi giu tab tai khoan co quyen', async () => {
  calls.length = 0;
  const res = fakeRes();
  await dashboardHandler()(request({ view: 'overview,debt,invoices' }, ['reports.overview', 'reports.invoices']), res);

  assert.deepEqual(calls[0].options, { views: ['overview', 'invoices'] }, 'debt bi bo vi thieu reports.debt');
  assert.equal(res.body.debtManagement, undefined);
});

test('view la tab tai khoan KHONG co quyen: tra payload rong ngay (khong doc/tinh gi, khong 403)', async () => {
  calls.length = 0;
  const res = fakeRes();
  await dashboardHandler()(request({ view: 'debt' }, ['reports.overview']), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { filters: {}, kpi: {} });
  assert.equal(calls.length, 0, 'khong duoc goi getDashboardData khi khong co tab nao duoc phep');
});

test('view sai ten: 400 INVALID_VIEW, khong goi getDashboardData', async () => {
  calls.length = 0;
  const res = fakeRes();
  await dashboardHandler()(request({ view: 'hoadon' }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_VIEW');
  assert.match(res.body.error, /hoadon/);
  assert.equal(calls.length, 0);
});

test('view bo trong hoac chi khoang trang = ca 5 tab', async () => {
  calls.length = 0;
  const res = fakeRes();
  await dashboardHandler()(request({ view: ' ' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].options, undefined);
});

test('view=debt co page: bang cong no loc/sap xep/phan trang tren may chu, giu KPI/chu ky, khong sua object cache', async () => {
  const customers = Array.from({ length: 130 }, (_, i) => ({ customerKey: 'k' + i, customerName: 'Khách ' + i, sale: i % 2 ? 'Lan' : 'Minh', currentDebt: i, overdueDebt: 0, workflowStatus: 'Chưa xử lý', paymentSchedule: '7' }));
  nextDebtManagement = { available: true, cycleDate: '2026-11-08', kpi: { actionCustomerCount: 9 }, customers };
  try {
    const res = fakeRes();
    await dashboardHandler()(request({ view: 'debt', page: '2', pageSize: '50', debtSale: 'Lan', sorts: JSON.stringify([{ key: 'currentDebt', dir: 'desc' }]) }), res);
    const debt = res.body.debtManagement;
    assert.equal(debt.totalRows, 65);
    assert.equal(debt.page, 2);
    assert.equal(debt.customers.length, 15);
    assert.equal(debt.customers[0].currentDebt, 29, 'trang 2 cua ket qua Lan sap giam dan');
    assert.equal(debt.cycleDate, '2026-11-08');
    assert.deepEqual(debt.kpi, { actionCustomerCount: 9 });
    assert.equal(nextDebtManagement.customers.length, 130, 'object cache khong bi cat');
    const full = fakeRes();
    await dashboardHandler()(request({ view: 'debt' }), full);
    assert.equal(full.body.debtManagement.customers.length, 130, 'khong co page = payload day du nhu cu (client cu)');
    assert.equal(full.body.debtManagement.totalRows, undefined);
    const denied = fakeRes();
    await dashboardHandler()(request({ page: '1', pageSize: '50' }, ['reports.invoices']), denied);
    assert.equal(denied.body.debtManagement, undefined, 'khong co quyen cong no thi khong co bang');
  } finally { nextDebtManagement = null; }
});
