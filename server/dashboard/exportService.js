'use strict';

// ==========================================
// XUAT EXCEL — doc THANG Postgres theo catalogue truong
//
// Luong du lieu:
//   1. Moi bang co MOT dinh nghia (TABLE_SPECS): worksheets (key/ten/cot/cot ma)
//      + ham nap dong. Buoc "lay danh sach truong" (getExportFields) va buoc tao
//      file (createExportWorkbook) cung doc dinh nghia nay nen cot luon khop.
//   2. Cac dong LOGIC (danh sach ma da loc/xep hang) lay tu
//      dashboardData.getDashboardData() (cache ket qua, chi nap 7 tab core).
//   3. Cot tho lay bang dashboardPgReader.readRowsByCodes() chi cho cac ma do,
//      roi ghep theo ma; nhan/kieu/mo ta cot theo exportFieldCatalog.js.
//   4. Buoc lay truong voi bang co dinh KHONG cham DB/Google (rowCount = null).
//   5. Gioi han tai: toi da 2 file dong thoi + hang doi 8; tran -> 503 EXPORT_BUSY.
//   6. getExportDataset() la tang lay/tong hop DUNG CHUNG; chi buoc render khac nhau:
//      renderExcelWorkbook (ExcelJS) va exportHtmlReport.renderHtmlReport (HTML tu chua).
//      runExport() boc ca hai trong cung slot/hang doi va AbortSignal.
// ==========================================

const ExcelJS = require('exceljs');
const dashboardData = require('./dashboardData');
const dashboardPgReader = require('./dashboardPgReader');
const productReportRepository = require('./productReportRepository');
const exportFieldCatalog = require('./exportFieldCatalog');
const { BRANCHES, BRANCH_BOTH, resolveBranchScope } = require('../branch/branches');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');
const { filterTableItems } = require('../public/js/table-explorer');
const htmlReportRenderer = require('./exportHtmlReport');

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEBT_QUEUE_FILTERS = new Set(['needsAction', 'currentDebt', 'overdue', 'all']);
const DEBT_SORT_FIELDS = [
  'customerName', 'sale', 'paymentSchedule', 'openingDebt', 'currentDebt',
  'overdueDebt', 'currentDebtToSalesRatio', 'overdueToSalesRatio', 'automaticAlert', 'workflowStatus'
];

// Gioi han tai: moi file Excel nap du lieu + ghi workbook trong RAM.
const EXPORT_MAX_CONCURRENT = 2;
const EXPORT_MAX_QUEUED = 8;
const EXPORT_BUSY_MESSAGE = 'Hệ thống đang xử lý nhiều yêu cầu xuất file, vui lòng thử lại sau ít giây.';

const TABLE_TITLES = Object.freeze({
  'overview.transactions': 'Chi tiết giao dịch',
  'overview.purchases': 'Danh sách nhập hàng',
  'overview.new-products': 'Danh sách mã mới',
  'products.top-selling': 'Sản phẩm bán chạy',
  'products.low-stock': 'Hàng đã hết',
  'products.all': 'Tất cả mã hàng',
  'products.newly-imported': 'Hàng mới nhập',
  'products.child-categories': 'Chi tiết nhóm con',
  'invoices.orders': 'Danh sách đặt hàng',
  'invoices.returns': 'Danh sách trả hàng',
  'customers.revenue': 'Doanh thu theo khách',
  'customers.debt': 'Chi tiết khách nợ',
  'customers.productDetail': 'Bảng chi tiết sản phẩm theo khách',
  'overview.productReport': 'Báo cáo hàng hóa',
  'suppliers.list': 'Danh sách nhà cung cấp',
  'debt.management': 'Quản lý công nợ',
  'search.results': 'Kết quả tìm kiếm',
  'stockout.recentScan': 'Hàng đứt gần đây',
  'stockout.check90d': 'Kiểm tra đứt hàng 90 ngày',
  'stockout.check30d': 'Kiểm tra đứt hàng 30 ngày'
});

function exportError(message, statusCode = 400, code = 'EXPORT_INVALID_REQUEST') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function exportAbortedError() {
  return exportError('Yêu cầu xuất file đã bị hủy.', 499, 'EXPORT_ABORTED');
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw exportAbortedError();
}

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function normalizeCode(value) {
  return normalizeText(value).normalize('NFC').toLocaleLowerCase('vi-VN');
}

function plainObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function normalizeFilterSpec(spec, fallbackMode = 'days') {
  const raw = spec && typeof spec === 'object' ? spec : {};
  const mode = ['days', 'range', 'all'].includes(raw.mode) ? raw.mode : fallbackMode;
  if (mode === 'all') return { mode: 'all' };
  if (mode === 'range') {
    return {
      mode: 'range',
      from: normalizeText(raw.from).slice(0, 10),
      to: normalizeText(raw.to).slice(0, 10)
    };
  }
  return { mode: 'days', days: Math.min(Math.max(Number(raw.days) || 30, 1), 3660) };
}

function normalizeFilters(rawFilters) {
  const raw = rawFilters && typeof rawFilters === 'object' ? rawFilters : {};
  const overview = normalizeFilterSpec(raw.overview);
  const products = normalizeFilterSpec(raw.products);
  const invoices = normalizeFilterSpec(raw.invoices);
  const customers = normalizeFilterSpec(raw.customers, 'all');
  const productStatus = ['Đang kinh doanh', 'Ngừng kinh doanh'].includes(raw.products && raw.products.status)
    ? raw.products.status
    : 'all';
  return {
    overview,
    products: { ...products, status: productStatus },
    invoices,
    customers,
    newPurchases: normalizeFilterSpec(raw.newPurchases || overview),
    // Hang moi nhap (tab Hang hoa phan 5) co bo loc rieng; client cu chua gui thi dung bo loc products nhu truoc.
    newlyImported: normalizeFilterSpec(raw.newlyImported || raw.products),
    newProducts: normalizeFilterSpec(raw.newProducts || overview)
  };
}

function inferColumnType(label) {
  const text = normalizeText(label);
  if (/(^|\s)(mã|id|sđt|điện thoại|cccd|cmnd|psid|serial|imei)(\s|$)|mã số thuế/iu.test(text)) return 'text';
  if (/ngày|thời gian|ngày sinh/iu.test(text)) return 'date';
  // Cot % tu KiotViet/Sheets thuong luu gia tri 10 de bieu dien 10%, khong
  // phai phan so 0.1. Giu dang number de Excel khong hien nham thanh 1000%.
  if (/%|tỷ lệ/iu.test(text)) return 'number';
  if (/giá|tiền|doanh thu|công nợ|\bnợ\b|tổng|số lượng|\bsl\b|tồn|khách đặt|giảm giá|thuế|phí|điểm|trọng lượng|đơn giá|thành tiền|giá trị|dư nợ|số ngày|số đơn|số mã/iu.test(text)) return 'number';
  return 'general';
}

// ---------- Gioi han tai (semaphore) ----------

let activeExportCount = 0;
const exportWaitQueue = [];

function makeExportRelease() {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    activeExportCount -= 1;
    dispatchExportQueue();
  };
}

function dispatchExportQueue() {
  while (activeExportCount < EXPORT_MAX_CONCURRENT && exportWaitQueue.length > 0) {
    const waiter = exportWaitQueue.shift();
    if (waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort);
    // Da huy trong luc cho (onAbort chua kip chay) -> bo qua muc nay, nhuong cho muc sau.
    if (waiter.signal && waiter.signal.aborted) {
      waiter.reject(exportAbortedError());
      continue;
    }
    activeExportCount += 1;
    waiter.resolve(makeExportRelease());
  }
}

