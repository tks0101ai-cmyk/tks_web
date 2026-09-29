'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  analyzeStockoutTimeline, computeStockoutWindow, maxDateKey, hasUnreliableZeroOnHand,
  estimateOnHandFromLatestPurchase, buildUnreliableDataWarning
} = require('./stockoutEngine');
const { daysBetweenInclusive } = require('./stockoutAnalyzer');

test('analyzeStockoutTimeline dùng 4 ngày đệm để xác nhận đợt vắt qua biên nhưng chỉ cộng ngày trong kỳ', () => {
  const result = analyzeStockoutTimeline({
    currentOnHand: 0,
    events: [],
    todayKey: '2026-01-10',
    daysBack: 5,
    minConsecutiveDays: 5
  });

  assert.deepEqual(result.periods, [{ fromDate: '2026-01-05', toDate: '2026-01-10', days: 6 }]);
  assert.deepEqual(result.summary, { stockoutCount: 1, totalStockoutDays: 6 });
  assert.equal(result.reportFromDate, '2026-01-05');
  assert.equal(result.calculationFromDate, '2026-01-01');
});

test('analyzeStockoutTimeline giữ tồn hiện tại khi mã không có ở bất kỳ bảng giao dịch nào', () => {
  const result = analyzeStockoutTimeline({
    currentOnHand: 3,
    events: [],
    todayKey: '2026-01-10',
    daysBack: 5,
    minConsecutiveDays: 5
  });

  assert.deepEqual(result.periods, []);
  assert.deepEqual(result.summary, { stockoutCount: 0, totalStockoutDays: 0 });
});

test('computeStockoutWindow khong gioi han khi cua so yeu cau da nam sau moc san', () => {
  const window = computeStockoutWindow({
    todayKey: '2026-09-08',
    daysBack: 10,
    minConsecutiveDays: 5,
    dataFromDateFloor: '2026-06-01'
  });
  assert.equal(window.reportFromDate, '2026-08-29');
  assert.equal(window.calculationFromDate, '2026-08-25');
});

test('computeStockoutWindow ghim reportFromDate va calculationFromDate vao dataFromDateFloor khi daysBack vuot qua moc', () => {
  const window = computeStockoutWindow({
    todayKey: '2026-09-08',
    daysBack: 183,
    minConsecutiveDays: 5,
    dataFromDateFloor: '2026-06-01'
  });
  assert.equal(window.reportFromDate, '2026-06-01');
  assert.equal(window.calculationFromDate, '2026-06-01');
});

test('analyzeStockoutTimeline gioi han dot dut hang theo dataFromDateFloor khi daysBack keo dai hon moc san', () => {
  const result = analyzeStockoutTimeline({
    currentOnHand: 0,
    events: [],
    todayKey: '2026-09-08',
    daysBack: 183,
    minConsecutiveDays: 5,
    dataFromDateFloor: '2026-06-01'
  });

  assert.equal(result.reportFromDate, '2026-06-01');
  assert.equal(result.calculationFromDate, '2026-06-01');
  assert.deepEqual(result.periods, [{
    fromDate: '2026-06-01',
    toDate: '2026-09-08',
    days: daysBetweenInclusive('2026-06-01', '2026-09-08')
  }]);
});

test('analyzeStockoutTimeline tra ve hasUnreliableData=true khi co ngay trong ky bao cao bi loai vi ton tho am', () => {
  // Ton hien tai = 0, nhung co 1 su kien +50 (vd Tra hang) ma khong co bang
  // chung nao khac giai thich duoc — dung luoc tinh LUI se ra ton tho am cho
  // ngay truoc do, nam trong ky bao cao (daysBack=5).
  const result = analyzeStockoutTimeline({
    currentOnHand: 0,
    events: [{ dateKey: '2026-01-08', delta: 50 }],
    todayKey: '2026-01-10',
    daysBack: 5,
    minConsecutiveDays: 5
  });
  assert.equal(result.hasUnreliableData, true);
});

test('analyzeStockoutTimeline tra ve hasUnreliableData=false khi khong co ngay nao bi loai', () => {
  const result = analyzeStockoutTimeline({
    currentOnHand: 3,
    events: [],
    todayKey: '2026-01-10',
    daysBack: 5,
    minConsecutiveDays: 5
  });
  assert.equal(result.hasUnreliableData, false);
});

test('maxDateKey tra ve moc muon hon, coi null/rong la khong gioi han', () => {
  assert.equal(maxDateKey('2026-06-01', '2026-08-04'), '2026-08-04');
  assert.equal(maxDateKey('2026-08-04', '2026-06-01'), '2026-08-04');
  assert.equal(maxDateKey(null, '2026-08-04'), '2026-08-04');
  assert.equal(maxDateKey('2026-08-04', null), '2026-08-04');
  assert.equal(maxDateKey(null, null), null);
});

test('hasUnreliableZeroOnHand: true khi su kien gan nhat la Nhap hang chua bi tieu thu', () => {
  const events = [
    { dateKey: '2026-08-01', delta: -5, source: 'invoices' },
    { dateKey: '2026-09-05', delta: 400, source: 'purchases' }
  ];
  assert.equal(hasUnreliableZeroOnHand(events), true);
});

