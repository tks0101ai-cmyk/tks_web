'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const {EventEmitter}=require('node:events');
const {attachRealtime}=require('./purchaseOrdersRealtime');
const dir=path.join(__dirname,'../public/thu-mua/dat-hang');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function page(t,{saved,savedOutbox,sourceMode='web',extraRows=[],employees=[]}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(dir,'index.html'),'utf8'),{url:'https://example.test/thu-mua/dat-hang/',runScripts:'outside-only'}),w=dom.window;
 t.after(()=>w.close());
 let current={sourceMode,permissions:{edit:true,import:true,export:true,depart:true,arrive:true},rows:[{id:'1',rowKey:'D00001',version:1,contId:null,productCode:'AC305',productName:'Băng dính',cartonCount:10,qtyPerCarton:100,supplier:'A'}],containers:[{id:'2',name:'CONT 11-1V',status:2,version:1}]};
 current.rows.push(...extraRows.map(r=>({productName:r.productCode,...r})));const calls=[],listeners={};
 w.PurchaseCalculations=require('../public/shared/purchase-calculations');w.PurchaseFreight=require('../public/shared/purchase-freight');w.PurchaseColumns=require('../public/shared/purchase-columns');w.PurchaseTasks=require('../public/shared/purchase-tasks');w.TKSNav={authGuard:async()=>({id:'buyer'})};
 w.EventSource=class{addEventListener(k,fn){listeners[k]=fn}close(){}};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.fetch=async(url,options={})=>{calls.push({url,options});if(url.endsWith('/employees'))return {ok:true,json:async()=>({rows:employees})};if(url.endsWith('/status')){const input=JSON.parse(options.body),container=current.containers.find(c=>String(c.id)===String(input.containerId));container.status=input.status;container.version++;return {ok:true,json:async()=>structuredClone(container)}}if(url.endsWith('/bulk')){const input=JSON.parse(options.body);return {ok:true,json:async()=>({results:input.rows.map(r=>({id:r.id,status:'updated'}))})}}if(options.method==='PATCH'){const input=JSON.parse(options.body);if(input.before.supplier!==undefined&&current.rows[0].supplier!==input.before.supplier)return {ok:false,status:409,json:async()=>({error:'Ô đã được người khác sửa.'})};current.rows[0]={...current.rows[0],...input.changes,version:current.rows[0].version+1};return {ok:true,json:async()=>current.rows[0]}}return {ok:true,json:async()=>structuredClone(current)}};
 if(saved)w.sessionStorage.setItem('purchase:buyer:v1',JSON.stringify(saved));if(savedOutbox)w.sessionStorage.setItem('purchase:buyer:v1:outbox',JSON.stringify(savedOutbox));
 w.eval(fs.readFileSync(path.join(dir,'purchase.js'),'utf8'));await tick();await tick();
 const change=(selector,v)=>{const el=w.document.querySelector(selector);el.value=v;el.dispatchEvent(new w.Event('change',{bubbles:true}))};
 return {w,calls,listeners,change,get current(){return current}};
}
test('quantity and container drafts recalculate container totals immediately and cancel restores them',async t=>{
 const p=await page(t);Object.assign(p.current.rows[0],{kgPerCarton:100,m3PerCarton:.5});p.listeners.changed();await tick();await tick();
 p.change('[data-edit="cartonCount"]','20');p.change('[data-edit="contId"]','2');
 const target=p.w.document.querySelector('[data-container-filter="2"]').closest('tr');assert.equal(target.cells[3].textContent,'2.00');assert.equal(target.cells[4].textContent,'10.00');assert.match(target.textContent,/Chưa lưu/);assert.equal(p.calls.filter(c=>c.options.method).length,0);
 p.w.document.getElementById('cancel').click();p.w.document.getElementById('discard').click();assert.equal(p.w.document.querySelector('[data-container-filter="2"]').closest('tr').cells[3].textContent,'0.00');assert.equal(p.current.rows[0].cartonCount,10);
});
test('order-row status dropdown updates the parent container and every other row in it',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:'2',productCode:'B',cartonCount:5,qtyPerCarton:10},{id:'4',rowKey:'D00004',version:1,contId:'2',productCode:'C',cartonCount:8,qtyPerCarton:10}]});
 p.change('#orderTable tr[data-id="3"] [data-status="2"]','3');await tick();await tick();
 assert.equal(p.w.document.querySelector('#containerTable [data-status="2"]').value,'3');const peers=[...p.w.document.querySelectorAll('#orderTable [data-status="2"]')];assert.equal(peers.length,2);assert.ok(peers.every(select=>select.value==='3'));assert.equal(p.calls.filter(c=>c.url.endsWith('/status')).length,1);assert.equal(p.current.rows[1].cartonCount,5);assert.equal(p.w.document.getElementById('modal').open,false);
});
test('direct status dropdown sends one authorized status request with no wizard',async t=>{
 const p=await page(t);p.change('[data-status="2"]','4');await tick();await tick();const calls=p.calls.filter(c=>c.url.endsWith('/status'));assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].options.body).status,4);assert.equal(p.w.document.getElementById('modal').open,false);assert.equal(p.w.document.getElementById('ordersPackingSection').hidden,true);assert.equal(p.w.document.getElementById('openOrdersPacking'),null);
});
test('adding an arbitrary product stages it in the chosen container without a write',async t=>{
 const p=await page(t);p.w.document.getElementById('add').click();const form=p.w.document.getElementById('addForm');Object.entries({productCode:'ANY',productName:'Hàng thử',qtyPerCarton:'5',cartonCount:'4',kgPerCarton:'100',m3PerCarton:'0.2',contId:'2'}).forEach(([k,v])=>form.elements[k].value=v);form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await tick();
 const state=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(Object.keys(state.newRows).length,1);assert.equal(p.calls.filter(c=>c.options.method).length,0);const target=p.w.document.querySelector('[data-container-filter="2"]').closest('tr');assert.equal(target.cells[3].textContent,'0.40');assert.equal(target.cells[4].textContent,'0.80');
});
test('numeric cells display comma thousands and accept the same notation without changing magnitude',async t=>{
 const p=await page(t,{extraRows:[{id:'4',rowKey:'D00004',version:1,cartonCount:1234,qtyPerCarton:2000,productCode:'LARGE',contId:null}]});
 const input=p.w.document.querySelector('tr[data-id="4"] [data-edit="cartonCount"]');assert.equal(input.value,'1,234');input.focus();assert.equal(input.value,'1234');input.value='2,345';input.dispatchEvent(new p.w.Event('change',{bubbles:true}));
 assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['4'].changes.cartonCount,2345);
});
test('filter remains private and does not publish writes; ordinary draft needs explicit confirmation',async t=>{
 const {w,calls,change}=await page(t);change('[data-edit="supplier"]','B');
 assert.equal(calls.filter(c=>c.options.method).length,0);
 w.document.getElementById('search').value='AC305';w.document.getElementById('search').dispatchEvent(new w.Event('input'));
 assert.equal(calls.filter(c=>c.options.method).length,0);
 w.document.getElementById('save').click();assert.match(w.document.getElementById('modalBody').textContent,/A → B/);
 w.document.getElementById('commit').click();await tick();await tick();assert.equal(calls.filter(c=>c.options.method==='PATCH').length,1);
 assert.equal(w.document.querySelector('[data-edit="supplier"]').value,'B');
});
test('remote updates preserve draft and private filter; same field conflict remains visible and unsaved',async t=>{
 const p=await page(t);p.change('[data-edit="supplier"]','B');p.w.document.getElementById('search').value='AC305';
 p.current.rows[0].supplier='C';p.current.rows[0].version=2;p.listeners.changed();await tick();await tick();
 assert.equal(p.w.document.querySelector('[data-edit="supplier"]').value,'B');assert.ok(p.w.document.querySelector('.conflict'));
 assert.equal(p.w.document.getElementById('search').value,'AC305');
 p.w.document.getElementById('save').click();p.w.document.getElementById('commit').click();await tick();await tick();
 assert.equal(p.current.rows[0].supplier,'C');assert.ok(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['1']);
});
test('restores own drafts after reload and sheets mode blocks mutation controls',async t=>{
 const saved={drafts:{1:{version:1,before:{supplier:'A'},changes:{supplier:'Draft'}}},filter:'all'};
 const {w}=await page(t,{saved,sourceMode:'sheets'});assert.match(w.document.getElementById('orderTable').textContent,/Draft/);assert.equal(w.document.getElementById('save').disabled,true);assert.equal(w.document.getElementById('add').disabled,true);
});
test('bulk selection includes shipped containers, applies inline edits and sends one audit batch',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:'2',supplier:'A',productCode:'B',cartonCount:5,qtyPerCarton:10}]});
 p.current.containers[0].status=3;p.w.document.getElementById('bulk').click();const pick=p.w.document.getElementById('pickAll');pick.checked=true;pick.dispatchEvent(new p.w.Event('change'));
 p.change('[data-edit="supplier"]','Shared');const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(Object.keys(saved.drafts).length,2);
 p.w.document.getElementById('save').click();p.w.document.getElementById('commit').click();await tick();await tick();
 const batches=p.calls.filter(c=>c.url.endsWith('/bulk'));assert.equal(batches.length,1);assert.equal(JSON.parse(batches[0].options.body).rows.length,2);
});
test('resolving same-cell conflict requires explicit choice and another confirmation',async t=>{
 const p=await page(t);p.change('[data-edit="supplier"]','B');p.current.rows[0].supplier='C';p.current.rows[0].version=2;p.listeners.changed();await tick();await tick();
 p.w.document.getElementById('save').click();p.w.document.getElementById('commit').click();await tick();await tick();
 assert.match(p.w.document.getElementById('modal').textContent,/Đối chiếu/);p.change('[data-resolve]','mine');p.w.document.getElementById('resolve').click();assert.equal(p.current.rows[0].supplier,'C');
 p.w.document.getElementById('save').click();p.w.document.getElementById('commit').click();await tick();await tick();assert.equal(p.current.rows[0].supplier,'B');
});
test('remote refresh while a cell is focused does not silently replace its comparison baseline',async t=>{
 const p=await page(t);const input=p.w.document.querySelector('[data-edit="supplier"]');input.focus();
 p.current.rows[0].supplier='C';p.current.rows[0].version=2;p.listeners.changed();await tick();await tick();
 assert.equal(input.value,'A');input.value='B';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 const draft=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['1'];assert.equal(draft.before.supplier,'A');assert.equal(draft.version,1);
});
test('PostgreSQL DATE objects are normalized for browser date fields',()=>{
 const {jsRow}=require('./purchaseOrdersService');assert.equal(jsRow({id:1,row_key:'D00001',root_key:'D00001',version:1,listed_at:new Date(2026,10,3)}).listedAt,'2026-11-03');
});
test('SSE cleans up subscriptions and presence on disconnect; change carries no row or private filters',()=>{
 const events=new EventEmitter(),routes={};attachRealtime({get:(path,fn)=>routes[path]=fn},'/purchase',events,{touch:async()=>({users:[],version:'0'}),remove:async()=>{}});
 const req=new EventEmitter();req.user={id:'u',username:'Buyer'};const chunks=[];const res={set(){},flushHeaders(){},write:c=>chunks.push(c)};
 routes['/purchase/events'](req,res);assert.equal(events.listenerCount('purchase-orders-changed'),1);assert.match(chunks.join(''),/Buyer/);
 events.emit('purchase-orders-changed',{secret:'must not forward'});assert.match(chunks.join(''),/event: changed/);assert.doesNotMatch(chunks.join(''),/must not forward/);
 req.emit('close');assert.equal(events.listenerCount('purchase-orders-changed'),0);
});

