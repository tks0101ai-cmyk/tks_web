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
    '0101_stock_position_stock_out_action.sql', '0105_stocktake.sql', '0109_stocktake_previous_cancel.sql']) {
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
  assert.equal('latestPosition' in rowOf(board, 'AAA1'), false, 'khong con vi tri kho');
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
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { statusText: 'OK', version: 99 }), { statusCode: 409 });
  await assert.rejects(service.saveNote(ctx(), session.id, 'BBB2', { recheckEmployeeId: 999 }), { statusCode: 400 });
  await service.saveTag(ctx(), session.id, 'AAA1', { cluster: 'Cụm ấm', isCombo: true });
  await service.saveTag(ctx(), session.id, 'BBB2', { cluster: 'cụm ấm' });
  const board = await service.getBoard(ctx(), session.id);
  assert.deepEqual(board.suggestions, { reason: ['lẫn mã'] });
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
  assert.deepEqual(board.counterpart, { id: sg.id, name: 'SG 29/10', branch: 'saigon', status: 'open', cancelled: false });

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
  assert.deepEqual(board.counterpart, { id: sg.id, name: 'SG 29/10', branch: 'saigon', status: 'open', cancelled: false });
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

test('trang thai: chi nhan 7 loai theo co so, giu chu cu khong doi, bo qua mau gui len', async () => {
  const { db, service, session } = await fixture();
  // Chu cu kieu dot nap tu sheet + mau cu nam san trong DB.
  await db.exec(`INSERT INTO stocktake_code_notes (session_id, product_code, status_text, status_color) VALUES (${session.id}, 'BBB2', 'lẫn bình giữ nhiệt', 'red')`);
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });

  // Ten chuan duoc nhan; chu tu do bi bo qua (invalid), o khac cung lan van ghi
  let result = await cells([
    { code: 'AAA1', column: 'statusText', value: 'Lẫn' },
    { code: 'CCC3', column: 'statusText', value: 'lẫn bình' },
    { code: 'CCC3', column: 'reasonText', value: 'ghi chú' }
  ]);
  assert.deepEqual(result.applied.map(a => [a.code, a.column, a.after]), [['AAA1', 'statusText', 'Lẫn'], ['CCC3', 'reasonText', 'ghi chú']]);
  assert.equal(result.skipped.invalid, 1);
  // Ten co so kia va chu "Chưa XL" khong luu; trong (= Chua XL) thi duoc
  result = await cells([{ code: 'AAA1', column: 'statusText', value: 'Nhầm HN' }, { code: 'CCC3', column: 'statusText', value: 'Chưa XL' }]);
  assert.deepEqual([result.applied.length, result.skipped.invalid], [0, 2]);
  result = await cells([{ code: 'AAA1', column: 'statusText', value: '' }]);
  assert.deepEqual(result.applied.map(a => a.after), ['']);

  // Chu cu khong doi: gui lai dung chu cu = unchanged, cot khac cung ma van luu; mau cu giu nguyen
  result = await cells([{ code: 'BBB2', column: 'statusText', value: 'lẫn bình giữ nhiệt' }, { code: 'BBB2', column: 'printPage', value: '3' }]);
  assert.deepEqual([result.skipped.unchanged, result.applied.map(a => a.column)], [1, ['printPage']]);
  let b = rowOf(await service.getBoard(ctx(), session.id), 'BBB2').note;
  assert.deepEqual([b.statusText, b.statusColor, b.printPage], ['lẫn bình giữ nhiệt', 'red', '3']);

  // saveNote: giu chu cu + sua ly do duoc; chu tu do moi -> 400; statusColor gui len bi bo qua
  ({ note: b } = await service.saveNote(ctx(), session.id, 'BBB2', { statusText: 'lẫn bình giữ nhiệt', reasonText: 'lý do', statusColor: 'blue', version: b.version }));
  assert.deepEqual([b.statusText, b.reasonText, b.statusColor], ['lẫn bình giữ nhiệt', 'lý do', 'red']);
  await assert.rejects(service.saveNote(ctx(), session.id, 'BBB2', { statusText: 'mất ko thấy', version: b.version }),
    { statusCode: 400, code: 'VALIDATION', field: 'statusText' });
  ({ note: b } = await service.saveNote(ctx(), session.id, 'BBB2', { statusText: 'Mất', version: b.version }));
  assert.deepEqual([b.statusText, b.statusColor], ['Mất', 'red']);
  const cBefore = rowOf(await service.getBoard(ctx(), session.id), 'CCC3').note; // CCC3 da co ghi chu (ly do) -> can version
  const { note: c } = await service.saveNote(ctx(), session.id, 'CCC3', { statusText: 'Thừa', statusColor: 'blue', version: cBefore.version });
  assert.deepEqual([c.statusText, c.statusColor], ['Thừa', '']);

  // Dot Sai Gon: "Nhầm HN" moi dung ten
  const sg = (await service.createSession(ctx(), { branch: 'saigon', name: 'SG', dateFrom: '2026-10-29', dateTo: '2026-10-29' })).session;
  result = await service.saveCells(ctx(), sg.id, { cells: [{ code: 'AAA1', column: 'statusText', value: 'Nhầm HN' }] });
  assert.deepEqual(result.applied.map(a => a.after), ['Nhầm HN']);
  result = await service.saveCells(ctx(), sg.id, { cells: [{ code: 'AAA1', column: 'statusText', value: 'Nhầm SG' }] });
  assert.equal(result.skipped.invalid, 1);
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
  await cells([{ code: 'AAA1', column: 'cluster', value: 'Cụm B' }, { code: 'AAA1', column: 'statusText', value: 'Thừa' }]);
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
    { code: 'aaa1', column: 'statusText', value: 'Mất', expected: '' },
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
    ['AAA1', 'statusText', '', 'Mất'], ['AAA1', 'reasonText', '', 'lý do'], ['AAA1', 'cluster', '', 'Cụm 1'],
    ['AAA1', 'combo', false, true], ['AAA1', 'recheck', '', 'Thái Kho'], ['AAA1', 'prevDiffManual', null, -1234]
  ]);
  assert.equal(announced.at(-1), session.id);
  const a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.note.statusText, a.note.reasonText, a.cluster, a.isCombo, a.note.recheckEmployeeId, a.prevDiff, a.prevDiffManual],
    ['Mất', 'lý do', 'Cụm 1', true, 502, -1234, true]);
  const { history } = await service.codeHistory(ctx(), session.id, 'AAA1');
  const own = history.filter(h => h.action === 'paste' && h.after.source === 'cells');
  assert.equal(own.length, 6);
  assert.ok(own.some(h => h.after.column === 'cluster' && h.after.cluster === 'Cụm 1'));
});

