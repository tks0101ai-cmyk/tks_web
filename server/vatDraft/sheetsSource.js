'use strict';

// Du lieu nguon Nhap VAT: 2 tab "Gộp VAT", "Khớp mã" cua file VAT TKS doc bang service
// account (Sheets API, chi doc, FORMATTED_VALUE = dung chuoi nhu CSV export truoc day).
// Parse theo CHU CAI cot (vatDraftConfig) va mo phong cach pandas doc o trong / "#N/A"
// (NaN -> chuoi 'nan' o cot chu, None o cot so) de ket qua khop app cu (vat-draft-app).

const { readSheetValuesById } = require('../sheets/sheetsClient');
const { normalizeCode, normalizeCodeForMatch, toFloatOrNone } = require('./normalization');
const { createTtlSnapshotCache } = require('../lib/ttlSnapshotCache');
const vatDraftConfig = require('./vatDraftConfig');

const EXPORT_URL = 'https://docs.google.com/spreadsheets/d/{sheetId}/export?format=csv&gid={gid}';
const FETCH_TIMEOUT_MS = 15000;

// Chuoi pandas mac dinh coi la NA (khop nguyen van, khong strip).
const PANDAS_NA = new Set([
  '', '#N/A', '#N/A N/A', '#NA', '-1.#IND', '-1.#QNAN', '-NaN', '-nan', '1.#IND', '1.#QNAN',
  '<NA>', 'N/A', 'NA', 'NULL', 'NaN', 'None', 'n/a', 'nan', 'null'
]);
const PANDAS_INT_RE = /^[ \t]*[+-]?\d+[ \t]*$/;
const PANDAS_FLOAT_RE = /^[ \t]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t]*$/;
const INT64_MAX = 9223372036854775807n;

