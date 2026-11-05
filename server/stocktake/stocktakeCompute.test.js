'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { codeKey, applyLineEdits, buildBoard, toResults, deriveColumns } = require('./stocktakeCompute');

const line = (orderId, lineNo, productCode, quantity, extra = {}) => ({
  orderId, lineNo, orderCode: 'DH' + orderId, team: 'TEAM 1', zone: 'G1', spec: '1t*10', productCode, productName: 'SP ' + productCode, quantity, ...extra
});
const byCode = board => Object.fromEntries(board.rows.map(row => [row.code, row]));

test('codeKey: bo khoang trang, viet hoa', () => {
  assert.equal(codeKey(' vh spl7 '), 'VHSPL7');
  assert.equal(codeKey(null), '');
});

test('cong so dem moi dong, gom ca don da huy', () => {
  const board = buildBoard({
    lines: [line(1, 1, 'A', 10), line(2, 1, 'a', 5, { orderStatus: 'Đã hủy' }), line(2, 2, 'B', 1.1), line(3, 1, 'B', 2.2)],
    products: [{ code: 'A', name: 'Hang A', stock: 12, cost: 1000 }, { code: 'B', stock: 3.3, cost: 10 }]
  });
  const rows = byCode(board);
  assert.equal(rows.A.counted, 15);
  assert.equal(rows.A.diffQty, 3);
  assert.equal(rows.A.diffValue, 3000);
  assert.equal(rows.A.name, 'Hang A');
  assert.equal(rows.B.counted, 3.3);
  assert.equal(rows.B.diffQty, 0);
  assert.equal(board.totals.mismatched, 1);
});

test('phan sua de SL/ma, dong bi bo khong tinh, dong tay duoc cong', () => {
  const board = buildBoard({
    lines: [line(1, 1, 'A', 10), line(1, 2, 'A', 4), line(1, 3, 'X', 7)],
    edits: [
      { id: 1, orderId: 1, lineNo: 1, quantity: 8, version: 2, updatedByName: 'Hưng' },
      { id: 2, orderId: 1, lineNo: 2, removed: true, version: 1 },
      { id: 3, orderId: 1, lineNo: 3, productCode: 'b', version: 1 },
      { id: 4, orderId: null, lineNo: null, productCode: 'A', quantity: 5, zone: 'G9', version: 1 }
    ],
    products: [{ code: 'A', stock: 13, cost: 1 }, { code: 'B', stock: 7, cost: 1 }]
  });
  const rows = byCode(board);
  assert.equal(rows.A.counted, 13);
  assert.equal(rows.A.lines.length, 3);
  assert.equal(rows.A.lines.find(l => l.lineNo === 1).original.quantity, 10);
  assert.equal(rows.A.lines.find(l => l.lineNo === 1).edit.updatedByName, 'Hưng');
  assert.ok(rows.A.lines.find(l => l.manual));
  assert.equal(rows.B.counted, 7);
  assert.equal(rows.X, undefined);
});

test('Quen KK: co ton, khong ai dem (ke ca khi dong duy nhat bi bo)', () => {
  const board = buildBoard({
    lines: [line(1, 1, 'B', 2)],
    edits: [{ id: 1, orderId: 1, lineNo: 1, removed: true, version: 1 }],
    products: [{ code: 'A', stock: 4, cost: 5 }, { code: 'B', stock: 2, cost: 1 }, { code: 'Z', stock: 0, cost: 1 }]
  });
  const rows = byCode(board);
  assert.equal(rows.A.forgotten, true);
  assert.equal(rows.A.diffQty, -4);
  assert.equal(rows.B.forgotten, true);
  assert.equal(rows.Z, undefined, 'ton 0 va khong dem thi khong vao bang');
  assert.equal(board.totals.forgotten, 2);
});

test('ma co so dem nhung khong co trong KiotViet: ton 0, inKiot false', () => {
  const rows = byCode(buildBoard({ lines: [line(1, 1, 'NEW', 3)] }));
  assert.equal(rows.NEW.inKiot, false);
  assert.equal(rows.NEW.diffQty, 3);
});

test('chenh theo Cum SP, KK truoc, ghi chu; khong con vi tri kho', () => {
  const board = buildBoard({
    lines: [line(1, 1, 'A', 12), line(1, 2, 'B', 3)],
    products: [{ code: 'A', stock: 10, cost: 1 }, { code: 'B', stock: 5, cost: 1 }, { code: 'C', stock: 1, cost: 1 }],
    tags: [{ code: 'A', cluster: 'Cum 1', isCombo: true, version: 1 }, { code: 'B', cluster: 'cum 1', version: 3 }],
    previous: [{ code: 'a', diffQty: -2 }],
    notes: [{ code: 'D', statusText: 'ok', version: 1 }]
  });
  const rows = byCode(board);
  assert.equal(rows.A.clusterDiff, 0);
  assert.equal(rows.B.clusterDiff, 0);
  assert.equal(rows.C.clusterDiff, null);
  assert.equal(rows.A.isCombo, true);
  assert.equal(rows.B.tagVersion, 3);
  assert.equal(rows.A.prevDiff, -2);
  assert.equal(rows.B.prevDiff, null);
  assert.equal('latestPosition' in rows.A, false);
  assert.equal(rows.D.note.statusText, 'ok', 'ma co ghi chu van hien du khong dem / khong ton');
});

