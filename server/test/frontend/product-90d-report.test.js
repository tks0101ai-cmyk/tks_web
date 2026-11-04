'use strict';

// Muc 4 "Hang hoa 90 ngay" cua tab Hang hoa (product-90d-report.js): ham thuan (dinh dang NULL/0/am/le, Top 3, khoang ngay,
// chuoi truy van), cau truc tieu de 2 tang trong index.html, hanh vi bang (tim/sap xep/phan trang o may chu, chong phan hoi cu,
// 4 trang thai) va phan quyen tren trang that.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const modulePath = path.join(publicDir, 'product-90d-report.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const H = require(modulePath);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- ham thuan ----------
test('formatValue: NULL -> "—", 0 -> "0", so am va so le giu nguyen theo en-US', () => {
  assert.equal(H.formatValue(null), '—');
  assert.equal(H.formatValue(undefined), '—');
  assert.equal(H.formatValue(''), '—');
  assert.equal(H.formatValue('abc'), '—');
  assert.equal(H.formatValue(0), '0');
  assert.equal(H.formatValue(-0), '0');
  assert.equal(H.formatValue('0'), '0');
  assert.equal(H.formatValue(-3), '-3');
  assert.equal(H.formatValue(-1250.5), '-1,250.5');
  assert.equal(H.formatValue(2.5), '2.5');
  assert.equal(H.formatValue(0.125), '0.125');
  assert.equal(H.formatValue(1234567.5), '1,234,567.5');
  assert.equal(H.formatValue('12.3456789'), '12.3456789', 'giu toi 8 chu so le, khong lam tron mat');
  assert.equal(H.formatValue(100000.0238), '100,000.0238');
  assert.equal(H.formatValue(1.123456789), '1.12345679');
  assert.equal(H.formatValue(2.50000000), '2.5', 'bo so 0 thua');
  assert.equal(H.formatValue(1500000), '1,500,000');
});

test('formatShare: ty le 0-1 thanh %, NULL -> "—"', () => {
  assert.equal(H.formatShare(0.4523), '45.2%');
  assert.equal(H.formatShare(1), '100%');
  assert.equal(H.formatShare(0), '0%');
  assert.equal(H.formatShare(null), '—');
});

test('formatPeriodRange + formatStamp (gio Viet Nam)', () => {
  assert.equal(H.formatPeriodRange('2026-08-06', '2026-09-04'), '06/08–04/09/2026');
  assert.equal(H.formatPeriodRange('2025-12-15', '2026-01-13'), '15/12/2025–13/01/2026');
  assert.equal(H.formatPeriodRange(null, '2026-01-13'), '');
  assert.equal(H.formatStamp('2026-11-03T19:05:00.000Z'), '02:05 04/11/2026');
  assert.equal(H.formatStamp('khong-phai-ngay'), '');
  assert.equal(H.formatStamp(null), '');
});

test('topCustomerLines: moi khach 1 dong "Ten|%DS|DS" (khong SL, khong phan cach nghin), bo khach SL = 0', () => {
  assert.deepEqual(H.topCustomerLines([
    { name: 'HN C Vương Ninh HN', share: 0.1, revenue: 45000000, quantity: 3 },
    { name: 'Khách B', share: 0.622, revenue: 10300000, quantity: 1 },
    { name: 'Khách C', share: 0.125, revenue: 300000.5, quantity: 1.5 }
  ]), ['HN C Vương Ninh HN|10%|45000000', 'Khách B|62.2%|10300000', 'Khách C|12.5%|300000.5']);
  // SL 0 (ke ca dong toan so 0) bi bo; SL am (tra hang) giu; ten rong -> "Khách lẻ"; share NULL -> "—"; doanh so am giu.
  assert.deepEqual(H.topCustomerLines([
    { name: 'Không mua', share: 0, revenue: 0, quantity: 0 },
    { name: '', share: null, revenue: -1250.5, quantity: -2 },
    { name: 'Chỉ SL 0', share: 0.3, revenue: 500, quantity: '0' }
  ]), ['Khách lẻ|—|-1250.5']);
  assert.deepEqual(H.topCustomerLines([{ name: 'A', share: 0, revenue: 0, quantity: 0 }]), [], 'loc het -> rong');
  assert.deepEqual(H.topCustomerLines(null), []);
  // Chi lay toi da 3 khach dau (du lieu da xep san).
  assert.equal(H.topCustomerLines([1, 2, 3, 4].map(i => ({ name: 'K' + i, share: 0.1, revenue: i, quantity: 1 }))).length, 3);
});

