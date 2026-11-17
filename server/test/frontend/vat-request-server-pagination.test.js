'use strict';

// ORDER VAT phân trang ở máy chủ (slice 6): đổi trang / tìm / sắp / gộp gọi lại máy chủ, giữ bộ lọc;
// giá trị KT đang lưu và vùng chọn theo id không mất khi đổi trang; bỏ kết quả (kể cả lỗi) của lần tải cũ;
// Excel luôn là toàn bộ kết quả bộ lọc. Máy chủ cũ (không có totalRows) đã được vat-request.test.js phủ.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions, PAGE_FEATURES } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'vat-request/index.html'), 'utf8');
const code = fs.readFileSync(path.join(publicDir, 'vat-request/vat-request.js'), 'utf8');
const batchCode = fs.readFileSync(path.join(publicDir, 'vat-request/vat-request-batch.js'), 'utf8');
const gridCode = fs.readFileSync(path.join(publicDir, 'vat-request/vat-request-grid.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 8; i++) await tick(); };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const STATUSES = ['pending', '0', '5', '1', '2', '3', '4'].map(value => ({ value, label: 'TT ' + value, locksSale: ['0', '5', '1', '2'].includes(value) }));
function row(id, extra = {}) {
  return {
    id, createdAt: '2026-10-19T03:00:00Z', createdBy: 'sale-1', createdByName: 'Khánh Thịnh', isLegacy: false,
    customerName: 'KH ' + id, customerCode: null, productCode: 'MA' + (id % 3), productKey: 'ma' + (id % 3), productName: 'Hàng ' + id,
    quantity: id, unitPrice: 1000, totalAmount: id * 1000, fullVat: true, saleNote: '', status: 'pending', statusLabel: 'TT pending',
    accountantNote: '', arrivalDate: null, version: 1, isLockedForSale: false, isMine: false, canEditSale: true, canProcess: true, canDelete: true,
    ...extra
  };
}
// Máy chủ giả: 250 dòng, phân trang / tìm theo q đơn giản, sắp theo quantity; trả groupCounts khi gộp.
function serverPage(all, query) {
  let rows = all.slice();
  if (query.q) rows = rows.filter(r => r.customerName.toLowerCase().includes(query.q.toLowerCase()));
  const sorts = JSON.parse(query.sorts || '[]');
  if (sorts[0] && sorts[0].key === 'quantity') rows.sort((a, b) => (a.quantity - b.quantity) * (sorts[0].dir === 'desc' ? -1 : 1));
  if (query.group === 'product') rows.sort((a, b) => a.productKey.localeCompare(b.productKey) || b.id - a.id);
  const pageSize = Number(query.pageSize) || 100;
  const page = Math.min(Number(query.page) || 1, Math.max(1, Math.ceil(rows.length / pageSize)));
  const pageRows = rows.slice((page - 1) * pageSize, page * pageSize);
  const groupCounts = query.group === 'product'
    ? Object.fromEntries([...new Set(pageRows.map(r => r.productKey))].map(key => [key, rows.filter(r => r.productKey === key).length])) : undefined;
  return {
    rows: pageRows, totalRows: rows.length, page, pageSize, groupCounts, truncated: false, rowOrder: true,
    statuses: STATUSES, sales: [], metrics: {}, stockStatus: null, viewer: { id: 'kt-1', canProcess: true, isManager: false }
  };
}

async function setup(t, { handler, featurePermissions = { 'accounting.vatRequestProcess': true }, vaiTro = 'Kế toán' } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vat-request/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(nav);
  const user = { id: 'kt-1', vaiTro, branch: 'Cả hai', permissions: resolvePermissions({ vaiTro, featurePermissions }), pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return { ok: true, status: 200, json: async () => ({ tables: {} }) };
    const key = `${options.method || 'GET'} ${parsed.pathname.replace('/api/vat-requests', '') || '/'}`;
    const call = { key, query: Object.fromEntries(parsed.searchParams), body: options.body ? JSON.parse(options.body) : undefined, signal: options.signal };
    calls.push(call);
    const result = await handler(call);
    const data = JSON.parse(JSON.stringify(result.data ?? null));
    return { ok: result.status < 400, status: result.status, json: async () => data,
      blob: async () => new window.Blob(['x']), headers: { get: name => (result.headers || {})[name.toLowerCase()] ?? null } };
  };
  window.eval(batchCode);
  window.eval(gridCode);
  window.eval(code);
  await window.TKSVatRequest.init();
  await settle();
  return { window, doc: window.document, calls };
}
const lists = calls => calls.filter(c => c.key === 'GET /');
const ids = doc => [...doc.querySelectorAll('#vrRows tr[data-id]')].map(tr => Number(tr.dataset.id));

test('ORDER VAT phân trang ở máy chủ: trang / sắp / tìm (debounce) gửi đủ bộ lọc, đếm theo toàn bộ kết quả, kẹp trang', async t => {
  const all = Array.from({ length: 250 }, (_, i) => row(250 - i));
  const { window, doc, calls } = await setup(t, { handler: async call => ({ status: 200, data: call.key === 'GET /' ? serverPage(all, call.query) : {} }) });
  const first = lists(calls)[0].query;
  assert.deepEqual([first.page, first.pageSize, first.status], ['1', '100', 'pending,3,4'], 'KT mặc định Cần xử lý, xin trang 1');
  assert.equal(ids(doc).length, 100);
  assert.match(doc.getElementById('vrCount').textContent, /1–100 \/ 250/);

  doc.getElementById('vrLast').click(); await settle();
  assert.equal(lists(calls).at(-1).query.page, '3');
  assert.equal(lists(calls).at(-1).query.status, 'pending,3,4', 'đổi trang giữ bộ lọc');
  assert.deepEqual(ids(doc), all.slice(200).map(r => r.id));
  assert.match(doc.getElementById('vrPage').textContent, /Trang 3 \/ 3/);
  doc.getElementById('vrNext').click(); await settle();
  assert.equal(lists(calls).at(-1).query.page, '3', 'không vượt trang cuối');

  doc.querySelector('[data-sort="quantity"]').click(); await settle();
  const sorted = lists(calls).at(-1).query;
  assert.deepEqual([sorted.page, JSON.parse(sorted.sorts)], ['1', [{ key: 'quantity', dir: 'asc' }]], 'sắp trên toàn bộ kết quả, về trang 1');
  assert.equal(ids(doc)[0], 1);

  const before = lists(calls).length;
  const search = doc.getElementById('vrSearch');
  for (const text of ['K', 'KH', 'KH 7']) { search.value = text; search.dispatchEvent(new window.Event('input')); }
  await settle();
  assert.equal(lists(calls).length, before, 'chưa gọi khi đang gõ');
  await wait(350); await settle();
  assert.equal(lists(calls).length, before + 1, 'chỉ 1 lần sau 300 ms');
  assert.equal(lists(calls).at(-1).query.q, 'KH 7');
  assert.ok(ids(doc).every(id => String(id).startsWith('7')), 'kết quả tìm của máy chủ, kể cả dòng ở trang xa');
  assert.match(doc.getElementById('vrCount').textContent, /\/ 11 dòng/);
});

test('ORDER VAT: bỏ kết quả lẫn lỗi của lần tải cũ; lỗi của lần mới nhất mới hiện', async t => {
  const all = Array.from({ length: 150 }, (_, i) => row(150 - i));
  const gates = [];
  const { window, doc, calls } = await setup(t, { handler: call => {
    if (call.key !== 'GET /') return { status: 200, data: {} };
    if (!gates.enabled) return { status: 200, data: serverPage(all, call.query) };
    return new Promise(resolve => gates.push({ call, resolve }));
  } });
  gates.enabled = true;
  doc.getElementById('vrNext').click(); await settle(); // trang 2 (sẽ trả chậm)
  doc.getElementById('vrFirst').click(); await settle(); // trang 1 mới nhất
  assert.equal(gates.length, 2);
  assert.equal(gates[0].call.signal.aborted, true, 'lần tải cũ bị hủy');
  gates[1].resolve({ status: 200, data: serverPage(all, gates[1].call.query) });
  await settle();
  gates[0].resolve({ status: 500, data: { error: 'Lỗi cũ' } });
  await settle();
  assert.equal(ids(doc)[0], 150, 'vẫn là trang 1');
  assert.notEqual(doc.getElementById('vrStatus').dataset.kind, 'error', 'lỗi của lần cũ bị bỏ qua');

  doc.getElementById('vrNext').click(); await settle();
  doc.getElementById('vrPrevious').click(); await settle();
  gates[3].resolve({ status: 500, data: { error: 'Máy chủ lỗi' } });
  await settle();
  gates[2].resolve({ status: 200, data: serverPage(all, gates[2].call.query) });
  await settle();
  assert.equal(doc.getElementById('vrStatus').dataset.kind, 'error');
  assert.match(doc.getElementById('vrStatus').textContent, /Máy chủ lỗi/);
  assert.equal(ids(doc).length, 0, 'thành công muộn của lần cũ không đè lỗi của lần mới');
  assert.equal(lists(calls).length, 5);
});

test('ORDER VAT: giá trị đang lưu và vùng chọn theo id giữ qua đổi trang; lưu dùng version của dòng; 409 nạp lại đúng trang', async t => {
  const all = Array.from({ length: 150 }, (_, i) => row(150 - i));
  let releaseSave;
  let conflict = false;
  const { window, doc, calls } = await setup(t, { handler: call => {
    if (call.key === 'GET /') return { status: 200, data: serverPage(all, call.query) };
    if (call.key === 'PATCH /bulk') {
      if (conflict) return { status: 409, data: { error: '1 yêu cầu vừa được người khác cập nhật.', code: 'VERSION_CONFLICT', conflictIds: [150] } };
      return new Promise(resolve => { releaseSave = () => {
        for (const item of call.body.items) Object.assign(all.find(r => r.id === item.id), item.changes, { version: item.version + 1 });
        resolve({ status: 200, data: { rows: call.body.items.map(item => ({ id: item.id, version: item.version + 1 })) } });
      }; });
    }
    return { status: 200, data: {} };
  } });
  // Chọn dòng 150 (trang 1).
  const box = doc.querySelector('[data-select="150"]');
  box.checked = true; box.dispatchEvent(new window.Event('change', { bubbles: true }));
  // KT sửa note dòng 150; máy chủ chưa trả lời.
  const cell = doc.querySelector('tr[data-id="150"] td[data-field="accountantNote"]');
  cell.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  const input = cell.querySelector('[data-inline]');
  input.value = 'CONT 11-1';
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(calls.find(c => c.key === 'PATCH /bulk').body.items, [{ id: 150, version: 1, changes: { accountantNote: 'CONT 11-1' } }]);

  doc.getElementById('vrNext').click(); await settle();
  assert.equal(ids(doc)[0], 50);
  doc.getElementById('vrPrevious').click(); await settle();
  assert.equal(lists(calls).at(-1).query.keep, '150', 'dòng vừa sửa được giữ lại trong kết quả');
  assert.equal(doc.querySelector('tr[data-id="150"] td[data-field="accountantNote"]').textContent, 'CONT 11-1', 'trang tải lại vẫn hiện giá trị đang lưu');
  assert.equal(doc.querySelector('[data-select="150"]').checked, true, 'vùng chọn theo id không mất khi đổi trang');

  releaseSave(); await settle();
  doc.getElementById('vrNext').click(); await settle();
  doc.getElementById('vrPrevious').click(); await settle();
  assert.equal(doc.querySelector('tr[data-id="150"] td[data-field="accountantNote"]').textContent, 'CONT 11-1', 'đã lưu: máy chủ trả giá trị mới');

  // Sửa tiếp: gửi version mới (2); 409 -> bỏ giá trị chờ, nạp lại đúng trang đang xem.
  conflict = true;
  doc.getElementById('vrNext').click(); await settle();
  const second = doc.querySelector('tr[data-id="50"] td[data-field="accountantNote"]');
  second.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  const note = second.querySelector('[data-inline]');
  note.value = 'Xung đột';
  note.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.deepEqual(calls.filter(c => c.key === 'PATCH /bulk').at(-1).body.items, [{ id: 50, version: 1, changes: { accountantNote: 'Xung đột' } }]);
  assert.equal(lists(calls).at(-1).query.page, '2', '409 nạp lại đúng trang');
  assert.equal(doc.querySelector('tr[data-id="50"] td[data-field="accountantNote"]').textContent, '', 'bản thật của máy chủ');
  assert.equal(doc.getElementById('vrStatus').dataset.kind, 'warn');
});

test('ORDER VAT gộp theo mã: đếm theo toàn bộ kết quả; ô chọn nhóm nói rõ chỉ chọn trên trang; Excel không gửi trang', async t => {
  const all = Array.from({ length: 150 }, (_, i) => row(150 - i));
  const { window, doc, calls } = await setup(t, { handler: async call => {
    if (call.key === 'GET /') return { status: 200, data: serverPage(all, call.query) };
    if (call.key === 'GET /export') return { status: 200, data: 'x', headers: { 'content-disposition': 'attachment; filename="ORDER_VAT.xlsx"', 'x-export-truncated': '0' } };
    return { status: 200, data: {} };
  } });
  doc.getElementById('vrGroupToggle').click(); await settle();
  assert.equal(lists(calls).at(-1).query.group, 'product');
  const header = doc.querySelector('.vr-group-row');
  assert.match(header.textContent, /50 yêu cầu/, 'mã ma0 có 50 yêu cầu trên toàn kết quả dù trang chỉ hiện một phần');
  assert.match(header.querySelector('[data-select-group]').getAttribute('aria-label'), /trên trang này/);

  const search = doc.getElementById('vrSearch');
  search.value = 'KH 1'; search.dispatchEvent(new window.Event('input'));
  await wait(350); await settle();
  window.URL.createObjectURL = () => 'blob:x'; window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {};
  doc.getElementById('vrExport').click(); await settle();
  const exported = calls.find(c => c.key === 'GET /export').query;
  assert.equal(exported.q, 'KH 1', 'Excel theo đúng bộ lọc + tìm đang xem');
  assert.equal(exported.status, 'pending,3,4');
  for (const key of ['page', 'pageSize', 'sorts', 'group', 'keep']) assert.equal(exported[key], undefined, `Excel không gửi ${key}`);
});

test('ORDER VAT máy chủ cũ (không totalRows): tìm / sắp / đổi trang tại chỗ, không gọi lại máy chủ', async t => {
  const all = Array.from({ length: 150 }, (_, i) => row(150 - i));
  const { window, doc, calls } = await setup(t, { handler: async call => ({ status: 200, data: call.key === 'GET /'
    ? { rows: all, truncated: false, rowOrder: true, statuses: STATUSES, sales: [], metrics: {}, stockStatus: null, viewer: { id: 'kt-1', canProcess: true } } : {} }) });
  assert.equal(ids(doc).length, 100);
  doc.getElementById('vrNext').click(); await settle();
  doc.querySelector('[data-sort="quantity"]').click(); await settle();
  const search = doc.getElementById('vrSearch');
  search.value = 'KH 149'; search.dispatchEvent(new window.Event('input'));
  await wait(350); await settle();
  assert.equal(lists(calls).length, 1, 'không tải lại');
  assert.deepEqual(ids(doc), [149]);
});

// 14/11/2026: máy chủ trả danh sách trước khi đọc xong Tồn VAT (Google Sheets chậm sau khi web khởi động lại).
test('Tồn VAT đang tải: báo "đang tải" (không báo lỗi), tự tải lại khi rảnh; có số rồi thì thôi tải lại', async t => {
  const all = Array.from({ length: 3 }, (_, i) => row(i + 1));
  let loading = true;
  const { doc, calls } = await setup(t, { handler: call => {
    if (call.key !== 'GET /') return { status: 200, data: {} };
    const data = serverPage(all, call.query);
    data.stockStatus = loading
      ? { available: false, loading: true, error: 'Đang tải tồn VAT từ Google Sheets (file nguồn đang chậm). Cột Tồn VAT sẽ có ở lần tải sau.' }
      : { available: true, stale: false, loadedAt: '2026-11-14T03:00:00Z' };
    return { status: 200, data };
  } });
  assert.equal(lists(calls).length, 1);
  assert.match(doc.getElementById('vrSource').textContent, /Đang tải tồn VAT/);
  assert.equal(doc.getElementById('vrSource').dataset.kind, 'warn');
  assert.equal(ids(doc).length, 3, 'danh sách hiện ngay');
  loading = false;
  await wait(10300); await settle();
  assert.equal(lists(calls).length, 2, 'tự tải lại 1 lần sau ~10 giây');
  assert.match(doc.getElementById('vrSource').textContent, /Tồn VAT lấy từ Google Sheets/);
  await wait(10300); await settle();
  assert.equal(lists(calls).length, 2, 'đã có Tồn VAT: không tải lại nữa');
});
