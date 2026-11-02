'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rules = require('./debtScheduleRules');

test('parseScheduleDays: chi nhan so nguyen 1..30', () => {
  assert.equal(rules.parseScheduleDays('3'), 3);
  assert.equal(rules.parseScheduleDays(7), 7);
  assert.equal(rules.parseScheduleDays(' 10 '), 10);
  for (const bad of ['', null, undefined, 'Hàng tuần', 'Khác', 'https://facebook.com/x', '0', '31', '90', '91', '2.5', '-1']) {
    assert.equal(rules.parseScheduleDays(bad), null, String(bad));
  }
});

test('khach chua co lich TT (hoac lich sai) tinh nhu 1 ngay', () => {
  assert.equal(rules.effectiveScheduleDays(null), 1);
  assert.equal(rules.effectiveScheduleDays('Hàng tuần'), 1);
  assert.equal(rules.effectiveScheduleDays(4), 4);
});

test('cua so lich TT dung vi du quy dinh: 15h thu 6 8/8', () => {
  assert.equal(rules.scheduleWindowStart('2026-08-08', 1), '2026-08-08');
  assert.equal(rules.scheduleWindowStart('2026-08-08', 3), '2026-08-06');
  assert.equal(rules.scheduleWindowStart('2026-08-08', 7), '2026-08-02');
  assert.equal(rules.scheduleWindowStart('2026-03-01', 2), '2026-02-28', 'qua ranh gioi thang');
});

test('no qua han = no hien tai - hoa don trong lich (khong tinh tra hang), khong am', () => {
  const daily = [
    { day: '2026-08-05', invoiceAmount: 100, returnAmount: 0 },
    { day: '2026-08-07', invoiceAmount: 300, returnAmount: 50 },
    { day: '2026-08-08', invoiceAmount: 200, returnAmount: 0 }
  ];
  assert.equal(rules.inScheduleDebt(daily, '2026-08-08', 1), 200);
  assert.equal(rules.inScheduleDebt(daily, '2026-08-08', 3), 500);
  assert.equal(rules.inScheduleDebt(daily, '2026-08-08', 7), 600);
  assert.equal(rules.inScheduleDebt([{ day: '2026-08-08', invoiceAmount: 0, returnAmount: 90 }], '2026-08-08', 1), 0, 'chi co tra hang -> 0: tra hang khong tinh');
  assert.equal(rules.overdueDebt(800000000, 200000000), 600000000, 'vi du cua nguoi dung');
  assert.equal(rules.overdueDebt(100, 500), 0);
});

test('buildCustomerRow: canh bao chi "Qua han" khi qua han > 0, khong con nguong 400k; co so ghi HN/SG', () => {
  const base = {
    branch: 'saigon', customerId: '9', customerCode: 'KH9', customerName: 'Khách 9', sale: 'Mai',
    scheduleDays: 1, currentDebt: 1000, openingDebt: 500, avgRevenue4m: 4000, feedback: {}
  };
  const daily = [{ day: '2026-10-12', invoiceAmount: 1000, returnAmount: 0 }];
  const row = rules.buildCustomerRow(base, { cycleDate: '2026-10-13', dailyAmounts: daily });
  assert.equal(row.branch, 'SG');
  assert.equal(row.customerKey, 'saigon:9');
  assert.equal(row.overdueDebt, 1000);
  assert.deepEqual(row.alertCodes, ['overdue'], 'qua han 1.000d van canh bao');
  assert.equal(row.overdueToSalesRatio, 0.25);
  assert.equal(row.needsAction, true);

  const handled = rules.buildCustomerRow({ ...base, feedback: { status: 'Đã xử lý' } }, { cycleDate: '2026-10-13', dailyAmounts: daily });
  assert.equal(handled.needsAction, false);

  const inSchedule = rules.buildCustomerRow({ ...base, scheduleDays: 2 }, { cycleDate: '2026-10-13', dailyAmounts: daily });
  assert.deepEqual(inSchedule.alertCodes, []);
  assert.equal(inSchedule.overdueDebt, 0);

  const noSales = rules.buildCustomerRow({ ...base, avgRevenue4m: null }, { cycleDate: '2026-10-13', dailyAmounts: daily });
  assert.equal(noSales.overdueToSalesRatio, null);
});

test('buildDebtReport: chua co ban chot -> unavailable kem canh bao; co ban chot -> KPI + nhom theo lich TT', () => {
  const empty = rules.buildDebtReport({ cycle: null, customers: [] });
  assert.equal(empty.available, false);
  assert.match(empty.dataWarnings[0], /Chưa có bản chốt/);

  const customers = [
    { scheduleDays: 3, paymentSchedule: '3', sale: 'A', currentDebt: 100, overdueDebt: 40, averageSales: 200, needsAction: true },
    { scheduleDays: 1, paymentSchedule: '1', sale: 'B', currentDebt: 50, overdueDebt: 0, averageSales: 0, needsAction: false }
  ];
  const report = rules.buildDebtReport({ cycle: { cycleDate: '2026-10-13', takenAt: 'x' }, customers });
  assert.equal(report.available, true);
  assert.equal(report.sourceSheet, 'Chốt lúc 15:00 13/10');
  assert.equal(report.kpi.totalCurrentDebt, 150);
  assert.equal(report.kpi.totalOverdueDebt, 40);
  assert.equal(report.kpi.actionCustomerCount, 1);
  assert.equal(report.kpi.overdueToSalesRatio, 0.2);
  assert.deepEqual(report.byPaymentSchedule.map(item => item.paymentSchedule), ['1', '3']);
});

