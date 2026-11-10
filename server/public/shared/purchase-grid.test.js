const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const grid = require('./purchase-grid');
const rows = Array.from({ length: 6 }, (_, i) => ({ id: 'id' + i, rowKey: 'R' + i, productCode: 'P' }));
const columns = [{ k: 'qty' }, { k: 'price' }, { k: 'note' }];
const cell = (r, key = 'qty') => ({ id: 'id' + r, key });
const options = (extra = {}) => ({ rows, columns, anchor: cell(1), focus: cell(2, 'price'), ...extra });

test('UMD exports exact API to CommonJS, browser and AMD without dependencies', () => {
  const names = ['fill', 'parseTSV', 'planPaste', 'range', 'serializeTSV', 'summarize'];
  assert.deepEqual(Object.keys(grid).sort(), names);
  const source = fs.readFileSync(__dirname + '/purchase-grid.js', 'utf8');
  const browser = {};
  vm.runInNewContext(source, browser);
  assert.deepEqual(Object.keys(browser.PurchaseGrid).sort(), names);
  let exported;
  const define = (dependencies, factory) => { exported = factory(); };
  define.amd = {};
  vm.runInNewContext(source, { define });
  assert.deepEqual(Object.keys(exported).sort(), names);
});

test('TSV handles quoted tabs, multiline text, doubled quotes, CRLF and trailing empties', () => {
  assert.deepEqual(grid.parseTSV('a\t"b\tc"\t"say ""hi"""\r\n"line\nnext"\t\t\r\n'),
    [['a', 'b\tc', 'say "hi"'], ['line\nnext', '', '']]);
  assert.deepEqual(grid.parseTSV(''), []);
  assert.deepEqual(grid.parseTSV('""'), [['']]);
  assert.deepEqual(grid.parseTSV('\t'), [['', '']]);
  assert.deepEqual(grid.parseTSV('a\n\n'), [['a'], ['']]);
  assert.deepEqual(grid.parseTSV('"a\r\nb"'), [['a\r\nb']]);
  assert.throws(() => grid.parseTSV('"unfinished'), /Unterminated/);
  assert.throws(() => grid.parseTSV('"done"oops'), /Unexpected/);
});

test('TSV serialization round trips raw formulas and special characters', () => {
  const matrix = [['=A1*2', '001.20', 'a\tb', '"quoted"'], ['x\ny', 'z\r\nw', '', '']];
  assert.deepEqual(grid.parseTSV(grid.serializeTSV(matrix)), matrix);
  assert.equal(grid.serializeTSV([]), '');
});

test('range is row-major, handles reversed endpoints and structural IDs after reorder/filter', () => {
  assert.deepEqual(grid.range(options({ anchor: cell(2, 'price'), focus: cell(1) })),
    [cell(1), cell(1, 'price'), cell(2), cell(2, 'price')]);
  assert.deepEqual(grid.range(options({ rows: [rows[2], rows[4], rows[1]], columns: [columns[1], columns[0]] })),
    [cell(2, 'price'), cell(2), cell(4, 'price'), cell(4), cell(1, 'price'), cell(1)]);
  for (const extra of [{ rows: [rows[1]] }, { anchor: null }, { focus: cell(9) }, { columns: [] }]) {
    assert.deepEqual(grid.range(options(extra)), []);
    assert.deepEqual(grid.planPaste(options({ ...extra, text: 'x' })), []);
  }
});

test('scalar paste fills selection and preserves all raw input and source objects', () => {
  const before = JSON.stringify({ rows, columns });
  assert.deepEqual(grid.planPaste(options({ text: '=SUM(A1:A2)' })),
    grid.range(options()).map(value => ({ ...value, raw: '=SUM(A1:A2)' })));
  assert.deepEqual(grid.planPaste(options({ text: '""' })).map(value => value.raw), ['', '', '', '']);
  assert.equal(JSON.stringify({ rows, columns }), before);
});

