// ==========================================
// USER TABLE PREFS — do rong cot / cot an hien cua tung bang, luu theo tai khoan
// (bang `user_table_prefs`, migration 0085). Client: public/shared/table-controls.js.
// ==========================================
'use strict';

const MODES = Object.freeze(['desktop', 'mobile']);
const MAX_COLUMNS = 200;
const MAX_KEY_LENGTH = 200;
const MIN_WIDTH = 24;
const MAX_WIDTH = 2000;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function validKey(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH;
}

function assertTarget(tableKey, mode) {
  if (!validKey(tableKey)) throw badRequest('Khóa bảng không hợp lệ.');
  if (!MODES.includes(mode)) throw badRequest('Chế độ màn hình không hợp lệ.');
}

/** Chi giu {columns:{key:{width?,hidden?}}, sort?:{key,dir}} hop le; sai dinh dang -> 400. */
function sanitizePrefs(input) {
  const source = input && typeof input === 'object' ? input.columns : null;
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw badRequest('Cấu hình bảng không hợp lệ.');
  const keys = Object.keys(source);
  if (keys.length > MAX_COLUMNS) throw badRequest('Quá nhiều cột.');
  const columns = {};
  for (const key of keys) {
    if (!validKey(key)) throw badRequest('Khóa cột không hợp lệ.');
    const item = source[key];
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw badRequest('Cấu hình cột không hợp lệ.');
    const out = {};
    if (item.width !== undefined) {
      if (typeof item.width !== 'number' || !Number.isFinite(item.width) || item.width < MIN_WIDTH || item.width > MAX_WIDTH) {
        throw badRequest('Độ rộng cột không hợp lệ.');
      }
      out.width = Math.round(item.width);
    }
    if (item.hidden !== undefined) {
      if (typeof item.hidden !== 'boolean') throw badRequest('Trạng thái ẩn cột không hợp lệ.');
      out.hidden = item.hidden;
    }
    if (Object.keys(out).length) columns[key] = out;
  }
  const prefs = { columns };
  const sort = input.sort;
  if (sort !== undefined && sort !== null) {
    if (typeof sort !== 'object' || Array.isArray(sort) || !validKey(sort.key) || !['asc', 'desc'].includes(sort.dir)) {
      throw badRequest('Cấu hình sắp xếp không hợp lệ.');
    }
    prefs.sort = { key: sort.key, dir: sort.dir };
  }
  return prefs;
}

/** -> { [tableKey]: { [mode]: prefs } } cua dung tai khoan. */
async function listForUser(pool, userId) {
  const { rows } = await pool.query(
    'SELECT table_key, screen_mode, prefs FROM user_table_prefs WHERE user_id = $1',
    [String(userId)]
  );
  const result = {};
  for (const row of rows) {
    (result[row.table_key] = result[row.table_key] || {})[row.screen_mode] = row.prefs;
  }
  return result;
}

async function savePrefs(pool, userId, tableKey, mode, prefs) {
  assertTarget(tableKey, mode);
  const clean = sanitizePrefs(prefs);
  await pool.query(
    `INSERT INTO user_table_prefs (user_id, table_key, screen_mode, prefs, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (user_id, table_key, screen_mode)
     DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
    [String(userId), tableKey, mode, JSON.stringify(clean)]
  );
  return clean;
}

module.exports = { MODES, sanitizePrefs, listForUser, savePrefs };
