'use strict';

// Sua TRANG THAI cua mot ngay cu trong lich su 7 ngay cua khach (ham thuan, khong I/O): doi trang thai
// ngay D thi so phien lien tiep va tien phat cua cac ngay SAU D tinh lai theo cung quy che cua ban chot
// 15:00 (nextOverdueStreak: ngay truoc "Da xu ly" -> chuoi reset, phien 1). Ngay truoc D khong doi.

const { nextOverdueStreak, suggestedPenalty, RESOLVED_STATUS } = require('./debtScheduleRules');

/** Tien phat cua mot ngay: "Da xu ly" = 0, con lai theo muc goi y cua quy che (khong con phat tay). */
function dayPenalty(overdue, streak, status) {
  return status === RESOLVED_STATUS ? 0 : suggestedPenalty(overdue, streak);
}

/**
 * `days` = cac chu ky tu cu den moi (chi cac ngay con luu): null neu khach khong co dong o ban chot do,
 * hoac { cycleDate, overdue, streak, status }. Tra ve ket qua tinh lai cho moi ngay tu `editIndex` tro di
 * (null neu khach khong co dong): { cycleDate, overdue, streak, status, penalty, streakChanged, statusChanged }.
 * So phien cua chinh ngay D khong doi (phu thuoc ngay truoc D); chi trang thai va tien phat cua D doi.
 */
function applyStatusEdit(days, editIndex, newStatus) {
  const edited = days[editIndex];
  if (!edited) throw new Error('Khach khong co dong o ngay can sua.');
  const results = [];
  let previous = null;
  for (let i = editIndex; i < days.length; i++) {
    const row = days[i];
    if (!row) { results.push(null); previous = null; continue; }
    const status = i === editIndex ? newStatus : row.status;
    const streak = i === editIndex
      ? row.streak
      : nextOverdueStreak(row.overdue, previous ? previous.streak : 0, previous ? previous.status : undefined);
    results.push({
      cycleDate: row.cycleDate, overdue: row.overdue, streak, status,
      penalty: dayPenalty(row.overdue, streak, status),
      streakChanged: streak !== row.streak, statusChanged: status !== row.status
    });
    previous = { streak, status };
  }
  return results;
}

module.exports = { applyStatusEdit, dayPenalty };
