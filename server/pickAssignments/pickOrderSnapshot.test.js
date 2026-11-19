'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeOrderSnapshot } = require('./pickOrderSnapshot');

test('snapshot preserves original duplicate lines and exact original amount', () => {
  const snap = makeOrderSnapshot({ customerName:'A', invoiceDiscount:0, lines:[
    {productCode:'A', productName:'Hàng A', quantity:10000, price:10, discount:0},
    {productCode:'a', productName:'Hàng A', quantity:1, price:11, discount:0},
    {productCode:'VAT8', quantity:1, price:99},
    {productCode:'DV', isService:true, quantity:1, price:99}
  ] });
  assert.equal(snap.schemaVersion, 2);
  assert.equal(snap.lines.length, 2);
  assert.equal(snap.goodsTotal, '100011');
  assert.equal(snap.payable, '100011');
  assert.equal(snap.lines[1].price, 11);
  assert.equal(snap.customerName, 'A');
});

test('decimal prices and discounts are computed without binary float arithmetic', () => {
  const snap = makeOrderSnapshot({ invoiceDiscount:'0.01', lines:[
    {productCode:'A', quantity:3, price:'0.3', discount:'0.1'},
    {productCode:'A', quantity:1, price:1e-7, discount:0}
  ] });
  assert.equal(snap.lines[0].amount, '0.6');
  assert.equal(snap.lines[0].unitPrice, '0.2');
  assert.equal(snap.goodsTotal, '0.6000001');
  assert.equal(snap.payable, '0.5900001');
});

test('reject invalid money and non-positive original lines; fractional lines are priced exactly', () => {
  for (const price of [Infinity, NaN, '', 'not-money', null]) {
    assert.throws(() => makeOrderSnapshot({invoiceDiscount:0, lines:[{productCode:'A', quantity:1, price}]}), {code:'VALIDATION'});
  }
  for (const quantity of [0, -1, Infinity, NaN, 1e13]) {
    assert.throws(() => makeOrderSnapshot({invoiceDiscount:0, lines:[{productCode:'A', quantity, price:1}]}), {code:'VALIDATION'});
  }
});
