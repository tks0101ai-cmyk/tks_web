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
test('purchase uses the shared application shell and brand instead of a private grid',()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(dir,'index.html'),'utf8'));
 const reference=new JSDOM(fs.readFileSync(path.join(dir,'../../stocktake/index.html'),'utf8'));
 try{
  const doc=dom.window.document,standard=reference.window.document;
  assert.equal(doc.querySelector('.receipt-header .brand').innerHTML,standard.querySelector('.receipt-header .brand').innerHTML);
  assert.ok(doc.querySelector('.shell > .sidebar#sidebar'));
  assert.ok(doc.querySelector('.shell > main.content'));
  assert.equal(doc.querySelector('.layout'),null);
  // The shared navigation inserts this sibling; it must stay in the shared flex shell.
  const handle=doc.createElement('div');handle.className='sidebar-resize-handle';
  doc.getElementById('sidebar').after(handle);
  assert.equal(handle.parentElement,doc.querySelector('main').parentElement);
  assert.ok(doc.querySelector('.receipt-header .status-line #accountChip'));
 }finally{dom.window.close();reference.window.close()}
});
test('purchase workspace omits the redundant order and history tab buttons',()=>{
 const dom=new JSDOM(fs.readFileSync(path.join(dir,'index.html'),'utf8'));
 try{assert.equal(dom.window.document.querySelector('.purchase-tabs'),null);assert.equal(dom.window.document.getElementById('historyToggle'),null)}finally{dom.window.close()}
});
test('inline edits save automatically without opening the draft confirmation',async t=>{
 const p=await page(t);p.change('[data-edit="supplier"]','B');
 await new Promise(resolve=>setTimeout(resolve,1200));await tick();await tick();
 assert.equal(p.current.rows[0].supplier,'B');assert.equal(p.w.document.getElementById('modal').open,false);
 assert.equal(Object.keys(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts).length,0);
});
test('order columns can be selected for pinning and persist in the user layout',async t=>{
 const p=await page(t),doc=p.w.document;assert.ok(doc.getElementById('pinColumns'));
 doc.getElementById('pinColumns').click();assert.match(doc.getElementById('modalTitle').textContent,/Ghim cột/);
 const checkbox=doc.querySelector('[data-pin-column="supplier"]');checkbox.checked=true;checkbox.dispatchEvent(new p.w.Event('change',{bubbles:true}));
 assert.deepEqual(JSON.parse(doc.defaultView.sessionStorage.getItem('purchase:buyer:v1')).pinnedColumns,['productCode','productName','supplier']);
 assert.ok(doc.querySelector('#orderTable th[data-key="supplier"].purchase-pinned-column'));
});
test('Excel import requires a fresh snapshot download before file selection',async t=>{
 const p=await page(t),doc=p.w.document;doc.getElementById('import').click();
 assert.match(doc.getElementById('modalTitle').textContent,/Nhập Excel theo dữ liệu hiện tại/);
 assert.ok(doc.getElementById('downloadSnapshot'));assert.equal(doc.getElementById('importUploadArea').hidden,true);
 assert.equal(doc.querySelector('#modalBody #importFile').disabled,true);
 assert.ok(doc.querySelector('#importDrop .import-drop-icon'));assert.match(doc.querySelector('#importDrop').textContent,/Kéo thả file Excel vào đây/);assert.match(doc.querySelector('#importDrop .import-choose').textContent,/Chọn file/);
 p.w.URL.createObjectURL=()=> 'blob:test';p.w.URL.revokeObjectURL=()=>{};p.w.HTMLAnchorElement.prototype.click=function(){};p.w.fetch=async()=>({ok:true,blob:async()=>new p.w.Blob()});doc.getElementById('downloadSnapshot').click();for(let i=0;i<4;i++)await tick();
 assert.equal(doc.getElementById('importUploadArea').hidden,false);assert.equal(doc.querySelector('#importFile').disabled,false);assert.match(doc.getElementById('importStatus').textContent,/Đã tải snapshot/);
});
test('pagination shows only pages one to three and arrows navigate the rest',async t=>{
 const extraRows=Array.from({length:150},(_,i)=>({id:String(i+2),rowKey:'D'+String(i+2).padStart(5,'0'),version:1,productCode:'P'+i,productName:'Item '+i,cartonCount:1,qtyPerCarton:1}));
 const p=await page(t,{extraRows}),doc=p.w.document,pages=()=>[...doc.querySelectorAll('#pageNumbers [data-page]')].map(button=>Number(button.dataset.page));
 assert.deepEqual(pages(),[1,2,3]);assert.match(doc.getElementById('pageNumbers').textContent,/…/);assert.equal(doc.getElementById('pageLabel').textContent,'Trang 1/4');
 for(const [button,label] of [['next','Trang 2/4'],['next','Trang 3/4'],['next','Trang 4/4'],['previous','Trang 3/4']]){doc.getElementById(button).click();assert.equal(doc.getElementById('pageLabel').textContent,label);assert.deepEqual(pages(),[1,2,3])}
});
async function page(t,{saved,savedOutbox,sourceMode='web',extraRows=[],employees=[],integrationEnabled=true,onEnhance}={}){
 const dom=new JSDOM(fs.readFileSync(path.join(dir,'index.html'),'utf8'),{url:'https://example.test/thu-mua/dat-hang/',runScripts:'outside-only'}),w=dom.window;
 t.after(()=>w.close());
 w.HTMLCanvasElement.prototype.getContext=()=>null;
 let current={sourceMode,integrationEnabled,permissions:{edit:true,import:true,export:true,depart:true,arrive:true},rows:[{id:'1',rowKey:'D00001',version:1,contId:null,productCode:'AC305',productName:'Băng dính',cartonCount:10,qtyPerCarton:100,supplier:'A'}],containers:[{id:'2',name:'CONT 11-1V',status:2,version:1}]};
 current.rows.push(...extraRows.map(r=>({productName:r.productCode,...r})));const calls=[],listeners={};
 w.PurchaseCalculations=require('../public/shared/purchase-calculations');w.PurchaseFreight=require('../public/shared/purchase-freight');w.PurchaseColumns=require('../public/shared/purchase-columns');w.PurchaseTasks=require('../public/shared/purchase-tasks');w.TKSNav={authGuard:async()=>({id:'buyer'})};
 w.PurchaseRealtime=require('../public/shared/purchase-realtime');w.PurchaseDraftHistory=require('../public/shared/purchase-draft-history');w.PurchaseContainerWorkspace=require('../public/shared/purchase-container-workspace');
 w.EventSource=class{addEventListener(k,fn){listeners[k]=fn}close(){}};
 w.HTMLDialogElement.prototype.showModal=function(){this.open=true};w.HTMLDialogElement.prototype.close=function(){this.open=false};
 w.fetch=async(url,options={})=>{if(url.startsWith('/api/me/table-prefs'))return {ok:true,json:async()=>({tables:{}})};calls.push({url,options});if(url.endsWith('/employees/batch')&&options.method==='PUT'){const {entries}=JSON.parse(options.body),next=[];for(const input of entries){let entry;if(input.id==null){entry={...input,id:'employee-'+(employees.length+1),version:1};delete entry.id;entry.id='employee-'+(employees.length+1);employees.push(entry)}else{entry=employees.find(e=>String(e.id)===String(input.id));if(!entry||input.version!==entry.version)return {ok:false,status:409,json:async()=>({error:'Danh sách NV đã đổi.'})};Object.assign(entry,input,{version:entry.version+1})}next.push(structuredClone(entry))}return {ok:true,json:async()=>({rows:next})}}
  if(url.endsWith('/employees')){
  if(options.method==='POST'){const input=JSON.parse(options.body),entry={id:'employee-'+(employees.length+1),name:input.name,version:1,isActive:true};employees.push(entry);return {ok:true,json:async()=>structuredClone(entry)}}
  return {ok:true,json:async()=>({rows:structuredClone(employees)})};
 }
 if(/\/employees\/[^/]+$/.test(url)&&options.method==='PATCH'){
  const input=JSON.parse(options.body),entry=employees.find(e=>String(e.id)===url.split('/').at(-1));
  if(!entry||input.version!==entry.version)return {ok:false,status:409,json:async()=>({error:'Danh sách NV đã đổi.'})};
  Object.assign(entry,input.changes,{version:entry.version+1});return {ok:true,json:async()=>structuredClone(entry)};
 }
 if(/\/containers\/[^/]+$/.test(url)&&options.method==='PATCH'){
  const input=JSON.parse(options.body),container=current.containers.find(c=>String(c.id)===url.split('/').at(-1)),arrival=Object.hasOwn(input.changes,'arrivalNote')||Object.hasOwn(input.changes,'arrivalDate');
  const contained=current.rows.filter(r=>String(r.contId)===String(container?.id)&&!r.deletedAt&&!r.deleted_at);
  const matches=Array.isArray(input.rows)&&input.rows.length===contained.length&&contained.every(r=>input.rows.some(ref=>String(ref.id)===String(r.id)&&ref.version===r.version));
  if(!container||input.version!==container.version||arrival&&!matches)return {ok:false,status:409,json:async()=>({error:'Cont hoặc dòng trong cont đã được người khác sửa.'})};
  const aliases={arrivalNote:'arrival_note',arrivalDate:'arrival_date',truckName:'truck_name',nameCn:'name_cn'};
  for(const [key,value] of Object.entries(input.changes))container[aliases[key]||key]=value;
  container.version++;return {ok:true,json:async()=>structuredClone(container)};
 }
 if(url.endsWith('/plan')&&options.method==='POST'){const plan=JSON.parse(options.body),createdKeys=[];for(const item of plan.rows||[]){const currentRow=current.rows.find(r=>String(r.id)===String(item.id));if(currentRow)Object.assign(currentRow,item.changes,{version:currentRow.version+1})}for(const item of plan.creates||[]){const values=item.values||item;createdKeys.push(values.rowKey);current.rows.push({...values,id:String(100+current.rows.length),version:1})}return {ok:true,json:async()=>({createdKeys,split:[]})}}if(url.endsWith('/status')){const input=JSON.parse(options.body),container=current.containers.find(c=>String(c.id)===String(input.containerId));container.status=input.status;container.version++;return {ok:true,json:async()=>structuredClone(container)}}if(url.endsWith('/bulk')){const input=JSON.parse(options.body);return {ok:true,json:async()=>({results:input.rows.map(r=>({id:r.id,status:'updated'}))})}}if(options.method==='PATCH'){const input=JSON.parse(options.body);if(input.before.supplier!==undefined&&current.rows[0].supplier!==input.before.supplier)return {ok:false,status:409,json:async()=>({error:'Ô đã được người khác sửa.'})};current.rows[0]={...current.rows[0],...input.changes,version:current.rows[0].version+1};return {ok:true,json:async()=>current.rows[0]}}return {ok:true,json:async()=>structuredClone(current)}};
 if(saved)w.sessionStorage.setItem('purchase:buyer:v1',JSON.stringify(saved));if(savedOutbox)w.sessionStorage.setItem('purchase:buyer:v1:outbox',JSON.stringify(savedOutbox));
 w.eval(fs.readFileSync(path.join(dir,'../../shared/table-controls.js'),'utf8'));
 if(onEnhance)w.TKSTables.enhance=onEnhance;
 w.PurchaseGrid=require('../public/shared/purchase-grid');w.PurchaseGridUI=require('../public/shared/purchase-grid-ui');Object.defineProperty(w.document,'hidden',{value:false,configurable:true});const realtimeAPI=w.PurchaseRealtime;w.PurchaseRealtime={...realtimeAPI,createScheduler:options=>realtimeAPI.createScheduler({...options,gapMs:0})};w.eval(fs.readFileSync(path.join(dir,'purchase.js'),'utf8'));await tick();await tick();
 const change=(selector,v)=>{const el=w.document.querySelector(selector);el.value=v;el.dispatchEvent(new w.Event('change',{bubbles:true}))};
 return {w,calls,listeners,change,get current(){return current}};
}
test('quantity and container drafts recalculate container totals immediately and cancel restores them',async t=>{
 const p=await page(t);Object.assign(p.current.rows[0],{kgPerCarton:100,m3PerCarton:.5});p.listeners.changed();await tick();await tick();
 p.change('[data-edit="cartonCount"]','20');p.change('[data-edit="contId"]','2');
 const target=p.w.document.querySelector('[data-container-filter="2"]').closest('tr');assert.equal(target.cells[3].textContent,'2.00');assert.equal(target.cells[4].textContent,'10.00');assert.match(target.textContent,/Chưa lưu/);assert.equal(p.calls.filter(c=>c.options.method).length,0);
 p.w.document.getElementById('cancel').click();p.w.document.getElementById('discard').click();assert.equal(p.w.document.querySelector('[data-container-filter="2"]').closest('tr').cells[3].textContent,'0.00');assert.equal(p.current.rows[0].cartonCount,10);
});
test('order rows show container status but cannot change it; metrics board updates whole container',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:'2',productCode:'B',cartonCount:5,qtyPerCarton:10},{id:'4',rowKey:'D00004',version:1,contId:'2',productCode:'C',cartonCount:8,qtyPerCarton:10}]});
 assert.equal(p.w.document.querySelectorAll('#orderTable tr[data-id="3"] [data-status]').length,0);assert.match(p.w.document.querySelector('#orderTable tr[data-id="3"] [data-field="status"]').textContent,/Chờ bốc/);
 p.change('#containerTable [data-status="2"]','3');await tick();await tick();
 assert.equal(p.w.document.querySelector('#containerTable [data-status="2"]').value,'3');const peers=['3','4'].map(id=>p.w.document.querySelector('#orderTable tr[data-id="'+id+'"] [data-field="status"]'));assert.ok(peers.every(cell=>cell.textContent==='Đã bốc'));assert.equal(p.calls.filter(c=>c.url.endsWith('/status')).length,1);assert.equal(p.current.rows[1].cartonCount,5);assert.equal(p.w.document.getElementById('modal').open,false);
});
test('status is editable from metrics board and sends one authorized request',async t=>{
 const p=await page(t);p.change('#containerTable [data-status="2"]','4');await tick();await tick();const calls=p.calls.filter(c=>c.url.endsWith('/status'));assert.equal(calls.length,1);assert.equal(JSON.parse(calls[0].options.body).status,4);assert.equal(p.w.document.getElementById('modal').open,false);
});
test('adding a new product saves it immediately with a reserved row key',async t=>{
 const p=await page(t);const prior=p.w.fetch;p.w.fetch=async(url,options={})=>{if(url.endsWith('/next-key'))return {ok:true,json:async()=>({rowKey:'D00042'})};if(url.endsWith('/plan')&&options.method==='POST'){p.calls.push({url,options});const plan=JSON.parse(options.body);for(const [i,create] of plan.creates.entries())p.current.rows.push({...create.values,id:String(42+i),version:1});return {ok:true,json:async()=>({createdKeys:plan.creates.map(create=>create.values.rowKey)})}}return prior(url,options)};
 p.w.document.getElementById('add').click();const form=p.w.document.getElementById('addForm');Object.entries({productCode:'ANY',productName:'Hàng thử',qtyPerCarton:'5',cartonCount:'4',kgPerCarton:'100',m3PerCarton:'0.2'}).forEach(([k,v])=>form.elements[k].value=v);form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,1200));await tick();await tick();
 const request=p.calls.find(c=>c.url.endsWith('/plan')),state=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.ok(request,p.w.document.getElementById('notice').textContent+JSON.stringify(state));const plan=JSON.parse(request.options.body);assert.equal(plan.creates[0].values.rowKey,'D00042');assert.equal(Object.hasOwn(plan.creates[0].values,'id'),false);assert.equal(Object.hasOwn(plan.creates[0].values,'version'),false);assert.equal(p.current.rows.at(-1).productCode,'ANY');assert.equal(Object.keys(state.drafts).length,0);assert.equal(Object.keys(state.newRows).length,0);assert.equal(p.w.document.getElementById('modal').open,false);
});
test('adding from an existing product code saves the cloned values immediately',async t=>{
 const p=await page(t),prior=p.w.fetch;p.w.fetch=async(url,options={})=>{if(url.endsWith('/next-key'))return {ok:true,json:async()=>({rowKey:'D00042'})};if(url.includes('/latest?code='))return {ok:true,json:async()=>({row:structuredClone(p.current.rows[0])})};if(url.endsWith('/plan')&&options.method==='POST'){p.calls.push({url,options});const plan=JSON.parse(options.body);for(const [i,create] of plan.creates.entries())p.current.rows.push({...create.values,id:String(42+i),version:1});return {ok:true,json:async()=>({createdKeys:plan.creates.map(create=>create.values.rowKey)})}}return prior(url,options)};
 p.w.document.getElementById('add').click();const form=p.w.document.getElementById('addForm');form.elements.productCode.value='AC305';form.elements.productCode.dispatchEvent(new p.w.Event('input',{bubbles:true}));await tick();await tick();assert.equal(form.elements.productName.value,'Băng dính');assert.equal(form.elements.cartonCount.value,'10');
 form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));await new Promise(resolve=>setTimeout(resolve,1200));await tick();await tick();const plan=JSON.parse(p.calls.find(c=>c.url.endsWith('/plan')).options.body),saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(plan.creates[0].values.productCode,'AC305');assert.equal(Object.hasOwn(plan.creates[0].values,'id'),false);assert.equal(Object.hasOwn(plan.creates[0].values,'version'),false);assert.equal(p.current.rows.length,2);assert.equal(Object.keys(saved.drafts).length,0);
});test('numeric cells display comma thousands and accept the same notation without changing magnitude',async t=>{
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
 const live=p.w.document.querySelector('[data-edit="supplier"]');assert.equal(p.w.document.activeElement,live);assert.equal(live.value,'A');live.value='B';live.dispatchEvent(new p.w.Event('input',{bubbles:true}));
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

// Tach bat dau bang mot nhan vao Ma SP roi xac nhan cont dich trong hop thoai; khong con nut Tach tren dong.
async function splitRow(p,id,destination){
 const doc=p.w.document,label=doc.querySelector('tr[data-id="'+id+'"] [data-field="productCode"] .code-label');
 label.dispatchEvent(new p.w.MouseEvent('click',{bubbles:true}));
 await new Promise(resolve=>setTimeout(resolve,300));
 if(destination!==undefined)doc.getElementById('splitTo').value=destination;
 doc.getElementById('splitConfirm').click();await tick();
}

test('manual split starts blank, blocks save and sends employee quantities in one plan',async t=>{
 const p=await page(t),doc=p.w.document;await splitRow(p,'1');const child=doc.querySelector('[data-child-qty="1"]');assert.ok(child);assert.equal(child.value,'');assert.equal(doc.querySelector('tr[data-id="1"] [data-edit="cartonCount"]').value,'10');doc.getElementById('save').click();assert.equal(doc.getElementById('modal').open,false);child.value='4';child.dispatchEvent(new p.w.Event('change',{bubbles:true}));p.change('tr[data-id="1"] [data-edit="cartonCount"]','7');doc.getElementById('save').click();doc.getElementById('commit').click();await tick();await tick();const plan=JSON.parse(p.calls.find(c=>c.url.endsWith('/plan')).options.body);assert.equal(plan.splits[0].quantity,4);assert.equal(plan.splits[0].sourceQty,7);assert.equal(plan.splits[0].manual,true);
});

test('paste is validated before any stage and is undoable as one operation',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:null,productCode:'B',cartonCount:5,qtyPerCarton:10}]});const doc=p.w.document;doc.querySelector('tr[data-id="3"] [data-field="cartonCount"]').click();const paste=text=>{const event=new p.w.Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=>text}});doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').dispatchEvent(event)};paste('12\ninvalid');assert.equal(doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').value,'5');paste('12\n13');assert.equal(doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').value,'12');doc.getElementById('undoWork').click();await tick();assert.equal(doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').value,'5');assert.equal(p.calls.filter(c=>c.options.method).length,0);
});
test('buyer selects configured NV privately and keyboard Enter moves down',async t=>{
 const p=await page(t,{employees:[{id:'7',name:'Nhân viên',department:'Mua',branch:'hanoi'}],extraRows:[{id:'3',rowKey:'D00003',version:1,contId:null,productCode:'B',cartonCount:5,qtyPerCarton:10}]});p.change('tr[data-id="1"] [data-edit="buyer"]','Nhân viên');const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.ok(saved.drafts['1'],JSON.stringify({saved,select:p.w.document.querySelector('[data-edit="buyer"]').outerHTML,notice:p.w.document.getElementById('notice').textContent}));assert.equal(saved.drafts['1'].changes.buyer,'Nhân viên');const buyer=p.w.document.querySelector('tr[data-id="1"] [data-edit="buyer"]');assert.equal(buyer.tagName,'SELECT');assert.deepEqual([...buyer.options].map(o=>o.value),['','Nhân viên']);const el=p.w.document.querySelector('tr[data-id="3"] [data-edit="cartonCount"]');el.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));assert.equal(p.w.document.activeElement.closest('tr').dataset.id,'1');
});
test('reorder creates private rows and quick filters do not issue writes',async t=>{
 const p=await page(t);p.w.document.getElementById('bulk').click();p.w.document.querySelector('[data-pick="1"]').click();p.w.document.getElementById('reorderWork').click();await tick();await tick();const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(Object.keys(saved.newRows).length,1);assert.equal(Object.values(saved.newRows)[0].contId,null);p.change('#quickWork','eta');assert.equal(p.calls.filter(c=>c.options.method).length,0);p.w.document.getElementById('undoWork').click();await tick();assert.equal(Object.keys(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).newRows).length,0);
});

