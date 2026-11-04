'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { parseT10, parseSg, compareSnapshot, createStocktakeSheetImport, T10_SOURCE, SOURCES } = require('./stocktakeSheetImport');
const { createStockTakeService } = require('./stocktakeService');

const MIGRATIONS = path.join(__dirname, '../db/migrations');
const migration = file => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
const poolFor = db => {
  const query = (sql, params) => db.query(sql, params);
  return { query, connect: async () => ({ query, release() {} }) };
};

async function migrated() {
  const db = new PGlite();
  for (const file of ['0001_core_master_data.sql', '0003_orders.sql', '0009_app_users_hr_employees.sql', '0041_hr_employee_status.sql',
    '0064_sheet_snapshots.sql', '0095_stock_positions.sql', '0099_stock_position_ack_and_history_purge.sql',
    '0101_stock_position_stock_out_action.sql', '0105_stocktake.sql', '0106_stocktake_previous_cancel.sql']) {
    await db.exec(migration(file));
  }
  return db;
}

// Giong tab that: dong 1 tieu de, dong 2 tong, du lieu tu dong 3; cot Trang in / Gio in / Count bi bo qua.
const HEADER = ['Mã SP', 'Tên hàng', 'TỔNG KIỂM', 'Tồn KIOT', 'SL Chênh', 'Giá trị chênh', 'Trạng thái', 'Chi tiết lý do', 'Trang in', 'Giờ in',
  'Người kiểm lại', 'KK Trước Sai', 'Kiểm SG', 'Cụm SP', 'Count', 'Tổng chênh theo CỤM', 'Do KK trước', 'Lẫn + KK trước', 'Do kiểm SG',
  'Quên KK', 'Combo', 'Vị trí kho gần nhất', 'Giá vốn'];
const row = (code, counted, stock, diff, extra = {}) => {
  const cells = Array(HEADER.length).fill('');
  Object.assign(cells, { 0: code, 1: 'Tên ' + code, 2: counted, 3: stock, 4: diff, 5: diff * 100, 22: 100 });
  for (const [index, value] of Object.entries(extra)) cells[index] = value;
  return cells;
};
const VALUES = [
  HEADER,
  ['', '', '', '', '', '-242,996,968'],
  row('lumi3m', 51, 485, -434, { 6: 'mất ko thấy', 7: 'MẤT- CHỜ TÌM SG', 8: '3', 9: '14:30', 10: 'cảnh', 11: -326, 13: 'Tủ LUMI3' }),
  row('LUMI3T', 10, 5, 45, { 13: 'tủ lumi3', 20: 'x' }), // SL chenh da sua tay, khong bang counted - stock
  row('SOLO', '1,000', '1,000', 0, { 13: 'Cụm một mã' }),
  row('LUMI3M', 1, 1, 0) // ma lap lai: giu dong dau
];

test('parseT10: doc theo ten cot, bo dong tong / ma lap, cum 1 ma bi bo', () => {
  const { rows } = parseT10(VALUES);
  assert.deepEqual(rows.map(r => r.code), ['LUMI3M', 'LUMI3T', 'SOLO']);
  assert.equal(rows[0].diffQty, -434);
  assert.equal(rows[0].diffValue, -43400);
  assert.equal(rows[0].cost, 100);
  assert.equal(rows[0].recheck, 'cảnh');
  assert.equal(rows[1].diffQty, 45);
  assert.equal(rows[1].isCombo, true);
  assert.equal(rows[0].cluster, 'Tủ LUMI3');
  assert.equal(rows[2].cluster, '');
  assert.equal(rows[2].counted, 1000);
  assert.throws(() => parseT10([['Mã SP', 'Tên hàng']]), { code: 'SHEET_FORMAT' });
  assert.deepEqual([rows[0].prevDiff, rows[0].printPage, rows[0].printTime], [-326, '3', '14:30']);
  assert.equal(rows[1].prevDiff, null, 'o L trong');
});

