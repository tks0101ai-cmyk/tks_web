'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {JSDOM} = require('jsdom');
const {makeOrderSnapshot} = require('../../pickAssignments/pickOrderSnapshot');
const dir = path.join(__dirname, '../../public/shipment/lifecycle/pick');

test('both print templates use one shared notice footer and remove the old metadata footer', async () => {
  const order={schemaVersion:2,orderCode:'DH-footer',branch:'HN',lines:Array.from({length:80},(_,i)=>({productCode:'P'+i,productName:'Hàng '+i,quantity:1,unitPrice:'10',amount:'10'}))};
  const record={status:'picking',lines:[]};
  const dom=await invoice(order,record);
  try {
    const d=dom.window.document,notice=d.querySelector('.invoice-notice').outerHTML;
    for(const template of ['delivery','order']){
      await dom.window.PickingInvoice.show(order,record,template);
      assert.equal(d.querySelectorAll('.invoice-notice').length,1);
      assert.equal(d.querySelector('.invoice-notice').outerHTML,notice);
      assert.match(d.querySelector('.invoice-notice').textContent,/kiểm hàng thừa\/thiếu\/vỡ trong vòng 3 ngày/);
      assert.equal(d.querySelector('.invoice-demo'),null);
      assert.equal(d.querySelectorAll('.invoice-goods tbody tr').length,80);
      dom.window.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));
      const exported=new JSDOM(dom.window.PickingPrint.document());
      try {
        assert.equal(exported.window.document.querySelectorAll('.print-page-layout>tfoot>tr>td').length,1,'reserve footer space on each printed page');
        assert.equal(exported.window.document.querySelectorAll('.print-page-layout .invoice-notice').length,1);
        assert.match(exported.window.document.querySelector('style').textContent,/\.invoice-notice\{position:fixed;left:0;right:0;bottom:0\}/,'keep the footer inside the printable area');
      } finally {exported.window.close();}
    }
  } finally {dom.window.close();}
});

async function invoice(order, record) {
  const dom = new JSDOM('<dialog id="pickingPrintDialog"></dialog><div id="pickingPrintTitle"></div><p id="pickingPrintMessage"></p><div id="pickingPrintSheet"></div>', {runScripts:'outside-only'});
  const w = dom.window;
  w.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  w.PickingInvoiceTemplate = fs.readFileSync(path.join(dir,'order-template.tpl'),'utf8');
  w.PickingPrintCSS = fs.readFileSync(path.join(dir,'invoice-a4.css'),'utf8');
  w.eval(fs.readFileSync(path.join(dir,'invoice.js'),'utf8'));
  await w.PickingInvoice.show(order, record);
  return dom;
}

test('v2 print uses original amounts, keeps ST and prints placement once per code', async () => {
  const order = {...makeOrderSnapshot({invoiceDiscount:0, lines:[
    {productCode:'A', productName:'Hàng A', quantity:10000, price:10, discount:0},
    {productCode:'a', productName:'Hàng A', quantity:1, price:11, discount:0}
  ]}), orderCode:'DH1', branch:'HN'};
  const dom = await invoice(order, {status:'picking', lines:[{productCode:'A',location:'A07',plannedQty:10001,stText:'101Tx100-99',stCartons:100.01}]});
  try {
    const d=dom.window.document;
    assert.equal(d.querySelectorAll('.invoice-goods thead td').length,9);
    assert.match(d.querySelector('.invoice-goods thead').textContent,/Thùng/);
    assert.doesNotMatch(d.querySelector('.invoice-goods thead').textContent,/\bST\b/,'cột ST cũ đã đổi tên thành Thùng');
    assert.equal(d.querySelectorAll('.invoice-goods tbody tr').length,2);
    assert.equal(d.querySelector('.invoice-goods tbody .invoice-st').style.textAlign,'center');
    assert.equal(d.querySelectorAll('.invoice-goods tbody .invoice-st')[0].textContent.trim(),'101Tx100-99');
    assert.equal(d.querySelectorAll('.invoice-goods tbody .invoice-st')[1].textContent.trim(),'');
    assert.match(d.querySelectorAll('.invoice-location')[1].textContent,/dòng 1/);
    assert.match(d.querySelector('.invoice-summary').textContent,/100,011/);
    assert.equal(d.querySelectorAll('.invoice-qr img').length,3);
    assert.equal(d.querySelector('.invoice-brand').textContent,'KHO SỈ TOKOSI');
    assert.equal(d.querySelector('.tokosi-invoice').getAttribute('contenteditable'),'false');
  } finally {dom.window.close();}
});

