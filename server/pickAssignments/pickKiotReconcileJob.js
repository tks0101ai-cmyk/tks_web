'use strict';

// Job nen: dong bo trang thai boc hang theo trang thai don KiotViet (xem pickAssignmentsService.reconcileWithKiot).
//   Dang boc + Kiot "Hoan thanh" -> Da boc (luc nay moi tru thung that); Dang boc + Kiot "Da huy" -> Da huy (tra giu cho).
//   Truoc do: bo dong chi dinh cua ma khong con tren don Kiot (tra giu cho vi tri, khong tru thung ma da xoa).
// Chi doc bang orders DA DONG BO vao Postgres cho vai chuc don dang boc (khong goi API KiotViet, khong doc 60 nghin don).
// Chay lai la an toan: chi dong 'picking', dung version cua chi dinh, nen nhieu instance / chay lap khong tru thung 2 lan.
const CONFIG = require('../config');
const pickAssignments = require('./pickAssignmentsService');

const DEFAULT_INTERVAL_MS = 2 * 60 * 1000;

function createPickKiotReconcileScheduler({
  enabled = CONFIG.PICK_KIOT_RECONCILE_ENABLED,
  service = pickAssignments,
  intervalMs = CONFIG.PICK_KIOT_RECONCILE_INTERVAL_MS || DEFAULT_INTERVAL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console
} = {}) {
  let timer = null;
  let stopped = true;
  let running = false;
  const reported = new Set(); // chi bao 1 lan moi (chi dinh, ma loi) de log khong bi tran khi 1 don ket (vd ton vi tri da doi)

  async function runOnce() {
    if (running) return null;
    running = true;
    try {
      const result = await service.reconcileWithKiot();
      if (result.pruned) {
        logger.log(`[PickKiotReconcile] Bo ${result.pruned} dong chi dinh cua ma khong con tren don Kiot (tra giu cho vi tri).`);
      }
      if (result.confirmed || result.cancelled) {
        logger.log(`[PickKiotReconcile] Da boc tu dong ${result.confirmed} don (Kiot hoan thanh), tra giu cho ${result.cancelled} don (Kiot huy).`);
      }
      for (const failure of result.failed) {
        const signature = `${failure.id}|${failure.outcome}|${failure.code}`;
        if (reported.has(signature)) continue;
        reported.add(signature);
        const what = failure.outcome === 'prune' ? 'bo dong chi dinh cua ma da xoa khoi' : failure.outcome === 'completed' ? 'xac nhan boc' : 'huy chi dinh';
        logger.error(`[PickKiotReconcile] Khong tu dong ${what} don ${failure.branch} ${failure.orderCode}: ${failure.code}. Can nguoi co quyen xu ly tay.`);
      }
      return result;
    } catch (error) {
      logger.error('[PickKiotReconcile] Loi luot doi chieu; thu lai o chu ky sau.', error && error.code ? error.code : 'UNKNOWN');
      return null;
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeoutFn(async () => { await runOnce(); schedule(); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() {
    if (!enabled || !stopped) return;
    stopped = false;
    schedule();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeoutFn(timer);
    timer = null;
  }

  return { start, stop, runOnce };
}

module.exports = { createPickKiotReconcileScheduler, DEFAULT_INTERVAL_MS };
