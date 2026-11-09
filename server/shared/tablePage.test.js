'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pageRows, sortRows } = require('./tablePage');
test('pageRows clamps last and empty pages, sortRows uses raw numbers/null last and stable ties', () => {
  const rows = [{ n: null }, { n: 10 }, { n: 2 }, { n: 2 }];
  const sorted = sortRows(rows, [{ key: 'n', dir: 'desc' }], { n: row => row.n });
  assert.deepEqual(sorted.map(row => row.n), [10, 2, 2, null]);
  assert.equal(sorted[1], rows[2]);
  assert.deepEqual(pageRows(sorted, { page: 99, pageSize: 3 }), { rows: [rows[0]], totalRows: 4, page: 2, pageSize: 3 });
  assert.equal(pageRows([], { page: 99 }).page, 1);
  assert.deepEqual(sortRows(rows, '[{"key":"n;DROP TABLE","dir":"desc"}]', { n: row => row.n }), rows);
});
