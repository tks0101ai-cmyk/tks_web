'use strict';
const fs=require('node:fs');
const {SHEET_NAMES,parseContainerSheet}=require('../productContainers/parser');
const {normalizeName}=require('./purchaseOrdersService');

// Preparation only: this module never opens a database or starts a sync job.
function prepareLegacySheets(sheets){
 const byName=new Map(sheets.map(s=>[s.name,s]));
 if(sheets.length!==SHEET_NAMES.length||byName.size!==SHEET_NAMES.length||SHEET_NAMES.some(n=>!byName.has(n)))throw Error('Cần đủ đúng 7 sheet nguồn.');
 const rows=[],conts=new Map(),issues=[],counts={};
 for(const name of SHEET_NAMES){
  const s=byName.get(name),parsed=parseContainerSheet(name,s.values,s.formattedValues||s.values);
  counts[name]=parsed.rows.length;
  issues.push(...parsed.warnings.map(w=>({sourceSheet:name,sourceRow:w.row,code:'SOURCE_PARSE_WARNING',message:w.reason})));
  for(const r of parsed.rows){
   const cells=(s.formattedValues||s.values)[r.sourceRow-1]||[];
   const key=normalizeName(r.containerName),prior=conts.get(key);
   if(r.status>4)issues.push({sourceSheet:name,sourceRow:r.sourceRow,code:'STATUS_REQUIRES_REVIEW',status:r.status});
   if(prior&&Number(prior.status.split('.')[0])!==r.status)issues.push({sourceSheet:name,sourceRow:r.sourceRow,code:'CONTAINER_STATUS_CONFLICT',container:r.containerName});
   if(!prior&&!/CHỜ XẾP/i.test(r.containerName))conts.set(key,{name:r.containerName,status:r.statusLabel});
   const row={rowKey:'D'+String(rows.length+1).padStart(5,'0'),sourceSheet:name,sourceRow:r.sourceRow,
    cont:r.containerName,code:r.productCode,name:String(cells[1]||'').trim(),listedAt:r.listedAt,
    qtyPerCarton:r.unitsPerPackage,cartonCount:r.packageCount,unitPriceCny:r.unitPriceCny,
    color:r.color,saleNote:r.saleNote,buyNote:r.otherNote,buyer:r.orderedBy,etaNote:r.eta,
    sourceQuantity:r.quantity,sourceVietnamPrice:r.vietnamPrice};
   if(!row.name||!Number.isSafeInteger(row.qtyPerCarton)||row.qtyPerCarton<=0||!Number.isSafeInteger(row.cartonCount)||row.cartonCount<=0){
    issues.push({sourceSheet:name,sourceRow:r.sourceRow,code:'ORDER_FIELDS_REQUIRE_REVIEW',rowKey:row.rowKey});
   }
   if(row.qtyPerCarton!=null&&row.cartonCount!=null&&Math.abs(row.qtyPerCarton*row.cartonCount-r.quantity)>1e-6){
    issues.push({sourceSheet:name,sourceRow:r.sourceRow,code:'QUANTITY_MISMATCH',rowKey:row.rowKey,sheet:r.quantity,calculated:row.qtyPerCarton*row.cartonCount});
   }
   rows.push(row);
  }
 }
 return {format:'purchase-legacy-v1',sheets:[...SHEET_NAMES],counts,conts:[...conts.values()],rows,issues,
  // Retain every original cell for review; derived fields are not guessed.
  rawSheets:SHEET_NAMES.map(n=>byName.get(n))};
}

async function readLegacySheets(client){
 const names=await client.listSheetTitles();
 if(SHEET_NAMES.some(n=>!names.includes(n)))throw Error('Workbook thiếu một trong 7 sheet nguồn.');
 const results=await Promise.allSettled(SHEET_NAMES.map(async name=>{
  const [values,formattedValues]=await Promise.all([
   client.getValues(name,{cellRange:'A:X',valueRenderOption:'UNFORMATTED_VALUE'}),
   client.getValues(name,{cellRange:'A:X',valueRenderOption:'FORMATTED_VALUE'})]);
  return {name,values,formattedValues};
 }));
 if(results.some(r=>r.status==='rejected'))throw Error('Chưa đọc đủ 7 sheet; không tạo bản nhập thiếu.');
 return prepareLegacySheets(results.map(r=>r.value));
}
module.exports={prepareLegacySheets,readLegacySheets};

if(require.main===module){
 const args=process.argv.slice(2),out=args.find(a=>a.startsWith('--out='))?.slice(6);
 if(!out){console.error('Dùng: node purchaseOrders/prepareLegacySheets.js --out=legacy-snapshot.json');process.exitCode=1;}
 else{
  const config=require('../config'),{createReadOnlyClient}=require('../sheets/sheetsClient');
  const id=config.PRODUCT_CONTAINER_SPREADSHEET_ID;
  if(!id){console.error('Chưa cấu hình workbook nguồn PRODUCT_CONTAINER_SPREADSHEET_ID.');process.exitCode=1;}
  else readLegacySheets(createReadOnlyClient(()=>id,'Chuẩn bị nhập Thu mua')).then(snapshot=>{
   fs.writeFileSync(out,JSON.stringify(snapshot,null,2),{encoding:'utf8',flag:'wx'});
   console.log(JSON.stringify({file:out,rows:snapshot.rows.length,counts:snapshot.counts,issues:snapshot.issues.length}));
  }).catch(error=>{console.error(error.message);process.exitCode=1});
 }
}
