'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const indexPath = path.join(publicDir, 'index.html');

function createDashboard() {
  const source = fs.readFileSync(indexPath, 'utf8');
  const dom = new JSDOM(source, { runScripts: 'outside-only', url: 'https://tokosi.example/#customers' });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; }
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => callback();
  dom.window.TKSNav = {
    authGuard: () => new Promise(() => {}),
    can: () => true,
    handleBranchError: () => false,
    renderTopSidebar() {}
  };
  dom.window.fetch = () => new Promise(() => {});
  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim())
    .forEach(script => dom.window.eval(script));
  return dom;
}

test('bao cao doanh thu theo khach doc tu bang dung san ghi ro du lieu den het ngay nao', () => {
  const dom = createDashboard();
  const hint = dom.window.customerProductWindowHint({
    computedAt: '2026-09-27T17:10:00.000Z',
    range: { from: '30/06/2026', to: '27/09/2026', days: 90, label: '90 ngày' }
  });
  assert.equal(hint, '90 ngày đến hết 27/09/2026');
  dom.window.close();
});

test('bao cao tinh tu sheet (khong co computedAt) hoac thieu range giu nhan "90 ngày gần đây"', () => {
  const dom = createDashboard();
  assert.equal(dom.window.customerProductWindowHint({ range: { to: '27/09/2026' } }), '90 ngày gần đây');
  assert.equal(dom.window.customerProductWindowHint({ computedAt: '2026-09-27T17:10:00.000Z' }), '90 ngày gần đây');
  assert.equal(dom.window.customerProductWindowHint(null), '90 ngày gần đây');
  dom.window.close();
});

test('o goi y cua so 90 ngay co id de loadCustomerProductReport cap nhat', () => {
  const dom = createDashboard();
  const element = dom.window.document.getElementById('cpWindowHint');
  assert.ok(element, 'thieu #cpWindowHint');
  assert.equal(element.textContent, '90 ngày gần đây');
  dom.window.close();
});

test('lam moi tang dan: cua so ket thuc chinh ngay cap nhat => ghi "den hom nay" kem gio cap nhat theo gio VN', () => {
  const dom = createDashboard();
  // 2026-10-16T05:07:00Z = 12:07 ngay 16/10 theo lich VN.
  const hint = dom.window.customerProductWindowHint({
    computedAt: '2026-10-16T05:07:00.000Z',
    range: { from: '19/07/2026', to: '16/10/2026', days: 90, label: '90 ngày' }
  });
  assert.equal(hint, '90 ngày đến hôm nay · cập nhật lúc 12:07');
  // Sau nua dem UTC nhung van la ngay 16/10 theo VN => van la "hom nay".
  assert.equal(dom.window.customerProductWindowHint({
    computedAt: '2026-10-15T20:30:00.000Z', range: { to: '16/10/2026' }
  }), '90 ngày đến hôm nay · cập nhật lúc 03:30');
  dom.window.close();
});

test('computedAt khong hop le van tra nhan an toan, khong nem loi', () => {
  const dom = createDashboard();
  assert.equal(dom.window.customerProductWindowHint({ computedAt: 'khong-phai-ngay', range: { to: '16/10/2026' } }), '90 ngày đến hết 16/10/2026');
  dom.window.close();
});

test('tai lai ngam khi chua chon khach thi khong goi API', async () => {
  const dom = createDashboard();
  let calls = 0;
  dom.window.fetch = () => { calls++; return new Promise(() => {}); };
  assert.equal(await dom.window.refreshCustomerProductReportQuietly(), false);
  assert.equal(calls, 0);
  dom.window.close();
});

test('su kien SSE dashboard-updated cung tai lai ngam bao cao khach dang xem', () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  const handler = source.slice(source.indexOf("stream.addEventListener('dashboard-updated'"));
  // Tab đang xem tải lại qua reloadForLiveUpdate (tab ẩn hoãn tới khi quay lại, cùng hàm này).
  assert.match(handler.slice(0, 900), /setTimeout\(reloadForLiveUpdate,/);
  const reload = source.slice(source.indexOf('function reloadForLiveUpdate()'));
  assert.match(reload.slice(0, 200), /loadData\(state\.days, false\);\s*refreshCustomerProductReportQuietly\(\);/);
});
