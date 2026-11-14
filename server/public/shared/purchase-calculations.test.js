const {test}=require('node:test');const assert=require('node:assert/strict');const C=require('./purchase-calculations');
const row={qtyPerCarton:300,cartonCount:4,unitPriceCny:1.35,freightPrepaid:10,freightPostpaid:20,fxRate:3920,kgPerCarton:13.8,m3PerCarton:.073,literWarehouse:.25,gramWarehouse:46};
test('canonical row formulas include prepaid, postpaid, allocated freight and surcharge on Tiền hàng',()=>{const d=C.row({...row,surchargePercent:.02},292000);assert.equal(d.totalQty,1200);assert.equal(d.totalCny,1630);assert.equal(d.goodsAmount,6389600);assert.equal(d.surchargeAmount,127792);assert.equal(d.totalTon,.0552);assert.equal(d.totalM3,.292);assert.equal(d.netPrice,(6389600+292000+127792+78400)/1200);assert.ok(Math.abs(d.literDiff-(d.literChina-.25)/.25)<1e-14);assert.equal(d.gramDiff,0)});
test('missing and zero have different meanings and no division creates NaN',()=>{for(const blank of [null,undefined,'']){const d=C.row({...row,freightPrepaid:blank},100);assert.equal(d.totalCny,1620);assert.equal(d.goodsAmount,6350400);assert.equal(d.netPrice,(6350400+100+78400)/1200)}assert.equal(C.row({...row,unitPriceCny:0,freightPrepaid:0,freightPostpaid:0},0).netPrice,0);for(const k of ['qtyPerCarton','cartonCount','kgPerCarton','m3PerCarton','fxRate','literWarehouse']){const d=C.row({...row,[k]:0},0);assert.ok(Object.values(d).every(v=>v==null||Number.isFinite(v)))}assert.equal(C.row({...row,m3PerCarton:0},null).totalM3,null);assert.equal(C.row({...row,fxRate:0},0).netPrice,null)});
test('decimal operations retain small quantities and do not round intermediate prices',()=>{assert.equal(C.mul(.1,3),.3);assert.equal(C.add(.1,.2),.3);assert.equal(C.row({...row,m3PerCarton:.000001,cartonCount:3},0).totalM3,.000003);assert.equal(C.row({...row,unitPriceCny:1.23456},0).totalCny,1491.472)});
test('NET includes a CNY surcharge percentage and postpaid uses 3920',()=>{const input={...row,qtyPerCarton:1,cartonCount:1,unitPriceCny:1,freightPrepaid:0,freightPostpaid:2,fxRate:5000,surchargePercent:.07};const d=C.row(input,null);assert.equal(d.surchargeAmount,350);assert.equal(d.netPrice,(5000+350+2*3920));assert.equal(C.row({...input,freightPostpaid:null,surchargePercent:null},null).netPrice,5000)});
test('surcharge is a percentage of the Tiền hàng column and NET remains a separate total',()=>{const d=C.row({...row,qtyPerCarton:1,cartonCount:2,unitPriceCny:100,freightPrepaid:10,freightPostpaid:5,fxRate:2,surchargePercent:.1},20);assert.equal(d.goodsAmount,420);assert.equal(d.surchargeAmount,42);assert.equal(d.netPrice,(420+20+42+5*3920)/2)});
test('unsafe quantities, negative amounts, invalid exchange rates and overflowing products are reported',()=>{assert.ok(C.issues({...row,cartonCount:1.5}).includes('cartonCount'));assert.ok(C.issues({...row,unitPriceCny:-1}).includes('unitPriceCny'));assert.ok(C.issues({...row,fxRate:0}).includes('fxRate'));assert.ok(C.issues({...row,cartonCount:Number.MAX_SAFE_INTEGER}).includes('totalQty'));assert.equal(C.mul(Number.MAX_SAFE_INTEGER,2),null);assert.equal(C.divide(1,0),null)});

test('grouped numeric text is unambiguous and small scientific numeric values stay valid',()=>{assert.equal(C.parse('1,234.56'),1234.56);assert.equal(C.parse('0'),0);assert.equal(C.parse(''),null);for(const v of ['1,23','1.234,56','1,2,3','0x10','Infinity'])assert.ok(Number.isNaN(C.parse(v)));assert.equal(C.mul(.0000001,3),.0000003)});
test('container totals include only known measurements and flag unfinished split quantities',()=>{const s=C.stats([{cartonCount:3,kgPerCarton:100,m3PerCarton:.1},{cartonCount:null,kgPerCarton:10,m3PerCarton:.2}]);assert.deepEqual(s,{count:2,ton:.3,m3:.3,missing:1})});

