'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createInflightLimit, routeKey } = require('./inflightLimit');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function startApp(t, options) {
  const gates = [];
  const app = express();
  app.use(createInflightLimit({ identify: req => 'u:' + (req.headers['x-user'] || 'a'), logger: { warn() {} }, ...options }));
  const slow = async (req, res) => { const gate = deferred(); gates.push(gate); await gate.promise; res.json({ ok: true }); };
  app.get('/api/product-report', slow);
  app.get('/api/product-report/containers/meta', slow);
  app.get('/api/stocktake/sessions/:id/board', slow);
  app.post('/api/product-report', slow);
  app.get('/api/other', slow);
  app.get('/api/stocktake/sessions/:id/events', slow);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (path, { user = 'a', method = 'GET', signal } = {}) => fetch(base + path, { method, headers: { 'x-user': user }, signal });
  const waitGates = async n => { while (gates.length < n) await new Promise(r => setTimeout(r, 5)); };
  const openAll = () => { for (const gate of gates.splice(0)) gate.resolve(); };
  return { call, waitGates, openAll, gates };
}

test('routeKey gop doan co so thanh :id', () => {
  assert.equal(routeKey('/api/stocktake/sessions/4/board'), '/api/stocktake/sessions/:id/board');
  assert.equal(routeKey('/api/shipment/lifecycle/DH022541/override'), '/api/shipment/lifecycle/:id/override');
});

test('request GET thu 5 cung nguoi cung duong dan bi 429, nguoi khac / duong dan khac / POST khong bi', async t => {
  const app = await startApp(t, { max: 4 });
  const first = [1, 2, 3, 4].map(() => app.call('/api/product-report'));
  await app.waitGates(4);
  const blocked = await app.call('/api/product-report');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '2');
  assert.equal((await blocked.json()).code, 'TOO_MANY_INFLIGHT');
  const others = [app.call('/api/product-report', { user: 'b' }), app.call('/api/product-report/containers/meta'),
    app.call('/api/product-report', { method: 'POST' }), app.call('/api/other')];
  await app.waitGates(8);
  app.openAll();
  for (const res of await Promise.all([...first, ...others])) assert.equal(res.status, 200);
  const again = app.call('/api/product-report');
  await app.waitGates(1);
  app.openAll();
  assert.equal((await again).status, 200, 'xong thi tra suat');
});

test('SSE /events khong bi tinh: mo nhieu tab cung dot van duoc', async t => {
  const app = await startApp(t, { max: 1 });
  const streams = [1, 2, 3].map(() => app.call('/api/stocktake/sessions/4/events'));
  await app.waitGates(3);
  app.openAll();
  for (const res of await Promise.all(streams)) assert.equal(res.status, 200);
});

test('client huy giua chung thi van giu suat toi khi handler xong', async t => {
  const app = await startApp(t, { max: 1 });
  const controller = new AbortController();
  const aborted = app.call('/api/stocktake/sessions/4/board', { signal: controller.signal }).catch(error => error);
  await app.waitGates(1);
  controller.abort();
  await aborted;
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await app.call('/api/stocktake/sessions/9/board')).status, 429, 'handler cu chua xong');
  app.openAll();
  await new Promise(r => setTimeout(r, 30));
  const next = app.call('/api/stocktake/sessions/9/board');
  await app.waitGates(1);
  app.openAll();
  assert.equal((await next).status, 200);
});

test('handler khong bao gio xong sau khi client huy: tra suat sau holdAfterCloseMs', async t => {
  const app = await startApp(t, { max: 1, holdAfterCloseMs: 50 });
  const controller = new AbortController();
  const aborted = app.call('/api/product-report', { signal: controller.signal }).catch(error => error);
  await app.waitGates(1);
  controller.abort();
  await aborted;
  await new Promise(r => setTimeout(r, 120));
  const next = app.call('/api/product-report');
  await app.waitGates(2);
  app.openAll();
  assert.equal((await next).status, 200);
});