test('hasUnreliableZeroOnHand: false khi su kien gan nhat khong phai Nhap hang', () => {
  const events = [
    { dateKey: '2026-08-01', delta: 50, source: 'purchases' },
    { dateKey: '2026-09-05', delta: 3, source: 'customerReturns' }
  ];
  assert.equal(hasUnreliableZeroOnHand(events), false);
});

test('hasUnreliableZeroOnHand: false khi Nhap hang trong ngay gan nhat bi tieu het cung ngay (net <= 0)', () => {
  const events = [
    { dateKey: '2026-09-05', delta: 400, source: 'purchases' },
    { dateKey: '2026-09-05', delta: -400, source: 'invoices' }
  ];
  assert.equal(hasUnreliableZeroOnHand(events), false);
});

test('hasUnreliableZeroOnHand: false khi ngay gan nhat co Nhap hang VA nguon khac, du so luong khong can bang het (co the la typo Tra NCC)', () => {
  // Giong truong hop thuc te ASTST16: Nhap +1200 va Tra NCC -1.2 cung ngay
  // (nhieu kha nang loi nhap lieu so luong Tra NCC) — co bang chung mot no
  // luc can doi that su, khong nen coi la Sheet Hang hoa loi thoi.
  const events = [
    { dateKey: '2026-08-28', delta: 1200, source: 'purchases' },
    { dateKey: '2026-08-28', delta: -1.2, source: 'supplierReturns' }
  ];
  assert.equal(hasUnreliableZeroOnHand(events), false);
});

test('hasUnreliableZeroOnHand: false khi khong co su kien nao', () => {
  assert.equal(hasUnreliableZeroOnHand([]), false);
});

test('estimateOnHandFromLatestPurchase + analyze: MCRY301 Sai Gon giu dot het hang 11/09->28/09 du ton hien tai chua cap nhat', () => {
  // Ton hien tai trong DB = 0 (chua kip cap nhat) nhung phieu Nhap 2.250 da co
  // trong ngay 29/09: uoc luong ton = 2.250 thi ton cuoi 28/09 = 0 chu khong am.
  const events = [
    { dateKey: '2026-09-08', delta: -150, source: 'invoices' },
    { dateKey: '2026-09-11', delta: -100, source: 'invoices' },
    { dateKey: '2026-09-29', delta: 2250, source: 'purchases' }
  ];
  assert.equal(hasUnreliableZeroOnHand(events), true);
  const onHand = estimateOnHandFromLatestPurchase(events);
  assert.equal(onHand, 2250);
  const result = analyzeStockoutTimeline({
    currentOnHand: onHand, events, todayKey: '2026-09-29', daysBack: 89,
    minConsecutiveDays: 5, dataFromDateFloor: '2026-06-01'
  });
  assert.deepEqual(result.periods, [{ fromDate: '2026-09-11', toDate: '2026-09-28', days: 18 }]);
  assert.equal(result.hasUnreliableData, false);
});

test('estimateOnHandFromLatestPurchase: null khi ma chi co Nhap hang (khong co bang chung tung ban)', () => {
  assert.equal(estimateOnHandFromLatestPurchase([{ dateKey: '2026-09-05', delta: 400, source: 'purchases' }]), null);
});

test('buildUnreliableDataWarning: chi canh bao khi du mau va ty le vuot 25%', () => {
  assert.equal(buildUnreliableDataWarning({ analyzed: 10, unreliable: 10 }), null);
  assert.equal(buildUnreliableDataWarning({ analyzed: 3254, unreliable: 143 }), null);
  const warning = buildUnreliableDataWarning({ analyzed: 3254, unreliable: 1829 });
  assert.match(warning, /56%/);
  assert.match(warning, /Trả NCC/);
});

test('MCRY301 Hanoi stock card: replenishment on Sep 14 separates Sep 9-13 and Sep 19-28 outages', () => {
  const events = [
    ['2026-08-31',2250,'purchases'], ['2026-09-02',-1650,'invoices'],
    ['2026-09-03',-600,'invoices'], ['2026-09-05',300,'purchases'],
    ['2026-09-08',-150,'invoices'], ['2026-09-09',-150,'invoices'],
    ['2026-09-14',4500,'purchases'], ['2026-09-14',-1650,'invoices'],
    ['2026-09-15',-600,'invoices'], ['2026-09-19',-2250,'supplierReturns']
  ].map(([dateKey, delta, source]) => ({ dateKey, delta, source }));
  const result = analyzeStockoutTimeline({ currentOnHand: 0, events, todayKey: '2026-09-28', daysBack: 29 });
  assert.deepEqual(result.periods, [
    { fromDate: '2026-08-30', toDate: '2026-08-30', days: 1 },
    { fromDate: '2026-09-09', toDate: '2026-09-13', days: 5 },
    { fromDate: '2026-09-19', toDate: '2026-09-28', days: 10 }
  ]);
  // The Aug 15-30 outage is clipped to the 30-day window starting Aug 30.
  assert.equal(result.summary.totalStockoutDays, 16);
  assert.equal(result.dailyStock.find(d => d.date === '2026-09-14').stock, 2850);
  assert.equal(result.dailyStock.find(d => d.date === '2026-09-18').stock, 2250);
});
