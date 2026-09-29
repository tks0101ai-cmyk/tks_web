// ==========================================
// TAB (VIEW) CUA "BAO CAO TONG HOP" — khai bao thuan (khong I/O).
//
// Truoc day GET /api/dashboard luon doc + tinh + tra du lieu cua CA 6 tab du
// nguoi dung chi dang xem 1 tab (do that: doc nguon ~9,8s khi cache nguoi, doi
// 1 bo loc ~0,9s, payload 5,25 MB). Bay gio client co the goi
// GET /api/dashboard?view=<tab> de chi doc/tinh/tra phan cua tab do:
//   - `coreKeys`: cac bang nguon (sheet "core") + CN1/3/7 tab nay can doc;
//   - `rollups`: cac truy van rollup tab nay can;
//   - `needsDebt`: co can workbook cong no + workflow (Google Sheets) hay khong;
//   - `filterKeys`: khoa cua object `filters` anh huong tab nay (vao cache key,
//     nen doi bo loc cua tab khac khong lam mat cache cua tab nay);
//   - VIEW_PAYLOAD: phan payload tab nay tra ve.
// Bo trong `view` = ca 6 tab, y het hanh vi cu (test + nguoi goi cu khong doi).
// ==========================================
'use strict';

const CONFIG = require('../config');

const VIEW_NAMES = Object.freeze(['overview', 'products', 'invoices', 'customers', 'suppliers', 'debt']);

// Quyen can co de xem tung tab — khop SECTION_FEATURE (dashboardPermissionFilter.js).
const VIEW_FEATURE = Object.freeze({
  overview: 'reports.overview',
  products: 'reports.products',
  invoices: 'reports.invoices',
  customers: 'reports.customers',
  suppliers: 'reports.suppliers',
  debt: 'reports.debt'
});

// Khoa dac biet trong danh sach nguon: bo CN1/CN3/CN7 (customerDebtActivityRepository).
const PERIODS_KEY = '@periods';

const CORE_SHEETS_ORDER = Object.freeze([
  CONFIG.SHEET_CATEGORIES, CONFIG.SHEET_PRODUCTS, CONFIG.SHEET_INVOICES, CONFIG.SHEET_ORDERS,
  CONFIG.SHEET_RETURNS, CONFIG.SHEET_CUSTOMERS, CONFIG.SHEET_SUPPLIERS
]);
const ALL_CORE_KEYS = Object.freeze([...CORE_SHEETS_ORDER, PERIODS_KEY]);

const ALL_ROLLUPS = Object.freeze([
  'overviewRevenue', 'invoicesRevenue', 'productSales', 'newlyImportedSales', 'firstPurchase',
  'purchaseTotals', 'newPurchaseOrders', 'invoiceQuantity'
]);

const VIEW_SOURCES = Object.freeze({
  // Tong quan: KPI (hang hoa/hoa don hom nay/khach hang) + 2 bieu do tron doanh thu theo nhom hang.
  overview: {
    sheets: [CONFIG.SHEET_CATEGORIES, CONFIG.SHEET_PRODUCTS, CONFIG.SHEET_INVOICES, CONFIG.SHEET_CUSTOMERS],
    rollups: ['overviewRevenue', 'productSales'],
    needsDebt: false
  },
  // newlyImportedSales: doanh thu hang moi nhap (phan 5) theo bo loc rieng ni.
  products: {
    sheets: [CONFIG.SHEET_CATEGORIES, CONFIG.SHEET_PRODUCTS],
    rollups: ['productSales', 'newlyImportedSales', 'firstPurchase'],
    needsDebt: false
  },
  // Dat hang (~23K dong) + Tra hang chi tab Hoa don can.
  invoices: {
    sheets: [CONFIG.SHEET_INVOICES, CONFIG.SHEET_ORDERS, CONFIG.SHEET_RETURNS],
    rollups: ['invoicesRevenue', 'invoiceQuantity'],
    needsDebt: false
  },
  customers: {
    sheets: [CONFIG.SHEET_CUSTOMERS, CONFIG.SHEET_INVOICES, CONFIG.SHEET_RETURNS],
    rollups: [],
    needsDebt: false
  },
  suppliers: {
    sheets: [CONFIG.SHEET_SUPPLIERS],
    rollups: ['purchaseTotals', 'newPurchaseOrders'],
    needsDebt: false
  },
  // Cong no: workbook Google Sheets + workflow Postgres + CN1/3/7, KHONG dung bang nguon core.
  debt: {
    sheets: [],
    periods: true,
    rollups: [],
    needsDebt: true
  }
});

