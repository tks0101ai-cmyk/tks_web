'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../vatDraft/csv');
const vatDraftConfig = require('../vatDraft/vatDraftConfig');
const { defaultStockConfig, createStockSource, lookupStock } = require('./stockSource');

test('paired VAT stocks sum companies once, prefer mappings, preserve zero/negative and unknown', () => {
  const { parseStockSnapshot, lookupVatStock } = require('./stockSource');
  const config = defaultStockConfig();
  const row = (company, representative, vat, actual, available) => {
    const values = Array(15).fill('');
    Object.assign(values, { 0: company, 1: representative, 3: vat, 8: actual, 14: available });
    return values;
  };
  const mapping = vat => ['SP', '', '', '', '', '', '', '', '', vat];
  const snapshot = parseStockSnapshot([Array(15).fill('header'),
    row('A', 'OTHER', 'V1', '10.5', '0'), row('B', '', 'V1', '2', '-3'),
    row('C', 'SP', 'V2', '100', '80'), row('D', 'UNKNOWN', 'V3', '', '')],
  [[], [], mapping('V1'), mapping('V1')], config);
  assert.deepEqual(lookupVatStock(snapshot, 'sp'), { actual: 12.5, available: -3,
    byCompany: [{ company: 'A', vatCode: 'V1', actual: 10.5, available: 0 }, { company: 'B', vatCode: 'V1', actual: 2, available: -3 }] });
  assert.equal(lookupVatStock(snapshot, 'OTHER').actual, 12.5);
  assert.equal(lookupVatStock(snapshot, 'V1').available, -3);
  assert.equal(lookupVatStock(snapshot, 'UNKNOWN').actual, null);
  assert.equal(lookupVatStock(snapshot, 'UNKNOWN').available, null);
  assert.equal(lookupVatStock(snapshot, 'MISSING'), null);
});

const GOP_VAT_SHEET_ID = vatDraftConfig.gopVatSheet.sheetId;

test('defaultStockConfig: mac dinh doc tab Gộp VAT + Khớp mã cua file trung gian (vatDraftConfig)', () => {
  const config = defaultStockConfig();
  assert.deepEqual(config.stockSheet, { spreadsheetId: vatDraftConfig.spreadsheetId, sheetId: GOP_VAT_SHEET_ID });
  assert.deepEqual(config.mappingSheet, { spreadsheetId: vatDraftConfig.spreadsheetId, sheetId: vatDraftConfig.khopMaSheet.sheetId });
});

test('createStockSource: doc 2 tab qua Sheets API, cong ton moi cong ty theo Khớp mã', async () => {
  const config = defaultStockConfig();
  const tabs = {
    [GOP_VAT_SHEET_ID]: parseCsv('CTY,Mã kiot đại diện,Tên,MÃ VAT KIOT,TÊN VAT,Tên hàng,ĐVT,x,TỒN ĐẦU NGÀY\nTKS THẤP,014XOAN,,VAT1,,,Cái,,"1,200"\nVC,,,VAT1,,,Cái,,300'),
    [vatDraftConfig.khopMaSheet.sheetId]: [[], ['Mã SP', 'Tên SP', '', '', '', '', '', '', '', 'Mã vat kiot'], ['BAT1', 'Bát', '', '', '', '', '', '', '', 'VAT1']]
  };
  const calls = [];
  const source = createStockSource({ config, readValues: async sheet => { calls.push(sheet.sheetId); return tabs[sheet.sheetId]; } });
  const snapshot = await source.get();
  assert.deepEqual(calls.sort(), [GOP_VAT_SHEET_ID, vatDraftConfig.khopMaSheet.sheetId].sort());
  assert.deepEqual(lookupStock(snapshot, 'bat1'), { total: 1500, byCompany: [{ company: 'TKS THẤP', vatCode: 'VAT1', stock: 1200 }, { company: 'VC', vatCode: 'VAT1', stock: 300 }] });
  assert.equal(lookupStock(snapshot, '014xoan').total, 1500, 'khong co trong Khớp mã thi dung Mã kiot đại diện');
});

test('createStockSource: tab Gộp VAT trung gian #REF! -> doc tab Gộp VAT cua file goc VAT TKS', async () => {
  const config = defaultStockConfig();
  assert.equal(config.stockFallbackSheet.sheetId, vatDraftConfig.fallback.gopVatSheet.sheetId);
  assert.equal(config.mappingFallbackSheet.sheetId, vatDraftConfig.fallback.khopMaSheet.sheetId);
  const gop = parseCsv('CTY,Mã kiot đại diện,Tên,MÃ VAT KIOT,TÊN VAT,Tên hàng,ĐVT,x,TỒN ĐẦU NGÀY\nVC,,,VAT1,,,Cái,,300');
  const khop = [[], ['Mã SP', 'Tên SP', '', '', '', '', '', '', '', 'Mã vat kiot'], ['BAT1', 'Bát', '', '', '', '', '', '', '', 'VAT1']];
  const readValues = async sheet => {
    if (sheet.spreadsheetId === vatDraftConfig.fallback.spreadsheetId) return gop;
    return sheet.sheetId === GOP_VAT_SHEET_ID ? [['#REF!']] : khop;
  };
  const snapshot = await createStockSource({ config, readValues, logger: null }).get();
  assert.equal(lookupStock(snapshot, 'bat1').total, 300);
});
