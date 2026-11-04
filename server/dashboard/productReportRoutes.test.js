'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Thay repository bang ban gia TRUOC khi nap routes.js (routes.js destructure
// ham luc nap) - test khong cham DB.
const repositoryPath = require.resolve('./productReportRepository');
const realRepository = require(repositoryPath);
const calls = [];
const historyPath = require.resolve('./productHistoryRepository');
const realHistory = require(historyPath);
require.cache[historyPath].exports = { getProductHistory: async args => {
  calls.push(args);
  if (!args.code) throw Object.assign(new Error('Thiếu mã hàng.'), { statusCode: 400 });
  return { rows: [{ customerName: 'KH A', unitCost: null }], totalRows: 1, summary: { purchaseCount: 1 } };
} };
require.cache[repositoryPath].exports = {
  ...realRepository,
  getProductReport: async () => ({
    rows: [{
      code: 'SP1', name: 'SP 1', priceHanoi: 15000, priceSaigon: 16500, availableValueHanoi: 150000, availableValueSaigon: 33000,
      stockHanoi: 1, qtySold30dHanoi: 4, daysHanoi: 7.5
    }],
    computedAt: '2026-10-17T00:00:00.000Z'
  }),
  getProductReportCustomers: async (args) => {
    calls.push(args);
    if (!args.code) {
      const error = new Error('Thiếu mã hàng.');
      error.statusCode = 400;
      throw error;
    }
    return { code: args.code, totalRevenue: 10, customerCount: 1, rows: [{ customerName: 'KH A', revenue: 10, share: 1 }] };
  }
};

const router = require('../routes');
require.cache[historyPath].exports = realHistory;

