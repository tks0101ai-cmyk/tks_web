'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM}=require('jsdom');
const dir=path.join(__dirname,'../public/thu-mua/dat-hang'),tick=()=>new Promise(setImmediate);
async function page(t,{local=false,localCount=1,directory=null,projectionProbe=null,revision=null,readOnly=false}={}){
 const w=new JSDOM(fs.readFileSync(path.join(dir,'index.html'),'utf8'),{url:'https://example.test/thu-mua/dat-hang/',runScripts:'outside-only'}).window;
 t.after(()=>w.close());w.HTMLCanvasElement.prototype.getContext=()=>null;
 const data={...(revision?{revision}:{}),sourceMode:'web',integrationEnabled:true,permissions:{edit:!readOnly,import:true,export:true,depart:true,arrive:true},regions:[],rows:[{id:'1',rowKey:'D00001',version:4,contId:'2',productCode:'A',productName:'Product',supplier:'Old',cartonCount:10,qtyPerCarton:5}],containers:[{id:'2',name:'CONT 11-1V',status:2,version:3,arrival_note:'2026-11-08',arrival_date:null}]},listeners={},calls=[],timers=new Set();let closed=0;
 for(const [name,file] of Object.entries({PurchaseCalculations:'purchase-calculations',PurchaseFreight:'purchase-freight',PurchaseColumns:'purchase-columns',PurchaseTasks:'purchase-tasks',PurchaseRealtime:'purchase-realtime',PurchaseDraftHistory:'purchase-draft-history',PurchaseContainerWorkspace:'purchase-container-workspace'}))w[name]=require('../public/shared/'+file);
 w.TKSNav={authGuard:async()=>({id:'buyer'})};w.EventSource=class{addEventListener(k,f){listeners[k]=f}close(){closed++}};
 w.setInterval=fn=>{timers.add(fn);return fn};w.clearInterval=id=>timers.delete(id);
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.fetch=async(url,options={})=>{if(url.startsWith('/api/me/table-prefs'))return {ok:true,json:async()=>({tables:{}})};calls.push({url,options});if(url.endsWith('/employees')&&directory)return {ok:true,json:()=>directory};if(url.endsWith('/regions'))return {ok:true,json:async()=>({rows:data.regions})};if(url.endsWith('/regions/batch'))return {ok:true,json:async()=>({rows:options?.body?JSON.parse(options.body).entries.map((r,i)=>({...r,id:r.id||String(i+1),version:1})):data.regions})};return {ok:true,json:async()=>{if(url.endsWith('/employees'))return {rows:[]};if(options.method==='PATCH')return {};const snapshot=structuredClone(data);if(projectionProbe&&snapshot.rows[0])Object.defineProperty(snapshot.rows[0],'__projectionProbe',{enumerable:true,get(){projectionProbe.count++;return true}});return snapshot}}};
 if(local){const newRows={},drafts={};for(let i=1;i<=localCount;i++){const id=i===1?'new-local':`new-local-${i}`,row={...data.rows[0],id,rowKey:`D${String(i+1).padStart(5,'0')}`,reservationId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,version:1,qtyPerCarton:5},supplier=i===1?'Local':`Local ${i}`;newRows[id]=row;drafts[id]={version:1,before:{supplier:''},changes:{supplier}}}w.sessionStorage.setItem('purchase:buyer:v1',JSON.stringify({newRows,drafts}))}
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
test('bulk row ticks update selection without rebuilding the order table',async t=>{
 const p=await page(t),doc=p.w.document,root=doc.getElementById('orderTable');doc.getElementById('bulk').click();let writes=0,proto=Object.getPrototypeOf(root),descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'innerHTML');proto=Object.getPrototypeOf(proto)}Object.defineProperty(root,'innerHTML',{configurable:true,get(){return descriptor.get.call(root)},set(value){writes++;descriptor.set.call(root,value)}});
 const checkbox=doc.querySelector('#orderTable input[data-pick]');checkbox.checked=true;checkbox.dispatchEvent(new p.w.Event('change',{bubbles:true}));assert.equal(writes,0);assert.equal(doc.getElementById('bulk').textContent,'Đang chọn 1 dòng');assert.equal(doc.querySelector('#pickAll').checked,true);
});
test('opening a date cell edits only that cell without rebuilding the order table',async t=>{
 const p=await page(t),doc=p.w.document,root=doc.getElementById('orderTable');let writes=0,proto=Object.getPrototypeOf(root),descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'innerHTML');proto=Object.getPrototypeOf(proto)}Object.defineProperty(root,'innerHTML',{configurable:true,get(){return descriptor.get.call(root)},set(value){writes++;descriptor.set.call(root,value)}});
 doc.querySelector('#orderTable [data-field="listedAt"] .date-label').click();assert.equal(writes,0);assert.ok(doc.querySelector('#orderTable [data-edit="listedAt"]'));assert.equal(doc.activeElement.dataset.edit,'listedAt');
});
test('date notes accept an approximate day range and save it as entered',async t=>{
 const p=await page(t),doc=p.w.document;doc.getElementById('columns').click();const option=doc.querySelector('[data-column="etaNote"]');option.checked=true;option.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('modalClose').click();const input=doc.querySelector('#orderTable [data-edit="etaNote"]');assert.ok(input);input.value='11-12/11';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));
 let saved;const fetch=p.w.fetch;p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/1'&&options.method==='PATCH'){saved=JSON.parse(options.body);return {ok:true,json:async()=>({})}}return fetch(url,options)};doc.getElementById('save').click();assert.ok(doc.getElementById('commit'));doc.getElementById('commit').click();for(let i=0;i<6;i++)await tick();assert.equal(saved.changes.etaNote,'11-12/11');
});
test('purchase errors are announced through a visible toast',async t=>{
 const p=await page(t),doc=p.w.document;
 p.w.fetch=async url=>url.endsWith('/operations')?{ok:true,json:async()=>({rows:[]})}:{ok:true,json:async()=>({rows:[]})};
 doc.querySelector('#orderTable [data-field="supplier"]').focus();
 doc.activeElement.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true}));await tick();
 const notice=doc.getElementById('notice');
 assert.match(notice.textContent,/Chưa có thao tác/);
 assert.ok(notice.classList.contains('toast'));
 assert.equal(notice.getAttribute('role'),'status');
});
test('Ctrl+Z undoes a grid paste but leaves native undo alone in the search field',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{literChina:120,measurementOverrides:{literChina:120}});
 p.data.rows.push({...p.data.rows[0],id:'2',rowKey:'D00002',literChina:110,measurementOverrides:{literChina:110}});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();const box=doc.querySelector('[data-column="literChina"]');box.checked=true;box.dispatchEvent(new p.w.Event('change',{bubbles:true}));
 const cell=doc.querySelector('[data-field="literChina"]'),paste=new p.w.Event('paste',{bubbles:true,cancelable:true});cell.click();paste.clipboardData={getData:()=> '121\n122'};cell.dispatchEvent(paste);
 assert.ok(p.drafts()['1']);const currentCell=doc.querySelector('[data-field="literChina"]'),undo=new p.w.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});currentCell.focus();currentCell.dispatchEvent(undo);assert.equal(undo.defaultPrevented,true);assert.equal(p.drafts()['1'],undefined);assert.equal(p.drafts()['2'],undefined);
 const search=doc.getElementById('search'),nativeUndo=new p.w.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});search.dispatchEvent(nativeUndo);assert.equal(nativeUndo.defaultPrevented,false);
});
test('Ctrl+Z undoes an edited input before it loses focus',async t=>{
 const p=await page(t),doc=p.w.document,input=doc.querySelector('[data-edit="supplier"]');input.focus();input.value='New supplier';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 await new Promise(resolve=>setTimeout(resolve,260));
 assert.equal(p.drafts()['1'].changes.supplier,'New supplier');
 input.addEventListener('keydown',e=>e.stopPropagation(),{once:true});
 const undo=new p.w.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});input.dispatchEvent(undo);
 assert.equal(undo.defaultPrevented,true);assert.equal(p.drafts()['1'],undefined);assert.equal(doc.activeElement.dataset.edit,'supplier');
});
test('container ratio is total tons divided by total cubic meters',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{cartonCount:10,kgPerCarton:2,m3PerCarton:.25});p.listeners.changed();await tick();await tick();
 assert.equal(doc.querySelector('#containerTable tbody tr:nth-child(2) td:nth-child(11)').textContent,'0.8%');
});
test('order lifecycle sits last and container lifecycle is confirmed with the current version',async t=>{
 const p=await page(t),doc=p.w.document;
 assert.equal(doc.querySelector('#orderTable thead th:last-child').textContent,'Trạng thái');
 assert.equal(doc.querySelector('#orderTable tbody .purchase-lifecycle-badge').textContent,'Hoạt động');
 assert.equal(doc.querySelector('#containerTable thead tr th:nth-last-child(2)').textContent.replace(/[▲▼]/g,'').trim(),'Người xếp');assert.equal(doc.querySelector('#containerTable thead tr th:last-child').textContent.replace(/[▲▼]/g,'').trim(),'Hoạt động');assert.equal(doc.querySelector('#containerTable tbody tr:nth-child(2) td:last-child .purchase-lifecycle-badge').textContent,'Hoạt động');
 doc.querySelector('#containerTable [data-container-lifecycle]').click();assert.equal(p.calls.some(call=>call.url.endsWith('/containers/deactivate')),false);doc.getElementById('confirmContainerLifecycle').click();await tick();await tick();
 const request=p.calls.find(call=>call.url.endsWith('/containers/deactivate'));
 assert.deepEqual(JSON.parse(request.options.body),{id:'2',version:3});
});
test('pinned container sits under filters and shows the six compact identity and metrics columns',async t=>{
 const p=await page(t),doc=p.w.document;doc.querySelector('#containerTable [data-container-filter="2"]').click();
 const filters=doc.querySelector('.order-filters'),watched=doc.getElementById('watchedContainer');assert.ok(filters.compareDocumentPosition(watched)&p.w.Node.DOCUMENT_POSITION_FOLLOWING);
 assert.equal(watched.querySelectorAll('thead th').length,8);assert.deepEqual([...watched.querySelectorAll('thead th')].slice(0,6).map(th=>th.textContent.trim()),['Tên cont','Hoạt động','Trạng thái','Tổng tấn','Tổng m³ đang xếp','Tổng m³ giả định']);assert.equal(watched.querySelectorAll('.sort-indicator').length,0);
});
test('assumed m3 is editable in the container grid and required by the create dialog',async t=>{
 const p=await page(t),doc=p.w.document;assert.equal(doc.querySelector('#containerTable [data-container-field="assumedM3"]').tagName,'INPUT');
 doc.getElementById('newCont').click();const form=doc.getElementById('contForm');assert.equal(form.elements.assumedM3.tagName,'INPUT');form.elements.name.value='NEW CONT';form.elements.assumedM3.value='170';form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();
 const call=p.calls.find(c=>c.url.endsWith('/containers'));assert.deepEqual(JSON.parse(call.options.body),{name:'NEW CONT',regionId:'',assumedM3:'170'});
});
test('clearing assumed m3 sends null and negative assumed m3 is rejected',async t=>{
 const p=await page(t),doc=p.w.document;p.data.containers[0].assumed_m3=170;p.listeners.changed();await tick();await tick();const input=doc.querySelector('#containerTable [data-container-field="assumedM3"]');input.focus();input.value='';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));await tick();await tick();const calls=()=>p.calls.filter(c=>c.url.endsWith('/containers/2')&&c.options.method==='PATCH');assert.equal(JSON.parse(calls()[0].options.body).changes.assumedM3,null);assert.equal(doc.getElementById('notice').textContent,'');const updated=doc.querySelector('#containerTable [data-container-field="assumedM3"]');updated.focus();updated.value='-1';updated.dispatchEvent(new p.w.Event('change',{bubbles:true}));await tick();assert.equal(calls().length,1);assert.match(doc.getElementById('notice').textContent,/lớn hơn 0 hoặc để trống/);
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
  const draft=p.drafts()['1'];if(draft){assert.equal(draft.before.supplier,'Old');assert.equal(draft.version,4)}else assert.ok(p.calls.some(call=>call.url==='/api/purchase-orders/plan'&&JSON.parse(call.options.body).rows?.some(row=>row.changes.supplier==='Private draft')),'the delayed auto-save may commit the preserved edit while refreshes continue');
  assert.equal(doc.querySelector('[data-edit="cartonCount"]').value,String(p.data.rows[0].cartonCount));
 }
});
test('pristine focused input retains its original comparison value/version when first edited after remote refresh',async t=>{
 const p=await page(t),doc=p.w.document;doc.querySelector('[data-edit="supplier"]').focus();
 p.data.rows[0].supplier='Remote';p.data.rows[0].version=5;p.listeners.changed();await tick();await tick();
 const input=doc.querySelector('[data-edit="supplier"]');assert.equal(doc.activeElement,input);assert.equal(input.value,'Old');assert.match(input.closest('td').title,/Remote/);
 input.value='My edit';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,260));assert.equal(p.drafts()['1'].before.supplier,'Old');assert.equal(p.drafts()['1'].version,4);
});
test('input burst recalculates derived values immediately and batches summary rendering to one frame',async t=>{
 const p=await page(t),doc=p.w.document,row=p.data.rows[0];row.kgPerCarton=10;row.m3PerCarton=.1;p.listeners.changed();await tick();await tick();
 doc.querySelector('#containerTable [data-container-filter="2"]').click();
 const frames=new Map();let frameId=0;p.w.requestAnimationFrame=callback=>{const id=++frameId;frames.set(id,callback);return id};p.w.cancelAnimationFrame=id=>frames.delete(id);
 const countWrites={containers:0,tasks:0},watch=(element,key)=>{let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'innerHTML');proto=Object.getPrototypeOf(proto)}Object.defineProperty(element,'innerHTML',{configurable:true,get(){return descriptor.get.call(element)},set(value){countWrites[key]++;descriptor.set.call(element,value)}})};
 watch(doc.getElementById('containerTable'),'containers');watch(doc.getElementById('purchaseTaskBar'),'tasks');
 const input=doc.querySelector('[data-edit="cartonCount"]');input.focus();
 for(const value of ['11','12','13']){input.value=value;input.dispatchEvent(new p.w.Event('input',{bubbles:true}))}
 assert.deepEqual(countWrites,{containers:0,tasks:0},'derived values update without rebuilding summary tables');assert.equal(doc.querySelector('#orderTable [data-field="totalM3"]')?.textContent,'1.30','dependent volume calculation updates during input');assert.equal(doc.querySelector('#containerTable [data-container-filter="2"]').closest('tr').cells[3].textContent,'1.30','container m3 updates in place during input');for(const [id,callback] of [...frames]){frames.delete(id);callback(0)}
 assert.deepEqual(countWrites,{containers:0,tasks:1},'summary task panel is refreshed once per frame without rebuilding container rows');const summary=doc.querySelector('#containerTable [data-container-filter="2"]').closest('tr').cells;assert.deepEqual([summary[2].textContent,summary[3].textContent],['0.13','1.30']);assert.equal(summary[6].querySelector('[data-cont-freight]').value,'202,000,000');assert.equal(summary[7].textContent,'155,384,615');
 assert.match(doc.querySelector('#purchaseTaskBar strong').textContent,/0\.13 \/ 32 T · 1\.30 \/ 170 m³/);
});
test('commit sync stays silent while the write is pending',async t=>{
 const p=await page(t),doc=p.w.document,input=doc.querySelector('[data-edit="supplier"]');input.focus();input.value='Saved supplier';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('save').click();
 let resolveWrite;const write=new Promise(resolve=>{resolveWrite=resolve}),fetch=p.w.fetch;p.w.fetch=async(url,options={})=>url==='/api/purchase-orders/1'&&options.method==='PATCH'?write:fetch(url,options);
 const commit=doc.getElementById('commit');commit.click();await tick();assert.equal(commit.disabled,true);assert.equal(commit.hasAttribute('aria-busy'),false);assert.equal(commit.textContent,'Lưu thay đổi');assert.equal(doc.querySelector('#modal [role="status"]')?.textContent,'');assert.equal(doc.getElementById('notice').textContent,'');assert.equal(doc.getElementById('modal').open,true);
 resolveWrite({ok:true,json:async()=>({})});for(let i=0;i<5;i++)await tick();
});
test('successful save closes without a sync toast and later applies authoritative row delta',async t=>{
 const p=await page(t,{revision:'8:1'}),doc=p.w.document;const input=doc.querySelector('[data-edit="supplier"]');input.focus();input.value='Saved supplier';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));input.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('save').click();
 let resolveDelta;const delta=new Promise(resolve=>{resolveDelta=resolve});const fetch=p.w.fetch;p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/1'&&options.method==='PATCH'){p.data.rows[0].supplier='Saved supplier';p.data.rows[0].version=5;return {ok:true,json:async()=>({...structuredClone(p.data.rows[0]),operationId:'op-1'})}}if(url.startsWith('/api/purchase-orders/changes?')){p.calls.push({url,options});return delta}return fetch(url,options)};
 const root=doc.getElementById('orderTable');let writes=0,proto=Object.getPrototypeOf(root),descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'innerHTML');proto=Object.getPrototypeOf(proto)}Object.defineProperty(root,'innerHTML',{configurable:true,get(){return descriptor.get.call(root)},set(value){writes++;descriptor.set.call(root,value)}});
 doc.getElementById('commit').click();for(let i=0;i<5;i++)await tick();
 const supplierCell=()=>doc.querySelector('tr[data-id="1"] [data-field="supplier"]');assert.equal(doc.getElementById('modal').open,false);assert.equal(p.drafts()['1'],undefined);assert.equal(doc.getElementById('notice').textContent,'');assert.equal(supplierCell().querySelector('input')?.value||supplierCell().textContent,'Saved supplier','authoritative PATCH row should render before the background delta');assert.equal(writes,1,'the accepted PATCH row renders while the background delta is pending');assert.ok(p.calls.some(c=>c.url==='/api/purchase-orders/changes?after=8%3A1'));
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
 doc.getElementById('retryWrite').click();for(let i=0;i<5;i++)await tick();assert.equal(writes,2);assert.equal(keys[1],keys[0],'outbox retry must reuse the original idempotency key');assert.equal(doc.getElementById('modal').open,false);assert.equal(p.drafts()['new-local'],undefined);assert.doesNotMatch(doc.getElementById('notice').textContent,/Đang đồng bộ/);assert.ok(p.calls.some(c=>c.url==='/api/purchase-orders/changes?after=8%3A1'));
 resolveDelta({ok:true,json:async()=>({revision:'8:2',rows:[{...p.data.rows.at(-1),version:1}],deletedIds:[],containers:p.data.containers,sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:false})});for(let i=0;i<5;i++)await tick();const localSupplier=doc.querySelector('tr[data-id="new-local"] [data-field="supplier"]');assert.equal(localSupplier.querySelector('input')?.value||localSupplier.textContent,'Local');
});
test('empty realtime delta advances revision without rebuilding the order grid',async t=>{
 const p=await page(t,{revision:'8:1'}),doc=p.w.document,root=doc.getElementById('orderTable'),fetch=p.w.fetch;let writes=0,proto=Object.getPrototypeOf(root),descriptor;while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'innerHTML');proto=Object.getPrototypeOf(proto)}Object.defineProperty(root,'innerHTML',{configurable:true,get(){return descriptor.get.call(root)},set(value){writes++;descriptor.set.call(root,value)}});
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/revision')return {ok:true,json:async()=>({revision:'8:2'})};if(url.startsWith('/api/purchase-orders/changes?'))return {ok:true,json:async()=>({revision:'8:2',rows:[],deletedIds:[],containers:p.data.containers,sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:false})};return fetch(url,options)};
 p.listeners.changed();for(let i=0;i<10;i++)await tick();assert.equal(writes,0);assert.equal(doc.querySelector('tr[data-id="1"] [data-field="supplier"] input').value,'Old');
});
test('discarded local row is not resurrected by an otherwise empty delta',async t=>{
 const p=await page(t,{local:true,revision:'8:1'}),doc=p.w.document,fetch=p.w.fetch;let changeCalls=0;
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/revision')return {ok:true,json:async()=>({revision:'8:2'})};if(url.startsWith('/api/purchase-orders/changes?')){changeCalls++;return {ok:true,json:async()=>({revision:'8:2',rows:[],deletedIds:[],containers:p.data.containers,sourceMode:'web',integrationEnabled:true,employeesChanged:false,reset:false})}}return fetch(url,options)};
 assert.ok(doc.querySelector('tr[data-id="new-local"]'));doc.getElementById('cancel').click();doc.getElementById('discard').click();await tick();assert.equal(doc.querySelector('tr[data-id="new-local"]'),null);
 p.listeners.changed();await new Promise(resolve=>setTimeout(resolve,500));for(let i=0;i<10;i++)await tick();assert.equal(changeCalls,1);assert.equal(doc.querySelector('tr[data-id="new-local"]'),null);
});
test('discard releases the local row reservation',async t=>{
 const p=await page(t,{local:true}),doc=p.w.document;doc.getElementById('cancel').click();doc.getElementById('discard').click();await tick();
 const release=p.calls.find(c=>c.url==='/api/purchase-orders/release-key');assert.ok(release);assert.deepEqual(JSON.parse(release.options.body),{reservationId:'00000000-0000-4000-8000-000000000001'});
 assert.equal(doc.querySelector('tr[data-id="new-local"]'),null);
});
test('discard cancels autosave before waiting for release and keeps drafts when release fails',async t=>{
 const p=await page(t,{local:true}),doc=p.w.document,fetch=p.w.fetch;let releaseCount=0,finishRelease;
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/release-key'){releaseCount++;if(releaseCount===1)return new Promise(resolve=>{finishRelease=resolve});return {ok:true,json:async()=>({released:true})}}return fetch(url,options)};
 doc.getElementById('cancel').click();doc.getElementById('discard').click();await tick();assert.equal(releaseCount,1);
 await new Promise(resolve=>setTimeout(resolve,500));assert.equal(p.calls.some(c=>c.url==='/api/purchase-orders/plan'),false,'discard must stop the scheduled autosave before awaiting release');
 finishRelease({ok:false,json:async()=>({error:'release failed'})});for(let i=0;i<5;i++)await tick();assert.ok(doc.querySelector('tr[data-id="new-local"]'));assert.ok(p.drafts()['new-local']);
 doc.getElementById('discard').click();for(let i=0;i<5;i++)await tick();assert.equal(doc.querySelector('tr[data-id="new-local"]'),null);
});
test('discard refuses while an autosaved create is in flight',async t=>{
 const p=await page(t,{local:true}),doc=p.w.document,fetch=p.w.fetch;let finishPlan;
 p.w.fetch=async(url,options={})=>url==='/api/purchase-orders/plan'&&options.method==='POST'?new Promise(resolve=>{finishPlan=resolve}):fetch(url,options);
 await new Promise(resolve=>setTimeout(resolve,500));assert.ok(finishPlan,'autosave should have started');
 doc.getElementById('cancel').click();doc.getElementById('discard').click();await tick();
 assert.ok(doc.querySelector('tr[data-id="new-local"]'));assert.ok(!p.calls.some(c=>c.url==='/api/purchase-orders/release-key'));assert.match(doc.getElementById('notice').textContent,/lưu xong/);
 p.data.rows.push({...p.data.rows[0],id:'2',rowKey:'D00002',supplier:'Local'});finishPlan({ok:true,json:async()=>({createdRows:[{clientId:'new-local',id:'2',rowKey:'D00002'}]})});
 for(let i=0;i<10;i++)await tick();assert.ok(doc.querySelector('tr[data-id="2"]'));
});
test('row history is requested by immutable order ID',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;p.w.fetch=async(url,options)=>{p.calls.push({url,options});return url==='/api/purchase-orders/history?orderId=1'?{ok:true,json:async()=>({rows:[]})}:fetch(url,options)};
 doc.querySelector('tr[data-id="1"] [data-field="productCode"] .code-label').dispatchEvent(new p.w.MouseEvent('dblclick',{bubbles:true}));await tick();
 assert.ok(p.calls.some(c=>c.url==='/api/purchase-orders/history?orderId=1'));
 assert.ok(!p.calls.some(c=>c.url.includes('history?rowKey=')));
});
test('one view-only full render projects each source row once for every summary',async t=>{
 const projectionProbe={count:0},p=await page(t,{projectionProbe});projectionProbe.count=0;p.w.document.getElementById('bulk').click();
 assert.equal(projectionProbe.count,1,'one full render should build one shared projected row array');
});
test('surcharge input accepts a percent and then displays its money amount without changing totals',async t=>{
 const p=await page(t),doc=p.w.document,row=p.data.rows[0];Object.assign(row,{qtyPerCarton:5,cartonCount:10,unitPriceCny:800,fxRate:5000,freightPrepaid:0});p.listeners.changed();await tick();await tick();
 assert.equal(doc.querySelector('[data-field="netPrice"]').textContent,'4,000,000');const totalCny=doc.querySelector('[data-field="totalCny"]').textContent;
 doc.getElementById('columns').click();const option=doc.querySelector('[data-column="surchargePercent"]');option.checked=true;option.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('modalClose').click();
 const input=doc.querySelector('[data-edit="surchargePercent"]');input.focus();input.value='10';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,260));
 assert.ok(p.drafts()['1'],JSON.stringify(p.drafts()));assert.equal(p.drafts()['1'].changes.surchargePercent,.1);assert.equal(doc.querySelector('[data-field="netPrice"]').textContent,'4,000,000');assert.equal(doc.querySelector('[data-field="totalCny"]').textContent,totalCny);assert.equal(input.value,'10');input.blur();await new Promise(resolve=>setTimeout(resolve,10));assert.equal(input.value,'20,000,000');input.focus();assert.equal(input.value,'10');
});
test('manual container freight previews assumed and actual m3 allocation immediately',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{m3PerCarton:.2,cartonCount:10});Object.assign(p.data.containers[0],{assumed_m3:10,freight:1000,freight_mode:'manual'});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();const option=doc.querySelector('[data-column="freightAmount"]');option.checked=true;option.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('modalClose').click();
 assert.equal(doc.querySelector('[data-field="freightAmount"]').textContent,'200');
 const assumed=doc.querySelector('#containerTable [data-container-field="assumedM3"]');assumed.focus();assumed.value='20';assumed.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 assert.equal(doc.querySelector('[data-field="freightAmount"]').textContent,'100');assert.equal(doc.querySelector('#containerTable tbody tr:nth-child(2) td:nth-child(8)').textContent,'50');
 assumed.value='';assumed.dispatchEvent(new p.w.Event('input',{bubbles:true}));assert.equal(doc.querySelector('[data-field="freightAmount"]').textContent,'1,000');assert.equal(doc.querySelector('#containerTable tbody tr:nth-child(2) td:nth-child(8)').textContent,'500');
});
test('spreadsheet total freight formula stays in Tiền VC and divides by assumed m3 first',async t=>{
 const p=await page(t),doc=p.w.document,formula='=(195000000+4*500*3920)/170*D2';Object.assign(p.data.rows[0],{m3PerCarton:14,cartonCount:10});Object.assign(p.data.containers[0],{assumed_m3:170,freight:null,freight_mode:'formula',freight_formula:formula});p.listeners.changed();await tick();await tick();const freight=doc.querySelector('#containerTable [data-cont-freight="2"]'),rate=()=>doc.querySelector('#containerTable [data-container-filter="2"]').closest('tr').cells[7].textContent;assert.equal(freight.value,'167,044,706');assert.equal(rate(),'982,616');const assumed=doc.querySelector('#containerTable [data-container-field="assumedM3"]');assumed.focus();assumed.value='';assumed.dispatchEvent(new p.w.Event('input',{bubbles:true}));assert.equal(freight.value,'167,044,706');assert.equal(rate(),'1,193,176');
});
test('Tiền VC displays expense per preferred m3 and reveals the saved cost expression on focus',async t=>{
 const p=await page(t),doc=p.w.document,formula='=(195000000+4*500*3920)';Object.assign(p.data.rows[0],{m3PerCarton:15,cartonCount:10});Object.assign(p.data.containers[0],{assumed_m3:170,freight:null,freight_mode:'formula',freight_formula:formula});p.listeners.changed();await tick();await tick();
 const input=doc.querySelector('#containerTable [data-cont-freight="2"]'),rate=()=>doc.querySelector('#containerTable [data-container-filter="2"]').closest('tr').cells[7].textContent;assert.equal(input.value,'202,840,000');assert.equal(rate(),'1,193,176');input.focus();assert.equal(input.value,formula);
 const assumed=doc.querySelector('#containerTable [data-container-field="assumedM3"]');assumed.focus();assumed.value='';assumed.dispatchEvent(new p.w.Event('input',{bubbles:true}));assert.equal(input.value,'202,840,000');assert.equal(rate(),'1,352,267');
});
test('formula freight displays its effective rate while VC/m3 follows assumed then actual volume',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{m3PerCarton:.2,cartonCount:10});Object.assign(p.data.containers[0],{assumed_m3:10,freight:null,freight_mode:'formula',freight_formula:'=100000/M3_XE'});p.listeners.changed();await tick();await tick();const freight=doc.querySelector('#containerTable [data-cont-freight="2"]'),rate=()=>doc.querySelector('#containerTable [data-container-filter="2"]').closest('tr').cells[7].textContent;assert.equal(freight.value,'10,000');assert.equal(rate(),'1,000');const assumed=doc.querySelector('#containerTable [data-container-field="assumedM3"]');assumed.focus();assumed.value='';assumed.dispatchEvent(new p.w.Event('input',{bubbles:true}));assert.equal(freight.value,'50,000');assert.equal(rate(),'25,000');
});
test('entering container freight previews per-item allocation against assumed m3',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{m3PerCarton:.2,cartonCount:10});Object.assign(p.data.containers[0],{assumed_m3:10,freight:0,freight_mode:'manual'});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();const option=doc.querySelector('[data-column="freightAmount"]');option.checked=true;option.dispatchEvent(new p.w.Event('change',{bubbles:true}));doc.getElementById('modalClose').click();
 const input=doc.querySelector('#containerTable [data-cont-freight]');input.focus();input.value='1,200';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,100));
 assert.equal(doc.querySelector('[data-field="freightAmount"]').textContent,'240');assert.equal(doc.querySelector('#containerTable tbody tr:nth-child(2) td:nth-child(8)').textContent,'120');assert.equal(input.value,'1,200');
});
test('changing actual stacked m3 immediately redistributes manual freight when assumed m3 is empty',async t=>{
 const p=await page(t),doc=p.w.document;Object.assign(p.data.rows[0],{m3PerCarton:.2,cartonCount:10});p.data.rows.push({...p.data.rows[0],id:'2',rowKey:'D00002',productCode:'B'});Object.assign(p.data.containers[0],{assumed_m3:null,freight:1000,freight_mode:'manual'});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();for(const key of ['freightAmount','m3PerCarton']){const option=doc.querySelector('[data-column="'+key+'"]');option.checked=true;option.dispatchEvent(new p.w.Event('change',{bubbles:true}))}doc.getElementById('modalClose').click();
 const amounts=()=>Object.fromEntries([...doc.querySelectorAll('#orderTable tr[data-id]')].map(tr=>[tr.dataset.id,tr.querySelector('[data-field="freightAmount"]').textContent]));assert.deepEqual(amounts(),{2:'500',1:'500'});const input=doc.querySelector('tr[data-id="1"] [data-edit="m3PerCarton"]');input.focus();input.value='0.4';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,100));
 assert.deepEqual(amounts(),{2:'333',1:'667'});
});
test('Đối chiếu overrides are directly editable and sent through the normal versioned row patch',async t=>{
 const p=await page(t),doc=p.w.document;p.data.rows[0].literChina=120;p.data.rows[0].measurementOverrides={literChina:120};p.data.rows.push({...p.data.rows[0],id:'2',rowKey:'D00002',literChina:110,measurementOverrides:{literChina:110}});p.listeners.changed();await tick();await tick();
 doc.getElementById('columns').click();doc.querySelector('[data-column="literChina"]').checked=true;doc.querySelector('[data-column="literChina"]').dispatchEvent(new p.w.Event('change',{bubbles:true}));
 const cells=doc.querySelectorAll('[data-field="literChina"]'),paste=new p.w.Event('paste',{bubbles:true,cancelable:true});cells[0].click();paste.clipboardData={getData:()=> '121\n122'};cells[0].dispatchEvent(paste);assert.equal(p.drafts()['2'].changes.literChina,121);assert.equal(p.drafts()['1'].changes.literChina,122);const keyTarget=doc.querySelector('[data-field="literChina"]'),undo=new p.w.KeyboardEvent('keydown',{key:'z',ctrlKey:true,bubbles:true,cancelable:true});keyTarget.focus();keyTarget.dispatchEvent(undo);assert.equal(p.drafts()['1'],undefined);assert.equal(p.drafts()['2'],undefined);
 const input=doc.querySelector('tr[data-id="1"] [data-edit="literChina"]');assert.ok(input);assert.equal(doc.querySelector('[data-field="status"] input'),null);input.focus();input.value='125';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,260));assert.equal(p.drafts()['1'].changes.literChina,125);
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
test('new row reservation survives add and autosave outside the order values',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch,reservationId='01234567-89ab-4def-8123-456789abcdef';
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/next-key')return {ok:true,json:async()=>({rowKey:'D00042',reservationId,expiresAt:'2026-11-13T12:30:00.000Z'})};if(url==='/api/purchase-orders/plan'&&options.method==='POST'){p.calls.push({url,options});return {ok:true,json:async()=>({})}}return fetch(url,options)};
 doc.getElementById('add').click();const form=doc.getElementById('addForm');
 Object.assign(form.elements.productCode,{value:'NEW'});Object.assign(form.elements.productName,{value:'New item'});Object.assign(form.elements.qtyPerCarton,{value:'2'});Object.assign(form.elements.cartonCount,{value:'3'});
 form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await tick();await new Promise(resolve=>setTimeout(resolve,550));await tick();await tick();
 const call=p.calls.find(c=>c.url==='/api/purchase-orders/plan'&&c.options.method==='POST');assert.ok(call);const body=JSON.parse(call.options.body),create=body.creates[0];
 assert.equal(create.values.rowKey,'D00042');assert.equal(create.reservationId,reservationId);assert.equal(Object.hasOwn(create.values,'reservationId'),false);
});
test('autosave replaces an owned expired reservation and preserves the saved local draft',async t=>{
 const p=await page(t,{local:true}),fetch=p.w.fetch,replacement='12345678-1234-4234-8234-123456789abc';let writes=0;
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/next-key')return {ok:true,json:async()=>({rowKey:'D00003',reservationId:replacement,expiresAt:'2026-11-13T13:00:00.000Z'})};if(url==='/api/purchase-orders/plan'&&options.method==='POST'){const body=JSON.parse(options.body);p.calls.push({url,options,body});if(++writes===1)return {ok:false,status:409,json:async()=>({code:'RESERVATION_EXPIRED',clientId:'new-local',error:'Reservation expired'})};p.data.rows.push({...body.creates[0].values,id:'42',version:1});return {ok:true,json:async()=>({createdRows:[{clientId:'new-local',id:'42',rowKey:'D00003'}]})}}return fetch(url,options)};
 await new Promise(resolve=>setTimeout(resolve,1000));await tick();await tick();
 const plans=p.calls.filter(c=>c.url==='/api/purchase-orders/plan'),retried=plans[1]?.body.creates[0];assert.equal(plans.length,2);assert.equal(retried.reservationId,replacement);assert.equal(retried.values.rowKey,'D00003');assert.equal(retried.values.supplier,'Local');assert.equal(Object.hasOwn(retried.values,'reservationId'),false);assert.equal(p.drafts()['new-local'],undefined);
});
test('autosave recovers a reclaimed reservation reported as ROW_KEY_UNKNOWN',async t=>{
 const p=await page(t,{local:true}),fetch=p.w.fetch,replacement='22345678-1234-4234-8234-123456789abc';let writes=0,reservations=0;
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/next-key'){reservations++;return {ok:true,json:async()=>({rowKey:'D00009',reservationId:replacement,expiresAt:'2026-11-13T13:00:00.000Z'})}}if(url==='/api/purchase-orders/plan'&&options.method==='POST'){const body=JSON.parse(options.body);p.calls.push({url,options,body});if(++writes===1)return {ok:false,status:409,json:async()=>({code:'ROW_KEY_UNKNOWN',error:'Reservation was reclaimed'})};return {ok:true,json:async()=>({createdRows:[{clientId:'new-local',id:'42',rowKey:'D00009'}]})}}return fetch(url,options)};
 await new Promise(resolve=>setTimeout(resolve,1000));await tick();await tick();
 const plans=p.calls.filter(c=>c.url==='/api/purchase-orders/plan'),retried=plans[1]?.body.creates[0];assert.equal(plans.length,2);assert.equal(reservations,1);assert.equal(retried.reservationId,replacement);assert.equal(retried.values.rowKey,'D00009');assert.equal(retried.values.supplier,'Local');assert.equal(p.drafts()['new-local'],undefined);
});
test('autosave replaces every reservation when reclaimed rows share a create batch',async t=>{
 const p=await page(t,{local:true,localCount:2}),fetch=p.w.fetch,replacements=[['D00009','32345678-1234-4234-8234-123456789abc'],['D00010','42345678-1234-4234-8234-123456789abc']];let writes=0,reservations=0;
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/next-key'){const [rowKey,reservationId]=replacements[reservations++];return {ok:true,json:async()=>({rowKey,reservationId,expiresAt:'2026-11-13T13:00:00.000Z'})}}if(url==='/api/purchase-orders/plan'&&options.method==='POST'){const body=JSON.parse(options.body);p.calls.push({url,options,body});if(++writes===1)return {ok:false,status:409,json:async()=>({code:'ROW_KEY_UNKNOWN',error:'Reservations were reclaimed'})};return {ok:true,json:async()=>({createdRows:[{clientId:'new-local',id:'42',rowKey:'D00009'},{clientId:'new-local-2',id:'43',rowKey:'D00010'}]})}}return fetch(url,options)};
 await new Promise(resolve=>setTimeout(resolve,1000));await tick();await tick();
 const plans=p.calls.filter(c=>c.url==='/api/purchase-orders/plan'),retried=plans[1]?.body.creates;assert.equal(plans.length,2);assert.equal(reservations,2);assert.deepEqual(retried.map(create=>[create.clientId,create.values.rowKey,create.reservationId,create.values.supplier]),[['new-local','D00009',replacements[0][1],'Local'],['new-local-2','D00010',replacements[1][1],'Local 2']]);assert.equal(p.drafts()['new-local'],undefined);assert.equal(p.drafts()['new-local-2'],undefined);
});
test('new row reconciliation follows immutable ID when another row reuses its key',async t=>{
 const p=await page(t,{local:true}),doc=p.w.document,fetch=p.w.fetch;let resolveCreate;const writes=[];
 p.w.fetch=async(url,options={})=>{if(url==='/api/purchase-orders/plan'&&options.method==='POST'){const body=JSON.parse(options.body);p.calls.push({url,options,body});writes.push(body);if(writes.length===1)return new Promise(resolve=>{resolveCreate=resolve});return {ok:true,json:async()=>({})}}return fetch(url,options)};
 await new Promise(resolve=>setTimeout(resolve,500));const edit=doc.querySelector('tr[data-id="new-local"] [data-edit="supplier"]');assert.ok(edit);edit.value='Later';edit.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 p.data.rows.push({...p.data.rows[0],id:'42',rowKey:'D00002',version:1,supplier:'Local'},{...p.data.rows[0],id:'99',rowKey:'D00002',version:1,supplier:'Other'});
 resolveCreate({ok:true,json:async()=>({createdRows:[{clientId:'new-local',id:'42',rowKey:'D00002'}],createdKeys:['D00002']})});
 await new Promise(resolve=>setTimeout(resolve,50));await tick();assert.equal(p.drafts()['42']?.changes.supplier,'Later');assert.equal(p.drafts()['99'],undefined);
 await new Promise(resolve=>setTimeout(resolve,600));await tick();await tick();
 assert.ok(writes.some(body=>body.creates?.[0]?.clientId==='new-local'));assert.ok(writes.some(body=>body.rows?.some(row=>String(row.id)==='42')),JSON.stringify(writes));assert.ok(writes.every(body=>!(body.rows||[]).some(row=>String(row.id)==='99')));
});
for(const scope of ['containerTable'])test('freight '+scope+' sends original focus version after SSE and cannot overwrite remote freight',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;
 if(scope==='watchedContainer')doc.querySelector('[data-container-filter="2"]').click();
 const input=doc.querySelector('#'+scope+' [data-cont-freight="2"]');input.focus();input.value='1,000';input.setSelectionRange(1,3);
 p.data.containers[0].version=9;p.data.containers[0].freight=9000;p.data.containers[0].freight_mode='manual';p.listeners.changed();await tick();await tick();
 assert.equal(doc.activeElement.value,'1,000');assert.equal(doc.activeElement.selectionStart,1);
 p.w.fetch=async(url,options={})=>{if(options.method!=='PATCH')return fetch(url,options);p.calls.push({url,options});const body=JSON.parse(options.body),ok=body.version===9;if(ok)p.data.containers[0].freight=body.changes.freight;return {ok,status:ok?200:409,json:async()=>ok?{}:{error:'Freight conflict'}}};
 doc.activeElement.dispatchEvent(new p.w.Event('change',{bubbles:true}));await tick();await tick();const body=JSON.parse(p.calls.find(c=>c.options.method==='PATCH').options.body);
 assert.equal(body.version,3);assert.equal(p.data.containers[0].freight,9000);assert.match(doc.getElementById('notice').textContent,/Freight conflict/);assert.equal(doc.activeElement.value,'1,000');
});
test('container freight cell saves an Excel-style formula instead of discarding its expression',async t=>{
 const p=await page(t),doc=p.w.document,formula='=(195000000+4*500*3930)/170*D2',input=doc.querySelector('#containerTable [data-cont-freight="2"]');
 input.focus();input.value=formula;input.dispatchEvent(new p.w.Event('change',{bubbles:true}));await tick();await tick();
 const call=p.calls.find(c=>c.url.endsWith('/containers/2')&&c.options.method==='PATCH');assert.ok(call);
 assert.deepEqual(JSON.parse(call.options.body),{version:3,changes:{freight:null,freightMode:'formula',freightFormula:formula}});
});
test('freight formula remains visible while editing and returns to the calculated rate on blur',async t=>{
 const p=await page(t),doc=p.w.document,formula='=(195000000+4*500*3920)/170*M3_CONT';p.data.containers[0].freight_formula=formula;p.data.containers[0].freight_mode='formula';p.listeners.changed();await tick();await tick();
 const input=doc.querySelector('#containerTable [data-cont-freight="2"]');assert.notEqual(input.value,formula);input.focus();assert.equal(input.value,formula);input.blur();assert.notEqual(input.value,formula);
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
for(const scope of ['containerTable'])for(const field of ['freight','carrier'])test('real focusout without native change commits restored dirty '+field+' in '+scope+' once using original version',async t=>{
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

test('region list splits waiting container groups and filters both tables',async t=>{
 const p=await page(t),doc=p.w.document;p.data.regions=[{id:'10',name:'V',color:'#0088AA',isActive:true,version:1},{id:'20',name:'H',color:'#AA5500',isActive:true,version:1}];p.data.rows[0].contId=null;p.data.rows[0].regionId='10';p.data.rows.push({...p.data.rows[0],id:'3',rowKey:'D00003',regionId:'20'});p.listeners.changed();await tick();await tick();
 const names=[...doc.querySelectorAll('#containerTable tbody tr td[data-container-filter]')].map(td=>td.textContent);assert.ok(names.some(name=>name.includes('Cont chờ xếp V')));assert.ok(names.some(name=>name.includes('Cont chờ xếp H')));assert.ok(doc.getElementById('orderRegion').options.length>=3);assert.ok(doc.getElementById('contRegion').options.length>=3);
});
test('region manager saves active name and RGB color in one batch',async t=>{
 const p=await page(t),doc=p.w.document;p.data.regions=[];doc.getElementById('managePurchaseRegions').click();await tick();const form=doc.getElementById('purchaseRegionAdd');form.elements.name.value='V';form.elements.color.value='#1188AA';form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));doc.getElementById('savePurchaseRegions').click();await tick();await tick();const call=p.calls.find(c=>c.url.endsWith('/regions/batch'));assert.ok(call);const entry=JSON.parse(call.options.body).entries[0];assert.equal(entry.name,'V');assert.equal(entry.color,'#1188AA');assert.equal(entry.isActive,true);
});
test('container note popup loads existing text and saves edits',async t=>{
 const p=await page(t),doc=p.w.document;p.data.containers[0].note='Ghi chú cũ';p.listeners.changed();await tick();await tick();doc.querySelector('[data-container-note="2"]').click();const form=doc.getElementById('containerNoteForm');assert.equal(form.elements.note.value,'Ghi chú cũ');form.elements.note.value='Ghi chú mới';form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await tick();await tick();const call=p.calls.find(c=>c.url.endsWith('/containers/2')&&c.options.method==='PATCH');assert.equal(JSON.parse(call.options.body).changes.note,'Ghi chú mới');
});
