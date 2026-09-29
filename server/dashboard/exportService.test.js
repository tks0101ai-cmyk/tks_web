'use strict';

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
// Test khong bao gio duoc cham DB that (readRowsByCodes/getDashboardData deu bi stub).
process.env.SUPABASE_DB_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const CONFIG = require('../config');
const dashboardData = require('./dashboardData');
const dashboardPgReader = require('./dashboardPgReader');
const productReportRepository = require('./productReportRepository');
const catalog = require('./exportFieldCatalog');
const exportService = require('./exportService');

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// ---------- Du lieu gia lap ----------

// Dong nguon theo ALIAS cua catalogue (gia tri rong = null nhu Postgres tra ve).
function sourceRow(sourceKey, values) {
  const row = {};
  catalog.getSourceFields(sourceKey).forEach(item => { row[item.key] = null; });
  return Object.assign(row, values);
}

function buildRowsBySheet() {
  const purchaseBase = {
    chi_nhanh: 'CN1', ma_nhap_hang: 'PN-01', thoi_gian: '14/08/2026 07:00', ma_nha_cung_cap: 'NCC-01',
    ten_nha_cung_cap: 'Nhà cung cấp A', tong_tien_hang: 100000, giam_gia_phieu_nhap: 0,
    can_tra_ncc: 100000, tien_da_tra_ncc: 0, tong_so_luong: 3, tong_so_mat_hang: 2, trang_thai: 'Đã nhập hàng'
  };
  return {
    [CONFIG.SHEET_PRODUCTS]: [
      sourceRow('products', { ma_hang: '00123', ten_hang: '=Tên có công thức', gia_ban: 150000, ngay_tao: '14/08/2026 08:00' })
    ],
    [CONFIG.SHEET_INVOICES]: [
      sourceRow('invoices', { ma_hoa_don: 'HD-01', ngay_ban: '14/08/2026 09:00', khach_hang: 'Khách A', tong_tien_hang: 300000 })
    ],
    [CONFIG.SHEET_ORDERS]: [
      sourceRow('orders', { ma_dat_hang: 'DH-01', ngay_dat: '14/08/2026 09:10', khach_hang: 'Khách A', tong_tien: 250000 })
    ],
    [CONFIG.SHEET_RETURNS]: [
      sourceRow('returns', { ma_tra_hang: 'TH-01', ngay_tra: '14/08/2026 10:00', khach_hang: 'Khách A', tong_tien_tra: 50000 })
    ],
    [CONFIG.SHEET_CUSTOMERS]: [
      sourceRow('customers', { ma_khach_hang: 'KH-01', ten_khach_hang: 'Khách A', dien_thoai: '0900123456', no_hien_tai: 100000 })
    ],
    [CONFIG.SHEET_SUPPLIERS]: [
      sourceRow('suppliers', { ma_ncc: 'NCC-01', ten_ncc: 'Nhà cung cấp A', dien_thoai: '0280011223', no_can_tra: 200000 })
    ],
    [CONFIG.SHEET_PURCHASES]: [
      sourceRow('purchases', { ...purchaseBase, ma_hang: '00123', ten_hang: 'Sản phẩm A', so_luong: 1 }),
      sourceRow('purchases', { ...purchaseBase, ma_hang: 'SP-02', ten_hang: 'Sản phẩm B', so_luong: 2 }),
      sourceRow('purchases', { ...purchaseBase, ma_nhap_hang: 'PN-99', ma_hang: 'SP-99', ten_hang: 'Phiếu khác', so_luong: 9 })
    ]
  };
}

function buildDashboard() {
  return {
    newPurchases: { orders: [{ code: 'PN-01' }] },
    products: {
      newProducts: { products: [{ code: '00123' }] },
      topSellingProducts: [{ code: '00123', qty: 2, revenue: 300000 }],
      topSellingParentCategories: [{ name: 'Áo', qty: 2, revenue: 300000, productCount: 1 }],
      newlyImported: { products: [{ code: '00123', firstImportDate: '14/08/2026', daysOnHand: 1, revenue: 300000 }] },
      childCategorySalesByParent: { Áo: [{ name: 'Áo thun', qty: 2, revenue: 300000, productCount: 1 }] }
    },
    lowStock: [{ code: '00123' }],
    allProducts: [{ code: '00123', pct: 100 }],
    invoices: {
      transactionsReport: { transactions: [{ code: 'HD-01', quantity: 2, quantityKnown: true }] },
      periodOrders: [{ code: 'DH-01' }],
      periodReturns: [{ code: 'TH-01' }]
    },
    customers: {
      topRevenue: { all: [{ code: 'KH-01', saleOrderCount: 2, revenue: 300000 }] },
      topDebt: [{ code: 'KH-01', periodRevenue: 300000 }]
    },
    suppliers: [{ code: 'NCC-01' }],
    debtManagement: {
      available: true,
      sourceSheet: 'Công nợ HN',
      customers: [
        {
          customerKey: 'khach-a', customerName: 'Khách A', sale: 'Lan', paymentSchedule: '1',
          openingDebt: 100000, currentDebt: 800000, overdueDebt: 500000,
          currentDebtToSalesRatio: 0.4, overdueToSalesRatio: 0.25,
          alertCodes: ['uncollected', 'overdue'], dataIssues: [],
          workflowStatus: 'Chưa xử lý', needsAction: true,
          updatedBy: '=Người cập nhật', updatedAt: '14/08/2026 10:00:00'
        },
        {
          customerKey: 'khach-b', customerName: 'Khách B', sale: 'Minh', paymentSchedule: '7',
          openingDebt: null, currentDebt: 1200000, overdueDebt: 0,
          currentDebtToSalesRatio: null, overdueToSalesRatio: null,
          alertCodes: [], dataIssues: ['duplicate_customer_name'],
          workflowStatus: 'Đã xử lý', needsAction: false,
          updatedBy: 'Quản lý', updatedAt: '15/08/2026 08:30:00'
        }
      ]
    }
  };
}

/**
 * Thay getDashboardData + readRowsByCodes bang stub (du lieu dashboard bi deep-freeze
 * de lo moi hanh vi sua cache dung chung). Tra ve { calls, dashboard, restore }.
 */
function installStubs(options = {}) {
  const calls = { dashboard: [], rows: [], rowOptions: [] };
  const dashboard = deepFreeze(options.dashboard || buildDashboard());
  const rowsBySheet = options.rowsBySheet || buildRowsBySheet();
  const originals = {
    getDashboardData: dashboardData.getDashboardData,
    readRowsByCodes: dashboardPgReader.readRowsByCodes
  };
  dashboardData.getDashboardData = async (...args) => {
    calls.dashboard.push(args);
    if (options.onDashboard) await options.onDashboard(...args);
    return dashboard;
  };
  dashboardPgReader.readRowsByCodes = async (sheetName, branch, codes, readOptions) => {
    calls.rows.push({ sheetName, branch, codes: Array.from(codes) });
    calls.rowOptions.push(readOptions);
    if (options.onRows) await options.onRows(sheetName, branch, codes);
    const source = catalog.getSourceBySheetName(sheetName);
    const wanted = new Set(codes);
    return {
      columns: source.fields.map(item => item.key),
      rows: (rowsBySheet[sheetName] || []).filter(row => wanted.has(row[source.codeKey])).map(row => ({ ...row }))
    };
  };
  return {
    calls,
    dashboard,
    restore() {
      dashboardData.getDashboardData = originals.getDashboardData;
      dashboardPgReader.readRowsByCodes = originals.readRowsByCodes;
    }
  };
}

async function withStubs(options, fn) {
  const stubs = installStubs(options);
  try {
    return await fn(stubs);
  } finally {
    stubs.restore();
  }
}

const FIXED_TABLES = [
  'overview.transactions', 'overview.purchases', 'overview.new-products',
  'products.top-selling', 'products.low-stock', 'products.all', 'products.newly-imported',
  'products.child-categories', 'invoices.orders', 'invoices.returns',
  'customers.revenue', 'customers.debt', 'suppliers.list', 'debt.management'
];

const FIXED_CONTEXT = { productAnalysis: 'product', childCategoryParent: 'Áo', debtQueue: 'all' };
const PRODUCT_COLUMNS = ['ma_hang', 'ten_hang', 'gia_ban'];

const STOCKOUT_ROWS = [{
  code: 'SP001', name: 'Ao thun', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6,
  stockoutCount: 1, totalStockoutDays: 6, currentOnHand: 3, hasUnreliableData: false,
  periods: [{ fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 }]
}];

// Payload hop le cho MOI tableKey (tru search.results) de kiem tra buoc lay truong.
function payloadFor(tableKey, extra = {}) {
  const payload = { tableKey, filters: {}, context: { ...FIXED_CONTEXT }, ...extra };
  if (tableKey === 'customers.productDetail') {
    payload.context = { customerProductCustomerCode: 'KH-01', customerProductCustomerName: 'Khách A' };
  }
  if (tableKey === 'stockout.recentScan') payload.recentStockoutResult = { branch: 'Hà Nội', rows: STOCKOUT_ROWS };
  if (tableKey === 'stockout.check90d') payload.stockout90dResult = { branch: 'Hà Nội', rows: STOCKOUT_ROWS };
  if (tableKey === 'stockout.check30d') payload.stockout30dResult = { branch: 'Hà Nội', rows: STOCKOUT_ROWS };
  return payload;
}

const ALL_STATIC_TABLES = exportService.__test__.TABLE_SPEC_KEYS;

function fixedEnv(stubs, branch = 'Hà Nội') {
  return { dashboard: stubs.dashboard, branch };
}

async function loadWorkbook(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  return workbook;
}

// ---------- Bang co dinh: dataset, loc, purchases, cong no ----------

test('registry dung du 14 bang va tao duoc dataset voi cot lay tu catalogue', async () => {
  await withStubs({}, async stubs => {
    assert.deepEqual(ALL_STATIC_TABLES.filter(key => FIXED_TABLES.includes(key)).sort(), FIXED_TABLES.slice().sort());
    for (const tableKey of FIXED_TABLES) {
      const dataset = await exportService.__test__.buildFixedDataset(tableKey, fixedEnv(stubs), FIXED_CONTEXT);
      assert.equal(dataset.tableKey, tableKey);
      assert.ok(dataset.worksheets.length >= 1, `${tableKey} phai co worksheet`);
      dataset.worksheets.forEach(worksheet => assert.ok(worksheet.columns.length >= 1));
    }
  });
});

test('cot tho cua bang co dinh lay theo catalogue: khoa la alias, nhan/kieu/mo ta tu catalogue', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('products.all', fixedEnv(stubs), {});
    const columns = dataset.worksheets[0].columns;
    const catalogFields = catalog.getSourceFields('products');
    assert.deepEqual(columns.slice(0, catalogFields.length).map(column => column.key), catalogFields.map(item => item.key));
    columns.slice(0, catalogFields.length).forEach((column, index) => {
      assert.equal(column.label, catalogFields[index].label);
      assert.equal(column.type, catalogFields[index].type);
      assert.equal(column.description, catalogFields[index].description);
    });
    assert.equal(columns[columns.length - 1].label, 'Tỷ trọng tồn kho');
    assert.equal(dataset.worksheets[0].codeKey, 'ma_hang');
    const row = dataset.worksheets[0].rows[0];
    assert.equal(row.ma_hang, '00123');
    assert.equal(row.gia_ban, 150000);
    assert.equal(row.d_stock_ratio, 1);
  });
});

test('buildFixedDataset loc tim thuong va nhieu ma truoc khi tao worksheet', async () => {
  await withStubs({}, async stubs => {
    const noMatch = await exportService.__test__.buildFixedDataset(
      'products.all', fixedEnv(stubs), {}, { mode: 'normal', query: 'không tồn tại' }
    );
    assert.equal(noMatch.worksheets[0].rows.length, 0);

    const codes = await exportService.__test__.buildFixedDataset(
      'products.all', fixedEnv(stubs), {}, { mode: 'codes', query: '00123 SP-404' }
    );
    const codeColumn = codes.worksheets[0].columns.find(column => column.label === 'Mã hàng');
    assert.ok(codeColumn);
    assert.deepEqual(codes.worksheets[0].rows.map(row => row[codeColumn.key]), ['00123']);

    const blank = await exportService.__test__.buildFixedDataset('products.all', fixedEnv(stubs), {}, { mode: 'normal', query: '' });
    assert.equal(blank.worksheets[0].rows.length, 1);
  });
});

