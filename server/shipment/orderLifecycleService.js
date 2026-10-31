// ==========================================
// ORDER LIFECYCLE SERVICE — suy ra trang thai tom tat 6 muc tu 10 cot sheet
// "Vong doi don hang", theo dung dac ta muc 4 cua spec:
// docs/superpowers/specs/2026-09-04-order-lifecycle-status-lookup.md
// (cot K "Don da ky nhan" bo sung sau ngay 2026-09-14, khong nam trong spec goc)
// ==========================================
'use strict';

const repo = require('./orderLifecycleRepository');
const query = require('./orderLifecycleQuery');

function makeError(message, statusCode, code) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

const STATUS = Object.freeze({
  NOT_SENT: 'NOT_SENT',
  SENT_TO_ACCOUNTANT: 'SENT_TO_ACCOUNTANT',
  DELIVERING: 'DELIVERING',
  DELIVERED: 'DELIVERED',
  SHIP_RECEIVED: 'SHIP_RECEIVED',
  SIGNED: 'SIGNED',
  // Luong don ke toan/chung tu (tab KeToan_ChungTu, 2026-10-15): chi 2 trang thai la NOT_SENT (phieu tam Kiot chua co
  // trong tab nao) va COMPLETED (ma da duoc ke toan ghi vao tab). COMPLETED khong chon duoc qua ghi de thu cong.
  COMPLETED: 'COMPLETED',
  // 2 trang thai CHI dat duoc qua ghi de thu cong (Quan ly/Ke toan) — khong
  // co moc thoi gian tuong ung nen computeStatus() khong bao gio tra ve.
  EXCEPTION: 'EXCEPTION',
  CANCELLED: 'CANCELLED'
});

const STATUS_LABEL = Object.freeze({
  [STATUS.NOT_SENT]: 'Đơn chưa gửi kế toán',
  [STATUS.SENT_TO_ACCOUNTANT]: 'Đơn đã gửi kế toán',
  [STATUS.DELIVERING]: 'Đơn đang được giao',
  [STATUS.DELIVERED]: 'Đơn đã giao thành công',
  [STATUS.SHIP_RECEIVED]: 'Đã nhận (Tại kho)',
  [STATUS.SIGNED]: 'Đã nhận (Đi giao xong)',
  [STATUS.COMPLETED]: 'Hoàn thành',
  [STATUS.EXCEPTION]: 'Sự cố',
  [STATUS.CANCELLED]: 'Đã hủy'
});

// Thu tu tien do cua 6 trang thai TINH TOAN duoc (khong bao gom EXCEPTION/
// CANCELLED — 2 trang thai nay khong nam trong luong tien do binh thuong nen
// khong so sanh rank duoc, luon thang tuyet doi khi da ghi de — xem
// computeEffectiveStatus).
const STATUS_RANK = Object.freeze({
  [STATUS.NOT_SENT]: 0,
  [STATUS.SENT_TO_ACCOUNTANT]: 1,
  [STATUS.DELIVERING]: 2,
  [STATUS.DELIVERED]: 3,
  [STATUS.SHIP_RECEIVED]: 4,
  [STATUS.SIGNED]: 5,
  // Cao hon moi muc con lai: don ke toan da xong thi ghi de thuong khong ha trang thai (chi EXCEPTION/CANCELLED thang).
  [STATUS.COMPLETED]: 6
});

// Phai khop orderLifecycleRepository.FLOW_* (test repository co kiem tra) — khai bao lai o day de test
// service mock repository khong lam hong dieu kien canh bao.
const FLOW_DELIVERY = 'DELIVERY';
const FLOW_PICKUP = 'PICKUP';
const FLOW_NORTH_SOUTH = 'NORTH_SOUTH';
const FLOW_ACCOUNTING = 'ACCOUNTING';

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Trang thai hien tai = muc cao nhat ma cot moc tuong ung da co gia tri, xet
 * uu tien K > J > H > F > C — BO QUA D va G (chi theo sau C/F trong quy
 * trinh that, khong tao trang thai rieng). Cot K (Don da ky nhan) la moc SAU
 * CUNG trong quy trinh (sau khi ship da nhan don o cot J) nen luon uu tien
 * cao nhat. Edge case phong thu: D/G co gia tri nhung C/F tuong ung trong (du
 * lieu bot loi) van ap dung bang nay, KHONG doc D/G.
 */
