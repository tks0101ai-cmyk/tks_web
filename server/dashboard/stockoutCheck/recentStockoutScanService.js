'use strict';

const {
  analyzeStockoutTimeline,
  computeStockoutWindow,
  maxDateKey,
  hasUnreliableZeroOnHand,
  buildUnreliableDataWarning,
  STOCKOUT_DATA_FLOOR_DATE_KEY
} = require('./stockoutEngine');
const { todayVnDateKey } = require('./dateHelpers');
const { loadActiveCandidates: defaultLoadActiveCandidates } = require('./productLoader');
const { loadStockoutEvents: defaultLoadStockoutEvents } = require('./stockoutEventLoader');

const DEFAULT_MIN_CONSECUTIVE_DAYS = 5;
const DEFAULT_DAYS_BACK = 183;

async function runRecentStockoutScanJob(jobStore, jobId, deps = {}) {
  const {
    source,
    loadStockoutEvents = defaultLoadStockoutEvents,
    loadActiveCandidates = defaultLoadActiveCandidates,
    daysBack = DEFAULT_DAYS_BACK,
    todayKey = todayVnDateKey(),
    minConsecutiveDays = DEFAULT_MIN_CONSECUTIVE_DAYS,
    dataFromDateFloor = STOCKOUT_DATA_FLOOR_DATE_KEY,
    branch = null
  } = deps;

  try {
    jobStore.updateProgress(jobId, { progress: { phase: 1 } });
    const { candidates: allActive, totalProductsScanned } = await loadActiveCandidates(source);
    // Giu nguyen ngu nghia cu cua "Hang dut gan day": chi bao cao ma DANG het
    // hang (ton kho hien tai = 0) va van con dut den hom nay.
    const candidates = allActive.filter((c) => c.currentOnHand === 0);
    const { calculationFromDate } = computeStockoutWindow({
      todayKey, daysBack, minConsecutiveDays, dataFromDateFloor
    });

    if (candidates.length === 0) {
      jobStore.setResult(jobId, { asOfDate: todayKey, branch, totalProductsScanned, totalCandidates: 0, sources: {}, warnings: [], rows: [] });
      return;
    }

    const validCodeSet = new Set(candidates.map((c) => c.code));
    const { eventMapByCode, sources, warnings } = await loadStockoutEvents({
      source,
      validCodeSet,
      fromDate: calculationFromDate,
      toDate: todayKey,
      onProgress(sourceProgress) {
        jobStore.updateProgress(jobId, { progress: {
          phase: 2,
          source: sourceProgress.source,
          sourceLabel: sourceProgress.label,
          sourceStatus: sourceProgress.status,
          phase2: sourceProgress
        } });
      }
    });

    const rows = [];
    let analyzed = 0;
    let unreliable = 0;
    for (const { code, name, createdDateKey } of candidates) {
      const events = eventMapByCode.get(code) || [];
      // Khong co bat ky giao dich nao (ban/nhap/tra) trong ca ky nghia la
      // khong co bang chung thuc te ma nay tung "dut hang" — chi la ton kho
      // dung im o 0, khong ai dong tram. Bo qua de tranh hang loat ma trung
      // het ngay bat dau (dung diem san dataFromDateFloor) chi vi thieu du
      // lieu, khong phai vi thuc su dut hang.
      if (events.length === 0) continue;
      // Ton kho hien tai = 0 nhung giao dich gan nhat la Nhap hang chua bi
      // tieu thu — Sheet Hang hoa (khong co vong doi soat dinh ky) gan nhu
      // chac chan da loi thoi. Bo qua thay vi bao dut hang sai tren du lieu
      // khong dang tin.
      if (hasUnreliableZeroOnHand(events)) continue;
      const { periods, hasUnreliableData } = analyzeStockoutTimeline({
        currentOnHand: 0, events, todayKey, daysBack, minConsecutiveDays,
        // Mot ma moi tao (createdDateKey) khong the dut hang truoc khi no
        // ton tai trong he thong — ghim moc san rieng cho ma nay.
        dataFromDateFloor: maxDateKey(dataFromDateFloor, createdDateKey)
      });
      analyzed++;
      if (hasUnreliableData) unreliable++;
      const lastPeriod = periods[periods.length - 1];
      if (!lastPeriod || lastPeriod.toDate !== todayKey) continue;
      rows.push({
        code,
        name,
        lastOutOfStockDate: lastPeriod.fromDate,
        daysOutOfStock: lastPeriod.days,
        periods,
        hasUnreliableData
      });
    }

    const qualityWarning = buildUnreliableDataWarning({ analyzed, unreliable });
    if (qualityWarning) warnings.push(qualityWarning);

    jobStore.setResult(jobId, {
      asOfDate: todayKey,
      branch,
      totalProductsScanned,
      totalCandidates: candidates.length,
      sources,
      warnings,
      rows
    });
  } catch (err) {
    jobStore.setError(jobId, { message: err.message, code: err.code || 'UNEXPECTED_ERROR' });
  }
}

module.exports = { runRecentStockoutScanJob };
