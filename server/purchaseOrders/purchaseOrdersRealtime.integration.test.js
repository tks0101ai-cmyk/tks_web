'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {attachRealtime,createPresenceStore}=require('./purchaseOrdersRealtime');
const tick=()=>new Promise(setImmediate);
function instance(store,events=new EventEmitter()){
 let handler;attachRealtime({get:(_,fn)=>handler=fn},'/purchase',events,store,{intervalMs:10});
 return {events,connect(){const req=new EventEmitter(),res=new EventEmitter(),chunks=[];req.user={id:'u',username:'Buyer'};Object.assign(res,{set(){},flushHeaders(){},write:chunk=>chunks.push(chunk)});handler(req,res);return {req,res,chunks,close:()=>req.emit('close')}}};
}
async function until(fn){for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,5))}assert.fail('timed out waiting for realtime state')}
test('two clients on independent instances observe committed DB revision; reconnect resyncs and cleanup removes resources',async t=>{
 let revision='1:1';const presence=new Set();const store={async touch(id){presence.add(id);return {users:[{id:'u',name:'Buyer'}],version:revision}},async remove(id){presence.delete(id)}};
 const a=instance(store),b=instance(store),one=a.connect(),two=b.connect();t.after(()=>{one.close();two.close()});await tick();
 assert.match(one.chunks.join(''),/"revision":"1:1"/);assert.match(two.chunks.join(''),/"revision":"1:1"/);
 revision='3:2';await until(()=>[one,two].every(p=>p.chunks.join('').includes('3:2')));
 // A lower sequence transaction commits later: max stays 3, count changes.
 revision='3:3';await until(()=>[one,two].every(p=>p.chunks.join('').includes('3:3')));
 a.events.emit('purchase-orders-changed',{draft:'private'});assert.doesNotMatch(one.chunks.join(''),/private/);
 one.close();two.close();await tick();assert.equal(presence.size,0);assert.equal(a.events.listenerCount('purchase-orders-changed'),0);assert.equal(b.events.listenerCount('purchase-orders-changed'),0);
 const count=one.chunks.length;await new Promise(r=>setTimeout(r,25));assert.equal(one.chunks.length,count);
 revision='4:4';const reconnect=a.connect();await tick();assert.match(reconnect.chunks.join(''),/"revision":"4:4"/);reconnect.close();await tick();assert.equal(presence.size,0);
});
test('many local clients share one event listener and receive payload-free committed invalidations',async()=>{
 const a=instance({touch:async()=>({users:[],version:'0:0'}),remove:async()=>{}}),clients=Array.from({length:14},()=>a.connect());
 try{assert.equal(a.events.listenerCount('purchase-orders-changed'),1);a.events.emit('purchase-orders-changed',{secret:'no'});for(const c of clients){assert.match(c.chunks.join(''),/event: changed\ndata: \{\}/);assert.doesNotMatch(c.chunks.join(''),/secret/)}}finally{clients.forEach(c=>c.close())}
 await tick();assert.equal(a.events.listenerCount('purchase-orders-changed'),0);
});
test('disconnect during presence query removes late insert; response error also cleans subscription',async()=>{
 let resolve,removed=0;const a=instance({touch:()=>new Promise(r=>resolve=r),remove:async()=>removed++}),c=a.connect();c.res.emit('error',Error('socket closed'));await tick();resolve({users:[],version:'1:1'});await tick();assert.equal(removed,2);assert.equal(a.events.listenerCount('purchase-orders-changed'),0);assert.doesNotMatch(c.chunks.join(''),/revision/);
});
test('presence store reads only public roster and committed history fingerprint',async()=>{
 const queries=[],pool={query:async(sql,args)=>{queries.push({sql,args});return {rows:sql.includes('AS version')?[{version:'9:8'}]:sql.startsWith('SELECT DISTINCT')?[{id:'u',name:'Buyer'}]:[]}}};
 const store=createPresenceStore(pool),snapshot=await store.touch('connection',{id:'u',username:'Buyer'});assert.equal(snapshot.version,'9:8');assert.match(queries[3].sql,/count\(\*\)/);await store.remove('connection');assert.deepEqual(queries.at(-1).args,['connection']);
});
test('real SQL presence expiry, actor deduplication, disconnect and late lower history id are detected',async()=>{
 const {PGlite}=require('@electric-sql/pglite');const db=new PGlite();
 try{
  await db.exec('CREATE TABLE purchase_presence(connection_id text PRIMARY KEY, actor_id text, actor_name text, expires_at timestamptz); CREATE TABLE purchase_history(id bigint PRIMARY KEY)');
  const store=createPresenceStore(db),user={id:'u',username:'Buyer'};
  assert.equal((await store.touch('a',user)).version,'0:0');
  await db.exec("INSERT INTO purchase_history VALUES(3); INSERT INTO purchase_presence VALUES('expired','old','Old',now()-interval '1 second')");
  const first=await store.touch('b',user);assert.equal(first.version,'3:1');assert.deepEqual(first.users,[{id:'u',name:'Buyer'}]);
  await db.exec('INSERT INTO purchase_history VALUES(2)');assert.equal((await store.touch('a',user)).version,'3:2');
  await store.remove('a');await store.remove('b');assert.equal((await db.query('SELECT * FROM purchase_presence')).rows.length,0);
 }finally{await db.close()}
});
test('router shares snapshot polling while renewing each connection separately',async t=>{
 let polls=0;const leases=new Set(),store={async renew(id){leases.add(id)},async snapshot(){polls++;return {users:[{id:'remote',name:'Remote'}],version:'7:4'}},async remove(id){leases.delete(id)}};
 const a=instance(store),clients=Array.from({length:8},()=>a.connect());t.after(()=>clients.forEach(c=>c.close()));await tick();assert.equal(polls,1);assert.equal(leases.size,8);
 for(const c of clients)assert.match(c.chunks.join(''),/"revision":"7:4"/);
 clients[0].close();await tick();assert.equal(leases.size,7);await until(()=>polls>=2);assert.ok(polls<8);
 clients.forEach(c=>c.close());await tick();const count=polls;await new Promise(r=>setTimeout(r,25));assert.equal(polls,count);assert.equal(leases.size,0);
});
test('shared SQL polling performs one cleanup, roster and history query per router tick',async t=>{
 const queries=[],pool={async query(sql,args){queries.push({sql,args});return {rows:sql.includes('AS version')?[{version:'8:3'}]:sql.startsWith('SELECT DISTINCT')?[{id:'u',name:'Buyer'}]:[]}}};
 const a=instance(createPresenceStore(pool)),clients=Array.from({length:6},()=>a.connect());t.after(()=>clients.forEach(c=>c.close()));await tick();
 assert.equal(queries.filter(q=>q.sql.startsWith('INSERT INTO purchase_presence')).length,6);
 assert.equal(queries.filter(q=>q.sql.includes('AS version')).length,1);
 assert.equal(queries.filter(q=>q.sql.startsWith('SELECT DISTINCT')).length,1);
 assert.equal(queries.filter(q=>q.sql.includes('expires_at<now()')).length,1);
 clients.forEach(c=>c.close());await tick();assert.equal(queries.filter(q=>q.sql.includes('connection_id=$1')).length,6);
});
test('slow shared snapshot never overlaps polls and does not send after disconnect',async t=>{
 let resolve,polls=0;const a=instance({async renew(){},snapshot(){polls++;return new Promise(r=>resolve=r)},async remove(){}}),c=a.connect();t.after(()=>c.close());
 await tick();await new Promise(r=>setTimeout(r,35));assert.equal(polls,1);c.close();const count=c.chunks.length;
 resolve({users:[],version:'9:4'});await tick();assert.equal(c.chunks.length,count);assert.equal(a.events.listenerCount('purchase-orders-changed'),0);
});
