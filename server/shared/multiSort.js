'use strict';

// SQL expressions come exclusively from the caller's catalog, never from query input.
function normalizeSorts(value, allowed, legacyKey, legacyDir) {
  let source = value;
  if (source === undefined || source === null || source === '') {
    source = legacyKey ? [{ key: legacyKey, dir: legacyDir === 'desc' ? 'desc' : 'asc' }] : [];
  } else if (typeof source === 'string') {
    if (source.length > 24000) return [];
    try { source = JSON.parse(source); } catch (_) { return []; }
  }
  if (!Array.isArray(source) || source.length > 200) return [];
  const accepts = key => allowed instanceof Set ? allowed.has(key)
    : Array.isArray(allowed) ? allowed.includes(key) : Object.prototype.hasOwnProperty.call(allowed, key);
  const seen = new Set();
  return source.filter(item => {
    if (!item || typeof item.key !== 'string' || !['asc', 'desc'].includes(item.dir) || !accepts(item.key) || seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  }).map(({ key, dir }) => ({ key, dir }));
}

function orderBy(sorts, allowed) {
  return normalizeSorts(sorts, allowed).map(({ key, dir }) => `${allowed[key]} ${dir.toUpperCase()} NULLS LAST`).join(', ');
}

function normalizeSortsStrict(value, allowed, legacyKey, legacyDir) {
  if (value === undefined) return normalizeSorts(value, allowed, legacyKey, legacyDir);
  const invalid = () => Object.assign(new Error('Cột hoặc chiều sắp xếp không hợp lệ.'), { statusCode: 400, code: 'INVALID_SORT' });
  let parsed = value;
  if (typeof parsed === 'string') {
    if (parsed.length > 24000) throw invalid();
    try { parsed = JSON.parse(parsed); } catch (_) { throw invalid(); }
  }
  if (!Array.isArray(parsed) || parsed.length > 200) throw invalid();
  const result = normalizeSorts(parsed, allowed);
  if (result.length !== parsed.length) throw invalid();
  return result;
}

module.exports = { normalizeSorts, normalizeSortsStrict, orderBy };
