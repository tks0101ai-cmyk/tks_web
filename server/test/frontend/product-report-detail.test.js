'use strict';

// Bang "Bao cao hang hoa" (tab Hang hoa): 35 cot theo thu tu sheet BC CHUNG (= thu tu cot file Excel), KHONG co
// nut "Chi tiet" rieng; so Ti trong khach lon nhat la nut mo hop chi tiet o muc Doanh so theo khach (hang du kien nay xem o hop cua bang Du kien hang ve). Bam vao 1 dong mo hop chi tiet giua man hinh (dung chung voi bang giao dich/dat hang/tra hang)
// gom bang doanh so tung khach 90 ngay (so tien + %) va bieu do tron dat canh ben.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

const PRODUCTS = [
  {
    code: 'SP-1', name: 'Khay giấy bạc', transferRequest: 40, inTransit: 75, stockHanoi: 5, stockSaigon: 3, availableToSell: 8, qtySold30d: 4, revenue90d: 1000, customerCount90d: 3, topCustomerRevenue90d: 600, topCustomerName: 'KH A', topCustomerShare: 0.6,
    availableHanoi: -2, availableSaigon: 5, descriptionHanoi: 'T50 # 30/9 | <b>VAT</b>+3200đ', descriptionSaigon: '', totalStock: 83, daysToOrder: 12.5, priceHanoi: 15000, priceSaigon: 16500,
    // Cột theo sheet BC CHUNG: Có bán HN âm nên Giá trị có bán HN và Ngày HN cũng âm (giữ nguyên dấu).
    qtySold30dHanoi: 3, qtySold30dSaigon: 1, orders30d: 18, orders90d: 60, stockoutDaysHanoi: 5, stockoutDaysSaigon: 0,
    availableValueHanoi: -30000, availableValueSaigon: 82500, daysHanoi: -20, daysSaigonTransit: 24, daysBothBranches: 83, ordersGrowth: 0.25
  },
  // Mọi trường mới thiếu (báo cáo chưa tính lại / API không trả giá): số có thể null hiện "—", Đứt luôn là số (0).
  { code: 'SP-2', name: 'Bình nước nhựa', stockHanoi: 0, stockSaigon: 0, availableToSell: 0, qtySold30d: 0, revenue90d: 0, customerCount90d: 0, topCustomerRevenue90d: 0, topCustomerName: '', topCustomerShare: null }
];

function customersPayload(code, count = 3) {
  const rows = Array.from({ length: count }, (_, i) => ({
    customerName: 'KH ' + String.fromCharCode(65 + i),
    revenue: (count - i) * 100,
    share: null
  }));
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);
  rows.forEach(row => { row.share = row.revenue / total; });
  return { code, totalRevenue: total, customerCount: count, rows };
}

function createPage({ customers = code => customersPayload(code), history, meta, report, reportVersion, can = () => true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/#products' });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  const charts = [];
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; this.destroyed = false; charts.push(this); }
    destroy() { this.destroyed = true; }
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => { if (dom.window.document) callback(); };
  dom.window.HTMLElement.prototype.scrollIntoView = function () {
    dom.window.__scrolled = (dom.window.__scrolled || 0) + 1;
    (dom.window.__scrolledTo = dom.window.__scrolledTo || []).push(this.id);
  };
  dom.window.TKSNav = { authGuard: () => new Promise(() => {}), can, handleBranchError: () => false, renderTopSidebar() {} };

  const urls = [];
  dom.window.fetch = (url) => {
    const href = String(url);
    urls.push(href);
    if (href.startsWith('/api/product-report/history?') && history) {
      const payload = history(new URL(href, 'https://tokosi.example').searchParams);
      return Promise.resolve(payload).then(body => ({ ok: !(body instanceof Error), status: body instanceof Error ? 500 : 200, json: async () => body }));
    }
    if (href === '/api/product-report') {
      return Promise.resolve({ ok: true, status: 200, json: async () => report ? report() : ({ rows: PRODUCTS, computedAt: '2026-09-29T00:15:00.000Z' }) });
    }
    if (href === '/api/product-report/containers/meta' && meta) return Promise.resolve({ ok: true, json: async () => ({ containerSync: meta(), reportVersion: reportVersion ? reportVersion() : null }) });
    if (href.startsWith('/api/product-report/customers?code=')) {
      const code = decodeURIComponent(href.split('code=')[1]);
      const payload = customers(code);
      if (payload instanceof Error) return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'loi' }) });
      return Promise.resolve({ ok: true, status: 200, json: async () => payload });
    }
    return new Promise(() => {});
  };

  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  if (history) dom.window.eval(fs.readFileSync(path.join(publicDir, 'js/product-history.js'), 'utf8'));
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(script => script.trim());
  const mainIndex = scripts.reduce((best, script, index) => (script.length > scripts[best].length ? index : best), 0);
  scripts.forEach((script, index) => dom.window.eval(script + (index === mainIndex ? '\nwindow.__reportTestState = state; window.__reportTestInternals = { docDetail, hiddenByProfile: PRODUCT_REPORT_HIDDEN_BY_PROFILE, widthsByProfile: PRODUCT_REPORT_WIDTHS_BY_PROFILE };' : '')));

  const doc = dom.window.document;
  return { dom, doc, charts, urls, run: code => dom.window.eval(code), $: id => doc.getElementById(id) };
}

const pieCharts = page => page.charts.filter(chart => chart.config.type === 'doughnut' && !chart.destroyed);
const rowOf = (page, code) => [...page.$('productReportRows').querySelectorAll('tr.doc-row')].find(tr => tr.dataset.tableItemId === code);
const modalText = page => page.$('docModalBody').textContent.replace(/\s+/g, ' ');

// 35 cột theo thứ tự sheet BC CHUNG: [data-column-key, nhãn trên tiêu đề]. Thứ tự này = thứ tự file Excel (PRODUCT_REPORT_COLUMNS ở exportService.js).
const COLUMNS = [
  ['ma-sp', 'Mã sản phẩm'], ['ten-sp', 'Tên sản phẩm'], ['chua-boc', 'Chưa bốc'], ['da-boc', 'Đã bốc'], ['gia-tri-co-ban-hn', 'Giá trị có bán HN'], ['sl-ban-30-ngay-hn', 'SL bán 30 ngày HN'],
  ['ton-thuc-hn', 'Tồn thực HN'], ['co-ban-hn', 'Có bán HN'], ['yc-dieu-chuyen', 'YC điều chuyển'], ['dieu-chuyen-sg', 'Điều chuyển SG'], ['ton-thuc-sg', 'Tồn thực SG'],
  ['co-ban-sg', 'Có bán SG'], ['sl-ban-30-ngay-sg', 'SL bán 30 ngày SG'], ['gia-tri-co-ban-sg', 'Giá trị có bán SG'],
  ['tong-ton-thuc', 'Tổng tồn thực + ĐC'], ['tong-co-ban', 'Tổng có bán + ĐC'], ['sl-ban-30-ngay', 'SL bán 30 ngày'],
  ['dut-hn', 'Đứt HN'], ['dut-sg', 'Đứt SG'], ['ngay-can-dat', 'Ngày cần đặt'],
  ['ngay-sg-dc', 'Ngày SG + ĐC'], ['ngay-hn', 'Ngày HN'], ['ngay-2-mien', 'Ngày 2 miền'], ['ds-90-ngay', 'DS 90 ngày'], ['sl-khach-ban', 'SL khách bán'],
  ['sl-don-90-ngay', 'SL đơn 90 ngày'], ['sl-don-30-ngay', 'SL đơn 30 ngày'], ['tang-truong', 'Tăng trưởng'], ['ds-khach-lon-nhat', 'DS khách lớn nhất'],
  ['khach-lon-nhat', 'Khách lớn nhất'], ['ti-trong-khach-lon-nhat', 'Tỉ trọng khách lớn nhất'], ['don-gia-hn', 'Đơn giá HN'], ['don-gia-sg', 'Đơn giá SG'],
  ['mo-ta-hn', 'Mô tả HN'], ['mo-ta-sg', 'Mô tả SG']
];
const KEYS = COLUMNS.map(column => column[0]);
const HEADERS = COLUMNS.map(column => column[1]);
// Chỉ số cột theo khóa (bớt giòn khi thêm/đổi thứ tự cột) và ô của một dòng theo khóa.
const idx = key => { const index = KEYS.indexOf(key); assert.ok(index >= 0, 'khong co cot ' + key); return index; };
const cellOf = (row, key) => row.cells[idx(key)];
const SENSITIVE_KEYS = ['gia-tri-co-ban-hn', 'gia-tri-co-ban-sg', 'don-gia-hn', 'don-gia-sg'];
// Cột bổ sung theo BC CHUNG + DS khách lớn nhất: ẩn mặc định ở CẢ HAI khung.
const NEW_KEYS = ['gia-tri-co-ban-hn', 'sl-ban-30-ngay-hn', 'sl-ban-30-ngay-sg', 'gia-tri-co-ban-sg', 'dut-hn', 'dut-sg', 'ngay-sg-dc', 'ngay-hn', 'ngay-2-mien',
  'sl-don-90-ngay', 'sl-don-30-ngay', 'tang-truong', 'ds-khach-lon-nhat'];
