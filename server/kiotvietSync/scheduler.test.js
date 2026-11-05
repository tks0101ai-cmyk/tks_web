'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPollingScheduler } = require('./scheduler');

test('completed customer sync clears debt and aging caches and reward scores before notifying browsers, including remote sync', () => {
  const { dashboardRollupEvents: events } = require('./dashboardRollupEvents');
  const repository = require('../debtSchedule/debtScheduleRepository').getDebtScheduleRepository();
  const rewards = require('../debtSchedule/debtRewardService').getDebtRewardService();
  const aging = require('../debtSchedule/debtAgingRepository').getDebtAgingRepository();
  const clearAging = aging.clearCache;
  const bump = repository.bumpVersion, clear = rewards.clearScores;
  const calls = [];
  const updated = () => calls.push('notify');
  repository.bumpVersion = () => calls.push('debt');
  rewards.clearScores = () => calls.push('scores');
  aging.clearCache = () => calls.push('aging');
  events.on('updated', updated);
  try {
    events.emit('customersChanged', { branch: 'hanoi' });
    assert.deepEqual(calls, ['debt', 'aging', 'scores', 'notify']);
    calls.length = 0;
    events.emit('customersChanged', { branch: 'hanoi', remote: true });
    assert.deepEqual(calls, ['debt', 'aging', 'scores']);
  } finally {
    repository.bumpVersion = bump;
    rewards.clearScores = clear;
    aging.clearCache = clearAging;
    events.off('updated', updated);
  }
});

test('disabled scheduler creates no timers and touches no configuration, API, database, or rollup dependency', () => {
  let touched = 0;
  const scheduler = createPollingScheduler({
    enabled:false, cashbookEnabled:false, getConfiguredBranches:()=>{touched++;}, setIntervalFn:()=>{touched++;},
    getPool:()=>{touched++;}, startDashboardRollupSchedule:()=>{touched++;}
  });
  assert.deepEqual(scheduler.startPollingScheduler(), []);
  assert.equal(touched, 0);
});

