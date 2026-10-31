'use strict';

// ==========================================
// MEASURE SHEET — du lieu sheet "CAN DO" (kich thuoc + can nang thung), doc tu bang shipping_measures.
// server/sheetSnapshots/sync.js doc Google Sheets (5 phut/lan, dung parseMeasureRows ben duoi) roi ghi vao DB;
// web KHONG goi Google moi request.
// Dung de tinh the tich (m3) / can nang (kg) cua dong hang trong hop chi tiet Vong doi don.
//   m3 moi cai = (Dai x Rong x Cao / 1.000.000) / SL-moi-thung ; kg moi cai = kg-thung / SL-moi-thung.
// Chi doc cac cot goc (SL/T, Can nang, D, R, C), tu tinh bang JS, khong doc cot cong thuc.
// Ma trung: lay hang DAU (giong XLOOKUP cua sheet "Hoa"), khong phan biet hoa/thuong.
// ==========================================

const { getPool } = require('../db/pool');

const HEADERS = Object.freeze({ code: 'MÃ SP', perCarton: 'SL/T', cartonKg: 'Cân nặng', length: 'D', width: 'R', height: 'C' });
// Cot O (thu 15, chi so 14) = "Cuoc 1 Sp (465/m3, 1367d/kg)" (tieu de co the xuong dong). Doc truc tiep, khong tinh lai.
const FREIGHT_COLUMN_INDEX = 14;
const FREIGHT_HEADER_PATTERN = /^cước 1 sp(?:\s|\(|$)/u;
const FREIGHT_HEADER_ERROR = 'Sheet CÂN ĐO: cột O phải có tiêu đề "Cước 1 Sp (…)"; chưa đọc được cước/đơn vị.';
const STALE_AFTER_MS = 20 * 60 * 1000;

function sourceError(code, message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = code;
  return error;
}

function normalizeHeader(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase('vi');
}

function codeKey(code) {
  return String(code ?? '').trim().toLowerCase();
}

function toPositive(value) {
  const number = typeof value === 'number' ? value : Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** O cuoc/chiec -> chuoi thap phan ('384', '0') de giu nguyen NUMERIC; trong/khong doc duoc/am -> null. */
function toFreight(value) {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? String(value) : String(value).normalize('NFC').replace(/[\s,]/gu, '').replace(/đ$/iu, '');
  if (!/^\d+(?:\.\d+)?$/u.test(text)) return null;
  return text.replace(/^0+(?=\d)/u, '').replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '');
}

/** Rows -> Map<codeKey, { perCarton, m3PerUnit, kgPerUnit, missingVolume, missingWeight, freightPerUnit }>; unavailable measurements are null.
 *  Map co them thuoc tinh freightError (null | thong bao) khi tieu de cot O sai. */
function parseMeasureRows(values) {
  const fields = Object.entries(HEADERS);
  let indexes;
  const headerRow = values.findIndex(row => {
    const normalized = row.map(normalizeHeader);
    const found = fields.map(([, title]) => normalized.indexOf(normalizeHeader(title)));
    if (found.some(index => index < 0)) return false;
    indexes = found;
    return true;
  });
  if (headerRow < 0) {
    throw sourceError('MEASURE_HEADERS_MISSING', `Sheet CÂN ĐO không có hàng tiêu đề đủ các cột: ${fields.map(([, title]) => title).join(', ')}.`);
  }
  const [iCode, iPer, iKg, iL, iW, iH] = indexes;
  // Cot O chi phuc vu Kiem tra gia ban: tieu de sai KHONG chan dong bo m3/kg (Vong doi don); moi o cuoc = NULL
  // va table.freightError ghi loi nguon de job kiem tra gia bao chua san sang (khong lay nham cot khac).
  const freightOk = FREIGHT_HEADER_PATTERN.test(normalizeHeader(values[headerRow][FREIGHT_COLUMN_INDEX]));
  const table = new Map();
  table.freightError = freightOk ? null : FREIGHT_HEADER_ERROR;
  for (const row of values.slice(headerRow + 1)) {
    const key = codeKey(row[iCode]);
    if (!key || table.has(key)) continue;
    const perCarton = toPositive(row[iPer]);
    const kg = toPositive(row[iKg]);
    const l = toPositive(row[iL]);
    const w = toPositive(row[iW]);
    const h = toPositive(row[iH]);
    const m3PerUnit = perCarton && l && w && h ? (l * w * h / 1000000) / perCarton : null;
    const kgPerUnit = perCarton && kg ? kg / perCarton : null;
    table.set(key, {
      perCarton, m3PerUnit, kgPerUnit, missingVolume: m3PerUnit === null, missingWeight: kgPerUnit === null,
      freightPerUnit: freightOk ? toFreight(row[FREIGHT_COLUMN_INDEX]) : null
    });
  }
  return table;
}

function createMeasureSheet({ getDb = getPool, now = () => Date.now() } = {}) {
  /** Tra cuu nhieu ma -> Map<codeKey, entry>. Ma khong co trong sheet khong xuat hien trong Map. */
  async function lookup(codes) {
    const keys = [...new Set(codes.map(codeKey).filter(Boolean))];
    let state;
    let measures;
    try {
      const db = getDb();
      [state, measures] = await Promise.all([
        db.query('SELECT last_success_at, last_error FROM sheet_snapshot_sync WHERE source = $1', ['shipping_measures']),
        keys.length
          ? db.query('SELECT code_key, per_carton, m3_per_unit, kg_per_unit FROM shipping_measures WHERE code_key = ANY($1)', [keys])
          : { rows: [] }
      ]);
    } catch (error) {
      console.error('[MeasureSheet] DB read failed:', error.code || 'UNKNOWN');
      throw sourceError('MEASURE_SOURCE_UNAVAILABLE', 'Không đọc được dữ liệu CÂN ĐO.');
    }
    const sync = state.rows[0];
    if (!sync?.last_success_at) throw sourceError('MEASURE_NOT_SYNCED', 'Dữ liệu CÂN ĐO chưa được đồng bộ từ Google Sheets.');
    if (sync.last_error || now() - new Date(sync.last_success_at).getTime() > STALE_AFTER_MS) {
      console.warn('[MeasureSheet] Dang dung ban dong bo cu (stale).');
    }
    const num = value => (value === null || value === undefined ? null : Number(value));
    const result = new Map();
    for (const row of measures.rows) {
      const m3PerUnit = num(row.m3_per_unit);
      const kgPerUnit = num(row.kg_per_unit);
      result.set(row.code_key, {
        perCarton: num(row.per_carton), m3PerUnit, kgPerUnit,
        missingVolume: m3PerUnit === null, missingWeight: kgPerUnit === null
      });
    }
    return result;
  }

  return { lookup };
}

module.exports = { parseMeasureRows, createMeasureSheet, codeKey, normalizeHeader, ...createMeasureSheet() };
