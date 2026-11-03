'use strict';

// Do thoi gian tung buoc cua 1 request (auth, tung query) de tim cho cham tren ban deploy.
// Ket qua nam o header `Server-Timing` (DevTools > Network > Timing) va log 1 dong khi tong > SLOW_MS.
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();
const SLOW_MS = Number(process.env.REQUEST_TIMING_SLOW_MS) > 0 ? Number(process.env.REQUEST_TIMING_SLOW_MS) : 500;

function round(ms) { return Math.round(ms * 10) / 10; }

// Dat TRUOC requireAuth de buoc `auth` gom ca doc user + doi chieu nhan su + quyen.
function startTiming(req, res, next) {
  const timing = { startedAt: performance.now(), lastMark: performance.now(), entries: [] };
  const originalWriteHead = res.writeHead;
  res.writeHead = function writeHead(...args) {
    if (!res.headersSent) {
      const total = performance.now() - timing.startedAt;
      const all = [...timing.entries, { name: 'total', ms: total }];
      res.setHeader('Server-Timing', all.map(e => `${e.name};dur=${round(e.ms)}`).join(', '));
      if (total >= SLOW_MS) {
        console.warn(`[timing] ${req.method} ${req.originalUrl.split('?')[0]} ${all.map(e => `${e.name}=${round(e.ms)}ms`).join(' ')}`);
      }
    }
    return originalWriteHead.apply(this, args);
  };
  storage.run(timing, next);
}

// Danh dau het 1 buoc middleware (tinh tu moc truoc do), vd markTiming('auth').
function markTiming(name) {
  return function mark(req, res, next) {
    const timing = storage.getStore();
    if (timing) {
      const now = performance.now();
      timing.entries.push({ name, ms: now - timing.lastMark });
      timing.lastMark = now;
    }
    next();
  };
}

// Chay 1 query va ghi thoi gian vao request hien tai (khong co request thi chay thang).
async function timedQuery(pool, name, sql, params) {
  return timedOperation(name, () => pool.query(sql, params));
}

// Independent stages can overlap: measure each stage from its own start.
async function timedOperation(name, operation) {
  const timing = storage.getStore();
  if (!timing) return operation();
  const began = performance.now();
  try {
    return await operation();
  } finally {
    timing.entries.push({ name, ms: performance.now() - began });
  }
}

module.exports = { startTiming, markTiming, timedQuery, timedOperation };
