'use strict';
// Test nay tu set bien moi truong gia de config.js khong throw khi thieu
// .env that — khong dung tai khoan Google Sheets that trong test.
process.env.DEBT_MANAGEMENT_SPREADSHEET_ID = process.env.DEBT_MANAGEMENT_SPREADSHEET_ID || 'test-debt-management-spreadsheet-id';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');

test('transaction and customer product pages retain full filtered totals/chart data', () => {
  const { queryTransactionsReport, queryCustomerProductReport } = require('./dashboardData');
  const transactions = Array.from({ length: 205 }, (_, i) => ({ code: 'HD' + i, customer: 'Áo đỏ', revenue: i + .5, quantity: 1, quantityKnown: true, paid: i, discount: 0, status: i === 0 ? 'Đã hủy' : 'Hoàn thành', timeMs: i }));
  const result = queryTransactionsReport({ transactions }, { page: 2, pageSize: 100, sorts: [{ key: 'revenue', dir: 'desc' }], q: 'ao do' });
  assert.equal(result.totalRows, 205);
  assert.equal(result.transactions[0].code, 'HD104');
  assert.equal(result.summary.revenue, 21012);
  assert.equal(result.summary.cancelledCount, 1);
  const products = transactions.map(row => ({ code: row.code, name: 'Áo', revenue: row.revenue, quantity: 1, revenueByDay: [{ date: '2026-11-01', revenue: row.revenue }] }));
  const detail = queryCustomerProductReport({ products, totalRevenueByDay: [], customer: { name: 'X' } }, { page: 2, pageSize: 100, sorts: [{ key: 'revenue', dir: 'desc' }] });
  assert.equal(detail.products.length, 100);
  assert.equal(detail.chartProducts.length, 205);
  assert.equal(detail.totalRevenue, 21012.5);
  assert.equal(detail.rows[0].code, 'HD104');
  assert.equal(detail.chartProducts[0].revenueByDay, undefined);
  assert.equal(detail.summary.purchasedCount, 205);
  const chosen = queryCustomerProductReport({ products }, { productCode: 'HD4', q: 'missing' });
  assert.equal(chosen.totalRows, 0);
  assert.equal(chosen.chartProducts.length, 1);
  assert.equal(chosen.productOptions.length, 205);
  assert.deepEqual(chosen.selectedRevenueByDay, products[4].revenueByDay);
});

// Require lai module tu dau cho moi test de cac cache module-level (let o
// dashboardData.js) khong bi ro ri giua cac test.
//
// dashboardData.js doc du lieu KiotViet qua dashboardPgReader (Postgres) thay
// vi sheetsClient. HN1/HN3/HN7 doc qua customerDebtActivityRepository tu DB;
// "Khach theo hang hoa" doc qua customerProductTopRepository
// (SQL) thay vi 1 sheet rieng.
//
// getDashboardData() gio doc 2 nguon SONG SONG:
//   - dashboardPgReader.readCoreDashboardSheets() — 7/9 tab (bo "Chi tiết hóa
//     đơn"/"Nhập hàng") dung cho getDashboardData() (/api/dashboard).
//   - dashboardPgReader.readDashboardSheets() — du 9 tab, dung cho nhanh du
//     phong bao cao doanh thu theo khach (getCachedDashboardSheets).
//   - dashboardRollupRepository.js — thay the 2 tab da bo (doanh thu theo
//     ngay, top san pham, ngay nhap dau tien...), dung
//     boi getDashboardData().
// Ca 3 mock nguon deu mac dinh tra rong/0 o day — tung test override lai khi
// can du lieu cu the.
function freshDashboardData() {
  delete require.cache[require.resolve('./dashboardData')];
  delete require.cache[require.resolve('./customerDebtActivityRepository')];
  delete require.cache[require.resolve('../debtSchedule/debtScheduleRepository')];
  delete require.cache[require.resolve('../debtSchedule/debtScheduleService')];
  delete require.cache[require.resolve('./dashboardPgReader')];
  delete require.cache[require.resolve('./customerProductTopRepository')];
  delete require.cache[require.resolve('./dashboardRollupRepository')];
  delete require.cache[require.resolve('./customerDirectoryRepository')];
  delete require.cache[require.resolve('./customerInvoiceLinesRepository')];
  const customerDebtActivityRepository = require('./customerDebtActivityRepository');
  customerDebtActivityRepository.readOperationalPeriods = async () => ({
    HN1: [['Khách hàng']], HN3: [['Khách hàng']], HN7: [['Khách hàng']]
  });
  // Cong no (server/debtSchedule): repository gia, mac dinh "chua co ban chot".
  const debtRepo = {
    version: 0,
    readReportCalls: [],
    report: { cycle: null, rows: [], amountsByCustomer: new Map() },
    async readReport(branches) { this.readReportCalls.push(branches); return this.report; },
    getVersion() { return this.version; }
  };
  require('../debtSchedule/debtScheduleRepository').getDebtScheduleRepository = () => debtRepo;
  const dashboardPgReader = require('./dashboardPgReader');
  mockPgSheets(dashboardPgReader, {});
  const customerProductTopRepository = require('./customerProductTopRepository');
  customerProductTopRepository.findTopCustomersByRevenueForProduct = async () => [];
  const dashboardRollupRepository = require('./dashboardRollupRepository');
  mockDashboardRollups(dashboardRollupRepository, {});
  const customerDirectoryRepository = require('./customerDirectoryRepository');
  customerDirectoryRepository.readCustomerDirectory = async () => [];
  // Mac dinh "bang chi tiet 90 ngay chua duoc dung" (null) de cac test cu van di
  // luong doi chieu sheet va khong cham DB that.
  const customerInvoiceLinesRepository = require('./customerInvoiceLinesRepository');
  customerInvoiceLinesRepository.readCustomerInvoiceLines = async () => null;
  const dashboardData = require('./dashboardData');
  return {
    dashboardData, customerDebtActivityRepository, debtRepo,
    dashboardPgReader, customerProductTopRepository, dashboardRollupRepository, customerDirectoryRepository,
    customerInvoiceLinesRepository
  };
}

// Ghi de dashboardPgReader.readDashboardSheets (du 9 tab, cache "full") VA readCoreDashboardSheets (7/9 tab, dung cho getDashboardData) bang
// mock tra du lieu co san (rong cho moi tab, tru cac tab duoc chi dinh trong
// `overrides`) — mot override cho tab nam ngoai 7 tab "core" (Chi tiết hóa
// đơn/Nhập hàng) chi anh huong readDashboardSheets, khong anh huong
// readCoreDashboardSheets (giong dung hanh vi that).
function mockPgSheets(dashboardPgReader, overrides) {
  // readDashboardSheets (full): giu hanh vi cu — merge THANG moi override vao
  // ket qua, ke ca ten khong nam trong SHEET_NAMES (vd CONFIG.SHEET_CUSTOMER_REPORT,
  // tab khong co that trong Postgres nhung mot so test can gia lap "neu co").
  dashboardPgReader.readDashboardSheets = async () => {
    const result = {};
    dashboardPgReader.SHEET_NAMES.forEach(name => { result[name] = []; });
    Object.assign(result, overrides);
    return result;
  };
  // readCoreDashboardSheets (7/9 tab): CHI nhan override cho ten thuc su nam
  // trong CORE_SHEET_NAMES — giong dung san pham that (khong bao gio tra "Chi
  // tiết hóa đơn"/"Nhập hàng"/tab khong ton tai).
  dashboardPgReader.readCoreDashboardSheets = async () => {
    const result = {};
    dashboardPgReader.CORE_SHEET_NAMES.forEach(name => { result[name] = []; });
    Object.keys(overrides || {}).forEach(name => {
      if (dashboardPgReader.CORE_SHEET_NAMES.includes(name)) result[name] = overrides[name];
    });
    return result;
  };
}

// Nhu mockPgSheets nhung dem so lan goi thuc su (khong tinh lan lay tu cache).
// `variant: 'full'` (mac dinh) dem readDashboardSheets (dung cho test lien
// quan search/export cache); `variant: 'core'` dem readCoreDashboardSheets
// (dung cho test lien quan cache cua getDashboardData).
function mockPgSheetsCounted(dashboardPgReader, callCounter, { variant = 'full' } = {}) {
  const fn = async () => {
    callCounter.count += 1;
    const names = variant === 'core' ? dashboardPgReader.CORE_SHEET_NAMES : dashboardPgReader.SHEET_NAMES;
    const result = {};
    names.forEach(name => { result[name] = []; });
    return result;
  };
  if (variant === 'core') dashboardPgReader.readCoreDashboardSheets = fn;
  else dashboardPgReader.readDashboardSheets = fn;
}

// Ghi de toan bo dashboardRollupRepository bang gia tri rong/0 mac dinh, roi
// ap dung `overrides` (map tenHam -> gia tri tra ve, hoac tenHam -> function
// async tuy chinh) — dung cho cac test can kiem soat du lieu rollup cu the.
function mockDashboardRollups(dashboardRollupRepository, overrides = {}) {
  const defaults = {
    getInvoiceRevenueByDay: () => [],
    getProductSalesBreakdown: () => [],
    getTopSellingProducts: () => [],
    getFirstPurchaseDates: () => [],
    getInvoiceQuantitiesByCode: () => []
  };
  Object.keys(defaults).forEach(name => {
    const override = overrides[name];
    if (typeof override === 'function') {
      dashboardRollupRepository[name] = async (...args) => override(...args);
    } else if (override !== undefined) {
      dashboardRollupRepository[name] = async () => override;
    } else {
      dashboardRollupRepository[name] = async () => defaults[name]();
    }
  });
}

// Nhu mockDashboardRollups nhung dem so lan MOI HAM rollup duoc goi THAT SU
// (khong tinh lan lay tu dashboardResultCache/tai su dung) — dung de kiem tra
// Task 1.1 (rollup chi duoc goi khi cache ket qua mien, khong goi truoc khi
// tra cache).
function mockDashboardRollupsCounted(dashboardRollupRepository, callCounter, overrides = {}) {
  const defaults = {
    getInvoiceRevenueByDay: () => [],
    getProductSalesBreakdown: () => [],
    getTopSellingProducts: () => [],
    getFirstPurchaseDates: () => [],
    getInvoiceQuantitiesByCode: () => []
  };
  Object.keys(defaults).forEach(name => {
    const override = overrides[name];
    dashboardRollupRepository[name] = async (...args) => {
      callCounter.count += 1;
      if (typeof override === 'function') return override(...args);
      if (override !== undefined) return override;
      return defaults[name]();
    };
  });
}

const BASE_FILTERS = {
  products: { mode: 'days', days: 30 },
  invoices: { mode: 'days', days: 30 },
  customers: { mode: 'all' },
  newProducts: { mode: 'days', days: 30 }
};

test('getCachedDashboardCoreSheets dung stale-while-revalidate: cache vua het han van tra du lieu cu ngay lap tuc, am tham lam moi o nen', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const callCounter = { count: 0 };
  let releaseSecondFetch;
  dashboardPgReader.readCoreDashboardSheets = async () => {
    callCounter.count += 1;
    const result = {};
    dashboardPgReader.CORE_SHEET_NAMES.forEach(name => { result[name] = []; });
    if (callCounter.count === 2) {
      await new Promise(resolve => { releaseSecondFetch = resolve; });
    }
    return result;
  };
  dashboardData.__test__.resetCaches();

  await dashboardData.getDashboardData(BASE_FILTERS);
  assert.equal(callCounter.count, 1, 'lan goi dau tien phai fetch that');

  dashboardData.__test__.expireSheetsCacheSoftly();

  const startedAt = Date.now();
  await dashboardData.getDashboardData(BASE_FILTERS);
  const elapsedMs = Date.now() - startedAt;

  assert.equal(callCounter.count, 2, 'cache het han phai kich hoat lam moi nen ngay');
  assert.ok(elapsedMs < 500, `khong duoc cho fetch nen (dang treo) hoan tat, nhung mat ${elapsedMs}ms`);

  releaseSecondFetch();
  await new Promise(resolve => setImmediate(resolve));
});

module.exports = {
  freshDashboardData, mockPgSheets, mockPgSheetsCounted, mockDashboardRollups, mockDashboardRollupsCounted, BASE_FILTERS
};

