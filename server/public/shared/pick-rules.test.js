'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const rules=require('./pick-rules');
test('fractional pieces allowed; non-positive/non-finite rejected; whole-carton excess preserved',()=>{
  const locations=[{id:'1',code:'A',location:'A01',available:100,perCarton:100}];
  for(const quantity of [0.4,0.6]){
    assert.deepEqual(rules.validate([{productCode:'A',quantity}],locations,[[{id:'1',quantity}]]),[]);
  }
  for(const quantity of [0,-1,Infinity,NaN,2e12]){
    assert.ok(rules.validate([{productCode:'A',quantity}],locations,[[{id:'1',quantity}]]).length);
  }
  assert.deepEqual(rules.validate([{productCode:'A',quantity:30}],locations,[[{id:'1',quantity:100}]]),[]);
});
