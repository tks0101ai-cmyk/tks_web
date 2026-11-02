(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TKSFuzzySearch = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Bỏ dấu tiếng Việt, hạ chữ thường, gom khoảng trắng.
  function fold(value) {
    return String(value == null ? '' : value)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'd')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function tokens(query) {
    const folded = fold(query);
    return folded ? folded.split(' ') : [];
  }

  // Kết quả phải chứa MỌI từ của từ khóa (không còn ngưỡng 80%): 1 từ -> 1, 5 từ -> 5.
  function requiredMatches(count) {
    return count;
  }

  // Từ khóa có dấu (vd "khả", "hân") phải khớp ĐÚNG dấu trong văn bản; từ khóa không dấu vẫn khớp cả
  // chữ có dấu lẫn không dấu. Tránh "khả hân" ra cả "Khanh" (kha + han nằm trong "khanh").
  function lowerKeepAccent(value) {
    return String(value == null ? '' : value).normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function compile(query) {
    const raw = lowerKeepAccent(query);
    const words = raw ? raw.split(' ').map(function (word) {
      const plain = fold(word);
      return { raw: word, plain: plain, accented: plain !== word };
    }) : [];
    return { words: words, plain: words.map(function (word) { return word.plain; }).join(' ') };
  }

  // Điểm khớp: 0 = không hiện. Khớp nhiều từ hơn điểm cao hơn, khớp nguyên cụm cao nhất.
  function scoreCompiled(haystack, compiled) {
    const words = compiled.words;
    if (!words.length) return 1;
    const folded = fold(haystack);
    let lowered = null;
    let matched = 0;
    for (const word of words) {
      if (word.accented) {
        if (lowered === null) lowered = lowerKeepAccent(haystack);
        if (lowered.indexOf(word.raw) !== -1) matched += 1;
      } else if (folded.indexOf(word.plain) !== -1) matched += 1;
    }
    if (matched < requiredMatches(words.length)) return 0;
    return matched + (folded.indexOf(compiled.plain) !== -1 ? words.length + 1 : 0);
  }

  function score(haystack, query) {
    return scoreCompiled(haystack, compile(query));
  }

  function matches(haystack, query) {
    return score(haystack, query) > 0;
  }

  // Lọc + xếp: khớp nhiều từ trước, giữ thứ tự gốc khi điểm bằng nhau.
  function filter(items, query, getText) {
    const compiled = compile(query);
    if (!compiled.words.length) return items.slice();
    const pick = typeof getText === 'function' ? getText : function (item) { return item; };
    return items
      .map(function (item, index) { return { item: item, index: index, score: scoreCompiled(pick(item), compiled) }; })
      .filter(function (entry) { return entry.score > 0; })
      .sort(function (a, b) { return b.score - a.score || a.index - b.index; })
      .map(function (entry) { return entry.item; });
  }

  return { fold: fold, tokens: tokens, requiredMatches: requiredMatches, score: score, matches: matches, filter: filter };
});
