'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const svc = require('./businessReportService');
const { serviceSnapshot: snapshot } = require('./testFixtures');

test('bang khach: quy doi 30 ngay, tang truong, TB 4 thang, khach hoat dong, Khach le vao Chua phan nhom', () => {
  const r = svc.buildCustomerReport(snapshot());
  const a = r.rows.find(x => x.key === 'chị a');
  assert.equal(a.saleName, 'Khang');
  assert.equal(a.priceLevel, 'Level 2');
  assert.equal(a.normalized, 500);            // 100*30/6
  assert.equal(a.growth, 100);                // 500/500
  assert.equal(a.avg4, (500 + 0 + 0 + 100) / (31 + 31 + 30 + 6) * 30); // T7+T8+T9 = 92 ngay + 6 ngay T10
  assert.equal(a.active, true);
  assert.deepEqual(a.refs, [{ branch: 'hanoi', code: 'KH1' }]);
  assert.equal('branch' in a, false, 'khach da gop khong con co so');
  assert.equal('code' in a, false, 'khach da gop khong con ma KH');
  const le = r.rows.find(x => x.key === 'khách lẻ');
  assert.equal(le.saleName, 'Chưa phân nhóm');
  assert.equal(le.name, 'Khách lẻ');
  assert.equal(le.growth, null);
  const old = r.rows.find(x => x.key === 'cũ');
  assert.equal(old.active, true, 'khach hoat dong do KiotViet: TB 4 thang = 0 van hoat dong');
  assert.deepEqual(r.monthLabels, ['T7/26', 'T8/26', 'T9/26', 'T10/26']);
  assert.equal('kpis' in r, false, 'the tong quan cu da bo');
});

test('level gia gop khach: lay ho so lon nhat da co level, khong co thi mac dinh vua', () => {
  const snap = snapshot();
  snap.directory.push({ branch: 'saigon', code: 'KH7', name: 'Chị A', saleName: 'Khang', priceLevel: 'Vừa' });
  snap.customers.push({ month: '2026-06-01', branch: 'saigon', customerCode: 'KH7', customerName: 'Chị A', netRevenue: 9999 });
  const rows = svc.buildCustomerReport(snap).rows;
  assert.equal(rows.find(x => x.key === 'chị a').priceLevel, 'Level 2', 'ho so SG lon nhat nhung mac dinh vua => lay level cua ho so HN');
  assert.equal(rows.find(x => x.key === 'cũ').priceLevel, 'Vừa', 'email trong => vua');
});

test('gop khach theo ten (HN + SG, khac hoa/thuong/khoang trang): cong chuoi thang, sale = sale co doanh so 4 thang lon hon', () => {
  const snap = snapshot();
  snap.directory.push({ branch: 'saigon', code: 'KH7', name: 'chị   A', saleName: 'Trinh', priceLevel: 'Level 9' });
  snap.customers.push(
    { month: '2026-10-01', branch: 'saigon', customerCode: 'KH7', customerName: 'chị   A', netRevenue: 50 },
    { month: '2026-06-01', branch: 'saigon', customerCode: 'KH7', customerName: 'chị   A', netRevenue: 9999 }); // ngoai cua so 4 thang
  const r = svc.buildCustomerReport(snap);
  const rows = r.rows.filter(x => x.key === 'chị a');
  assert.equal(rows.length, 1);
  const a = rows[0];
  assert.equal(a.current, 150);                        // 100 (HN) + 50 (SG)
  assert.equal(a.series['2026-09-01'], 500);
  assert.equal(a.name, 'chị   A', 'ten hien thi lay ho so co tong doanh so lon nhat (thang 6 cua SG)');
  assert.equal(a.saleName, 'Khang', 'Khang: 500+100 trong cua so, Trinh: chi 50');
  assert.equal(a.priceLevel, 'Level 9');
  assert.deepEqual(a.refs.map(x => `${x.branch}:${x.code}`).sort(), ['hanoi:KH1', 'saigon:KH7']);
  // Bang sale van tinh theo nhom goc cua tung ho so: Trinh co 50 thang nay, Khang van 100.
  const sales = svc.buildSaleReport(snap);
  assert.equal(sales.rows.find(x => x.saleName === 'Trinh').current, 50);
  assert.equal(sales.rows.find(x => x.saleName === 'Khang').current, 100);
});

test('gop khach: khach chi co doanh so cu thi sale la sale cua ho so co tong lon nhat', () => {
  const snap = snapshot();
  snap.directory.push({ branch: 'saigon', code: 'KH8', name: 'Cũ', saleName: 'Khang', priceLevel: '' });
  snap.customers.push({ month: '2026-03-01', branch: 'saigon', customerCode: 'KH8', customerName: 'Cũ', netRevenue: 100 });
  const old = svc.buildCustomerReport(snap).rows.find(x => x.key === 'cũ');
  assert.equal(old.saleName, 'Trinh', 'KH9 HN (Trinh) 999 > KH8 SG (Khang) 100');
  assert.equal(old.active, true);
});

test('bang sale: thang chot doc bang sale, thang hien tai gom tu khach theo nhom hien tai; SL khach = so khach da gop hoat dong', () => {
  const r = svc.buildSaleReport(snapshot());
  const khang = r.rows.find(x => x.saleName === 'Khang');
  assert.equal(khang.series['2026-09-01'], 500);
  assert.equal(khang.current, 100);
  assert.equal(khang.activeCustomers, 2); // Chị A + Anh B (TB4 = 300/4 > 0)
  const none = r.rows.find(x => x.saleName === 'Chưa phân nhóm');
  assert.equal(none.current, 60);
  assert.equal('kpis' in r, false);
});