function computeStatus(record) {
  // Luong ke toan/chung tu: dong co trong tab KeToan_ChungTu = da gui ke toan xong.
  if (record && record._flow === FLOW_ACCOUNTING) {
    return {
      code: STATUS.COMPLETED,
      label: STATUS_LABEL[STATUS.COMPLETED],
      actor: record.accountingSender || '',
      at: record.saleSentAt || null
    };
  }
  if (record && hasValue(record.orderSignedAt)) {
    return { code: STATUS.SIGNED, label: STATUS_LABEL[STATUS.SIGNED], actor: null, at: record.orderSignedAt };
  }
  if (record && hasValue(record.shipReceivedAt)) {
    return { code: STATUS.SHIP_RECEIVED, label: STATUS_LABEL[STATUS.SHIP_RECEIVED], actor: null, at: record.shipReceivedAt };
  }
  // 2026-10-02: cot H (deliveryConfirmedAt) khong con quyet dinh trang thai o bang tong quan;
  // gia tri van nam trong toDetail() de hop chi tiet hien nhu cu. DELIVERED chi con qua ghi de thu cong.
  if (record && hasValue(record.driverConfirmedDeliveryAt)) {
    return {
      code: STATUS.DELIVERING,
      label: STATUS_LABEL[STATUS.DELIVERING],
      actor: record.driverName || '',
      at: record.driverConfirmedDeliveryAt
    };
  }
  if (record && hasValue(record.saleSentAt)) {
    return {
      code: STATUS.SENT_TO_ACCOUNTANT,
      label: STATUS_LABEL[STATUS.SENT_TO_ACCOUNTANT],
      actor: record.saleName || '',
      at: record.saleSentAt
    };
  }
  return { code: STATUS.NOT_SENT, label: STATUS_LABEL[STATUS.NOT_SENT], actor: null, at: null };
}

function normalizeCode(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

/**
 * Ap dung ghi de (neu co) len trang thai tinh toan tu moc thoi gian.
 * - Khong co override -> giu nguyen computed.
 * - Override EXCEPTION/CANCELLED -> luon thang (khong co rank de so sanh).
 * - Override la 1 trong 6 trang thai thuong -> dong vai "muc san": trang
 *   thai nao co rank cao hon thi thang, de du lieu bot tien xa hon khong bi
 *   ket o trang thai da ghi de truoc do.
 */
function computeEffectiveStatus(record, overrideEntry) {
  const computed = computeStatus(record);
  if (!overrideEntry) return computed;

  const overrideCode = overrideEntry.to_status_code;
  if (overrideCode === STATUS.EXCEPTION || overrideCode === STATUS.CANCELLED) {
    return {
      code: overrideCode,
      label: STATUS_LABEL[overrideCode],
      actor: overrideEntry.changed_by || null,
      at: overrideEntry.changed_at || null,
      isOverride: true
    };
  }

  const computedRank = STATUS_RANK[computed.code];
  const overrideRank = STATUS_RANK[overrideCode];
  if (overrideRank === undefined || computedRank >= overrideRank) return computed;

  return {
    code: overrideCode,
    label: STATUS_LABEL[overrideCode],
    actor: overrideEntry.changed_by || null,
    at: overrideEntry.changed_at || null,
    isOverride: true
  };
}

// ---------------------------------------------------------------------------
// CANH BAO theo luong (2026-10-12) — moi don co the dinh NHIEU canh bao cung luc, tu mat khi buoc tuong ung
// da lam. Chi phu thuoc cac o sheet + dong ho: tinh trong RAM, KHONG luu DB (khong ton egress Supabase).
// API tra MA ngan (WARNING), giao dien/xuat Excel doi sang nhan (WARNING_LABEL).
// ---------------------------------------------------------------------------
const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const VN_UTC_OFFSET_MS = 7 * HOUR_MS; // Asia/Ho_Chi_Minh, khong co gio mua he
const WORK_START_HOUR = 6;
const WORK_END_HOUR = 18;
const ACCOUNTANT_LATE_WORK_MS = 30 * MINUTE_MS;
const DRIVER_NO_PHOTO_MS = 24 * HOUR_MS;
const NOT_SIGNED_AFTER_DRIVER_MS = 6 * HOUR_MS;
const PICKUP_PENDING_MS = 48 * HOUR_MS;
const NORTH_SOUTH_NO_BILL_MS = 24 * HOUR_MS;

const WARNING = Object.freeze({
  ACCOUNTANT_LATE: 'ACCOUNTANT_LATE',
  DRIVER_NO_PHOTO: 'DRIVER_NO_PHOTO',
  DRIVER_FORGOT_PHOTO: 'DRIVER_FORGOT_PHOTO',
  NOT_SIGNED_6H: 'NOT_SIGNED_6H',
  PICKUP_PENDING: 'PICKUP_PENDING',
  NO_TRAIN_BILL: 'NO_TRAIN_BILL',
  // Canh bao chi dinh vi tri (chi gan cho nguoi co quyen shipment.pick, xem withPickWarnings).
  PICK_KIOT_DIFF: 'PICK_KIOT_DIFF',
  PICK_ORDER_DIFF: 'PICK_ORDER_DIFF'
});

const WARNING_LABEL = Object.freeze({
  [WARNING.ACCOUNTANT_LATE]: 'Kế toán sót đơn',
  [WARNING.DRIVER_NO_PHOTO]: 'Lái xe chưa chụp đơn',
  [WARNING.DRIVER_FORGOT_PHOTO]: 'Lái xe quên chụp',
  [WARNING.NOT_SIGNED_6H]: 'Chưa nhận đơn quá 6 giờ',
  [WARNING.PICKUP_PENDING]: 'Khách/Ship chưa lấy',
  [WARNING.NO_TRAIN_BILL]: 'Chưa chụp bill tàu',
  [WARNING.PICK_KIOT_DIFF]: 'Lệch Kiot',
  [WARNING.PICK_ORDER_DIFF]: 'Lệch SL trong đơn'
});

/**
 * Doi 1 o thoi gian cua sheet ("dd/MM/yyyy HH:mm[:ss]", "dd/MM/yyyy", ma "15,35"
 * thay vi "15:35", hoac "YYYY-MM-DD HH:mm:ss" cua tab Lich su cap nhat) thanh
 * moc UTC (ms), coi gio tren sheet la gio Viet Nam nen ket qua khong phu thuoc
 * mui gio may chu. Khong doc duoc -> null.
 */
function parseSheetTimeMs(value) {
  const text = String(value == null ? '' : value).trim();
  let parts = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2})[:,h.](\d{2})(?:[:.](\d{2}))?)?/);
  let day, month, year;
  if (parts) {
    [day, month, year] = [parts[1], parts[2], parts[3]];
  } else {
    parts = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (!parts) return null;
    [year, month, day] = [parts[1], parts[2], parts[3]];
  }
  const ms = Date.UTC(Number(year), Number(month) - 1, Number(day),
    Number(parts[4] || 0), Number(parts[5] || 0), Number(parts[6] || 0));
  return Number.isNaN(ms) ? null : ms - VN_UTC_OFFSET_MS;
}