test('tim kiem thuong quet ca cot khong nam trong danh sach cot da chon roi moi cat con cot da chon', async () => {
  await withStubs({}, async stubs => {
    // "Khách A" chi xuat hien o cot khach_hang; chi chon 1 cot ma_hoa_don van phai tim thay.
    const dataset = await exportService.__test__.buildFixedDataset(
      'overview.transactions', fixedEnv(stubs), {}, { mode: 'normal', query: 'khach a' }, { transactions: ['ma_hoa_don'] }
    );
    assert.deepEqual(dataset.worksheets[0].rows, [{ ma_hoa_don: 'HD-01' }]);
  });
});

test('lọc danh sách nhập hàng giữ worksheet chi tiết cùng mã phiếu đã lọc', async () => {
  await withStubs({}, async stubs => {
    const noMatch = await exportService.__test__.buildFixedDataset(
      'overview.purchases', fixedEnv(stubs), {}, { mode: 'codes', query: 'PN-404' }
    );
    assert.equal(noMatch.worksheets[0].rows.length, 0);
    assert.equal(noMatch.worksheets[1].rows.length, 0);

    const matched = await exportService.__test__.buildFixedDataset(
      'overview.purchases', fixedEnv(stubs), {}, { mode: 'codes', query: 'PN-01' }
    );
    assert.equal(matched.worksheets[0].rows.length, 1);
    assert.equal(matched.worksheets[1].rows.length, 2);
  });
});

test('Nhap hang: worksheet tong hop 16 cot cap phieu + chi tiet 24 cot, moi dong hang cua cac phieu logic', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('overview.purchases', fixedEnv(stubs), {});
    assert.deepEqual(dataset.worksheets.map(sheet => sheet.name), ['Tổng hợp phiếu', 'Chi tiết mặt hàng']);
    assert.deepEqual(dataset.worksheets[0].columns.map(column => column.key), catalog.PURCHASE_SUMMARY_KEYS);
    assert.equal(dataset.worksheets[0].columns.length, 16);
    assert.equal(dataset.worksheets[1].columns.length, 24);
    assert.equal(dataset.worksheets[0].rows.length, 1);
    assert.equal(dataset.worksheets[1].rows.length, 2, 'chi lay dong hang cua phieu PN-01, khong lay PN-99');
    assert.deepEqual(dataset.worksheets[1].rows.map(row => row.ma_hang), ['00123', 'SP-02']);
    assert.ok(dataset.worksheets[1].columns.some(column => column.label === 'Mã hàng'));
    assert.equal(dataset.worksheets[0].rows[0].ma_nhap_hang, 'PN-01');
    assert.equal(dataset.worksheets[0].rows[0].ma_hang, undefined, 'tong hop phieu khong co cot cap dong hang');
    assert.equal(stubs.calls.rows.length, 1, 'chi 1 lan doc Postgres cho ca 2 worksheet');
  });
});

test('Quản lý công nợ xuất đúng một worksheet, lọc và sort trên toàn bộ tập khách', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('debt.management', fixedEnv(stubs), {
      debtQueue: 'all',
      debtSale: '',
      debtSchedule: '',
      debtSearch: '',
      debtSort: { columnIndex: 4, direction: 'desc' }
    });
    assert.equal(dataset.worksheets.length, 1);
    assert.equal(dataset.worksheets[0].name, 'Công nợ HN');
    assert.deepEqual(dataset.worksheets[0].rows.map(row => row.customerName), ['Khách B', 'Khách A']);
    assert.equal(dataset.worksheets[0].columns.length, 12);
    assert.equal(dataset.worksheets[0].columns.filter(column => column.selected !== false).length, 10);

    const matched = await exportService.__test__.buildFixedDataset('debt.management', fixedEnv(stubs), {
      debtQueue: 'overdue', debtSale: 'Lan', debtSchedule: '1', debtSearch: 'khách a'
    });
    assert.deepEqual(matched.worksheets[0].rows.map(row => row.customerName), ['Khách A']);

    const empty = await exportService.__test__.buildFixedDataset('debt.management', fixedEnv(stubs), {
      debtQueue: 'needsAction', debtSearch: 'không có'
    });
    assert.equal(empty.worksheets[0].rows.length, 0);
  });
});

test('Quản lý công nợ phản ánh đủ bốn bộ lọc hàng chờ', async () => {
  await withStubs({}, async stubs => {
    const names = async queue => (await exportService.__test__.buildFixedDataset('debt.management', fixedEnv(stubs), { debtQueue: queue }))
      .worksheets[0].rows.map(row => row.customerName);
    assert.deepEqual(await names('needsAction'), ['Khách A']);
    assert.deepEqual(await names('currentDebt'), ['Khách A', 'Khách B']);
    assert.deepEqual(await names('overdue'), ['Khách A']);
    assert.deepEqual(await names('all'), ['Khách A', 'Khách B']);
  });
});

test('Quản lý công nợ mặc định chọn 10 cột hiển thị và để 2 cột cập nhật là tùy chọn', async () => {
  const metadata = await exportService.getExportFields({ tableKey: 'debt.management', context: { debtQueue: 'all' } }, 'Hà Nội');
  const fields = metadata.worksheets[0].fields;
  assert.equal(fields.length, 12);
  assert.equal(fields.filter(field => field.selected).length, 10);
  assert.equal(fields.find(field => field.key === 'updatedBy').selected, false);
  assert.equal(fields.find(field => field.key === 'updatedAt').selected, false);
});

// ---------- Buoc lay truong: tinh, khong I/O ----------

test('buoc lay truong KHONG goi getDashboardData/readRowsByCodes/tim kiem voi moi bang co dinh (dem = 0), rowCount = null', async () => {
  const originals = {
    report: dashboardData.getCustomerProductRevenueReport,
    search: dashboardData.searchDashboardRecords
  };
  const forbidden = () => { throw new Error('khong duoc goi khi lay danh sach truong'); };
  dashboardData.getCustomerProductRevenueReport = forbidden;
  dashboardData.searchDashboardRecords = forbidden;
  try {
    await withStubs({}, async stubs => {
      for (const tableKey of ALL_STATIC_TABLES) {
        const metadata = await exportService.getExportFields(payloadFor(tableKey), 'Hà Nội');
        assert.equal(metadata.tableKey, tableKey);
        assert.equal(metadata.selectionMode, 'custom');
        assert.ok(metadata.worksheets.length >= 1, tableKey);
        metadata.worksheets.forEach(worksheet => {
          assert.equal(worksheet.rowCount, null, `${tableKey}/${worksheet.key}`);
          assert.ok(worksheet.fields.length >= 1);
          worksheet.fields.forEach(field => {
            assert.ok(typeof field.description === 'string' && field.description.length > 0, `${tableKey}.${field.key} thieu chu thich`);
          });
        });
      }
      assert.equal(stubs.calls.dashboard.length, 0);
      assert.equal(stubs.calls.rows.length, 0);
    });
  } finally {
    dashboardData.getCustomerProductRevenueReport = originals.report;
    dashboardData.searchDashboardRecords = originals.search;
  }
});

test('buoc lay truong van validate re: bang khong hop le, thieu khach/tu khoa, thieu ket qua stockout', async () => {
  await assert.rejects(exportService.getExportFields({ tableKey: 'khong.co' }), error => error.code === 'EXPORT_TABLE_NOT_ALLOWED' && error.statusCode === 400);
  await assert.rejects(
    exportService.getExportFields({ tableKey: 'customers.productDetail', context: {} }),
    error => error.statusCode === 400 && error.code === 'EXPORT_NO_CUSTOMER_SELECTED'
  );
  await assert.rejects(
    exportService.getExportFields({ tableKey: 'stockout.recentScan', recentStockoutResult: { rows: [] } }),
    error => error.statusCode === 400 && error.code === 'EXPORT_NO_DATA'
  );
  await assert.rejects(
    exportService.getExportFields({ tableKey: 'stockout.check90d' }),
    error => error.code === 'EXPORT_NO_DATA'
  );
  await assert.rejects(
    exportService.getExportFields({
      tableKey: 'stockout.check90d', tableSearch: { mode: 'normal', query: 'khong co' }, stockout90dResult: { rows: STOCKOUT_ROWS }
    }),
    error => error.statusCode === 404 && error.code === 'EXPORT_NO_DATA'
  );
});

test('cot o buoc lay truong == cot cua dataset o buoc xuat cho moi bang co dinh', async () => {
  const originals = {
    report: dashboardData.getCustomerProductRevenueReport,
    productReport: productReportRepository.getProductReport
  };
  dashboardData.getCustomerProductRevenueReport = async () => ({
    products: [{ code: 'SP-01', name: 'Sản phẩm một', quantity: 3, revenue: 300, month1Revenue: 1, month2Revenue: 2, month3Revenue: 3 }]
  });
  productReportRepository.getProductReport = async () => ({
    rows: [{
      code: 'SP-01', name: 'Sản phẩm một', stockHanoi: 1, stockSaigon: 2, availableToSell: 3, qtySold30d: 4,
      revenue90d: 5, customerCount90d: 6, topCustomerRevenue90d: 7, topCustomerName: 'Khách A', topCustomerShare: 0.5
    }],
    computedAt: '2026-09-23T00:05:00.000Z'
  });
  try {
    await withStubs({}, async () => {
      const payloads = ALL_STATIC_TABLES.map(tableKey => payloadFor(tableKey));
      payloads.push(payloadFor('products.top-selling', { context: { productAnalysis: 'parentCategory' } }));
      for (const payload of payloads) {
        const metadata = await exportService.getExportFields(payload, 'Hà Nội');
        const dataset = await exportService.__test__.buildExportDataset(payload, 'Hà Nội');
        const where = `${payload.tableKey} ${JSON.stringify(payload.context)}`;
        assert.equal(dataset.worksheets.length, metadata.worksheets.length, where);
        dataset.worksheets.forEach((worksheet, index) => {
          const fields = metadata.worksheets[index].fields;
          assert.equal(worksheet.key, metadata.worksheets[index].key, where);
          assert.deepEqual(worksheet.columns.map(column => column.key), fields.map(field => field.key), where);
          assert.deepEqual(worksheet.columns.map(column => column.label), fields.map(field => field.label), where);
          assert.deepEqual(worksheet.columns.map(column => column.type), fields.map(field => field.type), where);
        });
      }
    });
  } finally {
    dashboardData.getCustomerProductRevenueReport = originals.report;
    productReportRepository.getProductReport = originals.productReport;
  }
});

// ---------- Nhan chuan hoa cho ca cot derived/aggregate ----------

const FORBIDDEN_ENGLISH_TOKENS = new Set([
  'id', 'api', 'date', 'total', 'code', 'name', 'status', 'created', 'updated', 'price', 'quantity',
  'raw', 'sold', 'by', 'is', 'active', 'purchase', 'payment', 'customer', 'supplier', 'branch',
  'invoice', 'order', 'return', 'product', 'note', 'phone', 'address', 'debt', 'discount', 'fee'
]);
const FORBIDDEN_ABBREVIATIONS = new Set(['SL', 'DS', 'KH', 'NCC', 'SP', 'TT', 'HD', 'SĐT', 'SDT', 'TB', 'HN', 'SG']);

