const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PGlite } = require('@electric-sql/pglite');
const { createPurchaseOrdersService } = require('./purchaseOrdersService');
const { FILES: PURCHASE_FILES } = require('../db/ensurePurchaseSchema');
const excel = require('../public/shared/purchase-workbook');
const columns = require('../public/shared/purchase-columns');
let db, service, events;
const manager = { id: 'manager', hoTen: 'Người quản lý' };
const input = () => ({ productCode: 'A', productName: 'Hàng A', listedAt: '2026-11-03', qtyPerCarton: 20, cartonCount: 100, unitPriceCny: 2, fxRate: 3920, freightPrepaid: 0, freightPostpaid: 0, freightAmount: 1000 });
const file = rows => Buffer.from(excel.bytes(excel.exportWorkbook(rows, columns)));
before(async () => {
  db = new PGlite();
  // Danh sach migration Thu mua lay tu FILES de them migration moi khong lam
  // do test (truoc day ghim cung nen 0114/0115 bi bo sot).
  for (const name of ['0053_product_containers.sql','0072_product_container_unit_price_cny.sql','0075_product_container_expected.sql','0078_product_container_expected_prices.sql','0086_product_container_other_note.sql',...PURCHASE_FILES]) await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',name),'utf8'));
  await db.exec('CREATE TABLE product_report(product_code text,product_name text); CREATE TABLE kiot_test_stock(on_hand numeric);INSERT INTO kiot_test_stock VALUES(99)');
  events = new EventEmitter();
  const query = (sql,params) => db.query(sql,params);
  service = createPurchaseOrdersService({ pool:{query,connect:async()=>({query,release(){}})},events });
});
beforeEach(async () => {
  await db.exec(`TRUNCATE purchase_requests,purchase_undo_expected,purchase_operation_rows,purchase_operations,purchase_orders,product_containers,purchase_key_history,purchase_history,purchase_departures,purchase_import_previews,product_container_lines,product_container_expected,product_container_expected_state RESTART IDENTITY CASCADE;
    ALTER SEQUENCE purchase_order_key_seq RESTART WITH 1;
    UPDATE purchase_settings SET source_mode='web',projection_owns_all=true,integration_enabled=true;`);
  // integration_enabled=true: bo test nay mo ta hop dong khi Thu mua DA noi vao
  // he thong. Che do cach ly (mac dinh, migration 0117) duoc kiem rieng o
  // purchaseOrdersIsolation.test.js.
  // Bo test nay mo ta hop dong SAU cutover: Thu mua la nguon duy nhat nen moi
  // dong — ke ca dong cho xep — deu co trong read model dung chung. Pham vi
  // mot phan (mac dinh) duoc kiem rieng o purchaseOrdersProjectionScope.test.js.
});
after(async () => db?.close());

test('presence leases are shared between connections, expire, and expose only identity and history version',async()=>{
  const {createPresenceStore}=require('./purchaseOrdersRealtime');const store=createPresenceStore(db);
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  await store.touch(a,{id:'alice',hoTen:'Alice'});const both=await store.touch(b,{id:'bob',hoTen:'Bob'});
  assert.deepEqual(both.users.map(u=>u.name),['Alice','Bob']);assert.equal(both.version,'0');
  await db.query("UPDATE purchase_presence SET expires_at=now()-interval '1 minute' WHERE connection_id=$1",[a]);
  const active=await store.touch(b,{id:'bob',hoTen:'Bob'});assert.deepEqual(active.users,[{id:'bob',name:'Bob'}]);
  await store.remove(b);assert.equal((await db.query('SELECT count(*)::int n FROM purchase_presence')).rows[0].n,0);
});