/**
 * Thoi gian (ms) nam trong gio lam viec 6h–18h gio VN giua 2 moc UTC. Dung som khi da du `enoughMs`
 * (don ton lau khong phai duyet het tung ngay).
 */
function workingMsBetween(startMs, endMs, enoughMs = Infinity) {
  if (!(endMs > startMs)) return 0;
  const DAY = 24 * HOUR_MS;
  const startLocal = startMs + VN_UTC_OFFSET_MS;
  const endLocal = endMs + VN_UTC_OFFSET_MS;
  let total = 0;
  for (let day = Math.floor(startLocal / DAY) * DAY; day < endLocal && total < enoughMs; day += DAY) {
    const from = Math.max(startLocal, day + WORK_START_HOUR * HOUR_MS);
    const to = Math.min(endLocal, day + WORK_END_HOUR * HOUR_MS);
    if (to > from) total += to - from;
  }
  return total;
}

/**
 * Danh sach MA canh bao dang dung cua 1 don (rong = khong canh bao). Quy tac theo _flow cua dong sheet:
 * - moi luong: Sale da gui KT, KT chua duyet, du 30' TRONG GIO 6h–18h -> ACCOUNTANT_LATE. CHI ap dung khi trang thai
 *   hieu luc con la "Don da gui ke toan" (SENT_TO_ACCOUNTANT): don da sang Dang giao / Da nhan / Da ky nhan (hoac ghi de) thi bo.
 * - DELIVERY (DonHang_HN/SG): Sale gui >24h, chua Tai xe gui xac nhan, chua ky nhan -> DRIVER_NO_PHOTO;
 *   da ky nhan ma chua Tai xe gui xac nhan -> DRIVER_FORGOT_PHOTO; Tai xe gui >6h ma chua ky nhan -> NOT_SIGNED_6H.
 * - PICKUP (Khach_HN/SG): Sale gui >48h ma chua Ship nhan don -> PICKUP_PENDING.
 * - NORTH_SOUTH (DonHang_MienNam): Sale gui >24h ma chua ky nhan -> NO_TRAIN_BILL.
 * Don da huy/su co (ghi de thu cong) khong canh bao. Ghi de len trang thai thuong coi nhu cac buoc truoc
 * no da lam (vd ghi de "Da nhan (Di giao xong)" -> co ky nhan).
 */
function computeWarnings(record, summary, now = Date.now()) {
  if (!record) return [];
  if (summary && (summary.code === STATUS.CANCELLED || summary.code === STATUS.EXCEPTION)) return [];
  const overrideRank = summary && summary.isOverride ? STATUS_RANK[summary.code] : undefined;
  const reached = status => overrideRank !== undefined && overrideRank >= STATUS_RANK[status];

  const sentAt = parseSheetTimeMs(record.saleSentAt);
  const approved = hasValue(record.accountantApprovedOrderAt) || reached(STATUS.DELIVERING);
  const driverAt = parseSheetTimeMs(record.driverConfirmedDeliveryAt);
  const hasDriver = hasValue(record.driverConfirmedDeliveryAt) || reached(STATUS.DELIVERING);
  const signed = hasValue(record.orderSignedAt) || reached(STATUS.SIGNED);
  const shipReceived = hasValue(record.shipReceivedAt) || reached(STATUS.SHIP_RECEIVED);
  const flow = record._flow || FLOW_DELIVERY;

  const status = (summary && summary.code) || computeStatus(record).code;

  const warnings = [];
  if (status === STATUS.SENT_TO_ACCOUNTANT && sentAt !== null && !approved && workingMsBetween(sentAt, now, ACCOUNTANT_LATE_WORK_MS) >= ACCOUNTANT_LATE_WORK_MS) {
    warnings.push(WARNING.ACCOUNTANT_LATE);
  }
  if (flow === FLOW_DELIVERY) {
    if (sentAt !== null && !hasDriver && !signed && now - sentAt > DRIVER_NO_PHOTO_MS) warnings.push(WARNING.DRIVER_NO_PHOTO);
    if (signed && !hasDriver) warnings.push(WARNING.DRIVER_FORGOT_PHOTO);
    if (driverAt !== null && !signed && now - driverAt > NOT_SIGNED_AFTER_DRIVER_MS) warnings.push(WARNING.NOT_SIGNED_6H);
  } else if (flow === FLOW_PICKUP) {
    if (sentAt !== null && !shipReceived && now - sentAt > PICKUP_PENDING_MS) warnings.push(WARNING.PICKUP_PENDING);
  } else if (flow === FLOW_NORTH_SOUTH) {
    if (sentAt !== null && !signed && now - sentAt > NORTH_SOUTH_NO_BILL_MS) warnings.push(WARNING.NO_TRAIN_BILL);
  }
  return warnings;
}

