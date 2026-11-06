(function(root,factory){if(typeof module==='object'&&module.exports)module.exports=factory();else root.PurchaseCalculations=factory()})(typeof globalThis!=='undefined'?globalThis:this,function(){
 'use strict';
 const MAX=Number.MAX_SAFE_INTEGER;
 // Arithmetic only: no eval, identifiers, function calls or cell references.
 function evaluate(value){
  const plain=parse(value);if(!Number.isNaN(plain))return plain;
  const text=String(value).trim().replace(/^=/,'').replace(/×/g,'*').replace(/÷/g,'/');
  if(text.length>256)return NaN;let pos=0;
  const space=()=>{while(/\s/.test(text[pos]||'')&&pos<text.length)pos++};
  function atom(){space();if(text[pos]==='+'||text[pos]==='-'){const sign=text[pos++];return (sign==='-'?-1:1)*atom()}if(text[pos]==='('){pos++;const n=sumExpression();space();if(text[pos++]!==')')throw Error();return n}const m=text.slice(pos).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);if(!m)throw Error();pos+=m[0].length;return Number(m[0])}
  function product(){let n=atom();space();while(text[pos]==='*'||text[pos]==='/'){const op=text[pos++],rhs=atom();n=op==='*'?n*rhs:n/rhs;space()}return n}
  function sumExpression(){let n=product();space();while(text[pos]==='+'||text[pos]==='-'){const op=text[pos++],rhs=product();n=op==='+'?n+rhs:n-rhs;space()}return n}
  try{const n=sumExpression();return pos===text.length&&Number.isFinite(n)&&Math.abs(n)<=MAX?n:NaN}catch{return NaN}
 }
 function parse(value){if(value==null||String(value).trim()==='')return null;if(typeof value==='number')return Number.isFinite(value)?value:NaN;const text=String(value).trim();return /^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)?Number(text.replace(/,/g,'')):NaN}
 function number(value){if(value==null||typeof value==='boolean'||String(value).trim()==='')return null;const n=typeof value==='number'?value:parse(value);return Number.isFinite(n)&&Math.abs(n)<=MAX?n:null}
 function fraction(value){const n=number(value);if(n==null)return null;const [digits,exp='0']=String(n).toLowerCase().split('e'),parts=digits.split('.'),scale=(parts[1]||'').length-Number(exp);return scale>=0?[BigInt(parts.join('')),10n**BigInt(scale)]:[BigInt(parts.join(''))*10n**BigInt(-scale),1n]}
 function raw(kind,values){const f=values.map(v=>Array.isArray(v)?v:fraction(v));if(f.some(v=>!v))return null;let [n,d]=f.shift();for(const [a,b] of f){if(kind==='add'){n=n*b+a*d;d*=b}else if(kind==='mul'){n*=a;d*=b}else {if(a===0n)return null;n*=b;d*=a}}return [n,d]}
 function result(f){return f?number(Number(f[0])/Number(f[1])):null}
 function operation(kind,values){return result(raw(kind,values))}
 const scaled=(values,denominator)=>result(raw('div',[raw('mul',values),denominator]));
 const add=(...v)=>operation('add',v),mul=(...v)=>operation('mul',v),divide=(...v)=>operation('div',v);
 const positive=v=>{const n=number(v);return n>0?n:null};
 const nonnegative=v=>{const n=number(v);return n!=null&&n>=0?n:null};
 // VC truoc (已付) duoc phep AM: nguon TKS dung so am lam khoan giam tru/hoan.
 // Cac cot tien khac van khong am. Xem migration 0115_purchase_freight_prepaid_signed.sql.
 const SIGNED=new Set(['freightPrepaid']);
 const signed=v=>number(v);
 const quantity=v=>{const n=positive(v);return Number.isSafeInteger(n)?n:null};
 function row(r,freightAmount=null){
  const units=quantity(r.qtyPerCarton),cartons=quantity(r.cartonCount),price=nonnegative(r.unitPriceCny),pre=signed(r.freightPrepaid),post=nonnegative(r.freightPostpaid),fx=positive(r.fxRate),kg=positive(r.kgPerCarton),m3=positive(r.m3PerCarton),lw=positive(r.literWarehouse),gw=positive(r.gramWarehouse);
  const totalQty=mul(units,cartons),totalCny=add(mul(totalQty,price),pre),goodsAmount=mul(totalCny,fx),totalTon=scaled([kg,cartons],1000),totalM3=mul(m3,cartons),literChina=scaled([m3,1000],units),gramChina=scaled([kg,1000],units),freight=number(freightAmount);
  return {totalQty,totalCny,goodsAmount,totalTon,totalM3,freightAmount:freight,netPrice:result(raw('div',[raw('add',[goodsAmount,freight,raw('mul',[post,fx])]),totalQty])),literChina,gramChina,literDiff:divide(add(literChina,lw==null?null:-lw),lw),gramDiff:divide(add(gramChina,gw==null?null:-gw),gw),ratio:divide(totalTon,totalM3)};
 }
 function issues(r){const errors=[];for(const k of ['qtyPerCarton','cartonCount'])if(quantity(r[k])==null)errors.push(k);for(const k of ['unitPriceCny','freightPrepaid','freightPostpaid','fxRate','kgPerCarton','m3PerCarton','literWarehouse','gramWarehouse','taxAmount']){if(r[k]==null||r[k]==='')continue;const n=number(r[k]);if(n==null||n<0&&!SIGNED.has(k)||k==='fxRate'&&n===0)errors.push(k)}const derived=row(r);for(const [key,inputs] of Object.entries({totalQty:['qtyPerCarton','cartonCount'],totalCny:['qtyPerCarton','cartonCount','unitPriceCny','freightPrepaid'],goodsAmount:['qtyPerCarton','cartonCount','unitPriceCny','freightPrepaid','fxRate'],totalTon:['kgPerCarton','cartonCount'],totalM3:['m3PerCarton','cartonCount']})){if(inputs.every(k=>number(r[k])!=null)&&derived[key]==null&&!inputs.some(k=>number(r[k])===0))errors.push(key)}return [...new Set(errors)]}
 function sum(values){return values.reduce((total,v)=>v==null?total:add(total,v),0)}
 function stats(rows){let missing=0;const weights=[],volumes=[];for(const r of rows){const count=quantity(r.cartonCount),kg=positive(r.kgPerCarton),m3=positive(r.m3PerCarton);if(count==null||kg==null||m3==null)missing++;weights.push(scaled([count,kg],1000));volumes.push(mul(count,m3))}return {count:rows.length,ton:sum(weights),m3:sum(volumes),missing}}
 return {stats,sum,parse,evaluate,number,positive,nonnegative,signed,quantity,add,mul,divide,row,issues,SIGNED};
});
