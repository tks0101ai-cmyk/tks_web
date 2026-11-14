'use strict';

// Luat nghiep vu Yeu cau xuat VAT (thay sheet ORDER VAT 1). Kiem tra TAT CA o day — giao
// dien chi an nut cho tien.
//   - Truong cua sale / cua KT la 2 whitelist rieng; gui truong ngoai whitelist -> 403.
//   - Sale chi sua / xoa yeu cau CUA MINH va khi chua khoa (status 0, 1, 2 la khoa).
//   - Sale sua yeu cau dang 3 / 4 -> tu ve 'pending' de KT xu ly lai.
//   - KT (quyen accounting.vatRequestProcess) doi trang thai tu do moi chieu, ke ca mo khoa.
//   - Quan ly sua duoc ca hai nhom truong cua moi yeu cau.
//   - Moi lan luu phai kem `version`; lech -> 409 kem ban moi nhat (optimistic locking).
//   - Moi truong doi deu ghi vat_request_history.

const { getPool } = require('../db/pool');
const { ROLES } = require('../auth/userRepository');
const { hasFeature } = require('../auth/featureRegistry');
const repository = require('./repository');
const { nearestContainer, latestArrived } = require('./etaParser');
const { createStockSource, lookupStock, findSheetProduct, suggestSheetProducts } = require('./stockSource');
const { normalizeSorts } = require('../shared/multiSort');
const { pageRows } = require('../shared/tablePage');

const STATUS_LABELS = Object.freeze({
  pending: 'Chờ KT xử lý',
  0: 'Không khai được',
  5: 'VAT sẵn nhiều',
  1: 'Đã xong',
  2: 'Đã khai chờ về',
  3: 'Chờ khai chèn',
  4: 'Chờ cont về, tăng slg'
});
// '5' (0083) dung ngay sau '0': cung la "khong khai" nhung ma con nhieu hang VAT; thu tu nay = thu tu chip / sap xep.
const STATUSES = Object.freeze(['pending', '0', '5', '1', '2', '3', '4']);
const LOCKED_STATUSES = new Set(['0', '5', '1', '2']);
const REOPEN_ON_SALE_EDIT = new Set(['3', '4']);

// Ten truong API -> cot DB.
const SALE_FIELDS = Object.freeze({
  customerName: 'customer_name',
  customerCode: 'customer_code',
  productCode: 'product_code',
  quantity: 'quantity',
  unitPrice: 'unit_price_excl_vat',
  fullVat: 'full_vat',
  saleNote: 'sale_note'
});
const ACCOUNTANT_FIELDS = Object.freeze({
  status: 'status',
  accountantNote: 'accountant_note',
  arrivalDate: 'arrival_date'
});
const MAX_TEXT = 1000;
// Form nhieu dong: toi da 200 dong / lan gui (giong form Apps Script cu); chong gui trung 6 gio.
const MAX_BATCH_ROWS = 200;
const SUBMISSION_TTL_MS = 6 * 60 * 60 * 1000;

// Phan trang danh sach (slice 6): sap xep / gop theo ma tren TOAN BO ket qua khop bo loc roi moi cat trang.
// Gia tri sap xep giong het sortValueOf o vat-request.js; 5 cot so lieu chi KT (quyen xu ly) moi sap duoc.
const nullable = value => (value === null || value === undefined || value === '' ? null : value);
const SORT_VALUES = Object.freeze({
  createdAt: row => nullable(row.createdAt),
  sale: row => nullable(row.createdByName),
  customer: row => nullable(row.customerName),
  productCode: row => nullable(row.productCode),
  productName: row => nullable(row.productName),
  quantity: row => row.quantity,
  unitPrice: row => row.unitPrice,
  total: row => row.totalAmount,
  fullVat: row => (row.fullVat ? 1 : 0),
  saleNote: row => nullable(row.saleNote),
  status: row => { const index = STATUSES.indexOf(row.status); return index < 0 ? null : index; },
  accountantNote: row => nullable(row.accountantNote),
  arrivalDate: row => nullable(row.arrivalDate),
  vatStock: (row, m) => (m.vatStock ? m.vatStock.total : null),
  pendingQty: (row, m) => m.pendingInsertQty ?? null,
  incomingContainer: (row, m) => nullable(m.incomingContainer),
  containerStatus: (row, m) => nullable(m.containerStatus),
  containerEta: (row, m) => (m.containerEta ? (m.nearestArrivalDate ? 'a' + m.nearestArrivalDate : 'b' + m.containerEta) : null)
});
const METRIC_SORTS = new Set(['vatStock', 'pendingQty', 'incomingContainer', 'containerStatus', 'containerEta']);
const SALE_SORT_KEYS = Object.keys(SORT_VALUES).filter(key => !METRIC_SORTS.has(key));