test('manual split starts blank, blocks save and sends employee quantities in one plan',async t=>{
 const p=await page(t),doc=p.w.document;doc.querySelector('[data-row-transfer="1"]').click();const child=doc.querySelector('[data-child-qty="1"]');assert.ok(child);assert.equal(child.value,'');assert.equal(doc.querySelector('tr[data-id="1"] [data-edit="cartonCount"]').value,'10');doc.getElementById('save').click();assert.equal(doc.getElementById('modal').open,false);child.value='4';child.dispatchEvent(new p.w.Event('change',{bubbles:true}));p.change('tr[data-id="1"] [data-edit="cartonCount"]','7');doc.getElementById('save').click();doc.getElementById('commit').click();await tick();await tick();const plan=JSON.parse(p.calls.find(c=>c.url.endsWith('/plan')).options.body);assert.equal(plan.splits[0].quantity,4);assert.equal(plan.splits[0].sourceQty,7);assert.equal(plan.splits[0].manual,true);
});

test('paste is validated before any stage and is undoable as one operation',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:null,productCode:'B',cartonCount:5,qtyPerCarton:10}]});const doc=p.w.document;doc.querySelector('tr[data-id="3"] [data-field="cartonCount"]').click();const paste=text=>{const event=new p.w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=>text}});doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').dispatchEvent(event)};paste('12\ninvalid');assert.equal(doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').value,'5');paste('12\n13');assert.equal(doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').value,'12');doc.getElementById('undoWork').click();await tick();assert.equal(doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').value,'5');assert.equal(p.calls.filter(c=>c.options.method).length,0);
});
test('employee dropdown stores HR id privately and keyboard Enter moves down',async t=>{
 const p=await page(t,{employees:[{id:'7',name:'Nhân viên',department:'Mua',branch:'hanoi'}],extraRows:[{id:'3',rowKey:'D00003',version:1,contId:null,productCode:'B',cartonCount:5,qtyPerCarton:10}]});p.change('tr[data-id="1"] [data-edit="buyerEmployeeId"]','7');const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.ok(saved.drafts['1'],JSON.stringify({saved,select:p.w.document.querySelector('[data-edit="buyerEmployeeId"]').outerHTML,notice:p.w.document.getElementById('notice').textContent}));assert.equal(saved.drafts['1'].changes.buyerEmployeeId,'7');const el=p.w.document.querySelector('tr[data-id="3"] [data-edit="cartonCount"]');el.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.equal(p.w.document.activeElement.closest('tr').dataset.id,'1');
});
test('reorder creates private rows and quick filters do not issue writes',async t=>{
 const p=await page(t);p.w.document.getElementById('bulk').click();p.w.document.querySelector('[data-pick="1"]').click();p.w.document.getElementById('reorderWork').click();await tick();await tick();const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(Object.keys(saved.newRows).length,1);p.change('#quickWork','eta');assert.equal(p.calls.filter(c=>c.options.method).length,0);p.w.document.getElementById('undoWork').click();await tick();assert.equal(Object.keys(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).newRows).length,0);
});

