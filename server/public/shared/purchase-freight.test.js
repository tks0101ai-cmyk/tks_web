const {test}=require('node:test');
const assert=require('node:assert/strict');
const Freight=require('./purchase-freight');

test('container formula divides by assumed m3 and allocates its rate to current rows',()=>{
 const c={id:7,freightMode:'formula',freightFormula:'=(195000000+4*500*3930)/M3_XE',assumedM3:170};
 const rows=[{id:1,contId:7,m3PerCarton:.5,cartonCount:4},{id:2,contId:7,m3PerCarton:.25,cartonCount:4}];
 const formula=Freight.calculate(c,3);
 assert.ok(Math.abs(formula.rate-1193294.1176470588)<1e-7);
 assert.equal(formula.amount,1193294);
 const rates=Freight.rates(rows,[c]);
 assert.equal(Freight.rowAmount(rows[0],rates),2386588.2352941176);
 assert.equal(Freight.rowAmount(rows[1],rates),1193294.1176470588);
 assert.equal(Freight.calculate(c,4).amount,1193294);
 const actualOnly=Freight.calculate({...c,assumedM3:null},3);
 assert.equal(actualOnly.amount,67620000);
 assert.equal(Freight.calculate({...c,assumedM3:null},4).amount,50715000);
});

test('invalid stored container formulas produce no freight rate',()=>{
 const fee=Freight.calculate({freightMode:'formula',freightFormula:'=M3_CONT/0',freightCapacity:170},10);
 assert.equal(fee.rate,null);
 assert.equal(fee.amount,null);
});
