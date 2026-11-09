'use strict';

// Bang "Khach hang theo san pham" (muc 4 tab Hang hoa): MOI DONG = 1 CAP (san pham, khach) cua 90 ngay gan nhat, kem 3 ky cuon
// 30 ngay (T.nay / T.truoc / T.truoc nua), % cua SP va TANG TRUONG. Doc thang product_report_customers (lam moi tang dan sau moi luot
// sync) JOIN product_report lay ma/ten. Loc ten san pham, ten khach, nhom tang truong + sap xep + phan trang deu o SQL tren
// TOAN BO ket qua.
//   prior  = T.truoc + T.truoc nua  (= 2 x trung binh hai ky truoc)
//   growth = T.nay x 2 / prior - 1  khi prior > 0, so sanh nguong bang NUMERIC nhan cheo (khong dung so thuc):
//     lost: prior > 0 va T.nay <= 0 (<= -100%) | check: T.nay > 0 va 4 x T.nay < prior (-100%..-50%) |
//     drop: 2 x T.nay < prior (-50%..0) | up: con lai khi prior > 0 | new: prior <= 0 va T.nay > 0.
const { getPool } = require('../db/pool');
const { fuzzySqlParts } = require('../shared/fuzzySql');
const { timedQuery } = require('../lib/requestTiming');
const { customerPeriods } = require('./productReportRepository');

const GROWTH_GROUPS = Object.freeze(['all', 'lost', 'check', 'drop', 'up', 'new']);
// Khoa sap xep (whitelist) -> ten cot trong CTE g. KHONG BAO GIO noi chuoi tu nguoi dung vao SQL.
const SORT_SQL = Object.freeze({
  product_code: 'product_code', product_name: 'product_name', customer_name: 'customer_name',
  revenue: 'revenue', revenue_1_30d: 'r1', revenue_31_60d: 'r2', revenue_61_90d: 'r3', share: 'share', growth: 'growth'
});
const SORT_KEYS = Object.freeze(Object.keys(SORT_SQL));
const TEXT_SORTS = new Set(['product_code', 'product_name', 'customer_name']);
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;
const EXPORT_MAX_ROWS = 50000;

function invalid() {
  return Object.assign(new Error('Tham số báo cáo khách hàng theo sản phẩm không hợp lệ.'), { statusCode: 400 });
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw invalid();
  return Number(value);
}
// NUMERIC lay ra dang chuoi (::text) roi doi sang so; NULL giu nguyen NULL (khong bien thanh 0).
const toNumber = value => (value === null || value === undefined ? null : Number(value));

// Kiem tra bo loc + dung WHERE / ORDER BY. `add` them tham so va tra ve placeholder ($n). KHONG cham DB.
function parseFilters({ product = '', customer = '', growth = 'all', sort, dir } = {}, add) {
  if (typeof product !== 'string' || product.length > MAX_QUERY_LENGTH) throw invalid();
  if (typeof customer !== 'string' || customer.length > MAX_QUERY_LENGTH) throw invalid();
  if (typeof growth !== 'string' || !GROWTH_GROUPS.includes(growth)) throw invalid();
  if (sort !== undefined && (typeof sort !== 'string' || !SORT_KEYS.includes(sort))) throw invalid();
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') throw invalid();
  const where = [];
  const productFuzzy = fuzzySqlParts("COALESCE(g.product_code,'') || ' ' || COALESCE(g.product_name,'')", product, add);
  if (productFuzzy) where.push(productFuzzy.where);
  const customerFuzzy = fuzzySqlParts('g.customer_name', customer, add);
  if (customerFuzzy) where.push(customerFuzzy.where);
  if (growth !== 'all') where.push(`g.growth_state = '${growth}'`); // growth da nam trong whitelist o tren
  const sortKey = sort === undefined ? 'revenue' : sort;
  const direction = dir === 'asc' ? 'ASC' : dir === 'desc' ? 'DESC' : (TEXT_SORTS.has(sortKey) ? 'ASC' : 'DESC');
  // NULL luon cuoi o ca 2 chieu; hoa bang -> ma hang -> ten khach -> khoa khach de thu tu on dinh giua cac trang.
  const orderBy = alias => [
    `${alias}.${SORT_SQL[sortKey]} ${direction} NULLS LAST`,
    `${alias}.product_code ASC`, `${alias}.customer_name ASC`, `${alias}.customer_key ASC`
  ].join(', ');
  return { where: where.length ? 'WHERE ' + where.join(' AND ') : '', orderBy, sortKey, direction };
}