// Bộ cột ĐANG HIỆN mặc định (không đổi so với bảng 21 cột trước đó).
const inColumnOrder = list => KEYS.filter(key => list.includes(key));
const SALE_VISIBLE = inColumnOrder(['ma-sp', 'ten-sp', 'da-boc', 'chua-boc', 'ton-thuc-hn', 'co-ban-hn', 'yc-dieu-chuyen', 'dieu-chuyen-sg', 'ton-thuc-sg', 'co-ban-sg', 'mo-ta-hn', 'mo-ta-sg', 'ds-90-ngay']);
const MANAGER_VISIBLE = inColumnOrder(['ma-sp', 'ten-sp', 'don-gia-hn', 'don-gia-sg', 'da-boc', 'chua-boc', 'tong-ton-thuc', 'tong-co-ban', 'sl-ban-30-ngay', 'ngay-can-dat',
  'ds-90-ngay', 'sl-khach-ban', 'ti-trong-khach-lon-nhat']);
const hiddenOf = visible => KEYS.filter(key => !visible.includes(key));
const reportTable = page => page.$('productReportRows').closest('table');
const columnKeys = page => [...reportTable(page).querySelectorAll('thead th')].map(th => th.dataset.columnKey);
const scrolledSections = page => (page.dom.window.__scrolledTo || []).filter(id => id === 'productContainerSection' || id === 'productCustomerSection');
const READY = { available: true, version: 'v1', lastSuccessAt: '2026-10-15T02:00:00Z' };

test('bang Bao cao hang hoa co 35 cot theo thu tu sheet BC CHUNG, moi dong du 35 o dung vi tri, dong bam duoc', async () => {
  const page = createPage();
  await settle();

  const headers = [...reportTable(page).querySelectorAll('thead th')].map(th => th.textContent.replace(/[↕▲▼]/g, '').trim());
  assert.deepEqual(headers, HEADERS);
  assert.equal(HEADERS.length, 35);
  assert.deepEqual(columnKeys(page), KEYS);
  assert.equal(new Set(columnKeys(page)).size, 35, 'data-column-key duy nhat cho tung cot');

  const firstRow = page.$('productReportRows').querySelector('tr');
  assert.equal(firstRow.cells.length, 35);
  const text = key => cellOf(firstRow, key).textContent;
  assert.equal(text('ma-sp'), 'SP-1');
  assert.equal(text('gia-tri-co-ban-hn'), '-30,000');  // Giá trị có bán HN (tiền, giữ dấu âm)
  assert.equal(text('sl-ban-30-ngay-hn'), '3');
  assert.equal(text('ton-thuc-hn'), '5');
  assert.equal(text('co-ban-hn'), '-2');     // Có bán HN (âm giữ nguyên dấu)
  assert.equal(text('yc-dieu-chuyen'), '40');
  assert.equal(text('dieu-chuyen-sg'), '75');
  assert.equal(text('ton-thuc-sg'), '3');
  assert.equal(text('co-ban-sg'), '5');
  assert.equal(text('sl-ban-30-ngay-sg'), '1');
  assert.equal(text('gia-tri-co-ban-sg'), '82,500');
  assert.equal(text('tong-ton-thuc'), '83');
  assert.equal(text('tong-co-ban'), '8');
  assert.equal(text('sl-ban-30-ngay'), '4');
  assert.equal(text('dut-hn'), '5');
  assert.equal(text('dut-sg'), '0', 'Đứt = 0 van hien so 0, khong doi thanh —');
  assert.equal(text('da-boc'), '—', 'chua co snapshot CONT => —');
  assert.equal(text('chua-boc'), '—');
  assert.equal(text('ngay-can-dat'), '12.5');  // 1 chữ số thập phân
  assert.equal(text('ngay-sg-dc'), '24');
  assert.equal(text('ngay-hn'), '-20', 'Ngày HN âm khi Có bán HN âm');
  assert.equal(text('ngay-2-mien'), '83');
  assert.equal(text('ds-90-ngay'), '1,000');
  assert.equal(text('sl-khach-ban'), '3');
  assert.equal(text('sl-don-90-ngay'), '60');
  assert.equal(text('sl-don-30-ngay'), '18');
  assert.equal(text('tang-truong'), '+25%');
  assert.equal(text('ds-khach-lon-nhat'), '600');
  assert.match(text('khach-lon-nhat'), /KH A/);
  assert.match(text('ti-trong-khach-lon-nhat'), /60/);
  assert.equal(text('don-gia-hn'), '15,000');
  assert.equal(text('don-gia-sg'), '16,500');
  assert.match(text('mo-ta-hn'), /T50/);
  assert.equal(firstRow.getAttribute('tabindex'), '0');
  assert.match(firstRow.title, /doanh số theo khách/);
  assert.doesNotMatch(firstRow.title, /hàng dự kiến/, 'hang du kien nay xem o hop cua bang Du kien hang ve');
  [...page.$('productReportRows').querySelectorAll('tr.doc-row')].forEach(row => assert.equal(row.cells.length, 35));
  assert.match(page.$('productReportRows').innerHTML, /^\s*<tr/);
});

test('Tang truong hien % co dau (+25% / -40% / 0% / -100%), data-sort-value la phan so, null hien "—" va khong co moc sort', async () => {
  const rows = [0.25, -0.4, 0, -1, null].map((ordersGrowth, i) => ({ ...PRODUCTS[0], code: 'G-' + i, ordersGrowth }));
  const page = createPage({ report: () => ({ rows, containerSync: READY }) });
  await settle();
  const texts = rows.map(row => cellOf(rowOf(page, row.code), 'tang-truong').textContent);
  assert.deepEqual(texts, ['+25%', '-40%', '0%', '-100%', '—']);
  assert.deepEqual(rows.map(row => cellOf(rowOf(page, row.code), 'tang-truong').getAttribute('data-sort-value')), ['0.25', '-0.4', '0', '-1', null]);
  // Sắp xếp theo Tăng trưởng: số âm thật (-100%) xếp trước số dương, ô trống luôn ở cuối cả hai chiều.
  page.run("setTableSort('productReportRows', " + idx('tang-truong') + ")");
  assert.deepEqual([...page.$('productReportRows').querySelectorAll('tr.doc-row')].map(tr => tr.dataset.tableItemId), ['G-3', 'G-1', 'G-2', 'G-0', 'G-4']);
  page.run("setTableSort('productReportRows', " + idx('tang-truong') + ")");
  assert.deepEqual([...page.$('productReportRows').querySelectorAll('tr.doc-row')].map(tr => tr.dataset.tableItemId), ['G-0', 'G-2', 'G-1', 'G-3', 'G-4']);
});