test('sua tren bang: expected lech -> conflict khong ghi, o khac van ghi; hoan tac; trong = xoa; so that; o lap', async () => {
  const { service, session } = await fixture();
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });
  await cells([{ code: 'AAA1', column: 'statusText', value: 'Mất', expected: '' }, { code: 'AAA1', column: 'combo', value: 'x', expected: false }]);
  let a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  await service.saveNote(ctx(HUNG), session.id, 'AAA1', { statusText: 'Lẫn', version: a.note.version });

  let result = await cells([
    { code: 'AAA1', column: 'statusText', value: 'Thừa', expected: 'Mất' },
    { code: 'AAA1', column: 'printPage', value: '12', expected: '' }
  ]);
  assert.deepEqual(result.conflicts, [{ code: 'AAA1', column: 'statusText', current: 'Lẫn' }]);
  assert.deepEqual(result.applied.map(x => x.column), ['printPage']);
  a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.note.statusText, a.note.printPage], ['Lẫn', '12']);

  // hoan tac: gui lai before, expected = after
  result = await cells([{ code: 'AAA1', column: 'combo', value: '', expected: true }, { code: 'AAA1', column: 'printPage', value: '', expected: '12' }]);
  assert.deepEqual(result.applied.map(x => [x.column, x.after]), [['combo', false], ['printPage', '']], 'theo thu tu gui');
  a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.isCombo, a.note.printPage], [false, '']);

  // so that tu hoan tac khong bi doc thanh nghin; khong expected = khong kiem; o lap lay o cuoi; khong doi = unchanged
  result = await cells([
    { code: 'BBB2', column: 'otherDiffManual', value: 1.234 },
    { code: 'BBB2', column: 'statusText', value: 'KK trước' },
    { code: 'bbb2', column: 'statusText', value: 'Thừa' },
    { code: 'AAA1', column: 'statusText', value: 'Lẫn' }
  ]);
  assert.deepEqual(result.skipped, { notFound: 0, invalid: 0, unchanged: 1 });
  const b = rowOf(await service.getBoard(ctx(), session.id), 'BBB2');
  assert.deepEqual([b.otherDiff, b.note.statusText], [1.234, 'Thừa']);
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

