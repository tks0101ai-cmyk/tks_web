'use strict';

// Tab "Bao cao kinh doanh" (/reports/#business): 3 muc Tang truong Sale / khach hang / ma hang,
// API rieng /api/business-report (khong qua /api/dashboard), loc khach, panel chi tiet co bieu do cot,
// nut "Xuat file" (hop thoai chon truong dung chung, nut Excel/HTML) theo reports.export,
// nut "Tinh lai thang" theo reports.business.refreeze.
// Payload gia lay tu service that (businessReportService + testFixtures) de khop hop dong API.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const svc = require('../../businessReport/businessReportService');
const { serviceSnapshot } = require('../../businessReport/testFixtures');
const { exportFieldsFor, filterRows } = require('../../businessReport/businessReportExport');

const BUILDERS = { sales: svc.buildSaleReport, customers: svc.buildCustomerReport, products: svc.buildProductReport };

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };

function createPage({ can = () => true, notReady = false, hash = '#business', customerRows, saveLevel } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/reports/' + hash });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  const charts = [];
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; this.destroyed = false; charts.push(this); }
    destroy() { this.destroyed = true; }
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = cb => cb();
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.URL.createObjectURL = () => 'blob:test';
  dom.window.URL.revokeObjectURL = () => {};
  const downloads = [];
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.getAttribute('download')); };
  dom.window.TKSNav = { authGuard: () => new Promise(() => {}), can, handleBranchError: () => false, renderTopSidebar() {} };

  const urls = [];
  const snap = serviceSnapshot();
  dom.window.fetch = (url, opts) => {
    const href = String(url);
    urls.push({ href, opts });
    const ok = body => Promise.resolve({ ok: true, status: 200, json: async () => body });
    if (href.startsWith('/api/business-report/') && notReady && !href.startsWith('/api/business-report/export')) {
      return Promise.resolve({
        ok: false, status: 503,
        json: async () => ({ error: 'Báo cáo kinh doanh chưa sẵn sàng (chưa áp migration 0036).', code: 'BUSINESS_REPORT_NOT_READY' })
      });
    }
    if (href === '/api/business-report/sale-team') {
      const sent = JSON.parse(opts.body);
      return ok({ saleName: sent.saleName, team: sent.teamName || 'Chưa có team' });
    }
    if (href === '/api/business-report/customer-meta') return ok({ customers: {} });
    if (href === '/api/business-report/sales') return ok(svc.buildSaleReport(snap));
    if (href === '/api/business-report/customer-price-level' && saveLevel) return saveLevel(JSON.parse(opts.body));
    if (href === '/api/business-report/customers') { const report = svc.buildCustomerReport(snap); if (customerRows) report.rows = customerRows(report.rows); return ok(report); }
    if (href === '/api/business-report/products') return ok(svc.buildProductReport(snap));
    if (href === '/api/business-report/overview') return ok(svc.buildOverview(snap));
    if (href.startsWith('/api/business-report/detail?kind=sale')) return ok(svc.buildDetail('sale', 'Khang', snap, {}));
    if (href.startsWith('/api/business-report/detail?kind=customer')) {
      const key = decodeURIComponent(href.split('key=')[1]);
      return ok(svc.buildDetail('customer', key, snap, {}));
    }
    // Danh sach truong cua hop thoai Xuat file lay tu ham server that (khop hop dong API).
    if (href.startsWith('/api/business-report/export/fields?')) {
      const params = new URLSearchParams(href.split('?')[1]);
      const kind = params.get('kind');
      const report = BUILDERS[kind](snap);
      return ok(exportFieldsFor(kind, report, filterRows(kind, report.rows, Object.fromEntries(params))));
    }
    if (href.startsWith('/api/business-report/export?')) {
      const params = new URLSearchParams(href.split('?')[1]);
      const fileName = 'TKS_Bao_cao_kinh_doanh_' + params.get('kind') + '.' + params.get('format');
      return Promise.resolve({
        ok: true, status: 200,
        headers: { get: name => (/disposition/i.test(name) ? 'attachment; filename="' + fileName + '"' : null) },
        blob: async () => new dom.window.Blob(['x'])
      });
    }
    return new Promise(() => {}); // cac API khac cua trang khong can tra loi trong test nay
  };

  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim())
    .forEach(script => dom.window.eval(script));

  const doc = dom.window.document;
  return { dom, doc, urls, charts, downloads, $: id => doc.getElementById(id), run: code => dom.window.eval(code) };
}

