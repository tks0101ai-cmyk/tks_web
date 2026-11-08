'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registry = require('../auth/featureRegistry');
const { ROLES } = require('../auth/userRepository');
const { createVatRequestRouter, readFilters } = require('./routes');

function userFor(vaiTro) {
  const base = { id: 'u1', username: 'u1', vaiTro, trangThai: 'Đang hoạt động' };
  return { ...base, permissions: registry.resolvePermissions(base) };
}

async function withApp(user, service, run, options = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = user; req.effectiveUserResolved = true; next(); });
  app.use('/api/vat-requests', createVatRequestRouter({ service,
    customerSearch: async (branch, q) => ({ query: q, results: [] }), ...options }));
  const server = app.listen(0);
  try {
    const call = async (path, options = {}) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/vat-requests${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
        body: options.body ? JSON.stringify(options.body) : undefined
      });
      return { status: res.status, body: await res.json() };
    };
    await run(call);
  } finally {
    server.close();
  }
}

test('tai khoan khong co quyen Yeu cau xuat VAT -> 403 o moi route', async () => {
  const service = { list: async () => { throw new Error('khong duoc goi'); } };
  await withApp(userFor(ROLES.NHAN_VIEN_KHO), service, async call => {
    assert.equal((await call('/')).status, 403);
    assert.equal((await call('/', { method: 'POST', body: {} })).status, 403);
    assert.equal((await call('/price-suggest?code=014XOAN')).status, 403);
  });
});

test('API goi y gia tra ve gia order VAT gan nhat va can ma SP', async () => {
  await withApp(userFor(ROLES.NHAN_VIEN_SALE), {}, async call => {
    assert.equal((await call('/price-suggest')).status, 400);
    assert.deepEqual((await call('/price-suggest?code=014XOAN')).body,
      { latestOrder: { price: 12500, customerName: 'Khách mới', createdAt: null } });
  }, { priceSearch: async code => {
    assert.equal(code, '014XOAN');
    return { latestOrder: { price: 12500, customerName: 'Khách mới', createdAt: null } };
  } });
});

test('loi nghiep vu tra dung ma; 409 kem ban moi nhat; loi la -> 500 khong lo chi tiet', async () => {
  const calls = {};
  const service = {
    list: async (user, filters) => { calls.filters = filters; return { rows: [] }; },
    update: async () => { throw Object.assign(new Error('xung đột'), { statusCode: 409, code: 'VERSION_CONFLICT', latest: { id: 7, version: 3 } }); },
    remove: async (user, id, version) => { calls.remove = [id, version]; return { ok: true }; },
    create: async () => { throw new Error('db down secret'); }
  };
  await withApp(userFor(ROLES.NHAN_VIEN_SALE), service, async call => {
    assert.equal((await call('/?status=3,4,bad&q=%20abc%20&from=2026-10-01&to=xx')).status, 200);
    assert.deepEqual(calls.filters, { statuses: ['3', '4'], createdBy: null, productKey: null, q: 'abc', from: '2026-10-01', to: null, keep: [] });
    const conflict = await call('/7', { method: 'PATCH', body: { version: 1 } });
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body.latest, { id: 7, version: 3 });
    assert.equal((await call('/abc', { method: 'PATCH', body: {} })).status, 400);
    assert.equal((await call('/7?version=2', { method: 'DELETE' })).status, 200);
    assert.deepEqual(calls.remove, [7, '2']);
    const failed = await call('/', { method: 'POST', body: {} });
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(failed.body), /secret/);
  });
});

test('GET /export tra file xlsx theo bo loc; 403 tu service giu nguyen ma', async () => {
  let filters;
  const service = {
    exportList: async (user, f) => {
      if (user.vaiTro === ROLES.NHAN_VIEN_SALE) throw Object.assign(new Error('cấm'), { statusCode: 403, code: 'FEATURE_FORBIDDEN' });
      filters = f;
      return { rows: [], metrics: {}, truncated: true };
    }
  };
  for (const [vaiTro, expected] of [[ROLES.QUAN_LY, 200], [ROLES.NHAN_VIEN_SALE, 403]]) {
    const app = express();
    app.use((req, res, next) => { req.user = userFor(vaiTro); req.effectiveUserResolved = true; next(); });
    app.use('/api/vat-requests', createVatRequestRouter({ service }));
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/vat-requests/export?status=3&q=abc`);
      assert.equal(res.status, expected);
      if (expected === 200) {
        assert.match(res.headers.get('content-type'), /spreadsheetml/);
        assert.match(res.headers.get('content-disposition'), /attachment; filename="order_vat_\d{8}_\d{4}\.xlsx"/);
        assert.equal(res.headers.get('x-export-truncated'), '1');
        assert.deepEqual(filters, { statuses: ['3'], createdBy: null, productKey: null, q: 'abc', from: null, to: null, keep: [] });
      } else {
        assert.equal((await res.json()).code, 'FEATURE_FORBIDDEN');
      }
    } finally { server.close(); }
  }
});

test('readFilters doc keep: so nguyen duong, bo trung, toi da 500', () => {
  assert.deepEqual(readFilters({ keep: '5, 3,abc,0,-2,5,1.5' }).keep, [5, 3]);
  assert.equal(readFilters({ keep: Array.from({ length: 600 }, (_, i) => i + 1).join(',') }).keep.length, 500);
});

test('readFilters bo gia tri la', () => {
  assert.deepEqual(readFilters({ product: ' 014XOAN ', createdBy: 'u2' }), { statuses: [], createdBy: 'u2', productKey: '014xoan', q: null, from: null, to: null, keep: [] });
});

test('PATCH /position goi service.move voi ca body (dat truoc /:id nen khong bi nuot)', async () => {
  let moved = null;
  const service = {
    move: async (user, body) => { moved = body; return { ok: true }; },
    update: async () => { throw new Error('khong duoc goi update'); }
  };
  await withApp(userFor(ROLES.KE_TOAN), service, async call => {
    const res = await call('/position', { method: 'PATCH', body: { ids: [12, 3], belowId: 5 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.deepEqual(moved, { ids: [12, 3], belowId: 5 });
  });
});

test('readFilters: chi xin phan trang khi co page/pageSize; sorts / group chuyen nguyen cho service whitelist', () => {
  assert.equal(Object.hasOwn(readFilters({ q: 'abc' }), 'paging'), false);
  assert.deepEqual(readFilters({ page: '2', pageSize: '50', sorts: '[{"key":"quantity","dir":"desc"}]', group: 'product' }).paging,
    { page: '2', pageSize: '50', sorts: '[{"key":"quantity","dir":"desc"}]', group: true });
  assert.equal(readFilters({ page: '1', group: 'x' }).paging.group, false);
});
