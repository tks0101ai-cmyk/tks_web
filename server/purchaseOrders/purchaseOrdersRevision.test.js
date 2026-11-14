const {test}=require('node:test'),assert=require('node:assert/strict');
const {PGlite}=require('@electric-sql/pglite');
const {createPurchaseOrdersService}=require('./purchaseOrdersService');
test('list revision detects empty history, late lower id and history deletion',async()=>{
 const db=new PGlite();try{
 await db.exec("CREATE TABLE purchase_settings(id int,source_mode text,integration_enabled boolean); INSERT INTO purchase_settings VALUES(1,'web',false); CREATE TABLE product_containers(id bigint); CREATE TABLE purchase_regions(id bigint,name text,color text,is_active boolean,version int); CREATE TABLE purchase_orders(id bigint,product_code text,deleted_at timestamptz,inactive_at timestamptz); CREATE TABLE purchase_history(id bigint PRIMARY KEY); CREATE TABLE shipping_measures(code_key text PRIMARY KEY,per_carton numeric,m3_per_unit numeric,kg_per_unit numeric)");
 const query=(sql,args)=>db.query(sql,args),service=createPurchaseOrdersService({pool:{query,connect:async()=>({query,release(){}})}}),user={id:'u'};
 assert.equal((await service.list(user)).revision,'0:0');assert.deepEqual(await service.revision(user),{revision:'0:0'});
 await db.exec('INSERT INTO purchase_history VALUES(9)');assert.equal((await service.list(user)).revision,'9:1');
 await db.exec('INSERT INTO purchase_history VALUES(4)');assert.equal((await service.list(user)).revision,'9:2');assert.deepEqual(await service.revision(user),{revision:'9:2'});
 await db.exec('DELETE FROM purchase_history WHERE id=4');assert.equal((await service.list(user)).revision,'9:1');
 await assert.rejects(service.list(null),e=>e.code==='AUTH_REQUIRED');
 }finally{await db.close()}
});
test('list reads revision before table data so concurrent commits cannot label old containers as current',async()=>{
 const queries=[];let revision='1:1';
 const client={async query(sql){queries.push(sql);if(sql.includes('AS version'))return {rows:[{version:revision}]};if(sql.includes('purchase_settings'))return {rows:[{source_mode:'web'}]};if(sql.includes('product_containers')){revision='2:2';return {rows:[]}}return {rows:[]}},release(){}};
 const service=createPurchaseOrdersService({pool:{connect:async()=>client}}),snapshot=await service.list({id:'u'});
 assert.equal(snapshot.revision,'1:1');assert.ok(queries.findIndex(sql=>sql.includes('AS version'))<queries.findIndex(sql=>sql.includes('product_containers')));
});
test('revision authenticates before querying and reads only the history fingerprint',async()=>{
 const queries=[],pool={async query(sql){queries.push(sql);return {rows:[{version:'9007199254740993:2'}]}}};
 const service=createPurchaseOrdersService({pool});await assert.rejects(service.revision(null),e=>e.code==='AUTH_REQUIRED');assert.equal(queries.length,0);
 assert.deepEqual(await service.revision({id:'reader'}),{revision:'9007199254740993:2'});assert.equal(queries.length,1);assert.match(queries[0],/max\(id\)/);assert.match(queries[0],/count\(\*\)/);assert.match(queries[0],/FROM purchase_history/);
});
