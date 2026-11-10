'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {SHEET_NAMES}=require('../productContainers/parser');
const {prepareLegacySheets,readLegacySheets}=require('./prepareLegacySheets');
function source(name){const cells=Array(24).fill('');Object.assign(cells,{0:'SAME-CODE',1:'Hàng thử',12:10,13:2,14:20,15:1.5,23:3000});return {name,values:[['CONT '+name,'2.Chưa bốc'],cells]};}
test('one-time preparation retains all seven streams, repeated product codes and original cells',()=>{
 const input=SHEET_NAMES.map(source).reverse(),out=prepareLegacySheets(input);
 assert.deepEqual(Object.keys(out.counts),SHEET_NAMES);
 assert.deepEqual(out.rows.map(r=>r.sourceSheet),SHEET_NAMES);
 assert.equal(new Set(out.rows.map(r=>r.rowKey)).size,7);
 assert.ok(out.rows.every(r=>r.sourceRow===2&&r.code==='SAME-CODE'));
 assert.equal(out.rows[0].sourceQuantity,20);assert.equal(out.rows[0].sourceVietnamPrice,3000);
 assert.equal(out.rawSheets[0].values[1][1],'Hàng thử');assert.deepEqual(out.issues,[]);
});
test('legacy quantities that cannot be edited as canonical orders are reported instead of rounded',()=>{
 const input=SHEET_NAMES.map(source);input[0].values[1][13]=1.5;
 const out=prepareLegacySheets(input);
 assert.equal(out.rows[0].cartonCount,1.5);
 assert.ok(out.issues.some(i=>i.code==='ORDER_FIELDS_REQUIRE_REVIEW'));
 assert.ok(out.issues.some(i=>i.code==='QUANTITY_MISMATCH'));
});
test('missing sheets and failed reads cannot produce a partial snapshot',async()=>{
 assert.throws(()=>prepareLegacySheets(SHEET_NAMES.slice(1).map(source)),/7 sheet/);
 const client={listSheetTitles:async()=>SHEET_NAMES,getValues:async name=>{if(name==='SD')throw Error('unavailable');return source(name).values}};
 await assert.rejects(readLegacySheets(client),/Chưa đọc đủ 7 sheet/);
});
