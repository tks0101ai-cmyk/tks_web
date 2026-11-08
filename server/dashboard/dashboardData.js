// ==========================================
// DASHBOARD DATA — cung cap du lieu cho Web App (GET /api/dashboard)
//
// Nguon du lieu KiotViet (7 tab: Nhóm hàng/Hàng hóa/Hóa đơn/Chi tiết hóa
// đơn/Đặt hàng/Trả hàng/Khách hàng) doc tu Supabase
// Postgres qua dashboardPgReader.js — module do dung lai dung shape
// `[header, ...rows]` cua Sheets nen toan bo logic tinh toan ben duoi KHONG
// doi. Tap khach hang co giao dich 1/3/7 ngay doc tu Supabase qua
// customerDebtActivityRepository, khong con phu thuoc cac tab HN1/HN3/HN7.
// ==========================================
const CONFIG = require('../config');
const fuzzy = require('../shared/fuzzySearch');
const dashboardPgReader = require('./dashboardPgReader');
const customerDebtActivityRepository = require('./customerDebtActivityRepository');
const customerDirectoryRepository = require('./customerDirectoryRepository');
const customerInvoiceLinesRepository = require('./customerInvoiceLinesRepository');
const dashboardRollupRepository = require('./dashboardRollupRepository');
const { BRANCHES, BRANCH_BOTH, branchLabelToCode, resolveBranchScope } = require('../branch/branches');
// Tab Cong no (2026-10-13): ban chot 15:00 + lich TT luu Postgres (server/debtSchedule), khong
// con doc workbook Google Sheets / quy tac 1-3-7-Hang tuan.
const debtScheduleService = require('../debtSchedule/debtScheduleService');
const debtScheduleRepository = require('../debtSchedule/debtScheduleRepository');
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');
const { PERIODS_KEY, ALL_CORE_KEYS, ALL_ROLLUPS, resolveViewPlan, pickPayload, pickFilters } = require('./dashboardViews');
// Tang moi lan rollup refresh xong — nam trong khoa dashboardResultCache de
// ket qua tinh tu rollup cu tu het hieu luc ngay khi co rollup moi.
let rollupVersion = 0;
// true khi luot sync da ghi >=1 hoa don (syncDriver phat 'invoicesChanged' sau
// COMMIT) ma cache Hoa don chua duoc het han. Timer rollup 5 phut khong co hoa don
// moi -> KHONG doc lai bang Hoa don (~29 MB/lan ca 2 co so).
let invoicesChangedSinceExpiry = false;
dashboardRollupEvents.on('invoicesChanged', () => { invoicesChangedSinceExpiry = true; });
dashboardRollupEvents.on('customersChanged', () => { expireCustomerDirectoryCaches(); });
dashboardRollupEvents.on('updated', () => {
  rollupVersion += 1;
  if (invoicesChangedSinceExpiry) {
    invoicesChangedSinceExpiry = false;
    expireRollupBoundSheetCaches();
  }
});

const DASHBOARD_SHEETS_CACHE_TTL_MS = 90 * 1000;
// Hoa don / Chi tiet hoa don (bang nang nhat: HN ~30K dong ~19 MB) chi doi khi
// luot sync KiotViet ghi vao Postgres — va moi luot sync fast deu chay rollup
// roi phat dashboardRollupEvents 'updated'. Vi vay 2 bang nay KHONG het han theo
// 90s nua ma het han o rollup 'updated' DAU TIEN sau khi sync thuc su ghi hoa don
// ('invoicesChanged', xem expireRollupBoundSheetCaches);
// TTL duoi day chi la luoi an toan neu su kien khong den (rollup loi/tat sync).
// Giam egress Supabase ~4-5 lan cho 2 bang nay (90s -> ~7 phut nhip sync).
const ROLLUP_BOUND_SHEETS_FALLBACK_TTL_MS = 15 * 60 * 1000;
const ROLLUP_BOUND_SHEET_NAMES = new Set([CONFIG.SHEET_INVOICES, CONFIG.SHEET_INVOICE_DETAILS]);

// Danh dau qua han (KHONG xoa du lieu) -> request ke tiep van tra du lieu cu ngay
// va lam moi nen (stale-while-revalidate), giong het luc het TTL 90s truoc day.
// Tang moi lan het han cache Hoa don. Lan doc dang chay tu TRUOC khi het han co the
// mang dong hoa don cu (truoc COMMIT) -> luu ket qua do o trang thai da qua han.
let invoiceCacheGeneration = 0;

function rollupBoundExpiresAt(key, fetchedAt, generationAtStart) {
  if (!ROLLUP_BOUND_SHEET_NAMES.has(key)) return fetchedAt + DASHBOARD_SHEETS_CACHE_TTL_MS;
  return generationAtStart === invoiceCacheGeneration ? fetchedAt + ROLLUP_BOUND_SHEETS_FALLBACK_TTL_MS : fetchedAt;
}

function expireRollupBoundSheetCaches(now = Date.now()) {
  invoiceCacheGeneration += 1;
  dashboardCoreSheetsCacheByBranch.forEach(entries => {
    entries.forEach((entry, key) => {
      if (ROLLUP_BOUND_SHEET_NAMES.has(key) && entry.expiresAt > now) entry.expiresAt = now;
    });
  });
  dashboardSheetsCacheByBranch.forEach(cache => {
    if (cache.expiresAt > now) cache.expiresAt = now;
  });
}
const PRODUCT_REVENUE_SEARCH_LIVE_LIMIT = 200; // gioi han so dong render khi go tim truc tiep (khong ap dung cho xuat Excel)
const DASHBOARD_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const DASHBOARD_UTC_OFFSET = '+07:00';
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 3660; // ~10 nam — chan vong lap tao bucket ngay bi vo tan/qua lon
const TOP_REPORT_TRANSACTIONS = 15;
const CUSTOMER_PRODUCT_REVENUE_WINDOW_DAYS = 90;
const CUSTOMER_PRODUCT_REVENUE_MONTH_DAYS = 30;

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  timeZone: DASHBOARD_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
});

// Ban dung Intl (chuan vang) — chi con dung ngoai khoang an toan cua ban nhanh va
// lam mau doi chieu trong test (xem __test__.dateParts).
function getDashboardDatePartsIntl(date) {
  return Object.fromEntries(
    DATE_TIME_FORMATTER.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value])
  );
}

// Viet Nam khong co gio mua he: UTC+7 co dinh tu 13/06/1975 nen voi thoi diem
// trong [1976, 2100) chi can cong 7 gio roi doc cac truong UTC — cho ket qua
// GIONG HET Intl (day/month/hour... deu 2 chu so) nhung nhanh hon nhieu lan.
// formatToParts dung ~300ms/lan tinh khi doi bo loc (dat >15% CPU cua /api/dashboard
// do 3-4 lan goi/hoa don trong parseSheetDate + dmyKey qua ~40K hoa don/dat hang).
const VN_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const FAST_DATE_PARTS_MIN_MS = Date.UTC(1976, 0, 1);
const FAST_DATE_PARTS_MAX_MS = Date.UTC(2100, 0, 1);
const pad2 = value => (value < 10 ? '0' + value : String(value));

function getDashboardDateParts(date) {
  const time = date.getTime();
  if (!(time >= FAST_DATE_PARTS_MIN_MS && time < FAST_DATE_PARTS_MAX_MS)) return getDashboardDatePartsIntl(date);
  const wall = new Date(time + VN_UTC_OFFSET_MS);
  return {
    day: pad2(wall.getUTCDate()),
    month: pad2(wall.getUTCMonth() + 1),
    year: String(wall.getUTCFullYear()),
    hour: pad2(wall.getUTCHours()),
    minute: pad2(wall.getUTCMinutes()),
    second: pad2(wall.getUTCSeconds())
  };
}

function formatDMY(date) {
  const { day, month, year } = getDashboardDateParts(date);
  return `${day}/${month}/${year}`;
}

function formatDMYHMS(date) {
  const { day, month, year, hour, minute, second } = getDashboardDateParts(date);
  return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
}

function formatHM(date) {
  const { hour, minute } = getDashboardDateParts(date);
  return `${hour}:${minute}`;
}

function formatDMYHM(date) {
  const { day, month, hour, minute } = getDashboardDateParts(date);
  return `${day}/${month} ${hour}:${minute}`;
}

function parseDashboardWallTime(yyyy, MM, dd, hh = '0', mi = '0', ss = '0') {
  const pad = value => String(value).padStart(2, '0');
  const expected = `${pad(dd)}/${pad(MM)}/${yyyy} ${pad(hh)}:${pad(mi)}:${pad(ss)}`;
  const iso = `${yyyy}-${pad(MM)}-${pad(dd)}T${pad(hh)}:${pad(mi)}:${pad(ss)}${DASHBOARD_UTC_OFFSET}`;
  const date = new Date(iso);
  return !isNaN(date.getTime()) && formatDMYHMS(date) === expected ? date : null;
}

/**
 * Parse gia tri ngay do Sheets API tra ve (thuong la chuoi da format theo
 * number-format cua o, dang "dd/MM/yyyy HH:mm:ss"). Khong bao gio throw —
 * tra null neu khong doc duoc, de goi noi bo qua thay vi lam vo ca dashboard.
 */
function parseSheetDate(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw instanceof Date) return isNaN(raw.getTime()) ? null : raw;

  if (typeof raw === 'number') {
    const wallTime = new Date(Math.round((raw - 25569) * DAY_MS));
    if (isNaN(wallTime.getTime())) return null;
    return parseDashboardWallTime(
      wallTime.getUTCFullYear(),
      wallTime.getUTCMonth() + 1,
      wallTime.getUTCDate(),
      wallTime.getUTCHours(),
      wallTime.getUTCMinutes(),
      wallTime.getUTCSeconds()
    );
  }

  const str = String(raw).trim();
  if (!str) return null;

  const m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    const [, dd, MM, yyyy, hh = '0', mi = '0', ss = '0'] = m;
    if (Number(yyyy) > 1990) return parseDashboardWallTime(yyyy, MM, dd, hh, mi, ss);
  }

  // Chuoi ISO khong kem offset cung la gio Viet Nam tu Google Sheets (va cung
  // la dinh dang <input type="date"> gui len tu bo loc "Tuy chinh" o client).
  const isoLocal = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (isoLocal) {
    const [, yyyy, MM, dd, hh = '0', mi = '0', ss = '0'] = isoLocal;
    if (Number(yyyy) > 1990) return parseDashboardWallTime(yyyy, MM, dd, hh, mi, ss);
  }

  const d2 = new Date(str);
  const dashboardYear = !isNaN(d2.getTime()) ? Number(getDashboardDateParts(d2).year) : 0;
  if (dashboardYear > 1990 && dashboardYear < 2100) return d2;

  return null;
}

function dmyKey(date) {
  return formatDMY(date);
}

function startOfDay(date) {
  const { day, month, year } = getDashboardDateParts(date);
  return parseDashboardWallTime(year, month, day, 0, 0, 0);
}

function endOfDay(date) {
  const { day, month, year } = getDashboardDateParts(date);
  return parseDashboardWallTime(year, month, day, 23, 59, 59);
}

/**
 * Quy doi 1 bo loc thoi gian tu client ({mode, days, from, to}) thanh khoang
 * ngay cu the. mode: 'days' (N ngay gan nhat, ke ca hom nay) | 'range' (tuy
 * chinh tu ngay...den ngay...) | 'all' (khong gioi han — bo qua moi dieu kien
 * ngay thang). Khong bao gio throw: bo loc "range" thieu/sai dinh dang duoc
 * coi nhu "all" de dashboard khong bi trong thay vi bao loi.
 */
function resolveFilterRange(spec, now) {
  const raw = spec || {};
  const mode = raw.mode === 'range' || raw.mode === 'all' ? raw.mode : 'days';

  if (mode === 'all') {
    return { mode: 'all', start: null, end: null, label: 'Tất cả' };
  }

  if (mode === 'range') {
    const fromDate = raw.from ? parseSheetDate(raw.from) : null;
    const toDate = raw.to ? parseSheetDate(raw.to) : null;
    if (!fromDate || !toDate) {
      return { mode: 'all', start: null, end: null, label: 'Tất cả' };
    }
    let start = startOfDay(fromDate);
    let end = endOfDay(toDate);
    if (start.getTime() > end.getTime()) {
      start = startOfDay(toDate);
      end = endOfDay(fromDate);
    }
    if ((end.getTime() - start.getTime()) / DAY_MS > MAX_RANGE_DAYS) {
      end = endOfDay(new Date(start.getTime() + MAX_RANGE_DAYS * DAY_MS));
    }
    return { mode: 'range', start, end, label: `${formatDMY(start)} – ${formatDMY(end)}` };
  }

  const days = Math.min(Math.max(Number(raw.days) || 30, 1), MAX_RANGE_DAYS);
  const end = endOfDay(now);
  const start = startOfDay(new Date(now.getTime() - (days - 1) * DAY_MS));
  return { mode: 'days', days, start, end, label: `${days} ngày` };
}

