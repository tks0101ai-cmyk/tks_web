'use strict';

// Tinh lai bang product_report ("Bao cao hang hoa", tab Tong quan) - xem ke
// hoach da duyet "mutable-summit" va server/db/migrations/0018_product_report.sql.
// Khac voi refreshDashboardRollups (chay moi 5 phut, idempotent re per-branch
// window), bang nay CHI duoc phep tinh lai 1 LAN/DEM (quet 90 ngay hoa don ca
// 2 co so la truy van nang, khong nen chay lien tuc — vua ton tai nguyen
// Supabase vua khong dung yeu cau "cap nhat 1 lan luc 0h" cua nguoi dung).
// Pattern: ham thuan refreshProductReport tach khoi ham co dieu kien
// refreshProductReportIfDue, tach tiep khoi ham dang ky lich
// startProductReportSchedule (setIntervalFn injectable de test), dung dung
// pattern webhookEventsCleanup.js / dashboardRollupRefresh.js.

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (e) { /* dotenv là tùy chọn trong môi trường production */ }
}

const CONFIG = require('../config');
const { getPool } = require('../db/pool');
const { sqlLiteral } = require('../dashboard/inTransitSource');
const { normalizedNameSql } = require('./salesSqlFragments');

const BRANCH_CODES = Object.freeze(['hanoi', 'saigon']);

// TEN KHACH HIEN TAI uu tien hon ten ghi tren hoa don (doi ten khach tren KiotViet khong sua hoa don cu, ten cu
// con trong raw); khach gop theo TEN CHUAN HOA (cung ten khac ma = 1 khach). c = customers join theo customer_id.
const CUSTOMER_NAME_SQL = alias => `COALESCE(NULLIF(btrim(c.name), ''), NULLIF(btrim(${alias}.raw->>'customerName'), ''), 'Khách lẻ')`;
const CUSTOMER_KEY_SQL = alias => `'name:' || ${normalizedNameSql(CUSTOMER_NAME_SQL(alias))}`;

// Don dat hang cua khach ("Phieu tam") dang giu cho hang — chi trang thai nay bi tru khoi ton
// co the ban cua snapshot nen (Ton thuc - Dat hang phieu tam). Tu 16/10/2026,
// productReportRepository cong dieu chuyen SG khi doc; khong cong o SQL nay de tranh tinh hai lan.
const PENDING_ORDER_STATUS = 'Phiếu tạm';

// Ky tu bi cat o hai dau "Mo ta" san pham: dau cach, tab, CR, LF (E'...' cua Postgres, dung literal \t \r \n).
const DESCRIPTION_TRIM_CHARS = "E' \\t\\r\\n'";

// Gia tri 1 dong return_details (alias rd), tuyet doi - ban sao cua RETURN_AMOUNT_SQL
// trong customerProductTopRepository.js (cung ly do khong import o duoi).
const RETURN_AMOUNT_SQL = `CASE
    WHEN rd.raw ? 'subTotal' THEN abs(COALESCE((rd.raw->>'subTotal')::float8, 0))
    ELSE abs(COALESCE(rd.price, 0)::float8 * COALESCE(rd.quantity, 0)::float8)
  END`;

// "Thanh tien" tren 1 dong invoice_details - dung LAI CHINH XAC dinh nghia da
// co o customerProductTopRepository.js/dashboardRollupRefresh.js (khong import
// truc tiep de tranh phu thuoc chuoi giua 2 module rollup doc lap - cong thuc
// da on dinh tu 2026-09).
const DETAIL_AMOUNT_SQL = `CASE
    WHEN d.raw ? 'subTotal' THEN COALESCE((d.raw->>'subTotal')::float8, 0)
    ELSE COALESCE(d.price, 0)::float8 * COALESCE(d.quantity, 0)::float8 - COALESCE(d.discount, 0)::float8
  END`;

