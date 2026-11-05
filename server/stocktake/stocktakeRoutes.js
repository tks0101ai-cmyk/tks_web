'use strict';

// /api/stocktake/* — Kiem ke (doi chieu so dem don TEAM voi ton KiotViet), migration 0105.
// Xem (.view), sua (.edit) mac dinh chi Quan ly, cap them cho 3 quan ly kiem kho; dong dot / nap sheet (.close) chi Quan ly.
const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { hasFeature } = require('../auth/featureRegistry');
const { resolveBranch } = require('../branch/branchMiddleware');
const { BRANCHES, resolveBranchScope } = require('../branch/branches');
const service = require('./stocktakeService');
const { events: defaultEvents, CHANGED } = require('./stocktakeEvents');
const { createStocktakeWorkbook } = require('./stocktakeExport');
const sheetImport = require('./stocktakeSheetImport');

function createStocktakeRouter(dependencies = {}) {
  const router = express.Router();
  const svc = () => dependencies.service || service;

  router.use('/api/stocktake', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    dependencies.requireAuth || requireAuth,
    requireFeature('stocktake.view'),
    dependencies.resolveBranch || resolveBranch,
    express.json({ limit: '2mb' }));
  const edit = requireFeature('stocktake.edit');
  const close = requireFeature('stocktake.close');

  // Pham vi co so theo cookie: 'Ca hai' -> hanoi + saigon.
  const ctxOf = req => ({
    user: req.user,
    // Ma ngau nhien cua tab trinh duyet (chi de tin hieu SSE biet ai vua ghi), cat ngan cho an toan.
    clientId: String(req.get('x-stocktake-client') || '').replace(/[^\w-]/g, '').slice(0, 64),
    scope: resolveBranchScope(req.branch).map(label => (label === BRANCHES.HANOI ? 'hanoi' : 'saigon'))
  });
  const idOf = req => Number(req.params.id);

  const handle = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error && error.statusCode && error.statusCode < 500) {
        const body = { error: error.message, code: error.code };
        if (error.latest !== undefined) body.latest = error.latest;
        if (error.field) body.field = error.field;
        return res.status(error.statusCode).json(body);
      }
      console.error('[stocktake]', error);
      return res.status(500).json({ error: 'Lỗi máy chủ khi xử lý Kiểm kê.', code: 'STOCKTAKE_FAILED' });
    }
  };
  const can = req => ({ canEdit: hasFeature(req.user, 'stocktake.edit'), canClose: hasFeature(req.user, 'stocktake.close') });

  // ?includeCancelled=1 chi co tac dung voi nguoi co quyen dong dot (Quan ly) — xem lai / khoi phuc dot da huy.
  router.get('/api/stocktake/sessions', handle(async (req, res) => {
    const includeCancelled = req.query.includeCancelled === '1' && hasFeature(req.user, 'stocktake.close');
    res.json({ ...(await svc().listSessions(ctxOf(req), { includeCancelled })), ...can(req) });
  }));
  router.post('/api/stocktake/sessions', edit, handle(async (req, res) => {
    res.status(201).json(await svc().createSession(ctxOf(req), req.body || {}));
  }));
  router.patch('/api/stocktake/sessions/:id', edit, handle(async (req, res) => {
    res.json(await svc().updateSession(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.get('/api/stocktake/sessions/:id/board', handle(async (req, res) => {
    res.json({ ...(await svc().getBoard(ctxOf(req), idOf(req))), ...can(req) });
  }));

  router.get('/api/stocktake/sessions/:id/order-status', handle(async (req, res) => {
    res.json(await svc().getOrderStatus(ctxOf(req), idOf(req)));
  }));

  // SSE: bao "dot X vua doi" (khong kem du lieu); client tai lai bang bang GET board voi quyen cua chinh phien do.
  router.get('/api/stocktake/sessions/:id/events', handle(async (req, res) => {
    const sessionId = idOf(req);
    await assertReadable(req, sessionId);
    req.socket.setTimeout(0);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = chunk => {
      try {
        res.write(chunk);
        if (typeof res.flush === 'function') res.flush(); // compression() giu buffer rieng
      } catch { /* client da roi */ }
    };
    write(':ok\n\n');
    const bus = dependencies.events || defaultEvents;
    const onChanged = payload => {
      if (payload && payload.sessionId === sessionId) write(`event: stocktake-changed\ndata: ${JSON.stringify({ sessionId, by: payload.by || '' })}\n\n`);
    };
    bus.on(CHANGED, onChanged);
    const heartbeat = setInterval(() => write(':heartbeat\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off(CHANGED, onChanged);
    });
  }));
  // Kiem tra dot ton tai + thuoc pham vi co so truoc khi giu ket noi SSE.
  async function assertReadable(req, sessionId) {
    const { sessions } = await svc().listSessions(ctxOf(req));
    if (!sessions.some(session => session.id === sessionId)) {
      throw Object.assign(new Error('Không tìm thấy đợt kiểm kê.'), { statusCode: 404, code: 'NOT_FOUND' });
    }
  }

  router.patch('/api/stocktake/sessions/:id/lines', edit, handle(async (req, res) => {
    res.json(await svc().saveLine(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.post('/api/stocktake/sessions/:id/lines', edit, handle(async (req, res) => {
    res.status(201).json(await svc().addLine(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.put('/api/stocktake/sessions/:id/codes/:code/note', edit, handle(async (req, res) => {
    res.json(await svc().saveNote(ctxOf(req), idOf(req), req.params.code, req.body || {}));
  }));
  router.put('/api/stocktake/sessions/:id/codes/:code/tag', edit, handle(async (req, res) => {
    res.json(await svc().saveTag(ctxOf(req), idOf(req), req.params.code, req.body || {}));
  }));
  // Sua tren bang: go / dan khoi / xoa / keo nhan ban / hoan tac (nhieu ma x cot, kiem expected tung o).
  router.post('/api/stocktake/sessions/:id/cells', edit, handle(async (req, res) => {
    res.json(await svc().saveCells(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.get('/api/stocktake/sessions/:id/codes/:code/history', handle(async (req, res) => {
    res.json(await svc().codeHistory(ctxOf(req), idOf(req), req.params.code));
  }));
  router.post('/api/stocktake/sessions/:id/close', close, handle(async (req, res) => {
    res.json(await svc().closeSession(ctxOf(req), idOf(req), req.body || {}));
  }));
  // Huy / khoi phuc dot (khong xoa vat ly); dot phu thuoc de canh bao truoc khi huy / nap lai.
  router.post('/api/stocktake/sessions/:id/cancel', close, handle(async (req, res) => {
    res.json(await svc().cancelSession(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.post('/api/stocktake/sessions/:id/restore', close, handle(async (req, res) => {
    res.json(await svc().restoreSession(ctxOf(req), idOf(req), req.body || {}));
  }));
  router.get('/api/stocktake/sessions/:id/dependents', close, handle(async (req, res) => {
    res.json(await svc().dependents(ctxOf(req), idOf(req)));
  }));
  // Nap lai dot nap tu sheet: body { version, name?, date?, dryRun? } (dryRun = chi xem truoc).
  router.post('/api/stocktake/sessions/:id/reload-sheet', close, handle(async (req, res) => {
    res.json(await (dependencies.sheetImport || sheetImport).reloadSheet(ctxOf(req), idOf(req), req.body || {}));
  }));
  // Nap 1 lan dot T10 HN hoac KIEM SG tu sheet kiem ke (body.source = 't10' | 'sg').
  router.post('/api/stocktake/import-sheet', close, handle(async (req, res) => {
    res.status(201).json(await (dependencies.sheetImport || sheetImport).importSheet(ctxOf(req), req.body || {}));
  }));

  // Xuat Excel: POST { codes } = dung cac ma dang loc tren giao dien; GET = ca bang.
  const exportBoard = handle(async (req, res) => {
    const board = await svc().getBoard(ctxOf(req), idOf(req));
    let rows = board.rows;
    if (req.method === 'POST') {
      if (!Array.isArray(req.body && req.body.codes)) return res.status(400).json({ error: 'Danh sách mã xuất không hợp lệ.', code: 'VALIDATION' });
      const wanted = new Set(req.body.codes.map(String));
      rows = rows.filter(row => wanted.has(row.code));
    }
    const file = await createStocktakeWorkbook({ session: board.session, rows, employees: board.employees });
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
  });
  router.get('/api/stocktake/sessions/:id/export', exportBoard);
  router.post('/api/stocktake/sessions/:id/export', exportBoard);

  return router;
}

module.exports = createStocktakeRouter();
module.exports.createStocktakeRouter = createStocktakeRouter;
