const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareRows, prepareWorkbook, prepareSnapshotWorkbook, recheckPreview } = require('./purchaseOrdersImport');
const excel = require('../public/shared/purchase-workbook');
const XLSX = require('xlsx');
const columns = require('../public/shared/purchase-columns');
const existing = () => [{ id: 1, rowKey: 'D00001.01', version: 2, productCode: 'A', productName: 'Tape', cartonCount: 10, qtyPerCarton: 20, supplier: 'NCC', contId: 7 }];
const fresh = () => ({ productCode: 'A', productName: 'Tape', cartonCount: 5, qtyPerCarton: 20 });

test('same product without row key always creates a new waiting line, without modifying source', () => {
  const rows = existing(), before = JSON.stringify(rows);
  const result = prepareRows([fresh()], rows, { listedAt: '2026-11-03' });
  assert.equal(result.valid, true);
  assert.equal(result.operations[0].action, 'create');
  assert.equal(result.operations[0].values.contId, null);
  assert.equal(result.operations[0].values.listedAt, '2026-11-03');
  assert.equal(JSON.stringify(rows), before);
});
test('partial update preserves blank fields, permits code rename, and ignores computed/cont fields', () => {
  const result = prepareRows([{ rowKey: 'D00001.01', productCode: 'RENAMED', supplier: '', cartonCount: 11, container: 'Other', totalQty: 999 }], existing());
  assert.equal(result.valid, true);
  assert.deepEqual(result.operations[0].changes.map(c => c.key), ['productCode', 'cartonCount']);
  assert.equal(result.operations[0].expectedVersion, 2);
});
test('measurement columns are ignored by import templates and cannot change a row',()=>{
  const result=prepareRows([{rowKey:'D00001.01',productCode:'A',literWarehouse:1.25,m3Warehouse:.42,literChina:1.1,literDiff:-12,gramWarehouse:350,gramChina:300,gramDiff:-14,measuredOn:'2026-11-12',ratio:.8}],existing());
  assert.equal(result.valid,true,result.rows[0].errors.join('; '));
  assert.equal(result.rows[0].action,'unchanged');
  assert.deepEqual(result.operations,[]);
});
test('one error suppresses the whole plan; all errors remain available to the UI', () => {
  const result = prepareRows([fresh(), { rowKey: 'D99999', productCode: 'B' }], existing());
  assert.equal(result.valid, false);
  assert.equal(result.rows.length, 2);
  assert.equal(result.operations.length, 0);
});
test('retired split keys and duplicate keys are rejected', () => {
  assert.match(prepareRows([{ rowKey: 'D00001', productCode: 'A' }], existing()).rows[0].errors.join(), /tách/);
  const result = prepareRows([{ rowKey: 'D00001.01', productCode: 'A' }, { rowKey: 'D00001.01', productCode: 'A' }], existing());
  assert.equal(result.counts.error, 2);
  assert.equal(result.operations.length, 0);
  const padded = prepareRows([{ rowKey: ' D00001.01 ', productCode: 'A' }, { rowKey: 'D00001.01', productCode: 'A' }], existing());
  assert.equal(padded.counts.error, 2);
});
test('unchanged numeric values do not produce false updates', () => {
  const result = prepareRows([{ rowKey: 'D00001.01', productCode: 'A', cartonCount: '10.0' }], existing());
  assert.equal(result.counts.unchanged, 1);
  assert.equal(result.operations.length, 0);
});
test('negative/ambiguous/fractional counts and invalid dates block the plan', () => {
  for (const patch of [{ cartonCount: -1 }, { cartonCount: 1.5 }, { cartonCount: '1,00' }, { listedAt: '31/02/2026' }, { qtyPerCarton: Number.POSITIVE_INFINITY }]) {
    assert.equal(prepareRows([{ ...fresh(), ...patch }], []).valid, false);
  }
});
test('recheck refuses all operations when even an unchanged row changed since preview', () => {
  const rows = existing();
  const preview = prepareRows([{ rowKey: 'D00001.01', productCode: 'A' }, fresh()], rows);
  rows[0].version++;
  const result = recheckPreview(preview, rows);
  assert.equal(result.code, 'VERSION_CONFLICT');
  assert.deepEqual(result.operations, []);
});
test('recheck detects splitting/removal of a previously valid row', () => {
  const preview = prepareRows([{ rowKey: 'D00001.01', productCode: 'A', cartonCount: 3 }], existing());
  assert.equal(recheckPreview(preview, []).valid, false);
});
test('snapshot recheck keeps the active row when its display key was reused', () => {
  const current = { ...existing()[0], id: 2, productCode: 'CURRENT' };
  const archived = { ...existing()[0], id: 1, productCode: 'ARCHIVED', deletedAt: '2026-11-01' };
  const preview = prepareRows([{ rowKey: current.rowKey, productCode: 'CURRENT', productName: 'Renamed' }], [current], { snapshot: true, archivedRows: [archived] });
  assert.equal(preview.rows[0].action, 'update');
  const checked = recheckPreview(preview, [current], [archived]);
  assert.equal(checked.valid, true);
  assert.deepEqual(checked.conflicts, undefined);
});
test('snapshot deletion rows survive reused display keys in archived rows', () => {
  const keys = ['D00556', 'D00561'];
  const current = keys.map((rowKey, i) => ({ ...existing()[0], id: i + 2, rowKey }));
  const archived = keys.map((rowKey, i) => ({ ...existing()[0], id: i + 1, rowKey, deletedAt: '2026-11-01' }));
  const preview = prepareRows([fresh()], current, { snapshot: true, archivedRows: archived });
  assert.deepEqual(preview.rows.filter(row => row.action === 'delete').map(row => [row.rowKey, row.sourceRow]), [['D00556', null], ['D00561', null]]);
  const checked = recheckPreview(preview, current, archived);
  assert.equal(checked.valid, true);
  assert.deepEqual(checked.conflicts, undefined);
});
test('valid recheck preserves creation date and source data and exposes only planned writes', () => {
  const preview = prepareRows([fresh()], [], { listedAt: '2026-11-03' });
  const result = recheckPreview(preview, []);
  assert.equal(result.valid, true);
  assert.equal(result.operations[0].values.listedAt, '2026-11-03');
});
test('actual workbook roundtrip uses the same columns as frontend', () => {
  const file = excel.bytes(excel.exportWorkbook([{ ...fresh(), rowKey: 'D00001.01', cartonCount: 7 }], columns));
  const result = prepareWorkbook(file, existing());
  assert.equal(result.valid, true);
  assert(result.operations[0].changes.some(c => c.key === 'cartonCount' && c.after === 7));
});