const headerTexts = (page, tbodyId) => [...page.$(tbodyId).closest('table').querySelectorAll('thead th')]
  .map(th => th.textContent.replace(/[↕▲▼]/g, '').trim());
const rowsOf = (page, tbodyId) => [...page.$(tbodyId).querySelectorAll('tr.doc-row')];
const rowById = (page, tbodyId, id) => rowsOf(page, tbodyId).find(tr => tr.dataset.tableItemId === id);
const businessUrls = page => page.urls.map(u => u.href).filter(h => h.startsWith('/api/business-report/'));

test('sub-nav co tab "Khách hàng" (thay tab Khach hang cu) va #view-business co 4 muc (1 = Bao cao doanh thu theo khach, chuyen tu Tong quan; Tang truong ma hang da chuyen sang tab Hang hoa)', () => {
  const page = createPage();
  const btn = page.doc.querySelector('.report-subnav-item[data-view="business"]');
  assert.ok(btn, 'thieu nut sub-nav business');
  assert.match(btn.textContent, /Khách hàng/);
  assert.equal(page.doc.querySelectorAll('.report-subnav-item[data-view="customers"]').length, 0, 'tab Khach hang cu da go');
  const view = page.$('view-business');
  assert.ok(view, 'thieu #view-business');
  assert.equal(view.querySelector('.view-title').textContent.trim(), 'Khách hàng');
  const sectionTitles = [...view.querySelectorAll(':scope > section.section > .section-head h2')]
    .map(h => h.firstChild.textContent.trim());
  assert.deepEqual(sectionTitles, ['Báo cáo doanh thu theo khách', 'Chỉ số tổng quát', 'Tăng trưởng Sale', 'Tăng trưởng khách hàng']);
  assert.equal(view.querySelector('#businessProductsRows'), null, 'Tang truong ma hang khong con trong tab Khach hang');
  const steps = [...view.querySelectorAll(':scope > section.section > .section-head > .section-step')].map(s => s.textContent.trim());
  assert.deepEqual(steps, ['1', '2', '3', '4']);
  const firstSection = view.querySelector(':scope > section.section');
  assert.ok(firstSection.querySelector('#cpCustomerSearchInput'), 'o tim khach nam o dau tab Khach hang');
  assert.equal(page.$('view-overview').querySelector('#cpCustomerSearchInput'), null, 'Tong quan khong con o tim khach');
});

test('sidebar dung chung co muc Khách hàng (reports.business), khong con reports.customers', () => {
  const nav = fs.readFileSync(path.join(publicDir, 'shared', 'shared-nav.js'), 'utf8');
  assert.match(nav, /feature: 'reports\.business', view: 'business', label: 'Khách hàng'/);
  assert.doesNotMatch(nav, /reports\.customers/);
});

test('tab Hang hoa: Bao cao hang hoa (muc 1) + Du kien hang ve (muc 2) + Tang truong ma hang (muc 3) nam trong #view-products', () => {
  const page = createPage();
  const view = page.$('view-products');
  assert.ok(view, 'thieu #view-products');
  assert.equal(view.querySelector('.view-title').textContent.trim(), 'Hàng hóa');
  const titles = [...view.querySelectorAll('.section-head h2')].map(h => h.textContent.replace(/s+/g, ' ').trim());
  assert.match(titles[0], /^Báo cáo hàng hóa/);
  assert.match(titles[1], /^Dự kiến hàng về/);
  assert.match(titles[2], /^Tăng trưởng mã hàng/);
  assert.deepEqual([...view.querySelectorAll('.section-step')].map(s => s.textContent.trim()), ['1', '2', '3']);
  assert.ok(view.querySelector('#productReportRows'), 'Bao cao hang hoa da chuyen tu Tong quan sang Hang hoa');
  assert.equal(page.$('view-overview').querySelector('#productReportRows'), null, 'Tong quan khong con Bao cao hang hoa');
  assert.ok(view.querySelector('#businessProductsRows'), 'Tang truong ma hang da chuyen tu Khach hang sang Hang hoa');
});

