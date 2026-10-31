'use strict';
// Nhập trực tiếp trong bảng VT Hà Nội / VT Sài Gòn: bấm ô Ghi chú / Ngày về / Vị trí → gõ ngay tại ô,
// Enter hoặc rời ô → lưu, Esc → hủy, mũi tên → sang ô nhập kề bên.
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
const row = (id, extra = {}) => ({
  id, code: 'MA' + id, name: 'Hàng ' + id, notes: '2T x 100', arrivalDate: '', location: 'K' + id,
  quantity: 200, held: 0, available: 200, kiotQuantity: 350, warnings: [], rawWarnings: [], acknowledged: false,
  updatedByName: 'Quản lý', updatedAt: '2026-10-27T02:30:00.000Z', version: 3, ...extra
});

class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() {}
  emit(type) { (this.listeners[type] || []).forEach(fn => fn({})); }
}

async function setup(t, { data = { rows: [row(1), row(2), row(3)] }, canEdit = true, withEvents = false, patch } = {}) {
  FakeEventSource.instances = [];
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vt-positions/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
  Object.defineProperty(window.document, 'hidden', { value: false, writable: true, configurable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  // jsdom không tính bố cục nên offsetParent luôn null; code coi ô "thấy được" khi offsetParent khác null.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return this.parentNode; }, configurable: true });
  if (withEvents) window.EventSource = FakeEventSource;
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/carton.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const base = resolvePermissions({ vaiTro: 'Quản lý' });
  const user = {
    vaiTro: 'Quản lý', branch: 'Cả hai',
    permissions: [...new Set([...base, 'stockLocationsV2.view', 'stockLocationsV2.edit'])],
    pageFeatures: PAGE_FEATURES
  };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return json({ tables: {} });
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ method, path: parsed.pathname, body });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions') return json({ branch: parsed.searchParams.get('branch'), canEdit, canExport: false, rows: data.rows });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions/history') return json({ rows: [], nextBefore: null });
    if (method === 'PATCH') {
      const id = Number(parsed.pathname.split('/').pop());
      const current = data.rows.find(item => item.id === id);
      const updated = patch ? patch(current, body) : Object.assign({}, current, body, { version: current.version + 1 });
      delete updated.confirmEmpty;
      return json({ row: updated });
    }
    return json({ error: 'Không có mock', code: 'NO_MOCK' }, 500);
  };
  window.eval(code);
  window.TKSVtPositions.live.debounceMs = 10;
  await window.TKSVtPositions.init();
  const doc = window.document;
  const tr = id => doc.querySelector('#vtRows tr[data-id="' + id + '"]');
  const cellOf = (id, field) => tr(id).querySelector('td[data-field="' + field + '"]');
  const inputIn = (id, field) => cellOf(id, field).querySelector('input.vt-inline');
  return {
    window, doc, calls, data, tr, cellOf, inputIn,
    patches: () => calls.filter(call => call.method === 'PATCH'),
    detailOpen: () => doc.getElementById('vtDetailDialog').hasAttribute('open'),
    click: async (id, field) => { cellOf(id, field).click(); await settle(); },
    key: (input, key, extra = {}) => {
      const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra });
      input.dispatchEvent(event);
      return event;
    },
    type: (input, value) => { input.value = value; input.dispatchEvent(new window.Event('input', { bubbles: true })); }
  };
}

test('bấm ô Ghi chú / Ngày về / Vị trí (có quyền sửa) → ô nhập tại chỗ, không mở hộp chi tiết; bấm cột khác → mở hộp', async t => {
  const ui = await setup(t);
  for (const field of ['notes', 'arrivalDate', 'location']) {
    await ui.click(1, field);
    const input = ui.inputIn(1, field);
    assert.ok(input, 'có input.vt-inline ở ' + field);
    assert.equal(ui.detailOpen(), false, 'không mở hộp chi tiết khi bấm ' + field);
    assert.equal(ui.doc.activeElement, input, 'ô nhập đang giữ focus');
    input.blur();
    await settle();
  }
  assert.equal(ui.doc.querySelectorAll('input.vt-inline').length, 0);
  await ui.click(1, 'name');
  assert.equal(ui.detailOpen(), true, 'bấm Tên hàng mở hộp chi tiết');
  assert.equal(ui.doc.querySelectorAll('#vtRows input.vt-inline').length, 0);
});