test('order date-times keep hours and minutes through database writes, updates and import validation',async()=>{
 const created=await service.create(manager,{...input(),listedAt:'2026-11-03T14:25',orderedNote:'2026-11-03T15:30',etaNote:'2026-11-08T09:15'});
 assert.equal(created.listedAt,'2026-11-03T14:25');assert.equal(created.orderedNote,'2026-11-03T15:30');
 const updated=await service.update(manager,created.id,{version:created.version,changes:{shippedNote:'2026-11-04T08:45'}});assert.equal(updated.shippedNote,'2026-11-04T08:45');
 await assert.rejects(service.create(manager,{...input(),etaNote:'đợi xưởng báo'}),e=>e.code==='VALIDATION_ERROR');
});
test('confirmed row changes quantity and destination in one transaction; manual status uses version and audit only',async()=>{
 const a=await service.createContainer(manager,{name:'CONT PLAN',truckName:'17.5m'});const r=await service.create(manager,{...input(),contId:a.id});assert.equal(r.contId,String(a.id));
 const updated=await service.update(manager,r.id,{version:r.version,before:{contId:r.contId},changes:{cartonCount:50,contId:null}});assert.equal(updated.contId,null);assert.equal(updated.cartonCount,50);
 const changed=await service.changeStatus(manager,{containerId:a.id,version:a.version,status:4});assert.equal(changed.status,4);await assert.rejects(service.changeStatus(manager,{containerId:a.id,version:a.version,status:2}),e=>e.statusCode===409);assert.equal((await db.query('SELECT count(*)::int n FROM purchase_history WHERE action=\'status_edit\'')).rows[0].n,1);
});
test('migration leaves Sheets as default and writes are blocked before cutover', async () => {
  await db.query("UPDATE purchase_settings SET source_mode='sheets'");
  await assert.rejects(service.create(manager,input()),e=>e.code==='PURCHASE_SOURCE_NOT_ACTIVE');
  assert.equal((await db.query('SELECT count(*)::int n FROM purchase_orders')).rows[0].n,0);
});
test('create and transfer update canonical and both legacy read models atomically', async () => {
  const row=await service.create(manager,input());
  const cont=await service.createContainer(manager,{name:'CONT A',truckName:'17.5m'});
  await service.transfer(manager,{id:row.id,version:row.version,quantity:100,destinationId:cont.id});
  const source=(await db.query('SELECT * FROM product_container_lines')).rows[0];
  const expected=(await db.query('SELECT * FROM product_container_expected')).rows[0];
  assert.equal(source.container_name,'CONT A');assert.equal(Number(source.quantity),2000);
  assert.equal(expected.product_name,'Hàng A');assert.equal(Number(expected.quantity),2000);
});
test('repeated split keys preserve totals, retire old keys, and clear manual costs', async () => {
  const row=await service.create(manager,input()),cont=await service.createContainer(manager,{name:'CONT A',truckName:'18.5m'});
  const split=await service.transfer(manager,{id:row.id,version:1,quantity:20,destinationId:cont.id});
  assert.equal(split.remaining.rowKey,'D00001.01');assert.equal(split.created.rowKey,'D00001.02');
  assert.equal(split.remaining.freightAmount,null);
  const again=await service.transfer(manager,{id:split.created.id,version:1,quantity:5,destinationId:null});
  assert.equal(again.remaining.rowKey,'D00001.02.01');assert.equal(again.created.rowKey,'D00001.02.02');
  assert.equal(Number((await db.query('SELECT sum(carton_count) n FROM purchase_orders')).rows[0].n),100);
  assert.equal((await db.query('SELECT count(*)::int n FROM purchase_key_history')).rows[0].n,2);
});
test('same-field conflict rejects; different-field stale edit can merge', async () => {
  const row=await service.create(manager,input());
  await service.update(manager,row.id,{version:1,changes:{supplier:'NCC'}});
  await service.update(manager,row.id,{version:1,before:{buyer:null},changes:{buyer:'Dung'}});
  await assert.rejects(service.update(manager,row.id,{version:1,before:{supplier:null},changes:{supplier:'Wrong'}}),e=>e.code==='VERSION_CONFLICT');
  assert.equal((await service.list(manager)).rows[0].supplier,'NCC');
});
test('departure shortage and arrival keep immutable snapshot and do not change stock or prices', async () => {
  const row=await service.create(manager,{...input(),m3PerCarton:.2}),cont=await service.createContainer(manager,{name:'CONT A',truckName:'17.5m'});
  await service.transfer(manager,{id:row.id,version:1,quantity:100,destinationId:cont.id});
  await service.depart(manager,{containerId:cont.id,version:1,rows:[{id:row.id,version:2,actual:80}]});
  const list=await service.list(manager),shipped=list.rows.find(r=>r.contId===String(cont.id));
  assert.equal(shipped.cartonCount,80);assert.equal(list.rows.find(r=>r.contId==null).cartonCount,20);
  await service.arrive(manager,{containerId:cont.id,version:2,date:'2026-11-03',warehouse:'Kho Hà Nội'});
  await service.update(manager,shipped.id,{version:shipped.version,changes:{buyer:'Edited after arrival'}});
  assert.equal((await service.list(manager)).containers[0].status,4);
  assert.equal((await db.query('SELECT snapshot FROM purchase_departures')).rows[0].snapshot[0].cartonCount,80);
  assert.equal(Number((await db.query('SELECT on_hand FROM kiot_test_stock')).rows[0].on_hand),99);
  await assert.rejects(db.query('UPDATE purchase_history SET action=action'),/immutable/);
  await assert.rejects(db.query('DELETE FROM purchase_departures'),/immutable/);
});
test('invalid import preview never yields partial writes; token is bound to uploader', async () => {
  const row=await service.create(manager,input());
  const preview=await service.previewImport(manager,{buffer:file([{...input(),rowKey:row.rowKey,cartonCount:7},{...input(),rowKey:'D99999'}])});
  assert.equal(preview.valid,false);
  await assert.rejects(service.commitImport(manager,preview.token),e=>e.code==='IMPORT_INVALID');
  await assert.rejects(service.commitImport({id:'other'},preview.token),e=>e.code==='PREVIEW_NOT_FOUND');
  assert.equal((await service.list(manager)).rows[0].cartonCount,100);
});
test('import confirms all rows and replaying token does not create duplicates', async () => {
  const row=await service.create(manager,input());
  const preview=await service.previewImport(manager,{buffer:file([{...input(),rowKey:row.rowKey,cartonCount:7},input()])});
  const result=await service.commitImport(manager,preview.token);
  assert.equal(result.counts.create,1);assert.equal(result.counts.update,1);
  assert.deepEqual(await service.commitImport(manager,preview.token),result);
  assert.equal((await service.list(manager)).rows.length,2);
});
test('stale import rejects valid creations and updates together', async () => {
  const row=await service.create(manager,input());
  const preview=await service.previewImport(manager,{buffer:file([{...input(),rowKey:row.rowKey,cartonCount:7},input()])});
  await service.update(manager,row.id,{version:1,changes:{supplier:'Other'}});
  await assert.rejects(service.commitImport(manager,preview.token),e=>e.code==='VERSION_CONFLICT');
  assert.equal((await service.list(manager)).rows.length,1);assert.equal((await service.list(manager)).rows[0].cartonCount,100);
});
test('failure while updating read models rolls back rows and audit and emits no success event', async () => {
  const query=(sql,params)=>db.query(sql,params);let notifications=0;events.once('purchase-orders-changed',()=>notifications++);
  const failing=createPurchaseOrdersService({pool:{query,connect:async()=>({query,release(){}})},events,project:async()=>{throw Error('projection failed')}});
  await assert.rejects(failing.create(manager,input()),/projection failed/);
  assert.equal((await db.query('SELECT count(*)::int n FROM purchase_orders')).rows[0].n,0);
  assert.equal((await db.query('SELECT count(*)::int n FROM purchase_history')).rows[0].n,0);assert.equal(notifications,0);
  events.removeAllListeners();
});

