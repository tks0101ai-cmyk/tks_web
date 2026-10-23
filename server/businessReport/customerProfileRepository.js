'use strict';

// Thong tin / ghi chu theo khach hang cua bang "Doanh so theo khach" (migration 0080).
// Khoa khach = nameKey(ten) (khop hang bao cao). "Hom nay" = vnToday(now()) (gio VN), now inject duoc de test.
// Detail reads fail-soft; report reads and writes return 503 MIGRATION_PENDING for missing schema.

const crypto = require('crypto');
const { getPool } = require('../db/pool');
const { vnToday } = require('./businessMonths');
const { MAX_IMAGE_BYTES, ALLOWED_MIME, matchesSignature } = require('../hr/hrRuleDocumentImages');
const rules = require('./customerProfileRules');

const IMAGE_URL_PREFIX = '/api/business-report/customer-profile/images/';
const ACTIVE_STATUS = 'Đang hoạt động';
const CUSTOMER_ROLE = 'Khách';

const isPending = e => !!e && (e.code === '42P01' || e.code === '42703');
const num = v => (v === null || v === undefined ? null : Number(v));
const iso = v => (v instanceof Date ? v.toISOString() : (v == null ? null : new Date(v).toISOString()));
const displayName = u => (u && (u.hoTen || u.username)) || '';

function pendingError() {
  return rules.httpError(503, 'MIGRATION_PENDING', 'Chức năng ghi chú khách hàng chưa sẵn sàng (chưa cập nhật cơ sở dữ liệu).');
}

// Dinh dang anh theo magic byte (khong tin MIME client gui). null = khong phai png/jpeg/gif/webp.
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  for (const mime of ALLOWED_MIME) if (matchesSignature(buffer, mime)) return mime;
  return null;
}

function defaultUserStore() {
  return require('../auth/localUserStore');
}

