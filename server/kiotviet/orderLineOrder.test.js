'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { orderDetailsByKiotLines, createOrderLineSorter } = require('./orderLineOrder');

// Don DH047477 that: Public API sap theo productId, Kiot sap theo Id dong.
const apiDetails = [
  { productId: 48047336, productCode: 'HC3T1040', quantity: 240 },
  { productId: 48047693, productCode: 'TDCM100DNH', quantity: 400 },
  { productId: 48048152, productCode: 'B10V336', quantity: 65 },
  { productId: 48048153, productCode: 'B10V420', quantity: 50 },
  { productId: 51862260, productCode: 'HOMMIE2', quantity: 140 }
];
const kiotLines = [
  { id: 84452054, productId: 51862260, quantity: 140 },
  { id: 84452055, productId: 48047693, quantity: 400 },
  { id: 84452056, productId: 48048152, quantity: 65 },
  { id: 84452057, productId: 48048153, quantity: 50 },
  { id: 84452058, productId: 48047336, quantity: 240 }
];
const codes = list => list.map(d => d.productCode);
const silent = { warn() {} };

test('orderDetailsByKiotLines sap theo Id dong cua Kiot', () => {
  assert.deepEqual(codes(orderDetailsByKiotLines(apiDetails, kiotLines)),
    ['HOMMIE2', 'TDCM100DNH', 'B10V336', 'B10V420', 'HC3T1040']);
});

test('orderDetailsByKiotLines: cung ma nhieu dong ghep theo SL', () => {
  const details = [{ productId: 1, productCode: 'A', quantity: 5 }, { productId: 1, productCode: 'A', quantity: 9 }, { productId: 2, productCode: 'B', quantity: 1 }];
  const lines = [{ id: 1, productId: 2, quantity: 1 }, { id: 2, productId: 1, quantity: 9 }, { id: 3, productId: 1, quantity: 5 }];
  assert.deepEqual(orderDetailsByKiotLines(details, lines).map(d => d.quantity), [1, 9, 5]);
});

test('orderDetailsByKiotLines tra null khi lech so dong hoac thieu ma', () => {
  assert.equal(orderDetailsByKiotLines(apiDetails, kiotLines.slice(1)), null);
  assert.equal(orderDetailsByKiotLines(apiDetails, [...kiotLines.slice(1), { id: 9, productId: 7, quantity: 1 }]), null);
});

test('sortOrders sap don gan day, bo qua don cu va don 1 dong', async () => {
  const calls = [];
  const sorter = createOrderLineSorter({ now: () => Date.parse('2026-10-31T00:00:00Z'), log: silent,
    clientFor: () => ({ fetchOrderLines: async id => { calls.push(id); return kiotLines; } }) });
  const recent = { id: 1, code: 'DH1', purchaseDate: '2026-10-30T08:20:09', orderDetails: apiDetails };
  const old = { id: 2, code: 'DH2', purchaseDate: '2026-01-01T00:00:00', orderDetails: apiDetails };
  const single = { id: 3, code: 'DH3', purchaseDate: '2026-10-30T00:00:00', orderDetails: apiDetails.slice(0, 1) };
  const [a, b, c] = await sorter.sortOrders('hanoi', [recent, old, single]);
  assert.equal(codes(a.orderDetails)[0], 'HOMMIE2');
  assert.equal(b, old);
  assert.equal(c, single);
  assert.deepEqual(calls, [1]);
  const forced = await sorter.sortOrder('hanoi', old, { force: true });
  assert.equal(codes(forced.orderDetails)[0], 'HOMMIE2');
});

test('sortOrder fail-soft: loi API giu nguyen va tam dung, chua cau hinh giu nguyen', async () => {
  let t = 0; let calls = 0;
  const failing = createOrderLineSorter({ now: () => t, log: silent,
    clientFor: () => ({ fetchOrderLines: async () => { calls++; throw new Error('HTTP 500'); } }) });
  const order = { id: 1, code: 'DH1', orderDetails: apiDetails };
  assert.equal(await failing.sortOrder('hanoi', order), order);
  assert.equal(await failing.sortOrder('hanoi', order), order);
  assert.equal(calls, 1);
  t = 11 * 60 * 1000;
  await failing.sortOrder('hanoi', order);
  assert.equal(calls, 2);
  const none = createOrderLineSorter({ clientFor: () => null, log: silent });
  assert.equal(await none.sortOrder('hanoi', order), order);
});
