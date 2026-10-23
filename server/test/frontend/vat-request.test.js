'use strict';

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
const PROCESS_GRANTED = { 'accounting.vatRequestProcess': true };

const STATUSES = [
  { value: 'pending', label: 'Chờ KT xử lý', locksSale: false },
  { value: '0', label: '0. Không khai được', locksSale: true },
  { value: '5', label: 'VAT sẵn nhiều', locksSale: true },
  { value: '1', label: '1. Đã xong', locksSale: true },
  { value: '2', label: '2. Đã khai chờ về', locksSale: true },
  { value: '3', label: '3. Chờ khai chèn', locksSale: false },
  { value: '4', label: '4. Chờ cont về, tăng slg', locksSale: false }
];

function row(id, extra = {}) {
  return {
    id, createdAt: '2026-10-19T03:00:00Z', createdBy: 'sale-1', createdByName: 'Khánh Thịnh', isLegacy: false,
    customerName: 'KH A', customerCode: null, productCode: '014XOAN', productKey: '014xoan', productName: 'Bát inox',
    quantity: 400, unitPrice: 11400, totalAmount: 4560000, fullVat: true, saleNote: '', status: 'pending', statusLabel: 'Chờ KT xử lý',
    accountantNote: '', arrivalDate: null, version: 1, isLockedForSale: false, isMine: true, canEditSale: true, canProcess: false, canDelete: true,
    ...extra
  };
}

function listResponse(rows) {
  return {
    rows, truncated: false, statuses: STATUSES, sales: [{ id: 'sale-1', name: 'Khánh Thịnh' }],
    metrics: { '014xoan': { vatStock: { total: 1500, byCompany: [{ company: 'TKS THẤP', vatCode: 'VAT1', stock: 1200 }, { company: 'VC', vatCode: 'VAT1', stock: 300 }] }, pendingInsertQty: 200, incomingContainer: 'CONT 10-7G', containerStatus: '3. Đã bốc', containerEta: 'DK 28/10', nearestArrivalDate: '2026-10-28' } },
    stockStatus: { available: true, stale: false, loadedAt: '2026-10-20T02:00:00Z' }
  };
}

// Server khong gui 4 so O/P/Q/R cho nguoi khong co quyen xu ly.
function saleListResponse(rows) {
  return { ...listResponse(rows), metrics: {}, stockStatus: null };
}
const KT_ONLY_COLUMNS = ['vatStock', 'pendingQty', 'incomingContainer', 'containerStatus', 'containerEta'];

async function setup(t, { vaiTro, id = 'sale-1', responses, featurePermissions = {} }) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vat-request/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const user = { id, vaiTro, branch: 'Cả hai', permissions: resolvePermissions({ vaiTro, featurePermissions }), pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return { ok: true, status: 200, json: async () => ({ tables: {} }) };
    const key = `${options.method || 'GET'} ${parsed.pathname.replace('/api/vat-requests', '') || '/'}`;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ key, query: Object.fromEntries(parsed.searchParams), body });
    const handler = responses[key];
    const result = await (typeof handler === 'function' ? handler(body) : { status: 200, data: handler });
    const headers = result.headers || {};
    // Ban sao moi lan nhu fetch that: trang sua lac quan tren dong khong duoc lam doi "du lieu may chu".
    const data = result.data === undefined || typeof result.data === 'string' ? result.data : JSON.parse(JSON.stringify(result.data));
    return { ok: result.status < 400, status: result.status, json: async () => data,
      blob: async () => new window.Blob([result.data || '']), headers: { get: name => headers[name.toLowerCase()] ?? null } };
  };
  window.eval(batchCode);
  window.eval(gridCode);
  window.eval(code);
  await window.TKSVatRequest.init();
  await tick();
  return { window, doc: window.document, calls };
}

// ---- Thao tac kieu Google Sheet (vat-request-grid.js) ----
const gridCell = (doc, id, field) => doc.querySelector(`tr[data-id="${id}"] td[data-field="${field}"]`);
function editCell(window, doc, id, field) {
  gridCell(doc, id, field).dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  return gridCell(doc, id, field).querySelector('[data-inline]');
}
function mouse(window, target, type, extra = {}) {
  const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...extra });
  target.dispatchEvent(event);
  return event;
}
function dragSelect(window, doc, from, to) {
  mouse(window, gridCell(doc, ...from), 'mousedown');
  mouse(window, gridCell(doc, ...to), 'mouseover');
  mouse(window, doc, 'mouseup');
}
function clipboard(window, doc, type, text = '') {
  const store = { text };
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  event.clipboardData = { getData: () => store.text, setData: (format, value) => { store.text = value; } };
  doc.dispatchEvent(event);
  return { event, text: store.text };
}
const bulkEcho = body => ({ status: 200, data: { updated: body.items.length, rows: body.items.map(item => row(item.id, { canProcess: true, version: item.version + 1, ...item.changes })) } });

test('sale: mac dinh xem tat ca sale, khong co cot chon / sua nhanh, dong khoa khong co nut Sua', async t => {
  const rows = [row(1), row(2, { status: '1', statusLabel: '1. Đã xong', isLockedForSale: true, canEditSale: false, canDelete: false }),
    row(3, { createdBy: 'sale-2', createdByName: 'Tuyên', isMine: false, canEditSale: false, canDelete: false, fullVat: false })];
  const { doc, calls } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': saleListResponse(rows) } });
  assert.equal(calls[0].query.createdBy, undefined, 'mac dinh tat ca sale');
  assert.equal(doc.getElementById('vrSaleFilter').value, '');
  assert.equal(calls[0].query.status, undefined);
  assert.equal(doc.querySelector('[data-column-key="select"]'), null);
  assert.equal(doc.querySelector('[data-inline]'), null);
  assert.equal(doc.getElementById('vrGroupToggle').hidden, true);
  assert.equal(doc.getElementById('vrExport').hidden, true, 'sale khong xuat Excel');
  const editable = [...doc.querySelectorAll('[data-action="edit"]')].map(b => Number(b.dataset.id));
  assert.deepEqual(editable, [1]);
  assert.ok(doc.querySelector('tr[data-id="2"] .vr-lock'));
  assert.match(doc.querySelector('tr[data-id="1"] [data-field="total"]').textContent, /4,560,000/);
  for (const key of KT_ONLY_COLUMNS) assert.equal(doc.querySelector(`[data-column-key="${key}"], [data-field="${key}"]`), null, `sale khong thay cot ${key}`);
  assert.equal(doc.getElementById('vrSource').textContent, '', 'sale khong thay dong nguon Ton VAT');
  assert.equal(doc.querySelector('[data-column-key="quantity"] .sort-label').textContent, 'SL');
  const when = doc.querySelector('tr[data-id="1"] [data-field="createdAt"] .vr-when');
  assert.equal(when.textContent, '10:00 19/10/2026', 'du nam trong DOM (keo rong cot thi hien)');
  assert.equal(when.querySelector('.vr-year').textContent, '/2026', 'nam tach rieng de an khi cot hep');
  assert.equal(doc.querySelector('tr[data-id="1"] [data-field="fullVat"] .vr-tag').textContent, 'Full VAT');
  assert.equal(doc.querySelector('tr[data-id="3"] [data-field="fullVat"] .vr-tag').textContent, 'Chưa VAT', 'khong full VAT -> pill Chua VAT');
  assert.ok(doc.querySelector('#sidebar a[href="/vat-request/"]'), 'menu Ke toan co Yeu cau xuat VAT');
});

function batchApi() {
  const context = { window: {} };
  require('node:vm').runInNewContext(batchCode, context);
  return context.window.TKSVatRequestBatch;
}
const LOOKUP = {
  '014xoan': { found: true, productCode: '014XOAN', productName: 'Bát inox 2 lớp XOẮN 14cm', vatStock: { total: 1500, byCompany: [] }, pendingInsertQty: 0, incomingContainer: 'CONT 10-7G', containerStatus: '3. Đã bốc', containerEta: 'DK 28/10', nearestArrivalDate: '2026-10-28', latestOrder: { price: 12500, customerName: 'Khách cũ', createdAt: null } },
  // Dang tra ve cho sale: khong co Ton VAT / Cho khai / Cont.
  '26daquan': { found: true, productCode: '26DAQUAN', productName: 'Đồng hồ treo tường DẠ QUANG', latestOrder: null }
};
const lookupResponse = body => ({ status: 200, data: { results: Object.fromEntries(body.codes.map(code => [code.toLowerCase(), LOOKUP[code.toLowerCase()] || { found: false }])), stockStatus: { available: true } } });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function typeInto(window, input, value) {
  input.value = value;
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}
function pasteInto(window, target, text) {
  const event = new window.Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = { getData: () => text };
  target.dispatchEvent(event);
  return event;
}
function chooseFullVat(window, tr, value) {
  const select = tr.querySelector('[data-field="fullVat"]');
  select.value = value ? 'true' : 'false';
  select.dispatchEvent(new window.Event('input', { bubbles: true }));
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
}
const batchRows = doc => [...doc.querySelectorAll('#vrBatchRows tr[data-row]')];
const cell = (tr, name) => tr.querySelector(`[data-field="${name}"]`);
const submitBatch = (window, doc) => doc.getElementById('vrBatchForm').dispatchEvent(new window.Event('submit', { cancelable: true }));

