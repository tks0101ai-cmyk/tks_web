'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const indexPath = path.join(publicDir, 'index.html');

function createDashboard() {
  const source = fs.readFileSync(indexPath, 'utf8');
  const dom = new JSDOM(source, { runScripts: 'outside-only', url: 'https://tokosi.example/#overview' });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.Chart = class FakeChart {
    static instances = [];
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; FakeChart.instances.push(this); }
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => callback();
  dom.window.TKSNav = {
    authGuard: () => new Promise(() => {}),
    // Trang bao cao goi TKSNav.can('reports.<tab>') de biet tab nao duoc xem
    // (nguon: user.permissions tu /api/auth/me) — test nay khong kiem tra phan
    // quyen nen mo het.
    can: () => true,
    handleBranchError: () => false,
    renderTopSidebar() {}
  };
  dom.window.fetch = () => new Promise(() => {});
  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim())
    .forEach(script => dom.window.eval(script));
  return dom;
}

test('registry bao phủ đủ 21 bảng trong Báo cáo tổng hợp', () => {
  const dom = createDashboard();
  const expected = [
    'cpDetail', 'productReport', 'productSales90d', 'recentStockout', 'stockout90d', 'stockout30d',
    'endOfDay', 'overviewPurchase', 'todayNewProducts', 'topSelling', 'lowStock',
    'allProducts', 'inventoryValue', 'newlyImported', 'childCategory', 'orders', 'returns',
    'customerRevenue', 'topDebt', 'suppliers', 'debtManagement'
  ];
  const actual = Object.keys(dom.window.TABLE_EXPLORER_CONFIGS);
  assert.deepEqual([...actual].sort(), expected.sort());
  dom.window.close();
});

test('tìm từng bảng lọc toàn bộ dữ liệu trước phân trang và giữ mọi kết quả chứa cụm từ', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  const products = Array.from({ length: 105 }, (_, index) => ({
    code: `SP${String(index + 1).padStart(3, '0')}`,
    name: index === 100 || index === 101 ? `Chổi lau nhà ${index}` : `Sản phẩm ${index}`,
    stock: index
  }));

  dom.window.renderPaginatedRows(
    'allProducts',
    {
      tbody: 'allProductRows', pagination: 'allProductsPagination',
      firstBtn: 'allProductsFirstPage', prevBtn: 'allProductsPrevPage',
      nextBtn: 'allProductsNextPage', lastBtn: 'allProductsLastPage',
      label: 'allProductsPageLabel'
    },
    products,
    item => `<tr><td>${item.code}</td><td>${item.name}</td></tr>`,
    2,
    'Không có dữ liệu'
  );

  const input = document.querySelector('[data-table-search="allProducts"] .table-search-input');
  input.value = 'choi lau nha';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const rows = [...document.querySelectorAll('#allProductRows tr[data-table-item-id]')];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.dataset.tableItemId), ['SP101', 'SP102']);
  assert.match(document.querySelector('[data-table-search-count="allProducts"]').textContent, /2\s*\/\s*105/);
  assert.match(document.getElementById('allProductsPageLabel').textContent, /Trang 1\/1/);
  dom.window.close();
});

test('sort cột áp dụng cho toàn bộ dữ liệu đã lọc, không chỉ trang đang xem', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  // stock giam dan theo thu tu nguon: dong dau co stock lon nhat (249), dong cuoi co
  // stock nho nhat (0) — trang 1 (100 dong dau) truoc khi sort chi chua cac gia tri
  // stock tu 150 den 249, khong chua gia tri nho nhat nao.
  const products = Array.from({ length: 250 }, (_, index) => ({
    code: `SP${index}`,
    stock: 249 - index
  }));
  const ids = {
    tbody: 'allProductRows', pagination: 'allProductsPagination',
    firstBtn: 'allProductsFirstPage', prevBtn: 'allProductsPrevPage',
    nextBtn: 'allProductsNextPage', lastBtn: 'allProductsLastPage', label: 'allProductsPageLabel'
  };
  dom.window.renderPaginatedRows('allProducts', ids, products,
    item => `<tr><td>${item.code}</td><td data-sort-value="${item.stock}">${item.stock}</td></tr>`,
    2, 'Không có dữ liệu');

  dom.window.setTableSort('allProductRows', 1); // sort tang dan theo cot stock (cot index 1)

  const stocksOnPage1 = [...document.querySelectorAll('#allProductRows tr td:nth-child(2)')]
    .map(td => Number(td.getAttribute('data-sort-value')));
  assert.equal(stocksOnPage1.length, 100);
  assert.deepEqual(stocksOnPage1, Array.from({ length: 100 }, (_, i) => i));
  assert.match(document.getElementById('allProductsPageLabel').textContent, /Trang 1\/3/);

  document.getElementById('allProductsNextPage').click();
  const stocksOnPage2 = [...document.querySelectorAll('#allProductRows tr td:nth-child(2)')]
    .map(td => Number(td.getAttribute('data-sort-value')));
  assert.deepEqual(stocksOnPage2, Array.from({ length: 100 }, (_, i) => i + 100));

  dom.window.close();
});