test('typing digits is one undo unit while focused and revisiting starts a new edit',async t=>{
 const p=await page(t),doc=p.w.document;
 const input=()=>doc.querySelector('tr[data-id="1"] [data-edit="cartonCount"]');
 const type=values=>{input().focus();for(const value of values){input().value=value;input().dispatchEvent(new p.w.Event('input',{bubbles:true}))}};
 type(['1','12','123']);doc.getElementById('undoWork').click();await tick();
 assert.equal(input().value,'10','one undo restores the value before typing');
 type(['2','24']);input().dispatchEvent(new p.w.Event('change',{bubbles:true}));
 type(['3','36']);doc.getElementById('undoWork').click();await tick();assert.equal(input().value,'24');
 doc.getElementById('undoWork').click();await tick();assert.equal(input().value,'10');
 assert.equal(p.calls.filter(c=>c.options.method).length,0,'draft undo never writes to the backend');
});

test('reorder of an assigned row always stages waiting even while its container is pinned',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,productCode:'ASSIGNED',contId:'2',cartonCount:2,qtyPerCarton:10}]}),doc=p.w.document;
 const prior=p.w.fetch;p.w.fetch=async(url,options)=>url.includes('/latest?')?{ok:true,json:async()=>({row:p.current.rows[1]})}:prior(url,options);
 doc.querySelector('[data-container-filter="2"]').click();doc.getElementById('bulk').click();doc.querySelector('[data-pick="3"]').click();doc.getElementById('reorderWork').click();await tick();await tick();
 const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')),created=Object.values(saved.newRows);
 assert.equal(created.length,1);assert.equal(created[0].contId,null);assert.equal(created[0].productCode,'ASSIGNED');
 assert.equal(p.calls.filter(c=>c.options.method).length,0);
});

