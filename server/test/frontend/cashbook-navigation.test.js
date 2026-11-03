'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const registry = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const navSource = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const accountHtml = fs.readFileSync(path.join(publicDir, 'account/index.html'), 'utf8');

function sidebar(t, user, url = '/cashbook/') {
  const dom = new JSDOM('<nav id="sidebar"></nav>', {
    runScripts: 'outside-only', url: 'https://tokosi.test' + url
  });
  t.after(() => dom.window.close());
  dom.window.eval(navSource);
  const mount = dom.window.document.getElementById('sidebar');
  dom.window.TKSNav.renderTopSidebar(mount, 'accounting', {
    ...user, permissions: registry.resolvePermissions(user)
  });
  return mount;
}

test('Sổ quỹ là mục con của nhóm Kế toán và đang active trên trang quỹ', t => {
  const mount = sidebar(t, { vaiTro: 'Quản lý', branch: 'Cả hai' });
  const link = mount.querySelector('a[href="/cashbook/"]');
  assert.ok(link, 'phải có liên kết Sổ quỹ');
  assert.equal(link.textContent, 'Sổ quỹ');
  const group = link.closest('.nav-group');
  assert.ok(group, 'mục nằm trong nhóm con');
  assert.equal(group.querySelector('[data-tks-nav-group]').dataset.tksNavGroup, 'accounting');
  assert.ok(group.querySelector('[data-tks-nav-group]').classList.contains('has-active'));
  assert.ok(link.classList.contains('nav-item'));
  assert.ok(link.classList.contains('active'));
  assert.equal(link.getAttribute('aria-current'), 'page');
  assert.ok(link.querySelector('svg.ic'));
});

test('Sổ quỹ không còn là mục cấp 1 trên sidebar', t => {
  const mount = sidebar(t, { vaiTro: 'Quản lý', branch: 'Cả hai' });
  assert.equal(mount.querySelector(':scope > a[href="/cashbook/"]'), null);
});

test('tài khoản chỉ được cấp riêng quyền Sổ quỹ vẫn thấy nhóm Kế toán chứa Sổ quỹ', t => {
  const mount = sidebar(t, { vaiTro: 'Nhân viên kho', featurePermissions: { 'cashbook.view': true } });
  const link = mount.querySelector('a[href="/cashbook/"]');
  assert.ok(link);
  assert.equal(link.closest('.nav-group').querySelector('[data-tks-nav-group]').dataset.tksNavGroup, 'accounting');
});

test('sidebar Sổ quỹ ẩn với Sale/Kho/Khách và khi Quản lý bị thu hồi quyền xem', t => {
  for (const user of [{ vaiTro: 'Nhân viên sale' }, { vaiTro: 'Nhân viên kho' }, { vaiTro: 'Khách' },
    { vaiTro: 'Quản lý', featurePermissions: { 'cashbook.view': false } }]) {
    const mount = sidebar(t, user);
    assert.equal(mount.querySelector('a[href="/cashbook/"]'), null, user.vaiTro);
  }
});

test('Sổ quỹ không phụ thuộc cơ sở, chỉ active đúng đường dẫn và giữ quyền cấp riêng', t => {
  for (const branch of ['Hà Nội', 'Sài Gòn', 'Cả hai']) {
    const mount = sidebar(t, { vaiTro: 'Nhân viên kho', branch,
      featurePermissions: { 'cashbook.view': true } }, '/humanresources/');
    const link = mount.querySelector('a[href="/cashbook/"]');
    assert.ok(link, branch);
    assert.equal(link.classList.contains('active'), false);
    assert.equal(link.hasAttribute('aria-current'), false);
  }
  for (const url of ['/cashbook', '/cashbook/index.html']) {
    assert.ok(sidebar(t, { vaiTro: 'Quản lý' }, url).querySelector('a[href="/cashbook/"].active'));
  }
});

test('admin cứng vẫn thấy Sổ quỹ khi ghi đè quyền xem thành false', t => {
  const mount = sidebar(t, { username: 'admin', vaiTro: 'Khách',
    featurePermissions: { 'cashbook.view': false } });
  assert.ok(mount.querySelector('a[href="/cashbook/"]'));
});

test('trang phân quyền hiện nhóm Sổ quỹ sau HR và khóa quyền chốt khi tắt quyền xem', async t => {
  const dom = new JSDOM(accountHtml, { runScripts: 'outside-only', url: 'https://tokosi.test/account/#users' });
  t.after(() => dom.window.close());
  const { window } = dom;
  window.TKSNav = {
    authGuard: async () => ({ id: 'manager', vaiTro: 'Quản lý', permissions: registry.defaultsForRole('Quản lý') }),
    can: () => true, renderTopSidebar() {}, renderAccountChip() {}, logout() {}
  };
  window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ users: [] }) });
  for (const match of accountHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    if (match[1].trim()) window.eval(match[1]);
  }
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  window.renderPermissionsForm({ groups: registry.FEATURE_GROUPS, features: registry.FEATURES }, {
    vaiTro: 'Quản lý', defaults: registry.defaultsForRole('Quản lý'), overrides: {}
  });
  const doc = window.document;
  const titles = [...doc.querySelectorAll('.perm-group-title')].map(el => el.textContent);
  assert.equal(titles[titles.indexOf('Quản lý nhân sự') + 1], 'Sổ quỹ');
  const view = doc.querySelector('[data-feature="cashbook.view"]');
  assert.ok(view);
  assert.equal(view.dataset.default, '1');
  assert.equal(doc.querySelector('[data-feature="cashbook.manage"]'), null);
  const lifecycle = doc.querySelector('[data-feature="shipment.lifecycle"]');
  lifecycle.value = 'deny';
  lifecycle.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(doc.querySelector('[data-feature="shipment.export"]').title,
    'Cần bật Vòng đời đơn hàng (toàn bộ đơn) trước');
});
