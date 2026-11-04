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
const { startProduct90dReportSchedule } = require('./product90dReport');
const { refreshProductReportIncremental } = require('./productReportIncremental');
const { startCustomerInvoiceLinesSchedule, refreshCustomerInvoiceLinesIncremental } = require('./customerInvoiceLinesRefresh');
const { startInventoryValueSnapshotSchedule } = require('./inventoryValueSnapshot');
const { startBusinessMonthlySchedule } = require('./businessMonthlyRefresh');
const { startDebtCycleSnapshotSchedule } = require('../debtSchedule/debtCycleSnapshot');
const { dashboardRollupEvents } = require('./dashboardRollupEvents');
const debtScheduleRepository = require('../debtSchedule/debtScheduleRepository');
const { requestDebtAgingRefresh } = require('../debtSchedule/debtAgingRefresh');
const { requestBusinessCurrentMonthRefresh } = require('./businessCurrentMonthRefresh');

// Activity changes affect existing snapshots and monthly scoring immediately.
// Subscribe once per module, rather than once per scheduler/timer instance.
dashboardRollupEvents.on('customersChanged', (info) => {
  // Trang thai hoat dong doi -> loai khach khoi ca ban chot va bang tuoi no ngay khi doc lai.
  debtScheduleRepository.getDebtScheduleRepository().bumpVersion();
  require('../debtSchedule/debtAgingRepository').getDebtAgingRepository().clearCache();
  require('../debtSchedule/debtRewardService').getDebtRewardService().clearScores();
  // Su kien tu worker (remote): web chi xoa cache cua minh; 'updated' + tinh Tuoi no do worker lo.
  if (info && info.remote) return;
  dashboardRollupEvents.emit('updated', { at: Date.now() });
  // No hien tai vua doi -> tinh lai bang Tuoi no (migration 0059); doi thi bao client tai lai.
  requestDebtAgingRefresh().then(result => {
    if (result && result.changed) dashboardRollupEvents.emit('updated', { at: Date.now() });
  });
});

// Ban chot cong no moi o worker -> web tang phien ban de doc lai (tien trinh phat da tu tang).
dashboardRollupEvents.on('debtScheduleChanged', (info) => {
  if (info && info.remote) debtScheduleRepository.getDebtScheduleRepository().bumpVersion();
});

// orderSuppliers ("Dat hang nhap") o nhom fast: doi soat toan bo ~350 phieu chi vai
// request, va nhip 7 phut gan nhip snapshot ton kho (10 phut) nen hang vua nhap
// khong bi dem ca "dang van chuyen" lan "ton kho" lau.
const fastEntities = [require('./entities/invoices'), require('./entities/orders'), require('./entities/productOnHands'),
  require('./entities/productOnHandsSnapshot'), require('./entities/orderSuppliers')];
const slowEntities = [require('./entities/categories'), require('./entities/products'), require('./entities/customers'),
  require('./entities/returns'), require('./entities/purchases')];

const customersEntity = slowEntities.find(entity => entity.entity === 'customers');
// Poll tang dan khong thay khach bi chuyen sang "ngung hoat dong" (KiotViet khong bump modifiedDate),
// nen chi doi soat day du moi 24 gio. Cong no can quet day du (reconcile) ngay truoc khi chot / tinh lai
// de khach ngung hoat dong bi loai khoi tab Cong no ngay, khong cho toi 24 gio.
const customersFullScanEntity = { ...customersEntity, reconcileIntervalMs: 1 };
const bankAccounts = require('./entities/bankAccounts');
const cashFlows = require('./entities/cashFlows');

