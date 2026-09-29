'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const CONFIG = require('../config');
const {
  VIEW_NAMES, VIEW_FEATURE, VIEW_PAYLOAD, PERIODS_KEY, ALL_CORE_KEYS, ALL_ROLLUPS,
  parseViewsParam, resolveViewPlan, pickPayload, pickFilters
} = require('./dashboardViews');
const { SECTION_FEATURE } = require('./dashboardPermissionFilter');
const dashboardPgReader = require('./dashboardPgReader');

test('parseViewsParam: bo trong = ca 6 tab (null), tach dau phay, bo trung/khoang trang', () => {
  assert.equal(parseViewsParam(undefined), null);
  assert.equal(parseViewsParam(null), null);
  assert.equal(parseViewsParam(''), null);
  assert.equal(parseViewsParam(' , '), null);
  assert.deepEqual(parseViewsParam('overview'), ['overview']);
  assert.deepEqual(parseViewsParam(' overview , products,overview '), ['overview', 'products']);
  assert.deepEqual(parseViewsParam(['invoices', 'debt']), ['invoices', 'debt']);
});

test('parseViewsParam: ten tab sai bi tu choi 400 INVALID_VIEW, khong bo qua im lang', () => {
  assert.throws(
    () => parseViewsParam('overview,hoadon'),
    error => error.code === 'INVALID_VIEW' && error.statusCode === 400 && /hoadon/.test(error.message)
  );
  assert.throws(() => parseViewsParam('__proto__'), error => error.code === 'INVALID_VIEW');
});

test('ke hoach ca 6 tab (khong truyen view) = doc du 7 bang + CN1/3/7 + du 8 rollup + cong no, khoa cache "all"', () => {
  const plan = resolveViewPlan();
  assert.equal(plan.all, true);
  assert.deepEqual(plan.views, VIEW_NAMES);
  assert.equal(plan.key, 'all');
  assert.deepEqual(plan.coreKeys, ALL_CORE_KEYS);
  assert.deepEqual([...plan.rollups], ALL_ROLLUPS);
  assert.equal(plan.needsDebt, true);
  // Bang nguon cua ke hoach du phai la dung 7 tab core cua pgReader (+ periods).
  assert.deepEqual(
    plan.coreKeys.filter(key => key !== PERIODS_KEY).sort(),
    [...dashboardPgReader.CORE_SHEET_NAMES].sort()
  );
});

test('Tong quan KHONG doc Dat hang/Tra hang/Nha cung cap/cong no va khong chay rollup nhap hang/so luong hoa don', () => {
  const plan = resolveViewPlan(['overview']);
  assert.equal(plan.all, false);
  assert.equal(plan.key, 'overview');
  assert.deepEqual(plan.coreKeys, [CONFIG.SHEET_CATEGORIES, CONFIG.SHEET_PRODUCTS, CONFIG.SHEET_INVOICES, CONFIG.SHEET_CUSTOMERS]);
  assert.ok(!plan.coreKeys.includes(CONFIG.SHEET_ORDERS), 'Dat hang ~23K dong chi tab Hoa don can');
  assert.ok(!plan.coreKeys.includes(PERIODS_KEY));
  assert.deepEqual([...plan.rollups].sort(), ['overviewRevenue', 'productSales']);
  assert.equal(plan.needsDebt, false);
  assert.deepEqual(plan.filterKeys, ['overview', 'products']);
});

test('moi tab chi doc dung nguon cua no; Cong no chi can CN1/3/7 + workbook cong no', () => {
  const sheetsOf = name => resolveViewPlan([name]).coreKeys;
  assert.deepEqual(sheetsOf('products'), [CONFIG.SHEET_CATEGORIES, CONFIG.SHEET_PRODUCTS]);
  assert.deepEqual(sheetsOf('invoices'), [CONFIG.SHEET_INVOICES, CONFIG.SHEET_ORDERS, CONFIG.SHEET_RETURNS]);
  assert.deepEqual(sheetsOf('customers'), [CONFIG.SHEET_INVOICES, CONFIG.SHEET_RETURNS, CONFIG.SHEET_CUSTOMERS]);
  assert.deepEqual(sheetsOf('suppliers'), [CONFIG.SHEET_SUPPLIERS]);
  assert.deepEqual(sheetsOf('debt'), [PERIODS_KEY]);
  assert.equal(resolveViewPlan(['debt']).needsDebt, true);
  assert.equal(resolveViewPlan(['debt']).rollups.size, 0);
  assert.deepEqual([...resolveViewPlan(['suppliers']).rollups].sort(), ['newPurchaseOrders', 'purchaseTotals']);
  assert.deepEqual([...resolveViewPlan(['invoices']).rollups].sort(), ['invoiceQuantity', 'invoicesRevenue']);
  assert.deepEqual([...resolveViewPlan(['products']).rollups].sort(), ['firstPurchase', 'newlyImportedSales', 'productSales']);
  assert.deepEqual(resolveViewPlan(['products']).filterKeys, ['products', 'newlyImported', 'newProducts']);
  assert.equal(resolveViewPlan(['customers']).rollups.size, 0);
});