test('offline and failed reconnect preserve personal filters and all staged edits',async t=>{
 const p=await page(t);p.change('tr[data-id="1"] [data-edit="supplier"]','Draft');p.w.document.getElementById('search').value='AC305';p.w.document.getElementById('search').dispatchEvent(new p.w.Event('input'));Object.defineProperty(p.w.navigator,'onLine',{configurable:true,value:false});p.w.dispatchEvent(new p.w.Event('offline'));assert.equal(p.w.document.getElementById('save').disabled,true);p.w.fetch=async()=>{throw Error('Mất mạng')};p.w.dispatchEvent(new p.w.Event('online'));await tick();await tick();assert.equal(p.w.document.getElementById('search').value,'AC305');assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['1'].changes.supplier,'Draft');
});

test('a lost write response retains the request key and retry recovers without dropping other drafts',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,productCode:'B',cartonCount:5,qtyPerCarton:10,contId:null}]}),doc=p.w.document,real=p.w.fetch;let lost=true,firstKey,retryKey,cached;const savedCalls=[];p.w.fetch=async(url,options={})=>{if(options.method==='PATCH'){savedCalls.push(options);if(lost){lost=false;firstKey=options.headers['Idempotency-Key'];cached=await (await real(url,options)).json();throw Error('response lost')}retryKey=options.headers['Idempotency-Key'];return {ok:true,json:async()=>cached}}return real(url,options)};p.change('tr[data-id="1"] [data-edit="supplier"]','Draft');p.change('tr[data-id="3"] [data-edit="supplier"]','Other');doc.getElementById('save').click();doc.getElementById('commit').click();await tick();await tick();assert.ok(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1:outbox')).key);assert.equal(doc.getElementById('retryWrite').hidden,false);assert.ok(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['1']);doc.getElementById('retryWrite').click();await tick();await tick();assert.equal(retryKey,firstKey);assert.equal(p.w.sessionStorage.getItem('purchase:buyer:v1:outbox'),null);assert.equal(doc.getElementById('retryWrite').hidden,true);assert.equal(p.current.rows[0].supplier,'Draft');assert.equal(p.calls.filter(c=>c.options.method==='PATCH').length,1);assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['3'].changes.supplier,'Other');
});

test('watching a container pins its existing metrics without changing private filter',async t=>{
 const p=await page(t),doc=p.w.document;p.change('#filter','all');doc.querySelector('[data-container-filter="2"]').click();assert.equal(doc.getElementById('filter').value,'all');assert.match(doc.getElementById('watchedContainer').textContent,/11-1V/);const original=doc.querySelector('[data-container-filter="2"]').closest('tr');original.getBoundingClientRect=()=>({top:-100});p.w.dispatchEvent(new p.w.Event('scroll'));assert.equal(doc.getElementById('watchedContainer').hidden,false);doc.getElementById('watchedContainer').querySelector('button').click();assert.equal(doc.getElementById('watchedContainer').hidden,true);
});

test('status board toggles waiting and saved-container filters together without writes',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:'2',productCode:'IN-CONT',cartonCount:2,qtyPerCarton:10}]}),doc=p.w.document;
 const button=status=>doc.querySelector('#containerStatusBoard [data-container-status="'+status+'"]');
 const ids=()=>[...doc.querySelectorAll('#orderTable tr[data-id]')].map(tr=>tr.dataset.id);
 p.change('#filter','2');button('waiting').querySelector('strong').click();
 assert.equal(doc.getElementById('filter').value,'all');assert.equal(doc.getElementById('orderStatus').value,'0');assert.equal(doc.getElementById('contStatus').value,'0');
 assert.equal(button('waiting').getAttribute('aria-pressed'),'true');assert.deepEqual(ids(),['1']);
 assert.equal(doc.querySelector('#containerTable [data-container-filter="2"]'),null);
 button('waiting').click();assert.equal(doc.getElementById('orderStatus').value,'');assert.equal(doc.getElementById('contStatus').value,'');assert.equal(ids().length,2);
 button('2').click();assert.deepEqual(ids(),['3']);assert.equal(doc.getElementById('contStatus').value,'2');assert.equal(button('2').getAttribute('aria-pressed'),'true');
 p.listeners.changed();await tick();await tick();assert.deepEqual(ids(),['3']);assert.equal(button('2').getAttribute('aria-pressed'),'true');
 button('2').click();assert.equal(ids().length,2);assert.equal(doc.querySelectorAll('#containerStatusBoard [aria-pressed="true"]').length,0);
 assert.equal(p.calls.filter(c=>c.options.method).length,0);
});

test('pin is under private filters in the orders DOM, remains singular on refresh and unpins locally',async t=>{
 const p=await page(t),doc=p.w.document,watched=doc.getElementById('watchedContainer'),filters=doc.querySelector('.order-filters');
 assert.equal(watched.parentElement,doc.getElementById('orders'));assert.equal(filters.nextElementSibling,watched);assert.equal(watched.hidden,true);
 p.change('#search','AC305');doc.querySelector('#containerTable [data-container-filter="2"]').click();
 assert.equal(watched.hidden,false);assert.equal(filters.nextElementSibling,watched);assert.equal(doc.getElementById('search').value,'AC305');
 assert.equal(watched.querySelectorAll('tbody tr').length,1);assert.equal(watched.querySelectorAll('[id]').length,0);
 assert.equal(watched.querySelectorAll('thead th').length,6,'five data columns and the unpin control stay compact');
 assert.equal(watched.querySelector('.watched-caption'),null);assert.equal(watched.querySelector('.watched-actions'),null);assert.equal(watched.querySelector('thead button').textContent,'Bỏ ghim');assert.equal(watched.querySelector('thead button').closest('th'),watched.querySelector('thead th:last-child'));assert.doesNotMatch(watched.textContent,/Đang theo dõi/);
 p.listeners.changed();await tick();await tick();assert.equal(doc.querySelectorAll('#watchedContainer').length,1);assert.equal(watched.hidden,false);
 watched.querySelector('thead button').click();assert.equal(watched.hidden,true);assert.equal(doc.getElementById('search').value,'AC305');
 assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).taskTarget,null);assert.equal(p.calls.filter(c=>c.options.method).length,0);
});

