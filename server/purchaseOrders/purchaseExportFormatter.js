'use strict';

const ExcelJS=require('exceljs');
const PurchaseHeaders=require('../public/shared/purchase-headers');
const PurchaseWorkbook=require('../public/shared/purchase-workbook');

const NUMBER_TYPES=new Set(['num','num1','num2','num3','num4','cny','money','pct','ratio']);
const HEADER_FIT_COLUMNS=new Set(['supplier','regionId','container','status','color','saleNote','vatNote','buyNote']);
const HEADER_FILL={type:'pattern',pattern:'solid',fgColor:{argb:'FFEAF1F8'}};
const CELL_BORDER={top:{style:'thin',color:{argb:'FFD9E0EA'}},bottom:{style:'thin',color:{argb:'FFD9E0EA'}},left:{style:'thin',color:{argb:'FFD9E0EA'}},right:{style:'thin',color:{argb:'FFD9E0EA'}}};
const HEADER_BORDER={top:{style:'thin',color:{argb:'FFB8C6D8'}},bottom:{style:'thin',color:{argb:'FF9AAABD'}},left:{style:'thin',color:{argb:'FFB8C6D8'}},right:{style:'thin',color:{argb:'FFB8C6D8'}}};

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
  const percent=column.t==='pct'||column.t==='ratio'||['literDiff','gramDiff'].includes(column.k),number=Number(value);
  const shown=Number.isFinite(number)?Number((percent?number*100:number).toFixed(2)):0;
  const decimals=(String(shown).split('.')[1]||'').length;
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
    return new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(shown)+(percent?'%':'');
  }
  return String(value).split(/\r?\n/).reduce((longest,line)=>Math.max(longest,[...line].length),0);
}

function textWidth(value){return [...String(value??'')].reduce((width,char)=>width+(/[\u1100-\u11ff\u2e80-\u9fff\uf900-\ufaff\ufe30-\ufe6f\uff00-\uffef]/u.test(char)?2:1),0)}

function orderTableContainer(row){
  if(row.contId==null)return 'Chờ'+(row.regionName?' '+row.regionName:'');
  return String(row.container??'').replace(/^CONT\s+/i,'').replace(/\s+(?:CHƯA CÓ LỊCH|CHỜ BỐC|ĐÃ BỐC|ĐÃ VỀ).*$/i,'').trim();
}

function widthForColumn(column,values,headerLabel){
  if(HEADER_FIT_COLUMNS.has(column.k))return Math.max(4,textWidth(headerLabel)+1);
  let width=0;
  for(const value of values){const text=visibleText(value,column);width=Math.max(width,typeof text==='number'?text:[...text].length)}
  // Keep numeric columns wider than the formatted value so Excel never renders ####.
  return Math.max(4,width+(NUMBER_TYPES.has(column.t)?2:0));
}

async function formatPurchaseExport(rows,columns,fields,language='vi'){
  const selected=new Set(fields||columns.map(column=>column.k)),exportColumns=columns.filter(column=>column.k!=='m3Warehouse'&&selected.has(column.k));
  if(!exportColumns.length)throw Error('Chọn ít nhất một cột để xuất.');
  const values=rows.map(row=>exportColumns.map(column=>column.k==='container'?orderTableContainer(row):column.region?(row.regionName??row.regionId??null):column.k==='listedAt'?listedAtValue(row[column.k]):column.t==='datetime'&&column.k!=='measuredOn'?(dateOnly(row[column.k])||row[column.k]||null):(row[column.k]??null)));
  const book=new ExcelJS.Workbook();book.creator='TOKOSI';book.created=new Date();book.modified=book.created;
  const sheet=book.addWorksheet('Đặt hàng',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
  const headerLabels=exportColumns.map(column=>PurchaseHeaders.label(column,language));
  sheet.columns=exportColumns.map((column,index)=>({key:column.k,width:widthForColumn(column,values.map(row=>row[index]),headerLabels[index])}));
  const header=sheet.addRow(headerLabels);
  header.height=32;header.eachCell({includeEmpty:true},cell=>{cell.font={name:'Calibri',size:10,bold:true,color:{argb:'FF1D3553'}};cell.fill=HEADER_FILL;cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};cell.border=HEADER_BORDER});
  for(const rowValues of values)sheet.addRow(rowValues);
  for(let index=0;index<exportColumns.length;index++){
    const column=exportColumns[index],target=sheet.getColumn(index+1);
    if(column.k==='listedAt')target.numFmt='dd/mm';
    else if(column.t==='datetime'&&column.k!=='measuredOn')target.numFmt='dd/mm/yyyy';
    target.alignment={vertical:'middle',horizontal:NUMBER_TYPES.has(column.t)?'right':column.t==='datetime'||column.k==='listedAt'?'center':'left'};
  }
  sheet.eachRow((row,rowNumber)=>{if(rowNumber===1)return;let lineCount=1;row.eachCell({includeEmpty:true},(cell,columnNumber)=>{const column=exportColumns[columnNumber-1],wrap=HEADER_FIT_COLUMNS.has(column?.k);cell.font={name:'Calibri',size:10};cell.alignment={...cell.alignment,vertical:'middle',wrapText:wrap};cell.border=CELL_BORDER;if(NUMBER_TYPES.has(column?.t))cell.numFmt=numberFormat(column,cell.value);if(wrap&&cell.value!=null&&cell.value!==''){const width=Math.max(1,sheet.getColumn(columnNumber).width-1);lineCount=Math.max(lineCount,String(cell.value).split(/\r?\n/).reduce((count,line)=>count+Math.max(1,Math.ceil(textWidth(line)/width)),0))}});if(lineCount>1)row.height=Math.max(18,lineCount*14+2)});
  if(sheet.rowCount)sheet.autoFilter={from:{row:1,column:1},to:{row:sheet.rowCount,column:exportColumns.length}};
  return book.xlsx.writeBuffer();
}

module.exports={formatPurchaseExport};
