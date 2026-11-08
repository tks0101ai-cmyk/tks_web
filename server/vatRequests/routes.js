'use strict';

// /api/vat-requests/* — trang "Kế toán – ORDER VAT" (thay sheet ORDER VAT 1).
// Moi route can accounting.vatRequest; luat sua theo truong / khoa / version nam trong service.

const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { resolveBranch } = require('../branch/branchMiddleware');
const { STATUSES, createVatRequestService } = require('./service');
const { createVatRequestSuggestions } = require('./suggestions');
const { createVatRequestWorkbook } = require('./export');
const { wantsPage } = require('../shared/tablePage');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function readFilters(query = {}) {
  const statuses = String(query.status || '').split(',').map(s => s.trim()).filter(s => STATUSES.includes(s));
  const pick = value => String(value || '').trim();
  return {
    statuses,
    createdBy: pick(query.createdBy) || null,
    productKey: pick(query.product).toLowerCase() || null,
    q: pick(query.q).slice(0, 100) || null,
    from: DATE_RE.test(pick(query.from)) ? pick(query.from) : null,
    to: DATE_RE.test(pick(query.to)) ? pick(query.to) : null,
    // Dong KT vua sua (giu lai tren bang du khong con khop bo loc); toi da 500 id.
    keep: [...new Set(String(query.keep || '').split(',').map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 500),
    // Chi khi client gui page/pageSize (client cu khong gui -> tra du danh sach nhu truoc). Sap xep duoc loc
    // whitelist o service theo quyen; page / pageSize duoc kep o tablePage.pageRows.
    ...(wantsPage(query) ? { paging: { page: query.page, pageSize: query.pageSize, sorts: query.sorts, group: query.group === 'product' } } : {})
  };
}

function createVatRequestRouter({ service = createVatRequestService(), customerSearch, priceSearch } = {}) {
  const router = express.Router();
  let suggestions;
  const suggestionService = () => (suggestions ||= createVatRequestSuggestions());
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  router.use(requireAuth, requireFeature('accounting.vatRequest'));

  function handle(fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error && error.statusCode && error.statusCode < 500) {
          const body = { error: error.message, code: error.code };
          if (error.latest) body.latest = error.latest;
          if (error.conflictIds) body.conflictIds = error.conflictIds;
          if (error.field) body.field = error.field;
          if (error.errors) body.errors = error.errors;
          return res.status(error.statusCode).json(body);
        }
        console.error('[vat-requests]', error);
        return res.status(500).json({ error: 'Lỗi máy chủ khi xử lý ORDER VAT.', code: 'VAT_REQUEST_FAILED' });
      }
    };
  }

  const idParam = req => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) throw Object.assign(new Error('Mã yêu cầu không hợp lệ.'), { statusCode: 400, code: 'VALIDATION' });
    return id;
  };

  router.get('/', handle(async (req, res) => {
    res.json(await service.list(req.user, readFilters(req.query)));
  }));
  // Phai dat truoc '/:id'. Header X-Export-Truncated bao trang khi vuot gioi han dong cua list.
  router.get('/export', handle(async (req, res) => {
    const list = await service.exportList(req.user, readFilters(req.query));
    const file = await createVatRequestWorkbook(list);
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.set('X-Export-Truncated', list.truncated ? '1' : '0');
    res.send(file.buffer);
  }));
  router.get('/product-suggest', handle(async (req, res) => {
    res.json({ results: await service.suggestProducts(req.query.q, req.query.limit) });
  }));
  router.get('/customer-suggest', resolveBranch, handle(async (req, res) => {
    res.json(await (customerSearch || suggestionService().customers)(req.branch, req.query.q, req.query.limit));
  }));
  router.get('/price-suggest', handle(async (req, res) => {
    const code = String(req.query.code || '').trim().slice(0, 60);
    if (!code) return res.status(400).json({ error: 'Chưa chọn mã SP.', code: 'VALIDATION' });
    res.json(await (priceSearch || suggestionService().prices)(code));
  }));
  router.get('/metrics', handle(async (req, res) => {
    res.json(await service.productMetrics(req.user, String(req.query.code || '')));
  }));
  router.post('/', handle(async (req, res) => {
    res.status(201).json(await service.create(req.user, req.body));
  }));
  // Form nhieu dong: { submissionId, items: [...] } -> tao nhieu yeu cau trong 1 transaction.
  router.post('/batch', handle(async (req, res) => {
    const result = await service.createMany(req.user, req.body);
    res.status(result.duplicate ? 200 : 201).json(result);
  }));
  router.post('/lookup', handle(async (req, res) => {
    res.json(await service.lookupProducts(req.user, req.body && req.body.codes));
  }));
  router.patch('/bulk', handle(async (req, res) => {
    res.json(await service.bulkUpdate(req.user, req.body));
  }));
  // KT keo 1 / nhieu dong doi thu tu chung: { ids, belowId } | { ids, aboveId }. Phai dat truoc '/:id'.
  router.patch('/position', handle(async (req, res) => {
    res.json(await service.move(req.user, req.body));
  }));
  // Hoan tac / lam lai keo dong: { ranks: { id: 'numeric' } } (hang cu / moi do /position tra ve).
  router.patch('/position/ranks', handle(async (req, res) => {
    res.json(await service.restoreRanks(req.user, req.body));
  }));
  router.get('/:id', handle(async (req, res) => {
    res.json(await service.get(req.user, idParam(req)));
  }));
  router.patch('/:id', handle(async (req, res) => {
    res.json(await service.update(req.user, idParam(req), req.body));
  }));
  router.delete('/:id', handle(async (req, res) => {
    res.json(await service.remove(req.user, idParam(req), req.query.version ?? (req.body && req.body.version)));
  }));
  router.get('/:id/history', handle(async (req, res) => {
    res.json({ rows: await service.history(req.user, idParam(req)) });
  }));

  return router;
}

module.exports = { createVatRequestRouter, readFilters };
