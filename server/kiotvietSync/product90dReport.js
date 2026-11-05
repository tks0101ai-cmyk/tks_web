'use strict';

const { getPool } = require('../db/pool');
const { normalizedNameSql, INVOICE_STATUS_SQL } = require('./salesSqlFragments');
const { vnDateKey, vnMinutesOfDay, addDaysToKey } = require('./vnTime');

// Independent daily snapshot: never use the incremental customer/product reports,
// whose windows include today and whose active-customer filters differ.
// Catalog = only ACTIVE products: a code is included when at least one branch row has
// is_active IS NOT FALSE (NULL counts as active); the code/name come from an active row
// (Hanoi first). Sales/returns of inactive-only codes drop out because totals join the
// catalog, and stored rows of codes that became inactive are deleted on the next refresh.
const PERIODS = ['61_90d', '31_60d', '1_30d', '1_90d'];
const METRICS = ['qty', 'revenue', 'avg_price', 'customer_count', 'invoice_count', 'top_customers'];
const COLUMNS = ['product_key', 'product_code', 'product_name', ...PERIODS.flatMap(p => METRICS.map(m => `${m}_${p}`))];
const currentCustomer = alias => `COALESCE(NULLIF(btrim(c.name), ''), NULLIF(btrim(${alias}.raw->>'customerName'), ''), 'Khách lẻ')`;
const code = alias => `lower(btrim(COALESCE(NULLIF(btrim(p.code), ''), ${alias}.raw->>'productCode', '')))`;

// Same subtotal/discount rules as salesSqlFragments, but keep NUMERIC throughout
// instead of float8 so monetary and fractional quantity sums remain exact.
const SALE_AMOUNT = `CASE WHEN d.raw ? 'subTotal' THEN COALESCE((d.raw->>'subTotal')::numeric, 0)
  ELSE COALESCE(d.price,0) * COALESCE(d.quantity,0) - COALESCE(d.discount,0) END`;
const RETURN_AMOUNT = `abs(CASE WHEN rd.raw ? 'subTotal' THEN COALESCE((rd.raw->>'subTotal')::numeric,0)
  ELSE COALESCE(rd.price,0) * COALESCE(rd.quantity,0) END)`;

const FILL_SQL = `
WITH catalog AS (
  SELECT DISTINCT ON (lower(btrim(p.code))) lower(btrim(p.code)) AS product_key,
    btrim(p.code) AS product_code,
    COALESCE(NULLIF(btrim(p.raw->>'fullName'),''), NULLIF(btrim(p.name),''), btrim(p.code)) AS product_name
  FROM products p
  WHERE p.branch IN ('hanoi','saigon') AND btrim(COALESCE(p.code,'')) <> ''
    AND p.is_active IS NOT FALSE
  ORDER BY lower(btrim(p.code)), CASE p.branch WHEN 'hanoi' THEN 0 ELSE 1 END,
    p.synced_at DESC NULLS LAST, p.id DESC
), lines AS MATERIALIZED (
  SELECT ${code('d')} AS product_key,
    ${normalizedNameSql(currentCustomer('i'))} AS customer_key, ${currentCustomer('i')} AS customer_name,
    i.branch || ':' || i.id::text AS invoice_key,
    $1::date - (i.purchase_date AT TIME ZONE 'UTC')::date AS age,
    COALESCE(d.quantity,0)::numeric AS quantity, (${SALE_AMOUNT})::numeric AS revenue
  FROM invoices i
  JOIN invoice_details d ON d.branch=i.branch AND d.invoice_id=i.id
  LEFT JOIN products p ON p.branch=d.branch AND p.id=d.product_id
  LEFT JOIN customers c ON c.branch=i.branch AND c.id=i.customer_id
  WHERE i.branch IN ('hanoi','saigon') AND ${INVOICE_STATUS_SQL} = 'Hoàn thành'
    AND i.purchase_date >= (($1::date - 90)::timestamp AT TIME ZONE 'UTC')
    AND i.purchase_date < ($1::date::timestamp AT TIME ZONE 'UTC')
  UNION ALL
  SELECT ${code('rd')}, ${normalizedNameSql(currentCustomer('r'))}, ${currentCustomer('r')},
    NULL::text, $1::date - (r.return_date AT TIME ZONE 'UTC')::date,
    -abs(COALESCE(rd.quantity,0))::numeric, -(${RETURN_AMOUNT})::numeric
  FROM returns r
  JOIN return_details rd ON rd.branch=r.branch AND rd.return_id=r.id
  LEFT JOIN products p ON p.branch=rd.branch AND p.id=rd.product_id
  LEFT JOIN customers c ON c.branch=r.branch AND c.id=r.customer_id
  WHERE r.branch IN ('hanoi','saigon')
    AND COALESCE(NULLIF(r.raw->>'statusValue',''), CASE r.status WHEN 1 THEN 'Đã trả' END) = 'Đã trả'
    AND r.return_date >= (($1::date - 90)::timestamp AT TIME ZONE 'UTC')
    AND r.return_date < ($1::date::timestamp AT TIME ZONE 'UTC')
), periods(period, first_day, last_day) AS (
  VALUES ('61_90d',61,90), ('31_60d',31,60), ('1_30d',1,30), ('1_90d',1,90)
), totals AS (
  SELECT l.product_key, b.period, sum(l.quantity) AS qty, sum(l.revenue) AS revenue,
    count(DISTINCT l.customer_key) FILTER (WHERE l.invoice_key IS NOT NULL)::numeric AS customer_count,
    count(DISTINCT l.invoice_key)::numeric AS invoice_count
  FROM lines l JOIN periods b ON l.age BETWEEN b.first_day AND b.last_day
  GROUP BY l.product_key,b.period
), customers_net AS (
  SELECT l.product_key,b.period,l.customer_key, min(btrim(l.customer_name)) AS name,
    sum(l.quantity) AS quantity,sum(l.revenue) AS revenue
  FROM lines l JOIN periods b ON l.age BETWEEN b.first_day AND b.last_day
  GROUP BY l.product_key,b.period,l.customer_key
), ranked AS (
  SELECT c.*, row_number() OVER (PARTITION BY c.product_key,c.period ORDER BY c.revenue DESC,c.customer_key) AS rank,
    c.revenue / NULLIF(t.revenue,0) AS share
  FROM customers_net c JOIN totals t USING(product_key,period)
), top_customers AS (
  SELECT product_key,period,jsonb_agg(jsonb_build_object('name',name,'share',share,'revenue',revenue,'quantity',quantity) ORDER BY rank) AS customers
  FROM ranked WHERE rank <= 3 GROUP BY product_key,period
)
INSERT INTO product_90d_report_new (${COLUMNS.join(', ')})
SELECT p.product_key,p.product_code,p.product_name,
  ${PERIODS.map((period, i) => `COALESCE(t${i}.qty,0), COALESCE(t${i}.revenue,0),
    t${i}.revenue / NULLIF(t${i}.qty,0), COALESCE(t${i}.customer_count,0), COALESCE(t${i}.invoice_count,0),
    COALESCE(c${i}.customers,'[]'::jsonb)`).join(',\n  ')}
FROM catalog p
${PERIODS.map((period, i) => `LEFT JOIN totals t${i} ON t${i}.product_key=p.product_key AND t${i}.period='${period}'
LEFT JOIN top_customers c${i} ON c${i}.product_key=p.product_key AND c${i}.period='${period}'`).join('\n')}`;

