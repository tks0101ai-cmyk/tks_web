'use strict';
process.env.JWT_SECRET ||= 'test-secret';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ExcelJS = require('exceljs');
const { EventEmitter } = require('node:events');
const { createStockPositionsRouter } = require('./stockPositionsRoutes');
const { CHANGED } = require('./stockPositionsEvents');

const MANAGER = { id: 'ql', vaiTro: 'Quản lý' };
const ROWS = [
  { id: 1, code: 'AAA1', name: 'Hàng A', notes: '3T x 100', arrivalDate: '4/10', location: 'H1', quantity: 300, held: 120, available: 180, kiotQuantity: 42, warnings: [], updatedByName: 'QL', updatedAt: '2026-10-27T03:00:00.000Z', version: 1 },
  { id: 2, code: 'BBB2', name: '=SUM(A1)', notes: 'rác', arrivalDate: '', location: '', quantity: null, held: 0, available: null, kiotQuantity: null, warnings: ['unreadable'], updatedByName: 'QL', updatedAt: '2026-10-27T04:30:00.000Z', version: 1 }
];

const HISTORY = [
  { id: 2, createdAt: '2026-10-27T03:44:00.000Z', branch: 'HN', code: 'CKL2DBV', location: 'ST', action: 'edit', field: 'notes', oldValue: '41T x 250', newValue: '=40T x 250', summary: null, actorName: 'Nguyễn Ngọc Việt Thắng' },
  { id: 1, createdAt: '2026-10-27T03:27:00.000Z', branch: 'HN', code: 'CKL2DBV', location: 'ST', action: 'import_add', field: null, oldValue: null, newValue: null, summary: { added: 3, fileName: 'a.xlsx' }, actorName: 'Nhập dữ liệu đầu' }
];

