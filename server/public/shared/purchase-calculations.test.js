const {test}=require('node:test');const assert=require('node:assert/strict');const C=require('./purchase-calculations');
const row={qtyPerCarton:300,cartonCount:4,unitPriceCny:1.35,freightPrepaid:10,freightPostpaid:20,fxRate:3920,kgPerCarton:13.8,m3PerCarton:.073,literWarehouse:.25,gramWarehouse:46};
test('canonical row formulas include both RMB freight charges and exclude tax',()=>{const d=C.row({...row,taxAmount:99999},292000);assert.equal(d.totalQty,1200);assert.equal(d.totalCny,1630);assert.equal(d.goodsAmount,6389600);assert.equal(d.totalTon,.0552);assert.equal(d.totalM3,.292);assert.equal(d.netPrice,(6389600+292000+78400)/1200);assert.ok(Math.abs(d.literDiff-(d.literChina-.25)/.25)<1e-14);assert.equal(d.gramDiff,0)});
test('missing and zero have different meanings and no division creates NaN',()=>{for(const blank of [null,undefined,'']){const d=C.row({...row,freightPrepaid:blank},100);assert.equal(d.totalCny,null);assert.equal(d.netPrice,null)}assert.equal(C.row({...row,unitPriceCny:0,freightPrepaid:0,freightPostpaid:0},0).netPrice,0);for(const k of ['qtyPerCarton','cartonCount','kgPerCarton','m3PerCarton','fxRate','literWarehouse']){const d=C.row({...row,[k]:0},0);assert.ok(Object.values(d).every(v=>v==null||Number.isFinite(v)))}assert.equal(C.row({...row,m3PerCarton:0},null).totalM3,null);assert.equal(C.row({...row,fxRate:0},0).netPrice,null)});
test('decimal operations retain small quantities and do not round intermediate prices',()=>{assert.equal(C.mul(.1,3),.3);assert.equal(C.add(.1,.2),.3);assert.equal(C.row({...row,m3PerCarton:.000001,cartonCount:3},0).totalM3,.000003);assert.equal(C.row({...row,unitPriceCny:1.23456},0).totalCny,1491.472)});
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
  assert.ok(C.issues({...row,taxAmount:-1}).includes('taxAmount'));
  assert.deepEqual([...C.SIGNED],['freightPrepaid']);
});