test('large valid NET numerators and unit conversions are divided before checking output bounds',()=>{const r={...row,qtyPerCarton:10,cartonCount:1,unitPriceCny:1,freightPrepaid:0,freightPostpaid:0,fxRate:1};assert.equal(C.row(r,Number.MAX_SAFE_INTEGER).netPrice,(Number.MAX_SAFE_INTEGER+10)/10);assert.notEqual(C.row({...r,kgPerCarton:Number.MAX_SAFE_INTEGER},0).totalTon,null)});

// VC truoc (已付) la cot duy nhat duoc phep am: nguon TKS dung so am lam khoan
// giam tru. Ban chup 05/11/2026 co dong D00141 voi VC truoc -23 va tong te 2227.
test('prepaid freight accepts a negative amount while every other money column does not',()=>{
  const r={...row,qtyPerCarton:1,cartonCount:150,unitPriceCny:15,freightPrepaid:-23};
  const d=C.row(r,0);
  assert.equal(d.totalCny,2227,'1*150*15 - 23');
  assert.equal(d.goodsAmount,2227*3920);
  assert.ok(Number.isFinite(d.netPrice));
  assert.deepEqual(C.issues(r),[],'khong con bao loi vi so am');
  assert.ok(C.issues({...row,freightPostpaid:-1}).includes('freightPostpaid'),'VC sau van khong am');
  assert.ok(C.issues({...row,surchargePercent:-1}).includes('surchargePercent'));
  assert.deepEqual([...C.SIGNED],['freightPrepaid']);
});
test('numeric expressions respect precedence and reject code, invalid syntax and division by zero',()=>{
 const {evaluate}=require('./purchase-calculations');
 assert.equal(evaluate('(10 * 20 * 30) / 1000000'),.006);
 assert.equal(evaluate('=2 + 3 * (4 - 1)'),11);
 assert.equal(evaluate('-2 * -3'),6);
 assert.equal(evaluate('1,234.5'),1234.5);
 for(const value of ['1/0','2**3','AA11*2','globalThis.x=1','(1+2','2 3','()'])assert.ok(Number.isNaN(evaluate(value)),value);
});

test('saved freight formulas accept Excel arithmetic, safe functions and current-container variables',()=>{
 const {evaluateFormula}=require('./purchase-calculations');
 const variables={M3_CONT:140,M3_XE:170};
 assert.ok(Math.abs(evaluateFormula('=(195000000+4*500*3930)/M3_XE*M3_CONT',variables)-167061176.47058824)<1e-7);
 assert.equal(evaluateFormula('=ROUND(SUM(195000000,4*500*3930)/M3_XE*M3_CONT,0)',variables),167061176);
 assert.equal(evaluateFormula('=(195000000+4*500*3930)/170*D2',{...variables,D2:140}),167061176.47058824);
 for(const value of ['=M3_CONT/0','=process.exit()','=WEBSERVICE("x")','=UNKNOWN+1','=1+2;3','=ROUND(1,99)'])assert.ok(Number.isNaN(evaluateFormula(value,variables)),value);
});

for(const [label,prepaid,expected] of [['omitted',undefined,1620],['null',null,1620],['empty','',1620],['whitespace','  ',1620],['zero',0,1620],['positive',10,1630],['negative',-23,1597]]){
 test('row handles '+label+' prepaid freight',()=>{
  const input={...row,freightPrepaid:prepaid};if(label==='omitted')delete input.freightPrepaid;
  const d=C.row(input,100);assert.equal(d.totalCny,expected);assert.equal(d.goodsAmount,expected*row.fxRate);
  assert.equal(d.netPrice,(expected*row.fxRate+100+row.freightPostpaid*row.fxRate)/1200);
  assert.equal(C.sum([d.totalCny]),expected);
  for(const key of ['qtyPerCarton','cartonCount','unitPriceCny'])for(const missing of [undefined,null,'']){
   const incomplete=C.row({...input,[key]:missing},100);
   for(const field of ['totalCny','goodsAmount','netPrice'])assert.equal(incomplete[field],null,key+'/'+field);
  }
 });
}
test('row preserves invalid prepaid and other missing freight semantics',()=>{
 assert.equal(C.row({...row,freightPrepaid:'invalid'},100).totalCny,null);
 assert.equal(C.row({...row,freightPrepaid:null,freightPostpaid:null},100).netPrice,(6350400+100)/1200);
 assert.equal(C.row({...row,freightPrepaid:null},null).netPrice,(6350400+20*3920)/1200);
});
