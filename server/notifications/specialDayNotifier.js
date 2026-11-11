'use strict';

// Bao NGAY LE / SINH NHAT len chuong thong bao. Du lieu ngay: public/shared/special-days.js
// (truoc dung chung voi shooting-star.js; hieu ung phao hoa da go 11/11/2026). Nguoi nhan = moi tai khoan dang hoat
// dong co quyen `hr.leave` (quyen xem lich nghi phep).
//
// Chong gui trung: moi (ngay, su kien) chi gui khi CHEN DUOC dong vao bang
// special_day_notice_log (migration 0043). Gui loi / khong co nguoi nhan -> go dong danh
// dau de lan quet sau thu lai. Theo mau lich cua kiotvietSync/inventoryValueSnapshot.js:
// chay ngay luc khoi dong roi quet moi 5 phut, nen server ngu giua ngay van gui bu duoc.
// Ngay thuong khong cham DB.

const localUserStore = require('../auth/localUserStore');
const notificationRepository = require('./notificationRepository');
const { hasFeature } = require('../auth/featureRegistry');
const { getSpecialDay, todayKey } = require('../public/shared/special-days');

const TYPE_HOLIDAY = 'special_day';
const TYPE_BIRTHDAY = 'special_day_birthday';
const ACTIVE_STATUS = 'Đang hoạt động';
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const CLAIM_SQL = `
  INSERT INTO special_day_notice_log (day_key, event_key)
  VALUES ($1, $2)
  ON CONFLICT (day_key, event_key) DO NOTHING
  RETURNING event_key`;
const RELEASE_SQL = 'DELETE FROM special_day_notice_log WHERE day_key = $1 AND event_key = $2';

function createSpecialDayNotifier(options = {}) {
  const getPool = options.getPool || (() => require('../db/pool').getPool());
  const userStore = options.userStore || localUserStore;
  const notificationRepo = options.notificationRepo || notificationRepository;
  const canView = options.hasFeature || hasFeature;
  const log = options.log || console.log;

  /** Gui thong bao cua HOM NAY (gio VN) neu co va chua gui. Khong bao gio throw. */
  async function notifyIfDue(now = new Date()) {
    let claimed = null;
    try {
      const dateKey = todayKey(now);
      const day = getSpecialDay(dateKey);
      if (!day || day.notify === false || !day.message) return { skipped: true, reason: 'not-special' };

      const pool = getPool();
      const claim = await pool.query(CLAIM_SQL, [dateKey, day.key]);
      if (!claim.rows.length) return { skipped: true, reason: 'already-sent' };
      claimed = { pool, dateKey, eventKey: day.key };

      const users = await userStore.getAllUsers();
      const recipientIds = users
        .filter(u => u && u.id != null && u.trangThai === ACTIVE_STATUS && canView(u, 'hr.leave'))
        .map(u => u.id);
      if (!recipientIds.length) {
        await pool.query(RELEASE_SQL, [dateKey, day.key]);
        return { skipped: true, reason: 'no-recipients' };
      }

      await notificationRepo.createNotificationForUsers(recipientIds, {
        type: day.type === 'birthday' ? TYPE_BIRTHDAY : TYPE_HOLIDAY,
        title: day.title,
        message: day.message,
        relatedType: null,
        relatedId: `${dateKey}:${day.key}`
      });
      log(`[specialDays] ${dateKey} ${day.key}: bao ${recipientIds.length} tai khoan.`);
      return { skipped: false, dateKey, eventKey: day.key, recipients: recipientIds.length };
    } catch (err) {
      console.error('[specialDays] Lỗi báo thông báo ngày đặc biệt:', err.message);
      if (claimed) {
        try { await claimed.pool.query(RELEASE_SQL, [claimed.dateKey, claimed.eventKey]); } catch (_) { /* best-effort */ }
      }
      return { skipped: true, reason: 'error', error: err.message };
    }
  }

  return { notifyIfDue };
}

function startSpecialDayNotifySchedule({
  notifier = createSpecialDayNotifier(),
  intervalMs = POLL_INTERVAL_MS,
  setIntervalFn = setInterval,
  scheduleImmediate = queueMicrotask,
  now = () => new Date()
} = {}) {
  scheduleImmediate(() => { notifier.notifyIfDue(now()); });
  const timer = setIntervalFn(() => { notifier.notifyIfDue(now()); }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

module.exports = {
  TYPE_HOLIDAY,
  TYPE_BIRTHDAY,
  POLL_INTERVAL_MS,
  createSpecialDayNotifier,
  startSpecialDayNotifySchedule
};
