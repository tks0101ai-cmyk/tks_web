'use strict';

// Xuat bang "Gia duyet" ra Excel: dung TAP DANG LOC / SAP XEP cua man hinh (may chu doc lai bang cung bo loc),
// cot khop UI, ngay dd/mm/yyyy, gia dang so; chu chong formula injection.

const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');
const { MAX_EXPORT_ROWS } = require('./approvedPriceRepository');

const SHEET_NAME = 'Giá duyệt';
const FILE_BASE = 'TKS_Gia_duyet';

const COLUMNS = Object.freeze([
  { key: 'customerName', label: 'Khách hàng', width: 34, value: r => r.customerName || '(khách không còn trên KiotViet)' },
  { key: 'customerCode', label: 'Mã KH', width: 14, value: r => r.customerCode || '' },
  { key: 'branchLabel', label: 'Cơ sở', width: 12, value: r => r.branchLabel },
  { key: 'productCode', label: 'Mã SP', width: 18, value: r => r.productCode },
  { key: 'productName', label: 'Tên SP', width: 44, value: r => r.productName },
  { key: 'priceNoVat', label: 'Giá không VAT', width: 16, numFmt: '#,##0', value: r => (r.priceNoVat == null ? null : Number(r.priceNoVat)) },
  { key: 'priceWithVat', label: 'Giá có VAT', width: 16, numFmt: '#,##0', value: r => (r.priceWithVat == null ? null : Number(r.priceWithVat)) },
  { key: 'approver', label: 'Người duyệt', width: 18, value: r => r.approver },
  { key: 'approvedOn', label: 'Ngày duyệt', width: 14, value: r => dmy(r.approvedOn) }
]);

const dmy = day => (day ? day.split('-').reverse().join('/') : '');

function safeText(value) {
  const text = String(value == null ? '' : value);
  return /^[\s]*[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

function tooMany() {
  return Object.assign(new Error('Dữ liệu vượt giới hạn 20.000 dòng mỗi lần xuất. Hãy thu hẹp bộ lọc rồi xuất lại.'),
    { statusCode: 400, code: 'TOO_MANY_ROWS' });
}

/** @param {{ rows: object[], filters?: { approver?, from?, to?, q? } }} input */
async function createApprovedPriceExport({ rows = [], filters = {} } = {}) {
  if (rows.length > MAX_EXPORT_ROWS) throw tooMany();
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet(SHEET_NAME);
  sheet.columns = COLUMNS.map(c => ({ key: c.key, header: c.label, width: c.width, ...(c.numFmt ? { style: { numFmt: c.numFmt } } : {}) }));
  for (const row of rows) {
    sheet.addRow(COLUMNS.map(c => {
      const v = c.value(row);
      return typeof v === 'string' ? safeText(v) : v;
    }));
  }
  sheet.views = frozenNoGridlinesView(1);
  sheet.getRow(1).font = HEADER_FONT;
  sheet.getRow(1).height = 24;
  sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: COLUMNS.length } };
  applyFullTableBorder(sheet, COLUMNS.length, rows.length + 1);

  const info = workbook.addWorksheet('Thông tin');
  info.columns = [{ header: 'Mục', key: 'label', width: 30 }, { header: 'Giá trị', key: 'value', width: 50 }];
  info.addRow(['Người duyệt', filters.approver || 'Tất cả']);
  info.addRow(['Ngày duyệt', filters.from || filters.to ? `${dmy(filters.from) || '…'} – ${dmy(filters.to) || '…'}` : 'Tất cả']);
  if (filters.q) info.addRow(['Tìm kiếm', filters.q]);
  info.addRow(['Số dòng xuất', rows.length]);
  info.getRow(1).font = HEADER_FONT;

  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `${FILE_BASE}.xlsx`
  };
}

module.exports = { createApprovedPriceExport, COLUMNS };