function columnLetterToIndex(letter) {
  const text = String(letter).trim().toUpperCase();
  if (!/^[A-Z]+$/.test(text)) throw new Error(`Tên cột Excel không hợp lệ: '${letter}'`);
  let index = 0;
  for (const ch of text) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

/**
 * Mo phong pd.read_csv(header=None, skiprows=N): bo N dong dau, dem cot theo dong dau
 * con lai, o NA -> NaN, suy kieu tung cot (toan so nguyen -> chuoi so chuan nhu str(int);
 * co NA/so thuc -> Number; con lai giu nguyen chuoi).
 */
function toPandasFrame(records, skipRows) {
  const rows = records.slice(skipRows);
  const width = rows.length ? rows[0].length : 0;
  const cells = rows.map(row => {
    if (row.length > width) {
      const error = new Error(`Dòng có ${row.length} cột, nhiều hơn ${width} cột của dòng đầu.`);
      error.code = 'CSV_WIDTH';
      throw error;
    }
    return Array.from({ length: width }, (_, i) => {
      const raw = i < row.length ? row[i] : '';
      return PANDAS_NA.has(raw) ? NaN : raw;
    });
  });

  for (let col = 0; col < width; col += 1) {
    const values = cells.map(row => row[col]);
    const present = values.filter(value => typeof value === 'string');
    const hasNa = present.length !== values.length;
    const allInt = present.every(value => PANDAS_INT_RE.test(value) && BigInt(value.trim()) <= INT64_MAX && BigInt(value.trim()) >= -INT64_MAX - 1n);
    if (present.length && allInt && !hasNa) {
      cells.forEach(row => { row[col] = BigInt(row[col].trim()).toString(); });
    } else if (present.length && (allInt || present.every(value => PANDAS_FLOAT_RE.test(value)))) {
      cells.forEach(row => { if (typeof row[col] === 'string') row[col] = Number(row[col].trim()); });
    }
  }
  return { width, rows: cells };
}

function buildColMap(frame, letters) {
  const colMap = {};
  const missing = [];
  for (const [canonical, letter] of Object.entries(letters)) {
    const idx = columnLetterToIndex(letter);
    if (idx < frame.width) colMap[canonical] = idx;
    else missing.push(`${canonical} (cột ${String(letter).trim().toUpperCase()})`);
  }
  return { colMap, missing };
}

const isNa = value => typeof value === 'number' && Number.isNaN(value);

/** _parse_gop_vat -> { stockRows, errors, warnings, summary }. */
function parseGopVat(frame, letters = vatDraftConfig.gopVatColumns) {
  const { colMap, missing } = buildColMap(frame, letters);
  const summary = { sheetName: 'Gộp VAT', totalDataRows: 0, blankMaVatCount: 0, invalidTonCount: 0, zeroOrNegativeTonCount: 0 };
  if (missing.length) {
    return { stockRows: [], summary, warnings: [], errors: [`Sheet 'Gộp VAT' thiếu cột (ngoài phạm vi sheet): ${missing.join(', ')}`] };
  }
  const stockRows = [];
  const warnings = [];
  frame.rows.forEach((row, position) => {
    const rowIdx = position + 2;
    if (row.every(isNa)) return; // bo dong trong hoan toan
    const gcol = canonical => (colMap[canonical] !== undefined ? row[colMap[canonical]] : null);
    summary.totalDataRows += 1;

    const maVatKiot = normalizeCode(gcol('MÃ VAT KIOT'));
    const tenKeToan = normalizeCode(gcol('TÊN KẾ TOÁN'));
    const donViTinh = normalizeCode(gcol('Đơn vị tính'));
    if (!maVatKiot) summary.blankMaVatCount += 1;

    const tonRaw = gcol('TỒN CÓ THỂ NHÁP');
    const ton = toFloatOrNone(tonRaw);
    // Nhu Python: o trong / #N/A (NaN, str -> 'nan') hoac chu -> dong khong hop le, bo qua.
    if (tonRaw !== null && (isNa(tonRaw) || String(tonRaw).trim() !== '') && ton === null) {
      summary.invalidTonCount += 1;
      warnings.push({
        rowIndex: rowIdx,
        warningType: 'ton_khong_hop_le',
        detail: `Dòng ${rowIdx}: TỒN CÓ THỂ NHÁP='${isNa(tonRaw) ? 'nan' : tonRaw}' không chuyển được thành số.`
      });
      return;
    }
    const tonFinal = ton !== null ? ton : 0.0;
    if (tonFinal <= 0) summary.zeroOrNegativeTonCount += 1;

    stockRows.push({
      rowIndex: rowIdx,
      nguon: normalizeCode(gcol('NGUỒN')),
      maKiotDaiDien: normalizeCode(gcol('Mã kiot đại diện')),
      tenKiotDaiDien: normalizeCode(gcol('Tên kiot đại diện')),
      maVatKiot,
      tenVatKiot: normalizeCode(gcol('TÊN VAT KIOT')),
      tenKeToan,
      donViTinh,
      tonDauNgay: toFloatOrNone(gcol('TỒN ĐẦU NGÀY')),
      giaBan: toFloatOrNone(gcol('GIÁ BÁN')),
      thueVat: toFloatOrNone(gcol('THUẾ VAT')),
      thueNk: toFloatOrNone(gcol('THUẾ NK')),
      tongThueMat: toFloatOrNone(gcol('TỔNG THUẾ MẤT')),
      tongDangNhap: toFloatOrNone(gcol('TỔNG ĐANG NHÁP')) || 0.0,
      tonCoTheNhap: tonFinal,
      maVatKiotNorm: normalizeCodeForMatch(maVatKiot),
      tenKeToanNorm: normalizeCodeForMatch(tenKeToan),
      donViTinhNorm: normalizeCodeForMatch(donViTinh)
    });
  });
  return { stockRows, summary, warnings, errors: [] };
}

/** _parse_khop_ma -> { mappingRows, errors, summary }. */
function parseKhopMa(frame, letters = vatDraftConfig.khopMaColumns) {
  const { colMap, missing } = buildColMap(frame, letters);
  const summary = { sheetName: 'Khớp mã', totalDataRows: 0, blankMaCount: 0, blankMaVatCount: 0, duplicateMaSpMultiVatCount: 0 };
  if (missing.length) {
    return { mappingRows: [], summary, errors: [`Sheet 'Khớp mã' thiếu cột (ngoài phạm vi sheet): ${missing.join(', ')}`] };
  }
  const mappingRows = [];
  frame.rows.forEach((row, position) => {
    const rowIdx = position + 2;
    if (row.every(isNa)) return;
    const gcol = canonical => (colMap[canonical] !== undefined ? row[colMap[canonical]] : null);
    summary.totalDataRows += 1;
    const maSp = normalizeCode(gcol('Mã SP'));
    const maVatKiot = normalizeCode(gcol('Mã vat kiot'));
    if (!maSp) summary.blankMaCount += 1;
    if (!maVatKiot) summary.blankMaVatCount += 1;
    mappingRows.push({
      rowIndex: rowIdx,
      maSp,
      tenSp: normalizeCode(gcol('Tên SP')),
      maVatKiot,
      tenTruocVat: normalizeCode(gcol('Tên trước (Giá đầu  - Giá cuối) (VAT)')),
      maSpNorm: normalizeCodeForMatch(maSp),
      maVatKiotNorm: normalizeCodeForMatch(maVatKiot)
    });
  });
  const vatByMaSp = new Map();
  for (const m of mappingRows) {
    if (!m.maSpNorm) continue;
    if (!vatByMaSp.has(m.maSpNorm)) vatByMaSp.set(m.maSpNorm, new Set());
    vatByMaSp.get(m.maSpNorm).add(m.maVatKiotNorm);
  }
  summary.duplicateMaSpMultiVatCount = [...vatByMaSp.values()].filter(set => set.size > 1).length;
  return { mappingRows, summary, errors: [] };
}

function sheetError(message, code) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 503;
  return error;
}