test('delivery template has six columns, no prices, and uses saved order data', async () => {
  const order={schemaVersion:2,orderCode:'DH7',branch:'SG',customerName:'Khách <A>',customerPhone:'0901234567',customerAddress:'Địa chỉ',saleName:'Sale',lines:[{productCode:'A',productName:'Bình',quantity:600,unitPrice:'10',amount:'6000',note:'15th'}]};
  const record={status:'picking',lines:[{productCode:'A',location:'128',plannedQty:600,stText:'12Tx50'}]};
  const dom=await invoice(order,record);
  try {
    await dom.window.PickingInvoice.show(order,record,'delivery');
    const d=dom.window.document;
    assert.deepEqual(headers(d),['TT','Tên hàng','SL','Vị trí','Thùng','Thực nhặt']);
    assert.match(d.querySelector('.delivery-slip').textContent,/TỔNG KHO GIA DỤNG SÀI GÒN/);
    assert.match(d.querySelector('.delivery-slip').textContent,/Khách <A>/);
    assert.equal(cells(d)[2].textContent.trim(),'600');
    assert.equal(cells(d)[3].textContent.trim(),'128');
    assert.equal(cells(d)[4].textContent.trim(),'12Tx50');
    assert.equal(cells(d)[5].textContent.trim(),'');
    assert.equal(d.querySelector('.invoice-summary'),null);
    assert.equal(d.querySelector('[contenteditable="true"]'),null);
  } finally {dom.window.close();}
});

