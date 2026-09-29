'use strict';

// Trang Bao cao tong hop tai du lieu THEO TUNG TAB: GET /api/dashboard?view=<tab>
// (xem server/dashboard/dashboardViews.js) thay vi keo ca 6 tab moi lan. Test nay chay
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
    revenueToday: 1500000, invoicesToday: 3, cancelledToday: 1, totalStock: 120, totalProducts: 4, lowStockCount: 1,
    totalCustomers: 9, customersWithDebt: 2, totalDebt: 300000, ...extra
  };
}

// Payload moi tab NHU SERVER TRA (xem VIEW_PAYLOAD): Tong quan chi mang 2 truong cua `products`.
function payloadFor(view, marker = 'A') {
  const filters = label => ({ label });
  switch (view) {
    case 'overview':
      return {
        updatedAt: marker, kpi: kpi(),
        filters: { overview: filters('30 ngày'), products: filters('30 ngày'), productStatus: 'all' },
        overview: { revenueByDay: [], periodRevenue: 0, periodInvoices: 0 },
        products: {
          childCategorySalesByParent: { 'NHÀ BẾP': [{ name: 'Nồi', qty: 10, revenue: 5000000, productCount: 1 }] },
          availableParentCategories: ['NHÀ BẾP']
        }
      };
    case 'products':
      return {
        updatedAt: marker,
        kpi: { totalProducts: 4, totalStock: 120, inStockCodes: 3, activeProducts: 3, inactiveProducts: 1, lowStockCount: 1, totalInventoryValue: 5000, inventoryValueCategoryCount: 1 },
        filters: { productStatus: 'all', newlyImported: filters('30 ngày'), newProducts: filters('30 ngày') },
        products: {
          newProducts: { label: '30 ngày', count: 0, dateColumnAvailable: true, products: [] },
          topSellingProducts: [], topSellingParentCategories: [], allSellingProducts: [{ code: 'SP-1', name: 'Bán chạy', qty: 2, revenue: 200000 }],
          allSellingParentCategories: [],
          newlyImported: { label: '30 ngày', count: 0, products: [], topByRevenue: [], salesByCategory: [], countByCategory: [], salesRevenue: 0, salesQty: 0 }
        },
        lowStock: [], stockValueByCategory: [], stockByCategory: [],
        allProducts: [{ code: 'SP-1', name: 'Sản phẩm một', stock: 5, reserved: 0, status: 'Đang kinh doanh', cost: 1000, stockValue: 5000, pct: 100 }]
      };
    case 'invoices':
      return {
        updatedAt: marker, kpi: {}, filters: { invoices: filters('30 ngày') },
        invoices: {
          periodRevenue: 1200000, periodInvoices: 1, periodCancelledInvoices: 0, revenueByDay: [],
          periodOrders: [], periodReturns: [], pendingOrdersCount: 0, pendingOrdersTotal: 0, returnsCount: 0, totalReturns: 0,
          transactionsReport: {
            transactions: [{ code: 'HD-' + marker, time: '21/09 09:08', customer: 'KH A', employee: 'NV B', quantity: 3, quantityKnown: true, revenue: 1200000, discount: 0, paid: 1200000, status: 'Hoàn thành' }],
            topTransactions: [], summary: { quantity: 3, quantityKnown: true, revenue: 1200000, discount: 0, paid: 1200000 }
          }
        }
      };
    case 'customers':
      return {
        updatedAt: marker, kpi: { totalCustomers: 9, customersWithDebt: 2, totalDebt: 300000 }, filters: { customers: filters('Tất cả') },
        customers: { topDebt: [], topRevenue: { top15: [], all: [], label: 'Tất cả' } }
      };
    case 'suppliers':
      return {
        updatedAt: marker,
        kpi: { totalSuppliers: 4, suppliersWithDebt: 1, totalSupplierDebt: 500, purchaseOrdersCount: 2, totalPurchaseSpend: 9000, newPurchasesOrderCount: 0, newPurchasesTotalAmount: 0, newPurchasesSupplierCount: 0 },
        filters: { newPurchases: filters('30 ngày') },
        suppliers: [],
        newPurchases: { label: '30 ngày', orderCount: 0, totalAmount: 0, supplierCount: 0, bySupplier: [], orders: [] }
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
  assert.match(url, /^\/api\/dashboard\?view=overview&days=30&/);
  assert.match(url, /prMode=days&prDays=30/, 'Tong quan dung bo loc Hang hoa cho phan nhom hang');
  assert.match(url, /prStatus=all/);
  assert.doesNotMatch(url, /inMode|puMode|cuMode/, 'khong gui bo loc Hoa don/Nha cung cap/Khach hang');
  assert.equal(page.text('ov-customers'), '9', 'Tong quan ve tu payload cua tab');
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

  page.run("switchView('suppliers')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'suppliers']);
  assert.equal(page.text('sp-total'), '4', 'tab Nha cung cap ve tu payload cua chinh no');

  page.run("switchView('overview')");
  page.run("switchView('suppliers')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'suppliers'], 'tab con moi (cung bo loc, chua het han) khong tai lai');
  assert.equal(page.text('ov-customers'), '9');
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

  page.run("setMiniFilterDays('invoices', 7)");
  await settle();

  assert.deepEqual(page.viewsCalled(), ['overview', 'invoices', 'invoices']);
  assert.match(page.calls[2].url, /view=invoices&days=30&inMode=days&inDays=7/);
});

test('doi bo loc Hoa don khong lam Tong quan tai lai', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('invoices')");
  await settle();
  page.run("setMiniFilterDays('invoices', 7)");
  await settle();
  const before = page.calls.length;

  page.run("switchView('overview')");
  await settle();
  assert.equal(page.calls.length, before, 'chu ky Tong quan khong gom bo loc Hoa don -> khong tai lai');
});

test('Hang hoa gui ni/np + trang thai (khong gui khoang pr); bo loc ni/np va pr khong lam tab kia tai lai', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('products')");
  await settle();
  assert.equal(page.calls[page.calls.length - 1].url,
    '/api/dashboard?view=products&days=30&niMode=days&niDays=30&npMode=days&npDays=30&prStatus=all');

  page.run("setMiniFilterDays('newlyImported', 7)");
  await settle();
  assert.match(page.calls[page.calls.length - 1].url, /view=products&days=30&niMode=days&niDays=7&npMode=days&npDays=30&prStatus=all$/);
  page.run("setMiniFilterAll('newProducts')");
  await settle();
  assert.match(page.calls[page.calls.length - 1].url, /niDays=7&npMode=all&prStatus=all$/);
  const afterProducts = page.calls.length;

  page.run("switchView('overview')");
  await settle();
  assert.equal(page.calls.length, afterProducts, 'ni/np khong thuoc Tong quan -> Tong quan khong tai lai');

  page.run("setMiniFilterDays('products', 7)");
  await settle();
  assert.match(page.calls[page.calls.length - 1].url, /view=overview.*prDays=7/);
  const afterOverview = page.calls.length;
  page.run("switchView('products')");
  await settle();
  assert.equal(page.calls.length, afterOverview, 'khoang pr cua Tong quan khong lam tab Hang hoa tai lai');
});

test('doi trang thai kinh doanh (Hang hoa) tai lai tab Hang hoa va danh dau Tong quan cu (KPI dung chung bo loc nay)', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('products')");
  await settle();
  page.run("setProductStatus('Đang kinh doanh')");
  await settle();
  const last = page.calls[page.calls.length - 1];
  assert.equal(last.view, 'products');
  assert.match(last.url, /prStatus=%C4%90ang%20kinh%20doanh/);

  page.run("switchView('overview')");
  await settle();
  const overviewCall = page.calls[page.calls.length - 1];
  assert.equal(overviewCall.view, 'overview');
  assert.match(overviewCall.url, /prStatus=%C4%90ang%20kinh%20doanh/);
});