test('topCustomersHtml: 1 dong / khach + title cung chu, rong hoac loc het -> "—", ten co | va ky tu HTML duoc escape', () => {
  assert.match(H.topCustomersHtml([]), /—/);
  assert.doesNotMatch(H.topCustomersHtml([]), /<ol/);
  assert.match(H.topCustomersHtml(null), /—/);
  assert.match(H.topCustomersHtml([{ name: 'X', share: 0, revenue: 0, quantity: 0 }]), /—/, 'chi co khach SL 0 -> "—"');
  const dom = new JSDOM('<div id="x"></div>');
  const box = dom.window.document.getElementById('x');
  box.innerHTML = H.topCustomersHtml([
    { name: 'Đặng <An> | "Cty"', share: 0.5, revenue: 1200000, quantity: 12 },
    { name: 'Bỏ vì SL 0', share: 0, revenue: 0, quantity: 0 },
    { name: 'Khách C', share: 0.125, revenue: 300000.5, quantity: 1.5 }
  ]);
  const items = [...box.querySelectorAll('li')];
  assert.equal(items.length, 2);
  assert.equal(items[0].textContent, 'Đặng <An> | "Cty"|50%|1200000');
  assert.equal(items[0].title, items[0].textContent);
  assert.equal(box.querySelector('an'), null);
  assert.equal(items[1].textContent, 'Khách C|12.5%|300000.5');
});

test('exportContext + sortAction: payload Xuat file theo tu khoa da ap dung va nhan cot; nut sap xep bao hanh dong ke tiep', () => {
  assert.deepEqual(H.exportContext({ q: '  binh  ', sort: 'revenue_1_30d', dir: 'desc' }),
    { tableSearch: { mode: 'normal', query: 'binh' }, tableSort: { label: 'T.này – DS', direction: 'desc' } });
  assert.deepEqual(H.exportContext({ q: '', sort: '', dir: '' }), { tableSearch: { mode: 'normal', query: '' } });
  assert.deepEqual(H.exportContext({ q: 'x', sort: 'product_name', dir: 'asc' }).tableSort, { label: 'Tên hàng', direction: 'asc' });
  assert.equal(H.exportContext({ sort: 'top_customers_1_30d', dir: 'asc' }).tableSort, undefined, 'cot khong sap duoc');
  assert.equal(H.exportContext({ q: 'y'.repeat(250) }).tableSearch.query.length, 200);
  assert.equal(H.sortAction('none'), 'Sắp xếp tăng dần');
  assert.equal(H.sortAction('ascending'), 'Sắp xếp giảm dần');
  assert.equal(H.sortAction('descending'), 'Bỏ sắp xếp');
});

test('rowHtml: 26 o theo thu tu cot, NULL avg_price -> "—", 0 -> 0, am/le giu nguyen', () => {
  const row = { product_code: 'SP01', product_name: 'Tên rất dài <b>' };
  H.PERIODS.forEach(p => {
    Object.assign(row, { ['qty_' + p.key]: 0, ['revenue_' + p.key]: 0, ['avg_price_' + p.key]: null,
      ['customer_count_' + p.key]: 0, ['invoice_count_' + p.key]: 0, ['top_customers_' + p.key]: [] });
  });
  row.qty_1_30d = -4; row.revenue_1_30d = -800000; row.qty_1_90d = 2.75; row.avg_price_1_90d = 1234.5;
  const dom = new JSDOM('<table><tbody id="b"></tbody></table>');
  const body = dom.window.document.getElementById('b');
  body.innerHTML = H.rowHtml(row);
  const cells = [...body.rows[0].cells].map(td => td.textContent.trim());
  assert.equal(cells.length, 26);
  const at = key => cells[H.COLUMNS.findIndex(c => c.key === key)];
  assert.equal(at('product_code'), 'SP01');
  assert.equal(at('product_name'), 'Tên rất dài <b>');
  assert.equal(at('qty_61_90d'), '0');
  assert.equal(at('avg_price_61_90d'), '—');
  assert.equal(at('top_customers_61_90d'), '—');
  assert.equal(at('qty_1_30d'), '-4');
  assert.equal(at('revenue_1_30d'), '-800,000');
  assert.equal(at('qty_1_90d'), '2.75');
  assert.equal(at('avg_price_1_90d'), '1,234.5');
});

