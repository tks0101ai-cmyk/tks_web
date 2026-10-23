'use strict';

// Muc 2 "Du kien hang ve" cua tab Hang hoa (/reports/#products): bang toan bo dong hang cua moi cont tu
// API rieng /api/expected-arrivals (quyen reports.products.expected), loc Cont / Trang thai o trinh duyet,
// chi so theo dong dang hien, nut "Xuat file", va luong cua tai khoan CHI co quyen moi (Ke toan / Mua hang / Kho).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

// Dòng mẫu như máy chủ trả cho tài khoản KHÔNG có quyền xem giá: không có listedAt / unitPriceCny / vietnamPrice (status số 1–5 luôn có).
const row = (over) => Object.assign({
  scheduleLabel: '2. Đã bốc 18-20/10', statusLabel: '2. Đã bốc', status: 2, eta: '18-20/10', containerName: 'CONT 10-5H',
  productCode: 'MCRY301', productName: 'Máy cạo râu 301', color: 'Đen', saleNote: 'Giữ cho khách A', orderedBy: 'Lan',
  unitsPerPackage: 24, packageCount: 10, quantity: 240, sheetName: 'YIWU', sourceRow: 5
}, over);

const SAMPLE = {
  rows: [
    row({}),
    row({ sheetName: 'CONT TKS1', productCode: 'MCRY302', productName: 'Máy cạo râu 302', color: null, saleNote: null, orderedBy: 'Hoa', unitsPerPackage: 12, packageCount: 5, quantity: 60, sourceRow: 6 }),
    row({ scheduleLabel: '1. Chưa bốc 05/11', statusLabel: '1. Chưa bốc', status: 1, eta: '05/11', containerName: 'CONT 11-2A', productCode: 'QAT001', productName: 'Quạt mini', color: 'Trắng', orderedBy: null, unitsPerPackage: null, packageCount: null, quantity: 1000, sourceRow: 12 }),
    row({ scheduleLabel: '3. Đã về kho', statusLabel: '3. Đã về kho', status: 3, eta: '', containerName: 'CONT 09-1C', productCode: 'DEN200', productName: 'Đèn bàn 200', quantity: 500, sourceRow: 20 })
  ],
  filters: { containers: ['CONT 10-5H', 'CONT 11-2A', 'CONT 09-1C'], statuses: ['1. Chưa bốc', '2. Đã bốc', '3. Đã về kho'] },
  meta: { computedAt: '2026-10-20T03:00:00.000Z', version: 7, rowCount: 4 },
  fullAccess: false
};

// Bản cho Quản lý / Trợ lý (reports.overview.containers.full): có thêm Ngày lên list + Giá SP (tệ) + Giá hàng về VN.
const FULL_SAMPLE = {
  ...SAMPLE,
  rows: SAMPLE.rows.map((r, i) => ({ ...r, listedAt: '15/10', unitPriceCny: i === 2 ? null : 1.44 + i, vietnamPrice: i === 2 ? null : 26420.4 + i * 1000 })),
  fullAccess: true
};

const FIELDS = {
  title: 'Dự kiến hàng về', selectionMode: 'custom',
  worksheets: [{ key: 'expected', name: 'Dự kiến hàng về', rowCount: 4, fields: [
    { key: 'sheetName', label: 'Nguồn', type: 'text', selected: true },
    { key: 'scheduleLabel', label: 'Lịch/Trạng thái', type: 'text', selected: true },
    { key: 'containerName', label: 'Tên Cont', type: 'text', selected: true },
    { key: 'quantity', label: 'Tổng số lượng', type: 'number', selected: true }
  ] }]
};

// `real: true` mo phong TKSNav that: co getPermissions + authGuard nap quyen roi moi tai (trang cho quyen).
function createPage({ permissions = null, can = () => true, hash = '#products', real = false, respond = SAMPLE } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/reports/' + hash });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; }
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = cb => cb();
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.URL.createObjectURL = () => 'blob:test';
  dom.window.URL.revokeObjectURL = () => {};
  const downloads = [];
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.getAttribute('download')); };
  dom.window.EventSource = class { constructor(url) { dom.sseUrls = (dom.sseUrls || []).concat(url); } addEventListener() {} close() {} };

  if (real) {
    const perms = permissions || [];
    dom.window.TKSNav = {
      getPermissions: () => perms.slice(),
      can: (...keys) => keys.some(k => perms.includes(k)),
      authGuard: () => Promise.resolve({ vaiTro: 'Kế toán', permissions: perms }),
      handleBranchError: () => false, renderTopSidebar() {}
    };
  } else {
    dom.window.TKSNav = { authGuard: () => new Promise(() => {}), can, handleBranchError: () => false, renderTopSidebar() {} };
  }

  const urls = [];
  dom.window.fetch = (url) => {
    const href = String(url);
    urls.push(href);
    const ok = body => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (href === '/api/expected-arrivals') return respond instanceof Error ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) }) : ok(respond);
    if (href.startsWith('/api/expected-arrivals/export/fields')) return ok(FIELDS);
    if (href.startsWith('/api/expected-arrivals/export?')) {
      const params = new URLSearchParams(href.split('?')[1]);
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: name => (/disposition/i.test(name) ? 'attachment; filename="TKS_Du_kien_hang_ve.' + params.get('format') + '"' : null) },
        blob: async () => new dom.window.Blob(['x'])
      });
    }
    return new Promise(() => {}); // cac API khac khong tra loi
  };

  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim())
    .forEach(script => dom.window.eval(script));

  const doc = dom.window.document;
  return { dom, doc, urls, downloads, $: id => doc.getElementById(id), run: code => dom.window.eval(code) };
}

const bodyRows = page => [...page.$('expectedArrivalsRows').querySelectorAll('tr')].filter(tr => tr.cells.length > 1);
const cellTexts = tr => [...tr.cells].map(c => c.textContent.trim());
const cellOf = (tr, key) => {
  const headers = [...tr.closest('table').querySelectorAll('thead th')];
  return tr.cells[headers.findIndex(th => th.dataset.columnKey === key)];
};
const cardsOf = (page, id) => [...page.$(id).querySelectorAll('.kpi-card')]
  .map(c => [c.querySelector('.eyebrow').textContent.trim(), c.querySelector('.value').textContent.trim()]);
const setSelect = (page, id, value) => {
  page.$(id).value = value;
  page.$(id).dispatchEvent(new page.dom.window.Event('change'));
};
const paramsOf = href => new URLSearchParams(href.split('?')[1]);
const clickInline = (page, el) => { if (!el.disabled) page.run(el.getAttribute('onclick')); };

