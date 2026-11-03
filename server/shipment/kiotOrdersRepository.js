// ==========================================
// KIOT ORDERS — doc MOI don dat hang cua KiotViet (bang orders/order_details, 2 co so hanoi/saigon,
// moi trang thai: Phieu tam, Da xac nhan, Dang giao hang, Hoan thanh, Da huy) de GOP vao trang "Vong doi
// don hang" cung cac don tu Google Sheet, kem trang thai Kiot, ghi chu va "Gia tri co ban" cua don
// Phieu tam. Chi DOC; khong bao gio ghi vao DB hay Sheet. (Truoc 2026-10-02 module nay chi doc don
// Phieu tam — ten cu kiotPendingOrdersRepository.)
//
// GIA TRI CO BAN (quyet dinh cua nguoi dung 2026-10-02, thay cong thuc 2026-10-01): voi moi mat hang
// trong don Phieu tam,
//   so ban duoc = min(SL dat, max(0, TON THUC cua dung Kiot cua don))
//   gia tri     = so ban duoc x don gia sau chiet khau dong (price - discount)
// va cong tat ca mat hang. KHONG tinh hang dang van chuyen (cot "Dieu chuyen SG" chi de tham khao) va
// KHONG tru cac don Phieu tam khac. Don KHAC Phieu tam (da xac nhan/giao/hoan thanh/huy) khong co gia
// tri co ban (ton hien tai khong con y nghia voi don da xuat). Ton thuc = tong `inventories[].onHand`
// cua san pham trong retailer cua don. Dong ma "VAT..." la dong thue, khong phai hang ton kho — bo khoi
// phep tinh (nhu dashboardData).
//
// Doc ~60 nghin don (do that 2026-10-02: 1,8-2,2 giay, ~17 MB JSON tho) nen:
//   - cache TTL 2 phut + STALE-WHILE-REVALIDATE: het TTL thi tra ngay ban cu va lam moi o nen (nguoi
//     dung khong phai cho 2-6 giay), chi cho khi chua co ban nao hoac ban qua cu (staleMs);
//   - single-flight (nhieu nguoi mo trang cung luc chi 1 lan doc DB);
//   - FAIL-SOFT: loi Postgres KHONG duoc lam hong trang (van hien du lieu Sheet): tra {ok:false},
//     hoac ban cu (toi da staleMs) danh dau stale neu co.
// Chi cac dong hang cua don Phieu tam moi duoc doc (bo loc statusValue khop index mot phan 0028).
// ==========================================
'use strict';

const { getPool } = require('../db/pool');
const { readInTransitByCode } = require('../dashboard/inTransitSource');
const { saleNameSql, saleTelegramIdSql } = require('../dashboard/saleName');
const { getOrderDetail } = require('../dashboard/documentDetailRepository');
const measureSheet = require('./measureSheet');
const { buildOrderFreight } = require('./freightCalculator');

// Nhan co so cua Vong doi don hang ('HN'|'SG', nhan tab nguon Sheets) <-> ma co so trong DB.
// RIENG cho tinh nang nay, KHONG tron voi branch/branches.js (xem memory ve 3 he dinh danh co so).
const LIFECYCLE_TO_DB_BRANCH = Object.freeze({ HN: 'hanoi', SG: 'saigon' });
const DB_TO_LIFECYCLE_BRANCH = Object.freeze({ hanoi: 'HN', saigon: 'SG' });

const PHIEU_TAM = 'Phiếu tạm';
// Quyet dinh cua nguoi dung 2026-10-13: Vong doi chi hien don dat tu ngay nay tro di; don truoc ngay nay bi
// bo (TRU don Phieu tam: giu ca don cu vi con phai xu ly). Ngay tinh theo gio VN (xem AT TIME ZONE 'UTC').
const LIFECYCLE_ORDER_FROM = '2026-10-10';
const DEFAULT_TTL_MS = 2 * 60 * 1000;
const DEFAULT_STALE_MS = 15 * 60 * 1000;
// Sau 1 lan lam moi nen that bai, doi it nhat chung nay moi thu lai (tranh moi request deu goi DB dang loi).
const RETRY_BACKOFF_MS = 15 * 1000;
// Lam moi TANG DAN (2026-10-19): chi doc don co modified_date >= watermark - DELTA_OVERLAP_MS (chong lech dong
// ho / commit muon); moi FULL_RECONCILE_MS lai doc DAY DU 1 lan de bat don bi xoa, doi ten nhan vien, don roi
// khoi pham vi (vd Phieu tam cu chuyen sang Da huy).
const FULL_RECONCILE_MS = 30 * 60 * 1000;
const DELTA_OVERLAP_MS = 2 * 60 * 1000;

