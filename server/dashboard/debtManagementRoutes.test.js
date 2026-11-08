'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
// Schedule-route tests must never start the background refresh against the developer DB.
process.env.SUPABASE_DB_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const debtScheduleRepository = require('../debtSchedule/debtScheduleRepository');
const router = require('./debtManagementRoutes');

function fakeRes() {
  const res = { statusCode: 200, body: null, cookies: [] };
  res.status = code => { res.statusCode = code; return res; };
  res.json = body => { res.body = body; return res; };
  res.cookie = (...args) => { res.cookies.push(args); return res; };
  return res;
}

test('aging opt-in pages full filtered snapshot and returns linked facets/full debt totals', async () => {
  const service = require('../debtSchedule/debtScheduleService');
  const original = service.buildDebtAging;
  service.buildDebtAging = async () => ({ available: true, asOfDay: '2026-11-08', customers: Array.from({ length: 205 }, (_, i) => ({ customerName: 'Khách ' + i, sale: i % 2 ? 'A' : 'B', saleTeam: 'T', paymentSchedule: '30', currentDebt: i + .5 })) });
  try {
    const res = fakeRes();
    await routeStack('/api/debt-management/aging', 'get').at(-1)({ query: { page: 2, pageSize: 100, sorts: [{ key: 'currentDebt', dir: 'desc' }] } }, res);
    assert.equal(res.body.totalRows, 205);
    assert.equal(res.body.customers.length, 100);
    assert.equal(res.body.customers[0].currentDebt, 104.5);
    assert.equal(res.body.summary.currentDebt, 21012.5);
    assert.deepEqual(res.body.filters.sales, ['A', 'B']);
    assert.deepEqual(res.body.rows, res.body.customers);
  } finally { service.buildDebtAging = original; }
});

