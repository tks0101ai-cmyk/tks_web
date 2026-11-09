// ==========================================
// ACCOUNT AUDIT LOG — lich su chinh sua tai khoan (bang `account_audit_log`,
// migration 0040). Chi ghi thao tac QUAN TRI o adminUserRoutes.js: tao, sua thong
// tin, dat lai mat khau, xoa, sua phan quyen chi tiet. Tab "Lich su chinh sua"
// o /account/#history doc qua GET /api/admin/audit-log (quyen 'account.users').
//
// Ghi la best-effort: loi DB chi log, KHONG lam hong thao tac da thanh cong.
// Khong bao gio ghi mat khau / passwordHash.
// ==========================================
'use strict';

const { normalizeSortsStrict, orderBy } = require('../shared/multiSort');
const AUDIT_SORTS = Object.freeze({
  createdAt: 'created_at',
  actor: "COALESCE(NULLIF(actor_name, ''), actor_username)",
  target: "COALESCE(NULLIF(target_name, ''), target_username)",
  action: "CASE action WHEN 'create' THEN 'Tạo tài khoản' WHEN 'update' THEN 'Sửa thông tin' WHEN 'reset_password' THEN 'Đặt lại mật khẩu' WHEN 'delete' THEN 'Xóa tài khoản' WHEN 'permissions' THEN 'Sửa phân quyền' END",
  changes: 'changes::text'
});
const featureRegistry = require('./featureRegistry');
const { fuzzySqlParts } = require('../shared/fuzzySql');
const { normalizeDepartments } = require('../hr/hrApprovalDepartments');

const ACTIONS = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  RESET_PASSWORD: 'reset_password',
  DELETE: 'delete',
  PERMISSIONS: 'permissions'
});
const VALID_ACTIONS = Object.freeze(Object.values(ACTIONS));

// Thu tu = thu tu hien thi trong cot "Chi tiet".
const TRACKED_FIELDS = Object.freeze([
  { key: 'hoTen', label: 'Họ tên' },
  { key: 'username', label: 'Tên tài khoản' },
  { key: 'email', label: 'Email' },
  { key: 'soDienThoai', label: 'Số điện thoại' },
  { key: 'telegramId', label: 'ID Telegram' },
  { key: 'vaiTro', label: 'Vai trò' },
  { key: 'vaiTroOverride', label: 'Ghi đè vai trò' },
  { key: 'coSo', label: 'Cơ sở' },
  { key: 'coSoOverride', label: 'Ghi đè cơ sở' },
  { key: 'workCoSo', label: 'Cơ sở công tác' },
  { key: 'boPhan', label: 'Bộ phận trực thuộc' },
  { key: 'trangThai', label: 'Trạng thái' },
  { key: 'leaveApprovalDepartments', label: 'Bộ phận được duyệt nghỉ', list: true }
]);

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 100;

let injectedPool = null;

/** Test thay pool gia (null = quay ve mac dinh). */
function setPool(pool) {
  injectedPool = pool || null;
}

function resolvePool() {
  if (injectedPool) return injectedPool;
  // node --test nap .env (config.js) nen co the tro vao DB that: test route khong
  // tiem pool gia thi bo qua ghi, tranh rac nhat ky production.
  if (process.env.NODE_TEST_CONTEXT) return null;
  return require('../db/pool').getPool();
}