function assertStandardLabels(worksheets, where) {
  worksheets.forEach(worksheet => {
    const labels = new Set();
    const keys = new Set();
    worksheet.fields.forEach(field => {
      const label = field.label;
      const spot = `${where}/${worksheet.key}.${field.key} "${label}"`;
      assert.equal(typeof label, 'string', spot);
      assert.ok(label.length > 0 && label.length <= 40, `${spot}: do dai ${label.length}`);
      assert.equal(label, label.normalize('NFC').trim(), spot);
      assert.doesNotMatch(label, /\s{2,}/, spot);
      assert.match(label, /^\p{Lu}/u, `${spot}: phai viet hoa chu dau`);
      assert.doesNotMatch(label, /[\[\]:*?/\\]/, `${spot}: ky tu khong hop le cho header`);
      assert.doesNotMatch(label, /^[=+\-@]/, spot);
      [['label', label], ['description', field.description]].forEach(([part, text]) => {
        if (typeof text !== 'string') return;
        assert.doesNotMatch(text, /_/, `${spot} ${part}: snake_case`);
        assert.doesNotMatch(text, /(^|\s)T\.(\s|$)/, `${spot} ${part}: viet tat "T."`);
        text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).forEach(token => {
          assert.ok(!FORBIDDEN_ENGLISH_TOKENS.has(token.toLowerCase()), `${spot} ${part}: tu tieng Anh "${token}"`);
          assert.ok(!FORBIDDEN_ABBREVIATIONS.has(token.toUpperCase()), `${spot} ${part}: viet tat "${token}"`);
        });
      });
      assert.ok(!labels.has(label), `${spot}: nhan trung trong worksheet`);
      assert.ok(!keys.has(field.key), `${spot}: key trung trong worksheet`);
      labels.add(label);
      keys.add(field.key);
    });
  });
}

test('moi nhan cua moi bang co dinh (ca cot derived/aggregate) dat chuan hoa', async () => {
  const payloads = ALL_STATIC_TABLES.map(tableKey => payloadFor(tableKey));
  payloads.push(payloadFor('products.top-selling', { context: { productAnalysis: 'parentCategory' } }));
  for (const payload of payloads) {
    const metadata = await exportService.getExportFields(payload, 'Hà Nội');
    assertStandardLabels(metadata.worksheets, payload.tableKey);
  }
});

test('nhan derived/aggregate da doi theo quy uoc chuan hoa', async () => {
  const labelsOf = async (tableKey, extra) => {
    const metadata = await exportService.getExportFields(payloadFor(tableKey, extra), 'Hà Nội');
    return metadata.worksheets[0].fields.map(field => field.label);
  };
  assert.deepEqual(await labelsOf('customers.productDetail'),
    ['Tên hàng', 'Số lượng', 'Doanh thu', 'Doanh thu tháng này', 'Doanh thu tháng trước', 'Doanh thu 2 tháng trước']);
  const debt = await labelsOf('debt.management');
  assert.ok(debt.includes('Nhân viên phụ trách (Sale)'));
  assert.ok(debt.includes('Lịch thanh toán'));
  assert.deepEqual((await labelsOf('stockout.recentScan')).slice(0, 2), ['Mã hàng', 'Tên hàng']);
  assert.ok((await labelsOf('stockout.check90d')).includes('Số ngày đứt hàng trung bình'));
  assert.ok((await labelsOf('products.all')).includes('Tỷ trọng tồn kho'));
});

// ---------- Tao file xlsx ----------

test('ca 14 bang tao duoc file xlsx tu danh sach truong API tra ve', async () => {
  await withStubs({}, async stubs => {
    for (const tableKey of FIXED_TABLES) {
      const payload = { tableKey, filters: {}, context: { ...FIXED_CONTEXT } };
      const metadata = await exportService.getExportFields(payload);
      payload.columns = Object.fromEntries(metadata.worksheets.map(worksheet => [
        worksheet.key,
        worksheet.fields.map(field => field.key)
      ]));
      if (tableKey === 'debt.management') {
        assert.equal(metadata.worksheets[0].fields.filter(field => field.selected).length, 10);
      } else {
        assert.ok(metadata.worksheets.every(worksheet => worksheet.fields.every(field => field.selected)));
      }
      const file = await exportService.createExportWorkbook(payload);
      const workbook = await loadWorkbook(file);
      assert.equal(workbook.worksheets.length, metadata.worksheets.length, tableKey);
      workbook.worksheets.forEach((worksheet, index) => {
        assert.deepEqual(
          worksheet.getRow(1).values.slice(1),
          metadata.worksheets[index].fields.map(field => field.label),
          `${tableKey}: header Excel phai khop nhan buoc lay truong`
        );
      });
    }
  });
});

test('file Quản lý công nợ giữ kiểu số/phần trăm/text, freeze, AutoFilter và tên theo cơ sở', async () => {
  await withStubs({}, async () => {
    const payload = {
      tableKey: 'debt.management', context: { debtQueue: 'all' },
      columns: { debt_management: ['customerName', 'openingDebt', 'currentDebtToSalesRatio', 'updatedBy', 'updatedAt'] }
    };
    const hn = await exportService.createExportWorkbook(payload, 'Hà Nội');
    assert.match(hn.fileName, /^HN_Quan_ly_cong_no_\d{8}_\d{4}\.xlsx$/);
    const workbook = await loadWorkbook(hn);
    const worksheet = workbook.worksheets[0];
    assert.equal(worksheet.name, 'Công nợ HN');
    assert.equal(worksheet.getCell('B2').value, 100000);
    assert.equal(worksheet.getCell('C2').value, 0.4);
    assert.equal(worksheet.getColumn(3).numFmt, '0.00%');
    assert.equal(worksheet.getCell('D2').value, "'=Người cập nhật");
    assert.ok(worksheet.getCell('E2').value instanceof Date);
    assert.equal(worksheet.views[0].ySplit, 1);
    assert.ok(worksheet.autoFilter);
  });

  const sgDashboard = buildDashboard();
  sgDashboard.debtManagement.sourceSheet = 'Công nợ SG';
  await withStubs({ dashboard: sgDashboard }, async () => {
    const sg = await exportService.createExportWorkbook({
      tableKey: 'debt.management', context: { debtQueue: 'all' },
      columns: { debt_management: ['customerName'] }
    }, 'Sài Gòn');
    assert.match(sg.fileName, /^SG_Quan_ly_cong_no_\d{8}_\d{4}\.xlsx$/);
    const workbook = await loadWorkbook(sg);
    assert.equal(workbook.worksheets[0].name, 'Công nợ SG');
  });
});

test('workbook giu ma co so 0 dau, chan chuoi cong thuc va bat freeze/autofilter', async () => {
  const rows = buildRowsBySheet();
  rows[CONFIG.SHEET_PRODUCTS][0].ma_hang = '00123';
  await withStubs({ rowsBySheet: rows }, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'products.all',
      filters: {},
      columns: { all_products: PRODUCT_COLUMNS }
    });
    assert.match(file.fileName, /^TKS_Tat_ca_ma_hang_\d{8}_\d{4}\.xlsx$/);
    const workbook = await loadWorkbook(file);
    const worksheet = workbook.worksheets[0];
    assert.equal(worksheet.getCell('A2').value, '00123');
    assert.equal(worksheet.getCell('B2').value, "'=Tên có công thức");
    assert.equal(worksheet.getCell('C2').value, 150000);
    assert.equal(worksheet.views[0].ySplit, 1);
    assert.ok(worksheet.autoFilter);
  });
});

test('dien thoai khach giu so 0 dau (text) khi xuat', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'customers.revenue',
      columns: { customer_revenue: ['ma_khach_hang', 'dien_thoai', 'd_period_revenue'] }
    });
    const workbook = await loadWorkbook(file);
    assert.equal(workbook.worksheets[0].getCell('B2').value, '0900123456');
    assert.equal(workbook.worksheets[0].getCell('C2').value, 300000);
  });
});

test('cot number toan gia tri so nguyen thi khong hien .00', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'products.all',
      filters: {},
      columns: { all_products: PRODUCT_COLUMNS }
    });
    const workbook = await loadWorkbook(file);
    assert.equal(workbook.worksheets[0].getColumn(3).numFmt, '#,##0;[Red]-#,##0');
  });
});

test('cot number co it nhat 1 gia tri thap phan thi van hien .00', async () => {
  const rows = buildRowsBySheet();
  rows[CONFIG.SHEET_PRODUCTS][0].gia_ban = 150000.5;
  await withStubs({ rowsBySheet: rows }, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'products.all',
      filters: {},
      columns: { all_products: PRODUCT_COLUMNS }
    });
    const workbook = await loadWorkbook(file);
    assert.equal(workbook.worksheets[0].getColumn(3).numFmt, '#,##0.00;[Red]-#,##0.00');
  });
});

test('header khong to mau nen, chu den, an gridline', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'products.all',
      filters: {},
      columns: { all_products: PRODUCT_COLUMNS }
    });
    const worksheet = (await loadWorkbook(file)).worksheets[0];
    const header = worksheet.getRow(1);
    assert.equal(header.font.color.argb, 'FF000000');
    header.eachCell(cell => {
      assert.equal(cell.fill === undefined || cell.fill.pattern === 'none', true);
      assert.ok(cell.border && cell.border.top && cell.border.left && cell.border.bottom && cell.border.right);
    });
    assert.equal(worksheet.views[0].showGridLines, false);
    worksheet.getRow(2).eachCell(cell => {
      assert.ok(cell.border && cell.border.top && cell.border.left && cell.border.bottom && cell.border.right);
    });
  });
});

test('ten file gan tien to HN_/SG_ theo co so dang xuat', async () => {
  await withStubs({}, async () => {
    const payload = { tableKey: 'products.all', filters: {}, columns: { all_products: PRODUCT_COLUMNS } };
    const hn = await exportService.createExportWorkbook(payload, 'Hà Nội');
    assert.match(hn.fileName, /^HN_Tat_ca_ma_hang_\d{8}_\d{4}\.xlsx$/);
    const sg = await exportService.createExportWorkbook(payload, 'Sài Gòn');
    assert.match(sg.fileName, /^SG_Tat_ca_ma_hang_\d{8}_\d{4}\.xlsx$/);
  });
});

test('createExportWorkbook chi ghi cot da chon (thu tu theo yeu cau khong quan trong, theo cot nguon)', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'overview.purchases',
      columns: { purchase_summary: ['ma_nhap_hang', 'tong_tien_hang'], purchase_details: [] }
    });
    const workbook = await loadWorkbook(file);
    assert.equal(workbook.worksheets.length, 1, 'worksheet khong chon cot nao thi bo qua');
    assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1), ['Mã nhập hàng', 'Tổng tiền hàng']);
    assert.equal(workbook.worksheets[0].getCell('A2').value, 'PN-01');
    assert.equal(workbook.worksheets[0].getCell('B2').value, 100000);
  });
});

// ---------- Nguon du lieu: dung ma, dung bo loc, khong sua cache ----------

test('readRowsByCodes nhan dung tab, co so va danh sach ma logic; getDashboardData nhan dung bo loc', async () => {
  await withStubs({}, async stubs => {
    await exportService.createExportWorkbook({
      tableKey: 'customers.revenue',
      filters: { customers: { mode: 'days', days: 45 }, overview: { mode: 'range', from: '2026-01-01T00:00:00', to: '2026-01-31' } },
      columns: { customer_revenue: ['ma_khach_hang'] }
    }, 'Sài Gòn');
    assert.equal(stubs.calls.dashboard.length, 1);
    const [filters, branch, viewer] = stubs.calls.dashboard[0];
    assert.equal(branch, 'Sài Gòn');
    assert.equal(viewer, undefined, 'viewer bo trong = khong quyen sua cong no');
    assert.deepEqual(filters.customers, { mode: 'days', days: 45 });
    assert.deepEqual(filters.overview, { mode: 'range', from: '2026-01-01', to: '2026-01-31' });
    assert.deepEqual(filters.products, { mode: 'days', days: 30, status: 'all' });
    assert.deepEqual(stubs.calls.rows, [{ sheetName: CONFIG.SHEET_CUSTOMERS, branch: 'Sài Gòn', codes: ['KH-01'] }]);
  });

  await withStubs({}, async stubs => {
    await exportService.createExportWorkbook({
      tableKey: 'overview.purchases', columns: { purchase_summary: ['ma_nhap_hang'], purchase_details: ['ma_hang'] }
    }, 'Hà Nội');
    assert.deepEqual(stubs.calls.rows, [{ sheetName: CONFIG.SHEET_PURCHASES, branch: 'Hà Nội', codes: ['PN-01'] }]);
  });
});