async function start(t, { user = MANAGER, scope = 'Cả hai', events } = {}) {
  const calls = [];
  const record = name => async (ctx, ...args) => { calls.push([name, ...args]); return { ok: name }; };
  const service = {
    list: async (ctx, branch) => { calls.push(['list', branch, ctx.scope]); return { branch, rows: ROWS }; },
    create: record('create'), update: record('update'), deduct: record('deduct'), remove: record('remove'), history: record('history'),
    acknowledge: record('acknowledge'), purgeHistory: record('purgeHistory'),
    historyAll: async (ctx, branch, filters) => { calls.push(['historyAll', branch, filters, ctx.scope]); return { rows: HISTORY, truncated: false }; },
    stockOutFile: async (ctx, branch, options) => { calls.push(['stockOutFile', branch, options.fileName, options.buffer.length, ctx.scope]); return { counts: {}, errors: [] }; },
    importFile: async (ctx, branch, options) => { calls.push(['importFile', branch, options.mode, options.commit, options.fileName, options.buffer.length, ...(options.inputRows === undefined ? [] : [options.inputRows])]); return { counts: {} }; }
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = user; next(); });
  app.use(createStockPositionsRouter({
    requireAuth: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập.' })),
    resolveBranch: (req, res, next) => { req.branch = scope; next(); },
    service,
    ...(events ? { events } : {})
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api/stock-positions`;
  return { calls, base };
}

test('GET danh sách: Quản lý có canEdit + canExport, không cache, truyền phạm vi cơ sở', async t => {
  const { base, calls } = await start(t, { scope: 'Sài Gòn' });
  const res = await fetch(base + '?branch=SG');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.canEdit, true);
  assert.equal(body.canExport, true);
  assert.deepEqual(calls[0], ['list', 'SG', ['SG']]);
});

test('Chưa đăng nhập 401; Quản lý tắt quyền xem của tài khoản (kể cả Khách) thì 403, không gọi service', async t => {
  assert.equal((await fetch((await start(t, { user: null })).base + '?branch=HN')).status, 401);
  const off = { 'stockLocationsV2.view': false };
  const kho = await start(t, { user: { vaiTro: 'Nhân viên kho', featurePermissions: off } });
  const khach = await start(t, { user: { vaiTro: 'Khách', featurePermissions: off } });
  for (const { base } of [kho, khach]) {
    assert.equal((await fetch(base + '?branch=HN')).status, 403);
    // Mất xem thì xuất Excel (dù ghi đè cấp xuất) cũng mất theo.
    assert.equal((await fetch(base + '/export?branch=HN')).status, 403);
    assert.equal((await fetch(base + '/history/export?branch=HN')).status, 403);
  }
  const exportKept = await start(t, { user: { vaiTro: 'Khách', featurePermissions: { ...off, 'stockLocationsV2.export': true } } });
  assert.equal((await fetch(exportKept.base + '/export?branch=HN')).status, 403);
  assert.deepEqual([...kho.calls, ...khach.calls, ...exportKept.calls], []);
});

test('Mọi vai trò kể cả Khách xem + xuất Excel được theo mặc định, không có quyền ghi', async t => {
  const json = { 'Content-Type': 'application/json' };
  for (const vaiTro of ['Khách', 'Nhân viên kho', 'Nhân viên sale', 'Kế toán', 'Trợ lý']) {
    const { base, calls } = await start(t, { user: { vaiTro } });
    const list = await (await fetch(base + '?branch=HN')).json();
    assert.deepEqual([list.canEdit, list.canExport, list.canDeleteHistory], [false, true, false], vaiTro);
    assert.equal((await fetch(base + '/export?branch=HN')).status, 200, vaiTro);
    assert.equal((await fetch(base + '/history/export?branch=HN')).status, 200, vaiTro);
    assert.equal((await fetch(base + '/history?branch=HN')).status, 200, vaiTro);
    assert.equal((await fetch(base + '?branch=HN', { method: 'POST', headers: json, body: '{}' })).status, 403, vaiTro);
    assert.equal((await fetch(base + '/5', { method: 'PATCH', headers: json, body: '{}' })).status, 403, vaiTro);
    assert.equal((await fetch(base + '/5/deduct', { method: 'POST', headers: json, body: '{}' })).status, 403, vaiTro);
    assert.equal((await fetch(base + '/5/ack', { method: 'POST', headers: json, body: '{}' })).status, 403, vaiTro);
    assert.equal((await fetch(base + '/5', { method: 'DELETE' })).status, 403, vaiTro);
    assert.equal((await fetch(base + '/import?branch=HN&mode=add', { method: 'POST' })).status, 403, vaiTro);
    assert.equal((await fetch(base + '/stock-out?branch=HN', { method: 'POST' })).status, 403, vaiTro);
    assert.equal((await fetch(base + '/history?branch=HN', { method: 'DELETE' })).status, 403, vaiTro);
    assert.deepEqual(calls.map(c => c[0]), ['list', 'list', 'historyAll', 'history'], vaiTro);
  }
});

test('Khách được ghi đè cấp edit / historyDelete vẫn bị 403 (Khách chỉ có xem + xuất)', async t => {
  const json = { 'Content-Type': 'application/json' };
  const { base, calls } = await start(t, { user: { vaiTro: 'Khách', featurePermissions: { 'stockLocationsV2.edit': true, 'stockLocationsV2.historyDelete': true } } });
  assert.equal((await fetch(base + '?branch=HN', { method: 'POST', headers: json, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/5/ack', { method: 'POST', headers: json, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/history?branch=HN', { method: 'DELETE' })).status, 403);
  assert.deepEqual(calls, []);
});

test('Nhân viên kho ghi đè edit:true nhưng view:false thì không có quyền gì (edit cần view)', async t => {
  const json = { 'Content-Type': 'application/json' };
  const { base, calls } = await start(t, { user: { vaiTro: 'Nhân viên kho', featurePermissions: { 'stockLocationsV2.edit': true, 'stockLocationsV2.view': false } } });
  assert.equal((await fetch(base + '?branch=HN')).status, 403);
  assert.equal((await fetch(base + '?branch=HN', { method: 'POST', headers: json, body: '{}' })).status, 403);
  assert.equal((await fetch(base + '/5', { method: 'PATCH', headers: json, body: '{}' })).status, 403);
  assert.deepEqual(calls, []);
});

test('Chỉ xem (Quản lý tắt xuất Excel): đọc được, xuất bị 403', async t => {
  const viewer = { vaiTro: 'Nhân viên kho', featurePermissions: { 'stockLocationsV2.export': false } };
  const { base, calls } = await start(t, { user: viewer });
  const list = await (await fetch(base + '?branch=HN')).json();
  assert.equal(list.canEdit, false);
  assert.equal(list.canExport, false);
  assert.equal((await fetch(base + '/export?branch=HN')).status, 403);
  assert.equal((await fetch(base + '/history/export?branch=HN')).status, 403);
  assert.deepEqual(calls.map(c => c[0]), ['list']);
});

test('GET /history chuyển positionId (và limit/before) tới service', async t => {
  const { base, calls } = await start(t);
  await fetch(base + '/history?branch=SG&limit=50&before=9&positionId=12');
  await fetch(base + '/history?branch=HN');
  assert.deepEqual(calls[0], ['history', 'SG', { limit: '50', before: '9', positionId: '12' }]);
  assert.deepEqual(calls[1], ['history', 'HN', { limit: undefined, before: undefined, positionId: undefined }]);
});

test('Route ghi chuyển đúng tham số tới service', async t => {
  const { base, calls } = await start(t);
  const json = { 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '?branch=HN', { method: 'POST', headers: json, body: JSON.stringify({ code: 'A' }) })).status, 201);
  await fetch(base + '/7', { method: 'PATCH', headers: json, body: JSON.stringify({ version: 2, notes: '1T x 5' }) });
  await fetch(base + '/7/deduct', { method: 'POST', headers: json, body: JSON.stringify({ version: 2, quantity: 5 }) });
  await fetch(base + '/7?version=3', { method: 'DELETE' });
  await fetch(base + '/history?branch=HN&limit=5&before=9');
  assert.deepEqual(calls.map(c => c[0]), ['create', 'update', 'deduct', 'remove', 'history']);
  // PATCH bat checkHeld: trang VT cung khong ha ghi chu duoi phan don Dang boc dang giu.
  assert.deepEqual(calls[1].slice(1), [7, { version: 2, notes: '1T x 5' }, { checkHeld: true }]);
  assert.deepEqual(calls[3].slice(1), [7, 3]);
});

test('Lỗi giữ chỗ trả kèm mã đơn (orders) + tổng giữ (held) trong body', async t => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = MANAGER; next(); });
  const failWith = Object.assign(new Error('Đơn DH1 đang giữ 150 tại vị trí này, không hạ dưới 150.'), { statusCode: 409, code: 'BELOW_HELD', orders: ['DH1'], held: 150 });
  app.use(createStockPositionsRouter({
    requireAuth: (req, res, next) => next(),
    resolveBranch: (req, res, next) => { req.branch = 'Cả hai'; next(); },
    service: { update: async () => { throw failWith; } }
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/stock-positions/7`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, notes: '1T x 100' }) });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: failWith.message, code: 'BELOW_HELD', orders: ['DH1'], held: 150 });
});

