const {test}=require('node:test');
const assert=require('node:assert/strict');
const Freight=require('./purchase-freight');

test('container formula divides by assumed m3 and allocates its rate to current rows',()=>{
 const c={id:7,freightMode:'formula',freightFormula:'=(195000000+4*500*3930)/M3_XE',assumedM3:170};
 const rows=[{id:1,contId:7,m3PerCarton:.5,cartonCount:4},{id:2,contId:7,m3PerCarton:.25,cartonCount:4}];
 const formula=Freight.calculate(c,3);
 assert.ok(Math.abs(formula.rate-1193294.1176470588)<1e-7);
 assert.equal(formula.amount,202860000);
 const rates=Freight.rates(rows,[c]);
 assert.equal(Freight.rowAmount(rows[0],rates),2386588.2352941176);
 assert.equal(Freight.rowAmount(rows[1],rates),1193294.1176470588);
 assert.equal(Freight.calculate(c,4).amount,202860000);
 const actualOnly=Freight.calculate({...c,assumedM3:null},3);
 assert.equal(actualOnly.amount,202860000);
 assert.equal(Freight.calculate({...c,assumedM3:null},4).amount,202860000);
});

test('spreadsheet total freight formulas divide by assumed m3 first and actual m3 after clearing it',()=>{
 const formula='=(195000000+4*500*3920)/170*D2',estimated={freightMode:'formula',freightFormula:formula,assumedM3:170},volume=140;
 const withEstimate=Freight.calculate(estimated,volume);
 assert.ok(Math.abs(withEstimate.amount-167044706)<1);
 assert.ok(Math.abs(withEstimate.rate-982615.9169550174)<1e-7);
 const actual=Freight.calculate({...estimated,assumedM3:null},volume);
 assert.ok(Math.abs(actual.amount-167044706)<1);
 assert.ok(Math.abs(actual.rate-1193176.4705882354)<1e-7);
});
test('a total-cost expression displays and allocates against assumed volume before stacked volume',()=>{
 const cost=195000000+4*500*3920,container={freightMode:'formula',freightFormula:'=(195000000+4*500*3920)',assumedM3:170};
 const estimated=Freight.calculate(container,150);
 assert.equal(estimated.amount,cost);assert.equal(estimated.rate,cost/170);
 const actual=Freight.calculate({...container,assumedM3:null},150);
 assert.equal(actual.amount,cost);assert.equal(actual.rate,cost/150);
});
test('invalid stored container formulas produce no freight rate',()=>{
 const fee=Freight.calculate({freightMode:'formula',freightFormula:'=M3_CONT/0',freightCapacity:170},10);
 assert.equal(fee.rate,null);
 assert.equal(fee.amount,null);
});

test('manual container freight divides by assumed m3 first and actual stacked m3 after clearing it',()=>{
 const rows=[{contId:1,cartonCount:2,m3PerCarton:2},{contId:1,cartonCount:2,m3PerCarton:4}],container={id:1,freightMode:'manual',freight:1200,assumedM3:100};let rates=Freight.rates(rows,[container]);
 assert.equal(rates.get('1'),12);assert.deepEqual(rows.map(r=>Freight.rowAmount(r,rates)),[48,96]);
 const actual=Freight.calculate({...container,assumedM3:null},12);assert.equal(actual.rate,100);rates=Freight.rates(rows,[{...container,assumedM3:null}]);assert.equal(rates.get('1'),100);assert.deepEqual(rows.map(r=>Freight.rowAmount(r,rates)),[400,800]);
});

test('manual assumed volume still provides a rate for measured lines when another line lacks m3',()=>{
 const rows=[{contId:1,cartonCount:2,m3PerCarton:2},{contId:1,cartonCount:1,m3PerCarton:null}],rates=Freight.rates(rows,[{id:1,freightMode:'manual',freight:1000,assumedM3:100}]);
 assert.equal(rates.get('1'),10);assert.equal(Freight.rowAmount(rows[0],rates),40);assert.equal(Freight.rowAmount(rows[1],rates),null);
});