// Tra ban sao bo loc (khong sua filters cua nguoi goi); idempotent. (2026-10-16: tab Hang hoa cu da go nen
// khong con bo loc rieng `products` / `newProducts` / `newlyImported` de gom ve bo loc cha.)
function withTableFilterFallbacks(filters) {
  return { ...(filters || {}) };
}

function isWithinRange(date, range) {
  if (range.mode === 'all') return true;
  if (!date) return false;
  const t = date.getTime();
  return t >= range.start.getTime() && t <= range.end.getTime();
}

// true khi khoang loc chi gom dung 1 ngay (vd "1 ngày", hoac tuy chinh tu ngay = den ngay)
function isSingleDayRange(range) {
  return range.mode !== 'all' && formatDMY(range.start) === formatDMY(range.end);
}

// Chuoi 'YYYY-MM-DD' theo LICH VN cua 1 Date — dung lam tham so $2/$3 (DATE)
// cho cac truy van dashboardRollupRepository.js, tranh phai lap logic quy doi
// mui gio o file do (xem ghi chu dau file dashboardRollupRepository.js).
function toCalendarDateKey(date) {
  const { day, month, year } = getDashboardDateParts(date);
  return `${year}-${month}-${day}`;
}

// Quy doi 1 `range` (tu resolveFilterRange) sang cap {from, to} dang chuoi
// 'YYYY-MM-DD' hoac null (che do "Tất cả" — khong gioi han ngay).
function rangeToDateBounds(range) {
  if (!range || range.mode === 'all') return { from: null, to: null };
  return { from: toCalendarDateKey(range.start), to: toCalendarDateKey(range.end) };
}

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

// ---------- Cache THEO CO SO -------------------------------------------------
// Moi cache duoi day deu keyed by branch: hai co so doc hai spreadsheet khac
// nhau nen dung chung 1 cache se lam nguoi dung co so nay nhan du lieu cua co
// so kia (ro ri du lieu, khong chi la loi hien thi).
function emptyCache() {
  return { data: null, expiresAt: 0, loading: null };
}

function cacheEntryFor(cacheMap, branch) {
  const key = branch || BRANCHES.HANOI;
  if (!cacheMap.has(key)) cacheMap.set(key, emptyCache());
  return cacheMap.get(key);
}

