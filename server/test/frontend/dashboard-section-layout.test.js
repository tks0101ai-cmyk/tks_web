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

test('Tổng quan có 2 phần (Xu hướng đứng đầu; Báo cáo hàng hóa sang tab Hàng hóa, doanh thu theo khách sang tab Khách hàng)', () => {
  const titles = sectionTitles('overview');
  assert.deepEqual(titles.map(s => s.step), ['1', '2']);
  assert.ok(!titles.some(s => /nhóm hàng/.test(s.title)), 'phan nhom hang da bi go');
  assert.deepEqual(titles.map(s => s.title), ['Xu hướng', 'Kiểm tra đứt hàng']);
  assert.equal(view('overview').querySelector('#cpCustomerSearchInput'), null, 'doanh thu theo khach da chuyen sang tab Khach hang');
  assert.ok(view('business').querySelector('#cpCustomerSearchInput'), 'doanh thu theo khach phai nam o tab Khach hang');
  ['endOfDayRows', 'chartTopTransactions', 'todayNewProductRows'].forEach(id => {
    assert.equal(view('overview').querySelector('#' + id), null, id + ' khong duoc nam o Tong quan');
  });
  assert.equal(view('overview').querySelector('#productReportRows'), null, 'productReportRows da chuyen sang tab Hang hoa');
});

test('Tổng quan không còn phần nhóm hàng, Hàng hóa không còn phần nhóm con', () => {
  ['chartGroupRevenue', 'chartGroupQty', 'childCategoryParentSelect', 'chartChildCategoryRevenue', 'childCategoryRows'].forEach(id => {
    assert.equal(document.getElementById(id), null, id + ' da bi go khoi dashboard');
  });
});

test('Hóa đơn: Kiểm tra giá bán, Bảng giá duyệt rồi Giao dịch (đã bỏ phần Phân tích/Trả hàng; Xu hướng đã chuyển sang Tổng quan), không còn Hóa đơn gần đây', () => {
  const titles = sectionTitles('invoices');
  assert.deepEqual(titles.map(s => s.step), ['1', '2', '3']);
  assert.deepEqual(titles.map(s => s.title), ['Kiểm tra giá bán', 'Bảng giá duyệt', 'Giao dịch']);
  ['in-returns-total', 'in-returns-count'].forEach(id => assert.equal(document.getElementById(id), null, id + ' da bi go'));
  ['chartInvoiceRevenue', 'in-revenue'].forEach(id => {
    assert.equal(view('invoices').querySelector('#' + id), null, id + ' da chuyen sang Tong quan');
    assert.ok(view('overview').querySelector('#' + id), id + ' phai nam o Tong quan');
  });
  ['endOfDayRows', 'endOfDayPagination'].forEach(id => {
    assert.ok(view('invoices').querySelector('#' + id), id + ' phai nam o Hoa don');
  });
  assert.equal(view('invoices').querySelector('#chartTopTransactions'), null, 'bieu do top giao dich da bi go');
  ['invoiceRows', 'invoicesPagination', 'tagInvoices'].forEach(id => {
    assert.equal(view('invoices').querySelector('#' + id), null, id + ' da bi go khoi Hoa don');
  });
});

test('Hàng hóa có 4 phần: Báo cáo hàng hóa, Dự kiến hàng về, Tăng trưởng mã hàng và Hàng hóa 90 ngày', () => {
  const titles = sectionTitles('products');
  assert.deepEqual(titles.map(s => s.step), ['1', '2', '3', '4']);
  assert.deepEqual(titles.map(s => s.title), ['Báo cáo hàng hóa', 'Dự kiến hàng về', 'Tăng trưởng mã hàng', 'Hàng hóa 90 ngày']);
  ['productReportRows', 'expectedArrivalsRows', 'businessProductsRows', 'pcgRows'].forEach(id => assert.ok(view('products').querySelector('#' + id), id));
  ['todayNewProductRows', 'newlyImportedRows', 'allProductRows', 'topSellingRows', 'inventoryValueRows'].forEach(id => {
    assert.equal(document.getElementById(id), null, id + ' da bi go cung cac muc cu cua tab Hang hoa');
  });
});