function fieldValue(user, field) {
  const raw = user ? user[field.key] : undefined;
  // Thu tu phong ban khong co nghia: sap xep de doi thu tu khong bi coi la sua.
  if (field.list) return normalizeDepartments(Array.isArray(raw) ? raw : []).slice().sort((a, b) => a.localeCompare(b, 'vi')).join(', ');
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

/** Cac truong thong tin THUC SU doi giua 2 ban chup tai khoan. */
function diffUser(before, after) {
  const changes = [];
  for (const field of TRACKED_FIELDS) {
    const oldValue = fieldValue(before, field);
    const newValue = fieldValue(after, field);
    if (oldValue !== newValue) {
      changes.push({ field: field.key, label: field.label, before: oldValue, after: newValue });
    }
  }
  return changes;
}

/** Thong tin ban dau cua tai khoan moi tao (bo truong rong). */
function initialValues(user) {
  return diffUser({}, user);
}

function featureLabel(key) {
  const feature = featureRegistry.FEATURES.find(f => f.key === key);
  return feature ? feature.label : key;
}

/**
 * Quyen hieu luc truoc/sau (da tinh vai tro + ghi de + `requires`) va pham vi
 * duyet phong ban. Ghi nhan ten quyen tieng Viet de doc lai khong phu thuoc code.
 */
function diffPermissions(before, after) {
  const changes = [];
  const prev = new Set(featureRegistry.resolvePermissions(before || {}));
  const next = new Set(featureRegistry.resolvePermissions(after || {}));
  const added = [...next].filter(k => !prev.has(k)).map(featureLabel);
  const removed = [...prev].filter(k => !next.has(k)).map(featureLabel);
  if (added.length || removed.length) {
    changes.push({ field: 'permissions', label: 'Quyền', added, removed });
  }
  const scopeField = TRACKED_FIELDS.find(f => f.key === 'leaveApprovalDepartments');
  const oldScope = fieldValue(before, scopeField);
  const newScope = fieldValue(after, scopeField);
  if (oldScope !== newScope) {
    changes.push({ field: scopeField.key, label: scopeField.label, before: oldScope, after: newScope });
  }
  return changes;
}

function personName(user) {
  return String((user && (user.hoTen || user.username)) || '').trim();
}

/**
 * Ghi 1 dong nhat ky. update/permissions khong co thay doi thi bo qua.
 * Tra ve true neu da ghi.
 */
async function record({ action, actor, target, changes = [] }) {
  try {
    if (!VALID_ACTIONS.includes(action)) throw new Error(`Hành động nhật ký không hợp lệ: ${action}`);
    const list = Array.isArray(changes) ? changes : [];
    if ((action === ACTIONS.UPDATE || action === ACTIONS.PERMISSIONS) && !list.length) return false;
    const pool = resolvePool();
    if (!pool) return false;
    await pool.query(
      `INSERT INTO account_audit_log
         (action, actor_user_id, actor_username, actor_name, target_user_id, target_username, target_name, changes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [
        action,
        actor && actor.id != null ? String(actor.id) : null,
        String((actor && actor.username) || ''),
        personName(actor),
        target && target.id != null ? String(target.id) : null,
        String((target && target.username) || ''),
        personName(target),
        JSON.stringify(list)
      ]
    );
    return true;
  } catch (err) {
    console.error('=== LOI ghi nhat ky chinh sua tai khoan ===', err.message);
    return false;
  }
}

function isDateString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function rowToEntry(row) {
  return {
    id: String(row.id),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    action: row.action,
    actor: { id: row.actor_user_id || '', username: row.actor_username || '', name: row.actor_name || '' },
    target: { id: row.target_user_id || '', username: row.target_username || '', name: row.target_name || '' },
    changes: Array.isArray(row.changes) ? row.changes : []
  };
}

/**
 * Doc nhat ky, moi nhat truoc. Loc o SQL: q (ten/username nguoi sua hoac tai khoan),
 * action, from/to (YYYY-MM-DD, ngay gio Viet Nam), targetId.
 */
async function listEntries(options = {}) {
  const pool = injectedPool || require('../db/pool').getPool();
  const where = [];
  const params = [];
  const q = String(options.q || '').trim();
  // Tim gan dung (bo dau, 2 tu khop ca 2, >=3 tu khop qua nua) tren ten + username nguoi sua va tai khoan bi sua.
  const fz = fuzzySqlParts(
    "COALESCE(actor_name,'') || ' ' || COALESCE(actor_username,'') || ' ' || COALESCE(target_name,'') || ' ' || COALESCE(target_username,'')",
    q,
    value => { params.push(value); return '$' + params.length; }
  );
  if (fz) where.push(fz.where);
  if (VALID_ACTIONS.includes(options.action)) {
    params.push(options.action);
    where.push(`action = $${params.length}`);
  }
  if (options.targetId) {
    params.push(String(options.targetId));
    where.push(`target_user_id = $${params.length}`);
  }
  if (isDateString(options.from)) {
    params.push(options.from);
    where.push(`created_at >= ($${params.length}::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`);
  }
  if (isDateString(options.to)) {
    params.push(options.to);
    where.push(`created_at < ($${params.length}::date + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, parseInt(options.pageSize, 10) || PAGE_SIZE_DEFAULT));
  const requestedPage = Math.max(1, parseInt(options.page, 10) || 1);
  const sorts = normalizeSortsStrict(options.sorts, AUDIT_SORTS);
  const sortSql = orderBy(sorts, AUDIT_SORTS);
  const client = pool.connect ? await pool.connect() : pool;
  try {
    if (pool.connect) await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');

    const countResult = await client.query(`SELECT count(*)::int AS total FROM account_audit_log ${whereSql}`, params);
    const total = countResult.rows[0] ? Number(countResult.rows[0].total) : 0;
    const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
    const listParams = [...params, pageSize, (page - 1) * pageSize];
    const listResult = await client.query(
      `SELECT id, created_at, action, actor_user_id, actor_username, actor_name,
              target_user_id, target_username, target_name, changes
         FROM account_audit_log ${whereSql}
        ORDER BY ${sortSql ? `${sortSql}, ` : fz ? `${fz.score} DESC, ` : ''}${sortSql ? '' : 'created_at DESC, '}id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams
    );
    if (pool.connect) await client.query('COMMIT');
    const entries = listResult.rows.map(rowToEntry);
    return { rows: entries, entries, totalRows: total, total, page, pageSize };
  } catch (error) {
    if (pool.connect) await client.query('ROLLBACK');
    throw error;
  } finally { if (pool.connect) client.release(); }
}

module.exports = {
  ACTIONS,
  VALID_ACTIONS,
  TRACKED_FIELDS,
  diffUser,
  initialValues,
  diffPermissions,
  record,
  listEntries,
  setPool
};
