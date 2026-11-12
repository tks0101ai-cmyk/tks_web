'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('SSE initial connection and reconnection reload committed leave snapshot', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/humanresources/index.html'), 'utf8');
  const start = html.indexOf('let leaveEventSource = null;');
  const end = html.indexOf('// ---------- Init ----------', start);
  let stream;
  const calls = [];
  const context = { window: {}, EventSource: class {
    constructor() { stream = this; }
    close() {}
  }, loadLeaveRequests: silent => calls.push(silent), console };
  context.window.EventSource = context.EventSource;
  vm.runInNewContext(html.slice(start, end), context);
  context.setupLeaveRealtimeStream();
  assert.equal(typeof stream.onopen, 'function');
  stream.onopen();
  stream.onopen();
  assert.deepEqual(calls, [true, true]);
});

// 12/11/2026: tín hiệu tới lúc tab ẩn chỉ ghi nhớ; tab đang xem gom tín hiệu dồn dập trong 1 s thành 1 lần tải.
test('leave events defer while the tab is hidden and coalesce bursts while visible', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../public/humanresources/index.html'), 'utf8');
  const start = html.indexOf('let leaveEventSource = null;');
  const end = html.indexOf('// ---------- Init ----------', start);
  let stream;
  const calls = [];
  const timers = [];
  const document = { visibilityState: 'hidden' };
  const context = { window: {}, document, EventSource: class { constructor() { stream = this; } close() {} },
    loadLeaveRequests: silent => calls.push(silent), console, Date,
    setTimeout: fn => { timers.push(fn); return timers.length; },
    rawLeaveRequests: [], matchesLeaveScope: () => true, renderStats() {}, renderTable() {}, removeDeletedLeave() {} };
  context.window.EventSource = context.EventSource;
  vm.runInNewContext(html.slice(start, end), context);
  context.setupLeaveRealtimeStream();
  const send = type => stream.onmessage({ data: JSON.stringify({ type, data: { request_id: 'NP-1' } }) });
  send('LEAVE_STATUS_CHANGED');
  send('LEAVE_REQUEST_CREATED');
  assert.equal(calls.length, 0, 'hidden tab does not call the server');
  assert.equal(timers.length, 0);
  document.visibilityState = 'visible';
  vm.runInNewContext('reloadLeaveIfStale()', context);
  assert.deepEqual(calls, [true], 'one reload when the tab becomes visible');
  send('LEAVE_STATUS_CHANGED');
  send('LEAVE_STATUS_CHANGED');
  send('LEAVE_REQUEST_DELETED');
  assert.equal(timers.length, 1, 'a burst schedules one reload');
  timers[0]();
  assert.deepEqual(calls, [true, true]);
});