test('getDashboardData cache ket qua da tinh theo tung bo loc, khong tinh lai khi bo loc khong doi va raw sheets van con hieu luc', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const callCounter = { count: 0 };
  mockPgSheetsCounted(dashboardPgReader, callCounter, { variant: 'core' });
  dashboardData.__test__.resetCaches();

  await dashboardData.getDashboardData(BASE_FILTERS);
  await dashboardData.getDashboardData(BASE_FILTERS); // cung bo loc -> phai lay tu cache
  assert.equal(dashboardData.__test__.getComputeCallCount(), 1, 'bo loc khong doi -> khong tinh lai');

  const otherFilters = { ...BASE_FILTERS, products: { mode: 'days', days: 7 } };
  await dashboardData.getDashboardData(otherFilters); // bo loc khac -> phai tinh lai
  assert.equal(dashboardData.__test__.getComputeCallCount(), 2, 'bo loc khac -> phai tinh lai');

  dashboardData.__test__.expireSheetsCache();
  await dashboardData.getDashboardData(BASE_FILTERS); // raw sheets het han -> version moi -> phai tinh lai du bo loc giong lan dau
  assert.equal(dashboardData.__test__.getComputeCallCount(), 3, 'raw sheets refetch -> ket qua cu bi coi la stale, phai tinh lai');
  assert.equal(callCounter.count, 2, 'raw sheets phai duoc fetch lai dung 1 lan nua sau khi het han');
});

test('dashboardResultCache khong phinh vo han trong cung 1 phien ban raw sheets khi bo loc khac nhau khong gioi han', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const callCounter = { count: 0 };
  mockPgSheetsCounted(dashboardPgReader, callCounter, { variant: 'core' });
  dashboardData.__test__.resetCaches();

  // 40 bo loc khac nhau (> muc tran 32) nhung cung 1 phien ban raw sheets ->
  // phai bi cat bot, khong duoc phinh vo han theo so bo loc tu query string.
  for (let days = 1; days <= 40; days++) {
    await dashboardData.getDashboardData({ ...BASE_FILTERS, products: { mode: 'days', days } });
  }

  assert.equal(callCounter.count, 1, 'raw sheets van chi fetch 1 lan (chua het han 90s)');
  assert.equal(dashboardData.__test__.getComputeCallCount(), 40, 'moi bo loc khac nhau deu phai tinh rieng (chua bi cache trung)');
  assert.ok(
    dashboardData.__test__.getResultCacheSize() <= 32,
    `dashboardResultCache phai bi gioi han <= 32 entry, hien tai la ${dashboardData.__test__.getResultCacheSize()}`
  );
});

test('getDashboardData tra dashboardResultCache TRUOC khi goi rollup: lan goi thu 2 cung bo loc tren cache con hieu luc khong duoc goi lai bat ky ham rollup nao', async () => {
  const { dashboardData, dashboardRollupRepository } = freshDashboardData();
  const callCounter = { count: 0 };
  mockDashboardRollupsCounted(dashboardRollupRepository, callCounter);
  dashboardData.__test__.resetCaches();

  await dashboardData.getDashboardData(BASE_FILTERS);
  const countAfterFirstCall = callCounter.count;
  assert.ok(countAfterFirstCall > 0, 'lan dau tren cache trong phai goi rollup that su');
  assert.equal(dashboardData.__test__.getComputeCallCount(), 1);

  await dashboardData.getDashboardData(BASE_FILTERS); // cung bo loc, cache ket qua con hieu luc
  assert.equal(callCounter.count, countAfterFirstCall, 'trung dashboardResultCache -> khong duoc goi lai bat ky ham rollup nao');
  assert.equal(dashboardData.__test__.getComputeCallCount(), 1, 'trung cache -> khong tinh lai');
});

test('getDashboardData het hieu luc cache ket qua ngay khi dashboardRollupEvents phat "updated", du con trong TTL 90s', async () => {
  const { dashboardData, dashboardRollupRepository } = freshDashboardData();
  const callCounter = { count: 0 };
  mockDashboardRollupsCounted(dashboardRollupRepository, callCounter);
  dashboardData.__test__.resetCaches();

  await dashboardData.getDashboardData(BASE_FILTERS);
  const countAfterFirstCall = callCounter.count;
  assert.equal(dashboardData.__test__.getComputeCallCount(), 1);

  const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
  dashboardRollupEvents.emit('updated', { at: Date.now() });

  await dashboardData.getDashboardData(BASE_FILTERS); // cung bo loc nhung rollup da sang phien ban moi
  assert.ok(callCounter.count > countAfterFirstCall, 'sau su kien updated, rollup phai duoc goi lai du bo loc giong het lan truoc');
  assert.equal(dashboardData.__test__.getComputeCallCount(), 2, 'phien ban rollup doi -> phai tinh lai du bo loc khong doi');
});

test('getDashboardData gop nhieu request TRUNG cacheKey toi cung luc tren cache trong thanh 1 lan fetch rollup + compute (single-flight)', async () => {
  const { dashboardData, dashboardRollupRepository } = freshDashboardData();
  const callCounter = { count: 0 };
  mockDashboardRollupsCounted(dashboardRollupRepository, callCounter);
  dashboardData.__test__.resetCaches();

  const [first, second, third] = await Promise.all([
    dashboardData.getDashboardData(BASE_FILTERS),
    dashboardData.getDashboardData(BASE_FILTERS),
    dashboardData.getDashboardData(BASE_FILTERS)
  ]);

  assert.equal(dashboardData.__test__.getComputeCallCount(), 1, '3 request trung cacheKey cung luc chi duoc tinh 1 lan, khong phai 3');
  // fetchDashboardRollups() goi 3 lan rollup cho 1 co so (getInvoiceRevenueByDay
  // goi 2 lan cho overview/invoices range, getInvoiceQuantitiesByCode 1 lan) — BASE_FILTERS
  // ung voi 1 co so vat ly (Ha Noi mac dinh) nen dung 1 lan fetchDashboardRollups
  // duy nhat cho ca 3 request; neu khong gop (single-flight) con so nay se la 9 (x3).
  assert.equal(callCounter.count, 3, 'ca 3 request trung cacheKey chi duoc goi rollup 1 luot (khong phai 3 luot => 9)');
  assert.equal(first, second, 'ca 3 ket qua phai la cung 1 object reference (den tu chung 1 promise)');
  assert.equal(second, third, 'ca 3 ket qua phai la cung 1 object reference (den tu chung 1 promise)');
});

test('prewarmDashboardCaches nap san cache "nguon re" cho ca hai co so, getDashboardData sau do khong doc lai Postgres', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const callCounter = { count: 0 };
  mockPgSheetsCounted(dashboardPgReader, callCounter, { variant: 'core' });
  dashboardData.__test__.resetCaches();

  await assert.doesNotReject(dashboardData.prewarmDashboardCaches());
  const countAfterPrewarm = callCounter.count;
  assert.equal(countAfterPrewarm, 2, 'prewarm phai doc Postgres dung 1 lan cho MOI co so vat ly (Ha Noi + Sai Gon)');

  // BASE_FILTERS khong truyen branch -> mac dinh Ha Noi, phai dung lai cache
  // da nap san boi prewarm, KHONG doc lai Postgres.
  await dashboardData.getDashboardData(BASE_FILTERS);
  assert.equal(callCounter.count, countAfterPrewarm, 'getDashboardData sau prewarm phai dung lai cache, khong doc lai Postgres');
});

test('prewarmDashboardCaches van resolve (khong nem loi) va chi log loi khi mot co so khong doc duoc Postgres', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  let callCount = 0;
  dashboardPgReader.readCoreDashboardSheets = async branch => {
    callCount += 1;
    if (branch === 'Sài Gòn') throw new Error('Gia lap mat ket noi Postgres');
    const result = {};
    dashboardPgReader.CORE_SHEET_NAMES.forEach(name => { result[name] = []; });
    return result;
  };
  dashboardData.__test__.resetCaches();

  const logs = [];
  await assert.doesNotReject(dashboardData.prewarmDashboardCaches({ log: msg => logs.push(msg) }));

  assert.equal(callCount, 2, 'phai thu doc ca 2 co so du 1 co so loi (khong dung giua chung)');
  assert.ok(logs.some(msg => msg.includes('Hà Nội') && msg.includes('xong')), 'co so thanh cong phai duoc log');
  assert.ok(logs.some(msg => msg.includes('Sài Gòn') && msg.includes('loi')), 'co so loi phai duoc log loi, khong lam prewarm crash');
});

test('getDashboardData tra toan bo giao dich trong bang chi tiet, bieu do van chi top 15', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const CONFIG = require('../config');
  const invoiceHeader = ['Mã hóa đơn', 'Ngày bán', 'Khách hàng', 'SĐT khách', 'Nhân viên bán', 'Chi nhánh', 'Tổng tiền hàng', 'Giảm giá', 'Khách đã trả', 'Trạng thái'];
  const invoiceRows = Array.from({ length: 505 }, (_, index) => [
    `HD-${String(index + 1).padStart(3, '0')}`, '10/08/2026 10:00:00', 'Khách', '', 'Sale', '', index + 1, 0, index + 1, 'Hoàn thành'
  ]);
  mockPgSheets(dashboardPgReader, { [CONFIG.SHEET_INVOICES]: [invoiceHeader, ...invoiceRows] });
  dashboardData.__test__.resetCaches();

  const data = await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'all' } });
  const report = data.invoices.transactionsReport;

  assert.equal(report.transactions.length, 505, 'bang chi tiet khong bi cat o 500 dong');
  assert.equal(report.topTransactions.length, 15, 'bieu do van chi hien top 15');
  assert.equal(report.truncated, false);
});

test('chi tiet giao dich: moi dong co timeMs (epoch ms cua gio ban) vi chuoi `time` khong co nam, de bang sap theo THOI GIAN that', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const CONFIG = require('../config');
  const invoiceHeader = ['Mã hóa đơn', 'Ngày bán', 'Khách hàng', 'SĐT khách', 'Nhân viên bán', 'Chi nhánh', 'Tổng tiền hàng', 'Giảm giá', 'Khách đã trả', 'Trạng thái'];
  mockPgSheets(dashboardPgReader, {
    [CONFIG.SHEET_INVOICES]: [
      invoiceHeader,
      ['HD-A', '30/09/2026 10:00:00', 'Khách', '', 'Sale', '', 100, 0, 100, 'Hoàn thành'],
      ['HD-B', '01/10/2026 09:00:00', 'Khách', '', 'Sale', '', 100, 0, 100, 'Hoàn thành'],
      ['HD-C', '', 'Khách', '', 'Sale', '', 100, 0, 100, 'Hoàn thành']
    ]
  });
  dashboardData.__test__.resetCaches();

  const data = await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'all' } });
  const byCode = Object.fromEntries(data.invoices.transactionsReport.transactions.map(row => [row.code, row]));

  // Gio ban la gio dia phuong VN (UTC+7), `timeMs` la thoi diem tuyet doi tuong ung.
  assert.equal(byCode['HD-A'].timeMs, Date.parse('2026-09-30T10:00:00+07:00'));
  assert.equal(byCode['HD-B'].timeMs, Date.parse('2026-10-01T09:00:00+07:00'));
  assert.equal(byCode['HD-A'].time, '30/09 10:00', 'chuoi hien thi giu nguyen (dd/MM HH:mm, khong nam)');
  assert.ok(byCode['HD-B'].timeMs > byCode['HD-A'].timeMs, '01/10 sau 30/09 theo thoi gian that');
  assert.equal(byCode['HD-C'].timeMs, null, 'hoa don khong co gio ban -> timeMs null (khong phai 0/1970)');
  assert.equal(byCode['HD-C'].time, '—');
});

// Hoa don + Tra hang dung chung cho 2 test duoi (the chi so tab Hoa don sau khi go returnsCount/totalReturns).
function invoiceTabSheets(CONFIG) {
  return {
    [CONFIG.SHEET_INVOICES]: [
      ['Mã hóa đơn', 'Ngày bán', 'Khách hàng', 'SĐT khách', 'Nhân viên bán', 'Chi nhánh', 'Tổng tiền hàng', 'Giảm giá', 'Khách đã trả', 'Trạng thái'],
      ['HD-01', '10/08/2026 09:00:00', 'Khách A', '', 'NV', '', 300, 20, 280, 'Hoàn thành'],
      ['HD-02', '10/08/2026 11:00:00', 'Khách B', '', 'NV', '', 200, 0, 150, 'Hoàn thành'],
      ['HD-03', '10/08/2026 12:00:00', 'Khách C', '', 'NV', '', 999, 0, 0, 'Đã hủy'],
      ['HD-CU', '01/01/2026 10:00:00', 'Khách D', '', 'NV', '', 70, 5, 65, 'Hoàn thành']
    ],
    [CONFIG.SHEET_RETURNS]: [
      ['Mã trả hàng', 'Ngày trả', 'Mã hóa đơn', 'Khách hàng', 'Tổng tiền trả', 'Trạng thái'],
      ['TH-TRA', '10/08/2026 10:00:00', 'HD-01', 'Khách A', 50, 'Đã trả'],
      ['TH-HUY', '10/08/2026 10:01:00', 'HD-01', 'Khách A', 60, 'Đã hủy']
    ]
  };
}

