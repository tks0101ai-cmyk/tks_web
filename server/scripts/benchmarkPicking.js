'use strict';
// Offline fixture benchmark. No external API or production database is used.
process.env.NODE_ENV='test';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON='{}';
process.env.JWT_SECRET='offline-benchmark';
process.env.REDIS_ENABLED='false';
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {execFileSync}=require('node:child_process');
const {PGlite}=require('@electric-sql/pglite');

async function main(){
  const baseline=process.argv.find(v=>v.startsWith('--baseline='))?.split('=')[1]||'439fdab5';
  if(!/^[a-f0-9]{7,40}$/.test(baseline))throw Error('baseline must be a commit hash');
  const latency=Number(process.argv.find(v=>v.startsWith('--latency-ms='))?.split('=')[1]||0);
  if(!Number.isFinite(latency)||latency<0||latency>100)throw Error('latency must be 0..100ms');
  const filename=path.resolve(__dirname,'../pickAssignments/pickAssignmentsService.js');
  const oldModule=new Module(filename,module);oldModule.filename=filename;oldModule.paths=Module._nodeModulePaths(path.dirname(filename));
  oldModule._compile(execFileSync('git',['show',`${baseline}:server/pickAssignments/pickAssignmentsService.js`],{cwd:path.resolve(__dirname,'../..'),encoding:'utf8'}),filename);
  const factories=[['baseline',oldModule.exports.createPickAssignmentsService],['optimized',require(filename).createPickAssignmentsService]];
  const db=new PGlite(),rows=[];
  try{
    for(const file of ['0001_core_master_data.sql','0064_sheet_snapshots.sql','0095_stock_positions.sql','0096_order_pick_assignments.sql','0097_order_pick_assignment_snapshots.sql','0098_order_pick_history_mismatch_ack.sql'])
      await db.exec(fs.readFileSync(path.resolve(__dirname,'../db/migrations',file),'utf8'));
    await db.exec('ALTER TABLE stock_positions ADD COLUMN IF NOT EXISTS format_ack BOOLEAN NOT NULL DEFAULT false');
    for(let i=0;i<100;i++)await db.query('INSERT INTO stock_positions(branch,code,notes,location) VALUES ($1,$2,$3,$4)',['HN','P'+i,'100T x 100','A'+i]);
    let tail=Promise.resolve();
    const acquire=async()=>{const previous=tail;let release;tail=new Promise(r=>{release=r;});await previous;return release;};
    for(const [version,factory] of factories){
      for(const count of [1,20,100]){
        let queries=0,lineWrites=0;
        const query=async(sql,params)=>{queries++;if(/INSERT INTO order_pick_lines\b/.test(sql))lineWrites++;if(latency)await new Promise(r=>setTimeout(r,latency));return db.query(sql,params);};
        // One local PGlite instance: serialize transactions instead of interleaving BEGIN/COMMIT.
        const pool={query:async(sql,p)=>{const release=await acquire();try{return await query(sql,p);}finally{release();}},connect:async()=>{const release=await acquire();return {query,release};}};
        const service=factory({getDb:()=>pool,loadOrder:async({orderCode})=>({branch:'HN',orderCode,customerName:'Fixture',saleName:'Fixture',invoiceDiscount:0,
          status:{code:'SENT_TO_ACCOUNTANT',label:'Fixture'},lines:Array.from({length:count},(_,i)=>({productCode:'P'+i,productName:'Fixture '+i,quantity:1,price:10,discount:0}))})});
        for(const phase of ['first-pass','repeat-pass']){
          const samples=[],before=queries,writesBefore=lineWrites;
          await Promise.all(Array.from({length:5},async(_,user)=>{
            const orderCode=`BENCH-${version}-${count}-${phase}-${user}`;
            const start=performance.now();
            const result=await service.candidates({user:{id:'bench'}},{branch:'HN',orderCode});
            if(result.order.lines.length!==count)throw Error('wrong fixture candidates');
            const assigned=await service.assign({user:{id:'bench'}},{branch:'HN',orderCode,allocations:Array.from({length:count},(_,i)=>({productCode:'P'+i,positionId:i+1,qty:1}))});
            if(assigned.assignment.lines.length!==count)throw Error('wrong fixture assignment');
            samples.push(performance.now()-start);
          }));
          samples.sort((a,b)=>a-b);
          rows.push({version,lines:count,phase,concurrency:5,p50Ms:Math.round(samples[2]),p95Ms:Math.round(samples[4]),queries:queries-before,lineWrites:lineWrites-writesBefore});
        }
      }
    }
  }finally{await db.close();}
  console.log(JSON.stringify({kind:'offline-serialized-PGlite-fixture',baseline,injectedQueryLatencyMs:latency,
    limitation:'Measures candidates+assign only, not production API/network, Redis cold/warm or browser print. Five samples per case; not a production SLO result.',results:rows},null,2));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