// Khoa cua object `filters` (xem routes.js) anh huong ket qua cua tab.
const VIEW_FILTER_KEYS = Object.freeze({
  overview: ['overview', 'products'],
  products: ['products', 'newlyImported', 'newProducts'],
  invoices: ['invoices'],
  customers: ['customers'],
  suppliers: ['newPurchases'],
  debt: []
});

// Phan payload moi tab tra ve. `top`: khoa top-level tra nguyen; `nested`: chi
// mot so truong con cua khoa do (vd Tong quan chi can 2 truong cua `products`
// cho bieu do nhom hang, khong keo ca bang san pham); `kpi`/`filters`: truong
// con cua 2 khoa luon co mat. Moi truong o day PHAI duoc computeDashboardData()
// tinh cho tab do — test "moi tab tra dung lat cat cua ban day du" giu dieu do.
const VIEW_PAYLOAD = Object.freeze({
  overview: {
    top: ['overview'],
    nested: { products: ['childCategorySalesByParent', 'availableParentCategories'] },
    kpi: [
      'revenueToday', 'invoicesToday', 'cancelledToday', 'totalStock', 'totalProducts',
      'lowStockCount', 'totalCustomers', 'customersWithDebt', 'totalDebt'
    ],
    filters: ['overview', 'products', 'productStatus']
  },
  products: {
    top: ['products', 'lowStock', 'stockValueByCategory', 'allProducts', 'stockByCategory'],
    nested: {},
    kpi: [
      'totalProducts', 'totalStock', 'inStockCodes', 'activeProducts', 'inactiveProducts',
      'lowStockCount', 'totalInventoryValue', 'inventoryValueCategoryCount'
    ],
    filters: ['products', 'productStatus', 'newlyImported', 'newProducts']
  },
  invoices: {
    top: ['invoices'],
    nested: {},
    kpi: [],
    filters: ['invoices']
  },
  customers: {
    top: ['customers'],
    nested: {},
    kpi: ['totalCustomers', 'customersWithDebt', 'totalDebt'],
    filters: ['customers']
  },
  suppliers: {
    top: ['suppliers', 'newPurchases'],
    nested: {},
    kpi: [
      'totalSuppliers', 'suppliersWithDebt', 'totalSupplierDebt', 'purchaseOrdersCount',
      'totalPurchaseSpend', 'newPurchasesOrderCount', 'newPurchasesTotalAmount', 'newPurchasesSupplierCount'
    ],
    filters: ['newPurchases']
  },
  debt: {
    top: ['debtManagement'],
    nested: {},
    kpi: [],
    filters: []
  }
});

function invalidViewError(name) {
  const error = new Error(`Tab báo cáo không hợp lệ: ${name}`);
  error.code = 'INVALID_VIEW';
  error.statusCode = 400;
  return error;
}

/**
 * Doc tham so query `view` ("overview" hoac "overview,products"). Bo trong =>
 * null (ca 6 tab). Ten sai => nem loi 400 INVALID_VIEW.
 */
function parseViewsParam(raw) {
  if (raw === undefined || raw === null) return null;
  const text = Array.isArray(raw) ? raw.join(',') : String(raw);
  const names = text.split(',').map(item => item.trim()).filter(Boolean);
  if (!names.length) return null;
  names.forEach(name => {
    if (!VIEW_NAMES.includes(name)) throw invalidViewError(name);
  });
  return Array.from(new Set(names));
}

