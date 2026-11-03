'use strict';

// API bang "Gia duyet" (tab Hoa don): /api/invoice-approved-prices. Cache-Control: no-store.
//   GET    /                      danh sach theo bo loc (q, approver, from, to) + sort/dir + phan trang
//   GET    /export                xuat Excel TOAN BO tap dang loc/sap xep (can them reports.export)
//   GET    /customer-suggest      ?branch=&q=  goi y khach { id, code, name } cua co so
//   GET    /product-suggest       ?branch=&q=  goi y san pham { id, code, name } cua co so
//   POST   /import               nhap tu file Excel/CSV (multipart "file"); ?commit=1 ghi that, khong co = xem truoc (quyen manage)
//   POST   /                      tao (chi quyen ...approvedPrice)
//   PUT    /:id                   sua toan bo + expectedVersion
//   DELETE /:id                   xoa (?expectedVersion=)
// Xem: reports.invoices.approvedPrice (mac dinh chi Quan ly). Tao / sua / xoa: reports.invoices.approvedPrice.manage (mac dinh chi Quan ly).

const express = require('express');
const multer = require('multer');
const authMiddleware = require('../auth/authMiddleware');
const { hasFeature } = require('../auth/featureRegistry');
const { getApprovedPriceRepository } = require('./approvedPriceRepository');
const { createApprovedPriceExport } = require('./approvedPriceExport');
const { parseImportWorkbook } = require('./approvedPriceImport');
const rules = require('./approvedPriceRules');

const ID_RE = /^[1-9]\d{0,17}$/;
const IMPORT_MAX_BYTES = 4 * 1024 * 1024;
const IMPORT_EXTENSIONS = /\.(xlsx|xls|csv)$/iu;

const actorOf = user => [user?.hoTen, user?.username, user?.id]
  .map(value => String(value ?? '').trim()).find(Boolean) || 'unknown';

function createApprovedPriceRouter({
  repository = null,
  requireAuth = authMiddleware.requireAuth
} = {}) {
  const repo = () => repository || getApprovedPriceRepository();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, fieldSize: IMPORT_MAX_BYTES, fields: 1, files: 1 } });
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  router.use(express.json({ limit: '16kb' }));
  const view = [requireAuth, authMiddleware.requireFeature(rules.FEATURE_VIEW)];
  const manage = [...view, authMiddleware.requireFeature(rules.FEATURE_MANAGE)];

  const handle = (message, fn) => async (req, res) => {
    try { await fn(req, res); } catch (error) {
      if (error && error.statusCode && error.statusCode < 500) {
        return res.status(error.statusCode).json({
          error: error.message,
          ...(error.code ? { code: error.code } : {}),
          ...(error.row ? { row: error.row } : {})
        });
      }
      // Bang chua migrate (42P01): bao ro de van hanh biet, khong lo chi tiet DB.
      if (error && (error.code === '42P01' || error.code === '42703')) {
        return res.status(503).json({ error: 'Bảng Giá duyệt chưa được cài đặt (cần chạy migration 0091 và 0092).', code: 'NOT_MIGRATED' });
      }
      console.error(`[invoice-approved-prices ${req.method} ${req.path}]`, error && error.message);
      return res.status(503).json({ error: message });
    }
  };

  const pathId = req => {
    if (!ID_RE.test(String(req.params.id))) throw rules.bad('Mã bản ghi không hợp lệ.');
    return String(req.params.id);
  };

  router.get('/', ...view, handle('Không lấy được bảng Giá duyệt.', async (req, res) => {
    const query = rules.parseListQuery(req.query);
    const report = await repo().list(query);
    res.json({
      ...report,
      filters: { approver: query.approver, from: query.from, to: query.to, q: query.q, sort: query.sort, dir: query.dir },
      options: { approvers: rules.APPROVERS },
      canManage: hasFeature(req.user, rules.FEATURE_MANAGE)
    });
  }));

  router.get('/export', ...view, authMiddleware.requireFeature('reports.export'),
    handle('Không xuất được bảng Giá duyệt.', async (req, res) => {
      const query = rules.parseListQuery({ ...req.query, page: undefined, pageSize: undefined });
      const report = await repo().list(query, { all: true });
      const file = await createApprovedPriceExport({ rows: report.rows,
        filters: { approver: query.approver, from: query.from, to: query.to, q: query.q } });
      res.set('Content-Type', file.mimeType);
      res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
      res.send(file.buffer);
    }));

  const suggest = (kind) => handle('Không lấy được gợi ý.', async (req, res) => {
    const branch = rules.parseBranch(req.query.branch);
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
    const limit = Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20));
    const results = kind === 'customer' ? await repo().suggestCustomers(branch, q, limit) : await repo().suggestProducts(branch, q, limit);
    res.json({ results });
  });
  // Goi y chi phuc vu o nhap cua nguoi co quyen tao / sua.
  router.get('/customer-suggest', ...manage, suggest('customer'));
  router.get('/product-suggest', ...manage, suggest('product'));

  // Import Excel/CSV: ?commit=1 ghi that, khong co = chi xem truoc (khong ghi). Dong trung ban ghi da co thi ghi de.
  router.post('/import', ...manage, (req, res, next) => upload.single('file')(req, res, error => {
    if (!error) return next();
    const tooBig = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'File quá lớn (tối đa 4 MB).' : 'Không đọc được file tải lên.', code: tooBig ? 'IMPORT_FILE_TOO_LARGE' : 'IMPORT_UPLOAD_FAILED' });
  }), handle('Không nhập được file giá duyệt.', async (req, res) => {
    if (!req.file) throw rules.bad('Vui lòng chọn file Excel hoặc CSV.', 'IMPORT_FILE_REQUIRED');
    // multer giai ma ten file kieu latin1; doi ve UTF-8 truoc khi kiem tra duoi file.
    const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    if (!IMPORT_EXTENSIONS.test(fileName)) throw rules.bad('Chỉ nhận file .xlsx, .xls hoặc .csv.', 'IMPORT_BAD_EXTENSION');
    const rows = parseImportWorkbook(req.file.buffer, { fileName });
    res.json(await repo().importPrices(rows, actorOf(req.user), { commit: req.query.commit === '1' }));
  }));

  router.post('/', ...manage, handle('Không tạo được bản ghi giá duyệt.', async (req, res) => {
    const out = await repo().create(rules.parseCreate(req.body), actorOf(req.user));
    res.status(201).json(out);
  }));

  router.put('/:id', ...manage, handle('Không lưu được bản ghi giá duyệt.', async (req, res) => {
    const id = pathId(req);
    res.json(await repo().update(id, rules.parseUpdate(req.body), actorOf(req.user)));
  }));

  router.delete('/:id', ...manage, handle('Không xóa được bản ghi giá duyệt.', async (req, res) => {
    const id = pathId(req);
    const raw = req.query.expectedVersion;
    const expectedVersion = raw === undefined || raw === '' ? null : Number.parseInt(raw, 10);
    if (expectedVersion !== null && !(expectedVersion >= 1)) throw rules.bad('expectedVersion không hợp lệ.');
    res.json(await repo().remove(id, expectedVersion, actorOf(req.user)));
  }));

  return router;
}

module.exports = { createApprovedPriceRouter };
