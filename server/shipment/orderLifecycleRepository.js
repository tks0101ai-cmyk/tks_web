// ==========================================
// ORDER LIFECYCLE REPOSITORY — doc RIENG spreadsheet "Vong doi don hang",
// 2 tab DonHang_HN/DonHang_SG, gop thanh 1 danh sach kem _branch.
//
// Doc cot DonHang_HN/SG theo TEN HEADER (buildColumnIndex/readRowByHeader),
// KHONG theo vi tri A/B/C.. co dinh — xem HEADER_ALIASES ben duoi de biet ly
// do. Tab "Lich su cap nhat" (HISTORY_SCHEMA) van dung rowToObject vi tri co
// dinh nhu cu vi CHINH SERVER tao/ghi tab do, thu tu cot luon on dinh. KHONG
// co ham ghi cho SCHEMA chinh — day la nguon du lieu READ-ONLY (bot Telegram/
// Apps Script ben ngoai repo nay ghi).
// ==========================================
'use strict';

const CONFIG = require('../config');
const client = require('../sheets/orderLifecycleSheetsClient');
const historyClient = require('../sheets/orderLifecycleHistoryClient');

// Ma nhanh dung cho _branch/API branch filter — RIENG cho tinh nang nay,
// KHONG dung BRANCHES.HANOI/SAIGON ('Hà Nội'/'Sài Gòn') cua branch/branches.js
// vi day chi la nhan tab nguon, khong phai co so dang nhap cua tai khoan.
const LIFECYCLE_BRANCH = Object.freeze({ HN: 'HN', SG: 'SG' });

const SCHEMA = {
  headers: [
    'Mã đơn hàng', 'Nhân viên bán hàng', 'Khách hàng', 'Sale gửi đơn cho kế toán', 'Kế toán duyệt đơn',
    'Lái xe', 'Tài xế gửi xác nhận giao hàng', 'Kế toán duyệt giao hàng', 'Xác nhận đã giao/khách ký nhận',
    'Ship nhận đơn', 'Đơn đã ký nhận'
  ],
  fieldKeys: [
    'orderCode', 'saleName', 'customerName', 'saleSentAt', 'accountantApprovedOrderAt',
    'driverName', 'driverConfirmedDeliveryAt', 'accountantApprovedDeliveryAt', 'deliveryConfirmedAt',
    'shipReceivedAt', 'orderSignedAt'
  ]
};

// Tra cuu cot theo TEN HEADER (khong theo vi tri A/B/C..) vi nguoi dung chinh
// sua truc tiep tren Google Sheet (them/xoa/doi cho cot) — da xay ra thuc te
// ngay 2026-09-14: tab DonHang_SG bi xoa mat cot "Xac nhan da giao/khach ky
// nhan" lam lech toan bo cot phia sau, khien server doc nham J ("Ship nhan
// don") thanh I va lam sai trang thai hien thi. Moi fieldKey co the co NHIEU
// bien the header da xac minh tung xuat hien tren 2 tab (vd "Ke toan duyet"
// vs "Ke toan duyet don"). Cot khong tim thay trong header thuc te -> luon
// tra ve '' (khong lam vo cac cot khac), xem buildColumnIndex/readTab.
const HEADER_ALIASES = {
  orderCode: ['Mã đơn hàng'],
  saleName: ['Nhân viên bán hàng'],
  customerName: ['Khách hàng'],
  saleSentAt: ['Sale gửi đơn cho kế toán'],
  accountantApprovedOrderAt: ['Kế toán duyệt đơn', 'Kế toán duyệt'],
  driverName: ['Lái xe'],
  driverConfirmedDeliveryAt: ['Tài xế gửi xác nhận giao hàng'],
  accountantApprovedDeliveryAt: ['Kế toán duyệt giao hàng'],
  deliveryConfirmedAt: ['Xác nhận đã giao/khách ký nhận'],
  shipReceivedAt: ['Ship nhận đơn'],
  orderSignedAt: ['Đơn đã ký nhận']
};

// Chuan hoa de so sanh: trim + gom khoang trang + khong phan biet hoa/thuong
// + gop "kí"/"ký" (2 cach viet dau cung ton tai tren cac tab khac nhau).
function normalizeHeaderText(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/kí/g, 'ký');
}

/**
 * Xay map fieldKey -> chi so cot THUC TE tu dong header cua 1 tab (khop theo
 * HEADER_ALIASES, khong theo vi tri co dinh). fieldKey khong khop cot nao ->
 * -1 (readRowByHeader se tra '' cho field do, khong throw/lam lech cac field
 * khac).
 */
