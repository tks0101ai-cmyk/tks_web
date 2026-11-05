'use strict';

// Trang Bao cao tong hop tai du lieu THEO TUNG TAB: GET /api/dashboard?view=<tab>
// (xem server/dashboard/dashboardViews.js) thay vi keo ca 5 tab moi lan. Test nay chay
// trang that trong JSDOM voi fetch gia (dem/dieu khien tung request) de kiem tra:
// chi tai tab can xem, tab khac tai khi mo, gop payload, huy request theo tab, man che
// "Dang tai", cache sessionStorage theo tab.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

function viewOf(url) {
  const match = /[?&]view=([^&]+)/.exec(url);
  return match ? decodeURIComponent(match[1]) : null;
}

function kpi(extra = {}) {
  return {
    totalStock: 120, totalProducts: 4, lowStockCount: 1, totalInventoryValue: 5000,
    totalCustomers: 9, customersWithDebt: 2, totalDebt: 300000, ...extra
  };
}

// Payload moi tab NHU SERVER TRA (xem VIEW_PAYLOAD): Tong quan khong mang khoa `invoices`.
function payloadFor(view, marker = 'A') {
  const filters = label => ({ label });
  switch (view) {
    case 'overview':
      return {
        updatedAt: marker, kpi: kpi(),
        filters: { invoices: filters('30 ngày') },
        overview: { revenueByDay: [], periodRevenue: 0, periodInvoices: 0 }
      };
    case 'invoices':
      return {
        updatedAt: marker, kpi: {}, filters: { invoices: filters('30 ngày') },
        invoices: {
          periodRevenue: 1200000, periodInvoices: 1, periodCancelledInvoices: 0, revenueByDay: [],
          transactionsReport: {
            transactions: [{ code: 'HD-' + marker, time: '21/09 09:08', customer: 'KH A', employee: 'NV B', quantity: 3, quantityKnown: true, revenue: 1200000, discount: 0, paid: 1200000, status: 'Hoàn thành' }],
            topTransactions: [], summary: { quantity: 3, quantityKnown: true, revenue: 1200000, discount: 0, paid: 1200000 }
          }
        }
      };
    case 'debt':
      return {
        updatedAt: marker, kpi: {}, filters: {},
        debtManagement: {
          available: true, sourceSheet: 'Công nợ HN', dataWarnings: [],
          kpi: { totalCurrentDebt: 1, totalOverdueDebt: 0, actionCustomerCount: 0, overdueToSalesRatio: 0 },
          bySale: [], byPaymentSchedule: [], topCurrentDebt: [], topOverdueDebt: [], customers: []
        }
      };
    default:
      throw new Error('view la ' + view);
  }
}

// `respond(url)`: tra payload de tu dong tra loi, hoac undefined de test tu dieu khien (call.resolve).
function createPage({ hash = '', cache = null, respond = url => payloadFor(viewOf(url)), can = () => true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/' + hash });
  if (cache) dom.window.sessionStorage.setItem('tksDashboardCache', JSON.stringify(cache));
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; }
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => callback();
  dom.window.TKSNav = { authGuard: () => new Promise(() => {}), can, handleBranchError: () => false, renderTopSidebar() {} };

  const calls = [];
  dom.window.fetch = (url, options) => {
    if (!String(url).startsWith('/api/dashboard?')) return new Promise(() => {}); // vd /api/product-report
    const call = { url: String(url), view: viewOf(url), signal: options && options.signal, settled: false };
    calls.push(call);
    call.promise = new Promise((resolve, reject) => {
      call.resolve = payload => { call.settled = true; resolve({ ok: true, status: 200, json: async () => payload }); };
      call.fail = status => { call.settled = true; resolve({ ok: false, status, json: async () => ({ error: 'loi' }) }); };
      if (call.signal) {
        call.signal.addEventListener('abort', () => {
          call.settled = true;
          const error = new Error('The operation was aborted.');
          error.name = 'AbortError';
          reject(error);
        });
      }
    });
    if (respond) {
      Promise.resolve().then(() => {
        const payload = respond(call.url);
        if (payload !== undefined && !call.settled) call.resolve(payload);
      });
    }
    return call.promise;
  };

  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(script => script.trim());
  const mainIndex = scripts.reduce((best, script, index) => (script.length > scripts[best].length ? index : best), 0);
  // Cung 1 lan eval de thay `const state` (khong nam tren window).
  scripts[mainIndex] += '\n;window.__dash = { state, viewIsLoaded, buildDashboardQuery, isViewFresh, dashboardRequests, renderView };';
  scripts.forEach(script => dom.window.eval(script));

  const doc = dom.window.document;
  return {
    dom, doc, calls,
    dash: dom.window.__dash,
    text: id => doc.getElementById(id).textContent,
    veilOn: () => doc.getElementById('veil').classList.contains('show'),
    dashboardCalls: () => calls.filter(call => call.view),
    viewsCalled: () => calls.map(call => call.view),
    run: code => dom.window.eval(code)
  };
}

