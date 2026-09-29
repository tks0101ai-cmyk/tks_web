'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'index.html'), 'utf8');
const document = new JSDOM(html).window.document;

function view(name) {
  const el = document.getElementById('view-' + name);
  assert.ok(el, 'phai co view ' + name);
  return el;
}

function sectionTitles(name) {
  return [...view(name).querySelectorAll(':scope > section.section')].map(section => ({
    step: section.querySelector('.section-step').textContent.trim(),
    title: section.querySelector('.section-head h2').firstChild.textContent.trim()
  }));
}

test('Tổng quan có 5 phần: Báo cáo hàng hóa thay cho Báo cáo doanh thu theo hàng ở phần 4', () => {
  const titles = sectionTitles('overview');
  assert.deepEqual(titles.map(s => s.step), ['1', '2', '3', '4', '5']);
  assert.equal(titles[1].title, 'Doanh thu sản phẩm theo nhóm hàng');
  assert.equal(titles[3].title, 'Báo cáo hàng hóa');
  assert.equal(titles[4].title, 'Kiểm tra đứt hàng');
  ['endOfDayRows', 'chartTopTransactions', 'overviewPurchaseRows', 'chartOverviewPurchases', 'todayNewProductRows'].forEach(id => {
    assert.equal(view('overview').querySelector('#' + id), null, id + ' khong duoc nam o Tong quan');
  });
  assert.ok(view('overview').querySelector('#productReportRows'), 'productReportRows phai nam o Tong quan');
});

test('Doanh thu theo nhóm hàng gộp 2 biểu đồ tròn + nhóm con vào 1 phần ở Tổng quan, Hàng hóa không còn', () => {
  const section = [...view('overview').querySelectorAll(':scope > section.section')][1];
  ['chartGroupRevenue', 'chartGroupQty', 'childCategoryParentSelect', 'chartChildCategoryRevenue',
    'chartChildCategoryQty', 'childCategoryRows'].forEach(id => {
    assert.ok(section.querySelector('#' + id), id + ' phai nam trong phan Doanh thu san pham theo nhom hang');
  });
  ['chartNewlyImportedRevenue', 'chartNewlyImportedQty', 'childCategoryParentSelect', 'childCategoryRows'].forEach(id => {
    assert.equal(view('products').querySelector('#' + id), null, id + ' da bi go khoi Hang hoa');
  });
});

test('Hóa đơn chứa phần Giao dịch ngay sau Xu hướng, không còn Hóa đơn gần đây', () => {
  const titles = sectionTitles('invoices');
  assert.deepEqual(titles.map(s => s.step), ['1', '2', '3']);
  assert.deepEqual(titles.map(s => s.title), ['Xu hướng', 'Giao dịch', 'Phân tích']);
  ['endOfDayRows', 'endOfDayPagination'].forEach(id => {
    assert.ok(view('invoices').querySelector('#' + id), id + ' phai nam o Hoa don');
  });
  assert.equal(view('invoices').querySelector('#chartTopTransactions'), null, 'bieu do top giao dich da bi go');
  ['invoiceRows', 'invoicesPagination', 'tagInvoices'].forEach(id => {
    assert.equal(view('invoices').querySelector('#' + id), null, id + ' da bi go khoi Hoa don');
  });
});

test('Nhà cung cấp chứa phần Hàng nhập giữa Chỉ số và Phân tích nợ', () => {
  const titles = sectionTitles('suppliers');
  assert.deepEqual(titles.map(s => s.step), ['1', '2', '3']);
  assert.deepEqual(titles.map(s => s.title), ['Chỉ số then chốt', 'Hàng nhập', 'Phân tích & chi tiết']);
  ['sp-purchase-count', 'sp-purchase-total', 'sp-purchase-suppliers', 'chartOverviewPurchases', 'overviewPurchaseRows'].forEach(id => {
    assert.ok(view('suppliers').querySelector('#' + id), id + ' phai nam o Nha cung cap');
  });
});

