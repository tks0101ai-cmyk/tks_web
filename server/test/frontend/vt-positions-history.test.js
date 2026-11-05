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
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const row = id => ({ id, code: 'MA' + id, name: 'Hàng ' + id, notes: '2T x 100', arrivalDate: '', location: 'K' + id, quantity: 200, kiotQuantity: 350, warnings: [], updatedByName: 'Quản lý', updatedAt: '2026-10-27T02:30:00.000Z', version: 3 });

const ENTRIES = [
  { id: 30, createdAt: '2026-10-27T03:00:00Z', branch: 'HN', code: 'AAA', location: 'K1', action: 'edit', field: 'notes', oldValue: '1T x 5', newValue: '2T x 5', actorName: 'Lan' },
  { id: 29, createdAt: '2026-10-27T02:30:00Z', branch: 'HN', code: 'AAA', location: 'K1', action: 'edit', field: 'location', oldValue: 'K1', newValue: 'K2', actorName: 'Lan' },
  { id: 28, createdAt: '2026-10-27T02:00:00Z', branch: 'HN', code: 'BBB', location: 'K3', action: 'seed', field: null, oldValue: null, newValue: '41T x 250', actorName: 'Nhập dữ liệu đầu' },
  { id: 27, createdAt: '2026-10-27T01:00:00Z', branch: 'HN', code: 'CCC', location: 'K4', action: 'delete', field: null, oldValue: '3T x 10', newValue: null, actorName: 'Minh' },
  { id: 26, createdAt: '2026-10-27T00:30:00Z', branch: 'HN', code: '', location: '', action: 'import_add', field: null, summary: { added: 3, updated: 1, deleted: 0, skippedEmpty: 2, fileName: 'a.xlsx' }, actorName: 'Minh' }
];

async function setup(t, { canExport = true, exportResponse, entries = ENTRIES } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vt-positions/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/carton.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const base = resolvePermissions({ vaiTro: 'Quản lý' });
  const user = { vaiTro: 'Quản lý', branch: 'Cả hai', permissions: [...new Set([...base, 'stockLocationsV2.view', 'stockLocationsV2.edit'])], pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return json({ tables: {} });
    calls.push({ path: parsed.pathname, query: parsed.searchParams, options });
    if (parsed.pathname === '/api/stock-positions') return json({ branch: parsed.searchParams.get('branch'), canEdit: true, canExport, rows: [row(1)] });
    if (parsed.pathname === '/api/stock-positions/history') return json({ rows: entries, nextBefore: null });
    if (parsed.pathname === '/api/stock-positions/history/export') {
      return exportResponse || { ok: true, status: 200, headers: { get: name => (name === 'Content-Disposition' ? 'attachment; filename="vt_hn_lich-su_20261027_1000.xlsx"' : null) }, blob: async () => ({ size: 3 }) };
    }
    return json({ error: 'Không có mock' }, 500);
  };
  window.eval(code);
  await window.TKSVtPositions.init();
  return { window, doc: window.document, calls };
}

const openHistory = async ({ doc }) => { doc.getElementById('vtHistoryButton').click(); await settle(); };

test('hộp Lịch sử: đầu hộp có icon, dòng phụ "N thay đổi" (không hứa lưu vĩnh viễn) và bảng 5 cột', async t => {
  const ctx = await setup(t);
  await openHistory(ctx);
  const { doc } = ctx;
  assert.equal(doc.getElementById('vtHistoryTitle').textContent, 'Lịch sử cập nhật · VT Hà Nội');
  assert.equal(doc.getElementById('vtHistorySubtitle').textContent, '5 thay đổi');
  assert.ok(doc.querySelector('#vtHistoryDialog .vt-hist-icon svg'));
  assert.deepEqual([...doc.querySelectorAll('#vtHistoryTable thead th')].map(th => th.textContent), ['Thời gian', 'Người thực hiện', 'Hành động', 'Mã hàng / Vị trí', 'Thay đổi']);
  assert.equal(doc.querySelectorAll('#vtHistoryRows tr:first-child td').length, 5);
  assert.match(doc.querySelector('link[href^="/vt-positions/vt-history.css"]').getAttribute('href'), /vt-history\.css\?v=/);
});

