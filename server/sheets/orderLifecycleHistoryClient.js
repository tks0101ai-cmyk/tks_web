// ==========================================
// ORDER LIFECYCLE HISTORY CLIENT — doc/ghi RIENG tab "Lich su cap nhat" trong
// CUNG spreadsheet "Vong doi don hang" (ORDER_LIFECYCLE_SPREADSHEET_ID).
//
// Tach khoi orderLifecycleSheetsClient.js (scope readonly, chi doc 2 tab
// DonHang_HN/SG do bot Telegram/Apps Script ngoai repo ghi) vi tab nay LA
// NGOAI LE: do chinh server tao va ghi (ghi de trang thai thu cong cua Quan
// ly/Ke toan). Can scope "spreadsheets" day du + service account phai duoc
// cap quyen Editor (khong chi Viewer) tren spreadsheet nay.
// ==========================================
'use strict';

const { google } = require('googleapis');
const CONFIG = require('../config');
const { createSheetValuesCache } = require('./sheetValuesCache');

const API_TIMEOUT_MS = 15000; // 15s
const CACHE_TTL_MS = 15 * 1000; // 15s, invalidate ngay sau moi lan ghi
// Google loi tam thoi (qua han muc, timeout): dung ban doc tot gan nhat toi da 10 phut thay vi coi tab nhu rong
// (tab phu/lich su ghi de fail-soft ve [] -> don tut ve "Don chua gui ke toan", mat ghi de).
const STALE_IF_ERROR_MS = 10 * 60 * 1000;

let sheetsApiPromise = null;

function getSheetsApi() {
  if (!sheetsApiPromise) {
    const credentials = JSON.parse(CONFIG.GOOGLE_SERVICE_ACCOUNT_JSON);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
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
  err.detail = '[orderLifecycleHistoryClient] ORDER_LIFECYCLE_SPREADSHEET_ID chua duoc dat trong .env';
  return err;
}

function requireSpreadsheetId() {
  const id = CONFIG.ORDER_LIFECYCLE_SPREADSHEET_ID;
  if (!id) throw spreadsheetNotConfigured();
  return id;
}

const {sharedCache} = require('../lib/sharedCache');
const cacheKey = (spreadsheetId, sheetName) => `lifecycle-sheets:${spreadsheetId}:${sheetName}`;

// L1 trong tien trinh (tra ban cu + lam moi nen) dung tren L2 Redis (sharedCache, fail-open): nhieu instance chia se mot lan doc Google.
const valuesCache = createSheetValuesCache({
  ttlMs: CACHE_TTL_MS,
  staleIfErrorMs: STALE_IF_ERROR_MS,
  load: sheetName => {
    const spreadsheetId = requireSpreadsheetId();
    return sharedCache.readThrough(cacheKey(spreadsheetId, sheetName), CACHE_TTL_MS, async () => {
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
  onBackgroundError: err => console.warn('[orderLifecycleHistoryClient] doc Google Sheet loi, tam dung ban cu:', err.message)
});

/**
 * Doc toan bo du lieu tab "Lich su cap nhat" (mang 2 chieu, dong 1 la header).
 * options.allowStale: xem orderLifecycleSheetsClient.getValues. Sau moi lan ghi cache bi xoa nen luon doc ban moi.
 */
function getValues(sheetName, options) {
  return valuesCache.get(sheetName, options);
}

/**
 * Append 1 dong moi vao cuoi tab (Google Sheets Append API tu dong tim hang
 * trong tiep theo sau du lieu). Invalidate cache du thanh cong hay that bai —
 * 1 loi (vd timeout) khong dam bao ghi KHONG len sheet that.
 */
async function appendRow(sheetName, row) {
  const spreadsheetId = requireSpreadsheetId();
  const sheets = await getSheetsApi();
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: quoteSheetName(sheetName),
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] }
    }, { timeout: API_TIMEOUT_MS });
  } finally {
    // L2 truoc roi moi toi L1: doc xen giua khong the nap lai ban cu tu Redis vao L1.
    await sharedCache.invalidate(cacheKey(spreadsheetId, sheetName));
    valuesCache.invalidate();
  }
}

module.exports = { getValues, appendRow };
