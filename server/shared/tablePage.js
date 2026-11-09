'use strict';
// Pagination of complete derived snapshots. Call only after authorization/filtering.
const { normalizeSorts } = require('./multiSort');
const { filterTableItems } = require('../public/js/table-explorer');
const positive = (value, fallback, max) => /^\d+$/.test(String(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;
const wantsPage = (query = {}) => query.page !== undefined || query.pageSize !== undefined;
function pageRows(rows, query = {}) {
  const pageSize = positive(query.pageSize, 100, 500);
  const page = Math.min(positive(query.page, 1, Number.MAX_SAFE_INTEGER), Math.max(1, Math.ceil(rows.length / pageSize)));
  return { rows: rows.slice((page - 1) * pageSize, page * pageSize), totalRows: rows.length, page, pageSize };
}
function sortRows(rows, sorts, catalog) {
  const normalized = normalizeSorts(sorts, catalog);
  if (!normalized.length) return rows;
  return rows.map((row, index) => ({ row, index })).sort((a, b) => {
    for (const { key, dir } of normalized) {
      const av = catalog[key](a.row), bv = catalog[key](b.row);
      const ae = av == null || av === '' || (typeof av === 'number' && !Number.isFinite(av));
      const be = bv == null || bv === '' || (typeof bv === 'number' && !Number.isFinite(bv));
      if (ae !== be) return ae ? 1 : -1;
      if (ae) continue;
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'vi', { numeric: true, sensitivity: 'base' });
      if (cmp) return dir === 'desc' ? -cmp : cmp;
    }
    return a.index - b.index;
  }).map(item => item.row);
}
function searchRows(rows, query, config) {
  const result = filterTableItems(rows, config, { mode: query.qmode === 'codes' ? 'codes' : 'normal', query: query.q || '' });
  return { rows: result.items, search: { requestedCodes: result.requestedCodes || [], missingCodes: result.missingCodes || [] } };
}
function rowText(value) {
  if (value == null) return '';
  if (typeof value === 'object') return Object.values(value).map(rowText).join(' ');
  return String(value);
}
function scalarCatalog(rows) {
  const keys = new Set(rows.flatMap(row => Object.keys(row).filter(key => row[key] == null || ['string', 'number', 'boolean'].includes(typeof row[key]))));
  return Object.fromEntries([...keys].map(key => [key, row => row[key]]));
}
module.exports = { wantsPage, pageRows, sortRows, searchRows, rowText, scalarCatalog };
