'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const settle = async () => { for(let i=0;i<8;i++) await new Promise(r=>setImmediate(r)); };
const payload = (overrides={}) => ({ from:'2026-08-06',to:'2026-11-03',page:1,pageSize:25,totalRows:30,canViewCost:true,
  summary:{purchaseQuantity:32,returnQuantity:2,purchaseCount:28,returnCount:2,orderQuantity:7.5,orderCount:3},
  rows:[{time:'2026-11-03T23:59:59',branch:'hanoi',documentCode:'HD1',customerName:'Đặng <Mỹ>',type:'invoice',quantity:2,unitCost:null}],...overrides });
function setup() {
  const dom=new JSDOM('<section class="dp-section" id="history"></section>',{runScripts:'outside-only',url:'https://example.test'});
  const calls=[];
  dom.window.fetch=url=>new Promise(resolve=>calls.push({url,resolve}));
  dom.window.TKSTables={enhance:()=>{}};
  dom.window.eval(fs.readFileSync(path.join(__dirname,'../../public/js/product-history.js'),'utf8'));
  const root=dom.window.document.getElementById('history');
  let current=true;
  dom.window.TKSProductHistory.mount(root,{code:'SP1',isCurrent:()=>current});
  return {dom,root,calls,close:()=>{current=false;},answer:(index,data=payload(),ok=true)=>calls[index].resolve({ok,json:async()=>data})};
}
test('history renders safely; search and type reset page, summaries follow API and pagination keeps filters',async()=>{
  const p=setup();
  p.answer(0);await settle();
  assert.match(p.root.textContent,/Đặng <Mỹ>/);
  assert.equal(p.root.querySelector('tbody td').textContent,'03/11/2026 23:59');
  assert.equal(p.root.querySelector('tbody td:last-child').textContent,'—');
  assert.equal(p.root.querySelector('my'),null);
  p.root.querySelector('[data-action="next"]').click();
  assert.equal(new URL(p.calls[1].url,'https://x').searchParams.get('page'),'2');
  p.answer(1,payload({page:2}));await settle();
  const input=p.root.querySelector('input');input.value='dang';input.dispatchEvent(new p.dom.window.Event('input'));
  await new Promise(r=>setTimeout(r,230));
  const query=new URL(p.calls[2].url,'https://x').searchParams;
  assert.equal(query.get('page'),'1');assert.equal(query.get('q'),'dang');
  p.answer(2,payload({totalRows:1,summary:{purchaseQuantity:2,returnQuantity:0,purchaseCount:1,returnCount:0}}));await settle();
  assert.equal(p.root.querySelector('[data-stat="purchaseQuantity"]').textContent,'2');
  const select=p.root.querySelector('select');select.value='return';select.dispatchEvent(new p.dom.window.Event('change'));
  assert.equal(new URL(p.calls[3].url,'https://x').searchParams.get('q'),'dang');
  assert.equal(new URL(p.calls[3].url,'https://x').searchParams.get('type'),'return');
  p.answer(3,payload({totalRows:0,rows:[],summary:{purchaseQuantity:0,returnQuantity:0,purchaseCount:0,returnCount:0}}));await settle();
  assert.match(p.root.textContent,/Không có giao dịch/);
  assert.equal(p.root.querySelector('[data-stat="purchaseCount"]').textContent,'0');
  p.dom.window.close();
});
test('history ignores stale results, supports retry, hides cost, and ignores closed modal',async()=>{
  const p=setup();
  const select=p.root.querySelector('select');select.value='return';select.dispatchEvent(new p.dom.window.Event('change'));
  p.answer(1,payload({canViewCost:false}));await settle();
  assert.doesNotMatch(p.root.querySelector('thead').textContent,/Giá vốn/);
  p.answer(0,payload({rows:[]}));await settle();
  assert.match(p.root.textContent,/Đặng/);
  select.value='all';select.dispatchEvent(new p.dom.window.Event('change'));
  p.answer(2,{},false);await settle();
  assert.match(p.root.textContent,/Không tải được/);
  p.root.querySelector('[data-action="retry"]').click();
  p.close();p.answer(3);await settle();
  assert.doesNotMatch(p.root.textContent,/Đặng/);
  p.dom.window.close();
});

test('history separates draft totals and document column; sorts on server and exports the active filters and columns',async()=>{
  const p=setup();
  p.dom.window.TKSNav={can:()=>true};
  p.dom.window.openExportDialog=key=>{p.exportKey=key;};
  p.answer(0,payload({rows:[{time:'2026-11-03T12:30:00',branch:'saigon',documentCode:'DH1',customerName:'Khách B',type:'order',quantity:7.5}]}));
  await settle();
  assert.deepEqual([...p.root.querySelectorAll('th')].map(th=>th.dataset.columnKey),['time','type','documentCode','customerName','quantity','unitCost']);
  assert.equal(p.root.querySelector('tbody tr').cells[2].textContent,'DH1 · SG');
  assert.match(p.root.querySelector('tbody tr').cells[1].textContent,/Phiếu tạm/);
  assert.equal(p.root.querySelector('[data-stat="orderQuantity"]').textContent,'7,5');
  assert.equal(p.root.querySelector('[data-stat="orderCount"]').textContent,'3');
  assert.equal(p.root.querySelector('[data-column-key="unitCost"]').dataset.columnDefaultHidden,'true');
  p.root.querySelector('[data-sort="quantity"] button').click();
  const query=new URL(p.calls[1].url,'https://x').searchParams;
  assert.equal(query.get('sort'),'quantity');assert.equal(query.get('dir'),'asc');assert.equal(query.get('page'),'1');
  p.answer(1);await settle();
  const select=p.root.querySelector('select');select.value='order';select.dispatchEvent(new p.dom.window.Event('change'));
  p.answer(2);await settle();
  p.dom.window.TKSTables.getState=()=>({columns:[{key:'time',hidden:false},{key:'type',hidden:true},{key:'quantity',hidden:false}]});
  p.root.querySelector('[data-action="export"]').click();
  assert.equal(p.exportKey,'products.productHistory');
  const state=JSON.parse(JSON.stringify(p.dom.window.TKSProductHistory.exportState()));
  assert.deepEqual(state,{context:{productCode:'SP1',historyType:'order',historyQuery:''},tableSort:{label:'Số lượng',direction:'asc'},columns:{product_history:['time','quantity']}});
  p.close();assert.equal(p.dom.window.TKSProductHistory.exportState(),null);
  p.dom.window.close();
});
