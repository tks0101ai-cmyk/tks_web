'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { getProductHistory } = require('./productHistoryRepository');

test('90-day history: statuses, wall-clock VN dates, branches, grouping, fuzzy filters and totals before paging', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE products (branch text, id bigint, code text);
      CREATE TABLE customers (branch text, id bigint, name text);
      CREATE TABLE invoices (branch text, id bigint, code text, purchase_date timestamptz, customer_id bigint, status int, raw jsonb);
      CREATE TABLE invoice_details (branch text, invoice_id bigint, product_id bigint, quantity numeric, raw jsonb);
      CREATE TABLE returns (branch text, id bigint, code text, return_date timestamptz, customer_id bigint, raw jsonb);
      CREATE TABLE return_details (branch text, return_id bigint, product_id bigint, quantity numeric, raw jsonb);
      INSERT INTO products VALUES ('hanoi',1,'SP1'),('saigon',1,'SP1'),('hanoi',2,'OTHER');
      INSERT INTO customers VALUES ('hanoi',1,'Đặng Mỹ Thọ'),('saigon',1,'Khách SG');
      INSERT INTO invoices VALUES
        ('hanoi',1,'HD1','2026-11-03 23:59:59Z',1,1,'{"customerName":"Tên cũ"}'),
        ('saigon',1,'HD1','2026-08-06 00:00:00Z',1,1,'{}'),
        ('hanoi',2,'HD2','2026-08-05 23:59:59Z',1,1,'{}'),
        ('hanoi',3,'HD3','2026-11-04 00:00:00Z',1,1,'{}'),
        ('hanoi',4,'HD4','2026-11-02 12:00:00Z',1,1,'{"statusValue":"Đã hủy"}'),
        ('hanoi',5,'HD5','2026-11-02 12:00:00Z',null,1,'{}'),
        ('hanoi',6,'HD6','2026-11-02 12:00:00Z',1,3,'{}');
      INSERT INTO invoice_details VALUES
        ('hanoi',1,1,1.5,'{}'),('hanoi',1,1,2,'{}'),('saigon',1,1,4,'{}'),
        ('hanoi',2,1,100,'{}'),('hanoi',3,1,100,'{}'),('hanoi',4,1,100,'{}'),
        ('hanoi',5,1,2,'{"price":999}'),('hanoi',6,1,100,'{}'),('hanoi',1,2,100,'{}');
      INSERT INTO returns VALUES
        ('hanoi',1,'TH1','2026-11-03 08:00:00Z',1,'{"statusValue":"Đã trả"}'),
        ('hanoi',2,'TH2','2026-11-03 08:00:00Z',1,'{"statusValue":"Đã hủy"}');
      INSERT INTO return_details VALUES ('hanoi',1,1,0.5,'{}'),('hanoi',1,1,1,'{}'),('hanoi',2,1,100,'{}');
    `);
    const read = params => getProductHistory({ code: ' sp1 ', pool: db, now: new Date('2026-11-02T18:00:00Z'), ...params });
    const all = await read({ pageSize: '1' });
    assert.equal(all.from, '2026-08-06');
    assert.equal(all.to, '2026-11-03');
    assert.equal(all.totalRows, 4);
    assert.equal(all.rows.length, 1);
    assert.equal(all.rows[0].quantity, 3.5);
    assert.equal(all.rows[0].customerName, 'Đặng Mỹ Thọ');
    assert.equal(all.rows[0].time, '2026-11-03T23:59:59');
    assert.equal(all.rows[0].unitCost, null);
    assert.deepEqual(all.summary, { purchaseQuantity: 9.5, returnQuantity: 1.5, purchaseCount: 3, returnCount: 1 });
    const next = await read({ pageSize: '1', page: '2' });
    assert.deepEqual(next.summary, all.summary);
    const found = await read({ q: 'dang my tho' });
    assert.equal(found.totalRows, 2);
    assert.deepEqual(found.summary, { purchaseQuantity: 3.5, returnQuantity: 1.5, purchaseCount: 1, returnCount: 1 });
    const only = await read({ q: 'dang my', type: 'return' });
    assert.deepEqual(only.summary, { purchaseQuantity: 0, returnQuantity: 1.5, purchaseCount: 0, returnCount: 1 });
    assert.equal(only.rows[0].type, 'return');
    const none = await read({ q: 'khongtontai', page: '9' });
    assert.equal(none.totalRows, 0);
    assert.equal(none.page, 1);
    assert.deepEqual(none.rows, []);
    assert.equal((await read({ q: 'khach le' })).rows[0].unitCost, null);
    assert.equal((await read({ code: "SP1' OR 1=1 --" })).totalRows, 0);
    const last = await read({ page:'99',pageSize:'1' });
    assert.equal(last.page, 4);
    assert.deepEqual(last.summary, all.summary);
    await db.exec("UPDATE returns SET return_date='2026-11-03 23:59:59.999Z' WHERE id=1");
    assert.equal((await read({pageSize:'1'})).rows[0].type, 'return', 'sort preserves sub-second timestamp order');
  } finally { await db.close(); }
});

test('reject invalid history query before accessing DB', async () => {
  for (const params of [{}, {code: 'A', type: 'bad'}, {code:'A',page:'0'}, {code:'A',page:'1.2'}, {code:'A',pageSize:'101'}, {code:['A']}, {code:'A',q:['x']}]) {
    await assert.rejects(() => getProductHistory(params), {statusCode:400});
  }
});
