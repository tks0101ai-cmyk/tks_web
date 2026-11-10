'use strict';
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
const {randomUUID}=require('node:crypto');
function createPresenceStore(poolOverride) {
  const pool=()=>poolOverride||require('../db/pool').getPool();
  const store={
    async renew(id,user){await pool().query("INSERT INTO purchase_presence(connection_id,actor_id,actor_name,expires_at) VALUES($1,$2,$3,now()+interval '45 seconds') ON CONFLICT(connection_id) DO UPDATE SET expires_at=excluded.expires_at",[id,String(user.id),String(user.hoTen||user.username||user.id)])},
    async snapshot(){
      await pool().query('DELETE FROM purchase_presence WHERE expires_at<now()');
      const users=(await pool().query('SELECT DISTINCT actor_id AS id,actor_name AS name FROM purchase_presence WHERE expires_at>now() ORDER BY actor_name')).rows;
      const version=(await pool().query("SELECT COALESCE(max(id),0)::text || ':' || count(*)::text AS version FROM purchase_history")).rows[0].version;
      return {users,version};
    },
    async touch(id,user){await store.renew(id,user);return store.snapshot()},
    async remove(id){await pool().query('DELETE FROM purchase_presence WHERE connection_id=$1',[id])}
  };return store;
}
function attachRealtime(router, root, events=dashboardRollupEvents, store=createPresenceStore(), options={}) {
  const peers=new Map();let timer=null,polling=null;
  const send=(res,event,data)=>{try{if(res.destroyed||res.writableEnded)return;res.write('event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n');res.flush?.()}catch{res.destroy?.()}};
  const broadcast=()=>{for(const p of peers.values())send(p.res,'changed',{})};
  const roster=()=>{const users=[...new Map([...peers.values()].map(p=>[String(p.user.id),{id:String(p.user.id),name:String(p.user.hoTen||p.user.username||p.user.id)}])).values()];for(const p of peers.values())send(p.res,'presence',users)};
  const degraded=p=>send(p.res,'degraded',{message:'Chưa theo dõi được phiên làm việc; dữ liệu vẫn kiểm tra định kỳ.'});
  function renew(p){
    if(p.renewing)return p.renewing;
    p.renewing=(async()=>{
      try{
        const snapshot=await (store.renew?store.renew(p.key,p.user):store.touch(p.key,p.user));
        if(p.closed){await store.remove(p.key);return}
        p.snapshot=snapshot;
      }catch{if(!p.closed)degraded(p)}
    })().finally(()=>{p.renewing=null});return p.renewing;
  }
  function heartbeat(){
    if(polling)return polling;
    polling=(async()=>{
      await Promise.all([...peers.values()].map(renew));
      if(!peers.size)return;
      let snapshot;
      try{if(store.snapshot)snapshot=await store.snapshot()}
      catch{for(const p of peers.values())degraded(p);return}
      for(const p of peers.values()){
        const current=snapshot||p.snapshot;if(!current)continue;
        send(p.res,'presence',current.users);
        if(p.version!==current.version)send(p.res,'changed',{revision:current.version});
        p.version=current.version;
        try{p.res.write(': heartbeat\n\n')}catch{p.res.destroy?.()}
      }
    })().finally(()=>{polling=null});return polling;
  }
  router.get(root+'/events',(req,res)=>{
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const key=randomUUID(),p={key,user:req.user,res,closed:false,renewing:null};peers.set(key,p);
    if(peers.size===1){events.on('purchase-orders-changed',broadcast);timer=setInterval(heartbeat,options.intervalMs||3000);timer.unref()}
    send(res,'ready',{});roster();
    const cleanup=()=>{
      if(p.closed)return;p.closed=true;req.off('close',cleanup);res.off?.('close',cleanup);res.off?.('error',cleanup);peers.delete(key);
      if(!peers.size){clearInterval(timer);timer=null;events.off('purchase-orders-changed',broadcast)}
      Promise.resolve().then(()=>store.remove(key)).catch(()=>{});roster();
    };
    req.on('close',cleanup);res.on?.('close',cleanup);res.on?.('error',cleanup);
    void renew(p);void heartbeat();
  });
}
module.exports={attachRealtime,createPresenceStore};
