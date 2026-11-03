// ==========================================
// ORDER LIFECYCLE SHEETS CLIENT — doc RIENG spreadsheet "Vong doi don hang"
// (2 tab DonHang_HN/DonHang_SG), duoc Bot Telegram + Apps Script NGOAI REPO
// NAY ghi truc tiep. Server CHI DOC (scope spreadsheets.readonly).
//
// Khac sheetsClient.js: CA HAI tab nam trong CUNG 1
// spreadsheet (khong phai 1 spreadsheet/co so), nen chi can 1 client duy nhat
// — khong tach hanoiClient/saigonClient. Cache TTL ngan (15s) vi du lieu bot
// ghi gan-realtime; khong can generation-guard vi
// module nay KHONG BAO GIO ghi.
// ==========================================
'use strict';

const { google } = require('googleapis');
const CONFIG = require('../config');
const { createSheetValuesCache } = require('./sheetValuesCache');

const API_TIMEOUT_MS = 15000; // 15s
const CACHE_TTL_MS = 15 * 1000; // 15s

let sheetsApiPromise = null;

function getSheetsApi() {
  if (!sheetsApiPromise) {
    const credentials = JSON.parse(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly']
    });
    sheetsApiPromise = auth.getClient().then(authClient =>
      google.sheets({ version: 'v4', auth: authClient })
    );
  }
  return sheetsApiPromise;
}

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

function spreadsheetNotConfigured() {
  const err = new Error('Chưa cấu hình nguồn dữ liệu "Vòng đời đơn hàng".');
  err.code = 'BRANCH_NOT_CONFIGURED';
  err.statusCode = 503;
  err.detail = '[orderLifecycleSheetsClient] ORDER_LIFECYCLE_SPREADSHEET_ID chua duoc dat trong .env';
  return err;
}

function requireSpreadsheetId() {
  const id = CONFIG.ORDER_LIFECYCLE_SPREADSHEET_ID;
  if (!id) throw spreadsheetNotConfigured();
  return id;
}

const valuesCache = createSheetValuesCache({
  ttlMs: CACHE_TTL_MS,
  load: sheetName => {
    const spreadsheetId = requireSpreadsheetId();
    return getSheetsApi().then(sheets => sheets.spreadsheets.values.get({
      spreadsheetId,
      range: quoteSheetName(sheetName),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    }, { timeout: API_TIMEOUT_MS })).then(res => res.data.values || []);
  },
  onBackgroundError: err => console.warn('[orderLifecycleSheetsClient] lam moi nen loi:', err.message)
});

/**
 * Doc toan bo du lieu cua 1 tab, tra ve mang 2 chieu (giong sheetsClient.js).
 * options.allowStale: cache het han van tra ban cu ngay va lam moi o nen (hop Chi dinh vi tri dung).
 */
function getValues(sheetName, options) {
  return valuesCache.get(sheetName, options);
}

module.exports = { getValues };
