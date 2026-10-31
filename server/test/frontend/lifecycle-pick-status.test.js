'use strict';

// Cot "Trang thai boc" tren bang Vong doi don hang THAT (public/shipment/lifecycle/index.html), chay trong JSDOM voi fetch gia:
// chi nguoi co quyen shipment.pick thay cot, Dang boc doi duoc sang Da boc / Da huy bang dropdown (POST /api/shipment/pick/status),
// va canh bao chi dinh Lech Kiot / Lech SL trong don (to do dong + nhan o cot Canh bao, nam trong bo loc canh bao).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { lifecycleResponse, isListUrl } = require('./lifecycleFakeServer');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'shipment', 'lifecycle', 'index.html'), 'utf8');
const read = file => fs.readFileSync(file, 'utf8');

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function orderRow(code, extra = {}) {
  return {
    orderCode: code, branch: 'HN', saleName: 'Sale A', customerName: 'KH A', saleSentAt: '01/10/2026 08:00', warning: false,
    summary: { code: 'SENT_TO_ACCOUNTANT', label: 'Đã gửi kế toán', at: '01/10/2026 09:00' },
    source: 'kiotviet', kiotStatus: 'Phiếu tạm', sellableValue: 100000, orderTotal: 100000, orderDate: '01/10/2026 13:14', note: '',
    ...extra
  };
}

async function renderPage({ orders, permissions = ['shipment.lifecycle', 'shipment.pick'], confirmAnswer = true, statusReply } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/shipment/lifecycle/' });
  const { window } = dom;
  const calls = [];
  const confirms = [];
  const source = { orders };
  window.setInterval = () => 1;
  window.confirm = message => { confirms.push(message); return confirmAnswer; };
  window.eval(read(path.join(publicDir, 'shared/shared-nav.js')));
  const readCachedJSON = window.TKSNav.readCachedJSON;
  window.TKSNav = {
    readCachedJSON, authGuard: () => Promise.resolve({ vaiTro: 'Quản lý' }),
    can: (...keys) => keys.some(key => (Array.isArray(key) ? key : [key]).some(k => permissions.includes(k))), handleBranchError: () => false
  };
  window.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, options });
    const u = new URL(href, 'https://tokosi.example');
    if (isListUrl(href)) return json(lifecycleResponse(href, source.orders, { ok: true, stale: false, fetchedAt: null, count: 0 }));
    if (u.pathname === '/api/shipment/pick/status' && options.method === 'POST') {
      const body = JSON.parse(options.body);
      if (statusReply) return statusReply(body, source);
      return json({ assignment: { id: 7, branch: body.branch, orderCode: body.orderCode, status: body.status, version: 2, lines: [], history: [] } });
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(read(path.join(publicDir, 'shared/table-controls.js')));
  ['shared/carton.js', 'shared/pick-rules.js', 'shipment/lifecycle/pick/invoice.js', 'shipment/lifecycle/pick/print-tools.js', 'shipment/lifecycle/pick/pick-assign.js']
    .forEach(file => window.eval(read(path.join(publicDir, file))));
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).forEach(script => window.eval(script));
  await settle();
  return { dom, window, document: window.document, calls, confirms, source };
}

const rowsOf = document => [...document.querySelectorAll('#bulkBody tr')];
const pickCell = row => row.querySelector('[data-col="pickStatus"]');
const pickPosts = page => page.calls.filter(c => c.url.endsWith('/api/shipment/pick/status'));
async function choose(page, select, value) {
  select.value = value;
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await settle();
}

