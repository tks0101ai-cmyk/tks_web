'use strict';

const ExcelJS=require('exceljs');
const PurchaseHeaders=require('../public/shared/purchase-headers');
const PurchaseWorkbook=require('../public/shared/purchase-workbook');
const PurchaseCalculations=require('../public/shared/purchase-calculations');

const NUMBER_TYPES=new Set(['num','num1','num2','num3','num4','cny','money','pct','ratio']);
const INTEGER_DISPLAY_COLUMNS=new Set(['goodsAmount','freightAmount','fxRate']);
const HEADER_FIT_COLUMNS=new Set(['supplier','regionId','container','status','color','saleNote','vatNote','buyNote','buyer','paymentNote','listedAt','orderedNote','shippedNote','etaNote','arrivedNote']);
const CELL_BORDER={top:{style:'thin'},bottom:{style:'thin'},left:{style:'thin'},right:{style:'thin'}};
const HEADER_BORDER=CELL_BORDER;

function dateOnly(value){
  if(value==null||value==='')return null;
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth(),value.getUTCDate()));
  const raw=String(value).trim(),iso=/^(\d{4}-\d{2}-\d{2})/.exec(raw),local=/^(\d{1,2}\/\d{1,2}\/\d{4})/.exec(raw),date=PurchaseWorkbook.dateValue(iso?.[1]||local?.[1]||raw);
  if(!date)return null;
  const [year,month,day]=date.split('-').map(Number);
  return new Date(Date.UTC(year,month-1,day));
}
function listedAtValue(value){
  const normalized=PurchaseWorkbook.normalizeListedAt(value);if(!normalized)return value??null;
  if(normalized.includes(' + '))return normalized.replace(/(\d{4})-(\d{2})-(\d{2})/g,(_,year,month,day)=>day+'/'+month);
  const [year,month,day]=normalized.split('-').map(Number);return new Date(Date.UTC(year,month-1,day));
}

function numberFormat(column,value){
  if(!NUMBER_TYPES.has(column.t))return '@';
  if(column.k==='cartonCount')return '#,##0.###############';
  const percent=column.t==='pct'||column.t==='ratio'||['literDiff','gramDiff'].includes(column.k),number=Number(value);
  const shown=Number.isFinite(number)?Number((percent?number*100:number).toFixed(2)):0;
  const decimals=INTEGER_DISPLAY_COLUMNS.has(column.k)?0:(String(shown).split('.')[1]||'').length;
  const positive=(percent?'+0':'#,##0')+(decimals?'.'+'0'.repeat(decimals):'')+(percent?'%':'');
  const negative=(percent?'-0':'[Red]-#,##0')+(decimals?'.'+'0'.repeat(decimals):'')+(percent?'%':'');
  const zero=(percent?'0':'0')+(decimals?'.'+'0'.repeat(decimals):'')+(percent?'%':'');
  return `${positive};${negative};${zero}`;
}

function visibleText(value,column){
  if(value==null||value==='')return '';
  if(column.k==='listedAt'){
    if(value instanceof Date)return value.toLocaleDateString('en-GB',{timeZone:'UTC'}).slice(0,5);
    return String(PurchaseWorkbook.normalizeListedAt(value)||value).replace(/(\d{4})-(\d{2})-(\d{2})/g,(_,year,month,day)=>day+'/'+month);
  }
  if(column.t==='datetime'&&column.k!=='measuredOn'){
    const date=dateOnly(value);return date?date.toLocaleDateString('en-GB',{timeZone:'UTC'}):String(value);
  }
  if(NUMBER_TYPES.has(column.t)&&Number.isFinite(Number(value))){
    const number=Number(value),percent=column.t==='pct'||column.t==='ratio'||['literDiff','gramDiff'].includes(column.k),shown=percent?number*100:number;
    return new Intl.NumberFormat('en-US',{maximumFractionDigits:column.k==='cartonCount'?15:INTEGER_DISPLAY_COLUMNS.has(column.k)?0:2}).format(shown)+(percent?'%':'');
  }
  return String(value).split(/\r?\n/).reduce((longest,line)=>Math.max(longest,[...line].length),0);
}

function textWidth(value){return [...String(value??'')].reduce((width,char)=>width+(/[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe6f\uff00-\uffef]/u.test(char)?2:1),0)}

function orderTableContainer(row){
  if(row.contId==null)return 'Chờ'+(row.regionName?' '+row.regionName:'');
  return String(row.container??'').replace(/^CONT\s+/i,'').replace(/\s+(?:CHƯA CÓ LỊCH|CHỜ BỐC|ĐÃ BỐC|ĐÃ VỀ).*$/i,'').trim();
}

