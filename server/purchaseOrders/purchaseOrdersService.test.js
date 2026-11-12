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
const snapshotFile = async rows => { const snapshot=await service.importSnapshot(manager);return Buffer.from(excel.exportImportSnapshot({rows,columns,revision:snapshot.revision})); };
before(async () => {
  db = new PGlite();
  // Danh sach migration Thu mua lay tu FILES de them migration moi khong lam
  // do test (truoc day ghim cung nen 0114/0115 bi bo sot).
  for (const name of ['0053_product_containers.sql','0072_product_container_unit_price_cny.sql','0075_product_container_expected.sql','0078_product_container_expected_prices.sql','0086_product_container_other_note.sql',...PURCHASE_FILES]) await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',name),'utf8'));
  await db.exec('CREATE TABLE shipping_measures(code_key text PRIMARY KEY, per_carton numeric, m3_per_unit numeric, kg_per_unit numeric)');
  // Expected-arrivals projection also reads the Kiot product-name fallback.
  await db.exec('CREATE TABLE product_report(product_code text,product_name text); CREATE TABLE products(code text,name text); CREATE TABLE kiot_test_stock(on_hand numeric);INSERT INTO kiot_test_stock VALUES(99)');
  events = new EventEmitter();
  const query = (sql,params) => db.query(sql,params);
  service = createPurchaseOrdersService({ pool:{query,connect:async()=>({query,release(){}})},events });
});
beforeEach(async () => {
  await db.exec(`TRUNCATE purchase_employees,purchase_requests,purchase_undo_expected,purchase_operation_rows,purchase_operations,purchase_orders,product_containers,purchase_key_history,purchase_key_pool,purchase_key_reservations,purchase_history,purchase_departures,purchase_import_previews,product_container_lines,product_container_expected,product_container_expected_state,shipping_measures RESTART IDENTITY CASCADE;
    ALTER SEQUENCE purchase_order_key_seq RESTART WITH 1;
    UPDATE purchase_settings SET source_mode='web',projection_owns_all=true,integration_enabled=true;
    INSERT INTO purchase_employees(name) VALUES('Dung'),('Other'),('Edited after arrival');`);
  // integration_enabled=true: bo test nay mo ta hop dong khi Thu mua DA noi vao
  // he thong. Che do cach ly (mac dinh, migration 0117) duoc kiem rieng o
  // purchaseOrdersIsolation.test.js.
  // Bo test nay mo ta hop dong SAU cutover: Thu mua la nguon duy nhat nen moi
  // dong — ke ca dong cho xep — deu co trong read model dung chung. Pham vi
  // mot phan (mac dinh) duoc kiem rieng o purchaseOrdersProjectionScope.test.js.
});
after(async () => db?.close());

test('recyclable row key migration preserves family identity and seeds only inactive root keys',async()=>{
 const root=(await db.query("INSERT INTO purchase_orders(row_key,root_key,product_code,product_name,qty_per_carton,carton_count) VALUES('D70000','D70000','ROOT','Hàng gốc',1,1) RETURNING id")).rows[0].id;
 const child=(await db.query("INSERT INTO purchase_orders(row_key,root_key,split_from_key,root_order_id,product_code,product_name,qty_per_carton,carton_count) VALUES('D70000.01','D70000','D70000',$1,'CHILD','Hàng con',1,1) RETURNING id",[root])).rows[0].id;
 assert.deepEqual((await db.query('SELECT DISTINCT root_order_id FROM purchase_orders WHERE id=ANY($1::bigint[])',[ [root,child] ])).rows.map(r=>Number(r.root_order_id)),[Number(root)]);
 const retired=(await db.query("INSERT INTO purchase_orders(row_key,root_key,deleted_at,product_code,product_name,qty_per_carton,carton_count) VALUES('D70001','D70001',now(),'OLD','Hàng cũ',1,1) RETURNING id")).rows[0].id;
 await db.query("INSERT INTO purchase_orders(row_key,root_key,product_code,product_name,qty_per_carton,carton_count) VALUES('D70001','D70001','NEW','Hàng mới',1,1)");
 await db.query("INSERT INTO purchase_key_history(row_key,order_id,root_order_id,root_key) VALUES('D70001',$1,$1,'D70001'),('D70001',$2,$2,'D70001')",[retired,root]);
 assert.equal((await db.query("SELECT count(*)::int n FROM purchase_orders WHERE row_key='D70001'")).rows[0].n,2);
 assert.equal((await db.query("SELECT count(*)::int n FROM purchase_key_history WHERE row_key='D70001'")).rows[0].n,2);
 await db.query("INSERT INTO purchase_orders(row_key,root_key,deleted_at,product_code,product_name,qty_per_carton,carton_count) VALUES('D70002','D70002',now(),'DEL','Hàng xóa',1,1)");
 await db.query("INSERT INTO purchase_orders(row_key,root_key,product_code,product_name,qty_per_carton,carton_count) VALUES('D70003','D70003','LIVE','Hàng sống',1,1)");
 const seed=`WITH inactive_families AS (
   SELECT root_order_id,min(root_key) AS root_key FROM purchase_orders GROUP BY root_order_id
   HAVING bool_or(deleted_at IS NOT NULL) AND NOT bool_or(deleted_at IS NULL)
   ) INSERT INTO purchase_key_pool(row_key)
   SELECT family.root_key FROM inactive_families AS family
   WHERE NOT EXISTS(SELECT 1 FROM purchase_orders AS active WHERE active.row_key=family.root_key AND active.deleted_at IS NULL)
   ON CONFLICT(row_key) DO NOTHING`;
 await db.query(seed);await db.query(seed);
 assert.deepEqual((await db.query('SELECT row_key FROM purchase_key_pool ORDER BY row_key')).rows.map(r=>r.row_key),['D70002']);
});