function buildColumnIndex(headerRow) {
  const normalizedHeaders = (headerRow || []).map(normalizeHeaderText);
  const columnIndex = {};
  SCHEMA.fieldKeys.forEach(key => {
    const aliases = (HEADER_ALIASES[key] || []).map(normalizeHeaderText);
    columnIndex[key] = normalizedHeaders.findIndex(h => aliases.includes(h));
  });
  return columnIndex;
}

/**
 * Tieu de cot "Ma don hang" bi xoa/doi ten (da xay ra 11/11/2026: o A1 tab DonHang_SG bi de trong -> moi dong co ma
 * rong, khong ghep duoc don Kiot, ca tab hien "Don chua gui ke toan"). Ma don luon nam o cot A nen khi khong tim thay
 * tieu de va cot A chua bi truong nao khac nhan thi doc cot A, kem canh bao de nguoi van hanh sua lai tieu de.
 */
function withOrderCodeFallback(columnIndex, sheetName) {
  if (columnIndex.orderCode >= 0) return columnIndex;
  if (Object.keys(columnIndex).some(key => key !== 'orderCode' && columnIndex[key] === 0)) return columnIndex;
  console.warn(`[orderLifecycleRepository] Tab "${sheetName}" khong co tieu de "Mã đơn hàng" — tam doc ma don o cot A. Hay sua lai o A1.`);
  return Object.assign({}, columnIndex, { orderCode: 0 });
}

function readRowByHeader(row, columnIndex, fieldKeys) {
  const obj = {};
  fieldKeys.forEach(key => {
    const idx = columnIndex[key];
    obj[key] = (idx >= 0 && row[idx] !== undefined) ? row[idx] : '';
  });
  return obj;
}

// Schema tab "Lich su cap nhat" — do CHINH SERVER tao/ghi (ngoai le duy nhat
// trong module nay, xem orderLifecycleHistoryClient.js). Doc theo VI TRI CO
// DINH (khong header-alias nhu SCHEMA chinh) nen 2 cot "trang thai cu" MOI
// them (2026-09-14) PHAI nam O CUOI mang — chen giua se lam lech vi tri doc
// cua moi cot phia sau doi voi cac dong da ghi TRUOC khi co cot nay (du lieu
// that da ton tai tren sheet san xuat). Dong cu doc 2 cot nay -> '' (xem
// rowToObject) vi luc do chua tinh/ghi from_status.
const HISTORY_SCHEMA = {
  headers: [
    'Mã lịch sử', 'Mã đơn hàng', 'Mã trạng thái', 'Trạng thái mới',
    'Người thực hiện', 'Vai trò', 'Thời gian cập nhật', 'Ghi chú', 'Nội dung cập nhật',
    'Mã trạng thái cũ', 'Trạng thái cũ'
  ],
  fieldKeys: [
    'history_id', 'order_code', 'to_status_code', 'to_status_label',
    'changed_by', 'changed_by_role', 'changed_at', 'note', 'message',
    'from_status_code', 'from_status_label'
  ]
};

function rowToObject(row, fieldKeys) {
  const obj = {};
  fieldKeys.forEach((key, i) => { obj[key] = row[i] !== undefined ? row[i] : ''; });
  return obj;
}

function generateId(prefix) {
  const hex = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `${prefix}-${Date.now()}-${hex}`;
}

// Don Bac-Nam (tab DonHang_MienNam, 2026-10-12): la don cua Kiot Ha Noi nen mang _branch 'HN', chi doc 4 moc
// (Ma don, Sale gui ke toan, Ke toan duyet don, Don da ky nhan) + Sale/Khach; cac cot Lai xe/Tai xe/Ke toan
// duyet giao hang/Ship nhan don cua tab nay BO QUA (ep '') de trang thai chi ra 3 muc: chua gui KT / da gui KT
// / da ky nhan. _flow quyet dinh bo canh bao ap cho don (xem computeWarnings cua service).
//
// 2026-10-12: 5 luong / 5 tab — moi dong deu mang _flow:
//   DELIVERY    DonHang_HN/SG: giao bang xe; cot "Ship nhan don" BO QUA (luong ship/khach da tach ra tab rieng).
//   PICKUP      Khach_HN/SG: khach/ship lay tai kho; chi doc Ma don, Sale gui KT, KT duyet don, Ship nhan don.
//   NORTH_SOUTH DonHang_MienNam.
const FLOW_DELIVERY = 'DELIVERY';
const FLOW_PICKUP = 'PICKUP';
const FLOW_NORTH_SOUTH = 'NORTH_SOUTH';
const DELIVERY_FIELD_KEYS = SCHEMA.fieldKeys.filter(key => key !== 'shipReceivedAt');
const NORTH_SOUTH_FIELD_KEYS = [
  'orderCode', 'saleName', 'customerName', 'saleSentAt', 'accountantApprovedOrderAt', 'orderSignedAt'
];
// driverName = cot "Lai xe" cua tab Khach (buoc Kho trong hop chi tiet; chi hien ten, khong anh huong trang thai).
const PICKUP_FIELD_KEYS = [
  'orderCode', 'saleName', 'customerName', 'saleSentAt', 'accountantApprovedOrderAt', 'driverName', 'shipReceivedAt'
];