test('direct print formatting keeps text read-only, persists across sessions and exports styles', async () => {
  const order={schemaVersion:2,orderCode:'DH8',branch:'HN',lines:[{productCode:'A',productName:'Hàng A',quantity:10,unitPrice:'2',amount:'20'}]};
  const record={status:'picking',lines:[]};
  const dom=await invoice(order,record);
  const stored={};
  const sharedFetch=async(url,options={})=>{
    if(options.method==='PUT'){
      const body=JSON.parse(options.body),previous=stored[url]||{layout:null,version:0};
      assert.equal(body.version,previous.version);
      stored[url]={layout:body.layout,version:body.version+1};
    }
    return {ok:true,json:async()=>JSON.parse(JSON.stringify(stored[url]||{layout:null,version:0}))};
  };
  try {
    const w=dom.window,d=w.document;
    w.fetch=sharedFetch;
    w.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));
    await w.PickingPrint.prepare();
    const root=d.querySelector('.tokosi-invoice'),before=root.textContent;
    assert.equal(d.querySelector('#pickingPrintFormatting input,#pickingPrintFormatting select'),null);
    const cell=d.querySelector('.invoice-goods thead td'),table=cell.closest('table');
    cell.getBoundingClientRect=()=>({left:0,right:40,top:0,bottom:30,width:40,height:30});
    table.getBoundingClientRect=()=>({width:1000});
    const pointer=(target,type,x,y)=>target.dispatchEvent(new w.MouseEvent(type,{bubbles:true,button:0,clientX:x,clientY:y}));
    pointer(cell,'pointerdown',40,10);pointer(d,'pointermove',60,10);pointer(d,'pointerup',60,10);
    const cols=[...root.querySelectorAll('.invoice-goods col')];
    assert.equal(parseFloat(cols[0].style.width),6);
    assert.equal(parseFloat(cols[1].style.width),20);
    assert.ok(Math.abs(cols.reduce((n,c)=>n+parseFloat(c.style.width),0)-100)<.01);
    cell.parentElement.getBoundingClientRect=()=>({height:30});
    pointer(cell,'pointerdown',20,30);pointer(d,'pointermove',20,45);pointer(d,'pointerup',20,45);
    assert.equal(cell.parentElement.style.height,'45px');
    const name=cells(d)[1];name.style.fontSize='16px';
    const walker=d.createTreeWalker(name,w.NodeFilter.SHOW_TEXT);let node;
    while(walker.nextNode()){if(walker.currentNode.textContent.includes('Hàng A')){node=walker.currentNode;break;}}
    const range=d.createRange();range.setStart(node,0);range.setEnd(node,4);
    const selection=w.getSelection();selection.removeAllRanges();selection.addRange(range);
    const key=value=>root.dispatchEvent(new w.KeyboardEvent('keydown',{key:value,ctrlKey:true,bubbles:true,cancelable:true}));
    key(']');
    assert.equal(name.style.fontSize,'13pt');
    assert.equal(selection.toString(),'Hàng');
    key(']');
    assert.equal(name.style.fontSize,'14pt');
    key('[');
    assert.equal(name.style.fontSize,'13pt');
    assert.equal(root.textContent,before);
    assert.equal(root.getAttribute('contenteditable'),'false');
    const exported=new JSDOM(w.PickingPrint.document());
    assert.equal(exported.window.document.querySelector('[contenteditable="true"]'),null);
    assert.equal(exported.window.document.querySelector('.invoice-goods tbody td:nth-child(2)').style.fontSize,'13pt');
    assert.equal(exported.window.document.querySelector('.invoice-goods col').style.width,'6%');
    assert.equal(exported.window.document.querySelector('.invoice-goods tr').style.height,'45px');
    exported.window.close();
    await w.PickingInvoice.changeTemplate('delivery');
    assert.equal(d.querySelectorAll('.invoice-goods col').length,6);
    assert.equal(d.querySelector('[data-print-font]'),null);
    await w.PickingInvoice.changeTemplate('order');
    assert.equal(d.querySelector('.invoice-goods col').style.width,'6%');
    assert.equal(d.querySelector('.invoice-goods tbody td:nth-child(2)').style.fontSize,'13pt');
    // Another user/browser receives the shared server form without any local preferences.
    const reopened=await invoice(order,record);
    try{
      reopened.window.fetch=sharedFetch;
      Object.defineProperty(reopened.window,'localStorage',{get(){throw new Error('Other user has no local preferences');}});
      reopened.window.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));
      await reopened.window.PickingPrint.prepare();
      const rd=reopened.window.document;
      assert.equal(rd.querySelector('.invoice-goods col').style.width,'6%');
      assert.equal(rd.querySelector('.invoice-goods tr').style.height,'45px');
      assert.equal(rd.querySelector('.invoice-goods tbody td:nth-child(2)').style.fontSize,'13pt');
      rd.querySelector('#pickingPrintFormatting button').click();
      assert.equal(rd.querySelector('[data-print-font]'),null);
      assert.equal(rd.querySelector('.invoice-goods col').style.width,'4%');
      assert.equal(rd.querySelector('.invoice-goods tr').style.height,'');
    }finally{reopened.window.close();}
  } finally {dom.window.close();}
});

test('legacy print warns that original lines cannot be recovered; cancelled ST blank', async () => {
  const dom = await invoice({orderCode:'DH1', lines:[{productCode:'A',productName:'A',quantity:1,price:10}],invoiceDiscount:0}, {status:'cancelled',lines:[{productCode:'A',location:'A01',stText:'1Tx100'}]});
  try {
    assert.match(dom.window.document.querySelector('.invoice-legacy').textContent,/dòng gốc/);
    assert.equal(dom.window.document.querySelector('tbody .invoice-st').textContent.trim(),'');
  } finally {dom.window.close();}
});

const headers = d => [...d.querySelectorAll('.invoice-goods thead td')].map(td => td.textContent.replace(/\s+/g, ' ').trim());
const cells = (d, row = 0) => [...d.querySelectorAll('.invoice-goods tbody tr')[row].querySelectorAll('td')];

