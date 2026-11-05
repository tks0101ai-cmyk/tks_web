'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createClient}=require('redis');
const {createSharedCache}=require('./sharedCache');

// Use a dedicated TEST Redis. Never point this variable at production.
test('real Redis: shared reads, cross-client invalidation, guarded refill and outage fallback',
  {skip:!process.env.REDIS_TEST_URL},async()=>{
    const client=createClient({url:process.env.REDIS_TEST_URL,disableOfflineQueue:true,
      socket:{connectTimeout:2000,reconnectStrategy:false}});
    client.on('error',()=>{});
    await client.connect();
    const namespace=`tokosi:test:${process.pid}:${Date.now()}:v1`;
    const a=createSharedCache({client,namespace}),b=createSharedCache({client,namespace});
    let release;
    try {
      assert.equal(await a.readThrough('HN',1000,async()=>42),42);
      assert.equal(await b.readThrough('HN',1000,async()=>99),42);
      await b.invalidate('HN');
      let started;
      const ready=new Promise(r=>{started=r;});
      const old=a.readThrough('HN',1000,()=>{started();return new Promise(r=>{release=r;});});
      await ready;
      await b.invalidate('HN');
      assert.equal(await b.readThrough('HN',1000,async()=>43),43);
      release(10);await old;
      assert.equal(await a.readThrough('HN',1000,async()=>99),43);
      const evictedReady=new Promise(r=>{started=r;});
      const evicted=a.readThrough('evicted',1000,()=>{started();return new Promise(r=>{release=r;});});
      await evictedReady;
      // allkeys-lru may evict the generation while a slow source read is running.
      await client.del(`${namespace}:{${Buffer.from('evicted').toString('base64url')}}:generation`);
      release(10);await evicted;
      assert.equal(await b.readThrough('evicted',1000,async()=>11),11);
      assert.equal(await a.readThrough('SG',30,async()=>8),8);
      await new Promise(r=>setTimeout(r,50));
      assert.equal(await b.readThrough('SG',30,async()=>9),9);
      await a.set('seller-phones:hanoi:retailer-a',{at:1,phones:{7:'0901234567'}},1000);
      assert.equal((await b.get('seller-phones:hanoi:retailer-a')).phones[7],'0901234567');
      assert.equal(await b.get('seller-phones:saigon:retailer-b'),null);
      await client.quit();
      assert.equal(await a.readThrough('HN',1000,async()=>44),44);
    } finally {
      release?.(10);
      if(client.isOpen)client.destroy();
    }
  });
