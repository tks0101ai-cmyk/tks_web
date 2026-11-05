const { test } = require('node:test');
const assert = require('node:assert/strict');
const { prepareRows, prepareWorkbook, recheckPreview } = require('./purchaseOrdersImport');
const excel = require('../public/shared/purchase-workbook');
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
