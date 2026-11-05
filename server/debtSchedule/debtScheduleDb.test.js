'use strict';

// Chay SQL THAT cua migration 0047 + job chot 15:00 + repository tren PGlite.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { takeDebtCycleSnapshot, refreshDebtCycle, takeDebtCycleSnapshotIfDue, __test__ } = require('./debtCycleSnapshot');
const { createDebtScheduleRepository } = require('./debtScheduleRepository');
const { buildCustomerRow } = require('./debtScheduleRules');

const MIGRATION = ['0047_debt_schedule_report.sql', '0048_debt_penalty.sql', '0050_debt_cycle_manual_refresh.sql','0051_debt_penalty_ledger.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8')).join(' ');

// Bang toi thieu cua KiotViet ma job/repository doc.
const BASE_SCHEMA = `
  CREATE TABLE customers (branch TEXT, id BIGINT, code TEXT, name TEXT, debt NUMERIC, raw JSONB, PRIMARY KEY (branch, id));
  CREATE TABLE invoices (branch TEXT, id BIGINT, customer_id BIGINT, purchase_date TIMESTAMPTZ, total NUMERIC, raw JSONB);
  CREATE TABLE returns (branch TEXT, id BIGINT, customer_id BIGINT, return_date TIMESTAMPTZ, total NUMERIC, raw JSONB);
`;

function poolFor(db) {
  return {
    query: (sql, params) => db.query(sql, params),
    connect: async () => ({ query: (sql, params) => db.query(sql, params), release() {} })
  };
}

async function setup() {
  const db = new PGlite();
  await db.exec(BASE_SCHEMA);
  await db.exec(MIGRATION);
  return { db, pool: poolFor(db) };
}

const noAverages = async () => ({ branches: [], codes: [], values: [] });

test('active-only snapshot skips normalized and legacy inactive customers, preserving normalized precedence and missing flags', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await db.exec(`UPDATE customers SET raw = '{"isActive":false}' WHERE branch='hanoi' AND id=1;
      UPDATE customers SET raw = '{"IsActive":false}' WHERE branch='hanoi' AND id=2;
      INSERT INTO customers VALUES
        ('hanoi',3,'KH3','Active normalized',100,'{"isActive":true,"IsActive":false}'),
        ('hanoi',4,'KH4','Legacy inactive',100,'{"isActive":null,"IsActive":false}');`);
    const result = await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    assert.equal(result.customers, 2);
    assert.deepEqual((await db.query('SELECT branch, customer_id::text AS id FROM debt_cycle_customers ORDER BY branch, customer_id')).rows,
      [{ branch: 'hanoi', id: '3' }, { branch: 'saigon', id: '1' }]);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_cycle_amounts')).rows[0].n, 0);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM customers')).rows[0].n, 5);
  } finally { await db.close(); }
});

test('inactive stale snapshots disappear from current and historical reports without deleting stored audit', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    for (const date of ['2026-08-08','2026-08-09']) await takeDebtCycleSnapshot(pool, date, { takenAt: at15(date), log: () => {}, loadAverages: noAverages });
    const repo = createDebtScheduleRepository({ pool });
    assert.equal((await repo.readReport(['hanoi','saigon'])).rows.length, 3);
    await db.exec(`UPDATE customers SET raw = '{"isActive":false}' WHERE branch='hanoi' AND id=1;
      UPDATE customers SET raw = '{"IsActive":false}' WHERE branch='hanoi' AND id=2;`);
    repo.bumpVersion();
    for (const date of [undefined, '2026-08-08']) {
      const report = await repo.readReport(['hanoi','saigon'], date);
      assert.deepEqual(report.rows.map(row => row.branch + ':' + row.customerId), ['saigon:1']);
      assert.equal(report.amountsByCustomer.has('hanoi:1'), false);
    }
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_cycle_customers')).rows[0].n, 6);
    assert.ok((await db.query('SELECT COUNT(*)::int AS n FROM debt_cycle_amounts')).rows[0].n > 0);
  } finally { await db.close(); }
});