test('tao nhieu dong: form trong mo san o Dan tu Excel; dan 6 cot -> du cot, Full VAT de trong bat buoc chon tung dong', async t => {
  const responses = {
    'GET /': listResponse([]),
    'POST /lookup': lookupResponse,
    'POST /batch': body => ({ status: 201, data: { created: body.items.length, ids: [11, 12], duplicate: false } })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Nhân viên sale', responses });
  doc.getElementById('vrCreate').click();
  assert.equal(doc.getElementById('vrBatchDialog').hasAttribute('open'), true);
  assert.equal(doc.getElementById('vrBatchPastePanel').hidden, false, 'form trong -> mo san o dan');
  assert.equal(doc.activeElement, doc.getElementById('vrBatchPasteArea'));
  const event = pasteInto(window, doc.getElementById('vrBatchPasteArea'),
    'KH A Thắng\t014XOAN\tBát inox\t1.200\t11,400\tFULL VAT\r\nKH A Thắng\t26DAQUAN\tĐồng hồ\t280\t37870\tgấp\r\n');
  assert.equal(event.defaultPrevented, true);
  assert.equal(doc.getElementById('vrBatchPastePanel').hidden, true, 'dan xong thu gon o dan');
  const rows = batchRows(doc);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(tr => [cell(tr, 'customerName').value, cell(tr, 'productCode').value, cell(tr, 'quantity').value, cell(tr, 'unitPrice').value, cell(tr, 'saleNote').value, cell(tr, 'fullVat').value]),
    [['KH A Thắng', '014XOAN', '1200', '11400', 'FULL VAT', ''], ['KH A Thắng', '26DAQUAN', '280', '37870', 'gấp', '']]);
  assert.match(doc.getElementById('vrBatchNotice').textContent, /Đã dán 2 dòng\. Chọn Full VAT \/ Chưa VAT cho 2 dòng/);
  assert.equal(doc.activeElement, cell(rows[0], 'fullVat'), 'dua con tro toi o Full VAT dau tien chua chon');
  assert.match(doc.getElementById('vrBatchSummary').textContent, /2 dòng chưa chọn Full VAT/);
  await wait(400);
  const lookup = calls.filter(c => c.key === 'POST /lookup');
  assert.equal(lookup.length, 1, 'tra ca bang trong 1 lan goi');
  assert.deepEqual(lookup[0].body.codes, ['014XOAN', '26DAQUAN']);
  assert.match(rows[0].querySelector('[data-cell="product"]').textContent, /Bát inox 2 lớp XOẮN 14cm.*Tồn VAT 1,500.*Cont CONT 10-7G · 3\. Đã bốc DK 28\/10/);
  assert.equal(rows[1].querySelector('[data-cell="product"]').textContent, 'Đồng hồ treo tường DẠ QUANG', 'khong co so lieu -> chi ten SP');
  assert.match(rows[0].querySelector('[data-cell="price"]').textContent, /Gần nhất 12,500/);
  assert.match(doc.getElementById('vrBatchSummary').textContent, /2 dòng hàng · Tổng 24,283,600 ₫/);

  submitBatch(window, doc);
  await tick();
  assert.equal(calls.some(c => c.key === 'POST /batch'), false, 'chua chon Full VAT thi khong gui');
  assert.match(doc.getElementById('vrBatchError').textContent, /2 dòng chưa hợp lệ.*Dòng 1: chưa chọn Full VAT/);
  assert.equal(cell(rows[1], 'fullVat').getAttribute('aria-invalid'), 'true');

  chooseFullVat(window, rows[0], true);
  chooseFullVat(window, rows[1], false);
  assert.equal(cell(rows[1], 'fullVat').hasAttribute('aria-invalid'), false);
  assert.doesNotMatch(doc.getElementById('vrBatchSummary').textContent, /chưa chọn/);
  submitBatch(window, doc);
  await tick(); await tick();
  const post = calls.find(c => c.key === 'POST /batch');
  assert.ok(post.body.submissionId);
  assert.deepEqual(post.body.items, [
    { customerName: 'KH A Thắng', customerCode: null, productCode: '014XOAN', quantity: 1200, unitPrice: 11400, fullVat: true, saleNote: 'FULL VAT' },
    { customerName: 'KH A Thắng', customerCode: null, productCode: '26DAQUAN', quantity: 280, unitPrice: 37870, fullVat: false, saleNote: 'gấp' }
  ]);
  assert.equal(doc.getElementById('vrBatchDialog').hasAttribute('open'), false);
  assert.match(doc.getElementById('vrStatus').textContent, /Đã gửi 2 yêu cầu/);
  assert.equal(window.localStorage.getItem('vr-batch-draft:sale-1'), null);
});

test('dan kem dong tieu de (vd copy tu sheet ORDER VAT 1 cu): khop cot theo ten, bo cot la, khong lay Full VAT', () => {
  const api = batchApi();
  const plain = value => JSON.parse(JSON.stringify(value));
  const parseClipboard = text => api.parseClipboard(text);
  const mapPastedMatrix = (matrix, start) => plain(api.mapPastedMatrix(matrix, start));
  const matrix = parseClipboard('Thời gian\tEmail\tTên Sale\tKhách hàng\tMã SP Trim\tTên SP\tSố lượng\tGiá chưa VAT (Full VAT thì ghi chú)\tGhi chú (Mã VAT nếu có)\tKT PHẢN HỒI\n' +
    '19/10/2026\ta@x.vn\tThịnh\tKH A\t014XOAN\tBát\t400\t11.400\tFULL VAT\t3. Chờ khai chèn\n');
  const { rows, header } = mapPastedMatrix(matrix);
  assert.equal(header, true);
  assert.deepEqual(rows, [{ customerName: 'KH A', productCode: '014XOAN', quantity: '400', unitPrice: '11400', saleNote: 'FULL VAT' }]);
  const reordered = mapPastedMatrix(parseClipboard('Mã SP\tSL\tKhách hàng\n26DAQUAN\t5\tKH B'));
  assert.deepEqual(reordered.rows, [{ productCode: '26DAQUAN', quantity: '5', customerName: 'KH B' }]);
  const fromQty = mapPastedMatrix(parseClipboard('10\t2.000\tghi\n20\t3000\t'), 'quantity');
  assert.equal(fromQty.header, false);
  assert.deepEqual(fromQty.rows, [{ quantity: '10', unitPrice: '2000', saleNote: 'ghi' }, { quantity: '20', unitPrice: '3000', saleNote: '' }]);
});

test('tao nhieu dong: Ctrl+V khi con tro o vung trong cua form cung nhan; dan vao o giua bang bat dau tu cot do', async t => {
  const { window, doc } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': listResponse([]), 'POST /lookup': lookupResponse } });
  doc.getElementById('vrCreate').click();
  const event = pasteInto(window, doc.getElementById('vrBatchAdd'), 'KH C\t014XOAN\t\t3\t1000\t\nKH C\t26DAQUAN\t\t4\t2000\t');
  assert.equal(event.defaultPrevented, true);
  assert.equal(batchRows(doc).length, 2);
  const target = cell(batchRows(doc)[1], 'quantity');
  pasteInto(window, target, '9\t9000\n8\t8000');
  const rows = batchRows(doc);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(tr => [cell(tr, 'productCode').value, cell(tr, 'quantity').value, cell(tr, 'unitPrice').value]),
    [['014XOAN', '3', '1000'], ['26DAQUAN', '9', '9000'], ['', '8', '8000']]);
  assert.equal(cell(rows[2], 'customerName').value, 'KH C', 'dong them khi dan van chep khach dong tren');
});

