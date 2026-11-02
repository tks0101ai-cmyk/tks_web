'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createStockTakeService } = require('./stocktakeService');

const MIGRATIONS = path.join(__dirname, '../db/migrations');
const migration = file => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

function poolFor(db) {
  const query = (sql, params) => db.query(sql, params);
  return { query, connect: async () => ({ query, release() {} }) };
}

const QL = { id: 'ql-1', hoTen: 'Quản Lý A - 123456789', username: 'ql' };
const HUNG = { id: 'hung', hoTen: 'Hưng', username: 'hung' };
const ctx = (user = QL, scope = ['hanoi', 'saigon']) => ({ user, scope });

async function fixture() {
  const db = new PGlite();
  for (const file of ['0001_core_master_data.sql', '0003_orders.sql', '0009_app_users_hr_employees.sql', '0041_hr_employee_status.sql',
    '0064_sheet_snapshots.sql', '0095_stock_positions.sql', '0099_stock_position_ack_and_history_purge.sql',
    '0101_stock_position_stock_out_action.sql', '0103_stocktake.sql']) {
    await db.exec(migration(file));
  }
  await db.exec(`
    INSERT INTO products (branch, id, code, name, raw) VALUES
      ('hanoi', 1, 'AAA1', 'Hàng A', '{"inventories":[{"onHand":10,"cost":1000}]}'),
      ('hanoi', 2, 'BBB2', 'Hàng B', '{"inventories":[{"onHand":5,"cost":200}]}'),
      ('hanoi', 3, 'CCC3', 'Hàng C', '{"inventories":[{"onHand":0,"cost":50}]}'),
      ('saigon', 1, 'AAA1', 'Hàng A', '{"inventories":[{"onHand":7,"cost":1000}]}');
    INSERT INTO customers (branch, id, code, name, raw) VALUES
      ('hanoi', 11, 'KH1', 'TEAM 1 : HIỂU KHO', '{}'),
      ('hanoi', 12, 'KH2', 'Khách thường', '{}');
    INSERT INTO orders (branch, id, code, order_date, customer_id, raw) VALUES
      ('hanoi', 101, 'DH101', '2026-10-29 09:00+07', 11, '{"statusValue":"Phiếu tạm","description":"G1-15"}'),
      ('hanoi', 102, 'DH102', '2026-10-29 23:30+07', 11, '{"statusValue":"Đã hủy","description":"G2"}'),
      ('hanoi', 103, 'DH103', '2026-10-29 10:00+07', 12, '{"statusValue":"Phiếu tạm"}'),
      ('hanoi', 104, 'DH104', '2026-10-30 00:30+07', 11, '{"statusValue":"Phiếu tạm"}');
    INSERT INTO order_details (branch, order_id, line_no, product_id, quantity, raw) VALUES
      ('hanoi', 101, 1, 1, 8, '{"productCode":"AAA1","note":"1t*8","quantity":8}'),
      ('hanoi', 101, 2, 3, 1, '{"productCode":"CCC3","quantity":1.5}'),
      ('hanoi', 102, 1, 1, 4, '{"productCode":"AAA1","quantity":4}'),
      ('hanoi', 103, 1, 2, 99, '{"productCode":"BBB2","quantity":99}'),
      ('hanoi', 104, 1, 2, 99, '{"productCode":"BBB2","quantity":99}');
    INSERT INTO customers (branch, id, code, name, raw) VALUES ('saigon', 21, 'KS1', 'TEAM 2 : SG', '{}');
    INSERT INTO orders (branch, id, code, order_date, customer_id, raw) VALUES ('saigon', 201, 'DS201', '2026-10-29 09:00+07', 21, '{}');
    INSERT INTO order_details (branch, order_id, line_no, product_id, quantity, raw) VALUES ('saigon', 201, 1, 1, 4, '{"productCode":"AAA1","quantity":4}');
    INSERT INTO hr_employees (id, branch, ho_ten) VALUES (501, 'hanoi', 'Cảnh');
    INSERT INTO stock_positions (branch, code, location, arrival_date) VALUES ('HN', 'AAA1', 'G1-15', 'KK 4.10');
  `);
  const announced = [];
  const service = createStockTakeService({ getDb: () => poolFor(db), announce: id => announced.push(id) });
  const { session } = await service.createSession(ctx(), { branch: 'hanoi', name: 'Đợt 29/10', dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  return { db, service, session, announced };
}

const ratioOf = (a, b) => Math.round((a / b) * 10000) / 10000;
const rowOf = (board, code) => board.rows.find(row => row.code === code);

test('bang doi chieu: don TEAM trong ngay (gio VN, ca don huy), khach thuong bi bo, Quen KK', async () => {
  const { service, session } = await fixture();
  const board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').counted, 12);
  assert.equal(rowOf(board, 'AAA1').diffQty, 2);
  assert.equal(rowOf(board, 'AAA1').diffValue, 2000);
  assert.equal(rowOf(board, 'AAA1').lines.find(l => l.orderId === 101).zone, 'G1-15');
  assert.equal(rowOf(board, 'AAA1').lines.find(l => l.orderId === 101).spec, '1t*8');
  assert.equal(rowOf(board, 'AAA1').lines.find(l => l.orderId === 101).team, 'TEAM 1 : HIỂU KHO');
  assert.deepEqual(rowOf(board, 'AAA1').latestPosition, { location: 'G1-15', arrivalDate: 'KK 4.10' });
  assert.equal(rowOf(board, 'CCC3').counted, 1.5, 'so luong le doc tu raw');
  assert.equal(rowOf(board, 'BBB2').counted, 0, 'don khach thuong / ngoai ngay khong tinh');
  assert.equal(rowOf(board, 'BBB2').forgotten, true);
  assert.deepEqual(board.employees.map(e => e.name), ['Cảnh']);
});

test('sua dong goc, xung dot version tra 409 kem ban moi va ten nguoi sua', async () => {
  const { service, session, announced } = await fixture();
  const { edit } = await service.saveLine(ctx(HUNG), session.id, { orderId: 101, lineNo: 1, quantity: 10, version: null });
  assert.equal(edit.version, 1);
  assert.deepEqual(announced, [session.id]);
  let board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').counted, 14);

  await assert.rejects(service.saveLine(ctx(), session.id, { orderId: 101, lineNo: 1, quantity: 3, version: null }), error => {
    assert.equal(error.statusCode, 409);
    assert.equal(error.code, 'STOCKTAKE_CONFLICT');
    assert.equal(error.latest.updatedByName, 'Hưng');
    assert.equal(error.latest.quantity, 10);
    assert.match(error.message, /^Hưng vừa sửa lúc \d{2}:\d{2}/u);
    return true;
  });
  await service.saveLine(ctx(), session.id, { orderId: 101, lineNo: 1, removed: true, version: 1 });
  board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').counted, 4);
});

test('dong khong thuoc don TEAM cua dot bi tu choi', async () => {
  const { service, session } = await fixture();
  await assert.rejects(service.saveLine(ctx(), session.id, { orderId: 103, lineNo: 1, quantity: 1 }), { statusCode: 404 });
});

test('them dong tay, sua dong tay theo editId', async () => {
  const { service, session } = await fixture();
  const { edit } = await service.addLine(ctx(), session.id, { productCode: 'bbb 2', quantity: 5, zone: 'G9' });
  assert.equal(edit.productCode, 'BBB2');
  let board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'BBB2').counted, 5);
  assert.equal(rowOf(board, 'BBB2').forgotten, false);
  await service.saveLine(ctx(), session.id, { editId: edit.id, quantity: 4, version: edit.version });
  board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'BBB2').diffQty, -1);
  await assert.rejects(service.addLine(ctx(), session.id, { productCode: '', quantity: 1 }), { statusCode: 400 });
  await assert.rejects(service.addLine(ctx(), session.id, { productCode: 'A', quantity: -1 }), { statusCode: 400 });
});

