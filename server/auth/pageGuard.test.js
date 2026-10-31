'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPageGuard, isPageRequest, legacyPageRedirect } = require('./pageGuard');
const { pageRuleFor } = require('./featureRegistry');
const { ROLES } = require('./userRepository');

function fakeRes() {
  const res = { statusCode: null, redirectedTo: null, headers: {} };
  res.setHeader = (name, value) => { res.headers[name] = value; };
  res.redirect = (code, url) => { res.statusCode = code; res.redirectedTo = url; return res; };
  return res;
}

function fakeReq(path, { token = null } = {}) {
  return { method: 'GET', path, originalUrl: path, cookies: token ? { tks_auth: token } : {} };
}

/** Page guard voi mot tai khoan gia — khong cham Postgres. */
function guardFor(user, overrides = {}) {
  return createPageGuard({
    verifyToken: () => ({ id: 'u1' }),
    findUserById: async () => (user ? { id: 'u1', ...user } : null),
    resolveUser: async storedUser => storedUser,
    ...overrides
  });
}

async function run(guard, req) {
  const res = fakeRes();
  let nextCalled = false;
  await guard(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

test('Sổ quỹ yêu cầu đăng nhập và chặn Sale/Kho/Khách trên mọi đường dẫn HTML', async () => {
  for (const url of ['/cashbook', '/cashbook/', '/cashbook/index.html']) {
    const anonymous = await run(guardFor({ vaiTro: ROLES.QUAN_LY }), fakeReq(url));
    assert.equal(anonymous.nextCalled, false, url);
    assert.equal(anonymous.res.redirectedTo, '/login/?next=' + encodeURIComponent(url));
    for (const [role, target] of [[ROLES.NHAN_VIEN_SALE, '/reports/'],
      [ROLES.NHAN_VIEN_KHO, '/humanresources/'], [ROLES.KHACH, '/humanresources/']]) {
      const denied = await run(guardFor({ vaiTro: role }), fakeReq(url, { token: 'ok' }));
      assert.equal(denied.nextCalled, false, role + ' ' + url);
      assert.equal(denied.res.redirectedTo, target);
      assert.equal(denied.res.headers['Cache-Control'], 'no-store');
    }
  }
});

test('Sổ quỹ cho Quản lý/admin cứng vào và áp dụng cấp hoặc thu hồi quyền riêng', async () => {
  for (const url of ['/cashbook', '/cashbook/', '/cashbook/index.html']) {
    for (const user of [{ vaiTro: ROLES.QUAN_LY }, { username: 'admin', vaiTro: ROLES.KHACH },
      { vaiTro: ROLES.NHAN_VIEN_KHO, featurePermissions: { 'cashbook.view': true } }]) {
      const allowed = await run(guardFor(user), fakeReq(url, { token: 'ok' }));
      assert.equal(allowed.nextCalled, true);
      assert.equal(allowed.res.headers['Cache-Control'], 'no-store');
    }
    const revoked = await run(guardFor({ vaiTro: ROLES.QUAN_LY,
      featurePermissions: { 'cashbook.view': false } }), fakeReq(url, { token: 'ok' }));
    assert.equal(revoked.nextCalled, false);
    assert.equal(revoked.res.redirectedTo, '/reports/');
  }
});

test('isPageRequest chi nhan request dieu huong, bo qua tai nguyen tinh va /api', () => {
  for (const path of ['/', '/reports', '/reports/', '/account/', '/humanresources/', '/index.html']) {
    assert.equal(isPageRequest({ method: 'GET', path }), true, path);
  }
  for (const path of ['/api/auth/me', '/login/', '/register/', '/shared/shared.css',
    '/js/app.js', '/vendor/chart.umd.min.js', '/404.html', '/Logo.jpg', '/health']) {
    assert.equal(isPageRequest({ method: 'GET', path }), false, path);
  }
  assert.equal(isPageRequest({ method: 'POST', path: '/account/' }), false, 'chi gac GET/HEAD');
});

test('chua dang nhap: chuyen ve /login/ kem duong dan quay lai', async () => {
  const { res, nextCalled } = await run(guardFor({ vaiTro: ROLES.QUAN_LY }), fakeReq('/reports/'));
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 302);
  assert.equal(res.redirectedTo, '/login/?next=%2Freports%2F');
});

test('trang Vị trí hàng cũ /stock-locations chuyển hướng sang /vt-positions/ trên mọi đường dẫn HTML, kể cả khi chưa đăng nhập', async () => {
  for (const url of ['/stock-locations', '/stock-locations/', '/stock-locations/index.html', '/Stock-Locations/']) {
    for (const withToken of [false, true]) {
      const { res, nextCalled } = await run(legacyPageRedirect, fakeReq(url, withToken ? { token: 'ok' } : {}));
      assert.equal(nextCalled, false, url);
      assert.equal(res.statusCode, 302, url);
      assert.equal(res.redirectedTo, '/vt-positions/', url);
      assert.equal(res.headers['Cache-Control'], 'no-store');
    }
    const head = await run(legacyPageRedirect, { ...fakeReq(url), method: 'HEAD' });
    assert.equal(head.res.redirectedTo, '/vt-positions/');
  }
  // Tài nguyên tĩnh cũ, trang khác và POST không bị chuyển hướng.
  for (const req of [fakeReq('/stock-locations/stock-locations.js'), fakeReq('/stock-locationsx/'), fakeReq('/vt-positions/'),
    fakeReq('/api/stock-locations'), { ...fakeReq('/stock-locations/'), method: 'POST' }]) {
    const { res, nextCalled } = await run(legacyPageRedirect, req);
    assert.equal(nextCalled, true, req.path);
    assert.equal(res.redirectedTo, null);
  }
});

test('trang Vị trí hàng cũ không còn quy tắc quyền: pageGuard bỏ qua, việc chuyển hướng do legacyPageRedirect lo', async () => {
  assert.equal(pageRuleFor('/stock-locations/'), null);
  const staff = await run(guardFor({ vaiTro: ROLES.QUAN_LY }), fakeReq('/stock-locations/', { token: 'ok' }));
  assert.equal(staff.nextCalled, true);
  assert.equal(staff.res.redirectedTo, null);
});

test('VT Hà Nội / VT Sài Gòn page: cần đăng nhập, mọi vai trò kể cả Khách vào được, Quản lý tắt quyền xem từng tài khoản thì bị chặn', async () => {
  for (const url of ['/vt-positions', '/vt-positions/', '/vt-positions/index.html']) {
    const anonymous = await run(guardFor({ vaiTro: ROLES.QUAN_LY }), fakeReq(url));
    assert.equal(anonymous.nextCalled, false);
    assert.match(anonymous.res.redirectedTo, /^\/login\//);
    for (const role of Object.values(ROLES)) {
      const allowed = await run(guardFor({ vaiTro: role }), fakeReq(url, { token: 'ok' }));
      assert.equal(allowed.nextCalled, true, role + ' ' + url);
      const revoked = await run(guardFor({ vaiTro: role, featurePermissions: { 'stockLocationsV2.view': false } }), fakeReq(url, { token: 'ok' }));
      assert.equal(revoked.nextCalled, false, role + ' ' + url);
      assert.match(revoked.res.redirectedTo, /^\/(reports|humanresources|shipment|account)\//);
    }
  }
});

test('token hong: chuyen ve /login/', async () => {
  const guard = guardFor({ vaiTro: ROLES.QUAN_LY }, {
    verifyToken: () => { throw new Error('bad token'); }
  });
  const { res } = await run(guard, fakeReq('/reports/', { token: 'rac' }));
  assert.equal(res.statusCode, 302);
  assert.match(res.redirectedTo, /^\/login\//);
});

test('du quyen: cho qua va dat Cache-Control no-store', async () => {
  const guard = guardFor({ vaiTro: ROLES.QUAN_LY, trangThai: 'Đang hoạt động' });
  const { res, nextCalled } = await run(guard, fakeReq('/reports/', { token: 'ok' }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('thieu quyen: chuyen toi trang dau tien tai khoan vao duoc', async () => {
  const guest = guardFor({ vaiTro: ROLES.KHACH, trangThai: 'Đang hoạt động' });
  const { res } = await run(guest, fakeReq('/reports/', { token: 'ok' }));
  assert.equal(res.statusCode, 302);
  assert.equal(res.redirectedTo, '/humanresources/', 'Khách được xem Quy định công ty và Nghỉ phép');

  const accountant = guardFor({ vaiTro: ROLES.KE_TOAN, trangThai: 'Đang hoạt động' });
  const { res: res2 } = await run(accountant, fakeReq('/', { token: 'ok' }));
  assert.equal(res2.redirectedTo, null, 'Ke toan co bang Du kien hang ve nen "/" (trang bao cao) mo duoc');

  const { nextCalled } = await run(accountant, fakeReq('/humanresources/', { token: 'ok' }));
  assert.equal(nextCalled, true, 'Ke toan van vao duoc trang nhan su');
});

test('Nhan vien sale va marketing vao duoc trang bao cao theo quyen rieng', async () => {
  const sale = guardFor({ vaiTro: ROLES.NHAN_VIEN_SALE, trangThai: 'Đang hoạt động' });
  const saleResult = await run(sale, fakeReq('/reports/', { token: 'ok' }));
  assert.equal(saleResult.nextCalled, true);
  const saleRoot = await run(sale, fakeReq('/', { token: 'ok' }));
  assert.equal(saleRoot.nextCalled, true, '"/" cung phuc vu trang bao cao');

  const marketing = guardFor({ vaiTro: ROLES.NHAN_VIEN_MARKETING, trangThai: 'Đang hoạt động' });
  const marketingResult = await run(marketing, fakeReq('/reports/', { token: 'ok' }));
  assert.equal(marketingResult.nextCalled, true);
});

test('ghi de quyen theo tai khoan co hieu luc ngay o page guard', async () => {
  const guard = guardFor({
    vaiTro: ROLES.KE_TOAN,
    trangThai: 'Đang hoạt động',
    featurePermissions: { 'reports.overview': true }
  });
  const { nextCalled } = await run(guard, fakeReq('/reports/', { token: 'ok' }));
  assert.equal(nextCalled, true);
});

test('trang khong nam trong bang PAGE_FEATURES thi khong bi gac', async () => {
  const guard = guardFor({ vaiTro: ROLES.KHACH, trangThai: 'Đang hoạt động' });
  const { nextCalled } = await run(guard, fakeReq('/trang-la/', { token: 'ok' }));
  assert.equal(nextCalled, true);
});

test('loi DB/HR (5xx): CHO QUA — su co ha tang khong duoc lam chet ca site', async () => {
  const guard = guardFor(null, {
    findUserById: async () => { throw new Error('Postgres khong ket noi duoc'); }
  });
  const { res, nextCalled } = await run(guard, fakeReq('/reports/', { token: 'ok' }));
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('tai khoan khong con ton tai: chuyen ve /login/', async () => {
  const guard = guardFor(null, { findUserById: async () => null });
  const { res } = await run(guard, fakeReq('/account/', { token: 'ok' }));
  assert.equal(res.statusCode, 302);
  assert.match(res.redirectedTo, /^\/login\//);
});
