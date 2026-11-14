'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('./csv');
const {
  columnLetterToIndex,
  toPandasFrame,
  parseGopVat,
  parseKhopMa,
  parseMasterData,
  fetchSheetRecords,
  fetchSheetCsv,
  createMasterDataSource
} = require('./sheetsSource');
const vatDraftConfig = require('./vatDraftConfig');
const { readSheetValuesById } = require('../sheets/sheetsClient');

const GOP_HEADER = 'CTY,Mã kiot đại diện,Tên kiot đại diện,MÃ VAT KIOT,TÊN VAT KIOT,TÊN HÀNG,Đơn vị tính,x,TỒN ĐẦU NGÀY,GIÁ BÁN,THUẾ VAT,THUẾ NK,TỔNG THUẾ MẤT,TỔNG ĐANG NHÁP,TỒN CÓ THỂ NHÁP';
const KHOP_HEADER = 'CHECK TỒN BÊN SHEET VAT,,,,,,,,,,\nMã SP,Tên SP,,,,,,,,MÃ VAT KIOT,TÊN VAT KIOT';

test('parseCsv: nhay kep, "" trong o, xuong dong trong o, bo dong rong', () => {
  assert.deepEqual(parseCsv('a,"b,c","d ""e"""\n\n"x\ny",,\r\nz'), [['a', 'b,c', 'd "e"'], ['x\ny', '', ''], ['z']]);
});

test('columnLetterToIndex', () => {
  assert.equal(columnLetterToIndex('A'), 0);
  assert.equal(columnLetterToIndex('o'), 14);
  assert.equal(columnLetterToIndex('AA'), 26);
  assert.throws(() => columnLetterToIndex('A1'));
});

test('toPandasFrame: o trong / #N/A -> NaN; cot toan so nguyen -> chuoi so chuan; cot so le -> Number', () => {
  const frame = toPandasFrame(parseCsv('h1,h2,h3,h4\n007,1.5,#N/A,x\n10,,abc,\n'), 1);
  assert.equal(frame.width, 4);
  assert.deepEqual(frame.rows[0].slice(0, 2), ['7', 1.5]);
  assert.ok(Number.isNaN(frame.rows[0][2]));
  assert.equal(frame.rows[1][0], '10');
  assert.ok(Number.isNaN(frame.rows[1][1]));
  assert.equal(frame.rows[1][2], 'abc');
  assert.ok(Number.isNaN(frame.rows[1][3]));
});

test('parseGopVat: dong A-G trong thanh "nan" nhu pandas, TON #N/A bi bo, dong trong hoan toan bi bo', () => {
  const csv = [
    GOP_HEADER,
    'TKS THẤP,XUẤT THẤP,XUẤT THẤP,VAT1,Tên VAT,Đũa tre,Đôi,TKS THẤP,"76,614",370,8%,,8.00%,"1,000","75,614"',
    ',,,,,,,,,,,,,,"1,234"',
    'MAY,SP2,Tên 2,VAT2,Tên VAT 2,Kế toán 2,Cái,MAY,10,500,10%,,10%,,#N/A',
    ',,,,,,,,,,,,,,',
    'CAO,SP3,Tên 3,VAT3,Tên VAT 3,Kế toán 3,Cái,CAO,10,500,8%,,8%,,-5'
  ].join('\n');
  const { stockRows, warnings, summary, errors } = parseGopVat(toPandasFrame(parseCsv(csv), 1));
  assert.deepEqual(errors, []);
  assert.equal(stockRows.length, 3);
  const [first, nanRow, third] = stockRows;
  assert.deepEqual([first.rowIndex, first.nguon, first.maVatKiot, first.tonCoTheNhap, first.thueVat, first.tongDangNhap, first.giaBan], [2, 'TKS THẤP', 'VAT1', 75614, 0.08, 1000, 370]);
  assert.equal(first.maVatKiotNorm, 'vat1');
  assert.deepEqual([nanRow.nguon, nanRow.maVatKiot, nanRow.maVatKiotNorm, nanRow.tonCoTheNhap, nanRow.thueVat], ['nan', 'nan', 'nan', 1234, null]);
  assert.deepEqual([third.rowIndex, third.tonCoTheNhap], [6, -5], 'row_index dem ca dong bi bo');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].detail, /Dòng 4: TỒN CÓ THỂ NHÁP='nan'/);
  assert.equal(summary.invalidTonCount, 1);
  assert.equal(summary.zeroOrNegativeTonCount, 1);
});

