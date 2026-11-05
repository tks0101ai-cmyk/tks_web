const test = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryMonitor } = require('./memoryMonitor');

const MB = 1048576;

function setup(rssMb, limitMb) {
  const logs = [];
  const warns = [];
  let fn = null;
  let unrefCalled = false;
  const fakeTimer = { unref() { unrefCalled = true; } };
  const monitor = startMemoryMonitor({
    intervalMs: 1000,
    limitMb,
    logger: { log: (s) => logs.push(s), warn: (s) => warns.push(s) },
    setIntervalFn: (f) => { fn = f; return fakeTimer; },
    memoryUsage: () => ({ rss: rssMb * MB, heapUsed: 10 * MB, external: 2 * MB, arrayBuffers: 1 * MB })
  });
  return { monitor, logs, warns, run: () => fn(), unref: () => unrefCalled };
}

test('ghi log moi chu ky va unref timer', () => {
  const t = setup(100, 2048);
  assert.equal(t.unref(), true);
  t.run();
  assert.equal(t.logs.filter(line=>line.startsWith('[Memory]')).length, 1);
  assert.match(t.logs[0], /\[Memory\] rss=100MB heap=10MB external=2MB arrayBuffers=1MB/);
  assert.equal(t.warns.length, 0);
  t.monitor.stop();
});

test('canh bao khi rss > 75% tran', () => {
  const t = setup(1600, 2048);
  t.run();
  assert.equal(t.warns.length, 1);
  t.monitor.stop();
});

test('khong canh bao khi rss bang dung 75% tran', () => {
  const t = setup(1536, 2048);
  t.run();
  assert.equal(t.warns.length, 0);
  t.monitor.stop();
});

test('reports event-loop delay, pool pressure and cache outcomes without source data',()=>{
  const logs=[];let enabled=false,disabled=false,resets=0;
  const loopDelay={enable(){enabled=true;},disable(){disabled=true;},reset(){resets++;},percentile:()=>23000000,max:47000000};
  const monitor=startMemoryMonitor({logger:{log:s=>logs.push(s),warn(){}},loopDelay,
    getPoolStats:()=>({total:7,idle:2,waiting:3}),
    cacheStats:{hit:10,miss:2,error:1,bypass:3},setIntervalFn:()=>({unref(){}})});
  monitor.tick();monitor.stop();
  assert.equal(enabled,true);assert.equal(disabled,true);assert.equal(resets,1);
  assert.match(logs.join('\n'),/eventLoopP95=23ms eventLoopMax=47ms/);
  assert.match(logs.join('\n'),/poolTotal=7 poolIdle=2 poolWaiting=3/);
  assert.match(logs.join('\n'),/cacheHit=10 cacheMiss=2 cacheError=1 cacheBypass=3/);
});
