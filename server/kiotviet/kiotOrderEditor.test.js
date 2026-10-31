'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createKiotOrderEditor, buildBody, planRemoval, planQuantities, verifyAfter, kiotMessage, enabled } = require('./kiotOrderEditor');

const baseOrder = () => ({
  id: 501, code: 'DH001', branchId: 7, soldById: 11, customerId: 21, customerCode: 'KH1', customerName: 'Khach A',
  purchaseDate: '2026-10-30T08:00:00', discount: 5000, description: 'Giao sang', method: 'Cash', totalPayment: 100000,
  statusValue: 'Phiếu tạm', payments: [{ id: 1, amount: 100000, accountId: 3 }], invoiceOrderSurcharges: [],
  orderDelivery: { receiver: 'A', address: 'HN' },
  orderDetails: [
    { productId: 1, productCode: 'AAA', productName: 'Hang A', quantity: 10, price: 1000, discount: 0, note: '5T x 2' },
    { productId: 2, productCode: 'BBB', productName: 'Hang B', quantity: 4, price: 2000, discount: 100, note: '' },
    { productId: 3, productCode: 'VAT10', productName: 'VAT', quantity: 1, price: 800, discount: 0 }
  ]
});

function harness({ ignoreNote = false, rejectWith = null, breakCustomer = false } = {}) {
  const state = { order: baseOrder(), puts: [], persisted: [], logs: [] };
  const client = {
    fetchOrderById: async () => JSON.parse(JSON.stringify(state.order)),
    updateOrder: async (id, body) => {
      state.puts.push({ id, body });
      if (rejectWith) throw new Error(rejectWith);
      state.order = {
        ...state.order,
        discount: body.discount, description: body.description, totalPayment: body.totalPayment,
        customerId: breakCustomer ? 999 : state.order.customerId,
        orderDetails: body.orderDetails.map(line => (ignoreNote ? { ...line, note: '' } : { ...line }))
      };
      return state.order;
    }
  };
  const db = {
    query: async (sql, params) => {
      if (/FROM orders/.test(sql)) return { rows: params[1] === 'dh001' ? [{ id: 501 }] : [] };
      if (/order_kiot_edit_log/.test(sql)) { state.logs.push({ action: params[2], summary: JSON.parse(params[3]) }); return { rows: [] }; }
      throw new Error('unexpected sql ' + sql);
    }
  };
  const editor = createKiotOrderEditor({
    getDb: () => db, getBranchConfig: () => ({ branch: 'hanoi', clientId: 'x', clientSecret: 'y', retailer: 'CH' }),
    createClient: () => client, persistOrder: async (_db, branch, order) => { state.persisted.push({ branch, order }); }
  });
  return { state, editor };
}

test('planRemoval xoa moi dong cua ma, giu VAT, chan xoa dong cuoi', () => {
  const next = planRemoval(baseOrder().orderDetails, 'aaa');
  assert.deepEqual(next.map(line => line.productCode), ['BBB', 'VAT10']);
  assert.throws(() => planRemoval(baseOrder().orderDetails, 'ZZZ'), { code: 'VALIDATION' });
  assert.throws(() => planRemoval(next, 'BBB'), { code: 'LAST_LINE' });
});

test('planQuantities doi SL, gop dong trung ma ve dong dau voi gia binh quan', () => {
  const details = [
    ...baseOrder().orderDetails.slice(0, 1),
    { productId: 1, productCode: 'aaa', productName: 'Hang A', quantity: 10, price: 2000, discount: 0, note: '15th' },
    ...baseOrder().orderDetails.slice(1)
  ];
  const next = planQuantities(details, { AAA: 30 });
  const lines = next.filter(line => line.productCode.toLowerCase() === 'aaa');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].quantity, 30);
  assert.equal(lines[0].price, 1500);
  assert.equal(lines[0].note, '5T x 2; 15th');
  assert.throws(() => planQuantities(details, { AAA: 0 }), { code: 'VALIDATION' });
  assert.throws(() => planQuantities(details, { AAA: 1.5 }), { code: 'VALIDATION' });
  assert.throws(() => planQuantities(details, { ZZZ: 1 }), { code: 'VALIDATION' });
});

test('buildBody giu nguyen truong don, chi doi orderDetails va khong tao hoa don', () => {
  const order = baseOrder();
  const body = buildBody(order, order.orderDetails.slice(1));
  assert.equal(body.makeInvoice, false);
  assert.equal(body.branchId, 7);
  assert.equal(body.soldById, 11);
  assert.equal(body.discount, 5000);
  assert.equal(body.description, 'Giao sang');
  assert.equal(body.accountId, 3);
  assert.deepEqual(body.customer, { id: 21, code: 'KH1', name: 'Khach A' });
  assert.deepEqual(body.orderDelivery, order.orderDelivery);
  assert.equal(body.orderDetails.length, 2);
  assert.ok(!('surchages' in body));
});

