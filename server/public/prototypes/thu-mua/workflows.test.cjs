const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { JSDOM } = require('jsdom');

function fixture(t, savedStorage) {
  const dom = new JSDOM(fs.readFileSync(__dirname + '/index.html', 'utf8'), {
    runScripts: 'outside-only', url: 'https://mock.local/prototypes/thu-mua/'
  });
  const w = dom.window;
  if(savedStorage)Object.entries(savedStorage).forEach(([k,v])=>w.sessionStorage.setItem(k,v));
  w.PurchaseColumns = require('../../shared/purchase-columns');
  w.PurchaseHeaders = require('../../shared/purchase-headers');
  w.PurchaseTasks = require('../../shared/purchase-tasks');
  w.PurchaseCalculations=require('../../shared/purchase-calculations');w.PurchaseFreight = require('../../shared/purchase-freight');
  w.PurchaseExcel = require('../../shared/purchase-workbook');
  w.XLSX = require('xlsx');
  w.HTMLCanvasElement.prototype.getContext = () => ({ measureText: s => ({ width: String(s).length * 6 }) });
  for (const key of ['ResizeObserver', 'MutationObserver']) w[key] = class { observe() {} unobserve() {} disconnect() {} };
  for (const key of ['requestAnimationFrame', 'setInterval', 'setTimeout']) w[key] = () => 0;
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const context = dom.getInternalVMContext();
  for (const script of w.document.querySelectorAll('script:not([src])')) vm.runInContext(script.textContent, context);
  vm.runInContext(fs.readFileSync(__dirname+'/planning.js','utf8'),context);
  vm.runInContext(fs.readFileSync(__dirname+'/tasks.js','utf8'),context);
  vm.runInContext(fs.readFileSync(__dirname+'/freight.js','utf8'),context);
  vm.runInContext(fs.readFileSync(__dirname+'/balance.js','utf8'),context);
  vm.runInContext(fs.readFileSync(__dirname+'/productivity.js','utf8'),context);
  t.after(() => w.close());
  return { w, run: code => vm.runInContext(code, context) };
}

test('date columns use calendar/time inputs and old free text is preserved as notes',t=>{
 const {run,w}=fixture(t);assert.equal(run("colByKey('orderedNote').t"),'datetime');assert.equal(run("ROWS[0].orderedNote"),'');assert.match(run('ROWS[0].extraNote'),/10.27/);
 const cell=w.document.querySelector('#mainRows tr td[data-k="orderedNote"]');cell.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.equal(cell.querySelector('input').type,'datetime-local');
 assert.equal(run("fmt('2026-11-03T14:25','datetime')"),'03/11');
});
test('default order table hides row key and lets users toggle it',t=>{
 const {run,w}=fixture(t);assert.equal(w.document.querySelectorAll('#mainHead th').length,42);assert.equal(w.document.getElementById('colCount').textContent,'(42/42)');
 for(const key of ['freightPrepaid','freightPostpaid','fxRate','kgPerCarton','m3PerCarton','goodsAmount','freightAmount','taxAmount'])assert.ok(w.document.querySelector('#mainHead [data-k="'+key+'"]'));
 run('setAllCols(0)');assert.ok(w.document.querySelectorAll('#mainHead th').length<43);run('setAllCols(1)');assert.equal(w.document.querySelectorAll('#mainHead th').length,42);run("toggleCol('rowKey',true)");assert.equal(w.document.querySelectorAll('#mainHead th').length,43);run("toggleCol('rowKey',false)");assert.equal(w.document.querySelectorAll('#mainHead th').length,42);
});
test('numbers use comma grouping and decimal points regardless of header language', t => {
  const {run}=fixture(t);
  assert.equal(run('nf(1234567.89,2)'),'1,234,567.89');
  assert.equal(run("fmt(1668.8,'cny',colByKey('totalCny').decimals)"),'1,668.800');
  assert.equal(run("fmt(12.34567,'cny',colByKey('totalCny').decimals)"),'12.346');
  assert.equal(run("fmt(0.188,'ratio')"),'18.8%');
  assert.equal(run("fmt(0.073,'num4')"),'0.0730');
});
test('line freight follows volume and container rate rather than legacy manual value',t=>{const {run}=fixture(t);const result=run("(()=>{const r={...ROWS[0],freightAmount:120000,freightPrepaid:10,freightPostpaid:20};const before=derive(r);r.contId=2;contById(2).freightMode='formula';contById(2).freightBase=340000000;const after=derive(r);return {before:before.freightAmount,after:after.freightAmount,m3:after.totalM3}})()");assert.equal(result.after,result.m3*2000000);assert.notEqual(result.before,result.after)});