test('NV manager stages RGB, status and new entries then saves the whole directory once',async t=>{
 const p=await page(t,{employees:[{id:'7',name:'An',color:'#2563EB',version:4,isActive:true}]}),doc=p.w.document;
 const names=()=>[...doc.querySelector('tr[data-id="1"] [data-edit="buyer"]').options].map(o=>o.value),writes=()=>p.calls.filter(c=>c.options.method);
 doc.getElementById('managePurchaseEmployees').click();await tick();await tick();
 const form=doc.getElementById('purchaseEmployeeAdd');form.elements.name.value='Bình';form.elements.color.value='#EA580C';form.dispatchEvent(new p.w.Event('submit',{bubbles:true,cancelable:true}));
 assert.equal(writes().length,0,'adding a row stages it locally');assert.ok(doc.querySelector('[data-directory-id^="new:"]'));
 const tr=doc.querySelector('[data-directory-id="7"]');tr.querySelector('[data-directory-name]').value='An mới';tr.querySelector('[data-directory-color]').value='#123456';tr.querySelector('[data-directory-active]').value='false';
 doc.getElementById('savePurchaseEmployees').click();await tick();await tick();
 assert.equal(writes().length,1);assert.equal(writes()[0].options.method,'PUT');assert.match(writes()[0].url,/\/employees\/batch$/);
 const body=JSON.parse(writes()[0].options.body);assert.equal(body.entries.length,2);assert.deepEqual(body.entries.find(e=>e.id==='7'),{id:'7',version:4,name:'An mới',color:'#123456',isActive:false});assert.equal(body.entries.find(e=>e.id===null).name,'Bình');assert.ok(names().includes('Bình'));assert.equal(names().includes('An'),false);
 assert.equal(p.current.rows[0].buyer,undefined,'directory changes do not save order drafts');
});

test('measurement colors include exact plus/minus ten percent as good and only larger magnitudes as bad',async t=>{
 const cases=[['minus10',.09,9,'measure-good','-10%'],['plus10',.11,11,'measure-good','+10%'],['minusBeyond',.089,8.9,'measure-bad','-11%'],['plusBeyond',.111,11.1,'measure-bad','+11%'],['minusWithin',.095,9.5,'measure-good','-5%'],['zero',.1,10,'measure-good','0%']];
 const columns=require('../public/shared/purchase-columns');
 const p=await page(t,{saved:{columnLayout:6,visible:columns.map(c=>c.k)},extraRows:cases.map(([id,m3,kg],i)=>({id:String(i+10),rowKey:id,version:1,productCode:id,contId:null,cartonCount:1,qtyPerCarton:100,m3PerCarton:m3,kgPerCarton:kg,literWarehouse:1,gramWarehouse:100}))}),doc=p.w.document;
 cases.forEach(([id,m3,kg,expected,text],i)=>{for(const field of ['literDiff','gramDiff']){
  const cell=doc.querySelector('tr[data-id="'+(i+10)+'"] [data-field="'+field+'"]');
   const percent=Number(text.replace('%','')),shown=(percent>0?'+':'')+percent.toFixed(1)+'%';assert.equal(cell.querySelector('input')?.value??cell.textContent,shown,id+' '+field);assert.equal(cell.classList.contains(expected),true,id+' '+field+' '+expected);
  assert.equal(cell.classList.contains(expected==='measure-good'?'measure-bad':'measure-good'),false,id+' must have only one measurement class');
 }});
 assert.equal(p.calls.filter(c=>c.options.method).length,0);
});

test('large list renders one page and does not build hidden packing tables',async t=>{
 const started=Date.now(),extraRows=Array.from({length:5000},(_,i)=>({id:String(i+2),rowKey:'D'+String(i+2).padStart(5,'0'),version:1,contId:null,productCode:'SKU'+i,productName:'Hàng '+i,cartonCount:10,qtyPerCarton:20,kgPerCarton:5,m3PerCarton:.2}));const p=await page(t,{extraRows});assert.equal(p.w.document.querySelectorAll('#orderTable tbody tr').length,50);assert.equal(p.w.document.querySelectorAll('#sourceTable tr').length,0);assert.equal(p.w.document.querySelector('[data-container-filter=""]').closest('tr').cells[2].textContent,'5001');p.w.document.getElementById('search').value='SKU4999';p.w.document.getElementById('search').dispatchEvent(new p.w.Event('input'));assert.equal(p.w.document.querySelectorAll('#orderTable tbody tr').length,1);t.diagnostic('jsdom: 5,001 rows, initial render and filter '+(Date.now()-started)+' ms; not a real-browser benchmark');
});

test('an uncertain write is recoverable after reloading the page',async t=>{
 const first=await page(t);first.change('tr[data-id="1"] [data-edit="supplier"]','Reload');first.w.fetch=async()=>{throw Error('connection reset')};first.w.document.getElementById('save').click();first.w.document.getElementById('commit').click();await tick();await tick();const saved=JSON.parse(first.w.sessionStorage.getItem('purchase:buyer:v1')),savedOutbox=JSON.parse(first.w.sessionStorage.getItem('purchase:buyer:v1:outbox'));const next=await page(t,{saved,savedOutbox});assert.equal(next.w.document.getElementById('retryWrite').hidden,false);next.w.document.getElementById('retryWrite').click();await tick();await tick();const call=next.calls.find(c=>c.options.method==='PATCH');assert.equal(call.options.headers['Idempotency-Key'],savedOutbox.key);assert.equal(next.current.rows[0].supplier,'Reload');
});
test('product code cell splits on one click, opens history on two and edits only on F2',async t=>{
 const p=await page(t),doc=p.w.document,fetch=p.w.fetch;
 p.w.fetch=async(url,options)=>url.includes('/history?')?{ok:true,json:async()=>({rows:[]})}:fetch(url,options);
 const settle=()=>new Promise(resolve=>setTimeout(resolve,300));
 const cell=()=>doc.querySelector('[data-field="productCode"]');
 const bodyRows=()=>doc.querySelectorAll('#orderTable tbody tr[data-id]').length;
 const click=t=>cell().querySelector(t).dispatchEvent(new p.w.MouseEvent('click',{bubbles:true}));
 // Ma SP khong con la o nhap thuong truc: cho mot nhan va hai nhan dung vao cho khac nhau.
 assert.ok(cell().querySelector('.code-label'));
 assert.equal(cell().querySelector('input'),null);
 const before=bodyRows();
 doc.querySelector('[data-field="supplier"]').dispatchEvent(new p.w.MouseEvent('dblclick',{bubbles:true}));
 await tick();assert.equal(doc.getElementById('modal').open,false);
 // Trinh duyet ban click truoc dblclick: lich su phai mo ma khong duoc de lai dong tach nao.
 click('.code-label');cell().querySelector('.code-label').dispatchEvent(new p.w.MouseEvent('dblclick',{bubbles:true}));
 await tick();
 assert.equal(doc.getElementById('modal').open,true);
 assert.match(doc.getElementById('modal').textContent,/D00001/);
 await settle();
 assert.equal(bodyRows(),before,'hai nhan khong duoc tach dong');
 doc.getElementById('modalClose').click();
 // Nut but chi va F2 moi mo o sua, va khong duoc tach dong.
 click('[data-code-edit]');await tick();
 assert.equal(cell().querySelector('input[data-edit="productCode"]').value,'AC305');
 cell().querySelector('input').dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await tick();assert.equal(cell().querySelector('input'),null);
 cell().querySelector('.code-label').dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'F2',bubbles:true}));
 await tick();assert.equal(cell().querySelector('input[data-edit="productCode"]').value,'AC305');
 cell().querySelector('input').dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
 await tick();
 assert.equal(bodyRows(),before,'mo o sua khong duoc tach dong');
 // Mot nhan don chi MO hop xac nhan; chua duoc tach gi truoc khi nguoi dung dong y.
 assert.equal(doc.querySelector('[data-row-transfer]'),null,'khong con nut Tach tren dong');
 click('.code-label');await settle();
 assert.equal(doc.getElementById('modal').open,true);
 assert.ok(doc.getElementById('splitTo'),'hop thoai phai cho chon cont dich');
 assert.equal(bodyRows(),before,'mo hop thoai chua duoc tach');
 // Huy thi khong tach.
 doc.getElementById('splitCancel').click();await tick();
 assert.equal(bodyRows(),before);
 // Xac nhan moi tach, va mac con di theo cont da chon.
 click('.code-label');await settle();
 doc.getElementById('splitTo').value='2';
 doc.getElementById('splitConfirm').click();await tick();
 assert.equal(bodyRows(),before+1);
 assert.equal(doc.querySelector('#orderTable input[data-child-qty]').value,'');
 assert.equal(doc.querySelector('#orderTable select[data-child-cont]').value,'2');
});

test('live order headers stay below the watched row and release the offset on unpin',async t=>{
 const p=await page(t),doc=p.w.document;doc.querySelector('[data-container-filter="2"]').click();doc.getElementById('orderTable').getBoundingClientRect=()=>({top:60,bottom:600});doc.querySelector('[data-container-filter="2"]').closest('tr').getBoundingClientRect=()=>({top:-100});doc.getElementById('watchedContainer').getBoundingClientRect=()=>({bottom:180});p.w.dispatchEvent(new p.w.Event('scroll'));assert.equal(doc.getElementById('orderTable').style.getPropertyValue('--purchase-header-offset'),'120px');doc.getElementById('watchedContainer').querySelector('button').click();assert.equal(doc.getElementById('orderTable').style.getPropertyValue('--purchase-header-offset'),'0px');
});

test('container freight formula tracks unsaved order volume immediately',async t=>{
 const p=await page(t);Object.assign(p.current.rows[0],{kgPerCarton:100,m3PerCarton:.5});p.listeners.changed();await tick();await tick();p.change('tr[data-id="1"] [data-edit="contId"]','2');assert.equal(p.w.document.querySelector('[data-cont-freight="2"]').value,'5,941,176');p.change('tr[data-id="1"] [data-edit="cartonCount"]','20');assert.equal(p.w.document.querySelector('[data-cont-freight="2"]').value,'11,882,353');assert.equal(p.calls.filter(c=>c.options.method).length,0);
});

