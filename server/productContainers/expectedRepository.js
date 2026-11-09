'use strict';

// Doc bang "Du kien hang ve" (migration 0075) cho /api/expected-arrivals. Chi SELECT bang tinh san;
// cache dong da map theo `version` cua product_container_expected_state (chi tang khi noi dung doi),
// moi request chi ton 1 truy van nho doc state. Chua migrate / chua co state => bang rong.

const { getPool } = require('../db/pool');
const { fuzzySqlParts } = require('../shared/fuzzySql');
const { normalizeSorts, orderBy } = require('../shared/multiSort');
const { parseTableCodes } = require('../public/js/table-explorer');
const normalizeTableCode = value => String(value || '').trim().toLocaleLowerCase('vi-VN');

const SORT_FIELDS = {
  scheduleLabel: 'schedule_label', containerName: 'container_name', productCode: 'product_code', productName: 'product_name',
  color: 'color', saleNote: 'sale_note', otherNote: 'other_note', orderedBy: 'ordered_by', unitsPerPackage: 'units_per_package',
  packageCount: 'package_count', quantity: 'quantity', unitPriceCny: 'unit_price_cny', vietnamPrice: 'vietnam_price', sheetName: 'sheet_name'
};
const SORT_KEYS = ['lich-trang-thai', 'ten-cont', 'ma-sp', 'ten-sp', 'mau-sac', 'ghi-chu-sale', 'ghi-chu-khac', 'nguoi-dat', 'so-cai-kien', 'so-kien', 'tong-so-luong', 'gia-te', 'gia-vn', 'nguon'];
const SORT_LABELS = ['Lịch/Trạng thái', 'Tên Cont', 'Mã SP', 'Tên SP', 'Màu sắc', 'Ghi chú sale', 'Ghi chú khác', 'Người đặt', 'Số cái/kiện', 'Số kiện', 'Tổng số lượng', 'Giá SP (tệ)', 'Giá hàng về VN', 'Nguồn'];
const positiveInt = (value, fallback, max) => /^\d+$/.test(String(value)) && Number(value) > 0 ? Math.min(Number(value), max) : fallback;

const STATE_SQL = 'SELECT version::text AS version, computed_at, row_count FROM product_container_expected_state WHERE id = 1';
const ROWS_TAIL = ` FROM product_container_expected ORDER BY sheet_order, container_row, source_row`;
const ROWS_SQL = `SELECT schedule_label, status, status_label, eta, container_name, product_code, product_name, color, sale_note, other_note,
    ordered_by, listed_at, units_per_package, package_count, unit_price_cny, vietnam_price, quantity, sheet_name, source_row${ROWS_TAIL}`;
// Du phong khi chua ap migration 0078 (thieu listed_at / unit_price_cny / vietnam_price): bang van tai, gia = null.
const ROWS_LEGACY_SQL = `SELECT schedule_label, status, status_label, eta, container_name, product_code, product_name, color, sale_note,
    ordered_by, units_per_package, package_count, quantity, sheet_name, source_row${ROWS_TAIL}`;

const num = value => (value == null ? null : Number(value));

function mapRow(row) {
  return {
    scheduleLabel: row.schedule_label || '',
    status: Number(row.status) || 0,
    statusLabel: row.status_label || '',
    eta: row.eta || '',
    containerName: row.container_name || '',
    productCode: row.product_code || '',
    productName: row.product_name || '',
    color: row.color || '',
    saleNote: row.sale_note || '',
    otherNote: row.other_note || '',
    orderedBy: row.ordered_by || '',
    listedAt: row.listed_at || '',
    unitsPerPackage: num(row.units_per_package),
    packageCount: num(row.package_count),
    unitPriceCny: num(row.unit_price_cny),
    vietnamPrice: num(row.vietnam_price),
    quantity: num(row.quantity) || 0,
    sheetName: row.sheet_name,
    sourceRow: Number(row.source_row)
  };
}

// Danh sach loc: cont theo thu tu xuat hien; trang thai (cot B) distinct theo thu tu xuat hien.
function buildFilters(rows) {
  const containers = [];
  const statuses = [];
  const seenContainers = new Set();
  const seenStatuses = new Set();
  for (const row of rows) {
    if (row.containerName && !seenContainers.has(row.containerName)) { seenContainers.add(row.containerName); containers.push(row.containerName); }
    if (row.statusLabel && !seenStatuses.has(row.statusLabel)) { seenStatuses.add(row.statusLabel); statuses.push(row.statusLabel); }
  }
  return { containers, statuses };
}