test('tao nhieu dong: dong moi chep khach dong tren, Enter o dong cuoi them dong, loi chi dung dong va khong goi API', async t => {
  const { window, doc, calls } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': listResponse([]), 'POST /lookup': lookupResponse } });
  doc.getElementById('vrCreate').click();
  const first = batchRows(doc)[0];
  typeInto(window, cell(first, 'customerName'), 'KH B');
  typeInto(window, cell(first, 'productCode'), '014XOAN');
  typeInto(window, cell(first, 'quantity'), '1.5');
  typeInto(window, cell(first, 'unitPrice'), '100');
  chooseFullVat(window, first, false);
  cell(first, 'saleNote').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  const rows = batchRows(doc);
  assert.equal(rows.length, 2);
  assert.equal(cell(rows[1], 'customerName').value, 'KH B', 'dong moi dung lai khach dong tren');
  assert.equal(cell(rows[1], 'fullVat').value, '', 'Full VAT dong moi van de trong');
  assert.equal(doc.activeElement, cell(rows[1], 'productCode'));
  assert.match(doc.getElementById('vrBatchSummary').textContent, /1 dòng hàng/, 'dong chi co khach chua tinh');
  submitBatch(window, doc);
  await tick();
  assert.match(doc.getElementById('vrBatchError').textContent, /1 dòng chưa hợp lệ.*Dòng 1: số lượng phải là số nguyên/);
  assert.equal(cell(rows[0], 'quantity').getAttribute('aria-invalid'), 'true');
  assert.ok(rows[0].classList.contains('has-error'));
  assert.equal(calls.some(c => c.key === 'POST /batch'), false);
  typeInto(window, cell(rows[0], 'quantity'), '2');
  assert.equal(cell(rows[0], 'quantity').hasAttribute('aria-invalid'), false, 'sua o thi bo danh dau loi');
});

test('tao nhieu dong: server bao loi theo dong -> danh dau dung o; gui lai cung du lieu dung lai ma lan gui', async t => {
  const responses = {
    'GET /': listResponse([]),
    'POST /lookup': lookupResponse,
    'POST /batch': () => ({ status: 400, data: { error: '1 dòng chưa hợp lệ, chưa gửi dòng nào.', code: 'BATCH_INVALID', errors: [{ row: 2, field: 'customerName', message: 'Dòng 2: Khách hàng quá dài.' }] } })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Nhân viên sale', responses });
  doc.getElementById('vrCreate').click();
  pasteInto(window, doc.getElementById('vrBatchPasteArea'), 'KH A\t014XOAN\t\t10\t100\t\nKH C\t26DAQUAN\t\t5\t200\t');
  batchRows(doc).forEach(tr => chooseFullVat(window, tr, false));
  await wait(400);
  submitBatch(window, doc);
  await tick(); await tick();
  const rows = batchRows(doc);
  assert.equal(cell(rows[1], 'customerName').getAttribute('aria-invalid'), 'true');
  assert.match(doc.getElementById('vrBatchError').textContent, /Dòng 2: Khách hàng quá dài/);
  assert.equal(doc.getElementById('vrBatchDialog').hasAttribute('open'), true, 'loi thi giu nguyen form');
  submitBatch(window, doc);
  await tick(); await tick();
  const posts = calls.filter(c => c.key === 'POST /batch');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].body.submissionId, posts[1].body.submissionId);
});

test('tao nhieu dong: khoi phuc nhap chua gui tu lan truoc, giu lua chon Full VAT', async t => {
  const { window, doc } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': listResponse([]), 'POST /lookup': lookupResponse } });
  window.localStorage.setItem('vr-batch-draft:sale-1', JSON.stringify({ savedAt: Date.now(), rows: [
    { customerName: 'KH D', productCode: '014XOAN', quantity: '3', unitPrice: '1000', fullVat: null, saleNote: '' },
    { customerName: 'KH D', productCode: '26DAQUAN', quantity: '4', unitPrice: '2000', fullVat: true, saleNote: 'x' }
  ] }));
  doc.getElementById('vrCreate').click();
  const rows = batchRows(doc);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(tr => cell(tr, 'fullVat').value), ['', 'true']);
  assert.equal(doc.getElementById('vrBatchPastePanel').hidden, true, 'co nhap thi khong mo o dan');
  assert.match(doc.getElementById('vrBatchNotice').textContent, /khôi phục 2 dòng/);
});

test('gia order VAT gan nhat trong hop sua chi dien khi bam goi y; khi sua giu gia hien tai', async t => {
  const responses = {
    'GET /': listResponse([row(1, { unitPrice: 13000 })]),
    'GET /1/history': { rows: [] },
    'GET /metrics': { productName: 'Bát inox', vatStock: null, pendingInsertQty: 0, incomingContainer: '', containerStatus: '', containerEta: '' },
    'GET /price-suggest': { latestOrder: { price: 12500, customerName: 'Khách cũ', createdAt: '2026-10-20T02:00:00Z' } }
  };
  const { window, doc } = await setup(t, { vaiTro: 'Nhân viên sale', responses });
  doc.querySelector('tr[data-id="1"] [data-field="customer"]').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  assert.equal(doc.getElementById('vrPrice').value, '13,000');
  assert.match(doc.getElementById('vrPriceSuggestion').textContent, /12,500/);
  doc.getElementById('vrPriceSuggestion').querySelector('button').click();
  assert.equal(doc.getElementById('vrPrice').value, '12,500');
  const product = doc.getElementById('vrProduct');
  product.value = '26DAQUAN';
  product.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(doc.getElementById('vrPriceSuggestion').textContent, '', 'doi ma phai xoa goi y cua ma truoc');
});

test('Ke toan chua duoc cap quyen: chi xem, khong co sua nhanh / chon lo / gom theo ma', async t => {
  const { doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-2', responses: { 'GET /': listResponse([row(1, { isMine: false, canEditSale: false })]) } });
  assert.equal(calls[0].query.status, undefined);
  assert.equal(doc.querySelector('[data-column-key="select"]'), null);
  assert.equal(doc.querySelector('[data-inline]'), null);
  assert.equal(doc.getElementById('vrGroupToggle').hidden, true);
  assert.equal(doc.getElementById('vrExport').hidden, true, 'chua co quyen xu ly -> khong xuat Excel');
  assert.equal(doc.getElementById('vrBulk'), null, 'khong con thanh hang loat');
  assert.ok(doc.getElementById('vrCreate'));
});

test('KT: mac dinh loc Can xu ly; sua o hien ngay roi luu nen kem version; 409 nap lai ban that va canh bao', async t => {
  let conflict = false;
  const responses = {
    'GET /': listResponse([row(1, { canProcess: true, isMine: false }), row(2, { canProcess: true, isMine: false })]),
    'PATCH /bulk': body => conflict
      ? { status: 409, data: { error: '1 yêu cầu vừa được người khác cập nhật. Hãy tải lại rồi thử lại.', code: 'VERSION_CONFLICT', conflictIds: [1] } }
      : bulkEcho(body)
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  assert.equal(calls[0].query.status, 'pending,3,4');
  assert.equal(calls[0].query.createdBy, undefined);
  assert.ok(doc.querySelector('[data-column-key="select"]'));
  assert.equal(doc.getElementById('vrGroupToggle').hidden, false);
  assert.equal(doc.getElementById('vrExport').hidden, false);
  for (const key of KT_ONLY_COLUMNS) assert.ok(doc.querySelector(`th[data-column-key="${key}"]`), `KT thay cot ${key}`);
  assert.equal(doc.querySelector('tr[data-id="1"] [data-field="incomingContainer"]').textContent, 'CONT 10-7G');
  assert.equal(doc.querySelector('tr[data-id="1"] [data-field="containerStatus"]').textContent, '3. Đã bốc');
  assert.equal(doc.querySelector('tr[data-id="1"] [data-field="containerEta"]').textContent, 'DK 28/10');
  assert.equal(doc.querySelector('[data-column-key="nearestSchedule"]'), null, 'bo cot lich ghep cu');

  assert.equal(doc.querySelector('[data-inline]'), null, 'o KT hien chu, chua mo o sua');
  const note = editCell(window, doc, 1, 'accountantNote');
  note.value = 'CONT 10-6V';
  note.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(gridCell(doc, 1, 'accountantNote').textContent, 'CONT 10-6V', 'hien ngay, khong cho may chu');
  await tick(); await tick();
  assert.deepEqual(calls.find(c => c.key === 'PATCH /bulk').body, { items: [{ id: 1, version: 1, changes: { accountantNote: 'CONT 10-6V' } }] });

  conflict = true;
  const select = editCell(window, doc, 1, 'status');
  select.value = '1';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(gridCell(doc, 1, 'status').querySelector('.vr-badge').dataset.status, '1', 'hien ngay');
  await tick(); await tick(); await tick();
  assert.deepEqual(calls.filter(c => c.key === 'PATCH /bulk').pop().body.items, [{ id: 1, version: 2, changes: { status: '1' } }], 'version moi tu lan luu truoc');
  assert.equal(doc.getElementById('vrStatus').dataset.kind, 'warn');
  assert.equal(gridCell(doc, 1, 'status').querySelector('.vr-badge').dataset.status, 'pending', '409 -> nap lai ban that tu may chu');
});

test('sua lien tiep truoc khi may chu tra loi: hien ngay ca hai, luu tuan tu dung version (khong 409)', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  const responses = {
    'GET /': listResponse([row(1, { canProcess: true }), row(2, { canProcess: true })]),
    'PATCH /bulk': async body => { if (first) { first = false; await gate; } return bulkEcho(body); }
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  const edit = (value) => { const input = editCell(window, doc, 1, 'accountantNote'); input.value = value; input.dispatchEvent(new window.Event('change', { bubbles: true })); };
  edit('A');
  edit('B');
  assert.equal(gridCell(doc, 1, 'accountantNote').textContent, 'B', 'hien ngay gia tri moi nhat');
  await tick();
  assert.equal(calls.filter(c => c.key === 'PATCH /bulk').length, 1, 'lan 2 cho lan 1 xong');
  release();
  await tick(); await tick(); await tick(); await tick();
  const bulks = calls.filter(c => c.key === 'PATCH /bulk').map(c => c.body.items[0]);
  assert.deepEqual(bulks, [{ id: 1, version: 1, changes: { accountantNote: 'A' } }, { id: 1, version: 2, changes: { accountantNote: 'B' } }]);
  assert.equal(gridCell(doc, 1, 'accountantNote').textContent, 'B', 'tra loi lan 1 khong ghi de gia tri moi hon');
});

test('tick chon dong khong con hien thanh hang loat (da bo); o tick van dung de chon dong', async t => {
  const { window, doc } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses: { 'GET /': listResponse([row(1, { canProcess: true }), row(2, { canProcess: true })]) }, featurePermissions: PROCESS_GRANTED });
  const box = doc.querySelector('[data-select="1"]');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(doc.getElementById('vrBulk'), null);
  assert.equal(doc.getElementById('vrBulkApply'), null);
  assert.ok(doc.querySelector('tr[data-id="1"]').classList.contains('is-picked'));
});

