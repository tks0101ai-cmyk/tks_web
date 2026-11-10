'use strict';

// Run only after the deployed app exposes integrationEnabled in its API.
// This is an explicit operational command, never a startup migration.
async function configureIsolatedMode({pool,logger=console}){
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query('SELECT pg_advisory_xact_lock($1)',[20531015]);
  const applied=await client.query('SELECT 1 FROM schema_migrations WHERE filename=$1',['0117_purchase_isolated_workflow.sql']);
  if(!applied.rowCount)throw Error('Chưa có migration cách ly 0117; chưa mở ghi.');
  await client.query('SELECT id FROM purchase_settings WHERE id=1 FOR UPDATE');
  const settings=await client.query("UPDATE purchase_settings SET integration_enabled=false,projection_owns_all=false,source_mode='web' WHERE id=1 RETURNING source_mode,integration_enabled");
  if(settings.rowCount!==1)throw Error('Thiếu cấu hình Thu mua.');
  await client.query('COMMIT');
  logger.log('[Purchase] Đã mở ghi riêng Thu mua; không xuất thay đổi sang module khác.');
  return settings.rows[0];
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error}
 finally{client.release()}
}
module.exports={configureIsolatedMode};
if(require.main===module){
 if(!process.argv.includes('--enable')){console.error('Dùng: node purchaseOrders/configureIsolatedMode.js --enable');process.exitCode=1;}
 else{const pool=require('../db/pool').getPool();configureIsolatedMode({pool}).catch(e=>{console.error(e.message);process.exitCode=1}).finally(()=>pool.end())}
}
