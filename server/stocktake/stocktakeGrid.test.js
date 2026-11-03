'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EDIT_COLUMNS, parseClipboard, planPaste, planFill, moveIndex } = require('../public/stocktake/stocktakeGrid');
const { PASTE_COLUMNS } = require('../public/stocktake/stocktakePaste');

test('EDIT_COLUMNS: 9 cot, deu la cot dan hop le', () => {
  assert.equal(Object.keys(EDIT_COLUMNS).length, 9);
  for (const column of Object.values(EDIT_COLUMNS)) assert.ok(PASTE_COLUMNS[column], column);
});

test('parseClipboard: tab / xuong dong, CRLF, dong trong cuoi, o boc ngoac kep', () => {
  assert.deepEqual(parseClipboard('a\tb\r\nc\td\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseClipboard('mot'), [['mot']]);
  assert.deepEqual(parseClipboard(''), []);
  assert.deepEqual(parseClipboard('"dong 1\ndong 2"\tx\n"co ""ngoac"""\ty'), [['dong 1 dong 2', 'x'], ['co "ngoac"', 'y']]);
  assert.deepEqual(parseClipboard('a\t\tc'), [['a', '', 'c']]);
});

test('planPaste: khoi tu o tren-trai, bo cot an, bo dong vuot cuoi', () => {
  const rect = { top: 3, bottom: 3, left: 6, right: 6 };
  const targets = planPaste([['x', 'y', 'z'], ['p', 'q', 'r']], rect, { rowCount: 5, visibleCols: [0, 1, 6, 8, 9] });
  assert.deepEqual(targets, [
    { row: 3, col: 6, raw: 'x' }, { row: 3, col: 8, raw: 'y' }, { row: 3, col: 9, raw: 'z' },
    { row: 4, col: 6, raw: 'p' }, { row: 4, col: 8, raw: 'q' }, { row: 4, col: 9, raw: 'r' }
  ]);
  assert.deepEqual(planPaste([['a'], ['b'], ['c']], { top: 4, bottom: 4, left: 6, right: 6 }, { rowCount: 5, visibleCols: [6] }), [{ row: 4, col: 6, raw: 'a' }]);
  assert.deepEqual(planPaste([['a', 'b']], { top: 0, bottom: 0, left: 9, right: 9 }, { rowCount: 5, visibleCols: [6, 9] }), [{ row: 0, col: 9, raw: 'a' }]);
  assert.deepEqual(planPaste([], rect, { rowCount: 5, visibleCols: [6] }), []);
});

test('planPaste: 1 o vao vung nhieu o thi dien ca vung (bo cot an)', () => {
  const targets = planPaste([['ok']], { top: 1, bottom: 2, left: 6, right: 8 }, { rowCount: 10, visibleCols: [6, 8] });
  assert.deepEqual(targets, [{ row: 1, col: 6, raw: 'ok' }, { row: 1, col: 8, raw: 'ok' }, { row: 2, col: 6, raw: 'ok' }, { row: 2, col: 8, raw: 'ok' }]);
});

test('planFill: keo xuong / len lap mau theo vong, giu cot', () => {
  const rect = { top: 2, bottom: 3, left: 6, right: 6 };
  assert.deepEqual(planFill(rect, 6, [6]), [
    { row: 4, col: 6, fromRow: 2 }, { row: 5, col: 6, fromRow: 3 }, { row: 6, col: 6, fromRow: 2 }
  ]);
  assert.deepEqual(planFill(rect, 0, [6]), [{ row: 1, col: 6, fromRow: 3 }, { row: 0, col: 6, fromRow: 2 }]);
  assert.deepEqual(planFill(rect, 3, [6]), []);
  assert.deepEqual(planFill({ top: 0, bottom: 0, left: 6, right: 8 }, 1, [6, 8]), [{ row: 1, col: 6, fromRow: 0 }, { row: 1, col: 8, fromRow: 0 }]);
});

test('moveIndex: di trong cot dang hien, kep hai dau', () => {
  assert.equal(moveIndex([0, 1, 6, 8], 1, 1), 6);
  assert.equal(moveIndex([0, 1, 6, 8], 8, 1), 8);
  assert.equal(moveIndex([0, 1, 6, 8], 0, -1), 0);
  assert.equal(moveIndex([0, 1, 6, 8], 7, 1), 8, 'cot hien tai bi an: lay cot hien gan nhat ben phai');
  assert.equal(moveIndex([0, 1, 6, 8], 7, -1), 6);
});