test('tab Hoa don: da go returnsCount/totalReturns/periodGrossRevenue — Doanh thu/Thuc thu/Giam gia/So giao dich KHONG doi', async () => {
  const { dashboardData, dashboardPgReader, dashboardRollupRepository } = freshDashboardData();
  const CONFIG = require('../config');
  mockPgSheets(dashboardPgReader, invoiceTabSheets(CONFIG));
  // Rollup daily_invoice_summary: doanh thu thuc te = ban (500) − tra hang (50).
  mockDashboardRollups(dashboardRollupRepository, {
    getInvoiceRevenueByDay: () => [{ dateKey: '10/08/2026', revenue: 450, grossRevenue: 500, returnAmount: 50, invoiceCount: 2 }]
  });
  dashboardData.__test__.resetCaches();

  const range = await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'range', from: '2026-08-10', to: '2026-08-10' } });
  for (const key of ['returnsCount', 'totalReturns', 'periodGrossRevenue']) {
    assert.equal(key in range.invoices, false, key + ' da go khoi payload tab Hoa don');
  }
  // Cac so tab Hoa don hien thi (renderSectionKpis 'transactionsKpis'): chi tinh hoa don Hoan thanh trong ky.
  const { summary, transactions } = range.invoices.transactionsReport;
  assert.equal(transactions.length, 3, 'So giao dich: moi hoa don trong ky (ke ca Đã hủy)');
  assert.equal(summary.transactionCount, 2);
  assert.equal(summary.revenue, 500, 'Doanh thu = tong tien hang hoa don Hoan thanh');
  assert.equal(summary.discount, 20, 'Giam gia');
  assert.equal(summary.paid, 430, 'Thuc thu');
  // Doanh thu theo ngay = ban − tra hang (rollup) van giu nguyen.
  assert.equal(range.invoices.periodRevenue, 450);
  assert.equal(range.invoices.periodReturnAmount, 50);
  assert.equal(range.invoices.periodInvoices, 2);
  assert.equal(range.invoices.periodCancelledInvoices, 1);

  // 2 bang Dat hang / Tra hang (va KPI don cho) da bo khoi payload tab Hoa don.
  for (const key of ['periodOrders', 'periodReturns', 'pendingOrdersCount', 'pendingOrdersTotal', 'recentOrders', 'recentReturns']) {
    assert.equal(key in range.invoices, false, key + ' khong con trong payload');
  }
  assert.equal('orders' in range.filters, false);
  assert.equal('returns' in range.filters, false);
});

test('bo loc orders/returns cu trong yeu cau bi bo qua (khong anh huong ket qua / khong loi)', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const CONFIG = require('../config');
  mockPgSheets(dashboardPgReader, invoiceTabSheets(CONFIG));
  dashboardData.__test__.resetCaches();
  const data = await dashboardData.getDashboardData({
    ...BASE_FILTERS,
    invoices: { mode: 'all' },
    // Client cu con gui bo loc rieng cua bang da bo: phai bi bo qua, bang van theo bo loc Hoa don.
    orders: { mode: 'days', days: 1 },
    returns: { mode: 'days', days: 1 }
  });
  assert.equal(data.invoices.transactionsReport.transactions.length, 4);
  assert.equal(data.invoices.transactionsReport.summary.revenue, 570);
});

test('cache cua Ha Noi khong ro ri sang Sai Gon — moi co so fetch rieng', async () => {
  const { dashboardData, dashboardPgReader, customerDebtActivityRepository } = freshDashboardData();
  const { BRANCHES } = require('../branch/branches');
  const seen = [];
  // Ghi de dashboardPgReader.readCoreDashboardSheets de biet getDashboardData
  // hoi du lieu cua co so nao (nguon chinh cho /api/dashboard, nhan branch
  // truc tiep).
  dashboardPgReader.readCoreDashboardSheets = async (branch) => {
    seen.push(branch);
    const result = {};
    dashboardPgReader.CORE_SHEET_NAMES.forEach(name => { result[name] = []; });
    return result;
  };
  customerDebtActivityRepository.readOperationalPeriods = async () => ({
    HN1: [['Khách hàng']], HN3: [['Khách hàng']], HN7: [['Khách hàng']]
  });
  dashboardData.__test__.resetCaches();

  await dashboardData.getDashboardData(BASE_FILTERS, BRANCHES.HANOI);
  await dashboardData.getDashboardData(BASE_FILTERS, BRANCHES.SAIGON);
  await dashboardData.getDashboardData(BASE_FILTERS, BRANCHES.HANOI);

  assert.deepEqual(
    seen,
    [BRANCHES.HANOI, BRANCHES.SAIGON],
    'moi co so fetch dung 1 lan; lan goi Ha Noi thu hai phai lay tu cache cua Ha Noi'
  );
});

test('Ca hai giu giao dich trung ma theo (co so, ma) va gan provenance', async () => {
  const { dashboardData, dashboardPgReader, dashboardRollupRepository } = freshDashboardData();
  const CONFIG = require('../config');
  const { BRANCHES, BRANCH_BOTH } = require('../branch/branches');
  dashboardPgReader.readCoreDashboardSheets = async branch => {
    const result = Object.fromEntries(dashboardPgReader.CORE_SHEET_NAMES.map(name => [name, []]));
    result[CONFIG.SHEET_CATEGORIES] = [['Mã nhóm hàng', 'Tên nhóm hàng', 'Mã nhóm cha']];
    result[CONFIG.SHEET_PRODUCTS] = [['Mã hàng', 'Tên hàng', 'Nhóm hàng', 'Loại hàng', 'Giá vốn', 'Giá bán', 'Tồn kho', 'Khách đặt', 'Trạng thái']];
    result[CONFIG.SHEET_CUSTOMERS] = [['Mã khách hàng', 'Tên khách hàng', 'Điện thoại', 'Nợ hiện tại']];
    result[CONFIG.SHEET_INVOICES] = [
      ['Mã hóa đơn', 'Ngày bán', 'Khách hàng', 'SĐT khách', 'Nhân viên bán', 'Chi nhánh', 'Tổng tiền hàng', 'Giảm giá', 'Khách đã trả', 'Trạng thái'],
      ['HD-TRUNG', '10/08/2026 10:00:00', 'Khách', '', '', '', branch === BRANCHES.HANOI ? 100 : 200, 0, 0, 'Hoàn thành']
    ];
    result[CONFIG.SHEET_RETURNS] = [
      ['Mã trả hàng', 'Ngày trả', 'Khách hàng', 'Tổng tiền trả', 'Trạng thái', 'Chi nhánh'],
      ['TH-TRUNG', '10/08/2026 12:00:00', 'Khách', 5, 'Đã trả', '']
    ];
    return result;
  };
  mockDashboardRollups(dashboardRollupRepository, {
    getInvoiceQuantitiesByCode: ({ branch }) => [{ code: 'HD-TRUNG', quantity: branch === BRANCHES.HANOI ? 1 : 2 }]
  });
  dashboardData.__test__.resetCaches();

  const data = await dashboardData.getDashboardData({
    ...BASE_FILTERS, invoices: { mode: 'all' }
  }, BRANCH_BOTH);

  assert.deepEqual(data.invoices.transactionsReport.transactions.map(row => [row.code, row.branch, row.quantity]), [
    ['HD-TRUNG', BRANCHES.HANOI, 1], ['HD-TRUNG', BRANCHES.SAIGON, 2]
  ]);
  assert.equal(data.invoices.transactionsReport.summary.revenue, 300, 'cong du hoa don trung ma cua 2 co so');
  assert.equal('returnsCount' in data.invoices, false);
});

test('cache Ca hai co scope rieng va doi key khi version mot nguon vat ly thay doi', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const { BRANCHES, BRANCH_BOTH } = require('../branch/branches');
  const calls = { [BRANCHES.HANOI]: 0, [BRANCHES.SAIGON]: 0 };
  dashboardPgReader.readCoreDashboardSheets = async branch => {
    calls[branch] += 1;
    return Object.fromEntries(dashboardPgReader.CORE_SHEET_NAMES.map(name => [name, []]));
  };
  dashboardData.__test__.resetCaches();

  await dashboardData.getDashboardData(BASE_FILTERS, BRANCHES.HANOI);
  await dashboardData.getDashboardData(BASE_FILTERS, BRANCHES.SAIGON);
  const physicalComputeCount = dashboardData.__test__.getComputeCallCount();
  await dashboardData.getDashboardData(BASE_FILTERS, BRANCH_BOTH);
  const aggregateComputeCount = dashboardData.__test__.getComputeCallCount();
  await dashboardData.getDashboardData(BASE_FILTERS, BRANCH_BOTH);

  assert.equal(aggregateComputeCount, physicalComputeCount + 1);
  assert.equal(dashboardData.__test__.getComputeCallCount(), aggregateComputeCount, 'lan hai phai dung aggregate cache');
  dashboardData.__test__.expireSheetsCache(BRANCHES.SAIGON);
  await dashboardData.getDashboardData(BASE_FILTERS, BRANCH_BOTH);
  assert.deepEqual(calls, { [BRANCHES.HANOI]: 1, [BRANCHES.SAIGON]: 2 });
  assert.equal(dashboardData.__test__.getComputeCallCount(), aggregateComputeCount + 1);
});

test('Ca hai fail request neu nguon van han cua mot co so loi', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const { BRANCHES, BRANCH_BOTH } = require('../branch/branches');
  dashboardPgReader.readCoreDashboardSheets = async branch => {
    if (branch === BRANCHES.SAIGON) throw new Error('Supabase SG lỗi');
    return Object.fromEntries(dashboardPgReader.CORE_SHEET_NAMES.map(name => [name, []]));
  };
  dashboardData.__test__.resetCaches();

  await assert.rejects(dashboardData.getDashboardData(BASE_FILTERS, BRANCH_BOTH), /Supabase SG lỗi/);
});

// ===== getCustomerProductRevenueReport (tab Khach hang, phan 4) =====

const INVOICE_HEADERS = [
  'Mã hóa đơn', 'Ngày bán', 'Khách hàng', 'SĐT khách', 'Nhân viên bán', 'Chi nhánh',
  'Tổng tiền hàng', 'Giảm giá', 'Khách đã trả', 'Trạng thái', 'ID hóa đơn', 'Mã đặt hàng',
  'ID chi nhánh', 'ID nhân viên bán', 'ID khách hàng', 'Mã khách hàng', 'Mã trạng thái',
  'Tên trạng thái API', 'Ghi chú', 'Thu hộ COD', 'Ngày tạo'
];
const DETAIL_HEADERS = [
  'Mã hóa đơn', 'Mã hàng', 'Tên hàng', 'Số lượng', 'Đơn giá', 'Giảm giá', 'Thành tiền',
  'ID hóa đơn', 'ID hàng hóa', 'Giảm giá (%)', 'Ghi chú'
];

function invoiceRow({ code, date, name = '', phone = '', status = 'Hoàn thành', custCode = '' }) {
  const row = new Array(INVOICE_HEADERS.length).fill('');
  row[0] = code; row[1] = date; row[2] = name; row[3] = phone; row[9] = status; row[15] = custCode;
  return row;
}

function detailRow({ invoiceCode, itemCode, itemName, qty, total }) {
  const row = new Array(DETAIL_HEADERS.length).fill('');
  row[0] = invoiceCode; row[1] = itemCode; row[2] = itemName; row[3] = qty; row[6] = total;
  return row;
}

function mockCustomerProductRevenueSheets(dashboardPgReader, { invoices = [], details = [], customers = [] }) {
  const CONFIG = require('../config');
  mockPgSheets(dashboardPgReader, {
    [CONFIG.SHEET_INVOICES]: [INVOICE_HEADERS, ...invoices],
    [CONFIG.SHEET_INVOICE_DETAILS]: [DETAIL_HEADERS, ...details],
    [CONFIG.SHEET_CUSTOMERS]: [['Mã khách hàng', 'Tên khách hàng', 'Điện thoại'], ...customers]
  });
}