/**
 * Doc 1 tab qua Sheets API -> mang dong chuoi, dem du so cot nhu CSV export (values.get
 * cat o trong cuoi dong). Loi API -> loi 503 co code de route bao ro.
 * @param {{ source: { spreadsheetId, sheetId, range? }, sheetName: string, readValues?: Function }} args
 *   readValues(source) gia lap duoc trong test.
 */
async function fetchSheetRecords({ source, sheetName, readValues = readSheetValuesById }) {
  let values;
  try {
    values = await readValues(source);
  } catch (error) {
    const status = error.status || (error.response && error.response.status) || (typeof error.code === 'number' ? error.code : null);
    if (error.code === 'SHEET_TAB_NOT_FOUND') {
      throw sheetError(`Không tìm thấy tab '${sheetName}' (sheetId ${source.sheetId}) trong file nguồn. Kiểm tra cấu hình nguồn sheet.`, 'SHEET_TAB_NOT_FOUND');
    }
    if (status === 403) {
      throw sheetError(`Service account chưa có quyền xem file chứa sheet '${sheetName}'. Chia sẻ quyền Người xem cho service account.`, 'SHEET_FORBIDDEN');
    }
    if (status === 404) throw sheetError(`Không tìm thấy file chứa sheet '${sheetName}'.`, 'SHEET_HTTP');
    if (/timeout/i.test(String(error.message)) || error.code === 'ETIMEDOUT') {
      throw sheetError(`Đọc sheet '${sheetName}' quá lâu. Thử lại sau.`, 'SHEET_TIMEOUT');
    }
    throw sheetError(`Lỗi khi đọc sheet '${sheetName}' qua Google Sheets API: ${error.message}`, status ? 'SHEET_HTTP' : 'SHEET_NETWORK');
  }
  const width = values.reduce((max, row) => Math.max(max, row.length), 0);
  return values.map(row => Array.from({ length: width }, (_, i) => (row[i] === undefined || row[i] === null ? '' : String(row[i]))));
}

