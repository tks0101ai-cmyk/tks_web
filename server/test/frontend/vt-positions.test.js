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

const row = (id, extra = {}) => ({
  id, code: 'MA' + id, name: 'Hàng ' + id, notes: '2T x 100', arrivalDate: '', location: 'K' + id,
  quantity: 200, held: 0, available: 200, kiotQuantity: 350, warnings: [], updatedByName: 'Quản lý', updatedAt: '2026-10-27T02:30:00.000Z', version: 3, ...extra
});
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// handlers: hàm (url, options, parsed) trả về response giả cho các lệnh không phải GET danh sách.
async function setup(t, { branch = 'Cả hai', hash = '', data = { HN: [row(1)], SG: [row(2)] }, canEdit = true, canExport = false, permissions, handler, width = 1024 } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vt-positions/' + hash, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true });
  const media = { matches: width <= 600, addEventListener() {} };
  window.matchMedia = () => media;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/carton.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const base = resolvePermissions({ vaiTro: 'Quản lý' });
  const user = {
    vaiTro: 'Quản lý', branch,
    permissions: permissions || [...new Set([...base, 'stockLocationsV2.view', 'stockLocationsV2.edit'])],
    pageFeatures: PAGE_FEATURES
  };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return json({ tables: {} });
    const method = options.method || 'GET';
    calls.push({ method, path: parsed.pathname, query: parsed.searchParams, options });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions') {
      const target = parsed.searchParams.get('branch');
      return json({ branch: target, canEdit, canExport, rows: data[target] });
    }
    if (method === 'GET' && parsed.pathname === '/api/stock-positions/export') {
      return { ok: true, status: 200, headers: { get: name => (name === 'Content-Disposition' ? 'attachment; filename="VT-HN-2026.xlsx"' : null) }, blob: async () => ({ size: 3 }) };
    }
    if (handler) { const answer = await handler(url, options, parsed); if (answer) return answer; }
    return json({ error: 'Không có mock', code: 'NO_MOCK' }, 500);
  };
  window.eval(code);
  await window.TKSVtPositions.init();
  return {
    window, calls, doc: window.document,
    changeTab: async tab => {
      const event = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true }));
      window.location.hash = tab;
      await event;
      await tick();
    }
  };
}

const optionTexts = doc => [...doc.querySelectorAll('#vtWarnFilter option')].map(option => option.textContent);
const pickFilter = (doc, window, value) => {
  const select = doc.getElementById('vtWarnFilter');
  select.value = value;
  select.dispatchEvent(new window.Event('change'));
};

test('import review: column resizing and sorting cover the full filtered draft before paging', async t => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ row: i + 2, code: 'MA' + i, kind: 'add', quantity: i, cartons: i, location: 'K' + i, warnings: i === 150 ? ['multi'] : [] }));
  rows.push({ row: null, code: 'EMPTY', kind: 'add', quantity: null, cartons: null, warnings: [] });
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => parsed.pathname.endsWith('/import') ? json({ counts: { added: rows.length }, rows }) : null });
  doc.getElementById('vtImportButton').click();
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  const table = doc.getElementById('vtImportPreviewTable');
  assert.equal(table.querySelectorAll('th > .tks-column-resizer').length, 10);
  const firstCode = () => doc.querySelector('#vtImportPreviewRows tr .vt-import-code').textContent;
  assert.equal(firstCode(), 'MA150');
  const sort = table.querySelector('[data-import-sort="quantity"]');
  sort.click();
  assert.equal(firstCode(), 'MA0');
  assert.equal(sort.closest('th').getAttribute('aria-sort'), 'ascending');
  doc.getElementById('vtImportNextPage').click();
  assert.equal(firstCode(), 'MA100');
  sort.click();
  assert.equal(firstCode(), 'MA204');
  assert.match(doc.getElementById('vtImportPage').textContent, /Trang 1/);
  doc.getElementById('vtImportNextPage').click();
  doc.getElementById('vtImportNextPage').click();
  assert.equal(doc.querySelector('#vtImportPreviewRows tr:last-child .vt-import-code').textContent, 'EMPTY');
  sort.click();
  assert.equal(firstCode(), 'MA150');
  assert.equal(sort.closest('th').getAttribute('aria-sort'), 'none');
  const search = doc.getElementById('vtImportSearch');
  search.value = 'MA20';
  search.dispatchEvent(new window.Event('input'));
  sort.click();
  assert.equal(firstCode(), 'MA20');
  const handle = sort.closest('th').querySelector('.tks-column-resizer');
  const before = window.TKSTables.getState(table).columns[5].width;
  handle.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.ok(window.TKSTables.getState(table).columns[5].width > before);
  assert.equal(sort.closest('th').getAttribute('aria-sort'), 'ascending');
});

test('import review: warnings first, combined filters/search and paging include rows past 300', async t => {
  const inputs = Array.from({ length: 305 }, (_, i) => ({ row: i + 2, code: 'AAA' + i, notes: '1T x 10', location: 'A' + i }));
  const rows = inputs.map((r, i) => ({ ...r, kind: 'add', sourceIndexes: [i], warnings: i === 304 ? ['multi'] : [], name: i === 304 ? 'Miếng tẩy' : 'Hàng', cartons: 1, quantity: 10 }));
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => parsed.pathname.endsWith('/import') ? json({ counts: { added: 305 }, inputRows: inputs, rows }) : null });
  doc.getElementById('vtImportButton').click();
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  assert.match(doc.querySelector('#vtImportPreviewRows tr').textContent, /AAA304/);
  assert.equal(doc.querySelectorAll('#vtImportPreviewRows tr').length, 100);
  const search = doc.getElementById('vtImportSearch');
  search.value = 'mieng tay';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(doc.querySelectorAll('#vtImportPreviewRows tr').length, 1);
  doc.getElementById('vtImportWarnFilter').value = 'warn';
  doc.getElementById('vtImportWarnFilter').dispatchEvent(new window.Event('change'));
  assert.match(doc.querySelector('#vtImportPreviewRows tr').textContent, /Nhiều quy cách/);
  search.value = 'A0';
  search.dispatchEvent(new window.Event('input'));
  assert.match(doc.querySelector('#vtImportPreviewRows').textContent, /Không có dòng/);
});