test('scheduler creates independent fast and slow timers at configured intervals, plus a dashboard-rollup, customer-debt-report, product-report, customer-invoice-lines, inventory-value-snapshot and business-monthly schedule', () => {
  const timers = [];
  const immediate = [];
  const rollupCalls = [];
  const debtReportCalls = [];
  const productReportCalls = [];
  const product90dCalls = [];
  const invoiceLinesCalls = [];
  const inventorySnapshotCalls = [];
  const businessMonthlyCalls = [];
  const debtCycleCalls = [];
  const scheduler = createPollingScheduler({
    enabled:true, fastIntervalMs:7, slowIntervalMs:20, dashboardRollupIntervalMs:300000, customerDebtReportIntervalMs:300000, productReportIntervalMs:300000, customerInvoiceLinesIntervalMs:300000, inventoryValueSnapshotIntervalMs:60000, businessMonthlyIntervalMs:300000,
    getConfiguredBranches:()=>[], setIntervalFn:(fn,ms)=>(timers.push({fn,ms}),ms),
    scheduleImmediate:(fn)=>immediate.push(fn),
    getPool:()=>'fake-pool',
    startDashboardRollupSchedule:(pool,opts)=>{rollupCalls.push({pool,...opts}); return 'rollup-handle';},
    startCustomerDebtReportRefreshSchedule:(pool,opts)=>{debtReportCalls.push({pool,...opts}); return 'debt-report-handle';},
    startProductReportSchedule:(pool,opts)=>{productReportCalls.push({pool,...opts}); return 'product-report-handle';},
    startProduct90dReportSchedule:(pool,opts)=>{product90dCalls.push({pool,...opts}); return 'product-90d-handle';},
    startCustomerInvoiceLinesSchedule:(pool,opts)=>{invoiceLinesCalls.push({pool,...opts}); return 'invoice-lines-handle';},
    startInventoryValueSnapshotSchedule:(pool,opts)=>{inventorySnapshotCalls.push({pool,...opts}); return 'inventory-snapshot-handle';},
    startBusinessMonthlySchedule:(pool,opts)=>{businessMonthlyCalls.push({pool,...opts}); return 'business-monthly-handle';},
    startDebtCycleSnapshotSchedule:(pool,opts)=>{debtCycleCalls.push({pool,...opts}); return 'debt-cycle-handle';}
  });
  assert.deepEqual(scheduler.startPollingScheduler(), [7,20,86400000,60000,'rollup-handle','debt-report-handle','product-report-handle','product-90d-handle','invoice-lines-handle','inventory-snapshot-handle','business-monthly-handle','debt-cycle-handle']);
  assert.equal(product90dCalls.length, 1);
  assert.equal(product90dCalls[0].pool, 'fake-pool');
  assert.equal(product90dCalls[0].intervalMs, 60000);
  assert.equal(typeof product90dCalls[0].scheduleImmediate, 'function');
  assert.deepEqual(timers.map((x)=>x.ms), [7,20,86400000,60000]);
  assert.equal(immediate.length, 1);
  assert.equal(rollupCalls.length, 1);
  assert.equal(rollupCalls[0].pool, 'fake-pool');
  assert.equal(rollupCalls[0].intervalMs, 300000);
  // Ca 5 lich con deu phai nhan scheduleImmediate de con chay ngay luc khoi dong.
  assert.equal(typeof rollupCalls[0].scheduleImmediate, 'function');
  assert.equal(typeof debtReportCalls[0].scheduleImmediate, 'function');
  assert.equal(typeof productReportCalls[0].scheduleImmediate, 'function');
  assert.equal(typeof invoiceLinesCalls[0].scheduleImmediate, 'function');
  assert.equal(typeof inventorySnapshotCalls[0].scheduleImmediate, 'function');
  assert.equal(typeof businessMonthlyCalls[0].scheduleImmediate, 'function');
  assert.equal(debtReportCalls.length, 1);
  assert.equal(debtReportCalls[0].pool, 'fake-pool');
  assert.equal(debtReportCalls[0].intervalMs, 300000);
  assert.equal(productReportCalls.length, 1);
  assert.equal(productReportCalls[0].pool, 'fake-pool');
  assert.equal(productReportCalls[0].intervalMs, 300000);
  assert.equal(invoiceLinesCalls.length, 1);
  assert.equal(invoiceLinesCalls[0].pool, 'fake-pool');
  assert.equal(invoiceLinesCalls[0].intervalMs, 300000);
  assert.equal(inventorySnapshotCalls.length, 1);
  assert.equal(inventorySnapshotCalls[0].pool, 'fake-pool');
  assert.equal(inventorySnapshotCalls[0].intervalMs, 60000);
  assert.equal(businessMonthlyCalls.length, 1);
  assert.equal(businessMonthlyCalls[0].pool, 'fake-pool');
  assert.equal(businessMonthlyCalls[0].intervalMs, 300000);
  assert.equal(debtCycleCalls.length, 1);
  assert.equal(debtCycleCalls[0].pool, 'fake-pool');
  assert.equal(debtCycleCalls[0].intervalMs, 60000);
  assert.equal(typeof debtCycleCalls[0].beforeSnapshot, 'function');
  assert.equal(typeof debtCycleCalls[0].onSnapshot, 'function');
});

test('cashbook-only sync runs both branches on its own timer while other jobs remain disabled', async () => {
  const timers = [], immediate = [], calls = [];
  const scheduler = createPollingScheduler({
    enabled: false, cashbookEnabled: true, cashbookIntervalMs: 60000,
    getConfiguredBranches: () => [{ branch: 'hanoi' }, { branch: 'saigon' }],
    createKiotVietClient: () => ({}), pollEntityOnce: async (_api, branch, entity) => calls.push(`${branch}:${entity.entity}`),
    setIntervalFn: (fn, ms) => (timers.push({ fn, ms }), ms), scheduleImmediate: fn => immediate.push(fn),
    getPool: () => ({ query: async () => ({ rows: [{ id: 1 }] }) }),
    startDashboardRollupSchedule: () => { throw Error('unrelated rollup'); }
  });
  scheduler.startPollingScheduler();
  immediate[0]();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.sort(), ['hanoi:cash_flows', 'saigon:cash_flows']);
  calls.length = 0;
  await timers.find(t => t.ms === 60000).fn();
  assert.deepEqual(calls.sort(), ['hanoi:cash_flows', 'saigon:cash_flows']);
  assert.deepEqual(timers.map(t => t.ms).sort((a,b) => a-b), [60000, 86400000]);
});