test('gom theo ma SP: dong tieu de nhom hien ton VAT / can khai / dang ve', async t => {
  const responses = { 'GET /': listResponse([row(1, { canProcess: true }), row(2, { canProcess: true, productCode: '26DAQUAN', productKey: '26daquan', productName: 'Đồng hồ' }), row(3, { canProcess: true })]) };
  const { window, doc } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  const toggle = doc.getElementById('vrGroupToggle');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  const groups = [...doc.querySelectorAll('.vr-group-row')].map(r => r.textContent);
  assert.equal(groups.length, 2);
  assert.match(groups[0], /014XOAN.*2 yêu cầu · Tồn VAT 1,500 · Cần khai 200 · Cont CONT 10-7G · Lịch 3\. Đã bốc DK 28\/10/);
  assert.match(groups[1], /26DAQUAN.*1 yêu cầu$/, 'ma khong co so lieu -> chi so yeu cau');
  assert.deepEqual([...doc.querySelectorAll('#vrRows tr[data-id]')].map(r => Number(r.dataset.id)), [1, 3, 2]);
});

test('xuat Excel: quan ly thay nut; tai file theo dung bo loc dang xem, bao khi bi cat 5,000 dong; loi hien thong bao', async t => {
  const responses = {
    'GET /': { ...listResponse([row(1)]), viewer: { id: 'ql-1', canProcess: false, isManager: true } },
    'GET /export': () => ({ status: 200, data: 'xlsx', headers: { 'content-disposition': 'attachment; filename="order_vat_20261021_0930.xlsx"', 'x-export-truncated': '1' } })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Nhân viên sale', id: 'ql-1', responses });
  const button = doc.getElementById('vrExport');
  assert.equal(button.hidden, false, 'quan ly thay nut Xuat Excel');
  assert.equal(doc.getElementById('vrReload').disabled, false);
  assert.equal(button.closest('.vr-table-actions').querySelector('#vrColumnsButton') !== null, true, 'Cot hien thi nam canh Xuat Excel');

  const downloads = [];
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  doc.querySelector('[data-preset="3"]').click();
  await tick();
  button.click();
  await tick(); await tick();
  const exported = calls.find(c => c.key === 'GET /export');
  assert.equal(exported.query.status, '3', 'cung bo loc trang thai dang chon');
  assert.deepEqual(downloads, ['order_vat_20261021_0930.xlsx']);
  assert.equal(doc.getElementById('vrStatus').dataset.kind, 'warn');
  assert.equal(button.disabled, false);

  responses['GET /export'] = () => ({ status: 403, data: { error: 'Chỉ kế toán hoặc quản lý được xuất Excel ORDER VAT.' } });
  button.click();
  await tick(); await tick();
  assert.equal(doc.getElementById('vrStatus').dataset.kind, 'error');
  assert.match(doc.getElementById('vrStatus').textContent, /Chỉ kế toán/);
  assert.equal(downloads.length, 1);
});

const HISTORY = { rows: [
  { id: 2, changedAt: '2026-10-20T03:07:00Z', changedBy: 'kt-1', changedByName: 'Kế toán Lan', action: 'update', field: 'status', oldValue: 'pending', newValue: '1' },
  { id: 1, changedAt: '2026-10-20T03:06:00Z', changedBy: 'sale-1', changedByName: 'Khánh Thịnh', action: 'create', field: null, oldValue: null, newValue: null }
] };

function lockedRow(id) {
  return row(id, { status: '1', statusLabel: '1. Đã xong', isLockedForSale: true, canEditSale: false, canDelete: false });
}

test('nhay dup dong sua duoc: modal sua gon, nut Lich su (co so dem) mo khung chat noi, form khong doi; dong da khoa: chi lich su', async t => {
  const responses = { 'GET /': listResponse([row(1), lockedRow(2)]), 'GET /1/history': HISTORY, 'GET /2/history': HISTORY, 'GET /metrics': { productName: 'Bát inox', vatStock: null, pendingInsertQty: 0, incomingContainer: '', containerStatus: '', containerEta: '' } };
  const { window, doc } = await setup(t, { vaiTro: 'Nhân viên sale', responses });
  const dialog = doc.getElementById('vrFormDialog');
  const chat = doc.getElementById('vrChat');
  doc.querySelector('tr[data-id="1"] [data-field="customer"]').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  assert.equal(dialog.hasAttribute('open'), true);
  assert.equal(dialog.dataset.mode, 'edit');
  assert.equal(doc.getElementById('vrFormTitle').textContent, 'Sửa yêu cầu #1');
  assert.match(doc.getElementById('vrFormSub').textContent, /014XOAN · KH A/);
  assert.equal(doc.getElementById('vrFormBody').hidden, false);
  assert.equal(doc.getElementById('vrFormDelete').hidden, false);
  assert.equal(doc.getElementById('vrHistoryToggle').hidden, false);
  assert.equal(chat.hidden, true, 'lich su mac dinh thu gon');
  assert.equal(doc.getElementById('vrHistoryCount').textContent, '2');
  assert.equal(doc.getElementById('vrChatCount').textContent, '2');
  const items = [...doc.querySelectorAll('#vrHistoryList .vr-chat-item')];
  assert.deepEqual(items.map(li => li.dataset.kind), ['status', 'create']);
  assert.match(items[0].textContent, /Kế toán Lan/);
  assert.match(items[0].textContent, /Thay đổi trạng thái: Chờ KT xử lý → 1\. Đã xong/);
  assert.equal(doc.getElementById('vrProduct').value, '014XOAN');
  doc.getElementById('vrHistoryToggle').click();
  assert.equal(chat.hidden, false);
  assert.equal(dialog.dataset.historyOpen, 'true');
  assert.equal(doc.getElementById('vrHistoryToggle').getAttribute('aria-expanded'), 'true');
  assert.equal(doc.getElementById('vrFormBody').hidden, false, 'form van giu nguyen khi mo lich su');
  doc.getElementById('vrChatClose').click();
  assert.equal(chat.hidden, true);

  doc.querySelector('tr[data-id="2"] [data-field="customer"]').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  assert.equal(dialog.dataset.mode, 'history');
  assert.equal(doc.getElementById('vrFormTitle').textContent, 'Lịch sử yêu cầu #2');
  assert.equal(doc.getElementById('vrFormBody').hidden, true);
  assert.equal(doc.getElementById('vrHistoryInline').hidden, false);
  assert.equal(doc.getElementById('vrHistoryToggle').hidden, true);
  assert.equal(doc.getElementById('vrFormSubmit').hidden, true);
  assert.equal(doc.getElementById('vrFormCancel').textContent, 'Đóng');
  assert.equal(doc.querySelectorAll('#vrHistoryInlineList .vr-chat-item').length, 2);
  assert.match(doc.getElementById('vrFormSub').textContent, /đã khóa/);
});

test('luu: nut co trang thai dang luu va khong gui trung khi bam 2 lan', async t => {
  let release;
  const responses = {
    'GET /': listResponse([row(1)]), 'GET /1/history': HISTORY,
    'GET /metrics': { productName: 'Bát inox', vatStock: null, pendingInsertQty: 0, incomingContainer: '', containerStatus: '', containerEta: '' },
    'PATCH /1': body => ({ status: 200, data: row(1, { ...body, version: 2 }) })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Nhân viên sale', responses });
  const realFetch = window.fetch;
  window.fetch = (url, options = {}) => (options.method === 'PATCH' ? new Promise(resolve => { release = () => resolve(realFetch(url, options)); }) : realFetch(url, options));
  doc.querySelector('tr[data-id="1"] [data-field="customer"]').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  await tick();
  doc.getElementById('vrQuantity').value = '500';
  const submit = () => doc.getElementById('vrForm').dispatchEvent(new window.Event('submit', { cancelable: true }));
  submit();
  submit();
  const button = doc.getElementById('vrFormSubmit');
  assert.equal(button.disabled, true);
  assert.ok(button.classList.contains('is-loading'));
  assert.equal(doc.getElementById('vrFormSubmitLabel').textContent, 'Đang lưu…');
  release();
  await tick(); await tick();
  assert.equal(calls.filter(c => c.key === 'PATCH /1').length, 1);
  assert.equal(doc.getElementById('vrFormDialog').hasAttribute('open'), false);
});

test('nhay dup vao o KT mo o sua (khong mo hop); chuot phai hien menu, dong khoa khong co muc Sua', async t => {
  const responses = { 'GET /': listResponse([row(1, { canProcess: true, canEditSale: false, isMine: false }), lockedRow(2)]), 'GET /1/history': HISTORY, 'GET /2/history': HISTORY };
  const { window, doc } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  const control = editCell(window, doc, 1, 'accountantNote');
  assert.equal(control.matches('input[type="text"]'), true);
  assert.equal(doc.getElementById('vrFormDialog').hasAttribute('open'), false);

  const menu = doc.getElementById('vrRowMenu');
  const event = new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 300 });
  doc.querySelector('tr[data-id="2"] [data-field="productName"]').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(menu.hidden, false);
  assert.equal(menu.querySelector('[data-menu="edit"]').hidden, true);
  menu.querySelector('[data-menu="history"]').click();
  await tick();
  assert.equal(menu.hidden, true);
  assert.equal(doc.getElementById('vrFormDialog').dataset.mode, 'history');
});

