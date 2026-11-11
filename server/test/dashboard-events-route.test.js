'use strict';

// GET /api/dashboard/events (SSE): nhiều tín hiệu 'updated' dồn dập chỉ gửi 1 event xuống mỗi trình duyệt (11/11/2026).

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const router = require('../routes');
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');

function eventsHandler() {
  const layer = router.stack.find(item => item.route && item.route.path === '/api/dashboard/events' && item.route.methods.get);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

test('dashboard-updated events are coalesced per connection and stop after close', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const req = new EventEmitter();
  req.socket = { setTimeout() {} };
  const chunks = [];
  const res = { writeHead() {}, write: chunk => chunks.push(chunk) };
  const before = dashboardRollupEvents.listenerCount('updated');
  eventsHandler()(req, res);
  const events = () => chunks.filter(chunk => chunk.startsWith('event: dashboard-updated'));

  dashboardRollupEvents.emit('updated', { at: 1 });
  dashboardRollupEvents.emit('updated', { at: 2 });
  dashboardRollupEvents.emit('updated', { at: 3 });
  assert.equal(events().length, 0, 'waits for the burst to end');
  t.mock.timers.tick(2000);
  assert.equal(events().length, 1, 'one event for the whole burst');
  assert.match(events()[0], /"at":3/, 'carries the latest payload');

  dashboardRollupEvents.emit('updated', { at: 4 });
  t.mock.timers.tick(2000);
  assert.equal(events().length, 2, 'a later change is still delivered');

  dashboardRollupEvents.emit('updated', { at: 5 });
  req.emit('close');
  t.mock.timers.tick(5000);
  assert.equal(events().length, 2, 'nothing is written after close');
  assert.equal(dashboardRollupEvents.listenerCount('updated'), before);
});