/** Xin 1 slot xuat file; resolve ra ham release() (an toan goi nhieu lan). */
function acquireExportSlot(signal) {
  if (signal && signal.aborted) return Promise.reject(exportAbortedError());
  if (activeExportCount < EXPORT_MAX_CONCURRENT) {
    activeExportCount += 1;
    return Promise.resolve(makeExportRelease());
  }
  if (exportWaitQueue.length >= EXPORT_MAX_QUEUED) {
    return Promise.reject(exportError(EXPORT_BUSY_MESSAGE, 503, 'EXPORT_BUSY'));
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    if (signal) {
      waiter.onAbort = () => {
        const index = exportWaitQueue.indexOf(waiter);
        if (index < 0) return;
        exportWaitQueue.splice(index, 1);
        reject(exportAbortedError());
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    exportWaitQueue.push(waiter);
  });
}

// ---------- Dinh nghia cot ----------

function catalogColumn(item) {
  return {
    key: item.key, label: item.label, type: item.type,
    description: item.description, selected: item.selected !== false
  };
}

/** Cot theo catalogue cua 1 nguon (mac dinh: du cac truong theo thu tu tab). */
function sourceColumns(sourceKey, keys) {
  const fields = exportFieldCatalog.getSourceFields(sourceKey);
  if (!keys) return fields.map(catalogColumn);
  const byKey = new Map(fields.map(item => [item.key, item]));
  return keys.map(key => catalogColumn(byKey.get(key)));
}

/** Cot dashboard tinh them (khong thuoc catalogue): khoa d_<key>. */
function derivedColumn(key, label, type, description) {
  return { key: `d_${key}`, label, type, description, selected: true, derivedKey: key };
}

/** Cot cua bang tong hop: khoa = ten thuoc tinh cua dong nguon. */
function aggregateColumn(key, label, type, description, options = {}) {
  return {
    key,
    label,
    type: type || inferColumnType(label),
    description,
    wrapText: options.wrapText === true,
    selected: options.selected !== false
  };
}

// Cot cua cac bang tong hop/nguon dong — dung chung cho buoc lay truong va buoc tao file.
const DEBT_COLUMNS = [
  aggregateColumn('customerName', 'Khách hàng', 'text', 'Tên khách hàng trong bảng quản lý công nợ.'),
  aggregateColumn('sale', 'Nhân viên phụ trách (Sale)', 'text', 'Nhân viên bán hàng phụ trách công nợ của khách.'),
  aggregateColumn('paymentSchedule', 'Lịch thanh toán', 'text', 'Chu kỳ thanh toán đã thỏa thuận với khách.'),
  aggregateColumn('openingDebt', 'Nợ đầu kỳ', 'number', 'Số nợ của khách ở đầu kỳ theo dõi (VNĐ).'),
  aggregateColumn('currentDebt', 'Nợ hiện tại', 'number', 'Số tiền khách còn nợ tại thời điểm xuất (VNĐ).'),
  aggregateColumn('overdueDebt', 'Nợ quá hạn', 'number', 'Phần nợ đã quá hạn thanh toán (VNĐ).'),
  aggregateColumn('currentDebtToSalesRatio', 'Tỷ lệ nợ hiện tại trên doanh số', 'percent',
    'Nợ hiện tại chia cho doanh số của khách, hiển thị theo phần trăm.'),
  aggregateColumn('overdueToSalesRatio', 'Nợ quá hạn trên doanh số trung bình', 'percent',
    'Nợ quá hạn chia cho doanh số trung bình của khách, hiển thị theo phần trăm.'),
  aggregateColumn('automaticAlert', 'Cảnh báo tự động', 'text',
    'Cảnh báo hệ thống tự tính: Chưa thu, Quá hạn hoặc Lỗi dữ liệu.', { wrapText: true }),
  aggregateColumn('workflowStatus', 'Trạng thái xử lý', 'text', 'Trạng thái xử lý công nợ do nhân viên cập nhật.'),
  aggregateColumn('updatedBy', 'Người cập nhật', 'text', 'Người cập nhật trạng thái xử lý gần nhất.', { selected: false }),
  aggregateColumn('updatedAt', 'Cập nhật lúc', 'date', 'Thời điểm cập nhật trạng thái xử lý gần nhất.', { selected: false })
];

const DEBT_BRANCH_COLUMN = aggregateColumn('branch', 'Cơ sở', 'text', 'Cơ sở (Hà Nội hoặc Sài Gòn) của khoản công nợ.');

const PARENT_CATEGORY_COLUMNS = [
  aggregateColumn('name', 'Nhóm cha', undefined, 'Tên nhóm hàng cấp cha.'),
  aggregateColumn('qty', 'Số lượng bán', 'number', 'Tổng số lượng hàng bán ra của nhóm trong 90 ngày gần nhất.'),
  aggregateColumn('revenue', 'Doanh thu', 'number', 'Tổng doanh thu bán hàng của nhóm trong 90 ngày gần nhất (VNĐ).'),
  aggregateColumn('productCount', 'Số mã hàng', 'number', 'Số mã hàng thuộc nhóm có phát sinh bán trong 90 ngày gần nhất.')
];

const CHILD_CATEGORY_COLUMNS = [
  aggregateColumn('parent', 'Nhóm cha', undefined, 'Tên nhóm hàng cấp cha đang xem.'),
  aggregateColumn('name', 'Nhóm con', undefined, 'Tên nhóm hàng cấp con thuộc nhóm cha.'),
  aggregateColumn('qty', 'Số lượng bán', 'number', 'Tổng số lượng hàng bán ra của nhóm con trong kỳ.'),
  aggregateColumn('revenue', 'Doanh thu', 'number', 'Tổng doanh thu bán hàng của nhóm con trong kỳ (VNĐ).'),
  aggregateColumn('productCount', 'Số mã hàng', 'number', 'Số mã hàng thuộc nhóm con có phát sinh bán trong kỳ.')
];

const CUSTOMER_PRODUCT_DETAIL_COLUMNS = [
  aggregateColumn('name', 'Tên hàng', undefined, 'Tên hàng khách đã mua.'),
  aggregateColumn('quantity', 'Số lượng', 'number', 'Tổng số lượng hàng khách đã mua.'),
  aggregateColumn('revenue', 'Doanh thu', 'number', 'Tổng doanh thu của mặt hàng với khách (VNĐ).'),
  aggregateColumn('month1Revenue', 'Doanh thu tháng này', 'number', 'Doanh thu của mặt hàng với khách trong tháng hiện tại (VNĐ).'),
  aggregateColumn('month2Revenue', 'Doanh thu tháng trước', 'number', 'Doanh thu của mặt hàng với khách trong tháng trước (VNĐ).'),
  aggregateColumn('month3Revenue', 'Doanh thu 2 tháng trước', 'number', 'Doanh thu của mặt hàng với khách cách đây hai tháng (VNĐ).')
];

// Bao cao hang hoa (tab Tong quan) - doc thang tu bang product_report da tinh
// san 1 lan/dem (xem productReportRepository.js/productReportRefresh.js).
const PRODUCT_REPORT_COLUMNS = [
  aggregateColumn('code', 'Mã sản phẩm', 'text', 'Mã sản phẩm.'),
  aggregateColumn('name', 'Tên sản phẩm', undefined, 'Tên sản phẩm.'),
  aggregateColumn('stockHanoi', 'Tồn Hà Nội', 'number', 'Tồn kho hiện tại tại cơ sở Hà Nội.'),
  aggregateColumn('stockSaigon', 'Tồn Sài Gòn', 'number', 'Tồn kho hiện tại tại cơ sở Sài Gòn.'),
  aggregateColumn('availableToSell', 'Tổng tồn có thể bán', 'number',
    'Tổng tồn 2 cơ sở trừ số lượng đang bị giữ chỗ trong đơn đặt hàng của khách chưa hoàn tất.'),
  aggregateColumn('qtySold30d', 'Số lượng bán 30 ngày', 'number', 'Tổng số lượng bán ra trong 30 ngày gần nhất (tính đến hết hôm qua).'),
  aggregateColumn('revenue90d', 'Doanh số 90 ngày', 'number', 'Doanh số trong 90 ngày gần nhất (tính đến hết hôm qua, đơn vị tiền Việt Nam).'),
  aggregateColumn('customerCount90d', 'Số lượng khách mua', 'number', 'Số khách hàng khác nhau đã mua mã này trong 90 ngày.'),
  aggregateColumn('topCustomerRevenue90d', 'Doanh số khách lớn nhất', 'number', 'Doanh số của khách mua nhiều nhất trong 90 ngày.'),
  aggregateColumn('topCustomerName', 'Khách lớn nhất', 'text', 'Tên khách hàng mua nhiều nhất trong 90 ngày.'),
  aggregateColumn('topCustomerShare', 'Tỷ lệ khách lớn nhất', 'percent', 'Doanh số khách lớn nhất chia cho doanh số 90 ngày.')
];

const CUSTOMER_PRODUCT_TOP_COLUMNS = [
  aggregateColumn('productCode', 'Mã hàng', 'text', 'Mã hàng được tìm kiếm.'),
  aggregateColumn('productName', 'Tên hàng', undefined, 'Tên hàng được tìm kiếm.'),
  aggregateColumn('customerCode', 'Mã khách hàng', 'text', 'Mã khách hàng đã mua mặt hàng.'),
  aggregateColumn('customerName', 'Khách hàng', undefined, 'Tên khách hàng đã mua mặt hàng.'),
  aggregateColumn('purchasedQuantity', 'Tổng số lượng mua', 'number', 'Tổng số lượng khách đã mua mặt hàng.'),
  aggregateColumn('purchaseRevenue', 'Tổng doanh thu mua', 'number', 'Tổng doanh thu bán mặt hàng cho khách (VNĐ).'),
  aggregateColumn('returnedQuantityAllTime', 'Số lượng trả (toàn thời gian)', 'number', 'Tổng số lượng khách đã trả lại từ trước đến nay.'),
  aggregateColumn('returnValueAllTime', 'Giá trị trả (toàn thời gian)', 'number', 'Tổng giá trị hàng khách đã trả lại từ trước đến nay (VNĐ).'),
  aggregateColumn('netRevenue', 'Doanh thu thuần', 'number', 'Doanh thu sau khi trừ giá trị hàng trả lại (VNĐ).'),
  aggregateColumn('lastPurchaseDate', 'Ngày mua cuối cùng', 'date', 'Ngày khách mua mặt hàng gần nhất.')
];

const STOCKOUT_RECENT_COLUMNS = [
  aggregateColumn('code', 'Mã hàng', 'text', 'Mã hàng bị đứt hàng.'),
  aggregateColumn('name', 'Tên hàng', undefined, 'Tên hàng bị đứt hàng.'),
  aggregateColumn('lastOutOfStockDate', 'Ngày hết hàng gần nhất', 'date', 'Ngày gần nhất mặt hàng hết tồn kho.'),
  aggregateColumn('daysOutOfStock', 'Số ngày đứt hàng', 'number', 'Số ngày mặt hàng đứt hàng trong kỳ quét.'),
  aggregateColumn('periods', 'Các đợt đứt hàng', undefined, 'Từng đợt đứt hàng, mỗi đợt một dòng (từ ngày -> đến ngày).', { wrapText: true })
];

// Ket qua quet o "Cả hai" gop dong cua 2 co so (cung ma hang co the xuat hien
// hai lan) — bat buoc phai co cot nguon. Cot nay PHU THUOC KET QUA DA QUET
// (result.branch), khong phu thuoc co so dang chon luc bam Xuat Excel.
const STOCKOUT_BRANCH_COLUMN = aggregateColumn('branch', 'Cơ sở', 'text', 'Cơ sở (Hà Nội hoặc Sài Gòn) phát sinh kết quả đứt hàng.');

const STOCKOUT_90D_COLUMNS = [
  aggregateColumn('code', 'Mã hàng', 'text', 'Mã hàng được kiểm tra.'),
  aggregateColumn('name', 'Tên hàng', undefined, 'Tên hàng được kiểm tra.'),
  aggregateColumn('stockoutCount', 'Số lần đứt hàng', 'number', 'Số đợt đứt hàng trong 90 ngày gần nhất.'),
  aggregateColumn('totalStockoutDays', 'Số ngày đứt hàng', 'number', 'Tổng số ngày đứt hàng trong 90 ngày gần nhất.'),
  aggregateColumn('avgStockoutDays', 'Số ngày đứt hàng trung bình', 'number', 'Tổng số ngày đứt hàng chia cho số lần đứt hàng.'),
  aggregateColumn('currentOnHand', 'Tồn kho hiện tại', 'number', 'Số lượng tồn kho hiện tại của mặt hàng.'),
  aggregateColumn('periods', 'Các đợt đứt hàng', undefined, 'Từng đợt đứt hàng, mỗi đợt một dòng (từ ngày -> đến ngày).', { wrapText: true })
];

const STOCKOUT_30D_COLUMNS = [
  aggregateColumn('code', 'Mã hàng', 'text', 'Mã hàng được kiểm tra.'),
  aggregateColumn('name', 'Tên hàng', undefined, 'Tên hàng được kiểm tra.'),
  aggregateColumn('stockoutCount', 'Số lần đứt hàng', 'number', 'Số đợt đứt hàng trong 30 ngày gần nhất.'),
  aggregateColumn('totalStockoutDays', 'Số ngày đứt hàng', 'number', 'Tổng số ngày đứt hàng trong 30 ngày gần nhất.'),
  aggregateColumn('avgStockoutDays', 'Số ngày đứt hàng trung bình', 'number', 'Tổng số ngày đứt hàng chia cho số lần đứt hàng.'),
  aggregateColumn('currentOnHand', 'Tồn kho hiện tại', 'number', 'Số lượng tồn kho hiện tại của mặt hàng.'),
  aggregateColumn('periods', 'Các đợt đứt hàng', undefined, 'Từng đợt đứt hàng, mỗi đợt một dòng (từ ngày -> đến ngày).', { wrapText: true })
];

// ---------- Ghep dong tho theo ma ----------

function rowsByCode(sourceRows, codeKey) {
  const map = new Map();
  (sourceRows || []).forEach(row => {
    const key = normalizeCode(row && row[codeKey]);
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
}

/** Cot can nap cho 1 worksheet: cot da chon (khi khong tim kiem) hoac tat ca. */
function activeColumns(worksheet, selection, keepAll) {
  const requested = selection && selection[worksheet.key];
  if (keepAll || !Array.isArray(requested)) return worksheet.columns;
  const wanted = new Set(requested);
  return worksheet.columns.filter(column => wanted.has(column.key));
}

function pickSourceValues(row, columns, sourceRow) {
  columns.forEach(column => {
    row[column.key] = sourceRow ? sourceRow[column.key] : '';
  });
  return row;
}

function buildLogicalRows(items, byCode, columns, derivedValues, keyOf = item => normalizeCode(item.code)) {
  const sourceColumnsList = columns.filter(column => !column.derivedKey);
  const derivedColumns = columns.filter(column => column.derivedKey);
  return items.map(item => {
    const matches = byCode.get(keyOf(item)) || [];
    const row = pickSourceValues({}, sourceColumnsList, matches[0]);
    derivedColumns.forEach(column => {
      const compute = derivedValues && derivedValues[column.derivedKey];
      row[column.key] = compute ? compute(item) : '';
    });
    return row;
  });
}

function pickAggregateRows(sourceRows, columns) {
  return (sourceRows || []).map(source => {
    const row = {};
    columns.forEach(column => { row[column.key] = source[column.key]; });
    return row;
  });
}

async function readSourceRows(source, env, codes) {
  if (!codes.length) return [];
  const result = await dashboardPgReader.readRowsByCodes(source.sheetName, env.branch, codes, { signal: env.signal });
  throwIfAborted(env.signal);
  return (result && result.rows) || [];
}

// "Ca hai": khoa ghep gom co so vat ly + ma chuan hoa — cung ma chung tu co the ton tai o
// ca hai co so nen KHONG duoc ghep theo ma don le.
function compositeKey(branch, code) {
  return `${normalizeText(branch)}\u0000${normalizeCode(code)}`;
}

/**
 * Gop dong tho cua cac co so vat ly cho nguon THUC THE (san pham/khach/NCC) bang dung
 * quy tac cua man hinh (dashboardData.mergeEntityRows): cot cong don duoc cong, gia von
 * binh quan theo ton kho, cot con lai lay gia tri that dau tien theo Ha Noi -> Sai Gon.
 */
function mergeEntitySourceRows(source, rowsByBranch) {
  const fields = exportFieldCatalog.getSourceFields(source.key);
  const keys = fields.map(item => item.key);
  const headers = fields.map(item => item.sheetHeader);
  const sources = rowsByBranch.map(({ branch, rows }) => ({
    branch,
    sheets: { [source.sheetName]: [headers, ...rows.map(row => keys.map(key => row[key]))] }
  }));
  const merged = dashboardData.mergeEntityRows(sources, source.sheetName);
  if (!merged) return rowsByBranch.flatMap(group => group.rows);
  return merged.slice(1).map(values => Object.fromEntries(keys.map((key, index) => [key, values[index]])));
}

/**
 * Nap dong tho cho danh sach dong logic va tra ve cach ghep:
 *   - co so vat ly: doc 1 co so, ghep theo ma (nhu cu);
 *   - "Ca hai" + nguon giao dich (perBranch): moi co so vat ly chi doc cac ma cua CHINH no,
 *     ghep theo (co so, ma);
 *   - "Ca hai" + nguon thuc the: doc moi ma o ca hai co so roi gop theo ma.
 * Khong bao gio truyen "Ca hai" cho readRowsByCodes.
 */
async function loadSourceRowsForItems(source, env, items, perBranch) {
  const codes = items.map(item => item.code);
  const byCodeKey = item => normalizeCode(item.code);
  if (env.branch !== BRANCH_BOTH) {
    const sourceRows = await readSourceRows(source, env, codes);
    return { byKey: rowsByCode(sourceRows, source.codeKey), keyOf: byCodeKey };
  }
  const scope = resolveBranchScope(BRANCH_BOTH);
  if (perBranch) {
    const groups = await Promise.all(scope.map(async physicalBranch => ({
      branch: physicalBranch,
      rows: await readSourceRows(
        source,
        { ...env, branch: physicalBranch },
        items.filter(item => item.branch === physicalBranch).map(item => item.code)
      )
    })));
    const byKey = new Map();
    groups.forEach(({ branch, rows }) => rows.forEach(row => {
      const key = compositeKey(branch, row[source.codeKey]);
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(row);
    }));
    return { byKey, keyOf: item => compositeKey(item.branch, item.code) };
  }
  const groups = await Promise.all(scope.map(async physicalBranch => ({
    branch: physicalBranch,
    rows: await readSourceRows(source, { ...env, branch: physicalBranch }, codes)
  })));
  return { byKey: rowsByCode(mergeEntitySourceRows(source, groups), source.codeKey), keyOf: byCodeKey };
}

// ---------- Dinh nghia tung bang (worksheets + ham nap dong) ----------

function customerRevenueRows(dashboard) {
  const topRevenue = ((dashboard.customers || {}).topRevenue || {});
  return topRevenue.all || topRevenue.top50 || [];
}

const BRANCH_COLUMN_LABEL = 'Cơ sở';
const BRANCH_COLUMN_DESCRIPTION = 'Cơ sở (Hà Nội hoặc Sài Gòn) nơi phát sinh chứng từ.';
const BRANCH_ITEM_VALUE = item => normalizeText(item.branch);

function branchDerivedColumn() {
  return derivedColumn('branch', BRANCH_COLUMN_LABEL, 'text', BRANCH_COLUMN_DESCRIPTION);
}

/** Bang 1 worksheet: cac dong logic (ma) ghep voi dong tho cua 1 nguon catalogue. */
function singleSourceTable(options) {
  const { key, name, sourceKey, derived = [], items, branchColumn = false } = options;
  const source = exportFieldCatalog.getSource(sourceKey);
  // "Ca hai" + bang giao dich: them cot "Cơ sở" va ghep dong tho theo (co so, ma).
  const derivedValues = branchColumn ? { ...options.derivedValues, branch: BRANCH_ITEM_VALUE } : options.derivedValues;
  const worksheet = {
    key,
    name,
    codeKey: source.codeKey,
    columns: sourceColumns(sourceKey).concat(
      derived.map(def => derivedColumn(def.key, def.label, def.type, def.description)),
      branchColumn ? [branchDerivedColumn()] : []
    )
  };
  return {
    worksheets: [worksheet],
    async loadRows(env, activeFor) {
      const list = items(env.dashboard, env.context) || [];
      const { byKey, keyOf } = await loadSourceRowsForItems(source, env, list, branchColumn);
      return [{ rows: buildLogicalRows(list, byKey, activeFor(worksheet), derivedValues, keyOf) }];
    }
  };
}

/** Bang 1 worksheet tu du lieu tong hop cua dashboard (khong doc them Postgres). */
function aggregateTable(options) {
  const { key, name, columns, rows } = options;
  const worksheet = { key, name, columns, codeKey: options.codeKey };
  return {
    worksheets: [worksheet],
    async loadRows(env, activeFor) {
      const built = rows(env.dashboard, env.context) || [];
      const result = { rows: pickAggregateRows(built.rows || built, activeFor(worksheet)) };
      if (built.name) result.name = built.name;
      return [result];
    }
  };
}

function purchasesTable(aggregate = false) {
  const source = exportFieldCatalog.getSource('purchases');
  const extraColumns = aggregate ? [branchDerivedColumn()] : [];
  const derivedValues = aggregate ? { branch: BRANCH_ITEM_VALUE } : undefined;
  const summary = {
    key: 'purchase_summary', name: 'Tổng hợp phiếu', codeKey: source.codeKey,
    columns: sourceColumns('purchases', exportFieldCatalog.PURCHASE_SUMMARY_KEYS).concat(extraColumns)
  };
  const details = {
    key: 'purchase_details', name: 'Chi tiết mặt hàng', codeKey: source.codeKey,
    columns: sourceColumns('purchases').concat(extraColumns)
  };
  return {
    worksheets: [summary, details],
    async loadRows(env, activeFor) {
      const items = ((env.dashboard.newPurchases || {}).orders || []);
      const { byKey, keyOf } = await loadSourceRowsForItems(source, env, items, aggregate);
      const summaryRows = buildLogicalRows(items, byKey, activeFor(summary), derivedValues, keyOf);
      const detailColumns = activeFor(details);
      const detailSourceColumns = detailColumns.filter(column => !column.derivedKey);
      const detailDerivedColumns = detailColumns.filter(column => column.derivedKey);
      const detailRows = [];
      const seen = new Set();
      items.forEach(item => {
        if (detailColumns.length === 0) return; // khong chon cot nao cua worksheet chi tiet
        const key = keyOf(item);
        if (seen.has(key)) return;
        seen.add(key);
        (byKey.get(key) || []).forEach(sourceRow => {
          const row = pickSourceValues({}, detailSourceColumns, sourceRow);
          detailDerivedColumns.forEach(column => { row[column.key] = derivedValues[column.derivedKey](item); });
          detailRows.push(row);
        });
      });
      return [{ rows: summaryRows }, { rows: detailRows }];
    }
  };
}

function normalizeDebtSearch(value) {
  return normalizeText(value).normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase('vi-VN');
}

function debtAutomaticAlert(customer) {
  const labels = (customer.alertCodes || []).map(code => {
    if (code === 'uncollected') return 'Chưa thu';
    if (code === 'overdue') return 'Quá hạn';
    return '';
  }).filter(Boolean);
  if ((customer.dataIssues || []).length) labels.push('Lỗi dữ liệu');
  return labels.join(', ');
}

function sortDebtManagementRows(rows, sort) {
  const columnIndex = Number(sort && sort.columnIndex);
  const direction = sort && sort.direction;
  const field = Number.isInteger(columnIndex) ? DEBT_SORT_FIELDS[columnIndex] : '';
  if (!field || !['asc', 'desc'].includes(direction)) return rows.slice();
  return rows.map((row, index) => ({ row, index })).sort((left, right) => {
    const a = left.row[field];
    const b = right.row[field];
    const aEmpty = a === null || a === undefined || a === '';
    const bEmpty = b === null || b === undefined || b === '';
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    let comparison = 0;
    if (typeof a === 'number' && typeof b === 'number') comparison = a - b;
    else comparison = String(a).localeCompare(String(b), 'vi', { numeric: true, sensitivity: 'base' });
    if (comparison === 0) comparison = left.index - right.index;
    return direction === 'asc' ? comparison : -comparison;
  }).map(entry => entry.row);
}

function debtManagementRows(debtManagement, context, aggregate = false) {
  const debt = debtManagement && typeof debtManagement === 'object' ? debtManagement : {};
  const queue = DEBT_QUEUE_FILTERS.has(context.debtQueue) ? context.debtQueue : 'needsAction';
  const sale = normalizeText(context.debtSale);
  const schedule = normalizeText(context.debtSchedule);
  const query = normalizeDebtSearch(context.debtSearch);
  // Loc va sap xep LUON tren hang cua man hinh (o "Ca hai" la hang da gop theo khach), giong duong
  // co so vat ly; chi sau do moi tach thanh cac dong theo co so de xuat.
  const customers = Array.isArray(debt.customers) ? debt.customers : [];
  const retained = customers.filter(customer => {
    if (queue === 'needsAction' && !customer.needsAction) return false;
    if (queue === 'currentDebt' && !(Number(customer.currentDebt) > 0)) return false;
    if (queue === 'overdue' && !(Number(customer.overdueDebt) > 0)) return false;
    if (sale && customer.sale !== sale) return false;
    if (schedule && customer.paymentSchedule !== schedule) return false;
    if (query && !normalizeDebtSearch(customer.customerName).includes(query) && !normalizeDebtSearch(customer.sale).includes(query)) return false;
    return true;
  });
  const toRow = customer => ({
    customerName: customer.customerName,
    branch: normalizeText(customer.branch),
    sale: customer.sale,
    paymentSchedule: customer.paymentSchedule,
    openingDebt: customer.openingDebt,
    currentDebt: customer.currentDebt,
    overdueDebt: customer.overdueDebt,
    currentDebtToSalesRatio: customer.currentDebtToSalesRatio,
    overdueToSalesRatio: customer.overdueToSalesRatio,
    automaticAlert: debtAutomaticAlert(customer),
    workflowStatus: customer.workflowStatus,
    updatedBy: customer.updatedBy,
    updatedAt: customer.updatedAt
  });
  const customerByRow = new Map();
  const rows = retained.map(customer => {
    const row = toRow(customer);
    customerByRow.set(row, customer);
    return row;
  });
  const sorted = sortDebtManagementRows(rows, context.debtSort);
  if (!aggregate) return { rows: sorted, name: normalizeText(debt.sourceSheet) };
  // "Ca hai": hang gop khong the hien ty le/trang thai xu ly rieng cua tung co so, nen moi khach giu lai
  // duoc tach thanh cac dong theo co so (branchDetails, day du chi so cua chinh co so do).
  const expanded = sorted.flatMap(row => {
    const customer = customerByRow.get(row);
    const details = Array.isArray(customer.branchDetails) && customer.branchDetails.length ? customer.branchDetails : [customer];
    return details.map(toRow);
  });
  return { rows: expanded, name: normalizeText(debt.sourceSheet) };
}

// Worksheet cua bang khong doc dashboard/Postgres (du lieu tu bao cao rieng hoac payload).
function reportWorksheet(key, name, columns) {
  return { key, name, columns, codeKey: columns.some(column => column.key === 'code') ? 'code' : undefined };
}

// tableKey -> (context) => { worksheets, loadRows? }. Bang co loadRows doc tu dashboard
// (getDashboardData) + Postgres; bang khong co loadRows duoc dung rieng (xem buildExportDataset).
const TABLE_SPECS = {
  'overview.transactions': (context, scope) => singleSourceTable({
    key: 'transactions', name: 'Chi tiết giao dịch', sourceKey: 'invoices', branchColumn: scope.aggregate,
    items: dashboard => (((dashboard.invoices || {}).transactionsReport || {}).transactions) || [],
    derived: [{ key: 'quantity', label: 'Số lượng', type: 'number', description: 'Tổng số lượng hàng của hóa đơn; để trống nếu chưa xác định được.' }],
    derivedValues: { quantity: item => (item.quantityKnown ? item.quantity : '') }
  }),
  'overview.purchases': (context, scope) => purchasesTable(scope.aggregate),
  'overview.new-products': () => singleSourceTable({
    key: 'new_products', name: 'Mã mới tạo', sourceKey: 'products',
    items: dashboard => (((dashboard.products || {}).newProducts || {}).products) || []
  }),
  'products.top-selling': context => {
    if (context.productAnalysis === 'parentCategory') {
      return aggregateTable({
        key: 'top_parent_categories', name: 'Top nhóm cha', columns: PARENT_CATEGORY_COLUMNS,
        rows: dashboard => (dashboard.products || {}).allSellingParentCategories
          || (dashboard.products || {}).topSellingParentCategories || []
      });
    }
    return singleSourceTable({
      key: 'top_products', name: 'Top sản phẩm', sourceKey: 'products',
      items: dashboard => (dashboard.products || {}).allSellingProducts
        || (dashboard.products || {}).topSellingProducts || [],
      derived: [
        { key: 'sold_qty', label: 'Số lượng bán', type: 'number', description: 'Tổng số lượng hàng bán ra trong 90 ngày gần nhất.' },
        { key: 'sales_revenue', label: 'Doanh thu', type: 'number', description: 'Tổng doanh thu bán hàng trong 90 ngày gần nhất (VNĐ).' }
      ],
      derivedValues: { sold_qty: item => item.qty, sales_revenue: item => item.revenue }
    });
  },
  'products.low-stock': () => singleSourceTable({
    key: 'low_stock', name: 'Hàng đã hết', sourceKey: 'products',
    items: dashboard => dashboard.lowStock || []
  }),
  'products.all': () => singleSourceTable({
    key: 'all_products', name: 'Tất cả mã hàng', sourceKey: 'products',
    items: dashboard => dashboard.allProducts || [],
    derived: [{ key: 'stock_ratio', label: 'Tỷ trọng tồn kho', type: 'percent', description: 'Phần trăm tồn kho của mặt hàng trên tổng tồn kho của tất cả hàng hóa.' }],
    derivedValues: { stock_ratio: item => Number(item.pct || 0) / 100 }
  }),
  'products.newly-imported': () => singleSourceTable({
    key: 'newly_imported', name: 'Hàng mới nhập', sourceKey: 'products',
    items: dashboard => (((dashboard.products || {}).newlyImported || {}).products) || [],
    derived: [
      { key: 'first_import_date', label: 'Ngày nhập đầu tiên', type: 'date', description: 'Ngày đầu tiên mặt hàng được nhập kho.' },
      { key: 'days_on_hand', label: 'Số ngày tồn tại', type: 'number', description: 'Số ngày kể từ lần nhập đầu tiên đến hiện tại.' },
      { key: 'revenue', label: 'Doanh thu', type: 'number', description: 'Doanh thu bán hàng của mặt hàng kể từ khi nhập (VNĐ).' }
    ],
    derivedValues: {
      first_import_date: item => item.firstImportDate,
      days_on_hand: item => item.daysOnHand,
      revenue: item => item.revenue
    }
  }),
  'products.child-categories': context => aggregateTable({
    key: 'child_categories', name: 'Chi tiết nhóm con', columns: CHILD_CATEGORY_COLUMNS,
    rows: dashboard => {
      const parent = normalizeText(context.childCategoryParent);
      return ((((dashboard.products || {}).childCategorySalesByParent || {})[parent]) || []).map(item => ({
        parent, name: item.name, qty: item.qty, revenue: item.revenue, productCount: item.productCount
      }));
    }
  }),
  'invoices.orders': (context, scope) => singleSourceTable({
    key: 'orders', name: 'Đặt hàng', sourceKey: 'orders', branchColumn: scope.aggregate,
    items: dashboard => (dashboard.invoices || {}).periodOrders || []
  }),
  'invoices.returns': (context, scope) => singleSourceTable({
    key: 'returns', name: 'Trả hàng', sourceKey: 'returns', branchColumn: scope.aggregate,
    items: dashboard => (dashboard.invoices || {}).periodReturns || []
  }),
  'customers.revenue': () => singleSourceTable({
    key: 'customer_revenue', name: 'Doanh thu theo khách', sourceKey: 'customers',
    items: customerRevenueRows,
    derived: [
      { key: 'sale_order_count', label: 'Số đơn bán', type: 'number', description: 'Số đơn bán của khách trong kỳ.' },
      { key: 'period_revenue', label: 'Doanh thu trong kỳ', type: 'number', description: 'Doanh thu bán cho khách trong kỳ (VNĐ).' }
    ],
    derivedValues: { sale_order_count: item => item.saleOrderCount, period_revenue: item => item.revenue }
  }),
  'customers.debt': () => singleSourceTable({
    key: 'customer_debt', name: 'Khách còn nợ', sourceKey: 'customers',
    items: dashboard => (dashboard.customers || {}).topDebt || [],
    derived: [{ key: 'period_revenue', label: 'Doanh thu trong kỳ', type: 'number', description: 'Doanh thu bán cho khách trong kỳ (VNĐ).' }],
    derivedValues: { period_revenue: item => item.periodRevenue }
  }),
  'suppliers.list': () => singleSourceTable({
    key: 'suppliers', name: 'Nhà cung cấp', sourceKey: 'suppliers',
    items: dashboard => dashboard.suppliers || []
  }),
  'debt.management': (context, scope) => aggregateTable({
    key: 'debt_management', name: 'Quản lý công nợ',
    columns: scope.aggregate ? [DEBT_COLUMNS[0], DEBT_BRANCH_COLUMN, ...DEBT_COLUMNS.slice(1)] : DEBT_COLUMNS,
    rows: dashboard => debtManagementRows(dashboard.debtManagement, context, scope.aggregate)
  }),
  // Cac bang duoi day khong co loadRows: nguon du lieu rieng (bao cao khach/hang, payload quet ton).
  'customers.productDetail': () => ({
    worksheets: [reportWorksheet('customer_product_detail', 'Bảng chi tiết sản phẩm', CUSTOMER_PRODUCT_DETAIL_COLUMNS)]
  }),
  'overview.productReport': () => ({
    worksheets: [reportWorksheet('product_report', 'Báo cáo hàng hóa', PRODUCT_REPORT_COLUMNS)]
  }),
  'stockout.recentScan': () => ({
    worksheets: [reportWorksheet('recent_stockout_result', 'Hàng đứt gần đây', STOCKOUT_RECENT_COLUMNS)]
  }),
  'stockout.check90d': () => ({
    worksheets: [reportWorksheet('stockout_90d_result', 'Kiểm tra đứt hàng 90 ngày', STOCKOUT_90D_COLUMNS)]
  }),
  'stockout.check30d': () => ({
    worksheets: [reportWorksheet('stockout_30d_result', 'Kiểm tra đứt hàng 30 ngày', STOCKOUT_30D_COLUMNS)]
  })
};

function getTableSpec(tableKey, context, branch) {
  // hasOwnProperty: khoa cua Object.prototype ('__proto__', 'constructor'...) khong duoc lot qua.
  const factory = Object.prototype.hasOwnProperty.call(TABLE_SPECS, tableKey) ? TABLE_SPECS[tableKey] : null;
  if (typeof factory !== 'function') throw exportError('Bảng yêu cầu xuất không hợp lệ.', 400, 'EXPORT_TABLE_NOT_ALLOWED');
  return factory(plainObject(context), { aggregate: branch === BRANCH_BOTH });
}

// ---------- Tim kiem trong bang ----------

function hasTableSearch(tableSearch) {
  return !!normalizeText(tableSearch && tableSearch.query);
}

function filterWorksheetRows(worksheet, tableSearch) {
  if (!hasTableSearch(tableSearch)) return worksheet;
  const codeKey = worksheet.codeKey;
  const columns = worksheet.columns || [];
  const filtered = filterTableItems(worksheet.rows || [], {
    searchText: row => columns.map(column => row[column.key]).join(' '),
    code: codeKey ? row => row[codeKey] : undefined
  }, tableSearch);
  return { ...worksheet, rows: filtered.items };
}

function applyTableSearchToWorksheets(tableKey, worksheets, tableSearch) {
  if (!hasTableSearch(tableSearch)) return worksheets;
  if (tableKey !== 'overview.purchases') {
    return worksheets.map(worksheet => filterWorksheetRows(worksheet, tableSearch));
  }

  const summary = filterWorksheetRows(worksheets[0], tableSearch);
  // "Ca hai": cung ma phieu o hai co so la hai phieu khac nhau -> giu theo (co so, ma). Bang co
  // so vat ly khong co cot "d_branch" nen khoa chi con la ma nhu cu.
  const retentionKey = (row, codeKey) => compositeKey(row.d_branch, row[codeKey]);
  const retainedCodes = new Set((summary.rows || []).map(row => retentionKey(row, summary.codeKey)));
  const detail = worksheets[1];
  return [summary, {
    ...detail,
    rows: (detail.rows || []).filter(row => retainedCodes.has(retentionKey(row, detail.codeKey)))
  }];
}

function applyTableSearchToDataset(dataset, tableSearch) {
  if (!dataset || !hasTableSearch(tableSearch)) return dataset;
  return {
    ...dataset,
    worksheets: applyTableSearchToWorksheets(dataset.tableKey, dataset.worksheets || [], tableSearch)
  };
}

function projectWorksheetRows(worksheet, keys) {
  if (!Array.isArray(keys)) return worksheet;
  return {
    ...worksheet,
    rows: worksheet.rows.map(row => {
      const projected = {};
      keys.forEach(key => { projected[key] = row[key]; });
      return projected;
    })
  };
}

// ---------- Dataset ----------

/**
 * Dong bo bang co dinh tu dashboard + Postgres.
 * @param {string} tableKey
 * @param {{dashboard: Object, branch: string, signal?: AbortSignal}} env  `dashboard` chi DOC (nam trong cache dung chung)
 * @param {Object} context ngu canh bang (nhom cha, bo loc cong no...)
 * @param {Object} tableSearch tim kiem tren bang
 * @param {Object<string,string[]>} [selection] worksheetKey -> key cot da chon; co thi chi giu cot do
 */
async function buildFixedDataset(tableKey, env, context, tableSearch = {}, selection) {
  const spec = getTableSpec(tableKey, context, env.branch);
  if (typeof spec.loadRows !== 'function') {
    throw exportError('Bảng yêu cầu xuất không hợp lệ.', 400, 'EXPORT_TABLE_NOT_ALLOWED');
  }
  const searching = hasTableSearch(tableSearch);
  // Tim kiem can moi cot cua worksheet (nhu ban cu) nen khi co tim kiem thi nap
  // day du roi moi cat con cot da chon sau khi loc.
  const activeFor = worksheet => activeColumns(worksheet, selection, searching);
  const loaded = await spec.loadRows({ ...env, context: plainObject(context) }, activeFor);
  throwIfAborted(env.signal);

  let worksheets = spec.worksheets.map((worksheet, index) => ({
    key: worksheet.key,
    name: (loaded[index] && loaded[index].name) || worksheet.name,
    columns: worksheet.columns,
    codeKey: worksheet.codeKey,
    rows: (loaded[index] && loaded[index].rows) || []
  }));
  worksheets = applyTableSearchToWorksheets(tableKey, worksheets, tableSearch);
  if (searching && selection) {
    worksheets = worksheets.map(worksheet => projectWorksheetRows(worksheet, selection[worksheet.key]));
  }
  return {
    tableKey,
    title: TABLE_TITLES[tableKey],
    selectionMode: 'custom',
    worksheets
  };
}

function searchColumnType(sheetName, header) {
  const source = exportFieldCatalog.getSourceBySheetName(sheetName);
  const wanted = normalizeText(header).normalize('NFC');
  const found = source && source.fields.find(item => normalizeText(item.sheetHeader).normalize('NFC') === wanted);
  return found ? found.type : inferColumnType(header);
}

function fieldsToWorksheet(sourceKey, sourceLabel, results) {
  const source = exportFieldCatalog.getSource(sourceKey);
  const sheetName = source ? source.sheetName : sourceLabel;
  const maxFieldCount = results.reduce((max, result) => Math.max(max, (result.fields || []).length), 0);
  const sample = results.find(result => (result.fields || []).length === maxFieldCount) || { fields: [] };
  const columns = (sample.fields || []).map((field, index) => ({
    key: `c${index}`,
    label: normalizeText(exportFieldCatalog.labelForSheetHeader(sheetName, field.label)) || `Cột ${index + 1}`,
    type: searchColumnType(sheetName, field.label)
  }));
  const rows = results.map(result => {
    const row = {};
    columns.forEach((column, index) => {
      const field = (result.fields || [])[index];
      row[column.key] = !field ? '' : (Object.prototype.hasOwnProperty.call(field, 'rawValue') ? field.rawValue : (field.value === '—' ? '' : field.value));
    });
    return row;
  });
  // "Ca hai": ket qua giao dich mang co so vat ly cua tung dong (ma co the trung giua hai co so).
  if (results.length > 0 && results.every(result => typeof result.branch === 'string')) {
    columns.push({ key: 'co_so', label: BRANCH_COLUMN_LABEL, type: 'text' });
    rows.forEach((row, index) => { row.co_so = results[index].branch; });
  }
  return { key: `search_${sourceKey}`, name: sourceLabel, columns, rows };
}

async function buildSearchDataset(payload, filters, branch, signal) {
  const search = payload.search && typeof payload.search === 'object' ? payload.search : {};
  const view = normalizeText(search.view);
  const mode = normalizeText(search.mode) || 'normal';
  const query = normalizeText(search.query);
  if (view === 'overview') {
    throw exportError('Tìm kiếm ở Tổng quan không hỗ trợ xuất Excel.', 400, 'EXPORT_OVERVIEW_SEARCH_DISABLED');
  }
  if (!['products', 'invoices', 'customers', 'suppliers'].includes(view)) {
    throw exportError('Tab tìm kiếm không hợp lệ.', 400, 'EXPORT_SEARCH_VIEW_INVALID');
  }
  if (!query) throw exportError('Không có từ khóa tìm kiếm để xuất.', 400, 'EXPORT_SEARCH_QUERY_EMPTY');

  if (mode === 'customer-products') {
    if (view !== 'customers') throw exportError('Chế độ tìm kiếm này chỉ dùng cho tab Khách hàng.');
    const result = await dashboardData.searchTopCustomersByProducts(query, filters.customers, undefined, branch);
    throwIfAborted(signal);
    return {
      tableKey: 'search.results', title: 'Top khách hàng theo sản phẩm', selectionMode: 'custom',
      worksheets: [{
        key: 'customer_product_top', name: 'Top khách hàng theo sản phẩm',
        columns: CUSTOMER_PRODUCT_TOP_COLUMNS,
        rows: pickAggregateRows(result.results || [], CUSTOMER_PRODUCT_TOP_COLUMNS)
      }]
    };
  }

  // Doi so thu 5 la bo loc thoi gian (chi tab Khach hang dung de tinh doanh thu), doi so thu 6 moi la co so.
  const result = await dashboardData.searchDashboardRecords(
    view, query, 'all', mode === 'codes' ? 'codes' : undefined,
    view === 'customers' ? filters.customers : undefined, branch
  );
  throwIfAborted(signal);
  const groups = new Map();
  (result.results || []).forEach(item => {
    if (!groups.has(item.source)) groups.set(item.source, { label: item.sourceLabel, results: [] });
    groups.get(item.source).results.push(item);
  });
  if (groups.size === 0) throw exportError('Không có kết quả tìm kiếm để xuất.', 404, 'EXPORT_NO_DATA');
  const worksheets = Array.from(groups.entries()).map(([sourceKey, group]) =>
    fieldsToWorksheet(sourceKey, group.label, group.results));
  return {
    tableKey: 'search.results', title: 'Kết quả tìm kiếm',
    selectionMode: worksheets.length > 1 ? 'all-only' : 'custom', worksheets
  };
}

async function buildCustomerProductRevenueDataset(tableKey, description, payload, branch, signal) {
  const context = description.context;
  const customerCode = normalizeText(context.customerProductCustomerCode);
  const customerName = normalizeText(context.customerProductCustomerName);

  const report = await dashboardData.getCustomerProductRevenueReport(customerCode, customerName, branch);
  throwIfAborted(signal);
  const productCode = normalizeText(context.customerProductCode);
  const selectedProducts = productCode
    ? report.products.filter(p => normalizeCode(p.code) === normalizeCode(productCode))
    : report.products;
  const products = filterTableItems(selectedProducts, {
    searchText: product => Object.values(product).join(' '),
    code: product => product.code
  }, payload.tableSearch).items;

  const worksheet = description.worksheets[0];
  return {
    tableKey, title: TABLE_TITLES[tableKey], selectionMode: 'custom',
    worksheets: [{ ...worksheet, rows: pickAggregateRows(products, worksheet.columns) }]
  };
}

/**
 * Bao cao hang hoa - bang hien toan bo, tim kiem tren UI chi loc phia client -
 * doc thang bang da tinh san, ap lai dung bo loc mã/tên dang hien thi
 * (payload.tableSearch) de file xuat khop dung phan dang xem.
 */
async function buildProductReportDataset(description, payload, signal) {
  const data = await productReportRepository.getProductReport();
  throwIfAborted(signal);
  if (!data.rows.length) throw exportError('Chưa có dữ liệu báo cáo hàng hóa để xuất.', 404, 'EXPORT_NO_DATA');

  const worksheet = description.worksheets[0];
  return applyTableSearchToDataset({
    tableKey: 'overview.productReport', title: TABLE_TITLES['overview.productReport'], selectionMode: 'custom',
    worksheets: [{ ...worksheet, rows: pickAggregateRows(data.rows, worksheet.columns) }]
  }, payload.tableSearch);
}

function formatStockoutDate(dateKey) {
  const match = String(dateKey || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

function formatStockoutPeriods(periods) {
  return (Array.isArray(periods) ? periods : [])
    .map(period => `${formatStockoutDate(period.fromDate)} -> ${formatStockoutDate(period.toDate)}`)
    .join('\n');
}

function withStockoutBranchColumn(worksheet, result) {
  if (!result || result.branch !== BRANCH_BOTH) return worksheet;
  return { ...worksheet, columns: [STOCKOUT_BRANCH_COLUMN, ...worksheet.columns] };
}

function buildRecentStockoutResultDataset(description, payload) {
  const result = payload.recentStockoutResult && typeof payload.recentStockoutResult === 'object' ? payload.recentStockoutResult : null;
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  if (rows.length === 0) throw exportError('Chưa có kết quả hàng đứt gần đây để xuất.', 400, 'EXPORT_NO_DATA');
  const dataRows = rows.map(row => ({ ...row, periods: formatStockoutPeriods(row.periods) }));
  const worksheet = withStockoutBranchColumn(description.worksheets[0], result);
  return {
    tableKey: 'stockout.recentScan',
    title: TABLE_TITLES['stockout.recentScan'],
    selectionMode: 'custom',
    worksheets: [{ ...worksheet, rows: pickAggregateRows(dataRows, worksheet.columns) }],
    // Ket qua quet duoc client gui nguyen (khong truy van lai theo branch
    // hien tai), nen ten file phai theo co so LUC QUET (result.branch), khong
    // phai co so dang chon BAY GIO — tranh lech ten file neu doi co so hoac
    // mo tab khac giua luc quet va luc bam Xuat Excel.
    sourceBranch: result && result.branch
  };
}

function buildStockout90dResultDataset(description, payload) {
  const result = payload.stockout90dResult && typeof payload.stockout90dResult === 'object' ? payload.stockout90dResult : null;
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  if (rows.length === 0) throw exportError('Chưa có kết quả kiểm tra đứt hàng 90 ngày để xuất.', 400, 'EXPORT_NO_DATA');
  const dataRows = rows.map(row => ({
    ...row,
    avgStockoutDays: row.stockoutCount ? Math.round((row.totalStockoutDays / row.stockoutCount) * 100) / 100 : 0,
    periods: formatStockoutPeriods(row.periods)
  }));
  const worksheet = withStockoutBranchColumn(description.worksheets[0], result);
  return {
    tableKey: 'stockout.check90d',
    title: TABLE_TITLES['stockout.check90d'],
    selectionMode: 'custom',
    worksheets: [{ ...worksheet, rows: pickAggregateRows(dataRows, worksheet.columns) }],
    // Xem ghi chu tuong tu o buildRecentStockoutResultDataset.
    sourceBranch: result && result.branch
  };
}

function buildStockout30dResultDataset(description, payload) {
  const result = payload.stockout30dResult && typeof payload.stockout30dResult === 'object' ? payload.stockout30dResult : null;
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  if (rows.length === 0) throw exportError('Chưa có kết quả kiểm tra đứt hàng 30 ngày để xuất.', 400, 'EXPORT_NO_DATA');
  const dataRows = rows.map(row => ({
    ...row,
    avgStockoutDays: row.stockoutCount ? Math.round((row.totalStockoutDays / row.stockoutCount) * 100) / 100 : 0,
    periods: formatStockoutPeriods(row.periods)
  }));
  const worksheet = withStockoutBranchColumn(description.worksheets[0], result);
  return {
    tableKey: 'stockout.check30d',
    title: TABLE_TITLES['stockout.check30d'],
    selectionMode: 'custom',
    worksheets: [{ ...worksheet, rows: pickAggregateRows(dataRows, worksheet.columns) }],
    // Xem ghi chu tuong tu o buildRecentStockoutResultDataset.
    sourceBranch: result && result.branch
  };
}

/**
 * Kiem tra yeu cau + tra ve dinh nghia worksheets TINH — KHONG I/O (khong goi
 * getDashboardData/readRowsByCodes/Google/DB). Bang stockout co dataset tu payload
 * (khong I/O) nen duoc dung luon de giu dung loi EXPORT_NO_DATA cu.
 * search.results co worksheets dong (phu thuoc ket qua tim kiem) -> dynamic = true.
 */
function describeExport(payload, branch) {
  const request = plainObject(payload);
  const tableKey = normalizeText(request.tableKey);
  if (!Object.prototype.hasOwnProperty.call(TABLE_TITLES, tableKey)) throw exportError('Bảng yêu cầu xuất không hợp lệ.', 400, 'EXPORT_TABLE_NOT_ALLOWED');
  const filters = normalizeFilters(request.filters);
  const context = plainObject(request.context);
  if (tableKey === 'search.results') {
    return { tableKey, title: TABLE_TITLES[tableKey], selectionMode: 'custom', dynamic: true, filters, context, worksheets: null };
  }

  const spec = getTableSpec(tableKey, context, branch);
  const description = {
    tableKey, title: TABLE_TITLES[tableKey], selectionMode: 'custom', dynamic: false,
    filters, context, worksheets: spec.worksheets, spec
  };

  if (tableKey === 'customers.productDetail') {
    if (!normalizeText(context.customerProductCustomerCode)) {
      throw exportError('Chưa chọn khách hàng để xuất.', 400, 'EXPORT_NO_CUSTOMER_SELECTED');
    }
  } else if (tableKey === 'stockout.recentScan' || tableKey === 'stockout.check90d' || tableKey === 'stockout.check30d') {
    const dataset = tableKey === 'stockout.recentScan'
      ? buildRecentStockoutResultDataset(description, request)
      : tableKey === 'stockout.check90d'
        ? buildStockout90dResultDataset(description, request)
        : buildStockout30dResultDataset(description, request);
    const filtered = applyTableSearchToDataset(dataset, request.tableSearch);
    if (filtered.worksheets.every(worksheet => worksheet.rows.length === 0)) {
      throw exportError('Không có kết quả phù hợp bộ lọc để xuất.', 404, 'EXPORT_NO_DATA');
    }
    description.dataset = filtered;
    // Cot cua bang stockout phu thuoc ket qua da quet ("Cả hai" co them cot
    // "Cơ sở") nen phai validate lua chon cot theo worksheet cua ket qua, chu
    // khong theo dinh nghia tinh trong TABLE_SPECS.
    description.worksheets = filtered.worksheets;
  }
  return description;
}

/**
 * Nap dataset day du (co dong). Bang co dinh: getDashboardData() cho danh sach ma
 * + readRowsByCodes() cho cot tho. `options.signal` huy giua chung, `options.selection`
 * (worksheetKey -> key cot) chi giu cot da chon.
 */
async function buildExportDataset(payload, branch, options = {}) {
  const request = plainObject(payload);
  const signal = options.signal;
  throwIfAborted(signal);
  const description = options.description || describeExport(request, branch);
  const { tableKey } = description;
  if (description.dynamic) return buildSearchDataset(request, description.filters, branch, signal);
  if (description.dataset) return description.dataset;
  if (tableKey === 'customers.productDetail') {
    return buildCustomerProductRevenueDataset(tableKey, description, request, branch, signal);
  }
  if (tableKey === 'overview.productReport') {
    return buildProductReportDataset(description, request, signal);
  }
  // Viewer bo trong = khong quyen sua cong no (giong xuat file truoc day). Ket qua
  // nam trong cache dung chung nen chi DOC, khong sua.
  const dashboard = await dashboardData.getDashboardData(description.filters, branch);
  throwIfAborted(signal);
  return buildFixedDataset(tableKey, { dashboard, branch, signal }, description.context, request.tableSearch, options.selection);
}

function toFieldMeta(column) {
  const meta = { key: column.key, label: column.label, type: column.type, selected: column.selected !== false };
  if (column.description) meta.description = column.description;
  return meta;
}

/**
 * Danh sach truong cho modal Xuat Excel. Bang co dinh tra ve TUC THI tu dinh nghia
 * tinh (rowCount = null, khong query). Chi search.results chay tim kiem that.
 */
async function getExportFields(payload, branch) {
  const request = plainObject(payload);
  const description = describeExport(request, branch);
  let source = description;
  let rowCountOf = () => null;
  if (description.dynamic) {
    source = await buildSearchDataset(request, description.filters, branch);
    rowCountOf = worksheet => worksheet.rows.length;
  }
  return {
    tableKey: source.tableKey,
    title: source.title,
    selectionMode: source.selectionMode,
    worksheets: source.worksheets.map(worksheet => ({
      key: worksheet.key,
      name: worksheet.name,
      rowCount: rowCountOf(worksheet),
      fields: worksheet.columns.map(toFieldMeta)
    }))
  };
}

// ---------- Ghi Excel ----------

function neutralizeFormulaText(value) {
  const text = String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function parseExcelDate(value) {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  const text = normalizeText(value);
  if (!text) return null;
  const dmy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    const [, day, month, year, hour = '0', minute = '0', second = '0'] = dmy;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (iso) {
    const [, year, month, day, hour = '0', minute = '0', second = '0'] = iso;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  }
  return null;
}

function toExcelValue(value, type) {
  if (value === undefined || value === null || value === '' || value === '—') return null;
  if (type === 'text') return neutralizeFormulaText(value);
  if (type === 'date') return parseExcelDate(value) || neutralizeFormulaText(value);
  if (type === 'number' || type === 'percent') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : neutralizeFormulaText(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return neutralizeFormulaText(value);
}

function safeWorksheetName(name, usedNames) {
  const base = normalizeText(name).replace(/[\\/*?:\[\]]/g, ' ').replace(/\s+/g, ' ').slice(0, 31) || 'Dữ liệu';
  let candidate = base;
  let suffix = 2;
  while (usedNames.has(candidate.toLocaleLowerCase('vi-VN'))) {
    const tail = ` ${suffix++}`;
    candidate = base.slice(0, 31 - tail.length) + tail;
  }
  usedNames.add(candidate.toLocaleLowerCase('vi-VN'));
  return candidate;
}

function selectedColumnsForWorksheet(selectionMode, worksheet, requestColumns) {
  if (selectionMode === 'all-only') return worksheet.columns;
  const requested = requestColumns && requestColumns[worksheet.key];
  if (!Array.isArray(requested)) {
    throw exportError(`Chưa chọn trường cho worksheet "${worksheet.name}".`, 400, 'EXPORT_FIELDS_REQUIRED');
  }
  const allowed = new Map(worksheet.columns.map(column => [column.key, column]));
  const selected = [];
  const seen = new Set();
  requested.forEach(key => {
    if (!allowed.has(key)) throw exportError(`Trường "${key}" không hợp lệ.`, 400, 'EXPORT_FIELD_NOT_ALLOWED');
    if (!seen.has(key)) {
      seen.add(key);
      selected.push(allowed.get(key));
    }
  });
  return selected;
}

/** Kiem tra danh sach cot client gui theo worksheets; tra map worksheetKey -> key cot da chon. */
function resolveSelection(selectionMode, worksheets, requestColumns) {
  const keysByWorksheet = {};
  let total = 0;
  worksheets.forEach(worksheet => {
    const columns = selectedColumnsForWorksheet(selectionMode, worksheet, requestColumns);
    keysByWorksheet[worksheet.key] = columns.map(column => column.key);
    total += columns.length;
  });
  if (total === 0) throw exportError('Vui lòng chọn ít nhất một trường để xuất.', 400, 'EXPORT_NO_FIELDS_SELECTED');
  return keysByWorksheet;
}

function columnHasFraction(rows, key) {
  return rows.some(row => {
    const raw = row[key];
    if (raw === undefined || raw === null || raw === '' || raw === '—') return false;
    const numeric = typeof raw === 'number' ? raw : Number(raw);
    return Number.isFinite(numeric) && !Number.isInteger(numeric);
  });
}

function styleWorksheet(worksheet, columns, rows) {
  worksheet.views = frozenNoGridlinesView(1);
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rows.length + 1, 1), column: columns.length }
  };
  const header = worksheet.getRow(1);
  header.height = 24;
  header.font = HEADER_FONT;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  applyFullTableBorder(worksheet, columns.length, rows.length + 1);

  columns.forEach((column, index) => {
    const excelColumn = worksheet.getColumn(index + 1);
    const values = rows.slice(0, 100).map(row => normalizeText(row[column.key]));
    const width = Math.min(42, Math.max(12, column.label.length + 2, ...values.map(value => Math.min(value.length + 2, 42))));
    excelColumn.width = width;
    // Chi hien .00 khi du lieu THUC SU co phan thap phan (vd ton kho hang can
    // theo kg) — da so cot number (so luong, don gia VND) la so nguyen, hien
    // ".00" co dinh se thua va gay kho doc.
    if (column.type === 'number') {
      excelColumn.numFmt = columnHasFraction(rows, column.key) ? '#,##0.00;[Red]-#,##0.00' : '#,##0;[Red]-#,##0';
    }
    if (column.type === 'percent') excelColumn.numFmt = '0.00%';
    if (column.type === 'date') excelColumn.numFmt = 'dd/mm/yyyy hh:mm:ss';
    excelColumn.alignment = { vertical: 'top', wrapText: column.wrapText === true };
  });
}

function fileTimestamp(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).filter(part => part.type !== 'literal')
    .reduce((object, part) => ({ ...object, [part.type]: part.value }), {});
  return `${parts.year}${parts.month}${parts.day}_${parts.hour}${parts.minute}`;
}

function fileSlug(value) {
  return normalizeText(value).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'Du_lieu';
}

function branchFilePrefix(branch) {
  if (branch === BRANCHES.HANOI) return 'HN';
  if (branch === BRANCHES.SAIGON) return 'SG';
  return 'TKS';
}

// ---------- Tang dataset dung chung (Excel + HTML) ----------

const EXPORT_FORMATS = new Set(['xlsx', 'html']);

// Ngan tran cho bao cao HTML, tinh theo O (dong x cot) vi chi phi ti le voi so o chu khong
// voi so dong: du lieu nen gzip ~8-10 lan nen 1 trieu o ~ 5-8MB file, va tab trinh duyet
// (giai nen + loc/sap xep tren mang JS) van muot tren may van phong. Bang it cot (Bao cao
// hang hoa 11 cot) ~90.000 dong; nhieu cot (Chi tiet nhap hang 24 cot) ~40.000 dong.
// Lon hon nua thi Excel (AutoFilter, khong gioi han) phu hop hon.
const HTML_MAX_CELLS = 1000000;

function normalizeExportFormat(value) {
  const format = normalizeText(value).toLowerCase() || 'xlsx';
  if (!EXPORT_FORMATS.has(format)) throw exportError('Định dạng xuất không hợp lệ.', 400, 'EXPORT_FORMAT_INVALID');
  return format;
}

/**
 * Lay + tong hop du lieu xuat, DUNG CHUNG cho moi renderer. Tra ve
 * { meta, worksheets: [{ key, name, columns, rows }] } voi columns = dung cac cot
 * da chon (theo thu tu cot nguon) — renderer chi viec ve, khong tu loc/chon cot.
 * Goi ben trong slot xuat file (xem runExport). `options.description`/`selection`
 * da validate san thi truyen vao de khong tinh lai.
 */
async function getExportDataset(payload, branch, options = {}) {
  const request = plainObject(payload);
  const signal = options.signal;
  const description = options.description || describeExport(request, branch);
  const selection = options.selection !== undefined || description.dynamic
    ? options.selection
    : resolveSelection(description.selectionMode, description.worksheets, request.columns);
  const dataset = await buildExportDataset(request, branch, { signal, description, selection });
  throwIfAborted(signal);

  const worksheets = dataset.worksheets.map(sourceWorksheet => ({
    key: sourceWorksheet.key,
    name: sourceWorksheet.name,
    columns: selectedColumnsForWorksheet(dataset.selectionMode, sourceWorksheet, request.columns),
    rows: sourceWorksheet.rows
  })).filter(worksheet => worksheet.columns.length > 0);
  if (worksheets.length === 0) {
    throw exportError('Vui lòng chọn ít nhất một trường để xuất.', 400, 'EXPORT_NO_FIELDS_SELECTED');
  }
  const fileBranch = dataset.sourceBranch || branch;
  return {
    meta: {
      tableKey: dataset.tableKey,
      title: dataset.title,
      branch: fileBranch || '',
      generatedAt: new Date(),
      fileBase: `${branchFilePrefix(fileBranch)}_${fileSlug(dataset.title)}_${fileTimestamp()}`
    },
    worksheets
  };
}

/**
 * Khung chung cua moi lan xuat: validate re (khong I/O) -> xin slot (dung chung
 * EXPORT_MAX_CONCURRENT/EXPORT_MAX_QUEUED cho MOI dinh dang) -> getExportDataset ->
 * render. Slot giu ca buoc render vi ghi workbook/HTML cung ton RAM.
 */
async function runExport(payload, branch, options, render) {
  const request = plainObject(payload);
  const signal = options && options.signal;
  throwIfAborted(signal);

  // Kiem tra re (khong I/O) TRUOC khi xin slot: yeu cau sai khong chiem hang doi va
  // khong cham DB.
  const description = describeExport(request, branch);
  const selection = description.dynamic
    ? undefined
    : resolveSelection(description.selectionMode, description.worksheets, request.columns);

  const release = await acquireExportSlot(signal);
  try {
    throwIfAborted(signal);
    const dataset = await getExportDataset(request, branch, { signal, description, selection });
    throwIfAborted(signal);
    return await render(dataset, signal);
  } finally {
    release();
  }
}

// ---------- Renderer: Excel ----------

async function renderExcelWorkbook(dataset) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.properties.date1904 = false;
  const usedNames = new Set();

  dataset.worksheets.forEach(sourceWorksheet => {
    const columns = sourceWorksheet.columns;
    const worksheet = workbook.addWorksheet(safeWorksheetName(sourceWorksheet.name, usedNames));
    worksheet.columns = columns.map(column => ({ header: column.label, key: column.key }));
    sourceWorksheet.rows.forEach(sourceRow => {
      const output = {};
      columns.forEach(column => { output[column.key] = toExcelValue(sourceRow[column.key], column.type); });
      worksheet.addRow(output);
    });
    styleWorksheet(worksheet, columns, sourceWorksheet.rows);
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, mimeType: EXCEL_MIME, fileName: `${dataset.meta.fileBase}.xlsx` };
}

/**
 * Tao file Excel. Toi da EXPORT_MAX_CONCURRENT file chay dong thoi (them EXPORT_MAX_QUEUED
 * cho trong hang doi, tran -> 503 EXPORT_BUSY). `options.signal` (AbortSignal) huy yeu cau:
 * bo qua muc dang cho + dung sau moi buoc nap du lieu (loi EXPORT_ABORTED).
 */
function createExportWorkbook(payload, branch, options = {}) {
  return runExport(payload, branch, options, renderExcelWorkbook);
}

/** Bao cao HTML tu chua (KPI + bieu do + bang loc offline); chung hang doi voi Excel. */
function createExportHtml(payload, branch, options = {}) {
  return runExport(payload, branch, options, (dataset, signal) => {
    const totalRows = dataset.worksheets.reduce((sum, worksheet) => sum + worksheet.rows.length, 0);
    const totalCells = dataset.worksheets.reduce((sum, worksheet) => sum + worksheet.rows.length * worksheet.columns.length, 0);
    if (totalCells > HTML_MAX_CELLS) {
      throw exportError(
        `Dữ liệu có ${totalRows.toLocaleString('vi-VN')} dòng (${totalCells.toLocaleString('vi-VN')} ô), vượt giới hạn ${HTML_MAX_CELLS.toLocaleString('vi-VN')} ô của báo cáo HTML. Vui lòng bỏ bớt cột, thu hẹp bộ lọc hoặc dùng Xuất Excel.`,
        413, 'EXPORT_HTML_TOO_LARGE'
      );
    }
    throwIfAborted(signal);
    return htmlReportRenderer.renderHtmlReport(dataset);
  });
}

/** Chon renderer theo `payload.format` ('xlsx' mac dinh — giu hanh vi cu khi khong gui). */
async function createExport(payload, branch, options = {}) {
  const format = normalizeExportFormat(plainObject(payload).format);
  return format === 'html' ? createExportHtml(payload, branch, options) : createExportWorkbook(payload, branch, options);
}

// Ma loi cho phep tra thong diep (tieng Viet) cho client: EXPORT_* (exportService/
// dashboardPgReader) va INVALID_BRANCH. Loi bat ngo (pg, TypeError...) khong tra detail.
const CLIENT_SAFE_ERROR_CODE = /^(EXPORT_|INVALID_BRANCH$)/;

/** Than JSON tra ve khi luong xuat Excel loi: detail chi co voi loi da biet. */
function buildExportErrorBody(err, fallbackMessage) {
  const code = err && err.code;
  return {
    error: fallbackMessage,
    detail: CLIENT_SAFE_ERROR_CODE.test(String(code || '')) ? err.message : undefined,
    code
  };
}

module.exports = {
  TABLE_TITLES,
  EXPORT_MAX_CONCURRENT,
  EXPORT_MAX_QUEUED,
  HTML_MAX_CELLS,
  getExportFields,
  getExportDataset,
  createExport,
  createExportWorkbook,
  createExportHtml,
  buildExportErrorBody,
  __test__: {
    buildFixedDataset,
    buildExportDataset,
    describeExport,
    getTableSpec,
    TABLE_SPEC_KEYS: Object.keys(TABLE_SPECS),
    inferColumnType,
    toExcelValue,
    normalizeFilters,
    limiterState: () => ({ active: activeExportCount, queued: exportWaitQueue.length })
  }
};
