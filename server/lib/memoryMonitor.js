// Ghi log bo nho tien trinh dinh ky + canh bao som khi RSS tien sat tran RAM cua instance.
const WARN_RATIO = 0.75;

function toMb(bytes) {
  return Math.round((Number(bytes) || 0) / 1048576);
}

function startMemoryMonitor({
  intervalMs = 60000,
  limitMb = 2048,
  logger = console,
  setIntervalFn = setInterval,
  memoryUsage = () => process.memoryUsage(),
  loopDelay = require('node:perf_hooks').monitorEventLoopDelay({resolution:20}),
  getPoolStats = () => null,
  cacheStats = require('./sharedCache').sharedCache.stats
} = {}) {
  loopDelay.enable();
  function tick() {
    const m = memoryUsage();
    const rss = toMb(m.rss);
    logger.log(
      `[Memory] rss=${rss}MB heap=${toMb(m.heapUsed)}MB external=${toMb(m.external)}MB arrayBuffers=${toMb(m.arrayBuffers)}MB`
    );
    if (rss > limitMb * WARN_RATIO) {
      logger.warn(`[Memory] CANH BAO: rss=${rss}MB vuot ${Math.round(WARN_RATIO * 100)}% tran ${limitMb}MB`);
    }
    const ms = ns => Math.round((Number(ns)||0)/100000)/10;
    const p=getPoolStats() || {};
    logger.log(`[Performance] eventLoopP95=${ms(loopDelay.percentile(95))}ms eventLoopMax=${ms(loopDelay.max)}ms poolTotal=${p.total||0} poolIdle=${p.idle||0} poolWaiting=${p.waiting||0} cacheHit=${cacheStats.hit} cacheMiss=${cacheStats.miss} cacheError=${cacheStats.error} cacheBypass=${cacheStats.bypass}`);
    loopDelay.reset();
  }

  const timer = setIntervalFn(tick, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  return {
    stop() {
      clearInterval(timer);
      loopDelay.disable();
    },
    tick
  };
}

module.exports = { startMemoryMonitor };
