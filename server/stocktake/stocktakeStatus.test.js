'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Status = require('../public/stocktake/stocktakeStatus');

test('7 loai dung thu tu, ten theo co so, mau co dinh', () => {
  assert.deepEqual(Status.STATUS_TYPES.map(t => t.key), ['lost', 'previous', 'ok', 'wrong', 'surplus', 'mixed', 'pending']);
  assert.deepEqual(Status.optionsFor('hanoi').map(o => o.label), ['Mất', 'KK trước', 'OK', 'Nhầm SG', 'Thừa', 'Lẫn', 'Chưa XL']);
  assert.deepEqual(Status.optionsFor('saigon').map(o => o.label), ['Mất', 'KK trước', 'OK', 'Nhầm HN', 'Thừa', 'Lẫn', 'Chưa XL']);
  assert.deepEqual(Status.optionsFor('hanoi').map(o => o.color), ['#F87171', '#C8963E', '#EEFF41', '#C4B5FD', '#F9A8D4', '#67E8F9', '#FFFFFF']);
  assert.equal(Status.labelFor('other', 'hanoi'), 'Khác');
  assert.equal(Status.labelFor('bogus', 'hanoi'), '');
});

test('classify: ten chuan, chu cu T10 theo tu khoa som nhat, trong = Chua XL, khong khop = Khac', () => {
  const cases = {
    '': 'pending', '   ': 'pending', 'Chưa XL': 'pending', 'chua xl': 'pending',
    'Mất': 'lost', 'KK trước': 'previous', 'OK': 'ok', 'ok': 'ok', 'Nhầm SG': 'wrong', 'Nhầm HN': 'wrong', 'Thừa': 'surplus', 'Lẫn': 'mixed',
    'lẫn bình giữ nhiệt': 'mixed', 'Lẫn+kk trước': 'mixed', 'KK trước + lẫn': 'previous', 'đã kiểm lại thừa': 'surplus',
    'mất ko thấy': 'lost', 'Mất do thẻ kho xuất sai': 'lost', 'Nhầm SG + KK': 'wrong', 'xác nhận thừa đã có ảnh': 'surplus',
    'LẪN HỘP CƠM': 'mixed', 'KK Trước': 'previous', 'Lẻ': 'other', 'tìm thấy': 'other',
    'Thiếu': 'lost', 'thiếu 2 cái': 'lost', 'KK': 'previous'
  };
  for (const [text, key] of Object.entries(cases)) assert.equal(Status.classify(text), key, JSON.stringify(text));
  assert.equal(Status.classify(null), 'pending');
});

test('canonical / isValid: ten chuan theo co so, Chua XL -> trong, Khac -> null', () => {
  assert.equal(Status.canonical('lẫn bình giữ nhiệt', 'hanoi'), 'Lẫn');
  assert.equal(Status.canonical('nhầm sg', 'saigon'), 'Nhầm HN');
  assert.equal(Status.canonical('Nhầm HN', 'hanoi'), 'Nhầm SG');
  assert.equal(Status.canonical('Thiếu', 'saigon'), 'Mất');
  assert.equal(Status.canonical('Chưa XL', 'hanoi'), '');
  assert.equal(Status.canonical('', 'hanoi'), '');
  assert.equal(Status.canonical('Lẻ', 'hanoi'), null);
  assert.equal(Status.isValid('Lẫn', 'hanoi'), true);
  assert.equal(Status.isValid('', 'hanoi'), true);
  assert.equal(Status.isValid('lẫn', 'hanoi'), false);
  assert.equal(Status.isValid('Nhầm HN', 'hanoi'), false);
  assert.equal(Status.isValid('Nhầm HN', 'saigon'), true);
  assert.equal(Status.isValid('Chưa XL', 'hanoi'), false);
});

test('colorOf: mau theo loai, Chua XL / Khac khong to', () => {
  assert.equal(Status.colorOf('mất ko thấy'), '#F87171');
  assert.equal(Status.colorOf('Lẫn'), '#67E8F9');
  assert.equal(Status.colorOf(''), '');
  assert.equal(Status.colorOf('Lẻ'), '');
});

test('summarize: du 7 loai, Khac chi khi co, cong co dau, dong khong note = Chua XL', () => {
  const rows = [
    { note: { statusText: 'Mất' }, diffValue: -1000 },
    { note: { statusText: 'mất ko thấy' }, diffValue: -500 },
    { note: { statusText: 'Thừa' }, diffValue: 300 },
    { note: null, diffValue: 20 },
    { note: { statusText: '' }, diffValue: -5 }
  ];
  const totals = Status.summarize(rows);
  assert.deepEqual([...totals.keys()], ['lost', 'previous', 'ok', 'wrong', 'surplus', 'mixed', 'pending']);
  assert.deepEqual(totals.get('lost'), { count: 2, diffValue: -1500 });
  assert.deepEqual(totals.get('surplus'), { count: 1, diffValue: 300 });
  assert.deepEqual(totals.get('pending'), { count: 2, diffValue: 15 });
  assert.deepEqual(totals.get('ok'), { count: 0, diffValue: 0 });
  const withOther = Status.summarize([...rows, { note: { statusText: 'Lẻ' }, diffValue: 7 }]);
  assert.deepEqual([...withOther.keys()].at(-1), 'other');
  assert.deepEqual(withOther.get('other'), { count: 1, diffValue: 7 });
});
