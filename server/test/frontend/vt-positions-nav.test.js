'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions } = require('../../auth/featureRegistry');

const nav = fs.readFileSync(path.join(__dirname, '../../public/shared/shared-nav.js'), 'utf8');

// permissions truyền sẵn trong user (giống /api/auth/me) thì dùng nguyên; không có thì tính từ registry thật.
function sidebarFor(user, url = 'https://tokosi.test/vt-positions/#hn') {
  const dom = new JSDOM('<nav id="sidebar"></nav>', { url, runScripts: 'outside-only' });
  dom.window.eval(nav);
  if (!Array.isArray(user.permissions)) user.permissions = resolvePermissions(user);
  dom.window.TKSNav.renderTopSidebar(dom.window.document.getElementById('sidebar'), 'stockLocations', user);
  return dom;
}

const vtTabs = dom => [...dom.window.document.querySelectorAll('[data-vt-position-tab]')];

test('Quản lý thấy VT Hà Nội / VT Sài Gòn; mục theo hash đang mở được đánh dấu', () => {
  const dom = sidebarFor({ vaiTro: 'Quản lý', branch: 'Cả hai' }, 'https://tokosi.test/vt-positions/#sg');
  assert.deepEqual(vtTabs(dom).map(link => link.dataset.vtPositionTab), ['hn', 'sg']);
  assert.deepEqual(vtTabs(dom).map(link => link.textContent.trim()), ['VT Hà Nội', 'VT Sài Gòn']);
  assert.deepEqual(vtTabs(dom).map(link => link.getAttribute('href')), ['/vt-positions/#hn', '/vt-positions/#sg']);
  assert.deepEqual(vtTabs(dom).map(link => link.getAttribute('aria-current') === 'page' || link.classList.contains('active')), [false, true]);
  dom.window.close();
});

test('Module Vị trí hàng cũ đã gỡ: không còn mục /stock-locations/ hay data-stock-location-tab', () => {
  for (const url of ['https://tokosi.test/vt-positions/#hn', 'https://tokosi.test/stock-locations/#hn']) {
    const dom = sidebarFor({ vaiTro: 'Quản lý', branch: 'Cả hai' }, url);
    const doc = dom.window.document;
    assert.equal(doc.querySelectorAll('[data-stock-location-tab]').length, 0);
    assert.equal([...doc.querySelectorAll('a')].filter(link => /stock-locations/.test(link.getAttribute('href') || '')).length, 0);
    assert.doesNotMatch(doc.getElementById('sidebar').textContent, /Vị trí HN|Vị trí SG/);
    // Nhóm "Vị trí hàng" chỉ còn đúng 2 mục VT.
    const groupLinks = [...doc.querySelectorAll('#tksStockLocationsGroupList a')];
    assert.deepEqual(groupLinks.map(link => link.textContent.trim()), ['VT Hà Nội', 'VT Sài Gòn']);
    dom.window.close();
  }
});

test('VT chỉ hiện tab của cơ sở người dùng', () => {
  for (const [branch, expected] of [['Hà Nội', ['hn']], ['Sài Gòn', ['sg']]]) {
    const dom = sidebarFor({ vaiTro: 'Quản lý', branch });
    assert.deepEqual(vtTabs(dom).map(link => link.dataset.vtPositionTab), expected);
    dom.window.close();
  }
});

test('Menu chỉ dựa vào permissions: có stockLocationsV2.view thì thấy 2 mục VT (kể cả Khách), không có thì ẩn cả nhóm', () => {
  const guest = sidebarFor({ vaiTro: 'Khách', branch: 'Cả hai', permissions: ['stockLocationsV2.view'] });
  assert.deepEqual(vtTabs(guest).map(link => link.dataset.vtPositionTab), ['hn', 'sg']);
  assert.ok(guest.window.document.getElementById('tksStockLocationsGroupList'));
  guest.window.close();
  const guestHn = sidebarFor({ vaiTro: 'Khách', branch: 'Hà Nội', permissions: ['stockLocationsV2.view'] });
  assert.deepEqual(vtTabs(guestHn).map(link => link.dataset.vtPositionTab), ['hn']);
  guestHn.window.close();
  const none = sidebarFor({ vaiTro: 'Khách', branch: 'Cả hai', permissions: [] });
  assert.equal(vtTabs(none).length, 0);
  assert.equal(none.window.document.getElementById('tksStockLocationsGroupList'), null);
  none.window.close();
  // Quyền cũ stockLocations.view không còn mở được mục nào.
  const legacy = sidebarFor({ vaiTro: 'Nhân viên kho', branch: 'Cả hai', permissions: ['stockLocations.view'] });
  assert.equal(vtTabs(legacy).length, 0);
  legacy.window.close();
});

test('Registry thật: mọi vai trò, kể cả Khách, thấy mục VT khi mặc định bật stockLocationsV2.view', () => {
  for (const vaiTro of ['Quản lý', 'Nhân viên kho', 'Khách']) {
    const dom = sidebarFor({ vaiTro, branch: 'Cả hai' });
    assert.deepEqual(vtTabs(dom).map(link => link.dataset.vtPositionTab), ['hn', 'sg'], vaiTro);
    dom.window.close();
  }
});