test('chế độ nhiều mã khớp chính xác trên toàn bộ bảng và báo mã thiếu', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  const products = [
    { code: 'SP001', name: 'Sản phẩm 1' },
    { code: 'SP002', name: 'Sản phẩm 2' },
    { code: '00123', name: 'Sản phẩm giữ số 0' }
  ];
  const ids = {
    tbody: 'allProductRows', pagination: 'allProductsPagination',
    firstBtn: 'allProductsFirstPage', prevBtn: 'allProductsPrevPage',
    nextBtn: 'allProductsNextPage', lastBtn: 'allProductsLastPage', label: 'allProductsPageLabel'
  };
  dom.window.renderPaginatedRows('allProducts', ids, products,
    item => `<tr><td>${item.code}</td><td>${item.name}</td></tr>`, 2, 'Không có dữ liệu');

  document.querySelector('[data-table-search="allProducts"] [data-table-search-mode="codes"]').click();
  const input = document.querySelector('[data-table-search="allProducts"] .table-search-input');
  input.value = '00123, SP404; sp002';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  assert.deepEqual(
    [...document.querySelectorAll('#allProductRows tr[data-table-item-id]')].map(row => row.dataset.tableItemId),
    ['SP002', '00123']
  );
  assert.match(document.querySelector('[data-table-search-count="allProducts"]').textContent, /Đã tìm thấy 2\/3 mã/);
  assert.match(document.querySelector('[data-table-search-count="allProducts"]').textContent, /SP404/);
  dom.window.close();
});

test('bảng kết quả đứt hàng dùng cùng bộ lọc dù có renderer chuyên biệt', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  dom.window.renderRecentStockoutResultTable({
    asOfDate: '16/09/2026',
    totalProductsScanned: 3,
    rows: [
      { code: 'SP01', name: 'Chổi lau nhà lớn', lastOutOfStockDate: '15/09/2026', daysOutOfStock: 2, periods: [] },
      { code: 'SP02', name: 'Chổi lau nhà nhỏ', lastOutOfStockDate: '14/09/2026', daysOutOfStock: 3, periods: [] },
      { code: 'SP03', name: 'Nước lau sàn', lastOutOfStockDate: '13/09/2026', daysOutOfStock: 4, periods: [] }
    ]
  });

  const input = document.querySelector('[data-table-search="recentStockout"] .table-search-input');
  input.value = 'choi lau nha';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  assert.deepEqual(
    [...document.querySelectorAll('#recentStockoutResultRows tr[data-table-item-id]')].map(row => row.dataset.tableItemId),
    ['SP02', 'SP01']
  );
  assert.equal(document.getElementById('tagRecentStockoutRows').textContent, '2/3');
  dom.window.close();
});

test('điều hướng biểu đồ xóa tìm kiếm, chuyển đúng trang và tô sáng dòng đích', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  const products = Array.from({ length: 150 }, (_, index) => ({
    code: `SP${String(index + 1).padStart(3, '0')}`,
    name: `Sản phẩm ${index + 1}`
  }));
  const ids = {
    tbody: 'allProductRows', pagination: 'allProductsPagination',
    firstBtn: 'allProductsFirstPage', prevBtn: 'allProductsPrevPage',
    nextBtn: 'allProductsNextPage', lastBtn: 'allProductsLastPage', label: 'allProductsPageLabel'
  };
  dom.window.renderPaginatedRows('allProducts', ids, products,
    item => `<tr><td>${item.code}</td><td>${item.name}</td></tr>`, 2, 'Không có dữ liệu');

  const input = document.querySelector('[data-table-search="allProducts"] .table-search-input');
  input.value = 'SP001';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  dom.window.navigateChartToTable('allProducts', 'SP120');

  assert.equal(input.value, '');
  assert.equal(document.getElementById('allProductsPageLabel').textContent, 'Trang 2/2');
  assert.equal(document.querySelector('#allProductRows tr.table-row-target').dataset.tableItemId, 'SP120');
  dom.window.close();
});