test('muc 2 nam giua Bao cao hang hoa va Tang truong ma hang, co hang chi so ngay duoi tieu de', () => {
  const page = createPage();
  const sections = [...page.$('view-products').querySelectorAll(':scope > section.section')];
  assert.deepEqual(sections.map(s => s.id), ['productReportSection', 'expectedArrivalsSection', 'productGrowthSection']);
  assert.deepEqual(sections.map(s => s.querySelector('.section-step').textContent.trim()), ['1', '2', '3']);
  const section = page.$('expectedArrivalsSection');
  assert.equal(section.querySelector('.section-head h2').firstChild.textContent.trim(), 'Dự kiến hàng về');
  assert.ok(section.querySelector(':scope > .section-head').nextElementSibling.classList.contains('section-kpis'));
});

test('bang 14 cot dung thu tu, moi th co width px + data-column-key, key bang rieng', () => {
  const page = createPage();
  const table = page.$('expectedArrivalsRows').closest('table');
  assert.equal(table.dataset.tableKey, 'dashboard-table-expected-arrivals');
  const ths = [...table.querySelectorAll('thead th')];
  assert.deepEqual(ths.map(th => th.textContent.replace(/[▲▼]/g, '').trim()),
    ['Nguồn', 'Lịch/Trạng thái', 'Tên Cont', 'Mã SP', 'Tên SP', 'Màu sắc', 'Ghi chú sale', 'Ghi chú khác', 'Người đặt', 'Số cái/kiện', 'Số kiện', 'Tổng số lượng', 'Giá SP (tệ)', 'Giá hàng về VN']);
  ths.forEach(th => {
    assert.match(th.getAttribute('style') || '', /width:\s*\d+px/);
    assert.ok(th.dataset.columnKey, 'thieu data-column-key');
  });
  assert.equal(new Set(ths.map(th => th.dataset.columnKey)).size, 14);
  assert.deepEqual(ths.slice(-2).map(th => th.dataset.columnKey), ['gia-te', 'gia-vn']);
  // Quy uoc tieu de sap xep: moi th co nut sap xep, glyph chua sap la ▲▼.
  ths.forEach(th => assert.equal(th.querySelector('.sort-indicator').textContent, '▲▼'));
  assert.equal(table.querySelector('tbody').id, 'expectedArrivalsRows');
});

test('dang ky TABLE_EXPLORER_CONFIGS de tim kiem; hai o loc co aria-label', () => {
  const page = createPage();
  assert.ok(page.dom.window.TABLE_EXPLORER_CONFIGS.expectedArrivals);
  assert.equal(page.$('expectedArrivalsContainer').getAttribute('aria-label'), 'Lọc theo cont');
  assert.equal(page.$('expectedArrivalsStatus').getAttribute('aria-label'), 'Lọc theo trạng thái');
  assert.equal(page.$('expectedArrivalsContainer').options[0].textContent, 'Tất cả cont');
  assert.equal(page.$('expectedArrivalsStatus').options[0].textContent, 'Tất cả trạng thái');
});

test('vao tab Hang hoa: goi /api/expected-arrivals, ve du 4 dong, cot A = B+C, so en-US, thoi diem cap nhat', async () => {
  const page = createPage();
  page.run("switchView('products')");
  await settle();
  assert.equal(page.urls.filter(u => u === '/api/expected-arrivals').length, 1);
  assert.equal(page.$('expectedArrivalsSection').hidden, false);
  const rows = bodyRows(page);
  assert.equal(rows.length, 4);
  assert.deepEqual(cellTexts(rows[0]), ['', '2. Đã bốc 18-20/10', 'CONT 10-5H', 'MCRY301', 'Máy cạo râu 301', 'Đen', 'Giữ cho khách A', '—', 'Lan', '24', '10', '240', '—', '—']);
  // Gia tri rong -> "—"; so lon dinh dang 1,000.
  // Khong co fullAccess: o Nguon (cot dau) rong, khong lo ten sheet / token an danh.
  assert.deepEqual(cellTexts(rows[2]).slice(5), ['Trắng', 'Giữ cho khách A', '—', '—', '—', '—', '1,000', '—', '—']);
  assert.match(page.$('expectedArrivalsUpdatedAt').textContent, /^Dữ liệu cập nhật lúc /);
  assert.equal(page.$('tagExpectedArrivals').textContent, '4');
});

test('hai o loc lay danh sach tu filters cua may chu; loc theo Cont va Trang thai (statusLabel = o B), chi so theo dong da loc', async () => {
  const page = createPage();
  page.run("switchView('products')");
  await settle();
  assert.deepEqual([...page.$('expectedArrivalsContainer').options].map(o => o.value), ['', 'CONT 10-5H', 'CONT 11-2A', 'CONT 09-1C']);
  assert.deepEqual([...page.$('expectedArrivalsStatus').options].map(o => o.value), ['', '1. Chưa bốc', '2. Đã bốc', '3. Đã về kho']);
  // KPI ban dau: 3 cont, 4 dong, tong 1800.
  assert.deepEqual(cardsOf(page, 'expectedArrivalsKpis'), [['Số cont', '3'], ['Số dòng hàng', '4'], ['Tổng số lượng', '1,800']]);

  setSelect(page, 'expectedArrivalsContainer', 'CONT 10-5H');
  assert.equal(bodyRows(page).length, 2);
  assert.deepEqual(cardsOf(page, 'expectedArrivalsKpis'), [['Số cont', '1'], ['Số dòng hàng', '2'], ['Tổng số lượng', '300']]);
  assert.equal(page.$('tagExpectedArrivals').textContent, '2');

  // Trang thai loc theo o B (statusLabel) nen "2. Đã bốc" giu ca dong co lich "2. Đã bốc 18-20/10".
  setSelect(page, 'expectedArrivalsContainer', '');
  setSelect(page, 'expectedArrivalsStatus', '2. Đã bốc');
  assert.equal(bodyRows(page).length, 2);
  assert.ok(bodyRows(page).every(tr => cellTexts(tr)[1] === '2. Đã bốc 18-20/10'));

  setSelect(page, 'expectedArrivalsContainer', 'CONT 11-2A');
  assert.equal(bodyRows(page).length, 0, 'Cont + Trang thai la giao cua hai bo loc');
  assert.match(page.$('expectedArrivalsRows').textContent, /Chưa có hàng dự kiến về/);
  assert.deepEqual(cardsOf(page, 'expectedArrivalsKpis'), [['Số cont', '0'], ['Số dòng hàng', '0'], ['Tổng số lượng', '0']]);
});

test('tim kiem trong bang cap nhat ca bang lan chi so; sap xep theo Tong so luong', async () => {
  const page = createPage();
  page.run("switchView('products')");
  await settle();
  const input = page.doc.querySelector('[data-table-search="expectedArrivals"] input[type="search"], [data-table-search="expectedArrivals"] input');
  assert.ok(input, 'phai co o tim kiem');
  input.value = 'quạt';
  input.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  await settle();
  assert.equal(bodyRows(page).length, 1);
  assert.equal(cellTexts(bodyRows(page)[0])[3], 'QAT001');
  assert.deepEqual(cardsOf(page, 'expectedArrivalsKpis'), [['Số cont', '1'], ['Số dòng hàng', '1'], ['Tổng số lượng', '1,000']]);
  input.value = '';
  input.dispatchEvent(new page.dom.window.Event('input', { bubbles: true }));
  await settle();

  page.$('expectedArrivalsRows').closest('table').querySelector('thead th[data-column-key="tong-so-luong"] .sort-button').click();
  assert.deepEqual(bodyRows(page).map(tr => cellOf(tr, 'tong-so-luong').textContent), ['60', '240', '500', '1,000']);
});

