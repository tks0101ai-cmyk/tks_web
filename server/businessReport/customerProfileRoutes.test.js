'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ExcelJS = require('exceljs');
const { createBusinessReportRouter } = require('./businessReportRoutes');
const { serviceSnapshot } = require('./testFixtures');

const VIEW = ['reports.business', 'reports.business.customerNotes'];
const MANAGE = [...VIEW, 'reports.business.customerManage'];
const KEY = 'chị a';
const NOW = new Date('2026-10-22T05:00:00Z'); // 2026-10-22 gio VN
const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const IMG_ID = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('png-body')]);
const note = (over = {}) => ({ id: NOTE_ID, noteDate: '2026-10-22', body: 'Gặp khách', authorId: 'u-9', authorName: 'Sale', createdAt: '2026-10-22T03:00:00.000Z', updatedAt: '2026-10-22T03:00:00.000Z', ...over });

test('local price level: manager and assigned editor can change, unrelated viewer cannot; conflict is 409', async () => {
  const body = { key:KEY,level:'vip',version:1 };
  assert.equal((await call('/customer-price-level', { method:'PUT',body })).status,200);
  assert.equal((await call('/customer-price-level', { method:'PUT',body, permissions:VIEW })).status,403);
  const assigned = fakeProfiles({ editors:[{key:KEY,userId:'u-1'}] });
  assert.deepEqual((await call('/customer-price-level', { method:'PUT',body,permissions:VIEW,profiles:assigned })).data,
    {priceLevel:'vip',priceLevelVersion:2});
  const levels = { saveLevel:async () => { throw Object.assign(new Error('conflict'),{statusCode:409,code:'PRICE_LEVEL_CONFLICT'}); } };
  assert.equal((await call('/customer-price-level', {method:'PUT',body,levels})).status,409);
  const report = await call('/customers', {permissions:VIEW,profiles:assigned});
  const row = report.data.rows.find(r => r.key === KEY);
  assert.equal(row.priceLevel,'lớn');
  assert.equal(row.canEditPriceLevel,true);
  assert.deepEqual(row.salesChannels,['san']);
  const fields = await call('/export/fields?kind=customers&salesChannel=san&warehouseScale=small', {permissions:[...VIEW,'reports.export']});
  assert.equal(fields.data.worksheets[0].rowCount,1);
  assert.ok(fields.data.worksheets[0].fields.some(f => f.key === 'warehouseScale'));
});

// Kho gia luu trong RAM, ghi lai moi loi goi ghi (de kiem "khong ghi" khi bi 403).
function fakeProfiles({ editors = [], ...over } = {}) {
  const calls = [];
  const rec = (name, result) => async (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result; };
  const profile = { warehouseLocation: 'Kho 1', area: '', warehouseCount: 2, warehouseScale: 'small', competitor: '', salesChannels: ['san'] };
  return {
    calls,
    getReportProfiles: async keys => Object.fromEntries(keys.filter(k => k === KEY).map(k => [k, {
      ...profile, editors: editors.length ? editors.map(e => ({userId:e.userId,userName:'Sale'})) : [{ userId: 'u-2', userName: 'Sale Hai' }], visitDays: ['2026-10-01','2026-10-20'],
      images: [{ url: `/api/business-report/customer-profile/images/${IMG_ID}` }], lastVisit: '2026-10-20'
    }])),
    getMeta: rec('getMeta', { [KEY]: { lastVisit: '2026-10-20', noteCount: 2 } }),
    getProfile: rec('getProfile', {
      profile, images: [{ id: IMG_ID, url: `/api/business-report/customer-profile/images/${IMG_ID}`, contentType: 'image/png', byteSize: 12, createdAt: '2026-10-21T00:00:00.000Z' }],
      notes: [note(), note({ id: 'c0ffee00-0000-4000-8000-000000000000', noteDate: '2026-10-21' })],
      visitDays: ['2026-10-01', '2026-10-20'], lastVisit: '2026-10-20', editors: [{ userId: 'u-2', userName: 'Sale Hai' }]
    }),
    isEditor: async (key, userId) => editors.some(e => e.key === key && String(e.userId) === String(userId)),
    saveProfile: rec('saveProfile', (key, name, input) => ({ ...input, warehouseScale: profile.warehouseScale })),
    saveScale: rec('saveScale', (key, name, warehouseScale) => ({ ...profile, warehouseScale })),
    createNote: rec('createNote', (key, body) => note({ body })),
    updateNote: rec('updateNote', (key, id, body) => note({ id, body })),
    addImage: rec('addImage', (key, buf) => ({ id: IMG_ID, url: `/api/business-report/customer-profile/images/${IMG_ID}`, contentType: 'image/png', byteSize: buf.length, createdAt: '2026-10-22T05:00:00.000Z' })),
    deleteImage: rec('deleteImage', true),
    getImageMeta: async id => (id === IMG_ID ? { contentType: 'image/png', byteSize: PNG.length, sha256: 'ab'.repeat(32) } : null),
    getImageContent: async id => (id === IMG_ID ? PNG : null),
    setVisitDays: rec('setVisitDays', (key, dates) => ({ visitDays: dates, lastVisit: dates[dates.length - 1] || null })),
    setEditors: rec('setEditors', (key, ids) => ids.map(userId => ({ userId, userName: `Tên ${userId}` }))),
    listAssignableUsers: rec('listAssignableUsers', [{ id: 'u-2', hoTen: 'Sale Hai', vaiTro: 'Nhân viên sale' }]),
    ...over
  };
}