test('thứ tự cột phiếu: TT, Tên hàng, SL, Đơn giá, Thành tiền, Ghi chú, Vị trí, Thùng, Thực nhặt', async () => {
  const order = {...makeOrderSnapshot({invoiceDiscount:0, lines:[{productCode:'A', productName:'Hàng A', quantity:100, price:15400, discount:0, note:'full vat'}]}), orderCode:'DH2', branch:'HN'};
  const dom = await invoice(order, {status:'picking', lines:[{productCode:'A', location:'A07', plannedQty:100, stText:'2Tx50', stCartons:2}]});
  try {
    const d = dom.window.document;
    assert.deepEqual(headers(d), ['TT','Tên hàng','SL','Đơn giá','Thành tiền','Ghi chú','Vị trí','Thùng','Thực nhặt']);
    assert.equal(d.querySelectorAll('.invoice-goods colgroup col').length, 9);
    const c = cells(d);
    assert.equal(c.length, 9);
    assert.equal(c[0].textContent.trim(), '1');
    assert.equal(c[1].textContent.trim(), 'Hàng A');
    assert.equal(c[2].textContent.trim(), '100');
    assert.equal(c[3].textContent.trim(), '15,400');
    assert.equal(c[4].textContent.trim(), '1,540,000');
    assert.equal(c[5].textContent.trim(), 'full vat', 'Ghi chú đứng trước Vị trí');
    assert.ok(c[6].classList.contains('invoice-location'));
    assert.equal(c[7].textContent.trim(), '2Tx50');
    assert.ok(c[7].classList.contains('invoice-st'));
    assert.ok(c[8].classList.contains('invoice-actual'));
    assert.equal(c[8].textContent.trim(), '');
  } finally {dom.window.close();}
});

test('ô Vị trí: một vị trí chỉ ghi tên vị trí, không ghi số lượng', async () => {
  const order = {...makeOrderSnapshot({invoiceDiscount:0, lines:[{productCode:'A', productName:'Hàng A', quantity:300, price:10, discount:0}]}), orderCode:'DH3', branch:'HN'};
  const dom = await invoice(order, {status:'picking', lines:[{productCode:'A', location:'A01', plannedQty:300, stText:'3Tx100', stCartons:3}]});
  try {
    const cell = cells(dom.window.document)[6];
    assert.equal(cell.textContent.trim(), 'A01');
    assert.equal(cell.querySelectorAll('b,strong').length, 0);
  } finally {dom.window.close();}
});

test('ô Vị trí: từ hai vị trí mỗi vị trí một dòng "VT: SL" với SL in đậm; vị trí trùng tên cộng gộp', async () => {
  const order = {...makeOrderSnapshot({invoiceDiscount:0, lines:[{productCode:'A', productName:'Hàng A', quantity:200050, price:10, discount:0}]}), orderCode:'DH4', branch:'HN'};
  const dom = await invoice(order, {status:'picking', lines:[
    {productCode:'A', location:'A01', plannedQty:200000, stText:'2Tx100000', stCartons:2},
    {productCode:'A', location:'B02', plannedQty:30, stText:'', stCartons:null},
    {productCode:'A', location:'B02', plannedQty:20, stText:'', stCartons:null}
  ]});
  try {
    const cell = cells(dom.window.document)[6];
    const lines = [...cell.querySelectorAll('.invoice-loc-line')];
    assert.deepEqual(lines.map(l => l.textContent.replace(/\s+/g, ' ').trim()), ['A01:200000', 'B02:50']);
    assert.deepEqual([...cell.querySelectorAll('.invoice-loc-line b')].map(b => b.textContent), ['200000', '50'], 'chỉ số lượng in đậm, không thêm dấu phân cách hàng nghìn');
    assert.doesNotMatch(cell.textContent, /Tx/, 'số thùng không lặp ở ô Vị trí (đã có cột Thùng)');
  } finally {dom.window.close();}
});

test('CSS phiếu: cột Vị trí đủ rộng, mỗi dòng vị trí không xuống dòng; căn lề theo thứ tự cột mới', () => {
  const css = fs.readFileSync(path.join(dir, 'invoice-a4.css'), 'utf8');
  const tpl = fs.readFileSync(path.join(dir, 'order-template.tpl'), 'utf8');
  const widths = [...tpl.match(/<colgroup>.*?<\/colgroup>/s)[0].matchAll(/width:\s*(\d+)%/g)].map(m => Number(m[1]));
  assert.equal(widths.length, 9);
  assert.equal(widths.reduce((a, b) => a + b, 0), 100);
  assert.ok(widths[6] >= 13, 'cột Vị trí chứa "A01: 200,000"');
  assert.match(css, /\.invoice-loc-line\{[^}]*white-space:nowrap/);
  assert.match(css, /td:nth-child\(7\)/, 'Vị trí là cột thứ 7');
});

test('shared form load failure is visible and does not fall back to local user preferences',async()=>{
 const dom=await invoice({schemaVersion:2,orderCode:'DH9',lines:[]},{lines:[]});
 try{
  const w=dom.window;w.fetch=async()=>({ok:false,status:500});
  w.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));
  await w.PickingPrint.prepare();
  assert.match(w.document.getElementById('pickingPrintMessage').textContent,/Không tải được form chung/);
  assert.equal(w.document.querySelector('#pickingPrintFormatting button'),null);
 }finally{dom.window.close();}
});

