'use strict';

// Xuat Excel bang doi chieu kiem ke (dung thu tu cot tab "KIEM KE HN T10").
const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');
const { STATUS_COLORS } = require('../public/stocktake/stocktakePaste');

const NUMBER = '#,##0.##';
const MONEY = '#,##0';
const PERCENT = '0%';
// Chan cong thuc Excel do du lieu nguoi dung nhap (giong stockPositionsExport.js).
const safeText = value => (/^[\s]*[=+\-@]/u.test(String(value ?? '')) ? `'${value}` : String(value ?? ''));

// Dung thu tu tab "KIEM KE HN T10" (A->W) + cot Cap nhat. Dot SG: cot M/S doi ten sang Ha Noi.
function columns(employeeName, branch) {
  const other = branch === 'saigon' ? 'HN' : 'SG';
  const note = (row, field) => safeText(row.note ? row.note[field] : '');
  return [
    { header: 'Mã hàng', width: 16, value: row => safeText(row.code) },
    { header: 'Tên hàng', width: 40, value: row => safeText(row.name) },
    { header: 'Tổng kiểm', width: 12, numFmt: NUMBER, value: row => row.counted },
    { header: 'Tồn KIOT', width: 12, numFmt: NUMBER, value: row => row.stock },
    { header: 'SL chênh', width: 12, numFmt: NUMBER, value: row => row.diffQty },
    { header: 'Giá trị chênh', width: 16, numFmt: MONEY, value: row => row.diffValue },
    { header: 'Trạng thái', width: 16, value: row => note(row, 'statusText') },
    { header: 'Chi tiết lý do', width: 36, value: row => note(row, 'reasonText') },
    { header: 'Trang in', width: 10, value: row => note(row, 'printPage') },
    { header: 'Giờ in', width: 12, value: row => note(row, 'printTime') },
    { header: 'Người kiểm lại', width: 20, value: row => safeText(row.note ? employeeName(row.note.recheckEmployeeId) || row.note.recheckName : '') },
    { header: 'KK trước sai', width: 12, numFmt: NUMBER, value: row => row.prevDiff },
    { header: 'Kiểm ' + other, width: 12, numFmt: NUMBER, value: row => row.otherDiff },
    { header: 'Cụm SP', width: 16, value: row => safeText(row.cluster) },
    { header: 'Count', width: 8, numFmt: NUMBER, value: row => row.clusterCount },
    { header: 'Chênh cụm', width: 12, numFmt: NUMBER, value: row => row.clusterDiff },
    { header: 'Do KK trước', width: 12, numFmt: PERCENT, value: row => row.prevRatio },
    { header: 'Lẫn + KK trước', width: 14, numFmt: PERCENT, value: row => row.clusterPrevRatio },
    { header: 'Do kiểm ' + other, width: 12, numFmt: PERCENT, value: row => row.otherRatio },
    { header: 'Quên KK', width: 9, value: row => (row.forgotten ? 'X' : '') },
    { header: 'Combo', width: 8, value: row => (row.isCombo ? 'X' : '') },
    { header: 'Vị trí kho gần nhất', width: 18, value: row => safeText(row.latestPosition ? row.latestPosition.location : '') },
    { header: 'Giá vốn', width: 12, numFmt: MONEY, value: row => row.cost },
    { header: 'Cập nhật', width: 22, value: row => safeText(row.note && row.note.updatedByName ? row.note.updatedByName : '') }
  ];
}
const boardColumnHeaders = branch => columns(() => '', branch).map(col => col.header);

async function createStocktakeWorkbook({ session, rows = [], employees = [] }) {
  const names = new Map(employees.map(e => [e.id, e.name]));
  const cols = columns(id => (id === null || id === undefined ? '' : names.get(id) || ''), session.branch);
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet('Kiểm kê');
  sheet.columns = cols.map(col => ({ header: col.header, width: col.width, style: col.numFmt ? { numFmt: col.numFmt } : { alignment: { wrapText: true, vertical: 'top' } } }));
  const statusColumn = cols.findIndex(col => col.header === 'Trạng thái') + 1;
  rows.forEach(row => {
    const added = sheet.addRow(cols.map(col => {
      const value = col.value(row);
      return value === null || value === undefined ? null : value;
    }));
    // To o Trang thai theo mau nguoi dung chon tren web.
    const color = row.note && STATUS_COLORS[row.note.statusColor];
    if (color) added.getCell(statusColumn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color.argb } };
  });
  sheet.views = frozenNoGridlinesView(1);
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.height = 28;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: cols.length } };
  applyFullTableBorder(sheet, cols.length, rows.length + 1);
  const safeName = String(session.name || 'kiem-ke').normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/đ/gu, 'd').replace(/Đ/gu, 'D').replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: `kiem-ke-${safeName || session.id}.xlsx`,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
}

module.exports = { createStocktakeWorkbook, boardColumnHeaders };
