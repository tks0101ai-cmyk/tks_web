'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const XLSX = require('xlsx');
const { createStockPositionsService } = require('./stockPositionsService');
const { createStockOutOrdersService, buildPlan } = require('./stockOutOrdersService');

const MIGRATIONS = path.join(__dirname, '../db/migrations');
const migration = file => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

function poolFor(db) {
  const query = (sql, params) => db.query(sql, params);
  return { query, connect: async () => ({ query, release() {} }) };
}

const QL = { id: 'ql-1', hoTen: 'Quản Lý A - 123456789', username: 'ql' };
const ctx = (scope = ['HN', 'SG']) => ({ user: QL, scope });

async function fixture({ positions = [], pickTables = false } = {}) {
  const db = new PGlite();
  await db.exec(migration('0001_core_master_data.sql'));
  await db.exec(migration('0064_sheet_snapshots.sql'));
  await db.exec(migration('0095_stock_positions.sql'));
  await db.exec(migration('0099_stock_position_ack_and_history_purge.sql'));
  await db.exec(migration('0101_stock_position_stock_out_action.sql'));
  if (pickTables) {
    await db.exec(migration('0096_order_pick_assignments.sql'));
    await db.exec(migration('0101_stock_position_stock_out_action.sql'));
  }
  await db.exec(migration('0104_stock_out_orders.sql'));
  await db.query(`INSERT INTO products (branch, id, code, name, raw) VALUES
    ('hanoi', 1, 'AAA1', 'Kem chống nắng', '{"inventories":[{"onHand":30}]}'),
    ('hanoi', 2, 'BBB2', 'Sữa rửa mặt', '{"inventories":[{"onHand":5}]}'),
    ('saigon', 3, 'AAA1', 'Kem chống nắng SG', '{"inventories":[{"onHand":7}]}')`);
  for (const p of positions) {
    await db.query(`INSERT INTO stock_positions (branch, code, notes, location) VALUES ($1, $2, $3, $4)`, [p.branch || 'HN', p.code, p.notes, p.location]);
  }
  const getDb = () => poolFor(db);
  return { db, orders: createStockOutOrdersService({ getDb }), positions: createStockPositionsService({ getDb }) };
}

const rowsOf = async db => (await db.query('SELECT code, location, notes FROM stock_positions ORDER BY id')).rows;
const workbook = rows => {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
};

test('đơn tạm: chỉ tạo khi có quyền sửa, mỗi cơ sở một đơn, mã XK-HN-00001', async () => {
  const { db, orders } = await fixture();
  try {
    assert.deepEqual(await orders.getCurrent(ctx(), 'HN'), { order: null });
    const first = (await orders.getCurrent(ctx(), 'HN', { create: true })).order;
    assert.equal(first.code, 'XK-HN-00001');
    assert.equal(first.status, 'draft');
    assert.equal((await orders.getCurrent(ctx(), 'HN', { create: true })).order.id, first.id, 'gọi lại vẫn là đơn tạm cũ');
    assert.equal((await orders.getCurrent(ctx(), 'SG', { create: true })).order.code, 'XK-SG-00001', 'mỗi cơ sở đếm riêng');
    await assert.rejects(orders.getCurrent(ctx(['SG']), 'HN'), { statusCode: 403 });
  } finally { await db.close(); }
});

test('dòng đơn tạm: không gộp, không đụng tồn VT, sửa/xóa theo version, tên lấy từ danh mục', async () => {
  const { db, orders } = await fixture({ positions: [{ code: 'AAA1', notes: '5T x 100', location: 'A1' }] });
  try {
    const { order } = await orders.getCurrent(ctx(), 'HN', { create: true });
    const a = await orders.addLine(ctx(), order.id, { code: 'aaa1', location: 'a 1', notes: '1tx100' });
    const b = await orders.addLine(ctx(), order.id, { code: 'AAA1', location: 'A1', notes: '2T x 100' });
    assert.equal(a.line.code, 'AAA1');
    assert.equal(a.line.name, 'Kem chống nắng');
    assert.equal(a.line.location, 'A1');
    assert.equal(a.line.notes, '1T x 100');
    assert.equal(b.line.sortOrder, 2);
    const current = (await orders.getCurrent(ctx(), 'HN')).order;
    assert.equal(current.lines.length, 2, 'cùng mã + vị trí vẫn tách dòng');
    assert.equal(current.lines[1].preview.after, '2T x 100', 'xem trước trừ tuần tự: 5T - 1T - 2T');
    assert.equal(current.lines[1].preview.negative, false);
    assert.deepEqual(await rowsOf(db), [{ code: 'AAA1', location: 'A1', notes: '5T x 100' }], 'chưa chốt thì tồn nguyên');

    await assert.rejects(orders.addLine(ctx(), order.id, { code: 'AAA1', location: 'A1', notes: 'abc' }), { code: 'VALIDATION' });
    await assert.rejects(orders.addLine(ctx(), order.id, { code: 'AAA1', location: '', notes: '1T x 5' }), { code: 'VALIDATION' });
    const edited = await orders.updateLine(ctx(), a.line.id, { notes: '3T x 100', version: a.line.version });
    assert.equal(edited.line.notes, '3T x 100');
    await assert.rejects(orders.updateLine(ctx(), a.line.id, { notes: '1T x 100', version: a.line.version }), { code: 'VERSION_CONFLICT' });
    const removed = await orders.removeLine(ctx(), b.line.id, b.line.version);
    assert.equal(removed.deleted, true);
    assert.equal((await orders.getCurrent(ctx(), 'HN')).order.lines.length, 1);
  } finally { await db.close(); }
});