test('pinned freight input uses the same container update endpoint',async t=>{const p=await page(t),doc=p.w.document;doc.querySelector('[data-container-filter="2"]').click();const fetch=p.w.fetch;p.w.fetch=async(url,options)=>{if(url.endsWith('/containers/2')&&options.method==='PATCH'){const body=JSON.parse(options.body);Object.assign(p.current.containers[0],body.changes);p.calls.push({url,options});return {ok:true,json:async()=>p.current.containers[0]}}return fetch(url,options)};p.change('#watchedContainer [data-cont-freight="2"]','12,000,000');await tick();await tick();const call=p.calls.find(c=>c.url.endsWith('/containers/2')&&c.options.method==='PATCH');assert.ok(call);assert.equal(JSON.parse(call.options.body).changes.freight,12000000);assert.equal(doc.querySelector('#watchedContainer [data-cont-freight="2"]').value,'12,000,000');p.change('#watchedContainer [data-cont-freight="2"]','');await tick();await tick();const reset=JSON.parse(p.calls.filter(c=>c.url.endsWith('/containers/2')&&c.options.method==='PATCH').at(-1).options.body).changes;assert.equal(reset.freight,null);assert.equal(reset.freightMode,'formula');assert.equal(reset.freightBase,202000000);assert.equal(reset.freightCapacity,170)});

test('live measurement differences round to percentages until focused and preserve full precision while editing',async t=>{const p=await page(t),doc=p.w.document;doc.getElementById('columns').click();doc.getElementById('showSourceColumns').click();doc.getElementById('modalClose').click();Object.assign(p.current.rows[0],{m3PerCarton:.073,kgPerCarton:13.8,qtyPerCarton:300,literWarehouse:.25,m3Warehouse:.3,gramWarehouse:40,unitPriceCny:1.23456,freightPrepaid:0,freightPostpaid:0,fxRate:3920});p.listeners.changed();await tick();await tick();const diff=doc.querySelector('[data-edit="literDiff"]');assert.equal(diff.value,'-2.7%');diff.focus();assert.ok(Math.abs(Number(diff.value)+2.66666666666667)<1e-12);diff.blur();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(diff.value,'-2.7%');assert.equal(doc.querySelector('[data-edit="m3Warehouse"]').value,'0.300');assert.equal(doc.querySelector('[data-edit="gramDiff"]').value,'+15.0%');const input=doc.querySelector('[data-edit="unitPriceCny"]');input.focus();assert.equal(input.value,'1.23456');p.change('[data-edit="cartonCount"]','1,00');assert.equal(doc.querySelector('[data-field="totalQty"]').textContent,'');assert.equal(doc.querySelector('[data-field="netPrice"]').textContent,'')});
test('purchase CNY display toggles exact total in the cell and resets on blur',async t=>{const p=await page(t),doc=p.w.document;Object.assign(p.current.rows[0],{qtyPerCarton:1,cartonCount:1,unitPriceCny:3.1,freightPrepaid:0,fxRate:1});p.listeners.changed();await tick();await tick();assert.equal(doc.querySelector('[data-edit="unitPriceCny"]').value,'3.10');const price=doc.querySelector('[data-edit="unitPriceCny"]');price.focus();assert.equal(price.value,'3.1');price.blur();await new Promise(resolve=>setTimeout(resolve,5));assert.equal(price.value,'3.10');let total=doc.querySelector('[data-cny-detail]');assert.equal(total.tagName,'BUTTON');assert.equal(total.textContent,'3');assert.equal(total.getAttribute('aria-pressed'),'false');total.focus();total.click();assert.equal(total.textContent,'3.100');assert.equal(total.getAttribute('aria-pressed'),'true');assert.equal(doc.getElementById('modal').open,false);total.blur();assert.equal(total.textContent,'3');assert.equal(total.getAttribute('aria-pressed'),'false');p.change('[data-edit="unitPriceCny"]','4.2');assert.equal(doc.querySelector('[data-edit="unitPriceCny"]').value,'4.20');total=doc.querySelector('[data-cny-detail]');total.focus();total.click();assert.equal(total.textContent,'4.200');total.blur();assert.equal(total.textContent,'4');assert.equal(doc.querySelector('[data-edit="unitPriceCny"]').value,'4.20')});

test('production workspace filters compose privately and retain their values on refresh',async t=>{const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,productCode:'TARGET',contId:'2',supplier:'X',vatNote:'VAT X',buyer:'An',buyerEmployeeId:'5',listedAt:'2026-11-05T14:30',cartonCount:2,qtyPerCarton:10,kgPerCarton:100,m3PerCarton:.5,unitPriceCny:2,freightPrepaid:0,freightPostpaid:0,fxRate:3920},{id:'4',rowKey:'D00004',version:1,productCode:'OTHER',contId:'2',supplier:'Y',buyer:'Dung',listedAt:'2026-10-01',cartonCount:5,qtyPerCarton:10}]});const doc=p.w.document;p.change('#orderStatus','2');p.change('#orderBuyer','id:5');p.change('#orderSupplier','X');assert.equal(doc.getElementById('orderVat'),null,'the production workspace has no VAT filter');p.change('#orderFrom','2026-11-05');p.change('#orderTo','2026-11-05');assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,1);assert.equal(doc.querySelector('#orderTable tr[data-id]').dataset.id,'3');assert.equal(doc.getElementById('purchaseOverview'),null);assert.ok(doc.getElementById('containerStatusBoard'));const status=doc.querySelector('#containerStatusBoard [data-container-status="2"]');assert.equal(status.getAttribute('aria-pressed'),'true');assert.equal(status.textContent,'Chưa bốc 1');assert.equal(status.querySelector('[data-status-count]').textContent,'1');assert.equal(status.querySelector('[data-status-metric]'),null);p.listeners.changed();await tick();await tick();assert.equal(doc.getElementById('orderBuyer').value,'id:5');const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.orderFilters.orderSupplier,'X');assert.equal(p.calls.filter(c=>c.options.method).length,0);doc.getElementById('clearOrderFilters').click();assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,3)});
test('container filters do not filter orders and readonly mode disables new container creation',async t=>{const p=await page(t,{sourceMode:'sheets'}),doc=p.w.document;assert.equal(doc.getElementById('newCont').disabled,true);assert.equal(doc.getElementById('sourceBanner').hidden,false);doc.getElementById('contSearch').value='11-1V';doc.getElementById('contSearch').dispatchEvent(new p.w.Event('input'));assert.equal(doc.querySelectorAll('#containerTable [data-container-filter]').length,1);assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,1);doc.getElementById('clearContFilters').click();assert.equal(doc.querySelectorAll('#containerTable [data-container-filter]').length,2);assert.equal(p.calls.filter(c=>c.options.method).length,0)});
test('saved filter reload, accent-insensitive search and export use the same selected rows',async t=>{const p=await page(t,{saved:{filter:'all',orderFilters:{orderSupplier:'A'}},extraRows:[{id:'4',rowKey:'D00004',productCode:'B',supplier:'B',version:1,qtyPerCarton:10,cartonCount:2}]});const doc=p.w.document;assert.equal(doc.getElementById('orderSupplier').value,'A');doc.getElementById('search').value='bang dinh';doc.getElementById('search').dispatchEvent(new p.w.Event('input'));assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,1);p.w.URL.createObjectURL=()=>'/test.xlsx';p.w.URL.revokeObjectURL=()=>{};p.w.HTMLAnchorElement.prototype.click=function(){};const prior=p.w.fetch;let exported;p.w.fetch=async(url,options)=>{if(url.endsWith('/export')){exported=JSON.parse(options.body);return {ok:true,blob:async()=>new p.w.Blob(['test'])}}return prior(url,options)};doc.getElementById('export').click();await tick();await tick();assert.deepEqual(exported.ids,['1'])});
test('add dialog lists each known code once and fills the rest as soon as one is picked',async t=>{
 const p=await page(t,{extraRows:[
  {id:'3',rowKey:'D00003',version:1,contId:null,productCode:'AC305',productName:'Băng dính bản mới',supplier:'NCC A',listedAt:'2026-10-01'},
  {id:'4',rowKey:'D00004',version:1,contId:null,productCode:'TH810',productName:'Thùng nhựa',supplier:'NCC B'}]});
 const doc=p.w.document;doc.getElementById('add').click();
 const form=doc.getElementById('addForm');
 assert.equal(form.elements.productCode.getAttribute('list'),'codeSuggest');
 const options=[...doc.querySelectorAll('#codeSuggest option')];
 // AC305 co hai dong nhung chi duoc goi y mot lan, va lay ban Len list gan nhat.
 assert.deepEqual(options.map(o=>o.value),['AC305','TH810']);
 assert.match(options[0].getAttribute('label'),/Băng dính bản mới · NCC A/);
 const prior=p.w.fetch;
 p.w.fetch=async(url,o)=>url.includes('/latest?')?{ok:true,json:async()=>({row:{rowKey:'D00004',productName:'Thùng nhựa',supplier:'NCC B',qtyPerCarton:6,unitPriceCny:12}})}:prior(url,o);
 // Chon mot goi y chi ban su kien input; khong duoc bat nguoi dung roi o moi tu dien.
 form.elements.productCode.value='TH810';
 form.elements.productCode.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 await tick();await tick();
 assert.equal(form.elements.productName.value,'Thùng nhựa');
 assert.equal(form.elements.qtyPerCarton.value,'6');
});

test('add dialog has no container choice even when pinned and resets actual dates from older orders',async t=>{const p=await page(t),doc=p.w.document;doc.querySelector('[data-container-filter="2"]').click();doc.getElementById('add').click();const form=doc.getElementById('addForm');assert.equal(form.elements.contId,undefined);assert.equal(form.querySelector('.additional-fields').open,false);const prior=p.w.fetch;p.w.fetch=async(url,options)=>url.includes('/latest?')?{ok:true,json:async()=>({row:{rowKey:'D00003',listedAt:'2026-10-01',productName:'Old product',qtyPerCarton:10,cartonCount:4,shippedNote:'2026-10-02',arrivedNote:'2026-10-03'}})}:prior(url,options);form.elements.productCode.value='OLD';form.elements.productCode.dispatchEvent(new p.w.Event('change'));await tick();await tick();assert.equal(form.elements.shippedNote.value,'');assert.equal(form.elements.arrivedNote.value,'');assert.equal(form.elements.productName.value,'Old product')});

