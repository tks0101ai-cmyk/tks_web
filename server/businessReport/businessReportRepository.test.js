'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seed } = require('./testFixtures');
const { createRepository } = require('./businessReportRepository');

function poolFrom(db) {
  return { query: (text, params) => db.query(text, params), connect: async () => ({ query: (t, p) => db.query(t, p), release() {} }) };
}

test('snapshot: thang da chot doc bang, thang chua chot tinh truc tiep; danh ba co sale/level gia; cache 60s', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seed(db);
    let now = new Date('2026-10-06T03:00:00Z');
    const repo = createRepository({ pool: poolFrom(db), now: () => now });
    // Chua chot thang nao => thang 9 tinh live
    let snap = await repo.snapshot();
    assert.equal(snap.currentMonth, '2026-10-01');
    assert.equal(snap.day, 6);
    assert.equal(snap.months[0], '2026-03-01');
    assert.deepEqual(snap.frozenMonths, []);
    assert.equal(snap.customers.find(r => r.month === '2026-09-01' && r.customerCode === 'KH1').netRevenue, 810);
    assert.equal(snap.customers.find(r => r.month === '2026-10-01' && r.customerCode === 'KH1').netRevenue, 500);
    assert.deepEqual(snap.directory.find(d => d.branch === 'hanoi' && d.code === 'KH1'),
      { branch: 'hanoi', code: 'KH1', name: 'Chị A', saleName: 'Khang', priceLevel: 'lớn' });
    // Live revenue snapshots no longer derive level from email; routes overlay local levels.
    assert.equal(snap.directory.find(d => d.branch === 'hanoi' && d.code === 'KH2').priceLevel, 'lớn');
    // Chot thang 9 bang repo.refreeze => doc tu bang
    await repo.refreeze('2026-09');
    snap = await repo.snapshot();
    assert.ok(snap.frozenMonths.includes('2026-09-01'));
    assert.equal(snap.sales.find(s => s.month === '2026-09-01' && s.saleName === 'Khang').netRevenue, 810);
    // Cache: them hoa don moi, trong 60s van so cu; qua 60s thi so moi
    await db.exec(`INSERT INTO invoices VALUES ('hanoi', 105, 'HD5', '2026-10-05 10:00:00+00', 50, 1, '{"statusValue":"Hoàn thành","customerCode":"KH1"}')`);
    assert.equal((await repo.snapshot()).customers.find(r => r.month === '2026-10-01' && r.customerCode === 'KH1').netRevenue, 500);
    now = new Date(now.getTime() + 61000);
    // Het 60s: stale-while-revalidate => tra NGAY so cu, lam moi o nen; lan doc sau thay so moi.
    assert.equal((await repo.snapshot()).customers.find(r => r.month === '2026-10-01' && r.customerCode === 'KH1').netRevenue, 500);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal((await repo.snapshot()).customers.find(r => r.month === '2026-10-01' && r.customerCode === 'KH1').netRevenue, 550);
  } finally { await db.close(); }
});

test('top ma hang cua khach va top khach cua ma hang trong cac thang chi dinh (gop thang chot + live)', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seed(db);
    const repo = createRepository({ pool: poolFrom(db), now: () => new Date('2026-10-06T03:00:00Z') });
    await repo.refreeze('2026-09');
    const months = ['2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'];
    const top = await repo.customerProducts({ branch: 'hanoi', customerCode: 'KH1', months });
    assert.deepEqual(top.map(r => [r.productCode, r.revenue]), [['SP1', 950], ['SP2', 360]]); // 450 + 500 (T10)
    const buyers = await repo.productCustomers({ productCode: 'SP2', months });
    assert.deepEqual(buyers.map(r => [r.branch, r.customerCode, r.revenue]), [['hanoi', 'KH1', 360], ['hanoi', 'KH2', 200]]);
  } finally { await db.close(); }
});

// Pool bao PGlite co the: dem so lan doc bang state (= 1 lan tai snapshot), giu ket qua lai
// (gate) SAU khi truy van da chay de mo phong tai nen dang do dang, va gay loi theo y.
const STATE_SELECT = `SELECT to_char(month, 'YYYY-MM-DD') AS month, group_hash FROM business_monthly_state`;
function controllablePool(db) {
  const ctl = { loads: 0, gate: null, fail: false };
  const pool = {
    ctl,
    query: async (text, params) => {
      // Stub giao dich doc de PGlite mot session cho phep test cache/refreeze chen nhau.
      if (/^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SAVEPOINT |RELEASE SAVEPOINT |ROLLBACK TO SAVEPOINT )/.test(text) || text === 'ROLLBACK') return {rows:[]};
      if (String(text).includes(STATE_SELECT)) {
        ctl.loads += 1;
        if (ctl.fail) throw new Error('db down');
        const result = await db.query(text, params);
        if (ctl.gate) await ctl.gate.promise;
        return result;
      }
      return db.query(text, params);
    },
    connect: async () => ({ query: (t, p) => pool.query(t, p), release() {} })
  };
  return pool;
}
function gate() {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
}
const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, tries = 100) {
  for (let i = 0; i < tries; i++) { if (check()) return; await tick(10); }
  throw new Error('qua han cho dieu kien');
}
const kh1Oct = snap => snap.customers.find(r => r.month === '2026-10-01' && r.customerCode === 'KH1').netRevenue;