test('chuot phai -> Sua yeu cau; xoa ngay trong hop sua gui DELETE kem version', async t => {
  let deleted = false;
  const responses = {
    'GET /': () => ({ status: 200, data: listResponse(deleted ? [] : [row(7, { version: 3 })]) }),
    'GET /7/history': HISTORY,
    'GET /metrics': { productName: 'Bát inox', vatStock: null, pendingInsertQty: 0, incomingContainer: '', containerStatus: '', containerEta: '' },
    'DELETE /7': () => { deleted = true; return { status: 200, data: { ok: true } }; }
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Nhân viên sale', responses });
  window.confirm = () => { throw new Error('xoa yeu cau khong duoc hoi xac nhan'); };
  doc.querySelector('tr[data-id="7"] [data-field="customer"]').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 50, clientY: 50 }));
  const edit = doc.querySelector('#vrRowMenu [data-menu="edit"]');
  assert.equal(edit.hidden, false);
  edit.click();
  await tick();
  assert.equal(doc.getElementById('vrFormDialog').dataset.mode, 'edit');
  doc.getElementById('vrFormDelete').click();
  await tick();
  await tick();
  const del = calls.find(c => c.key === 'DELETE /7');
  assert.equal(del.query.version, '3');
  assert.equal(doc.getElementById('vrFormDialog').hasAttribute('open'), false);
  assert.match(doc.getElementById('vrStatus').textContent, /Đã xóa yêu cầu #7/);
});

test('o so / ma / ngay khong xuong dong giua chung; cot Thao tac chi con 1 nut', async t => {
  const { doc } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': listResponse([row(1), lockedRow(2)]) } });
  const tr = doc.querySelector('tr[data-id="1"]');
  for (const field of ['productCode', 'quantity', 'total', 'unitPrice']) assert.ok(tr.querySelector(`[data-field="${field}"]`).classList.contains('vr-nowrap'), field);
  assert.deepEqual([...tr.querySelectorAll('[data-field="actions"] button')].map(b => b.textContent), ['Sửa']);
  assert.deepEqual([...doc.querySelectorAll('tr[data-id="2"] [data-field="actions"] button')].map(b => b.textContent), ['Lịch sử']);
  assert.equal(doc.querySelector('[data-action="delete"]'), null);
});

test('sap xep theo cot tren toan bo danh sach: tang dan -> giam dan -> ve thu tu goc; o trong luon cuoi', async t => {
  const rows = [
    row(1, { customerName: 'Bình', quantity: 50, totalAmount: 500 }),
    row(2, { customerName: 'An', quantity: 300, totalAmount: null }),
    row(3, { customerName: 'Cường', quantity: 7, totalAmount: 70 })
  ];
  const { doc } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': listResponse(rows) } });
  const ids = () => [...doc.querySelectorAll('#vrRows tr[data-id]')].map(tr => Number(tr.dataset.id));
  const header = key => doc.querySelector(`#vrHeadRow [data-sort="${key}"]`);
  assert.equal(doc.querySelector('#vrHeadRow [data-column-key="actions"] .sort-button'), null, 'cot Thao tac khong sap xep');
  header('quantity').click();
  assert.deepEqual(ids(), [3, 1, 2]);
  assert.equal(header('quantity').closest('th').getAttribute('aria-sort'), 'ascending');
  assert.equal(header('quantity').querySelector('.sort-indicator').textContent, '▼');
  header('quantity').click();
  assert.deepEqual(ids(), [2, 1, 3]);
  assert.equal(header('quantity').querySelector('.sort-indicator').textContent, '▲');
  header('quantity').click();
  assert.deepEqual(ids(), [1, 2, 3], 've thu tu goc');
  assert.equal(header('quantity').closest('th').getAttribute('aria-sort'), 'none');
  header('customer').click();
  assert.deepEqual(ids(), [2, 1, 3], 'sap chu theo tieng Viet');
  header('total').click();
  assert.deepEqual(ids(), [3, 1, 2], 'o trong nam cuoi');
  header('total').click();
  assert.deepEqual(ids(), [1, 3, 2], 'giam dan o trong van cuoi');
});

test('mau theo trang thai: o chon KT phan hoi mang data-status va doi mau ngay khi chon; nut loc dang chon co aria-pressed', async t => {
  const responses = {
    'GET /': listResponse([row(1, { canProcess: true, status: '3', statusLabel: '3. Chờ khai chèn' })]),
    'PATCH /1': body => ({ status: 200, data: row(1, { ...body, version: 2, canProcess: true, statusLabel: '1. Đã xong' }) })
  };
  const { window, doc } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  assert.equal(gridCell(doc, 1, 'status').querySelector('.vr-badge').dataset.status, '3', 'chua sua: hien nhan mau');
  const select = editCell(window, doc, 1, 'status');
  assert.ok(select.classList.contains('vr-status-select'));
  assert.equal(select.dataset.status, '3');
  select.value = '1';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(select.dataset.status, '1', 'doi mau truoc khi luu xong');
  await tick(); await tick(); await tick();
  const chips = [...doc.querySelectorAll('#vrStatusChips .vr-chip')];
  assert.deepEqual(chips.map(c => c.dataset.preset), ['all', 'todo', 'pending', '0', '5', '1', '2', '3', '4']);
  assert.deepEqual(chips.filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.preset), ['todo']);
});

