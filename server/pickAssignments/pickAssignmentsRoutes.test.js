'use strict';
process.env.JWT_SECRET ||= 'test-secret';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createPickAssignmentsRouter } = require('./pickAssignmentsRoutes');

const MANAGER = { id: 'ql', vaiTro: 'Quản lý' };
const ASSIGNMENT = { id: 7, branch: 'HN', orderCode: 'DH001', status: 'picking', version: 1, lines: [], history: [] };

async function start(t, { user = MANAGER, failWith } = {}) {
  const calls = [];
  const record = name => async (ctx, ...args) => {
    calls.push([name, ...args]);
    if (failWith) throw failWith;
    return name === 'candidates' ? { order: { orderCode: 'DH001' }, candidates: {}, assignment: null } : name === 'get' ? { assignment: null } : { assignment: ASSIGNMENT };
  };
  const service = { candidates: record('candidates'), get: record('get'), assign: record('assign'), confirm: record('confirm'), cancel: record('cancel'), setStatus: record('setStatus'),
    createPosition: async (ctx, body) => { calls.push(['createPosition', body]); if (failWith) throw failWith; return { row: { id: 9 }, merged: body.location === 'A01' }; },
    updatePosition: async (ctx, id, body) => { calls.push(['updatePosition', id, body]); if (failWith) throw failWith; return { row: { id } }; },
    removePosition: async (ctx, id, params) => { calls.push(['removePosition', id, params]); if (failWith) throw failWith; return { deleted: true, id }; } };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = user; next(); });
  app.use('/api/shipment/pick', createPickAssignmentsRouter({
    requireAuth: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập.' })),
    service,
    pool:{},
    printLayouts:{readLayout:async(pool,template)=>({layout:{template},version:2}),writeLayout:async(pool,template,input,userId)=>({layout:input.layout,version:input.version+1,userId})}
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  return { calls, base: `http://127.0.0.1:${server.address().port}/api/shipment/pick` };
}

const json = { 'Content-Type': 'application/json' };

test('GET candidates / GET chi dinh: truyen branch + order (ma don), khong cache, tra 200', async t => {
  const { base, calls } = await start(t);
  const res = await fetch(base + '/candidates?branch=HN&order=DH001');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('server-timing') || '', /auth;dur=[\d.]+.*total;dur=[\d.]+/);
  assert.equal((await res.json()).order.orderCode, 'DH001');
  assert.equal((await fetch(base + '?branch=SG&order=DH9')).status, 200);
  assert.deepEqual(calls, [['candidates', { branch: 'HN', orderCode: 'DH001' }], ['get', { branch: 'SG', orderCode: 'DH9' }]]);
});

test('POST chi dinh 201; confirm / cancel truyen id so + version', async t => {
  const { base, calls } = await start(t);
  const body = { branch: 'HN', orderCode: 'DH001', allocations: [{ productCode: 'AAA1', positionId: 1, qty: 5 }] };
  const created = await fetch(base, { method: 'POST', headers: json, body: JSON.stringify(body) });
  assert.equal(created.status, 201);
  assert.equal((await created.json()).assignment.id, 7);
  assert.equal((await fetch(base + '/7/confirm', { method: 'POST', headers: json, body: JSON.stringify({ version: 1 }) })).status, 200);
  assert.equal((await fetch(base + '/7/cancel', { method: 'POST', headers: json, body: JSON.stringify({ version: 2 }) })).status, 200);
  assert.deepEqual(calls, [['assign', body], ['confirm', 7, { version: 1 }], ['cancel', 7, { version: 2 }]]);
});

test('POST /status (dropdown Trang thai boc): truyen nguyen body, body client khong chen duoc ly do huy', async t => {
  const { base, calls } = await start(t);
  const body = { branch: 'HN', orderCode: 'DH001', status: 'confirmed', reason: 'kiot_cancelled' };
  const res = await fetch(base + '/status', { method: 'POST', headers: json, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).assignment.id, 7);
  assert.deepEqual(calls, [['setStatus', body]]);
  await fetch(base + '/7/cancel', { method: 'POST', headers: json, body: JSON.stringify({ version: 1, reason: 'kiot_cancelled' }) });
  assert.deepEqual(calls[1], ['cancel', 7, { version: 1, reason: 'kiot_cancelled' }], 'route khong truyen tuy chon thu 4: ly do cua client bi bo qua o service');
});

test('Quan ly co quyen; chua dang nhap 401; Ke toan / NV kho / Khach (ke ca cap quyen gia mao) 403 va khong goi service', async t => {
  assert.equal((await fetch((await start(t, { user: null })).base + '?branch=HN&order=A')).status, 401);
  const denied = [
    { vaiTro: 'Kế toán' },
    { vaiTro: 'Nhân viên kho', featurePermissions: { 'shipment.pick': true } }, // thieu Vong doi don hang nen quyen bi bo
    { vaiTro: 'Khách', featurePermissions: { 'shipment.pick': true, 'shipment.lifecycle': true } }
  ];
  for (const user of denied) {
    const { base, calls } = await start(t, { user });
    for (const [method, url] of [['GET', '/candidates?branch=HN&order=A'], ['GET', '?branch=HN&order=A'], ['POST', ''], ['POST', '/1/confirm'], ['POST', '/1/cancel'], ['POST', '/status']]) {
      const res = await fetch(base + url, { method, headers: json, ...(method === 'POST' ? { body: '{}' } : {}) });
      assert.equal(res.status, 403, `${user.vaiTro} ${method} ${url}`);
    }
    assert.deepEqual(calls, []);
  }
  // Ke toan duoc Quan ly cap rieng shipment.pick (co san Vong doi don hang) thi dung duoc.
  const granted = await start(t, { user: { vaiTro: 'Kế toán', featurePermissions: { 'shipment.pick': true } } });
  assert.equal((await fetch(granted.base + '/candidates?branch=HN&order=A')).status, 200);
});

test('Loi nghiep vu 4xx tra { error, code, latest, field }; loi la 500 khong lo chi tiet', async t => {
  const conflict = Object.assign(new Error('Chỉ định đã bị người khác thay đổi.'), { statusCode: 409, code: 'VERSION_CONFLICT', latest: { id: 7 } });
  let { base } = await start(t, { failWith: conflict });
  let res = await fetch(base + '/7/confirm', { method: 'POST', headers: json, body: JSON.stringify({ version: 1 }) });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'Chỉ định đã bị người khác thay đổi.', code: 'VERSION_CONFLICT', latest: { id: 7 } });
  const invalid = Object.assign(new Error('Thiếu mã'), { statusCode: 400, code: 'VALIDATION', field: 'orderCode' });
  ({ base } = await start(t, { failWith: invalid }));
  res = await fetch(base + '?branch=HN&order=', {});
  assert.deepEqual(await res.json(), { error: 'Thiếu mã', code: 'VALIDATION', field: 'orderCode' });
  const original = console.error;
  console.error = () => {};
  try {
    ({ base } = await start(t, { failWith: new Error('boom: secret SQL') }));
    res = await fetch(base + '?branch=HN&order=A');
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'PICK_ASSIGNMENTS_FAILED');
  } finally { console.error = original; }
});

