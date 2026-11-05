'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const { refreshContainers, startContainerSchedule }=require('./sync');
const { SHEET_NAMES, INTERVAL_MS }=require('./parser');
function fakeConnection({locked=true,lastAttempt=null,lastSuccess=null}={}) {
  const calls=[];
  return {calls,release(){calls.push('RELEASE');},async query(sql,params){calls.push({sql,params});
    if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked}]};
    if(sql.startsWith('SELECT last_attempt'))return {rows:[{last_attempt_at:lastAttempt,last_success_at:lastSuccess}]};
    return {rows:[],rowCount:1};}};
}
const fixed=new Date('2026-10-15T02:00:00Z');

test('web source stops Sheet reads and snapshot writes even when forced',async()=>{
  const conn=fakeConnection(),original=conn.query;let reads=0;
  conn.query=async function(sql,params){if(sql.includes('to_regclass'))return {rows:[{name:'purchase_settings'}]};if(sql.includes('SELECT source_mode'))return {rows:[{source_mode:'web'}]};return original.call(this,sql,params)};
  const result=await refreshContainers({pool:{connect:async()=>conn},spreadsheetId:'fixture',force:true,client:{listSheetTitles:async()=>{reads++;return []}}});
  assert.equal(result.status,'web-source');assert.equal(reads,0);
  assert.equal(conn.calls.some(call=>call.sql?.startsWith('DELETE')),false);
  assert(conn.calls.some(call=>call.sql?.includes('pg_advisory_unlock')));
});
test('one source failure keeps prior snapshot, records safe error and releases shared lock',async()=>{
  const conn=fakeConnection();
  const reads=[];
  const result=await refreshContainers({pool:{connect:async()=>conn},spreadsheetId:'fixture',now:()=>fixed,
    client:{listSheetTitles:async()=>SHEET_NAMES,getValues:async(name)=>{reads.push(name);if(name==='SD')throw Error('secret request');return [];}},logger:{info(){},error(){}}});
  assert.equal(result.status,'failed');
  assert.equal(conn.calls.some(x=>x.sql?.startsWith('DELETE')),false);
  assert.ok(conn.calls.some(x=>x.sql?.includes('last_error')));
  assert.ok(conn.calls.some(x=>x.sql?.includes('pg_advisory_unlock')));
  assert.equal(conn.calls.at(-1),'RELEASE');
  assert.doesNotMatch(JSON.stringify(conn.calls),/secret request/);
});
test('not-due and shared-lock busy do not read Google',async()=>{
  for(const opts of [{lastSuccess:'2026-10-15T01:55:00Z'},{locked:false},{lastAttempt:'2026-10-15T01:56:00Z'}]){
    const conn=fakeConnection(opts);let reads=0;
    const result=await refreshContainers({pool:{connect:async()=>conn},spreadsheetId:'fixture',now:()=>fixed,client:{listSheetTitles:async()=>{reads++;return SHEET_NAMES;}},logger:{info(){},error(){}}});
    assert.ok(['not-due','busy'].includes(result.status));assert.equal(reads,0);
  }
});
test('seven-sheet success commits rows and metadata together; rollback on insert error',async()=>{
  for(const fail of [false,true]){
    const conn=fakeConnection();const original=conn.query;
    conn.query=async function(sql,params){if(fail&&sql.startsWith('INSERT INTO product_container_lines'))throw Error('insert fail');return original.call(this,sql,params);};
    const reads=[];
    const result=await refreshContainers({pool:{connect:async()=>conn},spreadsheetId:'fixture',now:()=>fixed,client:{listSheetTitles:async()=>SHEET_NAMES,getValues:async(name)=>{reads.push(name);const row=Array(24).fill('');row[0]='SKU';row[14]=2;return [['CONT A','2.Chưa bốc'],row];}},logger:{info(){},error(){}}});
    assert.equal(new Set(reads).size,7);
    const sql=conn.calls.filter(x=>x.sql).map(x=>x.sql);
    assert.ok(sql.indexOf('BEGIN')<sql.findIndex(x=>x.startsWith('DELETE')));
    assert.ok(sql.includes(fail?'ROLLBACK':'COMMIT'));
    assert.equal(result.status,fail?'failed':'updated');
  }
});
test('scheduler starts independently, runs every INTERVAL_MS (10 phut mac dinh) and can stop',async()=>{
  let callback;let count=0;let cleared=false;
  const runtime=startContainerSchedule({spreadsheetId:'fixture',refresh:async()=>{count++;},setTimeoutFn:(cb,ms)=>{callback=cb;assert.equal(ms,INTERVAL_MS);return {unref(){}};},clearTimeoutFn:()=>{cleared=true;}});
  await runtime.ready;await callback();assert.equal(count,2);runtime.stop();assert.equal(cleared,true);
});
test('restart schedules remaining persisted due time rather than another full interval',async()=>{
  let delay;
  const runtime=startContainerSchedule({spreadsheetId:'fixture',now:()=>1000,refresh:async()=>({status:'not-due',nextAttemptAt:1600}),setTimeoutFn:(cb,ms)=>{delay=ms;return {};},clearTimeoutFn(){}});
  await runtime.ready;assert.equal(delay,600);runtime.stop();
});
test('unlock failure discards the DB session instead of leaking its advisory lock into pool',async()=>{
  const conn=fakeConnection({lastSuccess:'2026-10-15T01:55:00Z'});const query=conn.query;
  let releasedWith;
  conn.query=async function(sql,args){if(sql.includes('pg_advisory_unlock'))throw Error('unlock failed');return query.call(this,sql,args);};
  conn.release=error=>{releasedWith=error;};
  await refreshContainers({pool:{connect:async()=>conn},spreadsheetId:'fixture',now:()=>fixed,logger:{info(){},error(){}}});
  assert.ok(releasedWith instanceof Error);
});
test('unchanged sheet: 0 dong ghi, version giu nguyen, chi cap nhat moc thoi gian',async()=>{
  const conn=fakeConnection();const original=conn.query;
  conn.query=async function(sql,params){
    if(sql.startsWith('DELETE FROM product_container_lines')||sql.startsWith('INSERT INTO product_container_lines'))return {rows:[],rowCount:0};
    if(sql.includes('AS first_run'))return {rows:[{first_run:false,warnings_changed:false}]};
    return original.call(this,sql,params);
  };
  const result=await refreshContainers({pool:{connect:async()=>conn},spreadsheetId:'fixture',now:()=>fixed,
    client:{listSheetTitles:async()=>SHEET_NAMES,getValues:async()=>{const row=Array(24).fill('');row[0]='SKU';row[14]=2;return [['CONT A','2.Chưa bốc'],row];}},logger:{info(){},error(){}}});
  assert.equal(result.status,'unchanged');
  assert.equal(result.version,undefined);
  const update=conn.calls.find(x=>x.sql&&x.sql.includes('UPDATE product_container_sync SET')&&x.sql.includes('CASE WHEN'));
  assert.ok(update,'van cap nhat last_success_at');
  assert.equal(update.params[0],false,'changed=false => CASE giu version cu');
  assert.ok(conn.calls.some(x=>x.sql==='COMMIT'));
});
test('chu ky mac dinh 10 phut va stale sau 3 chu ky',()=>{
  const { INTERVAL_MS, STALE_AFTER_MS }=require('./parser');
  assert.equal(INTERVAL_MS,10*60*1000);
  assert.equal(STALE_AFTER_MS,30*60*1000);
});
test('sau luot dong bo CONT updated/unchanged goi afterRefresh (tinh bang Du kien hang ve); loi cua no khong lam hong lich',async()=>{
  for(const [status,expected] of [['updated',1],['unchanged',1],['not-due',0],['failed',0],['held',0]]){
    let calls=0;let delay;
    const runtime=startContainerSchedule({spreadsheetId:'fixture',now:()=>1000,refresh:async()=>({status,nextAttemptAt:1600}),
      afterRefresh:async()=>{calls++;throw Error('boom');},setTimeoutFn:(cb,ms)=>{delay=ms;return {};},clearTimeoutFn(){},logger:{info(){},error(){}}});
    await runtime.ready;assert.equal(calls,expected,status);assert.equal(delay,600,'lich ke tiep khong bi anh huong');runtime.stop();
  }
});
