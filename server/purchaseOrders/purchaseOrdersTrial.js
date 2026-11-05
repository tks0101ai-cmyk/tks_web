'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {EventEmitter}=require('node:events');
const {getPool}=require('../db/pool');
const {FILES}=require('../db/ensurePurchaseSchema');
const {createPurchaseOrdersService}=require('./purchaseOrdersService');
const {createPresenceStore}=require('./purchaseOrdersRealtime');
const {seedSampleData}=require('./seedSampleData');

// Fail closed: public is deliberately absent. A missing sandbox table must
// fail instead of resolving to the identically named production table.
function trialPool(source){
  async function connect(){
    const client=await source.connect();
    try{await client.query('SET search_path TO purchase_trial, pg_catalog, pg_temp')}
    catch(error){client.release(error);throw error}
    let released;
    return {query:(sql,args)=>client.query(sql,args),release(){
      if(!released)released=client.query('RESET search_path').then(()=>client.release(),error=>client.release(error));
      return released;
    }};
  }
  return {connect,async query(sql,args){const client=await connect();try{return await client.query(sql,args)}finally{await client.release()}}};
}

function createPurchaseTrial({requireAuth,pool:sourcePool,routerFactory}={}){
  const events=new EventEmitter();let pending;
  async function initialize(){
    const pool=trialPool(sourcePool||getPool());const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout='5s'");
      await client.query("SET LOCAL statement_timeout='30s'");
      await client.query('SELECT pg_advisory_xact_lock(20531016)');
      await client.query('CREATE SCHEMA IF NOT EXISTS purchase_trial');
      await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(filename text PRIMARY KEY)');
      for(const file of FILES){
        const prior=await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1',[file]);
        if(prior.rowCount)continue;
        await client.query(fs.readFileSync(path.join(__dirname,'../db/migrations',file),'utf8'));
        await client.query('INSERT INTO schema_migrations(filename) VALUES($1)',[file]);
      }
      await client.query(`CREATE TABLE IF NOT EXISTS hr_employees(id bigint PRIMARY KEY,ho_ten text,bo_phan text,branch text,is_active boolean,employment_status text);
        INSERT INTO hr_employees VALUES(1,'An (mẫu)','Thu mua','hanoi',true,'active'),(2,'Bình (mẫu)','Thu mua','hanoi',true,'active'),(3,'Chi (mẫu)','Thu mua','hanoi',true,'active') ON CONFLICT DO NOTHING;`);
      const seeded=await client.query("SELECT 1 FROM schema_migrations WHERE filename='trial_sample_v1'");
      if(!seeded.rowCount){
        await seedSampleData({pool:{connect:async()=>({query:(sql,args)=>client.query(sql,args),release(){}})},logger:{log(){}},manageTransaction:false});
        await client.query("INSERT INTO schema_migrations(filename) VALUES('trial_sample_v1')");
      }
      await client.query("UPDATE purchase_settings SET source_mode='web' WHERE id=1");
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
    finally{await client.release()}
    // No production projection, cache invalidation or cross-module events.
    const service=createPurchaseOrdersService({pool,events,project:async()=>{},lockKey:20531016,invalidate:()=>{}});
    return {pool,service};
  }
  function state(){if(!pending)pending=initialize().catch(error=>{
    pending=null;console.error('[Purchase trial] Initialization failed:',error.code||'UNKNOWN');
    throw Object.assign(new Error('Chưa mở được dữ liệu dùng thử. Thu mua chính vẫn được giữ nguyên.'),{statusCode:503,code:'PURCHASE_TRIAL_UNAVAILABLE',cause:error});
  });return pending}
  const service=new Proxy({}, {get(_target,method){return async(...args)=>{
    const trial=await state();const result=await trial.service[method](...args);
    return method==='list'?{...result,trialMode:true}:result;
  }}});
  const presence={async touch(...args){return createPresenceStore((await state()).pool).touch(...args)},async remove(...args){if(pending)return createPresenceStore((await state()).pool).remove(...args)}};
  const createRouter=routerFactory||require('./purchaseOrdersRoutes').createPurchaseOrdersRouter;
  const router=createRouter({root:'/api/purchase-trial',service,events,presenceStore:presence,...(requireAuth?{requireAuth}:{})});
  return {router,state};
}
module.exports={createPurchaseTrial,trialPool};