test('loi tai /api/expected-arrivals: hien thong bao trong bang, khong ne loi', async () => {
  const page = createPage({ respond: new Error('x') });
  page.run("switchView('products')");
  await settle();
  assert.match(page.$('expectedArrivalsRows').textContent, /Không tải được bảng dự kiến hàng về/);
});

test('nut Xuat file: mo hop thoai chung, gui container/status/q dang ap, xuat dung cot da chon (xlsx va html)', async () => {
  const page = createPage();
  page.run("switchView('products')");
  await settle();
  const btn = page.$('expectedArrivalsExport').querySelector('button.export-button');
  assert.equal(btn.textContent.trim(), 'Xuất file');
  assert.ok(btn.hasAttribute('data-not-export'), 'khong bi an boi reports.export');
  assert.equal(btn.getAttribute('onclick'), 'openExpectedArrivalsExportDialog()');

  setSelect(page, 'expectedArrivalsContainer', 'CONT 10-5H');
  setSelect(page, 'expectedArrivalsStatus', '2. Đã bốc');
  clickInline(page, btn);
  await settle();
  assert.equal(page.$('exportModalBackdrop').hidden, false);
  const fieldsUrl = page.urls.find(u => u.startsWith('/api/expected-arrivals/export/fields'));
  const fp = paramsOf(fieldsUrl);
  assert.equal(fp.get('container'), 'CONT 10-5H');
  assert.equal(fp.get('status'), '2. Đã bốc');
  assert.equal(fp.has('q'), false);
  const inputs = [...page.$('exportFields').querySelectorAll('input[type="checkbox"]')];
  assert.equal(inputs.length, 4);
  inputs.find(i => i.value === 'containerName').checked = false;
  page.run(page.$('exportConfirmButton').getAttribute('onclick'));
  await settle();
  const exportUrl = page.urls.find(u => u.startsWith('/api/expected-arrivals/export?'));
  const p = paramsOf(exportUrl);
  assert.equal(p.get('format'), 'xlsx');
  assert.equal(p.get('container'), 'CONT 10-5H');
  assert.equal(p.get('status'), '2. Đã bốc');
  assert.equal(p.get('columns'), 'sheetName,scheduleLabel,quantity');
  assert.deepEqual(page.downloads, ['TKS_Du_kien_hang_ve.xlsx']);

  clickInline(page, btn);
  await settle();
  page.run(page.$('exportHtmlButton').getAttribute('onclick'));
  await settle();
  const htmlUrls = page.urls.filter(u => u.startsWith('/api/expected-arrivals/export?') && paramsOf(u).get('format') === 'html');
  assert.equal(htmlUrls.length, 1);
});

test('xuat file bi bo qua khi khong co reports.products.expected', async () => {
  const page = createPage({ can: k => k !== 'reports.products.expected' });
  page.run('openExpectedArrivalsExportDialog()');
  await settle();
  assert.equal(page.$('exportModalBackdrop').hidden, true);
  assert.equal(page.urls.some(u => u.startsWith('/api/expected-arrivals')), false);
});

test('thieu reports.products.expected: an muc, khong goi API', async () => {
  const page = createPage({ can: k => k !== 'reports.products.expected' });
  page.run("switchView('products')");
  await settle();
  assert.equal(page.$('expectedArrivalsSection').hidden, true);
  assert.equal(page.urls.includes('/api/expected-arrivals'), false);
});

test('chi co reports.products (khong co quyen moi): an muc moi, van tai Bao cao hang hoa', async () => {
  const page = createPage({ can: k => k === 'reports.products' });
  page.run("switchView('products')");
  await settle();
  assert.equal(page.$('expectedArrivalsSection').hidden, true);
  assert.equal(page.$('productReportSection').hidden, false);
  assert.equal(page.urls.includes('/api/product-report'), true);
});

// ---- Tai khoan CHI co reports.products.expected (Ke toan / NV mua hang / NV kho) tren trang that ----
test('chi co quyen moi: vao duoc tab Hang hoa, chi goi /api/expected-arrivals, cac muc/tab khac an', async () => {
  const page = createPage({ real: true, permissions: ['reports.products.expected'], hash: '' });
  await settle();
  // Tab dang xem la Hang hoa du hash trong (Tong quan khong duoc xem).
  assert.equal(page.$('view-products').classList.contains('active'), true);
  assert.equal(page.$('view-overview').classList.contains('active'), false);
  assert.equal(page.$('expectedArrivalsSection').hidden, false);
  assert.equal(page.$('productReportSection').hidden, true, 'khong co reports.products -> an Bao cao hang hoa');
  assert.equal(page.$('productGrowthSection').hidden, true);
  assert.equal(bodyRows(page).length, 4);

  // KHONG goi bat ky API nao khac (Bao cao hang hoa, ton kho, /api/dashboard, business-report, meta cont...) va khong mo SSE.
  assert.deepEqual(page.urls, ['/api/expected-arrivals']);
  assert.equal(page.dom.sseUrls, undefined, 'khong mo /api/dashboard/events');

  // Chi tab Hang hoa hien tren thanh tab con.
  const visible = [...page.doc.querySelectorAll('.report-subnav-item')].filter(b => !b.hidden).map(b => b.dataset.view);
  assert.deepEqual(visible, ['products']);
});

test('chi co quyen moi, vao thang /reports/#products: cung chi goi API moi', async () => {
  const page = createPage({ real: true, permissions: ['reports.products.expected'], hash: '#products' });
  await settle();
  assert.deepEqual(page.urls, ['/api/expected-arrivals']);
  assert.equal(page.$('view-products').classList.contains('active'), true);
});

test('chi co quyen moi, hash tro toi tab khong duoc xem (#debt): chuyen ve Hang hoa, khong goi API khac', async () => {
  const page = createPage({ real: true, permissions: ['reports.products.expected'], hash: '#debt' });
  await settle();
  assert.equal(page.$('view-products').classList.contains('active'), true);
  assert.deepEqual(page.urls, ['/api/expected-arrivals']);
});

test('trang that co du quyen bao cao: van tai Bao cao hang hoa sau khi nap quyen (khong doi hanh vi cu)', async () => {
  const page = createPage({
    real: true, hash: '#products',
    permissions: ['reports.overview', 'reports.products', 'reports.products.expected', 'reports.business']
  });
  await settle();
  assert.equal(page.urls.includes('/api/product-report'), true);
  assert.equal(page.urls.includes('/api/expected-arrivals'), true);
  assert.equal(page.$('productReportSection').hidden, false);
  assert.equal(page.$('expectedArrivalsSection').hidden, false);
});

