'use strict';

// Gioi han GET dong thoi o may chu (inflightLimit.js) co the tra 429 TOO_MANY_INFLIGHT cho nguoi dung binh thuong khi
// server cham (slot cua yeu cau da huy van bi giu). Hai trang goi API nang phai THU LAI sau Retry-After thay vi hien loi:
// - Bao cao hang hoa (index.html, requestServerTable): thu lai toi da 2 lan khi yeu cau con hieu luc; het luot thi bao loi.
// - Vong doi don hang (lifecycle/index.html, loadBulkOrders): thu lai khi van la lan goi moi nhat.
// Yeu cau da bi thay the (obsolete) KHONG duoc thu lai.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { defaultsForRole } = require('../../auth/featureRegistry');
const { lifecycleResponse, isListUrl } = require('./lifecycleFakeServer');

const publicDir = path.join(__dirname, '..', '..', 'public');
const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const lifecycleHtml = fs.readFileSync(path.join(publicDir, 'shipment', 'lifecycle', 'index.html'), 'utf8');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const TOO_MANY = 'Đang xử lý yêu cầu trước, vui lòng chờ.';

function response429(retryAfter) {
  return { ok: false, status: 429, headers: { get: name => (name.toLowerCase() === 'retry-after' ? retryAfter : null) }, json: async () => ({ code: 'TOO_MANY_INFLIGHT', error: TOO_MANY }) };
}

// ---------------------------------------------------------------------------
// Bao cao hang hoa (index.html)
// ---------------------------------------------------------------------------

const PRODUCT = code => ({ code, name: 'Hàng ' + code, stockHanoi: 1, stockSaigon: 1, availableToSell: 1, qtySold30d: 0, revenue90d: 0, customerCount90d: 0, topCustomerRevenue90d: 0, topCustomerName: '', topCustomerShare: null });