test('tab Hang hoa: chi goi API /api/business-report/products (khong goi /api/dashboard), muc Tang truong ma hang hien khi co reports.products.growth', async () => {
  const page = createPage({ hash: '#products' });
  page.run("switchView('products')");
  await settle();
  assert.deepEqual(businessUrls(page), ['/api/business-report/products']);
  assert.equal(page.urls.some(u => u.href.startsWith('/api/dashboard?view=products')), false);
  assert.equal(page.$('productGrowthSection').hidden, false);
  assert.deepEqual(cardsOf(page, 'businessProductsKpis').map(c => c[0]), ['Tăng trưởng', 'TB 4 tháng', 'Doanh số tháng này (đến 06/10)']);
  assert.ok(rowsOf(page, 'businessProductsRows').length > 0);
});

test('tab Hang hoa: thieu reports.products.growth thi an muc Tang truong ma hang va khong goi API', async () => {
  const page = createPage({ can: k => k !== 'reports.products.growth', hash: '#products' });
  page.run("switchView('products')");
  await settle();
  assert.deepEqual(businessUrls(page), []);
  assert.equal(page.$('productGrowthSection').hidden, true);
});

test('quyen Tang truong doc lap: thieu quyen Khach hang van tai duoc muc ma hang', async () => {
  const page = createPage({ can: k => k === 'reports.products.growth', hash: '#products' });
  page.run("switchView('products')");
  await settle();
  assert.deepEqual(businessUrls(page), ['/api/business-report/products']);
  assert.equal(page.$('productGrowthSection').hidden, false);
});

test('mo tab: goi 3 API bao cao (sales, customers, overview) + customer-meta (co reports.business.customerNotes), KHONG goi /api/dashboard?view=business', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  const called = businessUrls(page);
  assert.deepEqual(called.slice().sort(), ['/api/business-report/customer-meta', '/api/business-report/customers', '/api/business-report/overview', '/api/business-report/sales']);
  assert.equal(page.urls.some(u => u.href.startsWith('/api/dashboard?view=business')), false, 'khong goi /api/dashboard cho tab business');
  assert.equal(page.$('view-business').classList.contains('active'), true);
});

test('bang Sale: cot co dinh + TB 4 thang + Tang truong + hom nay + cac thang giam dan; tang truong %', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  assert.deepEqual(headerTexts(page, 'businessSalesRows'),
    ['Sale', 'Team', 'SL Khách', 'TB 4 tháng', 'Tăng trưởng', '06/10/2026', 'T9/26', 'T8/26', 'T7/26']);
  const khang = rowById(page, 'businessSalesRows', 'Khang');
  assert.ok(khang, 'co dong Khang');
  assert.equal(khang.cells[1].querySelector('select').value, 'Team Khang'); // Quan ly: dropdown doi team
  assert.equal(khang.cells[4].textContent.trim(), '100%');
  const ungrouped = rowById(page, 'businessSalesRows', 'Chưa phân nhóm');
  assert.ok(ungrouped, 'co dong Chua phan nhom');
  assert.equal(ungrouped.cells[1].textContent.trim(), 'Chưa có team');
  assert.equal(ungrouped.cells[4].textContent.trim(), '—');
  // Moi <th> sinh dong deu co width px (bang fixed-table).
  page.$('businessSalesRows').closest('table').querySelectorAll('thead th')
    .forEach(th => assert.match(th.getAttribute('style') || '', /width:\s*\d+px/));
});

const cardsOf = (page, id) => [...page.$(id).querySelectorAll('.kpi-card')]
  .map(c => [c.querySelector('.eyebrow').textContent.trim(), c.querySelector('.value').textContent.trim()]);
const fire = (page, el) => el.dispatchEvent(new page.dom.window.Event('change'));

test('muc 1 Chi so tong quat: 6 the (tang truong, TB 4 thang, doanh so thang nay, SL sale/khach/ma hoat dong)', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  const cards = cardsOf(page, 'businessOverviewKpis');
  assert.deepEqual(cards.map(c => c[0]), ['Tăng trưởng', 'TB 4 tháng', 'Doanh số tháng này (đến 06/10)', 'SL Sale', 'SL Khách hoạt động', 'SL Mã hoạt động']);
  assert.deepEqual(cards.slice(3).map(c => c[1]), ['1', '3', '1']);
  assert.equal(cards[2][1], page.run('fmtMoney(160)'));
});

test('moi bang chi co hang 3 chi so Tang truong / TB 4 thang / Doanh so thang nay (khong con the tong quan cu)', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  page.run("switchView('products')");
  await settle();
  for (const id of ['businessSalesKpis', 'businessCustomersKpis', 'businessProductsKpis']) {
    assert.deepEqual(cardsOf(page, id).map(c => c[0]), ['Tăng trưởng', 'TB 4 tháng', 'Doanh số tháng này (đến 06/10)'], id);
  }
});

