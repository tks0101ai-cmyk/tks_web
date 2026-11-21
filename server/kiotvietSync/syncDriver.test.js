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

test('orders recover delayed source records older than the previous checkpoint without duplicating them', async () => {
  const row = { id: 123, code: 'DH_DELAYED_FIXTURE', modifiedDate: '2026-11-21T01:18:58.000Z' };
  const saved = new Map();
  let checkpoint = '2026-11-21T01:18:00.000Z';
  let sourceVisible = false;
  let nowMs = Date.parse('2026-11-21T01:19:00.000Z');
  const driver = createSyncDriver({ pool: fakePool(), now: () => nowMs, checkpointRepository: {
    getCheckpoint: async () => ({ last_synced_at: checkpoint }),
    advanceCheckpoint: async (_branch, _entity, at) => { checkpoint = at; }
  }});
  const api = { fetchAllPages: async (_endpoint, query, onPage) => {
    await onPage(sourceVisible && Date.parse(row.modifiedDate) >= Date.parse(query.lastModifiedFrom) ? [row] : []);
  }};
  const entity = { ...require('./entities/orders'), upsertPage: async (_client, _branch, items) => {
    items.forEach(item => saved.set(item.id, item));
  }};
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.equal(saved.size, 0);
  sourceVisible = true;
  nowMs += 60000;
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.deepEqual(saved.get(row.id), row, 'a delayed order must be recovered on the next poll');
  nowMs += 60000;
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.equal(saved.size, 1);
  assert.equal(checkpoint, '2026-11-21T01:21:00.000Z');
});

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
    assert.equal(query.fromPurchaseDate, '2026-02-01');
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

test('cash flow daily reconciliation recovers old edits; intervening polls replay recent days',async()=>{
  const pool=fakePool(),queries=[],saved=[];
  let checkpoint={last_synced_at:'2026-10-06T00:00:00Z',note:'2026-10-06T00:00:00Z'};
  const driver=createSyncDriver({pool,now:()=>Date.parse('2026-10-07T00:00:00Z'),checkpointRepository:{
    getCheckpoint:async()=>checkpoint,
    advanceCheckpoint:async(_b,_e,at,{note})=>{checkpoint={last_synced_at:at,note};}
  }});
  const entity={...require('./entities/cashFlows'),upsertPage:async(_c,_b,items)=>saved.push(...items),reconcilePage:async(_c,_b,items)=>saved.push(...items)};
  const old={id:501,code:'OldCancelled',status:1,transDate:'2026-02-05T08:00:00',amount:500};
  const api={fetchAllPages:async(_e,q,cb)=>{queries.push(q);await cb(q.startDate.startsWith('1970-')?[old]:[]);}};
  await driver.pollEntityOnce(api,'hanoi',entity);
  assert.equal(queries[0].startDate,'1970-01-01T00:00:00.000Z');
  assert.equal(saved.length,2);
  queries.length=0;
  await driver.pollEntityOnce(api,'hanoi',{...entity,minIntervalMs:0});
  assert.equal(queries[0].startDate,'2026-09-30T00:00:00.000Z');
  assert.equal(queries[0].endDate,'2026-10-07T00:00:00.000Z');
});
test('cash flow reconciliation does not publish a completed marker after a failed later page',async()=>{
  const pool=fakePool();let advances=0;
  const driver=createSyncDriver({pool,checkpointRepository:{getCheckpoint:async()=>null,advanceCheckpoint:async()=>advances++}});
  const entity={...require('./entities/cashFlows'),upsertPage:pool.upsert,reconcilePage:pool.upsert};
  await assert.rejects(driver.pollEntityOnce({fetchAllPages:async(_e,_q,cb)=>{await cb([{id:1}]);throw new Error('later page failed');}},'hanoi',entity),/later page failed/);
  assert.equal(advances,0);
});

test('incomplete full cash flow pagination cannot mark missing cache or advance checkpoint',async()=>{
  const pool=fakePool();let pruned=0,advanced=0;
  const driver=createSyncDriver({pool,checkpointRepository:{getCheckpoint:async()=>null,advanceCheckpoint:async()=>advanced++}});
  const entity={...require('./entities/cashFlows'),reconcilePage:pool.upsert,markMissing:async()=>pruned++};
  const api={fetchAllPages:async(_e,_q,cb)=>{await cb([{id:1}],{total:2});}};
  await assert.rejects(driver.pollEntityOnce(api,'hanoi',entity),/Incomplete cash flow snapshot/);
  assert.equal(pruned,0);assert.equal(advanced,0);
});

