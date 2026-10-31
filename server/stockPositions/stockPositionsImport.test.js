'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseImportWorkbook } = require('./stockPositionsImport');

function workbook(rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

test('Import mặc định vẫn bắt buộc 4 cột (có Ngày về)', () => {
  const missing = workbook([['Mã hàng', 'Ghi chú', 'Vị trí'], ['AAA1', '1T x 5', 'A1']]);
  assert.throws(() => parseImportWorkbook(missing), error => error.code === 'IMPORT_HEADERS_MISSING' && /Ngày về/u.test(error.message));
  const rows = parseImportWorkbook(workbook([['Mã hàng', 'Ghi chú', 'Ngày về', 'Vị trí'], ['AAA1', '1T x 5', '4/10', 'A1']]));
  assert.deepEqual(rows.map(r => [r.row, r.code, r.notes, r.arrivalDate, r.location]), [[2, 'AAA1', '1T x 5', '4/10', 'A1']]);
});

test('Xuất kho (requireArrivalDate=false): 3 cột là đủ, Ngày về có cũng bị bỏ qua, alias cột và thứ tự tùy ý', () => {
  const options = { requireArrivalDate: false };
  const three = parseImportWorkbook(workbook([['Ghi chú', 'VT', 'Mã SP'], ['1T x 50', 'A1', 'AAA1']]), options);
  assert.deepEqual(three.map(r => [r.code, r.notes, r.location, r.arrivalDate]), [['AAA1', '1T x 50', 'A1', '']]);
  const four = parseImportWorkbook(workbook([['Mã hàng', 'Ghi chú', 'Ngày về', 'Vị trí'], ['AAA1', '1T x 50', 'KK 4.10', 'A1']]), options);
  assert.equal(four[0].arrivalDate, '');
  assert.throws(() => parseImportWorkbook(workbook([['Mã hàng', 'Ngày về'], ['AAA1', '1']]), options), error => error.code === 'IMPORT_HEADERS_MISSING' && /Ghi chú, Vị trí/u.test(error.message));
  assert.throws(() => parseImportWorkbook(workbook([['Tên', 'Giá'], ['x', 1]]), options), error => error.code === 'IMPORT_HEADERS_MISSING' && /3 cột: Mã hàng, Ghi chú, Vị trí/u.test(error.message));
});