test('bang khong co ma logic thi khong query Postgres', async () => {
  const dashboard = buildDashboard();
  dashboard.suppliers = [];
  await withStubs({ dashboard }, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('suppliers.list', fixedEnv(stubs), {});
    assert.equal(dataset.worksheets[0].rows.length, 0);
    assert.equal(stubs.calls.rows.length, 0);
  });
});

test('dong logic khong co dong tho tuong ung van duoc xuat voi cot rong (giu hanh vi cu)', async () => {
  const dashboard = buildDashboard();
  dashboard.allProducts = [{ code: '00123', pct: 50 }, { code: 'KHONG-CO', pct: 10 }];
  await withStubs({ dashboard }, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('products.all', fixedEnv(stubs), {});
    assert.equal(dataset.worksheets[0].rows.length, 2);
    assert.equal(dataset.worksheets[0].rows[1].ma_hang, '');
    assert.equal(dataset.worksheets[0].rows[1].d_stock_ratio, 0.1);
  });
});

test('ghep dong tho theo ma da chuan hoa (NFC, hoa/thuong, dau cach thua) nhung van truyen dung ma goc cho Postgres', async () => {
  const dashboard = deepFreeze({ ...buildDashboard(), allProducts: [{ code: ' sp-á ', pct: 0 }] });
  const originals = { getDashboardData: dashboardData.getDashboardData, readRowsByCodes: dashboardPgReader.readRowsByCodes };
  const requested = [];
  dashboardPgReader.readRowsByCodes = async (sheetName, branch, codes) => {
    requested.push(Array.from(codes));
    // Postgres luu ma dang NFD + viet hoa (SP-A + dau sac roi): chi khop khi ghep theo ma da chuan hoa.
    return { columns: [], rows: [sourceRow('products', { ma_hang: 'SP-Á', ten_hang: 'Hàng A' })] };
  };
  try {
    const dataset = await exportService.__test__.buildFixedDataset('products.all', { dashboard, branch: 'Hà Nội' }, {});
    assert.deepEqual(requested, [[' sp-á ']]);
    assert.equal(dataset.worksheets[0].rows.length, 1);
    assert.equal(dataset.worksheets[0].rows[0].ten_hang, 'Hàng A');
  } finally {
    dashboardData.getDashboardData = originals.getDashboardData;
    dashboardPgReader.readRowsByCodes = originals.readRowsByCodes;
  }
});

test('xuat file khong sua ket qua dashboard dung chung (du lieu stub bi deep-freeze)', async () => {
  await withStubs({}, async stubs => {
    assert.ok(Object.isFrozen(stubs.dashboard));
    for (const tableKey of FIXED_TABLES) {
      const payload = { tableKey, context: { ...FIXED_CONTEXT, debtSort: { columnIndex: 4, direction: 'desc' } }, tableSearch: { mode: 'normal', query: 'a' } };
      const metadata = await exportService.getExportFields(payload);
      payload.columns = Object.fromEntries(metadata.worksheets.map(worksheet => [worksheet.key, worksheet.fields.map(field => field.key)]));
      await exportService.createExportWorkbook(payload, 'Hà Nội');
    }
    assert.deepEqual(stubs.dashboard, buildDashboard());
  });
});

// ---------- Validate cot truoc khi cham DB ----------

test('API dich vu tu choi tim kiem Tong quan va tu choi khi khong chon truong', async () => {
  await assert.rejects(
    exportService.getExportFields({ tableKey: 'search.results', search: { view: 'overview', query: 'abc' } }),
    error => error.code === 'EXPORT_OVERVIEW_SEARCH_DISABLED'
  );

  await withStubs({}, async () => {
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'products.all', columns: { all_products: [] } }),
      error => error.code === 'EXPORT_NO_FIELDS_SELECTED'
    );
  });
});

test('createExportWorkbook validate danh sach cot TRUOC khi nap du lieu (khong cham getDashboardData/Postgres)', async () => {
  await withStubs({}, async stubs => {
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'products.all', columns: { all_products: ['khong_co_cot_nay'] } }),
      error => error.statusCode === 400 && error.code === 'EXPORT_FIELD_NOT_ALLOWED'
    );
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'products.all', columns: {} }),
      error => error.statusCode === 400 && error.code === 'EXPORT_FIELDS_REQUIRED'
    );
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'products.all' }),
      error => error.code === 'EXPORT_FIELDS_REQUIRED'
    );
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'overview.purchases', columns: { purchase_summary: ['ma_nhap_hang'] } }),
      error => error.code === 'EXPORT_FIELDS_REQUIRED'
    );
    await assert.rejects(exportService.createExportWorkbook({ tableKey: 'bang.la' }), error => error.code === 'EXPORT_TABLE_NOT_ALLOWED');
    await assert.rejects(exportService.createExportWorkbook(undefined), error => error.code === 'EXPORT_TABLE_NOT_ALLOWED');
    assert.equal(stubs.calls.dashboard.length, 0);
    assert.equal(stubs.calls.rows.length, 0);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('chi nap cot da chon: dong dataset chi co cac khoa cot da chon', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset(
      'products.all', fixedEnv(stubs), {}, {}, { all_products: ['ma_hang', 'd_stock_ratio'] }
    );
    assert.deepEqual(Object.keys(dataset.worksheets[0].rows[0]), ['ma_hang', 'd_stock_ratio']);
    assert.equal(dataset.worksheets[0].columns.length > 2, true, 'danh sach cot day du van giu de validate allowlist');
  });
});

// ---------- Tim kiem, bao cao khach, stockout ----------

test('tim kiem nhieu nguon tu dong xuat moi nguon mot worksheet va khong can gui cot', async () => {
  const originalSearch = dashboardData.searchDashboardRecords;
  dashboardData.searchDashboardRecords = async () => ({
    results: [
      { source: 'invoices', sourceLabel: 'Hóa đơn', fields: [{ label: 'Mã hóa đơn', value: 'HD-01', rawValue: 'HD-01' }] },
      { source: 'orders', sourceLabel: 'Đặt hàng', fields: [{ label: 'Mã đặt hàng', value: 'DH-01', rawValue: 'DH-01' }] }
    ]
  });
  try {
    const payload = { tableKey: 'search.results', filters: {}, search: { view: 'invoices', mode: 'codes', query: 'HD-01 DH-01' } };
    const metadata = await exportService.getExportFields(payload);
    assert.equal(metadata.selectionMode, 'all-only');
    assert.deepEqual(metadata.worksheets.map(sheet => sheet.name), ['Hóa đơn', 'Đặt hàng']);
    assert.deepEqual(metadata.worksheets.map(sheet => sheet.rowCount), [1, 1]);
    const file = await exportService.createExportWorkbook(payload);
    assert.equal((await loadWorkbook(file)).worksheets.length, 2);
  } finally {
    dashboardData.searchDashboardRecords = originalSearch;
  }
});

test('search.results dung nhan chuan hoa theo catalogue va kieu cot theo catalogue', async () => {
  const originalSearch = dashboardData.searchDashboardRecords;
  dashboardData.searchDashboardRecords = async () => ({
    results: [{
      source: 'suppliers', sourceLabel: CONFIG.SHEET_SUPPLIERS,
      fields: [
        { label: 'Mã NCC', value: 'NCC-01', rawValue: 'NCC-01' },
        { label: 'Tên NCC', value: 'Nhà cung cấp A', rawValue: 'Nhà cung cấp A' },
        { label: 'Điện thoại', value: '0280011223', rawValue: '0280011223' },
        { label: 'Nợ cần trả', value: '200.000', rawValue: 200000 },
        { label: 'Cột lạ', value: 'x', rawValue: 'x' }
      ]
    }]
  });
  try {
    const payload = { tableKey: 'search.results', search: { view: 'suppliers', mode: 'normal', query: 'ncc' } };
    const metadata = await exportService.getExportFields(payload);
    assert.equal(metadata.selectionMode, 'custom');
    assert.deepEqual(metadata.worksheets[0].fields.map(field => field.label),
      ['Mã nhà cung cấp', 'Tên nhà cung cấp', 'Điện thoại', 'Nợ cần trả hiện tại', 'Cột lạ']);
    assert.deepEqual(metadata.worksheets[0].fields.map(field => field.type), ['text', 'general', 'text', 'number', 'general']);
    assert.equal(metadata.worksheets[0].rowCount, 1);
    assertStandardLabels(metadata.worksheets.map(sheet => ({ ...sheet, fields: sheet.fields.slice(0, 4) })), 'search');

    payload.columns = { search_suppliers: ['c0', 'c2'] };
    const workbook = await loadWorkbook(await exportService.createExportWorkbook(payload));
    assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1), ['Mã nhà cung cấp', 'Điện thoại']);
    assert.equal(workbook.worksheets[0].getCell('B2').value, '0280011223');
  } finally {
    dashboardData.searchDashboardRecords = originalSearch;
  }
});

test('search.results che do khach theo san pham dung nhan chuan hoa', async () => {
  const originals = dashboardData.searchTopCustomersByProducts;
  dashboardData.searchTopCustomersByProducts = async () => ({
    results: [{
      productCode: 'SP-01', productName: 'Hàng một', customerCode: 'KH-01', customerName: 'Khách A',
      purchasedQuantity: 3, purchaseRevenue: 300, returnedQuantityAllTime: 1, returnValueAllTime: 100,
      netRevenue: 200, lastPurchaseDate: '14/08/2026 09:00'
    }]
  });
  try {
    const payload = { tableKey: 'search.results', search: { view: 'customers', mode: 'customer-products', query: 'sp-01' } };
    const metadata = await exportService.getExportFields(payload);
    assert.equal(metadata.worksheets[0].rowCount, 1);
    assertStandardLabels(metadata.worksheets, 'search.customer-products');
    payload.columns = { customer_product_top: metadata.worksheets[0].fields.map(field => field.key) };
    const workbook = await loadWorkbook(await exportService.createExportWorkbook(payload));
    assert.equal(workbook.worksheets[0].getRow(1).getCell(3).value, 'Mã khách hàng');
  } finally {
    dashboardData.searchTopCustomersByProducts = originals;
  }
});

test('Bao cao doanh thu theo khach: xuat bang chi tiet (gom ca cot so sanh thang), loc theo san pham khi co chon, tu choi khi chua chon khach', async () => {
  const originalReport = dashboardData.getCustomerProductRevenueReport;
  dashboardData.getCustomerProductRevenueReport = async (code, name) => ({
    customer: { code, name: name || code },
    products: [
      { code: 'SP-01', name: 'Sản phẩm một', quantity: 3, revenue: 300, month1Revenue: 100, month2Revenue: 100, month3Revenue: 100 },
      { code: 'SP-02', name: 'Sản phẩm hai', quantity: 1, revenue: 100, month1Revenue: 100, month2Revenue: 0, month3Revenue: 0 }
    ]
  });
  try {
    const detailDataset = await exportService.__test__.buildExportDataset({
      tableKey: 'customers.productDetail',
      context: { customerProductCustomerCode: 'KH-01', customerProductCustomerName: 'Khách A' }
    });
    assert.equal(detailDataset.worksheets[0].rows.length, 2);
    assert.deepEqual(detailDataset.worksheets[0].columns.map(c => c.label),
      ['Tên hàng', 'Số lượng', 'Doanh thu', 'Doanh thu tháng này', 'Doanh thu tháng trước', 'Doanh thu 2 tháng trước']);

    const monthlyDataset = await exportService.__test__.buildExportDataset({
      tableKey: 'customers.productDetail',
      context: { customerProductCustomerCode: 'KH-01', customerProductCode: 'SP-02' }
    });
    assert.equal(monthlyDataset.worksheets[0].rows.length, 1, 'chon 1 san pham thi chi xuat 1 dong');
    assert.equal(monthlyDataset.worksheets[0].rows[0].name, 'Sản phẩm hai');
    assert.equal(monthlyDataset.worksheets[0].rows[0].month1Revenue, 100);

    const selectedWithSearch = await exportService.__test__.buildExportDataset({
      tableKey: 'customers.productDetail',
      context: { customerProductCustomerCode: 'KH-01', customerProductCode: 'SP-02' },
      tableSearch: { mode: 'normal', query: 'SP-02' }
    });
    assert.equal(selectedWithSearch.worksheets[0].rows.length, 1, 'ma san pham da chon khong bi loc mat khi worksheet an cot ma');

    await assert.rejects(
      exportService.__test__.buildExportDataset({ tableKey: 'customers.productDetail', context: {} }),
      error => error.statusCode === 400 && error.code === 'EXPORT_NO_CUSTOMER_SELECTED'
    );

    const file = await exportService.createExportWorkbook({
      tableKey: 'customers.productDetail',
      context: { customerProductCustomerCode: 'KH-01' },
      columns: { customer_product_detail: ['name', 'month1Revenue'] }
    });
    assert.equal((await loadWorkbook(file)).worksheets[0].getCell('B2').value, 100);
  } finally {
    dashboardData.getCustomerProductRevenueReport = originalReport;
  }
});

