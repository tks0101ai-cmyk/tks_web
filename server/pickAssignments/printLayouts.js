'use strict';
// Form in chung: chỉ lưu định dạng, không nhận HTML/text hoặc dữ liệu đơn.
const fail=(statusCode,message)=>Object.assign(new Error(message),{statusCode});
const templates={order:9,delivery:7};
const footerTables={order:{summary:4,signatures:2,notes:1},delivery:{deliverySignatures:3,deliveryNote:1}};
function assertTemplate(template){if(!Object.hasOwn(templates,template))throw fail(400,'Mẫu in không hợp lệ.');}
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const validPath=value=>typeof value==='string'&&value.length<=1200&&(value===''||/^([a-z][a-z0-9]*:nth-child\([1-9][0-9]*\))( > [a-z][a-z0-9]*:nth-child\([1-9][0-9]*\))*$/.test(value));
function validateLayout(template,input){
 assertTemplate(template);
 const result=validateTable(input,templates[template]);
 if(input.tables!==undefined){
  if(!plain(input.tables)||Object.keys(input.tables).some(key=>!Object.hasOwn(footerTables[template],key)))throw fail(400,'Định dạng bảng phụ không hợp lệ.');
  result.tables={};
  for(const [key,value] of Object.entries(input.tables))result.tables[key]=validateTable(value,footerTables[template][key]);
 }
 return result;
}
function validateTable(input,columnCount){
 const invalid=()=>{throw fail(400,'Định dạng phiếu không hợp lệ.');};
 const number=(n,min,max)=>typeof n==='number'&&Number.isFinite(n)&&n>=min&&n<=max;
 const formatting=(source,allowSize=false)=>{
  if(!plain(source))invalid();
  const clean={};
  for(const key of ['bold','italic'])if(source[key]!==undefined){if(typeof source[key]!=='boolean')invalid();clean[key]=source[key];}
  if(source.align!==undefined){if(!['left','right','center'].includes(source.align))invalid();clean.align=source.align;}
  if(allowSize&&source.size!==undefined){if(!number(source.size,7,36))invalid();clean.size=source.size;}
  return clean;
 };
 if(!input||!Array.isArray(input.widths)||!Array.isArray(input.heights)||!Array.isArray(input.fonts))invalid();
 const {widths,heights,fonts}=input;
 if(widths.length&&(widths.length!==columnCount||widths.some(n=>!number(n,2,100))||Math.abs(widths.reduce((a,b)=>a+b,0)-100)>.1))invalid();
 if(heights.length>2000||heights.some(n=>n!==null&&!number(n,16,1200)))invalid();
 if(fonts.length>2000)invalid();
 const cleanFonts=fonts.map(op=>{
  if(!op||!validPath(op.path)||!Number.isSafeInteger(op.start)||!Number.isSafeInteger(op.end)||op.start<0||op.end<=op.start||op.end>100000)invalid();
  const format=formatting(op,true);delete format.align;
  if(!Object.keys(format).length)invalid();
  return {path:op.path,start:op.start,end:op.end,...format};
 });
 const result={widths:[...widths],heights:[...heights],fonts:cleanFonts};
 if(input.groups!==undefined){
  if(!plain(input.groups)||Object.keys(input.groups).some(k=>!['body','header'].includes(k)))invalid();
  result.groups={};
  for(const [key,group] of Object.entries(input.groups)){
   if(!plain(group))invalid();
   const clean={};
   if(group.height!==undefined){if(!number(group.height,16,1200))invalid();clean.height=group.height;}
   if(group.size!==undefined){if(!number(group.size,7,36))invalid();clean.size=group.size;}
   if(group.columns!==undefined){
    if(!plain(group.columns)||Object.keys(group.columns).length>columnCount)invalid();
    clean.columns={};
    for(const [index,format] of Object.entries(group.columns)){
     if(!/^(0|[1-9][0-9]*)$/.test(index)||Number(index)>=columnCount)invalid();
     clean.columns[index]=formatting(format,true);
    }
   }
   result.groups[key]=clean;
  }
 }
 if(input.blocks!==undefined){
  if(!Array.isArray(input.blocks)||input.blocks.length>1000)invalid();
  result.blocks=input.blocks.map(op=>{
   if(!op||!validPath(op.path)||!['left','right','center'].includes(op.align))invalid();
   return {path:op.path,align:op.align};
  });
 }
 return result;
}
async function readLayout(pool,template){
 assertTemplate(template);
 const {rows}=await pool.query('SELECT layout, version FROM shared_print_layouts WHERE template=$1',[template]);
 return rows[0]||{layout:null,version:0};
}
async function writeLayout(pool,template,input,userId){
 const layout=validateLayout(template,input?.layout),version=input?.version;
 if(!Number.isSafeInteger(version)||version<0||version>2147483646)throw fail(400,'Phiên bản mẫu in không hợp lệ.');
 const {rows}=await pool.query(`INSERT INTO shared_print_layouts(template,layout,version,updated_by)
 SELECT $1,$2::jsonb,1,$4 WHERE $3::integer=0 OR EXISTS(SELECT 1 FROM shared_print_layouts WHERE template=$1 AND version=$3)
 ON CONFLICT(template) DO UPDATE SET layout=EXCLUDED.layout,version=shared_print_layouts.version+1,updated_by=EXCLUDED.updated_by,updated_at=now()
 WHERE shared_print_layouts.version=$3 RETURNING layout,version`,[template,JSON.stringify(layout),version,String(userId)]);
 if(!rows.length)throw fail(409,'Form chung đã được người khác sửa. Đóng rồi mở lại phiếu để lấy form mới trước khi chỉnh tiếp.');
 return rows[0];
}
module.exports={validateLayout,readLayout,writeLayout};