test('scheduling preserves freight while a manual container amount reallocates by volume',async()=>{
  const row=await service.create(manager,{...input(),m3PerCarton:.2}),cont=await service.createContainer(manager,{name:'CONT A',truckName:'17.5m'});
  await service.transfer(manager,{id:row.id,version:1,quantity:100,destinationId:cont.id});
  await service.schedule(manager,{containerId:cont.id,version:1,loading:'DK 05/11 bốc'});
  await service.updateContainer(manager,cont.id,{version:2,changes:{freight:99999999,name:'CONT NEW'}});
  assert.equal((await service.list(manager)).rows[0].freightAmount,99999999);
  assert.equal((await db.query('SELECT container_name FROM product_container_lines')).rows[0].container_name,'CONT NEW');
});
test('bulk saves independent rows, reports conflicts individually, and emits one audit entry',async()=>{
  const a=await service.create(manager,input()),b=await service.create(manager,input());
  await service.update(manager,b.id,{version:1,changes:{buyer:'Other'}});
  const result=await service.bulkEdit(manager,{rows:[{id:a.id,version:1},{id:b.id,version:1}],changes:{buyer:'Dung'}});
  assert.equal(result.results[0].status,'updated');assert.equal(result.results[1].status,'conflict');
  assert.equal((await db.query("SELECT count(*)::int n FROM purchase_history WHERE action='bulk_edit'")).rows[0].n,1);
});
test('revise import requires every file row and validates all corrected data server-side',async()=>{
  const preview=await service.previewImport(manager,{buffer:file([{...input(),rowKey:'D99999'},input()])});
  await assert.rejects(service.reviseImport(manager,preview.token,[input()]),e=>e.code==='IMPORT_ROW_COUNT');
  const corrected=await service.reviseImport(manager,preview.token,[input(),input()]);assert.equal(corrected.valid,true);
  await service.commitImport(manager,preview.token);assert.equal((await service.list(manager)).rows.length,2);
});
test('manual edit can clear optional notes and costs without changing required fields',async()=>{
  const row=await service.create(manager,input());await service.update(manager,row.id,{version:1,changes:{supplier:'NCC'}});
  const updated=await service.update(manager,row.id,{version:2,changes:{supplier:'',freightPostpaid:null}});
  assert.equal(updated.supplier,'');assert.equal(updated.freightAmount,null);
  await assert.rejects(service.update(manager,row.id,{version:updated.version,changes:{productName:''}}),e=>e.code==='VALIDATION_ERROR');
});