test('Import: nhận file multipart, chặn sai đuôi file, truyền chế độ + commit', async t => {
  const { base, calls } = await start(t);
  const form = name => { const f = new FormData(); f.append('file', new Blob(['abc']), name); return f; };
  assert.equal((await fetch(base + '/import?branch=SG&mode=add&commit=1', { method: 'POST', body: form('vt.xlsx') })).status, 200);
  assert.deepEqual(calls[0], ['importFile', 'SG', 'add', true, 'vt.xlsx', 3]);
  assert.equal((await fetch(base + '/import?branch=SG&mode=add', { method: 'POST', body: form('vt.pdf') })).status, 400);
  const none = await fetch(base + '/import?branch=SG&mode=add', { method: 'POST', body: new FormData() });
  assert.equal(none.status, 400);
  assert.equal((await none.json()).code, 'IMPORT_FILE_REQUIRED');
});

test('Xuất kho: Quản lý nhận file multipart, chặn sai đuôi/thiếu file, truyền cơ sở + phạm vi; vai trò không có quyền sửa bị 403', async t => {
  const { base, calls } = await start(t, { scope: 'Sài Gòn' });
  const form = name => { const f = new FormData(); f.append('file', new Blob(['abc']), name); return f; };
  const ok = await fetch(base + '/stock-out?branch=SG', { method: 'POST', body: form('xuat.xlsx') });
  assert.equal(ok.status, 200);
  assert.deepEqual(calls, [['stockOutFile', 'SG', 'xuat.xlsx', 3, ['SG']]]);
  const bad = await fetch(base + '/stock-out?branch=SG', { method: 'POST', body: form('xuat.pdf') });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'IMPORT_BAD_EXTENSION');
  const none = await fetch(base + '/stock-out?branch=SG', { method: 'POST', body: new FormData() });
  assert.equal(none.status, 400);
  assert.equal((await none.json()).code, 'IMPORT_FILE_REQUIRED');
  assert.equal(calls.length, 1);
  const viewer = await start(t, { user: { vaiTro: 'Nhân viên kho' } });
  assert.equal((await fetch(viewer.base + '/stock-out?branch=HN', { method: 'POST', body: form('xuat.xlsx') })).status, 403);
  assert.deepEqual(viewer.calls, []);
});