test('bao cao doanh thu theo khach: join dung hoa don hoan thanh/trong ky/dung khach, bo qua phan con lai', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const now = new Date('2026-08-14T12:00:00+07:00');
  mockCustomerProductRevenueSheets(dashboardPgReader, {
    invoices: [
      invoiceRow({ code: 'HD-1', date: '10/08/2026 10:00:00', custCode: 'KH-A', status: 'Hoàn thành' }),
      invoiceRow({ code: 'HD-2', date: '10/08/2026 11:00:00', custCode: 'KH-A', status: 'Đang xử lý' }),
      invoiceRow({ code: 'HD-3', date: '10/08/2026 12:00:00', custCode: 'KH-B', status: 'Hoàn thành' }),
      invoiceRow({ code: 'HD-4', date: '01/01/2026 09:00:00', custCode: 'KH-A', status: 'Hoàn thành' })
    ],
    details: [
      detailRow({ invoiceCode: 'HD-1', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 2, total: 200 }),
      detailRow({ invoiceCode: 'HD-1', itemCode: 'SP-02', itemName: 'Sản phẩm hai', qty: 1, total: 100 }),
      detailRow({ invoiceCode: 'HD-2', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 5, total: 500 }),
      detailRow({ invoiceCode: 'HD-3', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 9, total: 900 }),
      detailRow({ invoiceCode: 'HD-4', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 7, total: 700 })
    ]
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-A', '', undefined, now);

  assert.equal(report.customer.code, 'KH-A');
  assert.equal(report.totalRevenue, 300);
  assert.equal(report.totalQuantity, 3);
  assert.deepEqual(
    report.products.map(p => [p.code, p.quantity, p.revenue]),
    [['SP-01', 2, 200], ['SP-02', 1, 100]]
  );
});

test('bao cao doanh thu theo khach: totalRevenueByDay luon du 90 diem, ngay khong phat sinh la 0', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const now = new Date('2026-08-14T12:00:00+07:00');
  mockCustomerProductRevenueSheets(dashboardPgReader, {
    invoices: [invoiceRow({ code: 'HD-1', date: '10/08/2026 10:00:00', custCode: 'KH-A' })],
    details: [detailRow({ invoiceCode: 'HD-1', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 1, total: 150 })]
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-A', '', undefined, now);

  assert.equal(report.totalRevenueByDay.length, 90);
  assert.equal(report.totalRevenueByDay.reduce((s, d) => s + d.revenue, 0), 150);
  const emptyDay = report.totalRevenueByDay.find(d => d.date === '01/08/2026');
  assert.equal(emptyDay.revenue, 0);
  const invoiceDay = report.totalRevenueByDay.find(d => d.date === '10/08/2026');
  assert.equal(invoiceDay.revenue, 150);
});

test('bao cao doanh thu theo khach: chia dung 3 bucket T.nay/T.truoc/T.truoc nua, loai hoa don o ngay thu 90', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const now = new Date('2026-08-14T12:00:00+07:00');
  const offsetDates = {
    0: '14/08/2026', 29: '16/07/2026', 30: '15/07/2026',
    59: '16/06/2026', 60: '15/06/2026', 89: '17/05/2026', 90: '16/05/2026'
  };
  const invoices = Object.entries(offsetDates).map(([offset, date]) =>
    invoiceRow({ code: 'HD-' + offset, date: date + ' 08:00:00', custCode: 'KH-A' }));
  const details = Object.keys(offsetDates).map(offset =>
    detailRow({ invoiceCode: 'HD-' + offset, itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 1, total: 100 }));
  mockCustomerProductRevenueSheets(dashboardPgReader, { invoices, details });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-A', '', undefined, now);
  const product = report.products.find(p => p.code === 'SP-01');

  assert.equal(product.month1Revenue, 200, 'ngay 0 va 29 thuoc T.nay');
  assert.equal(product.month2Revenue, 200, 'ngay 30 va 59 thuoc T.truoc');
  assert.equal(product.month3Revenue, 200, 'ngay 60 va 89 thuoc T.truoc nua');
  assert.equal(product.revenue, 600, 'hoa don ngay thu 90 nam ngoai cua so 90 ngay, khong duoc tinh');
});

test('bao cao doanh thu theo khach: khop khach qua SDT hoac ten khi hoa don thieu ma khach hang', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const now = new Date('2026-08-14T12:00:00+07:00');
  mockCustomerProductRevenueSheets(dashboardPgReader, {
    customers: [['KH-A', 'Khách   A  ', '0900000001']],
    invoices: [
      invoiceRow({ code: 'HD-1', date: '10/08/2026 10:00:00', phone: '0900000001', status: 'Hoàn thành' }),
      invoiceRow({ code: 'HD-2', date: '11/08/2026 10:00:00', name: '  khách A', status: 'Hoàn thành' })
    ],
    details: [
      detailRow({ invoiceCode: 'HD-1', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 1, total: 100 }),
      detailRow({ invoiceCode: 'HD-2', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 1, total: 100 })
    ]
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-A', '', undefined, now);

  assert.equal(report.totalRevenue, 200, 'ca 2 hoa don (khop qua SDT va qua ten chuan hoa) deu duoc tinh');
});

test('bao cao doanh thu theo khach: thieu ma khach hang thi bao loi ro rang, khong quet du lieu', async () => {
  const { dashboardData } = freshDashboardData();
  dashboardData.__test__.resetCaches();

  await assert.rejects(
    dashboardData.getCustomerProductRevenueReport('', '', undefined, new Date('2026-08-14T12:00:00+07:00')),
    error => error.statusCode === 400 && error.code === 'CUSTOMER_CODE_REQUIRED'
  );
});

test('bao cao doanh thu theo khach: co lap theo chi nhanh, khong ro ri du lieu giua Ha Noi va Sai Gon', async () => {
  const { dashboardData, dashboardPgReader, customerDebtActivityRepository } = freshDashboardData();
  const { BRANCHES } = require('../branch/branches');
  const CONFIG = require('../config');
  const seen = [];
  customerDebtActivityRepository.readOperationalPeriods = async () => ({
    HN1: [['Khách hàng']], HN3: [['Khách hàng']], HN7: [['Khách hàng']]
  });
  dashboardPgReader.readDashboardSheets = async branch => {
    seen.push(branch);
    const result = {};
    dashboardPgReader.SHEET_NAMES.forEach(name => { result[name] = []; });
    result[CONFIG.SHEET_INVOICES] = [INVOICE_HEADERS,
      invoiceRow({ code: 'HD-1', date: '10/08/2026 10:00:00', custCode: 'KH-A', status: 'Hoàn thành' })];
    result[CONFIG.SHEET_INVOICE_DETAILS] = [DETAIL_HEADERS,
      detailRow({ invoiceCode: 'HD-1', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 1, total: branch === BRANCHES.SAIGON ? 999 : 100 })];
    return result;
  };
  dashboardData.__test__.resetCaches();
  const now = new Date('2026-08-14T12:00:00+07:00');

  const hanoi = await dashboardData.getCustomerProductRevenueReport('KH-A', '', BRANCHES.HANOI, now);
  const saigon = await dashboardData.getCustomerProductRevenueReport('KH-A', '', BRANCHES.SAIGON, now);

  assert.equal(hanoi.totalRevenue, 100);
  assert.equal(saigon.totalRevenue, 999);
  assert.deepEqual(seen, [BRANCHES.HANOI, BRANCHES.SAIGON]);
});

// ----- Nguon bang chi tiet hoa don 90 ngay (customer_invoice_lines_90d) -----

function stubInvoiceLines(customerInvoiceLinesRepository, snapshot) {
  const calls = [];
  customerInvoiceLinesRepository.readCustomerInvoiceLines = async params => { calls.push(params); return snapshot; };
  return calls;
}

function invoiceLine({ dateKey, itemCode, itemName, quantity, revenue, customerName = 'Khách A' }) {
  return { dateKey, customerName, itemCode, itemName, quantity, revenue };
}

test('bao cao doanh thu theo khach doc tu bang chi tiet 90 ngay: khong quet sheet, cua so theo bang', async () => {
  const { dashboardData, dashboardPgReader, customerInvoiceLinesRepository } = freshDashboardData();
  dashboardPgReader.readDashboardSheets = async () => { throw new Error('khong duoc doc sheet khi da co bang'); };
  const computedAt = new Date('2026-08-14T17:10:00Z');
  const calls = stubInvoiceLines(customerInvoiceLinesRepository, {
    window: { start: '2026-05-17', end: '2026-08-14' },
    computedAt,
    linesByBranch: {
      hanoi: [
        invoiceLine({ dateKey: '14/08/2026', itemCode: 'SP-01', itemName: 'Sản phẩm một', quantity: '2', revenue: '200' }),
        invoiceLine({ dateKey: '16/07/2026', itemCode: 'SP-01', itemName: 'Tên cũ', quantity: '1', revenue: '100' }),
        invoiceLine({ dateKey: '15/07/2026', itemCode: 'SP-02', itemName: 'Sản phẩm hai', quantity: '3', revenue: '50' })
      ]
    }
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport(' KH-A ', 'Khách A', undefined, new Date('2026-08-15T12:00:00+07:00'));

  assert.deepEqual(calls, [{ branchCodes: ['hanoi'], customerCode: 'KH-A' }]);
  assert.deepEqual(report.customer, { code: 'KH-A', name: 'Khách A' });
  assert.deepEqual([report.range.from, report.range.to, report.range.days], ['17/05/2026', '14/08/2026', 90]);
  assert.equal(report.totalRevenueByDay.length, 90);
  assert.equal(report.totalRevenueByDay[0].date, '17/05/2026');
  assert.equal(report.totalRevenueByDay[89].date, '14/08/2026');
  assert.equal(report.totalRevenue, 350);
  assert.equal(report.totalQuantity, 6);
  assert.deepEqual(
    report.products.map(p => [p.code, p.name, p.quantity, p.revenue, p.month1Revenue, p.month2Revenue, p.month3Revenue]),
    [['SP-01', 'Sản phẩm một', 3, 300, 300, 0, 0], ['SP-02', 'Sản phẩm hai', 3, 50, 0, 50, 0]],
    'ngay cuoi cua so = tuoi 0; 16/07 (29 ngay truoc) vao T.nay, 15/07 (30 ngay truoc) vao T.truoc; ten lay o dong dau'
  );
  assert.equal(report.products[0].revenueByDay.find(d => d.date === '16/07/2026').revenue, 100);
  assert.equal(report.computedAt, computedAt);
});

test('bao cao doanh thu theo khach tu bang: ten khach lay tu hoa don khi nguoi goi khong truyen ten', async () => {
  const { dashboardData, customerInvoiceLinesRepository } = freshDashboardData();
  stubInvoiceLines(customerInvoiceLinesRepository, {
    window: { start: '2026-05-17', end: '2026-08-14' },
    computedAt: new Date(),
    linesByBranch: { hanoi: [invoiceLine({ dateKey: '10/08/2026', itemCode: 'SP-01', itemName: 'Một', quantity: 1, revenue: 10, customerName: 'Chị Lan' })] }
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-A', '', undefined, new Date('2026-08-15T12:00:00+07:00'));
  assert.equal(report.customer.name, 'Chị Lan');
});

test('bao cao doanh thu theo khach tu bang: khach khong co dong nao tra bao cao rong day du 90 ngay', async () => {
  const { dashboardData, customerInvoiceLinesRepository } = freshDashboardData();
  stubInvoiceLines(customerInvoiceLinesRepository, {
    window: { start: '2026-05-17', end: '2026-08-14' },
    computedAt: new Date(),
    linesByBranch: { hanoi: [] }
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-A', 'Khách A', undefined, new Date('2026-08-15T12:00:00+07:00'));
  assert.equal(report.totalRevenue, 0);
  assert.deepEqual(report.products, []);
  assert.equal(report.totalRevenueByDay.length, 90);
});

test('Ca hai bao cao doanh thu theo khach tu bang: gop theo ma hang, ten Ha Noi truoc, co lap tung co so', async () => {
  const { dashboardData, dashboardPgReader, customerInvoiceLinesRepository } = freshDashboardData();
  const { BRANCH_BOTH } = require('../branch/branches');
  dashboardPgReader.readDashboardSheets = async () => { throw new Error('khong duoc doc sheet khi da co bang'); };
  const calls = stubInvoiceLines(customerInvoiceLinesRepository, {
    window: { start: '2026-05-22', end: '2026-08-19' },
    computedAt: new Date('2026-08-19T17:10:00Z'),
    linesByBranch: {
      hanoi: [invoiceLine({ dateKey: '18/08/2026', itemCode: 'SP-1', itemName: 'Áo Hà Nội', quantity: 1, revenue: 100 })],
      saigon: [
        invoiceLine({ dateKey: '19/08/2026', itemCode: 'sp-1', itemName: 'Áo Sài Gòn', quantity: 2, revenue: 300 }),
        invoiceLine({ dateKey: '19/08/2026', itemCode: 'SP-2', itemName: 'Hàng hai', quantity: 1, revenue: 50 })
      ]
    }
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-1', 'Khách 1', BRANCH_BOTH, new Date('2026-08-20T03:00:00.000Z'));

  assert.deepEqual(calls, [{ branchCodes: ['hanoi', 'saigon'], customerCode: 'KH-1' }]);
  assert.deepEqual(report.products.map(p => [p.code, p.name, p.quantity, p.revenue]), [
    ['SP-1', 'Áo Hà Nội', 3, 400], ['SP-2', 'Hàng hai', 1, 50]
  ]);
  assert.equal(report.totalRevenue, 450);
  assert.equal(report.totalRevenueByDay.find(d => d.date === '19/08/2026').revenue, 350);
  assert.equal(report.totalRevenueByDay.length, 90);
  assert.ok(report.computedAt instanceof Date);
});

test('bao cao doanh thu theo khach: bang chua dung (null) thi quay ve luong sheet cu', async () => {
  const { dashboardData, dashboardPgReader, customerInvoiceLinesRepository } = freshDashboardData();
  const calls = stubInvoiceLines(customerInvoiceLinesRepository, null);
  mockCustomerProductRevenueSheets(dashboardPgReader, {
    invoices: [invoiceRow({ code: 'HD-1', date: '10/08/2026 10:00:00', custCode: 'KH-A' })],
    details: [detailRow({ invoiceCode: 'HD-1', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 2, total: 200 })]
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-A', '', undefined, new Date('2026-08-14T12:00:00+07:00'));

  assert.equal(calls.length, 1);
  assert.equal(report.totalRevenue, 200);
  assert.equal(report.computedAt, undefined);
});

test('bao cao doanh thu theo khach: loi doc bang (vd chua chay migration) thi ghi log va quay ve luong sheet cu', async () => {
  const { dashboardData, dashboardPgReader, customerInvoiceLinesRepository } = freshDashboardData();
  customerInvoiceLinesRepository.readCustomerInvoiceLines = async () => { throw new Error('relation "customer_invoice_lines_state" does not exist'); };
  mockCustomerProductRevenueSheets(dashboardPgReader, {
    invoices: [invoiceRow({ code: 'HD-1', date: '10/08/2026 10:00:00', custCode: 'KH-A' })],
    details: [detailRow({ invoiceCode: 'HD-1', itemCode: 'SP-01', itemName: 'Sản phẩm một', qty: 2, total: 200 })]
  });
  dashboardData.__test__.resetCaches();
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let report;
  try {
    report = await dashboardData.getCustomerProductRevenueReport('KH-A', '', undefined, new Date('2026-08-14T12:00:00+07:00'));
  } finally {
    console.error = originalError;
  }

  assert.equal(report.totalRevenue, 200);
  assert.match(errors.join('\n'), /does not exist/);
});

test('bao cao doanh thu theo khach: thieu ma khach thi bao loi 400 va khong cham bang chi tiet', async () => {
  const { dashboardData, customerInvoiceLinesRepository } = freshDashboardData();
  const calls = stubInvoiceLines(customerInvoiceLinesRepository, null);
  dashboardData.__test__.resetCaches();

  await assert.rejects(
    dashboardData.getCustomerProductRevenueReport('  ', '', undefined, new Date('2026-08-14T12:00:00+07:00')),
    error => error.statusCode === 400 && error.code === 'CUSTOMER_CODE_REQUIRED'
  );
  assert.equal(calls.length, 0);
});

const PRODUCT_HEADERS = [
  'Mã hàng', 'Tên hàng', 'Nhóm hàng', 'Đơn vị', 'Loại hàng', 'Giá vốn', 'Giá bán',
  'Tồn kho', 'Khách đặt', 'Trạng thái', 'Ghi chú', 'Mã nhóm hàng'
];
function productRow({ code, name, cost = 0, price = 0, stock = 0, status = 'Đang kinh doanh' }) {
  const row = new Array(PRODUCT_HEADERS.length).fill('');
  row[0] = code; row[1] = name; row[5] = cost; row[6] = price; row[7] = stock; row[9] = status;
  return row;
}

// ===== getDashboardData: cac khoi da chuyen tu quet "Chi tiết hóa đơn"/
// "Nhập hàng" (bo khoi cache "core") sang dashboardRollupRepository.js =====
// Dung bo loc 'range' (tu ngay/den ngay co dinh) cho cac tab lien quan de
// khong phu thuoc "now" that (BASE_FILTERS dung 'days' tuong doi, khong hop
// de kiem tra tham so from/to truyen xuong repository mot cach xac dinh).

const CATEGORY_HEADERS = ['Mã nhóm hàng', 'Tên nhóm hàng', 'Mã nhóm cha'];
function categoryRow({ id, name, parentId = '' }) {
  return [id, name, parentId];
}

test('getDashboardData: tab Hoa don — doi bo loc invoices tinh lai giao dich (khong dung nham cache); payload chi mang bo loc invoices', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const CONFIG = require('../config');
  mockPgSheets(dashboardPgReader, {
    [CONFIG.SHEET_INVOICES]: [
      ['Mã hóa đơn', 'Ngày bán', 'Khách hàng', 'SĐT khách', 'Nhân viên bán', 'Chi nhánh', 'Tổng tiền hàng', 'Giảm giá', 'Khách đã trả', 'Trạng thái'],
      ['HD-AUG', '10/08/2026 10:00:00', 'Khách A', '', '', '', 50, 0, 50, 'Hoàn thành'],
      ['HD-JUL', '10/07/2026 10:00:00', 'Khách A', '', '', '', 60, 0, 60, 'Hoàn thành']
    ]
  });
  dashboardData.__test__.resetCaches();

  const views = { views: ['invoices'] };
  const aug = await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'range', from: '2026-08-01', to: '2026-08-31' } }, undefined, undefined, views);
  const jul = await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'range', from: '2026-07-01', to: '2026-07-31' } }, undefined, undefined, views);
  assert.deepEqual(aug.invoices.transactionsReport.transactions.map(t => t.code), ['HD-AUG']);
  assert.deepEqual(jul.invoices.transactionsReport.transactions.map(t => t.code), ['HD-JUL']);
  assert.deepEqual([aug.invoices.transactionsReport.summary.revenue, jul.invoices.transactionsReport.summary.revenue], [50, 60]);
  assert.deepEqual(Object.keys(jul.filters), ['invoices'], 'payload tab Hoa don chi con bo loc invoices (orders/returns da bo)');
});

test('getDashboardData: doanh thu theo ngay (Tong quan/Hoa don) doc tu getInvoiceRevenueByDay (rollup)', async () => {
  const { dashboardData, dashboardRollupRepository } = freshDashboardData();
  const calls = [];
  mockDashboardRollups(dashboardRollupRepository, {
    getInvoiceRevenueByDay: (args) => {
      calls.push(args);
      return [{ dateKey: '10/08/2026', revenue: 500000, invoiceCount: 3 }];
    }
  });
  dashboardData.__test__.resetCaches();

  const filters = {
    ...BASE_FILTERS,
    overview: { mode: 'range', from: '2026-08-01', to: '2026-08-31' },
    invoices: { mode: 'range', from: '2026-08-10', to: '2026-08-10' }
  };
  const data = await dashboardData.getDashboardData(filters);

  // Xu huong Tong quan dung chung bo loc `invoices` (khong dung filters.overview).
  assert.equal(calls.length, 2, 'goi rieng cho Tong quan va Hoa don');
  assert.deepEqual([calls[0].from, calls[0].to], ['2026-08-10', '2026-08-10']);
  assert.deepEqual([calls[1].from, calls[1].to], ['2026-08-10', '2026-08-10']);

  assert.equal(data.overview.periodRevenue, 500000);
  assert.equal(data.overview.periodInvoices, 3);
  const day = data.overview.revenueByDay.find(d => d.date === '10/08/2026');
  assert.equal(day.revenue, 500000);
  assert.equal(day.count, 3);

  // invoicesRange chi 1 ngay (10/08 - 10/08) -> dung 1 dong, khop dong rollup.
  assert.equal(data.invoices.periodRevenue, 500000);
  assert.equal(data.invoices.periodInvoices, 3);
});

test('getDashboardData: doanh thu thuc te (Tong quan/Hoa don) la doanh thu ban tru tra hang', async () => {
  const { dashboardData, dashboardRollupRepository } = freshDashboardData();
  mockDashboardRollups(dashboardRollupRepository, {
    getInvoiceRevenueByDay: () => [
      { dateKey: '10/08/2026', revenue: 380000, grossRevenue: 500000, returnAmount: 120000, returnCount: 2, invoiceCount: 3 },
      { dateKey: '11/08/2026', revenue: -30000, grossRevenue: 0, returnAmount: 30000, returnCount: 1, invoiceCount: 0 }
    ]
  });
  dashboardData.__test__.resetCaches();

  const data = await dashboardData.getDashboardData({
    ...BASE_FILTERS,
    invoices: { mode: 'range', from: '2026-08-10', to: '2026-08-12' }
  });

  assert.equal(data.overview.periodGrossRevenue, 500000);
  assert.equal('periodGrossRevenue' in data.invoices, false, 'tab Hoa don khong con tra periodGrossRevenue (FE khong dung)');
  [data.overview, data.invoices].forEach(period => {
    assert.equal(period.periodRevenue, 350000, 'doanh thu thuc te = 500000 ban - 150000 tra hang');
    assert.equal(period.periodReturnAmount, 150000);
    assert.equal(period.periodInvoices, 3, 'so hoa don hoan thanh khong bi tru');
    assert.deepEqual(period.revenueByDay.map(d => [d.date, d.revenue, d.returnAmount]), [
      ['10/08/2026', 380000, 120000],
      ['11/08/2026', -30000, 30000],
      ['12/08/2026', 0, 0]
    ]);
  });
});

test('getDashboardData: doanh thu theo ngay tach theo co so (cot chong HN/SG), 1 co so chi co khoa cua co so do', async () => {
  const { dashboardData, dashboardRollupRepository } = freshDashboardData();
  const { BRANCHES, BRANCH_BOTH } = require('../branch/branches');
  mockDashboardRollups(dashboardRollupRepository, {
    getInvoiceRevenueByDay: ({ branch }) => (branch === BRANCHES.HANOI
      ? [{ dateKey: '10/08/2026', revenue: 380, grossRevenue: 500, returnAmount: 120, returnCount: 1, invoiceCount: 3 }]
      : [{ dateKey: '10/08/2026', revenue: 200, grossRevenue: 200, returnAmount: 0, returnCount: 0, invoiceCount: 1 },
        { dateKey: '11/08/2026', revenue: 50, grossRevenue: 50, returnAmount: 0, returnCount: 0, invoiceCount: 1 }])
  });
  dashboardData.__test__.resetCaches();
  const filters = { ...BASE_FILTERS, invoices: { mode: 'range', from: '2026-08-10', to: '2026-08-12' } };

  const both = await dashboardData.getDashboardData(filters, BRANCH_BOTH);
  [both.overview, both.invoices].forEach(period => {
    assert.deepEqual(period.revenueByDay.map(d => [d.date, d.revenue, d.revenueHanoi, d.revenueSaigon]), [
      ['10/08/2026', 580, 380, 200],
      ['11/08/2026', 50, 0, 50],
      ['12/08/2026', 0, 0, 0]
    ]);
  });

  dashboardData.__test__.resetCaches();
  const hanoi = await dashboardData.getDashboardData(filters, BRANCHES.HANOI);
  assert.deepEqual(hanoi.overview.revenueByDay.map(d => [d.revenue, d.revenueHanoi, 'revenueSaigon' in d]), [
    [380, 380, false], [0, 0, false], [0, 0, false]
  ]);
});

test('getDashboardData: cot SL cua "Chi tiết giao dịch" doc tu getInvoiceQuantitiesByCode (rollup)', async () => {
  const { dashboardData, dashboardPgReader, dashboardRollupRepository } = freshDashboardData();
  const CONFIG = require('../config');
  mockPgSheets(dashboardPgReader, {
    [CONFIG.SHEET_INVOICES]: [
      INVOICE_HEADERS,
      invoiceRow({ code: 'HD-01', date: '10/08/2026 10:00:00', status: 'Hoàn thành' })
    ]
  });
  mockDashboardRollups(dashboardRollupRepository, {
    getInvoiceQuantitiesByCode: () => [{ code: 'HD-01', quantity: 7 }]
  });
  dashboardData.__test__.resetCaches();

  // Bao cao giao dich thuoc tab Hoa don nen theo bo loc "invoices", khong phai "overview".
  const filters = {
    ...BASE_FILTERS,
    overview: { mode: 'days', days: 1 },
    invoices: { mode: 'range', from: '2026-08-01', to: '2026-08-31' }
  };
  const data = await dashboardData.getDashboardData(filters);

  const row = data.invoices.transactionsReport.transactions.find(t => t.code === 'HD-01');
  assert.ok(row, 'hoa don HD-01 phai xuat hien trong bang chi tiet giao dich');
  assert.equal(row.quantity, 7);
  assert.equal(row.quantityKnown, true);
});

// ---------- Ca hai: bao cao doanh thu theo khach ----------

const AGG_PRODUCT_HEADER = ['Mã hàng', 'Tên hàng', 'Nhóm hàng', 'Loại hàng', 'Giá vốn', 'Giá bán', 'Tồn kho', 'Khách đặt', 'Trạng thái'];
const AGG_INVOICE_HEADER = ['Mã hóa đơn', 'Ngày bán', 'Khách hàng', 'SĐT khách', 'Chi nhánh', 'Tổng tiền hàng', 'Trạng thái', 'Mã khách hàng'];
const AGG_DETAIL_HEADER = ['Mã hóa đơn', 'Mã hàng', 'Tên hàng', 'Số lượng', 'Đơn giá', 'Giảm giá', 'Thành tiền'];

// readDashboardSheets (9 tab, cache "full") theo tung co so VAT LY:
// `byBranch` = { [branch]: { [sheetName]: rows } }. Ghi lai moi co so duoc doc.
function mockFullSheetsByBranch(dashboardPgReader, byBranch, seenBranches = []) {
  dashboardPgReader.readDashboardSheets = async branch => {
    seenBranches.push(branch);
    const result = {};
    dashboardPgReader.SHEET_NAMES.forEach(name => { result[name] = []; });
    return Object.assign(result, byBranch[branch] || {});
  };
}

function aggregateRevenueSheets(BRANCHES, CONFIG) {
  return {
    [BRANCHES.HANOI]: {
      [CONFIG.SHEET_PRODUCTS]: [AGG_PRODUCT_HEADER, ['SP-1', 'Áo Hà Nội', '', '', 10, 20, 2, 0, 'Đang kinh doanh']],
      [CONFIG.SHEET_INVOICES]: [AGG_INVOICE_HEADER,
        ['HD-1', '18/08/2026 10:00:00', 'Khách 1', '', '', 100, 'Hoàn thành', 'KH-1']],
      [CONFIG.SHEET_INVOICE_DETAILS]: [AGG_DETAIL_HEADER, ['HD-1', 'SP-1', 'Áo Hà Nội', 1, 100, 0, 100]]
    },
    [BRANCHES.SAIGON]: {
      [CONFIG.SHEET_PRODUCTS]: [AGG_PRODUCT_HEADER, ['SP-1', 'Áo Sài Gòn', '', '', 20, 25, 3, 0, 'Đang kinh doanh']],
      [CONFIG.SHEET_INVOICES]: [AGG_INVOICE_HEADER,
        ['HD-1', '18/08/2026 11:00:00', 'Khách 9', '', '', 999, 'Hoàn thành', 'KH-9'],
        ['HD-2', '19/08/2026 09:00:00', 'Khách 1', '', '', 350, 'Hoàn thành', 'KH-1']],
      [CONFIG.SHEET_INVOICE_DETAILS]: [AGG_DETAIL_HEADER,
        ['HD-1', 'SP-1', 'Áo Sài Gòn', 5, 200, 0, 999],
        ['HD-2', 'SP-1', 'Áo Sài Gòn', 2, 150, 0, 300],
        ['HD-2', 'SP-2', 'Hàng hai', 1, 50, 0, 50]]
    }
  };
}

test('Ca hai bao cao doanh thu theo khach cong theo ma hang va ngay, khong ghep hoa don trung ma giua co so', async () => {
  const { dashboardData, dashboardPgReader } = freshDashboardData();
  const CONFIG = require('../config');
  const { BRANCHES, BRANCH_BOTH } = require('../branch/branches');
  const seen = [];
  mockFullSheetsByBranch(dashboardPgReader, aggregateRevenueSheets(BRANCHES, CONFIG), seen);
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport(
    'KH-1', 'Khách 1', BRANCH_BOTH, new Date('2026-08-20T03:00:00.000Z')
  );

  assert.deepEqual(report.products.map(product => [product.code, product.name, product.quantity, product.revenue]), [
    ['SP-1', 'Áo Hà Nội', 3, 400], ['SP-2', 'Hàng hai', 1, 50]
  ]);
  assert.equal(report.totalRevenue, 450);
  assert.equal(report.totalQuantity, 4);
  assert.equal(report.products[0].month1Revenue, 400);
  const dayRevenue = date => report.totalRevenueByDay.find(day => day.date === date).revenue;
  assert.equal(dayRevenue('18/08/2026'), 100);
  assert.equal(dayRevenue('19/08/2026'), 350);
  assert.equal(report.products[0].revenueByDay.find(day => day.date === '19/08/2026').revenue, 300);
  assert.deepEqual(seen.sort(), [BRANCHES.HANOI, BRANCHES.SAIGON]);
});

// searchCustomerDirectory: goi y nhanh cho o tim kiem "Bao cao doanh thu theo
// khach" (tab Tong quan) — nguon rieng (customerDirectoryRepository), KHONG
// dung getCachedDashboardSheets (9-tab, cham khi cache nguoi).
test('searchCustomerDirectory: tim theo ma hoac ten, uu tien trung/tien to truoc chua cum tu', async () => {
  const { dashboardData, customerDirectoryRepository } = freshDashboardData();
  const calls = [];
  customerDirectoryRepository.readCustomerDirectory = async branch => {
    calls.push(branch);
    return [
      { branch: 'hanoi', code: 'KH01', name: 'Trần Thị Bình' },
      { branch: 'hanoi', code: 'KH02', name: 'Nguyễn Văn An' },
      { branch: 'hanoi', code: 'AN9', name: 'Khách lẻ' }
    ];
  };
  dashboardData.__test__.resetCaches();

  const result = await dashboardData.searchCustomerDirectory('Hà Nội', 'an', 8);

  assert.deepEqual(calls, ['Hà Nội']);
  // "AN9" trung tien to ma -> xep truoc "Nguyễn Văn An" (chua cum tu trong ten).
  // "Trần" chứa "an" khi bỏ dấu -> khớp gần đúng, xếp sau cùng.
  assert.deepEqual(result.results.map(r => r.code), ['AN9', 'KH02', 'KH01']);
});

test('searchCustomerDirectory: cache danh ba trong TTL, khong query lai Postgres moi lan go phim', async () => {
  const { dashboardData, customerDirectoryRepository } = freshDashboardData();
  let callCount = 0;
  customerDirectoryRepository.readCustomerDirectory = async () => {
    callCount += 1;
    return [{ branch: 'hanoi', code: 'KH01', name: 'Trần Thị Bình' }];
  };
  dashboardData.__test__.resetCaches();

  await dashboardData.searchCustomerDirectory('Hà Nội', 'binh', 8);
  await dashboardData.searchCustomerDirectory('Hà Nội', 'bình', 8);

  assert.equal(callCount, 1);
});

test('searchCustomerDirectory: su kien customersChanged het han cache, lan sau doc lai danh ba', async () => {
  const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
  const { dashboardData, customerDirectoryRepository } = freshDashboardData();
  let callCount = 0;
  customerDirectoryRepository.readCustomerDirectory = async () => {
    callCount += 1;
    return [{ branch: 'hanoi', code: 'KH01', name: 'Trần Thị Bình' }];
  };
  dashboardData.__test__.resetCaches();

  await dashboardData.searchCustomerDirectory('Hà Nội', 'binh', 8);
  await dashboardData.searchCustomerDirectory('Hà Nội', 'binh', 8);
  assert.equal(callCount, 1, 'trong TTL, chua co su kien -> doc 1 lan');

  dashboardRollupEvents.emit('customersChanged', { branch: 'hanoi' });
  await dashboardData.searchCustomerDirectory('Hà Nội', 'binh', 8);
  assert.equal(callCount, 2, 'sau customersChanged -> doc lai danh ba');
});

test('searchCustomerDirectory: chuoi rong tra ket qua rong, khong goi repository', async () => {
  const { dashboardData, customerDirectoryRepository } = freshDashboardData();
  customerDirectoryRepository.readCustomerDirectory = async () => assert.fail('không được query khi chưa gõ gì');
  dashboardData.__test__.resetCaches();

  const result = await dashboardData.searchCustomerDirectory('Hà Nội', '   ', 8);

  assert.deepEqual(result.results, []);
});

// ===== getDashboardData theo TUNG TAB (options.views) — xem dashboardViews.js =====
// Muc tieu: moi tab chi doc/tinh dung phan cua no (nhanh hon nhieu khi cache nguoi/
// doi bo loc) nhung ket qua PHAI y het lat cat tuong ung cua ban day du 5 tab.

const { VIEW_NAMES, VIEW_PAYLOAD } = require('./dashboardViews');

function vnToday() {
  return new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' }); // dd/mm/yyyy
}

// Du lieu co mat o MOI bang/rollup de tung tab co gi do de so sanh.
function installRichViewFixture(ctx) {
  const CONFIG = require('../config');
  const today = vnToday();
  const product = (code, name, stock, status, categoryId) => {
    const row = productRow({ code, name, cost: 1000, price: 2000, stock, status });
    row[2] = 'Đồ uống'; row[11] = categoryId;
    return row;
  };
  mockPgSheets(ctx.dashboardPgReader, {
    [CONFIG.SHEET_CATEGORIES]: [CATEGORY_HEADERS, categoryRow({ id: '1', name: 'Đồ uống' })],
    [CONFIG.SHEET_PRODUCTS]: [
      PRODUCT_HEADERS,
      product('SP-01', 'Sản phẩm một', 5, 'Đang kinh doanh', '1'),
      product('SP-02', 'Sản phẩm hai', 0, 'Đang kinh doanh', '1'),
      product('SP-03', 'Sản phẩm ba', 9, 'Ngừng kinh doanh', '1')
    ],
    [CONFIG.SHEET_INVOICES]: [
      INVOICE_HEADERS,
      invoiceRow({ code: 'HD-1', date: `${today} 09:00:00`, name: 'Khách A', phone: '0900000001', status: 'Hoàn thành', custCode: 'KH-A' }),
      invoiceRow({ code: 'HD-2', date: `${today} 10:00:00`, name: 'Khách B', phone: '0900000002', status: 'Đã hủy', custCode: 'KH-B' })
    ].map((row, index) => { if (index) { row[6] = 250000; row[8] = 250000; } return row; }),
    [CONFIG.SHEET_ORDERS]: [
      ['Mã đặt hàng', 'Ngày đặt', 'Khách hàng', 'Nhân viên lập', 'Chi nhánh', 'Tổng tiền', 'Trạng thái'],
      ['DH-1', `${today} 08:00:00`, 'Khách A', '', '', 300000, 'Phiếu tạm']
    ],
    [CONFIG.SHEET_RETURNS]: [
      ['Mã trả hàng', 'Ngày trả', 'Mã hóa đơn', 'Khách hàng', 'Tổng tiền trả', 'Trạng thái'],
      ['TH-1', `${today} 11:00:00`, 'HD-1', 'Khách A', 50000, 'Đã trả']
    ],
    [CONFIG.SHEET_CUSTOMERS]: [
      ['Mã khách hàng', 'Tên khách hàng', 'Điện thoại', 'a', 'b', 'c', 'd', 'Nợ hiện tại'],
      ['KH-A', 'Khách A', '0900000001', '', '', '', '', 120000],
      ['KH-B', 'Khách B', '0900000002', '', '', '', '', 0]
    ],
  });
  mockDashboardRollups(ctx.dashboardRollupRepository, {
    getInvoiceRevenueByDay: [{ dateKey: today, revenue: 250000, invoiceCount: 1 }],
    getProductSalesBreakdown: [
      { code: 'SP-01', name: 'Sản phẩm một', qty: 4, revenue: 400000 },
      { code: 'SP-02', name: 'Sản phẩm hai', qty: 1, revenue: 90000 }
    ],
    getFirstPurchaseDates: [{ code: 'SP-01', name: 'Sản phẩm một', firstPurchaseDateText: `${today} 07:00:00` }],
    getInvoiceQuantitiesByCode: [{ code: 'HD-1', quantity: 3 }]
  });
  ctx.debtRepo.report = {
    cycle: { cycleDate: '2026-10-13', takenAt: '2026-10-13T08:00:00.000Z' },
    rows: [{
      branch: 'hanoi', customerId: '1', customerCode: 'KH-A', customerName: 'Khách A', sale: 'Lan', scheduleDays: 7,
      currentDebt: 500000, openingDebt: 0, avgRevenue4m: null, feedback: {}
    }],
    amountsByCustomer: new Map([['hanoi:1', [{ day: '2026-10-12', invoiceAmount: 300000, returnAmount: 0 }]]])
  };
}

function expectedViewSlice(full, view) {
  const spec = VIEW_PAYLOAD[view];
  const out = { filters: {}, kpi: {} };
  spec.filters.forEach(key => { out.filters[key] = full.filters[key]; });
  spec.kpi.forEach(key => { out.kpi[key] = full.kpi[key]; });
  spec.top.forEach(key => { out[key] = full[key]; });
  Object.keys(spec.nested).forEach(parent => {
    out[parent] = {};
    spec.nested[parent].forEach(child => { out[parent][child] = full[parent][child]; });
  });
  return out;
}

const VIEW_TEST_VIEWER = { permissions: ['reports.debt.edit'] };

test('tung tab: payload y het lat cat tuong ung cua ban day du 5 tab (mot co so va "Ca hai")', async () => {
  const { BRANCH_BOTH } = require('../branch/branches');
  for (const branch of [undefined, 'Sài Gòn', BRANCH_BOTH]) {
    const ctx = freshDashboardData();
    installRichViewFixture(ctx);
    ctx.dashboardData.__test__.resetCaches();
    const full = await ctx.dashboardData.getDashboardData(BASE_FILTERS, branch, VIEW_TEST_VIEWER);
    for (const view of VIEW_NAMES) {
      const part = await ctx.dashboardData.getDashboardData(BASE_FILTERS, branch, VIEW_TEST_VIEWER, { views: [view] });
      const { updatedAt, ...comparable } = part;
      assert.deepEqual(
        JSON.parse(JSON.stringify(comparable)),
        JSON.parse(JSON.stringify(expectedViewSlice(full, view))),
        `tab ${view} (co so ${branch || 'mac dinh'}) phai khop lat cat cua ban day du`
      );
    }
  }
});

test('tung tab: tra du lieu that (khong phai lat cat rong) — Tong quan/Hoa don/Cong no co so lieu dung', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  ctx.dashboardData.__test__.resetCaches();
  const overview = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  ['revenueToday', 'invoicesToday', 'cancelledToday', 'activeProducts', 'inventoryValueCategoryCount'].forEach(key => {
    assert.equal(key in overview.kpi, false, `kpi.${key} da go (FE khong dung)`);
  });
  assert.equal('overview' in overview.filters, false, 'bo loc ov* da bo');
  assert.deepEqual(overview.kpi, {}, 'chi so KPI hang hoa/khach hang da go (tab Hang hoa va Khach hang cu)');
  assert.ok(overview.overview, 'Tong quan van co xu huong doanh thu');
  assert.equal(overview.products, undefined, 'Tong quan khong con phan doanh thu theo nhom hang');
  assert.equal(overview.invoices, undefined, 'Tong quan khong keo du lieu Hoa don');
  assert.equal(overview.allProducts, undefined, 'Tong quan khong keo bang san pham (1,3MB)');
  assert.equal(overview.debtManagement, undefined);

  const invoices = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  assert.equal('returnsCount' in invoices.invoices, false, 'the chi so Tra hang da go');
  assert.equal('periodOrders' in invoices.invoices, false, 'bang Dat hang / Tra hang da bo');
  assert.equal(invoices.invoices.transactionsReport.transactions.find(item => item.code === 'HD-1').quantity, 3);
  assert.equal(invoices.invoices.periodCancelledInvoices, 1);
  assert.equal(invoices.products, undefined);

  const debt = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['debt'] });
  assert.equal(debt.debtManagement.customers.length, 1);
  assert.deepEqual(debt.kpi, {});
});

test('tung tab: Tong quan chi doc bang Hoa don + 1 rollup, KHONG cham cong no / Dat hang', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  const CONFIG = require('../config');
  const coreReads = [];
  const orig = ctx.dashboardPgReader.readCoreDashboardSheets;
  ctx.dashboardPgReader.readCoreDashboardSheets = async (branch, names) => { coreReads.push(names); return orig(branch, names); };
  const rollupCalls = [];
  ['getInvoiceRevenueByDay', 'getInvoiceQuantitiesByCode']
    .forEach(name => {
      const original = ctx.dashboardRollupRepository[name];
      ctx.dashboardRollupRepository[name] = async (...args) => { rollupCalls.push(name); return original(...args); };
    });
  let debtTouched = 0;
  ctx.debtRepo.readReport = async () => { debtTouched += 1; return { cycle: null, rows: [], amountsByCustomer: new Map() }; };
  ctx.customerDebtActivityRepository.readOperationalPeriods = async () => { debtTouched += 1; return { HN1: [], HN3: [], HN7: [] }; };
  ctx.dashboardData.__test__.resetCaches();

  await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });

  assert.equal(coreReads.length, 1, 'gop thanh 1 lan doc Postgres');
  assert.deepEqual([...coreReads[0]], [CONFIG.SHEET_INVOICES]);
  assert.deepEqual(rollupCalls.sort(), ['getInvoiceRevenueByDay']);
  assert.equal(debtTouched, 0, 'Tong quan khong doc cong no/CN1-3-7');
});