test('recursive split keys preserve quantity and require manual cost review', t => {
  const { run } = fixture(t);
  const result = run(`(() => {
    const r=ROWS[0];r.cartonCount=100;r.freightPrepaid=100;r.freightPostpaid=20;r.freightAmount=300;
    const a=branchRowKeys(r);const child={...r,id:++rowSeq,rowKey:a.child,cartonCount:20};
    r.cartonCount=80;ROWS.push(child);const b=branchRowKeys(child);
    const grandchild={...child,id:++rowSeq,rowKey:b.child,cartonCount:5};child.cartonCount=15;ROWS.push(grandchild);
    return {key:child.rowKey,total:r.cartonCount+child.cartonCount+grandchild.cartonCount,cost:r.freightAmount,net:derive(r).netPrice};
  })()`);
  assert.equal(result.key, 'D00001.02.01');
  assert.equal(result.total, 100);
  assert.equal(result.cost, null);
  assert.equal(result.net, null);
});

test('arrival records date, warehouse and actor without locking prices or accepting receipt checks', t => {
  const { run, w } = fixture(t);
  run('openStep(2)');
  assert(w.document.getElementById('stArrival'));
  assert(w.document.getElementById('stWarehouse'));
  assert.equal(w.document.getElementById('stLock'), null);
  assert.equal(w.document.getElementById('stResult'), null);
  run("stArrival.value='2026-11-03';stWarehouse.value='Kho Hà Nội';doStep()");
  assert.equal(run('contById(2).step'), 4);
  assert.equal(run('contById(2).arrivalWarehouse'), 'Kho Hà Nội');
  assert.equal(run('contById(2).arrivalBy'), 'Bạn');
  assert.equal(run('ROWS.some(r=>r.contId===2&&r.netLocked!=null)'), false);
});

test('stale arrival confirmation is rejected', t => {
  const { run } = fixture(t);
  run("openStep(2);stArrival.value='2026-11-03';stWarehouse.value='Kho Hà Nội';contById(2).version++;doStep()");
  assert.equal(run('contById(2).step'), 3);
});

test('keyless import is always new; obsolete split key is not an update', t => {
  const { run } = fixture(t);
  assert.equal(run("classifyImport({productCode:'AC305',productName:'Tape',qtyPerCarton:300,cartonCount:5}).mode"), 'new');
  run('branchRowKeys(ROWS[0])');
  assert.equal(run("classifyImport({rowKey:'D00001',productCode:'AC305'}).mode"), 'err');
  assert.match(run("classifyImport({rowKey:'D00001',productCode:'AC305'}).note"), /tách/);
});

test('blank imported cells preserve existing data and stale imports cannot overwrite', t => {
  const { run } = fixture(t);
  run("draft=[{__mode:'update',__target:ROWS[0].id,__version:ROWS[0].v,productCode:'AC305',supplier:'',cartonCount:9}];saveDraft()");
  assert.equal(run('ROWS[0].supplier'), 'băng dính');
  assert.equal(run('ROWS[0].cartonCount'), 9);
  run("draft=[{__mode:'update',__target:ROWS[0].id,__version:ROWS[0].v-1,cartonCount:99}];saveDraft()");
  assert.equal(run('ROWS[0].cartonCount'), 9);
  assert.equal(run('draft.length'), 1);
});

test('local filter and draft edits do not write shared rows before confirmation', t => {
  const { run } = fixture(t);
  const result = run(`(() => {
    const r=ROWS[0],before=r.buyer;fBuyer.value='An';render();
    bulkMode=true;state.picked.add(r.id);saveCell(r,{k:'buyer'},before,'Test buyer',r.v);
    return {before,after:r.buyer,pending:bulkDrafts.get(r.id).changes.buyer};
  })()`);
  assert.equal(result.before, result.after);
  assert.equal(result.pending, 'Test buyer');
});

