'use strict';

// Doc bang product_report ("Bao cao hang hoa", tab Tong quan) - bang duoc
// tinh san 1 lan/dem boi server/kiotvietSync/productReportRefresh.js
// (server/db/migrations/0018_product_report.sql). Repository nay CHI doc, ap
// dung cho ca route GET va luong xuat Excel (exportService.js) de khong viet
// trung logic map cot o 2 noi.
const { getPool } = require('../db/pool');
const { timedQuery, timedOperation } = require('../lib/requestTiming');
const { readContainerSummary, getContainerMeta } = require('../productContainers/repository');
const { normalizeCode } = require('../productContainers/parser');
const { readInTransitByCode } = require('./inTransitSource');
const { readTransferRequestByCode } = require('./transferRequestSource');

// NULL = dong chua duoc tinh lai sau migration 0057 -> null (giao dien hien "—"), khong gia thanh 0.
function nullableNumber(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Cac truong lien quan GIA: route /api/product-report va xuat Excel/HTML boc bo khi tai khoan khong co quyen
// reports.products.price (don gia + gia tri co ban = co ban x don gia).
const PRODUCT_REPORT_PRICE_KEYS = Object.freeze(['priceHanoi', 'priceSaigon', 'availableValueHanoi', 'availableValueSaigon']);

// Truong DOANH SO / MO TA (chia doanh so cho so luong ra duoc don gia; Mo ta thuong ghi bang gia): boc bo khi thieu quyen
// reports.products.sales (Nhan vien marketing mac dinh khong co).
const PRODUCT_REPORT_SALES_KEYS = Object.freeze(['revenue90d', 'topCustomerRevenue90d', 'topCustomerShare', 'descriptionHanoi', 'descriptionSaigon']);

function mapRow(row) {
  return {
    code: row.product_code,
    name: row.product_name,
    stockHanoi: Number(row.stock_hanoi) || 0,
    stockSaigon: Number(row.stock_saigon) || 0,
    // "Co ban" tung co so (ton thuc - Phieu tam cua co so do); cong hai cot = available_to_sell luu san.
    availableHanoi: nullableNumber(row.available_hanoi),
    availableSaigon: nullableNumber(row.available_saigon),
    // Truong "Mo ta" cua san pham tren KiotViet (nhan vien ghi bang gia cho sale tra cuu).
    descriptionHanoi: row.description_hanoi || '',
    descriptionSaigon: row.description_saigon || '',
    // "Don gia" tung co so (products.base_price); chi route /api/product-report moi tra cho tai khoan co quyen xem gia.
    priceHanoi: nullableNumber(row.price_hanoi),
    priceSaigon: nullableNumber(row.price_saigon),
    availableToSell: Number(row.available_to_sell) || 0,
    qtySold30d: Number(row.qty_sold_30d) || 0,
    // SL ban 30 ngay theo co so + SL don 30/90 ngay (migration 0067); NULL = chua tinh lai => null ("—" tren giao dien).
    qtySold30dHanoi: nullableNumber(row.qty_sold_30d_hanoi),
    qtySold30dSaigon: nullableNumber(row.qty_sold_30d_saigon),
    orders30d: nullableNumber(row.orders_30d),
    orders90d: nullableNumber(row.orders_90d),
    // "Dut HN / Dut SG" = tong so ngay dut hang 30 ngay gan nhat (bang product_stockout_days); luon la so, mac dinh 0.
    stockoutDaysHanoi: Number(row.stockout_days_hanoi) || 0,
    stockoutDaysSaigon: Number(row.stockout_days_saigon) || 0,
    revenue90d: Number(row.revenue_90d) || 0,
    customerCount90d: Number(row.customer_count_90d) || 0,
    topCustomerRevenue90d: Number(row.top_customer_revenue_90d) || 0,
    topCustomerName: row.top_customer_name || '',
    topCustomerShare: row.top_customer_share === null || row.top_customer_share === undefined
      ? null : Number(row.top_customer_share),
    computedAt: row.computed_at
  };
}

// Hang dang van chuyen (order_suppliers) nho (vai tram dong) nhung doi sau moi luot sync; doc lai toi da
// moi chu ky nay thay vi moi request.
const IN_TRANSIT_TTL_MS = 60 * 1000;
// Doc bao cao kem so ngay dut hang (product_stockout_days, migration 0067). Bang nay chua ton tai (42P01) =>
// tra ve truy van cu khong join, so ngay dut = 0: code chay duoc truoc khi ap migration.
const REPORT_COLUMNS_SQL = `pr.*, COALESCE(sd.days_hanoi, 0) AS stockout_days_hanoi, COALESCE(sd.days_saigon, 0) AS stockout_days_saigon`;
const STOCKOUT_JOIN_SQL = 'LEFT JOIN product_stockout_days sd ON sd.product_key = lower(btrim(pr.product_code))';
// Bang da chi giu ma dang kinh doanh (job tang dan loc is_active khi ghi) nen khong con EXISTS luc doc.
const VERSIONED_ROWS_SQL = (withStockout) => `SELECT ${withStockout ? REPORT_COLUMNS_SQL : 'pr.*'}
  FROM product_report pr ${withStockout ? STOCKOUT_JOIN_SQL : ''} ORDER BY pr.product_code`;
// Luong cu: loc trang thai hien tai khi doc de snapshot ban dem, KPI va file xuat cung chi gom ma con kinh doanh
// o it nhat mot co so. NULL giu quy uoc mac dinh dang kinh doanh nhu bao cao dut hang; khong loc theo ton/doanh so.
const LEGACY_ROWS_SQL = (withStockout) => `SELECT ${withStockout ? REPORT_COLUMNS_SQL : 'pr.*'}
  FROM product_report pr ${withStockout ? STOCKOUT_JOIN_SQL : ''}
  WHERE EXISTS (
    SELECT 1 FROM products p
    WHERE p.code = pr.product_code
      AND p.branch IN ('hanoi', 'saigon')
      AND p.is_active IS NOT FALSE
  )
  ORDER BY pr.product_code`;
async function queryReportRows(pool, buildSql) {
  try {
    return await pool.query(buildSql(true));
  } catch (error) {
    if (error.code !== '42P01') throw error;
    return pool.query(buildSql(false));
  }
}

const STATE_PROBE_SQL = 'SELECT version::text AS version, computed_at FROM product_report_state WHERE id = 1';

/**
 * Bo doc "Bao cao hang hoa". Khi co bang product_report_state (migration 0055, che do lam moi tang dan) thi
 * doc theo PHIEN BAN: 10,9K dong chi bi keo tu DB ve may chu 1 lan moi khi `version` doi (chi tang khi co dong
 * that su doi), tong CONT chi doc lai khi version CONT doi, hang van chuyen cache toi da 60 giay; nhieu nguoi
 * xem/xuat file dung chung. Chua co state => luong cu (loc is_active luc doc, khong cache).
 * Cache nam trong bo bo doc, nen moi lan goi voi pool truyen vao (test) la bo doc moi, khong dung chung.
 *
 * Nguoi doc den khi dang co luot tai thi dung chung luot do, khong tu keo them: moi lan cache trong (vua deploy, doi
 * version) ca 10,9K dong qua duong Oregon - Singapore se giu ket noi rat lau, nhieu nguoi cung keo la het pool 5 ket
 * noi va ca app xep hang (do that 2026-11-05: 101 truy van cho). Chi dung chung phan TAI; compose chay rieng cho tung
 * nguoi vi ben goi duoc sua ket qua (routes.js gan de data.rows de an cot theo quyen).
 */
function createProductReportReader({ pool, now = Date.now } = {}) {
  let rowsCache = null; // { version, rows }  - dong da map, KHONG bi sua
  let containerCache = null; // { version, totals }
  let transitCache = null; // { at, byCode }
  let transferRequestCache = null; // { at, byCode }
  let inFlight = null; // luot tai dang chay, xoa khi xong ke ca khi loi de lan sau thu lai

  async function probeState() {
    try {
      const { rows } = await pool.query(STATE_PROBE_SQL);
      return rows[0] && rows[0].version != null ? rows[0] : null;
    } catch (error) {
      if (error.code === '42P01') return null; // chua chay migration 0055
      throw error;
    }
  }

  async function readInTransit() {
    if (!transitCache || now() - transitCache.at > IN_TRANSIT_TTL_MS) {
      transitCache = { at: now(), byCode: await readInTransitByCode(pool) };
    }
    return transitCache.byCode;
  }

  // YC dieu chuyen (don Phieu tam khach "Dieu chuyen SG" tai Kiot HN): cache cung chu ky voi hang van chuyen.
  async function readTransferRequest() {
    if (!transferRequestCache || now() - transferRequestCache.at > IN_TRANSIT_TTL_MS) {
      transferRequestCache = { at: now(), byCode: await readTransferRequestByCode(pool) };
    }
    return transferRequestCache.byCode;
  }

  async function readVersioned(state) {
    if (!rowsCache || rowsCache.version !== state.version) {
      const { rows } = await timedOperation('reportRows', () => queryReportRows(pool, VERSIONED_ROWS_SQL));
      rowsCache = { version: state.version, rows: rows.map(mapRow) };
    }
    const { containerSync } = await getContainerMeta({ pool });
    let totals = {};
    if (containerSync.available) {
      if (!containerCache || containerCache.version !== containerSync.version) {
        const summary = await readContainerSummary(pool);
        containerCache = { version: summary.containerSync.version, totals: summary.totals };
      }
      totals = containerCache.totals;
    }
    const inTransitByCode = await readInTransit();
    const transferRequestByCode = await readTransferRequest();
    return { base: rowsCache.rows, computedAt: state.computed_at, containerSync, totals, inTransitByCode, transferRequestByCode };
  }

  async function load() {
    const state = await probeState();
    if (state) return { part: await readVersioned(state), reportVersion: state.version };
    return { part: await readLegacyParts(pool), reportVersion: null };
  }

  async function read() {
    if (!inFlight) inFlight = load().finally(() => { inFlight = null; });
    const { part, reportVersion } = await inFlight;
    return { ...compose(part), reportVersion };
  }

  return { read, probeState };
}

// "Ngay can dat" = (Tong co ban + Chua boc + Da boc) / SL ban 30 ngay * 30, lam tron 1 chu so thap phan (giong cot
// "Ngay can dat" cua file mau). null khi khong ban duoc ngay nao (chia cho 0) hoac chua co snapshot CONT (thieu
// Chua boc/Da boc thi so ngay se thap sai). Co the am khi hang da bi giu qua ton - khong kep ve 0.
function daysToOrder(availableToSell, unloadedQty, loadedQty, qtySold30d) {
  if (unloadedQty === null || loadedQty === null || !(qtySold30d > 0)) return null;
  // Nhan truoc roi chia: 7 / 3 * 30 ra 70.00000000000001, (7 * 30) / 3 ra dung 70.
  const days = (availableToSell + unloadedQty + loadedQty) * 30 / qtySold30d;
  return Number.isFinite(days) ? Math.round(days * 10) / 10 : null;
}

// So ngay ban het = so luong / SL ban 30 ngay * 30, lam tron 1 chu so thap phan. null khi thieu so luong hoac khong
// ban duoc ngay nao (mau so <= 0 / null). Co the am khi hang da bi giu qua ton - khong kep ve 0.
function daysOfCover(quantity, qtySold30d) {
  if (quantity === null || quantity === undefined || !(qtySold30d > 0)) return null;
  const days = quantity * 30 / qtySold30d;
  return Number.isFinite(days) ? Math.round(days * 10) / 10 : null;
}

// Cong ton co phan le (vd 16.4) hay ra 16.400000000000002; lam tron 3 chu so de web/Excel khong hien duoi thap phan thua.
function roundQuantity(value) {
  return Math.round(value * 1000) / 1000;
}

// Ghep dong goc (da cache) voi CONT + hang van chuyen thanh phan hoi; tao dong moi de khong sua cache.
function compose({ base, computedAt, containerSync, totals, inTransitByCode, transferRequestByCode = new Map() }) {
  const rows = base.map((row) => {
    const inTransit = inTransitByCode.get(normalizeCode(row.code)) || 0;
    // "YC dieu chuyen" = don Phieu tam khach Dieu chuyen SG tai Kiot HN; cong vao hai cot tong cung voi Dieu chuyen SG.
    const transferRequest = transferRequestByCode.get(normalizeCode(row.code)) || 0;
    const quantities = totals[normalizeCode(row.code)];
    // The stored base already equals sellable HN + sellable SG (on-hand less pending customer orders).
    // Add SG transit once at read time, never fold it back into the stored base.
    const availableToSell = row.availableToSell + inTransit + transferRequest;
    const unloadedQty = containerSync.available ? Number(quantities?.unloadedQty || 0) : null;
    const loadedQty = containerSync.available ? Number(quantities?.loadedQty || 0) : null;
    // Gia tri co ban = co ban x don gia CUNG co so (null neu thieu mot ve, giu so am); tang truong don =
    // SL don 30 ngay x 3 / SL don 90 ngay - 1 (30 ngay x 3 = tuong duong 90 ngay), null khi chua co SL don 90 ngay.
    const availableValue = (available, price) => (available === null || price === null ? null : roundQuantity(available * price));
    const ordersGrowth = row.orders30d === null || row.orders90d === null || !(row.orders90d > 0)
      ? null : Math.round((row.orders30d * 3 / row.orders90d - 1) * 1e6) / 1e6;
    return {
      ...row,
      inTransit,
      transferRequest,
      availableToSell: roundQuantity(availableToSell),
      // "Tong ton thuc + DC" = ton thuc HN + ton thuc SG + dieu chuyen SG + YC dieu chuyen.
      totalStock: roundQuantity(row.stockHanoi + row.stockSaigon + inTransit + transferRequest),
      unloadedQty,
      loadedQty,
      daysToOrder: daysToOrder(availableToSell, unloadedQty, loadedQty, row.qtySold30d),
      availableValueHanoi: availableValue(row.availableHanoi, row.priceHanoi),
      availableValueSaigon: availableValue(row.availableSaigon, row.priceSaigon),
      // Ngay HN / Ngay SG + DC (hang dang van chuyen ve SG) / Ngay 2 mien, moi cai chia cho SL ban 30 ngay tuong ung.
      daysHanoi: daysOfCover(row.availableHanoi, row.qtySold30dHanoi),
      daysSaigonTransit: row.availableSaigon === null ? null : daysOfCover(inTransit + row.availableSaigon, row.qtySold30dSaigon),
      daysBothBranches: daysOfCover(availableToSell, row.qtySold30d),
      ordersGrowth
    };
  });
  return { rows, computedAt, containerSync };
}

let defaultReader = null;
async function getProductReport({ pool } = {}) {
  if (pool) return createProductReportReader({ pool }).read();
  if (!defaultReader) defaultReader = createProductReportReader({ pool: getPool() });
  return defaultReader.read();
}

// Chi phien ban bao cao (nhe, 1 dong) cho /containers/meta; null neu chua co state/loi.
async function getProductReportVersion({ pool } = {}) {
  try {
    const reader = pool ? createProductReportReader({ pool }) : (defaultReader ||= createProductReportReader({ pool: getPool() }));
    const state = await reader.probeState();
    return state ? state.version : null;
  } catch {
    return null;
  }
}

async function readLegacyParts(pool) {
  const { rows } = await queryReportRows(pool, LEGACY_ROWS_SQL);
  const items = rows.map(mapRow);
  const computedAt = items.length ? items.reduce((latest, item) => (
    !latest || (item.computedAt && item.computedAt > latest) ? item.computedAt : latest
  ), null) : null;
  const { containerSync, totals } = await readContainerSummary(pool);
  const inTransitByCode = await readInTransitByCode(pool);
  const transferRequestByCode = await readTransferRequestByCode(pool);
  return { base: items, computedAt, containerSync, totals, inTransitByCode, transferRequestByCode };
}

// Khung "Chi tiet" duoi bang: doanh so 90 ngay cua tung khach da mua ma hang nay
// (bang product_report_customers, cung snapshot voi product_report - xem migration
// 0023). % = doanh so khach / TONG doanh so cac khach cua ma hang nen luon cong
// lai 100%; co the lech rat nhe so voi cot "% Khach lon nhat" vi mau so cot do la
// revenue_90d lay tu rollup daily_product_sales.
function customerPeriods(end) {
  if (!end) return [];
  const date = new Date(String(end).slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(date.getTime())) return [];
  const offset = days => new Date(date.getTime() - days * 86400000).toISOString().slice(0, 10);
  return [ ['1_30d', 'T.này'], ['31_60d', 'T.trước'], ['61_90d', 'T.trước nữa'] ]
    .map(([key, label], i) => ({ key, label, from: offset(i * 30 + 29), to: offset(i * 30) }));
}

async function getProductReportCustomers({ code, pool = getPool() } = {}) {
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!trimmed) {
    const error = new Error('Thiếu mã hàng.');
    error.statusCode = 400;
    throw error;
  }
  const { rows } = await timedQuery(pool, 'customers',
    `SELECT c.*, s.customer_window_end::text
     FROM (SELECT (SELECT customer_window_end FROM product_report_state WHERE id = 1) AS customer_window_end) s
     LEFT JOIN LATERAL (
       SELECT customer_name, revenue, revenue_1_30d, revenue_31_60d, revenue_61_90d
       FROM product_report_customers
       WHERE product_key = lower(btrim($1))
       ORDER BY revenue DESC, customer_name
     ) c ON true
     ORDER BY revenue DESC, customer_name`,
    [code]
  );
  const periods = customerPeriods(rows[0] && rows[0].customer_window_end);
  const customers = rows.filter(row => row.customer_name != null);
  const totalRevenue = customers.reduce((sum, row) => sum + (Number(row.revenue) || 0), 0);
  return {
    code: trimmed,
    totalRevenue,
    customerCount: customers.length,
    periods,
    rows: customers.map((row) => {
      const revenue = Number(row.revenue) || 0;
      return {
        customerName: row.customer_name || '',
        revenue,
        revenue1_30d: periods.length ? nullableNumber(row.revenue_1_30d) : null,
        revenue31_60d: periods.length ? nullableNumber(row.revenue_31_60d) : null,
        revenue61_90d: periods.length ? nullableNumber(row.revenue_61_90d) : null,
        share: totalRevenue > 0 ? revenue / totalRevenue : null
      };
    })
  };
}

module.exports = {
  getProductReport, getProductReportCustomers, getProductReportVersion, createProductReportReader, customerPeriods,
  PRODUCT_REPORT_PRICE_KEYS, PRODUCT_REPORT_SALES_KEYS,
  __test__: { mapRow, daysToOrder, daysOfCover }
};
