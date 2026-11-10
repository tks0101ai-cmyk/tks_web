'use strict';
// Tim request lam dung event loop: theo doi request dang chay + vua xong, va mot vong
// setInterval nho. Khi vong do chay tre >= nguong (event loop bi chan), in 1 dong
// [loop-stall] liet ke request dang chay va request xong trong khoang bi chan.
// Chi phi: Set.add/delete moi request + 1 phep so sanh moi intervalMs.

const MAX_PATH = 100;

function isSse(res) {
  const type = typeof res.getHeader === 'function' ? res.getHeader('content-type') : '';
  return String(type || '').startsWith('text/event-stream');
}

function createRequestTracker({ now = () => performance.now(), recentMs = 2000, maxRecent = 200 } = {}) {
  const inflight = new Set();
  const recent = []; // { method, path, startedAt, endedAt }, theo thu tu xong

  function prune(at) {
    while (recent.length && (recent[0].endedAt < at - recentMs || recent.length > maxRecent)) recent.shift();
  }

  function middleware(req, res, next) {
    const entry = {
      method: req.method,
      path: String(req.originalUrl || req.url || '').split('?')[0].slice(0, MAX_PATH),
      startedAt: now(),
      res
    };
    inflight.add(entry);
    const done = () => {
      if (!inflight.delete(entry)) return; // finish roi close: chi ghi 1 lan
      if (isSse(res)) return;
      const endedAt = now();
      recent.push({ method: entry.method, path: entry.path, startedAt: entry.startedAt, endedAt });
      prune(endedAt);
    };
    res.once('finish', done);
    res.once('close', done); // client huy giua chung: khong co finish
    next();
  }

  // Request dang chay + request xong sau moc `since`, lau nhat truoc, moi loai toi da `limit`.
  function snapshot(since, limit = 5) {
    const at = now();
    prune(at);
    const top = rows => rows.sort((a, b) => b.ms - a.ms).slice(0, limit);
    const running = [...inflight].filter(e => !isSse(e.res));
    return {
      inflightCount: running.length,
      inflight: top(running.map(e => ({ method: e.method, path: e.path, ms: Math.round(at - e.startedAt) }))),
      done: top(recent.filter(e => e.endedAt > since)
        .map(e => ({ method: e.method, path: e.path, ms: Math.round(e.endedAt - e.startedAt) })))
    };
  }

  return { middleware, snapshot, size: () => inflight.size };
}

function startLoopStallWatch({
  tracker,
  thresholdMs = 1000,
  intervalMs = 100,
  maxListed = 5,
  logger = console,
  now = () => performance.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval
}) {
  let lastTick = now();
  const list = rows => rows.map(r => `${r.method} ${r.path} ${r.ms}ms`).join('; ');

  function check() {
    const at = now();
    const lag = at - lastTick - intervalMs;
    const since = lastTick;
    lastTick = at;
    if (lag < thresholdMs) return;
    const snap = tracker.snapshot(since, maxListed);
    logger.warn(`[loop-stall] lag=${Math.round(lag)}ms inflight=${snap.inflightCount} [${list(snap.inflight)}] done=[${list(snap.done)}]`);
  }

  const timer = setIntervalFn(check, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearIntervalFn(timer), check };
}

module.exports = { createRequestTracker, startLoopStallWatch };