test('shared form GET/PUT uses shipment.pick, user from session and no-store',async t=>{
 const {base}=await start(t);
 const res=await fetch(base+'/print-layout/order');
 assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');
 assert.deepEqual(await res.json(),{layout:{template:'order'},version:2});
 const updated=await fetch(base+'/print-layout/order',{method:'PUT',headers:json,body:JSON.stringify({layout:{fonts:[]},version:2,userId:'spoof'})});
 assert.equal(updated.status,200);assert.deepEqual(await updated.json(),{layout:{fonts:[]},version:3,userId:'ql'});
 const denied=await start(t,{user:{vaiTro:'Khách'}});
 assert.equal((await fetch(denied.base+'/print-layout/order')).status,403);
 assert.equal((await fetch(denied.base+'/print-layout/order',{method:'PUT',headers:json,body:'{}'})).status,403);
 const anon=await start(t,{user:null});
 assert.equal((await fetch(anon.base+'/print-layout/order')).status,401);
});

test('POST chi dinh truyen nguyen removed/needs trong body cho service; route /order-lines/remove (ghi Kiot) da bo', async t => {
  const { base, calls } = await start(t);
  const body = { branch: 'HN', orderCode: 'DH001', allocations: [{ productCode: 'AAA1', positionId: 1, qty: 5 }], removed: ['BBB2'], needs: { AAA1: 5 } };
  assert.equal((await fetch(base, { method: 'POST', headers: json, body: JSON.stringify(body) })).status, 201);
  assert.deepEqual(calls, [['assign', body]]);
  const gone = await fetch(base + '/order-lines/remove', { method: 'POST', headers: json, body: JSON.stringify({ branch: 'HN', orderCode: 'DH001', productCode: 'AAA1' }) });
  assert.equal(gone.status, 404);
  assert.equal(calls.length, 1);
});

