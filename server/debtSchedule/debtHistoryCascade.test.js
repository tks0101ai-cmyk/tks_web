'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyStatusEdit, dayPenalty } = require('./debtHistoryCascade');

const day = (cycleDate, overdue, streak, status = 'Chưa xử lý') => ({ cycleDate, overdue, streak, status });

// Khach no cham 500k suot 5 ngay, chua xu ly: phien 1..5 -> 25k, 25k, 50k, 100k, 150k.
const FIVE_DAYS = [
  day('2026-10-28', 500000, 1), day('2026-10-29', 500000, 2), day('2026-10-30', 500000, 3),
  day('2026-10-31', 500000, 4), day('2026-11-01', 500000, 5)
];

test('Da xu ly o ngay giua: ngay do het phat, ngay sau reset ve phien 1 va cac ngay tiep dem lai', () => {
  const result = applyStatusEdit(FIVE_DAYS, 2, 'Đã xử lý');
  assert.deepEqual(result.map(r => r.streak), [3, 1, 2]);
  assert.deepEqual(result.map(r => r.penalty), [0, 25000, 25000]);
  assert.deepEqual(result.map(r => r.statusChanged), [true, false, false]);
  assert.deepEqual(result.map(r => r.streakChanged), [false, true, true]);
});

test('Bo qua giu nguyen chuoi phien va tien phat cac ngay sau', () => {
  const result = applyStatusEdit(FIVE_DAYS, 1, 'Bỏ qua');
  assert.deepEqual(result.map(r => r.streak), [2, 3, 4, 5]);
  assert.deepEqual(result.map(r => r.penalty), [25000, 50000, 100000, 150000]);
  assert.deepEqual(result.map(r => r.streakChanged), [false, false, false, false]);
});

test('doi Da xu ly ve Chua xu ly: chuoi noi lai theo phien truoc', () => {
  const days = [day('a', 500000, 1), day('b', 500000, 3, 'Đã xử lý'), day('c', 500000, 1), day('d', 500000, 2)];
  const result = applyStatusEdit(days, 1, 'Chưa xử lý');
  assert.deepEqual(result.map(r => r.streak), [3, 4, 5]);
  assert.equal(result[0].penalty, 50000);
});

test('ngay sau co no le (< 400k) luon phien 0 va phat 25k; khong qua han thi khong phat', () => {
  const days = [day('a', 500000, 1), day('b', 100000, 0), day('c', 0, 0)];
  const result = applyStatusEdit(days, 0, 'Đã xử lý');
  assert.deepEqual(result.map(r => r.streak), [1, 0, 0]);
  assert.deepEqual(result.map(r => r.penalty), [0, 25000, 0]);
});

test('ngay khach khong co dong ban chot cat chuoi', () => {
  const days = [day('a', 500000, 1), null, day('c', 500000, 1), day('d', 500000, 2)];
  const result = applyStatusEdit(days, 0, 'Bỏ qua');
  assert.equal(result[1], null);
  assert.deepEqual([result[2].streak, result[3].streak], [1, 2]);
});

test('chay lai tren ket qua cho cung ket qua, ngay truoc ngay sua khong bi tra ve', () => {
  const first = applyStatusEdit(FIVE_DAYS, 2, 'Đã xử lý');
  const reapplied = FIVE_DAYS.map((d, i) => (i < 2 ? d : { ...d, streak: first[i - 2].streak, status: first[i - 2].status }));
  const second = applyStatusEdit(reapplied, 2, 'Đã xử lý');
  assert.deepEqual(second.map(r => r.streak), first.map(r => r.streak));
  assert.ok(second.every(r => !r.streakChanged && !r.statusChanged));
  assert.equal(first.length, 3);
});

test('dayPenalty: Da xu ly = 0 ke ca khi qua han lon', () => {
  assert.equal(dayPenalty(9000000, 9, 'Đã xử lý'), 0);
  assert.equal(dayPenalty(9000000, 9, 'Chưa xử lý'), 200000);
});

test('ngay sua khong co dong thi bao loi', () => {
  assert.throws(() => applyStatusEdit([null], 0, 'Đã xử lý'));
});