test('shared form conflict is visible and never reports local changes as shared success',async()=>{
 const dom=await invoice({schemaVersion:2,orderCode:'DH10',lines:[]},{lines:[]});
 try{
  const w=dom.window;w.fetch=async(url,options={})=>options.method==='PUT'?{ok:false,status:409,json:async()=>({error:'Form chung đã được người khác sửa.'})}:{ok:true,json:async()=>({layout:null,version:0})};
  w.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));
  await w.PickingPrint.prepare();
  w.document.querySelector('#pickingPrintFormatting button').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(w.document.getElementById('pickingPrintMessage').textContent,/người khác sửa/);
  assert.match(w.document.getElementById('pickingPrintMessage').textContent,/chưa được lưu chung/);
 }finally{dom.window.close();}
});

test('phiếu in gộp thùng trong từng khu, nối cộng giữa các khu và giữ phần thiếu riêng',async()=>{
 const order={schemaVersion:2,orderCode:'DH-KHU',lines:[{productCode:'A',productName:'Hàng A',quantity:285,unitPrice:'1',amount:'285'}]};
 const record={status:'picking',lines:[
  {productCode:'A',location:'B',plannedQty:140,stText:'3Tx50-10',stCartons:3},
  {productCode:'A',location:'A',plannedQty:100,stText:'2Tx50',stCartons:2},
  {productCode:'A',location:'A',plannedQty:45,stText:'1Tx50-5',stCartons:1}
 ]};
 const dom=await invoice(order,record);
 try{
  dom.window.PickingCarton=require('../../public/shared/carton.js');
  await dom.window.PickingInvoice.show(order,record);
  const d=dom.window.document;
  const printed=d.querySelector('tbody .invoice-st');
  assert.equal(printed.textContent.trim(),'3T x 50 - 5 + 3T x 50 - 10');
  assert.ok(printed.classList.contains('invoice-st-frac'));
  assert.equal(d.querySelector('.invoice-goods tbody tr').cells[2].textContent.trim(),'285');
 }finally{dom.window.close();}
});