function unionInOrder(order, lists) {
  const wanted = new Set(lists.flat());
  return order.filter(item => wanted.has(item));
}

/**
 * Ke hoach doc/tinh cho 1 tap tab. `rawViews` = mang ten tab, hoac
 * undefined/null = ca 6 tab (hanh vi cu).
 */
function resolveViewPlan(rawViews) {
  const all = rawViews === undefined || rawViews === null;
  const requested = all ? VIEW_NAMES.slice() : Array.from(new Set(rawViews));
  requested.forEach(name => {
    if (!VIEW_NAMES.includes(name)) throw invalidViewError(name);
  });
  const views = VIEW_NAMES.filter(name => requested.includes(name));
  const viewSet = new Set(views);

  const sheets = unionInOrder(CORE_SHEETS_ORDER, views.map(name => VIEW_SOURCES[name].sheets));
  const needsPeriods = views.some(name => VIEW_SOURCES[name].periods);
  const coreKeys = needsPeriods ? [...sheets, PERIODS_KEY] : sheets;
  const rollups = new Set(unionInOrder(ALL_ROLLUPS, views.map(name => VIEW_SOURCES[name].rollups)));
  const filterKeys = unionInOrder(
    ['overview', 'products', 'invoices', 'customers', 'newPurchases', 'newlyImported', 'newProducts'],
    views.map(name => VIEW_FILTER_KEYS[name])
  );

  return Object.freeze({
    all,
    views,
    key: all ? 'all' : views.join('+'),
    has: name => viewSet.has(name),
    coreKeys,
    rollups,
    needsDebt: views.some(name => VIEW_SOURCES[name].needsDebt),
    filterKeys
  });
}

/**
 * Cat ban tinh day du (shape cu cua computeDashboardData) ve dung phan cua cac
 * tab trong `plan`. Ke hoach "ca 6 tab" tra nguyen ban day du (khong doi shape).
 * Luon tra object MOI cho ban cat — khong sua `full` (co the la object trong cache).
 */
function pickPayload(full, plan) {
  if (plan.all) return full;
  const top = new Set();
  const nested = new Map();
  const kpiKeys = new Set();
  const filterKeys = new Set();
  plan.views.forEach(name => {
    const spec = VIEW_PAYLOAD[name];
    spec.top.forEach(key => top.add(key));
    Object.keys(spec.nested).forEach(parent => {
      if (!nested.has(parent)) nested.set(parent, new Set());
      spec.nested[parent].forEach(child => nested.get(parent).add(child));
    });
    spec.kpi.forEach(key => kpiKeys.add(key));
    spec.filters.forEach(key => filterKeys.add(key));
  });

  const picked = { updatedAt: full.updatedAt, filters: {}, kpi: {} };
  filterKeys.forEach(key => { if (key in full.filters) picked.filters[key] = full.filters[key]; });
  kpiKeys.forEach(key => { if (key in full.kpi) picked.kpi[key] = full.kpi[key]; });
  top.forEach(key => { if (key in full) picked[key] = full[key]; });
  nested.forEach((children, parent) => {
    if (top.has(parent) || !full[parent]) return; // da lay nguyen ca khoa
    picked[parent] = {};
    children.forEach(child => { if (child in full[parent]) picked[parent][child] = full[parent][child]; });
  });
  return picked;
}

/** Chi giu cac bo loc anh huong `plan` — dung lam cache key (ke hoach ca 6 tab: giu het). */
function pickFilters(filters, plan) {
  const source = filters || {};
  if (plan.all) return source;
  const picked = {};
  plan.filterKeys.forEach(key => { if (source[key] !== undefined) picked[key] = source[key]; });
  return picked;
}

module.exports = {
  VIEW_NAMES,
  VIEW_FEATURE,
  VIEW_PAYLOAD,
  PERIODS_KEY,
  ALL_CORE_KEYS,
  ALL_ROLLUPS,
  parseViewsParam,
  resolveViewPlan,
  pickPayload,
  pickFilters
};
