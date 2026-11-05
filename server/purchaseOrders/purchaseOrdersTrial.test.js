'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {FILES}=require('../db/ensurePurchaseSchema');
const {createPurchaseTrial,trialPool}=require('./purchaseOrdersTrial');
const {dashboardRollupEvents}=require('../kiotvietSync/dashboardRollupEvents');
const manager={id:'trial-manager',hoTen:'Người thử',vaiTro:'Quản lý'};
const input=code=>({productCode:code,productName:'Hàng thử '+code,qtyPerCarton:10,cartonCount:5,unitPriceCny:2,fxRate:3920,freightPrepaid:0,freightPostpaid:0,kgPerCarton:10,m3PerCarton:.1,listedAt:'2026-11-05'});
let trial,state,db,source;
before(async()=>{
 db=new PGlite();for(const file of FILES)await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',file),'utf8'));
 await db.exec("CREATE TABLE production_only(marker text); INSERT INTO production_only VALUES('keep'); CREATE TABLE product_container_lines(marker text); INSERT INTO product_container_lines VALUES('real'); CREATE TABLE product_container_expected(marker text); INSERT INTO product_container_expected VALUES('real')");
 let tail=Promise.resolve();
 const query=async(sql,args)=>{const r=args?await db.query(sql,args):(await db.exec(sql)).at(-1);return {...r,rowCount:r.rows?.length||r.affectedRows||0}};
 async function connect(){const prior=tail;let release;tail=new Promise(resolve=>{release=resolve});await prior;return {query,release}};
 source={connect,async query(sql,args){const c=await connect();try{return await c.query(sql,args)}finally{c.release()}}};
 trial=createPurchaseTrial({pool:source});state=await trial.state();
});
after(async()=>db?.close());

test('trial writes affect only its schema and never publish production events',async()=>{
 const listed=await state.service.list(manager);assert.equal(listed.sourceMode,'web');assert.equal(listed.rows.length,12);
 let published=0;const listener=()=>published++;dashboardRollupEvents.on('purchase-orders-changed',listener);
 try{assert.equal((await state.service.create(manager,input('TRIAL-ONLY'))).productCode,'TRIAL-ONLY')}
 finally{dashboardRollupEvents.off('purchase-orders-changed',listener)}
 assert.equal(published,0);
 assert.equal((await source.query('SELECT source_mode FROM public.purchase_settings')).rows[0].source_mode,'sheets');
 assert.equal((await source.query('SELECT count(*)::int n FROM public.purchase_orders')).rows[0].n,0);
 assert.equal((await source.query('SELECT count(*)::int n FROM public.product_containers')).rows[0].n,0);
 assert.equal((await source.query('SELECT marker FROM public.product_container_lines')).rows[0].marker,'real');
 assert.equal((await source.query('SELECT marker FROM public.product_container_expected')).rows[0].marker,'real');
});

test('trial lookup fails closed and released pool connections regain their original schema',async()=>{
 await assert.rejects(state.pool.query('SELECT * FROM production_only'),e=>e.code==='42P01');
 assert.match((await source.query('SHOW search_path')).rows[0].search_path,/public/);
 assert.equal((await source.query('SELECT marker FROM production_only')).rows[0].marker,'keep');
});

test('a connection that cannot reset its schema is destroyed instead of returned to production',async()=>{
 const resetError=Object.assign(new Error('reset failed'),{code:'TEST_RESET'});let released;
 const pool=trialPool({async connect(){return {async query(sql){if(sql==='RESET search_path')throw resetError;return {rows:[]}},release(error){released=error}}}});
 const client=await pool.connect();await client.release();assert.equal(released,resetError);
});

test('concurrent trial writes have distinct keys and isolated audit operations',async()=>{
 const rows=await Promise.all(Array.from({length:6},(_,i)=>state.service.create(manager,input('PARALLEL-'+i))));
 assert.equal(new Set(rows.map(r=>r.rowKey)).size,6);
 const captured=await state.pool.query('SELECT operation_id,count(*)::int n FROM purchase_operation_rows WHERE row_id=ANY($1::bigint[]) GROUP BY operation_id',[rows.map(r=>r.id)]);
 assert.equal(captured.rows.length,6);assert.ok(captured.rows.every(r=>r.n===1));
});

test('trial uses real update, delete, restore and undo behavior',async()=>{
 const row=await state.service.create(manager,input('EDIT-TRIAL'));
 const updated=await state.service.update(manager,row.id,{version:row.version,changes:{cartonCount:8}});assert.equal(updated.cartonCount,8);
 await state.service.undo(manager,{operationId:updated.operationId});
 const current=(await state.service.list(manager)).rows.find(r=>r.id===row.id);assert.equal(current.cartonCount,5);
 await state.service.remove(manager,{rows:[{id:current.id,version:current.version}]});
 const deleted=(await state.service.trash(manager)).find(r=>r.id===row.id);assert.ok(deleted);
 await state.service.restore(manager,{id:deleted.id,version:deleted.version});assert.ok((await state.service.list(manager)).rows.some(r=>r.id===row.id));
});

