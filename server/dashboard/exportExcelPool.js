'use strict';

// ==========================================
// Dựng file Excel trong 1 worker thread dùng chung, để ExcelJS (tốn CPU nhiều giây với bảng lớn) không chặn event loop
// của web (log [loop-stall] 12/11/2026: POST /api/export làm đứng cả web tới 4,2 s).
// - Worker tạo khi cần, tự tắt sau WORKER_IDLE_MS không có việc; số file song song vẫn do hàng đợi của exportService giới hạn.
// - Dataset không gửi được sang worker (DataCloneError) hoặc worker lỗi / thoát: dựng ngay trong luồng chính như trước.
// - EXPORT_EXCEL_WORKER=off: tắt worker (dựng trong luồng chính) — công tắc khẩn cấp, không cần deploy lại code.
// ==========================================

const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { renderExcelWorkbook } = require('./exportExcelRenderer');

const WORKER_FILE = path.join(__dirname, 'exportExcelWorker.js');
const WORKER_IDLE_MS = 5 * 60 * 1000;

let worker = null;
let nextId = 0;
let idleTimer = null;
const pending = new Map(); // id -> { resolve, reject, dataset }

function renderInline(dataset) {
  return renderExcelWorkbook(dataset);
}

// Worker hỏng: các việc đang chờ dựng lại trong luồng chính, không bắt người dùng xuất lại.
function recoverPending(reason) {
  const jobs = [...pending.values()];
  pending.clear();
  worker = null;
  if (jobs.length) console.warn('[export] Worker Excel lỗi, dựng lại trong luồng chính:', reason && reason.message ? reason.message : reason);
  for (const job of jobs) renderInline(job.dataset).then(job.resolve, job.reject);
}

function refState() {
  if (!worker) return;
  // Chỉ giữ process sống khi đang có việc (worker rảnh không chặn tắt server / kết thúc test).
  if (pending.size) worker.ref(); else worker.unref();
  clearTimeout(idleTimer);
  if (!pending.size) {
    idleTimer = setTimeout(() => { if (worker && !pending.size) { const w = worker; worker = null; w.terminate().catch(() => {}); } }, WORKER_IDLE_MS);
    idleTimer.unref();
  }
}

function getWorker() {
  if (worker) return worker;
  const created = new Worker(WORKER_FILE);
  created.on('message', ({ id, ok, buffer, mimeType, fileName, message }) => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    if (ok) job.resolve({ buffer: Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), mimeType, fileName });
    else job.reject(new Error(message));
    refState();
  });
  created.on('error', error => { if (worker === created) recoverPending(error); });
  created.on('exit', code => { if (worker === created) recoverPending(new Error(`exit ${code}`)); });
  worker = created;
  return worker;
}

async function renderExcelInWorker(dataset) {
  if (String(process.env.EXPORT_EXCEL_WORKER || '').toLowerCase() === 'off') return renderInline(dataset);
  let target;
  try { target = getWorker(); } catch (error) { return renderInline(dataset); }
  const id = ++nextId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject, dataset }));
  try {
    target.postMessage({ id, dataset });
  } catch (error) {
    pending.delete(id);
    refState();
    return renderInline(dataset); // DataCloneError: dataset có giá trị không gửi được sang worker
  }
  refState();
  return result;
}

module.exports = { renderExcelInWorker, __test__: { state: () => ({ hasWorker: !!worker, pending: pending.size }) } };
