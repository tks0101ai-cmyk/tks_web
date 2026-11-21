'use strict';

// /api/vat-lookup/* — trang "Kế toán – Tra cứu VAT" (thay app Apps Script Tra cứu VAT).
// Quyen accounting.vatLookup (mac dinh Quan ly, Ke toan, Nhan vien sale). Toan cong ty,
// khong ap cookie co so. Tim kiem chay tren server: client chi gui danh sach tu khoa.

const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { createLookupSource } = require('./lookupSource');
const { parseSearchQueries, search, stockForCodes, MAX_SEARCH_TERMS } = require('./lookupModel');

const MAX_QUERY_CHARS = 20000;
const MAX_STOCK_CODES = 200;
const MAX_STOCK_CODE_CHARS = 60;

function stockCodesError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'VAT_LOOKUP_STOCK_INVALID';
  return error;
}

/** Body { codes: [...] }: 1-200 ma (sau khi bo khoang trang hai dau, bo rong, bo trung), moi ma <= 60 ky tu. */
function parseStockCodes(body) {
  const raw = body && body.codes;
  if (!Array.isArray(raw)) throw stockCodesError('Thiếu danh sách mã SP (codes).');
  const codes = [...new Set(raw.map(code => (typeof code === 'string' ? code.trim() : '')).filter(Boolean))];
  if (!codes.length) throw stockCodesError('Danh sách mã SP trống.');
  if (codes.length > MAX_STOCK_CODES) throw stockCodesError(`Tối đa ${MAX_STOCK_CODES} mã SP mỗi lần.`);
  if (codes.some(code => code.length > MAX_STOCK_CODE_CHARS)) throw stockCodesError(`Mã SP dài quá ${MAX_STOCK_CODE_CHARS} ký tự.`);
  return codes;
}

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

  // Body { codes: [...] } — Ton VAT cho hop chi tiet chung tu (tab Hoa don, Vong doi don hang; public/shared/vat-stock.js).
  // Khop ma CHINH XAC, dung chung bo dem voi /search (khong doc Google Sheets them).
  router.post('/stock', ...guard, handle(async (req, res) => {
    const codes = parseStockCodes(req.body);
    const snapshot = await source.get();
    res.json({ meta: meta(snapshot), items: stockForCodes(snapshot, codes) });
  }));

  return router;
}

module.exports = { createVatLookupRouter };
