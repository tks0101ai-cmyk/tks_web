'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const dir=path.join(__dirname,'../public/thu-mua/dat-hang'),tick=()=>new Promise(setImmediate);
async function page(t,{local=false,directory=null}={}){
 const w=new JSDOM(fs.readFileSync(path.join(dir,'index.html'),'utf8'),{url:'https://example.test/thu-mua/dat-hang/',runScripts:'outside-only'}).window;
 t.after(()=>w.close());w.HTMLCanvasElement.prototype.getContext=()=>null;
 const data={sourceMode:'web',integrationEnabled:true,permissions:{edit:true,import:true,export:true,depart:true,arrive:true},rows:[{id:'1',rowKey:'D00001',version:4,contId:'2',productCode:'A',productName:'Product',supplier:'Old',cartonCount:10,qtyPerCarton:5}],containers:[{id:'2',name:'CONT 11-1V',status:2,version:3,arrival_note:'2026-11-08',arrival_date:null}]},listeners={},calls=[],timers=new Set();let closed=0;
 for(const [name,file] of Object.entries({PurchaseCalculations:'purchase-calculations',PurchaseFreight:'purchase-freight',PurchaseColumns:'purchase-columns',PurchaseTasks:'purchase-tasks',PurchaseRealtime:'purchase-realtime',PurchaseDraftHistory:'purchase-draft-history',PurchaseContainerWorkspace:'purchase-container-workspace'}))w[name]=require('../public/shared/'+file);
 w.TKSNav={authGuard:async()=>({id:'buyer'})};w.EventSource=class{addEventListener(k,f){listeners[k]=f}close(){closed++}};
 w.setInterval=fn=>{timers.add(fn);return fn};w.clearInterval=id=>timers.delete(id);
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.fetch=async(url,options={})=>{if(url.startsWith('/api/me/table-prefs'))return {ok:true,json:async()=>({tables:{}})};calls.push({url,options});if(url.endsWith('/employees')&&directory)return {ok:true,json:()=>directory};return {ok:true,json:async()=>url.endsWith('/employees')?{rows:[]}:options.method==='PATCH'?{}:structuredClone(data)}};
 if(local){const row={...data.rows[0],id:'new-local',rowKey:'D00002',version:1};w.sessionStorage.setItem('purchase:buyer:v1',JSON.stringify({newRows:{'new-local':row},drafts:{'new-local':{version:1,before:{supplier:''},changes:{supplier:'Local'}}}}))}
 w.eval(fs.readFileSync(path.join(dir,'../../shared/table-controls.js'),'utf8'));w.PurchaseGrid=require('../public/shared/purchase-grid');w.PurchaseGridUI=require('../public/shared/purchase-grid-ui');Object.defineProperty(w.document,'hidden',{value:false,configurable:true});const realtimeAPI=w.PurchaseRealtime;w.PurchaseRealtime={...realtimeAPI,createScheduler:options=>realtimeAPI.createScheduler({...options,gapMs:0})};w.eval(fs.readFileSync(path.join(dir,'purchase.js'),'utf8'));await tick();await tick();
 return {w,data,calls,listeners,timers,get closed(){return closed},drafts:()=>JSON.parse(w.sessionStorage.getItem('purchase:buyer:v1')).drafts};
}
test('integrated refresh updates another cell during numeric expression typing, retaining baseline/caret and navigation mode',async t=>{
 const p=await page(t),doc=p.w.document,input=doc.querySelector('[data-edit="cartonCount"]');input.focus();input.value='2*6';input.dataset.gridEditing='true';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.setSelectionRange(1,2);
 p.data.rows[0].supplier='Remote supplier';p.data.rows[0].cartonCount=20;p.data.rows[0].version=5;p.listeners.changed();await tick();await tick();
 assert.equal(doc.activeElement.value,'2*6');assert.equal(doc.activeElement.selectionStart,1);assert.equal(doc.activeElement.selectionEnd,2);assert.equal(doc.activeElement.dataset.gridEditing,'true');assert.equal(doc.activeElement.dataset.gridDirty,'true');assert.equal(doc.querySelector('[data-edit="supplier"]').value,'Remote supplier');assert.equal(p.drafts()['1'].before.cartonCount,10);assert.equal(p.drafts()['1'].version,4);assert.match(doc.getElementById('notice').textContent,/Người khác/);assert.ok(doc.querySelector('[data-field="cartonCount"]').classList.contains('conflict'));
});
for(const modal of [false,true])test('arrival '+(modal?'modal':'inline')+' sends saved contained row versions, excluding local rows and retaining edit baseline across refresh',async t=>{
 const p=await page(t,{local:true}),doc=p.w.document;assert.ok(p.drafts()['new-local']);
 if(modal){doc.querySelector('[data-container-edit="2"]').click();const form=doc.getElementById('editCont');form.elements.arrivalNote.value='09/11';p.data.containers[0].version=9;p.data.rows[0].version=8;p.listeners.changed();await tick();await tick();form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}))}
 else{let input=doc.querySelector('#containerTable [data-container-field="arrivalNote"]');input.focus();input.value='09/11';p.data.containers[0].version=9;p.data.rows[0].version=8;p.listeners.changed();await tick();await tick();input=doc.activeElement;assert.equal(input.value,'09/11');input.dispatchEvent(new p.w.Event('change',{bubbles:true}))}
 await tick();await tick();const call=p.calls.find(c=>c.options.method==='PATCH');assert.ok(call);const body=JSON.parse(call.options.body);assert.equal(body.version,3);assert.deepEqual(body.rows,[{id:'1',version:4}]);assert.match(body.changes.arrivalNote,/11-09/);
});
test('pagehide closes events, clears poll timer and prevents queued refreshes',async t=>{
 const p=await page(t);assert.equal(p.timers.size,1);p.w.dispatchEvent(new p.w.Event('pagehide'));assert.equal(p.closed,1);assert.equal(p.timers.size,0);const n=p.calls.length;p.listeners.changed();p.w.dispatchEvent(new p.w.Event('online'));await tick();await tick();assert.equal(p.calls.length,n);
 const scripts=[...p.w.document.scripts].map(s=>s.src);assert.ok(scripts.findIndex(s=>s.includes('purchase-realtime.js'))<scripts.findIndex(s=>s.includes('/purchase.js')));
});
test('SSE refresh loads newly added employees while retaining draft baseline and tolerating absent or failed directory responses',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;
 const input=doc.querySelector('[data-edit="supplier"]');input.focus();input.value='Private draft';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.setSelectionRange(2,5);
 let mode='valid';p.w.fetch=async(url,options)=>{
  if(!url.endsWith('/employees'))return fetch(url,options);
  if(mode==='fail')throw Error('offline directory');
  return {ok:true,json:async()=>mode==='valid'?{rows:[{id:'nv-new',name:'New employee'}]}:{}};
 };
 for(const next of ['valid','absent','fail']){
  mode=next;p.data.rows[0].cartonCount++;p.listeners.changed();await tick();await tick();
  assert.ok([...doc.querySelector('[data-edit="buyer"]').options].some(o=>o.value==='New employee'),next);
  assert.equal(doc.activeElement.value,'Private draft');assert.equal(doc.activeElement.selectionStart,2);assert.equal(doc.activeElement.selectionEnd,5);
  assert.equal(p.drafts()['1'].before.supplier,'Old');assert.equal(p.drafts()['1'].version,4);
  assert.equal(doc.querySelector('[data-edit="cartonCount"]').value,String(p.data.rows[0].cartonCount));
 }
});
test('pristine focused input retains its original comparison value/version when first edited after remote refresh',async t=>{
 const p=await page(t),doc=p.w.document;doc.querySelector('[data-edit="supplier"]').focus();
 p.data.rows[0].supplier='Remote';p.data.rows[0].version=5;p.listeners.changed();await tick();await tick();
 const input=doc.querySelector('[data-edit="supplier"]');assert.equal(doc.activeElement,input);assert.equal(input.value,'Old');assert.match(input.closest('td').title,/Remote/);
 input.value='My edit';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));assert.equal(p.drafts()['1'].before.supplier,'Old');assert.equal(p.drafts()['1'].version,4);
});
for(const scope of ['containerTable','watchedContainer'])test('freight '+scope+' sends original focus version after SSE and cannot overwrite remote freight',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;
 if(scope==='watchedContainer')doc.querySelector('[data-container-filter="2"]').click();
 const input=doc.querySelector('#'+scope+' [data-cont-freight="2"]');input.focus();input.value='1,000';input.setSelectionRange(1,3);
 p.data.containers[0].version=9;p.data.containers[0].freight=9000;p.data.containers[0].freight_mode='manual';p.listeners.changed();await tick();await tick();
 assert.equal(doc.activeElement.value,'1,000');assert.equal(doc.activeElement.selectionStart,1);
 p.w.fetch=async(url,options={})=>{if(options.method!=='PATCH')return fetch(url,options);p.calls.push({url,options});const body=JSON.parse(options.body),ok=body.version===9;if(ok)p.data.containers[0].freight=body.changes.freight;return {ok,status:ok?200:409,json:async()=>ok?{}:{error:'Freight conflict'}}};
 doc.activeElement.dispatchEvent(new p.w.Event('change',{bubbles:true}));await tick();await tick();const body=JSON.parse(p.calls.find(c=>c.options.method==='PATCH').options.body);
 assert.equal(body.version,3);assert.equal(p.data.containers[0].freight,9000);assert.match(doc.getElementById('notice').textContent,/Freight conflict/);assert.equal(doc.activeElement.value,'1,000');
});
for(const action of ['save','toggle'])test('employee modal '+action+' uses rendered directory version despite SSE directory refresh',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;let directory=[{id:'nv',name:'Original name',version:2,isActive:true}];
 p.w.fetch=async(url,options={})=>{
  if(url.endsWith('/employees'))return {ok:true,json:async()=>({rows:structuredClone(directory)})};
  if(url.endsWith('/employees/nv')&&options.method==='PATCH'){p.calls.push({url,options});const body=JSON.parse(options.body),ok=body.version===directory[0].version;if(ok)Object.assign(directory[0],body.changes);return {ok,status:ok?200:409,json:async()=>ok?{}:{error:'Employee conflict'}}}
  return fetch(url,options);
 };
 doc.getElementById('managePurchaseEmployees').click();await tick();await tick();const input=doc.querySelector('[data-directory-name]');input.value='Local rename';
 directory=[{id:'nv',name:'Remote rename',version:7,isActive:false}];p.listeners.changed();await tick();await tick();assert.equal(input.value,'Local rename');
 doc.querySelector('[data-directory-'+action+']').click();await tick();await tick();const body=JSON.parse(p.calls.find(c=>c.url.endsWith('/employees/nv')).options.body);
 assert.equal(body.version,2);if(action==='toggle')assert.equal(body.changes.isActive,false);assert.equal(directory[0].name,'Remote rename');assert.equal(directory[0].isActive,false);assert.match(doc.getElementById('notice').textContent,/Employee conflict/);assert.equal(input.value,'Local rename');
});
for(const scope of ['containerTable','watchedContainer'])for(const field of ['freight','carrier'])test('real focusout without native change commits restored dirty '+field+' in '+scope+' once using original version',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;
 if(scope==='watchedContainer')doc.querySelector('[data-container-filter="2"]').click();
 const selector='#'+scope+(field==='freight'?' [data-cont-freight="2"]':' [data-container-field="carrier"]'),input=doc.querySelector(selector);
 input.focus();input.value=field==='freight'?'123':'Local carrier';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 p.data.containers[0].version=9;p.data.containers[0].freight=999;p.data.containers[0].freight_mode='manual';p.data.containers[0].carrier='Remote carrier';
 p.listeners.changed();await tick();await tick();assert.equal(p.calls.filter(c=>c.options.method==='PATCH').length,0,'rerender must not save');
 p.w.fetch=async(url,options={})=>{if(options.method!=='PATCH')return fetch(url,options);p.calls.push({url,options});return {ok:false,status:409,json:async()=>({error:'Container conflict'})}};
 const restored=doc.querySelector(selector);assert.equal(doc.activeElement,restored);restored.blur();await tick();await tick();
 const writes=p.calls.filter(c=>c.options.method==='PATCH');assert.equal(writes.length,1);const body=JSON.parse(writes[0].options.body);assert.equal(body.version,3);assert.equal(body.changes[field],field==='freight'?123:'Local carrier');assert.equal(restored.value,field==='freight'?'123':'Local carrier');assert.match(doc.getElementById('notice').textContent,/Container conflict/);
});
test('native change followed by focusout never duplicates container commit',async t=>{
 const p=await page(t),doc=p.w.document,input=doc.querySelector('[data-cont-freight="2"]');input.focus();input.value='123';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));input.blur();await tick();await tick();assert.equal(p.calls.filter(c=>c.options.method==='PATCH').length,1);
});

