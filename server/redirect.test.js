'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedirectServer } = require('./redirect');

test('GET/HEAD -> 302, phuong thuc khac -> 307, giu duong dan + query; /health tra 200', async t => {
  const server = createRedirectServer({ target: 'https://app.example.com/' });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;

  let res = await fetch(base + '/stocktake/?dot=4', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://app.example.com/stocktake/?dot=4');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  res = await fetch(base + '/', { method: 'HEAD', redirect: 'manual' });
  assert.equal(res.status, 302);

  res = await fetch(base + '/api/kiotviet/webhook/abc', { method: 'POST', body: '{}', redirect: 'manual' });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'https://app.example.com/api/kiotviet/webhook/abc');

  res = await fetch(base + '/health');
  assert.equal(res.status, 200);
});

test('REDIRECT_TO phai la https://ten-mien, khong co duong dan', () => {
  assert.throws(() => createRedirectServer({ target: '' }), /REDIRECT_TO/);
  assert.throws(() => createRedirectServer({ target: 'http://app.example.com' }), /REDIRECT_TO/);
  assert.throws(() => createRedirectServer({ target: 'https://app.example.com/x' }), /REDIRECT_TO/);
});
