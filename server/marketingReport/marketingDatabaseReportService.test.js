'use strict';
const test=require('node:test'); const assert=require('node:assert/strict');
const {createDatabaseMarketingReportService}=require('./marketingDatabaseReportService');
const snapshot={pages:[{pageId:'1',name:'Page'}],aliases:[{rawName:'A',reportEmployee:'Sale'},{rawName:'B',reportEmployee:'Sale'}],monthlyRows:[{id:'1',version:'1',reportYear:2026,reportMonth:10,pageId:'1',page:'Page',sale:'Sale',customer:'Known'}],rawRows:[{sourceOrder:'1',pageId:'1',phone:'012',employeeRaw:'A',creditedDate:'2026-10-01'},{sourceOrder:'2',pageId:'1',phone:'012',employeeRaw:'B',creditedDate:'2026-10-02'}]};
test('database aggregation maps after first/last; ratio follows sums; year and snapshots preserved',async()=>{const service=createDatabaseMarketingReportService({repository:{readSnapshot:async()=>structuredClone(snapshot)},legacy:{},revenue:async(m,y)=>({available:true,revenueOf:()=>m+y}),now:()=>Date.parse('2026-10-12')});const report=await service.report('receipt-check',{month:'10',year:'2026'});assert.equal(report.rows[0].first,1);assert.equal(report.rows[0].repeat,1);assert.equal(report.rows[0].equivalent,1.2);assert.equal(report.rows[0].rate,1/1.2); const detail=await service.detail({kind:'receipt-check',key:report.rows[0].key,snapshotId:report.snapshotId});assert.equal(detail.reconciliation.status,'matched');assert.deepEqual(detail.groups.slice(0,3).map(g=>g.rows.length),[1,1,1]);const old=await service.report('receipt-check',{month:'10',year:'2025'});assert.equal(old.rows.length,0);});
test('ADS always delegates to sheets',async()=>{let seen;const service=createDatabaseMarketingReportService({repository:{},legacy:{report:async(k,q)=>{seen=[k,q];return {snapshotId:'ads'};}},revenue:()=>{}});assert.equal((await service.report('costs',{month:10})).snapshotId,'ads');assert.equal(seen[0],'costs');});

test('create validates directory identity, fields and page; update preserves unmatched imported name',async()=>{let written;const service=createDatabaseMarketingReportService({repository:{readSnapshot:async()=>snapshot,createMonthlyRow:async b=>{written=b;return {...b,id:'9',version:'1'};},updateMonthlyRow:async(id,v,b)=>({...b,id,version:String(+v+1)})},legacy:{},revenue:()=>{},businessRepository:{snapshot:async()=>({directory:[{branch:'hanoi',code:'KH1',name:'Known',saleName:'Sale',priceLevel:''}]})}});const input={reportYear:2026,reportMonth:9,sale:'Sale',customer:'Known',customerDirectoryId:'hanoi:KH1',phone:'012',page:'Page',pageId:null,status:'Chốt',dataSource:'Mới',closedAt:'2026-10-01',newCustomer:'',note:''};const saved=await service.createRow({...input},{});assert.equal(saved.row.id,'9');assert.equal(written.pageId,'1');assert.equal(written.reportMonth,9);assert.equal(written.closedAt,'2026-10-01');await assert.rejects(service.createRow({...input,customer:'Other'},{}),{code:'MARKETING_INVALID_CUSTOMER'});await assert.rejects(service.createRow({...input,revenue:9},{}),{code:'MARKETING_INVALID_FIELD'});await assert.rejects(service.createRow({...input,page:'Unknown'},{}),{code:'MARKETING_INVALID_PAGE'});const edited=await service.updateMonthlyRow('1',{...input,version:'1',customer:'Known',customerDirectoryId:null},{});assert.equal(edited.row.customer,'Known');assert.equal(edited.row.version,'2');});
test('directory search bounded and zero denominator rate remains null',async()=>{const service=createDatabaseMarketingReportService({repository:{readSnapshot:async()=>({...snapshot,rawRows:[]})},legacy:{},revenue:()=>{},businessRepository:{snapshot:async()=>({directory:Array.from({length:110},(_,i)=>({branch:'hanoi',code:String(i),name:'Name'}))})}});assert.equal((await service.customers()).customers.length,100);assert.equal((await service.customers({q:'not found'})).customers.length,0);const r=await service.report('receipt-check',{year:2026,month:10});assert.equal(r.rows[0].rate,null);assert.equal(r.kpis.at(-1).value,null);});