test('unauthorized trial requests cannot initialize or connect to its store',async t=>{
 let connected=0;const privateTrial=createPurchaseTrial({pool:{async connect(){connected++;throw Error('Must not connect')}},requireAuth:(req,res)=>res.status(401).json({error:'Đăng nhập'})});
 const app=express();app.use(privateTrial.router);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>server.close());
 assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/purchase-trial')).status,401);assert.equal(connected,0);
});

test('router keeps its own API root and reinitializing never resets edited sample containers',async t=>{
 const container=(await state.service.list(manager)).containers[0];await state.service.changeStatus(manager,{containerId:container.id,version:container.version,status:1});
 const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=manager;next()});const routed=createPurchaseTrial({pool:source,requireAuth:(_req,_res,next)=>next()});app.use(routed.router);
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
 const response=await fetch(base+'/api/purchase-trial');assert.equal(response.status,200);const data=await response.json();assert.equal(data.trialMode,true);assert.equal(data.containers.find(c=>c.id===container.id).status,1);
 assert.equal((await fetch(base+'/api/purchase-orders')).status,404);
});

test('a failed first seed rolls back trial changes and releases the connection safely',async()=>{
 const before=(await source.query('SELECT id,status FROM purchase_trial.product_containers ORDER BY id')).rows;
 await source.query("DELETE FROM purchase_trial.schema_migrations WHERE filename='trial_sample_v1'");
 const failing=createPurchaseTrial({pool:{async connect(){const client=await source.connect();return {
  query(sql,args){if(/INSERT INTO purchase_orders/.test(sql))throw Object.assign(new Error('seed failure'),{code:'TEST_SEED'});return client.query(sql,args)},
  release(error){client.release(error)}
 }}}});
 await assert.rejects(failing.state(),e=>e.code==='PURCHASE_TRIAL_UNAVAILABLE'&&e.statusCode===503);
 assert.deepEqual((await source.query('SELECT id,status FROM purchase_trial.product_containers ORDER BY id')).rows,before);
 assert.match((await source.query('SHOW search_path')).rows[0].search_path,/public/);
 assert.equal((await source.query('SELECT count(*)::int n FROM public.purchase_orders')).rows[0].n,0);
});

test('a reserved row key survives the save while unknown, reused or malformed keys are refused',async()=>{
 // Dat cho truoc o popup roi dung lai dung khoa do khi luu.
 const reserved=(await state.service.reserveKey()).rowKey;
 assert.match(reserved,/^D\d{5}$/);
 const created=await state.service.create(manager,{...input('KEY-KEEP'),rowKey:reserved});
 assert.equal(created.rowKey,reserved,'khoa dat cho phai duoc giu nguyen, khong sinh so khac');

 // Dung lai chinh khoa vua ghi: phai tu choi chu khong am tham cap khoa moi.
 await assert.rejects(()=>state.service.create(manager,{...input('KEY-REUSE'),rowKey:reserved}),/lạ hoặc đã dùng/);
 // Khoa chua tung phat ra tu sequence.
 await assert.rejects(()=>state.service.create(manager,{...input('KEY-AHEAD'),rowKey:'D99999'}),/lạ hoặc đã dùng/);
 // Khoa sai dang.
 for(const bad of ['XYZ','D1','D000001','d00001','D0000A'])
   await assert.rejects(()=>state.service.create(manager,{...input('KEY-BAD'),rowKey:bad}),/Khóa dòng/);
 // Chuoi rong = khong gui khoa, phai tu sinh chu khong bao loi.
 for(const blank of ['','   ',null])
   assert.match((await state.service.create(manager,{...input('KEY-BLANK'),rowKey:blank})).rowKey,/^D\d{5}$/);

 // Khoa da nghi (nam trong purchase_key_history sau khi tach) khong duoc dung lai.
 const retired=(await state.service.reserveKey()).rowKey;
 await source.query('INSERT INTO purchase_trial.purchase_key_history(row_key,order_id,root_key) VALUES($1,$2,$1)',[retired,created.id]);
 await assert.rejects(()=>state.service.create(manager,{...input('KEY-RETIRED'),rowKey:retired}),/lạ hoặc đã dùng/);

 // Khong gui khoa thi van tu sinh nhu truoc, giu nguyen duong import.
 const auto=await state.service.create(manager,input('KEY-AUTO'));
 assert.match(auto.rowKey,/^D\d{5}$/);
 assert.notEqual(auto.rowKey,reserved);
});
