'use strict';

// Muc 4 "Hang hoa 90 ngay" cua tab Hang hoa (product-customer-growth.js): ham thuan (dinh dang, ba muc mau do/cam/vang, chuoi truy van,
// ngu canh xuat file), cau truc index.html, hanh vi bang (loc/sap xep/phan trang o may chu, chong phan hoi cu, cac trang thai)
// va phan quyen tren trang that.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const modulePath = path.join(publicDir, 'product-customer-growth.js');
const moduleSource = fs.readFileSync(modulePath, 'utf8');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const H = require(modulePath);
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const wait = ms => new Promise(r => setTimeout(r, ms));

// ---------- ham thuan ----------
test('formatMoney: NULL -> "—", 0 -> "0", am giu dau, lam tron so nguyen', () => {
  assert.equal(H.formatMoney(null), '—');
  assert.equal(H.formatMoney(undefined), '—');
  assert.equal(H.formatMoney(''), '—');
  assert.equal(H.formatMoney(0), '0');
  assert.equal(H.formatMoney(-0.2), '0');
  assert.equal(H.formatMoney(26920000), '26,920,000');
  assert.equal(H.formatMoney('-1250.5'), '-1,251');
});

test('formatShare + formatGrowth: 1 chu so le, dau + cho so duong, khong bao gio "-0"', () => {
  assert.equal(H.formatShare(0.4523), '45.2%');
  assert.equal(H.formatShare(0.5), '50%');
  assert.equal(H.formatShare(null), '—');
  assert.equal(H.formatGrowth(-0.625), '-62.5%');
  assert.equal(H.formatGrowth(0.125), '+12.5%');
  assert.equal(H.formatGrowth(0), '0%');
  assert.equal(H.formatGrowth(-0.0004), '0%');
  assert.equal(H.formatGrowth(5), '+500%');
  assert.equal(H.formatGrowth(null), '—');
});

test('formatPeriodRange + formatStamp (gio Viet Nam)', () => {
  assert.equal(H.formatPeriodRange('2026-10-07', '2026-11-05'), '07/10–05/11/2026');
  assert.equal(H.formatPeriodRange('2025-12-15', '2026-01-13'), '15/12/2025–13/01/2026');
  assert.equal(H.formatPeriodRange(null, '2026-01-13'), '');
  assert.equal(H.formatStamp('2026-11-05T19:05:00.000Z'), '02:05 06/11/2026');
  assert.equal(H.formatStamp('khong-phai-ngay'), '');
  assert.equal(H.formatStamp(null), '');
});

function cell(markup) {
  const dom = new JSDOM('<table><tbody><tr></tr></tbody></table>');
  dom.window.document.querySelector('tr').innerHTML = markup;
  return dom.window.document.querySelector('td');
}

test('growthCellHtml: chi hien %, ba muc mau theo lop (lost do, check cam, drop vang) kem title; new -> "Mới"; khong tinh duoc -> "—"; tang khong mau', () => {
  const lost = cell(H.growthCellHtml({ growth: -1, growthState: 'lost' }));
  assert.ok(lost.classList.contains('is-lost'));
  assert.equal(lost.textContent.trim(), '-100%');
  assert.equal(lost.getAttribute('title'), 'Giảm hết 100%');
  const check = cell(H.growthCellHtml({ growth: -0.62, growthState: 'check' }));
  assert.ok(check.classList.contains('is-check'));
  assert.equal(check.textContent.trim(), '-62%');
  assert.equal(check.getAttribute('title'), 'Giảm hơn 50%');
  assert.ok(!check.textContent.includes('Cần check'));
  const drop = cell(H.growthCellHtml({ growth: -0.3, growthState: 'drop' }));
  assert.ok(drop.classList.contains('is-drop'));
  assert.equal(drop.textContent.trim(), '-30%');
  assert.equal(drop.getAttribute('title'), 'Giảm dưới 50%');
  const up = cell(H.growthCellHtml({ growth: 0.4, growthState: 'up' }));
  assert.equal(up.textContent.trim(), '+40%');
  assert.ok(!/is-(lost|check|drop)/.test(up.className));
  assert.equal(up.getAttribute('title'), null);
  assert.equal(cell(H.growthCellHtml({ growth: null, growthState: 'new' })).textContent.trim(), 'Mới');
  assert.equal(cell(H.growthCellHtml({ growth: null, growthState: null })).textContent.trim(), '—');
});

