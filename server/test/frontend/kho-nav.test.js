'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions } = require('../../auth/featureRegistry');

const nav = fs.readFileSync(path.join(__dirname, '../../public/shared/shared-nav.js'), 'utf8');

function sidebarFor(user, url = 'https://tokosi.test/kho-hn/') {
  const dom = new JSDOM('<nav id="sidebar"></nav>', { url, runScripts: 'outside-only' });
  dom.window.eval(nav);
  if (!Array.isArray(user.permissions)) user.permissions = resolvePermissions(user);
  dom.window.TKSNav.renderTopSidebar(dom.window.document.getElementById('sidebar'), 'stockLocations', user);
  return dom;
}

const khoTabs = dom => [...dom.window.document.querySelectorAll('[data-kho-tab]')];
const groupLabels = dom => [...dom.window.document.querySelectorAll('#tksStockLocationsGroupList a')].map(link => link.textContent.trim());

test('Quản lý thấy Kho Hà Nội / Kho Sài Gòn, xen giữa VT Hà Nội/VT Sài Gòn và Kiểm kê', () => {
  const dom = sidebarFor({ vaiTro: 'Quản lý', branch: 'Cả hai' });
  assert.deepEqual(khoTabs(dom).map(link => link.dataset.khoTab), ['hn', 'sg']);
  assert.deepEqual(khoTabs(dom).map(link => link.textContent.trim()), ['Kho Hà Nội', 'Kho Sài Gòn']);
  assert.deepEqual(khoTabs(dom).map(link => link.getAttribute('href')), ['/kho-hn/', '/kho-sg/']);
  assert.deepEqual(groupLabels(dom), ['VT Hà Nội', 'Kho Hà Nội', 'VT Sài Gòn', 'Kho Sài Gòn', 'Kiểm kê']);
  dom.window.close();
});

test('Mọi vai trò, kể cả Khách, thấy cả hai mục Kho khi mặc định có stockLocationsV2.view', () => {
  for (const vaiTro of ['Quản lý', 'Nhân viên kho', 'Khách']) {
    const dom = sidebarFor({ vaiTro, branch: 'Cả hai' });
    assert.deepEqual(khoTabs(dom).map(link => link.dataset.khoTab), ['hn', 'sg'], vaiTro);
    dom.window.close();
  }
});

test('Kho chỉ hiện mục của cơ sở người dùng, giống VT', () => {
  for (const [branch, expected] of [['Hà Nội', ['hn']], ['Sài Gòn', ['sg']]]) {
    const dom = sidebarFor({ vaiTro: 'Khách', branch });
    assert.deepEqual(khoTabs(dom).map(link => link.dataset.khoTab), expected, branch);
    dom.window.close();
  }
});

test('Mục Kho được đánh dấu theo trang đang mở', () => {
  const cases = [
    ['https://tokosi.test/kho-hn/', [true, false]],
    ['https://tokosi.test/kho-sg/', [false, true]],
    ['https://tokosi.test/vt-positions/#hn', [false, false]]
  ];
  for (const [url, expected] of cases) {
    const dom = sidebarFor({ vaiTro: 'Quản lý', branch: 'Cả hai' }, url);
    const active = khoTabs(dom).map(link => link.getAttribute('aria-current') === 'page' || link.classList.contains('active'));
    assert.deepEqual(active, expected, url);
    dom.window.close();
  }
});

test('Không có stockLocationsV2.view thì ẩn mục Kho; stockLocations.view cũ không mở được', () => {
  for (const permissions of [[], ['stockLocations.view']]) {
    const dom = sidebarFor({ vaiTro: 'Khách', branch: 'Cả hai', permissions });
    assert.equal(khoTabs(dom).length, 0);
    dom.window.close();
  }
  const only = sidebarFor({ vaiTro: 'Khách', branch: 'Cả hai', permissions: ['stockLocationsV2.view'] });
  assert.deepEqual(groupLabels(only), ['VT Hà Nội', 'Kho Hà Nội', 'VT Sài Gòn', 'Kho Sài Gòn']);
  only.window.close();
});
