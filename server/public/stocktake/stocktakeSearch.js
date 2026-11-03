/* Tim kiem trang Kiem ke, chuyen tu tool tra-cuu-vi-tri (Index.html: normalizeText / searchProducts).
   Dung chung trinh duyet (window.TKSStocktakeSearch) va Node (test). Fuse.js truyen vao tu ngoai (window.Fuse). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakeSearch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Khop mo chi bu cho du FUZZY_LIMIT dong; khop chac chan (muc 1-7) khong bi cat.
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

  // 1 ma dung · 2 ten dung · 3 ma bat dau · 4 ten bat dau · 5 ma chua · 6 ten chua ca cum · 7 du moi tu · roi Fuse.
  function rank(entry, queryText, queryCode, tokens) {
    const { code, name, text } = entry;
    if (queryCode && code === queryCode) return [1, code.length];
    if (queryText && name === queryText) return [2, name.length];
    if (queryCode && code.startsWith(queryCode)) return [3, code.length];
    if (queryText && name.startsWith(queryText)) return [4, name.length];
    if (queryCode && code.includes(queryCode)) return [5, code.indexOf(queryCode)];
    if (queryText && name.includes(queryText)) return [6, name.indexOf(queryText)];
    if (tokens.length && tokens.every(token => text.includes(token))) return [7, tokens.reduce((sum, token) => sum + text.indexOf(token), 0)];
    return null;
  }

  function search(index, query) {
    const queryText = normalizeText(query);
    const queryCode = normalizeCode(query);
    if (!queryText && !queryCode) return index.entries.map(entry => entry.row);
    const tokens = queryText.split(' ').filter(Boolean);
    const ranked = [];
    for (const entry of index.entries) {
      const hit = rank(entry, queryText, queryCode, tokens);
      if (hit) ranked.push({ entry, priority: hit[0], tie: hit[1] });
    }
    ranked.sort((a, b) => a.priority - b.priority || a.tie - b.tie || a.entry.order - b.entry.order);
    const result = ranked.map(item => item.entry.row);
    if (index.fuse && result.length < FUZZY_LIMIT) {
      const seen = new Set(ranked.map(item => item.entry));
      const fuzzy = new Map();
      const add = value => {
        if (!value) return;
        for (const hit of index.fuse.search(value, { limit: FUZZY_LIMIT * 2 })) {
          if (seen.has(hit.item)) continue;
          const score = hit.score ?? 1;
          const old = fuzzy.get(hit.item);
          if (old === undefined || score < old) fuzzy.set(hit.item, score);
        }
      };
      add(queryText);
      if (queryCode !== queryText) add(queryCode);
      const extra = [...fuzzy].sort((a, b) => a[1] - b[1] || a[0].order - b[0].order).slice(0, FUZZY_LIMIT - result.length);
      result.push(...extra.map(([entry]) => entry.row));
    }
    return result;
  }

  return { FUZZY_LIMIT, normalizeText, normalizeCode, buildIndex, search };
});
