'use strict';

// Excel xuất trong worker thread (12/11/2026): cùng nội dung như dựng trong luồng chính, không chặn event loop,
// tự quay về luồng chính khi dataset không gửi được sang worker hoặc khi tắt bằng EXPORT_EXCEL_WORKER=off.
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { renderExcelWorkbook } = require('./exportExcelRenderer');
const { renderExcelInWorker } = require('./exportExcelPool');

function dataset(rows = 3000, extra = {}) {
  return {
    meta: { fileBase: 'TKS_test', reportNotes: [['Nguồn', 'Kiểm thử'], ['Ghi chú', 'Dòng 1\nDòng 2']], ...extra.meta },
    worksheets: [{
      key: 'main', name: 'Bảng/Chính?', autoRowHeight: true,
      columns: [
        { key: 'code', label: 'Mã', type: 'text' },
        { key: 'qty', label: 'SL', type: 'number', fractionDigits: 2, signTone: true },
        { key: 'rate', label: 'Tỷ lệ', type: 'percent' },
        { key: 'at', label: 'Ngày', type: 'date' },
        { key: 'note', label: 'Ghi chú', type: 'text', wrapText: true }
      ],
      rows: Array.from({ length: rows }, (_, i) => ({ code: i % 7 === 0 ? '=SUM(A1)' : 'SP' + i, qty: (i % 5) - 2 + i / 100,
        rate: i / rows, at: `${String(1 + (i % 28)).padStart(2, '0')}/10/2026 08:00`, note: i % 3 ? 'a\nb' : 'x' })),
      ...extra.worksheet
    }]
  };
}

async function read(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  return workbook.worksheets.map(sheet => ({ name: sheet.name, rows: sheet.getSheetValues().slice(1).map(row => JSON.stringify(row)) }));
}

test('worker builds the same workbook as the main thread and does not block the event loop', async () => {
  const input = dataset();
  const inline = await renderExcelWorkbook(structuredClone(input));
  let ticks = 0;
  const ticker = setInterval(() => { ticks++; }, 5);
  const viaWorker = await renderExcelInWorker(input);
  clearInterval(ticker);
  assert.equal(viaWorker.fileName, 'TKS_test.xlsx');
  assert.equal(viaWorker.mimeType, inline.mimeType);
  assert.ok(Buffer.isBuffer(viaWorker.buffer));
  assert.deepEqual(await read(viaWorker), await read(inline));
  assert.ok(ticks > 3, `main thread kept running timers while the workbook was built (${ticks} ticks)`);
});

test('a dataset that cannot be sent to the worker is built in the main thread instead', async () => {
  const input = dataset(5, { meta: { formatter() {} } });
  const file = await renderExcelInWorker(input);
  assert.equal((await read(file))[0].name.trim(), 'Bảng Chính');
});

test('EXPORT_EXCEL_WORKER=off builds in the main thread', async t => {
  const previous = process.env.EXPORT_EXCEL_WORKER;
  process.env.EXPORT_EXCEL_WORKER = 'off';
  t.after(() => { if (previous === undefined) delete process.env.EXPORT_EXCEL_WORKER; else process.env.EXPORT_EXCEL_WORKER = previous; });
  const file = await renderExcelInWorker(dataset(5));
  assert.equal((await read(file)).length, 2);
});
