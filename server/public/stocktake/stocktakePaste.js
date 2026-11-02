/* Hieu du lieu dan tu Google Sheets cho trang Kiem ke (2 cot: Ma SP + gia tri, cach nhau bang tab).
   Dung chung trinh duyet (window.TKSStocktakePaste) va server (require) de hai ben hieu giong nhau. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakePaste = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PASTE_COLUMNS = Object.freeze({
    statusText: { label: 'Trạng thái', kind: 'text', max: 200 },
    reasonText: { label: 'Chi tiết lý do', kind: 'text', max: 1000 },
    printPage: { label: 'Trang in', kind: 'text', max: 50 },
    printTime: { label: 'Giờ in', kind: 'text', max: 50 },
    recheck: { label: 'Người kiểm lại', kind: 'recheck', max: 200 },
    cluster: { label: 'Cụm SP', kind: 'text', max: 200 },
    combo: { label: 'Combo', kind: 'combo' },
    prevDiffManual: { label: 'KK trước sai', kind: 'number' },
    otherDiffManual: { label: 'Kiểm SG / Kiểm HN', kind: 'number' }
  });
  // Mau danh dau Trang thai cua tung ma (khoa luu DB -> nhan + mau to o Excel). '' = khong mau.
  const STATUS_COLORS = Object.freeze({
    red: { label: 'Đỏ', argb: 'FFFCA5A5' },
    orange: { label: 'Cam', argb: 'FFFDBA74' },
    yellow: { label: 'Vàng', argb: 'FFFDE68A' },
    green: { label: 'Xanh lá', argb: 'FF86EFAC' },
    cyan: { label: 'Xanh cyan', argb: 'FF67E8F9' },
    blue: { label: 'Xanh dương', argb: 'FF93C5FD' },
    purple: { label: 'Tím', argb: 'FFC4B5FD' },
    gray: { label: 'Xám', argb: 'FFD1D5DB' }
  });
  const MAX_ABS = 1e12;
  const COMBO_YES = new Set(['x', 'true', '1', 'co']);

  const codeKey = value => String(value ?? '').replace(/\s+/gu, '').toUpperCase();
  const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const foldName = value => clean(value).normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase();

  // "1.234" / "-1.234.567" (cham hang nghin), "-1,5" (phay thap phan), "1234", "12.5".
  function parseVnNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let text = String(value ?? '').replace(/\s+/gu, '');
    if (!text) return null;
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/u.test(text)) text = text.replace(/\./gu, '').replace(',', '.');
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/u.test(text)) text = text.replace(/,/gu, '');
    else if (/^-?\d+,\d+$/u.test(text)) text = text.replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/u.test(text)) return null;
    const n = Number(text);
    return Number.isFinite(n) && Math.abs(n) <= MAX_ABS ? n : null;
  }

  const parseComboFlag = value => COMBO_YES.has(foldName(value));

  function normalizeValue(column, raw) {
    const spec = PASTE_COLUMNS[column];
    if (!spec) return { ok: false };
    const text = clean(raw);
    if (spec.kind === 'number') {
      if (!text) return { ok: true, value: null, empty: true };
      const n = parseVnNumber(text);
      return n === null ? { ok: false } : { ok: true, value: n, empty: false };
    }
    if (spec.kind === 'combo') return { ok: true, value: parseComboFlag(text), empty: !text };
    if (spec.max && text.length > spec.max) return { ok: false };
    return { ok: true, value: text, empty: !text };
  }

  // Dong dau la tieu de khi o ma khong phai ma da biet VA o gia tri khong hop le voi cot dich.
  function parsePasteText(text, { isKnownCode = () => true, column } = {}) {
    const lines = String(text ?? '').split(/\r?\n/u);
    const byCode = new Map();
    let duplicates = 0;
    let firstContent = true;
    lines.forEach(line => {
      if (!line.trim()) return;
      const isFirst = firstContent;
      firstContent = false;
      const cells = line.split('\t');
      const code = codeKey(cells[0]);
      const value = clean(cells.slice(1).join(' '));
      if (!code) return;
      if (isFirst && !isKnownCode(code)) {
        const check = normalizeValue(column, value);
        if (!check.ok || PASTE_COLUMNS[column].kind !== 'number') return;
      }
      if (byCode.has(code)) { duplicates += 1; byCode.delete(code); }
      byCode.set(code, value);
    });
    return { rows: [...byCode].map(([code, value]) => ({ code, value })), duplicates };
  }

  return { PASTE_COLUMNS, STATUS_COLORS, codeKey, foldName, parseVnNumber, parseComboFlag, normalizeValue, parsePasteText };
});