test('Hàng hóa chứa phần Mã mới tạo sau Hàng mới nhập', () => {
  const titles = sectionTitles('products');
  assert.deepEqual(titles.map(s => s.step), ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(titles.slice(4).map(s => s.title), ['Hàng mới nhập', 'Mã mới tạo']);
  assert.ok(view('products').querySelector('#todayNewProductRows'));
});

test('bộ lọc thời gian: thanh trên chỉ ở Tổng quan; Hàng hóa có bộ lọc riêng trong phần 5 và 6, Trạng thái vẫn dùng chung', () => {
  const groupsOf = name => [...document.querySelectorAll('#filterBar .filter-group')]
    .filter(group => (group.dataset.filterView || '').split(/\s+/).includes(name));
  assert.ok(groupsOf('overview').some(group => group.querySelector('.mini-filter[data-filter-key="products"]')),
    'Tong quan giu bo loc thoi gian cho phan doanh thu theo nhom hang');
  assert.equal(groupsOf('products').some(group => group.querySelector('.mini-filter')), false,
    'thanh tren o Hang hoa khong con bo loc thoi gian');
  assert.ok(groupsOf('products').some(group => group.querySelector('#productStatusToggle')),
    'Trang thai van o thanh tren cua Hang hoa');

  const sections = [...view('products').querySelectorAll(':scope > section.section')];
  const filterIn = (section, key) => section.querySelector('.mini-filter[data-filter-key="' + key + '"]');
  assert.ok(filterIn(sections[4], 'newlyImported'), 'phan 5 co bo loc rieng');
  assert.ok(filterIn(sections[5], 'newProducts'), 'phan 6 co bo loc rieng');
  assert.equal(sections[2].querySelector('.mini-filter'), null, 'phan 3 khong co bo loc thoi gian');
  assert.equal(document.getElementById('productAnalysisPeriod').textContent, 'doanh thu 90 ngày gần nhất');

  ['products', 'newlyImported', 'newProducts', 'invoices', 'suppliers', 'customers'].forEach(key => {
    assert.ok(document.getElementById('miniFrom-' + key), 'thieu o Tu ngay cua ' + key);
    assert.ok(document.getElementById('miniTo-' + key), 'thieu o Den ngay cua ' + key);
  });
  ['invoices', 'suppliers', 'customers'].forEach(name => assert.ok(groupsOf(name).length, name + ' phai co nhom loc'));
});

test('tham số bộ lọc gửi backend: pr cho Tổng quan, ni cho Hàng mới nhập, np cho Mã mới tạo', () => {
  const match = html.match(/const TAB_FILTER_PREFIXES = \{([\s\S]*?)\};/);
  assert.ok(match, 'phai co TAB_FILTER_PREFIXES');
  const map = new Function('return {' + match[1] + '}')();
  assert.deepEqual(map.products, ['pr']);
  assert.deepEqual(map.newlyImported, ['ni']);
  assert.deepEqual(map.newProducts, ['np']);
  assert.deepEqual(map.invoices, ['in']);
  assert.deepEqual(map.suppliers, ['pu']);
  assert.equal(map.overview, undefined);
});

// ---- Render thật: dữ liệu đúng cấu trúc payload mới phải hiện ở tab mới ----
function createRenderedDashboard(data) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/#overview' });
  dom.window.sessionStorage.setItem('tksDashboardCache', JSON.stringify({
    data,
    days: 30,
    filters: { products: { mode: 'days', days: 30 }, invoices: { mode: 'days', days: 30 }, customers: { mode: 'all' } },
    productStatus: 'all'
  }));
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; }
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => callback();
  dom.window.TKSNav = { authGuard: () => new Promise(() => {}), can: () => true, handleBranchError: () => false, renderTopSidebar() {} };
  dom.window.fetch = () => new Promise(() => {});
  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', file), 'utf8'));
  });
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim())
    .forEach(script => dom.window.eval(script));
  return dom;
}

