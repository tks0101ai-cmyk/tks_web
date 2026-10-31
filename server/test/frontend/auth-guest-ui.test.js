'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

function readPublic(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'public', relativePath), 'utf8');
}

function inlineScripts(html) {
  return [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
}

function loadPageWithSharedStyles(relativePath) {
  const sharedCss = readPublic('shared/shared.css');
  const html = readPublic(relativePath).replace(
    /<link[^>]+shared\.css[^>]*>/i,
    `<style>${sharedCss}</style>`
  );
  return new JSDOM(html, { runScripts: 'outside-only' });
}

test('login co nut dang ky rieng va giu nut Google', () => {
  const html = readPublic('login/index.html');
  assert.match(html, /href="\/register\/"/);
  assert.match(html, /googleBtnWrap/);
});

test('trang dang ky va trang account co script inline hop le', () => {
  for (const page of ['register/index.html', 'account/index.html']) {
    const html = readPublic(page);
    inlineScripts(html).forEach(script => assert.doesNotThrow(() => new Function(script)));
  }
});

// shared-nav.js khong con mang vai tro nao: menu va dieu huong deu dua tren
// `permissions` + `pageFeatures` do /api/auth/me tra ve (nguon:
// server/auth/featureRegistry.js). Cac test duoi day nap script that trong
// jsdom thay vi do chuoi nguon.
const { PAGE_FEATURES } = require('../../auth/featureRegistry');
const { defaultsForRole } = require('../../auth/featureRegistry');

function loadSharedNav(url) {
  const dom = new JSDOM(
    '<html><body><header><div id="accountChip"></div></header><div id="sidebar" data-tks-active-top="reports"></div></body></html>',
    { runScripts: 'outside-only', url }
  );
  dom.window.eval(readPublic('shared/shared-nav.js'));
  return dom;
}

test('shared JSON cache coalesces reads, expires, bounds memory and isolates auth changes', async () => {
  const dom = loadSharedNav('https://tokosi.example/');
  const nav = dom.window.TKSNav;
  let now = 1000;
  let calls = 0;
  let fail = false;
  dom.window.Date.now = () => now;
  dom.window.fetch = async () => ({ ok: !fail, status: fail ? 500 : 200, json: async () => ({ call: ++calls }) });
  const user = { id: 'a', username: 'one', permissions: ['x', 'y'] };
  nav.setPermissions(user);
  const [first, concurrent] = await Promise.all([nav.readCachedJSON('/cont'), nav.readCachedJSON('/cont')]);
  assert.equal(first, concurrent);
  assert.equal(calls, 1);
  nav.setPermissions({ ...user, permissions: ['y', 'x'] });
  assert.equal(await nav.readCachedJSON('/cont'), first);
  now += 60001;
  await nav.readCachedJSON('/cont');
  assert.equal(calls, 2);
  fail = true;
  await nav.readCachedJSON('/failure');
  await nav.readCachedJSON('/failure');
  assert.equal(calls, 4);
  fail = false;
  for(let i = 0; i < 101; i++) await nav.readCachedJSON('/bounded/' + i);
  const before = calls;
  await nav.readCachedJSON('/cont');
  assert.equal(calls, before + 1);
  nav.setPermissions({ ...user, permissions: ['x'] });
  await nav.readCachedJSON('/cont');
  assert.equal(calls, before + 2);
  nav.setPermissions({ ...user, permissions: ['x'], coSo: 'Hà Nội' });
  await nav.readCachedJSON('/cont');
  assert.equal(calls, before + 3);
  nav.clearCachedJSON();
  await nav.readCachedJSON('/cont');
  assert.equal(calls, before + 4);
  let release;
  dom.window.fetch = () => new Promise(resolve => { release = resolve; });
  const stale = nav.readCachedJSON('/pending');
  await Promise.resolve();
  nav.setPermissions({ ...user, id: 'b' });
  release({ ok: true, status: 200, json: async () => ({ secret: true }) });
  await assert.rejects(stale, /AUTH_SCOPE_CHANGED/);
  dom.window.close();
});

test('shared nav khong con mang vai tro cung — menu dung tu danh sach quyen', () => {
  const script = readPublic('shared/shared-nav.js');
  assert.doesNotThrow(() => new Function(script));
  assert.doesNotMatch(script, /NO_REPORTS_ROLES/);
  assert.doesNotMatch(script, /NO_SHIPMENT_ROLES/);
  assert.doesNotMatch(script, /'Nhân viên mua hàng'/);
  assert.match(script, /TKSNav\.can/);
});

test('sidebar của Khách chỉ có VT Hà Nội / VT Sài Gòn, Hồ sơ, Quy định công ty và Nghỉ phép', () => {
  const dom = loadSharedNav('https://tokosi.example/account/');
  const { window } = dom;
  const sidebar = window.document.getElementById('sidebar');
  window.TKSNav.renderTopSidebar(sidebar, 'account', {
    vaiTro: 'Khách',
    permissions: defaultsForRole('Khách'),
    pageFeatures: PAGE_FEATURES
  });

  assert.doesNotMatch(sidebar.innerHTML, /Báo cáo tổng hợp/);
  assert.match(sidebar.innerHTML, /Quản lý nhân sự/);
  assert.match(sidebar.innerHTML, /Quy định công ty/);
  assert.match(sidebar.innerHTML, /Nghỉ phép/);
  assert.deepEqual([...sidebar.querySelectorAll('a')].map(a => a.getAttribute('href')),
    ['/vt-positions/#hn', '/vt-positions/#sg', '/humanresources/#quydinh', '/humanresources/#leave', '/account/#profile']);
  assert.match(sidebar.innerHTML, /VT Hà Nội/);
  assert.match(sidebar.innerHTML, /VT Sài Gòn/);
  assert.doesNotMatch(sidebar.innerHTML, /stock-locations/);
  assert.doesNotMatch(sidebar.innerHTML, /Quản lý người dùng/);
  assert.doesNotMatch(sidebar.innerHTML, /Vòng đời đơn hàng/);
  assert.match(sidebar.innerHTML, /Quản lý hồ sơ/);
});

test('PAGE_FEATURES: Khách vào được Tài khoản và Nhân sự, không vào báo cáo hoặc vận đơn', () => {
  const dom = loadSharedNav('https://tokosi.example/account/');
  const { window } = dom;
  window.TKSNav.setPermissions({ permissions: defaultsForRole('Khách'), pageFeatures: PAGE_FEATURES });

  const allowed = pathname => {
    const rule = window.TKSNav._pageRuleFor(pathname);
    return !rule || window.TKSNav.can(rule.anyOf);
  };

  assert.equal(allowed('/account/'), true);
  assert.equal(allowed('/account/index.html'), true);
  assert.equal(allowed('/shipment/lifecycle/'), false);

  assert.equal(allowed('/'), false);
  assert.equal(allowed('/index.html'), false);
  assert.equal(allowed('/reports/'), false);
  assert.equal(allowed('/humanresources/'), true);

  assert.equal(window.TKSNav._landingPath(), '/humanresources/');
});

test('trang bao cao duoc phuc vu o ca "/" lan "/reports/" nen ca hai cung mot quy tac quyen', () => {
  const dom = loadSharedNav('https://tokosi.example/');
  const { window } = dom;
  window.TKSNav.setPermissions({ permissions: defaultsForRole('Kế toán'), pageFeatures: PAGE_FEATURES });

  for (const pathname of ['/', '/index.html', '/reports', '/reports/']) {
    const rule = window.TKSNav._pageRuleFor(pathname);
    assert.ok(rule, `${pathname} phai co quy tac quyen`);
    assert.equal(rule.path, '/reports', pathname);
    // Tu 2026-10-20 Ke toan co reports.products.expected (bang Du kien hang ve) nen vao duoc trang bao cao (chi tab Hang hoa).
    assert.equal(window.TKSNav.can(rule.anyOf), true, `Kế toán xem được ${pathname} nhờ reports.products.expected`);
  }

  for (const pathname of ['/account', '/humanresources', '/shipment/lifecycle']) {
    assert.notEqual(window.TKSNav._pageRuleFor(pathname).path, '/reports', pathname);
  }

  // Tro ly co quyen bao cao -> vao duoc chinh trang do.
  window.TKSNav.setPermissions({ permissions: defaultsForRole('Trợ lý'), pageFeatures: PAGE_FEATURES });
  assert.equal(window.TKSNav.can(window.TKSNav._pageRuleFor('/').anyOf), true);
});

test('shared nav logout co xac nhan confirm va khong de nut dang xuat roi rac tren topbar', () => {
  const script = readPublic('shared/shared-nav.js');
  assert.match(script, /confirm\(['"]Bạn có chắc chắn muốn đăng xuất\?['"]\)/);
  assert.doesNotMatch(script, /<button type="button" class="logout-btn-standalone" id="tksLogoutBtn">Đăng xuất<\/button>/);
  assert.match(script, /id="tksProfileLogout"/);
});

test('trang account co khoi va nut dang xuat trong tab ho so ca nhan', () => {
  const html = readPublic('account/index.html');
  assert.match(html, /id="btnAccountLogout"/);
  assert.match(html, /handleLogout\(\)/);
  assert.match(html, /function handleLogout/);
});

test('cac trang login, register, account co nut an hien mat khau password-toggle-btn', () => {
  for (const page of ['login/index.html', 'register/index.html', 'account/index.html']) {
    const html = readPublic(page);
    assert.match(html, /password-toggle-btn/);
    assert.match(html, /togglePassword/);
  }
});

test('trang register chi cho phep dang ky bang email', () => {
  const html = readPublic('register/index.html');
  const dom = new JSDOM(html);
  const document = dom.window.document;
  assert.ok(document.querySelector('#email'));
  assert.equal(document.querySelector('#tabRegisterPhone'), null);
  assert.equal(document.querySelector('#fieldPhoneWrap'), null);
  assert.equal(document.querySelector('#soDienThoai'), null);
});

test('trang login co banner dem nguoc lockout 5 phut va modal reset mat khau OTP', () => {
  const html = readPublic('login/index.html');
  assert.match(html, /id="loginLockoutAlert"/);
  assert.match(html, /id="lockoutCountdown"/);
  assert.match(html, /id="forgotPasswordModal"/);
  assert.match(html, /Quên mật khẩu\?/);
  assert.match(html, /api\/auth\/forgot-password/);
});

test('trang account co khu vuc thong tin khoi phuc voi mat khau xac nhan', () => {
  const html = readPublic('account/index.html');
  assert.match(html, /Thông tin khôi phục/);
  assert.match(html, /id="profRecoveryEmail"/);
  assert.match(html, /id="recoveryConfirmPass"/);
  assert.match(html, /handleSaveRecovery/);
});

test('dong bo logo cong ty va favicon tren tat ca cac trang/tab', () => {
  const pages = [
    'index.html',
    'login/index.html',
    'register/index.html',
    'account/index.html'
  ];
  for (const page of pages) {
    const html = readPublic(page);
    assert.match(html, /<link rel="icon" type="image\/jpeg" href="\/Logo\.jpg">/, `Trang ${page} thieu favicon Logo.jpg`);
    assert.match(html, /<img [^>]*src="\/Logo\.jpg"/, `Trang ${page} thieu anh logo Logo.jpg`);
  }
});

test('header dung chung co cung kich thuoc dieu khien tren bon tab chinh', () => {
  const pages = ['index.html', 'humanresources/index.html', 'account/index.html'];

  for (const page of pages) {
    const dom = loadPageWithSharedStyles(page);
    const { document } = dom.window;
    const profile = document.createElement('button');
    profile.className = 'profile-trigger';
    document.querySelector('#accountChip').appendChild(profile);

    const themeStyle = dom.window.getComputedStyle(document.querySelector('.theme-toggle'));
    const profileStyle = dom.window.getComputedStyle(profile);
    const brandStyle = dom.window.getComputedStyle(document.querySelector('.brand-mark'));

    assert.equal(themeStyle.minHeight, '40px', `${page}: nut theme sai chieu cao`);
    assert.equal(themeStyle.borderRadius, '9999px', `${page}: nut theme sai bo goc`);
    assert.equal(profileStyle.minHeight, '40px', `${page}: nut ho so sai chieu cao`);
    assert.equal(profileStyle.borderRadius, '10px', `${page}: nut ho so sai bo goc`);
    assert.equal(brandStyle.width, '44px', `${page}: logo sai chieu rong`);
    assert.equal(brandStyle.height, '44px', `${page}: logo sai chieu cao`);
    assert.equal(brandStyle.borderRadius, '12px', `${page}: logo sai bo goc`);
  }
});

test('ba tab chinh cung khai bao viewport de header responsive giong nhau', () => {
  const pages = ['index.html', 'humanresources/index.html', 'account/index.html'];

  for (const page of pages) {
    const dom = new JSDOM(readPublic(page));
    const viewport = dom.window.document.querySelector('meta[name="viewport"]');
    assert.ok(viewport, `${page}: thieu viewport meta`);
    assert.equal(viewport.getAttribute('content'), 'width=device-width, initial-scale=1');
  }
});



test('self-only HR guest sees the leave navigation link', () => {
  const dom = loadSharedNav('https://tokosi.example/account/');
  try {
    const sidebar = dom.window.document.getElementById('sidebar');
    dom.window.TKSNav.renderTopSidebar(sidebar, 'account', { vaiTro: 'Khách', permissions: ['account.profile', 'hr.leave.submit'], pageFeatures: PAGE_FEATURES });
    assert.ok(sidebar.querySelector('a[href="/humanresources/#leave"]'));
  } finally { dom.window.close(); }
});
