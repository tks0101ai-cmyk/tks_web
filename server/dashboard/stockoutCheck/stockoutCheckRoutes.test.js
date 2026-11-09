'use strict';
process.env.KIOTVIET_CLIENT_ID = process.env.KIOTVIET_CLIENT_ID || 'test-client-id';
process.env.KIOTVIET_CLIENT_SECRET = process.env.KIOTVIET_CLIENT_SECRET || 'test-client-secret';
process.env.KIOTVIET_RETAILER = process.env.KIOTVIET_RETAILER || 'test-retailer';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('./stockoutCheckRoutes');

function fakeRes() {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

function getRouteHandler(method, routePath) {
  const layer = router.stack.find((item) => item.route && item.route.path === routePath && item.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const recentStockoutScanService = require('./recentStockoutScanService');

test('POST /api/products/stockout-recent/scan: tao job va tra 202 + jobId', async () => {
  const original = recentStockoutScanService.runRecentStockoutScanJob;
  let called = false;
  recentStockoutScanService.runRecentStockoutScanJob = async () => { called = true; };
  try {
    const handler = getRouteHandler('post', '/api/products/stockout-recent/scan');
    const req = {};
    const res = fakeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 202);
    assert.equal(typeof res.body.jobId, 'string');
    assert.equal(router.jobStore.getJob(res.body.jobId).status, 'running');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, true);
  } finally {
    recentStockoutScanService.runRecentStockoutScanJob = original;
  }
});

test('GET /api/products/stockout-recent/:jobId/progress: job khong ton tai tra 404', async () => {
  const handler = getRouteHandler('get', '/api/products/stockout-recent/:jobId/progress');
  const req = { params: { jobId: 'khong-ton-tai' } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'JOB_NOT_FOUND');
});

test('GET /api/products/stockout-recent/:jobId/result: job dang chay tra 409 JOB_NOT_READY', async () => {
  const jobId = router.jobStore.createJob();
  const handler = getRouteHandler('get', '/api/products/stockout-recent/:jobId/result');
  const req = { params: { jobId } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'JOB_NOT_READY');
});

test('GET /api/products/stockout-recent/:jobId/result: job xong tra 200 + result', async () => {
  const jobId = router.jobStore.createJob();
  router.jobStore.setResult(jobId, { asOfDate: '2026-01-10', totalProductsScanned: 100, totalCandidates: 1, rows: [{ code: 'SP001', name: 'A', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6 }] });
  const handler = getRouteHandler('get', '/api/products/stockout-recent/:jobId/result');
  const req = { params: { jobId } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.rows.length, 1);
});

const stockout90dScanService = require('./stockout90dScanService');

test('POST /api/products/stockout-90d/scan: tao job va tra 202 + jobId', async () => {
  const original = stockout90dScanService.runStockout90dScanJob;
  let called = false;
  stockout90dScanService.runStockout90dScanJob = async () => { called = true; };
  try {
    const handler = getRouteHandler('post', '/api/products/stockout-90d/scan');
    const req = { branch: 'Hà Nội' };
    const res = fakeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 202);
    assert.equal(typeof res.body.jobId, 'string');
    assert.equal(router.jobStore.getJob(res.body.jobId).status, 'running');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, true);
  } finally {
    stockout90dScanService.runStockout90dScanJob = original;
  }
});

test('GET /api/products/stockout-90d/:jobId/progress: job khong ton tai tra 404', async () => {
  const handler = getRouteHandler('get', '/api/products/stockout-90d/:jobId/progress');
  const req = { params: { jobId: 'khong-ton-tai' } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'JOB_NOT_FOUND');
});

test('GET /api/products/stockout-90d/:jobId/result: job dang chay tra 409 JOB_NOT_READY', async () => {
  const jobId = router.jobStore.createJob();
  const handler = getRouteHandler('get', '/api/products/stockout-90d/:jobId/result');
  const req = { params: { jobId } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'JOB_NOT_READY');
});

test('GET /api/products/stockout-90d/:jobId/result: job xong tra 200 + result', async () => {
  const jobId = router.jobStore.createJob();
  router.jobStore.setResult(jobId, {
    asOfDate: '2026-01-20',
    fromDate: '2026-01-01',
    totalProductsScanned: 100,
    totalCandidates: 1,
    rows: [{ code: 'SP001', name: 'A', stockoutCount: 1, totalStockoutDays: 6, currentOnHand: 2 }]
  });
  const handler = getRouteHandler('get', '/api/products/stockout-90d/:jobId/result');
  const req = { params: { jobId } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.rows.length, 1);
});

const stockout30dScanService = require('./stockout30dScanService');