function mergeExportRows(rows){
  const groups=new Map();
  for(const row of rows){
    const code=String(row.productCode??'').trim().normalize('NFC').toLocaleLowerCase('vi');
    const units=Number(row.qtyPerCarton),cartons=Number(row.cartonCount);
    if(!code||!Number.isSafeInteger(units)||units<=0||!Number.isSafeInteger(cartons)||cartons<=0){groups.set('single:'+String(row.id??groups.size),[row]);continue}
    const key=JSON.stringify([code,String(row.contId??''),String(row.regionId??''),units]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row);
  }
  const epoch=value=>{const normalized=PurchaseWorkbook.normalizeListedAt(value);const part=String(normalized||value||'').split(' + ')[0],match=/^(\d{4}-\d{2}-\d{2})/.exec(part);return match?Date.parse(match[1]+'T00:00:00Z')||0:0};
  const updated=row=>Date.parse(row.updatedAt||'')||epoch(row.listedAt)||Number(row.id)||0;
  const result=[];
  for(const group of groups.values()){
    if(group.length<2){result.push(...group);continue}
    const newest=[...group].sort((a,b)=>updated(b)-updated(a)||Number(b.id||0)-Number(a.id||0))[0];
    const cartonCount=group.reduce((sum,row)=>sum+Number(row.cartonCount),0);
    if(!Number.isFinite(cartonCount)||cartonCount<=0||cartonCount>Number.MAX_SAFE_INTEGER){result.push(...group);continue}
    const chronological=[...group].sort((a,b)=>epoch(a.listedAt)-epoch(b.listedAt)||updated(a)-updated(b)||Number(a.id||0)-Number(b.id||0));
    const dates=[...new Set(group.flatMap(row=>String(PurchaseWorkbook.normalizeListedAt(row.listedAt)||'').split(' + ').filter(Boolean)).sort((a,b)=>Date.parse(a+'T00:00:00Z')-Date.parse(b+'T00:00:00Z')||a.localeCompare(b)))];
    const orderedNotes=[...new Set(chronological.map(row=>String(row.orderedNote??'').trim()).filter(Boolean))];
    const merged={...newest,cartonCount,listedAt:dates.join(' + ')||newest.listedAt||null,orderedNote:orderedNotes.join(' + ')||null};
    const derived=PurchaseCalculations.row(merged,null,merged.containerFxRate);
    const freightRates=group.map(row=>Number(row.totalM3)>0&&Number.isFinite(Number(row.freightAmount))?Number(row.freightAmount)/Number(row.totalM3):null).filter(Number.isFinite);
    const freight=freightRates.length?freightRates[0]*Number(derived.totalM3||0):group.some(row=>row.freightAmount!=null)?group.reduce((sum,row)=>sum+(Number(row.freightAmount)||0),0):null;
    Object.assign(merged,PurchaseCalculations.row(merged,freight,merged.containerFxRate));
    result.push(merged);
  }
  return result;
}

function widthForColumn(column,values,headerLabel){
  if(HEADER_FIT_COLUMNS.has(column.k))return Math.max(4,textWidth(headerLabel)+1);
  let width=0;
  for(const value of values){const text=visibleText(value,column);width=Math.max(width,typeof text==='number'?text:[...text].length)}
  // Keep numeric columns wider than the formatted value so Excel never renders ####.
  return Math.max(4,textWidth(headerLabel),width+(NUMBER_TYPES.has(column.t)?2:0));
}

async function formatPurchaseExport(rows,columns,fields,language='vi',{mergeSameProduct=false}={}){
  if(mergeSameProduct)rows=mergeExportRows(rows);
  const selected=new Set(fields||columns.map(column=>column.k)),exportColumns=columns.filter(column=>column.k!=='m3Warehouse'&&selected.has(column.k));
  if(!exportColumns.length)throw Error('Chọn ít nhất một cột để xuất.');
  const values=rows.map(row=>exportColumns.map(column=>column.k==='container'?orderTableContainer(row):column.region?(row.regionName??row.regionId??null):column.k==='listedAt'?listedAtValue(row[column.k]):column.t==='datetime'&&column.k!=='measuredOn'?(dateOnly(row[column.k])||row[column.k]||null):(row[column.k]??null)));
  const book=new ExcelJS.Workbook();book.creator='TOKOSI';book.created=new Date();book.modified=book.created;
  const sheet=book.addWorksheet('Đặt hàng',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
  const headerLabels=exportColumns.map(column=>PurchaseHeaders.label(column,language));
  sheet.columns=exportColumns.map((column,index)=>({key:column.k,width:widthForColumn(column,values.map(row=>row[index]),headerLabels[index])}));
  const header=sheet.addRow(headerLabels);
  header.eachCell({includeEmpty:true},cell=>{cell.font={name:'Calibri',size:11,bold:true};cell.alignment={horizontal:'center'};cell.border=HEADER_BORDER});
  for(const rowValues of values)sheet.addRow(rowValues);
  for(let index=0;index<exportColumns.length;index++){
    const column=exportColumns[index],target=sheet.getColumn(index+1);
    if(column.k==='listedAt')target.numFmt='dd/mm';
    else if(column.t==='datetime'&&column.k!=='measuredOn')target.numFmt='dd/mm/yyyy';
    target.alignment={vertical:'middle'};
  }
  sheet.eachRow((row,rowNumber)=>{if(rowNumber===1)return;row.eachCell({includeEmpty:true},(cell,columnNumber)=>{const column=exportColumns[columnNumber-1];cell.font={name:'Calibri',size:11};cell.alignment={vertical:'middle',wrapText:false};cell.border=CELL_BORDER;if(NUMBER_TYPES.has(column?.t))cell.numFmt=numberFormat(column,cell.value)})});
  if(sheet.rowCount)sheet.autoFilter={from:{row:1,column:1},to:{row:sheet.rowCount,column:exportColumns.length}};
  return book.xlsx.writeBuffer();
}

module.exports={formatPurchaseExport,mergeExportRows};
