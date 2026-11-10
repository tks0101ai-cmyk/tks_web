'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../vatDraft/csv');
const m = require('./lookupModel');
const { parseLookupRecords, isFormulaErrorSheet } = require('./lookupSource');

// Header giong sheet that (23/10/2026): Khớp mã co dong ghi chu phia tren header,
// DK về 2 co cot so luong cuoi khong co ten.
const GOP = [
  'CTY,Mã kiot đại diện,Tên kiot đại diện,MÃ VAT KIOT,TÊN VAT KIOT (giá chưa vat tham khảo),TÊN HÀNG,Đơn vị tính,x,TỒN ĐẦU NGÀY,GIÁ BÁN,THUẾ VAT,THUẾ NK,TỔNG THUẾ MẤT,TỔNG ĐANG NHÁP,TỒN CÓ THỂ NHÁP',
  'TKS THẤP,APTH10,Ấm Hoa,VAT10001,Ấm VAT,Ấm giữ nhiệt 1L,Cái,x,"1,200",100,8%,,8.00%,200,"1,000"',
  'VC,APTH10,Ấm Hoa,VAT10001,Ấm VAT,Ấm giữ nhiệt 1L,Cái,x,300,100,8%,,8.00%,,300',
  'LUCKY,APTH10,Ấm Hoa,VAT10001,Ấm VAT,Ấm giữ nhiệt loại khác,Cái,x,50,100,8%,,10.00%,,XUẤT THẤP',
  'SHC,BDC-PT1B,Bơm đạp,VAT20002,Bơm VAT,Bơm đạp chân,Cái,x,0,100,8%,,8.00%,,0',
  'SHC,ONLYGOP,Chỉ có ở Gộp,VAT30003,X,Hàng gộp,Cái,x,10,1,8%,,8.00%,,10'
].join('\n');
const KHOP = [
  'CHECK TỒN BÊN SHEET VAT,,,,,,,,,,',
  'Mã SP,Tên SP,,,,,,,,MÃ VAT KIOT,TÊN VAT KIOT',
  'APTH10,Ấm giữ nhiệt Hoa 1L,0,,,,,,,VAT10001,Ấm giữ nhiệt 1000ML (VAT)',
  'APTH10-B,Ấm Hoa bản B,0,,,,,,,VAT10001,Ấm giữ nhiệt 1000ML (VAT)',
  'BDC-PT1B,Bơm đạp chân pittong,0,,,,,,,VAT20002,Bơm (VAT)',
  'NOVAT,Hàng chưa có mã VAT,0,,,,,,,,'
].join('\n');
const DKVE = [
  'TRẠNG THÁI,CONT,mã kiot,tên kiot,',
  '1. Đang chờ khai,10-10Y,APTH10,Ấm giữ nhiệt Hoa 1L,800',
  '1. Đang chờ khai,10-10Y,APTH10,Ấm giữ nhiệt Hoa 1L,"1,000"',
  '3. Đã khai,9-1V,APTH10,Ấm giữ nhiệt Hoa 1L,5',
  '4. Đã ký - Chưa nhập Kiot,9-10V,APTH10,Ấm giữ nhiệt Hoa 1L,"2,592"',
  '10. Đã nhập Kiot,8-1V,BDC-PT1B,Bơm đạp chân pittong,10',
  '2. Đang về cảng,BSUNG-1,TALEWS,BÚT NHUỘM TÓC SUAKE (OD),972'
].join('\n');

const model = () => parseLookupRecords({ gop: parseCsv(GOP), khop: parseCsv(KHOP), dkve: parseCsv(DKVE) });

test('rowsToObjects: do dung dong header nam duoi dong ghi chu, cot khong ten thanh "Cột N"', () => {
  const rows = m.rowsToObjects(parseCsv(KHOP), ['ma sp', 'ten sp']);
  assert.equal(rows[0]['Mã SP'], 'APTH10');
  assert.equal(rows[0].__rowNumber, 3);
  assert.deepEqual(m.makeUniqueHeaders(['A', '', 'A']), ['A', 'Cột 2', 'A (2)']);
});

test('parseNumber: phan cach hang nghin, chu -> 0', () => {
  assert.equal(m.parseNumber('1,200'), 1200);
  assert.equal(m.parseNumber('1.234.567'), 1234567);
  assert.equal(m.parseNumber('1,5'), 1.5);
  assert.equal(m.parseNumber('XUẤT THẤP'), 0);
  assert.equal(m.parseNumber(''), 0);
});

