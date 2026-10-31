'use strict';

// Trang thai boc (2026-10-27): in lai nguyen tu, doi tay Dang boc -> Da boc / Da huy, tu dong theo Kiot, canh bao lech SL.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createPickAssignmentsService } = require('./pickAssignmentsService');
const kiotData = require('./pickKiotData');

const MIGRATIONS = path.join(__dirname, '../db/migrations');
const migration = file => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

function poolFor(db) {
  const query = (sql, params) => db.query(sql, params);
  return { query, connect: async () => ({ query, release() {} }) };
}

const QL = { id: 'ql-1', hoTen: 'Quản Lý A - 123456789', username: 'ql' };
const ctx = scope => ({ user: QL, ...(scope ? { scope } : {}) });

function order(overrides = {}) {
  return {
    branch: 'HN', orderCode: 'DH001', customerName: 'Khách A', saleName: 'Sale B', saleTelegramId: '555', orderDate: '31/10/2026 09:00',
    status: { code: 'SENT_TO_ACCOUNTANT', label: 'Đơn đã gửi kế toán' }, invoiceDiscount: 0,
    lines: [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 250, price: 10, discount: 0 }],
    ...overrides
  };
}

const lineOf = (productCode, quantity) => ({ productCode, productName: productCode, quantity, price: 1, discount: 0 });

async function fixture({ orders = { DH001: order() } } = {}) {
  const db = new PGlite();
  await db.exec(migration('0001_core_master_data.sql'));
  await db.exec(migration('0003_orders.sql'));
  await db.exec(migration('0064_sheet_snapshots.sql'));
  await db.exec(migration('0095_stock_positions.sql'));
  await db.exec(migration('0096_order_pick_assignments.sql'));
  await db.exec(migration('0097_order_pick_assignment_snapshots.sql'));
  await db.exec(migration('0098_order_pick_history_mismatch_ack.sql'));
  const seed = [
    { code: 'AAA1', location: 'A01', notes: '3T x 100' }, // id 1: 300
    { code: 'AAA1', location: 'B02', notes: '2T x 100' }, // id 2: 200
    { code: 'BBB2', location: 'C03', notes: '5T x 10' } // id 3
  ];
  for (const row of seed) {
    await db.query(`INSERT INTO stock_positions (branch, code, name, notes, location) VALUES ('HN', $1, $2, $3, $4)`, [row.code, 'Tên ' + row.code, row.notes, row.location]);
  }
  const service = createPickAssignmentsService({
    getDb: () => poolFor(db),
    loadOrder: async ({ branch, orderCode }) => {
      const found = orders[orderCode];
      return found && found.branch === branch ? found : null;
    }
  });
  const notesOf = async id => (await db.query('SELECT notes FROM stock_positions WHERE id = $1', [id])).rows[0]?.notes;
  const pickCount = async () => (await db.query(`SELECT count(*)::int AS n FROM stock_position_history WHERE action = 'pick'`)).rows[0].n;
  const latest = async code => (await service.get(ctx(), { branch: 'HN', orderCode: code })).assignment;
  return { db, service, notesOf, pickCount, latest };
}