test('import review: edit uses raw sources, add/remove recalculate and commit the exact edited draft', async t => {
  let received;
  const initial = [{ row: 2, code: 'AAA1', notes: '2T x 100', location: 'A1', name: '', arrivalDate: '' }];
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => {
    if (!parsed.pathname.endsWith('/import')) return null;
    received = options.body.get('rows') ? JSON.parse(options.body.get('rows')) : initial;
    return json({ counts: { updated: received.length }, inputRows: received, rows: received.map((r, i) => ({ ...r, kind: 'update', notes: '7T x 100', sourceIndexes: [i], warnings: [], quantity: 700 })) });
  } });
  doc.getElementById('vtImportButton').click();
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  doc.querySelector('[data-import-edit]').click();
  assert.equal(doc.querySelector('#vtImportEditor [data-field="notes"]').value, '2T x 100');
  assert.equal(doc.getElementById('vtImportConfirm').disabled, true);
  doc.querySelector('#vtImportEditor [data-field="notes"]').value = '4T x 100';
  doc.getElementById('vtImportSave').click();
  await settle();
  assert.equal(received[0].notes, '4T x 100');
  doc.getElementById('vtImportAdd').click();
  doc.querySelector('#vtImportEditor [data-field="code"]').value = 'BBB2';
  doc.querySelector('#vtImportEditor [data-field="notes"]').value = '1T x 20';
  doc.getElementById('vtImportSave').click();
  await settle();
  assert.equal(received.length, 2);
  doc.querySelector('[data-import-remove]').click();
  await settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].code, 'BBB2');
  doc.getElementById('vtImportConfirm').click();
  await settle();
  assert.equal(received[0].notes, '1T x 20');
  assert.equal(doc.getElementById('vtImportDialog').open, false);
});

test('import review: merged source editor saves each original once and cancel changes nothing', async t => {
  let draft = [
    { row: 2, code: 'AAA1', notes: '2T x 100', location: 'A1' },
    { row: 3, code: 'AAA1', notes: '1T x 100', location: 'A1' }
  ];
  let submissions = 0;
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => {
    if (!parsed.pathname.endsWith('/import')) return null;
    submissions += 1;
    if (options.body.get('rows')) draft = JSON.parse(options.body.get('rows'));
    return json({ counts: { updated: 1 }, inputRows: draft, rows: [{ kind: 'update', code: 'AAA1', notes: '8T x 100', location: 'A1', sourceIndexes: [0, 1], warnings: [] }] });
  } });
  doc.getElementById('vtImportButton').click();
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  doc.querySelector('[data-import-edit]').click();
  const groups = [...doc.querySelectorAll('#vtImportEditor fieldset')];
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map(group => group.querySelector('[data-field="notes"]').value), ['2T x 100', '1T x 100']);
  groups[0].querySelector('[data-field="notes"]').value = '9T x 100';
  doc.getElementById('vtImportCancelEdit').click();
  assert.equal(submissions, 1);
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
  doc.querySelector('[data-import-edit]').click();
  assert.equal(doc.querySelector('#vtImportEditor [data-field="notes"]').value, '2T x 100');
  doc.querySelector('#vtImportEditor [data-field="notes"]').value = '4T x 100';
  doc.getElementById('vtImportSave').click();
  await settle();
  assert.deepEqual(draft.map(source => source.notes), ['4T x 100', '1T x 100']);
  assert.equal(submissions, 2);
});

test('import review: keep planned deletion submits existing row into replace draft', async t => {
  let draft = [{ row: 2, code: 'AAA1', notes: '1T x 10', location: 'A1' }];
  const removed = { kind: 'delete', code: 'BBB2', name: 'Hàng B', notes: '2T x 20', arrivalDate: '25/10', location: 'B2', sourceIndexes: [], warnings: [] };
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => {
    if (!parsed.pathname.endsWith('/import')) return null;
    if (options.body.get('rows')) draft = JSON.parse(options.body.get('rows'));
    return json({ counts: { deleted: draft.length === 1 ? 1 : 0 }, inputRows: draft, rows: [
      { ...draft[0], kind: 'add', sourceIndexes: [0], warnings: [] },
      ...(draft.length === 1 ? [removed] : [{ ...draft[1], kind: 'unchanged', sourceIndexes: [1], warnings: [] }])
    ] });
  } });
  doc.getElementById('vtImportButton').click();
  doc.querySelector('input[name="vtImportMode"][value="replace"]').checked = true;
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  doc.querySelector('[data-import-keep]').click();
  await settle();
  assert.deepEqual(draft[1], { row: null, code: 'BBB2', name: 'Hàng B', notes: '2T x 20', arrivalDate: '25/10', location: 'B2' });
  assert.equal(doc.querySelector('[data-import-keep]'), null);
  assert.equal(doc.querySelector('[data-count="deleted"] b').textContent, '0');
});

test('import review: deleting the last source blocks commit but a new row can restore the draft', async t => {
  let draft = [{ row: 2, code: 'AAA1', notes: '1T x 10', location: 'A1' }];
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => {
    if (!parsed.pathname.endsWith('/import')) return null;
    if (options.body.get('rows')) draft = JSON.parse(options.body.get('rows'));
    return json({ counts: { added: draft.length }, inputRows: draft, rows: draft.map((source, index) => ({ ...source, kind: 'add', sourceIndexes: [index], warnings: [] })) });
  } });
  doc.getElementById('vtImportButton').click();
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  doc.querySelector('[data-import-remove]').click();
  await settle();
  assert.equal(doc.getElementById('vtImportConfirm').disabled, true);
  assert.equal(doc.getElementById('vtImportAdd').disabled, false);
  doc.getElementById('vtImportAdd').click();
  doc.querySelector('#vtImportEditor [data-field="code"]').value = 'BBB2';
  doc.querySelector('#vtImportEditor [data-field="notes"]').value = '3T x 20';
  doc.getElementById('vtImportSave').click();
  await settle();
  assert.equal(draft.length, 1);
  assert.equal(draft[0].code, 'BBB2');
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
});