test('ô nhập mang sẵn giá trị hiện tại của dòng', async t => {
  const ui = await setup(t, { data: { rows: [row(1, { notes: '3T x 50', arrivalDate: '4/10', location: 'A05' })] } });
  await ui.click(1, 'notes');
  assert.equal(ui.inputIn(1, 'notes').value, '3T x 50');
  await ui.click(1, 'arrivalDate');
  assert.equal(ui.inputIn(1, 'arrivalDate').value, '4/10');
  await ui.click(1, 'location');
  assert.equal(ui.inputIn(1, 'location').value, 'A05');
});

test('chỉ xem: bấm ô Ghi chú mở hộp chi tiết, không có ô nhập', async t => {
  const ui = await setup(t, { canEdit: false });
  await ui.click(1, 'notes');
  assert.equal(ui.detailOpen(), true);
  assert.equal(ui.doc.querySelectorAll('input.vt-inline').length, 0);
});

test('gõ giá trị mới + Enter → PATCH đúng version, chỉ trường đã đổi; ô hiện giá trị mới', async t => {
  const ui = await setup(t);
  await ui.click(1, 'notes');
  const input = ui.inputIn(1, 'notes');
  ui.type(input, '5T x 100');
  const event = ui.key(input, 'Enter');
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.equal(ui.patches().length, 1);
  assert.equal(ui.patches()[0].path, '/api/stock-positions/1');
  assert.deepEqual(ui.patches()[0].body, { version: 3, notes: '5T x 100' });
  assert.equal(ui.doc.querySelectorAll('input.vt-inline').length, 0);
  assert.match(ui.cellOf(1, 'notes').textContent, /5T x 100/);
  assert.equal(ui.detailOpen(), false);
});

test('Vị trí được chuẩn hóa khi lưu: bỏ khoảng trắng, viết hoa ("a 05" -> "A05")', async t => {
  const ui = await setup(t);
  await ui.click(1, 'location');
  const input = ui.inputIn(1, 'location');
  ui.type(input, ' a 05 ');
  ui.key(input, 'Enter');
  await settle();
  assert.deepEqual(ui.patches()[0].body, { version: 3, location: 'A05' });
  assert.match(ui.cellOf(1, 'location').textContent, /A05/);
});

test('rời ô (blur) cũng lưu; Ngày về gửi đúng trường arrivalDate', async t => {
  const ui = await setup(t);
  await ui.click(2, 'arrivalDate');
  const input = ui.inputIn(2, 'arrivalDate');
  ui.type(input, '9/9');
  input.blur();
  await settle();
  assert.deepEqual(ui.patches()[0].body, { version: 3, arrivalDate: '9/9' });
});

test('không đổi giá trị → không gọi PATCH (kể cả chỉ thêm khoảng trắng thừa)', async t => {
  const ui = await setup(t);
  await ui.click(1, 'notes');
  ui.key(ui.inputIn(1, 'notes'), 'Enter');
  await settle();
  await ui.click(1, 'notes');
  ui.type(ui.inputIn(1, 'notes'), '  2T x 100  ');
  ui.key(ui.inputIn(1, 'notes'), 'Enter');
  await settle();
  assert.equal(ui.patches().length, 0);
});

test('Esc hủy: không PATCH, ô trả về chữ cũ', async t => {
  const ui = await setup(t);
  await ui.click(1, 'notes');
  const input = ui.inputIn(1, 'notes');
  ui.type(input, '9T x 9');
  const event = ui.key(input, 'Escape');
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.equal(ui.patches().length, 0);
  assert.equal(ui.doc.querySelectorAll('input.vt-inline').length, 0);
  assert.match(ui.cellOf(1, 'notes').textContent, /2T x 100/);
  assert.doesNotMatch(ui.cellOf(1, 'notes').textContent, /9T/);
});