function routeStack(path, method = 'patch') {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method} ${path}`);
  return layer.route.stack.map(item => item.handle);
}

function withRepo(fake, run) {
  const original = debtScheduleRepository.getDebtScheduleRepository;
  debtScheduleRepository.getDebtScheduleRepository = () => fake;
  return Promise.resolve(run()).finally(() => { debtScheduleRepository.getDebtScheduleRepository = original; });
}

function withRewards(fake, run) {
  const service = require('../debtSchedule/debtRewardService');
  const original = service.getDebtRewardService;
  service.getDebtRewardService = () => fake;
  return Promise.resolve(run()).finally(() => { service.getDebtRewardService = original; });
}

function allowed(guard, role) {
  let nextCalled = false;
  guard({ user: { vaiTro: role } }, fakeRes(), () => { nextCalled = true; });
  return nextCalled;
}

test('quyen mac dinh: Sale phan hoi chi Nhan vien sale; QL phan hoi, trang thai, lich TT chi Quan ly', () => {
  const cases = [
    ['/api/debt-management/sale-feedback', { 'Nhân viên sale': true, 'Quản lý': false, 'Trợ lý': false }],
    ['/api/debt-management/manager-feedback', { 'Nhân viên sale': false, 'Quản lý': true, 'Trợ lý': false }],
    ['/api/debt-management/status', { 'Nhân viên sale': false, 'Quản lý': true, 'Trợ lý': false }],
    ['/api/debt-management/schedule', { 'Nhân viên sale': false, 'Quản lý': true, 'Trợ lý': false }]
  ];
  for (const [path, expected] of cases) {
    const [, featureGuard] = routeStack(path);
    for (const [role, ok] of Object.entries(expected)) assert.equal(allowed(featureGuard, role), ok, `${path} ${role}`);
  }
});

test('GET /cycles: can quyen xuat file, tra danh sach ban chot tu repository', async () => {
  const [authGuard, featureGuard, handler] = routeStack('/api/debt-management/cycles', 'get');
  const res0 = fakeRes();
  await authGuard({ cookies: {} }, res0, () => assert.fail('khong duoc next'));
  assert.equal(res0.statusCode, 401);
  assert.equal(typeof featureGuard, 'function');
  const cycles = [{ cycleDate: '2026-10-13', takenAt: 'x' }, { cycleDate: '2026-10-12', takenAt: 'y' }];
  await withRepo({ listCycles: async () => cycles }, async () => {
    const res = fakeRes();
    await handler({ user: { vaiTro: 'Quản lý' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { cycles });
  });
});

test('PATCH chua dang nhap tra 401', async () => {
  const [authGuard] = routeStack('/api/debt-management/sale-feedback');
  const res = fakeRes();
  await authGuard({ cookies: {} }, res, () => assert.fail('khong duoc next'));
  assert.equal(res.statusCode, 401);
});

test('PATCH sale-feedback chuyen dung tham so xuong repository, nguoi sua lay tu session', async () => {
  const handler = routeStack('/api/debt-management/sale-feedback').at(-1);
  let received;
  await withRepo({ saveFeedback: async payload => { received = payload; return { cycleDate: '2026-10-13', value: 'Hẹn thứ 6', by: 'Lan', changed: true }; } }, async () => {
    const res = fakeRes();
    await handler({ user: { id: 'u1', hoTen: 'Lan' }, body: { branch: 'hanoi', customerId: '42', cycleDate: '2026-10-13', value: 'Hẹn thứ 6' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.value, 'Hẹn thứ 6');
  });
  assert.deepEqual(received, {
    branch: 'hanoi', customerId: '42', cycleDate: '2026-10-13', field: 'sale', value: 'Hẹn thứ 6', user: { id: 'u1', hoTen: 'Lan' }
  });
});

test('loi nghiep vu (409 sang chu ky moi) tra nguyen ma loi; loi DB tra 503', async () => {
  const handler = routeStack('/api/debt-management/manager-feedback').at(-1);
  const conflict = Object.assign(new Error('Bảng công nợ đã sang chu kỳ mới'), { statusCode: 409, code: 'DEBT_CYCLE_CHANGED' });
  await withRepo({ saveFeedback: async () => { throw conflict; } }, async () => {
    const res = fakeRes();
    await handler({ user: {}, body: { branch: 'hanoi', customerId: '1', cycleDate: '2026-10-12', value: 'x' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'DEBT_CYCLE_CHANGED');
  });
  await withRepo({ saveFeedback: async () => { throw new Error('db down'); } }, async () => {
    const res = fakeRes();
    await handler({ user: {}, body: { branch: 'hanoi', customerId: '1', value: 'x' } }, res);
    assert.equal(res.statusCode, 503);
  });
});

test('PATCH status tu choi trang thai ngoai danh sach truoc khi cham DB', async () => {
  const handler = routeStack('/api/debt-management/status').at(-1);
  await withRepo({ saveStatus: async () => assert.fail('khong duoc ghi') }, async () => {
    const res = fakeRes();
    await handler({ user: {}, body: { branch: 'hanoi', customerId: '1', status: 'Không hợp lệ' } }, res);
    assert.equal(res.statusCode, 400);
  });
});

test('PATCH status voi historical=true sua ngay cu qua saveHistoricalStatus; khong co co thi van la saveStatus', async () => {
  const handler = routeStack('/api/debt-management/status').at(-1);
  const calls = [];
  const fake = {
    saveStatus: async payload => { calls.push(['current', payload]); return { status: 'Đã xử lý' }; },
    saveHistoricalStatus: async payload => { calls.push(['historical', payload]); return { status: 'Đã xử lý', changed: true, recalculatedDays: 2 }; }
  };
  await withRepo(fake, async () => {
    const res = fakeRes();
    await handler({ user: { id: 'u1', hoTen: 'QL' }, body: { branch: 'hanoi', customerId: '1', cycleDate: '2026-10-30', status: 'Đã xử lý', historical: true } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.recalculatedDays, 2);
    await handler({ user: {}, body: { branch: 'hanoi', customerId: '1', cycleDate: '2026-10-30', status: 'Đã xử lý', historical: 'true' } }, fakeRes());
  });
  assert.deepEqual(calls.map(call => call[0]), ['historical', 'current']);
  assert.deepEqual(calls[0][1], { branch: 'hanoi', customerId: '1', cycleDate: '2026-10-30', status: 'Đã xử lý', user: { id: 'u1', hoTen: 'QL' } });
});

test('khong con route phat tay /api/debt-management/penalty', () => {
  assert.equal(router.stack.some(item => item.route?.path === '/api/debt-management/penalty'), false);
});

test('GET customer-history: can quyen Cong no, chi cho co so nguoi xem duoc phep, chuyen branch + customerId xuong repository', async () => {
  const [authGuard, featureGuard, , handler] = routeStack('/api/debt-management/customer-history', 'get');
  const res0 = fakeRes();
  await authGuard({ cookies: {} }, res0, () => assert.fail('khong duoc next'));
  assert.equal(res0.statusCode, 401);
  assert.equal(typeof featureGuard, 'function');
  let received;
  await withRepo({ listCustomerHistory: async payload => { received = payload; return { customer: {}, days: [], totalPenalty: 0 }; } }, async () => {
    const res = fakeRes();
    await handler({ branch: 'Cả hai', user: {}, query: { branch: 'saigon', customerId: '9' } }, res);
    assert.equal(res.statusCode, 200);
    const forbidden = fakeRes();
    await handler({ branch: 'Hà Nội', user: {}, query: { branch: 'saigon', customerId: '9' } }, forbidden);
    assert.equal(forbidden.statusCode, 403);
  });
  assert.deepEqual(received, { branch: 'saigon', customerId: '9' });
});

test('PATCH schedule gui so ngay + nguoi sua xuong repository', async () => {
  const handler = routeStack('/api/debt-management/schedule').at(-1);
  let received;
  await withRepo({ setSchedule: async payload => { received = payload; return { scheduleDays: 3, changed: true }; } }, async () => {
    const res = fakeRes();
    await handler({ user: { hoTen: 'QL' }, body: { branch: 'saigon', customerId: '7', scheduleDays: '3' } }, res);
    assert.equal(res.statusCode, 200);
  });
  assert.deepEqual(received, { branch: 'saigon', customerId: '7', days: '3', user: { hoTen: 'QL' } });
});

test('GET feedback-history doc theo co so dang xem', async () => {
  const handler = routeStack('/api/debt-management/feedback-history', 'get').at(-1);
  let received;
  await withRepo({ listFeedbackHistory: async payload => { received = payload; return { cycleDate: '2026-10-13', entries: [] }; } }, async () => {
    const res = fakeRes();
    await handler({ branch: 'Cả hai', user: {} }, res);
    assert.equal(res.statusCode, 200);
  });
  assert.deepEqual(received, { branches: ['hanoi', 'saigon'] });
});

test('GET penalty-board: debt permission, requested month and display branch reach shared reward service', async () => {
  const [authGuard, featureGuard, , handler] = routeStack('/api/debt-management/penalty-board', 'get');
  const res0 = fakeRes();
  await authGuard({ cookies: {} }, res0, () => assert.fail('khong duoc next'));
  assert.equal(res0.statusCode, 401);
  assert.equal(allowed(featureGuard, 'Nhân viên sale'), true);
  const days = [{ cycleDate: '2026-10-13', sale: 'Lan', penalizedCustomers: 2, amount: 50000 }];
  let received;
  const board = { month: '2026-09', openCycleDate: null, days, rows: [{ sale: 'Lan', rank: 7 }], status: 'finalized' };
  await withRewards({
    readBoard: async payload => { received = payload; return board; }
  }, async () => {
    const res = fakeRes();
    await handler({ branch: 'Hà Nội', user: {}, query: { month: '2026-09' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, board);
  });
  assert.deepEqual(received, { month: '2026-09', branches: ['hanoi'] });
});

test('GET penalty-board: chua co ban chot thi tra rong, loi DB tra 503', async () => {
  const handler = routeStack('/api/debt-management/penalty-board', 'get').at(-1);
  await withRewards({ readBoard: async () => ({ month: null, openCycleDate: null, days: [] }) }, async () => {
    const res = fakeRes();
    await handler({ branch: 'Cả hai', user: {} }, res);
    assert.deepEqual(res.body, { month: null, openCycleDate: null, days: [] });
  });
  await withRewards({ readBoard: async () => { throw new Error('db down'); } }, async () => {
    const res = fakeRes();
    await handler({ branch: 'Cả hai', user: {} }, res);
    assert.equal(res.statusCode, 503);
  });
});

test('reward month errors preserve invalid/unavailable status and code', async () => {
  const handler = routeStack('/api/debt-management/penalty-board', 'get').at(-1);
  for (const statusCode of [400,404]) await withRewards({readBoard:async()=>{
    throw Object.assign(new Error('month'),{statusCode,code:'REWARD_MONTH'});
  }},async()=>{
    const res=fakeRes();await handler({branch:'Cả hai',query:{month:'x'},user:{}},res);
    assert.equal(res.statusCode,statusCode);assert.equal(res.body.code,'REWARD_MONTH');
  });
});

test('GET /aging: can quyen Cong no, loc theo co so dang xem, chi doc bang tinh san', async () => {
  const [authGuard, featureGuard, branchGuard, handler] = routeStack('/api/debt-management/aging', 'get');
  const res0 = fakeRes();
  await authGuard({ cookies: {} }, res0, () => assert.fail('khong duoc next'));
  assert.equal(res0.statusCode, 401);
  assert.equal(allowed(featureGuard, 'Quản lý'), true);
  assert.equal(allowed(featureGuard, 'Khách hàng'), false);
  assert.equal(typeof branchGuard, 'function');
  const agingRepo = require('../debtSchedule/debtAgingRepository');
  const original = agingRepo.getDebtAgingRepository;
  let received;
  agingRepo.getDebtAgingRepository = () => ({
    readAging: async branches => {
      received = branches;
      return { state: { asOfDay: '2026-10-17', refreshedAt: '2026-10-17T03:00:00.000Z', customersSyncedAt: null },
        rows: [{ branchCode: 'saigon', customerId: '1', customerName: 'Anh Sài', sale: null, scheduleDays: 2, currentDebt: 50,
          overdueDebt: 0, payoffDay: '2026-10-16', beyondHistory: false, equivalentDays: 1, remainingDays: 1 }] };
    }
  });
  try {
    const res = fakeRes();
    await handler({ user: { vaiTro: 'Quản lý' }, branch: 'Sài Gòn' }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(received, ['saigon']);
    assert.equal(res.body.customers[0].remainingDays, 1);
    assert.equal(res.body.customers[0].branch, 'SG');
    assert.equal(res.body.available, true);
    agingRepo.getDebtAgingRepository = () => ({ readAging: async () => { throw new Error('db down'); } });
    const failed = fakeRes();
    const originalError = console.error;
    console.error = () => {};
    try { await handler({ user: { vaiTro: 'Quản lý' } }, failed); } finally { console.error = originalError; }
    assert.equal(failed.statusCode, 503);
    assert.equal(failed.body.code, 'DEBT_AGING_UNAVAILABLE');
  } finally {
    agingRepo.getDebtAgingRepository = original;
  }
});

test('GET /aging/invoices: can quyen Cong no, chi cho xem co so dang duoc phep, loi 4xx tra nguyen ma', async () => {
  const [authGuard, featureGuard, branchGuard, handler] = routeStack('/api/debt-management/aging/invoices', 'get');
  const res0 = fakeRes();
  await authGuard({ cookies: {} }, res0, () => assert.fail('khong duoc next'));
  assert.equal(res0.statusCode, 401);
  assert.equal(allowed(featureGuard, 'Quản lý'), true);
  assert.equal(allowed(featureGuard, 'Khách hàng'), false);
  assert.equal(typeof branchGuard, 'function');
  const agingRepo = require('../debtSchedule/debtAgingRepository');
  const original = agingRepo.getDebtAgingRepository;
  const calls = [];
  agingRepo.getDebtAgingRepository = () => ({
    readCustomerInvoices: async (branch, customerId) => {
      calls.push([branch, customerId]);
      return { customer: { customerName: 'Anh Sài', branchCode: 'saigon', currentDebt: 50, payoffDay: '2026-10-16', beyondHistory: false,
        equivalentDays: 1, remainingDays: 1, scheduleDays: 2 }, invoices: [{ code: 'HD1', date: '16/10/2026 09:00', seller: 'Tú', total: 80 }] };
    }
  });
  try {
    const res = fakeRes();
    await handler({ user: { vaiTro: 'Quản lý' }, branch: 'Sài Gòn', query: { branch: 'saigon', customerId: '1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [['saigon', '1']]);
    assert.equal(res.body.invoices[0].amount, 80);
    assert.equal(res.body.total, 80);
    const denied = fakeRes();
    await handler({ user: { vaiTro: 'Quản lý' }, branch: 'Sài Gòn', query: { branch: 'hanoi', customerId: '1' } }, denied);
    assert.equal(denied.statusCode, 403);
    const bad = fakeRes();
    await handler({ user: { vaiTro: 'Quản lý' }, branch: 'Sài Gòn', query: {} }, bad);
    assert.equal(bad.statusCode, 400);
  } finally {
    agingRepo.getDebtAgingRepository = original;
  }
});