test('import review: errors allow commit; failed recalculation retains edits until retry succeeds', async t => {
  let failRefresh = false;
  let draft;
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => {
    if (!parsed.pathname.endsWith('/import')) return null;
    if (failRefresh) throw new Error('offline');
    draft = options.body.get('rows') ? JSON.parse(options.body.get('rows')) : [{ row: 2, code: '', notes: 'bad' }];
    return json({ counts: { errors: draft[0].code ? 0 : 1 }, inputRows: draft, rows: [{ ...draft[0], kind: draft[0].code ? 'add' : 'error', sourceIndexes: [0], warnings: [], message: draft[0].code ? '' : 'Thiếu mã hàng.' }] });
  } });
  doc.getElementById('vtImportButton').click();
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
  doc.querySelector('[data-import-edit]').click();
  doc.querySelector('#vtImportEditor [data-field="code"]').value = 'ZZZ9';
  failRefresh = true;
  doc.getElementById('vtImportSave').click();
  await settle();
  assert.equal(doc.getElementById('vtImportConfirm').disabled, true);
  assert.equal(doc.getElementById('vtImportRetry').hidden, false);
  doc.querySelector('#vtImportFilter [data-kind="error"]').click();
  assert.equal(doc.querySelector('[data-import-edit]').disabled, true, 'stale source indexes cannot be used after rerender');
  assert.equal(doc.querySelector('[data-import-remove]').disabled, true);
  failRefresh = false;
  doc.getElementById('vtImportRetry').click();
  await settle();
  assert.equal(draft[0].code, 'ZZZ9');
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
});

test('import review: pending recalculation prevents close and escape until the draft is checked', async t => {
  let release;
  const draft = [{ row: 2, code: 'AAA1', notes: '1T x 10', location: 'A1' }];
  const answer = source => ({ counts: { added: 1 }, inputRows: source, rows: [{ ...source[0], kind: 'add', sourceIndexes: [0], warnings: [] }] });
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => {
    if (!parsed.pathname.endsWith('/import')) return null;
    if (options.body.get('rows')) return new Promise(resolve => { release = () => resolve(json(answer(JSON.parse(options.body.get('rows'))))); });
    return json(answer(draft));
  } });
  doc.getElementById('vtImportButton').click();
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  doc.querySelector('[data-import-edit]').click();
  doc.querySelector('#vtImportEditor [data-field="notes"]').value = '2T x 10';
  doc.getElementById('vtImportSave').click();
  await settle();
  const dialog = doc.getElementById('vtImportDialog');
  const escape = new window.Event('cancel', { cancelable: true });
  dialog.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, true);
  const closes = [...dialog.querySelectorAll('[data-vt-close]')];
  assert.ok(closes.length);
  assert.ok(closes.every(button => button.disabled));
  assert.equal(doc.getElementById('vtImportButton').disabled, true, 'a pending import cannot be reset by reopening the modal');
  doc.getElementById('vtImportButton').dispatchEvent(new window.Event('click'));
  assert.equal(doc.getElementById('vtImportConfirm').disabled, true);
  closes[0].click();
  assert.equal(dialog.open, true);
  assert.equal(doc.getElementById('vtImportConfirm').disabled, true);
  release();
  await settle();
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
  assert.ok(closes.every(button => !button.disabled));
  assert.equal(doc.getElementById('vtImportButton').disabled, false);
});

test('import review: duplicate existing key cannot be kept by adding the same quantity again', async t => {
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => {
    if (!parsed.pathname.endsWith('/import')) return null;
    return json({ counts: { unchanged: 1, deleted: 1 }, inputRows: [{ row: 2, code: 'AAA1', notes: '2T x 10', location: 'A1' }], rows: [
      { kind: 'unchanged', code: 'AAA1', notes: '2T x 10', location: 'A1', sourceIndexes: [0], warnings: [] },
      { kind: 'delete', code: 'AAA1', notes: '1T x 10', location: ' a 1 ', sourceIndexes: [], warnings: [] }
    ] });
  } });
  doc.getElementById('vtImportButton').click();
  doc.querySelector('input[name="vtImportMode"][value="replace"]').checked = true;
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')] });
  doc.getElementById('vtImportPreview').click();
  await settle();
  assert.equal(doc.querySelector('[data-import-keep]'), null, 'keeping a duplicate through input addition would merge quantities');
});

test('hàng cảnh báo đổi chữ sang đỏ (không tô nền); bộ lọc Cảnh báo/Hợp lệ/Tất cả đếm và nhớ riêng từng tab', async t => {
  const data = {
    HN: [row(1, { warnings: ['multi'] }), row(2, { warnings: ['unknowncode', 'multi'], kiotQuantity: null }), row(3)],
    SG: [row(4, { warnings: ['unreadable'], quantity: null })]
  };
  const { doc, window, changeTab } = await setup(t, { data });
  assert.deepEqual(optionTexts(doc), ['Cảnh báo (2)', 'Hợp lệ (1)', 'Tất cả']);
  assert.equal(doc.getElementById('vtWarnFilter').value, 'all', 'mặc định Tất cả');
  assert.equal(doc.querySelectorAll('#vtRows tr.vt-warning').length, 2);
  assert.equal(doc.querySelector('#vtRows tr[data-id="3"]').classList.contains('vt-warning'), false);
  assert.match(doc.querySelector('#vtRows tr[data-id="2"] .vt-badge').textContent, /Mã SP lạ, Nhiều quy cách/);
  const css = fs.readFileSync(path.join(publicDir, 'vt-positions/vt-positions.css'), 'utf8');
  assert.match(css, /tr\.vt-warning td\{color:var\(--red\)\}/);
  assert.doesNotMatch(css.match(/tr\.vt-warning td\{[^}]*\}/)[0], /background/);
  pickFilter(doc, window, 'warn');
  assert.deepEqual([...doc.querySelectorAll('#vtRows tr')].map(tr => tr.dataset.id), ['1', '2']);
  assert.equal(doc.getElementById('vtWarnFilter').parentElement.dataset.filter, 'warn');
  pickFilter(doc, window, 'valid');
  assert.deepEqual([...doc.querySelectorAll('#vtRows tr')].map(tr => tr.dataset.id), ['3']);
  assert.equal(doc.getElementById('vtWarnFilter').parentElement.dataset.filter, 'valid');
  pickFilter(doc, window, 'all');
  assert.equal(doc.querySelectorAll('#vtRows tr').length, 3);
  pickFilter(doc, window, 'warn');
  await changeTab('sg');
  assert.deepEqual(optionTexts(doc), ['Cảnh báo (1)', 'Hợp lệ (0)', 'Tất cả']);
  assert.equal(doc.getElementById('vtWarnFilter').value, 'all', 'bộ lọc cảnh báo giữ riêng từng tab');
  assert.equal(doc.querySelector('#vtRows [data-field="quantity"]').textContent, '', 'SL trống khi ghi chú sai định dạng');
});

