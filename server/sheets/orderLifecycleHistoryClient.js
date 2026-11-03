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

const API_TIMEOUT_MS = 15000; // 15s
const CACHE_TTL_MS = 15 * 1000; // 15s, invalidate ngay sau moi lan ghi

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
const cacheKey = (spreadsheetId,sheetName) => `lifecycle-sheets:${spreadsheetId}:${sheetName}`;

async function getValues(sheetName) {
  const spreadsheetId = requireSpreadsheetId();
  return sharedCache.readThrough(cacheKey(spreadsheetId,sheetName), CACHE_TTL_MS, async () => {
    const sheets = await getSheetsApi();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: quoteSheetName(sheetName),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING'
    }, {timeout: API_TIMEOUT_MS});
    return res.data.values || [];
  }, {validate: rows => Array.isArray(rows) && rows.every(Array.isArray)});
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
    await sharedCache.invalidate(cacheKey(spreadsheetId,sheetName));
  }
}

module.exports = { getValues, appendRow };