test('loc team o bang Sale: dong, the 3 chi so va tag doi theo; "Tat ca team" tra lai het', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  const team = page.$('businessSalesTeam');
  assert.deepEqual([...team.options].map(o => o.value), ['', 'Chưa có team', 'Team Khang', 'Team Trinh']);
  const all = cardsOf(page, 'businessSalesKpis');
  const ids = () => rowsOf(page, 'businessSalesRows').map(tr => tr.dataset.tableItemId);
  assert.equal(ids().length, 3);
  team.value = 'Team Khang';
  fire(page, team);
  assert.deepEqual(ids(), ['Khang']);
  assert.equal(page.$('tagBusinessSales').textContent.trim(), '1');
  const khangRow = page.run("businessFilteredSales()")[0];
  assert.deepEqual(cardsOf(page, 'businessSalesKpis'), [
    ['Tăng trưởng', '100%'], ['TB 4 tháng', page.run('fmtMoney(' + khangRow.avg4 + ')')], ['Doanh số tháng này (đến 06/10)', page.run('fmtMoney(100)')]]);
  team.value = '';
  fire(page, team);
  assert.equal(ids().length, 3);
  assert.deepEqual(cardsOf(page, 'businessSalesKpis'), all);
});

test('tang truong cua tap da loc = tong quy doi / tong thang truoc (khong phai trung binh %); thang truoc = 0 thi "—"', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  const rows = [{ prev: 100, normalized: 300, avg4: 10, current: 50 }, { prev: 300, normalized: 100, avg4: 20, current: 20 }];
  const cards = page.run('businessSummaryCards(' + JSON.stringify(rows) + ', { today: "2026-10-06" })');
  assert.equal(cards[0].value, '100%', '(300+100)/(100+300), khong phai (300%+33%)/2');
  const none = page.run('businessSummaryCards([{ prev: 0, normalized: 5, avg4: 1, current: 1 }], { today: "2026-10-06" })');
  assert.equal(none[0].value, '—');
});

test('o tim kiem cung doi hang 3 chi so cua bang', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  const before = cardsOf(page, 'businessCustomersKpis');
  const input = page.doc.querySelector('[data-table-search="businessCustomers"] input[type="search"], [data-table-search="businessCustomers"] input');
  assert.ok(input, 'co o tim kiem bang khach');
  input.value = 'anh';
  input.dispatchEvent(new page.dom.window.Event('input'));
  await settle();
  const after = cardsOf(page, 'businessCustomersKpis');
  assert.notDeepEqual(after, before);
  assert.equal(page.$('tagBusinessCustomers').textContent.trim(), '1');
  assert.equal(after[2][1], page.run('fmtMoney(0)'), 'Anh B khong co doanh so thang nay');
});

test('bang khach: an khach khong hoat dong mac dinh, cong tac hien lai, loc theo sale, cot Level gia', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  const ids = () => rowsOf(page, 'businessCustomersRows').map(tr => tr.dataset.tableItemId);
  assert.equal(ids().includes('cũ'), false, 'khach cu khong hoat dong bi an mac dinh');
  assert.equal(ids().length, 3);
  assert.equal(page.doc.getElementById('businessCustomersBranch'), null, 'khong con bo loc co so');

  const inactive = page.$('businessCustomersInactive');
  inactive.checked = true;
  inactive.dispatchEvent(new page.dom.window.Event('change'));
  assert.equal(ids().includes('cũ'), true, 'tick cong tac thi khach cu hien');
  inactive.checked = false;
  inactive.dispatchEvent(new page.dom.window.Event('change'));

  const sale = page.$('businessCustomersSale');
  assert.ok([...sale.options].some(o => o.value === 'Khang'), 'dropdown sale co Khang');
  sale.value = 'Khang';
  sale.dispatchEvent(new page.dom.window.Event('change'));
  assert.deepEqual(ids().sort(), ['anh b', 'chị a']);
  assert.deepEqual(page.run('businessFilteredCustomers().map(r => r.saleName)'), ['Khang', 'Khang']);

  const headers = headerTexts(page, 'businessCustomersRows');
  assert.deepEqual(headers.slice(0, 5), ['Tên khách', 'Sale', 'Level giá', 'Ghi chú', 'Tiếp khách lần cuối']);
  const chiA = rowById(page, 'businessCustomersRows', 'chị a');
  assert.equal(chiA.cells[2].textContent.trim(), 'Level 2');
});

