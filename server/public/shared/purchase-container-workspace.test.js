const {test}=require('node:test');
const assert=require('node:assert/strict');
const {JSDOM}=require('jsdom');
const fs=require('node:fs');
const W=require('./purchase-container-workspace');
const containers=[{id:1,name:'B',status:1},{id:2,name:'A',status:2},{id:3,name:'C',status:3},{id:4,name:'D',status:4}];
const rows=[{contId:null,cartonCount:2,kgPerCarton:100,m3PerCarton:.1},{contId:'1',cartonCount:3,kgPerCarton:100,m3PerCarton:.1},{contId:2,cartonCount:null}];
test('statusSummary totals supplied draft-aware rows and includes empty containers',()=>{
 const s=W.statusSummary({containers,rows});
 assert.deepEqual(s.map(x=>x.status),['waiting',1,2,3,4]);
 assert.deepEqual(s.map(x=>[x.containerCount,x.count,x.ton,x.m3,x.missing]),[[0,1,.2,.2,0],[1,1,.3,.3,0],[1,1,0,0,1],[1,0,0,0,0],[1,0,0,0,0]]);
 assert.deepEqual(W.statusSummary({}).map(x=>x.count),[0,0,0,0,0]);
});
test('groupContainers keeps waiting first under every sort and never mutates input',()=>{
 for(const sort of ['name','status','ton','m3','count'])for(const direction of ['asc','desc']){
  const groups=W.groupContainers({containers,rows,sort,direction});assert.equal(groups[0].c.id,null);assert.equal(groups.length,5);
 }
 assert.deepEqual(W.groupContainers({containers,rows,sort:'name'}).slice(1).map(x=>x.c.id),[2,1,3,4]);
 assert.equal(rows[0].contId,null);assert.equal(containers[0].id,1);
});
test('statusMarkup renders accessible filter hooks and accepts numeric selected status',()=>{
 const dom=new JSDOM(W.statusMarkup({containers,rows,selectedStatus:2}));const buttons=[...dom.window.document.querySelectorAll('button[data-container-status]')];
 assert.equal(buttons.length,5);assert.deepEqual(buttons.map(b=>b.dataset.containerStatus),['waiting','1','2','3','4']);
 assert.equal(buttons[2].getAttribute('aria-pressed'),'true');assert.match(buttons[0].textContent,/Chờ xếp/);
 let chosen;dom.window.document.body.addEventListener('click',e=>{chosen=e.target.closest('[data-container-status]')?.dataset.containerStatus});buttons[1].querySelector('span').click();assert.equal(chosen,'1');
 assert.equal(new JSDOM(W.statusMarkup({selectedStatus:'waiting'})).window.document.querySelector('button').getAttribute('aria-pressed'),'true');
});
test('containerEditorMarkup supports snake-case data, safe fields and readonly computed values in both clones',()=>{
 const c={id:'<bad>',name:'\"/><script>bad()</script>',truck_name:'18.5m',name_cn:'中',freight_mode:'manual',freight:123,max_ton:30,m3_min:150,m3_max:180};
 const markup=W.containerEditorMarkup(c,{rows:[{...rows[0],contId:c.id}]});const doc=new JSDOM(markup+markup).window.document;
 assert.equal(doc.querySelectorAll('script').length,0);assert.equal(doc.querySelectorAll('[id]').length,0);
 const editors=doc.querySelectorAll('[data-container-editor]');assert.equal(editors.length,2);
 const fields=['name','truckName','carrier','loader','nameCn','loading','arrivalNote','arrivalDate','freight','freightMode','freightBase','freightCapacity','maxTon','m3Min','m3Max'];
 for(const field of fields)assert.ok(editors[0].querySelector('[name="'+field+'"][data-container-field="'+field+'"]'),field);
 assert.equal(editors[0].querySelector('[name=name]').value,c.name);assert.equal(editors[0].querySelector('[name=truckName]').value,'18.5m');
 assert.equal(editors[0].querySelector('[name=maxTon]').value,'30');assert.equal(editors[0].querySelector('[name=freightMode]').value,'manual');
 for(const key of ['count','ton','m3'])assert.ok(editors[0].querySelector('output[data-container-computed="'+key+'"]'));
 assert.equal(editors[0].querySelector('[data-container-computed=ton]').textContent,'0.2');
 assert.equal(editors[0].querySelector('[data-container-computed=count]').textContent,'1');
});
test('containerEditorMarkup preserves camel-case zero values and derives formula freight',()=>{
 const doc=new JSDOM(W.containerEditorMarkup({id:1,freightMode:'formula',freightBase:100,freightCapacity:2,maxTon:0},{rows})).window.document;
 assert.equal(doc.querySelector('[name=freight]').value,'15');assert.equal(doc.querySelector('[name=maxTon]').value,'0');
 assert.equal(doc.querySelector('[name=freightMode]').value,'formula');
});
test('browser UMD exposes same API using existing calculation and freight globals',()=>{
 const dom=new JSDOM('',{runScripts:'outside-only'});
 for(const name of ['purchase-calculations','purchase-freight','purchase-container-workspace'])dom.window.eval(fs.readFileSync(require.resolve('./'+name),'utf8'));
 assert.equal(dom.window.PurchaseContainerWorkspace.statusSummary({}).length,5);
});
