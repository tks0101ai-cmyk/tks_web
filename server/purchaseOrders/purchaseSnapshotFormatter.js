'use strict';

const ExcelJS = require('exceljs');

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

function numberFormat(column) {
  if (column.k === 'literDiff' || column.k === 'gramDiff') return '+0.##%;-0.##%;0%';
  if (column.t === 'pct') return '+0.##%;-0.##%;0%';
  if (column.t === 'ratio') return '0.##%';
  const formats = { num: '#,##0.####', num1: '#,##0.#', num2: '#,##0.##', num3: '#,##0.###', num4: '#,##0.####', cny: '#,##0.###', money: '#,##0.##' };
  return formats[column.t] || null;
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
    const format = column.k === 'measuredOn' ? '@' : numberFormat(column) || (column.t === 'datetime' ? 'dd/mm/yyyy hh:mm' : null);
    if (format) col.numFmt = format;
    const horizontal = ['num', 'num1', 'num2', 'num3', 'num4', 'cny', 'money', 'pct', 'ratio'].includes(column.t) ? 'right' : column.t === 'datetime' ? 'center' : 'left';
    col.alignment = { vertical: 'middle', horizontal };
  });
}

function styleGuideSheet(sheet) {
  sheet.columns = GUIDE_WIDTHS.map(width => ({ width }));
  sheet.views = [{ state: 'normal', showGridLines: false }];
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
  styleOrderSheet(order, columns);
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

module.exports = { formatPurchaseSnapshot };
