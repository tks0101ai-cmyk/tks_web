'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { signToken } = require('../auth/authService');
const localUserStore = require('../auth/localUserStore');
const effectiveUserResolver = require('../auth/effectiveUserResolver');
const testUsers = new Map();
localUserStore.getUserById = async id => testUsers.get(String(id)) || null;
effectiveUserResolver.resolveUser = async user => user;
delete require.cache[require.resolve('../auth/authMiddleware')];
delete require.cache[require.resolve('./orderLifecycleRoutes')];
const { AUTH_COOKIE_NAME } = require('../auth/authMiddleware');
const router = require('./orderLifecycleRoutes');
const service = require('./orderLifecycleService');
const kiotRepository = require('./kiotOrdersRepository');
const pickAssignments = require('../pickAssignments/pickAssignmentsService');

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {}, sentBuffer: null };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  res.setHeader = (name, value) => { res.headers[name] = value; return res; };
  res.send = payload => { res.sentBuffer = payload; if (res.statusCode === null) res.statusCode = 200; return res; };
  return res;
}

function getRouteStack(method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`Không tìm thấy route: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.map(l => l.handle);
}

/**
 * Chay TOAN BO middleware stack cua 1 route (requireAuth -> requireRole ->
 * handler chinh) — mo phong dung hanh vi production, khac hrLeaveRoutes.test.js
 * chi goi rieng handler cuoi (role-gating da duoc kiem o authMiddleware.test.js
 * roi). O day can kiem tra ca role-list CU THE cua tung route nen phai chay het.
 */
async function callRoute(method, routePath, req, res) {
  const stack = getRouteStack(method, routePath);
  for (const handle of stack) {
    let calledNext = false;
    await handle(req, res, () => { calledNext = true; });
    if (!calledNext) break;
  }
}

function reqAs(vaiTro, params, query, body) {
  const id = `u-${vaiTro}`;
  const user = { id, username: id, hoTen: 'Người dùng', vaiTro, coSo: 'Cả hai', trangThai: 'Đang hoạt động' };
  testUsers.set(id, user);
  const token = signToken(user);
  return { cookies: { [AUTH_COOKIE_NAME]: token }, params: params || {}, query: query || {}, body: body || {} };
}

test.beforeEach(() => {
  service.findOrder = async () => ({ found: true, branch: 'HN', summary: { code: 'DELIVERED' }, detail: {} });
  service.listAllOrders = async () => ([{ orderCode: 'HD001' }]);
  // Bang "Toan bo don hang" goi queryOrders (1 TRANG, loc/sap xep tren may chu, gop don Kiot moi trang thai).
  service.queryOrders = async () => ({
    orders: [{ orderCode: 'HD001' }], page: 1, pageSize: 100, totalPages: 1, total: 1, filteredTotal: 1, kiotStatuses: [],
    kiot: { ok: true, stale: false, fetchedAt: null, count: 0 }
  });
  // Khong cham DB that: thay chi tiet dong hang cua Kiot bang ban gia.
  kiotRepository.kiotOrders.readOrderDetail = async ({ branch, code }) => ({ code, branch, phieuTam: true, lines: [] });
  service.exportOrders = async () => ([{ orderCode: 'HD001', branch: 'HN', summary: { label: 'Đã giao' } }]);
  service.overrideStatus = async () => ({ orderCode: 'HD001', branch: 'HN', summary: { code: 'CANCELLED', isOverride: true } });
  service.listHistory = async () => ([{ historyId: 'OVR-1', orderCode: 'HD001', statusCode: 'CANCELLED' }]);
});

// 2026-10-03: Tra cuu theo ma + Lich su GAN vao Vong doi don hang -> Khach (khong co lifecycle) bi 403.
test('GET /api/shipment/lifecycle/:orderCode — Khách bị 403 (tra cứu theo mã cần Vòng đời đơn hàng)', async () => {
  const req = reqAs('Khách', { orderCode: 'HD001' });
  const res = fakeRes();
  await callRoute('get', '/:orderCode', req, res);
  assert.equal(res.statusCode, 403);
});

test('GET /api/shipment/lifecycle — Khách bị 403', async () => {
  const req = reqAs('Khách');
  const res = fakeRes();
  await callRoute('get', '/', req, res);
  assert.equal(res.statusCode, 403);
});

// Xem toan bo don (GET /, GET /order-detail), Tra cuu 1 don (GET /:orderCode) va Lich su (GET /history)
// CUNG nhom vai tro: noi bo TRU Nhan vien kho (2026-10-03), Nhan vien mua hang va Nhan vien marketing (2026-10-02);
// cac vai tro do (va Khach) khong con gi trong Vong doi don hang. XUAT EXCEL (POST /export) chi Quan ly (2026-10-02).
const INTERNAL_ROLES = [
  'Kế toán', 'Trưởng kho', 'Quản lý', 'Trợ lý', 'Nhân viên sale',
  'Lái xe', 'Nhân viên kho', 'Nhân viên mua hàng'
];
const NO_LIFECYCLE_ROLES = ['Nhân viên kho', 'Nhân viên mua hàng', 'Nhân viên marketing'];
const LIFECYCLE_VIEW_ROLES = INTERNAL_ROLES.filter(role => !NO_LIFECYCLE_ROLES.includes(role));

for (const role of LIFECYCLE_VIEW_ROLES) {
  test(`GET /api/shipment/lifecycle/:orderCode — ${role} gọi được (200)`, async () => {
    const req = reqAs(role, { orderCode: 'HD001' });
    const res = fakeRes();
    await callRoute('get', '/:orderCode', req, res);
    assert.equal(res.statusCode, 200);
  });
}

for (const role of LIFECYCLE_VIEW_ROLES) {
  test(`GET /api/shipment/lifecycle — ${role} gọi được (200)`, async () => {
    const req = reqAs(role);
    const res = fakeRes();
    await callRoute('get', '/', req, res);
    assert.equal(res.statusCode, 200);
  });
}

for (const role of NO_LIFECYCLE_ROLES) {
  test(`GET /api/shipment/lifecycle, /order-detail, /:orderCode, /history — ${role} bị 403 (không có Vòng đời đơn hàng)`, async () => {
    const list = fakeRes();
    await callRoute('get', '/', reqAs(role), list);
    assert.equal(list.statusCode, 403);
    const detail = fakeRes();
    await callRoute('get', '/order-detail', reqAs(role, {}, { code: 'DH1', branch: 'HN' }), detail);
    assert.equal(detail.statusCode, 403);
    const lookup = fakeRes();
    await callRoute('get', '/:orderCode', reqAs(role, { orderCode: 'HD001' }), lookup);
    assert.equal(lookup.statusCode, 403, 'tra cuu theo ma gan voi Vong doi don hang');
    const history = fakeRes();
    await callRoute('get', '/history', reqAs(role), history);
    assert.equal(history.statusCode, 403);
  });
}

test('GET /api/shipment/lifecycle/history — Khách bị 403', async () => {
  const req = reqAs('Khách');
  const res = fakeRes();
  await callRoute('get', '/history', req, res);
  assert.equal(res.statusCode, 403);
});

for (const role of LIFECYCLE_VIEW_ROLES) {
  test(`GET /api/shipment/lifecycle/history — ${role} gọi được (200)`, async () => {
    const req = reqAs(role);
    const res = fakeRes();
    await callRoute('get', '/history', req, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.history, [{ historyId: 'OVR-1', orderCode: 'HD001', statusCode: 'CANCELLED' }]);
  });
}

test('GET /api/shipment/lifecycle/history KHÔNG bị route /:orderCode nuốt mất (không lẫn với tra cứu mã đơn "history")', async () => {
  const req = reqAs('Quản lý');
  const res = fakeRes();
  await callRoute('get', '/history', req, res);
  assert.deepEqual(Object.keys(res.body), ['history']);
});

test('GET /api/shipment/lifecycle trả 1 TRANG đơn (gộp đơn Kiot mọi trạng thái): truyền nguyên query + kiot repository, trả đúng phần phân trang và trạng thái nguồn `kiot`', async () => {
  let received = null;
  const payload = {
    orders: [{ orderCode: 'DH1', source: 'kiotviet', kiotStatus: 'Hoàn thành' }], page: 2, pageSize: 100, totalPages: 7, total: 650,
    filteredTotal: 650, kiotStatuses: ['Phiếu tạm', 'Hoàn thành'], kiot: { ok: false, stale: false, fetchedAt: null, count: 0 }
  };
  service.queryOrders = async (params, options) => {
    received = { params, options };
    return payload;
  };
  const query = { branch: 'SG', kiotStatus: 'Hoàn thành', page: '2', sort: 'note', dir: 'desc' };
  const res = fakeRes();
  // Xóa tạm hai biến retailer của .env để kết quả không phụ thuộc máy chạy test.
  const previous = { hn: process.env.KIOTVIET_RETAILER, sg: process.env.KIOTVIET_RETAILER_SG };
  delete process.env.KIOTVIET_RETAILER;
  delete process.env.KIOTVIET_RETAILER_SG;
  try {
    await callRoute('get', '/', reqAs('Nhân viên sale', {}, query), res);
  } finally {
    if (previous.hn !== undefined) process.env.KIOTVIET_RETAILER = previous.hn;
    if (previous.sg !== undefined) process.env.KIOTVIET_RETAILER_SG = previous.sg;
  }
  assert.equal(res.statusCode, 200);
  // Body = nguyen ket qua service + kiotOrderHosts (ten mien gian hang cho nut "Mo don tren Kiot").
  // Khong co bien KIOTVIET_RETAILER nen hai co so deu null -> giao dien khong hien nut.
  assert.deepEqual(res.body, { ...payload, kiotOrderHosts: { HN: null, SG: null } });
  assert.deepEqual(received.params, query, 'bo loc/sap xep/trang di thang xuong service (service kiem tra hop le)');
  assert.equal(received.options.kiot, kiotRepository.kiotOrders, 'phai truyen repository doc don cua Kiot');
  // Nhan vien sale khong co shipment.pick -> KHONG nhan trang thai boc / canh bao chi dinh (cot bi an).
  assert.equal(received.options.pickStatuses, undefined);
  assert.equal(received.options.pickWarnings, undefined);
});

test('GET /api/shipment/lifecycle: nguoi co quyen shipment.pick (Quan ly) nhan nguon trang thai boc + canh bao chi dinh (Lech Kiot / Lech SL trong don)', async () => {
  let received = null;
  service.queryOrders = async (params, options) => { received = options; return { orders: [], page: 1, pageSize: 100, totalPages: 1, total: 0, filteredTotal: 0 }; };
  await callRoute('get', '/', reqAs('Quản lý'), fakeRes());
  assert.equal(received.pickStatuses, pickAssignments.latestStatuses, 'phai truyen nguon trang thai chi dinh vi tri (cot pickStatus + bo loc)');
  assert.equal(typeof pickAssignments.pickWarnings, 'function');
  assert.equal(received.pickWarnings, pickAssignments.pickWarnings, 'phai truyen nguon canh bao chi dinh');
});

test('GET /api/shipment/lifecycle: co bien gian hang thi tra ten mien de mo don tren Kiot', async () => {
  const previous = { hn: process.env.KIOTVIET_RETAILER, sg: process.env.KIOTVIET_RETAILER_SG };
  process.env.KIOTVIET_RETAILER = 'CHhanoi';
  process.env.KIOTVIET_RETAILER_SG = 'CHsaigon';
  try {
    service.queryOrders = async () => ({ orders: [], page: 1, pageSize: 100, totalPages: 1, total: 0, filteredTotal: 0 });
    const res = fakeRes();
    await callRoute('get', '/', reqAs('Quản lý'), res);
    assert.deepEqual(res.body.kiotOrderHosts, { HN: 'chhanoi.kiotviet.vn', SG: 'chsaigon.kiotviet.vn' });
  } finally {
    if (previous.hn === undefined) delete process.env.KIOTVIET_RETAILER; else process.env.KIOTVIET_RETAILER = previous.hn;
    if (previous.sg === undefined) delete process.env.KIOTVIET_RETAILER_SG; else process.env.KIOTVIET_RETAILER_SG = previous.sg;
  }
});

test('Tra cuu 1 don KHONG tra ten mien Kiot: chi route xem toan bo don can nut "Mo don tren Kiot"', async () => {
  const previous = process.env.KIOTVIET_RETAILER;
  process.env.KIOTVIET_RETAILER = 'CHhanoi';
  try {
    const res = fakeRes();
    await callRoute('get', '/:orderCode', reqAs('Quản lý', { orderCode: 'HD001' }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(res.body || {}, 'kiotOrderHosts'), false);
  } finally {
    if (previous === undefined) delete process.env.KIOTVIET_RETAILER; else process.env.KIOTVIET_RETAILER = previous;
  }
});

test('GET /api/shipment/lifecycle: tham số sai (service ném 400) -> trả 400 kèm mã, không phải 500', async () => {
  service.queryOrders = async () => {
    const err = new Error('Tham số "branch" phải là "HN" hoặc "SG".');
    err.statusCode = 400;
    err.code = 'INVALID_BRANCH';
    throw err;
  };
  const res = fakeRes();
  await callRoute('get', '/', reqAs('Quản lý', {}, { branch: 'XX' }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_BRANCH');
});


test('GET /api/shipment/lifecycle/:orderCode không đăng nhập -> 401', async () => {
  const req = { cookies: {}, params: { orderCode: 'HD001' }, query: {} };
  const res = fakeRes();
  await callRoute('get', '/:orderCode', req, res);
  assert.equal(res.statusCode, 401);
});

test('POST /api/shipment/lifecycle/lookup đã gỡ (không giao diện nào gọi): không route POST nào khớp "/lookup" -> Express trả 404', () => {
  const matching = router.stack.filter(l => l.route && l.route.methods.post && l.match('/lookup'));
  assert.deepEqual(matching.map(l => l.route.path), []);
});

// Xuat Excel (2026-10-02): CHI Quan ly co quyen mac dinh. Moi vai tro khac (ke ca Tro ly, Ke toan) bi 403.
test('POST /api/shipment/lifecycle/export — Khách bị 403', async () => {
  const req = reqAs('Khách', {}, {}, {});
  const res = fakeRes();
  await callRoute('post', '/export', req, res);
  assert.equal(res.statusCode, 403);
});

for (const role of INTERNAL_ROLES.filter(item => item !== 'Quản lý')) {
  test(`POST /api/shipment/lifecycle/export — ${role} bị 403 (chỉ Quản lý được xuất file)`, async () => {
    let exported = false;
    service.exportOrders = async () => { exported = true; return []; };
    const req = reqAs(role, {}, {}, {});
    const res = fakeRes();
    await callRoute('post', '/export', req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(exported, false, 'khong doc du lieu khi khong co quyen');
  });
}

test('POST /api/shipment/lifecycle/export — Quản lý gọi được (200, trả file xlsx)', async () => {
  const req = reqAs('Quản lý', {}, {}, {});
  const res = fakeRes();
  await callRoute('post', '/export', req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.ok(res.sentBuffer && res.sentBuffer.length > 0);
});

test('POST /api/shipment/lifecycle/export — tài khoản được Quản lý cấp thêm quyền shipment.export (ghi đè theo tài khoản) cũng xuất được', async () => {
  const req = reqAs('Kế toán', {}, {}, {});
  testUsers.get('u-Kế toán').featurePermissions = { 'shipment.export': true };
  const res = fakeRes();
  await callRoute('post', '/export', req, res);
  testUsers.get('u-Kế toán').featurePermissions = undefined;
  assert.equal(res.statusCode, 200);
});

test('POST /api/shipment/lifecycle/export gửi BỘ LỌC (body) + kiot repository cho service, không gửi danh sách mã', async () => {
  let received = null;
  service.exportOrders = async (params, options) => {
    received = { params, options };
    return [{ orderCode: 'DH1', branch: 'HN', summary: { label: 'Đơn chưa gửi kế toán' }, kiotStatus: 'Hoàn thành' }];
  };
  const body = { branch: 'HN', kiotStatus: 'Hoàn thành', sort: 'orderCode', dir: 'desc' };
  const res = fakeRes();
  await callRoute('post', '/export', reqAs('Quản lý', {}, {}, body), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(received.params, body);
  assert.equal(received.options.kiot, kiotRepository.kiotOrders);
});

test('POST /api/shipment/lifecycle/export — quá giới hạn số dòng -> 400 TOO_MANY_ROWS (không dựng file lớn làm nghẽn máy chủ)', async () => {
  const { MAX_EXPORT_ROWS } = require('./orderLifecycleExport');
  service.exportOrders = async () => Array.from({ length: MAX_EXPORT_ROWS + 1 }, (_, i) => ({ orderCode: 'DH' + i, branch: 'HN', summary: {} }));
  const res = fakeRes();
  await callRoute('post', '/export', reqAs('Quản lý', {}, {}, {}), res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'TOO_MANY_ROWS');
  assert.match(res.body.error, /vượt giới hạn 20,000 đơn/);
  assert.equal(res.sentBuffer, null);
});

// ---------------------------------------------------------------------------
// GET /api/shipment/lifecycle/order-detail — chi tiet dong hang theo Kiot (chi vai tro xem duoc bang toan bo don)
// ---------------------------------------------------------------------------

test('GET /order-detail — Khách bị 403 (không lộ giá/tồn kho cho khách tra cứu)', async () => {
  const res = fakeRes();
  await callRoute('get', '/order-detail', reqAs('Khách', {}, { code: 'DH1', branch: 'HN' }), res);
  assert.equal(res.statusCode, 403);
});

test('GET /order-detail — không đăng nhập -> 401', async () => {
  const res = fakeRes();
  await callRoute('get', '/order-detail', { cookies: {}, params: {}, query: { code: 'DH1', branch: 'HN' } }, res);
  assert.equal(res.statusCode, 401);
});

for (const role of LIFECYCLE_VIEW_ROLES) {
  test(`GET /order-detail — ${role} gọi được (200) và truyền đúng cơ sở/mã`, async () => {
    let received = null;
    kiotRepository.kiotOrders.readOrderDetail = async args => { received = args; return { code: args.code, branch: args.branch, phieuTam: true, lines: [] }; };
    const res = fakeRes();
    await callRoute('get', '/order-detail', reqAs(role, {}, { code: ' DH041173 ', branch: 'HN' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(received, { branch: 'HN', code: 'DH041173' });
    assert.equal(res.body.detail.code, 'DH041173');
  });
}

test('GET /order-detail KHÔNG bị route /:orderCode nuốt mất (không lẫn với tra cứu mã đơn "order-detail")', async () => {
  let lookupCalled = false;
  service.findOrder = async () => { lookupCalled = true; return { found: false }; };
  const res = fakeRes();
  await callRoute('get', '/order-detail', reqAs('Quản lý', {}, { code: 'DH1', branch: 'SG' }), res);
  assert.equal(lookupCalled, false);
  assert.deepEqual(Object.keys(res.body), ['detail']);
});

test('GET /order-detail — thiếu/sai mã hoặc cơ sở -> 400', async () => {
  const noCode = fakeRes();
  await callRoute('get', '/order-detail', reqAs('Quản lý', {}, { branch: 'HN' }), noCode);
  assert.equal(noCode.statusCode, 400);
  assert.equal(noCode.body.code, 'INVALID_CODE');

  const badBranch = fakeRes();
  await callRoute('get', '/order-detail', reqAs('Quản lý', {}, { code: 'DH1', branch: 'Hà Nội' }), badBranch);
  assert.equal(badBranch.statusCode, 400);
  assert.equal(badBranch.body.code, 'INVALID_BRANCH');

  const longCode = fakeRes();
  await callRoute('get', '/order-detail', reqAs('Quản lý', {}, { code: 'D'.repeat(101), branch: 'HN' }), longCode);
  assert.equal(longCode.statusCode, 400);
});

test('GET /order-detail — lỗi 404 của kho dữ liệu được trả đúng statusCode/code', async () => {
  kiotRepository.kiotOrders.readOrderDetail = async () => {
    const err = new Error('Không tìm thấy đơn đặt hàng này.');
    err.statusCode = 404;
    err.code = 'ORDER_NOT_FOUND';
    throw err;
  };
  const res = fakeRes();
  await callRoute('get', '/order-detail', reqAs('Quản lý', {}, { code: 'DH999', branch: 'HN' }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'ORDER_NOT_FOUND');
});

test('POST /api/shipment/lifecycle/export — lỗi từ service được trả về đúng statusCode', async () => {
  service.exportOrders = async () => { throw new Error('Lỗi Google Sheets'); };
  const req = reqAs('Quản lý', {}, {}, { codes: ['HD001'] });
  const res = fakeRes();
  await callRoute('post', '/export', req, res);
  assert.equal(res.statusCode, 500);
});

// ---------------------------------------------------------------------------
// POST /api/shipment/lifecycle/:orderCode/override — mac dinh chi Quan ly (Ke toan phai duoc Quan ly cap rieng, 2026-10-03)
// ---------------------------------------------------------------------------

const OVERRIDE_ROLES = ['Quản lý'];
const NON_OVERRIDE_INTERNAL_ROLES = [
  'Kế toán', 'Trưởng kho', 'Trợ lý', 'Nhân viên sale', 'Lái xe', 'Nhân viên kho', 'Nhân viên mua hàng'
];

for (const role of OVERRIDE_ROLES) {
  test(`POST /api/shipment/lifecycle/:orderCode/override — ${role} gọi được (200)`, async () => {
    const req = reqAs(role, { orderCode: 'HD001' }, {}, { status: 'CANCELLED' });
    const res = fakeRes();
    await callRoute('post', '/:orderCode/override', req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.order.summary.code, 'CANCELLED');
  });
}

for (const role of NON_OVERRIDE_INTERNAL_ROLES) {
  test(`POST /api/shipment/lifecycle/:orderCode/override — ${role} bị 403 (xem được nhưng không sửa được)`, async () => {
    const req = reqAs(role, { orderCode: 'HD001' }, {}, { status: 'CANCELLED' });
    const res = fakeRes();
    await callRoute('post', '/:orderCode/override', req, res);
    assert.equal(res.statusCode, 403);
  });
}

test('POST /api/shipment/lifecycle/:orderCode/override — Kế toán được Quản lý cấp riêng shipment.override thì gọi được; NV kho (không có Vòng đời) có cấp cũng 403', async () => {
  const accountant = reqAs('Kế toán', { orderCode: 'HD001' }, {}, { status: 'CANCELLED' });
  testUsers.get('u-Kế toán').featurePermissions = { 'shipment.override': true };
  const ok = fakeRes();
  await callRoute('post', '/:orderCode/override', accountant, ok);
  testUsers.get('u-Kế toán').featurePermissions = undefined;
  assert.equal(ok.statusCode, 200);

  const keeper = reqAs('Nhân viên kho', { orderCode: 'HD001' }, {}, { status: 'CANCELLED' });
  testUsers.get('u-Nhân viên kho').featurePermissions = { 'shipment.override': true };
  const denied = fakeRes();
  await callRoute('post', '/:orderCode/override', keeper, denied);
  testUsers.get('u-Nhân viên kho').featurePermissions = undefined;
  assert.equal(denied.statusCode, 403);
});

test('POST /api/shipment/lifecycle/:orderCode/override — Khách bị 403', async () => {
  const req = reqAs('Khách', { orderCode: 'HD001' }, {}, { status: 'CANCELLED' });
  const res = fakeRes();
  await callRoute('post', '/:orderCode/override', req, res);
  assert.equal(res.statusCode, 403);
});

test('POST /api/shipment/lifecycle/:orderCode/override — thiếu "status" -> 400 INVALID_REQUEST', async () => {
  const req = reqAs('Quản lý', { orderCode: 'HD001' }, {}, {});
  const res = fakeRes();
  await callRoute('post', '/:orderCode/override', req, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'INVALID_REQUEST');
});

test('POST /api/shipment/lifecycle/:orderCode/override — truyền đúng changedBy/changedByRole từ req.user', async () => {
  let received = null;
  service.overrideStatus = async (orderCode, opts) => {
    received = { orderCode, opts };
    return { orderCode, branch: 'HN', summary: { code: opts.code, isOverride: true } };
  };
  const req = reqAs('Kế toán', { orderCode: 'HD001' }, {}, { status: 'EXCEPTION', note: 'khách báo hỏng hàng' });
  testUsers.get('u-Kế toán').featurePermissions = { 'shipment.override': true };
  const res = fakeRes();
  await callRoute('post', '/:orderCode/override', req, res);
  testUsers.get('u-Kế toán').featurePermissions = undefined;
  assert.equal(res.statusCode, 200);
  assert.equal(received.orderCode, 'HD001');
  assert.equal(received.opts.code, 'EXCEPTION');
  assert.equal(received.opts.changedByRole, 'Kế toán');
  assert.equal(received.opts.note, 'khách báo hỏng hàng');
});

test('POST /api/shipment/lifecycle/:orderCode/override — lỗi từ service được trả về đúng statusCode', async () => {
  service.overrideStatus = async () => {
    const err = new Error('Không tìm thấy đơn hàng "HD999".');
    err.statusCode = 404;
    err.code = 'ORDER_NOT_FOUND';
    throw err;
  };
  const req = reqAs('Quản lý', { orderCode: 'HD999' }, {}, { status: 'CANCELLED' });
  const res = fakeRes();
  await callRoute('post', '/:orderCode/override', req, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'ORDER_NOT_FOUND');
});

// CONT details reuse the report repository, while lifecycle never exposes its
// privileged fields, even to managers or callers supplying fullAccess=true.
for (const role of LIFECYCLE_VIEW_ROLES) {
  test(`GET /containers allows lifecycle role ${role} with public fields only`, async () => {
    const repository = require('../productContainers/repository');
    const original = repository.getContainerDetails;
    let received;
    repository.getContainerDetails = async args => { received = args; return { rows: [], fullAccess: args.fullAccess }; };
    try {
      const req = reqAs(role, {}, { code: 'SKU', fullAccess: 'true' });
      const res = fakeRes();
      await callRoute('get', '/containers', req, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(received, { code: 'SKU', fullAccess: false });
      assert.equal(res.body.fullAccess, false);
    } finally { repository.getContainerDetails = original; }
  });
}
test('GET /containers denies anonymous, guest, missing lifecycle roles and revoked permissions before reading data', async () => {
  const repository = require('../productContainers/repository');
  const original = repository.getContainerDetails;
  let calls = 0;
  repository.getContainerDetails = async () => { calls++; return { rows: [] }; };
  try {
    const anonymous = fakeRes();
    await callRoute('get', '/containers', { cookies: {}, query: { code: 'SKU' }, params: {} }, anonymous);
    assert.equal(anonymous.statusCode, 401);
    for (const role of ['Khách', ...NO_LIFECYCLE_ROLES]) {
      const res = fakeRes();
      await callRoute('get', '/containers', reqAs(role, {}, { code: 'SKU' }), res);
      assert.equal(res.statusCode, 403);
    }
    const revoked = reqAs('Quản lý', {}, { code: 'SKU' });
    testUsers.get('u-Quản lý').featurePermissions = { 'shipment.lifecycle': false };
    const denied = fakeRes();
    await callRoute('get', '/containers', revoked, denied);
    assert.equal(denied.statusCode, 403);
    assert.equal(calls, 0);
  } finally { repository.getContainerDetails = original; }
});
test('GET /containers sanitizes unexpected DB errors and retains unavailable snapshot metadata', async () => {
  const repository = require('../productContainers/repository');
  const original = repository.getContainerDetails;
  try {
    repository.getContainerDetails = async () => { throw Error('private DB credentials'); };
    const res = fakeRes();
    await callRoute('get', '/containers', reqAs('Quản lý', {}, { code: 'SKU' }), res);
    assert.equal(res.statusCode, 503);
    assert.doesNotMatch(JSON.stringify(res.body), /private|credentials/);
    repository.getContainerDetails = async () => {
      throw Object.assign(Error('Chưa sẵn sàng'), { statusCode: 503, code: 'CONTAINER_SNAPSHOT_UNAVAILABLE', containerSync: { available: false } });
    };
    await callRoute('get', '/containers', reqAs('Quản lý', {}, { code: 'SKU' }), res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.containerSync.available, false);
  } finally { repository.getContainerDetails = original; }
});
test('GET /containers precedes the dynamic order-code route', () => {
  const paths = router.stack.filter(layer => layer.route?.methods.get).map(layer => layer.route.path);
  assert.ok(paths.indexOf('/containers') < paths.indexOf('/:orderCode'));
});
