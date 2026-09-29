'use strict';

const { addDaysToDateKey } = require('./dateHelpers');
const { reconstructDailyStock } = require('./timelineBuilder');
const { findStockoutPeriods, summarizeStockoutPeriods, daysBetweenInclusive } = require('./stockoutAnalyzer');

const DEFAULT_MIN_CONSECUTIVE_DAYS = 5;

// Moc ngay som nhat toan bo tinh nang Dut hang duoc phep xet, bat ke daysBack
// yeu cau bao xa. Sheet Tra NCC khong co API va duoc nhap tay, nen khong dam
// bao du lieu tin cay truoc moc nay — de mac dinh (khong truyen
// dataFromDateFloor) se tu dong lam tron nguoc thanh gia tri fake-zero keo
// dai sai. Se tu het tac dung khi hom nay - daysBack da muon hon moc nay.
const STOCKOUT_DATA_FLOOR_DATE_KEY = '2026-06-01';

// Tra ve { reportFromDate, calculationFromDate } sau khi da ap dung dem 4 ngay
// (minConsecutiveDays - 1) va moc san (dataFromDateFloor, neu co). Dung chung
// giua noi tai analyzeStockoutTimeline va noi goi ben ngoai (vd de gioi han
// cua so truy van loadStockoutEvents cho dong bo voi phan tich).
function computeStockoutWindow({ todayKey, daysBack, minConsecutiveDays = DEFAULT_MIN_CONSECUTIVE_DAYS, dataFromDateFloor = null }) {
  let reportFromDate = addDaysToDateKey(todayKey, -daysBack);
  if (dataFromDateFloor && reportFromDate < dataFromDateFloor) reportFromDate = dataFromDateFloor;
  const warmupDays = Math.max(0, minConsecutiveDays - 1);
  let calculationFromDate = addDaysToDateKey(reportFromDate, -warmupDays);
  if (dataFromDateFloor && calculationFromDate < dataFromDateFloor) calculationFromDate = dataFromDateFloor;
  return { reportFromDate, calculationFromDate };
}