test('parseKhopMa bo 2 dong dau, doc A/B/J/K', () => {
  const csv = `${KHOP_HEADER}\nAPTH10,Ấm giữ nhiệt Hoa 1L,"71,500",,,,,0,9.27%,VAT10001,"Ấm giữ nhiệt 1000ML (72,300 - 78,700) (VAT)"`;
  const { mappingRows } = parseKhopMa(toPandasFrame(parseCsv(csv), 2));
  assert.deepEqual(mappingRows, [{
    rowIndex: 2, maSp: 'APTH10', tenSp: 'Ấm giữ nhiệt Hoa 1L', maVatKiot: 'VAT10001',
    tenTruocVat: 'Ấm giữ nhiệt 1000ML (72,300 - 78,700) (VAT)', maSpNorm: 'apth10', maVatKiotNorm: 'vat10001'
  }]);
});

test('cot nam ngoai pham vi sheet -> loi', () => {
  const data = parseMasterData(parseCsv('a,b,c\n1,2,3'), parseCsv('x\ny\n1,2'));
  assert.equal(data.errors.length, 2);
  assert.match(data.errors[0], /Gộp VAT' thiếu cột/);
});

function fakeResponse({ status = 200, contentType = 'text/csv; charset=utf-8', body = '' }) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => contentType }, text: async () => body };
}

test('fetchSheetCsv: sheet het cong khai (tra HTML) -> loi ro rang', async () => {
  await assert.rejects(
    fetchSheetCsv({ gid: 0, sheetName: 'Gộp VAT', fetchImpl: async () => fakeResponse({ contentType: 'text/html' }) }),
    error => error.code === 'SHEET_NOT_PUBLIC' && error.statusCode === 503
  );
  await assert.rejects(
    fetchSheetCsv({ gid: 0, sheetName: 'Gộp VAT', fetchImpl: async () => fakeResponse({ status: 500 }) }),
    error => error.code === 'SHEET_HTTP'
  );
});

test('readSheetValuesById: tim tab theo sheetId roi doc theo ten (co nhay), khong co tab -> SHEET_TAB_NOT_FOUND', async () => {
  const calls = [];
  const sheetsApi = {
    spreadsheets: {
      get: async params => { calls.push(['get', params.spreadsheetId]); return { data: { sheets: [{ properties: { sheetId: 7, title: "Gộp VAT's" } }] } }; },
      values: { get: async params => { calls.push(['values', params.range, params.valueRenderOption]); return { data: { values: [['a']] } }; } }
    }
  };
  assert.deepEqual(await readSheetValuesById({ spreadsheetId: 'F', sheetId: '7', range: 'A1:P' }, { sheetsApi }), [['a']]);
  assert.deepEqual(calls, [['get', 'F'], ['values', "'Gộp VAT''s'!A1:P", 'FORMATTED_VALUE']]);
  await assert.rejects(readSheetValuesById({ spreadsheetId: 'F', sheetId: 8 }, { sheetsApi }), error => error.code === 'SHEET_TAB_NOT_FOUND');
});

test('fetchSheetRecords: dem du cot nhu CSV export (values.get cat o trong cuoi dong), so -> chuoi', async () => {
  const records = await fetchSheetRecords({
    source: { spreadsheetId: 'F', sheetId: 1 }, sheetName: 'Gộp VAT',
    readValues: async () => [['h1', 'h2', 'h3'], [], ['x'], [1, null, 'z']]
  });
  assert.deepEqual(records, [['h1', 'h2', 'h3'], ['', '', ''], ['x', '', ''], ['1', '', 'z']]);
});

test('fetchSheetRecords: loi Sheets API -> loi 503 co code ro rang', async () => {
  const failWith = error => fetchSheetRecords({ source: { spreadsheetId: 'F', sheetId: 1 }, sheetName: 'Gộp VAT', readValues: async () => { throw error; } });
  await assert.rejects(failWith(Object.assign(new Error('The caller does not have permission'), { code: 403 })),
    error => error.code === 'SHEET_FORBIDDEN' && error.statusCode === 503 && /Service account/.test(error.message));
  await assert.rejects(failWith(Object.assign(new Error('x'), { code: 'SHEET_TAB_NOT_FOUND' })), error => error.code === 'SHEET_TAB_NOT_FOUND' && /sheetId 1/.test(error.message));
  await assert.rejects(failWith(Object.assign(new Error('Not found'), { response: { status: 404 } })), error => error.code === 'SHEET_HTTP');
  await assert.rejects(failWith(new Error('timeout of 15000ms exceeded')), error => error.code === 'SHEET_TIMEOUT');
  await assert.rejects(failWith(new Error('socket hang up')), error => error.code === 'SHEET_NETWORK');
});