test('khoi dong khong hash: CHI tai tab Tong quan, khong keo 5 tab con lai va khong gui bo loc cua tab khac', async () => {
  const page = createPage();
  await settle();

  assert.equal(page.calls.length, 1);
  const url = page.calls[0].url;
  assert.match(url, /^\/api\/dashboard\?view=overview&days=30&inMode=days&inDays=30$/, 'Tong quan chi gui bo loc Hoa don cho bieu do Xu huong');
  assert.doesNotMatch(url, /prMode|prDays/, 'Tong quan khong con dung bo loc Hang hoa');
  assert.doesNotMatch(url, /prStatus/, 'khong con bo loc trang thai kinh doanh');
  assert.doesNotMatch(url, /puMode|cuMode|orMode|rtMode/, 'khong gui bo loc Nha cung cap/Khach hang/Dat hang/Tra hang');
  assert.equal(page.veilOn(), false, 'man che tat sau khi tai xong');
});

test('mo thang /reports/#invoices: chi tai tab Hoa don (khong tai Tong quan truoc)', async () => {
  const page = createPage({ hash: '#invoices' });
  await settle();

  assert.deepEqual(page.viewsCalled(), ['invoices']);
  assert.match(page.calls[0].url, /inMode=days&inDays=30/);
  assert.doesNotMatch(page.calls[0].url, /prMode|prStatus|cuMode|puMode/);
  assert.match(page.text('endOfDayRows'), /HD-A/);
});

test('bam sang tab chua tai: tai dung tab do roi ve; quay lai tab da tai thi khong goi lai server', async () => {
  const page = createPage();
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview']);

  page.run("switchView('invoices')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'invoices']);
  assert.match(page.text('endOfDayRows'), /HD-A/);

  page.run("switchView('overview')");
  page.run("switchView('invoices')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'invoices'], 'tab con moi (cung bo loc, chua het han) khong tai lai');
});

test('tab chua co du lieu hien man che "Dang tai" toi khi tai xong', async () => {
  const page = createPage({ respond: url => (viewOf(url) === 'overview' ? payloadFor('overview') : undefined) });
  await settle();
  assert.equal(page.veilOn(), false);

  page.run("switchView('invoices')");
  assert.equal(page.veilOn(), true, 'chua co du lieu Hoa don -> hien man che');
  page.calls[1].resolve(payloadFor('invoices'));
  await settle();
  assert.equal(page.veilOn(), false);
  assert.match(page.text('endOfDayRows'), /HD-A/);
});

test('man che chi tat khi TAT CA tab dang tai thu cong da xong (khong tat som khi 2 tab tai cung luc)', async () => {
  const page = createPage({ respond: () => undefined });
  await settle();
  assert.equal(page.veilOn(), true, 'lan tai dau tien chua co du lieu -> man che');

  page.run("switchView('invoices')");
  assert.equal(page.calls.length, 2);
  page.calls[0].resolve(payloadFor('overview'));
  await settle();
  assert.equal(page.veilOn(), true, 'Hoa don van dang tai -> man che phai con');

  page.calls[1].resolve(payloadFor('invoices'));
  await settle();
  assert.equal(page.veilOn(), false);
});

test('doi bo loc tab dang xem chi tai lai tab do, khong keo tab khac', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('invoices')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'invoices']);

  page.run("setTableDateFilter('invoices', '2026-09-01', '2026-09-07')");
  await settle();

  assert.deepEqual(page.viewsCalled(), ['overview', 'invoices', 'invoices']);
  assert.match(page.calls[2].url, /view=invoices&days=30&inMode=range&inFrom=2026-09-01&inTo=2026-09-07/);
});

test('doi bo loc Hoa don lam Tong quan tai lai (chung bo loc Xu huong); mo tab Hang hoa khong goi /api/dashboard', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('invoices')");
  await settle();
  page.run("setTableDateFilter('invoices', '2026-09-01', '2026-09-07')");
  await settle();
  const before = page.calls.length;

  page.run("switchView('overview')");
  await settle();
  assert.equal(page.calls.length, before + 1, 'Tong quan dung bo loc Hoa don cho Xu huong -> tai lai 1 lan');
  assert.match(page.calls[page.calls.length - 1].url, /view=overview.*inFrom=2026-09-01/);

  // Tab Hang hoa khong con goi /api/dashboard (Bao cao hang hoa + Tang truong ma hang co API rieng).
  const afterOverview = page.calls.length;
  page.run("switchView('products')");
  await settle();
  assert.equal(page.calls.length, afterOverview, 'mo tab Hang hoa khong goi /api/dashboard');
  assert.ok(page.calls.every(call => call.view !== 'products'));
});

test('khong con bo loc trang thai kinh doanh: khong co ham setProductStatus va khong tab nao gui prStatus', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('products')");
  await settle();
  assert.equal(page.run('typeof setProductStatus'), 'undefined');
  assert.equal(page.doc.getElementById('productStatusToggle'), null);
  page.calls.forEach(call => assert.doesNotMatch(call.url, /prStatus/));
});

test('tab tu tai lai khi server bao co du lieu moi (dataEpoch tang): tab dang xem ngay, tab khac khi mo', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('invoices')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'invoices']);

  page.dash.state.dataEpoch += 1; // nhu SSE 'dashboard-updated'
  page.run("switchView('overview')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'invoices', 'overview'], 'Tong quan da cu -> tai lai khi mo');
  assert.equal(page.veilOn(), false, 'da co du lieu cu de ve nen khong bat man che');
});

test('du lieu tab qua VIEW_MAX_AGE (5 phut) duoc tai lai khi mo tab, du khong co su kien nao', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('invoices')");
  await settle();
  page.run("switchView('overview')");
  await settle();
  const before = page.calls.length;

  page.dash.state.viewMeta.invoices.at -= 6 * 60 * 1000;
  page.run("switchView('invoices')");
  await settle();
  assert.equal(page.calls.length, before + 1);
  assert.equal(page.calls[before].view, 'invoices');
});

test('moi tab co request rieng: chuyen tab KHONG huy request tab khac; doi bo loc cua chinh tab huy request cu cua no', async () => {
  const page = createPage({ respond: () => undefined });
  await settle();
  page.calls[0].resolve(payloadFor('overview'));
  await settle();

  page.run("switchView('debt')");
  const productsCall = page.calls[1];
  page.run("switchView('invoices')");
  const invoicesCall = page.calls[2];
  assert.equal(productsCall.signal.aborted, false, 'chuyen sang Hoa don khong duoc huy request cua Cong no');
  assert.equal(invoicesCall.signal.aborted, false);

  page.run("setTableDateFilter('invoices', '2026-09-01', '2026-09-07')");
  assert.equal(invoicesCall.signal.aborted, true, 'doi bo loc Hoa don huy request cu cua Hoa don');
  assert.equal(productsCall.signal.aborted, false);
  const newInvoicesCall = page.calls[3];
  assert.match(newInvoicesCall.url, /inFrom=2026-09-01/);

  // Response cua request bi huy (ve tay cham) khong ghi de du lieu.
  newInvoicesCall.resolve(payloadFor('invoices', 'MOI'));
  productsCall.resolve(payloadFor('debt'));
  await settle();
  assert.match(page.text('endOfDayRows'), /HD-MOI/);
  assert.equal(page.veilOn(), false, 'tat ca request da xong/huy -> tat man che');
});

test('tab dang tai cung bo loc khong bi tai trung khi bam vao tab lan nua', async () => {
  const page = createPage({ respond: url => (viewOf(url) === 'overview' ? payloadFor('overview') : undefined) });
  await settle();
  page.run("switchView('invoices')");
  page.run("switchView('overview')");
  page.run("switchView('invoices')");
  await settle();
  assert.equal(page.viewsCalled().filter(view => view === 'invoices').length, 1, 'dang cho response Hoa don -> khong goi them');
});

test('loi tai tab dang xem (chua co du lieu) hien hop loi + thu lai; loi tai tab nen khong hien hop loi', async () => {
  const page = createPage({ respond: url => (viewOf(url) === 'overview' ? payloadFor('overview') : undefined) });
  await settle();

  page.run("switchView('invoices')");
  page.calls[1].fail(500);
  await settle();
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, false, 'tab dang xem chua co du lieu -> hien hop loi');
  assert.equal(page.veilOn(), false, 'loi cung phai tat man che');

  page.run("retryLoadData()");
  assert.equal(page.calls[2].view, 'invoices', 'Thu lai tai dung tab dang xem');
  page.calls[2].resolve(payloadFor('invoices'));
  await settle();
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, true);

  // Tab da chuyen di khi request cu that bai -> khong bat hop loi cho tab dang xem.
  page.run("switchView('debt')");
  const productsCall = page.calls[3];
  page.run("switchView('overview')");
  productsCall.fail(500);
  await settle();
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, true);
});

test('renderView bo qua tab chua tai xong (khong nem loi khi state.data moi co payload tab khac)', async () => {
  const page = createPage();
  await settle();
  assert.equal(page.dash.viewIsLoaded('invoices'), false);
  assert.doesNotThrow(() => page.dash.renderView('invoices'));
  assert.doesNotThrow(() => page.run('toggleTheme()'));
});

