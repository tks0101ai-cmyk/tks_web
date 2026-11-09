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

async function setup(t, { data = { rows: [row(1), row(2), row(3)] }, canEdit = true, withEvents = false, patch, handle } = {}) {
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
    if (method === 'GET' && parsed.pathname === '/api/stock-positions') return json({ branch: parsed.searchParams.get('branch'), canEdit, canExport: false, rows: JSON.parse(JSON.stringify(data.rows)) });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions/history') return json({ rows: [], nextBefore: null });
    if (handle) { const result = handle(method, parsed, body); if (result) return result; }
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

// ---- Chọn vùng ô rồi Delete / dán từ Excel (table-controls 'tks:cells-edit') ----
function selectCells(ui, from, to) {
  const fire = (type, target, buttons) => target.dispatchEvent(new ui.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons }));
  fire('mousedown', ui.cellOf(...from), 1);
  fire('mousemove', ui.cellOf(...to), 1);
  fire('mouseup', ui.cellOf(...to), 0);
}
function pasteText(ui, text) {
  const event = new ui.window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { getData: () => text };
  ui.doc.dispatchEvent(event);
  return event;
}
const pressKey = (ui, key) => ui.doc.dispatchEvent(new ui.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

test('dán khối từ Excel vào Ghi chú + Ngày về: mỗi dòng đúng một PATCH gộp, kèm version', async t => {
  const ui = await setup(t);
  selectCells(ui, [1, 'notes'], [2, 'arrivalDate']);
  pasteText(ui, '5T x 50\t1/11\n3T x 10\t2/11');
  await settle();
  const patches = ui.patches();
  assert.equal(patches.length, 2);
  assert.deepEqual(patches.map(p => [p.path.split('/').pop(), p.body]), [
    ['1', { version: 3, notes: '5T x 50', arrivalDate: '1/11' }],
    ['2', { version: 3, notes: '3T x 10', arrivalDate: '2/11' }]
  ]);
  assert.match(ui.cellOf(2, 'notes').textContent, /3T x 10/);
});

test('dán vào Vị trí được chuẩn hóa; ô không đổi thì không PATCH; cột Mã/SL bị bỏ qua', async t => {
  const ui = await setup(t);
  selectCells(ui, [1, 'location'], [3, 'location']);
  pasteText(ui, 'a 05\nK2\nb 07');
  await settle();
  assert.deepEqual(ui.patches().map(p => [p.path.split('/').pop(), p.body.location]), [['1', 'A05'], ['3', 'B07']]); // K2 đã là vị trí hiện tại
  const before = ui.patches().length;
  selectCells(ui, [1, 'code'], [1, 'code']);
  pasteText(ui, 'ZZZ');
  await settle();
  assert.equal(ui.patches().length, before);
});

test('Delete trên cột Vị trí/Ngày về xóa giá trị qua PATCH ""', async t => {
  const ui = await setup(t, { data: { rows: [row(1, { arrivalDate: '1/11' }), row(2, { arrivalDate: '2/11' })] } });
  selectCells(ui, [1, 'arrivalDate'], [2, 'arrivalDate']);
  pressKey(ui, 'Delete');
  await settle();
  assert.deepEqual(ui.patches().map(p => p.body.arrivalDate), ['', '']);
});

test('Delete trên Ghi chú hỏi MỘT lần; đồng ý → PATCH confirmEmpty cho mọi dòng, từ chối → không PATCH', async t => {
  const ui = await setup(t);
  selectCells(ui, [1, 'notes'], [2, 'notes']);
  pressKey(ui, 'Delete');
  await settle();
  assert.equal(ui.patches().length, 0, 'chưa gửi khi chưa xác nhận');
  assert.equal(ui.doc.getElementById('vtConfirmDialog').hasAttribute('open'), true);
  ui.doc.getElementById('vtConfirmCancel').click();
  await sleep(80);
  assert.equal(ui.patches().length, 0);

  selectCells(ui, [1, 'notes'], [2, 'notes']);
  pressKey(ui, 'Delete');
  await settle();
  ui.doc.getElementById('vtConfirmOk').click();
  await sleep(80);
  assert.deepEqual(ui.patches().map(p => [p.body.notes, p.body.confirmEmpty]), [['', true], ['', true]]);
});

test('chỉ xem (không có quyền sửa): dán / Delete không gửi gì', async t => {
  const ui = await setup(t, { canEdit: false });
  selectCells(ui, [1, 'notes'], [2, 'location']);
  pasteText(ui, 'x');
  pressKey(ui, 'Delete');
  await settle();
  assert.equal(ui.patches().length, 0);
});

// ---- Hoàn tác / làm lại sửa ô theo vùng chọn: edit.revert() / edit.reapply() cho table-controls (Ctrl+Z / Ctrl+Y) ----
// Máy chủ giả có trạng thái: PATCH kiểm version (409 VERSION_CONFLICT), Ghi chú trống cần confirmEmpty rồi xóa dòng, POST tạo lại dòng với id mới.
function fakeServer(initial) {
  const store = initial.map(item => ({ ...item }));
  let nextId = 100;
  return {
    store,
    data: { get rows() { return store; } },
    handle(method, parsed, body) {
      if (method === 'PATCH') {
        const id = Number(parsed.pathname.split('/').pop());
        const found = store.find(item => item.id === id);
        if (!found || body.version !== found.version) return json({ code: 'VERSION_CONFLICT', error: 'Dòng đã bị người khác sửa.' }, 409);
        if (body.notes === '' && !body.confirmEmpty) return json({ code: 'WOULD_AUTO_DELETE', error: 'Hết hàng' }, 409);
        if (body.notes === '') { store.splice(store.indexOf(found), 1); return json({ deleted: true, id }); }
        for (const field of ['notes', 'arrivalDate', 'location']) if (field in body) found[field] = body[field];
        found.version += 1;
        return json({ row: { ...found } });
      }
      if (method === 'POST' && parsed.pathname === '/api/stock-positions') {
        const created = row(nextId++, { ...body, version: 1 });
        store.push(created);
        return json({ row: { ...created } }, 201);
      }
      return null;
    }
  };
}
async function setupUndo(t, rows = [row(1), row(2), row(3)]) {
  const server = fakeServer(rows);
  const ui = await setup(t, { data: server.data, handle: server.handle });
  const edits = [];
  // Gắn sau listener của trang nên chạy sau applyCellEdits: lúc này edit đã có revert/reapply.
  ui.doc.getElementById('vtRows').addEventListener('tks:cells-edit', event => edits.push(...event.detail.edits));
  return Object.assign(ui, { server, edits, undoable: () => edits.filter(edit => typeof edit.revert === 'function') });
}
const runAll = (list, name) => Promise.all(list.map(edit => edit[name]()));

test('revert / reapply sau khi dán: mỗi dòng đúng MỘT PATCH gộp, đúng version mới nhất, gửi giá trị cũ rồi giá trị mới', async t => {
  const ui = await setupUndo(t);
  selectCells(ui, [1, 'notes'], [2, 'arrivalDate']);
  pasteText(ui, '5T x 50\t1/11\n3T x 10\t2/11');
  await sleep(80);
  assert.equal(ui.patches().length, 2);
  const undoable = ui.undoable();
  assert.equal(undoable.length, 4, 'mỗi ô đổi thật có revert');
  assert.ok(undoable.every(edit => typeof edit.reapply === 'function'));

  assert.deepEqual(await runAll(undoable, 'revert'), [true, true, true, true]);
  await sleep(80);
  const reverts = ui.patches().slice(2);
  assert.equal(reverts.length, 2, 'hai cột cùng dòng chỉ một PATCH');
  assert.deepEqual(reverts.map(p => [p.path.split('/').pop(), p.body]), [
    ['1', { version: 4, notes: '2T x 100', arrivalDate: '' }],
    ['2', { version: 4, notes: '2T x 100', arrivalDate: '' }]
  ]);
  assert.deepEqual(ui.server.store.map(item => [item.notes, item.arrivalDate]), [['2T x 100', ''], ['2T x 100', ''], ['2T x 100', '']]);
  assert.match(ui.cellOf(2, 'notes').textContent, /2T x 100/);

  assert.deepEqual(await runAll(undoable, 'revert'), [true, true, true, true], 'revert lần hai: đã ở trạng thái cũ');
  assert.equal(ui.patches().length, 4, 'không gửi thêm');

  assert.deepEqual(await runAll(undoable, 'reapply'), [true, true, true, true]);
  await sleep(80);
  const reapplied = ui.patches().slice(4);
  assert.deepEqual(reapplied.map(p => [p.path.split('/').pop(), p.body]), [
    ['1', { version: 5, notes: '5T x 50', arrivalDate: '1/11' }],
    ['2', { version: 5, notes: '3T x 10', arrivalDate: '2/11' }]
  ]);
  assert.match(ui.cellOf(2, 'notes').textContent, /3T x 10/);
});

test('ô không đổi giá trị thì không có revert / reapply; cột Mã không có', async t => {
  const ui = await setupUndo(t);
  selectCells(ui, [1, 'location'], [3, 'location']);
  pasteText(ui, 'a 05\nK2\nb 07');
  await sleep(80);
  const cells = ui.edits.map(edit => [edit.cell.parentElement.dataset.id, typeof edit.revert, typeof edit.reapply]);
  assert.deepEqual(cells, [['1', 'function', 'function'], ['2', 'undefined', 'undefined'], ['3', 'function', 'function']]);

  selectCells(ui, [1, 'code'], [1, 'code']);
  pasteText(ui, 'ZZZ');
  await sleep(80);
  assert.equal(ui.undoable().length, 2, 'ô Mã không được xử lý nên không thêm revert');
});

test('revert gặp VERSION_CONFLICT (người khác sửa dòng) → false, không ghi đè dữ liệu của họ', async t => {
  const ui = await setupUndo(t);
  selectCells(ui, [1, 'notes'], [1, 'notes']);
  pasteText(ui, '5T x 50');
  await sleep(80);
  ui.server.store[0].notes = 'Người khác sửa';
  ui.server.store[0].version = 10;
  const [edit] = ui.undoable();
  assert.equal(await edit.revert(), false);
  await sleep(80);
  assert.equal(ui.server.store[0].notes, 'Người khác sửa');
  assert.equal(ui.patches().length, 2, 'một PATCH ban đầu + một PATCH revert bị từ chối');
  assert.equal(ui.doc.getElementById('vtNotice').dataset.error, 'true');
});

test('xóa Ghi chú (đã xác nhận) → dòng bị xóa; revert tạo lại dòng bằng POST ảnh chụp cũ, reapply xóa lại bằng confirmEmpty', async t => {
  const ui = await setupUndo(t, [row(1, { arrivalDate: '4/10' }), row(2), row(3)]);
  selectCells(ui, [1, 'notes'], [2, 'notes']);
  pressKey(ui, 'Delete');
  await settle();
  ui.doc.getElementById('vtConfirmOk').click();
  await sleep(80);
  assert.deepEqual(ui.server.store.map(item => item.id), [3], 'dòng 1 và 2 đã bị xóa');
  const undoable = ui.undoable();
  assert.equal(undoable.length, 2);

  assert.deepEqual(await runAll(undoable, 'revert'), [true, true]);
  await sleep(80);
  const posts = ui.calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts.map(p => p.body), [
    { code: 'MA1', notes: '2T x 100', arrivalDate: '4/10', location: 'K1' },
    { code: 'MA2', notes: '2T x 100', arrivalDate: '', location: 'K2' }
  ]);
  assert.deepEqual(ui.server.store.map(item => item.code).sort(), ['MA1', 'MA2', 'MA3']);
  assert.ok(ui.doc.querySelector('#vtRows tr[data-id="100"]'), 'dòng khôi phục hiện lại trong bảng với id mới');
  assert.ok(ui.doc.querySelector('#vtRows tr[data-id="101"]'));
  assert.equal(ui.doc.getElementById('vtNotice').querySelector('.vt-undo'), null, 'nút Hoàn tác cũ đã được gỡ');

  const before = ui.patches().length;
  assert.deepEqual(await runAll(undoable, 'reapply'), [true, true]);
  await sleep(80);
  const reapplied = ui.patches().slice(before);
  assert.deepEqual(reapplied.map(p => [p.path.split('/').pop(), p.body]), [
    ['100', { version: 1, notes: '', confirmEmpty: true }],
    ['101', { version: 1, notes: '', confirmEmpty: true }]
  ]);
  assert.deepEqual(ui.server.store.map(item => item.id), [3]);
});

test('xóa Ghi chú bị Hủy → các edit bị hủy không có revert / reapply', async t => {
  const ui = await setupUndo(t);
  selectCells(ui, [1, 'notes'], [2, 'notes']);
  pressKey(ui, 'Delete');
  await settle();
  ui.doc.getElementById('vtConfirmCancel').click();
  await sleep(80);
  assert.equal(ui.undoable().length, 0);
  assert.ok(ui.edits.length >= 2 && ui.edits.every(edit => edit.cancelled === true));
});
