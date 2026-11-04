'use strict';

// Bao cao "Hang hoa 90 ngay" (tab Hang hoa, muc 4): CHI DOC 2 bang tinh san
// product_90d_report + product_90d_report_state (job server/kiotvietSync/product90dReport.js dung luc 02:00).
// Khong quet chung tu, khong tinh lai. Tim kiem + sap xep + phan trang deu lam o SQL tren TOAN BO ket qua.
const { getPool } = require('../db/pool');
const { addDaysToKey } = require('../kiotvietSync/vnTime');
const { fuzzySqlParts } = require('../shared/fuzzySql');

// Thu tu 4 ky co dinh theo giao dien; first/last = so ngay lui tu as_of_date (A): ky = [A-last, A-first].
const PERIODS = [
  { key: '61_90d', label: 'T.trc nữa', first: 61, last: 90 },
  { key: '31_60d', label: 'T.trc', first: 31, last: 60 },
  { key: '1_30d', label: 'T.này', first: 1, last: 30 },
  { key: '1_90d', label: '90 ngày', first: 1, last: 90 }
];
// Chi so so (NUMERIC) moi ky; top_customers_* la JSONB, khong sap xep duoc.
const NUMERIC_METRICS = ['qty', 'revenue', 'avg_price', 'customer_count', 'invoice_count'];
const NUMERIC_COLUMNS = PERIODS.flatMap(p => NUMERIC_METRICS.map(m => `${m}_${p.key}`));
const TOP_COLUMNS = PERIODS.map(p => `top_customers_${p.key}`);
// Danh sach trang de sap xep: ten cot DB, KHONG bao gio noi chuoi tu nguoi dung vao SQL.
const SORT_COLUMNS = Object.freeze(['product_code', 'product_name', ...NUMERIC_COLUMNS]);
const SORT_SET = new Set(SORT_COLUMNS);
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 200;

function invalid() {
  return Object.assign(new Error('Tham số báo cáo hàng hóa 90 ngày không hợp lệ.'), { statusCode: 400 });
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw invalid();
  return Number(value);
}

// NUMERIC lay ra dang chuoi (::text) roi doi sang so; NULL giu nguyen NULL (khong bien thanh 0).
const toNumber = value => (value === null || value === undefined ? null : Number(value));

// Top 3 khach: chuan hoa dung <= 3 phan tu {name, share, revenue, quantity}; du lieu hong -> [].
function normalizeTop(value) {
  let list = value;
  if (typeof list === 'string') { try { list = JSON.parse(list); } catch { list = []; } }
  if (!Array.isArray(list)) return [];
  return list.slice(0, 3).filter(item => item && typeof item === 'object').map(item => ({
    name: item.name == null ? '' : String(item.name),
    share: toNumber(item.share),
    revenue: toNumber(item.revenue),
    quantity: toNumber(item.quantity)
  }));
}

function periodsFor(asOfDate) {
  return PERIODS.map(p => ({
    key: p.key, label: p.label,
    from: addDaysToKey(asOfDate, -p.last), to: addDaysToKey(asOfDate, -p.first)
  }));
}