test('cache sessionStorage luu theo tab (kem views) va khoi phuc: ve ngay tu cache, van hoi lai server cho tab dang mo', async () => {
  const first = createPage();
  await settle();
  first.run("switchView('invoices')");
  await settle();
  const cache = JSON.parse(first.dom.window.sessionStorage.getItem('tksDashboardCache'));
  assert.deepEqual(Object.keys(cache.views).sort(), ['invoices', 'overview']);
  assert.match(cache.views.overview.sig, /^view=overview&days=30&inMode=days&inDays=30$/);
  assert.equal(cache.data.kpi.totalCustomers, 9);

  const second = createPage({ hash: '#invoices', cache, respond: () => undefined });
  assert.match(second.text('endOfDayRows'), /HD-A/);
  assert.equal(second.veilOn(), false, 'da co du lieu trong cache -> khong bat man che');
  await settle();
  assert.deepEqual(second.viewsCalled(), ['invoices'], 'van hoi lai server cho tab dang mo, khong keo tab khac');
});

test('cache cu (ban day du 6 tab, khong co views) van dung duoc: cac tab du khoa du lieu duoc coi la da tai va tai lai khi mo', async () => {
  const legacy = {
    data: { ...payloadFor('overview'), ...payloadFor('debt'), kpi: { ...kpi() } },
    days: 30,
    filters: { products: { mode: 'days', days: 30 }, invoices: { mode: 'days', days: 30 } },
    productStatus: 'all'
  };
  const page = createPage({ cache: legacy, respond: () => undefined });
  assert.equal(page.dash.viewIsLoaded('overview'), true);
  assert.equal(page.dash.viewIsLoaded('debt'), true);
  assert.equal(page.dash.viewIsLoaded('invoices'), false);

  page.run("switchView('debt')");
  assert.equal(page.calls.filter(call => call.view === 'debt').length, 1, 'cache cu chua co chu ky -> phai hoi lai server');
});

test('sessionStorage day: bo cache cu thay vi giu ban cu hon man hinh', async () => {
  const page = createPage();
  await settle();
  const storage = page.dom.window.sessionStorage;
  assert.ok(storage.getItem('tksDashboardCache'));
  const realSetItem = page.dom.window.Storage.prototype.setItem;
  page.dom.window.Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    page.run("switchView('invoices')");
    await settle();
  } finally {
    page.dom.window.Storage.prototype.setItem = realSetItem;
  }
  assert.equal(storage.getItem('tksDashboardCache'), null);
  assert.match(page.text('endOfDayRows'), /HD-A/);
});

test('sau khi nap quyen: hash tro toi tab khong duoc xem -> van tai tab dang mo (khong bi trang)', async () => {
  let allowed = [];
  const page = createPage({
    hash: '#debt',
    can: feature => allowed.includes(feature) // luc khoi dong quyen chua nap -> false het
  });
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview'], 'khong tai tab theo hash khi chua co quyen');

  allowed = ['reports.overview', 'reports.invoices']; // tai khoan khong co reports.debt
  page.run('applyReportViewPermissions()');
  await settle();

  assert.deepEqual(page.viewsCalled(), ['overview'], 'giu tab duoc phep, khong tai lap lai du lieu da co');
});

test('tai khoan chi co quyen Hoa don: tab dau tien duoc phep duoc tai (khong tai lai tab khong duoc xem)', async () => {
  let allowed = [];
  const page = createPage({ can: feature => allowed.includes(feature) });
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview']);

  allowed = ['reports.invoices'];
  page.run('applyReportViewPermissions()');
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'invoices']);
  assert.match(page.text('endOfDayRows'), /HD-A/);
});

test('payload rong cua tab khong duoc xem (server tra {filters:{}, kpi:{}}) khong lam sap trang', async () => {
  const page = createPage({ respond: () => ({ filters: {}, kpi: {} }) });
  await settle();
  assert.equal(page.veilOn(), false);
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, true);
  assert.doesNotThrow(() => page.dash.renderView('overview'));
});

test('hop bao loi cua tab truoc bien mat khi chuyen sang tab khac (khong con hien "Khong the tai du lieu" tren tab da co du lieu)', async () => {
  const page = createPage({ respond: url => (viewOf(url) === 'overview' ? payloadFor('overview') : undefined) });
  await settle();

  page.run("switchView('invoices')");
  page.calls[1].fail(500);
  await settle();
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, false);

  page.run("switchView('overview')");
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, true, 'Tong quan da co du lieu -> khong hien loi cua tab Nha cung cap');
});

test('SSE mo xong trong luc lan tai dau con dang bay khong goi them lan nua (khong huy request dang bay)', async () => {
  const page = createPage({ respond: () => undefined });
  await settle();
  assert.equal(page.calls.length, 1);
  assert.ok(page.dash.state.lastFetchAt > 0, 'moc "vua tai" tinh tu luc bat dau goi');
  assert.equal(page.calls[0].signal.aborted, false);
});
