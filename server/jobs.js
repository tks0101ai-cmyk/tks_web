'use strict';

// Cac job nen doc nguon ngoai (KiotViet, Google Sheets, Pancake) roi ghi Postgres.
// Chay chung tien trinh web (BACKGROUND_JOBS=inline) hoac tach rieng worker.js
// (BACKGROUND_JOBS=worker) de parse JSON / tinh toan nang khong chiem event loop
// cua web (do that 2026-10-20: /health 0,3s -> 2,4s khi job chay).
const CONFIG = require('./config');

function startBackgroundJobs() {
  const stops = [];

  stops.push(require('./productContainers/sync').startContainerSchedule());

  // CÂN ĐO: đọc Google Sheets theo chu kỳ vào Postgres, web chỉ đọc DB (Vị trí hàng cũ đã gỡ 2026-10-30).
  stops.push(require('./sheetSnapshots/sync').startSheetSnapshotSchedule());

  if (CONFIG.PANCAKE_MARKETING_SYNC_ENABLED) {
    const pancakeScheduler = require('./marketingReport/pancakeScheduler').createPancakeScheduler({ enabled: true });
    pancakeScheduler.start();
    stops.push(pancakeScheduler);
  }

  // Kiem tra gia ban: job 23:00 VN cong bo cua so 7 ngay (khoa advisory chong 2 instance, xem invoicePriceAudit/).
  if (CONFIG.INVOICE_PRICE_AUDIT_ENABLED) {
    const priceAuditScheduler = require('./invoicePriceAudit/priceAuditScheduler').createPriceAuditScheduler({ enabled: true });
    priceAuditScheduler.start().catch((err) => {
      console.error('[PriceAudit] Loi khoi dong lich:', err && err.code ? err.code : 'UNKNOWN');
    });
    stops.push(priceAuditScheduler);
  }

  // Trang thai boc hang theo Kiot (Dang boc + Kiot hoan thanh -> Da boc; + Kiot huy -> Chua boc): chi doc DB, nhe.
  if (CONFIG.PICK_KIOT_RECONCILE_ENABLED && CONFIG.SUPABASE_DB_URL) {
    const pickScheduler = require('./pickAssignments/pickKiotReconcileJob').createPickKiotReconcileScheduler({ enabled: true });
    pickScheduler.start();
    stops.push(pickScheduler);
  }

  if (CONFIG.KIOTVIET_SYNC_ENABLED || CONFIG.KIOTVIET_CASHBOOK_SYNC_ENABLED) {
    require('./kiotvietSync/scheduler').startPollingScheduler();
  }

  const stopAll = () => stops.forEach(job => job.stop());
  process.once('SIGTERM', stopAll);
  process.once('SIGINT', stopAll);
}

module.exports = { startBackgroundJobs };