test('bam dong Khang: mo panel chi tiet co the tong quan, bieu do cot theo thang va bang khach', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  assert.equal(page.$('docModalBackdrop').hidden, true);
  rowById(page, 'businessSalesRows', 'Khang').click();
  await settle();

  assert.ok(businessUrls(page).includes('/api/business-report/detail?kind=sale&key=Khang'));
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.match(page.$('docModalTitle').textContent, /Khang/);
  const summary = page.$('docModalBody').querySelector('.business-summary');
  assert.ok(summary, 'co khoi .business-summary');
  assert.ok([...summary.querySelectorAll('.dp-stat-label')].some(e => e.textContent.trim() === 'TB 4 tháng'));

  const bars = page.charts.filter(c => c.config.type === 'bar' && !c.destroyed);
  assert.equal(bars.length, 1);
  assert.deepEqual(bars[0].config.data.labels, ['T7/26', 'T8/26', 'T9/26', 'T10/26*']);
  assert.deepEqual(bars[0].config.data.datasets[0].data, [0, 300, 500, 100]);

  const customerRows = [...page.$('docModalBody').querySelectorAll('tbody tr')];
  assert.equal(customerRows.length, 2, 'bang khach cua sale Khang');
  assert.match(page.$('docModalBody').textContent, /Chị A/);

  page.run('closeDocumentDetail()');
  assert.equal(page.charts.filter(c => c.config.type === 'bar' && !c.destroyed).length, 0, 'dong panel huy bieu do');
});

test('panel khach: tieu de la ten khach (khong phai ten sale), ca khi mo tu bang lan khi di tu panel Sale', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();

  rowById(page, 'businessCustomersRows', 'chị a').click();
  await settle();
  assert.ok(businessUrls(page).includes('/api/business-report/detail?kind=customer&key=' + encodeURIComponent('chị a')));
  const title = page.$('docModalTitle').textContent;
  assert.match(title, /Khách hàng · Chị A/);
  assert.doesNotMatch(title, /Khang/);
  page.run('closeDocumentDetail()');

  rowById(page, 'businessSalesRows', 'Khang').click();
  await settle();
  const drill = [...page.$('docModalBody').querySelectorAll('tr.business-detail-customer')].find(tr => tr.dataset.key === 'chị a');
  assert.ok(drill, 'panel Sale co dong khach chị a');
  drill.click();
  await settle();
  const drillTitle = page.$('docModalTitle').textContent;
  assert.match(drillTitle, /Khách hàng · Chị A/);
  assert.doesNotMatch(drillTitle, /Khang/);
});

test('quyen: khong co reports.business.refreeze thi an nut Tinh lai thang; khong co reports.export thi an nut xuat', async () => {
  const noRefreeze = createPage({ can: k => k !== 'reports.business.refreeze' });
  noRefreeze.run("switchView('business')");
  await settle();
  assert.equal(noRefreeze.$('businessRefreezeBtn').hidden, true);
  noRefreeze.doc.querySelectorAll('.business-export').forEach(el => assert.equal(el.hidden, false));

  const manager = createPage();
  manager.run("switchView('business')");
  await settle();
  assert.equal(manager.$('businessRefreezeBtn').hidden, false);

  const noExport = createPage({ can: k => k !== 'reports.export' });
  noExport.run("switchView('business')");
  await settle();
  const exportBoxes = [...noExport.doc.querySelectorAll('.business-export')];
  assert.equal(exportBoxes.length, 3);
  exportBoxes.forEach(el => assert.equal(el.hidden, true));
  // Khong co quyen xuat thi goi truc tiep cung khong mo hop thoai, khong goi API.
  noExport.run("openBusinessExportDialog('sales')");
  await settle();
  assert.equal(noExport.$('exportModalBackdrop').hidden, true);
  assert.equal(businessUrls(noExport).some(h => h.startsWith('/api/business-report/export')), false);
});