test('trang thai: "10." khong bi doc thanh 1; chi 1-3 la chuan bi ve', () => {
  assert.equal(m.parseTrangThaiSo('10. Đã nhập Kiot'), 10);
  assert.equal(m.isChuanBiVe(10), false);
  assert.equal(m.isChuanBiVe(3), true);
  assert.equal(m.trangThaiLabel('1. Đang chờ khai'), 'Đang chờ khai');
});

test('Gộp VAT: cong ton qua cac CTY cung san pham, Ten hang khac thanh dong rieng', () => {
  const result = m.search(model(), ['APTH10']);
  const lines = result.vat.rows.filter(r => r.maKiot === 'APTH10');
  assert.equal(lines.length, 2);
  const main = lines.find(r => r.tenHang === 'Ấm giữ nhiệt 1L');
  assert.deepEqual([main.tonDauNgay, main.tonCoTheNhap, main.tongThueMat, main.conVAT], [1500, 1300, '8.00%', true]);
  const other = lines.find(r => r.tenHang === 'Ấm giữ nhiệt loại khác');
  assert.equal(other.tonCoTheNhap, 0, 'ton la chu -> 0, dong van hien');
});

test('tim kiem: khop ma chinh xac dung dau, san pham chung ma VAT di kem', () => {
  const result = m.search(model(), ['APTH10']);
  assert.equal(result.productCount, 2);
  assert.deepEqual([...new Set(result.vat.rows.map(r => r.maKiot))], ['APTH10', 'APTH10-B']);
});

test('tim theo ten khong dau', () => {
  const result = m.search(model(), ['bom dap chan']);
  assert.equal(result.vat.rows[0].maKiot, 'BDC-PT1B');
  assert.equal(result.vat.rows[0].conVAT, false, 'ton co the nhap = 0 -> Không còn VAT');
});

test('Hàng sắp về: chi trang thai 1-3, gop theo CONT + ma Kiot va cong so luong', () => {
  const result = m.search(model(), ['APTH10']);
  assert.deepEqual(result.incoming.rows.map(r => [r.cont, r.maKiot, r.trangThai, r.soLuong]), [
    ['10-10Y', 'APTH10', 'Đang chờ khai', 1800],
    ['9-1V', 'APTH10', 'Đã khai', 5]
  ]);
  assert.equal(result.vat.rows[0].hasIncoming, true);
});

test('san pham chi co o DK về 2 van tim duoc (loi BÚT NHUỘM TÓC SUAKE 2026-08-19)', () => {
  const result = m.search(model(), ['BÚT NHUỘM TÓC SUAKE']);
  assert.equal(result.productCount, 1);
  assert.deepEqual(result.vat.rows.map(r => [r.maKiot, r.maVat, r.conVAT, r.hasIncoming]), [['TALEWS', '', false, true]]);
  assert.equal(result.incoming.rows[0].cont, 'BSUNG-1');
});

test('khong co dong sap ve: tra danh sach dong DK về 2 de thay ly do', () => {
  const result = m.search(model(), ['BDC-PT1B']);
  assert.equal(result.incoming.total, 0);
  assert.deepEqual(result.incoming.debug, [{ maKiot: 'BDC-PT1B', trangThai: '10. Đã nhập Kiot', rowNumber: 6 }]);
});

test('dan nhieu dong: bo trung, tach ;, bao tu khoa khong tim thay', () => {
  const parsed = m.parseSearchQueries('APTH10\n apth10 ;khongco\n\nBDC-PT1B');
  assert.deepEqual(parsed.queries, ['APTH10', 'khongco', 'BDC-PT1B']);
  const result = m.search(model(), parsed.queries);
  assert.deepEqual(result.notFoundQueries, ['khongco']);
  assert.deepEqual(result.matchedQueries, ['APTH10', 'BDC-PT1B']);
  const many = m.parseSearchQueries(Array.from({ length: 105 }, (_, i) => 'M' + i).join('\n'));
  assert.equal(many.queries.length, 100);
  assert.equal(many.ignoredCount, 5);
});

test('model dem dong tung sheet', () => {
  const built = model();
  assert.deepEqual(built.counts, { gop: 5, khop: 4, dkve: 6 });
  assert.match(built.source, /DK về 2 6 dòng/);
});

