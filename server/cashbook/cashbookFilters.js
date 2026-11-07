'use strict';
const { fuzzySqlParts } = require('../shared/fuzzySql');

function invalid(message) {
  const e = new Error(message);
  e.statusCode = 400;
  e.code = 'INVALID_CASHBOOK_QUERY';
  return e;
}
function scalar(value, key) {
  if (typeof value !== 'string') throw invalid(`Tham số ${key} không hợp lệ.`);
  return value;
}
function id(value) {
  return (
    /^(?:-1|[1-9]\d*)$/.test(value) && BigInt(value) <= 9223372036854775807n
  );
}
function list(value, key, valid) {
  if (value === undefined) return null;
  const s = scalar(value, key);
  if (s === '') return [];
  const parts = s.split(',');
  if (parts.length > 500 || parts.some((x) => !valid(x)))
    throw invalid(`Tham số ${key} không hợp lệ.`);
  return [...new Set(parts)];
}
function parseFund(value = 'all') {
  scalar(value, 'fund');
  if (['all', 'cash', 'bank', 'unassigned'].includes(value)) return value;
  return list(value, 'fund', id);
}
function day(value) {
  scalar(value, 'ngày');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw invalid('Ngày phải có dạng YYYY-MM-DD.');
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value)
    throw invalid('Ngày không hợp lệ.');
  return +d - 7 * 3600000;
}
function text(value, key) {
  if (value === undefined) return '';
  const s = scalar(value, key).trim();
  if (s.length > 200) throw invalid(`Tham số ${key} quá dài.`);
  return s;
}
function integer(value, key, fallback, max) {
  if (value === undefined) return fallback;
  scalar(value, key);
  if (
    !/^[1-9]\d*$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > max
  )
    throw invalid(`Tham số ${key} không hợp lệ.`);
  return Number(value);
}
function parseFilters(query = {}, now = new Date()) {
  const keys = [
    'fund',
    'preset',
    'from',
    'to',
    'docTypes',
    'groups',
    'statuses',
    'accounting',
    'creators',
    'staff',
    'partnerQ',
    'partnerPhone',
    'code',
    'note',
    'page',
    'pageSize', 'sorts',
  ];
  for (const k of Object.keys(query))
    if (!keys.includes(k)) throw invalid(`Tham số ${k} không được hỗ trợ.`);
  let from, to;
  if (query.from !== undefined || query.to !== undefined) {
    if (
      query.from === undefined ||
      query.to === undefined ||
      query.preset !== undefined
    )
      throw invalid('Cần cả Từ–Đến, không kèm preset.');
    from = day(query.from);
    to = day(query.to) + 86400000 - 1;
  } else {
    const preset =
      query.preset === undefined ? 'thisYear' : scalar(query.preset, 'preset');
    const vn = new Date(+now + 7 * 3600000),
      y = vn.getUTCFullYear(),
      m = vn.getUTCMonth(),
      d = vn.getUTCDate();
    const local = (yy, mm, dd) => Date.UTC(yy, mm, dd) - 7 * 3600000;
    switch (preset) {
      case 'today':
        from = local(y, m, d);
        to = from + 86400000 - 1;
        break;
      case 'yesterday':
        from = local(y, m, d - 1);
        to = from + 86400000 - 1;
        break;
      case 'thisWeek':
        from = local(y, m, d - ((vn.getUTCDay() + 6) % 7));
        to = from + 7 * 86400000 - 1;
        break;
      case 'thisMonth':
        from = local(y, m, 1);
        to = local(y, m + 1, 1) - 1;
        break;
      case 'lastMonth':
        from = local(y, m - 1, 1);
        to = local(y, m, 1) - 1;
        break;
      case 'thisYear':
        from = local(y, 0, 1);
        to = local(y + 1, 0, 1) - 1;
        break;
      default:
        throw invalid('Preset thời gian không hợp lệ.');
    }
  }
  if (from > to) throw invalid('Ngày Từ phải trước ngày Đến.');
  const groups = list(query.groups, 'groups', (x) => {
    if (id(x)) return true;
    if (!x.startsWith('name:')) return false;
    try {
      return (
        !!decodeURIComponent(x.slice(5)).trim() &&
        decodeURIComponent(x.slice(5)).length <= 200
      );
    } catch {
      return false;
    }
  });
  const accounting =
    query.accounting === undefined
      ? 'all'
      : scalar(query.accounting, 'accounting');
  if (!['all', 'yes', 'no'].includes(accounting))
    throw invalid('Hạch toán không hợp lệ.');
  return {
    fund: parseFund(query.fund),
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    docTypes: list(query.docTypes, 'docTypes', (x) =>
      ['receipt', 'payment'].includes(x),
    ) ?? ['receipt', 'payment'],
    statuses: list(query.statuses, 'statuses', (x) =>
      ['paid', 'cancelled'].includes(x),
    ) ?? ['paid', 'cancelled'],
    groups,
    accounting,
    creators: list(query.creators, 'creators', id),
    staff: list(query.staff, 'staff', id),
    partnerQ: text(query.partnerQ, 'partnerQ'),
    partnerPhone: text(query.partnerPhone, 'partnerPhone'),
    code: text(query.code, 'code'),
    note: text(query.note, 'note'),
    ...(query.sorts !== undefined ? { sorts: require('../shared/multiSort').normalizeSortsStrict(query.sorts, ['code','transDate','docType','group','partnerName','partnerPhone','fundName','branch','creatorName','staffName','amount','runningBalance','status','note']) } : {}),
    page: integer(query.page, 'page', 1, 1000000),
    pageSize: integer(query.pageSize, 'pageSize', 100, 200),
  };
}
// Tất cả giá trị dữ liệu qua tham số; alias chỉ do module nội bộ chọn và trỏ tới
// view v_cash_book_transactions (migration 0070): các trường trích từ raw đã là cột của view.
function buildWhere(
  f,
  { alias = 'c', dates = true, fundOnly = false, start = 0 } = {},
) {
  const params = [],
    scores = [],
    parts = [`${alias}.source_missing_at IS NULL`];
  const add = (v) => {
    params.push(v);
    return `$${params.length + start}`;
  };
  if (f.fund === 'cash') parts.push(`${alias}.method='Cash'`);
  else if (f.fund === 'unassigned')
    parts.push(`${alias}.method IS DISTINCT FROM 'Cash' AND ${alias}.account_id IS NULL`);
  else if (f.fund === 'bank') parts.push(`${alias}.method IS DISTINCT FROM 'Cash'`);
  else if (Array.isArray(f.fund))
    parts.push(
      f.fund.length
        ? `${alias}.method IS DISTINCT FROM 'Cash' AND ${alias}.account_id=ANY(${add(f.fund)}::bigint[])`
        : 'FALSE',
    );
  if (!fundOnly) {
    if (dates)
      parts.push(
        `${alias}.trans_date>=${add(f.from)}::timestamptz`,
        `${alias}.trans_date<=${add(f.to)}::timestamptz`,
      );
    parts.push(
      f.docTypes.length
        ? `${alias}.is_receipt=ANY(${add(f.docTypes.map((x) => x === 'receipt'))}::boolean[])`
        : 'FALSE',
    );
    parts.push(
      f.statuses.length
        ? `COALESCE(${alias}.status,0)=ANY(${add(f.statuses.map((x) => (x === 'paid' ? 0 : 1)))}::int[])`
        : 'FALSE',
    );
    if (f.groups !== null) {
      const opts = [];
      for (const g of f.groups)
        opts.push(
          g.startsWith('name:')
            ? `(${alias}.cash_group_id IS NULL AND ${alias}.cash_group_name=${add(decodeURIComponent(g.slice(5)))})`
            : `${alias}.cash_group_id=${add(g)}`,
        );
      parts.push(opts.length ? `(${opts.join(' OR ')})` : 'FALSE');
    }
    for (const [key, column] of [
      ['creators', 'created_by'],
      ['staff', 'raw_user_id'],
    ])
      if (f[key] !== null)
        parts.push(
          f[key].length
            ? `${alias}.${column}=ANY(${add(f[key])}::text[])`
            : 'FALSE',
        );
    if (f.accounting !== 'all')
      parts.push(
        `${alias}.used_for_financial_reporting=${add(f.accounting === 'yes' ? '1' : '0')}`,
      );
    const like = (v) => `%${v.replace(/[\\%_]/g, '\\$&')}%`;
    // Nguoi nop/nhan: tim gan dung tren ten + ma doi tac (cung luat voi giao dien).
    if (f.partnerQ) {
      const fz = fuzzySqlParts(`COALESCE(${alias}.partner_name,'') || ' ' || COALESCE(${alias}.partner_id,'')`, f.partnerQ, add);
      if (fz) {
        parts.push(fz.where);
        scores.push(fz.score);
      }
    }
    if (f.partnerPhone)
      parts.push(
        `${alias}.partner_phone ILIKE ${add(like(f.partnerPhone))}`,
      );
    // O tim kiem cua bang So chi tiet (ma phieu / ghi chu).
    if (f.code) parts.push(`${alias}.code ILIKE ${add(like(f.code))}`);
    if (f.note) {
      const fz = fuzzySqlParts(`${alias}.description`, f.note, add);
      if (fz) {
        parts.push(fz.where);
        scores.push(fz.score);
      }
    }
  }
  // score: bieu thuc diem tim gan dung (null neu khong tim ten/ghi chu) de xep khop nhieu tu truoc.
  return {
    sql: parts.length ? parts.join(' AND ') : 'TRUE',
    params,
    score: scores.length ? scores.join('+') : null,
  };
}
module.exports = {
  parseFilters,
  parseFund,
  buildWhere,
  invalid,
};
