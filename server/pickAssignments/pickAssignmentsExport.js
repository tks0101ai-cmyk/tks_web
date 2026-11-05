'use strict';

// Xuat Excel "Chi dinh vi tri" cua hop Vong doi don hang: moi cap (ma hang, vi tri duoc chi dinh) 1 dong,
// ma hang co nhieu vi tri -> nhieu dong (moi dong dung vi tri + so luong cua no). Ma chua chi dinh vi tri van co 1 dong (vi tri/SL nhat de trong).
const ExcelJS = require('exceljs');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');

const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const NUMBER = '#,##0.###';
const MAX_ROWS = 5000;

// Chan cong thuc Excel do du lieu nguoi dung nhap (giong stockPositionsExport.js).
const safeText = value => (/^[\s]*[=+\-@]/u.test(String(value ?? '')) ? `'${value}` : String(value ?? ''));
const text = value => (value === null || value === undefined || value === '' ? null : safeText(value));
const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const COLUMNS = Object.freeze([
  { header: 'Mã đơn', width: 16, value: (row, ctx) => text(ctx.orderCode) },
  { header: 'Mã hàng', width: 18, value: row => text(row.productCode) },
  { header: 'Tên hàng', width: 42, value: row => text(row.productName) },
  { header: 'SL cần nhặt', width: 13, numFmt: NUMBER, value: row => num(row.need) },
  { header: 'Vị trí', width: 18, value: row => text(row.location) },
  { header: 'SL nhặt', width: 12, numFmt: NUMBER, value: row => num(row.quantity) },
  { header: 'Số thùng', width: 12, numFmt: NUMBER, value: row => num(row.cartons) },
  { header: 'Quy cách ST', width: 26, value: row => text(row.stText) }
]);

// Lam sach dong gui len tu trinh duyet: chi giu truong biet truoc, gioi han so dong.
function normalizeRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, MAX_ROWS).filter(row => row && typeof row === 'object' && String(row.productCode ?? '').trim()).map(row => ({
    productCode: row.productCode, productName: row.productName, need: row.need, location: row.location,
    quantity: row.quantity, cartons: row.cartons, stText: row.stText
  }));
}

async function createPickAssignmentsWorkbook({ branch, orderCode, rows = [] }, { now = new Date() } = {}) {
  const data = normalizeRows(rows);
  const ctx = { branch, orderCode };
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  const sheet = workbook.addWorksheet('Chỉ định vị trí');
  sheet.columns = COLUMNS.map(col => ({ header: col.header, width: col.width, style: col.numFmt ? { numFmt: col.numFmt } : { alignment: { wrapText: true, vertical: 'top' } } }));
  data.forEach(row => sheet.addRow(COLUMNS.map(col => col.value(row, ctx))));
  sheet.views = frozenNoGridlinesView(1);
  const header = sheet.getRow(1);
  header.font = HEADER_FONT;
  header.height = 28;
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, data.length + 1), column: COLUMNS.length } };
  applyFullTableBorder(sheet, COLUMNS.length, data.length + 1);
  const stamp = new Date(now.getTime() + VN_OFFSET_MS).toISOString();
  const safeCode = String(orderCode || 'don').replace(/[^\w.-]+/gu, '_').slice(0, 40) || 'don';
  return {
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    fileName: `chi-dinh-vi-tri_${safeCode}_${stamp.slice(0, 10).replace(/-/g, '')}_${stamp.slice(11, 16).replace(':', '')}.xlsx`,
    rowCount: data.length
  };
}

module.exports = { createPickAssignmentsWorkbook, normalizeRows, COLUMNS };