function createReportPage(respond) {
  const dom = new JSDOM(indexHtml, { runScripts: 'outside-only', url: 'https://tokosi.example/#products' });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  window.Chart = class { static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } }; destroy() {} };
  window.setInterval = () => 1;
  window.requestAnimationFrame = callback => { if (window.document) callback(); };
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.TKSNav = { authGuard: () => new Promise(() => {}), can: () => true, handleBranchError: () => false, renderTopSidebar() {} };
  const calls = [];
  window.fetch = (url, options) => {
    const href = String(url);
    if (href.split('?')[0] !== '/api/product-report') return new Promise(() => {});
    const call = { href, options, n: calls.filter(c => c.href === href).length + 1 };
    calls.push(call);
    return Promise.resolve(respond(call, calls));
  };
  ['pagination.js', 'table-explorer.js'].forEach(file => window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8')));
  [...indexHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(script => script.trim())
    .forEach(script => window.eval(script));
  return { dom, window, $: id => window.document.getElementById(id), run: code => window.eval(code), calls };
}

const reportOk = (code, extra = {}) => ({ ok: true, status: 200, json: async () => ({ rows: [PRODUCT(code)], totalRows: 1, page: 1, pageSize: 100, summary: {}, filters: {}, ...extra }) });

test('Báo cáo hàng hóa: gặp 429 rồi 200 thì thử lại cùng URL, hiện dữ liệu và không báo lỗi', async t => {
  const page = createReportPage(call => (call.n === 1 ? response429('0') : reportOk('SP-OK')));
  t.after(() => page.window.close());
  page.run("switchView('products')");
  await sleep(50); await settle();
  assert.equal(page.calls.length, 2, 'goi lai dung 1 lan');
  assert.equal(page.calls[0].href, page.calls[1].href, 'thu lai CUNG url');
  assert.match(page.$('productReportRows').textContent, /SP-OK/);
  assert.doesNotMatch(page.$('productReportRows').textContent, /Không tải được/);
});

test('Báo cáo hàng hóa: Retry-After lớn bị chặn ở 5 giây, thiếu header thì mặc định 2 giây', async t => {
  const page = createReportPage(() => reportOk('SP-1'));
  t.after(() => page.window.close());
  const delay = page.run('serverTableRetryDelayMs');
  const res = value => ({ headers: { get: () => value } });
  assert.equal(delay(res('99')), 5000);
  assert.equal(delay(res('3')), 3000);
  assert.equal(delay(res('0')), 0);
  assert.equal(delay(res(null)), 2000);
  assert.equal(delay(res('abc')), 2000);
  assert.equal(delay({}), 2000);
});

test('Báo cáo hàng hóa: hết 2 lượt thử lại vẫn 429 thì hiện thông báo của máy chủ, giữ nguyên dòng cũ', async t => {
  let mode = 'ok';
  const page = createReportPage(() => (mode === 'ok' ? reportOk('SP-OLD') : response429('0')));
  t.after(() => page.window.close());
  page.run("switchView('products')");
  await settle();
  assert.match(page.$('productReportRows').textContent, /SP-OLD/);
  mode = '429';
  const before = page.calls.length;
  page.run("setTableSort('productReportRows',19,{shiftKey:false})");
  await sleep(50); await settle();
  assert.equal(page.calls.length - before, 3, '1 lan dau + toi da 2 lan thu lai');
  assert.ok(page.$('tksToastStack').textContent.includes(TOO_MANY));
  assert.match(page.$('productReportRows').textContent, /SP-OLD/);
});

test('Báo cáo hàng hóa: yêu cầu đã bị thay thế (obsolete) không được thử lại', async t => {
  let slowOnce = false;
  const page = createReportPage(call => {
    if (slowOnce) { slowOnce = false; return response429('0.3'); }
    return reportOk('SP-NEW');
  });
  t.after(() => page.window.close());
  page.run("switchView('products')");
  await settle();
  const before = page.calls.length;
  slowOnce = true;
  page.run("setTableSort('productReportRows',19,{shiftKey:false})"); // lan 1: 429 + cho 0,3s
  await sleep(30); await settle();
  assert.equal(page.calls.length - before, 1);
  const firstUrl = page.calls[before].href;
  page.run("setTableSort('productReportRows',19,{shiftKey:false})"); // doi sap xep -> thay the yeu cau dang cho
  await sleep(450); await settle();
  assert.equal(page.calls.filter(c => c.href === firstUrl).length, 1, 'URL cu khong bi goi lai sau khi bi thay the');
  assert.match(page.$('productReportRows').textContent, /SP-NEW/);
});

// ---------------------------------------------------------------------------
// Vong doi don hang (lifecycle/index.html)
// ---------------------------------------------------------------------------

function sheetOrder(code) {
  return {
    orderCode: code, branch: 'HN', saleName: 'Sale A', customerName: 'KH Sheet', saleSentAt: '01/10/2026 08:00', warning: false,
    summary: { code: 'DELIVERING', label: 'Đơn đang được giao', at: '01/10/2026 09:00' },
    source: 'sheet', kiotStatus: '', sellableValue: null, orderTotal: null, orderDate: '', note: ''
  };
}

async function renderLifecycle({ orders, fetchImpl }) {
  const dom = new JSDOM(lifecycleHtml, { runScripts: 'outside-only', url: 'https://tokosi.example/shipment/lifecycle/' });
  const { window } = dom;
  const calls = [];
  window.setInterval = () => 1;
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8'));
  const readCachedJSON = window.TKSNav.readCachedJSON;
  const permissions = defaultsForRole('Quản lý');
  window.TKSNav = { readCachedJSON, authGuard: () => Promise.resolve({ vaiTro: 'Quản lý' }), can: (...keys) => keys.some(key => (Array.isArray(key) ? key : [key]).some(k => permissions.includes(k))), handleBranchError: () => false };
  window.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const custom = fetchImpl && await fetchImpl(String(url), calls.filter(c => isListUrl(c.url)).length);
    if (custom) return custom;
    if (isListUrl(url)) {
      const body = lifecycleResponse(String(url), orders, { ok: true, stale: false, fetchedAt: null, count: 0 });
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.alert = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  [...lifecycleHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).forEach(script => window.eval(script));
  await settle();
  return { dom, window, document: window.document, calls };
}

const codesOf = document => [...document.querySelectorAll('#bulkBody tr')].map(row => row.cells[0].textContent);
const listCallsOf = page => page.calls.filter(call => isListUrl(call.url));

test('Vòng đời: gặp 429 rồi 200 thì thử lại, bảng có dữ liệu và không hiện lỗi', async t => {
  const page = await renderLifecycle({ orders: [sheetOrder('A'), sheetOrder('B')], fetchImpl: (url, n) => (n === 1 ? response429('0') : null) });
  t.after(() => page.window.close());
  await sleep(50); await settle();
  assert.equal(listCallsOf(page).length, 2, 'goi lai dung 1 lan');
  assert.deepEqual(codesOf(page.document).sort(), ['A', 'B']);
  assert.equal(page.document.getElementById('bulkEmpty').hidden, true);
});

test('Vòng đời: hết 2 lượt thử lại vẫn 429 thì hiện thông báo của máy chủ', async t => {
  const page = await renderLifecycle({ orders: [sheetOrder('A')], fetchImpl: () => response429('0') });
  t.after(() => page.window.close());
  await sleep(50); await settle();
  assert.equal(listCallsOf(page).length, 3, '1 lan dau + toi da 2 lan thu lai');
  assert.equal(page.document.getElementById('bulkEmpty').hidden, false);
  assert.equal(page.document.getElementById('bulkEmpty').textContent, TOO_MANY);
});

test('Vòng đời: lần gọi đã bị thay thế bởi lần mới hơn không được thử lại', async t => {
  let slowOnce = false;
  const page = await renderLifecycle({
    orders: [sheetOrder('A')],
    fetchImpl: () => { if (slowOnce) { slowOnce = false; return response429('0.3'); } return null; }
  });
  t.after(() => page.window.close());
  const before = listCallsOf(page).length;
  slowOnce = true;
  page.window.eval('loadBulkOrders()'); // lan 1: 429 + cho 0,3s
  await sleep(30); await settle();
  page.window.eval('loadBulkOrders()'); // lan 2 (moi nhat): 200
  await sleep(450); await settle();
  assert.equal(listCallsOf(page).length - before, 2, 'lan cu bi thay the khong goi lai');
  assert.deepEqual(codesOf(page.document), ['A']);
  assert.equal(page.document.getElementById('bulkEmpty').hidden, true);
});