test('live planning updates source and destination totals before save; cancel restores both',t=>{
 const {run}=fixture(t);const result=run(`(()=>{const r=ROWS[0],before=contStats(1).ton,queue=contStats(null).ton,qty=r.cartonCount;stagePlanningCell(r,'cartonCount',qty+10);stagePlanningCell(r,'contId',1);const preview=contStats(1).ton,original=r.cartonCount,source=contStats(null).ton;bulkCancel();return {before,preview,original,qty,kg:r.kgPerCarton,source,queue,after:contStats(1).ton}})()`);
 assert.equal(result.original,result.qty);assert.ok(Math.abs(result.preview-result.before-(result.qty+10)*result.kg/1000)<1e-8);assert.ok(result.source<result.queue);assert.equal(result.after,result.before);
});
test('adding arbitrary code to a trial container allocates a permanent key only after confirmation',t=>{
 const {run}=fixture(t);run("openAdd();aCont.value='1';draft=[{...ROWS[0],productCode:'ARBITRARY',productName:'Hàng thử'}];saveDraft()");assert.equal(run('ROWS[0].__trialNew'),true);assert.equal(run('ROWS[0].contId'),1);assert.match(run('ROWS[0].rowKey'),/MỚI/);run('planningCheck();bulkCommit()');assert.equal(run('ROWS[0].__trialNew'),undefined);assert.match(run('ROWS[0].rowKey'),/^D\d+/);
});
test('order status dropdown updates one container, its other order rows and the top table',t=>{
 const {run,w}=fixture(t),before=run("LOG.filter(l=>l.action==='status_change').length");const select=w.document.querySelector('#mainRows [data-row-container-status="1"]');assert.ok(select);select.value='4';select.dispatchEvent(new w.Event('change',{bubbles:true}));
 assert.equal(run('contById(1).step'),4);assert.ok([...w.document.querySelectorAll('#mainRows [data-row-container-status="1"]')].every(el=>el.value==='4'));assert.equal(w.document.querySelector('#contFull select[aria-label="Trạng thái CONT 10-9V"]').value,'4');assert.equal(run("LOG.filter(l=>l.action==='status_change').length"),before+1);assert.equal(w.document.querySelector('#mainRows tr td[data-k="status"]').querySelector('select'),null);
});
test('planning replaces the two-pane packing UI and status is a direct dropdown',t=>{
 const {w}=fixture(t);assert.equal(w.document.getElementById('ordersPackingSection').hidden,true);assert.equal(w.document.getElementById('openOrdersPacking'),null);const select=w.document.querySelector('#contFull select');assert.ok(select);select.value='4';select.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(w.document.getElementById('stepBackdrop').classList.contains('open'),false);
});
test('packing combines all waiting sources, labels origin and prevents selecting target rows',t=>{
 const {run,w}=fixture(t);run("packing.query='';packing.target=1;renderPacking()");
 assert.equal(w.document.querySelector('.pack-source-select'),null);
 assert.equal(w.document.querySelectorAll('.pack-pane:first-child tbody tr').length,run('ROWS.filter(r=>r.contId==null||contById(r.contId)?.step<3).length'));
 assert.ok(w.document.querySelector('.pack-pane:first-child input[type=checkbox]:disabled'));
 assert.match(w.document.querySelector('.pack-pane:first-child').textContent,/CONT 10-9V/);
});

test('partial allocation can return goods to queue without duplicating quantity', t => {
  const { run } = fixture(t);
  run(`(() => {const r=ROWS.find(r=>r.contId===1);r.cartonCount=100;
    packing.target=null;packing.review={target:null,cv:0,rows:[{id:r.id,v:r.v,from:1,qty:20}]};
    window.testRoot=r.rowKey;packCommit();})()`);
  assert.equal(run('ROWS.filter(r=>r.rootKey===window.testRoot).reduce((n,r)=>n+r.cartonCount,0)'), 100);
  assert.equal(run('ROWS.find(r=>r.rowKey===window.testRoot+".02").contId'), null);
});

test('partial departure keeps shipped quantities and branches shortfall back to queue', t => {
  const { run } = fixture(t);
  run(`(() => {const c=contById(1),rs=ROWS.filter(r=>r.contId===1);rs[0].cartonCount=100;
    window.departureRoot=rs[0].rowKey;packing.target=1;
    packing.shipping={target:1,cv:c.version,rows:rs.map((r,i)=>({id:r.id,v:r.v,planned:r.cartonCount,actual:i===0?80:r.cartonCount}))};
    packShipCommit();})()`);
  assert.equal(run('contById(1).step'), 3);
  assert.equal(run('ROWS.find(r=>r.rowKey===window.departureRoot+".01").cartonCount'), 80);
  assert.equal(run('ROWS.find(r=>r.rowKey===window.departureRoot+".02").cartonCount'), 20);
  assert.equal(run('ROWS.find(r=>r.rowKey===window.departureRoot+".02").contId'), null);
  const snapshotQty = run('contById(1).departureSnapshot.rows[0].cartonCount');
  run('ROWS.find(r=>r.contId===1).cartonCount=77');
  assert.equal(run('contById(1).departureSnapshot.rows[0].cartonCount'), snapshotQty);
});

test('different-field concurrent edits merge; same-field edits cannot overwrite', t => {
  const { run } = fixture(t);
  run(`(() => {const r=ROWS[0],v=r.v,before=r.buyer;r.supplier='Other supplier';r.v++;
    saveCell(r,colByKey('buyer'),before,'New buyer',v)})()`);
  assert.equal(run('ROWS[0].buyer'), 'New buyer');
  assert.equal(run('ROWS[0].supplier'), 'Other supplier');
  run(`(() => {const r=ROWS[0],v=r.v,before=r.buyer;r.buyer='Concurrent buyer';r.v++;
    saveCell(r,colByKey('buyer'),before,'Should not save',v)})()`);
  assert.equal(run('ROWS[0].buyer'), 'Concurrent buyer');
});