function normalizeWhitespace(value) {
  return String(value === undefined || value === null ? '' : value)
    .normalize('NFKC')
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeSearchValue(value) {
  return normalizeWhitespace(value)
    // Chuẩn NFC giúp so sánh dấu tiếng Việt nhất quán ngay cả khi nguồn dữ liệu và
    // truy vấn dùng cách biểu diễn Unicode khác nhau (ví dụ: "a" + dấu tổ hợp so với
    // ký tự dựng sẵn). Chữ hoa/thường được bỏ qua có chủ đích.
    .normalize('NFC')
    .toLocaleLowerCase('vi-VN');
}

function compactSearchValue(value) {
  return value.replace(/\s/gu, '');
}

// ---------- Danh ba khach hang (rieng, nhe) — goi y tim khach o phan "Bao cao
// doanh thu theo khach" (tab Tong quan) ----------------------------------
// Cache TACH BIET voi dashboardSheetsCacheByBranch:
// o day chi doc bang "customers" (nhe, xem customerDirectoryRepository.js)
// thay vi phai cho ca 9 bang dashboard (~14s luc cache nguoi) chi de goi y
// ten/ma khach hang. Du lieu day du (doanh thu 90 ngay) van chi tai SAU khi
// nguoi dung chon 1 khach cu the, qua /api/customer-product-revenue.
// Danh ba chi doi khi sync ghi khach moi/sua khach ('customersChanged' phat sau
// COMMIT, xem handler o dau file) nen TTL dai (10 phut) chi la luoi an toan.
const CUSTOMER_DIRECTORY_CACHE_TTL_MS = 10 * 60 * 1000;
let customerDirectoryCacheByBranch = new Map();
// Het han moi danh ba da cache: lan getCustomerDirectory ke tiep doc lai DB.
// (Doc qua tham chieu bien module nen van dung sau resetCaches.)
function expireCustomerDirectoryCaches() {
  customerDirectoryCacheByBranch.forEach(entry => { entry.expiresAt = 0; });
}
const CUSTOMER_DIRECTORY_BRANCH_RANK = { hanoi: 0, saigon: 1 };

// Gop danh sach cua "Ca hai" ve 1 dong moi khach (uu tien Ha Noi truoc, giong
// BRANCH_RANK_SQL trong customerProductTopRepository.js) — tranh goi y hien
// trung mot khach hai lan khi ma khach trung giua hai co so.
function dedupeCustomerDirectoryRows(rows, byName = false) {
  const sorted = rows.slice().sort((a, b) =>
    (CUSTOMER_DIRECTORY_BRANCH_RANK[a.branch] ?? 99) - (CUSTOMER_DIRECTORY_BRANCH_RANK[b.branch] ?? 99));
  const seen = new Map();
  sorted.forEach(row => {
    // "Cả hai": khach o hai co so co ma khac nhau nhung cung ten => mot khach.
    const key = byName && row.name
      ? 'name:' + normalizeSearchValue(row.name)
      : normalizeSearchValue(row.code) || (row.name ? 'name:' + normalizeSearchValue(row.name) : '');
    if (!key || seen.has(key)) return;
    seen.set(key, { code: row.code, name: row.name || row.code });
  });
  return Array.from(seen.values());
}

/**
 * Ma khach cua CUNG MOT khach (theo ten) o tung co so vat ly — { hanoi: 'KH-1', saigon: 'KH-9' }.
 * Khach o "Cả hai" gop theo ten nen ma khac nhau giua hai co so.
 */
async function getCustomerCodesByBranchForName(customerName) {
  const nameKey = normalizeSearchValue(customerName);
  if (!nameKey) return {};
  await getCustomerDirectory(BRANCH_BOTH);
  const rows = cacheEntryFor(customerDirectoryCacheByBranch, BRANCH_BOTH).rows || [];
  const codes = {};
  rows.forEach(row => {
    if (row.code && normalizeSearchValue(row.name) === nameKey && !codes[row.branch]) codes[row.branch] = row.code;
  });
  return codes;
}

async function getCustomerDirectory(branch) {
  const cache = cacheEntryFor(customerDirectoryCacheByBranch, branch);
  const now = Date.now();
  if (cache.data && now < cache.expiresAt) return cache.data;
  if (cache.loading) return cache.loading;

  const loading = customerDirectoryRepository.readCustomerDirectory(branch)
    .then(rows => {
      cache.rows = rows;
      cache.data = dedupeCustomerDirectoryRows(rows, branch === BRANCH_BOTH);
      cache.expiresAt = Date.now() + CUSTOMER_DIRECTORY_CACHE_TTL_MS;
      return cache.data;
    })
    .finally(() => {
      if (cache.loading === loading) cache.loading = null;
    });
  cache.loading = loading;
  return loading;
}

/**
 * Goi y ten/ma khach hang NHANH cho o tim kiem o phan "Bao cao doanh thu theo
 * khach" — dung rieng danh ba khach hang (getCustomerDirectory), de khong
 * bi cho theo cache nang cua cac tab khac (Hoa don/Nhap hang...).
 */
const FUZZY_MATCH_RANK = 14;

async function searchCustomerDirectory(branch, rawQuery, rawLimit) {
  const queryText = normalizeWhitespace(rawQuery).slice(0, 120);
  if (!queryText) return { query: queryText, results: [] };
  const limit = Math.min(Math.max(Number(rawLimit) || 8, 1), 50);

  const normalizedQuery = normalizeSearchValue(queryText);
  const query = {
    value: normalizedQuery,
    compactValue: compactSearchValue(normalizedQuery),
    tokens: normalizedQuery.split(' ').filter(Boolean)
  };

  const directory = await getCustomerDirectory(branch);
  const fuzzyMatcher = fuzzy.createMatcher(queryText);
  const matches = [];
  directory.forEach(customer => {
    const normalizedCode = normalizeSearchValue(customer.code);
    const normalizedName = normalizeSearchValue(customer.name);
    const rank = getSearchMatchRank({
      normalizedCode,
      normalizedName,
      compactCode: compactSearchValue(normalizedCode),
      compactName: compactSearchValue(normalizedName)
    }, query);
    if (rank >= 0) { matches.push({ customer, rank, score: 0 }); return; }
    // Khong khop theo cum tu: tim gan dung (1 tu phai khop; 2 tu ca 2; >=3 tu qua nua; bo dau), xep sau cac hang tren.
    const score = fuzzyMatcher.empty ? 0 : fuzzyMatcher.score(fuzzy.fold(`${customer.code} ${customer.name}`));
    if (score > 0) matches.push({ customer, rank: FUZZY_MATCH_RANK, score });
  });

  matches.sort((a, b) =>
    a.rank - b.rank || b.score - a.score ||
    a.customer.code.localeCompare(b.customer.code, 'vi', { numeric: true, sensitivity: 'base' }) ||
    a.customer.name.localeCompare(b.customer.name, 'vi', { sensitivity: 'base' }));

  return {
    query: queryText,
    results: matches.slice(0, limit).map(({ customer }) => ({ code: customer.code, name: customer.name || customer.code }))
  };
}

function getSearchMatchRank(record, query) {
  const { normalizedCode: code, normalizedName: name, compactCode, compactName } = record;
  const { value, compactValue, tokens } = query;
  if (code === value) return 0;
  if (name === value) return 1;
  if (compactCode === compactValue) return 2;
  if (compactName === compactValue) return 3;
  if (code.startsWith(value)) return 4;
  if (name.startsWith(value)) return 5;
  if (compactCode.startsWith(compactValue)) return 6;
  if (compactName.startsWith(compactValue)) return 7;
  if (code.includes(value)) return 8;
  if (name.includes(value)) return 9;
  if (compactCode.includes(compactValue)) return 10;
  if (compactName.includes(compactValue)) return 11;
  if (tokens.length > 1 && tokens.every(token => code.includes(token))) return 12;
  if (tokens.length > 1 && tokens.every(token => name.includes(token))) return 13;
  return -1;
}

// ---------- Cache ngan han cho du lieu tho ----------
// Truoc day moi lan goi /api/dashboard deu batchGet lai TOAN BO cac sheet.
// Gio moi tab co bo loc rieng nen client co the goi API thuong xuyen hon han
// (moi lan doi bo loc o bat ky tab nao) — cache vai chuc giay de khong phai
// quet lai toan bo bang Postgres; tinh toan loc theo ngay van chay tren du
// lieu da cache nen van nhanh va luon phan anh dung bo loc moi nhat.
let dashboardSheetsCacheByBranch = new Map();

function dashboardSheetsCacheFor(branch) {
  const key = branch || BRANCHES.HANOI;
  if (!dashboardSheetsCacheByBranch.has(key)) {
    dashboardSheetsCacheByBranch.set(key, { data: null, version: 0, expiresAt: 0, loading: null });
  }
  return dashboardSheetsCacheByBranch.get(key);
}

// Fetch Postgres that su, khong dong bo voi request nao ca — dung
// chung cho ca duong "cho fetch xong" (cache rong/qua han qua lau) lan
// duong "lam moi nen" (stale-while-revalidate, xem getCachedDashboardSheets).
function fetchAndCacheDashboardSheets(branch, cache) {
  const generationAtStart = invoiceCacheGeneration;
  return Promise.all([
    dashboardPgReader.readDashboardSheets(branch),
    customerDebtActivityRepository.readOperationalPeriods(branch)
  ]).then(([pgSheets, debtPeriods]) => {
    const sheets = { ...pgSheets, ...debtPeriods };
    cache.data = sheets;
    cache.version += 1;
    // Cache "full" gom Hoa don + Chi tiet hoa don -> het han theo su kien rollup.
    cache.expiresAt = rollupBoundExpiresAt(CONFIG.SHEET_INVOICES, Date.now(), generationAtStart);
    return sheets;
  });
}

// Doc Postgres ca 9 tab tren 1 co so mat ~14s (do luong that 2026-09-18,
// truy van "Nhap hang"/"Chi tiet hoa don" nang nhat) — neu de nguoi dung dau
// tien sau moi lan cache het han (90s) phai cho tron 14s thi rat cham. Ap
// dung stale-while-revalidate: qua han thi VAN tra du lieu cu ngay lap tuc,
// dong thoi am tham lam moi o nen — chi khi du lieu cu qua cu (qua
// MAX_STALE_MS, vd server moi khoi dong lai lau hoac Postgres loi lien tuc)
// moi bat nguoi dung dau tien cho fetch that.
const DASHBOARD_SHEETS_MAX_STALE_MS = 10 * 60 * 1000; // 10 phut

async function getCachedDashboardSheets(branch) {
  const cache = dashboardSheetsCacheFor(branch);
  const now = Date.now();
  if (cache.data && now < cache.expiresAt) {
    return cache.data;
  }

  const isUsableStale = cache.data && now < cache.expiresAt + DASHBOARD_SHEETS_MAX_STALE_MS;
  if (isUsableStale) {
    if (!cache.loading) {
      cache.loading = fetchAndCacheDashboardSheets(branch, cache)
        .catch(err => {
          console.error(`[Dashboard] Lam moi nen (stale-while-revalidate) that bai cho ${branch}, tiep tuc dung du lieu cu:`, err.message);
        })
        .finally(() => {
          if (cache.loading) cache.loading = null;
        });
    }
    return cache.data;
  }

  if (cache.loading) return cache.loading;
  const loading = fetchAndCacheDashboardSheets(branch, cache)
    .finally(() => {
      if (cache.loading === loading) cache.loading = null;
    });
  cache.loading = loading;
  return loading;
}

// ---------- Cache "core" (6/7 tab, nhanh) — dung RIENG cho /api/dashboard ----------
// Bo "Chi tiết hóa đơn" (tab nang nhat, ~14s/lan doc) — cac khoi
// tung can tab nay trong computeDashboardData() gio doc tu
// dashboardRollupRepository.js thay the. Cache "full" (getCachedDashboardSheets)
// chi con dung cho nhanh du phong cua bao cao doanh thu theo khach
// (getCustomerProductRevenueReport) — xuat Excel khong dung cache do.
//
// Cache THEO TUNG BANG (6 bang core + CN1/3/7 "@periods"), moi bang co TTL /
// stale-while-revalidate / version rieng: tab Tong quan chi doc Hang hoa + Hoa
// don + Khach hang + Nhom hang, khong phai cho bang Dat hang (~23K dong, ~2,8s).
// Cac bang thieu/qua cu trong cung 1 lan goi duoc gop thanh 1 lan doc Postgres
// duy nhat (giu dung so lan doc nhu cache 1 khoi truoc day khi can du 7 bang).
let dashboardCoreSheetsCacheByBranch = new Map(); // branch -> Map<key, { data, version, expiresAt, loading }>

function dashboardCoreEntry(branch, key) {
  const branchKey = branch || BRANCHES.HANOI;
  let entries = dashboardCoreSheetsCacheByBranch.get(branchKey);
  if (!entries) {
    entries = new Map();
    dashboardCoreSheetsCacheByBranch.set(branchKey, entries);
  }
  let entry = entries.get(key);
  if (!entry) {
    entry = { data: null, version: 0, expiresAt: 0, loading: null };
    entries.set(key, entry);
  }
  return entry;
}

function storeDashboardCoreEntry(branch, key, data, expiresAt) {
  const entry = dashboardCoreEntry(branch, key);
  entry.data = data;
  entry.version += 1;
  entry.expiresAt = expiresAt;
}

// Doc THAT tu Postgres cac khoa `keys` trong 1 lan (khong dong bo voi request
// nao) — dung chung cho duong "cho fetch xong" lan "lam moi nen".
function fetchDashboardCoreSources(branch, keys) {
  const sheetNames = keys.filter(key => key !== PERIODS_KEY);
  const wantPeriods = keys.includes(PERIODS_KEY);
  const generationAtStart = invoiceCacheGeneration;
  const loading = Promise.all([
    sheetNames.length ? dashboardPgReader.readCoreDashboardSheets(branch, sheetNames) : null,
    wantPeriods ? customerDebtActivityRepository.readOperationalPeriods(branch) : null
  ]).then(([pgSheets, debtPeriods]) => {
    const fetchedAt = Date.now();
    sheetNames.forEach(name => {
      storeDashboardCoreEntry(branch, name, (pgSheets && pgSheets[name]) || [], rollupBoundExpiresAt(name, fetchedAt, generationAtStart));
    });
    if (wantPeriods) storeDashboardCoreEntry(branch, PERIODS_KEY, debtPeriods || {}, fetchedAt + DASHBOARD_SHEETS_CACHE_TTL_MS);
  }).finally(() => {
    keys.forEach(key => {
      const entry = dashboardCoreEntry(branch, key);
      if (entry.loading === loading) entry.loading = null;
    });
  });
  keys.forEach(key => { dashboardCoreEntry(branch, key).loading = loading; });
  return loading;
}

// Y het pattern stale-while-revalidate cua getCachedDashboardSheets() o tren
// (xem ghi chu tai do) nhung ap dung TUNG khoa: khoa con han -> dung ngay; khoa
// qua han vua phai (trong DASHBOARD_SHEETS_MAX_STALE_MS) -> tra du lieu cu roi
// lam moi nen; khoa chua co/qua cu -> phai cho doc that. Tra ve map ten sheet
// -> [header, ...rows] (kem HN1/HN3/HN7 neu `keys` co PERIODS_KEY).
async function getCachedDashboardCoreSources(branch, keys = ALL_CORE_KEYS) {
  const now = Date.now();
  const waiting = new Set();
  const mustFetch = [];
  const refreshInBackground = [];
  keys.forEach(key => {
    const entry = dashboardCoreEntry(branch, key);
    if (entry.data && now < entry.expiresAt) return;
    const isUsableStale = entry.data && now < entry.expiresAt + DASHBOARD_SHEETS_MAX_STALE_MS;
    if (entry.loading) {
      if (!isUsableStale) waiting.add(entry.loading);
      return;
    }
    (isUsableStale ? refreshInBackground : mustFetch).push(key);
  });

  if (refreshInBackground.length) {
    fetchDashboardCoreSources(branch, refreshInBackground).catch(err => {
      console.error(`[Dashboard] Lam moi nen (core, stale-while-revalidate) that bai cho ${branch}, tiep tuc dung du lieu cu:`, err.message);
    });
  }
  if (mustFetch.length) waiting.add(fetchDashboardCoreSources(branch, mustFetch));
  if (waiting.size) await Promise.all(waiting);

  const sources = {};
  keys.forEach(key => {
    const data = dashboardCoreEntry(branch, key).data;
    if (key === PERIODS_KEY) Object.assign(sources, data);
    else sources[key] = data;
  });
  return sources;
}

// Chi phuc vu test: duyet moi bang nguon da co trong cache cua 1 co so.
function forEachDashboardCoreEntry(branch, callback) {
  const entries = dashboardCoreSheetsCacheByBranch.get(branch || BRANCHES.HANOI);
  if (entries) entries.forEach(callback);
}

// true khi it nhat 1 bang nguon chua co hoac qua cu (ngoai cua so stale-while-revalidate) —
// tuc la request nay PHAI cho doc Postgres. Khi do version cua bang doi nen ket qua da tinh
// chac chan khong trung cache, co the chay rollup song song luon thay vi doi doc xong bang
// nguon (cold: tong = max(bang nguon, rollup) thay vi cong).
function dashboardCoreSourcesNeedBlockingFetch(branch, keys) {
  const now = Date.now();
  return keys.some(key => {
    const entry = dashboardCoreEntry(branch, key);
    return !(entry.data && now < entry.expiresAt + DASHBOARD_SHEETS_MAX_STALE_MS);
  });
}

// Chuoi phien ban cua cac khoa `keys` — vao khoa dashboardResultCache de ket
// qua tinh tu bang cu het hieu luc ngay khi bang do duoc lam moi.
function dashboardCoreSourcesVersion(branch, keys) {
  return keys.map(key => dashboardCoreEntry(branch, key).version).join('.');
}

/**
 * Gop cac hoa don trong `records` thanh chuoi doanh thu theo ngay trong
 * `range`. Voi "Tat ca" (khong gioi han), bucket theo tung ngay THUC SU CO
 * hoa don thay vi dien du moi ngay lich (tranh bieu do qua dai/rong khi du
 * lieu trai dai nhieu nam).
 */
function buildRevenuePeriod(range, invoiceRecords) {
  const completed = invoiceRecords.filter(r => r.isCompleted && r._dt && isWithinRange(r._dt, range));
  const dayBuckets = {};
  const dayOrder = [];

  if (range.mode === 'all') {
    completed
      .slice()
      .sort((a, b) => a._sortTime - b._sortTime)
      .forEach(r => {
        if (!dayBuckets[r._dateKey]) {
          dayBuckets[r._dateKey] = { revenue: 0, count: 0 };
          dayOrder.push(r._dateKey);
        }
      });
  } else {
    let cursor = range.start;
    while (cursor.getTime() <= range.end.getTime()) {
      const key = formatDMY(cursor);
      dayBuckets[key] = { revenue: 0, count: 0 };
      dayOrder.push(key);
      cursor = new Date(cursor.getTime() + DAY_MS);
    }
  }

  completed.forEach(r => {
    const bucket = dayBuckets[r._dateKey];
    if (!bucket) return;
    bucket.revenue += r.total;
    bucket.count += 1;
  });

  const revenueByDay = dayOrder.map(key => ({
    date: key,
    label: key.substring(0, 5),
    revenue: dayBuckets[key].revenue,
    count: dayBuckets[key].count
  }));
  const periodRevenue = revenueByDay.reduce((s, d) => s + d.revenue, 0);
  const periodInvoices = revenueByDay.reduce((s, d) => s + d.count, 0);
  return { revenueByDay, periodRevenue, periodInvoices };
}

// Doanh thu thuc te theo tung co so tren moi dong rollup (de ve cot chong Ha Noi + Sai Gon).
const REVENUE_BRANCH_FIELDS = ['revenueHanoi', 'revenueSaigon'];

function revenueBranchField(physicalBranch) {
  if (physicalBranch === BRANCHES.HANOI) return 'revenueHanoi';
  if (physicalBranch === BRANCHES.SAIGON) return 'revenueSaigon';
  return null;
}

/**
 * Gan `revenueHanoi`/`revenueSaigon` (= `revenue` cua dong) vao cac dong doanh thu theo ngay cua 1 co so vat ly,
 * de buoc gop "Cả hai" (cong theo ngay) giu duoc phan cua tung co so. Tra ban sao — `rollups` co the
 * dang duoc chia se giua cac request dang bay.
 */
function tagRollupBranch(rollups, physicalBranch) {
  const field = revenueBranchField(physicalBranch);
  if (!field || !rollups) return rollups;
  const tag = rows => (rows || []).map(row => ({ ...row, [field]: Number(row.revenue) || 0 }));
  return { ...rollups, overviewRevenueRows: tag(rollups.overviewRevenueRows), invoicesRevenueRows: tag(rollups.invoicesRevenueRows) };
}

/**
 * Ban sao cua buildRevenuePeriod() nhung nguon la cac dong da tong hop san tu
 * daily_invoice_summary (dashboardRollupRepository.getInvoiceRevenueByDay) —
 * thay vi quet tung hoa don trong `invoiceRecords`. `rollupRows` da duoc SQL
 * loc dung hoa don Hoan thanh, TRU tra hang, va sap xep tang dan theo ngay, nen o day CHI
 * can dien them cac ngay trong khoang khong phat sinh (che do 'days'/'range')
 * hoac giu nguyen thu tu tra ve (che do 'all', chi gom ngay THUC SU CO du
 * lieu — giong het hanh vi cu).
 */
function buildRevenuePeriodFromRollup(range, rollupRows) {
  const dayBuckets = {};
  const dayOrder = [];

  // Doanh thu theo co so (cot chong HN/SG cua bieu do): chi co khoa cua co so nao CO mat trong du lieu
  // (xem tagRollupBranch), ngay khong phat sinh thi 0.
  const branchSeries = REVENUE_BRANCH_FIELDS.filter(field => rollupRows.some(row => row[field] !== undefined));
  const newBucket = () => {
    const bucket = { revenue: 0, grossRevenue: 0, returnAmount: 0, count: 0 };
    branchSeries.forEach(field => { bucket[field] = 0; });
    return bucket;
  };

  if (range.mode === 'all') {
    rollupRows.forEach(row => {
      if (!dayBuckets[row.dateKey]) {
        dayBuckets[row.dateKey] = newBucket();
        dayOrder.push(row.dateKey);
      }
    });
  } else {
    let cursor = range.start;
    while (cursor.getTime() <= range.end.getTime()) {
      const key = formatDMY(cursor);
      dayBuckets[key] = newBucket();
      dayOrder.push(key);
      cursor = new Date(cursor.getTime() + DAY_MS);
    }
  }

  // `revenue` cua dong rollup la doanh thu THUC TE (da tru tien tra hang trong
  // ngay, xem getInvoiceRevenueByDay). Dong khong co grossRevenue/returnAmount
  // (nguon cu) coi nhu khong co tra hang.
  rollupRows.forEach(row => {
    const bucket = dayBuckets[row.dateKey];
    if (!bucket) return;
    const returnAmount = Number(row.returnAmount) || 0;
    bucket.revenue += row.revenue;
    bucket.grossRevenue += row.grossRevenue !== undefined ? Number(row.grossRevenue) || 0 : row.revenue + returnAmount;
    bucket.returnAmount += returnAmount;
    bucket.count += row.invoiceCount;
    branchSeries.forEach(field => { bucket[field] += Number(row[field]) || 0; });
  });

  const revenueByDay = dayOrder.map(key => {
    const day = {
      date: key,
      label: key.substring(0, 5),
      revenue: dayBuckets[key].revenue,
      grossRevenue: dayBuckets[key].grossRevenue,
      returnAmount: dayBuckets[key].returnAmount,
      count: dayBuckets[key].count
    };
    branchSeries.forEach(field => { day[field] = dayBuckets[key][field]; });
    return day;
  });
  const periodRevenue = revenueByDay.reduce((s, d) => s + d.revenue, 0);
  const periodGrossRevenue = revenueByDay.reduce((s, d) => s + d.grossRevenue, 0);
  const periodReturnAmount = revenueByDay.reduce((s, d) => s + d.returnAmount, 0);
  const periodInvoices = revenueByDay.reduce((s, d) => s + d.count, 0);
  return { revenueByDay, periodRevenue, periodGrossRevenue, periodReturnAmount, periodInvoices };
}

/**
 * Doanh thu 90 ngay gan nhat cua 1 khach hang cu the, tach theo tung san
 * pham (tab Khach hang — "Bao cao doanh thu theo khach"). Join truc tiep
 * "Hoa don" (de biet ngay ban + khach hang) voi "Chi tiet hoa don" (de biet
 * mat hang) qua Ma hoa don. KHONG dung cac sheet tong hop san co ("Bao cao
 * ban hang"/"Khach theo hang hoa") vi do la snapshot toan thoi gian, refresh
 * 1 lan/ngay va khong co san 3 bucket thang (0-29/30-59/60-89 ngay) can cho
 * bang so sanh doanh so theo thang.
 */
function computeCustomerProductRevenue(sheets, customerCode, customerName, now) {
  const targetCode = String(customerCode || '').trim();
  if (!targetCode) {
    const err = new Error('Thiếu mã khách hàng.');
    err.statusCode = 400;
    err.code = 'CUSTOMER_CODE_REQUIRED';
    throw err;
  }

  const range = resolveFilterRange({ mode: 'days', days: CUSTOMER_PRODUCT_REVENUE_WINDOW_DAYS }, now);
  const invData = sheets[CONFIG.SHEET_INVOICES] || [];
  const detailData = sheets[CONFIG.SHEET_INVOICE_DETAILS] || [];
  const custData = sheets[CONFIG.SHEET_CUSTOMERS] || [];

  // Cung mot chuoi fallback ma khach hang (ma -> SDT -> ten chuan hoa) nhu
  // aggregateCustomerRevenueFromSheetRows, de doanh thu tinh o day khop voi so
  // lieu "Top khach hang theo doanh thu" o phan 2 cua cung tab.
  const custCodeByPhone = new Map();
  const custCodeByName = new Map();
  let resolvedName = String(customerName || '').trim();
  for (let r = 1; r < custData.length; r++) {
    const row = custData[r];
    const code = String(row[0] || '').trim();
    const name = String(row[1] || '').trim();
    const phone = normalizePhone(row[2]);
    if (!code) continue;
    if (phone) custCodeByPhone.set(phone, code);
    if (name) custCodeByName.set(normalizeSearchValue(name), code);
    if (code === targetCode && name && !resolvedName) resolvedName = name;
  }

  const invHeaders = invData[0] || [];
  const invIndex = (header, fallback) => {
    const idx = invHeaders.findIndex(h => String(h || '').trim() === header);
    return idx >= 0 ? idx : fallback;
  };
  const invCodeIdx = invIndex('Mã hóa đơn', 0);
  const invDateIdx = invIndex('Ngày bán', 1);
  const invNameIdx = invIndex('Khách hàng', 2);
  const invPhoneIdx = invIndex('SĐT khách', 3);
  const invStatusIdx = invIndex('Trạng thái', 9);
  const invCustCodeIdx = invIndex('Mã khách hàng', 15);

  // Ma hoa don (da chuan hoa) -> ngay ban, chi giu hoa don hoan thanh, trong
  // 90 ngay va thuoc dung khach hang dang xem.
  const matchedInvoiceDates = new Map();
  for (let r = 1; r < invData.length; r++) {
    const row = invData[r];
    const status = String(row[invStatusIdx] || 'Hoàn thành').trim();
    if (status !== 'Hoàn thành') continue;

    const dt = parseSheetDate(row[invDateIdx]);
    if (!isWithinRange(dt, range)) continue;

    let code = String(row[invCustCodeIdx] || '').trim();
    const name = String(row[invNameIdx] || '').trim();
    const phone = normalizePhone(row[invPhoneIdx]);
    if (!code && phone && custCodeByPhone.has(phone)) code = custCodeByPhone.get(phone);
    if (!code && name && custCodeByName.has(normalizeSearchValue(name))) code = custCodeByName.get(normalizeSearchValue(name));
    if (code !== targetCode) continue;

    const invoiceCode = String(row[invCodeIdx] || '').trim();
    if (!invoiceCode) continue;
    matchedInvoiceDates.set(invoiceCode, dt);
    if (!resolvedName && name) resolvedName = name;
  }

  const detHeaders = detailData[0] || [];
  const detIndex = (header, fallback) => {
    const idx = detHeaders.findIndex(h => String(h || '').trim() === header);
    return idx >= 0 ? idx : fallback;
  };
  const detCodeIdx = detIndex('Mã hóa đơn', 0);
  const detItemCodeIdx = detIndex('Mã hàng', 1);
  const detItemNameIdx = detIndex('Tên hàng', 2);
  const detQtyIdx = detIndex('Số lượng', 3);
  const detTotalIdx = detIndex('Thành tiền', 6);

  const lines = [];
  for (let r = 1; r < detailData.length; r++) {
    const row = detailData[r];
    const invoiceCode = String(row[detCodeIdx] || '').trim();
    if (!invoiceCode || !matchedInvoiceDates.has(invoiceCode)) continue;
    lines.push({
      dateKey: formatDMY(matchedInvoiceDates.get(invoiceCode)),
      itemCode: row[detItemCodeIdx],
      itemName: row[detItemNameIdx],
      quantity: row[detQtyIdx],
      revenue: row[detTotalIdx]
    });
  }

  return buildCustomerProductRevenueReport({ targetCode, resolvedName, lines, range });
}

/**
 * Phan tinh thuan cua "Bao cao doanh thu theo khach", dung chung cho 2 nguon
 * dong hang (computeCustomerProductRevenue doc tu sheet, computeCustomerProduct
 * RevenueFromLines doc tu bang chi tiet 90 ngay): gom theo ngay/mat hang va chia
 * 3 bucket thang. `lines` = cac dong chi tiet hoa don da thuoc dung khach, theo
 * thu tu hoa don moi nhat truoc (ten hien thi cua mat hang lay o dong dau tien);
 * `range` = {start, end, label} cua cua so 90 ngay.
 */
function buildCustomerProductRevenueReport({ targetCode, resolvedName, lines, range }) {
  const dayKeys = [];
  for (let cursor = range.start; cursor.getTime() <= range.end.getTime(); cursor = new Date(cursor.getTime() + DAY_MS)) {
    dayKeys.push(formatDMY(cursor));
  }
  // Tuoi (so ngay truoc ngay cuoi cua so) cua tung ngay trong dayKeys, dung de
  // xep vao bucket T.nay/T.truoc/T.truoc nua. Tinh tu vi tri trong dayKeys (KHONG
  // dung ham daysSince() dung chung — ham do luon so voi new Date() THUC, bo
  // qua tham so `now` truyen vao nen se sai khi test truyen `now` gia dinh).
  const ageByDateKey = new Map();
  const lastDayIndex = dayKeys.length - 1;
  dayKeys.forEach((key, index) => ageByDateKey.set(key, lastDayIndex - index));
  const emptyDayBuckets = () => {
    const buckets = {};
    dayKeys.forEach(key => { buckets[key] = 0; });
    return buckets;
  };
  const toRevenueByDay = dayBuckets => dayKeys.map(key => ({
    date: key,
    label: key.substring(0, 5),
    revenue: dayBuckets[key] || 0
  }));

  const totalDayBuckets = emptyDayBuckets();
  const productsByCode = new Map();

  for (const line of lines) {
    const dateKey = line.dateKey;
    const quantity = Number(line.quantity) || 0;
    const revenue = Number(line.revenue) || 0;
    const itemCode = String(line.itemCode || '').trim() || '—';
    const itemName = String(line.itemName || '').trim() || itemCode;

    if (totalDayBuckets[dateKey] !== undefined) totalDayBuckets[dateKey] += revenue;

    if (!productsByCode.has(itemCode)) {
      productsByCode.set(itemCode, {
        code: itemCode,
        name: itemName,
        quantity: 0,
        revenue: 0,
        month1Revenue: 0,
        month2Revenue: 0,
        month3Revenue: 0,
        dayBuckets: emptyDayBuckets()
      });
    }
    const product = productsByCode.get(itemCode);
    product.quantity += quantity;
    product.revenue += revenue;
    if (product.dayBuckets[dateKey] !== undefined) product.dayBuckets[dateKey] += revenue;

    // T.nay = 0-29 ngay truoc, T.truoc = 30-59, T.truoc nua = 60-89 (hoa don
    // qua 90 ngay da bi loai o vong loc "Hoa don" phia tren nen khong can
    // nhanh else rieng cho "ngoai pham vi").
    const age = ageByDateKey.get(dateKey);
    if (age !== undefined) {
      if (age < CUSTOMER_PRODUCT_REVENUE_MONTH_DAYS) product.month1Revenue += revenue;
      else if (age < CUSTOMER_PRODUCT_REVENUE_MONTH_DAYS * 2) product.month2Revenue += revenue;
      else if (age < CUSTOMER_PRODUCT_REVENUE_MONTH_DAYS * 3) product.month3Revenue += revenue;
    }
  }

  const products = Array.from(productsByCode.values())
    .map(p => ({
      code: p.code,
      name: p.name,
      quantity: p.quantity,
      revenue: p.revenue,
      month1Revenue: p.month1Revenue,
      month2Revenue: p.month2Revenue,
      month3Revenue: p.month3Revenue,
      revenueByDay: toRevenueByDay(p.dayBuckets)
    }))
    .sort((a, b) => b.revenue - a.revenue);

  return {
    customer: { code: targetCode, name: resolvedName || targetCode },
    range: { from: formatDMY(range.start), to: formatDMY(range.end), days: CUSTOMER_PRODUCT_REVENUE_WINDOW_DAYS, label: range.label },
    totalRevenueByDay: toRevenueByDay(totalDayBuckets),
    totalRevenue: products.reduce((sum, p) => sum + p.revenue, 0),
    totalQuantity: products.reduce((sum, p) => sum + p.quantity, 0),
    products
  };
}

/**
 * Cung bao cao, nhung dong hang doc san tu bang customer_invoice_lines_90d (xem
 * customerInvoiceLinesRepository.js) thay vi doi chieu 3 sheet. Cua so la 90 ngay
 * ket thuc HOM QUA luc bang duoc dung lai (mac dinh moi dem), nen bucket thang
 * tinh theo ngay cuoi cua so do — khac luong sheet (cua so ket thuc hom nay).
 * Tra null khi bang chua tung duoc dung (de goi ham quay ve luong sheet).
 *
 * Ten khach: uu tien `customerName` nguoi goi truyen (giao dien luon truyen), thieu
 * thi lay ten tren hoa don gan nhat — bo buoc tra bang customers cua luong sheet
 * vi bang do khong co index theo ma khach.
 */
async function computeCustomerProductRevenueFromLines(customerCode, customerName, branch) {
  const targetCode = String(customerCode || '').trim();
  if (!targetCode) return null;

  const physicalBranches = branch === BRANCH_BOTH ? resolveBranchScope(BRANCH_BOTH) : [branch || BRANCHES.HANOI];
  const branchCodes = physicalBranches.map(branchLabelToCode);
  if (branchCodes.some(code => !code)) return null;

  // "Cả hai": khach gop theo ten nen moi co so co ma rieng; khong tra duoc danh ba thi
  // giu cach cu (cung 1 ma cho ca hai co so).
  const customerCodesByBranch = branch === BRANCH_BOTH
    ? await getCustomerCodesByBranchForName(customerName).catch(() => ({}))
    : {};
  const snapshot = await customerInvoiceLinesRepository.readCustomerInvoiceLines({
    branchCodes,
    customerCode: targetCode,
    ...(Object.keys(customerCodesByBranch).length ? { customerCodesByBranch } : {})
  });
  if (!snapshot) return null;

  const range = {
    start: startOfDay(parseSheetDate(snapshot.window.start)),
    end: endOfDay(parseSheetDate(snapshot.window.end)),
    label: `${CUSTOMER_PRODUCT_REVENUE_WINDOW_DAYS} ngày`
  };
  const reports = branchCodes.map(code => {
    const lines = snapshot.linesByBranch[code] || [];
    const invoiceName = lines.length ? String(lines[0].customerName || '').trim() : '';
    return buildCustomerProductRevenueReport({
      targetCode,
      resolvedName: String(customerName || '').trim() || invoiceName,
      lines,
      range
    });
  });
  const report = reports.length > 1 ? mergeCustomerProductRevenueReports(reports) : reports[0];
  return { ...report, computedAt: snapshot.computedAt };
}

// Ten hien thi that (khac ma du phong) dau tien theo thu tu Ha Noi -> Sai Gon.
function isRealDisplayName(name, code) {
  const text = String(name || '').trim();
  return Boolean(text) && text !== String(code || '').trim();
}

/**
 * Gop bao cao doanh thu theo khach cua cac co so vat ly (moi bao cao da tinh
 * rieng tren hoa don + chi tiet cua CHINH co so do, nen hoa don trung ma giua hai
 * co so khong bao gio bi ghep nham). Cong theo ma hang chuan hoa va theo ngay.
 */
function mergeCustomerProductRevenueReports(reports) {
  const cloneDays = days => days.map(day => ({ ...day }));
  const addDays = (target, source) => {
    const byDate = new Map(target.map(day => [day.date, day]));
    source.forEach(day => {
      if (byDate.has(day.date)) byDate.get(day.date).revenue += day.revenue;
    });
  };
  const first = reports[0];
  const totalRevenueByDay = cloneDays(first.totalRevenueByDay);
  const productsByCode = new Map();
  let customerName = '';

  reports.forEach((report, reportIndex) => {
    if (reportIndex > 0) addDays(totalRevenueByDay, report.totalRevenueByDay);
    if (!customerName && isRealDisplayName(report.customer.name, report.customer.code)) customerName = report.customer.name;
    report.products.forEach(product => {
      const key = normalizeSearchValue(product.code);
      if (!productsByCode.has(key)) {
        productsByCode.set(key, { ...product, revenueByDay: cloneDays(product.revenueByDay) });
        return;
      }
      const target = productsByCode.get(key);
      if (!isRealDisplayName(target.name, target.code) && isRealDisplayName(product.name, product.code)) {
        target.name = product.name;
      }
      ['quantity', 'revenue', 'month1Revenue', 'month2Revenue', 'month3Revenue'].forEach(field => {
        target[field] += product[field];
      });
      addDays(target.revenueByDay, product.revenueByDay);
    });
  });

  const products = Array.from(productsByCode.values()).sort((a, b) => b.revenue - a.revenue);
  return {
    customer: { code: first.customer.code, name: customerName || first.customer.code },
    range: first.range,
    totalRevenueByDay,
    totalRevenue: products.reduce((sum, p) => sum + p.revenue, 0),
    totalQuantity: products.reduce((sum, p) => sum + p.quantity, 0),
    products
  };
}

async function getCustomerProductRevenueReport(customerCode, customerName, branch, now = new Date()) {
  // Uu tien bang chi tiet 90 ngay dung san moi dem (tra cuu theo index, nhanh);
  // chua co bang / loi doc bang (vd chua chay migration 0022) thi quay ve luong
  // doi chieu sheet cu de bao cao khong bi hong.
  try {
    const fromLines = await computeCustomerProductRevenueFromLines(customerCode, customerName, branch);
    if (fromLines) return fromLines;
  } catch (err) {
    console.error('[Dashboard] Doc bang chi tiet hoa don 90 ngay that bai, quay ve luong sheet:', err.message);
  }
  if (branch === BRANCH_BOTH) {
    const codesByBranch = await getCustomerCodesByBranchForName(customerName).catch(() => ({}));
    const reports = await Promise.all(resolveBranchScope(BRANCH_BOTH).map(async physicalBranch =>
      computeCustomerProductRevenue(
        await getCachedDashboardSheets(physicalBranch),
        codesByBranch[branchLabelToCode(physicalBranch)] || customerCode,
        customerName,
        now
      )));
    return mergeCustomerProductRevenueReports(reports);
  }
  const sheets = await getCachedDashboardSheets(branch);
  return computeCustomerProductRevenue(sheets, customerCode, customerName, now);
}

/**
 * Bao cao chi tiet giao dich trong `range` cho tab Hoa don (truoc day nam o tab
 * Tong quan, thay cho khai niem "cuoi ngay" co dinh). Tong hop (summary) luon tinh tren TOAN
 * BO giao dich trong ky. Danh sach chi tiet (transactions) tra ve day du de
 * bang co the phan trang tren toan bo ky; rieng bieu do van chi dung top 15.
 */
function invoiceIdentity(branch, code) {
  return `${String(branch || '').trim()}\u0000${String(code || '').trim()}`;
}

function queryTransactionsReport(report, query = {}, { exportAll = false } = {}) {
  const { pageRows, sortRows, searchRows, rowText, scalarCatalog } = require('../shared/tablePage');
  const all = report.transactions || [];
  const { rows, search } = searchRows(all, query, { searchText: rowText, code: row => row.code });
  const complete = rows.filter(row => row.status === 'Hoàn thành');
  const total = key => complete.reduce((sum, row) => sum + (Number(row[key]) || 0), 0);
  const summary = { transactionCount: complete.length, cancelledCount: rows.length - complete.length,
    quantity: total('quantity'), quantityKnown: complete.length > 0 && complete.every(row => row.quantityKnown),
    revenue: total('revenue'), discount: total('discount'), paid: total('paid') };
  const sorted = sortRows(rows, query.sorts, scalarCatalog(all));
  const page = exportAll ? { rows: sorted, totalRows: sorted.length } : pageRows(sorted, query);
  return { ...report, ...page, transactions: page.rows, summary, search, filters: {}, totalInRange: rows.length,
    topTransactions: complete.slice().sort((a, b) => b.revenue - a.revenue).slice(0, TOP_REPORT_TRANSACTIONS) };
}

function queryCustomerProductReport(report, query = {}) {
  const { pageRows, sortRows, searchRows, rowText, scalarCatalog } = require('../shared/tablePage');
  const all = report.products || [];
  const productCode = String(query.productCode || '').trim().toLocaleLowerCase('vi-VN');
  const selected = productCode ? all.filter(row => String(row.code || '').trim().toLocaleLowerCase('vi-VN') === productCode) : all;
  const { rows, search } = searchRows(selected, query, { searchText: rowText, code: row => row.code });
  const sorted = sortRows(rows, query.sorts, scalarCatalog(all));
  const sum = key => rows.reduce((total, row) => total + (Number(row[key]) || 0), 0);
  const summary = { revenue: sum('revenue'), quantity: sum('quantity'), month1Revenue: sum('month1Revenue'), month2Revenue: sum('month2Revenue'), month3Revenue: sum('month3Revenue'), purchasedCount: rows.filter(row => Number(row.quantity) > 0).length };
  const page = pageRows(sorted, query);
  return { ...report, ...page, products: page.rows,
    chartProducts: selected.map(({ code, name, revenue }) => ({ code, name, revenue })),
    productOptions: all.map(({ code, name }) => ({ code, name })),
    selectedRevenueByDay: productCode && selected[0] ? selected[0].revenueByDay || [] : null,
    summary, search, filters: {}, totalRevenue: summary.revenue, totalQuantity: summary.quantity };
}

function buildTransactionsReport(range, invoiceRecords, invoiceQuantityMap, includeBranch = true) {
  const singleDay = isSingleDayRange(range);
  const inRangeRecords = invoiceRecords.filter(r => isWithinRange(r._dt, range));

  const allTransactions = inRangeRecords
    .map(r => {
      const normalizedCode = String(r.code).trim();
      const branchQuantityKey = invoiceIdentity(r.branch, normalizedCode);
      const quantityKey = r.branch && invoiceQuantityMap.has(branchQuantityKey) ? branchQuantityKey : normalizedCode;
      return {
        code: r.code,
        ...(includeBranch ? { branch: r.branch } : {}),
        time: r._dt ? (singleDay ? formatHM(r._dt) : formatDMYHM(r._dt)) : '—',
        // Chuoi `time` o tren khong co nam (dd/MM HH:mm, hay HH:mm khi loc 1 ngay) nen khong sap theo chuoi duoc:
        // gui kem epoch ms de bang sap xep theo THOI GIAN that (null khi hoa don khong co thoi gian).
        timeMs: r._dt ? r._dt.getTime() : null,
        customer: r.customer,
        employee: r.employee,
        quantity: invoiceQuantityMap.get(quantityKey) || 0,
        quantityKnown: invoiceQuantityMap.has(quantityKey),
        revenue: r.total,
        discount: r.discount,
        paid: r.paid,
        status: r.status,
        _sortTime: r._sortTime
      };
    })
    .sort((a, b) => b._sortTime - a._sortTime);

  const completedTransactions = allTransactions.filter(t => t.status === 'Hoàn thành');
  const topTransactions = completedTransactions
    .slice()
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, TOP_REPORT_TRANSACTIONS)
    .map(({ _sortTime, ...rest }) => rest);
  const summary = {
    transactionCount: completedTransactions.length,
    cancelledCount: allTransactions.length - completedTransactions.length,
    quantity: completedTransactions.reduce((s, t) => s + t.quantity, 0),
    quantityKnown: completedTransactions.length > 0 && completedTransactions.every(t => t.quantityKnown),
    revenue: completedTransactions.reduce((s, t) => s + t.revenue, 0),
    discount: completedTransactions.reduce((s, t) => s + t.discount, 0),
    paid: completedTransactions.reduce((s, t) => s + t.paid, 0)
  };

  const transactions = allTransactions
    .map(({ _sortTime, ...rest }) => rest);

  return {
    date: range.label,
    singleDay,
    truncated: false,
    totalInRange: allTransactions.length,
    transactions,
    topTransactions,
    summary
  };
}