test('offline and failed reconnect preserve personal filters and all staged edits',async t=>{
 const p=await page(t);p.change('tr[data-id="1"] [data-edit="supplier"]','Draft');p.w.document.getElementById('search').value='AC305';p.w.document.getElementById('search').dispatchEvent(new p.w.Event('input'));Object.defineProperty(p.w.navigator,'onLine',{configurable:true,value:false});p.w.dispatchEvent(new p.w.Event('offline'));assert.equal(p.w.document.getElementById('save').disabled,true);p.w.fetch=async()=>{throw Error('Mất mạng')};p.w.dispatchEvent(new p.w.Event('online'));await tick();await tick();assert.equal(p.w.document.getElementById('search').value,'AC305');assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['1'].changes.supplier,'Draft');
});

test('a lost write response retains the request key and retry recovers without dropping other drafts',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,productCode:'B',cartonCount:5,qtyPerCarton:10,contId:null}]}),doc=p.w.document,real=p.w.fetch;let lost=true,firstKey,retryKey,cached;const savedCalls=[];p.w.fetch=async(url,options={})=>{if(options.method==='PATCH'){savedCalls.push(options);if(lost){lost=false;firstKey=options.headers['Idempotency-Key'];cached=await (await real(url,options)).json();throw Error('response lost')}retryKey=options.headers['Idempotency-Key'];return {ok:true,json:async()=>cached}}return real(url,options)};p.change('tr[data-id="1"] [data-edit="supplier"]','Draft');p.change('tr[data-id="3"] [data-edit="supplier"]','Other');doc.getElementById('save').click();doc.getElementById('commit').click();await tick();await tick();assert.ok(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1:outbox')).key);assert.equal(doc.getElementById('retryWrite').hidden,false);assert.ok(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['1']);doc.getElementById('retryWrite').click();await tick();await tick();assert.equal(retryKey,firstKey);assert.equal(p.w.sessionStorage.getItem('purchase:buyer:v1:outbox'),null);assert.equal(doc.getElementById('retryWrite').hidden,true);assert.equal(p.current.rows[0].supplier,'Draft');assert.equal(p.calls.filter(c=>c.options.method==='PATCH').length,1);assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['3'].changes.supplier,'Other');
});