test('cash flow synchronization is excluded from the slow group and overlapping cashbook ticks are skipped', async () => {
  const timers = [], calls = [];
  let finish, hold = false;
  const scheduler = createPollingScheduler({
    enabled: true, cashbookIntervalMs: 60000,
    getConfiguredBranches: () => [{ branch: 'hanoi' }], createKiotVietClient: () => ({}),
    pollEntityOnce: async (_api, _branch, entity) => {
      calls.push(entity.entity);
      if (hold && entity.entity === 'cash_flows') await new Promise(r => { finish = r; });
    },
    setIntervalFn: (fn, ms) => (timers.push({ fn, ms }), ms), scheduleImmediate: () => {},
    getPool: () => ({}), startDashboardRollupSchedule: () => {}, startCustomerDebtReportRefreshSchedule: () => {},
    startProductReportSchedule: () => {}, startProduct90dReportSchedule: () => {}, startCustomerInvoiceLinesSchedule: () => {}, startInventoryValueSnapshotSchedule: () => {},
    startBusinessMonthlySchedule: () => {},
    startDebtCycleSnapshotSchedule: () => {}
  });
  scheduler.startPollingScheduler();
  await timers[1].fn();
  assert.ok(!calls.includes('cash_flows'));
  hold = true;
  const timer = timers.find(t => t.ms === 60000);
  const pending = timer.fn();
  await new Promise(r => setImmediate(r));
  await timer.fn();
  assert.equal(calls.filter(x => x === 'cash_flows').length, 1);
  finish(); await pending;
});

test('scheduler schedules an immediate background catch-up from persisted checkpoints', async () => {
  const immediate = [];
  const calls = [];
  const hotRollups = [];
  const scheduler = createPollingScheduler({
    enabled:true,
    getConfiguredBranches:()=>[{branch:'hanoi',clientId:'1',clientSecret:'2',retailer:'hn'}],
    createKiotVietClient:()=>({}),
    pollEntityOnce:async (_api,branch,entity)=>calls.push(`${branch}:${entity.entity}`),
    setIntervalFn:()=>({}),
    scheduleImmediate:(fn)=>immediate.push(fn),
    getPool:()=>({query:async()=>({rows:[{id:1}]})}),
    refreshDashboardRollupsAndNotify:async (_pool,opts)=>{hotRollups.push(opts);},
    startDashboardRollupSchedule:()=>({}),
    startCustomerDebtReportRefreshSchedule:()=>({}),
    startProductReportSchedule:()=>({}),
    startProduct90dReportSchedule:()=>({}),
    startCustomerInvoiceLinesSchedule:()=>({}),
    startInventoryValueSnapshotSchedule:()=>({}),
    startBusinessMonthlySchedule:()=>({}),startDebtCycleSnapshotSchedule:()=>({})
  });

  scheduler.startPollingScheduler();
  assert.equal(immediate.length, 1);
  immediate[0]();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(calls.includes('hanoi:invoices'));
  assert.ok(calls.includes('hanoi:cash_flows'));
});

test('moi luot sync fast keo theo mot luot rollup "nong" ngay sau do', async () => {
  const timers = [];
  const order = [];
  const scheduler = createPollingScheduler({
    enabled:true,
    getConfiguredBranches:()=>[{branch:'hanoi',clientId:'1',clientSecret:'2',retailer:'hn'}],
    createKiotVietClient:()=>({}),
    pollEntityOnce:async (_api,branch,entity)=>order.push(`sync:${entity.entity}`),
    setIntervalFn:(fn,ms)=>(timers.push({fn,ms}),ms),
    scheduleImmediate:()=>{},
    getPool:()=>'fake-pool',
    refreshDashboardRollupsAndNotify:async (pool,opts)=>{order.push(`rollup:${pool}:${opts.windowDays}:${opts.includeFirstPurchase}`);},
    startDashboardRollupSchedule:()=>'rollup-handle',
    startCustomerDebtReportRefreshSchedule:()=>'debt-handle',
    startProductReportSchedule:()=>'product-handle',
    startProduct90dReportSchedule:()=>({}),
    startCustomerInvoiceLinesSchedule:()=>'invoice-lines-handle',
    startInventoryValueSnapshotSchedule:()=>'inventory-snapshot-handle',
    startBusinessMonthlySchedule:()=>'business-monthly-handle',startDebtCycleSnapshotSchedule:()=>'debt-cycle-handle'
  });

  scheduler.startPollingScheduler();
  await timers[0].fn(); // nhip fast

  assert.ok(order.includes('sync:invoices'));
  // Rollup phai chay SAU khi sync xong, neu khong thi van tong hop du lieu cu.
  assert.equal(order[order.length - 1], 'rollup:fake-pool:7:false');
});