test('migration 0123 backfills legacy import families, undo snapshots, and exact pool contents',async t=>{
 const legacyDb=new PGlite();
 try {
  for(const name of ['0053_product_containers.sql','0072_product_container_unit_price_cny.sql','0075_product_container_expected.sql','0078_product_container_expected_prices.sql','0086_product_container_other_note.sql',...PURCHASE_FILES.slice(0,-1)]) await legacyDb.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',name),'utf8'));
  const insertRoot="INSERT INTO purchase_orders(row_key,root_key,split_from_key,deleted_at,product_code,product_name,qty_per_carton,carton_count) VALUES($1,$2,$3,$4,$5,$6,1,1) RETURNING id";
  const root=Number((await legacyDb.query(insertRoot,['D88000','D88000',null,null,'ROOT','Gốc'])).rows[0].id);
  await legacyDb.query(insertRoot,['D88000.01','D88000','D88000',null,'CHILD','Nhánh']);
  const importedA=Number((await legacyDb.query(insertRoot,['D88001.01','D88001','D88001',null,'IMP1','Nhập 1'])).rows[0].id);
  await legacyDb.query(insertRoot,['D88001.02','D88001','D88001',null,'IMP2','Nhập 2']);
  await legacyDb.query(insertRoot,['D88002.01','D88002','D88002',new Date(),'DEL1','Xóa 1']);
  await legacyDb.query(insertRoot,['D88002.02','D88002','D88002',new Date(),'DEL2','Xóa 2']);
  await legacyDb.query(insertRoot,['D88003.01','D88003','D88003',null,'LIVE','Còn sống']);
  await legacyDb.query(insertRoot,['D88003.02','D88003','D88003',new Date(),'DEL3','Xóa 3']);
  await legacyDb.query("INSERT INTO purchase_key_history(row_key,order_id,root_key) VALUES('D88000',$1,'D88000')",[root]);
  const operation='88888888-8888-4888-8888-888888888888';
  await legacyDb.query('INSERT INTO purchase_operations(id,actor_id,action) VALUES($1,$2,$3)',[operation,manager.id,'delete']);
  const oldRow=(await legacyDb.query('SELECT to_jsonb(purchase_orders) AS row FROM purchase_orders WHERE id=$1',[root])).rows[0].row;
  await legacyDb.query('INSERT INTO purchase_operation_rows(operation_id,row_id,before_row,after_row) VALUES($1,$2,$3,NULL)',[operation,root,JSON.stringify(oldRow)]);
  await legacyDb.query('INSERT INTO purchase_undo_expected(operation_id,row_id,expected_row) VALUES($1,$2,$3)',[operation,root,JSON.stringify(oldRow)]);
  const missingRow=999999;
  const orphanSnapshot={id:missingRow,row_key:'D88001.01',root_key:'D88001',split_from_key:'D88001'};
  await legacyDb.query('INSERT INTO purchase_operation_rows(operation_id,row_id,before_row,after_row) VALUES($1,$2,$3,NULL)',[operation,missingRow,JSON.stringify(orphanSnapshot)]);
  await legacyDb.query('INSERT INTO purchase_undo_expected(operation_id,row_id,expected_row) VALUES($1,$2,$3)',[operation,missingRow,JSON.stringify(orphanSnapshot)]);

  await legacyDb.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0123_purchase_recyclable_row_keys.sql'),'utf8'));
  const families=(await legacyDb.query("SELECT root_key,array_agg(root_order_id ORDER BY id) ids FROM purchase_orders GROUP BY root_key ORDER BY root_key")).rows;
  const byKey=new Map(families.map(f=>[f.root_key,f.ids.map(String)]));
  await t.test('legacy split and suffix-only import rows share one root identity',async()=>{
   assert.deepEqual(byKey.get('D88000'),[String(root),String(root)]);
   assert.deepEqual(byKey.get('D88001'),[String(importedA),String(importedA)]);
   assert.equal(Number((await legacyDb.query("SELECT root_order_id FROM purchase_key_history WHERE row_key='D88000'")).rows[0].root_order_id),root);
  });
  const snapshots=(await legacyDb.query('SELECT row_id,root_order_id,before_row FROM purchase_operation_rows WHERE operation_id=$1 ORDER BY row_id',[operation])).rows;
  await t.test('legacy undo snapshots keep exact current-row equality',async()=>{
   assert.equal(Number(snapshots[0].root_order_id),root);
   assert.equal(Number(snapshots[0].before_row.root_order_id),root);
   assert.equal(Number(snapshots[1].root_order_id),importedA);
   assert.equal(Number(snapshots[1].before_row.root_order_id),importedA);
   assert.deepEqual((await legacyDb.query('SELECT expected.expected_row=to_jsonb(row) AS exact FROM purchase_undo_expected expected JOIN purchase_orders row ON row.id=expected.row_id WHERE expected.operation_id=$1',[operation])).rows,[{exact:true}]);
   assert.equal((await legacyDb.query('SELECT expected_row->>\'root_order_id\' AS root_id FROM purchase_undo_expected WHERE operation_id=$1 AND row_id=$2',[operation,missingRow])).rows[0].root_id,String(importedA));
  });
  await t.test('pool seed excludes active suffix-only families and contains only inactive roots',async()=>{
   assert.deepEqual((await legacyDb.query('SELECT row_key FROM purchase_key_pool ORDER BY row_key')).rows.map(r=>r.row_key),['D88002']);
  });
 } finally { await legacyDb.close(); }
});

