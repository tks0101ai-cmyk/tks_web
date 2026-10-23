// ==========================================
// HR LEAVE ROUTES — /api/hr/* : quan ly yeu cau nghi phep.
//
// Mount trong server/routes.js:
//   const hrLeaveRoutes = require('./hr/hrLeaveRoutes');
//   router.use(hrLeaveRoutes);
//
// Routes nghi phep su dung cung chuan phan quyen va handleError() cua server.
// ==========================================
'use strict';

const express = require('express');
const multer = require('multer');


const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const defaultRepo = require('./hrLeaveRepository');
const { hasFeature } = require('../auth/featureRegistry');
const { createHrLeaveSelfService } = require('./hrLeaveSelfService');
const defaultSchedules=require('./hrLeaveWorkSchedulesRepository');
const {normalizeCalendar}=require('./hrLeaveTiming');
const { createHrLeaveAuthorization, routingWarning } = require('./hrLeaveAuthorization');
const notificationRepo = require('../notifications/notificationRepository');
const employeeDirectory = require('./employeeDirectory');
const hrLeaveService = require('./hrLeaveService');
const {
  resolveApproverName,
  computeDurationSessions,
  parseIsoDateOnly,
  notifyAllUsers: defaultNotifyAllUsers
} = hrLeaveService;
const { buildLeaveRequestsWorkbook } = require('./hrLeaveExportService');
const { buildEmployeeDirectoryWorkbook } = require('./hrEmployeeExportService');
const { BRANCHES, BRANCH_BOTH, allowedBranches, normalizeCoSo, branchLabelToCode } = require('../branch/branches');
const { leaveEvents, LEAVE_EVENT_TYPES, broadcastLeaveEvent } = require('./hrLeaveEvents');
const { createHrLeaveDecisionService } = require('./hrLeaveDecisionService');
const { createHrEmployeeAdminService, STATUS_LABELS } = require('./hrEmployeeAdminService');
const { parseEmployeeWorkbook } = require('./hrEmployeeWorkbookImport');
const { departmentsFor } = require('./hrDepartmentCatalog');
const { importRows: importEmployeeRows } = require('./hrEmployeeWorkbookImportService');
const { parseInsuranceWorkbook, previewInsuranceImport } = require('./hrEmployeeInsuranceImport');
const hrEmployeesRepository = require('./hrEmployeesRepository');

const employeeWorkbookUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 }
});