test('importT10: tao dot da dong, ghi chu + nguoi kiem lai, tag khong de tag san co, khong nap lai', async () => {
  const db = await migrated();
  await db.exec(`INSERT INTO hr_employees (id, branch, ho_ten) VALUES (501, 'hanoi', 'Cảnh');
                 INSERT INTO stocktake_product_tags (branch, product_code, cluster) VALUES ('hanoi', 'LUMI3T', 'Cụm trên web');`);
  const reads = [];
  const importer = createStocktakeSheetImport({
    getDb: () => poolFor(db), announce: () => {},
    readValues: async (source, options) => { reads.push([source, options]); return VALUES; }
  });
  const ctx = { user: { id: 'ql', hoTen: 'Quản Lý A' }, scope: ['hanoi', 'saigon'] };
  const result = await importer.importT10(ctx, {});
  assert.deepEqual(reads, [[T10_SOURCE, { valueRenderOption: 'UNFORMATTED_VALUE' }]]);
  assert.deepEqual({ codes: result.codes, mismatched: result.mismatched, notes: result.notes, tags: result.tags }, { codes: 3, mismatched: 2, notes: 1, tags: 1 });

  const service = createStockTakeService({ getDb: () => poolFor(db), announce: () => {} });
  const board = await service.getBoard(ctx, result.sessionId);
  assert.equal(board.session.status, 'closed');
  assert.equal(board.session.dateTo, '2026-10-03');
  const lumi = board.rows.find(r => r.code === 'LUMI3M');
  assert.equal(lumi.note.recheckEmployeeId, 501);
  assert.equal(lumi.note.recheckName, 'cảnh');
  assert.equal(lumi.note.reasonText, 'MẤT- CHỜ TÌM SG');
  assert.equal(board.rows.find(r => r.code === 'LUMI3T').cluster, 'Cụm trên web');

  await assert.rejects(importer.importT10(ctx, {}), { statusCode: 409, code: 'ALREADY_IMPORTED' });
  await assert.rejects(importer.importT10({ ...ctx, scope: ['saigon'] }, {}), { statusCode: 403 });

  const { session: next } = await service.createSession(ctx, { branch: 'hanoi', name: 'Đợt 29/10', dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  const nextBoard = await service.getBoard(ctx, next.id);
  assert.equal(nextBoard.previousSessionId, result.sessionId);
});

const SG_HEADER = ['Mã SP', 'Tên hàng', 'Giá vốn', 'Team 1: Kim Muội + a Hùng', 'Team Lỗi', 'TỔNG KIỂM', 'Tồn KIOT', 'SL Chênh', 'Giá trị chênh',
  'Chắc chắn thừa', 'KK trước sai', 'Lý do', 'Lý do sơ bộ', 'Trang in'];
const SG_VALUES = [
  SG_HEADER,
  ['', '', '', '', '', '', '', '', '-9,085,583'],
  ['TYC20C', 'Củ sạc', 15092, 0, 900, 900, 1900, -1000, -15092000, '', 1900, 'LẪN CÁC LOẠI SẠC VỚI NHAU ', '', ' '],
  ['LUMI3M', 'Tủ', 100, 0, 0, 93, 141, -48, -4800, 'a Chương', 1, 'Check lại ô số 10', 'Thiếu', '7']
];

test('parseSg: doc theo tieu de KIEM SG, Ly do so bo -> trang thai, Chac chan thua -> nguoi kiem lai', () => {
  const { rows } = parseSg(SG_VALUES);
  assert.deepEqual(rows.map(r => r.code), ['TYC20C', 'LUMI3M']);
  const lumi = rows[1];
  assert.deepEqual([lumi.counted, lumi.stock, lumi.diffQty, lumi.diffValue, lumi.cost, lumi.prevDiff], [93, 141, -48, -4800, 100, 1]);
  assert.deepEqual([lumi.statusText, lumi.reasonText, lumi.recheck, lumi.printPage], ['Thiếu', 'Check lại ô số 10', 'a Chương', '7']);
  assert.equal(rows[0].reasonText, 'LẪN CÁC LOẠI SẠC VỚI NHAU');
  assert.equal(rows[0].printPage, '');
});

test('importSheet sg + t10: hai dot dong, noi doi chieu cheo, Kiem SG cua T10 = SL chenh SG', async () => {
  const db = await migrated();
  const importer = createStocktakeSheetImport({
    getDb: () => poolFor(db), announce: () => {},
    readValues: async source => (String(source.sheetId) === String(SOURCES.sg.sheetId) ? SG_VALUES : VALUES)
  });
  const ctx = { user: { id: 'ql', hoTen: 'Quản Lý A' }, scope: ['hanoi', 'saigon'] };
  const sg = await importer.importSheet(ctx, { source: 'sg' });
  assert.equal(sg.counterpartSessionId, null);
  const t10 = await importer.importSheet(ctx, {});
  assert.equal(t10.counterpartSessionId, sg.sessionId);
  await assert.rejects(importer.importSheet(ctx, { source: 'sg' }), { code: 'ALREADY_IMPORTED' });
  await assert.rejects(importer.importSheet(ctx, { source: 'xx' }), { statusCode: 400 });

  const service = createStockTakeService({ getDb: () => poolFor(db), announce: () => {} });
  const hn = await service.getBoard(ctx, t10.sessionId);
  const lumi = hn.rows.find(r => r.code === 'LUMI3M');
  assert.deepEqual([lumi.prevDiff, lumi.otherDiff], [-326, -48]);
  assert.equal(lumi.note.printPage, '3');
  const sgBoard = await service.getBoard(ctx, sg.sessionId);
  assert.equal(sgBoard.session.branch, 'saigon');
  assert.equal(sgBoard.session.counterpartSessionId, t10.sessionId);
  assert.equal(sgBoard.rows.find(r => r.code === 'LUMI3M').otherDiff, -434);
});

// ---------- 0106: nap lai dot nap tu sheet ----------

test('compareSnapshot: dem them / mat / doi, mau xep theo do lech lon nhat', () => {
  const result = compareSnapshot(
    [{ code: 'A', diffQty: 1 }, { code: 'B', diffQty: -5 }, { code: 'C', diffQty: 0 }],
    [{ code: 'A', diffQty: 1 }, { code: 'B', diffQty: 3 }, { code: 'D', diffQty: -20 }]);
  assert.deepEqual([result.added, result.removed, result.changed], [1, 1, 1]);
  assert.deepEqual(result.sample.map(s => s.code), ['D', 'B', 'C']);
  assert.deepEqual(result.sample[0], { code: 'D', before: null, after: -20 });
});

test('reloadSheet: xem truoc khong ghi; nap lai giu id, thay ket qua + ghi chu, khong de tag, doi ten / ngay', async () => {
  const db = await migrated();
  let current = VALUES;
  const announced = [];
  const importer = createStocktakeSheetImport({ getDb: () => poolFor(db), announce: id => announced.push(id), readValues: async () => current });
  const ctx = { user: { id: 'ql', hoTen: 'Quản Lý A' }, scope: ['hanoi', 'saigon'] };
  const { sessionId } = await importer.importT10(ctx, {});
  await db.exec(`UPDATE stocktake_product_tags SET cluster = 'Sửa trên web' WHERE product_code = 'LUMI3M'`);
  const service = createStockTakeService({ getDb: () => poolFor(db), announce: () => {} });
  const version = (await service.getBoard(ctx, sessionId)).session.version;

  // Sheet moi: LUMI3M doi SL chenh + bo ghi chu, LUMI3T mat, NEW1 them.
  current = [HEADER, VALUES[1], row('LUMI3M', 60, 485, -425, { 13: 'Tủ LUMI3' }), row('SOLO', 1000, 1000, 0), row('NEW1', 3, 0, 3)];
  const preview = await importer.reloadSheet(ctx, sessionId, { version, dryRun: true, date: '2026-10-25' });
  assert.equal(preview.dryRun, true);
  assert.deepEqual([preview.added, preview.removed, preview.changed, preview.codes], [1, 1, 1, 3]);
  assert.deepEqual(preview.before, { codes: 3, mismatched: 2, name: 'Kiểm kê HN T10 (sheet)', date: '2026-10-03' });
  assert.equal(preview.date, '2026-10-25');
  let board = await service.getBoard(ctx, sessionId);
  assert.equal(board.rows.find(r => r.code === 'LUMI3M').diffQty, -434, 'xem truoc khong ghi');
  assert.equal(board.session.version, version);
  assert.deepEqual(announced, [sessionId]);

  await assert.rejects(importer.reloadSheet(ctx, sessionId, { version: version + 1 }), { statusCode: 409, code: 'STOCKTAKE_CONFLICT' });
  const result = await importer.reloadSheet(ctx, sessionId, { version, name: 'T10 HN (nạp lại)', date: '2026-10-25' });
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.version, version + 1);
  board = await service.getBoard(ctx, sessionId);
  assert.deepEqual(board.rows.map(r => r.code), ['LUMI3M', 'NEW1', 'SOLO']);
  assert.equal(board.rows.find(r => r.code === 'LUMI3M').diffQty, -425);
  assert.equal(board.rows.find(r => r.code === 'LUMI3M').note, null, 'ghi chu cu bi thay');
  assert.equal(board.rows.find(r => r.code === 'LUMI3M').cluster, 'Sửa trên web', 'tag khong bi ghi de');
  assert.deepEqual([board.session.name, board.session.dateFrom, board.session.dateTo], ['T10 HN (nạp lại)', '2026-10-25', '2026-10-25']);
  assert.equal(board.session.reloadedByName, 'Quản Lý A');
  const history = (await db.query(`SELECT before, after FROM stocktake_history WHERE action = 'sheet_reload'`)).rows;
  assert.equal(history.length, 1);
  assert.equal(history[0].before.codes, 3);
  assert.equal(history[0].after.changed, 1);
  assert.equal(history[0].after.sample, undefined);

  // Dot mo sau do dung ban chup moi lam KK truoc.
  const { session: next } = await service.createSession(ctx, { branch: 'hanoi', name: 'Sau', dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  assert.equal((await service.getBoard(ctx, next.id)).previousSessionId, sessionId);
});

test('reloadSheet: loi sheet -> khong doi gi; chan dot web, dot huy, ngoai pham vi, ngay sai', async () => {
  const db = await migrated();
  let current = VALUES;
  const importer = createStocktakeSheetImport({ getDb: () => poolFor(db), announce: () => {}, readValues: async () => current });
  const ctx = { user: { id: 'ql', hoTen: 'Quản Lý A' }, scope: ['hanoi', 'saigon'] };
  const { sessionId } = await importer.importT10(ctx, {});
  const service = createStockTakeService({ getDb: () => poolFor(db), announce: () => {} });
  const version = (await service.getBoard(ctx, sessionId)).session.version;

  current = [['Mã SP', 'Tên hàng']];
  await assert.rejects(importer.reloadSheet(ctx, sessionId, { version }), { code: 'SHEET_FORMAT' });
  current = [HEADER];
  await assert.rejects(importer.reloadSheet(ctx, sessionId, { version }), { code: 'SHEET_EMPTY' });
  current = VALUES;
  assert.equal((await service.getBoard(ctx, sessionId)).rows.length, 3);
  await assert.rejects(importer.reloadSheet(ctx, sessionId, { version, date: '2026-02-30' }), { statusCode: 400, code: 'VALIDATION' });
  await assert.rejects(importer.reloadSheet({ ...ctx, scope: ['saigon'] }, sessionId, { version }), { statusCode: 403 });
  await assert.rejects(importer.reloadSheet(ctx, 999999, { version }), { statusCode: 404 });

  const { session: web } = await service.createSession(ctx, { branch: 'hanoi', name: 'Web', dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  await assert.rejects(importer.reloadSheet(ctx, web.id, { version: web.version }), { statusCode: 400, code: 'NOT_SHEET_IMPORT' });
  const { session: cancelled } = await service.cancelSession(ctx, sessionId, { version, reason: 'Cũ' });
  await assert.rejects(importer.reloadSheet(ctx, sessionId, { version: cancelled.version }), { statusCode: 409, code: 'STOCKTAKE_CANCELLED' });
});
