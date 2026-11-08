'use strict';
process.env.JWT_SECRET ||= 'test-secret';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ExcelJS = require('exceljs');
const { createStockPositionsRouter } = require('./stockPositionsRoutes');

const MANAGER = { id: 'ql', vaiTro: 'Quản lý' };
const ORDER = {
  id: 7, branch: 'HN', code: 'XK-HN-00007', status: 'confirmed', lines: [
    { id: 1, code: 'VAS', name: 'Vas nam', location: 'CONT', notes: '5T x 100', quantity: 500, createdByName: 'An', updatedAt: '2026-11-08T03:00:00.000Z', result: { before: '3T x 100', after: '-2T x 100', negative: true } },
    { id: 2, code: 'ABC', name: '=HYPERLINK("x")', location: 'A1', notes: '1T x 10', quantity: 10, createdByName: 'An', updatedAt: '2026-11-08T03:00:00.000Z', result: { created: true, after: '-1T x 10', negative: true } }
  ]
};

async function start(t, { user = MANAGER, scope = 'Cả hai' } = {}) {
  const calls = [];
  const record = name => async (ctx, ...args) => { calls.push([name, ...args]); return { ok: name }; };
  const ordersService = {
    getCurrent: async (ctx, branch, options) => { calls.push(['getCurrent', branch, options, ctx.scope]); return { order: null }; },
    addLine: record('addLine'), updateLine: record('updateLine'), removeLine: record('removeLine'), confirm: record('confirm'), list: record('list'),
    get: async (ctx, id) => { calls.push(['get', id]); return { order: ORDER }; },
    events: async (ctx, id, options) => { calls.push(['events', id, options.limit]); return { events: [] }; },
    importLines: async (ctx, id, options) => { calls.push(['importLines', id, options.fileName, options.buffer.length]); return { counts: {} }; }
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { if (user) req.user = user; next(); });
  app.use(createStockPositionsRouter({
    requireAuth: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập.' })),
    resolveBranch: (req, res, next) => { req.branch = scope; next(); },
    service: {}, ordersService
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  return { calls, base: `http://127.0.0.1:${server.address().port}/api/stock-positions/stock-out-orders` };
}

const send = (url, method, body) => fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

test('Quản lý: đọc đơn tạm (được tạo), thêm/sửa/xóa dòng, chốt đều gọi service đúng tham số', async t => {
  const { base, calls } = await start(t, { scope: 'Hà Nội' });
  const current = await (await fetch(base + '/current?branch=HN')).json();
  assert.equal(current.canEdit, true);
  assert.deepEqual(calls[0], ['getCurrent', 'HN', { create: true }, ['HN']]);
  assert.equal((await send(base + '/7/lines', 'POST', { code: 'A', location: 'A1', notes: '1T x 5' })).status, 201);
  assert.equal((await send(base + '/lines/9', 'PATCH', { notes: '2T x 5', version: 1 })).status, 200);
  assert.equal((await send(base + '/lines/9?version=2', 'DELETE')).status, 200);
  assert.equal((await send(base + '/7/confirm', 'POST', { version: 4 })).status, 200);
  assert.deepEqual(calls.slice(1).map(call => call[0]), ['addLine', 'updateLine', 'removeLine', 'confirm']);
  assert.deepEqual(calls.at(-1), ['confirm', 7, { version: 4 }]);
  assert.deepEqual(calls[3], ['removeLine', 9, 2]);
  assert.equal((await fetch(base + '?branch=HN')).status, 200);
  assert.equal((await fetch(base + '/7')).status, 200);
});

test('Lưu vết đơn: GET /:id/events gọi service với id và limit', async t => {
  const { base, calls } = await start(t, { scope: 'Hà Nội' });
  assert.equal((await fetch(base + '/7/events?limit=20')).status, 200);
  assert.deepEqual(calls[0], ['events', 7, '20']);
});

test('Xuất Excel đơn: trả file xlsx đúng dòng, chặn công thức, cần quyền export', async t => {
  const { base, calls } = await start(t, { scope: 'Hà Nội' });
  const response = await fetch(base + '/7/export');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /don-xuat-kho_xk-hn-00007_\d{8}_\d{4}\.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.rowCount, 3);
  const header = sheet.getRow(1).values.slice(1);
  assert.deepEqual(header.slice(0, 11), ['Mã đơn', 'Trạng thái', '#', 'Mã hàng', 'Tên hàng', 'Vị trí', 'Ghi chú thùng', 'SL xuất', 'Tồn VT trước', 'Sau khi chốt', 'Ghi chú']);
  assert.deepEqual(sheet.getRow(2).values.slice(1, 12), ['XK-HN-00007', 'Đã chốt', 1, 'VAS', 'Vas nam', 'CONT', '5T x 100', 500, '3T x 100', '-2T x 100', 'Số lượng âm']);
  assert.equal(sheet.getRow(3).getCell(5).value, "'=HYPERLINK(\"x\")");
  assert.equal(sheet.getRow(3).getCell(9).value, 'Chưa có dòng VT');
  assert.deepEqual(calls[0], ['get', 7]);
  const detail = await (await fetch(base + '/7')).json();
  assert.equal(detail.canExport, true);
});

test('Xuất Excel đơn: Khách (mặc định có quyền xuất VT) tải được, canExport = true', async t => {
  const { base } = await start(t, { user: { vaiTro: 'Khách' } });
  assert.equal((await (await fetch(base + '/7')).json()).canExport, true);
  assert.equal((await fetch(base + '/7/export')).status, 200);
});

test('Khách chỉ xem: đọc được đơn (không tạo), mọi thao tác ghi bị 403', async t => {
  const { base, calls } = await start(t, { user: { vaiTro: 'Khách' } });
  const current = await (await fetch(base + '/current?branch=HN')).json();
  assert.equal(current.canEdit, false);
  assert.deepEqual(calls[0].slice(0, 3), ['getCurrent', 'HN', { create: false }]);
  for (const [method, url, body] of [['POST', '/7/lines', {}], ['PATCH', '/lines/9', {}], ['DELETE', '/lines/9', undefined], ['POST', '/7/confirm', {}]]) {
    assert.equal((await send(base + url, method, body)).status, 403, method + ' ' + url);
  }
  assert.equal(calls.length, 1, 'không gọi service ghi');
});

test('Chưa đăng nhập 401', async t => {
  const { base } = await start(t, { user: null });
  assert.equal((await fetch(base + '/current?branch=HN')).status, 401);
});
