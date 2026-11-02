'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { parseT10, createStocktakeSheetImport, T10_SOURCE } = require('./stocktakeSheetImport');
const { createStockTakeService } = require('./stocktakeService');

const MIGRATIONS = path.join(__dirname, '../db/migrations');
const migration = file => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
const poolFor = db => {
  const query = (sql, params) => db.query(sql, params);
  return { query, connect: async () => ({ query, release() {} }) };
};

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
  row('lumi3m', 51, 485, -434, { 6: 'mất ko thấy', 7: 'MẤT- CHỜ TÌM SG', 10: 'cảnh', 13: 'Tủ LUMI3' }),
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
});

test('importT10: tao dot da dong, ghi chu + nguoi kiem lai, tag khong de tag san co, khong nap lai', async () => {
  const db = new PGlite();
  for (const file of ['0001_core_master_data.sql', '0003_orders.sql', '0009_app_users_hr_employees.sql', '0041_hr_employee_status.sql',
    '0064_sheet_snapshots.sql', '0095_stock_positions.sql', '0099_stock_position_ack_and_history_purge.sql',
    '0101_stock_position_stock_out_action.sql', '0103_stocktake.sql']) {
    await db.exec(migration(file));
  }
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
