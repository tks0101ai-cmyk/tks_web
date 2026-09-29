'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSyncDriver } = require('./syncDriver');

function fakePool({ failUpsertAt = 0 } = {}) {
  const transactions = [];
  let upserts = 0;
  return {
    transactions,
    async connect() {
      const commands = [];
      transactions.push(commands);
      return {
        async query(sql) { commands.push(sql); },
        release() { commands.push('RELEASE'); }
      };
    },
    upsert: async () => {
      upserts++;
      if (upserts === failUpsertAt) throw new Error('page failed');
    }
  };
}

test('empty checkpoint on a snapshot entity (no backfillRangeParam) does a full sweep, no date filter', async () => {
  const pool = fakePool();
  const advances = [];
  const queries = [];
  const driver = createSyncDriver({ pool, now: () => Date.parse('2026-09-14T02:00:00Z'), checkpointRepository: {
    getCheckpoint: async () => null,
    advanceCheckpoint: async (...args) => advances.push(args)
  }});
  const api = { fetchAllPages: async (endpoint, query, onPage) => {
    queries.push([endpoint, query]);
    await onPage([{ id: 1 }]);
    await onPage([{ id: 2 }]);
  }};
  const entity = { entity: 'products', endpoint: 'products', listQuery: { includeInventory: 'true' }, incrementalParam: 'lastModifiedFrom', upsertPage: pool.upsert };
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.deepEqual(queries[0], ['products', { includeInventory: 'true' }]);
  assert.equal(advances.length, 1);
  assert.ok(pool.transactions.every((tx) => tx.join(',') === 'BEGIN,COMMIT,RELEASE'));
});

test('entity co minIntervalMs: bo qua khi lan thanh cong truoc con moi, chay lai khi da du cu, khong chay chong nhau', async () => {
  const pool = fakePool();
  let last = '2026-09-29T03:00:00.000Z';
  const advances = [];
  let nowMs = Date.parse('2026-09-29T03:05:00Z');
  const driver = createSyncDriver({ pool, now: () => nowMs, checkpointRepository: {
    getCheckpoint: async () => ({ last_synced_at: last }),
    advanceCheckpoint: async (...args) => { advances.push(args); }
  }});
  const queries = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const api = { fetchAllPages: async (endpoint, query, onPage) => { queries.push([endpoint, query]); await gate; await onPage([{ id: 1 }]); } };
  const entity = { entity: 'product_on_hands_snapshot', endpoint: 'productOnHands', listQuery: {}, incrementalParam: 'lastModifiedFrom',
    pollFullSnapshot: true, minIntervalMs: 10 * 60 * 1000, upsertPage: pool.upsert };

  await driver.pollEntityOnce(api, 'saigon', entity); // 5 phut < 10 phut -> bo qua
  assert.equal(queries.length, 0);

  nowMs = Date.parse('2026-09-29T03:11:00Z');
  const first = driver.pollEntityOnce(api, 'saigon', entity);
  await new Promise((resolve) => setImmediate(resolve));
  await driver.pollEntityOnce(api, 'saigon', entity); // dang chay -> bo qua
  release();
  await first;
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0], ['productOnHands', {}]); // khong loc lastModifiedFrom
  assert.equal(advances.length, 1);
});

test('empty checkpoint on a chunked entity (has backfillRangeParam) still falls back to one hour ago', async () => {
  const pool = fakePool();
  const queries = [];
  const driver = createSyncDriver({ pool, now: () => Date.parse('2026-09-14T02:00:00Z'), checkpointRepository: {
    getCheckpoint: async () => null,
    advanceCheckpoint: async () => {}
  }});
  const api = { fetchAllPages: async (endpoint, query, onPage) => { queries.push([endpoint, query]); await onPage([{ id: 1 }]); } };
  const entity = {
    entity: 'invoices', endpoint: 'invoices', listQuery: {}, incrementalParam: 'lastModifiedFrom',
    backfillRangeParam: { from: 'fromPurchaseDate', to: 'toPurchaseDate' }, upsertPage: pool.upsert
  };
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.deepEqual(queries[0], ['invoices', { lastModifiedFrom: '2026-09-14T01:00:00.000Z' }]);
});

test('a failed page rolls back only that page and does not advance its checkpoint', async () => {
  const pool = fakePool({ failUpsertAt: 2 });
  let advances = 0;
  const driver = createSyncDriver({ pool, checkpointRepository: {
    getCheckpoint: async () => ({ last_synced_at: '2026-09-14T00:00:00Z' }),
    advanceCheckpoint: async () => { advances++; }
  }});
  const api = { fetchAllPages: async (_e, _q, onPage) => { await onPage([1]); await onPage([2]); } };
  await assert.rejects(driver.pollEntityOnce(api, 'hanoi', { entity:'orders', endpoint:'orders', listQuery:{}, incrementalParam:'lastModifiedFrom', hasUpperBound:false, upsertPage:pool.upsert }), /page failed/);
  assert.equal(advances, 0);
  assert.deepEqual(pool.transactions.map((tx) => tx.slice(0, -1)), [['BEGIN','COMMIT'], ['BEGIN','ROLLBACK']]);
});