function receiveEmployeeWorkbook(req, res, next) {
  employeeWorkbookUpload.single('file')(req, res, err => {
    if (!err) return next();
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({
      error: tooLarge ? 'File vượt quá 8 MB.' : 'Không đọc được file Excel.',
      code: tooLarge ? 'HR_EMPLOYEE_FILE_TOO_LARGE' : 'HR_EMPLOYEE_FILE_INVALID'
    });
  });
}
function createHrLeaveRoutes(options = {}) {
const router = express.Router();
const repo = options.repo || defaultRepo;
const notifyAllUsers = options.notifyAllUsers || defaultNotifyAllUsers;
const authorization = options.authorization || createHrLeaveAuthorization();
const notifyApprovers = options.notifyApprovers || notificationRepo.createNotificationForUsers;
const schedules=options.schedules || defaultSchedules;
const selfService = options.selfService || createHrLeaveSelfService({ repo, schedules });
const decisions = options.decisions || createHrLeaveDecisionService({ repo, authorization });

// Phan quyen theo TINH NANG (server/auth/featureRegistry.js).
//   hr.leave        — xem ho so nghi phep (mac dinh: moi vai tro noi bo)
//   hr.employees    — xem Danh sach nhan su
//   hr.leave.manage — tao / duyet nghi phep (mac dinh: chi Quan ly)
const authInternal = [requireAuth, requireFeature('hr.leave'), (req, res, next) => req.user.vaiTro === 'Khách' ? res.status(403).json({ error: 'Khách chỉ được xem đơn nghỉ phép của mình.' }) : next()];
const authEmployees = [requireAuth, requireFeature('hr.employees')];
const authEmployeesManage = [requireAuth, requireFeature('hr.employees.manage')];
const employeeAdmin = options.employeeAdmin || createHrEmployeeAdminService();
const authManager = [requireAuth, requireFeature('hr.leave.manage')];
const authAbsence = [requireAuth, requireFeature('hr.leave.absence.manage')];
const authLeaveList = [requireAuth, requireFeature('hr.leave', 'hr.leave.submit')];

// Bo loc "Co so" cua trang: bo trong / 'all' / "Cả hai" = TAT CA co so tai
// khoan duoc xem (khong phu thuoc co so dang chon o thanh dieu huong); 1 co so
// cu the phai nam trong pham vi duoc phep, neu khong 403 — server luon xac
// thuc lai.
function resolveBranchScope(req, requested) {
  const allowed = allowedBranches(req.user);
  const wanted = String(requested == null ? '' : requested).trim();
  if (!wanted || wanted === 'all') return allowed;
  const branch = normalizeCoSo(wanted);
  // "Cả hai" la lua chon giao dien, khong phai mot co so vat ly. Voi bo loc cua
  // trang no dong nghia "Tat ca co so" — va van bi gioi han trong allowedBranches
  // nen KHONG BAO GIO mo rong pham vi cua tai khoan (vd tai khoan 1 co so).
  if (branch === BRANCH_BOTH) return allowed;
  if (branch !== BRANCHES.HANOI && branch !== BRANCHES.SAIGON) {
    throw new repo.HrError(`Cơ sở không hợp lệ: "${wanted}".`, 400, 'INVALID_BRANCH');
  }
  if (!allowed.includes(branch)) {
    throw new repo.HrError('Bạn không có quyền xem cơ sở này.', 403, 'BRANCH_FORBIDDEN');
  }
  return [branch];
}

// req.branch co the la "Cả hai" — day KHONG phai co so vat ly nen khong duoc
// dung lam nhan co so cho ban ghi hay cho thong bao/SSE.
function physicalBranchOrNull(branch) {
  return branch === BRANCHES.HANOI || branch === BRANCHES.SAIGON ? branch : null;
}

function handleError(res, err, context) {
  if(err.code==='P0001' && /LEAVE_SCHEDULE_REQUIRED/.test(err.message)) return res.status(409).json({error:'Chưa cấu hình giờ bắt đầu buổi nghỉ. Quản lý cần cập nhật lịch làm việc cho nhân sự và ngày đã chọn.',code:'LEAVE_SCHEDULE_REQUIRED'});
  if(err.code==='P0001' && /LEAVE_IDENTITY_MISMATCH/.test(err.message)) return res.status(409).json({error:'Liên kết nhân sự hoặc cơ sở đã thay đổi. Vui lòng tải lại hồ sơ.',code:'LEAVE_IDENTITY_MISMATCH'});
  if(err.code==='P0001' && /INVALID_LEAVE_SESSIONS/.test(err.message)) return res.status(400).json({error:'Lịch nghỉ không hợp lệ.',code:'INVALID_LEAVE_RANGE'});
  if (err.statusCode && err.statusCode < 500) {
    return res.status(err.statusCode).json({ error: err.message, code: err.code });
  }
  // "Co so chua duoc cau hinh nguon du lieu" la 503 nhung KHONG phai loi he
  // thong — giu nguyen thong diep de nguoi dung biet phai lam gi (bao Quan ly
  // cau hinh nguon), thay vi "Loi he thong, vui long thu lai sau".
  if (err.code === 'BRANCH_NOT_CONFIGURED' || err.code === 'HR_DIRECTORY_UNAVAILABLE' || err.code === 'HR_DIRECTORY_SCHEMA_INVALID') {
    console.warn(`[${context}] ${err.detail || err.message}`);
    return res.status(err.statusCode || 503).json({ error: err.message, code: err.code });
  }
  console.error(`=== LOI ${context} ===`);
  console.error(err.stack);
  console.error(`${'='.repeat(context.length + 10)}`);
  return res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại sau.', code: err.code });
}

// ---------------------------------------------------------------------------
// GET /api/hr/leave-requests/stream — Server-Sent Events (SSE) cap nhat realtime
// ---------------------------------------------------------------------------
// Dat TRUOC route /:id de tranh "stream" bi hieu nham la 1 request_id.

router.get('/api/hr/leave-requests/stream', ...authInternal, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  // Gui initial ping xac nhan ket noi thanh cong
  res.write(': connected\n\n');

  const watchedBranches = allowedBranches(req.user);
  const onLeaveEvent = (payload) => {
    // Chi day su kien cua cac co so tai khoan nay duoc phep xem.
    if (payload && payload.branch && !watchedBranches.includes(payload.branch)) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      // Client disconnect, khong can throw
    }
  };

  leaveEvents.on('leave-event', onLeaveEvent);

  // Heartbeat dinh ky de tranh timeout proxy / trinh duyet (25s)
  const heartbeatTimer = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clearInterval(heartbeatTimer);
    }
  }, 25000);

  req.on('close', () => {
    leaveEvents.removeListener('leave-event', onLeaveEvent);
    clearInterval(heartbeatTimer);
  });
});