test('cột Thay đổi: cũ gạch ngang → mới, nhãn trường khác Ghi chú, Tạo mới, Đã xóa, tóm tắt import', async t => {
  const ctx = await setup(t);
  await openHistory(ctx);
  const rows = [...ctx.doc.querySelectorAll('#vtHistoryRows tr')];
  const edit = rows[0].querySelector('.vt-hist-change');
  assert.equal(edit.textContent, '1T x 5 → 2T x 5');
  assert.equal(edit.querySelector('del.vt-hist-old').textContent, '1T x 5');
  assert.equal(edit.querySelector('ins.vt-hist-new').textContent, '2T x 5');
  assert.equal(edit.querySelector('.vt-hist-field'), null, 'Ghi chú không cần nhãn trường');
  assert.equal(rows[1].querySelector('.vt-hist-change').textContent, 'Vị trí: K1 → K2');
  assert.equal(rows[2].querySelector('.vt-hist-change').textContent, 'Tạo mới: 41T x 250');
  assert.equal(rows[3].querySelector('.vt-hist-change').textContent, 'Đã xóa: 3T x 10');
  assert.equal(rows[4].querySelector('.vt-hist-change').textContent, 'Thêm 3 · Đổi 1 · Xóa 0 · Bỏ qua 2 · a.xlsx');
});

test('pill hành động có màu theo loại và vẫn có chữ', async t => {
  const ctx = await setup(t);
  await openHistory(ctx);
  const pills = [...ctx.doc.querySelectorAll('#vtHistoryRows .vt-hist-pill')].map(p => [p.textContent, p.dataset.tone]);
  assert.deepEqual(pills, [['Sửa', 'blue'], ['Sửa', 'blue'], ['Nhập dữ liệu đầu', 'neutral'], ['Xóa dòng', 'red'], ['Import bổ sung', 'green']]);
  const css = fs.readFileSync(path.join(publicDir, 'vt-positions/vt-history.css'), 'utf8');
  assert.match(css, /\.vt-hist-old\{[^}]*line-through/);
  assert.match(css, /\.vt-hist-new\{[^}]*var\(--green\)/);
});

test('nút Xuất Excel trong hộp chỉ hiện khi canExport', async t => {
  const hidden = await setup(t, { canExport: false });
  await openHistory(hidden);
  assert.equal(hidden.doc.getElementById('vtHistoryExport').hidden, true);
  const shown = await setup(t, { canExport: true });
  await openHistory(shown);
  assert.equal(shown.doc.getElementById('vtHistoryExport').hidden, false);
});

test('Xuất Excel lịch sử gọi history/export kèm branch, action, q và tải file theo Content-Disposition', async t => {
  const ctx = await setup(t);
  await openHistory(ctx);
  const { doc, window, calls } = ctx;
  const downloads = [];
  window.URL.createObjectURL = blob => { downloads.push({ blob }); return 'blob:hist'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.at(-1).name = this.download; downloads.at(-1).href = this.href; };

  doc.getElementById('vtHistoryExport').click();
  await settle();
  let call = calls.filter(c => c.path === '/api/stock-positions/history/export').at(-1);
  assert.equal(call.query.get('branch'), 'HN');
  assert.equal(call.query.has('action'), false);
  assert.equal(call.query.has('q'), false);
  assert.equal(call.options.credentials, 'same-origin');
  assert.equal(downloads[0].name, 'vt_hn_lich-su_20261027_1000.xlsx');
  assert.equal(downloads[0].href, 'blob:hist');

  doc.getElementById('vtHistoryAction').value = 'edit';
  doc.getElementById('vtHistorySearch').value = ' lan ';
  doc.getElementById('vtHistoryExport').click();
  await settle();
  call = calls.filter(c => c.path === '/api/stock-positions/history/export').at(-1);
  assert.equal(call.query.get('action'), 'edit');
  assert.equal(call.query.get('q'), 'lan');
});

