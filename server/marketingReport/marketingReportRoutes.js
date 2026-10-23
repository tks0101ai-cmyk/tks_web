'use strict';
const express = require('express');
const { requireAuth, requireFeature, requireRole } = require('../auth/authMiddleware');
const { createMarketingReportService } = require('./marketingReportService');
const { createExportFile, tableRows, exportFieldsFor, resolveColumnKeys } = require('./marketingReportExport');

function createMarketingReportRouter({service=createMarketingReportService()}={}) {
  const router=express.Router();
  router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use(requireAuth,requireFeature('reports.marketing'));
  const handle=fn=>async(req,res)=>{
    try{res.json(await fn(req));}catch(error){
      if(error.statusCode && (error.code?.startsWith('MARKETING_')||error.code==='INVALID_MARKETING_INPUT'))return res.status(error.statusCode).json({error:error.message,code:error.code});
      console.error('[MarketingReport] Request failed:',error.code||'UNKNOWN');
      res.status(500).json({error:'Không tải được báo cáo Marketing. Vui lòng thử lại.',code:'MARKETING_REPORT_ERROR'});
    }
  };
  router.get('/metadata',handle(async req=>({...await service.metadata(),canEdit:req.user.vaiTro==='Quản lý'&&require('../auth/featureRegistry').hasFeature(req.user,'reports.marketing.edit')})));
  const actor=req=>({userId:String(req.user.id||req.user.username),username:req.user.username||'',name:req.user.hoTen||''});
  const manager=requireRole('Quản lý');
  const dbMethod=method=>{if(typeof service[method]!=='function')throw Object.assign(new Error('Nguồn PostgreSQL chưa được bật.'),{statusCode:409,code:'MARKETING_DATABASE_DISABLED'});return service[method];};
  router.get('/customers',handle(req=>dbMethod('customers')(req.query)));
  router.get('/sync-status',handle(()=>dbMethod('syncStatus')()));
  router.get('/aliases',handle(()=>dbMethod('aliases')()));
  router.put('/aliases',manager,requireFeature('reports.marketing.edit'),express.json({limit:'8kb'}),handle(req=>dbMethod('upsertAlias')(req.body,actor(req))));
  router.post('/monthly/rows',manager,requireFeature('reports.marketing.edit'),express.json({limit:'16kb'}),handle(req=>dbMethod('createRow')(req.body,actor(req))));
  router.put('/monthly/rows/:id',manager,requireFeature('reports.marketing.edit'),express.json({limit:'16kb'}),handle(req=>dbMethod('updateMonthlyRow')(req.params.id,req.body,actor(req))));
  router.get('/monthly/rows/:id/audit',manager,handle(req=>dbMethod('audit')(req.params.id)));
  for(const kind of ['monthly','receipt-check','phones','costs'])router.get('/'+kind,handle(req=>service.report(kind,req.query)));
  // Ghi ngược Khách mới / Ghi chú vào Google Sheets: cần thêm quyền reports.marketing.edit.
  router.put('/monthly/row',manager,requireFeature('reports.marketing.edit'),express.json({limit:'8kb'}),handle(req=>service.updateRow(req.body)));
  router.get('/detail',handle(req=>service.detail(req.query)));
  // Xuất bảng ra Excel/HTML: cần đồng thời reports.marketing (router.use ở trên) và reports.export.
  const exportContext=async req=>{
    const kind=String(req.query.kind||''),table=String(req.query.table||'');
    if(!['monthly','receipt-check','phones','costs'].includes(kind)||!['summary','rows'].includes(table)){
      const e=new Error('Bảng xuất không hợp lệ.');e.statusCode=400;e.code='MARKETING_EXPORT_INVALID';throw e;
    }
    const {kind:_k,table:_t,q,columns,format,sortKey,sortDir,...filters}=req.query;
    const result=await service.report(kind,filters);
    return {kind,table,result,rows:tableRows(table,result,q,{sortKey,sortDir})};
  };
  router.get('/export/fields',requireFeature('reports.export'),handle(async req=>{
    const {kind,table,result,rows}=await exportContext(req);
    return exportFieldsFor(kind,table,result,rows);
  }));
  router.get('/export',requireFeature('reports.export'),async(req,res)=>{
    try{
      const {kind,table,result,rows}=await exportContext(req);
      const keys=resolveColumnKeys(kind,table,result,req.query.columns);
      const file=await createExportFile(kind,table,String(req.query.format||'xlsx'),result,rows,keys);
      res.set('Content-Type',file.mimeType);
      res.set('Content-Disposition',`attachment; filename="${file.fileName}"`);
      res.send(file.buffer);
    }catch(error){
      if(error.statusCode&&(error.code?.startsWith('MARKETING_')||error.code==='INVALID_MARKETING_INPUT'))return res.status(error.statusCode).json({error:error.message,code:error.code});
      console.error('[MarketingReport] Export failed:',error.code||'UNKNOWN');
      res.status(500).json({error:'Không xuất được báo cáo Marketing. Vui lòng thử lại.',code:'MARKETING_REPORT_ERROR'});
    }
  });
  return router;
}
module.exports={createMarketingReportRouter};
