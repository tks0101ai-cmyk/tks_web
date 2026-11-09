'use strict';

// Xuat Excel mot Don xuat kho (don tam hoac don da chot): moi dong don 1 dong Excel, dung thu tu tren man hinh.
// Don da chot lay "Ton VT truoc / Sau khi chot" tu result da luu; don tam lay tu preview (xem truoc theo ton VT hien tai).
const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const NUMBER = '#,##0.###';

// Chan cong thuc Excel do du lieu nguoi dung nhap (giong stockPositionsExport.js), NGOAI TRU ghi chu so am dang "-2T x 100" (dau '-' + chu so)
// vi do la du lieu that cua don, khong phai cong thuc.
const safeText = value => (/^[\s]*(?:[=+@]|-(?!\d))/u.test(String(value ?? '')) ? `'${value}` : String(value ?? ''));
const vnTime = iso => { const date = iso ? new Date(iso) : null; return !date || Number.isNaN(date.getTime()) ? null : new Date(date.getTime() + VN_OFFSET_MS); };

const outcomeOf = line => line.result || line.preview || null;

const COLUMNS = Object.freeze([
  { header: 'Mã đơn', width: 16, value: (line, order) => order.code },
  { header: 'Trạng thái', width: 14, value: (line, order) => (order.status === 'confirmed' ? 'Đã chốt' : 'Đơn tạm') },
  { header: '#', width: 6, numFmt: '0', value: (line, order, index) => index + 1 },
  { header: 'Mã hàng', width: 16, value: line => line.code },
  { header: 'Tên hàng', width: 40, value: line => line.name },
  { header: 'Vị trí', width: 16, value: line => line.location },
  { header: 'Ghi chú thùng', width: 26, value: line => line.notes },
  { header: 'SL xuất', width: 12, numFmt: NUMBER, value: line => line.quantity },
  { header: 'Tồn VT trước', width: 26, value: line => {
    const outcome = outcomeOf(line);
    if (!outcome) return null;
    return outcome.created || outcome.missing ? 'Chưa có dòng VT' : outcome.before;
  } },
  { header: 'Sau khi chốt', width: 26, value: line => { const outcome = outcomeOf(line); return outcome ? outcome.after : null; } },
  { header: 'Ghi chú', width: 22, value: line => {
    const outcome = outcomeOf(line);
    if (!outcome) return null;
    if (outcome.blocked) return outcome.reason || 'Không trừ được';
    return outcome.negative ? 'Số lượng âm' : null;
  } },
  { header: 'Người nhập', width: 22, value: line => line.createdByName },
  { header: 'TG cập nhật', width: 18, numFmt: 'dd/mm/yyyy hh:mm', value: line => vnTime(line.updatedAt) }
]);

function cellValue(value) {
  if (value === null || value === undefined || value === '') return null;
  return value instanceof Date || typeof value === 'number' ? value : safeText(value);
}

async function createStockOutOrderWorkbook({ order }, { now = new Date() } = {}) {
  const lines = Array.isArray(order.lines) ? order.lines : [];
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet(String(order.code || 'Đơn xuất kho').replace(/[\\/?*[\]:]/gu, '-').slice(0, 31));
  sheet.columns = COLUMNS.map(col => ({ header: col.header, width: col.width, style: col.numFmt ? { numFmt: col.numFmt } : { alignment: { wrapText: true, vertical: 'top' } } }));
  lines.forEach((line, index) => sheet.addRow(COLUMNS.map(col => cellValue(col.value(line, order, index)))));
  sheet.views = frozenNoGridlinesView(1);
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.height = 28;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, lines.length + 1), column: COLUMNS.length } };
  applyFullTableBorder(sheet, COLUMNS.length, lines.length + 1);
  const stamp = new Date(now.getTime() + VN_OFFSET_MS).toISOString();
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `don-xuat-kho_${String(order.code || order.id).toLowerCase()}_${stamp.slice(0, 10).replace(/-/g, '')}_${stamp.slice(11, 16).replace(':', '')}.xlsx`
  };
}

module.exports = { createStockOutOrderWorkbook, COLUMNS };
