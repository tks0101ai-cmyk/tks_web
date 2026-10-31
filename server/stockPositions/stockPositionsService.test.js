'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const XLSX = require('xlsx');
const { createStockPositionsService, mergeNotes, tx } = require('./stockPositionsService');
const { events, CHANGED } = require('./stockPositionsEvents');

const MIGRATIONS = path.join(__dirname, '../db/migrations');
const migration = file => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

function poolFor(db) {
  const query = (sql, params) => db.query(sql, params);
  return { query, connect: async () => ({ query, release() {} }) };
}

const QL = { id: 'ql-1', hoTen: 'Quản Lý A - 123456789', username: 'ql' };
const ctx = (scope = ['HN', 'SG']) => ({ user: QL, scope });

async function fixture({ lines = [] } = {}) {
  const db = new PGlite();
  await db.exec(migration('0001_core_master_data.sql'));
  await db.exec(migration('0064_sheet_snapshots.sql'));
  let row = 0;
  for (const line of lines) {
    await db.query(`INSERT INTO stock_location_lines (branch, source_row, code, name, notes, location, arrival_date) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [line.branch, ++row, line.code, line.name || '', line.notes, line.location || '', line.arrivalDate || '']);
  }
  await db.exec(migration('0095_stock_positions.sql'));
  await db.exec(migration('0099_stock_position_ack_and_history_purge.sql'));
  await db.exec(migration('0101_stock_position_stock_out_action.sql'));
  await db.query(`INSERT INTO products (branch, id, code, name, raw) VALUES
    ('hanoi', 1, 'AAA1', 'Hàng A một', '{"inventories":[{"onHand":30},{"onHand":12}]}'),
    ('hanoi', 2, 'BBB2', 'Hàng B hai', '{"inventories":[{"onHand":5}]}'),
    ('saigon', 3, 'AAA1', 'Hàng A một SG', '{"inventories":[{"onHand":7}]}')`);
  const service = createStockPositionsService({ getDb: () => poolFor(db) });
  return { db, service };
}

function workbook(rows, name = 'Sheet1') {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, name);
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

const HEADER = ['Mã hàng', 'Ghi chú', 'Ngày về', 'Vị trí'];
const OUT_HEADER = ['Mã hàng', 'Ghi chú', 'Vị trí'];

test('import: known products keep unreadable notes as warnings through replace and additive merges', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '5T x 100', location: 'A1' }] });
  try {
    const buffer = workbook([HEADER, ['AAA1', '1/10 đi sửa', '29/10', 'A1'], ['BBB2', '1T x 50 (K TEM)', '', 'B1']]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer });
    assert.equal(preview.counts.errors, 0);
    const row = preview.rows.find(row => row.code === 'AAA1');
    assert.equal(row.kind, 'update');
    assert.equal(row.quantity, null);
    assert.ok(row.warnings.length > 0);
    await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true, buffer });
    assert.equal((await db.query("SELECT notes FROM stock_positions WHERE code = 'AAA1'")).rows[0].notes, '1/10 đi sửa');
    const additions = workbook([HEADER, ['AAA1', '2T x 10', '', 'A1'], ['AAA1', 'chờ sửa', '', 'A1'], ['BBB2', 'kiểm tem', '', 'B1']]);
    const done = await service.importFile(ctx(), 'HN', { mode: 'add', commit: true, buffer: additions });
    assert.equal(done.counts.errors, 0);
    const stored = (await db.query('SELECT code, notes FROM stock_positions ORDER BY code')).rows;
    assert.equal(stored[0].notes, '1/10 đi sửa + 2T x 10 + chờ sửa');
    assert.match(stored[1].notes, /K TEM/);
    assert.match(stored[1].notes, /kiểm tem/);
  } finally { await db.close(); }
});

test('import review: keeps error, skipped and unchanged sources; draft edits commit without adding existing quantity twice', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '5T x 100', location: 'A1' }] });
  try {
    const buffer = workbook([HEADER, ['AAA1', '2T x 100', '', 'A1'], ['AAA1', '1T x 100', '', 'A1'], ['', 'bad', '', 'B1'], ['BBB2', '', '', 'B2']]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'add', buffer });
    assert.equal(preview.inputRows.length, 4);
    const merged = preview.rows.find(r => r.kind === 'update');
    assert.deepEqual(merged.sourceIndexes, [0, 1]);
    assert.equal(merged.notes, '8T x 100');
    assert.deepEqual(preview.rows.find(r => r.row === 4).sourceIndexes, [2]);
    assert.equal(preview.rows.find(r => r.row === 5).kind, 'skipped');
    const inputRows = [{ ...preview.inputRows[0], notes: '4T x 100' }, { row: null, code: 'BBB2', notes: '2T x 20', arrivalDate: '29/10', location: ' c 1 ' }];
    const checked = await service.importFile(ctx(), 'HN', { mode: 'add', buffer, inputRows });
    assert.equal(checked.rows.find(r => r.kind === 'update').notes, '9T x 100');
    await service.importFile(ctx(), 'HN', { mode: 'add', buffer, inputRows, commit: true });
    const saved = (await service.list(ctx(), 'HN')).rows;
    assert.deepEqual(saved.map(r => [r.code, r.notes, r.location]), [['AAA1', '9T x 100', 'A1'], ['BBB2', '2T x 20', 'C1']]);
    const unchanged = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer, inputRows: saved });
    assert.equal(unchanged.rows.filter(r => r.kind === 'unchanged').length, 2);
    await assert.rejects(() => service.importFile(ctx(), 'HN', { mode: 'add', buffer, inputRows: [{ code: {} }] }), { code: 'IMPORT_INVALID_ROWS' });
    await assert.rejects(() => service.importFile(ctx(), 'HN', { mode: 'add', buffer, inputRows: [] }), { code: 'IMPORT_EMPTY_FILE' });
  } finally { await db.close(); }
});

test('import review: all invalid rows skip without deleting existing stock', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '5T x 100', location: 'A1' }] });
  try {
    const buffer = workbook([HEADER, ['', '', '29/10', ''], ['BBB2', 'bad', '', 'B'.repeat(101)]]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer });
    assert.equal(preview.counts.errors, 0);
    assert.equal(preview.counts.skippedEmpty, 2);
    assert.equal(preview.counts.deleted, 0);
    assert.ok(preview.rows.every(row => row.kind === 'skipped' && row.message));
    const done = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer, commit: true });
    assert.equal(done.imported, true);
    assert.equal((await service.list(ctx(), 'HN')).rows.length, 1);
  } finally { await db.close(); }
});

test('import review: warnings and every input past 300 are returned, including unknown codes', async () => {
  const { db, service } = await fixture();
  try {
    const buffer = workbook([HEADER, ...Array.from({ length: 305 }, (_, i) => ['AAA1', '1T x 10', '', 'A' + i]), ['ZZZ9', '1T x 10 + 1T x 20', '', 'Z']]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'add', buffer });
    assert.equal(preview.inputRows.length, 306);
    assert.equal(preview.rows.length, 306);
    assert.deepEqual(preview.rows.find(r => r.code === 'ZZZ9').warnings, ['multi', 'unknowncode']);
    assert.equal((await service.list(ctx(), 'HN')).rows.length, 0);
  } finally { await db.close(); }
});

test('migration seed: sao chep Vi tri HN/SG, go tien to "T x ", bo dong het hang va thieu ma, ghi lich su seed', async () => {
  const { db, service } = await fixture({ lines: [
    { branch: 'HN', code: 'AAA1', name: 'A', notes: 'T x 4T*100', location: '42', arrivalDate: 'KK 4.10' },
    { branch: 'HN', code: 'BBB2', name: 'B', notes: 'T x 50t*800', location: 'sm' },
    { branch: 'HN', code: 'CCC3', name: 'C', notes: '', location: '1' },
    { branch: 'HN', code: 'DDD4', name: 'D', notes: 'Hết hàng', location: '2' },
    { branch: 'HN', code: '', name: 'E', notes: '1T x 5', location: '3' },
    { branch: 'HN', code: 'FFF6', name: 'F', notes: 'T x Ghi chú lạ', location: '4' },
    { branch: 'SG', code: 'AAA1', name: 'A', notes: '3T X 200', location: '38', arrivalDate: '08/10' }
  ] });
  try {
    const hn = await service.list(ctx(), 'HN');
    assert.deepEqual(hn.rows.map(r => [r.code, r.notes]), [['AAA1', '4T x 100'], ['BBB2', '50T x 800'], ['FFF6', 'T x Ghi chú lạ']]);
    assert.equal(hn.rows[0].arrivalDate, 'KK 4.10');
    assert.equal(hn.rows[0].updatedByName, 'Nhập dữ liệu đầu');
    assert.equal(hn.rows[0].quantity, 400);
    assert.equal(hn.rows[2].quantity, null);
    assert.deepEqual(hn.rows[2].warnings, ['unreadable', 'unknowncode']);
    const sg = await service.list(ctx(), 'SG');
    assert.equal(sg.rows[0].quantity, 600);
    const seeds = await db.query(`SELECT branch, summary FROM stock_position_history WHERE action = 'seed' ORDER BY branch`);
    assert.deepEqual(seeds.rows.map(r => [r.branch, r.summary.rows]), [['HN', 3], ['SG', 1]]);
  } finally { await db.close(); }
});

test('list: chuẩn hóa ghi chú cũ và gộp quy cách không liền nhau mà không ghi lại DB', async () => {
  const original = '1t*100+1t*100+1t*80+1t*100';
  const { db, service } = await fixture({ lines: [
    { branch: 'HN', code: 'AAA1', notes: original, location: 'A01' },
    { branch: 'HN', code: 'BBB2', notes: '1t100+2T*100', location: 'A02' },
    { branch: 'HN', code: 'AAA1', notes: '3T*50+1T*49', location: 'SMT2' },
    { branch: 'HN', code: 'AAA1', notes: '1t*7c lẻ', location: 'A03' },
    { branch: 'HN', code: 'AAA1', notes: '1th*360', location: 'A04' },
    { branch: 'HN', code: 'AAA1', notes: '1t x 72 ( in tem )', location: 'A05' },
    { branch: 'HN', code: 'AAA1', notes: 'T x 9X12+1TX12', location: 'A06' },
    { branch: 'HN', code: 'AAA1', notes: '1TX800 ( DÁN LẠI TEM )', location: 'A07' },
    { branch: 'HN', code: 'AAA1', notes: 'T x 1b*80', location: 'A08' },
    { branch: 'HN', code: 'AAA1', notes: '4t*30, check lại', location: 'A09' },
    { branch: 'HN', code: 'AAA1', notes: 'T x (1 bóng mịn + 1 bóng sần hở)\n1t*19', location: 'A10' },
    { branch: 'HN', code: 'AAA1', notes: '1t*30+2t*30 (dán tem)+2t*30+1t*30', location: 'A11' }
  ] });
  try {
    const { rows } = await service.list(ctx(), 'HN');
    assert.equal(rows[0].notes, '3T x 100 + 1T x 80');
    assert.equal(rows[0].quantity, 380);
    assert.equal(rows[0].available, 380);
    assert.deepEqual(rows[0].warnings, ['multi']);
    assert.equal(rows[1].notes, '3T x 100');
    assert.deepEqual(rows[1].warnings, []);
    assert.equal(rows[2].notes, '3T x 50 + 1T x 49');
    assert.equal(rows[2].quantity, 199);
    assert.deepEqual(rows.slice(3).map(r => [r.notes, r.quantity, r.warnings]), [
      ['1T x 7c lẻ', 7, []], ['1T x 360', 360, []], ['1T x 72 (in tem)', 72, []],
      ['10T x 12', 120, []], ['1T x 800 (DÁN LẠI TEM)', null, ['unreadable']],
      ['1b x 80', null, ['unreadable']], ['4T x 30, check lại', null, ['unreadable']],
      ['T x (1 bóng mịn + 1 bóng sần hở)\n1T x 19', null, ['unreadable']],
      ['4T x 30 + 2T x 30 (dán tem)', null, ['unreadable']]
    ]);
    const { createStockPositionsWorkbook } = require('./stockPositionsExport');
    const exported = await createStockPositionsWorkbook({ branch: 'HN', rows });
    const book = XLSX.read(exported.buffer, { type: 'buffer' });
    const sheetRows = XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]]);
    assert.equal(sheetRows[0]['Ghi chú số thùng'], '3T x 100 + 1T x 80');
    assert.equal(sheetRows.at(-2)['Ghi chú số thùng'], 'T x (1 bóng mịn + 1 bóng sần hở)\n1T x 19');
    assert.equal(sheetRows.at(-1)['Ghi chú số thùng'], '4T x 30 + 2T x 30 (dán tem)');
    const stored = (await db.query('SELECT notes, version FROM stock_positions WHERE id = $1', [rows[0].id])).rows[0];
    assert.equal(stored.notes, original);
    assert.equal(stored.version, rows[0].version);
    assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM stock_position_history WHERE action <> 'seed'")).rows[0].count, 0);
  } finally { await db.close(); }
});

test('list: ten + SL Kiot tra theo ma tu products, ma la bi canh bao, dong trung (ma, vi tri) cua du lieu dau khong bi canh bao', async () => {
  const { db, service } = await fixture({ lines: [
    { branch: 'HN', code: 'AAA1', name: 'tên sheet', notes: '1T x 50', location: 'H1' },
    { branch: 'HN', code: 'AAA1', name: 'tên sheet', notes: '2T x 50', location: 'h1' },
    { branch: 'HN', code: 'ZZZ9', name: 'Mã lạ', notes: '1T x 5 + 1T x 6', location: 'H2' }
  ] });
  try {
    const { rows } = await service.list(ctx(['HN']), 'HN');
    assert.equal(rows[0].name, 'Hàng A một');
    assert.equal(rows[0].kiotQuantity, 42);
    assert.deepEqual(rows[0].warnings, []);
    assert.deepEqual(rows[1].warnings, []);
    assert.equal(rows[2].name, 'Mã lạ');
    assert.equal(rows[2].kiotQuantity, null);
    assert.deepEqual(rows[2].warnings, ['multi', 'unknowncode']);
    await assert.rejects(() => service.list(ctx(['SG']), 'HN'), { code: 'BRANCH_OUT_OF_SCOPE' });
  } finally { await db.close(); }
});

test('create: chuan hoa ghi chu, tra ten theo ma khong phan biet hoa/thuong, trung (ma, vi tri) thi tu cong vao dong cu, ghi lich su', async () => {
  const { db, service } = await fixture();
  try {
    const { row } = await service.create(ctx(), 'HN', { code: ' aaa1 ', notes: '1t 100 + 2T*100', arrivalDate: '4/10', location: 'H1' });
    assert.equal(row.code, 'AAA1');
    assert.equal(row.name, 'Hàng A một');
    assert.equal(row.notes, '3T x 100');
    assert.equal(row.quantity, 300);
    assert.equal(row.kiotQuantity, 42);
    assert.equal(row.updatedByName, 'Quản Lý A');
    assert.equal(row.version, 1);
    assert.equal(row.merged, undefined);
    // Trung (ma, vi tri): cong thong minh vao dong cu — cung SL/thung thi gop thung, khac thi noi bang " + ".
    const same = await service.create(ctx(), 'HN', { code: 'aaa1', notes: '2T*100', arrivalDate: '20/10', location: 'h1' });
    assert.equal(same.merged, true);
    assert.equal(same.row.id, row.id);
    assert.equal(same.row.notes, '5T x 100');
    assert.equal(same.row.quantity, 500);
    assert.equal(same.row.arrivalDate, '20/10');
    assert.equal(same.row.version, 2);
    assert.equal(same.row.location, 'H1');
    const other50 = await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 50', location: 'H1' });
    assert.equal(other50.row.notes, '5T x 100 + 1T x 50');
    assert.deepEqual(other50.row.warnings, ['multi']);
    assert.equal((await service.list(ctx(), 'HN')).rows.length, 1);
    await assert.rejects(() => service.create(ctx(), 'HN', { code: 'AAA1', notes: 'rác', location: 'H1' }), { code: 'VALIDATION', field: 'notes' });
    await assert.rejects(() => service.create(ctx(), 'HN', { code: 'AAA1', notes: '', location: 'H2' }), { code: 'VALIDATION', field: 'notes' });
    await assert.rejects(() => service.create(ctx(), 'HN', { code: '', notes: '1T x 5', location: 'H2' }), { code: 'VALIDATION', field: 'code' });
    const other = await service.create(ctx(), 'HN', { code: 'ZZZ', notes: '1T x 5', location: 'H1' });
    assert.equal(other.row.name, '');
    assert.deepEqual(other.row.warnings, ['unknowncode']);
    const history = await service.history(ctx(), 'HN');
    assert.deepEqual(history.rows.map(h => [h.action, h.code]), [['create', 'ZZZ'], ['edit', 'AAA1'], ['edit', 'AAA1'], ['edit', 'AAA1'], ['create', 'AAA1']]);
  } finally { await db.close(); }
});

test('update: chuan hoa, version, 409 sua chong, khong ghi lich su khi khong doi, tu xoa khi het hang can xac nhan', async () => {
  const { db, service } = await fixture();
  try {
    const { row } = await service.create(ctx(), 'HN', { code: 'AAA1', notes: '3T x 100', location: 'H1' });
    const same = await service.update(ctx(), row.id, { version: 1, notes: '3t  x 100', location: 'H1' });
    assert.equal(same.row.version, 1);
    const edited = await service.update(ctx(), row.id, { version: 1, notes: '1t*100 + 1t*100', arrivalDate: '16/10' });
    assert.equal(edited.row.notes, '2T x 100');
    assert.equal(edited.row.arrivalDate, '16/10');
    assert.equal(edited.row.version, 2);
    await assert.rejects(() => service.update(ctx(), row.id, { version: 1, notes: '9T x 1' }),
      error => error.code === 'VERSION_CONFLICT' && error.latest.notes === '2T x 100');
    const second = await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 5', location: 'H2' });
    await assert.rejects(() => service.update(ctx(), second.row.id, { version: 1, location: 'h1' }), { code: 'DUPLICATE_POSITION' });
    await assert.rejects(() => service.update(ctx(), row.id, { version: 2, notes: '' }), { code: 'WOULD_AUTO_DELETE' });
    assert.equal((await service.list(ctx(), 'HN')).rows.length, 2);
    assert.deepEqual(await service.update(ctx(), row.id, { version: 2, notes: '', confirmEmpty: true }), { deleted: true, id: row.id });
    assert.equal((await service.list(ctx(), 'HN')).rows.length, 1);
    const history = (await service.history(ctx(), 'HN')).rows.map(h => [h.action, h.field, h.oldValue, h.newValue]);
    assert.ok(history.some(h => h[0] === 'auto_delete' && h[2] === '2T x 100'));
    assert.equal(history.filter(h => h[0] === 'edit').length, 2); // notes + arrivalDate, lan "khong doi" khong ghi
    await assert.rejects(() => service.update(ctx(['SG']), row.id + 1000, { version: 1 }), { code: 'NOT_FOUND' });
    await assert.rejects(() => service.update(ctx(['SG']), second.row.id, { version: 1, notes: '1T x 9' }), { code: 'BRANCH_OUT_OF_SCOPE' });
  } finally { await db.close(); }
});

test('deduct: 3T x 100 tru 200 -> 1T x 100; tru le them phan " - N"; tru het thi tu xoa; tru qua thi bao loi', async () => {
  const { db, service } = await fixture();
  try {
    const { row } = await service.create(ctx(), 'HN', { code: 'AAA1', notes: '3T x 100', location: 'H1' });
    const a = await service.deduct(ctx(), row.id, { version: 1, quantity: 200 });
    assert.equal(a.row.notes, '1T x 100');
    assert.equal(a.row.quantity, 100);
    const b = await service.deduct(ctx(), row.id, { version: 2, quantity: 30 });
    assert.equal(b.row.notes, '1T x 100 - 30');
    assert.equal(b.row.quantity, 70);
    await assert.rejects(() => service.deduct(ctx(), row.id, { version: 3, quantity: 71 }), { code: 'VALIDATION' });
    await assert.rejects(() => service.deduct(ctx(), row.id, { version: 3, quantity: 0 }), { code: 'VALIDATION' });
    assert.deepEqual(await service.deduct(ctx(), row.id, { version: 3, quantity: 70 }), { deleted: true, id: row.id });
    const history = (await service.history(ctx(), 'HN')).rows.map(h => h.action);
    assert.deepEqual(history.slice(0, 3), ['auto_delete', 'deduct', 'deduct']);
  } finally { await db.close(); }
});

test('remove: xoa dong, ghi lich su delete, sai version bi 409', async () => {
  const { db, service } = await fixture();
  try {
    const { row } = await service.create(ctx(), 'SG', { code: 'AAA1', notes: '1T x 5', location: 'S1' });
    await assert.rejects(() => service.remove(ctx(), row.id, 9), { code: 'VERSION_CONFLICT' });
    assert.deepEqual(await service.remove(ctx(), row.id, 1), { deleted: true, id: row.id });
    assert.equal((await service.history(ctx(), 'SG')).rows[0].action, 'delete');
    assert.equal((await service.list(ctx(), 'SG')).rows.length, 0);
  } finally { await db.close(); }
});

test('lich su bat bien: khong sua/xoa duoc, phan trang theo before', async () => {
  const { db, service } = await fixture();
  try {
    for (const location of ['A', 'B', 'C']) await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 5', location });
    await assert.rejects(() => db.query('UPDATE stock_position_history SET code = $1', ['x']), /immutable/);
    await assert.rejects(() => db.query('DELETE FROM stock_position_history'), /immutable/);
    const page1 = await service.history(ctx(), 'HN', { limit: 2 });
    assert.equal(page1.rows.length, 2);
    assert.ok(page1.nextBefore);
    const page2 = await service.history(ctx(), 'HN', { limit: 2, before: page1.nextBefore });
    assert.equal(page2.rows.length, 1);
    assert.equal(page2.nextBefore, null);
  } finally { await db.close(); }
});

test('history: positionId chi lay lich su cua dong do, gia tri rac thi bo qua', async () => {
  const { db, service } = await fixture();
  try {
    const first = (await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 5', location: 'A' })).row;
    await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 5', location: 'B' });
    await service.update(ctx(), first.id, { version: first.version, notes: '2T x 5' });
    const all = await service.history(ctx(), 'HN');
    const own = await service.history(ctx(), 'HN', { positionId: String(first.id) });
    assert.equal(all.rows.length, 3);
    assert.deepEqual(own.rows.map(h => h.action), ['edit', 'create']);
    assert.ok(own.rows.every(h => h.positionId === first.id));
    assert.equal((await service.history(ctx(), 'HN', { positionId: 999999 })).rows.length, 0);
    for (const junk of ['abc', '', '0', '-3', null, undefined]) assert.equal((await service.history(ctx(), 'HN', { positionId: junk })).rows.length, 3, String(junk));
    assert.equal((await service.history(ctx(), 'SG', { positionId: first.id })).rows.length, 0);
  } finally { await db.close(); }
});

test('mergeNotes: gop cung quy cach, khac quy cach noi bang +, cong phan tru le', () => {
  assert.equal(mergeNotes('1th*72 (in tem)', '1t*72'), '2T x 72 (in tem)');
  assert.equal(mergeNotes('1t*7c lẻ', '1t*7c lẻ'), '2T x 7c lẻ');
  assert.equal(mergeNotes('1t*7c lẻ', '1t*72 (in tem)'), '1T x 7c + 1T x 72 lẻ (in tem)');
  assert.equal(mergeNotes('5T x 100', '2T x 100'), '7T x 100');
  assert.equal(mergeNotes('5T x 100', '2T x 50'), '5T x 100 + 2T x 50');
  assert.equal(mergeNotes('5T x 100 - 30', '1T x 100'), '6T x 100 - 30');
  assert.equal(mergeNotes('rác', '1T x 5'), null);
});

async function seedImportRows(service) {
  await service.create(ctx(), 'HN', { code: 'AAA1', notes: '5T x 100', arrivalDate: '1/10', location: 'H1' });
  await service.create(ctx(), 'HN', { code: 'BBB2', notes: '1T x 10', arrivalDate: '1/10', location: 'H2' });
}

test('đơn Đang bốc giữ dòng VT: xóa tay / sửa-trừ về 0 bị chặn, import Thay thế giữ lại dòng đó; Đã bốc/Đã hủy thì xóa được', async () => {
  const { db, service } = await fixture({ lines: [
    { branch: 'HN', code: 'AAA1', notes: '3T x 100', location: 'A1' },
    { branch: 'HN', code: 'BBB2', notes: '1T x 10', location: 'B1' },
    { branch: 'HN', code: 'CCC3', notes: '1T x 10', location: 'C1' }
  ] });
  try {
    await db.exec(migration('0096_order_pick_assignments.sql'));
    await db.exec(migration('0101_stock_position_stock_out_action.sql'));
    const byCode = Object.fromEntries((await service.list(ctx(), 'HN')).rows.map(r => [r.code, r]));
    const hold = async (orderCode, status, position) => {
      const id = Number((await db.query(`INSERT INTO order_pick_assignments (branch, order_code, status) VALUES ('HN', $1, $2) RETURNING id`, [orderCode, status])).rows[0].id);
      await db.query(`INSERT INTO order_pick_lines (assignment_id, product_code, position_id, location, planned_qty, reserved_qty) VALUES ($1, $2, $3, $4, 10, 10)`, [id, position.code, position.id, position.location]);
    };
    await hold('DH1', 'picking', byCode.AAA1);
    await hold('DH2', 'confirmed', byCode.CCC3);
    await assert.rejects(service.remove(ctx(), byCode.AAA1.id, byCode.AAA1.version), e => e.code === 'POSITION_HELD' && /DH1/u.test(e.message));
    await assert.rejects(service.deduct(ctx(), byCode.AAA1.id, { quantity: 300, version: byCode.AAA1.version }), e => e.code === 'POSITION_HELD');
    await assert.rejects(service.update(ctx(), byCode.AAA1.id, { notes: '', version: byCode.AAA1.version, confirmEmpty: true }), e => e.code === 'POSITION_HELD');
    const buffer = workbook([['mã SP', 'GHI CHÚ', 'Ngày về', 'Vị trí'], ['ZZZ9', '1T x 5', '', 'Z1']]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer });
    assert.deepEqual([preview.counts.deleted, preview.counts.keptHeld], [2, 1]);
    assert.match(preview.rows.find(r => r.kind === 'skipped' && r.code === 'AAA1').message, /DH1/u);
    await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true, buffer });
    assert.deepEqual((await service.list(ctx(), 'HN')).rows.map(r => r.code).sort(), ['AAA1', 'ZZZ9']);
  } finally { await db.close(); }
});

test('import replace: xem truoc khong ghi, xac nhan thay toan bo (them/doi/xoa), bo dong SL 0', async () => {
  const { db, service } = await fixture();
  try {
    await seedImportRows(service);
    const buffer = workbook([
      ['Báo cáo vị trí', '', '', '', 'Cột thừa'],
      ['STT', 'mã SP', 'GHI CHÚ', 'Ngày về', 'Vị trí', 'Cột thừa'],
      [1, 'aaa1', '5T x 100', '1/10', 'H1', 'x'],       // khong doi
      [2, 'ZZZ9', '1t*20 + 2T*20', 'KK 4.10', 'H9', ''], // them (ma la)
      [3, 'BBB2', '', '', 'H2', ''],                      // SL 0: bo qua => dong BBB2 cu bi xoa
      [4, '', '', '', '', '']
    ]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer, fileName: 'vt.xlsx' });
    assert.deepEqual(preview.counts, { added: 1, updated: 0, deleted: 1, unchanged: 1, skippedEmpty: 1, keptHeld: 0, errors: 0 });
    assert.deepEqual(preview.rows.map(r => [r.kind, r.code, r.notes, r.location, r.cartons, r.quantity]), [['add', 'ZZZ9', '3T x 20', 'H9', 3, 60], ['delete', 'BBB2', '1T x 10', 'H2', 1, 10], ['unchanged', 'AAA1', '5T x 100', 'H1', 5, 500], ['skipped', 'BBB2', '', 'H2', 0, 0]]);
    assert.equal((await service.list(ctx(), 'HN')).rows.length, 2);
    const done = await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true, buffer, fileName: 'vt.xlsx' });
    assert.equal(done.imported, true);
    const rows = (await service.list(ctx(), 'HN')).rows;
    assert.deepEqual(rows.map(r => [r.code, r.notes, r.arrivalDate, r.location]), [['AAA1', '5T x 100', '1/10', 'H1'], ['ZZZ9', '3T x 20', 'KK 4.10', 'H9']]);
    const history = (await service.history(ctx(), 'HN')).rows;
    const summary = history.find(h => h.action === 'import_replace');
    assert.equal(summary.summary.file, 'vt.xlsx');
    assert.equal(summary.summary.added, 1);
    assert.ok(history.some(h => h.action === 'delete' && h.code === 'BBB2'));
  } finally { await db.close(); }
});

test('import add: cong ghi chu vao dong trung (ma, vi tri), dong moi them, dong ngoai file giu nguyen', async () => {
  const { db, service } = await fixture();
  try {
    await seedImportRows(service);
    const buffer = workbook([HEADER, ['AAA1', '2T x 100', '16/10', 'h1'], ['AAA1', '1T x 30', '', 'H3']]);
    const done = await service.importFile(ctx(), 'HN', { mode: 'add', commit: true, buffer, fileName: 'them.xlsx' });
    assert.deepEqual(done.counts, { added: 1, updated: 1, deleted: 0, unchanged: 0, skippedEmpty: 0, keptHeld: 0, errors: 0 });
    const rows = (await service.list(ctx(), 'HN')).rows;
    assert.deepEqual(rows.map(r => [r.code, r.notes, r.arrivalDate, r.location]),
      [['AAA1', '7T x 100', '16/10', 'H1'], ['BBB2', '1T x 10', '1/10', 'H2'], ['AAA1', '1T x 30', '', 'H3']]);
  } finally { await db.close(); }
});

test('import add: ghi chu viet tu do (2Tx100 co san, file 1T100) tu nhay thanh 3T x 100, ke ca khi xem truoc', async () => {
  const { db, service } = await fixture();
  try {
    await service.create(ctx(), 'HN', { code: 'AAA1', notes: '2Tx100', arrivalDate: '1/10', location: 'H1' });
    const buffer = workbook([HEADER, ['aaa1', '1T100', '', 'h1']]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'add', buffer, fileName: 'them.xlsx' });
    assert.deepEqual(preview.counts, { added: 0, updated: 1, deleted: 0, unchanged: 0, skippedEmpty: 0, keptHeld: 0, errors: 0 });
    assert.equal(preview.rowsTotal, 1);
    assert.deepEqual(preview.rows[0], { kind: 'update', row: preview.rows[0].row, code: 'AAA1', name: preview.rows[0].name, notes: '3T x 100', arrivalDate: '1/10', location: 'H1', cartons: 3, quantity: 300, sourceIndexes: [0], warnings: [], before: { notes: '2T x 100', arrivalDate: '1/10', location: 'H1' } },
      'xem trước hiện đúng giá trị sẽ ghi (đã chuẩn hóa, đã cộng) kèm giá trị cũ');
    await service.importFile(ctx(), 'HN', { mode: 'add', commit: true, buffer, fileName: 'them.xlsx' });
    const rows = (await service.list(ctx(), 'HN')).rows;
    assert.deepEqual(rows.map(r => [r.code, r.notes, r.quantity, r.arrivalDate, r.location]), [['AAA1', '3T x 100', 300, '1/10', 'H1']]);
  } finally { await db.close(); }
});

test('import loi: missing code blocks commit; free-form notes do not; Excel dates remain supported', async () => {
  const { db, service } = await fixture();
  try {
    await seedImportRows(service);
    await assert.rejects(() => service.importFile(ctx(), 'HN', { mode: 'add', buffer: workbook([['Mã hàng', 'Ghi chú', 'Vị trí'], ['A', '1T x 1', 'x']]) }),
      error => error.code === 'IMPORT_HEADERS_MISSING' && /Ngày về/.test(error.message));
    await assert.rejects(() => service.importFile(ctx(), 'HN', { mode: 'add', buffer: Buffer.from('không phải excel') }), error => ['IMPORT_UNREADABLE', 'IMPORT_HEADERS_MISSING'].includes(error.code));
    await assert.rejects(() => service.importFile(ctx(), 'HN', { mode: 'xoa', buffer: workbook([HEADER, ['A', '1T x 1', '', 'x']]) }), { code: 'VALIDATION' });
    const bad = workbook([HEADER, ['', '1T x 5', '', 'H1'], ['AAA1', 'nhiều thùng', '', 'H1'], ['CCC3', '1T x 5', '', 'H5'], ['ccc3', '2T x 5', '', 'h5']]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer: bad });
    assert.equal(preview.counts.errors, 0);
    assert.equal(preview.rows.find(row => row.row === 2).kind, 'skipped');
    assert.equal((await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true, buffer: bad })).imported, true);
    assert.equal((await service.list(ctx(), 'HN')).rows.length, 2);

    const sheet = XLSX.utils.aoa_to_sheet([HEADER, ['AAA1', '1T x 5', '', 'H1']]);
    sheet.C2 = { t: 'n', v: 46300, z: 'dd/mm/yyyy' }; // 2026-08-... theo serial Excel
    sheet['!ref'] = 'A1:D2';
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'S');
    const dated = await service.importFile(ctx(), 'HN', { mode: 'add', commit: true, buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx', cellStyles: true }), fileName: 'ngay.xlsx' });
    assert.equal(dated.counts.updated, 1);
    const row = (await service.list(ctx(), 'HN')).rows.find(r => r.location === 'H1');
    assert.match(row.arrivalDate, /^\d{2}\/\d{2}(\/\d{4})?$/);
  } finally { await db.close(); }
});

test('import: mã ngoài Kiot giữ tên và ghi chú tự do, cập nhật tên và không tự tính SL', async () => {
  const { db, service } = await fixture();
  try {
    const header = ['Mã', 'Tên hàng', 'Thùng', 'Ngày về', 'Ô'];
    const buffer = workbook([header, ['NEW1', 'Hàng mẫu', 'Chưa kiểm đếm', '28/10', 'a 1'], ['AAA1', 'Tên Excel', '1T x 5', '', 'A2'], ['NEW2', 'Hàng rỗng', '', '', 'A3']]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer });
    assert.equal(preview.counts.errors, 0);
    await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true, buffer });
    let rows = (await service.list(ctx(), 'HN')).rows;
    const manual = rows.find(r => r.code === 'NEW1');
    assert.deepEqual([manual.name, manual.notes, manual.arrivalDate, manual.location, manual.quantity, manual.available, manual.kiotQuantity], ['Hàng mẫu', 'Chưa kiểm đếm', '28/10', 'A1', null, null, null]);
    assert.equal(rows.find(r => r.code === 'AAA1').name, 'Hàng A một');
    assert.ok(rows.some(r => r.code === 'NEW2'));
    await service.importFile(ctx(), 'HN', { mode: 'add', commit: true, buffer: workbook([header, ['NEW1', 'Tên mới', '1T x 5', '', 'A1']]) });
    rows = (await service.list(ctx(), 'HN')).rows;
    const updated = rows.find(r => r.code === 'NEW1');
    assert.deepEqual([updated.name, updated.notes, updated.quantity], ['Tên mới', 'Chưa kiểm đếm + 1T x 5', null]);
    assert.ok((await service.history(ctx(), 'HN')).rows.some(r => r.field === 'name' && r.newValue === 'Tên mới'));
    await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true, buffer: workbook([header, ['NEW1', 'Tên mới', '2T x 5', '', 'A1']]) });
    const numeric = (await service.list(ctx(), 'HN')).rows[0];
    assert.equal(numeric.quantity, null);
    await assert.rejects(() => service.deduct(ctx(), numeric.id, { version: numeric.version, quantity: 1 }), { code: 'NOT_DEDUCTIBLE' });
    const edited = await service.update(ctx(), numeric.id, { version: numeric.version, notes: '' });
    assert.equal(edited.row.notes, '');
    assert.equal(edited.row.quantity, null);
  } finally { await db.close(); }
});

test('import: mã lạ chuẩn hóa và gộp ghi chú ngay trong DB ở replace, dòng trùng và add', async () => {
  const { db, service } = await fixture();
  try {
    const raw = '5t 100 + 1t*100 + 3T x100 + 3thX100';
    const buffer = workbook([HEADER, ['TEXT', raw, 'TEXT', 'TEXT']]);
    const preview = await service.importFile(ctx(), 'HN', { mode: 'replace', buffer });
    assert.equal(preview.counts.errors, 0);
    assert.equal((await db.query('SELECT * FROM stock_positions')).rows.length, 0, 'xem trước không ghi DB');
    await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true, buffer });
    assert.equal((await db.query("SELECT notes FROM stock_positions WHERE code = 'TEXT'")).rows[0].notes, '12T x 100');
    await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true,
      buffer: workbook([HEADER, ['TEXT', '5t100', '', 'TEXT'], ['TEXT', '1t*100', '', 'TEXT']]) });
    assert.equal((await db.query("SELECT notes FROM stock_positions WHERE code = 'TEXT'")).rows[0].notes, '6T x 100');
    await db.query("UPDATE stock_positions SET notes = '5t100 + 1t*100' WHERE code = 'TEXT'");
    await service.importFile(ctx(), 'HN', { mode: 'add', commit: true,
      buffer: workbook([HEADER, ['TEXT', '3thX100', '', 'TEXT'], ['TEXT', '3t100', '', 'TEXT']]) });
    assert.equal((await db.query("SELECT notes FROM stock_positions WHERE code = 'TEXT'")).rows[0].notes, '12T x 100');
    const result = (await service.list(ctx(), 'HN')).rows[0];
    assert.equal(result.quantity, null, 'chuẩn hóa không tự suy ra SL cho mã lạ');
    assert.ok(result.rawWarnings.includes('unknowncode'));
    assert.ok((await service.history(ctx(), 'HN')).rows.some(r => r.field === 'notes' && r.newValue === '12T x 100'));
  } finally { await db.close(); }
});

test('import: mã bỏ mọi khoảng trắng, viết hoa và tra đúng tên Kiot; hàng ngoài Kiot gộp space', async () => {
  const { db, service } = await fixture();
  try {
    const header = ['Mã', 'Tên hàng', 'Ghi chú', 'Ngày về', 'Vị trí'];
    const buffer = workbook([header,
      [' a a\ta1 ', 'Tên Excel sai', ' 1t  x  5 ', '  KK   28.10 ', ' a 1 '],
      [' ne\tw 1 ', '  Hàng   mẫu  ', '  Chưa   kiểm\tđếm  ', '  KK   28.10 ', ' a 2 ']
    ]);
    await service.importFile(ctx(), 'HN', { mode: 'replace', commit: true, buffer });
    const rows = (await service.list(ctx(), 'HN')).rows;
    assert.deepEqual(rows.map(r => [r.code, r.name, r.notes, r.arrivalDate, r.location]), [
      ['AAA1', 'Hàng A một', '1T x 5', 'KK 28.10', 'A1'],
      ['NEW1', 'Hàng mẫu', 'Chưa kiểm đếm', 'KK 28.10', 'A2']
    ]);
    const stored = (await db.query('SELECT code FROM stock_positions ORDER BY id')).rows;
    assert.deepEqual(stored.map(r => r.code), ['AAA1', 'NEW1']);
    const added = await service.create(ctx(), 'HN', { code: ' a a a 1 ', notes: '1T x 5', location: 'A1' });
    assert.equal(added.merged, true);
    assert.equal(added.row.quantity, 10);
    await db.query("UPDATE stock_positions SET code = ' n e w 1 ', notes = ' Chưa   kiểm đếm ' WHERE code = 'NEW1'");
    await service.importFile(ctx(), 'HN', { mode: 'add', commit: true, buffer: workbook([header, ['n e w 1', '', ' Ghi   thêm ', '', 'A2']]) });
    const unknown = (await service.list(ctx(), 'HN')).rows.find(r => r.code === 'NEW1');
    assert.equal(unknown.name, 'Hàng mẫu');
    assert.equal(unknown.notes, 'Chưa kiểm đếm + Ghi thêm');
    assert.equal((await db.query("SELECT code FROM stock_positions WHERE id = $1", [unknown.id])).rows[0].code, 'NEW1');
  } finally { await db.close(); }
});

test('import csv UTF-8 co dau', async () => {
  const { db, service } = await fixture();
  try {
    const csv = Buffer.from('﻿Mã hàng,Ghi chú,Ngày về,Vị trí\nAAA1,"1T x 10 + 2T x 10",KK 4.10,Kệ 1\n', 'utf8');
    const done = await service.importFile(ctx(), 'SG', { mode: 'replace', commit: true, buffer: csv, fileName: 'vt.csv' });
    assert.equal(done.counts.added, 1);
    const [row] = (await service.list(ctx(), 'SG')).rows;
    assert.deepEqual([row.notes, row.arrivalDate, row.location, row.name], ['3T x 10', 'KK 4.10', 'KỆ1', 'Hàng A một SG']);
  } finally { await db.close(); }
});

test('Vị trí được chuẩn hóa khi nhập: bỏ mọi khoảng trắng + viết hoa ("a 05" -> "A05"), cả Thêm dòng, Sửa và Import; so trùng không phân biệt khoảng trắng/hoa-thường', async () => {
  const { normalizeLocation } = require('./stockPositionsService');
  assert.deepEqual(['a 05', ' kệ  1 ', 'sm', 'A05', '', null].map(normalizeLocation), ['A05', 'KỆ1', 'SM', 'A05', '', '']);
  const { db, service } = await fixture();
  try {
    const first = await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 5', location: 'a 05' });
    assert.equal(first.row.location, 'A05');
    // "A 05" và "a05" đều là cùng vị trí "A05": cộng vào dòng sẵn có, không tạo dòng mới.
    const same = await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 5', location: ' A 0 5 ' });
    assert.equal(same.merged, true);
    assert.equal(same.row.id, first.row.id);
    const other = await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 5', location: 'b 1' });
    assert.equal(other.row.location, 'B1');
    const moved = await service.update(ctx(), other.row.id, { version: other.row.version, location: 'c 7' });
    assert.equal(moved.row.location, 'C7');
    await assert.rejects(() => service.update(ctx(), other.row.id, { version: moved.row.version, location: 'a  05' }), { code: 'DUPLICATE_POSITION' });
    const buffer = workbook([HEADER, ['AAA1', '1T x 5', '', 'd 9'], ['aaa1', '2T x 5', '', 'D9']]);
    const done = await service.importFile(ctx(), 'HN', { mode: 'add', commit: true, buffer, fileName: 'chuan-hoa.xlsx' });
    assert.equal(done.counts.added, 1, 'hai dòng "d 9" và "D9" trong file là cùng một vị trí D9');
    const rows = (await service.list(ctx(), 'HN')).rows;
    assert.deepEqual(rows.map(r => r.location).sort(), ['A05', 'C7', 'D9']);
  } finally { await db.close(); }
});

test('import: dong trung (ma, vi tri) trong file tu cong, ke ca che do thay toan bo', async () => {
  const { db, service } = await fixture();
  try {
    const buffer = workbook([HEADER, ['AAA1', '2T x 100', '', 'H1'], ['aaa1', '3T x 100 + 1T x 50', '16/10', 'h1'], ['AAA1', '1T x 20', '', 'H2']]);
    const done = await service.importFile(ctx(), 'SG', { mode: 'replace', commit: true, buffer, fileName: 'trung.xlsx' });
    assert.equal(done.counts.added, 2);
    const rows = (await service.list(ctx(), 'SG')).rows;
    assert.deepEqual(rows.map(r => [r.code, r.notes, r.arrivalDate, r.location]), [['AAA1', '5T x 100 + 1T x 50', '16/10', 'H1'], ['AAA1', '1T x 20', '', 'H2']]);
  } finally { await db.close(); }
});

test('deduct thông minh trong cùng vị trí nhiều quy cách: 3T x 200 + 1T x 50 trừ 250 còn 2T x 200', async () => {
  const { db, service } = await fixture();
  try {
    const { row } = await service.create(ctx(), 'HN', { code: 'AAA1', notes: '3T x 200 + 1T x 50', location: 'H1' });
    const result = await service.deduct(ctx(), row.id, { version: 1, quantity: 250 });
    assert.equal(result.row.notes, '2T x 200');
    assert.equal(result.row.quantity, 400);
    assert.deepEqual(result.row.warnings, []);
  } finally { await db.close(); }
});

test('historyAll: lọc theo hành động và từ khóa không dấu, tôn trọng phạm vi cơ sở', async () => {
  const { db, service } = await fixture();
  try {
    const { row } = await service.create({ user: { id: 'u2', hoTen: 'Nguyễn Văn Đạt' }, scope: ['HN', 'SG'] }, 'HN', { code: 'AAA1', notes: '3T x 100', location: 'H1' });
    await service.update(ctx(), row.id, { version: row.version, notes: '2T x 100' });
    await service.create(ctx(), 'SG', { code: 'BBB2', notes: '1T x 5', location: 'S1' });
    const all = await service.historyAll(ctx(), 'HN');
    assert.equal(all.truncated, false);
    assert.ok(all.rows.length >= 2);
    assert.ok(all.rows.every(entry => entry.branch === 'HN'));
    assert.deepEqual((await service.historyAll(ctx(), 'HN', { action: 'edit' })).rows.map(h => h.action), ['edit']);
    assert.deepEqual((await service.historyAll(ctx(), 'HN', { q: 'nguyen van dat' })).rows.map(h => h.action), ['create']);
    assert.equal((await service.historyAll(ctx(), 'HN', { q: 'ĐẠT', action: 'create' })).rows.length, 1);
    assert.equal((await service.historyAll(ctx(), 'HN', { q: '2t x 100' })).rows.length, 1);
    assert.equal((await service.historyAll(ctx(), 'HN', { q: 'sửa' })).rows[0].action, 'edit');
    assert.equal((await service.historyAll(ctx(), 'HN', { q: 'khong-co-tu-nay' })).rows.length, 0);
    await assert.rejects(() => service.historyAll(ctx(['SG']), 'HN'), { code: 'BRANCH_OUT_OF_SCOPE' });
    await assert.rejects(() => service.historyAll(ctx(), 'XX'), { code: 'INVALID_BRANCH' });
  } finally { await db.close(); }
});

test('list: Có thể bốc = SL kho trừ giữ chỗ của các đơn Đang bốc (confirmed/cancelled không tính), bằng 1 truy vấn gộp', async () => {
  const { db, service } = await fixture({ lines: [
    { branch: 'HN', code: 'AAA1', name: 'A', notes: '3T x 100', location: 'H1' },
    { branch: 'HN', code: 'BBB2', name: 'B', notes: '1T x 5', location: 'H2' },
    { branch: 'HN', code: 'FFF6', name: 'F', notes: 'T x Ghi chú lạ', location: 'H3' },
    { branch: 'SG', code: 'AAA1', name: 'A', notes: '2T x 100', location: 'S1' }
  ] });
  try {
    await db.exec(migration('0096_order_pick_assignments.sql'));
    await db.exec(migration('0097_order_pick_assignment_snapshots.sql'));
    await db.exec(migration('0098_order_pick_history_mismatch_ack.sql'));
    const hn = (await service.list(ctx(), 'HN')).rows;
    const sg = (await service.list(ctx(), 'SG')).rows;
    const [a, b] = hn;
    const assign = async (branch, orderCode, status) =>
      Number((await db.query(`INSERT INTO order_pick_assignments (branch, order_code, status) VALUES ($1, $2, $3) RETURNING id`, [branch, orderCode, status])).rows[0].id);
    const line = (assignmentId, position, reserved) => db.query(
      `INSERT INTO order_pick_lines (assignment_id, product_code, position_id, location, planned_qty, reserved_qty) VALUES ($1, $2, $3, $4, $5, $6)`,
      [assignmentId, position.code, position.id, position.location, 50, reserved]);
    await line(await assign('HN', 'DH1', 'picking'), a, 120);
    await line(await assign('HN', 'DH2', 'picking'), a, 30);
    await line(await assign('HN', 'DH3', 'confirmed'), a, 0);
    await line(await assign('HN', 'DH4', 'cancelled'), a, 99);
    await line(await assign('HN', 'DH5', 'picking'), b, 9); // giữ vượt SL: không âm
    await line(await assign('SG', 'DH6', 'picking'), sg[0], 40);
    const after = (await service.list(ctx(), 'HN')).rows;
    assert.deepEqual(after.map(r => [r.quantity, r.held, r.available]), [[300, 150, 150], [5, 9, 0], [null, 0, null]]);
    const afterSg = (await service.list(ctx(), 'SG')).rows;
    assert.deepEqual(afterSg.map(r => [r.quantity, r.held, r.available]), [[200, 40, 160]]);
  } finally { await db.close(); }
});

test('list: chưa áp migration giữ chỗ (0096) thì Có thể bốc = SL kho, bảng không hỏng', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', name: 'A', notes: '3T x 100', location: 'H1' }] });
  try {
    const { rows } = await service.list(ctx(), 'HN');
    assert.deepEqual([rows[0].quantity, rows[0].held, rows[0].available], [300, 0, 300]);
  } finally { await db.close(); }
});

test('ack: Đã sửa cho dòng có cảnh báo (kể cả Mã SP lạ), giữ khi sửa ghi chú, bỏ đánh dấu, ghi lịch sử, tăng version', async () => {
  const { db, service } = await fixture();
  try {
    const bad = (await service.create(ctx(), 'HN', { code: 'AAA1', notes: 'rác', location: 'A1' })).row;
    assert.deepEqual(bad.warnings, ['unreadable']);
    assert.equal(bad.acknowledged, false);
    const acked = (await service.acknowledge(ctx(), bad.id, { version: bad.version, acknowledged: true })).row;
    assert.equal(acked.acknowledged, true);
    assert.deepEqual(acked.warnings, []);
    assert.deepEqual(acked.rawWarnings, ['unreadable']);
    assert.equal(acked.version, bad.version + 1);
    assert.equal(acked.updatedAt, bad.updatedAt, 'Đã sửa không phải sửa dữ liệu nên không đổi giờ/người cập nhật');
    const edited = (await service.update(ctx(), bad.id, { version: acked.version, notes: 'vẫn rác' })).row;
    assert.equal(edited.acknowledged, true, 'sửa ghi chú không tự bỏ cờ');
    assert.deepEqual(edited.warnings, []);
    assert.deepEqual(edited.rawWarnings, ['unreadable']);
    const unknown = (await service.create(ctx(), 'HN', { code: 'ZZZ9', notes: '1T x 5', location: 'B1' })).row;
    assert.deepEqual(unknown.warnings, ['unknowncode']);
    assert.deepEqual((await service.acknowledge(ctx(), unknown.id, { version: unknown.version, acknowledged: true })).row.warnings, []);
    const back = (await service.acknowledge(ctx(), bad.id, { version: edited.version, acknowledged: false })).row;
    assert.equal(back.acknowledged, false);
    assert.deepEqual(back.warnings, ['unreadable']);
    const log = (await db.query(`SELECT action, actor_name FROM stock_position_history WHERE action IN ('ack', 'unack') ORDER BY id`)).rows;
    assert.deepEqual(log.map(r => [r.action, r.actor_name]), [['ack', 'Quản Lý A'], ['ack', 'Quản Lý A'], ['unack', 'Quản Lý A']]);
    // lặp lại cùng trạng thái: không tăng version, không ghi lịch sử
    assert.equal((await service.acknowledge(ctx(), bad.id, { version: back.version, acknowledged: false })).row.version, back.version);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_position_history WHERE action IN ('ack', 'unack')`)).rows[0].n, 3);
    await assert.rejects(() => service.acknowledge(ctx(), bad.id, { version: back.version, acknowledged: 'yes' }), { statusCode: 400, code: 'VALIDATION' });
    const fine = (await service.create(ctx(), 'HN', { code: 'AAA1', notes: '2T x 10', location: 'C1' })).row;
    await assert.rejects(() => service.acknowledge(ctx(), fine.id, { version: fine.version, acknowledged: true }), { statusCode: 409, code: 'NOTHING_TO_ACK' });
    await assert.rejects(() => service.acknowledge(ctx(), bad.id, { version: 1, acknowledged: true }), { statusCode: 409, code: 'VERSION_CONFLICT' });
    await assert.rejects(() => service.acknowledge(ctx(['SG']), bad.id, { version: back.version, acknowledged: true }), { statusCode: 403, code: 'BRANCH_OUT_OF_SCOPE' });
  } finally { await db.close(); }
});

