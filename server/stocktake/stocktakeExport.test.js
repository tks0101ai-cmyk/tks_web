'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { checkSpec, createStatsWorkbook, createStocktakeWorkbook, statsHeaders, numberFormat } = require('./stocktakeExport');

test('checkSpec: khop, lech, khong nhan duoc, trong', () => {
  assert.equal(checkSpec('3Tx40+1Tx17', 137).status, 'ok');
  assert.equal(checkSpec('1T x 40c', 40).text, '');
  assert.equal(checkSpec('9*12', 108).status, 'ok');
  assert.equal(checkSpec('1th x 60c', 60).status, 'ok');
  assert.equal(checkSpec('3T x 100 - 20', 280).status, 'ok');
  assert.deepEqual(checkSpec('8t*30', 210), { status: 'diff', computed: 240, text: 'Lệch: quy cách 240, SL 210' });
  assert.equal(checkSpec('1t x 26', 0.72).text, 'Lệch: quy cách 26, SL 0.72');
  for (const spec of ['12tx30 chưa thay vỏ', 'LẤY PIN 1t*60', '1t', '1t x 200 ( tem)', 'vỏ']) {
    assert.deepEqual(checkSpec(spec, 360), { status: 'unreadable', text: 'Không nhân được quy cách' }, spec);
  }
  for (const spec of ['', '  ', null, undefined]) assert.deepEqual(checkSpec(spec, 5), { status: 'blank', text: 'Thiếu quy cách' });
});

test('file thong ke: dung cot, bo dong da bo, co dong tay, sap theo ten roi team roi khu, to mau, chan cong thuc', async () => {
  const rows = [
    {
      code: 'B1', name: 'Bình', note: { printPage: '12' }, lines: [
        { team: 'TEAM 10 : A', zone: 'G2', spec: '1tx10', quantity: 10 },
        { team: 'TEAM 2 : B', zone: 'G9', spec: '8t*30', quantity: 210 },
        { team: 'TEAM 2 : B', zone: 'G1', spec: 'chưa rõ', quantity: 5 },
        { team: 'TEAM 3 : C', zone: 'G5', spec: '1tx1', quantity: 1, removed: true }
      ]
    },
    { code: 'A1', name: 'Ấm', note: null, lines: [{ team: 'Thêm tay', zone: '=SUM(A1)', spec: '', quantity: 7, manual: true }] },
    { code: 'Z9', name: 'Không ai đếm', note: { printPage: '1' }, lines: [] }
  ];
  const file = await createStatsWorkbook({ session: { id: 7, name: 'KK 7/11' }, rows });
  assert.equal(file.fileName, 'kiem-ke-thong-ke-KK-7-11.xlsx');
  assert.match(file.mimeType, /spreadsheetml/u);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const sheet = workbook.getWorksheet('THỐNG KÊ');
  assert.deepEqual(sheet.getRow(1).values.slice(1), statsHeaders());
  assert.deepEqual(statsHeaders(), ['Tên khách hàng', 'Ghi chú', 'Mã hàng', 'Tên hàng', 'Ghi chú hàng hóa', 'Số lượng', 'Kiểm quy cách', 'Trang in', 'Đơn']);
  assert.equal(sheet.rowCount, 5);
  const row = index => sheet.getRow(index).values.slice(1);
  assert.deepEqual(row(2).slice(0, 7), ['Thêm tay', "'=SUM(A1)", 'A1', 'Ấm', '', 7, 'Thiếu quy cách']);
  assert.deepEqual(row(3).slice(0, 8), ['TEAM 2 : B', 'G1', 'B1', 'Bình', 'chưa rõ', 5, 'Không nhân được quy cách', '12']);
  assert.deepEqual(row(4).slice(0, 8), ['TEAM 2 : B', 'G9', 'B1', 'Bình', '8t*30', 210, 'Lệch: quy cách 240, SL 210', '12']);
  assert.deepEqual(row(5).slice(0, 6), ['TEAM 10 : A', 'G2', 'B1', 'Bình', '1tx10', 10]);
  assert.ok(!row(5)[6], 'khop thi de trong');
  const fill = index => sheet.getRow(index).getCell(7).fill;
  assert.equal(fill(4).fgColor.argb, 'FFFECACA');
  assert.equal(fill(3).fgColor.argb, 'FFFEF3C7');
  assert.equal(fill(2).fgColor.argb, 'FFFEF3C7');
  assert.notEqual(fill(5) && fill(5).pattern, 'solid', 'dong khop khong to');
  assert.ok(sheet.autoFilter, 'co bo loc');
});

test('file thong ke: dot khong co dong nao van tao duoc file chi co tieu de', async () => {
  const file = await createStatsWorkbook({ session: { id: 9, name: '' }, rows: [{ code: 'A', name: 'A', lines: [] }] });
  assert.equal(file.fileName, 'kiem-ke-thong-ke-9.xlsx');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  assert.equal(workbook.getWorksheet('THỐNG KÊ').rowCount, 1);
});

test('numberFormat: so nguyen khong co dau cham thua', () => {
  assert.equal(numberFormat(60), '#,##0');
  assert.equal(numberFormat(0), '#,##0');
  assert.equal(numberFormat(1.5), '#,##0.##');
  assert.equal(numberFormat(-5), '#,##0');
});

test('file thong ke: cot Don phan biet dong Kiot va dong tu them; so luong dung dinh dang theo o', async () => {
  const rows = [{ code: 'A', name: 'A', note: null, lines: [
    { team: 'TEAM 1', zone: 'G1', spec: '1t*60', quantity: 60, orderCode: 'DH1' },
    { team: 'Kho', zone: 'G2', spec: '', quantity: 1.5, manual: true, orderCode: '' }
  ] }];
  const file = await createStatsWorkbook({ session: { id: 1, name: 'x' }, rows });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const sheet = workbook.getWorksheet('THỐNG KÊ');
  assert.equal(sheet.getRow(2).getCell(9).value, 'Thêm tay');
  assert.equal(sheet.getRow(3).getCell(9).value, 'DH1');
  assert.equal(sheet.getRow(2).getCell(6).numFmt, '#,##0.##');
  assert.equal(sheet.getRow(3).getCell(6).numFmt, '#,##0');
});

test('Xuat Excel: cot so dung dinh dang theo o, khong co dau cham thua', async () => {
  const file = await createStocktakeWorkbook({ session: { id: 1, name: 'x', branch: 'hanoi' }, employees: [], rows: [
    { code: 'A', name: 'A', counted: 12, stock: 10.5, diffQty: 1.5, diffValue: 3, cost: 2, prevDiff: 0, otherDiff: null, cluster: '', note: null }
  ] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const row = workbook.getWorksheet('Kiểm kê').getRow(2);
  assert.equal(row.getCell(3).numFmt, '#,##0');
  assert.equal(row.getCell(4).numFmt, '#,##0.##');
  assert.equal(row.getCell(12).numFmt, '#,##0');
});
