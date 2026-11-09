'use strict';
const { getPool } = require('../db/pool');
const leaveRepo = require('./hrLeaveRepository');
const { branchCodeToLabel } = require('../branch/branches');
const { computeIsUrgent } = require('./hrLeaveService');
const {normalizeCalendar,calculateTiming}=require('./hrLeaveTiming');
const defaultSchedules=require('./hrLeaveWorkSchedulesRepository');
const { normalizeWorkAssignment } = require('../auth/accountWorkAssignment');

// Account identity and workplace are authoritative, including accounts without an HR link.
async function loadActiveProfile(userId, pool = getPool()) {
  const { rows } = await pool.query(`
    SELECT u.id AS user_id, u.username, u.vai_tro, u.telegram_id, NULL::bigint AS hr_employee_id,
           COALESCE(NULLIF(u.ho_ten, ''), u.username) AS ho_ten,
           u.bo_phan, u.work_branch AS branch
    FROM app_users u
    WHERE u.id = $1 AND u.trang_thai = 'Đang hoạt động' AND NOT u.is_deleted
      AND u.work_branch IN ('hanoi', 'saigon') AND btrim(u.bo_phan) <> ''
  `, [userId]);
  const row = rows[0];
  if (!row) return null;
  try {
    normalizeWorkAssignment({ vaiTro: row.vai_tro, workCoSo: branchCodeToLabel(row.branch), boPhan: row.bo_phan });
    return row;
  } catch { return null; }
}
// Ghi đè nhãn theo tài khoản (bảng hr_leave_timing_overrides, migration 0120).
// Chỉ phục vụ hiển thị "Dự kiến" cho khớp: nhãn lưu thật do trigger DB hr_leave_01_timing_override quyết định.
// Fail-soft nếu chưa có bảng.
async function hasTimingOverride(userId, pool) {
  try {
    const { rows } = await (pool || getPool()).query('SELECT 1 FROM hr_leave_timing_overrides WHERE user_id = $1', [userId]);
    return rows.length > 0;
  } catch { return false; }
}
function createHrLeaveSelfService({ loadProfile = loadActiveProfile, repo = leaveRepo, schedules=defaultSchedules, timingOverride = hasTimingOverride, now = () => new Date() } = {}) {
  async function context(user) {
    const row = user && user.id ? await loadProfile(user.id) : null;
    if (!row) return { eligible: false, profile: null };
    return { eligible: true, profile: {
      userId: row.user_id, hrEmployeeId: row.hr_employee_id, username: row.username, telegramChatId: row.telegram_id || '',
      hoTen: row.ho_ten, boPhan: row.bo_phan, coSo: branchCodeToLabel(row.branch), vaiTro: row.vai_tro
    } };
  }
  async function prepare(user,body={},reasonRequired=true) {
    const ctx = await context(user);
    if (!ctx.eligible) throw new leaveRepo.HrError('Tài khoản chưa được cấu hình cơ sở công tác và bộ phận.', 403, 'SELF_LEAVE_WORK_ASSIGNMENT_REQUIRED');
    if (reasonRequired && (typeof body.ly_do !== 'string' || !body.ly_do.trim())) throw new leaveRepo.HrError('Vui lòng nhập lý do nghỉ.', 400, 'INVALID_REASON');
    if (body.nguoi_ban_giao != null && typeof body.nguoi_ban_giao !== 'string') throw new leaveRepo.HrError('Người bàn giao phải là chuỗi ký tự.', 400, 'INVALID_HANDOVER');
    if (body.end_date != null && typeof body.end_date !== 'string') throw new leaveRepo.HrError('Ngày kết thúc không hợp lệ.', 400, 'INVALID_LEAVE_RANGE');
    const calendar=normalizeCalendar(body);
    const submittedAt = now();
    // Work schedules are keyed by account regardless of HR linkage.
    const schedule=await schedules.getScheduleForUser(ctx.profile.userId,calendar.start_date);
    const timing=calculateTiming(calendar,schedule,submittedAt);
    // Áp ghi đè nhãn theo tài khoản (nếu có).
    if (timing.timingStatus === 'Xin muộn' && await timingOverride(ctx.profile.userId)) timing.timingStatus = 'Đúng hạn';
    return {ctx,calendar,timing,submittedAt};
  }
  async function preview(user,body={}) {return (await prepare(user,body,false)).timing;}
  async function submit(user, body = {}) {
    const {ctx,calendar,timing,submittedAt}=await prepare(user,body);
    const profile = ctx.profile;
    return repo.createLeaveRequest({
      user_id: profile.userId, hr_employee_id: profile.hrEmployeeId, web_username: profile.username,
      telegram_chat_id: profile.telegramChatId,
      ho_ten: profile.hoTen, bo_phan: profile.boPhan, chuc_vu: profile.vaiTro,
      ly_do: body.ly_do.trim(), nguoi_ban_giao: (body.nguoi_ban_giao || '').trim(),
      ...calendar,
      tong_buoi_nghi: calendar.totalSessions, tong_ngay_nghi: calendar.totalSessions / 2,
      timing_status:timing.timingStatus,
      co_nghi_gap: computeIsUrgent(timing.firstSessionStartAt,submittedAt), co_tu_y_nghi: false,
      trang_thai: leaveRepo.LEAVE_STATUS.PENDING,
      loai_yeu_cau: leaveRepo.LEAVE_TYPE.REQUEST
    }, profile.coSo);
  }
  async function canEdit(user,request,loadedContext) {
    if(!request || request.source!=='web' || request.loai_yeu_cau!==leaveRepo.LEAVE_TYPE.REQUEST || String(request.user_id)!==String(user && user.id)) return false;
    const ctx=loadedContext || await context(user);
    return ctx.eligible && ctx.profile.coSo===request.co_so;
  }
  async function resubmit(user,id,body={}) {
    const {ctx,calendar}=await prepare(user,body);
    const request=await repo.getLeaveRequestById(id,ctx.profile.coSo);
    if(!await canEdit(user,request)) throw new leaveRepo.HrError('Bạn không có quyền sửa đơn này hoặc liên kết nhân sự đã thay đổi.',403,'LEAVE_EDIT_FORBIDDEN');
    return repo.resubmitLeaveRequest(id,{...calendar,userId:ctx.profile.userId,employeeId:ctx.profile.hrEmployeeId,expectedVersion:body.expectedVersion,ly_do:body.ly_do.trim(),nguoi_ban_giao:(body.nguoi_ban_giao||'').trim()},ctx.profile.coSo);
  }
  return { context, submit, preview, resubmit, canEdit };
}
module.exports = { createHrLeaveSelfService, loadActiveProfile };