test('buildExportDataset: stockout.recentScan tra dung worksheet', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      branch: 'Hà Nội',
      rows: [{
        code: 'SP001', name: 'Ao thun', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, hasUnreliableData: true,
        periods: [
          { fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 },
          { fromDate: '2026-01-10', toDate: '2026-01-15', days: 6 }
        ]
      }]
    }
  });

  assert.equal(dataset.tableKey, 'stockout.recentScan');
  assert.equal(dataset.title, 'Hàng đứt gần đây');
  assert.equal(dataset.sourceBranch, 'Hà Nội');
  assert.equal(dataset.worksheets.length, 1);
  assert.deepEqual(dataset.worksheets[0].columns.map((c) => c.key), ['code', 'name', 'lastOutOfStockDate', 'daysOutOfStock', 'periods']);
  assert.equal(dataset.worksheets[0].rows[0].code, 'SP001');
  assert.equal(dataset.worksheets[0].rows[0].periods, '01/01/2026 -> 05/01/2026\n10/01/2026 -> 15/01/2026');
});

test('buildExportDataset loc ket qua stockout theo tableSearch hien tai', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.recentScan',
    tableSearch: { mode: 'normal', query: 'chổi lau nhà' },
    recentStockoutResult: {
      rows: [
        { code: 'SP001', name: 'Chổi lau nhà lớn', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, periods: [] },
        { code: 'SP002', name: 'Nước lau sàn', lastOutOfStockDate: '2026-01-06', daysOutOfStock: 7, periods: [] }
      ]
    }
  });

  assert.deepEqual(dataset.worksheets[0].rows.map(row => row.code), ['SP001']);
});

test('createExportWorkbook: file stockout.recentScan dung ten co so LUC QUET (result.branch), khong phai co so dang xuat hien tai', async () => {
  const file = await exportService.createExportWorkbook({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      branch: 'Hà Nội',
      rows: [{ code: 'SP001', name: 'Ao thun', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, periods: [] }]
    },
    columns: { recent_stockout_result: ['code', 'name', 'lastOutOfStockDate', 'daysOutOfStock', 'periods'] }
  }, 'Sài Gòn'); // req.branch hien tai la Sai Gon, nhung ban quet duoc chay o Ha Noi
  assert.match(file.fileName, /^HN_/);
});

test('buildExportDataset: stockout.recentScan khong co dong nao thi bao loi EXPORT_NO_DATA', async () => {
  await assert.rejects(
    exportService.__test__.buildExportDataset({ tableKey: 'stockout.recentScan', recentStockoutResult: { rows: [] } }),
    /EXPORT_NO_DATA|Chưa có kết quả/
  );
});

test('buildExportDataset: stockout.check90d tra dung worksheet', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.check90d',
    stockout90dResult: {
      branch: 'Sài Gòn',
      rows: [{
        code: 'SP001', name: 'Ao thun', stockoutCount: 2, totalStockoutDays: 10, currentOnHand: 3, hasUnreliableData: false,
        periods: [
          { fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 },
          { fromDate: '2026-01-10', toDate: '2026-01-14', days: 5 }
        ]
      }]
    }
  });

  assert.equal(dataset.tableKey, 'stockout.check90d');
  assert.equal(dataset.title, 'Kiểm tra đứt hàng 90 ngày');
  assert.equal(dataset.sourceBranch, 'Sài Gòn');
  assert.equal(dataset.worksheets.length, 1);
  assert.deepEqual(dataset.worksheets[0].columns.map((c) => c.key), ['code', 'name', 'stockoutCount', 'totalStockoutDays', 'avgStockoutDays', 'currentOnHand', 'periods']);
  assert.equal(dataset.worksheets[0].rows[0].code, 'SP001');
  assert.equal(dataset.worksheets[0].rows[0].avgStockoutDays, 5);
  assert.equal(dataset.worksheets[0].rows[0].periods, '01/01/2026 -> 05/01/2026\n10/01/2026 -> 14/01/2026');
});

test('buildExportDataset: stockout.check30d tra dung worksheet', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.check30d',
    stockout30dResult: {
      branch: 'Sài Gòn',
      rows: [{
        code: 'SP001', name: 'Ao thun', stockoutCount: 2, totalStockoutDays: 10, currentOnHand: 3, hasUnreliableData: false,
        periods: [
          { fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 },
          { fromDate: '2026-01-10', toDate: '2026-01-14', days: 5 }
        ]
      }]
    }
  });

  assert.equal(dataset.tableKey, 'stockout.check30d');
  assert.equal(dataset.title, 'Kiểm tra đứt hàng 30 ngày');
  assert.equal(dataset.sourceBranch, 'Sài Gòn');
  assert.equal(dataset.worksheets.length, 1);
  assert.deepEqual(dataset.worksheets[0].columns.map((c) => c.key), ['code', 'name', 'stockoutCount', 'totalStockoutDays', 'avgStockoutDays', 'currentOnHand', 'periods']);
  assert.equal(dataset.worksheets[0].rows[0].code, 'SP001');
  assert.equal(dataset.worksheets[0].rows[0].avgStockoutDays, 5);
  assert.equal(dataset.worksheets[0].rows[0].periods, '01/01/2026 -> 05/01/2026\n10/01/2026 -> 14/01/2026');
});

test('buildExportDataset: stockout.check30d khong co dong nao thi bao loi EXPORT_NO_DATA', async () => {
  await assert.rejects(
    exportService.__test__.buildExportDataset({ tableKey: 'stockout.check30d', stockout30dResult: { rows: [] } }),
    /EXPORT_NO_DATA|Chưa có kết quả/
  );
});

test('file Excel stockout bật wrap text cho cột Các đợt đứt hàng', async () => {
  const file = await exportService.createExportWorkbook({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      rows: [{
        code: 'SP001', name: 'Áo thun', lastOutOfStockDate: '2026-01-01', daysOutOfStock: 10,
        periods: [
          { fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 },
          { fromDate: '2026-01-10', toDate: '2026-01-14', days: 5 }
        ]
      }]
    },
    columns: { recent_stockout_result: ['code', 'name', 'lastOutOfStockDate', 'daysOutOfStock', 'periods'] }
  });
  const workbook = await loadWorkbook(file);
  const periodsColumn = workbook.worksheets[0].getColumn(5);
  assert.equal(periodsColumn.alignment.wrapText, true);
  assert.match(workbook.worksheets[0].getCell('E2').value, /\n/);
});

test('buildExportDataset: stockout.check90d khong co dong nao thi bao loi EXPORT_NO_DATA', async () => {
  await assert.rejects(
    exportService.__test__.buildExportDataset({ tableKey: 'stockout.check90d', stockout90dResult: { rows: [] } }),
    /EXPORT_NO_DATA|Chưa có kết quả/
  );
});

// ---------- Gioi han tai ----------

function createGate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

const QUICK_EXPORT = { tableKey: 'products.all', columns: { all_products: ['ma_hang'] } };

test('semaphore: 5 export dong thoi chi chay toi da 2, cac yeu cau con lai cho trong hang doi roi van xong het', async () => {
  const gate = createGate();
  let running = 0;
  let maxRunning = 0;
  await withStubs({
    onDashboard: async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running -= 1;
    }
  }, async stubs => {
    const jobs = Array.from({ length: 5 }, () => exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'));
    await tick();
    assert.equal(exportService.EXPORT_MAX_CONCURRENT, 2);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 3 });
    assert.equal(stubs.calls.dashboard.length, 2, 'moi 2 yeu cau dau duoc nap du lieu');
    gate.open();
    const files = await Promise.all(jobs);
    assert.equal(files.length, 5);
    assert.equal(maxRunning, 2);
    assert.equal(stubs.calls.dashboard.length, 5);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('semaphore: hang doi day (2 dang chay + 8 cho) thi yeu cau thu 11 bi tu choi 503 EXPORT_BUSY', async () => {
  const gate = createGate();
  await withStubs({ onDashboard: () => gate.promise }, async () => {
    assert.equal(exportService.EXPORT_MAX_QUEUED, 8);
    const jobs = Array.from({ length: 10 }, () => exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'));
    const overflow = exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội');
    await assert.rejects(overflow, error => error.statusCode === 503 && error.code === 'EXPORT_BUSY'
      && error.message === 'Hệ thống đang xử lý nhiều yêu cầu xuất file, vui lòng thử lại sau ít giây.');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 8 });
    gate.open();
    const files = await Promise.all(jobs);
    assert.equal(files.length, 10);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
    // Sau khi ha tai thi nhan lai duoc yeu cau moi.
    const later = await exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội');
    assert.ok(later.buffer.length > 0);
  });
});

test('semaphore: luon nha slot khi export loi (ca loi nap du lieu lan loi ghi file)', async () => {
  let failNext = 2;
  await withStubs({
    onDashboard: async () => {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('loi nap du lieu gia lap');
      }
    }
  }, async () => {
    await assert.rejects(exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'), /loi nap du lieu gia lap/);
    await assert.rejects(exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'), /loi nap du lieu gia lap/);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
    const ok = await exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội');
    assert.ok(ok.buffer.length > 0);
    // Loi validate sau khi nap (search.results khong co ket qua) cung phai nha slot.
    const originalSearch = dashboardData.searchDashboardRecords;
    dashboardData.searchDashboardRecords = async () => ({ results: [] });
    try {
      await assert.rejects(
        exportService.createExportWorkbook({ tableKey: 'search.results', search: { view: 'products', query: 'abc' } }),
        error => error.code === 'EXPORT_NO_DATA'
      );
    } finally {
      dashboardData.searchDashboardRecords = originalSearch;
    }
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('huy: signal da abort thi khong nap du lieu; abort khi dang cho trong hang doi thi bo muc do va khong chay', async () => {
  const gate = createGate();
  await withStubs({ onDashboard: () => gate.promise }, async stubs => {
    const already = new AbortController();
    already.abort();
    await assert.rejects(
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: already.signal }),
      error => error.code === 'EXPORT_ABORTED'
    );
    assert.equal(stubs.calls.dashboard.length, 0);

    const running = [
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'),
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội')
    ];
    const controller = new AbortController();
    const queued = exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: controller.signal });
    const survivor = exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội');
    await tick();
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 2 });
    controller.abort();
    await assert.rejects(queued, error => error.code === 'EXPORT_ABORTED');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 1 });

    gate.open();
    await Promise.all([...running, survivor]);
    assert.equal(stubs.calls.dashboard.length, 3, 'muc da huy trong hang doi khong bao gio nap du lieu');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('huy: dung ngay sau buoc nap dashboard, khong doc Postgres va nha slot', async () => {
  const controller = new AbortController();
  await withStubs({ onDashboard: async () => { controller.abort(); } }, async stubs => {
    await assert.rejects(
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: controller.signal }),
      error => error.code === 'EXPORT_ABORTED'
    );
    assert.equal(stubs.calls.dashboard.length, 1);
    assert.equal(stubs.calls.rows.length, 0);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });

  const second = new AbortController();
  await withStubs({ onRows: async () => { second.abort(); } }, async stubs => {
    await assert.rejects(
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: second.signal }),
      error => error.code === 'EXPORT_ABORTED'
    );
    assert.equal(stubs.calls.rows.length, 1);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

// ---------- Sua loi sau review ----------

test('tableKey trung khoa cua Object.prototype bi tu choi 400 EXPORT_TABLE_NOT_ALLOWED (khong phai TypeError 500)', async () => {
  const isNotAllowed = error => error.statusCode === 400 && error.code === 'EXPORT_TABLE_NOT_ALLOWED';
  for (const tableKey of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    await assert.rejects(exportService.getExportFields({ tableKey, context: {} }, 'Hà Nội'), isNotAllowed, `getExportFields ${tableKey}`);
    await assert.rejects(exportService.createExportWorkbook({ tableKey, context: {} }, 'Hà Nội'), isNotAllowed, `createExportWorkbook ${tableKey}`);
    assert.throws(() => exportService.__test__.getTableSpec(tableKey, {}), isNotAllowed, `getTableSpec ${tableKey}`);
  }
});

test('readRowsByCodes nhan signal cua yeu cau xuat de dung giua cac lo', async () => {
  await withStubs({}, async stubs => {
    const controller = new AbortController();
    await exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: controller.signal });
    assert.equal(stubs.calls.rowOptions.length, 1);
    assert.strictEqual(stubs.calls.rowOptions[0].signal, controller.signal);
  });
});

