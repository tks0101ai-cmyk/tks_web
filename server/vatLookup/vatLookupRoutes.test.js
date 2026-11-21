'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registry = require('../auth/featureRegistry');
const { ROLES } = require('../auth/userRepository');
const { createVatLookupRouter } = require('./vatLookupRoutes');
const { parseCsv } = require('../vatDraft/csv');
const { createLookupSource } = require('./lookupSource');

// Key = sheetId cua tab trong file trung gian "cúc cu test" (Gộp VAT, Khớp mã, DK VỀ).
const CSV = {
  0: 'CTY,Mã kiot đại diện,Tên kiot đại diện,MÃ VAT KIOT,TÊN VAT KIOT,TÊN HÀNG,Đơn vị tính,x,TỒN ĐẦU NGÀY,GIÁ BÁN,THUẾ VAT,THUẾ NK,TỔNG THUẾ MẤT,TỔNG ĐANG NHÁP,TỒN CÓ THỂ NHÁP\n'
    + 'TKS THẤP,TALEWS,Bút,VAT11629,Bút VAT,Bút chấm chân tóc,Cái,x,"1,000",1,8%,,8.00%,,"1,000"',
  1192158065: ',,,,,,,Đỏ cao quá,Vàng thấp quá\nMã SP,Tên SP,Giá Bq,,,,,,,Mã vat kiot,Tên trước (Giá đầu  - Giá cuối) (VAT)\nTALEWS,BÚT NHUỘM TÓC SUAKE (OD),,,,,,,,VAT11629,Bút VAT',
  740003979: 'TRẠNG THÁI,CONT,mã kiot,tên kiot,\n1. Đang chờ khai,10-10Y,TALEWS,BÚT NHUỘM TÓC SUAKE (OD),972'
};

/** Sheets API gia lap: tra mang dong theo sheetId cua tab. */
function fakeReadValues(overrides = {}) {
  const calls = [];
  const impl = async ({ sheetId }) => {
    calls.push(String(sheetId));
    return parseCsv(sheetId in overrides ? overrides[sheetId] : CSV[sheetId]);
  };
  impl.calls = calls;
  return impl;
}

function userFor(vaiTro, featurePermissions) {
  const user = { username: 'u1', vaiTro, featurePermissions, trangThai: 'Đang hoạt động' };
  return { ...user, permissions: registry.resolvePermissions(user) };
}

async function request(path, { user = userFor(ROLES.NHAN_VIEN_SALE), method = 'GET', body, source = createLookupSource({ readValues: fakeReadValues() }) } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; req.effectiveUserResolved = !!user; next(); });
  app.use('/api/vat-lookup', createVatLookupRouter({ source }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/vat-lookup${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, headers: res.headers, body: await res.json() };
  } finally {
    server.close();
  }
}

test('phan quyen: chua dang nhap 401; Sale / Ke toan / Quan ly 200; Khach 403; tat rieng -> 403', async () => {
  assert.equal((await request('/meta', { user: null })).status, 401);
  for (const role of [ROLES.NHAN_VIEN_SALE, ROLES.KE_TOAN, ROLES.QUAN_LY]) {
    assert.equal((await request('/meta', { user: userFor(role) })).status, 200, role);
  }
  const guest = await request('/meta', { user: userFor(ROLES.KHACH, { 'accounting.vatLookup': true }) });
  assert.equal(guest.status, 403);
  assert.equal(guest.body.code, 'FEATURE_FORBIDDEN');
  assert.equal((await request('/meta', { user: userFor(ROLES.NHAN_VIEN_SALE, { 'accounting.vatLookup': false }) })).status, 403);
});

test('GET /meta: so san pham, dong nguon, khong cache trinh duyet', async () => {
  const res = await request('/meta');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.body.products, 1);
  assert.equal(res.body.stale, false);
  assert.match(res.body.source, /Gộp VAT 1 dòng · Khớp mã 1 dòng · DK về 2 1 dòng/);
  assert.ok(res.body.loadedAt);
});