test('Import review: malformed JSON is rejected and edited rows reach the service', async t => {
  const { base, calls } = await start(t);
  const form = rows => { const value = new FormData(); value.append('file', new Blob(['abc']), 'vt.csv'); value.append('rows', rows); return value; };
  for (const invalid of ['{', 'null', '{}', '42']) {
    const response = await fetch(base + '/import?branch=HN&mode=replace&commit=1', { method: 'POST', body: form(invalid) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'IMPORT_INVALID_ROWS');
  }
  assert.deepEqual(calls, []);
  const rows = [{ row: 7, code: 'AAA1', notes: '3T x 100', arrivalDate: '29/10', location: 'B1' }];
  const response = await fetch(base + '/import?branch=HN&mode=replace&commit=1', { method: 'POST', body: form(JSON.stringify(rows)) });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [['importFile', 'HN', 'replace', true, 'vt.csv', 3, rows]]);
});

test('Xuất Excel: đủ 10 cột dữ liệu (gồm Có thể bốc), tên file theo cơ sở, chặn công thức, giờ VN', async t => {
  const { base } = await start(t);
  const res = await fetch(base + '/export?branch=HN');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="vt_hn_\d{8}_\d{4}\.xlsx"/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = workbook.getWorksheet('VT Hà Nội');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Mã hàng', 'Tên hàng', 'SL kho', 'Có thể bốc', 'SL Kiot', 'Ghi chú số thùng', 'Ngày về', 'Vị trí', 'Người cập nhật', 'TG cập nhật']);
  assert.deepEqual(sheet.getRow(2).values.slice(1, 9), ['AAA1', 'Hàng A', 300, 180, 42, '3T x 100', '4/10', 'H1']);
  assert.equal(sheet.getRow(2).getCell(10).value.toISOString(), '2026-10-27T10:00:00.000Z'); // 03:00 UTC = 10:00 giờ VN
  assert.equal(sheet.getRow(3).getCell(2).value, "'=SUM(A1)");
  assert.equal(sheet.getRow(3).getCell(3).value, null);
  assert.equal(sheet.getRow(3).getCell(4).value, null); // Có thể bốc trống khi ghi chú không đọc được
});

test('Xuất Excel lịch sử: truyền bộ lọc + phạm vi, 9 cột, nhãn tiếng Việt, giờ VN, chặn công thức', async t => {
  const { base, calls } = await start(t, { scope: 'Hà Nội' });
  const res = await fetch(base + '/history/export?branch=HN&action=edit&q=th%E1%BA%AFng');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="vt_hn_lich-su_\d{8}_\d{4}\.xlsx"/);
  assert.equal(res.headers.get('x-history-truncated'), 'false');
  assert.deepEqual(calls[0], ['historyAll', 'HN', { action: 'edit', q: 'thắng' }, ['HN']]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = workbook.getWorksheet('Lịch sử VT Hà Nội');
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Thời gian', 'Người thực hiện', 'Hành động', 'Mã hàng', 'Vị trí', 'Trường', 'Giá trị cũ', 'Giá trị mới', 'Tóm tắt']);
  assert.equal(sheet.getRow(2).getCell(1).value.toISOString(), '2026-10-27T10:44:00.000Z'); // 03:44 UTC = 10:44 giờ VN
  assert.deepEqual(sheet.getRow(2).values.slice(2, 8), ['Nguyễn Ngọc Việt Thắng', 'Sửa', 'CKL2DBV', 'ST', 'Ghi chú', '41T x 250']);
  assert.equal(sheet.getRow(2).getCell(8).value, "'=40T x 250");
  assert.equal(sheet.getRow(3).getCell(3).value, 'Import bổ sung');
  assert.equal(sheet.getRow(3).getCell(9).value, 'Thêm 3 · a.xlsx');
});