test('bộ lọc cảnh báo: số đếm tính trên toàn bộ dòng (không theo từ khóa), rỗng thì báo đúng lý do, về trang 1 khi đổi', async t => {
  const rows = Array.from({ length: 130 }, (_, i) => row(i + 1, i < 3 ? { warnings: ['unreadable'] } : {}));
  const { doc, window } = await setup(t, { data: { HN: rows, SG: [] } });
  doc.getElementById('vtNext').click();
  assert.equal(doc.getElementById('vtPage').textContent, 'Trang 2 / 2');
  pickFilter(doc, window, 'warn');
  assert.equal(doc.getElementById('vtPage').textContent, 'Trang 1 / 1');
  const search = doc.getElementById('vtSearch');
  search.value = 'MA7';
  search.dispatchEvent(new window.Event('input'));
  assert.deepEqual(optionTexts(doc), ['Cảnh báo (3)', 'Hợp lệ (127)', 'Tất cả'], 'không đổi theo từ khóa');
  assert.equal(doc.getElementById('vtStatus').textContent, 'Không có dòng cảnh báo.');
  const noWarn = await setup(t, { data: { HN: [row(1)], SG: [] } });
  pickFilter(noWarn.doc, noWarn.window, 'warn');
  assert.equal(noWarn.doc.getElementById('vtStatus').textContent, 'Không có dòng cảnh báo.');
  const allWarn = await setup(t, { data: { HN: [row(1, { warnings: ['multi'] })], SG: [] } });
  pickFilter(allWarn.doc, allWarn.window, 'valid');
  assert.equal(allWarn.doc.getElementById('vtStatus').textContent, 'Không có dòng hợp lệ.');
  const { filterRows } = allWarn.window.TKSVtPositions;
  const sample = [row(1, { warnings: ['multi'] }), row(2)];
  assert.deepEqual(Array.from(filterRows(sample, '', true), r => r.id), [1], 'true = chỉ cảnh báo (tương thích boolean cũ)');
  assert.deepEqual(Array.from(filterRows(sample, '', 'warn'), r => r.id), [1]);
  assert.deepEqual(Array.from(filterRows(sample, '', 'valid'), r => r.id), [2]);
  assert.deepEqual(Array.from(filterRows(sample, '', 'all'), r => r.id), [1, 2]);
  assert.deepEqual(Array.from(filterRows(sample, '', false), r => r.id), [1, 2]);
});

test('hiện 10 cột gồm Có thể bốc, Cập nhật và Người sửa cuối riêng (không còn cột Thao tác), số en-US và giờ Việt Nam, SL Kiot trống khi không có', async t => {
  const data = { HN: [row(1, { quantity: 12345.5, available: 12000.5, held: 345, kiotQuantity: null, arrivalDate: 'KK 4.10' })], SG: [] };
  const { doc } = await setup(t, { data });
  const labels = [...doc.querySelectorAll('#vtTable thead th')].map(th => th.textContent.replace(/[▲▼]/g, '').trim());
  assert.deepEqual(labels, ['Mã hàng', 'Tên hàng', 'SL kho', 'Có thể bốc', 'SL Kiot', 'Ghi chú số thùng', 'Ngày về', 'Vị trí', 'Cập nhật', 'Người sửa cuối']);
  assert.equal(doc.querySelector('#vtTable th[data-field="actions"]'), null);
  assert.equal(doc.querySelector('#vtRows [data-menu-toggle], #vtRows [data-action]'), null, 'không còn nút ⋯/Xóa trong bảng');
  assert.equal(doc.querySelector('td[data-field="quantity"]').textContent, '12,345.5');
  assert.equal(doc.querySelector('td[data-field="available"]').textContent, '12,000.5');
  assert.match(doc.querySelector('td[data-field="available"]').title, /345/, 'tooltip nói rõ phần đang giữ chỗ');
  assert.equal(doc.querySelector('td[data-field="kiotQuantity"]').textContent, '');
  assert.equal(doc.querySelector('td[data-field="arrivalDate"]').textContent, 'KK 4.10');
  assert.equal(doc.querySelector('td[data-field="updated"] .vt-updated-time').textContent, '27/10/2026 09:30');
  assert.equal(doc.querySelector('td[data-field="updatedByName"]').textContent, 'Quản lý', 'Người sửa cuối là cột riêng');
  assert.equal(doc.querySelector('td[data-field="updated"] .vt-updated-by'), null);
});

test('mỗi cột khai báo độ rộng tối thiểu để kéo hẹp không làm chữ xếp từng ký tự', async t => {
  const { doc } = await setup(t);
  const mins = [...doc.querySelectorAll('#vtTable thead th')].map(th => Number(th.dataset.minWidth));
  assert.equal(mins.length, 10);
  assert.ok(mins.every(min => min >= 80), 'mọi cột ≥ 80px: ' + mins.join(','));
});

test('vị trí hiện dạng pill, huy hiệu cảnh báo có biểu tượng và chữ, mỗi dòng bấm được (tabindex)', async t => {
  const data = { HN: [row(1, { warnings: ['unreadable'] })], SG: [] };
  const { doc } = await setup(t, { data });
  assert.equal(doc.querySelector('td[data-field="location"] .vt-pill').textContent, 'K1');
  assert.ok(doc.querySelector('td[data-field="notes"] .vt-badge .vt-badge-icon'));
  assert.equal(doc.querySelector('td[data-field="notes"] .vt-badge').textContent, 'Sai định dạng');
  const tr = doc.querySelector('#vtRows tr[data-id="1"]');
  assert.equal(tr.tabIndex, 0);
  assert.ok(tr.classList.contains('vt-row'));
  assert.equal(doc.querySelector('#vtRows .vt-editable'), null, 'không còn sửa tại chỗ');
  assert.equal(doc.querySelector('#vtRows .vt-edit-icon'), null);
});