test('watching a container pins its existing metrics without changing private filter',async t=>{
 const p=await page(t),doc=p.w.document;p.change('#filter','all');doc.querySelector('[data-container-filter="2"]').click();assert.equal(doc.getElementById('filter').value,'all');assert.match(doc.getElementById('watchedContainer').textContent,/CONT 11-1V/);const original=doc.querySelector('[data-container-filter="2"]').closest('tr');original.getBoundingClientRect=()=>({top:-100});p.w.dispatchEvent(new p.w.Event('scroll'));assert.equal(doc.getElementById('watchedContainer').hidden,false);doc.getElementById('watchedContainer').querySelector('button').click();assert.equal(doc.getElementById('watchedContainer').hidden,true);
});

test('large list renders one page and does not build hidden packing tables',async t=>{
 const started=Date.now(),extraRows=Array.from({length:5000},(_,i)=>({id:String(i+2),rowKey:'D'+String(i+2).padStart(5,'0'),version:1,contId:null,productCode:'SKU'+i,productName:'Hàng '+i,cartonCount:10,qtyPerCarton:20,kgPerCarton:5,m3PerCarton:.2}));const p=await page(t,{extraRows});assert.equal(p.w.document.querySelectorAll('#orderTable tbody tr').length,50);assert.equal(p.w.document.querySelectorAll('#sourceTable tr').length,0);assert.equal(p.w.document.querySelector('[data-container-filter=""]').closest('tr').cells[2].textContent,'5001');p.w.document.getElementById('search').value='SKU4999';p.w.document.getElementById('search').dispatchEvent(new p.w.Event('input'));assert.equal(p.w.document.querySelectorAll('#orderTable tbody tr').length,1);t.diagnostic('jsdom: 5,001 rows, initial render and filter '+(Date.now()-started)+' ms; not a real-browser benchmark');
});

