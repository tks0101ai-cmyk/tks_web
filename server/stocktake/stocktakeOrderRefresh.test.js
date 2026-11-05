'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrderRefresher, isTeamOrder } = require('./stocktakeOrderRefresh');

const NOW = Date.parse('2026-11-05T02:30:00.000Z');
const BRANCHES = [{ branch: 'hanoi', clientId: 'a', clientSecret: 'b', retailer: 'c' }];

function harness({ checkpoint = '2026-11-05T02:29:00.000Z', pages = [[]], fetchError, upsertError, branches = BRANCHES, known = [] } = {}) {
  const state = { queries: [], fetchCalls: [], upserts: [], clients: [], clock: NOW, transactions: [], released: 0 };
  const client = {
    query: async sql => { state.transactions.push(sql); return { rows: [] }; },
    release: () => { state.released += 1; }
  };
  const db = {
    query: async (sql, params) => {
      state.queries.push([sql, params]);
      if (/FROM orders/.test(sql)) return { rows: known.filter(row => params[1].includes(row.id)) };
      return { rows: checkpoint ? [{ last_synced_at: checkpoint }] : [] };
    },
    connect: async () => client
  };
  const refresh = createOrderRefresher({
    getDb: () => db,
    getBranches: () => branches,
    createClient: config => {
      state.clients.push(config);
      return {
        fetchAllPages: async (endpoint, query, onPage) => {
          state.fetchCalls.push([endpoint, query]);
          if (state.hold) await state.hold;
          if (fetchError) throw fetchError;
          for (const page of pages) await onPage(page, {});
        }
      };
    },
    ordersEntity: {
      endpoint: 'orders',
      listQuery: { includePayment: 'true', pageSize: '20' },
      upsertPage: async (pg, branch, items) => {
        if (upsertError) throw upsertError;
        state.upserts.push([pg, branch, items]);
      }
    },
    now: () => state.clock,
    logger: { error() {} }
  });
  return { refresh, state };
}

test('nhan dien don TEAM + so giong dieu kien gom don cua dot', () => {
  for (const name of ['TEAM 1: Quân test', 'team5 kho', '  TEAM 12 : A + B']) assert.equal(isTeamOrder({ customerName: name }), true, name);
  for (const name of ['Team Lỗi', 'KH Team Hàng Lỗi', 'Khách thường', '', null]) assert.equal(isTeamOrder({ customerName: name }), false, String(name));
});

test('lay don tu 5 phut truoc checkpoint, chi ghi don TEAM, khong dong vao checkpoint', async () => {
  const team = { id: 1, customerName: 'TEAM 1: Quân test' };
  const other = { id: 2, customerName: 'Khách thường' };
  const { refresh, state } = harness({ pages: [[team, other], [other]] });
  const result = await refresh('hanoi');
  assert.deepEqual(result, { fetched: 3, teamOrders: 1, refreshedAt: new Date(NOW).toISOString(), cached: false });
  const [endpoint, query] = state.fetchCalls[0];
  assert.equal(endpoint, 'orders');
  assert.equal(query.lastModifiedFrom, '2026-11-05T02:24:00.000Z');
  assert.equal(query.includePayment, 'true');
  assert.equal(state.upserts.length, 1, 'trang khong co don TEAM thi khong mo giao dich');
  assert.equal(state.upserts[0][1], 'hanoi');
  assert.deepEqual(state.upserts[0][2], [team]);
  assert.deepEqual(state.transactions, ['BEGIN', 'COMMIT']);
  assert.equal(state.released, 1);
  assert.ok(state.queries.every(([sql]) => !/INSERT|UPDATE/.test(sql)), 'checkpoint van do luot nen quan ly');
  assert.equal(state.clients[0].retailer, 'c');
});

test('chi ghi don chua co hoac da doi so voi DB', async () => {
  const fresh = { id: 1, customerName: 'TEAM 1', modifiedDate: '2026-11-05T09:21:44.9930000' };
  const edited = { id: 2, customerName: 'TEAM 2', modifiedDate: '2026-11-05T09:30:00.0000000' };
  const same = { id: 3, customerName: 'TEAM 3', modifiedDate: '2026-11-05T09:10:00.0000000' };
  const sameNew = { id: 4, customerName: 'TEAM 4' };
  const { refresh, state } = harness({
    pages: [[fresh, edited, same, sameNew]],
    known: [{ id: 2, modified: '2026-11-05T09:00:00.0000000' }, { id: 3, modified: '2026-11-05T09:10:00.0000000' }, { id: 4, modified: null }]
  });
  const result = await refresh('hanoi');
  assert.equal(result.teamOrders, 2);
  assert.deepEqual(state.upserts[0][2], [fresh, edited]);
});

test('don TEAM deu da moi nhat: khong mo giao dich', async () => {
  const { refresh, state } = harness({ pages: [[{ id: 3, customerName: 'TEAM 3', modifiedDate: 'a' }]], known: [{ id: 3, modified: 'a' }] });
  assert.equal((await refresh('hanoi')).teamOrders, 0);
  assert.deepEqual(state.transactions, []);
});

test('chua co checkpoint: lay 1 gio; checkpoint qua cu: gioi han 24 gio', async () => {
  const none = harness({ checkpoint: null });
  await none.refresh('hanoi');
  assert.equal(none.state.fetchCalls[0][1].lastModifiedFrom, new Date(NOW - 3600 * 1000).toISOString());
  const old = harness({ checkpoint: '2026-10-01T00:00:00.000Z' });
  await old.refresh('hanoi');
  assert.equal(old.state.fetchCalls[0][1].lastModifiedFrom, new Date(NOW - 24 * 3600 * 1000).toISOString());
});

test('bam lien tiep: goi trung nhau dung chung 1 luot, trong 15 giay tra ket qua vua lay', async () => {
  const { refresh, state } = harness();
  let release;
  state.hold = new Promise(resolve => { release = resolve; });
  const first = refresh('hanoi');
  const second = refresh('hanoi');
  await new Promise(resolve => setImmediate(resolve));
  release();
  assert.deepEqual(await first, await second);
  assert.equal(state.fetchCalls.length, 1);
  state.clock = NOW + 14999;
  assert.equal((await refresh('hanoi')).cached, true);
  assert.equal(state.fetchCalls.length, 1);
  state.clock = NOW + 15000;
  assert.equal((await refresh('hanoi')).cached, false);
  assert.equal(state.fetchCalls.length, 2);
});

test('loi KiotViet: bao 424, khong cache, bam lai duoc ngay', async () => {
  const { refresh, state } = harness({ fetchError: new Error('HTTP 500') });
  await assert.rejects(refresh('hanoi'), { statusCode: 424, code: 'KIOT_READ_FAILED' });
  await assert.rejects(refresh('hanoi'), { statusCode: 424 });
  assert.equal(state.fetchCalls.length, 2);
});

test('loi ghi DB: rollback, tra ket noi, bao 424', async () => {
  const { refresh, state } = harness({ pages: [[{ id: 1, customerName: 'TEAM 1' }]], upsertError: new Error('deadlock') });
  await assert.rejects(refresh('hanoi'), { statusCode: 424 });
  assert.deepEqual(state.transactions, ['BEGIN', 'ROLLBACK']);
  assert.equal(state.released, 1);
});

test('co so chua cau hinh KiotViet: bao ro, khong goi API', async () => {
  const { refresh, state } = harness({ branches: [] });
  await assert.rejects(refresh('hanoi'), { statusCode: 424, code: 'KIOT_NOT_CONFIGURED' });
  assert.equal(state.fetchCalls.length, 0);
});
