'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON='{}';
process.env.JWT_SECRET='test';
process.env.REDIS_ENABLED='false';
process.env.ORDER_LIFECYCLE_SPREADSHEET_ID='test-cache-workbook';
const test=require('node:test');
const assert=require('node:assert/strict');
const {google}=require('googleapis');

test('append invalidates the history tab cache (L1 + shared L2)',async t=>{
  let reads=0,rows=[['header'],['old']];
  t.mock.method(google.auth,'GoogleAuth',function(){this.getClient=async()=>({});});
  t.mock.method(google,'sheets',()=>({spreadsheets:{values:{
    get:async()=>{reads++;return {data:{values:structuredClone(rows)}};},
    append:async()=>{rows.push(['new']);return {};}
  }}}));
  const reader=require('./orderLifecycleSheetsClient'), history=require('./orderLifecycleHistoryClient');
  // Reader va history giu L1 rieng (tab khac nhau trong thuc te); chung nhau tang L2 sharedCache nen lan doc thu hai khong goi Google.
  assert.deepEqual(await reader.getValues('cache-test-history'),[['header'],['old']]);
  assert.deepEqual(await history.getValues('cache-test-history'),[['header'],['old']]);
  assert.equal(reads,1);
  await history.appendRow('cache-test-history',['new']);
  assert.deepEqual(await history.getValues('cache-test-history'),[['header'],['old'],['new']]);
  assert.equal(reads,2);
});

test('ambiguous append failure invalidates cached history too',async t=>{
  let rows=[['header'],['before']];
  t.mock.method(google.auth,'GoogleAuth',function(){this.getClient=async()=>({});});
  t.mock.method(google,'sheets',()=>({spreadsheets:{values:{
    get:async()=>({data:{values:structuredClone(rows)}}),
    append:async()=>{rows.push(['committed-but-timeout']);throw Error('timeout');}
  }}}));
  // Each module owns its lazy Google API binding.
  delete require.cache[require.resolve('./orderLifecycleHistoryClient')];
  const history=require('./orderLifecycleHistoryClient');
  assert.deepEqual(await history.getValues('ambiguous-test'),[['header'],['before']]);
  await assert.rejects(history.appendRow('ambiguous-test',['row']),/timeout/);
  assert.deepEqual(await history.getValues('ambiguous-test'),[['header'],['before'],['committed-but-timeout']]);
});
