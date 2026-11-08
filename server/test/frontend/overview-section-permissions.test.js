'use strict';

// Tab Tong quan co 4 muc; muc 4 (Kiem tra dut hang + nhap Tra NCC) goi cac API duoi
// /api/products can quyen Hang hoa (reports.products). Nguoi chi co quyen Tong quan
// (reports.overview) nen muc 4 phai bi AN va khong duoc goi /import-status (se 403).
// (Nhan vien sale mac dinh co du cac tab xem — 5 tab tu 2026-10-02, them Bao cao kinh doanh 2026-10-07 —
// nen test dung quyen rut bot reports.products.)
// Chay trang that trong JSDOM voi TKSNav/fetch gia.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { defaultsForRole } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function createPage(vaiTro, withoutKeys = [], hash = 'overview', historyLoaded = false) {
  const permissions = defaultsForRole(vaiTro).filter(key => !withoutKeys.includes(key));
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/#' + hash });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; }
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => callback();
  dom.window.TKSNav = {
    getPermissions: () => permissions,
    authGuard: () => Promise.resolve({ vaiTro, branches: ['Hà Nội', 'Sài Gòn', 'Cả hai'], permissions }),
    can: (...keys) => keys.some(key => permissions.includes(key)),
    handleBranchError: () => false,
    renderTopSidebar() {}
  };

  const urls = [];
  dom.window.fetch = url => {
    urls.push(String(url));
    if (historyLoaded && String(url).startsWith('/api/inventory-value-history')) {
      return Promise.resolve({ ok: true, json: async () => ({ rows: [] }) });
    }
    if (String(url).includes('/supplier-returns/import-status')) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ statuses: [] }) });
    }
    return new Promise(() => {}); // cac API con lai khong can tra loi trong test nay
  };

  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim())
    .forEach(script => dom.window.eval(script));
  return { dom, urls, section: () => dom.window.document.getElementById('overviewStockoutSection') };
}

test('muc 4 Tong quan co id de an/hien theo quyen', () => {
  assert.match(html, /<section class="section" id="overviewStockoutSection">/);
});

test('Overview boot does not fetch the product report; switching repeatedly deduplicates pending loads', async () => {
  const page = createPage('Quản lý');
  try {
    await settle();
    assert.equal(page.urls.some(url => url.split('?')[0] === '/api/product-report'), false);
    assert.equal(page.urls.filter(url => url.startsWith('/api/inventory-value-history')).length, 1);
    for (let i = 0; i < 3; i++) {
      page.dom.window.eval("switchView('products'); switchView('overview')");
    }
    await settle();
    assert.equal(page.urls.filter(url => url.split('?')[0] === '/api/product-report').length, 1);
    assert.equal(page.urls.filter(url => url.startsWith('/api/inventory-value-history')).length, 1);
  } finally { page.dom.window.close(); }
});

test('Direct products boot only fetches its sources; overview auxiliaries wait for overview', async () => {
  const page = createPage('Quản lý', [], 'products');
  try {
    await settle();
    assert.equal(page.urls.filter(url => url.split('?')[0] === '/api/product-report').length, 1);
    assert.equal(page.urls.some(url => url.startsWith('/api/inventory-value-history')), false);
    assert.equal(page.urls.some(url => url.includes('/supplier-returns/import-status')), false);
    page.dom.window.eval("switchView('overview')");
    await settle();
    assert.equal(page.urls.filter(url => url.startsWith('/api/inventory-value-history')).length, 1);
    assert.equal(page.urls.filter(url => url.includes('/supplier-returns/import-status')).length, 1);
  } finally { page.dom.window.close(); }
});

test('Loaded history is reused and missing report permissions prevent requests', async () => {
  const page = createPage('Quản lý', ['reports.products'], 'overview', true);
  try {
    await settle();
    page.dom.window.eval("switchView('products'); switchView('overview'); switchView('overview')");
    await settle();
    assert.equal(page.urls.some(url => url.split('?')[0] === '/api/product-report'), false);
    assert.equal(page.urls.filter(url => url.startsWith('/api/inventory-value-history')).length, 1);
  } finally { page.dom.window.close(); }
  const restricted = createPage('Quản lý', ['reports.overview'], 'products');
  try {
    await settle();
    restricted.dom.window.eval("switchView('overview'); loadInventoryHistory()");
    assert.equal(restricted.urls.some(url => url.startsWith('/api/inventory-value-history')), false);
  } finally { restricted.dom.window.close(); }
});

test('Người không có quyền Hàng hóa (chỉ Tổng quan): ẩn mục 4 và không gọi API nhập Trả NCC', async () => {
  const page = createPage('Nhân viên sale', ['reports.products']);
  await settle();
  assert.equal(page.section().hidden, true);
  assert.equal(page.urls.some(url => url.includes('/api/products/')), false, 'khong goi API duoi /api/products');
  page.dom.window.close();
});

test('Nhân viên sale (mặc định có quyền Hàng hóa): hiện mục 4', async () => {
  const page = createPage('Nhân viên sale');
  await settle();
  assert.equal(page.section().hidden, false);
  page.dom.window.close();
});

test('Quản lý (có quyền Hàng hóa): hiện mục 4 và nạp trạng thái nhập Trả NCC như cũ', async () => {
  const page = createPage('Quản lý');
  await settle();
  assert.equal(page.section().hidden, false);
  assert.ok(page.urls.some(url => url.includes('/api/products/supplier-returns/import-status')));
  page.dom.window.close();
});
