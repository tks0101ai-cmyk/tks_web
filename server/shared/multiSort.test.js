'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSorts, orderBy } = require('./multiSort');

test('multi-sort query: priority, whitelist, duplicate keys, bounded input and legacy fallback', () => {
  const allowed = { name: 'p.name', qty: 'p.qty', cost: 'p.cost' };
  assert.deepEqual(normalizeSorts(JSON.stringify([{ key: 'qty', dir: 'desc' }, { key: 'name', dir: 'asc' }, { key: 'qty', dir: 'asc' }, { key: 'injected', dir: 'asc' }]), allowed), [
    { key: 'qty', dir: 'desc' }, { key: 'name', dir: 'asc' }
  ]);
  assert.deepEqual(normalizeSorts(undefined, allowed, 'cost', 'desc'), [{ key: 'cost', dir: 'desc' }]);
  for (const invalid of ['[', '{}', 'null', 'x'.repeat(30000), [{ key: 'qty', dir: 'desc; DROP TABLE x' }]]) {
    assert.deepEqual(normalizeSorts(invalid, allowed), []);
  }
  assert.deepEqual(normalizeSorts([{ key: '__proto__', dir: 'asc' }], allowed), []);
  assert.equal(orderBy([{ key: 'qty', dir: 'desc' }, { key: 'name', dir: 'asc' }], allowed), 'p.qty DESC NULLS LAST, p.name ASC NULLS LAST');
  assert.equal(orderBy([{ key: 'evil', dir: 'asc' }], allowed), '');
});


test('strict API normalization rejects malformed, duplicate and non-whitelisted layers', () => {
  const strict = require('./multiSort').normalizeSortsStrict;
  for (const value of ['invalid','null','{}','[{"key":"unknown","dir":"asc"}]','[{"key":"name","dir":"sideways"}]','[{"key":"name","dir":"asc"},{"key":"name","dir":"desc"}]']) {
    assert.throws(() => strict(value,['name']), {statusCode:400});
  }
  assert.deepEqual(strict('[{"key":"name","dir":"desc"}]',['name']),[{key:'name',dir:'desc'}]);
});
