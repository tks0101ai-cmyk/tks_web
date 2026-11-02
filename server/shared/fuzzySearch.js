'use strict';
// Tim gan dung phia may chu — dung CHUNG luat voi giao dien (public/shared/fuzzy-search.js):
// MOI tu cua cau tim phai khop (AND); khop nhieu tu xep truoc, nguyen cum xep dau;
// bo dau / hoa thuong (tu co dau phai dung dau; chi ap dung khi dung score/matches/filter tren van ban goc). Them createMatcher() de loc ~60 nghin dong: tach tu cua cau tim 1 lan, con van ban
// cua dong da duoc chuan hoa san (fold) nen moi dong chi con vai lan indexOf.
const fuzzy = require('../public/shared/fuzzy-search.js');

/** Tra ve { empty, score(foldedText) }. foldedText PHAI di qua fuzzy.fold truoc (de dong tu bo nho dem). */
function createMatcher(query) {
  const words = fuzzy.tokens(query);
  const required = fuzzy.requiredMatches(words.length);
  const phrase = words.join(' ');
  return {
    empty: words.length === 0,
    score(foldedText) {
      if (!words.length) return 1;
      let matched = 0;
      for (let i = 0; i < words.length; i += 1) if (foldedText.indexOf(words[i]) !== -1) matched += 1;
      if (matched < required) return 0;
      return matched + (foldedText.indexOf(phrase) !== -1 ? words.length + 1 : 0);
    }
  };
}

module.exports = Object.assign({ createMatcher }, fuzzy);