test('canViewReport(products): chap nhan reports.products HOAC reports.products.expected', () => {
  const only = createPage({ can: k => k === 'reports.products.expected' });
  assert.equal(only.run("canViewReport('products')"), true);
  assert.equal(only.run("canViewReport('invoices')"), false);
  const none = createPage({ can: () => false });
  assert.equal(none.run("canViewReport('products')"), false);
});

test('shared-nav: muc Hang hoa cua sidebar chap nhan 1 trong 3 quyen', () => {
  const nav = fs.readFileSync(path.join(publicDir, 'shared', 'shared-nav.js'), 'utf8');
  assert.match(nav, /feature: 'reports\.products', anyOf: \['reports\.products', 'reports\.products\.expected', 'reports\.products\.growth'\], view: 'products'/);
});


test('Nguồn displays exact sheet names, escapes markup, and sorts both directions', async () => {
  const source = 'CONT TKS1 <img src=x onerror="alert(1)"> & "Nguồn"';
  const page = createPage({ respond: { ...FULL_SAMPLE, rows: [FULL_SAMPLE.rows[0], FULL_SAMPLE.rows[1], row({ sheetName: source })] } });
  page.run("switchView('products')");
  await settle();
  const table = page.$('expectedArrivalsRows').closest('table');
  assert.equal(table.dataset.tableKey, 'dashboard-table-expected-arrivals');
  assert.equal(table.querySelector('th').dataset.columnKey, 'nguon');
  assert.equal(table.querySelector('th').style.width, '120px');
  assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[0]), ['YIWU', 'CONT TKS1', source]);
  assert.equal(bodyRows(page)[2].cells[0].querySelector('img'), null);
  assert.equal(bodyRows(page)[2].getAttribute('data-table-item-id'), source + ':5');
  const sort = table.querySelector('th .sort-button');
  sort.click();
  assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[0]), ['CONT TKS1', source, 'YIWU']);
  sort.click();
  assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[0]), ['YIWU', source, 'CONT TKS1']);
});

test('loading, empty, filtered empty, and error rows span all 14 columns', async () => {
  const loading = createPage();
  assert.equal(loading.$('expectedArrivalsRows').querySelector('td').colSpan, 14);
  loading.run('renderExpectedArrivals()');
  assert.equal(loading.$('expectedArrivalsRows').querySelector('td').colSpan, 14);
  const empty = createPage({ respond: { ...SAMPLE, rows: [] } });
  empty.run("switchView('products')");
  const error = createPage({ respond: new Error('fixture error') });
  error.run("switchView('products')");
  await settle();
  assert.equal(empty.$('expectedArrivalsRows').querySelector('td').colSpan, 14);
  assert.equal(error.$('expectedArrivalsRows').querySelector('td').colSpan, 14);
  loading.run("switchView('products')");
  await settle();
  setSelect(loading, 'expectedArrivalsContainer', 'CONT 11-2A');
  setSelect(loading, 'expectedArrivalsStatus', '2. Đã bốc');
  assert.equal(loading.$('expectedArrivalsRows').querySelector('td').colSpan, 14);
});

test('search keeps normal text and code modes without adding sheet-name matches', async () => {
  const page = createPage();
  page.run("switchView('products')");
  await settle();
  for (const mode of ['normal', 'codes']) {
    page.run(`Object.assign(getTableSearchState('expectedArrivals'), {mode: '${mode}', query: 'YIWU'}); renderExpectedArrivals()`);
    assert.equal(bodyRows(page).length, 0);
    assert.equal(page.$('expectedArrivalsRows').querySelector('td').colSpan, 14);
    const query = mode === 'normal' ? 'quạt' : 'MCRY301 QAT001';
    page.run(`Object.assign(getTableSearchState('expectedArrivals'), {mode: '${mode}', query: '${query}'}); renderExpectedArrivals()`);
    assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[3]), mode === 'normal' ? ['QAT001'] : ['MCRY301', 'QAT001']);
  }
});

test('pagination retains source cells across 100-row pages', async () => {
  const rows = Array.from({ length: 101 }, (_, i) => row({ sheetName: i < 100 ? 'YIWU' : 'CONT TKS1', sourceRow: i + 1 }));
  const page = createPage({ respond: { ...FULL_SAMPLE, rows } });
  page.run("switchView('products')");
  await settle();
  assert.equal(bodyRows(page).length, 100);
  page.$('expectedArrivalsNextPage').click();
  assert.equal(bodyRows(page).length, 1);
  assert.equal(bodyRows(page)[0].cells.length, 14);
  assert.equal(cellTexts(bodyRows(page)[0])[0], 'CONT TKS1');
});

test('real table controls preserve old keyed column choices and show Nguồn by default', async () => {
  const page = createPage({ respond: FULL_SAMPLE });
  page.run("switchView('products')");
  await settle();
  const table = page.$('expectedArrivalsRows').closest('table');
  // Seed a previous ten-column view in this document's real session Map.
  const old = page.doc.createElement('table');
  old.dataset.tableKey = table.dataset.tableKey;
  old.innerHTML = table.innerHTML;
  old.querySelector('[data-column-key="nguon"]')?.remove();
  [...old.tBodies[0].rows].forEach(tr => { if (tr.cells.length === 14) tr.cells[0].remove(); });
  const wrap = page.doc.createElement('div');
  wrap.className = 'table-wrap';
  wrap.append(old);
  page.doc.body.append(wrap);
  const tableHost = table.parentElement;
  table.remove();
  page.dom.window.eval(fs.readFileSync(path.join(publicDir, 'shared', 'table-controls.js'), 'utf8'));
  const api = page.dom.window.TKSTables;
  const buttons = new Map([old].map(target => {
    const button = page.doc.createElement('button');
    page.doc.body.append(button);
    api.enhance(target, { button });
    return [target, button];
  }));
  const hide = (target, key) => {
    buttons.get(target).click();
    const picker = page.doc.querySelector('.tks-columns-picker');
    const input = picker.querySelector(`[data-column-key="${key}"]`);
    input.checked = !input.checked;
    input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    picker.querySelector('[data-action="close"]').click();
  };
  hide(old, 'ten-sp');
  old.querySelector('[data-column-key="ma-sp"] .tks-column-resizer')
    .dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  tableHost.append(table);
  const button = page.doc.createElement('button');
  page.doc.body.append(button);
  buttons.set(table, button);
  api.enhance(table, { button });
  const columns = api.getState(table).columns;
  assert.equal(columns.length, 14);
  assert.equal(columns[0].key, 'nguon');
  assert.equal(columns[0].hidden, false);
  assert.equal(columns[0].width, 120);
  assert.equal(columns.find(c => c.key === 'ma-sp').width, 130);
  assert.equal(columns.find(c => c.key === 'ten-sp').hidden, true);
  assert.equal(bodyRows(page)[0].cells[4].classList.contains('tks-column-hidden'), true);
  hide(table, 'nguon');
  assert.equal(bodyRows(page)[0].cells[0].classList.contains('tks-column-hidden'), true);
  hide(table, 'nguon');
  setSelect(page, 'expectedArrivalsContainer', 'CONT 10-5H');
  api.refresh(table);
  assert.equal(api.getState(table).columns.find(c => c.key === 'ten-sp').hidden, true);
  assert.equal(api.getState(table).columns[0].hidden, false);
});


