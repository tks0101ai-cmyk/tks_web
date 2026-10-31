'use strict';

// /api/stock-positions/* — tab "VT Ha Noi" / "VT Sai Gon", module Vi tri hang duy nhat (module cu doc Google Sheets da go 2026-10-30).
// Xem + Xuat Excel (stockLocationsV2.view / .export): mac dinh MOI vai tro ke ca Khach; ghi (.edit) va xoa lich su (.historyDelete) chi noi bo.
const express = require('express');
const multer = require('multer');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { hasFeature } = require('../auth/featureRegistry');
const { resolveBranch } = require('../branch/branchMiddleware');
const { BRANCHES, resolveBranchScope } = require('../branch/branches');
const service = require('./stockPositionsService');
const { events: defaultEvents, CHANGED } = require('./stockPositionsEvents');
const { createStockPositionsWorkbook, createStockPositionsHistoryWorkbook } = require('./stockPositionsExport');

const IMPORT_MAX_BYTES = 8 * 1024 * 1024;
const IMPORT_EXTENSIONS = /\.(xlsx|xls|csv)$/iu;

function createStockPositionsRouter(dependencies = {}) {
  const router = express.Router();
  const svc = () => dependencies.service || service;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: IMPORT_MAX_BYTES, fieldSize: IMPORT_MAX_BYTES, fields: 1, files: 1 } });

  router.use('/api/stock-positions', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    dependencies.requireAuth || requireAuth,
    requireFeature('stockLocationsV2.view'),
    dependencies.resolveBranch || resolveBranch);
  const edit = requireFeature('stockLocationsV2.edit');

  // Pham vi co so theo cookie: 'Ca hai' -> HN + SG.
  const ctxOf = req => ({
    user: req.user,
    scope: resolveBranchScope(req.branch).map(label => (label === BRANCHES.HANOI ? 'HN' : 'SG'))
  });

  const handle = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error && error.statusCode && error.statusCode < 500) {
        const body = { ...error.body, error: error.message, code: error.code };
        if (error.latest) body.latest = error.latest;
        if (error.field) body.field = error.field;
        return res.status(error.statusCode).json(body);
      }
      console.error('[stock-positions]', error);
      return res.status(500).json({ error: 'Lỗi máy chủ khi xử lý Vị trí hàng.', code: 'STOCK_POSITIONS_FAILED' });
    }
  };
  const idOf = req => Number(req.params.id);

  router.get('/api/stock-positions', handle(async (req, res) => {
    const result = await svc().list(ctxOf(req), req.query.branch);
    res.json({ ...result, canEdit: hasFeature(req.user, 'stockLocationsV2.edit'), canExport: hasFeature(req.user, 'stockLocationsV2.export'), canDeleteHistory: hasFeature(req.user, 'stockLocationsV2.historyDelete') });
  }));
  // SSE: bao "bang vi tri co so X vua doi" (khong keo du lieu) de trinh duyet tu tai nen; client lay du lieu bang GET list
  // voi quyen/co so cua chinh phien do. Ket noi giu mo -> proxy phai khong buffer (X-Accel-Buffering) va co heartbeat.
  router.get('/api/stock-positions/events', (req, res) => {
    const branch = String(req.query.branch || '').toUpperCase();
    if (!ctxOf(req).scope.includes(branch)) {
      return res.status(403).json({ error: 'Không có quyền xem vị trí hàng của cơ sở này.', code: 'BRANCH_FORBIDDEN' });
    }
    req.socket.setTimeout(0); // Node mac dinh ngat socket khong hoat dong sau ~2 phut
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const write = chunk => {
      try {
        res.write(chunk);
        // compression() boc res trong stream gzip co buffer rieng: khong flush thi su kien bi giu lai.
        if (typeof res.flush === 'function') res.flush();
      } catch { /* client da roi */ }
    };
    write(':ok\n\n');
    const bus = dependencies.events || defaultEvents;
    const onChanged = payload => {
      if (payload && payload.branch === branch) write(`event: positions-changed\ndata: ${JSON.stringify({ branch })}\n\n`);
    };
    bus.on(CHANGED, onChanged);
    const heartbeat = setInterval(() => write(':heartbeat\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off(CHANGED, onChanged);
    });
  });
  router.get('/api/stock-positions/code-suggestions', handle(async (req, res) => {
    res.json(await svc().suggestCodes(ctxOf(req), req.query.branch, req.query.q));
  }));
  // Export selected rows in screen order, restricted to the authorized branch.
  router.route('/api/stock-positions/export').get(requireFeature('stockLocationsV2.export'), exportPositions).post(requireFeature('stockLocationsV2.export'), express.json({ limit: '8mb' }), exportPositions);
  async function exportPositions(req, res, next) {
    return handle(async (req, res) => {
    const { branch, rows } = await svc().list(ctxOf(req), req.query.branch);
    let exportRows = rows;
    if (req.method === 'POST') {
      if (!Array.isArray(req.body?.ids)) return res.status(400).json({ error: 'Danh sách dòng xuất không hợp lệ.' });
      const byId = new Map(rows.map(row => [String(row.id), row]));
      exportRows = [...new Set(req.body.ids.map(String))].map(id => byId.get(id)).filter(Boolean);
    }
    const file = await createStockPositionsWorkbook({ branch, rows: exportRows });
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
    })(req, res, next);
  }
  // Phai dat truoc '/:id'.
  router.get('/api/stock-positions/history', handle(async (req, res) => {
    res.json(await svc().history(ctxOf(req), req.query.branch, { limit: req.query.limit, before: req.query.before, positionId: req.query.positionId }));
  }));
  // Xuat Excel Lich su cap nhat cua co so (loc theo hanh dong + tu khoa nhu hop tren man hinh); quyen stockLocationsV2.export.
  router.get('/api/stock-positions/history/export', requireFeature('stockLocationsV2.export'), handle(async (req, res) => {
    const branch = req.query.branch;
    const { rows, truncated } = await svc().historyAll(ctxOf(req), branch, { action: req.query.action, q: req.query.q });
    const file = await createStockPositionsHistoryWorkbook({ branch, rows });
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.set('X-History-Truncated', String(Boolean(truncated)));
    res.send(file.buffer);
  }));
  // Xoa lich su cua mot co so theo khoang ngay (yyyy-mm-dd, trong = khong gioi han); quyen rieng stockLocationsV2.historyDelete.
  // Dat TRUOC router.delete('/:id') de khong bi coi 'history' la ma dong.
  router.delete('/api/stock-positions/history', requireFeature('stockLocationsV2.historyDelete'), handle(async (req, res) => {
    res.json(await svc().purgeHistory(ctxOf(req), req.query.branch, { from: req.query.from, to: req.query.to }));
  }));
  router.post('/api/stock-positions/import', edit, (req, res, next) => upload.single('file')(req, res, error => {
    if (!error) return next();
    const tooBig = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'File quá lớn (tối đa 8 MB).' : 'Không đọc được file tải lên.', code: tooBig ? 'IMPORT_FILE_TOO_LARGE' : 'IMPORT_UPLOAD_FAILED' });
  }), handle(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn file Excel hoặc CSV.', code: 'IMPORT_FILE_REQUIRED' });
    // multer giai ma ten file kieu latin1; doi ve UTF-8 de hien ten tieng Viet trong lich su.
    const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    if (!IMPORT_EXTENSIONS.test(fileName)) return res.status(400).json({ error: 'Chỉ nhận file .xlsx, .xls hoặc .csv.', code: 'IMPORT_BAD_EXTENSION' });
    let inputRows;
    if (req.body && req.body.rows !== undefined) {
      try { inputRows = JSON.parse(req.body.rows); }
      catch { return res.status(400).json({ error: 'Danh sách dòng import không hợp lệ.', code: 'IMPORT_INVALID_ROWS' }); }
      if (!Array.isArray(inputRows)) return res.status(400).json({ error: 'Danh sách dòng import không hợp lệ.', code: 'IMPORT_INVALID_ROWS' });
    }
    res.json(await svc().importFile(ctxOf(req), req.query.branch, {
      mode: req.query.mode, commit: req.query.commit === '1', buffer: req.file.buffer, fileName,
      ...(inputRows !== undefined ? { inputRows } : {})
    }));
  }));
  // Xuat kho: tru SL hang loat theo file (3 cot Ma hang, Ghi chu, Vi tri), dong sai bo qua + tra danh sach. Dat truoc '/:id/...'.
  router.post('/api/stock-positions/stock-out', edit, (req, res, next) => upload.single('file')(req, res, error => {
    if (!error) return next();
    const tooBig = error.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'File quá lớn (tối đa 8 MB).' : 'Không đọc được file tải lên.', code: tooBig ? 'IMPORT_FILE_TOO_LARGE' : 'IMPORT_UPLOAD_FAILED' });
  }), handle(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Vui lòng chọn file Excel hoặc CSV.', code: 'IMPORT_FILE_REQUIRED' });
    const fileName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    if (!IMPORT_EXTENSIONS.test(fileName)) return res.status(400).json({ error: 'Chỉ nhận file .xlsx, .xls hoặc .csv.', code: 'IMPORT_BAD_EXTENSION' });
    res.json(await svc().stockOutFile(ctxOf(req), req.query.branch, { buffer: req.file.buffer, fileName }));
  }));
  router.post('/api/stock-positions', edit, handle(async (req, res) => {
    const result = await svc().create(ctxOf(req), req.query.branch, req.body || {});
    res.status(result.merged ? 200 : 201).json(result);
  }));
  router.patch('/api/stock-positions/:id', edit, handle(async (req, res) => {
    res.json(await svc().update(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.post('/api/stock-positions/:id/deduct', edit, handle(async (req, res) => {
    res.json(await svc().deduct(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.post('/api/stock-positions/:id/ack', edit, handle(async (req, res) => {
    res.json(await svc().acknowledge(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.delete('/api/stock-positions/:id', edit, handle(async (req, res) => {
    const version = req.query.version === undefined ? undefined : Number(req.query.version);
    res.json(await svc().remove(ctxOf(req), idOf(req), version));
  }));
  return router;
}

module.exports = createStockPositionsRouter();
module.exports.createStockPositionsRouter = createStockPositionsRouter;