// dateKey lon hon giua 2 moc, coi null/rong la "khong gioi han" (thua ben
// con lai). Dung de ghim rieng tung ma theo ngay tao (createdDateKey) ben
// canh moc san chung ca he thong (dataFromDateFloor).
function maxDateKey(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

// Neu ngay co giao dich gan nhat cua 1 ma CHI CO Nhap hang, tuyet doi khong
// co giao dich nao khac, currentOnHand=0 lay tu KiotViet /products gan nhu
// chac chan chua kip cap nhat (do lech thoi gian giua luc phieu Nhap hang
// hoan tat va luc API san pham phan anh ton kho moi — xem thuc te OTD10N,
// tren 24h van chua cap nhat). Chi xet "hoan toan khong co giao dich nao
// khac" (khong xet net theo so luong) vi so luong Tra NCC nhap tay co the sai
// lech (typo/dinh dang) ma van la 1 no luc that su can doi — khong nen coi la
// du lieu loi thoi.
function hasUnreliableZeroOnHand(events) {
  if (!Array.isArray(events) || events.length === 0) return false;
  let maxDate = null;
  for (const e of events) {
    if (maxDate === null || e.dateKey > maxDate) maxDate = e.dateKey;
  }
  const eventsOnMaxDate = events.filter((e) => e.dateKey === maxDate);
  const hasPurchase = eventsOnMaxDate.some((e) => e.source === 'purchases');
  const hasOtherSource = eventsOnMaxDate.some((e) => e.source !== 'purchases');
  return hasPurchase && !hasOtherSource;
}

// Khi hasUnreliableZeroOnHand: ton hien tai (0) chua kip cap nhat sau phieu Nhap
// hang moi nhat, nen uoc luong ton that = tong so luong nhap cua ngay do (khong
// co giao dich nao khac cung ngay de tru). Dung de van dung lai timeline thay vi
// bo qua ca ma — bo qua se lam mat dot dut hang that ngay truoc phieu nhap (vd.
// MCRY301 Sai Gon: het hang 11/09->28/09, nhap 2.250 sang 29/09 nhung ton chua cap nhat).
// Tra null (=> van bo qua ma) khi ma CHI co Nhap hang, khong co giao dich nao khac:
// khong co bang chung ma nay tung ban/ton, ton 0 truoc do la gia (xem scan tests).
function estimateOnHandFromLatestPurchase(events) {
  if (!events.some((e) => e.source !== 'purchases')) return null;
  let maxDate = null;
  for (const e of events) if (maxDate === null || e.dateKey > maxDate) maxDate = e.dateKey;
  return events
    .filter((e) => e.dateKey === maxDate && e.source === 'purchases')
    .reduce((sum, e) => sum + e.delta, 0);
}

// Ty le ma co ngay "khong dang tin" (ton tinh nguoc bi am) o muc binh thuong la
// ~4-15% (kiem ke/dieu chinh ton khong co trong nguon). Vuot xa muc do gan nhu
// chac chan do du lieu Tra NCC sai (nham co so, thieu lich su) — su co 29/09/2026:
// 2 file Excel nhap nham co so day ty le nay len 56% ma khong co canh bao nao.
const UNRELIABLE_WARNING_MIN_ANALYZED = 20;
const UNRELIABLE_WARNING_RATIO = 0.25;

function buildUnreliableDataWarning({ analyzed, unreliable }) {
  if (!(analyzed >= UNRELIABLE_WARNING_MIN_ANALYZED)) return null;
  if (unreliable / analyzed <= UNRELIABLE_WARNING_RATIO) return null;
  const percent = Math.round((unreliable / analyzed) * 100);
  return `${unreliable.toLocaleString('vi-VN')}/${analyzed.toLocaleString('vi-VN')} mã (${percent}%) có ngày tồn kho tính ngược bị âm nên bị loại khỏi kết quả. ` +
    'Dữ liệu Trả NCC nhiều khả năng sai cơ sở hoặc thiếu lịch sử — hãy kiểm tra lại file Excel đã nhập rồi quét lại.';
}

function analyzeStockoutTimeline(options) {
  const {
    currentOnHand,
    events = [],
    todayKey,
    daysBack,
    minConsecutiveDays = DEFAULT_MIN_CONSECUTIVE_DAYS,
    dataFromDateFloor = null
  } = options;
  const { reportFromDate, calculationFromDate } = computeStockoutWindow({
    todayKey, daysBack, minConsecutiveDays, dataFromDateFloor
  });
  const calculationDaysBack = daysBetweenInclusive(calculationFromDate, todayKey) - 1;
  const dailyStock = reconstructDailyStock(currentOnHand, events, todayKey, calculationDaysBack);
  const periods = findStockoutPeriods(
    dailyStock,
    minConsecutiveDays,
    reportFromDate,
    todayKey
  );
  // Co it nhat 1 ngay trong ky bao cao bi loai vi thieu du lieu (xem
  // timelineBuilder.js) — bao hieu cho tang tren de canh bao nguoi dung, du
  // cac dot con lai van hop le.
  const hasUnreliableData = dailyStock.some(
    (d) => d.unreliable && d.date >= reportFromDate && d.date <= todayKey
  );

  return {
    reportFromDate,
    calculationFromDate,
    dailyStock,
    periods,
    summary: summarizeStockoutPeriods(periods),
    hasUnreliableData
  };
}

module.exports = {
  DEFAULT_MIN_CONSECUTIVE_DAYS,
  STOCKOUT_DATA_FLOOR_DATE_KEY,
  computeStockoutWindow,
  maxDateKey,
  hasUnreliableZeroOnHand,
  estimateOnHandFromLatestPurchase,
  buildUnreliableDataWarning,
  analyzeStockoutTimeline
};
