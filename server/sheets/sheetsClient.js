// ==========================================
// GOOGLE SHEETS CLIENT — factory doc-only dung chung cho cac spreadsheet
// con lai (hien tai: "Bảng Công nợ", xem debtManagementSheetsClient.js).
// ==========================================
const { google } = require('googleapis');
const CONFIG = require('../config');

// Gioi han tren cho moi lan goi Google Sheets API — tranh request Express bi
// treo vo thoi han neu Google API cham/khong phan hoi.
const API_TIMEOUT_MS = 15000; // 15s

let sheetsApiPromise = null;

function quoteSheetName(sheetName) {
  return `'${String(sheetName).replace(/'/g, "''")}'`;
}

// Auth dung CHUNG cho moi co so — cung mot service account doc ca hai
// spreadsheet, khong can nhan ban client xac thuc.
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

function sheetNameFromRange(rangeStr) {
  if (!rangeStr) return null;
  const namePart = rangeStr.split('!')[0];
  if (namePart.startsWith("'") && namePart.endsWith("'")) {
    return namePart.slice(1, -1).replace(/''/g, "'");
  }
  return namePart;
}

const SHEET_TITLES_CACHE_TTL_MS = 5 * 60 * 1000; // vai phut la du: danh sach tab hau nhu khong doi giua cac lan poll

/**
 * Loi "co so chua duoc cau hinh nguon du lieu" — statusCode 503 de route tra
 * dung ma cho client, code de UI hien thong bao rieng thay vi loi chung chung.
 */
function branchNotConfigured(branchLabel) {
  const err = new Error(`Cơ sở ${branchLabel} chưa được cấu hình nguồn dữ liệu.`);
  err.code = 'BRANCH_NOT_CONFIGURED';
  err.statusCode = 503;
  return err;
}

/**
 * Tao client doc gan voi 1 spreadsheet.
 * @param {() => (string|null)} getSpreadsheetId doc CONFIG tai thoi diem GOI
 *   (khong phai luc require) de test co the doi config sau khi module da load.
 * @param {string} branchLabel ten co so, dung trong thong bao loi.
 */