// Cot "Cơ sở" (nhan co so vat ly 'Hà Nội'/'Sài Gòn') them vao cuoi moi tab boi dashboardPgReader.
const SHEET_FACILITY_HEADER = 'Cơ sở';
// Cot phu them vao tab Khach hang da gop theo ten: JSON { 'Hà Nội': maKH, 'Sài Gòn': maKH }.
const CUSTOMER_CODES_HEADER = 'Mã khách hàng theo cơ sở';
// Cot phu JSON { 'Hà Nội': no, 'Sài Gòn': no } — cong no cua khach o tung co so (cot "Nợ hiện tại" la tong).
const CUSTOMER_DEBT_BY_BRANCH_HEADER = 'Nợ hiện tại theo cơ sở';

// Bao dam sheet gop co cot "Cơ sở" (nguon khong tu mang cot nay van nhan dung co so vat ly).
function ensureFacilityHeader(headers) {
  const index = headers.findIndex(header => String(header || '').trim() === SHEET_FACILITY_HEADER);
  if (index >= 0) return index;
  headers.push(SHEET_FACILITY_HEADER);
  return headers.length - 1;
}

function sheetHeaderIndex(headers, name) {
  return headers.findIndex(header => String(header || '').trim() === name);
}

function alignSheetRow(sourceHeaders, targetHeaders, row) {
  const sourceIndex = new Map(sourceHeaders.map((header, index) => [String(header || '').trim(), index]));
  return targetHeaders.map(header => {
    const index = sourceIndex.get(String(header || '').trim());
    return index === undefined ? '' : row[index];
  });
}

