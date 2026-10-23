'use strict';
const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { createRepository } = require('./cashbookRepository');
const { parseFilters, invalid } = require('./cashbookFilters');
const fuzzySearch = require('../public/shared/fuzzy-search.js');

const BALANCE_MONEY_FIELDS = new Set(['balance', 'balanceHanoi', 'balanceSaigon']);

// Khớp renderBalances / sortedBalances trong public/cashbook/index.html.
function filterAndSortBalances(rows, { q, group, sortField, sortDir }) {
  const query = typeof q === 'string' ? q : '';
  const wantedGroup = typeof group === 'string' ? group : '';
  let result = rows.filter((row) => !wantedGroup || (row.accountGroup || 'Khác') === wantedGroup);
  if (fuzzySearch.tokens(query).length) {
    result = fuzzySearch.filter(result, query, (row) =>
      [row.name, row.accountNo, row.description, row.accountGroup].join(' '));
  }
  if (!sortField || !['asc', 'desc'].includes(sortDir)) return result;
  const value = (row) => {
    if (BALANCE_MONEY_FIELDS.has(sortField)) return row[sortField] == null ? null : Number(row[sortField]);
    if (sortField === 'accountNo') return String(row.accountNo || row.name || '');
    if (sortField === 'accountGroup') return String(row.accountGroup || 'Khác');
    return String(row[sortField] == null ? '' : row[sortField]);
  };
  const sign = sortDir === 'asc' ? 1 : -1;
  return result
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      const emptyA = a.v == null || a.v === '';
      const emptyB = b.v == null || b.v === '';
      if (emptyA !== emptyB) return emptyA ? 1 : -1;
      const c = typeof a.v === 'number'
        ? a.v - b.v
        : String(a.v).localeCompare(String(b.v), 'vi', { numeric: true, sensitivity: 'base' });
      return c ? sign * c : a.index - b.index;
    })
    .map((entry) => entry.row);
}
const {
  createExportFile,
  selectedColumns,
  MAX_EXPORT_ROWS,
  tooManyRows,
} = require('./cashbookExport');
function createCashbookRouter({ repository = createRepository() } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const view = [requireAuth, requireFeature('cashbook.view')];
  function handle(fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (e) {
        if (e.statusCode === 400)
          return res.status(400).json({ error: e.message, code: e.code });
        console.error(`[cashbook ${req.method} ${req.path}]`, e);
        return res.status(500).json({
          error: 'Lỗi hệ thống, vui lòng thử lại sau.',
          code: 'CASHBOOK_ERROR',
        });
      }
    };
  }
  router.get(
    '/sync-status',
    ...view,
    handle(async (req, res) => res.json(await repository.syncStatus())),
  );
  router.get(
    '/summary',
    ...view,
    handle(async (req, res) =>
      res.json(await repository.summary(parseFilters(req.query))),
    ),
  );
  router.get(
    '/entries',
    ...view,
    handle(async (req, res) =>
      res.json(await repository.entries(parseFilters(req.query))),
    ),
  );
  router.get(
    '/filter-options',
    ...view,
    handle(async (req, res) => {
      parseFilters(req.query);
      res.json(await repository.filterOptions());
    }),
  );
  router.get(
    '/export',
    ...view,
    handle(async (req, res) => {
      const {
        view: which, format = 'xlsx', columns,
        balanceQ, balanceGroup, balanceSortField, balanceSortDir,
        ...query
      } = req.query;
      selectedColumns(which, columns);
      if (!['xlsx', 'html'].includes(format))
        throw invalid('Định dạng xuất không hợp lệ.');
      const f = parseFilters(query);
      let rows;
      if (which === 'balances') {
        // Bảng Số dư lọc/sắp ngay trên màn hình (từ khóa, nhóm, cột bấm): file xuất đúng các dòng đang hiện.
        rows = filterAndSortBalances((await repository.summary(f)).balances, {
          q: balanceQ, group: balanceGroup, sortField: balanceSortField, sortDir: balanceSortDir,
        });
      } else {
        const r = await repository[which](f, {
          exportLimit: MAX_EXPORT_ROWS + 1,
        });
        if (r.total > MAX_EXPORT_ROWS) throw tooManyRows();
        rows = r[which];
      }
      const day = (iso) =>
        new Date(+new Date(iso) + 7 * 3600000).toISOString().slice(0, 10).split('-').reverse().join('/');
      const file = await createExportFile(which, format, rows, columns, {
        period: `${day(f.from)} – ${day(f.to)}`,
      });
      res.set('Content-Type', file.mimeType);
      res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.send(file.buffer);
    }),
  );
  return router;
}
const router = createCashbookRouter();
module.exports = router;
module.exports.createCashbookRouter = createCashbookRouter;