/**
 * Tab doc duoc nhung khong dung duoc: IMPORTRANGE cua file trung gian loi chi con 1 o
 * ('#REF!', '#N/A', 'Loading...') hoac rong; hoac it cot hon so cot can doc (minColumns).
 */
function isBrokenSheetRecords(records, minColumns = 0) {
  const filled = records.flat().filter(value => String(value || '').trim() !== '').length;
  if (filled <= 1) return true;
  const width = records.reduce((max, row) => Math.max(max, row.length), 0);
  return width < minColumns;
}

function describeBrokenRecords(records) {
  const first = records.flat().map(value => String(value || '').trim()).find(Boolean);
  return first ? `chỉ có '${first}'` : 'trống';
}

/**
 * Doc tab cua file trung gian; loi API hoac tab hong (isBrokenSheetRecords) thi doc tab
 * tuong ung cua file goc (fallbackSource). Tra { records, usedFallback, reason }.
 * Ca hai deu hong: nem loi cua file goc kem ly do file trung gian (503 code cua file goc,
 * hoac SHEET_REF_ERROR khi file goc doc duoc nhung cung hong).
 */
async function fetchSheetRecordsWithFallback({ source, fallbackSource, sheetName, minColumns = 0, refErrorCode = 'SHEET_REF_ERROR', readValues = readSheetValuesById, logger = console }) {
  let reason;
  let primaryRecords = null;
  try {
    primaryRecords = await fetchSheetRecords({ source, sheetName, readValues });
    if (!isBrokenSheetRecords(primaryRecords, minColumns)) return { records: primaryRecords, usedFallback: false };
    reason = `tab ${describeBrokenRecords(primaryRecords)}`;
  } catch (error) {
    if (!fallbackSource) throw error;
    reason = error.message;
  }
  if (!fallbackSource) return { records: primaryRecords, usedFallback: false };

  if (logger) logger.warn(`[vat-sheets] '${sheetName}' file trung gian lỗi (${reason}) -> đọc file gốc VAT TKS (sheetId ${fallbackSource.sheetId}).`);
  let fallbackRecords;
  try {
    fallbackRecords = await fetchSheetRecords({ source: fallbackSource, sheetName: `${sheetName} (file gốc VAT TKS)`, readValues });
  } catch (error) {
    throw sheetError(`Sheet '${sheetName}' ở file trung gian lỗi (${reason}); đọc file gốc VAT TKS dự phòng cũng lỗi: ${error.message}`, error.code || 'SHEET_NETWORK');
  }
  if (isBrokenSheetRecords(fallbackRecords, minColumns)) {
    throw sheetError(`Sheet '${sheetName}' ở file trung gian lỗi (${reason}); file gốc VAT TKS dự phòng cũng lỗi (tab ${describeBrokenRecords(fallbackRecords)}). Báo người quản lý sheet kiểm tra.`, refErrorCode);
  }
  return { records: fallbackRecords, usedFallback: true, reason };
}

/** Tai CSV 1 sheet cong khai (chi con script import ORDER VAT dung); sheet het chia se cong khai thi Google tra HTML dang nhap -> bao loi ro. */
async function fetchSheetCsv({ gid, sheetName, sheetId, fetchImpl = globalThis.fetch }) {
  const url = EXPORT_URL.replace('{sheetId}', sheetId).replace('{gid}', String(gid));
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw sheetError(`Tải sheet '${sheetName}' quá ${FETCH_TIMEOUT_MS / 1000} giây. Kiểm tra mạng rồi thử lại.`, 'SHEET_TIMEOUT');
    }
    throw sheetError(`Lỗi mạng khi tải sheet '${sheetName}': ${error.message}`, 'SHEET_NETWORK');
  }
  if (!response.ok) {
    throw sheetError(`Google Sheets trả lỗi ${response.status} khi tải sheet '${sheetName}'.`, 'SHEET_HTTP');
  }
  const contentType = String(response.headers.get('content-type') || '');
  if (!contentType.includes('text/csv')) {
    throw sheetError(`Sheet '${sheetName}' không còn chia sẻ công khai (Google không trả về CSV).`, 'SHEET_NOT_PUBLIC');
  }
  return response.text();
}