// Don ke toan/chung tu (tab KeToan_ChungTu, 2026-10-15): 1 tab DUNG CHUNG HN+SG, chi 3 cot (Ma don hang,
// Nguoi gui (ke toan), Thoi gian gui) nen khong co co so — _branch de null, service gan theo don Kiot (mergeRows).
// Moi dong = 1 don DA gui ke toan ("Hoan thanh"); Thoi gian gui doc vao saleSentAt de dung chung cot/loc thoi gian.
const FLOW_ACCOUNTING = 'ACCOUNTING';
const ACCOUNTING_HEADER_ALIASES = {
  orderCode: ['Mã đơn hàng'],
  accountingSender: ['Người gửi (kế toán)', 'Người gửi'],
  saleSentAt: ['Thời gian gửi']
};

function readAccountingRows(values) {
  if (!values || values.length === 0) return [];
  const headers = (values[0] || []).map(normalizeHeaderText);
  const indexOf = key => headers.findIndex(h => ACCOUNTING_HEADER_ALIASES[key].map(normalizeHeaderText).includes(h));
  const columns = { orderCode: indexOf('orderCode'), accountingSender: indexOf('accountingSender'), saleSentAt: indexOf('saleSentAt') };
  return values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== undefined))
    .map(row => {
      const record = {};
      SCHEMA.fieldKeys.forEach(key => { record[key] = ''; });
      record.accountingSender = '';
      Object.keys(columns).forEach(key => {
        const idx = columns[key];
        if (idx >= 0 && row[idx] !== undefined) record[key] = row[idx];
      });
      return Object.assign(record, { _branch: null, _flow: FLOW_ACCOUNTING });
    })
    .filter(record => String(record.orderCode).trim() !== '');
}

async function readAccountingTab(readOptions) {
  try {
    return readAccountingRows(await client.getValues(CONFIG.ORDER_LIFECYCLE_SHEET_ACCOUNTING, readOptions));
  } catch (err) {
    console.error(`=== CANH BAO: Khong doc duoc tab "${CONFIG.ORDER_LIFECYCLE_SHEET_ACCOUNTING}" (don ke toan/chung tu, bo qua) ===`);
    console.error(err.message);
    console.error('==========================================================================');
    return [];
  }
}

async function readTab(sheetName, branch, { fieldKeys = DELIVERY_FIELD_KEYS, flow = FLOW_DELIVERY } = {}, readOptions) {
  const values = await client.getValues(sheetName, readOptions);
  if (!values || values.length === 0) return [];
  const columnIndex = withOrderCodeFallback(buildColumnIndex(values[0]), sheetName);
  const dataRows = values.slice(1);
  return dataRows
    .filter(row => row.some(cell => cell !== '' && cell !== undefined))
    .map(row => {
      const record = {};
      SCHEMA.fieldKeys.forEach(key => { record[key] = ''; });
      Object.assign(record, readRowByHeader(row, columnIndex, fieldKeys), { _branch: branch });
      if (flow) record._flow = flow;
      return record;
    });
}

/**
 * Tab phu (Bac-Nam, Khach_HN/SG) FAIL-SOFT: tab moi them, bi doi ten/xoa khong duoc lam sap ca man hinh tra cuu
 * (2 tab DonHang_HN/SG van throw nhu cu) — ghi log ro ten tab roi coi nhu rong.
 */
async function readOptionalTab(sheetName, branch, options, label, readOptions) {
  try {
    return await readTab(sheetName, branch, options, readOptions);
  } catch (err) {
    console.error(`=== CANH BAO: Khong doc duoc tab "${sheetName}" (${label}, bo qua) ===`);
    console.error(err.message);
    console.error('==========================================================================');
    return [];
  }
}

/**
 * Doc ca 5 tab + tab KeToan_ChungTu, gop thanh 1 danh sach theo thu tu HN -> Bac-Nam -> Khach_HN -> SG -> Khach_SG
 * -> Ke toan/Chung tu (cuoi cung: ma trung voi tab khac thi dong truoc thang, xem mergeRows). Don Bac-Nam tinh nhu don HN. Ma don khong bao gio trung giua cac tab (neu trung, dong gap truoc thang — xem mergeRows).
 * readOptions.allowStale: xem orderLifecycleSheetsClient.getValues.
 */