test('kieu Sheet — sale: keo chon vung o roi Ctrl+C chep TSV (so tron, ngay dd/mm/yyyy); khong co cham keo / o sua', async t => {
  const rows = [row(1, { arrivalDate: '2026-10-28', saleNote: 'gấp\tlắm' }), row(2, { quantity: 1200, unitPrice: 9500, totalAmount: 11400000 })];
  const { window, doc } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': saleListResponse(rows) } });
  const down = mouse(window, gridCell(doc, 1, 'quantity'), 'mousedown');
  assert.equal(down.defaultPrevented, true, 'khong boi den chu kieu trinh duyet');
  mouse(window, gridCell(doc, 2, 'unitPrice'), 'mouseover');
  mouse(window, doc, 'mouseup');
  assert.equal(doc.querySelectorAll('td.vr-cell-sel').length, 4);
  const copied = clipboard(window, doc, 'copy');
  assert.equal(copied.event.defaultPrevented, true);
  assert.equal(copied.text, '400\t11400\n1200\t9500');
  dragSelect(window, doc, [1, 'saleNote'], [1, 'arrivalDate']);
  assert.equal(clipboard(window, doc, 'copy').text, '"gấp\tlắm"\tChờ KT xử lý\t\t28/10/2026', 'o co tab duoc boc ngoac kep');
  assert.equal(doc.querySelector('.vr-fill-handle'), null, 'sale khong keo nhan ban');
  assert.equal(doc.querySelector('td[data-editable]'), null);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelectorAll('td.vr-cell-sel').length, 0, 'Esc bo chon');
});

test('kieu Sheet — KT keo cham o KT note xuong 2 dong: 1 lan PATCH /bulk dung version tung dong; Hoan tac gui lai gia tri cu', async t => {
  const responses = {
    'GET /': listResponse([row(1, { canProcess: true, accountantNote: 'CONT 10-6V' }), row(2, { canProcess: true, version: 4 }), row(3, { canProcess: true, version: 2, accountantNote: 'cũ' })]),
    'PATCH /bulk': bulkEcho
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  mouse(window, gridCell(doc, 1, 'accountantNote'), 'mousedown');
  mouse(window, doc, 'mouseup');
  const handle = gridCell(doc, 1, 'accountantNote').querySelector('.vr-fill-handle');
  assert.ok(handle, 'cham keo o goc o dang chon');
  mouse(window, handle, 'mousedown');
  mouse(window, gridCell(doc, 3, 'accountantNote'), 'mouseover');
  assert.equal(doc.querySelectorAll('td.vr-fill-target').length, 2, 'to vung dich khi dang keo');
  mouse(window, doc, 'mouseup');
  await tick(); await tick();
  const bulk = calls.filter(c => c.key === 'PATCH /bulk');
  assert.equal(bulk.length, 1);
  assert.deepEqual(bulk[0].body.items, [{ id: 2, version: 4, changes: { accountantNote: 'CONT 10-6V' } }, { id: 3, version: 2, changes: { accountantNote: 'CONT 10-6V' } }]);
  assert.equal(gridCell(doc, 3, 'accountantNote').textContent, 'CONT 10-6V');
  assert.ok(gridCell(doc, 3, 'accountantNote').classList.contains('vr-cell-sel'), 'vung chon noi ra ca phan vua dien');
  assert.match(doc.getElementById('vrStatus').textContent, /Đã sửa 2 yêu cầu/);
  const toast = doc.getElementById('vrToast');
  assert.equal(toast.hidden, false, 'thong bao noi goc duoi');
  assert.match(toast.textContent, /Đã sửa 2 yêu cầu/);
  toast.querySelector('[data-toast="undo"]').click();
  await tick(); await tick();
  const undo = calls.filter(c => c.key === 'PATCH /bulk')[1];
  assert.deepEqual(undo.body.items, [{ id: 2, version: 5, changes: { accountantNote: '' } }, { id: 3, version: 3, changes: { accountantNote: 'cũ' } }]);
  assert.match(doc.getElementById('vrStatus').textContent, /Đã hoàn tác: sửa 2 yêu cầu/);
  assert.equal(toast.querySelector('[data-toast="undo"]').hidden, true, 'het buoc hoan tac');
  assert.equal(toast.querySelector('[data-toast="redo"]').hidden, false, 'co lam lai');
});

test('kieu Sheet — KT dan cot trang thai tu Sheet (gia tri sai bo qua); dan 1 ngay vao vung 3 o dien ca 3', async t => {
  let lists = 0;
  const responses = {
    'GET /': () => { lists += 1; return { status: 200, data: listResponse([1, 2, 3].map(id => row(id, { canProcess: true }))) }; },
    'PATCH /bulk': bulkEcho
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  mouse(window, gridCell(doc, 1, 'status'), 'mousedown');
  mouse(window, doc, 'mouseup');
  const pasted = clipboard(window, doc, 'paste', '2\r\n3. Chờ khai chèn\r\nxx\r\n');
  assert.equal(pasted.event.defaultPrevented, true);
  await tick(); await tick(); await tick();
  assert.deepEqual(calls.find(c => c.key === 'PATCH /bulk').body.items, [{ id: 1, version: 1, changes: { status: '2' } }, { id: 2, version: 1, changes: { status: '3' } }]);
  assert.match(doc.getElementById('vrStatus').textContent, /Đã sửa 2 yêu cầu\. Bỏ qua 1 ô/);
  assert.equal(lists, 1, 'doi trang thai khong nap lai ca bang');
  assert.deepEqual(calls.find(c => c.key === 'POST /lookup').body, { codes: ['014XOAN'] }, 'chi hoi lai so lieu ma lien quan');

  dragSelect(window, doc, [1, 'arrivalDate'], [3, 'arrivalDate']);
  clipboard(window, doc, 'paste', '28/10/2026');
  await tick(); await tick();
  const dates = calls.filter(c => c.key === 'PATCH /bulk')[1];
  assert.deepEqual(dates.body.items.map(item => [item.id, item.changes.arrivalDate]), [[1, '2026-10-28'], [2, '2026-10-28'], [3, '2026-10-28']]);
});

test('kieu Sheet — KT: go phim mo o sua voi ky tu vua go; Esc o ngay ve bo sua khong luu; Delete xoa note', async t => {
  const responses = { 'GET /': listResponse([row(1, { canProcess: true, accountantNote: 'cũ', arrivalDate: '2026-10-28' })]), 'PATCH /bulk': bulkEcho };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  mouse(window, gridCell(doc, 1, 'accountantNote'), 'mousedown');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'C', bubbles: true, cancelable: true }));
  const input = gridCell(doc, 1, 'accountantNote').querySelector('input[data-inline]');
  assert.equal(input.value, 'C', 'go phim thay noi dung nhu Sheet');
  assert.equal(doc.activeElement, input);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(gridCell(doc, 1, 'accountantNote').textContent, 'cũ');

  const date = editCell(window, doc, 1, 'arrivalDate');
  assert.equal(date.type, 'date');
  date.value = '2026-11-01';
  date.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(gridCell(doc, 1, 'arrivalDate').textContent, '28/10/2026', 'Esc khong luu');
  assert.equal(calls.some(c => c.key.startsWith('PATCH')), false);

  mouse(window, gridCell(doc, 1, 'accountantNote'), 'mousedown');
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  await tick(); await tick();
  assert.deepEqual(calls.find(c => c.key === 'PATCH /bulk').body.items, [{ id: 1, version: 1, changes: { accountantNote: '' } }]);
});

// ---- Keo dong doi thu tu uu tien chung (KT) ----
const rowIds = doc => [...doc.querySelectorAll('#vrRows tr[data-id]')].map(tr => Number(tr.dataset.id));
const grip = (doc, id) => doc.querySelector(`[data-row-drag="${id}"]`);
function dragRow(window, doc, id, targetId, clientY = 0) {
  mouse(window, grip(doc, id), 'mousedown');
  mouse(window, doc.querySelector(`tr[data-id="${targetId}"] td[data-field="customer"]`), 'mousemove', { clientY });
  mouse(window, doc, 'mouseup');
}

