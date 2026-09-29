'use strict';

const CONFIG = require('../config');
const { getConfiguredBranches } = require('./config');
const { createKiotVietClient } = require('../kiotviet/kiotVietApiClient');
const { pollEntityOnce } = require('./syncDriver');
const { recordFailure } = require('./checkpointRepository');
const { getPool } = require('../db/pool');
const {
  startDashboardRollupSchedule, refreshDashboardRollupsAndNotify, HOT_WINDOW_DAYS
} = require('./dashboardRollupRefresh');
const { startCustomerDebtReportRefreshSchedule } = require('./customerDebtReportRefresh');
const { startProductReportSchedule } = require('./productReportRefresh');
const { startCustomerInvoiceLinesSchedule } = require('./customerInvoiceLinesRefresh');

const fastEntities = [require('./entities/invoices'), require('./entities/orders'), require('./entities/productOnHands'),
  require('./entities/productOnHandsSnapshot')];
const slowEntities = [require('./entities/categories'), require('./entities/products'), require('./entities/customers'),
  require('./entities/suppliers'), require('./entities/returns'), require('./entities/purchases'), require('./entities/cashFlows')];

function createPollingScheduler({
  enabled = CONFIG.KIOTVIET_SYNC_ENABLED,
  fastIntervalMs = CONFIG.KIOTVIET_SYNC_FAST_INTERVAL_MS,
  slowIntervalMs = CONFIG.KIOTVIET_SYNC_SLOW_INTERVAL_MS,
  // Luot rollup DAY DU (400 ngay, ~6,4s + ghi de ~61.000 dong do 2026-09-24)
  // chi con phai lo phan lich su: nhung ngay gan day da duoc luot "nong" chay
  // ngay sau moi luot sync fast lam moi. Vi vay gian ra 30 phut thay vi 5 phut.
  dashboardRollupIntervalMs = 30 * 60 * 1000,
  customerDebtReportIntervalMs = 5 * 60 * 1000,
  productReportIntervalMs = 5 * 60 * 1000,
  customerInvoiceLinesIntervalMs = 5 * 60 * 1000,
  getConfiguredBranches: getBranches = getConfiguredBranches,
  createKiotVietClient: createClient = createKiotVietClient,
  pollEntityOnce: poll = pollEntityOnce,
  recordFailure: record = recordFailure,
  setIntervalFn = setInterval,
  scheduleImmediate = queueMicrotask,
  getPool: getPoolFn = getPool,
  startDashboardRollupSchedule: startRollup = startDashboardRollupSchedule,
  refreshDashboardRollupsAndNotify: refreshHotRollup = refreshDashboardRollupsAndNotify,
  startCustomerDebtReportRefreshSchedule: startCustomerDebtReportRefresh = startCustomerDebtReportRefreshSchedule,
  startProductReportSchedule: startProductReport = startProductReportSchedule,
  startCustomerInvoiceLinesSchedule: startCustomerInvoiceLines = startCustomerInvoiceLinesSchedule,
  logger = console
} = {}) {
  async function runGroup(entities) {
    const branches = getBranches();
    if (!branches.length) {
      logger.warn('[KiotViet Sync] Không có cơ sở đủ cấu hình; bỏ qua nhịp polling.');
      return;
    }
    await Promise.allSettled(branches.map(async (branchConfig) => {
      const api = createClient(branchConfig);
      await Promise.allSettled(entities.map(async (entity) => {
        try {
          await poll(api, branchConfig.branch, entity);
        } catch (error) {
          await record(branchConfig.branch, entity.entity, error.message).catch((recordError) => {
            logger.error('[KiotViet Sync] Không ghi được lỗi checkpoint:', recordError.message);
          });
        }
      }));
    }));
  }

  /**
   * Luot sync "fast" (hoa don/don hang/ton kho) roi tinh lai NGAY rollup cua
   * vai ngay gan nhat. Truoc day hai viec nay chay theo hai nhip doc lap nen
   * do tre cua Dashboard bang nhip sync CONG nhip rollup; noi lai thi du lieu
   * vua keo ve xuat hien tren bao cao ngay trong cung luot, va SSE chi bao
   * "co du lieu moi" sau khi rollup da thuc su xong.
   */
  async function runFastGroupAndRollup() {
    await runGroup(fastEntities);
    await refreshHotRollup(getPoolFn(), {
      windowDays: HOT_WINDOW_DAYS,
      includeFirstPurchase: false,
      getConfiguredBranches: getBranches,
      log: logger.log ? logger.log.bind(logger) : logger
    });
  }

  function startPollingScheduler() {
    if (!enabled) return [];
    // Chạy một lượt nền ngay khi service khởi động để bù khoảng trống từ
    // checkpoint gần nhất (ví dụ Render vừa ngủ/redeploy). Không await ở đây
    // để HTTP server vẫn sẵn sàng nhận request trong lúc đồng bộ catch-up.
    scheduleImmediate(() => {
      runFastGroupAndRollup().catch((error) => logger.error('[KiotViet Sync] Lỗi lượt fast ban đầu:', error.message));
      runGroup(slowEntities).catch((error) => logger.error('[KiotViet Sync] Lỗi lượt slow ban đầu:', error.message));
    });
    return [
      setIntervalFn(() => runFastGroupAndRollup(), fastIntervalMs),
      setIntervalFn(() => runGroup(slowEntities), slowIntervalMs),
      // Rollup bao cao Dashboard (server/db/migrations/0013), luot DAY DU: lo
      // phan lich su xa hon HOT_WINDOW_DAYS (vd hoa don cu bi sua trong
      // KiotViet), vi nhung ngay gan day da co luot "nong" sau moi luot sync
      // fast lo. Nhet chung khoi khoi dong nay (chi bat khi
      // KIOTVIET_SYNC_ENABLED=true) de khong can 1 co che enable/disable rieng.
      startRollup(getPoolFn(), {
        intervalMs: dashboardRollupIntervalMs,
        setIntervalFn,
        scheduleImmediate,
        log: logger.log ? logger.log.bind(logger) : logger
      }),
      // Bao cao cong no khach hang HN1/HN3/HN7 (server/db/migrations/0014) -
      // cung 1 ly do nhet chung khoi khoi dong nay nhu rollup Dashboard o tren.
      startCustomerDebtReportRefresh(getPoolFn(), {
        intervalMs: customerDebtReportIntervalMs,
        setIntervalFn,
        scheduleImmediate,
        log: logger.log ? logger.log.bind(logger) : logger
      }),
      // Bao cao hang hoa (server/db/migrations/0018) - CHI tinh lai 1 lan/dem
      // (ham refreshProductReportIfDue tu kiem tra ngay VN, xem
      // productReportRefresh.js) du duoc kiem tra moi 5 phut nhu cac job tren.
      startProductReport(getPoolFn(), {
        intervalMs: productReportIntervalMs,
        setIntervalFn,
        scheduleImmediate,
        log: logger.log ? logger.log.bind(logger) : logger
      }),
      // Chi tiet hoa don 90 ngay theo khach (server/db/migrations/0022) - cung 1 ly do
      // nhu bao cao hang hoa o tren: chi dung lai 1 lan/dem sau 0h VN (ham
      // refreshCustomerInvoiceLinesIfDue tu kiem tra), du duoc kiem tra moi 5 phut.
      startCustomerInvoiceLines(getPoolFn(), {
        intervalMs: customerInvoiceLinesIntervalMs,
        setIntervalFn,
        scheduleImmediate,
        log: logger.log ? logger.log.bind(logger) : logger
      })
    ];
  }
  return { startPollingScheduler, runGroup };
}

const scheduler = createPollingScheduler();
module.exports = { ...scheduler, createPollingScheduler };