test('an uncertain write is recoverable after reloading the page',async t=>{
 const first=await page(t);first.change('tr[data-id="1"] [data-edit="supplier"]','Reload');first.w.fetch=async()=>{throw Error('connection reset')};first.w.document.getElementById('save').click();first.w.document.getElementById('commit').click();await tick();await tick();const saved=JSON.parse(first.w.sessionStorage.getItem('purchase:buyer:v1')),savedOutbox=JSON.parse(first.w.sessionStorage.getItem('purchase:buyer:v1:outbox'));const next=await page(t,{saved,savedOutbox});assert.equal(next.w.document.getElementById('retryWrite').hidden,false);next.w.document.getElementById('retryWrite').click();await tick();await tick();const call=next.calls.find(c=>c.options.method==='PATCH');assert.equal(call.options.headers['Idempotency-Key'],savedOutbox.key);assert.equal(next.current.rows[0].supplier,'Reload');
});
test('only product-code double click opens row history on the live page',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;p.w.fetch=async(url,options)=>url.includes('/history?')?{ok:true,json:async()=>({rows:[]})}:fetch(url,options);doc.querySelector('[data-field="supplier"]').dispatchEvent(new p.w.MouseEvent('dblclick',{bubbles:true}));await tick();assert.equal(doc.getElementById('modal').open,false);doc.querySelector('[data-field="productCode"] input').dispatchEvent(new p.w.MouseEvent('dblclick',{bubbles:true}));await tick();assert.equal(doc.getElementById('modal').open,true);assert.match(doc.getElementById('modal').textContent,/D00001/);
});