/** Truong canh bao gan vao dong tra ve: `warnings` (ma) + `warning` (boolean, giu tuong thich). */
function warningFields(record, summary, now) {
  const warnings = computeWarnings(record, summary, now);
  return { warnings, warning: warnings.length > 0 };
}

/**
 * Xay map ma don (da chuan hoa) -> dong ghi de MOI NHAT tu tab "Lich su cap
 * nhat". Sheets append luon theo thu tu thoi gian nen dong cuoi cung khop
 * ma don chinh la ghi de hien hanh — khong can so sanh timestamp.
 */
function latestOverrideByCode(historyRows) {
  const map = new Map();
  historyRows.forEach(row => {
    const key = normalizeCode(row.order_code);
    if (key) map.set(key, row);
  });
  return map;
}

/**
 * Chi tiet day du 10 cot, y het 1 hang trong Google Sheet (o trong hien "—" do
 * client dam nhiem hien thi, o day chi tra chuoi rong nguyen ban).
 */
function toDetail(record) {
  const detail = {
    orderCode: record.orderCode,
    saleName: record.saleName,
    customerName: record.customerName,
    saleSentAt: record.saleSentAt,
    accountantApprovedOrderAt: record.accountantApprovedOrderAt,
    driverName: record.driverName,
    driverConfirmedDeliveryAt: record.driverConfirmedDeliveryAt,
    accountantApprovedDeliveryAt: record.accountantApprovedDeliveryAt,
    deliveryConfirmedAt: record.deliveryConfirmedAt,
    shipReceivedAt: record.shipReceivedAt,
    orderSignedAt: record.orderSignedAt
  };
  // Chi luong ke toan/chung tu co truong nay (cot "Nguoi gui (ke toan)" cua tab KeToan_ChungTu).
  if (record._flow === FLOW_ACCOUNTING) detail.accountingSender = record.accountingSender || '';
  return detail;
}

/** 1 dong cua bang "Toan bo don hang": chi tiet + co so + trang thai hieu luc + canh bao. */
function toOrderRow(record, overrideEntry) {
  const summary = computeEffectiveStatus(record, overrideEntry);
  return Object.assign(toDetail(record), {
    branch: record._branch,
    flow: record._flow || FLOW_DELIVERY,
    summary
  }, warningFields(record, summary));}

/**
 * Tra cuu 1 don theo ma (trim, khong phan biet hoa/thuong). Ma khong ton tai
 * trong ca 2 tab -> found:false + summary "Đơn chưa gửi kế toán" (KHONG loi
 * 404 kho hieu, dung theo yeu cau Success Criteria cua spec).
 */
async function findOrder(orderCode) {
  const target = normalizeCode(orderCode);
  if (!target) {
    return { found: false, summary: computeStatus(null) };
  }
  const [records, historyRows] = await Promise.all([repo.readAll(), repo.readOverrideHistory()]);
  const record = records.find(r => normalizeCode(r.orderCode) === target);
  if (!record) {
    return { found: false, summary: computeStatus(null) };
  }
  const overrides = latestOverrideByCode(historyRows);
  const summary = computeEffectiveStatus(record, overrides.get(target));
  return {
    found: true,
    branch: record._branch,
    flow: record._flow || FLOW_DELIVERY,
    summary,
    warnings: computeWarnings(record, summary),
    detail: toDetail(record)
  };
}

// ---------------------------------------------------------------------------
// GOP don cua KiotViet vao bang "Toan bo don hang" (2026-10-01; mo rong MOI trang thai 2026-10-02)
//
// Khi doc duoc Kiot, bang gom MOI don dat hang tren Kiot (Phieu tam, Da xac nhan, Dang giao hang, Hoan
// thanh, Da huy; ~60 nghin don) — dong sheet khong khop don Kiot nao bi bo; Sale/Khach/Ghi chu lay tu Kiot.
// Khoa gop = (co so HN/SG, ma don chuan hoa) — cung ma DH ton tai o ca 2 co so (18.222 ma trung
// ve toan bo lich su vi ca 2 cung dem tu DH000001) nen KHONG duoc khop theo ma don thuan.
// Dong Google Sheet THANG khi trung (giu nguyen trang thai tu cac moc thoi gian + ghi de); don chi
// co o Kiot -> trang thai san co NOT_SENT "Đơn chưa gửi kế toán" (thap nhat), khong ap ghi de
// (ghi de chi chay voi ma co trong sheet, va lich su ghi de khoa theo ma don thuan khong theo co so).
// Truong them: source ('sheet'|'kiotviet'), kiotStatus (trang thai tren Kiot; '' neu khong co don Kiot),
// note (ghi chu cua don Kiot), sellableValue (Gia tri co ban; chi don Phieu tam, con lai null), orderTotal,
// orderDate. Danh sach ~60 nghin dong KHONG bao gio gui nguyen xuong trinh duyet: queryOrders loc/sap
// xep/cat trang tren may chu (orderLifecycleQuery.js).
// ---------------------------------------------------------------------------