test('import retains the version from preview, not from later acceptance', t => {
  const { run } = fixture(t);
  run(`openAdd();window.__imp=[{rowKey:ROWS[0].rowKey,productCode:ROWS[0].productCode,cartonCount:99,...classifyImport(ROWS[0])}];ROWS[0].v++;acceptImport();saveDraft()`);
  assert.notEqual(run('ROWS[0].cartonCount'), 99);
  assert.equal(run('draft.length'), 0);
});

test('any stale row blocks the whole batch including valid updates and creations', t => {
  const { run } = fixture(t);
  run(`window.originalRows=ROWS.length;window.originalKeySeq=keySeq;
    draft=[{__mode:'update',__target:ROWS[0].id,__version:ROWS[0].v,cartonCount:55},
      {__mode:'update',__target:ROWS[1].id,__version:ROWS[1].v-1,cartonCount:66},
      {__mode:'new',productCode:'NEW',productName:'New',qtyPerCarton:10,cartonCount:5}];saveDraft()`);
  assert.equal(run('ROWS[0].cartonCount'), 4);
  assert.equal(run('ROWS.length'), run('window.originalRows'));
  assert.equal(run('keySeq'), run('window.originalKeySeq'));
  assert.equal(run('draft.length'), 3);
});

test('all import errors remain visible and must be corrected before staging', t => {
  const { run, w } = fixture(t);
  run('openAdd();fakeImport()');
  assert.equal(run('window.__imp.length'), 6);
  assert(w.document.querySelector('#importPreview button[onclick="acceptImport()"]').disabled);
  run('acceptImport()');
  assert.equal(run('draft.length'), 0);
  run("editImportCell(3,'rowKey','');editImportCell(4,'productCode','BOXNEW')");
  assert.equal(w.document.querySelector('#importPreview button[onclick="acceptImport()"]').disabled, false);
  run('acceptImport()');
  assert.equal(run('draft.length'), 6);
  assert.equal(run('ROWS.length'), 93);
});

test('duplicate row keys block every occurrence without dropping file rows', t => {
  const { run } = fixture(t);
  run("openAdd();window.__imp=[{rowKey:'D00001',productCode:'AC305'},{rowKey:'D00001',productCode:'AC305'}];refreshImportPreview();acceptImport()");
  assert.equal(run('draft.length'), 0);
  assert.equal(run('window.__imp.filter(r=>r.mode==="err").length'), 2);
});

test('unexpected write failure rolls back rows, logs and key counters for the entire batch', t => {
  const { run } = fixture(t);
  run(`window.oldLogCount=LOG.length;window.oldKeySeq=keySeq;window.oldRowSeq=rowSeq;
    draft=[{__mode:'update',__target:ROWS[0].id,__version:ROWS[0].v,cartonCount:55},
      {__mode:'new',productCode:'NEW',productName:'New',qtyPerCarton:10,cartonCount:5}];
    window.baseLogIt=logIt;window.calls=0;logIt=function(e){if(++window.calls===2)throw Error('simulated failure');window.baseLogIt(e)};
    saveDraft()`);
  assert.equal(run('ROWS[0].cartonCount'), 4);
  assert.equal(run('ROWS.length'), 93);
  assert.equal(run('keySeq'), run('window.oldKeySeq'));
  assert.equal(run('rowSeq'), run('window.oldRowSeq'));
  assert.equal(run('LOG.length'), run('window.oldLogCount'));
  assert.equal(run('draft.length'), 2);
});

test('real Excel roundtrip updates current branch while ignoring computed/container columns', t => {
  const { run, w } = fixture(t);
  const rows = JSON.parse(run("branchRowKeys(ROWS[0]);JSON.stringify([derive(ROWS[0])])"));
  const columns = JSON.parse(run('JSON.stringify(COLS)'));
  const workbook = w.PurchaseExcel.exportWorkbook(rows, columns, columns.map(c => c.k));
  const sheet = workbook.Sheets['Đặt hàng'];
  const headers = w.XLSX.utils.sheet_to_json(sheet, { header: 1 })[0];
  const cartonIndex = headers.indexOf(w.PurchaseExcel.caption(columns.find(c => c.k === 'cartonCount')));
  sheet[w.XLSX.utils.encode_cell({ r: 1, c: cartonIndex })].v = 22;
  const parsed = w.PurchaseExcel.parseWorkbook(w.PurchaseExcel.read(w.PurchaseExcel.bytes(workbook)), columns);
  assert.equal(parsed.rows[0].rowKey, 'D00001.01');
  assert.equal(parsed.rows[0].cartonCount, 22);
  assert.equal(parsed.rows[0].netPrice, undefined);
  assert.equal(parsed.rows[0].container, undefined);
  run('openAdd()');
  w.__imp = parsed.rows;
  w.__importFields = parsed.fields;
  run('refreshImportPreview();acceptImport();saveDraft()');
  assert.equal(run('ROWS[0].cartonCount'), 22);
});