test('buildQuery bo tham so rong; dir chi di kem sort; relevance khong gui', () => {
  assert.equal(H.buildQuery({ q: '', sort: '', dir: '', page: 1, pageSize: 50 }), 'page=1&pageSize=50');
  assert.equal(H.buildQuery({ q: '  ', sort: '', dir: 'desc', page: 1, pageSize: 50 }), 'page=1&pageSize=50');
  assert.equal(H.buildQuery({ q: ' ốc vít ', sort: 'revenue_1_90d', dir: 'desc', page: 3, pageSize: 100 }),
    'q=%E1%BB%91c+v%C3%ADt&sort=revenue_1_90d&dir=desc&page=3&pageSize=100');
  assert.equal(H.buildQuery({ q: 'a', sort: 'relevance', dir: 'asc', page: 1, pageSize: 50 }), 'q=a&page=1&pageSize=50');
  assert.equal(H.buildQuery({}), '');
  assert.equal(H.buildQuery({ pageSize: 500 }), 'pageSize=200');
});

test('nextSort: tang dan -> giam dan -> bo sap xep', () => {
  assert.deepEqual(H.nextSort({ sort: '', dir: '' }, 'qty_1_30d'), { sort: 'qty_1_30d', dir: 'asc' });
  assert.deepEqual(H.nextSort({ sort: 'qty_1_30d', dir: 'asc' }, 'qty_1_30d'), { sort: 'qty_1_30d', dir: 'desc' });
  assert.deepEqual(H.nextSort({ sort: 'qty_1_30d', dir: 'desc' }, 'qty_1_30d'), { sort: '', dir: '' });
  assert.deepEqual(H.nextSort({ sort: 'qty_1_30d', dir: 'desc' }, 'product_code'), { sort: 'product_code', dir: 'asc' });
});

// ---------- cau truc index.html ----------
const pageDoc = new JSDOM(html).window.document;