test('POST /search: tra ca 2 tab tu 1 lan goi; doc dung 3 tab', async () => {
  const readValues = fakeReadValues();
  const res = await request('/search', { method: 'POST', body: { q: 'talews\nkhongco' }, source: createLookupSource({ readValues }) });
  assert.equal(res.status, 200);
  assert.deepEqual(readValues.calls.sort(), ['0', '1192158065', '740003979']);
  assert.deepEqual(res.body.queries, ['talews', 'khongco']);
  assert.deepEqual(res.body.notFoundQueries, ['khongco']);
  assert.deepEqual(res.body.vat.rows.map(r => [r.maKiot, r.maVat, r.tonCoTheNhap, r.conVAT, r.hasIncoming]), [['TALEWS', 'VAT11629', 1000, true, true]]);
  assert.deepEqual(res.body.incoming.rows.map(r => [r.cont, r.trangThai, r.soLuong]), [['10-10Y', 'Đang chờ khai', 972]]);
});

test('POST /search: noi dung qua dai -> 400', async () => {
  const res = await request('/search', { method: 'POST', body: { q: 'x'.repeat(20001) } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'VAT_LOOKUP_QUERY_TOO_LONG');
});

test('DK về 2 tra #REF! ca file trung gian lan file goc -> 503 co code ro rang', async () => {
  const source = createLookupSource({ readValues: fakeReadValues({ 740003979: '#REF!', 467403108: '#REF!' }), logger: null });
  const res = await request('/search', { method: 'POST', body: { q: 'TALEWS' }, source });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, 'DK_VE_REF_ERROR');
  assert.match(res.body.error, /file gốc VAT TKS dự phòng cũng lỗi/);
});

test('Tab file trung gian #REF! -> doc tab file goc (MUA VAT SIDA / Gộp VAT goc), meta ghi fallbackTabs', async () => {
  const readValues = fakeReadValues({ 740003979: '#REF!', 0: '#REF!', 467403108: CSV[740003979], 950697804: CSV[0] });
  const source = createLookupSource({ readValues, logger: null });
  const res = await request('/search', { method: 'POST', body: { q: 'TALEWS' }, source });
  assert.equal(res.status, 200);
  assert.deepEqual(readValues.calls.sort(), ['0', '1192158065', '467403108', '740003979', '950697804']);
  assert.deepEqual(res.body.meta.fallbackTabs, ['Gộp VAT', 'DK về 2']);
  assert.deepEqual(res.body.incoming.rows.map(r => [r.cont, r.soLuong]), [['10-10Y', 972]]);
  assert.equal((await request('/meta', { source })).body.fallbackTabs.length, 2);
});

test('POST /refresh ep tai lai; Sheets loi sau do -> tra ban cu danh dau stale', async () => {
  let fail = false;
  const base = fakeReadValues();
  const readValues = async sheet => { if (fail) throw new Error('mạng'); return base(sheet); };
  let clock = 0;
  const source = createLookupSource({ readValues, now: () => clock });
  assert.equal((await request('/refresh', { method: 'POST', source })).body.stale, false);
  assert.equal(base.calls.length, 3);
  fail = true;
  clock = 11 * 60 * 1000;
  // Het 10 phut: tra NGAY ban dang co (khong cho Google Sheets), doc lai o nen.
  const first = await request('/meta', { source });
  assert.equal(first.status, 200);
  assert.equal(first.body.products, 1);
  // Lan doc nen loi -> cac request sau thay ban cu danh dau stale.
  for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
  const res = await request('/meta', { source });
  assert.equal(res.status, 200);
  assert.equal(res.body.stale, true);
  assert.equal(res.body.products, 1);
});


test('modern search envelopes retain metadata/input cap and cached source, with permission checks before reading',async()=>{
  const readValues=fakeReadValues(),source=createLookupSource({readValues});
  const body={q:'TALEWS',vatPage:99,vatPageSize:100,vatSorts:[{key:'tonCoTheNhap',dir:'desc'}],incomingPage:99,incomingPageSize:100,incomingSorts:[{key:'soLuong',dir:'desc'}]};
  const first=await request('/search',{method:'POST',body,source});assert.equal(first.status,200);assert.equal(first.body.vat.page,1);assert.equal(first.body.vat.pageSize,100);assert.equal(first.body.vat.totalRows,1);assert.equal(first.body.incoming.page,1);assert.equal(first.body.incoming.totalRows,1);
  await request('/search',{method:'POST',body:{...body,vatPage:1},source});assert.equal(readValues.calls.length,3);
  assert.equal(first.body.meta.stale,false);assert.deepEqual(first.body.queries,['TALEWS']);
  let reads=0;const deniedSource={get:async()=>{reads++;throw new Error('must not read');}};
  for(const user of [null,userFor(ROLES.KHACH),userFor(ROLES.NHAN_VIEN_SALE,{'accounting.vatLookup':false})]){
    const denied=await request('/search',{method:'POST',body,source:deniedSource,user});assert.ok([401,403].includes(denied.status));
  }
  assert.equal(reads,0);
});

