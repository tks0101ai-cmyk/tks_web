'use strict';

// Refresh dinh ky 4 bang rollup theo ngay dung cho trang "Bao cao tong hop"
// cua Dashboard (xem server/db/migrations/0013_dashboard_rollups.sql va ke
// hoach da duyet "melodic-juggling-karp"). Theo dung pattern
// webhookEventsCleanup.js: ham thuan (refreshDashboardRollups) tach khoi ham
// dang ky lich (startDashboardRollupSchedule), setIntervalFn injectable de
// test khong phai cho interval that.
//
// Idempotent: moi bang dung INSERT ... ON CONFLICT DO UPDATE nen chay lai
// nhieu lan (polling 5 phut, hoac chay tay lai) deu an toan.

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (e) { /* dotenv là tùy chọn trong môi trường production */ }
}

const { getConfiguredBranches } = require('./config');
const { getPool } = require('../db/pool');
const { DETAIL_AMOUNT_SQL, RETURN_AMOUNT_SQL } = require('../dashboard/customerProductTopRepository');
const { dashboardRollupEvents } = require('./dashboardRollupEvents');

const DEFAULT_WINDOW_DAYS = 400;

// Cua so cua luot rollup "nong" chay ngay sau moi luot sync KiotViet
// (scheduler.js). Chon 7 ngay vi do la pham vi thuc te cua hoa don vua tao
// hoac vua bi sua; xa hon the do luot rollup day du (DEFAULT_WINDOW_DAYS) lo.
// Do luong 2026-09-24 tren du lieu that: 7 ngay ~1,4s ca 2 co so, trong khi
// 400 ngay ~6,4s va ghi de ~61.000 dong.
const HOT_WINDOW_DAYS = 7;

// LUU Y MUI GIO (khac voi dashboardPgReader.js): `now()` la TIMESTAMPTZ THAT,
// gan dung nhan mui gio, KHAC voi cac cot purchase_date/sale_date (luu "gio
// treo tuong VN mang nhan UTC" — doc dung phai qua `AT TIME ZONE 'UTC'`, xem
// dau file dashboardPgReader.js). Vi vay de tinh moc "N ngay truoc, theo lich
// VN" tu THOI DIEM THAT (`now()`), phai doi no ve gio VN bang
// `AT TIME ZONE 'Asia/Ho_Chi_Minh'` (dung 'UTC' o day se lech den +7h vao
// khoang 00h-07h gio VN) — roi moi so sanh voi cac cot da quy doi qua
// `AT TIME ZONE 'UTC'` (2 phep doi khac nhau nhung cung tra ra "ngay lich VN").
//
// LUU Y VE MA TRANG THAI: KHONG duoc gia dinh y nghia so status (vd "3 =
// Hoan thanh") - da doi chieu truc tiep du lieu that tren Supabase 2026-09-18
// (ca 2 co so) va phat hien so KHONG co y nghia co dinh giua cac entity:
// invoices status=1 la "Hoan thanh" (status=3 la "Dang xu ly", CHI 7 dong o
// Ha Noi) - nguoc hoan toan voi gia dinh ban dau (status=3="Hoan thanh") tung
// khien ban dau cua file nay loc SAI, lam daily_invoice_summary gan nhu rong.
// Luon loc theo `raw->>'statusValue'` (chuoi that tu KiotViet, xem
// dashboardPgReader.js statusLabel()), khong loc theo so.
//
// LUU Y IO (do tren Supabase 2026-09-28, DB chi ~365MB nhung sinh 36,8GB WAL va
// 115GB tep tam trong 34 ngay; daily_product_sales bi UPDATE ~115 trieu lan
// tren 62.000 dong): ca 4 cau duoi day chay hang tram lan moi ngay, nen phai
// tranh 3 loi da gay ra do:
//  1. DO UPDATE vo dieu kien ghi de ca dong khong doi -> moi lan la 1 phien ban
//     dong moi + WAL + dead tuple + autovacuum. KHONG du neu chi them
//     `ON CONFLICT ... DO UPDATE ... WHERE`: Postgres van KHOA tung dong trung
//     khoa truoc khi xet WHERE (van ghi WAL + lam ban trang). Nen cac dong
//     khong doi bi loai ngay o SELECT (LEFT JOIN vao bang dich + IS DISTINCT
//     FROM), khong bao gio toi buoc INSERT. `updated_at` khong doc o dau ngoai
//     chinh cac cau nay nen thanh "lan thay doi gan nhat".
//  2. work_mem mac dinh ~2MB lam Sort/GroupAggregate tran ra tep tam vi dong dua
//     vao sort con mang theo ca cot `raw` JSONB (~1,4KB/dong). Truy van con
//     `OFFSET 0` chi giu cot can (ngay, tien, trang thai...) va giao dich chay
//     voi ROLLUP_WORK_MEM (xem queryWithWorkMem).
//  3. Loc `(purchase_date AT TIME ZONE 'UTC')::date >= ...` khong dung duoc
//     index -> quet ca bang. WINDOW_START_SQL doi cung moc do ve TIMESTAMPTZ de
//     so sanh thang voi cot goc (index ...purchase_date, migration 0021):
//     (ts AT TIME ZONE 'UTC')::date >= D  <=>  ts >= (D::timestamp AT TIME ZONE 'UTC').
//     Da doi chieu tren du lieu that (2 co so x 7/400 ngay): tap ket qua giong het.
//
// Tong hop tinh bang ::numeric de so sanh dung kieu voi cot dich (NUMERIC): so
// float8 -> numeric qua CUNG ham cast luc INSERT nen 2 lan chay cho cung chuoi so.
//
// $2 = so ngay cua so (int); ngay hom nay tinh theo lich VN tu `now()` THAT
// (xem ghi chu mui gio o tren).
const WINDOW_START_SQL = `(((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - $2::int)::timestamp AT TIME ZONE 'UTC')`;