test('sắp xếp cột Cập nhật theo thời gian, ô trống luôn cuối', async t => {
  const { window } = await setup(t);
  const rows = [row(1, { updatedAt: '2026-10-27T02:00:00Z' }), row(2, { updatedAt: null }), row(3, { updatedAt: '2026-10-26T02:00:00Z' })];
  assert.deepEqual(Array.from(window.TKSVtPositions.sortRows(rows, 'updated', 'asc'), r => r.id), [3, 1, 2]);
  assert.deepEqual(Array.from(window.TKSVtPositions.sortRows(rows, 'updated', 'desc'), r => r.id), [1, 3, 2]);
});

test('chọn số dòng/trang đổi phân trang và đếm dòng định dạng en-US', async t => {
  const rows = Array.from({ length: 120 }, (_, i) => row(i + 1));
  const { doc, window } = await setup(t, { data: { HN: rows, SG: [] } });
  assert.equal(doc.querySelectorAll('#vtRows tr').length, 100, 'mặc định 100 dòng');
  assert.equal(doc.getElementById('vtCount').textContent, '1–100 / 120 dòng');
  const select = doc.getElementById('vtPageSize');
  select.value = '50';
  select.dispatchEvent(new window.Event('change'));
  assert.equal(doc.querySelectorAll('#vtRows tr').length, 50);
  assert.equal(doc.getElementById('vtPage').textContent, 'Trang 1 / 3');
  doc.getElementById('vtNext').click();
  assert.equal(doc.getElementById('vtCount').textContent, '51–100 / 120 dòng');
  select.value = '200';
  select.dispatchEvent(new window.Event('change'));
  assert.equal(doc.querySelectorAll('#vtRows tr').length, 120);
  assert.equal(doc.getElementById('vtPage').textContent, 'Trang 1 / 1');
});

test('chỉ hiện tab cơ sở được phép', async t => {
  const { doc, calls } = await setup(t, { branch: 'Sài Gòn', hash: '#hn' });
  assert.deepEqual([...doc.querySelectorAll('[data-vt-tab]')].filter(a => !a.hidden).map(a => a.dataset.vtTab), ['sg']);
  assert.equal(calls[0].query.get('branch'), 'SG');
});

test('canEdit=false hoặc không có quyền sửa: ẩn nút Thêm/Import; vẫn bấm dòng xem chi tiết nhưng không có Lưu/Xóa', async t => {
  const readonly = await setup(t, { canEdit: false });
  assert.equal(readonly.doc.getElementById('vtAddButton').hidden, true);
  assert.equal(readonly.doc.getElementById('vtImportButton').hidden, true);
  assert.equal(readonly.doc.getElementById('vtHistoryButton').hidden, false, 'xem lịch sử vẫn được');
  readonly.doc.querySelector('#vtRows tr[data-id="1"]').click();
  assert.ok(readonly.doc.getElementById('vtDetailDialog').hasAttribute('open'), 'chỉ xem vẫn mở được hộp chi tiết');
  assert.equal(readonly.doc.getElementById('vtDetailSave').hidden, true);
  assert.equal(readonly.doc.getElementById('vtDetailDelete').hidden, true);

  const noPermission = await setup(t, { permissions: ['stockLocationsV2.view'] });
  assert.equal(noPermission.doc.getElementById('vtAddButton').hidden, true);
  noPermission.doc.querySelector('#vtRows tr[data-id="1"]').click();
  assert.equal(noPermission.doc.getElementById('vtDetailSave').hidden, true);

  const editor = await setup(t);
  assert.equal(editor.doc.getElementById('vtAddButton').hidden, false);
  editor.doc.querySelector('#vtRows tr[data-id="1"]').click();
  assert.equal(editor.doc.getElementById('vtDetailSave').hidden, false);
  assert.equal(editor.doc.getElementById('vtDetailDelete').hidden, false);
});

test('thêm dòng gửi POST theo cơ sở và hiện dòng mới; lỗi trùng hiện trong hộp thoại', async t => {
  let answer = json({ row: row(9, { code: 'NEW9', location: 'A1' }) }, 201);
  let sent;
  const { doc, window } = await setup(t, {
    handler: async (url, options, parsed) => { if (options.method === 'POST') { sent = { query: parsed.searchParams, body: JSON.parse(options.body) }; return answer; } }
  });
  doc.getElementById('vtAddButton').click();
  const form = doc.getElementById('vtAddForm');
  assert.ok(doc.getElementById('vtAddDialog').hasAttribute('open'));
  form.elements.code.value = ' NEW9 ';
  form.elements.notes.value = '1T x 5';
  form.elements.location.value = 'A1';
  answer = json({ error: 'Ghi chú sai định dạng nên không cộng được vào dòng sẵn có.', code: 'VALIDATION' }, 400);
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(doc.getElementById('vtAddError').textContent, 'Ghi chú sai định dạng nên không cộng được vào dòng sẵn có.');
  assert.ok(doc.getElementById('vtAddDialog').hasAttribute('open'));
  answer = json({ row: row(9, { code: 'NEW9', location: 'A1' }) }, 201);
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(sent.query.get('branch'), 'HN');
  assert.deepEqual(sent.body, { code: 'NEW9', notes: '1T x 5', arrivalDate: '', location: 'A1' });
  assert.equal(doc.getElementById('vtAddDialog').hasAttribute('open'), false);
  assert.ok(doc.querySelector('#vtRows tr[data-id="9"]'));
});

