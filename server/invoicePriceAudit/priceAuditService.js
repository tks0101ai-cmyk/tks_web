'use strict';

// Lop nghiep vu HTTP cua "Kiem tra gia ban": kiem tra query / body (400), quyen theo dong, ghi giai thich / Chot.
// Repository khong kiem tra query -> moi gia tri tu client deu qua day truoc. Tien / trang thai luon do SQL tinh tu
// ban goc + Chot (priceAuditSql); client chi gui text giai thich hoac decision.

const { getPriceAuditRepository, httpError } = require('./priceAuditRepository');
const access = require('./priceAuditAccess');
const { COLUMNS } = require('./priceAuditColumns');
const { hasFeature } = require('../auth/featureRegistry');

const BRANCHES = Object.freeze(['hanoi', 'saigon']);
const STATUSES = Object.freeze(['correct', 'wrong']);
const DECISION_FILTERS = Object.freeze(['pending', 'ok', 'penalty']);
const DECISIONS = Object.freeze(['ok', 'penalty']);
const PAGE_SIZES = Object.freeze([25, 50, 100, 200]);
const DEFAULT_PAGE_SIZE = 50;
const MAX_EXPLANATION = 4000;
const MAX_SEARCH = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INVOICE_ID = /^\d{1,19}$/;
const LINE_NO = /^\d{1,6}$/;
const NOT_MIGRATED_MESSAGE = 'Chức năng kiểm tra giá chưa sẵn sàng trên máy chủ (chưa cập nhật cơ sở dữ liệu).';

const bad = message => httpError(400, message, 'BAD_REQUEST');
const blank = value => value === undefined || value === null || value === '';
const single = value => (Array.isArray(value) ? value[value.length - 1] : value);

function isRealDate(text) {
  if (!DATE.test(text)) return false;
  const d = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === text;
}

function parseEnum(value, allowed, label) {
  const v = single(value);
  if (blank(v)) return null;
  if (!allowed.includes(v)) throw bad(`${label} không hợp lệ.`);
  return v;
}

function parseBool(value, label) {
  const v = single(value);
  if (blank(v)) return null;
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  throw bad(`${label} không hợp lệ.`);
}

function parsePositiveInt(value, label, fallback) {
  const v = single(value);
  if (blank(v)) return fallback;
  if (!/^\d{1,9}$/.test(String(v)) || Number(v) < 1) throw bad(`${label} không hợp lệ.`);
  return Number(v);
}

/**
 * Query GET -> tham so da hop le cho repository.readReport. Ngay phai nam trong cua so cong bo (meta).
 * branch: query.branch (hanoi/saigon) neu co, khong thi pham vi cookie (1 co so -> loc, Ca hai -> tat ca).
 */
function validateQuery(query = {}, { branchScope = BRANCHES, windowFrom = null, windowTo = null } = {}) {
  let branch = parseEnum(query.branch, BRANCHES, 'Cơ sở');
  if (!branch) {
    const scope = (branchScope || []).filter(b => BRANCHES.includes(b));
    branch = scope.length === 1 ? scope[0] : null;
  }
  const from = single(query.from);
  const to = single(query.to);
  for (const [label, value] of [['Từ ngày', from], ['Đến ngày', to]]) {
    if (blank(value)) continue;
    if (!isRealDate(String(value))) throw bad(`${label} phải có dạng YYYY-MM-DD.`);
    if (windowFrom && windowTo && (value < windowFrom || value > windowTo)) {
      throw bad(`${label} phải nằm trong cửa sổ đã công bố ${windowFrom} – ${windowTo}.`);
    }
  }
  if (!blank(from) && !blank(to) && from > to) throw bad('Từ ngày phải trước hoặc bằng Đến ngày.');
  const pageSize = parsePositiveInt(query.pageSize, 'Số dòng mỗi trang', DEFAULT_PAGE_SIZE);
  if (!PAGE_SIZES.includes(pageSize)) throw bad('Số dòng mỗi trang chỉ nhận 25 / 50 / 100 / 200.');
  const sale = single(query.sale);
  const q = single(query.q);
  if (!blank(sale) && typeof sale !== 'string') throw bad('Sale không hợp lệ.');
  if (!blank(q) && (typeof q !== 'string' || q.length > MAX_SEARCH)) throw bad('Từ khóa tìm kiếm không hợp lệ.');
  return {
    branch,
    from: blank(from) ? null : from,
    to: blank(to) ? null : to,
    sale: blank(sale) ? null : sale,
    status: parseEnum(query.status, STATUSES, 'Kết quả'),
    decision: parseEnum(query.decision, DECISION_FILTERS, 'Chốt'),
    vat: parseBool(query.vat, 'Full VAT'),
    freight: parseBool(query.freight, 'Bao cước'),
    q: blank(q) ? null : q.trim() || null,
    ...(query.sorts !== undefined ? { sorts: require('../shared/multiSort').normalizeSortsStrict(query.sorts, COLUMNS.map(c => c.key)) } : {}),
    sort: parseEnum(query.sort, COLUMNS.map(c => c.key), 'Cột sắp xếp'),
    dir: parseEnum(query.dir, ['asc', 'desc'], 'Chiều sắp xếp') || 'asc',
    page: parsePositiveInt(query.page, 'Trang', 1),
    pageSize
  };
}

