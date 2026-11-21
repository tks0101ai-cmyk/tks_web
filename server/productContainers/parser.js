'use strict';

const SHEET_NAMES = Object.freeze(['YIWU', 'VK-DUNG', 'HÀ BẮC', 'SD', 'GDONG', 'KHÁC', 'CONT TKS1']);
// Chu ky doc Sheets: 10 phut (truoc day 2 gio) de Hang du kien bam nhip dong bo KiotViet; chinh bang
// PRODUCT_CONTAINER_SYNC_INTERVAL_MS (>= 60 giay). Qua 3 chu ky khong co ban thanh cong => bao "du lieu cu".
const INTERVAL_MS = Math.max(60 * 1000, Number(process.env.PRODUCT_CONTAINER_SYNC_INTERVAL_MS) || 10 * 60 * 1000);
const STALE_AFTER_MS = 3 * INTERVAL_MS;
const text = value => String(value ?? '').trim();
const normalizeCode = value => text(value).toLowerCase();
// Ô A của dòng tiêu đề cột dưới mỗi CONT: "STT" hoặc "Mã SP / Mã sản phẩm / Mã hàng".
const HEADER_CODE = /^(?:stt|m[aã]\s*(?:sp|sản phẩm|hàng))$/i;

// Google UNFORMATTED_VALUE supplies numbers for numeric/formula cells. Accept
// plain numeric text as well, never guess locale-dependent separators.
function numeric(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\s*\d+(?:\.\d+)?\s*$/.test(value))) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parseContainerSheet(sheetName, values, formattedValues = values) {
  const rows = [];
  const warnings = [];
  let current = null;
  let blankCount = 0;
  let awaitingHeader = false;
  for (let index = 0; index < values.length; index++) {
    const row = values[index] || [];
    const display = formattedValues[index] || [];
    const code = text(display[0]) || text(row[0]);
    if (/^END$/i.test(code)) break;
    if (/^CONT\b/i.test(code)) {
      const statusText = text(row[1]);
      const match = /^([1-5])(?=\s|\.|$)/.exec(statusText);
      current = match ? { containerName: code, status: Number(match[1]), statusLabel: text(display[1]) || statusText, eta: text(display[2]), containerRow: index + 1 } : null;
      if (!current) warnings.push({ sheetName, row: index + 1, reason: 'Trạng thái CONT không hợp lệ' });
      blankCount = 0;
      awaitingHeader = true;
      continue;
    }
    if (!Array.from({ length: 25 }, (_, col) => text(display[col])).some(Boolean)) {
      if (++blankCount >= 20) current = null;
      continue;
    }
    blankCount = 0;
    if (!current || !code) continue;
    if (HEADER_CODE.test(code)) { awaitingHeader = false; continue; }
    const quantity = numeric(row[15]);
    // Cấu trúc khối: dòng CONT → dòng tiêu đề cột → dữ liệu. Dòng có mã đầu tiên dưới CONT mà cột P
    // không phải số là tiêu đề viết khác mẫu (không phải lỗi dữ liệu) nên bỏ qua, không cảnh báo.
    const firstUnderCont = awaitingHeader;
    awaitingHeader = false;
    if (quantity === null && firstUnderCont) continue;
    if (quantity === null) {
      warnings.push({ sheetName, row: index + 1, reason: 'Tổng số lượng P không hợp lệ' });
      continue;
    }
    rows.push({
      ...current, sheetName, sourceRow: index + 1,
      productCode: code, productKey: normalizeCode(code),
      // Cot G la "VAT: ghi chu" chen them, chi de nhap tay, khong doc vao he thong - vi vay cac
      // cot tu H tro di lech +1 so voi ten bien (otherNote van la cot G cu, nay o H).
      color: text(display[4]), saleNote: text(display[5]), otherNote: text(display[7]),
      orderedBy: text(display[8]), listedAt: text(display[12]),
      unitsPerPackage: numeric(row[13]), packageCount: numeric(row[14]),
      quantity, unitPriceCny: numeric(row[16]), vietnamPrice: numeric(row[24])
    });
  }
  return { rows, warnings };
}

module.exports = { SHEET_NAMES, INTERVAL_MS, STALE_AFTER_MS, normalizeCode, numeric, parseContainerSheet };
