const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPurchaseOrdersRouter } = require('./purchaseOrdersRoutes');
const { ROLES } = require('../auth/userRepository');
const registry = require('../auth/featureRegistry');
async function start(t,user) {
  const calls=[];
  const record=name=>async(...args)=>{calls.push({name,args});return {ok:true}};
  const service=Object.fromEntries(['employees','trash','operations','remove','restore','undo','applyPlan','list','history','create','update','createContainer','updateContainer','schedule','changeStatus','bulkEdit','transfer','depart','arrive','previewImport','reviseImport','commitImport'].map(name=>[name,record(name)]));
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
  for(const endpoint of ['', '/depart','/arrive','/import/preview','/import/confirm'])assert.equal((await fetch(base+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/export')).status,403);assert.deepEqual(calls.map(x=>x.name),['list']);
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
 const {base,calls}=await start(t,{id:'reader',vaiTro:ROLES.NHAN_VIEN_MUA_HANG,featurePermissions:{'purchase.view':true}});for(const path of ['/delete','/restore','/undo','/plan'])assert.equal((await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);assert.equal((await fetch(base+'/employees')).status,200);assert.deepEqual(calls.map(c=>c.name),['employees']);
});

test('invalid request keys are rejected before a mutation reaches the service',async t=>{
 const {base,calls}=await start(t,{id:'manager',vaiTro:ROLES.QUAN_LY});const response=await fetch(base,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'invalid'},body:'{}'});assert.equal(response.status,400);assert.equal(calls.length,0);
});