function kiotKey(branch, code) {
  return `${branch}|${normalizeCode(code)}`;
}

/**
 * Don "chua gui ke toan" chua co moc thoi gian nao (summary.at = null) nen lay THOI GIAN DAT HANG tren Kiot
 * lam moc "Cap nhat gan nhat" — khong sinh them cot. Don da sang trang thai khac giu nguyen moc cua no.
 */
function withOrderDateAsUpdate(row, orderDate) {
  if (!orderDate || !row.summary || row.summary.code !== STATUS.NOT_SENT || hasValue(row.summary.at)) return row;
  return Object.assign(row, { summary: Object.assign({}, row.summary, { at: orderDate }) });
}

/**
 * Dong cho don chi co o Kiot (khong co dong sheet): "Don chua gui ke toan", cac moc sheet de trong, khong canh bao.
 * Dong GON (khong tao 11 truong chuoi rong nhu dong sheet) vi co toi ~60 nghin dong trong bo nho.
 */
function kiotOnlyRow(order) {
  return {
    orderCode: order.code,
    branch: order.branch,
    saleName: order.saleName || '',
    saleTelegramId: order.saleTelegramId || '',
    customerName: order.customerName || '',
    saleSentAt: '',
    summary: { code: STATUS.NOT_SENT, label: STATUS_LABEL[STATUS.NOT_SENT], actor: null, at: order.orderDate || null },
    warnings: [],
    warning: false,
    source: 'kiotviet',
    kiotStatus: order.kiotStatus || '',
    sellableValue: order.sellableValue,
    orderTotal: order.total,
    orderDate: order.orderDate,
    note: order.note || ''
  };
}

/**
 * Don Kiot ung voi 1 ma trong tab KeToan_ChungTu. Cung ma DH co the ton tai o ca HN lan SG (xem tren) ma tab
 * khong ghi co so: chi 1 ben co thi lay ben do; ca 2 ben thi uu tien don con Phieu tam (day la don can gui ke toan),
 * van hoa nhau thi lay don dat gan day nhat, bang nhau lay HN. Khong co don nao -> undefined.
 */
function pickAccountingKiotOrder(code, kiotByKey) {
  if (!normalizeCode(code)) return undefined;
  const candidates = ['HN', 'SG'].map(branch => kiotByKey.get(kiotKey(branch, code))).filter(Boolean);
  if (candidates.length <= 1) return candidates[0];
  const pending = candidates.filter(order => order.kiotStatus === 'Phiếu tạm');
  if (pending.length === 1) return pending[0];
  const time = order => {
    const ms = query.parseDateTimeValue(order.orderDate);
    return ms === null ? -Infinity : ms;
  };
  return time(candidates[1]) > time(candidates[0]) ? candidates[1] : candidates[0];
}

/**
 * HAM THUAN. Gop dong sheet + don Kiot (moi trang thai) thanh danh sach dong cho bang.
 * `kiotResult` = ket qua readOrders() ({ok, orders}); khong ok/khong co thi chi con dong sheet (khong co du lieu Kiot).
 * Thu tu: dong sheet nhu cu, sau do don chi-Kiot (da sap moi nhat truoc boi kiotOrdersRepository).
 */
