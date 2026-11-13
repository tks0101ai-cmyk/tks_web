'use strict';

// /api/vat-draft/* — trang "Kế toán – Nháp VAT". Route Xu ly hoa don can quyen accounting.vatDraft
// (mac dinh chi Quan ly + admin cung; Quan ly bat rieng cho tung Ke toan o /account/).
// Route Tao QR (/qr/*, /meta) nhan them accounting.qr (mac dinh Nhan vien sale).
// /qr/parse-image gui anh hoa don toi AI vision (xKiro, cau hinh XKIRO_* trong config.js).

const express = require('express');
const multer = require('multer');
const appConfig = require('../config');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { resolveBranch } = require('../branch/branchMiddleware');
const { branchLabelToCode, resolveBranchScope } = require('../branch/branches');
const { createDocumentsRepository } = require('./documentsRepository');
const { getInvoiceDetail, getOrderDetail } = require('../dashboard/documentDetailRepository');
const { createMasterDataSource } = require('./sheetsSource');
const { createVatDraftService } = require('./vatDraftService');
const { createVatDraftWorkbook } = require('./vatDraftExport');
const { parseDocumentCodes } = require('./pasteParser');
const { createInvoiceVisionClient } = require('./invoiceVision');

const MAX_INVOICE_IMAGE_BYTES = 6 * 1024 * 1024;
const INVOICE_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const invoiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_INVOICE_IMAGE_BYTES, files: 1, fields: 2 } });

/** Bao multer: anh qua co -> 413, loi khac -> 400 (JSON co code) thay vi 500. */
function uploadInvoiceImage(req, res, next) {
  invoiceUpload.single('file')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `Ảnh hóa đơn quá lớn, tối đa ${MAX_INVOICE_IMAGE_BYTES / (1024 * 1024)} MB.`, code: 'INVOICE_IMAGE_TOO_LARGE' });
    }
    return res.status(400).json({ error: 'Không đọc được file tải lên.', code: 'INVOICE_IMAGE_UPLOAD_FAILED' });
  });
}

function defaultVisionClient() {
  return createInvoiceVisionClient({
    apiKey: appConfig.XKIRO_API_KEY,
    baseUrl: appConfig.XKIRO_BASE_URL,
    model: appConfig.INVOICE_VISION_MODEL,
    fallbackModel: appConfig.INVOICE_VISION_FALLBACK_MODEL
  });
}

function createVatDraftRouter({
  repository = createDocumentsRepository(),
  masterData = createMasterDataSource(),
  vision = defaultVisionClient(),
  service = createVatDraftService({ repository, masterData, vision }),
  documentDetail = { getInvoiceDetail, getOrderDetail }
} = {}) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  const guard = [requireAuth, requireFeature('accounting.vatDraft')];
  const qrGuard = [requireAuth, requireFeature('accounting.vatDraft', 'accounting.qr')];
  // Bo loc "Cơ sở" tren trang (?branch=hanoi|saigon|all) uu tien hon cookie co so o header.
  const branchCodes = req => {
    const picked = String((req.query && req.query.branch) || '').trim();
    if (picked === 'hanoi' || picked === 'saigon') return [picked];
    if (picked === 'all') return ['hanoi', 'saigon'];
    return resolveBranchScope(req.branch).map(branchLabelToCode);
  };

  function handle(fn) {
    return async (req, res) => {
      try {
        await fn(req, res);
      } catch (error) {
        if (error.statusCode === 400) return res.status(400).json({ error: error.message, code: error.code });
        if (error.statusCode === 404) return res.status(404).json({ error: error.message, code: error.code || 'VAT_DRAFT_NOT_FOUND' });
        if (error.statusCode === 503) return res.status(503).json({ error: error.message, code: error.code || 'VAT_DRAFT_SOURCE_UNAVAILABLE' });
        console.error(`[vat-draft ${req.method} ${req.path}]`, error);
        return res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại sau.', code: 'VAT_DRAFT_ERROR' });
      }
    };
  }

  async function masterDataStatus(force) {
    try {
      const snapshot = force ? await masterData.refresh() : await masterData.get();
      return { ...service.masterDataMeta(snapshot), error: null };
    } catch (error) {
      return { loadedAt: null, stale: false, stockRows: 0, mappingRows: 0, invalidStockRows: 0, error: error.message };
    }
  }

  // Danh sach tai khoan + ngan hang: tra NGAY, khong cho Google Sheets (truoc 13/11/2026 /meta cho
  // doc Sheets toi ~60 giay khi het cache -> o chon tai khoan trong).
  router.get('/meta', ...qrGuard, handle(async (req, res) => {
    res.json({ vietqr: service.accountsMeta() });
  }));

  // Trang thai Sheets / KiotViet cho thanh trang thai tab Xu ly (duoc phep cham).
  router.get('/master-data/status', ...guard, handle(async (req, res) => {
    const [master, sync] = await Promise.all([masterDataStatus(false), repository.syncStatus().catch(() => [])]);
    res.json({ masterData: master, sync });
  }));

  router.post('/master-data/refresh', ...guard, handle(async (req, res) => {
    res.json({ masterData: await masterDataStatus(true) });
  }));

  // Hop chi tiet khi bam 1 dong "Hoa don da dan": dung lai loader cua dashboard nhung theo quyen Ke toan
  // (ke toan khong can quyen Bao cao hoa don).
  router.get('/documents/detail', ...guard, handle(async (req, res) => {
    const { kind, branch, code } = req.query;
    if (!['invoice', 'order'].includes(kind) || !['hanoi', 'saigon'].includes(branch)) {
      return res.status(400).json({ error: 'Chứng từ không hợp lệ.', code: 'VAT_DRAFT_INVALID' });
    }
    const load = kind === 'invoice' ? documentDetail.getInvoiceDetail : documentDetail.getOrderDetail;
    res.json({ detail: await load({ code, branchCode: branch }) });
  }));

  router.post('/documents/resolve', ...guard, resolveBranch, handle(async (req, res) => {
    const { codes, invalid, truncated } = parseDocumentCodes(req.body && req.body.text);
    const result = await repository.resolveCodes({ branchCodes: branchCodes(req), codes });
    res.json({ ...result, invalid, truncated });
  }));

  router.post('/allocate', ...guard, handle(async (req, res) => {
    res.json(await service.allocate(req.body || {}));
  }));

  router.post('/export', ...guard, handle(async (req, res) => {
    const file = await createVatDraftWorkbook(req.body || {});
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
  }));

  router.post('/qr/url', ...qrGuard, handle(async (req, res) => {
    res.json(service.qrUrl(req.body || {}));
  }));

  // Anh hoa don (trinh duyet da thu nho / render trang 1 PDF thanh JPEG) -> AI doc -> goi y tai khoan.
  // PDF co lop chu: trinh duyet gui chu MOI trang (pdf.js) -> doc bang regex, khong qua AI.
  router.post('/qr/parse-text', ...qrGuard, handle(async (req, res) => {
    res.json(service.parsePdfText(req.body && req.body.text));
  }));

  router.post('/qr/parse-image', ...qrGuard, uploadInvoiceImage, handle(async (req, res) => {
    const file = req.file;
    if (!file || !INVOICE_IMAGE_TYPES.has(file.mimetype)) {
      return res.status(400).json({ error: 'Chỉ nhận ảnh hóa đơn JPG, PNG hoặc WebP.', code: 'INVOICE_IMAGE_INVALID' });
    }
    res.json(await service.parseInvoiceImage({ buffer: file.buffer, mimeType: file.mimetype }));
  }));

  return router;
}

module.exports = { createVatDraftRouter };