test('purchase order milestone fields accept and preserve free text',()=>{
  const notes={orderedNote:'đã đặt qua WeChat',shippedNote:'xe rời kho 31-32/11',etaNote:'dự kiến tuần sau',arrivedNote:'chưa kiểm đếm'};
  const result=prepareRows([{...fresh(),...notes}],[]);
  assert.equal(result.valid,true,result.rows[0].errors.join('; '));
  for(const [key,value] of Object.entries(notes))assert.equal(result.operations[0].values[key],value);
});

test('full snapshot workbook carries revision, complete writable headers and per-column guidance', () => {
  const file=excel.exportImportSnapshot({rows:[{...fresh(),rowKey:'D00001.01'}],columns,revision:'12:34'});
  const workbook=excel.read(file),parsed=excel.parseImportSnapshot(file,columns);
  const guide=XLSX.utils.sheet_to_json(workbook.Sheets['Hướng dẫn'],{header:1,defval:''});
  const writable=excel.importColumns(columns);
  assert.ok(workbook.SheetNames.includes('Đặt hàng'));
  assert.equal(workbook.Workbook.Sheets.find(s=>s.name==='__TOKOSI').Hidden,1);
  assert.equal(parsed.revision,'12:34');
  assert.deepEqual(parsed.fields,writable.map(c=>c.k));
  assert.equal(parsed.rows[0].rowKey,'D00001.01');
  assert.equal(parsed.rows[0].productNameCn,null);
  assert.ok(writable.every(c=>guide.some(row=>row.includes(excel.caption(c)))), 'guide must explain every imported column');
  assert.ok(guide.flat().some(cell=>/ví dụ/i.test(String(cell))), 'example stays on guide sheet');
  assert.ok(!writable.some(c=>['literWarehouse','m3Warehouse','literChina','literDiff','gramWarehouse','gramChina','gramDiff','measuredOn'].includes(c.k)));
  assert.equal(parsed.rows[0].container,null);
});

