const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createRequestTracker, startLoopStallWatch } = require('./loopStallWatch');

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

function fakeRes(contentType) {
  const res = new EventEmitter();
  res.getHeader = name => (name.toLowerCase() === 'content-type' ? contentType : undefined);
  return res;
}

function send(tracker, method, url, contentType) {
  const req = { method, originalUrl: url };
  const res = fakeRes(contentType);
  let nextCalled = false;
  tracker.middleware(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  return res;
}

test('request dang chay nam trong inflight, xong thi chuyen sang done', () => {
  const clock = fakeClock();
  const tracker = createRequestTracker({ now: clock.now });
  const res = send(tracker, 'GET', '/api/shipment/lifecycle?page=2');
  clock.advance(300);
  let snap = tracker.snapshot(0);
  assert.deepEqual(snap.inflight, [{ method: 'GET', path: '/api/shipment/lifecycle', ms: 300 }]);
  assert.deepEqual(snap.done, []);

  res.emit('finish');
  res.emit('close'); // close sau finish khong duoc ghi trung
  clock.advance(50);
  snap = tracker.snapshot(0);
  assert.deepEqual(snap.inflight, []);
  assert.deepEqual(snap.done, [{ method: 'GET', path: '/api/shipment/lifecycle', ms: 300 }]);
});

test('client huy giua chung (chi co close) thi khong ro ri inflight', () => {
  const clock = fakeClock();
  const tracker = createRequestTracker({ now: clock.now });
  const res = send(tracker, 'GET', '/api/product-report');
  res.emit('close');
  assert.equal(tracker.size(), 0);
});

test('bo qua ket noi SSE ca khi dang mo lan khi da dong', () => {
  const clock = fakeClock();
  const tracker = createRequestTracker({ now: clock.now });
  const sse = send(tracker, 'GET', '/api/stocktake/sessions/5/events', 'text/event-stream; charset=utf-8');
  send(tracker, 'GET', '/api/a');
  clock.advance(5000);
  assert.deepEqual(tracker.snapshot(0).inflight.map(r => r.path), ['/api/a']);
  sse.emit('close');
  assert.deepEqual(tracker.snapshot(0).done, []);
});

test('done chi gom request xong tu moc since, sap xep lau nhat truoc va gioi han so dong', () => {
  const clock = fakeClock();
  const tracker = createRequestTracker({ now: clock.now });
  const early = send(tracker, 'GET', '/api/early');
  clock.advance(100);
  early.emit('finish'); // xong luc 1100
  const since = clock.now() + 1;
  const responses = [100, 400, 200].map(ms => ({ ms, res: send(tracker, 'GET', '/api/r' + ms) }));
  for (const { ms, res } of [...responses].sort((a, b) => a.ms - b.ms)) {
    clock.advance(ms - (clock.now() - 1100));
    res.emit('finish');
  }
  const snap = tracker.snapshot(since, 2);
  assert.deepEqual(snap.done.map(r => r.path), ['/api/r400', '/api/r200']);
});

test('done cu hon recentMs va vuot maxRecent bi xoa', () => {
  const clock = fakeClock();
  const tracker = createRequestTracker({ now: clock.now, recentMs: 2000, maxRecent: 3 });
  send(tracker, 'GET', '/api/old').emit('finish');
  clock.advance(2500);
  for (const p of ['/api/1', '/api/2', '/api/3', '/api/4']) send(tracker, 'GET', p).emit('finish');
  assert.deepEqual(tracker.snapshot(0, 10).done.map(r => r.path).sort(), ['/api/2', '/api/3', '/api/4']);
});

test('duong dan qua dai bi cat ngan', () => {
  const tracker = createRequestTracker({ now: fakeClock().now });
  send(tracker, 'GET', '/api/' + 'x'.repeat(300));
  assert.equal(tracker.snapshot(0).inflight[0].path.length, 100);
});

function setupWatch(options = {}) {
  const clock = fakeClock();
  const tracker = createRequestTracker({ now: clock.now });
  const warns = [];
  let tickFn = null;
  let unrefCalled = false;
  let cleared = false;
  const timer = { unref() { unrefCalled = true; } };
  const watch = startLoopStallWatch({
    tracker,
    thresholdMs: 1000,
    intervalMs: 100,
    now: clock.now,
    logger: { warn: line => warns.push(line) },
    setIntervalFn: (fn, ms) => { assert.equal(ms, 100); tickFn = fn; return timer; },
    clearIntervalFn: t => { assert.equal(t, timer); cleared = true; },
    ...options
  });
  return { clock, tracker, warns, watch, tick: () => tickFn(), unref: () => unrefCalled, cleared: () => cleared };
}

test('khong log khi event loop tre duoi nguong', () => {
  const w = setupWatch();
  for (let i = 0; i < 5; i += 1) { w.clock.advance(100 + 50); w.tick(); }
  w.clock.advance(100 + 999); w.tick();
  assert.deepEqual(w.warns, []);
  assert.equal(w.unref(), true);
});

test('event loop dung >= nguong thi log ca request dang chay va request vua xong trong khoang dung', () => {
  const w = setupWatch();
  const before = send(w.tracker, 'GET', '/api/before');
  w.clock.advance(100);
  before.emit('finish'); // xong truoc khi dung -> khong liet ke
  w.tick();

  const slow = send(w.tracker, 'GET', '/api/shipment/lifecycle');
  send(w.tracker, 'POST', '/api/shipment/pick');
  w.clock.advance(1200);
  slow.emit('finish');
  w.clock.advance(100);
  w.tick(); // tick cach tick truoc 1300 ms -> lag 1200 ms

  assert.equal(w.warns.length, 1);
  assert.equal(w.warns[0],
    '[loop-stall] lag=1200ms inflight=1 [POST /api/shipment/pick 1300ms] done=[GET /api/shipment/lifecycle 1200ms]');
});

test('stop xoa timer', () => {
  const w = setupWatch();
  w.watch.stop();
  assert.equal(w.cleared(), true);
});