test('container writes require the version seen by the user',async()=>{
  const cont=await service.createContainer(manager,{name:'CONT A',truckName:'17.5m'});
  await assert.rejects(service.schedule(manager,{containerId:cont.id,loading:'Tomorrow'}),e=>e.code==='VERSION_REQUIRED');
  await service.schedule(manager,{containerId:cont.id,version:1,loading:'Tomorrow'});
  await assert.rejects(service.updateContainer(manager,cont.id,{version:1,changes:{name:'STALE'}}),e=>e.code==='VERSION_CONFLICT');
});

test('latest listing has no time cutoff and uses listing date rather than insert order',async()=>{
  await service.create(manager,{...input(),listedAt:'2020-01-01',cartonCount:3});
  await service.create(manager,{...input(),listedAt:'2019-01-01',cartonCount:7});
  assert.equal((await service.latest(manager,' a ')).cartonCount,3);
  assert.equal(await service.latest(manager,'unknown'),null);
});

test('server export uses volume allocation consistently with row NET',async()=>{
  const row=await service.create(manager,{...input(),m3PerCarton:.2}),cont=await service.createContainer(manager,{name:'CONT A',truckName:'17.5m'});
  await service.transfer(manager,{id:row.id,version:1,quantity:100,destinationId:cont.id});
  await service.updateContainer(manager,cont.id,{version:1,changes:{freight:999999}});
  const exported=(await service.exportRows(manager))[0];
  assert.equal(exported.container,'CONT A');assert.equal(exported.totalQty,2000);assert.equal(exported.freightAmount,999999);
  assert.equal(exported.netPrice,(4000*3920+999999)/2000);
});