// ---------------------------------------------------------------------------
// GET /api/hr/leave-requests — danh sach, loc theo status/employee/department/branch/from-to
// ---------------------------------------------------------------------------

router.get('/api/hr/leave-requests', ...authLeaveList, async (req, res) => {
  try {
    const { status, employee, department, branch, from, to } = req.query;
    const viewAll = req.user.vaiTro !== 'Khách' && hasFeature(req.user, 'hr.leave');
    let scope = viewAll ? resolveBranchScope(req, branch) : [];
    if (!viewAll) {
      const context = await selfService.context(req.user);
      if (!context.eligible) throw new defaultRepo.HrError('Tài khoản không đủ điều kiện tự xin nghỉ.', 403, 'SELF_LEAVE_INELIGIBLE');
      scope = [context.profile.coSo];
    }
    const rows = await repo.getLeaveRequests(
      { status, employee, department, from, to, ...(viewAll ? {} : { userId: req.user.id }) }, scope
    );
    const visible = viewAll ? rows : rows.filter(row => String(row.user_id) === String(req.user.id));
    const described = visible.length ? await authorization.describeRequests(req.user, visible) : [];
    const editContext=selfService.canEdit && described.some(row=>row.source==='web' && String(row.user_id)===String(req.user.id)) ? await selfService.context(req.user) : null;
    const requests=await Promise.all(described.map(async row=>({...row,canEdit:selfService.canEdit ? await selfService.canEdit(req.user,row,editContext) : false})));
    res.status(200).json({ requests });
  } catch (err) {
    handleError(res, err, 'GET /api/hr/leave-requests');
  }
});

