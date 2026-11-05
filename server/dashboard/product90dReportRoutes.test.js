'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

// Thay repository bang ban gia TRUOC khi nap routes.js (routes.js destructure ham luc nap) - test khong cham DB.
const repositoryPath = require.resolve('./product90dReportRepository');
const realRepository = require(repositoryPath);
const calls = [];
let nextError = null;
require.cache[repositoryPath].exports = {
  ...realRepository,
  getProduct90dReport: async args => {
    calls.push(args);
    if (nextError) throw nextError;
    return { available: true, rows: [{ product_code: 'SP1' }], totalRows: 1, page: 1, pageSize: 50 };
  }
};
const router = require('../routes');
require.cache[repositoryPath].exports = realRepository;

const PATH = '/api/product-report/90d';
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
// Chay lan luot guard featureGuard cua router.use('/api/product-report') roi guard rieng cua route (khong dung JWT that).
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

test('guard /api/product-report dung truoc route, route con yeu cau them reports.products.sales', () => {
  const layer = routeLayer();
  assert.equal(layer.route.stack.length, 2, 'requireFeature + handler');
  const guard = router.stack.findIndex(x => !x.route && x.regexp && x.regexp.test(PATH));
  assert.ok(guard >= 0 && guard < router.stack.indexOf(layer));
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
    const { blocked, res } = await runGuards(user);
    assert.equal(blocked, true, JSON.stringify(user));
    assert.equal(res.statusCode, status, JSON.stringify(user));
  }
  for (const vaiTro of ['Quản lý', 'Trợ lý']) {
    const { blocked } = await runGuards({ vaiTro });
    assert.equal(blocked, false, vaiTro);
  }
  assert.equal(calls.length, 0, 'tai khoan bi chan khong duoc cham repository');
});

test('GET /90d chuyen dung tham so truy van vao repository va tra 200 nguyen ven', async () => {
  const res = fakeRes();
  const query = { q: 'binh', sort: 'qty_1_30d', dir: 'desc', page: '2', pageSize: '25' };
  await routeLayer().route.stack.at(-1).handle({ user: { vaiTro: 'Quản lý' }, query }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.available, true);
  assert.deepEqual(calls.at(-1), query);
});

test('GET /90d: tham so sai -> 400 kem thong bao; loi DB -> 500 thong bao chung khong lo chi tiet', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    nextError = Object.assign(new Error('Tham số báo cáo hàng hóa 90 ngày không hợp lệ.'), { statusCode: 400 });
    const bad = fakeRes();
    await routeLayer().route.stack.at(-1).handle({ user: { vaiTro: 'Quản lý' }, query: { sort: 'x' } }, bad);
    assert.equal(bad.statusCode, 400);
    assert.match(bad.body.error, /không hợp lệ/);

    nextError = Object.assign(new Error('relation "product_90d_report" does not exist: secret detail'), { code: '42P01' });
    const failed = fakeRes();
    await routeLayer().route.stack.at(-1).handle({ user: { vaiTro: 'Quản lý' }, query: {} }, failed);
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.error, 'Không lấy được báo cáo hàng hóa 90 ngày.');
    assert.equal(JSON.stringify(failed.body).includes('secret detail'), false);
    assert.equal(JSON.stringify(failed.body).includes('42P01'), false);
  } finally {
    nextError = null;
    console.error = originalError;
  }
});
