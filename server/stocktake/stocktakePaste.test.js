'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVnNumber, parseComboFlag, foldName, parsePasteText, normalizeValue, PASTE_COLUMNS } = require('../public/stocktake/stocktakePaste');

test('parseVnNumber: kieu VN, kieu thuong, rong / chu', () => {
  assert.equal(parseVnNumber('1.234'), 1234);
  assert.equal(parseVnNumber('-1.234.567'), -1234567);
  assert.equal(parseVnNumber('-1,5'), -1.5);
  assert.equal(parseVnNumber('1,900'), 1900, 'phay + dung 3 so = nghin (Sheet kieu My)');
  assert.equal(parseVnNumber('-1,234'), -1234);
  assert.equal(parseVnNumber('1,234,567'), 1234567);
  assert.equal(parseVnNumber('12,25'), 12.25);
  assert.equal(parseVnNumber('1234'), 1234);
  assert.equal(parseVnNumber('12.5'), 12.5, 'mot dau cham, khong du 3 so sau -> thap phan');
  assert.equal(parseVnNumber(' -326 '), -326);
  assert.equal(parseVnNumber(42), 42);
  assert.equal(parseVnNumber(''), null);
  assert.equal(parseVnNumber('abc'), null);
  assert.equal(parseVnNumber('#DIV/0!'), null);
});

test('parseComboFlag + foldName', () => {
  for (const yes of ['x', 'X', 'TRUE', 'true', '1', 'có', 'Co']) assert.equal(parseComboFlag(yes), true, yes);
  for (const no of ['', '0', 'false', 'không']) assert.equal(parseComboFlag(no), false, no);
  assert.equal(foldName('  Thái   KHO '), 'thai kho');
  assert.equal(foldName('Đông'), 'dong');
});

test('parsePasteText: tab, bo tieu de, bo dong trong, ma lap lay dong cuoi', () => {
  const known = new Set(['LUMI3M', 'LUMI3T']);
  const text = 'Mã SP\tKK Trước Sai\r\nlumi3m\t-326\n\n LUMI3T \t-170\nLUMI3M\t-300\n';
  const { rows, duplicates } = parsePasteText(text, { isKnownCode: code => known.has(code), column: 'prevDiffManual' });
  assert.deepEqual(rows, [{ code: 'LUMI3T', value: '-170' }, { code: 'LUMI3M', value: '-300' }]);
  assert.equal(duplicates, 1);
});

test('parsePasteText: dong dau la du lieu that thi giu', () => {
  const { rows } = parsePasteText('LUMI3M\tmất ko thấy', { isKnownCode: () => true, column: 'statusText' });
  assert.deepEqual(rows, [{ code: 'LUMI3M', value: 'mất ko thấy' }]);
});

test('parsePasteText: dong tieu de sau dong trong van bi bo', () => {
  const { rows } = parsePasteText('\nMã SP\tKK\nA\t5', { isKnownCode: code => code === 'A', column: 'prevDiffManual' });
  assert.deepEqual(rows, [{ code: 'A', value: '5' }]);
});

test('parsePasteText: tieu de cot chu bi bo, dong du lieu giu', () => {
  const { rows } = parsePasteText('Mã SP\tTrạng thái\nLUMI3M\tOK', { isKnownCode: code => code === 'LUMI3M', column: 'statusText' });
  assert.deepEqual(rows, [{ code: 'LUMI3M', value: 'OK' }]);
});

test('normalizeValue theo kieu cot', () => {
  assert.deepEqual(normalizeValue('prevDiffManual', '-1.234'), { ok: true, value: -1234, empty: false });
  assert.deepEqual(normalizeValue('prevDiffManual', ''), { ok: true, value: null, empty: true });
  assert.deepEqual(normalizeValue('prevDiffManual', 'abc'), { ok: false });
  assert.deepEqual(normalizeValue('combo', 'x'), { ok: true, value: true, empty: false });
  assert.deepEqual(normalizeValue('combo', ''), { ok: true, value: false, empty: true });
  assert.deepEqual(normalizeValue('printPage', 'a'.repeat(51)), { ok: false });
  assert.deepEqual(normalizeValue('statusText', '  ok  '), { ok: true, value: 'ok', empty: false });
  assert.deepEqual(normalizeValue('recheck', 'THÁI KHO'), { ok: true, value: 'THÁI KHO', empty: false });
  assert.equal(PASTE_COLUMNS.reasonText.max, 1000);
});

test('STATUS_COLORS: bang mau trang thai dung chung', () => {
  const { STATUS_COLORS } = require('../public/stocktake/stocktakePaste');
  assert.deepEqual(Object.keys(STATUS_COLORS), ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'gray']);
  assert.equal(STATUS_COLORS.red.label, 'Đỏ');
  assert.match(STATUS_COLORS.red.argb, /^FF[0-9A-F]{6}$/);
});