/** Chay handler POST quet va tra ve deps ma service nhan duoc (jobStore, jobId, deps). */
async function captureScanDeps(service, fnName, routePath, req) {
  const original = service[fnName];
  let captured = null;
  service[fnName] = async (_store, _jobId, deps) => { captured = deps; };
  try {
    const res = fakeRes();
    await getRouteHandler('post', routePath)(req, res);
    assert.equal(res.statusCode, 202);
    await new Promise((resolve) => setImmediate(resolve));
    return captured;
  } finally {
    service[fnName] = original;
  }
}

test('quet 30 ngay inject hook persistStockoutDays (mot co so), quet 90 ngay / gan day thi khong', async () => {
  const deps30 = await captureScanDeps(stockout30dScanService, 'runStockout30dScanJob', '/api/products/stockout-30d/scan', { branch: 'Sài Gòn' });
  assert.equal(typeof deps30.persistStockoutDays, 'function');
  assert.equal(deps30.branch, 'Sài Gòn');

  const deps90 = await captureScanDeps(stockout90dScanService, 'runStockout90dScanJob', '/api/products/stockout-90d/scan', { branch: 'Sài Gòn' });
  assert.equal(deps90.persistStockoutDays, undefined);

  const depsRecent = await captureScanDeps(recentStockoutScanService, 'runRecentStockoutScanJob', '/api/products/stockout-recent/scan', { branch: 'Sài Gòn' });
  assert.equal(depsRecent.persistStockoutDays, undefined);
});

test('quet 30 ngay o "Cả hai": moi co so vat ly deu co hook (chay qua job con)', async () => {
  const seen = [];
  const original = stockout30dScanService.runStockout30dScanJob;
  stockout30dScanService.runStockout30dScanJob = async (store, jobId, deps) => {
    seen.push({ branch: deps.branch, hook: typeof deps.persistStockoutDays });
    store.setResult(jobId, { asOfDate: '2026-01-10', totalProductsScanned: 0, totalCandidates: 0, sources: {}, warnings: [], rows: [] });
  };
  try {
    const res = fakeRes();
    await getRouteHandler('post', '/api/products/stockout-30d/scan')({ branch: 'Cả hai' }, res);
    assert.equal(res.statusCode, 202);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, [
      { branch: 'Hà Nội', hook: 'function' },
      { branch: 'Sài Gòn', hook: 'function' }
    ]);
  } finally {
    stockout30dScanService.runStockout30dScanJob = original;
  }
});

test('POST /api/products/stockout-30d/scan: tao job va tra 202 + jobId', async () => {
  const original = stockout30dScanService.runStockout30dScanJob;
  let called = false;
  stockout30dScanService.runStockout30dScanJob = async () => { called = true; };
  try {
    const handler = getRouteHandler('post', '/api/products/stockout-30d/scan');
    const req = { branch: 'Hà Nội' };
    const res = fakeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 202);
    assert.equal(typeof res.body.jobId, 'string');
    assert.equal(router.jobStore.getJob(res.body.jobId).status, 'running');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(called, true);
  } finally {
    stockout30dScanService.runStockout30dScanJob = original;
  }
});

test('GET /api/products/stockout-30d/:jobId/progress: job khong ton tai tra 404', async () => {
  const handler = getRouteHandler('get', '/api/products/stockout-30d/:jobId/progress');
  const req = { params: { jobId: 'khong-ton-tai' } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 404);
  assert.equal(res.body.code, 'JOB_NOT_FOUND');
});

test('GET /api/products/stockout-30d/:jobId/result: job dang chay tra 409 JOB_NOT_READY', async () => {
  const jobId = router.jobStore.createJob();
  const handler = getRouteHandler('get', '/api/products/stockout-30d/:jobId/result');
  const req = { params: { jobId } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'JOB_NOT_READY');
});

test('GET /api/products/stockout-30d/:jobId/result: job xong tra 200 + result', async () => {
  const jobId = router.jobStore.createJob();
  router.jobStore.setResult(jobId, {
    asOfDate: '2026-01-20',
    fromDate: '2026-01-01',
    totalProductsScanned: 100,
    totalCandidates: 1,
    rows: [{ code: 'SP001', name: 'A', stockoutCount: 1, totalStockoutDays: 6, currentOnHand: 2 }]
  });
  const handler = getRouteHandler('get', '/api/products/stockout-30d/:jobId/result');
  const req = { params: { jobId } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.rows.length, 1);
});

// ---------------------------------------------------------------------------
// Co so "Cả hai": chay job con cho tung co so vat ly roi gop ket qua.
// ---------------------------------------------------------------------------

