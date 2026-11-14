'use strict';

// Worker thread dựng file .xlsx (xem exportExcelPool.js): nhận { id, task, payload }, trả { id, ok, buffer, mimeType, fileName }.
// task trong danh sách cố định (EXCEL_TASKS của exportExcelPool) — không nạp module tùy ý theo dữ liệu nhận được.
const { parentPort } = require('node:worker_threads');
const { EXCEL_TASKS } = require('./exportExcelTasks');

parentPort.on('message', async ({ id, task, payload }) => {
  try {
    const run = EXCEL_TASKS[task];
    if (!run) throw new Error(`Không có loại file Excel '${task}'.`);
    const file = await run(payload);
    parentPort.postMessage({ id, ok: true, buffer: file.buffer, mimeType: file.mimeType, fileName: file.fileName });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, message: (error && error.message) || String(error) });
  }
});
