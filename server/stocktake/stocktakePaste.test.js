'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVnNumber, parseComboFlag, foldName, normalizeValue, PASTE_COLUMNS } = require('../public/stocktake/stocktakePaste');

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

test('STATUS_COLORS da bo: mau trang thai tinh theo loai (stocktakeStatus.js)', () => {
  assert.equal('STATUS_COLORS' in require('../public/stocktake/stocktakePaste'), false);
});

test('columnValue / sameValue / rawOf: dang gia tri cot dung chung trinh duyet + server', () => {
  const { columnValue, sameValue, rawOf } = require('../public/stocktake/stocktakePaste');
  const note = { statusText: 'mất', reasonText: '', printPage: '12', printTime: '', recheckEmployeeId: 502, recheckName: '', prevDiffManual: -1234, otherDiffManual: null };
  const nameOf = id => (id === 502 ? 'Thái Kho' : '');
  assert.equal(columnValue('statusText', note, null, nameOf), 'mất');
  assert.equal(columnValue('reasonText', null, null, nameOf), '');
  assert.equal(columnValue('recheck', note, null, nameOf), 'Thái Kho');
  assert.equal(columnValue('recheck', { recheckEmployeeId: null, recheckName: 'CẬN' }, null, nameOf), 'CẬN');
  assert.equal(columnValue('prevDiffManual', note, null, nameOf), -1234);
  assert.equal(columnValue('otherDiffManual', note, null, nameOf), null);
  assert.equal(columnValue('otherDiffManual', null, null, nameOf), null);
  assert.equal(columnValue('cluster', null, { cluster: 'Cụm 1', isCombo: true }, nameOf), 'Cụm 1');
  assert.equal(columnValue('combo', null, { cluster: '', isCombo: true }, nameOf), true);
  assert.equal(columnValue('combo', null, null, nameOf), false);

  assert.equal(sameValue('statusText', ' mất  ', 'mất'), true);
  assert.equal(sameValue('recheck', 'thai kho', 'Thái Kho'), true);
  assert.equal(sameValue('prevDiffManual', null, undefined), true);
  assert.equal(sameValue('prevDiffManual', 0, null), false);
  assert.equal(sameValue('combo', false, ''), true);
  assert.equal(sameValue('bogus', 'a', 'a'), false);

  assert.equal(rawOf('combo', true), 'x');
  assert.equal(rawOf('combo', false), '');
  assert.equal(rawOf('prevDiffManual', null), '');
  assert.equal(rawOf('prevDiffManual', 1.234), 1.234);
  assert.equal(rawOf('statusText', 'mất'), 'mất');
});

test('normalizeValue: so that cho cot so khong qua parseVnNumber', () => {
  assert.deepEqual(normalizeValue('prevDiffManual', 1.234), { ok: true, value: 1.234, empty: false });
  assert.deepEqual(normalizeValue('prevDiffManual', '1.234'), { ok: true, value: 1234, empty: false });
  assert.equal(normalizeValue('prevDiffManual', Infinity).ok, false);
  assert.equal(normalizeValue('prevDiffManual', 1e13).ok, false);
});