test('live order headers stay below the watched row and release the offset on unpin',async t=>{
 const p=await page(t),doc=p.w.document;doc.querySelector('[data-container-filter="2"]').click();doc.getElementById('orderTable').getBoundingClientRect=()=>({top:60,bottom:600});doc.querySelector('[data-container-filter="2"]').closest('tr').getBoundingClientRect=()=>({top:-100});doc.getElementById('watchedContainer').getBoundingClientRect=()=>({bottom:180});p.w.dispatchEvent(new p.w.Event('scroll'));assert.equal(doc.getElementById('orderTable').style.getPropertyValue('--purchase-header-offset'),'120px');doc.getElementById('watchedContainer').querySelector('button').click();assert.equal(doc.getElementById('orderTable').style.getPropertyValue('--purchase-header-offset'),'0px');
});

test('container freight formula tracks unsaved order volume immediately',async t=>{
 const p=await page(t);Object.assign(p.current.rows[0],{kgPerCarton:100,m3PerCarton:.5});p.listeners.changed();await tick();await tick();p.change('tr[data-id="1"] [data-edit="contId"]','2');assert.equal(p.w.document.querySelector('[data-cont-freight="2"]').value,'5,941,176');p.change('tr[data-id="1"] [data-edit="cartonCount"]','20');assert.equal(p.w.document.querySelector('[data-cont-freight="2"]').value,'11,882,353');assert.equal(p.calls.filter(c=>c.options.method).length,0);
});

test('pinned freight input uses the same container update endpoint',async t=>{const p=await page(t),doc=p.w.document;doc.querySelector('[data-container-filter="2"]').click();const fetch=p.w.fetch;p.w.fetch=async(url,options)=>{if(url.endsWith('/containers/2')&&options.method==='PATCH'){const body=JSON.parse(options.body);Object.assign(p.current.containers[0],body.changes);p.calls.push({url,options});return {ok:true,json:async()=>p.current.containers[0]}}return fetch(url,options)};p.change('#watchedContainer [data-cont-freight="2"]','12,000,000');await tick();await tick();const call=p.calls.find(c=>c.url.endsWith('/containers/2')&&c.options.method==='PATCH');assert.ok(call);assert.equal(JSON.parse(call.options.body).changes.freight,12000000);assert.equal(doc.querySelector('#watchedContainer [data-cont-freight="2"]').value,'12,000,000');p.change('#watchedContainer [data-cont-freight="2"]','');await tick();await tick();const reset=JSON.parse(p.calls.filter(c=>c.url.endsWith('/containers/2')&&c.options.method==='PATCH').at(-1).options.body).changes;assert.equal(reset.freight,null);assert.equal(reset.freightMode,'formula');assert.equal(reset.freightBase,202000000);assert.equal(reset.freightCapacity,170)});

test('live measurement differences use supplier minus warehouse over warehouse and preserve input precision',async t=>{const p=await page(t),doc=p.w.document;Object.assign(p.current.rows[0],{m3PerCarton:.073,kgPerCarton:13.8,qtyPerCarton:300,literWarehouse:.25,gramWarehouse:40,unitPriceCny:1.23456,freightPrepaid:0,freightPostpaid:0,fxRate:3920});p.listeners.changed();await tick();await tick();assert.equal(doc.querySelector('[data-field="literDiff"]').textContent,'-3%');assert.equal(doc.querySelector('[data-field="gramDiff"]').textContent,'+15%');const input=doc.querySelector('[data-edit="unitPriceCny"]');input.focus();assert.equal(input.value,'1.23456');p.change('[data-edit="cartonCount"]','1,00');assert.equal(doc.querySelector('[data-field="totalQty"]').textContent,'');assert.equal(doc.querySelector('[data-field="netPrice"]').textContent,'')});

test('production workspace filters compose privately and retain their values on refresh',async t=>{const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,productCode:'TARGET',contId:'2',supplier:'X',vatNote:'VAT X',buyer:'An',buyerEmployeeId:'5',listedAt:'2026-11-05T14:30',cartonCount:2,qtyPerCarton:10,kgPerCarton:100,m3PerCarton:.5,unitPriceCny:2,freightPrepaid:0,freightPostpaid:0,fxRate:3920},{id:'4',rowKey:'D00004',version:1,productCode:'OTHER',contId:'2',supplier:'Y',buyer:'Dung',listedAt:'2026-10-01',cartonCount:5,qtyPerCarton:10}]});const doc=p.w.document;p.change('#orderStatus','2');p.change('#orderBuyer','id:5');p.change('#orderSupplier','X');p.change('#orderVat','VAT X');p.change('#orderFrom','2026-11-05');p.change('#orderTo','2026-11-05');assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,1);assert.equal(doc.querySelector('#orderTable tr[data-id]').dataset.id,'3');assert.match(doc.getElementById('purchaseOverview').textContent,/40.000/);p.listeners.changed();await tick();await tick();assert.equal(doc.getElementById('orderBuyer').value,'id:5');const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.orderFilters.orderSupplier,'X');assert.equal(p.calls.filter(c=>c.options.method).length,0);doc.getElementById('clearOrderFilters').click();assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,3)});
test('container filters do not filter orders and readonly mode disables new container creation',async t=>{const p=await page(t,{sourceMode:'sheets'}),doc=p.w.document;assert.equal(doc.getElementById('newCont').disabled,true);assert.equal(doc.getElementById('sourceBanner').hidden,false);doc.getElementById('contSearch').value='11-1V';doc.getElementById('contSearch').dispatchEvent(new p.w.Event('input'));assert.equal(doc.querySelectorAll('#containerTable [data-container-filter]').length,1);assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,1);doc.getElementById('clearContFilters').click();assert.equal(doc.querySelectorAll('#containerTable [data-container-filter]').length,2);assert.equal(p.calls.filter(c=>c.options.method).length,0)});
test('saved filter reload, accent-insensitive search and export use the same selected rows',async t=>{const p=await page(t,{saved:{filter:'all',orderFilters:{orderSupplier:'A'}},extraRows:[{id:'4',rowKey:'D00004',productCode:'B',supplier:'B',version:1,qtyPerCarton:10,cartonCount:2}]});const doc=p.w.document;assert.equal(doc.getElementById('orderSupplier').value,'A');doc.getElementById('search').value='bang dinh';doc.getElementById('search').dispatchEvent(new p.w.Event('input'));assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,1);p.w.URL.createObjectURL=()=>'/test.xlsx';p.w.URL.revokeObjectURL=()=>{};p.w.HTMLAnchorElement.prototype.click=function(){};const prior=p.w.fetch;let exported;p.w.fetch=async(url,options)=>{if(url.endsWith('/export')){exported=JSON.parse(options.body);return {ok:true,blob:async()=>new p.w.Blob(['test'])}}return prior(url,options)};doc.getElementById('export').click();await tick();await tick();assert.deepEqual(exported.ids,['1'])});
test('add dialog prefills the chosen container and resets actual dates from older orders',async t=>{const p=await page(t),doc=p.w.document;doc.querySelector('[data-container-filter="2"]').click();doc.getElementById('add').click();const form=doc.getElementById('addForm');assert.equal(form.elements.contId.value,'2');assert.equal(form.querySelector('.additional-fields').open,false);const prior=p.w.fetch;p.w.fetch=async(url,options)=>url.includes('/latest?')?{ok:true,json:async()=>({row:{rowKey:'D00003',listedAt:'2026-10-01',productName:'Old product',qtyPerCarton:10,cartonCount:4,shippedNote:'2026-10-02',arrivedNote:'2026-10-03'}})}:prior(url,options);form.elements.productCode.value='OLD';form.elements.productCode.dispatchEvent(new p.w.Event('change'));await tick();await tick();assert.equal(form.elements.shippedNote.value,'');assert.equal(form.elements.arrivedNote.value,'');assert.equal(form.elements.productName.value,'Old product')});

test('remote changes never silently remove a personal filter even when its last matching value disappears',async t=>{const p=await page(t),doc=p.w.document;p.change('#orderSupplier','A');p.current.rows[0].supplier='B';p.listeners.changed();await tick();await tick();assert.equal(doc.getElementById('orderSupplier').value,'A');assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,0);assert.match(doc.getElementById('orderTable').textContent,/Không có dòng/);assert.equal(p.calls.filter(c=>c.options.method).length,0)});
