'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {FILES}=require('../db/ensurePurchaseSchema');
const {projectContainers}=require('./purchaseOrdersProjection');
const {createPurchaseOrdersService}=require('./purchaseOrdersService');
const C=require('../public/shared/purchase-calculations');
let db,service;
before(async()=>{
 db=new PGlite();
 for(const name of ['0053_product_containers.sql','0072_product_container_unit_price_cny.sql','0075_product_container_expected.sql','0078_product_container_expected_prices.sql','0086_product_container_other_note.sql',...FILES])await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations',name),'utf8'));
 await db.exec('CREATE TABLE shipping_measures(code_key text PRIMARY KEY, per_carton numeric, m3_per_unit numeric, kg_per_unit numeric)');
 await db.exec("CREATE TABLE product_report(product_code text,product_name text);CREATE TABLE products(code text,name text);UPDATE purchase_settings SET source_mode='web',projection_owns_all=true,integration_enabled=true");
 const query=(sql,params)=>db.query(sql,params);
 service=createPurchaseOrdersService({pool:{query,connect:async()=>({query,release(){}})}});
});
after(async()=>db?.close());
test('projectContainers and exportRows agree for optional signed prepaid and missing required inputs',async()=>{
 const cases=[['omitted',undefined],['null',null],['empty',''],['zero',0],['positive',10],['negative',-23],['missing-price',null,'unitPriceCny'],['missing-postpaid',null,'freightPostpaid'],['zero-price',null,null,0]];
 const expected=new Map();
 for(const [label,prepaid,missing,price=1.35] of cases){
  const row={qtyPerCarton:300,cartonCount:4,unitPriceCny:price,freightPostpaid:20,fxRate:3920,m3PerCarton:.073};
  row.surchargePercent=label==='zero-price'?.05:0;
  if(label!=='omitted')row.freightPrepaid=prepaid;
  if(missing)row[missing]=null;
  const total=missing&&missing!=='freightPostpaid'?null:1200*price+(Number(prepaid)||0);
  expected.set(label,{total,row});
  // Empty and omitted numeric fields reach PostgreSQL as NULL via the existing shared parser.
  await db.query('INSERT INTO purchase_orders(row_key,root_key,product_code,product_name,qty_per_carton,carton_count,unit_price_cny,freight_prepaid,freight_postpaid,fx_rate,m3_per_carton,surcharge_percent) VALUES($9,$9,$1,$1,$2,$3,$4,$5,$6,$7,$8,$10)',[label,row.qtyPerCarton,row.cartonCount,row.unitPriceCny,C.number(row.freightPrepaid),row.freightPostpaid,row.fxRate,row.m3PerCarton,'D'+String(expected.size).padStart(5,'0'),row.surchargePercent]);
 }
 await db.exec('BEGIN');
 try{await projectContainers({query:(sql,params)=>/CREATE TEMP/.test(sql)?db.exec(sql):db.query(sql,params)});await db.exec('COMMIT');}catch(e){await db.exec('ROLLBACK');throw e;}
 const exported=await service.exportRows({id:'manager'});
 const projected=(await db.query("SELECT product_code,vietnam_price FROM product_container_lines WHERE sheet_name='THU MUA'")).rows;
 assert.equal(exported.length,cases.length);assert.equal(projected.length,cases.length);
 for(const [label,{total,row}] of expected){
  const out=exported.find(r=>r.productCode===label),sql=projected.find(r=>r.product_code===label);
  assert.equal(out.totalCny,total,label+' totalCny');assert.equal(out.goodsAmount,total==null?null:total*3920,label+' goodsAmount');
  if(total==null){assert.equal(out.netPrice,null,label);assert.equal(sql.vietnam_price,null,label);}
  else{const net=(total*3920+(out.freightAmount||0)+(Number(row.freightPostpaid)||0)*3920)/1200;assert.equal(out.netPrice,net,label);assert.ok(Math.abs(Number(sql.vietnam_price)-net)<1e-7,label+' SQL parity');}
 }
});
