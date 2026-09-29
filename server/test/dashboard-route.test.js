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
dashboardData.getDashboardData = async (filters, branch, viewer, options) => {
  calls.push({ filters, branch, viewer, options });
  return {
    updatedAt: 'x',
    filters: { invoices: { label: '30 ngày' } },
    kpi: {},
    invoices: { periodRevenue: 1 },
    products: { childCategorySalesByParent: {}, availableParentCategories: [] },
    debtManagement: { available: true },
    customers: { topDebt: [] }
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
  'reports.overview', 'reports.products', 'reports.invoices', 'reports.customers', 'reports.suppliers', 'reports.debt'
];

function request(query, permissions = ALL_PERMISSIONS) {
  return { query, branch: 'Hà Nội', user: { permissions } };
}

test('khong co view: ca 6 tab nhu cu (khong truyen options.views), payload duoc cat theo quyen', async () => {
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

test('view bo trong hoac chi khoang trang = ca 6 tab', async () => {
  calls.length = 0;
  const res = fakeRes();
  await dashboardHandler()(request({ view: ' ' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].options, undefined);
});

test('bo loc Hang moi nhap (ni*) doc rieng, khong lan voi pr/np', async () => {
  calls.length = 0;
  await dashboardHandler()(request({
    view: 'products', niMode: 'range', niFrom: '2026-07-01', niTo: '2026-07-31',
    npMode: 'days', npDays: '7', prStatus: 'Đang kinh doanh'
  }), fakeRes());

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].filters.newlyImported, { mode: 'range', days: undefined, from: '2026-07-01', to: '2026-07-31' });
  assert.equal(calls[0].filters.newProducts.days, '7');
  assert.equal(calls[0].filters.products.status, 'Đang kinh doanh');
  assert.deepEqual(calls[0].options, { views: ['products'] });
});