test('nhan cot tong hop: ty le no qua han theo doanh so TRUNG BINH, khong viet tat NCC', async () => {
  const metadata = await exportService.getExportFields({ tableKey: 'debt.management', context: { debtQueue: 'all' } }, 'Hà Nội');
  const overdue = metadata.worksheets[0].fields.find(field => field.key === 'overdueToSalesRatio');
  assert.equal(overdue.label, 'Nợ quá hạn trên doanh số trung bình');
  assert.match(overdue.description, /doanh số trung bình/);
});

test('buildExportErrorBody: chi tra detail cho loi da biet (EXPORT_*, INVALID_BRANCH), loi bat ngo dung thong diep mac dinh', () => {
  const known = Object.assign(new Error('Bảng yêu cầu xuất không hợp lệ.'), { statusCode: 400, code: 'EXPORT_TABLE_NOT_ALLOWED' });
  assert.deepEqual(exportService.buildExportErrorBody(known, 'Không thể tạo file Excel.'),
    { error: 'Không thể tạo file Excel.', detail: 'Bảng yêu cầu xuất không hợp lệ.', code: 'EXPORT_TABLE_NOT_ALLOWED' });
  const branch = Object.assign(new Error('Cơ sở không hợp lệ.'), { statusCode: 400, code: 'INVALID_BRANCH' });
  assert.equal(exportService.buildExportErrorBody(branch, 'x').detail, 'Cơ sở không hợp lệ.');

  const pg = Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' });
  const body = exportService.buildExportErrorBody(pg, 'Không lấy được danh sách trường xuất Excel.');
  assert.equal(body.detail, undefined);
  assert.equal(body.error, 'Không lấy được danh sách trường xuất Excel.');
  assert.equal('googleStatus' in body, false);
  assert.equal(exportService.buildExportErrorBody(new TypeError('Cannot read properties of undefined'), 'x').detail, undefined);
});

// ---------- Ca hai: xuat Excel ----------

const BOTH = 'Cả hai';
const HN = 'Hà Nội';
const SG = 'Sài Gòn';

// Thay readRowsByCodes bang ban theo TUNG CO SO VAT LY: `rowsByBranch` = { [branch]: { [sheetName]: rows } }.
// Ghi lai moi lan goi; tu choi neu bi goi voi bat ky gia tri nao khong phai co so vat ly.
function stubRowsByBranch(rowsByBranch, calls) {
  dashboardPgReader.readRowsByCodes = async (sheetName, branch, codes, readOptions) => {
    if (![HN, SG].includes(branch)) throw new Error(`readRowsByCodes bi goi voi co so khong vat ly: ${branch}`);
    calls.push({ sheetName, branch, codes: Array.from(codes) });
    const source = catalog.getSourceBySheetName(sheetName);
    const wanted = new Set(codes);
    return {
      columns: source.fields.map(item => item.key),
      rows: (((rowsByBranch[branch] || {})[sheetName]) || []).filter(row => wanted.has(row[source.codeKey])).map(row => ({ ...row }))
    };
  };
}

function worksheetTable(workbook, index = 0) {
  const worksheet = workbook.worksheets[index];
  const rows = [];
  worksheet.eachRow((row, rowNumber) => { if (rowNumber > 1) rows.push(row.values.slice(1)); });
  return { header: worksheet.getRow(1).values.slice(1), rows };
}

test('Ca hai: buoc lay truong bang giao dich them cot "Cơ sở" khong nap du lieu, co so vat ly giu nguyen', async () => {
  await withStubs({}, async stubs => {
    for (const tableKey of ['overview.transactions', 'overview.purchases', 'invoices.orders', 'invoices.returns']) {
      const both = await exportService.getExportFields(payloadFor(tableKey), BOTH);
      const physical = await exportService.getExportFields(payloadFor(tableKey), HN);
      assert.equal(both.worksheets.length, physical.worksheets.length);
      both.worksheets.forEach((worksheet, index) => {
        const last = worksheet.fields[worksheet.fields.length - 1];
        assert.deepEqual(worksheet.fields.slice(0, -1), physical.worksheets[index].fields, `${tableKey}: cot cu giu nguyen`);
        assert.equal(last.label, 'Cơ sở');
        assert.equal(last.selected, true);
        assert.equal(last.type, 'text');
        assert.ok(!physical.worksheets[index].fields.some(field => field.label === 'Cơ sở'), 'co so vat ly khong co cot moi');
      });
    }
    const productsBoth = await exportService.getExportFields(payloadFor('products.all'), BOTH);
    const productsPhysical = await exportService.getExportFields(payloadFor('products.all'), SG);
    assert.deepEqual(productsBoth, productsPhysical, 'bang thuc the da gop theo ma khong can cot co so');
    const debt = await exportService.getExportFields(payloadFor('debt.management'), BOTH);
    assert.equal(debt.worksheets[0].fields[1].label, 'Cơ sở');
    assert.equal(stubs.calls.dashboard.length, 0);
    assert.equal(stubs.calls.rows.length, 0);
  });
});

test('Ca hai: hoa don trung ma o hai co so ghep dung dong tho theo (co so, ma) va chi truy van co so co ma', async () => {
  const dashboard = {
    invoices: {
      transactionsReport: {
        transactions: [
          { code: 'HD-01', branch: HN, quantity: 2, quantityKnown: true },
          { code: 'HD-01', branch: SG, quantity: 5, quantityKnown: true },
          { code: 'HD-02', branch: SG, quantity: 1, quantityKnown: true }
        ]
      }
    }
  };
  await withStubs({ dashboard }, async stubs => {
    const calls = [];
    stubRowsByBranch({
      [HN]: { [CONFIG.SHEET_INVOICES]: [sourceRow('invoices', { ma_hoa_don: 'HD-01', khach_hang: 'Khách HN', tong_tien_hang: 100 })] },
      [SG]: { [CONFIG.SHEET_INVOICES]: [
        sourceRow('invoices', { ma_hoa_don: 'HD-01', khach_hang: 'Khách SG', tong_tien_hang: 200 }),
        sourceRow('invoices', { ma_hoa_don: 'HD-02', khach_hang: 'Khách SG 2', tong_tien_hang: 300 })
      ] }
    }, calls);
    const file = await exportService.createExportWorkbook({
      tableKey: 'overview.transactions',
      columns: { transactions: ['ma_hoa_don', 'khach_hang', 'tong_tien_hang', 'd_quantity', 'd_branch'] }
    }, BOTH);
    const table = worksheetTable(await loadWorkbook(file));
    assert.deepEqual(table.header, ['Mã hóa đơn', 'Khách hàng', 'Tổng tiền hàng', 'Số lượng', 'Cơ sở']);
    assert.deepEqual(table.rows, [
      ['HD-01', 'Khách HN', 100, 2, HN],
      ['HD-01', 'Khách SG', 200, 5, SG],
      ['HD-02', 'Khách SG 2', 300, 1, SG]
    ]);
    assert.deepEqual(calls, [
      { sheetName: CONFIG.SHEET_INVOICES, branch: HN, codes: ['HD-01'] },
      { sheetName: CONFIG.SHEET_INVOICES, branch: SG, codes: ['HD-01', 'HD-02'] }
    ]);
    assert.equal(stubs.calls.dashboard[0][1], BOTH, 'man hinh va xuat cung nap tap Ca hai');
  });

  // Chi mot co so co ma -> khong query co so con lai.
  await withStubs({ dashboard: { invoices: { periodOrders: [{ code: 'DH-01', branch: SG }], periodReturns: [{ code: 'TH-01', branch: HN }, { code: 'TH-01', branch: SG }] } } }, async () => {
    const calls = [];
    stubRowsByBranch({
      [SG]: {
        [CONFIG.SHEET_ORDERS]: [sourceRow('orders', { ma_dat_hang: 'DH-01', khach_hang: 'Khách SG' })],
        [CONFIG.SHEET_RETURNS]: [sourceRow('returns', { ma_tra_hang: 'TH-01', khach_hang: 'Trả SG' })]
      },
      [HN]: { [CONFIG.SHEET_RETURNS]: [sourceRow('returns', { ma_tra_hang: 'TH-01', khach_hang: 'Trả HN' })] }
    }, calls);
    const orders = worksheetTable(await loadWorkbook(await exportService.createExportWorkbook({
      tableKey: 'invoices.orders', columns: { orders: ['ma_dat_hang', 'd_branch'] }
    }, BOTH)));
    assert.deepEqual(orders.rows, [['DH-01', SG]]);
    assert.deepEqual(calls.map(call => call.branch), [SG]);
    const returns = worksheetTable(await loadWorkbook(await exportService.createExportWorkbook({
      tableKey: 'invoices.returns', columns: { returns: ['ma_tra_hang', 'khach_hang', 'd_branch'] }
    }, BOTH)));
    assert.deepEqual(returns.rows, [['TH-01', 'Trả HN', HN], ['TH-01', 'Trả SG', SG]]);
  });
});

test('Ca hai: phieu nhap trung ma giu tong hop va chi tiet theo (co so, ma), loc bang khong lam roi dong co so khac', async () => {
  const purchaseBase = { ma_nhap_hang: 'PN-01', ma_nha_cung_cap: 'NCC-01', trang_thai: 'Đã nhập hàng' };
  const dashboard = { newPurchases: { orders: [{ code: 'PN-01', branch: HN }, { code: 'PN-01', branch: SG }] } };
  const rowsByBranch = {
    [HN]: { [CONFIG.SHEET_PURCHASES]: [sourceRow('purchases', { ...purchaseBase, ten_nha_cung_cap: 'NCC Alpha', ma_hang: 'SP-A', ten_hang: 'Hàng HN', so_luong: 1 })] },
    [SG]: { [CONFIG.SHEET_PURCHASES]: [
      sourceRow('purchases', { ...purchaseBase, ten_nha_cung_cap: 'NCC Beta', ma_hang: 'SP-B', ten_hang: 'Hàng SG 1', so_luong: 2 }),
      sourceRow('purchases', { ...purchaseBase, ten_nha_cung_cap: 'NCC Beta', ma_hang: 'SP-C', ten_hang: 'Hàng SG 2', so_luong: 3 })
    ] }
  };
  await withStubs({ dashboard }, async () => {
    const calls = [];
    stubRowsByBranch(rowsByBranch, calls);
    const columns = { purchase_summary: ['ma_nhap_hang', 'ten_nha_cung_cap', 'd_branch'], purchase_details: ['ma_hang', 'd_branch'] };
    const workbook = await loadWorkbook(await exportService.createExportWorkbook({ tableKey: 'overview.purchases', columns }, BOTH));
    assert.deepEqual(worksheetTable(workbook, 0).rows, [['PN-01', 'NCC Alpha', HN], ['PN-01', 'NCC Beta', SG]]);
    assert.deepEqual(worksheetTable(workbook, 1).rows, [['SP-A', HN], ['SP-B', SG], ['SP-C', SG]]);
    assert.deepEqual(calls.map(call => [call.branch, call.codes]), [[HN, ['PN-01']], [SG, ['PN-01']]]);

    // Tim trong bang: chi phieu cua Sai Gon khop "beta" -> chi tiet cung ma cua Ha Noi phai bi loai.
    const searched = await loadWorkbook(await exportService.createExportWorkbook({
      tableKey: 'overview.purchases', columns, tableSearch: { mode: 'normal', query: 'beta' }
    }, BOTH));
    assert.deepEqual(worksheetTable(searched, 0).rows, [['PN-01', 'NCC Beta', SG]]);
    assert.deepEqual(worksheetTable(searched, 1).rows, [['SP-B', SG], ['SP-C', SG]]);
  });
});