function createClient(getSpreadsheetId, branchLabel) {
  let sheetTitlesCache = { data: null, expiresAt: 0, loading: null };

  function requireSpreadsheetId() {
    const id = getSpreadsheetId();
    if (!id) throw branchNotConfigured(branchLabel);
    return id;
  }

  /**
   * Doc toan bo du lieu cua 1 sheet, tra ve mang 2 chieu (giong getDataRange().getValues()).
   */
  async function getValues(sheetName, { valueRenderOption = 'UNFORMATTED_VALUE', cellRange = '' } = {}) {
    const spreadsheetId = requireSpreadsheetId();
    const sheets = await getSheetsApi();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: quoteSheetName(sheetName) + (cellRange ? `!${cellRange}` : ''),
      // Dashboard can tinh toan tren gia tri so goc. Neu dung mac dinh
      // FORMATTED_VALUE, locale vi-VN tra 1021937723 thanh "1.021.937.723"
      // va Number(...) se bien gia tri nay thanh NaN/0.
      valueRenderOption,
      dateTimeRenderOption: 'FORMATTED_STRING'
    }, { timeout: API_TIMEOUT_MS });
    return res.data.values || [];
  }

  /**
   * Danh sach ten cac sheet (tab) hien co trong spreadsheet — dung de debug
   * va de loc bot range khong ton tai truoc khi goi batchGet.
   * Ket qua duoc cache vai phut (giong searchSheetCache) vi getMultipleSheetValues
   * goi ham nay o MOI lan client poll du lieu, trong khi danh sach tab hau nhu
   * khong bao gio doi giua 2 lan poll lien tiep.
   */
  async function listSheetTitles() {
    if (sheetTitlesCache.data && Date.now() < sheetTitlesCache.expiresAt) {
      return sheetTitlesCache.data;
    }
    if (sheetTitlesCache.loading) return sheetTitlesCache.loading;

    const spreadsheetId = requireSpreadsheetId();
    const sheets = await getSheetsApi();
    const loading = sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties.title'
    }, { timeout: API_TIMEOUT_MS })
      .then(res => {
        const titles = (res.data.sheets || []).map(s => s.properties.title);
        sheetTitlesCache.data = titles;
        sheetTitlesCache.expiresAt = Date.now() + SHEET_TITLES_CACHE_TTL_MS;
        return titles;
      })
      .finally(() => {
        if (sheetTitlesCache.loading === loading) sheetTitlesCache.loading = null;
      });
    sheetTitlesCache.loading = loading;
    return loading;
  }

  /**
   * Doc NHIEU sheet trong 1 lan goi API (giam do tre khi client poll dinh ky).
   * batchGet se loi TOAN BO (khong tra ve gi ca) neu chi 1 sheet trong danh sach
   * khong ton tai, nen phai loc truoc theo danh sach tab thuc te — 1 tab bi
   * thieu/doi ten chi lam rong muc do, khong lam sap ca dashboard.
   * @param {string[]} sheetNames
   * @returns {Promise<Object<string, any[][]>>} map ten sheet -> mang 2 chieu (rong neu sheet khong co du lieu hoac khong ton tai)
   */
  async function getMultipleSheetValues(sheetNames) {
    const spreadsheetId = requireSpreadsheetId();
    const sheets = await getSheetsApi();
    const result = {};
    sheetNames.forEach(name => { result[name] = []; });

    const existingTitles = new Set(await listSheetTitles());
    const namesToFetch = sheetNames.filter(name => existingTitles.has(name));
    if (namesToFetch.length === 0) return result;

    // Fetch tung sheet rieng biet de tranh response JSON cua 1 lan batchGet vuot qua
    // gioi han Buffer.toString() cua V8 (~512MB JSON string), gay crash Realloc/OOM.
    // Chay song song theo chunk nho (3 sheets/lan) vua dam bao toc do vua an toan RAM.
    const CHUNK_SIZE = 3;
    for (let i = 0; i < namesToFetch.length; i += CHUNK_SIZE) {
      const chunk = namesToFetch.slice(i, i + CHUNK_SIZE);
      await Promise.all(chunk.map(async (name) => {
        try {
          const res = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: quoteSheetName(name),
            valueRenderOption: 'UNFORMATTED_VALUE',
            dateTimeRenderOption: 'FORMATTED_STRING'
          }, { timeout: API_TIMEOUT_MS });
          result[name] = (res.data && res.data.values) || [];
        } catch (err) {
          console.error(`[SheetsClient] Loi khi doc sheet "${name}":`, err.message || err);
          result[name] = [];
        }
      }));
    }

    return result;
  }

  return { getValues, getMultipleSheetValues, listSheetTitles };
}

/**
 * Doc 1 tab xac dinh theo sheetId (= gid tren URL) thay vi theo ten: doi ten tab
 * khong lam hong nguon. Tra mang 2 chieu nhu values.get (cuoi dong / cuoi bang trong bi cat).
 * @param {{ spreadsheetId: string, sheetId: number|string, range?: string, timeoutMs?: number }} source
 *   range dang 'A1:P' (bo trong = ca tab).
 * @param {{ sheetsApi?: object, valueRenderOption?: string }} options sheetsApi de test gia lap.
 *
 * KHONG tu thu lai (retry: false): googleapis mac dinh thu lai 3 lan khi het thoi gian cho, nen 1 lan doc
 * file goc VAT TKS (timeout 45 s) tung keo dai ~136 s va moi trang VAT cho theo (14/11/2026). Loi -> nguoi
 * goi tra ban cu (cache) hoac lan sau doc lai.
 */
async function readSheetValuesById({ spreadsheetId, sheetId, range = '', timeoutMs = API_TIMEOUT_MS }, { sheetsApi, valueRenderOption = 'FORMATTED_VALUE' } = {}) {
  const sheets = sheetsApi || await getSheetsApi();
  const requestOptions = { timeout: timeoutMs, retry: false };
  const meta = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title)'
  }, requestOptions);
  const tab = (meta.data.sheets || []).find(s => String(s.properties.sheetId) === String(sheetId));
  if (!tab) {
    const err = new Error(`Không có tab sheetId ${sheetId} trong file ${spreadsheetId}.`);
    err.code = 'SHEET_TAB_NOT_FOUND';
    throw err;
  }
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: quoteSheetName(tab.properties.title) + (range ? `!${range}` : ''),
    valueRenderOption,
    dateTimeRenderOption: 'FORMATTED_STRING'
  }, requestOptions);
  return res.data.values || [];
}

module.exports = {
  createReadOnlyClient: createClient,
  readSheetValuesById
};
