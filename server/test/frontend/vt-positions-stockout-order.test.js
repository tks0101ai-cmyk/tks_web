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
const orderCode = fs.readFileSync(path.join(publicDir, 'vt-positions/vt-stockout-order.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

const line = (id, extra = {}) => ({
  id, orderId: 7, sortOrder: id, code: 'AAA1', name: 'Kem chống nắng', location: 'A1', notes: '3T x 100', quantity: 300, source: 'manual', version: 1,
  createdByName: 'Quản lý', updatedAt: '2026-11-02T03:00:00.000Z', result: null,
  preview: { before: '5T x 100', after: '2T x 100', quantity: 200, negative: false, missing: false, held: 0, blocked: false }, ...extra
});
const draft = (lines, extra = {}) => ({ id: 7, branch: 'HN', code: 'XK-HN-00001', status: 'draft', version: 4, createdByName: 'Quản lý', createdAt: '2026-11-02T02:00:00.000Z', confirmedAt: null, confirmedByName: null, summary: null, lines, ...extra });

async function setup(t, { order = draft([line(1)]), canEdit = true, canExport = false, handler, historyRows } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vt-positions/#hn', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
  const media = { matches: false, addEventListener() {} };
  window.matchMedia = () => media;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  ['fuzzy-search.js', 'carton.js', 'table-controls.js'].forEach(file => window.eval(fs.readFileSync(path.join(publicDir, 'shared', file), 'utf8')));
  window.eval(nav);
  const base = resolvePermissions({ vaiTro: 'Quản lý' });
  const user = { vaiTro: 'Quản lý', branch: 'Cả hai', permissions: [...new Set([...base, 'stockLocationsV2.view', ...(canEdit ? ['stockLocationsV2.edit'] : [])])], pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  const current = { order };
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return json({ tables: {} });
    const method = options.method || 'GET';
    calls.push({ method, path: parsed.pathname, query: parsed.searchParams, body: options.body && typeof options.body === 'string' ? JSON.parse(options.body) : options.body });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions') return json({ branch: 'HN', canEdit, canExport: false, rows: [] });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions/stock-out-orders/current') return json({ order: current.order, canEdit, canExport });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions/stock-out-orders' && historyRows) return json({ orders: historyRows });
    if (handler) { const answer = await handler(parsed, options, current); if (answer) return answer; }
    return json({ error: 'Không có mock', code: 'NO_MOCK' }, 500);
  };
  window.eval(orderCode);
  window.eval(code);
  await window.TKSVtPositions.init();
  return { window, doc: window.document, calls, current };
}

const openDialog = async doc => { doc.getElementById('vtOrderButton').click(); await settle(); };

test('mở Đơn xuất kho: hiện mã đơn, dòng và xem trước tồn VT trước/sau; chỉ gọi GET (chưa trừ tồn)', async t => {
  const { doc, calls } = await setup(t);
  await openDialog(doc);
  assert.equal(doc.getElementById('vtOrderDialog').hasAttribute('open'), true);
  assert.match(doc.getElementById('vtOrderSubtitle').textContent, /VT Hà Nội · XK-HN-00001 · Đơn tạm/);
  const rows = [...doc.querySelectorAll('#vtOrderRows tr.vt-order-row')];
  assert.equal(rows.length, 1);
  assert.match(rows[0].textContent, /Kem chống nắng/);
  assert.match(rows[0].querySelector('.vt-order-before').textContent, /5T x 100/);
  assert.match(rows[0].querySelector('.vt-order-after').textContent, /2T x 100/);
  assert.equal(doc.getElementById('vtOrderConfirm').hidden, false);
  assert.equal(calls.some(call => call.method !== 'GET'), false);
  assert.equal(calls.find(call => call.path.endsWith('/current')).query.get('branch'), 'HN');
});

test('"+ Thêm dòng": hiện hàng nhập cuối bảng, gợi ý theo tên, lưu POST rồi tải lại và hàng nhập trống', async t => {
  const { doc, window, calls, current } = await setup(t, {
    handler: async (parsed, options, state) => {
      if (parsed.pathname === '/api/stock-positions/code-suggestions') return json({ items: [{ code: 'AAA1', name: 'Kem chống nắng' }] });
      if (parsed.pathname === '/api/stock-positions/stock-out-orders/7/lines' && options.method === 'POST') {
        state.order = draft([line(1), line(2, { notes: '1T x 50', quantity: 50, location: 'CONT' })], { version: 5 });
        return json({ line: line(2) }, 201);
      }
      return null;
    }
  });
  await openDialog(doc);
  doc.getElementById('vtOrderAdd').click();
  const name = doc.getElementById('vtOrderName');
  assert.ok(name, 'hiện hàng nhập ở cuối bảng');
  name.value = 'kem chong';
  name.dispatchEvent(new window.Event('input'));
  await new Promise(resolve => setTimeout(resolve, 260));
  await settle();
  assert.deepEqual([...doc.querySelectorAll('#vtOrderSuggestions option')].map(option => option.value), ['Kem chống nắng (AAA1)']);
  doc.getElementById('vtOrderName').value = 'Kem chống nắng (AAA1)';
  doc.getElementById('vtOrderLocation').value = 'CONT';
  doc.getElementById('vtOrderNotes').value = '1T x 50';
  doc.querySelector('#vtOrderFoot .vt-btn-primary').click();
  await settle();
  const post = calls.find(call => call.method === 'POST');
  assert.deepEqual(post.body, { code: 'AAA1', name: 'Kem chống nắng', location: 'CONT', notes: '1T x 50' });
  assert.equal(doc.querySelectorAll('#vtOrderRows tr.vt-order-row').length, 2);
  assert.equal(doc.getElementById('vtOrderName').value, '', 'hàng nhập trống sẵn để nhập tiếp');
  assert.equal(current.order.lines.length, 2);
});

test('thêm dòng chưa chọn hàng trong gợi ý hoặc thiếu vị trí: báo lỗi tại chỗ, không gọi API', async t => {
  const { doc, calls } = await setup(t);
  await openDialog(doc);
  doc.getElementById('vtOrderAdd').click();
  doc.getElementById('vtOrderName').value = 'gõ bừa';
  doc.querySelector('#vtOrderFoot .vt-btn-primary').click();
  await settle();
  assert.match(doc.getElementById('vtOrderAddError').textContent, /chọn hàng trong danh sách gợi ý/);
  assert.equal(calls.some(call => call.method === 'POST'), false);
});

test('chốt đơn: hộp xác nhận nêu dòng âm và dòng chưa có VT; đồng ý mới POST confirm kèm version, rồi báo và tải lại bảng', async t => {
  const negative = line(2, { code: 'BBB2', name: 'Sữa rửa mặt', location: 'B1', notes: '7T x 100', quantity: 700, preview: { before: '5T x 100', after: '-2T x 100', quantity: -200, negative: true, missing: false, held: 0, blocked: false } });
  const missing = line(3, { code: 'CCC3', name: 'Hàng mới', location: 'Z9', notes: '1T x 20', quantity: 20, preview: { before: '', after: '-1T x 20', quantity: -20, negative: true, missing: true, held: 0, blocked: false } });
  const { doc, calls, current } = await setup(t, {
    order: draft([line(1), negative, missing]),
    handler: async (parsed, options, state) => {
      if (parsed.pathname === '/api/stock-positions/stock-out-orders/7/confirm') {
        state.order = draft([], { id: 8, code: 'XK-HN-00002', version: 1 });
        return json({ order: draft([], { status: 'confirmed' }), stats: { positions: 3, lines: 3, quantity: 420, negative: 2, removed: 0, created: 1 } });
      }
      return null;
    }
  });
  await openDialog(doc);
  assert.match(doc.querySelector('#vtOrderRows tr[data-line-id="2"] .vt-order-neg').textContent, /-2T x 100/);
  doc.getElementById('vtOrderConfirm').click();
  await settle();
  const message = doc.getElementById('vtConfirmMessage').textContent;
  assert.match(message, /Chốt đơn XK-HN-00001: 3 dòng, 3 vị trí/);
  assert.match(message, /2 vị trí sẽ ra số ÂM/);
  assert.match(message, /1 vị trí chưa có dòng VT/);
  assert.equal(calls.some(call => call.path.endsWith('/confirm')), false, 'chưa bấm Chốt đơn thì chưa gửi');
  doc.getElementById('vtConfirmOk').click();
  await settle();
  const confirm = calls.find(call => call.path.endsWith('/confirm'));
  assert.deepEqual(confirm.body, { version: 4 });
  assert.match(doc.getElementById('vtNotice').textContent, /Đã chốt đơn XK-HN-00001/);
  assert.equal(current.order.code, 'XK-HN-00002');
  assert.equal(doc.getElementById('vtOrderConfirm').disabled, true, 'đơn mới trống chưa chốt được');
  assert.ok(calls.filter(call => call.method === 'GET' && call.path === '/api/stock-positions').length >= 2, 'bảng VT tải lại sau khi chốt');
});

test('Hủy hộp xác nhận thì không chốt', async t => {
  const { doc, calls } = await setup(t);
  await openDialog(doc);
  doc.getElementById('vtOrderConfirm').click();
  await settle();
  doc.getElementById('vtConfirmCancel').click();
  await settle();
  assert.equal(calls.some(call => call.path.endsWith('/confirm')), false);
});

test('sửa ô Ghi chú tại chỗ gửi PATCH đúng version; xóa dòng gửi DELETE kèm version', async t => {
  const { doc, window, calls } = await setup(t, {
    handler: async (parsed, options) => {
      if (parsed.pathname === '/api/stock-positions/stock-out-orders/lines/1') return json({ line: line(1) });
      return null;
    }
  });
  await openDialog(doc);
  doc.querySelector('#vtOrderRows td[data-field="notes"]').click();
  const input = doc.querySelector('#vtOrderRows input.vt-order-inline');
  assert.equal(input.value, '3T x 100');
  input.value = '4T x 100';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  const patch = calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body, { notes: '4T x 100', version: 1 });
  doc.querySelector('#vtOrderRows .vt-order-actions button').click();
  await settle();
  const del = calls.find(call => call.method === 'DELETE');
  assert.equal(del.path, '/api/stock-positions/stock-out-orders/lines/1');
  assert.equal(del.query.get('version'), '1');
});