// Giong TKSTables.compareValues: o trong luon xuong cuoi (khong dao theo chieu), so so voi so, con lai so chu 'vi' numeric.
function compareSortValues(a, b, dir) {
  const emptyA = a === null || a === undefined || a === '' || (typeof a === 'number' && !Number.isFinite(a));
  const emptyB = b === null || b === undefined || b === '' || (typeof b === 'number' && !Number.isFinite(b));
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const result = typeof a === 'number' && typeof b === 'number' ? a - b
    : String(a).localeCompare(String(b), 'vi', { numeric: true, sensitivity: 'base' });
  return result * (dir === 'desc' ? -1 : 1);
}

/** Khong sap / khong gop: giu thu tu may chu (sort_rank hoac diem tim). Tie-break cuoi = id giam dan (on dinh). */
function orderListRows(rows, { sorts, group }, metrics) {
  const metricOf = row => metrics[row.productKey] || {};
  const bySort = (a, b) => {
    for (const { key, dir } of sorts) {
      const result = compareSortValues(SORT_VALUES[key](a, metricOf(a)), SORT_VALUES[key](b, metricOf(b)), dir);
      if (result) return result;
    }
    return 0;
  };
  if (group) {
    return rows.slice().sort((a, b) => String(a.productKey || '').localeCompare(String(b.productKey || ''), 'vi', { numeric: true })
      || bySort(a, b) || String(b.createdAt || '').localeCompare(String(a.createdAt || '')) || b.id - a.id);
  }
  if (!sorts.length) return rows;
  return rows.slice().sort((a, b) => bySort(a, b) || b.id - a.id);
}

function httpError(statusCode, message, code, extra = {}) {
  return Object.assign(new Error(message), { statusCode, code }, extra);
}

function canProcess(user) {
  return hasFeature(user, 'accounting.vatRequestProcess');
}

function isManager(user) {
  return !!user && user.vaiTro === ROLES.QUAN_LY;
}

function isOwner(user, row) {
  return !!(user && row && row.created_by && String(row.created_by) === String(user.id));
}

function isLockedForSale(row) {
  return LOCKED_STATUSES.has(row.status);
}

function canEditSaleFields(user, row) {
  return isManager(user) || (isOwner(user, row) && !isLockedForSale(row));
}

// ---- Kiem tra gia tri ----

function text(value, label, { required = false, max = MAX_TEXT } = {}) {
  if (value === null || value === undefined) value = '';
  if (typeof value !== 'string' && typeof value !== 'number') throw httpError(400, `${label} không hợp lệ.`, 'VALIDATION');
  const result = String(value).trim();
  if (required && !result) throw httpError(400, `Thiếu ${label}.`, 'VALIDATION');
  if (result.length > max) throw httpError(400, `${label} quá dài (tối đa ${max} ký tự).`, 'VALIDATION');
  return result;
}

function positiveNumber(value, label, { integer = false } = {}) {
  const number = typeof value === 'string' ? Number(value.replace(/,/g, '').trim()) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) {
    throw httpError(400, `${label} phải là ${integer ? 'số nguyên ' : 'số '}lớn hơn 0.`, 'VALIDATION');
  }
  return number;
}

function isoDate(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  const date = match && new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (!date || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) {
    throw httpError(400, `${label} phải có dạng YYYY-MM-DD.`, 'VALIDATION');
  }
  return String(value);
}

const VALIDATORS = {
  customerName: value => text(value, 'Khách hàng', { required: true, max: 200 }),
  customerCode: value => text(value, 'Mã khách', { max: 60 }) || null,
  productCode: value => text(value, 'Mã SP', { required: true, max: 60 }),
  quantity: value => positiveNumber(value, 'Số lượng', { integer: true }),
  unitPrice: value => positiveNumber(value, 'Giá chưa VAT'),
  fullVat: value => {
    if (typeof value !== 'boolean') throw httpError(400, 'Full VAT phải là có / không.', 'VALIDATION');
    return value;
  },
  saleNote: value => text(value, 'Ghi chú'),
  status: value => {
    const status = String(value ?? '');
    if (!STATUSES.includes(status)) throw httpError(400, 'Trạng thái không hợp lệ.', 'VALIDATION');
    return status;
  },
  accountantNote: value => text(value, 'Ghi chú KT'),
  arrivalDate: value => isoDate(value, 'Ngày về')
};

function parseVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw httpError(400, 'Thiếu phiên bản dữ liệu (version).', 'VERSION_REQUIRED');
  return version;
}

/** Tach payload thanh thay doi theo nhom; truong la / truong he thong -> 403. */
function splitPayload(payload, allowedGroups) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw httpError(400, 'Dữ liệu gửi lên không hợp lệ.', 'VALIDATION');
  const sale = {};
  const accountant = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'version') continue;
    if (allowedGroups.sale && Object.hasOwn(SALE_FIELDS, key)) sale[key] = VALIDATORS[key](value);
    else if (allowedGroups.accountant && Object.hasOwn(ACCOUNTANT_FIELDS, key)) accountant[key] = VALIDATORS[key](value);
    else throw httpError(403, `Bạn không được sửa trường "${key}".`, 'FIELD_FORBIDDEN', { field: key });
  }
  return { sale, accountant };
}

