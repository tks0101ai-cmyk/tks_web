'use strict';
process.env.JWT_SECRET ||= 'test-secret';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createStockPositionsRouter } = require('./stockPositionsRoutes');

const MANAGER = { id: 'ql', vaiTro: 'Quản lý' };

async function start(t, { user = MANAGER, scope = 'Cả hai' } = {}) {
  const calls = [];
  const record = name => async (ctx, ...args) => { calls.push([name, ...args]); return { ok: name }; };
  const ordersService = {
    getCurrent: async (ctx, branch, options) => { calls.push(['getCurrent', branch, options, ctx.scope]); return { order: null }; },
    addLine: record('addLine'), updateLine: record('updateLine'), removeLine: record('removeLine'), confirm: record('confirm'), list: record('list'), get: record('get'),
    events: async (ctx, id, options) => { calls.push(['events', id, options.limit]); return { events: [] }; },
    importLines: async (ctx, id, options) => { calls.push(['importLines', id, options.fileName, options.buffer.length]); return { counts: {} }; }
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = user; next(); });
  app.use(createStockPositionsRouter({
    requireAuth: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập.' })),
    resolveBranch: (req, res, next) => { req.branch = scope; next(); },
    service: {}, ordersService
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  return { calls, base: `http://127.0.0.1:${server.address().port}/api/stock-positions/stock-out-orders` };
}

const send = (url, method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('Quản lý: đọc đơn tạm (được tạo), thêm/sửa/xóa dòng, chốt đều gọi service đúng tham số', async t => {
  const { base, calls } = await start(t, { scope: 'Hà Nội' });
  const current = await (await fetch(base + '/current?branch=HN')).json();
  assert.equal(current.canEdit, true);
  assert.deepEqual(calls[0], ['getCurrent', 'HN', { create: true }, ['HN']]);
  assert.equal((await send(base + '/7/lines', 'POST', { code: 'A', location: 'A1', notes: '1T x 5' })).status, 201);
  assert.equal((await send(base + '/lines/9', 'PATCH', { notes: '2T x 5', version: 1 })).status, 200);
  assert.equal((await send(base + '/lines/9?version=2', 'DELETE')).status, 200);
  assert.equal((await send(base + '/7/confirm', 'POST', { version: 4 })).status, 200);
  assert.deepEqual(calls.slice(1).map(call => call[0]), ['addLine', 'updateLine', 'removeLine', 'confirm']);
  assert.deepEqual(calls.at(-1), ['confirm', 7, { version: 4 }]);
  assert.deepEqual(calls[3], ['removeLine', 9, 2]);
  assert.equal((await fetch(base + '?branch=HN')).status, 200);
  assert.equal((await fetch(base + '/7')).status, 200);
});

test('Lưu vết đơn: GET /:id/events gọi service với id và limit', async t => {
  const { base, calls } = await start(t, { scope: 'Hà Nội' });
  assert.equal((await fetch(base + '/7/events?limit=20')).status, 200);
  assert.deepEqual(calls[0], ['events', 7, '20']);
});

test('Khách chỉ xem: đọc được đơn (không tạo), mọi thao tác ghi bị 403', async t => {
  const { base, calls } = await start(t, { user: { vaiTro: 'Khách' } });
  const current = await (await fetch(base + '/current?branch=HN')).json();
  assert.equal(current.canEdit, false);
  assert.deepEqual(calls[0].slice(0, 3), ['getCurrent', 'HN', { create: false }]);
  for (const [method, url, body] of [['POST', '/7/lines', {}], ['PATCH', '/lines/9', {}], ['DELETE', '/lines/9', undefined], ['POST', '/7/confirm', {}]]) {
    assert.equal((await send(base + url, method, body)).status, 403, method + ' ' + url);
  }
  assert.equal(calls.length, 1, 'không gọi service ghi');
});

test('Chưa đăng nhập 401', async t => {
  const { base } = await start(t, { user: null });
  assert.equal((await fetch(base + '/current?branch=HN')).status, 401);
});