test('tung tab: Cong no khong doc bang nguon nao, khong goi rollup, khong doc CN1/3/7 — chi doc ban chot cong no', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  let coreReads = 0;
  ctx.dashboardPgReader.readCoreDashboardSheets = async () => { coreReads += 1; return {}; };
  let rollupCalls = 0;
  ['getInvoiceRevenueByDay', 'getProductSalesBreakdown', 'getFirstPurchaseDates', 'getInvoiceQuantitiesByCode']
    .forEach(name => { ctx.dashboardRollupRepository[name] = async () => { rollupCalls += 1; return []; }; });
  let periods = 0;
  ctx.customerDebtActivityRepository.readOperationalPeriods = async () => { periods += 1; return { HN1: [['Khách hàng']], HN3: [['Khách hàng']], HN7: [['Khách hàng']] }; };
  ctx.dashboardData.__test__.resetCaches();

  const data = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['debt'] });

  assert.equal(coreReads, 0);
  assert.equal(rollupCalls, 0);
  assert.equal(periods, 0, 'quy tac 1-3-7 da bo, khong doc CN1/3/7');
  assert.deepEqual(ctx.debtRepo.readReportCalls, [['hanoi']]);
  assert.equal(data.debtManagement.available, true);
  const [customer] = data.debtManagement.customers;
  assert.equal(customer.inScheduleDebt, 300000);
  assert.equal(customer.overdueDebt, 200000);
  assert.deepEqual(customer.alertCodes, ['overdue']);
  assert.equal(customer.branch, 'HN');
});