test('source dropdown precedes Cont and always offers all seven sources, including empty snapshots', async () => {
  const page = createPage({ respond: { ...FULL_SAMPLE, rows: [] } });
  const source = page.$('expectedArrivalsSource');
  assert.ok(source, 'source dropdown required');
  assert.equal(source.getAttribute('aria-label'), 'Lọc theo nguồn');
  assert.equal(source.className, page.$('expectedArrivalsContainer').className);
  assert.equal(source.nextElementSibling.id, 'expectedArrivalsContainer');
  const names = ['', 'YIWU', 'VK-DUNG', 'HÀ BẮC', 'SD', 'GDONG', 'KHÁC', 'CONT TKS1'];
  assert.deepEqual([...source.options].map(o => o.value), names);
  assert.deepEqual([...source.options].map(o => o.textContent), ['Tất cả nguồn', ...names.slice(1)]);
  assert.equal(source.value, '');
  page.run("switchView('products')");
  await settle();
  setSelect(page, 'expectedArrivalsSource', 'KHÁC');
  assert.deepEqual([...source.options].map(o => o.value), names);
  assert.equal(source.value, 'KHÁC');
  assert.equal(bodyRows(page).length, 0);
  assert.equal(page.$('expectedArrivalsRows').querySelector('td').colSpan, 14);
  assert.deepEqual(cardsOf(page, 'expectedArrivalsKpis'), [['Số cont', '0'], ['Số dòng hàng', '0'], ['Tổng số lượng', '0']]);
});

test('source uses exact sheetName and intersects Cont, status, and both search modes', async () => {
  const rows = [...FULL_SAMPLE.rows, row({ sheetName: 'CONT TKS1 extra', quantity: 9999 })];
  const page = createPage({ respond: { ...FULL_SAMPLE, rows } });
  page.run("switchView('products')");
  await settle();
  assert.ok(page.$('expectedArrivalsSource'));
  setSelect(page, 'expectedArrivalsSource', 'CONT TKS1');
  assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[3]), ['MCRY302']);
  assert.equal(page.$('tagExpectedArrivals').textContent, '1');
  assert.deepEqual(cardsOf(page, 'expectedArrivalsKpis'), [['Số cont', '1'], ['Số dòng hàng', '1'], ['Tổng số lượng', '60']]);
  setSelect(page, 'expectedArrivalsContainer', 'CONT 10-5H');
  setSelect(page, 'expectedArrivalsStatus', '1. Chưa bốc');
  assert.equal(bodyRows(page).length, 0);
  setSelect(page, 'expectedArrivalsStatus', '2. Đã bốc');
  for (const mode of ['normal', 'codes']) {
    const missing = mode === 'normal' ? 'quạt' : 'QAT001';
    page.run(`Object.assign(getTableSearchState('expectedArrivals'), {mode: '${mode}', query: '${missing}'}); renderExpectedArrivals()`);
    assert.equal(bodyRows(page).length, 0);
    const query = mode === 'normal' ? 'máy cạo' : 'MCRY301 MCRY302';
    page.run(`Object.assign(getTableSearchState('expectedArrivals'), {mode: '${mode}', query: '${query}'}); renderExpectedArrivals()`);
    assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[3]), ['MCRY302']);
    assert.equal(page.$('expectedArrivalsSource').value, 'CONT TKS1');
  }
  setSelect(page, 'expectedArrivalsSource', 'YIWU');
  assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[3]), ['MCRY301']);
  assert.equal(page.$('expectedArrivalsContainer').value, 'CONT 10-5H');
  assert.equal(page.$('expectedArrivalsStatus').value, '2. Đã bốc');
  assert.equal(page.run("getTableSearchState('expectedArrivals').query"), 'MCRY301 MCRY302');
  setSelect(page, 'expectedArrivalsSource', 'CONT TKS1');
  setSelect(page, 'expectedArrivalsContainer', 'CONT 11-2A');
  assert.equal(bodyRows(page).length, 0);
  assert.equal(page.$('tagExpectedArrivals').textContent, '0');
  assert.equal(page.$('expectedArrivalsSource').value, 'CONT TKS1');
});