test('nhieu tab: hop cac nguon theo thu tu chuan, khoa cache on dinh khong phu thuoc thu tu truyen vao', () => {
  const a = resolveViewPlan(['invoices', 'overview']);
  const b = resolveViewPlan(['overview', 'invoices', 'overview']);
  assert.equal(a.key, 'overview+invoices');
  assert.equal(b.key, a.key);
  assert.deepEqual(a.coreKeys, b.coreKeys);
  assert.ok(a.has('overview') && a.has('invoices') && !a.has('debt'));
  assert.deepEqual([...a.rollups].sort(), ['invoiceQuantity', 'invoicesRevenue', 'overviewRevenue', 'productSales']);
});

test('resolveViewPlan tu choi ten tab sai', () => {
  assert.throws(() => resolveViewPlan(['overview', 'nope']), error => error.code === 'INVALID_VIEW');
});

test('moi khoa payload top-level cua tab dung quyen cua chinh tab do (khop SECTION_FEATURE), tru khoa luon giu', () => {
  VIEW_NAMES.forEach(view => {
    VIEW_PAYLOAD[view].top.forEach(key => {
      assert.equal(SECTION_FEATURE[key], VIEW_FEATURE[view], `${view}.${key} phai can quyen ${VIEW_FEATURE[view]}`);
    });
  });
});

test('pickFilters: chi giu bo loc anh huong tab (cache key), ke hoach ca 6 tab giu nguyen', () => {
  const filters = {
    overview: { mode: 'days', days: 30 }, products: { mode: 'days', days: 7 }, invoices: { mode: 'days', days: 3 },
    customers: { mode: 'all' }, newPurchases: { mode: 'days', days: 60 },
    newlyImported: { mode: 'days', days: 14 }, newProducts: { mode: 'days', days: 30 }
  };
  assert.equal(pickFilters(filters, resolveViewPlan()), filters);
  assert.deepEqual(pickFilters(filters, resolveViewPlan(['invoices'])), { invoices: { mode: 'days', days: 3 } });
  assert.deepEqual(pickFilters(filters, resolveViewPlan(['debt'])), {});
  // Doi bo loc Hoa don khong doi khoa cua Tong quan / Hang hoa.
  const changed = { ...filters, invoices: { mode: 'days', days: 90 } };
  assert.deepEqual(pickFilters(changed, resolveViewPlan(['overview'])), pickFilters(filters, resolveViewPlan(['overview'])));
  assert.deepEqual(pickFilters(changed, resolveViewPlan(['products'])), pickFilters(filters, resolveViewPlan(['products'])));
  // Bo loc Hang moi nhap chi doi khoa cua Hang hoa, khong doi khoa cua Tong quan.
  const niChanged = { ...filters, newlyImported: { mode: 'days', days: 7 } };
  assert.notDeepEqual(pickFilters(niChanged, resolveViewPlan(['products'])), pickFilters(filters, resolveViewPlan(['products'])));
  assert.deepEqual(pickFilters(niChanged, resolveViewPlan(['overview'])), pickFilters(filters, resolveViewPlan(['overview'])));
});

test('pickPayload: cat dung phan cua tab, khong sua ban day du, khoa long `products` cua Tong quan chi co 2 truong', () => {
  const full = {
    updatedAt: 'x',
    filters: { overview: 1, products: 2, productStatus: 'all', invoices: 3, customers: 4, newPurchases: 5, newProducts: 6 },
    kpi: {
      revenueToday: 1, invoicesToday: 2, cancelledToday: 3, totalStock: 4, totalProducts: 5, lowStockCount: 6,
      totalCustomers: 7, customersWithDebt: 8, totalDebt: 9, totalSuppliers: 10, inStockCodes: 11
    },
    overview: { a: 1 },
    products: { childCategorySalesByParent: { X: [] }, availableParentCategories: ['X'], allSellingProducts: [1, 2, 3] },
    invoices: { big: 1 }, customers: { topDebt: [] }, lowStock: [1], allProducts: [1], suppliers: [1], debtManagement: { k: 1 }
  };
  const snapshot = JSON.stringify(full);

  const overview = pickPayload(full, resolveViewPlan(['overview']));
  assert.deepEqual(Object.keys(overview).sort(), ['filters', 'kpi', 'overview', 'products', 'updatedAt']);
  assert.deepEqual(overview.products, { childCategorySalesByParent: { X: [] }, availableParentCategories: ['X'] });
  assert.deepEqual(overview.filters, { overview: 1, products: 2, productStatus: 'all' });
  assert.equal(overview.kpi.revenueToday, 1);
  assert.equal(overview.kpi.totalSuppliers, undefined, 'KPI nha cung cap khong thuoc tab Tong quan');

  const products = pickPayload(full, resolveViewPlan(['products']));
  assert.equal(products.products, full.products, 'tab Hang hoa lay nguyen ca khoa products');
  assert.deepEqual(products.lowStock, [1]);
  assert.equal(products.invoices, undefined);

  const both = pickPayload(full, resolveViewPlan(['overview', 'products']));
  assert.equal(both.products, full.products, 'khi co ca Hang hoa thi products day du thang partial cua Tong quan');
  assert.equal(both.overview.a, 1);

  const debt = pickPayload(full, resolveViewPlan(['debt']));
  assert.deepEqual(Object.keys(debt).sort(), ['debtManagement', 'filters', 'kpi', 'updatedAt']);
  assert.deepEqual(debt.kpi, {});

  assert.equal(pickPayload(full, resolveViewPlan()), full, 'ke hoach ca 6 tab tra nguyen ban day du');
  assert.equal(JSON.stringify(full), snapshot, 'khong duoc sua ban day du (co the la object trong cache dung chung)');
});