test('Cong no: phien ban repository nam trong khoa cache — ghi phan hoi/lich TT thi lan doc sau tinh lai', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  ctx.dashboardData.__test__.resetCaches();
  const first = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['debt'] });
  await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['debt'] });
  assert.equal(ctx.debtRepo.readReportCalls.length, 1, 'cung phien ban -> dung cache ket qua');
  ctx.debtRepo.report = { ...ctx.debtRepo.report, rows: [{ ...ctx.debtRepo.report.rows[0], scheduleDays: 1 }] };
  ctx.debtRepo.version += 1;
  const second = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['debt'] });
  assert.equal(ctx.debtRepo.readReportCalls.length, 2);
  assert.equal(first.debtManagement.customers[0].overdueDebt, 200000);
  assert.equal(second.debtManagement.customers[0].overdueDebt, 500000, 'lich 1 ngay: don 12/10 da qua han');
});

test('Cong no: quyen sua tung cot theo nguoi xem va khoa cache tach theo quyen', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  ctx.dashboardData.__test__.resetCaches();
  const sale = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, { permissions: ['reports.debt', 'reports.debt.saleFeedback'] }, { views: ['debt'] });
  const manager = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, { permissions: ['reports.debt', 'reports.debt.managerFeedback', 'reports.debt.edit', 'reports.debt.schedule', 'reports.debt.refresh'] }, { views: ['debt'] });
  assert.deepEqual(sale.debtManagement.access, { status: false, saleFeedback: true, managerFeedback: false, schedule: false, refresh: false });
  assert.deepEqual(manager.debtManagement.access, { status: true, saleFeedback: false, managerFeedback: true, schedule: true, refresh: true });
  assert.equal(sale.debtManagement.customers[0].canEditSaleFeedback, true);
  assert.equal(manager.debtManagement.customers[0].canEditSaleFeedback, false);
});

