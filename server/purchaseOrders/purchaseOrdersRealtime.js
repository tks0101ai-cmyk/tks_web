'use strict';
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
const {randomUUID}=require('node:crypto');
function createPresenceStore(poolOverride) {
  const {getPool}=require('../db/pool');
  return {
    async touch(id,user){
      const pool=poolOverride||getPool();
      await pool.query("INSERT INTO purchase_presence(connection_id,actor_id,actor_name,expires_at) VALUES($1,$2,$3,now()+interval '45 seconds') ON CONFLICT(connection_id) DO UPDATE SET expires_at=excluded.expires_at",[id,String(user.id),String(user.hoTen||user.username||user.id)]);
      await pool.query('DELETE FROM purchase_presence WHERE expires_at<now()');
      const users=(await pool.query('SELECT DISTINCT actor_id AS id,actor_name AS name FROM purchase_presence WHERE expires_at>now() ORDER BY actor_name')).rows;
      const version=(await pool.query('SELECT COALESCE(max(id),0)::text AS version FROM purchase_history')).rows[0].version;
      return {users,version};
    },
    async remove(id){await (poolOverride||getPool()).query('DELETE FROM purchase_presence WHERE connection_id=$1',[id])}
  };
}
function attachRealtime(router, root, events=dashboardRollupEvents, store=createPresenceStore()) {
  const peers=new Map();
  const send=(res,event,data)=>{res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');res.flush?.()};
  const roster=()=>{const users=[...new Map([...peers.values()].map(p=>[String(p.user.id),{id:String(p.user.id),name:String(p.user.hoTen||p.user.username||p.user.id)}])).values()];for(const p of peers.values())send(p.res,'presence',users)};
  router.get(root+'/events',(req,res)=>{
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const key=randomUUID();peers.set(key,{user:req.user,res});
    const changed=()=>send(res,'changed',{});
    events.on('purchase-orders-changed',changed);send(res,'ready',{});roster();
    let closed=false,busy=false,version;
    const heartbeat=async()=>{
      if(busy||closed)return;busy=true;
      try{const snapshot=await store.touch(key,req.user);if(closed){await store.remove(key);return}send(res,'presence',snapshot.users);if(version!==undefined&&version!==snapshot.version)changed();version=snapshot.version;res.write(': heartbeat\n\n')}
      catch{if(!closed)send(res,'degraded',{message:'Chưa theo dõi được phiên làm việc; dữ liệu vẫn kiểm tra định kỳ.'})}
      finally{busy=false}
    };
    heartbeat();const timer=setInterval(heartbeat,10000);timer.unref();
    req.on('close',()=>{closed=true;clearInterval(timer);events.off('purchase-orders-changed',changed);peers.delete(key);store.remove(key).catch(()=>{});roster()});
  });
}
module.exports={attachRealtime,createPresenceStore};