test('gop payload: Tong quan (1 phan cua products) va Hang hoa (day du) khong ghi de mat truong cua nhau', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('products')");
  await settle();

  const { state } = page.dash;
  assert.deepEqual(Object.keys(state.data.products).sort().includes('allSellingProducts'), true);
  assert.ok(state.data.products.childCategorySalesByParent['NHÀ BẾP']);
  assert.equal(state.data.kpi.revenueToday, 1500000, 'kpi Tong quan con nguyen sau khi tab Hang hoa gop kpi cua no');
  assert.equal(state.data.kpi.inStockCodes, 3, 'kpi Hang hoa duoc gop them, khong thay the');

  // Tong quan tai lai (mang 1 phan `products`) khong duoc xoa bang san pham cua tab Hang hoa.
  page.dash.state.dataEpoch += 1;
  page.run("switchView('overview')");
  await settle();
  assert.equal(state.data.products.allSellingProducts.length, 1);
  assert.equal(state.data.allProducts.length, 1);
  assert.equal(state.data.filters.newProducts.label, '30 ngày');
});

test('tab tu tai lai khi server bao co du lieu moi (dataEpoch tang): tab dang xem ngay, tab khac khi mo', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('customers')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'customers']);

  page.dash.state.dataEpoch += 1; // nhu SSE 'dashboard-updated'
  page.run("switchView('overview')");
  await settle();
  assert.deepEqual(page.viewsCalled(), ['overview', 'customers', 'overview'], 'Tong quan da cu -> tai lai khi mo');
  assert.equal(page.veilOn(), false, 'da co du lieu cu de ve nen khong bat man che');
});