test('sync hoa don chi phat invoicesChanged khi trang co dong va da COMMIT; entity khac/trang rong thi khong', async () => {
  const { EventEmitter } = require('events');
  const events = new EventEmitter();
  const seen = [];
  const pool = fakePool();
  events.on('invoicesChanged', payload => seen.push({ ...payload, committed: pool.transactions.at(-1).includes('COMMIT') }));
  const driver = createSyncDriver({ pool, events, now: () => Date.parse('2026-09-14T02:00:00Z'), checkpointRepository: {
    getCheckpoint: async () => ({ last_synced_at: '2026-09-14T01:00:00Z' }),
    advanceCheckpoint: async () => {}
  }});
  const api = { fetchAllPages: async (endpoint, query, onPage) => { await onPage([{ id: 1 }, { id: 2 }]); await onPage([]); } };
  const base = { listQuery: {}, incrementalParam: 'lastModifiedFrom', backfillRangeParam: {}, upsertPage: pool.upsert };
  await driver.pollEntityOnce(api, 'hanoi', { ...base, entity: 'invoices', endpoint: 'invoices' });
  assert.deepEqual(seen, [{ branch: 'hanoi', count: 2, committed: true }]);
  await driver.pollEntityOnce(api, 'hanoi', { ...base, entity: 'orders', endpoint: 'orders' });
  assert.equal(seen.length, 1, 'entity khac khong lam het han cache Hoa don');
});

test('customers force initial reconciliation, preserve daily marker, then use incremental removals transactionally', async () => {
  const { EventEmitter } = require('node:events');
  const pool = fakePool();
  const events = new EventEmitter();
  const notices = [], missing = [], metadata = [], queries = [];
  let clock = Date.parse('2026-10-15T01:00:00Z');
  let checkpoint = { last_synced_at: '2026-10-15T00:50:00Z', note: null };
  events.on('customersChanged', data => notices.push({ ...data, committed: pool.transactions.at(-1).includes('COMMIT') }));
  const driver = createSyncDriver({ pool, events, now: () => clock, checkpointRepository: {
    getCheckpoint: async () => checkpoint,
    advanceCheckpoint: async (_b, _e, at, options) => { checkpoint = { last_synced_at: at, note: options.note }; }
  }});
  const entity = { ...require('./entities/customers'), upsertPage: pool.upsert,
    applyPageMetadata: async (client, branch, info) => { metadata.push(info.removedIds); await client.query('METADATA'); },
    markMissing: async (client, branch, ids) => { missing.push(ids); await client.query('MISSING'); }
  };
  const api = { fetchAllPages: async (_e, query, cb, options) => {
    queries.push(query);
    if (!query.lastModifiedFrom) assert.equal(options.requireComplete, true);
    await cb([{ id: 1 }, { id: 2 }], { total: 2, removedIds: [3] });
  }};
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.equal(queries[0].lastModifiedFrom, undefined);
  assert.deepEqual(missing, [['1', '2']]);
  assert.equal(JSON.parse(checkpoint.note).activeCustomersReconciledAt, '2026-10-15T01:00:00.000Z');
  clock += 60000;
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.equal(queries[1].lastModifiedFrom, '2026-10-15T00:55:00.000Z', 'chong lan 5 phut so voi checkpoint 01:00');
  assert.equal(queries[1].orderBy, 'id');
  assert.equal(queries[1].orderDirection, 'ASC');
  assert.equal(queries[1].includeRemoveIds, 'true');
  assert.equal(missing.length, 1);
  assert.equal(JSON.parse(checkpoint.note).activeCustomersReconciledAt, '2026-10-15T01:00:00.000Z');
  clock += 24 * 60 * 60 * 1000;
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.equal(queries[2].lastModifiedFrom, undefined);
  assert.equal(missing.length, 2);
  assert.deepEqual(metadata, [[3], [3], [3]]);
  assert.deepEqual(notices, Array(3).fill({ branch: 'hanoi', committed: true }));
  assert.ok(pool.transactions.filter(tx => tx.includes('METADATA')).every(tx => tx.join(',') === 'BEGIN,METADATA,COMMIT,RELEASE'));
});

