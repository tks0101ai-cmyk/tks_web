const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('UMD helper is available', () => {
  assert.ok(fs.existsSync(__dirname + '/purchase-draft-history.js'));
});

function fixture(saved) {
  const { create } = require('./purchase-draft-history');
  let value = saved?.value || { a: '7', b: '8' };
  const stack = saved?.stack || [];
  const history = create({ snapshot: () => value,
    remember: (before, label) => stack.push({ before, label }), state: saved?.active });
  return { history, stack, get value() { return value; },
    type(key, text) { history.begin(key); value[key] = text; },
    undo() { const before = history.undo(() => stack.pop()); if (before !== undefined) value = before; },
    save() { return JSON.parse(JSON.stringify({ value, stack, active: history.exportState() })); } };
}

test('begin coalesces digits and undo restores the old value while focused', () => {
  const f = fixture(); f.type('a', '1'); f.type('a', '12'); f.type('a', '123');
  assert.equal(f.stack.length, 0); f.undo(); assert.equal(f.value.a, '7');
  assert.equal(f.history.exportState(), null);
  f.type('a', '9'); f.undo(); assert.equal(f.value.a, '7');
});

test('switching cells flushes the previous edit; undo walks both cells', () => {
  const f = fixture(); f.type('a', '12'); f.type('b', '34');
  assert.equal(f.stack.length, 1); f.undo(); assert.deepEqual(f.value, { a: '12', b: '8' });
  f.undo(); assert.deepEqual(f.value, { a: '7', b: '8' });
});

test('flush commits dropdowns and revisiting the same cell starts another unit', () => {
  const f = fixture(); f.type('a', 'first'); assert.equal(f.history.flush('Dropdown'), true);
  f.type('a', 'second'); f.history.flush(); assert.equal(f.stack.length, 2);
  assert.equal(f.stack[0].label, 'Dropdown'); f.undo(); assert.equal(f.value.a, 'first');
  f.undo(); assert.equal(f.value.a, '7');
});

test('no-op focus, reverted typing and repeated flush do not consume history', () => {
  const f = fixture(); f.history.begin('a'); assert.equal(f.history.flush(), false);
  f.type('a', '12'); f.type('a', '7'); assert.equal(f.history.flush(), false);
  assert.equal(f.history.flush(), false); assert.equal(f.history.undo(() => undefined), undefined);
  f.type('b', '9'); f.history.flush(); f.history.begin('a'); f.undo();
  assert.equal(f.value.b, '8'); assert.equal(f.stack.length, 0);
});

test('explicit paste/bulk snapshot stays separate from the preceding cell edit', () => {
  const f = fixture(); f.type('a', '12'); f.history.flush();
  const before = JSON.parse(JSON.stringify(f.value)); f.value.a = '99'; f.value.b = '99';
  f.stack.push({ before, label: 'Paste' }); f.undo();
  assert.deepEqual(f.value, { a: '12', b: '8' }); f.undo(); assert.equal(f.value.a, '7');
});

test('session reload preserves active baseline and older committed history', () => {
  const f = fixture(); f.type('b', '20'); f.history.flush(); f.type('a', '123');
  const reloaded = fixture(f.save()); reloaded.undo();
  assert.deepEqual(reloaded.value, { a: '7', b: '20' }); reloaded.undo();
  assert.deepEqual(reloaded.value, { a: '7', b: '8' });
});

test('exportState is detached; reset discards stale active state after save/cancel', () => {
  const f = fixture(); f.type('a', '12'); const state = f.history.exportState();
  state.before.a = 'corrupt'; f.undo(); assert.equal(f.value.a, '7');
  f.type('a', '13'); f.history.reset(); assert.equal(f.history.flush(), false);
  assert.equal(f.history.exportState(), null);
});

test('browser global exports the same create API without DOM or backend hooks', () => {
  const context = {}; vm.runInNewContext(fs.readFileSync(__dirname + '/purchase-draft-history.js', 'utf8'), context);
  assert.equal(typeof context.PurchaseDraftHistory.create, 'function');
});