test('one branch/entity failure is recorded without blocking other work', async () => {
  const timers = [];
  const calls = [];
  const failures = [];
  const scheduler = createPollingScheduler({
    enabled:true, getConfiguredBranches:()=>[
      {branch:'hanoi',clientId:'1',clientSecret:'2',retailer:'hn'},
      {branch:'saigon',clientId:'3',clientSecret:'4',retailer:'sg'}
    ],
    createKiotVietClient:(config)=>({branch:config.retailer}),
    pollEntityOnce:async (_api,branch,entity)=>{ calls.push(`${branch}:${entity.entity}`); if(branch==='hanoi'&&entity.entity==='invoices') throw new Error('down'); },
    recordFailure:async (...args)=>failures.push(args),
    setIntervalFn:(fn,ms)=>(timers.push({fn,ms}),ms),
    scheduleImmediate:()=>{},
    getPool:()=>'fake-pool',
    refreshDashboardRollupsAndNotify:async ()=>{},
    startDashboardRollupSchedule:()=>'rollup-handle'
  });
  scheduler.startPollingScheduler();
  await timers[0].fn();
  assert.ok(calls.includes('saigon:orders'));
  assert.deepEqual(failures, [['hanoi','invoices','down']]);
});

test('explicit customer sync reports branch failures instead of claiming a complete refresh', async () => {
  const completed = [], failures = [];
  const scheduler = createPollingScheduler({
    getConfiguredBranches: () => [{ branch: 'hanoi' }, { branch: 'saigon' }],
    createKiotVietClient: () => ({}),
    pollEntityOnce: async (_api, branch) => {
      if (branch === 'hanoi') throw Error('source unavailable');
      completed.push(branch);
    },
    recordFailure: async (...args) => failures.push(args)
  });
  await assert.rejects(scheduler.syncCustomers(), /chưa hoàn tất.*source unavailable/);
  assert.deepEqual(completed, ['saigon']);
  assert.deepEqual(failures, [['hanoi', 'customers', 'source unavailable']]);
});

function bankScheduler({empty=true,queryError=false,clientError=false,pollError=false,recordError=false}={}) {
 const timers=[],immediate=[],calls=[],failures=[],errors=[];
 const scheduler=createPollingScheduler({enabled:true,getConfiguredBranches:()=>[{branch:'hanoi'},{branch:'saigon'}],
 createKiotVietClient:b=>{if(clientError&&b.branch==='hanoi')throw Error('client');return {};},
 pollEntityOnce:async(_a,b,e)=>{calls.push(b+':'+e.entity);if(pollError&&b==='hanoi'&&e.entity==='cash_book_accounts')throw Error('poll');},
 recordFailure:async(...args)=>{failures.push(args);if(recordError)throw Error('record');},
 setIntervalFn:(fn,ms)=>(timers.push({fn,ms}),ms),scheduleImmediate:fn=>immediate.push(fn),
 getPool:()=>({query:async()=>{if(queryError)throw Error('database');return {rows:empty?[]:[{id:1}]};}}),
 refreshDashboardRollupsAndNotify:async()=>{},startDashboardRollupSchedule:()=>{},startCustomerDebtReportRefreshSchedule:()=>{},
 startProductReportSchedule:()=>{},startProduct90dReportSchedule:()=>{},startCustomerInvoiceLinesSchedule:()=>{},startInventoryValueSnapshotSchedule:()=>{},startBusinessMonthlySchedule:()=>{},startDebtCycleSnapshotSchedule:()=>{},
 logger:{log(){},warn(){},error:(...args)=>errors.push(args)}});
 scheduler.startPollingScheduler();return {timers,immediate,calls,failures,errors};
}
test('empty account catalog syncs both branches on startup; populated catalog waits for daily timer',async()=>{
 for(const empty of [true,false]) {
  const x=bankScheduler({empty});x.immediate[0]();await new Promise(r=>setImmediate(r));
  assert.deepEqual(x.calls.filter(c=>c.endsWith(':cash_book_accounts')),empty?['hanoi:cash_book_accounts','saigon:cash_book_accounts']:[]);
  const timer=x.timers.find(t=>t.ms===86400000);assert.ok(timer);await timer.fn();
  assert.ok(x.calls.includes('hanoi:cash_book_accounts'));assert.ok(x.calls.includes('saigon:cash_book_accounts'));
 }
});
test('bank sync contains startup database errors, client construction and checkpoint recording failures',async()=>{
 const db=bankScheduler({queryError:true});db.immediate[0]();await new Promise(r=>setImmediate(r));assert.ok(db.errors.length);
 for(const opts of [{clientError:true},{pollError:true,recordError:true}]){
  const x=bankScheduler(opts);const timer=x.timers.find(t=>t.ms===86400000);assert.ok(timer);await timer.fn();
  assert.ok(x.calls.includes('saigon:cash_book_accounts'));assert.ok(x.failures.some(f=>f[0]==='hanoi'&&f[1]==='cash_book_accounts'));
  if(opts.recordError)assert.ok(x.errors.length);
 }
});

