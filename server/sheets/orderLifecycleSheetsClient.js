// ==========================================
// ORDER LIFECYCLE SHEETS CLIENT — doc RIENG spreadsheet "Vong doi don hang"
// (2 tab DonHang_HN/DonHang_SG), duoc Bot Telegram + Apps Script NGOAI REPO
// NAY ghi truc tiep. Server CHI DOC (scope spreadsheets.readonly).
//
// Khac sheetsClient.js: CA HAI tab nam trong CUNG 1
// spreadsheet (khong phai 1 spreadsheet/co so), nen chi can 1 client duy nhat
// — khong tach hanoiClient/saigonClient. Cache TTL ngan (15s) vi du lieu bot
// ghi gan-realtime. Shared generation guard cũng nhận invalidation từ history client.
// ==========================================
'use strict';

const { google } = require('googleapis');
const CONFIG = require('../config');
const { createSheetValuesCache } = require('./sheetValuesCache');

const API_TIMEOUT_MS = 15000; // 15s
const CACHE_TTL_MS = 15 * 1000; // 15s
// Google loi tam thoi (qua han muc, timeout): dung ban doc tot gan nhat toi da 10 phut thay vi coi tab nhu rong
// (tab phu/lich su ghi de fail-soft ve [] -> don tut ve "Don chua gui ke toan", mat ghi de).
const STALE_IF_ERROR_MS = 10 * 60 * 1000;

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

const {sharedCache} = require('../lib/sharedCache');

// L1 trong tien trinh (tra ban cu + lam moi nen) dung tren L2 Redis (sharedCache, fail-open): nhieu instance chia se mot lan doc Google.
const valuesCache = createSheetValuesCache({
  ttlMs: CACHE_TTL_MS,
  staleIfErrorMs: STALE_IF_ERROR_MS,
  load: sheetName => {
    const spreadsheetId = requireSpreadsheetId();
    return sharedCache.readThrough(`lifecycle-sheets:${spreadsheetId}:${sheetName}`, CACHE_TTL_MS, async () => {
      const sheets = await getSheetsApi();
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: quoteSheetName(sheetName),
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING'
      }, { timeout: API_TIMEOUT_MS });
      return res.data.values || [];
    }, { validate: rows => Array.isArray(rows) && rows.every(Array.isArray) });
  },
  onBackgroundError: err => console.warn('[orderLifecycleSheetsClient] doc Google Sheet loi, tam dung ban cu:', err.message)
});

/**
 * Doc toan bo du lieu cua 1 tab, tra ve mang 2 chieu (giong sheetsClient.js).
 * options.allowStale: cache het han van tra ban cu ngay va lam moi o nen (hop Chi dinh vi tri dung).
 */
function getValues(sheetName, options) {
  return valuesCache.get(sheetName, options);
}

module.exports = { getValues };