test('source change resets pagination to page one and remains selected on rerender', async () => {
  const rows = Array.from({ length: 202 }, (_, i) => row({ sheetName: i < 101 ? 'YIWU' : 'CONT TKS1', sourceRow: i + 1 }));
  const page = createPage({ respond: { ...FULL_SAMPLE, rows } });
  page.run("switchView('products')");
  await settle();
  assert.ok(page.$('expectedArrivalsSource'));
  page.$('expectedArrivalsNextPage').click();
  assert.match(page.$('expectedArrivalsPageLabel').textContent, /^Trang 2\//);
  setSelect(page, 'expectedArrivalsSource', 'CONT TKS1');
  assert.match(page.$('expectedArrivalsPageLabel').textContent, /^Trang 1\//);
  assert.equal(bodyRows(page).length, 100);
  assert.ok(bodyRows(page).every(tr => cellTexts(tr)[0] === 'CONT TKS1'));
  assert.equal(page.$('tagExpectedArrivals').textContent, '101');
  page.$('expectedArrivalsNextPage').click();
  assert.equal(bodyRows(page).length, 1);
  page.run('renderExpectedArrivals()');
  assert.equal(page.$('expectedArrivalsSource').value, 'CONT TKS1');
  assert.match(page.$('expectedArrivalsPageLabel').textContent, /^Trang 2\//);
  setSelect(page, 'expectedArrivalsSource', '');
  assert.match(page.$('expectedArrivalsPageLabel').textContent, /^Trang 1\//);
  assert.equal(page.$('tagExpectedArrivals').textContent, '202');
});

test('export fields and both file formats keep source alongside other active filters and search', async () => {
  const page = createPage({ respond: FULL_SAMPLE });
  page.run("switchView('products')");
  await settle();
  assert.equal(paramsOf('/?' + page.run('expectedArrivalsExportQuery()')).has('source'), false);
  assert.ok(page.$('expectedArrivalsSource'));
  setSelect(page, 'expectedArrivalsSource', 'CONT TKS1');
  setSelect(page, 'expectedArrivalsContainer', 'CONT 10-5H');
  setSelect(page, 'expectedArrivalsStatus', '2. Đã bốc');
  page.run("Object.assign(getTableSearchState('expectedArrivals'), {mode: 'normal', query: 'Máy cạo'}); renderExpectedArrivals()");
  for (const action of ['exportConfirmButton', 'exportHtmlButton']) {
    page.run('openExpectedArrivalsExportDialog()');
    await settle();
    page.run(page.$(action).getAttribute('onclick'));
    await settle();
  }
  const exportUrls = page.urls.filter(u => u.startsWith('/api/expected-arrivals/export'));
  assert.equal(exportUrls.length, 4);
  for (const url of exportUrls) {
    const params = paramsOf(url);
    assert.equal(params.get('source'), 'CONT TKS1');
    assert.equal(params.get('container'), 'CONT 10-5H');
    assert.equal(params.get('status'), '2. Đã bốc');
    assert.equal(params.get('q'), 'Máy cạo');
  }
  assert.deepEqual(exportUrls.filter(u => u.includes('/export?')).map(u => paramsOf(u).get('format')), ['xlsx', 'html']);
});

// ---- Cot gia theo quyen (fullAccess cua may chu) + hop "Chi tiet hang du kien" ----
const headOf = (page, key) => page.$('expectedArrivalsRows').closest('table').querySelector('thead th[data-column-key="' + key + '"]');
const withTableControls = (options) => {
  const page = createPage(options);
  page.dom.window.eval(fs.readFileSync(path.join(publicDir, 'shared', 'table-controls.js'), 'utf8'));
  page.dom.window.TKSTables.refreshAll();
  return page;
};
const stateOf = page => {
  const state = page.dom.window.TKSTables.getState(page.$('expectedArrivalsRows').closest('table'));
  return { key: state.key, hidden: Array.from(state.columns).filter(c => c.hidden).map(c => c.key) };
};

test('khong co fullAccess: hai cot gia bi an + khong liet ke, Mau sac / Ghi chu sale khong an mac dinh, o gia hien "—"', async () => {
  const page = createPage();
  // Truoc khi tai du lieu da an san (khong lo cot gia ra giay lat).
  ['gia-te', 'gia-vn'].forEach(key => {
    assert.equal(headOf(page, key).hidden, true, key);
    assert.equal(headOf(page, key).dataset.columnUnlisted, 'true', key);
  });
  page.run("switchView('products')");
  await settle();
  ['gia-te', 'gia-vn'].forEach(key => {
    assert.equal(headOf(page, key).hidden, true, key);
    assert.equal(headOf(page, key).dataset.columnUnlisted, 'true', key);
  });
  ['mau-sac', 'ghi-chu-sale'].forEach(key => assert.equal(headOf(page, key).hasAttribute('data-column-default-hidden'), false, key));
  bodyRows(page).forEach(tr => assert.deepEqual(['gia-te', 'gia-vn'].map(key => cellOf(tr, key).textContent), ['—', '—']));
});

test('khong co fullAccess: cot Nguon + o loc Nguon bi an, khong liet ke, khong vao bo loc / xuat file; o Nguon rong', async () => {
  const anonymous = { ...SAMPLE, rows: SAMPLE.rows.map((r, i) => ({ ...r, sheetName: '#' + (i + 1) })) };
  const page = withTableControls({ respond: anonymous });
  // Truoc khi tai da an san.
  assert.equal(headOf(page, 'nguon').hidden, true);
  assert.equal(headOf(page, 'nguon').dataset.columnUnlisted, 'true');
  assert.equal(page.$('expectedArrivalsSource').hidden, true);
  page.run("switchView('products')");
  await settle();
  assert.equal(headOf(page, 'nguon').hidden, true);
  assert.equal(headOf(page, 'nguon').dataset.columnUnlisted, 'true');
  assert.equal(page.$('expectedArrivalsSource').hidden, true);
  assert.equal(bodyRows(page).length, 4);
  bodyRows(page).forEach(tr => {
    assert.equal(tr.cells.length, 14);
    assert.equal(tr.cells[0].textContent, '');
    assert.equal(tr.cells[0].classList.contains('tks-column-hidden'), true);
    assert.equal(tr.textContent.includes('#'), false, 'khong lo token an danh');
  });
  // Khong co trong hop "Cot hien thi".
  page.$('expectedArrivalsRows').closest('.panel').querySelector('.tks-columns-button').click();
  assert.equal(page.doc.querySelector('.tks-columns-picker input[data-column-key="nguon"]'), null);
  assert.ok(page.doc.querySelector('.tks-columns-picker input[data-column-key="ma-sp"]'));
  // Ep gia tri vao o loc: van khong loc theo nguon, khong gui ?source=.
  const select = page.$('expectedArrivalsSource');
  select.insertAdjacentHTML('beforeend', '<option value="#1">#1</option>');
  setSelect(page, 'expectedArrivalsSource', '#1');
  assert.equal(bodyRows(page).length, 4, 'khong loc theo nguon');
  assert.equal(paramsOf('/?' + page.run('expectedArrivalsExportQuery()')).has('source'), false);
  page.run('openExpectedArrivalsExportDialog()');
  await settle();
  page.run(page.$('exportConfirmButton').getAttribute('onclick'));
  await settle();
  const exportUrls = page.urls.filter(u => u.startsWith('/api/expected-arrivals/export'));
  assert.ok(exportUrls.length >= 2);
  exportUrls.forEach(url => assert.equal(paramsOf(url).has('source'), false, url));
  // Tim kiem khong khop ten sheet.
  page.run("Object.assign(getTableSearchState('expectedArrivals'), {mode: 'normal', query: '#1'}); renderExpectedArrivals()");
  assert.equal(bodyRows(page).length, 0);
});

test('co fullAccess: cot Nguon hien + liet ke, khong an mac dinh, o loc Nguon hien va loc dung; mat quyen thi o loc bi an va xoa lua chon', async () => {
  const page = withTableControls({ respond: FULL_SAMPLE });
  page.run("switchView('products')");
  await settle();
  assert.equal(headOf(page, 'nguon').hidden, false);
  assert.equal(headOf(page, 'nguon').hasAttribute('data-column-unlisted'), false);
  assert.equal(headOf(page, 'nguon').hasAttribute('data-column-default-hidden'), false);
  assert.equal(page.$('expectedArrivalsSource').hidden, false);
  assert.equal(stateOf(page).hidden.includes('nguon'), false);
  assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[0]), ['YIWU', 'CONT TKS1', 'YIWU', 'YIWU']);
  page.$('expectedArrivalsRows').closest('.panel').querySelector('.tks-columns-button').click();
  assert.ok(page.doc.querySelector('.tks-columns-picker input[data-column-key="nguon"]'));
  setSelect(page, 'expectedArrivalsSource', 'CONT TKS1');
  assert.deepEqual(bodyRows(page).map(tr => cellTexts(tr)[3]), ['MCRY302']);
  assert.equal(paramsOf('/?' + page.run('expectedArrivalsExportQuery()')).get('source'), 'CONT TKS1');
  // Mat quyen (tai lai voi fullAccess=false): o loc bi an va xoa lua chon.
  page.dom.window.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => SAMPLE });
  page.run('loadExpectedArrivals()');
  await settle();
  assert.equal(page.$('expectedArrivalsSource').hidden, true);
  assert.equal(page.$('expectedArrivalsSource').value, '');
  assert.equal(bodyRows(page).length, 4);
  assert.equal(paramsOf('/?' + page.run('expectedArrivalsExportQuery()')).has('source'), false);
});