test('o chua co so (Gia tri co ban, SL 30 ngay theo co so, Co ban, Tong ton, Ngay, SL don, Tang truong, Don gia, Mo ta) hien "—", KHONG gia thanh 0 va KHONG dung moc sort -1 (so am hop le); Dut luon la so', async () => {
  const page = createPage();
  await settle();
  const sp2 = rowOf(page, 'SP-2');
  // Ô số có thể âm/null: "—" và KHÔNG có data-sort-value (-1 sẽ xếp lẫn với số âm thật).
  const nullable = ['gia-tri-co-ban-hn', 'sl-ban-30-ngay-hn', 'co-ban-hn', 'co-ban-sg', 'sl-ban-30-ngay-sg', 'gia-tri-co-ban-sg', 'tong-ton-thuc', 'ngay-can-dat',
    'ngay-sg-dc', 'ngay-hn', 'ngay-2-mien', 'sl-don-90-ngay', 'sl-don-30-ngay', 'tang-truong', 'don-gia-hn', 'don-gia-sg'];
  nullable.forEach(key => {
    assert.equal(cellOf(sp2, key).textContent.trim(), '—', key);
    assert.equal(cellOf(sp2, key).hasAttribute('data-sort-value'), false, key);
  });
  ['mo-ta-hn', 'mo-ta-sg'].forEach(key => assert.equal(cellOf(sp2, key).textContent.trim(), '—', key));
  // Đứt HN/SG luôn là số (API mặc định 0) và DS khách lớn nhất = 0 là số thật.
  ['dut-hn', 'dut-sg', 'ds-khach-lon-nhat'].forEach(key => assert.equal(cellOf(sp2, key).textContent.trim(), '0', key));
  const sp1 = rowOf(page, 'SP-1');
  assert.equal(cellOf(sp1, 'co-ban-hn').getAttribute('data-sort-value'), '-2');
  assert.equal(cellOf(sp1, 'gia-tri-co-ban-hn').getAttribute('data-sort-value'), '-30000');
  assert.equal(cellOf(sp1, 'ngay-hn').getAttribute('data-sort-value'), '-20');
  assert.equal(cellOf(sp1, 'ngay-can-dat').getAttribute('data-sort-value'), '12.5');
  // Sap xep theo "Co ban HN": so am dung truoc so duong, o trong luon cuoi o ca hai chieu.
  page.run("setTableSort('productReportRows', " + idx('co-ban-hn') + ")");
  assert.deepEqual([...page.$('productReportRows').querySelectorAll('tr.doc-row')].map(tr => tr.dataset.tableItemId), ['SP-1', 'SP-2']);
  page.run("setTableSort('productReportRows', " + idx('co-ban-hn') + ")");
  assert.deepEqual([...page.$('productReportRows').querySelectorAll('tr.doc-row')].map(tr => tr.dataset.tableItemId), ['SP-1', 'SP-2'], 'o trong van o cuoi khi sap giam dan');
});

test('Mo ta HN/SG hien nguyen van, an toan HTML, rong thi "—"; tim kiem tim duoc theo noi dung mo ta', async () => {
  const page = createPage();
  await settle();
  const sp1 = rowOf(page, 'SP-1');
  assert.equal(cellOf(sp1, 'mo-ta-hn').textContent, 'T50 # 30/9 | <b>VAT</b>+3200đ');
  assert.equal(cellOf(sp1, 'mo-ta-hn').querySelector('b'), null, 'mo ta khong duoc chen HTML');
  assert.equal(cellOf(sp1, 'mo-ta-sg').textContent.trim(), '—');
  page.run("getTableSearchState('productReport').query = 'T50'; renderProductReport();");
  assert.deepEqual([...page.$('productReportRows').querySelectorAll('tr.doc-row')].map(tr => tr.dataset.tableItemId), ['SP-1']);
});

test('Ti trong khach lon nhat la nut chi khi co so > 0; Chua boc / Da boc la chu thuong (hang du kien xem o hop bang Du kien hang ve); 0 va null chi la chu', async () => {
  const page = createPage({ report: () => ({ rows: [
    { ...PRODUCTS[0], unloadedQty: 150, loadedQty: 0 },
    { ...PRODUCTS[1], unloadedQty: null, loadedQty: null }
  ], containerSync: READY }) });
  await settle();
  const sp1 = rowOf(page, 'SP-1'); const sp2 = rowOf(page, 'SP-2');
  const link = (row, key) => cellOf(row, key).querySelector('button.cell-link');
  assert.equal(link(sp1, 'chua-boc'), null);
  assert.equal(cellOf(sp1, 'chua-boc').textContent, '150');
  assert.equal(cellOf(sp1, 'chua-boc').getAttribute('data-sort-value'), '150');
  assert.equal(link(sp1, 'da-boc'), null);
  assert.equal(cellOf(sp1, 'da-boc').textContent, '0');
  assert.equal(link(sp1, 'ti-trong-khach-lon-nhat').dataset.detailFocus, 'customers');
  assert.match(link(sp1, 'ti-trong-khach-lon-nhat').textContent, /60/);
  assert.equal(cellOf(sp2, 'chua-boc').textContent.trim(), '—');
  assert.equal(link(sp2, 'ti-trong-khach-lon-nhat'), null, 'khong co ti trong => khong co nut');
  // Nut chi con o cot Ti trong khach lon nhat.
  assert.deepEqual([...page.$('productReportRows').querySelectorAll('button')].map(button => button.closest('td').cellIndex), [idx('ti-trong-khach-lon-nhat')]);
});

test('hop chi tiet giu Doanh so theo khach va them muc lich su, khong goi API CONT', async () => {
  const page = createPage();
  await settle();
  rowOf(page, 'SP-1').click();
  await settle();
  const customers = page.$('productCustomerSection');
  assert.ok(customers);
  assert.equal(page.$('productContainerSection'), null);
  assert.equal([...page.$('docModalBody').querySelectorAll(':scope > section')].map(section => section.id).join(','), 'productHistorySection,productCustomerSection', 'Lịch sử giao dịch đứng đầu hộp, trên Doanh số theo khách');
  assert.match(customers.querySelector('.dp-section-title').textContent, /Doanh số theo khách/);
  assert.doesNotMatch(page.$('docModalBody').textContent, /Hàng dự kiến/);
  assert.ok(customers.querySelector('#productDetailChart'), 'bieu do ty trong nam trong Doanh so theo khach');
  assert.match(customers.textContent, /Khách hàng/);
  assert.equal(page.urls.some(url => url.startsWith('/api/product-report/containers?')), false);
});

