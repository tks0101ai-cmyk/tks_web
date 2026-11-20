'use strict';const {test}=require('node:test');const assert=require('node:assert/strict');const {PGlite}=require('@electric-sql/pglite');const {ensurePurchaseSchema,FILES}=require('./ensurePurchaseSchema');
test('first startup creates only purchase schema and preserves the existing source, rows and earlier migrations',async()=>{const db=new PGlite();try{await db.exec("CREATE TABLE schema_migrations(filename text primary key);INSERT INTO schema_migrations VALUES('0109_stocktake_previous_cancel.sql');CREATE TABLE product_container_lines(id int);INSERT INTO product_container_lines VALUES(7)");const pool={connect:async()=>({query:async(s,p)=>s.includes('CREATE TABLE IF NOT EXISTS')||s.startsWith('--')?(await db.exec(s),{rowCount:0}):db.query(s,p),release(){}})},logger={log(){}};const first=await ensurePurchaseSchema({pool,logger});assert.deepEqual(first.applied,FILES);assert.equal((await db.query('SELECT source_mode FROM purchase_settings')).rows[0].source_mode,'sheets');assert.equal((await db.query('SELECT count(*) FROM purchase_orders')).rows[0].count,0);assert.equal((await db.query('SELECT id FROM product_container_lines')).rows[0].id,7);assert.equal((await db.query('SELECT count(*) FROM schema_migrations')).rows[0].count,1+FILES.length);assert.deepEqual((await ensurePurchaseSchema({pool,logger})).applied,[])}finally{await db.close()}});
test('startup failure rolls back the whole module and does not commit migration markers',async()=>{const calls=[],pool={connect:async()=>({query:async(sql)=>{calls.push(sql);if(sql.startsWith('SELECT 1 FROM schema_migrations'))return {rowCount:0};if(sql.includes('CREATE TABLE IF NOT EXISTS purchase_requests'))throw Error('DDL blocked');return {rowCount:0}},release(){calls.push('release')}})};await assert.rejects(ensurePurchaseSchema({pool}),/DDL blocked/);assert.equal(calls.includes('COMMIT'),false);assert.equal(calls.at(-2),'ROLLBACK');assert.equal(calls.at(-1),'release')});

test('0138 repairs databases where 0137 was applied before its last two columns were added',async()=>{
 const db=new PGlite();try{
  await db.exec("CREATE TABLE schema_migrations(filename text primary key)");
  const pool={connect:async()=>({query:async(sql,params)=>sql.includes('CREATE TABLE IF NOT EXISTS')||sql.startsWith('--')?(await db.exec(sql),{rowCount:0}):db.query(sql,params),release(){}})},logger={log(){}};
  await ensurePurchaseSchema({pool,logger});
  const region=(await db.query("INSERT INTO purchase_regions(name,name_key) VALUES('H','h') RETURNING id")).rows[0];
  await db.query("UPDATE purchase_settings SET waiting_freight=1234 WHERE id=1");
  await db.exec('DROP TABLE purchase_waiting_configs; ALTER TABLE purchase_settings DROP COLUMN waiting_assumed_m3, DROP COLUMN waiting_container_fx_rate; DELETE FROM schema_migrations WHERE filename=\'0138_purchase_waiting_region_freight.sql\'');
  const result=await ensurePurchaseSchema({pool,logger});
  assert.deepEqual(result.applied,['0138_purchase_waiting_region_freight.sql']);
  assert.ok((await db.query("SELECT 1 FROM information_schema.columns WHERE table_name='purchase_settings' AND column_name='waiting_assumed_m3'")).rowCount);
  assert.equal((await db.query('SELECT freight FROM purchase_waiting_configs WHERE region_id=$1',[region.id])).rows[0].freight,'1234');
 }finally{await db.close()}
});


test('employee migration seeds distinct legacy names without HR or row rewrites and reruns safely',async()=>{
 const fs=require('node:fs'),path=require('node:path'),db=new PGlite();try{
  await db.exec("CREATE TABLE purchase_orders(id int, buyer text);INSERT INTO purchase_orders VALUES(1,' Dung '),(2,'Dung'),(3,'Legacy'),(4,NULL),(5,'')");
  const migration=fs.readFileSync(path.join(__dirname,'migrations/0119_purchase_employees.sql'),'utf8');
  await db.exec(migration);await db.exec(migration);
  const catalog=(await db.query('SELECT name,is_active,version FROM purchase_employees ORDER BY name')).rows;
  assert.deepEqual(catalog,[{name:'Dung',is_active:true,version:1},{name:'Legacy',is_active:true,version:1}]);
  assert.equal((await db.query('SELECT buyer FROM purchase_orders WHERE id=1')).rows[0].buyer,' Dung ');
  assert.equal((await db.query("SELECT to_regclass('hr_employees') t")).rows[0].t,null);
  // Moi migration Thu mua moi phai duoc dang ky trong FILES, neu khong PGlite trong test va
  // ensurePurchaseSchema tren may chu se chay thieu. Kiem tra theo thu muc thay vi ghim mot ten:
  // ghim ten lam dong nay do moi lan them migration (0135 them vao 16/11 ma quen sua cho nay).
  const onDisk=fs.readdirSync(path.join(__dirname,'migrations')).filter(name=>/_purchase_.*\.sql$/.test(name)&&name>='0110').sort();
  assert.deepEqual([...FILES].sort(),onDisk,'FILES phai liet ke du moi migration Thu mua tren dia');
 }finally{await db.close()}
});