test('Cong no "Ca hai": doc ca 2 co so, moi dong giu co so rieng (HN/SG)', async () => {
  const ctx = freshDashboardData();
  const { BRANCH_BOTH } = require('../branch/branches');
  installRichViewFixture(ctx);
  ctx.debtRepo.report.rows.push({ ...ctx.debtRepo.report.rows[0], branch: 'saigon', scheduleDays: null });
  ctx.dashboardData.__test__.resetCaches();
  const data = await ctx.dashboardData.getDashboardData(BASE_FILTERS, BRANCH_BOTH, VIEW_TEST_VIEWER, { views: ['debt'] });
  assert.deepEqual(ctx.debtRepo.readReportCalls, [['hanoi', 'saigon']]);
  assert.deepEqual(data.debtManagement.customers.map(item => [item.branch, item.paymentSchedule, item.overdueDebt]), [
    ['HN', '7', 200000],
    ['SG', '1', 500000]
  ]);
});

test('tung tab: cache tach rieng — doi bo loc cua tab khac KHONG lam mat cache, doi bo loc cua chinh no thi tinh lai', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  ctx.dashboardData.__test__.resetCaches();
  const { dashboardData } = ctx;
  const compute = () => dashboardData.__test__.getComputeCallCount();

  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  assert.equal(compute(), 1);

  await dashboardData.getDashboardData({ ...BASE_FILTERS, products: { mode: 'days', days: 7 }, customers: { mode: 'days', days: 3 } },
    undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  assert.equal(compute(), 1, 'doi bo loc Hang hoa/Khach hang khong anh huong tab Hoa don -> lay tu cache');

  await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'days', days: 7 } },
    undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  assert.equal(compute(), 2, 'doi bo loc Hoa don -> tinh lai');

  // Tab khac co cache rieng: tinh xong tab Tong quan khong don mat entry cua tab Hoa don.
  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  assert.equal(compute(), 3);
  await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'days', days: 7 } },
    undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  assert.equal(compute(), 3, 'entry Hoa don van con sau khi tab Tong quan tinh xong');

  // Ban day du (khong views) la mot entry khac, khong dung chung voi tab don le.
  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER);
  assert.equal(compute(), 4);
});

test('tung tab: tab khong dung rollup/cong no khong bi het hieu luc khi rollup doi', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  ctx.dashboardData.__test__.resetCaches();
  const { dashboardData } = ctx;
  const compute = () => dashboardData.__test__.getComputeCallCount();

  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['debt'] });
  assert.equal(compute(), 1);

  const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
  dashboardRollupEvents.emit('updated', { at: Date.now() });

  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['debt'] });
  await new Promise(resolve => setImmediate(resolve));
  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['debt'] });
  // Rollup chay theo timer, khong co hoa don moi -> Cong no (khong dung rollup) giu nguyen cache.
  assert.equal(compute(), 1, 'Cong no khong dung rollup nen rollup doi khong lam tinh lai');

  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  assert.equal(compute(), 2);
  dashboardRollupEvents.emit('updated', { at: Date.now() });
  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  assert.equal(compute(), 3, 'Tong quan dung rollup nen phai tinh lai khi rollup doi');
});

test('cache nguon theo tung bang: mo them tab chi doc bang con thieu, bang con han duoc dung lai', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  const CONFIG = require('../config');
  const reads = [];
  const orig = ctx.dashboardPgReader.readCoreDashboardSheets;
  ctx.dashboardPgReader.readCoreDashboardSheets = async (branch, names) => { reads.push(names); return orig(branch, names); };
  ctx.dashboardData.__test__.resetCaches();
  const { dashboardData } = ctx;

  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });

  assert.equal(reads.length, 1,
    'tab Hoa don chi can bang Hoa don, da co san tu tab Tong quan (khong doc Dat hang/Tra hang)');

});

test('cache nguon theo tung bang: het han mem chi lam moi nen dung bang qua han, van tra du lieu cu ngay', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  const CONFIG = require('../config');
  const reads = [];
  const orig = ctx.dashboardPgReader.readCoreDashboardSheets;
  ctx.dashboardPgReader.readCoreDashboardSheets = async (branch, names) => { reads.push(names); return orig(branch, names); };
  ctx.dashboardData.__test__.resetCaches();
  const { dashboardData } = ctx;

  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  assert.equal(reads.length, 1);

  dashboardData.__test__.expireCoreSources(undefined, [CONFIG.SHEET_INVOICES], true);
  await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'days', days: 7 } },
    undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(reads.length, 2, 'lam moi nen dung 1 lan');
  assert.deepEqual(reads[1], [CONFIG.SHEET_INVOICES], 'chi lam moi bang Hoa don');
});

test('cache nguon theo tung bang: loi doc bang nguon tab dang mo duoc nem ra, lan sau tu thu lai', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  let fail = true;
  const orig = ctx.dashboardPgReader.readCoreDashboardSheets;
  ctx.dashboardPgReader.readCoreDashboardSheets = async (branch, names) => {
    if (fail) throw new Error('Gia lap mat ket noi Postgres');
    return orig(branch, names);
  };
  ctx.dashboardData.__test__.resetCaches();

  await assert.rejects(
    ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['invoices'] }),
    /mat ket noi Postgres/
  );
  fail = false;
  const data = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  assert.ok(data.invoices, 'lan sau doc lai thanh cong sau khi loi');
});