test('Tinh lai thang khong phai nut xuat: applyExportPermission khong an nham khi thieu reports.export', async () => {
  const page = createPage({ can: k => k !== 'reports.export' });
  page.run("switchView('business')");
  await settle();
  page.run('applyExportPermission()');
  assert.equal(page.$('businessRefreezeBtn').hidden, false);
  // Nut xuat that van bi an.
  page.doc.querySelectorAll('.business-export .export-button').forEach(btn => assert.equal(btn.hidden, true));
});

const exportUrls = page => businessUrls(page).filter(h => h.startsWith('/api/business-report/export?'));
const fieldsUrls = page => businessUrls(page).filter(h => h.startsWith('/api/business-report/export/fields?'));
const paramsOf = href => new URLSearchParams(href.split('?')[1]);
const fieldInputs = page => [...page.$('exportFields').querySelectorAll('input[type="checkbox"]')];
// runScripts 'outside-only' khong chay onclick inline: mo phong click bang eval thuoc tinh onclick (nut disabled thi bo qua).
const clickInline = (page, el) => { if (!el.disabled) page.run(el.getAttribute('onclick')); };

test('moi bang chi co 1 nut "Xuất file" (cung kieu cac bang khac), khong con nut Xuat Excel/Xuat HTML rieng', () => {
  const page = createPage();
  ['sales', 'customers', 'products'].forEach(kind => {
    const box = page.doc.querySelector('.business-export[data-kind="' + kind + '"]');
    const buttons = [...box.querySelectorAll('button')];
    assert.equal(buttons.length, 1, kind);
    assert.equal(buttons[0].textContent.trim(), 'Xuất file');
    assert.ok(buttons[0].classList.contains('export-button'));
    assert.ok(buttons[0].querySelector('svg'), 'co icon tai xuong nhu cac bang khac');
    assert.equal(buttons[0].getAttribute('onclick'), "openBusinessExportDialog('" + kind + "')");
  });
  const viewText = [...page.$('view-business').querySelectorAll('button')].map(b => b.textContent.trim());
  assert.equal(viewText.includes('Xuất Excel'), false);
  assert.equal(viewText.includes('Xuất HTML'), false);
});

test('bam Xuat file bang Khach: mo hop thoai chung giua man hinh, chon truong mac dinh het, gui bo loc dang ap', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  page.$('businessCustomersInactive').checked = true;
  page.$('businessCustomersSale').value = 'Khang';
  clickInline(page, page.doc.querySelector('.business-export[data-kind="customers"] button'));
  await settle();

  assert.equal(page.$('exportModalBackdrop').hidden, false);
  assert.match(page.$('exportModalTitle').textContent, /Xuất file · .*Khách hàng/);
  const fieldsParams = paramsOf(fieldsUrls(page)[0]);
  assert.equal(fieldsParams.get('kind'), 'customers');
  assert.equal(fieldsParams.get('inactive'), '1');
  assert.equal(fieldsParams.get('sale'), 'Khang');
  const inputs = fieldInputs(page);
  assert.ok(inputs.length >= 7);
  assert.ok(inputs.every(i => i.checked), 'mac dinh chon het');
  assert.deepEqual(inputs.slice(0, 3).map(i => i.closest('label').textContent.trim()), ['Tên khách', 'Sale', 'Level giá']);
  assert.equal(page.$('exportConfirmButton').hidden, false);
  assert.equal(page.$('exportHtmlButton').hidden, false);

  // Bo chon cot Level gia roi xuat Excel: URL chi con cac cot con lai + giu bo loc.
  const level = inputs.find(i => i.value === 'priceLevel');
  level.checked = false;
  clickInline(page, page.$('exportConfirmButton'));
  await settle();
  assert.equal(exportUrls(page).length, 1);
  const p = paramsOf(exportUrls(page)[0]);
  assert.equal(p.get('kind'), 'customers');
  assert.equal(p.get('format'), 'xlsx');
  assert.equal(p.get('inactive'), '1');
  assert.equal(p.get('sale'), 'Khang');
  const columns = p.get('columns').split(',');
  assert.deepEqual(columns, inputs.filter(i => i.value !== 'priceLevel').map(i => i.value));
  assert.equal(columns.includes('priceLevel'), false);
  assert.deepEqual(page.downloads, ['TKS_Bao_cao_kinh_doanh_customers.xlsx']);
  assert.equal(page.$('exportModalBackdrop').hidden, true, 'tai xong thi dong hop thoai');
});