test('snapshot container names assign matching active containers and blank values return rows to waiting',()=>{
  const containers=[{id:'9',name:'10-2H',region_id:'3'}],regions=[{id:'3',name:'H',isActive:true}],current=[{...existing()[0],regionId:'3',contId:null}];
  const assigned=prepareRows([{rowKey:'D00001.01',productCode:'A',regionId:'H',container:'CONT 10-2H'}],current,{snapshot:true,regions,containers});
  assert.equal(assigned.valid,true,assigned.rows[0].errors.join('; '));
  assert.equal(assigned.operations[0].changes.find(change=>change.key==='contId').after,'9');
  const waiting=prepareRows([{rowKey:'D00001.01',productCode:'A',regionId:'H',container:''}],[{...current[0],contId:'9'}],{snapshot:true,regions,containers});
  assert.equal(waiting.valid,true);assert.equal(waiting.operations[0].changes.find(change=>change.key==='contId').after,null);
  const alias=prepareRows([{...fresh(),container:'Chờ -H'}],[],{snapshot:true,containers});
  assert.equal(alias.valid,true);assert.equal(alias.operations[0].values.contId,null);
  const pricing=prepareRows([{...fresh(),container:'Tính giá'}],[],{snapshot:true,containers});
  assert.equal(pricing.valid,true);assert.equal(pricing.operations[0].values.contId,null);
});

test('snapshot plans unknown containers for creation and blocks region-mismatched names',()=>{
  const containers=[{id:'9',name:'10-2H',region_id:'3'}],regions=[{id:'3',name:'H',isActive:true},{id:'4',name:'V',isActive:true}];
  const unknown=prepareRows([{...fresh(),container:'10-99H'}],[],{snapshot:true,containers});
  assert.equal(unknown.valid,true);assert.equal(unknown.masterData.containers[0].name,'10-99H');
  const mismatch=prepareRows([{...fresh(),regionId:'V',container:'10-2H'}],[],{snapshot:true,regions,containers});
  assert.equal(mismatch.valid,false);assert.match(mismatch.rows[0].errors.join(' '),/vùng không khớp/);
});


test('snapshot import resolves configured regions and plans unknown region names',()=>{
  const current=[{...fresh(),id:'1',rowKey:'D00001',version:4,regionId:null}],regions=[{id:'9',name:'Miền Bắc',isActive:true}];
  const accepted=prepareRows([{rowKey:'D00001',productCode:'A',regionId:'Miền Bắc'}],current,{snapshot:true,regions});
  assert.equal(accepted.valid,true);assert.equal(accepted.rows[0].changes.find(change=>change.key==='regionId').after,'9');
  const planned=prepareRows([{rowKey:'D00001',productCode:'A',regionId:'Không có'}],current,{snapshot:true,regions});
  assert.equal(planned.valid,true);assert.equal(planned.masterData.regions[0].name,'Không có');
});
test('snapshot parser rejects ordinary or incomplete workbooks and accepts an intentionally empty snapshot', () => {
  const rows=[{...fresh(),rowKey:'D00001.01'}],ordinary=excel.bytes(excel.exportWorkbook(rows,columns));
  assert.throws(()=>excel.parseImportSnapshot(ordinary,columns),/Tải snapshot/);
  const file=excel.exportImportSnapshot({rows,columns,revision:'12:34'}),incomplete=excel.read(file);
  incomplete.Sheets['Đặt hàng'].B1.v='Unknown header';incomplete.Sheets['Đặt hàng'].B1.w='Unknown header';
  assert.throws(()=>excel.parseImportSnapshot(excel.bytes(incomplete),columns),/Cột không xác định|Mã SP/);
  const empty=excel.parseImportSnapshot(excel.exportImportSnapshot({rows:[],columns,revision:'12:34'}),columns);
  assert.equal(empty.rows.length,0);
});

test('full snapshot clears blank cells and plans omitted current rows for deletion', () => {
  const current=[existing()[0],{id:2,rowKey:'D00002',version:1,productCode:'B',productName:'Other',cartonCount:1,qtyPerCarton:1}],
    plan=prepareRows([{rowKey:'D00001.01',productCode:'A',productName:'Tape',cartonCount:10,qtyPerCarton:20,supplier:''}],current,{snapshot:true});
  assert.equal(plan.valid,true);
  assert.equal(plan.counts.update,1);
  assert.equal(plan.counts.delete,1);
  assert.equal(plan.operations.find(op=>op.action==='delete').id,2);
  assert.equal(plan.operations.find(op=>op.action==='update').changes.find(change=>change.key==='supplier').after,null);
  assert.equal(plan.sourceRows[0].supplier,'');
});