// Own submissions have their own eligibility guard; this never grants broad HR visibility.
router.get('/api/hr/leave-requests/self/context', requireAuth, async (req, res) => {
  try { res.status(200).json(await selfService.context(req.user)); }
  catch (err) { handleError(res, err, 'GET /api/hr/leave-requests/self/context'); }
});
router.post('/api/hr/leave-requests/self/preview', requireAuth, async(req,res)=>{
  try {res.status(200).json(await selfService.preview(req.user,req.body || {}));}
  catch(err){handleError(res,err,'POST leave preview');}
});
router.post('/api/hr/leave-requests/self/:id/resubmit',requireAuth,async(req,res)=>{
  try {
    const record=await selfService.resubmit(req.user,req.params.id,req.body || {});
    res.status(200).json({request:{...record,canEdit:selfService.canEdit ? await selfService.canEdit(req.user,record) : false}});
    broadcastLeaveEvent(LEAVE_EVENT_TYPES.STATUS_CHANGED,record,record.co_so);
  }catch(err){handleError(res,err,'POST leave resubmit');}
});
router.post('/api/hr/leave-requests/self', requireAuth, async (req, res) => {
  try {
    const record = await selfService.submit(req.user, req.body || {});
    let routing = { users: [], missing: true, fallback: false };
    try { routing = await authorization.routingFor(record); }
    catch (err) { console.error('[HR self] Không thể xác định người duyệt:', err.code || 'ROUTING_FAILED'); }
    const warning = routingWarning(routing);
    res.status(201).json({ request: { ...record, routingWarning: warning }, routingWarning: warning });
    broadcastLeaveEvent(LEAVE_EVENT_TYPES.CREATED, record, record.co_so);
    if(routing.users.length) void notifyApprovers(routing.users.map(user => user.id), {
      type: 'leave_request_created', title: 'Có yêu cầu nghỉ phép mới',
      message: `${record.ho_ten} vừa gửi yêu cầu nghỉ phép.`, relatedType: 'leaveRequest', relatedId: record.request_id
    }).catch(err => console.error('[HR self] Không thể gửi thông báo:', err.code || 'NOTIFICATION_FAILED'));
  } catch (err) { handleError(res, err, 'POST /api/hr/leave-requests/self'); }
});

// ---------------------------------------------------------------------------
// GET /api/hr/leave-requests/summary/urgent-flags — dem "nghi gap"/thang
// ---------------------------------------------------------------------------
// Dat TRUOC route /:id de tranh "summary" bi hieu nham la 1 request_id.

router.get('/api/hr/leave-requests/summary/urgent-flags', ...authInternal, async (req, res) => {
  try {
    const summary = await repo.getUrgentFlagSummary(req.query.month, allowedBranches(req.user));
    res.status(200).json({ summary });
  } catch (err) {
    handleError(res, err, 'GET /api/hr/leave-requests/summary/urgent-flags');
  }
});

// ---------------------------------------------------------------------------
// POST /api/hr/leave-requests/export — xuat Excel danh sach dang loc/sap xep
// ---------------------------------------------------------------------------
// Dat TRUOC route /:id de tranh "export" bi hieu nham la 1 request_id.

router.post('/api/hr/leave-requests/export', ...authInternal, async (req, res) => {
  try {
    const { status, employee, department, branch, from, to, sortField, sortDir, requestIds } = req.body || {};
    const { buffer, fileName, mime } = await buildLeaveRequestsWorkbook(
      { status, employee, department, from, to, sortField, sortDir, requestIds },
      resolveBranchScope(req, branch)
    );
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    handleError(res, err, 'POST /api/hr/leave-requests/export');
  }
});

// ---------------------------------------------------------------------------
// GET /api/hr/leave-requests/:id — chi tiet 1 yeu cau
// ---------------------------------------------------------------------------

async function visibleRequest(req) {
  const viewAll=req.user.vaiTro !== 'Khách' && hasFeature(req.user,'hr.leave');
  let scope=allowedBranches(req.user);
  if(!viewAll) {
    const context=await selfService.context(req.user);
    if(!context.eligible) return null;
    scope=[context.profile.coSo];
  }
  const request=await repo.getLeaveRequestById(req.params.id,scope);
  return request && (viewAll || String(request.user_id)===String(req.user.id)) ? request : null;
}
router.get('/api/hr/leave-requests/:id/history',...authLeaveList,async(req,res)=>{
  try {
    if(!await visibleRequest(req)) return res.status(404).json({error:'Không tìm thấy yêu cầu nghỉ phép.',code:'LEAVE_REQUEST_NOT_FOUND'});
    res.status(200).json({submissions:await repo.getSubmissionHistory(req.params.id)});
  }catch(err){handleError(res,err,'GET leave history');}
});
router.get('/api/hr/leave-requests/:id', ...authLeaveList, async (req, res) => {
  try {
    const request = await visibleRequest(req);
    if (!request) {
      return res.status(404).json({ error: `Không tìm thấy yêu cầu "${req.params.id}".`, code: 'LEAVE_REQUEST_NOT_FOUND' });
    }
    const [described] = await authorization.describeRequests(req.user, [request]);
    res.status(200).json({ request: {...described,canEdit:selfService.canEdit ? await selfService.canEdit(req.user,request) : false} });
  } catch (err) {
    handleError(res, err, 'GET /api/hr/leave-requests/:id');
  }
});