test('ghi chu ma + nguoi kiem lai, goi y trang thai; tag Cum SP giu qua dot', async () => {
  const { service, session } = await fixture();
  const { note } = await service.saveNote(ctx(), session.id, 'aaa1', { statusText: 'KK trước', reasonText: 'lẫn mã', recheckEmployeeId: 501 });
  assert.equal(note.recheckEmployeeId, 501);
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { statusText: 'ok', version: 99 }), { statusCode: 409 });
  await assert.rejects(service.saveNote(ctx(), session.id, 'BBB2', { recheckEmployeeId: 999 }), { statusCode: 400 });
  await service.saveTag(ctx(), session.id, 'AAA1', { cluster: 'Cụm ấm', isCombo: true });
  await service.saveTag(ctx(), session.id, 'BBB2', { cluster: 'cụm ấm' });
  const board = await service.getBoard(ctx(), session.id);
  assert.deepEqual(board.suggestions.status, ['KK trước']);
  assert.equal(rowOf(board, 'AAA1').isCombo, true);
  assert.equal(rowOf(board, 'AAA1').clusterDiff, 2 + -5);
  const { history } = await service.codeHistory(ctx(), session.id, 'AAA1');
  assert.deepEqual(history.map(h => h.action), ['tag', 'note']);
});

