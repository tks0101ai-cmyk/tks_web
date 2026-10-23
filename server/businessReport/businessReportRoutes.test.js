'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ExcelJS = require('exceljs');
const { createBusinessReportRouter } = require('./businessReportRoutes');
const { serviceSnapshot } = require('./testFixtures');

// Truyen permissions da giai; requireAuth va requireFeature van chay that.
async function request(path, { permissions = ['reports.business', 'reports.products.growth'], method = 'GET', body, repo = {} } = {}) {
  const calls = [];
  const app = express();
  app.use((req, res, next) => {
    req.user = { username: 'tester', vaiTro: 'Quản lý', permissions };
    req.effectiveUserResolved = true;
    next();
  });
  app.use('/api/business-report', createBusinessReportRouter({
    customerPriceLevels: { getLevels:async keys => Object.fromEntries(keys.map(k => [k,{level:'large',version:1}])) },
    repository: {
      snapshot: async () => serviceSnapshot(),
      customerProducts: async args => { calls.push(['customerProducts', args]); return [{ productCode: 'SP1', productName: 'Khay', revenue: 10, qty: 1 }]; },
      productCustomers: async args => { calls.push(['productCustomers', args]); return [{ branch: 'hanoi', customerCode: 'KH1', revenue: 10, qty: 1 }, { branch: 'hanoi', customerCode: '', revenue: 5, qty: 1 }]; },
      refreeze: async month => { calls.push(['refreeze', month]); return { month, customers: 1 }; },
      ...repo
    }
  }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/business-report${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, calls, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('GET /sales, /customers, /products: quyen theo tung muc', async () => {
  const ok = await request('/sales');
  assert.equal(ok.status, 200);
  assert.ok(ok.data.rows.find(r => r.saleName === 'Khang'));
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal((await request('/customers')).status, 200);
  assert.equal((await request('/products')).status, 200);
  const denied = await request('/sales', { permissions: ['reports.overview'] });
  assert.equal(denied.status, 403);
});

test('quyen Tang truong ma hang doc lap Khach hang va Du kien, gom chi tiet va xuat', async () => {
  const growth = { permissions: ['reports.products.growth'] };
  assert.equal((await request('/products', growth)).status, 200);
  assert.equal((await request('/sales', growth)).status, 403);
  assert.equal((await request('/detail?kind=customer&key=x', growth)).status, 403);
  for (const permissions of [['reports.business', 'reports.export'], ['reports.products.expected']]) {
    for (const path of ['/products', '/detail?kind=product&key=SP1', '/export?kind=products', '/export/fields?kind=products']) {
      assert.equal((await request(path, { permissions })).status, 403, path);
    }
  }
  const exported = await request('/export/fields?kind=products', { permissions: ['reports.products.growth', 'reports.export'] });
  assert.equal(exported.status, 200);
});

test('GET /detail?kind=customer nap top ma hang 4 thang gan nhat qua repository', async () => {
  const r = await request('/detail?kind=customer&key=' + encodeURIComponent('chị a'));
  assert.equal(r.status, 200);
  assert.deepEqual(r.calls[0], ['customerProducts', { branch: 'hanoi', customerCode: 'KH1', months: ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'] }]);
  assert.equal(r.data.topProducts[0].productCode, 'SP1');
  assert.equal(r.data.customer.key, 'chị a');
});

test('GET /overview: chi so tong quat, can reports.business', async () => {
  const ok = await request('/overview');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data.kpis.map(k => k.key), ['growth', 'avg4', 'current', 'saleCount', 'activeCustomers', 'activeProducts']);
  assert.equal((await request('/overview', { permissions: ['reports.overview'] })).status, 403);
});

test('GET /detail?kind=customer cong don top ma hang cua moi ho so da gop (HN + SG)', async () => {
  const snap = serviceSnapshot();
  snap.directory.push({ branch: 'saigon', code: 'KH7', name: 'Chị A', saleName: 'Khang', priceLevel: '' });
  snap.customers.push({ month: '2026-10-01', branch: 'saigon', customerCode: 'KH7', customerName: 'Chị A', netRevenue: 5 });
  const r = await request('/detail?kind=customer&key=' + encodeURIComponent('chị a'), {
    repo: {
      snapshot: async () => snap,
      customerProducts: async args => [{ productCode: 'SP1', productName: 'Khay', revenue: args.branch === 'hanoi' ? 10 : 7, qty: 1 }]
    }
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.topProducts, [{ productCode: 'SP1', productName: 'Khay', revenue: 17, qty: 2 }]);
});

test('GET /detail?kind=product gan ten khach cho top khach, Khach le co ten rieng', async () => {
  const r = await request('/detail?kind=product&key=SP1');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.topCustomers.map(c => c.customerName), ['Chị A', 'Khách lẻ']);
  assert.equal('branch' in r.data.topCustomers[0], false, 'gop theo ten: khong con co so');
});

test('GET /detail: khong co key => 404, loai sai => 400', async () => {
  assert.equal((await request('/detail?kind=sale&key=Khong')).status, 404);
  assert.equal((await request('/detail?kind=abc&key=x')).status, 400);
});

test('POST /refreeze: can reports.business.refreeze, goi repository.refreeze', async () => {
  const denied = await request('/refreeze', { method: 'POST', body: { month: '2026-09' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.calls.length, 0);
  const ok = await request('/refreeze', { method: 'POST', body: { month: '2026-09' }, permissions: ['reports.business', 'reports.business.refreeze'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.calls, [['refreeze', '2026-09']]);
});

test('GET /export: can ca reports.business va reports.export', async () => {
  const noExport = await request('/export?kind=customers&format=xlsx');
  assert.equal(noExport.status, 403);
  const noView = await request('/export?kind=customers&format=xlsx', { permissions: ['reports.export'] });
  assert.equal(noView.status, 403);
  const ok = await request('/export?kind=customers&format=xlsx', { permissions: ['reports.business', 'reports.products.growth', 'reports.export'] });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type'), /spreadsheetml/);
  assert.match(ok.headers.get('content-disposition'), /TKS_Bao_cao_kinh_doanh_customers\.xlsx/);
  const bad = await request('/export?kind=zzz&format=xlsx', { permissions: ['reports.business', 'reports.products.growth', 'reports.export'] });
  assert.equal(bad.status, 400);
});

test('GET /export?columns=: file chi chua cot da chon; khoa la / rong => 400', async () => {
  const both = { permissions: ['reports.business', 'reports.products.growth', 'reports.export'] };
  const ok = await request('/export?kind=sales&format=xlsx&columns=' + encodeURIComponent('saleName,avg4'), both);
  assert.equal(ok.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ok.data);
  assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), ['Sale', 'TB 4 tháng']);
  const unknown = await request('/export?kind=sales&format=xlsx&columns=saleName,password', both);
  assert.equal(unknown.status, 400);
  assert.equal(unknown.data.code, 'INVALID_COLUMNS');
  assert.equal((await request('/export?kind=sales&format=xlsx&columns=', both)).status, 400);
});

test('GET /export/fields: can ca reports.business va reports.export; tra truong + so dong theo bo loc', async () => {
  assert.equal((await request('/export/fields?kind=customers')).status, 403);
  assert.equal((await request('/export/fields?kind=customers', { permissions: ['reports.export'] })).status, 403);
  const both = { permissions: ['reports.business', 'reports.products.growth', 'reports.export'] };
  const active = await request('/export/fields?kind=customers', both);
  assert.equal(active.status, 200);
  const ws = active.data.worksheets[0];
  assert.equal(ws.key, 'customers');
  assert.deepEqual(ws.fields.slice(0, 3).map(f => f.label), ['Tên khách', 'Sale', 'Level giá']);
  const all = await request('/export/fields?kind=customers&inactive=1', both);
  assert.ok(all.data.worksheets[0].rowCount > ws.rowCount, 'inactive=1 dem ca khach khong hoat dong');
  assert.equal((await request('/export/fields?kind=zzz', both)).status, 400);
});

test('unhandled DB failures remain 500 without leaking detail', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const notReady = await request('/sales', { repo: { snapshot: async () => { throw new Error('relation "business_monthly_state" does not exist'); } } });
    assert.equal(notReady.status, 500);
    assert.equal(notReady.data.code, 'BUSINESS_REPORT_ERROR');
    const boom = await request('/sales', { repo: { snapshot: async () => { throw new Error('secret db detail'); } } });
    assert.equal(boom.status, 500);
    assert.equal(boom.data.code, 'BUSINESS_REPORT_ERROR');
    assert.ok(!JSON.stringify(boom.data).includes('secret'));
  } finally { console.error = origError; }
});


test('missing migration end-to-end HTTP 200 keeps current live tables and details', async () => {
 const { PGlite } = require('@electric-sql/pglite');
 const { seed } = require('./testFixtures');
 const { createRepository } = require('./businessReportRepository');
 const db = new PGlite();
 try {
  await seed(db);
  await db.exec('DROP TABLE business_monthly_state, business_monthly_customer_sales, business_monthly_product_sales, business_monthly_sale_sales, business_monthly_customer_product_sales');
  const repo = createRepository({pool:{query:(q,p)=>db.query(q,p),connect:async()=>({query:(q,p)=>db.query(q,p),release(){}})},now:()=>new Date('2026-10-06T03:00:00Z')});
  for(const kind of ['sales','customers','products']) {
   const res = await request('/'+kind,{repo});
   assert.equal(res.status,200);
   assert.equal(res.data.notReady,true);
   assert.equal(res.data.rows.reduce((sum,r)=>sum+r.current,0),500);
  }
  const detail = await request('/detail?kind=customer&key='+encodeURIComponent('chị a'),{repo});
  assert.equal(detail.status,200);
  assert.equal(detail.data.notReady,true);
  assert.equal(detail.data.topProducts[0].revenue,950);
 }finally{await db.close();}
});

test('PUT /sale-team: can reports.business.editTeam, chi nhan sale co trong bang, goi repository.setSaleTeam', async () => {
  const body = { saleName: 'Khang', teamName: 'Team Trinh' };
  const setSaleTeam = async (sale, team) => ({ saleName: sale, team });
  const denied = await request('/sale-team', { method: 'PUT', body });
  assert.equal(denied.status, 403);
  const editor = { permissions: ['reports.business', 'reports.business.editTeam'] };
  const calls = [];
  const ok = await request('/sale-team', { method: 'PUT', body: { saleName: ' Khang ', teamName: '  Team   Trinh ' }, ...editor, repo: { setSaleTeam: async (s, t) => { calls.push([s, t]); return { saleName: s, team: t }; } } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { saleName: 'Khang', team: 'Team Trinh' });
  assert.deepEqual(calls, [['Khang', 'Team Trinh']]);
  const clear = await request('/sale-team', { method: 'PUT', body: { saleName: 'Khang', teamName: '' }, ...editor, repo: { setSaleTeam } });
  assert.equal(clear.status, 200);
  assert.equal((await request('/sale-team', { method: 'PUT', body: { saleName: 'Khong co', teamName: 'X' }, ...editor, repo: { setSaleTeam } })).status, 404);
  assert.equal((await request('/sale-team', { method: 'PUT', body: { saleName: 'Chưa phân nhóm', teamName: 'X' }, ...editor, repo: { setSaleTeam } })).status, 400);
  assert.equal((await request('/sale-team', { method: 'PUT', body: { saleName: '', teamName: 'X' }, ...editor, repo: { setSaleTeam } })).status, 400);
  assert.equal((await request('/sale-team', { method: 'PUT', body: { saleName: 'Khang', teamName: 'x'.repeat(61) }, ...editor, repo: { setSaleTeam } })).status, 400);
});
