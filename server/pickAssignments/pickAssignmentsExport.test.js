'use strict';
process.env.JWT_SECRET ||= 'test-secret';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const express = require('express');
const { createPickAssignmentsWorkbook, COLUMNS } = require('./pickAssignmentsExport');
const { createPickAssignmentsRouter } = require('./pickAssignmentsRoutes');

const ROWS = [
  { productCode: 'AAA1', productName: 'Hàng A', need: 100, location: 'A07', quantity: 60, cartons: 3, stText: '3T x 20' },
  { productCode: 'AAA1', productName: 'Hàng A', need: 100, location: 'B02', quantity: 40, cartons: 2, stText: '2T x 20' },
  { productCode: 'BBB2', productName: '=HYPERLINK("x")', need: 5, location: '', quantity: null, cartons: null, stText: '' },
  { productCode: '', productName: 'bỏ', need: 1 }
];

async function readSheet(buffer) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  return book.worksheets[0];
}

test('workbook: mỗi vị trí 1 dòng, mã chưa chỉ định vẫn có dòng, bỏ dòng thiếu mã, chặn công thức', async () => {
  const file = await createPickAssignmentsWorkbook({ branch: 'HN', orderCode: 'DH/001', rows: ROWS }, { now: new Date('2026-11-05T03:00:00Z') });
  assert.equal(file.rowCount, 3);
  assert.equal(file.fileName, 'chi-dinh-vi-tri_DH_001_20261105_1000.xlsx');
  const sheet = await readSheet(file.buffer);
  assert.deepEqual(sheet.getRow(1).values.slice(1), COLUMNS.map(c => c.header));
  assert.deepEqual(sheet.getRow(2).values.slice(1), ['DH/001', 'AAA1', 'Hàng A', 100, 'A07', 60, 3, '3T x 20']);
  assert.deepEqual(sheet.getRow(3).values.slice(1), ['DH/001', 'AAA1', 'Hàng A', 100, 'B02', 40, 2, '2T x 20']);
  assert.equal(sheet.getRow(4).getCell(3).value, '\'=HYPERLINK("x")');
  assert.equal(sheet.getRow(4).getCell(5).value, null);
  assert.equal(sheet.rowCount, 4);
});

test('POST /export: trả file xlsx, thiếu rows thì 400', async t => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { id: 'ql', vaiTro: 'Quản lý' }; next(); });
  app.use('/api/shipment/pick', createPickAssignmentsRouter({ requireAuth: (req, res, next) => next(), service: {}, pool: {} }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/shipment/pick/export`;
  const headers = { 'Content-Type': 'application/json' };
  const ok = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ branch: 'HN', orderCode: 'DH1', rows: ROWS }) });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /spreadsheetml/);
  assert.match(ok.headers.get('content-disposition'), /chi-dinh-vi-tri_DH1_/);
  const sheet = await readSheet(Buffer.from(await ok.arrayBuffer()));
  assert.equal(sheet.rowCount, 4);
  const bad = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ branch: 'HN' }) });
  assert.equal(bad.status, 400);
});
