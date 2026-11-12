'use strict';

// ==========================================
// EXPORT EXCEL RENDERER — dựng file .xlsx từ dataset đã nạp (exportService.getExportDataset).
// Tách khỏi exportService.js (12/11/2026) để chạy được trong worker thread (exportExcelWorker.js): ExcelJS dựng
// workbook lớn tốn CPU nhiều giây và từng làm đứng cả web (log [loop-stall]: POST /api/export, lag 4,2 s).
// Module thuần: chỉ phụ thuộc ExcelJS + excelTableStyle, không chạm DB / cấu hình.
// ==========================================

const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

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
    // So lieu hien thi lam tron den so nguyen (khong phan thap phan).
    if (column.type === 'number') excelColumn.numFmt = '#,##0;[Red]-#,##0';
    if (column.type === 'percent') excelColumn.numFmt = '0.00%';
    if (column.type === 'date') excelColumn.numFmt = 'dd/mm/yyyy hh:mm:ss';
    excelColumn.alignment = { vertical: 'top', wrapText: column.wrapText === true };
    if (column.signTone) applySignToneFont(worksheet, index + 1, rows, column);
    if (column.type === 'number' && Number.isInteger(column.fractionDigits)) applyFractionFormat(worksheet, index + 1, rows, column);
  });
}

// Cot khai bao fractionDigits: o so le dung dinh dang co dung so chu so thap phan can thiet (toi da fractionDigits),
// o so nguyen giu '#,##0' — gia tri o van la so that, chi la hien thi khong bi lam tron.
function excelFractionFormat(value, maxDigits) {
  if (typeof value !== 'number' || !Number.isFinite(value) || Number.isInteger(value)) return null;
  // fractionDigits 0: dinh dang cot '#,##0' da lam tron; rieng so am lam tron ve 0 (-0.2) dung dinh dang khong dau tru de khong hien "-0".
  if (maxDigits === 0) return value < 0 && Math.round(-value) === 0 ? '#,##0;#,##0' : null;
  const text = String(Number(value.toFixed(maxDigits)));
  const digits = /e/i.test(text) ? maxDigits : ((text.split('.')[1] || '').length);
  if (!digits) return null;
  const decimals = '0'.repeat(Math.min(digits, maxDigits));
  return `#,##0.${decimals};[Red]-#,##0.${decimals}`;
}

function applyFractionFormat(worksheet, columnNumber, rows, column) {
  rows.forEach((row, index) => {
    const format = excelFractionFormat(toExcelValue(row[column.key], column.type), column.fractionDigits);
    if (format) worksheet.getRow(index + 2).getCell(columnNumber).numFmt = format;
  });
}

// Worksheet khai bao autoRowHeight: dong co o xuong dong (vd Top 3 khach) duoc dat chieu cao du so dong chu,
// vi Excel khong tu gian chieu cao dong khi mo file.
function applyAutoRowHeight(worksheet, columns, rows) {
  const wrapped = columns.filter(column => column.wrapText);
  if (!wrapped.length) return;
  rows.forEach((row, index) => {
    const lines = Math.max(1, ...wrapped.map(column => String(row[column.key] == null ? '' : row[column.key]).split('\n').length));
    if (lines > 1) worksheet.getRow(index + 2).height = lines * 15 + 3;
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
    if (sourceWorksheet.autoRowHeight) applyAutoRowHeight(worksheet, columns, sourceWorksheet.rows);
  });

  const metadataSheets = [
    ['Thông tin thưởng phạt', dataset.meta.debtRewardNotes],
    // reportNotesTitle: bang tu dat ten sheet ghi chu; mac dinh giu ten cu cua Bao cao hang hoa (CONT).
    [dataset.meta.reportNotesTitle || 'Thông tin hàng dự kiến', dataset.meta.reportNotes]
  ];
  for (const [name, notes] of metadataSheets) {
    if (!notes) continue;
    const columns = [
      { key: 'label', label: 'Thông tin', type: 'text', wrapText: false },
      { key: 'value', label: 'Giá trị', type: 'text', wrapText: true }
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

module.exports = { EXCEL_MIME, renderExcelWorkbook, toExcelValue, excelFractionFormat };