async function addKiotOrder(db, { code, status, id, lines, branch = 'hanoi' }) {
  await db.query(`INSERT INTO orders (branch, id, code, raw) VALUES ($1, $2, $3, $4::jsonb)`, [branch, id, code, JSON.stringify({ statusValue: status })]);
  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    await db.query(`INSERT INTO order_details (branch, order_id, line_no, quantity, raw) VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [branch, id, lineNo, line.quantity, JSON.stringify({ productCode: line.productCode })]);
  }
}

const body = (allocations, extra = {}) => ({ branch: 'HN', orderCode: 'DH001', allocations, ...extra });

test('kiotOutcome: chi Hoan thanh / Da huy, khong phan biet dau va hoa/thuong', () => {
  assert.equal(kiotData.kiotOutcome('Hoàn thành'), 'completed');
  assert.equal(kiotData.kiotOutcome('hoan thanh'), 'completed');
  assert.equal(kiotData.kiotOutcome('Đã hủy'), 'cancelled');
  assert.equal(kiotData.kiotOutcome('Da huy'), 'cancelled');
  for (const other of ['Phiếu tạm', 'Đã xác nhận', 'Đang giao hàng', '', null, undefined]) assert.equal(kiotData.kiotOutcome(other), null);
});

test('diffQuantities: lech khi khac SL, ma chua chi dinh (picked 0) hoac ma chi dinh khong con tren don (ordered 0); khop thi rong', () => {
  const assigned = new Map([['a1', { productCode: 'A1', quantity: 400 }], ['b2', { productCode: 'B2', quantity: 10 }]]);
  assert.deepEqual(kiotData.diffQuantities(assigned, new Map([['a1', 400], ['b2', 10]])), []);
  assert.deepEqual(kiotData.diffQuantities(assigned, new Map([['a1', 395], ['b2', 10], ['c3', 7]])), [
    { productCode: 'A1', picked: 400, ordered: 395 }, { productCode: 'c3', picked: 0, ordered: 7 }]);
  assert.deepEqual(kiotData.diffQuantities(assigned, new Map([['a1', 400]])), [{ productCode: 'B2', picked: 10, ordered: 0 }]);
});

test('assign reassign: in lai don Dang boc = huy luot cu + luot moi cung giao dich, van Dang boc, ton that khong doi', async () => {
  const { db, service, notesOf, latest } = await fixture();
  try {
    const first = (await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }]))).assignment;
    await assert.rejects(() => service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 2, qty: 200 }, { productCode: 'AAA1', positionId: 1, qty: 50 }])), { code: 'ALREADY_ASSIGNED' });
    await assert.rejects(() => service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }], { reassign: true, version: 9 })), { code: 'VERSION_CONFLICT' });
    const second = (await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 2, qty: 200 }, { productCode: 'AAA1', positionId: 1, qty: 50 }], { reassign: true, version: 1 }))).assignment;
    assert.notEqual(second.id, first.id);
    assert.equal(second.status, 'picking');
    assert.equal((await latest('DH001')).id, second.id);
    const oldRow = (await db.query('SELECT status, version FROM order_pick_assignments WHERE id = $1', [first.id])).rows[0];
    assert.deepEqual([oldRow.status, oldRow.version], ['cancelled', 2]);
    const reason = (await db.query(`SELECT summary->>'reason' AS reason FROM order_pick_history WHERE assignment_id = $1 AND action = 'cancel'`, [first.id])).rows[0].reason;
    assert.equal(reason, 'reassign');
    assert.equal(await notesOf(1), '3T x 100');
    assert.equal(await notesOf(2), '2T x 100');
    assert.equal((await service.latestStatuses()).get('HN|dh001'), 'picking');
  } finally { await db.close(); }
});

test('assign reassign: loi o luot moi thi luot cu giu nguyen; Da boc khong in lai duoc', async () => {
  const { db, service, latest, notesOf } = await fixture();
  try {
    const first = (await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }]))).assignment;
    await assert.rejects(() => service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 10 }], { reassign: true })), { code: 'VALIDATION' });
    const still = await latest('DH001');
    assert.deepEqual([still.id, still.status, still.version], [first.id, 'picking', 1]);
    await service.confirm(ctx(), first.id, { version: 1 });
    assert.notEqual(await notesOf(1), '3T x 100', 'da tru thung that');
    // Da boc cung chi dinh lai duoc: hoan thung da tru, huy luot cu, tao luot Dang boc moi trong 1 giao dich.
    await assert.rejects(() => service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 10 }], { reassign: true })), { code: 'VALIDATION' });
    assert.notEqual(await notesOf(1), '3T x 100', 'loi o luot moi thi thung van tru nhu cu');
    assert.equal((await latest('DH001')).status, 'confirmed');
    const second = (await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }], { reassign: true, version: 2 }))).assignment;
    assert.equal(second.status, 'picking');
    assert.notEqual(second.id, first.id);
    assert.equal(await notesOf(1), '3T x 100', 'thung da tru duoc hoan lai');
    const old = await service.get(ctx(), { branch: 'HN', orderCode: 'DH001' });
    assert.equal(old.assignment.id, second.id);
    const history = (await db.query(`SELECT summary FROM order_pick_history WHERE assignment_id = $1 AND action = 'cancel'`, [first.id])).rows;
    assert.deepEqual(history.map(r => [r.summary.reverted, r.summary.reason]), [[true, 'reassign']]);
    const revert = (await db.query(`SELECT count(*)::int AS n FROM stock_position_history WHERE action = 'pick_revert'`)).rows[0];
    assert.equal(revert.n, 1);
  } finally { await db.close(); }
});

test('setStatus: Dang boc -> Da boc tru thung dung 1 lan (bam lai khong tru nua); Dang boc -> Da huy; Da boc la cuoi', async () => {
  const { db, service, notesOf, pickCount } = await fixture({ orders: {
    DH001: order(),
    DH002: order({ orderCode: 'DH002', lines: [lineOf('BBB2', 20)] })
  } });
  try {
    await assert.rejects(() => service.setStatus(ctx(), { branch: 'HN', orderCode: 'DH001', status: 'confirmed' }), { statusCode: 409, code: 'INVALID_STATE' });
    await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    await assert.rejects(() => service.setStatus(ctx(), { branch: 'HN', orderCode: 'DH001', status: 'picking' }), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(() => service.setStatus(ctx(['SG']), { branch: 'HN', orderCode: 'DH001', status: 'confirmed' }), { statusCode: 403 });
    const done = (await service.setStatus(ctx(), { branch: 'HN', orderCode: 'DH001', status: 'confirmed' })).assignment;
    assert.equal(done.status, 'confirmed');
    const notesAfter = await notesOf(1);
    assert.notEqual(notesAfter, '3T x 100', 'da tru thung that');
    const again = (await service.setStatus(ctx(), { branch: 'HN', orderCode: 'DH001', status: 'confirmed' })).assignment;
    assert.equal(again.version, done.version);
    assert.equal(await notesOf(1), notesAfter, 'xac nhan lai khong tru lan 2');
    assert.equal(await pickCount(), 1);
    await assert.rejects(() => service.setStatus(ctx(), { branch: 'HN', orderCode: 'DH001', status: 'cancelled' }), { statusCode: 409, code: 'INVALID_STATE' });

    await service.assign(ctx(), { branch: 'HN', orderCode: 'DH002', allocations: [{ productCode: 'BBB2', positionId: 3, qty: 20 }] });
    const cancelled = (await service.setStatus(ctx(), { branch: 'HN', orderCode: 'DH002', status: 'cancelled' })).assignment;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(await notesOf(3), '5T x 10');
    assert.equal((await service.latestStatuses()).get('HN|dh002'), 'cancelled', 'Da huy thu cong van hien nhan Da huy');
    await assert.rejects(() => service.setStatus(ctx(), { branch: 'HN', orderCode: 'DH002', status: 'confirmed' }), { statusCode: 409, code: 'INVALID_STATE' });
  } finally { await db.close(); }
});

test('reconcileWithKiot: Kiot Hoan thanh -> Da boc (tru thung), Kiot Da huy -> Chua boc (tra giu cho), Da boc khong bi dong toi', async () => {
  const { db, service, notesOf, pickCount, latest } = await fixture({ orders: {
    DH001: order(),
    DH002: order({ orderCode: 'DH002', lines: [lineOf('BBB2', 20)] }),
    DH003: order({ orderCode: 'DH003', lines: [lineOf('AAA1', 50)] }),
    DH004: order({ orderCode: 'DH004', lines: [lineOf('BBB2', 10)] })
  } });
  try {
    await addKiotOrder(db, { code: 'DH001', status: 'Hoàn thành', id: 1, lines: [{ productCode: 'AAA1', quantity: 250 }] });
    await addKiotOrder(db, { code: 'DH002', status: 'Đã hủy', id: 2, lines: [{ productCode: 'BBB2', quantity: 20 }] });
    await addKiotOrder(db, { code: 'DH003', status: 'Đã xác nhận', id: 3, lines: [{ productCode: 'AAA1', quantity: 50 }] });
    await addKiotOrder(db, { code: 'DH004', status: 'Đã hủy', id: 4, lines: [{ productCode: 'BBB2', quantity: 10 }] });
    await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    await service.assign(ctx(), { branch: 'HN', orderCode: 'DH002', allocations: [{ productCode: 'BBB2', positionId: 3, qty: 20 }] });
    await service.assign(ctx(), { branch: 'HN', orderCode: 'DH003', allocations: [{ productCode: 'AAA1', positionId: 2, qty: 50 }] });
    // DH004 da duoc nguoi dung xac nhan boc roi Kiot moi huy: Da boc khong bao gio bi Kiot dong toi.
    const four = (await service.assign(ctx(), { branch: 'HN', orderCode: 'DH004', allocations: [{ productCode: 'BBB2', positionId: 3, qty: 10 }] })).assignment;
    await service.confirm(ctx(), four.id, { version: 1 });

    const result = await service.reconcileWithKiot();
    assert.deepEqual([result.checked, result.confirmed, result.cancelled, result.failed.length], [3, 1, 1, 0]);
    const dh001 = await latest('DH001');
    assert.equal(dh001.status, 'confirmed');
    assert.equal(dh001.confirmedByName, 'Hệ thống (KiotViet)');
    assert.notEqual(await notesOf(1), '3T x 100', 'da tru thung that');
    const dh002 = await latest('DH002');
    assert.equal(dh002.status, 'cancelled');
    assert.equal(dh002.history.at(-1).summary.reason, 'kiot_cancelled');
    assert.equal((await latest('DH003')).status, 'picking', 'Kiot chua hoan thanh: giu nguyen');
    assert.equal((await latest('DH004')).status, 'confirmed');
    const map = await service.latestStatuses();
    assert.equal(map.get('HN|dh002'), 'cancelled', 'Kiot huy -> Da huy');
    assert.equal(map.get('HN|dh001'), 'confirmed');
    assert.equal(map.get('HN|dh004'), 'confirmed');

    const picksBefore = await pickCount();
    const repeat = await service.reconcileWithKiot();
    assert.deepEqual([repeat.checked, repeat.confirmed, repeat.cancelled], [1, 0, 0]);
    assert.equal(await pickCount(), picksBefore, 'chay lai khong tru lan 2');
  } finally { await db.close(); }
});

test('reconcileWithKiot: ton vi tri da doi -> bao loi cho chi dinh do, giu Dang boc, khong chan don khac; khong co chi dinh nao thi nhe', async () => {
  const { db, service, notesOf, latest } = await fixture({ orders: {
    DH001: order(),
    DH002: order({ orderCode: 'DH002', lines: [lineOf('BBB2', 20)] })
  } });
  try {
    assert.deepEqual(await service.reconcileWithKiot(), { checked: 0, confirmed: 0, cancelled: 0, skipped: 0, failed: [] });
    await addKiotOrder(db, { code: 'DH001', status: 'Hoàn thành', id: 1, lines: [{ productCode: 'AAA1', quantity: 250 }] });
    await addKiotOrder(db, { code: 'DH002', status: 'Hoàn thành', id: 2, lines: [{ productCode: 'BBB2', quantity: 20 }] });
    await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    await service.assign(ctx(), { branch: 'HN', orderCode: 'DH002', allocations: [{ productCode: 'BBB2', positionId: 3, qty: 20 }] });
    await db.query(`UPDATE stock_positions SET notes = '1T x 100', version = version + 1 WHERE id = 1`);
    const result = await service.reconcileWithKiot();
    assert.deepEqual([result.confirmed, result.failed.length, result.failed[0].code, result.failed[0].orderCode], [1, 1, 'STOCK_CHANGED', 'DH001']);
    assert.equal((await latest('DH001')).status, 'picking');
    assert.equal((await latest('DH002')).status, 'confirmed');
    assert.equal(await notesOf(1), '1T x 100');
  } finally { await db.close(); }
});

const PAIR_KEY = 'HN|dh001';
const warningsOf = async service => (await service.pickWarnings()).get(PAIR_KEY);

test('pickWarnings: Lech Kiot = SL can nhat (snapshot) khac SL don Kiot hien tai, tu het khi Kiot khop lai; Da huy khong canh bao; chua ap migration thi Map rong', async () => {
  const { db, service, latest } = await fixture({ orders: {
    DH001: order({ lines: [lineOf('AAA1', 250), lineOf('BBB2', 20)] })
  } });
  try {
    await addKiotOrder(db, { code: 'DH001', status: 'Phiếu tạm', id: 1, lines: [{ productCode: 'AAA1', quantity: 240 }, { productCode: 'BBB2', quantity: 20 }, { productCode: 'VAT10', quantity: 1 }] });
    await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }, { productCode: 'BBB2', positionId: 3, qty: 20 }]));
    assert.deepEqual(await warningsOf(service), ['PICK_KIOT_DIFF'], 'chon du 250/250 nhung Kiot dat 240');
    // Kiot sua don khop lai -> canh bao tu het.
    await db.query(`UPDATE order_details SET quantity = 250 WHERE branch = 'hanoi' AND order_id = 1 AND line_no = 1`);
    assert.equal(await warningsOf(service), undefined);
    // Kiot them dong moi chua chi dinh -> lech.
    await db.query(`INSERT INTO order_details (branch, order_id, line_no, quantity, raw) VALUES ('hanoi', 1, 9, 5, '{"productCode":"CCC3"}'::jsonb)`);
    assert.deepEqual(await warningsOf(service), ['PICK_KIOT_DIFF']);
    // Chi dinh bi huy -> khong canh bao (chi Dang boc / Da boc).
    await service.cancel(ctx(), (await latest('DH001')).id, { version: 1 });
    assert.equal(await warningsOf(service), undefined);
    await db.exec('DROP TABLE order_pick_lines; DROP TABLE order_pick_history; DROP TABLE order_pick_assignments;');
    assert.equal((await service.pickWarnings()).size, 0);
  } finally { await db.close(); }
});

test('pickWarnings: Lech SL trong don = tong SL chon theo vi tri khac SL can nhat (dong do da xac nhan luu); chi dinh lai khop thi het', async () => {
  const { db, service, latest, notesOf } = await fixture();
  try {
    await addKiotOrder(db, { code: 'DH001', status: 'Phiếu tạm', id: 1, lines: [{ productCode: 'AAA1', quantity: 250 }] });
    await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 200 }], { allowMismatch: true }));
    assert.deepEqual(await warningsOf(service), ['PICK_ORDER_DIFF'], 'can 250 nhung chi chon 200; Kiot van 250');
    const current = await latest('DH001');
    await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }], { reassign: true, version: current.version }));
    assert.equal(await warningsOf(service), undefined);
  } finally { await db.close(); }
});

test('pickWarnings: don Da boc van canh bao khi SL Kiot lech', async () => {
  const { db, service, latest, notesOf } = await fixture();
  try {
    await addKiotOrder(db, { code: 'DH001', status: 'Hoàn thành', id: 1, lines: [{ productCode: 'AAA1', quantity: 230 }] });
    await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    await service.confirm(ctx(), (await latest('DH001')).id, { version: 1 });
    assert.deepEqual(await warningsOf(service), ['PICK_KIOT_DIFF']);
  } finally { await db.close(); }
});

test('pickWarnings: don dat truoc 31/10/2026 khong canh bao Lech Kiot / Lech SL trong don', async () => {
  const { db, service } = await fixture({ orders: { DH001: order({ orderDate: '30/10/2026 23:59', lines: [lineOf('AAA1', 250)] }) } });
  try {
    await addKiotOrder(db, { code: 'DH001', status: 'Phiếu tạm', id: 1, lines: [{ productCode: 'AAA1', quantity: 240 }] });
    await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 200 }], { allowMismatch: true }));
    assert.equal(await warningsOf(service), undefined);
  } finally { await db.close(); }
});

test('assign needs: SL can nhat sua tay vao snapshot (quantity da sua, kiotQuantity = SL Kiot, gop dong cung ma), phan bo kiem theo SL moi; Lech Kiot den khi Kiot sua khop', async () => {
  const { db, service, latest } = await fixture({ orders: {
    DH001: order({ lines: [{ productCode: 'AAA1', productName: 'Hàng A', quantity: 100, price: 10, discount: 0, note: 'a' }, lineOf('BBB2', 20), { productCode: 'aaa1', productName: 'Hàng A', quantity: 150, price: 10, discount: 0, note: 'b' }] })
  } });
  try {
    await addKiotOrder(db, { code: 'DH001', status: 'Phiếu tạm', id: 1, lines: [{ productCode: 'AAA1', quantity: 250 }, { productCode: 'BBB2', quantity: 20 }] });
    // Chon 200 (2 thung x 100): khop SL sua 200 -> khong Lech SL trong don; Kiot 250 -> Lech Kiot.
    const { assignment } = await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 200 }, { productCode: 'BBB2', positionId: 3, qty: 20 }], { needs: { AAA1: 200 } }));
    const lines = assignment.snapshot.lines;
    assert.deepEqual(lines.map(l => [l.productCode, l.quantity, l.kiotQuantity ?? null]), [['AAA1', 200, 250], ['BBB2', 20, null]], 'hai dong AAA1/aaa1 gop thanh mot, thu tu Kiot giu nguyen');
    assert.equal(assignment.snapshot.goodsTotal, '2020', '200 x 10 + 20 x 1');
    assert.deepEqual(await warningsOf(service), ['PICK_KIOT_DIFF']);
    await db.query(`UPDATE order_details SET quantity = 200 WHERE branch = 'hanoi' AND order_id = 1 AND line_no = 1`);
    assert.equal(await warningsOf(service), undefined, 'Kiot sua khop SL da sua -> het canh bao');
    assert.equal((await latest('DH001')).snapshot.lines[0].quantity, 200);
  } finally { await db.close(); }
});

test('assign needs: SL sua phai nguyen duong va ma co trong don; trung SL Kiot thi snapshot giu nguyen; phan bo vuot SL sua van bi chan neu khong allowMismatch', async () => {
  const { db, service } = await fixture();
  try {
    const bad = needs => service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }], { needs }));
    for (const needs of [{ AAA1: 0 }, { AAA1: -5 }, { AAA1: 1.5 }, { AAA1: 'abc' }, { AAA1: null }, { AAA1: '' }, { ZZZ9: 10 }, [1, 2], 'x']) {
      await assert.rejects(() => bad(needs), error => error.statusCode === 400 && error.code === 'VALIDATION', JSON.stringify(needs));
    }
    await assert.rejects(() => bad({ AAA1: 100 }), error => error.statusCode === 400, 'chon 250 nhung can 100 (thua hon 1 thung, chua xac nhan lech)');
    const { assignment } = await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }], { needs: { aaa1: 250 } }));
    assert.equal(assignment.snapshot.lines[0].quantity, 250);
    assert.equal(assignment.snapshot.lines[0].kiotQuantity, undefined, 'SL sua trung SL Kiot -> khong ghi kiotQuantity');
  } finally { await db.close(); }
});

test('cancel: ly do huy chi do may chu dat; body.reason tu client bi bo qua (khong gia mao "Kiot huy" de an trang thai Da huy)', async () => {
  const { db, service, latest, notesOf } = await fixture();
  try {
    const { assignment } = await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }]));
    await service.cancel(ctx(), assignment.id, { version: 1, reason: 'kiot_cancelled' });
    assert.equal((await latest('DH001')).history.at(-1).summary.reason, 'manual');
    assert.equal((await service.latestStatuses()).get('HN|dh001'), 'cancelled');
  } finally { await db.close(); }
});

test('trừ tồn theo đơn: người sửa = mã đơn (người bấm tay lẫn job Kiot), tên người bấm nằm trong summary', async () => {
  const { db, service } = await fixture({ orders: { DH001: order(), DH002: order({ orderCode: 'DH002', lines: [lineOf('BBB2', 20)] }) } });
  try {
    await addKiotOrder(db, { code: 'DH002', status: 'Hoàn thành', id: 2, lines: [{ productCode: 'BBB2', quantity: 20 }] });
    const manual = (await service.assign(ctx(), body([{ productCode: 'AAA1', positionId: 1, qty: 250 }]))).assignment;
    await service.confirm(ctx(), manual.id, { version: 1 });
    await service.assign(ctx(), { branch: 'HN', orderCode: 'DH002', allocations: [{ productCode: 'BBB2', positionId: 3, qty: 20 }] });
    await service.reconcileWithKiot();
    const log = (await db.query(`SELECT position_id, actor_name, summary FROM stock_position_history WHERE action = 'pick' ORDER BY id`)).rows;
    assert.deepEqual(log.map(r => [Number(r.position_id), r.actor_name, r.summary.confirmedBy]), [[1, 'DH001', 'Quản Lý A'], [3, 'DH002', '']]);
    const updated = (await db.query(`SELECT updated_by_name FROM stock_positions WHERE id IN (1, 3) ORDER BY id`)).rows.map(r => r.updated_by_name);
    assert.deepEqual(updated, ['DH001', 'DH002']);
    const orderLog = (await db.query(`SELECT order_code, actor_name FROM order_pick_history WHERE action = 'confirm' ORDER BY id`)).rows;
    assert.deepEqual(orderLog.map(r => [r.order_code, r.actor_name]), [['DH001', 'Quản Lý A'], ['DH002', 'Hệ thống (KiotViet)']]);
  } finally { await db.close(); }
});


test('Kiot seller phone +84 is stored with a leading 0',async()=>{
 for(const [input,expected] of [['+84923170904','0923170904'],['+84 923 170 904','0923170904'],['84923170904','0923170904'],['+840923170904','0923170904'],['0923170904','0923170904'],['','']])assert.equal(kiotData.toLocalPhone(input),expected);
 const lookup=kiotData.createSellerPhoneLookup({getBranches:()=>[{branch:'hanoi'}],createClient:()=>({fetchAllPages:async(e,q,cb)=>{await cb([{id:7,mobilePhone:'+84923170904'}]);}})});
 assert.equal(await lookup('hanoi',7),'0923170904');
});

test('Kiot seller phones match ID and retailer, cache concurrent pages and retry after failure',async()=>{
 let calls=0,time=0;
 const lookup=kiotData.createSellerPhoneLookup({now:()=>time,getBranches:()=>[{branch:'hanoi'},{branch:'saigon'}],createClient:config=>({fetchAllPages:async(endpoint,query,onPage)=>{
  calls++;assert.equal(endpoint,'users');await onPage([{id:7,mobilePhone:config.branch==='hanoi'?'0901111111':'0902222222'},{id:8,mobilePhone:''}]);
 }})});
 assert.deepEqual(await Promise.all([lookup('hanoi',7),lookup('hanoi',7)]),['0901111111','0901111111']);
 assert.equal(calls,1);assert.equal(await lookup('saigon',7),'0902222222');assert.equal(await lookup('hanoi',8),'');
 assert.equal(await lookup('hanoi',999),'');assert.equal(await lookup('unknown',7),'');
 time=301000;assert.equal(await lookup('hanoi',7),'0901111111');assert.equal(calls,3);
 let fail=true,attempts=0;
 const retry=kiotData.createSellerPhoneLookup({now:()=>time,getBranches:()=>[{branch:'hanoi'}],createClient:()=>({fetchAllPages:async(e,q,cb)=>{attempts++;if(fail)throw new Error('API unavailable');await cb([{id:7,mobilePhone:'0903333333'}]);}})});
 assert.equal(await retry('hanoi',7),'');assert.equal(await retry('hanoi',7),'');assert.equal(attempts,1);
 fail=false;time+=31000;assert.equal(await retry('hanoi',7),'0903333333');
});