test('one KiotViet client per branch per run so the cached OAuth token is reused across entities',async()=>{
 const created=[];
 const scheduler=createPollingScheduler({enabled:true,getConfiguredBranches:()=>[{branch:'hanoi'},{branch:'saigon'}],
 createKiotVietClient:b=>{created.push(b.branch);return {};},pollEntityOnce:async()=>{},recordFailure:async()=>{},
 setIntervalFn:(fn,ms)=>ms,scheduleImmediate:()=>{},getPool:()=>({query:async()=>({rows:[{id:1}]})}),
 refreshDashboardRollupsAndNotify:async()=>{},startDashboardRollupSchedule:()=>{},startCustomerDebtReportRefreshSchedule:()=>{},
 startProductReportSchedule:()=>{},startProduct90dReportSchedule:()=>{},startCustomerInvoiceLinesSchedule:()=>{},startInventoryValueSnapshotSchedule:()=>{},startBusinessMonthlySchedule:()=>{},startDebtCycleSnapshotSchedule:()=>{},
 logger:{log(){},warn(){},error(){}}});
 await scheduler.runGroup([{entity:'a'},{entity:'b'},{entity:'c'}]);
 assert.deepEqual(created.sort(),['hanoi','saigon']);
});

function fastScheduler(overrides = {}) {
  const timers = [], order = [], errors = [];
  const scheduler = createPollingScheduler({
    enabled: true,
    getConfiguredBranches: () => [{ branch: 'hanoi', clientId: '1', clientSecret: '2', retailer: 'hn' }],
    createKiotVietClient: () => ({}),
    pollEntityOnce: async (_api, _branch, entity) => order.push(`sync:${entity.entity}`),
    setIntervalFn: (fn, ms) => (timers.push({ fn, ms }), ms), scheduleImmediate: () => {},
    getPool: () => 'fake-pool',
    refreshCustomerInvoiceLinesIncremental: async () => {}, refreshProductReportIncremental: async () => {},
    refreshDebtAging: async () => { order.push('debt-aging'); },
    refreshDashboardRollupsAndNotify: async () => { order.push('rollup'); },
    startDashboardRollupSchedule: () => 'rollup-handle', startCustomerDebtReportRefreshSchedule: () => 'debt-handle',
    startProductReportSchedule: () => 'product-handle', startProduct90dReportSchedule: () => '90d-handle', startCustomerInvoiceLinesSchedule: () => 'lines-handle',
    startInventoryValueSnapshotSchedule: () => 'inventory-handle', startBusinessMonthlySchedule: () => 'business-handle',
    startDebtCycleSnapshotSchedule: () => 'cycle-handle',
    logger: { log() {}, warn() {}, error: (...args) => errors.push(args.join(' ')) },
    ...overrides
  });
  scheduler.startPollingScheduler();
  return { timers, order, errors };
}

test('moi luot sync fast tinh san doanh so thang hien tai (bao cao kinh doanh) sau tuoi no va TRUOC rollup', async () => {
  const calls = [];
  const x = fastScheduler({
    refreshBusinessCurrentMonth: async (pool, opts) => { x.order.push('business-current-month'); calls.push({ pool, log: typeof opts.log }); }
  });
  await x.timers[0].fn();
  const at = name => x.order.indexOf(name);
  assert.ok(at('sync:invoices') < at('debt-aging'));
  assert.ok(at('debt-aging') < at('business-current-month'));
  assert.ok(at('business-current-month') < at('rollup'));
  assert.deepEqual(calls, [{ pool: 'fake-pool', log: 'function' }]);
});

test('loi khi tinh san doanh so thang hien tai khong lam hong luot rollup, chi ghi log', async () => {
  const x = fastScheduler({ refreshBusinessCurrentMonth: async () => { throw new Error('mat ket noi'); } });
  await x.timers[0].fn();
  assert.ok(x.order.includes('rollup'), 'rollup van chay');
  assert.ok(x.errors.some(line => /mat ket noi/.test(line) && /kinh doanh/.test(line)));
});