// ---------------------------------------------------------------------------
// POST /api/hr/leave-requests — Quan ly nhap tay (bao gom "tu y nghi")
// ---------------------------------------------------------------------------

router.post('/api/hr/leave-requests', ...authAbsence, async (req, res) => {
  try {
    const {
      web_username, ho_ten, chuc_vu, ly_do, loai_yeu_cau,
      start_date, start_session, end_date, end_session,
      nguoi_ban_giao, co_tu_y_nghi
    } = req.body || {};

    if (!ho_ten || !ly_do) {
      return res.status(400).json({ error: 'Thiếu trường bắt buộc: ho_ten, ly_do.', code: 'INVALID_REQUEST' });
    }

    const calendar=normalizeCalendar(req.body);
    // Định danh là tài khoản (app_users): user_id, hoặc web_username; hr_employee_id cũ chỉ dùng khi trỏ đúng một tài khoản.
    const employee=await schedules.resolveAccount({userId:req.body.user_id,username:web_username,employeeId:req.body.hr_employee_id});
    if(!employee) throw new defaultRepo.HrError('Không tìm thấy tài khoản nhân sự đang hoạt động có cơ sở công tác.',400,'LEAVE_EMPLOYEE_REQUIRED');

    // Dang xem "Cả hai" thi khong co co so nao "dang chon" de gan cho don —
    // lay co so tu ho so nhan su, khong suy ra duoc thi bao loi (4xx) thay vi
    // ghi bua vao mot co so.
    const {branchCodeToLabel}=require('../branch/branches');
    const recordBranch=branchCodeToLabel(employee.branch);
    if(!allowedBranches(req.user).includes(recordBranch) || (physicalBranchOrNull(req.branch) && req.branch!==recordBranch)) throw new defaultRepo.HrError('Bạn không có quyền ghi nhận nhân sự tại cơ sở này.',403,'BRANCH_FORBIDDEN');

    const isManualAbsence = !!co_tu_y_nghi || loai_yeu_cau === repo.LEAVE_TYPE.MANUAL_ABSENCE;
    const record = await repo.createLeaveRequest({
      web_username:employee.username || '',
      user_id:employee.user_id,
      hr_employee_id:null,
      bo_phan:employee.bo_phan,
      ho_ten:employee.ho_ten,
      chuc_vu,
      ly_do,
      loai_yeu_cau: isManualAbsence ? repo.LEAVE_TYPE.MANUAL_ABSENCE : repo.LEAVE_TYPE.REQUEST,
      ...calendar,
      tong_buoi_nghi: calendar.totalSessions,
      nguoi_ban_giao,
      // Ban ghi "tu y nghi" la ghi nhan, khong phai don cho duyet -> mac dinh Da duyet.
      trang_thai: isManualAbsence ? repo.LEAVE_STATUS.APPROVED : repo.LEAVE_STATUS.PENDING,
      nguoi_duyet: isManualAbsence ? resolveApproverName(req.user) : undefined,
      approver_user_id: isManualAbsence ? req.user.id : undefined,
      thoi_diem_duyet: isManualAbsence ? new Date().toISOString() : undefined,
      co_tu_y_nghi: isManualAbsence
    }, recordBranch);
    res.status(201).json({ request: record });

    // Phat tin hieu realtime toi tat ca cac client dang mo
    broadcastLeaveEvent(LEAVE_EVENT_TYPES.CREATED, record, record.co_so || recordBranch);

    const notification = {
      type: isManualAbsence ? 'leave_absence_recorded' : 'leave_request_created',
      title: 'Có nhân sự nghỉ phép mới',
      message: `${record.ho_ten} vừa ${isManualAbsence ? 'được ghi nhận tự ý nghỉ' : 'gửi yêu cầu nghỉ phép'} từ ${record.thoi_gian_bat_dau} đến ${record.thoi_gian_ket_thuc}.`,
      relatedType: 'leaveRequest',
      relatedId: record.request_id || record.id
    };
    if (isManualAbsence) {
      void notifyAllUsers(req.user.id, record.co_so || recordBranch, notification);
    } else {
      // The legacy endpoint may still create pending requests; apply the same routing
      // as self submissions without broadening visibility to unrelated accounts.
      try {
        const routing = await authorization.routingFor(record);
        if (routing.users.length) void notifyApprovers(routing.users.map(user => user.id), notification)
          .catch(err => console.error('[HR legacy create] Không thể gửi thông báo:', err.code || 'NOTIFICATION_FAILED'));
      } catch (err) {
        console.error('[HR legacy create] Không thể xác định người duyệt:', err.code || 'ROUTING_FAILED');
      }
    }
  } catch (err) {
    handleError(res, err, 'POST /api/hr/leave-requests');
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/hr/leave-requests/:id/status — Quan ly doi trang thai phe duyet
// ---------------------------------------------------------------------------

router.patch('/api/hr/leave-requests/:id/status', ...authManager, async (req, res) => {
  try {
    const { status, note, expectedVersion } = req.body || {};
    const updated = await decisions.decide({ requestId: req.params.id, user: req.user, status, note, expectedVersion, channel: 'web' }, { notify: false });
    res.status(200).json({ request: updated });
    void decisions.notifyDecision(updated, req.user && req.user.id, typeof note === 'string' ? note.trim() : undefined);
  } catch (err) {
    handleError(res, err, 'PATCH /api/hr/leave-requests/:id/status');
  }
});

// ---------------------------------------------------------------------------
// POST /api/hr/telegram/link-code — tu sinh ma lien ket cho chinh minh
// ---------------------------------------------------------------------------

router.post('/api/hr/telegram/link-code', ...authInternal, (_req, res) => {
  res.status(410).json({
    error: 'Luồng liên kết Telegram qua Google Sheets đã tạm ngừng. Bot sẽ liên kết trực tiếp qua tài khoản trong Postgres.',
    code: 'TELEGRAM_SHEET_LINK_DISABLED'
  });
});

// ---------------------------------------------------------------------------
// POST /api/hr/telegram/link-code/assign — Quan ly sinh ma ho nhan vien khac
// ---------------------------------------------------------------------------

router.post('/api/hr/telegram/link-code/assign', ...authManager, (_req, res) => {
  res.status(410).json({
    error: 'Luồng liên kết Telegram qua Google Sheets đã tạm ngừng. Bot sẽ liên kết trực tiếp qua tài khoản trong Postgres.',
    code: 'TELEGRAM_SHEET_LINK_DISABLED'
  });
});

// ---------------------------------------------------------------------------
// GET /api/hr/employees — danh sach nhan su (ten, bo phan, co so, sdt, email)
// cua moi co so tai khoan duoc xem; trang loc theo co so/phong ban phia client.
// ---------------------------------------------------------------------------

// Dang cong khai 1 nhan su cho giao dien. `ngayThem` (ngay tao dong) chi gui cho
// tai khoan co 'hr.employees.manage'; nguoi khac khong nhan truong nay.
function publicEmployee(employee, canManage) {
  const out = {
    id: String(employee.rowIndex),
    hoTen: employee.hoTen,
    boPhan: employee.boPhan,
    coSo: employee.sourceBranch,
    soDienThoai: employee.soDienThoai,
    email: employee.email,
    trangThai: STATUS_LABELS[employee.employmentStatus] || STATUS_LABELS.active
  };
  if (canManage) out.ngayThem = employee.createdAt || '';
  if (canManage) Object.assign(out, {
    chucVu: employee.chucVu || '', ngayVaoLam: employee.ngayVaoLam || null,
    ngaySinh: employee.ngaySinh || null, soCccd: employee.soCccd || '',
    diaChiHienTai: employee.diaChiHienTai || '', nguoiThanQuanHe: employee.nguoiThanQuanHe || '',
    nguoiThanHoTen: employee.nguoiThanHoTen || '', nguoiThanSoDienThoai: employee.nguoiThanSoDienThoai || '',
    gioiTinh: employee.gioiTinh || '', hoSoDayDu: !!employee.hoSoDayDu,
    vanTayDaDangKy: !!employee.vanTayDaDangKy, insuranceNumber: employee.insuranceNumber || '', ngayNghiViec: employee.ngayNghiViec || null
  });
  return out;
}

router.get('/api/hr/employees', ...authEmployees, async (req, res) => {
  try {
    const branches = allowedBranches(req.user);
    const canManage = hasFeature(req.user, 'hr.employees.manage');
    const snapshot = await employeeDirectory.getSnapshot();
    const employees = snapshot.employees
      .filter(employee => branches.includes(employee.sourceBranch))
      .map(employee => publicEmployee(employee, canManage))
      .sort((a, b) => a.hoTen.localeCompare(b.hoTen, 'vi'));
    const departments = {};
    branches.forEach(label => { departments[label] = departmentsFor(branchLabelToCode(label)); });
    res.status(200).json({ employees, stale: !!snapshot.stale, canManage, departments });
  } catch (err) {
    handleError(res, err, 'GET /api/hr/employees');
  }
});

// Them / sua nhan su (kem trang thai lam viec). Response co `accounts` = tai khoan
// da khoa / mo khoa / bo qua do doi trang thai.
router.post('/api/hr/employees', ...authEmployeesManage, async (req, res) => {
  try {
    const { employee, accounts } = await employeeAdmin.createEmployee(req.user, req.body);
    res.status(201).json({ employee: publicEmployee(employee, true), accounts });
  } catch (err) {
    handleError(res, err, 'POST /api/hr/employees');
  }
});

router.put('/api/hr/employees/:id', ...authEmployeesManage, async (req, res) => {
  try {
    const { employee, accounts } = await employeeAdmin.updateEmployee(req.user, req.params.id, req.body);
    res.status(200).json({ employee: publicEmployee(employee, true), accounts });
  } catch (err) {
    handleError(res, err, 'PUT /api/hr/employees/:id');
  }
});

router.post('/api/hr/employees/import', ...authEmployeesManage, receiveEmployeeWorkbook, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'Vui lòng chọn file Excel.', code: 'HR_EMPLOYEE_FILE_REQUIRED' });
    }
    const rows = parseEmployeeWorkbook(req.file.buffer);
    const permitted = allowedBranches(req.user).map(label => label === BRANCHES.HANOI ? 'hanoi' : 'saigon');
    const forbidden = rows.find(row => !permitted.includes(row.branch));
    if (forbidden) return res.status(403).json({ error: 'File có cơ sở ngoài phạm vi quản lý.', code: 'BRANCH_FORBIDDEN' });
    const result = await importEmployeeRows(rows);
    employeeDirectory.clearCache();
    return res.status(200).json(result);
  } catch (err) {
    handleError(res, err, 'POST /api/hr/employees/import');
  }
});

