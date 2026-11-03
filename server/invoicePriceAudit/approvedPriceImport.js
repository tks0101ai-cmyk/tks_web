'use strict';

// Doc + kiem tra file import bang "Gia duyet" (xlsx/xls/csv) bang SheetJS, mau stockPositionsImport.js.
// Cot bat buoc: Ma KH, Co so, Ma SP, Nguoi duyet, Ngay duyet va it nhat 1 trong 2 cot Gia khong VAT / Gia co VAT (khop ten cot khong
// phan biet hoa/thuong va dau; cot thua nhu Khach hang / Ten SP bo qua nen co the sua truc tiep file "Xuat file" roi nhap lai).
// Thuan (khong cham DB): doc file -> dong tho -> validateRow (kiem tra tung dong) de repository/route/test dung chung.

const XLSX = require('xlsx');
const rules = require('./approvedPriceRules');

const MAX_IMPORT_ROWS = 1000;
const HEADER_SCAN_ROWS = 20;

const COLUMNS = Object.freeze({
  customerCode: { label: 'Mã KH', aliases: ['ma kh', 'ma khach hang', 'ma khach', 'kh'] },
  branch: { label: 'Cơ sở', aliases: ['co so', 'chi nhanh'] },
  productCode: { label: 'Mã SP', aliases: ['ma sp', 'ma hang', 'ma san pham'] },
  priceNoVat: { label: 'Giá không VAT', aliases: ['gia khong vat', 'gia chua vat', 'gia ko vat'] },
  priceWithVat: { label: 'Giá có VAT', aliases: ['gia co vat'] },
  approver: { label: 'Người duyệt', aliases: ['nguoi duyet'] },
  approvedOn: { label: 'Ngày duyệt', aliases: ['ngay duyet'] }
});
const REQUIRED = ['customerCode', 'branch', 'productCode', 'approver', 'approvedOn'];

function importError(code, message) {
  return Object.assign(new Error(message), { statusCode: 400, code });
}

const fold = value => String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/[đĐ]/gu, 'd')
  .toLowerCase().replace(/\s+/gu, ' ').trim();

const BRANCH_ALIASES = Object.freeze({ hanoi: 'hanoi', 'ha noi': 'hanoi', hn: 'hanoi', saigon: 'saigon', 'sai gon': 'saigon', sg: 'saigon' });

function plainText(cell) {
  if (!cell || cell.v === undefined || cell.v === null) return '';
  return String(typeof cell.v === 'number' && cell.w !== undefined ? cell.w : cell.v).trim();
}

const pad2 = n => String(n).padStart(2, '0');

// Ngay: o kieu ngay cua Excel -> yyyy-mm-dd; chuoi dd/mm/yyyy (hoac d-m-yyyy, d.m.yyyy) hoac yyyy-mm-dd. Khong doan nam.
function dayText(cell) {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return '';
  if (typeof cell.v === 'number') {
    const d = XLSX.SSF.parse_date_code(cell.v);
    return d && d.y >= 1900 ? `${d.y}-${pad2(d.m)}-${pad2(d.d)}` : String(cell.v);
  }
  const text = String(cell.v).trim();
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/u.exec(text);
  if (dmy) return `${dmy[3]}-${pad2(dmy[2])}-${pad2(dmy[1])}`;
  return text;
}

// Gia: o so lay gia tri that (khong lay chuoi da dinh dang "232,000"); chuoi bo dau phan cach hang nghin (en-US "," / vi "." khi du nhom 3).
function priceValue(cell) {
  if (!cell || cell.v === undefined || cell.v === null || cell.v === '') return '';
  if (typeof cell.v === 'number') return Number.isFinite(cell.v) ? String(cell.v) : '';
  const text = String(cell.v).trim().replace(/\s+/gu, '');
  if (/^\d{1,3}([.,]\d{3})+$/u.test(text)) return text.replace(/[.,]/gu, '');
  return text.replace(',', '.');
}