function firstSheetHeaders(branchSources, sheetName) {
  for (const source of branchSources) {
    const sheet = source.sheets[sheetName];
    if (Array.isArray(sheet) && Array.isArray(sheet[0])) return sheet[0].slice();
  }
  return null;
}

function mergeEntitySheet(branchSources, sheetName, codeHeader, additiveHeaders = [], options = {}) {
  const targetHeaders = firstSheetHeaders(branchSources, sheetName);
  if (!targetHeaders) return [];
  const codeIndex = sheetHeaderIndex(targetHeaders, codeHeader);
  // Khach gop theo TEN (ma khach khac nhau giua hai co so): dong khong co ten van
  // giu duoc bang cach roi ve ma. Cot "Cơ sở" cua dong gop = cac co so cua no.
  const fallbackCodeIndex = options.fallbackCodeHeader ? sheetHeaderIndex(targetHeaders, options.fallbackCodeHeader) : -1;
  const branchIndex = options.branchHeader ? ensureFacilityHeader(targetHeaders) : -1;
  const codesByBranchHeader = options.codesByBranchHeader || '';
  // Cot cong don van giu tong hai co so, kem 1 cot phu JSON { 'Hà Nội': x, 'Sài Gòn': y } de tach theo co so.
  const sumByBranchHeader = options.sumByBranchHeader || '';
  const sumByBranchOutputHeader = options.sumByBranchOutputHeader || '';
  const sumByBranchIndex = sumByBranchHeader ? sheetHeaderIndex(targetHeaders, sumByBranchHeader) : -1;
  const additiveIndexes = new Map(additiveHeaders.map(header => [header, sheetHeaderIndex(targetHeaders, header)]));
  const costIndex = options.weightedInventoryCost ? sheetHeaderIndex(targetHeaders, 'Giá vốn') : -1;
  const stockIndex = options.weightedInventoryCost ? sheetHeaderIndex(targetHeaders, 'Tồn kho') : -1;
  const entities = new Map();

  branchSources.forEach(source => {
    const sheet = source.sheets[sheetName];
    if (!Array.isArray(sheet) || !Array.isArray(sheet[0])) return;
    const sourceHeaders = sheet[0];
    for (let index = 1; index < sheet.length; index += 1) {
      const aligned = alignSheetRow(sourceHeaders, targetHeaders, sheet[index] || []);
      const primaryCode = String(aligned[codeIndex] || '').trim();
      const fallbackCode = fallbackCodeIndex >= 0 ? String(aligned[fallbackCodeIndex] || '').trim() : '';
      if (!primaryCode && !fallbackCode) continue;
      const key = primaryCode ? normalizeSearchValue(primaryCode) : 'code:' + normalizeSearchValue(fallbackCode);
      if (!entities.has(key)) {
        entities.set(key, {
          row: new Array(targetHeaders.length).fill(''),
          sums: new Map(additiveHeaders.map(header => [header, 0])),
          inventoryValue: 0,
          branches: [],
          codesByBranch: {},
          sumByBranch: {}
        });
      }
      const entity = entities.get(key);
      const rowBranch = branchIndex >= 0 ? String(aligned[branchIndex] || source.branch || '').trim() : '';
      if (rowBranch && !entity.branches.includes(rowBranch)) entity.branches.push(rowBranch);
      if (sumByBranchIndex >= 0 && rowBranch) {
        entity.sumByBranch[rowBranch] = (entity.sumByBranch[rowBranch] || 0) + (Number(aligned[sumByBranchIndex]) || 0);
      }
      const rowCode = fallbackCodeIndex >= 0 ? fallbackCode : primaryCode;
      if (rowCode && rowBranch && !entity.codesByBranch[rowBranch]) entity.codesByBranch[rowBranch] = rowCode;
      aligned.forEach((value, columnIndex) => {
        if ((entity.row[columnIndex] === '' || entity.row[columnIndex] == null) && value !== '' && value != null) {
          entity.row[columnIndex] = value;
        }
      });
      additiveHeaders.forEach(header => {
        const columnIndex = additiveIndexes.get(header);
        entity.sums.set(header, entity.sums.get(header) + (Number(aligned[columnIndex]) || 0));
      });
      if (costIndex >= 0 && stockIndex >= 0) {
        entity.inventoryValue += Math.max(Number(aligned[stockIndex]) || 0, 0) * Math.max(Number(aligned[costIndex]) || 0, 0);
      }
    }
  });

  const rows = Array.from(entities.values()).map(entity => {
    additiveHeaders.forEach(header => {
      const columnIndex = additiveIndexes.get(header);
      if (columnIndex >= 0) entity.row[columnIndex] = entity.sums.get(header);
    });
    if (costIndex >= 0 && stockIndex >= 0) {
      const positiveStock = Math.max(Number(entity.row[stockIndex]) || 0, 0);
      if (positiveStock > 0) entity.row[costIndex] = entity.inventoryValue / positiveStock;
    }
    if (branchIndex >= 0 && entity.branches.length) entity.row[branchIndex] = entity.branches.join(', ');
    if (codesByBranchHeader) entity.row.push(JSON.stringify(entity.codesByBranch));
    if (sumByBranchOutputHeader) entity.row.push(JSON.stringify(entity.sumByBranch));
    return entity.row;
  });
  const extraHeaders = [codesByBranchHeader, sumByBranchOutputHeader].filter(Boolean);
  return [extraHeaders.length ? [...targetHeaders, ...extraHeaders] : targetHeaders, ...rows];
}