test('muc 4 nam ngay sau Tang truong ma hang, buoc "4", tieu de "Hàng hóa 90 ngày", an mac dinh, nap script/css co ?v=', () => {
  const ids = [...pageDoc.querySelectorAll('#view-products > section.section')].map(s => s.id);
  assert.deepEqual(ids, ['productReportSection', 'expectedArrivalsSection', 'productGrowthSection', 'product90dSection']);
  const section = pageDoc.getElementById('product90dSection');
  assert.equal(section.hidden, true);
  assert.equal(section.querySelector('.section-step').textContent.trim(), '4');
  assert.equal(section.querySelector('.section-head h2').firstChild.textContent.trim(), 'Hàng hóa 90 ngày');
  assert.match(html, /<script src="\/product-90d-report\.js\?v=\d{8}-\d+"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/product-90d-report\.css\?v=\d{8}-\d+">/);
  assert.ok(html.indexOf('/shared/table-controls.js') < html.indexOf('/product-90d-report.js'), 'table-controls phai nap truoc');
  // Khong co bo loc co so, khong co nut lam moi nguon.
  assert.equal(section.querySelector('select:not(#product90dPageSize)'), null);
  assert.doesNotMatch(section.textContent, /Làm mới/);
});

function leafGrid(thead) {
  const occupied = []; const leaves = [];
  [...thead.rows].forEach((row, r) => {
    let cursor = 0;
    [...row.cells].forEach(cell => {
      while (occupied[cursor] > r) cursor++;
      for (let i = cursor; i < cursor + cell.colSpan; i++) occupied[i] = r + (cell.rowSpan || 1);
      if (cell.colSpan === 1) leaves[cursor] = cell;
      cursor += cell.colSpan;
    });
  });
  return leaves;
}

test('tieu de 2 tang: 26 cot la (khoa on dinh, duy nhat, khop COLUMNS), 4 nhom colspan 6 dung thu tu ky', () => {
  const table = pageDoc.getElementById('product90dTable');
  assert.equal(table.dataset.tableSort, 'off');
  assert.ok(table.classList.contains('fixed-table'));
  const thead = table.tHead;
  assert.equal(thead.rows.length, 2);
  const groups = [...thead.rows[0].querySelectorAll('th.p90-group')];
  assert.deepEqual(groups.map(g => g.dataset.period), ['61_90d', '31_60d', '1_30d', '1_90d']);
  assert.deepEqual(groups.map(g => g.colSpan), [6, 6, 6, 6]);
  assert.deepEqual(groups.map(g => g.querySelector('.p90-group-label').textContent), ['T.trc nữa', 'T.trc', 'T.này', '90 ngày']);
  const leaves = leafGrid(thead);
  assert.equal(leaves.length, 26);
  const keys = leaves.map(th => th.dataset.columnKey);
  assert.equal(new Set(keys).size, 26, 'khoa cot phai duy nhat');
  assert.deepEqual(keys, H.COLUMNS.map(c => c.key));
  assert.deepEqual(leaves.slice(2, 8).map(th => th.textContent.replace(/[▲▼]/g, '').trim()), ['SL', 'DS', 'Giá TB', 'SL khách', 'Lượt mua', 'Top 3 khách']);
  // Moi th co data-no-sort (trang khong tu sap xep tai cho); cot so co nut sap xep cua module, Top 3 thi khong.
  [...thead.querySelectorAll('th')].forEach(th => assert.ok(th.hasAttribute('data-no-sort'), th.outerHTML.slice(0, 80)));
  leaves.forEach(th => {
    const key = th.dataset.columnKey;
    if (/^top_customers_/.test(key)) {
      assert.equal(th.querySelector('.sort-button'), null, key);
      assert.equal(th.dataset.sort, undefined);
    } else {
      assert.equal(th.dataset.sort, key);
      assert.equal(th.querySelector('.sort-indicator').textContent, '▲▼');
    }
  });
  // Nhan trong hop Cot hien thi phan biet duoc ky.
  assert.equal(H.COLUMNS.find(c => c.key === 'qty_1_30d').pickerLabel, 'T.này – SL');
  assert.equal(new Set(H.COLUMNS.map(c => c.pickerLabel)).size, 26);
});

// ---------- hanh vi bang (DOM toi thieu + table-controls that) ----------
function sectionHtml() {
  const start = html.indexOf('<section class="section" id="product90dSection"');
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
}

function periods() {
  return [
    { key: '61_90d', label: 'T.trc nữa', from: '2026-08-06', to: '2026-09-04' },
    { key: '31_60d', label: 'T.trc', from: '2026-09-05', to: '2026-10-04' },
    { key: '1_30d', label: 'T.này', from: '2026-10-05', to: '2026-11-03' },
    { key: '1_90d', label: '90 ngày', from: '2026-08-06', to: '2026-11-03' }
  ];
}
function sampleRow(code, extra) {
  const row = { product_code: code, product_name: 'Hàng ' + code };
  H.PERIODS.forEach(p => Object.assign(row, { ['qty_' + p.key]: 1, ['revenue_' + p.key]: 1000, ['avg_price_' + p.key]: 1000,
    ['customer_count_' + p.key]: 1, ['invoice_count_' + p.key]: 1, ['top_customers_' + p.key]: [{ name: 'KH', share: 1, revenue: 1000, quantity: 1 }] }));
  return Object.assign(row, extra);
}
function report(rows, extra) {
  return Object.assign({ available: true, state: { asOfDate: '2026-11-04', windowStart: '2026-08-06', windowEnd: '2026-11-03',
    computedAt: '2026-11-03T19:05:00.000Z', rowCount: rows.length, version: 3 }, periods: periods(), rows,
    totalRows: rows.length, page: 1, pageSize: 50, sort: 'product_code', dir: 'asc' }, extra);
}

function createWidget({ can = () => true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="view active" id="view-products">' + sectionHtml() + '</div></body>',
    { runScripts: 'outside-only', url: 'https://tokosi.example/reports/#products', pretendToBeVisual: true });
  const w = dom.window;
  w.TKSNav = { can };
  const calls = [];
  w.fetch = (url, options) => new Promise((resolve, reject) => {
    if (!String(url).startsWith('/api/product-report/90d')) return; // vd /api/me/table-prefs cua table-controls
    const call = { url: String(url), options, resolve, reject };
    calls.push(call);
    if (options && options.signal) options.signal.addEventListener('abort', () => { call.aborted = true; });
  });
  w.eval(fs.readFileSync(path.join(publicDir, 'shared', 'table-controls.js'), 'utf8'));
  w.eval(moduleSource);
  const $ = id => w.document.getElementById(id);
  const answer = (index, body, status = 200) => calls[index].resolve({ ok: status < 400, status, json: async () => body });
  const params = index => new URL(calls[index].url, 'https://x').searchParams;
  const texts = () => [...$('product90dRows').rows].map(tr => [...tr.cells].map(td => td.textContent.trim()));
  return { dom, w, $, calls, answer, params, texts };
}

test('tai lan dau: goi API mac dinh, ve dong, khoang ngay tren tieu de, "Dữ liệu cập nhật lúc" gio VN', async () => {
  const p = createWidget();
  try {
    p.w.TKSProduct90d.load(false);
    assert.equal(p.$('product90dSection').hidden, false);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].url, '/api/product-report/90d?page=1&pageSize=50');
    assert.match(p.$('product90dRows').textContent, /Đang tải/);
    p.answer(0, report([sampleRow('SP1', { avg_price_1_30d: null, qty_1_30d: 0, qty_31_60d: -2, qty_1_90d: 0.5, top_customers_1_30d: [] })]));
    await settle();
    const row = p.texts()[0];
    const at = key => row[H.COLUMNS.findIndex(c => c.key === key)];
    assert.equal(at('product_code'), 'SP1');
    assert.equal(at('avg_price_1_30d'), '—');
    assert.equal(at('qty_1_30d'), '0');
    assert.equal(at('qty_31_60d'), '-2');
    assert.equal(at('qty_1_90d'), '0.5');
    assert.equal(at('top_customers_1_30d'), '—');
    assert.deepEqual([...p.w.document.querySelectorAll('th.p90-group .p90-group-range')].map(s => s.textContent),
      ['06/08–04/09/2026', '05/09–04/10/2026', '05/10–03/11/2026', '06/08–03/11/2026']);
    assert.equal(p.$('product90dUpdatedAt').textContent, 'Dữ liệu cập nhật lúc 02:05 04/11/2026');
    assert.equal(p.$('tagProduct90dRows').textContent, '1 mã');
    // Du lieu con moi: mo lai tab khong goi lai API.
    await p.w.TKSProduct90d.load(false);
    assert.equal(p.calls.length, 1);
  } finally { p.dom.window.close(); }
});