test('rowHtml: 8 o theo thu tu COLUMNS, 0 -> "0", NULL -> "—", khach rong -> "Khách lẻ", ky tu HTML duoc escape', () => {
  const dom = new JSDOM('<table><tbody id="b"></tbody></table>');
  const body = dom.window.document.getElementById('b');
  body.innerHTML = H.rowHtml({
    productCode: 'SP<1>', productName: 'Bình & Ly', customerName: '', revenue: 26920000, revenue1_30d: 16000000,
    revenue31_60d: 0, revenue61_90d: null, share: 0.5, growth: null, growthState: null
  });
  const cells = [...body.rows[0].cells].map(td => td.textContent.trim());
  assert.equal(cells.length, H.COLUMNS.length);
  assert.equal(H.COLUMNS.length, 8);
  assert.ok(cells[0].includes('SP<1>') && cells[0].includes('Bình & Ly'));
  assert.ok(body.innerHTML.includes('SP&lt;1&gt;'));
  assert.equal(cells[1], 'Khách lẻ');
  assert.equal(cells[2], '26,920,000');
  assert.equal(cells[3], '16,000,000');
  assert.equal(cells[4], '0');
  assert.equal(cells[5], '—');
  assert.ok(cells[6].includes('50%'));
  assert.equal(cells[7], '—');
});

test('buildQuery: bo tham so rong; growth=all khong gui; sorts gui dang khoa:chieu; tran pageSize 200', () => {
  assert.equal(H.buildQuery({}), '');
  assert.equal(H.buildQuery({ product: ' binh ', customer: 'Hạnh', growth: 'check', sorts: [{ sort: 'growth', dir: 'asc' }], page: 2, pageSize: 100 }),
    'product=binh&customer=H%E1%BA%A1nh&growth=check&sorts=growth%3Aasc&page=2&pageSize=100');
  assert.equal(H.buildQuery({ growth: 'all', sorts: [{ sort: 'customer_name', dir: 'asc' }, { sort: 'share', dir: 'desc' }], page: 1, pageSize: 500 }),
    'sorts=customer_name%3Aasc%2Cshare%3Adesc&page=1&pageSize=200');
  assert.equal(H.buildQuery({ growth: 'bad', sorts: [] }), '');
  assert.equal(H.buildQuery({ growth: 'lost' }), 'growth=lost');
  assert.equal(H.buildQuery({ sorts: [{ sort: 'khong-co', dir: 'asc' }, { sort: 'revenue', dir: 'up' }] }), '', 'cap sai bi bo');
});

test('nextSorts: them cap -> tang -> giam -> go; toi da 4 cap thi thay cap cuoi; khong sua mang cu; formatSorts; sortAction', () => {
  const customer = { sort: 'customer_name', dir: 'asc' };
  assert.deepEqual(H.nextSorts([], 'growth'), [{ sort: 'growth', dir: 'asc' }]);
  assert.deepEqual(H.nextSorts(undefined, 'growth'), [{ sort: 'growth', dir: 'asc' }]);
  assert.deepEqual(H.nextSorts([customer], 'share'), [customer, { sort: 'share', dir: 'asc' }], 'cot moi cong don vao cuoi');
  const two = [customer, { sort: 'share', dir: 'asc' }];
  assert.deepEqual(H.nextSorts(two, 'share'), [customer, { sort: 'share', dir: 'desc' }]);
  assert.deepEqual(H.nextSorts(two, 'customer_name'), [{ sort: 'customer_name', dir: 'desc' }, { sort: 'share', dir: 'asc' }], 'doi chieu cap dau, giu thu tu');
  assert.deepEqual(H.nextSorts([customer, { sort: 'share', dir: 'desc' }], 'share'), [customer], 'giam dan -> go cap');
  assert.deepEqual(H.nextSorts([customer, { sort: 'share', dir: 'asc' }], 'customer_name').length, 2);
  assert.deepEqual(H.nextSorts([{ sort: 'customer_name', dir: 'desc' }, { sort: 'share', dir: 'asc' }], 'customer_name'), [{ sort: 'share', dir: 'asc' }], 'go cap dau -> cap sau don len');
  assert.equal(H.MAX_SORT_LEVELS, 4);
  const four = [{ sort: 'product_name', dir: 'asc' }, customer, { sort: 'revenue', dir: 'asc' }, { sort: 'share', dir: 'asc' }];
  assert.deepEqual(H.nextSorts(four, 'growth'), [four[0], four[1], four[2], { sort: 'growth', dir: 'asc' }], 'day 4 cap: thay cap cuoi');
  const snapshot = JSON.stringify(two);
  H.nextSorts(two, 'share');
  assert.equal(JSON.stringify(two), snapshot, 'khong sua mang dau vao');
  assert.equal(H.formatSorts([customer, { sort: 'share', dir: 'desc' }]), 'customer_name:asc,share:desc');
  assert.equal(H.formatSorts([]), '');
  assert.equal(H.formatSorts(null), '');
  assert.equal(H.formatSorts([{ sort: 'nope', dir: 'asc' }, { sort: 'growth', dir: 'asc' }]), 'growth:asc');
  assert.equal(H.sortAction('none'), 'Sắp xếp tăng dần');
  assert.equal(H.sortAction('ascending'), 'Sắp xếp giảm dần');
  assert.equal(H.sortAction('descending'), 'Bỏ sắp xếp');
});