test('điều hướng dùng mã nguồn khi hai nhãn biểu đồ trùng nhau', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  const customers = [
    { code: 'KH01', name: 'Công ty Minh Anh', revenue: 100, saleOrderCount: 1 },
    { code: 'KH02', name: 'Công ty Minh Anh', revenue: 200, saleOrderCount: 2 }
  ];
  const ids = {
    tbody: 'customerRevenueRows', pagination: 'customerRevenuePagination',
    firstBtn: 'customerRevenueFirstPage', prevBtn: 'customerRevenuePrevPage',
    nextBtn: 'customerRevenueNextPage', lastBtn: 'customerRevenueLastPage', label: 'customerRevenuePageLabel'
  };
  dom.window.renderPaginatedRows('customerRevenue', ids, customers,
    item => `<tr><td>${item.code}</td><td>${item.name}</td></tr>`, 2, 'Không có dữ liệu');
  dom.window.renderTopCustomerRevenueChart({ top15: customers });

  const chart = dom.window.Chart.instances.at(-1);
  chart.config.options.onClick({}, [{ index: 1 }]);

  assert.equal(document.querySelector('#customerRevenueRows tr.table-row-target').dataset.tableItemId, 'KH02');
  dom.window.close();
});

test('mục biểu đồ đã biến mất chỉ thông báo và giữ nguyên bộ lọc bảng', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  const ids = {
    tbody: 'allProductRows', pagination: 'allProductsPagination',
    firstBtn: 'allProductsFirstPage', prevBtn: 'allProductsPrevPage',
    nextBtn: 'allProductsNextPage', lastBtn: 'allProductsLastPage', label: 'allProductsPageLabel'
  };
  dom.window.renderPaginatedRows('allProducts', ids, [{ code: 'SP001', name: 'Sản phẩm 1' }],
    item => `<tr><td>${item.code}</td><td>${item.name}</td></tr>`, 2, 'Không có dữ liệu');
  const input = document.querySelector('[data-table-search="allProducts"] .table-search-input');
  input.value = 'SP001';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  dom.window.navigateChartToTable('allProducts', 'SP404');

  assert.equal(input.value, 'SP001');
  assert.equal(document.getElementById('allProductsPageLabel').textContent, 'Trang 1/1');
  assert.equal(document.getElementById('tableNavigationStatus').textContent, 'Không còn tìm thấy dòng tương ứng');
  dom.window.close();
});

test('payload xuất Excel mang theo chế độ và từ khóa của đúng bảng', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  const ids = {
    tbody: 'allProductRows', pagination: 'allProductsPagination',
    firstBtn: 'allProductsFirstPage', prevBtn: 'allProductsPrevPage',
    nextBtn: 'allProductsNextPage', lastBtn: 'allProductsLastPage', label: 'allProductsPageLabel'
  };
  dom.window.renderPaginatedRows('allProducts', ids, [{ code: 'SP001', name: 'Chổi lau nhà' }],
    item => `<tr><td>${item.code}</td><td>${item.name}</td></tr>`, 2, 'Không có dữ liệu');
  document.querySelector('[data-table-search="allProducts"] [data-table-search-mode="codes"]').click();
  const input = document.querySelector('[data-table-search="allProducts"] .table-search-input');
  input.value = 'SP001 SP404';
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));

  const payload = dom.window.buildExportPayload('products.all');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.tableSearch)), {
    mode: 'codes',
    query: 'SP001 SP404'
  });
  dom.window.close();
});

test('ô tìm kiếm bảng ẩn nút × mặc định của trình duyệt để chỉ còn một nút xóa', () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  assert.match(source, /\.table-search-input\[type="search"\]::-webkit-search-cancel-button/);
});