test('co fullAccess: hien 2 cot gia (te 2 so le, VN lam tron, trong = "—"), Mau sac / Ghi chu sale an mac dinh', async () => {
  const page = createPage({ respond: FULL_SAMPLE });
  page.run("switchView('products')");
  await settle();
  ['gia-te', 'gia-vn'].forEach(key => {
    assert.equal(headOf(page, key).hidden, false, key);
    assert.equal(headOf(page, key).hasAttribute('data-column-unlisted'), false, key);
  });
  assert.equal(headOf(page, 'ghi-chu-khac').hidden, true, 'fullAccess does not grant other-note access');
  assert.equal(headOf(page, 'ghi-chu-khac').dataset.columnUnlisted, 'true');
  ['mau-sac', 'ghi-chu-sale'].forEach(key => assert.equal(headOf(page, key).dataset.columnDefaultHidden, 'true', key));
  ['nguon', 'ten-sp', 'nguoi-dat', 'tong-so-luong'].forEach(key => assert.equal(headOf(page, key).hasAttribute('data-column-default-hidden'), false, key));
  const rows = bodyRows(page);
  const quantityAndPrices = tr => ['tong-so-luong', 'gia-te', 'gia-vn'].map(key => cellOf(tr, key).textContent);
  assert.deepEqual(quantityAndPrices(rows[0]), ['240', '1.44', '26,420']);
  assert.deepEqual(quantityAndPrices(rows[1]), ['60', '2.44', '27,420']);
  assert.deepEqual(quantityAndPrices(rows[2]), ['1,000', '—', '—'], 'gia trong => "—"');
  assert.equal(cellOf(rows[0], 'gia-te').getAttribute('data-sort-value'), '1.44');
  assert.equal(cellOf(rows[2], 'gia-te').hasAttribute('data-sort-value'), false);
  // Sap xep theo Giá hàng về VN: o trong luon cuoi.
  headOf(page, 'gia-vn').querySelector('.sort-button').click();
  assert.deepEqual(bodyRows(page).map(tr => cellOf(tr, 'gia-vn').textContent), ['26,420', '27,420', '29,420', '—']);
});

test('table-controls: co fullAccess doi khoa phien ":full", an san Mau sac + Ghi chu sale, bat lai duoc; khong fullAccess giu khoa goc va khong liet ke cot gia', async () => {
  const full = withTableControls({ respond: FULL_SAMPLE });
  assert.deepEqual(stateOf(full), { key: 'dashboard-table-expected-arrivals', hidden: [] });
  full.run("switchView('products')");
  await settle();
  assert.deepEqual(stateOf(full), { key: 'dashboard-table-expected-arrivals:full', hidden: ['mau-sac', 'ghi-chu-sale'] });
  assert.equal(bodyRows(full)[0].cells[5].classList.contains('tks-column-hidden'), true, 'o Mau sac bi an');
  assert.equal(cellOf(bodyRows(full)[0], 'gia-te').classList.contains('tks-column-hidden'), false, 'o Gia SP (te) hien');
  full.$('expectedArrivalsRows').closest('.panel').querySelector('.tks-columns-button').click();
  ['gia-te', 'gia-vn', 'mau-sac', 'ghi-chu-sale'].forEach(key =>
    assert.ok(full.doc.querySelector('.tks-columns-picker input[data-column-key="' + key + '"]'), key + ' co trong hop Cot hien thi'));
  const box = full.doc.querySelector('.tks-columns-picker input[data-column-key="mau-sac"]');
  box.checked = true; box.dispatchEvent(new full.dom.window.Event('change', { bubbles: true }));
  assert.deepEqual(stateOf(full).hidden, ['ghi-chu-sale']);

  const plain = withTableControls();
  plain.run("switchView('products')");
  await settle();
  assert.deepEqual(stateOf(plain), { key: 'dashboard-table-expected-arrivals', hidden: [] });
  assert.equal(cellOf(bodyRows(plain)[0], 'gia-te').classList.contains('tks-column-hidden'), true);
  plain.$('expectedArrivalsRows').closest('.panel').querySelector('.tks-columns-button').click();
  ['gia-te', 'gia-vn'].forEach(key => assert.equal(plain.doc.querySelector('.tks-columns-picker input[data-column-key="' + key + '"]'), null, key + ' khong duoc liet ke'));
  assert.equal(plain.doc.querySelector('.tks-columns-picker input[data-column-key="ghi-chu-khac"]'), null);
  assert.ok(plain.doc.querySelector('.tks-columns-picker input[data-column-key="mau-sac"]'));
});

// MCRY301 co 3 dong o 2 nguon (ma viet thuong + khoang trang van khop), DEN200 la ma khac.
const DETAIL_ROWS = [
  row({}),
  row({ productCode: ' mcry301 ', containerName: 'CONT 11-2A', scheduleLabel: '1. Chưa bốc 05/11', statusLabel: '1. Chưa bốc', status: 1, eta: '05/11', quantity: 100, sourceRow: 7, color: 'Xanh', saleNote: '<b>x</b>' }),
  row({ sheetName: 'CONT TKS1', containerName: 'CONT 12-1A', quantity: 60, sourceRow: 8 }),
  row({ productCode: 'DEN200', productName: 'Đèn bàn 200', scheduleLabel: '3. Đã về kho', statusLabel: '3. Đã về kho', status: 3, eta: '', containerName: 'CONT 09-1C', quantity: 500, sourceRow: 20 })
];
const DETAIL_SAMPLE = { ...SAMPLE, rows: DETAIL_ROWS };
const DETAIL_FULL = { ...FULL_SAMPLE, rows: DETAIL_ROWS.map((r, i) => ({ ...r, listedAt: '15/10', unitPriceCny: 1.44, vietnamPrice: 26420 + i })) };
const statTiles = page => [...page.$('docModalBody').querySelectorAll('.dp-stat')].map(el => [el.querySelector('.dp-stat-label').textContent, el.querySelector('.dp-stat-value').textContent]);
const rowFor = (page, sheetName, sourceRow) => bodyRows(page).find(tr => tr.dataset.tableItemId === sheetName + ':' + sourceRow);

