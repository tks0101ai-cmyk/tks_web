'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeText, normalizeCode, buildIndex, search, FUZZY_LIMIT } = require('../public/stocktake/stocktakeSearch');
const FuseModule = require('../public/vendor/fuse.min.js');
const Fuse = FuseModule.default || FuseModule;

const item = (code, name, extra = '') => ({ row: { code }, code, name, extra });
const codes = rows => rows.map(row => row.code);

test('chuan hoa giong tra-cuu-vi-tri: bo dau, tach so khoi chu, bo ky tu la', () => {
  assert.equal(normalizeText('Băng keo chống thấm 20cm (T9) (10KG)'), 'bang keo chong tham 20 cm t 9 10 kg');
  assert.equal(normalizeText('  Đèn LED-12V  '), 'den led 12 v');
  assert.equal(normalizeCode(' bk-20 '), 'bk20');
  assert.equal(normalizeCode('Đ.10'), 'd10');
});

test('"băng keo 10kg" ra dung san pham du cac tu nam lon xon', () => {
  const index = buildIndex([item('BK20', 'Băng keo chống thấm 20cm (T9) (10KG)'), item('KEO1', 'Keo dán sắt 1kg')], { Fuse });
  assert.equal(search(index, 'băng keo 10kg')[0].code, 'BK20');
  assert.equal(search(index, 'BANG KEO 10 KG')[0].code, 'BK20');
});

test('thu tu muc khop 1-7 nhu tool', () => {
  const index = buildIndex([
    item('ZZ1', 'Có chứa bk10 ở giữa'),   // 6: ten chua nguyen cum (bk 10)
    item('XBK10', 'Hàng X'),              // 5: ma chua
    item('BK10A', 'Hàng A'),              // 3: ma bat dau bang
    item('Q1', 'bk10 đầu tên'),           // 4: ten bat dau bang
    item('BK10', 'Hàng gốc'),             // 1: ma khop dung
    item('Q2', 'bk 10'),                  // 2: ten khop dung
    item('Q3', 'Hàng', 'cụm bk ghi chú 10') // 7: du moi tu trong ten + phu
  ]);
  assert.deepEqual(codes(search(index, 'bk10')), ['BK10', 'Q2', 'BK10A', 'Q1', 'XBK10', 'ZZ1', 'Q3']);
});

test('muc 1-7 khong bi cat 100; Fuse chi bu toi tong 100', () => {
  const many = Array.from({ length: 150 }, (_, i) => item('K' + i, 'Keo dán số ' + i));
  assert.equal(search(buildIndex(many, { Fuse }), 'keo').length, 150);

  const few = Array.from({ length: 98 }, (_, i) => item('B' + i, 'Băng keo loại ' + i));
  const typos = Array.from({ length: 10 }, (_, i) => item('T' + i, 'Bnag keoo ' + i));
  const result = search(buildIndex([...few, ...typos], { Fuse }), 'bang keo');
  assert.equal(result.length, FUZZY_LIMIT);
  assert.deepEqual(codes(result.slice(0, 98)), codes(few.map(x => x.row)));
  assert.ok(result.slice(98).every(row => row.code.startsWith('T')));
});

test('go sai chinh ta: Fuse van ra; khong co Fuse thi chi muc 1-7', () => {
  const rows = [item('BK20', 'Băng keo chống thấm'), item('DN1', 'Đèn ngủ')];
  assert.deepEqual(codes(search(buildIndex(rows, { Fuse }), 'bang keoo')), ['BK20']);
  assert.deepEqual(codes(search(buildIndex(rows), 'bang keoo')), []);
  assert.deepEqual(codes(search(buildIndex(rows), 'bang keo')), ['BK20']);
});

test('tu khoa rong: tra moi dong theo thu tu dua vao', () => {
  const index = buildIndex([item('A', 'a'), item('B', 'b')], { Fuse });
  assert.deepEqual(codes(search(index, '   ')), ['A', 'B']);
});
