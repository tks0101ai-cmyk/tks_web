'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const realtime=require('./purchase-realtime');
test('mergeRows applies other committed cells, retains baseline/version and makes same-cell/deletion conflicts explicit',()=>{
  const drafts={'1':{version:1,before:{name:'old'},changes:{name:'typing'}},'2':{before:{},changes:{name:'lost'}}},copy=JSON.stringify(drafts);
  const out=realtime.mergeRows([{id:'1',version:2,name:'remote',quantity:9}],drafts);
  assert.equal(out.rows[0].name,'typing');assert.equal(out.rows[0].quantity,9);
  assert.deepEqual(out.conflicts.map(c=>[c.id,c.field,c.deleted]),[['1','name',false],['2',undefined,true]]);
  assert.equal(JSON.stringify(drafts),copy);
  assert.equal(realtime.mergeRows([{id:'1',name:'typing'}],drafts).conflicts.filter(c=>!c.deleted).length,0);
});
test('mergeDelta changes only listed rows, preserves drafts, reports conflicts and ignores older row versions',()=>{
 const current={revision:'10:3',sourceMode:'web',integrationEnabled:true,rows:[{id:'1',version:5,supplier:'A',quantity:1},{id:'2',version:3,supplier:'B'},{id:'4',version:10,supplier:'Keep'}],containers:[{id:'old'}]};
 const delta={revision:'10:6',sourceMode:'sheets',integrationEnabled:false,rows:[{id:'1',version:6,supplier:'Remote',quantity:9},{id:'3',version:1,supplier:'New'},{id:'4',version:9,supplier:'Stale'}],deletedIds:['2'],containers:[{id:'new'}],employeesChanged:true};
 const drafts={'1':{version:5,before:{supplier:'A'},changes:{supplier:'Local'}},'2':{version:3,before:{supplier:'B'},changes:{supplier:'Draft'}}},copy=JSON.stringify(drafts);
 const out=realtime.mergeDelta(current,delta,drafts);
 assert.deepEqual(out.rows.map(r=>r.id),['1','4','3']);assert.deepEqual(out.rows[0],{id:'1',version:6,supplier:'Local',quantity:9});assert.deepEqual(out.rows[1],{id:'4',version:10,supplier:'Keep'});assert.equal(out.rows[2].supplier,'New');
 assert.deepEqual(out.conflicts.map(c=>[c.id,c.field,c.deleted]),[['1','supplier',false],['2',undefined,true]]);assert.deepEqual(out.containers,[{id:'new'}]);assert.equal(out.sourceMode,'sheets');assert.equal(out.integrationEnabled,false);assert.equal(out.employeesChanged,true);assert.equal(JSON.stringify(drafts),copy);
});
for(const scope of ['orderTable','containerTable','watchedContainer'])test('refresh preserves latest focused value and caret while other cells update: '+scope,async()=>{
  const attrs=scope==='orderTable'?'data-edit="name"':'data-container-id="1" data-container-field="name"';
  const dom=new JSDOM('<div id="'+scope+'"></div>'),doc=dom.window.document;
  const render=snapshot=>{doc.getElementById(scope).innerHTML='<div data-id="1"><input '+attrs+' value="'+snapshot.rows[0].name+'"><span>'+snapshot.rows[0].quantity+'</span></div>'};
  render({rows:[{name:'old',quantity:1}]});let resolve;
  let conflicts;const coordinator=realtime.createCoordinator({getRoot:()=>doc,fetchSnapshot:()=>new Promise(r=>resolve=r),applySnapshot:render,onConflict:c=>conflicts=c});
  const input=doc.querySelector('input');input.focus();input.value='draft';input.setSelectionRange(2,4,'backward');
  const pending=coordinator.refresh();input.value='draft latest';input.setSelectionRange(3,7,'backward');
  resolve({revision:'2',rows:[{name:'remote',quantity:9}]});await pending;
  assert.equal(doc.activeElement.value,'draft latest');assert.equal(doc.activeElement.selectionStart,3);assert.equal(doc.activeElement.selectionEnd,7);assert.equal(doc.activeElement.selectionDirection,'backward');assert.equal(doc.querySelector('span').textContent,'9');assert.equal(conflicts[0].focused,true);assert.equal(conflicts[0].remote,'remote');coordinator.destroy();dom.window.close();
});
test('refresh applies valid pending responses without starvation and skips older numeric snapshots',async()=>{
  const dom=new JSDOM(''),resolvers=[],applied=[];let active=0,peak=0;
  const c=realtime.createCoordinator({getRoot:()=>dom.window.document,fetchSnapshot:()=>{active++;peak=Math.max(active,peak);return new Promise(r=>resolvers.push(value=>{active--;r(value)}))},applySnapshot:s=>applied.push(s.revision)});
  const first=c.refresh();assert.equal(c.refresh(),first);c.refresh();resolvers.shift()({revision:'1'});await new Promise(setImmediate);assert.deepEqual(applied,['1']);resolvers.shift()({revision:'3'});await first;
  const second=c.refresh();resolvers.shift()({revision:'2'});await second;assert.deepEqual(applied,['1','3']);assert.equal(peak,1);
  const last=c.refresh();c.destroy();resolvers.shift()({revision:'4'});await last;await c.refresh();assert.deepEqual(applied,['1','3']);dom.window.close();
});
test('coordinator consumes delta after baseline while preserving focused draft state',async()=>{
 const dom=new JSDOM('<div id="orderTable"></div>'),doc=dom.window.document,applied=[];let count=0,conflicts=[];
 const render=state=>{doc.getElementById('orderTable').innerHTML='<div data-id="1"><input data-edit="name" value="'+state.rows[0].name+'"><span>'+state.rows[0].quantity+'</span></div>'};
 const c=realtime.createCoordinator({getRoot:()=>doc,getDrafts:()=>({'1':{before:{name:'old'},changes:{name:'local'}}}),fetchSnapshot:async()=>({revision:'1:1',rows:[{id:'1',version:1,name:'old',quantity:1}]}),fetchDelta:async after=>{count++;assert.equal(after,'1:1');return {revision:'1:2',rows:[{id:'1',version:2,name:'remote',quantity:9}],deletedIds:[],containers:[],sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:false}},applySnapshot:render,applyDelta:(delta,merged)=>{applied.push(delta.revision);render(merged)},onConflict:c=>conflicts=c});
 await c.refresh();const input=doc.querySelector('input');input.focus();input.value='local typing';input.setSelectionRange(2,7);await c.refresh();
 assert.equal(count,1);assert.deepEqual(applied,['1:2']);assert.equal(c.revision,'1:2');assert.equal(doc.activeElement.value,'local typing');assert.equal(doc.activeElement.selectionStart,2);assert.equal(doc.querySelector('span').textContent,'9');assert.equal(conflicts[0].field,'name');c.destroy();dom.window.close();
});
test('reset or delta error falls back to full snapshot',async()=>{
 for(const fail of ['reset','error','malformed']){
  const dom=new JSDOM('');let deltas=0,snapshots=0,revision='2:1';
  const c=realtime.createCoordinator({getRoot:()=>dom.window.document,fetchSnapshot:async()=>{snapshots++;return {revision,rows:[{id:'1',version:3,name:'snapshot'}]}},fetchDelta:async()=>{deltas++;if(fail==='error')throw Error('delta failed');return {revision:fail==='malformed'?'bad':'2:2',rows:[],deletedIds:[],containers:[],reset:fail==='reset'}},applySnapshot:()=>{},applyDelta:()=>{throw Error('reset delta applied')}});
  c.captureBaseline({revision:'2:0',rows:[]});await c.refresh();assert.equal(deltas,1);assert.equal(snapshots,1);assert.equal(c.revision,revision);c.destroy();dom.window.close();
 }
});
test('fetch failure releases coordinator for reconnect retry',async()=>{
 const dom=new JSDOM('');let fail=true,count=0;const c=realtime.createCoordinator({getRoot:()=>dom.window.document,fetchSnapshot:async()=>{if(fail)throw Error('offline');return {rows:[]}},applySnapshot:()=>count++});
 await assert.rejects(c.refresh(),/offline/);fail=false;await c.refresh();assert.equal(count,1);c.destroy();dom.window.close();
});
function schedulerHarness(refresh){
 let time=0,hidden=false,id=0;const timers=new Map(),errors=[];
 const scheduler=realtime.createScheduler({refresh,isHidden:()=>hidden,now:()=>time,onError:e=>errors.push(e),setTimer:(fn,delay)=>{timers.set(++id,{fn,at:time+delay});return id},clearTimer:id=>timers.delete(id)});
 return {scheduler,errors,timers,hide(value){hidden=value},async advance(ms){time+=ms;for(const [id,t] of [...timers])if(t.at<=time){timers.delete(id);t.fn()}await new Promise(setImmediate)}};
}
test('scheduler coalesces bursts with trailing work without overlapping slow requests',async()=>{
 const resolvers=[];let calls=0;const h=schedulerHarness(()=>{calls++;return new Promise(r=>resolvers.push(r))});
 h.scheduler.trigger();assert.equal(calls,1);for(let i=0;i<100;i++)h.scheduler.trigger();await h.advance(5000);assert.equal(calls,1);
 resolvers.shift()();await h.advance(0);assert.equal(calls,2);resolvers.shift()();await h.advance(3000);assert.equal(calls,2);h.scheduler.destroy();
});
test('scheduler hidden changes flush once and destroy cancels trailing work',async()=>{
 let calls=0;const h=schedulerHarness(async()=>{calls++});h.hide(true);for(let i=0;i<20;i++)h.scheduler.trigger();await h.advance(9000);assert.equal(calls,0);
 h.hide(false);h.scheduler.visible();h.scheduler.visible();await h.advance(0);assert.equal(calls,1);
 h.scheduler.trigger();await h.advance(2999);assert.equal(calls,1);await h.advance(1);assert.equal(calls,2);
 h.scheduler.trigger();h.scheduler.destroy();await h.advance(3000);h.scheduler.trigger();h.scheduler.visible();assert.equal(calls,2);assert.equal(h.timers.size,0);
});
test('scheduler reports errors and permits retry',async()=>{
 let calls=0;const error=Error('offline'),h=schedulerHarness(()=>{if(++calls===1)throw error});h.scheduler.trigger();await h.advance(0);assert.deepEqual(h.errors,[error]);h.scheduler.trigger();await h.advance(3000);assert.equal(calls,2);h.scheduler.destroy();
});
test('scheduler rechecks visibility at timer fire and destroy suppresses in-flight trailing work',async()=>{
 let calls=0,resolve;const h=schedulerHarness(()=>{calls++;return new Promise(r=>resolve=r)});
 h.scheduler.trigger();resolve();await h.advance(0);h.scheduler.trigger();h.hide(true);await h.advance(3000);assert.equal(calls,1);
 h.hide(false);h.scheduler.visible();assert.equal(calls,2);h.scheduler.trigger();h.scheduler.destroy();resolve();await h.advance(6000);assert.equal(calls,2);assert.equal(h.timers.size,0);
});
