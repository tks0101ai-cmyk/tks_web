'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {PGlite}=require('@electric-sql/pglite');
const {validateLayout,readLayout,writeLayout}=require('./printLayouts');
const layout={widths:[4,22,8,10,13,10,13,10,10],heights:[40,null],fonts:[{path:'table:nth-child(1) > tbody:nth-child(2) > tr:nth-child(1) > td:nth-child(2)',start:0,end:4,size:13}]};

test('delivery accepts its actual seven columns and footer tables persist independently',()=>{
 const input={widths:[5,30,8,12,13,20,12],heights:[],fonts:[],groups:{body:{columns:{1:{size:13,bold:true}}}},tables:{deliverySignatures:{widths:[30,30,40],heights:[],fonts:[],groups:{body:{columns:{2:{size:14,align:'right'}}}}}}};
 assert.deepEqual(validateLayout('delivery',input),input);
 assert.throws(()=>validateLayout('delivery',{...input,widths:[5,39,8,14,18,16]}),{statusCode:400});
 assert.throws(()=>validateLayout('delivery',{...input,tables:{summary:input.tables.deliverySignatures}}),{statusCode:400});
 assert.throws(()=>validateLayout('delivery',{...input,groups:{body:{columns:{7:{bold:true}}}}}),{statusCode:400});
});
test('shared layout accepts only formatting and valid template geometry',()=>{
 assert.deepEqual(validateLayout('order',layout),layout);
 for(const input of [{...layout,widths:[100]}, {...layout,heights:[-1]}, {...layout,fonts:[{...layout.fonts[0],path:'script'}]}, {...layout,fonts:[{...layout.fonts[0],size:99}]}])assert.throws(()=>validateLayout('order',input),{statusCode:400});
 assert.throws(()=>validateLayout('unknown',layout),{statusCode:400});
 assert.deepEqual(validateLayout('order',{...layout,html:'<script>bad</script>'}),layout);
});
test('two users share persisted form; templates isolated; stale writes rejected and reset persisted',async()=>{
 const db=new PGlite();
 try{
  await db.exec('CREATE ROLE reporting_readonly');
  await db.exec(fs.readFileSync(path.join(__dirname,'../db/migrations/0100_shared_print_layouts.sql'),'utf8'));
  assert.deepEqual(await readLayout(db,'order'),{layout:null,version:0});
  const shared={...layout,groups:{body:{height:42,size:12,columns:{1:{align:'center',bold:true,italic:true}}},header:{size:11}},blocks:[{path:'p:nth-child(1)',align:'right'}]};
  const first=await writeLayout(db,'order',{layout:shared,version:0},'user-a');
  assert.equal(first.version,1);
  assert.deepEqual((await readLayout(db,'order')).layout,shared);
  assert.deepEqual(await readLayout(db,'delivery'),{layout:null,version:0});
  await assert.rejects(writeLayout(db,'order',{layout,version:0},'user-b'),{statusCode:409});
  const second=await writeLayout(db,'order',{layout:{widths:[],heights:[],fonts:[]},version:1},'user-b');
  assert.equal(second.version,2);
  assert.equal((await db.query('SELECT updated_by FROM shared_print_layouts')).rows[0].updated_by,'user-b');
  assert.deepEqual((await readLayout(db,'order')).layout,{widths:[],heights:[],fonts:[]});
 }finally{await db.close();}
});

test('shared form validates table groups, column formatting and rich text without accepting arbitrary styles',()=>{
 const groups={body:{height:42,size:12,columns:{1:{align:'center',bold:true,italic:false}}},header:{height:36,size:11,columns:{1:{align:'left',bold:false}}}};
 const rich={...layout,groups,blocks:[{path:'p:nth-child(1)',align:'right'}],fonts:[{path:'p:nth-child(1)',start:0,end:4,bold:true,italic:false}]};
 assert.deepEqual(validateLayout('order',rich),rich);
 for(const bad of [
  {...rich,groups:{body:{height:-2}}},
  {...rich,groups:{body:{size:99}}},
  {...rich,groups:{body:{columns:{9:{bold:true}}}}},
  {...rich,groups:{body:{columns:{1:{align:'justify'}}}}},
  {...rich,groups:{header:{columns:{1:{italic:'yes'}}}}},
  {...rich,fonts:[{path:'p:nth-child(1)',start:0,end:4,bold:'yes'}]},
  {...rich,blocks:[{path:'script',align:'left'}]}
 ])assert.throws(()=>validateLayout('order',bad),{statusCode:400});
});