async function readAll(readOptions) {
  const northSouth = { fieldKeys: NORTH_SOUTH_FIELD_KEYS, flow: FLOW_NORTH_SOUTH };
  const pickup = { fieldKeys: PICKUP_FIELD_KEYS, flow: FLOW_PICKUP };
  const [hnRows, northSouthRows, pickupHnRows, sgRows, pickupSgRows, accountingRows] = await Promise.all([
    readTab(CONFIG.ORDER_LIFECYCLE_SHEET_HN, LIFECYCLE_BRANCH.HN, undefined, readOptions),
    readOptionalTab(CONFIG.ORDER_LIFECYCLE_SHEET_NORTH_SOUTH, LIFECYCLE_BRANCH.HN, northSouth, 'don Bac-Nam', readOptions),
    readOptionalTab(CONFIG.ORDER_LIFECYCLE_SHEET_PICKUP_HN, LIFECYCLE_BRANCH.HN, pickup, 'khach/ship lay HN', readOptions),
    readTab(CONFIG.ORDER_LIFECYCLE_SHEET_SG, LIFECYCLE_BRANCH.SG, undefined, readOptions),
    readOptionalTab(CONFIG.ORDER_LIFECYCLE_SHEET_PICKUP_SG, LIFECYCLE_BRANCH.SG, pickup, 'khach/ship lay SG', readOptions),
    readAccountingTab(readOptions)
  ]);
  return [...hnRows, ...northSouthRows, ...pickupHnRows, ...sgRows, ...pickupSgRows, ...accountingRows];
}

/**
 * Doc toan bo tab "Lich su cap nhat" (moi dong = 1 lan ghi de trang thai).
 * FAIL-SOFT VOI MOI LOI (thieu ORDER_LIFECYCLE_SPREADSHEET_ID, tab chua duoc
 * tao boi setupOrderLifecycleHistorySheet.js, service account chua duoc cap
 * quyen Editor, Google API tam thoi loi...) -> tra ve mang rong thay vi throw.
 * Day la tinh nang BO SUNG (ghi de thu cong) — khong duoc phep lam hong man
 * hinh tra cuu vong doi don hang hien co (GET /api/shipment/lifecycle) von
 * hoat dong tot truoc khi tinh nang nay ton tai.
 */
async function readOverrideHistory(readOptions) {
  let values;
  try {
    values = await historyClient.getValues(CONFIG.ORDER_LIFECYCLE_SHEET_HISTORY, readOptions);
  } catch (err) {
    console.error('=== CANH BAO: Khong doc duoc tab "Lich su cap nhat" (bo qua override) ===');
    console.error(err.message);
    console.error('==========================================================================');
    return [];
  }
  if (!values || values.length === 0) return [];
  return values.slice(1)
    .filter(row => row.some(cell => cell !== '' && cell !== undefined))
    .map(row => rowToObject(row, HISTORY_SCHEMA.fieldKeys));
}

/**
 * Ghi 1 dong ghi de trang thai moi vao tab "Lich su cap nhat".
 * @param {{order_code, to_status_code, to_status_label, changed_by,
 *          changed_by_role, note, message, from_status_code, from_status_label}} entry
 * @returns {Promise<object>} Dong da ghi (kem history_id, changed_at)
 */
async function appendOverride(entry) {
  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Ho_Chi_Minh' });
  const full = {
    history_id: generateId('OVR'),
    order_code: entry.order_code,
    to_status_code: entry.to_status_code,
    to_status_label: entry.to_status_label,
    changed_by: entry.changed_by,
    changed_by_role: entry.changed_by_role,
    changed_at: now,
    note: entry.note || '',
    message: entry.message,
    from_status_code: entry.from_status_code || '',
    from_status_label: entry.from_status_label || ''
  };
  const row = HISTORY_SCHEMA.fieldKeys.map(key => full[key]);
  await historyClient.appendRow(CONFIG.ORDER_LIFECYCLE_SHEET_HISTORY, row);
  return full;
}

module.exports = {
  LIFECYCLE_BRANCH,
  FLOW_DELIVERY,
  FLOW_PICKUP,
  FLOW_NORTH_SOUTH,
  FLOW_ACCOUNTING,
  SCHEMA_HEADERS: SCHEMA.headers,
  SCHEMA_FIELD_KEYS: SCHEMA.fieldKeys,
  HISTORY_SCHEMA_HEADERS: HISTORY_SCHEMA.headers,
  HISTORY_SCHEMA_FIELD_KEYS: HISTORY_SCHEMA.fieldKeys,
  rowToObject,
  buildColumnIndex,
  readAll,
  readOverrideHistory,
  appendOverride
};
