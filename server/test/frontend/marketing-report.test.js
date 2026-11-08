const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const source = fs.readFileSync(path.join(__dirname,'../../public/marketing-report.js'),'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function page(customFetch) {
  const dom = new JSDOM('<div id="view-marketing" class="active"><button id="marketingRefresh"></button><div id="marketingSourceStatus"></div><div id="marketingSections"></div></div><dialog id="marketingDetailDialog"><h2 id="marketingDetailTitle"></h2><p id="marketingDetailSubtitle"></p><p id="marketingDetailStatus"></p><button id="marketingDetailRefresh"></button><button id="marketingDetailClose"></button><div id="marketingDetailBody"></div></dialog>',{runScripts:'outside-only',url:'https://example.test/reports/#marketing',pretendToBeVisual:true});
  const window = dom.window, urls = [];
  window.TKSNav = {can:() => true};
  window.matchMedia = () => ({matches:true});
  window.setInterval = () => 0;
  window.HTMLDialogElement.prototype.showModal = function() { this.open=true; };
  window.HTMLDialogElement.prototype.close = function() { this.open=false; this.dispatchEvent(new window.Event('close')); };
  window.fetch = async (url, options) => {
    urls.push(url);
    if(customFetch) { const custom = await customFetch(url, options); if(custom) return custom; }
    const endpoint = url.split('/').pop().split('?')[0];
    const json = endpoint==='metadata' ? {currentMonth:10,months:{monthly:[9,10],check:[10],costs:[10]}} : endpoint==='detail' ? {title:'Chi tiết page',snapshotId:'snapshot-new',groups:[],kpis:[],computedAt:'2026-10-08T10:00:00Z'} : {snapshotId:'snapshot-1',computedAt:'2026-10-08T09:00:00Z',kpis:[],charts:[],warnings:[],filters:{pages:['Hữu Nghị']},summaryRows:[{key:'page:hn',label:'Hữu Nghị',employee:'Tâm MKT',count:101}],rows:Array.from({length:101},(_,i) => ({key:'phone:'+i,phone:'0'+i,page:'Hữu Nghị',sale:i===100?'Đặng An':'Sale '+i,revenue:101-i}))};
    return {ok:true,status:200,json:async()=>json};
  };
  window.eval(fs.readFileSync(path.join(__dirname,'../../public/shared/search-clear.js'),'utf8'));
  window.eval(fs.readFileSync(path.join(__dirname,'../../public/shared/table-controls.js'),'utf8'));
  window.eval(source);
  return {dom,window,doc:window.document,urls};
}
test('Marketing sort cycles back to source order before pagination',async()=>{
  const p=page();
  try {
    await p.window.TKSMarketing.load();
    const host=p.doc.getElementById('marketing-monthly-rows');
    const click=field=>host.querySelector('[data-sort="'+field+'"]').click();
    const state=field=>host.querySelector('th[data-column-key="'+field+'"]').getAttribute('aria-sort');
    const first=()=>host.querySelector('tbody tr td:nth-child(8)').textContent;
    click('revenue'); assert.equal(state('revenue'),'ascending'); assert.equal(first(),'1');
    click('revenue'); assert.equal(state('revenue'),'descending'); assert.equal(first(),'101');
    click('revenue'); assert.equal(state('revenue'),'none'); assert.equal(first(),'101');
    assert.equal(host._marketingState.sorts.length,0);
    click('revenue'); assert.equal(state('revenue'),'ascending');
    click('sale'); assert.equal(state('sale'),'ascending'); assert.equal(state('revenue'),'none');
  } finally { p.dom.window.close(); }
});