test('dong dot: chup ket qua, dot dong chi doc, dot sau co KK truoc', async () => {
  const { db, service, session } = await fixture();
  await assert.rejects(service.closeSession(ctx(), session.id, { version: 99 }), { statusCode: 409 });
  const { session: closed } = await service.closeSession(ctx(), session.id, { version: session.version });
  assert.equal(closed.status, 'closed');
  assert.equal(closed.closedByName, 'Quản Lý A');

  // Ton doi sau khi dong: dot da dong khong troi.
  await db.query(`UPDATE products SET raw = '{"inventories":[{"onHand":100,"cost":1000}]}' WHERE id = 1`);
  const board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').stock, 10);
  assert.equal(rowOf(board, 'AAA1').diffQty, 2);
  assert.equal(rowOf(board, 'BBB2').forgotten, true, 'Quen KK suy tu ban chup');
  assert.equal(board.totals.forgotten, 1);
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { statusText: 'x' }), { statusCode: 409, code: 'STOCKTAKE_CLOSED' });
  await assert.rejects(service.addLine(ctx(), session.id, { productCode: 'A', quantity: 1 }), { code: 'STOCKTAKE_CLOSED' });

  const { session: next } = await service.createSession(ctx(), { branch: 'hanoi', name: 'Đợt sau', dateFrom: '2026-10-30', dateTo: '2026-10-30' });
  const nextBoard = await service.getBoard(ctx(), next.id);
  assert.equal(nextBoard.previousSessionId, session.id);
  assert.equal(rowOf(nextBoard, 'AAA1').prevDiff, 2);
});

test('pham vi co so va kiem tra du lieu tao dot', async () => {
  const { service, session } = await fixture();
  await assert.rejects(service.getBoard(ctx(QL, ['saigon']), session.id), { statusCode: 403 });
  await assert.rejects(service.createSession(ctx(), { branch: 'hanoi', name: 'x', dateFrom: '2026-10-30', dateTo: '2026-10-29' }), { statusCode: 400 });
  await assert.rejects(service.createSession(ctx(), { branch: 'hn', name: 'x', dateFrom: '2026-10-29', dateTo: '2026-10-29' }), { code: 'INVALID_BRANCH' });
  const { sessions } = await service.listSessions(ctx(QL, ['saigon']));
  assert.deepEqual(sessions, []);
});

test('lich su chi them: UPDATE bi trigger chan', async () => {
  const { db } = await fixture();
  await assert.rejects(db.query(`UPDATE stocktake_history SET actor_name = 'x'`), /immutable/u);
});

test('dot doi chieu: Kiem SG tu dot SG dang mo / da dong, sai co so bi tu choi, doi bang PATCH', async () => {
  const { service, session } = await fixture();
  await assert.rejects(service.createSession(ctx(), { branch: 'hanoi', name: 'x', dateFrom: '2026-10-29', dateTo: '2026-10-29', counterpartSessionId: session.id }),
    { statusCode: 400, code: 'INVALID_COUNTERPART' });
  const { session: sg } = await service.createSession(ctx(), { branch: 'saigon', name: 'SG 29/10', dateFrom: '2026-10-29', dateTo: '2026-10-29', counterpartSessionId: session.id });
  assert.equal(sg.counterpartSessionId, session.id);
  const { session: hn } = await service.updateSession(ctx(), session.id, { counterpartSessionId: sg.id, version: session.version });
  assert.equal(hn.counterpartSessionId, sg.id);
  assert.equal(hn.version, session.version + 1);
  await assert.rejects(service.updateSession(ctx(), session.id, { counterpartSessionId: null, version: session.version }), { statusCode: 409 });

  let board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').otherDiff, -3, 'SG: dem 4, ton 7');
  assert.equal(rowOf(board, 'AAA1').otherRatio, ratioOf(2 + -3, -3));
  assert.deepEqual(board.counterpart, { id: sg.id, name: 'SG 29/10', branch: 'saigon', status: 'open' });

  await service.closeSession(ctx(), sg.id, { version: sg.version });
  board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').otherDiff, -3, 'tu ban chup dot SG');
});