function isMissingTable(error) {
  return error && error.code === '42P01';
}

function isMissingColumn(error) {
  return error && error.code === '42703';
}

/** Bo doc co cache rieng; moi lan truyen pool (test) la bo doc moi. */
function createExpectedRepository({ pool = getPool() } = {}) {
  let cache = null; // { version, rows, filters, computedAt }

  async function readState() {
    const { rows } = await pool.query(STATE_SQL);
    return rows[0] || null;
  }

  /** @returns {{ rows: object[], filters: {containers: string[], statuses: string[]}, meta: {computedAt, version, rowCount} }} */
  async function getExpected() {
    let state;
    try {
      state = await readState();
      if (!state) return empty();
      if (!cache || cache.version !== state.version) {
        let rows;
        try {
          ({ rows } = await pool.query(ROWS_SQL));
        } catch (error) {
          if (!isMissingColumn(error)) throw error;
          ({ rows } = await pool.query(ROWS_LEGACY_SQL)); // chua ap 0078
        }
        const mapped = rows.map(mapRow);
        cache = { version: state.version, rows: mapped, filters: buildFilters(mapped), computedAt: state.computed_at };
      }
    } catch (error) {
      if (isMissingTable(error)) return empty();
      throw error;
    }
    return {
      rows: cache.rows,
      filters: cache.filters,
      meta: { computedAt: cache.computedAt ? new Date(cache.computedAt).toISOString() : null, version: cache.version, rowCount: cache.rows.length }
    };
  }

  // One statement gives page, count, totals and linked facets the same database snapshot.
  async function queryExpected(query = {}, { fullAccess = false, otherNoteAccess = false, exportAll = false, countOnly = false } = {}) {
    const pageSize = positiveInt(query.pageSize, 100, 500);
    const requestedPage = positiveInt(query.page, 1, Number.MAX_SAFE_INTEGER);
    const values = [];
    const add = value => { values.push(value); return '$' + values.length; };
    const source = fullAccess && query.source ? String(query.source) : '';
    const container = String(query.container || '');
    const status = String(query.status || '');
    const allowed = {};
    Object.entries(SORT_FIELDS).forEach(([key, column], i) => {
      if ((!fullAccess && ['sheetName', 'unitPriceCny', 'vietnamPrice'].includes(key)) || (!otherNoteAccess && key === 'otherNote')) return;
      allowed[key] = column;
      allowed[SORT_KEYS[i]] = column;
    });
    const legacyIndex = SORT_LABELS.findIndex(label => label.replace(/\s/g, '').toLowerCase() === String(query.sortLabel || '').replace(/\s/g, '').toLowerCase());
    const sorts = normalizeSorts(query.sorts, allowed, SORT_KEYS[legacyIndex], query.sortDir);
    const requestedCodes = String(query.qmode) === 'codes' ? parseTableCodes(query.q) : [];
    const searchTerms = ['schedule_label', 'container_name', 'product_code', 'product_name', 'color', 'sale_note', ...(otherNoteAccess ? ['other_note'] : []), 'ordered_by'];
    const fuzzy = String(query.qmode) === 'codes' ? null : fuzzySqlParts(`concat_ws(' ',${searchTerms.join(',')})`, String(query.q || ''), add);
    const searchWhere = requestedCodes.length ? `lower(btrim(product_code)) = ANY(${add(requestedCodes.map(normalizeTableCode))}::text[])` : fuzzy ? fuzzy.where : 'TRUE';
    const sourceWhere = source ? `sheet_name = ${add(source)}` : 'TRUE';
    const containerWhere = container ? `container_name = ${add(container)}` : 'TRUE';
    const statusWhere = status ? `status_label = ${add(status)}` : 'TRUE';
    const ordering = [orderBy(sorts, allowed), fuzzy ? fuzzy.score + ' DESC' : '', 'sheet_order, container_row, source_row, sheet_name'].filter(Boolean).join(', ');
    const size = add(pageSize);
    const page = add(requestedPage);
    const facet = (column, condition) => `(SELECT COALESCE(jsonb_agg(value ORDER BY first_order), '[]'::jsonb) FROM (SELECT ${column} AS value, min(source_order) AS first_order FROM searched WHERE ${condition} AND ${column} <> '' GROUP BY ${column}) f)`;
    const sql = `WITH base AS (
      SELECT e.*, COALESCE(to_jsonb(e)->>'other_note','') AS optional_other_note,
        to_jsonb(e)->>'listed_at' AS optional_listed_at,
        (to_jsonb(e)->>'unit_price_cny')::numeric AS optional_unit_price_cny,
        (to_jsonb(e)->>'vietnam_price')::numeric AS optional_vietnam_price,
        dense_rank() OVER (ORDER BY sheet_order,sheet_name) AS anonymous_source,
        row_number() OVER (ORDER BY sheet_order,container_row,source_row,sheet_name) AS source_order
      FROM product_container_expected e WHERE EXISTS (SELECT 1 FROM product_container_expected_state WHERE id=1)
    ), authorized AS (
      SELECT sheet_name,source_row,sheet_order,container_row,container_name,status,status_label,eta,schedule_label,
        product_code,product_name,color,sale_note,ordered_by,units_per_package,package_count,quantity,anonymous_source,source_order,
        optional_other_note AS other_note,optional_listed_at AS listed_at,
        optional_unit_price_cny AS unit_price_cny,optional_vietnam_price AS vietnam_price FROM base
    ), searched AS (SELECT * FROM authorized WHERE ${searchWhere}),
    filtered AS (SELECT * FROM searched WHERE ${sourceWhere} AND ${containerWhere} AND ${statusWhere}),
    stats AS (SELECT count(*)::int AS total, COALESCE(sum(quantity),0) AS quantity FROM filtered),
    paging AS (SELECT *, LEAST(${page}::bigint,GREATEST(1,ceil(total::numeric/${size}::int)))::int AS page FROM stats),
    selected AS (SELECT * FROM filtered ORDER BY ${ordering} LIMIT ${countOnly ? '0' : exportAll ? '20001' : size + '::int'} OFFSET ${exportAll || countOnly ? '0' : '(SELECT (page-1)::bigint*' + size + '::int FROM paging)'})
    SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(s)), '[]'::jsonb) FROM selected s) AS rows,
      total,page,quantity,
      ${fullAccess ? facet('sheet_name', containerWhere + ' AND ' + statusWhere) : "'[]'::jsonb"} AS sources,
      ${facet('container_name', sourceWhere + ' AND ' + statusWhere)} AS containers,
      ${facet('status_label', sourceWhere + ' AND ' + containerWhere)} AS statuses,
      ${requestedCodes.length ? "(SELECT COALESCE(jsonb_agg(DISTINCT lower(btrim(product_code))), '[]'::jsonb) FROM filtered)" : "'[]'::jsonb"} AS found_codes,
      (SELECT to_jsonb(st) FROM product_container_expected_state st WHERE id=1) AS state FROM paging`;
    try {
      const { rows: [result] } = await pool.query(sql, values);
      const rows = result.rows.map(raw => {
        const row = mapRow(raw);
        if (!fullAccess) {
          row.sheetName = '#' + raw.anonymous_source;
          delete row.listedAt; delete row.unitPriceCny; delete row.vietnamPrice;
        }
        if (!otherNoteAccess) delete row.otherNote;
        return row;
      });
      const state = result.state;
      return { rows, totalRows: Number(result.total), page: Number(result.page), pageSize,
        summary: { quantity: Number(result.quantity) },
        filters: { sources: result.sources, containers: result.containers, statuses: result.statuses },
        search: { requestedCodes, missingCodes: requestedCodes.filter(code => !result.found_codes.includes(normalizeTableCode(code))) },
        meta: { computedAt: state && state.computed_at ? new Date(state.computed_at).toISOString() : null, version: state ? String(state.version) : null, rowCount: state ? Number(state.row_count) : 0 } };
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      return { ...empty(), totalRows: 0, page: 1, pageSize, summary: { quantity: 0 }, filters: { sources: [], containers: [], statuses: [] }, search: { requestedCodes, missingCodes: requestedCodes } };
    }
  }

  return { getExpected, queryExpected };
}

function empty() {
  return { rows: [], filters: { containers: [], statuses: [] }, meta: { computedAt: null, version: null, rowCount: 0 } };
}

let shared = null;
const getExpected = () => (shared || (shared = createExpectedRepository())).getExpected();
const queryExpected = (query, options) => (shared || (shared = createExpectedRepository())).queryExpected(query, options);

module.exports = { createExpectedRepository, getExpected, queryExpected, mapRow, buildFilters };