function mergeTransactionalSheet(branchSources, sheetName) {
  const targetHeaders = firstSheetHeaders(branchSources, sheetName);
  if (!targetHeaders) return [];
  const branchIndex = sheetHeaderIndex(targetHeaders, 'Chi nhánh');
  const facilityIndex = ensureFacilityHeader(targetHeaders);
  const rows = [];
  branchSources.forEach(source => {
    const sheet = source.sheets[sheetName];
    if (!Array.isArray(sheet) || !Array.isArray(sheet[0])) return;
    for (let index = 1; index < sheet.length; index += 1) {
      const aligned = alignSheetRow(sheet[0], targetHeaders, sheet[index] || []);
      if (branchIndex >= 0) aligned[branchIndex] = source.branch;
      if (facilityIndex >= 0) aligned[facilityIndex] = source.branch;
      rows.push(aligned);
    }
  });
  return [targetHeaders, ...rows];
}

function concatenateSheet(branchSources, sheetName) {
  const targetHeaders = firstSheetHeaders(branchSources, sheetName);
  if (!targetHeaders) return [];
  const rows = [];
  branchSources.forEach(source => {
    const sheet = source.sheets[sheetName];
    if (!Array.isArray(sheet) || !Array.isArray(sheet[0])) return;
    for (let index = 1; index < sheet.length; index += 1) {
      rows.push(alignSheetRow(sheet[0], targetHeaders, sheet[index] || []));
    }
  });
  return [targetHeaders, ...rows];
}

// Quy tac gop thuc the theo ma (cot cong don, gia von binh quan theo ton kho) —
// dung chung cho man hinh (mergeDashboardSheets) va xuat Excel (mergeEntityRows).
// Hang hoa KHONG con gop: cung ma o hai co so la hai dong rieng kem cot "Cơ sở"
// (xem mergeTransactionalSheet). Khach gop theo TEN (ma khac nhau giua hai co so).
const ENTITY_MERGE_SPECS = {
  [CONFIG.SHEET_CUSTOMERS]: {
    codeHeader: 'Tên khách hàng',
    additiveHeaders: ['Nợ hiện tại', 'Tổng bán', 'Tổng doanh thu'],
    options: {
      fallbackCodeHeader: 'Mã khách hàng',
      branchHeader: SHEET_FACILITY_HEADER,
      codesByBranchHeader: CUSTOMER_CODES_HEADER,
      sumByBranchHeader: 'Nợ hiện tại',
      sumByBranchOutputHeader: CUSTOMER_DEBT_BY_BRANCH_HEADER
    }
  },
  [CONFIG.SHEET_CATEGORIES]: { codeHeader: 'Mã nhóm hàng', additiveHeaders: [], options: {} }
};

/**
 * Gop cac dong thuc the (san pham/khach) cua nhieu co so vat ly theo ma —
 * `branchSources` = [{ branch, sheets: { [sheetName]: [header, ...rows] } }].
 * Tra ve [header, ...rows] (hoac null neu sheet khong co quy tac gop thuc the).
 */
function mergeEntityRows(branchSources, sheetName) {
  const spec = Object.prototype.hasOwnProperty.call(ENTITY_MERGE_SPECS, sheetName) ? ENTITY_MERGE_SPECS[sheetName] : null;
  if (!spec) return null;
  return mergeEntitySheet(branchSources, sheetName, spec.codeHeader, spec.additiveHeaders, spec.options);
}

function mergeDashboardSheets(branchSources) {
  const sheetNames = new Set(branchSources.flatMap(source => Object.keys(source.sheets || {})));
  const merged = {};
  sheetNames.forEach(sheetName => {
    if ([CONFIG.SHEET_PRODUCTS, CONFIG.SHEET_INVOICES, CONFIG.SHEET_ORDERS, CONFIG.SHEET_RETURNS, CONFIG.SHEET_INVOICE_DETAILS].includes(sheetName)) {
      merged[sheetName] = mergeTransactionalSheet(branchSources, sheetName);
    } else if (Object.prototype.hasOwnProperty.call(ENTITY_MERGE_SPECS, sheetName)) {
      merged[sheetName] = mergeEntityRows(branchSources, sheetName);
    } else {
      merged[sheetName] = concatenateSheet(branchSources, sheetName);
    }
  });
  return merged;
}

function mergeRollupRows(branchSources, field, keyOf, additiveFields, sort) {
  const merged = new Map();
  branchSources.forEach(source => {
    const rows = source.rollups[field] || [];
    rows.forEach(row => {
      const key = keyOf(row);
      if (!merged.has(key)) merged.set(key, { ...row });
      else {
        const target = merged.get(key);
        additiveFields.forEach(additiveField => {
          target[additiveField] = (Number(target[additiveField]) || 0) + (Number(row[additiveField]) || 0);
        });
        if (
          (!target.name && row.name) ||
          (target._hasDisplayName === false && row._hasDisplayName === true)
        ) {
          target.name = row.name;
          if (row._hasDisplayName === true) target._hasDisplayName = true;
        }
      }
    });
  });
  const rows = Array.from(merged.values());
  if (sort) rows.sort(sort);
  return rows;
}

function mergeDashboardRollups(branchSources) {
  const invoiceQuantityRows = branchSources.flatMap(source =>
    (source.rollups.invoiceQuantityRows || []).map(row => ({ ...row, branch: source.branch }))
  );

  return {
    overviewRevenueRows: mergeRollupRows(
      branchSources,
      'overviewRevenueRows',
      row => row.dateKey,
      ['revenue', 'grossRevenue', 'returnAmount', 'returnCount', 'invoiceCount', ...REVENUE_BRANCH_FIELDS],
      (a, b) => (parseSheetDate(a.dateKey)?.getTime() || 0) - (parseSheetDate(b.dateKey)?.getTime() || 0)
    ),
    invoicesRevenueRows: mergeRollupRows(
      branchSources,
      'invoicesRevenueRows',
      row => row.dateKey,
      ['revenue', 'grossRevenue', 'returnAmount', 'returnCount', 'invoiceCount', ...REVENUE_BRANCH_FIELDS],
      (a, b) => (parseSheetDate(a.dateKey)?.getTime() || 0) - (parseSheetDate(b.dateKey)?.getTime() || 0)
    ),
    invoiceQuantityRows
  };
}