test('Xuat HTML tu hop thoai bang Sale: format=html, chi cot da chon, khong gui inactive', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  page.run("openBusinessExportDialog('sales')");
  await settle();
  const inputs = fieldInputs(page);
  inputs.forEach(i => { i.checked = ['saleName', 'current'].includes(i.value); });
  clickInline(page, page.$('exportHtmlButton'));
  await settle();
  const p = paramsOf(exportUrls(page)[0]);
  assert.equal(p.get('kind'), 'sales');
  assert.equal(p.get('format'), 'html');
  assert.equal(p.get('columns'), 'saleName,current');
  assert.equal(p.has('inactive'), false);
  assert.deepEqual(page.downloads, ['TKS_Bao_cao_kinh_doanh_sales.html']);
});

test('hop thoai chung van dung API /api/export cho bang khac sau khi da xuat bang kinh doanh', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  page.run("openBusinessExportDialog('products')");
  await settle();
  page.run('closeExportDialog()');
  page.run("openExportDialog('overview.transactions')");
  await settle();
  const last = page.urls[page.urls.length - 1];
  assert.equal(last.href, '/api/export/fields');
  assert.equal(last.opts.method, 'POST');
  page.run('closeExportDialog()');
});

test('API 503 BUSINESS_REPORT_NOT_READY: bang hien "Đang dựng dữ liệu tháng cũ…"', async () => {
  const page = createPage({ notReady: true });
  page.run("switchView('business')");
  await settle();
  page.run("switchView('products')");
  await settle();
  ['businessSalesRows', 'businessCustomersRows', 'businessProductsRows'].forEach(id => {
    assert.match(page.$(id).textContent, /Đang dựng dữ liệu tháng cũ…/);
  });
});

test('ham tang truong: >=100% xanh, <100% do, null "—"', () => {
  const page = createPage();
  assert.match(page.run('businessGrowthHtml(100)'), /pill ok[^>]*>100%/);
  assert.match(page.run('businessGrowthHtml(54.6)'), /pill bad[^>]*>55%/);
  assert.match(page.run('businessGrowthHtml(null)'), /—/);
});

test('xuat bang Sale gui team dang loc', async () => {
  const page = createPage();
  page.run("switchView('business')");
  await settle();
  page.$('businessSalesTeam').value = 'Team Khang';
  clickInline(page, page.doc.querySelector('.business-export[data-kind="sales"] button'));
  await settle();
  const fieldsParams = paramsOf(fieldsUrls(page)[0]);
  assert.equal(fieldsParams.get('kind'), 'sales');
  assert.equal(fieldsParams.get('team'), 'Team Khang');
  assert.equal(fieldsParams.get('branch'), null);
});

test('Team trong bang Sale: Quan ly (reports.business.editTeam) thay dropdown, doi team goi PUT roi tai lai; nguoi khac chi thay chu', async () => {
  const viewer = createPage({ can: k => k !== 'reports.business.editTeam' });
  viewer.run("switchView('business')");
  await settle();
  assert.equal(viewer.$('businessSalesRows').querySelectorAll('select.business-team-select').length, 0);
  assert.match(rowById(viewer, 'businessSalesRows', 'Khang').textContent, /Team Khang/);

  const page = createPage();
  page.run("switchView('business')");
  await settle();
  const row = rowById(page, 'businessSalesRows', 'Khang');
  const select = row.querySelector('select.business-team-select');
  assert.ok(select, 'o Team la dropdown');
  assert.equal(select.value, 'Team Khang');
  assert.deepEqual([...select.options].map(o => o.textContent), ['Chưa có team', 'Team Khang', 'Team Trinh', '+ Team mới…']);
  // Bam vao dropdown khong mo hop chi tiet
  select.click();
  await settle();
  assert.equal(page.$('docModalBackdrop').hidden, true);
  const before = businessUrls(page).filter(h => h === '/api/business-report/sales').length;
  select.value = 'Team Trinh';
  select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  await settle();
  const put = page.urls.find(u => u.href === '/api/business-report/sale-team');
  assert.equal(put.opts.method, 'PUT');
  assert.deepEqual(JSON.parse(put.opts.body), { saleName: 'Khang', teamName: 'Team Trinh' });
  assert.equal(businessUrls(page).filter(h => h === '/api/business-report/sales').length, before + 1, 'tai lai bang Sale sau khi luu');
});