test('archived matches stay archived unless the preview explicitly opts in to recovery',()=>{
  const inactive={...existing()[0],id:3,rowKey:'D00003',productCode:'ARCHIVED',version:4,inactiveAt:'2026-11-10T00:00:00Z',deletedAt:null};
  const source={rowKey:'D00003',productCode:'ARCHIVED',productName:'Tape',cartonCount:7,qtyPerCarton:20};
  const skipped=prepareRows([source],[],{snapshot:true,archivedRows:[inactive]});
  assert.equal(skipped.valid,true);assert.equal(skipped.rows[0].action,'archived_skip');assert.equal(skipped.counts.archivedSkip,1);assert.equal(skipped.operations.length,0);
  const selected=prepareRows([{...source,recoverArchived:true}],[],{snapshot:true,archivedRows:[inactive]});
  assert.equal(selected.valid,true);assert.equal(selected.rows[0].action,'reactivate');assert.equal(selected.operations[0].expectedVersion,4);assert.equal(selected.counts.reactivate,1);
});

test('a new row with the same product code is separate from archived rows',()=>{
  const archived=[{...existing()[0],id:3,rowKey:'D00003',productCode:'ARCHIVED',inactiveAt:null,deletedAt:'2026-11-10T00:00:00Z'}, {...existing()[0],id:4,rowKey:'D00004',productCode:'ARCHIVED',inactiveAt:'2026-11-11T00:00:00Z',deletedAt:null}];
  const source={...fresh(),productCode:'ARCHIVED'};
  const added=prepareRows([source],[],{archivedRows:archived});
  assert.equal(added.valid,true);assert.equal(added.rows[0].action,'create');assert.equal(added.counts.create,1);assert.equal(added.rows[0].archivedCandidates,undefined);
  const selected=prepareRows([{...source,recoverArchived:true,recoverRowKey:'D00003'}],[],{archivedRows:archived});
  assert.equal(selected.valid,true);assert.equal(selected.rows[0].action,'restore');assert.equal(selected.rows[0].id,3);assert.equal(selected.rows[0].rowKey,'D00003');
  assert.equal(recheckPreview(selected,[],archived).operations[0].action,'restore');
});

test('stale snapshot is rejected before creating a plan', () => {
  const current=existing(),file=excel.exportImportSnapshot({rows:current,columns,revision:'12:34'});
  assert.throws(()=>prepareSnapshotWorkbook(file,current,{currentRevision:'12:35'}),error=>error.code==='IMPORT_SNAPSHOT_STALE');
  assert.equal(prepareSnapshotWorkbook(file,current,{currentRevision:'12:34'}).snapshotRevision,'12:34');
});

// Duong ghi cua web (sua o, sua hang loat, import) deu di qua prepareRows, nen
// VC truoc am phai duoc nhan o day — khong chi o DB.
test('prepaid freight may be negative on import and edits while other amounts may not', () => {
  const ok = prepareRows([{ ...fresh(), freightPrepaid: -23 }], []);
  assert.equal(ok.valid, true, ok.rows[0].errors.join('; '));
  assert.equal(ok.rows[0].values.freightPrepaid, -23);

  // Sua rieng mot o khac tren dong da co VC truoc am: khong duoc bi tu choi.
  const current = [{ ...existing()[0], freightPrepaid: -23, unitPriceCny: 15, fxRate: 3920 }];
  const edit = prepareRows([{ rowKey: 'D00001.01', productCode: 'A', supplier: 'NCC khac' }], current);
  assert.equal(edit.valid, true, edit.rows[0].errors.join('; '));

  for (const patch of [{ freightPostpaid: -1 }, { unitPriceCny: -1 }, { kgPerCarton: -1 }]) {
    assert.equal(prepareRows([{ ...fresh(), ...patch }], []).valid, false, JSON.stringify(patch));
  }
  assert.equal(prepareRows([{ ...fresh(), surchargePercent: -.1 }], []).valid, true, 'signed surcharge percent is accepted');
});