test('periodic expected-arrivals refresh preserves canonical names for products not yet in Kiot',async()=>{
  await service.create(manager,input());
  const query=(sql,params)=>db.query(sql,params);
  await require('../productContainers/expectedRefresh').refreshExpected({query,connect:async()=>({query,release(){}})},{log(){}});
  assert.equal((await db.query('SELECT product_name FROM product_container_expected')).rows[0].product_name,'Hàng A');
});

test('balance plan commits edits, recursive split and new code together; stale split rolls everything back',async()=>{
 const c=await service.createContainer(manager,{name:'CONT TASK',truckName:'17.5m'}),a=await service.create(manager,input()),b=await service.create(manager,{...input(),productCode:'B'});
 await service.applyPlan(manager,{rows:[{id:b.id,version:b.version,changes:{cartonCount:30}}],splits:[{id:a.id,version:a.version,sourceQty:100,quantity:40,destinationId:c.id}],creates:[{values:{...input(),productCode:'C',contId:c.id}}]});
 const all=(await service.list(manager)).rows;const branches=all.filter(r=>r.rowKey.startsWith(a.rowKey+'.'));assert.equal(branches.length,2);assert.equal(branches.reduce((s,r)=>s+r.cartonCount,0),100);assert.ok(branches.some(r=>r.rowKey===a.rowKey+'.02'&&String(r.contId)===String(c.id)));assert.equal((await db.query("SELECT count(*)::int n FROM purchase_history WHERE action='balance_plan'")).rows[0].n,1);
 const current=all.find(r=>String(r.id)===String(b.id));await assert.rejects(service.applyPlan(manager,{rows:[{id:b.id,version:current.version,changes:{cartonCount:99}}],splits:[{id:a.id,version:a.version,sourceQty:60,quantity:10,destinationId:c.id}]}));assert.equal((await service.list(manager)).rows.find(r=>String(r.id)===String(b.id)).cartonCount,30);
});

test('manual code split saves independently entered quantities and rejects blank child',async()=>{
 const a=await service.create(manager,input());await assert.rejects(service.applyPlan(manager,{splits:[{id:a.id,version:a.version,manual:true,sourceQty:100,quantity:null}]}));await service.applyPlan(manager,{splits:[{id:a.id,version:a.version,manual:true,sourceQty:7,quantity:4,destinationId:null}]});const rows=(await service.list(manager)).rows;assert.equal(rows.find(r=>r.rowKey===a.rowKey+'.01').cartonCount,7);assert.equal(rows.find(r=>r.rowKey===a.rowKey+'.02').cartonCount,4);
});

test('soft delete and restore update both read models and stale batch writes nothing',async()=>{
 const a=await service.create(manager,input()),b=await service.create(manager,{...input(),productCode:'B'});await assert.rejects(service.remove(manager,{rows:[{id:a.id,version:a.version},{id:b.id,version:999}]}));assert.equal((await service.list(manager)).rows.length,2);const result=await service.remove(manager,{rows:[{id:a.id,version:a.version}]});assert.ok(result.operationId);assert.equal((await service.list(manager)).rows.length,1);assert.equal((await db.query('SELECT count(*)::int n FROM product_container_lines')).rows[0].n,1);const trash=await service.trash(manager);assert.equal(trash.length,1);await service.restore(manager,{id:a.id,version:trash[0].version});assert.equal((await service.list(manager)).rows.length,2);
});
test('undo owns immutable snapshots, handles both split branches atomically and rejects another actor or stale row',async()=>{
 const a=await service.create(manager,input());const op=await service.applyPlan(manager,{splits:[{id:a.id,version:a.version,sourceQty:10,quantity:4,manual:true}]});await assert.rejects(service.undo({id:'other'},{operationId:op.operationId}));await service.undo(manager,{operationId:op.operationId});const rows=(await service.list(manager)).rows;assert.equal(rows.length,1);assert.equal(rows[0].rowKey,a.rowKey);assert.equal(rows[0].cartonCount,100);await assert.rejects(service.undo(manager,{operationId:op.operationId}));const update=await service.update(manager,a.id,{version:rows[0].version,changes:{cartonCount:9}});await service.update(manager,a.id,{version:update.version,changes:{supplier:'New'}});await assert.rejects(service.undo(manager,{operationId:update.operationId}),e=>e.code==='VERSION_CONFLICT');assert.equal((await service.list(manager)).rows[0].cartonCount,9);
});
test('employee assignment uses active HR id and returns only directory fields',async()=>{
 await db.exec("CREATE TABLE IF NOT EXISTS hr_employees(id BIGSERIAL PRIMARY KEY,ho_ten TEXT,bo_phan TEXT,branch TEXT,is_active BOOLEAN DEFAULT true,employment_status TEXT DEFAULT 'active');TRUNCATE hr_employees RESTART IDENTITY;INSERT INTO hr_employees(ho_ten,bo_phan,branch) VALUES('Nhân viên A','Mua','hanoi')");assert.deepEqual(await service.employees(manager),[]);const a=await service.create(manager,{...input(),buyerEmployeeId:'1'});assert.equal(a.buyer,'Nhân viên A');assert.equal(a.buyerEmployeeId,'1');assert.deepEqual(await service.employees(manager),[{name:'Nhân viên A'}]);await db.exec("UPDATE hr_employees SET employment_status='resigned'");await assert.rejects(service.update(manager,a.id,{version:a.version,changes:{buyerEmployeeId:'1'}}),e=>e.code==='EMPLOYEE_INVALID');
});