test('actual file loading preserves all error rows and does not stage/write automatically', async t => {
  const { run, w } = fixture(t);
  const columns = JSON.parse(run('JSON.stringify(COLS)'));
  const workbook = w.PurchaseExcel.exportWorkbook([
    { rowKey: 'D00001', productCode: 'AC305', cartonCount: 20 },
    { rowKey: 'D99999', productCode: 'BAD', cartonCount: 5 }
  ], columns, ['rowKey', 'productCode', 'cartonCount']);
  run('openAdd()');
  w.fileForTest = { name: 'orders.xlsx', size: 2000, arrayBuffer: async () => w.PurchaseExcel.bytes(workbook) };
  await run('loadPurchaseExcel(window.fileForTest)');
  assert.equal(run('window.__imp.length'), 2);
  assert.equal(run('draft.length'), 0);
  assert.equal(run('ROWS[0].cartonCount'), 4);
  assert.equal(w.document.querySelector('#importPreview button[onclick="acceptImport()"]').disabled, true);
});

test('column resize minimum follows cell data rather than the header',t=>{const {run,w}=fixture(t);const key='listedAt';assert.equal(run("minimumColumnWidth(colByKey('listedAt'))"),60);assert.equal(w.document.querySelector('#mainHead th[data-k="listedAt"]').dataset.minWidth,'60');});

test('only numeric columns default to the tight data minimum',t=>{const {run}=fixture(t);assert.equal(run('COLS.filter(c=>isNum(c.t)).every(c=>compactColumnWidth(c)===minimumColumnWidth(c))'),true);assert.ok(run("compactColumnWidth(colByKey('productName'))")>=80);assert.ok(run("compactColumnWidth(colByKey('listedAt'))")>=60);});

test('manual split leaves child quantity blank, keeps parent and blocks save until entered',t=>{
 const {run,w}=fixture(t);run('ROWS[0].cartonCount=10;openPlanningTransfer(ROWS[0].id)');assert.equal(run('planningRows().find(r=>r.__splitPreview).cartonCount'),null);assert.equal(run('planningRows().find(r=>r.id===ROWS[0].id).cartonCount'),10);run('planningCheck()');assert.equal(run('bulkPending'),null);const input=w.document.querySelector('[data-split-qty]');assert.ok(input);assert.equal(input.value,'');input.value='4';input.dispatchEvent(new w.Event('change',{bubbles:true}));run("stagePlanningCell(ROWS[0],'cartonCount',7);planningCheck();bulkCommit()");assert.equal(run("ROWS.find(r=>r.rowKey==='D00001.01').cartonCount"),7);assert.equal(run("ROWS.find(r=>r.rowKey==='D00001.02').cartonCount"),4);
});
test('task drafts can be found despite private filters and cancel restores unsplit row',t=>{
 const {run}=fixture(t);const result=run(`(()=>{const r=ROWS[0],key=r.rowKey;planning.splits.set(r.id,{version:r.v,quantity:1,destinationId:2});planning.onlyDirty=true;render();const count=filtered().length;bulkCancel();return {count,key:r.rowKey,original:key,splits:planning.splits.size}})()`);assert.equal(result.count,2);assert.equal(result.key,result.original);assert.equal(result.splits,0);
});

test('container changes use an inline dropdown without opening a popup',t=>{
 const {run,w}=fixture(t);const select=w.document.querySelector('#mainRows [data-row-cont]');assert.ok(select);select.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));assert.ok(!w.document.getElementById('purchaseTaskDialog')?.open);select.value='2';select.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(run('bulkDrafts.get(ROWS[0].id).changes.contId'),2);assert.equal(run('ROWS[0].contId'),null);
});

test('sticky metrics have no task buttons and edited-row toggle stays in table toolbar',t=>{
 const {run,w}=fixture(t);run('openPlanningTransfer(ROWS[0].id)');const bar=w.document.getElementById('purchaseTaskBar');assert.equal(bar.querySelectorAll('button').length,0);assert.ok(bar.querySelector('select'));const toolbar=w.document.getElementById('bulkActions');assert.match(toolbar.textContent,/Lưu thay đổi/);assert.match(toolbar.textContent,/Xem các dòng đã sửa/);assert.doesNotMatch(w.document.body.textContent,/Tìm dòng chưa lưu|Áp dụng vào bản nháp|Lưu phương án|Tách \/ Chuyển/);
});

