'use strict';

// Ham thuan cua Bao cao kinh doanh: khoa thang (ngay 1, lich VN), quy doi thang dang
// chay ve 30 ngay, tang truong, TB 4 thang. Spec: docs/superpowers/specs/2026-10-07-business-report-design.md.

const { vnDateKey } = require('../kiotvietSync/vnTime');

const FIRST_MONTH = '2026-03-01';
const UNGROUPED_SALE = 'Chưa phân nhóm';
const NO_TEAM = 'Chưa có team';
const RETAIL_NAME = 'Khách lẻ';
// Legacy aggregation default used only when preserving the displayed level at cutover.
// Live routes overlay the stored local level; new customer keys default to large there.
const DEFAULT_PRICE_LEVEL = 'vừa';
const PRICE_LEVEL_LABELS = { vip: 'vip', large: 'lớn', medium: DEFAULT_PRICE_LEVEL };

// Khoa so khop ten (khach, sale): NFKC, bo ky tu rong (zero-width), gop khoang trang, chu thuong.
// CUNG cong thuc voi ham SQL tks_name_key() (migration 0069) / normalizedNameSql(): JS truoc day khong bo
// zero-width nen ten co U+200B lech giua duong JS va duong SQL.
function nameKey(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function monthKey(dateKey) {
  return String(dateKey).slice(0, 7) + '-01';
}

function addMonths(month, n) {
  const [y, mo] = month.split('-').map(Number);
  const index = y * 12 + (mo - 1) + n;
  const year = Math.floor(index / 12);
  const mon = (index % 12) + 1;
  return `${year}-${String(mon).padStart(2, '0')}-01`;
}

function monthsBetween(fromMonth, toMonth) {
  const out = [];
  for (let m = fromMonth; m <= toMonth; m = addMonths(m, 1)) out.push(m);
  return out;
}

function monthLabel(month) {
  const [y, mo] = month.split('-');
  return `T${Number(mo)}/${y.slice(2)}`;
}

function vnToday(now = new Date()) {
  return vnDateKey(now);
}

function badMonth(message) {
  const e = new Error(message);
  e.statusCode = 400;
  return e;
}

// Thang duoc phep chot lai (nut "Tinh lai thang" va chay tay job): 'YYYY-MM', tu FIRST_MONTH,
// da ket thuc theo lich VN. Tra 'YYYY-MM-01'; sai thi nem Error statusCode 400. Chot thang
// dang chay se ghi state => job ngay mung 1 coi thang do da chot => chot thieu du lieu.
function parseClosedMonth(monthParam, now = new Date()) {
  if (typeof monthParam !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(monthParam)) {
    throw badMonth('Tháng không hợp lệ (định dạng YYYY-MM).');
  }
  const month = `${monthParam}-01`;
  if (month < FIRST_MONTH || month >= monthKey(vnToday(now))) {
    throw badMonth('Chỉ tính lại được tháng đã qua, từ T3/2026.');
  }
  return month;
}

function dayOfMonth(dateKey) {
  return Number(String(dateKey).slice(8, 10));
}

// Thang dang chay: doanh so x 30 / so ngay da qua (gom ca hom nay).
function normalizeTo30Days(amount, day) {
  return (Number(amount) || 0) * 30 / Math.max(1, day);
}

function growthPct(normalized, prev) {
  const p = Number(prev) || 0;
  if (p <= 0) return null;
  return (Number(normalized) || 0) / p * 100;
}

function daysInMonth(month) {
  const [y, mo] = month.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// TB 4 thang = (3 thang truoc + thang nay den hom nay) / tong so ngay cua 4 thang do (den hom nay),
// nhan 30 de ra so tuong duong 1 thang.
function avg4Months(prev3, current, prevDays, day) {
  const total = [0, 1, 2].reduce((s, i) => s + (Number(prev3[i]) || 0), 0) + (Number(current) || 0);
  const days = (Number(prevDays) || 0) + Math.max(1, day);
  return total / days * 30;
}

function buildMetrics(series, currentMonth, day) {
  const current = Number(series[currentMonth]) || 0;
  const normalized = normalizeTo30Days(current, day);
  const prevMonths = [1, 2, 3].map(i => addMonths(currentMonth, -i));
  const prev3 = prevMonths.map(m => Number(series[m]) || 0);
  const prevDays = prevMonths.reduce((s, m) => s + daysInMonth(m), 0);
  return { current, normalized, prev: prev3[0], growth: growthPct(normalized, prev3[0]), avg4: avg4Months(prev3, current, prevDays, day) };
}

module.exports = {
  FIRST_MONTH, UNGROUPED_SALE, NO_TEAM, RETAIL_NAME, DEFAULT_PRICE_LEVEL, PRICE_LEVEL_LABELS, nameKey, monthKey, addMonths, monthsBetween, monthLabel,
  vnToday, parseClosedMonth, dayOfMonth, normalizeTo30Days, growthPct, avg4Months, buildMetrics
};
