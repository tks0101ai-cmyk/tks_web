/* Gia tri 9 cot nhap tay cua trang Kiem ke (doc so kieu VN, chuan hoa, so sanh, dao nguoc de hoan tac).
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
    // Hoan tac gui lai so that (vd 1.234): khong doc lai bang parseVnNumber (se thanh 1234).
    if (spec.kind === 'number' && typeof raw === 'number') {
      return Number.isFinite(raw) && Math.abs(raw) <= MAX_ABS ? { ok: true, value: raw, empty: false } : { ok: false };
    }
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

  // Gia tri hien tai cua 1 cot dan tren 1 ma, cung dang normalizeValue().value.
  // note: ban ghi ghi chu (hoac null), tag: { cluster, isCombo } (hoac null), nameOf: id nhan su -> ten.
  function columnValue(column, note, tag, nameOf = () => '') {
    const n = note || {};
    switch (column) {
      case 'recheck': {
        const id = n.recheckEmployeeId;
        return (id !== null && id !== undefined && nameOf(id)) || n.recheckName || '';
      }
      case 'cluster': return (tag && tag.cluster) || '';
      case 'combo': return Boolean(tag && tag.isCombo);
      case 'prevDiffManual': case 'otherDiffManual': return n[column] === null || n[column] === undefined ? null : n[column];
      default: return n[column] || '';
    }
  }

  function sameValue(column, a, b) {
    const spec = PASTE_COLUMNS[column];
    if (!spec) return false;
    if (spec.kind === 'number') return (a ?? null) === (b ?? null);
    if (spec.kind === 'combo') return Boolean(a) === Boolean(b);
    if (spec.kind === 'recheck') return foldName(a) === foldName(b);
    return clean(a) === clean(b);
  }

  // Nguoc cua normalizeValue: gia tri -> du lieu tho gui lai server (hoan tac).
  function rawOf(column, value) {
    const spec = PASTE_COLUMNS[column];
    if (spec && spec.kind === 'combo') return value ? 'x' : '';
    if (value === null || value === undefined) return '';
    return spec && spec.kind === 'number' ? value : String(value);
  }

  return { PASTE_COLUMNS, codeKey, foldName, parseVnNumber, parseComboFlag, normalizeValue, columnValue, sameValue, rawOf };
});