test('Đã sửa + xóa lịch sử: chuyển tham số, route history không bị /:id nuốt, canDeleteHistory theo quyền', async t => {
  const { base, calls } = await start(t);
  const json = { 'Content-Type': 'application/json' };
  const list = await (await fetch(base + '?branch=HN')).json();
  assert.equal(list.canDeleteHistory, true);
  assert.equal((await fetch(base + '/7/ack', { method: 'POST', headers: json, body: JSON.stringify({ version: 2, acknowledged: true }) })).status, 200);
  assert.equal((await fetch(base + '/history?branch=SG&from=2026-10-01&to=2026-10-05', { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(base + '/history?branch=HN', { method: 'DELETE' })).status, 200);
  assert.deepEqual(calls.map(c => c[0]), ['list', 'acknowledge', 'purgeHistory', 'purgeHistory']);
  assert.deepEqual(calls[1].slice(1), [7, { version: 2, acknowledged: true }]);
  assert.deepEqual(calls[2].slice(1), ['SG', { from: '2026-10-01', to: '2026-10-05' }]);
  assert.deepEqual(calls[3].slice(1), ['HN', { from: undefined, to: undefined }]);
});

test('Quyền: chỉ sửa được Đã sửa khi có edit; chỉ xóa lịch sử khi có historyDelete', async t => {
  const editor = { vaiTro: 'Nhân viên kho', featurePermissions: { 'stockLocationsV2.view': true, 'stockLocationsV2.edit': true } };
  const { base, calls } = await start(t, { user: editor });
  const json = { 'Content-Type': 'application/json' };
  assert.equal((await (await fetch(base + '?branch=HN')).json()).canDeleteHistory, false);
  assert.equal((await fetch(base + '/7/ack', { method: 'POST', headers: json, body: JSON.stringify({ version: 1, acknowledged: true }) })).status, 200);
  assert.equal((await fetch(base + '/history?branch=HN', { method: 'DELETE' })).status, 403);
  const viewer = await start(t, { user: { vaiTro: 'Nhân viên kho', featurePermissions: { 'stockLocationsV2.view': true } } });
  assert.equal((await fetch(viewer.base + '/7/ack', { method: 'POST', headers: json, body: '{}' })).status, 403);
  const granted = await start(t, { user: { vaiTro: 'Nhân viên kho', featurePermissions: { 'stockLocationsV2.view': true, 'stockLocationsV2.historyDelete': true } } });
  assert.equal((await fetch(granted.base + '/history?branch=HN', { method: 'DELETE' })).status, 200);
  assert.deepEqual(calls.map(c => c[0]), ['list', 'acknowledge']);
});

async function readUntil(reader, text) {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

test('GET /events: mở SSE, chỉ nhận tín hiệu đúng cơ sở, dọn listener khi đóng', async t => {
  const events = new EventEmitter();
  const { base } = await start(t, { events });
  const res = await fetch(base + '/events?branch=HN');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const reader = res.body.getReader();
  await readUntil(reader, ':ok');
  assert.equal(events.listenerCount(CHANGED), 1);
  events.emit(CHANGED, { branch: 'SG' });
  events.emit(CHANGED, { branch: 'HN' });
  const chunk = await readUntil(reader, 'positions-changed');
  assert.match(chunk, /event: positions-changed\ndata: \{"branch":"HN"\}\n\n/);
  assert.ok(!chunk.includes('SG'));
  await reader.cancel();
  for (let i = 0; i < 20 && events.listenerCount(CHANGED) > 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.listenerCount(CHANGED), 0);
});

test('GET /events: ngoài phạm vi cơ sở 403, thiếu quyền 403, chưa đăng nhập 401, cơ sở lạ 403', async t => {
  const events = new EventEmitter();
  const sg = await start(t, { scope: 'Sài Gòn', events });
  const forbidden = await fetch(sg.base + '/events?branch=HN');
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, 'BRANCH_FORBIDDEN');
  assert.equal((await fetch(sg.base + '/events?branch=XX')).status, 403);
  assert.equal((await fetch((await start(t, { user: { vaiTro: 'Nhân viên kho', featurePermissions: { 'stockLocationsV2.view': false } }, events })).base + '/events?branch=HN')).status, 403);
  assert.equal((await fetch((await start(t, { user: null, events })).base + '/events?branch=HN')).status, 401);
  assert.equal(events.listenerCount(CHANGED), 0);
});
