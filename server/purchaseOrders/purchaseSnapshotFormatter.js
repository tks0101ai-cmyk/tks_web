'use strict';

const ExcelJS = require('exceljs');
const purchaseWorkbook = require('../public/shared/purchase-workbook');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1F8' } };
const HEADER_BORDER = { style: 'thin', color: { argb: 'FF9AAABD' } };
const GUIDE_WIDTHS = [28, 17, 34, 68];

function columnWidth(column) {
  const key = String(column.k || '');
  const label = column.cn ? `${column.l} · ${column.cn}` : String(column.l || key);
  const header = Math.min(20, [...label].length + 2);
  let preferred = 18;
  if (key === 'rowKey') preferred = 14;
  else if (['productCode', 'productName'].includes(key)) preferred = key === 'productName' ? 34 : 18;
  else if (key === 'productNameCn') preferred = 30;
  else if (column.t === 'datetime') preferred = 17;
  else if (['num', 'num1', 'num2', 'num3', 'num4', 'cny', 'money', 'pct', 'ratio'].includes(column.t)) preferred = 15;
  else if (/note|supplier|buyer|container|region|employee/i.test(key)) preferred = 24;
  return Math.max(10, Math.min(column.t === 'datetime' ? 19 : 36, Math.max(preferred, header)));
}

function numberFormat(column, value) {
  if (!purchaseWorkbook.numericTypes.has(column.t)) return null;
  const percent = column.k === 'literDiff' || column.k === 'gramDiff' || column.t === 'pct' || column.t === 'ratio';
  const raw = value && typeof value === 'object' && 'result' in value ? value.result : value;
  const numeric = Number(raw), shown = Number.isFinite(numeric) ? Number((percent ? numeric * 100 : numeric).toFixed(2)) : 0;
  const decimals = (String(shown).split('.')[1] || '').length;
  const signedPercent = column.k === 'literDiff' || column.k === 'gramDiff' || column.t === 'pct';
  const positive = (percent ? (signedPercent ? '+0' : '0') : '#,##0') + (decimals ? '.' + '0'.repeat(decimals) : '') + (percent ? '%' : '');
  const negative = (percent ? '-0' : '[Red]-#,##0') + (decimals ? '.' + '0'.repeat(decimals) : '') + (percent ? '%' : '');
  const zero = '0' + (decimals ? '.' + '0'.repeat(decimals) : '') + (percent ? '%' : '');
  return `${positive};${negative};${zero}`;
}

function styleHeader(row) {
  row.height = 34;
  row.font = { bold: true, color: { argb: 'FF1D3553' } };
  row.fill = HEADER_FILL;
  row.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  row.eachCell({ includeEmpty: true }, cell => {
    cell.border = { bottom: HEADER_BORDER };
  });
}

function setTableView(sheet, columnCount) {
  sheet.views = [{ state: 'frozen', ySplit: 1, showGridLines: false }];
  if (columnCount && sheet.rowCount) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, sheet.rowCount), column: columnCount }
    };
  }
}

function styleOrderSheet(sheet, columns) {
  sheet.columns = columns.map(column => ({ width: columnWidth(column) }));
  setTableView(sheet, columns.length);
  styleHeader(sheet.getRow(1));
  columns.forEach((column, index) => {
    const col = sheet.getColumn(index + 1);
    const format = column.k === 'measuredOn' ? '@' : column.t === 'datetime' ? 'dd/mm/yyyy hh:mm' : null;
    if (format) col.numFmt = format;
    const horizontal = ['num', 'num1', 'num2', 'num3', 'num4', 'cny', 'money', 'pct', 'ratio'].includes(column.t) ? 'right' : column.t === 'datetime' ? 'center' : 'left';
    col.alignment = { vertical: 'middle', horizontal };
    if (purchaseWorkbook.numericTypes.has(column.t)) {
      col.eachCell({ includeEmpty: false }, cell => { if (cell.row > 1) cell.numFmt = numberFormat(column, cell.value); });
    }
  });
}

function styleGuideSheet(sheet) {
  sheet.columns = GUIDE_WIDTHS.map(width => ({ width }));
  sheet.views = [{ state: 'normal', showGridLines: false }];
  sheet.eachRow(row => row.eachCell({ includeEmpty: true }, cell => {
    cell.font = { name: 'Calibri', size: 10 };
    cell.alignment = { vertical: 'middle', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9E0EA' } } };
  }));
  for (let rowNumber = 2; rowNumber <= 6; rowNumber++) {
    sheet.mergeCells(rowNumber, 1, rowNumber, 4);
    const row = sheet.getRow(rowNumber);
    row.height = 34;
    row.alignment = { vertical: 'middle', wrapText: true };
  }
  const title = sheet.getRow(1);
  title.height = 32;
  title.font = { bold: true, size: 16, color: { argb: 'FF1D3553' } };
  title.alignment = { vertical: 'middle' };
  let columnsHeader = 0;
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    if (sheet.getCell(rowNumber, 1).value === 'CỘT') {
      columnsHeader = rowNumber;
      styleHeader(sheet.getRow(rowNumber));
      break;
    }
  }
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
    const value = String(sheet.getCell(rowNumber, 1).value?.text || sheet.getCell(rowNumber, 1).value || '');
    if (value.startsWith('VÍ DỤ DÒNG MỚI')) {
      for (let detailRow = columnsHeader + 1; detailRow < rowNumber; detailRow++) {
        sheet.getRow(detailRow).height = 34;
        sheet.getRow(detailRow).alignment = { vertical: 'top', wrapText: true };
      }
      sheet.getRow(rowNumber).height = 24;
      sheet.getRow(rowNumber).font = { bold: true, color: { argb: 'FF1D3553' } };
      if (rowNumber + 1 <= sheet.rowCount) styleHeader(sheet.getRow(rowNumber + 1));
      break;
    }
  }
}

async function formatPurchaseSnapshot(source, columns) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(source));
  const order = workbook.getWorksheet('Đặt hàng');
  if (!order) throw new Error('Snapshot thiếu sheet Đặt hàng.');
  const importColumns = purchaseWorkbook.importColumns(columns);
  styleOrderSheet(order, [columns.find(column => column.k === 'rowKey'), ...importColumns.filter(column => column.k !== 'rowKey')].filter(Boolean));
  const guide = workbook.getWorksheet('Hướng dẫn');
  if (guide) styleGuideSheet(guide);
  const regions = workbook.getWorksheet('Danh sách vùng');
  if (regions) {
    regions.columns = [{ width: 16 }, { width: 30 }, { width: 14 }];
    setTableView(regions, 3);
    styleHeader(regions.getRow(1));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function formatPurchaseNewCodesTemplate(source, columns) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(source));
  const template = workbook.getWorksheet('Mã mới');
  if (!template) throw new Error('File mẫu thiếu sheet Mã mới.');
  styleOrderSheet(template, purchaseWorkbook.newCodeColumns(columns));
  const guide = workbook.getWorksheet('Hướng dẫn');
  if (guide) styleGuideSheet(guide);
  const regions = workbook.getWorksheet('Danh sách vùng');
  if (regions) {
    regions.columns = [{ width: 16 }, { width: 30 }, { width: 14 }];
    setTableView(regions, 3);
    styleHeader(regions.getRow(1));
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { formatPurchaseSnapshot, formatPurchaseNewCodesTemplate };
