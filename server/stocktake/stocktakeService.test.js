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
    '0101_stock_position_stock_out_action.sql', '0105_stocktake.sql']) {
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

test('dot web da dong: M/L la ban chup, doi chieu doi sau do khong lam doi; dot nap tu sheet moi co fallback', async () => {
  const { db, service, session } = await fixture();
  await db.exec(`INSERT INTO products (branch, id, code, name, raw) VALUES ('saigon', 3, 'CCC3', 'Hàng C', '{"inventories":[{"onHand":0,"cost":50}]}')`);
  const { session: sg } = await service.createSession(ctx(), { branch: 'saigon', name: 'SG 29/10', dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  const { session: hn } = await service.updateSession(ctx(), session.id, { counterpartSessionId: sg.id, version: session.version });
  await service.closeSession(ctx(), hn.id, { version: hn.version });
  let board = await service.getBoard(ctx(), hn.id);
  assert.equal(rowOf(board, 'AAA1').otherDiff, -3);
  assert.equal(rowOf(board, 'CCC3').otherDiff, null);
  assert.deepEqual(board.counterpart, { id: sg.id, name: 'SG 29/10', branch: 'saigon', status: 'open' });
  await service.addLine(ctx(), sg.id, { productCode: 'CCC3', quantity: 2, zone: 'G1' });
  await service.addLine(ctx(), sg.id, { productCode: 'AAA1', quantity: 5, zone: 'G1' });
  board = await service.getBoard(ctx(), hn.id);
  assert.equal(rowOf(board, 'CCC3').otherDiff, null, 'web: NULL giu nguyen');
  assert.equal(rowOf(board, 'AAA1').otherDiff, -3, 'web: ban chup khong doi');
});

test('doi chieu ngoai pham vi co so bi chan 403 khi dat, doc van mo', async () => {
  const { service, session } = await fixture();
  const { session: sg } = await service.createSession(ctx(), { branch: 'saigon', name: 'SG', dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  const hnOnly = ctx(QL, ['hanoi']);
  await assert.rejects(service.createSession(hnOnly, { branch: 'hanoi', name: 'HN2', dateFrom: '2026-10-30', dateTo: '2026-10-30', counterpartSessionId: sg.id }),
    { statusCode: 403, code: 'BRANCH_OUT_OF_SCOPE' });
  await assert.rejects(service.updateSession(hnOnly, session.id, { counterpartSessionId: sg.id, version: session.version }),
    { statusCode: 403, code: 'BRANCH_OUT_OF_SCOPE' });
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

test('mau trang thai: luu theo ma, mau la bi tu choi, sua tren bang giu nguyen mau', async () => {
  const { service, session } = await fixture();
  const { note } = await service.saveNote(ctx(), session.id, 'AAA1', { statusText: 'mất ko thấy', statusColor: 'red' });
  assert.equal(note.statusColor, 'red');
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { statusColor: '#ff0000', version: note.version }), { statusCode: 400 });
  await service.saveCells(ctx(), session.id, { cells: [{ code: 'AAA1', column: 'statusText', value: 'tìm thấy' }] });
  let board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').note.statusText, rowOf(board, 'AAA1').note.statusColor], ['tìm thấy', 'red']);
  const latest = rowOf(board, 'AAA1').note;
  await service.saveNote(ctx(), session.id, 'AAA1', { statusColor: '', version: latest.version });
  board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').note.statusColor, '');
});

test('sua tren bang: nguoi kiem lai khop / mo ho / co so khac, combo, cum dung chung, xoa so tay, lich su cum o dot khac', async () => {
  const { db, service, session } = await fixture();
  await db.exec(`INSERT INTO hr_employees (id, branch, ho_ten) VALUES (502, 'hanoi', 'Thái Kho'), (503, 'hanoi', 'Thai Kho'), (504, 'saigon', 'Cận')`);
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });
  const rowNow = async code => rowOf(await service.getBoard(ctx(), session.id), code);

  // Cảnh (501) la nhan su HN duy nhat -> gan id; 'thai kho' trung 2 nhan su sau bo dau -> giu chu; 'Cận' chi co o SG -> giu chu
  await cells([{ code: 'AAA1', column: 'recheck', value: ' cảnh ' }, { code: 'BBB2', column: 'recheck', value: 'thai kho' }, { code: 'CCC3', column: 'recheck', value: 'Cận' }]);
  let a = await rowNow('AAA1');
  assert.deepEqual([a.note.recheckEmployeeId, a.note.recheckName], [501, '']);
  assert.deepEqual([(await rowNow('BBB2')).note.recheckEmployeeId, (await rowNow('BBB2')).note.recheckName], [null, 'thai kho']);
  assert.deepEqual([(await rowNow('CCC3')).note.recheckEmployeeId, (await rowNow('CCC3')).note.recheckName], [null, 'Cận']);

  // combo 'x' -> co, '0' -> khong; cum dung chung 2 ma (khac hoa thuong) -> Count = 2
  await cells([{ code: 'AAA1', column: 'combo', value: 'x' }, { code: 'AAA1', column: 'cluster', value: 'Cụm ấm' }, { code: 'BBB2', column: 'cluster', value: 'cụm ấm' }]);
  assert.equal((await rowNow('AAA1')).isCombo, true);
  assert.equal((await rowNow('BBB2')).clusterCount, 2);
  await cells([{ code: 'AAA1', column: 'combo', value: '0' }]);
  assert.equal((await rowNow('AAA1')).isCombo, false);

  // so dan tay KK truoc sai: ghi roi xoa (trong) -> het "dan tay"
  await cells([{ code: 'AAA1', column: 'prevDiffManual', value: '-1.234' }]);
  a = await rowNow('AAA1');
  assert.deepEqual([a.prevDiff, a.prevDiffManual], [-1234, true]);
  await cells([{ code: 'AAA1', column: 'prevDiffManual', value: '' }]);
  assert.equal((await rowNow('AAA1')).prevDiffManual, false);

  // Cum SP sua o dot nay hien trong lich su cua dot khac cung co so; cot ghi chu thi khong
  await cells([{ code: 'AAA1', column: 'cluster', value: 'Cụm B' }, { code: 'AAA1', column: 'statusText', value: 'sau' }]);
  const other = (await service.createSession(ctx(), { branch: 'hanoi', name: 'Đợt khác', dateFrom: '2026-10-30', dateTo: '2026-10-30' })).session;
  const { history } = await service.codeHistory(ctx(), other.id, 'AAA1');
  assert.ok(history.some(h => h.action === 'paste' && h.after.column === 'cluster' && h.after.cluster === 'Cụm B'));
  assert.ok(!history.some(h => h.action === 'paste' && h.after.column === 'statusText'));
});

test('nguoi kiem lai go tay: khop dung 1 nhan su cung co so thi gan id, khong thi giu chu, xoa duoc', async () => {
  const { service, session } = await fixture();
  let { note } = await service.saveNote(ctx(), session.id, 'AAA1', { recheckName: '  cảnh ' });
  assert.deepEqual([note.recheckEmployeeId, note.recheckName], [501, '']);
  ({ note } = await service.saveNote(ctx(), session.id, 'AAA1', { recheckName: 'THÁI KHO', version: note.version }));
  assert.deepEqual([note.recheckEmployeeId, note.recheckName], [null, 'THÁI KHO']);
  ({ note } = await service.saveNote(ctx(), session.id, 'AAA1', { recheckName: '', version: note.version }));
  assert.deepEqual([note.recheckEmployeeId, note.recheckName], [null, '']);
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { recheckName: 'x'.repeat(201), version: note.version }), { statusCode: 400 });
});

test('sua tren bang: nhieu cot cung ma (ghi chu + tag) 1 giao dich, ma la / gia tri sai, lich su source cells', async () => {
  const { db, service, session, announced } = await fixture();
  await db.exec(`INSERT INTO hr_employees (id, branch, ho_ten) VALUES (502, 'hanoi', 'Thái Kho')`);
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });
  const result = await cells([
    { code: 'aaa1', column: 'statusText', value: 'mất', expected: '' },
    { code: 'AAA1', column: 'reasonText', value: 'lý do', expected: '' },
    { code: 'AAA1', column: 'cluster', value: 'Cụm 1', expected: '' },
    { code: 'AAA1', column: 'combo', value: 'x', expected: false },
    { code: 'AAA1', column: 'recheck', value: 'thai kho', expected: '' },
    { code: 'AAA1', column: 'prevDiffManual', value: '-1.234', expected: null },
    { code: 'ZZZ9', column: 'statusText', value: 'x' },
    { code: 'BBB2', column: 'otherDiffManual', value: 'abc' }
  ]);
  assert.deepEqual(result.skipped, { notFound: 1, invalid: 1, unchanged: 0 });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.applied.map(a => [a.code, a.column, a.before, a.after]), [
    ['AAA1', 'statusText', '', 'mất'], ['AAA1', 'reasonText', '', 'lý do'], ['AAA1', 'cluster', '', 'Cụm 1'],
    ['AAA1', 'combo', false, true], ['AAA1', 'recheck', '', 'Thái Kho'], ['AAA1', 'prevDiffManual', null, -1234]
  ]);
  assert.equal(announced.at(-1), session.id);
  const a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.note.statusText, a.note.reasonText, a.cluster, a.isCombo, a.note.recheckEmployeeId, a.prevDiff, a.prevDiffManual],
    ['mất', 'lý do', 'Cụm 1', true, 502, -1234, true]);
  const { history } = await service.codeHistory(ctx(), session.id, 'AAA1');
  const own = history.filter(h => h.action === 'paste' && h.after.source === 'cells');
  assert.equal(own.length, 6);
  assert.ok(own.some(h => h.after.column === 'cluster' && h.after.cluster === 'Cụm 1'));
});

