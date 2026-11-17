'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileOpenOrders, planUpdate, isOpenStatus, TERMINAL_STATUSES } = require('./reconcileOpenOrders');

const row = (over = {}) => ({ branch: 'hanoi', id: '1', code: 'DH044921', raw: { statusValue: 'Phiếu tạm' }, synced_at: null, ...over });
const silent = { log() {}, warn() {} };

test('chi coi Hoan thanh va Da huy la ket thuc; con lai van phai theo doi', () => {
  assert.deepEqual(TERMINAL_STATUSES, ['Hoàn thành', 'Đã hủy']);
  for (const open of ['Phiếu tạm', 'Đã xác nhận', 'Đang giao hàng', '', 'Trạng thái lạ']) {
    assert.equal(isOpenStatus(open), true, open || '(rong)');
  }
  for (const done of TERMINAL_STATUSES) assert.equal(isOpenStatus(done), false, done);
});

test('don bi huy tren KiotViet duoc phat hien va ghi dung trang thai moi', () => {
  const plan = planUpdate(row(), { found: true, order: { statusValue: 'Đã hủy', status: 4 } });
  assert.equal(plan.action, 'update');
  assert.equal(plan.from, 'Phiếu tạm');
  assert.equal(plan.to, 'Đã hủy');
});

test('khong bia trang thai: 404 chi bao missing chu khong suy ra la da huy', () => {
  const plan = planUpdate(row(), { found: false, order: null });
  assert.equal(plan.action, 'missing');
  assert.equal(plan.code, 'DH044921');
  assert.ok(!('to' in plan), 'khong duoc gan trang thai nao cho don 404');
});

test('API khong tra statusValue thi bo qua, khong ghi de bang chuoi rong', () => {
  assert.equal(planUpdate(row(), { found: true, order: { status: 4 } }).action, 'skip');
  assert.equal(planUpdate(row(), { found: true, order: { statusValue: 'Phiếu tạm' } }).action, 'unchanged');
});

function fakePool(rows) {
  const writes = [];
  return {
    writes,
    queries: [],
    async query(sql, params) {
      this.queries.push({ sql, params });
      if (/UPDATE orders/.test(sql)) { writes.push({ branch: params[0], id: params[1], raw: JSON.parse(params[2]) }); return { rows: [] }; }
      return { rows };
    },
  };
}

test('luot doi soat chi hoi don chua ket thuc va ghi lai don da huy', async () => {
  const pool = fakePool([row(), row({ id: '2', code: 'DH049077' })]);
  const asked = [];
  const client = {
    async fetchOrderById(id) {
      asked.push(id);
      return id === '1'
        ? { found: true, order: { statusValue: 'Đã hủy', status: 4, modifiedDate: '2026-11-10T03:00:00Z' } }
        : { found: true, order: { statusValue: 'Phiếu tạm' } };
    },
  };
  const summary = await reconcileOpenOrders({ pool, client, logger: silent });
  assert.deepEqual(asked, ['1', '2']);
  assert.equal(summary.updated, 1);
  assert.equal(summary.unchanged, 1);
  assert.deepEqual(summary.changes, [{ code: 'DH044921', from: 'Phiếu tạm', to: 'Đã hủy' }]);
  assert.equal(pool.writes.length, 1, 'chi ghi dong that su doi');
  assert.equal(pool.writes[0].raw.statusValue, 'Đã hủy');
  // Cau chon ung vien phai loai san trang thai ket thuc o tang SQL.
  assert.deepEqual(pool.queries[0].params[0], TERMINAL_STATUSES);
});

test('mot don loi khong lam hong ca luot va duoc dem rieng', async () => {
  const pool = fakePool([row(), row({ id: '2', code: 'DH2' })]);
  const client = {
    async fetchOrderById(id) {
      if (id === '1') throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return { found: true, order: { statusValue: 'Đã hủy' } };
    },
  };
  const summary = await reconcileOpenOrders({ pool, client, logger: silent });
  assert.equal(summary.skipped, 1);
  assert.equal(summary.updated, 1, 'don sau van duoc xu ly');
});

test('don khong con tren API duoc dem va neu ten, khong bi sua du lieu', async () => {
  const pool = fakePool([row()]);
  const client = { async fetchOrderById() { return { found: false, order: null }; } };
  const summary = await reconcileOpenOrders({ pool, client, logger: silent });
  assert.equal(summary.missing, 1);
  assert.deepEqual(summary.missingCodes, ['DH044921']);
  assert.equal(pool.writes.length, 0, 'don 404 khong duoc ghi de');
});

test('thieu client thi bao loi ro thay vi chay im lang', async () => {
  await assert.rejects(() => reconcileOpenOrders({ pool: fakePool([]) }), /fetchOrderById/);
});