test('sap xep o may chu: ▲▼ -> ▼ tang -> ▲ giam -> bo; Top 3 khong sap xep; ve trang 1', async () => {
  const p = createWidget();
  try {
    p.w.TKSProduct90d.load(true);
    p.answer(0, report([sampleRow('SP1')], { totalRows: 120, page: 1 }));
    await settle();
    p.$('product90dNextPage').click();
    assert.equal(p.params(1).get('page'), '2');
    p.answer(1, report([sampleRow('SP51')], { totalRows: 120, page: 2 }));
    await settle();
    const th = p.w.document.querySelector('th[data-column-key="revenue_1_90d"]');
    th.querySelector('.sort-button').click();
    assert.deepEqual([p.params(2).get('sort'), p.params(2).get('dir'), p.params(2).get('page')], ['revenue_1_90d', 'asc', '1']);
    assert.equal(th.getAttribute('aria-sort'), 'ascending');
    assert.equal(th.querySelector('.sort-indicator').textContent, '▼');
    p.answer(2, report([sampleRow('SP1')], { totalRows: 120 }));
    await settle();
    th.querySelector('.sort-button').click();
    assert.equal(p.params(3).get('dir'), 'desc');
    assert.equal(th.querySelector('.sort-indicator').textContent, '▲');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(4).get('sort'), null);
    assert.equal(p.params(4).get('dir'), null);
    assert.equal(th.querySelector('.sort-indicator').textContent, '▲▼');
    const before = p.calls.length;
    p.w.document.querySelector('th[data-column-key="top_customers_1_90d"]').click();
    assert.equal(p.calls.length, before);
  } finally { p.dom.window.close(); }
});