test('chỉ xem: không có nút Chốt/Import/Thêm dòng/Xóa, có lời nhắc', async t => {
  const { doc } = await setup(t, { canEdit: false });
  await openDialog(doc);
  assert.equal(doc.getElementById('vtOrderConfirm').hidden, true);
  assert.equal(doc.getElementById('vtOrderImport').hidden, true);
  assert.equal(doc.getElementById('vtOrderAdd'), null);
  assert.equal(doc.querySelector('#vtOrderRows .vt-order-actions button'), null);
  assert.match(doc.getElementById('vtOrderHint').textContent, /chỉ xem được đơn/);
});

test('Danh sách đơn: đơn tạm đứng đầu kèm trạng thái, đơn đã chốt bên dưới; bấm đơn chốt xem chi tiết với tồn trước/sau và dòng âm', async t => {
  const confirmedLine = line(1, { result: { before: '5T x 100', after: '-2T x 100', quantity: -200, negative: true, created: false }, preview: null });
  const confirmed = draft([confirmedLine], { id: 6, code: 'XK-HN-00000', status: 'confirmed', confirmedAt: '2026-11-02T10:00:00.000Z', confirmedByName: 'Quản lý B', summary: { lines: 1, positions: 1, quantity: 700, negative: 1, removed: 0, created: 0 } });
  const { doc } = await setup(t, {
    historyRows: [{ ...confirmed, lines: [], lineCount: 1 }],
    handler: async parsed => (parsed.pathname === '/api/stock-positions/stock-out-orders/6' ? json({ order: confirmed }) : null)
  });
  await openDialog(doc);
  doc.querySelector('[data-order-view="list"]').click();
  await settle();
  assert.equal(doc.getElementById('vtOrderList').hidden, false);
  const rows = [...doc.querySelectorAll('#vtOrderListRows tr.is-link')];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /XK-HN-00001.*Đơn tạm/, 'đơn tạm ở đầu');
  assert.match(rows[1].textContent, /XK-HN-00000.*Đã chốt.*Quản lý B/);
  assert.match(doc.getElementById('vtOrderListNote').textContent, /1 đơn tạm · 1 đơn đã chốt/);
  rows[1].click();
  await settle();
  assert.equal(doc.getElementById('vtOrderDetail').hidden, false);
  assert.match(doc.getElementById('vtOrderSubtitle').textContent, /Đã chốt .* bởi Quản lý B/);
  assert.match(doc.querySelector('#vtOrderDetailRows .vt-order-neg').textContent, /-2T x 100/);
  assert.match(doc.getElementById('vtOrderDetailNote').textContent, /1 vị trí âm/);
  doc.getElementById('vtOrderBack').click();
  await settle();
  assert.equal(doc.getElementById('vtOrderList').hidden, false, 'Quay lại về danh sách');
});