test('du lieu tab qua VIEW_MAX_AGE (5 phut) duoc tai lai khi mo tab, du khong co su kien nao', async () => {
  const page = createPage();
  await settle();
  page.run("switchView('suppliers')");
  await settle();
  page.run("switchView('overview')");
  await settle();
  const before = page.calls.length;

  page.dash.state.viewMeta.suppliers.at -= 6 * 60 * 1000;
  page.run("switchView('suppliers')");
  await settle();
  assert.equal(page.calls.length, before + 1);
  assert.equal(page.calls[before].view, 'suppliers');
});

test('moi tab co request rieng: chuyen tab KHONG huy request tab khac; doi bo loc cua chinh tab huy request cu cua no', async () => {
  const page = createPage({ respond: () => undefined });
  await settle();
  page.calls[0].resolve(payloadFor('overview'));
  await settle();

  page.run("switchView('products')");
  const productsCall = page.calls[1];
  page.run("switchView('invoices')");
  const invoicesCall = page.calls[2];
  assert.equal(productsCall.signal.aborted, false, 'chuyen sang Hoa don khong duoc huy request cua Hang hoa');
  assert.equal(invoicesCall.signal.aborted, false);

  page.run("setMiniFilterDays('invoices', 7)");
  assert.equal(invoicesCall.signal.aborted, true, 'doi bo loc Hoa don huy request cu cua Hoa don');
  assert.equal(productsCall.signal.aborted, false);
  const newInvoicesCall = page.calls[3];
  assert.match(newInvoicesCall.url, /inDays=7/);

  // Response cua request bi huy (ve tay cham) khong ghi de du lieu.
  newInvoicesCall.resolve(payloadFor('invoices', 'MOI'));
  productsCall.resolve(payloadFor('products'));
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

  page.run("switchView('suppliers')");
  page.calls[1].fail(500);
  await settle();
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, false, 'tab dang xem chua co du lieu -> hien hop loi');
  assert.equal(page.veilOn(), false, 'loi cung phai tat man che');

  page.run("retryLoadData()");
  assert.equal(page.calls[2].view, 'suppliers', 'Thu lai tai dung tab dang xem');
  page.calls[2].resolve(payloadFor('suppliers'));
  await settle();
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, true);

  // Tab da chuyen di khi request cu that bai -> khong bat hop loi cho tab dang xem.
  page.run("switchView('customers')");
  const customersCall = page.calls[3];
  page.run("switchView('overview')");
  customersCall.fail(500);
  await settle();
  assert.equal(page.doc.getElementById('dashboardLoadError').hidden, true);
});