test('hop chi tiet: dong bang la tr.doc-row bam duoc / Enter, mo hop wide khong goi API, tieu de + khung cap nhat', async () => {
  const page = createPage({ respond: DETAIL_SAMPLE });
  page.run("switchView('products')");
  await settle();
  const first = rowFor(page, 'YIWU', 5);
  assert.ok(first.classList.contains('doc-row'));
  assert.equal(first.getAttribute('tabindex'), '0');
  assert.equal(page.$('docModalBackdrop').hidden, true);
  const calls = page.urls.length;
  first.click();
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.ok(page.doc.querySelector('.doc-modal').classList.contains('is-wide'));
  assert.equal(page.$('docModalTitle').textContent, 'Chi tiết hàng dự kiến · MCRY301 – Máy cạo râu 301');
  assert.equal(page.urls.length, calls, 'hop dung tai cho, khong goi API');
  assert.match(page.$('docModalBody').textContent, /Dữ liệu cập nhật lúc /);
  assert.match(page.$('docModalSubtitle').textContent, /3 dòng hàng · 3 cont/);

  page.run('closeDocumentDetail()');
  assert.equal(page.$('docModalBackdrop').hidden, true);
  assert.equal(page.doc.activeElement, first, 'focus ve dong da bam');
  rowFor(page, 'YIWU', 5).dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(page.$('docModalBackdrop').hidden, false);
});

test('hop chi tiet: bam nut trong dong khong mo hop; bam o chu mo hop', async () => {
  const page = createPage({ respond: DETAIL_SAMPLE });
  page.run("switchView('products')");
  await settle();
  const tr = rowFor(page, 'YIWU', 5);
  const button = page.doc.createElement('button');
  tr.cells[0].append(button);
  button.click();
  assert.equal(page.$('docModalBackdrop').hidden, true);
  tr.cells[3].click();
  assert.equal(page.$('docModalBackdrop').hidden, false);
});

test('hop chi tiet: gom MOI CONT cung ma SP (khong phan biet hoa thuong / khoang trang), the tong so luong theo trang thai 1-5 + tong', async () => {
  const page = createPage({ respond: DETAIL_SAMPLE });
  page.run("switchView('products')");
  await settle();
  rowFor(page, 'YIWU', 5).click();
  assert.deepEqual(statTiles(page), [
    ['1. Chưa bốc', '100'], ['2. Đã bốc', '300'], ['3. Đã về kho', '0'], ['Trạng thái 4', '0']
  ]);
  const table = page.$('docModalBody').querySelector('table.dp-table');
  assert.equal(table.dataset.tableKey, 'dashboard-table-expected-arrival-detail');
  // Riêng bảng này: ô Trạng thái không xuống dòng (cắt "..."), tooltip giữ chữ đầy đủ; các cột có độ rộng mặc định.
  const statusCell = table.querySelector('tbody td.expected-status-cell');
  assert.ok(statusCell && statusCell.title === statusCell.textContent);
  assert.ok([...table.querySelectorAll('thead th')].every(th => /^\d+px$/.test(th.style.width)));
  assert.deepEqual([...table.tBodies[0].rows].map(tr => tr.cells[0].textContent), ['CONT 10-5H', 'CONT 11-2A', 'CONT 12-1A']);
  assert.deepEqual([...table.tHead.rows[0].cells].map(th => th.textContent.replace(/[▲▼]/g, '').trim()),
    ['Tên CONT', 'Trạng thái', 'Ngày về', 'Màu sắc', 'Ghi chú sale', 'Tổng số lượng']);
  assert.equal(table.querySelectorAll('thead th[data-column-default-hidden]').length, 0, 'khong co quyen xem gia: Mau sac / Ghi chu sale khong an');
  // Cot nhay cam khong len bang; ghi chu duoc escape.
  assert.equal(table.textContent.includes('Lan'), false);
  assert.equal(table.querySelector('b'), null);
  assert.ok(table.textContent.includes('<b>x</b>'));
  assert.deepEqual([...table.tBodies[0].rows].map(tr => tr.cells[5].textContent), ['240', '100', '60']);

  // Ma khac (DEN200 - trang thai 3) chi co the trang thai 3.
  page.run('closeDocumentDetail()');
  rowFor(page, 'YIWU', 20).click();
  assert.deepEqual(statTiles(page).map(t => t[1]), ['0', '0', '500', '0']);
  assert.equal(page.$('docModalBody').querySelectorAll('tbody tr').length, 1);
});

test('hop chi tiet: co fullAccess them 6 cot (Nguoi dat ... Gia VN), Mau sac / Ghi chu sale an mac dinh; khong co dong CONT thi bao rong', async () => {
  const page = createPage({ respond: DETAIL_FULL });
  page.run("switchView('products')");
  await settle();
  rowFor(page, 'YIWU', 5).click();
  const table = page.$('docModalBody').querySelector('table.dp-table');
  assert.deepEqual([...table.tHead.rows[0].cells].map(th => th.textContent.replace(/[▲▼]/g, '').trim()),
    ['Tên CONT', 'Trạng thái', 'Ngày về', 'Màu sắc', 'Ghi chú sale', 'Người đặt', 'Ngày lên list', 'Số cái/kiện', 'Số kiện', 'Tổng số lượng', 'Giá SP (tệ)', 'Giá hàng về VN']);
  assert.deepEqual([...table.querySelectorAll('thead th[data-column-default-hidden]')].map(th => th.textContent.replace(/[▲▼]/g, '').trim()), ['Màu sắc', 'Ghi chú sale']);
  assert.deepEqual([...table.tBodies[0].rows[0].cells].slice(5).map(td => td.textContent), ['Lan', '15/10', '24', '10', '240', '1.44', '26,420']);

  // Khong con dong nao cung ma (du lieu doi trong luc mo hop) => thong bao rong, tong 0.
  page.run('closeDocumentDetail()');
  page.run("openDocumentDetail('expectedArrival', { productCode: 'KHONGCO', productName: 'X', sheetName: 'ZZ', sourceRow: 1 }, null)");
  assert.match(page.$('docModalBody').textContent, /Không có hàng dự kiến phù hợp cho mã này/);
  assert.equal(statTiles(page).at(-1)[1], '0');
});

test('hop Chi tiet hang hoa (Bao cao hang hoa) khong con muc Hang du kien: markup/handler cu da go', () => {
  assert.equal(html.includes('productContainerContent'), false);
  assert.equal(html.includes('productContainerSection'), false);
  assert.equal(html.includes('renderProductContainers'), false);
  assert.equal(html.includes('/api/product-report/containers?'), false, 'chi con /containers/meta');
});

test('hop chi tiet: trang thai 4 va 5 cu da gop thanh "4.Da ve": dong con mang so 5 don vao the 4, khong co the thu 5', async () => {
  const merged = { ...SAMPLE, rows: [
    row({ statusLabel: '4.Đã về', status: 4, quantity: 200, sourceRow: 31 }),
    row({ statusLabel: '5.Đã về, Đã khớp tiền', status: 5, quantity: 50, containerName: 'CONT 9-11Y', sourceRow: 32 })
  ] };
  const page = createPage({ respond: merged });
  page.run("switchView('products')");
  await settle();
  rowFor(page, 'YIWU', 31).click();
  const tiles = statTiles(page);
  assert.equal(tiles.length, 4);
  assert.equal(tiles[3][1], '250');
});
