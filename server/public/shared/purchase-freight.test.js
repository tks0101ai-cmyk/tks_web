const {test}=require('node:test');
const assert=require('node:assert/strict');
const Freight=require('./purchase-freight');

test('container formula recalculates total freight from current volume and allocates it back to rows',()=>{
 const c={id:7,freightMode:'formula',freightFormula:'=(195000000+4*500*3930)/M3_XE*M3_CONT',freightCapacity:170};
 const rows=[{id:1,contId:7,m3PerCarton:.5,cartonCount:4},{id:2,contId:7,m3PerCarton:.25,cartonCount:4}];
 const formula=Freight.calculate(c,3);
 assert.ok(Math.abs(formula.rate-1193294.1176470588)<1e-7);
 assert.equal(formula.amount,3579882);
 const rates=Freight.rates(rows,[c]);
 assert.equal(Freight.rowAmount(rows[0],rates),2386588.2352941176);
 assert.equal(Freight.rowAmount(rows[1],rates),1193294.1176470588);
 assert.equal(Freight.calculate(c,4).amount,4773176);
});

test('invalid stored container formulas produce no freight rate',()=>{
 const fee=Freight.calculate({freightMode:'formula',freightFormula:'=M3_CONT/0',freightCapacity:170},10);
 assert.equal(fee.rate,null);
 assert.equal(fee.amount,null);
});