test('presence leases are shared between connections, expire, and expose only identity and history version',async()=>{
  const {createPresenceStore}=require('./purchaseOrdersRealtime');const store=createPresenceStore(db);
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  await store.touch(a,{id:'alice',hoTen:'Alice'});const both=await store.touch(b,{id:'bob',hoTen:'Bob'});
  assert.deepEqual(both.users.map(u=>u.name),['Alice','Bob']);assert.equal(both.version,'0:0');
  await db.query("UPDATE purchase_presence SET expires_at=now()-interval '1 minute' WHERE connection_id=$1",[a]);
  const active=await store.touch(b,{id:'bob',hoTen:'Bob'});assert.deepEqual(active.users,[{id:'bob',name:'Bob'}]);
  await store.remove(b);assert.equal((await db.query('SELECT count(*)::int n FROM purchase_presence')).rows[0].n,0);
});

test('delta changes return authoritative rows, tombstones, containers and employee invalidation',async()=>{
 const original=await service.create(manager,input());
 const baseline=await service.revision(manager);
 const container=await service.createContainer(manager,{name:'DELTA CONT',truckName:'17.5m'});
 const updated=await service.update(manager,original.id,{version:original.version,changes:{cartonCount:80}});
 const deleted=await service.create(manager,{...input(),productCode:'B'});
 await service.remove(manager,{rows:[{id:deleted.id,version:deleted.version}]});
 await service.createEmployee(manager,{name:'Delta employee'});
 const delta=await service.changes(manager,baseline.revision);
 assert.equal(delta.reset,false);
 assert.equal(delta.employeesChanged,true);
 assert.ok(delta.revision!==baseline.revision);
 assert.deepEqual(delta.rows.map(row=>row.id),[original.id]);
 assert.equal(delta.rows[0].version,updated.version);
 assert.equal(delta.rows[0].cartonCount,80);
 assert.deepEqual(delta.deletedIds,[deleted.id]);
 assert.ok(delta.containers.some(row=>String(row.id)===String(container.id)));
 assert.equal(delta.sourceMode,'web');
 assert.equal(delta.integrationEnabled,true);
 assert.equal(Object.hasOwn(delta,'before_row'),false);
 assert.equal(JSON.stringify(delta).includes('before_row'),false);
});
test('container truck name accepts user-entered text on create and edit',async()=>{
 const created=await service.createContainer(manager,{name:'CUSTOM TRUCK',truckName:'Xe 20 tấn'});
 assert.equal(created.truck_name,'Xe 20 tấn');
 const edited=await service.updateContainer(manager,created.id,{version:created.version,changes:{truckName:'  Mooc lùn  '}});
 assert.equal(edited.truck_name,'Mooc lùn');
 await assert.rejects(service.updateContainer(manager,created.id,{version:edited.version,changes:{truckName:'x'.repeat(81)}}),e=>e.statusCode===400);
 await assert.rejects(service.createContainer(manager,{name:'BAD TRUCK',truckName:{}}),e=>e.statusCode===400);
});

test('delta changes request a reset for malformed, ahead and over-cap cursors',async()=>{
 const one=await service.create(manager,input());
 const current=await service.revision(manager);
 for(const after of ['broken','999999:999999',current.revision+':999999']){
  const result=await service.changes(manager,after);
  assert.equal(result.reset,true,after);
  assert.equal(result.revision,current.revision,after);
  assert.deepEqual(result.rows,[],after);
  assert.deepEqual(result.deletedIds,[],after);
 }
 const operation='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 await db.query('INSERT INTO purchase_operations(id,actor_id) VALUES($1,$2)',[operation,manager.id]);
 await db.query("INSERT INTO purchase_history(action,actor_id,actor_name,summary) VALUES('edit',$1,$2,$3)",[manager.id,manager.hoTen,JSON.stringify({operationId:operation})]);
 await db.query('INSERT INTO purchase_operation_rows(operation_id,row_id,root_order_id,before_row,after_row) SELECT $1,100000+g,100000+g,NULL,NULL FROM generate_series(1,501) g',[operation]);
 const overCap=await service.changes(manager,'0:0');
 assert.equal(overCap.reset,true);
 assert.deepEqual(overCap.rows,[]);
 assert.deepEqual(overCap.deletedIds,[]);
 assert.ok(one.id);
});