test('nut sap xep bao hanh dong ke tiep; bam phan dem o tieu de cung sap xep; nut Xuat file khoa/mo theo du lieu va mang dung ngu canh', async () => {
  let canExport = true;
  const p = createWidget({ can: key => key !== 'reports.export' || canExport });
  try {
    const exportButton = p.$('product90dExportButton');
    assert.equal(exportButton.disabled, true, 'chua co du lieu -> khoa');
    p.w.TKSProduct90d.load(true);
    assert.equal(exportButton.disabled, true, 'dang tai -> khoa');
    p.answer(0, report([sampleRow('SP1')]));
    await settle();
    assert.equal(exportButton.disabled, false);
    assert.equal(exportButton.hidden, false);
    const th = p.w.document.querySelector('th[data-column-key="revenue_1_30d"]');
    const button = th.querySelector('.sort-button');
    assert.equal(button.title, 'Sắp xếp tăng dần theo T.này – DS');
    assert.equal(button.getAttribute('aria-label'), 'Sắp xếp tăng dần theo cột T.này – DS');
    th.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true })); // bam phan dem cua o (target = th)
    assert.equal(p.params(1).get('sort'), 'revenue_1_30d');
    assert.equal(button.title, 'Sắp xếp giảm dần theo T.này – DS');
    p.answer(1, report([sampleRow('SP1')]));
    await settle();
    button.click();
    assert.equal(button.title, 'Bỏ sắp xếp theo T.này – DS');
    p.answer(2, report([sampleRow('SP1')]));
    await settle();
    // Ngu canh xuat file = tu khoa dang ap dung + nhan cot dang sap xep.
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.TKSProduct90d.exportState())), { tableSearch: { mode: 'normal', query: '' }, tableSort: { label: 'T.này – DS', direction: 'desc' } });
    const opened = [];
    p.w.openExportDialog = key => opened.push(key);
    p.w.TKSProduct90d.openExport();
    assert.deepEqual(opened, ['products.product90d']);
    // Loi / chua nap / tim khong ra -> khoa; khong co quyen xuat -> an.
    p.w.TKSProduct90d.load(true);
    p.answer(3, { error: 'x' }, 500);
    await settle();
    assert.equal(exportButton.disabled, true);
    p.$('product90dRows').querySelector('[data-action="retry"]').click();
    p.answer(4, { available: false, rows: [], totalRows: 0 });
    await settle();
    assert.equal(exportButton.disabled, true);
    canExport = false;
    p.$('product90dPageSize').dispatchEvent(new p.w.Event('change'));
    p.answer(5, report([sampleRow('SP1')]));
    await settle();
    assert.equal(exportButton.hidden, true);
  } finally { p.dom.window.close(); }
});

test('tim kiem: debounce, bo qua khi dang go IME, huy yeu cau cu; phan hoi cu ve muon KHONG ghi de', async () => {
  const p = createWidget();
  try {
    p.w.TKSProduct90d.load(true);
    p.answer(0, report([sampleRow('SP1')]));
    await settle();
    const input = p.$('product90dSearch');
    const type = (value, init) => { input.value = value; input.dispatchEvent(new p.w.InputEvent('input', init || {})); };
    input.dispatchEvent(new p.w.CompositionEvent('compositionstart'));
    type('ố');
    await wait(220);
    assert.equal(p.calls.length, 1, 'dang go IME: chua tim');
    input.value = 'ốc';
    input.dispatchEvent(new p.w.CompositionEvent('compositionend'));
    type('ốc v');
    type('ốc vít');
    await wait(220);
    assert.equal(p.calls.length, 2, 'debounce: chi 1 yeu cau cho chuoi cuoi');
    assert.equal(p.params(1).get('q'), 'ốc vít');
    assert.equal(p.params(1).get('page'), '1');
    // Doi sap xep trong khi tim cu chua ve: yeu cau cu bi huy va phan hoi cu khong duoc ve.
    p.w.document.querySelector('th[data-column-key="qty_1_30d"] .sort-button').click();
    assert.equal(p.calls[1].aborted, true);
    assert.equal(p.params(2).get('q'), 'ốc vít');
    assert.equal(p.params(2).get('sort'), 'qty_1_30d');
    p.answer(2, report([sampleRow('MOI')]));
    await settle();
    p.answer(1, report([sampleRow('CU')]));
    await settle();
    assert.equal(p.texts()[0][0], 'MOI');
    // Khong co ket qua.
    type('khong co');
    await wait(220);
    p.answer(3, report([], { totalRows: 0 }));
    await settle();
    assert.match(p.$('product90dRows').textContent, /Không có mã hàng nào khớp “khong co”/);
    assert.equal(p.$('product90dPagination').hidden, true);
    // Xoa trong: goi lai ngay, khong cho debounce.
    type('');
    assert.equal(p.calls.length, 5);
    assert.equal(p.params(4).get('q'), null);
  } finally { p.dom.window.close(); }
});