test('Danh sách đơn: đơn tạm chưa có dòng nào thì không hiện như một đơn', async t => {
  const { doc } = await setup(t, { order: draft([]), historyRows: [] });
  await openDialog(doc);
  doc.querySelector('[data-order-view="list"]').click();
  await settle();
  assert.equal(doc.querySelectorAll('#vtOrderListRows tr.is-link').length, 0);
  assert.match(doc.getElementById('vtOrderListRows').textContent, /Chưa có đơn nào/);
  assert.doesNotMatch(doc.getElementById('vtOrderListNote').textContent, /đơn tạm/);
});

test('Danh sách đơn: bấm đơn tạm mở lại tab Đơn tạm; ô tìm lọc theo mã đơn / người', async t => {
  const confirmed = draft([], { id: 6, code: 'XK-HN-00000', status: 'confirmed', confirmedAt: '2026-11-02T10:00:00.000Z', confirmedByName: 'Lan', summary: { lines: 2, positions: 2, quantity: 5, negative: 0, removed: 0, created: 0 } });
  const { doc, window } = await setup(t, { historyRows: [{ ...confirmed, lineCount: 2 }] });
  await openDialog(doc);
  doc.querySelector('[data-order-view="list"]').click();
  await settle();
  const search = doc.getElementById('vtOrderSearch');
  const type = value => { search.value = value; search.dispatchEvent(new window.Event('input')); };
  type('lan');
  assert.deepEqual([...doc.querySelectorAll('#vtOrderListRows .vt-order-ordercode')].map(td => td.textContent), ['XK-HN-00000']);
  type('zzz');
  assert.match(doc.getElementById('vtOrderListRows').textContent, /Không có đơn nào khớp/);
  type('');
  doc.querySelector('#vtOrderListRows tr.is-link').click();
  await settle();
  assert.equal(doc.getElementById('vtOrderCurrent').hidden, false);
  assert.match(doc.getElementById('vtOrderSubtitle').textContent, /XK-HN-00001 · Đơn tạm/);
});