test('remote changes never silently remove a personal filter even when its last matching value disappears',async t=>{const p=await page(t),doc=p.w.document;p.change('#orderSupplier','A');p.current.rows[0].supplier='B';p.listeners.changed();await tick();await tick();assert.equal(doc.getElementById('orderSupplier').value,'A');assert.equal(doc.querySelectorAll('#orderTable tr[data-id]').length,0);assert.match(doc.getElementById('orderTable').textContent,/Không có dòng/);assert.equal(p.calls.filter(c=>c.options.method).length,0)});
test('narrow-screen navigation opens and closes the sidebar drawer',async t=>{
 const p=await page(t),doc=p.w.document,menu=doc.getElementById('menuBtn'),side=doc.getElementById('sidebar'),back=doc.getElementById('backdrop');
 assert.equal(menu.getAttribute('aria-controls'),'sidebar');
 assert.equal(side.classList.contains('open'),false);assert.equal(back.classList.contains('show'),false);assert.equal(menu.getAttribute('aria-expanded'),'false');
 menu.click();assert.equal(side.classList.contains('open'),true);assert.equal(back.classList.contains('show'),true);assert.equal(menu.getAttribute('aria-expanded'),'true');
 back.click();assert.equal(side.classList.contains('open'),false);assert.equal(back.classList.contains('show'),false);assert.equal(menu.getAttribute('aria-expanded'),'false');
 menu.click();doc.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(side.classList.contains('open'),false,'Esc dong drawer');
 menu.click();side.innerHTML='<a href="/thu-mua/dat-hang/">Thu mua</a>';side.querySelector('a').click();
 assert.equal(side.classList.contains('open'),false,'chon mot muc dieu huong thi drawer tu dong');
 assert.equal(back.classList.contains('show'),false);
});

test('compact columns declare stable keys, small numeric widths and keep row keys visible',async t=>{
 const p=await page(t),doc=p.w.document,table=doc.querySelector('#orderTable table');
 assert.equal(table.dataset.tableFit,'off');assert.equal(table.dataset.minColumnWidth,'24');
 assert.ok(table.querySelector('th[data-column-key="rowKey"]'));
 assert.ok(Number(table.querySelector('th[data-column-key="cartonCount"]').dataset.defaultWidth)<64);
 assert.equal(table.querySelector('.resize'),null);
 doc.getElementById('columns').click();doc.getElementById('showSourceColumns').click();
 const names=[...doc.querySelectorAll('#orderTable th')].filter(th=>th.querySelector('.sort-label').textContent==='Tên SP');
 assert.equal(names.length,1);assert.equal(names[0].dataset.columnKey,'productName');
 assert.ok([...doc.querySelectorAll('#containerTable th')].every(th=>Number(th.dataset.defaultWidth)>0));
});

// Che do dung thu da duoc go (06/11/2026). Thay vao do, bang bao phai noi ro
// dang ghi cach ly hay da noi vao he thong, va moi request van di duong that.
test('the banner states the isolated write mode and every request uses the real API',async t=>{
 const p=await page(t,{integrationEnabled:false}),doc=p.w.document;
 assert.ok(p.calls.every(call=>call.url.startsWith('/api/purchase-orders')),'khong con duong /api/purchase-trial');
 const banner=doc.getElementById('sourceBanner');
 assert.equal(banner.hidden,false);
 assert.match(banner.textContent,/CÁCH LY/);
 assert.match(banner.textContent,/Dự kiến hàng về/);
 assert.ok(banner.classList.contains('isolated-banner'));
 assert.equal(doc.getElementById('add').disabled,false,'cach ly van ghi that nen cac nut mo');
 assert.equal(doc.getElementById('purchaseTrialLink'),null,'khong con link Dung thu');
 p.change('[data-edit="cartonCount"]','8');
 assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['1'].changes.cartonCount,8,'ban nhap dung mot pham vi duy nhat');
});

test('the banner disappears once Purchase is wired into the shared system',async t=>{
 const doc=(await page(t,{integrationEnabled:true})).w.document;
 assert.equal(doc.getElementById('sourceBanner').hidden,true);
});

test('with the Sheet source the banner says writing is off and never mentions a sample mode',async t=>{
 const banner=(await page(t,{sourceMode:'sheets'})).w.document.getElementById('sourceBanner');
 assert.equal(banner.hidden,false);
 assert.match(banner.textContent,/Google Sheet/);
 assert.doesNotMatch(banner.textContent,/DÙNG THỬ|dữ liệu mẫu/i);
});

// Nguồn là metadata nội bộ: không có bộ lọc/cột riêng, nhưng vẫn được tìm qua ô Tìm kiếm.
test('source metadata remains searchable without exposing a source filter or column',async t=>{
 const p=await page(t,{extraRows:[
   {id:'10',rowKey:'D00010',version:1,contId:null,productCode:'YW-1',cartonCount:1,qtyPerCarton:1,sourceSheet:'YIWU'},
   {id:'11',rowKey:'D00011',version:1,contId:null,productCode:'YW-2',cartonCount:1,qtyPerCarton:1,sourceSheet:'YIWU'},
   {id:'12',rowKey:'D00012',version:1,contId:null,productCode:'TK-1',cartonCount:1,qtyPerCarton:1,sourceSheet:'CONT TKS1'}
 ]}),doc=p.w.document;
 const keys=()=>[...doc.querySelectorAll('#orderTable tbody tr td[data-field="rowKey"]')].map(td=>td.textContent.trim()).sort();
 assert.equal(doc.getElementById('orderSource'),null,'nguon khong co bo loc rieng');
 assert.equal(doc.querySelector('#orderTable [data-field="sourceSheet"]'),null,'nguon khong hien thanh cot');
 const search=doc.getElementById('search');search.value='CONT TKS1';search.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 assert.deepEqual(keys(),['D00012'],'ten nguon duoc tim qua o tim kiem');
 search.value='';search.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 assert.deepEqual(keys(),['D00001','D00010','D00011','D00012']);
 assert.equal(p.calls.filter(c=>c.options.method).length,0,'chi loc, khong gui lenh ghi');
});

// Sort cua table-controls doi cho dong trong DOM nen chi xep 50 dong dang hien; o day phai xep
// toan bo dong da loc roi moi cat trang, nen dong nho nhat o trang cuoi phai nhay len dau.
test('nut sap xep o tieu de xep toan bo dong da loc truoc khi cat trang va xoay vong ba trang thai',async t=>{
 const extraRows=Array.from({length:60},(_,i)=>({id:String(i+2),rowKey:'D'+String(i+2).padStart(5,'0'),version:1,contId:null,productCode:'SKU'+i,cartonCount:(i*7)%60+2,qtyPerCarton:10}));
 const p=await page(t,{extraRows}),doc=p.w.document;
 const head=()=>doc.querySelector('#orderTable th[data-key="cartonCount"]');
 const first=()=>doc.querySelector('#orderTable tbody tr td[data-field="cartonCount"] input').value;
 const glyph=()=>head().querySelector('.sort-indicator').textContent;
 assert.equal(doc.querySelectorAll('#orderTable tbody tr').length,50,'van phan trang 50 dong');
 assert.equal(head().getAttribute('aria-sort'),'none');assert.equal(glyph(),'▲▼');
 assert.equal(first(),'55','mac dinh xep theo id giam dan');

 head().querySelector('.sort-button').click();
 assert.equal(head().getAttribute('aria-sort'),'ascending');assert.equal(glyph(),'▲1');
 assert.equal(first(),'2','tang dan: so nho nhat o trang cuoi theo thu tu goc phai len dau trang 1');
 assert.equal(doc.querySelectorAll('#orderTable th[aria-sort="ascending"]').length,1,'chi mot cot duoc sap xep');
 assert.deepEqual(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).colSort,[{key:'cartonCount',dir:'asc'}]);

 head().querySelector('.sort-button').click();
 assert.equal(head().getAttribute('aria-sort'),'descending');assert.equal(glyph(),'▼1');
 assert.equal(first(),'61');

 head().querySelector('.sort-button').click();
 assert.equal(head().getAttribute('aria-sort'),'none');assert.equal(first(),'55','nhan lan ba thi tra lai thu tu goc');
 assert.deepEqual(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).colSort,[]);

 // Chon lai o Sap xep thi bo sap xep theo cot, khong de hai thu tu tranh nhau.
 head().querySelector('.sort-button').click();
 assert.equal(head().getAttribute('aria-sort'),'ascending');
 p.change('#sort','code');
 assert.equal(head().getAttribute('aria-sort'),'none');
 assert.equal(p.calls.filter(c=>c.options.method).length,0,'sap xep la viec cua may tram, khong goi may chu');
});

test('sap xep theo cot giu nguyen trang thai sau khi tai lai va giu mã da tach o dau bang',async t=>{
 const p=await page(t,{saved:{colSort:{k:'productCode',dir:'desc'}},extraRows:[
  {id:'3',rowKey:'D00003',version:1,contId:null,productCode:'AAA',cartonCount:9,qtyPerCarton:10},
  {id:'4',rowKey:'D00004',version:1,contId:null,productCode:'ZZZ',cartonCount:9,qtyPerCarton:10}
 ]}),doc=p.w.document;
 const codes=()=>[...doc.querySelectorAll('#orderTable tbody tr td[data-field="productCode"]')].map(td=>td.textContent.trim().replace('✎',''));
 assert.equal(doc.querySelector('#orderTable th[data-key="productCode"]').getAttribute('aria-sort'),'descending');
 assert.deepEqual(codes(),['ZZZ','AC305','AAA']);

 // Tach dong: hai nhanh .01 / .02 phai dung canh nhau o dau bang du dang sap xep theo cot.
 const keys=()=>[...doc.querySelectorAll('#orderTable tbody tr td[data-field="rowKey"]')].map(td=>td.textContent.trim());
 doc.querySelector('#orderTable tr[data-id="3"] td[data-field="productCode"] .code-label').dispatchEvent(new p.w.MouseEvent('click',{bubbles:true}));
 await new Promise(resolve=>setTimeout(resolve,300)); // mot nhan phai doi qua cua so cho nhan thu hai
 doc.getElementById('splitConfirm').click();
 assert.deepEqual(keys(),['D00003.01','D00003.02','D00004','D00001']);

 // Khoa khong hop le trong bo nho phien thi bo qua, khong lam trang do.
 const broken=await page(t,{saved:{colSort:{k:'khong-co-cot-nay',dir:'asc'}}});
 assert.equal(broken.w.document.querySelectorAll('#orderTable th[aria-sort="none"]').length,broken.w.document.querySelectorAll('#orderTable th.sortable').length);
});