test('sua tren bang: tra ban ghi vua luu (version, nguoi sua) va bao tin hieu kem ma trinh duyet', async () => {
  const { db, service, session } = await fixture();
  const signals = [];
  const tracked = createStockTakeService({ getDb: () => poolFor(db), announce: (id, by) => signals.push([id, by]) });
  const result = await tracked.saveCells({ ...ctx(), clientId: 'tab-1' }, session.id, { cells: [
    { code: 'AAA1', column: 'statusText', value: 'Lẫn' },
    { code: 'AAA1', column: 'reasonText', value: 'lý do' },
    { code: 'BBB2', column: 'cluster', value: 'Cụm X' }
  ] });
  assert.deepEqual(result.notes.map(n => [n.code, n.statusText, n.reasonText, n.version, n.updatedByName]), [['AAA1', 'Lẫn', 'lý do', 1, 'Quản Lý A']]);
  assert.ok(result.notes[0].updatedAt);
  assert.deepEqual(result.tags.map(t => [t.code, t.cluster, t.version]), [['BBB2', 'Cụm X', 1]]);
  assert.deepEqual(signals, [[session.id, 'tab-1']]);
  const empty = await tracked.saveCells(ctx(), session.id, { cells: [{ code: 'AAA1', column: 'statusText', value: 'Lẫn' }] });
  assert.deepEqual([empty.notes, empty.tags], [[], []]);
});

// ---------- 0109: chon dot KK truoc, huy / khoi phuc dot ----------

// Hai dot HN da dong (A: 29/10 AAA1 chenh +2; B: 30/10 them 5 AAA1 -> chenh +7) + dot mo C 31/10.
async function previousFixture() {
  const base = await fixture();
  const { service, session: a } = base;
  await service.closeSession(ctx(), a.id, { version: a.version });
  const { session: b } = await service.createSession(ctx(), { branch: 'hanoi', name: 'Đợt B', dateFrom: '2026-10-30', dateTo: '2026-10-30' });
  await service.addLine(ctx(), b.id, { productCode: 'AAA1', quantity: 17 });
  const bNow = (await service.getBoard(ctx(), b.id)).session;
  await service.closeSession(ctx(), b.id, { version: bNow.version });
  const { session: c } = await service.createSession(ctx(), { branch: 'hanoi', name: 'Đợt C', dateFrom: '2026-10-31', dateTo: '2026-10-31' });
  return { ...base, a, b, c };
}

test('KK truoc: tu dong lay dot dong gan nhat; chon tay dung dung dot, doi chieu khong bi xoa', async () => {
  const { service, a, b, c } = await previousFixture();
  let board = await service.getBoard(ctx(), c.id);
  assert.deepEqual(board.previousSession, { id: b.id, name: 'Đợt B', mode: 'auto', manualInvalid: false });
  assert.equal(rowOf(board, 'AAA1').prevDiff, 7);

  const { session: sg } = await service.createSession(ctx(), { branch: 'saigon', name: 'SG', dateFrom: '2026-10-31', dateTo: '2026-10-31' });
  const { session: c1 } = await service.updateSession(ctx(), c.id, { counterpartSessionId: sg.id, version: c.version });
  const { session: c2 } = await service.updateSession(ctx(HUNG), c.id, { previousSessionId: a.id, version: c1.version });
  assert.equal(c2.previousSessionId, a.id);
  assert.equal(c2.counterpartSessionId, sg.id, 'doi KK truoc khong xoa doi chieu');
  board = await service.getBoard(ctx(), c.id);
  assert.deepEqual(board.previousSession, { id: a.id, name: 'Đợt 29/10', mode: 'manual', manualInvalid: false });
  assert.equal(rowOf(board, 'AAA1').prevDiff, 2);

  const { session: c3 } = await service.updateSession(ctx(), c.id, { counterpartSessionId: null, version: c2.version });
  assert.equal(c3.previousSessionId, a.id, 'doi doi chieu khong xoa KK truoc');
  await assert.rejects(service.updateSession(ctx(), c.id, { version: c3.version }), { statusCode: 400 });

  // Dong dot C: prev_diff chup tu dot chon tay; lich su session_close ghi dot KK truoc da dung.
  await service.closeSession(ctx(), c.id, { version: c3.version });
  const closed = await service.getBoard(ctx(), c.id);
  assert.equal(rowOf(closed, 'AAA1').prevDiff, 2);
});