test('Marketing tables search, sort before pagination and expose the shared column picker alongside export',async()=>{
  const p=page(); await p.window.TKSMarketing.load();
  const host=p.doc.getElementById('marketing-monthly-rows');
  assert.equal(host.querySelectorAll('tbody tr').length,100);
  assert.equal(host.querySelector('tbody tr td:nth-child(8)').textContent, '101');
  host.querySelector('[data-sort="revenue"]').click();
  assert.match(host.querySelector('tbody tr').textContent,/Đặng An/);
  const search=host.querySelector('input[type="search"]'); search.value='dang an'; search.dispatchEvent(new p.window.Event('input'));
  assert.equal(host.querySelectorAll('tbody tr').length,1);
  assert.equal(host.querySelector('[data-column]'),null);
  assert.equal(p.doc.querySelector('.marketing-columns, .marketing-toc'),null);
  assert.ok(host.querySelector('.tks-columns-button'));
  assert.equal(host.querySelectorAll('th[data-column-key]').length,10);
  host.querySelector('.tks-columns-button').click();
  const phone=p.doc.querySelector('.tks-columns-picker:not([hidden]) input[data-column-key="phone"]');
  phone.checked=false; phone.dispatchEvent(new p.window.Event('change',{bubbles:true}));
  host.querySelector('[data-sort="revenue"]').click();
  assert.ok(host.querySelector('th[data-column-key="phone"]').classList.contains('tks-column-hidden'));
  assert.ok(host.querySelector('tbody tr td:nth-child(3)').classList.contains('tks-column-hidden'));
  p.doc.querySelector('.tks-columns-picker:not([hidden]) [data-action="close"]').click();
  let opened;
  p.window.exportFetch=(url)=>url; p.window.startExportDialog=async(payload,source)=>{opened={payload,source};};
  host.querySelector('.export-button').click();
  const query=new URLSearchParams(opened.payload.query);
  assert.deepEqual([query.get('kind'),query.get('table'),query.get('q'),query.get('month')],['monthly','rows','dang an','10']);
  const fileUrl=opened.source.file({...opened.payload,columns:{rows:['sale','revenue']},format:'html'},{});
  assert.match(fileUrl,/^\/api\/marketing-report\/export\?/);
  assert.equal(new URL(fileUrl,'https://example.test').searchParams.get('columns'),'sale,revenue');
  await settle();
  const clear=host.querySelector('.tks-search-clear'); assert.ok(clear); assert.equal(clear.hidden,false);
  clear.click(); assert.equal(search.value,''); assert.equal(host.querySelectorAll('tbody tr').length,100);
  assert.equal(clear.hidden,true); assert.equal(p.doc.activeElement,search);
  p.dom.window.close();
});
test('Keyboard detail pins snapshot, refresh repins and close returns focus',async()=>{
  const p=page(); await p.window.TKSMarketing.load();
  const row=p.doc.querySelector('#marketing-phones-rows tr[data-detail-key]');
  row.dispatchEvent(new p.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await settle();
  let detail=p.urls.filter(url=>url.includes('/detail?')).pop();
  assert.equal(new URL(detail,'https://example.test').searchParams.get('snapshotId'),'snapshot-1');
  assert.equal(p.doc.getElementById('marketingDetailDialog').open,true);
  p.doc.getElementById('marketingDetailRefresh').click(); await settle();
  detail=p.urls.filter(url=>url.includes('/detail?')).pop();
  const params=new URL(detail,'https://example.test').searchParams;
  assert.equal(params.get('refresh'),'1'); assert.equal(params.has('snapshotId'),false);
  p.doc.getElementById('marketingDetailClose').click(); assert.equal(p.doc.activeElement,row);
  p.dom.window.close();
});
test('Source failure keeps other reports available; closing discards pending detail',async()=>{
  let resolveDetail;
  const p=page(async url=>{
    if(url.includes('/costs?')) return {ok:false,status:503,json:async()=>({error:'Nguồn chi phí chưa sẵn sàng'})};
    if(url.includes('/detail?')) return new Promise(resolve=>{resolveDetail=resolve;});
  });
  await p.window.TKSMarketing.load();
  assert.match(p.doc.getElementById('marketing-costs-status').textContent,/Nguồn chi phí/);
  assert.ok(p.doc.querySelector('#marketing-phones-rows tbody tr'));
  p.doc.querySelector('#marketing-phones-rows tr[data-detail-key]').click(); await settle();
  p.doc.getElementById('marketingDetailClose').click();
  resolveDetail({ok:true,status:200,json:async()=>({title:'Phản hồi cũ',groups:[]})}); await settle();
  assert.notEqual(p.doc.getElementById('marketingDetailTitle').textContent,'Phản hồi cũ');
  p.dom.window.close();
});
test('Changing month discards an older response that arrives after the current selection',async()=>{
  let resolveOld;
  const p=page(async url=>{
    if(url.includes('/monthly?month=9')) return new Promise(resolve=>{resolveOld=resolve;});
  });
  await p.window.TKSMarketing.load();
  const select=p.doc.getElementById('marketing-monthly-month');
  select.value='9'; select.dispatchEvent(new p.window.Event('change')); await settle();
  select.value='10'; select.dispatchEvent(new p.window.Event('change')); await settle();
  resolveOld({ok:true,status:200,json:async()=>({computedAt:'2026-09-01',snapshotId:'old',rows:[{sale:'Phản hồi tháng cũ'}],summaryRows:[],kpis:[],charts:[],warnings:[]})}); await settle();
  assert.doesNotMatch(p.doc.getElementById('marketing-monthly-rows').textContent,/Phản hồi tháng cũ/);
  assert.equal(p.doc.getElementById('marketing-monthly-month').value,'10');
  p.dom.window.close();
});
test('Source ratios display as percentages and fractional conversion counts stay precise',async()=>{
  const p=page(async url=>{
    if(url.includes('/receipt-check?')) return {ok:true,status:200,json:async()=>({snapshotId:'ratio',computedAt:'2026-10-08',rows:[{key:'check:1',name:'Sale',equivalent:147.4,rate:.040705}],summaryRows:[],kpis:[{label:'Tỷ lệ',value:.040705,format:'percent'},{label:'Quy đổi',value:147.4,format:'number'}],charts:[],warnings:[],filters:{}})};
  });
  await p.window.TKSMarketing.load();
  const rows=p.doc.getElementById('marketing-receipt-check-rows').textContent;
  assert.match(rows,/4.07%/); assert.match(rows,/147.4/);
  const cards=p.doc.getElementById('marketing-receipt-check-kpis').textContent;
  assert.match(cards,/4.07%/); assert.match(cards,/147.4/);
  p.dom.window.close();
});
test('Filter/status IDs are unique and KPI cards occupy real report-grid columns',async()=>{
  const p=page(async url=>{
    if(url.includes('/monthly?')) return {ok:true,status:200,json:async()=>({snapshotId:'unique',computedAt:'2026-10-08',rows:[],summaryRows:[],kpis:[{label:'Doanh số',value:28000751,format:'money'},{label:'Số khách',value:100,format:'number'},{label:'Page',value:6,format:'number'}],charts:[],warnings:[],filters:{statuses:['Đã chốt đơn']}})};
  });
  await p.window.TKSMarketing.load();
  const ids=Array.from(p.doc.querySelectorAll('[id]'),element=>element.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(p.doc.getElementById('marketing-monthly-filter-status').options.length,2);
  assert.match(p.doc.getElementById('marketing-monthly-status').textContent,/Đọc nguồn lúc/);
  assert.ok(Array.from(p.doc.querySelectorAll('#marketing-monthly-kpis .kpi-card')).every(card=>card.classList.contains('col-4')));
  p.dom.window.close();
});
test('Receipt-check employee/page detail rows open the pinned source detail',async()=>{
  const p=page(async url=>{
    if(url.includes('/receipt-check?')) return {ok:true,status:200,json:async()=>({snapshotId:'check-snapshot',computedAt:'2026-10-08',rows:[{key:'check:employee-page',name:'Mai',page:'Hữu Nghị',first:20}],summaryRows:[],kpis:[],charts:[],warnings:[],filters:{}})};
  });
  await p.window.TKSMarketing.load();
  p.doc.querySelector('#marketing-receipt-check-rows tr[data-detail-key]').dispatchEvent(new p.window.KeyboardEvent('keydown',{key:' ',bubbles:true})); await settle();
  const params=new URL(p.urls.filter(url=>url.includes('/detail?')).pop(),'https://example.test').searchParams;
  assert.equal(params.get('kind'),'receipt-check'); assert.equal(params.get('key'),'check:employee-page'); assert.equal(params.get('snapshotId'),'check-snapshot');
  p.dom.window.close();
});
test('Phone summary detail drills into a record in the same dialog and returns focus to the page',async()=>{
  const p=page(async url=>{
    if(url.includes('/detail?')) {
      const params=new URL(url,'https://example.test').searchParams;
      const rows=params.get('key')==='page:hn' ? [{key:'phone:1',phone:'09001',page:'Hữu Nghị'},{key:'phone:2',phone:'09002',page:'Hữu Nghị'}] : [{key:'phone:1',phone:'09001',page:'Hữu Nghị',firstEmployee:'Mai'}];
      return {ok:true,status:200,json:async()=>({snapshotId:'phone-pinned',title:'SĐT',computedAt:'2026-10-08',groups:[{kind:'phones',title:'Danh sách SĐT',rows}],kpis:[],warnings:[]})};
    }
  });
  await p.window.TKSMarketing.load();
  const original=p.doc.querySelector('#marketing-phones-rows tr[data-detail-key]'); original.click(); await settle();
  p.doc.querySelector('#marketingDetailBody tr[data-detail-key]').dispatchEvent(new p.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await settle();
  const params=new URL(p.urls.filter(url=>url.includes('/detail?')).pop(),'https://example.test').searchParams;
  assert.equal(params.get('key'),'phone:1'); assert.equal(params.get('snapshotId'),'phone-pinned');
  assert.equal(p.doc.querySelectorAll('dialog[open]').length,1);
  assert.match(p.doc.getElementById('marketingDetailBody').textContent,/Mai/);
  p.doc.getElementById('marketingDetailClose').click(); assert.equal(p.doc.activeElement,original);
  p.dom.window.close();
});

const monthlyJson = rows => ({ok:true,status:200,json:async()=>({snapshotId:'s1',computedAt:'2026-10-08T09:00:00Z',kpis:[],charts:[],warnings:[],filters:{},summaryRows:[],rows})});

test('tên sale đuôi MKT được tô vàng, tên khác thì không',async()=>{
  const p=page(url=>url.includes('/monthly?')?monthlyJson([
    {key:'a',sale:'Hoàng MKT',customer:'KH A',phone:'0912345678',newCustomer:'',note:''},
    {key:'b',sale:'Uyên SG',customer:'KH B',phone:'0900000000',newCustomer:'',note:''}]):null);
  p.window.TKSNav={can:name=>name!=='reports.marketing.edit'};
  await p.window.TKSMarketing.load();
  const cells=[...p.doc.querySelectorAll('#marketing-monthly-rows tbody tr')].map(tr=>tr.querySelector('td').innerHTML);
  assert.match(cells[0],/<span class="mkt-name">Hoàng MKT<\/span>/);
  assert.doesNotMatch(cells[1],/mkt-name/);
  assert.equal(p.doc.querySelector('#marketing-monthly-rows [data-edit]'),null,'không có quyền sửa thì không có ô nhập');
  p.dom.window.close();
});

test('sửa Ghi chú gửi PUT kèm snapshot, lỗi thì trả lại giá trị cũ',async()=>{
  const puts=[];let fail=false;
  const p=page(url=>url.includes('/monthly?')?monthlyJson([{key:'a',sale:'Hoàng MKT',customer:'KH A',phone:'0912345678',newCustomer:'',note:'cũ'}]):null);
  const base=p.window.fetch;
  p.window.fetch=async(url,init)=>{
    if(String(url).includes('/monthly/row')){puts.push({url,init});return fail?{ok:false,status:409,json:async()=>({error:'Dòng đã đổi'})}:{ok:true,status:200,json:async()=>({ok:true,field:'note',value:JSON.parse(init.body).value})};}
    return base(url,init);
  };
  await p.window.TKSMarketing.load();
  const input=p.doc.querySelector('#marketing-monthly-rows textarea[data-edit="note"]');
  assert.equal(input.getAttribute('wrap'),'soft');
  assert.equal(input.maxLength,500);
  Object.defineProperty(input,'scrollHeight',{value:94});
  input.dispatchEvent(new p.window.Event('input'));
  assert.equal(input.style.height,'94px');
  input.value='bản nháp chưa lưu';
  const escape=new p.window.KeyboardEvent('keydown',{key:'Escape',cancelable:true});
  input.dispatchEvent(escape);
  assert.equal(input.value,'cũ');
  assert.equal(escape.defaultPrevented,true);
  const enter=new p.window.KeyboardEvent('keydown',{key:'Enter',cancelable:true});
  input.dispatchEvent(enter);
  assert.equal(enter.defaultPrevented,true);
  assert.equal(input.value,'cũ');
  input.value='gọi lại ngày mai';input.dispatchEvent(new p.window.Event('change'));await settle();
  assert.equal(puts[0].init.method,'PUT');
  assert.deepEqual(JSON.parse(puts[0].init.body),{snapshotId:'s1',key:'a',field:'note',value:'gọi lại ngày mai'});
  fail=true;
  input.value='lỗi';input.dispatchEvent(new p.window.Event('change'));await settle();
  assert.equal(input.value,'gọi lại ngày mai');
  assert.match(p.doc.getElementById('marketing-monthly-status').textContent,/Dòng đã đổi/);
  p.dom.window.close();
});

function databasePage(canEdit=true, onWrite) {
  return page(async (url,options)=>{
    const reply=json=>({ok:true,status:200,json:async()=>json});
    if(options?.method && options.method!=='GET') return onWrite ? onWrite(url,options) : reply({row:{id:'row-1'}});
    if(url.includes('/metadata?'))return reply({sourceMode:'database',canEdit,pages:[{pageId:'1184366971419195',name:'Hữu Nghị'}],currentMonth:10,currentYear:2026,months:{monthly:[10],check:[10],costs:[10]}});
    if(url.includes('/sync-status?'))return reply({pages:[{pageName:'<img src=x>',status:'Lỗi',lastSuccessAt:'2026-10-10',lastError:'<script>alert(1)</script>'}]});
    if(url.includes('/customers?'))return reply({customers:[{id:'1:KH01',branch:'HN',code:'KH01',name:'Khách đã chọn'}]});
    if(url.includes('/audit?'))return reply({audit:[{createdAt:'2026-10-10',actorName:'Quản lý',changes:{note:'<img src=x>'}}]});
    if(url.includes('/aliases?'))return reply({aliases:[],unmapped:['Tên chưa rõ']});
    if(url.includes('/monthly?'))return reply({computedAt:'2026-10-10',rows:[{id:'row-1',key:'row-1',version:'2',reportMonth:9,reportYear:2026,sale:'Sale',customer:'Khách',phone:'0900000000',page:'Hữu Nghị',closedAt:'2026-10-01',note:'ghi chú'}],filters:{pages:['Hữu Nghị']}});
  });
}
test('Database manager form preserves report period, chooses Kiot customer and submits version; conflict retains input',async()=>{
  let submitted;
  const p=databasePage(true,(url,options)=>{submitted={url,body:JSON.parse(options.body)};return {ok:false,status:409,json:async()=>({error:'conflict'})};});
  await p.window.TKSMarketing.load();
  assert.equal(p.doc.querySelector('#marketing-monthly-rows textarea'),null);
  assert.equal(p.doc.getElementById('marketing-monthly-year').value,'2026');
  assert.equal(p.doc.querySelector('#marketingOperations'),null);
  assert.equal(p.urls.some(url=>url.includes('/sync-status?')),false);
  p.doc.querySelector('#marketing-monthly-rows [data-detail-key]').click();await settle();
  const form=p.doc.querySelector('#marketingEditorDialog form');
  assert.equal(form.elements.reportMonth.value,'9');assert.equal(form.elements.closedAt.value,'2026-10-01');
  p.doc.querySelector('[data-customer-search]').value='Khách';p.doc.querySelector('[data-find]').click();await settle();
  p.doc.querySelector('[data-customers] button').click();form.elements.note.value='Nội dung mới';
  form.dispatchEvent(new p.window.Event('submit',{cancelable:true}));await settle();
  assert.equal(submitted.url,'/api/marketing-report/monthly/rows/row-1');assert.equal(submitted.body.version,'2');assert.equal(submitted.body.customerDirectoryId,'1:KH01');assert.equal(submitted.body.reportMonth,9);
  assert.equal(form.elements.note.value,'Nội dung mới');assert.equal(form.querySelector('[type="submit"]').disabled,true);assert.match(form.querySelector('[data-message]').textContent,/người khác/);
  assert.equal(p.doc.querySelector('#marketingEditorDialog img'),null);p.dom.window.close();
});
test('Database read-only user has no editing or alias controls even with feature permission',async()=>{
 const p=databasePage(false);await p.window.TKSMarketing.load();
 assert.equal(p.doc.querySelector('#marketing-monthly-rows [data-detail-key]'),null);
 assert.equal(p.doc.querySelector('#marketing-monthly-rows .mini-filter-apply'),null);
 assert.equal(p.doc.querySelector('[data-aliases]'),null);assert.equal(p.doc.querySelector('#marketing-monthly-rows textarea'),null);p.dom.window.close();
});
test('Database manager creates a row with a separate report period',async()=>{
 const writes=[];const p=databasePage(true,(url,options)=>{writes.push({url,body:JSON.parse(options.body)});return {ok:true,status:200,json:async()=>({row:{id:'new'}})};});await p.window.TKSMarketing.load();
 p.doc.querySelector('#marketing-monthly-rows .mini-filter-apply').click();let form=p.doc.querySelector('#marketingEditorDialog form');
 Object.entries({sale:'Sale',customer:'Khách',phone:'0900000000',page:'Hữu Nghị',closedAt:'2026-09-30',reportMonth:'10',reportYear:'2026'}).forEach(([key,value])=>form.elements[key].value=value);
 p.doc.querySelector('[data-find]').click();await settle();p.doc.querySelector('[data-customers] button').click();form.elements.status.value='Chốt';form.elements.dataSource.value='Pancake';form.dispatchEvent(new p.window.Event('submit',{cancelable:true}));await settle();assert.equal(writes[0].url,'/api/marketing-report/monthly/rows');assert.equal(writes[0].body.reportMonth,10);assert.equal(writes[0].body.closedAt,'2026-09-30');
 assert.equal(p.doc.querySelector('[data-aliases]'),null);p.dom.window.close();
});

test('Imported monthly row with unresolved page keeps blank when saved',async()=>{
 let submitted;
 const p=page(async(url,options)=>{
  const reply=json=>({ok:true,status:200,json:async()=>json});
  if(options?.method==='PUT'){submitted=JSON.parse(options.body);return reply({row:{id:'legacy'}});}
  if(url.includes('/metadata?'))return reply({sourceMode:'database',canEdit:true,currentMonth:10,currentYear:2026,pages:[{pageId:'firstpage',name:'Hữu Nghị'}],months:{monthly:[10],check:[10],costs:[10]}});
  if(url.includes('/sync-status?'))return reply({pages:[]});
  if(url.includes('/audit?'))return reply({audit:[]});
  if(url.includes('/monthly?'))return reply({rows:[{id:'legacy',key:'legacy',version:'1',page:null,pageId:null,customer:'Khách cũ',phone:'0900000000',sale:'An',status:'Chốt',dataSource:'Sheets',closedAt:'2026-10-01',reportMonth:10,reportYear:2026}],filters:{}});
 });await p.window.TKSMarketing.load();p.doc.querySelector('#marketing-monthly-rows [data-detail-key]').click();await settle();
 const form=p.doc.querySelector('#marketingEditorDialog form');assert.equal(form.elements.page.value,'');assert.equal(form.elements.page.required,false);
 form.elements.note.value='Sửa ghi chú';form.dispatchEvent(new p.window.Event('submit',{cancelable:true}));await settle();assert.equal(submitted.page,'');assert.equal(submitted.pageId,null);p.dom.window.close();
});
test('Phone source detail exposes raw observations with escaped text and distinct Vietnam source time/report date',async()=>{
 const p=page(async url=>{if(url.includes('/detail?'))return {ok:true,status:200,json:async()=>({groups:[{kind:'phone-source',title:'Dữ liệu nguồn',rows:[{phone:'0900000000',employeeRaw:'<img src=x>',sourceCreatedAt:'2026-09-30T18:30:00Z',sourceCreatedText:'30/09/2026',creditedDate:'2026-10-02',origin:'pancake',sourceKey:'<script>x</script>',rowNumber:7}]}]})};});
 await p.window.TKSMarketing.load();p.doc.querySelector('#marketing-phones-rows [data-detail-key]').click();await settle();const host=p.doc.querySelector('#marketing-detail-group-0');assert.ok(host.querySelector('[data-column-key="employeeRaw"]'));assert.ok(host.querySelector('[data-column-key="sourceCreatedAt"]'));assert.match(host.textContent,/<img src=x>/);assert.equal(host.querySelector('img,script'),null);assert.match(host.textContent,/02\/10\/2026/);assert.match(host.textContent,/1\/10\/2026/);assert.match(host.textContent,/01:30/);p.dom.window.close();
});

test('Marketing omits sync panel and month choices follow exact year/month pairs; ADS has no year control',async()=>{
 const p=page(async url=>{const reply=json=>({ok:true,status:200,json:async()=>json});
 if(url.includes('/metadata?'))return reply({sourceMode:'database',canEdit:false,currentMonth:10,currentYear:2026,months:{monthly:[9,10],check:[9,10],costs:[10]},periods:[{year:2025,month:9},{year:2026,month:10}]});
 if(url.includes('/sync-status?'))return reply({pages:[{name:'Page',status:'pending',lastSuccessAt:null},{name:'Page khác',status:'success',lastSuccessAt:'2026-10-12T00:41:00Z'}]});
 });await p.window.TKSMarketing.load();assert.equal(p.doc.querySelector('#marketingOperations'),null);assert.equal(p.urls.some(url=>url.includes('/sync-status?')),false);
 assert.equal(p.doc.getElementById('marketing-costs-year'),null);const month=p.doc.getElementById('marketing-monthly-month');assert.deepEqual(Array.from(month.options,o=>o.value),['10']);const year=p.doc.getElementById('marketing-monthly-year');year.value='2025';year.dispatchEvent(new p.window.Event('change'));await settle();
 const options=Array.from(p.doc.getElementById('marketing-monthly-month').options,o=>[o.value,o.textContent]);assert.deepEqual(options.map(o=>o[0]),['9','10']);assert.match(options[1][1],/Chưa có dữ liệu/);assert.match(p.doc.getElementById('marketing-monthly-warnings').textContent,/tháng\/năm/);p.dom.window.close();
});
test('hộp chi tiết Marketing: hàng chỉ số dạng .dp-stat và bảng trong hộp CŨNG có sort, kéo cột, nút "Cột hiển thị" như bảng ngoài trang',async()=>{
  const p=page(async url=>{
    if(url.includes('/detail?')) return {ok:true,status:200,json:async()=>({snapshotId:'d1',title:'Chi tiết page',computedAt:'2026-10-08',kpis:[{label:'Số điện thoại',value:12,format:'number'},{label:'Tỷ lệ chốt',value:.25,format:'percent'}],groups:[{kind:'phones',title:'Danh sách SĐT',rows:[{key:'phone:1',phone:'09001',page:'Hữu Nghị'}]}],warnings:[]})};
  });
  await p.window.TKSMarketing.load();
  assert.ok(p.doc.querySelector('#marketing-monthly-rows .tks-columns-button'),'bang ngoai trang co nut Cot hien thi');
  p.doc.querySelector('#marketing-phones-rows tr[data-detail-key]').click(); await settle();
  const body=p.doc.getElementById('marketingDetailBody');
  const tiles=[...body.querySelectorAll('.dp-stat')].map(el=>[el.querySelector('.dp-stat-label').textContent,el.querySelector('.dp-stat-value').textContent]);
  assert.deepEqual(tiles,[['Số điện thoại','12'],['Tỷ lệ chốt','25%']]);
  assert.equal(body.querySelector('table').getAttribute('data-table-controls'),null);
  p.window.TKSTables.refreshAll();
  const dialog=p.doc.getElementById('marketingDetailDialog');
  assert.equal(dialog.querySelectorAll('.tks-columns-button').length,1);
  assert.ok(dialog.querySelectorAll('th > .tks-column-resizer').length>0);
  assert.equal(dialog.querySelector('th .sort-indicator').textContent,'▲▼');
  p.dom.window.close();
});

test('Pancake independent dataset labels sources and preserves legacy selection in details and exports',async()=>{
 const p=page(async url=>{const reply=json=>({ok:true,status:200,json:async()=>json});if(url.includes('/metadata?'))return reply({sourceMode:'database',dataset:'pancake-independent',canEdit:true,currentMonth:10,currentYear:2026,months:{monthly:[10],check:[10],costs:[10]},pages:[]});if(url.includes('/sync-status?'))return reply({pages:[]});});
 await p.window.TKSMarketing.load();assert.match(p.doc.getElementById('marketingSourceStatus').textContent,/Pancake độc lập/);
 for(const kind of ['phones','monthly','receipt-check'])assert.ok(p.doc.getElementById('marketing-'+kind+'-dataset'));
 const select=p.doc.getElementById('marketing-monthly-dataset');select.value='legacy';select.dispatchEvent(new p.window.Event('change'));await settle();assert.equal(p.doc.querySelector('#marketing-monthly-rows .mini-filter-apply'),null);
 const phones=p.doc.getElementById('marketing-phones-dataset');phones.value='legacy';phones.dispatchEvent(new p.window.Event('change'));await settle();
 p.doc.querySelector('#marketing-phones-rows [data-detail-key]').click();await settle();const detail=p.urls.filter(u=>u.includes('/detail?')).at(-1);assert.equal(new URL(detail,'https://example.test').searchParams.get('dataset'),'legacy');p.dom.window.close();
});


test('Marketing retains three priorities, cycles a middle priority and sends all export sorts',async()=>{
  const p=page();
  try {
    await p.window.TKSMarketing.load();
    const host=p.doc.getElementById('marketing-monthly-rows');
    const click=(key,shiftKey=false)=>host.querySelector('[data-sort="'+key+'"]').dispatchEvent(new p.window.MouseEvent('click',{bubbles:true,shiftKey}));
    click('page'); click('sale',true); click('revenue',true); click('sale',true);
    assert.equal(host.querySelector('[data-sort="page"] .sort-indicator').textContent,'▲1');
    assert.equal(host.querySelector('[data-sort="sale"] .sort-indicator').textContent,'▼2');
    assert.equal(host.querySelector('[data-sort="revenue"] .sort-indicator').textContent,'▲3');
    click('sale',true);
    assert.equal(host.querySelector('[data-sort="revenue"] .sort-indicator').textContent,'▲2');
    assert.equal(host._marketingState.sorts.length,2);
  } finally {p.dom.window.close();}
});


test('server Marketing paging/search/sort uses whole-result envelopes, debounces input and ignores stale success and errors',async()=>{
  const delayed=new Map(), monthly=[];
  const p=page(async url=>{
    const parsed=new URL(url,'https://example.test');
    if(parsed.pathname!=='/api/marketing-report/monthly')return;
    const q=parsed.searchParams.get('q')||'', pageNumber=Number(parsed.searchParams.get('pageNumber')||1);
    monthly.push(parsed.searchParams);
    if(q.startsWith('slow'))return new Promise(resolve=>delayed.set(q,resolve));
    return {ok:true,status:200,json:async()=>({kind:'monthly',rows:[{key:'remote:'+pageNumber,customer:q||'Remote '+pageNumber,sale:'Lan',revenue:7}],totalRows:q?1:205,page:q?1:pageNumber,pageSize:100,snapshotId:'snap-'+q,kpis:[{label:'Khách chốt',value:q?1:205}],charts:[],filters:{pages:['HN']},warnings:[]})};
  });
  const pause=()=>new Promise(resolve=>setTimeout(resolve,300));
  try {
    await p.window.TKSMarketing.load();
    const host=p.doc.getElementById('marketing-monthly-rows');
    assert.equal(host.querySelectorAll('tbody tr').length,1);
    assert.match(host.querySelector('[data-count]').textContent,/205/);
    assert.match(p.doc.getElementById('marketing-monthly-kpis').textContent,/205/);
    host.querySelector('#marketing-monthly-data-table-next').click();await settle();
    assert.equal(monthly.at(-1).get('pageNumber'),'2');assert.match(host.querySelector('tbody').textContent,/Remote 2/);
    host.querySelector('[data-sort="revenue"]').click();await settle();
    assert.equal(monthly.at(-1).get('pageNumber'),'1');assert.deepEqual(JSON.parse(monthly.at(-1).get('sorts')),[{key:'revenue',dir:'asc'}]);
    const type=value=>{const search=host.querySelector('input[type="search"]');search.focus();search.value=value;search.dispatchEvent(new p.window.Event('input'));};
    const before=monthly.length;
    type('s');type('sl');type('slow-success');
    assert.equal(monthly.length,before);await pause();assert.equal(monthly.length,before+1);
    type('latest');
    delayed.get('slow-success')({ok:true,status:200,json:async()=>({rows:[{customer:'STALE SUCCESS'}],totalRows:99,page:1,pageSize:100,kpis:[]})});
    await settle();assert.doesNotMatch(host.querySelector('tbody').textContent,/STALE/);
    await pause();assert.match(host.querySelector('tbody').textContent,/latest/);assert.match(p.doc.getElementById('marketing-monthly-kpis').textContent,/1/);
    assert.equal(p.doc.activeElement.id,'marketing-monthly-data-table-search');
    type('slow-error');await pause();type('newest');await pause();
    delayed.get('slow-error')({ok:false,status:401,json:async()=>({error:'STALE ERROR'})});await settle();
    assert.match(host.querySelector('tbody').textContent,/newest/);assert.doesNotMatch(p.doc.getElementById('marketing-monthly-status').textContent,/STALE ERROR/);
    assert.equal(p.doc.getElementById('marketing-monthly').getAttribute('aria-busy'),'false');
    assert.equal(p.window.location.pathname,'/reports/');
    assert.equal(monthly.at(-1).get('q'),'newest');assert.equal(monthly.at(-1).get('pageSize'),'100');
  } finally {p.dom.window.close();}
});

test('server detail groups retain page/search state and snapshot while paging independently',async()=>{
  const calls=[];
  const p=page(async url=>{
    const parsed=new URL(url,'https://example.test');if(parsed.pathname!=='/api/marketing-report/detail')return;
    calls.push(parsed.searchParams);const queries=JSON.parse(parsed.searchParams.get('groupQueries')||'{}');
    return {ok:true,status:200,json:async()=>({title:'Detail',snapshotId:'snapshot-1',kpis:[{label:'Full detail',value:205}],groups:[{kind:'phones',title:'Phones',rows:[{key:'record',phone:'0900000000'}],totalRows:205,page:queries[0]?.pageNumber||1,pageSize:100},{kind:'monthly',title:'Monthly',rows:[{customer:'Full customer'}],totalRows:1,page:1,pageSize:100}]})};
  });
  try{
    await p.window.TKSMarketing.load();p.doc.querySelector('#marketing-phones-rows tr[data-detail-key]').click();await settle();
    p.doc.querySelector('#marketing-detail-group-0 #marketing-detail-phones-0-next').click();await settle();
    assert.equal(calls.at(-1).get('snapshotId'),'snapshot-1');
    const states=JSON.parse(calls.at(-1).get('groupQueries'));
    assert.equal(states[0].pageNumber,2);assert.equal(states[1].pageNumber,1);
    assert.match(p.doc.querySelector('#marketing-detail-group-0 [data-page-label]').textContent,/2\/3/);
    assert.match(p.doc.getElementById('marketingDetailBody').textContent,/205/);
  }finally{p.dom.window.close();}
});