test('mũi tên Down / Up chuyển sang ô nhập cùng cột ở dòng kề và ô cũ tự lưu', async t => {
  const ui = await setup(t);
  await ui.click(1, 'notes');
  const first = ui.inputIn(1, 'notes');
  ui.type(first, '7T x 100');
  const down = ui.key(first, 'ArrowDown');
  await settle();
  assert.equal(down.defaultPrevented, true);
  const second = ui.inputIn(2, 'notes');
  assert.ok(second, 'dòng dưới có ô nhập cùng cột');
  assert.equal(ui.doc.activeElement, second);
  assert.equal(ui.inputIn(1, 'notes'), null, 'ô cũ không còn là ô nhập');
  assert.equal(ui.patches().length, 1);
  assert.deepEqual(ui.patches()[0].body, { version: 3, notes: '7T x 100' });

  ui.key(second, 'ArrowUp');
  await settle();
  assert.ok(ui.inputIn(1, 'notes'));
  assert.equal(ui.doc.activeElement, ui.inputIn(1, 'notes'));
  assert.equal(ui.inputIn(2, 'notes'), null);
  assert.equal(ui.patches().length, 1, 'ô dòng 2 không đổi nên không lưu');

  // Hết dòng phía trên: không chuyển, không chặn phím.
  const edge = ui.key(ui.inputIn(1, 'notes'), 'ArrowUp');
  assert.equal(edge.defaultPrevented, false);
  assert.ok(ui.inputIn(1, 'notes'));
});

test('Right chỉ chuyển khi con trỏ ở cuối chữ; Left chỉ chuyển khi ở đầu chữ', async t => {
  const ui = await setup(t, { data: { rows: [row(1, { notes: '2T x 100', arrivalDate: '4/10' })] } });
  await ui.click(1, 'notes');
  let input = ui.inputIn(1, 'notes');

  input.setSelectionRange(2, 2);
  let event = ui.key(input, 'ArrowRight');
  assert.equal(event.defaultPrevented, false, 'giữa chữ: để con trỏ di chuyển bình thường');
  assert.ok(ui.inputIn(1, 'notes'));
  assert.equal(ui.inputIn(1, 'arrivalDate'), null);

  input.setSelectionRange(input.value.length, input.value.length);
  event = ui.key(input, 'ArrowRight');
  assert.equal(event.defaultPrevented, true);
  await settle();
  input = ui.inputIn(1, 'arrivalDate');
  assert.ok(input, 'sang ô Ngày về bên phải');
  assert.equal(ui.doc.activeElement, input);

  input.setSelectionRange(2, 2);
  event = ui.key(input, 'ArrowLeft');
  assert.equal(event.defaultPrevented, false, 'giữa chữ: không chuyển');
  assert.ok(ui.inputIn(1, 'arrivalDate'));

  input.setSelectionRange(0, 0);
  event = ui.key(input, 'ArrowLeft');
  assert.equal(event.defaultPrevented, true);
  await settle();
  assert.ok(ui.inputIn(1, 'notes'), 'quay lại ô Ghi chú bên trái');
  assert.equal(ui.inputIn(1, 'arrivalDate'), null);
});

test('làm mới nền (render background) không ghi đè ô đang gõ', async t => {
  const ui = await setup(t, { withEvents: true });
  await ui.click(1, 'notes');
  const input = ui.inputIn(1, 'notes');
  ui.type(input, 'đang gõ dở');
  // Người khác sửa dòng 1 và dòng 2 → máy chủ báo, trang tải nền rồi vá bảng.
  ui.data.rows = [row(1, { notes: '5T x 100', version: 4 }), row(2, { arrivalDate: '1/11', version: 4 }), row(3)];
  FakeEventSource.instances[0].emit('positions-changed');
  await sleep(80);
  assert.ok(ui.inputIn(1, 'notes'), 'ô đang gõ vẫn còn là ô nhập');
  assert.equal(ui.inputIn(1, 'notes'), input, 'cùng một node, không bị dựng lại');
  assert.equal(input.value, 'đang gõ dở');
  assert.equal(ui.doc.activeElement, input);
  assert.match(ui.cellOf(2, 'arrivalDate').textContent, /1\/11/, 'các ô khác vẫn được vá');
  assert.equal(ui.patches().length, 0);
});