test('null-page receipt details stay isolated and raw source names survive mapped phone detail',async()=>{const fixture=structuredClone(snapshot);fixture.monthlyRows.push({...fixture.monthlyRows[0],id:'2',pageId:null,page:''});fixture.rawRows[0].sourceCreatedAt='2026-09-27T00:00:00Z';const service=createDatabaseMarketingReportService({repository:{readSnapshot:async()=>fixture},legacy:{},revenue:()=>{}});const report=await service.report('receipt-check',{year:2026,month:10});const selected=report.rows.find(r=>r.pageId===null);const detail=await service.detail({kind:'receipt-check',key:selected.key,snapshotId:report.snapshotId});assert.deepEqual(detail.groups.slice(0,3).map(g=>g.rows.length),[0,0,1]);assert.equal(detail.reconciliation.status,'matched');assert.ok(detail.subtitle.includes('Page chưa xác định'));const phones=await service.report('phones');const phoneDetail=await service.detail({kind:'phones',key:phones.rows[0].key,snapshotId:phones.snapshotId});const raw=phoneDetail.groups.find(g=>g.kind==='phone-source').rows;assert.deepEqual(raw.map(r=>r.employeeRaw),['A','B']);assert.equal(raw[0].sourceCreatedAt,'2026-09-27T00:00:00Z');assert.equal(raw[0].raw,undefined);});
test('partial versioned update preserves historical blank page and all omitted fields',async()=>{let saved;const historical={...snapshot.monthlyRows[0],pageId:null,page:'',phone:'012',status:'Closed',dataSource:'Old',closedAt:null,note:'Old'};const service=createDatabaseMarketingReportService({repository:{readSnapshot:async()=>({...snapshot,monthlyRows:[historical]}),updateMonthlyRow:async(id,v,b)=>{saved=b;return {...b,id,version:'2'};}},legacy:{},revenue:()=>{}});await service.updateMonthlyRow('1',{version:'1',note:'New'},{});assert.equal(saved.phone,'012');assert.equal(saved.sale,'Sale');assert.equal(saved.pageId,null);assert.equal(saved.status,'Closed');assert.equal(saved.note,'New');await assert.rejects(service.updateMonthlyRow('1',{version:'8',note:'Overwrite'},{}),{code:'MARKETING_VERSION_CONFLICT'});});

test('unavailable directory returns safe503 and metadata exposes exact period pairs',async()=>{const service=createDatabaseMarketingReportService({repository:{readSnapshot:async()=>snapshot},legacy:{metadata:async()=>({})},revenue:()=>{},businessRepository:{snapshot:async()=>{throw new Error('private db diagnostic');}}});await assert.rejects(service.customers(),e=>e.statusCode===503&&e.code==='MARKETING_CUSTOMERS_UNAVAILABLE'&&!e.message.includes('private'));const metadata=await service.metadata();assert.deepEqual(metadata.periods,[{year:2026,month:10}]);});