test('inactive customer edits are rejected and visible history is filtered while audit rows survive', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    const repo = createDebtScheduleRepository({ pool });
    const target = { branch:'hanoi', customerId:'1', user:{ id:'m1', hoTen:'Manager' } };
    await repo.setSchedule({ ...target, days:3 });
    await repo.saveFeedback({ ...target, field:'sale', value:'Original' });
    const auditCount = (await db.query('SELECT COUNT(*)::int AS n FROM debt_feedback_history')).rows[0].n;
    await db.exec(`UPDATE customers SET raw = '{"isActive":false}' WHERE branch='hanoi' AND id=1`);
    for (const write of [
      () => repo.setSchedule({ ...target, days:7 }),
      () => repo.withTransaction(client => repo.setScheduleWith(client, { ...target, days:7, source:'import' })),
      () => repo.saveFeedback({ ...target, field:'sale', value:'Changed' }),
      () => repo.saveFeedback({ ...target, field:'manager', value:'Changed' }),
      () => repo.saveStatus({ ...target, status:'Đã xử lý' }),
      () => repo.saveHistoricalStatus({ ...target, cycleDate:'2026-08-08', status:'Đã xử lý' })
    ]) await assert.rejects(write, error => error.statusCode === 404);
    assert.deepEqual((await repo.listFeedbackHistory({ branches:['hanoi'] })).entries, []);
    assert.deepEqual(await repo.listScheduleLog(), []);
    assert.deepEqual(await repo.listScheduleLog({ branch:'hanoi', customerId:'1' }), []);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_feedback_history')).rows[0].n, auditCount);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM debt_payment_schedule_log')).rows[0].n, 1);
    assert.equal((await db.query('SELECT schedule_days FROM debt_payment_schedules')).rows[0].schedule_days, 3);
  } finally { await db.close(); }
});

test('report cache expires so customer activity changes cannot leave stale reports indefinitely', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    let now = 1000;
    const repo = createDebtScheduleRepository({ pool, now: () => now });
    assert.equal((await repo.readReport(['hanoi'])).rows.length, 2);
    await db.exec(`UPDATE customers SET raw = '{"isActive":false}' WHERE branch='hanoi' AND id=1`);
    now += 301000;
    assert.deepEqual((await repo.readReport(['hanoi'])).rows.map(row => row.customerId), ['2']);
  } finally { await db.close(); }
});

test('amountsByCustomer gom theo khach: dung hinh dang Map<branch:id, [{day,invoiceAmount,returnAmount}]> tang dan theo ngay, so la Number', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    const report = await createDebtScheduleRepository({ pool }).readReport(['hanoi', 'saigon']);
    assert.deepEqual([...report.amountsByCustomer.keys()], ['hanoi:1']);
    assert.deepEqual(report.amountsByCustomer.get('hanoi:1'), [
      { day: '2026-08-05', invoiceAmount: 100, returnAmount: 0 },
      { day: '2026-08-07', invoiceAmount: 300, returnAmount: 50 },
      { day: '2026-08-08', invoiceAmount: 200, returnAmount: 0 }
    ]);
  } finally { await db.close(); }
});

// Chot dung 15:00 VN ngay date.
const at15 = date => new Date(`${date}T08:00:00Z`);

