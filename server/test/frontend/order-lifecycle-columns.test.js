'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

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

// Chuoi "dd/MM/yyyy" sap theo bang chu cai KHAC thu tu thoi gian that:
//   chu:  01/10/2026 < 05/01/2027 < 30/09/2026
//   that: 30/09/2026 < 01/10/2026 < 05/01/2027
const ORDERS = [
  { orderCode: 'A1', branch: 'HN', saleName: 'An', customerName: 'X', saleSentAt: '05/01/2027 08:00', warning: false,
    summary: { code: 'DELIVERING', label: 'Đang giao', at: '05/01/2027 09:00' } },
  { orderCode: 'A2', branch: 'HN', saleName: 'Bình', customerName: 'Y', saleSentAt: '30/09/2026 10:47', warning: true,
    summary: { code: 'DELIVERING', label: 'Đang giao', at: '02/10/2026 10:00' } },
  { orderCode: 'A3', branch: 'HN', saleName: 'Chi', customerName: 'Z', saleSentAt: '01/10/2026 07:00', warning: false,
    summary: { code: 'DELIVERING', label: 'Đang giao', at: '01/10/2026 12:00' } },
  { orderCode: 'A4', branch: 'HN', saleName: 'Dung', customerName: 'W', saleSentAt: '', warning: false,
    summary: { code: 'NOT_SENT', label: 'Chưa gửi', at: null } }
];

async function settle() { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); }

async function renderTable() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/shipment/lifecycle/' });
  const { window } = dom;
  window.setInterval = () => 1;
  window.TKSNav = {
    authGuard: () => Promise.resolve({ vaiTro: 'Quản lý' }),
    can: fakeCan('Quản lý'),
    handleBranchError: () => false
  };
  // May chu gia: loc / sap xep / cat trang bang chinh module cua may chu that (lifecycleFakeServer.js).
  window.fetch = async url => {
    if (!isListUrl(url)) return { ok: false, status: 404, json: async () => ({}) };
    const body = lifecycleResponse(String(url), ORDERS, { ok: true });
    return { ok: true, json: async () => body };
  };
  window.MutationObserver = class { observe() {} disconnect() {} };
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/shared/table-controls.js'), 'utf8'));
  inlineScripts(html).forEach(script => window.eval(script));
  await settle();
  return dom;
}

function codes(document) {
  return [...document.querySelectorAll('#bulkBody tr')].map(row => row.cells[0].textContent);
}

function setValue(window, element, value) {
  element.value = value;
  element.dispatchEvent(new window.Event('change', { bubbles: true }));
}

const cell = (row, key) => row.querySelector(`[data-col="${key}"]`);

test('bảng có đủ cột: Giá trị đơn + Giá trị có bán + Ghi chú (sau Khách hàng), Sale ra đơn, Trạng thái KiotViet, Trạng thái, Trạng thái bốc (người có quyền chỉ định), Cập nhật gần nhất và Cảnh báo', async () => {
  const dom = await renderTable();
  const { document } = dom.window;
  const headers = [...document.querySelectorAll('#bulkHeadRow th')].map(th => th.querySelector('.sort-label').textContent.trim());
  assert.deepEqual(headers, [
    'Mã đơn', 'Cơ sở', 'Thời gian đặt hàng', 'Sale', 'Khách hàng', 'Giá trị đơn', 'Giá trị có bán', 'Ghi chú', 'Sale ra đơn',
    'Trạng thái KiotViet', 'Trạng thái', 'Trạng thái bốc', 'Cập nhật gần nhất', 'Cảnh báo'
  ]);

  const rows = [...document.querySelectorAll('#bulkBody tr')];
  assert.equal(cell(rows[1], 'saleSentAt').textContent, '30/09/2026 10:47');
  assert.equal(cell(rows[3], 'saleSentAt').textContent, '—');
  assert.equal(cell(rows[0], 'orderTotal').textContent, '—', 'dong khong co don Kiot khong co Gia tri don');
  assert.equal(cell(rows[0], 'sellableValue').textContent, '—', 'dong khong co don Kiot khong co Gia tri co ban');
  assert.equal(cell(rows[0], 'note').textContent, '—');
  assert.equal(cell(rows[0], 'kiotStatus').textContent, '—');

  // Chi don co warning=true moi co chu "Canh bao" (mau do); con lai de trong.
  assert.equal(cell(rows[1], 'warning').textContent, 'Cảnh báo');
  assert.ok(cell(rows[1], 'warning').querySelector('.badge-exception'));
  assert.equal(cell(rows[0], 'warning').textContent, '');
  assert.equal(cell(rows[3], 'warning').textContent, '');
  dom.window.close();
});