test('history loads independently of failed customer section and stale product requests cannot overwrite new product', async () => {
  let answerFirst;
  const data = name => ({from:'2026-08-06',to:'2026-11-03',page:1,pageSize:25,totalRows:1,canViewCost:true,
    summary:{purchaseQuantity:2,returnQuantity:0,purchaseCount:1,returnCount:0},
    rows:[{time:'2026-11-03T10:00:00',customerName:name,type:'invoice',branch:'hanoi',documentCode:'HD1',quantity:2,unitCost:null}]});
  const page = createPage({ customers: () => new Error('fail'), history: query => query.get('code') === 'SP-1'
    ? new Promise(resolve => {answerFirst = resolve;}) : data('Khách mới') });
  await settle(); rowOf(page,'SP-1').click(); await settle();
  rowOf(page,'SP-2').click(); await settle();
  assert.match(page.$('productCustomerContent').textContent,/Không tải được/);
  assert.match(page.$('productHistorySection').textContent,/Khách mới/);
  answerFirst(data('Khách cũ')); await settle();
  assert.doesNotMatch(page.$('productHistorySection').textContent,/Khách cũ/);
  assert.equal(page.$('productHistorySection').querySelector('[data-stat="purchaseCount"]').textContent,'1');
});

test('bam so Ti trong khach lon nhat: mo hop va cuon toi Doanh so theo khach SAU khi da tai xong', async () => {
  const page = createPage({ report: () => ({ rows: [{ ...PRODUCTS[0], unloadedQty: 150, loadedQty: 0 }], containerSync: READY }) });
  await settle();
  cellOf(rowOf(page, 'SP-1'), 'ti-trong-khach-lon-nhat').querySelector('button').click();
  await settle();
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.deepEqual(scrolledSections(page), ['productCustomerSection']);
  assert.equal(page.dom.window.__reportTestInternals.docDetail.focus, null, 'muc tieu chi dung 1 lan');
  // Tai lai hop (metadata doi / Thu lai) khong cuon lai.
  page.run('loadDocumentDetail()'); await settle();
  assert.deepEqual(scrolledSections(page), ['productCustomerSection']);
});

test('bam so Chua bot / Da boc khong con la nut: bam o do mo hop nhu bam o thuong, khong cuon', async () => {
  const page = createPage({ report: () => ({ rows: [{ ...PRODUCTS[0], unloadedQty: 150, loadedQty: 20 }], containerSync: READY }) });
  await settle();
  cellOf(rowOf(page, 'SP-1'), 'da-boc').click();
  await settle();
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.equal(page.urls.filter(url => url === '/api/product-report/customers?code=SP-1').length, 1);
  assert.deepEqual(scrolledSections(page), []);
});

test('bam o thuong (khong phai nut) mo hop khong cuon; dong dong hop huy muc tieu dang cho', async () => {
  let release;
  const page = createPage({ report: () => ({ rows: [{ ...PRODUCTS[0], unloadedQty: 150, loadedQty: 0 }], containerSync: READY }),
    customers: code => new Promise(resolve => { release = () => resolve(customersPayload(code)); }) });
  await settle();
  rowOf(page, 'SP-1').cells[1].click();
  await settle();
  assert.equal(page.dom.window.__reportTestInternals.docDetail.focus, null);
  release(); await settle();
  assert.deepEqual(scrolledSections(page), []);
  page.run('closeDocumentDetail()');

  // Bam nut roi dong hop truoc khi Doanh so theo khach ve: khong cuon, khong de lai muc tieu cho lan mo sau.
  cellOf(rowOf(page, 'SP-1'), 'ti-trong-khach-lon-nhat').querySelector('button').click();
  await settle();
  assert.equal(page.dom.window.__reportTestInternals.docDetail.focus, 'customers');
  page.run('closeDocumentDetail()');
  assert.equal(page.dom.window.__reportTestInternals.docDetail.focus, null);
  release(); await settle();
  assert.deepEqual(scrolledSections(page), []);
});

function sessionHidden(page) {
  const state = page.dom.window.TKSTables.getState(reportTable(page));
  // Mang tao trong realm cua jsdom khong deepEqual duoc voi mang cua test => sao chep ra mang thuong.
  return { key: state.key, hidden: Array.from(state.columns).filter(column => column.hidden).map(column => column.key) };
}
function pageWithTableControls(options) {
  const page = createPage(options);
  page.dom.window.eval(fs.readFileSync(path.join(publicDir, 'shared', 'table-controls.js'), 'utf8'));
  return page;
}

test('khung nhin mac dinh: bo cot dang hien cua Sale / Quan ly / Tro ly KHONG doi; moi cot moi (BC CHUNG + DS khach lon nhat) an o ca hai khung', async () => {
  const sale = pageWithTableControls();
  await settle();
  sale.dom.window.TKSTables.refreshAll();
  assert.deepEqual(sessionHidden(sale).hidden, [], 'truoc khi biet vai tro chua an cot nao');
  sale.run("window.__reportTestState.currentUser = { vaiTro: 'Nhân viên sale' }; applyProductReportColumnView();");
  const saleView = sessionHidden(sale);
  assert.equal(saleView.key, 'dashboard-table-2:sale');
  const columns = columnKeys(sale);
  assert.deepEqual(columns, KEYS);
  assert.deepEqual(columns.filter(key => !saleView.hidden.includes(key)), SALE_VISIBLE, 'sale: A→K (khong co don gia) + cot DS 90 ngay, giong ban 21 cot');
  assert.deepEqual(saleView.hidden, hiddenOf(SALE_VISIBLE));
  NEW_KEYS.forEach(key => assert.ok(saleView.hidden.includes(key), 'cot moi an o khung Sale: ' + key));

  for (const vaiTro of ['Quản lý', 'Trợ lý']) {
    const manager = pageWithTableControls();
    await settle();
    manager.dom.window.TKSTables.refreshAll();
    manager.run("window.__reportTestState.currentUser = { vaiTro: '" + vaiTro + "' }; applyProductReportColumnView();");
    const view = sessionHidden(manager);
    assert.equal(view.key, 'dashboard-table-2:manager');
    assert.deepEqual(columns.filter(key => !view.hidden.includes(key)), MANAGER_VISIBLE, vaiTro + ': bo cot hien giong ban 21 cot (don gia hien san)');
    assert.deepEqual(view.hidden, hiddenOf(MANAGER_VISIBLE));
    NEW_KEYS.forEach(key => assert.ok(view.hidden.includes(key), vaiTro + ': cot moi an: ' + key));
    const hiddenHeaders = [...reportTable(manager).querySelectorAll('thead th.tks-column-hidden')].map(th => th.dataset.columnKey);
    assert.deepEqual(hiddenHeaders, hiddenOf(MANAGER_VISIBLE), 'cot an that su bi an tren giao dien');
    const bodyRows = [...reportTable(manager).querySelectorAll('tbody tr.doc-row')];
    assert.ok(bodyRows.length > 0);
    bodyRows.forEach(row => {
      KEYS.forEach(key => assert.equal(cellOf(row, key).classList.contains('tks-column-hidden'), !MANAGER_VISIBLE.includes(key), 'o cot ' + key));
    });
  }
});

test('khung nhin theo vai tro: nguoi dung bat lai cot bang "Cot hien thi" thi duoc giu; goi lai khong ghi de', async () => {
  const page = pageWithTableControls();
  await settle();
  page.dom.window.TKSTables.refreshAll();
  page.run("window.__reportTestState.currentUser = { vaiTro: 'Quản lý' }; applyProductReportColumnView();");
  assert.ok(sessionHidden(page).hidden.includes('ton-thuc-hn'));
  reportTable(page).closest('.panel').querySelector('.tks-columns-button').click();
  const box = page.doc.querySelector('.tks-columns-picker input[data-column-key="ton-thuc-hn"]');
  box.checked = true; box.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  assert.equal(sessionHidden(page).hidden.includes('ton-thuc-hn'), false);
  // authGuard ve lai / dong goi lai cung hoi so: khong dua cot vua bat ve trang thai an.
  page.run('applyProductReportColumnView()');
  assert.equal(sessionHidden(page).hidden.includes('ton-thuc-hn'), false);
  assert.deepEqual(sessionHidden(page).hidden, hiddenOf(MANAGER_VISIBLE).filter(key => key !== 'ton-thuc-hn'));
  // Cot moi bat duoc bang hop Cot hien thi nhu moi cot khac (vi du Tang truong, DS khach lon nhat).
  ['tang-truong', 'ds-khach-lon-nhat', 'dut-hn'].forEach(key => {
    const input = page.doc.querySelector('.tks-columns-picker input[data-column-key="' + key + '"]');
    assert.ok(input, key + ' co trong hop Cot hien thi');
    input.checked = true; input.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.equal(sessionHidden(page).hidden.includes(key), false, key);
    assert.equal(cellOf(rowOf(page, 'SP-1'), key).classList.contains('tks-column-hidden'), false, 'o cot ' + key);
  });
});

