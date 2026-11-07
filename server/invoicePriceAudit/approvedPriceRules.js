'use strict';

// Luat dau vao cua bang "Gia duyet" (tab Hoa don): danh sach nguoi duyet, kiem tra gia / ngay / id, bo loc va sap xep.
// Thuan (khong cham DB) de service/route/test dung chung.

// Bang gia duyet la du lieu nhay cam: xem la quyen RIENG (mac dinh chi Quan ly), khong di theo quyen Kiem tra gia ban.
const FEATURE_VIEW = 'reports.invoices.approvedPrice';
const FEATURE_MANAGE = 'reports.invoices.approvedPrice.manage';

const APPROVERS = Object.freeze(['Anh Quân', 'Anh Duy', 'Anh Duy Khánh']);
const BRANCHES = Object.freeze(['hanoi', 'saigon']);
const BRANCH_LABELS = Object.freeze({ hanoi: 'Hà Nội', saigon: 'Sài Gòn' });
// Khoa sap xep (khop SORT_SQL cua repository) = khoa cot cua bang.
const SORT_KEYS = Object.freeze(['customerName', 'branch', 'productCode', 'productName', 'priceNoVat', 'priceWithVat', 'approver', 'approvedOn']);

const ID_RE = /^[1-9]\d{0,17}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const PRICE_RE = /^\d{1,12}(\.\d{1,4})?$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function bad(message, code = 'INVALID_INPUT', statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** 'YYYY-MM-DD' hop le tren lich (khong nhan 2026-02-30). */
function isValidDay(value) {
  const m = DAY_RE.exec(String(value ?? ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toISOString().slice(0, 10) === value;
}

function requireDay(value, label) {
  if (!isValidDay(value)) throw bad(`${label} không hợp lệ (cần dạng YYYY-MM-DD).`, 'INVALID_DATE');
  return value;
}

/** Gia duyet: so duong, toi da 12 chu so nguyen + 4 le. Nhan chuoi/so, tra chuoi chuan (khong dau phay, khong 0 thua dau). */
function parsePrice(value, { required = true, label = 'Giá duyệt' } = {}) {
  if (value === null || value === undefined || value === '') {
    // required=false: de trong hop le -> null (gia khong VAT / co VAT chi can nhap 1 trong 2).
    if (!required) return null;
    throw bad(label + ' bắt buộc.', 'INVALID_PRICE');
  }
  if (typeof value === 'boolean') throw bad(label + ' không hợp lệ.', 'INVALID_PRICE');
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value).trim();
  if (!PRICE_RE.test(text) || Number(text) <= 0) throw bad(label + ' phải là số lớn hơn 0 (tối đa 4 chữ số thập phân).', 'INVALID_PRICE');
  return text.replace(/^0+(?=\d)/, '');
}

function parseApprover(value) {
  if (!APPROVERS.includes(value)) throw bad(`Người duyệt phải là một trong: ${APPROVERS.join(', ')}.`, 'INVALID_APPROVER');
  return value;
}

function parseBranch(value) {
  if (!BRANCHES.includes(value)) throw bad('Cơ sở không hợp lệ.', 'INVALID_BRANCH');
  return value;
}

function parseId(value, label) {
  const text = String(value ?? '').trim();
  if (!ID_RE.test(text)) throw bad(`${label} không hợp lệ.`, 'INVALID_ID');
  return text;
}

function checkBody(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Dữ liệu gửi lên không hợp lệ.');
  const extra = Object.keys(body).filter(k => !allowed.includes(k));
  if (extra.length) throw bad(`Không được gửi các trường: ${extra.join(', ')}.`);
}

/** POST body: { branch, customerId, productId, priceNoVat, priceWithVat, approver, approvedOn }; 2 giá tùy chọn, cần ít nhất 1. */
function parseCreate(body) {
  checkBody(body, ['branch', 'customerId', 'productId', 'priceNoVat', 'priceWithVat', 'approver', 'approvedOn']);
  const priceNoVat = parsePrice(body.priceNoVat, { required: false, label: 'Giá không VAT' });
  const priceWithVat = parsePrice(body.priceWithVat, { required: false, label: 'Giá có VAT' });
  if (priceNoVat === null && priceWithVat === null) {
    throw bad('Nhập ít nhất một trong hai giá (không VAT / có VAT).', 'PRICE_REQUIRED');
  }
  return {
    branch: parseBranch(body.branch),
    customerId: parseId(body.customerId, 'Khách hàng'),
    productId: parseId(body.productId, 'Mã SP'),
    priceNoVat,
    priceWithVat,
    approver: parseApprover(body.approver),
    approvedOn: requireDay(body.approvedOn, 'Ngày duyệt')
  };
}

/** PUT body: du 6 truong nhu POST (sua duoc ca khach / san pham / co so) + expectedVersion (khoa lac quan). */
function parseUpdate(body) {
  checkBody(body, ['branch', 'customerId', 'productId', 'priceNoVat', 'priceWithVat', 'approver', 'approvedOn', 'expectedVersion']);
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 1) throw bad('Thiếu expectedVersion hợp lệ.');
  const { expectedVersion, ...rest } = body;
  return { ...parseCreate(rest), expectedVersion };
}

const nil = v => (v === undefined || v === null || v === '' ? null : v);

/** Bo loc + sap xep + phan trang tu query string; gia tri la la -> 400. */
function parseListQuery(query = {}) {
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, 100) : '';
  const approver = nil(query.approver);
  if (approver !== null && !APPROVERS.includes(approver)) throw bad('Người duyệt không hợp lệ.', 'INVALID_APPROVER');
  const from = nil(query.from);
  const to = nil(query.to);
  if (from !== null) requireDay(from, 'Ngày duyệt (từ)');
  if (to !== null) requireDay(to, 'Ngày duyệt (đến)');
  if (from !== null && to !== null && from > to) throw bad('Ngày duyệt "từ" phải trước hoặc bằng "đến".', 'INVALID_RANGE');
  const sort = nil(query.sort);
  if (sort !== null && !SORT_KEYS.includes(sort)) throw bad('Cột sắp xếp không hợp lệ.', 'INVALID_SORT');
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE));
  return { approver, from, to, q, ...(query.sorts !== undefined ? { sorts: require('../shared/multiSort').normalizeSortsStrict(query.sorts, SORT_KEYS) } : {}), sort, dir: query.dir === 'desc' ? 'desc' : 'asc', page, pageSize };
}

module.exports = {
  FEATURE_VIEW, FEATURE_MANAGE, APPROVERS, BRANCHES, BRANCH_LABELS, SORT_KEYS,
  DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE,
  bad, isValidDay, parsePrice, parseCreate, parseUpdate, parseListQuery, parseBranch
};