test('không còn thanh lọc thời gian chung; bộ lọc Từ – Đến gắn vào từng bảng có lọc thời gian', () => {
  assert.equal(document.getElementById('filterBar'), null);
  const match = html.match(/const TABLE_DATE_FILTERS = \{([\s\S]*?)\};/);
  assert.ok(match, 'phai co TABLE_DATE_FILTERS');
  const map = new Function('return {' + match[1] + '}')();
  // Moi bang 1 bo loc rieng (2 bang Dat hang / Tra hang cua tab Hoa don da bo 2026-10-01).
  assert.deepEqual(map, {
    endOfDay: 'invoices'
  });
  assert.equal(new Set(Object.values(map)).size, Object.keys(map).length, 'khong bang nao dung chung bo loc');
});

test('không còn mục Chỉ số then chốt đầu tab; mỗi mục con có hàng chỉ số ngay dưới tiêu đề', () => {
  ['overview', 'products', 'invoices'].forEach(name => {
    const sections = [...view(name).querySelectorAll(':scope > section.section')];
    assert.ok(!sectionTitles(name).some(s => s.title === 'Chỉ số then chốt'), name);
    sections.forEach((section, index) => {
      // Dự kiến hàng về và Hàng hóa 90 ngày (bảng tính sẵn, chỉ đọc) không có hàng chỉ số.
      if (section.id === 'expectedArrivalsSection' || section.id === 'product90dSection') {
        assert.equal(section.querySelector('.section-kpis'), null);
        return;
      }
      assert.ok(section.querySelector('.section-kpis'), name + ' muc ' + (index + 1) + ' thieu chi so then chot');
      const firstBlock = section.querySelector(':scope > .section-head').nextElementSibling;
      assert.ok(firstBlock.classList.contains('section-kpis'), name + ' muc ' + (index + 1) + ': chi so phai o dau muc');
    });
  });
});

test('tham số bộ lọc gửi backend: chỉ còn in (Hóa đơn/Xu hướng); pr/ni/np/cu/ov/de đã bỏ', () => {
  const match = html.match(/const TAB_FILTER_PREFIXES = \{([\s\S]*?)\};/);
  assert.ok(match, 'phai co TAB_FILTER_PREFIXES');
  const map = new Function('return {' + match[1] + '}')();
  assert.deepEqual(map, { invoices: ['in'] });
  assert.equal(map.overview, undefined);
});

// ---- Render thật: dữ liệu đúng cấu trúc payload mới phải hiện ở tab mới ----
function createRenderedDashboard(data) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/#overview' });
  dom.window.sessionStorage.setItem('tksDashboardCache', JSON.stringify({
    data,
    days: 30,
    filters: { products: { mode: 'days', days: 30 }, invoices: { mode: 'days', days: 30 } },
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
  const kpi = { totalStock: 0, totalProducts: 0, lowStockCount: 0,
    totalCustomers: 0, customersWithDebt: 0, totalDebt: 0,
    inStockCodes: 0, inactiveProducts: 0, totalInventoryValue: 0 };
  return {
    kpi,
    filters: { products: { label: '30 ngày' }, invoices: { label: '30 ngày' } },
    invoices: {
      periodRevenue: 0, periodInvoices: 0, periodCancelledInvoices: 0, revenueByDay: [],
      transactionsReport: {
        transactions: [{ code: 'HD-777', time: '21/09 09:08', customer: 'KH A', employee: 'NV B', quantity: 3, quantityKnown: true, revenue: 1200000, discount: 0, paid: 1200000, status: 'Hoàn thành' }],
        topTransactions: [{ code: 'HD-777', revenue: 1200000, status: 'Hoàn thành' }],
        summary: { quantity: 3, quantityKnown: true, revenue: 1200000, discount: 0, paid: 1200000 }
      }
    },
  };
}

test('render: giao dịch hiện ở Hóa đơn; mở tab Hàng hóa không ném lỗi', () => {
  const dom = createRenderedDashboard(samplePayload());
  const doc = dom.window.document;
  const text = id => doc.getElementById(id).textContent;

  dom.window.eval("switchView('invoices')");
  assert.match(text('endOfDayRows'), /HD-777/);
  assert.match(text('end-day-total-revenue'), /1,200,000/);
  assert.match(text('end-day-table-count'), /1 giao dịch/);

  assert.doesNotThrow(() => dom.window.eval("switchView('products')"));

  // Chuyển về Tổng quan không được ném lỗi dù dữ liệu tab khác có mặt
  assert.doesNotThrow(() => dom.window.eval("switchView('overview')"));
});