test('hộp Lịch sử cập nhật tải theo cơ sở, lọc theo hành động, tìm kiếm và tải thêm bằng before', async t => {
  const entries = [
    { id: 30, createdAt: '2026-10-27T03:00:00Z', branch: 'HN', code: 'AAA', location: 'K1', action: 'edit', field: 'notes', oldValue: '1T x 5', newValue: '2T x 5', actorName: 'Lan' },
    { id: 29, createdAt: '2026-10-27T02:00:00Z', branch: 'HN', code: '', location: '', action: 'import_add', field: null, summary: { added: 3, updated: 1, deleted: 0, skippedEmpty: 2, fileName: 'a.xlsx' }, actorName: 'Minh' }
  ];
  const queries = [];
  const { doc, window } = await setup(t, {
    handler: async (url, options, parsed) => {
      if (parsed.pathname !== '/api/stock-positions/history') return null;
      queries.push(parsed.searchParams);
      return parsed.searchParams.get('before')
        ? json({ rows: [{ id: 5, createdAt: '2026-10-26T01:00:00Z', branch: 'HN', code: 'OLD', location: 'K9', action: 'create', actorName: 'Hà' }], nextBefore: null })
        : json({ rows: entries, nextBefore: 29 });
    }
  });
  doc.getElementById('vtHistoryButton').click();
  await settle();
  assert.equal(queries[0].get('branch'), 'HN');
  assert.ok(doc.getElementById('vtHistoryDialog').hasAttribute('open'));
  assert.equal(doc.querySelectorAll('#vtHistoryRows tr').length, 2);
  const first = [...doc.querySelectorAll('#vtHistoryRows tr:first-child td')].map(td => td.textContent);
  assert.deepEqual(first, ['27/10/2026 10:00', 'Lan', 'Sửa', 'AAA · K1', '1T x 5 → 2T x 5']);
  assert.match(doc.querySelectorAll('#vtHistoryRows tr')[1].textContent, /Import bổ sung.*Thêm 3 · Đổi 1 · Xóa 0 · Bỏ qua 2 · a\.xlsx/);
  const action = doc.getElementById('vtHistoryAction');
  action.value = 'import_add';
  action.dispatchEvent(new window.Event('change'));
  assert.equal(doc.querySelectorAll('#vtHistoryRows tr').length, 1);
  action.value = '';
  action.dispatchEvent(new window.Event('change'));
  const search = doc.getElementById('vtHistorySearch');
  search.value = 'lan';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(doc.querySelectorAll('#vtHistoryRows tr').length, 1);
  search.value = '';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(doc.getElementById('vtHistoryMore').hidden, false);
  doc.getElementById('vtHistoryMore').click();
  await settle();
  assert.equal(queries[1].get('before'), '29');
  assert.equal(doc.querySelectorAll('#vtHistoryRows tr').length, 3);
  assert.equal(doc.getElementById('vtHistoryMore').hidden, true);
});

test('import: xem trước tùy chọn hiện số liệu và lỗi theo dòng; xác nhận rồi tải lại bảng', async t => {
  const queries = [];
  let preview = { mode: 'add', commit: false, counts: { added: 2, updated: 1, deleted: 0, unchanged: 4, skippedEmpty: 1, errors: 1 }, errors: [{ row: 7, message: 'Thiếu mã SP' }] };
  const { doc, calls, window } = await setup(t, {
    handler: async (url, options, parsed) => {
      if (parsed.pathname !== '/api/stock-positions/import') return null;
      queries.push({ query: parsed.searchParams, body: options.body });
      return json({ ...preview, commit: parsed.searchParams.get('commit') === '1' });
    }
  });
  doc.getElementById('vtImportButton').click();
  assert.ok(doc.getElementById('vtImportDialog').hasAttribute('open'));
  doc.getElementById('vtImportPreview').click();
  await settle();
  assert.match(doc.getElementById('vtImportError').textContent, /chọn file/);
  const input = doc.getElementById('vtImportFile');
  Object.defineProperty(input, 'files', { value: [new window.File(['x'], 'vitri.xlsx')], configurable: true });
  doc.querySelector('input[name="vtImportMode"][value="replace"]').checked = true;
  doc.getElementById('vtImportPreview').click();
  await settle();
  assert.equal(queries[0].query.get('mode'), 'replace');
  assert.equal(queries[0].query.get('commit'), '0');
  assert.equal(queries[0].query.get('branch'), 'HN');
  assert.ok(queries[0].body instanceof window.FormData);
  assert.equal(queries[0].body.get('file').name, 'vitri.xlsx');
  assert.equal(doc.querySelector('[data-count="added"] b').textContent, '2');
  assert.equal(doc.querySelector('[data-count="errors"] b').textContent, '1');
  assert.equal(doc.querySelector('[data-import-errors]'), null, 'không lặp lại danh sách lỗi phía trên bảng');
  assert.equal(doc.getElementById('vtImportError').textContent, '');
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false, 'dòng lỗi không khóa xác nhận');

  preview = { ...preview, counts: { ...preview.counts, errors: 0 }, errors: [] };
  doc.getElementById('vtImportPreview').click();
  await settle();
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
  const listCalls = calls.filter(c => c.method === 'GET' && c.path === '/api/stock-positions').length;
  doc.getElementById('vtImportConfirm').click();
  await settle();
  assert.equal(queries[2].query.get('commit'), '1');
  assert.equal(doc.getElementById('vtImportDialog').hasAttribute('open'), false);
  assert.equal(calls.filter(c => c.method === 'GET' && c.path === '/api/stock-positions').length, listCalls + 1, 'tải lại bảng sau import');
  assert.match(doc.getElementById('vtNotice').textContent, /thêm 2, cập nhật 1, xóa 0/);
});

