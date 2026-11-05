const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const excel = require('../public/shared/purchase-workbook');
const columns = [
  { k: 'rowKey', l: 'Khóa dòng', t: 'text' },
  { k: 'productCode', l: 'Mã SP', t: 'text' },
  { k: 'productName', l: 'Tên SP', t: 'text' },
  { k: 'productNameCn', l: 'Tên SP', cn: '品名', t: 'text' },
  { k: 'cartonCount', l: 'Số thùng', t: 'num' },
  { k: 'listedAt', l: 'Lên list', t: 'date' },
  { k: 'totalQty', l: 'Tổng SL', t: 'num', d: 1 }
];
function book(data, name = 'Đặt hàng') {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(data), name);
  return workbook;
}

test('row key is always the first exported column and long branch keys remain text', () => {
  const workbook = excel.exportWorkbook([{ rowKey: 'D00001.02.01.01', productCode: '00123', cartonCount: 2 }], columns, ['productCode', 'cartonCount']);
  assert.equal(workbook.Sheets['Đặt hàng'].A1.v, 'Khóa dòng');
  const result = excel.parseWorkbook(excel.read(excel.bytes(workbook)), columns);
  assert.equal(result.rows[0].rowKey, 'D00001.02.01.01');
  assert.equal(result.rows[0].productCode, '00123');
});

test('blank cells stay absent; formulas/computed columns are not imported as writable fields', () => {
  const result = excel.parseWorkbook(book([['Mã SP', 'Tên SP (Việt)', 'Tổng SL'], ['AC305', '', 999999]]), columns);
  assert.equal(result.rows[0].productName, undefined);
  assert.equal(result.rows[0].totalQty, undefined);
  assert.deepEqual(result.ignored, ['Tổng SL']);
});

test('Excel dates and explicit Vietnamese dates normalize without timezone drift', () => {
  assert.equal(excel.dateValue('03/11/2026'), '2026-11-03');
  assert.equal(excel.dateValue('31/02/2026'), null);
  const result = excel.parseWorkbook(book([['Mã SP', 'Lên list'], ['A', 46329]]), columns);
  assert.equal(result.rows[0].listedAt, '2026-11-03');
});

test('invalid date/ambiguous numeric values remain editable errors instead of being guessed', () => {
  const result = excel.parseWorkbook(book([['Mã SP', 'Số thùng', 'Lên list'], ['A', '1,00', 'someday']]), columns);
  assert.equal(result.rows.length, 1);
  assert.equal(Object.keys(result.rows[0].__cellErrors).length, 2);
});

test('duplicate/unknown headers and missing product-code column reject the whole file', () => {
  for (const data of [
    [['Mã SP', 'Mã SP'], ['A', 'B']],
    [['Mã SP', 'Unknown column'], ['A', 1]],
    [['Tên SP (Việt)'], ['A']]
  ]) assert.throws(() => excel.parseWorkbook(book(data), columns));
});

test('multi-sheet files use explicit selected sheet and preserve string values as text', () => {
  const workbook = book([['Mã SP'], ['A']], 'First');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Mã SP', 'Tên SP (Việt)'], ['B', '=not-a-formula']]), 'Second');
  const result = excel.parseWorkbook(workbook, columns, 'Second');
  assert.equal(result.rows[0].productCode, 'B');
  const exported = excel.exportWorkbook(result.rows, columns);
  assert.equal(exported.Sheets['Đặt hàng'].C2.t, 's');
  assert.equal(exported.Sheets['Đặt hàng'].C2.f, undefined);
});

test('spreadsheet cell errors and formulas without cached values cannot silently become blank', () => {
  const workbook = book([['Mã SP', 'Số thùng', 'Lên list'], ['A', 2, '2026-11-03']]);
  workbook.Sheets['Đặt hàng'].B2 = { t: 'e', v: 7, w: '#DIV/0!' };
  workbook.Sheets['Đặt hàng'].C2 = { t: 'n', f: 'TODAY()' };
  const result = excel.parseWorkbook(workbook, columns);
  assert.equal(Object.keys(result.rows[0].__cellErrors).length, 2);
});

test('total CNY export displays three decimals while preserving numeric value',()=>{const catalog=require('../public/shared/purchase-columns');const book=excel.exportWorkbook([{rowKey:'D00001',totalCny:1668.8}],catalog,['totalCny']);const cell=book.Sheets[book.SheetNames[0]].B2;assert.equal(cell.v,1668.8);assert.equal(XLSX.utils.format_cell(cell),'1,668.800')});

test('date-time cells export as Excel dates and roundtrip hours/minutes',()=>{const catalog=require('../public/shared/purchase-columns');const b=excel.exportWorkbook([{rowKey:'D00001',productCode:'A',listedAt:'2026-11-03T14:25',orderedNote:'2026-11-04T09:15'}],catalog,['productCode','listedAt','orderedNote']);const parsed=excel.parseWorkbook(excel.read(excel.bytes(b)),catalog);assert.equal(parsed.rows[0].listedAt,'2026-11-03T14:25');assert.equal(parsed.rows[0].orderedNote,'2026-11-04T09:15');assert.equal(excel.dateTimeValue('31/02/2026 09:15'),null);assert.equal(excel.dateTimeValue('2026-11-03T25:00'),null)});