test('4 cot nhay cam (Gia tri co ban HN/SG + Don gia HN/SG): co quyen reports.products.price thi Don gia hien san cho Quan ly / Tro ly, Gia tri co ban an san; khong co quyen thi ca 4 cot bi go khoi bang va hop "Cot hien thi"', async () => {
  const PRICE_KEYS = ['don-gia-hn', 'don-gia-sg'];
  const VALUE_KEYS = ['gia-tri-co-ban-hn', 'gia-tri-co-ban-sg'];
  const onlyThese = keys => keys.sort().join() === SENSITIVE_KEYS.slice().sort().join();
  // Dung 4 th danh dau data-price-column, theo khoa (khong theo chi so).
  const probe = createPage();
  await settle();
  assert.ok(onlyThese([...reportTable(probe).querySelectorAll('thead th[data-price-column]')].map(th => th.dataset.columnKey)));
  // Co quyen: hien/an mac dinh theo ho so, tat/bat lai duoc bang hop Cot hien thi.
  for (const vaiTro of ['Quản lý', 'Trợ lý', 'Nhân viên sale']) {
    const page = pageWithTableControls({ can: key => key === 'reports.products.price' || key.startsWith('reports.') });
    await settle();
    page.dom.window.TKSTables.refreshAll();
    page.run("window.__reportTestState.currentUser = { vaiTro: '" + vaiTro + "' }; applyProductReportColumnView();");
    const showsPrice = vaiTro !== 'Nhân viên sale';
    const hidden = sessionHidden(page).hidden;
    assert.ok(PRICE_KEYS.every(key => hidden.includes(key) === !showsPrice), vaiTro + ': don gia ' + (showsPrice ? 'hien' : 'an') + ' mac dinh');
    assert.ok(VALUE_KEYS.every(key => hidden.includes(key)), vaiTro + ': gia tri co ban an mac dinh');
    reportTable(page).closest('.panel').querySelector('.tks-columns-button').click();
    assert.ok(SENSITIVE_KEYS.every(key => page.doc.querySelector('.tks-columns-picker input[data-column-key="' + key + '"]')), 'ca 4 cot co trong hop Cot hien thi');
    assert.equal(cellOf(rowOf(page, 'SP-1'), 'don-gia-hn').classList.contains('tks-column-hidden'), !showsPrice, 'cot don gia hien san cho Quan ly / Tro ly');
    const box = page.doc.querySelector('.tks-columns-picker input[data-column-key="don-gia-hn"]');
    box.checked = !showsPrice; box.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.equal(sessionHidden(page).hidden.includes('don-gia-hn'), showsPrice, 'doi duoc bang hop Cot hien thi');
    assert.equal(cellOf(rowOf(page, 'SP-1'), 'don-gia-hn').textContent, '15,000');
    // Bat Gia tri co ban: hien so da dinh dang tien.
    const valueBox = page.doc.querySelector('.tks-columns-picker input[data-column-key="gia-tri-co-ban-sg"]');
    valueBox.checked = true; valueBox.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
    assert.equal(sessionHidden(page).hidden.includes('gia-tri-co-ban-sg'), false);
    assert.equal(cellOf(rowOf(page, 'SP-1'), 'gia-tri-co-ban-sg').textContent, '82,500');
    assert.equal(cellOf(rowOf(page, 'SP-1'), 'gia-tri-co-ban-sg').classList.contains('tks-column-hidden'), false);
  }
  // Khong co quyen: ca 4 cot bi an han, khong xuat hien trong hop chon cot.
  for (const vaiTro of ['Nhân viên sale', 'Quản lý']) {
    const page = pageWithTableControls({ can: key => key !== 'reports.products.price' });
    await settle();
    page.dom.window.TKSTables.refreshAll();
    page.run("window.__reportTestState.currentUser = { vaiTro: '" + vaiTro + "' }; applyProductReportColumnView();");
    const priceHeads = [...reportTable(page).querySelectorAll('thead th[data-price-column]')];
    assert.equal(priceHeads.length, 4);
    priceHeads.forEach(th => { assert.equal(th.hidden, true); assert.ok(th.classList.contains('tks-column-hidden')); });
    assert.ok(rowOf(page, 'SP-1'));
    SENSITIVE_KEYS.forEach(key => assert.ok(cellOf(rowOf(page, 'SP-1'), key).classList.contains('tks-column-hidden'), 'o ' + key + ' bi an'));
    reportTable(page).closest('.panel').querySelector('.tks-columns-button').click();
    SENSITIVE_KEYS.forEach(key => assert.equal(page.doc.querySelector('.tks-columns-picker input[data-column-key="' + key + '"]'), null, key + ' khong co trong hop Cot hien thi'));
    assert.ok(page.doc.querySelector('.tks-columns-picker input[data-column-key="ton-thuc-hn"]'), 'cac cot khac van co');
    assert.ok(page.doc.querySelector('.tks-columns-picker input[data-column-key="tang-truong"]'), 'cot moi khong nhay cam van co');
  }
});

test('khung nhin theo vai tro: chua biet vai tro hoac chua nap table-controls thi khong lam gi, khong loi', async () => {
  const page = createPage();
  await settle();
  assert.equal(page.dom.window.TKSTables, undefined);
  page.run("window.__reportTestState.currentUser = { vaiTro: 'Quản lý' }; applyProductReportColumnView();");
  const withControls = pageWithTableControls();
  await settle();
  withControls.dom.window.TKSTables.refreshAll();
  withControls.run('applyProductReportColumnView()'); // currentUser = null
  assert.deepEqual(sessionHidden(withControls), { key: 'dashboard-table-2', hidden: [] });
});

test('cot an mac dinh khop: khoa an cua tung ho so deu co trong thead, cot moi + DS khach lon nhat nam trong danh sach an cua CA HAI ho so, do rong du 35 cot', async () => {
  const page = createPage();
  await settle();
  const keys = columnKeys(page);
  const raw = page.dom.window.__reportTestInternals.hiddenByProfile;
  const lists = { sale: Array.from(raw.sale), manager: Array.from(raw.manager) };
  [...lists.sale, ...lists.manager].forEach(key => assert.ok(keys.includes(key), key));
  assert.equal(new Set(lists.sale).size, lists.sale.length, 'khong khoa an trung (sale)');
  assert.equal(new Set(lists.manager).size, lists.manager.length, 'khong khoa an trung (manager)');
  assert.deepEqual(keys.filter(key => !lists.manager.includes(key)), MANAGER_VISIBLE);
  assert.deepEqual(keys.filter(key => !lists.sale.includes(key)), SALE_VISIBLE);
  NEW_KEYS.forEach(key => { assert.ok(lists.sale.includes(key), 'sale an ' + key); assert.ok(lists.manager.includes(key), 'manager an ' + key); });
  // Do rong khai bao ro cho tung ho so: 35 so duong, cung thu tu thead.
  const widths = page.dom.window.__reportTestInternals.widthsByProfile;
  ['sale', 'manager'].forEach(profile => {
    const list = Array.from(widths[profile]);
    assert.equal(list.length, 35, profile);
    assert.ok(list.every(width => Number.isFinite(width) && width >= 60), profile);
  });
});