test('exportContext: dung bo loc dang ap dung, gui sorts nhieu cap, mac dinh khong gui sap xep', () => {
  assert.deepEqual(H.exportContext({ product: ' binh ', customer: '', growth: 'check', sorts: [{ sort: 'growth', dir: 'asc' }] }),
    { context: { productQuery: 'binh', customerQuery: '', growthGroup: 'check', sorts: 'growth:asc' } });
  assert.deepEqual(H.exportContext({ sorts: [{ sort: 'customer_name', dir: 'asc' }, { sort: 'share', dir: 'desc' }] }),
    { context: { productQuery: '', customerQuery: '', growthGroup: 'all', sorts: 'customer_name:asc,share:desc' } });
  assert.deepEqual(H.exportContext({}), { context: { productQuery: '', customerQuery: '', growthGroup: 'all' } });
  assert.deepEqual(H.exportContext({ growth: 'bad', sorts: [] }), { context: { productQuery: '', customerQuery: '', growthGroup: 'all' } });
  assert.equal(H.exportContext({ growth: 'lost' }).context.growthGroup, 'lost');
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
  assert.equal(section.querySelector('.panel-head h2').firstChild.textContent.trim(), 'Khách hàng theo sản phẩm');
  assert.match(html, /<script src="\/product-customer-growth\.js\?v=\d{8}-\d+"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/product-customer-growth\.css\?v=\d{8}-\d+">/);
  assert.ok(html.indexOf('/shared/table-controls.js') < html.indexOf('/product-customer-growth.js'), 'table-controls phai nap truoc');
  assert.doesNotMatch(html, /product-90d-report\.(js|css)/, 'giao dien cu cua muc 4 da bi go khoi trang');
  assert.doesNotMatch(section.textContent, /Làm mới/);
});

test('tieu de bang: 8 cot khop COLUMNS, nut sap xep, do rong ghi trong thead; bo loc co du 3 dieu khien', () => {
  const table = pageDoc.getElementById('pcgTable');
  assert.equal(table.dataset.tableSort, 'off');
  assert.equal(table.dataset.tableKey, 'dashboard-table-product-customer-growth');
  assert.ok(table.classList.contains('fixed-table'));
  assert.equal(table.tHead.rows.length, 1);
  const ths = [...table.tHead.rows[0].cells];
  assert.deepEqual(ths.map(th => th.dataset.columnKey), H.COLUMNS.map(c => c.key));
  assert.equal(new Set(ths.map(th => th.dataset.columnKey)).size, 8);
  assert.deepEqual(ths.map(th => th.dataset.sort), H.COLUMNS.map(c => c.sort));
  assert.deepEqual(ths.map(th => th.querySelector('.sort-label').textContent), H.COLUMNS.map(c => c.label));
  ths.forEach((th, index) => {
    assert.ok(th.hasAttribute('data-no-sort'), 'trang tu sap xep qua API');
    assert.equal(th.getAttribute('aria-sort'), 'none');
    assert.equal(th.querySelector('.sort-indicator').textContent, '▲▼');
    assert.equal(th.style.width, H.COLUMNS[index].width + 'px');
  });
  assert.deepEqual([...pageDoc.querySelectorAll('#pcgGrowth option')].map(o => [o.value, o.textContent]), H.GROWTH_OPTIONS);
  assert.deepEqual(H.GROWTH_OPTIONS.map(o => o[0]), ['all', 'lost', 'check', 'drop', 'up', 'new']);
  ['pcgProductSearch', 'pcgCustomerSearch', 'pcgGrowth', 'pcgExportButton', 'pcgPageSize'].forEach(id => assert.ok(pageDoc.getElementById(id), id));
  const clear = pageDoc.getElementById('pcgClearSort');
  assert.ok(clear, 'co nut Xoa sap xep');
  assert.equal(clear.hidden, true, 'an khi chua sap xep');
  assert.equal(clear.type, 'button');
  assert.ok(clear.closest('.pcg-filters'));
  assert.match(pageDoc.getElementById('pcgExportButton').getAttribute('onclick'), /openExportDialog\('products\.productCustomerGrowth'\)/);
  assert.ok(pageDoc.getElementById('pcgExportButton').closest('#product90dSection .panel-head-actions'));
});

test('CSS: ba muc mau dung bien mau cua trang (khong ma hex), bang co khung cuon rieng', () => {
  const css = fs.readFileSync(path.join(publicDir, 'product-customer-growth.css'), 'utf8');
  assert.match(css, /\.pcg-table td\.is-lost[^{]*\{[^}]*var\(--red\)/);
  assert.match(css, /\.pcg-table td\.is-check[^{]*\{[^}]*var\(--orange\)/);
  assert.match(css, /\.pcg-table td\.is-drop[^{]*\{[^}]*var\(--yellow\)/);
  assert.doesNotMatch(css, /pcg-flag/);
  assert.match(css, /\.pcg-scroll\s*\{[^}]*overflow:\s*auto/);
  assert.match(css, /\.pcg-table thead \.sort-level\s*\{[^}]*position:\s*absolute/);
  assert.match(css, /\.pcg-clear-sort\[hidden\]\s*\{[^}]*display:\s*none/);
  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/);
});

test('shared.css: --orange va --yellow co o ca khoi Toi lan khoi Sang (moi token xuat hien it nhat 2 lan)', () => {
  const css = fs.readFileSync(path.join(publicDir, 'shared', 'shared.css'), 'utf8');
  ['--orange', '--yellow'].forEach(token => {
    assert.ok((css.match(new RegExp('\\s' + token + ':\\s*#[0-9A-Fa-f]{6}', 'g')) || []).length >= 2, token);
  });
  assert.match(css, /--orange:#FB923C/);
  assert.match(css, /--orange:#C2410C/);
  assert.match(css, /--yellow:#FACC15/);
  assert.match(css, /--yellow:#A16207/);
  // index.html phai bust cache shared.css (server cache ?v= 1 gio) de trinh duyet/edge nhan token moi.
  assert.doesNotMatch(html, /shared\.css\?v=20261028-leave-btn/);
  // Chuoi phien ban doi theo cac dot nang phien ban chung (vd main nang dong loat 20261107-3): chi can ton tai va khac chuoi cu.
  assert.match(html, /<link rel="stylesheet" href="\/shared\/shared\.css\?v=(?!20261028-leave-btn")[\w-]+">/);
});

// ---------- hanh vi bang (DOM toi thieu + table-controls that) ----------
function sectionHtml() {
  const start = html.indexOf('<section class="section" id="product90dSection"');
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
}
function periods() {
  return [
    { key: '1_30d', label: 'T.này', from: '2026-10-07', to: '2026-11-05' },
    { key: '31_60d', label: 'T.trước', from: '2026-09-07', to: '2026-10-06' },
    { key: '61_90d', label: 'T.trước nữa', from: '2026-08-08', to: '2026-09-06' }
  ];
}
function sampleRow(customer, extra) {
  return Object.assign({
    productCode: 'SP1', productName: 'Bình giữ nhiệt', customerName: customer, revenue: 1000, revenue1_30d: 400,
    revenue31_60d: 300, revenue61_90d: 300, share: 0.5, growth: 0.3333, growthState: 'up'
  }, extra);
}
function report(rows, extra) {
  return Object.assign({
    available: true, state: { customerWindowEnd: '2026-11-05', computedAt: '2026-11-05T19:05:00.000Z', version: 3 }, periods: periods(),
    summary: {
      totalRows: rows.length, lostRows: rows.filter(r => r.growthState === 'lost').length,
      checkRows: rows.filter(r => r.growthState === 'check').length
    }, rows,
    page: 1, pageSize: 50, sort: 'revenue', dir: 'desc'
  }, extra);
}

function createWidget({ can = () => true } = {}) {
  const dom = new JSDOM('<!doctype html><body><div class="view active" id="view-products">' + sectionHtml() + '</div></body>',
    { runScripts: 'outside-only', url: 'https://tokosi.example/reports/#products', pretendToBeVisual: true });
  const w = dom.window;
  w.TKSNav = { can };
  const calls = [];
  w.fetch = (url, options) => new Promise((resolve, reject) => {
    if (!String(url).startsWith('/api/product-report/customer-growth')) return; // vd /api/me/table-prefs cua table-controls
    const call = { url: String(url), options, resolve, reject };
    calls.push(call);
    if (options && options.signal) options.signal.addEventListener('abort', () => { call.aborted = true; });
  });
  w.eval(fs.readFileSync(path.join(publicDir, 'shared', 'table-controls.js'), 'utf8'));
  w.eval(moduleSource);
  const $ = id => w.document.getElementById(id);
  const answer = (index, body, status = 200) => calls[index].resolve({ ok: status < 400, status, json: async () => body });
  const params = index => new URL(calls[index].url, 'https://x').searchParams;
  const texts = () => [...$('pcgRows').rows].map(tr => [...tr.cells].map(td => td.textContent.trim()));
  const type = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event('input')); };
  const choose = (id, value) => { $(id).value = value; $(id).dispatchEvent(new w.Event('change')); };
  return { dom, w, $, calls, answer, params, texts, type, choose };
}

test('tai lan dau: goi API mac dinh, ve dong, tieu de ky co khoang ngay, mau theo muc dung o, "Dữ liệu cập nhật lúc" gio VN', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(false);
    assert.equal(p.$('product90dSection').hidden, false);
    assert.equal(p.calls.length, 1);
    assert.equal(p.calls[0].url, '/api/product-report/customer-growth?page=1&pageSize=50');
    assert.match(p.$('pcgRows').textContent, /Đang tải/);
    p.answer(0, report([sampleRow('Khách A', { growth: -1, growthState: 'lost' }), sampleRow('Khách B'), sampleRow('Khách C', { growth: -0.62, growthState: 'check' })]));
    await settle();
    const rows = p.texts();
    assert.equal(rows.length, 3);
    assert.equal(rows[0][1], 'Khách A');
    assert.match(rows[0][7], /^-100%$/);
    assert.equal(p.w.document.querySelectorAll('#pcgRows td.is-lost').length, 1);
    assert.equal(p.w.document.querySelectorAll('#pcgRows td.is-check').length, 1);
    assert.equal(p.$('pcgStatus').textContent, '3 dòng khớp · 1 giảm hết 100% · 1 giảm hơn 50%');
    assert.equal(p.$('pcgRowsTag').textContent, '3 dòng');
    assert.equal(p.$('pcgUpdatedAt').textContent, 'Dữ liệu cập nhật lúc 02:05 06/11/2026');
    const title = key => p.w.document.querySelector('th[data-column-key="' + key + '"] .sort-button').title;
    assert.equal(title('revenue_1_30d'), 'Sắp xếp tăng dần theo T.này (07/10–05/11/2026)');
    assert.equal(title('revenue_61_90d'), 'Sắp xếp tăng dần theo T.trước nữa (08/08–06/09/2026)');
    // Du lieu con moi: mo lai tab khong goi lai API.
    await p.w.TKSProductCustomerGrowth.load(false);
    assert.equal(p.calls.length, 1);
  } finally { p.dom.window.close(); }
});

test('loc: debounce 150ms, bo qua khi dang go IME, doi nhom ve trang 1, giu cac bo loc con lai', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')], { summary: { totalRows: 120, lostRows: 0, checkRows: 0 } }));
    await settle();
    p.$('pcgNextPage').click();
    assert.equal(p.params(1).get('page'), '2');
    p.answer(1, report([sampleRow('Khách B')], { summary: { totalRows: 120, lostRows: 0, checkRows: 0 }, page: 2 }));
    await settle();
    p.type('pcgProductSearch', 'binh');
    assert.equal(p.calls.length, 2, 'debounce: chua goi ngay');
    await wait(220);
    assert.equal(p.calls.length, 3);
    assert.equal(p.params(2).get('product'), 'binh');
    assert.equal(p.params(2).get('page'), '1', 'doi bo loc ve trang 1');
    p.answer(2, report([sampleRow('Khách A')]));
    await settle();
    p.type('pcgCustomerSearch', 'hanh');
    await wait(220);
    assert.equal(p.params(3).get('product'), 'binh');
    assert.equal(p.params(3).get('customer'), 'hanh');
    p.answer(3, report([sampleRow('Khách A')]));
    await settle();
    p.choose('pcgGrowth', 'check');
    assert.equal(p.calls.length, 5);
    assert.equal(p.params(4).get('growth'), 'check');
    assert.equal(p.params(4).get('product'), 'binh');
    assert.equal(p.params(4).get('customer'), 'hanh');
    // Dang go bo go (IME): cho compositionend moi goi.
    p.answer(4, report([sampleRow('Khách A')]));
    await settle();
    const before = p.calls.length;
    p.$('pcgProductSearch').dispatchEvent(new p.w.Event('compositionstart'));
    p.type('pcgProductSearch', 'binh gi');
    await wait(220);
    assert.equal(p.calls.length, before, 'IME dang go khong goi API');
    p.$('pcgProductSearch').dispatchEvent(new p.w.Event('compositionend'));
    await wait(220);
    assert.equal(p.calls.length, before + 1);
    // Nut x xoa o tim va goi lai khong co tham so product.
    p.answer(before, report([sampleRow('Khách A')]));
    await settle();
    p.$('pcgProductClear').click();
    assert.equal(p.params(p.calls.length - 1).get('product'), null);
  } finally { p.dom.window.close(); }
});

test('sap xep o may chu: ▲▼ -> ▼ tang -> ▲ giam -> bo; nut bao hanh dong ke tiep; ve trang 1', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    const th = p.w.document.querySelector('th[data-column-key="growth"]');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(1).get('sorts'), 'growth:asc');
    assert.equal(p.params(1).get('sort'), null, 'khong con gui sort/dir cu');
    assert.equal(p.params(1).get('page'), '1');
    p.answer(1, report([sampleRow('Khách A')], { sort: 'growth', dir: 'asc' }));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'ascending');
    assert.equal(th.querySelector('.sort-indicator').textContent, '▼');
    assert.match(th.querySelector('.sort-button').title, /^Sắp xếp giảm dần theo Tăng trưởng/);
    assert.equal(th.querySelector('.sort-level'), null, 'mot cap thi khong hien so cap');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(2).get('sorts'), 'growth:desc');
    p.answer(2, report([sampleRow('Khách A')], { sort: 'growth', dir: 'desc' }));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'descending');
    th.querySelector('.sort-button').click();
    assert.equal(p.params(3).get('sorts'), null, 'bo sap xep -> thu tu mac dinh cua may chu');
    p.answer(3, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(th.getAttribute('aria-sort'), 'none');
  } finally { p.dom.window.close(); }
});

