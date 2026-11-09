'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createMarketingReportRouter } = require('./marketingReportRoutes');

// Authentication and permission middleware run unchanged; only source reads are mocked.
async function request(path, { permissions = ['reports.marketing'], authenticated = true, role = 'Quản lý', method = 'GET', service = {}, body } = {}) {
  const calls = [];
  const app = express();
  app.use((req, res, next) => {
    if (authenticated) {
      req.user = { username: 'tester', vaiTro: role, permissions };
      req.effectiveUserResolved = true;
    }
    next();
  });
  app.use('/api/marketing-report', createMarketingReportRouter({ service: {
    metadata: async () => { calls.push(['metadata']); return { months: [10] }; },
    report: async (kind, query) => { calls.push(['report', kind, { ...query }]); return { kind, rows: [{ key: 'source:1' }] }; },
    detail: async query => { calls.push(['detail', { ...query }]); return { groups: [] }; },
    updateRow: async b => { calls.push(['updateRow', { ...b }]); return { ok: true }; },
    ...service
  } }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/marketing-report${path}`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: res.status, headers: res.headers, calls,
      data: (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text() };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const endpoints = ['metadata', 'monthly', 'receipt-check', 'phones', 'costs', 'detail'];

test('all Marketing reads reject unauthenticated or missing permission before calling source', async () => {
  for (const endpoint of endpoints) {
    const unauthenticated = await request('/' + endpoint, { authenticated: false });
    assert.equal(unauthenticated.status, 401, endpoint);
    assert.equal(unauthenticated.headers.get('cache-control'), 'no-store');
    assert.deepEqual(unauthenticated.calls, []);
    const denied = await request('/' + endpoint, { permissions: ['reports.business'] });
    assert.equal(denied.status, 403, endpoint);
    assert.equal(denied.headers.get('cache-control'), 'no-store');
    assert.equal(denied.data.code, 'FEATURE_FORBIDDEN');
    assert.deepEqual(denied.calls, []);
  }
});

test('metadata and each report delegate to the expected service read with unchanged filters', async () => {
  const metadata = await request('/metadata');
  assert.equal(metadata.status, 200);
  assert.deepEqual(metadata.calls, [['metadata']]);
  assert.equal(metadata.headers.get('cache-control'), 'no-store');
  for (const kind of ['monthly', 'receipt-check', 'phones', 'costs']) {
    const result = await request('/' + kind + '?month=10&page=HN&employee=Lan');
    assert.equal(result.status, 200, kind);
    assert.deepEqual(result.calls, [['report', kind, { month: '10', page: 'HN', employee: 'Lan' }]]);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
});

test('detail delegates source identity, snapshot and active filter values', async () => {
  const result = await request('/detail?kind=phones&key=sheet%3A12&snapshotId=s1&month=10&page=HN');
  assert.equal(result.status, 200);
  assert.deepEqual(result.calls, [['detail', { kind: 'phones', key: 'sheet:12', snapshotId: 's1', month: '10', page: 'HN' }]]);
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test('validation failures preserve client status and code', async () => {
  const result = await request('/monthly?month=bad', { service: { report: async () => {
    throw Object.assign(new Error('Tháng không hợp lệ.'), { statusCode: 400, code: 'MARKETING_INVALID_MONTH' });
  } } });
  assert.equal(result.status, 400);
  assert.equal(result.data.code, 'MARKETING_INVALID_MONTH');
});

test('unexpected source failures never expose credentials or raw Google diagnostics', async () => {
  const original = console.error;
  console.error = () => {};
  try {
    const result = await request('/metadata', { service: { metadata: async () => {
      throw new Error('secret credential private_key Google response');
    } } });
    assert.equal(result.status, 500);
    assert.equal(result.data.code, 'MARKETING_REPORT_ERROR');
    assert.ok(!JSON.stringify(result.data).includes('secret'));
    assert.ok(!JSON.stringify(result.data).includes('private_key'));
  } finally { console.error = original; }
});

test('a safe source failure returns 503 without affecting another report read', async () => {
  const failed = await request('/phones', { service: { report: async () => {
    throw Object.assign(new Error('Nguồn SĐT chưa sẵn sàng.'), { statusCode: 503, code: 'MARKETING_SOURCE_UNAVAILABLE' });
  } } });
  assert.equal(failed.status, 503);
  assert.equal(failed.data.code, 'MARKETING_SOURCE_UNAVAILABLE');
  const other = await request('/costs');
  assert.equal(other.status, 200);
  assert.deepEqual(other.calls, [['report', 'costs', {}]]);
});

test('Marketing has no write endpoints', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const result = await request('/monthly', { method });
    assert.equal(result.status, 404, method);
    assert.deepEqual(result.calls, []);
  }
});

test('writing Khách mới/Ghi chú needs reports.marketing.edit and only that route writes', async () => {
  const body = { snapshotId: 's', key: 'k', field: 'note', value: 'x' };
  const denied = await request('/monthly/row', { method: 'PUT', body });
  assert.equal(denied.status, 403);
  assert.deepEqual(denied.calls, []);
  const ok = await request('/monthly/row', { method: 'PUT', body, permissions: ['reports.marketing', 'reports.marketing.edit'] });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.calls, [['updateRow', body]]);
});

test('Marketing cannot write even with edit feature enabled',async()=>{for(const path of ['/monthly/row','/monthly/rows/1','/aliases']){const r=await request(path,{role:'Marketing',permissions:['reports.marketing','reports.marketing.edit'],method:'PUT',body:{version:'1'}});assert.equal(r.status,403);assert.equal(r.calls.length,0);}const r=await request('/monthly/rows',{role:'Marketing',permissions:['reports.marketing','reports.marketing.edit'],method:'POST',body:{}});assert.equal(r.status,403);});


test('row API separates social page from pagination and export always reads the full filtered snapshot',async()=>{
  const rows=Array.from({length:230},(_,i)=>({key:'r'+i,customer:i>=100?'Đặng An':'Khác',revenue:i,sale:'Lan',page:'HN'}));
  const calls=[];
  const service={report:async(kind,query)=>{calls.push({...query});return {kind,rows,kpis:[{label:'Khách chốt',value:230}],summaryRows:[],filters:{pages:['HN']}};}};
  const page=await request('/monthly?page=HN&pageNumber=2&pageSize=10&q=dang%20an&sorts='+encodeURIComponent(JSON.stringify([{key:'revenue',dir:'desc'}])),{service});
  assert.equal(page.status,200);assert.equal(page.data.totalRows,130);assert.equal(page.data.page,2);assert.equal(page.data.rows[0].revenue,219);assert.equal(page.data.kpis[0].value,130);assert.equal(calls[0].page,'HN');
  const exported=await request('/export/fields?kind=monthly&table=rows&page=HN&pageNumber=2&pageSize=10&q=dang%20an',{permissions:['reports.marketing','reports.export'],service});
  assert.equal(exported.status,200);assert.equal(exported.data.worksheets[0].rowCount,130);assert.equal(calls[1].page,'HN');assert.equal(calls[1].pageNumber,undefined);assert.equal(calls[1].pageSize,undefined);
});

test('detail groups page independently while reconciliation and KPI retain full source scope',async()=>{
  const groups=[{kind:'phones',rows:Array.from({length:220},(_,i)=>({key:'p'+i,phone:'0'+i}))},{kind:'monthly',rows:Array.from({length:150},(_,i)=>({customer:'Khách '+i,revenue:i}))}];
  const query=encodeURIComponent(JSON.stringify({0:{pageNumber:9,pageSize:100},1:{q:'Khách 149'}}));
  const result=await request('/detail?kind=phones&groupQueries='+query,{service:{detail:async()=>({groups,kpis:[{label:'Dòng chi tiết',value:220}],reconciliation:{found:{rows:220}}})}});
  assert.equal(result.status,200);assert.equal(result.data.groups[0].page,3);assert.equal(result.data.groups[0].totalRows,220);assert.equal(result.data.groups[0].rows.length,20);
  assert.equal(result.data.groups[1].page,1);assert.equal(result.data.groups[1].totalRows,1);assert.equal(result.data.kpis[0].value,220);assert.equal(result.data.reconciliation.found.rows,220);
});