// LUU Y MUI GIO / TRANG THAI: giong het quy uoc trong dashboardRollupRefresh.js
// - cot purchase_date/order_date/sale_date luu "gio treo tuong VN mang nhan
// UTC" (doc bang AT TIME ZONE 'UTC'), con moc "hom nay theo lich VN" phai lay
// tu now() THAT qua AT TIME ZONE 'Asia/Ho_Chi_Minh'. "Hoa don hop le" dung
// CHUNG 1 dinh nghia (statusValue != 'Đã hủy') cho ca doanh so 90 ngay (G) va
// doanh so khach lon nhat (I) de ty trong K = I/G khong bao gio vuot 100%
// (file Sheets cu dung 2 cong thuc khac nhau nen co dong K > 100%, xem ke
// hoach da duyet).
const CUSTOMER_PERIOD_AGG_SQL = `COALESCE(SUM(amount) FILTER (WHERE line_at >= ((vn_today.today - 30)::timestamp AT TIME ZONE 'UTC')), 0) AS revenue_1_30d,
      COALESCE(SUM(amount) FILTER (WHERE line_at >= ((vn_today.today - 60)::timestamp AT TIME ZONE 'UTC') AND line_at < ((vn_today.today - 30)::timestamp AT TIME ZONE 'UTC')), 0) AS revenue_31_60d,
      COALESCE(SUM(amount) FILTER (WHERE line_at < ((vn_today.today - 60)::timestamp AT TIME ZONE 'UTC')), 0) AS revenue_61_90d`;

