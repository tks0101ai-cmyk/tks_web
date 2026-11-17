'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { filterRows, sortRowsByLabel } = require('./expectedExport');

const rows = [
  { sheetName: 'A', productCode: 'B2', productName: 'Bình', quantity: 5, unitPriceCny: 9 },
  { sheetName: 'A', productCode: 'A1', productName: 'Ấm', quantity: 20, unitPriceCny: 3 },
  { sheetName: 'A', productCode: 'C3', productName: 'Cốc', quantity: '', unitPriceCny: 1 }
];

test('sortRowsByLabel: sap theo tieu de cot, o trong luon cuoi', () => {
  const asc = sortRowsByLabel(rows, { sortLabel: 'Tổng số lượng', sortDir: 'asc' }, { fullAccess: true });
  assert.deepEqual(asc.map(r => r.productCode), ['B2', 'A1', 'C3']);
  const desc = sortRowsByLabel(rows, { sortLabel: 'tổng số lượng', sortDir: 'desc' }, { fullAccess: true });
  assert.deepEqual(desc.map(r => r.productCode), ['A1', 'B2', 'C3']);
});

test('sortRowsByLabel: khong co quyen gia thi bo qua cot gia, nhan la giu nguyen thu tu', () => {
  assert.equal(sortRowsByLabel(rows, { sortLabel: 'Giá SP (tệ)', sortDir: 'asc' }, { fullAccess: false }), rows);
  assert.equal(sortRowsByLabel(rows, { sortLabel: 'Không có cột', sortDir: 'asc' }, { fullAccess: true }), rows);
  assert.equal(sortRowsByLabel(rows, {}, { fullAccess: true }), rows);
});

test('filterRows: che do Nhieu ma khop dung danh sach ma SP', () => {
  const result = filterRows(rows, { q: 'A1 C3', qmode: 'codes' });
  assert.deepEqual(result.map(r => r.productCode).sort(), ['A1', 'C3']);
});

// 14/11/2026: xuat 12k dong dung ExcelJS trong luong chinh lam ca web dung 1,6-1,9 s ([loop-stall]).
test('xuat xlsx 12.000 dong dung file trong worker: event loop khong dung, noi dung file day du', async () => {
  const ExcelJS = require('exceljs');
  const { createExportFile: exportFile } = require('./expectedExport');
  const rows = Array.from({ length: 12000 }, (_, i) => ({ scheduleLabel: '1. Chưa bốc', containerName: 'CONT ' + (i % 209), productCode: 'SP' + i,
    productName: i === 0 ? '=HYPERLINK("x")' : 'Tên ' + i, color: 'Đỏ', saleNote: '', orderedBy: 'NV', unitsPerPackage: 24, packageCount: 10, quantity: i + 1, sheetName: 'YIWU', sourceRow: i }));
  let maxLag = 0;
  let last = performance.now();
  const timer = setInterval(() => { const now = performance.now(); maxLag = Math.max(maxLag, now - last - 10); last = now; }, 10);
  let file;
  try { file = await exportFile('xlsx', rows, ['productCode', 'productName', 'quantity'], {}); } finally { clearInterval(timer); }
  assert.ok(maxLag < 150, `event loop dung ${Math.round(maxLag)} ms`);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const sheet = wb.worksheets[0];
  assert.equal(sheet.name, 'Dự kiến hàng về');
  assert.equal(sheet.rowCount, 12001);
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Mã SP', 'Tên SP', 'Tổng số lượng']);
  assert.deepEqual(sheet.getRow(12001).values.slice(1), ['SP11999', 'Tên 11999', 12000]);
  assert.equal(sheet.getRow(2).getCell(2).value, "'=HYPERLINK(\"x\")", 'van chan cong thuc Excel');
  assert.equal(file.fileName.endsWith('.xlsx'), true);
});