test('POST /api/products/stockout-recent/scan ở "Cả hai": quét cả hai cơ sở vật lý và gộp kết quả', async () => {
  const original = recentStockoutScanService.runRecentStockoutScanJob;
  const scannedBranches = [];
  recentStockoutScanService.runRecentStockoutScanJob = async (store, jobId, deps) => {
    scannedBranches.push(deps.branch);
    store.setResult(jobId, {
      asOfDate: '2026-09-21', branch: deps.branch, totalProductsScanned: 5, totalCandidates: 1,
      sources: {}, warnings: [], rows: [{ code: 'SP001', name: 'A', periods: [] }]
    });
  };
  try {
    const handler = getRouteHandler('post', '/api/products/stockout-recent/scan');
    const req = { branch: 'Cả hai' };
    const res = fakeRes();

    await handler(req, res);
    assert.equal(res.statusCode, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(scannedBranches, ['Hà Nội', 'Sài Gòn']);
    const job = router.jobStore.getJob(res.body.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.result.branch, 'Cả hai');
    assert.deepEqual(job.result.rows.map((row) => row.branch), ['Hà Nội', 'Sài Gòn']);
  } finally {
    recentStockoutScanService.runRecentStockoutScanJob = original;
  }
});

test('POST /api/products/stockout-90d/scan ở "Cả hai": quét cả hai cơ sở vật lý và gộp kết quả', async () => {
  const original = stockout90dScanService.runStockout90dScanJob;
  const scannedBranches = [];
  stockout90dScanService.runStockout90dScanJob = async (store, jobId, deps) => {
    scannedBranches.push(deps.branch);
    store.setResult(jobId, {
      asOfDate: '2026-09-21', fromDate: '2026-06-23', branch: deps.branch,
      totalProductsScanned: 5, totalCandidates: 1, sources: {}, warnings: [],
      rows: [{ code: 'SP001', name: 'A', periods: [] }]
    });
  };
  try {
    const handler = getRouteHandler('post', '/api/products/stockout-90d/scan');
    const req = { branch: 'Cả hai' };
    const res = fakeRes();

    await handler(req, res);
    assert.equal(res.statusCode, 202);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(scannedBranches, ['Hà Nội', 'Sài Gòn']);
    const job = router.jobStore.getJob(res.body.jobId);
    assert.equal(job.status, 'done');
    assert.equal(job.result.branch, 'Cả hai');
    assert.equal(job.result.fromDate, '2026-06-23');
  } finally {
    stockout90dScanService.runStockout90dScanJob = original;
  }
});

// ---------------------------------------------------------------------------
// Import Tra NCC tu Excel KiotViet.
// ---------------------------------------------------------------------------

const supplierReturnImportService = require('./supplierReturnImportService');

test('POST /api/products/supplier-returns/import: thieu file tra 400', async () => {
  const handler = getRouteHandler('post', '/api/products/supplier-returns/import');
  const req = { file: null, body: { branch: 'Hà Nội' }, user: { vaiTro: 'Quản lý' } };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'SUPPLIER_RETURN_IMPORT_NO_FILE');
});

test('POST /api/products/supplier-returns/import: co so khong phai co so vat ly hop le tra 403', async () => {
  const handler = getRouteHandler('post', '/api/products/supplier-returns/import');
  const req = {
    file: { buffer: Buffer.from(''), originalname: 'file.xlsx' },
    body: { branch: 'Cả hai' },
    user: { coSo: 'Hà Nội', vaiTro: 'Nhân viên' }
  };
  const res = fakeRes();

  await handler(req, res);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'BRANCH_NOT_ALLOWED');
});

test('POST /api/products/supplier-returns/import: thanh cong thi ghi Postgres va tra tom tat', async () => {
  const originalParse = supplierReturnImportService.parseSupplierReturnWorkbook;
  const originalReplace = supplierReturnImportService.replaceSupplierReturnImport;
  let replaceCall = null;
  supplierReturnImportService.parseSupplierReturnWorkbook = () => ({
    rows: [
      { code: 'SP001', name: 'Hàng A', dateKey: '2026-06-01', quantity: 5 },
      { code: 'SP002', name: 'Hàng B', dateKey: '2026-09-22', quantity: 10 }
    ],
    skipped: [{ row: 5, reason: 'Thiếu Mã hàng' }],
    totalDataRows: 3
  });
  supplierReturnImportService.replaceSupplierReturnImport = async (args) => { replaceCall = args; };
  try {
    const handler = getRouteHandler('post', '/api/products/supplier-returns/import');
    const req = {
      file: { buffer: Buffer.from('fake'), originalname: 'TraNCC.xlsx' },
      body: { branch: 'Hà Nội' },
      user: { vaiTro: 'Quản lý', username: 'thangnnv' }
    };
    const res = fakeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.imported, 2);
    assert.equal(res.body.skipped, 1);
    assert.equal(res.body.earliestDate, '2026-06-01');
    assert.equal(res.body.latestDate, '2026-09-22');
    assert.equal(replaceCall.branch, 'hanoi');
    assert.equal(replaceCall.sourceFile, 'TraNCC.xlsx');
    assert.equal(replaceCall.importedBy, 'thangnnv');
  } finally {
    supplierReturnImportService.parseSupplierReturnWorkbook = originalParse;
    supplierReturnImportService.replaceSupplierReturnImport = originalReplace;
  }
});

