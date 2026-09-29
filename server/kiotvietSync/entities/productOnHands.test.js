'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const productOnHands = require('./productOnHands');
const productOnHandsSnapshot = require('./productOnHandsSnapshot');

// Client gia: cau SELECT tra ve inventories hien co theo id, cac cau khac chi duoc ghi lai.
function clientWithCurrent(currentById) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push([sql, params]);
      if (/^\s*SELECT id, raw->'inventories'/.test(sql)) {
        return { rows: params[1].filter((id) => id in currentById).map((id) => ({ id, inventories: currentById[id] })) };
      }
      return { rows: [] };
    }
  };
}

test('entity dung checkpoint rieng, khong dung "products"', () => {
  assert.equal(productOnHands.entity, 'product_on_hands');
  assert.equal(productOnHands.endpoint, 'productOnHands');
  assert.equal(productOnHands.incrementalParam, 'lastModifiedFrom');
});

test('snapshot: quet toan bo, checkpoint rieng, co gioi han tan suat', () => {
  assert.equal(productOnHandsSnapshot.entity, 'product_on_hands_snapshot');
  assert.equal(productOnHandsSnapshot.endpoint, 'productOnHands');
  assert.equal(productOnHandsSnapshot.pollFullSnapshot, true);
  assert.ok(productOnHandsSnapshot.minIntervalMs >= 60 * 1000);
  assert.equal(typeof productOnHandsSnapshot.upsertPage, 'function');
});

test('GOP theo branchId: giu cost/onOrder cu, chi de onHand/reserved moi; khong INSERT dong moi', async () => {
  const client = clientWithCurrent({
    1: [{ branchId: 7, onHand: 60, reserved: 0, cost: 60000, onOrder: 5 }]
  });
  const result = await productOnHands.upsertPage(client, 'hanoi', [
    { id: 1, code: '010GDYE', modifiedDate: '2026-09-23T08:38:28', inventories: [{ branchId: 7, onHand: 0, reserved: 3 }] }
  ]);

  assert.deepEqual(result, { received: 1, updated: 1 });
  const update = client.calls.find((call) => /UPDATE products/.test(call[0]));
  assert.ok(update);
  assert.doesNotMatch(client.calls.map((c) => c[0]).join('\n'), /INSERT INTO/);
  assert.deepEqual(update[1][1], [1]);
  assert.deepEqual(JSON.parse(update[1][2][0]), [{ branchId: 7, onHand: 0, reserved: 3, cost: 60000, onOrder: 5 }]);
});

test('khong UPDATE khi ton khong doi (tranh ghi WAL khi quet toan bo)', async () => {
  const client = clientWithCurrent({
    2: [{ branchId: 1, onHand: 15, reserved: 2, cost: 100 }]
  });
  const result = await productOnHands.upsertPage(client, 'hanoi', [
    { id: 2, inventories: [{ branchId: 1, onHand: 15, reserved: 2 }] }
  ]);
  assert.deepEqual(result, { received: 1, updated: 0 });
  assert.equal(client.calls.filter((call) => /UPDATE products/.test(call[0])).length, 0);
});

test('id chua co trong products -> bo qua, khong throw', async () => {
  const client = clientWithCurrent({});
  const result = await productOnHands.upsertPage(client, 'saigon', [{ Id: 9, Inventories: [{ BranchId: 1, OnHand: 4 }] }]);
  assert.deepEqual(result, { received: 1, updated: 0 });
});

test('item khong co Inventories -> ghi mang rong khi dong dang co ton, khong throw', async () => {
  const client = clientWithCurrent({ 9: [{ branchId: 1, onHand: 4 }] });
  const result = await productOnHands.upsertPage(client, 'saigon', [{ Id: 9 }]);
  assert.deepEqual(result, { received: 1, updated: 1 });
  const update = client.calls.find((call) => /UPDATE products/.test(call[0]));
  assert.deepEqual(update[1][2], ['[]']);
});

test('mergeInventories: kho moi chua co thi them nguyen ban, kho khong con trong response bi bo', () => {
  const merged = productOnHands.mergeInventories(
    [{ branchId: 1, onHand: 5, cost: 10 }, { branchId: 2, onHand: 8, cost: 20 }],
    [{ branchId: 2, onHand: 1, reserved: 0 }, { branchId: 3, onHand: 7, reserved: 1 }]
  );
  assert.deepEqual(merged, [
    { branchId: 2, onHand: 1, cost: 20, reserved: 0 },
    { branchId: 3, onHand: 7, reserved: 1 }
  ]);
});