test('ghi chu: trang in, gio in, so dan tay L/M; dong dot luu prev_diff / other_diff', async () => {
  const { db, service, session } = await fixture();
  const { note } = await service.saveNote(ctx(), session.id, 'AAA1', { printPage: '12', printTime: '14:30 03/10', prevDiffManual: -326, otherDiffManual: '-1,5' });
  assert.deepEqual([note.printPage, note.printTime, note.prevDiffManual, note.otherDiffManual], ['12', '14:30 03/10', -326, -1.5]);
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { printPage: 'x'.repeat(51), version: note.version }), { statusCode: 400 });
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { prevDiffManual: 'abc', version: note.version }), { statusCode: 400 });
  let board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').prevDiff, rowOf(board, 'AAA1').prevDiffManual], [-326, true]);

  const fresh = await service.getBoard(ctx(), session.id);
  await service.closeSession(ctx(), session.id, { version: fresh.session.version });
  const stored = (await db.query(`SELECT prev_diff::float8 AS p, other_diff::float8 AS o FROM stocktake_session_results WHERE product_code = 'AAA1'`)).rows[0];
  assert.deepEqual([stored.p, stored.o], [-326, -1.5]);
  board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').prevDiff, rowOf(board, 'AAA1').otherDiff], [-326, -1.5]);
  assert.equal(rowOf(board, 'AAA1').prevRatio, ratioOf(2 + -326, -326));
});

test('dan cot: tung loai cot, bo qua / xoa o trong, ma la, gia tri sai, lich su paste', async () => {
  const { db, service, session, announced } = await fixture();
  await db.exec(`INSERT INTO hr_employees (id, branch, ho_ten) VALUES (502, 'hanoi', 'Thái Kho')`);
  const paste = (column, rows, mode = 'skip') => service.pasteColumn(ctx(), session.id, { column, mode, rows });

  let result = await paste('prevDiffManual', [{ code: 'aaa1', value: '-1.234' }, { code: 'ZZZ9', value: '1' }, { code: 'BBB2', value: 'abc' }, { code: 'CCC3', value: '' }]);
  assert.deepEqual(result, { changed: 1, skipped: { notFound: 1, invalid: 1, unchanged: 0, empty: 1 } });
  assert.deepEqual(announced.at(-1), session.id);
  let board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').prevDiff, rowOf(board, 'AAA1').prevDiffManual], [-1234, true]);

  result = await paste('prevDiffManual', [{ code: 'AAA1', value: '' }], 'clear');
  assert.equal(result.changed, 1);
  board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').prevDiffManual, false);

  await paste('recheck', [{ code: 'AAA1', value: 'thai kho' }, { code: 'BBB2', value: 'CẬN' }]);
  await paste('combo', [{ code: 'AAA1', value: 'x' }]);
  await paste('cluster', [{ code: 'AAA1', value: 'Cụm ấm' }, { code: 'BBB2', value: 'cụm ấm' }]);
  result = await paste('statusText', [{ code: 'AAA1', value: 'mất ko thấy' }, { code: 'AAA1x', value: 'x' }]);
  assert.equal(result.skipped.notFound, 1);
  assert.equal((await paste('statusText', [{ code: 'AAA1', value: 'mất ko thấy' }])).skipped.unchanged, 1);

  board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').note.recheckEmployeeId, rowOf(board, 'AAA1').note.recheckName], [502, '']);
  assert.deepEqual([rowOf(board, 'BBB2').note.recheckEmployeeId, rowOf(board, 'BBB2').note.recheckName], [null, 'CẬN']);
  assert.equal(rowOf(board, 'AAA1').isCombo, true);
  assert.equal(rowOf(board, 'BBB2').clusterCount, 2);
  assert.equal(rowOf(board, 'AAA1').note.statusText, 'mất ko thấy');
  const { history } = await service.codeHistory(ctx(), session.id, 'AAA1');
  assert.ok(history.filter(h => h.action === 'paste').length >= 5);
  assert.deepEqual(history.find(h => h.action === 'paste').after.column, 'statusText');

  await assert.rejects(paste('bogus', [{ code: 'AAA1', value: '1' }]), { statusCode: 400 });
  await assert.rejects(service.pasteColumn(ctx(), session.id, { column: 'statusText', mode: 'skip', rows: Array(10001).fill({ code: 'AAA1', value: 'x' }) }), { statusCode: 400 });
  const fresh = await service.getBoard(ctx(), session.id);
  await service.closeSession(ctx(), session.id, { version: fresh.session.version });
  await assert.rejects(paste('statusText', [{ code: 'AAA1', value: 'y' }]), { statusCode: 409, code: 'STOCKTAKE_CLOSED' });
});
