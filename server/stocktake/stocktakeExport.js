'use strict';

// Xuat Excel bang doi chieu kiem ke (cot nhu tab "KIEM KE HN T10").
const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');

const NUMBER = '#,##0.##';
const MONEY = '#,##0';
// Chan cong thuc Excel do du lieu nguoi dung nhap (giong stockPositionsExport.js).
const safeText = value => (/^[\s]*[=+\-@]/u.test(String(value ?? '')) ? `'${value}` : String(value ?? ''));

function columns(employeeName) {
  return [
    { header: 'Mã hàng', width: 16, value: row => safeText(row.code) },
    { header: 'Tên hàng', width: 40, value: row => safeText(row.name) },
    { header: 'Vị trí kho gần nhất', width: 18, value: row => safeText(row.latestPosition ? row.latestPosition.location : '') },
    { header: 'Tổng kiểm', width: 12, numFmt: NUMBER, value: row => row.counted },
    { header: 'Tồn KIOT', width: 12, numFmt: NUMBER, value: row => row.stock },
    { header: 'SL chênh', width: 12, numFmt: NUMBER, value: row => row.diffQty },
    { header: 'Giá vốn', width: 12, numFmt: MONEY, value: row => row.cost },
    { header: 'Giá trị chênh', width: 16, numFmt: MONEY, value: row => row.diffValue },
    { header: 'Cụm SP', width: 16, value: row => safeText(row.cluster) },
    { header: 'Chênh cụm', width: 12, numFmt: NUMBER, value: row => row.clusterDiff },
    { header: 'Combo', width: 8, value: row => (row.isCombo ? 'X' : '') },
    { header: 'KK trước sai', width: 12, numFmt: NUMBER, value: row => row.prevDiff },
    { header: 'Quên KK', width: 9, value: row => (row.forgotten ? 'X' : '') },
    { header: 'Người kiểm lại', width: 20, value: row => safeText(employeeName(row.note && row.note.recheckEmployeeId)) },
    { header: 'Trạng thái', width: 16, value: row => safeText(row.note ? row.note.statusText : '') },
    { header: 'Chi tiết lý do', width: 36, value: row => safeText(row.note ? row.note.reasonText : '') }
  ];
}

async function createStocktakeWorkbook({ session, rows = [], employees = [] }) {
  const names = new Map(employees.map(e => [e.id, e.name]));
  const cols = columns(id => (id === null || id === undefined ? '' : names.get(id) || ''));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet('Kiểm kê');
  sheet.columns = cols.map(col => ({ header: col.header, width: col.width, style: col.numFmt ? { numFmt: col.numFmt } : { alignment: { wrapText: true, vertical: 'top' } } }));
  rows.forEach(row => sheet.addRow(cols.map(col => {
    const value = col.value(row);
    return value === null || value === undefined ? null : value;
  })));
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

module.exports = { createStocktakeWorkbook };