test('sap xep nhieu cap: bam cot thu hai cong don, so cap tren tieu de, doi chieu, go cap, nut Xoa sap xep', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    const th = key => p.w.document.querySelector('th[data-column-key="' + key + '"]');
    const level = key => { const el = th(key).querySelector('.sort-level'); return el ? el.textContent : null; };
    // Bam, tra loi, doi cap nhat giao dien; tra ve chi so lan goi API vua gui.
    const click = async key => {
      th(key).querySelector('.sort-button').click();
      const index = p.calls.length - 1;
      p.answer(index, report([sampleRow('Khách A')]));
      await settle();
      return index;
    };
    assert.equal(p.$('pcgClearSort').hidden, true);

    let i = await click('customer');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc');
    assert.equal(level('customer'), null, 'mot cap thi khong hien so');
    assert.equal(p.$('pcgClearSort').hidden, false);
    assert.equal(p.$('pcgClearSort').textContent, 'Xóa sắp xếp (1)');

    i = await click('share');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc,share:asc', 'bam cot thu hai = cong don');
    assert.equal(p.params(i).get('page'), '1');
    assert.equal(level('customer'), '1');
    assert.equal(level('share'), '2');
    assert.equal(th('customer').getAttribute('aria-sort'), 'ascending');
    assert.equal(th('share').getAttribute('aria-sort'), 'ascending');
    assert.equal(th('revenue').getAttribute('aria-sort'), 'none');
    assert.equal(th('share').querySelector('.sort-button').title, 'Sắp xếp giảm dần theo % của SP (cấp 2)');
    assert.equal(th('share').querySelector('.sort-button').getAttribute('aria-label'), 'Sắp xếp giảm dần theo cột % của SP (cấp 2)');
    assert.equal(p.$('pcgClearSort').textContent, 'Xóa sắp xếp (2)');

    i = await click('share');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc,share:desc', 'bam lai cot: doi chieu, giu thu tu cap');
    assert.equal(th('share').getAttribute('aria-sort'), 'descending');
    assert.equal(th('share').querySelector('.sort-indicator').textContent, '▲');

    i = await click('share');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc', 'bam lan ba: go cap khoi danh sach');
    assert.equal(level('customer'), null, 'con 1 cap -> an so cap');
    assert.equal(th('share').getAttribute('aria-sort'), 'none');

    i = await click('growth');
    assert.equal(p.params(i).get('sorts'), 'customer_name:asc,growth:asc');
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.TKSProductCustomerGrowth.exportState())),
      { context: { productQuery: '', customerQuery: '', growthGroup: 'all', sorts: 'customer_name:asc,growth:asc' } });

    p.$('pcgClearSort').click();
    i = p.calls.length - 1;
    assert.equal(p.params(i).get('sorts'), null, 'Xoa sap xep -> thu tu mac dinh');
    assert.equal(p.params(i).get('page'), '1');
    p.answer(i, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(p.$('pcgClearSort').hidden, true);
    ['customer', 'growth'].forEach(key => {
      assert.equal(th(key).getAttribute('aria-sort'), 'none', key);
      assert.equal(level(key), null, key);
    });
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.TKSProductCustomerGrowth.exportState())),
      { context: { productQuery: '', customerQuery: '', growthGroup: 'all' } });
  } finally { p.dom.window.close(); }
});