test('import: bước Xem trước hiện bảng các dòng đã chuẩn hóa (cũ → mới), lọc theo loại, Quay lại về bước chọn file', async t => {
  const rows = [
    { kind: 'add', row: 3, code: 'ZZZ9', name: 'Hàng mới', notes: '3T x 20', arrivalDate: 'KK 4.10', location: 'H9', cartons: 3, quantity: 60 },
    { kind: 'update', row: 4, code: 'AAA1', name: 'Cưa', notes: '7T x 100', arrivalDate: '1/10', location: 'H1', cartons: 7, quantity: 700, before: { notes: '5T x 100', arrivalDate: '1/10', location: 'H1' } },
    { kind: 'delete', row: null, code: 'BBB2', name: '', notes: '1T x 10', arrivalDate: '', location: 'H2', cartons: 1, quantity: 10 }
  ];
  const { doc, window } = await setup(t, {
    handler: async (url, options, parsed) => parsed.pathname === '/api/stock-positions/import'
      ? json({ mode: 'add', commit: false, counts: { added: 1, updated: 1, deleted: 1, unchanged: 0, skippedEmpty: 0, errors: 0 }, errors: [], rows, rowsTotal: 5 })
      : null
  });
  doc.getElementById('vtImportButton').click();
  assert.equal(doc.getElementById('vtImportPickPanel').hidden, false);
  assert.equal(doc.getElementById('vtImportConfirm').hidden, true, 'bước 1 chỉ có Xem trước');
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'vitri.xlsx')], configurable: true });
  doc.getElementById('vtImportFile').dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('vtImportFileName').textContent, 'vitri.xlsx');
  doc.getElementById('vtImportPreview').click();
  await settle();
  assert.equal(doc.getElementById('vtImportPickPanel').hidden, true);
  assert.equal(doc.querySelector('#vtImportSteps [data-step="2"]').classList.contains('is-current'), true);
  assert.equal(doc.getElementById('vtImportConfirm').hidden, false);
  const bodyRows = () => [...doc.querySelectorAll('#vtImportPreviewRows tr')].map(tr => [...tr.children].map(td => td.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(bodyRows(), [
    ['Thêm', '3', 'ZZZ9Hàng mới', '3T x 20', '3', '60', 'KK 4.10', 'H9', '—', ''],
    ['Cập nhật', '4', 'AAA1Cưa', '5T x 100 → 7T x 100', '7', '700', '1/10', 'H1', '—', ''],
    ['Xóa', '—', 'BBB2', '1T x 10', '1', '10', '—', 'H2', '—', '']
  ]);
  assert.match(doc.getElementById('vtImportPreviewNote').textContent, /3 \/ 5 dòng/);
  doc.querySelector('#vtImportFilter [data-kind="update"]').click();
  assert.deepEqual(bodyRows().map(r => r[2]), ['AAA1Cưa']);
  doc.getElementById('vtImportBack').click();
  assert.equal(doc.getElementById('vtImportPickPanel').hidden, false);
  assert.equal(doc.getElementById('vtImportPreviewBox').hidden, true);
});

test('đổi chế độ hoặc file không bắt buộc xem trước lại; bỏ chọn file thì khóa import', async t => {
  const { doc, window } = await setup(t, {
    handler: async (url, options, parsed) => parsed.pathname === '/api/stock-positions/import'
      ? json({ counts: { added: 1, updated: 0, deleted: 0, unchanged: 0, skippedEmpty: 0, errors: 0 }, errors: [] }) : null
  });
  doc.getElementById('vtImportButton').click();
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [new window.File(['x'], 'a.csv')], configurable: true });
  doc.getElementById('vtImportPreview').click();
  await settle();
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
  doc.querySelector('input[name="vtImportMode"][value="replace"]').dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
  Object.defineProperty(doc.getElementById('vtImportFile'), 'files', { value: [], configurable: true });
  doc.getElementById('vtImportFile').dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('vtImportConfirm').disabled, true);
});