const REFRESH_SQL = `
  WITH vn_today AS (
    SELECT (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS today
  ),
  hn_products AS (
    SELECT
      p.code,
      COALESCE(NULLIF(p.raw->>'fullName', ''), p.name) AS name,
      (SELECT COALESCE(SUM(COALESCE((inv->>'onHand')::float8, 0)), 0)
         FROM jsonb_array_elements(COALESCE(p.raw->'inventories', '[]'::jsonb)) inv) AS on_hand,
      -- "Mo ta" san pham tren KiotViet (nhan vien ghi bang gia cho sale tra cuu), tung co so mot. btrim phai cat ca
      -- tab/xuong dong (mac dinh chi cat dau cach): mo ta chi con xuong dong coi nhu trong.
      NULLIF(btrim(p.raw->>'description', ${DESCRIPTION_TRIM_CHARS}), '') AS description,
      -- "Don gia" = GIA VON cua co so (trung binh inventories[].cost trong raw, cung dinh nghia INVENTORY_COST_SQL
      -- cua tab Hang hoa); Ha Noi quyet dinh danh sach ma hang nen thieu gia von coi nhu 0.
      COALESCE((SELECT ROUND(AVG((inv->>'cost')::numeric))
                  FROM jsonb_array_elements(COALESCE(p.raw->'inventories', '[]'::jsonb)) inv), 0) AS price
    FROM products p
    WHERE p.branch = 'hanoi' AND COALESCE(p.code, '') <> ''
  ),
  sg_products AS (
    SELECT
      p.code,
      (SELECT COALESCE(SUM(COALESCE((inv->>'onHand')::float8, 0)), 0)
         FROM jsonb_array_elements(COALESCE(p.raw->'inventories', '[]'::jsonb)) inv) AS on_hand,
      NULLIF(btrim(p.raw->>'description', ${DESCRIPTION_TRIM_CHARS}), '') AS description,
      (SELECT ROUND(AVG((inv->>'cost')::numeric))
         FROM jsonb_array_elements(COALESCE(p.raw->'inventories', '[]'::jsonb)) inv) AS price
    FROM products p
    WHERE p.branch = 'saigon' AND COALESCE(p.code, '') <> ''
  ),
  pending_orders AS (
    -- "Dat hang cua khach" (bang orders, KHONG PHAI purchases-NCC) o trang thai Phieu tam —
    -- so nay bi tru khoi ton co the ban vi da bi giu cho (truoc 2026-10-01 con tinh them
    -- 'Đang xử lý'/'Đã xác nhận' — gan nhu khong co don nao o 2 trang thai nay).
    -- Vi tu loc phieu tam KHOP NGUYEN VAN dieu kien cua idx_orders_phieu_tam
    -- ((raw->>'statusValue') = 'Phiếu tạm', KHONG boc COALESCE) nen Postgres chi doc ~900 don thay
    -- vi quet order_details: do 2026-10-16 750ms/13.500 block doc dia -> 37ms/0 doc dia.
    -- OFFSET 0 giu nguyen vai tro "doc don truoc, tra cuu dong chi tiet sau".
    -- qty = tong hai co so (cot available_to_sell); qty_hanoi/qty_saigon = phan giu cho cua tung co so (cot "Co ban" HN/SG).
    SELECT
      lower(btrim(COALESCE(NULLIF(d.raw->>'productCode', ''), p.code, ''))) AS product_key,
      SUM(COALESCE(d.quantity, 0))::float8 AS qty,
      COALESCE(SUM(COALESCE(d.quantity, 0)) FILTER (WHERE d.branch = 'hanoi'), 0)::float8 AS qty_hanoi,
      COALESCE(SUM(COALESCE(d.quantity, 0)) FILTER (WHERE d.branch = 'saigon'), 0)::float8 AS qty_saigon
    FROM (
      SELECT branch, id FROM orders
      WHERE branch = ANY($1::text[])
        AND (raw->>'statusValue') = ${sqlLiteral(PENDING_ORDER_STATUS)}
      OFFSET 0
    ) o
    JOIN order_details d ON d.branch = o.branch AND d.order_id = o.id
    LEFT JOIN products p ON p.branch = d.branch AND p.id = d.product_id
    GROUP BY 1
  ),
  sales_30d AS (
    -- qty = tong hai co so (cot qty_sold_30d); qty_hanoi/qty_saigon = SL ban 30 ngay cua tung co so (cot "SL ban 30 ngay HN/SG").
    SELECT p.code AS product_code, SUM(dps.qty)::float8 AS qty,
      COALESCE(SUM(dps.qty) FILTER (WHERE dps.branch = 'hanoi'), 0)::float8 AS qty_hanoi,
      COALESCE(SUM(dps.qty) FILTER (WHERE dps.branch = 'saigon'), 0)::float8 AS qty_saigon
    FROM daily_product_sales dps
    JOIN products p ON p.branch = dps.branch AND p.id = dps.product_id
    CROSS JOIN vn_today
    WHERE dps.sale_date >= vn_today.today - 30 AND dps.sale_date <= vn_today.today - 1
    GROUP BY p.code
  ),
  sales_90d AS (
    SELECT p.code AS product_code, SUM(dps.revenue)::float8 AS revenue
    FROM daily_product_sales dps
    JOIN products p ON p.branch = dps.branch AND p.id = dps.product_id
    CROSS JOIN vn_today
    WHERE dps.sale_date >= vn_today.today - 90 AND dps.sale_date <= vn_today.today - 1
    GROUP BY p.code
  ),
  -- Doanh so rong cua khach: dong ban (duong) + dong hang khach tra (am, theo ngay
  -- tra) de khop revenue_90d (daily_product_sales da tru tra hang).
  -- invoice_key (branch:id hoa don, NULL o dong tra hang) + line_at (ngay ban/tra) de dem SL don theo ma hang;
  -- customer_active tach rieng (khong loc o day) vi don cua khach da ngung van tinh vao SL don, con rollup
  -- daily_product_sales cung khong loc khach ngung hoat dong.
  sales90_lines AS (
    (SELECT
      lower(btrim(COALESCE(NULLIF(d.raw->>'productCode', ''), p.code, ''))) AS product_key,
      ${CUSTOMER_KEY_SQL('i')} AS customer_key,
      ${CUSTOMER_NAME_SQL('i')} AS customer_name,
      ${DETAIL_AMOUNT_SQL} AS amount,
      d.branch || ':' || d.invoice_id AS invoice_key,
      i.purchase_date AS line_at,
      COALESCE(c.raw->>'isActive', c.raw->>'IsActive', 'true') <> 'false' AS customer_active
    FROM invoice_details d
    JOIN invoices i ON i.branch = d.branch AND i.id = d.invoice_id
    LEFT JOIN products p ON p.branch = d.branch AND p.id = d.product_id
    LEFT JOIN customers c ON c.branch = i.branch AND c.id = i.customer_id
    CROSS JOIN vn_today
    WHERE d.branch = ANY($1::text[])
      AND COALESCE(i.raw->>'statusValue', '') != 'Đã hủy'
      AND i.purchase_date >= ((vn_today.today - 90)::timestamp AT TIME ZONE 'UTC')
      AND i.purchase_date <  (vn_today.today::timestamp AT TIME ZONE 'UTC'))
    UNION ALL
    (SELECT
      lower(btrim(COALESCE(NULLIF(rd.raw->>'productCode', ''), p.code, ''))) AS product_key,
      ${CUSTOMER_KEY_SQL('r')} AS customer_key,
      ${CUSTOMER_NAME_SQL('r')} AS customer_name,
      -(${RETURN_AMOUNT_SQL}) AS amount,
      NULL::text AS invoice_key,
      r.return_date AS line_at,
      COALESCE(c.raw->>'isActive', c.raw->>'IsActive', 'true') <> 'false' AS customer_active
    FROM return_details rd
    JOIN returns r ON r.branch = rd.branch AND r.id = rd.return_id
    LEFT JOIN products p ON p.branch = rd.branch AND p.id = rd.product_id
    LEFT JOIN customers c ON c.branch = r.branch AND c.id = r.customer_id
    CROSS JOIN vn_today
    WHERE rd.branch = ANY($1::text[])
      AND r.raw->>'statusValue' = 'Đã trả'
      AND r.return_date >= ((vn_today.today - 90)::timestamp AT TIME ZONE 'UTC')
      AND r.return_date <  (vn_today.today::timestamp AT TIME ZONE 'UTC'))
  ),
  -- SL don theo MA HANG (khong theo product_id vi id khac nhau moi co so): so hoa don khac nhau (khong huy,
  -- ca hai co so) co chua ma hang; 30 ngay = phan cuoi cua cua so 90 ngay. Dong tra hang (invoice_key NULL) khong tinh.
  order_counts AS (
    SELECT
      product_key,
      COUNT(DISTINCT invoice_key)::float8 AS orders_90d,
      COUNT(DISTINCT invoice_key) FILTER (WHERE line_at >= ((vn_today.today - 30)::timestamp AT TIME ZONE 'UTC'))::float8 AS orders_30d
    FROM sales90_lines
    CROSS JOIN vn_today
    WHERE invoice_key IS NOT NULL AND product_key <> ''
    GROUP BY product_key
  ),
  -- MATERIALIZED: customer_agg duoc doc 2 lan (xep hang khach lon nhat + luu vao
  -- product_report_customers cho khung "Chi tiet" cua bang) nen phai tinh dung 1
  -- lan, khong de planner quet lai 90 ngay invoice_details. HAVING > 0: khach tra
  -- het (hoac tra nhieu hon da mua trong ky) khong con la khach mua hang cua ma nay.
  customer_agg AS MATERIALIZED (
    SELECT product_key, customer_key, MIN(customer_name) AS customer_name, SUM(amount) AS revenue,
      ${CUSTOMER_PERIOD_AGG_SQL}
    FROM sales90_lines CROSS JOIN vn_today
    WHERE product_key <> '' AND customer_active
    GROUP BY product_key, customer_key
    HAVING SUM(amount) > 0
  ),
  -- CTE ghi du lieu luon chay du 1 lan du cau lenh chinh khong doc RETURNING.
  saved_customers AS (
    INSERT INTO product_report_customers (product_key, customer_key, customer_name, revenue, revenue_1_30d, revenue_31_60d, revenue_61_90d)
    SELECT product_key, customer_key, customer_name, revenue, revenue_1_30d, revenue_31_60d, revenue_61_90d
    FROM customer_agg
    RETURNING 1
  ),
  saved_window AS (
    INSERT INTO product_report_state (id, computed_at, version, last_full_at, customer_window_end)
    SELECT 1, now(), 1, now(), today - 1 FROM vn_today
    ON CONFLICT (id) DO UPDATE SET computed_at = now(), last_full_at = now(),
      version = product_report_state.version + 1, customer_window_end = EXCLUDED.customer_window_end
    RETURNING 1
  ),
  customer_ranked AS (
    SELECT
      product_key, customer_name, revenue,
      ROW_NUMBER() OVER (PARTITION BY product_key ORDER BY revenue DESC) AS rn,
      COUNT(*) OVER (PARTITION BY product_key) AS customer_count
    FROM customer_agg
  ),
  customer_top AS (
    SELECT product_key, customer_name AS top_customer_name, revenue AS top_customer_revenue, customer_count
    FROM customer_ranked
    WHERE rn = 1
  )
  INSERT INTO product_report (
    product_code, product_name, stock_hanoi, stock_saigon, available_to_sell,
    qty_sold_30d, revenue_90d, customer_count_90d, top_customer_revenue_90d,
    top_customer_name, top_customer_share,
    available_hanoi, available_saigon, description_hanoi, description_saigon, price_hanoi, price_saigon,
    qty_sold_30d_hanoi, qty_sold_30d_saigon, orders_30d, orders_90d, computed_at
  )
  SELECT
    hn.code,
    hn.name,
    hn.on_hand,
    COALESCE(sg.on_hand, 0),
    hn.on_hand + COALESCE(sg.on_hand, 0) - COALESCE(po.qty, 0),
    COALESCE(s30.qty, 0),
    COALESCE(s90.revenue, 0),
    COALESCE(ct.customer_count, 0),
    COALESCE(ct.top_customer_revenue, 0),
    ct.top_customer_name,
    CASE WHEN COALESCE(s90.revenue, 0) > 0 THEN LEAST(1, COALESCE(ct.top_customer_revenue, 0) / s90.revenue) ELSE NULL END,
    hn.on_hand - COALESCE(po.qty_hanoi, 0),
    COALESCE(sg.on_hand, 0) - COALESCE(po.qty_saigon, 0),
    hn.description,
    sg.description,
    hn.price,
    sg.price,
    COALESCE(s30.qty_hanoi, 0),
    COALESCE(s30.qty_saigon, 0),
    COALESCE(oc.orders_30d, 0),
    COALESCE(oc.orders_90d, 0),
    now()
  FROM hn_products hn
  LEFT JOIN sg_products sg ON sg.code = hn.code
  LEFT JOIN pending_orders po ON po.product_key = lower(btrim(hn.code))
  LEFT JOIN sales_30d s30 ON s30.product_code = hn.code
  LEFT JOIN sales_90d s90 ON s90.product_code = hn.code
  LEFT JOIN order_counts oc ON oc.product_key = lower(btrim(hn.code))
  LEFT JOIN customer_top ct ON ct.product_key = lower(btrim(hn.code))`;