test('keo dong — KT co tay nam, sale khong; an khi sap xep theo cot / gop ma / tim kiem / chua ap migration', async t => {
  const kt = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses: { 'GET /': listResponse([1, 2, 3].map(id => row(id, { canProcess: true }))) }, featurePermissions: PROCESS_GRANTED });
  assert.equal(kt.doc.querySelectorAll('[data-row-drag]').length, 3);
  assert.match(grip(kt.doc, 1).getAttribute('aria-label'), /Kéo để đổi thứ tự yêu cầu #1/);
  kt.doc.querySelector('#vrHeadRow [data-sort="quantity"]').click();
  assert.equal(kt.doc.querySelector('[data-row-drag]'), null, 'dang sap xep theo cot');
  kt.doc.querySelector('#vrHeadRow [data-sort="quantity"]').click();
  kt.doc.querySelector('#vrHeadRow [data-sort="quantity"]').click();
  assert.equal(kt.doc.querySelectorAll('[data-row-drag]').length, 3, 've thu tu goc thi hien lai');
  kt.doc.getElementById('vrGroupToggle').click();
  assert.equal(kt.doc.querySelector('[data-row-drag]'), null, 'dang gop theo ma');
  kt.doc.getElementById('vrGroupToggle').click();
  const search = kt.doc.getElementById('vrSearch');
  search.value = 'bát';
  search.dispatchEvent(new kt.window.Event('input', { bubbles: true }));
  if (kt.window.TKSFuzzySearch) assert.equal(kt.doc.querySelector('[data-row-drag]'), null, 'dang tim kiem');

  const sale = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': saleListResponse([row(1), row(2)]) } });
  assert.equal(sale.doc.querySelector('[data-row-drag]'), null);

  const legacy = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses: { 'GET /': { ...listResponse([row(1, { canProcess: true })]), rowOrder: false } }, featurePermissions: PROCESS_GRANTED });
  assert.equal(legacy.doc.querySelector('[data-row-drag]'), null, 'chua ap migration 0079');
});

