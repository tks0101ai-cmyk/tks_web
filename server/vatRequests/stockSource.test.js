'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCsv } = require('../vatDraft/csv');
const vatDraftConfig = require('../vatDraft/vatDraftConfig');
const { defaultStockConfig, createStockSource, lookupStock } = require('./stockSource');

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
