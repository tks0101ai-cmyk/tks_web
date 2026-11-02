'use strict';

// /api/shipment/pick/* — Chi dinh vi tri hang cho don (trang Vong doi don hang). Quyen: shipment.pick (mac dinh chi Quan ly).
// Mount trong server/routes.js TRUOC cong '/api/shipment' chung, ngay canh '/api/shipment/lifecycle'. Khong dung resolveBranch:
// trang Vong doi hien ca 2 co so bat ke cookie tks_branch, co so cua don lay tu tham so `branch` (HN|SG).
const express = require('express');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { hasFeature } = require('../auth/featureRegistry');
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
        // Ma don Dang boc dang giu vi tri (POSITION_HELD / BELOW_HELD / HELD_SPEC_CONFLICT) + tong giu cho (BELOW_HELD).
        if (error.orders) body.orders = error.orders;
        if (error.held !== undefined) body.held = error.held;
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
  // Sua VT trong hop can THEM quyen xem + sua VT (requireFeature(a, b) la HOAC nen xich 2 middleware rieng).
  const canEditPositions = user => hasFeature(user, 'stockLocationsV2.view') && hasFeature(user, 'stockLocationsV2.edit');
  const vtEdit = [requireFeature('stockLocationsV2.view'), requireFeature('stockLocationsV2.edit')];

  router.get('/candidates', handle(async (req, res) => {
    res.json({ ...await svc().candidates(ctxOf(req), query(req)), canEditPositions: canEditPositions(req.user) });
  }));
  // Them / sua ghi chu / xoa dong VT cua ma trong don. Dat TRUOC '/:id/...'.
  // POST body { branch, orderCode, productCode, location, notes } -> 201 { row, merged:false } | 200 { row, merged:true } (cong vao dong trung).
  router.post('/positions', vtEdit, handle(async (req, res) => {
    const result = await svc().createPosition(ctxOf(req), req.body || {});
    res.status(result.merged ? 200 : 201).json(result);
  }));
  // PATCH body { branch, orderCode, notes, version, confirmEmpty? } -> { row } | { deleted:true, id }.
  router.patch('/positions/:id', vtEdit, handle(async (req, res) => {
    res.json(await svc().updatePosition(ctxOf(req), Number(req.params.id), req.body || {}));
  }));
  // DELETE ?branch&order&version -> { deleted:true, id }.
  router.delete('/positions/:id', vtEdit, handle(async (req, res) => {
    res.json(await svc().removePosition(ctxOf(req), Number(req.params.id), { ...query(req), version: req.query.version }));
  }));
  router.get('/', handle(async (req, res) => {
    res.json(await svc().get(ctxOf(req), query(req)));
  }));
  router.post('/', handle(async (req, res) => {
    res.status(201).json(await svc().assign(ctxOf(req), req.body || {}));
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
