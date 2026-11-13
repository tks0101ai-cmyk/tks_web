'use strict';
// Tim gan dung ngay trong SQL (cung luat voi shared/fuzzySearch.js): bo dau + hoa thuong, MOI tu cua cau tim phai khop; diem = so tu khop (+ so tu + 1 neu khop nguyen cum) de xep truoc.
// Dung khi bang lon, can loc + phan trang + tong ngay o Postgres. Chi truyen tu khoa qua tham so.
const fuzzy = require('./fuzzySearch');

const VN_FROM = 'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ';
const VN_TO = 'a'.repeat(17) + 'e'.repeat(11) + 'i'.repeat(5) + 'o'.repeat(17) + 'u'.repeat(11) + 'y'.repeat(5) + 'd';
const foldSql = (expression) => `translate(lower(${expression}), '${VN_FROM}', '${VN_TO}')`;

/**
 * @param {string} expression  bieu thuc SQL van ban (co the NULL; se COALESCE)
 * @param {string} query       cau tim cua nguoi dung
 * @param {(value:any)=>string} add  them tham so, tra ve placeholder ($n)
 * @param {{folded?: boolean}} [options]  folded=true: `expression` DA la foldSql(COALESCE(...,'')) tinh san 1 lan / dong
 *   (vd cot cua CTE) -> khong boc translate lai cho tung tu (translate tieng Viet ~70 us / lan: 12k dong x 5 lan = 4,4 s, 13/11/2026)
 * @returns {{where:string, score:string}|null}  null khi cau tim rong
 */
function fuzzySqlParts(expression, query, add, { folded = false } = {}) {
  const words = fuzzy.tokens(query);
  if (!words.length) return null;
  const text = folded ? expression : foldSql(`COALESCE(${expression},'')`);
  const holders = words.map((w) => add(w));
  const hits = holders.map((p) => `(position(${p} in ${text})>0)::int`);
  const matched = `(${hits.join('+')})`;
  // 1 tu: cum = chinh tu do (dung lai tham so). Nhieu tu: them tham so cum, ghim vao WHERE de truy van
  // khong dung diem (COUNT, tong) van khong co tham so thua kieu.
  const phrase = words.length === 1 ? holders[0] : add(words.join(' '));
  const pin = words.length === 1 ? '' : ` AND ${phrase}::text IS NOT NULL`;
  const where = `${matched}>=${fuzzy.requiredMatches(words.length)}${pin}`;
  const score = `(${matched}+CASE WHEN position(${phrase} in ${text})>0 THEN ${words.length + 1} ELSE 0 END)`;
  return { where, score };
}

module.exports = { foldSql, fuzzySqlParts, VN_FROM, VN_TO };