const DASHBOARD_RESULT_CACHE_TTL_MS = DASHBOARD_SHEETS_CACHE_TTL_MS; // ket qua tinh toan khong the "tuoi" hon du lieu tho dung de tinh ra no
const DASHBOARD_RESULT_CACHE_MAX_ENTRIES = 32; // chan bo nho: filters den tu query string nen so bo loc khac nhau la khong gioi han
let dashboardResultCache = new Map(); // key: `${branch}|${sheetsVersion}|${JSON.stringify(filters)}` -> { data, expiresAt }
// Gop nhieu request TRUNG cacheKey toi gan nhu cung luc thanh 1 lan fetch
// rollup + compute (single-flight) — xem cach dung trong getDashboardData().
let dashboardResultInflight = new Map(); // cacheKey -> Promise<data>
let computeCallCountForTest = 0; // chi dung trong test, xem __test__ o cuoi file

// Co so + tap tab (plan.key) nam TRONG key (khong phai Map rieng) de mot key cu
// the luon thuoc dung mot co so va mot tap tab — hai co so co the trung
// sheetsVersion nhung khong bao gio trung key. `dashboardResultScope` la tien to
// dung de don cac phien ban CU cua chinh tap tab do (xem getDashboardData).
function dashboardResultScope(branch, plan) {
  return (branch || BRANCHES.HANOI) + '|' + plan.key + '|';
}

function dashboardResultCacheKey(branch, plan, sourceVersions, filters) {
  return dashboardResultScope(branch, plan) + sourceVersions + '|' + JSON.stringify(filters || {});
}

/**
 * Goi song song toan bo du lieu tu dashboardRollupRepository.js can cho
 * computeDashboardData() — thay cho viec quet "Chi tiết hóa đơn"
 * trong Node.js. KHONG co cache rieng o day (moi bang rollup da nho + co
 * index, ban than Postgres du nhanh); getDashboardData() CHI goi ham nay SAU
 * khi da tra dashboardResultCache va bi mien (cache trung thi ham nay khong
 * duoc goi — xem versionTag/cacheKey trong getDashboardData).
 *
 * `plan` (tu resolveViewPlan): CHI chay cac truy van tab dang xem can — cac
 * truy van con lai tra undefined (computeDashboardData da co gia tri mac dinh
 * `|| []`), vd tab Tong quan khong phai cho getInvoiceQuantitiesByCode (~3,3s
 * khi nguoi) chi Hoa don moi can. Bo trong = du 6 truy van nhu cu.
 */
async function fetchDashboardRollups(branch, { invoicesRange }, plan) {
  const wanted = plan ? plan.rollups : new Set(ALL_ROLLUPS);
  const run = (name, load) => (wanted.has(name) ? load() : undefined);
  const invoicesBounds = rangeToDateBounds(invoicesRange);
  // Xu huong doanh thu theo ngay cua tab Tong quan dung bo loc `invoices` (chung voi bang Chi tiet giao dich).
  const overviewBounds = invoicesBounds;
  const [
    overviewRevenueRows, invoicesRevenueRows, invoiceQuantityRows
  ] = await Promise.all([
    run('overviewRevenue', () => dashboardRollupRepository.getInvoiceRevenueByDay({ branch, from: overviewBounds.from, to: overviewBounds.to })),
    run('invoicesRevenue', () => dashboardRollupRepository.getInvoiceRevenueByDay({ branch, from: invoicesBounds.from, to: invoicesBounds.to })),
    run('invoiceQuantity', () => dashboardRollupRepository.getInvoiceQuantitiesByCode({ branch, from: invoicesBounds.from, to: invoicesBounds.to }))
  ]);

  return { overviewRevenueRows, invoicesRevenueRows, invoiceQuantityRows };
}

// Rollup dang bay theo (co so, tab, khoang ngay, phien ban rollup): nhieu request nguoi
// trung nhau cung luc dung chung 1 luot truy van thay vi moi request tu chay rieng.
// CHI dung chung khi dang bay — xong la xoa, khong giu ket qua (khong phai cache).
const dashboardRollupFetchInflight = new Map();

function shareDashboardRollupFetch(branch, ranges, plan, rollupVersionSnapshot) {
  const bounds = ['invoicesRange'].map(name => rangeToDateBounds(ranges[name]));
  const key = [branch || '', plan.key, JSON.stringify(bounds), rollupVersionSnapshot].join('|');
  const existing = dashboardRollupFetchInflight.get(key);
  if (existing) return existing;
  const fetching = fetchDashboardRollups(branch, ranges, plan).finally(() => {
    if (dashboardRollupFetchInflight.get(key) === fetching) dashboardRollupFetchInflight.delete(key);
  });
  dashboardRollupFetchInflight.set(key, fetching);
  return fetching;
}

// Chi doc nguon "re" (cache trong bo nho, thuong tuc thi) — KHONG goi rollup
// (cac cau SQL rollup) o day nua. getDashboardData() chi goi fetchDashboardRollups()
// rieng, SAU khi da tra dashboardResultCache va bi mien (xem Task 1.1).
// `plan` quyet dinh bang nguon nao duoc doc. Tab Cong no doc rieng qua
// debtScheduleService (xem getDashboardData), khong dung bang nguon core.
async function loadDashboardBaseSources(branch, physicalBranch = branch || BRANCHES.HANOI, plan = resolveViewPlan()) {
  const sheets = await getCachedDashboardCoreSources(branch, plan.coreKeys);
  return { branch: physicalBranch, sheets };
}

function dashboardSourceVersion(branch, plan) {
  // Phien ban cong no tang moi lan ghi phan hoi/trang thai/lich TT hoac co ban chot moi.
  const debtPart = plan.needsDebt ? `d${debtScheduleRepository.getDebtScheduleRepository().getVersion()}` : '-';
  return `${branch}:${dashboardCoreSourcesVersion(branch, plan.coreKeys)}:${debtPart}`;
}

/**
 * Ham chinh lay du lieu cho dashboard — wrapper them cache ket qua da tinh
 * theo tung bo loc, tranh chay lai toan bo tinh toan ben duoi khi client doi
 * tab/poll lai voi CUNG bo loc trong luc du lieu tho (dashboardCoreSheetsCache)
 * chua het han.
 * @param {Object} filters - xem computeDashboardData
 * @param {Object} [options]
 * @param {string[]} [options.views] - chi doc/tinh/tra cac tab nay ('overview' |
 *   'products' | 'invoices' | 'debt'); bo trong =
 *   ca 5 tab nhu truoc day (xem dashboardViews.js). Cache ket qua tach rieng theo
 *   tap tab + chi theo cac bo loc tab do dung.
 * @returns {Object} Du lieu KPI, bieu do, bang xep hang cho dashboard
 */
async function getDashboardData(filters, branch, viewer, options) {
  // Dien san bo loc rieng tung bang (fallback ve bo loc cha) truoc khi tinh cache
  // key — khoang ngay khac nhau khong bao gio dung chung 1 ket qua cache.
  const f = withTableFilterFallbacks(filters);
  // Chup rollupVersion NGAY DAU HAM (truoc moi await): neu rollup doi phien ban trong luc
  // doc nguon/rollup, ket qua tinh xong van duoc luu duoi khoa cu (versionTag), chi lang phi
  // 1 lan tinh, khong bao gio luu du lieu cu duoi khoa moi.
  const rollupVersionAtStart = rollupVersion;
  const plan = resolveViewPlan(options && options.views);
  const requestedBranch = branch || BRANCHES.HANOI;
  const branchScope = resolveBranchScope(requestedBranch);
  if (!branchScope.length) {
    const error = new Error(`Cơ sở không hợp lệ: ${branch}`);
    error.code = 'INVALID_BRANCH';
    error.statusCode = 400;
    throw error;
  }
  const now = new Date();
  // (Bo loc rieng `overview` (ov*) da bo 2026-10-05: tab Tong quan dung bo loc `invoices`.)
  const invoicesRange = resolveFilterRange(f.invoices, now);
  const ranges = { invoicesRange };
  // sourceArguments[i] la tham so branch thuc su truyen cho pgReader/rollup —
  // dung lai y het cho ca loadDashboardBaseSources va fetchDashboardRollups
  // ben duoi de tranh lech logic giua 2 cho.
  const sourceArguments = branchScope.map(physicalBranch =>
    (branch == null && branchScope.length === 1 ? undefined : physicalBranch)
  );
  // Cache nguon nguoi/qua cu (vd sang som, sau khi server khoi dong lai): phai cho doc Postgres
  // nen ket qua chac chan khong trung cache -> chay rollup song song voi viec doc bang nguon.
  // Khi cache nguon con han thi KHONG chay som: co the trung dashboardResultCache (xem Task 1.1).
  const earlyRollups = plan.rollups.size && branchScope.some((physicalBranch, index) =>
    dashboardCoreSourcesNeedBlockingFetch(sourceArguments[index], plan.coreKeys)
  )
    ? branchScope.map((physicalBranch, index) =>
      shareDashboardRollupFetch(sourceArguments[index], ranges, plan, rollupVersionAtStart))
    : null;
  // Loi cua rollup chay som duoc nem lai khi ket qua that su can (trong computing ben duoi);
  // ngan "unhandled rejection" neu request nay khong toi buoc do (vd gop vao request dang tinh).
  if (earlyRollups) earlyRollups.forEach(promise => promise.catch(() => {}));
  const branchSources = await Promise.all(branchScope.map((physicalBranch, index) =>
    loadDashboardBaseSources(sourceArguments[index], physicalBranch, plan)
  ));
  const sourceVersions = branchScope.map(physicalBranch => dashboardSourceVersion(physicalBranch, plan)).join(';');
  // Tab khong dung rollup (Cong no) khong bi het hieu luc khi rollup doi.
  const versionTag = sourceVersions + (plan.rollups.size ? ':r' + rollupVersionAtStart : '');
  // Quyen sua tung cot cong no khac nhau theo nguoi xem -> nam trong khoa cache.
  const editTag = plan.needsDebt ? debtScheduleService.debtAccessTag(viewer) : 'n';
  const cacheKey = dashboardResultCacheKey(requestedBranch, plan, `${versionTag}:${editTag}`, pickFilters(f, plan));

  const cached = dashboardResultCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }

  // Nhieu request TRUNG cacheKey toi gan nhu cung luc (vd moi tab trinh duyet
  // dang mo nhan SSE 'dashboard-updated' roi tu goi lai /api/dashboard cung
  // bo loc) -> gop lai thanh 1 lan fetch rollup + compute duy nhat, tranh moi
  // request tu chay rieng roi dong pool ket noi DB (xem Task 1.2).
  const inflight = dashboardResultInflight.get(cacheKey);
  if (inflight) return inflight;

  const computing = (async () => {
    // Du lieu tho hoac rollup da sang phien ban moi -> moi ket qua cache cu deu
    // tinh tu du lieu cu, don sach de Map khong phinh vo han qua nhieu phien ban.
    // Chi don entry CUA CHINH CO SO + TAP TAB nay (tien to `${branch}|${tab}|`) —
    // entry cua co so/tab khac co vong doi rieng.
    const scopePrefix = dashboardResultScope(requestedBranch, plan);
    for (const key of dashboardResultCache.keys()) {
      if (key.startsWith(scopePrefix) && !key.startsWith(scopePrefix + versionTag + ':')) {
        dashboardResultCache.delete(key);
      }
    }

    // Cache ket qua mien -> gio moi goi rollup (toi da 7 cau SQL/co so). Gan thang
    // vao tung branchSource (object moi tao rieng cho request nay, khong phai
    // object dung chung tu cache) de giu dung shape ma computeDashboardData/
    // mergeDashboardSheets/mergeDebtManagementSources/mergeDashboardRollups
    // dang mong doi (doc branchSources[i].rollups).
    await Promise.all(branchSources.map((source, index) =>
      (earlyRollups ? earlyRollups[index] : fetchDashboardRollups(sourceArguments[index], ranges, plan)).then(rollups => {
        source.rollups = tagRollupBranch(rollups, source.branch);
      })
    ));

    // Cong no: moi dong la (co so, khach) nen "Cả hai" chi la ghep dong cua 2 co so.
    const debtManagement = plan.has('debt')
      ? await debtScheduleService.buildDebtManagement(branchScope, viewer)
      : undefined;
    let data;
    if (branchSources.length === 1) {
      const source = branchSources[0];
      data = computeDashboardData(source.sheets, f, now, source.branch, source.rollups, debtManagement, plan);
    } else {
      data = computeDashboardData(
        mergeDashboardSheets(branchSources),
        f,
        now,
        BRANCH_BOTH,
        mergeDashboardRollups(branchSources),
        debtManagement,
        plan
      );
    }
    dashboardResultCache.set(cacheKey, { data, expiresAt: Date.now() + DASHBOARD_RESULT_CACHE_TTL_MS });
    // Gioi han so entry trong Map — Map giu thu tu insertion nen phan tu dau tien
    // luon la entry cu nhat, xoa dan cho toi khi ve lai duoi muc tran.
    while (dashboardResultCache.size > DASHBOARD_RESULT_CACHE_MAX_ENTRIES) {
      dashboardResultCache.delete(dashboardResultCache.keys().next().value);
    }
    return data;
  })().finally(() => {
    // Loi (fetch rollup hoac compute nem loi) TU LAN ra ngoai cho moi nguoi
    // dang cho tai day — khong bat loi de cache, giu dung hanh vi hien tai
    // (lan sau se tu thu lai tu dau vi entry inflight da bi xoa).
    if (dashboardResultInflight.get(cacheKey) === computing) dashboardResultInflight.delete(cacheKey);
  });
  dashboardResultInflight.set(cacheKey, computing);
  return computing;
}