// SheetJS TREO vo han khi gap .xlsx bi cat do (zip thieu "end of central directory") nen kiem tra chu ky truoc khi doc:
// .xlsx = zip co EOCD trong 64 KB cuoi; .xls = OLE2 (D0 CF 11 E0). .csv la van ban nen khong can.
function looksReadable(buffer, fileName) {
  if (/\.csv$/iu.test(fileName)) return true;
  if (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const tail = buffer.subarray(Math.max(0, buffer.length - 65557));
    return tail.includes(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  }
  return buffer.length >= 8 && buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
}

/**
 * @returns {Array<{row:number, customerCode:string, branch:string, productCode:string, priceNoVat:string, priceWithVat:string,
 *   approver:string, approvedOn:string}>} dong co du lieu (row = so dong Excel). Nem loi 400 khi file khong doc duoc / thieu cot / qua nhieu dong.
 */
function parseImportWorkbook(buffer, { fileName = '' } = {}) {
  let workbook;
  if (!looksReadable(buffer, fileName)) throw importError('IMPORT_UNREADABLE', 'Không đọc được file. Hãy dùng file .xlsx, .xls hoặc .csv.');
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

  // Hang tieu de: dong dau tien (trong 20 dong dau) co du cot bat buoc va it nhat 1 cot gia; khong co thi bao cot thieu cua dong gan dung nhat.
  let best = null;
  const lastScan = Math.min(range.e.r, range.s.r + HEADER_SCAN_ROWS - 1);
  for (let r = range.s.r; r <= lastScan; r += 1) {
    const found = {};
    for (let c = range.s.c; c <= range.e.c; c += 1) {
      const text = fold(plainText(cellAt(r, c)));
      if (!text) continue;
      for (const [key, def] of Object.entries(COLUMNS)) if (found[key] === undefined && def.aliases.includes(text)) found[key] = c;
    }
    const hasPrice = found.priceNoVat !== undefined || found.priceWithVat !== undefined;
    const hits = REQUIRED.filter(key => found[key] !== undefined).length + (hasPrice ? 1 : 0);
    if (hits === REQUIRED.length + 1) { best = { r, found, hits }; break; }
    if (hits > 0 && (!best || hits > best.hits)) best = { r, found, hits };
  }
  if (!best) {
    throw importError('IMPORT_HEADERS_MISSING', `Không tìm thấy hàng tiêu đề. File cần các cột: ${REQUIRED.map(k => COLUMNS[k].label).join(', ')} và ít nhất một trong hai cột Giá không VAT / Giá có VAT.`);
  }
  const missing = REQUIRED.filter(key => best.found[key] === undefined).map(key => COLUMNS[key].label);
  if (best.found.priceNoVat === undefined && best.found.priceWithVat === undefined) missing.push('Giá không VAT hoặc Giá có VAT');
  if (missing.length) throw importError('IMPORT_HEADERS_MISSING', `File thiếu cột: ${missing.join(', ')}.`);

  const rows = [];
  for (let r = best.r + 1; r <= range.e.r; r += 1) {
    const at = key => (best.found[key] === undefined ? undefined : cellAt(r, best.found[key]));
    const line = {
      row: r + 1,
      customerCode: plainText(at('customerCode')),
      branch: plainText(at('branch')),
      productCode: plainText(at('productCode')),
      priceNoVat: priceValue(at('priceNoVat')),
      priceWithVat: priceValue(at('priceWithVat')),
      approver: plainText(at('approver')),
      approvedOn: dayText(at('approvedOn'))
    };
    if (Object.entries(line).some(([key, value]) => key !== 'row' && value)) rows.push(line);
  }
  if (!rows.length) throw importError('IMPORT_EMPTY_FILE', 'File không có dòng dữ liệu nào dưới hàng tiêu đề.');
  if (rows.length > MAX_IMPORT_ROWS) {
    throw importError('IMPORT_TOO_MANY_ROWS', `File có ${rows.length} dòng, vượt giới hạn ${MAX_IMPORT_ROWS} dòng mỗi lần nhập. Hãy chia nhỏ file.`);
  }
  return rows;
}

/**
 * Kiem tra 1 dong tho. Tra { ok: true, value: { branch, customerCode, productCode, priceNoVat, priceWithVat, approver, approvedOn } }
 * hoac { ok: false, message }. Chua doi chieu KiotViet (viec cua repository).
 */
function validateRow(line) {
  const fail = message => ({ ok: false, message });
  const customerCode = String(line.customerCode || '').trim();
  const productCode = String(line.productCode || '').trim();
  if (!customerCode) return fail('Thiếu Mã KH.');
  if (!productCode) return fail('Thiếu Mã SP.');
  const branch = BRANCH_ALIASES[fold(line.branch)];
  if (!branch) return fail(`Cơ sở "${line.branch || ''}" không hợp lệ (Hà Nội / Sài Gòn).`);
  const approver = rules.APPROVERS.find(a => fold(a) === fold(line.approver));
  if (!approver) return fail(`Người duyệt "${line.approver || ''}" không hợp lệ (${rules.APPROVERS.join(' / ')}).`);
  if (!rules.isValidDay(line.approvedOn)) return fail(`Ngày duyệt "${line.approvedOn || ''}" không hợp lệ (cần dd/mm/yyyy).`);
  let priceNoVat;
  let priceWithVat;
  try {
    priceNoVat = rules.parsePrice(line.priceNoVat, { required: false, label: 'Giá không VAT' });
    priceWithVat = rules.parsePrice(line.priceWithVat, { required: false, label: 'Giá có VAT' });
  } catch (error) {
    return fail(error.message);
  }
  if (priceNoVat === null && priceWithVat === null) return fail('Nhập ít nhất một trong hai giá (không VAT / có VAT).');
  return { ok: true, value: { branch, customerCode, productCode, priceNoVat, priceWithVat, approver, approvedOn: line.approvedOn } };
}

module.exports = { parseImportWorkbook, validateRow, fold, COLUMNS, MAX_IMPORT_ROWS };