test('table body columns share size and rows fit their own content, header stays separate and shortcuts persist for other users/new rows',async()=>{
 const order={schemaVersion:2,orderCode:'DH-STYLE',lines:[1,2].map(n=>({productCode:'P'+n,productName:'Hàng '+n,quantity:10,unitPrice:'1',amount:'10'}))};
 const record={status:'picking',lines:[]},saved={};
 const fetchShared=async(url,options={})=>{
  if(options.method==='PUT'){
   const body=JSON.parse(options.body);saved[url]={layout:body.layout,version:body.version+1};
  }
  return {ok:true,json:async()=>JSON.parse(JSON.stringify(saved[url]||{layout:null,version:0}))};
 };
 const dom=await invoice(order,record);
 try{
  const w=dom.window,d=w.document;w.fetch=fetchShared;
  const root=d.querySelector('.tokosi-invoice'),before=root.textContent;
  const bodyRows=[...d.querySelectorAll('.invoice-goods tbody tr')];
  bodyRows.forEach((r,i)=>{r.getBoundingClientRect=()=>({height:parseFloat(r.style.height)||24+i*8});r.querySelectorAll('td').forEach(td=>td.style.fontSize='16px');});
  w.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));await w.PickingPrint.prepare();
  const select=el=>{const range=d.createRange();range.selectNodeContents(el);w.getSelection().removeAllRanges();w.getSelection().addRange(range);};
  const key=k=>root.dispatchEvent(new w.KeyboardEvent('keydown',{key:k,ctrlKey:true,bubbles:true,cancelable:true}));
  select(bodyRows[0].cells[1]);key(']');
  assert.ok(bodyRows.every(r=>r.cells[1].style.fontSize==='13pt'&&r.cells[0].style.fontSize==='16px'));
  assert.equal(d.querySelector('.invoice-goods thead td').style.fontSize,'');
  for(const [shortcut,align] of [['l','left'],['r','right'],['e','center']]){
   key(shortcut);assert.ok(bodyRows.every(r=>r.cells[1].style.textAlign===align));
  }
  // Ctrl+B / Ctrl+I không còn đổi đậm / nghiêng trên phiếu.
  key('b');key('i');assert.ok(bodyRows.every(r=>r.cells[1].style.fontWeight===''&&r.cells[1].style.fontStyle===''));

  assert.equal(bodyRows[0].cells[0].style.fontWeight,'');
  const cell=bodyRows[0].cells[1];cell.getBoundingClientRect=()=>({left:0,right:100,top:0,bottom:24,height:24});
  const y=24;
  const pointer=(target,type,y)=>target.dispatchEvent(new w.MouseEvent(type,{bubbles:true,button:0,clientX:40,clientY:y}));
  pointer(cell,'pointerdown',y);pointer(d,'pointermove',y+12);pointer(d,'pointerup',y+12);
  assert.ok(bodyRows.every(r=>r.style.height===''));
  assert.deepEqual(bodyRows.map(r=>r.getBoundingClientRect().height),[24,32]);
  const header=d.querySelector('.invoice-goods thead td');select(header);key(']');key('r');
  assert.equal(header.style.textAlign,'right');assert.equal(bodyRows[0].cells[0].style.textAlign,'center');
  assert.ok(bodyRows.every(r=>r.cells[0].style.fontSize==='16px'));
  const lastHeader=d.querySelector('.invoice-goods thead td:last-child');select(lastHeader);key('r');
  assert.equal(lastHeader.querySelector('p').style.textAlign,'right');
  const title=d.querySelector('.invoice-title');select(title);key('e');assert.equal(title.closest('p').style.textAlign,'center');
  const customer=d.querySelector('.invoice-customer p')||d.querySelector('.invoice-customer');select(customer);key('l');
  assert.equal(customer.style.textAlign,'left');
  assert.equal(root.textContent,before);
  await new Promise(resolve=>setImmediate(resolve));
  const reopened=await invoice({...order,lines:[...order.lines,...order.lines.map(l=>({...l,productCode:l.productCode+'N'}))]},record);
  try{
   const rw=reopened.window;rw.fetch=fetchShared;rw.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));await rw.PickingPrint.prepare();
   const rows=[...rw.document.querySelectorAll('.invoice-goods tbody tr')];assert.equal(rows.length,4);
   assert.ok(rows.every(r=>r.style.height===''&&r.cells[0].style.fontSize===''&&r.cells[1].style.fontSize==='13pt'&&r.cells[1].style.textAlign==='center'));
   assert.equal(rw.document.querySelector('.invoice-goods thead td').style.textAlign,'right');
   const exported=new JSDOM(rw.PickingPrint.document());
   assert.equal(exported.window.document.querySelector('.invoice-goods tbody td:nth-child(2)').style.fontSize,'13pt');exported.window.close();
   rw.document.querySelector('#pickingPrintFormatting button').click();assert.equal(rows[0].cells[1].style.textAlign,'');
  }finally{reopened.window.close();}
 }finally{dom.window.close();}
});


test('seller Zalo phone prints with leading 0 even when the snapshot holds +84',async()=>{
 const dom=await invoice({schemaVersion:2,orderCode:'DH-PHONE',saleName:'Sale A',sellerPhone:'+84923170904',lines:[{productCode:'A',productName:'A',quantity:1,unitPrice:'2',amount:'2'}]},{status:'picking',lines:[]});
 try{assert.match(dom.window.document.querySelector('.invoice-seller').textContent,/Zalo: 0923170904/);assert.equal(dom.window.document.querySelector('.invoice-seller strong').textContent,'0923170904','số Zalo in đậm');}finally{dom.window.close();}
});