router.post('/api/hr/employees/insurance-import', ...authEmployeesManage, receiveEmployeeWorkbook, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'Vui lòng chọn file Excel.', code: 'HR_EMPLOYEE_FILE_REQUIRED' });
    const rows = await parseInsuranceWorkbook(req.file.buffer);
    const snapshot = await employeeDirectory.getSnapshot({ forceRefresh: true });
    const preview = previewInsuranceImport(rows, snapshot.employees, allowedBranches(req.user));
    if (!rows.length || !preview.valid) return res.status(400).json({ error: 'File không có số bảo hiểm hợp lệ.', ...preview, updates: undefined });
    if (req.query.commit === '1') {
      if (preview.errors.length) return res.status(400).json({ error: 'Hãy sửa các dòng lỗi trước khi nhập.', ...preview, updates: undefined });
      await hrEmployeesRepository.updateInsuranceNumbers(preview.updates);
      employeeDirectory.clearCache();
    }
    return res.status(200).json({ total: preview.total, valid: preview.valid, errors: preview.errors, imported: req.query.commit === '1' ? preview.valid : 0 });
  } catch (err) { handleError(res, err, 'POST /api/hr/employees/insurance-import'); }
});

// Lịch làm việc theo tài khoản (app_users.id). Quyền: đúng cơ sở công tác + bộ phận của tài khoản trong phạm vi duyệt.
async function scheduleAccount(req) {
  const account=await schedules.getAccount(req.params.userId);
  if(!account) throw new defaultRepo.HrError('Không tìm thấy tài khoản đang hoạt động có cơ sở công tác.',404,'HR_ACCOUNT_NOT_FOUND');
  await authorization.authorizeEmployee(req.user,{branch:account.branch,bo_phan:account.bo_phan});
  return account;
}
router.get('/api/hr/leave-work-schedules/:userId',...authManager,async(req,res)=>{
  try {const account=await scheduleAccount(req);res.status(200).json({schedule:await schedules.getScheduleForUser(account.user_id,req.query.date)});}
  catch(err){handleError(res,err,'GET work schedule');}
});
router.put('/api/hr/leave-work-schedules/:userId',...authManager,async(req,res)=>{
  try {const account=await scheduleAccount(req);const body=req.body||{};res.status(200).json({schedule:await schedules.setScheduleForUser(account.user_id,{date:body.date,morningStart:body.morningStart ?? null,afternoonStart:body.afternoonStart ?? null})});}
  catch(err){handleError(res,err,'PUT work schedule');}
});
// Danh sách tài khoản để chọn khi ghi nhận nghỉ/cấu hình lịch, lọc theo cơ sở được phép.
router.get('/api/hr/leave-accounts',...authAbsence,async(req,res)=>{
  try {
    const {branchCodeToLabel}=require('../branch/branches');
    const allowed=allowedBranches(req.user);
    const accounts=(await schedules.listAccounts()).filter(a=>allowed.includes(branchCodeToLabel(a.branch)));
    res.status(200).json({accounts:accounts.map(a=>({id:a.user_id,username:a.username,hoTen:a.ho_ten,boPhan:a.bo_phan,coSo:branchCodeToLabel(a.branch)}))});
  } catch(err){handleError(res,err,'GET leave accounts');}
});

// ---------------------------------------------------------------------------
// GET /api/hr/employees/export — xuat Excel Danh sach nhan su dang tim kiem
// ---------------------------------------------------------------------------
// Dat TRUOC route /:id neu sau nay them (hien tai chua co, nhung giu quy uoc).

router.get('/api/hr/employees/export', ...authEmployees, async (req, res) => {
  try {
    const { keyword, department, branch, status } = req.query || {};
    const { buffer, fileName, mime } = await buildEmployeeDirectoryWorkbook(
      { keyword, department, status, includeExtended: hasFeature(req.user, 'hr.employees.manage') },
      resolveBranchScope(req, branch)
    );
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    handleError(res, err, 'GET /api/hr/employees/export');
  }
});

return router;
}
module.exports = createHrLeaveRoutes();
module.exports.createHrLeaveRoutes = createHrLeaveRoutes;
