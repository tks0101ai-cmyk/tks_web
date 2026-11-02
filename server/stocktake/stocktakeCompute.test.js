'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { codeKey, applyLineEdits, buildBoard, toResults } = require('./stocktakeCompute');

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

test('chenh theo Cum SP, KK truoc, vi tri, ghi chu', () => {
  const board = buildBoard({
    lines: [line(1, 1, 'A', 12), line(1, 2, 'B', 3)],
    products: [{ code: 'A', stock: 10, cost: 1 }, { code: 'B', stock: 5, cost: 1 }, { code: 'C', stock: 1, cost: 1 }],
    tags: [{ code: 'A', cluster: 'Cum 1', isCombo: true, version: 1 }, { code: 'B', cluster: 'cum 1', version: 3 }],
    previous: [{ code: 'a', diffQty: -2 }],
    positions: [{ code: 'A', location: 'G1-15', arrivalDate: 'KK 4.10' }, { code: 'A', location: 'cu' }],
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
  assert.deepEqual(rows.A.latestPosition, { location: 'G1-15', arrivalDate: 'KK 4.10' });
  assert.equal(rows.D.note.statusText, 'ok', 'ma co ghi chu van hien du khong dem / khong ton');
});

test('toResults: ban chup gon theo ma', () => {
  const board = buildBoard({ lines: [line(1, 1, 'A', 2)], products: [{ code: 'A', name: 'Hang A', stock: 1, cost: 300 }] });
  assert.deepEqual(toResults(board), [{ code: 'A', name: 'Hang A', counted: 2, stock: 1, cost: 300, diffQty: 1, diffValue: 300 }]);
});

test('applyLineEdits: khong co phan sua thi giu nguyen', () => {
  const [only] = applyLineEdits([line(1, 1, 'a', 2)], []);
  assert.equal(only.productCode, 'A');
  assert.equal(only.edit, null);
  assert.equal(only.removed, false);
});