test('chốt đơn: trừ gộp theo (mã, vị trí), dòng âm, tạo dòng VT chưa có, xóa dòng về 0, lịch sử kèm mã đơn', async () => {
  const { db, orders } = await fixture({ positions: [
    { code: 'AAA1', notes: '5T x 100', location: 'A1' },
    { code: 'BBB2', notes: '1T x 50', location: 'CONT' },
    { code: 'AAA1', notes: '3T x 100', location: 'CONT' }
  ] });
  try {
    const { order } = await orders.getCurrent(ctx(), 'HN', { create: true });
    await orders.addLine(ctx(), order.id, { code: 'AAA1', location: 'A1', notes: '3T x 100' });
    await orders.addLine(ctx(), order.id, { code: 'AAA1', location: 'A1', notes: '4T x 100' }); // tổng 7T x 100 > 5T x 100 -> -2T x 100
    await orders.addLine(ctx(), order.id, { code: 'BBB2', location: 'CONT', notes: '1T x 50' }); // về 0 -> xóa
    await orders.addLine(ctx(), order.id, { code: 'BBB2', location: 'B9', notes: '1T x 20' }); // chưa có dòng VT -> tạo dòng âm
    const version = (await orders.getCurrent(ctx(), 'HN')).order.version;

    await assert.rejects(orders.confirm(ctx(), order.id, { version: version - 1 }), { code: 'VERSION_CONFLICT' });
    const done = await orders.confirm(ctx(), order.id, { version });
    assert.equal(done.order.status, 'confirmed');
    assert.equal(done.order.confirmedByName, 'Quản Lý A');
    assert.deepEqual(done.stats, { positions: 3, lines: 4, quantity: 770, negative: 2, removed: 1, created: 1 });
    assert.deepEqual(await rowsOf(db), [
      { code: 'AAA1', location: 'A1', notes: '-2T x 100' },
      { code: 'AAA1', location: 'CONT', notes: '3T x 100' },
      { code: 'BBB2', location: 'B9', notes: '-1T x 20' }
    ]);
    const history = (await db.query(`SELECT code, location, action, old_value, new_value, summary, actor_name FROM stock_position_history WHERE action = 'stock_out' ORDER BY id`)).rows;
    assert.equal(history.length, 3);
    for (const entry of history) {
      assert.equal(entry.summary.source, 'order');
      assert.equal(entry.summary.orderCode, 'XK-HN-00001');
      assert.equal(entry.summary.orderId, Number(order.id));
      assert.equal(entry.actor_name, 'Quản Lý A');
    }
    const a1 = history.find(entry => entry.location === 'A1');
    assert.equal(a1.old_value, '5T x 100');
    assert.equal(a1.new_value, '-2T x 100');
    assert.equal(a1.summary.negative, true);
    assert.equal(history.find(entry => entry.location === 'CONT').new_value, null, 'dòng về 0 bị xóa');

    const detail = (await orders.get(ctx(), order.id)).order;
    assert.equal(detail.lines[1].result.negative, true);
    assert.equal(detail.lines[1].result.after, '-2T x 100');

    await assert.rejects(orders.confirm(ctx(), order.id, {}), { code: 'ORDER_CONFIRMED' });
    await assert.rejects(orders.addLine(ctx(), order.id, { code: 'AAA1', location: 'A1', notes: '1T x 5' }), { code: 'ORDER_CONFIRMED' });
    const next = (await orders.getCurrent(ctx(), 'HN', { create: true })).order;
    assert.equal(next.code, 'XK-HN-00002', 'chốt xong có đơn tạm mới, mã tăng dần');
    assert.equal(next.lines.length, 0);
    const listed = await orders.list(ctx(), 'HN');
    assert.deepEqual(listed.orders.map(o => [o.code, o.lineCount]), [['XK-HN-00001', 4]]);
  } finally { await db.close(); }
});

test('dòng âm tự bù khi cộng hàng vào đúng vị trí (Thêm dòng VT)', async () => {
  const { db, orders, positions } = await fixture({ positions: [{ code: 'AAA1', notes: '5T x 100', location: 'A1' }] });
  try {
    const { order } = await orders.getCurrent(ctx(), 'HN', { create: true });
    await orders.addLine(ctx(), order.id, { code: 'AAA1', location: 'A1', notes: '7T x 100' });
    await orders.confirm(ctx(), order.id, {});
    const [row] = (await positions.list(ctx(), 'HN')).rows;
    assert.equal(row.notes, '-2T x 100');
    assert.equal(row.quantity, -200);
    assert.equal(row.available, 0, 'Có thể bốc không âm');
    assert.deepEqual(row.warnings, ['negative']);
    const added = await positions.create(ctx(), 'HN', { code: 'AAA1', location: 'A1', notes: '5T x 100' });
    assert.equal(added.merged, true);
    assert.equal(added.row.notes, '3T x 100');
  } finally { await db.close(); }
});