test('matrix starts at rectangle top-left, can extend past selection and never clips overflow', () => {
  assert.deepEqual(grid.planPaste(options({ anchor: cell(2, 'price'), focus: cell(1), text: '001\t=2+3\na\tb\nc\td' })), [
    { ...cell(1), raw: '001' }, { ...cell(1, 'price'), raw: '=2+3' },
    { ...cell(2), raw: 'a' }, { ...cell(2, 'price'), raw: 'b' },
    { ...cell(3), raw: 'c' }, { ...cell(3, 'price'), raw: 'd' }
  ]);
  assert.throws(() => grid.planPaste(options({ anchor: cell(5), focus: cell(5), text: 'a\nb' })), /bounds/);
  assert.throws(() => grid.planPaste(options({ anchor: cell(1, 'note'), focus: cell(1, 'note'), text: 'a\tb' })), /bounds/);
  assert.deepEqual(grid.planPaste(options({ text: '' })), []);
});

test('keyed paste maps exact unique rowKeys regardless of visible ordering, with optional header', () => {
  for (const prefix of ['', 'Mã dòng\tQuantity\tPrice\n', 'rowKey\tqty\tprice\n']) {
    assert.deepEqual(grid.planPaste(options({ rows: [rows[5], rows[2], rows[1]], text: prefix + 'R5\t007\t=A1\nR1\t2\t3' })), [
      { ...cell(5), raw: '007' }, { ...cell(5, 'price'), raw: '=A1' },
      { ...cell(1), raw: '2' }, { ...cell(1, 'price'), raw: '3' }
    ]);
  }
});

test('keyed paste rejects unknown, filtered, duplicate, nonexact and product codes atomically', () => {
  for (const text of ['rowKey\tqty\nP\t1', 'rowKey\tqty\nR1 \t1', 'R1\t1\nunknown\t2',
    'unknown\t1\nR1\t2', 'R1\t1\nR1\t2', 'rowKey\tqty\nR1', 'rowKey\tqty\nR0\t1']) {
    assert.throws(() => grid.planPaste(options({ rows: rows.slice(1), text })), /rowKey/);
  }
  assert.throws(() => grid.planPaste(options({ rows: [...rows, { id: 'other', rowKey: 'R1' }], text: 'R1\t1' })), /duplicate/);
  assert.throws(() => grid.planPaste(options({ text: 'R1\t1\t2\t3\t4' })), /bounds/);
  // No key header or recognized key means an ordinary matrix, never productCode mapping.
  assert.deepEqual(grid.planPaste(options({ text: 'P\t7' })), [{ ...cell(1), raw: 'P' }, { ...cell(1, 'price'), raw: '7' }]);
});

test('fill repeats complete selected rows downward and upward, preserving source IDs', () => {
  assert.deepEqual(grid.fill(options({ target: cell(5) })), [3, 4, 5].flatMap((r, i) =>
    ['qty', 'price'].map(key => ({ ...cell(r, key), fromId: 'id' + (1 + i % 2), fromKey: key }))));
  assert.deepEqual(grid.fill(options({ anchor: cell(2), focus: cell(3), target: cell(0) })), [
    { ...cell(0), fromId: 'id2', fromKey: 'qty' }, { ...cell(1), fromId: 'id3', fromKey: 'qty' }
  ]);
  assert.deepEqual(grid.fill(options({ rows: [rows[2], rows[1], rows[5]], target: cell(5) })), [
    { ...cell(5), fromId: 'id2', fromKey: 'qty' }, { ...cell(5, 'price'), fromId: 'id2', fromKey: 'price' }
  ]);
  for (const target of [cell(1), cell(2), cell(9), cell(5, 'unknown'), null]) {
    assert.deepEqual(grid.fill(options({ target })), []);
  }
  assert.deepEqual(grid.fill(options({ anchor: null, target: cell(5) })), []);
});

test('summary counts nonempty text and finite supplied numbers without coercing raw strings', () => {
  assert.deepEqual(grid.summarize([{ text: '0', number: 0 }, { text: '2', number: 2 },
    { text: '-4', number: -4 }, { text: '=A1', number: NaN }, { text: '9', number: '9' },
    { text: '', number: null }, { text: null, number: Infinity }]),
  { count: 5, numeric: 3, sum: -2, average: -2 / 3 });
  assert.deepEqual(grid.summarize([]), { count: 0, numeric: 0, sum: 0, average: null });
});
