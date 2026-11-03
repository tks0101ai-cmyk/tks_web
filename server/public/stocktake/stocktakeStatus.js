/* Trang thai kiem ke: 7 loai co dinh (mau tu dong), xep loai chu cu (dot nap tu sheet), ten chuan khi luu, tong theo loai cho the.
   Dung chung trinh duyet (window.TKSStocktakeStatus), server va xuat Excel (require) de hai ben hieu giong nhau. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakeStatus = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Thu tu hien thi (the, danh sach chon, bo loc). 'pending' (Chua XL) = o trong, khong luu chu "Chưa XL".
  const STATUS_TYPES = Object.freeze([
    Object.freeze({ key: 'lost', label: 'Mất', color: '#F87171' }),
    Object.freeze({ key: 'previous', label: 'KK trước', color: '#C8963E' }),
    Object.freeze({ key: 'ok', label: 'OK', color: '#EEFF41' }),
    Object.freeze({ key: 'wrong', label: 'Nhầm SG', labelSaigon: 'Nhầm HN', color: '#C4B5FD' }),
    Object.freeze({ key: 'surplus', label: 'Thừa', color: '#F9A8D4' }),
    Object.freeze({ key: 'mixed', label: 'Lẫn', color: '#67E8F9' }),
    Object.freeze({ key: 'pending', label: 'Chưa XL', color: '#FFFFFF' })
  ]);
  const OTHER = Object.freeze({ key: 'other', label: 'Khác', color: '' });
  const BY_KEY = new Map(STATUS_TYPES.map(type => [type.key, type]));
  // Tu khoa nguyen tu (sau khi gap chu); chu cu nhieu y ("Lẫn+kk trước") lay tu khoa xuat hien som nhat.
  const KEYWORDS = Object.freeze([
    ['ok', 'ok'], ['mat', 'lost'], ['kk truoc', 'previous'], ['kk', 'previous'], ['nham', 'wrong'], ['thua', 'surplus'], ['lan', 'mixed']
  ]);

  // "Lẫn+KK trước" -> "lan kk truoc": thuong, bo dau, d, ky tu khac chu/so -> khoang trang.
  const fold = value => String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  function labelFor(key, branch) {
    if (key === OTHER.key) return OTHER.label;
    const type = BY_KEY.get(key);
    if (!type) return '';
    return branch === 'saigon' && type.labelSaigon ? type.labelSaigon : type.label;
  }

  const optionsFor = branch => STATUS_TYPES.map(type => ({ key: type.key, label: labelFor(type.key, branch), color: type.color }));

  function classify(text) {
    const folded = fold(text);
    if (!folded || folded === 'chua xl') return 'pending';
    if (folded === 'nham sg' || folded === 'nham hn') return 'wrong';
    const exact = STATUS_TYPES.find(type => fold(type.label) === folded);
    if (exact) return exact.key;
    const padded = ' ' + folded + ' ';
    let best = null;
    for (const [word, key] of KEYWORDS) {
      const at = padded.indexOf(' ' + word + ' ');
      if (at >= 0 && (!best || at < best.at)) best = { at, key };
    }
    return best ? best.key : OTHER.key;
  }

  // Chu de luu khi nguoi dung chon / dan / keo: ten chuan theo co so; Chua XL -> ''; khong xep duoc loai -> null.
  function canonical(text, branch) {
    const key = classify(text);
    if (key === 'pending') return '';
    return key === OTHER.key ? null : labelFor(key, branch);
  }

  const isValid = (text, branch) => text === '' || canonical(text, branch) === text;

  function colorOf(text) {
    const key = classify(text);
    return key === 'pending' || key === OTHER.key ? '' : BY_KEY.get(key).color;
  }

  // Tong theo loai tren moi dong (khong theo bo loc): so ma + tong gia tri chenh co dau.
  function summarize(rows) {
    const totals = new Map(STATUS_TYPES.map(type => [type.key, { count: 0, diffValue: 0 }]));
    for (const row of rows || []) {
      const key = classify(row && row.note ? row.note.statusText : '');
      if (!totals.has(key)) totals.set(key, { count: 0, diffValue: 0 });
      const entry = totals.get(key);
      entry.count += 1;
      entry.diffValue += Number(row && row.diffValue) || 0;
    }
    return totals;
  }

  return { STATUS_TYPES, OTHER, fold, labelFor, optionsFor, classify, canonical, isValid, colorOf, summarize };
});