test('KK truoc: chan dot khac co so / dang mo / chinh no / da huy; tao dot kem KK truoc', async () => {
  const { service, a, b, c } = await previousFixture();
  const { session: sg } = await service.createSession(ctx(), { branch: 'saigon', name: 'SG', dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  await service.closeSession(ctx(), sg.id, { version: sg.version });
  const { session: open } = await service.createSession(ctx(), { branch: 'hanoi', name: 'Mở', dateFrom: '2026-11-01', dateTo: '2026-11-01' });
  for (const previousSessionId of [sg.id, open.id, c.id, 999999]) {
    await assert.rejects(service.updateSession(ctx(), c.id, { previousSessionId, version: c.version }), { statusCode: 400, code: 'INVALID_PREVIOUS' });
  }
  await service.cancelSession(ctx(), a.id, { version: (await service.getBoard(ctx(), a.id)).session.version, reason: 'Sai số' });
  await assert.rejects(service.updateSession(ctx(), c.id, { previousSessionId: a.id, version: c.version }), { code: 'INVALID_PREVIOUS' });
  const { session: d } = await service.createSession(ctx(), { branch: 'hanoi', name: 'D', dateFrom: '2026-10-01', dateTo: '2026-10-01', previousSessionId: b.id });
  assert.equal(d.previousSessionId, b.id, 'chon tay khong rang buoc ngay');
  assert.equal((await service.getBoard(ctx(), d.id)).previousSession.mode, 'manual');
  await assert.rejects(service.createSession(ctx(), { branch: 'hanoi', name: 'E', dateFrom: '2026-10-01', dateTo: '2026-10-01', previousSessionId: sg.id }),
    { code: 'INVALID_PREVIOUS' });
});

test('huy dot: an khoi danh sach, chi doc, KK truoc / doi chieu bo qua; khoi phuc tro lai', async () => {
  const { db, service, a, b, c } = await previousFixture();
  const { session: c1 } = await service.updateSession(ctx(), c.id, { previousSessionId: b.id, version: c.version });
  const bVersion = (await service.getBoard(ctx(), b.id)).session.version;
  await assert.rejects(service.cancelSession(ctx(), b.id, { version: bVersion, reason: '  ' }), { statusCode: 400 });
  await assert.rejects(service.cancelSession(ctx(), b.id, { version: bVersion, reason: 'x'.repeat(501) }), { statusCode: 400 });
  await assert.rejects(service.cancelSession(ctx(), b.id, { version: bVersion + 5, reason: 'Sai' }), { statusCode: 409, code: 'STOCKTAKE_CONFLICT' });

  const deps = await service.dependents(ctx(), b.id);
  assert.deepEqual(deps.previousOf.map(d => [d.id, d.mode, d.changes]), [[c.id, 'manual', true]]);

  const { session: cancelled } = await service.cancelSession(ctx(HUNG), b.id, { version: bVersion, reason: 'Số sheet cũ' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.cancelledByName, 'Hưng');
  assert.equal(cancelled.cancelReason, 'Số sheet cũ');
  assert.equal(cancelled.status, 'closed', 'status giu nguyen');
  await assert.rejects(service.cancelSession(ctx(), b.id, { version: cancelled.version, reason: 'lại' }), { code: 'STOCKTAKE_CANCELLED' });

  assert.equal((await service.listSessions(ctx())).sessions.some(s => s.id === b.id), false);
  assert.equal((await service.listSessions(ctx(), { includeCancelled: true })).sessions.find(s => s.id === b.id).cancelled, true);

  // Chon tay tro toi dot huy -> tu dong (bo qua dot huy) -> dot A.
  let board = await service.getBoard(ctx(), c.id);
  assert.deepEqual(board.previousSession, { id: a.id, name: 'Đợt 29/10', mode: 'auto', manualInvalid: true });
  assert.equal(rowOf(board, 'AAA1').prevDiff, 2);

  // Dot huy van xem duoc nhung khong ghi duoc (ca tag).
  assert.equal((await service.getBoard(ctx(), b.id)).session.cancelled, true);
  await assert.rejects(service.saveTag(ctx(), b.id, 'AAA1', { cluster: 'X' }), { code: 'STOCKTAKE_CANCELLED' });
  const { session: openOne } = await service.createSession(ctx(), { branch: 'hanoi', name: 'Mở', dateFrom: '2026-11-01', dateTo: '2026-11-01' });
  const { session: openCancelled } = await service.cancelSession(ctx(), openOne.id, { version: openOne.version, reason: 'Tạo nhầm' });
  await assert.rejects(service.addLine(ctx(), openOne.id, { productCode: 'AAA1', quantity: 1 }), { statusCode: 409, code: 'STOCKTAKE_CANCELLED' });
  await assert.rejects(service.closeSession(ctx(), openOne.id, { version: openCancelled.version }), { code: 'STOCKTAKE_CANCELLED' });
  await assert.rejects(service.updateSession(ctx(), openOne.id, { previousSessionId: null, version: openCancelled.version }), { code: 'STOCKTAKE_CANCELLED' });

  await assert.rejects(service.restoreSession(ctx(), c.id, { version: c1.version }), { code: 'STOCKTAKE_NOT_CANCELLED' });
  const { session: restored } = await service.restoreSession(ctx(), b.id, { version: cancelled.version });
  assert.deepEqual([restored.cancelled, restored.cancelReason, restored.status], [false, '', 'closed']);
  board = await service.getBoard(ctx(), c.id);
  assert.deepEqual(board.previousSession, { id: b.id, name: 'Đợt B', mode: 'manual', manualInvalid: false });

  const actions = (await db.query(`SELECT action FROM stocktake_history WHERE session_id = $1 ORDER BY id`, [b.id])).rows.map(r => r.action);
  assert.deepEqual(actions.slice(-2), ['session_cancel', 'session_restore']);
});

test('huy dot doi chieu: bang khong con Kiem SG, khong dat lam doi chieu duoc; dot phu thuoc gom dot da dong', async () => {
  const { service, session } = await fixture();
  const { session: sg } = await service.createSession(ctx(), { branch: 'saigon', name: 'SG', dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  const { session: hn } = await service.updateSession(ctx(), session.id, { counterpartSessionId: sg.id, version: session.version });
  assert.equal(rowOf(await service.getBoard(ctx(), hn.id), 'AAA1').otherDiff, -3);
  const deps = await service.dependents(ctx(), sg.id);
  assert.deepEqual(deps.counterpartOf.map(d => [d.id, d.changes]), [[hn.id, true]]);
  await service.cancelSession(ctx(), sg.id, { version: sg.version, reason: 'Sai' });
  const board = await service.getBoard(ctx(), hn.id);
  assert.equal(rowOf(board, 'AAA1').otherDiff, null);
  assert.equal(board.counterpart.cancelled, true);
  const { session: hn2 } = await service.createSession(ctx(), { branch: 'hanoi', name: 'HN2', dateFrom: '2026-10-30', dateTo: '2026-10-30' });
  await assert.rejects(service.updateSession(ctx(), hn2.id, { counterpartSessionId: sg.id, version: hn2.version }), { code: 'INVALID_COUNTERPART' });

  // Dot da dong tung dung dot nay lam KK truoc: lay tu lich su luc dong, danh dau khong doi.
  await service.closeSession(ctx(), hn.id, { version: hn.version });
  const later = (await service.getBoard(ctx(), hn2.id)).session;
  await service.closeSession(ctx(), hn2.id, { version: later.version });
  const prevDeps = await service.dependents(ctx(), hn.id);
  assert.deepEqual(prevDeps.previousOf.map(d => [d.id, d.mode, d.changes]), [[hn2.id, 'snapshot', false]]);
  await assert.rejects(service.dependents(ctx(QL, ['saigon']), hn.id), { statusCode: 403 });
});