test('a hung employee directory cannot block first rows or subsequent row refresh',async t=>{
 let finish;const gate=new Promise(resolve=>finish=resolve);t.after(()=>finish({rows:[]}));const p=await page(t,{directory:gate}),doc=p.w.document;assert.ok(doc.querySelector('[data-edit="supplier"]'));assert.equal(doc.querySelector('[data-edit="supplier"]').value,'Old');p.data.rows[0].supplier='Fresh rows';p.listeners.changed();await tick();await tick();assert.equal(doc.querySelector('[data-edit="supplier"]').value,'Fresh rows');finish({rows:[{id:'a',name:'Directory finally ready'}]});await tick();await tick();assert.ok([...doc.querySelector('[data-edit="buyer"]').options].some(o=>o.value==='Directory finally ready'));
});

test('automatic invalidation checks lightweight revision and skips full rows when already current',async t=>{
 const p=await page(t),fetch=p.w.fetch;let revision='8:1';p.data.revision=revision;p.w.fetch=async(url,options)=>url.endsWith('/revision')?{ok:true,json:async()=>({revision})}:fetch(url,options);
 p.listeners.changed();await tick();await tick();const count=()=>p.calls.filter(c=>c.url==='/api/purchase-orders'&&!c.options.method).length;const n=count();p.listeners.changed();await tick();await tick();assert.equal(count(),n);revision='9:2';p.data.revision=revision;p.data.rows[0].supplier='New revision';p.listeners.changed();await tick();await tick();assert.equal(count(),n+1);assert.equal(p.w.document.querySelector('[data-edit="supplier"]').value,'New revision');
});
test('background refresh preserves row order and selected stable ids while new rows remain in their container group',async t=>{
 const p=await page(t),doc=p.w.document;const cell=doc.querySelector('tr[data-id="1"] [data-field="supplier"]');cell.click();p.data.rows.push({id:'9',rowKey:'D00009',version:1,contId:null,productCode:'NEW',productName:'New item',supplier:'New',cartonCount:2,qtyPerCarton:1});p.listeners.changed();await tick();await tick();assert.deepEqual([...doc.querySelectorAll('#orderTable tbody tr[data-id]')].map(r=>r.dataset.id),['9','1']);assert.ok(doc.querySelector('tr[data-id="1"] [data-field="supplier"]').classList.contains('purchase-cell-selected'));
});