test('Ca hai: bang thuc the doc ca hai co so theo ma va gop cung quy tac man hinh (cong ton, gia von binh quan)', async () => {
  const dashboard = { allProducts: [{ code: 'SP-1', pct: 100 }, { code: 'SP-2', pct: 0 }] };
  await withStubs({ dashboard }, async stubs => {
    const calls = [];
    stubRowsByBranch({
      [HN]: { [CONFIG.SHEET_PRODUCTS]: [
        sourceRow('products', { ma_hang: 'SP-1', ten_hang: 'Áo Hà Nội', ton_kho: 2, gia_von: 10, gia_ban: 20 }),
        sourceRow('products', { ma_hang: 'SP-2', ten_hang: 'Chỉ Hà Nội', ton_kho: 4, gia_von: 5, gia_ban: 9 })
      ] },
      [SG]: { [CONFIG.SHEET_PRODUCTS]: [sourceRow('products', { ma_hang: 'SP-1', ten_hang: 'Áo Sài Gòn', ton_kho: 3, gia_von: 20, gia_ban: null })] }
    }, calls);
    const dataset = await exportService.__test__.buildFixedDataset('products.all', { dashboard: stubs.dashboard, branch: BOTH }, {});
    const rows = dataset.worksheets[0].rows;
    assert.deepEqual(rows.map(row => [row.ma_hang, row.ten_hang, row.ton_kho, row.gia_von, row.gia_ban]), [
      ['SP-1', 'Áo Hà Nội', 5, 16, 20],
      ['SP-2', 'Chỉ Hà Nội', 4, 5, 9]
    ]);
    assert.deepEqual(calls.map(call => [call.branch, call.codes]), [[HN, ['SP-1', 'SP-2']], [SG, ['SP-1', 'SP-2']]]);
  });
});

test('Ca hai: loc Quan ly cong no tren hang GOP nhu man hinh, roi moi tach tung co so kem cot "Cơ sở"', async () => {
  const detail = (customerName, branch, currentDebt, needsAction, workflowStatus) => ({
    branch, sourceSheet: `Công nợ ${branch}`, customerName, sale: 'Lan', paymentSchedule: '1',
    openingDebt: 0, currentDebt, overdueDebt: Math.max(currentDebt, 0), alertCodes: [], dataIssues: [], workflowStatus, needsAction,
    updatedBy: '', updatedAt: ''
  });
  // Hang gop nhu mergeDebtManagementSources: cong no cong don, needsAction la OR cua cac co so.
  const merged = (customerName, currentDebt, needsAction, branchDetails) => ({
    customerName, sale: 'Lan', paymentSchedule: '1', openingDebt: 0, currentDebt, overdueDebt: Math.max(currentDebt, 0),
    needsAction, alertCodes: [], dataIssues: [], workflowStatus: 'Đã xử lý', branchDetails
  });
  const dashboard = {
    debtManagement: {
      available: true,
      sourceSheet: 'Công nợ Hà Nội + Công nợ Sài Gòn',
      customers: [
        // A: HN khong can xu ly (100), SG can xu ly (200) -> man hinh: 1 hang 300, needsAction = true.
        merged('Khách A', 300, true, [detail('Khách A', HN, 100, false, 'Đã xử lý'), detail('Khách A', SG, 200, true, 'Chưa xử lý')]),
        // B: cong no HN +500 va SG -500 bu tru nhau -> man hinh: 0, khong thuoc hang "Con no".
        merged('Khách B', 0, false, [detail('Khách B', HN, 500, false, 'Đã xử lý'), detail('Khách B', SG, -500, false, 'Đã xử lý')]),
        // C: cong no lon hon A nhung chi co 1 co so (khong co branchDetails).
        merged('Khách C', 900, false, undefined)
      ]
    }
  };
  const build = context => exportService.__test__.buildFixedDataset('debt.management', { dashboard: dashboard_, branch: BOTH }, context);
  let dashboard_;
  await withStubs({ dashboard }, async stubs => {
    dashboard_ = stubs.dashboard;
    const all = await build({ debtQueue: 'all' });
    assert.equal(all.worksheets[0].columns[1].label, 'Cơ sở');
    assert.deepEqual(all.worksheets[0].rows.map(row => [row.customerName, row.branch, row.currentDebt, row.workflowStatus]), [
      ['Khách A', HN, 100, 'Đã xử lý'], ['Khách A', SG, 200, 'Chưa xử lý'],
      ['Khách B', HN, 500, 'Đã xử lý'], ['Khách B', SG, -500, 'Đã xử lý'],
      ['Khách C', '', 900, 'Đã xử lý']
    ]);

    // needsAction loc theo hang gop (OR cac co so): giu CA HAI dong cua A, khong bo cong no 100 cua Ha Noi.
    const needs = await build({ debtQueue: 'needsAction' });
    assert.deepEqual(needs.worksheets[0].rows.map(row => [row.customerName, row.branch, row.currentDebt]), [
      ['Khách A', HN, 100], ['Khách A', SG, 200]
    ]);

    // currentDebt loc theo tong gop: B (500 - 500 = 0) bi an nhu tren man hinh, ke ca dong Ha Noi +500.
    const owing = await build({ debtQueue: 'currentDebt' });
    assert.deepEqual(owing.worksheets[0].rows.map(row => [row.customerName, row.branch]), [
      ['Khách A', 'Hà Nội'], ['Khách A', 'Sài Gòn'], ['Khách C', '']
    ]);
    const overdue = await build({ debtQueue: 'overdue' });
    assert.deepEqual(overdue.worksheets[0].rows.map(row => row.customerName), ['Khách A', 'Khách A', 'Khách C']);

    // Sap xep theo gia tri GOP (cot "Nợ hiện tại"): C (900) truoc A (300), cac dong co so di cung khach.
    const sorted = await build({ debtQueue: 'currentDebt', debtSort: { columnIndex: 4, direction: 'desc' } });
    assert.deepEqual(sorted.worksheets[0].rows.map(row => [row.customerName, row.branch]), [
      ['Khách C', ''], ['Khách A', HN], ['Khách A', SG]
    ]);
    assert.equal(stubs.calls.rows.length, 0, 'bang cong no khong doc them Postgres');
  });
});

test('xuat ket qua tim kiem truyen dung co so va bo loc khach xuong searchDashboardRecords (khong dat co so vao o filterSpec)', async () => {
  const originalSearch = dashboardData.searchDashboardRecords;
  const calls = [];
  dashboardData.searchDashboardRecords = async (...args) => {
    calls.push(args);
    return { results: [{ source: 'products', sourceLabel: 'Hàng hóa', fields: [{ label: 'Mã hàng', value: 'SP-1', rawValue: 'SP-1' }] }] };
  };
  try {
    await exportService.createExportWorkbook({
      tableKey: 'search.results', search: { view: 'products', mode: 'normal', query: 'sp' }, columns: { search_products: ['c0'] }
    }, SG);
    await exportService.createExportWorkbook({
      tableKey: 'search.results', filters: { customers: { mode: 'days', days: 7 } },
      search: { view: 'customers', mode: 'codes', query: 'kh-1' }, columns: { search_products: ['c0'] }
    }, BOTH);
    const [view, query, limit, mode, filterSpec, branch] = calls[0];
    assert.deepEqual([view, query, limit, mode, filterSpec, branch], ['products', 'sp', 'all', undefined, undefined, SG]);
    assert.deepEqual(calls[1].slice(3), ['codes', { mode: 'days', days: 7 }, BOTH]);
  } finally {
    dashboardData.searchDashboardRecords = originalSearch;
  }
});

test('Ca hai: ket qua tim kiem giao dich them cot "Cơ sở" tu provenance cua tung dong', async () => {
  const originalSearch = dashboardData.searchDashboardRecords;
  dashboardData.searchDashboardRecords = async () => ({
    results: [
      { source: 'invoices', sourceLabel: 'Hóa đơn', branch: HN, fields: [{ label: 'Mã hóa đơn', value: 'HD-01', rawValue: 'HD-01' }] },
      { source: 'invoices', sourceLabel: 'Hóa đơn', branch: SG, fields: [{ label: 'Mã hóa đơn', value: 'HD-01', rawValue: 'HD-01' }] }
    ]
  });
  try {
    const payload = { tableKey: 'search.results', filters: {}, search: { view: 'invoices', mode: 'codes', query: 'HD-01' } };
    const metadata = await exportService.getExportFields(payload, BOTH);
    assert.deepEqual(metadata.worksheets[0].fields.map(field => field.label), ['Mã hóa đơn', 'Cơ sở']);
    payload.columns = { search_invoices: metadata.worksheets[0].fields.map(field => field.key) };
    const table = worksheetTable(await loadWorkbook(await exportService.createExportWorkbook(payload, BOTH)));
    assert.deepEqual(table.rows, [['HD-01', HN], ['HD-01', SG]]);
  } finally {
    dashboardData.searchDashboardRecords = originalSearch;
  }
});

// ---------- Xuat ket qua dut hang quet o "Cả hai" ----------

test('buildExportDataset: ket qua stockout quet o "Cả hai" them cot Co so o dau worksheet', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      branch: 'Cả hai',
      rows: [
        { code: 'SP001', name: 'Ao thun', branch: 'Hà Nội', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, periods: [] },
        { code: 'SP001', name: 'Ao thun', branch: 'Sài Gòn', lastOutOfStockDate: '2026-01-07', daysOutOfStock: 4, periods: [] }
      ]
    }
  });

  assert.equal(dataset.worksheets[0].columns[0].key, 'branch');
  assert.equal(dataset.worksheets[0].columns[0].label, 'Cơ sở');
  assert.deepEqual(dataset.worksheets[0].rows.map(row => row.branch), ['Hà Nội', 'Sài Gòn']);
});

test('buildExportDataset: ket qua stockout quet o mot co so KHONG co cot Co so', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.check90d',
    stockout90dResult: { branch: 'Hà Nội', rows: STOCKOUT_ROWS }
  });

  assert.equal(dataset.worksheets[0].columns.some(column => column.key === 'branch'), false);
});

test('createExportWorkbook: chap nhan truong "branch" khi ket qua stockout quet o "Cả hai"', async () => {
  const file = await exportService.createExportWorkbook({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      branch: 'Cả hai',
      rows: [{ code: 'SP001', name: 'Ao thun', branch: 'Sài Gòn', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, periods: [] }]
    },
    columns: { recent_stockout_result: ['branch', 'code', 'name', 'lastOutOfStockDate', 'daysOutOfStock', 'periods'] }
  }, 'Cả hai');

  assert.ok(file.buffer.byteLength > 0);
});

// ---------- Xuat bao cao HTML (renderer thu hai, dung chung tang dataset) ----------

const zlib = require('node:zlib');
const { JSDOM } = require('jsdom');
const exportHtmlReport = require('./exportHtmlReport');

const DEBT_HTML_EXPORT = {
  tableKey: 'debt.management', format: 'html', context: { debtQueue: 'all' },
  columns: { debt_management: ['customerName', 'sale', 'currentDebt', 'overdueDebt', 'currentDebtToSalesRatio', 'workflowStatus'] }
};

/** Doc du lieu nhung (gzip + base64) giong trinh duyet. */
function embeddedData(html) {
  const doc = new JSDOM(html).window.document;
  const node = doc.getElementById('report-data');
  assert.equal(node.getAttribute('data-encoding'), 'gzip-base64');
  return JSON.parse(zlib.gunzipSync(Buffer.from(node.textContent, 'base64')).toString('utf8'));
}