test('selected container indicator row pins after scrolling and updates from private edits',t=>{
 const {run,w}=fixture(t);assert.equal(w.document.getElementById('balanceBar'),null);assert.ok(w.document.getElementById('planningTaskMount').hidden);run("pickCont('2')");assert.match(w.document.getElementById('watchedContainer').textContent,/Đang theo dõi/);run('watchedSourceRow.getBoundingClientRect=()=>({top:1000});positionWatchedContainer()');assert.ok(w.document.getElementById('watchedContainer').hidden);run('watchedSourceRow.getBoundingClientRect=()=>({top:-100});positionWatchedContainer()');assert.equal(w.document.getElementById('watchedContainer').hidden,false);const before=w.document.getElementById('watchedContainer').textContent;run("stagePlanningCell(ROWS[0],'contId',2);stagePlanningCell(ROWS[0],'cartonCount',100);render()");assert.notEqual(w.document.getElementById('watchedContainer').textContent,before);assert.equal(run('fCont.value'),'');run('planning.target=null;renderConts()');assert.ok(w.document.getElementById('watchedContainer').hidden);
});

test('row history opens only on product code double click',t=>{
 const {w}=fixture(t);const doc=w.document,fire=selector=>doc.querySelector(selector).dispatchEvent(new w.MouseEvent('dblclick',{bubbles:true}));fire('#mainRows td[data-k="cartonCount"]');assert.ok(!doc.getElementById('histBackdrop').classList.contains('open'));fire('#mainRows td[data-k="productName"]');assert.ok(!doc.getElementById('histBackdrop').classList.contains('open'));fire('#mainRows td[data-k="productCode"]');assert.ok(doc.getElementById('histBackdrop').classList.contains('open'));
});

test('one click focuses an editable cell and selects existing text without opening history',t=>{
 const {w}=fixture(t);for(const key of ['productCode','supplier','cartonCount']){const cell=w.document.querySelector('#mainRows td[data-k="'+key+'"]');cell.dispatchEvent(new w.MouseEvent('click',{bubbles:true}));const input=cell.querySelector('input');assert.ok(input,key);assert.equal(w.document.activeElement,input);if(input.type==='text'){assert.equal(input.selectionStart,0);assert.equal(input.selectionEnd,input.value.length)}assert.ok(!w.document.getElementById('histBackdrop').classList.contains('open'));input.blur()}
});

test('split quantity editor retains entered value and updates calculated row after change',t=>{
 const {run,w}=fixture(t);run('openPlanningTransfer(ROWS[0].id)');let input=w.document.querySelector('[data-split-qty]');assert.ok(input.classList.contains('cell-input'));assert.equal(input.type,'text');input.value='77';input.dispatchEvent(new w.Event('change',{bubbles:true}));input=w.document.querySelector('[data-split-qty]');assert.equal(input.value,'77');assert.equal(run('planningRows().find(r=>r.__splitPreview).cartonCount'),77);const row=input.closest('tr');assert.match(row.querySelector('[data-k="totalQty"]').textContent,/23,100/);assert.ok(!w.document.getElementById('histBackdrop').classList.contains('open'));
});

test('paste validates the entire range before staging and undo restores one paste',t=>{
 const {run}=fixture(t);run("state.visible=new Set(['cartonCount','unitPriceCny']);render()");assert.equal(run("workPaste('12\\t2.5\\n13\\t3.5',{id:String(filtered()[0].id),key:'cartonCount'})"),4);assert.equal(run('bulkDrafts.size'),2);run('workUndo()');assert.equal(run('bulkDrafts.size'),0);assert.throws(()=>run("workPaste('12\\t2.5\\ninvalid\\t3.5',{id:String(filtered()[0].id),key:'cartonCount'})"));assert.equal(run('bulkDrafts.size'),0);
});
test('multi-row container move is one undo step and keeps saved rows unchanged',t=>{
 const {run,w}=fixture(t);run('state.picked=new Set([ROWS[0].id,ROWS[1].id]);workMove()');w.document.getElementById('workMoveTarget').value='2';w.document.getElementById('workMoveApply').click();assert.equal(run('bulkDrafts.size'),2);assert.equal(run('ROWS[0].contId'),null);run('workUndo()');assert.equal(run('bulkDrafts.size'),0);
});
test('delete requires confirmation then save, trash restores and saved undo blocks stale rows',t=>{
 const {run,w}=fixture(t);run('state.picked.add(ROWS[0].id);workDelete()');assert.equal(run('work.pendingDelete.size'),0);w.document.getElementById('workDeleteConfirm').click();assert.equal(run('work.pendingDelete.size'),1);assert.equal(run('ROWS[0].__deleted'),undefined);run('planningCheck();bulkCommit()');assert.equal(run('ROWS[0].__deleted'),true);assert.equal(run('planningRows().some(r=>r.id===ROWS[0].id)'),false);run('workTrash()');w.document.querySelector('[data-work-restore]').click();assert.equal(run('ROWS[0].__deleted'),undefined);run('ROWS[0].v++;workUndo()');assert.equal(run('ROWS[0].__deleted'),undefined);
});
test('reorder uses newest listing as a new private row and quick filters remain private',t=>{
 const {run}=fixture(t);run("ROWS[0].listedAt='2099-01-01';ROWS[0].unitPriceCny=123;state.picked.add(ROWS[0].id);workReorder()");assert.equal(run('ROWS.find(r=>r.__trialNew).unitPriceCny'),123);assert.equal(run('ROWS.find(r=>r.__trialNew).contId'),null);assert.equal(run('ROWS.find(r=>r.__trialNew).rootKey'),undefined);run('workUndo()');assert.equal(run('ROWS.some(r=>r.__trialNew)'),false);run("work.quick='measure';render()");assert.ok(run('filtered().every(r=>!(r.kgPerCarton>0&&r.m3PerCarton>0))'));
});
test('pre-save checks expose invalid split and Enter navigates to next row',t=>{
 const {run,w}=fixture(t);run('openPlanningTransfer(ROWS[0].id)');assert.ok(run('workIssues().errors.length')>0);run('planningCheck()');assert.match(run('bulkPanel.textContent'),/lỗi cần sửa/);run('bulkCancel()');const cell=w.document.querySelector('#mainRows td[data-k="supplier"]');cell.click();const input=cell.querySelector('input');input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.equal(w.document.activeElement.closest('tr').dataset.id,run('String(filtered()[1].id)'));
});

