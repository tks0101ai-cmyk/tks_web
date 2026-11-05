'use strict';

// Tien trinh job nen rieng (Render Background Worker): `npm run worker`.
// Web dat BACKGROUND_JOBS=worker de khong chay trung job. Chi duoc chay DUNG 1
// worker (job dung timer in-process). Su kien doi du lieu gui sang web qua
// pg_notify (kiotvietSync/dashboardRollupEvents.js).
const CONFIG = require('./config');
const { getPool } = require('./db/pool');
const { publishToPostgres } = require('./kiotvietSync/dashboardRollupEvents');
const { startBackgroundJobs } = require('./jobs');

process.on('uncaughtException', (err) => {
  console.error('[Worker] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Worker] Unhandled rejection:', reason);
});

publishToPostgres(getPool());
startBackgroundJobs();

if (CONFIG.MEMORY_MONITOR) {
  const memoryMonitor = require('./lib/memoryMonitor').startMemoryMonitor({
    getPoolStats: () => {const p=getPool();return {total:p.totalCount,idle:p.idleCount,waiting:p.waitingCount};},
    intervalMs: CONFIG.MEMORY_LOG_INTERVAL_MS,
    limitMb: CONFIG.MEMORY_LIMIT_MB
  });
  process.once('SIGTERM', () => memoryMonitor.stop());
  process.once('SIGINT', () => memoryMonitor.stop());
}

console.log('[Worker] Job nen da khoi dong');
