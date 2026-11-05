'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const productCosts = require('./productCosts');

const INV = cost => [{ branchId: 7, cost, onHand: 60, reserved: 2, onOrder: 5 }];
const OLD_SYNC = new Date('2026-01-01T00:00:00Z').toISOString();

async function fixture() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, '../../db/migrations/0001_core_master_data.sql'), 'utf8'));
  await db.query(`INSERT INTO products (branch, id, code, name, raw, synced_at) VALUES
    ('hanoi', 1, 'A', 'A', $1, $3), ('hanoi', 2, 'B', 'B', $2, $3), ('saigon', 1, 'A', 'A', $1, $3)`,
  [JSON.stringify({ description: 'mo ta', inventories: INV(1000) }), JSON.stringify({ inventories: INV(511) }), OLD_SYNC]);
  return db;
}
const read = async (db, branch, id) => (await db.query('SELECT raw, synced_at FROM products WHERE branch = $1 AND id = $2', [branch, id])).rows[0];

test('khai bao entity: quet toan bo /products, checkpoint rieng', () => {
  assert.equal(productCosts.entity, 'product_costs');
  assert.equal(productCosts.endpoint, 'products');
  assert.equal(productCosts.pollFullSnapshot, true);
  assert.equal(productCosts.listQuery.includeInventory, 'true');
});

test('nam trong nhom dong bo cham de khong giu cho luot don hang', () => {
  const source = fs.readFileSync(path.join(__dirname, '../scheduler.js'), 'utf8');
  const slowGroup = /const slowEntities = \[([\s\S]*?)\];/.exec(source)[1];
  assert.match(slowGroup, /entities\/productCosts/);
});

test('chi doi cost dung co so, giu ton va cac truong khac', async () => {
  const db = await fixture();
  const result = await productCosts.upsertPage(db, 'hanoi', [{ id: 1, inventories: [{ branchId: 7, cost: 3300, onHand: 999, reserved: 99 }] }]);
  assert.deepEqual(result, { received: 1, updated: 1 });
  const row = await read(db, 'hanoi', 1);
  assert.deepEqual(row.raw, { description: 'mo ta', inventories: INV(3300) });
  assert.notEqual(row.synced_at.toISOString(), OLD_SYNC);
  assert.equal((await read(db, 'saigon', 1)).raw.inventories[0].cost, 1000);
});

test('khong ghi khi cost khong doi, bo qua hang la, cost rong, kho la', async () => {
  const db = await fixture();
  const result = await productCosts.upsertPage(db, 'hanoi', [
    { id: 2, inventories: [{ branchId: 7, cost: 511.0 }] },
    { id: 999, inventories: [{ branchId: 7, cost: 5 }] },
    { id: 1, inventories: [{ branchId: 7 }, { branchId: 8, cost: 77 }] }
  ]);
  assert.deepEqual(result, { received: 3, updated: 0 });
  assert.equal((await read(db, 'hanoi', 2)).synced_at.toISOString(), OLD_SYNC);
  assert.deepEqual((await read(db, 'hanoi', 1)).raw.inventories, INV(1000));
});

test('giu so le; dong chua co inventories khong gay loi; trang rong khong goi DB', async () => {
  const db = await fixture();
  await db.exec(`INSERT INTO products (branch, id, code, name, raw) VALUES ('hanoi', 3, 'C', 'C', '{}')`);
  const result = await productCosts.upsertPage(db, 'hanoi', [{ id: 2, inventories: [{ branchId: 7, cost: 511.41 }] }, { id: 3, inventories: [{ branchId: 7, cost: 1 }] }]);
  assert.deepEqual(result, { received: 2, updated: 1 });
  assert.equal((await read(db, 'hanoi', 2)).raw.inventories[0].cost, 511.41);
  assert.deepEqual((await read(db, 'hanoi', 3)).raw, {});
  assert.deepEqual(await productCosts.upsertPage({ query() { throw new Error('khong duoc goi'); } }, 'hanoi', []), { received: 0, updated: 0 });
});