/** Khoa dong tu URL /:branch/:invoiceId/:lineNo (invoiceId giu chuoi de khong mat chinh xac BIGINT). */
function parseKey(params = {}) {
  const branch = String(params.branch ?? '');
  const invoiceId = String(params.invoiceId ?? '');
  const lineNo = String(params.lineNo ?? '');
  if (!BRANCHES.includes(branch)) throw bad('Cơ sở của dòng không hợp lệ.');
  if (!INVOICE_ID.test(invoiceId)) throw bad('Mã hóa đơn (ID) không hợp lệ.');
  if (!LINE_NO.test(lineNo) || Number(lineNo) < 1) throw bad('Số dòng hóa đơn không hợp lệ.');
  return { branch, invoiceId, sourceLineNo: Number(lineNo) };
}

function checkBody(body, allowedKeys) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Dữ liệu gửi lên không hợp lệ.');
  const extra = Object.keys(body).filter(k => !allowedKeys.includes(k));
  if (extra.length) throw bad(`Không được sửa các trường: ${extra.join(', ')}.`);
  const v = body.expectedVersion;
  if (!Number.isInteger(v) || v < 1) throw bad('Thiếu expectedVersion hợp lệ.');
  return v;
}

const actorOf = viewer => [viewer?.hoTen, viewer?.username, viewer?.id]
  .map(value => String(value ?? '').trim()).find(Boolean) || 'unknown';
const isMissingTable = err => Boolean(err) && err.code === '42P01';

function notMigratedReport(query) {
  return {
    meta: { available: false, reason: 'not_migrated', message: NOT_MIGRATED_MESSAGE, windowFrom: null, windowTo: null,
      lastSuccessAt: null, lastAttemptAt: null, lastError: null, addedInvoiceCount: 0 },
    filters: { applied: query, options: { sales: [] } }, kpis: null, totals: null, saleSummary: [],
    rows: [], totalRows: 0, page: query.page, pageSize: query.pageSize
  };
}

function createPriceAuditService({ repository = getPriceAuditRepository() } = {}) {
  /** GET /: query thô + viewer + { branchScope } -> bao cao, rows co quyen theo viewer. */
  async function getReport(rawQuery, viewer, { branchScope } = {}) {
    let state;
    try {
      state = await repository.readState();
    } catch (err) {
      if (isMissingTable(err)) return notMigratedReport(validateQuery(rawQuery, { branchScope }));
      throw err;
    }
    const published = Boolean(state && state.published_day);
    const query = validateQuery(rawQuery, {
      branchScope,
      windowFrom: published ? state.window_from : null,
      windowTo: published ? state.window_to : null
    });
    let report;
    try {
      report = await repository.readReport(query, viewer);
    } catch (err) {
      if (isMissingTable(err)) return notMigratedReport(query);
      throw err;
    }
    const decide = access.canDecide(viewer);
    return { ...report, rows: report.rows.map(row => access.withCapabilities(viewer, row, { decide })) };
  }

  async function guardConflict(promise, viewer) {
    try {
      return await promise;
    } catch (err) {
      if (err && err.row) err.row = access.withCapabilities(viewer, err.row);
      throw err;
    }
  }

  /** PATCH explanation: body { text, expectedVersion }; quyen giai thich tren moi hoa don. */
  async function updateExplanation(params, body, viewer) {
    const key = parseKey(params);
    const expectedVersion = checkBody(body, ['text', 'expectedVersion']);
    if (typeof body.text !== 'string') throw bad('Nội dung giải thích phải là chuỗi.');
    if (body.text.length > MAX_EXPLANATION) throw bad(`Giải thích tối đa ${MAX_EXPLANATION} ký tự.`);
    if (!access.canView(viewer) || !hasFeature(viewer, access.FEATURE_EXPLAIN)) {
      throw httpError(403, 'Bạn không có quyền điền Sale giải thích.', 'FORBIDDEN');
    }
    const row = await guardConflict(repository.setExplanation(key, body.text, expectedVersion, actorOf(viewer)), viewer);
    return { row: access.withCapabilities(viewer, row) };
  }

  /**
   * PATCH decision: body { decision: null|'ok'|'penalty', expectedVersion }. Tra { row } va, de client cap nhat
   * KPI ma khong goi lai, { kpis, totals, totalRows } tinh theo filterQuery (bo loc dang dung, query cua PATCH).
   */
  async function updateDecision(params, body, viewer, filterQuery = {}, context = {}) {
    const key = parseKey(params);
    const expectedVersion = checkBody(body, ['decision', 'expectedVersion']);
    if (!('decision' in body) || !(body.decision === null || DECISIONS.includes(body.decision))) {
      throw bad('Chốt chỉ nhận null / "ok" / "penalty".');
    }
    if (!access.canView(viewer) || !access.canDecide(viewer)) {
      throw httpError(403, 'Bạn không có quyền chốt kiểm tra giá.', 'FORBIDDEN');
    }
    const row = await guardConflict(repository.setDecision(key, body.decision, expectedVersion, actorOf(viewer)), viewer);
    let summary = {};
    try {
      const report = await getReport({ ...filterQuery, page: undefined, pageSize: String(PAGE_SIZES[0]) }, viewer, context);
      summary = { kpis: report.kpis, totals: report.totals, totalRows: report.totalRows };
    } catch (err) {
      // Ghi da commit: bo loc cu khong hop le (vd ngay da ra khoi cua so) -> client tu tai lai.
      if (!(err && err.statusCode === 400)) throw err;
      summary = { kpis: null, totals: null, totalRows: null };
    }
    return { row: access.withCapabilities(viewer, row), ...summary };
  }

  return { getReport, updateExplanation, updateDecision };
}

let defaultService;
function getPriceAuditService() {
  if (!defaultService) defaultService = createPriceAuditService();
  return defaultService;
}

module.exports = {
  PAGE_SIZES,
  MAX_EXPLANATION,
  validateQuery,
  parseKey,
  createPriceAuditService,
  getPriceAuditService
};