async function seedKiot(db) {
  await db.exec(`
    INSERT INTO customers VALUES
      ('hanoi', 1, 'KH1', 'Khách Một', 800, '{"groups":"Lan"}'),
      ('hanoi', 2, 'KH2', 'Khách Hai', 0, '{"groups":"Lan"}'),
      ('saigon', 1, 'KH1', 'Khách Một SG', 300, '{}');
    -- Gio VN gan nhan UTC: 8/8 15:00 la moc chot.
    INSERT INTO invoices VALUES
      ('hanoi', 10, 1, '2026-08-08 10:00+00', 200, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 11, 1, '2026-08-08 16:00+00', 999, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 12, 1, '2026-08-07 09:00+00', 300, '{"statusValue":"Hoàn thành"}'),
      ('hanoi', 13, 1, '2026-08-06 09:00+00', 500, '{"statusValue":"Đã hủy"}'),
      ('hanoi', 14, 1, '2026-08-05 09:00+00', 100, '{"statusValue":"Hoàn thành"}'),
      ('saigon', 15, 1, '2026-08-08 09:00+00', 300, '{"statusValue":"Đang xử lý"}');
    INSERT INTO returns VALUES
      ('hanoi', 20, 1, '2026-08-07 11:00+00', -50, '{"statusValue":"Đã trả"}'),
      ('hanoi', 21, 1, '2026-08-07 12:00+00', -70, '{"statusValue":"Đã hủy"}');
  `);
}

test('migration 0047: khoa chinh dung, lich TT 1..90, nhat ky lich TT chi them', async () => {
  const { db } = await setup();
  try {
    await assert.rejects(db.query(`INSERT INTO debt_payment_schedules (branch, customer_id, schedule_days) VALUES ('hanoi', 1, 0)`), /check/i);
    await assert.rejects(db.query(`INSERT INTO debt_payment_schedules (branch, customer_id, schedule_days) VALUES ('danang', 1, 3)`), /check/i);
    await db.query(`INSERT INTO debt_payment_schedule_log (branch, customer_id, new_days, source) VALUES ('hanoi', 1, 3, 'web')`);
    await assert.rejects(db.query('DELETE FROM debt_payment_schedule_log'), /immutable/);
    await assert.rejects(db.query(`INSERT INTO debt_feedback_history (cycle_date, branch, customer_id, field) VALUES ('2026-10-13', 'hanoi', 1, 'note')`), /check/i);
  } finally { await db.close(); }
});

test('chot 15:00: toan bo khach 2 co so (ca no 0), so tien theo ngay cat dung 15:00, chi don Hoan thanh, bo don huy/dang xu ly/phieu tra huy', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    const result = await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: async () => ({ branches: ['hanoi'], codes: ['KH1'], values: [4000] }) });
    assert.deepEqual(result, { cycleDate: '2026-08-08', created: true, customers: 3 });
    const { rows: customers } = await db.query(`SELECT branch, customer_id::int AS id, current_debt::int AS debt, opening_debt, avg_revenue_4m::int AS avg FROM debt_cycle_customers ORDER BY branch, customer_id`);
    assert.deepEqual(customers, [
      { branch: 'hanoi', id: 1, debt: 800, opening_debt: null, avg: 4000 },
      { branch: 'hanoi', id: 2, debt: 0, opening_debt: null, avg: null },
      { branch: 'saigon', id: 1, debt: 300, opening_debt: null, avg: null }
    ]);
    const { rows: amounts } = await db.query(`SELECT branch, day::text AS day, invoice_amount::int AS inv, return_amount::int AS ret FROM debt_cycle_amounts ORDER BY branch, day`);
    assert.deepEqual(amounts, [
      { branch: 'hanoi', day: '2026-08-05', inv: 100, ret: 0 },
      { branch: 'hanoi', day: '2026-08-07', inv: 300, ret: 50 },
      { branch: 'hanoi', day: '2026-08-08', inv: 200, ret: 0 }
    ]);
    const again = await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    assert.equal(again.created, false, 'moi ngay chot 1 lan');

    await db.query(`UPDATE customers SET debt = 500 WHERE branch = 'hanoi' AND id = 1`);
    await takeDebtCycleSnapshot(pool, '2026-08-09', { takenAt: at15('2026-08-09'), log: () => {}, loadAverages: noAverages });
    const { rows } = await db.query(`SELECT current_debt::int AS debt, opening_debt::int AS opening FROM debt_cycle_customers WHERE cycle_date = '2026-08-09' AND branch = 'hanoi' AND customer_id = 1`);
    assert.deepEqual(rows, [{ debt: 500, opening: 800 }], 'no dau ky = no hien tai cua ban chot truoc');
  } finally { await db.close(); }
});