async function call(path, { permissions = MANAGE, user = {}, method = 'GET', body, form, headers = {}, profiles = fakeProfiles(), levels = null } = {}) {
  const app = express();
  app.use((req, res, next) => {
    req.user = { id: 'u-1', username: 'tester', hoTen: 'Người Test', vaiTro: 'Quản lý', permissions, ...user };
    req.effectiveUserResolved = true;
    next();
  });
  app.use('/api/business-report', createBusinessReportRouter({
    repository: { snapshot: async () => serviceSnapshot() },
    customerProfiles: profiles,
    customerPriceLevels: levels || {
      getLevels: async keys => Object.fromEntries(keys.map(k => [k, { level:'large', version:1 }])),
      saveLevel: async (key, level, version) => ({ level,version:version+1 })
    },
    now: () => NOW
  }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/business-report${path}`, {
      method,
      // 'no-cache' (thay vi mac dinh) de undici khong tu them Cache-Control: no-cache khi co If-None-Match.
      cache: 'no-cache',
      headers: form ? headers : { 'Content-Type': 'application/json', ...headers },
      body: form || (body === undefined ? undefined : JSON.stringify(body))
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, profiles, data: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}
const writes = r => r.profiles.calls.filter(([name]) => name !== 'getProfile' && name !== 'getMeta');

test('scale requires both manager and notes permissions; assigned editors cannot write scale', async () => {
  const body = { key: KEY, warehouseScale: 'very_large' };
  for (const permissions of [VIEW, ['reports.business', 'reports.business.customerManage']]) {
    const profiles = fakeProfiles({ editors: [{ key: KEY, userId: 'u-2' }] });
    const r = await call('/customer-profile/scale', { method: 'PUT', body, permissions, user: { id: 'u-2' }, profiles });
    assert.equal(r.status, 403);
    assert.equal(writes(r).length, 0);
  }
  const profiles = fakeProfiles({ saveScale: async (key, name, scale) => ({ warehouseScale: scale }) });
  const r = await call('/customer-profile/scale', { method: 'PUT', body, profiles });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { warehouseScale: 'very_large' });
  for (const warehouseScale of ['huge', null, '']) {
    assert.equal((await call('/customer-profile/scale', { method: 'PUT', body: { ...body, warehouseScale }, profiles })).status, 400);
  }
});

test('moi API ghi chu khach: 403 neu thieu reports.business.customerNotes (ke ca khi co reports.business)', async () => {
  const none = { permissions: ['reports.business'] };
  const cases = [
    ['GET', '/customer-meta'], ['GET', `/customer-profile?key=${encodeURIComponent(KEY)}`], ['PUT', '/customer-profile'],
    ['POST', '/customer-profile/notes'], ['PUT', `/customer-profile/notes/${NOTE_ID}`], ['POST', `/customer-profile/images?key=${encodeURIComponent(KEY)}`],
    ['DELETE', `/customer-profile/images/${IMG_ID}?key=${encodeURIComponent(KEY)}`], ['GET', `/customer-profile/images/${IMG_ID}`],
    ['PUT', '/customer-profile/visits'], ['PUT', '/customer-profile/editors'], ['PUT', '/customer-profile/scale'], ['GET', '/customer-profile/assignable-users']
  ];
  for (const [method, path] of cases) {
    const r = await call(path, { ...none, method, body: method === 'GET' || method === 'DELETE' ? undefined : { key: KEY } });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(writes(r).length, 0);
  }
});

test('GET /customer-meta tra { customers } va khong cache', async () => {
  const r = await call('/customer-meta', { permissions: VIEW });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, { customers: { [KEY]: { lastVisit: '2026-10-20', noteCount: 2 } } });
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('GET /customer-profile: dung hop dong, Quan ly canEdit + canManage, note hom nay editable', async () => {
  const r = await call(`/customer-profile?key=${encodeURIComponent(KEY)}`, { permissions: MANAGE });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data).sort(), ['canEdit', 'canManage', 'editors', 'images', 'key', 'lastVisit', 'name', 'notes', 'profile', 'today', 'visitDays']);
  assert.equal(r.data.key, KEY);
  assert.equal(r.data.name, 'Chị A');
  assert.equal(r.data.today, '2026-10-22');
  assert.equal(r.data.canEdit, true);
  assert.equal(r.data.canManage, true);
  assert.deepEqual(r.data.notes.map(n => [n.noteDate, n.editable]), [['2026-10-22', true], ['2026-10-21', false]]);
  assert.deepEqual(r.data.visitDays, ['2026-10-01', '2026-10-20']);
  assert.equal(r.data.lastVisit, '2026-10-20');
  assert.deepEqual(r.data.profile, { warehouseLocation: 'Kho 1', area: '', warehouseCount: 2, warehouseScale: 'small', competitor: '', salesChannels: ['san'] });
  assert.equal(r.data.images[0].url, `/api/business-report/customer-profile/images/${IMG_ID}`);
  assert.deepEqual(r.data.editors, [{ userId: 'u-2', userName: 'Sale Hai' }]);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('GET /customer-profile: nguoi duoc gan canEdit, nguoi khong duoc gan chi doc (note khong editable)', async () => {
  const profiles = fakeProfiles({ editors: [{ key: KEY, userId: 'u-2' }] });
  const assigned = await call(`/customer-profile?key=${encodeURIComponent(KEY)}`, { permissions: VIEW, user: { id: 'u-2', vaiTro: 'Nhân viên sale' }, profiles });
  assert.equal(assigned.data.canEdit, true);
  assert.equal(assigned.data.canManage, false);
  assert.equal(assigned.data.notes[0].editable, true);
  const other = await call(`/customer-profile?key=${encodeURIComponent(KEY)}`, { permissions: VIEW, user: { id: 'u-3', vaiTro: 'Nhân viên sale' }, profiles });
  assert.equal(other.data.canEdit, false);
  assert.equal(other.data.canManage, false);
  assert.ok(other.data.notes.every(n => n.editable === false));
  // Duoc gan cho khach khac thi khong tinh cho khach nay.
  const wrongCustomer = await call(`/customer-profile?key=${encodeURIComponent(KEY)}`, { permissions: VIEW, user: { id: 'u-5' }, profiles: fakeProfiles({ editors: [{ key: 'anh b', userId: 'u-5' }] }) });
  assert.equal(wrongCustomer.data.canEdit, false);
});

test('GET /customer-profile: thieu key 400, khach khong co trong bao cao 404', async () => {
  assert.equal((await call('/customer-profile')).status, 400);
  const unknown = await call('/customer-profile?key=' + encodeURIComponent('khach la'));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.data.code, 'CUSTOMER_NOT_FOUND');
});

test('PUT /customer-profile: Quan ly luon sua; nguoi duoc gan sua; nguoi khong duoc gan 403 va khong ghi', async () => {
  const body = { key: KEY, warehouseLocation: ' Kho A ', warehouseCount: '5', warehouseScale: 'large', competitor: 'Tem Y', salesChannels: ['san', 'fb_live'] };
  const manager = await call('/customer-profile', { method: 'PUT', body });
  assert.equal(manager.status, 200);
  assert.deepEqual(manager.data, { profile: { warehouseLocation: 'Kho A', area: '', warehouseCount: 5, warehouseScale: 'small', competitor: 'Tem Y', salesChannels: ['san', 'fb_live'] } });
  assert.equal(Object.hasOwn(writes(manager)[0][3], 'warehouseScale'), false);
  const [name, key, customerName, , actor] = writes(manager)[0];
  assert.deepEqual([name, key, customerName, actor], ['saveProfile', KEY, 'Chị A', { id: 'u-1', name: 'Người Test' }]);

  const editors = [{ key: KEY, userId: 'u-2' }];
  const assigned = await call('/customer-profile', { method: 'PUT', body, permissions: VIEW, user: { id: 'u-2' }, profiles: fakeProfiles({ editors }) });
  assert.equal(assigned.status, 200);
  assert.equal(Object.hasOwn(writes(assigned)[0][3], 'warehouseScale'), false);
  const denied = await call('/customer-profile', { method: 'PUT', body, permissions: VIEW, user: { id: 'u-3' }, profiles: fakeProfiles({ editors }) });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.code, 'CUSTOMER_EDIT_FORBIDDEN');
  assert.equal(writes(denied).length, 0);
});

test('PUT /customer-profile: validate 400 (area, kenh, so luong, do dai), thieu key 400, khach la 404', async () => {
  const ok = { key: KEY, warehouseScale: 'none', salesChannels: [] };
  for (const bad of [
    { ...ok, area: 'x'.repeat(501) }, { ...ok, salesChannels: ['san', 'tiktok'] }, { ...ok, salesChannels: 'san' },
    { ...ok, warehouseCount: -1 }, { ...ok, warehouseCount: 'abc' }, { ...ok, competitor: 'x'.repeat(501) }, { ...ok, warehouseLocation: 'x'.repeat(501) }
  ]) {
    const r = await call('/customer-profile', { method: 'PUT', body: bad });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal(r.data.code, 'INVALID_PROFILE');
    assert.equal(writes(r).length, 0);
  }
  assert.equal((await call('/customer-profile', { method: 'PUT', body: { warehouseScale: 'none' } })).status, 400);
  assert.equal((await call('/customer-profile', { method: 'PUT', body: { ...ok, key: 'khach la' } })).status, 404);
  const empty = await call('/customer-profile', { method: 'PUT', body: { ...ok, warehouseCount: null } });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.profile.warehouseCount, null);
});

test('POST /customer-profile/notes: 201 + editable, trung ngay 409 NOTE_EXISTS_TODAY, validate 400, nguoi la 403', async () => {
  const ok = await call('/customer-profile/notes', { method: 'POST', body: { key: KEY, body: '  Đã gặp  ' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.note.body, 'Đã gặp');
  assert.equal(ok.data.note.editable, true);
  assert.deepEqual(writes(ok)[0], ['createNote', KEY, 'Đã gặp', { id: 'u-1', name: 'Người Test' }]);

  const dup = Object.assign(new Error('Hôm nay khách này đã có note'), { statusCode: 409, code: 'NOTE_EXISTS_TODAY' });
  const conflict = await call('/customer-profile/notes', { method: 'POST', body: { key: KEY, body: 'x' }, profiles: fakeProfiles({ createNote: async () => { throw dup; } }) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.code, 'NOTE_EXISTS_TODAY');

  for (const body of ['', '   ', 'x'.repeat(2001), null, 5]) {
    const r = await call('/customer-profile/notes', { method: 'POST', body: { key: KEY, body } });
    assert.equal(r.status, 400, String(body).slice(0, 10));
    assert.equal(r.data.code, 'INVALID_NOTE');
  }
  assert.equal((await call('/customer-profile/notes', { method: 'POST', body: { key: 'khach la', body: 'x' } })).status, 404);
  const denied = await call('/customer-profile/notes', { method: 'POST', body: { key: KEY, body: 'x' }, permissions: VIEW, user: { id: 'u-3' } });
  assert.equal(denied.status, 403);
  assert.equal(writes(denied).length, 0);
});

test('PUT /customer-profile/notes/:id: sua trong ngay, qua ngay 409 NOTE_LOCKED, id sai 404, nguoi duoc gan sua duoc', async () => {
  const ok = await call(`/customer-profile/notes/${NOTE_ID}`, { method: 'PUT', body: { key: KEY, body: 'Sửa lại' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.note.body, 'Sửa lại');
  assert.equal(ok.data.note.editable, true);
  assert.deepEqual(writes(ok)[0].slice(0, 4), ['updateNote', KEY, NOTE_ID, 'Sửa lại']);

  const locked = Object.assign(new Error('Note đã qua ngày'), { statusCode: 409, code: 'NOTE_LOCKED' });
  const r = await call(`/customer-profile/notes/${NOTE_ID}`, { method: 'PUT', body: { key: KEY, body: 'x' }, profiles: fakeProfiles({ updateNote: async () => { throw locked; } }) });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'NOTE_LOCKED');

  assert.equal((await call('/customer-profile/notes/khong-phai-uuid', { method: 'PUT', body: { key: KEY, body: 'x' } })).status, 404);
  assert.equal((await call(`/customer-profile/notes/${NOTE_ID}`, { method: 'PUT', body: { key: KEY, body: '' } })).status, 400);
  const assigned = await call(`/customer-profile/notes/${NOTE_ID}`, { method: 'PUT', body: { key: KEY, body: 'Người được gán sửa' }, permissions: VIEW, user: { id: 'u-2' }, profiles: fakeProfiles({ editors: [{ key: KEY, userId: 'u-2' }] }) });
  assert.equal(assigned.status, 200);
  const denied = await call(`/customer-profile/notes/${NOTE_ID}`, { method: 'PUT', body: { key: KEY, body: 'x' }, permissions: VIEW, user: { id: 'u-3' } });
  assert.equal(denied.status, 403);
  assert.equal(writes(denied).length, 0);
});

function pngForm(name = 'a.png', content = PNG) {
  const form = new FormData();
  form.append('file', new Blob([content], { type: 'image/png' }), name);
  return form;
}

test('POST /customer-profile/images: 201 { image }; 403 truoc khi doc file; thieu file 400; IMAGE_LIMIT/IMAGE_INVALID tu repository', async () => {
  const q = `?key=${encodeURIComponent(KEY)}`;
  const ok = await call(`/customer-profile/images${q}`, { method: 'POST', form: pngForm() });
  assert.equal(ok.status, 201);
  assert.deepEqual(Object.keys(ok.data.image).sort(), ['byteSize', 'contentType', 'createdAt', 'id', 'url']);
  const [name, key, buffer, actor] = writes(ok)[0];
  assert.deepEqual([name, key, Buffer.compare(buffer, PNG), actor], ['addImage', KEY, 0, { id: 'u-1', name: 'Người Test' }]);

  const denied = await call(`/customer-profile/images${q}`, { method: 'POST', form: pngForm(), permissions: VIEW, user: { id: 'u-3' } });
  assert.equal(denied.status, 403);
  assert.equal(writes(denied).length, 0);

  const missing = new FormData();
  missing.append('other', 'x');
  assert.equal((await call(`/customer-profile/images${q}`, { method: 'POST', form: missing })).data.code, 'IMAGE_MISSING');
  assert.equal((await call('/customer-profile/images', { method: 'POST', form: pngForm() })).status, 400);
  assert.equal((await call('/customer-profile/images?key=khach%20la', { method: 'POST', form: pngForm() })).status, 404);

  for (const [statusCode, code] of [[409, 'IMAGE_LIMIT'], [400, 'IMAGE_INVALID'], [413, 'IMAGE_TOO_LARGE']]) {
    const err = Object.assign(new Error('loi'), { statusCode, code });
    const r = await call(`/customer-profile/images${q}`, { method: 'POST', form: pngForm(), profiles: fakeProfiles({ addImage: async () => { throw err; } }) });
    assert.deepEqual([r.status, r.data.code], [statusCode, code]);
  }
});

test('POST /customer-profile/images: file qua 5MB bi chan 413 IMAGE_TOO_LARGE', async () => {
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  const r = await call(`/customer-profile/images?key=${encodeURIComponent(KEY)}`, { method: 'POST', form: pngForm('big.png', big) });
  assert.equal(r.status, 413);
  assert.equal(r.data.code, 'IMAGE_TOO_LARGE');
});

test('DELETE /customer-profile/images/:id: can quyen sua + key; khong thay 404', async () => {
  const q = `?key=${encodeURIComponent(KEY)}`;
  const ok = await call(`/customer-profile/images/${IMG_ID}${q}`, { method: 'DELETE' });
  assert.deepEqual([ok.status, ok.data], [200, { ok: true }]);
  assert.deepEqual(writes(ok)[0], ['deleteImage', KEY, IMG_ID]);
  const denied = await call(`/customer-profile/images/${IMG_ID}${q}`, { method: 'DELETE', permissions: VIEW, user: { id: 'u-3' } });
  assert.equal(denied.status, 403);
  assert.equal(writes(denied).length, 0);
  assert.equal((await call(`/customer-profile/images/${IMG_ID}`, { method: 'DELETE' })).status, 400);
  assert.equal((await call(`/customer-profile/images/abc${q}`, { method: 'DELETE' })).status, 404);
  const notFound = Object.assign(new Error('Không tìm thấy ảnh.'), { statusCode: 404, code: 'IMAGE_NOT_FOUND' });
  assert.equal((await call(`/customer-profile/images/${IMG_ID}${q}`, { method: 'DELETE', profiles: fakeProfiles({ deleteImage: async () => { throw notFound; } }) })).status, 404);
});

test('GET /customer-profile/images/:id: tra byte voi ETag sha256, cache private immutable, nosniff; If-None-Match => 304; sai id 404', async () => {
  const r = await call(`/customer-profile/images/${IMG_ID}`, { permissions: VIEW });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('etag'), `"${'ab'.repeat(32)}"`);
  assert.equal(r.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(r.data, PNG);
  const cached = await call(`/customer-profile/images/${IMG_ID}`, { permissions: VIEW, headers: { 'If-None-Match': `"${'ab'.repeat(32)}"` } });
  assert.equal(cached.status, 304);
  assert.equal((await call('/customer-profile/images/33333333-3333-4333-8333-333333333333', { permissions: VIEW })).status, 404);
  assert.equal((await call('/customer-profile/images/abc', { permissions: VIEW })).status, 404);
});

test('PUT /customer-profile/visits: chi customerManage; thay ca tap ngay; ngay tuong lai / sai dinh dang / qua 400 => 400', async () => {
  const body = { key: KEY, dates: ['2026-10-20', '2026-10-01', '2026-10-20', '2026-10-22'] };
  const ok = await call('/customer-profile/visits', { method: 'PUT', body });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { visitDays: ['2026-10-01', '2026-10-20', '2026-10-22'], lastVisit: '2026-10-22' });
  assert.deepEqual(writes(ok)[0], ['setVisitDays', KEY, ['2026-10-01', '2026-10-20', '2026-10-22'], { id: 'u-1', name: 'Người Test' }]);

  // Nguoi duoc gan sua noi dung nhung KHONG sua duoc Tiep khach lan cuoi.
  const assigned = await call('/customer-profile/visits', { method: 'PUT', body, permissions: VIEW, user: { id: 'u-2' }, profiles: fakeProfiles({ editors: [{ key: KEY, userId: 'u-2' }] }) });
  assert.equal(assigned.status, 403);
  assert.equal(writes(assigned).length, 0);

  for (const dates of [['2026-10-23'], ['2026-02-30'], ['22/10/2026'], 'x', null, Array.from({ length: 401 }, () => '2026-10-01').map((d, i) => `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`).concat(['2024-05-05'])]) {
    const r = await call('/customer-profile/visits', { method: 'PUT', body: { key: KEY, dates } });
    assert.equal(r.status, 400, JSON.stringify(dates).slice(0, 40));
    assert.equal(r.data.code, 'INVALID_VISIT_DATES');
  }
  assert.equal((await call('/customer-profile/visits', { method: 'PUT', body: { key: 'khach la', dates: [] } })).status, 404);
  assert.deepEqual((await call('/customer-profile/visits', { method: 'PUT', body: { key: KEY, dates: [] } })).data, { visitDays: [], lastVisit: null });
});

test('PUT /customer-profile/editors + GET assignable-users: chi customerManage, thay ca danh sach', async () => {
  const ok = await call('/customer-profile/editors', { method: 'PUT', body: { key: KEY, userIds: ['u-2', 'u-3', 'u-2'] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { editors: [{ userId: 'u-2', userName: 'Tên u-2' }, { userId: 'u-3', userName: 'Tên u-3' }] });
  assert.deepEqual(writes(ok)[0].slice(0, 3), ['setEditors', KEY, ['u-2', 'u-3']]);
  assert.deepEqual((await call('/customer-profile/editors', { method: 'PUT', body: { key: KEY, userIds: [] } })).data, { editors: [] });
  for (const userIds of ['u-2', null, [''], [{}], Array.from({ length: 201 }, (_, i) => `u-${i}`)]) {
    const r = await call('/customer-profile/editors', { method: 'PUT', body: { key: KEY, userIds } });
    assert.equal(r.status, 400, JSON.stringify(userIds).slice(0, 30));
    assert.equal(r.data.code, 'INVALID_EDITORS');
  }
  assert.equal((await call('/customer-profile/editors', { method: 'PUT', body: { key: 'khach la', userIds: [] } })).status, 404);
  const denied = await call('/customer-profile/editors', { method: 'PUT', body: { key: KEY, userIds: ['u-2'] }, permissions: VIEW });
  assert.equal(denied.status, 403);
  assert.equal(writes(denied).length, 0);

  const list = await call('/customer-profile/assignable-users');
  assert.deepEqual(list.data, { users: [{ id: 'u-2', hoTen: 'Sale Hai', vaiTro: 'Nhân viên sale' }] });
  assert.equal((await call('/customer-profile/assignable-users', { permissions: VIEW })).status, 403);
});

test('repository bao MIGRATION_PENDING (503): route tra 503 co code, khong thanh 500', async () => {
  const pending = Object.assign(new Error('Chức năng ghi chú khách hàng chưa sẵn sàng'), { statusCode: 503, code: 'MIGRATION_PENDING' });
  const profiles = fakeProfiles({ saveProfile: async () => { throw pending; }, createNote: async () => { throw pending; }, setVisitDays: async () => { throw pending; } });
  for (const [path, method, body] of [
    ['/customer-profile', 'PUT', { key: KEY, warehouseScale: 'none' }],
    ['/customer-profile/notes', 'POST', { key: KEY, body: 'x' }],
    ['/customer-profile/visits', 'PUT', { key: KEY, dates: [] }]
  ]) {
    const r = await call(path, { method, body, profiles });
    assert.equal(r.status, 503, path);
    assert.equal(r.data.code, 'MIGRATION_PENDING');
  }
});

test('loi he thong ghi chu khach van la 500 khong lo chi tiet', async () => {
  const origError = console.error;
  console.error = () => {};
  try {
    const r = await call('/customer-meta', { permissions: VIEW, profiles: fakeProfiles({ getMeta: async () => { throw new Error('secret db detail'); } }) });
    assert.equal(r.status, 500);
    assert.equal(r.data.code, 'BUSINESS_REPORT_ERROR');
    assert.ok(!JSON.stringify(r.data).includes('secret'));
  } finally { console.error = origError; }
});

test('GET /export?kind=customers: them cot "Tiep khach lan cuoi" (dd/mm/yyyy) khi co quyen xem ghi chu khach', async () => {
  const exporter = [...VIEW, 'reports.products.growth', 'reports.export'];
  const fields = await call('/export/fields?kind=customers&inactive=1', { permissions: exporter });
  assert.deepEqual(fields.data.worksheets[0].fields.slice(0, 4).map(f => f.label), ['Tên khách', 'Sale', 'Level giá', 'Tiếp khách lần cuối']);
  const res = await call('/export?kind=customers&format=xlsx&inactive=1&columns=' + encodeURIComponent('name,lastVisit'), { permissions: exporter });
  assert.equal(res.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(res.data);
  const rows = wb.worksheets[0].getSheetValues().slice(2).map(r => r.slice(1));
  assert.deepEqual(wb.worksheets[0].getRow(1).values.slice(1), ['Tên khách', 'Tiếp khách lần cuối']);
  assert.deepEqual(rows.find(r => r[0] === 'Chị A'), ['Chị A', '20/10/2026']);
  assert.deepEqual(rows.find(r => r[0] === 'Anh B'), ['Anh B', '']);
});

test('GET /export: no profile fields without view permission; batch read failure blocks export', async () => {
  const plain = ['reports.business', 'reports.products.growth', 'reports.export'];
  const fields = await call('/export/fields?kind=customers', { permissions: plain });
  assert.ok(!fields.data.worksheets[0].fields.some(f => f.key === 'lastVisit'));
  assert.equal((await call('/export?kind=customers&format=xlsx&columns=lastVisit', { permissions: plain })).status, 400);

  const origError = console.error;
  console.error = () => {};
  try {
    const broken = fakeProfiles({ getReportProfiles: async () => { throw new Error('db down'); } });
    const res = await call('/export?kind=customers&format=xlsx&inactive=1&columns=' + encodeURIComponent('name,lastVisit'), { permissions: [...VIEW, 'reports.products.growth', 'reports.export'], profiles: broken });
    assert.equal(res.status, 500);
    assert.equal(res.data.code,'BUSINESS_REPORT_ERROR');
  } finally { console.error = origError; }
});

// Noi that su: router + repository that tren PGlite co migration 0080 (hop dong GET/PUT/POST xuyen suot), va chua migrate => 503.
test('tich hop PGlite: Quan ly tao note / ngay da di / nguoi sua / anh qua router that; chua migrate => doc rong, ghi 503', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { PGlite } = require('@electric-sql/pglite');
  const { createCustomerProfileRepository } = require('./customerProfileRepository');
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0080_customer_notes.sql'), 'utf8');
  const detailsSql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0084_customer_profile_details.sql'), 'utf8');
  const users = [{ id: 'u-2', username: 'sale2', hoTen: 'Sale Hai', vaiTro: 'Nhân viên sale', trangThai: 'Đang hoạt động' }];
  const make = async migrate => {
    const db = new PGlite();
    if (migrate) { await db.exec(sql); await db.exec(detailsSql); }
    const pool = { query: (q, p) => db.query(q, p), connect: async () => ({ query: (q, p) => db.query(q, p), release() {} }) };
    return { db, profiles: createCustomerProfileRepository({ pool, now: () => NOW, userStore: { getAllUsers: async () => users } }) };
  };
  const { db, profiles } = await make(true);
  try {
    const q = encodeURIComponent(KEY);
    const created = await call('/customer-profile/notes', { method: 'POST', body: { key: KEY, body: 'Lần đầu' }, profiles });
    assert.equal(created.status, 201);
    assert.equal(created.data.note.noteDate, '2026-10-22');
    assert.equal(created.data.note.authorName, 'Người Test');
    assert.equal((await call('/customer-profile/notes', { method: 'POST', body: { key: KEY, body: 'Lần hai' }, profiles })).data.code, 'NOTE_EXISTS_TODAY');
    assert.equal((await call('/customer-profile/visits', { method: 'PUT', body: { key: KEY, dates: ['2026-10-05', '2026-10-21'] }, profiles })).data.lastVisit, '2026-10-21');
    assert.equal((await call('/customer-profile/editors', { method: 'PUT', body: { key: KEY, userIds: ['u-2'] }, profiles })).status, 200);
    assert.equal((await call('/customer-profile/editors', { method: 'PUT', body: { key: KEY, userIds: ['u-404'] }, profiles })).data.code, 'INVALID_EDITORS');
    const up = await call(`/customer-profile/images?key=${q}`, { method: 'POST', form: pngForm(), profiles });
    assert.equal(up.status, 201);
    const img = await call(up.data.image.url.replace('/api/business-report', ''), { permissions: VIEW, profiles });
    assert.equal(img.status, 200);
    assert.deepEqual(img.data, PNG);

    // Sale duoc gan sua duoc (isEditor that), Sale khac chi doc.
    const sale = { permissions: VIEW, user: { id: 'u-2', vaiTro: 'Nhân viên sale' }, profiles };
    const edited = await call(`/customer-profile/notes/${created.data.note.id}`, { ...sale, method: 'PUT', body: { key: KEY, body: 'Sale sửa' } });
    assert.equal(edited.status, 200);
    assert.equal(edited.data.note.body, 'Sale sửa');
    assert.equal((await call(`/customer-profile/notes/${created.data.note.id}`, { ...sale, user: { id: 'u-3' }, method: 'PUT', body: { key: KEY, body: 'x' } })).status, 403);

    const full = await call(`/customer-profile?key=${q}`, { ...sale, user: { id: 'u-3' } });
    assert.deepEqual([full.data.canEdit, full.data.canManage, full.data.lastVisit, full.data.notes.length, full.data.images.length], [false, false, '2026-10-21', 1, 1]);
    assert.deepEqual(full.data.editors, [{ userId: 'u-2', userName: 'Sale Hai' }]);
    assert.deepEqual((await call('/customer-meta', { permissions: VIEW, profiles })).data, { customers: { [KEY]: { lastVisit: '2026-10-21', noteCount: 1 } } });
  } finally { await db.close(); }

  const bare = await make(false);
  try {
    assert.deepEqual((await call('/customer-meta', { permissions: VIEW, profiles: bare.profiles })).data, { customers: {} });
    const view = await call(`/customer-profile?key=${encodeURIComponent(KEY)}`, { permissions: VIEW, profiles: bare.profiles });
    assert.deepEqual([view.status, view.data.notes, view.data.canEdit], [200, [], false]);
    const write = await call('/customer-profile/notes', { method: 'POST', body: { key: KEY, body: 'x' }, profiles: bare.profiles });
    assert.deepEqual([write.status, write.data.code], [503, 'MIGRATION_PENDING']);
  } finally { await bare.db.close(); }
});