/**
 * Tinh toan toan bo du lieu dashboard tu du lieu tho da doc (sheets) va bo
 * loc. Ham thuan (khong tu fetch, khong cache) de getDashboardData ben tren
 * co the cache ket qua theo (phien ban du lieu tho + bo loc).
 * @param {Object} sheets - map ten sheet -> mang 2 chieu, tu getCachedDashboardSheets()
 * @param {Object} filters - Bo loc rieng cho tung tab. Moi bo loc thoi gian co
 *   dang { mode: 'days'|'range'|'all', days?, from?, to? }; products co them
 *   (chi hang "Đang kinh doanh" duoc tinh, khong con bo loc trang thai).
 * @param {Date} now
 * @returns {Object} Du lieu KPI, bieu do, bang xep hang cho dashboard
 */
function computeDashboardData(sheets, filters, now, branch, rollups, debtManagementOverride, plan) {
  computeCallCountForTest += 1;
  // `plan` (dashboardViews.resolveViewPlan): chi tinh phan cua cac tab duoc chon.
  // Bang nguon/rollup cua tab khac KHONG duoc nap (xem `|| []` ben duoi) nen cac
  // vong lap tren chung la no-op; chi mot so khoi ton kem/khong an toan khi thieu
  // du lieu (cong no, top khach, chi tiet giao dich) can guard bang plan.has().
  const view = plan || resolveViewPlan();
  const f = withTableFilterFallbacks(filters);
  rollups = rollups || {};

  const invoicesRange = resolveFilterRange(f.invoices, now);

  const debtManagement = !view.has('debt') ? undefined : debtManagementOverride;

  const invData = sheets[CONFIG.SHEET_INVOICES] || [];
  // "Chi tiết hóa đơn" KHONG con doc tu `sheets` o day — tab nang nhat, da bo
  // khoi cache "core" (xem getCachedDashboardCoreSources()) va duoc thay bang
  // dashboardRollupRepository.js qua tham so `rollups`.
  // (Bang "Đặt hàng" khong con doc o day: don dat hang "Phieu tam" nay hien o trang Vong doi don hang.)
  const singleBranch = branch && branch !== BRANCH_BOTH ? branch : '';

  // ---------- HÓA ĐƠN: index 1 lần, dùng lại cho mọi bộ lọc ----------
  // Cột: [0]Mã hóa đơn [1]Ngày bán [2]Khách hàng [3]SĐT khách [4]Nhân viên bán [5]Chi nhánh [6]Tổng tiền hàng [7]Giảm giá [8]Khách đã trả [9]Trạng thái
  // Tong so luong tung hoa don de bao cao co cot SL nhu KiotViet — truy van
  // rieng, gioi han theo invoicesRange (dashboardRollupRepository truy van
  // truc tiep invoice_details/invoices, KHONG dung "Chi tiết hóa đơn" da bo
  // khoi cache "core"; xem fetchDashboardRollups()).
  const invoiceQuantityMap = new Map();
  ((rollups && rollups.invoiceQuantityRows) || []).forEach(row => {
    const code = String(row.code || '').trim();
    invoiceQuantityMap.set(row.branch ? invoiceIdentity(row.branch, code) : code, row.quantity);
  });

  const invoiceRecords = [];
  const invoiceHeaders = invData[0] || [];
  const invoiceBranchIndex = sheetHeaderIndex(invoiceHeaders, 'Chi nhánh');
  const invoiceFacilityIndex = sheetHeaderIndex(invoiceHeaders, SHEET_FACILITY_HEADER);

  for (let r = 1; r < invData.length; r++) {
    const row = invData[r];
    const code = row[0];
    if (!code) continue;
    const customer = row[2];
    const phone = row[3];
    const employee = row[4];
    const total = Number(row[6]) || 0;
    const discount = Number(row[7]) || 0;
    const paid = Number(row[8]) || 0;
    const status = row[9] || 'Hoàn thành';
    const isCancelled = status === 'Đã hủy';
    const isCompleted = status === 'Hoàn thành';
    const dt = parseSheetDate(row[1]);
    const dateKey = dt ? dmyKey(dt) : '';

    const record = {
      code,
      branch: (invoiceFacilityIndex >= 0 && row[invoiceFacilityIndex])
        || (branch === BRANCH_BOTH ? row[invoiceBranchIndex] || '' : singleBranch),
      customer,
      phone,
      employee,
      total,
      discount,
      paid,
      status,
      time: row[1] || '',
      isCancelled,
      isCompleted,
      _dt: dt,
      _dateKey: dateKey,
      _sortTime: dt ? dt.getTime() : 0
    };
    invoiceRecords.push(record);
  }

  // Doanh thu theo ngay cua tab Tong quan/Hoa don — tu daily_invoice_summary
  // (hoa don Hoan thanh TRU tien tra hang = doanh thu thuc te, xem dashboardRollupRepository.getInvoiceRevenueByDay())
  // thay vi tu gom lai `invoiceRecords` trong JS moi request.
  const overviewPeriod = buildRevenuePeriodFromRollup(invoicesRange, (rollups && rollups.overviewRevenueRows) || []);
  const transactionsReport = view.has('invoices')
    ? buildTransactionsReport(invoicesRange, invoiceRecords, invoiceQuantityMap)
    : undefined;

  const invoicesPeriod = buildRevenuePeriodFromRollup(invoicesRange, (rollups && rollups.invoicesRevenueRows) || []);
  const periodCancelledInvoices = (view.has('invoices') || view.has('overview'))
    ? invoiceRecords.filter(record => record.isCancelled && isWithinRange(record._dt, invoicesRange)).length
    : 0;

  // (2026-10-05: the chi so "Trả hàng" cua tab Hoa don — invoices.returnsCount/totalReturns — da go vi
  // giao dien khong dung. Doanh thu van = ban − tra hang, tinh tu rollup daily_invoice_summary, khong
  // phu thuoc vong lap nay.)

  // Ban day du (shape cu). pickPayload() giu nguyen khi chay du 5 tab, cat ve
  // dung phan cua tab duoc chon khi chay theo tung tab (dashboardViews.js).
  const result = {
    updatedAt: formatDMYHMS(now),
    filters: {
      invoices: invoicesRange
    },
    // (2026-10-16: bo cac chi so KPI hang hoa/khach hang — giao dien khong con dung; giu khoa rong cho dung shape.)
    kpi: {},
    overview: {
      revenueByDay: overviewPeriod.revenueByDay,
      periodRevenue: overviewPeriod.periodRevenue,
      periodGrossRevenue: overviewPeriod.periodGrossRevenue,
      periodReturnAmount: overviewPeriod.periodReturnAmount,
      periodInvoices: overviewPeriod.periodInvoices,
      periodCancelledInvoices
    },
    invoices: {
      revenueByDay: invoicesPeriod.revenueByDay,
      periodRevenue: invoicesPeriod.periodRevenue,
      periodReturnAmount: invoicesPeriod.periodReturnAmount,
      periodInvoices: invoicesPeriod.periodInvoices,
      periodCancelledInvoices,
      transactionsReport
    },
    debtManagement
  };
  return pickPayload(result, view);
}

/**
 * Nap san cache "nguon re" (cac tab core) cho MOI co so
 * vat ly, goi 1 lan luc server khoi dong (xem server/index.js) de nguoi dung
 * dau tien sau restart/redeploy khong phai cho doc 7 tab (~13.5s). Duyet
 * TUAN TU (khong Promise.all) — tranh chiem pool ket noi Postgres dung luc
 * luot sync khoi dong (neu KIOTVIET_SYNC_ENABLED) cung dang chay. Loi tung co
 * so chi log, khong nem — co so chua cau hinh nguon du lieu khong duoc lam
 * crash server.
 */
async function prewarmDashboardCaches({ log } = {}) {
  const logFn = typeof log === 'function' ? log : () => {};
  for (const physicalBranch of resolveBranchScope(BRANCH_BOTH)) {
    try {
      await getCachedDashboardCoreSources(physicalBranch, ALL_CORE_KEYS);
      logFn(`[Dashboard] Prewarm xong cho co so ${physicalBranch}`);
    } catch (err) {
      logFn(`[Dashboard] Prewarm loi cho co so ${physicalBranch}, bo qua: ${err.message}`);
    }
  }
}

module.exports = {
  queryTransactionsReport, queryCustomerProductReport,
  getDashboardData,
  getCustomerDirectory,
  searchCustomerDirectory,
  getCustomerProductRevenueReport,
  mergeEntityRows,
  prewarmDashboardCaches,
  // Cac hook duoi day CHI phuc vu test (dashboardData.test.js) — khong dung
  // trong code san pham.
  __test__: {
    resetCaches() {
      dashboardSheetsCacheByBranch = new Map();
      dashboardCoreSheetsCacheByBranch = new Map();
      customerDirectoryCacheByBranch = new Map();
      dashboardResultCache = new Map();
      dashboardResultInflight = new Map();
      computeCallCountForTest = 0;
      invoicesChangedSinceExpiry = false;
      invoiceCacheGeneration = 0;
    },
    // Cache "core" (7/9 tab) — dung cho getDashboardData() (kem xuat Excel qua exportService.js).
    expireSheetsCache(branch) {
      forEachDashboardCoreEntry(branch, entry => { entry.expiresAt = 0; });
    },
    // Khac expireSheetsCache(): dat "vua qua han" (con trong cua so
    // DASHBOARD_SHEETS_MAX_STALE_MS) de test duong stale-while-revalidate —
    // expireSheetsCache() dat expiresAt=0 lam cache qua han QUA LAU (roi vao
    // nhanh phai cho fetch that, khac hanh vi can test o day).
    expireSheetsCacheSoftly(branch) {
      forEachDashboardCoreEntry(branch, entry => { entry.expiresAt = Date.now() - 1000; });
    },
    // Chi het han cac bang nguon duoc chi dinh (test cache theo tung bang).
    expireCoreSources(branch, keys, soft = false) {
      keys.forEach(key => {
        dashboardCoreEntry(branch, key).expiresAt = soft ? Date.now() - 1000 : 0;
      });
    },
    // Cache "full" (9 tab) — nhanh du phong cua getCustomerProductRevenueReport.
    expireFullSheetsCache(branch) {
      dashboardSheetsCacheFor(branch).expiresAt = 0;
    },
    expireFullSheetsCacheSoftly(branch) {
      dashboardSheetsCacheFor(branch).expiresAt = Date.now() - 1000;
    },
    // Ban nhanh va ban Intl chuan cua getDashboardDateParts — test doi chieu 2 ban.
    dateParts: getDashboardDateParts,
    datePartsIntl: getDashboardDatePartsIntl,
    getComputeCallCount: () => computeCallCountForTest,
    getResultCacheSize: () => dashboardResultCache.size
  }
};