test('xuat ban chot cu: listCycles moi nhat truoc (toi da 7), readReport(ngay) doc dung ban do, ngoai 7 ngay/sai dinh dang bi tu choi', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    const repo = createDebtScheduleRepository({ pool });
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    await db.query(`UPDATE customers SET debt = 500 WHERE branch = 'hanoi' AND id = 1`);
    await takeDebtCycleSnapshot(pool, '2026-08-09', { takenAt: at15('2026-08-09'), log: () => {}, loadAverages: noAverages });

    const cycles = await repo.listCycles();
    assert.deepEqual(cycles.map(cycle => cycle.cycleDate), ['2026-08-09', '2026-08-08']);

    const latest = await repo.readReport(['hanoi']);
    assert.equal(latest.cycle.cycleDate, '2026-08-09', 'bo trong ngay = ban moi nhat');
    const old = await repo.readReport(['hanoi'], '2026-08-08');
    assert.equal(old.cycle.cycleDate, '2026-08-08');
    assert.equal(old.rows.find(row => row.customerId === '1').currentDebt, 800, 'no cua ban chot ngay 8, khong phai no hien tai');
    assert.equal(latest.rows.find(row => row.customerId === '1').currentDebt, 500);
    assert.equal((await repo.readReport(['hanoi'])).cycle.cycleDate, '2026-08-09', 'doc ban cu khong lam hong cache ban moi nhat');

    await assert.rejects(repo.readReport(['hanoi'], '2026-08-01'), err => err.statusCode === 404 && err.code === 'DEBT_CYCLE_NOT_FOUND');
    await assert.rejects(repo.readReport(['hanoi'], '8/8'), err => err.statusCode === 400 && err.code === 'INVALID_CYCLE_DATE');

    // Chi 7 ban gan nhat duoc xuat: them 7 ngay moi thi ngay 8/8 roi khoi danh sach.
    for (let day = 10; day <= 16; day += 1) {
      const date = `2026-08-${day}`;
      await takeDebtCycleSnapshot(pool, date, { takenAt: at15(date), log: () => {}, loadAverages: noAverages });
    }
    assert.equal((await repo.listCycles()).length, 7);
    await assert.rejects(repo.readReport(['hanoi'], '2026-08-08'), err => err.code === 'DEBT_CYCLE_NOT_FOUND');
  } finally { await db.close(); }
});

test('chot TRE (16:53): don sau 15:00 truoc luc chot da nam trong no hien tai nen cung tinh vao no trong lich', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: new Date('2026-08-08T09:53:00Z'), log: () => {}, loadAverages: noAverages });
    const { rows } = await db.query(`SELECT invoice_amount::int AS inv, overdue_debt::int AS overdue
      FROM debt_cycle_amounts a JOIN debt_cycle_customers c USING (cycle_date, branch, customer_id)
      WHERE a.branch = 'hanoi' AND a.customer_id = 1 AND a.day = '2026-08-08'`);
    assert.deepEqual(rows, [{ inv: 1199, overdue: 0 }], 'no 800 - trong lich 1199 -> qua han 0, khong du 999');
  } finally { await db.close(); }
});