function mergeRows({ records, overrides, kiotResult }) {
  const kiotOk = !!(kiotResult && kiotResult.ok && Array.isArray(kiotResult.orders));
  const kiotOrders = kiotOk ? kiotResult.orders : [];
  const kiotByKey = new Map(kiotOrders.map(order => [kiotKey(order.branch, order.code), order]));
  const matched = new Set();

  const rows = [];
  records.forEach(record => {
    // Tab KeToan_ChungTu dung chung HN+SG (khong co cot co so) -> co so lay theo don Kiot cung ma (pickAccountingKiotOrder).
    const isAccounting = record._flow === FLOW_ACCOUNTING;
    const kiotOrder = isAccounting
      ? pickAccountingKiotOrder(record.orderCode, kiotByKey)
      : (normalizeCode(record.orderCode) ? kiotByKey.get(kiotKey(record._branch, record.orderCode)) : undefined);
    const key = kiotKey(isAccounting ? (kiotOrder ? kiotOrder.branch : '') : record._branch, record.orderCode);
    // Doc duoc Kiot: bang CHI gom don co tren Kiot — dong sheet khong khop (khong co tren Kiot) bi bo; moi don
    // chi 1 dong (sheet trung ma thi lay dong dau). Kiot loi: giu dong sheet nhu cu (giao dien hien canh bao).
    if (kiotOk && (!kiotOrder || matched.has(key))) return;
    const row = toOrderRow(record, overrides.get(normalizeCode(record.orderCode)));
    if (isAccounting) row.branch = kiotOrder ? kiotOrder.branch : ''; // Kiot loi: khong biet co so, chi hien o "Ca hai"
    if (kiotOrder) matched.add(key);
    Object.assign(row, {
      source: 'sheet',
      kiotStatus: kiotOrder ? (kiotOrder.kiotStatus || '') : '',
      sellableValue: kiotOrder ? kiotOrder.sellableValue : null,
      orderTotal: kiotOrder ? kiotOrder.total : null,
      orderDate: kiotOrder ? kiotOrder.orderDate : '',
      note: kiotOrder ? (kiotOrder.note || '') : ''
    });
    // Sale + khach hang lay tu don Kiot (khong doc o sheet); sheet chi cung cap cac moc thoi gian/trang thai.
    if (kiotOrder) Object.assign(row, { saleName: kiotOrder.saleName || '', saleTelegramId: kiotOrder.saleTelegramId || '', customerName: kiotOrder.customerName || '' });
    rows.push(withOrderDateAsUpdate(row, row.orderDate));
  });

  kiotOrders.forEach(order => {
    if (matched.has(kiotKey(order.branch, order.code))) return;
    rows.push(kiotOnlyRow(order));
  });
  return rows;
}

/** Tom tat tinh trang nguon Kiot de giao dien hien thong bao khi loi (null = khong gop Kiot). */
function kiotMeta(kiotResult) {
  if (!kiotResult) return null;
  return {
    ok: !!kiotResult.ok,
    stale: !!kiotResult.stale,
    fetchedAt: kiotResult.fetchedAt || null,
    count: Array.isArray(kiotResult.orders) ? kiotResult.orders.length : 0
  };
}

// Danh sach dong da gop duoc DUNG LAI giua cac request khi du lieu nguon khong doi (ban gop ~60 nghin dong).
// Khoa: noi dung sheet + lich su ghi de, danh sach don Kiot (theo THAM CHIEU mang — repository chi doi mang
// khi doc lai DB) va PHUT hien tai (canh bao qua 24h phu thuoc dong ho, khong chi du lieu).
const WARNING_BUCKET_MS = 60 * 1000;
let mergedCache = null; // { sheetKey, kiotRef, bucket, rows }
const selectionCache = query.createSelectionCache(); // tu bo het khi mang dong nguon doi (xem createSelectionCache)

async function loadMergedRows(kiot) {
  const [records, historyRows, kiotResult] = await Promise.all([
    repo.readAll(),
    repo.readOverrideHistory(),
    kiot ? kiot.readOrders() : Promise.resolve(null)
  ]);
  const sheetKey = JSON.stringify([records, historyRows]);
  const kiotRef = !kiotResult ? 'none' : (kiotResult.ok && Array.isArray(kiotResult.orders) ? kiotResult.orders : 'failed');
  const bucket = Math.floor(Date.now() / WARNING_BUCKET_MS);
  if (mergedCache && mergedCache.sheetKey === sheetKey && mergedCache.kiotRef === kiotRef && mergedCache.bucket === bucket) {
    return { rows: mergedCache.rows, kiotResult };
  }
  const overrides = latestOverrideByCode(historyRows);
  const rows = mergeRows({ records, overrides, kiotResult });
  mergedCache = { sheetKey, kiotRef, bucket, rows };
  return { rows, kiotResult };
}

/**
 * Mot TRANG cua bang "Toan bo don hang". `rawParams` la query string cua GET (branch, status, kiotStatus,
 * dateField, from, to, mode, q, sort, dir, page, pageSize — xem orderLifecycleQuery.parseParams; tham so sai
 * -> loi 400). `kiot` (repository co readOrders(), khong bao gio throw) tuy chon: khong truyen thi chi co dong sheet.
 * Tra { orders (cac dong cua trang), page, pageSize, totalPages, total (don trong co so da chon, chua loc),
 * filteredTotal (sau loc), kiotStatuses (cho o loc), warningCounts (theo co so), kpis (chi so tong quat dau
 * trang theo bo loc hien tai — xem orderLifecycleQuery.countSummary), facets (so don theo tung gia tri cua cac o loc
 * dropdown, theo cac bo loc khac dang chon — xem orderLifecycleQuery.countFacets), kiot (tom tat nguon Kiot | null) }.
 */
