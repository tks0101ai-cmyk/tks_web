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
const debtScheduleService = require('../debtSchedule/debtScheduleService');
const dashboardPgReader = require('./dashboardPgReader');
const productReportRepository = require('./productReportRepository');
const exportFieldCatalog = require('./exportFieldCatalog');
const { BRANCHES, BRANCH_BOTH, branchLabelToCode, resolveBranchScope } = require('../branch/branches');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');
const { filterTableItems } = require('../public/js/table-explorer');
const htmlReportRenderer = require('./exportHtmlReport');

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DEBT_QUEUE_FILTERS = new Set(['needsAction', 'currentDebt', 'overdue', 'all']);
// Khop thu tu cot bang Cong no tren man hinh (DEBT_SORT_FIELDS o public/index.html).
const DEBT_SORT_FIELDS = [
  'branch', 'customerName', 'sale', 'saleTeam', 'paymentSchedule', 'currentDebt', 'overdueDebt',
  'inScheduleDebt', 'currentDebtToSalesRatio', 'overdueToSalesRatio', 'automaticAlert', 'overdueStreak',
  'previousPenaltyAmount', 'penaltyAmount', 'saleFeedback', 'managerFeedback', 'workflowStatus'
];

// Khop thu tu cot bang Tuoi no theo hoa don (DEBT_AGING_SORT_FIELDS o public/index.html).
const DEBT_AGING_SORT_FIELDS = [
  'branch', 'customerName', 'sale', 'saleTeam', 'paymentSchedule', 'currentDebt', 'overdueDebt',
  'payoffDay', 'equivalentDays', 'remainingDays'
];

// Gioi han tai: moi file Excel nap du lieu + ghi workbook trong RAM.
const EXPORT_MAX_CONCURRENT = 2;
const EXPORT_MAX_QUEUED = 8;
const EXPORT_BUSY_MESSAGE = 'Hệ thống đang xử lý nhiều yêu cầu xuất file, vui lòng thử lại sau ít giây.';

const TABLE_TITLES = Object.freeze({
  'overview.transactions': 'Chi tiết giao dịch',
  'customers.productDetail': 'Bảng chi tiết sản phẩm theo khách',
  'overview.productReport': 'Báo cáo hàng hóa',
  'debt.management': 'Quản lý công nợ',
  'debt.penalty': 'Thưởng/phạt sale theo công nợ',
  'debt.aging': 'Tuổi nợ theo hóa đơn',
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
  // (Bo loc `overview` da bo 2026-10-05 — getDashboardData khong con dung; client chua bao gio gui.)
  // (2026-10-16: tab Hang hoa cu da go nen khong con bo loc `products` / `newProducts` / `newlyImported`.)
  return { invoices: normalizeFilterSpec(raw.invoices) };
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
    selected: options.selected !== false,
    // Cot so tu to mau theo dau (am do, 0 vang, duong xanh la) o ca Excel va HTML.
    ...(options.signTone === true ? { signTone: true } : {})
  };
}

// Cot cua cac bang tong hop/nguon dong — dung chung cho buoc lay truong va buoc tao file.
const DEBT_COLUMNS = [
  aggregateColumn('customerName', 'Khách hàng', 'text', 'Tên khách hàng trên KiotViet.'),
  aggregateColumn('sale', 'Nhân viên phụ trách (Sale)', 'text', 'Nhóm khách hàng của khách trên KiotViet.'),
  aggregateColumn('saleTeam', 'Nhóm sale', 'text', 'Nhóm hiện tại dùng chung với tab Khách hàng.'),
  aggregateColumn('paymentSchedule', 'Lịch thanh toán', 'number', 'Số ngày nợ tối đa của khách tại cơ sở này; chưa đặt thì tính 1 ngày.'),
  aggregateColumn('currentDebt', 'Nợ hiện tại', 'number', 'Nợ của khách tại bản chốt 15:00 gần nhất (VNĐ).'),
  aggregateColumn('inScheduleDebt', 'Doanh số trong kỳ', 'number', 'Doanh số trong lịch thanh toán = tổng hóa đơn hoàn thành trong số ngày của lịch (không trừ trả hàng) (VNĐ).'),
  aggregateColumn('overdueDebt', 'Nợ quá hạn', 'number', 'Nợ hiện tại trừ tổng hóa đơn hoàn thành trong số ngày của lịch thanh toán (không trừ trả hàng), không âm (VNĐ).'),
  aggregateColumn('currentDebtToSalesRatio', 'Tỷ lệ nợ hiện tại trên doanh số', 'percent',
    'Nợ hiện tại chia cho doanh số trung bình 4 tháng (tab Khách hàng).'),
  aggregateColumn('overdueToSalesRatio', 'Nợ quá hạn trên doanh số trung bình', 'percent',
    'Nợ quá hạn chia cho doanh số trung bình 4 tháng (tab Khách hàng).'),
  aggregateColumn('automaticAlert', 'Cảnh báo tự động', 'text',
    'Quá hạn khi nợ quá hạn lớn hơn 0 đồng.', { wrapText: true }),
  aggregateColumn('overdueStreak', 'Số phiên liên tiếp', 'number',
    'Số phiên chốt 15:00 liên tiếp khách có nợ quá hạn từ 400.000đ; về 0 khi hết nợ chậm.'),
  aggregateColumn('previousPenaltyAmount', 'Tiền phạt phiên trước', 'number',
    'Tiền phạt của phiên chốt 15:00 liền trước (số Quản lý đã điền hoặc mức gợi ý); để trống nếu khách chưa có ở phiên trước.'),
  aggregateColumn('penaltyAmount', 'Tiền phạt phiên này', 'number',
    'Tiền phạt nợ quá hạn của phiên: mức gợi ý theo quy chế (nợ lẻ 25.000đ, nợ chậm theo số phiên liên tiếp) hoặc số Quản lý đã điền (VNĐ).'),
  aggregateColumn('saleFeedback', 'Sale phản hồi', 'text', 'Phản hồi của Sale trong chu kỳ chốt hiện tại.', { wrapText: true }),
  aggregateColumn('managerFeedback', 'QL phản hồi', 'text', 'Phản hồi của Quản lý trong chu kỳ chốt hiện tại.', { wrapText: true }),
  aggregateColumn('workflowStatus', 'Trạng thái xử lý', 'text', 'Trạng thái xử lý công nợ trong chu kỳ chốt hiện tại.'),
  aggregateColumn('updatedBy', 'Người cập nhật', 'text', 'Người cập nhật trạng thái xử lý gần nhất.', { selected: false }),
  aggregateColumn('updatedAt', 'Cập nhật lúc', 'date', 'Thời điểm cập nhật trạng thái xử lý gần nhất.', { selected: false })
];