test('customer full scans use stable ID ordering so tied modification dates do not skip later debts', async () => {
  const { createKiotVietClient } = require('../kiotviet/kiotVietApiClient');
  const balances = new Map([[3, 94005900]]);
  let advanced = false;
  const requests = [];
  const source = [1, 2, 3].map(id => ({ id, debt: id === 3 ? -4251600 : 0, modifiedDate: '2026-10-20T12:40:20' }));
  const api = createKiotVietClient({ clientId: 'test', clientSecret: 'test', retailer: 'test', fetchImpl: async url => {
    if (url.includes('/connect/token')) return { ok: true, text: async () => JSON.stringify({ access_token: 'test', expires_in: 3600 }) };
    const query = new URL(url).searchParams;
    requests.push(query);
    const offset = Number(query.get('currentItem'));
    const stable = query.get('orderBy') === 'id' && query.get('orderDirection') === 'ASC';
    const data = offset === 0 ? source.slice(0, 2) : [source[stable ? 2 : 1]];
    return { ok: true, text: async () => JSON.stringify({ total: 3, data }) };
  } });
  const driver = createSyncDriver({ pool: fakePool(), checkpointRepository: {
    getCheckpoint: async () => null, advanceCheckpoint: async () => { advanced = true; }
  } });
  const entity = { ...require('./entities/customers'), listQuery: { ...require('./entities/customers').listQuery, pageSize: '2' },
    upsertPage: async (_client, _branch, items) => { for (const item of items) balances.set(item.id, item.debt); },
    applyPageMetadata: async () => {}, markMissing: async () => {}
  };
  await driver.pollEntityOnce(api, 'hanoi', entity);
  assert.equal(advanced, true);
  assert.equal(balances.get(3), -4251600);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(query => query.get('orderBy') === 'id' && query.get('orderDirection') === 'ASC'));
});

test('invalid or interrupted customer scans never mark missing or publish completion/event', async () => {
  const cases = [
    async cb => { await cb([{ id: 1 }], { total: 2 }); },
    async cb => { await cb([{ id: 1 }, { id: 1 }], { total: 2 }); },
    async cb => { await cb([{ id: 1 }], { total: 1 }); throw new Error('interrupted'); },
    async cb => { await cb([], { total: 0 }); },
    async cb => { await cb([{ id: 1 }]); },
    async cb => { await cb([{ id: 1 }], { total: 2 }); await cb([{ id: 2 }], { total: 3 }); }
  ];
  for (const stream of cases) {
    let marked = 0, advanced = 0, emitted = 0;
    const driver = createSyncDriver({ pool: fakePool(), events: { emit: () => emitted++ }, checkpointRepository: {
      getCheckpoint: async () => ({ last_synced_at: '2026-10-15T00:00:00Z' }), advanceCheckpoint: async () => advanced++
    }});
    const entity = { ...require('./entities/customers'), upsertPage: async () => {}, applyPageMetadata: async () => {}, markMissing: async () => marked++ };
    await assert.rejects(driver.pollEntityOnce({ fetchAllPages: async (_e, _q, cb) => stream(cb) }, 'saigon', entity), /Incomplete.*customer.*snapshot|interrupted/);
    assert.equal(marked, 0);
    assert.equal(advanced, 0);
    assert.equal(emitted, 0);
  }
});

test('overlapping customer callers both await the shared scan completion', async () => {
  let release, calls = 0, emitted = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const driver = createSyncDriver({ pool: fakePool(), events: { emit: () => emitted++ }, checkpointRepository: {
    getCheckpoint: async () => null, advanceCheckpoint: async () => {}
  }});
  const entity = { ...require('./entities/customers'), upsertPage: async () => {}, applyPageMetadata: async () => {}, markMissing: async () => {} };
  const api = { fetchAllPages: async (_e, _q, cb) => { calls++; await pending; await cb([{ id: 1 }], { total: 1 }); } };
  let firstDone = false, secondDone = false;
  const first = driver.pollEntityOnce(api, 'hanoi', entity).then(() => { firstDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  const second = driver.pollEntityOnce(api, 'hanoi', entity).then(() => { secondDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(emitted, 0);
  assert.equal(firstDone, false);
  assert.equal(secondDone, false, 'Manual refresh must not return before the existing scan commits');
  release();
  await Promise.all([first, second]);
  assert.equal(firstDone, true);
  assert.equal(secondDone, true);
  assert.equal(emitted, 1);
});
