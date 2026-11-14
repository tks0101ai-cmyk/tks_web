(function(root,factory){
 if(typeof module==='object'&&module.exports)module.exports=factory(require('./purchase-calculations'),require('./purchase-freight'));
 else root.PurchaseContainerWorkspace=factory(root.PurchaseCalculations,root.PurchaseFreight);
})(typeof globalThis!=='undefined'?globalThis:this,function(C,F){
 'use strict';
 const statuses=[['waiting','Chờ xếp'],[1,'Chưa có lịch'],[2,'Chưa bốc'],[3,'Đã bốc'],[4,'Đã về']];
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const key=value=>String(value??'');
 const waiting=value=>value==null||value==='';
 const value=(c,camel,snake,fallback='')=>c[camel]??c[snake]??fallback;
 // Callers supply effective rows (saved values merged with drafts), before status filtering.
 function groupContainers({containers=[],rows=[],sort='status',direction='asc'}={}){
  const buckets=new Map();
  for(const r of rows){const id=key(r.contId);if(!buckets.has(id))buckets.set(id,[]);buckets.get(id).push(r)}
  const entry=c=>{const assigned=buckets.get(key(c.id))||[];return {c,rows:assigned,stats:C.stats(assigned)}};
  const queue=entry({id:null,name:'Chờ xếp',status:'waiting'});
  const seen=new Set();
  const groups=containers.filter(c=>{const id=key(c.id);if(waiting(c.id)||seen.has(id))return false;seen.add(id);return true}).map(entry);
  const sign=direction==='desc'?-1:1;
  groups.sort((a,b)=>{
   let result;
   if(['ton','m3','count'].includes(sort))result=a.stats[sort]-b.stats[sort];
   else if(sort==='name')result=String(a.c.name??'').localeCompare(String(b.c.name??''),'vi');
   else result=Number(a.c.status)-Number(b.c.status);
   return sign*(result||String(a.c.name??'').localeCompare(String(b.c.name??''),'vi'));
  });
  return [queue,...groups];
 }
 function statusSummary(options={}){
  const groups=groupContainers(options);
  return statuses.map(([status,label])=>{
   const matching=groups.filter(g=>status==='waiting'?waiting(g.c.id):!waiting(g.c.id)&&Number(g.c.status)===status);
   return {status,label,containerCount:matching.filter(g=>!waiting(g.c.id)).length,...C.stats(matching.flatMap(g=>g.rows))};
  });
 }
 function statusMarkup(options={}){
  return '<div class="purchase-container-status" role="group" aria-label="Lọc theo trạng thái cont">'+statusSummary(options).map(s=>
   '<button type="button" data-container-status="'+s.status+'" aria-pressed="'+(String(options.selectedStatus)===String(s.status))+'"><strong>'+s.label+'</strong> <span data-status-count>'+ (s.status==='waiting'?s.count:s.containerCount)+'</span></button>'
  ).join('')+'</div>';
 }
 // No IDs, form wrapper or handlers: safe to use in bottom table and pinned copy.
 // Parent owns permissions, validation, parsing numeric input and PATCH/version handling.
 function containerEditorMarkup(c={}, {rows=[],regions=[]}={}){
  const stats=C.stats(rows.filter(r=>key(r.contId)===key(c.id))),fee=F.calculate(c,stats.m3);
  const fields=[
   ['name','Tên cont','text',c.name],['regionId','Vùng','select',String(value(c,'regionId','region_id')??'')],['assumedM3','Tổng m³ giả định','number',value(c,'assumedM3','assumed_m3')],
   ['carrier','Nhà vận chuyển','text',c.carrier],['loader','Người xếp','text',c.loader],
   ['nameCn','Tên cont TQ','text',value(c,'nameCn','name_cn')],['loading','Lịch bốc','text',c.loading],
   ['arrivalNote','Dự kiến đến','text',value(c,'arrivalNote','arrival_note')],
   ['arrivalDate','Ngày về','date',String(value(c,'arrivalDate','arrival_date')).slice(0,10)],
   ['freight','Tiền VC','number',fee.amount],['freightMode','Chế độ cước','select',fee.mode],
   ['freightBase','Tiền chuẩn','number',fee.base],['freightCapacity','m³ chuẩn','number',fee.capacity],
   ['maxTon','Tải trọng tối đa (T)','number',value(c,'maxTon','max_ton',32)],
   ['m3Min','Khối tối thiểu (m³)','number',value(c,'m3Min','m3_min',160)],
   ['m3Max','Khối tối đa (m³)','number',value(c,'m3Max','m3_max',170)]
  ];
  return '<div class="purchase-container-editor" data-container-editor="'+esc(c.id)+'">'+fields.map(([name,label,type,v])=>{
   const attrs=' name="'+name+'" data-container-field="'+name+'" aria-label="'+label+'"';
   const options=name==='regionId'?[['','Chưa gán vùng'],...regions.filter(r=>r.isActive!==false||String(r.id)===String(v)).map(r=>[String(r.id),r.name])]:[['formula','Tự tính theo m³'],['manual','Nhập tay']];
   const control=type==='select'?'<select'+attrs+'>'+options.map(([id,text])=>'<option value="'+esc(id)+'"'+(String(v??'')===String(id)?' selected':'')+'>'+esc(text)+'</option>').join('')+'</select>':'<input type="'+type+'"'+attrs+(type==='number'?' step="any"':'')+' value="'+esc(v)+'">';
   return '<label>'+label+control+'</label>';
  }).join('')+[['count','Số dòng'],['ton','Tấn'],['m3','m³']].map(([name,label])=>'<label>'+label+'<output data-container-computed="'+name+'">'+esc(stats[name])+'</output></label>').join('')+'</div>';
 }
 return {statusSummary,statusMarkup,groupContainers,containerEditorMarkup};
});