test('saved split undo restores both branches together and refuses later edits',t=>{
 const {run}=fixture(t);run("openPlanningTransfer(ROWS[0].id);planning.splits.get(ROWS[0].id).quantity=3;planningCheck();bulkCommit()");assert.equal(run("ROWS.filter(r=>r.rowKey.startsWith('D00001.')).length"),2);run('workUndo()');assert.ok(run("ROWS.some(r=>r.rowKey==='D00001')"));assert.equal(run("ROWS.filter(r=>r.rowKey.startsWith('D00001.')).length"),0);
});
test('stale delete blocks the entire pending save',t=>{
 const {run,w}=fixture(t);run('state.picked.add(ROWS[0].id);workDelete()');w.document.getElementById('workDeleteConfirm').click();run("stagePlanningCell(ROWS[1],'cartonCount',999);ROWS[0].v++;planningCheck();bulkCommit()");assert.equal(run('ROWS[0].__deleted'),undefined);assert.notEqual(run('ROWS[1].cartonCount'),999);
});
test('deleting an unsaved new row does not allocate a permanent key',t=>{
 const {run,w}=fixture(t);run('state.picked.add(ROWS[0].id);workReorder();state.picked=new Set([ROWS.find(r=>r.__trialNew).id]);workDelete()');w.document.getElementById('workDeleteConfirm').click();const seq=run('keySeq');run('planningCheck();bulkCommit()');assert.equal(run('keySeq'),seq);assert.equal(run('ROWS.some(r=>r.__trialNew)'),false);
});

test('saved delete and its audit survive reload and can be restored',t=>{
 const first=fixture(t);first.run('state.picked.add(ROWS[0].id);workDelete()');first.w.document.getElementById('workDeleteConfirm').click();first.run('planningCheck();bulkCommit();work.quick="measure";workPersist()');const saved={};for(let i=0;i<first.w.sessionStorage.length;i++){const key=first.w.sessionStorage.key(i);saved[key]=first.w.sessionStorage.getItem(key)}const next=fixture(t,saved);assert.equal(next.run('ROWS[0].__deleted'),true);assert.equal(next.run('work.quick'),'measure');assert.ok(next.run('LOG.some(l=>l.action==="delete")'));next.run('workTrash()');next.w.document.querySelector('[data-work-restore]').click();assert.equal(next.run('ROWS[0].__deleted'),undefined);
});
test('sequential saved edits undo one operation at a time without changing other rows',t=>{
 const {run}=fixture(t);const original=run('ROWS[0].cartonCount');run("stagePlanningCell(ROWS[0],'cartonCount',12);planningCheck();bulkCommit();stagePlanningCell(ROWS[0],'cartonCount',18);planningCheck();bulkCommit();workUndo()");assert.equal(run('ROWS[0].cartonCount'),12);run('workUndo()');assert.equal(run('ROWS[0].cartonCount'),original);
});

test('child quantity change is independently undoable without removing split',t=>{
 const {run,w}=fixture(t);run('openPlanningTransfer(ROWS[0].id)');const input=w.document.querySelector('[data-split-qty]');input.value='8';input.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(run('planning.splits.get(ROWS[0].id).quantity'),8);run('workUndo()');assert.equal(run('planning.splits.get(ROWS[0].id).quantity'),null);run('workUndo()');assert.equal(run('planning.splits.size'),0);
});

test('employee dropdown stages selected employee and undo restores original',t=>{
 const {run,w}=fixture(t);const select=w.document.querySelector('[data-row-buyer]');assert.equal(select.value,'An');assert.ok([...select.options].some(x=>x.value==='Lê'));select.value='Lê';select.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(run('bulkDrafts.get(ROWS[0].id).changes.buyer'),'Lê');assert.equal(run('ROWS[0].buyer'),'An');assert.equal(w.document.querySelector('[data-row-buyer]').value,'Lê');run('workUndo()');assert.equal(w.document.querySelector('[data-row-buyer]').value,'An');
});