test('renderView bo qua tab chua tai xong (khong nem loi khi state.data moi co payload tab khac)', async () => {
  const page = createPage();
  await settle();
  assert.equal(page.dash.viewIsLoaded('products'), false);
  assert.doesNotThrow(() => page.dash.renderView('products'));
  assert.doesNotThrow(() => page.run('toggleTheme()'));
});

test('cache sessionStorage luu theo tab (kem views) va khoi phuc: ve ngay tu cache, van hoi lai server cho tab dang mo', async () => {
  const first = createPage();
  await settle();
  first.run("switchView('suppliers')");
  await settle();
  const cache = JSON.parse(first.dom.window.sessionStorage.getItem('tksDashboardCache'));
  assert.deepEqual(Object.keys(cache.views).sort(), ['overview', 'suppliers']);
  assert.match(cache.views.overview.sig, /^view=overview&days=30&/);
  assert.equal(cache.data.kpi.totalSuppliers, 4);

  const second = createPage({ hash: '#suppliers', cache, respond: () => undefined });
  assert.equal(second.text('sp-total'), '4', 've ngay tu cache truoc khi server tra loi');
  assert.equal(second.veilOn(), false, 'da co du lieu trong cache -> khong bat man che');
  await settle();
  assert.deepEqual(second.viewsCalled(), ['suppliers'], 'van hoi lai server cho tab dang mo, khong keo tab khac');
});

test('cache cu (ban day du 6 tab, khong co views) van dung duoc: cac tab du khoa du lieu duoc coi la da tai va tai lai khi mo', async () => {
  const legacy = {
    data: { ...payloadFor('overview'), ...payloadFor('suppliers'), kpi: { ...kpi(), totalSuppliers: 4, suppliersWithDebt: 1, totalSupplierDebt: 500, totalPurchaseSpend: 9000 } },
    days: 30,
    filters: { products: { mode: 'days', days: 30 }, invoices: { mode: 'days', days: 30 }, suppliers: { mode: 'days', days: 30 }, customers: { mode: 'all' } },
    productStatus: 'all'
  };
  const page = createPage({ cache: legacy, respond: () => undefined });
  assert.equal(page.dash.viewIsLoaded('overview'), true);
  assert.equal(page.dash.viewIsLoaded('suppliers'), true);
  assert.equal(page.dash.viewIsLoaded('invoices'), false);
  assert.equal(page.text('ov-customers'), '9');

  page.run("switchView('suppliers')");
  assert.equal(page.calls.filter(call => call.view === 'suppliers').length, 1, 'cache cu chua co chu ky -> phai hoi lai server');
});

test('sessionStorage day: bo cache cu thay vi giu ban cu hon man hinh', async () => {
  const page = createPage();
  await settle();
  const storage = page.dom.window.sessionStorage;
  assert.ok(storage.getItem('tksDashboardCache'));
  const realSetItem = page.dom.window.Storage.prototype.setItem;
  page.dom.window.Storage.prototype.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    page.run("switchView('suppliers')");
    await settle();
  } finally {
    page.dom.window.Storage.prototype.setItem = realSetItem;
  }
  assert.equal(storage.getItem('tksDashboardCache'), null);
  assert.equal(page.text('sp-total'), '4', 'loi luu cache khong duoc lam hong man hinh');
});

test('sau khi nap quyen: hash tro toi tab khong duoc xem -> van tai tab dang mo (khong bi trang)', async () => {
  let allowed = [];
  const page = createPage({
    hash: '#debt',
    can: feature => allowed.includes(feature) // luc khoi dong quyen chua nap -> false het
  });
  await settle();
  assert.deepEqual(page.viewsCalled(), ['debt'], 'khoi dong tai tab theo hash khi chua biet quyen');

  allowed = ['reports.overview', 'reports.invoices']; // tai khoan khong co reports.debt
  page.run('applyReportViewPermissions()');
  await settle();

  assert.deepEqual(page.viewsCalled(), ['debt', 'overview'], 'Tong quan (tab hien tai) chua co du lieu -> tai them');
  assert.equal(page.text('ov-customers'), '9');
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

  page.run("switchView('suppliers')");
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