test('reset(): xoa ca danh sach cap sap xep', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    p.w.document.querySelector('th[data-column-key="customer"] .sort-button').click();
    p.answer(1, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(p.$('pcgClearSort').hidden, false);
    p.w.TKSProductCustomerGrowth.reset();
    assert.equal(p.$('pcgClearSort').hidden, true);
    assert.equal(p.w.document.querySelector('th[data-column-key="customer"]').getAttribute('aria-sort'), 'none');
  } finally { p.dom.window.close(); }
});

test('nut Xuat file: khoa/mo theo du lieu, an khi thieu reports.export, exportState mang dung bo loc + sap xep', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    assert.equal(p.$('pcgExportButton').disabled, true, 'khoa khi dang tai');
    p.answer(0, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(p.$('pcgExportButton').disabled, false);
    p.choose('pcgGrowth', 'check');
    p.answer(1, report([sampleRow('Khách A', { growth: -0.9, growthState: 'check' })]));
    await settle();
    p.w.document.querySelector('th[data-column-key="growth"] .sort-button').click();
    // Doi tuong tao trong JSDOM khac realm (prototype) voi Node -> so sanh qua JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(p.w.TKSProductCustomerGrowth.exportState())),
      { context: { productQuery: '', customerQuery: '', growthGroup: 'check', sorts: 'growth:asc' } });
    p.answer(2, report([]));
    await settle();
    assert.equal(p.$('pcgExportButton').disabled, true, 'khong co dong -> khong xuat');
  } finally { p.dom.window.close(); }
  const noExport = createWidget({ can: key => key !== 'reports.export' });
  try {
    noExport.w.TKSProductCustomerGrowth.load(true);
    noExport.answer(0, report([sampleRow('Khách A')]));
    await settle();
    assert.equal(noExport.$('pcgExportButton').hidden, true);
  } finally { noExport.dom.window.close(); }
});

