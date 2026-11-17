'use strict';

// Xuat Excel danh sach "Dong bi bo qua" cua lan Xuat kho Excel (client gui lai danh sach loi vua nhan tu /stock-out).
const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const MAX_ROWS = 5000;
// Chan cong thuc Excel do du lieu nguoi dung nhap.
const safeText = value => (/^[\s]*(?:[=+@]|-(?!\d))/u.test(String(value ?? '')) ? `'${value}` : String(value ?? ''));

const COLUMNS = Object.freeze([
  { header: 'Dòng file', width: 11, numFmt: '0' },
  { header: 'Mã hàng', width: 18 },
  { header: 'Vị trí', width: 16 },
  { header: 'Ghi chú', width: 20 },
  { header: 'Lý do', width: 70 }
]);

async function createStockOutSkippedWorkbook({ errors, branch }, { now = new Date() } = {}) {
  const rows = (Array.isArray(errors) ? errors : []).slice(0, MAX_ROWS);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet('Dòng bị bỏ qua');
  sheet.columns = COLUMNS.map(col => ({ header: col.header, width: col.width, style: col.numFmt ? { numFmt: col.numFmt } : { alignment: { wrapText: true, vertical: 'top' } } }));
  rows.forEach(item => {
    const row = Number(item && item.row);
    sheet.addRow([
      Number.isFinite(row) ? row : null,
      item && item.code ? safeText(item.code) : null,
      item && item.location ? safeText(item.location) : null,
      item && item.notes ? safeText(item.notes) : null,
      item && item.message ? safeText(item.message) : null
    ]);
  });
  sheet.views = frozenNoGridlinesView(1);
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.height = 28;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: COLUMNS.length } };
  applyFullTableBorder(sheet, COLUMNS.length, rows.length + 1);
  const stamp = new Date(now.getTime() + VN_OFFSET_MS).toISOString();
  const tag = /^(HN|SG)$/i.test(String(branch || '')) ? `_${String(branch).toLowerCase()}` : '';
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `xuat-kho-excel-dong-bo-qua${tag}_${stamp.slice(0, 10).replace(/-/g, '')}_${stamp.slice(11, 16).replace(':', '')}.xlsx`
  };
}

module.exports = { createStockOutSkippedWorkbook };