function routeLayer(method, routePath) {
  const layer = router.stack.find(item => item.route && item.route.path === routePath && item.route.methods[method]);
  if (!layer) throw new Error(`Khong tim thay route ${method} ${routePath}`);
  return layer;
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

test('history API inherits report guards, sales permission and strips cost for unauthorized users', async () => {
  const layer = routeLayer('get', '/api/product-report/history');
  assert.equal(layer.route.stack.length, 2);
  const guard = router.stack.findIndex(x => !x.route && x.regexp && x.regexp.test('/api/product-report/history'));
  assert.ok(guard >= 0 && guard < router.stack.indexOf(layer));
  for (const [user,status] of [[undefined,401],[{vaiTro:'Nhân viên marketing'},403],[{vaiTro:'Quản lý',featurePermissions:{'reports.products.sales':false}},403]]) {
    const denied = fakeRes();
    await layer.route.stack[0].handle({user},denied,()=>assert.fail('must reject'));
    assert.equal(denied.statusCode,status);
  }
  for (const [vaiTro, allowed] of [['Quản lý', true], ['Nhân viên sale', false]]) {
    const res = fakeRes();
    await layer.route.stack.at(-1).handle({ user: { vaiTro }, query: {code:'SP1',q:'kh',type:'invoice',page:'2',pageSize:'25'} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.canViewCost, allowed);
    assert.equal('unitCost' in res.body.rows[0], allowed);
    assert.deepEqual(calls.at(-1), {code:'SP1',q:'kh',type:'invoice',page:'2',pageSize:'25'});
  }
  const res = fakeRes();
  await layer.route.stack.at(-1).handle({user:{vaiTro:'Quản lý'},query:{}}, res);
  assert.equal(res.statusCode, 400);
});

test('GET /api/product-report/customers tra doanh so khach theo ma hang (?code=)', async () => {
  const res = fakeRes();
  await routeLayer('get', '/api/product-report/customers').route.stack.at(-1).handle({ query: { code: '012CUTIE' } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.code, '012CUTIE');
  assert.deepEqual(calls.at(-1), { code: '012CUTIE' });
});

test('GET /api/product-report/customers tra 400 (khong phai 500) khi thieu ma hang', async () => {
  const originalError = console.error;
  console.error = () => {};
  const res = fakeRes();
  try {
    await routeLayer('get', '/api/product-report/customers').route.stack.at(-1).handle({ query: {} }, res);
  } finally {
    console.error = originalError;
  }
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /mã hàng/);
});

test('/api/product-report (ke ca /customers) chung guard reports.products, dat truoc route handler', () => {
  const guardIndex = router.stack.findIndex(layer => !layer.route && layer.regexp && layer.regexp.test('/api/product-report/customers'));
  const routeIndex = router.stack.indexOf(routeLayer('get', '/api/product-report/customers'));
  assert.ok(guardIndex >= 0, 'phai co middleware guard khop /api/product-report/customers');
  assert.ok(guardIndex < routeIndex, 'guard phai dung truoc route handler');
});

test('GET /api/product-report: don gia HN/SG chi tra cho tai khoan co quyen reports.products.price (Quan ly, Tro ly)', async () => {
  const handle = routeLayer('get', '/api/product-report').route.stack.at(-1).handle;
  for (const vaiTro of ['Quản lý', 'Trợ lý']) {
    const res = fakeRes();
    await handle({ user: { vaiTro } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.rows[0].priceHanoi, 15000, vaiTro);
    assert.equal(res.body.rows[0].priceSaigon, 16500, vaiTro);
    assert.equal(res.body.rows[0].availableValueHanoi, 150000, vaiTro);
    assert.equal(res.body.rows[0].availableValueSaigon, 33000, vaiTro);
  }
  for (const vaiTro of ['Nhân viên sale', 'Kế toán']) {
    const res = fakeRes();
    await handle({ user: { vaiTro } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(Object.keys(res.body.rows[0]).filter(key => realRepository.PRODUCT_REPORT_PRICE_KEYS.includes(key)), [],
      vaiTro + ' khong nhan 4 truong gia (don gia + gia tri co ban)');
    assert.equal(res.body.rows[0].stockHanoi, 1, 'cac truong khac giu nguyen');
    assert.equal(res.body.rows[0].qtySold30dHanoi, 4, 'SL ban 30 ngay khong phai truong nhay cam');
    assert.equal(res.body.rows[0].daysHanoi, 7.5);
  }
  // Quan ly cap rieng cho 1 sale: co quyen thi nhan gia (khi sale da co reports.products).
  const granted = fakeRes();
  await handle({ user: { vaiTro: 'Nhân viên sale', featurePermissions: { 'reports.products.price': true } } }, granted);
  assert.equal(granted.body.rows[0].priceHanoi, 15000);
  assert.equal(granted.body.rows[0].availableValueSaigon, 33000);
  // Gỡ quyền của một Quản lý cụ thể.
  const revoked = fakeRes();
  await handle({ user: { vaiTro: 'Quản lý', featurePermissions: { 'reports.products.price': false } } }, revoked);
  assert.equal('priceHanoi' in revoked.body.rows[0], false);
  assert.equal('availableValueHanoi' in revoked.body.rows[0], false);
});

test('GET /api/product-report: bo doc dung chung khong bi xoa truong gia sau khi loc cho tai khoan khac', async () => {
  const handle = routeLayer('get', '/api/product-report').route.stack.at(-1).handle;
  const sale = fakeRes();
  await handle({ user: { vaiTro: 'Nhân viên sale' } }, sale);
  const manager = fakeRes();
  await handle({ user: { vaiTro: 'Quản lý' } }, manager);
  assert.equal(manager.body.rows[0].priceHanoi, 15000);
  assert.equal(manager.body.rows[0].availableValueHanoi, 150000);
});

test('PRODUCT_REPORT_PRICE_KEYS gom dung 4 truong gia (route + xuat file dung chung)', () => {
  assert.deepEqual([...realRepository.PRODUCT_REPORT_PRICE_KEYS],
    ['priceHanoi', 'priceSaigon', 'availableValueHanoi', 'availableValueSaigon']);
});