function createCustomerProfileRepository({ pool = null, now = () => new Date(), userStore = null } = {}) {
  const db = () => pool || getPool();
  const query = (text, params) => db().query(text, params);
  const today = () => vnToday(now());
  const users = () => userStore || defaultUserStore();

  // Ghi: thieu bang => 503 MIGRATION_PENDING.
  async function guardWrite(fn) {
    try { return await fn(); } catch (e) {
      if (isPending(e)) throw pendingError();
      throw e;
    }
  }

  async function transaction(fn) {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally { client.release(); }
  }

  const imageOut = r => ({ id: r.id, url: IMAGE_URL_PREFIX + r.id, contentType: r.content_type, byteSize: Number(r.byte_size), createdAt: iso(r.created_at) });
  const noteOut = r => ({
    id: r.id, noteDate: r.note_date, body: r.body, authorId: r.author_id, authorName: r.author_name,
    createdAt: iso(r.created_at), updatedAt: iso(r.updated_at)
  });
  const profileOut = r => (r ? {
    warehouseLocation: r.warehouse_location, area: r.area || '', warehouseCount: num(r.warehouse_count), warehouseScale: r.warehouse_scale,
    competitor: r.competitor, salesChannels: r.sales_channels || []
  } : rules.emptyProfile());
  const PROFILE_COLS = 'warehouse_location, area, warehouse_count, warehouse_scale, competitor, sales_channels';
  const NOTE_COLS = `id, to_char(note_date, 'YYYY-MM-DD') AS note_date, body, author_id, author_name, created_at, updated_at`;

  // Report reads must surface missing schema; do not export silently empty profiles.
  // One batch query keeps reads bounded and never selects notes or image bytea.
  async function getReportProfiles(keys) {
    const requested = [...new Set(keys)];
    if (!requested.length) return {};
    return guardWrite(async () => {
      const { rows } = await query(`
        SELECT k.customer_key, p.warehouse_location, p.area, p.warehouse_count, p.warehouse_scale, p.competitor, p.sales_channels,
          COALESCE((SELECT json_agg(json_build_object('userId', e.user_id, 'userName', e.user_name) ORDER BY e.user_name, e.user_id)
            FROM customer_editors e WHERE e.customer_key = k.customer_key), '[]'::json) AS editors,
          COALESCE((SELECT json_agg(to_char(v.visit_date, 'YYYY-MM-DD') ORDER BY v.visit_date)
            FROM customer_visit_days v WHERE v.customer_key = k.customer_key), '[]'::json) AS visit_days,
          COALESCE((SELECT json_agg(json_build_object('id', i.id, 'url', $2::text || i.id::text) ORDER BY i.created_at, i.id)
            FROM customer_profile_images i WHERE i.customer_key = k.customer_key), '[]'::json) AS images
        FROM unnest($1::text[]) AS k(customer_key)
        LEFT JOIN customer_profiles p ON p.customer_key = k.customer_key`, [requested, IMAGE_URL_PREFIX]);
      return Object.fromEntries(rows.map(r => [r.customer_key, {
        ...profileOut(r.warehouse_scale == null ? null : r), editors: r.editors, visitDays: r.visit_days, images: r.images
      }]));
    });
  }

  // { [customerKey]: { lastVisit, noteCount } } - chi khach co du lieu. Thieu bang => {}.
  async function getMeta() {
    try {
      const { rows } = await query(`
        WITH v AS (SELECT customer_key, max(visit_date) AS d FROM customer_visit_days GROUP BY customer_key),
             n AS (SELECT customer_key, count(*)::int AS c FROM customer_notes GROUP BY customer_key)
        SELECT COALESCE(v.customer_key, n.customer_key) AS customer_key, to_char(v.d, 'YYYY-MM-DD') AS last_visit, COALESCE(n.c, 0) AS note_count
        FROM v FULL JOIN n ON n.customer_key = v.customer_key`);
      return Object.fromEntries(rows.map(r => [r.customer_key, { lastVisit: r.last_visit || null, noteCount: Number(r.note_count) || 0 }]));
    } catch (e) {
      if (isPending(e)) return {};
      throw e;
    }
  }

  // Du lieu tho cua 1 khach (route them key/name/today/canEdit/editable). Thieu bang => rong.
  async function getProfile(key) {
    try {
      const [profile, images, notes, visits, editors] = await Promise.all([
        query(`SELECT ${PROFILE_COLS} FROM customer_profiles WHERE customer_key = $1`, [key]),
        query('SELECT id, content_type, byte_size, created_at FROM customer_profile_images WHERE customer_key = $1 ORDER BY created_at, id', [key]),
        query(`SELECT ${NOTE_COLS} FROM customer_notes WHERE customer_key = $1 ORDER BY note_date DESC, created_at DESC`, [key]),
        query(`SELECT to_char(visit_date, 'YYYY-MM-DD') AS d FROM customer_visit_days WHERE customer_key = $1 ORDER BY visit_date`, [key]),
        query('SELECT user_id, user_name FROM customer_editors WHERE customer_key = $1 ORDER BY user_name, user_id', [key])
      ]);
      const visitDays = visits.rows.map(r => r.d);
      return {
        profile: profileOut(profile.rows[0]),
        images: images.rows.map(imageOut),
        notes: notes.rows.map(noteOut),
        visitDays,
        lastVisit: visitDays.length ? visitDays[visitDays.length - 1] : null,
        editors: editors.rows.map(r => ({ userId: r.user_id, userName: r.user_name }))
      };
    } catch (e) {
      if (!isPending(e)) throw e;
      return { profile: rules.emptyProfile(), images: [], notes: [], visitDays: [], lastVisit: null, editors: [] };
    }
  }

  async function isEditor(key, userId) {
    if (userId === null || userId === undefined || userId === '') return false;
    try {
      const { rows } = await query('SELECT 1 FROM customer_editors WHERE customer_key = $1 AND user_id = $2', [key, String(userId)]);
      return rows.length > 0;
    } catch (e) {
      if (isPending(e)) return false;
      throw e;
    }
  }

  // actor: { id, name } - ghi nhan nguoi sua; luon luu ten tai thoi diem ghi.
  const actorId = a => (a && a.id !== undefined && a.id !== null ? String(a.id) : null);
  const actorName = a => String((a && a.name) || '');

  async function saveProfile(key, customerName, input, actor) {
    const p = rules.normalizeProfileInput(input);
    return guardWrite(async () => {
      const { rows } = await query(`
        INSERT INTO customer_profiles (customer_key, customer_name, warehouse_location, warehouse_count, area, competitor, sales_channels, updated_by_id, updated_by_name, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7::text[], $8, $9, $10::timestamptz)
        ON CONFLICT (customer_key) DO UPDATE SET customer_name = EXCLUDED.customer_name, warehouse_location = EXCLUDED.warehouse_location,
          warehouse_count = EXCLUDED.warehouse_count, area = EXCLUDED.area, competitor = EXCLUDED.competitor,
          sales_channels = EXCLUDED.sales_channels, updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = EXCLUDED.updated_at
        RETURNING *`,
      [key, String(customerName || ''), p.warehouseLocation, p.warehouseCount, p.area, p.competitor, p.salesChannels, actorId(actor), actorName(actor), now().toISOString()]);
      return profileOut(rows[0]);
    });
  }

  // Atomic column-specific upsert: never read/replace general information during a scale edit.
  async function saveScale(key, customerName, value, actor) {
    const scale = rules.normalizeScale(value);
    return guardWrite(async () => {
      const { rows } = await query(`
        INSERT INTO customer_profiles (customer_key, customer_name, warehouse_scale, updated_by_id, updated_by_name, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
        ON CONFLICT (customer_key) DO UPDATE SET customer_name = EXCLUDED.customer_name, warehouse_scale = EXCLUDED.warehouse_scale,
          updated_by_id = EXCLUDED.updated_by_id, updated_by_name = EXCLUDED.updated_by_name, updated_at = EXCLUDED.updated_at
        RETURNING ${PROFILE_COLS}`,
      [key, String(customerName || ''), scale, actorId(actor), actorName(actor), now().toISOString()]);
      return profileOut(rows[0]);
    });
  }

  // Moi khach toi da 1 note / ngay (UNIQUE): trung => 409 NOTE_EXISTS_TODAY.
  async function createNote(key, body, actor) {
    const text = rules.normalizeNoteBody(body);
    return guardWrite(async () => {
      const at = now().toISOString();
      const { rows } = await query(`
        INSERT INTO customer_notes (id, customer_key, note_date, body, author_id, author_name, created_at, updated_at)
        VALUES ($1, $2, $3::date, $4, $5, $6, $7::timestamptz, $7::timestamptz)
        ON CONFLICT (customer_key, note_date) DO NOTHING
        RETURNING ${NOTE_COLS}`,
      [crypto.randomUUID(), key, today(), text, actorId(actor), actorName(actor), at]);
      if (!rows.length) throw rules.httpError(409, 'NOTE_EXISTS_TODAY', 'Hôm nay khách này đã có note, hãy sửa note hiện có.');
      return noteOut(rows[0]);
    });
  }

  // Chi sua trong ngay tao (theo gio VN): note_date != hom nay => 409 NOTE_LOCKED. Giu nguyen tac gia.
  async function updateNote(key, id, body) {
    const text = rules.normalizeNoteBody(body);
    return guardWrite(async () => {
      const { rows } = await query(`
        UPDATE customer_notes SET body = $4, updated_at = $5::timestamptz
        WHERE id = $1 AND customer_key = $2 AND note_date = $3::date
        RETURNING ${NOTE_COLS}`, [id, key, today(), text, now().toISOString()]);
      if (rows.length) return noteOut(rows[0]);
      const exists = await query('SELECT 1 FROM customer_notes WHERE id = $1 AND customer_key = $2', [id, key]);
      if (!exists.rows.length) throw rules.httpError(404, 'NOTE_NOT_FOUND', 'Không tìm thấy note.');
      throw rules.httpError(409, 'NOTE_LOCKED', 'Note đã qua ngày nên không sửa được nữa.');
    });
  }

  // buffer: noi dung file tho. Dinh dang theo magic byte; <= 5MB; toi da 10 anh / khach (kiem trong 1 cau INSERT).
  async function addImage(key, buffer, actor) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw rules.httpError(400, 'IMAGE_MISSING', 'Thiếu file ảnh.');
    if (buffer.length > MAX_IMAGE_BYTES) throw rules.httpError(413, 'IMAGE_TOO_LARGE', `Ảnh quá lớn, tối đa ${MAX_IMAGE_BYTES / (1024 * 1024)} MB.`);
    const contentType = detectImageType(buffer);
    if (!contentType) throw rules.httpError(400, 'IMAGE_INVALID', 'File ảnh không hợp lệ (chỉ nhận PNG, JPEG, GIF, WebP).');
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    return guardWrite(async () => {
      const { rows } = await query(`
        INSERT INTO customer_profile_images (id, customer_key, content_type, byte_size, sha256, data, created_by_id, created_by_name, created_at)
        SELECT $1::uuid, $2::text, $3::text, $4::int, $5::text, $6::bytea, $7::text, $8::text, $9::timestamptz
        WHERE (SELECT count(*) FROM customer_profile_images WHERE customer_key = $2::text) < $10::int
        RETURNING id, content_type, byte_size, created_at`,
      [crypto.randomUUID(), key, contentType, buffer.length, sha256, buffer, actorId(actor), actorName(actor), now().toISOString(), rules.MAX_IMAGES]);
      if (!rows.length) throw rules.httpError(409, 'IMAGE_LIMIT', `Mỗi khách tối đa ${rules.MAX_IMAGES} ảnh.`);
      return imageOut(rows[0]);
    });
  }

  async function deleteImage(key, id) {
    return guardWrite(async () => {
      const { rows } = await query('DELETE FROM customer_profile_images WHERE id = $1 AND customer_key = $2 RETURNING id', [id, key]);
      if (!rows.length) throw rules.httpError(404, 'IMAGE_NOT_FOUND', 'Không tìm thấy ảnh.');
      return true;
    });
  }

  // Anh theo id (khong can key): tach meta / noi dung de tra 304 khong keo BYTEA.
  async function getImageMeta(id) {
    try {
      const { rows } = await query('SELECT content_type, byte_size, sha256 FROM customer_profile_images WHERE id = $1', [id]);
      return rows[0] ? { contentType: rows[0].content_type, byteSize: Number(rows[0].byte_size), sha256: String(rows[0].sha256).trim() } : null;
    } catch (e) {
      if (isPending(e)) return null;
      throw e;
    }
  }

  async function getImageContent(id) {
    try {
      const { rows } = await query('SELECT data FROM customer_profile_images WHERE id = $1', [id]);
      return rows[0] ? Buffer.from(rows[0].data) : null;
    } catch (e) {
      if (isPending(e)) return null;
      throw e;
    }
  }

  // Thay TOAN BO tap ngay da di (giu nguoi dat cua ngay da co). Tra { visitDays, lastVisit }.
  async function setVisitDays(key, dates, actor) {
    const list = rules.normalizeVisitDates(dates, today());
    return guardWrite(async () => {
      await transaction(async client => {
        await client.query('DELETE FROM customer_visit_days WHERE customer_key = $1 AND NOT (visit_date = ANY($2::date[]))', [key, list]);
        if (list.length) {
          await client.query(`INSERT INTO customer_visit_days (customer_key, visit_date, set_by_id, set_by_name, set_at)
            SELECT $1::text, d, $3::text, $4::text, $5::timestamptz FROM unnest($2::date[]) AS d ON CONFLICT (customer_key, visit_date) DO NOTHING`,
          [key, list, actorId(actor), actorName(actor), now().toISOString()]);
        }
      });
      return { visitDays: list, lastVisit: list.length ? list[list.length - 1] : null };
    });
  }

  // Danh sach tai khoan co the gan lam nguoi sua: dang hoat dong, vai tro noi bo (khong phai Khach).
  async function listAssignableUsers() {
    const all = await users().getAllUsers();
    return all
      .filter(u => u && u.trangThai === ACTIVE_STATUS && u.vaiTro && u.vaiTro !== CUSTOMER_ROLE && u.id !== undefined && u.id !== null)
      .map(u => ({ id: String(u.id), hoTen: displayName(u), vaiTro: u.vaiTro }))
      .sort((a, b) => a.hoTen.localeCompare(b.hoTen, 'vi') || a.id.localeCompare(b.id));
  }

  // Thay TOAN BO danh sach nguoi sua. userIds phai la tai khoan dang hoat dong (ten chup lai luc gan).
  async function setEditors(key, userIds, actor) {
    const ids = rules.normalizeUserIds(userIds);
    const byId = new Map((await listAssignableUsers()).map(u => [u.id, u]));
    if (ids.some(id => !byId.has(id))) throw rules.httpError(400, 'INVALID_EDITORS', 'Có tài khoản không hợp lệ hoặc đã ngừng hoạt động.');
    return guardWrite(async () => {
      await transaction(async client => {
        await client.query('DELETE FROM customer_editors WHERE customer_key = $1 AND NOT (user_id = ANY($2::text[]))', [key, ids]);
        for (const id of ids) {
          await client.query(`INSERT INTO customer_editors (customer_key, user_id, user_name, assigned_by_id, assigned_at)
            VALUES ($1, $2, $3, $4, $5::timestamptz)
            ON CONFLICT (customer_key, user_id) DO UPDATE SET user_name = EXCLUDED.user_name`,
          [key, id, byId.get(id).hoTen, actorId(actor), now().toISOString()]);
        }
      });
      return ids.map(id => ({ userId: id, userName: byId.get(id).hoTen }));
    });
  }

  return {
    getMeta, getProfile, getReportProfiles, isEditor, saveProfile, saveScale, createNote, updateNote, addImage, deleteImage,
    getImageMeta, getImageContent, setVisitDays, listAssignableUsers, setEditors, today
  };
}

module.exports = { createCustomerProfileRepository, detectImageType };