test('người KHÔNG có quyền chỉ định: không có cột Trạng thái bốc, không có ô lọc, không có cảnh báo lệch SL', async () => {
  const page = await renderPage({ orders: [orderRow('DH1')], permissions: ['shipment.lifecycle'] });
  const headers = [...page.document.querySelectorAll('#bulkHeadRow th')].map(th => th.textContent.replace(/[▲▼]/g, '').trim());
  assert.equal(headers.includes('Trạng thái bốc'), false);
  assert.equal(page.document.querySelector('[data-col="pickStatus"]'), null);
  assert.equal(page.document.getElementById('bulkPickWrap').hidden, true);
  assert.equal(page.document.querySelector('#bulkWarningFilter option[value="PICK_KIOT_DIFF"]'), null, 'không thấy lựa chọn lọc Lệch Kiot');
  assert.equal(page.document.querySelector('#bulkWarningFilter option[value="PICK_ORDER_DIFF"]'), null);
  page.dom.window.close();
});

test('người có quyền: cột nằm sau Trạng thái; Chưa bốc / Đã bốc / Đã hủy là nhãn, Đang bốc là dropdown 3 lựa chọn', async () => {
  const page = await renderPage({ orders: [
    orderRow('DH1', { pickStatus: null }), orderRow('DH2', { pickStatus: 'picking' }),
    orderRow('DH3', { pickStatus: 'confirmed' }), orderRow('DH4', { pickStatus: 'cancelled' })
  ] });
  const headers = [...page.document.querySelectorAll('#bulkHeadRow th')].map(th => th.textContent.replace(/[▲▼]/g, '').trim());
  assert.deepEqual(headers.slice(headers.indexOf('Trạng thái')), ['Trạng thái', 'Trạng thái bốc', 'Cập nhật gần nhất', 'Cảnh báo']);
  const rows = rowsOf(page.document);
  const labels = rows.map(row => {
    const state = pickCell(row).querySelector('.lc-pick-state');
    return [state.tagName, state.dataset.pickStatus, state.tagName === 'SELECT' ? state.selectedOptions[0].textContent : state.textContent];
  });
  const byCode = Object.fromEntries(rows.map((row, i) => [row.cells[0].textContent, labels[i]]));
  assert.deepEqual(byCode.DH1, ['SPAN', 'none', 'Chưa bốc']);
  assert.deepEqual(byCode.DH2, ['SELECT', 'picking', 'Đang bốc']);
  assert.deepEqual(byCode.DH3, ['SPAN', 'confirmed', 'Đã bốc']);
  assert.deepEqual(byCode.DH4, ['SPAN', 'cancelled', 'Đã hủy']);
  const select = rows.find(row => row.cells[0].textContent === 'DH2').querySelector('select');
  assert.deepEqual([...select.options].map(o => o.value), ['picking', 'confirmed', 'cancelled']);
  assert.equal(page.document.querySelectorAll('#bulkBody select.lc-pick-state').length, 1, 'chỉ Đang bốc mới có dropdown');
  page.dom.window.close();
});

test('cột Trạng thái bốc: mặc định ẩn (bật ở hộp Cột hiển thị) và có sort phía máy chủ ▲▼', async () => {
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })] });
  const th = page.document.querySelector('#bulkHeadRow th[data-col="pickStatus"]');
  assert.equal(th.classList.contains('tks-column-hidden'), true, 'mặc định ẩn');
  assert.equal(th.classList.contains('sortable'), true);
  assert.equal(th.dataset.sort, 'pickStatus');
  assert.equal(th.getAttribute('aria-sort'), 'none');
  assert.equal(th.querySelector('.sort-indicator').textContent, '▲▼');
  const before = page.calls.filter(c => isListUrl(c.url)).length;
  th.click();
  await settle();
  const listCalls = page.calls.filter(c => isListUrl(c.url));
  assert.ok(listCalls.length > before, 'bấm tiêu đề thì tải lại danh sách');
  const url = new URL(listCalls[listCalls.length - 1].url, 'https://tokosi.example');
  assert.equal(url.searchParams.get('sort'), 'pickStatus');
  assert.equal(url.searchParams.get('dir'), 'asc');
  assert.equal(th.getAttribute('aria-sort'), 'ascending');
  th.click();
  await settle();
  const again = new URL(page.calls.filter(c => isListUrl(c.url)).pop().url, 'https://tokosi.example');
  assert.equal(again.searchParams.get('dir'), 'desc');
  page.dom.window.close();
});