// work_mem CHI cho giao dich rollup. Cac luot rollup noi tiep qua
// runRollupExclusive nen toi da 1 giao dich dung muc nay tai mot thoi diem.
const ROLLUP_WORK_MEM = '32MB';

// $1 branch, $2 so ngay cua so (int) - chi tinh lai hoa don trong N ngay gan
// nhat. revenue/invoice_count CHI tinh statusValue='Hoàn thành'; cancelled_count
// la statusValue='Đã hủy', rieng cho KPI "hom nay" - KHONG duoc tron 2 dieu
// kien nay voi daily_product_sales (dieu kien khac nhau, xem SCHEMA.md).
const INVOICE_AGG_SQL = `
    SELECT
      $1::text AS branch,
      s.sale_date,
      COALESCE(SUM(s.total) FILTER (WHERE s.status = 'Hoàn thành'), 0)::numeric AS revenue,
      (COUNT(*) FILTER (WHERE s.status = 'Hoàn thành'))::int AS invoice_count,
      (COUNT(*) FILTER (WHERE s.status = 'Đã hủy'))::int AS cancelled_count
    FROM (
      SELECT (purchase_date AT TIME ZONE 'UTC')::date AS sale_date, total, raw->>'statusValue' AS status
      FROM invoices
      WHERE branch = $1
        AND purchase_date >= ${WINDOW_START_SQL}
      OFFSET 0
    ) s
    GROUP BY s.sale_date`;

