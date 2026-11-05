'use strict';

// Xuat Excel bang doi chieu kiem ke (dung thu tu cot tab "KIEM KE HN T10").
const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');
const Status = require('../public/stocktake/stocktakeStatus');
const { parseSpec } = require('../public/shared/carton');

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
    { header: 'Giá vốn', width: 12, numFmt: MONEY, value: row => row.cost },
    { header: 'Cập nhật', width: 22, value: row => safeText(row.note && row.note.updatedByName ? row.note.updatedByName : '') }
  ];
}
const boardColumnHeaders = branch => columns(() => '', branch).map(col => col.header);

const MIME_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const fileNameOf = (prefix, session) => {
  const safeName = String(session.name || '').normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/đ/gu, 'd').replace(/Đ/gu, 'D').replace(/[^\w.-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `${prefix}-${safeName || session.id}.xlsx`;
};

// So quy cach voi so luong. Chi dung trinh doc nghiem parseSpec (khong doan quy cach kem chu) de dong nghi ngo duoc xem lai.
function checkSpec(spec, quantity) {
  if (!String(spec ?? '').trim()) return { status: 'blank', text: 'Thiếu quy cách' };
  const parsed = parseSpec(spec);
  if (!parsed) return { status: 'unreadable', text: 'Không nhân được quy cách' };
  const qty = Number(quantity) || 0;
  if (Math.abs(parsed.quantity - qty) < 0.000001) return { status: 'ok', computed: parsed.quantity, text: '' };
  return { status: 'diff', computed: parsed.quantity, text: `Lệch: quy cách ${parsed.quantity}, SL ${qty}` };
}

const CHECK_FILL = Object.freeze({ diff: 'FFFECACA', unreadable: 'FFFEF3C7', blank: 'FFFEF3C7' });
const STATS_COLUMNS = Object.freeze([
  { header: 'Tên khách hàng', width: 38 }, { header: 'Ghi chú', width: 14 }, { header: 'Mã hàng', width: 16 }, { header: 'Tên hàng', width: 40 },
  { header: 'Ghi chú hàng hóa', width: 24 }, { header: 'Số lượng', width: 12, numFmt: NUMBER }, { header: 'Kiểm quy cách', width: 30 }, { header: 'Trang in', width: 10 }
]);
const CHECK_COLUMN = STATS_COLUMNS.findIndex(col => col.header === 'Kiểm quy cách') + 1;
const statsHeaders = () => STATS_COLUMNS.map(col => col.header);
const compareVi = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'vi', { numeric: true });

// File giong tab THONG KE cua sheet kiem ke: moi dong dem la 1 dong, cong theo ma = Tong kiem.
async function createStatsWorkbook({ session, rows = [] }) {
  const lines = [];
  for (const row of rows) {
    for (const line of row.lines || []) if (!line.removed) lines.push({ row, line });
  }
  lines.sort((a, b) => compareVi(a.row.name, b.row.name) || compareVi(a.line.team, b.line.team) || compareVi(a.line.zone, b.line.zone));
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet('THỐNG KÊ');
  sheet.columns = STATS_COLUMNS.map(col => ({ header: col.header, width: col.width, ...(col.numFmt ? { style: { numFmt: col.numFmt } } : {}) }));
  for (const { row, line } of lines) {
    const check = checkSpec(line.spec, line.quantity);
    const added = sheet.addRow([safeText(line.team), safeText(line.zone), safeText(row.code), safeText(row.name), safeText(line.spec), line.quantity, check.text,
      safeText(row.note ? row.note.printPage : '')]);
    const fill = CHECK_FILL[check.status];
    if (fill) added.getCell(CHECK_COLUMN).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  }
  sheet.views = frozenNoGridlinesView(1);
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.height = 28;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, lines.length + 1), column: STATS_COLUMNS.length } };
  applyFullTableBorder(sheet, STATS_COLUMNS.length, lines.length + 1);
  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), fileName: fileNameOf('kiem-ke-thong-ke', session), mimeType: MIME_XLSX };
}

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
    // To o Trang thai theo loai (stocktakeStatus.js); Chua XL / Khac khong to.
    const color = Status.colorOf(row.note ? row.note.statusText : '');
    if (color) added.getCell(statusColumn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color.slice(1).toUpperCase() } };
  });
  sheet.views = frozenNoGridlinesView(1);
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.height = 28;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: cols.length } };
  applyFullTableBorder(sheet, cols.length, rows.length + 1);
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    fileName: fileNameOf('kiem-ke', session),
    mimeType: MIME_XLSX
  };
}

module.exports = { createStocktakeWorkbook, createStatsWorkbook, checkSpec, statsHeaders, boardColumnHeaders };
