'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{}';
process.env.JWT_SECRET = 'test-secret';
const test = require('node:test');
const assert = require('node:assert/strict');
const {createSellerPhoneLookup} = require('./pickKiotData');
const {createSharedCache} = require('../lib/sharedCache');

test('expired seller contacts survive Kiot errors for at most 30 minutes and stay retailer-scoped', async () => {
  let time=0, fail=false;
  const lookup=createSellerPhoneLookup({now:()=>time,shared:createSharedCache({now:()=>time}),
    getBranches:()=>[{branch:'hanoi',retailer:'hn'},{branch:'saigon',retailer:'sg'}],
    createClient:config=>({fetchAllPages:async(endpoint,q,onPage)=>{
      if(fail)throw Error('Kiot down');
      await onPage([{id:7,mobilePhone:config.retailer==='hn'?'+84901234567':'0907654321'}]);
    }})});
  assert.equal(await lookup('hanoi',7),'0901234567');
  assert.equal(await lookup('saigon',7),'0907654321');
  time=300001; fail=true;
  assert.equal(await lookup('hanoi',7),'0901234567');
  time=1800001;
  assert.equal(await lookup('hanoi',7),'');
});

test('a cold contact lookup has a bounded request budget, joining a single refresh', async () => {
  let loads=0, release;
  const lookup=createSellerPhoneLookup({requestBudgetMs:20,shared:createSharedCache(),
    getBranches:()=>[{branch:'hanoi',retailer:'hn'}],
    createClient:()=>({fetchAllPages:async(e,q,cb)=>{loads++; await new Promise(r=>{release=r;}); await cb([{id:7,mobilePhone:'0901234567'}]);}})});
  const began=performance.now();
  assert.deepEqual(await Promise.all([lookup('hanoi',7),lookup('hanoi',7)]),['','']);
  assert.ok(performance.now()-began<500);
  assert.equal(loads,1);
  release();
  await new Promise(r=>setImmediate(r));
  assert.equal(await lookup('hanoi',7),'0901234567');
});

test('independent web lookups reuse the worker-populated shared contact cache', async () => {
  const shared=createSharedCache(); let calls=0;
  const options={shared,getBranches:()=>[{branch:'hanoi',retailer:'hn'}],createClient:()=>({fetchAllPages:async(e,q,cb)=>{calls++;await cb([{id:7,mobilePhone:'0901234567'}]);}})};
  const worker=createSellerPhoneLookup(options);
  assert.equal(typeof worker.refreshAll,'function');
  await worker.refreshAll();
  assert.equal(await createSellerPhoneLookup(options)('hanoi',7),'0901234567');
  assert.equal(calls,1);
});

test('malformed cached contacts are replaced from source',async()=>{
  const shared=createSharedCache();
  await shared.set('seller-phones:hanoi:hn',{at:Date.now()},1800000);
  const lookup=createSellerPhoneLookup({shared,getBranches:()=>[{branch:'hanoi',retailer:'hn'}],
    createClient:()=>({fetchAllPages:async(e,q,cb)=>cb([{id:7,mobilePhone:'0901234567'}])})});
  assert.equal(await lookup('hanoi',7),'0901234567');
});

test('seller refresh performs one real Kiot client attempt instead of disabling requests',async()=>{
  const lookup=createSellerPhoneLookup({getBranches:()=>[{branch:'hanoi',retailer:'hn',clientId:'id',clientSecret:'test',
    fetchImpl:async url=>({ok:true,status:200,text:async()=>JSON.stringify(String(url).includes('/connect/token')
      ?{access_token:'test-token',expires_in:3600}:{total:1,data:[{id:7,mobilePhone:'0901234567'}]})})}]});
  assert.equal(await lookup('hanoi',7),'0901234567');
});