test('trang thai: loi -> thong bao + Thu lai (khong ve so 0); chua co du lieu; khong khop bo loc; phan hoi cu khong ghi de', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, { error: 'Không lấy được' }, 500);
    await settle();
    assert.match(p.$('pcgRows').textContent, /Không tải được báo cáo khách hàng theo sản phẩm/);
    assert.ok(p.$('pcgRows').querySelector('[data-action="retry"]'));
    assert.equal(p.$('pcgRows').textContent.includes('0'), false, 'loi khong duoc thanh bang so 0');
    p.$('pcgRows').querySelector('[data-action="retry"]').click();
    assert.equal(p.calls.length, 2);
    p.answer(1, { available: false, rows: [], summary: { totalRows: 0, lostRows: 0, checkRows: 0 } });
    await settle();
    assert.match(p.$('pcgRows').textContent, /Chưa có dữ liệu kỳ/);
    // Khong khop bo loc.
    p.type('pcgProductSearch', 'zzz');
    await wait(220);
    p.answer(2, report([], { summary: { totalRows: 0, lostRows: 0, checkRows: 0 } }));
    await settle();
    assert.match(p.$('pcgRows').textContent, /Không có dòng nào khớp bộ lọc/);
    // Phan hoi cu ve muon KHONG ghi de truy van moi hon.
    p.type('pcgProductSearch', 'abc');
    await wait(220);
    p.type('pcgProductSearch', 'abcd');
    await wait(220);
    const older = p.calls.length - 2, newer = p.calls.length - 1;
    assert.equal(p.calls[older].aborted, true, 'yeu cau cu bi huy');
    p.answer(newer, report([sampleRow('Khách MỚI')]));
    await settle();
    p.answer(older, report([sampleRow('Khách CŨ')]));
    await settle();
    assert.equal(p.texts()[0][1], 'Khách MỚI');
  } finally { p.dom.window.close(); }
});