function samplePayload() {
  const kpi = { revenueToday: 0, invoicesToday: 0, cancelledToday: 0, totalStock: 0, totalProducts: 0, lowStockCount: 0,
    totalCustomers: 0, customersWithDebt: 0, totalDebt: 0, totalSuppliers: 4, suppliersWithDebt: 1, totalSupplierDebt: 500,
    totalPurchaseSpend: 9000, inStockCodes: 0, inactiveProducts: 0, inventoryValueCategoryCount: 0, totalInventoryValue: 0 };
  return {
    kpi,
    filters: { products: { label: '30 ngày' }, invoices: { label: '30 ngày' } },
    invoices: {
      periodRevenue: 0, periodInvoices: 0, periodCancelledInvoices: 0, revenueByDay: [],
      periodOrders: [], periodReturns: [],
      transactionsReport: {
        transactions: [{ code: 'HD-777', time: '21/09 09:08', customer: 'KH A', employee: 'NV B', quantity: 3, quantityKnown: true, revenue: 1200000, discount: 0, paid: 1200000, status: 'Hoàn thành' }],
        topTransactions: [{ code: 'HD-777', revenue: 1200000, status: 'Hoàn thành' }],
        summary: { quantity: 3, quantityKnown: true, revenue: 1200000, discount: 0, paid: 1200000 }
      }
    },
    newPurchases: {
      label: '30 ngày', orderCount: 1, totalAmount: 777000, supplierCount: 1,
      bySupplier: [{ name: 'NCC Z', orderCount: 1, total: 777000 }],
      orders: [{ code: 'PN-555', date: '21/09/2026 08:17', supplier: 'NCC Z', total: 777000, status: 'Đã nhập hàng' }]
    },
    products: {
      newProducts: { label: '30 ngày', count: 1, dateColumnAvailable: true,
        products: [{ code: 'MOI-01', name: 'Hàng mới tạo', category: 'Nhóm X', createdAt: '18/09/2026 14:28:00', cost: 0, price: 0 }] },
      topSellingProducts: [], topSellingParentCategories: [], childCategorySalesByParent: {}, availableParentCategories: [],
      newlyImported: { products: [], topByRevenue: [], salesByCategory: [], countByCategory: [], salesRevenue: 0, salesQty: 0 }
    },
    lowStock: [], stockValueByCategory: [], allProducts: [], stockByCategory: [], suppliers: [],
    customers: { topDebt: [], topRevenue: { top15: [], all: [], label: '—' } }
  };
}

test('render: giao dịch hiện ở Hóa đơn, phiếu nhập ở Nhà cung cấp, mã mới tạo ở Hàng hóa', () => {
  const dom = createRenderedDashboard(samplePayload());
  const doc = dom.window.document;
  const text = id => doc.getElementById(id).textContent;

  dom.window.eval("switchView('invoices')");
  assert.match(text('endOfDayRows'), /HD-777/);
  assert.match(text('end-day-total-revenue'), /1\.200\.000/);
  assert.match(text('end-day-table-count'), /1 giao dịch/);

  dom.window.eval("switchView('suppliers')");
  assert.match(text('overviewPurchaseRows'), /PN-555/);
  assert.equal(text('sp-purchase-count'), '1');
  assert.match(text('sp-purchase-total'), /777\.000/);
  assert.equal(text('sp-purchase-suppliers'), '1');

  dom.window.eval("switchView('products')");
  assert.match(text('todayNewProductRows'), /MOI-01/);
  assert.match(text('today-new-products-count'), /1 mã mới/);
  // Bảng chỉ còn 4 cột (bỏ Giá vốn/Giá bán) và có biểu đồ tỷ lệ số mã theo nhóm
  assert.equal(doc.querySelectorAll('#todayNewProductRows tr:first-child td').length, 4);
  assert.equal(doc.querySelector('#todayNewProductRows').closest('table').querySelectorAll('th').length, 4);
  assert.equal(text('tagNewProductsCategory'), '1 nhóm');
  assert.equal(doc.getElementById('chartNewProductsCategory').hidden, false);

  // Chuyển về Tổng quan không được ném lỗi dù dữ liệu tab khác có mặt
  assert.doesNotThrow(() => dom.window.eval("switchView('overview')"));
});

test('render: phần 3 luôn ghi 90 ngày; phần 5/6 ghi khoảng của bộ lọc riêng, không theo bộ lọc Tổng quan', () => {
  const payload = samplePayload();
  payload.filters = { products: { label: '7 ngày' } };
  payload.products.newlyImported.label = '01/07/2026 – 31/07/2026';
  payload.products.newProducts.label = 'Tất cả';
  const dom = createRenderedDashboard(payload);
  const text = id => dom.window.document.getElementById(id).textContent;

  dom.window.eval("switchView('products')");
  assert.equal(text('productAnalysisPeriod'), 'doanh thu 90 ngày gần nhất');
  assert.equal(text('newlyImportedPeriod'), 'ngày nhập đầu tiên: 01/07/2026 – 31/07/2026');
  assert.equal(text('newProductsPeriod'), 'ngày tạo: Tất cả');
  assert.match(text('newlyImportedRows'), /01\/07\/2026 – 31\/07\/2026/, 'thong bao rong dung khoang ni');
});

