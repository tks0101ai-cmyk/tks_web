'use strict';

// API bang "Du kien hang ve" (tab Hang hoa): /api/expected-arrivals. Dat NGOAI /api/product-report vi router do
// bat 'reports.products' ma Ke toan / Mua hang / Kho khong co; o day chi can 'reports.products.expected'
// (xuat file cung quyen nay, KHONG can reports.export). Gop HN + SG, khong theo co so dang chon.

const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const expectedRepository = require('./expectedRepository');
const { hasFeature } = require('../auth/featureRegistry');
const { createExportFile, filterRows, sortRowsByLabel, exportFieldsFor, resolveColumnKeys, stripPriceFields } = require('./expectedExport');

// Gia (Gia SP tep, Gia hang ve VN, ngay len gia) chi Quan ly co quyen xem day du CONT moi thay.
const canSeeOtherNote = req => hasFeature(req.user, 'reports.products.expected.otherNote') === true;
const stripOtherNote = (rows, allowed) => allowed ? rows : rows.map(({ otherNote, ...row }) => row);
const canSeePrices = req => hasFeature(req.user, 'reports.overview.containers.full') === true;

function createExpectedArrivalsRouter({ repository = expectedRepository } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const guard = [requireAuth, requireFeature('reports.products.expected')];

  const handle = (message, fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      if (error && error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({ error: error.message, ...(error.code ? { code: error.code } : {}) });
      }
      // Khong lo chi tiet loi DB cho client.
      console.error(`[expected-arrivals ${req.method} ${req.path}]`, error && error.message);
      return res.status(503).json({ error: message });
    }
  };

  router.get('/', ...guard, handle('Không lấy được bảng Dự kiến hàng về.', async (req, res) => {
    const data = await repository.getExpected();
    const fullAccess = canSeePrices(req);
    const otherNoteAccess = canSeeOtherNote(req);
    res.status(200).json({ ...data, rows: stripOtherNote(stripPriceFields(data.rows, fullAccess), otherNoteAccess), fullAccess, otherNoteAccess });
  }));

  const loadFiltered = async req => {
    const data = await repository.getExpected();
    const fullAccess = canSeePrices(req);
    const otherNoteAccess = canSeeOtherNote(req);
    const stripped = stripPriceFields(filterRows(stripOtherNote(data.rows, otherNoteAccess), fullAccess ? req.query : { ...req.query, source: '' }), fullAccess);
    return { data, fullAccess, otherNoteAccess, rows: sortRowsByLabel(stripped, req.query, { fullAccess, otherNoteAccess }) };
  };

  // Danh sach truong cho hop thoai "Xuat file" dung chung (cung dang /api/business-report/export/fields).
  router.get('/export/fields', ...guard, handle('Không lấy được danh sách trường xuất.', async (req, res) => {
    const { rows, fullAccess, otherNoteAccess } = await loadFiltered(req);
    res.json(exportFieldsFor(rows, { fullAccess, otherNoteAccess }));
  }));

  router.get('/export', ...guard, handle('Không xuất được bảng Dự kiến hàng về.', async (req, res) => {
    const { data, rows, fullAccess, otherNoteAccess } = await loadFiltered(req);
    const columnKeys = resolveColumnKeys(req.query.columns, { fullAccess, otherNoteAccess });
    const file = await createExportFile(String(req.query.format || 'xlsx'), rows, columnKeys, { query: req.query, meta: data.meta, fullAccess, otherNoteAccess });
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
  }));

  return router;
}

module.exports = { createExpectedArrivalsRouter };
