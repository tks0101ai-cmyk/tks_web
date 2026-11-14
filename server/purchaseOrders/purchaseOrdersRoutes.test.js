const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPurchaseOrdersRouter } = require('./purchaseOrdersRoutes');
const { ROLES } = require('../auth/userRepository');
const registry = require('../auth/featureRegistry');
const workbook = require('../public/shared/purchase-workbook');
const columns = require('../public/shared/purchase-columns');
async function start(t,user) {
  const calls=[];
  const record=name=>async(...args)=>{calls.push({name,args});return name==='revision'?{revision:'9:4'}:name==='importSnapshot'?{revision:'9:4',rows:[]}:name==='history'?[]:{ok:true}};
  const service=Object.fromEntries(['revision','changes','employees','saveEmployees','regions','saveRegions','createEmployee','updateEmployee','trash','inactive','containerTrash','inactiveContainers','deactivateContainer','reactivateContainer','removeContainer','restoreContainer','operations','remove','deactivate','reactivate','restore','undo','applyPlan','list','history','create','update','createContainer','updateContainer','schedule','changeStatus','bulkEdit','transfer','depart','arrive','importSnapshot','previewImport','reviseImport','commitImport','reserveKey','releaseKey'].map(name=>[name,record(name)]));
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user=user;next()});
  app.use(createPurchaseOrdersRouter({service,requireAuth:(req,res,next)=>req.user?next():res.status(401).json({error:'Chưa đăng nhập'})}));
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server))});t.after(()=>server.close());
  return {base:'http://127.0.0.1:'+server.address().port+'/api/purchase-orders',calls};
}
test('purchase permissions default to manager only and guests cannot be granted access',()=>{
  for(const role of Object.values(ROLES))assert.equal(registry.defaultsForRole(role).includes('purchase.view'),role===ROLES.QUAN_LY);
  assert.equal(registry.hasFeature({vaiTro:ROLES.KHACH,featurePermissions:{'purchase.view':true}},'purchase.view'),false);
});
test('unauthenticated and unauthorized users never reach service',async t=>{
  for(const [user,status] of [[null,401],[{id:'buyer',vaiTro:ROLES.NHAN_VIEN_MUA_HANG},403]]){
    const {base,calls}=await start(t,user);assert.equal((await fetch(base)).status,status);assert.equal((await fetch(base+'/events')).status,status);assert.equal(calls.length,0);
  }
});
test('view permission does not implicitly grant edit, import, export, departure or arrival',async t=>{
  const {base,calls}=await start(t,{id:'buyer',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}});
  assert.equal((await fetch(base)).status,200);
  for(const endpoint of ['/depart','/arrive','/import/preview','/import/confirm'])assert.equal((await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/import/snapshot')).status,403);
  assert.equal((await fetch(base+'/export')).status,403);assert.deepEqual(calls.map(x=>x.name),['list']);
});
test('snapshot download requires import permission and returns a workbook with headers',async t=>{
 const reader=await start(t,{id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}});
 assert.equal((await fetch(reader.base+'/import/snapshot')).status,403);assert.deepEqual(reader.calls.map(c=>c.name),[]);
 const manager=await start(t,{id:'manager',vaiTro:ROLES.QUAN_LY}),response=await fetch(manager.base+'/import/snapshot');
 assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);assert.match(response.headers.get('content-type'),/spreadsheetml/);
 const parsed=workbook.parseImportSnapshot(new Uint8Array(await response.arrayBuffer()),columns);assert.equal(parsed.revision,'9:4');assert.equal(parsed.rows.length,0);
 assert.deepEqual(manager.calls.map(c=>c.name),['importSnapshot']);
});
test('snapshot route enforces import capability and sends the generated attachment',async()=>{
 const user={id:'manager',vaiTro:ROLES.QUAN_LY},calls=[],service={importSnapshot:async actor=>{calls.push(actor);return {revision:'9:4',rows:[]}}};
 const router=createPurchaseOrdersRouter({service,requireAuth:(req,res,next)=>next()}),route=router.stack.find(layer=>layer.route?.path==='/api/purchase-orders/import/snapshot').route;
 let denied=0;await route.stack[0].handle({user:{id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG}}, {status(code){denied=code;return this},json(){return this}},()=>{});assert.equal(denied,403);assert.equal(calls.length,0);
 const headers={},response={type(value){headers.type=value;return this},set(name,value){headers[name]=value;return this},send(value){this.body=value;return this}},request={user,get:()=>undefined,method:'GET'};
 await route.stack.at(-1).handle(request,response);assert.equal(calls[0],user);assert.match(headers['Content-Disposition'],/attachment/);assert.match(headers.type,/spreadsheetml/);
 assert.equal(workbook.parseImportSnapshot(response.body,columns).revision,'9:4');
});
test('granting a specific action works while other action grants remain independent',async t=>{
  const {base,calls}=await start(t,{id:'buyer',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true,'purchase.arrive':true}});
  assert.equal((await fetch(base+'/arrive',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({containerId:1})})).status,200);
  assert.deepEqual(calls.map(x=>x.name),['arrive']);
  assert.equal((await fetch(base+'/depart',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
});
test('import commit accepts a token only, never client-generated write operations',async t=>{
  const {base,calls}=await start(t,{id:'ql',vaiTro:ROLES.QUAN_LY});
  const token='01234567-89ab-4def-8123-456789abcdef';
  const response=await fetch(base+'/import/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,operations:[{deleteAll:true}]})});
  assert.equal(response.status,200);assert.equal(calls[0].args.length,2);assert.equal(calls[0].args[1],token);
  assert.equal((await fetch(base+'/import/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"token":"invalid"}'})).status,400);
});

test('delete restore and undo require edit permission, directory requires purchase view only',async t=>{
 const {base,calls}=await start(t,{id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}});for(const path of ['/delete','/deactivate','/reactivate','/restore','/undo','/plan'])assert.equal((await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.equal((await fetch(base+'/employees')).status,200);assert.deepEqual(calls.map(c=>c.name),['employees']);
});

test('row key release requires edit permission and validates reservation ID',async t=>{
 const reader=await start(t,{id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}});
 assert.equal((await fetch(reader.base+'/release-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reservationId:'01234567-89ab-4def-8123-456789abcdef'})})).status,403);
 assert.deepEqual(reader.calls,[]);
 const manager=await start(t,{id:'manager',vaiTro:ROLES.QUAN_LY}),id='01234567-89ab-4def-8123-456789abcdef';
 for(const body of [{},{reservationId:'invalid'}])assert.equal((await fetch(manager.base+'/release-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,400);
 const response=await fetch(manager.base+'/release-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reservationId:id})});
 assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});
 assert.equal(manager.calls[0].name,'releaseKey');assert.deepEqual(manager.calls[0].args,[{id:'manager',vaiTro:ROLES.QUAN_LY},{reservationId:id}]);
});

test('history requires a positive internal order ID and forwards only that identity',async t=>{
 const {base,calls}=await start(t,{id:'manager',vaiTro:ROLES.QUAN_LY});
 for(const query of ['', '?orderId=0', '?orderId=-1', '?orderId=abc', '?rowKey=D00001'])assert.equal((await fetch(base+'/history'+query)).status,400);
 assert.equal(calls.length,0);
 const response=await fetch(base+'/history?orderId=123');assert.equal(response.status,200);assert.deepEqual(await response.json(),{rows:[]});
 assert.deepEqual(calls.map(call=>call.name),['history']);assert.deepEqual(calls[0].args,[{id:'manager',vaiTro:ROLES.QUAN_LY},'123']);
});

test('invalid request keys are rejected before a mutation reaches the service',async t=>{
 const {base,calls}=await start(t,{id:'manager',vaiTro:ROLES.QUAN_LY});const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'invalid'},body:'{}'});assert.equal(response.status,400);assert.equal(calls.length,0);
});


test('catalog writes require purchase edit and manager routes forward exact requests',async t=>{
 const reader=await start(t,{id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}});
 for(const [method,path] of [['POST','/employees'],['PATCH','/employees/7']])assert.equal((await fetch(reader.base+path,{method,headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal(reader.calls.length,0);
 const manager=await start(t,{id:'manager',vaiTro:ROLES.QUAN_LY});
 assert.equal((await fetch(manager.base+'/employees',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'A'})})).status,201);
 const body={version:2,changes:{name:'B',isActive:false}};
 assert.equal((await fetch(manager.base+'/employees/7',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,200);
 assert.deepEqual(manager.calls.map(c=>c.name),['createEmployee','updateEmployee']);assert.deepEqual(manager.calls[0].args[1],{name:'A'});assert.equal(manager.calls[1].args[1],'7');assert.deepEqual(manager.calls[1].args[2],body);
});

test('container patch forwards the complete shared row version snapshot',async t=>{
 const {base,calls}=await start(t,{id:'manager',vaiTro:ROLES.QUAN_LY});
 const body={version:3,changes:{arrivalNote:'2026-11-10',arrivalDate:'2026-11-11',assumedM3:185,maxTon:35,m3Min:150,m3Max:180},rows:[{id:'1',version:4}]};
 assert.equal((await fetch(base+'/containers/9',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,200);
 assert.equal(calls[0].name,'updateContainer');assert.equal(calls[0].args[1],'9');assert.deepEqual(calls[0].args[2],body);
});
test('container lifecycle routes require edit and expose inactive and trash collections',async t=>{
 const reader=await start(t,{id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}});
 for(const path of ['/containers/deactivate','/containers/reactivate','/containers/delete','/containers/restore'])assert.equal((await fetch(reader.base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(reader.base+'/containers/inactive')).status,200);assert.equal((await fetch(reader.base+'/containers/trash')).status,200);
 const manager=await start(t,{id:'manager',vaiTro:ROLES.QUAN_LY});
 for(const [path,method] of [['/containers/deactivate','deactivateContainer'],['/containers/reactivate','reactivateContainer'],['/containers/delete','removeContainer'],['/containers/restore','restoreContainer']]){
  assert.equal((await fetch(manager.base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'9',version:4})})).status,200);
 }
 assert.deepEqual(manager.calls.map(call=>call.name),['deactivateContainer','reactivateContainer','removeContainer','restoreContainer']);
});
test('revision endpoint requires purchase view and returns only the lightweight fingerprint',async t=>{
 for(const [user,status] of [[null,401],[{id:'buyer',vaiTro:ROLES.NHAN_VIEN_MUA_HANG},403],[{id:'guest',vaiTro:ROLES.KHACH,featurePermissions:{'purchase.view':true}},403]]){
  const p=await start(t,user);assert.equal((await fetch(p.base+'/revision')).status,status);assert.equal(p.calls.length,0);
 }
 const user={id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}},p=await start(t,user),response=await fetch(p.base+'/revision');
 assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),{revision:'9:4'});assert.deepEqual(p.calls.map(c=>c.name),['revision']);assert.deepEqual(p.calls[0].args,[user]);
});

test('changes route forwards the exact revision cursor to the view-only service',async()=>{
 const user={id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}},calls=[];
 const service={changes:async(...args)=>{calls.push(args);return {revision:'10:5',rows:[],deletedIds:[],containers:[],sourceMode:'web',integrationEnabled:false,employeesChanged:false,reset:false}}};
 const router=createPurchaseOrdersRouter({service,requireAuth:(req,res,next)=>next()}),route=router.stack.find(layer=>layer.route?.path==='/api/purchase-orders/changes').route;
 let body;const response={set(){return this},json(value){body=value;return this}};
 await route.stack[0].handle({user,method:'GET',get:()=>undefined,originalUrl:'/api/purchase-orders/changes?after=9%3A4',query:{after:'9:4'},body:{}},response);
 assert.deepEqual(body,{revision:'10:5',rows:[],deletedIds:[],containers:[],sourceMode:'web',integrationEnabled:false,employeesChanged:false,reset:false});assert.deepEqual(calls,[[user,'9:4']]);
});