/** Parse 2 tab (mang dong) -> { stockRows, mappingRows, errors, warnings, summaries }. */
function parseMasterData(gopVatRecords, khopMaRecords, config = vatDraftConfig) {
  const gopVat = parseGopVat(toPandasFrame(gopVatRecords, config.gopVatSkipRows), config.gopVatColumns);
  const khopMa = parseKhopMa(toPandasFrame(khopMaRecords, config.khopMaSkipRows), config.khopMaColumns);
  return {
    stockRows: gopVat.stockRows,
    mappingRows: khopMa.mappingRows,
    errors: [...gopVat.errors, ...khopMa.errors],
    warnings: gopVat.warnings,
    summaries: { gopVat: gopVat.summary, khopMa: khopMa.summary }
  };
}

/** Nguon file goc du phong cua 1 tab (config.fallback[key]) hoac null khi khong cau hinh. */
function fallbackSourceFor(config, key) {
  const fallback = config.fallback;
  if (!fallback || !fallback[key]) return null;
  return { spreadsheetId: fallback.spreadsheetId, ...(fallback.timeoutMs ? { timeoutMs: fallback.timeoutMs } : {}), ...fallback[key] };
}

/** So cot toi thieu de doc du cac cot cau hinh theo chu cai. */
function minColumnsFor(letters) {
  return Math.max(0, ...Object.values(letters).map(letter => columnLetterToIndex(letter) + 1));
}

/**
 * Nguon master data co cache: tuoi 10 phut, nut "Cập nhật" ep tai lai; Sheets loi tam
 * thoi thi tra ban cu (stale, toi da 6 gio) thay vi lam hong ca trang. Tab trung gian hong
 * thi doc file goc (config.fallback), ten tab da dung du phong ghi trong fallbackTabs.
 */
function createMasterDataSource({ readValues, config = vatDraftConfig, now, logger } = {}) {
  const cache = createTtlSnapshotCache({
    freshTtlMs: 10 * 60 * 1000,
    staleTtlMs: 6 * 60 * 60 * 1000,
    ...(now ? { now } : {}),
    fetch: async () => {
      const read = (key, sheetName, letters) => fetchSheetRecordsWithFallback({
        source: { spreadsheetId: config.spreadsheetId, ...config[key] },
        fallbackSource: fallbackSourceFor(config, key),
        sheetName,
        minColumns: minColumnsFor(letters),
        readValues,
        ...(logger !== undefined ? { logger } : {})
      });
      const [gopVat, khopMa] = await Promise.all([
        read('gopVatSheet', 'Gộp VAT', config.gopVatColumns),
        read('khopMaSheet', 'Khớp mã', config.khopMaColumns)
      ]);
      const data = parseMasterData(gopVat.records, khopMa.records, config);
      if (data.errors.length) throw sheetError(data.errors.join(' '), 'SHEET_COLUMNS');
      data.fallbackTabs = [gopVat.usedFallback && 'Gộp VAT', khopMa.usedFallback && 'Khớp mã'].filter(Boolean);
      return data;
    }
  });
  return {
    get: options => cache.get(options),
    refresh: () => cache.get({ forceRefresh: true }),
    set: data => cache.set(data),
    clear: () => cache.clear()
  };
}

module.exports = {
  PANDAS_NA,
  columnLetterToIndex,
  toPandasFrame,
  parseGopVat,
  parseKhopMa,
  parseMasterData,
  fetchSheetRecords,
  isBrokenSheetRecords,
  fetchSheetRecordsWithFallback,
  fallbackSourceFor,
  fetchSheetCsv,
  createMasterDataSource
};