test('khung "Doanh so theo khach" va o tim san pham duoi bang da bi go', async () => {
  const page = createPage();
  await settle();
  ['productDetailPanel', 'productDetailSearchInput', 'productDetailSuggestions', 'productDetailEmptyState', 'productDetailContent']
    .forEach(id => assert.equal(page.$(id), null, id + ' khong con'));
});

test('bam 1 dong: goi API dung ma, hop giua man hinh hien bang khach (so tien + %) va bieu do tron canh ben', async () => {
  const page = createPage();
  await settle();
  assert.equal(page.$('docModalBackdrop').hidden, true);

  rowOf(page, 'SP-1').click();
  await settle();

  assert.ok(page.urls.includes('/api/product-report/customers?code=SP-1'));
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.ok(page.doc.querySelector('.doc-modal').classList.contains('is-wide'));
  assert.match(page.$('docModalTitle').textContent, /SP-1.*Khay giấy bạc/);
  assert.match(page.$('docModalSubtitle').textContent, /3 khách.*600.*90 ngày/);

  const rows = [...page.$('docModalBody').querySelectorAll('tbody tr')];
  assert.equal(rows.length, 3);
  assert.match(rows[0].cells[0].textContent, /KH A/);
  assert.match(rows[0].cells[1].textContent, /300/);
  assert.match(rows[0].cells[5].textContent, /50/); // 300 / 600

  const pies = pieCharts(page);
  assert.equal(pies.length, 1);
  assert.deepEqual(pies[0].config.data.labels, ['KH A', 'KH B', 'KH C']);
  assert.deepEqual(pies[0].config.data.datasets[0].data, [300, 200, 100]);
  assert.ok(page.$('docModalBody').contains(page.$('productDetailChart')), 'bieu do nam trong hop');
});

test('product detail places chart beside stats, customer table below and renders three nullable rolling periods', async () => {
  const page=createPage({customers:code=>({...customersPayload(code),periods:[
    {key:'1_30d',label:'T.này',from:'2026-10-06',to:'2026-11-04'},
    {key:'31_60d',label:'T.trước',from:'2026-09-06',to:'2026-10-05'},
    {key:'61_90d',label:'T.trước nữa',from:'2026-08-07',to:'2026-09-05'}
  ],rows:[{customerName:'Khách A',revenue:300,share:1,revenue1_30d:-20,revenue31_60d:0,revenue61_90d:320}]})});
  await settle();rowOf(page,'SP-1').click();await settle();
  const content=page.$('productCustomerContent');
  const overview=content.querySelector('.product-detail-overview');
  assert.ok(overview.querySelector('.dp-stats'));
  assert.ok(overview.contains(page.$('productDetailChart')));
  const table=content.querySelector('table');
  assert.equal(overview.contains(table),false);
  assert.deepEqual([...table.tHead.rows[0].cells].map(c=>c.textContent),['Khách hàng','DS 90 ngày','T.này','T.trước','T.trước nữa','% của SP']);
  assert.match(table.tHead.rows[0].cells[2].title,/06\/10\/2026.*04\/11\/2026/);
  assert.deepEqual([...table.tBodies[0].rows[0].cells].slice(2,5).map(c=>c.getAttribute('data-sort-value')),['-20','0','320']);
  page.dom.window.close();
  const missing=createPage();await settle();rowOf(missing,'SP-1').click();await settle();
  assert.deepEqual([...missing.$('productCustomerContent').querySelector('tbody tr').cells].slice(2,5).map(c=>c.textContent),['—','—','—']);
  missing.dom.window.close();
});

test('bam dong khac: huy bieu do cu, chi con 1 bieu do; dong hop huy bieu do', async () => {
  const page = createPage();
  await settle();

  rowOf(page, 'SP-1').click();
  await settle();
  const firstPie = pieCharts(page)[0];

  rowOf(page, 'SP-2').click();
  await settle();
  assert.ok(firstPie.destroyed, 'bieu do SP cu phai bi huy');
  assert.match(page.$('docModalTitle').textContent, /SP-2/);

  page.run('closeDocumentDetail()');
  assert.equal(page.$('docModalBackdrop').hidden, true);
  assert.equal(pieCharts(page).length, 0);
  assert.equal(page.$('docModalBody').innerHTML, '');
});

test('nhieu khach: bieu do tron hien du tung khach (khong gop "Khac"), bang khach dong vai tro chu giai (o mau trung mau lat)', async () => {
  const page = createPage({ customers: code => customersPayload(code, 14) });
  await settle();
  rowOf(page, 'SP-1').click();
  await settle();

  assert.equal(page.$('docModalBody').querySelectorAll('tbody tr').length, 14);
  const pie = pieCharts(page)[0];
  assert.equal(pie.config.data.labels.length, 14);
  assert.ok(!pie.config.data.labels.some(label => /^Khác/.test(label)));
  assert.equal(pie.config.data.datasets[0].data.reduce((a, b) => a + b, 0), (14 + 13 + 12 + 11 + 10 + 9 + 8 + 7 + 6 + 5 + 4 + 3 + 2 + 1) * 100);
assert.equal(pie.config.options.plugins.legend.display, false, 'legend Chart.js tat: bang khach la chu giai');
  assert.equal(page.$('productDetailLegend'), null, 'khong con chu giai HTML rieng');
  const swatches = [...page.$('docModalBody').querySelectorAll('tbody .dp-swatch')];
  assert.equal(swatches.length, 14);
  const probe = page.doc.createElement('i');
  const normalized = color => { probe.style.background = ''; probe.style.background = color; return probe.style.background; };
  swatches.forEach((swatch, index) => {
    assert.equal(swatch.style.background, normalized(pie.config.data.datasets[0].backgroundColor[index]), 'o mau dong ' + index + ' trung mau lat');
  });
  assert.match(page.$('docModalBody').querySelector('tbody tr').textContent, /KH A/);
});

test('san pham chua co du lieu khach: thong bao ro rang, khong ve bieu do', async () => {
  const page = createPage({ customers: code => ({ code, totalRevenue: 0, customerCount: 0, rows: [] }) });
  await settle();
  rowOf(page, 'SP-2').click();
  await settle();

  assert.match(modalText(page), /Chưa có dữ liệu khách/);
  assert.equal(pieCharts(page).length, 0);
});

test('API loi: hien thong bao loi + nut Thu lai trong hop, khong vo trang', async () => {
  const page = createPage({ customers: () => new Error('boom') });
  await settle();
  rowOf(page, 'SP-1').click();
  await settle();

  assert.match(modalText(page), /Không tải được doanh số khách/);
  assert.ok(page.$('docModalBody').querySelector('button'), 'co nut Thu lai');
  assert.equal(pieCharts(page).length, 0);
});

test('phim Enter tren dong cung mo hop chi tiet', async () => {
  const page = createPage();
  await settle();
  rowOf(page, 'SP-1').dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.match(page.$('docModalTitle').textContent, /SP-1/);
});

const statsOf = page => Object.fromEntries([...page.$('docModalBody').querySelectorAll('.dp-stat')].map(el => [
  el.querySelector('.dp-stat-label').textContent,
  { value: el.querySelector('.dp-stat-value').textContent, sub: (el.querySelector('.dp-stat-sub') || { textContent: '' }).textContent }
]));