// Bang xep hang phat sale (khung Chi so then chot, tab Cong no) — khop cot man hinh.
const DEBT_PENALTY_COLUMNS = [
  aggregateColumn('rank', 'Hạng', 'number', 'Thứ hạng thưởng toàn hệ thống Hà Nội + Sài Gòn theo phạt/điểm; Sale không có điểm không xếp hạng.'),
  aggregateColumn('sale', 'Sale', 'text', 'Nhân viên phụ trách (nhóm khách hàng trên KiotViet).'),
  aggregateColumn('saleTeam', 'Nhóm sale', 'text', 'Nhóm hiện tại dùng chung với tab Khách hàng.'),
  aggregateColumn('points', 'Điểm', 'number', 'Điểm công nợ của Sale trong tháng theo quy chế thưởng.'),
  aggregateColumn('ratio', 'Phạt/điểm', 'number', 'Phạt gốc chia cho điểm; để trống khi không có điểm.'),
  aggregateColumn('penaltyDays', 'Ngày bị phạt', 'number', 'Số ngày trong tháng (từ ngày 01) Sale có tiền phạt công nợ.'),
  aggregateColumn('lastDayCustomers', 'Khách phạt gần nhất', 'number', 'Số khách bị phạt của ngày chốt gần nhất.'),
  aggregateColumn('total', 'Phạt gốc', 'number', 'Tổng phạt gốc trong tháng trước miễn phạt theo hạng (VNĐ).'),
  aggregateColumn('payablePenalty', 'Phạt phải nộp', 'number', 'Số tiền phạt phải nộp sau miễn phạt theo hạng (VNĐ).'),
  aggregateColumn('reward', 'Tiền thưởng', 'number', 'Tổng thưởng theo hạng và theo điểm (VNĐ); tạm tính trong tháng, chính thức khi chốt tháng.'),
  aggregateColumn('month', 'Tháng', 'text', 'Tháng thưởng/phạt được chọn (YYYY-MM).'),
  aggregateColumn('status', 'Trạng thái', 'text', 'Thưởng tạm tính khi tháng đang mở; Đã chốt khi đã khóa kết quả tháng.'),
  aggregateColumn('rankReward', 'Thưởng theo hạng', 'number', 'Phần thưởng theo thứ hạng toàn hệ thống (VNĐ); tạm tính trong tháng, chính thức khi chốt tháng.', { selected: false }),
  aggregateColumn('pointsReward', 'Thưởng theo điểm', 'number', 'Phần thưởng phân bổ theo điểm (VNĐ); tạm tính trong tháng, chính thức khi chốt tháng.', { selected: false })
];

// Bang Tuoi no theo hoa don (muc 3 tab Cong no) — so song, khop cot man hinh.
const DEBT_AGING_COLUMNS = [
  aggregateColumn('branch', 'Cơ sở', 'text', 'Cơ sở của khoản công nợ (Hà Nội hoặc Sài Gòn).'),
  aggregateColumn('customerName', 'Khách hàng', 'text', 'Tên khách hàng trên KiotViet.'),
  aggregateColumn('sale', 'Sale', 'text', 'Nhóm khách hàng của khách trên KiotViet.'),
  aggregateColumn('saleTeam', 'Nhóm sale', 'text', 'Nhóm hiện tại dùng chung với tab Khách hàng.'),
  aggregateColumn('paymentSchedule', 'Lịch thanh toán', 'number', 'Số ngày nợ tối đa của khách tại cơ sở này; chưa đặt thì tính 1 ngày.'),
  aggregateColumn('currentDebt', 'Nợ hiện tại', 'number', 'Nợ của khách theo lần đồng bộ KiotViet mới nhất (VNĐ).'),
  aggregateColumn('overdueDebt', 'Nợ quá hạn', 'number', 'Nợ hiện tại trừ tổng hóa đơn hoàn thành trong số ngày của lịch thanh toán tính tới hôm nay (không trừ trả hàng), không âm (VNĐ).'),
  aggregateColumn('payoffDay', 'Ngày hết nợ', 'text', 'Trừ dần nợ hiện tại bằng hóa đơn hoàn thành từ hôm nay lùi về; ngày làm nợ còn lại ≤ 0. "Trước …" = trừ hết 365 ngày hóa đơn vẫn còn nợ.'),
  aggregateColumn('equivalentDays', 'Ngày nợ tương đương', 'number', 'Hôm nay trừ ngày hết nợ cộng 1 (ngày, tính cả ngày hết nợ); để trống khi không còn nợ.'),
  aggregateColumn('remainingDays', 'Còn hạn', 'number', 'Lịch thanh toán trừ ngày nợ tương đương (ngày); dương (xanh lá) là còn hạn, 0 (vàng) là chạm lịch, âm (đỏ) là quá lịch thanh toán.', { signTone: true })
];

