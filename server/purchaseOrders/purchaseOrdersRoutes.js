'use strict';
const {createHash,randomUUID}=require('node:crypto');
const express = require('express');
const multer = require('multer');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { hasFeature } = require('../auth/featureRegistry');
const { createPurchaseOrdersService } = require('./purchaseOrdersService');
const workbook = require('../public/shared/purchase-workbook');
const { formatPurchaseSnapshot } = require('./purchaseSnapshotFormatter');
const { formatPurchaseExport } = require('./purchaseExportFormatter');
const columns = require('../public/shared/purchase-columns');
function createPurchaseOrdersRouter(dependencies={}) {
  const router=express.Router(),service=dependencies.service||createPurchaseOrdersService({deferProjection:true});
  const root=dependencies.root||'/api/purchase-orders';
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:1}});
  const requirePurchaseScope=scope=>(req,res,next)=>hasFeature(req.user,scope)?next():res.status(403).json({code:'PURCHASE_SCOPE_REQUIRED',error:scope==='purchase.orders'?'Bạn chưa được cấp quyền làm việc với bảng Đặt hàng.':'Bạn chưa được cấp quyền làm việc với bảng Chỉ số cont.'});
  const ordersScope=requirePurchaseScope('purchase.orders'),containersScope=requirePurchaseScope('purchase.containers');
  const eitherTableScope=(req,res,next)=>hasFeature(req.user,'purchase.orders','purchase.containers')?next():res.status(403).json({code:'PURCHASE_SCOPE_REQUIRED',error:'Bạn chưa được cấp quyền làm việc với bảng Thu mua.'});
  router.use(root,(req,res,next)=>{res.set('Cache-Control','no-store');next()},dependencies.requireAuth||requireAuth,requireFeature('purchase.view'));
  require('./purchaseOrdersRealtime').attachRealtime(router,root,dependencies.events,dependencies.presenceStore);
  const handle=fn=>async(req,res)=>{try{const key=req.get('Idempotency-Key');if(key&&['POST','PATCH'].includes(req.method)){if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key))return res.status(400).json({code:'REQUEST_KEY_INVALID',error:'Mã lần lưu không hợp lệ.'});req.user={...req.user,_purchaseRequest:{key,fingerprint:createHash('sha256').update(req.method+' '+req.originalUrl+' '+JSON.stringify(req.body)).digest('hex')}}}await fn(req,res)}catch(error){if(error.code==='42P01'){error.statusCode=503;error.code='PURCHASE_MIGRATION_REQUIRED';error.message='Thu mua chưa khởi tạo xong dữ liệu. Các module khác vẫn hoạt động.'}const status=error.statusCode||500,requestId=status>=500?randomUUID():null;if(status>=500)console.error('[Purchase API] Request failed',{requestId,method:req.method,path:String(req.originalUrl||req.path||'').split('?')[0],name:error?.name,code:error?.code,message:String(error?.message||error).slice(0,300),stack:String(error?.stack||'').split('\n').slice(1,6).join('\n')});res.status(status).json({code:error.code||'PURCHASE_FAILED',error:status<500?error.message:status===503?error.message:'Không xử lý được Thu mua.',...(error.rows?{rows:error.rows}:{}),...(error.conflicts?{conflicts:error.conflicts}:{}),...(error.clientId?{clientId:error.clientId}:{}),...(requestId?{requestId}:{})})}};
  router.get(root,handle(async(req,res)=>{const hasOrders=hasFeature(req.user,'purchase.orders'),hasContainers=hasFeature(req.user,'purchase.containers'),legacyReadOnly=!hasOrders&&!hasContainers&&hasFeature(req.user,'purchase.view');res.json({...await service.list(req.user,req.query),permissions:{orders:hasOrders||legacyReadOnly,containers:hasContainers||legacyReadOnly,...Object.fromEntries(['edit','import','export','depart','arrive'].map(k=>[k,hasFeature(req.user,'purchase.'+k)]))}})}));
  router.patch(root+'/waiting-config',ordersScope,requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.updateWaitingConfig(req.user,req.body))));
  router.get(root+'/revision',handle(async(req,res)=>res.json(await service.revision(req.user))));
  router.get(root+'/changes',handle(async(req,res)=>res.json(await service.changes(req.user,req.query.after))));
  router.get(root+'/employees',requireFeature('purchase.view'),handle(async(req,res)=>res.json({rows:await service.employees(req.user)})));
  router.get(root+'/regions',eitherTableScope,handle(async(req,res)=>res.json({rows:await service.regions(req.user)})));
  router.put(root+'/regions/batch',eitherTableScope,handle(async(req,res)=>res.json(await service.saveRegions(req.user,req.body))));
  router.put(root+'/employees/batch',ordersScope,handle(async(req,res)=>res.json(await service.saveEmployees(req.user,req.body))));
  router.post(root+'/employees',ordersScope,handle(async(req,res)=>res.status(201).json(await service.createEmployee(req.user,req.body))));
  router.patch(root+'/employees/:id',ordersScope,handle(async(req,res)=>res.json(await service.updateEmployee(req.user,req.params.id,req.body))));
  router.get(root+'/trash',requireFeature('purchase.view'),handle(async(req,res)=>res.json({rows:await service.trash(req.user)})));
  router.get(root+'/inactive',requireFeature('purchase.view'),handle(async(req,res)=>res.json({rows:await service.inactive(req.user)})));
  router.get(root+'/containers/trash',requireFeature('purchase.view'),handle(async(req,res)=>res.json({rows:await service.containerTrash(req.user)})));
  router.get(root+'/containers/inactive',requireFeature('purchase.view'),handle(async(req,res)=>res.json({rows:await service.inactiveContainers(req.user)})));
  router.get(root+'/operations',requireFeature('purchase.view'),handle(async(req,res)=>res.json({rows:await service.operations(req.user)})));
  // Nhat ky phien ban: danh sach phien ban, va trang thai bang tai mot phien ban.
  router.get(root+'/versions',requireFeature('purchase.view'),handle(async(req,res)=>res.json({rows:await service.versions(req.user,{limit:req.query.limit,before:req.query.before})})));
  router.get(root+'/versions/:id',requireFeature('purchase.view'),handle(async(req,res)=>res.json(await service.versionAt(req.user,req.params.id))));
  router.post(root+'/versions/:id/restore',ordersScope,requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.restoreVersion(req.user,req.params.id))));
  for(const [path,method] of [['delete','remove'],['deactivate','deactivate'],['reactivate','reactivate'],['restore','restore'],['undo','undo']])router.post(root+'/'+path,requirePurchaseScope(path.startsWith('containers/')?'purchase.containers':'purchase.orders'),handle(async(req,res)=>res.json(await service[method](req.user,req.body))));
  for(const [path,method] of [['containers/deactivate','deactivateContainer'],['containers/reactivate','reactivateContainer'],['containers/delete','removeContainer'],['containers/restore','restoreContainer']])router.post(root+'/'+path,requirePurchaseScope(path.startsWith('containers/')?'purchase.containers':'purchase.orders'),handle(async(req,res)=>res.json(await service[method](req.user,req.body))));
  router.get(root+'/latest',requireFeature('purchase.view'),handle(async(req,res)=>res.json({row:await service.latest(req.user,req.query.code)})));
  router.post(root+'/latest-many',requireFeature('purchase.view'),handle(async(req,res)=>res.json({rows:await service.latestMany(req.user,req.body?.codes)})));
  router.post(root+'/next-key',ordersScope,handle(async(req,res)=>res.json(await service.reserveKey(req.user))));
  router.post(root+'/release-key',ordersScope,handle(async(req,res)=>{if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.body?.reservationId||''))return res.status(400).json({code:'RESERVATION_ID_INVALID',error:'Mã giữ chỗ không hợp lệ.'});res.json(await service.releaseKey(req.user,{reservationId:req.body.reservationId}))}));
  router.get(root+'/history',requireFeature('purchase.view'),handle(async(req,res)=>{const id=req.query.orderId;if(!/^[1-9]\d*$/.test(String(id||''))||BigInt(id)>9223372036854775807n)return res.status(400).json({code:'ORDER_ID_INVALID',error:'Mã dòng nội bộ không hợp lệ.'});res.json({rows:await service.history(req.user,id)})}));
  router.post(root+'/export',requireFeature('purchase.export'),handle(async(req,res)=>{
    const allowed=new Set(columns.map(c=>c.k)),fields=req.body.fields,ids=req.body.ids,filters=req.body.filters,validIds=Array.isArray(ids)&&ids.length<=10000&&!ids.some(id=>!/^[1-9]\d*$/.test(String(id))),validFilters=filters&&typeof filters==='object'&&!Array.isArray(filters)&&Object.keys(filters).every(key=>['search','container','region','status','buyer','from','to','quick','flag','sort','colSort','onlyIds','ids'].includes(key))&&(filters.ids==null||Array.isArray(filters.ids)&&filters.ids.length<=10000&&!filters.ids.some(id=>!/^[1-9]\d*$/.test(String(id))));
    if(!Array.isArray(fields)||!fields.length||fields.some(k=>!allowed.has(k))||!(validIds||validFilters))return res.status(400).json({code:'EXPORT_INVALID',error:'Danh sách dòng hoặc bộ lọc/cột không hợp lệ.'});
    const rows=await service.exportRows(req.user,validIds?ids.map(String):null,validFilters?filters:null);
    const file=await formatPurchaseExport(rows,columns,fields,req.body.language==='zh'?'zh':'vi');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('Thu-mua.xlsx').send(Buffer.from(file));
  }));
  router.get(root+'/export',requireFeature('purchase.export'),handle(async(req,res)=>{
    const allowed=new Set(columns.map(c=>c.k)),fields=req.query.fields?String(req.query.fields).split(','):columns.map(c=>c.k);
    if(fields.some(k=>!allowed.has(k)))return res.status(400).json({code:'EXPORT_FIELDS_INVALID',error:'Cột xuất không hợp lệ.'});
    const rows=await service.exportRows(req.user),file=await formatPurchaseExport(rows,columns,fields,req.query.language==='zh'?'zh':'vi');
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('Thu-mua.xlsx').send(Buffer.from(file));
  }));
  router.post(root+'/bulk-create',ordersScope,handle(async(req,res)=>res.status(201).json(await service.createMany(req.user,req.body))));
  router.post(root,ordersScope,handle(async(req,res)=>res.status(201).json(await service.create(req.user,req.body))));
  router.patch(root+'/:id',ordersScope,handle(async(req,res)=>res.json(await service.update(req.user,req.params.id,req.body))));
  router.post(root+'/containers',containersScope,handle(async(req,res)=>res.status(201).json(await service.createContainer(req.user,req.body))));
  router.patch(root+'/containers/:id',containersScope,handle(async(req,res)=>res.json(await service.updateContainer(req.user,req.params.id,req.body))));
  router.post(root+'/plan',ordersScope,handle(async(req,res)=>res.json(await service.applyPlan(req.user,req.body))));
  router.post(root+'/status',containersScope,handle(async(req,res)=>{const next=Number(req.body.status);if((next===3&&!hasFeature(req.user,'purchase.depart'))||(next===4&&!hasFeature(req.user,'purchase.arrive')))return res.status(403).json({error:'Chưa có quyền đổi sang trạng thái này.'});res.json(await service.changeStatus(req.user,req.body))}));
  router.post(root+'/schedule',containersScope,handle(async(req,res)=>res.json(await service.schedule(req.user,req.body))));
  router.post(root+'/bulk',ordersScope,handle(async(req,res)=>res.json(await service.bulkEdit(req.user,req.body))));
  router.post(root+'/transfer',ordersScope,handle(async(req,res)=>res.json(await service.transfer(req.user,req.body))));
  router.post(root+'/depart',requireFeature('purchase.depart'),handle(async(req,res)=>res.json(await service.depart(req.user,req.body))));
  router.post(root+'/arrive',requireFeature('purchase.arrive'),handle(async(req,res)=>res.json(await service.arrive(req.user,req.body))));
  router.get(root+'/import/snapshot',requireFeature('purchase.import'),handle(async(req,res)=>{const snapshot=await service.importSnapshot(req.user);const data=workbook.exportImportSnapshot({...snapshot,columns}),formatted=await formatPurchaseSnapshot(data,columns);res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').set('Content-Disposition','attachment; filename="tokosi-purchase-snapshot.xlsx"').send(formatted)}));
  router.post(root+'/import/preview',requireFeature('purchase.import'),(req,res,next)=>upload.single('file')(req,res,error=>{
    if(error)return res.status(400).json({code:'IMPORT_FILE_INVALID',error:'Chỉ chọn một file, tối đa 10 MB.'});next();
  }),async(req,res)=>{
    if(!req.file||!/\.xlsx$/i.test(req.file.originalname))return res.status(400).json({code:'IMPORT_FILE_INVALID',error:'Chọn file .xlsx.'});
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'});
    res.flushHeaders?.();
    const send=payload=>{if(!res.destroyed)res.write('data: '+JSON.stringify(payload)+'\n\n')};
    const yieldToClient=()=>new Promise(resolve=>setImmediate(resolve));
    try{
      send({type:'progress',percent:5,message:'File đã tải lên. Máy chủ đang bắt đầu xử lý…'});await yieldToClient();
      const result=await service.previewImport(req.user,{buffer:req.file.buffer,allowStale:req.query.allowStale==='1',onProgress:async(percent,message)=>{send({type:'progress',percent,message});await yieldToClient()}});
      send({type:'result',result});res.end();
    }catch(error){
      if(error.code==='42P01'){error.statusCode=503;error.code='PURCHASE_MIGRATION_REQUIRED';error.message='Thu mua chưa khởi tạo xong dữ liệu. Các module khác vẫn hoạt động.'}
      const status=error.statusCode||500,requestId=status>=500?randomUUID():null;
      if(status>=500)console.error('[Purchase API] Request failed',{requestId,method:req.method,path:String(req.originalUrl||req.path||'').split('?')[0],name:error?.name,code:error?.code,message:String(error?.message||error).slice(0,300),stack:String(error?.stack||'').split('\n').slice(1,6).join('\n')});
      send({type:'error',status,code:error.code||'PURCHASE_FAILED',error:status<500?error.message:status===503?error.message:'Không xử lý được Thu mua.',...(error.rows?{rows:error.rows}:{}),...(error.conflicts?{conflicts:error.conflicts}:{}),...(error.clientId?{clientId:error.clientId}:{}),...(requestId?{requestId}:{})});res.end();
    }
  });
  router.post(root+'/import/revise',requireFeature('purchase.import'),handle(async(req,res)=>{if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.body.token||''))return res.status(400).json({code:'IMPORT_TOKEN_INVALID',error:'Bản xem trước không hợp lệ.'});res.json(await service.reviseImport(req.user,req.body.token,req.body.rows))}));
  router.post(root+'/import/confirm',requireFeature('purchase.import'),handle(async(req,res)=>{
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.body.token||''))return res.status(400).json({code:'IMPORT_TOKEN_INVALID',error:'Bản xem trước không hợp lệ.'});
    res.json(await service.commitImport(req.user,req.body.token,{ackStale:req.body.ackStale===true}));
  }));
  return router;
}
module.exports=createPurchaseOrdersRouter();
module.exports.createPurchaseOrdersRouter=createPurchaseOrdersRouter;
