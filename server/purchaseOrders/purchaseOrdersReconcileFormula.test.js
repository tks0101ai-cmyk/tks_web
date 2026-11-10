'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {reconcile}=require('./purchaseOrdersReconcile');
const C=require('../public/shared/purchase-calculations');
const base={rowKey:'D00001',productCode:'A',contId:'1',cartonCount:4,qtyPerCarton:300,unitPriceCny:1.35,kgPerCarton:10,m3PerCarton:.1};
const snapshot=rows=>({containers:[{id:'1',name:'CONT A',status:1}],rows});
for(const [label,value,expected] of [['omitted',undefined,1620],['null',null,1620],['empty','',1620],['whitespace','  ',1620],['zero',0,1620],['positive',10,1630],['negative',-23,1597]]){
 test('reconcile totals match shared row for '+label+' prepaid',()=>{
  const row={...base,freightPrepaid:value};if(label==='omitted')delete row.freightPrepaid;
  const input=snapshot([row]),before=structuredClone(input),result=reconcile(input,structuredClone(input));
  assert.equal(C.row(row).totalCny,expected);
  for(const totals of [result.sheetTotals,result.webTotals]){assert.equal(totals['CONT A'].totalCny,expected);assert.equal(totals['CONT A'].missing,0);}
  assert.equal(result.match,true);assert.deepEqual(result.problems,[]);assert.deepEqual(input,before);
 });
}
for(const key of ['qtyPerCarton','cartonCount','unitPriceCny'])for(const value of [undefined,null,'']){
 test('reconcile refuses to invent totals for missing '+key+' '+String(value),()=>{
  const row={...base,freightPrepaid:null,[key]:value},input=snapshot([row]),result=reconcile(input,input);
  assert.equal(C.row(row).totalCny,null);assert.equal(result.sheetTotals['CONT A'].totalCny,0);
  assert.ok(result.sheetTotals['CONT A'].missing>0);assert.ok(result.problems.some(p=>p.code==='INCOMPLETE_TOTALS'));assert.equal(result.match,false);
 });
}
test('reconcile aggregates signed prepaid and preserves field-level differences',()=>{
 const rows=[{...base,freightPrepaid:null},{...base,rowKey:'D00002',freightPrepaid:-23},{...base,rowKey:'D00003',freightPrepaid:10}];
 const other=structuredClone(rows);other[0].freightPrepaid=0;
 const result=reconcile(snapshot(rows),snapshot(other));
 assert.equal(result.sheetTotals['CONT A'].totalCny,C.sum(rows.map(r=>C.row(r).totalCny)));
 assert.equal(result.sheetTotals['CONT A'].totalCny,4847);assert.equal(result.webTotals['CONT A'].totalCny,4847);
 assert.equal(result.problems.length,0);assert.equal(result.match,false);
 assert.deepEqual(result.differences,[{rowKey:'D00001',field:'freightPrepaid',sheet:null,web:0}]);
});
test('reconcile still flags invalid prepaid and missing measurements',()=>{
 for(const changes of [{freightPrepaid:'bad'},{freightPrepaid:null,kgPerCarton:null},{freightPrepaid:null,m3PerCarton:null}]){
  const input=snapshot([{...base,...changes}]),result=reconcile(input,input);
  assert.equal(result.match,false);assert.ok(result.problems.some(p=>p.code==='INCOMPLETE_TOTALS'));
 }
});