test('sheet chi con o #REF! -> loi 503 DK_VE_REF_ERROR', () => {
  assert.equal(isFormulaErrorSheet(parseCsv('#REF!')), true);
  assert.equal(isFormulaErrorSheet(parseCsv(DKVE)), false);
  assert.throws(() => parseLookupRecords({ gop: parseCsv(GOP), khop: parseCsv(KHOP), dkve: [['#REF!']] }), error => error.code === 'DK_VE_REF_ERROR' && error.statusCode === 503);
});

// Anh loi 27/10/2026: TBVC200, HDLCNL khop VAT10680 nhung khong co dong Gộp VAT rieng.
const GOP_SHARED = [
  'CTY,Mã kiot đại diện,Tên kiot đại diện,MÃ VAT KIOT,TÊN VAT KIOT,TÊN HÀNG,Đơn vị tính,x,TỒN ĐẦU NGÀY,GIÁ BÁN,THUẾ VAT,THUẾ NK,TỔNG THUẾ MẤT,TỔNG ĐANG NHÁP,TỒN CÓ THỂ NHÁP',
  'SHC,H200TMC,Bông 200c,VAT10680,Hộp bông (VAT),Bông A,Hộp,x,720,1,8%,,13.40%,,720',
  'SHC,18S45TB,Bông 180c,VAT10680,Hộp bông (VAT),Bông B,Hộp,x,"1,800",1,8%,,13.40%,,0',
  'SHC,ZERO1,Hàng hết,VAT50005,Hết (VAT),Hàng hết,Cái,x,5,1,8%,,8.00%,,0',
  'SHC,,,VAT60006,Lẻ (VAT),Hàng không mã đại diện,Cái,x,50,1,8%,,8.00%,,50'
].join('\n');
const KHOP_SHARED = [
  'Mã SP,Tên SP,,,,,,,,MÃ VAT KIOT,TÊN VAT KIOT',
  'TBVC200,Hộp bông VCool,0,,,,,,,VAT10680,Hộp bông (VAT)',
  'HDLCNL,Hộp bông Dalaini,0,,,,,,,VAT10680,Hộp bông (VAT)',
  'H200TMC,Bông 200c,0,,,,,,,VAT10680,Hộp bông (VAT)',
  '18S45TB,Bông 180c,0,,,,,,,VAT10680,Hộp bông (VAT)',
  'ZERO1,Hàng hết,0,,,,,,,VAT50005,Hết (VAT)',
  'LONE,Hàng lẻ,0,,,,,,,VAT60006,Lẻ (VAT)'
].join('\n');
const sharedModel = () => parseLookupRecords({ gop: parseCsv(GOP_SHARED), khop: parseCsv(KHOP_SHARED), dkve: parseCsv(DKVE) });
const statusOf = (built, query) => m.search(built, [query]).vat.rows.map(r => [r.maKiot, r.tonCoTheNhap, r.conVAT]);

test('Còn VAT = SUMIF Tồn có thể nháp theo mã VAT: moi dong cung VAT10680 deu con VAT', () => {
  assert.deepEqual(statusOf(sharedModel(), 'TBVC200'), [
    ['TBVC200', 0, true],
    ['HDLCNL', 0, true],
    ['H200TMC', 720, true],
    ['18S45TB', 0, true]
  ]);
  assert.deepEqual(statusOf(sharedModel(), 'HDLCNL')[0], ['HDLCNL', 0, true]);
});

test('Còn VAT theo ma VAT: tong = 0 -> khong con; cong ca dong Gộp VAT khong co ma dai dien', () => {
  assert.deepEqual(statusOf(sharedModel(), 'ZERO1'), [['ZERO1', 0, false]]);
  assert.deepEqual(statusOf(sharedModel(), 'LONE'), [['LONE', 0, true]]);
});

test('Còn VAT khong con doi Khớp mã: ma chi co o Gộp VAT, ma VAT con ton -> con VAT', () => {
  assert.deepEqual(statusOf(model(), 'ONLYGOP'), [['ONLYGOP', 10, true]]);
});

test('Khớp mã goc (file VAT TKS): cot K "Tên trước (Giá đầu - Giá cuối) (VAT)" dung lam ten VAT', () => {
  const khop = parseCsv(',,,,,,,Đỏ cao quá,Vàng thấp quá\nMã SP,Tên SP,Giá Bq,,,,,,,Mã vat kiot,Tên trước (Giá đầu  - Giá cuối) (VAT)\nNOGOP,Ấm Hoa,0,,,,,,,VAT90009,"Ấm (72,300 - 78,700) (VAT)"');
  const built = parseLookupRecords({ gop: parseCsv(GOP), khop, dkve: parseCsv(DKVE) });
  const result = m.search(built, ['NOGOP']);
  assert.deepEqual(result.vat.rows.map(r => [r.maKiot, r.maVat, r.tenVat]), [['NOGOP', 'VAT90009', 'Ấm (72,300 - 78,700) (VAT)']]);
});