test('dropdown Đang bốc → Đã bốc: hỏi xác nhận, POST đúng body, ô thành nhãn Đã bốc (hết dropdown)', async () => {
  const page = await renderPage({ orders: [orderRow('DH2', { pickStatus: 'picking' })] });
  const select = pickCell(rowsOf(page.document)[0]).querySelector('select');
  await choose(page, select, 'confirmed');
  assert.equal(page.confirms.length, 1);
  assert.match(page.confirms[0], /ĐÃ BỐC.*DH2/su);
  const posts = pickPosts(page);
  assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].options.body), { branch: 'HN', orderCode: 'DH2', status: 'confirmed' });
  const state = pickCell(rowsOf(page.document)[0]).querySelector('.lc-pick-state');
  assert.deepEqual([state.tagName, state.dataset.pickStatus, state.textContent], ['SPAN', 'confirmed', 'Đã bốc']);
  assert.equal(page.document.querySelector('#toastContainer .toast-success') !== null, true);
  page.dom.window.close();
});

test('dropdown Đang bốc → Đã hủy: POST status=cancelled, ô thành nhãn Đã hủy; bấm Hủy ở hộp xác nhận thì không gọi API và trả dropdown về cũ', async () => {
  const refused = await renderPage({ orders: [orderRow('DH2', { pickStatus: 'picking' })], confirmAnswer: false });
  const refusedSelect = pickCell(rowsOf(refused.document)[0]).querySelector('select');
  await choose(refused, refusedSelect, 'cancelled');
  assert.equal(pickPosts(refused).length, 0);
  assert.equal(refusedSelect.value, 'picking');
  refused.dom.window.close();

  const page = await renderPage({ orders: [orderRow('DH2', { pickStatus: 'picking' })] });
  await choose(page, pickCell(rowsOf(page.document)[0]).querySelector('select'), 'cancelled');
  assert.deepEqual(JSON.parse(pickPosts(page)[0].options.body).status, 'cancelled');
  assert.match(page.confirms[0], /Hủy bốc đơn DH2/u);
  assert.equal(pickCell(rowsOf(page.document)[0]).querySelector('.lc-pick-state').textContent, 'Đã hủy');
  page.dom.window.close();
});

test('lỗi từ máy chủ (409): dropdown trả về Đang bốc, báo lỗi và tải lại danh sách; lỗi mạng cũng trả về', async () => {
  const page = await renderPage({
    orders: [orderRow('DH2', { pickStatus: 'picking' })],
    statusReply: () => json({ error: 'Chỉ định đã bị người khác thay đổi.', code: 'INVALID_STATE' }, 409)
  });
  const listCallsBefore = page.calls.filter(c => isListUrl(c.url)).length;
  const select = pickCell(rowsOf(page.document)[0]).querySelector('select');
  await choose(page, select, 'confirmed');
  assert.equal(select.value, 'picking');
  assert.equal(select.disabled, false);
  assert.match(page.document.querySelector('#toastContainer .toast-error').textContent, /người khác thay đổi/u);
  assert.ok(page.calls.filter(c => isListUrl(c.url)).length > listCallsBefore, 'tải lại danh sách sau 409');

  const offline = await renderPage({ orders: [orderRow('DH2', { pickStatus: 'picking' })], statusReply: () => { throw new Error('offline'); } });
  const offlineSelect = pickCell(rowsOf(offline.document)[0]).querySelector('select');
  await choose(offline, offlineSelect, 'cancelled');
  assert.equal(offlineSelect.value, 'picking');
  assert.match(offline.document.querySelector('#toastContainer .toast-error').textContent, /kết nối/u);
  [page, offline].forEach(p => p.dom.window.close());
});