test('pinned container reserves header offset and releases it when unpinned',t=>{
 const {run,w}=fixture(t);run("pickCont('2');mainTable.closest('.table-wrap').getBoundingClientRect=()=>({top:60,bottom:600});watchedSourceRow.getBoundingClientRect=()=>({top:-100});watchedCont.getBoundingClientRect=()=>({bottom:180});positionWatchedContainer()");assert.equal(w.document.querySelector('#mainTable').closest('.table-wrap').style.getPropertyValue('--purchase-header-offset'),'120px');run('planning.target=null;positionWatchedContainer()');assert.equal(w.document.querySelector('#mainTable').closest('.table-wrap').style.getPropertyValue('--purchase-header-offset'),'0px');
});

test('container freight follows 202 million over 170 m3 and manual override is separate from line costs',t=>{
 const {run,w}=fixture(t);assert.equal(run('PurchaseFreight.calculate({freightMode:"formula"},120).amount'),142588235);assert.equal(run('PurchaseFreight.calculate({freightMode:"formula"},170).amount'),202000000);const before=run('ROWS[0].freightAmount');run("const oldFreight=PurchaseFreight.calculate(contById(2),contStats(2).m3).amount;stagePlanningCell(ROWS[0],'contId',2);stagePlanningCell(ROWS[0],'cartonCount',100);render()");assert.notEqual(run('PurchaseFreight.calculate(contById(2),contStats(2).m3).amount'),run('oldFreight'));run('mockFreightSave(2,{freight:500000,freightMode:"manual"})');assert.equal(run('PurchaseFreight.calculate(contById(2),contStats(2).m3).amount'),500000);assert.equal(run('ROWS[0].freightAmount'),before);run('mockFreightSave(2,{freightMode:"formula"})');assert.notEqual(run('PurchaseFreight.calculate(contById(2),contStats(2).m3).amount'),500000);
});

test('truck column has only vehicle name and status 3 is labelled da boc',t=>{
 const {run,w}=fixture(t);assert.equal(run('STATUS_LABEL[3]'),'3. Đã bốc');const row=w.document.querySelector('#contFull tr[onclick="pickCont(\'2\')"]');assert.ok(row);assert.equal(row.cells[2].querySelector('.crumb'),null);assert.match(row.cells[1].textContent,/Đã bốc/);assert.doesNotMatch(row.cells[2].textContent,/Trong tải|32 T|tới 160/);
});

test('pinned container freight remains editable and reprices product rows',t=>{
 const {run,w}=fixture(t);run("pickCont('2')");const input=w.document.querySelector('#watchedContainer [data-cont-freight="2"]');assert.ok(input);input.value='12,000,000';input.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(run('contById(2).freight'),12000000);assert.equal(run('contById(2).freightMode'),'manual');assert.equal(w.document.querySelector('#watchedContainer [data-cont-freight="2"]').value,'12,000,000');const r=run('planningRows().find(r=>r.contId===2)');assert.ok(run('derive(planningRows().find(r=>r.contId===2)).freightAmount')>0);
});

test('clearing pinned freight restores the standard automatic formula',t=>{const {run,w}=fixture(t);run("pickCont('2');mockFreightSave(2,{freight:123,freightMode:'manual'})");const input=w.document.querySelector('#watchedContainer [data-cont-freight="2"]');input.value='';input.dispatchEvent(new w.Event('change',{bubbles:true}));assert.equal(run('contById(2).freightMode'),'formula');assert.equal(run('contById(2).freightBase'),202000000);assert.equal(run('contById(2).freightCapacity'),170);assert.equal(w.document.querySelector('#watchedContainer [data-cont-freight="2"]').value,run('nf(Math.round(202000000/170*contStats(2).m3))'))});

test('canonical formulas retain blanks and mark incomplete money summaries',t=>{const {run,w}=fixture(t);const result=run("derive({...ROWS[0],qtyPerCarton:300,cartonCount:4,kgPerCarton:13.8,m3PerCarton:.073,literWarehouse:.25,gramWarehouse:40,freightPrepaid:null})");assert.equal(result.totalQty,1200);assert.equal(result.totalCny,null);assert.equal(result.goodsAmount,null);assert.equal(result.totalTon,.0552);assert.equal(result.totalM3,.292);assert.ok(result.literDiff<0);assert.equal(result.gramDiff,.15);run("renderKpis([derive({...ROWS[0],unitPriceCny:null})])");assert.match(w.document.getElementById('kpis').textContent,/Còn 1 dòng thiếu/);assert.match(w.document.getElementById('kpis').textContent,/—/)});