test('dang tai lai: giu bang cu nhung danh dau ban; loi -> thong bao + Thu lai (khong ve so 0); chua nap -> thong bao rieng', async () => {
  const p = createWidget();
  try {
    p.w.TKSProduct90d.load(true);
    p.answer(0, report([sampleRow('SP1')]));
    await settle();
    p.$('product90dPageSize').value = '100';
    p.$('product90dPageSize').dispatchEvent(new p.w.Event('change'));
    assert.equal(p.params(1).get('pageSize'), '100');
    assert.equal(p.texts()[0][0], 'SP1', 'bang cu van hien trong luc tai');
    assert.equal(p.$('product90dScroll').getAttribute('aria-busy'), 'true');
    assert.ok(p.$('product90dScroll').classList.contains('is-busy'));
    p.answer(1, { error: 'Lỗi máy chủ nội bộ chi tiết' }, 500);
    await settle();
    const text = p.$('product90dRows').textContent;
    assert.match(text, /Không tải được báo cáo Hàng hóa 90 ngày/);
    assert.doesNotMatch(text, /chi tiết|SP1/);
    assert.equal(p.$('product90dRows').querySelectorAll('td.col-num').length, 0, 'loi khong duoc thanh bang so');
    assert.equal(p.$('product90dPagination').hidden, true);
    assert.equal(p.$('product90dUpdatedAt').textContent, '—');
    assert.equal(p.$('product90dScroll').hasAttribute('aria-busy'), false);
    // Thong bao + nut nam trong khoi dinh mep trai rong bang khung (man hep van thay nut Thu lai).
    assert.ok(p.$('product90dRows').querySelector('.p90-note-inner [data-action="retry"]'));
    p.$('product90dRows').querySelector('[data-action="retry"]').click();
    assert.equal(p.calls.length, 3);
    assert.equal(p.calls[2].url, p.calls[1].url, 'Thu lai chi goi lai dung truy van');
    p.answer(2, { available: false, rows: [], totalRows: 0 });
    await settle();
    assert.match(p.$('product90dRows').textContent, /Chưa nạp báo cáo Hàng hóa 90 ngày/);
    assert.equal(p.$('product90dRows').querySelectorAll('td.col-num').length, 0);
    assert.equal(p.$('tagProduct90dRows').textContent, '—');
    // 403 (thieu quyen tren may chu) hien thong bao cua may chu.
    p.w.TKSProduct90d.load(true);
    p.answer(3, { error: 'Bạn không có quyền xem mục này.' }, 403);
    await settle();
    assert.match(p.$('product90dRows').textContent, /Bạn không có quyền xem mục này/);
  } finally { p.dom.window.close(); }
});

test('trang vuot qua cuoi: dung page may chu tra ve', async () => {
  const p = createWidget();
  try {
    p.w.TKSProduct90d.load(true);
    p.answer(0, report([sampleRow('SP1')], { totalRows: 120, page: 3 }));
    await settle();
    assert.equal(p.$('product90dPageLabel').textContent, 'Trang 3/3');
    assert.equal(p.$('product90dNextPage').disabled, true);
  } finally { p.dom.window.close(); }
});