test('mười hai cot cong thuc mang mau rieng, VC truoc am to chu do va nhan rowKey la Mã dòng',async t=>{
 const columns=require('../public/shared/purchase-columns');
 const p=await page(t,{saved:{columnLayout:3,visible:columns.map(c=>c.k)},extraRows:[
  {id:'3',rowKey:'D00003',version:1,contId:null,productCode:'NEG',cartonCount:2,qtyPerCarton:10,unitPriceCny:5,freightPrepaid:-1101,fxRate:3920}
 ]}),doc=p.w.document;
 const derived=columns.filter(c=>c.d).map(c=>c.k);
 assert.equal(derived.length,12);
 for(const k of derived)assert.ok(doc.querySelector('#orderTable td[data-field="'+k+'"].calc'),k+' phai co lop mau cot cong thuc');
 const coloured=[...doc.querySelectorAll('#orderTable tbody tr:first-child td.calc')].map(td=>td.dataset.field);
 assert.deepEqual(coloured.slice().sort(),derived.slice().sort(),'chi 12 cot cong thuc duoc to mau');
 assert.ok(doc.querySelector('#orderTable th[data-key="netPrice"].calc'),'tieu de cot cong thuc cung mang lop mau');

 const negative=doc.querySelector('#orderTable tr[data-id="3"] td[data-field="freightPrepaid"]');
 assert.ok(negative.classList.contains('negative'),'VC truoc am duoc danh dau');
 assert.equal(negative.querySelector('input').value,'-1,101');
 assert.equal(doc.querySelector('#orderTable tr[data-id="1"] td[data-field="freightPrepaid"]').classList.contains('negative'),false,'o trong khong to do');

 assert.equal(doc.querySelector('#orderTable th[data-key="rowKey"] .sort-label').textContent,'Mã dòng');
 assert.ok(doc.querySelector('#orderTable td[data-field="cartonCount"]').classList.contains('num'),'cot so mang lop num de can phai');
});
test('negative freight CSS colors cell and input text red without a red background',()=>{
 const dom=new JSDOM('<!doctype html><head></head><body></body>');
 try{
  const doc=dom.window.document,html=fs.readFileSync(path.join(dir,'index.html'),'utf8');
  const page=new JSDOM(html);
  try{
   for(const link of page.window.document.querySelectorAll('link[rel="stylesheet"]')){
    const href=link.getAttribute('href').split('?')[0];if(/^https?:/.test(href))continue;
    const file=href.startsWith('/')?path.join(dir,'../..',href):path.join(dir,href);
    const style=doc.createElement('style');style.textContent=fs.readFileSync(file,'utf8');doc.head.append(style);
   }
  }finally{page.window.close()}
  const negativeRules=[...doc.styleSheets].flatMap(sheet=>[...sheet.cssRules]).filter(rule=>rule.selectorText?.includes('td.negative'));
  for(const selector of ['td.negative','td.negative input']){
   const rules=negativeRules.filter(rule=>rule.selectorText.split(',').some(part=>part.trim().endsWith(selector)));
   assert.ok(rules.some(rule=>rule.style.getPropertyValue('color').trim()==='var(--red)'),selector+' must use red text');
  }
  for(const rule of negativeRules){
   assert.equal(rule.style.getPropertyValue('background'),'','negative cells must not add a background');
   assert.equal(rule.style.getPropertyValue('background-color'),'','negative cells must not add a background color');
  }
 }finally{dom.window.close()}
});

test('arithmetic, dd/mm, payment and configured NV stage and save real values',async t=>{
 const p=await page(t,{saved:{columnLayout:4,visible:require('../public/shared/purchase-columns').map(c=>c.k)},employees:[{name:'Tên đã nhập'}],extraRows:[{id:'8',rowKey:'D00008',productCode:'B',cartonCount:1,qtyPerCarton:10,m3PerCarton:.011,literWarehouse:1,kgPerCarton:.008,gramWarehouse:1,listedAt:'2025-01-01',contId:'2'}]}),doc=p.w.document;
 const input=doc.querySelector('tr[data-id="1"] [data-edit="m3PerCarton"]');
 input.value='(10 * 20 * 30) / 1000000';input.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 assert.equal(input.parentElement.querySelector('output').textContent,'= 0.006');
 input.dispatchEvent(new p.w.Event('change',{bubbles:true}));
 assert.equal(doc.querySelector('tr[data-id="1"] [data-edit="m3PerCarton"]').value,'0.006');
 doc.querySelector('tr[data-id="8"] .date-label').click();
 const date=doc.querySelector('tr[data-id="8"] [data-edit="listedAt"]');assert.equal(date.type,'text');
 p.change('tr[data-id="8"] [data-edit="listedAt"]','25/12');
 p.change('tr[data-id="1"] [data-edit="buyer"]','Tên đã nhập');
 p.change('tr[data-id="1"] [data-edit="paymentNote"]','Chờ tt');
 const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));
 assert.equal(saved.drafts['1'].changes.m3PerCarton,.006);
 assert.equal(saved.drafts['8'].changes.listedAt,'2025-12-25');
 assert.equal(saved.drafts['1'].changes.buyer,'Tên đã nhập');
 assert.equal(saved.drafts['1'].changes.paymentNote,'Chờ tt');
 assert.equal(doc.querySelector('tr[data-id="1"] [data-edit="buyer"]').tagName,'SELECT');assert.deepEqual([...doc.querySelector('tr[data-id="1"] [data-edit="buyer"]').options].map(o=>o.value),['','Tên đã nhập']);
 assert.equal(doc.querySelector('tr[data-id="8"] [data-edit="contId"] option:checked').textContent,'11-1V');
 assert.ok(doc.querySelector('tr[data-id="8"] [data-field="literDiff"]').classList.contains('measure-good'));
 assert.ok(doc.querySelector('tr[data-id="8"] [data-field="gramDiff"]').classList.contains('measure-bad'));
 doc.getElementById('save').click();doc.getElementById('commit').click();await tick();await tick();
 const write=p.calls.find(c=>c.options.method==='PATCH'&&c.url.endsWith('/1'));
 assert.equal(JSON.parse(write.options.body).changes.buyer,'Tên đã nhập');
 assert.equal(JSON.parse(write.options.body).changes.m3PerCarton,.006);
});
test('grid arrows move through inputs, computed and readonly cells without saving; F2 edits text',async t=>{
 const p=await page(t,{saved:{columnLayout:5,visible:['rowKey','productCode','productName','container','status','qtyPerCarton','cartonCount','totalQty','unitPriceCny']},extraRows:[{id:'3',rowKey:'D00003',version:1,productCode:'B',cartonCount:2,qtyPerCarton:10,contId:'2'}]}),doc=p.w.document;
 const key=k=>doc.activeElement.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:k,bubbles:true,cancelable:true}));
 doc.querySelector('tr[data-id="3"] [data-edit="cartonCount"]').focus();
 key('ArrowRight');assert.equal(doc.activeElement.dataset.field,'totalQty');
 key('ArrowRight');assert.equal(doc.activeElement.dataset.edit,'unitPriceCny');
 key('ArrowLeft');key('ArrowLeft');assert.equal(doc.activeElement.dataset.edit,'cartonCount');
 doc.activeElement.value='12';doc.activeElement.dispatchEvent(new p.w.Event('input',{bubbles:true}));
 key('ArrowUp');assert.equal(doc.activeElement.closest('tr').dataset.id,'1');assert.equal(doc.activeElement.dataset.edit,'cartonCount');
 assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['3'].changes.cartonCount,12);
 doc.querySelector('tr[data-id="3"] [data-edit="contId"]').focus();key('ArrowRight');
 assert.equal(doc.activeElement.dataset.field,'status');key('ArrowUp');assert.equal(doc.activeElement.dataset.field,'status');
 const text=doc.querySelector('tr[data-id="3"] [data-edit="productName"]');text.focus();key('F2');
 assert.equal(text.dataset.gridEditing,'true');key('ArrowLeft');assert.equal(doc.activeElement,text);
 key('Escape');key('ArrowLeft');assert.equal(doc.activeElement.className,'code-label');
 key('ArrowLeft');assert.equal(doc.activeElement.dataset.field,'rowKey');
 assert.equal(p.calls.filter(c=>c.options.method).length,0);
 assert.equal(doc.getElementById('orders').dataset.motion,'off');
});