test('createMasterDataSource: doc 2 tab theo sheetId; cache 10 phut, refresh ep tai lai, loi thi tra ban cu (stale)', async () => {
  const sources = [];
  let fail = false;
  let clock = 0;
  const gop = parseCsv(`${GOP_HEADER}\nMAY,SP1,Tên,VAT1,Tên VAT,KT,Cái,MAY,1,100,8%,,8%,,5`);
  const khop = parseCsv(`${KHOP_HEADER}\nSP1,Tên,,,,,,,,VAT1,Tên VAT`);
  const readValues = async source => {
    sources.push(source);
    if (fail) throw new Error('mat mang');
    return source.sheetId === vatDraftConfig.gopVatSheet.sheetId ? gop : khop;
  };
  const source = createMasterDataSource({ readValues, now: () => clock });
  const first = await source.get();
  assert.equal(first.stockRows.length, 1);
  assert.equal(first.mappingRows.length, 1);
  assert.deepEqual(sources.map(s => [s.spreadsheetId, s.sheetId, s.range]), [
    [vatDraftConfig.spreadsheetId, vatDraftConfig.gopVatSheet.sheetId, 'A1:P'],
    [vatDraftConfig.spreadsheetId, vatDraftConfig.khopMaSheet.sheetId, 'A1:K']
  ]);
  clock = 5 * 60 * 1000;
  await source.get();
  assert.equal(sources.length, 2, 'con trong 10 phut thi dung cache');
  await source.refresh();
  assert.equal(sources.length, 4);
  fail = true;
  const stale = await source.refresh();
  assert.equal(stale.stale, true);
  assert.equal(stale.stockRows.length, 1);
});

const {
  isBrokenSheetRecords,
  fetchSheetRecordsWithFallback
} = require('./sheetsSource');

const silentLogger = { warn() {} };

test('isBrokenSheetRecords: chi 1 o (#REF!, Loading...) / rong / it cot hon can doc', () => {
  assert.equal(isBrokenSheetRecords([['#REF!']]), true);
  assert.equal(isBrokenSheetRecords([['Loading...', '']]), true);
  assert.equal(isBrokenSheetRecords([]), true);
  assert.equal(isBrokenSheetRecords([['a', 'b'], ['1', '2']]), false);
  assert.equal(isBrokenSheetRecords([['a', 'b'], ['1', '2']], 3), true);
});

test('fetchSheetRecordsWithFallback: tab trung gian #REF! -> doc file goc', async () => {
  const calls = [];
  const readValues = async source => {
    calls.push(source.spreadsheetId);
    return source.spreadsheetId === 'MID' ? [['#REF!']] : [['h1', 'h2'], ['1', '2']];
  };
  const result = await fetchSheetRecordsWithFallback({
    source: { spreadsheetId: 'MID', sheetId: 0 }, fallbackSource: { spreadsheetId: 'SRC', sheetId: 9, timeoutMs: 45000 },
    sheetName: 'Gộp VAT', readValues, logger: silentLogger
  });
  assert.deepEqual(calls, ['MID', 'SRC']);
  assert.equal(result.usedFallback, true);
  assert.deepEqual(result.records, [['h1', 'h2'], ['1', '2']]);
});

test('fetchSheetRecordsWithFallback: loi API o file trung gian -> doc file goc; tab tot thi khong doc file goc', async () => {
  const readValues = async source => {
    if (source.spreadsheetId === 'MID') throw Object.assign(new Error('timeout of 15000ms exceeded'), {});
    return [['a', 'b'], ['1', '2']];
  };
  const viaFallback = await fetchSheetRecordsWithFallback({
    source: { spreadsheetId: 'MID', sheetId: 0 }, fallbackSource: { spreadsheetId: 'SRC', sheetId: 9 }, sheetName: 'Khớp mã', readValues, logger: silentLogger
  });
  assert.equal(viaFallback.usedFallback, true);
  let fallbackCalls = 0;
  const ok = await fetchSheetRecordsWithFallback({
    source: { spreadsheetId: 'MID', sheetId: 0 }, fallbackSource: { spreadsheetId: 'SRC', sheetId: 9 }, sheetName: 'Khớp mã', logger: silentLogger,
    readValues: async source => { if (source.spreadsheetId === 'SRC') fallbackCalls += 1; return [['a', 'b'], ['1', '2']]; }
  });
  assert.equal(ok.usedFallback, false);
  assert.equal(fallbackCalls, 0);
});

