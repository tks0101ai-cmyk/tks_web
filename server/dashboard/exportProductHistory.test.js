'use strict';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const repository = require('./productHistoryRepository');
const service = require('./exportService');
const allowed = { canViewProducts: true, canViewSales: true };
const keys = ['time', 'type', 'documentCode', 'customerName', 'quantity'];
const payload = extra => ({ tableKey: 'products.productHistory', context: { productCode: 'SP1', historyType: 'return', historyQuery: 'Khách' }, columns: { product_history: keys }, ...extra });

test('history export denies absent product/sales permissions and hides price without explicit permission', async () => {
  for (const options of [{}, { canViewProducts: true }, { canViewSales: true }]) {
    await assert.rejects(service.getExportFields(payload(), 'Hà Nội', options), { statusCode: 403 });
    await assert.rejects(service.createExport(payload(), 'Hà Nội', options), { statusCode: 403 });
  }
  const fields = await service.getExportFields(payload(), 'Hà Nội', allowed);
  assert.deepEqual(fields.worksheets[0].fields.map(f => f.key), keys);
  const priced = await service.getExportFields(payload(), 'Hà Nội', { ...allowed, canViewPrice: true });
  assert.equal(priced.worksheets[0].fields.at(-1).key, 'unitCost');
  assert.equal(priced.worksheets[0].fields.at(-1).selected, false);
  await assert.rejects(service.getExportDataset(payload({ columns: { product_history: ['unitCost'] } }), 'Hà Nội', allowed), { code: 'EXPORT_FIELD_NOT_ALLOWED' });
});

test('history Excel exports every result, forwards whitelist sort/filter, preserves Vietnam clock and numeric quantity', async () => {
  const original = repository.getProductHistoryForExport;
  let args;
  repository.getProductHistoryForExport = async input => {
    args = input;
    return { from: '2026-08-06', to: '2026-11-04', rows: Array.from({ length: 205 }, (_, i) => ({ time: '2026-11-04T09:15:30', type: ['invoice', 'return', 'order'][i % 3], documentCode: `HD${i}`, branch: i % 2 ? 'saigon' : 'hanoi', customerName: 'Khách A', quantity: '-1.5', unitCost: '1200' })) };
  };
  try {
    const request = payload({ tableSort: { label: 'Số lượng', direction: 'asc' } });
    const dataset = await service.getExportDataset(request, 'Sài Gòn', allowed);
    assert.equal(dataset.meta.branch, 'Cả hai');
    assert.ok(dataset.meta.reportNotes.some(note => note[0] === 'Mã hàng' && note[1] === 'SP1'));
    assert.ok(dataset.meta.reportNotes.some(note => note[0] === 'Khoảng thời gian' && note[1] === '06/08/2026 – 04/11/2026'));
    assert.ok(dataset.meta.reportNotes.some(note => note[0] === 'Loại giao dịch' && note[1] === 'Trả hàng'));
    assert.ok(dataset.meta.reportNotes.some(note => note[0] === 'Từ khóa tìm' && note[1] === 'Khách'));
    assert.equal(dataset.worksheets[0].rows.length, 205);
    assert.deepEqual(args, { code: 'SP1', q: 'Khách', type: 'return', sort: 'quantity', dir: 'asc', signal: undefined });
    const file = await service.createExport(request, 'Hà Nội', allowed);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    const sheet = workbook.worksheets[0];
    let header;
    sheet.eachRow(row => { if (row.getCell(1).value === 'Thời gian') header = row.number; });
    assert.ok(header);
    assert.deepEqual(sheet.getRow(header).values.slice(1), ['Thời gian', 'Loại giao dịch', 'Mã giao dịch', 'Khách hàng', 'Số lượng']);
    const first = sheet.getRow(header + 1);
    assert.equal(first.getCell(1).value.toISOString(), '2026-11-04T09:15:30.000Z');
    assert.equal(first.getCell(2).value, 'Hóa đơn');
    assert.equal(first.getCell(3).value, 'HD0 · HN');
    assert.equal(sheet.getRow(header + 2).getCell(3).value, 'HD1 · SG');
    assert.equal(sheet.getRow(header + 3).getCell(2).value, 'Đơn hàng Phiếu tạm');
    assert.equal(first.getCell(5).value, -1.5);
    assert.equal(sheet.getRow(header + 205).getCell(5).value, -1.5);
  } finally { repository.getProductHistoryForExport = original; }
});


test('history export maps each screen sort label, ignores arbitrary sort and respects selected column order', async () => {
  const original = repository.getProductHistoryForExport;
  const calls = [];
  repository.getProductHistoryForExport = async args => {
    calls.push(args);
    return { rows: [{ time: '2026-11-04T09:00:00', type: 'return', documentCode: 'TH1', branch: 'saigon', customerName: 'A', quantity: 0, unitCost: '1200.5' }] };
  };
  try {
    for (const [label, sort] of [['Thời gian', 'time'], ['Loại giao dịch', 'type'], ['Mã giao dịch', 'documentCode'], ['Khách hàng', 'customerName'], ['Số lượng', 'quantity']]) {
      await service.getExportDataset(payload({ tableSort: { label, direction: 'asc' } }), 'Hà Nội', allowed);
      assert.equal(calls.at(-1).sort, sort);
      assert.equal(calls.at(-1).dir, 'asc');
    }
    const request = payload({ context: { productCode: 'SP2' }, tableSort: { label: 'DROP TABLE', direction: 'asc' }, columns: { product_history: ['quantity', 'unitCost', 'type'] } });
    const dataset = await service.getExportDataset(request, 'Hà Nội', { ...allowed, canViewPrice: true });
    assert.deepEqual(calls.at(-1), { code: 'SP2', q: '', type: 'all', sort: 'time', dir: 'desc', signal: undefined });
    assert.deepEqual(dataset.worksheets[0].columns.map(c => c.key), ['quantity', 'unitCost', 'type']);
    const file = await service.createExport(request, 'Hà Nội', { ...allowed, canViewPrice: true });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file.buffer);
    let found = false;
    book.worksheets[0].eachRow(row => {
      if (row.getCell(3).value === 'Trả hàng') {
        found = true;
        assert.equal(row.getCell(1).value, 0);
        assert.equal(row.getCell(2).value, 1200.5);
      }
    });
    assert.equal(found, true);
    const longQuery = 'a'.repeat(500);
    const longFile = await service.createExport(payload({ context: { productCode: 'SP2', historyQuery: longQuery } }), 'Hà Nội', allowed);
    assert.equal(calls.at(-1).q, longQuery, 'full query over 200 characters reaches repository');
    const longBook = new ExcelJS.Workbook();
    await longBook.xlsx.load(longFile.buffer);
    assert.equal(longBook.worksheets[0].getRow(2).getCell(5).value, 0);
    const callCount = calls.length;
    await assert.rejects(service.createExport(payload({ context: { productCode: 'SP2', historyQuery: 'a'.repeat(501) } }), 'Hà Nội', allowed), { statusCode: 400 });
    assert.equal(calls.length, callCount, 'invalid query is rejected before database access');
  } finally { repository.getProductHistoryForExport = original; }
});