test('SWR: het ttl tra ngay ban cu, lam moi nen (1 lan du nhieu nguoi goi), lan doc sau thay so moi', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seed(db);
    let now = new Date('2026-10-06T03:00:00Z');
    const pool = controllablePool(db);
    const repo = createRepository({ pool, now: () => now });
    assert.equal(kh1Oct(await repo.snapshot()), 500);
    assert.equal(pool.ctl.loads, 1);
    await db.exec(`INSERT INTO invoices VALUES ('hanoi', 105, 'HD5', '2026-10-05 10:00:00+00', 50, 1, '{"statusValue":"Hoàn thành","customerCode":"KH1"}')`);
    now = new Date(now.getTime() + 61000);
    pool.ctl.gate = gate(); // giu tai nen lai de kiem tra tra-ngay-ban-cu
    const stale = await repo.snapshot();
    assert.equal(kh1Oct(stale), 500, 'tra ngay ban cu, khong cho tai nen');
    await repo.snapshot(); await repo.snapshot();
    await until(() => pool.ctl.loads === 2);
    assert.equal(pool.ctl.loads, 2, 'chi 1 lan tai nen du 3 nguoi goi (khong dam dong)');
    assert.equal(kh1Oct(await repo.snapshot()), 500, 'tai nen chua xong van ban cu');
    pool.ctl.gate.release(); pool.ctl.gate = null;
    await until(() => pool.ctl.loads === 2);
    await tick(100);
    assert.equal(kh1Oct(await repo.snapshot()), 550, 'sau khi nen xong thi doc ra so moi');
    assert.equal(pool.ctl.loads, 2);
  } finally { await db.close(); }
});

test('SWR: lam moi nen that bai thi giu ban cu va ghi log; lan lam moi sau thanh cong van cap nhat', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  const origError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    await seed(db);
    let now = new Date('2026-10-06T03:00:00Z');
    const pool = controllablePool(db);
    const repo = createRepository({ pool, now: () => now });
    assert.equal(kh1Oct(await repo.snapshot()), 500);
    await db.exec(`INSERT INTO invoices VALUES ('hanoi', 105, 'HD5', '2026-10-05 10:00:00+00', 50, 1, '{"statusValue":"Hoàn thành","customerCode":"KH1"}')`);
    now = new Date(now.getTime() + 61000);
    pool.ctl.fail = true;
    assert.equal(kh1Oct(await repo.snapshot()), 500);
    await until(() => logs.length >= 1);
    assert.match(logs[0], /business-report/);
    assert.equal(kh1Oct(await repo.snapshot()), 500, 'loi nen khong lam mat ban cu, khong nem loi cho nguoi dung');
    pool.ctl.fail = false;
    // Lan doc tiep theo khoi dong lam moi nen thanh cong (moi lan doc chi tra ban cu cho den khi xong).
    let value = 0;
    for (let i = 0; i < 100 && value !== 550; i++) { value = kh1Oct(await repo.snapshot()); if (value !== 550) await tick(20); }
    assert.equal(value, 550);
  } finally { console.error = origError; await tick(100); await db.close(); }
});

test('SWR: lan tai dau tien phai cho; loi o lan dau nem loi va khong cache loi', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seed(db);
    const pool = controllablePool(db);
    const repo = createRepository({ pool, now: () => new Date('2026-10-06T03:00:00Z') });
    pool.ctl.fail = true;
    await assert.rejects(() => repo.snapshot(), /db down/);
    pool.ctl.fail = false;
    assert.equal(kh1Oct(await repo.snapshot()), 500);
  } finally { await db.close(); }
});

