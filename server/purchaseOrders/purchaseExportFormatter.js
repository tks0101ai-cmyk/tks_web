'use strict';

const ExcelJS=require('exceljs');
const PurchaseHeaders=require('../public/shared/purchase-headers');
const PurchaseWorkbook=require('../public/shared/purchase-workbook');

const NUMBER_TYPES=new Set(['num','num1','num2','num3','num4','cny','money','pct','ratio']);
const HEADER_FILL={type:'pattern',pattern:'solid',fgColor:{argb:'FFEAF1F8'}};

function dateOnly(value){
  if(value==null||value==='')return null;
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth(),value.getUTCDate()));
  const raw=String(value).trim(),iso=/^(\d{4}-\d{2}-\d{2})/.exec(raw),local=/^(\d{1,2}\/\d{1,2}\/\d{4})/.exec(raw),date=PurchaseWorkbook.dateValue(iso?.[1]||local?.[1]||raw);
  if(!date)return null;
  const [year,month,day]=date.split('-').map(Number);
  return new Date(Date.UTC(year,month-1,day));
}

function numberFormat(column){
  if(['literDiff','gramDiff','pct'].includes(column.k)||column.t==='pct')return '+0.##%;-0.##%;0%';
  if(column.t==='ratio')return '0.##%';
  return NUMBER_TYPES.has(column.t)?'#,##0.##;[Red]-#,##0.##;0':'@';
}

function visibleText(value,column){
  if(value==null||value==='')return '';
  if(column.t==='datetime'&&column.k!=='measuredOn'){
    const date=dateOnly(value);return date?date.toLocaleDateString('en-GB',{timeZone:'UTC'}):String(value);
  }
  if(NUMBER_TYPES.has(column.t)&&Number.isFinite(Number(value))){
    const number=Number(value),percent=column.t==='pct'||column.t==='ratio'||['literDiff','gramDiff'].includes(column.k),shown=percent?number*100:number;
    return new Intl.NumberFormat('en-US',{maximumFractionDigits:2}).format(shown)+(percent?'%':'');
  }
  return String(value).split(/\r?\n/).reduce((longest,line)=>Math.max(longest,[...line].length),0);
}

function orderTableContainer(row){
  if(row.contId==null)return 'Chờ'+(row.regionName?' '+row.regionName:'');
  return String(row.container??'').replace(/^CONT\s+/i,'').replace(/\s+(?:CHƯA CÓ LỊCH|CHỜ BỐC|ĐÃ BỐC|ĐÃ VỀ).*$/i,'').trim();
}

function widthForColumn(column,values){
  let width=0;
  for(const value of values){const text=visibleText(value,column);width=Math.max(width,typeof text==='number'?text:[...text].length)}
  // Headers wrap onto multiple lines; size each column to the displayed cell
  // values so a long title does not leave unused horizontal space.
  return Math.max(4,width);
}

async function formatPurchaseExport(rows,columns,fields,language='vi'){
  const selected=new Set(fields||columns.map(column=>column.k)),exportColumns=columns.filter(column=>selected.has(column.k));
  if(!exportColumns.length)throw Error('Chọn ít nhất một cột để xuất.');
  const values=rows.map(row=>exportColumns.map(column=>column.k==='container'?orderTableContainer(row):column.region?(row.regionName??row.regionId??null):column.t==='datetime'&&column.k!=='measuredOn'?(dateOnly(row[column.k])||row[column.k]||null):(row[column.k]??null)));
  const book=new ExcelJS.Workbook();book.creator='TOKOSI';book.created=new Date();book.modified=book.created;
  const sheet=book.addWorksheet('Đặt hàng',{views:[{state:'frozen',ySplit:1,showGridLines:false}]});
  sheet.columns=exportColumns.map((column,index)=>({key:column.k,width:widthForColumn(column,values.map(row=>row[index]))}));
  const header=sheet.addRow(exportColumns.map(column=>PurchaseHeaders.label(column,language)));
  header.height=32;header.eachCell({includeEmpty:true},cell=>{cell.font={name:'Arial',size:10,bold:true,color:{argb:'FF1D3553'}};cell.fill=HEADER_FILL;cell.alignment={vertical:'middle',horizontal:'center',wrapText:true};cell.border={bottom:{style:'thin',color:{argb:'FF9AAABD'}}}});
  for(const rowValues of values)sheet.addRow(rowValues);
  for(let index=0;index<exportColumns.length;index++){
    const column=exportColumns[index],target=sheet.getColumn(index+1);
    if(column.t==='datetime'&&column.k!=='measuredOn')target.numFmt='dd/mm/yyyy';
    else if(NUMBER_TYPES.has(column.t))target.numFmt=numberFormat(column);
    target.alignment={vertical:'middle',horizontal:NUMBER_TYPES.has(column.t)?'right':column.t==='datetime'?'center':'left'};
  }
  sheet.eachRow((row,rowNumber)=>{if(rowNumber===1)return;row.eachCell({includeEmpty:true},cell=>{cell.font={name:'Arial',size:10};cell.alignment={...cell.alignment,vertical:'middle'}})});
  if(sheet.rowCount)sheet.autoFilter={from:{row:1,column:1},to:{row:sheet.rowCount,column:exportColumns.length}};
  return book.xlsx.writeBuffer();
}

module.exports={formatPurchaseExport};