function validateFilters(filters) {
  parseFilters(filters, () => '$0');
}

// s = dong state (khong co cua so khach -> khong tra dong nao, available:false); tot = tong DS cua tung san pham tren
// TAT CA khach (mau so % cua SP, khong doi theo bo loc); b = cap + prior; g = them growth / growth_state.
const BASE_CTES = `WITH s AS (
    SELECT customer_window_end::text AS window_end, version::text AS version,
      to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at
    FROM product_report_state WHERE id = 1 AND customer_window_end IS NOT NULL
  ), tot AS (
    SELECT product_key, SUM(revenue) AS total FROM product_report_customers GROUP BY product_key
  ), b AS (
    SELECT pr.product_code, pr.product_name, pc.customer_key, pc.customer_name, pc.revenue,
      pc.revenue_1_30d AS r1, pc.revenue_31_60d AS r2, pc.revenue_61_90d AS r3,
      CASE WHEN tot.total > 0 THEN pc.revenue / tot.total END AS share,
      CASE WHEN pc.revenue_1_30d IS NULL OR pc.revenue_31_60d IS NULL OR pc.revenue_61_90d IS NULL
        THEN NULL ELSE pc.revenue_31_60d + pc.revenue_61_90d END AS prior
    FROM s
    CROSS JOIN product_report_customers pc
    JOIN tot ON tot.product_key = pc.product_key
    JOIN product_report pr ON lower(btrim(pr.product_code)) = pc.product_key
  ), g AS (
    SELECT b.*,
      CASE WHEN prior > 0 THEN r1 * 2 / prior - 1 END AS growth,
      CASE WHEN prior IS NULL THEN NULL
           WHEN prior > 0 AND r1 <= 0 THEN 'lost'
           WHEN prior > 0 AND r1 * 4 < prior THEN 'check'
           WHEN prior > 0 AND r1 * 2 < prior THEN 'drop'
           WHEN prior > 0 THEN 'up'
           WHEN r1 > 0 THEN 'new' END AS growth_state
    FROM b
  )`;

const ROW_SELECT = `pg.product_code, pg.product_name, pg.customer_name, pg.revenue::text AS revenue,
  pg.r1::text AS r1, pg.r2::text AS r2, pg.r3::text AS r3, pg.share::text AS share, pg.growth::text AS growth, pg.growth_state`;

function mapRecords(records) {
  return records.filter(r => r.product_code !== null && r.product_code !== undefined).map(r => ({
    productCode: r.product_code,
    productName: r.product_name,
    customerName: r.customer_name || '',
    revenue: toNumber(r.revenue),
    revenue1_30d: toNumber(r.r1),
    revenue31_60d: toNumber(r.r2),
    revenue61_90d: toNumber(r.r3),
    share: toNumber(r.share),
    growth: toNumber(r.growth),
    growthState: r.growth_state || null
  }));
}

function stateOf(head) {
  return { customerWindowEnd: head.window_end, computedAt: head.computed_at, version: Number(head.version) };
}

const UNAVAILABLE = () => ({ available: false, rows: [], summary: { totalRows: 0, lostRows: 0, checkRows: 0 } });

