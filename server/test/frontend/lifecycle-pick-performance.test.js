'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {JSDOM}=require('jsdom');
const dir=path.join(__dirname,'../../public/shipment/lifecycle/pick');
const source=name=>fs.readFileSync(path.join(dir,name),'utf8');
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('asset loading starts all QR requests together and retries after failed prefetch',async()=>{
  const dom=new JSDOM('',{runScripts:'outside-only'}),w=dom.window;
  try{
    const ids=['a'.repeat(32),'b'.repeat(32),'c'.repeat(32)],pending=[];
    let fail=true;
    w.fetch=async url=>{
      if(url.includes('.tpl')){if(fail){fail=false;throw Error('offline');}return {ok:true,text:async()=>ids.map(id=>'https://cdn2-retail-images.kiotviet.vn/2026/10/05/chhanoi/'+id+'.jpg').join(' ')};}
      if(url.includes('.css'))return {ok:true,text:async()=>''};
      return new Promise(resolve=>pending.push(()=>resolve({ok:false})));
    };
    w.eval(source('invoice.js'));
    await assert.rejects(w.PickingInvoice.loadAssets(),/offline/);
    const loading=w.PickingInvoice.loadAssets();await settle();
    assert.equal(pending.length,3,'independent QR images must start before any one finishes');
    pending.forEach(resolve=>resolve());await loading;
    assert.match(w.PickingInvoiceTemplate,/invoice-assets/);
  }finally{dom.window.close();}
});

test('printing and saving stay blocked until fresh shared form succeeds, including programmatic clicks',async()=>{
  const dom=new JSDOM('<dialog id="pickingPrintDialog"><div class="dp-head"><div><button id="pickingPrintBtn"></button></div></div><div id="pickingPrintSheet"></div></dialog><div id="pickingPrintTitle"></div>',{runScripts:'outside-only'}),w=dom.window,d=w.document;
  try{
    w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    w.PickingInvoiceTemplate=source('order-template.tpl');w.PickingPrintCSS=source('invoice-a4.css');
    w.eval(source('invoice.js'));w.eval(source('print-tools.js'));w.PickingPrint.init();
    let release;
    w.fetch=()=>new Promise(resolve=>{release=resolve;});
    const showing=w.PickingInvoice.show({schemaVersion:2,orderCode:'private-order-code',branch:'HN',lines:[],goodsTotal:'0',payable:'0',invoiceDiscount:'0'},{status:'picking',lines:[]});
    await settle();
    assert.equal(d.getElementById('pickingPrintBtn').disabled,true);
    d.getElementById('pickingPrintBtn').onclick();
    assert.equal(d.getElementById('pickingPrintFrame'),null);
    release({ok:false});await showing;
    // Từ 3451ffc: form chung lỗi không khóa In/Lưu HTML (phiếu giữ mẫu mặc định, có thông báo đỏ).
    assert.equal(d.getElementById('pickingPrintBtn').disabled,false);
    assert.equal(d.getElementById('pickingSavePrint').disabled,false);
    w.fetch=async()=>({ok:true,json:async()=>({layout:null,version:0})});
    assert.equal(await w.PickingPrint.prepare(),true);
    assert.equal(d.getElementById('pickingPrintBtn').disabled,false);
    assert.equal(d.getElementById('pickingSavePrint').disabled,false);
  }finally{dom.window.close();}
});

test('print timing uses bounded aggregate labels and never leaves marks or order identifiers',async()=>{
  const dom=new JSDOM('<dialog id="pickingPrintDialog"></dialog><div id="pickingPrintSheet"></div><div id="pickingPrintTitle"></div>',{runScripts:'outside-only'}),w=dom.window;
  try{
    const measures=new Map();
    w.performance.measure=(name,options)=>measures.set(name,options);
    w.performance.clearMeasures=name=>measures.delete(name);
    w.PickingInvoiceTemplate=source('order-template.tpl');w.PickingPrintCSS=source('invoice-a4.css');
    w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    w.eval(source('invoice.js'));
    for(let i=0;i<4;i++)await w.PickingInvoice.show({schemaVersion:2,orderCode:'sensitive-'+i,lines:[],goodsTotal:'0',payable:'0'},{lines:[]});
    assert.ok(measures.has('tokosi.pick.preview-ready'));
    assert.ok(measures.has('tokosi.pick.render'));
    assert.ok(measures.has('tokosi.pick.layout'));
    assert.ok(measures.size<=5);
    assert.doesNotMatch([...measures.keys()].join(','),/sensitive/);
    for(const timing of measures.values()){assert.equal(typeof timing.start,'number');assert.equal(typeof timing.end,'number');}
  }finally{dom.window.close();}
});

test('a delayed print frame cannot print an older layout after the same root is saved again',async()=>{
  const dom=new JSDOM('<dialog id="pickingPrintDialog"><div class="dp-head"><div><button id="pickingPrintBtn"></button></div></div><div id="pickingPrintSheet"></div></dialog><div id="pickingPrintTitle"></div>',{runScripts:'outside-only'}),w=dom.window,d=w.document;
  try{
    w.HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
    w.PickingInvoiceTemplate=source('order-template.tpl');w.PickingPrintCSS=source('invoice-a4.css');
    let writes=0;
    w.fetch=async(url,options={})=>{
      if(options.method==='PUT'){writes++;return {ok:true,json:async()=>({version:1})};}
      return {ok:true,json:async()=>({layout:null,version:0})};
    };
    w.eval(source('invoice.js'));w.eval(source('print-tools.js'));w.PickingPrint.init();
    await w.PickingInvoice.show({schemaVersion:2,orderCode:'DH1',branch:'HN',lines:[{productCode:'A',productName:'Name',quantity:1,unitPrice:'1',amount:'1'}],goodsTotal:'1',payable:'1',invoiceDiscount:'0'},{status:'picking',lines:[]});
    d.getElementById('pickingPrintBtn').onclick();
    const frame=d.getElementById('pickingPrintFrame'),load=frame.onload;frame.onload=null;
    frame.contentDocument.body.innerHTML='<img id="waiting">';
    const image=frame.contentDocument.getElementById('waiting');
    Object.defineProperty(image,'complete',{value:false});
    let printed=0;frame.contentWindow.focus=()=>{};frame.contentWindow.print=()=>{printed++;};
    const printing=load();
    const root=d.querySelector('.tokosi-invoice'),name=root.querySelector('.invoice-goods tbody td:nth-child(2)');
    const range=d.createRange();range.selectNodeContents(name);w.getSelection().addRange(range);
    root.dispatchEvent(new w.KeyboardEvent('keydown',{key:']',ctrlKey:true,bubbles:true,cancelable:true}));
    await settle();
    assert.equal(writes,1,'the newer form is saved while the frame waits for its image');
    assert.equal(root.dataset.printReady,'true','same source root is ready again after saving');
    image.dispatchEvent(new frame.contentWindow.Event('load'));await printing;
    assert.equal(printed,0,'the frame captured before the successful save must be discarded');
  }finally{dom.window.close();}
});