test('sắp xếp cột thời gian theo thời gian thật (không theo chuỗi), ô trống luôn cuối', async () => {
  const dom = await renderTable();
  const { document } = dom.window;

  const saleSentHeader = document.querySelector('th[data-sort="saleSentAt"]');
  saleSentHeader.click();
  await settle();
  assert.deepEqual(codes(document), ['A2', 'A3', 'A1', 'A4']); // 30/09/2026, 01/10/2026, 05/01/2027, trống

  saleSentHeader.click();
  await settle();
  assert.deepEqual(codes(document), ['A1', 'A3', 'A2', 'A4']); // giảm dần, trống VẪN ở cuối

  const atHeader = document.querySelector('th[data-sort="at"]');
  atHeader.click();
  await settle();
  assert.deepEqual(codes(document), ['A3', 'A2', 'A1', 'A4']); // 01/10, 02/10, 05/01/2027, trống
  dom.window.close();
});

test('sắp xếp cột Cảnh báo: đơn có cảnh báo lên trước khi giảm dần', async () => {
  const dom = await renderTable();
  const { document } = dom.window;
  const header = document.querySelector('th[data-sort="warning"]');
  header.click();
  header.click();
  await settle();
  assert.equal(codes(document)[0], 'A2');
  dom.window.close();
});

test('bộ lọc thời gian: mặc định tất cả thời gian, lọc theo Sale ra đơn từ ... đến ... (gồm cả ngày cuối)', async () => {
  const dom = await renderTable();
  const { document } = dom.window;
  const from = document.getElementById('bulkDateFrom');
  const to = document.getElementById('bulkDateTo');
  const all = document.getElementById('bulkDateAll');

  assert.equal(from.value, '');
  assert.equal(to.value, '');
  assert.ok(all.classList.contains('active'));
  assert.deepEqual(codes(document), ['A1', 'A2', 'A3', 'A4']);

  setValue(dom.window, from, '2026-09-30');
  setValue(dom.window, to, '2026-09-30');
  await settle();
  assert.deepEqual(codes(document), ['A2']); // 30/09 10:47 nằm trong ngày cuối được chọn
  assert.equal(all.classList.contains('active'), false);
  assert.equal(document.getElementById('bulkCount').textContent, '1 / 4 đơn');

  setValue(dom.window, to, '2026-10-01');
  await settle();
  assert.deepEqual(codes(document), ['A2', 'A3']);

  // chỉ có "từ": không giới hạn phía sau; đơn chưa có Sale ra đơn bị loại khi đã chọn khoảng
  setValue(dom.window, to, '');
  setValue(dom.window, from, '2026-10-01');
  await settle();
  assert.deepEqual(codes(document), ['A1', 'A3']);

  all.click();
  await settle();
  assert.equal(from.value, '');
  assert.deepEqual(codes(document), ['A1', 'A2', 'A3', 'A4']);
  assert.ok(all.classList.contains('active'));
  dom.window.close();
});

test('bộ lọc thời gian có thể áp dụng cho cột "Cập nhật gần nhất"', async () => {
  const dom = await renderTable();
  const { document } = dom.window;
  setValue(dom.window, document.getElementById('bulkDateField'), 'at');
  setValue(dom.window, document.getElementById('bulkDateFrom'), '2026-10-02');
  setValue(dom.window, document.getElementById('bulkDateTo'), '2026-10-02');
  await settle();
  assert.deepEqual(codes(document), ['A2']);
  dom.window.close();
});