const profileRows = rows => rows.map((r, i) => Object.assign({}, r, {
  priceLevel: i === 0 ? 'lớn' : 'vừa', priceLevelVersion: 3, canEditPriceLevel: i === 0,
  salesChannels: i === 0 ? ['san', 'fb_ads'] : [], warehouseScale: i === 0 ? 'small' : 'none'
}));

test('customer profile filters combine before pagination and share export conditions without loading profile', async () => {
  const page = createPage({ customerRows: profileRows });
  page.run("switchView('business')"); await settle();
  const channel = page.$('businessCustomersSalesChannel');
  const scale = page.$('businessCustomersScale');
  assert.ok(channel, 'sales channel filter exists'); assert.ok(scale, 'scale filter exists');
  assert.equal([...channel.options].find(o => o.value === 'san').textContent, 'Bán sàn');
  assert.equal([...scale.options].find(o => o.value === 'small').textContent, 'Nhỏ');
  page.$('businessCustomersInactive').checked = true;
  channel.value = 'fb_ads'; fire(page, channel);
  scale.value = 'small'; fire(page, scale);
  assert.equal(rowsOf(page, 'businessCustomersRows').length, 1);
  const query = new URLSearchParams(page.run("businessExportQuery('customers')"));
  assert.equal(query.get('salesChannel'), 'fb_ads'); assert.equal(query.get('warehouseScale'), 'small');
  scale.value = 'none'; fire(page, scale);
  assert.equal(rowsOf(page, 'businessCustomersRows').length, 0, 'AND filters');
  channel.value = 'none'; fire(page, channel);
  assert.equal(rowsOf(page, 'businessCustomersRows').length, 3, 'empty profiles match none');
  assert.equal(businessUrls(page).some(u => u.includes('customer-profile')), false);
});

test('customer profile filters stay hidden and ignored without detail permission', async () => {
  const page = createPage({ can: k => k !== 'reports.business.customerNotes', customerRows: profileRows });
  page.run("switchView('business')"); await settle();
  for (const id of ['businessCustomersSalesChannel', 'businessCustomersScale']) assert.equal(page.$(id).hidden, true);
  page.$('businessCustomersSalesChannel').value = 'san';
  assert.equal(new URLSearchParams(page.run("businessExportQuery('customers')")).has('salesChannel'), false);
  assert.equal(page.run('businessFilteredCustomers().length'), 3);
});

test('price level dropdown locks, persists version, refreshes options and never opens row details', async () => {
  let resolveSave; let sent;
  const page = createPage({ customerRows: profileRows, saveLevel: body => { sent = body; return new Promise(r => { resolveSave = r; }); } });
  page.run("switchView('business')"); await settle();
  const select = page.doc.querySelector('.business-price-level-select');
  assert.ok(select, 'editable customer has dropdown');
  assert.equal(page.doc.querySelectorAll('.business-price-level-select').length, 1, 'read-only customers have text');
  select.click(); select.dispatchEvent(new page.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(page.$('docModalBackdrop').hidden, true);
  const key = select.closest('tr').dataset.tableItemId;
  select.value = 'vip'; select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  assert.equal(select.disabled, true);
  assert.deepEqual(sent, { key, level: 'vip', version: 3 });
  resolveSave({ ok: true, status: 200, json: async () => ({ priceLevel: 'vip', priceLevelVersion: 4 }) }); await settle();
  const updated = page.doc.querySelector('.business-price-level-select');
  assert.equal(updated.value, 'vip'); assert.equal(updated.disabled, false);
  assert.equal(page.run('businessFilteredCustomers()[0].priceLevelVersion'), 4);
  assert.ok([...page.$('businessCustomersLevel').options].some(o => o.value === 'vip'));
  assert.equal(page.$('docModalBackdrop').hidden, true);
});

test('price level conflict restores the saved choice and reports reload guidance', async () => {
  const page = createPage({ customerRows: profileRows, saveLevel: () => Promise.resolve({ ok: false, status: 409, json: async () => ({ error: 'Dữ liệu đã thay đổi. Vui lòng tải lại.' }) }) });
  page.run("switchView('business')"); await settle();
  const select = page.doc.querySelector('.business-price-level-select'); assert.ok(select);
  const original = select.value;
  select.value = 'vip'; select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true })); await settle();
  assert.equal(select.value, original); assert.equal(select.disabled, false);
  assert.equal(page.run('businessFilteredCustomers()[0].priceLevelVersion'), 3);
  assert.match(page.doc.body.textContent, /Dữ liệu đã thay đổi.*tải lại/);
});
