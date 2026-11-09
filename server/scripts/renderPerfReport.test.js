'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeHourly, summarizeTiming, fetchLogs } = require('./renderPerfReport');

test('summarizeHourly: gom theo gio VN, lay poolWaiting lon nhat va RSS lon nhat', () => {
  const rows = summarizeHourly([
    { timestamp: '2026-11-09T02:53:24Z', message: '[Performance] eventLoopP95=21.2ms poolTotal=4 poolIdle=0 poolWaiting=2 cacheHit=0' },
    { timestamp: '2026-11-09T02:54:24Z', message: '[Performance] eventLoopP95=27.3ms poolTotal=4 poolIdle=0 poolWaiting=21 cacheHit=0' },
    { timestamp: '2026-11-09T02:54:24Z', message: '[Memory] rss=590MB heap=296MB external=9MB arrayBuffers=6MB' },
    { timestamp: '2026-11-09T03:01:00Z', message: '[Performance] eventLoopP95=20ms poolTotal=4 poolIdle=4 poolWaiting=0 cacheHit=0' },
    { timestamp: '2026-11-09T03:01:00Z', message: '[timing] GET /api/x total=5ms' }
  ]);
  assert.deepEqual(rows, [
    { hour: '2026-11-09 09', samples: 2, waitingMax: 21, waitingOver10: 1, rssMaxMb: 590 },
    { hour: '2026-11-09 10', samples: 1, waitingMax: 0, waitingOver10: 0, rssMaxMb: 0 }
  ]);
});

test('summarizeTiming: gop so trong duong dan thanh :id, bo query, bo dong trung cua hai logger', () => {
  const rows = summarizeTiming([
    { timestamp: '2026-11-09T02:54:05Z', message: '[timing] GET /api/shipment/pick auth=0.5ms total=19296.7ms' },
    { timestamp: '2026-11-09T02:54:05Z', message: '[timing] GET /api/shipment/pick total=19296.8ms' },
    { timestamp: '2026-11-09T02:55:00Z', message: '[timing] GET /api/stocktake/sessions/4/board total=1000ms' },
    { timestamp: '2026-11-09T02:55:01Z', message: '[timing] GET /api/stocktake/sessions/7/board?x=1 total=3000ms' },
    { timestamp: '2026-11-09T02:55:02Z', message: '[Performance] poolWaiting=3' }
  ]);
  assert.deepEqual(rows, [
    { endpoint: 'GET /api/shipment/pick', count: 1, avgMs: 19297, maxMs: 19297, over5s: 1 },
    { endpoint: 'GET /api/stocktake/sessions/:id/board', count: 2, avgMs: 2000, maxMs: 3000, over5s: 0 }
  ]);
});

test('fetchLogs: canh bao khi het maxPages ma log cu hon van con', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        logs: [{ timestamp: '2026-11-09T02:00:00Z', message: '[timing] GET /api/x total=1ms' }],
        hasMore: true,
        nextEndTime: '2026-11-09T01:00:00Z'
      })
    };
  };
  const warnings = [];
  const entries = await fetchLogs({
    apiKey: 'test', serviceId: 'srv-test', text: '[timing]', hours: 24,
    maxPages: 2, fetchImpl: fakeFetch, warn: msg => warnings.push(msg)
  });
  assert.equal(calls, 2);
  assert.equal(entries.length, 2);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Cắt bớt: đã đọc 2 dòng/);
});