test('GET /api/products/supplier-returns/import-status: "Cả hai" tra trang thai ca 2 co so', async () => {
  const original = supplierReturnImportService.getSupplierReturnImportStatus;
  supplierReturnImportService.getSupplierReturnImportStatus = async ({ branch }) => ({
    branch, rowCount: branch === 'hanoi' ? 100 : 0, earliestDate: null, latestDate: null, importedAt: null, importedBy: '', sourceFile: ''
  });
  try {
    const handler = getRouteHandler('get', '/api/products/supplier-returns/import-status');
    const req = { branch: 'Cả hai' };
    const res = fakeRes();

    await handler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.statuses.map((s) => s.branch), ['Hà Nội', 'Sài Gòn']);
    assert.equal(res.body.statuses[0].rowCount, 100);
  } finally {
    supplierReturnImportService.getSupplierReturnImportStatus = original;
  }
});

test('POST /api/products/stockout-recent/scan ở cơ sở vật lý: vẫn chỉ quét đúng cơ sở đó', async () => {
  const original = recentStockoutScanService.runRecentStockoutScanJob;
  const scannedBranches = [];
  recentStockoutScanService.runRecentStockoutScanJob = async (_store, _jobId, deps) => {
    scannedBranches.push(deps.branch);
  };
  try {
    const handler = getRouteHandler('post', '/api/products/stockout-recent/scan');
    const req = { branch: 'Sài Gòn' };
    const res = fakeRes();

    await handler(req, res);
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(res.statusCode, 202);
    assert.deepEqual(scannedBranches, ['Sài Gòn']);
  } finally {
    recentStockoutScanService.runRecentStockoutScanJob = original;
  }
});


test('all completed stockout result APIs filter/sort the full snapshot before paging without changing export or scan metadata',async()=>{
  for(const kind of ['stockout-recent','stockout-90d','stockout-30d']) {
    const rows=Array.from({length:240},(_,i)=>({code:'SP'+String(i).padStart(3,'0'),name:i>=200?'Đặng An':'Hàng khác',branch:i%2?'Hà Nội':'Sài Gòn',daysOutOfStock:i,totalStockoutDays:i,stockoutCount:2,currentOnHand:i%7,periods:[{fromDate:'2026-11-01',toDate:'2026-11-08',days:8}]}));
    const snapshot={rows,asOfDate:'2026-11-08',totalProductsScanned:1234,totalCandidates:400,sources:{invoices:'postgres'},warnings:['Test source warning']};
    const jobId=router.jobStore.createJob();router.jobStore.setResult(jobId,snapshot);
    const handler=getRouteHandler('get','/api/products/'+kind+'/:jobId/result');
    async function read(query){const res=fakeRes();await handler({params:{jobId},query},res);assert.equal(res.statusCode,200);return res.body.result;}
    const page=await read({page:'999',pageSize:'100'});
    assert.equal(page.totalRows,240);assert.equal(page.page,3);assert.equal(page.rows.length,40);assert.equal(page.rows[0].code,'SP039');
    assert.equal(page.totalProductsScanned,1234);assert.equal(page.totalCandidates,400);assert.deepEqual(page.sources,snapshot.sources);assert.deepEqual(page.warnings,snapshot.warnings);assert.equal(page.asOfDate,snapshot.asOfDate);
    const found=await read({page:'2',pageSize:'10',q:'dang an',sorts:JSON.stringify([{key:'branch',dir:'asc'},{key:'daysOutOfStock',dir:'desc'}])});
    assert.equal(found.totalRows,40);assert.equal(found.totalResultRows,240);assert.equal(found.rows.length,10);assert.equal(found.rows[0].code,'SP219');
    const codes=await read({page:'99',qmode:'codes',q:'SP239 SP201 missing'});
    assert.equal(codes.totalRows,2);assert.equal(codes.page,1);assert.deepEqual(codes.search.missingCodes,['missing']);assert.deepEqual(codes.rows.map(row=>row.code),['SP239','SP201']);
    const dated=await read({page:'1',q:'2026-11-01'});assert.equal(dated.totalRows,240);
    const empty=await read({page:'99',q:'notfound'});assert.equal(empty.totalRows,0);assert.equal(empty.page,1);
    const legacy=await read({});assert.equal(legacy,snapshot);assert.equal(legacy.rows.length,240);assert.equal(router.jobStore.getJob(jobId).result,snapshot);assert.equal(snapshot.rows[0].code,'SP000');
  }
});