test('tinh lai bang tay: ghi de chu ky dang mo tai luc bam, giu phan hoi, khong cong phien, chan bam lien', async () => {
  const { db, pool } = await setup();
  try {
    await assert.rejects(refreshDebtCycle(pool, { log: () => {}, loadAverages: noAverages }), err => err.statusCode === 409);
    await seedKiot(db);
    await db.query("UPDATE customers SET debt = 2000000 WHERE branch = 'hanoi' AND id = 1");
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    await db.query("INSERT INTO debt_cycle_feedback (cycle_date, branch, customer_id, sale_feedback) VALUES ('2026-08-08', 'hanoi', 1, 'hen thu 9/8')");
    const before = (await db.query("SELECT overdue_debt::int AS o, overdue_streak AS s FROM debt_cycle_customers WHERE branch = 'hanoi' AND customer_id = 1")).rows[0];
    // Sang 9/8 09:00 (truoc chot 15:00): khach tra bot no, co them don 9/8.
    await db.query("UPDATE customers SET debt = 1500000 WHERE branch = 'hanoi' AND id = 1");
    await db.query(`INSERT INTO invoices VALUES ('hanoi', 30, 1, '2026-08-09 08:00+00', 1000, '{"statusValue":"Hoàn thành"}')`);
    const result = await refreshDebtCycle(pool, { takenAt: new Date('2026-08-09T02:00:00Z'), userName: 'QL A', log: () => {}, loadAverages: noAverages });
    assert.equal(result.cycleDate, '2026-08-08', 'van la chu ky dang mo');
    const after = (await db.query("SELECT current_debt::int AS d, overdue_debt::int AS o, overdue_streak AS s FROM debt_cycle_customers WHERE branch = 'hanoi' AND customer_id = 1")).rows[0];
    // Tinh lai luc 9/8: cua so truot theo ngay tinh lai, lich 1 ngay = CHI don 9/8 (1000).
    assert.deepEqual(after, { d: 1500000, o: 1500000 - 1000, s: before.s }, 'no moi, khong cong phien');
    const fb = (await db.query("SELECT sale_feedback FROM debt_cycle_feedback WHERE cycle_date = '2026-08-08'")).rows;
    assert.deepEqual(fb, [{ sale_feedback: 'hen thu 9/8' }], 'phan hoi giu nguyen');
    const run = (await db.query("SELECT refreshed_by_name, customer_count FROM debt_cycle_runs")).rows[0];
    assert.deepEqual(run, { refreshed_by_name: 'QL A', customer_count: 3 });
    await assert.rejects(refreshDebtCycle(pool, { takenAt: new Date('2026-08-09T02:00:30Z'), log: () => {}, loadAverages: noAverages }), err => err.statusCode === 429);
  } finally { await db.close(); }
});

test('so phien lien tiep: +1 moi chot khi qua han >= 400k, Da xu ly reset chuoi, het no cham reset 0', async () => {
  const { db, pool } = await setup();
  try {
    await db.query(`INSERT INTO customers (branch, id, code, name, debt, raw) VALUES
      ('hanoi', 1, 'KH1', 'A', 900000, '{}'), ('hanoi', 2, 'KH2', 'B', 300000, '{}')`);
    await db.query(`INSERT INTO invoices (branch, id, customer_id, purchase_date, total, raw) VALUES
      ('hanoi', 1, 1, '2026-08-08 02:00+00', 200000, '{"statusValue":"Hoàn thành"}')`);
    const take = date => takeDebtCycleSnapshot(pool, date, { takenAt: at15(date), log: () => {}, loadAverages: noAverages });
    const streak = async date => (await db.query(`SELECT customer_id::int AS id, overdue_debt::int AS overdue, overdue_streak AS streak FROM debt_cycle_customers WHERE cycle_date = $1 ORDER BY customer_id`, [date])).rows;
    await take('2026-08-08');
    assert.deepEqual(await streak('2026-08-08'), [{ id: 1, overdue: 700000, streak: 1 }, { id: 2, overdue: 300000, streak: 0 }], 'chot dau: phien 1; no le = 0');
    await take('2026-08-09');
    assert.equal((await streak('2026-08-09'))[0].streak, 2);
    await db.query(`INSERT INTO debt_cycle_feedback (cycle_date, branch, customer_id, status) VALUES ('2026-08-09', 'hanoi', 1, 'Đã xử lý')`);
    await take('2026-08-10');
    assert.equal((await streak('2026-08-10'))[0].streak, 1, 'Da xu ly o chu ky truoc: chuoi reset, phien 1');
    await take('2026-08-11');
    assert.equal((await streak('2026-08-11'))[0].streak, 2, 'khong con Da xu ly: +1');
    await db.query(`UPDATE customers SET debt = 100000 WHERE id = 1`);
    await take('2026-08-12');
    assert.equal((await streak('2026-08-12'))[0].streak, 0, 'het no cham thi reset 0');
  } finally { await db.close(); }
});

