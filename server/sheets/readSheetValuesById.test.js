'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';
process.env.JWT_SECRET ||= 'test';
const { readSheetValuesById } = require('./sheetsClient');

// 14/11/2026: googleapis mac dinh thu lai 3 lan khi het thoi gian cho -> 1 lan doc file goc VAT TKS (45 s)
// keo dai ~136 s. Doc theo sheetId phai tat retry de thoi gian cho bi chan boi timeoutMs.
test('readSheetValuesById: ca 2 lan goi Sheets API deu tat retry va dung timeoutMs cua nguon', async () => {
  const calls = [];
  const sheetsApi = { spreadsheets: {
    get: async (params, options) => { calls.push(['get', options]); return { data: { sheets: [{ properties: { sheetId: 7, title: 'Gộp VAT' } }] } }; },
    values: { get: async (params, options) => { calls.push(['values', options, params.range]); return { data: { values: [['a']] } }; } }
  } };
  const values = await readSheetValuesById({ spreadsheetId: 'S', sheetId: 7, range: 'A1:P', timeoutMs: 45000 }, { sheetsApi });
  assert.deepEqual(values, [['a']]);
  assert.deepEqual(calls, [
    ['get', { timeout: 45000, retry: false }],
    ['values', { timeout: 45000, retry: false }, "'Gộp VAT'!A1:P"]
  ]);
});