test('removeLine ghi len Kiot, doc lai doi chieu, cap nhat DB cuc bo va ghi nhat ky', async () => {
  const { state, editor } = harness();
  const result = await editor.removeLine({ branch: 'HN', orderCode: 'DH001', productCode: 'AAA', actor: { id: 9, name: 'Quan ly' } });
  assert.equal(result.changed, true);
  assert.equal(state.puts.length, 1);
  assert.deepEqual(state.puts[0].body.orderDetails.map(line => line.productCode), ['BBB', 'VAT10']);
  assert.equal(state.persisted.length, 1);
  assert.equal(state.persisted[0].branch, 'hanoi');
  assert.equal(state.logs[0].action, 'remove_line');
  assert.equal(state.logs[0].summary.productCode, 'AAA');
  assert.equal(state.logs[0].summary.before.length, 3);
});

test('setQuantities khong goi Kiot khi SL khong doi', async () => {
  const { state, editor } = harness();
  const result = await editor.setQuantities({ branch: 'HN', orderCode: 'DH001', quantities: { AAA: 10 } });
  assert.equal(result.changed, false);
  assert.equal(state.puts.length, 0);
});

test('setQuantities doi SL tren Kiot', async () => {
  const { state, editor } = harness();
  await editor.setQuantities({ branch: 'HN', orderCode: 'DH001', quantities: { AAA: 7 } });
  assert.equal(state.order.orderDetails.find(line => line.productCode === 'AAA').quantity, 7);
  assert.equal(state.logs[0].action, 'set_quantity');
});

test('Kiot tu choi PUT -> loi 502, khong cap nhat DB, khong khoi phuc', async () => {
  const { state, editor } = harness({ rejectWith: 'HTTP 400: {"responseStatus":{"message":"Don da hoan thanh"}}' });
  await assert.rejects(editor.removeLine({ branch: 'HN', orderCode: 'DH001', productCode: 'AAA' }), { code: 'KIOT_REJECTED', message: /Don da hoan thanh/ });
  assert.equal(state.puts.length, 1);
  assert.equal(state.persisted.length, 0);
});

test('Kiot bo qua ghi chu dong -> doi chieu that bai, khoi phuc va bao ro', async () => {
  const { state, editor } = harness({ ignoreNote: true });
  await assert.rejects(editor.setQuantities({ branch: 'HN', orderCode: 'DH001', quantities: { BBB: 9 } }), { code: 'KIOT_ROLLBACK_FAILED' });
  assert.equal(state.puts.length, 2);
  assert.equal(state.persisted.length, 0);
  assert.equal(state.logs[0].action, 'rollback');
  assert.equal(state.logs[0].summary.restored, false);
});

test('Kiot doi truong khac (khach) -> khoi phuc va bao loi', async () => {
  const { state, editor } = harness({ breakCustomer: true });
  await assert.rejects(editor.removeLine({ branch: 'HN', orderCode: 'DH001', productCode: 'AAA' }), { code: /KIOT_(VERIFY|ROLLBACK)_FAILED/ });
  assert.equal(state.puts.length, 2);
  assert.equal(state.persisted.length, 0);
});

test('don khong co trong DB -> 404; tat co -> 403', async () => {
  const { editor } = harness();
  await assert.rejects(editor.removeLine({ branch: 'HN', orderCode: 'XXX', productCode: 'AAA' }), { code: 'NOT_FOUND' });
  const off = createKiotOrderEditor({ isEnabled: () => false });
  await assert.rejects(off.removeLine({ branch: 'HN', orderCode: 'DH001', productCode: 'AAA' }), { code: 'KIOT_WRITE_DISABLED' });
  assert.equal(enabled({ KIOT_ORDER_WRITE_ENABLED: 'false' }), false);
  assert.equal(enabled({}), true);
});

test('verifyAfter bo qua so tien giam khi giam theo %, kiotMessage rut gon loi', () => {
  const before = { ...baseOrder(), discountRatio: 5 };
  const after = { ...baseOrder(), discount: 1234 };
  assert.deepEqual(verifyAfter(before, after, baseOrder().orderDetails.map(line => ({ ...line }))), []);
  assert.equal(kiotMessage(new Error('HTTP 400: {"responseStatus":{"message":"Loi X"}}')), 'Loi X');
});