test('den han chot: tu 15:00 VN, chi cho hom nay', () => {
  const { cycleDateDue } = __test__;
  assert.equal(cycleDateDue(null, new Date('2026-10-13T07:59:00Z')), null, '14:59 VN');
  assert.equal(cycleDateDue(null, new Date('2026-10-13T08:00:00Z')), '2026-10-13', '15:00 VN');
  assert.equal(cycleDateDue('2026-10-13', new Date('2026-10-13T10:00:00Z')), null, 'da chot hom nay');
  assert.equal(cycleDateDue('2026-10-12', new Date('2026-10-13T02:00:00Z')), null, '9:00 VN hom sau: chua toi gio');
});

test('takeIfDue dong bo khach truoc khi chot va bao co ban chot moi', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    const events = [];
    const result = await takeDebtCycleSnapshotIfDue(pool, {
      log: () => {}, now: () => new Date('2026-08-08T08:30:00Z'), loadAverages: noAverages,
      beforeSnapshot: async () => events.push('sync'), onSnapshot: () => events.push('bump')
    });
    assert.equal(result.cycleDate, '2026-08-08');
    assert.deepEqual(events, ['sync', 'bump']);
  } finally { await db.close(); }
});

test('repository: lich TT doc truc tiep (sua la doi no qua han ngay), phan hoi + lich su theo chu ky, sang chu ky moi thi trong', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    const repo = createDebtScheduleRepository({ pool });
    const overdueOf = async () => {
      const { cycle, rows, amountsByCustomer } = await repo.readReport(['hanoi']);
      const row = rows.find(item => item.customerId === '1');
      return buildCustomerRow(row, { cycleDate: cycle.cycleDate, dailyAmounts: amountsByCustomer.get('hanoi:1') }).overdueDebt;
    };
    assert.equal(await overdueOf(), 600, 'chua co lich = 1 ngay: 800 - 200');

    const manager = { id: 'm1', hoTen: 'Quản lý A' };
    const set = await repo.setSchedule({ branch: 'hanoi', customerId: '1', days: 3, user: manager });
    assert.equal(set.changed, true);
    assert.equal(await overdueOf(), 300, 'lich 3 ngay: 800 - 200 - 300 (khong tinh tra hang)');
    assert.equal((await repo.setSchedule({ branch: 'hanoi', customerId: '1', days: '3', user: manager })).changed, false);
    const log = await repo.listScheduleLog({ branch: 'hanoi', customerId: '1' });
    assert.deepEqual(log.map(item => [item.oldDays, item.newDays, item.source, item.actorName, item.customerCode]), [[null, 3, 'web', 'Quản lý A', 'KH1']]);
    await assert.rejects(repo.setSchedule({ branch: 'hanoi', customerId: '1', days: 'Hàng tuần', user: manager }), error => error.statusCode === 400);

    const sale = { id: 's1', hoTen: 'Lan' };
    await repo.saveFeedback({ field: 'sale', branch: 'hanoi', customerId: '1', cycleDate: '2026-08-08', value: 'Khách hẹn thứ 2', user: sale });
    await repo.saveFeedback({ field: 'sale', branch: 'hanoi', customerId: '1', value: 'Khách hẹn thứ 3', user: sale });
    await repo.saveFeedback({ field: 'sale', branch: 'hanoi', customerId: '1', value: 'Khách hẹn thứ 3', user: sale });
    await repo.saveStatus({ branch: 'hanoi', customerId: '1', status: 'Bỏ qua', user: manager });
    const history = await repo.listFeedbackHistory({ branches: ['hanoi'] });
    assert.deepEqual(history.entries.map(item => [item.field, item.oldValue, item.newValue, item.actorName]).sort(), [
      ['schedule', '', '3', 'Quản lý A'],
      ['sale', '', 'Khách hẹn thứ 2', 'Lan'],
      ['sale', 'Khách hẹn thứ 2', 'Khách hẹn thứ 3', 'Lan'],
      ['status', 'Chưa xử lý', 'Bỏ qua', 'Quản lý A']
    ].sort(), 'moi thay doi tren giao dien vao lich su; noi dung khong doi thi khong ghi');
    let report = await repo.readReport(['hanoi']);
    assert.equal(report.rows[0].feedback.saleFeedback, 'Khách hẹn thứ 3');
    assert.equal(report.rows[0].feedback.status, 'Bỏ qua');

    await assert.rejects(
      repo.saveFeedback({ field: 'manager', branch: 'hanoi', customerId: '99', value: 'x', user: manager }),
      error => error.statusCode === 404, 'khach khong co trong ban chot'
    );

    await takeDebtCycleSnapshot(pool, '2026-08-09', { takenAt: at15('2026-08-09'), log: () => {}, loadAverages: noAverages });
    repo.bumpVersion();
    report = await repo.readReport(['hanoi']);
    assert.equal(report.cycle.cycleDate, '2026-08-09');
    assert.equal(report.rows[0].feedback.saleFeedback, '', 'sang chu ky moi phan hoi tu trong');
    assert.equal(report.rows[0].feedback.status, 'Chưa xử lý');
    assert.equal(report.rows[0].scheduleDays, 3, 'lich TT giu nguyen qua chu ky');
    assert.deepEqual((await repo.listFeedbackHistory({ branches: ['hanoi'] })).entries, []);
    await assert.rejects(
      repo.saveFeedback({ field: 'sale', branch: 'hanoi', customerId: '1', cycleDate: '2026-08-08', value: 'cũ', user: sale }),
      error => error.statusCode === 409, 'man hinh chu ky cu bi chan'
    );
  } finally { await db.close(); }
});