test('purgeHistory: xóa theo khoảng ngày giờ VN, chỉ cơ sở chỉ định, để lại dòng history_purged, UPDATE vẫn bị chặn', async () => {
  const { db, service } = await fixture();
  try {
    const add = (branch, iso, code) => db.query(`INSERT INTO stock_position_history (branch, created_at, code, action, actor_name) VALUES ($1, $2, $3, 'edit', 'x')`, [branch, iso, code]);
    await add('HN', '2026-10-01T16:59:00Z', 'D1'); // 01/10 23:59 giờ VN
    await add('HN', '2026-10-01T17:00:00Z', 'D2'); // 02/10 00:00
    await add('HN', '2026-10-03T16:59:59Z', 'D3'); // 03/10 23:59:59
    await add('HN', '2026-10-03T17:00:00Z', 'D4'); // 04/10 00:00
    await add('SG', '2026-10-02T05:00:00Z', 'S1');
    const result = await service.purgeHistory(ctx(), 'HN', { from: '2026-10-02', to: '2026-10-03' });
    assert.deepEqual(result, { deleted: 2, from: '2026-10-02', to: '2026-10-03' });
    const left = (await db.query(`SELECT code FROM stock_position_history WHERE code <> '' ORDER BY code`)).rows.map(r => r.code);
    assert.deepEqual(left, ['D1', 'D4', 'S1']);
    const purged = (await db.query(`SELECT branch, actor_name, summary FROM stock_position_history WHERE action = 'history_purged'`)).rows;
    assert.equal(purged.length, 1);
    assert.equal(purged[0].branch, 'HN');
    assert.equal(purged[0].actor_name, 'Quản Lý A');
    assert.deepEqual(purged[0].summary, { deleted: 2, from: '2026-10-02', to: '2026-10-03' });
    // Xóa toàn bộ cơ sở: gồm cả dòng history_purged cũ, rồi để lại 1 dòng mới
    assert.equal((await service.purgeHistory(ctx(), 'HN', {})).deleted, 3);
    const hn = (await db.query(`SELECT action, summary FROM stock_position_history WHERE branch = 'HN'`)).rows;
    assert.deepEqual(hn.map(r => r.action), ['history_purged']);
    assert.deepEqual(hn[0].summary, { deleted: 3, from: null, to: null });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_position_history WHERE branch = 'SG'`)).rows[0].n, 1);
    // Ngoài hàm purge vẫn bất biến; trong giao dịch có cờ purge thì UPDATE vẫn bị chặn
    await assert.rejects(() => db.query('DELETE FROM stock_position_history'), /immutable/);
    await db.exec(`BEGIN; SELECT set_config('app.history_purge', 'on', true);`);
    await assert.rejects(() => db.query(`UPDATE stock_position_history SET actor_name = 'y'`), /immutable/);
    await db.exec('ROLLBACK');
    await assert.rejects(() => service.purgeHistory(ctx(['SG']), 'HN', {}), { statusCode: 403, code: 'BRANCH_OUT_OF_SCOPE' });
    await assert.rejects(() => service.purgeHistory(ctx(), 'HN', { from: '2026-13-40' }), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(() => service.purgeHistory(ctx(), 'HN', { from: '2026-10-05', to: '2026-10-01' }), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(() => service.purgeHistory(ctx(), 'XX', {}), { statusCode: 400, code: 'INVALID_BRANCH' });
  } finally { await db.close(); }
});

test('normalizeStoredNote: số trần = 1 thùng, gộp cộng dồn, thống nhất ký hiệu', () => {
  const carton = require('../public/shared/carton.js');
  assert.equal(carton.normalizeStoredNote('60'), '1T x 60');
  assert.equal(carton.normalizeStoredNote(' 150 '), '1T x 150');
  assert.equal(carton.normalizeStoredNote('1t*150'), '1T x 150');
  assert.equal(carton.normalizeStoredNote('1tx432'), '1T x 432');
  assert.equal(carton.normalizeStoredNote('50Tx50 + 70Tx50 + 5Tx50'), '125T x 50');
  assert.equal(carton.normalizeStoredNote('0'), '0');
  assert.equal(carton.normalizeStoredNote('abc'), carton.normalizeNote('abc'));
});

test('normalizeAllNotes: dry-run không ghi; --apply đổi ghi chú, tăng version, ghi lịch sử; chạy lại không đổi gì', async () => {
  const { db, service } = await fixture();
  try {
    await db.query(`INSERT INTO stock_positions (branch, code, name, notes, location) VALUES
      ('HN', 'AAA1', '', '60', 'A1'), ('HN', 'BBB2', '', '50Tx50 + 70tx50', 'A2'), ('HN', 'AAA1', '', '3T x 100', 'A3'), ('SG', 'AAA1', '', '1t*150', 'H1')`);
    const dry = await service.normalizeAllNotes({ branch: 'HN' });
    assert.equal(dry.changed, 2);
    assert.equal((await db.query(`SELECT notes FROM stock_positions WHERE location = 'A1'`)).rows[0].notes, '60');
    const applied = await service.normalizeAllNotes({ branch: 'HN', dryRun: false });
    assert.equal(applied.changed, 2);
    const notes = Object.fromEntries((await db.query(`SELECT location, notes, version FROM stock_positions WHERE branch = 'HN'`)).rows.map(r => [r.location, r.notes]));
    assert.deepEqual(notes, { A1: '1T x 60', A2: '120T x 50', A3: '3T x 100' });
    assert.equal((await db.query(`SELECT notes FROM stock_positions WHERE branch = 'SG'`)).rows[0].notes, '1t*150', 'không đụng cơ sở khác');
    const history = (await db.query(`SELECT action, old_value, new_value, actor_name FROM stock_position_history WHERE summary->>'normalized' = 'true' ORDER BY id`)).rows;
    assert.equal(history.length, 2);
    assert.equal(history[0].action, 'edit');
    assert.equal(history[0].old_value, '60');
    assert.equal((await service.normalizeAllNotes({ branch: 'HN', dryRun: false })).changed, 0);
  } finally { await db.close(); }
});

test('mergeDuplicateRows: dry-run không ghi; --apply cộng ghi chú dòng trùng (mã, vị trí) vào dòng id nhỏ nhất, xóa dòng thừa, ghi lịch sử; bỏ qua nhóm sai định dạng', async () => {
  const { db, service } = await fixture();
  try {
    await db.query(`INSERT INTO stock_positions (branch, code, name, notes, arrival_date, location) VALUES
      ('HN', 'AAA1', '', '1T x 100', 'KK 4.10', '30'), ('HN', 'AAA1', '', '1T x 100', '', ' 30 '),
      ('HN', 'BBB2', '', '2T x 10', '', 'A1'), ('HN', 'BBB2', '', 'rác', '', 'A1'),
      ('HN', 'AAA1', '', '3T x 5', '', 'B2'), ('SG', 'AAA1', '', '1T x 100', '', '30'), ('SG', 'AAA1', '', '1T x 100', '', '30')`);
    const dry = await service.mergeDuplicateRows({ branch: 'HN' });
    assert.equal(dry.groups, 1);
    assert.equal(dry.removed, 1);
    assert.equal(dry.skipped.length, 1);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_positions WHERE branch = 'HN'`)).rows[0].n, 5);
    const applied = await service.mergeDuplicateRows({ branch: 'HN', dryRun: false });
    assert.equal(applied.removed, 1);
    const rows = (await db.query(`SELECT code, location, notes, arrival_date, version FROM stock_positions WHERE branch = 'HN' ORDER BY id`)).rows;
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0], { code: 'AAA1', location: '30', notes: '2T x 100', arrival_date: 'KK 4.10', version: 2 });
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM stock_positions WHERE branch = 'SG'`)).rows[0].n, 2, 'không đụng cơ sở khác');
    const history = (await db.query(`SELECT action FROM stock_position_history WHERE actor_name = 'Gộp dòng trùng' ORDER BY id`)).rows.map(r => r.action);
    assert.deepEqual(history, ['edit', 'delete']);
    assert.equal((await service.mergeDuplicateRows({ branch: 'HN', dryRun: false })).removed, 0);
  } finally { await db.close(); }
});

test('mergeNotes: ghi chú số trần được hiểu là 1 thùng', () => {
  assert.equal(mergeNotes('60', '2T x 60'), '3T x 60');
});

test('suggestCodes: khop ma (bo khoang trang, hoa/thuong) hoac ten, ma bat dau bang tu khoa xep truoc, rong thi tra rong', async () => {
  const { db, service } = await fixture();
  try {
    const byCode = await service.suggestCodes(ctx(), 'HN', ' aaa ');
    assert.ok(byCode.items.length >= 1);
    assert.ok(byCode.items.every(item => item.code.includes('AAA')));
    assert.equal(byCode.items[0].code, 'AAA1');
    assert.equal(byCode.items[0].name, 'Hàng A một');
    assert.deepEqual((await service.suggestCodes(ctx(), 'HN', '')).items, []);
    assert.deepEqual((await service.suggestCodes(ctx(), 'HN', '%')).items, []);
  } finally {
    await db.close();
  }
});

function collectChanges(t) {
  const seen = [];
  const listener = payload => seen.push(payload.branch);
  events.on(CHANGED, listener);
  t.after(() => events.off(CHANGED, listener));
  return seen;
}

test('phat tin hieu doi sau khi COMMIT, dung co so, khong phat khi doc', async t => {
  const { db, service } = await fixture();
  const seen = collectChanges(t);
  try {
    await service.list(ctx(), 'HN');
    assert.deepEqual(seen, []);
    await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 10', location: 'Z1' });
    assert.deepEqual(seen, ['HN']);
    await service.create(ctx(), 'SG', { code: 'AAA1', notes: '1T x 10', location: 'Z2' });
    assert.deepEqual(seen, ['HN', 'SG']);
  } finally { await db.close(); }
});

test('khong phat tin hieu khi giao dich ROLLBACK, lan sau khong bi lan co so cu', async t => {
  const { db, service } = await fixture();
  const seen = collectChanges(t);
  try {
    const pool = poolFor(db);
    await assert.rejects(tx.withTransaction(pool, async client => { await tx.lockBranch(client, 'HN'); throw new Error('boom'); }), /boom/);
    assert.deepEqual(seen, []);
    await tx.withTransaction(pool, async client => { await tx.lockBranch(client, 'SG'); });
    assert.deepEqual(seen, ['SG']);
    await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 10', location: 'Z1' });
    assert.deepEqual(seen, ['SG', 'HN']);
  } finally { await db.close(); }
});

// ---- Xuất kho từ file (stockOutFile) ----

const stored = async db => (await db.query('SELECT code, location, notes, version, updated_by_name FROM stock_positions ORDER BY id')).rows;

test('stockOut: trừ đúng dòng (mã, vị trí) của cơ sở đang mở, tăng version, ghi người bấm; cột Ngày về có cũng bỏ qua', async () => {
  const { db, service } = await fixture({ lines: [
    { branch: 'HN', code: 'AAA1', notes: '5T x 100', location: 'A1' },
    { branch: 'HN', code: 'AAA1', notes: '2T x 50', location: 'A2' },
    { branch: 'SG', code: 'AAA1', notes: '5T x 100', location: 'A1' }
  ] });
  try {
    const buffer = workbook([HEADER, ['aaa1', '1T x 100', 'ngày bất kỳ', ' a 1 '], ['AAA1', '1T x 50', '', 'A2']]);
    const result = await service.stockOutFile(ctx(), 'HN', { buffer, fileName: 'xuat.xlsx' });
    assert.deepEqual(result.counts, { fileRows: 2, applied: 2, updated: 2, deleted: 0, skipped: 0, quantity: 150 });
    assert.deepEqual(result.errors, []);
    assert.deepEqual((await stored(db)).map(r => [r.location, r.notes, r.version]), [['A1', '4T x 100', 2], ['A2', '1T x 50', 2], ['A1', '5T x 100', 1]]);
    assert.equal((await stored(db))[0].updated_by_name, 'Quản Lý A');
    assert.deepEqual((await service.list(ctx(), 'SG')).rows.map(r => r.notes), ['5T x 100']);
  } finally { await db.close(); }
});

test('stockOut: nhiều quy cách 3T x 200 + 1T x 50 trừ 250 còn 2T x 200; ghi chú nhiều quy cách trong file cũng trừ được', async () => {
  const { db, service } = await fixture({ lines: [
    { branch: 'HN', code: 'AAA1', notes: '3T x 200 + 1T x 50', location: 'A1' },
    { branch: 'HN', code: 'BBB2', notes: '4T x 100', location: 'B1' }
  ] });
  try {
    const result = await service.stockOutFile(ctx(), 'HN', { buffer: workbook([OUT_HEADER, ['AAA1', '1T x 200 + 1T x 50', 'A1'], ['BBB2', '2T x 100', 'B1']]) });
    assert.equal(result.counts.applied, 2);
    assert.deepEqual((await stored(db)).map(r => r.notes), ['2T x 200', '2T x 100']);
  } finally { await db.close(); }
});

test('stockOut: về 0 thì tự xóa dòng và ghi lịch sử stock_out (nhãn Xuất kho) kèm người bấm + file', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '2T x 100', location: 'A1' }, { branch: 'HN', code: 'BBB2', notes: '3T x 10', location: 'B1' }] });
  try {
    const result = await service.stockOutFile(ctx(), 'HN', { fileName: 'het.xlsx', buffer: workbook([OUT_HEADER, ['AAA1', '2T x 100', 'A1'], ['BBB2', '1T x 10', 'B1']]) });
    assert.deepEqual(result.counts, { fileRows: 2, applied: 2, updated: 1, deleted: 1, skipped: 0, quantity: 210 });
    assert.deepEqual((await stored(db)).map(r => r.code), ['BBB2']);
    const history = (await service.history(ctx(), 'HN')).rows.filter(h => h.action === 'stock_out');
    assert.equal(history.length, 2);
    const gone = history.find(h => h.code === 'AAA1');
    assert.deepEqual([gone.field, gone.oldValue, gone.newValue, gone.actorName], ['notes', '2T x 100', null, 'Quản Lý A']);
    assert.deepEqual(gone.summary, { deducted: 200, removed: true, fileName: 'het.xlsx', fileRows: [2] });
    const left = history.find(h => h.code === 'BBB2');
    assert.deepEqual([left.oldValue, left.newValue, left.summary.removed], ['3T x 10', '2T x 10', false]);
    assert.equal((await service.historyAll(ctx(), 'HN', { action: 'stock_out' })).rows.length, 2);
    assert.equal((await service.historyAll(ctx(), 'HN', { q: 'xuất kho' })).rows.length, 2);
  } finally { await db.close(); }
});

test('stockOut: dòng sai bị bỏ qua kèm số dòng Excel + lý do, dòng hợp lệ vẫn trừ; không có dòng hợp lệ thì không ghi gì', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '2T x 100', location: 'A1' }] });
  try {
    const buffer = workbook([OUT_HEADER,
      ['AAA1', '1T x 100', 'A1'], // 2: hợp lệ
      ['AAA1', '1T x 100', 'Z9'], // 3: không có vị trí đó
      ['ZZZ9', '1T x 5', 'A1'], // 4: không có mã
      ['AAA1', 'rác', 'A1'], // 5: ghi chú sai định dạng
      ['AAA1', '', 'A1'], // 6: ghi chú trống
      ['AAA1', '5T x 100', 'A1'], // 7: vượt tồn (còn 100)
      ['', '1T x 5', 'A1'], // 8: thiếu mã
      ['AAA1', '1T x 5', ''] // 9: thiếu vị trí
    ]);
    const result = await service.stockOutFile(ctx(), 'HN', { buffer });
    assert.deepEqual(result.counts, { fileRows: 8, applied: 1, updated: 1, deleted: 0, skipped: 7, quantity: 100 });
    assert.deepEqual(result.errors.map(e => [e.row, e.code, e.location]), [[3, 'AAA1', 'Z9'], [4, 'ZZZ9', 'A1'], [5, 'AAA1', 'A1'], [6, 'AAA1', 'A1'], [7, 'AAA1', 'A1'], [8, '', 'A1'], [9, 'AAA1', '']]);
    assert.match(result.errors[0].message, /Không có dòng/u);
    assert.match(result.errors[2].message, /sai định dạng/u);
    assert.match(result.errors[4].message, /vượt quá/u);
    assert.equal((await stored(db))[0].notes, '1T x 100');
    const before = (await db.query('SELECT count(*)::int AS n FROM stock_position_history')).rows[0].n;
    const none = await service.stockOutFile(ctx(), 'HN', { buffer: workbook([OUT_HEADER, ['ZZZ9', '1T x 5', 'A1']]) });
    assert.deepEqual([none.counts.applied, none.counts.skipped], [0, 1]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM stock_position_history')).rows[0].n, before);
    assert.equal((await stored(db))[0].version, 2);
  } finally { await db.close(); }
});

test('stockOut: dòng trùng (mã, vị trí) trong file trừ tuần tự theo thứ tự file; tổng không vượt tồn, dòng làm vượt bị bỏ qua riêng, 1 lịch sử cho mỗi vị trí', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '3T x 100', location: 'A1' }] });
  try {
    const buffer = workbook([OUT_HEADER, ['AAA1', '1T x 100', 'A1'], ['AAA1', '1T x 100', 'A1'], ['AAA1', '2T x 100', 'A1'], ['aaa1', '1T x 100', 'a1']]);
    const result = await service.stockOutFile(ctx(), 'HN', { fileName: 'trung.xlsx', buffer });
    // Dòng 4 (2T x 100) vượt phần còn lại (100) nên bỏ qua; dòng 5 vẫn trừ được và làm hết hàng.
    assert.deepEqual(result.counts, { fileRows: 4, applied: 3, updated: 0, deleted: 1, skipped: 1, quantity: 300 });
    assert.deepEqual(result.errors.map(e => e.row), [4]);
    assert.match(result.errors[0].message, /có thể xuất \(100\)/u);
    assert.deepEqual(await stored(db), []);
    const history = (await service.history(ctx(), 'HN')).rows.filter(h => h.action === 'stock_out');
    assert.equal(history.length, 1);
    assert.deepEqual(history[0].summary, { deducted: 300, removed: true, fileName: 'trung.xlsx', fileRows: [2, 3, 5] });
  } finally { await db.close(); }
});

test('stockOut: dòng trùng cuối cùng làm hết hàng thì các dòng sau bị bỏ qua vì còn 0', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '2T x 100', location: 'A1' }] });
  try {
    const result = await service.stockOutFile(ctx(), 'HN', { buffer: workbook([OUT_HEADER, ['AAA1', '1T x 100', 'A1'], ['AAA1', '1T x 100', 'A1'], ['AAA1', '1T x 100', 'A1']]) });
    assert.deepEqual([result.counts.applied, result.counts.deleted, result.counts.skipped], [2, 1, 1]);
    assert.deepEqual(await stored(db), []);
  } finally { await db.close(); }
});

test('stockOut: trừ phần lẻ khi SL không tròn thùng (số trần = 1 thùng)', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '3T x 100', location: 'A1' }] });
  try {
    await service.stockOutFile(ctx(), 'HN', { buffer: workbook([OUT_HEADER, ['AAA1', '30', 'A1']]) });
    assert.equal((await stored(db))[0].notes, '3T x 100 - 30');
  } finally { await db.close(); }
});

test('stockOut: không xuất phần đang bị phiếu bốc giữ chỗ (Đang bốc); đủ phần còn lại thì trừ', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '3T x 100', location: 'A1' }] });
  try {
    await db.exec(migration('0096_order_pick_assignments.sql'));
    await db.exec(migration('0101_stock_position_stock_out_action.sql')); // 0096 dựng lại CHECK cũ; nạp lại bản đầy đủ
    const [position] = (await service.list(ctx(), 'HN')).rows;
    const assignment = Number((await db.query(`INSERT INTO order_pick_assignments (branch, order_code, status) VALUES ('HN', 'DH1', 'picking') RETURNING id`)).rows[0].id);
    await db.query(`INSERT INTO order_pick_lines (assignment_id, product_code, position_id, location, planned_qty, reserved_qty) VALUES ($1, 'AAA1', $2, 'A1', 120, 120)`, [assignment, position.id]);
    const result = await service.stockOutFile(ctx(), 'HN', { buffer: workbook([OUT_HEADER, ['AAA1', '2T x 100', 'A1'], ['AAA1', '1T x 100', 'A1']]) });
    // Còn 300, giữ chỗ 120 -> có thể xuất 180: dòng 2 (200) bị bỏ qua, dòng 3 (100) trừ được.
    assert.deepEqual([result.counts.applied, result.counts.skipped], [1, 1]);
    assert.equal(result.errors[0].row, 2);
    assert.match(result.errors[0].message, /có thể xuất \(180\)/u);
    assert.equal((await stored(db))[0].notes, '2T x 100');
  } finally { await db.close(); }
});

test('stockOut: file thiếu cột bắt buộc / không đọc được / rỗng / thiếu file; phạm vi cơ sở; cơ sở không hợp lệ', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '3T x 100', location: 'A1' }] });
  try {
    await assert.rejects(() => service.stockOutFile(ctx(), 'HN', { buffer: workbook([['Mã hàng', 'Vị trí'], ['AAA1', 'A1']]) }), error => error.code === 'IMPORT_HEADERS_MISSING' && /Ghi chú/u.test(error.message));
    await assert.rejects(() => service.stockOutFile(ctx(), 'HN', { buffer: workbook([['Mã hàng', 'Ghi chú'], ['AAA1', '1T x 1']]) }), error => error.code === 'IMPORT_HEADERS_MISSING' && /Vị trí/u.test(error.message));
    await assert.rejects(() => service.stockOutFile(ctx(), 'HN', { buffer: workbook([['Tên', 'Giá'], ['x', 1]]) }), { code: 'IMPORT_HEADERS_MISSING' });
    await assert.rejects(() => service.stockOutFile(ctx(), 'HN', { buffer: workbook([OUT_HEADER]) }), { code: 'IMPORT_EMPTY_FILE' });
    await assert.rejects(() => service.stockOutFile(ctx(), 'HN', { buffer: Buffer.from('không phải excel') }), error => ['IMPORT_UNREADABLE', 'IMPORT_HEADERS_MISSING'].includes(error.code));
    await assert.rejects(() => service.stockOutFile(ctx(), 'HN', {}), { code: 'IMPORT_FILE_REQUIRED' });
    const buffer = workbook([OUT_HEADER, ['AAA1', '1T x 100', 'A1']]);
    await assert.rejects(() => service.stockOutFile(ctx(['SG']), 'HN', { buffer }), { code: 'BRANCH_OUT_OF_SCOPE' });
    await assert.rejects(() => service.stockOutFile(ctx(), 'XX', { buffer }), { code: 'INVALID_BRANCH' });
    assert.equal((await stored(db))[0].notes, '3T x 100');
  } finally { await db.close(); }
});

test('stockOut: CSV UTF-8 có dấu; thứ tự cột tùy ý; tiêu đề không nằm ở dòng đầu', async () => {
  const { db, service } = await fixture({ lines: [{ branch: 'SG', code: 'AAA1', notes: '3T x 100', location: 'S1' }] });
  try {
    const csv = Buffer.from('﻿Danh sách xuất kho\nVị trí,Mã hàng,Ghi chú\nS1,AAA1,1T x 100\n', 'utf8');
    const result = await service.stockOutFile(ctx(), 'SG', { buffer: csv, fileName: 'xuat.csv' });
    assert.deepEqual([result.counts.applied, result.counts.skipped], [1, 0]);
    assert.equal((await stored(db))[0].notes, '2T x 100');
  } finally { await db.close(); }
});

test('stockOut: phát tín hiệu đổi sau COMMIT chỉ khi có dòng thật sự bị trừ', async t => {
  const { db, service } = await fixture({ lines: [{ branch: 'HN', code: 'AAA1', notes: '3T x 100', location: 'A1' }] });
  const seen = collectChanges(t);
  try {
    await service.stockOutFile(ctx(), 'HN', { buffer: workbook([OUT_HEADER, ['ZZZ', '1T x 1', 'A1']]) });
    assert.deepEqual(seen, []);
    await service.stockOutFile(ctx(), 'HN', { buffer: workbook([OUT_HEADER, ['AAA1', '1T x 100', 'A1']]) });
    assert.deepEqual(seen, ['HN']);
  } finally { await db.close(); }
});
