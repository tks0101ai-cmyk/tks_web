'use strict';

// Dung file .xlsx "Du kien hang ve" tu cot + mang gia tri da chuan bi san (expectedExport.createExportFile).
// Tach rieng (chi can ExcelJS + style) de chay trong worker thread dung chung (dashboard/exportExcelPool.js):
// 12k dong ExcelJS tung chan event loop 1,6-1,9 s moi lan xuat (log [loop-stall] 14/11/2026).
const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');

/**
 * @param {{ columns: {key, label, type, decimals?}[], values: any[][], sheetName: string, fileName: string }} payload
 *   values[i][j] = gia tri o (chuoi da qua safeText, so, hoac null) theo dung thu tu columns.
 */
async function renderExpectedXlsx({ columns, values, sheetName, fileName }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet(sheetName);
  sheet.columns = columns.map(c => ({
    key: c.key,
    header: c.label,
    width: c.type === 'number' ? 16 : c.key === 'productName' || c.key === 'saleNote' ? 36 : 22,
    style: c.type === 'number' ? { numFmt: c.decimals === 2 ? '#,##0.00' : c.decimals === 0 ? '#,##0' : '#,##0' } : {}
  }));
  for (const row of values) sheet.addRow(row);
  sheet.views = frozenNoGridlinesView(1);
  sheet.getRow(1).font = HEADER_FONT;
  sheet.getRow(1).height = 24;
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, values.length + 1), column: columns.length } };
  applyFullTableBorder(sheet, columns.length, values.length + 1);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName
  };
}

module.exports = { renderExpectedXlsx };