test('fetchSheetRecordsWithFallback: ca hai hong -> loi 503 ro rang; khong co du phong -> giu hanh vi cu', async () => {
  await assert.rejects(fetchSheetRecordsWithFallback({
    source: { spreadsheetId: 'MID', sheetId: 0 }, fallbackSource: { spreadsheetId: 'SRC', sheetId: 9 }, sheetName: 'Gộp VAT', logger: silentLogger,
    readValues: async () => [['#REF!']]
  }), error => error.code === 'SHEET_REF_ERROR' && error.statusCode === 503 && /file gốc VAT TKS dự phòng cũng lỗi/.test(error.message));
  await assert.rejects(fetchSheetRecordsWithFallback({
    source: { spreadsheetId: 'MID', sheetId: 0 }, fallbackSource: { spreadsheetId: 'SRC', sheetId: 9 }, sheetName: 'Gộp VAT', logger: silentLogger,
    readValues: async source => { if (source.spreadsheetId === 'MID') return [['#REF!']]; throw Object.assign(new Error('denied'), { code: 403 }); }
  }), error => error.code === 'SHEET_FORBIDDEN' && /'#REF!'/.test(error.message));
  const noFallback = await fetchSheetRecordsWithFallback({ source: { spreadsheetId: 'MID', sheetId: 0 }, sheetName: 'Gộp VAT', readValues: async () => [['#REF!']] });
  assert.deepEqual(noFallback, { records: [['#REF!']], usedFallback: false });
  await assert.rejects(fetchSheetRecordsWithFallback({
    source: { spreadsheetId: 'MID', sheetId: 0 }, sheetName: 'Gộp VAT', readValues: async () => { throw new Error('socket hang up'); }
  }), error => error.code === 'SHEET_NETWORK');
});

test('createMasterDataSource: file trung gian #REF! -> doc tab file goc (sheetId goc, timeout dai), ghi fallbackTabs', async () => {
  const gop = parseCsv(`${GOP_HEADER}\nMAY,SP1,Tên,VAT1,Tên VAT,KT,Cái,MAY,1,100,8%,,8%,,5`);
  const khop = parseCsv(`${KHOP_HEADER}\nSP1,Tên,,,,,,,,VAT1,Tên VAT`);
  const sources = [];
  const readValues = async source => {
    sources.push(source);
    if (source.spreadsheetId === vatDraftConfig.spreadsheetId) {
      return source.sheetId === vatDraftConfig.gopVatSheet.sheetId ? [['#REF!']] : khop;
    }
    return gop;
  };
  const data = await createMasterDataSource({ readValues, logger: silentLogger }).get();
  assert.equal(data.stockRows.length, 1);
  assert.equal(data.mappingRows.length, 1);
  assert.deepEqual(data.fallbackTabs, ['Gộp VAT']);
  const fallbackRead = sources.find(s => s.spreadsheetId === vatDraftConfig.fallback.spreadsheetId);
  assert.deepEqual(fallbackRead, { spreadsheetId: vatDraftConfig.fallback.spreadsheetId, timeoutMs: vatDraftConfig.fallback.timeoutMs, sheetId: 950697804, range: 'A1:P' });
});

// 14/11/2026: 3 trang VAT doc cung tab (vd file goc VAT TKS khi file trung gian loi) -> dung chung 1 lan doc.
test('bo doc mac dinh: doc trung tab dang chay / vua xong dung chung 1 lan goi; loi khong giu lai', async () => {
  const sheetsClient = require('../sheets/sheetsClient');
  const original = sheetsClient.readSheetValuesById;
  const calls = [];
  let fail = false;
  sheetsClient.readSheetValuesById = async source => {
    calls.push(source.sheetId);
    await new Promise(resolve => setTimeout(resolve, 20));
    if (fail) throw new Error('timeout of 45000ms exceeded');
    return [['Mã', 'Tên'], ['A1', 'x']];
  };
  const modulePath = require.resolve('./sheetsSource');
  delete require.cache[modulePath];
  try {
    const { fetchSheetRecordsWithFallback: fetchFresh } = require('./sheetsSource');
    const source = { spreadsheetId: 'SHARED', sheetId: 950697804, range: 'A1:P', timeoutMs: 45000 };
    const [a, b] = await Promise.all([
      fetchFresh({ source, sheetName: 'Gộp VAT', logger: null }),
      fetchFresh({ source: { ...source }, sheetName: 'Tồn VAT', logger: null })
    ]);
    assert.deepEqual(a.records, b.records);
    assert.notEqual(a.records, b.records, 'moi nguoi goi nhan mang rieng');
    await fetchFresh({ source, sheetName: 'Gộp VAT', logger: null });
    assert.deepEqual(calls, [950697804], '3 lan doc trong 60 s -> 1 lan goi Google');
    const other = { ...source, sheetId: 1 };
    fail = true;
    await assert.rejects(() => fetchFresh({ source: other, sheetName: 'Khớp mã', logger: null }), /quá lâu/);
    fail = false;
    await fetchFresh({ source: other, sheetName: 'Khớp mã', logger: null });
    assert.deepEqual(calls, [950697804, 1, 1], 'lan loi khong duoc dung lai');
  } finally {
    sheetsClient.readSheetValuesById = original;
    delete require.cache[modulePath];
  }
});
