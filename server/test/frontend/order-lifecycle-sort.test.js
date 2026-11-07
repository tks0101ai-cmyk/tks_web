'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// TKSNav that dung TKSNav.can(<quyen>) (nguon: user.permissions tu /api/auth/me)
// thay cho kiem tra vai tro cung — mock phai co ham do, lay dung quyen mac dinh
// cua vai tro tu server/auth/featureRegistry.js.
const { defaultsForRole } = require('../../auth/featureRegistry');
const { lifecycleResponse, isListUrl } = require('./lifecycleFakeServer');
function fakeCan(vaiTro) {
  const permissions = defaultsForRole(vaiTro);
  return (...keys) => keys.some(key => (Array.isArray(key) ? key : [key]).some(k => permissions.includes(k)));
}


const htmlPath = path.join(__dirname, '..', '..', 'public', 'shipment', 'lifecycle', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

function inlineScripts(source) {
  return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
}

async function settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }

// Mac dinh (chua chon cot) may chu sap theo thoi gian dat hang MOI NHAT truoc; dong khong co ngay dat giu thu tu goc.
const ORDERS = [
  { orderCode: 'B002', branch: 'HN', saleName: 'Bình', customerName: 'Yến', summary: { code: 'DELIVERING', label: 'Đang giao', at: '02/09/2026 09:00' } },
  { orderCode: 'A001', branch: 'HN', saleName: 'An', customerName: 'Xuân', summary: { code: 'DELIVERED', label: 'Đã giao', at: '01/09/2026 09:00' } }
];

async function renderLifecycleTable() {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://tokosi.example/shipment/lifecycle/'
  });
  const { window } = dom;
  window.setInterval = () => 1;
  window.TKSNav = {
    authGuard: () => Promise.resolve({ vaiTro: 'Quản lý' }),
    can: fakeCan('Quản lý'),
    handleBranchError: () => false
  };
  window.fetch = async url => {
    if (!isListUrl(url)) return { ok: false, status: 404, json: async () => ({}) };
    const body = lifecycleResponse(String(url), ORDERS, { ok: true });
    return { ok: true, json: async () => body };
  };

  window.eval(fs.readFileSync(path.join(__dirname, '../../public/shared/table-controls.js'), 'utf8'));
  inlineScripts(html).forEach(script => window.eval(script));
  await settle();
  return dom;
}

function visibleOrderCodes(document) {
  return [...document.querySelectorAll('#bulkBody tr')].map(row => row.cells[0].textContent);
}

test('nhan lan thu ba vao cung ten cot se bo sap xep va tra ve thu tu mac dinh', async () => {
  const dom = await renderLifecycleTable();
  const { document } = dom.window;
  const orderCodeHeader = document.querySelector('th[data-sort="orderCode"]');

  orderCodeHeader.click();
  await settle();
  assert.deepEqual(visibleOrderCodes(document), ['A001', 'B002']);

  orderCodeHeader.click();
  await settle();
  assert.deepEqual(visibleOrderCodes(document), ['B002', 'A001']);

  orderCodeHeader.click();
  await settle();
  assert.deepEqual(visibleOrderCodes(document), ['B002', 'A001']);
  assert.equal(orderCodeHeader.classList.contains('sort-active'), false);
  // Ve mac dinh: tieu de "Thoi gian dat hang" bao ▼ (moi nhat truoc).
  assert.equal(document.querySelector('th[data-sort="orderDate"]').getAttribute('aria-sort'), 'descending');

  dom.window.close();
});
