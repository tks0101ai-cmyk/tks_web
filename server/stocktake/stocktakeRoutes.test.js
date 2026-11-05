'use strict';
process.env.JWT_SECRET ||= 'test-secret';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const ExcelJS = require('exceljs');
const { EventEmitter } = require('node:events');
const { createStocktakeRouter } = require('./stocktakeRoutes');
const { boardColumnHeaders } = require('./stocktakeExport');
const { CHANGED } = require('./stocktakeEvents');

const MANAGER = { id: 'ql', vaiTro: 'Quản lý' };
// Thang/Quan/Hung: vai tro kho, duoc Quan ly cap xem + sua (khong cap dong dot).
const STOCK_MANAGER = { id: 'hung', vaiTro: 'Nhân viên kho', featurePermissions: { 'stocktake.view': true, 'stocktake.edit': true } };
const SESSION = { id: 7, branch: 'hanoi', name: 'Đợt 29/10', status: 'open', version: 1 };
const ROWS = [
  { code: 'AAA1', name: 'Hàng A', counted: 12, stock: 10, cost: 1000, diffQty: 2, diffValue: 2000, cluster: '', clusterDiff: null, isCombo: false, prevDiff: null, prevRatio: 2.3313, forgotten: false, note: { recheckEmployeeId: 501, statusText: 'ok', reasonText: '=lẫn' } },
  { code: 'BBB2', name: 'Hàng B', counted: 0, stock: 5, cost: 200, diffQty: -5, diffValue: -1000, cluster: '', clusterDiff: null, isCombo: true, prevDiff: -1, forgotten: true, note: null }
];

async function start(t, { user = MANAGER, scope = 'Cả hai', events, fail } = {}) {
  const calls = [];
  const contexts = [];
  const record = name => async (ctx, ...args) => {
    calls.push([name, ...args, ctx.scope]);
    contexts.push(ctx);
    if (fail) throw fail;
    return { ok: name };
  };
  const service = {
    listSessions: async (ctx, options = {}) => {
      calls.push(['listSessions', ctx.scope, ...(options.includeCancelled ? ['includeCancelled'] : [])]);
      return { sessions: [SESSION] };
    },
    getBoard: async (ctx, id) => { calls.push(['getBoard', id, ctx.scope]); return { session: SESSION, rows: ROWS, employees: [{ id: 501, name: 'Cảnh' }] }; },
    createSession: record('createSession'), saveLine: record('saveLine'), addLine: record('addLine'), saveNote: record('saveNote'),
    saveTag: record('saveTag'), updateSession: record('updateSession'), saveCells: record('saveCells'), codeHistory: record('codeHistory'), closeSession: record('closeSession'),
    cancelSession: record('cancelSession'), restoreSession: record('restoreSession'), dependents: record('dependents'), getOrderStatus: record('getOrderStatus')
  };
  const app = express();
  app.use((req, res, next) => { if (user) req.user = user; next(); });
  app.use(createStocktakeRouter({
    requireAuth: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập.' })),
    resolveBranch: (req, res, next) => { req.branch = scope; next(); },
    service,
    sheetImport: { importSheet: record('importSheet'), reloadSheet: record('reloadSheet') },
    ...(events ? { events } : {})
  }));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => server.close());
  return { calls, contexts, base: `http://127.0.0.1:${server.address().port}/api/stocktake` };
}

const json = body => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('Quan ly: xem, sua, dong dot; pham vi co so tu cookie', async t => {
  const { base, calls } = await start(t, { scope: 'Hà Nội' });
  const list = await fetch(base + '/sessions');
  assert.equal(list.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await list.json(), { sessions: [SESSION], canEdit: true, canClose: true });
  assert.deepEqual(calls[0], ['listSessions', ['hanoi']]);
  assert.equal((await fetch(base + '/sessions', { method: 'POST', ...json({ name: 'x' }) })).status, 201);
  assert.equal((await fetch(base + '/sessions/7/lines', { method: 'PATCH', ...json({ orderId: 1, lineNo: 1, quantity: 3, version: null }) })).status, 200);
  assert.equal((await fetch(base + '/sessions/7/lines', { method: 'POST', ...json({ productCode: 'A', quantity: 1 }) })).status, 201);
  assert.equal((await fetch(base + '/sessions/7/codes/AAA1/note', { method: 'PUT', ...json({ statusText: 'ok' }) })).status, 200);
  assert.equal((await fetch(base + '/sessions/7/codes/AAA1/tag', { method: 'PUT', ...json({ cluster: 'C' }) })).status, 200);
  assert.equal((await fetch(base + '/sessions/7', { method: 'PATCH', ...json({ counterpartSessionId: 9, version: 1 }) })).status, 200);
  assert.equal((await fetch(base + '/sessions/7/cells', { method: 'POST', ...json({ cells: [] }) })).status, 200);
  assert.equal((await fetch(base + '/sessions/7/paste', { method: 'POST', ...json({ column: 'statusText', rows: [] }) })).status, 404);
  assert.equal((await fetch(base + '/sessions/7/close', { method: 'POST', ...json({ version: 1 }) })).status, 200);
  assert.equal((await fetch(base + '/import-sheet', { method: 'POST', ...json({}) })).status, 201);
  assert.deepEqual(calls.slice(1).map(c => c.slice(0, 2)), [
    ['createSession', { name: 'x' }], ['saveLine', 7], ['addLine', 7], ['saveNote', 7], ['saveTag', 7], ['updateSession', 7], ['saveCells', 7], ['closeSession', 7], ['importSheet', {}]
  ]);
});