function makeError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

/** Dong ma VAT* la dong thue, khong phai hang ton kho. */
function isServiceProductKey(productKey) {
  return String(productKey || '').startsWith('vat');
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

// Ma hang duoc so khop theo chu thuong da trim (giong IN_TRANSIT_SQL / product_report).
function productKeyOf(code) {
  return String(code == null ? '' : code).trim().toLowerCase();
}

/**
 * HAM THUAN. Chia "so ban duoc" cho tung dong don.
 * @param lines [{ orderKey, productKey, quantity, amount }] — amount = (price - discount) * quantity
 * @param availableOf (line) => so luong CO THE CAP (ton thuc, co the am)
 * @returns mang song song voi `lines`: { sellableQty, sellableAmount } (null voi dong thue/khong co ma)
 *
 * Cung 1 san pham xuat hien nhieu dong trong cung 1 don thi gop lai de TON CHI BI TINH 1 LAN:
 * ti le co ban = min(1, ton cap / tong SL cua san pham do trong don), chia deu cho cac dong.
 */
function allocateSellable(lines, availableOf) {
  const out = lines.map(() => ({ sellableQty: null, sellableAmount: null }));
  const groups = new Map(); // orderKey + productKey -> { quantity, indexes[] }
  lines.forEach((line, index) => {
    if (!line.productKey || isServiceProductKey(line.productKey)) return;
    const key = `${line.orderKey}\u0000${line.productKey}`;
    let group = groups.get(key);
    if (!group) { group = { quantity: 0, indexes: [] }; groups.set(key, group); }
    group.quantity += toNumber(line.quantity);
    group.indexes.push(index);
  });
  groups.forEach(group => {
    const available = Math.max(0, toNumber(availableOf(lines[group.indexes[0]])));
    const ratio = group.quantity > 0 ? Math.min(1, available / group.quantity) : 0;
    group.indexes.forEach(index => {
      out[index] = {
        sellableQty: toNumber(lines[index].quantity) * ratio,
        sellableAmount: toNumber(lines[index].amount) * ratio
      };
    });
  });
  return out;
}

// Dau don CUA MOI TRANG THAI (khong dong hang): trang thai Kiot + ghi chu + khach + sale. Sale lay tu
// o.raw soldByName, thieu thi bang staff, roi cat ID Telegram (dashboard/saleName.js). Ngay dat doc bang
// Ten khach: uu tien TEN HIEN TAI o bang customers (doi ten tren Kiot thi hien ngay), ten tren don chi la du phong.
// AT TIME ZONE 'UTC' ("gio treo tuong VN mang nhan UTC", xem dashboardPgReader.js).
const ALL_ORDERS_SQL = `
  SELECT
    o.branch,
    o.id AS order_id,
    o.code,
    COALESCE(o.total, 0)::float8 AS total,
    COALESCE(to_char(o.order_date AT TIME ZONE 'UTC', 'DD/MM/YYYY HH24:MI'), '') AS order_date_text,
    COALESCE(to_char(o.order_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS'), '') AS order_date_key,
    COALESCE(NULLIF(c.name, ''), NULLIF(o.raw->>'customerName', ''), 'Khách lẻ') AS customer_name,
    ${saleNameSql(`COALESCE(NULLIF(o.raw->>'soldByName', ''), s.name, '')`)} AS sale_name,
    ${saleTelegramIdSql(`COALESCE(NULLIF(o.raw->>'soldByName', ''), s.name, '')`)} AS sale_telegram_id,
    COALESCE(o.raw->>'statusValue', '') AS kiot_status,
    COALESCE(o.raw->>'description', '') AS note,
    o.modified_date
  FROM orders o
  LEFT JOIN staff s ON s.branch = o.branch AND s.id = o.sold_by_id
  LEFT JOIN customers c ON c.branch = o.branch AND c.id = o.customer_id
  WHERE (o.raw->>'statusValue' = '${PHIEU_TAM}'
     OR o.order_date IS NULL
     OR (o.order_date AT TIME ZONE 'UTC') >= TIMESTAMP '${LIFECYCLE_ORDER_FROM} 00:00:00')`;

// Ban tang dan: them dieu kien modified_date ($1 = watermark - chong lan). Dong modified_date NULL luon lay lai
// (khong co dau hieu doi). Dung index idx_orders_modified (branch, modified_date).
const DELTA_ORDERS_SQL = `${ALL_ORDERS_SQL}
    AND (o.modified_date >= $1::timestamptz OR o.modified_date IS NULL)`;

// Dong hang cua CAC DON PHIEU TAM (de tinh gia tri co ban). Bieu thuc loc statusValue GIU NGUYEN (khong
// COALESCE) de trung dieu kien index mot phan 0028. Thanh tien dong = (price - discount) x quantity vi
// order_details.raw.subTotal luon 0.
const PENDING_LINES_SQL = `
  SELECT
    o.branch,
    o.id AS order_id,
    btrim(COALESCE(NULLIF(d.raw->>'productCode', ''), p.code, '')) AS product_code,
    COALESCE(d.quantity, 0)::float8 AS quantity,
    (COALESCE(d.price, 0)::float8 - COALESCE(d.discount, 0)::float8) * COALESCE(d.quantity, 0)::float8 AS amount
  FROM orders o
  JOIN order_details d ON d.branch = o.branch AND d.order_id = o.id
  LEFT JOIN products p ON p.branch = d.branch AND p.id = d.product_id
  WHERE o.raw->>'statusValue' = 'Phiếu tạm'
  ORDER BY o.branch, o.id, d.line_no`;

// Ton thuc theo ma hang cua 1 co so (retailer): tong `inventories[].onHand` (moi retailer chi co 1 kho
// "Chi nhanh trung tam"). Loc bang `p.code = ANY(...)` de dung unique index (branch, code).
const ON_HAND_BY_CODE_SQL = `
  SELECT p.code AS code, COALESCE(SUM((inv->>'onHand')::numeric), 0)::float8 AS on_hand
  FROM products p
  LEFT JOIN LATERAL jsonb_array_elements(COALESCE(p.raw->'inventories', '[]'::jsonb)) inv ON true
  WHERE p.branch = $1 AND p.code = ANY($2::text[])
  GROUP BY p.code`;

async function readOnHandByKey(db, dbBranch, productCodes) {
  const codes = [...new Set(productCodes.filter(Boolean))];
  const byKey = new Map();
  if (codes.length === 0) return byKey;
  const result = await db.query(ON_HAND_BY_CODE_SQL, [dbBranch, codes]);
  for (const row of (result && result.rows) || []) byKey.set(productKeyOf(row.code), toNumber(row.on_hand));
  return byKey;
}

/**
 * @param {object} [options]
 * @param {object|function} [options.pool] pool (hoac ham tra pool); mac dinh getPool() luc goi.
 * @param {function} [options.now] dong ho (ms) — test tiem vao.
 * @param {number} [options.ttlMs] thoi gian cache; {number} [options.staleMs] toi da dung ban cu khi loi / lam moi nen.
 * @param {function} [options.readInTransit] doc hang dang van chuyen (chi de HIEN THI o chi tiet don).
 * @param {function} [options.fetchOrderDetail] doc 1 don (mac dinh documentDetailRepository.getOrderDetail).
 */
function createKiotOrdersRepository({
  pool,
  now = () => Date.now(),
  ttlMs = DEFAULT_TTL_MS,
  staleMs = DEFAULT_STALE_MS,
  readInTransit = readInTransitByCode,
  fetchOrderDetail = getOrderDetail,
  lookupMeasures = measureSheet.lookup
} = {}) {
  const getDb = () => (typeof pool === 'function' ? pool() : (pool || getPool()));
  let cache = null; // { result, at, failed }
  let inflight = null;
  let nextTryAt = 0;

  // Trang thai tang dan. ordersByKey: `${db branch}|${order_id}` -> { order (chua co sellableValue), dateKey, pending }.
  let ordersByKey = null;
  let watermark = null; // ms: max modified_date da thay
  let lastFullAt = 0;
  let forceFull = true;

  function toMs(value) {
    if (value == null || value === '') return null;
    const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }

  function inScope(entry) {
    return entry.pending || entry.dateKey === '' || entry.dateKey >= `${LIFECYCLE_ORDER_FROM}T00:00:00`;
  }

  async function queryOrders() {
    const db = getDb();
    const full = forceFull || !ordersByKey || watermark === null || now() - lastFullAt >= FULL_RECONCILE_MS;
    const headersPromise = full
      ? db.query(ALL_ORDERS_SQL)
      : db.query(DELTA_ORDERS_SQL, [new Date(watermark - DELTA_OVERLAP_MS).toISOString()]);
    const [headersResult, linesResult] = await Promise.all([headersPromise, db.query(PENDING_LINES_SQL)]);

    // Gop vao ban sao cua map (chi gan lai khi moi truy van thanh cong, de loi giua chung khong lam hong trang thai).
    const nextMap = full ? new Map() : new Map(ordersByKey);
    let nextWatermark = full ? null : watermark;
    const headerRows = (headersResult && headersResult.rows) || [];
    for (const row of headerRows) {
      const key = `${row.branch}|${row.order_id}`;
      const entry = {
        dateKey: row.order_date_key || '',
        pending: row.kiot_status === PHIEU_TAM,
        order: {
          branch: DB_TO_LIFECYCLE_BRANCH[row.branch] || '',
          code: String(row.code || ''),
          customerName: row.customer_name || '',
          saleName: row.sale_name || '',
          // ID Telegram cat khoi ten (dashboard/saleName.js) — chi tiet don hien them ben canh ten nhu Kiot.
          saleTelegramId: row.sale_telegram_id || '',
          orderDate: row.order_date_text || '',
          total: toNumber(row.total),
          kiotStatus: row.kiot_status || '',
          note: row.note || ''
        }
      };
      // Ban day du da loc pham vi bang SQL; ban tang dan loai them don nao khong con trong pham vi.
      if (full || inScope(entry)) nextMap.set(key, entry); else nextMap.delete(key);
      const ms = toMs(row.modified_date);
      if (ms !== null && (nextWatermark === null || ms > nextWatermark)) nextWatermark = ms;
    }

    // Gia tri co ban cua don Phieu tam: ton thuc theo (co so, ma). Phu thuoc TON KHO (khong theo modified_date)
    // nen moi lan lam moi (ca tang dan) doc lai dong hang + ton va tinh lai cho MOI don Phieu tam trong map.
    const lineRows = (linesResult && linesResult.rows) || [];
    const codesByBranch = new Map();
    for (const row of lineRows) {
      if (!row.product_code) continue;
      if (!codesByBranch.has(row.branch)) codesByBranch.set(row.branch, []);
      codesByBranch.get(row.branch).push(row.product_code);
    }
    const onHandByBranch = new Map();
    await Promise.all([...codesByBranch.entries()].map(async ([dbBranch, codes]) => {
      onHandByBranch.set(dbBranch, await readOnHandByKey(db, dbBranch, codes));
    }));

    const lines = lineRows
      .filter(row => row.product_code)
      .map(row => ({
        orderKey: `${row.branch}|${row.order_id}`,
        dbBranch: row.branch,
        productKey: productKeyOf(row.product_code),
        quantity: toNumber(row.quantity),
        amount: toNumber(row.amount)
      }));
    const allocation = allocateSellable(lines, line => (onHandByBranch.get(line.dbBranch) || new Map()).get(line.productKey) || 0);
    const sellableByOrder = new Map();
    lines.forEach((line, index) => {
      const part = allocation[index];
      if (!part || part.sellableAmount === null) return;
      sellableByOrder.set(line.orderKey, (sellableByOrder.get(line.orderKey) || 0) + part.sellableAmount);
    });

    // Moi lan 1 doi tuong don MOI (ban cu da giao cho nguoi goi, khong sua tai cho). Chi don Phieu tam co gia tri
    // co ban (0 neu chua co dong hang); don khac = null. Sap moi nhat truoc theo ngay dat THAT (khong theo chuoi
    // hien thi), cung ngay thi theo ma.
    const items = [...nextMap.entries()].map(([key, entry]) => ({
      key: entry.dateKey,
      order: { ...entry.order, sellableValue: entry.pending ? Math.round(sellableByOrder.get(key) || 0) : null }
    }));
    items.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : a.order.code.localeCompare(b.order.code)));

    ordersByKey = nextMap;
    watermark = nextWatermark;
    if (full) lastFullAt = now();
    forceFull = false;
    return { ok: true, stale: false, fetchedAt: new Date(now()).toISOString(), orders: items.map(item => item.order) };
  }

  function view(entry) {
    return entry.failed ? { ...entry.result, stale: true } : entry.result;
  }

  /** Doc lai tu DB (single-flight). KHONG nem: loi -> ban cu <= staleMs (stale) hoac { ok:false }. */
  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const result = await queryOrders();
        cache = { result, at: now(), failed: false };
        nextTryAt = 0;
        return result;
      } catch (error) {
        console.warn('[Lifecycle] Không đọc được đơn từ Kiot (hiển thị dữ liệu Sheet):', error.message);
        forceFull = true; // lan sau doc day du, khong tin trang thai tang dan
        nextTryAt = now() + RETRY_BACKOFF_MS;
        if (cache && now() - cache.at < staleMs) {
          cache.failed = true;
          return view(cache);
        }
        return { ok: false, stale: false, fetchedAt: null, orders: [], error: error.message };
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /**
   * Moi don cua ca 2 co so (moi trang thai) kem gia tri co ban (don Phieu tam). KHONG BAO GIO throw:
   * { ok, stale, fetchedAt, orders[] } voi moi don { branch:'HN'|'SG', code, customerName, saleName, orderDate
   * ('dd/MM/yyyy HH:mm'), total, kiotStatus, note, sellableValue (so | null) }, moi nhat truoc.
   * Con han cache -> tra ngay; het han nhung con ban <= staleMs -> tra ban cu ngay + lam moi nen.
   */
  async function readOrders() {
    const current = now();
    if (cache && current - cache.at < ttlMs) return view(cache);
    if (cache && current - cache.at < staleMs) {
      if (!inflight && current >= nextTryAt) refresh();
      return view(cache);
    }
    return refresh();
  }

  function invalidate() { cache = null; nextTryAt = 0; forceFull = true; }

  // Picking needs only one code. Query both retailers so the shared accounting
  // sheet can select its branch using the same rules as the full lifecycle list.
  async function readOrderHeaders(code) {
    const target = String(code ?? '').trim().toLowerCase();
    if (!target) return [];
    const { rows } = await getDb().query(`${ALL_ORDERS_SQL}
      AND lower(btrim(o.code)) = $1`, [target]);
    return rows.map(row => ({
      branch: DB_TO_LIFECYCLE_BRANCH[row.branch] || '',
      code: String(row.code || ''),
      customerName: row.customer_name || '', saleName: row.sale_name || '',
      saleTelegramId: row.sale_telegram_id || '', orderDate: row.order_date_text || '',
      total: toNumber(row.total), kiotStatus: row.kiot_status || '', note: row.note || '',
      sellableValue: null
    }));
  }

  async function readPickingDetail({branch, code}) {
    const branchCode = LIFECYCLE_TO_DB_BRANCH[branch];
    if (!branchCode) throw makeError('Cơ sở không hợp lệ (HN hoặc SG).', 400, 'INVALID_BRANCH');
    return fetchOrderDetail({code, branchCode, pool:getDb()});
  }

  /**
   * Chi tiet 1 don cho hop thoai: dau chung + dong hang (documentDetailRepository.getOrderDetail), voi
   * don dang Phieu tam them ton thuc / dieu chuyen SG (hang dang van chuyen — chi hien thi) / so co ban
   * tung dong. Don khac trang thai Phieu tam: cac cot ton = null (ton hien tai khong co y nghia voi don da
   * xuat). Nem loi 400/404 cua getOrderDetail.
   */
  async function readOrderDetail({ branch, code }) {
    const dbBranch = LIFECYCLE_TO_DB_BRANCH[branch];
    if (!dbBranch) throw makeError('Cơ sở không hợp lệ (HN hoặc SG).', 400, 'INVALID_BRANCH');
    const db = getDb();
    let detail;
    try {
      detail = await fetchOrderDetail({ code, branchCode: dbBranch, pool: db });
    } catch (error) {
      // getOrderDetail nem 400/404 khong kem `code`; gan ma de route tra {error, code} nhat quan.
      if (error && error.statusCode === 404 && !error.code) error.code = 'ORDER_NOT_FOUND';
      if (error && error.statusCode === 400 && !error.code) error.code = 'INVALID_REQUEST';
      throw error;
    }
    const isPending = detail.status === PHIEU_TAM;
    const orderLines = Array.isArray(detail.lines) ? detail.lines : [];

    let stock = null;
    if (isPending) {
      const [onHandByKey, inTransitByCode] = await Promise.all([
        readOnHandByKey(db, dbBranch, orderLines.map(line => String(line.productCode || '').trim())),
        readInTransit(db)
      ]);
      stock = { onHandByKey, inTransitByCode };
    }
    const allocation = isPending
      ? allocateSellable(
        orderLines.map(line => ({
          orderKey: 'detail', productKey: productKeyOf(line.productCode), quantity: line.quantity, amount: line.amount
        })),
        line => stock.onHandByKey.get(line.productKey) || 0
      )
      : [];

    let sellableValue = 0;
    const lines = orderLines.map((line, index) => {
      const key = productKeyOf(line.productCode);
      const part = allocation[index] || { sellableQty: null, sellableAmount: null };
      const isService = isServiceProductKey(key);
      if (part.sellableAmount !== null) sellableValue += part.sellableAmount;
      return {
        ...line,
        isService,
        onHand: isPending && !isService ? (stock.onHandByKey.get(key) || 0) : null,
        inTransit: isPending && !isService ? (stock.inTransitByCode.get(key) || 0) : null,
        sellableQty: part.sellableQty,
        sellableAmount: part.sellableAmount === null ? null : Math.round(part.sellableAmount)
      };
    });
    // The tich + cuoc (sheet CAN DO). FAIL-SOFT: loi Sheets khong lam hong hop chi tiet.
    let freight;
    let lineMeasures = null;
    try {
      const codes = lines.filter(line => !line.isService).map(line => line.productCode);
      const built = buildOrderFreight(lines, await lookupMeasures(codes));
      freight = built.freight;
      lineMeasures = built.lineMeasures;
    } catch (error) {
      console.warn('[KiotOrders] measure unavailable:', error.code || error.message);
      freight = { unavailable: true, message: error.statusCode === 503 ? error.message : 'Không tính được thể tích và cước lúc này.' };
    }
    return {
      ...detail,
      branch,
      phieuTam: isPending,
      lines: lineMeasures ? lines.map((line, index) => ({ ...line, measure: lineMeasures[index] })) : lines,
      freight,
      sellableValue: isPending ? Math.round(sellableValue) : null
    };
  }

  return { readOrders, readOrderDetail, readOrderHeaders, readPickingDetail, invalidate };
}

// Instance mac dinh dung pool that (getPool() duoc goi luc can, khong luc nap module).
const kiotOrders = createKiotOrdersRepository();

module.exports = {
  createKiotOrdersRepository,
  kiotOrders,
  LIFECYCLE_TO_DB_BRANCH,
  DB_TO_LIFECYCLE_BRANCH,
  __test__: { LIFECYCLE_ORDER_FROM, allocateSellable, productKeyOf, isServiceProductKey, ALL_ORDERS_SQL, DELTA_ORDERS_SQL, FULL_RECONCILE_MS, PENDING_LINES_SQL, ON_HAND_BY_CODE_SQL }
};