const INVOICE_SUMMARY_SQL = `
  WITH agg AS (${INVOICE_AGG_SQL}
  )
  INSERT INTO daily_invoice_summary (branch, sale_date, revenue, invoice_count, cancelled_count)
  SELECT a.branch, a.sale_date, a.revenue, a.invoice_count, a.cancelled_count
  FROM agg a
  LEFT JOIN daily_invoice_summary t ON t.branch = a.branch AND t.sale_date = a.sale_date
  WHERE t.branch IS NULL
     OR (t.revenue, t.invoice_count, t.cancelled_count)
        IS DISTINCT FROM (a.revenue, a.invoice_count, a.cancelled_count)
  ON CONFLICT (branch, sale_date) DO UPDATE SET
    revenue = EXCLUDED.revenue,
    invoice_count = EXCLUDED.invoice_count,
    cancelled_count = EXCLUDED.cancelled_count,
    updated_at = now()`;

// "Thanh tien" tren tung dong = DETAIL_AMOUNT_SQL (tai dung chinh xac tu
// customerProductTopRepository.js, alias "d" cho invoice_details). Dieu kien
// hoa don statusValue != 'Đã hủy' (gom ca "Hoàn thành" lan "Đang xử lý"/"Phiếu
// tạm"), khac han dieu kien cua daily_invoice_summary o tren - dung THEO
// TEXT, khong dung so (xem ghi chu mui gio/trang thai o tren).
//
// DOANH SO THUC TE: tru luon hang khach tra. Moi dong return_details cua phieu tra
// statusValue='Đã trả' la 1 dong AM (so luong + gia tri) vao dung ngay TRA hang
// (return_date) cua ma hang do, nen qty/revenue o day la so rong (co the am o
// ngay chi co tra hang). RETURN_AMOUNT_SQL dung alias "rd" cho return_details.
const PRODUCT_SALES_AGG_SQL = `
    SELECT
      $1::text AS branch,
      s.sale_date,
      s.product_id,
      COALESCE(SUM(s.qty), 0)::numeric AS qty,
      COALESCE(SUM(s.amount), 0)::numeric AS revenue
    FROM (
      (SELECT
        (i.purchase_date AT TIME ZONE 'UTC')::date AS sale_date,
        d.product_id,
        COALESCE(d.quantity, 0)::float8 AS qty,
        ${DETAIL_AMOUNT_SQL} AS amount
      FROM invoice_details d
      JOIN invoices i ON i.branch = d.branch AND i.id = d.invoice_id
      WHERE d.branch = $1
        AND COALESCE(i.raw->>'statusValue', '') != 'Đã hủy'
        AND d.product_id IS NOT NULL
        AND i.purchase_date >= ${WINDOW_START_SQL})
      UNION ALL
      (SELECT
        (r.return_date AT TIME ZONE 'UTC')::date AS sale_date,
        rd.product_id,
        -abs(COALESCE(rd.quantity, 0)::float8) AS qty,
        -(${RETURN_AMOUNT_SQL}) AS amount
      FROM return_details rd
      JOIN returns r ON r.branch = rd.branch AND r.id = rd.return_id
      WHERE rd.branch = $1
        AND r.raw->>'statusValue' = 'Đã trả'
        AND rd.product_id IS NOT NULL
        AND r.return_date >= ${WINDOW_START_SQL})
      OFFSET 0
    ) s
    GROUP BY s.sale_date, s.product_id`;