test('khong con phat tay: repository khong co savePenalty, du lieu debt_cycle_penalties cu khong anh huong bao cao', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    const repo = createDebtScheduleRepository({ pool });
    assert.equal(repo.savePenalty, undefined);
    await db.exec(`INSERT INTO debt_cycle_penalties (cycle_date, branch, customer_id, amount) VALUES ('2026-08-08', 'hanoi', 1, 40000)`);
    repo.bumpVersion();
    const row = (await repo.readReport(['hanoi'])).rows[0];
    assert.equal('penaltyOverride' in row, false);
    assert.equal(buildCustomerRow(row, { cycleDate: '2026-08-08', dailyAmounts: [] }).penaltyAmount, 25000);
  } finally { await db.close(); }
});

test('tinh lai sau 15:00 khi chua co ban chot hom nay: TAO ban chot hom nay', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    // 9/8 15:40 VN (08:40Z): chua co ban chot 9/8.
    const result = await refreshDebtCycle(pool, { takenAt: new Date('2026-08-09T08:40:00Z'), userName: 'QL A', log: () => {}, loadAverages: noAverages });
    assert.equal(result.cycleDate, '2026-08-09');
    assert.equal(result.created, true);
    const runs = (await db.query('SELECT cycle_date::text AS d FROM debt_cycle_runs ORDER BY 1')).rows.map(r => r.d);
    assert.deepEqual(runs, ['2026-08-08', '2026-08-09']);
  } finally { await db.close(); }
});

test('tinh lai khi ban chot cuoi da cu 3 ngay: tao ban chot dung ngay muc tieu (truoc 15:00 = hom qua)', async () => {
  const { db, pool } = await setup();
  try {
    await seedKiot(db);
    await takeDebtCycleSnapshot(pool, '2026-08-08', { takenAt: at15('2026-08-08'), log: () => {}, loadAverages: noAverages });
    const result = await refreshDebtCycle(pool, { takenAt: new Date('2026-08-11T02:00:00Z'), log: () => {}, loadAverages: noAverages });
    assert.equal(result.cycleDate, '2026-08-10');
    assert.equal(result.created, true);
  } finally { await db.close(); }
});
