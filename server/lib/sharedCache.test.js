'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSharedCache } = require('./sharedCache');

test('local fallback shares a load, expires and never serves an invalidated in-flight result to a later reader', async () => {
  let time = 0, loads = 0, release;
  const cache = createSharedCache({ namespace: 'test', now: () => time });
  const first = cache.readThrough('HN', 15000, () => { loads++; return new Promise(r => { release = r; }); });
  const joined = cache.readThrough('HN', 15000, () => { throw Error('duplicate'); });
  await Promise.resolve();
  await cache.invalidate('HN');
  assert.equal(await cache.readThrough('HN', 15000, async () => 'new'), 'new');
  release('old');
  assert.deepEqual(await Promise.all([first, joined]), ['old', 'old']);
  assert.equal(await cache.readThrough('HN', 15000, async () => 'wrong'), 'new');
  time = 15001;
  assert.equal(await cache.readThrough('HN', 15000, async () => { loads++; return 'fresh'; }), 'fresh');
  assert.equal(loads, 2);
});

test('an unavailable Redis never prevents source reads or queues commands', async () => {
  const cache = createSharedCache({ namespace: 'test', client: {isReady:false, get(){throw Error('offline command');}} });
  assert.equal(await cache.readThrough('HN', 15000, async () => 42), 42);
  assert.equal(await cache.get('SG'), null);
  assert.equal(await cache.set('SG', {phone:'09'}, 1000), false);
  await cache.invalidate('HN');
});

test('invalid Redis setup is treated as a cache outage, not an application failure', async () => {
  const cache=createSharedCache({getClient:()=>{throw Error('invalid URL');}});
  assert.equal(await cache.readThrough('HN',15000,async()=>123),123);
  await cache.invalidate('HN');
});

test('corrupt Redis envelopes fall back to valid source rows',async()=>{
  for(const payload of [{expires:Date.now()+10000},{expires:Date.now()+10000,data:'bad'},{expires:1e99,data:[['bad']]}]){
    const cache=createSharedCache({client:{isReady:true,eval:async()=>['token',JSON.stringify(payload)]}});
    assert.deepEqual(await cache.readThrough('HN',15000,async()=>[['source']],{validate:v=>Array.isArray(v)&&v.every(Array.isArray)}),[['source']]);
  }
});

test('a stalled Redis command is abandoned within its budget and source errors are not cached', async () => {
  const cache = createSharedCache({ namespace: 'test', timeoutMs: 15, client: {isReady:true, eval: () => new Promise(()=>{})} });
  const began = performance.now();
  assert.equal(await cache.readThrough('HN', 15000, async () => 'source'), 'source');
  assert.ok(performance.now() - began < 500);
  const local = createSharedCache({namespace:'test'});
  await assert.rejects(local.readThrough('HN',15000,async()=>{throw Error('source failed');}), /source failed/);
  assert.equal(await local.readThrough('HN',15000,async()=>123),123);
});