test('server supports stepwise undo while a later actor edit blocks an older operation',async()=>{
 const a=await service.create(manager,input());const first=await service.update(manager,a.id,{version:a.version,changes:{cartonCount:12}}),second=await service.update(manager,a.id,{version:first.version,changes:{cartonCount:18}});await service.undo(manager,{operationId:second.operationId});await service.undo(manager,{operationId:first.operationId});assert.equal((await service.list(manager)).rows[0].cartonCount,100);
});

test('two actors merge separate fields, block same-cell overwrite and stale delete',async()=>{
 const other={id:'other',hoTen:'Nhân viên khác'},a=await service.create(manager,input());const first=await service.update(manager,a.id,{version:a.version,changes:{supplier:'A'}});const second=await service.update(other,a.id,{version:a.version,before:{cartonCount:100},changes:{cartonCount:80}});assert.equal(second.supplier,'A');await assert.rejects(service.update(other,a.id,{version:a.version,before:{supplier:null},changes:{supplier:'B'}}),e=>e.code==='VERSION_CONFLICT');await assert.rejects(service.remove(manager,{rows:[{id:a.id,version:first.version}]}),e=>e.code==='VERSION_CONFLICT');assert.equal((await service.list(manager)).rows[0].cartonCount,80);
});
test('deleting a row after import preview invalidates the whole import and does not resurrect it',async()=>{
 const a=await service.create(manager,input()),preview=await service.previewImport(manager,{buffer:file([{...a,cartonCount:3},{...input(),productCode:'NEW'}])});await service.remove(manager,{rows:[{id:a.id,version:a.version}]});await assert.rejects(service.commitImport(manager,preview.token));assert.equal((await service.list(manager)).rows.length,0);
});

test('employee assignment can be cleared without invalid bigint values',async()=>{
 await db.exec("CREATE TABLE IF NOT EXISTS hr_employees(id BIGSERIAL PRIMARY KEY,ho_ten TEXT,bo_phan TEXT,branch TEXT,is_active BOOLEAN DEFAULT true,employment_status TEXT DEFAULT 'active');TRUNCATE hr_employees RESTART IDENTITY;INSERT INTO hr_employees(ho_ten,bo_phan,branch) VALUES('A','Mua','hanoi')");const a=await service.create(manager,{...input(),buyerEmployeeId:'1'});const b=await service.update(manager,a.id,{version:a.version,changes:{buyerEmployeeId:null}});assert.equal(b.buyerEmployeeId,null);assert.equal(b.buyer,'');
});

