'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeText, normalizeCode, buildIndex, search, FUZZY_LIMIT } = require('../public/stocktake/stocktakeSearch');
const FuseModule = require('../public/vendor/fuse.min.js');
const Fuse = FuseModule.default || FuseModule;

const item = (code, name, extra = '') => ({ row: { code }, code, name, extra });
const codes = result => result.rows.map(row => row.code);

test('chuan hoa giong tra-cuu-vi-tri: bo dau, tach so khoi chu, bo ky tu la', () => {
  assert.equal(normalizeText('Băng keo chống thấm 20cm (T9) (10KG)'), 'bang keo chong tham 20 cm t 9 10 kg');
  assert.equal(normalizeText('  Đèn LED-12V  '), 'den led 12 v');
  assert.equal(normalizeCode(' bk-20 '), 'bk20');
  assert.equal(normalizeCode('Đ.10'), 'd10');
});

test('"băng keo 10kg" chi ra hang 10KG (ten that), khong 11KG/19KG/15.5KG, khong ket qua mo', () => {
  const index = buildIndex([
    item('B10', 'Băng keo chống thấm 15cm (T12) (10KG)'),
    item('B10T', 'Băng keo chống thấm 20cm (Thùng 9 cuộn) (10kg/thùng)'),
    item('B11', 'Băng keo chống thấm 10cm (T18) (11KG)'),
    item('B19', 'Băng keo chống thấm X2000 10cm (T18) - 19KG'),
    item('B155', 'Băng keo X2000 size 10cm (Thùng 18 cuộN/15.5KG) (OD)'),
    item('O10', 'Ổ điện VÀNG 4 Ổ 10m')
  ], { Fuse });
  const result = search(index, 'băng keo 10kg');
  assert.deepEqual(codes(result), ['B10', 'B10T']);
  assert.equal(result.fuzzy, false);
  assert.deepEqual(codes(search(index, 'BANG KEO 10KG')), ['B10', 'B10T']);
});

test('so khop tron so, chu cuoi duoc la tien to tu, cum go lien phai lien', () => {
  const index = buildIndex([item('C10', 'Cuộn 10m'), item('C100', 'Cuộn 100m'), item('BK', 'Băng keo'), item('KG', 'Thùng 10 cái 5kg')]);
  assert.deepEqual(codes(search(index, 'cuộn 10')), ['C10']);
  assert.deepEqual(codes(search(index, 'bang ke')), ['BK']);
  assert.deepEqual(codes(search(index, '10kg')), [], '"10" va "kg" khong dung lien');
  assert.deepEqual(codes(search(index, '10 kg')), ['KG'], 'go tach thi moi tu khop rieng');
});

test('thu tu muc khop 1-7 nhu tool', () => {
  const index = buildIndex([
    item('ZZ1', 'Có chứa bk10 ở giữa'),   // 6: ten chua nguyen cum (bk 10)
    item('XBK10', 'Hàng X'),              // 5: ma chua
    item('BK10A', 'Hàng A'),              // 3: ma bat dau bang
    item('Q1', 'bk10 đầu tên'),           // 4: ten bat dau bang
    item('BK10', 'Hàng gốc'),             // 1: ma khop dung
    item('Q2', 'bk 10'),                  // 2: ten khop dung
    item('Q3', 'Hàng', 'cụm ghi chú bk10') // 7: du moi cum trong ten + phu
  ]);
  assert.deepEqual(codes(search(index, 'bk10')), ['BK10', 'Q2', 'BK10A', 'Q1', 'XBK10', 'ZZ1', 'Q3']);
});

test('khop chac chan khong bi cat; co ket qua khop thi khong them ket qua mo', () => {
  const many = Array.from({ length: 150 }, (_, i) => item('K' + i, 'Keo dán số ' + i));
  const result = search(buildIndex(many, { Fuse }), 'keo');
  assert.equal(result.rows.length, 150);
  assert.equal(result.fuzzy, false);

  const few = [item('B1', 'Băng keo loại 1'), item('T1', 'Bnag keoo 1')];
  assert.deepEqual(codes(search(buildIndex(few, { Fuse }), 'bang keo')), ['B1']);
});

test('khong co ma khop: Fuse bu toi da FUZZY_LIMIT va bao fuzzy; khong co Fuse thi rong', () => {
  const rows = [item('BK20', 'Băng keo chống thấm'), item('DN1', 'Đèn ngủ')];
  const fuzzy = search(buildIndex(rows, { Fuse }), 'bang keoo');
  assert.deepEqual(codes(fuzzy), ['BK20']);
  assert.equal(fuzzy.fuzzy, true);
  assert.deepEqual(search(buildIndex(rows), 'bang keoo'), { rows: [], fuzzy: false });
  const typos = Array.from({ length: 150 }, (_, i) => item('T' + i, 'Bnag keoo ' + i));
  assert.equal(search(buildIndex(typos, { Fuse }), 'bang keo').rows.length, FUZZY_LIMIT);
});

test('tu khoa rong: tra moi dong theo thu tu dua vao', () => {
  const index = buildIndex([item('A', 'a'), item('B', 'b')], { Fuse });
  assert.deepEqual(search(index, '   '), { rows: [{ code: 'A' }, { code: 'B' }], fuzzy: false });
});