test('sua tren bang: expected lech -> conflict khong ghi, o khac van ghi; hoan tac; trong = xoa; so that; o lap', async () => {
  const { service, session } = await fixture();
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });
  await cells([{ code: 'AAA1', column: 'statusText', value: 'mất', expected: '' }, { code: 'AAA1', column: 'combo', value: 'x', expected: false }]);
  let a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  await service.saveNote(ctx(HUNG), session.id, 'AAA1', { statusText: 'Hưng sửa', statusColor: 'red', version: a.note.version });

  let result = await cells([
    { code: 'AAA1', column: 'statusText', value: 'của tôi', expected: 'mất' },
    { code: 'AAA1', column: 'printPage', value: '12', expected: '' }
  ]);
  assert.deepEqual(result.conflicts, [{ code: 'AAA1', column: 'statusText', current: 'Hưng sửa' }]);
  assert.deepEqual(result.applied.map(x => x.column), ['printPage']);
  a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.note.statusText, a.note.statusColor, a.note.printPage], ['Hưng sửa', 'red', '12'], 'mau trang thai giu nguyen');

  // hoan tac: gui lai before, expected = after
  result = await cells([{ code: 'AAA1', column: 'combo', value: '', expected: true }, { code: 'AAA1', column: 'printPage', value: '', expected: '12' }]);
  assert.deepEqual(result.applied.map(x => [x.column, x.after]), [['combo', false], ['printPage', '']], 'theo thu tu gui');
  a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.isCombo, a.note.printPage], [false, '']);

  // so that tu hoan tac khong bi doc thanh nghin; khong expected = khong kiem; o lap lay o cuoi; khong doi = unchanged
  result = await cells([
    { code: 'BBB2', column: 'otherDiffManual', value: 1.234 },
    { code: 'BBB2', column: 'statusText', value: 'cu' },
    { code: 'bbb2', column: 'statusText', value: 'moi' },
    { code: 'AAA1', column: 'statusText', value: 'Hưng sửa' }
  ]);
  assert.deepEqual(result.skipped, { notFound: 0, invalid: 0, unchanged: 1 });
  const b = rowOf(await service.getBoard(ctx(), session.id), 'BBB2');
  assert.deepEqual([b.otherDiff, b.note.statusText], [1.234, 'moi']);
});

test('sua tren bang: kiem tra dau vao, dot da dong', async () => {
  const { service, session } = await fixture();
  const send = body => service.saveCells(ctx(), session.id, body);
  await assert.rejects(send({ cells: [] }), { statusCode: 400 });
  await assert.rejects(send({}), { statusCode: 400 });
  await assert.rejects(send({ cells: Array(10001).fill({ code: 'AAA1', column: 'statusText', value: 'x' }) }), { statusCode: 400 });
  await assert.rejects(send({ cells: [{ code: 'AAA1', column: 'bogus', value: 'x' }] }), { statusCode: 400 });
  await assert.rejects(send({ cells: [{ code: 'AAA1', column: 'constructor', value: 'x' }] }), { statusCode: 400 });
  const fresh = await service.getBoard(ctx(), session.id);
  await service.closeSession(ctx(), session.id, { version: fresh.session.version });
  await assert.rejects(send({ cells: [{ code: 'AAA1', column: 'statusText', value: 'x' }] }), { statusCode: 409, code: 'STOCKTAKE_CLOSED' });
});