test('Sửa VT trong hộp: /positions cần thêm quyền xem + sửa VT; candidates báo canEditPositions; route truyền đúng tham số', async t => {
  const { base, calls } = await start(t);
  const candidates = await (await fetch(base + '/candidates?branch=HN&order=DH001')).json();
  assert.equal(candidates.canEditPositions, true);
  const body = { branch: 'HN', orderCode: 'DH001', productCode: 'AAA1', location: 'Z1', notes: '1T x 5' };
  const created = await fetch(base + '/positions', { method: 'POST', headers: json, body: JSON.stringify(body) });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), { row: { id: 9 }, merged: false });
  const merged = await fetch(base + '/positions', { method: 'POST', headers: json, body: JSON.stringify({ ...body, location: 'A01' }) });
  assert.equal(merged.status, 200, 'cong vao dong trung -> 200');
  const patch = { branch: 'HN', orderCode: 'DH001', notes: '2T x 5', version: 3, confirmEmpty: true };
  assert.deepEqual(await (await fetch(base + '/positions/12', { method: 'PATCH', headers: json, body: JSON.stringify(patch) })).json(), { row: { id: 12 } });
  assert.deepEqual(await (await fetch(base + '/positions/12?branch=HN&order=DH001&version=4', { method: 'DELETE' })).json(), { deleted: true, id: 12 });
  assert.deepEqual(calls.slice(1), [
    ['createPosition', body], ['createPosition', { ...body, location: 'A01' }],
    ['updatePosition', 12, patch], ['removePosition', 12, { branch: 'HN', orderCode: 'DH001', version: '4' }]
  ]);

  // Co shipment.pick nhung thieu quyen sua VT: thay hop nhung khong co nut sua, /positions bi 403 va khong goi service.
  const pickOnly = [
    { vaiTro: 'Kế toán', featurePermissions: { 'shipment.pick': true } },
    { ...MANAGER, featurePermissions: { 'stockLocationsV2.edit': false } },
    { ...MANAGER, featurePermissions: { 'stockLocationsV2.view': false } }
  ];
  for (const user of pickOnly) {
    const limited = await start(t, { user });
    const view = await fetch(limited.base + '/candidates?branch=HN&order=DH001');
    assert.equal(view.status, 200);
    assert.equal((await view.json()).canEditPositions, false, JSON.stringify(user));
    for (const [method, url] of [['POST', '/positions'], ['PATCH', '/positions/1'], ['DELETE', '/positions/1?branch=HN&order=DH001&version=1']]) {
      const res = await fetch(limited.base + url, { method, headers: json, ...(method === 'DELETE' ? {} : { body: JSON.stringify(body) }) });
      assert.equal(res.status, 403, `${JSON.stringify(user)} ${method} ${url}`);
    }
    assert.deepEqual(limited.calls.map(c => c[0]), ['candidates']);
  }
});

test('Lỗi sửa VT trong hộp trả kèm mã đơn đang giữ (orders) và tổng giữ (held)', async t => {
  const failWith = Object.assign(new Error('Đơn DH002 đang giữ 100 tại vị trí này, không hạ dưới 100.'), { statusCode: 409, code: 'BELOW_HELD', orders: ['DH002'], held: 100 });
  const { base } = await start(t, { failWith });
  const res = await fetch(base + '/positions/1', { method: 'PATCH', headers: json, body: JSON.stringify({ branch: 'HN', orderCode: 'DH001', notes: '1T x 50', version: 1 }) });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: failWith.message, code: 'BELOW_HELD', orders: ['DH002'], held: 100 });
  const held = Object.assign(new Error('Dòng này đang được đơn Đang bốc DH002 chỉ định nên không xóa được.'), { statusCode: 409, code: 'POSITION_HELD', orders: ['DH002'] });
  const second = await start(t, { failWith: held });
  const removed = await fetch(second.base + '/positions/1?branch=HN&order=DH001&version=1', { method: 'DELETE' });
  assert.deepEqual(await removed.json(), { error: held.message, code: 'POSITION_HELD', orders: ['DH002'] });
});