// DONG MO COI: phieu tra/hoa don da vao bang roi bi doi sang 'Đã hủy' thi nhom (ngay, ma hang) khong con
// trong `agg`, INSERT ... ON CONFLICT chi cham toi nhom CO trong agg nen dong cu o lai mai (2026-11-06: TVPAMS
// -1950 tinh hai lan vi phieu tra da huy). Nen cung cau lenh XOA dong trong cua so ngay dang tinh ma `agg` khong
// con (agg chi doc 1 lan: CTE duoc dung chung). Chi dong cua branch nay va ngay >= dau cua so — ngoai cua so
// agg khong nhin thay nen khong duoc dong vao. Moc ngay = cung moc WINDOW_START_SQL, quy ve date.
const PRODUCT_SALES_SQL = `
  WITH agg AS (${PRODUCT_SALES_AGG_SQL}
  ),
  stale AS (
    DELETE FROM daily_product_sales t
    WHERE t.branch = $1
      AND t.sale_date >= ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - $2::int)
      AND NOT EXISTS (SELECT 1 FROM agg a WHERE a.sale_date = t.sale_date AND a.product_id = t.product_id)
    RETURNING 1
  )
  INSERT INTO daily_product_sales (branch, sale_date, product_id, qty, revenue)
  SELECT a.branch, a.sale_date, a.product_id, a.qty, a.revenue
  FROM agg a
  LEFT JOIN daily_product_sales t
    ON t.branch = a.branch AND t.sale_date = a.sale_date AND t.product_id = a.product_id
  WHERE t.branch IS NULL
     OR (t.qty, t.revenue) IS DISTINCT FROM (a.qty, a.revenue)
  ON CONFLICT (branch, sale_date, product_id) DO UPDATE SET
    qty = EXCLUDED.qty,
    revenue = EXCLUDED.revenue,
    updated_at = now()`;

// $1 branch (+ $2 so ngay neu la ban "gan day"). Ngay nhap dau tien cua mot ma
// hang co the xa hon 400 ngay va van can dung cho "Hang moi nhap", nen ban DAY
// DU khong gioi han cua so ngay. Chi ghi khi ma hang chua co dong hoac moc moi
// SOM HON moc dang luu (giu ngu nghia LEAST cu: khong mat moc cu hon neu du lieu
// duoc backfill them sau) - truoc day cau nay ghi de ~7.300 dong/lan du gia tri
// gan nhu khong bao gio doi.
//
// Ban day du doc toan bo purchase_details (~21MB, ~3,7s, phai doc lai tu dia vi
// bi cac lan quet khac day khoi cache) - qua dat de chay moi 30 phut chi de bat
// "ma hang vua duoc nhap lan dau". Vi vay chi chay day du luc khoi dong va sau
// moi FIRST_PURCHASE_FULL_INTERVAL_MS; giua hai lan do dung ban "gan day" chi
// xet phieu nhap trong cua so ngay (dung index purchase_date). Phieu nhap bi
// sua LUI ngay ve qua khu xa hon cua so se duoc luot day du tiep theo bat.
const firstPurchaseSql = (windowFilter) => `
  WITH agg AS (
    SELECT d.product_id, MIN(pu.purchase_date) AS first_purchase_date
    FROM purchase_details d
    JOIN purchases pu ON pu.branch = d.branch AND pu.id = d.purchase_id
    WHERE d.branch = $1
      AND d.product_id IS NOT NULL
      AND pu.purchase_date IS NOT NULL${windowFilter}
    GROUP BY d.product_id
  )
  INSERT INTO product_first_purchase (branch, product_id, first_purchase_date)
  SELECT $1, a.product_id, a.first_purchase_date
  FROM agg a
  LEFT JOIN product_first_purchase t ON t.branch = $1 AND t.product_id = a.product_id
  WHERE t.product_id IS NULL OR a.first_purchase_date < t.first_purchase_date
  ON CONFLICT (branch, product_id) DO UPDATE SET
    first_purchase_date = LEAST(product_first_purchase.first_purchase_date, EXCLUDED.first_purchase_date),
    updated_at = now()`;

const FIRST_PURCHASE_SQL = firstPurchaseSql('');
const FIRST_PURCHASE_RECENT_SQL = firstPurchaseSql(`
      AND pu.purchase_date >= ${WINDOW_START_SQL}`);
const FIRST_PURCHASE_FULL_INTERVAL_MS = 6 * 60 * 60 * 1000;

// branch -> thoi diem (ms) chay ban DAY DU gan nhat trong tien trinh nay.
// Chua co (moi khoi dong) => lan dau luon la ban day du.
const firstPurchaseFullRunAt = new Map();