const DEBT_BRANCH_COLUMN = aggregateColumn('branch', 'Cơ sở', 'text', 'Cơ sở của khoản công nợ (Hà Nội hoặc Sài Gòn).');

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
// 35 cot, THU TU = thu tu sheet BC CHUNG va = thu tu cot bang "Bao cao hang hoa" tren man hinh (thead trong public/index.html);
// doi thu tu o day phai doi thead + productReportRowHtml + PRODUCT_REPORT_WIDTHS_BY_PROFILE. Cot "ngay" khai bao type tuong minh
// (nhan co chu "ngay" se bi inferColumnType suy ra thanh cot ngay thang). Tang truong la phan so (0,25 = 25%), kieu 'percent'.
const PRODUCT_REPORT_COLUMNS = [
  aggregateColumn('code', 'Mã sản phẩm', 'text', 'Mã sản phẩm.'),
  aggregateColumn('name', 'Tên sản phẩm', undefined, 'Tên sản phẩm.'),
  aggregateColumn('loadedQty', 'Đã bốc', 'number', 'Tổng số lượng toàn công ty trong CONT trạng thái 3; trống khi chưa có dữ liệu.'),
  aggregateColumn('unloadedQty', 'Chưa bốc', 'number', 'Tổng số lượng toàn công ty trong CONT trạng thái 1 hoặc 2; trống khi chưa có dữ liệu.'),
  aggregateColumn('availableValueHanoi', 'Giá trị có bán Hà Nội', 'number',
    'Có bán Hà Nội nhân đơn giá Hà Nội (VNĐ); trống khi thiếu một trong hai số. Chỉ Quản lý và Trợ lý được xuất.'),
  aggregateColumn('qtySold30dHanoi', 'Số lượng bán 30 ngày Hà Nội', 'number', 'Tổng số lượng bán ra tại Hà Nội trong 30 ngày gần nhất (tính đến hết hôm qua); trống khi báo cáo chưa được tính lại.'),
  aggregateColumn('stockHanoi', 'Tồn thực Hà Nội', 'number', 'Tồn kho hiện tại tại cơ sở Hà Nội.'),
  aggregateColumn('availableHanoi', 'Có bán Hà Nội', 'number', 'Tồn thực Hà Nội trừ số lượng khách đặt phiếu tạm tại Hà Nội; trống khi báo cáo chưa được tính lại.'),
  aggregateColumn('transferRequest', 'Yêu cầu điều chuyển', 'number',
    'Tổng số lượng trong các đơn đặt hàng Phiếu tạm của khách Điều chuyển Sài Gòn tại Kiot Hà Nội (mọi thời gian), cộng vào tổng tồn thực và tổng có bán của báo cáo này.'),
  aggregateColumn('inTransit', 'Điều chuyển SG', 'number', 'Số lượng đặt hàng nhập Đã xác nhận nhà cung cấp tại Kiot Sài Gòn, cộng vào tồn có thể bán của báo cáo này.'),
  aggregateColumn('stockSaigon', 'Tồn thực Sài Gòn', 'number', 'Tồn kho hiện tại tại cơ sở Sài Gòn.'),
  aggregateColumn('availableSaigon', 'Có bán Sài Gòn', 'number', 'Tồn thực Sài Gòn trừ số lượng khách đặt phiếu tạm tại Sài Gòn; trống khi báo cáo chưa được tính lại.'),
  aggregateColumn('qtySold30dSaigon', 'Số lượng bán 30 ngày Sài Gòn', 'number', 'Tổng số lượng bán ra tại Sài Gòn trong 30 ngày gần nhất (tính đến hết hôm qua); trống khi báo cáo chưa được tính lại.'),
  aggregateColumn('availableValueSaigon', 'Giá trị có bán Sài Gòn', 'number',
    'Có bán Sài Gòn nhân đơn giá Sài Gòn (VNĐ); trống khi thiếu một trong hai số. Chỉ Quản lý và Trợ lý được xuất.'),
  aggregateColumn('totalStock', 'Tổng tồn thực và điều chuyển', 'number', 'Tồn thực Hà Nội cộng tồn thực Sài Gòn cộng yêu cầu điều chuyển cộng điều chuyển Sài Gòn.'),
  aggregateColumn('availableToSell', 'Tổng có bán và điều chuyển', 'number',
    'Có bán Hà Nội cộng có bán Sài Gòn cộng yêu cầu điều chuyển cộng điều chuyển Sài Gòn; có bán từng cơ sở đã trừ khách đặt phiếu tạm.'),
  aggregateColumn('qtySold30d', 'Số lượng bán 30 ngày', 'number', 'Tổng số lượng bán ra trong 30 ngày gần nhất (tính đến hết hôm qua).'),
  aggregateColumn('stockoutDaysHanoi', 'Số ngày đứt hàng Hà Nội', 'number',
    'Tổng số ngày đứt hàng tại Hà Nội trong 30 ngày gần nhất theo lần quét đứt hàng 30 ngày gần nhất; bằng 0 khi không đứt hoặc chưa quét.'),
  aggregateColumn('stockoutDaysSaigon', 'Số ngày đứt hàng Sài Gòn', 'number',
    'Tổng số ngày đứt hàng tại Sài Gòn trong 30 ngày gần nhất theo lần quét đứt hàng 30 ngày gần nhất; bằng 0 khi không đứt hoặc chưa quét.'),
  aggregateColumn('daysToOrder', 'Ngày cần đặt', 'number',
    '(Tổng có bán và điều chuyển + Chưa bốc + Đã bốc) chia số lượng bán 30 ngày, nhân 30; trống khi không có số lượng bán hoặc chưa có dữ liệu CONT.'),
  aggregateColumn('daysSaigonTransit', 'Ngày bán hết Sài Gòn và điều chuyển', 'number',
    '(Điều chuyển Sài Gòn + Có bán Sài Gòn) chia số lượng bán 30 ngày Sài Gòn, nhân 30; trống khi Sài Gòn không bán được trong 30 ngày.'),
  aggregateColumn('daysHanoi', 'Ngày bán hết Hà Nội', 'number',
    'Có bán Hà Nội chia số lượng bán 30 ngày Hà Nội, nhân 30; trống khi Hà Nội không bán được trong 30 ngày.'),
  aggregateColumn('daysBothBranches', 'Ngày bán hết hai miền', 'number',
    'Tổng có bán và điều chuyển chia số lượng bán 30 ngày của cả hai cơ sở, nhân 30; trống khi không bán được trong 30 ngày.'),
  aggregateColumn('revenue90d', 'Doanh số 90 ngày', 'number', 'Doanh số trong 90 ngày gần nhất (tính đến hết hôm qua, đơn vị tiền Việt Nam).'),
  aggregateColumn('customerCount90d', 'Số lượng khách mua', 'number', 'Số khách hàng khác nhau đã mua mã này trong 90 ngày.'),
  aggregateColumn('orders90d', 'Số lượng đơn 90 ngày', 'number', 'Số đơn hàng có chứa mã này trong 90 ngày gần nhất; trống khi báo cáo chưa được tính lại.'),
  aggregateColumn('orders30d', 'Số lượng đơn 30 ngày', 'number', 'Số đơn hàng có chứa mã này trong 30 ngày gần nhất; trống khi báo cáo chưa được tính lại.'),
  aggregateColumn('ordersGrowth', 'Tăng trưởng', 'percent',
    'Số đơn 30 ngày nhân 3 chia số đơn 90 ngày rồi trừ 1 (so tốc độ đơn 30 ngày với mức trung bình của 90 ngày); trống khi chưa có đơn nào trong 90 ngày.'),
  aggregateColumn('topCustomerRevenue90d', 'Doanh số khách lớn nhất', 'number', 'Doanh số của khách mua nhiều nhất trong 90 ngày.'),
  aggregateColumn('topCustomerName', 'Khách lớn nhất', 'text', 'Tên khách hàng mua nhiều nhất trong 90 ngày.'),
  aggregateColumn('topCustomerShare', 'Tỉ trọng khách lớn nhất', 'percent', 'Doanh số khách lớn nhất chia cho doanh số 90 ngày.'),
  aggregateColumn('priceHanoi', 'Đơn giá Hà Nội', 'number', 'Giá vốn của mã hàng trên KiotViet Hà Nội (VNĐ); trống khi chưa có giá. Chỉ Quản lý và Trợ lý được xuất.'),
  aggregateColumn('priceSaigon', 'Đơn giá Sài Gòn', 'number', 'Giá vốn của mã hàng trên KiotViet Sài Gòn (VNĐ); trống khi Sài Gòn không có mã này hoặc chưa có giá. Chỉ Quản lý và Trợ lý được xuất.'),
  aggregateColumn('descriptionHanoi', 'Mô tả Hà Nội', 'text', 'Mô tả sản phẩm trên KiotViet của cơ sở Hà Nội (thường ghi bảng giá cho nhân viên bán hàng tra cứu).', { wrapText: true }),
  aggregateColumn('descriptionSaigon', 'Mô tả Sài Gòn', 'text', 'Mô tả sản phẩm trên KiotViet của cơ sở Sài Gòn (thường ghi bảng giá cho nhân viên bán hàng tra cứu).', { wrapText: true })
];