test('render: Tổng quan vẽ biểu đồ doanh thu + số lượng theo nhóm hàng, nhấn lát để xem nhóm con', () => {
  const payload = samplePayload();
  const child = (name, qty, revenue) => ({ name, qty, revenue, productCount: 1 });
  payload.products.childCategorySalesByParent = {
    'NHÀ BẾP': [child('Nồi', 10, 5000000), child('Chảo', 5, 3000000)],
    'PHÒNG ĂN': [child('Bát', 100, 2000000)],
    'Chưa xác định': [child('Chưa phân nhóm', 1, 100000)]
  };
  payload.products.availableParentCategories = ['NHÀ BẾP', 'PHÒNG ĂN', 'KHO TRỐNG'];
  const dom = createRenderedDashboard(payload);
  const doc = dom.window.document;
  const text = id => doc.getElementById(id).textContent;

  dom.window.eval("switchView('overview')");
  assert.equal(doc.getElementById('chartGroupRevenue').hidden, false);
  assert.equal(doc.getElementById('chartGroupQty').hidden, false);
  assert.equal(text('tagGroupRevenue'), '10.1tr₫');
  assert.equal(text('tagGroupQty'), '116');
  assert.match(text('groupRevenuePeriod'), /30 ngày/);

  // Ô Nhóm cha gồm nhóm có bán, nhóm chưa có doanh thu và nhóm chỉ có trong dữ liệu bán
  const options = [...doc.querySelectorAll('#childCategoryParentSelect option')].map(o => o.value);
  assert.deepEqual(options, ['', 'Chưa xác định', 'KHO TRỐNG', 'NHÀ BẾP', 'PHÒNG ĂN']);
  assert.equal(doc.getElementById('childCategoryPanels').hidden, true);

  // Chọn nhóm cha -> hiện biểu đồ số lượng + doanh thu nhóm con và bảng chi tiết
  dom.window.eval("selectChildCategoryParentFromChart({ name: 'NHÀ BẾP' })");
  assert.equal(doc.getElementById('childCategoryParentSelect').value, 'NHÀ BẾP');
  assert.equal(doc.getElementById('childCategoryPanels').hidden, false);
  assert.equal(doc.getElementById('chartChildCategoryRevenue').hidden, false);
  assert.equal(doc.getElementById('chartChildCategoryQty').hidden, false);
  assert.equal(doc.querySelectorAll('#childCategoryRows tr').length, 2);

  // Lát "Khác" không phải nhóm thật nên bấm vào không đổi lựa chọn
  dom.window.eval("selectChildCategoryParentFromChart({ name: 'Khác (2 nhóm)', isOther: true })");
  assert.equal(doc.getElementById('childCategoryParentSelect').value, 'NHÀ BẾP');

  // Hàng hóa không còn phần này nhưng vẫn render bình thường
  assert.doesNotThrow(() => dom.window.eval("switchView('products')"));
});

test('biểu đồ nhóm hàng hiển thị đủ từng nhóm (không gộp "Khác") và bỏ nhóm không có giá trị dương', () => {
  const dom = createRenderedDashboard(samplePayload());
  const groups = Array.from({ length: 12 }, (_, index) => ({ name: 'G' + index, qty: 12 - index, revenue: (12 - index) * 1000 }));
  groups.push({ name: 'ZERO', qty: 0, revenue: 0 });
  dom.window.eval('window.__groups = ' + JSON.stringify(groups));
  const slices = dom.window.eval("groupChartSlices(window.__groups, 'revenue')");
  assert.equal(slices.length, 12);
  assert.equal(slices[0].name, 'G0');
  assert.equal(slices[11].name, 'G11');
  assert.ok(!slices.some(slice => slice.name === 'ZERO'));
});
