'use strict';

// Worker thread dựng file .xlsx (xem exportExcelPool.js): nhận { id, dataset }, trả { id, ok, buffer, mimeType, fileName }.
const { parentPort } = require('node:worker_threads');
const { renderExcelWorkbook } = require('./exportExcelRenderer');

parentPort.on('message', async ({ id, dataset }) => {
  try {
    const file = await renderExcelWorkbook(dataset);
    parentPort.postMessage({ id, ok: true, buffer: file.buffer, mimeType: file.mimeType, fileName: file.fileName });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, message: (error && error.message) || String(error) });
  }
});