test('import trực tiếp sau chọn file, không gọi xem trước; lỗi máy chủ giữ hộp và cho thử lại', async t => {
  let valid = false;
  const { doc, calls, window } = await setup(t, {
    handler: async (url, options, parsed) => parsed.pathname === '/api/stock-positions/import'
      ? valid ? json({ counts: { added: 1 }, imported: true })
        : json({ error: 'File còn lỗi', counts: { errors: 1 }, errors: [{ row: 2, message: 'Thiếu mã hàng.' }] }, 400)
      : null
  });
  doc.getElementById('vtImportButton').click();
  const input = doc.getElementById('vtImportFile');
  Object.defineProperty(input, 'files', { value: [new window.File(['x'], 'Book1.xlsx')], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
  doc.getElementById('vtImportConfirm').click();
  doc.getElementById('vtImportConfirm').click();
  await settle();
  let imports = calls.filter(c => c.path === '/api/stock-positions/import');
  assert.equal(imports.length, 1, 'chặn bấm lặp khi đang gửi');
  assert.equal(imports[0].query.get('commit'), '1');
  assert.ok(doc.getElementById('vtImportDialog').hasAttribute('open'));
  assert.equal(doc.querySelector('[data-import-errors]'), null);
  assert.match(doc.getElementById('vtImportError').textContent, /File còn lỗi/);
  assert.equal(doc.getElementById('vtImportConfirm').disabled, false, 'lỗi từ máy chủ không khóa xác nhận');
  valid = true;
  doc.getElementById('vtImportBack').click();
  doc.getElementById('vtImportPreview').click();
  await settle();
  doc.getElementById('vtImportConfirm').click();
  await settle();
  imports = calls.filter(c => c.path === '/api/stock-positions/import');
  assert.equal(imports.length, 3);
  assert.deepEqual(imports.map(c => c.query.get('commit')), ['1', '0', '1']);
  assert.equal(doc.getElementById('vtImportDialog').hasAttribute('open'), false);
});

test('import lỗi kết nối báo trong hộp và mở lại nút để thử lại', async t => {
  const { doc, window } = await setup(t, {
    handler: async (url, options, parsed) => {
      if (parsed.pathname === '/api/stock-positions/import') throw new TypeError('Failed to fetch');
    }
  });
  doc.getElementById('vtImportButton').click();
  const input = doc.getElementById('vtImportFile');
  Object.defineProperty(input, 'files', { value: [new window.File(['x'], 'Book1.xlsx')], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  for (const button of ['vtImportPreview', 'vtImportConfirm']) {
    doc.getElementById(button).click();
    await settle();
    assert.match(doc.getElementById('vtImportError').textContent, /Không kết nối được máy chủ/);
    assert.equal(doc.getElementById('vtImportConfirm').disabled, false);
    assert.equal(input.disabled, false);
    assert.ok(doc.getElementById('vtImportDialog').hasAttribute('open'));
  }
});

test('nút Xuất Excel chỉ hiện khi canExport, tải file theo cơ sở với tên từ Content-Disposition', async t => {
  const hidden = await setup(t, { canExport: false });
  assert.equal(hidden.doc.getElementById('vtExportButton').hidden, true);

  const { doc, calls, window } = await setup(t, { canExport: true });
  assert.equal(doc.getElementById('vtExportButton').hidden, false);
  const downloads = [];
  window.URL.createObjectURL = blob => { downloads.push({ blob }); return 'blob:vt'; };
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.at(-1).name = this.download; downloads.at(-1).href = this.href; };
  doc.getElementById('vtExportButton').click();
  await settle();
  const exportCall = calls.find(c => c.path === '/api/stock-positions/export');
  assert.equal(exportCall.query.get('branch'), 'HN');
  assert.equal(exportCall.options.credentials, 'same-origin');
  assert.equal(downloads[0].name, 'VT-HN-2026.xlsx');
  assert.equal(downloads[0].href, 'blob:vt');
});

test('sắp xếp số theo giá trị, ô trống luôn cuối', async t => {
  const { window } = await setup(t);
  const rows = [row(1, { quantity: 10 }), row(2, { quantity: null }), row(3, { quantity: 2 })];
  assert.deepEqual(Array.from(window.TKSVtPositions.sortRows(rows, 'quantity', 'asc'), r => r.id), [3, 1, 2]);
  assert.deepEqual(Array.from(window.TKSVtPositions.sortRows(rows, 'quantity', 'desc'), r => r.id), [1, 3, 2]);
});

test('Xuất kho: nút chỉ hiện khi được sửa; chọn file → Trừ kho gửi POST theo cơ sở, hiện kết quả + dòng bỏ qua, tải lại bảng', async t => {
  const readonly = await setup(t, { canEdit: false });
  assert.equal(readonly.doc.getElementById('vtStockOutButton').hidden, true);
  assert.equal((await setup(t, { permissions: ['stockLocationsV2.view'] })).doc.getElementById('vtStockOutButton').hidden, true);

  const result = {
    fileName: 'xuat.xlsx',
    counts: { fileRows: 3, applied: 2, updated: 1, deleted: 1, skipped: 1, quantity: 250 },
    errors: [{ row: 4, code: 'ZZZ9', location: 'K9', notes: '1T x 5', message: 'Không có dòng nào cùng mã hàng và vị trí trong cơ sở này.' }],
    errorsTruncated: false
  };
  const { doc, calls, window } = await setup(t, {
    handler: async (url, options, parsed) => (parsed.pathname === '/api/stock-positions/stock-out' ? json(result) : null)
  });
  const button = doc.getElementById('vtStockOutButton');
  assert.equal(button.hidden, false);
  button.click();
  assert.ok(doc.getElementById('vtStockOutDialog').hasAttribute('open'));
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
  assert.equal(posts[0].options.body.get('file').name, 'xuat.xlsx');
  assert.ok(doc.getElementById('vtStockOutDialog').hasAttribute('open'), 'giữ hộp để xem kết quả');
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

test('Xuất kho: lỗi từ máy chủ / mất kết nối báo trong hộp và cho thử lại; tab SG gửi branch=SG', async t => {
  let mode = 'server';
  const { doc, calls, window, changeTab } = await setup(t, {
    handler: async (url, options, parsed) => {
      if (parsed.pathname !== '/api/stock-positions/stock-out') return null;
      if (mode === 'offline') throw new TypeError('Failed to fetch');
      return json({ error: 'File thiếu cột: Vị trí.', code: 'IMPORT_HEADERS_MISSING' }, 400);
    }
  });
  await changeTab('sg');
  doc.getElementById('vtStockOutButton').click();
  assert.match(doc.getElementById('vtStockOutSubtitle').textContent, /VT Sài Gòn/);
  const input = doc.getElementById('vtStockOutFile');
  Object.defineProperty(input, 'files', { value: [new window.File(['x'], 'xuat.csv')], configurable: true });
  input.dispatchEvent(new window.Event('change'));
  doc.getElementById('vtStockOutRun').click();
  await settle();
  assert.equal(calls.find(c => c.path === '/api/stock-positions/stock-out').query.get('branch'), 'SG');
  assert.match(doc.getElementById('vtStockOutError').textContent, /File thiếu cột: Vị trí/);
  assert.equal(doc.getElementById('vtStockOutRun').disabled, false, 'lỗi không khóa nút thử lại');
  assert.equal(doc.getElementById('vtStockOutReview').hidden, true);
  mode = 'offline';
  doc.getElementById('vtStockOutRun').click();
  await settle();
  assert.match(doc.getElementById('vtStockOutError').textContent, /Không kết nối được máy chủ/);
  assert.equal(doc.getElementById('vtStockOutRun').disabled, false);
  assert.ok(doc.getElementById('vtStockOutDialog').hasAttribute('open'));
});

test('Lịch sử: hành động Xuất kho có nhãn, lọc được và hiện ghi chú cũ → mới kèm tóm tắt', async t => {
  const entries = [
    { id: 3, createdAt: '2026-10-30T03:00:00Z', branch: 'HN', code: 'AAA', location: 'K1', action: 'stock_out', field: 'notes', oldValue: '3T x 100', newValue: '2T x 100', summary: { deducted: 100, removed: false, fileName: 'xuat.xlsx', fileRows: [2] }, actorName: 'Lan' },
    { id: 2, createdAt: '2026-10-30T02:00:00Z', branch: 'HN', code: 'BBB', location: 'K2', action: 'stock_out', field: 'notes', oldValue: '1T x 50', newValue: null, summary: { deducted: 50, removed: true, fileName: 'xuat.xlsx', fileRows: [3] }, actorName: 'Lan' },
    { id: 1, createdAt: '2026-10-30T01:00:00Z', branch: 'HN', code: 'CCC', location: 'K3', action: 'edit', field: 'notes', oldValue: '1T x 5', newValue: '2T x 5', actorName: 'Minh' }
  ];
  const { doc, window } = await setup(t, { handler: async (url, options, parsed) => (parsed.pathname === '/api/stock-positions/history' ? json({ rows: entries, nextBefore: null }) : null) });
  doc.getElementById('vtHistoryButton').click();
  await settle();
  const rows = [...doc.querySelectorAll('#vtHistoryRows tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.replace(/\s+/g, ' ').trim()));
  assert.deepEqual(rows[0].slice(2), ['Xuất kho', 'AAA · K1', '3T x 100 → 2T x 100 Trừ 100 · xuat.xlsx']);
  assert.deepEqual(rows[1].slice(2), ['Xuất kho', 'BBB · K2', '1T x 50 Trừ 50 · Hết hàng, đã xóa dòng · xuat.xlsx']);
  const action = doc.getElementById('vtHistoryAction');
  assert.ok([...action.options].some(option => option.value === 'stock_out' && option.textContent === 'Xuất kho'));
  action.value = 'stock_out';
  action.dispatchEvent(new window.Event('change'));
  assert.equal(doc.querySelectorAll('#vtHistoryRows tr').length, 2);
});
