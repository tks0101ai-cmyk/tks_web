'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Thay repository bang ban gia TRUOC khi nap routes.js (routes.js destructure ham luc nap) - test khong cham DB.
const repositoryPath = require.resolve('./productCustomerGrowthRepository');
const realRepository = require(repositoryPath);
const calls = [];
let nextError = null;
require.cache[repositoryPath].exports = {
  ...realRepository,
  getProductCustomerGrowth: async args => {
    calls.push(args);
    if (nextError) throw nextError;
    return { available: true, rows: [{ productCode: 'SP1' }], summary: { totalRows: 1, checkRows: 0 }, page: 1, pageSize: 50 };
  }
};
const router = require('../routes');
require.cache[repositoryPath].exports = realRepository;

const PATH = '/api/product-report/customer-growth';
function routeLayer() {
  const layer = router.stack.find(item => item.route && item.route.path === PATH && item.route.methods.get);
  if (!layer) throw new Error('Khong tim thay route GET ' + PATH);
  return layer;
}
function fakeRes() {
  return {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}
// Chay lan luot featureGuard cua router.use('/api/product-report') roi guard rieng cua route (khong dung JWT that).
async function runGuards(user) {
  const res = fakeRes();
  const chain = [
    ...router.stack.filter(layer => !layer.route && layer.regexp && layer.regexp.test(PATH) && layer.handle.name === 'featureGuard')
      .map(layer => layer.handle),
    ...routeLayer().route.stack.slice(0, -1).map(layer => layer.handle)
  ];
  for (const handle of chain) {
    let passed = false;
    await handle({ user }, res, () => { passed = true; });
    if (!passed) return { blocked: true, res };
  }
  return { blocked: false, res };
}

test('route nam duoi guard /api/product-report va con yeu cau them reports.products.sales', () => {
  const layer = routeLayer();
  assert.equal(layer.route.stack.length, 2, 'requireFeature + handler');
  assert.ok(router.stack.some(x => !x.route && x.regexp && x.regexp.test(PATH) && x.handle.name === 'featureGuard'),
    'phai co featureGuard (reports.products) ke thua tu router.use');
});

test('phan quyen: chua dang nhap 401, thieu reports.products hoac reports.products.sales 403, du quyen qua', async () => {
  const cases = [
    [undefined, 401],
    [{ vaiTro: 'Nhân viên marketing' }, 403],
    [{ vaiTro: 'Quản lý', featurePermissions: { 'reports.products': false } }, 403],
    [{ vaiTro: 'Quản lý', featurePermissions: { 'reports.products.sales': false } }, 403],
    [{ vaiTro: 'Khách' }, 403]
  ];
  for (const [user, status] of cases) {
    const result = await runGuards(user);
    assert.equal(result.blocked, true, JSON.stringify(user));
    assert.equal(result.res.statusCode, status, JSON.stringify(user));
  }
  const allowed = await runGuards({ vaiTro: 'Quản lý' });
  assert.equal(allowed.blocked, false);
});

async function call(query) {
  const res = fakeRes();
  await routeLayer().route.stack.at(-1).handle({ query }, res);
  return res;
}

test('200: chuyen dung tham so query sang repository', async () => {
  calls.length = 0;
  nextError = null;
  const res = await call({ product: 'binh', customer: 'hanh', growth: 'check', sort: 'growth', dir: 'asc', page: '2', pageSize: '25' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.available, true);
  assert.deepEqual(calls.at(-1), { product: 'binh', customer: 'hanh', growth: 'check', sort: 'growth', dir: 'asc', page: '2', pageSize: '25' });
});

test('loi: 400 giu thong diep, loi khac -> 500 thong diep chung (khong lo chi tiet)', async () => {
  const errors = console.error;
  console.error = () => {};
  try {
    nextError = Object.assign(new Error('Tham số báo cáo khách hàng theo sản phẩm không hợp lệ.'), { statusCode: 400 });
    let res = await call({ growth: 'xxx' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error, 'Tham số báo cáo khách hàng theo sản phẩm không hợp lệ.');
    nextError = new Error('password=secret connection refused');
    res = await call({});
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.error, 'Không lấy được báo cáo khách hàng theo sản phẩm.');
    assert.doesNotMatch(JSON.stringify(res.body), /secret/);
  } finally {
    console.error = errors;
    nextError = null;
  }
});
