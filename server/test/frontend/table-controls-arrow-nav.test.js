'use strict';
// Điều hướng bằng phím mũi tên giữa các ô nhập trong bảng (shared/table-controls.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const source = fs.readFileSync(path.join(__dirname, '../../public/shared/table-controls.js'), 'utf8');

async function setup(t, body) {
  const dom = new JSDOM('<!doctype html><body><table data-table-key="nav"><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody>' + body + '</tbody></table></body>',
    { url: 'https://tables.test/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const { window } = dom;
  // jsdom không tính bố cục nên offsetParent luôn null; coi ô "thấy được" khi có parentNode.
  Object.defineProperty(window.HTMLElement.prototype, 'offsetParent', { get() { return this.parentNode; }, configurable: true });
  window.eval(source);
  if (window.document.readyState === 'loading') window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
  const doc = window.document;
  const press = (el, key, init = {}) => {
    const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(event);
    return event;
  };
  return { window, doc, press, $: id => doc.getElementById(id) };
}
const text = (id, v = 'abc') => '<td><input id="' + id + '" type="text" value="' + v + '"></td>';
const rows = (...r) => r.map(c => '<tr>' + c.join('') + '</tr>').join('');

test('ArrowDown/ArrowUp jump to same column in adjacent row, skipping rows without an input', async t => {
  const { doc, press, $ } = await setup(t, rows([text('a1'), text('b1')], ['<td>x</td>', '<td>y</td>'], [text('a3'), text('b3')]));
  $('b1').focus();
  const down = press($('b1'), 'ArrowDown');
  assert.equal(down.defaultPrevented, true);
  assert.equal(doc.activeElement, $('b3'));
  const up = press($('b3'), 'ArrowUp');
  assert.equal(up.defaultPrevented, true);
  assert.equal(doc.activeElement, $('b1'));
});

test('ArrowRight/ArrowLeft move only when the caret is at the edge', async t => {
  const { doc, press, $ } = await setup(t, rows([text('a'), text('b')]));
  $('a').focus();
  $('a').setSelectionRange(1, 1);
  assert.equal(press($('a'), 'ArrowRight').defaultPrevented, false);
  assert.equal(doc.activeElement, $('a'));
  $('a').setSelectionRange(3, 3);
  assert.equal(press($('a'), 'ArrowRight').defaultPrevented, true);
  assert.equal(doc.activeElement, $('b'));
  $('b').setSelectionRange(2, 2);
  assert.equal(press($('b'), 'ArrowLeft').defaultPrevented, false);
  assert.equal(doc.activeElement, $('b'));
  $('b').setSelectionRange(0, 0);
  assert.equal(press($('b'), 'ArrowLeft').defaultPrevented, true);
  assert.equal(doc.activeElement, $('a'));
});

test('type=number ArrowUp/ArrowDown still change cell', async t => {
  const num = id => '<td><input id="' + id + '" type="number" value="5"></td>';
  const { doc, press, $ } = await setup(t, rows([num('n1')], [num('n2')]));
  $('n1').focus();
  assert.equal(press($('n1'), 'ArrowDown').defaultPrevented, true);
  assert.equal(doc.activeElement, $('n2'));
  assert.equal(press($('n2'), 'ArrowUp').defaultPrevented, true);
  assert.equal(doc.activeElement, $('n1'));
});

test('textarea ArrowDown/ArrowUp change cell only at end/start of text', async t => {
  const area = (id, v) => '<td><textarea id="' + id + '">' + v + '</textarea></td>';
  const { doc, press, $ } = await setup(t, rows([area('t1', 'ab\ncd')], [area('t2', 'ef')]));
  $('t1').focus();
  $('t1').setSelectionRange(1, 1);
  assert.equal(press($('t1'), 'ArrowDown').defaultPrevented, false);
  assert.equal(doc.activeElement, $('t1'));
  $('t1').setSelectionRange(5, 5);
  assert.equal(press($('t1'), 'ArrowDown').defaultPrevented, true);
  assert.equal(doc.activeElement, $('t2'));
  $('t2').setSelectionRange(1, 1);
  assert.equal(press($('t2'), 'ArrowUp').defaultPrevented, false);
  $('t2').setSelectionRange(0, 0);
  assert.equal(press($('t2'), 'ArrowUp').defaultPrevented, true);
  assert.equal(doc.activeElement, $('t1'));
});

test('select, readOnly, disabled targets and neighbours are ignored', async t => {
  const { doc, press, $ } = await setup(t, rows(
    ['<td><select id="s"><option>1</option></select></td>', text('b1')],
    [text('a2'), '<td><input id="ro" readonly value="x"></td>'],
    [text('a3'), '<td><input id="dis" disabled value="x"></td>'],
    [text('a4'), text('b4')]
  ));
  $('s').focus();
  assert.equal(press($('s'), 'ArrowDown').defaultPrevented, false);
  // Ô kề readOnly/disabled bị bỏ qua: từ b1 xuống b4.
  $('b1').focus();
  assert.equal(press($('b1'), 'ArrowDown').defaultPrevented, true);
  assert.equal(doc.activeElement, $('b4'));
  // Nguồn readOnly / disabled không điều hướng.
  assert.equal(press($('ro'), 'ArrowDown').defaultPrevented, false);
  assert.equal(press($('dis'), 'ArrowUp').defaultPrevented, false);
});

test('already-prevented events and modified keys are left alone', async t => {
  const { doc, window, $ } = await setup(t, rows([text('a1')], [text('a2')]));
  $('a1').addEventListener('keydown', e => e.preventDefault());
  $('a1').focus();
  $('a1').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
  assert.equal(doc.activeElement, $('a1'));
  const plain = await setup(t, rows([text('b1')], [text('b2')]));
  plain.$('b1').focus();
  const shifted = plain.press(plain.$('b1'), 'ArrowDown', { shiftKey: true });
  assert.equal(shifted.defaultPrevented, false);
  assert.equal(plain.doc.activeElement, plain.$('b1'));
});

test('no adjacent cell means no preventDefault', async t => {
  const { press, $ } = await setup(t, rows([text('a1'), text('b1')], [text('a2'), '<td>none</td>']));
  assert.equal(press($('a1'), 'ArrowUp').defaultPrevented, false);
  assert.equal(press($('b1'), 'ArrowDown').defaultPrevented, false);
  $('b1').setSelectionRange(3, 3);
  assert.equal(press($('b1'), 'ArrowRight').defaultPrevented, false);
  $('a1').setSelectionRange(0, 0);
  assert.equal(press($('a1'), 'ArrowLeft').defaultPrevented, false);
});
