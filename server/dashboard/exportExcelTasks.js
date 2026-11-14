'use strict';

// Các loại file .xlsx dựng được trong worker (exportExcelWorker.js) hoặc luồng chính (dự phòng): tên -> hàm thuần
// (payload) => { buffer, mimeType, fileName }. Chỉ nạp module dựng file (ExcelJS), không nạp config / DB.
const EXCEL_TASKS = Object.freeze({
  dataset: payload => require('./exportExcelRenderer').renderExcelWorkbook(payload),
  expectedArrivals: payload => require('../productContainers/expectedExcel').renderExpectedXlsx(payload)
});

module.exports = { EXCEL_TASKS };