test('Xuất kho Excel: tab chỉ hiện khi được sửa; chọn file → Trừ kho gửi POST theo cơ sở, hiện kết quả + dòng bỏ qua, tải lại bảng', async t => {
  const readonly = await setup(t, { canEdit: false });
  await openDialog(readonly.doc);
  assert.equal(readonly.doc.getElementById('vtOrderExcelTab').hidden, true);
  assert.equal(readonly.doc.getElementById('vtStockOutButton'), null, 'nút Xuất kho riêng ở thanh công cụ đã gỡ');

  const result = {
    fileName: 'xuat.xlsx',
    counts: { fileRows: 3, applied: 2, updated: 1, deleted: 1, skipped: 1, quantity: 250 },
    errors: [{ row: 4, code: 'ZZZ9', location: 'K9', notes: '1T x 5', message: 'Không có dòng nào cùng mã hàng và vị trí trong cơ sở này.' }],
    errorsTruncated: false
  };
  const { doc, calls, window } = await setup(t, {
    handler: async parsed => (parsed.pathname === '/api/stock-positions/stock-out' ? json(result) : null)
  });
  await openDialog(doc);
  const tab = doc.getElementById('vtOrderExcelTab');
  assert.equal(tab.hidden, false);
  tab.click();
  await settle();
  assert.equal(doc.getElementById('vtOrderExcel').hidden, false);
  assert.equal(doc.getElementById('vtOrderCurrent').hidden, true);
  assert.match(doc.getElementById('vtOrderSubtitle').textContent, /VT Hà Nội · Xuất kho Excel/);
  assert.equal(doc.getElementById('vtStockOutRun').disabled, true, 'chưa chọn file thì không trừ được');
  const input = doc.getElementById('vtStockOutFile');
  Object.defineProperty(input, 'files', { value: [new window.File(['x'], 'xuat.xlsx')], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('vtStockOutFileName').textContent, 'xuat.xlsx');
  assert.equal(doc.getElementById('vtStockOutRun').disabled, false);
  doc.getElementById('vtStockOutRun').click();
  doc.getElementById('vtStockOutRun').click();
  await settle();
  const posts = calls.filter(c => c.path === '/api/stock-positions/stock-out');
  assert.equal(posts.length, 1, 'chặn bấm lặp khi đang gửi');
  assert.equal(posts[0].method, 'POST');
  assert.equal(posts[0].query.get('branch'), 'HN');
  assert.equal(posts[0].body.get('file').name, 'xuat.xlsx');
  assert.ok(doc.getElementById('vtOrderDialog').hasAttribute('open'), 'giữ hộp để xem kết quả');
  assert.deepEqual([...doc.querySelectorAll('#vtStockOutResult li')].map(li => li.dataset.count + ':' + li.querySelector('b').textContent),
    ['applied:2', 'deleted:1', 'skipped:1', 'quantity:250']);
  assert.equal(doc.getElementById('vtStockOutErrorsBox').hidden, false);
  assert.deepEqual([...doc.querySelectorAll('#vtStockOutErrorRows tr td')].map(td => td.textContent),
    ['4', 'ZZZ9', 'K9', '1T x 5', 'Không có dòng nào cùng mã hàng và vị trí trong cơ sở này.']);
  assert.equal(doc.getElementById('vtStockOutRun').hidden, true);
  assert.equal(doc.getElementById('vtStockOutBack').hidden, false);
  assert.match(doc.getElementById('vtNotice').textContent, /trừ 2 dòng, xóa 1 dòng hết hàng, bỏ qua 1 dòng/);
  assert.ok(calls.filter(c => c.method === 'GET' && c.path === '/api/stock-positions').length >= 2, 'tải lại bảng sau khi trừ');
  doc.getElementById('vtStockOutBack').click();
  assert.equal(doc.getElementById('vtStockOutPickPanel').hidden, false);
  assert.equal(doc.getElementById('vtStockOutRun').hidden, false);
});

test('Xuất kho Excel: lỗi từ máy chủ / mất kết nối báo trong tab và cho thử lại', async t => {
  let mode = 'server';
  const { doc, calls, window } = await setup(t, {
    handler: async parsed => {
      if (parsed.pathname !== '/api/stock-positions/stock-out') return null;
      if (mode === 'offline') throw new TypeError('Failed to fetch');
      return json({ error: 'File thiếu cột: Vị trí.', code: 'IMPORT_HEADERS_MISSING' }, 400);
    }
  });
  await openDialog(doc);
  doc.getElementById('vtOrderExcelTab').click();
  await settle();
  const input = doc.getElementById('vtStockOutFile');
  Object.defineProperty(input, 'files', { value: [new window.File(['x'], 'xuat.csv')], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  doc.getElementById('vtStockOutRun').click();
  await settle();
  assert.equal(calls.find(c => c.path === '/api/stock-positions/stock-out').query.get('branch'), 'HN');
  assert.match(doc.getElementById('vtStockOutError').textContent, /File thiếu cột: Vị trí/);
  assert.equal(doc.getElementById('vtStockOutRun').disabled, false, 'lỗi không khóa nút thử lại');
  assert.equal(doc.getElementById('vtStockOutReview').hidden, true);
  mode = 'offline';
  doc.getElementById('vtStockOutRun').click();
  await settle();
  assert.match(doc.getElementById('vtStockOutError').textContent, /Không kết nối được máy chủ/);
  assert.equal(doc.getElementById('vtStockOutRun').disabled, false);
  assert.ok(doc.getElementById('vtOrderDialog').hasAttribute('open'));
});

test('Lịch sử VT: dòng chốt đơn có nút "Xem đơn" mở chi tiết đơn xuất kho', async t => {
  const confirmed = draft([line(1, { result: { before: '5T x 100', after: 'Hết hàng', negative: false, created: false }, preview: null })], { status: 'confirmed', confirmedAt: '2026-11-02T10:00:00.000Z', confirmedByName: 'Quản lý B', summary: null });
  const entry = { id: 5, createdAt: '2026-11-02T10:00:00.000Z', branch: 'HN', code: 'AAA1', location: 'A1', action: 'stock_out', field: 'notes', oldValue: '5T x 100', newValue: '-2T x 100', summary: { source: 'order', orderId: 7, orderCode: 'XK-HN-00001', deducted: 700, negative: true }, actorName: 'Quản lý B' };
  const { doc } = await setup(t, {
    handler: async parsed => {
      if (parsed.pathname === '/api/stock-positions/history') return json({ rows: [entry], nextBefore: null });
      if (parsed.pathname === '/api/stock-positions/stock-out-orders/7') return json({ order: confirmed });
      return null;
    }
  });
  doc.getElementById('vtHistoryButton').click();
  await settle();
  const link = doc.querySelector('#vtHistoryRows .vt-hist-order');
  assert.ok(link, 'có nút mở đơn');
  assert.match(link.textContent, /XK-HN-00001/);
  assert.match(doc.querySelector('#vtHistoryRows .vt-hist-summary').textContent, /Đơn xuất kho XK-HN-00001/);
  link.click();
  await settle();
  assert.equal(doc.getElementById('vtOrderDialog').hasAttribute('open'), true);
  assert.equal(doc.getElementById('vtOrderDetail').hidden, false);
  assert.match(doc.getElementById('vtOrderSubtitle').textContent, /XK-HN-00001/);
});

test('Xuất Excel đơn: nút chỉ hiện khi có quyền export và đơn có dòng; bấm gọi GET /:id/export rồi tải file', async t => {
  const hidden = await setup(t, { canExport: false });
  await openDialog(hidden.doc);
  assert.equal(hidden.doc.getElementById('vtOrderExport').hidden, true);

  const { window, doc, calls } = await setup(t, { canExport: true, handler: async parsed => {
    if (parsed.pathname === '/api/stock-positions/stock-out-orders/7/export') {
      return { ok: true, status: 200, headers: { get: () => 'attachment; filename="don-xuat-kho_xk-hn-00001_20261108_1000.xlsx"' }, blob: async () => new window.Blob(['x']) };
    }
    return null;
  } });
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  const downloads = [];
  window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  await openDialog(doc);
  const button = doc.getElementById('vtOrderExport');
  assert.equal(button.hidden, false);
  button.click();
  await settle();
  assert.ok(calls.some(call => call.method === 'GET' && call.path === '/api/stock-positions/stock-out-orders/7/export'));
  assert.deepEqual(downloads, ['don-xuat-kho_xk-hn-00001_20261108_1000.xlsx']);
  assert.equal(button.disabled, false);
});

test('Xuất Excel đơn: đơn tạm chưa có dòng thì ẩn nút', async t => {
  const { doc } = await setup(t, { canExport: true, order: draft([]) });
  await openDialog(doc);
  assert.equal(doc.getElementById('vtOrderExport').hidden, true);
});