test('order date-times keep hours and minutes through database writes, updates and import validation',async()=>{
 const created=await service.create(manager,{...input(),listedAt:'2026-11-03T14:25',orderedNote:'2026-11-03T15:30',etaNote:'2026-11-08T09:15'});
 assert.equal(created.listedAt,'2026-11-03T14:25');assert.equal(created.orderedNote,'2026-11-03T15:30');
 const updated=await service.update(manager,created.id,{version:created.version,changes:{shippedNote:'2026-11-04T08:45'}});assert.equal(updated.shippedNote,'2026-11-04T08:45');
 await assert.rejects(service.create(manager,{...input(),etaNote:'đợi xưởng báo'}),e=>e.code==='VALIDATION_ERROR');
});
test('confirmed row changes quantity and destination in one transaction; manual status uses version and audit only',async()=>{
 const a=await service.createContainer(manager,{name:'CONT PLAN',truckName:'17.5m'});const r=await service.create(manager,{...input(),contId:a.id});assert.equal(r.contId,null);
 const updated=await service.update(manager,r.id,{version:r.version,before:{contId:r.contId},changes:{cartonCount:50,contId:null}});assert.equal(updated.contId,null);assert.equal(updated.cartonCount,50);
 const changed=await service.changeStatus(manager,{containerId:a.id,version:a.version,status:4});assert.equal(changed.status,4);await assert.rejects(service.changeStatus(manager,{containerId:a.id,version:a.version,status:2}),e=>e.statusCode===409);assert.equal((await db.query('SELECT count(*)::int n FROM purchase_history WHERE action=\'status_edit\'')).rows[0].n,1);
});
test('warehouse liter and m³ measurements project one CÂN ĐO record to every matching purchase row',async()=>{
 await db.query("INSERT INTO shipping_measures(code_key,per_carton,m3_per_unit) VALUES('a',12,.025)");
 await service.create(manager,{...input(),productCode:'A'});await service.create(manager,{...input(),productCode:' a '});
 const listed=await service.list(manager),exported=await service.exportRows(manager);
 assert.equal(listed.rows.length,2);assert.deepEqual(listed.rows.map(r=>[r.literWarehouse,Number(r.m3Warehouse.toFixed(3))]),[[25,.3],[25,.3]]);
 assert.deepEqual(exported.map(r=>[r.literWarehouse,Number(r.m3Warehouse.toFixed(3))]),[[25,.3],[25,.3]]);
 const latest=await service.latest(manager,'A');assert.deepEqual([latest.literWarehouse,latest.m3Warehouse],[25,.3]);
 const preview=await service.previewImport(manager,{buffer:await snapshotFile(exported)});
 assert.equal(preview.valid,true);assert.equal(preview.counts.unchanged,2);
 await service.remove(manager,{rows:[{id:listed.rows[0].id,version:listed.rows[0].version}]});assert.equal((await service.trash(manager))[0].m3Warehouse,.3);
});
test('comparison overrides persist per order row, export effective values, and clear back to shared measurements',async()=>{
 await db.query("INSERT INTO shipping_measures(code_key,per_carton,m3_per_unit,kg_per_unit) VALUES('a',12,.025,.4)");
 const a=await service.create(manager,{...input(),productCode:'A',m3PerCarton:.073,kgPerCarton:10}),b=await service.create(manager,{...input(),productCode:'A',listedAt:'2026-11-02',m3PerCarton:.073,kgPerCarton:10});
 const edited=await service.update(manager,a.id,{version:a.version,before:{literWarehouse:25},changes:{literWarehouse:30,m3Warehouse:.42,literChina:8,literDiff:-.7333,gramWarehouse:450,gramChina:350,gramDiff:-.2222,measuredOn:'2026-11-10T14:35',ratio:18.5}});
 assert.deepEqual([edited.literWarehouse,edited.m3Warehouse,edited.literChina,edited.literDiff,edited.gramWarehouse,edited.gramChina,edited.gramDiff,edited.measuredOn,edited.ratio],[30,.42,8,-.7333,450,350,-.2222,'2026-11-10T14:35',18.5]);
 assert.equal(edited.measurementDefaults.literWarehouse,25);assert.equal(edited.measurementDefaults.m3Warehouse,.3);assert.equal(edited.measurementDefaults.measuredOn,null);
 assert.deepEqual(Object.keys(edited.measurementOverrides).sort(),['literChina','literDiff','literWarehouse','m3Warehouse','gramWarehouse','gramChina','gramDiff','measuredOn','ratio'].sort());
 const listed=await service.list(manager),exported=await service.exportRows(manager),latest=await service.latest(manager,'A');
 const persisted=listed.rows.find(r=>r.id===a.id);assert.equal(persisted.literWarehouse,30);assert.equal(persisted.m3Warehouse,.42);assert.equal(exported.find(r=>r.id===a.id).literChina,8);assert.equal(exported.find(r=>r.id===a.id).literDiff,-.7333);assert.equal(latest.measurementOverrides.literWarehouse,30);
 assert.deepEqual([listed.rows.find(r=>r.id===b.id).literWarehouse,listed.rows.find(r=>r.id===b.id).m3Warehouse],[25,.3]);
 assert.deepEqual((await db.query("SELECT per_carton,m3_per_unit,kg_per_unit FROM shipping_measures WHERE code_key='a'")).rows[0],{per_carton:'12',m3_per_unit:'0.025',kg_per_unit:'0.4'});
 const undo=(await service.operations(manager))[0];assert.ok(undo);await service.undo(manager,{operationId:undo.id});assert.equal((await service.latest(manager,'A')).literWarehouse,25);
 const again=await service.update(manager,a.id,{version:(await service.latest(manager,'A')).version,changes:{literWarehouse:30,m3Warehouse:.42,measuredOn:'2026-11-10'}});
 const cleared=await service.update(manager,a.id,{version:again.version,changes:{literWarehouse:null,m3Warehouse:'',measuredOn:null}});assert.equal(cleared.literWarehouse,25);assert.equal(cleared.m3Warehouse,.3);assert.equal(cleared.measuredOn,null);assert.equal(Object.hasOwn(cleared.measurementOverrides,'literWarehouse'),false);
 const changedSource=await service.update(manager,a.id,{version:cleared.version,changes:{literWarehouse:35,literDiff:null}});assert.ok(Number.isFinite(changedSource.literDiff));
 await assert.rejects(service.update(manager,a.id,{version:changedSource.version,changes:{literWarehouse:-1}}),e=>e.code==='VALIDATION_ERROR');
 const direct=await service.create(manager,{...input(),productCode:'A',m3Warehouse:.66});assert.equal(direct.m3Warehouse,.66);
 const planned=await service.applyPlan(manager,{creates:[{values:{...input(),productCode:'A',gramWarehouse:550}}]});assert.equal(planned.createdKeys.length,1);assert.equal((await service.latest(manager,'A')).gramWarehouse,550);
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
  const preview=await service.previewImport(manager,{buffer:await snapshotFile([{...input(),rowKey:row.rowKey,cartonCount:7},{...input(),rowKey:'D99999'}])});
  assert.equal(preview.valid,false);
  await assert.rejects(service.commitImport(manager,preview.token),e=>e.code==='IMPORT_INVALID');
  await assert.rejects(service.commitImport({id:'other'},preview.token),e=>e.code==='PREVIEW_NOT_FOUND');
  assert.equal((await service.list(manager)).rows[0].cartonCount,100);
});
test('import confirms all rows and replaying token does not create duplicates', async () => {
  const row=await service.create(manager,input());
  const preview=await service.previewImport(manager,{buffer:await snapshotFile([{...input(),rowKey:row.rowKey,cartonCount:7},input()])});
  const result=await service.commitImport(manager,preview.token);
  assert.equal(result.counts.create,1);assert.equal(result.counts.update,1);
  assert.deepEqual(await service.commitImport(manager,preview.token),result);
  assert.equal((await service.list(manager)).rows.length,2);
});
test('snapshot import clears blanks and soft-deletes rows omitted from the complete file',async()=>{
 const kept=await service.create(manager,{...input(),supplier:'NCC'}),removed=await service.create(manager,{...input(),productCode:'B'}),cursor=(await service.revision(manager)).revision;
 const preview=await service.previewImport(manager,{buffer:await snapshotFile([{...kept,supplier:''}])});assert.equal(preview.valid,true);assert.equal(preview.counts.update,1);assert.equal(preview.counts.delete,1);
 await service.commitImport(manager,preview.token);const listed=await service.list(manager);assert.equal(listed.rows.length,1);assert.equal(listed.rows[0].supplier,null);
 const trash=(await service.trash(manager))[0];assert.equal(trash.rowKey,removed.rowKey);
 assert.deepEqual((await db.query("SELECT summary->'deleted' deleted FROM purchase_history WHERE action='import'")).rows[0].deleted,[removed.rowKey]);
 assert.ok((await service.changes(manager,cursor)).deletedIds.includes(removed.id));await service.restore(manager,{id:removed.id,version:trash.version});assert.equal((await service.list(manager)).rows.length,2);
});
test('snapshot changed after download is rejected before preview',async()=>{
 const row=await service.create(manager,input()),snapshot=await service.importSnapshot(manager),buffer=Buffer.from(excel.exportImportSnapshot({rows:snapshot.rows,columns,revision:snapshot.revision}));
 await service.update(manager,row.id,{version:row.version,changes:{supplier:'Changed'}});
 await assert.rejects(service.previewImport(manager,{buffer}),error=>error.code==='IMPORT_SNAPSHOT_STALE');assert.equal((await service.list(manager)).rows[0].supplier,'Changed');
});
test('stale import rejects valid creations and updates together', async () => {
  const row=await service.create(manager,input());
  const preview=await service.previewImport(manager,{buffer:await snapshotFile([{...input(),rowKey:row.rowKey,cartonCount:7},input()])});
  await service.update(manager,row.id,{version:1,changes:{supplier:'Other'}});
  await assert.rejects(service.commitImport(manager,preview.token),e=>e.code==='IMPORT_SNAPSHOT_STALE');
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
  const preview=await service.previewImport(manager,{buffer:await snapshotFile([{...input(),rowKey:'D99999'},input()])});
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

test('balance plan ignores client-only id and version on a new row',async()=>{
 await db.query("SELECT setval('purchase_order_key_seq',1,true)");
 const result=await service.applyPlan(manager,{creates:[{values:{...input(),id:'new123',version:1,rowKey:'D00001',contId:null}}]});
 const created=(await service.list(manager)).rows[0];assert.deepEqual(result.createdKeys,['D00001']);assert.equal(created.rowKey,'D00001');assert.equal(created.version,1);assert.notEqual(created.id,'new123');
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
test('catalog is independent of HR and assignments save name snapshots',async()=>{
 const e=await service.createEmployee(manager,{name:'Nhân viên A'});assert.deepEqual(Object.keys(e).sort(),['color','id','isActive','name','version']);
 assert.equal((await db.query("SELECT to_regclass('hr_employees') AS t")).rows[0].t,null);
 const row=await service.create(manager,{...input(),buyer:e.name});assert.equal(row.buyer,e.name);assert.equal(row.buyerEmployeeId,null);
 await service.updateEmployee(manager,e.id,{version:e.version,changes:{name:'Renamed',isActive:false}});
 assert.equal((await service.latest(manager,'A')).buyer,e.name);
 await assert.rejects(service.create(manager,{...input(),buyer:e.name}),e=>e.code==='EMPLOYEE_INVALID');
 await assert.rejects(service.create(manager,{...input(),buyerEmployeeId:'1'}),e=>e.code==='EMPLOYEE_INVALID');
 const edited=await service.update(manager,row.id,{version:row.version,changes:{buyer:row.buyer,supplier:'OK'}});assert.equal(edited.supplier,'OK');
});

test('server supports stepwise undo while a later actor edit blocks an older operation',async()=>{
 const a=await service.create(manager,input());const first=await service.update(manager,a.id,{version:a.version,changes:{cartonCount:12}}),second=await service.update(manager,a.id,{version:first.version,changes:{cartonCount:18}});await service.undo(manager,{operationId:second.operationId});await service.undo(manager,{operationId:first.operationId});assert.equal((await service.list(manager)).rows[0].cartonCount,100);
});

test('two actors merge separate fields, block same-cell overwrite and stale delete',async()=>{
 const other={id:'other',hoTen:'Nhân viên khác'},a=await service.create(manager,input());const first=await service.update(manager,a.id,{version:a.version,changes:{supplier:'A'}});const second=await service.update(other,a.id,{version:a.version,before:{cartonCount:100},changes:{cartonCount:80}});assert.equal(second.supplier,'A');await assert.rejects(service.update(other,a.id,{version:a.version,before:{supplier:null},changes:{supplier:'B'}}),e=>e.code==='VERSION_CONFLICT');await assert.rejects(service.remove(manager,{rows:[{id:a.id,version:first.version}]}),e=>e.code==='VERSION_CONFLICT');assert.equal((await service.list(manager)).rows[0].cartonCount,80);
});
test('deleting a row after import preview invalidates the whole import and does not resurrect it',async()=>{
 const a=await service.create(manager,input()),preview=await service.previewImport(manager,{buffer:await snapshotFile([{...a,cartonCount:3},{...input(),productCode:'NEW'}])});await service.remove(manager,{rows:[{id:a.id,version:a.version}]});await assert.rejects(service.commitImport(manager,preview.token));assert.equal((await service.list(manager)).rows.length,0);
});

test('employee assignment can be cleared using the buyer name field',async()=>{
 const a=await service.create(manager,{...input(),buyer:'Dung'});const b=await service.update(manager,a.id,{version:a.version,changes:{buyer:''}});assert.equal(b.buyerEmployeeId,null);assert.equal(b.buyer,'');
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

test('multi-row allocation, export and SQL projection agree through manual, formula and missing-volume cases',async()=>{const c=await service.createContainer(manager,{name:'PARITY',truckName:'17.5m'});for(const [i,volume] of [.1,.3,.000001].entries()){const r=await service.create(manager,{...input(),productCode:'PARITY'+i,m3PerCarton:volume,unitPriceCny:1.23456,freightPrepaid:.1,freightPostpaid:.2});await service.transfer(manager,{id:r.id,version:r.version,quantity:r.cartonCount,destinationId:c.id})}let version=c.version;for(const changes of [{freight:1234567},{freightMode:'formula',freightBase:202000000,freightCapacity:170}]){const updated=await service.updateContainer(manager,c.id,{version,changes});version=updated.version;const exported=await service.exportRows(manager),projection=(await db.query('SELECT product_code,vietnam_price FROM product_container_lines')).rows;for(const row of exported){const price=Number(projection.find(p=>p.product_code===row.productCode).vietnam_price);assert.ok(Math.abs(price-row.netPrice)<.000001);assert.equal(row.literDiff,null);assert.equal(row.totalCny,2469.22)}const freight=exported.reduce((n,r)=>n+r.freightAmount,0);if(changes.freight)assert.ok(Math.abs(freight-changes.freight)<.001)}const rows=(await service.list(manager)).rows;await service.update(manager,rows[0].id,{version:rows[0].version,before:{m3PerCarton:rows[0].m3PerCarton},changes:{m3PerCarton:null}});const manual=await service.updateContainer(manager,c.id,{version,changes:{freight:1000}});const exported=await service.exportRows(manager);assert.ok(exported.every(r=>r.freightAmount===null&&r.netPrice!=null));assert.ok((await db.query('SELECT vietnam_price FROM product_container_lines')).rows.every(r=>Number.isFinite(Number(r.vietnam_price))))});
test('unconfigured new buyer names are rejected and legacy names stay editable',async()=>{
 await assert.rejects(service.create(manager,{...input(),buyer:'Free text'}),e=>e.code==='EMPLOYEE_INVALID');
 const a=await service.create(manager,input());await db.query('UPDATE purchase_orders SET buyer=$2 WHERE id=$1',[a.id,'Legacy']);
 const b=await service.update(manager,a.id,{version:a.version,changes:{buyer:'Legacy',supplier:'Supplier'}});assert.equal(b.buyer,'Legacy');
 await assert.rejects(service.update(manager,a.id,{version:b.version,changes:{buyer:'Not configured'}}),e=>e.code==='EMPLOYEE_INVALID');
 assert.ok(!(await service.employees(manager)).some(e=>e.name==='Legacy'));
});


test('catalog lifecycle validates names, optimistic versions, uniqueness, audit and realtime',async()=>{
 let signals=0;const listener=()=>signals++;events.on('purchase-orders-changed',listener);
 try{
  const e=await service.createEmployee(manager,{name:'  Catalog A  '});assert.equal(e.name,'Catalog A');assert.equal(e.isActive,true);assert.equal(e.version,1);
  await assert.rejects(service.createEmployee(manager,{name:'catalog a'}),e=>e.code==='EMPLOYEE_EXISTS');
  await assert.rejects(service.createEmployee(manager,{name:' '}),e=>e.code==='NAME_INVALID');
  await assert.rejects(service.updateEmployee(manager,e.id,{changes:{name:'B'}}),e=>e.code==='VERSION_REQUIRED');
  await assert.rejects(service.updateEmployee(manager,e.id,{version:99,changes:{name:'B'}}),e=>e.code==='VERSION_CONFLICT');
  await assert.rejects(service.updateEmployee(manager,e.id,{version:1,changes:{isActive:'false'}}),e=>e.code==='VALIDATION_ERROR');
  await assert.rejects(service.updateEmployee(manager,e.id,{version:1,changes:{name:'Dung'}}),e=>e.code==='EMPLOYEE_EXISTS');
  const inactive=await service.updateEmployee(manager,e.id,{version:1,changes:{name:'Catalog B',isActive:false}});assert.equal(inactive.version,2);
  assert.deepEqual((await service.employees(manager)).find(r=>r.id===e.id),inactive);
  await assert.rejects(service.create(manager,{...input(),buyer:'Catalog B'}),e=>e.code==='EMPLOYEE_INVALID');
  await assert.rejects(service.updateEmployee(manager,e.id,{version:1,changes:{isActive:true}}),e=>e.code==='VERSION_CONFLICT');
  const active=await service.updateEmployee(manager,e.id,{version:2,changes:{isActive:true}});assert.equal(active.version,3);
  assert.equal(signals,3);assert.equal((await db.query("SELECT count(*)::int n FROM purchase_history WHERE action IN ('employee_create','employee_edit')")).rows[0].n,3);
  const a=await service.create(manager,{...input(),buyer:active.name});assert.equal(a.buyer,'Catalog B');
  assert.equal(Number((await db.query('SELECT on_hand FROM kiot_test_stock')).rows[0].on_hand),99);
 }finally{events.off('purchase-orders-changed',listener)}
});

test('bulk and plan reject unconfigured or inactive assignments atomically and preserve legacy edits',async()=>{
 const a=await service.create(manager,input()),b=await service.create(manager,{...input(),productCode:'B'});
 const rows=[a,b].map(r=>({id:r.id,version:r.version}));
 await assert.rejects(service.bulkEdit(manager,{rows,changes:{buyer:'Free text'}}),e=>e.code==='EMPLOYEE_INVALID');
 await db.query("UPDATE purchase_employees SET is_active=false WHERE name='Other'");
 await assert.rejects(service.applyPlan(manager,{rows:[{...rows[0],changes:{supplier:'Must rollback'}},{...rows[1],changes:{buyer:'Other'}}]}),e=>e.code==='EMPLOYEE_INVALID');
 await assert.rejects(service.applyPlan(manager,{creates:[{values:{...input(),buyer:'Other'}}]}),e=>e.code==='EMPLOYEE_INVALID');
 assert.equal((await service.latest(manager,'A')).supplier,null);
 await db.query("UPDATE purchase_orders SET buyer='Old buyer' WHERE id=$1",[a.id]);
 await service.applyPlan(manager,{rows:[{...rows[0],changes:{buyer:'Old buyer',supplier:'Still editable'}}]});
 assert.equal((await service.latest(manager,'A')).supplier,'Still editable');
 const result=await service.bulkEdit(manager,{rows:[{id:b.id,version:b.version}],changes:{buyer:'Dung'}});assert.equal(result.results[0].status,'updated');
 assert.equal((await service.latest(manager,'B')).buyer,'Dung');
});

test('imports validate catalog at preview, revision and commit without losing legacy snapshots',async()=>{
 const bad=await service.previewImport(manager,{buffer:await snapshotFile([{...input(),buyer:'Free text'}])});assert.equal(bad.valid,false);assert.equal(bad.counts.error,1);
 await assert.rejects(service.commitImport(manager,bad.token),e=>e.code==='IMPORT_INVALID');
 const revised=await service.reviseImport(manager,bad.token,[{...input(),buyer:'Dung'}]);assert.equal(revised.valid,true);
 await db.query("UPDATE purchase_employees SET is_active=false WHERE name='Dung'");
 await assert.rejects(service.commitImport(manager,bad.token),e=>e.code==='EMPLOYEE_INVALID');assert.equal((await service.list(manager)).rows.length,0);
 await db.query("UPDATE purchase_employees SET is_active=true WHERE name='Dung'");await service.commitImport(manager,bad.token);
 const a=(await service.list(manager)).rows[0];assert.equal(a.buyer,'Dung');assert.equal(a.contId,null);
 await db.query("UPDATE purchase_orders SET buyer='Legacy import' WHERE id=$1",[a.id]);
 const legacy=await service.previewImport(manager,{buffer:await snapshotFile([{...a,buyer:'Legacy import',supplier:'Imported edit'}])});assert.equal(legacy.valid,true);await service.commitImport(manager,legacy.token);
 assert.equal((await service.latest(manager,'A')).buyer,'Legacy import');assert.equal((await service.latest(manager,'A')).supplier,'Imported edit');
 const changed=await service.previewImport(manager,{buffer:await snapshotFile([{...await service.latest(manager,'A'),buyer:'Other'}])});assert.equal(changed.valid,true);
 await db.query("UPDATE purchase_employees SET is_active=false WHERE name='Other'");await assert.rejects(service.commitImport(manager,changed.token),e=>e.code==='EMPLOYEE_INVALID');
 assert.equal((await service.latest(manager,'A')).buyer,'Legacy import');
});

test('direct and plan new products always wait even with a requested container',async()=>{
 const c=await service.createContainer(manager,{name:'WAITING',truckName:'17.5m'});
 const a=await service.create(manager,{...input(),contId:c.id});assert.equal(a.contId,null);
 await service.applyPlan(manager,{creates:[{values:{...input(),productCode:'PLAN',contId:c.id,buyer:'Dung'}}]});
 assert.ok((await service.list(manager)).rows.every(r=>r.contId===null));
});

test('shared container edits propagate dates atomically, recalculate NET and preserve quantities and stock',async()=>{
 const c=await service.createContainer(manager,{name:'SHARED',truckName:'17.5m'});
 const waiting=await service.create(manager,{...input(),productCode:'WAIT'});
 for(const productCode of ['A','B']){const r=await service.create(manager,{...input(),productCode,m3PerCarton:.2,kgPerCarton:3});await service.transfer(manager,{id:r.id,version:r.version,quantity:r.cartonCount,destinationId:c.id})}
 const initial=(await service.list(manager)).rows.filter(r=>r.contId===String(c.id));const rows=initial.map(({id,version})=>({id,version}));
 const physical=initial.map(r=>[r.id,r.cartonCount,r.qtyPerCarton,r.kgPerCarton,r.m3PerCarton]);
 const changed=await service.updateContainer(manager,c.id,{version:c.version,rows,changes:{name:'SHARED RENAMED',truckName:'18.5m',carrier:'Carrier',loader:'Loader',nameCn:'中文',loading:'Tomorrow',arrivalNote:'2026-11-10T09:30',arrivalDate:'2026-11-12',maxTon:35,m3Min:150,m3Max:180,freight:1000000}});
 assert.equal(changed.version,2);assert.equal(changed.truck_name,'18.5m');assert.equal(Number(changed.max_ton),35);
 const updated=(await service.list(manager)).rows.filter(r=>r.contId===String(c.id));assert.deepEqual(updated.map(r=>[r.id,r.cartonCount,r.qtyPerCarton,r.kgPerCarton,r.m3PerCarton]),physical);
 for(const r of updated){assert.equal(r.version,3);assert.equal(r.etaNote,'2026-11-10T09:30');assert.equal(r.arrivedNote,'2026-11-12');assert.equal(r.freightAmount,500000)}
 assert.equal((await service.latest(manager,'WAIT')).version,waiting.version);
 const exported=(await service.exportRows(manager)).filter(r=>r.contId===String(c.id));assert.ok(exported.every(r=>r.container==='SHARED RENAMED'&&r.netPrice===(4000*3920+500000)/2000));
 const projection=(await db.query("SELECT container_name,vietnam_price FROM product_container_lines WHERE product_code IN ('A','B')")).rows;assert.ok(projection.every(r=>r.container_name==='SHARED RENAMED'&&Number(r.vietnam_price)===exported[0].netPrice));
 assert.equal(Number((await db.query('SELECT on_hand FROM kiot_test_stock')).rows[0].on_hand),99);
 const history=(await db.query("SELECT summary FROM purchase_history WHERE action='container_edit'")).rows[0].summary;assert.equal(history.rows.length,2);assert.equal(history.before.name,'SHARED');assert.equal(history.after.name,'SHARED RENAMED');
 assert.equal((await db.query('SELECT count(*)::int n FROM purchase_operation_rows WHERE operation_id=$1',[history.operationId])).rows[0].n,2);
 const versions=updated.map(({id,version})=>({id,version}));
 await service.updateContainer(manager,c.id,{version:changed.version,rows:versions,changes:{arrivalNote:'',arrivalDate:null}});
 assert.ok((await service.list(manager)).rows.filter(r=>r.contId===String(c.id)).every(r=>!r.etaNote&&!r.arrivedNote));
});

test('shared container optimistic conflicts and validation roll back every row, container, audit and event',async()=>{
 const c=await service.createContainer(manager,{name:'ATOMIC',truckName:'17.5m'}),a=await service.create(manager,input());
 const r=(await service.transfer(manager,{id:a.id,version:a.version,quantity:a.cartonCount,destinationId:c.id})).row;
 let signals=0;const listener=()=>signals++;events.on('purchase-orders-changed',listener);
 try{
  const changes={arrivalNote:'2026-11-10',name:'Must not persist'};
  for(const rows of [undefined,[],[{id:r.id,version:1}],[{id:r.id,version:r.version},{id:r.id,version:r.version}]])await assert.rejects(service.updateContainer(manager,c.id,{version:c.version,changes,rows}),e=>e.code==='VERSION_CONFLICT');
  await assert.rejects(service.updateContainer(manager,c.id,{version:999,changes,rows:[r]}),e=>e.code==='VERSION_CONFLICT');
  for(const changes of [{maxTon:0},{m3Min:200,m3Max:100},{truckName:'x'.repeat(81)},{ton:100},{m3:100},{count:1},{arrivalDate:'2026-02-30'},{arrivalNote:'sometime'}])await assert.rejects(service.updateContainer(manager,c.id,{version:c.version,rows:[r],changes}),e=>e.statusCode===400);
  const other=await service.createContainer(manager,{name:'DUPLICATE',truckName:'17.5m'});signals=0;
  await assert.rejects(service.updateContainer(manager,c.id,{version:c.version,rows:[r],changes:{arrivalDate:'2026-11-11',name:other.name}}),e=>e.code==='CONTAINER_EXISTS');
  assert.equal(signals,0);assert.equal((await service.latest(manager,'A')).version,r.version);assert.equal((await service.latest(manager,'A')).arrivedNote,null);
  assert.equal((await db.query('SELECT name,version FROM product_containers WHERE id=$1',[c.id])).rows[0].name,'ATOMIC');
  assert.equal((await db.query("SELECT count(*)::int n FROM purchase_history WHERE action='container_edit'")).rows[0].n,0);
 }finally{events.off('purchase-orders-changed',listener)}
});


test('isolated catalog writes emit only purchase realtime and retain audit',async()=>{
 await db.query('UPDATE purchase_settings SET integration_enabled=false');
 const query=(sql,params)=>db.query(sql,params);let shared=0,purchase=0,projected=0,invalidated=0;
 const isolatedEvents=new EventEmitter();isolatedEvents.on('containersChanged',()=>shared++);isolatedEvents.on('purchase-orders-changed',()=>purchase++);
 const isolated=createPurchaseOrdersService({pool:{query,connect:async()=>({query,release(){}})},events:isolatedEvents,project:async()=>projected++,invalidate:()=>invalidated++});
 const e=await isolated.createEmployee(manager,{name:'Isolated'});await isolated.updateEmployee(manager,e.id,{version:e.version,changes:{isActive:false}});
 assert.deepEqual({shared,purchase,projected,invalidated},{shared:0,purchase:2,projected:0,invalidated:0});
 assert.equal((await db.query("SELECT count(*)::int n FROM purchase_history WHERE action IN ('employee_create','employee_edit')")).rows[0].n,2);
});

test('shared container edits reject membership changed after the editor opened',async()=>{
 const c=await service.createContainer(manager,{name:'MEMBERSHIP',truckName:'17.5m'}),a=await service.create(manager,input()),b=await service.create(manager,{...input(),productCode:'B'});
 const first=(await service.transfer(manager,{id:a.id,version:a.version,quantity:a.cartonCount,destinationId:c.id})).row;
 await service.transfer(manager,{id:b.id,version:b.version,quantity:b.cartonCount,destinationId:c.id});
 await assert.rejects(service.updateContainer(manager,c.id,{version:c.version,rows:[first],changes:{arrivalDate:'2026-11-12'}}),e=>e.code==='VERSION_CONFLICT');
 assert.ok((await service.list(manager)).rows.every(r=>r.arrivedNote===null));
});