// Cot nhay cam (Don gia + Gia tri co ban HN/SG) chi Quan ly/Tro ly (reports.products.price) duoc xuat. Hang so DUNG CHUNG voi routes.js
// (GET /api/product-report), dinh nghia o productReportRepository.js.
const PRODUCT_REPORT_PRICE_KEYS = productReportRepository.PRODUCT_REPORT_PRICE_KEYS;
const PRODUCT_REPORT_SALES_KEYS = productReportRepository.PRODUCT_REPORT_SALES_KEYS;

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
  // (san pham khong gop nua — chi khach/NCC; xem ENTITY_MERGE_SPECS trong dashboardData.js)
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
  if (perBranch === 'customer') {
    // Khach gop theo TEN: moi co so doc cac ma khach cua chinh no (item.codesByBranch),
    // gop dong tho theo ten (giong man hinh) roi ghep lai theo ten.
    const groups = await Promise.all(scope.map(async physicalBranch => ({
      branch: physicalBranch,
      rows: await readSourceRows(
        source,
        { ...env, branch: physicalBranch },
        items.map(item => (item.codesByBranch || {})[physicalBranch]).filter(Boolean)
      )
    })));
    const byKey = rowsByCode(mergeEntitySourceRows(source, groups), 'ten_khach_hang');
    return { byKey, keyOf: item => normalizeCode(item.name) };
  }
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


/** Bang 1 worksheet: cac dong logic (ma) ghep voi dong tho cua 1 nguon catalogue. */
function singleSourceTable(options) {
  // branchColumn: true => "Ca hai" ghep dong tho theo (co so, ma) (chung tu/hang hoa cung ma o ca
  // hai co so la hai dong rieng); 'customer' => khach gop theo ten (xem loadSourceRowsForItems).
  const { key, name, sourceKey, derived = [], items, branchColumn = false, derivedValues, summaryKeys } = options;
  const source = exportFieldCatalog.getSource(sourceKey);
  const worksheet = {
    key,
    name,
    codeKey: source.codeKey,
    columns: sourceColumns(sourceKey).concat(
      derived.map(def => derivedColumn(def.key, def.label, def.type, def.description))
    )
  };
  // Cot so lam KPI/bieu do chinh cua bao cao HTML (xem exportHtmlReport.planFor).
  if (summaryKeys) worksheet.summaryKeys = summaryKeys;
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
  if (options.summaryKeys) worksheet.summaryKeys = options.summaryKeys;
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

function normalizeDebtSearch(value) {
  return normalizeText(value).normalize('NFC').replace(/\s+/g, ' ').toLocaleLowerCase('vi-VN');
}

// Gom mọi giá trị lồng nhau của dòng gốc thành một chuỗi — giống tableSearchText trên màn hình.
function rawItemSearchText(item) {
  const values = [];
  (function collect(value) {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) { value.forEach(collect); return; }
    if (typeof value === 'object') { Object.keys(value).forEach(key => collect(value[key])); return; }
    values.push(String(value));
  })(item);
  return values.join(' ');
}

// Tìm gần đúng trên dòng gốc (không phải cột xuất) để file khớp đúng các dòng màn hình công nợ đang hiện.
function searchRawItems(items, query) {
  if (!normalizeText(query)) return items;
  return filterTableItems(items, { searchText: rawItemSearchText }, { mode: 'normal', query: String(query) }).items;
}

function debtAutomaticAlert(customer) {
  return (customer.alertCodes || []).includes('overdue') ? 'Quá hạn' : '';
}

