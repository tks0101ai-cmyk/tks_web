'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTtlSnapshotCache } = require('./ttlSnapshotCache');

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('backgroundRefresh: het han tra ngay ban cu, doc lai nen 1 lan; nhieu request khong cho lan doc cham', async () => {
  let clock = 0;
  const reads = [];
  const cache = createTtlSnapshotCache({
    freshTtlMs: 1000, staleTtlMs: 10000, backgroundRefresh: true, now: () => clock,
    fetch: () => { const d = deferred(); reads.push(d); return d.promise; }
  });
  const first = cache.get();
  reads[0].resolve({ value: 1 });
  assert.equal((await first).value, 1);

  clock = 1500;
  assert.equal((await cache.get()).value, 1, 'khong cho lan doc moi');
  assert.equal((await cache.get()).value, 1);
  assert.equal(reads.length, 2, 'chi 1 lan doc nen');
  reads[1].resolve({ value: 2 });
  await tick();
  const fresh = await cache.get();
  assert.deepEqual([fresh.value, fresh.stale], [2, false]);
});

test('backgroundRefresh: doc nen loi -> request sau thay ban cu danh dau stale; doc lai thanh cong thi bo co', async () => {
  let clock = 0;
  let fail = false;
  let reads = 0;
  const cache = createTtlSnapshotCache({
    freshTtlMs: 1000, staleTtlMs: 10000, backgroundRefresh: true, now: () => clock,
    fetch: async () => { reads++; if (fail) throw new Error('sheet loi'); return { value: reads }; }
  });
  assert.equal((await cache.get()).value, 1);
  fail = true;
  clock = 1500;
  const immediate = await cache.get();
  assert.deepEqual([immediate.value, immediate.stale], [1, false], 'chua biet loi: tra ban dang co');
  await tick();
  const marked = await cache.get();
  assert.deepEqual([marked.value, marked.stale], [1, true], 'lan doc nen da loi: bao ban cu');
  await tick();
  fail = false;
  await cache.get();
  await tick();
  const recovered = await cache.get();
  assert.equal(recovered.stale, false);
  assert.ok(recovered.value > 1);
});

test('khong backgroundRefresh (mac dinh): het han thi cho doc moi; loi tra ban cu stale cho chinh lan do', async () => {
  let clock = 0;
  let fail = false;
  const cache = createTtlSnapshotCache({
    freshTtlMs: 1000, staleTtlMs: 10000, now: () => clock,
    fetch: async () => { if (fail) throw new Error('loi'); return { value: clock }; }
  });
  assert.equal((await cache.get()).value, 0);
  clock = 1500;
  assert.equal((await cache.get()).value, 1500);
  fail = true;
  clock = 3000;
  const stale = await cache.get();
  assert.deepEqual([stale.value, stale.stale], [1500, true]);
  clock = 20000;
  await assert.rejects(() => cache.get(), /loi/);
});
