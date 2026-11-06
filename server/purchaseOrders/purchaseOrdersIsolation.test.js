'use strict';
// Che do ghi CACH LY (purchase_settings.integration_enabled=false, migration 0117).
//
// Hop dong can bao ve: trang Thu mua ghi THAT (sua / xoa mem / khoi phuc / hoan
// tac / tach dong / trang thai cont) va van co lich su, audit, SSE rieng; nhung
// khong mot byte nao chay sang du lieu dung chung — khong projection, khong xoa
// cache cont, khong phat containersChanged. Day la dieu kien de thu nghiem tren
// production ma Du kien hang ve / Vong doi don hang khong doi hanh vi.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PGlite } = require('@electric-sql/pglite');
const { createPurchaseOrdersService } = require('./purchaseOrdersService');
const { FILES: PURCHASE_FILES } = require('../db/ensurePurchaseSchema');

const manager = { id: 'manager', hoTen: 'Người quản lý' };
const input = () => ({ productCode: 'A', productName: 'Hàng A', listedAt: '2026-11-03', qtyPerCarton: 20, cartonCount: 100, unitPriceCny: 2, fxRate: 3920, freightPrepaid: 0, freightPostpaid: 0 });
const BASE = ['0053_product_containers.sql', '0072_product_container_unit_price_cny.sql', '0075_product_container_expected.sql',
  '0078_product_container_expected_prices.sql', '0086_product_container_other_note.sql'];

let db, service, events, projected, invalidated, shared;
before(async () => {
  db = new PGlite();
  for (const name of [...BASE, ...PURCHASE_FILES]) await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8'));
  await db.exec('CREATE TABLE product_report(product_code text,product_name text)');
  events = new EventEmitter();
  const query = (sql, params) => db.query(sql, params);
  service = createPurchaseOrdersService({
    pool: { query, connect: async () => ({ query, release() {} }) },
    events,
    project: async () => { projected++; },
    invalidate: () => { invalidated++; }
  });
});
beforeEach(async () => {
  await db.exec(`TRUNCATE purchase_requests,purchase_undo_expected,purchase_operation_rows,purchase_operations,purchase_orders,product_containers,purchase_key_history,purchase_history,purchase_departures,purchase_import_previews,product_container_lines RESTART IDENTITY CASCADE;
    ALTER SEQUENCE purchase_order_key_seq RESTART WITH 1;
    UPDATE purchase_settings SET source_mode='web',integration_enabled=false;`);
  projected = 0; invalidated = 0; shared = [];
  events.removeAllListeners();
  events.on('containersChanged', () => shared.push('containersChanged'));
});
after(async () => db?.close());

const rows = async () => (await db.query('SELECT count(*)::int n FROM purchase_orders WHERE deleted_at IS NULL')).rows[0].n;
const history = async () => (await db.query('SELECT count(*)::int n FROM purchase_history')).rows[0].n;

test('an isolated create writes the row and its history but never reaches shared data', async () => {
  const own = [];
  events.on('purchase-orders-changed', () => own.push('changed'));
  const created = await service.create(manager, input());
  assert.ok(created.rowKey, 'dong duoc ghi that');
  assert.equal(await rows(), 1);
  assert.equal(await history(), 1, 'lich su van ghi');
  assert.equal(projected, 0, 'khong chay projection');
  assert.equal(invalidated, 0, 'khong xoa cache cont dung chung');
  assert.deepEqual(shared, [], 'khong phat containersChanged');
  assert.deepEqual(own, ['changed'], 'SSE rieng cua Thu mua van phat');
  assert.equal((await db.query('SELECT count(*)::int n FROM product_container_lines')).rows[0].n, 0, 'read model dung chung khong bi ghi');
});

test('the same create wires into shared data once integration is enabled', async () => {
  await db.query("UPDATE purchase_settings SET integration_enabled=true WHERE id=1");
  await service.create(manager, input());
  assert.equal(projected, 1);
  assert.equal(invalidated, 1);
  assert.deepEqual(shared, ['containersChanged']);
});

