'use strict';

const { getPool } = require('../db/pool');
const { vnDateKey, addDaysToKey } = require('../kiotvietSync/vnTime');
const { INVOICE_STATUS_SQL } = require('../kiotvietSync/salesSqlFragments');
const { fuzzySqlParts } = require('../shared/fuzzySql');

function invalid() {
  return Object.assign(new Error('Tham số lịch sử giao dịch không hợp lệ.'), { statusCode: 400 });
}
function integer(value, fallback, max) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') throw invalid();
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1 || Number(value) > max) throw invalid();
  return Number(value);
}

// SQL expressions are selected only from this whitelist; query input is never interpolated.
const SORT_SQL = Object.freeze({
  time: 'filtered.time',
  type: "CASE type WHEN 'invoice' THEN 'Hóa đơn' WHEN 'return' THEN 'Trả hàng' ELSE 'Đơn hàng Phiếu tạm' END",
  documentCode: "COALESCE(code, '') || ' · ' || CASE branch WHEN 'hanoi' THEN 'HN' ELSE 'SG' END",
  customerName: 'customer_name',
  quantity: 'quantity'
});

async function readProductHistory({ code, q = '', type = 'all', sort = 'time', dir = 'desc', page, pageSize, pool, now = new Date() } = {}, exportAll = false) {
  if (typeof code !== 'string' || !code.trim() || code.length > 200 || typeof q !== 'string' || q.length > 500
    || !['all', 'invoice', 'return', 'order'].includes(type)
    || typeof sort !== 'string' || !Object.hasOwn(SORT_SQL, sort) || !['asc', 'desc'].includes(dir)) throw invalid();
  page = integer(page, 1, 1000000);
  pageSize = integer(pageSize, 25, 100);
  const to = vnDateKey(now), from = addDaysToKey(to, -89);
  const values = [code.trim(), from, to, type];
  const add = value => { values.push(value); return '$' + values.length; };
  const fuzzy = fuzzySqlParts('customer_name', q, add);
  const pageParam = exportAll ? null : add(page), sizeParam = exportAll ? null : add(pageSize);
  // Dates from Kiot are VN wall-clock timestamps labelled UTC. Do not convert them to VN again.
  // No documented historical cost field exists in synced invoice/return details. NULL is intentional:
  // neither detail.price nor products.inventories.cost represents cost at transaction time.
  const sql = `WITH lines AS (
    SELECT i.branch, i.id, i.code, i.purchase_date AS time, 'invoice'::text AS type,
      COALESCE(NULLIF(btrim(c.name), ''), NULLIF(btrim(i.raw->>'customerName'), ''), 'Khách lẻ') AS customer_name,
      abs(COALESCE(d.quantity, 0)) AS quantity
    FROM invoices i
    JOIN invoice_details d ON d.branch = i.branch AND d.invoice_id = i.id
    LEFT JOIN products p ON p.branch = d.branch AND p.id = d.product_id
    LEFT JOIN customers c ON c.branch = i.branch AND c.id = i.customer_id
    WHERE i.branch IN ('hanoi','saigon') AND ${INVOICE_STATUS_SQL} = 'Hoàn thành'
      AND i.purchase_date >= ($2::date::timestamp AT TIME ZONE 'UTC')
      AND i.purchase_date < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND lower(btrim(COALESCE(NULLIF(btrim(d.raw->>'productCode'), ''), p.code, ''))) = lower(btrim($1))
    UNION ALL
    SELECT r.branch, r.id, r.code, r.return_date, 'return'::text,
      COALESCE(NULLIF(btrim(c.name), ''), NULLIF(btrim(r.raw->>'customerName'), ''), 'Khách lẻ'),
      abs(COALESCE(d.quantity, 0))
    FROM returns r
    JOIN return_details d ON d.branch = r.branch AND d.return_id = r.id
    LEFT JOIN products p ON p.branch = d.branch AND p.id = d.product_id
    LEFT JOIN customers c ON c.branch = r.branch AND c.id = r.customer_id
    WHERE r.branch IN ('hanoi','saigon') AND r.raw->>'statusValue' = 'Đã trả'
      AND r.return_date >= ($2::date::timestamp AT TIME ZONE 'UTC')
      AND r.return_date < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND lower(btrim(COALESCE(NULLIF(btrim(d.raw->>'productCode'), ''), p.code, ''))) = lower(btrim($1))
    UNION ALL
    SELECT o.branch, o.id, o.code, o.order_date, 'order'::text,
      COALESCE(NULLIF(btrim(c.name), ''), NULLIF(btrim(o.raw->>'customerName'), ''), 'Khách lẻ'),
      abs(COALESCE(d.quantity, 0))
    FROM orders o
    JOIN order_details d ON d.branch = o.branch AND d.order_id = o.id
    LEFT JOIN products p ON p.branch = d.branch AND p.id = d.product_id
    LEFT JOIN customers c ON c.branch = o.branch AND c.id = o.customer_id
    WHERE o.branch IN ('hanoi','saigon')
      AND o.raw->>'statusValue' = 'Phiếu tạm'
      AND o.order_date >= ($2::date::timestamp AT TIME ZONE 'UTC')
      AND o.order_date < (($3::date + 1)::timestamp AT TIME ZONE 'UTC')
      AND lower(btrim(COALESCE(NULLIF(btrim(d.raw->>'productCode'), ''), p.code, ''))) = lower(btrim($1))
  ), filtered AS MATERIALIZED (
    SELECT branch, id, code, time, type, customer_name, SUM(quantity) AS quantity
    FROM lines WHERE ($4 = 'all' OR type = $4) ${fuzzy ? 'AND ' + fuzzy.where : ''}
    GROUP BY branch, id, code, time, type, customer_name
  ), totals AS (
    SELECT count(*)::int AS total_rows,
      COALESCE(SUM(quantity) FILTER (WHERE type = 'invoice'), 0) AS purchase_quantity,
      COALESCE(SUM(quantity) FILTER (WHERE type = 'return'), 0) AS return_quantity,
      count(*) FILTER (WHERE type = 'invoice')::int AS purchase_count,
      count(*) FILTER (WHERE type = 'return')::int AS return_count,
      COALESCE(SUM(quantity) FILTER (WHERE type = 'order'), 0) AS order_quantity,
      count(*) FILTER (WHERE type = 'order')::int AS order_count
    FROM filtered
  ), meta AS (
    SELECT *, ${exportAll ? '1' : `LEAST(${pageParam}::int, GREATEST(1, CEIL(total_rows::numeric / ${sizeParam}::int)::int))`} AS page FROM totals
  )
  SELECT meta.*, COALESCE((SELECT jsonb_agg(row_to_json(paged)) FROM (
    SELECT branch, id::text AS "documentId", code AS "documentCode", type,
      to_char(time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS time,
      customer_name AS "customerName", quantity, NULL::numeric AS "unitCost"
    FROM filtered ORDER BY ${SORT_SQL[sort]} ${dir.toUpperCase()}, branch, type, id DESC
    ${exportAll ? '' : `LIMIT ${sizeParam}::int OFFSET (meta.page - 1) * ${sizeParam}::int`}
  ) paged), '[]'::jsonb) AS rows FROM meta`;
  const { rows: [result] } = await (pool || getPool()).query(sql, values);
  return {
    code: code.trim(), from, to, page: result.page, pageSize, totalRows: result.total_rows,
    summary: {
      purchaseQuantity: Number(result.purchase_quantity), returnQuantity: Number(result.return_quantity),
      purchaseCount: result.purchase_count, returnCount: result.return_count,
      orderQuantity: Number(result.order_quantity), orderCount: result.order_count
    },
    rows: result.rows.map(row => ({ ...row, quantity: Number(row.quantity), unitCost: null }))
  };
}

async function getProductHistory(options) {
  return readProductHistory(options);
}

async function getProductHistoryForExport(options) {
  return readProductHistory(options, true);
}

module.exports = { getProductHistory, getProductHistoryForExport };