async function queryOrders(rawParams, { kiot, pickStatuses, pickWarnings } = {}) {
  const params = query.parseParams(rawParams);
  const { rows: mergedRows, kiotResult } = await loadMergedRows(kiot);
  const rows = await withPickWarnings(mergedRows, pickWarnings);
  const pickMap = pickStatuses ? await pickStatuses() : null;
  // Loc theo trang thai chi dinh vi tri: thu hep tap dong (chi dinh it, don ~60 nghin) roi loc/sap xep nhu thuong, khong qua
  // selectionCache (gan voi mang dong nguon). Khong loc thi van dung cache; pickStatus chi gan len cac dong cua trang tra ve.
  const filtered = pickMap && params.pickStatus ? rows.filter(row => matchesPickFilter(pickMap.get(pickKey(row)), params.pickStatus)) : null;
  const scope = query.rowsInBranch(rows, params.branch);
  // Sap xep theo trang thai boc can ban do chi dinh (Postgres) nen cung khong qua selectionCache.
  const sortParams = withPickSort(params, pickMap);
  const selected = filtered || sortParams !== params ? query.selectRows(filtered || rows, sortParams) : selectionCache.select(rows, params);
  const paged = query.paginate(selected, params.page, params.pageSize);
  return {
    orders: pickMap ? withPickStatus(paged.items, pickMap) : paged.items,
    page: paged.page,
    pageSize: paged.pageSize,
    totalPages: paged.totalPages,
    total: scope.length,
    filteredTotal: selected.length,
    kiotStatuses: query.distinctKiotStatuses(scope),
    warningCounts: query.countWarnings(scope),
    kpis: query.countSummary(filtered || rows, params),
    facets: query.countFacets(rows, params, pickMap ? row => pickMap.get(pickKey(row)) || 'none' : null),
    kiot: kiotMeta(kiotResult)
  };
}

// Khoa trang thai chi dinh theo (co so, ma don) — khop pickAssignmentsService.latestStatuses ('HN|ma don chu thuong').
function pickKey(row) {
  return `${row.branch}|${normalizeCode(row.orderCode)}`;
}

// Thu tu sap xep cot "Trang thai boc" (tang dan theo luong lam viec): Chua boc, Dang boc, Da boc, Da huy.
const PICK_SORT_RANK = { picking: 1, confirmed: 2, cancelled: 3 };

/** Ban sao params kem gia tri sap xep pickStatus (neu dang sap theo cot nay va co ban do chi dinh); khong thi tra nguyen params. */
function withPickSort(params, pickMap) {
  if (params.sort !== 'pickStatus' || !pickMap) return params;
  return Object.assign({}, params, { sortValues: { pickStatus: row => PICK_SORT_RANK[pickMap.get(pickKey(row))] || 0 } });
}

// Bo loc "Trang thai boc": 'none' = Chua boc (khong co khoa trong ban do), con lai khop dung trang thai chi dinh moi nhat.
function matchesPickFilter(status, filter) {
  return filter === 'none' ? !status : status === filter;
}

/**
 * Canh bao chi dinh vi tri (PICK_KIOT_DIFF, PICK_ORDER_DIFF): `pickWarnings()` (pickAssignmentsService) tra Map 'co so|ma don' -> [ma] cho
 * moi chi dinh Dang boc / Da boc (it don). Cong cac ma vao `warnings` cua dong tuong ung TRUOC khi loc/dem nen chung nam trong o loc
 * canh bao, the KPI va file Excel. Chi sao chep nong cac dong doi; mang ket qua duoc nho lai theo (mang nguon, chu ky) de selectionCache
 * van dung duoc. Khong truyen `pickWarnings` (nguoi khong co quyen shipment.pick) hoac khong co canh bao thi tra nguyen `rows`.
 */