test('bang sale: cot Team, sale khong co trong sale_teams vao "Chua co team", danh sach team de loc', () => {
  const r = svc.buildSaleReport(snapshot());
  assert.equal(r.rows.find(x => x.saleName === 'Khang').team, 'Team Khang');
  assert.equal(r.rows.find(x => x.saleName === 'Trinh').team, 'Team Trinh');
  assert.equal(r.rows.find(x => x.saleName === 'Chưa phân nhóm').team, 'Chưa có team');
  assert.deepEqual(r.teams, ['Chưa có team', 'Team Khang', 'Team Trinh']);
  const noTeams = snapshot();
  delete noTeams.teams;
  assert.equal(svc.buildSaleReport(noTeams).rows.find(x => x.saleName === 'Khang').team, 'Chưa có team');
});

test('ten sale khac hoa/thuong gop vao ten trong sale_teams (BICH TRAN -> Bich Tran)', () => {
  const snap = snapshot();
  snap.teams.push({ saleName: 'Bích Trân', teamName: 'Team Hồng Trinh' });
  snap.directory.push({ branch: 'hanoi', code: 'KH20', name: 'X', saleName: 'BÍCH TRÂN', priceLevel: '' },
    { branch: 'hanoi', code: 'KH21', name: 'Y', saleName: 'Bích Trân', priceLevel: '' });
  snap.customers.push({ month: '2026-10-01', branch: 'hanoi', customerCode: 'KH20', customerName: 'X', netRevenue: 10 },
    { month: '2026-10-01', branch: 'hanoi', customerCode: 'KH21', customerName: 'Y', netRevenue: 20 });
  snap.sales.push({ month: '2026-09-01', saleName: 'BÍCH TRÂN', netRevenue: 5 }, { month: '2026-09-01', saleName: 'Bích Trân', netRevenue: 7 });
  const rows = svc.buildSaleReport(snap).rows.filter(x => x.saleName.toLowerCase() === 'bích trân');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].saleName, 'Bích Trân');
  assert.equal(rows[0].current, 30);
  assert.equal(rows[0].series['2026-09-01'], 12);
  assert.equal(rows[0].team, 'Team Hồng Trinh');
  assert.equal(svc.buildCustomerReport(snap).rows.find(x => x.key === 'x').saleName, 'Bích Trân');
});

test('bang ma hang: tang truong theo tien', () => {
  const r = svc.buildProductReport(snapshot());
  const p = r.rows.find(x => x.code === 'SP1');
  assert.equal(p.normalized, 800);
  assert.equal(p.growth, 200);
});

test('overview: chi so tong quat toan cong ty (tang truong, TB 4 thang, tien thang nay, SL sale/khach/ma hoat dong)', () => {
  const o = svc.buildOverview(snapshot());
  const v = key => o.kpis.find(k => k.key === key).value;
  assert.deepEqual(o.kpis.map(k => k.key), ['growth', 'avg4', 'current', 'saleCount', 'activeCustomers', 'activeProducts']);
  assert.equal(v('current'), 160);                       // 100 Khang + 60 Chua phan nhom
  const sales = svc.buildSaleReport(snapshot()).rows;
  assert.equal(v('avg4'), sales.reduce((s, r) => s + r.avg4, 0));
  const prev = sales.reduce((s, r) => s + r.prev, 0);
  const normalized = sales.reduce((s, r) => s + r.normalized, 0);
  assert.equal(v('growth'), normalized / prev * 100);
  assert.equal(v('saleCount'), 1, 'chi Khang hoat dong; Trinh chi co doanh so cu, Chua phan nhom khong tinh');
  assert.equal(v('activeCustomers'), 4);                 // moi khach con trong snapshot (Chi A, Anh B, Khach le, Cu): theo KiotViet, khong theo doanh so
  assert.equal(v('activeProducts'), 1);                  // SP1
  assert.equal(o.kpis.find(k => k.key === 'current').type, 'money');
  assert.equal(o.kpis.find(k => k.key === 'growth').type, 'percent');
});

test('chi tiet sale: tong quan + chuoi thang + danh sach khach cua sale', () => {
  const d = svc.buildDetail('sale', 'Khang', snapshot(), {});
  assert.equal(d.title, 'Khang');
  assert.deepEqual(d.chart.map(c => c.label), ['T7/26', 'T8/26', 'T9/26', 'T10/26']);
  assert.equal(d.customers.length, 2);
  assert.ok(d.summary.find(s => s.key === 'avg4'));
});

test('chi tiet: bieu do chi giu 6 thang gan nhat, tong van cong du cac thang', () => {
  const snap = snapshot();
  snap.months = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', ...snap.months];
  const d = svc.buildDetail('sale', 'Khang', snap, {});
  assert.deepEqual(d.chart.map(c => c.label), ['T5/26', 'T6/26', 'T7/26', 'T8/26', 'T9/26', 'T10/26']);
  assert.equal(d.chart[d.chart.length - 1].partial, true);
});

test('chi tiet khach theo khoa ten: tra refs de route nap top ma hang', () => {
  const d = svc.buildDetail('customer', 'chị a', snapshot(), {});
  assert.equal(d.title, 'Chị A');
  assert.equal(d.subtitle, 'Sale Khang');
  assert.deepEqual(d.customer.refs, [{ branch: 'hanoi', code: 'KH1' }]);
});

test('khong co key thi buildDetail nem loi 404', () => {
  assert.throws(() => svc.buildDetail('sale', 'Khong ton tai', snapshot(), {}), e => e.statusCode === 404);
});