test('Quan ly kiem kho duoc cap xem + sua: khong dong dot duoc', async t => {
  const { base, calls } = await start(t, { user: STOCK_MANAGER });
  const board = await (await fetch(base + '/sessions/7/board')).json();
  assert.deepEqual([board.canEdit, board.canClose], [true, false]);
  assert.equal((await fetch(base + '/sessions/7/codes/AAA1/note', { method: 'PUT', ...json({ statusText: 'ok' }) })).status, 200);
  assert.equal((await fetch(base + '/sessions/7/close', { method: 'POST', ...json({ version: 1 }) })).status, 403);
  assert.equal((await fetch(base + '/import-sheet', { method: 'POST', ...json({}) })).status, 403);
  assert.ok(!calls.some(c => c[0] === 'closeSession' || c[0] === 'importSheet'));
});

test('Khong co quyen sua: khong sua o, khong doi dot doi chieu', async t => {
  const viewer = { id: 'v', vaiTro: 'Nhân viên kho', featurePermissions: { 'stocktake.view': true } };
  const { base, calls } = await start(t, { user: viewer });
  assert.equal((await fetch(base + '/sessions/7/cells', { method: 'POST', ...json({ cells: [] }) })).status, 403);
  assert.equal((await fetch(base + '/sessions/7', { method: 'PATCH', ...json({ counterpartSessionId: 9 }) })).status, 403);
  assert.ok(!calls.some(c => c[0] === 'updateSession' || c[0] === 'saveCells'));
});

test('Mac dinh vai tro khac khong xem duoc; Khach duoc ghi de van bi chan; chua dang nhap 401', async t => {
  assert.equal((await fetch((await start(t, { user: null })).base + '/sessions')).status, 401);
  for (const user of [{ vaiTro: 'Nhân viên kho' }, { vaiTro: 'Trợ lý' }, { vaiTro: 'Khách', featurePermissions: { 'stocktake.view': true, 'stocktake.edit': true } }]) {
    const { base, calls } = await start(t, { user });
    assert.equal((await fetch(base + '/sessions')).status, 403, user.vaiTro);
    assert.equal((await fetch(base + '/sessions/7/codes/A/note', { method: 'PUT', ...json({}) })).status, 403, user.vaiTro);
    assert.deepEqual(calls, []);
  }
  const viewOnly = await start(t, { user: { vaiTro: 'Nhân viên kho', featurePermissions: { 'stocktake.view': true } } });
  assert.equal((await fetch(viewOnly.base + '/sessions/7/board')).status, 200);
  assert.equal((await fetch(viewOnly.base + '/sessions/7/lines', { method: 'POST', ...json({}) })).status, 403);
});

test('ma trinh duyet tu header X-Stocktake-Client vao ctx (loc ky tu la, toi da 64)', async t => {
  const { base, contexts } = await start(t);
  await fetch(base + '/sessions/7/cells', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Stocktake-Client': 'tab-1<script>' + 'x'.repeat(80) }, body: '{}' });
  assert.equal(contexts.at(-1).clientId, ('tab-1script' + 'x'.repeat(80)).slice(0, 64));
  await fetch(base + '/sessions/7/cells', { method: 'POST', ...json({}) });
  assert.equal(contexts.at(-1).clientId, '', 'khong gui header -> rong');
});

test('409 tra kem latest; loi may chu khong lo chi tiet', async t => {
  const latest = { version: 2, updatedByName: 'Hưng' };
  const conflict = Object.assign(new Error('Hưng vừa sửa lúc 10:42. Xem bản mới rồi lưu lại.'), { statusCode: 409, code: 'STOCKTAKE_CONFLICT', latest });
  const { base } = await start(t, { fail: conflict });
  const res = await fetch(base + '/sessions/7/codes/AAA1/note', { method: 'PUT', ...json({ version: 1 }) });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: conflict.message, code: 'STOCKTAKE_CONFLICT', latest });

  const boom = await start(t, { fail: new Error('db password leaked') });
  const err = await fetch(boom.base + '/sessions/7/lines', { method: 'POST', ...json({}) });
  assert.equal(err.status, 500);
  assert.equal((await err.json()).code, 'STOCKTAKE_FAILED');
});