test('chốt chặn dòng VT ghi chú không đọc được; import Excel liệt kê dòng sai', async () => {
  const { db, orders } = await fixture({ positions: [{ code: 'AAA1', notes: 'hỏng', location: 'A1' }] });
  try {
    const { order } = await orders.getCurrent(ctx(), 'HN', { create: true });
    const result = await orders.importLines(ctx(), order.id, {
      fileName: 'cont.xlsx',
      buffer: workbook([['Mã hàng', 'Ghi chú', 'Vị trí'], ['aaa1', '1T x 50', 'A1'], ['', '1T x 5', 'A1'], ['BBB2', 'xxx', 'B1'], ['BBB2', '2T x 5', '']])
    });
    assert.deepEqual(result.counts, { fileRows: 4, added: 1, skipped: 3 });
    assert.equal(result.errors.length, 3);
    const lines = (await orders.getCurrent(ctx(), 'HN')).order.lines;
    assert.equal(lines.length, 1);
    assert.equal(lines[0].source, 'excel');
    assert.equal(lines[0].preview.blocked, true);
    await assert.rejects(orders.confirm(ctx(), order.id, {}), { code: 'ORDER_BLOCKED' });
    assert.deepEqual(await rowsOf(db), [{ code: 'AAA1', location: 'A1', notes: 'hỏng' }], 'không trừ bừa');
  } finally { await db.close(); }
});

test('dòng bị đơn Đang bốc giữ chỗ: vẫn trừ, về 0 thì giữ dòng (không xóa) để phiếu bốc còn trỏ vào', async () => {
  const { db, orders } = await fixture({ pickTables: true, positions: [{ code: 'AAA1', notes: '2T x 100', location: 'A1' }] });
  try {
    const id = Number((await db.query('SELECT id FROM stock_positions')).rows[0].id);
    const a = (await db.query(`INSERT INTO order_pick_assignments (branch, order_code, status) VALUES ('HN', 'DH1', 'picking') RETURNING id`)).rows[0].id;
    await db.query(`INSERT INTO order_pick_lines (assignment_id, product_code, position_id, location, planned_qty, reserved_qty) VALUES ($1, 'AAA1', $2, 'A1', 100, 100)`, [a, id]);
    const { order } = await orders.getCurrent(ctx(), 'HN', { create: true });
    await orders.addLine(ctx(), order.id, { code: 'AAA1', location: 'A1', notes: '2T x 100' });
    const preview = (await orders.getCurrent(ctx(), 'HN')).order.lines[0].preview;
    assert.equal(preview.held, 100);
    await orders.confirm(ctx(), order.id, {});
    assert.deepEqual(await rowsOf(db), [{ code: 'AAA1', location: 'A1', notes: 'Hết hàng' }]);
  } finally { await db.close(); }
});

test('buildPlan thuần: tuần tự theo thứ tự dòng, dòng sai chặn cả nhóm', () => {
  const lines = [
    { id: 1, code: 'X', location: 'A', notes: '1T x 50', name: '' },
    { id: 2, code: 'x', location: 'a', notes: '1T x 50', name: '' },
    { id: 3, code: 'Y', location: 'B', notes: 'sai', name: '' }
  ];
  const positions = new Map([['x|A', { id: 9, code: 'X', location: 'A', notes: '1T x 50' }]]);
  const plan = buildPlan(lines, positions, new Map());
  const x = plan.groups.find(group => group.code === 'X');
  assert.equal(x.notes, '-1T x 50');
  assert.equal(x.negative, true);
  assert.equal(plan.perLine.get(1).after, 'Hết hàng');
  assert.equal(plan.perLine.get(2).negative, true);
  assert.equal(plan.groups.find(group => group.code === 'Y').blocked, true);
});

test('gợi ý theo tên: gõ không dấu vẫn ra tên có dấu', async () => {
  const { db, positions } = await fixture();
  try {
    assert.deepEqual((await positions.suggestCodes(ctx(), 'HN', 'kem chong nang')).items, [{ code: 'AAA1', name: 'Kem chống nắng' }]);
    assert.deepEqual((await positions.suggestCodes(ctx(), 'HN', 'Sữa rửa')).items.map(item => item.code), ['BBB2']);
    assert.deepEqual((await positions.suggestCodes(ctx(), 'HN', 'sua rua')).items.map(item => item.code), ['BBB2']);
    assert.deepEqual((await positions.suggestCodes(ctx(), 'SG', 'chong nang')).items.map(item => item.code), ['AAA1']);
  } finally { await db.close(); }
});