test('thieu reports.products.sales: an muc, khong goi API', async () => {
  const p = createWidget({ can: key => key !== 'reports.products.sales' });
  try {
    await p.w.TKSProductCustomerGrowth.load(true);
    assert.equal(p.$('product90dSection').hidden, true);
    assert.equal(p.calls.length, 0);
  } finally { p.dom.window.close(); }
});

test('table-controls: nhan hop "Cot hien thi" dung ten cot, an cot Tang truong khong lam vo bang', async () => {
  const p = createWidget();
  try {
    p.w.TKSProductCustomerGrowth.load(true);
    p.answer(0, report([sampleRow('Khách A', { growth: -0.9, growthState: 'check' })]));
    await settle();
    assert.ok(p.$('pcgTable').classList.contains('tks-controlled-table'));
    const button = p.w.document.querySelector('.tks-columns-button');
    assert.ok(button, 'co nut Cot hien thi');
    button.click();
    const labels = [...p.w.document.querySelectorAll('.tks-columns-list label')].map(l => l.textContent.trim());
    assert.deepEqual(labels, H.COLUMNS.map(c => c.label));
  } finally { p.dom.window.close(); }
});

// ---------- trang that: phan quyen + tai khi mo tab ----------
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

test('trang that: chi co Du kien hang ve -> muc 4 an, khong goi /api/product-report/customer-growth', async () => {
  const page = createPage(['reports.products.expected']);
  try {
    await settle();
    assert.equal(page.$('product90dSection').hidden, true);
    assert.equal(page.urls.some(u => u.startsWith('/api/product-report/customer-growth')), false);
    // Chi Du kien hang ve duoc goi (ke ca khi main doi API nay sang phan trang may chu: ?page=1&pageSize=100).
    assert.equal(page.urls.length, 1);
    assert.match(page.urls[0], /^\/api\/expected-arrivals(\?|$)/);
  } finally { /* khong close(): MutationObserver cua trang chay sau khi dong cua so se nem loi vo hai */ }
});

test('trang that: reports.products + reports.products.sales -> muc 4 hien va goi API; thieu .sales -> an', async () => {
  const allowed = createPage(['reports.products', 'reports.products.sales']);
  const denied = createPage(['reports.products']);
  try {
    await settle();
    assert.equal(allowed.$('product90dSection').hidden, false);
    assert.ok(allowed.urls.includes('/api/product-report/customer-growth?page=1&pageSize=50'));
    await settle();
    assert.equal(denied.$('product90dSection').hidden, true);
    assert.equal(denied.urls.some(u => u.startsWith('/api/product-report/customer-growth')), false);
    assert.equal(denied.urls.some(u => u.startsWith('/api/product-report/90d')), false, 'API cu cua muc 4 khong con duoc goi tu giao dien');
  } finally { /* xem ghi chu o test tren */ }
});