test('Xuat Excel: ca bang hoac chi ma dang loc; chan cong thuc', async t => {
  const { base } = await start(t);
  const res = await fetch(base + '/sessions/7/export', { method: 'POST', ...json({ codes: ['BBB2'] }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /kiem-ke-Dot-29-10\.xlsx/u);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await res.arrayBuffer()));
  const sheet = workbook.getWorksheet('Kiểm kê');
  assert.equal(sheet.rowCount, 2);
  assert.equal(sheet.getRow(2).getCell(1).value, 'BBB2');

  const all = new ExcelJS.Workbook();
  await all.xlsx.load(Buffer.from(await (await fetch(base + '/sessions/7/export')).arrayBuffer()));
  const rows = all.getWorksheet('Kiểm kê');
  assert.equal(rows.rowCount, 3);
  assert.deepEqual(rows.getRow(1).values.slice(1), boardColumnHeaders('hanoi'));
  assert.equal(boardColumnHeaders('hanoi')[12], 'Kiểm SG');
  assert.equal(boardColumnHeaders('saigon')[12], 'Kiểm HN');
  assert.equal(boardColumnHeaders('saigon')[18], 'Do kiểm HN');
  assert.equal(boardColumnHeaders('hanoi').length, 23);
  assert.equal(rows.getRow(2).getCell(11).value, 'Cảnh');
  assert.equal(rows.getRow(2).getCell(8).value, "'=lẫn");
  assert.ok(!boardColumnHeaders('hanoi').includes('Vị trí kho gần nhất'));
  assert.equal(rows.getRow(2).getCell(22).value, 1000, 'cot 22 nay la Gia von');
  assert.equal(rows.getRow(2).getCell(7).fill.fgColor.argb, 'FFEEFF41', 'o Trang thai to theo loai (ok -> OK, vang neon)');
  const plain = rows.getRow(3).getCell(7).fill;
  assert.ok(!plain || plain.pattern !== 'solid', 'khong co trang thai -> khong to');
  assert.equal(rows.getRow(2).getCell(17).numFmt, '0%');
  assert.equal((await fetch(base + '/sessions/7/export', { method: 'POST', ...json({}) })).status, 400);
});

test('SSE: chi bao dot dang xem; dot khong thuoc pham vi 404', async t => {
  const events = new EventEmitter();
  const { base } = await start(t, { events });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const res = await fetch(base + '/sessions/7/events', { signal: controller.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  events.emit(CHANGED, { sessionId: 8 });
  events.emit(CHANGED, { sessionId: 7, by: 'tab-1' });
  while (!text.includes('stocktake-changed')) text += decoder.decode((await reader.read()).value);
  assert.ok(text.includes('data: {"sessionId":7,"by":"tab-1"}'), 'kem ma trinh duyet vua ghi');
  assert.ok(!text.includes('"sessionId":8'));

  assert.equal((await fetch(base + '/sessions/99/events')).status, 404);
});

test('Huy / khoi phuc / dot phu thuoc / nap lai sheet: chi Quan ly; xem dot da huy chi Quan ly', async t => {
  const manager = await start(t);
  assert.equal((await fetch(manager.base + '/sessions/7/cancel', { method: 'POST', ...json({ version: 1, reason: 'Sai' }) })).status, 200);
  assert.equal((await fetch(manager.base + '/sessions/7/restore', { method: 'POST', ...json({ version: 2 }) })).status, 200);
  assert.equal((await fetch(manager.base + '/sessions/7/dependents')).status, 200);
  assert.equal((await fetch(manager.base + '/sessions/7/reload-sheet', { method: 'POST', ...json({ version: 1, dryRun: true }) })).status, 200);
  await fetch(manager.base + '/sessions?includeCancelled=1');
  assert.deepEqual(manager.calls.map(c => c.slice(0, 3)), [
    ['cancelSession', 7, { version: 1, reason: 'Sai' }], ['restoreSession', 7, { version: 2 }], ['dependents', 7, ['hanoi', 'saigon']],
    ['reloadSheet', 7, { version: 1, dryRun: true }], ['listSessions', ['hanoi', 'saigon'], 'includeCancelled']
  ]);

  const stock = await start(t, { user: STOCK_MANAGER });
  for (const [path, method] of [['/sessions/7/cancel', 'POST'], ['/sessions/7/restore', 'POST'], ['/sessions/7/dependents', 'GET'], ['/sessions/7/reload-sheet', 'POST']]) {
    const res = await fetch(stock.base + path, method === 'GET' ? {} : { method, ...json({}) });
    assert.equal(res.status, 403, path);
  }
  await fetch(stock.base + '/sessions?includeCancelled=1');
  assert.deepEqual(stock.calls, [['listSessions', ['hanoi', 'saigon']]], 'khong phai Quan ly: bo qua includeCancelled');
});

test('order-status: nguoi chi co quyen xem goi duoc', async t => {
  const viewer = { id: 'v', vaiTro: 'Nhân viên kho', featurePermissions: { 'stocktake.view': true } };
  const { base, calls } = await start(t, { user: viewer });
  assert.equal((await fetch(base + '/sessions/7/order-status')).status, 200);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['getOrderStatus', 7]);
});