test('Xuất Excel lịch sử lỗi: báo trong dòng phụ và bật lại nút', async t => {
  const ctx = await setup(t, { exportResponse: json({ error: 'Không đủ quyền' }, 403) });
  await openHistory(ctx);
  ctx.doc.getElementById('vtHistoryExport').click();
  await settle();
  assert.equal(ctx.doc.getElementById('vtHistorySubtitle').textContent, 'Không đủ quyền');
  assert.equal(ctx.doc.getElementById('vtHistoryExport').disabled, false);
});

test('cột Thay đổi: bỏ Đã sửa (warnings rỗng) không để trống; dòng nhặt hàng hiện chữ thay vì JSON', async t => {
  const entries = [
    { id: 3, createdAt: '2026-10-27T03:00:00Z', branch: 'HN', code: 'AAA', location: 'K1', action: 'unack', field: null, summary: { warnings: [] }, actorName: 'Lan' },
    { id: 2, createdAt: '2026-10-27T02:00:00Z', branch: 'HN', code: 'AAA', location: 'K1', action: 'pick', field: null, summary: { orderCode: 'DH1', assignmentId: 7, confirmedBy: 'Hà', picked: 12 }, actorName: 'Lan' },
    { id: 1, createdAt: '2026-10-27T01:00:00Z', branch: 'HN', code: 'AAA', location: 'K1', action: 'pick', field: null, summary: { orderCode: 'DH2', assignmentId: 8, confirmedBy: '', picked: 5 }, actorName: 'Job' }
  ];
  const ctx = await setup(t, { entries });
  await openHistory(ctx);
  const cells = [...ctx.doc.querySelectorAll('#vtHistoryRows .vt-hist-change')].map(td => td.textContent);
  assert.notEqual(cells[0], '');
  assert.equal(cells[0], 'Không có cảnh báo');
  assert.equal(cells[1], 'Nhặt 12 · Xác nhận: Hà');
  assert.equal(cells[2], 'Nhặt 5 · Job Kiot');
  assert.ok(!cells.join('').includes('{'));
});

test('cột Thay đổi: sửa/thêm/xóa VT từ hộp Chỉ định vị trí (source pick) hiện cũ → mới kèm "Chỉ định đơn X"', async t => {
  const entries = [
    { id: 3, createdAt: '2026-10-31T03:00:00Z', branch: 'HN', code: 'AAA', location: 'K1', action: 'edit', field: 'notes', oldValue: '4T x 50', newValue: '5T x 50', summary: { orderCode: 'DH1', source: 'pick' }, actorName: 'Lan' },
    { id: 2, createdAt: '2026-10-31T02:00:00Z', branch: 'HN', code: 'AAA', location: 'K9', action: 'create', field: null, oldValue: null, newValue: '1T x 50', summary: { orderCode: 'DH1', source: 'pick' }, actorName: 'Lan' },
    { id: 1, createdAt: '2026-10-31T01:00:00Z', branch: 'HN', code: 'AAA', location: 'K2', action: 'delete', field: null, oldValue: '2T x 25', newValue: null, summary: { orderCode: 'DH2', source: 'pick' }, actorName: 'Lan' }
  ];
  const ctx = await setup(t, { entries });
  await openHistory(ctx);
  const cells = [...ctx.doc.querySelectorAll('#vtHistoryRows .vt-hist-change')];
  assert.equal(cells[0].querySelector('del.vt-hist-old').textContent, '4T x 50');
  assert.equal(cells[0].querySelector('ins.vt-hist-new').textContent, '5T x 50');
  assert.equal(cells[0].textContent, '4T x 50 → 5T x 50  Chỉ định đơn DH1');
  assert.equal(cells[1].textContent, '1T x 50  Chỉ định đơn DH1');
  assert.equal(cells[2].textContent, '2T x 25  Chỉ định đơn DH2');
  assert.ok(!cells.map(c => c.textContent).join('').includes('{'));
});