test('cảnh báo chỉ định: Lệch Kiot / Lệch SL trong đơn tô đỏ dòng, nhãn có giải thích; tự hết khi danh sách mới không còn; đơn không lệch không tô; ô lọc có 2 lựa chọn', async () => {
  const page = await renderPage({ orders: [
    orderRow('DH1', { pickStatus: 'picking', warning: true, warnings: ['PICK_KIOT_DIFF'] }),
    orderRow('DH2', { pickStatus: 'confirmed' }),
    orderRow('DH3', { pickStatus: 'picking', warning: true, warnings: ['PICK_KIOT_DIFF', 'PICK_ORDER_DIFF'] })
  ] });
  const byCode = code => rowsOf(page.document).find(row => row.cells[0].textContent === code);
  const labels = code => [...byCode(code).querySelectorAll('[data-col="warning"] .lc-warning-badge')].map(node => node.textContent);
  assert.equal(byCode('DH1').classList.contains('lc-row-mismatch'), true);
  assert.equal(byCode('DH2').classList.contains('lc-row-mismatch'), false);
  assert.deepEqual(labels('DH1'), ['Lệch Kiot']);
  assert.deepEqual(labels('DH3'), ['Lệch Kiot', 'Lệch SL trong đơn']);
  assert.match(byCode('DH1').querySelector('.lc-warning-badge').title, /Kiot/u);
  assert.deepEqual(labels('DH2'), []);
  const options = [...page.document.querySelectorAll('#bulkWarningFilter option')].map(option => [option.value, option.textContent]);
  assert.deepEqual(options.slice(-2), [['PICK_KIOT_DIFF', 'Lệch Kiot'], ['PICK_ORDER_DIFF', 'Lệch SL trong đơn']]);

  // Chọn lọc -> gửi warning lên máy chủ.
  const filter = page.document.getElementById('bulkWarningFilter');
  filter.value = 'PICK_ORDER_DIFF';
  filter.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await settle();
  assert.match(page.calls.filter(c => isListUrl(c.url)).at(-1).url, /warning=PICK_ORDER_DIFF/u);
  filter.value = '';
  filter.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await settle();

  // Kiot sửa đơn / chỉ định lại khớp -> lần làm mới sau không còn mã -> hết đỏ.
  page.source.orders = [orderRow('DH1', { pickStatus: 'picking' }), orderRow('DH2', { pickStatus: 'confirmed' }), orderRow('DH3', { pickStatus: 'picking' })];
  page.window.eval('loadBulkOrders(true)');
  await settle();
  assert.equal(byCode('DH1').classList.contains('lc-row-mismatch'), false);
  assert.deepEqual(labels('DH1'), []);
  assert.equal(rowsOf(page.document).length, 3);
  page.dom.window.close();
});

test('đổi Đang bốc → Đã hủy thì hết cảnh báo chỉ định ngay trên dòng (cảnh báo khác giữ nguyên)', async () => {
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking', warning: true, warnings: ['NOT_SIGNED_6H', 'PICK_KIOT_DIFF'] })] });
  const row = () => rowsOf(page.document)[0];
  assert.equal(row().classList.contains('lc-row-mismatch'), true);
  await choose(page, pickCell(row()).querySelector('select'), 'cancelled');
  assert.equal(row().classList.contains('lc-row-mismatch'), false);
  assert.deepEqual([...row().querySelectorAll('[data-col="warning"] .lc-warning-badge')].map(node => node.textContent), ['Chưa nhận đơn quá 6 giờ']);
  page.dom.window.close();
});

test('đơn Đã bốc vẫn cảnh báo chỉ định (không có dropdown để đổi trạng thái)', async () => {
  const page = await renderPage({ orders: [orderRow('DH3', { pickStatus: 'confirmed', warning: true, warnings: ['PICK_ORDER_DIFF'] })] });
  const row = rowsOf(page.document)[0];
  assert.equal(row.classList.contains('lc-row-mismatch'), true);
  assert.equal(row.querySelector('select.lc-pick-state'), null);
  page.dom.window.close();
});
