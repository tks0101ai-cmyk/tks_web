const test = require('node:test');
const assert = require('node:assert/strict');
const fz = require('./fuzzy-search');

test('combo 100 set khớp combo set', () => {
  assert.ok(fz.matches('Combo 100 Set quà tặng', 'combo 100 set'));
  assert.ok(!fz.matches('Combo Set quà tặng', 'combo 100 set'));
  assert.ok(fz.matches('Combo Set quà tặng', 'combo 100 set'.replace(' 100', '')));
});
test('một từ phải khớp; hai từ phải khớp cả hai', () => {
  assert.ok(!fz.matches('abc', 'xyz'));
  assert.ok(!fz.matches('combo', 'combo set'));
});
test('bỏ dấu và đ', () => {
  assert.ok(fz.matches('Đường Hà Nội', 'duong ha noi'));
});
test('xếp khớp nhiều từ và nguyên cụm lên trước', () => {
  const out = fz.filter(['combo xyz set', 'set combo 100', 'combo 100 set'], 'combo 100 set');
  assert.equal(out[0], 'combo 100 set');
  assert.equal(out.length, 2);
});
test('phải chứa MỌI từ khóa, không còn ngưỡng 80%', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 10].map(fz.requiredMatches), [1, 2, 3, 4, 5, 6, 10]);
  assert.ok(!fz.matches('HN C Trạng Đại Mỗ', 'HN C Hạnh Hạ Mỗ'));
  assert.ok(fz.matches('HN C Hạnh Hạ Mỗ', 'HN C Hạnh Hạ Mỗ'));
  assert.ok(!fz.matches('a b c d e', 'a b c d e zzz'));
  assert.ok(fz.matches('e d c b a', 'a b c d e'), 'khớp mọi từ, không cần đúng thứ tự');
});
test('ô trống trả toàn bộ', () => {
  assert.deepEqual(fz.filter(['a', 'b'], '  '), ['a', 'b']);
});

test('từ khóa có dấu phải khớp đúng dấu; không dấu khớp tự do', () => {
  assert.ok(fz.matches('HN A Khả Hân Ba Vì', 'khả hân'));
  assert.ok(!fz.matches('HN A Khanh Dương Nội', 'khả hân'));
  assert.ok(!fz.matches('HN C Hạnh Chip Mê Linh Khách mới', 'khả hân'));
  assert.ok(!fz.matches('HN A Khả Hạnh', 'khả hân'));
  assert.ok(fz.matches('HN A Khả Hân Ba Vì', 'kha han'));
  assert.ok(fz.matches('HN A Khả Hân Ba Vì', 'KHẢ  HÂN'));
  assert.ok(fz.matches('Đường Hà Nội', 'đường'));
  assert.ok(!fz.matches('Duong Ha Noi', 'đường'));
  assert.deepEqual(fz.filter(['Khanh Dương', 'Khả Hân', 'Hân Khả'], 'khả hân'), ['Khả Hân', 'Hân Khả']);
});
