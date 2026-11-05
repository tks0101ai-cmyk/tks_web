/* Tim kiem trang Kiem ke, chuyen tu tool tra-cuu-vi-tri (Index.html: normalizeText / searchProducts), khop ten chat hon:
   moi tu go la 1 cum phai lien nhau va bat dau o dau 1 tu, so cuoi cum khop tron so; Fuse chi khi khong co ma khop.
   Dung chung trinh duyet (window.TKSStocktakeSearch) va Node (test). Fuse.js truyen vao tu ngoai (window.Fuse). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakeSearch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const FUZZY_LIMIT = 100;
  const FUSE_OPTIONS = Object.freeze({
    includeScore: true, shouldSort: true, threshold: 0.36, distance: 100, ignoreLocation: true, minMatchCharLength: 2,
    keys: [{ name: 'code', weight: 0.25 }, { name: 'name', weight: 0.60 }, { name: 'extra', weight: 0.15 }]
  });
  const strip = value => String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  // "Băng keo 20cm (T9) (10KG)" -> "bang keo 20 cm t 9 10 kg"
  function normalizeText(value) {
    return strip(value)
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const normalizeCode = value => strip(value).replace(/[^a-z0-9]+/g, '');
  // Chuan hoa 1 lan khi tai bang, khong lam lai moi lan go.
  function buildIndex(items, { Fuse } = {}) {
    const entries = items.map((item, order) => {
      const name = normalizeText(item.name);
      const extra = normalizeText(item.extra);
      return { row: item.row, code: normalizeCode(item.code), name, extra, text: [name, extra].filter(Boolean).join(' '), order };
    });
    return { entries, fuse: typeof Fuse === 'function' ? new Fuse(entries, FUSE_OPTIONS) : null };
  }
  // Vi tri dau tien cum `phrase` bat dau o dau 1 tu cua `text`; cum ket thuc bang so thi sau do khong duoc la chu so
  // ("10" khong khop "100"), ket thuc bang chu thi duoc la tien to tu ("ke" khop "keo"). Khong co -> -1.
  function findPhrase(text, phrase) {
    if (!phrase) return -1;
    const wholeNumber = /\d$/.test(phrase);
    let from = 0;
    for (;;) {
      const at = text.indexOf(phrase, from);
      if (at < 0) return -1;
      const next = text[at + phrase.length];
      if ((at === 0 || text[at - 1] === ' ') && (!wholeNumber || next === undefined || !/\d/.test(next))) return at;
      from = at + 1;
    }
  }
  // 1 ma dung · 2 ten dung · 3 ma bat dau · 4 ten bat dau (theo tu) · 5 ma chua · 6 ten chua ca cum (theo tu) · 7 du moi cum go.
  function rank(entry, queryText, queryCode, groups) {
    const { code, name, text } = entry;
    if (queryCode && code === queryCode) return [1, code.length];
    if (queryText && name === queryText) return [2, name.length];
    if (queryCode && code.startsWith(queryCode)) return [3, code.length];
    const inName = queryText ? findPhrase(name, queryText) : -1;
    if (inName === 0) return [4, name.length];
    if (queryCode && code.includes(queryCode)) return [5, code.indexOf(queryCode)];
    if (inName > 0) return [6, inName];
    if (!groups.length) return null;
    let tie = 0;
    for (const group of groups) {
      const at = findPhrase(text, group);
      if (at < 0) return null;
      tie += at;
    }
    return [7, tie];
  }
  function search(index, query) {
    const queryText = normalizeText(query);
    const queryCode = normalizeCode(query);
    if (!queryText && !queryCode) return { rows: index.entries.map(entry => entry.row), fuzzy: false };
    // Moi tu go (tach theo khoang trang) la 1 cum: "10kg" -> "10 kg" phai dung lien.
    const groups = String(query ?? '').split(/\s+/).map(normalizeText).filter(Boolean);
    const ranked = [];
    for (const entry of index.entries) {
      const hit = rank(entry, queryText, queryCode, groups);
      if (hit) ranked.push({ entry, priority: hit[0], tie: hit[1] });
    }
    ranked.sort((a, b) => a.priority - b.priority || a.tie - b.tie || a.entry.order - b.entry.order);
    if (ranked.length || !index.fuse) return { rows: ranked.map(item => item.entry.row), fuzzy: false };
    const fuzzy = new Map();
    const add = value => {
      if (!value) return;
      for (const hit of index.fuse.search(value, { limit: FUZZY_LIMIT * 2 })) {
        const score = hit.score ?? 1;
        const old = fuzzy.get(hit.item);
        if (old === undefined || score < old) fuzzy.set(hit.item, score);
      }
    };
    add(queryText);
    if (queryCode !== queryText) add(queryCode);
    const rows = [...fuzzy].sort((a, b) => a[1] - b[1] || a[0].order - b[0].order).slice(0, FUZZY_LIMIT).map(([entry]) => entry.row);
    return { rows, fuzzy: rows.length > 0 };
  }
  return { FUZZY_LIMIT, normalizeText, normalizeCode, buildIndex, search };
});