const VALUE_COLUMNS = COLUMNS.filter(c => c !== 'product_key');
const UPSERT_SQL = `INSERT INTO product_90d_report AS old (${COLUMNS.join(',')})
  SELECT ${COLUMNS.join(',')} FROM product_90d_report_new
  ON CONFLICT(product_key) DO UPDATE SET ${VALUE_COLUMNS.map(c => `${c}=EXCLUDED.${c}`).join(',')}
  WHERE ROW(${VALUE_COLUMNS.map(c => `old.${c}`).join(',')})
    IS DISTINCT FROM ROW(${VALUE_COLUMNS.map(c => `EXCLUDED.${c}`).join(',')})`;

async function refreshProduct90dReport(pool, { now = () => new Date(), force = true, log = console.log } = {}) {
  const current = now();
  if (!force && vnMinutesOfDay(current) < 120) return { skipped: 'before-02:00' };
  const today = vnDateKey(current);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Multiple workers/manual runs cannot publish the same daily snapshot twice.
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(20531106) AS locked');
    if (!lock.rows[0].locked) {
      await client.query('ROLLBACK');
      return { skipped: 'busy' };
    }
    const state = await client.query('SELECT as_of_date::text FROM product_90d_report_state WHERE id=1');
    if (!force && state.rows[0]?.as_of_date >= today) {
      await client.query('COMMIT');
      return { skipped: 'already-current' };
    }
    await client.query("SET LOCAL statement_timeout = '180s'");
    await client.query("SET LOCAL work_mem = '32MB'");
    await client.query('SET LOCAL enable_mergejoin = off');
    await client.query('CREATE TEMP TABLE product_90d_report_new (LIKE product_90d_report) ON COMMIT DROP');
    await client.query(FILL_SQL, [today]);
    const changed = await client.query(UPSERT_SQL);
    const deleted = await client.query(`DELETE FROM product_90d_report r
      WHERE NOT EXISTS (SELECT 1 FROM product_90d_report_new n WHERE n.product_key=r.product_key)`);
    const saved = await client.query(`INSERT INTO product_90d_report_state
      (id,as_of_date,window_start,window_end,computed_at,row_count,version)
      VALUES (1,$1::date,$1::date-90,$1::date-1,$2,(SELECT count(*) FROM product_90d_report_new),1)
      ON CONFLICT(id) DO UPDATE SET as_of_date=EXCLUDED.as_of_date,window_start=EXCLUDED.window_start,
        window_end=EXCLUDED.window_end,computed_at=EXCLUDED.computed_at,row_count=EXCLUDED.row_count,
        version=product_90d_report_state.version+1 RETURNING row_count,version`, [today, current]);
    await client.query('COMMIT');
    const result = { rowCount: Number(saved.rows[0].row_count), version: Number(saved.rows[0].version),
      window: { start: addDaysToKey(today,-90), end: addDaysToKey(today,-1) },
      changed: changed.rowCount, deleted: deleted.rowCount };
    log(`[product90dReport] ${result.window.start}..${result.window.end}: ${result.rowCount} mã hàng.`);
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function startProduct90dReportSchedule(pool, {
  intervalMs = 60 * 1000, setIntervalFn = setInterval, scheduleImmediate = queueMicrotask,
  now = () => new Date(), log = console.log
} = {}) {
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try { await refreshProduct90dReport(pool, { now, force: false, log }); }
    catch (error) {
      // Deploying the worker before migration must not break other sync jobs.
      if (error.code !== '42P01') log(`[product90dReport] Lỗi cập nhật: ${error.message}`);
    } finally { running = false; }
  }
  scheduleImmediate(tick);
  return setIntervalFn(tick, intervalMs);
}

if (require.main === module) {
  const pool = getPool();
  refreshProduct90dReport(pool).catch(error => {
    console.error(`[product90dReport] ${error.message}`); process.exitCode = 1;
  }).finally(() => pool.end());
}

module.exports = { refreshProduct90dReport, startProduct90dReportSchedule };