test('grid arrow navigation crosses page boundaries in the same column',async t=>{
 const p=await page(t,{extraRows:Array.from({length:51},(_,i)=>({id:String(i+2),rowKey:'D'+String(i+2).padStart(5,'0'),version:1,productCode:'P'+i,cartonCount:1,qtyPerCarton:1}))}),doc=p.w.document;
 const last=[...doc.querySelectorAll('#orderTable tbody tr[data-id]')].at(-1),id=last.dataset.id;
 last.querySelector('[data-edit="cartonCount"]').focus();
 doc.activeElement.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
 assert.equal(doc.getElementById('pageLabel').textContent,'Trang 2/2');assert.equal(doc.activeElement.dataset.edit,'cartonCount');
 doc.activeElement.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));
 assert.equal(doc.getElementById('pageLabel').textContent,'Trang 1/2');assert.equal(doc.activeElement.closest('tr').dataset.id,id);
});
test('initial order layout uses restored filters before table widths are cached',async t=>{
 const layouts=[];
 const p=await page(t,{saved:{filter:'all',columnLayout:6},onEnhance:table=>{if(table.closest('#orderTable'))layouts.push({rows:table.tBodies[0].rows.length,mode:table.dataset.tableSelectWidth})}});
 assert.equal(layouts[0].rows,1,'first enhancement must contain real rows, not an empty placeholder');
 assert.equal(layouts[0].mode,'selected');
 const td=p.w.document.querySelector('#orderTable td[data-field="productCode"]');assert.ok(td.querySelector('.code-cell > .code-label'));
 p.change('#filter','');p.listeners.changed();await tick();await tick();
 assert.equal(p.w.document.getElementById('filter').value,'','saved filter is consumed once, not restored over new choices');
});


test('purchase Shift sorting keeps three priorities and renumbers after removing the middle',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',productCode:'ABC',supplier:'A',cartonCount:5},{id:'4',rowKey:'D00004',productCode:'ABC',supplier:'A',cartonCount:9}]}),doc=p.w.document;
 const click=(key,shiftKey=false)=>doc.querySelector('#orderTable th[data-key="'+key+'"] .sort-button').dispatchEvent(new p.w.MouseEvent('click',{bubbles:true,shiftKey}));
 click('supplier');click('productCode',true);click('cartonCount',true);click('cartonCount',true);
 assert.equal(doc.querySelector('th[data-key="cartonCount"] .sort-indicator').textContent,'▼3');
 assert.deepEqual([...doc.querySelectorAll('#orderTable tbody tr')].map(tr=>tr.dataset.id),['4','3','1']);
 click('productCode',true);click('productCode',true);
 assert.equal(doc.querySelector('th[data-key="cartonCount"] .sort-indicator').textContent,'▼2');
 assert.deepEqual(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).colSort,[{key:'supplier',dir:'asc'},{key:'cartonCount',dir:'desc'}]);
});

test('container metrics use shared multi-sort while the waiting group stays pinned',async t=>{
 const p=await page(t),doc=p.w.document;
 const table=doc.querySelector('#containerTable table');
 assert.equal(table.dataset.tableSort,'local');
 const buttons=table.querySelectorAll('thead .sort-button');
 assert.equal(buttons.length,15);
 buttons[0].click();buttons[3].dispatchEvent(new p.w.MouseEvent('click',{bubbles:true,shiftKey:true}));
 assert.equal(buttons[0].querySelector('.sort-indicator').textContent,'▲1');
 assert.equal(buttons[3].querySelector('.sort-indicator').textContent,'▲2');
 assert.equal(table.tBodies[0].rows[0].hasAttribute('data-sort-fixed'),true);
 assert.ok(table.tBodies[0].rows[0].querySelector('[data-container-filter=""]'));
});


test('range scalar paste is one private undo unit and keyed paste uses rowKey even for duplicate product codes',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:null,productCode:'AC305',supplier:'Other',cartonCount:2,qtyPerCarton:10}]}),doc=p.w.document;
 const a=doc.querySelector('tr[data-id="3"] [data-field="supplier"]'),b=doc.querySelector('tr[data-id="1"] [data-field="supplier"]');a.dispatchEvent(new p.w.MouseEvent('click',{bubbles:true}));b.dispatchEvent(new p.w.MouseEvent('click',{bubbles:true,shiftKey:true}));assert.equal(doc.querySelectorAll('.purchase-cell-selected').length,2);
 const paste=new p.w.Event('paste',{bubbles:true,cancelable:true});paste.clipboardData={getData:()=> 'Shared'};b.dispatchEvent(paste);
 let saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.drafts['1'].changes.supplier,'Shared');assert.equal(saved.drafts['3'].changes.supplier,'Shared');assert.equal(p.calls.filter(c=>c.options.method).length,0);doc.getElementById('undoWork').click();assert.equal(doc.querySelector('tr[data-id="1"] [data-edit="supplier"]').value,'A');assert.equal(doc.querySelector('tr[data-id="3"] [data-edit="supplier"]').value,'Other');
 const target=doc.querySelector('tr[data-id="1"] [data-field="supplier"]');target.click();const keyed=new p.w.Event('paste',{bubbles:true,cancelable:true});keyed.clipboardData={getData:()=> 'D00003\tOnly row three'};target.dispatchEvent(keyed);saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.drafts['3'].changes.supplier,'Only row three');assert.equal(saved.drafts['1'],undefined);
});
test('range paste validates every target before changing any draft and supports quoted multiline text',async t=>{
 const p=await page(t),doc=p.w.document;const target=doc.querySelector('[data-field="cartonCount"]');target.click();const bad=new p.w.Event('paste',{bubbles:true,cancelable:true});bad.clipboardData={getData:()=> '20\twrong calculated column'};target.dispatchEvent(bad);assert.match(doc.getElementById('notice').textContent,/Chưa dán/);assert.equal(doc.querySelector('[data-edit="cartonCount"]').value,'10');
 const supplier=doc.querySelector('[data-field="supplier"]');supplier.click();const quoted=new p.w.Event('paste',{bubbles:true,cancelable:true});quoted.clipboardData={getData:()=> '"Supplier\ncontinued"'};supplier.dispatchEvent(quoted);assert.equal(JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1')).drafts['1'].changes.supplier,'Supplier\ncontinued');assert.equal(p.calls.filter(c=>c.options.method).length,0);
});

test('Ctrl+D reads current typed draft rather than stale rendered row and remains a private undo step',async t=>{
 const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:null,productCode:'B',cartonCount:2,qtyPerCarton:10,unitPriceCny:3}]}),doc=p.w.document;
 const source=doc.querySelector('tr[data-id="3"] [data-edit="unitPriceCny"]'),target=doc.querySelector('tr[data-id="1"] [data-edit="unitPriceCny"]');source.focus();source.value='4';source.dispatchEvent(new p.w.Event('input',{bubbles:true}));source.closest('td').click();target.closest('td').dispatchEvent(new p.w.MouseEvent('click',{bubbles:true,shiftKey:true}));source.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'d',ctrlKey:true,bubbles:true,cancelable:true}));
 const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.drafts['1'].changes.unitPriceCny,4);assert.equal(saved.drafts['3'].changes.unitPriceCny,4);assert.equal(p.calls.filter(c=>c.options.method).length,0);doc.getElementById('undoWork').click();assert.equal(doc.querySelector('tr[data-id="3"] [data-edit="unitPriceCny"]').value,'4.00');
});

test('Escape cancels the active cell edit without discarding another staged field',async t=>{const p=await page(t),doc=p.w.document;p.change('[data-edit="cartonCount"]','20');const supplier=doc.querySelector('[data-edit="supplier"]');supplier.focus();supplier.value='Cancelled';supplier.dispatchEvent(new p.w.Event('input',{bubbles:true}));supplier.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.drafts['1'].changes.supplier,undefined);assert.equal(saved.drafts['1'].changes.cartonCount,20);assert.equal(doc.querySelector('[data-edit="supplier"]').value,'A');assert.equal(p.calls.filter(c=>c.options.method).length,0)});

test('paste follows keyboard navigation instead of the previous selected row',async t=>{const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:null,productCode:'B',supplier:'Other',cartonCount:2,qtyPerCarton:1}]}),doc=p.w.document;const source=doc.querySelector('tr[data-id="3"] [data-edit="supplier"]');source.click();source.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));assert.equal(doc.activeElement.closest('tr').dataset.id,'1');const event=new p.w.Event('paste',{bubbles:true,cancelable:true});event.clipboardData={getData:()=> '"Moved\nvalue"'};doc.activeElement.dispatchEvent(event);const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.drafts['1'].changes.supplier,'Moved\nvalue');assert.equal(saved.drafts['3'],undefined)});
test('paste cannot bypass split-parent freight readonly cells',async t=>{const p=await page(t,{saved:{columnLayout:6,visible:['rowKey','productCode','cartonCount','freightPrepaid'],drafts:{'1':{version:1,before:{cartonCount:10},changes:{cartonCount:5},split:{quantity:5,destinationId:'2'}}}}}),doc=p.w.document;const target=doc.querySelector('tr[data-id="1"] [data-field="freightPrepaid"]');assert.ok(target);assert.equal(target.querySelector('input'),null);target.click();const event=new p.w.Event('paste',{bubbles:true,cancelable:true});event.clipboardData={getData:()=> '100\n'};target.dispatchEvent(event);const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.drafts['1'].changes.freightPrepaid,undefined);assert.match(doc.getElementById('notice').textContent,/Chưa dán/);assert.equal(p.calls.filter(c=>c.options.method).length,0)});

test('Escape after a range paste clears selection without cancelling the staged range',async t=>{const p=await page(t,{extraRows:[{id:'3',rowKey:'D00003',version:1,contId:null,productCode:'B',supplier:'Other',cartonCount:2,qtyPerCarton:1}]}),doc=p.w.document;doc.querySelector('tr[data-id="3"] [data-field="supplier"]').click();doc.querySelector('tr[data-id="1"] [data-field="supplier"]').dispatchEvent(new p.w.MouseEvent('click',{bubbles:true,shiftKey:true}));const paste=new p.w.Event('paste',{bubbles:true,cancelable:true});paste.clipboardData={getData:()=> 'Shared'};doc.querySelector('tr[data-id="3"] [data-edit="supplier"]').dispatchEvent(paste);assert.equal(doc.activeElement.dataset.edit,'supplier');assert.equal(doc.activeElement.closest('tr').dataset.id,'3');doc.activeElement.dispatchEvent(new p.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));assert.equal(doc.querySelectorAll('.purchase-cell-selected').length,0);const saved=JSON.parse(p.w.sessionStorage.getItem('purchase:buyer:v1'));assert.equal(saved.drafts['1'].changes.supplier,'Shared');assert.equal(saved.drafts['3'].changes.supplier,'Shared')});
