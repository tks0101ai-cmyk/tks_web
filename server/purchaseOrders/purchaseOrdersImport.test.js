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
  const result = prepareRows([{ rowKey: 'D00001.01', productCode: 'RENAMED', supplier: '', cartonCount: 11, container: 'Other', totalQty: 999, literWarehouse: 99 }], existing());
  assert.equal(result.valid, true);
  assert.deepEqual(result.operations[0].changes.map(c => c.key), ['productCode', 'cartonCount']);
  assert.equal(result.operations[0].expectedVersion, 2);
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

test('purchase note dates preserve temporary ranges but reject invalid month days',()=>{
  const ok=prepareRows([{...fresh(),etaNote:'11-12/11'}],[]);
  assert.equal(ok.valid,true,ok.rows[0].errors.join('; '));
  assert.equal(ok.operations[0].values.etaNote,'11-12/11');
  const invalid=prepareRows([{...fresh(),etaNote:'31-32/11'}],[]);
  assert.equal(invalid.valid,false);
  assert.match(invalid.rows[0].errors.join('; '),/ngày không hợp lệ/);
});

test('full snapshot workbook carries revision, complete writable headers and per-column guidance', () => {
  const file=excel.exportImportSnapshot({rows:[{...fresh(),rowKey:'D00001.01'}],columns,revision:'12:34'});
  const workbook=excel.read(file),parsed=excel.parseImportSnapshot(file,columns);
  const guide=XLSX.utils.sheet_to_json(workbook.Sheets['Hướng dẫn'],{header:1,defval:''});
  const writable=columns.filter(c=>c.k==='rowKey'||!c.d&&!c.m&&!c.ro&& !['container','status'].includes(c.k));
  assert.ok(workbook.SheetNames.includes('Đặt hàng'));
  assert.equal(workbook.Workbook.Sheets.find(s=>s.name==='__TOKOSI').Hidden,1);
  assert.equal(parsed.revision,'12:34');
  assert.deepEqual(parsed.fields,writable.map(c=>c.k));
  assert.equal(parsed.rows[0].rowKey,'D00001.01');
  assert.equal(parsed.rows[0].productNameCn,null);
  assert.ok(writable.every(c=>guide.some(row=>row.includes(excel.caption(c)))), 'guide must explain every imported column');
  assert.ok(guide.flat().some(cell=>/ví dụ/i.test(String(cell))), 'example stays on guide sheet');
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

  for (const patch of [{ freightPostpaid: -1 }, { unitPriceCny: -1 }, { taxAmount: -1 }, { kgPerCarton: -1 }]) {
    assert.equal(prepareRows([{ ...fresh(), ...patch }], []).valid, false, JSON.stringify(patch));
  }
});