function sortDebtManagementRows(rows, sort, fieldOverride) {
  const columnIndex = Number(sort && sort.columnIndex);
  const direction = sort && sort.direction;
  const field = fieldOverride || (Number.isInteger(columnIndex) ? DEBT_SORT_FIELDS[columnIndex] : '');
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

// Cot "Cơ sở": khach gop hai co so liet ke tung co so (branchDetails), khong thi co so cua chinh dong.
function debtBranchLabel(customer) {
  const details = Array.isArray(customer.branchDetails) ? customer.branchDetails : [];
  const labels = details.map(detail => normalizeText(detail.branch)).filter(Boolean);
  return labels.join(', ');
}

function debtRewardStatusLabel(status) {
  return status === 'finalized' ? 'Đã chốt' : 'Thưởng tạm tính';
}

function debtPenaltyRows(board, context = {}) {
  return board.rows.filter(row => !context.debtPenaltyTeam || (row.saleTeam || 'Chưa có team') === context.debtPenaltyTeam).map(row => ({
    saleTeam: row.saleTeam || 'Chưa có team',
    ...row, ratio: row.ratio === null || row.ratio === undefined ? null : Math.round(row.ratio),
    month: board.month, status: debtRewardStatusLabel(board.status)
  }));
}

function debtRewardMetadata(board) {
  const amount = value => `${Number(value).toLocaleString('en-US')}đ`;
  const coverage = board.coverage;
  const summary = board.summary;
  const notes = [
    ['Tháng', board.month],
    ['Trạng thái', debtRewardStatusLabel(board.status)],
    ['Phạm vi xếp hạng', 'Hà Nội + Sài Gòn'],
    ['Tổng phạt gốc toàn hệ thống', amount(summary.grossPenalty)],
    ['Tổng phạt phải nộp toàn hệ thống', amount(summary.payablePenalty)],
    ['Quỹ thưởng toàn hệ thống', amount(summary.pool)],
    ['Quỹ từ tiền phạt', amount(summary.penaltyFund)],
    ['Công ty bù', amount(summary.companyTopUp)],
    [board.status === 'finalized' ? 'Thưởng đã phân bổ' : 'Tổng thưởng tạm tính', amount(summary.allocatedReward)],
    ['Số Sale nhận thưởng toàn hệ thống', String(summary.recipientCount)],
    ['Phạm vi dữ liệu', `${coverage.from} – ${coverage.to}`],
    ['Đủ bản chốt', coverage.complete ? 'Đầy đủ' : 'Chưa đầy đủ'],
    ['Ngày thiếu bản chốt', coverage.missingDays.length ? coverage.missingDays.join(', ') : 'Không có'],
    ['Phiên bản quy chế', String(board.ruleVersion)]
  ];
  if (board.status !== 'finalized') notes.push(['Tiền thưởng', 'Thưởng tạm tính, sẽ chốt chính thức vào cuối tháng']);
  if (board.closedAt) notes.push(['Chốt tháng lúc', board.closedAt]);
  return {
    month: board.month, status: board.status, closedAt: board.closedAt,
    ruleVersion: board.ruleVersion, summary, coverage, notes
  };
}

function debtManagementRows(debtManagement, context, aggregate = false) {
  const debt = debtManagement && typeof debtManagement === 'object' ? debtManagement : {};
  const queue = DEBT_QUEUE_FILTERS.has(context.debtQueue) ? context.debtQueue : 'needsAction';
  const sale = normalizeText(context.debtSale);
  const schedule = normalizeText(context.debtSchedule);
  // Loc va sap xep LUON tren hang cua man hinh (o "Ca hai" la hang da gop theo khach), giong duong
  // co so vat ly; chi sau do moi tach thanh cac dong theo co so de xuat.
  const customers = Array.isArray(debt.customers) ? debt.customers : [];
  const candidates = customers.filter(customer => {
    if (queue === 'needsAction' && !customer.needsAction) return false;
    if (queue === 'currentDebt' && !(Number(customer.currentDebt) > 0)) return false;
    if (queue === 'overdue' && !(Number(customer.overdueDebt) > 0)) return false;
    if (context.debtTeam && (customer.saleTeam || 'Chưa có team') !== context.debtTeam) return false;
    if (sale && customer.sale !== sale) return false;
    if (schedule && customer.paymentSchedule !== schedule) return false;
    return true;
  });
  const retained = searchRawItems(candidates, context.debtSearch);
  const toRow = customer => ({
    customerName: customer.customerName,
    branch: normalizeText(customer.branch) || debtBranchLabel(customer),
    sale: customer.sale,
    saleTeam: customer.saleTeam || 'Chưa có team',
    paymentSchedule: Number(customer.paymentSchedule) || null,
    currentDebt: customer.currentDebt,
    inScheduleDebt: customer.inScheduleDebt,
    overdueDebt: customer.overdueDebt,
    currentDebtToSalesRatio: customer.currentDebtToSalesRatio,
    overdueToSalesRatio: customer.overdueToSalesRatio,
    automaticAlert: debtAutomaticAlert(customer),
    overdueStreak: Number(customer.overdueStreak) || 0,
    previousPenaltyAmount: customer.previousPenaltyAmount === null || customer.previousPenaltyAmount === undefined ? null : Number(customer.previousPenaltyAmount),
    penaltyAmount: Number(customer.penaltyAmount) || 0,
    saleFeedback: customer.saleFeedback || '',
    managerFeedback: customer.managerFeedback || '',
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

function formatDayKey(day) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}` : '';
}

// Bang Tuoi no: ap lai bo loc Sale / Lich TT / Tim + sap xep cua man hinh (context.debtAging*).
function debtAgingRows(debtAging, context) {
  const customers = Array.isArray(debtAging && debtAging.customers) ? debtAging.customers : [];
  const sale = normalizeText(context.debtAgingSale);
  const schedule = normalizeText(context.debtAgingSchedule);
  const candidates = customers.filter(customer => {
    if (context.debtAgingTeam && (customer.saleTeam || 'Chưa có team') !== context.debtAgingTeam) return false;
    if (sale && customer.sale !== sale) return false;
    if (schedule && customer.paymentSchedule !== schedule) return false;
    return true;
  });
  const rows = searchRawItems(candidates, context.debtAgingSearch).map(customer => ({
    branch: customer.branch,
    customerName: customer.customerName,
    sale: customer.sale,
    saleTeam: customer.saleTeam || 'Chưa có team',
    paymentSchedule: Number(customer.paymentSchedule) || null,
    currentDebt: customer.currentDebt,
    overdueDebt: customer.overdueDebt,
    payoffDay: customer.payoffDay ? `${customer.beyondHistory ? 'Trước ' : ''}${formatDayKey(customer.payoffDay)}` : '',
    payoffDayKey: customer.payoffDay || '',
    equivalentDays: customer.equivalentDays,
    remainingDays: customer.remainingDays
  }));
  const sort = context.debtAgingSort;
  const field = DEBT_AGING_SORT_FIELDS[Number(sort && sort.columnIndex)];
  // Ngay het no sap theo khoa YYYY-MM-DD, khong theo chuoi dd/mm hien thi.
  const sortField = field === 'payoffDay' ? 'payoffDayKey' : field;
  return sortField ? sortDebtManagementRows(rows, sort, sortField) : rows;
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
  'debt.management': (context, scope) => aggregateTable({
    key: 'debt_management', name: 'Quản lý công nợ',
    columns: [DEBT_COLUMNS[0], DEBT_BRANCH_COLUMN, ...DEBT_COLUMNS.slice(1)],
    rows: dashboard => debtManagementRows(dashboard.debtManagement, context, scope.aggregate)
  }),
  'debt.penalty': context => aggregateTable({
    key: 'debt_penalty', name: 'Thưởng phạt sale', columns: DEBT_PENALTY_COLUMNS,
    rows: dashboard => debtPenaltyRows(dashboard.debtReward, context),
    summaryKeys: ['total', 'payablePenalty', 'reward']
  }),
  'debt.aging': context => aggregateTable({
    key: 'debt_aging', name: 'Tuổi nợ theo hóa đơn', columns: DEBT_AGING_COLUMNS,
    rows: dashboard => debtAgingRows(dashboard.debtAging, context)
  }),
  // Cac bang duoi day khong co loadRows: nguon du lieu rieng (bao cao khach/hang, payload quet ton).
  'customers.productDetail': () => ({
    worksheets: [reportWorksheet('customer_product_detail', 'Bảng chi tiết sản phẩm', CUSTOMER_PRODUCT_DETAIL_COLUMNS)]
  }),
  'overview.productReport': () => ({
    // summaryKeys cố định 3 chỉ số KPI/biểu đồ của báo cáo HTML như trước khi thêm cột theo cơ sở (nếu không, "Số lượng bán 30 ngày Hà Nội"
    // đứng trước "Số lượng bán 30 ngày" và chiếm KPI thứ ba).
    worksheets: [{ ...reportWorksheet('product_report', 'Báo cáo hàng hóa', PRODUCT_REPORT_COLUMNS), summaryKeys: ['revenue90d', 'topCustomerRevenue90d', 'qtySold30d'] }]
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

// Bảng mà ô tìm kiếm trên màn hình chỉ so khớp một số trường (bảng Thưởng/phạt chỉ tìm theo Sale).
const WORKSHEET_SEARCH_KEYS = { debt_penalty: ['sale'] };

function filterWorksheetRows(worksheet, tableSearch) {
  if (!hasTableSearch(tableSearch)) return worksheet;
  const codeKey = worksheet.codeKey;
  const searchKeys = WORKSHEET_SEARCH_KEYS[worksheet.key];
  const columns = (worksheet.columns || []).filter(column => !searchKeys || searchKeys.includes(column.key));
  const filtered = filterTableItems(worksheet.rows || [], {
    searchText: row => columns.map(column => row[column.key]).join(' '),
    code: codeKey ? row => row[codeKey] : undefined
  }, tableSearch);
  return { ...worksheet, rows: filtered.items };
}

// Sắp xếp theo cột đang bấm trên màn hình: client gửi nhãn cột (tiêu đề <th>) + chiều, khớp với nhãn cột xuất.
// Không tìm thấy cột khớp thì giữ nguyên thứ tự (không bao giờ làm hỏng file).
function normalizeSortLabel(value) {
  return normalizeText(value).normalize('NFC').toLocaleLowerCase('vi-VN').replace(/\s+/g, ' ');
}

function normalizeTableSort(tableSort) {
  const raw = plainObject(tableSort);
  const label = normalizeSortLabel(raw.label);
  if (!label) return null;
  return { label, direction: raw.direction === 'desc' ? 'desc' : 'asc' };
}

function sortWorksheetRows(worksheet, tableSort) {
  const sort = normalizeTableSort(tableSort);
  if (!sort) return worksheet;
  const column = (worksheet.columns || []).find(item => normalizeSortLabel(item.label) === sort.label);
  if (!column) return worksheet;
  const entries = (worksheet.rows || []).map((row, index) => {
    const value = row[column.key];
    const text = normalizeText(value);
    const number = text !== '' && typeof value !== 'boolean' && Number.isFinite(Number(value)) ? Number(value) : null;
    return { row, index, text, number, empty: text === '' };
  });
  entries.sort((a, b) => {
    if (a.empty !== b.empty) return a.empty ? 1 : -1;
    const comparison = a.number !== null && b.number !== null
      ? a.number - b.number
      : a.text.localeCompare(b.text, 'vi', { numeric: true, sensitivity: 'base' });
    if (comparison === 0) return a.index - b.index;
    return sort.direction === 'asc' ? comparison : -comparison;
  });
  return { ...worksheet, rows: entries.map(entry => entry.row) };
}

function applyTableSearchToWorksheets(worksheets, tableSearch, tableSort) {
  const filtered = hasTableSearch(tableSearch)
    ? worksheets.map(worksheet => filterWorksheetRows(worksheet, tableSearch))
    : worksheets;
  return normalizeTableSort(tableSort) ? filtered.map(worksheet => sortWorksheetRows(worksheet, tableSort)) : filtered;
}

function applyTableSearchToDataset(dataset, tableSearch, tableSort) {
  if (!dataset || (!hasTableSearch(tableSearch) && !normalizeTableSort(tableSort))) return dataset;
  return {
    ...dataset,
    worksheets: applyTableSearchToWorksheets(dataset.worksheets || [], tableSearch, tableSort)
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
async function buildFixedDataset(tableKey, env, context, tableSearch = {}, selection, tableSort) {
  const spec = getTableSpec(tableKey, context, env.branch);
  if (typeof spec.loadRows !== 'function') {
    throw exportError('Bảng yêu cầu xuất không hợp lệ.', 400, 'EXPORT_TABLE_NOT_ALLOWED');
  }
  // Sắp xếp theo nhãn cột cũng cần đủ cột của worksheet như tìm kiếm.
  const searching = hasTableSearch(tableSearch) || !!normalizeTableSort(tableSort);
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
    ...(worksheet.summaryKeys ? { summaryKeys: worksheet.summaryKeys } : {}),
    rows: (loaded[index] && loaded[index].rows) || []
  }));
  worksheets = applyTableSearchToWorksheets(worksheets, tableSearch, tableSort);
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
  return applyTableSearchToDataset({
    tableKey, title: TABLE_TITLES[tableKey], selectionMode: 'custom',
    worksheets: [{ ...worksheet, rows: pickAggregateRows(products, worksheet.columns) }]
  }, null, payload.tableSort);
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
    reportNotes: productContainerExportNotes(data.containerSync),
    worksheets: [{ ...worksheet, rows: pickAggregateRows(data.rows, worksheet.columns) }]
  }, payload.tableSearch, payload.tableSort);
}

function productContainerExportNotes(sync) {
  const available = Boolean(sync && sync.available);
  const timestamp = sync && sync.lastSuccessAt ? new Date(sync.lastSuccessAt) : null;
  const updatedAt = timestamp && Number.isFinite(timestamp.getTime())
    ? new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    }).format(timestamp) : '—';
  const status = !available ? 'Dữ liệu chưa sẵn sàng; số lượng để trống.'
    : sync.lastError ? 'Đang dùng dữ liệu cũ; lần cập nhật gần nhất thất bại.'
      : sync.stale ? 'Đang dùng dữ liệu cũ; chờ cập nhật.' : 'Dữ liệu sẵn sàng.';
  return [
    ['Cập nhật CONT thành công lúc', updatedAt],
    ['Trạng thái hàng dự kiến', status],
    ['Phạm vi hàng dự kiến', 'Toàn công ty (Hà Nội + Sài Gòn)']
  ];
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
 */
function describeExport(payload, branch, options = {}) {
  const request = plainObject(payload);
  const tableKey = normalizeText(request.tableKey);
  if (!Object.prototype.hasOwnProperty.call(TABLE_TITLES, tableKey)) throw exportError('Bảng yêu cầu xuất không hợp lệ.', 400, 'EXPORT_TABLE_NOT_ALLOWED');
  const filters = normalizeFilters(request.filters);
  const context = plainObject(request.context);

  if (tableKey === 'debt.penalty' && context.debtRewardMonth !== undefined && context.debtRewardMonth !== '') {
    if (typeof context.debtRewardMonth !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(context.debtRewardMonth)) {
      throw exportError('Tháng thưởng/phạt không hợp lệ (YYYY-MM).');
    }
  }

  const spec = getTableSpec(tableKey, context, branch);
  // Đơn giá và Giá trị có bán HN/SG (PRODUCT_REPORT_PRICE_KEYS) chỉ cho tài khoản có quyền reports.products.price (route truyền options.canViewPrice); thiếu cờ = không có giá,
  // nên cột không xuất hiện trong danh sách trường và yêu cầu tự gõ khóa cột giá bị từ chối EXPORT_FIELD_NOT_ALLOWED.
  if (tableKey === 'overview.productReport' && (!options.canViewPrice || options.canViewSales === false)) {
    const blocked = [...(options.canViewPrice ? [] : PRODUCT_REPORT_PRICE_KEYS), ...(options.canViewSales === false ? PRODUCT_REPORT_SALES_KEYS : [])];
    spec.worksheets = spec.worksheets.map(worksheet => ({
      ...worksheet, columns: worksheet.columns.filter(column => !blocked.includes(column.key))
    }));
  }
  const description = {
    tableKey, title: TABLE_TITLES[tableKey], selectionMode: 'custom',
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
    const filtered = applyTableSearchToDataset(dataset, request.tableSearch, request.tableSort);
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
  if (description.dataset) return description.dataset;
  if (tableKey === 'customers.productDetail') {
    return buildCustomerProductRevenueDataset(tableKey, description, request, branch, signal);
  }
  if (tableKey === 'overview.productReport') {
    return buildProductReportDataset(description, request, signal);
  }
  if (tableKey === 'debt.penalty') {
    const branches = resolveBranchScope(branch || BRANCH_BOTH).map(branchLabelToCode).filter(Boolean);
    const month = description.context.debtRewardMonth || undefined;
    const board = await require('../debtSchedule/debtRewardService').getDebtRewardService().readBoard({ month, branches });
    throwIfAborted(signal);
    if (!board.summary) throw exportError('Chưa có bản chốt công nợ để xuất thưởng/phạt.', 404, 'EXPORT_NO_DATA');
    const dataset = await buildFixedDataset(tableKey, { dashboard: { debtReward: board }, branch, signal }, description.context, request.tableSearch, options.selection, request.tableSort);
    if (board.status !== 'finalized') {
      dataset.worksheets.forEach(worksheet => {
        worksheet.columns = worksheet.columns.map(column => column.key === 'reward' ? { ...column, label: 'Thưởng tạm tính' } : column);
      });
    }
    return { ...dataset, debtReward: debtRewardMetadata(board) };
  }
  if (tableKey === 'debt.aging') {
    const branches = resolveBranchScope(branch || BRANCH_BOTH).map(branchLabelToCode).filter(Boolean);
    const debtAging = await debtScheduleService.buildDebtAging(branches);
    throwIfAborted(signal);
    return buildFixedDataset(tableKey, { dashboard: { debtAging }, branch, signal }, description.context, request.tableSearch, options.selection);
  }
  // Viewer bo trong = khong quyen sua cong no (giong xuat file truoc day). Ket qua
  // nam trong cache dung chung nen chi DOC, khong sua.
  // Bang cong no co the xuat ban chot cu (toi da 7 ngay): doc thang tu bang chot, khong qua cache dashboard.
  const debtCycleDate = tableKey === 'debt.management' ? normalizeText(description.context.debtCycleDate) : '';
  if (debtCycleDate) {
    const debtManagement = await debtScheduleService.buildDebtManagement(resolveBranchScope(branch || BRANCHES.HANOI), undefined, { cycleDate: debtCycleDate });
    throwIfAborted(signal);
    const dataset = await buildFixedDataset(tableKey, { dashboard: { debtManagement }, branch, signal }, description.context, request.tableSearch, options.selection);
    return { ...dataset, cycleDate: debtCycleDate };
  }
  const dashboard = await dashboardData.getDashboardData(description.filters, branch);
  throwIfAborted(signal);
  return buildFixedDataset(tableKey, { dashboard, branch, signal }, description.context, request.tableSearch, options.selection, request.tableSort);
}

function toFieldMeta(column) {
  const meta = { key: column.key, label: column.label, type: column.type, selected: column.selected !== false };
  if (column.description) meta.description = column.description;
  return meta;
}

/**
 * Danh sach truong cho modal Xuat Excel. Bang co dinh tra ve TUC THI tu dinh nghia
 * tinh (rowCount = null, khong query).
 */
async function getExportFields(payload, branch, options = {}) {
  const request = plainObject(payload);
  const source = describeExport(request, branch, options);
  return {
    tableKey: source.tableKey,
    title: source.title,
    selectionMode: source.selectionMode,
    worksheets: source.worksheets.map(worksheet => ({
      key: worksheet.key,
      name: worksheet.name,
      rowCount: null,
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
    if (column.signTone) applySignToneFont(worksheet, index + 1, rows, column);
  });
}

// Chu am do / 0 vang dam / duong xanh la (khop mau cot Con han tren man hinh va file HTML).
const SIGN_TONE_ARGB = { neg: 'FFB91C1C', zero: 'FFB8860B', pos: 'FF047857' };

function applySignToneFont(worksheet, columnNumber, rows, column) {
  rows.forEach((row, index) => {
    const value = toExcelValue(row[column.key], column.type);
    if (typeof value !== 'number') return;
    const tone = value < 0 ? 'neg' : value === 0 ? 'zero' : 'pos';
    worksheet.getRow(index + 2).getCell(columnNumber).font = { bold: true, color: { argb: SIGN_TONE_ARGB[tone] } };
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
  const description = options.description || describeExport(request, branch, options);
  const selection = options.selection !== undefined
    ? options.selection
    : resolveSelection(description.selectionMode, description.worksheets, request.columns);
  const dataset = await buildExportDataset(request, branch, { signal, description, selection });
  throwIfAborted(signal);

  const worksheets = dataset.worksheets.map(sourceWorksheet => ({
    key: sourceWorksheet.key,
    name: sourceWorksheet.name,
    columns: selectedColumnsForWorksheet(dataset.selectionMode, sourceWorksheet, request.columns),
    ...(sourceWorksheet.summaryKeys ? { summaryKeys: sourceWorksheet.summaryKeys } : {}),
    rows: sourceWorksheet.rows
  })).filter(worksheet => worksheet.columns.length > 0);
  if (worksheets.length === 0) {
    throw exportError('Vui lòng chọn ít nhất một trường để xuất.', 400, 'EXPORT_NO_FIELDS_SELECTED');
  }
  const fileBranch = dataset.sourceBranch || branch;
  // Ban chot cu cua cong no: ghi ngay chot vao tieu de va ten file de khong nham voi ban moi nhat.
  const cycleDate = dataset.cycleDate || '';
  const cycleLabel = cycleDate ? `${cycleDate.slice(8, 10)}/${cycleDate.slice(5, 7)}/${cycleDate.slice(0, 4)}` : '';
  const reward = dataset.debtReward;
  return {
    meta: {
      tableKey: dataset.tableKey,
      title: reward ? `${dataset.title} - ${reward.month} (${debtRewardStatusLabel(reward.status)})`
        : cycleLabel ? `${dataset.title} - chốt 15:00 ${cycleLabel}` : dataset.title,
      branch: fileBranch || '',
      generatedAt: new Date(),
      fileBase: `${branchFilePrefix(fileBranch)}_${fileSlug(dataset.title)}${reward ? `_thang_${reward.month.replace('-', '')}` : ''}${cycleDate ? `_chot_${cycleDate.replace(/-/g, '')}` : ''}_${fileTimestamp()}`,
      ...(dataset.reportNotes ? { reportNotes: dataset.reportNotes } : {}),
      ...(reward ? { debtReward: reward, debtRewardNotes: reward.notes } : {})
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
  const description = describeExport(request, branch, options);
  const selection = resolveSelection(description.selectionMode, description.worksheets, request.columns);

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

  const metadataSheets = [
    ['Thông tin thưởng phạt', dataset.meta.debtRewardNotes],
    ['Thông tin hàng dự kiến', dataset.meta.reportNotes]
  ];
  for (const [name, notes] of metadataSheets) {
    if (!notes) continue;
    const columns = [
      aggregateColumn('label', 'Thông tin', 'text'),
      aggregateColumn('value', 'Giá trị', 'text', undefined, { wrapText: true })
    ];
    const rows = notes.map(([label, value]) => ({ label, value }));
    const worksheet = workbook.addWorksheet(safeWorksheetName(name, usedNames));
    worksheet.columns = columns.map(column => ({ header: column.label, key: column.key }));
    rows.forEach(row => worksheet.addRow({ label: toExcelValue(row.label, 'text'), value: toExcelValue(row.value, 'text') }));
    styleWorksheet(worksheet, columns, rows);
    worksheet.getColumn(1).width = 38;
    worksheet.getColumn(2).width = 60;
  }

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
        `Dữ liệu có ${totalRows.toLocaleString('en-US')} dòng (${totalCells.toLocaleString('en-US')} ô), vượt giới hạn ${HTML_MAX_CELLS.toLocaleString('en-US')} ô của báo cáo HTML. Vui lòng bỏ bớt cột, thu hẹp bộ lọc hoặc dùng Xuất Excel.`,
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
