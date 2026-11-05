'use strict';

// Doc file import Vi tri hang (xlsx/xls/csv) bang SheetJS (xlsx), mau supplierReturnImportService.js.
// 4 cot bat buoc: Ma hang, Ghi chu, Ngay ve, Vi tri (khop ten cot khong phan biet hoa/thuong va dau; cot thua bo qua).
// Xuat kho (requireArrivalDate = false): chi 3 cot bat buoc Ma hang, Ghi chu, Vi tri; cot Ngay ve neu co thi bo qua.
// Ngay ve la TEXT tu do ("KK 4.10", "16/10"); o kieu ngay cua Excel doi thanh dd/MM (cung nam) hoac dd/MM/yyyy.
const XLSX = require('xlsx');

const HEADER_SCAN_ROWS = 20;
const COLUMNS = Object.freeze({
  code: { label: 'Mã hàng', aliases: ['ma hang', 'ma sp', 'ma san pham', 'ma'] },
  notes: { label: 'Ghi chú', aliases: ['ghi chu', 'ghi chu so thung', 'thung', 'ghi chu hang hoa', 'mo ta'] },
  arrivalDate: { label: 'Ngày về', aliases: ['ngay ve'] },
  location: { label: 'Vị trí', aliases: ['vi tri', 'vt', 'o', 'khu'] }
});

function importError(code, message) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

const fold = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/[đĐ]/gu, 'd')
  .toLowerCase().replace(/\s+/gu, ' ').trim();

const pad2 = n => String(n).padStart(2, '0');

function dateText(cell, now) {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  if (typeof cell.v === 'number' && cell.z && XLSX.SSF.is_date(cell.z)) {
    const d = XLSX.SSF.parse_date_code(cell.v);
    if (d && d.d && d.m) return d.y === now.getFullYear() ? `${pad2(d.d)}/${pad2(d.m)}` : `${pad2(d.d)}/${pad2(d.m)}/${d.y}`;
  }
  return String(cell.w !== undefined && typeof cell.v === 'number' ? cell.w : cell.v).trim();
}

function plainText(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  return String(typeof cell.v === 'number' && cell.w !== undefined ? cell.w : cell.v).trim();
}

/**
 * @returns {Array<{row:number, code:string, notes:string, arrivalDate:string, location:string}>} dong co du lieu (row = so dong Excel).
 * Nem loi 400 khi file khong doc duoc, khong co sheet, hoac thieu cot.
 * requireArrivalDate=false (Xuat kho): Ngay ve khong bat buoc va luon tra '' du file co cot do.
 */
function parseImportWorkbook(buffer, { fileName = '', now = new Date(), requireArrivalDate = true } = {}) {
  let workbook;
  try {
    if (/\.csv$/iu.test(fileName)) workbook = XLSX.read(buffer.toString('utf8').replace(/^﻿/u, ''), { type: 'string', raw: true });
    else workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch (error) {
    throw importError('IMPORT_UNREADABLE', 'Không đọc được file. Hãy dùng file .xlsx, .xls hoặc .csv.');
  }
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet || !sheet['!ref']) throw importError('IMPORT_EMPTY_FILE', 'File không có dữ liệu.');
  const range = XLSX.utils.decode_range(sheet['!ref']);
  const cellAt = (r, c) => sheet[XLSX.utils.encode_cell({ r, c })];

  const required = Object.keys(COLUMNS).filter(key => requireArrivalDate || key !== 'arrivalDate');
  // Tim hang tieu de o bat ky dong nao trong 20 dong dau; neu khong du cot bat buoc thi liet ke cot thieu cua hang gan dung nhat.
  let best = null;
  const lastScan = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1);
  for (let r = range.s.r; r <= lastScan; r += 1) {
    const found = {};
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const text = fold(plainText(cellAt(r, c)));
      if (!text) continue;
      for (const [key, def] of Object.entries(COLUMNS)) if (found[key] === undefined && def.aliases.includes(text)) found[key] = c;
    }
    const hits = required.filter(key => found[key] !== undefined).length;
    // Tên hàng là cột tùy chọn, không ảnh hưởng việc tìm đủ 4 cột bắt buộc.
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      if (['ten hang', 'ten sp', 'ten san pham'].includes(fold(plainText(cellAt(r, c))))) { found.name = c; break; }
    }
    if (hits === required.length) { best = { r, found, hits }; break; }
    if (hits > 0 && (!best || hits > best.hits)) best = { r, found, hits };
  }
  if (!best) throw importError('IMPORT_HEADERS_MISSING', `Không tìm thấy hàng tiêu đề. File cần có ${required.length} cột: ${required.map(key => COLUMNS[key].label).join(', ')}.`);
  const missing = required.filter(key => best.found[key] === undefined).map(key => COLUMNS[key].label);
  if (missing.length) throw importError('IMPORT_HEADERS_MISSING', `File thiếu cột: ${missing.join(', ')}.`);

  const rows = [];
  for (let r = best.r + 1; r <= range.e.r; r += 1) {
    const line = {
      row: r + 1,
      code: plainText(cellAt(r, best.found.code)),
      name: best.found.name === undefined ? '' : plainText(cellAt(r, best.found.name)),
      notes: plainText(cellAt(r, best.found.notes)),
      arrivalDate: requireArrivalDate && best.found.arrivalDate !== undefined ? dateText(cellAt(r, best.found.arrivalDate), now) : '',
      location: plainText(cellAt(r, best.found.location))
    };
    if (line.code || line.notes || line.arrivalDate || line.location) rows.push(line);
  }
  if (!rows.length) throw importError('IMPORT_EMPTY_FILE', 'File không có dòng dữ liệu nào dưới hàng tiêu đề.');
  return rows;
}

module.exports = { parseImportWorkbook, fold, COLUMNS };