// Mo bao cao trong jsdom; jsdom khong co DecompressionStream/Response nen muon cua Node
// (cung API chuan cua trinh duyet). Cho den khi bang da render xong tu du lieu giai nen.
async function openHtmlReport(file, options = {}) {
  const html = file.buffer.toString('utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      win.HTMLCanvasElement.prototype.getContext = () => null; // jsdom khong co canvas
      win.console.error = () => {};
      if (!options.legacyBrowser) {
        win.DecompressionStream = DecompressionStream;
        win.Response = Response;
      }
    }
  });
  const doc = dom.window.document;
  for (let attempt = 0; attempt < 200 && /Đang mở dữ liệu/.test(doc.getElementById('tbody').textContent); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { html, dom, doc };
}

test('createExport: khong gui format -> Excel nhu cu; format sai bi tu choi TRUOC khi cham du lieu', async () => {
  await withStubs({}, async stubs => {
    const xlsx = await exportService.createExport(QUICK_EXPORT, 'Hà Nội');
    assert.match(xlsx.fileName, /^HN_.+\.xlsx$/);
    assert.equal(xlsx.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await assert.rejects(
      exportService.createExport({ ...QUICK_EXPORT, format: 'pdf' }, 'Hà Nội'),
      error => error.statusCode === 400 && error.code === 'EXPORT_FORMAT_INVALID'
    );
    assert.equal(stubs.calls.dashboard.length, 1, 'format sai khong duoc nap du lieu');
  });
});

test('Excel va HTML dung chung getExportDataset: cung cot da chon, cung dong, cung co so', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.getExportDataset(DEBT_HTML_EXPORT, 'Hà Nội');
    assert.deepEqual(dataset.worksheets[0].columns.map(column => column.key), DEBT_HTML_EXPORT.columns.debt_management);
    assert.equal(dataset.worksheets[0].rows.length, 2);
    assert.equal(dataset.meta.branch, 'Hà Nội');

    const file = await exportService.createExport(DEBT_HTML_EXPORT, 'Hà Nội');
    assert.match(file.fileName, /^HN_Quan_ly_cong_no_\d{8}_\d{4}\.html$/);
    assert.equal(file.mimeType, 'text/html; charset=utf-8');
    const embedded = embeddedData(file.buffer.toString('utf8'));
    assert.deepEqual(embedded.worksheets[0].columns.map(column => column.key), DEBT_HTML_EXPORT.columns.debt_management);
    assert.equal(embedded.worksheets[0].rows.length, 2);
    // Cot khong chon (updatedBy) khong duoc lot vao file.
    assert.doesNotMatch(file.buffer.toString('utf8'), /Người cập nhật/);
    assert.deepEqual(stubs.calls.dashboard.map(args => args[1]), ['Hà Nội', 'Hà Nội'], 'dung co so cua req.branch');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('bao cao HTML tu chua: KPI render san, Chart.js inline, khong tai tai nguyen ngoai, co CSP', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExport(DEBT_HTML_EXPORT, 'Sài Gòn');
    const { html, doc } = await openHtmlReport(file);
    assert.doesNotMatch(html, /<script[^>]+src=/i, 'khong script ngoai');
    assert.doesNotMatch(html, /<link[^>]+href=/i, 'khong stylesheet ngoai');
    assert.doesNotMatch(html, /XMLHttpRequest|\/api\//, 'khong goi API sau khi mo');
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
    assert.match(html, /Chart\.js v4/, 'thu vien Chart.js nam ngay trong file');
    assert.equal(doc.title, 'Quản lý công nợ · TOKOSI');

    // KPI co trong HTML goc (khong can JS): so dong + tong no hien tai.
    const staticDoc = new JSDOM(html).window.document;
    const kpis = [...staticDoc.querySelectorAll('#kpis .kpi')].map(card => card.textContent);
    assert.ok(kpis.length >= 2 && kpis.length <= 4);
    assert.match(kpis[0], /Số dòng dữ liệu\s*2/);
    assert.ok(kpis.some(text => /Tổng nợ hiện tại/.test(text) && /2\.000\.000/.test(text)), kpis.join(' | '));

    // Bang render tu du lieu nhung, dinh dang so/phan tram tieng Viet.
    const cells = [...doc.querySelectorAll('#tbody tr')].map(row => [...row.cells].map(cell => cell.textContent));
    assert.equal(cells.length, 2);
    assert.deepEqual(cells[0].slice(0, 5), ['Khách A', 'Lan', '800.000', '500.000', '40%']);
    assert.equal(cells[1][4], '—', 'o trong hien gach ngang');
  });
});

test('bao cao HTML: tim kiem khong dau, loc va sap xep chay hoan toan tren du lieu nhung', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExport(DEBT_HTML_EXPORT, 'Hà Nội');
    const { dom, doc } = await openHtmlReport(file);
    const win = dom.window;
    const rows = () => [...doc.querySelectorAll('#tbody tr')].map(row => row.cells[0].textContent);
    const input = doc.getElementById('q');
    input.value = 'khach b';
    input.dispatchEvent(new win.Event('input'));
    assert.deepEqual(rows(), ['Khách B']);
    assert.match(doc.getElementById('count').textContent, /Hiển thị 1 \/ 2 dòng/);

    input.value = 'khong co';
    input.dispatchEvent(new win.Event('input'));
    assert.match(doc.getElementById('tbody').textContent, /Không có dòng nào khớp bộ lọc/);

    doc.getElementById('reset').click();
    assert.deepEqual(rows(), ['Khách A', 'Khách B']);
    // Bam tieu de "Nợ hiện tại" -> giam dan (1.200.000 truoc).
    doc.querySelector('#thead button[data-col="2"]').click();
    assert.deepEqual(rows(), ['Khách B', 'Khách A']);
    // Cot phan loai (Sale / Trang thai) duoc dua len bo loc.
    const select = doc.getElementById('category');
    assert.equal(select.hidden, false);
    select.value = [...select.options].find(option => option.value === 'Lan' || option.value === 'Chưa xử lý').value;
    select.dispatchEvent(new win.Event('change'));
    assert.deepEqual(rows(), ['Khách A']);
    win.close();
  });
});

test('bao cao HTML vuot HTML_MAX_CELLS (dong x cot) thi bao loi goi y dung Excel va nha slot', async () => {
  // QUICK_EXPORT chon 1 cot -> so o = so dong.
  const many = Array.from({ length: exportService.HTML_MAX_CELLS + 1 }, (_, index) => ({ code: `SP${index}` }));
  await withStubs({ dashboard: { ...buildDashboard(), allProducts: many } }, async () => {
    await assert.rejects(
      exportService.createExport({ ...QUICK_EXPORT, format: 'html' }, 'Hà Nội'),
      error => error.statusCode === 413 && error.code === 'EXPORT_HTML_TOO_LARGE' && /Xuất Excel/.test(error.message)
    );
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
    // Excel khong bi gioi han nay.
    const xlsx = await exportService.createExport(QUICK_EXPORT, 'Hà Nội');
    assert.match(xlsx.fileName, /\.xlsx$/);
  });
});

test('bao cao HTML dung chung hang doi voi Excel (khong co hang doi rieng)', async () => {
  const gate = createGate();
  await withStubs({ onDashboard: () => gate.promise }, async () => {
    const jobs = [
      exportService.createExport(QUICK_EXPORT, 'Hà Nội'),
      exportService.createExport({ ...QUICK_EXPORT, format: 'html' }, 'Hà Nội'),
      exportService.createExport({ ...QUICK_EXPORT, format: 'html' }, 'Hà Nội')
    ];
    await tick();
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 1 });
    gate.open();
    const files = await Promise.all(jobs);
    assert.deepEqual(files.map(file => file.fileName.split('.').pop()), ['xlsx', 'html', 'html']);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('du lieu nhung khong the dong the script (chong XSS tu du lieu)', async () => {
  const file = await exportHtmlReport.renderHtmlReport({
    meta: { title: '<img src=x onerror=alert(1)>', branch: 'Hà Nội', generatedAt: new Date(), fileBase: 'HN_X' },
    worksheets: [{ key: 'a', name: 'A', columns: [{ key: 'n', label: '<b>Tên</b>', type: 'text' }], rows: [{ n: '</script><!--' }] }]
  });
  const html = file.buffer.toString('utf8');
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal((html.match(/<\/script>/g) || []).length, 3, 'chi co 3 the script cua chinh bao cao');
  assert.equal(embeddedData(html).worksheets[0].rows[0][0], '</script><!--');
});

test('du lieu nhung duoc nen gzip: nho hon nhieu lan JSON tho va giai nen ra dung du lieu', async () => {
  const rows = Array.from({ length: 20000 }, (_, index) => ({
    code: `SP${index}`, name: `Sản phẩm mẫu số ${index % 500}`, group: ['Áo', 'Quần', 'Mũ'][index % 3], qty: index % 97, amount: (index % 1000) * 1500
  }));
  const columns = [
    { key: 'code', label: 'Mã hàng', type: 'text' }, { key: 'name', label: 'Tên hàng', type: 'text' },
    { key: 'group', label: 'Nhóm hàng', type: 'text' }, { key: 'qty', label: 'Số lượng', type: 'number' },
    { key: 'amount', label: 'Doanh thu', type: 'number' }
  ];
  const file = await exportHtmlReport.renderHtmlReport({
    meta: { title: 'Lớn', branch: 'Hà Nội', generatedAt: new Date(), fileBase: 'HN_L' },
    worksheets: [{ key: 'a', name: 'A', columns, rows }]
  });
  const html = file.buffer.toString('utf8');
  const rawJsonBytes = Buffer.byteLength(JSON.stringify(rows.map(row => columns.map(column => row[column.key]))));
  const embeddedBytes = new JSDOM(html).window.document.getElementById('report-data').textContent.length;
  assert.ok(embeddedBytes * 4 < rawJsonBytes, `nen chua du: ${embeddedBytes} vs ${rawJsonBytes}`);
  const data = embeddedData(html);
  assert.equal(data.worksheets[0].rows.length, 20000);
  assert.deepEqual(data.worksheets[0].rows[19999], ['SP19999', 'Sản phẩm mẫu số 499', 'Quần', 19999 % 97, 999 * 1500]);

  const { dom, doc } = await openHtmlReport(file);
  const input = doc.getElementById('q');
  input.value = 'sp19999 quan';
  input.dispatchEvent(new dom.window.Event('input'));
  assert.match(doc.getElementById('count').textContent, /Hiển thị 1 \/ 20\.000 dòng/);
  dom.window.close();
});

test('trinh duyet khong co DecompressionStream thi bao ro thay vi trang trang', async () => {
  const file = await exportHtmlReport.renderHtmlReport({
    meta: { title: 'X', branch: 'Hà Nội', generatedAt: new Date(), fileBase: 'HN_X' },
    worksheets: [{ key: 'a', name: 'A', columns: [{ key: 'n', label: 'Tên', type: 'text' }], rows: [{ n: 'a' }] }]
  });
  const { dom, doc } = await openHtmlReport(file, { legacyBrowser: true });
  assert.match(doc.getElementById('tbody').textContent, /Trình duyệt này quá cũ/);
  dom.window.close();
});

test('normalizeFilters: Hang moi nhap co bo loc rieng, client cu khong gui thi dung bo loc products', () => {
  const { normalizeFilters } = exportService.__test__;
  const own = normalizeFilters({
    products: { mode: 'days', days: 7, status: 'Đang kinh doanh' },
    newlyImported: { mode: 'range', from: '2026-07-01', to: '2026-07-31' }
  });
  assert.deepEqual(own.newlyImported, { mode: 'range', from: '2026-07-01', to: '2026-07-31' });
  assert.deepEqual(own.products, { mode: 'days', days: 7, status: 'Đang kinh doanh' });
  assert.deepEqual(normalizeFilters({ products: { mode: 'days', days: 7 } }).newlyImported, { mode: 'days', days: 7 });
});
