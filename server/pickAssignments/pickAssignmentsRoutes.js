'use strict';

// /api/shipment/pick/* — Chi dinh vi tri hang cho don (trang Vong doi don hang). Quyen: shipment.pick (mac dinh chi Quan ly).
// Mount trong server/routes.js TRUOC cong '/api/shipment' chung, ngay canh '/api/shipment/lifecycle'. Khong dung resolveBranch:
// trang Vong doi hien ca 2 co so bat ke cookie tks_branch, co so cua don lay tu tham so `branch` (HN|SG).
const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const service = require('./pickAssignmentsService');

function createPickAssignmentsRouter(dependencies = {}) {
  const router = express.Router();
  const svc = () => dependencies.service || service;

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); },
    dependencies.requireAuth || requireAuth,
    requireFeature('shipment.pick'));

  const ctxOf = req => ({ user: req.user });
  const handle = fn => async (req, res) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error && error.statusCode && error.statusCode < 500) {
        const body = { error: error.message, code: error.code };
        if (error.latest) body.latest = error.latest;
        if (error.field) body.field = error.field;
        return res.status(error.statusCode).json(body);
      }
      console.error('[pick-assignments]', error);
      return res.status(500).json({ error: 'Lỗi máy chủ khi xử lý chỉ định vị trí.', code: 'PICK_ASSIGNMENTS_FAILED' });
    }
  };
  const query = req => ({ branch: req.query.branch, orderCode: req.query.order });

  // Form in chung, dùng cùng quyền với thao tác in/chỉ định.
  const layouts=dependencies.printLayouts || require('./printLayouts');
  const pool=()=>dependencies.pool || require('../db/pool').getPool();
  router.get('/print-layout/:template',handle(async(req,res)=>{
    res.json(await layouts.readLayout(pool(),req.params.template));
  }));
  router.put('/print-layout/:template',handle(async(req,res)=>{
    res.json(await layouts.writeLayout(pool(),req.params.template,req.body,req.user.id));
  }));
  router.get('/candidates', handle(async (req, res) => {
    res.json(await svc().candidates(ctxOf(req), query(req)));
  }));
  router.get('/', handle(async (req, res) => {
    res.json(await svc().get(ctxOf(req), query(req)));
  }));
  router.post('/', handle(async (req, res) => {
    res.status(201).json(await svc().assign(ctxOf(req), req.body || {}));
  }));
  // Xoa dong hang khoi don KiotViet (ghi nguoc len Kiot): body { branch, orderCode, productCode }.
  router.post('/order-lines/remove', handle(async (req, res) => {
    res.json(await svc().removeLine(ctxOf(req), req.body || {}));
  }));
  // Doi trang thai bang dropdown cot "Trang thai boc": body { branch, orderCode, status: 'confirmed' | 'cancelled' }.
  // Dat TRUOC '/:id/...' (khong xung dot vi 2 doan duong dan khac nhau, nhung giu cho de doc).
  router.post('/status', handle(async (req, res) => {
    res.json(await svc().setStatus(ctxOf(req), req.body || {}));
  }));
  router.post('/:id/confirm', handle(async (req, res) => {
    res.json(await svc().confirm(ctxOf(req), Number(req.params.id), req.body || {}));
  }));
  router.post('/:id/cancel', handle(async (req, res) => {
    res.json(await svc().cancel(ctxOf(req), Number(req.params.id), req.body || {}));
  }));
  return router;
}

module.exports = createPickAssignmentsRouter();
module.exports.createPickAssignmentsRouter = createPickAssignmentsRouter;