test('hop co hang chi so tong quan: doanh so, so khach, khach lon nhat, top 3, ton HN-SG va SL ban 30 ngay (lay tu dong bang)', async () => {
  const page = createPage({ customers: code => customersPayload(code, 14) });
  await settle();
  rowOf(page, 'SP-1').click();
  await settle();

  const stats = statsOf(page);
  // 14 khach, doanh so (14 - i) * 100 => tong 10.500; khach lon nhat 1.400 (13,3%); top 3 = 3.900 (37,1%)
  assert.match(stats['Doanh số 90 ngày'].value, /10,500₫/);
  assert.equal(stats['Số khách mua'].value, '14');
  assert.equal(stats['Số khách mua'].sub, 'TB 750₫ / khách');
  assert.match(stats['Khách lớn nhất'].value, /13[.,]3%/);
  assert.equal(stats['Khách lớn nhất'].sub, 'KH A');
  assert.match(stats['Top 3 khách'].value, /37[.,]1%/);
  assert.match(stats['Top 3 khách'].sub, /3,900₫/);
  assert.equal(stats['Tồn HN · SG'].value, '5 · 3');
  assert.equal(stats['Tồn HN · SG'].sub, 'Có thể bán 8');
  assert.equal(stats['SL bán 30 ngày'].value, '4');
});

test('it khach (<= 3): khong co the "Top 3 khach" (luon 100%)', async () => {
  const page = createPage();
  await settle();
  rowOf(page, 'SP-1').click();
  await settle();
  assert.equal(statsOf(page)['Top 3 khách'], undefined);
  assert.ok(statsOf(page)['Doanh số 90 ngày']);
});

test('hop co sort, thanh keo do rong cot va nut "Cột hiển thị" o dau khoi Khach hang; sort theo so (data-sort-value)', async () => {
  const page = createPage();
  await settle();
  page.dom.window.eval(fs.readFileSync(path.join(publicDir, 'shared', 'table-controls.js'), 'utf8'));
  rowOf(page, 'SP-1').click();
  await settle();
  const table = page.$('docModalBody').querySelector('table');
  assert.equal(table.getAttribute('data-table-controls'), null);
  page.dom.window.TKSTables.refreshAll();
  const buttons = page.$('docModalBackdrop').querySelectorAll('.tks-columns-button');
  assert.equal(buttons.length, 1);
  assert.ok(buttons[0].parentElement.classList.contains('dp-section-head'), 'nut nam o dau khoi, khong them hang cong cu');
  assert.equal(table.querySelectorAll('th > .tks-column-resizer').length, 6);

  // sort theo cot "Doanh so 90 ngay": tang dan roi giam dan, thu tu goc khi bam lan 3
  const names = () => [...table.tBodies[0].rows].map(row => row.cells[0].textContent.trim());
  const original = names();
  const header = table.tHead.rows[0].cells[1];
  header.querySelector('.sort-button').click();
  const ascending = names();
  assert.deepEqual(ascending, original.slice().sort((a, b) => revenueOf(table, a) - revenueOf(table, b)));
  header.querySelector('.sort-button').click();
  assert.deepEqual(names(), ascending.slice().reverse());
  header.querySelector('.sort-button').click();
  assert.deepEqual(names(), original);
  // an cot: du lieu van con, chi cot bi an
  buttons[0].click();
  const picker = page.$('docModalBackdrop').ownerDocument.querySelector('.tks-columns-picker');
  assert.equal(picker.hidden, false);
});

function revenueOf(table, name) {
  const row = [...table.tBodies[0].rows].find(item => item.cells[0].textContent.trim() === name);
  return Number(row.cells[1].getAttribute('data-sort-value'));
}

const READY_SYNC = { available: true, version: 'v1', lastSuccessAt: '2026-10-15T02:00:00Z' };

test('loi tai doanh so khach khong lam hop vo; o Chua boc chua co snapshot van la "—"', async () => {
  const page = createPage({ customers: () => new Error('fail') });
  await settle(); rowOf(page, 'SP-1').click(); await settle();
  assert.match(page.$('productCustomerSection').textContent, /Không tải được/);
  assert.equal(cellOf(rowOf(page, 'SP-1'), 'chua-boc').textContent, '—');
});

test('phan hoi doanh so khach cu khong duoc ghi de ma moi hoac mo lai hop da dong', async () => {
  let resolveFirst;
  const page = createPage({ customers: code => code === 'SP-1' ? new Promise(resolve => { resolveFirst = resolve; }) : customersPayload(code, 1) });
  await settle(); rowOf(page, 'SP-1').click(); await settle();
  rowOf(page, 'SP-2').click(); await settle();
  resolveFirst(customersPayload('SP-1', 3)); await settle();
  assert.equal(page.$('docModalBody').querySelectorAll('tbody tr').length, 1, 'chi con khach cua SP-2');
  page.run('closeDocumentDetail()'); await settle();
  assert.equal(page.$('docModalBody').innerHTML, '');
});

test('Chua boc / Da boc giu so 0 va so thap phan (khong con goi API CONT khi mo hop)', async () => {
  const page = createPage({
    report: () => ({ rows: [{ ...PRODUCTS[0], unloadedQty: 0, loadedQty: 3.25 }], containerSync: READY_SYNC })
  });
  await settle();
  assert.equal(cellOf(rowOf(page, 'SP-1'), 'chua-boc').textContent, '0');
  assert.equal(cellOf(rowOf(page, 'SP-1'), 'da-boc').textContent, '3.25');
  rowOf(page, 'SP-1').click(); await settle();
  assert.equal(page.urls.some(url => url.startsWith('/api/product-report/containers?')), false);
  assert.equal(page.$('productContainerSection'), null);
});

test('metadata thay doi moi tai lai bang va giu tim kiem, sort, trang; an view khong goi API', async () => {
  let version = 'v1';
  const page = createPage({ meta: () => ({ ...READY_SYNC, version }), report: () => ({ rows: PRODUCTS.map(p => ({ ...p, unloadedQty: version === 'v1' ? 10 : 20, loadedQty: 0 })), containerSync: { ...READY_SYNC, version } }) });
  await settle();
  const calls = () => page.urls.filter(url => url === '/api/product-report').length;
  const initialCalls = calls();
  page.run("document.querySelectorAll('.view').forEach(el => el.classList.remove('active')); document.getElementById('productReportRows').closest('.view').classList.add('active'); window.__reportTestState.view = document.getElementById('productReportRows').closest('.view').id.replace('view-', '');");
  await page.run('refreshProductContainerMeta()'); await settle();
  assert.equal(calls(), initialCalls, 'cung version khong tai lai');
  page.run("getTableSearchState('productReport').query = 'SP-1'; window.__reportTestState.tableSorts.productReportRows = { columnIndex: " + idx('chua-boc') + ", direction: 'desc' }; window.__reportTestState.tablePages.productReport = 1;");
  version = 'v2';
  await page.run('refreshProductContainerMeta()'); await settle();
  assert.equal(calls(), initialCalls + 1);
  assert.equal(cellOf(rowOf(page, 'SP-1'), 'chua-boc').textContent, '20');
  assert.equal(rowOf(page, 'SP-2'), undefined, 'bo loc tim kiem van duoc giu');
  assert.equal(page.run("getTableSearchState('productReport').query"), 'SP-1');
  assert.equal(page.run('window.__reportTestState.tableSorts.productReportRows.columnIndex'), idx('chua-boc'));
  assert.equal(page.run('window.__reportTestState.tablePages.productReport'), 1);
  const metaCalls = page.urls.filter(url => url.includes('/containers/meta')).length;
  page.run("document.getElementById('productReportRows').closest('.view').classList.remove('active')");
  version = 'v3'; await page.run('refreshProductContainerMeta()'); await settle();
  assert.equal(page.urls.filter(url => url.includes('/containers/meta')).length, metaCalls);
});