test('toResults: ban chup gon theo ma', () => {
  const board = buildBoard({ lines: [line(1, 1, 'A', 2)], products: [{ code: 'A', name: 'Hang A', stock: 1, cost: 300 }] });
  assert.deepEqual(toResults(board), [{ code: 'A', name: 'Hang A', counted: 2, stock: 1, cost: 300, diffQty: 1, diffValue: 300, prevDiff: null, otherDiff: null }]);
});

test('applyLineEdits: khong co phan sua thi giu nguyen', () => {
  const [only] = applyLineEdits([line(1, 1, 'a', 2)], []);
  assert.equal(only.productCode, 'A');
  assert.equal(only.edit, null);
  assert.equal(only.removed, false);
});

test('deriveColumns: Count, chenh cum, 3 ty le; mau so 0 / trong -> null', () => {
  const rows = deriveColumns([
    { code: 'A', diffQty: -434, cluster: 'Tủ LUMI3', prevDiff: -326, otherDiff: null },
    { code: 'B', diffQty: 45, cluster: 'tủ lumi3 ', prevDiff: null, otherDiff: 0 },
    { code: 'C', diffQty: -5, cluster: '', prevDiff: 0, otherDiff: -10 }
  ]);
  const [a, b, c] = rows;
  assert.equal(a.clusterCount, 2);
  assert.equal(a.clusterDiff, -389);
  assert.equal(a.prevRatio, 2.3313, '(E+L)/L = (-434-326)/-326');
  assert.equal(a.clusterPrevRatio, 1.838, '(-389 + -326) / -389, L trong tinh 0');
  assert.equal(b.clusterPrevRatio, 1.838);
  assert.equal(b.prevRatio, null, 'L trong');
  assert.equal(b.otherRatio, null, 'M = 0');
  assert.equal(c.clusterCount, null);
  assert.equal(c.clusterDiff, null);
  assert.equal(c.clusterPrevRatio, null);
  assert.equal(c.prevRatio, null, 'L = 0');
  assert.equal(c.otherRatio, 1.5, '(-5 + -10) / -10');
});

test('buildBoard: so dan tay uu tien hon so tu lay cho L va M', () => {
  const { rows } = buildBoard({
    products: [{ code: 'A', name: 'A', stock: 10, cost: 1 }, { code: 'B', name: 'B', stock: 3, cost: 1 }],
    previous: [{ code: 'A', diffQty: -2 }, { code: 'B', diffQty: -1 }],
    counterpart: [{ code: 'A', diffQty: 4 }],
    notes: [{ code: 'B', prevDiffManual: -7, otherDiffManual: 5, statusText: '', reasonText: '', version: 1 }]
  });
  const byCode = Object.fromEntries(rows.map(r => [r.code, r]));
  assert.deepEqual([byCode.A.prevDiff, byCode.A.prevDiffManual, byCode.A.otherDiff], [-2, false, 4]);
  assert.deepEqual([byCode.B.prevDiff, byCode.B.prevDiffAuto, byCode.B.prevDiffManual], [-7, -1, true]);
  assert.deepEqual([byCode.B.otherDiff, byCode.B.otherDiffAuto, byCode.B.otherDiffManual], [5, null, true]);
  const results = toResults({ rows });
  assert.deepEqual(results.find(r => r.code === 'B').prevDiff, -7);
  assert.deepEqual(results.find(r => r.code === 'B').otherDiff, 5);
});

test('hang dang hoat dong 0/0 co trong bang, khong la Quen KK; hang ngung 0/0 khong co', () => {
  const board = buildBoard({
    lines: [{ orderId: 1, lineNo: 0, productCode: 'DEM', quantity: 5 }],
    products: [
      { code: 'RONG', stock: 0, cost: 1, active: true }, { code: 'NGUNG', stock: 0, cost: 1, active: false },
      { code: 'NGUNGTON', stock: 3, cost: 1, active: false }, { code: 'DEM', stock: 0, cost: 2, active: false }
    ]
  });
  assert.deepEqual(board.rows.map(row => row.code).sort(), ['DEM', 'NGUNGTON', 'RONG']);
  const row = code => board.rows.find(item => item.code === code);
  assert.equal(row('RONG').forgotten, false);
  assert.equal(row('RONG').diffQty, 0);
  assert.equal(row('DEM').diffQty, 5);
  assert.equal(board.totals.mismatched, 2);
});