async function getProduct90dReport({ q = '', sort, dir, page, pageSize, pool } = {}) {
  if (typeof q !== 'string' || q.length > MAX_QUERY_LENGTH) throw invalid();
  if (sort !== undefined && (typeof sort !== 'string' || !SORT_SET.has(sort))) throw invalid();
  if (dir !== undefined && dir !== 'asc' && dir !== 'desc') throw invalid();
  page = integer(page, 1, 1000000);
  pageSize = integer(pageSize, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  const values = [];
  const add = value => { values.push(value); return '$' + values.length; };
  const fuzzy = fuzzySqlParts("COALESCE(t.product_code,'') || ' ' || COALESCE(t.product_name,'')", q, add);
  const pageParam = add(page), sizeParam = add(pageSize);

  // Co chu de tim ma khong chon cot sap xep -> xep theo do khop; con lai mac dinh theo ma hang tang dan.
  const relevance = Boolean(fuzzy) && sort === undefined;
  const sortColumn = sort === undefined ? 'product_code' : sort;
  const direction = dir === 'desc' ? 'DESC' : (dir === 'asc' ? 'ASC' : (sort !== undefined && NUMERIC_COLUMNS.includes(sort) ? 'DESC' : 'ASC'));
  // NULL luon cuoi o ca 2 chieu; hoa bang -> ma hang -> khoa ky thuat de thu tu on dinh giua cac trang.
  const orderBy = [
    relevance ? 'f.score DESC' : `f.${sortColumn} ${direction} NULLS LAST`,
    'f.product_code ASC', 'f.product_key ASC'
  ].join(', ');

  const numericSelect = NUMERIC_COLUMNS.map(c => `pg.${c}::text AS ${c}`).join(', ');
  const topSelect = TOP_COLUMNS.map(c => `pg.${c} AS ${c}`).join(', ');
  // Mot cau lenh duy nhat: trang thai + tong + trang da kep ve trang cuoi cung cung doc cung mot anh chup.
  // Khong co dong state -> khong tra dong nao (available:false).
  const sql = `WITH s AS (
    SELECT as_of_date::text AS as_of_date, window_start::text AS window_start, window_end::text AS window_end,
      to_char(computed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS computed_at,
      row_count::text AS row_count, version::text AS version
    FROM product_90d_report_state WHERE id = 1
  ), f AS (
    SELECT t.*, ${fuzzy ? fuzzy.score : '0'} AS score
    FROM product_90d_report t ${fuzzy ? 'WHERE ' + fuzzy.where : ''}
  ), meta AS (
    SELECT count(*)::int AS total_rows,
      LEAST(${pageParam}::int, GREATEST(1, CEIL(count(*)::numeric / ${sizeParam}::int)::int)) AS page
    FROM f
  )
  SELECT s.*, meta.total_rows, meta.page, pg.product_code, pg.product_name, ${numericSelect}, ${topSelect}
  FROM s CROSS JOIN meta
  LEFT JOIN LATERAL (
    SELECT * FROM f ORDER BY ${orderBy}
    LIMIT ${sizeParam}::int OFFSET (meta.page - 1) * ${sizeParam}::int
  ) pg ON true
  ORDER BY ${relevance ? 'pg.score DESC' : `pg.${sortColumn} ${direction} NULLS LAST`}, pg.product_code ASC, pg.product_key ASC`;
  const { rows: records } = await (pool || getPool()).query(sql, values);

  if (!records.length) return { available: false, rows: [], totalRows: 0 };
  const head = records[0];
  const rows = records.filter(r => r.product_code !== null && r.product_code !== undefined).map(r => {
    const row = { product_code: r.product_code, product_name: r.product_name };
    for (const p of PERIODS) {
      row[`qty_${p.key}`] = toNumber(r[`qty_${p.key}`]);
      row[`revenue_${p.key}`] = toNumber(r[`revenue_${p.key}`]);
      row[`avg_price_${p.key}`] = toNumber(r[`avg_price_${p.key}`]);
      row[`customer_count_${p.key}`] = toNumber(r[`customer_count_${p.key}`]);
      row[`invoice_count_${p.key}`] = toNumber(r[`invoice_count_${p.key}`]);
      row[`top_customers_${p.key}`] = normalizeTop(r[`top_customers_${p.key}`]);
    }
    return row;
  });
  return {
    available: true,
    state: {
      asOfDate: head.as_of_date, windowStart: head.window_start, windowEnd: head.window_end,
      computedAt: head.computed_at, rowCount: Number(head.row_count), version: Number(head.version)
    },
    periods: periodsFor(head.as_of_date),
    rows,
    totalRows: head.total_rows,
    page: head.page,
    pageSize,
    sort: relevance ? 'relevance' : sortColumn,
    dir: direction.toLowerCase()
  };
}

module.exports = { getProduct90dReport, SORT_COLUMNS, PERIODS, MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE };
