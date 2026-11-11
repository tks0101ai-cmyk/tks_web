'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSheetValuesCache } = require('./sheetValuesCache');

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup() {
  let time = 0;
  const loads = [];
  const cache = createSheetValuesCache({
    ttlMs: 15000,
    now: () => time,
    load: name => { const d = deferred(); loads.push({ name, ...d }); return d.promise; }
  });
  return { cache, loads, advance: ms => { time += ms; } };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('con han: tra cache, khong doc lai; het han khong allowStale: cho ban moi', async () => {
  const { cache, loads, advance } = setup();
  const first = cache.get('A');
  loads[0].resolve([['v1']]);
  assert.deepEqual(await first, [['v1']]);
  assert.deepEqual(await cache.get('A'), [['v1']]);
  assert.equal(loads.length, 1);
  advance(15001);
  const second = cache.get('A');
  assert.equal(loads.length, 2, 'het han thi doc lai');
  loads[1].resolve([['v2']]);
  assert.deepEqual(await second, [['v2']]);
});

test('allowStale: het han tra ngay ban cu, lam moi nen dung 1 luot; xong thi dung ban moi', async () => {
  const { cache, loads, advance } = setup();
  const first = cache.get('A');
  loads[0].resolve([['v1']]);
  await first;
  advance(15001);
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v1']], 'khong cho mang');
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v1']]);
  assert.equal(loads.length, 2, 'chi 1 luot lam moi nen');
  loads[1].resolve([['v2']]);
  await flush();
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v2']]);
});

test('allowStale nhung chua co du lieu: cho doc nhu thuong', async () => {
  const { cache, loads } = setup();
  const pending = cache.get('A', { allowStale: true });
  assert.equal(loads.length, 1);
  loads[0].resolve([['v1']]);
  assert.deepEqual(await pending, [['v1']]);
});

test('lam moi nen loi: giu ban cu, bao onBackgroundError, lan sau thu lai', async () => {
  let time = 0;
  const errors = [];
  const results = [[['v1']], new Error('quota'), [['v3']]];
  let calls = 0;
  const cache = createSheetValuesCache({
    ttlMs: 15000, now: () => time, onBackgroundError: e => errors.push(e.message),
    load: async () => { const r = results[calls++]; if (r instanceof Error) throw r; return r; }
  });
  await cache.get('A');
  time = 15001;
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v1']]);
  await flush();
  assert.deepEqual(errors, ['quota']);
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v1']], 'van ban cu');
  await flush();
  assert.equal(calls, 3, 'thu lai');
  assert.deepEqual(await cache.get('A', { allowStale: true }), [['v3']]);
});

test('khong allowStale + doc loi: nem loi; invalidate bo ca luot doc dang chay', async () => {
  const { cache, loads } = setup();
  const failing = cache.get('A');
  loads[0].reject(new Error('down'));
  await assert.rejects(failing, /down/);
  const before = cache.get('B');
  cache.invalidate();
  loads[1].resolve([['truoc khi ghi']]);
  await before;
  const after = cache.get('B');
  assert.equal(loads.length, 3, 'sau invalidate phai doc lai, khong dung ket qua cua luot truoc');
  loads[2].resolve([['sau khi ghi']]);
  assert.deepEqual(await after, [['sau khi ghi']]);
});

test('staleIfErrorMs: doc lai loi thi tra ban tot gan nhat (khong nem), qua han thi nem; chua co ban nao van nem', async () => {
  let time = 0;
  const errors = [];
  const results = [[['v1']], new Error('quota'), new Error('quota 2'), [['v4']]];
  let calls = 0;
  const cache = createSheetValuesCache({
    ttlMs: 15000, staleIfErrorMs: 600000, now: () => time, onBackgroundError: e => errors.push(e.message),
    load: async () => { const r = results[calls++]; if (r instanceof Error) throw r; return r; }
  });
  await cache.get('A');
  time = 15001;
  assert.deepEqual(await cache.get('A'), [['v1']], 'Google loi: van tra ban cu');
  assert.deepEqual(errors, ['quota']);
  time = 15001 + 600001;
  await assert.rejects(cache.get('A'), /quota 2/, 'ban cu qua 10 phut: bao loi that');
  assert.deepEqual(await cache.get('A'), [['v4']], 'lan sau doc lai binh thuong');
  const empty = createSheetValuesCache({ ttlMs: 15000, staleIfErrorMs: 600000, load: async () => { throw new Error('down'); } });
  await assert.rejects(empty.get('A'), /down/);
});