function createPollingScheduler({
  enabled = CONFIG.KIOTVIET_SYNC_ENABLED,
  fastIntervalMs = CONFIG.KIOTVIET_SYNC_FAST_INTERVAL_MS,
  slowIntervalMs = CONFIG.KIOTVIET_SYNC_SLOW_INTERVAL_MS,
  cashbookEnabled = enabled || CONFIG.KIOTVIET_CASHBOOK_SYNC_ENABLED,
  cashbookIntervalMs = CONFIG.KIOTVIET_CASHBOOK_SYNC_INTERVAL_MS,
  // Luot rollup DAY DU (400 ngay, ~6,4s + ghi de ~61.000 dong do 2026-09-24)
  // chi con phai lo phan lich su: nhung ngay gan day da duoc luot "nong" chay
  // ngay sau moi luot sync fast lam moi. Vi vay gian ra 30 phut thay vi 5 phut.
  dashboardRollupIntervalMs = 30 * 60 * 1000,
  customerDebtReportIntervalMs = 5 * 60 * 1000,
  productReportIntervalMs = 5 * 60 * 1000,
  product90dReportIntervalMs = 60 * 1000,
  customerInvoiceLinesIntervalMs = 5 * 60 * 1000,
  // Chup gia tri ton kho luc 23:59 VN: kiem tra moi 1 phut de khong truot qua phut do.
  inventoryValueSnapshotIntervalMs = 60 * 1000,
  businessMonthlyIntervalMs = 5 * 60 * 1000,
  // Chot cong no luc 15:00 VN: kiem tra moi phut.
  debtCycleSnapshotIntervalMs = 60 * 1000,
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
  startProduct90dReportSchedule: startProduct90dReport = startProduct90dReportSchedule,
  startCustomerInvoiceLinesSchedule: startCustomerInvoiceLines = startCustomerInvoiceLinesSchedule,
  refreshCustomerInvoiceLinesIncremental: refreshInvoiceLinesIncremental = refreshCustomerInvoiceLinesIncremental,
  refreshProductReportIncremental: refreshProductReportIncrementally = refreshProductReportIncremental,
  refreshDebtAging = requestDebtAgingRefresh,
  refreshBusinessCurrentMonth = requestBusinessCurrentMonthRefresh,
  startInventoryValueSnapshotSchedule: startInventoryValueSnapshot = startInventoryValueSnapshotSchedule,
  startBusinessMonthlySchedule: startBusinessMonthly = startBusinessMonthlySchedule,
  startDebtCycleSnapshotSchedule: startDebtCycleSnapshot = startDebtCycleSnapshotSchedule,
  logger = console
} = {}) {
  let cashbookRunning = false;
  async function runCashbook() {
    if (cashbookRunning) return;
    cashbookRunning = true;
    try { await runGroup([cashFlows]); }
    catch (error) { logger.error('[KiotViet Sync] Lỗi sổ quỹ:', error.message); }
    finally { cashbookRunning = false; }
  }
  async function runGroup(entities, { throwOnError = false } = {}) {
    const branches = getBranches();
    if (!branches.length) {
      logger.warn('[KiotViet Sync] Không có cơ sở đủ cấu hình; bỏ qua nhịp polling.');
      if (throwOnError) throw new Error('Không có cơ sở KiotViet đủ cấu hình để đồng bộ khách hàng.');
      return;
    }
    const failures = [];
    await Promise.allSettled(branches.map(async (branchConfig) => {
      // 1 client/co so/luot: token OAuth duoc cache trong client, tao client
      // rieng cho tung entity se xin token moi lien tuc. Loi tao client van
      // ghi checkpoint loi cho tung entity nhu loi poll.
      let api = null;
      let clientError = null;
      try { api = createClient(branchConfig); } catch (error) { clientError = error; }
      await Promise.allSettled(entities.map(async (entity) => {
        try {
          if (clientError) throw clientError;
          await poll(api, branchConfig.branch, entity);
        } catch (error) {
          failures.push(error);
          await record(branchConfig.branch, entity.entity, error.message).catch((recordError) => {
            logger.error('[KiotViet Sync] Không ghi được lỗi checkpoint:', recordError.message);
          });
        }
      }));
    }));
    if (throwOnError && failures.length) throw new Error('Đồng bộ khách hàng chưa hoàn tất: ' + failures.map(error => error.message).join('; '));
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
    // Doanh thu theo khach lam moi TANG DAN ngay sau khi hoa don vua ve (chi khi
    // REPORTS_INCREMENTAL_ENABLED=true; tat thi tra ve ngay). Chay TRUOC rollup + SSE de khi client duoc bao
    // "co du lieu moi" va tai lai thi bang chi tiet da cap nhat. Loi o day khong duoc lam hong luot rollup.
    try {
      await refreshInvoiceLinesIncremental(getPoolFn(), { log: logger.log ? logger.log.bind(logger) : logger });
    } catch (error) {
      logger.error('[KiotViet Sync] Lỗi làm mới tăng dần doanh thu theo khách:', error.message);
    }
    // Bang Tuoi no theo hoa don (migration 0059) tinh lai TRUOC rollup + SSE de client tai lai
    // thay ngay hoa don vua ve; ghi khac biet, nuot loi (khong lam hong luot rollup).
    await refreshDebtAging(getPoolFn(), { log: logger.log ? logger.log.bind(logger) : logger });
    // Doanh so thang hien tai cua Bao cao kinh doanh (migration 0068) tinh san vao business_current_month_*:
    // toi da 1 luot / 10 phut, chi tinh lai khi co chung tu/khach moi (synced_at), day du moi dem + khi sang thang.
    // Chay TRUOC rollup + SSE de client tai lai thay so moi; ghi khac biet, nuot loi (khong lam hong rollup).
    try {
      await refreshBusinessCurrentMonth(getPoolFn(), { log: logger.log ? logger.log.bind(logger) : logger });
    } catch (error) {
      logger.error('[KiotViet Sync] Lỗi tính sẵn doanh số tháng hiện tại (báo cáo kinh doanh):', error.message);
    }
    await refreshHotRollup(getPoolFn(), {
      windowDays: HOT_WINDOW_DAYS,
      includeFirstPurchase: false,
      getConfiguredBranches: getBranches,
      log: logger.log ? logger.log.bind(logger) : logger
    });
    // Bao cao hang hoa doc doanh so tu rollup 'nong' vua xong nen phai chay SAU no (chi khi
    // REPORTS_INCREMENTAL_ENABLED=true; ghi khac biet nen luot nhan roi ghi ~0 dong).
    try {
      await refreshProductReportIncrementally(getPoolFn(), { log: logger.log ? logger.log.bind(logger) : logger });
    } catch (error) {
      logger.error('[KiotViet Sync] Lỗi làm mới tăng dần báo cáo hàng hóa:', error.message);
    }
  }

  async function syncBankAccountsIfEmpty() {
    const result = await getPoolFn().query('SELECT id FROM cash_book_accounts LIMIT 1');
    if (!result.rows.length) await runGroup([bankAccounts]);
  }

  function runDailyBankAccounts() {
    return runGroup([bankAccounts]).catch(error => logger.error('[KiotViet Sync] Lỗi đồng bộ tài khoản:', error.message));
  }

  function startPollingScheduler() {
    if (!enabled && !cashbookEnabled) return [];
    // Chạy một lượt nền ngay khi service khởi động để bù khoảng trống từ
    // checkpoint gần nhất (ví dụ Render vừa ngủ/redeploy). Không await ở đây
    // để HTTP server vẫn sẵn sàng nhận request trong lúc đồng bộ catch-up.
    scheduleImmediate(() => {
      if (enabled) {
        runFastGroupAndRollup().catch((error) => logger.error('[KiotViet Sync] Lỗi lượt fast ban đầu:', error.message));
        runGroup(slowEntities).catch((error) => logger.error('[KiotViet Sync] Lỗi lượt slow ban đầu:', error.message));
      }
      if (cashbookEnabled) {
        syncBankAccountsIfEmpty().catch(error => logger.error('[KiotViet Sync] Lỗi tài khoản ban đầu:', error.message));
        runCashbook();
      }
    });
    if (!enabled) return [
      setIntervalFn(runDailyBankAccounts, 24 * 60 * 60 * 1000),
      setIntervalFn(runCashbook, cashbookIntervalMs)
    ];
    return [
      setIntervalFn(() => runFastGroupAndRollup(), fastIntervalMs),
      setIntervalFn(() => runGroup(slowEntities), slowIntervalMs),
      ...(cashbookEnabled ? [
        setIntervalFn(runDailyBankAccounts, 24 * 60 * 60 * 1000),
        setIntervalFn(runCashbook, cashbookIntervalMs)
      ] : []),
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
      // Independent 90-day snapshot (0106): once per VN day at/after 02:00;
      // minute ticks only check state, never trigger incremental refreshes.
      startProduct90dReport(getPoolFn(), {
        intervalMs: product90dReportIntervalMs,
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
      }),
      // Lich su gia tri ton kho theo ngay (server/db/migrations/0025) - CHI chup 1 lan/ngay
      // luc 23:59 VN (co chup bu sang hom sau truoc 12:00); ham
      // takeInventoryValueSnapshotIfDue tu kiem tra, du duoc goi moi phut.
      startInventoryValueSnapshot(getPoolFn(), {
        intervalMs: inventoryValueSnapshotIntervalMs,
        setIntervalFn,
        scheduleImmediate,
        log: logger.log ? logger.log.bind(logger) : logger
      }),
      // Bao cao kinh doanh (server/db/migrations/0036) - chot doanh so thang vua qua luc
      // >= 00:10 VN ngay mung 1 (backfill tu 2026-03 lan dau) + dung lai bang sale theo
      // nhom khach hien tai; ham refreshBusinessMonthlyIfDue tu kiem tra, goi moi 5 phut.
      startBusinessMonthly(getPoolFn(), {
        intervalMs: businessMonthlyIntervalMs,
        setIntervalFn,
        scheduleImmediate,
        log: logger.log ? logger.log.bind(logger) : logger
      }),
      // Cong no theo lich TT (migration 0047) - chot 1 lan/ngay luc 15:00 VN. Dong bo khach
      // ngay truoc khi chot de no hien tai khop KiotViet; chot xong tang phien ban de
      // dashboard doc ban moi.
      startDebtCycleSnapshot(getPoolFn(), {
        intervalMs: debtCycleSnapshotIntervalMs,
        setIntervalFn,
        scheduleImmediate,
        log: logger.log ? logger.log.bind(logger) : logger,
        beforeSnapshot: () => runGroup([customersFullScanEntity], { throwOnError: true }),
        onSnapshot: () => {
          debtScheduleRepository.getDebtScheduleRepository().bumpVersion();
          dashboardRollupEvents.emit('debtScheduleChanged', { at: Date.now() });
          // Ban chot 15:00 moi: bao client dang mo SSE tai lai, khong cho rollup 5 phut.
          dashboardRollupEvents.emit('updated', { at: Date.now() });
        }
      })
    ];
  }
  // Nut Tinh lai cong no: dong bo khach (no hien tai) ngay truoc khi tinh.
  const syncCustomers = () => runGroup([customersFullScanEntity], { throwOnError: true });

  return { startPollingScheduler, runGroup, syncCustomers };
}

const scheduler = createPollingScheduler();
module.exports = { ...scheduler, createPollingScheduler };
