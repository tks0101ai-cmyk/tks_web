'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assertChildReplacement } = require('./entityTestUtils');
const entity = require('./orders');
test('orders replaces all detail rows and declares no upper bound', async () => {
  assert.equal(entity.hasUpperBound, false);
  assert.equal(entity.listQuery.pageSize, '20');
  await assertChildReplacement(entity, { Id: 11, Code: 'DH11', OrderDetails: [{ ProductId: 1 }] }, 'order_details', 1);
});

function recordingClient() {
  const calls = [];
  return { calls, query: async (sql, params) => { calls.push([sql, params]); return { rows: [] }; } };
}

test('orders: moi don ghi cac dong trong 1 INSERT, line_no dung thu tu', async () => {
  const client = recordingClient();
  await entity.upsertPage(client, 'hanoi', [{ Id: 11, Code: 'DH11', OrderDetails: [{ ProductId: 1, Quantity: 5 }, { ProductId: 2, Quantity: 6 }, { ProductId: 3, Quantity: 7 }] }], { prepared: true });
  const inserts = client.calls.filter(([sql]) => /INSERT INTO order_details/.test(sql));
  assert.equal(inserts.length, 1);
  const [, params] = inserts[0];
  const width = params.length / 3;
  assert.deepEqual([params[2], params[2 + width], params[2 + 2 * width]], [0, 1, 2]);
  assert.deepEqual([params[3], params[3 + width], params[3 + 2 * width]], [1, 2, 3]);
});

test('orders: upsertPage da sap san thi khong sap lai; prepareItems dung rieng duoc', async () => {
  const { createDocumentEntity } = require('./documentEntityFactory');
  const seen = [];
  const custom = createDocumentEntity({
    entity: 'orders', listQuery: {}, parentColumns: ['branch', 'id'], parentUpdateColumns: ['id'], mapParent: x => [x.id],
    detailTable: 'order_details', parentIdColumn: 'order_id', detailKeys: ['lines'], detailColumns: ['branch', 'order_id', 'line_no'], mapDetail: () => [],
    prepareItems: async (branch, items) => { seen.push(branch); return items; }
  });
  await custom.upsertPage(recordingClient(), 'hanoi', [{ id: 1, lines: [] }], { prepared: true });
  assert.deepEqual(seen, []);
  await custom.upsertPage(recordingClient(), 'hanoi', [{ id: 1, lines: [] }]);
  assert.deepEqual(seen, ['hanoi']);
  await custom.prepareItems('saigon', []);
  assert.deepEqual(seen, ['hanoi', 'saigon']);
});