test('Hàng VAT có sẵn: 4 cot Mã/Tên Kiot, Mã/Tên VAT Kiot lay tu Gộp VAT (cot E co hau to "giá chưa vat tham khảo")', () => {
  const rows = m.search(model(), ['APTH10']).vat.rows;
  const fromGop = rows.filter(r => r.tenHang);
  assert.ok(fromGop.length);
  fromGop.forEach(r => assert.deepEqual([r.maKiot, r.tenKiot, r.maVat, r.tenVat], ['APTH10', 'Ấm Hoa', 'VAT10001', 'Ấm VAT']));
  // APTH10-B chi co o Khớp mã (khong co dong Gộp VAT rieng) -> van dung ten cua Khớp mã.
  assert.deepEqual(rows.filter(r => r.maKiot === 'APTH10-B').map(r => [r.tenKiot, r.tenVat]), [['Ấm Hoa bản B', 'Ấm giữ nhiệt 1000ML (VAT)']]);
});

test('modern VAT/incoming pages sort the full derived result before the old 500-row cap and retain complete extra columns',()=>{
  const built=model(),product=built.products.find(row=>row.maKiot==='ONLYGOP');
  product.vatLines=Array.from({length:640},(_,i)=>({maVat:'V'+i,tenVat:'VAT '+i,tenHang:'Hàng '+i,dvt:'Cái',tongThueMat:i%2?'8.5%':'8.12%',tonDauNgay:i+0.25,tonCoTheNhap:i+0.75}));
  built.dkVeByMaKiot.set(product.maKiotNorm,Array.from({length:630},(_,i)=>({cont:'CONT '+i,maKiot:product.maKiot,maKiotNorm:product.maKiotNorm,tenKiot:product.tenKiot,trangThaiSo:1,trangThaiRaw:'1. Đang chờ khai',soLuong:i+0.5,soLuongRaw:String(i+0.5),extra:i===629?{'Cột cuối':'Late value'}:{}})));
  const legacy=m.search(built,['ONLYGOP']);assert.equal(legacy.vat.total,640);assert.equal(legacy.vat.rows.length,500);assert.equal(legacy.incoming.rows.length,500);
  const query={vatPage:2,vatPageSize:100,vatSorts:[{key:'tonCoTheNhap',dir:'desc'}],incomingPage:7,incomingPageSize:100,incomingSorts:[{key:'soLuong',dir:'desc'}]};
  const result=m.search(built,['ONLYGOP'],query);
  assert.equal(result.productCount,1);assert.equal(result.vat.totalRows,640);assert.equal(result.vat.total,640);assert.equal(result.vat.page,2);assert.equal(result.vat.rows[0].tonCoTheNhap,539.75);
  assert.equal(result.incoming.totalRows,630);assert.equal(result.incoming.page,7);assert.equal(result.incoming.rows.length,30);assert.equal(result.incoming.rows[0].soLuong,29.5);assert.deepEqual(result.incoming.extraKeys,['Cột cuối']);
  const clamped=m.search(built,['ONLYGOP'],{vatPage:999,vatPageSize:500,incomingPage:999,incomingPageSize:200});assert.equal(clamped.vat.pageSize,200);assert.equal(clamped.vat.page,4);assert.equal(clamped.vat.rows.length,40);assert.equal(clamped.incoming.page,4);
  const multi=m.search(built,['ONLYGOP'],{vatPage:1,vatPageSize:1,vatSorts:[{key:'tongThueMat',dir:'desc'},{key:'tonCoTheNhap',dir:'desc'}]});assert.equal(multi.vat.rows[0].tonCoTheNhap,639.75);
  const empty=m.search(built,['notfound'],{vatPage:999,incomingPage:999});assert.equal(empty.vat.page,1);assert.equal(empty.incoming.page,1);assert.equal(empty.vat.totalRows,0);
  const single=m.search(built,['ONLYGOP'],{vatPage:1});assert.equal(single.incoming.pageSize,100);assert.equal(single.incoming.rows.length,100);
  assert.equal(product.vatLines[0].tonCoTheNhap,0.75);
});