// ---- Chuyen doi hien thi ----

function historyValue(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function sameValue(column, before, after) {
  if (['quantity', 'unit_price_excl_vat'].includes(column)) {
    return (before === null || before === undefined ? null : Number(before)) === (after === null || after === undefined ? null : Number(after));
  }
  return historyValue(before) === historyValue(after);
}

function toNumber(value) {
  return value === null || value === undefined ? null : Number(value);
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function serializeRow(row, user) {
  const locked = isLockedForSale(row);
  const editSale = canEditSaleFields(user, row);
  return {
    id: Number(row.id),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdByEmail: row.created_by_email,
    isLegacy: !!row.is_legacy,
    customerName: row.customer_name,
    customerCode: row.customer_code,
    productCode: row.product_code,
    productKey: row.product_key,
    productName: row.product_name,
    quantity: toNumber(row.quantity),
    unitPrice: toNumber(row.unit_price_excl_vat),
    totalAmount: toNumber(row.total_amount),
    fullVat: !!row.full_vat,
    saleNote: row.sale_note,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status],
    accountantNote: row.accountant_note,
    arrivalDate: row.arrival_date,
    version: Number(row.version),
    isLockedForSale: locked,
    isMine: isOwner(user, row),
    canEditSale: editSale,
    canProcess: canProcess(user),
    canDelete: editSale
  };
}

// Danh sach / so lieu chi cho Ton VAT (Google Sheets) toi da chung nay: lan doc dau sau khi khoi dong co the
// mat 1-2 phut (file goc VAT TKS) -> tra danh sach truoc, cot Ton VAT bao "dang tai", lan tai sau co so.
const STOCK_WAIT_MS = 3000;

const STOCK_LOADING = Symbol('stock-loading');

function createVatRequestService({ pool = getPool(), stockSource = createStockSource(), now = () => new Date(), stockWaitMs = STOCK_WAIT_MS } = {}) {
  const submissions = new Map(); // `${userId}:${submissionId}` -> { promise, at } (chong gui trung form nhieu dong)
  async function loadOrThrow(db, id, options) {
    const row = await repository.getRequest(db, id, options);
    if (!row) throw httpError(404, 'Không tìm thấy yêu cầu.', 'NOT_FOUND');
    return row;
  }

  /**
   * @param {{ waitMs?: number }} [options] waitMs: cho toi da bay nhieu ms (chi cho so lieu hien thi). Qua han ->
   *   { snapshot: null, status: { available: false, loading: true } }; lan doc van chay tiep (cache dung chung).
   *   Bo trong = cho den khi xong (tra ma SP khi tao yeu cau can danh muc day du).
   */
  async function readStock({ waitMs } = {}) {
    const pending = Promise.resolve().then(() => stockSource.get());
    try {
      let timer;
      const snapshot = !(waitMs >= 0) ? await pending : await Promise.race([
        pending,
        new Promise(resolve => { timer = setTimeout(resolve, waitMs, STOCK_LOADING); })
      ]).finally(() => clearTimeout(timer));
      if (snapshot === STOCK_LOADING) {
        pending.catch(() => {}); // doc xong (hoac loi) sau: chi de cache, khong ai cho
        return { snapshot: null, status: { available: false, loading: true, error: 'Đang tải tồn VAT từ Google Sheets (file nguồn đang chậm). Cột Tồn VAT sẽ có ở lần tải sau.' } };
      }
      return { snapshot, status: { available: true, stale: !!snapshot.stale, loadedAt: snapshot.loadedAt ? new Date(snapshot.loadedAt).toISOString() : null } };
    } catch (error) {
      return { snapshot: null, status: { available: false, error: error.message } };
    }
  }

  /**
   * Tra ma SP cho ORDER VAT -> Map(lower(btrim(ma)) -> { product_code, product_name }).
   * Uu tien product_report (ma hang KiotViet); ma khong co thi tra tiep sheet Khớp mã / Gộp VAT
   * (ma chi co o KiotViet SG, ngung kinh doanh, ma VAT...). Sheet loi -> chi con ket qua product_report.
   */
  async function resolveProducts(db, codes) {
    const products = await repository.findProducts(db, codes);
    const missing = [...new Set(codes.map(code => String(code || '').trim().toLowerCase()).filter(key => key && !products.has(key)))];
    if (!missing.length) return products;
    const { snapshot } = await readStock();
    for (const key of missing) {
      const entry = findSheetProduct(snapshot, key);
      if (entry) products.set(key, { product_code: entry.code, product_name: entry.name });
    }
    return products;
  }

  async function resolveProduct(db, code) {
    return (await resolveProducts(db, [code])).get(String(code || '').trim().toLowerCase()) || null;
  }

  /**
   * O / P / Q / R / S theo product_key. Q = Ten Cont chua ve som nhat; R/S = Trang thai + Ngay ve cua cont do
   * (het cont chua ve thi cont da ve gan nhat).
   * Chi KT (quyen xu ly) thay 4 so nay: user khac -> metrics rong, stockStatus null, khong doc nguon.
   */
  async function metricsFor(user, productKeys) {
    if (!canProcess(user)) return { metrics: {}, stockStatus: null };
    const keys = [...new Set(productKeys.filter(Boolean))];
    const [pending, incoming, stock] = await Promise.all([
      repository.pendingInsertQuantities(pool, keys),
      repository.incomingContainers(pool, keys),
      readStock({ waitMs: stockWaitMs })
    ]);
    const metrics = {};
    for (const key of keys) {
      const lines = incoming.get(key) || [];
      const arrival = nearestContainer(lines.filter(line => line.status !== 4), { now: now() });
      // Trang thai / ngay ve: cont chua ve som nhat; het cont chua ve thi cont "4. Da ve" gan nhat.
      const shown = arrival.line ? arrival : (latestArrived(lines.filter(line => line.status === 4), { now: now() }) || arrival);
      const cell = value => String(value == null ? '' : value).trim();
      metrics[key] = {
        vatStock: stock.snapshot ? lookupStock(stock.snapshot, key) : null,
        pendingInsertQty: pending.get(key) || 0,
        incomingContainer: arrival.containerName,
        containerStatus: shown.line ? cell(shown.line.statusLabel) : '',
        containerEta: shown.line ? cell(shown.line.eta) : '',
        nearestArrivalDate: shown.date
      };
    }
    return { metrics, stockStatus: stock.status };
  }

  /**
   * filters.paging = { page, pageSize, sorts, group } (route chi dat khi client gui page/pageSize): loc + tim +
   * sap / gop tren TOAN BO dong khop (toi da LIST_LIMIT, nhu truoc) roi moi cat trang. Tra them totalRows / page /
   * pageSize / sorts da nhan / groupCounts (so yeu cau cua tung ma tren toan ket qua). metrics chi gom ma tren trang;
   * so lieu luon tinh tu nguon day du phia may chu (khong tu cac dong cua trang). Khong co paging -> tra du nhu cu.
   */
  async function list(user, filters = {}) {
    const { rows, truncated, rowOrder } = await repository.listRequests(pool, filters);
    const common = sales => ({
      truncated,
      rowOrder: rowOrder !== false, // false = chua ap migration 0079, giao dien an tay nam keo dong
      sales,
      statuses: STATUSES.map(value => ({ value, label: STATUS_LABELS[value], locksSale: LOCKED_STATUSES.has(value) })),
      viewer: { id: user.id, canProcess: canProcess(user), isManager: isManager(user) }
    });
    if (!filters.paging) {
      const [{ metrics, stockStatus }, sales] = await Promise.all([
        metricsFor(user, rows.map(row => row.product_key)),
        repository.listCreators(pool)
      ]);
      return { rows: rows.map(row => serializeRow(row, user)), metrics, stockStatus, ...common(sales) };
    }
    const paging = filters.paging;
    const sorts = normalizeSorts(paging.sorts, canProcess(user) ? Object.keys(SORT_VALUES) : SALE_SORT_KEYS);
    const group = paging.group === true && canProcess(user);
    const serialized = rows.map(row => serializeRow(row, user));
    // Sap theo cot so lieu can so lieu cua MOI dong khop; con lai chi doc so lieu cho cac ma tren trang.
    const needAll = sorts.some(sort => METRIC_SORTS.has(sort.key));
    const all = needAll ? await metricsFor(user, serialized.map(row => row.productKey)) : null;
    const ordered = orderListRows(serialized, { sorts, group }, all ? all.metrics : {});
    const page = pageRows(ordered, { page: paging.page, pageSize: paging.pageSize });
    const pageKeys = [...new Set(page.rows.map(row => row.productKey).filter(Boolean))];
    const { metrics, stockStatus } = all
      ? { metrics: Object.fromEntries(pageKeys.filter(key => all.metrics[key]).map(key => [key, all.metrics[key]])), stockStatus: all.stockStatus }
      : await metricsFor(user, pageKeys);
    let groupCounts;
    if (group) {
      const wanted = new Set(pageKeys);
      groupCounts = {};
      for (const row of ordered) if (wanted.has(row.productKey)) groupCounts[row.productKey] = (groupCounts[row.productKey] || 0) + 1;
    }
    return {
      ...page, sorts, group, ...(groupCounts ? { groupCounts } : {}),
      metrics, stockStatus, ...common(await repository.listCreators(pool))
    };
  }

  /**
   * KT keo 1 hoac nhieu dong: { ids: [tren -> duoi], belowId } dat ca nhom ngay tren dong do, hoac
   * { ids, aboveId } ngay duoi (tha xuong cuoi). Dong roi nhau gom thanh 1 khoi theo thu tu `ids`.
   * Thu tu dung chung cho moi nguoi; khong doi version / khong ghi lich su (khong phai du lieu yeu cau).
   */
  async function move(user, payload = {}) {
    if (!canProcess(user)) throw httpError(403, 'Bạn không có quyền xếp thứ tự ORDER VAT.', 'FEATURE_FORBIDDEN');
    const isId = value => Number.isInteger(value) && value > 0;
    const ids = Array.isArray(payload && payload.ids) ? payload.ids.map(Number) : [];
    if (!ids.length || ids.length > 500 || !ids.every(isId) || new Set(ids).size !== ids.length) {
      throw httpError(400, 'Chọn từ 1 đến 500 yêu cầu để kéo.', 'VALIDATION');
    }
    const neighborOf = value => (value === null || value === undefined ? null : Number(value));
    const belowId = neighborOf(payload.belowId);
    const aboveId = neighborOf(payload.aboveId);
    const given = [belowId, aboveId].filter(value => value !== null);
    if (given.length !== 1 || !isId(given[0]) || ids.includes(given[0])) {
      throw httpError(400, 'Vị trí thả không hợp lệ.', 'VALIDATION');
    }
    let result;
    try {
      result = await repository.withTransaction(pool, client => repository.moveRequests(client, ids, { belowId, aboveId }));
    } catch (error) {
      if (error.code === '42703') throw httpError(409, 'Chưa bật được kéo dòng (cần áp migration 0079).', 'ROW_ORDER_UNAVAILABLE');
      throw error;
    }
    if (!result) throw httpError(404, 'Yêu cầu hoặc dòng bên cạnh vừa bị xóa. Hãy tải lại.', 'NOT_FOUND');
    return { ok: true, before: result.before, after: result.after };
  }

  /** Hoan tac / lam lai keo dong: dat lai dung hang da luu ({ ranks: { id: 'numeric' } }, toi da 500). */
  async function restoreRanks(user, payload = {}) {
    if (!canProcess(user)) throw httpError(403, 'Bạn không có quyền xếp thứ tự ORDER VAT.', 'FEATURE_FORBIDDEN');
    const ranks = payload && payload.ranks && typeof payload.ranks === 'object' && !Array.isArray(payload.ranks) ? payload.ranks : {};
    const entries = Object.entries(ranks);
    const valid = ([id, rank]) => /^[1-9]\d*$/.test(id) && typeof rank === 'string' && /^-?\d{1,20}(\.\d{1,1000})?$/.test(rank);
    if (!entries.length || entries.length > 500 || !entries.every(valid)) throw httpError(400, 'Dữ liệu thứ tự không hợp lệ.', 'VALIDATION');
    try {
      const updated = await repository.withTransaction(pool, client => repository.setRanks(client, ranks));
      return { ok: true, updated };
    } catch (error) {
      if (error.code === '42703') throw httpError(409, 'Chưa bật được kéo dòng (cần áp migration 0079).', 'ROW_ORDER_UNAVAILABLE');
      throw error;
    }
  }

  // Xuat Excel: chi KT (quyen xu ly) va quan ly; cung bo loc voi list() nen khop dung man hinh.
  async function exportList(user, filters = {}) {
    if (!canProcess(user) && !isManager(user)) throw httpError(403, 'Chỉ kế toán hoặc quản lý được xuất Excel ORDER VAT.', 'FEATURE_FORBIDDEN');
    // Luon xuat TOAN BO ket qua cua bo loc (khong cat trang du client co gui page).
    return list(user, { ...filters, paging: null });
  }

  async function get(user, id) {
    return serializeRow(await loadOrThrow(pool, id), user);
  }

  async function create(user, payload) {
    const { sale } = splitPayload(payload, { sale: true });
    for (const key of ['customerName', 'productCode', 'quantity', 'unitPrice']) {
      if (!Object.hasOwn(sale, key)) VALIDATORS[key](undefined);
    }
    const product = await resolveProduct(pool, sale.productCode);
    if (!product) throw httpError(400, `Không tìm thấy mã SP "${sale.productCode}".`, 'PRODUCT_NOT_FOUND');
    const values = {
      created_by: String(user.id),
      created_by_name: user.hoTen || user.username || '',
      created_by_email: user.email || '',
      product_name: product.product_name || ''
    };
    for (const [key, value] of Object.entries(sale)) values[SALE_FIELDS[key]] = value;
    values.product_code = product.product_code;
    const id = await repository.withTransaction(pool, async client => {
      const newId = await repository.insertRequest(client, values);
      await repository.insertHistory(client, [{ requestId: newId, changedBy: user.id, changedByName: values.created_by_name, action: 'create' }]);
      return newId;
    });
    return get(user, id);
  }

  /**
   * Gui nhieu dong hang trong 1 lan (thay form Apps Script cu "ORDER VAT"): moi dong la 1 yeu cau.
   * Kiem tra TAT CA dong truoc; co dong loi -> 400 BATCH_INVALID kem { errors: [{ row, field, message }] }
   * va khong ghi dong nao. Hop le -> ghi het trong 1 transaction.
   * `submissionId` chong gui trung (mat mang roi bam lai): cung tai khoan + cung ma trong 6 gio -> tra
   * lai ket qua lan dau, khong tao them. Luu trong bo nho tien trinh vi web chi chay 1 instance.
   */
  async function createMany(user, payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw httpError(400, 'Dữ liệu gửi lên không hợp lệ.', 'VALIDATION');
    const submissionId = text(payload.submissionId, 'Mã lần gửi', { required: true, max: 100 });
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) throw httpError(400, 'Chưa có dòng hàng nào.', 'VALIDATION');
    if (items.length > MAX_BATCH_ROWS) throw httpError(400, `Mỗi lần gửi tối đa ${MAX_BATCH_ROWS} dòng.`, 'VALIDATION');
    const key = `${user.id}:${submissionId}`;
    pruneSubmissions();
    if (submissions.has(key)) return { ...(await submissions.get(key).promise), duplicate: true };
    const promise = insertBatch(user, items);
    submissions.set(key, { promise, at: now().getTime() });
    try {
      return await promise;
    } catch (error) {
      submissions.delete(key); // loi -> cho phep gui lai cung ma
      throw error;
    }
  }

  function pruneSubmissions() {
    const cutoff = now().getTime() - SUBMISSION_TTL_MS;
    for (const [key, entry] of submissions) if (entry.at < cutoff) submissions.delete(key);
  }

  async function insertBatch(user, items) {
    const errors = [];
    const parsed = items.map((raw, index) => {
      const row = index + 1;
      const sale = {};
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        errors.push({ row, field: null, message: `Dòng ${row}: dữ liệu không hợp lệ.` });
        return null;
      }
      for (const [field, value] of Object.entries(raw)) {
        if (!Object.hasOwn(SALE_FIELDS, field)) { errors.push({ row, field, message: `Dòng ${row}: không được gửi trường "${field}".` }); continue; }
        try { sale[field] = VALIDATORS[field](value); } catch (error) { errors.push({ row, field, message: `Dòng ${row}: ${error.message}` }); }
      }
      for (const field of ['customerName', 'productCode', 'quantity', 'unitPrice']) {
        if (Object.hasOwn(sale, field) || errors.some(e => e.row === row && e.field === field)) continue;
        try { VALIDATORS[field](undefined); } catch (error) { errors.push({ row, field, message: `Dòng ${row}: ${error.message}` }); }
      }
      // Form nhieu dong: sale phai tu chon Full VAT / Khong full VAT cho TUNG dong (khong mac dinh).
      if (!Object.hasOwn(sale, 'fullVat') && !errors.some(e => e.row === row && e.field === 'fullVat')) {
        errors.push({ row, field: 'fullVat', message: `Dòng ${row}: chưa chọn Full VAT / Chưa VAT.` });
      }
      return sale;
    });
    const products = await resolveProducts(pool, parsed.filter(Boolean).map(sale => sale.productCode));
    parsed.forEach((sale, index) => {
      if (!sale || !sale.productCode) return;
      if (!products.has(sale.productCode.trim().toLowerCase())) {
        errors.push({ row: index + 1, field: 'productCode', message: `Dòng ${index + 1}: không tìm thấy mã SP "${sale.productCode}".` });
      }
    });
    if (errors.length) {
      const rows = new Set(errors.map(e => e.row)).size;
      throw httpError(400, `${rows} dòng chưa hợp lệ, chưa gửi dòng nào.`, 'BATCH_INVALID', { errors: errors.sort((a, b) => a.row - b.row) });
    }
    const createdByName = user.hoTen || user.username || '';
    const ids = await repository.withTransaction(pool, async client => {
      const created = [];
      for (const sale of parsed) {
        const product = products.get(sale.productCode.trim().toLowerCase());
        const values = { created_by: String(user.id), created_by_name: createdByName, created_by_email: user.email || '', product_name: product.product_name || '' };
        for (const [field, value] of Object.entries(sale)) values[SALE_FIELDS[field]] = value;
        values.product_code = product.product_code;
        const id = await repository.insertRequest(client, values);
        await repository.insertHistory(client, [{ requestId: id, changedBy: user.id, changedByName: createdByName, action: 'create' }]);
        created.push(Number(id));
      }
      return created;
    });
    return { created: ids.length, ids, duplicate: false };
  }

  /** Thong tin cho tung dong cua form nhieu dong: ten SP, O/P/Q/R, gia VAT gan nhat — 1 lan goi cho ca bang. */
  async function lookupProducts(user, codes) {
    const list = (Array.isArray(codes) ? codes : []).map(code => String(code || '').trim()).filter(Boolean).slice(0, MAX_BATCH_ROWS);
    const products = await resolveProducts(pool, list);
    const keys = [...products.keys()];
    const [{ metrics, stockStatus }, prices] = await Promise.all([metricsFor(user, keys), repository.latestProductPrices(pool, keys)]);
    const results = {};
    for (const code of list) {
      const key = code.toLowerCase();
      const product = products.get(key);
      if (!product) { results[key] = { found: false }; continue; }
      const price = prices.get(key);
      results[key] = {
        found: true, productCode: product.product_code, productName: product.product_name, ...metrics[key],
        latestOrder: price ? { price: Number(price.price), customerName: price.customer_name, createdAt: toIso(price.created_at) } : null
      };
    }
    return { results, stockStatus };
  }

  async function conflict(user, id) {
    const latest = await repository.getRequest(pool, id);
    if (!latest) return httpError(404, 'Yêu cầu đã bị xóa.', 'NOT_FOUND');
    return httpError(409, 'Yêu cầu vừa được người khác cập nhật. Dữ liệu mới nhất đã được tải lại.', 'VERSION_CONFLICT', { latest: serializeRow(latest, user) });
  }

  /**
   * Ap thay doi vao 1 dong da khoa FOR UPDATE; tra { changes, history } (rong neu khong co gi doi).
   * Kiem tra quyen theo trang thai HIEN TAI cua dong (khong tin du lieu client).
   */
  async function planChanges(client, user, row, { sale, accountant }) {
    if (Object.keys(sale).length && !canEditSaleFields(user, row)) {
      if (!isOwner(user, row) && !isManager(user)) throw httpError(403, 'Bạn chỉ được sửa yêu cầu của chính mình.', 'NOT_OWNER');
      throw httpError(403, 'Yêu cầu đã bị khóa vì kế toán đã xử lý.', 'LOCKED');
    }
    if (Object.keys(accountant).length && !canProcess(user)) {
      throw httpError(403, 'Bạn không có quyền xử lý ORDER VAT.', 'FEATURE_FORBIDDEN');
    }
    const changes = {};
    for (const [key, value] of Object.entries(sale)) {
      const column = SALE_FIELDS[key];
      if (!sameValue(column, row[column], value)) changes[column] = value;
    }
    if (changes.product_code !== undefined) {
      const product = await resolveProduct(client, changes.product_code);
      if (!product) throw httpError(400, `Không tìm thấy mã SP "${changes.product_code}".`, 'PRODUCT_NOT_FOUND');
      if (product.product_code === row.product_code) delete changes.product_code;
      else { changes.product_code = product.product_code; changes.product_name = product.product_name || ''; }
    }
    const saleChanged = Object.keys(changes).length > 0;
    for (const [key, value] of Object.entries(accountant)) {
      const column = ACCOUNTANT_FIELDS[key];
      if (!sameValue(column, row[column], value)) changes[column] = value;
    }
    if (saleChanged && REOPEN_ON_SALE_EDIT.has(row.status) && !Object.hasOwn(accountant, 'status')) {
      changes.status = 'pending';
    }
    const history = Object.entries(changes)
      .filter(([column]) => column !== 'product_name')
      .map(([column, value]) => ({
        requestId: row.id, changedBy: user.id, changedByName: user.hoTen || user.username || '', action: 'update',
        field: column, oldValue: historyValue(row[column]), newValue: historyValue(value)
      }));
    return { changes, history };
  }

  async function update(user, id, payload) {
    const version = parseVersion(payload && payload.version);
    const groups = splitPayload(payload, { sale: true, accountant: true });
    const result = await repository.withTransaction(pool, async client => {
      const row = await loadOrThrow(client, id, { forUpdate: true });
      if (Number(row.version) !== version) return { conflict: true };
      const { changes, history } = await planChanges(client, user, row, groups);
      if (!Object.keys(changes).length) return { unchanged: true };
      if (!await repository.updateRequest(client, id, changes, version)) return { conflict: true };
      await repository.insertHistory(client, history);
      return { updated: true };
    });
    if (result.conflict) throw await conflict(user, id);
    return get(user, id);
  }

  /**
   * KT doi trang thai / ghi chu / ngay ve cho nhieu dong; 1 dong lech version -> huy ca lo (409).
   * Moi item { id, version, changes? }: thay doi cua dong = changes chung + changes rieng (keo / dan
   * kieu Sheet gui gia tri khac nhau tung dong). Tra them `rows` (ban moi) de giao dien hoan tac.
   */
  async function bulkUpdate(user, payload) {
    if (!canProcess(user)) throw httpError(403, 'Bạn không có quyền xử lý ORDER VAT.', 'FEATURE_FORBIDDEN');
    const items = Array.isArray(payload && payload.items) ? payload.items : [];
    if (!items.length || items.length > 500) throw httpError(400, 'Chọn từ 1 đến 500 yêu cầu.', 'VALIDATION');
    const shared = splitPayload(payload.changes || {}, { accountant: true }).accountant;
    const targets = items.map(item => ({
      id: Number(item && item.id),
      version: parseVersion(item && item.version),
      accountant: { ...shared, ...splitPayload((item && item.changes) || {}, { accountant: true }).accountant }
    }));
    if (targets.some(item => !Number.isInteger(item.id) || item.id < 1)) throw httpError(400, 'Mã yêu cầu không hợp lệ.', 'VALIDATION');
    if (targets.every(item => !Object.keys(item.accountant).length)) throw httpError(400, 'Chưa chọn thay đổi nào.', 'VALIDATION');
    const result = await repository.withTransaction(pool, async client => {
      const conflicts = [];
      const updatedIds = [];
      for (const target of targets) {
        const row = await repository.getRequest(client, target.id, { forUpdate: true });
        if (!row || Number(row.version) !== target.version) { conflicts.push(target.id); continue; }
        const { changes, history } = await planChanges(client, user, row, { sale: {}, accountant: target.accountant });
        if (!Object.keys(changes).length) continue;
        await repository.updateRequest(client, target.id, changes, target.version);
        await repository.insertHistory(client, history);
        updatedIds.push(target.id);
      }
      if (conflicts.length) throw httpError(409, `${conflicts.length} yêu cầu vừa được người khác cập nhật. Hãy tải lại rồi thử lại.`, 'VERSION_CONFLICT', { conflictIds: conflicts });
      return { updatedIds };
    });
    const rows = await Promise.all(result.updatedIds.map(id => repository.getRequest(pool, id)));
    return { updated: result.updatedIds.length, rows: rows.filter(Boolean).map(row => serializeRow(row, user)) };
  }

  async function remove(user, id, versionValue) {
    const version = parseVersion(versionValue);
    const result = await repository.withTransaction(pool, async client => {
      const row = await loadOrThrow(client, id, { forUpdate: true });
      if (Number(row.version) !== version) return { conflict: true };
      if (!canEditSaleFields(user, row)) {
        if (!isOwner(user, row) && !isManager(user)) throw httpError(403, 'Bạn chỉ được xóa yêu cầu của chính mình.', 'NOT_OWNER');
        throw httpError(403, 'Yêu cầu đã bị khóa vì kế toán đã xử lý.', 'LOCKED');
      }
      await client.query('UPDATE vat_requests SET is_deleted = true, version = version + 1, updated_at = now() WHERE id = $1', [id]);
      await repository.insertHistory(client, [{ requestId: row.id, changedBy: user.id, changedByName: user.hoTen || user.username || '', action: 'delete' }]);
      return { deleted: true };
    });
    if (result.conflict) throw await conflict(user, id);
    return { ok: true };
  }

  async function history(user, id) {
    await loadOrThrow(pool, id);
    const rows = await repository.listHistory(pool, id);
    return rows.map(row => ({
      id: Number(row.id),
      changedAt: toIso(row.changed_at),
      changedBy: row.changed_by,
      changedByName: row.changed_by_name,
      action: row.action,
      field: row.field,
      oldValue: row.old_value,
      newValue: row.new_value
    }));
  }

  async function productMetrics(user, productCode) {
    const product = await resolveProduct(pool, productCode);
    if (!product) throw httpError(404, 'Không tìm thấy mã SP.', 'PRODUCT_NOT_FOUND');
    const key = product.product_code.trim().toLowerCase();
    const { metrics, stockStatus } = await metricsFor(user, [key]);
    return { productCode: product.product_code, productName: product.product_name, ...metrics[key], stockStatus };
  }

  async function suggestProducts(query, limit) {
    const q = String(query || '').trim().slice(0, 60);
    if (!q) return [];
    const max = Math.min(Math.max(Number(limit) || 10, 1), 30);
    const rows = await repository.suggestProducts(pool, q, max);
    const results = rows.map(row => ({ code: row.product_code, name: row.product_name }));
    if (results.length >= max) return results;
    // Bo sung ma chi co trong sheet Khớp mã / Gộp VAT (sau ma KiotViet, khong trung ma).
    const seen = new Set(results.map(row => row.code.trim().toLowerCase()));
    const { snapshot } = await readStock({ waitMs: stockWaitMs }); // goi y khi go: khong cho Sheets lau
    for (const entry of suggestSheetProducts(snapshot, q, max)) {
      if (results.length >= max) break;
      const key = entry.code.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ code: entry.code, name: entry.name });
    }
    return results;
  }

  return { list, exportList, get, create, createMany, update, bulkUpdate, move, restoreRanks, remove, history, productMetrics, lookupProducts, suggestProducts };
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  LOCKED_STATUSES,
  SALE_FIELDS,
  ACCOUNTANT_FIELDS,
  MAX_BATCH_ROWS,
  createVatRequestService
};