test('Telegram ID is bold and footer columns resize, format and restore independently',async()=>{
 const order={schemaVersion:2,orderCode:'DH-FOOT',saleName:'Sale A',saleTelegramId:'123456',sellerPhone:'0901234567',lines:[{productCode:'A',productName:'A',quantity:1,unitPrice:'2',amount:'2'}]};
 const dom=await invoice(order,{status:'picking',lines:[]});
 try{
  const w=dom.window,d=w.document;
  assert.equal(d.querySelector('.invoice-telegram').textContent,'123456');
  assert.equal(d.querySelector('.invoice-telegram').tagName,'STRONG');
  assert.match(d.querySelector('.invoice-seller').textContent,/Zalo: 0901234567/);
  let saved=null;
  w.fetch=async(url,opts={})=>{if(opts.method==='PUT')saved=JSON.parse(opts.body).layout;return {ok:true,json:async()=>({layout:saved,version:0})};};
  w.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));await w.PickingPrint.prepare();
  const root=d.querySelector('.tokosi-invoice'),summary=d.querySelector('.invoice-summary'),cell=summary.rows[0].cells[1];
  assert.equal(summary.querySelectorAll('col').length,4);
  const range=d.createRange();range.selectNodeContents(cell);w.getSelection().addRange(range);
  const key=k=>root.dispatchEvent(new w.KeyboardEvent('keydown',{key:k,ctrlKey:true,bubbles:true,cancelable:true}));
  key(']');key('r');key('b');key('i');
  assert.ok([...summary.rows].every(r=>r.cells[1].style.fontSize&&r.cells[1].style.textAlign==='right'&&r.cells[1].style.fontWeight===''&&r.cells[1].style.fontStyle===''));
  assert.equal(summary.rows[0].cells[0].style.fontSize,'');
  assert.equal(d.querySelector('.invoice-goods tbody td:nth-child(2)').style.fontSize,'');
  cell.getBoundingClientRect=()=>({left:470,right:670,top:0,bottom:30});summary.getBoundingClientRect=()=>({width:1000});
  cell.dispatchEvent(new w.MouseEvent('pointerdown',{bubbles:true,button:0,clientX:670,clientY:10}));
  d.dispatchEvent(new w.MouseEvent('pointermove',{clientX:680,clientY:10}));d.dispatchEvent(new w.MouseEvent('pointerup'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(summary.querySelectorAll('col')[1].style.width,'21%');
  assert.equal(saved.tables.summary.widths[1],21);
  await w.PickingInvoice.changeTemplate('order');
  assert.equal(d.querySelector('.invoice-summary').rows[1].cells[1].style.textAlign,'right');
  const exported=new JSDOM(w.PickingPrint.document());
  assert.equal(exported.window.document.querySelector('.invoice-summary col:nth-child(2)').style.width,'21%');exported.window.close();
  d.querySelector('#pickingPrintFormatting button').click();assert.equal(d.querySelector('.invoice-summary').rows[1].cells[1].style.fontSize,'');
  await w.PickingInvoice.changeTemplate('delivery');
  assert.equal(d.querySelectorAll('.delivery-signatures col').length,3);
  assert.equal(d.querySelector('.invoice-telegram').textContent,'123456');
 }finally{dom.window.close();}
});


test('unallocated repeated products leave both placement columns blank in both templates', async () => {
  const order={schemaVersion:2,orderCode:'DH-empty',branch:'HN',lines:[1,2].map(() => ({productCode:'A',productName:'Hàng A',quantity:10,unitPrice:'2',amount:'20'}))};
  const record={status:'picking',lines:[]};
  const dom=await invoice(order,record);
  try {
    for(const template of ['order','delivery']) {
      await dom.window.PickingInvoice.show(order,record,template);
      for(const cell of dom.window.document.querySelectorAll('.invoice-goods tbody .invoice-location, .invoice-goods tbody .invoice-st')) assert.equal(cell.textContent.trim(),'');
    }
  } finally {dom.window.close();}
});


test('saved body heights do not inflate short rows or exported HTML',async()=>{
 const dom=await invoice({schemaVersion:2,orderCode:'DH-AUTO',lines:[1,2].map(n=>({productCode:'P'+n,productName:'Hàng '+n,quantity:1,unitPrice:'1',amount:'1'}))},{status:'picking',lines:[]});
 try{
  const w=dom.window;
  w.fetch=async()=>({ok:true,json:async()=>({layout:{widths:[],heights:[45,100,100],fonts:[],groups:{body:{height:100}}},version:1})});
  w.eval(fs.readFileSync(path.join(dir,'print-tools.js'),'utf8'));await w.PickingPrint.prepare();
  assert.ok([...w.document.querySelectorAll('.invoice-goods tbody tr')].every(r=>r.style.height===''));
  const exported=new JSDOM(w.PickingPrint.document());
  try{assert.ok([...exported.window.document.querySelectorAll('.invoice-goods tbody tr')].every(r=>r.style.height===''));}finally{exported.window.close();}
 }finally{dom.window.close();}
});