/**
 * Chay 1 cau rollup trong giao dich rieng voi `SET LOCAL work_mem` (chi anh
 * huong giao dich nay, tu het hieu luc khi COMMIT/ROLLBACK nen khong lam "ban"
 * ket noi tra ve pool). Pool khong co `connect` (mock trong test) thi chay
 * thang bang `pool.query`.
 */
async function queryWithWorkMem(pool, sql, params) {
  if (typeof pool.connect !== 'function') return pool.query(sql, params);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL work_mem = '${ROLLUP_WORK_MEM}'`);
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Chay lai cac bang rollup cho tung co so da cau hinh credentials.
 * Idempotent (UPSERT), an toan chay lai nhieu lan/gap loi giua duong.
 * @param {number} windowDays So ngay tinh lai: DEFAULT_WINDOW_DAYS (luot day du)
 *   hoac HOT_WINDOW_DAYS (luot "nong" sau moi luot sync).
 * @param {boolean} includeFirstPurchase false = bo qua product_first_purchase.
 * @param {Function} now, firstPurchaseFullRunAt, firstPurchaseFullIntervalMs
 *   Chi de test: dong ho va bang "lan chay day du gan nhat" cua product_first_purchase.
 * @returns {Promise<Array<{branch, dailyInvoiceSummary, dailyProductSales, dailyPurchaseSummary, productFirstPurchase}>>}
 *   Cac so dem la SO DONG THAT SU THEM/DOI (khong phai so dong da tinh): dong khong doi bi bo qua.
 */
async function refreshDashboardRollups(pool, {
  windowDays = DEFAULT_WINDOW_DAYS,
  includeFirstPurchase = true,
  getConfiguredBranches: getBranches = getConfiguredBranches,
  log = console.log,
  now = Date.now,
  firstPurchaseFullRunAt: fullRunAt = firstPurchaseFullRunAt,
  firstPurchaseFullIntervalMs = FIRST_PURCHASE_FULL_INTERVAL_MS
} = {}) {
  const branches = getBranches().map((item) => item.branch);
  const results = [];

  for (const branch of branches) {
    const invoiceSummary = await queryWithWorkMem(pool, INVOICE_SUMMARY_SQL, [branch, windowDays]);
    const productSales = await queryWithWorkMem(pool, PRODUCT_SALES_SQL, [branch, windowDays]);
    // FIRST_PURCHASE_SQL (ban day du) quet TOAN BO purchase_details (khong co
    // cua so ngay, xem ghi chu o tren) nen la cau dat nhat trong 3 cau, trong
    // khi "ngay nhap som nhat cua mot ma hang" gan nhu khong doi giua hai luot.
    // Luot "nong" bo qua no; luot day du chi chay ban day du luc khoi dong va
    // moi FIRST_PURCHASE_FULL_INTERVAL_MS, con lai dung ban "gan day".
    let firstPurchase = null;
    if (includeFirstPurchase) {
      const nowMs = now();
      const lastFull = fullRunAt.get(branch);
      const fullDue = lastFull === undefined || nowMs - lastFull >= firstPurchaseFullIntervalMs;
      firstPurchase = fullDue
        ? await queryWithWorkMem(pool, FIRST_PURCHASE_SQL, [branch])
        : await queryWithWorkMem(pool, FIRST_PURCHASE_RECENT_SQL, [branch, windowDays]);
      // Chi ghi nhan sau khi ban day du chay XONG (loi thi lan sau thu lai).
      if (fullDue) fullRunAt.set(branch, nowMs);
    }

    const row = {
      branch,
      dailyInvoiceSummary: invoiceSummary.rowCount || 0,
      dailyProductSales: productSales.rowCount || 0,
      productFirstPurchase: firstPurchase ? firstPurchase.rowCount || 0 : 0
    };
    results.push(row);
    log(`[dashboardRollupRefresh] ${branch} (${windowDays} ngay): daily_invoice_summary=${row.dailyInvoiceSummary}, ` +
      `daily_product_sales=${row.dailyProductSales}, ` +
      `product_first_purchase=${includeFirstPurchase ? row.productFirstPurchase : 'bo qua'}`);
  }

  return results;
}

// Gio co NHIEU nguon cung kich hoat rollup: luot "nong" sau moi luot sync
// fast, luot day du theo interval, va luot chay ngay luc khoi dong. Chung
// UPSERT vao cung nhung dong cua daily_invoice_summary/daily_product_sales
// nhung quet theo thu tu khac nhau (cua so ngay khac nhau => ke hoach truy van
// khac nhau), nen hai luot chong nhau co the cho khoa lan nhau hoac deadlock.
// Noi tiep trong tien trinh: moi luc chi mot luot duoc chay.
let rollupChain = Promise.resolve();

function runRollupExclusive(task) {
  const next = rollupChain.then(task, task);
  rollupChain = next.then(() => {}, () => {});
  return next;
}

/**
 * Chay rollup roi bao cho client dang mo SSE (/api/dashboard/events) biet co du
 * lieu moi de tu goi lai /api/dashboard. CHI phat khi refresh thanh cong, tranh
 * bao "co du lieu moi" trong khi rollup vua that bai giua chung. Khong bao gio
 * nem loi ra ngoai — nguoi goi (interval, luot sync) khong co cho nao de bat.
 */
function refreshDashboardRollupsAndNotify(pool, {
  events = dashboardRollupEvents,
  log = console.log,
  ...options
} = {}) {
  return runRollupExclusive(() => refreshDashboardRollups(pool, { ...options, log }))
    .then(() => { events.emit('updated', { at: Date.now() }); })
    .catch((error) => {
      log(`[dashboardRollupRefresh] Loi khi refresh: ${error.message}`);
    });
}

function startDashboardRollupSchedule(pool, {
  intervalMs = 5 * 60 * 1000, windowDays = DEFAULT_WINDOW_DAYS,
  setIntervalFn = setInterval, scheduleImmediate = queueMicrotask, log = console.log,
  getConfiguredBranches: getBranches = getConfiguredBranches,
  events = dashboardRollupEvents
} = {}) {
  const run = () => refreshDashboardRollupsAndNotify(pool, {
    windowDays, log, getConfiguredBranches: getBranches, events
  });

  // CHAY NGAY mot luot khi khoi dong, giong nhom polling KiotViet
  // (scheduler.js) va productReportRefresh.js. Neu chi dua vao setInterval thi
  // sau moi lan restart/redeploy/thuc day, Dashboard se doc so lieu cu cho
  // den het mot chu ky intervalMs — trong khi lan sync ngay luc khoi dong da
  // keo hoa don moi ve bang `invoices` roi. Da quan sat truc tiep tren
  // Supabase 2026-09-24: server khoi dong lai luc 06:47, rollup den 06:52 moi
  // chay, Dashboard treo o 94 hoa don trong khi thuc te da la 99.
  scheduleImmediate(run);
  return setIntervalFn(run, intervalMs);
}

async function main() {
  const pool = getPool();
  const results = await refreshDashboardRollups(pool);
  console.log(`[dashboardRollupRefresh] Hoan tat, ${results.length} co so.`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[dashboardRollupRefresh] That bai: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  refreshDashboardRollups,
  refreshDashboardRollupsAndNotify,
  startDashboardRollupSchedule,
  DEFAULT_WINDOW_DAYS,
  HOT_WINDOW_DAYS,
  FIRST_PURCHASE_FULL_INTERVAL_MS,
  __sql__: {
    INVOICE_SUMMARY_SQL, PRODUCT_SALES_SQL, FIRST_PURCHASE_SQL, FIRST_PURCHASE_RECENT_SQL,
    INVOICE_AGG_SQL, PRODUCT_SALES_AGG_SQL
  }
};