test('replaying an acknowledged request returns one result without duplicate rows or audit',async()=>{
 const request={...manager,_purchaseRequest:{key:'11111111-1111-4111-8111-111111111111',fingerprint:'create-A'}};const first=await service.create(request,input()),again=await service.create(request,input());assert.deepEqual(again,first);assert.equal((await service.list(manager)).rows.length,1);assert.equal((await db.query("SELECT count(*)::int n FROM purchase_history WHERE action='create'")).rows[0].n,1);await assert.rejects(service.create({...request,_purchaseRequest:{...request._purchaseRequest,fingerprint:'other-body'}},input()),e=>e.code==='REQUEST_KEY_REUSED');
});
test('a rolled back request can retry and commits its cache only after projection succeeds',async()=>{
 const request={...manager,_purchaseRequest:{key:'22222222-2222-4222-8222-222222222222',fingerprint:'request'}},query=(sql,p)=>db.query(sql,p),broken=createPurchaseOrdersService({pool:{query,connect:async()=>({query,release(){}})},project:async()=>{throw Error('projection failed')},events});await assert.rejects(broken.create(request,input()));assert.equal((await db.query('SELECT count(*)::int n FROM purchase_requests')).rows[0].n,0);await service.create(request,input());assert.equal((await service.list(manager)).rows.length,1);
});

test('row history filters the complete split family without unrelated product rows',async()=>{
 const a=await service.create(manager,input());await service.create(manager,{...input(),productCode:'B'});const result=await service.applyPlan(manager,{splits:[{id:a.id,version:a.version,sourceQty:8,quantity:2,manual:true}]});const history=await service.history(manager,a.rowKey+'.02');assert.ok(history.length>=2);assert.ok(history.every(h=>!h.summary.row||h.summary.row.productCode==='A'));assert.ok(history.some(h=>h.action==='balance_plan'));await assert.rejects(service.history(manager,'invalid'),e=>e.code==='ROW_KEY_INVALID');
});

test('undo preview names the exact fields and values that will be restored',async()=>{
 const a=await service.create(manager,input());await service.update(manager,a.id,{version:a.version,changes:{cartonCount:12,supplier:'X'}});const actions=await service.operations(manager);assert.equal(actions[0].action,'edit');assert.ok(actions[0].preview[0].changes.some(c=>c.field==='cartonCount'&&c.from===12&&c.to===100));assert.ok(actions[0].preview[0].changes.some(c=>c.field==='supplier'&&c.from==='X'));
});
test('five thousand rows retain complete projections when five hundred rows are edited',async t=>{
 const start=Date.now();await db.exec("INSERT INTO purchase_orders(row_key,root_key,product_code,product_name,qty_per_carton,carton_count,kg_per_carton,m3_per_carton) SELECT 'D'||(100000+n)::text,'D'||(100000+n)::text,'LOAD'||n,'Hàng thử',10,1,5,.2 FROM generate_series(1,5000) n");const all=(await service.list(manager)).rows;assert.equal(all.length,5000);const selected=all.slice(0,500).map(r=>({id:r.id,version:r.version,before:{cartonCount:1}}));const changed=await service.bulkEdit(manager,{rows:selected,changes:{cartonCount:2}});assert.equal(changed.results.filter(r=>r.status==='updated').length,500);assert.equal((await db.query('SELECT count(*)::int n FROM product_container_lines')).rows[0].n,5000);assert.equal((await service.list(manager)).rows.filter(r=>r.cartonCount===2).length,500);t.diagnostic('PGlite fixture: 5,000 rows, 500 edits and projection '+(Date.now()-start)+' ms; staging performance still required');
});

test('container formula settings are versioned and missing product volume remains unpriced',async()=>{
 const c=await service.createContainer(manager,{name:'FORMULA',truckName:'17.5m'});assert.equal(c.freight_mode,'formula');const r=await service.create(manager,{...input(),contId:c.id});const changed=await service.updateContainer(manager,c.id,{version:c.version,changes:{freightMode:'formula',freightBase:202000000,freightCapacity:170}});assert.equal(Number(changed.freight_base),202000000);await assert.rejects(service.updateContainer(manager,c.id,{version:changed.version,changes:{freightCapacity:0}}));assert.equal((await service.list(manager)).rows[0].freightAmount,r.freightAmount);
});

