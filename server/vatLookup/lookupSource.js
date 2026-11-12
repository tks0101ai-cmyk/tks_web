'use strict';

// Nguon du lieu Tra cuu VAT: 3 tab cua file trung gian "cúc cu test" (IMPORTRANGE tu VAT TKS:
// Gộp VAT, Khớp mã, DK VỀ = MUA VAT SIDA cot A:E) doc bang service account — dung lai fetchSheetRecords cua Nhap VAT
// nhung cache RIENG vi Nhap VAT parse theo chu cai cot, khong co cot TÊN HÀNG va bo dong
// ton khong hop le. Cache 10 phut; Sheets loi tam thoi thi tra ban cu (stale) toi da 6 gio.

const { fetchSheetRecordsWithFallback, fallbackSourceFor } = require('../vatDraft/sheetsSource');
const { createTtlSnapshotCache } = require('../lib/ttlSnapshotCache');
const vatDraftConfig = require('../vatDraft/vatDraftConfig');
const { SHEET_TARGETS, rowsToObjects, buildModel } = require('./lookupModel');

// Tab DK VỀ cua file trung gian (IMPORTRANGE tab MUA VAT SIDA cua VAT TKS), cot A:E = du lieu
// "DK về 2" (TRẠNG THÁI, CONT, mã kiot, tên kiot, SL).
const DK_VE_SHEET = Object.freeze({ sheetId: 740003979, range: 'A:E' });

function defaultLookupConfig() {
  return {
    spreadsheetId: vatDraftConfig.spreadsheetId,
    sheets: { gop: vatDraftConfig.gopVatSheet, khop: vatDraftConfig.khopMaSheet, dkve: DK_VE_SHEET },
    // Tab trung gian hong (#REF! ...) thi doc tab tuong ung cua file goc VAT TKS.
    fallbackSheets: {
      gop: fallbackSourceFor(vatDraftConfig, 'gopVatSheet'),
      khop: fallbackSourceFor(vatDraftConfig, 'khopMaSheet'),
      dkve: fallbackSourceFor(vatDraftConfig, 'dkVeSheet')
    }
  };
}

function sourceError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 503;
  return error;
}

/** Tab chi con 1 o loi cong thuc (#REF!, #N/A...) = cong thuc nguon hong: bao ro thay vi hien trong. */
function isFormulaErrorSheet(records) {
  const cells = records.flat().map(value => String(value || '').trim()).filter(Boolean);
  return cells.length === 1 && /^#[A-Z/0!?]+!?$/.test(cells[0]);
}

/** 3 tab (mang dong) -> model; sheet thieu dong header / loi cong thuc -> loi 503 co code. */
function parseLookupRecords(recordsByKey) {
  const rowsBySheet = {};
  for (const target of SHEET_TARGETS) {
    const records = recordsByKey[target.key];
    if (isFormulaErrorSheet(records)) {
      throw sourceError(`Sheet '${target.label}' chỉ trả về lỗi công thức ${records.flat().find(Boolean)} (công thức trong file nguồn đang lỗi). Báo người quản lý sheet kiểm tra.`, target.key === 'dkve' ? 'DK_VE_REF_ERROR' : 'SHEET_REF_ERROR');
    }
    rowsBySheet[target.key] = rowsToObjects(records, target.headerAnchors);
  }
  if (!rowsBySheet.gop.length && !rowsBySheet.khop.length) {
    throw sourceError('Không đọc được dữ liệu từ sheet Khớp mã hoặc Gộp VAT. Hãy kiểm tra lại tên cột trong Google Sheet.', 'SHEET_COLUMNS');
  }
  return buildModel(rowsBySheet);
}

function createLookupSource({ readValues, config = defaultLookupConfig(), now, logger } = {}) {
  const cache = createTtlSnapshotCache({
    freshTtlMs: 10 * 60 * 1000,
    staleTtlMs: 6 * 60 * 60 * 1000,
    ...(now ? { now } : {}),
    fetch: async () => {
      const results = await Promise.all(SHEET_TARGETS.map(target => fetchSheetRecordsWithFallback({
        source: { spreadsheetId: config.spreadsheetId, ...config.sheets[target.key] },
        fallbackSource: (config.fallbackSheets && config.fallbackSheets[target.key]) || null,
        sheetName: target.label,
        refErrorCode: target.key === 'dkve' ? 'DK_VE_REF_ERROR' : 'SHEET_REF_ERROR',
        readValues,
        ...(logger !== undefined ? { logger } : {})
      })));
      const model = parseLookupRecords(Object.fromEntries(SHEET_TARGETS.map((target, i) => [target.key, results[i].records])));
      model.fallbackTabs = SHEET_TARGETS.filter((target, i) => results[i].usedFallback).map(target => target.label);
      return model;
    }
  });
  return {
    get: options => cache.get(options),
    refresh: () => cache.get({ forceRefresh: true })
  };
}

module.exports = { DK_VE_SHEET, defaultLookupConfig, isFormulaErrorSheet, parseLookupRecords, createLookupSource };