test('every isolated write path leaves shared data untouched', async () => {
  const created = await service.create(manager, input());
  const id = created.id;
  const updated = await service.update(manager, id, { version: created.version, changes: { supplier: 'NCC khac' } });
  assert.equal(updated.supplier, 'NCC khac', 'sua that');
  await service.remove(manager, { rows: [{ id, version: updated.version }] });
  assert.equal(await rows(), 0, 'xoa mem that');
  const trashed = (await db.query('SELECT * FROM purchase_orders WHERE id=$1', [id])).rows[0];
  await service.restore(manager, { id, version: Number(trashed.version) });
  assert.equal(await rows(), 1, 'khoi phuc that');
  assert.ok(await history() >= 4, 'moi thao tac deu co lich su');
  assert.equal(projected, 0);
  assert.equal(invalidated, 0);
  assert.deepEqual(shared, []);
});

test('isolation is read under the same lock as the source gate, so one write cannot be half-wired', async () => {
  // source_mode va integration_enabled doc cung mot cau SELECT ... FOR UPDATE.
  // Doi co giua hai luot ghi thi luot sau theo gia tri moi, khong co luot nao
  // vua cach ly vua day projection.
  await service.create(manager, input());
  assert.equal(projected, 0);
  await db.query("UPDATE purchase_settings SET integration_enabled=true WHERE id=1");
  await service.create(manager, { ...input(), productCode: 'B' });
  assert.equal(projected, 1, 'chi luot sau noi vao he thong');
  assert.equal(await rows(), 2);
});

test('writing is still refused while the source is the Sheet, isolated or not', async () => {
  for (const integration of [false, true]) {
    await db.query('UPDATE purchase_settings SET source_mode=$1,integration_enabled=$2 WHERE id=1', ['sheets', integration]);
    await assert.rejects(service.create(manager, input()), error => error.code === 'PURCHASE_SOURCE_NOT_ACTIVE');
  }
  assert.equal(await rows(), 0);
});

test('list reports both flags so the page can state the mode', async () => {
  const isolated = await service.list(manager);
  assert.equal(isolated.sourceMode, 'web');
  assert.equal(isolated.integrationEnabled, false);
  await db.query("UPDATE purchase_settings SET integration_enabled=true WHERE id=1");
  assert.equal((await service.list(manager)).integrationEnabled, true);
});

// Du kien hang ve: ten hang chi duoc lay tu purchase_orders khi Thu mua da noi
// vao he thong. O che do cach ly, ban Thu mua la du lieu dang thu nghiem.
test('the expected-arrivals refresh takes product names from Purchase only when wired in', async () => {
  const { refreshExpected } = require('../productContainers/expectedRefresh');
  const probe = [];
  const client = {
    query: async (sql, params) => {
      probe.push(sql);
      if (sql.includes('to_regclass')) return { rows: [{ name: 'purchase_settings' }] };
      if (sql.includes('SELECT source_mode')) return { rows: [settings] };
      if (sql.includes('advisory')) return { rows: [{ locked: true }] };
      return { rows: [{ n: 0 }], rowCount: 0 };
    },
    release() {}
  };
  let settings = { source_mode: 'web', integration_enabled: false };
  const pool = { connect: async () => client };
  const overwrites = () => probe.filter(sql => sql.includes('UPDATE expected_stage s SET product_name=o.product_name')).length;
  const reachedGate = () => probe.some(sql => sql.includes('SELECT source_mode'));

  await refreshExpected(pool, { log() {} });
  assert.ok(reachedGate(), 'phai chay toi cho kiem co, neu khong thi test vo nghia');
  assert.equal(overwrites(), 0, 'cach ly: khong lay ten tu purchase_orders');

  probe.length = 0;
  settings = { source_mode: 'web', integration_enabled: true };
  await refreshExpected(pool, { log() {} });
  assert.equal(overwrites(), 1, 'da noi vao he thong: lay ten tu purchase_orders');
});