test('thieu reports.products.sales: an muc, khong goi API', async () => {
  const p = createWidget({ can: k => k === 'reports.products' });
  try {
    await p.w.TKSProduct90d.load(true);
    assert.equal(p.$('product90dSection').hidden, true);
    assert.equal(p.calls.length, 0);
  } finally { p.dom.window.close(); }
});

test('table-controls: an cot -> colspan nhom co lai; an het 6 cot -> nhom bien mat; nhan Cot hien thi co ten ky', async () => {
  const p = createWidget();
  try {
    p.w.TKSProduct90d.load(true);
    p.answer(0, report([sampleRow('SP1')]));
    await settle();
    const table = p.$('product90dTable');
    p.w.TKSTables.refreshAll();
    const stateOf = () => p.w.TKSTables.getState(table);
    assert.equal(stateOf().columns.length, 26);
    assert.equal(stateOf().columns.find(c => c.key === 'qty_1_30d').label, 'T.này – SL');
    p.w.document.querySelector('.tks-columns-button').click();
    const toggle = key => {
      const box = p.w.document.querySelector('.tks-columns-picker input[data-column-key="' + key + '"]');
      box.checked = !box.checked;
      box.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    };
    const group = table.querySelector('th.p90-group[data-period="1_30d"]');
    toggle('qty_1_30d');
    assert.equal(group.colSpan, 5);
    assert.ok(table.querySelector('th[data-column-key="qty_1_30d"]').classList.contains('tks-column-hidden'));
    ['revenue_1_30d', 'avg_price_1_30d', 'customer_count_1_30d', 'invoice_count_1_30d', 'top_customers_1_30d'].forEach(toggle);
    assert.ok(group.classList.contains('tks-column-hidden'));
    assert.equal(table.querySelector('th.p90-group[data-period="1_90d"]').colSpan, 6);
    // Dong du lieu: o cua cot an cung an.
    const index = H.COLUMNS.findIndex(c => c.key === 'qty_1_30d');
    assert.ok(p.$('product90dRows').rows[0].cells[index].classList.contains('tks-column-hidden'));
  } finally { p.dom.window.close(); }
});

// ---------- trang that: phan quyen ----------
function createPage(permissions) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/reports/#products' });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => ({});
  w.Chart = class { static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } }; constructor(c, config) { this.config = config; } destroy() {} };
  w.setInterval = () => 1;
  w.requestAnimationFrame = cb => cb();
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.EventSource = class { addEventListener() {} close() {} };
  w.TKSNav = {
    getPermissions: () => permissions.slice(),
    can: (...keys) => keys.some(k => permissions.includes(k)),
    authGuard: () => Promise.resolve({ vaiTro: 'Kế toán', permissions }),
    handleBranchError: () => false, renderTopSidebar() {}
  };
  const urls = [];
  w.fetch = url => { urls.push(String(url)); return new Promise(() => {}); };
  ['pagination.js', 'table-explorer.js'].forEach(file => w.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8')));
  w.eval(moduleSource);
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim()).forEach(s => w.eval(s));
  return { dom, urls, $: id => w.document.getElementById(id) };
}

test('trang that: chi co Du kien hang ve -> muc 4 an, khong goi /api/product-report/90d', async () => {
  const page = createPage(['reports.products.expected']);
  try {
    await settle();
    assert.equal(page.$('product90dSection').hidden, true);
    assert.equal(page.urls.some(u => u.startsWith('/api/product-report/90d')), false);
    assert.deepEqual(page.urls, ['/api/expected-arrivals']);
  } finally { /* khong close(): MutationObserver cua trang chay sau khi dong cua so se nem loi vo hai */ }
});

test('trang that: reports.products + reports.products.sales -> muc 4 hien va goi API; thieu .sales -> an', async () => {
  const allowed = createPage(['reports.products', 'reports.products.sales']);
  const denied = createPage(['reports.products']);
  try {
    await settle();
    assert.equal(allowed.$('product90dSection').hidden, false);
    assert.ok(allowed.urls.includes('/api/product-report/90d?page=1&pageSize=50'));
    await settle();
    assert.equal(denied.$('product90dSection').hidden, true);
    assert.equal(denied.urls.some(u => u.startsWith('/api/product-report/90d')), false);
  } finally { /* xem ghi chu o test tren */ }
});