test('refreeze xoa cache; tai nen dang do (bat dau truoc refreeze) khong duoc ghi de bang so cu', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seed(db);
    let now = new Date('2026-10-06T03:00:00Z');
    const pool = controllablePool(db);
    const repo = createRepository({ pool, now: () => now });
    assert.deepEqual((await repo.snapshot()).frozenMonths, []);
    now = new Date(now.getTime() + 61000);
    pool.ctl.gate = gate(); // tai nen doc state TRUOC refreeze roi bi giu lai
    await repo.snapshot();
    await until(() => pool.ctl.loads === 2);
    await repo.refreeze('2026-09');
    pool.ctl.gate.release(); pool.ctl.gate = null;
    await tick(200); // cho tai nen cu xong (ket qua cu: chua co thang chot)
    const snap = await repo.snapshot();
    assert.ok(snap.frozenMonths.includes('2026-09-01'), 'khong bi ban cu ghi de len cache da xoa');
    assert.equal(snap.sales.find(s => s.month === '2026-09-01' && s.saleName === 'Khang').netRevenue, 810);
  } finally { await db.close(); }
});

test('snapshot doc team tu sale_teams; thieu bang sale_teams thi teams rong, bao cao van chay', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seed(db);
    await db.exec(`INSERT INTO sale_teams (sale_name, team_name) VALUES ('Khang', 'Team Khang')`);
    const now = () => new Date('2026-10-06T03:00:00Z');
    let snap = await createRepository({ pool: poolFrom(db), now }).snapshot();
    assert.ok(snap.teams.some(t => t.saleName === 'Khang' && t.teamName === 'Team Khang'));
    await db.exec('DROP TABLE sale_teams');
    snap = await createRepository({ pool: poolFrom(db), now }).snapshot();
    assert.deepEqual(snap.teams, []);
    assert.equal(snap.notReady, true, 'thang cu chua chot => van notReady nhu cu, khong phai do sale_teams');
    assert.ok(snap.customers.length > 0);
  } finally { await db.close(); }
});

test('snapshot bo khach va ma hang ngung hoat dong (chi ma ngung o moi co so moi bi loai)', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seed(db);
    // KH2 ngung hoat dong; SP2 ngung kinh doanh.
    await db.exec(`UPDATE customers SET raw = '{"isActive":false}' WHERE code = 'KH2';
      UPDATE products SET is_active = false WHERE code = 'SP2'`);
    const repo = createRepository({ pool: poolFrom(db), now: () => new Date('2026-10-06T03:00:00Z') });
    const snap = await repo.snapshot();
    assert.equal(snap.customers.some(r => r.customerCode === 'KH2'), false);
    assert.equal(snap.directory.some(d => d.code === 'KH2'), false);
    assert.ok(snap.customers.some(r => r.customerCode === 'KH1'));
    assert.equal(snap.products.some(r => r.productCode === 'SP2'), false);
    assert.ok(snap.products.some(r => r.productCode === 'SP1'));
  } finally { await db.close(); }
});

test('setSaleTeam: doi team, team moi, bo khoi team, khop khong phan biet hoa/thuong, xoa cache snapshot', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await seed(db);
    await db.exec(`INSERT INTO sale_teams (sale_name, team_name) VALUES ('Khang', 'Team Khang'), ('Trinh', 'Team Trinh')`);
    const repo = createRepository({ pool: poolFrom(db), now: () => new Date('2026-10-06T03:00:00Z') });
    const teamOf = async name => ((await repo.snapshot()).teams.find(t => t.saleName === name) || {}).teamName;
    assert.equal(await teamOf('Khang'), 'Team Khang');
    const count = async () => (await db.query('SELECT count(*)::int AS n FROM sale_teams')).rows[0].n;
    const before = await count();
    // Doi sang team co san, go khac hoa/thuong => dung cach viet da co, khong tao dong trung.
    const debtRepo = require('../debtSchedule/debtScheduleRepository').getDebtScheduleRepository();
    const debtVersion = debtRepo.getVersion();
    assert.deepEqual(await repo.setSaleTeam('khang', 'team   TRINH'), { saleName: 'Khang', team: 'Team Trinh' });
    assert.ok(debtRepo.getVersion() > debtVersion, 'changing team invalidates the debt dashboard cache');
    assert.equal(await teamOf('Khang'), 'Team Trinh');
    assert.equal(await count(), before);
    // Team moi
    assert.deepEqual(await repo.setSaleTeam('Khang', 'Team Mới'), { saleName: 'Khang', team: 'Team Mới' });
    assert.equal(await teamOf('Khang'), 'Team Mới');
    // Bo khoi team => xoa dong, 'Chua co team'
    assert.deepEqual(await repo.setSaleTeam('Khang', 'Chưa có team'), { saleName: 'Khang', team: 'Chưa có team' });
    assert.equal(await teamOf('Khang'), undefined);
    // Sale chua tung co trong sale_teams
    assert.deepEqual(await repo.setSaleTeam('Sale Mới', 'Team Trinh'), { saleName: 'Sale Mới', team: 'Team Trinh' });
    assert.equal(await teamOf('Sale Mới'), 'Team Trinh');
  } finally { await db.close(); }
});