/**
 * Tinh lai TOAN BO bang product_report va product_report_customers (khong theo
 * tung co so - bang gom ca 2 co so tren 1 dong/ma hang). Xoa trang roi nap lai trong 1 transaction de
 * khong co trang thai "nua vơi" neu loi giua chung.
 */
async function refreshProductReport(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE product_report, product_report_customers');
    const result = await client.query(REFRESH_SQL, [BRANCH_CODES]);
    await client.query('COMMIT');
    log(`[productReportRefresh] Da tinh lai ${result.rowCount || 0} ma hang.`);
    return { rowCount: result.rowCount || 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function vnDateKey(date) {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  return formatter.format(date);
}

/**
 * Chi tinh lai neu CHUA tinh cho ngay lich VN hien tai - goi moi 5 phut (nhu
 * cac job dong bo khac) nhung hau het cac lan chi la 1 SELECT re roi bo qua,
 * dam bao truy van 90-ngay nang chi chay dung 1 lan/dem.
 */
async function refreshProductReportIfDue(pool, {
  log = console.log, now = () => new Date(), incremental = CONFIG.REPORTS_INCREMENTAL_ENABLED
} = {}) {
  const today = vnDateKey(now());
  if (incremental) {
    // Che do tang dan (REPORTS_INCREMENTAL_ENABLED): bao cao duoc lam moi sau moi luot sync fast bang
    // productReportIncremental (ghi khac biet, khong TRUNCATE). Luot kiem tra 5 phut nay chi dam bao
    // chay phan nang it nhat 1 lan/ngay VN va khoi tao khi chua co state; thieu migration 0055 => luong cu.
    // require tai cho de tranh vong phu thuoc (productReportIncremental cat SQL tu file nay).
    const incrementalModule = require('./productReportIncremental');
    try {
      const { rows } = await pool.query(incrementalModule.__sql__.READ_STATE_SQL);
      const fullAt = rows[0] && rows[0].last_full_at;
      if (fullAt && vnDateKey(new Date(fullAt)) === today && rows[0].customer_window_end === today && !rows[0].periods_missing) return { skipped: true };
      const result = await incrementalModule.refreshProductReportIncremental(pool, { log, now, enabled: true });
      return { skipped: false, ...result };
    } catch (error) {
      if (error.code !== '42P01' && error.code !== '42703') throw error;
      // chua chay migration 0055: roi xuong luong chot dem cu ben duoi
    }
  }
  const { rows } = await readLastComputed(pool);
  const lastComputedAt = rows[0] && rows[0].last_computed_at;
  // Dong con NULL o cot theo co so / SL don (vua ap migration 0057/0067, chua tinh lai) => tinh lai ngay thay vi doi sang ngay moi.
  const needsBranchColumns = Boolean(rows[0] && rows[0].needs_branch_columns);
  if (lastComputedAt && vnDateKey(new Date(lastComputedAt)) === today && !needsBranchColumns) {
    return { skipped: true };
  }
  const { rowCount } = await refreshProductReport(pool, { log });
  return { skipped: false, rowCount };
}

// Chua ap migration 0057/0063/0067 (thieu cot available_hanoi/price_hanoi/orders_90d, 42703) thi chi doc moc thoi gian nhu truoc do.
const LAST_COMPUTED_SQL = 'SELECT MAX(computed_at) AS last_computed_at FROM product_report';
const LAST_COMPUTED_WITH_BRANCH_COLUMNS_SQL = `SELECT MAX(computed_at) AS last_computed_at,
  COALESCE(bool_or(available_hanoi IS NULL OR price_hanoi IS NULL
    OR qty_sold_30d_hanoi IS NULL OR orders_90d IS NULL), false)
    OR EXISTS (SELECT 1 FROM product_report_customers WHERE revenue_1_30d IS NULL OR revenue_31_60d IS NULL OR revenue_61_90d IS NULL)
    OR NOT EXISTS (SELECT 1 FROM product_report_state WHERE id = 1 AND customer_window_end IS NOT NULL)
    AS needs_branch_columns FROM product_report`;
async function readLastComputed(pool) {
  try {
    return await pool.query(LAST_COMPUTED_WITH_BRANCH_COLUMNS_SQL);
  } catch (error) {
    if (error.code !== '42703') throw error;
    return pool.query(LAST_COMPUTED_SQL);
  }
}

function startProductReportSchedule(pool, {
  intervalMs = 5 * 60 * 1000,
  setIntervalFn = setInterval,
  scheduleImmediate = queueMicrotask,
  log = console.log
} = {}) {
  scheduleImmediate(() => {
    refreshProductReportIfDue(pool, { log }).catch((error) => {
      log(`[productReportRefresh] Loi khi tinh lan dau: ${error.message}`);
    });
  });
  return setIntervalFn(() => {
    refreshProductReportIfDue(pool, { log }).catch((error) => {
      log(`[productReportRefresh] Loi khi kiem tra/tinh lai: ${error.message}`);
    });
  }, intervalMs);
}

async function main() {
  const pool = getPool();
  const result = await refreshProductReport(pool);
  console.log(`[productReportRefresh] Hoan tat, ${result.rowCount} ma hang.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[productReportRefresh] That bai: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  refreshProductReport,
  refreshProductReportIfDue,
  startProductReportSchedule,
  __sql__: { REFRESH_SQL, DESCRIPTION_TRIM_CHARS, CUSTOMER_PERIOD_AGG_SQL },
  __test__: { vnDateKey }
};