test('cash flows use two independently paginated receipt branches and persist the window end in note', async () => {
  const pool = fakePool();
  const apiCalls = [];
  const pages = [];
  const advances = [];
  const driver = createSyncDriver({ pool, now: () => Date.parse('2026-09-14T02:00:00Z'), checkpointRepository: {
    getCheckpoint: async () => ({ note: '2026-09-14T00:00:00.000Z' }),
    advanceCheckpoint: async (...args) => advances.push(args)
  }});
  const api = { fetchAllPages: async (endpoint, query, onPage) => { apiCalls.push([endpoint, query]); await onPage([{ id: query.isReceipt }]); } };
  await driver.pollEntityOnce(api, 'saigon', { entity:'cash_flows', endpoint:'cashflow', listQuery:{ includeUser:'true' }, upsertPage:async (_c,_b,items)=>pages.push(items) });
  assert.deepEqual(apiCalls.map((x)=>x[1]), [
    { includeUser:'true', startDate:'2026-09-14T00:00:00.000Z', endDate:'2026-09-14T02:00:00.000Z', isReceipt:'true' },
    { includeUser:'true', startDate:'2026-09-14T00:00:00.000Z', endDate:'2026-09-14T02:00:00.000Z', isReceipt:'false' }
  ]);
  assert.deepEqual(pages[0], [{ id:'true', IsReceipt:true }, { id:'false', IsReceipt:false }]);
  assert.equal(advances[0][3].note, '2026-09-14T02:00:00.000Z');
});

test('cash flow recovery ignores an error note and resumes from the last successful window', async () => {
  const pool=fakePool();
  const queries=[];
  const driver=createSyncDriver({pool,now:()=>Date.parse('2026-09-14T02:00:00Z'),checkpointRepository:{
    getCheckpoint:async()=>({note:'network down',last_synced_at:'2026-09-14T00:30:00Z'}),advanceCheckpoint:async()=>{}
  }});
  const api={fetchAllPages:async(_endpoint,query,onPage)=>{queries.push(query);await onPage([]);}};
  await driver.pollEntityOnce(api,'hanoi',{entity:'cash_flows',endpoint:'cashflow',listQuery:{},upsertPage:async()=>{}});
  assert.equal(queries[0].startDate,'2026-09-14T00:30:00.000Z');
});

test('purchases poll recovers recreated backdated receipts omitted by lastModifiedFrom', async () => {
  const pool = fakePool();
  const saved = [];
  const purchases = require('./entities/purchases');
  const driver = createSyncDriver({ pool, checkpointRepository: {
    getCheckpoint: async () => ({ last_synced_at: '2026-09-28T00:00:00Z' }),
    advanceCheckpoint: async () => {}
  }});
  const receipt = { id: 16136771, code: 'PN002517', purchaseDate: '2026-09-14T06:24:40', createdDate: '2026-09-17T10:30:50', status: 3 };
  const api = { fetchAllPages: async (_e, query, onPage) => {
    assert.equal(query.fromPurchaseDate, '2026-06-01');
    await onPage(query.lastModifiedFrom ? [] : [receipt]);
  }};
  await driver.pollEntityOnce(api, 'hanoi', { ...purchases,
    upsertPage: async (_c, _b, items) => saved.push(...items),
    reconcilePage: async (_c, _b, items) => saved.push(...items)
  });
  assert.deepEqual(saved, [receipt]);
});

test('failed initial snapshot keeps checkpoint empty; an empty successful sweep advances once', async () => {
  const pool = fakePool();
  let advances = 0;
  const driver = createSyncDriver({ pool, checkpointRepository: {
    getCheckpoint: async () => null, advanceCheckpoint: async () => { advances++; }
  }});
  const entity = { entity: 'products', endpoint: 'products', listQuery: {}, upsertPage: pool.upsert };
  await assert.rejects(driver.pollEntityOnce({ fetchAllPages: async (_e, _q, cb) => {
    await cb([1]); throw new Error('network failure');
  }}, 'hanoi', entity), /network failure/);
  assert.equal(advances, 0);
  await driver.pollEntityOnce({ fetchAllPages: async () => {} }, 'hanoi', entity);
  assert.equal(advances, 1);
});