test('dong chi tiet sau metadata refresh tra focus ve dong ma moi thay vi dong da tach DOM', async () => {
  let version = 'v1';
  const page = createPage({
    meta: () => ({ ...READY_SYNC, version }),
    report: () => ({ rows: PRODUCTS, containerSync: { ...READY_SYNC, version } })
  });
  await settle();
  const oldRow = rowOf(page, 'SP-1');
  oldRow.focus(); oldRow.click(); await settle();
  page.run("document.querySelectorAll('.view').forEach(el => el.classList.remove('active')); document.getElementById('productReportRows').closest('.view').classList.add('active'); window.__reportTestState.view = document.getElementById('productReportRows').closest('.view').id.replace('view-', '');");
  version = 'v2';
  await page.run('refreshProductContainerMeta()'); await settle();
  const newRow = rowOf(page, 'SP-1');
  assert.equal(oldRow.isConnected, false);
  assert.notEqual(newRow, oldRow);
  page.run('closeDocumentDetail()');
  assert.equal(page.doc.activeElement, newRow);
});

test('dong chi tiet tra focus ve tim kiem bao cao khi ma khong con tren trang', async () => {
  const page = createPage();
  await settle();
  rowOf(page, 'SP-1').click(); await settle();
  page.run("getTableSearchState('productReport').query = 'SP-2'; renderProductReport();");
  assert.equal(rowOf(page, 'SP-1'), undefined);
  page.run('closeDocumentDetail()');
  assert.equal(page.doc.activeElement, page.doc.querySelector('[data-table-search="productReport"] .table-search-input'));
});

test('reportVersion cua bao cao doi (CONT khong doi) => tai lai bang; cung version hoac null => khong tai lai', async () => {
  let version = 'r1';
  const page = createPage({
    meta: () => READY_SYNC,
    reportVersion: () => version,
    report: () => ({ rows: PRODUCTS, containerSync: READY_SYNC, reportVersion: 'r1' })
  });
  await settle();
  const calls = () => page.urls.filter(url => url === '/api/product-report').length;
  const initialCalls = calls();
  page.run("document.querySelectorAll('.view').forEach(el => el.classList.remove('active')); document.getElementById('productReportRows').closest('.view').classList.add('active'); window.__reportTestState.view = document.getElementById('productReportRows').closest('.view').id.replace('view-', '');");
  await page.run('refreshProductContainerMeta()'); await settle();
  assert.equal(calls(), initialCalls, 'cung reportVersion => khong tai lai');
  version = 'r2';
  await page.run('refreshProductContainerMeta()'); await settle();
  assert.equal(calls(), initialCalls + 1, 'reportVersion doi => tai lai 1 lan');
  // Phan hoi tai lai van mang version cu 'r1' trong fixture nen lan poll sau lai thay khac; doi fixture cho khop.
});

test('chua co che do tang dan (reportVersion = null) thi khong tai lai chi vi reportVersion', async () => {
  const page = createPage({ meta: () => READY_SYNC, reportVersion: () => null, report: () => ({ rows: PRODUCTS, containerSync: READY_SYNC }) });
  await settle();
  const calls = () => page.urls.filter(url => url === '/api/product-report').length;
  const initialCalls = calls();
  page.run("document.querySelectorAll('.view').forEach(el => el.classList.remove('active')); document.getElementById('productReportRows').closest('.view').classList.add('active'); window.__reportTestState.view = document.getElementById('productReportRows').closest('.view').id.replace('view-', '');");
  await page.run('refreshProductContainerMeta()'); await settle();
  assert.equal(calls(), initialCalls);
});

// Tô màu bảng: cột tồn / có bán theo cơ sở (HN xanh dương, SG tím) và rule màu Ngày cần đặt sao Conditional Formatting Excel.
test('Ngay can dat to mau theo rule Excel (<10,5 xanh la, 10,5-20 vang, 20-30 cam, >30 do); o trong khong to; cot ton HN/SG co lop to mau', async () => {
  const page = createPage();
  await settle();

  const classOf = value => page.run('productReportDaysToOrderClass(' + value + ')');
  assert.equal(classOf(-5), 'pr-days-low', 'so am (het hang) thuoc nhom < 10,5');
  assert.equal(classOf(0), 'pr-days-low');
  assert.equal(classOf(10.4), 'pr-days-low');
  assert.equal(classOf(10.5), 'pr-days-mid');
  assert.equal(classOf(19.9), 'pr-days-mid');
  assert.equal(classOf(20), 'pr-days-high', 'Excel: 20 thuoc rule between 20 and 30 (uu tien cao hon)');
  assert.equal(classOf(30), 'pr-days-high');
  assert.equal(classOf(30.1), 'pr-days-over');

  const cell = key => cellOf(rowOf(page, 'SP-1'), key);
  assert.ok(cell('ngay-can-dat').classList.contains('pr-days-mid'), 'SP-1: 12,5 ngay => vang');
  const empty = cellOf(rowOf(page, 'SP-2'), 'ngay-can-dat');
  assert.equal(empty.textContent, '—');
  assert.ok(![...empty.classList].some(name => name.startsWith('pr-days-')), 'o "—" khong to mau');

  // Mau theo LOAI cot, khong theo co so: Ton thuc (HN + SG) cung mau, Co ban (HN + SG) cung mau khac.
  ['ton-thuc-hn', 'ton-thuc-sg'].forEach(key => assert.ok(cell(key).classList.contains('pr-stock') && !cell(key).classList.contains('pr-avail'), key + ' to mau Ton thuc'));
  ['co-ban-hn', 'co-ban-sg'].forEach(key => assert.ok(cell(key).classList.contains('pr-avail') && !cell(key).classList.contains('pr-stock'), key + ' to mau Co ban'));
  ['co-ban-hn', 'co-ban-sg'].forEach(key => assert.ok(cellOf(rowOf(page, 'SP-2'), key).classList.contains('pr-avail'), 'o Co ban "—" van to mau de cot lien mach'));
  assert.equal(reportTable(page).id, 'productReportTable');
});

// Tiêu đề giống bảng Kiểm kê: ▲▼ nhỏ ở góc dưới phải (không chiếm chỗ chữ); Mô tả HN/SG chữ nhỏ hơn.
test('tieu de bang Bao cao hang hoa giong Kiem ke (mui ten sort o goc, khong an chu) va cot Mo ta HN/SG chu nho', async () => {
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join('\n');
  const rule = selector => {
    // Gộp thân mọi rule có selector kết thúc đúng bằng `selector {` (selector có thể nằm trong nhóm nhiều selector).
    const bodies = [];
    for (let start = css.indexOf(selector + ' {'); start >= 0; start = css.indexOf(selector + ' {', start + 1)) {
      bodies.push(css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start)));
    }
    assert.ok(bodies.length, 'thieu rule CSS ' + selector);
    return bodies.join(' ').replace(/\s+/g, ' ');
  };
  const indicator = rule('#productReportTable thead th .sort-indicator');
  assert.match(indicator, /position: absolute/);
  assert.match(indicator, /font-size: 7px/);
  assert.match(indicator, /bottom: -8px/);
  assert.match(rule('#productReportTable thead th .sort-button'), /position: relative/);
  assert.match(rule('#productReportTable thead th'), /padding: 5px 4px 9px/);
  assert.match(rule('#productReportTable td.pr-desc'), /font-size: 11px/);

  const page = createPage();
  await settle();
  const row = rowOf(page, 'SP-1');
  ['mo-ta-hn', 'mo-ta-sg'].forEach(key => assert.ok(cellOf(row, key).classList.contains('pr-desc'), key + ' dung chu nho'));
});
