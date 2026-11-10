'use strict';
const {createHash}=require('node:crypto');
const express = require('express');
const multer = require('multer');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { hasFeature } = require('../auth/featureRegistry');
const { createPurchaseOrdersService } = require('./purchaseOrdersService');
const workbook = require('../public/shared/purchase-workbook');
const columns = require('../public/shared/purchase-columns');
function createPurchaseOrdersRouter(dependencies={}) {
  const router=express.Router(),service=dependencies.service||createPurchaseOrdersService();
  const root=dependencies.root||'/api/purchase-orders';
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:10*1024*1024,files:1,fields:1}});
  router.use(root,(req,res,next)=>{res.set('Cache-Control','no-store');next()},dependencies.requireAuth||requireAuth,requireFeature('purchase.view'));
  require('./purchaseOrdersRealtime').attachRealtime(router,root,dependencies.events,dependencies.presenceStore);
  const handle=fn=>async(req,res)=>{try{const key=req.get('Idempotency-Key');if(key&&['POST','PATCH'].includes(req.method)){if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(key))return res.status(400).json({code:'REQUEST_KEY_INVALID',error:'Mã lần lưu không hợp lệ.'});req.user={...req.user,_purchaseRequest:{key,fingerprint:createHash('sha256').update(req.method+' '+req.originalUrl+' '+JSON.stringify(req.body)).digest('hex')}}}await fn(req,res)}catch(error){if(error.code==='42P01'){error.statusCode=503;error.code='PURCHASE_MIGRATION_REQUIRED';error.message='Thu mua chưa khởi tạo xong dữ liệu. Các module khác vẫn hoạt động.'}const status=error.statusCode||500;res.status(status).json({code:error.code||'PURCHASE_FAILED',error:status<500?error.message:status===503?error.message:'Không xử lý được Thu mua.',...(error.rows?{rows:error.rows}:{}),...(error.conflicts?{conflicts:error.conflicts}:{})})}};
  router.get(root,handle(async(req,res)=>res.json({...await service.list(req.user),permissions:Object.fromEntries(['edit','import','export','depart','arrive'].map(k=>[k,hasFeature(req.user,'purchase.'+k)]))})));
  router.get(root+'/revision',handle(async(req,res)=>res.json(await service.revision(req.user))));
  router.get(root+'/employees',handle(async(req,res)=>res.json({rows:await service.employees(req.user)})));
  router.put(root+'/employees/batch',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.saveEmployees(req.user,req.body))));
  router.post(root+'/employees',requireFeature('purchase.edit'),handle(async(req,res)=>res.status(201).json(await service.createEmployee(req.user,req.body))));
  router.patch(root+'/employees/:id',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.updateEmployee(req.user,req.params.id,req.body))));
  router.get(root+'/trash',handle(async(req,res)=>res.json({rows:await service.trash(req.user)})));
  router.get(root+'/operations',handle(async(req,res)=>res.json({rows:await service.operations(req.user)})));
  for(const [path,method] of [['delete','remove'],['restore','restore'],['undo','undo']])router.post(root+'/'+path,requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service[method](req.user,req.body))));
  router.get(root+'/latest',handle(async(req,res)=>res.json({row:await service.latest(req.user,req.query.code)})));
  router.post(root+'/next-key',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.reserveKey(req.user))));
  router.get(root+'/history',handle(async(req,res)=>res.json({rows:await service.history(req.user,req.query.rowKey)})));
  router.post(root+'/export',requireFeature('purchase.export'),handle(async(req,res)=>{
    const allowed=new Set(columns.map(c=>c.k)),fields=req.body.fields,ids=req.body.ids;
    if(!Array.isArray(fields)||!fields.length||fields.some(k=>!allowed.has(k))||!Array.isArray(ids)||ids.length>10000||ids.some(id=>!/^\d+$/.test(String(id))))return res.status(400).json({code:'EXPORT_INVALID',error:'Danh sách dòng hoặc cột không hợp lệ.'});
    const selected=new Set(ids.map(String)),rows=(await service.exportRows(req.user)).filter(r=>selected.has(String(r.id)));
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('Thu-mua.xlsx').send(Buffer.from(workbook.bytes(workbook.exportWorkbook(rows,columns,fields))));
  }));
  router.get(root+'/export',requireFeature('purchase.export'),handle(async(req,res)=>{
    const allowed=new Set(columns.map(c=>c.k)),fields=req.query.fields?String(req.query.fields).split(','):columns.map(c=>c.k);
    if(fields.some(k=>!allowed.has(k)))return res.status(400).json({code:'EXPORT_FIELDS_INVALID',error:'Cột xuất không hợp lệ.'});
    const rows=await service.exportRows(req.user);const book=workbook.exportWorkbook(rows,columns,fields);
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('Thu-mua.xlsx').send(Buffer.from(workbook.bytes(book)));
  }));
  router.post(root,requireFeature('purchase.edit'),handle(async(req,res)=>res.status(201).json(await service.create(req.user,req.body))));
  router.patch(root+'/:id',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.update(req.user,req.params.id,req.body))));
  router.post(root+'/containers',requireFeature('purchase.edit'),handle(async(req,res)=>res.status(201).json(await service.createContainer(req.user,req.body))));
  router.patch(root+'/containers/:id',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.updateContainer(req.user,req.params.id,req.body))));
  router.post(root+'/plan',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.applyPlan(req.user,req.body))));
  router.post(root+'/status',requireFeature('purchase.edit'),handle(async(req,res)=>{const next=Number(req.body.status);if((next===3&&!hasFeature(req.user,'purchase.depart'))||(next===4&&!hasFeature(req.user,'purchase.arrive')))return res.status(403).json({error:'Chưa có quyền đổi sang trạng thái này.'});res.json(await service.changeStatus(req.user,req.body))}));
  router.post(root+'/schedule',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.schedule(req.user,req.body))));
  router.post(root+'/bulk',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.bulkEdit(req.user,req.body))));
  router.post(root+'/transfer',requireFeature('purchase.edit'),handle(async(req,res)=>res.json(await service.transfer(req.user,req.body))));
  router.post(root+'/depart',requireFeature('purchase.depart'),handle(async(req,res)=>res.json(await service.depart(req.user,req.body))));
  router.post(root+'/arrive',requireFeature('purchase.arrive'),handle(async(req,res)=>res.json(await service.arrive(req.user,req.body))));
  router.post(root+'/import/preview',requireFeature('purchase.import'),(req,res,next)=>upload.single('file')(req,res,error=>{
    if(error)return res.status(400).json({code:'IMPORT_FILE_INVALID',error:'Chỉ chọn một file, tối đa 10 MB.'});next();
  }),handle(async(req,res)=>{
    if(!req.file||!/\.xlsx$/i.test(req.file.originalname))return res.status(400).json({code:'IMPORT_FILE_INVALID',error:'Chọn file .xlsx.'});
    res.json(await service.previewImport(req.user,{buffer:req.file.buffer,sheetName:req.body.sheetName}));
  }));
  router.post(root+'/import/revise',requireFeature('purchase.import'),handle(async(req,res)=>{if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.body.token||''))return res.status(400).json({code:'IMPORT_TOKEN_INVALID',error:'Bản xem trước không hợp lệ.'});res.json(await service.reviseImport(req.user,req.body.token,req.body.rows))}));
  router.post(root+'/import/confirm',requireFeature('purchase.import'),handle(async(req,res)=>{
    if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(req.body.token||''))return res.status(400).json({code:'IMPORT_TOKEN_INVALID',error:'Bản xem trước không hợp lệ.'});
    res.json(await service.commitImport(req.user,req.body.token));
  }));
  return router;
}
module.exports=createPurchaseOrdersRouter();
module.exports.createPurchaseOrdersRouter=createPurchaseOrdersRouter;