test('blank-employee row detail ignores same-employee date repeats exactly like the totals',async()=>{
  const fixture=structuredClone(snapshot);
  fixture.rawRows.push({sourceOrder:'3',pageId:'1',phone:'099',employeeRaw:'',creditedDate:'2026-10-01'},{sourceOrder:'4',pageId:'1',phone:'099',employeeRaw:'',creditedDate:'2026-10-03'});
  const service=createDatabaseMarketingReportService({repository:{readSnapshot:async()=>structuredClone(fixture)},legacy:{},revenue:()=>{}});
  const report=await service.report('receipt-check',{year:2026,month:10});
  const blank=report.rows.find(r=>r.employee==='');
  assert.equal(blank.first,1);assert.equal(blank.repeat,0);
  const detail=await service.detail({kind:'receipt-check',key:blank.key,snapshotId:report.snapshotId});
  assert.equal(detail.reconciliation.status,'matched');
  assert.deepEqual(detail.reconciliation.found,{first:1,repeat:0,closed:0});
});
test('directory search requires every keyword, in any order',async()=>{const directory=[{branch:'hanoi',code:'K1',name:'KH A Khả Hân Ba Vì'},{branch:'hanoi',code:'K2',name:'HN A Khanh Dương Nội'},{branch:'hanoi',code:'K3',name:'KH Hân Khách'}];const service=createDatabaseMarketingReportService({repository:{readSnapshot:async()=>({...snapshot,rawRows:[]})},legacy:{},revenue:()=>{},businessRepository:{snapshot:async()=>({directory})}});const names=async q=>(await service.customers({q})).customers.map(r=>r.code);assert.deepEqual(await names('khả hân'),['K1']);assert.deepEqual(await names('han kha'),['K1','K2','K3']);assert.deepEqual(await names('hân khả'),['K1']);assert.deepEqual(await names('ba vì khả'),['K1']);});

// Bảng tổng SĐT theo NV từng lọc lại toàn bộ dòng cho từng NV (~30k dòng × 60 NV ≈ 15 s, treo event loop). Kết quả đếm 1 lượt phải
// giống hệt cách lọc cũ (kể cả tên khác hoa/thường, khoảng trắng thừa, ô chứa nhiều tên) và không còn chạy hàng chục giây.
test('phones summary counts match the per-employee filter and stay fast on 30k rows',async()=>{
  const {norm}=require('./marketingParsers');
  const names=v=>String(v??'').split(/\s*,\s*/).filter(Boolean);
  const oldMatches=(r,employee)=>[r.employee,r.sale,r.firstEmployee,r.currentEmployee,r.repeatEmployee].some(v=>names(v).some(n=>norm(n)===norm(employee)));
  const employees=Array.from({length:60},(_,i)=>`Nhân Viên ${i}`);
  const variants=['Nguyễn  A','nguyễn a','B, C','  C ','Đặng Đ'];
  const rows=Array.from({length:30000},(_,i)=>({pageId:String(i%5),phoneKey:`p${i}`,phone:`09${i}`,
    firstEmployee:i%11===0?variants[i%variants.length]:employees[i%60],currentEmployee:i%13===0?variants[(i+2)%variants.length]:employees[(i*7)%60],
    repeatEmployee:i%3===0?employees[(i*3)%60]:null,firstAt:'2026-10-01',currentAt:'2026-10-02',repeatAt:i%3===0?'2026-10-03':null,trace:[]}));
  const fixture={pages:Array.from({length:5},(_,i)=>({pageId:String(i),name:`Page ${i}`,lastSuccessAt:'2026-10-01'})),aliases:[{rawName:'Đặng Đ',reportEmployee:'Sale Đ'}],monthlyRows:[],
    summary:{rows,employeeRaws:[],periods:[],unresolvedAny:false}};
  const service=createDatabaseMarketingReportService({independent:true,repository:{readIndependentSummary:async()=>fixture},legacy:{},revenue:()=>{}});
  const started=performance.now();
  const report=await service.report('phones',{});
  const elapsed=performance.now()-started;
  const byEmployee=report.summaryRows.filter(r=>r.kind==='employee');
  assert.ok(byEmployee.length>60);
  for(const row of byEmployee)assert.equal(row.count,report.rows.filter(r=>oldMatches(r,row.employee)).length,row.employee);
  for(const row of report.summaryRows.filter(r=>r.kind==='page'))assert.equal(row.count,report.rows.filter(r=>r.page===row.page).length);
  assert.ok(elapsed<3000,`phones report took ${Math.round(elapsed)} ms`);
  const filtered=await service.report('phones',{employee:'NGUYỄN A'});
  assert.equal(filtered.rows.length,report.rows.filter(r=>oldMatches(r,'NGUYỄN A')).length);
  assert.ok(filtered.rows.length>0);
});