test('POST /stock: ton VAT theo ma SP khop chinh xac, giu khoa ma client gui; khong cache trinh duyet', async () => {
  const codes = [' talews ', 'TALEW', 'KHONGCO', '   ', null, ...Array(201).fill('TALEWS')];
  const res = await request('/stock', { method: 'POST', body: { codes } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(res.body.items, {
    talews: { vatCode: 'VAT11629', vatKey: 'vat11629', stock: 1000 },
    TALEW: { vatCode: null, vatKey: null, stock: null },
    KHONGCO: { vatCode: null, vatKey: null, stock: null },
    TALEWS: { vatCode: 'VAT11629', vatKey: 'vat11629', stock: 1000 }
  });
  assert.equal(res.body.meta.stale, false);
  assert.ok(res.body.meta.loadedAt);
});

test('POST /stock: body sai -> 400 VAT_LOOKUP_STOCK_INVALID', async () => {
  const bodies = [{}, { codes: 'TALEWS' }, { codes: [] }, { codes: ['  ', null, 5] },
    { codes: Array.from({ length: 201 }, (_, i) => 'M' + i) }, { codes: ['X'.repeat(61)] }];
  for (const body of bodies) {
    const res = await request('/stock', { method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 40));
    assert.equal(res.body.code, 'VAT_LOOKUP_STOCK_INVALID');
  }
});

test('POST /stock: thieu quyen Tra cuu VAT -> 403, khong doc sheet', async () => {
  const readValues = fakeReadValues();
  const source = createLookupSource({ readValues });
  const res = await request('/stock', { method: 'POST', body: { codes: ['TALEWS'] }, source, user: userFor(ROLES.NHAN_VIEN_SALE, { 'accounting.vatLookup': false }) });
  assert.equal(res.status, 403);
  assert.equal(readValues.calls.length, 0);
});

test('POST /stock: dung chung bo dem voi /search (khong doc sheet them); nguon loi -> 503', async () => {
  const readValues = fakeReadValues();
  const source = createLookupSource({ readValues });
  await request('/search', { method: 'POST', body: { q: 'TALEWS' }, source });
  const before = readValues.calls.length;
  assert.equal((await request('/stock', { method: 'POST', body: { codes: ['TALEWS'] }, source })).status, 200);
  assert.equal(readValues.calls.length, before);
  const broken = { get: async () => { const error = new Error('Sheet lỗi'); error.statusCode = 503; error.code = 'SHEET_REF_ERROR'; throw error; } };
  const failed = await request('/stock', { method: 'POST', body: { codes: ['TALEWS'] }, source: broken });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, 'SHEET_REF_ERROR');
});

test('POST /stock: chưa đăng nhập trả 401 trước khi đọc nguồn', async () => {
  const readValues = fakeReadValues();
  const source = createLookupSource({ readValues });
  const res = await request('/stock', { method: 'POST', body: { codes: ['TALEWS'] }, source, user: null });
  assert.equal(res.status, 401);
  assert.equal(readValues.calls.length, 0);
});

test('POST /stock: trả dữ liệu và thời điểm tải của bản cũ khi làm mới nguồn thất bại', async () => {
  const base = fakeReadValues();
  let fail = false;
  const readValues = async sheet => {
    if (fail) throw new Error('mạng');
    return base(sheet);
  };
  const source = createLookupSource({ readValues, logger: null });
  const body = { codes: ['TALEWS'] };
  const fresh = await request('/stock', { method: 'POST', body, source });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.meta.stale, false);
  fail = true;
  const refreshed = await request('/refresh', { method: 'POST', source });
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.body.stale, true);
  const stale = await request('/stock', { method: 'POST', body, source });
  assert.equal(stale.status, 200);
  assert.deepEqual(stale.body.meta, { ...fresh.body.meta, stale: true });
  assert.deepEqual(stale.body.items, fresh.body.items);
});
