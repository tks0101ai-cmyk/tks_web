'use strict';

// /api/vat-lookup/* — trang "Kế toán – Tra cứu VAT" (thay app Apps Script Tra cứu VAT).
// Quyen accounting.vatLookup (mac dinh Quan ly, Ke toan, Nhan vien sale). Toan cong ty,
// khong ap cookie co so. Tim kiem chay tren server: client chi gui danh sach tu khoa.

const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { createLookupSource } = require('./lookupSource');
const { parseSearchQueries, search, MAX_SEARCH_TERMS } = require('./lookupModel');

const MAX_QUERY_CHARS = 20000;

function createVatLookupRouter({ source = createLookupSource() } = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const guard = [requireAuth, requireFeature('accounting.vatLookup')];

  function handle(fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error.statusCode === 400) return res.status(400).json({ error: error.message, code: error.code });
        if (error.statusCode === 503) return res.status(503).json({ error: error.message, code: error.code || 'VAT_LOOKUP_SOURCE_UNAVAILABLE' });
        console.error(`[vat-lookup ${req.method} ${req.path}]`, error);
        return res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại sau.', code: 'VAT_LOOKUP_ERROR' });
      }
    };
  }

  const meta = snapshot => ({
    loadedAt: snapshot.loadedAt ? new Date(snapshot.loadedAt).toISOString() : null,
    stale: !!snapshot.stale,
    fallbackTabs: snapshot.fallbackTabs || [],
    products: snapshot.products.length,
    source: snapshot.source
  });

  router.get('/meta', ...guard, handle(async (req, res) => {
    res.json(meta(await source.get()));
  }));

  router.post('/refresh', ...guard, handle(async (req, res) => {
    res.json(meta(await source.refresh()));
  }));

  // Body { q: "<noi dung o tim kiem>" } — tach dong / bo trung giong app cu (toi da 100 tu khoa).
  router.post('/search', ...guard, handle(async (req, res) => {
    const text = req.body && typeof req.body.q === 'string' ? req.body.q : '';
    if (text.length > MAX_QUERY_CHARS) {
      return res.status(400).json({ error: `Nội dung tìm kiếm quá dài (tối đa ${MAX_SEARCH_TERMS} dòng).`, code: 'VAT_LOOKUP_QUERY_TOO_LONG' });
    }
    const { queries, ignoredCount } = parseSearchQueries(text);
    const snapshot = await source.get();
    res.json({ meta: meta(snapshot), queries, ignoredCount, ...search(snapshot, queries, req.body || {}) });
  }));

  return router;
}

module.exports = { createVatLookupRouter };
