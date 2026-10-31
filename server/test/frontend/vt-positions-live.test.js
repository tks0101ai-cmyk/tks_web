'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions, PAGE_FEATURES } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'vt-positions/index.html'), 'utf8');
const code = fs.readFileSync(path.join(publicDir, 'vt-positions/vt-positions.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const row = (id, extra = {}) => ({ id, code: 'MA' + id, name: 'Hàng ' + id, notes: '2T x 100', arrivalDate: '', location: 'K' + id, quantity: 200, available: 200, held: 0, kiotQuantity: 350, warnings: [], rawWarnings: [], acknowledged: false, updatedByName: 'Quản lý', updatedAt: '2026-10-27T02:30:00.000Z', version: 3, ...extra });
const BAD = (id = 1) => row(id, { notes: 'rác', quantity: null, warnings: ['unreadable'], rawWarnings: ['unreadable'] });

class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; FakeEventSource.instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() { this.closed = true; }
  emit(type) { (this.listeners[type] || []).forEach(fn => fn({})); }
}

// data.rows là nguồn dữ liệu của máy chủ giả; đổi data.rows rồi gọi refresh()/emit để mô phỏng người khác sửa.
async function setup(t, { data = { rows: [row(1), row(2), row(3)] }, withEvents = false } = {}) {
  FakeEventSource.instances = [];
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vt-positions/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
  Object.defineProperty(window.document, 'hidden', { value: false, writable: true, configurable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  if (withEvents) window.EventSource = FakeEventSource;
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/carton.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const base = resolvePermissions({ vaiTro: 'Quản lý' });
  const permissions = [...new Set([...base, 'stockLocationsV2.view', 'stockLocationsV2.edit'])];
  const user = { vaiTro: 'Quản lý', branch: 'Cả hai', permissions, pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return json({ tables: {} });
    const method = options.method || 'GET';
    calls.push({ method, path: parsed.pathname, query: parsed.searchParams, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions') return json({ branch: parsed.searchParams.get('branch'), canEdit: true, canExport: true, canDeleteHistory: false, rows: data.rows });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions/history') return json({ rows: [], nextBefore: null });
    return json({ error: 'Không có mock' }, 500);
  };
  window.eval(code);
  window.TKSVtPositions.live.debounceMs = 10;
  window.TKSVtPositions.live.fallbackMs = 40;
  await window.TKSVtPositions.init();
  const lists = () => calls.filter(call => call.method === 'GET' && call.path === '/api/stock-positions').length;
  return { window, doc: window.document, calls, data, lists };
}

const cell = (tr, field) => tr.querySelector('td[data-field="' + field + '"]');
const ids = doc => [...doc.querySelectorAll('#vtRows tr')].map(tr => tr.dataset.id);

test('cập nhật nền: giữ nguyên node dòng + focus, chỉ sửa ô đổi và nháy ô đó', async t => {
  const { window, doc, data } = await setup(t);
  const tr1 = doc.querySelector('#vtRows tr[data-id="1"]');
  const tr2 = doc.querySelector('#vtRows tr[data-id="2"]');
  tr2.focus();
  assert.equal(doc.activeElement, tr2);
  data.rows = [row(1), row(2, { kiotQuantity: 999, available: 150, held: 50, version: 4 }), row(3)];
  await window.TKSVtPositions.refresh();
  assert.equal(doc.querySelector('#vtRows tr[data-id="1"]'), tr1);
  assert.equal(doc.querySelector('#vtRows tr[data-id="2"]'), tr2);
  assert.equal(doc.activeElement, tr2);
  assert.equal(cell(tr2, 'kiotQuantity').textContent, '999');
  assert.equal(cell(tr2, 'available').textContent, '150');
  assert.match(cell(tr2, 'available').title, /giữ chỗ 50/);
  assert.ok(cell(tr2, 'kiotQuantity').classList.contains('vt-cell-flash'));
  assert.ok(!cell(tr2, 'code').classList.contains('vt-cell-flash'));
  assert.ok(!cell(tr1, 'kiotQuantity').classList.contains('vt-cell-flash'));
});

test('cập nhật nền: dòng mới chèn đúng chỗ, dòng bị xóa gỡ đi, số đếm và bộ lọc cảnh báo cập nhật tại chỗ', async t => {
  const { window, doc, data } = await setup(t);
  const tr1 = doc.querySelector('#vtRows tr[data-id="1"]');
  const tr3 = doc.querySelector('#vtRows tr[data-id="3"]');
  const warnOption = doc.querySelector('#vtWarnFilter option[value="warn"]');
  assert.match(warnOption.textContent, /Cảnh báo \(0\)/);
  data.rows = [row(1), BAD(4), row(3)];
  await window.TKSVtPositions.refresh();
  assert.deepEqual(ids(doc), ['1', '4', '3']);
  assert.equal(doc.querySelector('#vtRows tr[data-id="1"]'), tr1);
  assert.equal(doc.querySelector('#vtRows tr[data-id="3"]'), tr3);
  assert.match(doc.getElementById('vtCount').textContent, /1–3 \/ 3 dòng/);
  assert.equal(doc.querySelector('#vtWarnFilter option[value="warn"]'), warnOption, 'node option giữ nguyên');
  assert.match(warnOption.textContent, /Cảnh báo \(1\)/);
  assert.ok(doc.querySelector('#vtWarnFilter option[value="type:unreadable"]').textContent.includes('(1)'));
  data.rows = [row(3), row(1)];
  await window.TKSVtPositions.refresh();
  assert.deepEqual(ids(doc), ['3', '1']);
  assert.equal(doc.querySelector('#vtRows tr[data-id="1"]'), tr1);
});

test('cập nhật nền giữ từ khóa tìm, bộ lọc, trang; render thường (gõ tìm) không nháy ô', async t => {
  const { window, doc, data } = await setup(t);
  const search = doc.getElementById('vtSearch');
  search.value = 'MA2';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(ids(doc), ['2']);
  assert.equal(doc.querySelectorAll('.vt-cell-flash').length, 0);
  data.rows = [row(1), row(2, { kiotQuantity: 5, version: 4 }), row(3)];
  await window.TKSVtPositions.refresh();
  assert.equal(search.value, 'MA2');
  assert.deepEqual(ids(doc), ['2']);
  assert.equal(cell(doc.querySelector('#vtRows tr[data-id="2"]'), 'kiotQuantity').textContent, '5');
});

test('SSE: mở đúng cơ sở, gộp nhiều tín hiệu thành một lần tải, bảng vá tại chỗ', async t => {
  const { doc, data, lists } = await setup(t, { withEvents: true });
  assert.equal(FakeEventSource.instances.length, 1);
  assert.match(FakeEventSource.instances[0].url, /\/api\/stock-positions\/events\?branch=HN$/);
  const before = lists();
  const tr1 = doc.querySelector('#vtRows tr[data-id="1"]');
  data.rows = [row(1, { kiotQuantity: 77, version: 4 }), row(2), row(3)];
  const source = FakeEventSource.instances[0];
  source.emit('positions-changed'); source.emit('positions-changed'); source.emit('positions-changed');
  await sleep(80);
  assert.equal(lists(), before + 1);
  assert.equal(doc.querySelector('#vtRows tr[data-id="1"]'), tr1);
  assert.equal(cell(tr1, 'kiotQuantity').textContent, '77');
});

test('SSE: đổi tab đóng nguồn cũ và mở nguồn cơ sở mới; mở lại sau ngắt thì tải bù', async t => {
  const { window, lists } = await setup(t, { withEvents: true });
  const first = FakeEventSource.instances[0];
  first.emit('open');
  const afterFirstOpen = lists();
  first.emit('open'); // nối lại sau khi ngắt -> tải bù
  await sleep(60);
  assert.equal(lists(), afterFirstOpen + 1);
  window.location.hash = 'sg';
  await settle(); await sleep(30);
  assert.equal(first.closed, true);
  const second = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  assert.match(second.url, /branch=SG$/);
});

test('SSE: tab ẩn thì không tải, hiện lại thì tải bù một lần; trình duyệt không có EventSource vẫn chạy', async t => {
  const { window, doc, lists } = await setup(t, { withEvents: true });
  const source = FakeEventSource.instances[0];
  Object.defineProperty(doc, 'hidden', { value: true, configurable: true });
  const before = lists();
  source.emit('positions-changed');
  await sleep(60);
  assert.equal(lists(), before);
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });
  doc.dispatchEvent(new window.Event('visibilitychange'));
  await sleep(60);
  assert.equal(lists(), before + 1);
  const plain = await setup(t);
  assert.equal(plain.doc.querySelectorAll('#vtRows tr').length, 3);
});

test('SSE lỗi: bật tải bù định kỳ, kết nối lại thì tắt', async t => {
  const { lists } = await setup(t, { withEvents: true });
  const source = FakeEventSource.instances[0];
  const before = lists();
  source.emit('error');
  await sleep(150);
  assert.ok(lists() >= before + 2, 'tải bù lặp theo fallbackMs');
  source.emit('open');
  await sleep(30);
  const settled = lists();
  await sleep(150);
  assert.equal(lists(), settled);
});

test('hộp chi tiết đang mở: không bị đóng/mất chữ đang gõ; dòng đổi hiện dải cảnh báo, Xem bản mới nạp lại', async t => {
  const { window, doc, data } = await setup(t, { withEvents: true });
  doc.querySelector('#vtRows tr[data-id="2"]').click();
  await settle();
  const dialog = doc.getElementById('vtDetailDialog');
  const notes = doc.querySelector('#vtDetailForm [name="notes"]');
  notes.value = '9T x 100';
  notes.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(doc.getElementById('vtDetailStale').hidden, true);
  data.rows = [row(1), row(2, { notes: '5T x 100', version: 4 }), row(3)];
  FakeEventSource.instances[0].emit('positions-changed');
  await sleep(80);
  assert.ok(dialog.hasAttribute('open'), 'hộp vẫn mở');
  assert.equal(notes.value, '9T x 100', 'chữ đang gõ giữ nguyên');
  assert.equal(doc.getElementById('vtDetailStale').hidden, false);
  assert.match(doc.getElementById('vtDetailStaleText').textContent, /người khác sửa/);
  doc.getElementById('vtDetailStaleReload').click();
  await settle();
  assert.equal(notes.value, '5T x 100');
  assert.equal(doc.getElementById('vtDetailStale').hidden, true);
  assert.ok(dialog.hasAttribute('open'));
});

test('hộp chi tiết đang mở: dòng bị xóa thì báo đã xóa và ẩn nút Xem bản mới; version giữ nguyên thì cập nhật số phái sinh', async t => {
  const { doc, data } = await setup(t, { withEvents: true });
  doc.querySelector('#vtRows tr[data-id="2"]').click();
  await settle();
  data.rows = [row(1), row(2, { kiotQuantity: 123 }), row(3)];
  FakeEventSource.instances[0].emit('positions-changed');
  await sleep(80);
  assert.equal(doc.getElementById('vtDetailStale').hidden, true, 'version không đổi: không báo');
  assert.equal(doc.getElementById('vtDetailKiot').textContent, '123');
  data.rows = [row(1), row(3)];
  FakeEventSource.instances[0].emit('positions-changed');
  await sleep(80);
  assert.equal(doc.getElementById('vtDetailStale').hidden, false);
  assert.match(doc.getElementById('vtDetailStaleText').textContent, /xóa/);
  assert.equal(doc.getElementById('vtDetailStaleReload').hidden, true);
});
