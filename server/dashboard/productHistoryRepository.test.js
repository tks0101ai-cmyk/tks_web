'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { getProductHistory, getProductHistoryForExport } = require('./productHistoryRepository');

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
      CREATE TABLE orders (branch text, id bigint, code text, order_date timestamptz, customer_id bigint, status int, raw jsonb);
      CREATE TABLE order_details (branch text, order_id bigint, product_id bigint, quantity numeric, raw jsonb);
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
    assert.deepEqual(all.summary, { purchaseQuantity: 9.5, returnQuantity: 1.5, purchaseCount: 3, returnCount: 1, orderQuantity: 0, orderCount: 0 });
    const next = await read({ pageSize: '1', page: '2' });
    assert.deepEqual(next.summary, all.summary);
    const found = await read({ q: 'dang my tho' });
    assert.equal(found.totalRows, 2);
    assert.deepEqual(found.summary, { purchaseQuantity: 3.5, returnQuantity: 1.5, purchaseCount: 1, returnCount: 1, orderQuantity: 0, orderCount: 0 });
    const only = await read({ q: 'dang my', type: 'return' });
    assert.deepEqual(only.summary, { purchaseQuantity: 0, returnQuantity: 1.5, purchaseCount: 0, returnCount: 1, orderQuantity: 0, orderCount: 0 });
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
    await db.exec(`INSERT INTO orders VALUES
      ('hanoi',1,'DH1','2026-11-03 11:00Z',1,3,'{"statusValue":"Phiếu tạm"}'),
      ('saigon',1,'DH1','2026-08-06 00:00Z',1,1,'{"statusValue":"Phiếu tạm"}'),
      ('hanoi',2,'DH2','2026-11-03 11:00Z',1,1,'{"statusValue":"Đã hủy"}'),
      ('hanoi',3,'DH3','2026-08-05 23:59:59Z',1,1,'{}'),
      ('hanoi',4,'DH4','2026-11-04 00:00Z',1,1,'{}'),
      ('hanoi',5,'DH5','2026-11-03 11:00Z',1,1,'{}');
      INSERT INTO order_details VALUES ('hanoi',1,1,-2,'{}'),('hanoi',1,1,3,'{}'),('saigon',1,1,7,'{}'),
      ('hanoi',2,1,99,'{}'),('hanoi',3,1,99,'{}'),('hanoi',4,1,99,'{}'),('hanoi',5,1,99,'{}');`);
    const orders = await read({type:'order',sort:'quantity',dir:'asc',pageSize:1});
    assert.equal(orders.totalRows,2);
    assert.equal(orders.rows[0].quantity,5);
    assert.equal(orders.rows[0].customerName,'Đặng Mỹ Thọ');
    assert.deepEqual(orders.summary,{purchaseQuantity:0,returnQuantity:0,purchaseCount:0,returnCount:0,orderQuantity:12,orderCount:2});
    const exported = await getProductHistoryForExport({code:'SP1',pool:db,now:new Date('2026-11-02T18:00:00Z'),sort:'quantity',dir:'desc'});
    assert.deepEqual(exported.rows.map(r=>r.quantity),[7,5,4,3.5,2,1.5]);
    assert.deepEqual((await read({sort:'type',dir:'asc'})).rows.map(r=>r.type),['invoice','invoice','invoice','return','order','order']);
    assert.deepEqual((await read({sort:'documentCode',dir:'asc',type:'order'})).rows.map(r=>r.branch),['hanoi','saigon']);
    for (const sort of ['time','type','documentCode','customerName','quantity']) {
      const full = await read({sort,dir:'asc'});
      const first = await read({sort,dir:'asc',pageSize:1});
      const last = await read({sort,dir:'desc',pageSize:1});
      assert.deepEqual(first.rows[0],full.rows[0]);
      if(sort !== 'customerName') assert.equal(last.rows[0][sort],full.rows.at(-1)[sort]);
    }
    await db.exec(`INSERT INTO orders SELECT 'hanoi', n, 'DH'||n, '2026-11-03 11:00Z'::timestamptz,1,1,'{"statusValue":"Phiếu tạm"}'::jsonb FROM generate_series(10,119) n;
      INSERT INTO order_details SELECT 'hanoi',n,1,1,'{}'::jsonb FROM generate_series(10,119) n;`);
    let exportQueries = 0;
    const bulk = await getProductHistoryForExport({code:'SP1',type:'order',pool:{query(...args){exportQueries++;return db.query(...args);}},now:new Date('2026-11-02T18:00:00Z')});
    assert.equal(bulk.rows.length,112);
    assert.equal(bulk.totalRows,112);
    assert.equal(exportQueries,1,'export uses one snapshot query rather than reading pages');
  } finally { await db.close(); }
});

test('reject invalid history query before accessing DB', async () => {
  for (const params of [{}, {code: 'A', type: 'bad'}, {code:'A',sort:['time']}, {code:'A',sort:'quantity DESC;'}, {code:'A',dir:'bad'}, {code:'A',page:'0'}, {code:'A',page:'1.2'}, {code:'A',pageSize:'101'}, {code:['A']}, {code:'A',q:['x']}]) {
    await assert.rejects(() => getProductHistory({...params,pool:{query(){assert.fail('invalid query must not access DB');}}}), {statusCode:400});
  }
});