async function getProductCustomerGrowth({ product, customer, growth, sort, dir, page, pageSize, pool } = {}) {
  const values = [];
  const add = value => { values.push(value); return '$' + values.length; };
  const filters = parseFilters({ product, customer, growth, sort, dir }, add);
  page = integer(page, 1, 1000000);
  pageSize = integer(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const pageParam = add(page), sizeParam = add(pageSize);

  // Mot cau lenh duy nhat: trang thai + tong + so dong "can check" + trang da kep ve trang cuoi cung doc cung mot anh chup.
  const sql = `${BASE_CTES}, f AS (
    SELECT g.* FROM g ${filters.where}
  ), meta AS (
    SELECT count(*)::int AS total_rows,
      (count(*) FILTER (WHERE growth_state = 'lost'))::int AS lost_rows,
      (count(*) FILTER (WHERE growth_state = 'check'))::int AS check_rows,
      LEAST(${pageParam}::int, GREATEST(1, CEIL(count(*)::numeric / ${sizeParam}::int)::int)) AS page
    FROM f
  )
  SELECT s.*, meta.total_rows, meta.lost_rows, meta.check_rows, meta.page, ${ROW_SELECT}
  FROM s CROSS JOIN meta
  LEFT JOIN LATERAL (
    SELECT * FROM f ORDER BY ${filters.orderBy('f')}
    LIMIT ${sizeParam}::int OFFSET (meta.page - 1) * ${sizeParam}::int
  ) pg ON true
  ORDER BY ${filters.orderBy('pg')}`;
  const { rows: records } = await timedQuery(pool || getPool(), 'customer-growth', sql, values);

  if (!records.length) return UNAVAILABLE();
  const head = records[0];
  return {
    available: true,
    state: stateOf(head),
    periods: customerPeriods(head.window_end),
    summary: { totalRows: head.total_rows, lostRows: head.lost_rows, checkRows: head.check_rows },
    rows: mapRecords(records),
    page: head.page,
    pageSize,
    sort: filters.sortKey,
    dir: filters.direction.toLowerCase()
  };
}

// Xuat file: TOAN BO dong khop bo loc, cung luat loc + sap xep voi man hinh, khong phan trang. Tran an toan EXPORT_MAX_ROWS:
// vuot -> loi 413 ro rang, khong cat ngam.
async function getProductCustomerGrowthForExport({ product, customer, growth, sort, dir, pool, maxRows = EXPORT_MAX_ROWS } = {}) {
  const values = [];
  const add = value => { values.push(value); return '$' + values.length; };
  const filters = parseFilters({ product, customer, growth, sort, dir }, add);
  const limit = integer(maxRows, EXPORT_MAX_ROWS, EXPORT_MAX_ROWS);
  const limitParam = add(limit + 1);
  const sql = `${BASE_CTES}, f AS (
    SELECT g.* FROM g ${filters.where}
  )
  SELECT s.*, (SELECT count(*)::int FROM f) AS total_rows,
    (SELECT (count(*) FILTER (WHERE growth_state = 'lost'))::int FROM f) AS lost_rows,
    (SELECT (count(*) FILTER (WHERE growth_state = 'check'))::int FROM f) AS check_rows, ${ROW_SELECT}
  FROM s
  LEFT JOIN LATERAL (SELECT * FROM f ORDER BY ${filters.orderBy('f')} LIMIT ${limitParam}::int) pg ON true
  ORDER BY ${filters.orderBy('pg')}`;
  const { rows: records } = await timedQuery(pool || getPool(), 'customer-growth-export', sql, values);

  if (!records.length) return UNAVAILABLE();
  const head = records[0];
  const rows = mapRecords(records);
  if (rows.length > limit) {
    throw Object.assign(new Error(`Bảng khách hàng theo sản phẩm có ${Number(head.total_rows).toLocaleString('en-US')} dòng, vượt giới hạn ${limit.toLocaleString('en-US')} dòng của một lần xuất. Vui lòng gõ từ khóa hoặc chọn nhóm tăng trưởng để thu hẹp.`),
      { statusCode: 413, code: 'EXPORT_TOO_MANY_ROWS' });
  }
  return {
    available: true,
    state: stateOf(head),
    periods: customerPeriods(head.window_end),
    summary: { totalRows: head.total_rows, lostRows: head.lost_rows, checkRows: head.check_rows },
    rows,
    sort: filters.sortKey,
    dir: filters.direction.toLowerCase()
  };
}

module.exports = {
  getProductCustomerGrowth, getProductCustomerGrowthForExport, validateFilters,
  GROWTH_GROUPS, SORT_KEYS, EXPORT_MAX_ROWS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE
};