test('tham so views khong hop le bi tu choi 400, khong doc nguon nao', async () => {
  const ctx = freshDashboardData();
  let reads = 0;
  ctx.dashboardPgReader.readCoreDashboardSheets = async () => { reads += 1; return {}; };
  ctx.dashboardData.__test__.resetCaches();

  await assert.rejects(
    ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview', 'khong-co'] }),
    error => error.code === 'INVALID_VIEW' && error.statusCode === 400
  );
  assert.equal(reads, 0);
});

test('getDashboardDateParts ban nhanh (UTC+7 co dinh) cho ket qua y het Intl tren hang tram nghin moc, ke ca ranh gioi ngay/nam', () => {
  const { dashboardData } = freshDashboardData();
  const { dateParts, datePartsIntl } = dashboardData.__test__;
  const same = time => {
    const date = new Date(time);
    const fast = dateParts(date);
    const intl = datePartsIntl(date);
    return JSON.stringify(fast) === JSON.stringify({
      day: intl.day, month: intl.month, year: intl.year, hour: intl.hour, minute: intl.minute, second: intl.second
    }) && Object.keys(intl).sort().join(',') === 'day,hour,minute,month,second,year';
  };
  const low = Date.UTC(1976, 0, 1);
  const high = Date.UTC(2100, 0, 1);
  let seed = 12345; // LCG co dinh de test xac dinh (khong Math.random)
  const next = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < 50000; i++) assert.ok(same(low + Math.floor(next() * (high - low))), `lech tai mau ngau nhien ${i}`);
  // Ranh gioi ngay VN (17:00 UTC) +/- vai giay, nam nhuan, cuoi nam, 2 moc bien cua duong nhanh.
  for (let year = 1976; year <= 2099; year++) {
    for (const [month, day] of [[0, 1], [1, 28], [1, 29], [11, 31]]) {
      const base = Date.UTC(year, month, day, 17, 0, 0);
      [-2000, -1, 0, 1, 2000].forEach(offset => assert.ok(same(base + offset), `lech tai ${new Date(base + offset).toISOString()}`));
    }
  }
  [-1000, 0, 1000].forEach(offset => { assert.ok(same(low + offset)); assert.ok(same(high + offset)); });
  // Ngoai khoang an toan va ngay khong hop le giu nguyen hanh vi cu (Intl).
  assert.deepEqual(dateParts(new Date(Date.UTC(1960, 5, 1))), datePartsIntl(new Date(Date.UTC(1960, 5, 1))));
  assert.throws(() => dateParts(new Date(NaN)), RangeError);
});

// ===== Cache nguon nguoi: rollup chay SONG SONG voi viec doc bang nguon =====
// (truoc day doc bang nguon xong moi chay rollup -> cold = cong hai buoc; gio = max).

test('cache nguon nguoi: rollup bat dau NGAY trong luc dang doi doc bang nguon (khong doi doc xong)', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  let releaseSources;
  const gate = new Promise(resolve => { releaseSources = resolve; });
  const origRead = ctx.dashboardPgReader.readCoreDashboardSheets;
  ctx.dashboardPgReader.readCoreDashboardSheets = async (branch, names) => { await gate; return origRead(branch, names); };
  const rollupCalls = [];
  ['getInvoiceRevenueByDay'].forEach(name => {
    const original = ctx.dashboardRollupRepository[name];
    ctx.dashboardRollupRepository[name] = async (...args) => { rollupCalls.push(name); return original(...args); };
  });
  ctx.dashboardData.__test__.resetCaches();

  const pending = ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(rollupCalls.sort(), ['getInvoiceRevenueByDay'],
    'rollup da chay trong luc bang nguon con dang cho (gate chua mo)');

  releaseSources();
  const data = await pending;
  assert.ok(data.overview);
  assert.deepEqual(rollupCalls.sort(), ['getInvoiceRevenueByDay'], 'khong goi rollup lan 2');
});

test('cache nguon con han: rollup KHONG chay som — ket qua da tinh trung cache thi khong goi rollup nao', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  ctx.dashboardData.__test__.resetCaches();
  await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });

  let rollupCalls = 0;
  ['getInvoiceRevenueByDay'].forEach(name => {
    ctx.dashboardRollupRepository[name] = async () => { rollupCalls += 1; return []; };
  });
  await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  assert.equal(rollupCalls, 0);
});

test('nhieu request nguoi trung nhau cung luc chi chay rollup 1 luot (dung chung luot dang bay)', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  let calls = 0;
  ['getInvoiceRevenueByDay'].forEach(name => {
    const original = ctx.dashboardRollupRepository[name];
    ctx.dashboardRollupRepository[name] = async (...args) => { calls += 1; return original(...args); };
  });
  ctx.dashboardData.__test__.resetCaches();

  await Promise.all([1, 2, 3].map(() =>
    ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] })));

  assert.equal(calls, 1, 'Tong quan = 1 truy van rollup (doanh thu theo ngay), khong nhan 3');
});

test('rollup doi phien ban trong luc dang doc nguon: ket qua luu duoi khoa cu, lan sau cung bo loc phai tinh lai', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  let releaseSources;
  const gate = new Promise(resolve => { releaseSources = resolve; });
  const origRead = ctx.dashboardPgReader.readCoreDashboardSheets;
  ctx.dashboardPgReader.readCoreDashboardSheets = async (branch, names) => { await gate; return origRead(branch, names); };
  ctx.dashboardData.__test__.resetCaches();
  const { dashboardData } = ctx;

  const pending = dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  await new Promise(resolve => setImmediate(resolve));
  const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
  dashboardRollupEvents.emit('updated', { at: Date.now() }); // rollup moi xong trong luc dang cho
  releaseSources();
  await pending;
  assert.equal(dashboardData.__test__.getComputeCallCount(), 1);

  ctx.dashboardPgReader.readCoreDashboardSheets = origRead;
  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  assert.equal(dashboardData.__test__.getComputeCallCount(), 2,
    'du lieu rollup chay truoc su kien khong duoc coi la moi nhat — phai tinh lai voi rollup moi');
});

test('rollup chay som that bai: loi duoc nem ra dung 1 lan (khong "unhandled rejection"), lan sau tu thu lai', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  let fail = true;
  const original = ctx.dashboardRollupRepository.getInvoiceRevenueByDay;
  ctx.dashboardRollupRepository.getInvoiceRevenueByDay = async (...args) => {
    if (fail) throw new Error('Gia lap rollup loi');
    return original(...args);
  };
  ctx.dashboardData.__test__.resetCaches();

  await assert.rejects(
    ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] }),
    /rollup loi/
  );
  fail = false;
  const data = await ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] });
  assert.ok(data.overview);
});

test('bang nguon loi + rollup loi cung luc: tra loi cua bang nguon, khong de lai unhandled rejection', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  ctx.dashboardPgReader.readCoreDashboardSheets = async () => { throw new Error('Gia lap mat ket noi bang nguon'); };
  ctx.dashboardRollupRepository.getInvoiceRevenueByDay = async () => { throw new Error('Gia lap rollup loi'); };
  ctx.dashboardData.__test__.resetCaches();

  await assert.rejects(
    ctx.dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['overview'] }),
    /bang nguon/
  );
  await new Promise(resolve => setImmediate(resolve)); // de node:test bat unhandled rejection neu co
});

test('searchCustomerDirectory o "Cả hai": khach cung ten (ma khac nhau giua hai co so) chi hien 1 lan, Ha Noi truoc', async () => {
  const { dashboardData, customerDirectoryRepository } = freshDashboardData();
  const { BRANCH_BOTH } = require('../branch/branches');
  customerDirectoryRepository.readCustomerDirectory = async () => [
    { branch: 'hanoi', code: 'KH-1', name: 'Khách An' },
    { branch: 'saigon', code: 'KH-9', name: 'khách  an' },
    { branch: 'saigon', code: 'KH-3', name: 'Khách Bình' }
  ];
  dashboardData.__test__.resetCaches();

  const result = await dashboardData.searchCustomerDirectory(BRANCH_BOTH, 'khách', 8);

  assert.deepEqual(result.results, [
    { code: 'KH-1', name: 'Khách An' },
    { code: 'KH-3', name: 'Khách Bình' }
  ]);
});

test('bao cao doanh thu theo khach o "Cả hai": moi co so tra theo MA KHACH RIENG cua cung khach (tra theo ten danh ba)', async () => {
  const { dashboardData, customerDirectoryRepository, customerInvoiceLinesRepository } = freshDashboardData();
  const { BRANCH_BOTH } = require('../branch/branches');
  customerDirectoryRepository.readCustomerDirectory = async () => [
    { branch: 'hanoi', code: 'KH-1', name: 'Khách An' },
    { branch: 'saigon', code: 'KH-9', name: 'Khách An' },
    { branch: 'saigon', code: 'KH-3', name: 'Khách khác' }
  ];
  const calls = stubInvoiceLines(customerInvoiceLinesRepository, {
    window: { start: '2026-05-22', end: '2026-08-19' },
    computedAt: new Date('2026-08-19T17:10:00Z'),
    linesByBranch: {
      hanoi: [invoiceLine({ dateKey: '18/08/2026', itemCode: 'SP-1', itemName: 'Áo', quantity: 1, revenue: 100 })],
      saigon: [invoiceLine({ dateKey: '19/08/2026', itemCode: 'SP-1', itemName: 'Áo', quantity: 2, revenue: 300 })]
    }
  });
  dashboardData.__test__.resetCaches();

  const report = await dashboardData.getCustomerProductRevenueReport('KH-1', 'Khách An', BRANCH_BOTH, new Date('2026-08-20T03:00:00.000Z'));

  assert.deepEqual(calls, [{
    branchCodes: ['hanoi', 'saigon'],
    customerCode: 'KH-1',
    customerCodesByBranch: { hanoi: 'KH-1', saigon: 'KH-9' }
  }]);
  assert.equal(report.totalRevenue, 400, 'doanh thu hai co so cong lai cho cung mot khach');
});

test('cache Hoa don chi het han khi sync ghi hoa don roi rollup xong, khong theo TTL 90s/timer rollup (giam egress)', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  const CONFIG = require('../config');
  const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
  const reads = [];
  const orig = ctx.dashboardPgReader.readCoreDashboardSheets;
  ctx.dashboardPgReader.readCoreDashboardSheets = async (branch, names) => { reads.push([...names]); return orig(branch, names); };
  ctx.dashboardData.__test__.resetCaches();
  const { dashboardData } = ctx;

  await dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  assert.deepEqual(reads, [[CONFIG.SHEET_INVOICES]]);

  const realNow = Date.now;
  Date.now = () => realNow() + 5 * 60 * 1000; // qua 90s cu nhung chua co rollup moi
  try {
    await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'days', days: 7 } },
      undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 1, 'Hoa don con han toi khi co su kien rollup');

    dashboardRollupEvents.emit('updated', { at: Date.now() });
    await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'days', days: 14 } },
      undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 1, 'rollup theo timer khong co hoa don moi -> khong doc lai Hoa don');

    dashboardRollupEvents.emit('invoicesChanged', { branch: 'hanoi', count: 1 });
    await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'days', days: 21 } },
      undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 1, 'chi co hoa don moi, chua co rollup -> chua doc lai');

    dashboardRollupEvents.emit('updated', { at: Date.now() });
    await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'days', days: 30 } },
      undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(reads.length, 2, 'sync ghi hoa don + rollup moi -> lam moi nen bang Hoa don');
    assert.deepEqual(reads[1], [CONFIG.SHEET_INVOICES]);
  } finally {
    Date.now = realNow;
  }
});

test('cache Hoa don: lan doc dang chay khi bi het han duoc luu o trang thai qua han (khong giu 15 phut du lieu cu)', async () => {
  const ctx = freshDashboardData();
  installRichViewFixture(ctx);
  const CONFIG = require('../config');
  const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
  const reads = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const orig = ctx.dashboardPgReader.readCoreDashboardSheets;
  ctx.dashboardPgReader.readCoreDashboardSheets = async (branch, names) => {
    reads.push([...names]);
    if (reads.length === 1) await gate; // lan doc dau con dang chay khi sync ghi hoa don
    return orig(branch, names);
  };
  ctx.dashboardData.__test__.resetCaches();
  const { dashboardData } = ctx;

  const first = dashboardData.getDashboardData(BASE_FILTERS, undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  await new Promise(resolve => setImmediate(resolve));
  dashboardRollupEvents.emit('invoicesChanged', { branch: 'hanoi', count: 1 });
  dashboardRollupEvents.emit('updated', { at: Date.now() });
  release();
  await first;
  assert.equal(reads.length, 1);

  await dashboardData.getDashboardData({ ...BASE_FILTERS, invoices: { mode: 'days', days: 7 } },
    undefined, VIEW_TEST_VIEWER, { views: ['invoices'] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads.length, 2, 'ket qua doc truoc khi het han phai duoc lam moi o request ke tiep');
  assert.deepEqual(reads[1], [CONFIG.SHEET_INVOICES]);
});
