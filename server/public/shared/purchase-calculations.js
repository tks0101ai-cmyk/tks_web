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
 function evaluateFormula(value,variables={}){
  const text=String(value??'').trim().replace(/^=/,'').replace(/×/g,'*').replace(/÷/g,'/');
  if(!text||text.length>512||!variables||typeof variables!=='object'||Array.isArray(variables))return NaN;let pos=0;
  const space=()=>{while(/\s/.test(text[pos]||'')&&pos<text.length)pos++};
  const finite=n=>Number.isFinite(n)&&Math.abs(n)<=MAX?n:NaN;
  function atom(){
   space();if(text[pos]==='+'||text[pos]==='-'){const sign=text[pos++];return finite((sign==='-'?-1:1)*atom())}
   if(text[pos]==='('){pos++;const n=sumExpression();space();if(text[pos++]!==')')throw Error();return n}
   const numeric=text.slice(pos).match(/^(?:\d+(?:\.\d*)?|\.\d+)/);if(numeric){pos+=numeric[0].length;return Number(numeric[0])}
   const identifier=text.slice(pos).match(/^[A-Za-z_][A-Za-z0-9_]*/);if(!identifier)throw Error();pos+=identifier[0].length;const key=identifier[0].toUpperCase();space();
   if(text[pos]==='('){pos++;const args=[];space();if(text[pos]!==')'){while(true){args.push(sumExpression());space();if(text[pos]!==',')break;pos++}}if(text[pos++]!==')')throw Error();if(args.length>32)throw Error();
    if(key==='SUM'&&args.length)return finite(args.reduce((a,b)=>a+b,0));if(key==='MIN'&&args.length)return Math.min(...args);if(key==='MAX'&&args.length)return Math.max(...args);if(key==='ABS'&&args.length===1)return Math.abs(args[0]);
    if(key==='ROUND'&&args.length===2&&Number.isInteger(args[1])&&Math.abs(args[1])<=12){const factor=10**args[1];return finite(Math.sign(args[0])*Math.floor(Math.abs(args[0])*factor+.5)/factor)}throw Error()
   }
   const variable=key==='D2'?'M3_CONT':key;if(!Object.hasOwn(variables,variable))throw Error();const n=Number(variables[variable]);return finite(n)
  }
  function power(){let n=atom();space();if(text[pos]==='^'){pos++;n=finite(n**power())}return n}
  function product(){let n=power();space();while(text[pos]==='*'||text[pos]==='/'){const op=text[pos++],rhs=power();n=finite(op==='*'?n*rhs:n/rhs);space()}return n}
  function sumExpression(){let n=product();space();while(text[pos]==='+'||text[pos]==='-'){const op=text[pos++],rhs=product();n=finite(op==='+'?n+rhs:n-rhs);space()}return n}
  try{const n=sumExpression();space();return pos===text.length?finite(n):NaN}catch{return NaN}
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
  const units=quantity(r.qtyPerCarton),cartons=quantity(r.cartonCount),price=nonnegative(r.unitPriceCny),pre=r.freightPrepaid==null||String(r.freightPrepaid).trim()===''?0:signed(r.freightPrepaid),post=nonnegative(r.freightPostpaid),surchargePercent=nonnegative(r.surchargePercent),fx=positive(r.fxRate),kg=positive(r.kgPerCarton),m3=positive(r.m3PerCarton),lw=positive(r.literWarehouse),gw=positive(r.gramWarehouse);
  const totalQty=mul(units,cartons),goodsCny=mul(totalQty,price),totalCny=add(goodsCny,pre),goodsAmount=mul(totalCny,fx),surchargeAmount=mul(goodsAmount,surchargePercent),totalTon=scaled([kg,cartons],1000),totalM3=mul(m3,cartons),freight=number(freightAmount),overrides=r.measurementOverrides||{},override=(key,value)=>Object.hasOwn(overrides,key)?number(overrides[key]):value;
  const literChina=override('literChina',scaled([m3,1000],units)),gramChina=override('gramChina',scaled([kg,1000],units));
  return {totalQty,totalCny,goodsAmount,surchargeAmount,totalTon,totalM3,freightAmount:freight,netPrice:result(raw('div',[raw('add',[goodsAmount,freight??0,raw('mul',[post??0,3920])]),totalQty])),literChina,gramChina,literDiff:override('literDiff',divide(add(literChina,lw==null?null:-lw),lw)),gramDiff:override('gramDiff',divide(add(gramChina,gw==null?null:-gw),gw)),ratio:override('ratio',divide(totalTon,totalM3))};
 }
 function issues(r){const errors=[];for(const k of ['qtyPerCarton','cartonCount'])if(quantity(r[k])==null)errors.push(k);for(const k of ['unitPriceCny','freightPrepaid','freightPostpaid','surchargePercent','fxRate','kgPerCarton','m3PerCarton','literWarehouse','gramWarehouse']){if(r[k]==null||r[k]==='')continue;const n=number(r[k]);if(n==null||n<0&&!SIGNED.has(k)||k==='fxRate'&&n===0)errors.push(k)}const derived=row(r);for(const [key,inputs] of Object.entries({totalQty:['qtyPerCarton','cartonCount'],totalCny:['qtyPerCarton','cartonCount','unitPriceCny','freightPrepaid'],goodsAmount:['qtyPerCarton','cartonCount','unitPriceCny','freightPrepaid','fxRate'],totalTon:['kgPerCarton','cartonCount'],totalM3:['m3PerCarton','cartonCount']})){if(inputs.every(k=>number(r[k])!=null)&&derived[key]==null&&!inputs.some(k=>number(r[k])===0))errors.push(key)}return [...new Set(errors)]}
 function sum(values){return values.reduce((total,v)=>v==null?total:add(total,v),0)}
 function stats(rows){let missing=0;const weights=[],volumes=[];for(const r of rows){const count=quantity(r.cartonCount),kg=positive(r.kgPerCarton),m3=positive(r.m3PerCarton);if(count==null||kg==null||m3==null)missing++;weights.push(scaled([count,kg],1000));volumes.push(mul(count,m3))}return {count:rows.length,ton:sum(weights),m3:sum(volumes),missing}}
 return {stats,sum,parse,evaluate,evaluateFormula,number,positive,nonnegative,signed,quantity,add,mul,divide,row,issues,SIGNED};
});