test('freight allocation shares manual container cost and refuses incomplete volumes',()=>{const model=require('../public/shared/purchase-freight');const rows=[{contId:1,cartonCount:2,m3PerCarton:2},{contId:1,cartonCount:3,m3PerCarton:2}],containers=[{id:1,freightMode:'manual',freight:1000}];let rates=model.rates(rows,containers);assert.deepEqual(rows.map(r=>model.rowAmount(r,rates)),[400,600]);rows[1].m3PerCarton=null;rates=model.rates(rows,containers);assert.equal(model.rowAmount(rows[0],rates),null);containers[0].freightMode='formula';rates=model.rates(rows,containers);assert.equal(model.rowAmount(rows[0],rates),4*202000000/170);assert.equal(model.rowAmount(rows[1],rates),null)});

test('clearing container freight restores the standard volume formula',async()=>{const c=await service.createContainer(manager,{name:'CLEAR COST',truckName:'17.5m'});const manual=await service.updateContainer(manager,c.id,{version:c.version,changes:{freight:123,freightMode:'manual',freightBase:999,freightCapacity:2}});const auto=await service.updateContainer(manager,c.id,{version:manual.version,changes:{freight:null}});assert.equal(auto.freight_mode,'formula');assert.equal(Number(auto.freight_base),202000000);assert.equal(Number(auto.freight_capacity),170)});

test('multi-row allocation, export and SQL projection agree through manual, formula and missing-volume cases',async()=>{const c=await service.createContainer(manager,{name:'PARITY',truckName:'17.5m'});for(const [i,volume] of [.1,.3,.000001].entries())await service.create(manager,{...input(),productCode:'PARITY'+i,contId:c.id,m3PerCarton:volume,unitPriceCny:1.23456,freightPrepaid:.1,freightPostpaid:.2});let version=c.version;for(const changes of [{freight:1234567},{freightMode:'formula',freightBase:202000000,freightCapacity:170}]){const updated=await service.updateContainer(manager,c.id,{version,changes});version=updated.version;const exported=await service.exportRows(manager),projection=(await db.query('SELECT product_code,vietnam_price FROM product_container_lines')).rows;for(const row of exported){const price=Number(projection.find(p=>p.product_code===row.productCode).vietnam_price);assert.ok(Math.abs(price-row.netPrice)<.000001);assert.equal(row.literDiff,null);assert.equal(row.totalCny,2469.22)}const freight=exported.reduce((n,r)=>n+r.freightAmount,0);if(changes.freight)assert.ok(Math.abs(freight-changes.freight)<.001)}const rows=(await service.list(manager)).rows;await service.update(manager,rows[0].id,{version:rows[0].version,before:{m3PerCarton:rows[0].m3PerCarton},changes:{m3PerCarton:null}});const manual=await service.updateContainer(manager,c.id,{version,changes:{freight:1000}});const exported=await service.exportRows(manager);assert.ok(exported.every(r=>r.freightAmount===null&&r.netPrice===null));assert.ok((await db.query('SELECT vietnam_price FROM product_container_lines')).rows.every(r=>r.vietnam_price===null))});
test('free purchase buyer names persist and suggestions include previously entered names without HR records',async()=>{
 const a=await service.create(manager,{...input(),buyer:'Người mua mới'});
 assert.equal(a.buyer,'Người mua mới');assert.equal(a.buyerEmployeeId,null);
 const b=await service.update(manager,a.id,{version:a.version,changes:{buyer:'Tên khác'}});
 assert.equal(b.buyer,'Tên khác');
 const names=await service.employees(manager);assert.ok(names.some(e=>e.name==='Tên khác'));assert.ok(names.some(e=>e.name==='Người mua mới'));
});
