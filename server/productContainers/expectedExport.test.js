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