let pickWarnedCache = null;
async function withPickWarnings(rows, pickWarnings) {
  if (!pickWarnings) return rows;
  const found = await pickWarnings();
  if (!found || !found.size) return rows;
  const signature = JSON.stringify([...found].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  if (pickWarnedCache && pickWarnedCache.rows === rows && pickWarnedCache.signature === signature) return pickWarnedCache.result;
  const result = rows.map(row => {
    const extra = found.get(pickKey(row));
    return extra ? Object.assign({}, row, { warnings: [...(Array.isArray(row.warnings) ? row.warnings : []), ...extra] }) : row;
  });
  pickWarnedCache = { rows, signature, result };
  return result;
}

/** Gan `pickStatus` (picking|confirmed|cancelled|null) cho cac dong cua TRANG tra ve (ban sao nong, khong sua dong trong cache). */
function withPickStatus(items, pickMap) {
  return items.map(row => Object.assign({}, row, { pickStatus: pickMap.get(pickKey(row)) || null }));
}

/** Dong gop cua 1 don theo (co so, ma don); null neu khong co (hoac Kiot loi va don khong co trong sheet). */
async function findMergedOrder(branch, orderCode, { kiot } = {}) {
  const { rows } = await loadMergedRows(kiot);
  const target = normalizeCode(orderCode);
  return rows.find(row => row.branch === branch && normalizeCode(row.orderCode) === target) || null;
}

/**
 * Toan bo dong DA LOC + SAP XEP (moi trang, khong cat trang) de xuat Excel — cung bo tham so voi queryOrders
 * nen file khop dung bang tren man hinh. Khong truyen bo loc nao -> toan bo (don moi dat nhat truoc).
 */
async function exportOrders(rawParams, { kiot, pickStatuses, pickWarnings } = {}) {
  const params = query.parseParams(rawParams);
  const { rows: mergedRows } = await loadMergedRows(kiot);
  const rows = await withPickWarnings(mergedRows, pickWarnings);
  if (pickStatuses && (params.pickStatus || params.sort === 'pickStatus')) {
    const pickMap = await pickStatuses();
    const source = params.pickStatus ? rows.filter(row => matchesPickFilter(pickMap.get(pickKey(row)), params.pickStatus)) : rows;
    return query.selectRows(source, withPickSort(params, pickMap));
  }
  return selectionCache.select(rows, params);
}

/**
 * Toan bo don tu ca 2 tab, giu nguyen thu tu hang trong sheet. branchFilter
 * tuy chon ('HN'|'SG'). CHI doc Google Sheet (khong gop Kiot) — bang "Toan bo don
 * hang" dung queryOrders.
 */
async function listAllOrders(branchFilter) {
  const [records, historyRows] = await Promise.all([repo.readAll(), repo.readOverrideHistory()]);
  const overrides = latestOverrideByCode(historyRows);
  const filtered = branchFilter ? records.filter(r => r._branch === branchFilter) : records;
  return filtered.map(record => toOrderRow(record, overrides.get(normalizeCode(record.orderCode))));
}

/**
 * Toan bo lich su ghi de trang thai (tab "Lich su cap nhat" tren Google Sheet
 * — truoc gio chi duoc doc noi bo de tinh trang thai hieu luc, chua co giao
 * dien xem). Moi nhat hien truoc: sheet ghi noi tiep theo thu tu thoi gian
 * (append-only) nen chi can dao nguoc mang, khong can parse/so sanh timestamp.
 * Kem branch (join theo ma don voi bang chinh) de UI loc theo co so giong
 * Khu B; don khong con trong bang chinh (vd ma go nham luc ghi de) -> branch null.
 */
async function listHistory() {
  const [historyRows, records] = await Promise.all([repo.readOverrideHistory(), repo.readAll()]);
  const branchByCode = new Map();
  records.forEach(record => {
    const key = normalizeCode(record.orderCode);
    if (!branchByCode.has(key)) branchByCode.set(key, record._branch);
  });
  return historyRows.slice().reverse().map(row => ({
    historyId: row.history_id,
    orderCode: row.order_code,
    branch: branchByCode.get(normalizeCode(row.order_code)) || null,
    statusCode: row.to_status_code,
    statusLabel: row.to_status_label,
    // Cac dong ghi TRUOC khi co cot nay (2026-09-14) -> rong, xem HISTORY_SCHEMA.
    fromStatusCode: row.from_status_code || '',
    fromStatusLabel: row.from_status_label || '',
    changedBy: row.changed_by,
    changedByRole: row.changed_by_role,
    changedAt: row.changed_at,
    note: row.note,
    message: row.message
  }));
}

/**
 * Ghi de trang thai thu cong (Quan ly/Ke toan). Validate ma don co that (nam
 * trong 2 tab DonHang_HN/SG) truoc khi ghi — tranh tao lich su cho ma khong
 * ton tai. Tra ve trang thai hieu luc MOI NHAT sau khi ghi.
 */
async function overrideStatus(orderCode, { code, changedBy, changedByRole, note = '' }) {
  if (!STATUS_LABEL[code]) {
    throw makeError(`Trạng thái "${code}" không hợp lệ.`, 400, 'INVALID_STATUS');
  }

  const target = normalizeCode(orderCode);
  const [records, historyRows] = await Promise.all([repo.readAll(), repo.readOverrideHistory()]);
  const record = records.find(r => normalizeCode(r.orderCode) === target);
  if (!record) {
    throw makeError(`Không tìm thấy đơn hàng "${orderCode}" trong bảng vòng đời đơn hàng.`, 404, 'ORDER_NOT_FOUND');
  }

  // Trang thai hieu luc NGAY TRUOC lan ghi de nay — luu lai de hien "trang
  // thai cu" tren tab Lich su cap nhat (khong the suy nguoc tu cac dong lich
  // su SAU nay vi override la mot "muc san", khong phai always-overwrite).
  const overrides = latestOverrideByCode(historyRows);
  const fromStatus = computeEffectiveStatus(record, overrides.get(target));

  const message = `${changedBy} - ${changedByRole} đã cập nhật đơn hàng sang trạng thái ${STATUS_LABEL[code]}.`;
  const entry = await repo.appendOverride({
    order_code: record.orderCode,
    to_status_code: code,
    to_status_label: STATUS_LABEL[code],
    from_status_code: fromStatus.code,
    from_status_label: fromStatus.label,
    changed_by: changedBy,
    changed_by_role: changedByRole,
    note,
    message
  });

  const summary = computeEffectiveStatus(record, entry);
  return {
    orderCode: record.orderCode,
    branch: record._branch,
    summary,
    ...warningFields(record, summary)
  };
}

module.exports = {
  STATUS, STATUS_LABEL, STATUS_RANK,
  computeStatus, computeEffectiveStatus, WARNING, WARNING_LABEL, computeWarnings, workingMsBetween, parseSheetTimeMs, findOrder, listAllOrders, queryOrders,
  exportOrders, overrideStatus, listHistory, findMergedOrder,
  mergeRows, pickAccountingKiotOrder
};