test('keo dong — tha len tren dong 1 gui belowId, tha xuong cuoi gui aboveId; Alt+mui ten doi 1 dong; khong bat vung chon o', async t => {
  const responses = {
    'GET /': listResponse([1, 2, 3].map(id => row(id, { canProcess: true }))),
    'PATCH /position': () => ({ status: 200, data: { ok: true } })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  assert.deepEqual(rowIds(doc), [1, 2, 3]);
  mouse(window, grip(doc, 3), 'mousedown');
  mouse(window, doc.querySelector('tr[data-id="1"] td[data-field="customer"]'), 'mousemove', { clientY: 0 });
  assert.ok(doc.querySelector('tr[data-id="1"]').classList.contains('vr-drop-before'), 'vach chi cho tha');
  assert.ok(doc.querySelector('tr[data-id="3"]').classList.contains('vr-row-dragging'));
  mouse(window, doc, 'mouseup');
  assert.deepEqual(rowIds(doc), [3, 1, 2], 'doi thu tu ngay');
  await tick();
  assert.deepEqual(calls.find(c => c.key === 'PATCH /position').body, { ids: [3], belowId: 1 });
  assert.match(doc.getElementById('vrStatus').textContent, /Đã chuyển yêu cầu #3/);
  assert.equal(doc.querySelectorAll('td.vr-cell-sel').length, 0, 'keo dong khong chon o');
  assert.equal(doc.querySelector('.vr-drop-before, .vr-drop-after, .vr-row-dragging'), null);

  dragRow(window, doc, 1, 2, 10); // nua duoi dong cuoi -> xuong cuoi
  await tick();
  assert.deepEqual(rowIds(doc), [3, 2, 1]);
  assert.deepEqual(calls.filter(c => c.key === 'PATCH /position').pop().body, { ids: [1], aboveId: 2 });

  const before = calls.length;
  dragRow(window, doc, 2, 2, 0); // tha lai cho cu
  assert.equal(calls.length, before, 'tha lai cho cu khong goi API');

  grip(doc, 3).dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  await tick(); await tick();
  assert.deepEqual(rowIds(doc), [2, 3, 1]);
  assert.deepEqual(calls.filter(c => c.key === 'PATCH /position').pop().body, { ids: [3], belowId: 1 });
  assert.equal(doc.activeElement, grip(doc, 3), 'giu focus o tay nam');
});

test('keo dong — API loi thi bao loi va nap lai thu tu tu may chu; Esc huy keo', async t => {
  let lists = 0;
  const responses = {
    'GET /': () => { lists += 1; return { status: 200, data: listResponse([1, 2].map(id => row(id, { canProcess: true }))) }; },
    'PATCH /position': () => ({ status: 403, data: { error: 'Bạn không có quyền xếp thứ tự ORDER VAT.', code: 'FEATURE_FORBIDDEN' } })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  mouse(window, grip(doc, 2), 'mousedown');
  mouse(window, doc.querySelector('tr[data-id="1"] td[data-field="customer"]'), 'mousemove', { clientY: 0 });
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  mouse(window, doc, 'mouseup');
  assert.equal(calls.some(c => c.key === 'PATCH /position'), false, 'Esc huy keo');

  dragRow(window, doc, 2, 1, 0);
  assert.deepEqual(rowIds(doc), [2, 1]);
  await tick(); await tick(); await tick();
  assert.match(doc.getElementById('vrStatus').textContent, /không có quyền xếp thứ tự/);
  assert.equal(lists, 2, 'nap lai danh sach');
  assert.deepEqual(rowIds(doc), [1, 2], 'tro ve thu tu tu may chu');
});

test('kieu Sheet — PATCH /bulk 409: nap lai roi van giu thong bao xung dot', async t => {
  const responses = {
    'GET /': listResponse([1, 2].map(id => row(id, { canProcess: true, accountantNote: 'A' }))),
    'PATCH /bulk': () => ({ status: 409, data: { error: '1 yêu cầu vừa được người khác cập nhật. Hãy tải lại rồi thử lại.', code: 'VERSION_CONFLICT', conflictIds: [2] } })
  };
  const { window, doc } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  dragSelect(window, doc, [1, 'accountantNote'], [2, 'accountantNote']);
  clipboard(window, doc, 'paste', 'B');
  await tick(); await tick(); await tick();
  assert.match(doc.getElementById('vrStatus').textContent, /vừa được người khác cập nhật/);
  assert.equal(doc.getElementById('vrStatus').dataset.kind, 'warn');
});

test('keo nhieu dong — bam tay nam chon dong (tick o Chon), Shift chon doan, Ctrl them/bo; keo nhom roi gom thanh 1 khoi', async t => {
  const responses = {
    'GET /': listResponse([1, 2, 3, 4, 5, 6].map(id => row(id, { canProcess: true }))),
    'PATCH /position': () => ({ status: 200, data: { ok: true } })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  const picked = () => [...doc.querySelectorAll('#vrRows tr.is-picked')].map(tr => Number(tr.dataset.id));
  const ticked = () => [...doc.querySelectorAll('[data-select]:checked')].map(box => Number(box.dataset.select));
  const click = (id, extra = {}) => { mouse(window, grip(doc, id), 'mousedown', extra); mouse(window, doc, 'mouseup'); };

  click(2);
  assert.deepEqual(picked(), [2], 'bam tay nam chon ca dong');
  assert.deepEqual(ticked(), [2], 'chung vung chon voi o tick');
  click(4, { shiftKey: true });
  assert.deepEqual(picked(), [2, 3, 4], 'Shift chon doan lien');
  click(3, { ctrlKey: true });
  assert.deepEqual(picked(), [2, 4], 'Ctrl bo 1 dong');
  click(6, { ctrlKey: true });
  assert.deepEqual(picked(), [2, 4, 6], 'Ctrl them dong roi');

  // Keo tay nam dong 4 (dang chon) len tren dong 1 -> ca nhom 2, 4, 6 gom thanh khoi o dau
  mouse(window, grip(doc, 4), 'mousedown');
  assert.deepEqual([...doc.querySelectorAll('tr.vr-row-dragging')].map(tr => Number(tr.dataset.id)), [2, 4, 6], 'ca nhom mo di');
  mouse(window, doc.querySelector('tr[data-id="1"] td[data-field="customer"]'), 'mousemove', { clientY: 0 });
  mouse(window, doc, 'mouseup');
  assert.deepEqual(rowIds(doc), [2, 4, 6, 1, 3, 5]);
  await tick();
  assert.deepEqual(calls.find(c => c.key === 'PATCH /position').body, { ids: [2, 4, 6], belowId: 1 });
  assert.match(doc.getElementById('vrStatus').textContent, /Đã chuyển 3 yêu cầu/);
  assert.deepEqual(picked(), [2, 4, 6], 'van giu vung chon sau khi tha');

  // Tha khoi xuong cuoi
  mouse(window, grip(doc, 6), 'mousedown');
  mouse(window, doc.querySelector('tr[data-id="5"] td[data-field="customer"]'), 'mousemove', { clientY: 10 });
  mouse(window, doc, 'mouseup');
  await tick();
  assert.deepEqual(rowIds(doc), [1, 3, 5, 2, 4, 6]);
  assert.deepEqual(calls.filter(c => c.key === 'PATCH /position').pop().body, { ids: [2, 4, 6], aboveId: 5 });

  // Tha vao giua chinh khoi / ngay canh khoi lien -> khong goi API
  const before = calls.length;
  mouse(window, grip(doc, 2), 'mousedown');
  mouse(window, doc.querySelector('tr[data-id="5"] td[data-field="customer"]'), 'mousemove', { clientY: 10 });
  mouse(window, doc, 'mouseup');
  assert.equal(calls.length, before, 'khoi da o dung cho');

  // Bam (khong keo) vao 1 dong trong vung nhieu dong -> chi con dong do
  click(4);
  assert.deepEqual(picked(), [4]);
  assert.deepEqual(ticked(), [4]);
});

// ---- Giu dong vua sua, chip chon nhieu, Ctrl+Z / Ctrl+Y ----
const keyDown = (window, doc, key, extra = {}) => doc.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));

test('chip trang thai chon nhieu; Can xu ly / Tat ca chi chon mot minh; tat het ve Tat ca', async t => {
  const { doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses: { 'GET /': listResponse([]) }, featurePermissions: PROCESS_GRANTED });
  const pressed = () => [...doc.querySelectorAll('#vrStatusChips .vr-chip')].filter(c => c.getAttribute('aria-pressed') === 'true').map(c => c.dataset.preset);
  const chip = key => doc.querySelector(`#vrStatusChips [data-preset="${key}"]`);
  const lastStatus = () => calls.filter(c => c.key === 'GET /').pop().query.status;
  assert.deepEqual(pressed(), ['todo']);
  chip('1').click();
  assert.deepEqual(pressed(), ['1'], 'bam trang thai khi dang Can xu ly -> chi con trang thai do');
  assert.equal(lastStatus(), '1');
  chip('2').click();
  assert.deepEqual(pressed(), ['1', '2']);
  assert.equal(lastStatus(), '1,2');
  chip('1').click();
  assert.deepEqual(pressed(), ['2'], 'bam lai thi tat');
  chip('2').click();
  assert.deepEqual(pressed(), ['all'], 'tat het -> Tat ca');
  assert.equal(lastStatus(), undefined);
  chip('3').click(); chip('4').click();
  chip('todo').click();
  assert.deepEqual(pressed(), ['todo'], 'Can xu ly chi chon mot minh');
  assert.equal(lastStatus(), 'pending,3,4');  await tick(); await tick();
});

test('doi trang thai: dong o lai bang (gui keep) cho toi khi doi bo loc / bam tai lai; Excel khong gui keep', async t => {
  const responses = {
    'GET /': () => ({ status: 200, data: listResponse([row(1, { canProcess: true }), row(2, { canProcess: true })]) }),
    'PATCH /1': body => ({ status: 200, data: row(1, { ...body, version: 2, canProcess: true, statusLabel: '1. Đã xong' }) }),
    'GET /export': () => ({ status: 200, data: 'xlsx', headers: { 'content-disposition': 'attachment; filename="x.xlsx"' } })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  const select = editCell(window, doc, 1, 'status');
  select.value = '1';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(); await tick();
  const lists = () => calls.filter(c => c.key === 'GET /');
  assert.equal(lists().pop().query.keep, '1', 'nap lai so lieu van giu dong vua sua');
  doc.getElementById('vrExport').click();
  await tick();
  assert.equal(calls.find(c => c.key === 'GET /export').query.keep, undefined);
  doc.getElementById('vrReload').click();
  await tick();
  assert.equal(lists().pop().query.keep, undefined, 'bam tai lai bo dong giu lai');

  const again = editCell(window, doc, 1, 'status');
  again.value = '1'; // giong cu -> khong luu; doi sang gia tri khac
  again.value = '2';
  again.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(); await tick();
  assert.equal(lists().pop().query.keep, '1');
  doc.querySelector('#vrStatusChips [data-preset="all"]').click();
  await tick();
  assert.equal(lists().pop().query.keep, undefined, 'doi chip bo dong giu lai');
});

test('Ctrl+Z hoan tac sua 1 o va keo dong nhieu buoc, Ctrl+Y lam lai; dang go trong o thi khong bat', async t => {
  let version = 1;
  const responses = {
    'GET /': () => ({ status: 200, data: listResponse([row(1, { canProcess: true, version, accountantNote: version > 1 ? 'MOI' : 'CU' }), row(2, { canProcess: true })]) }),
    'PATCH /bulk': body => { if (body.items[0].id === 1) version = body.items[0].version + 1; return bulkEcho(body); },
    'PATCH /position': () => ({ status: 200, data: { ok: true, before: { 2: '100' }, after: { 2: '300' } } }),
    'PATCH /position/ranks': () => ({ status: 200, data: { ok: true, updated: 1 } })
  };
  const { window, doc, calls } = await setup(t, { vaiTro: 'Kế toán', id: 'kt-1', responses, featurePermissions: PROCESS_GRANTED });
  const note = editCell(window, doc, 1, 'accountantNote');
  note.value = 'MOI';
  note.dispatchEvent(new window.Event('change', { bubbles: true }));
  await tick(); await tick();
  dragRow(window, doc, 2, 1, 0);
  await tick(); await tick();

  keyDown(window, doc, 'z', { ctrlKey: true });
  await tick(); await tick(); await tick();
  assert.deepEqual(calls.filter(c => c.key === 'PATCH /position/ranks').pop().body, { ranks: { 2: '100' } }, 'buoc 1: hoan tac keo dong');
  keyDown(window, doc, 'z', { ctrlKey: true });
  await tick(); await tick(); await tick();
  assert.deepEqual(calls.filter(c => c.key === 'PATCH /bulk').pop().body, { items: [{ id: 1, version: 2, changes: { accountantNote: 'CU' } }] }, 'buoc 2: hoan tac sua o');
  assert.match(doc.getElementById('vrToast').textContent, /Đã hoàn tác: sửa yêu cầu #1/);
  keyDown(window, doc, 'z', { ctrlKey: true });
  await tick();
  assert.match(doc.getElementById('vrToast').textContent, /Không còn thao tác để hoàn tác/);

  keyDown(window, doc, 'y', { ctrlKey: true });
  await tick(); await tick(); await tick();
  assert.deepEqual(calls.filter(c => c.key === 'PATCH /bulk').pop().body.items[0].changes, { accountantNote: 'MOI' }, 'Ctrl+Y lam lai');

  const before = calls.length;
  const input = editCell(window, doc, 2, 'accountantNote');
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
  await tick();
  assert.equal(calls.length, before, 'dang go trong o thi Ctrl+Z la cua o nhap');
});

test('Ctrl+Z khong lam gi voi sale', async t => {
  const { window, doc, calls } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': saleListResponse([row(1)]) } });
  const before = calls.length;
  keyDown(window, doc, 'z', { ctrlKey: true });
  await tick();
  assert.equal(calls.length, before);
  assert.equal(doc.getElementById('vrToast'), null);
});

test('thanh tab Ke toan: ORDER VAT dang chon, co Tra cuu VAT; khong con nut rieng o dau trang', async t => {
  const { doc } = await setup(t, { vaiTro: 'Nhân viên sale', responses: { 'GET /': saleListResponse([row(1)]) } });
  assert.deepEqual([...doc.querySelectorAll('#vrTabs a')].map(a => a.getAttribute('href')), ['/vat-draft/#tao-qr', '/vat-lookup/', '/vat-request/']);
  assert.equal(doc.querySelector('#vrTabs [aria-current="page"]').getAttribute('href'), '/vat-request/');
  assert.equal(doc.getElementById('vrLookupLink'), null);
});
