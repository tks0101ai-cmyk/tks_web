'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const dir=path.join(__dirname,'../public/thu-mua/dat-hang'),tick=()=>new Promise(setImmediate);
async function page(t,{local=false,directory=null,projectionProbe=null,revision=null,readOnly=false}={}){
 const w=new JSDOM(fs.readFileSync(path.join(dir,'index.html'),'utf8'),{url:'https://example.test/thu-mua/dat-hang/',runScripts:'outside-only'}).window;
 t.after(()=>w.close());w.HTMLCanvasElement.prototype.getContext=()=>null;
 const data={...(revision?{revision}:{}),sourceMode:'web',integrationEnabled:true,permissions:{edit:!readOnly,import:true,export:true,depart:true,arrive:true},rows:[{id:'1',rowKey:'D00001',version:4,contId:'2',productCode:'A',productName:'Product',supplier:'Old',cartonCount:10,qtyPerCarton:5}],containers:[{id:'2',name:'CONT 11-1V',status:2,version:3,arrival_note:'2026-11-08',arrival_date:null}]},listeners={},calls=[],timers=new Set();let closed=0;
 for(const [name,file] of Object.entries({PurchaseCalculations:'purchase-calculations',PurchaseFreight:'purchase-freight',PurchaseColumns:'purchase-columns',PurchaseTasks:'purchase-tasks',PurchaseRealtime:'purchase-realtime',PurchaseDraftHistory:'purchase-draft-history',PurchaseContainerWorkspace:'purchase-container-workspace'}))w[name]=require('../public/shared/'+file);
 w.TKSNav={authGuard:async()=>({id:'buyer'})};w.EventSource=class{addEventListener(k,f){listeners[k]=f}close(){closed++}};
 w.setInterval=fn=>{timers.add(fn);return fn};w.clearInterval=id=>timers.delete(id);
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.fetch=async(url,options={})=>{if(url.startsWith('/api/me/table-prefs'))return {ok:true,json:async()=>({tables:{}})};calls.push({url,options});if(url.endsWith('/employees')&&directory)return {ok:true,json:()=>directory};return {ok:true,json:async()=>{if(url.endsWith('/employees'))return {rows:[]};if(options.method==='PATCH')return {};const snapshot=structuredClone(data);if(projectionProbe&&snapshot.rows[0])Object.defineProperty(snapshot.rows[0],'__projectionProbe',{enumerable:true,get(){projectionProbe.count++;return true}});return snapshot}}};
 if(local){const row={...data.rows[0],id:'new-local',rowKey:'D00002',version:1,qtyPerCarton:5};w.sessionStorage.setItem('purchase:buyer:v1',JSON.stringify({newRows:{'new-local':row},drafts:{'new-local':{version:1,before:{supplier:''},changes:{supplier:'Local'}}}}))}
 w.eval(fs.readFileSync(path.join(dir,'../../shared/table-controls.js'),'utf8'));w.PurchaseGrid=require('../public/shared/purchase-grid');w.PurchaseGridUI=require('../public/shared/purchase-grid-ui');Object.defineProperty(w.document,'hidden',{value:false,configurable:true});const realtimeAPI=w.PurchaseRealtime;w.PurchaseRealtime={...realtimeAPI,createScheduler:options=>realtimeAPI.createScheduler({...options,gapMs:0})};w.eval(fs.readFileSync(path.join(dir,'purchase.js'),'utf8'));await tick();await tick();
 return {w,data,calls,listeners,timers,get closed(){return closed},drafts:()=>JSON.parse(w.sessionStorage.getItem('purchase:buyer:v1')).drafts};
}
test('page size 10 slices the table and keeps next-page navigation',async t=>{
 const p=await page(t),doc=p.w.document;
 for(let i=2;i<=12;i++)p.data.rows.push({...p.data.rows[0],id:String(i),rowKey:'D'+String(i).padStart(5,'0')});
 p.listeners.changed();await tick();await tick();
 const size=doc.getElementById('pageSize');size.value='10';size.dispatchEvent(new p.w.Event('change',{bubbles:true}));
 assert.equal(doc.querySelectorAll('#orderTable tbody tr[data-id]').length,10);
 assert.equal(doc.getElementById('pageLabel').textContent,'Trang 1/2');
 doc.getElementById('next').click();
 assert.equal(doc.querySelectorAll('#orderTable tbody tr[data-id]').length,2);
 assert.equal(doc.getElementById('pageLabel').textContent,'Trang 2/2');
});
test('purchase errors are announced through a visible toast',async t=>{
 const p=await page(t),doc=p.w.document;
 p.w.fetch=async url=>url.endsWith('/operations')?{ok:true,json:async()=>({rows:[]})}:{ok:true,json:async()=>({rows:[]})};
 doc.getElementById('undoWork').click();await tick();
 const notice=doc.getElementById('notice');
 assert.match(notice.textContent,/Chưa có thao tác/);
 assert.ok(notice.classList.contains('toast'));
 assert.equal(notice.getAttribute('role'),'status');
});
test('integrated refresh updates another cell during numeric expression typing, retaining baseline/caret and navigation mode',async t=>{
 const p=await page(t),doc=p.w.document,input=doc.querySelector('[data-edit="cartonCount"]');input.focus();input.value='2*6';input.dataset.gridEditing='true';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.setSelectionRange(1,2);
 p.data.rows[0].supplier='Remote supplier';p.data.rows[0].cartonCount=20;p.data.rows[0].version=5;p.listeners.changed();await tick();await tick();
 assert.equal(doc.activeElement.value,'2*6');assert.equal(doc.activeElement.selectionStart,1);assert.equal(doc.activeElement.selectionEnd,2);assert.equal(doc.activeElement.dataset.gridEditing,'true');assert.equal(doc.activeElement.dataset.gridDirty,'true');assert.equal(doc.querySelector('[data-edit="supplier"]').value,'Remote supplier');assert.equal(p.drafts()['1'].before.cartonCount,10);assert.equal(p.drafts()['1'].version,4);assert.match(doc.getElementById('notice').textContent,/Người khác/);assert.ok(doc.querySelector('[data-field="cartonCount"]').classList.contains('conflict'));
});
 test('arrival inline edit sends saved contained row versions, excluding local rows and retaining edit baseline across refresh',async t=>{
  const p=await page(t,{local:true}),doc=p.w.document;assert.ok(p.drafts()['new-local']);
  let input=doc.querySelector('#containerTable [data-container-field="arrivalNote"]');input.focus();input.value='09/11';p.data.containers[0].version=9;p.data.rows[0].version=8;p.listeners.changed();await tick();await tick();input=doc.activeElement;assert.equal(input.value,'09/11');input.dispatchEvent(new p.w.Event('change',{bubbles:true}));
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
test('input burst avoids repeated synchronous cont/task rebuilds while keeping draft and totals current',async t=>{
 const p=await page(t),doc=p.w.document,row=p.data.rows[0];row.kgPerCarton=10;row.m3PerCarton=.1;p.listeners.changed();await tick();await tick();
 doc.querySelector('#containerTable [data-container-filter="2"]').click();
 const frames=new Map();let frameId=0;p.w.requestAnimationFrame=callback=>{const id=++frameId;frames.set(id,callback);return id};p.w.cancelAnimationFrame=id=>frames.delete(id);
 const countWrites={containers:0,tasks:0},watch=(element,key)=>{let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'innerHTML');proto=Object.getPrototypeOf(proto)}Object.defineProperty(element,'innerHTML',{configurable:true,get(){return descriptor.get.call(element)},set(value){countWrites[key]++;descriptor.set.call(element,value)}})};
 watch(doc.getElementById('containerTable'),'containers');watch(doc.getElementById('purchaseTaskBar'),'tasks');
 const input=doc.querySelector('[data-edit="cartonCount"]');input.focus();
 for(const value of ['11','12','13']){input.value=value;input.dispatchEvent(new p.w.Event('input',{bubbles:true}))}
 assert.deepEqual(countWrites,{containers:0,tasks:0},'input burst must not rebuild summary DOM synchronously');const pendingFrames=[...frames.values()];frames.clear();pendingFrames.forEach(callback=>callback(16));
 assert.deepEqual(countWrites,{containers:1,tasks:1},'one frame rebuilds each summary once');assert.equal(p.drafts()['1'].changes.cartonCount,13);const values=[...doc.querySelector('#containerTable [data-container-filter="2"]').closest('tr').querySelectorAll('td.num')].slice(0,3).map(td=>td.textContent);assert.deepEqual(values,['1','0.13','1.30']);
 assert.match(doc.querySelector('#purchaseTaskBar strong').textContent,/0\.13 \/ 32 T · 1\.30 \/ 170 m³/);
});
test('commit announces saving while the write is pending',async t=>{
 const p=await page(t),doc=p.w.document,input=doc.querySelector('[data-edit="supplier"]');input.focus();input.value='Saved supplier';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('save').click();
 let resolveWrite;const write=new Promise(resolve=>{resolveWrite=resolve}),fetch=p.w.fetch;p.w.fetch=async(url,options={})=>url==='/api/purchase-orders/1'&&options.method==='PATCH'?write:fetch(url,options);
 const commit=doc.getElementById('commit');commit.click();await tick();assert.equal(commit.disabled,true);assert.equal(commit.getAttribute('aria-busy'),'true');assert.match(commit.textContent,/Đang lưu/);assert.equal(doc.querySelector('#modal [role="status"]')?.textContent,'Đang lưu thay đổi…');assert.equal(doc.getElementById('modal').open,true);
 resolveWrite({ok:true,json:async()=>({})});for(let i=0;i<5;i++)await tick();
});
test('successful save closes before delta refresh finishes and later applies authoritative row delta',async t=>{
 const p=await page(t,{revision:'8:1'}),doc=p.w.document;const input=doc.querySelector('[data-edit="supplier"]');input.focus();input.value='Saved supplier';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('save').click();
 let resolveDelta;const delta=new Promise(resolve=>{resolveDelta=resolve});const fetch=p.w.fetch;p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/1'&&options.method==='PATCH'){p.data.rows[0].supplier='Saved supplier';p.data.rows[0].version=5;return {ok:true,json:async()=>({...structuredClone(p.data.rows[0]),operationId:'op-1'})}}if(url.startsWith('/api/purchase-orders/changes?')){p.calls.push({url,options});return delta}return fetch(url,options)};
 const root=doc.getElementById('orderTable');let writes=0,proto=Object.getPrototypeOf(root),descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'innerHTML');proto=Object.getPrototypeOf(proto)}Object.defineProperty(root,'innerHTML',{configurable:true,get(){return descriptor.get.call(root)},set(value){writes++;descriptor.set.call(root,value)}});
 doc.getElementById('commit').click();for(let i=0;i<5;i++)await tick();
 const supplierCell=()=>doc.querySelector('tr[data-id="1"] [data-field="supplier"]');assert.equal(doc.getElementById('modal').open,false);assert.equal(p.drafts()['1'],undefined);assert.match(doc.getElementById('notice').textContent,/Đang đồng bộ/);assert.equal(supplierCell().querySelector('input')?.value||supplierCell().textContent,'Saved supplier','authoritative PATCH row should render before the background delta');assert.equal(writes,1,'the accepted PATCH row renders while the background delta is pending');assert.ok(p.calls.some(c=>c.url==='/api/purchase-orders/changes?after=8%3A1'));
 doc.getElementById('notice').textContent='Thông báo mới hơn';
 resolveDelta({ok:true,json:async()=>({revision:'8:2',rows:[structuredClone(p.data.rows[0])],deletedIds:[],containers:p.data.containers,sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:false})});for(let i=0;i<5;i++)await tick();
 assert.equal(writes,2,'the later delta applies after the authoritative PATCH row render');assert.equal(supplierCell().querySelector('input')?.value||supplierCell().textContent,'Saved supplier');assert.equal(p.drafts()['1'],undefined);assert.equal(doc.getElementById('save').hidden,true);assert.equal(doc.getElementById('notice').textContent,'Thông báo mới hơn','background completion must not overwrite a newer notice');
});
test('automatic invalidation uses changes and only reset falls back to full snapshot',async t=>{
 const p=await page(t,{revision:'8:1'}),doc=p.w.document,fetch=p.w.fetch;let revision='8:2',reset=false,changeCalls=0,revisionCalls=0;
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/revision'){revisionCalls++;return {ok:true,json:async()=>({revision})}}if(url.startsWith('/api/purchase-orders/changes?')){changeCalls++;if(reset)return {ok:true,json:async()=>({revision,rows:[],deletedIds:[],containers:p.data.containers,sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:true})};p.data.rows[0].supplier='Remote delta';p.data.rows[0].version=5;return {ok:true,json:async()=>({revision,rows:[structuredClone(p.data.rows[0])],deletedIds:[],containers:p.data.containers,sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:false})}}if(url==='/api/purchase-orders'&&!options.method&&reset){p.calls.push({url,options});return {ok:true,json:async()=>structuredClone({...p.data,revision})}}return fetch(url,options)};
 const fullCount=()=>p.calls.filter(c=>c.url==='/api/purchase-orders'&&!c.options.method).length,initialFull=fullCount();p.listeners.changed();for(let i=0;i<5;i++)await tick();
 assert.equal(changeCalls,1);assert.equal(fullCount(),initialFull);assert.equal(doc.querySelector('[data-edit="supplier"]').value,'Remote delta');
 revision='8:3';reset=true;p.data.rows[0].supplier='Reset snapshot';p.listeners.changed();for(let i=0;i<30;i++)await tick();
 assert.equal(revisionCalls,2,'each invalidation checks the lightweight revision');assert.equal(changeCalls,2,'each new revision consumes a delta');assert.equal(fullCount(),initialFull+1);assert.equal(doc.querySelector('[data-edit="supplier"]').value,'Reset snapshot');
});
test('definite save rejection keeps draft and re-enables commit for retry',async t=>{
 const p=await page(t,{local:true}),doc=p.w.document;doc.getElementById('save').click();const commit=doc.getElementById('commit'),fetch=p.w.fetch;p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/plan'&&options.method==='POST'){p.calls.push({url,options});return {ok:false,status:400,json:async()=>({error:'Definite validation rejection'})}}return fetch(url,options)};
 commit.click();for(let i=0;i<5;i++)await tick();
 assert.equal(p.calls.filter(c=>c.url==='/api/purchase-orders/plan'&&c.options.method==='POST').length,1);assert.ok(p.drafts()['new-local']);assert.equal(doc.getElementById('modal').open,true);assert.equal(doc.getElementById('retryWrite').hidden,true);assert.equal(commit.disabled,false);
});
test('definite row validation rejection keeps confirmation modal and draft',async t=>{
 const p=await page(t),doc=p.w.document,input=doc.querySelector('[data-edit="supplier"]');input.focus();input.value='Invalid supplier';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('save').click();const fetch=p.w.fetch;p.w.fetch=async(url,options={})=>url==='/api/purchase-orders/1'&&options.method==='PATCH'?{ok:false,status:400,json:async()=>({error:'Definite validation rejection'})}:fetch(url,options);
 doc.getElementById('commit').click();for(let i=0;i<5;i++)await tick();
 assert.ok(p.drafts()['1']);assert.equal(doc.getElementById('modal').open,true);assert.equal(doc.getElementById('commit').disabled,false);assert.match(doc.getElementById('notice').textContent,/Definite validation rejection/);
});
test('ambiguous save failure keeps commit disabled while retry outbox is pending',async t=>{
 const p=await page(t,{local:true}),doc=p.w.document;doc.getElementById('save').click();const commit=doc.getElementById('commit'),fetch=p.w.fetch;p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/plan'&&options.method==='POST'){p.calls.push({url,options});return {ok:false,status:500,json:async()=>({error:'Ambiguous server failure'})}}return fetch(url,options)};
 commit.click();for(let i=0;i<5;i++)await tick();
 assert.ok(p.drafts()['new-local']);assert.equal(doc.getElementById('modal').open,true);assert.equal(doc.getElementById('retryWrite').hidden,false);assert.equal(commit.disabled,true);
});
test('successful outbox retry closes modal without waiting for background delta',async t=>{
 const p=await page(t,{local:true,revision:'8:1'}),doc=p.w.document,fetch=p.w.fetch;let writes=0,resolveDelta;const delta=new Promise(resolve=>{resolveDelta=resolve}),keys=[];
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/plan'&&options.method==='POST'){writes++;keys.push(options.headers['Idempotency-Key']);if(writes===1)return {ok:false,status:500,json:async()=>({error:'Ambiguous server failure'})};p.data.rows.push({...p.data.rows[0],id:'new-local',rowKey:'D00002',supplier:'Local'});return {ok:true,json:async()=>({})}}if(url.startsWith('/api/purchase-orders/changes?')){p.calls.push({url,options});return delta}return fetch(url,options)};
 doc.getElementById('save').click();doc.getElementById('commit').click();for(let i=0;i<5;i++)await tick();assert.equal(doc.getElementById('modal').open,true);assert.ok(p.drafts()['new-local']);
 doc.getElementById('retryWrite').click();for(let i=0;i<5;i++)await tick();assert.equal(writes,2);assert.equal(keys[1],keys[0],'outbox retry must reuse the original idempotency key');assert.equal(doc.getElementById('modal').open,false);assert.equal(p.drafts()['new-local'],undefined);assert.match(doc.getElementById('notice').textContent,/Đang đồng bộ/);assert.ok(p.calls.some(c=>c.url==='/api/purchase-orders/changes?after=8%3A1'));
 resolveDelta({ok:true,json:async()=>({revision:'8:2',rows:[{...p.data.rows.at(-1),version:1}],deletedIds:[],containers:p.data.containers,sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:false})});for(let i=0;i<5;i++)await tick();const localSupplier=doc.querySelector('tr[data-id="new-local"] [data-field="supplier"]');assert.equal(localSupplier.querySelector('input')?.value||localSupplier.textContent,'Local');
});
test('discarded local row is not resurrected by an otherwise empty delta',async t=>{
 const p=await page(t,{local:true,revision:'8:1'}),doc=p.w.document,fetch=p.w.fetch;let changeCalls=0;
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/revision')return {ok:true,json:async()=>({revision:'8:2'})};if(url.startsWith('/api/purchase-orders/changes?')){changeCalls++;return {ok:true,json:async()=>({revision:'8:2',rows:[],deletedIds:[],containers:p.data.containers,sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:false})}}return fetch(url,options)};
 assert.ok(doc.querySelector('tr[data-id="new-local"]'));doc.getElementById('cancel').click();doc.getElementById('discard').click();assert.equal(doc.querySelector('tr[data-id="new-local"]'),null);
 p.listeners.changed();for(let i=0;i<10;i++)await tick();assert.equal(changeCalls,1);assert.equal(doc.querySelector('tr[data-id="new-local"]'),null);
});
test('one view-only full render projects each source row once for every summary',async t=>{
 const projectionProbe={count:0},p=await page(t,{projectionProbe});projectionProbe.count=0;p.w.document.getElementById('bulk').click();
 assert.equal(projectionProbe.count,1,'one full render should build one shared projected row array');
});
test('Đối chiếu overrides are directly editable and sent through the normal versioned row patch',async t=>{
 const p=await page(t),doc=p.w.document;p.data.rows[0].literChina=120;p.data.rows[0].measurementOverrides={literChina:120};p.data.rows.push({...p.data.rows[0],id:'2',rowKey:'D00002',literChina:110,measurementOverrides:{literChina:110}});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();doc.querySelector('[data-column="literChina"]').checked=true;doc.querySelector('[data-column="literChina"]').dispatchEvent(new p.w.Event('change',{bubbles:true}));
 const cells=doc.querySelectorAll('[data-field="literChina"]'),paste=new p.w.Event('paste',{bubbles:true,cancelable:true});cells[0].click();paste.clipboardData={getData:()=> '121\n122'};cells[0].dispatchEvent(paste);assert.equal(p.drafts()['2'].changes.literChina,121);assert.equal(p.drafts()['1'].changes.literChina,122);doc.getElementById('undoWork').click();assert.equal(p.drafts()['1'],undefined);assert.equal(p.drafts()['2'],undefined);
 const input=doc.querySelector('tr[data-id="1"] [data-edit="literChina"]');assert.ok(input);assert.equal(doc.querySelector('[data-field="status"] input'),null);input.focus();input.value='125';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));assert.equal(p.drafts()['1'].changes.literChina,125);
 doc.getElementById('save').click();doc.getElementById('commit').click();await tick();await tick();const call=p.calls.find(c=>c.options.method==='PATCH'&&c.url.endsWith('/1'));assert.ok(call);assert.deepEqual(JSON.parse(call.options.body),{version:4,before:{literChina:120},changes:{literChina:125}});
});
test('measurement inputs show agreed precision and focus/blur alone creates no draft',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{kgPerCarton:14.041,m3PerCarton:.0671,qtyPerCarton:3});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();for(const key of ['kgPerCarton','m3PerCarton','gramChina']){const box=doc.querySelector('[data-column="'+key+'"]');box.checked=true;box.dispatchEvent(new p.w.Event('change',{bubbles:true}))}
 for(const [key,shown] of [['kgPerCarton','14.0'],['m3PerCarton','0.067'],['gramChina','4,680']]){let input=doc.querySelector('[data-edit="'+key+'"]');assert.equal(input.value,shown,key+' initial');input.focus();input.blur();await new Promise(resolve=>setTimeout(resolve,5));input=doc.querySelector('[data-edit="'+key+'"]');assert.equal(input.value,shown,key+' after blur')}assert.equal(Object.keys(p.drafts()).length,0);
});
test('calculated ratio is shown as a rounded percentage in edit and view modes',async t=>{
 for(const readOnly of [false,true]){const p=await page(t,{readOnly}),doc=p.w.document;Object.assign(p.data.rows[0],{kgPerCarton:14,m3PerCarton:.067});p.listeners.changed();await tick();await tick();
  doc.getElementById('columns').click();const box=doc.querySelector('[data-column="ratio"]');box.checked=true;box.dispatchEvent(new p.w.Event('change',{bubbles:true}));
  assert.equal(readOnly?doc.querySelector('[data-field="ratio"]').textContent:doc.querySelector('[data-edit="ratio"]').value,'20.9%',readOnly?'read-only':'editable');
 }
});
test('percentage overrides edit in displayed percentage points; blank clears a value override',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{literDiff:-.03,ratio:25,literChina:1.23,measurementOverrides:{literDiff:-.03,ratio:25,literChina:1.23}});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();for(const key of ['literDiff','ratio','literChina']){const box=doc.querySelector('[data-column="'+key+'"]');box.checked=true;box.dispatchEvent(new p.w.Event('change',{bubbles:true}))}
  assert.equal(doc.querySelector('[data-edit="literDiff"]').value,'-3.0%');assert.equal(doc.querySelector('[data-edit="ratio"]').value,'25.0%');
 for(const [key,v] of [['literDiff','12'],['ratio','12'],['literChina','']]){const input=doc.querySelector('tr[data-id="1"] [data-edit="'+key+'"]');input.value=v;input.dispatchEvent(new p.w.Event('input',{bubbles:true}))}
 assert.deepEqual(p.drafts()['1'].changes,{literDiff:.12,ratio:12,literChina:null});doc.getElementById('save').click();doc.getElementById('commit').click();await tick();await tick();const body=JSON.parse(p.calls.find(c=>c.options.method==='PATCH'&&c.url.endsWith('/1')).options.body);assert.deepEqual(body.changes,{literDiff:.12,ratio:12,literChina:null});
});
test('staged override changes and clears recalculate dependent comparison fields from fallback',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{m3PerCarton:.005,literWarehouse:1,literChina:1.2,literDiff:.2,measurementOverrides:{literChina:1.2},measurementDefaults:{literWarehouse:1,m3Warehouse:null,literChina:1,literDiff:0,gramWarehouse:null,gramChina:null,gramDiff:null,measuredOn:null,ratio:null}});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();for(const key of ['literChina','literDiff']){const box=doc.querySelector('[data-column="'+key+'"]');box.checked=true;box.dispatchEvent(new p.w.Event('change',{bubbles:true}))}
  let input=doc.querySelector('tr[data-id="1"] [data-edit="literChina"]');input.focus();input.value='1.5';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));assert.equal(doc.querySelector('tr[data-id="1"] [data-edit="literDiff"]').value,'+50.0%');
  input=doc.querySelector('tr[data-id="1"] [data-edit="literChina"]');input.focus();input.value='';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));assert.equal(doc.querySelector('tr[data-id="1"] [data-edit="literDiff"]').value,'0.0%');
});
test('new row submission carries staged comparison overrides',async t=>{
 const p=await page(t,{local:true}),doc=p.w.document;doc.getElementById('columns').click();doc.querySelector('[data-column="literChina"]').checked=true;doc.querySelector('[data-column="literChina"]').dispatchEvent(new p.w.Event('change',{bubbles:true}));
 const input=doc.querySelector('tr[data-id="new-local"] [data-edit="literChina"]');assert.ok(input);input.value='125';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));doc.getElementById('save').click();doc.getElementById('commit').click();await tick();await tick();const call=p.calls.find(c=>c.options.method==='POST'&&c.url==='/api/purchase-orders/plan');assert.ok(call);const body=JSON.parse(call.options.body);assert.equal(body.creates[0].values.literChina,125);
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
test('employee manager stages RGB edits and saves once with rendered versions despite SSE refresh',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;let directory=[{id:'nv',name:'Original name',color:'#2563EB',version:2,isActive:true}];
 p.w.fetch=async(url,options={})=>{
  if(url.endsWith('/employees'))return {ok:true,json:async()=>({rows:structuredClone(directory)})};
  if(url.endsWith('/employees/batch')&&options.method==='PUT'){p.calls.push({url,options});const {entries}=JSON.parse(options.body),ok=entries.every(entry=>{const saved=directory.find(row=>String(row.id)===String(entry.id));return saved&&entry.version===saved.version});return {ok,status:ok?200:409,json:async()=>ok?{rows:directory}:{error:'Employee conflict'}}}
  return fetch(url,options);
 };
 doc.getElementById('managePurchaseEmployees').click();await tick();await tick();const input=doc.querySelector('[data-directory-name]');input.value='Local rename';doc.querySelector('[data-directory-color]').value='#E84A5F';doc.querySelector('[data-directory-active]').value='false';
 assert.equal(doc.querySelectorAll('[data-directory-save],[data-directory-toggle]').length,0);assert.ok(doc.getElementById('savePurchaseEmployees'));
 directory=[{id:'nv',name:'Remote rename',color:'#2563EB',version:7,isActive:false}];p.listeners.changed();await tick();await tick();assert.equal(input.value,'Local rename');
 doc.getElementById('savePurchaseEmployees').click();await tick();await tick();const call=p.calls.find(c=>c.url.endsWith('/employees/batch')),body=JSON.parse(call.options.body);
 assert.equal(call.options.method,'PUT');assert.deepEqual(body.entries,[{id:'nv',version:2,name:'Local rename',color:'#E84A5F',isActive:false}]);assert.equal(directory[0].name,'Remote rename');assert.match(doc.getElementById('notice').textContent,/Employee conflict/);assert.equal(input.value,'Local rename');
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