test('suggestedPenalty: no le 25k, no cham theo bac phien, het qua han = 0', () => {
  assert.equal(rules.suggestedPenalty(0, 3), 0);
  assert.equal(rules.suggestedPenalty(399999, 5), 25000);
  const tiers = [1, 2, 3, 4, 5, 6, 9].map(streak => rules.suggestedPenalty(400000, streak));
  assert.deepEqual(tiers, [25000, 25000, 50000, 100000, 150000, 200000, 200000]);
});

test('nextOverdueStreak: +1 khi >= 400k, reset 0 khi duoi, Da xu ly reset chuoi (chu ky ke tiep la phien 1)', () => {
  assert.equal(rules.nextOverdueStreak(400000, 0, undefined), 1);
  assert.equal(rules.nextOverdueStreak(500000, 2, 'Chưa xử lý'), 3);
  assert.equal(rules.nextOverdueStreak(500000, 2, 'Bỏ qua'), 3);
  assert.equal(rules.nextOverdueStreak(500000, 2, 'Đã xử lý'), 1);
  assert.equal(rules.nextOverdueStreak(500000, 0, 'Đã xử lý'), 1);
  assert.equal(rules.nextOverdueStreak(399999, 2, 'Đã xử lý'), 0);
  assert.equal(rules.nextOverdueStreak(399999, 4, 'Bỏ qua'), 0);
});

test('buildCustomerRow: "Đã xử lý" => phạt 0, phiên 0, nợ quá hạn vẫn hiện; "Bỏ qua" vẫn phạt; không còn phạt tay', () => {
  const base = { branch: 'hanoi', customerId: 1, currentDebt: 900000, overdueStreak: 2, scheduleDays: 7 };
  const open = rules.buildCustomerRow(base, { cycleDate: '2026-10-13', dailyAmounts: [] });
  assert.ok(open.penaltyAmount > 0);
  assert.equal(open.overdueStreak, 2);
  const done = rules.buildCustomerRow({ ...base, feedback: { status: 'Đã xử lý' } }, { cycleDate: '2026-10-13', dailyAmounts: [] });
  assert.equal(done.penaltyAmount, 0);
  assert.equal(done.suggestedPenalty, 0);
  assert.equal(done.overdueStreak, 0);
  assert.equal(done.overdueDebt, 900000, 'so no qua han van hien');
  // Du lieu cu con penaltyOverride cung bi bo qua: tien phat chi theo quy che.
  const ignored = rules.buildCustomerRow({ ...base, penaltyOverride: 40000, penaltyBy: 'QL' }, { cycleDate: '2026-10-13', dailyAmounts: [] });
  assert.equal(ignored.penaltyAmount, open.penaltyAmount);
  assert.equal('penaltyIsManual' in ignored, false);
  assert.equal('canEditPenalty' in ignored, false);
  const skipped = rules.buildCustomerRow({ ...base, feedback: { status: 'Bỏ qua' } }, { cycleDate: '2026-10-13', dailyAmounts: [] });
  assert.equal(skipped.penaltyAmount, open.penaltyAmount);
  assert.equal(skipped.overdueStreak, 2);
});

test('previousPenaltyAmount: Da xu ly = 0 > goi y theo phien truoc; khong co dong phien truoc -> null', () => {
  const base = { branch: 'hanoi', customerId: 1, currentDebt: 0, scheduleDays: 7 };
  const build = previousCycle => rules.buildCustomerRow({ ...base, previousCycle }, { cycleDate: '2026-08-12', dailyAmounts: [] });
  assert.equal(build(null).previousPenaltyAmount, null);
  assert.equal(build({ overdueDebt: 100000, overdueStreak: 0, status: 'Chưa xử lý' }).previousPenaltyAmount, 25000);
  assert.equal(build({ overdueDebt: 900000, overdueStreak: 2, status: 'Đã xử lý' }).previousPenaltyAmount, 0);
  assert.equal(build({ overdueDebt: 900000, overdueStreak: 3, status: 'Chưa xử lý' }).previousPenaltyAmount, 50000);
});

test('anchorDate (tinh lai sang hom sau): cua so truot theo ngay tinh lai, van dung N ngay', () => {
  const daily = [
    { day: '2026-08-07', invoiceAmount: 100, returnAmount: 0 },
    { day: '2026-08-08', invoiceAmount: 200, returnAmount: 0 },
    { day: '2026-08-09', invoiceAmount: 300, returnAmount: 0 }
  ];
  assert.equal(rules.inScheduleDebt(daily, '2026-08-08', 1, '2026-08-09'), 300);
  assert.equal(rules.inScheduleDebt(daily, '2026-08-08', 2, '2026-08-09'), 500);
  assert.equal(rules.inScheduleDebt(daily.slice(0, 2), '2026-08-08', 2, '2026-08-08'), 300);
});
