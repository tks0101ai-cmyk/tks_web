// ==========================================
// ADMIN USER ROUTES — API quản trị tài khoản người dùng dành riêng cho Quản lý.
// Cung cấp các thao tác CRUD, đặt lại mật khẩu, khóa/mở khóa tài khoản.
// Áp dụng chặt chẽ business rule: Chống tự hạ quyền, tự khóa, tự xóa chính mình.
// ==========================================
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { requireAuth, requireFeature } = require('./authMiddleware');
const localUserStore = require('./localUserStore');
const { ROLES, ACTIVE_STATUS, INACTIVE_STATUS, LOCKED_STATUS, PENDING_STATUS } = localUserStore;
const { normalizePhone } = require('./userRepository');
const featureRegistry = require('./featureRegistry');
const notificationRepo = require('../notifications/notificationRepository');
const { normalizeCoSo, BRANCH_VALUES } = require('../branch/branches');
const contactChangeService = require('./contactChangeService');
const employeeDirectory = require('../hr/employeeDirectory');
const accountPolicy = require('./accountPolicy');
const { normalizeDepartments } = require('../hr/hrApprovalDepartments');
const userExport = require('./adminUserExportService');
const accountAuditLog = require('./accountAuditLog');
const { normalizeWorkAssignment } = require('./accountWorkAssignment');
const { departmentsFor, suggestedDepartmentsByRole } = require('../hr/hrDepartmentCatalog');

const router = express.Router();

const VALID_ROLES = Object.values(ROLES);
const VALID_STATUSES = [ACTIVE_STATUS, INACTIVE_STATUS, LOCKED_STATUS, PENDING_STATUS];

function publicAdminUser(u) {
  return {
    ...Object.fromEntries(userExport.EXPORT_FIELDS.map(field => [field.key, field.value(u)])),
    id: u.id,
    username: u.username,
    hoTen: u.hoTen,
    email: u.email || '',
    soDienThoai: u.soDienThoai || '',
    telegramId: u.telegramId || '',
    emailKhoiPhuc: u.emailKhoiPhuc || '',
    sdtKhoiPhuc: u.sdtKhoiPhuc || '',
    vaiTro: u.vaiTro,
    coSo: u.coSo || '',
    assignedCoSo: u.assignedCoSo ?? u.coSo ?? '',
    boPhan: u.boPhan || '',
    workCoSo: u.workCoSo || '',
    leaveApprovalDepartments: normalizeDepartments(u.leaveApprovalDepartments || []),
    trangThai: u.trangThai,
    ngayTao: u.ngayTao || '',
    dangNhapGanNhat: u.dangNhapGanNhat || '',
    hasPassword: !!u.passwordHash,
    hrManaged: !!u.hrManaged,
    hrSourceBranch: u.hrSourceBranch || '',
    sheetVaiTro: u.sheetVaiTro || '',
    sheetCoSo: u.sheetCoSo || '',
    vaiTroOverride: u.vaiTroOverride || '',
    coSoOverride: u.coSoOverride || '',
    roleSource: u.roleSource || (u.hrManaged ? 'sheet' : 'local'),
    lockReason: u.lockReason || '',
    // Ghi de quyen rieng cua tai khoan (DELTA so voi mac dinh theo vai tro) —
    // bang nguoi dung dua vao day de hien nhan "đã tuỳ chỉnh quyền".
    featurePermissions: featureRegistry.sanitizeOverrides(u.featurePermissions)
  };
}

// Phan quyen theo TINH NANG (featureRegistry.js):
//   account.users         — xem danh sach (mac dinh: moi vai tro noi bo)
//   account.users.manage  — them/sua/khoa/xoa (mac dinh: chi Quan ly)
//   account.permissions   — phan quyen chi tiet (mac dinh: chi Quan ly)
/**
 * Luat 5c (accountPolicy.checkHrRoleEscalation): doi chieu `identities` ({ emails, phones } —
 * thuong lay tu accountPolicy.hrIdentitiesOf, tuc MOI dinh danh resolver khop, gom ca username)
 * voi cac dong hr_employees DANG HOAT DONG (chi doc). Quan ly bo qua (duoc gan moi vai tro).
 * Dong da gan voi chinh `target` (hrRowIndex) khong tinh. Khong doi chieu duoc => fail closed.
 * Tra ve null neu duoc phep, hoac { status, code, error }.
 */
async function checkHrIdentityEscalation(actor, identities, target) {
  if (accountPolicy.isManagerClass(actor)) return null;
  const clean = values => (values || []).map(v => String(v || '').trim()).filter(Boolean);
  const parts = [
    ...clean(identities && identities.emails).map(email => ({ email })),
    ...clean(identities && identities.phones).map(phone => ({ phone }))
  ];
  if (!parts.length) return null;

  let snapshot;
  try {
    snapshot = await employeeDirectory.getSnapshot();
  } catch (err) {
    console.error('[adminUserRoutes] Không đối chiếu được Danh sách nhân sự:', err && err.message);
    return { status: 503, code: 'HR_DIRECTORY_UNAVAILABLE', error: 'Không thể đối chiếu Danh sách nhân sự, vui lòng thử lại sau.' };
  }
  const employees = (snapshot && snapshot.employees) || [];
  const matches = [];
  for (const part of parts) {
    try {
      const employee = employeeDirectory.findEmployeeByIdentifier(employees, part);
      if (employee) matches.push(employee);
    } catch (err) {
      if (err && err.code === 'HR_IDENTITY_CONFLICT') {
        return { status: 403, code: accountPolicy.HR_ROLE_ESCALATION_CODE, error: 'Email/số điện thoại này trùng nhiều dòng nhân sự — chỉ Quản lý mới được gán.' };
      }
      throw err;
    }
  }
  const boundRow = target && target.hrRowIndex !== undefined && target.hrRowIndex !== null ? String(target.hrRowIndex) : '';
  const relevant = matches.filter(employee => !boundRow || String(employee.rowIndex) !== boundRow);
  const reason = accountPolicy.checkHrRoleEscalation(actor, relevant);
  return reason ? { status: 403, code: accountPolicy.HR_ROLE_ESCALATION_CODE, error: reason } : null;
}

function approvalScopeChange(actor, current, next, body) {
  const explicit = Object.hasOwn(body, 'leaveApprovalDepartments');
  if (explicit && (!Array.isArray(body.leaveApprovalDepartments) || body.leaveApprovalDepartments.some(value => typeof value !== 'string'))) {
    return { status: 400, code: 'INVALID_LEAVE_DEPARTMENTS', error: 'Phòng ban duyệt phải là danh sách chuỗi.' };
  }
  let departments = normalizeDepartments((explicit ? body.leaveApprovalDepartments : current && current.leaveApprovalDepartments) || []);
  if (next.vaiTro === ROLES.QUAN_LY && (!current || current.vaiTro !== ROLES.QUAN_LY) && (!explicit || !departments.length)) {
    return { status: 400, code: 'LEAVE_DEPARTMENTS_REQUIRED', error: 'Vui lòng chọn ít nhất một phòng ban duyệt cho Quản lý mới.' };
  }
  if (!explicit && !departments.length && current && !featureRegistry.hasFeature(current, 'hr.leave.manage') && featureRegistry.hasFeature(next, 'hr.leave.manage')) {
    departments = normalizeDepartments([current.boPhan || '']);
  }
  const denied = accountPolicy.checkDepartmentGrant(actor, current, departments);
  if (denied) return { status: 403, code: accountPolicy.DENIED_CODE, error: denied };
  if (current && JSON.stringify(departments) !== JSON.stringify(normalizeDepartments(current.leaveApprovalDepartments || []))) {
    const protectedReason = accountPolicy.checkProtectedManager(actor, current, 'đổi phạm vi duyệt phòng ban');
    if (protectedReason) return { status: 403, code: accountPolicy.DENIED_CODE, error: protectedReason };
  }
  return { departments };
}

// ID Telegram dạng chuỗi số (giữ nguyên độ chính xác > 2^53). Rỗng = không liên kết.
function parseTelegramId(raw) {
  if (typeof raw !== 'string') return { error: 'ID Telegram phải là chuỗi chữ số.' };
  const value = raw.trim();
  if (value && !/^[1-9]\d{0,19}$/.test(value)) return { error: 'ID Telegram phải là số nguyên dương, tối đa 20 chữ số.' };
  return { value };
}

async function departmentCatalog() {
  const [users, historical] = await Promise.all([
    localUserStore.getAllUsers(),
    require('./appUsersRepository').selectApprovalDepartmentCatalog().catch(() => [])
  ]);
  return normalizeDepartments([
    ...departmentsFor('hanoi'), ...departmentsFor('saigon'),
    ...historical,
    ...users.flatMap(user => [user.boPhan || '', ...normalizeDepartments(user.leaveApprovalDepartments || [])])
  ]).sort((a, b) => a.localeCompare(b, 'vi'));
}

const authView = [requireAuth, requireFeature('account.users')];
const authManage = [requireAuth, requireFeature('account.users.manage')];
const authPermissions = [requireAuth, requireFeature('account.permissions')];

/**
 * GET /api/admin/users — Danh sách tất cả người dùng trong hệ thống.
 */
router.get('/api/admin/users', ...authView, async (req, res) => {
  try {
    const users = await localUserStore.getAllUsers();
    const result = users.map(publicAdminUser);
    res.status(200).json({ users: result });
  } catch (err) {
    console.error('=== LOI GET /api/admin/users ===', err);
    res.status(500).json({ error: 'Không tải được danh sách người dùng.' });
  }
});

/**
 * GET /api/admin/users/export/fields — danh mục trường có thể xuất (cho hộp chọn trường).
 */
router.get('/api/admin/users/export/fields', ...authView, (req, res) => {
  res.status(200).json({
    fields: userExport.EXPORT_FIELDS.map(f => ({ key: f.key, label: f.label })),
    defaults: userExport.DEFAULT_FIELD_KEYS
  });
});

/**
 * GET /api/admin/users/export?fields=a,b&q=&role=&coSo=&trangThai= — Xuất Excel
 * danh sách tài khoản (đúng bộ lọc đang xem) với các trường được chọn.
 * Chỉ Quản lý (account.users.manage). Không bao giờ xuất mật khẩu.
 */
router.get('/api/admin/users/export', ...authManage, async (req, res) => {
  try {
    const fieldKeys = userExport.parseFieldKeys(req.query.fields);
    if (!fieldKeys) {
      return res.status(400).json({ error: 'Vui lòng chọn ít nhất một trường thông tin để xuất.', code: 'NO_EXPORT_FIELDS' });
    }
    const str = v => (typeof v === 'string' ? v : '');
    const users = await localUserStore.getAllUsers();
    const { buffer, fileName, mime } = await userExport.buildUserWorkbook(
      users,
      { q: str(req.query.q), role: str(req.query.role), coSo: str(req.query.coSo), trangThai: str(req.query.trangThai) },
      fieldKeys
    );
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error('=== LOI GET /api/admin/users/export ===', err);
    res.status(500).json({ error: 'Không xuất được file Excel danh sách tài khoản.' });
  }
});

/**
 * POST /api/admin/users — Tạo mới một tài khoản người dùng.
 */
router.post('/api/admin/users', ...authManage, async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const hoTen = String(req.body.hoTen || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const soDienThoai = String(req.body.soDienThoai || '').trim();
    const vaiTro = String(req.body.vaiTro || ROLES.KHACH).trim();
    const rawCoSo = String(req.body.coSo || '').trim();
    // Chuan hoa ve dung 'Hà Nội' | 'Sài Gòn' | 'Cả hai'; gia tri la ('An Khánh'
    // /'Tân Phú' cua du lieu cu) van duoc chap nhan va tu doi ten.
    const coSo = rawCoSo ? normalizeCoSo(rawCoSo) : '';

    if (!username) {
      return res.status(400).json({ error: 'Vui lòng nhập tên tài khoản (username).' });
    }
    if (username.length < 3 || username.length > 50) {
      return res.status(400).json({ error: 'Tên tài khoản phải từ 3 đến 50 ký tự.' });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'Mật khẩu khởi tạo phải có ít nhất 8 ký tự.' });
    }
    if (!hoTen) {
      return res.status(400).json({ error: 'Vui lòng nhập họ và tên.' });
    }
    if (email && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
      return res.status(400).json({ error: 'Email không đúng định dạng.' });
    }
    if (soDienThoai) {
      const normPhone = normalizePhone(soDienThoai);
      if (!/^(0|\+84)(3|5|7|8|9)[0-9]{8}$/.test(normPhone) && !/^[0-9]{10}$/.test(normPhone)) {
        return res.status(400).json({ error: 'Số điện thoại không đúng định dạng (yêu cầu 10 số).' });
      }
    }
    if (!VALID_ROLES.includes(vaiTro)) {
      return res.status(400).json({ error: `Vai trò không hợp lệ. Cho phép: ${VALID_ROLES.join(', ')}` });
    }
    if (rawCoSo && !coSo) {
      return res.status(400).json({ error: `Cơ sở phụ trách không hợp lệ. Cho phép: ${BRANCH_VALUES.join(', ')}` });
    }
    // Nguoi khong phai Quan ly chi tao duoc tai khoan co quyen <= quyen cua chinh ho.
    // Luat 5a: khong tao TK mang dinh danh admin cung (resolver nhan admin theo email/username).
    const protectedId = accountPolicy.checkProtectedIdentity(req.user, [username, email, soDienThoai]);
    if (protectedId) return accountPolicy.sendDenied(res, protectedId, accountPolicy.PROTECTED_IDENTITY_CODE);
    const denied = accountPolicy.checkGrant(req.user, null, { username, email, vaiTro, featurePermissions: {} });
    if (denied) return accountPolicy.sendDenied(res, denied);
    // Luat 5c: TK moi (ke ca Khach — dang nhap Google se gan TK khop vao dong nhan su) khong
    // duoc mang email/SĐT/username cua nhan su co vai tro vuot quyen actor duoc cap.
    const hrDenied = await checkHrIdentityEscalation(req.user, accountPolicy.hrIdentitiesOf({
      username, email, soDienThoai: normalizePhone(soDienThoai)
    }), null);
    if (hrDenied) return res.status(hrDenied.status).json({ error: hrDenied.error, code: hrDenied.code });

    const scope = approvalScopeChange(req.user, null, { vaiTro }, req.body);
    if (scope.error) return res.status(scope.status).json({ error: scope.error, code: scope.code });
    const assignment = normalizeWorkAssignment({ vaiTro, workCoSo: req.body.workCoSo, boPhan: req.body.boPhan });
    let telegramId = '';
    if (Object.hasOwn(req.body, 'telegramId')) {
      const parsedTelegram = parseTelegramId(req.body.telegramId);
      if (parsedTelegram.error) return res.status(400).json({ error: parsedTelegram.error, code: 'INVALID_TELEGRAM_ID' });
      telegramId = parsedTelegram.value;
    }
    if (telegramId && (await localUserStore.getAllUsers()).some(u => !u.isDeleted && u.telegramId === telegramId)) {
      return res.status(409).json({ error: 'ID Telegram này đã được sử dụng. Vui lòng kiểm tra lại.', code: 'TELEGRAM_ID_EXISTS' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    let newUser = await localUserStore.createUser({
      id: crypto.randomUUID(),
      username,
      passwordHash,
      hoTen,
      email,
      soDienThoai: normalizePhone(soDienThoai),
      vaiTro,
      coSo,
      ...assignment,
      trangThai: ACTIVE_STATUS,
      leaveApprovalDepartments: scope.departments
    });

    // Telegram đi qua đường cập nhật hồ sơ để ghi đồng thời liên kết bot (hr_telegram_links).
    let telegramWarning = null;
    if (telegramId) {
      try {
        newUser = await localUserStore.updateUser(newUser.id, { telegramId });
        employeeDirectory.clearCache();
      } catch (telegramErr) {
        telegramWarning = 'Đã tạo tài khoản nhưng chưa lưu được ID Telegram: ' + (telegramErr.message || 'lỗi không xác định');
      }
    }

    res.status(201).json({ user: publicAdminUser(newUser), ...(telegramWarning ? { warning: telegramWarning } : {}) });
    await accountAuditLog.record({
      action: accountAuditLog.ACTIONS.CREATE, actor: req.user, target: newUser,
      changes: accountAuditLog.initialValues(newUser)
    });

    // Bao cho nhung nguoi khac co quyen quan ly tai khoan - best-effort,
    // KHONG duoc lam hong response da tra o tren.
    try {
      const allUsers = await localUserStore.getAllUsers();
      const managerIds = allUsers
        .filter(u => featureRegistry.hasFeature(u, 'account.users.manage') && String(u.id) !== String(req.user.id))
        .map(u => u.id);
      await notificationRepo.createNotificationForUsers(managerIds, {
        type: 'account_created',
        title: 'Tài khoản mới được tạo',
        message: `${newUser.hoTen || newUser.username} (${newUser.username}) vừa được tạo với vai trò "${newUser.vaiTro}".`,
        relatedType: 'accountCreated',
        relatedId: newUser.id
      });
    } catch (notifyErr) {
      console.error('Lỗi báo thông báo tài khoản mới cho Quản lý:', notifyErr.message);
    }
  } catch (err) {
    if (err && err.code === 'USER_EXISTS') {
      return res.status(409).json({ error: err.message });
    }
    if (err && err.statusCode && err.statusCode < 500) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    console.error('=== LOI POST /api/admin/users ===', err);
    res.status(500).json({ error: 'Không tạo được tài khoản, vui lòng thử lại.' });
  }
});

/**
 * PUT /api/admin/users/:id — Chỉnh sửa thông tin tài khoản.
 */
router.put('/api/admin/users/:id', ...authManage, async (req, res) => {
  try {
    const targetId = req.params.id;
    let targetUser = await localUserStore.getUserById(targetId);
    if (!targetUser) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản cần chỉnh sửa.' });
    }
    const notWritable = accountPolicy.checkTargetWritable(req.user, targetUser);
    if (notWritable) return accountPolicy.sendDenied(res, notWritable);
    // Ban chup TRUOC khi sua (targetUser bi gan lai trong vong pendingAdminChanges).
    const userBefore = targetUser;

    const currentAdminId = req.user.id;
    const isSelf = String(currentAdminId) === String(targetId) ||
                   req.user.username.toLowerCase() === targetUser.username.toLowerCase();
    const isTargetThang = (localUserStore.isProtectedSuperAdmin && (localUserStore.isProtectedSuperAdmin(targetUser.email) || localUserStore.isProtectedSuperAdmin(targetUser.username))) ||
                          (targetUser.email && targetUser.email.toLowerCase() === 'thangnnv2003@gmail.com') ||
                          (targetUser.username && targetUser.username.toLowerCase() === 'thangnnv2003@gmail.com') ||
                          (targetUser.username && targetUser.username.toLowerCase() === 'thangnnv2003');
    const isTargetHardcodedAdmin = localUserStore.isHardcodedAdmin(targetUser.email) ||
                                   localUserStore.isHardcodedAdmin(targetUser.username);

    const updates = {};

    if (Object.hasOwn(req.body, 'telegramId')) {
      const parsedTelegram = parseTelegramId(req.body.telegramId);
      if (parsedTelegram.error) return res.status(400).json({ error: parsedTelegram.error, code: 'INVALID_TELEGRAM_ID' });
      const telegramId = parsedTelegram.value;
      if (telegramId !== (targetUser.telegramId || '')) {
        const denied = accountPolicy.checkTakeover(req.user, targetUser, 'đổi ID Telegram của tài khoản này') ||
                       accountPolicy.checkProtectedManager(req.user, targetUser, 'đổi ID Telegram');
        if (denied) return accountPolicy.sendDenied(res, denied);
      }
      updates.telegramId = telegramId;
    }

    if (req.body.hoTen !== undefined) {
      const hoTen = String(req.body.hoTen || '').trim();
      if (!hoTen) return res.status(400).json({ error: 'Họ tên không được để trống.' });
      updates.hoTen = hoTen;
    }

    // ---- Email / SĐT: chi KIEM TRA o day. Lenh ghi (adminChange ghi ca hr_employees lan
    // app_users) duoc HOAN den sau khi MOI kiem tra cua route da qua — xem pendingAdminChanges. ----
    const nextEmail = req.body.email !== undefined ? String(req.body.email || '').trim().toLowerCase() : null;
    const nextPhone = req.body.soDienThoai !== undefined ? normalizePhone(String(req.body.soDienThoai || '').trim()) : null;
    // So voi gia tri DANG LUU da chuan hoa (DB co the con khoang trang / chu hoa cu).
    const emailChanging = nextEmail !== null && nextEmail !== String(targetUser.email || '').trim().toLowerCase();
    const phoneChanging = nextPhone !== null && nextPhone !== normalizePhone(targetUser.soDienThoai);

    if (nextEmail && (nextEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail))) {
      return res.status(400).json({ error: 'Email không đúng định dạng.' });
    }
    if (nextPhone && !/^(0|\+84)(3|5|7|8|9)[0-9]{8}$/.test(nextPhone) && !/^[0-9]{10}$/.test(nextPhone)) {
      return res.status(400).json({ error: 'Số điện thoại không đúng định dạng.' });
    }
    if (emailChanging) {
      const denied = accountPolicy.checkTakeover(req.user, targetUser, 'đổi email của tài khoản này') ||
                     accountPolicy.checkProtectedManager(req.user, targetUser, 'đổi email');
      if (denied) return accountPolicy.sendDenied(res, denied);
    }
    if (phoneChanging) {
      const denied = accountPolicy.checkTakeover(req.user, targetUser, 'đổi số điện thoại của tài khoản này') ||
                     accountPolicy.checkProtectedManager(req.user, targetUser, 'đổi số điện thoại');
      if (denied) return accountPolicy.sendDenied(res, denied);
    }
    if (emailChanging || phoneChanging) {
      // Luat 5a: dinh danh admin cung — resolver se bien TK thanh admin cung.
      const protectedId = accountPolicy.checkProtectedIdentity(req.user, [
        emailChanging ? nextEmail : '', phoneChanging ? nextPhone : ''
      ]);
      if (protectedId) return accountPolicy.sendDenied(res, protectedId, accountPolicy.PROTECTED_IDENTITY_CODE);
      // Luat 5b: tu doi email/SĐT cua minh phai qua trang Ho so (OTP) hoac Quan ly khac.
      const selfChange = accountPolicy.checkSelfContactChange(req.user, targetUser);
      if (selfChange) return accountPolicy.sendDenied(res, selfChange, accountPolicy.SELF_CONTACT_CHANGE_CODE);
      // Luat 5c: email/SĐT MOI khop nhan su vai tro cao hon quyen actor duoc cap. (Username
      // khong doi qua route nay; dinh danh cu da co san nen khong phai "gan moi".)
      const hrDenied = await checkHrIdentityEscalation(req.user, {
        emails: emailChanging ? [nextEmail] : [],
        phones: phoneChanging ? [nextPhone] : []
      }, targetUser);
      if (hrDenied) return res.status(hrDenied.status).json({ error: hrDenied.error, code: hrDenied.code });
    }

    // TK nhan su: doi email/SĐT qua contactChangeService.adminChange (ghi hr_employees +
    // app_users). CHUA goi o day — chi xep hang, goi ngay truoc localUserStore.updateUser.
    const pendingAdminChanges = [];

    if (nextEmail !== null) {
      if (targetUser.hrManaged && emailChanging) {
        pendingAdminChanges.push({ field: 'email', value: nextEmail });
      } else {
        updates.email = nextEmail;
        // Email moi chua duoc chu TK xac minh: khong de co cu "da xac minh" di theo
        // (resolver dung co nay de gan TK Khach vao dong nhan su).
        if (emailChanging) updates.verifiedEmail = false;
      }
    }

    if (nextPhone !== null) {
      if (targetUser.hrManaged && phoneChanging && nextPhone) {
        pendingAdminChanges.push({ field: 'phone', value: nextPhone });
      } else {
        updates.soDienThoai = nextPhone;
        if (phoneChanging) updates.verifiedPhone = false;
      }
    }

    // Luat 4: doi co so / trang thai cua Quan ly KHAC chi danh cho Quan ly cap cao. Form luon
    // gui lai gia tri hien tai nen chi chan khi gia tri THUC SU doi.
    const currentCoSo = targetUser.coSo ? (normalizeCoSo(targetUser.coSo) || String(targetUser.coSo)) : '';

    if (req.body.coSo !== undefined) {
      const rawCoSo = String(req.body.coSo || '').trim();
      const coSo = rawCoSo ? normalizeCoSo(rawCoSo) : '';
      if (rawCoSo && !coSo) {
        return res.status(400).json({ error: `Cơ sở phụ trách không hợp lệ. Cho phép: ${BRANCH_VALUES.join(', ')}` });
      }
      if (coSo !== currentCoSo) {
        const deniedCoSo = accountPolicy.checkProtectedManager(req.user, targetUser, 'đổi cơ sở phụ trách');
        if (deniedCoSo) return accountPolicy.sendDenied(res, deniedCoSo);
      }
      updates.coSo = coSo;
    }

    if (req.body.vaiTro !== undefined) {
      const vaiTro = String(req.body.vaiTro).trim();
      if (!VALID_ROLES.includes(vaiTro)) {
        return res.status(400).json({ error: `Vai trò không hợp lệ: ${vaiTro}` });
      }
      // Business Rule: Chống tự hạ quyền & chống hạ quyền thangnnv2003@gmail.com / Admin mặc định
      if (isSelf && vaiTro !== ROLES.QUAN_LY) {
        return res.status(400).json({ error: 'Bạn không thể tự hạ quyền Quản lý của chính mình.' });
      }
      if (isTargetThang && vaiTro !== ROLES.QUAN_LY) {
        return res.status(400).json({ error: 'Không ai có quyền hạ quyền tài khoản thangnnv2003@gmail.com.' });
      }
      if (isTargetHardcodedAdmin && vaiTro !== ROLES.QUAN_LY) {
        return res.status(400).json({ error: 'Không thể hạ quyền của tài khoản Quản trị viên hệ thống mặc định.' });
      }
      // Ha vai tro cua Quan ly KHAC chi danh cho Quan ly cap cao (luat 4 cua accountPolicy).
      const denied = (vaiTro !== ROLES.QUAN_LY && accountPolicy.checkProtectedManager(req.user, targetUser, 'hạ vai trò')) ||
                     accountPolicy.checkGrant(req.user, targetUser, { ...targetUser, vaiTro });
      if (denied) return accountPolicy.sendDenied(res, denied);
      // Luat 5c: TK Khach (khong HR) len vai tro noi bo => resolver tin dinh danh KHONG can
      // xac minh, nen dinh danh hien co cung phai qua doi chieu nhan su.
      const promotingFromGuest = !targetUser.hrManaged &&
        (targetUser.vaiTro || ROLES.KHACH) === ROLES.KHACH && vaiTro !== ROLES.KHACH;
      if (promotingFromGuest) {
        // Do MOI dinh danh (email, SĐT VA username) nhu resolver.localUserMatchesEmployee.
        const hrDenied = await checkHrIdentityEscalation(req.user, accountPolicy.hrIdentitiesOf({
          username: targetUser.username,
          email: Object.hasOwn(updates, 'email') ? updates.email : targetUser.email,
          soDienThoai: Object.hasOwn(updates, 'soDienThoai') ? updates.soDienThoai : targetUser.soDienThoai
        }), targetUser);
        if (hrDenied) return res.status(hrDenied.status).json({ error: hrDenied.error, code: hrDenied.code });
      }
      updates.vaiTro = vaiTro;
      // Preserve legacy override metadata without writing the role to HR.
      if (targetUser.hrManaged) {
        updates.vaiTroOverride = vaiTro;
        updates.roleSource = 'override';
      }
    }

    if (req.body.vaiTroOverride !== undefined) {
      if (!targetUser.hrManaged) {
        return res.status(409).json({ error: 'Chỉ tài khoản đồng bộ HR mới có ghi đè vai trò.' });
      }
      const vaiTroOverride = req.body.vaiTroOverride === null ? '' : String(req.body.vaiTroOverride).trim();
      if (vaiTroOverride && !VALID_ROLES.includes(vaiTroOverride)) {
        return res.status(400).json({ error: `Vai trò ghi đè không hợp lệ: ${vaiTroOverride}` });
      }
      if (isSelf && vaiTroOverride && vaiTroOverride !== ROLES.QUAN_LY) {
        return res.status(400).json({ error: 'Bạn không thể tự hạ quyền Quản lý của chính mình.' });
      }
      if (isTargetHardcodedAdmin && vaiTroOverride !== ROLES.QUAN_LY) {
        return res.status(400).json({ error: 'Không thể thay đổi ghi đè của tài khoản Quản trị viên hệ thống.' });
      }
      const resultingRole = vaiTroOverride || targetUser.sheetVaiTro || ROLES.KHACH;
      const denied = (resultingRole !== ROLES.QUAN_LY && accountPolicy.checkProtectedManager(req.user, targetUser, 'hạ vai trò')) ||
                     accountPolicy.checkGrant(req.user, targetUser, { ...targetUser, vaiTro: resultingRole });
      if (denied) return accountPolicy.sendDenied(res, denied);
      updates.vaiTroOverride = vaiTroOverride;
      updates.vaiTro = resultingRole;
      updates.roleSource = vaiTroOverride ? 'override' : 'sheet';
    }

    if (req.body.coSoOverride !== undefined) {
      if (!targetUser.hrManaged) {
        return res.status(409).json({ error: 'Chỉ tài khoản đồng bộ HR mới có ghi đè cơ sở.' });
      }
      const rawOverride = req.body.coSoOverride === null ? '' : String(req.body.coSoOverride).trim();
      const coSoOverride = rawOverride ? normalizeCoSo(rawOverride) : '';
      if (rawOverride && !coSoOverride) {
        return res.status(400).json({ error: `Cơ sở ghi đè không hợp lệ. Cho phép: ${BRANCH_VALUES.join(', ')}` });
      }
      if (isTargetHardcodedAdmin && coSoOverride !== 'Cả hai') {
        return res.status(400).json({ error: 'Không thể thay đổi cơ sở của tài khoản Quản trị viên hệ thống.' });
      }
      const resultingCoSo = coSoOverride || targetUser.sheetCoSo || 'Cả hai';
      if (coSoOverride !== (targetUser.coSoOverride || '') || resultingCoSo !== currentCoSo) {
        const deniedCoSo = accountPolicy.checkProtectedManager(req.user, targetUser, 'đổi cơ sở phụ trách');
        if (deniedCoSo) return accountPolicy.sendDenied(res, deniedCoSo);
      }
      updates.coSoOverride = coSoOverride;
      updates.coSo = resultingCoSo;
    }

    if (req.body.trangThai !== undefined) {
      const trangThai = String(req.body.trangThai).trim();
      if (!VALID_STATUSES.includes(trangThai)) {
        return res.status(400).json({ error: `Trạng thái không hợp lệ: ${trangThai}` });
      }
      // Business Rule: Chống tự khóa & chống khóa thangnnv2003@gmail.com / Admin mặc định
      if (isSelf && (trangThai === LOCKED_STATUS || trangThai === 'Khóa')) {
        return res.status(400).json({ error: 'Bạn không thể tự khóa tài khoản của chính mình.' });
      }
      if (isTargetThang && (trangThai === LOCKED_STATUS || trangThai === 'Khóa')) {
        return res.status(400).json({ error: 'Không ai có quyền khóa tài khoản thangnnv2003@gmail.com.' });
      }
      if (isTargetHardcodedAdmin && (trangThai === LOCKED_STATUS || trangThai === 'Khóa')) {
        return res.status(400).json({ error: 'Không thể khóa tài khoản Quản trị viên hệ thống mặc định.' });
      }
      // Luat 4: MOI thay doi trang thai cua Quan ly khac (khong chi Khoa) — 'Chờ duyệt' cung
      // la ha quyen: lan dang nhap Google sau activatePendingGuest se bien TK thanh Khach.
      if (trangThai !== targetUser.trangThai) {
        const isLock = trangThai === LOCKED_STATUS || trangThai === 'Khóa';
        const deniedStatus = accountPolicy.checkProtectedManager(req.user, targetUser, isLock ? 'khóa tài khoản' : 'đổi trạng thái tài khoản');
        if (deniedStatus) return accountPolicy.sendDenied(res, deniedStatus);
      }
      updates.trangThai = trangThai;
      updates.lockReason = (trangThai === LOCKED_STATUS || trangThai === 'Khóa') ? 'manual' : '';
    }

    const scope = approvalScopeChange(req.user, targetUser, { ...targetUser, ...updates }, req.body);
    if (scope.error) return res.status(scope.status).json({ error: scope.error, code: scope.code });
    updates.leaveApprovalDepartments = scope.departments;
    // Chỉ kiểm tra công tác khi request chạm tới nó (hoặc đổi vai trò qua lại Khách),
    // để tài khoản cũ chưa khai cơ sở/bộ phận vẫn sửa được thông tin khác.
    const nextRole = updates.vaiTro ?? targetUser.vaiTro;
    const touchesAssignment = Object.hasOwn(req.body, 'workCoSo') || Object.hasOwn(req.body, 'boPhan')
      || ((nextRole === ROLES.KHACH) !== (targetUser.vaiTro === ROLES.KHACH));
    const assignment = !touchesAssignment
      ? { workCoSo: targetUser.workCoSo || '', boPhan: targetUser.boPhan || '' }
      : normalizeWorkAssignment({
        vaiTro: nextRole,
        workCoSo: Object.hasOwn(req.body, 'workCoSo') ? req.body.workCoSo : targetUser.workCoSo,
        boPhan: Object.hasOwn(req.body, 'boPhan') ? req.body.boPhan : targetUser.boPhan
      });
    if (req.body.workCoSo !== undefined && req.body.workCoSo !== targetUser.workCoSo && req.body.boPhan === undefined && assignment.boPhan !== (targetUser.boPhan || '')) {
      return res.status(400).json({ error: 'Vui lòng chọn lại bộ phận trực thuộc tại cơ sở công tác.', code: 'DEPARTMENT_BRANCH_MISMATCH' });
    }
    if (assignment.workCoSo !== (targetUser.workCoSo || '') || assignment.boPhan !== (targetUser.boPhan || '')) {
      const denied = accountPolicy.checkProtectedManager(req.user, targetUser, 'đổi cơ sở công tác hoặc bộ phận');
      if (denied) return accountPolicy.sendDenied(res, denied);
    }
    Object.assign(updates, assignment);

    // MOI kiem tra da qua: bay gio moi ghi email/SĐT cua TK nhan su (hr_employees + app_users).
    for (const change of pendingAdminChanges) {
      targetUser = await contactChangeService.adminChange(targetUser, change.field, change.value);
    }

    const updated = await localUserStore.updateUser(targetId, updates);
    if (Object.hasOwn(updates, 'telegramId')) employeeDirectory.clearCache();

    res.status(200).json({ user: publicAdminUser(updated) });
    await accountAuditLog.record({
      action: accountAuditLog.ACTIONS.UPDATE, actor: req.user, target: updated,
      changes: accountAuditLog.diffUser(userBefore, updated)
    });
  } catch (err) {
    if (err && err.code === 'USER_EXISTS') {
      return res.status(409).json({ error: err.message });
    }
    if (err && err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('=== LOI PUT /api/admin/users/:id ===', err);
    res.status(500).json({ error: 'Không cập nhật được tài khoản.' });
  }
});

/**
 * POST /api/admin/users/:id/reset-password — Đặt lại mật khẩu cho user.
 */
router.post('/api/admin/users/:id/reset-password', ...authManage, async (req, res) => {
  try {
    const targetId = req.params.id;
    const targetUser = await localUserStore.getUserById(targetId);
    if (!targetUser) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    }
    // Dat lai mat khau = dang nhap duoc thanh tai khoan dich => coi la chiem quyen.
    const denied = accountPolicy.checkTargetWritable(req.user, targetUser) ||
                   accountPolicy.checkTakeover(req.user, targetUser, 'đặt lại mật khẩu của tài khoản này') ||
                   accountPolicy.checkProtectedManager(req.user, targetUser, 'đặt lại mật khẩu');
    if (denied) return accountPolicy.sendDenied(res, denied);

    const newPassword = String(req.body.newPassword || '');
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });
    }
    if (newPassword.length > 128) {
      return res.status(400).json({ error: 'Mật khẩu mới không được dài quá 128 ký tự.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 10);
    await localUserStore.updateUser(targetId, { passwordHash });

    res.status(200).json({ ok: true, message: 'Đã đặt lại mật khẩu thành công.' });
    await accountAuditLog.record({ action: accountAuditLog.ACTIONS.RESET_PASSWORD, actor: req.user, target: targetUser });
  } catch (err) {
    console.error('=== LOI POST /api/admin/users/:id/reset-password ===', err);
    res.status(500).json({ error: 'Không đặt lại được mật khẩu.' });
  }
});

/**
 * DELETE /api/admin/users/:id — Xóa tài khoản người dùng.
 */
router.delete('/api/admin/users/:id', ...authManage, async (req, res) => {
  try {
    const targetId = req.params.id;
    const targetUser = await localUserStore.getUserById(targetId);
    if (!targetUser) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản để xóa.' });
    }
    const notWritable = accountPolicy.checkTargetWritable(req.user, targetUser);
    if (notWritable) return accountPolicy.sendDenied(res, notWritable);

    const isSelf = String(req.user.id) === String(targetId) ||
                   req.user.username.toLowerCase() === targetUser.username.toLowerCase();
    if (isSelf) {
      return res.status(400).json({ error: 'Bạn không thể tự xóa tài khoản của chính mình.' });
    }

    const isTargetThang = (localUserStore.isProtectedSuperAdmin && (localUserStore.isProtectedSuperAdmin(targetUser.email) || localUserStore.isProtectedSuperAdmin(targetUser.username))) ||
                          (targetUser.email && targetUser.email.toLowerCase() === 'thangnnv2003@gmail.com') ||
                          (targetUser.username && targetUser.username.toLowerCase() === 'thangnnv2003@gmail.com') ||
                          (targetUser.username && targetUser.username.toLowerCase() === 'thangnnv2003');
    if (isTargetThang) {
      return res.status(400).json({ error: 'Không ai có quyền xóa tài khoản thangnnv2003@gmail.com.' });
    }

    const isTargetHardcodedAdmin = localUserStore.isHardcodedAdmin(targetUser.email) ||
                                   localUserStore.isHardcodedAdmin(targetUser.username);
    if (isTargetHardcodedAdmin) {
      return res.status(400).json({ error: 'Không thể xóa tài khoản Quản trị viên hệ thống mặc định.' });
    }
    const deniedDelete = accountPolicy.checkProtectedManager(req.user, targetUser, 'xóa tài khoản');
    if (deniedDelete) return accountPolicy.sendDenied(res, deniedDelete);

    await localUserStore.deleteUser(targetId);
    res.status(200).json({ ok: true, message: 'Đã xóa tài khoản thành công.' });
    await accountAuditLog.record({ action: accountAuditLog.ACTIONS.DELETE, actor: req.user, target: targetUser });
  } catch (err) {
    console.error('=== LOI DELETE /api/admin/users/:id ===', err);
    res.status(500).json({ error: 'Không xóa được tài khoản.' });
  }
});

/**
 * GET /api/admin/audit-log?q=&action=&from=&to=&page=&pageSize= — Lịch sử chỉnh sửa
 * tài khoản (tab /account/#history). Ai xem được tab Quản lý người dùng là xem được.
 */
router.get('/api/admin/audit-log', ...authView, async (req, res) => {
  try {
    const str = v => (typeof v === 'string' ? v : '');
    const result = await accountAuditLog.listEntries({
      q: str(req.query.q), action: str(req.query.action), targetId: str(req.query.targetId),
      from: str(req.query.from), to: str(req.query.to), page: req.query.page, pageSize: req.query.pageSize
    });
    res.status(200).json(result);
  } catch (err) {
    console.error('=== LOI GET /api/admin/audit-log ===', err);
    res.status(500).json({ error: 'Không tải được lịch sử chỉnh sửa.' });
  }
});

// -------------------------------------------------------------
// PHAN QUYEN CHI TIET THEO TUNG TAI KHOAN
// Quyen mac dinh tinh theo vai tro (featureRegistry.js); moi tai khoan co the
// duoc ghi de tung key mot. Cot app_users.feature_permissions chi luu DELTA.
// -------------------------------------------------------------

/**
 * GET /api/admin/permissions/catalog — danh muc tinh nang + mac dinh theo vai
 * tro, de giao dien dung bang phan quyen ma khong chep lai nhan tieng Viet.
 */
router.get('/api/admin/permissions/catalog', ...authView, async (req, res) => {
  const roleDefaults = {};
  for (const role of VALID_ROLES) roleDefaults[role] = featureRegistry.defaultsForRole(role);
  res.status(200).json({
    groups: featureRegistry.FEATURE_GROUPS,
    features: featureRegistry.FEATURES.map(f => ({
      key: f.key,
      label: f.label,
      groupKey: f.groupKey,
      alwaysOn: !!f.alwaysOn,
      dynamic: !!f.dynamic,
      forbiddenRoles: f.forbiddenRoles || [],
      requires: f.requires || null
    })),
    roleDefaults,
    departmentsByBranch: { 'Hà Nội': departmentsFor('hanoi'), 'Sài Gòn': departmentsFor('saigon') },
    suggestedDepartmentByRole: { 'Hà Nội': suggestedDepartmentsByRole('hanoi'), 'Sài Gòn': suggestedDepartmentsByRole('saigon') },
    departments: await departmentCatalog().catch(() => [])
  });
});

/**
 * Chan sua quyen cua Quan tri vien he thong, va chan tu thao go quyen quan tri
 * cua CHINH MINH (khoa chet: khong con ai vao duoc man hinh phan quyen).
 */
const SELF_LOCKOUT_KEYS = ['account.permissions', 'account.users.manage'];

function assertPermissionsEditable(req, targetUser, overrides) {
  const isTargetProtected = localUserStore.isProtectedSuperAdmin(targetUser.email) ||
                            localUserStore.isProtectedSuperAdmin(targetUser.username) ||
                            localUserStore.isHardcodedAdmin(targetUser.email) ||
                            localUserStore.isHardcodedAdmin(targetUser.username);
  if (isTargetProtected) {
    return 'Không thể thay đổi quyền của tài khoản Quản trị viên hệ thống.';
  }
  const isSelf = String(req.user.id) === String(targetUser.id) ||
                 String(req.user.username || '').toLowerCase() === String(targetUser.username || '').toLowerCase();
  if (isSelf && overrides) {
    const blocked = SELF_LOCKOUT_KEYS.filter(key => overrides[key] === false);
    if (blocked.length) {
      return 'Bạn không thể tự thu hồi quyền quản trị của chính mình.';
    }
  }
  return null;
}

function permissionsPayload(user) {
  return {
    userId: user.id,
    username: user.username,
    hoTen: user.hoTen || '',
    vaiTro: user.vaiTro,
    boPhan: user.boPhan || '',
    leaveApprovalDepartments: normalizeDepartments(user.leaveApprovalDepartments || []),
    defaults: featureRegistry.defaultsForRole(user.vaiTro),
    overrides: featureRegistry.sanitizeOverrides(user.featurePermissions),
    effective: featureRegistry.resolvePermissions(user)
  };
}

/**
 * GET /api/admin/users/:id/permissions — quyen mac dinh + ghi de + hieu luc.
 */
router.get('/api/admin/users/:id/permissions', ...authPermissions, async (req, res) => {
  try {
    const targetUser = await localUserStore.getUserById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    }
    res.status(200).json(permissionsPayload(targetUser));
  } catch (err) {
    console.error('=== LOI GET /api/admin/users/:id/permissions ===', err);
    res.status(500).json({ error: 'Không tải được phân quyền của tài khoản.' });
  }
});

/**
 * PUT /api/admin/users/:id/permissions — ghi de THAY THE TOAN BO delta hien co.
 * Body: { overrides: { "<key>": true | false | null } } — null (hoac vang mat)
 * nghia la "quay ve mac dinh theo vai tro".
 */
router.put('/api/admin/users/:id/permissions', ...authPermissions, async (req, res) => {
  try {
    const targetUser = await localUserStore.getUserById(req.params.id);
    if (!targetUser) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    }

    const raw = req.body && req.body.overrides;
    if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      return res.status(400).json({ error: 'Trường "overrides" phải là một object.' });
    }

    const unknown = featureRegistry.unknownOverrideKeys(raw);
    if (unknown.length) {
      return res.status(400).json({
        error: `Quyền không hợp lệ: ${unknown.join(', ')}.`,
        code: 'UNKNOWN_FEATURE',
        validKeys: featureRegistry.FEATURE_KEYS
      });
    }

    const overrides = featureRegistry.sanitizeOverrides(raw);
    const forbiddenGrants = Object.keys(overrides).filter(key => overrides[key] && featureRegistry.isFeatureForbiddenForRole(key, targetUser.vaiTro));
    if (forbiddenGrants.length) {
      return res.status(400).json({ error: 'Không thể cấp quyền ngoài Quy định công ty, Nghỉ phép và Vị trí hàng (xem, xuất Excel) cho tài khoản Khách.', code: 'FEATURE_ROLE_FORBIDDEN' });
    }
    const blockedReason = assertPermissionsEditable(req, targetUser, overrides);
    if (blockedReason) {
      return res.status(400).json({ error: blockedReason });
    }
    // Nguoi khong phai Quan ly khong duoc tu cap / cap them quyen chinh ho khong co.
    // Quan ly thuong khong duoc RUT bot quyen cua Quan ly khac (them quyen thi duoc).
    const resolvedBefore = featureRegistry.resolvePermissions(targetUser);
    const resolvedAfter = featureRegistry.resolvePermissions({ ...targetUser, featurePermissions: overrides });
    const revokesPermission = resolvedBefore.some(key => !resolvedAfter.includes(key));
    const denied = accountPolicy.checkTargetWritable(req.user, targetUser) ||
                   accountPolicy.checkGrant(req.user, targetUser, { ...targetUser, featurePermissions: overrides }) ||
                   (revokesPermission && accountPolicy.checkProtectedManager(req.user, targetUser, 'rút quyền'));
    if (denied) return accountPolicy.sendDenied(res, denied);

    const scope = approvalScopeChange(req.user, targetUser, { ...targetUser, featurePermissions: overrides }, req.body);
    if (scope.error) return res.status(scope.status).json({ error: scope.error, code: scope.code });
    const updated = await localUserStore.updateUser(targetUser.id, { featurePermissions: overrides, leaveApprovalDepartments: scope.departments });
    res.status(200).json(permissionsPayload(updated));
    await accountAuditLog.record({
      action: accountAuditLog.ACTIONS.PERMISSIONS, actor: req.user, target: updated,
      changes: accountAuditLog.diffPermissions(targetUser, updated)
    });

    // Bao cho chinh chu tai khoan biet quyen vua doi — best-effort, KHONG duoc
    // lam hong response da tra o tren.
    try {
      await notificationRepo.createNotificationForUsers([targetUser.id], {
        type: 'permissions_changed',
        title: 'Quyền truy cập đã được cập nhật',
        message: `${req.user.hoTen || req.user.username} vừa điều chỉnh quyền truy cập tài khoản của bạn. Tải lại trang để áp dụng.`,
        relatedType: 'permissionsChanged',
        relatedId: targetUser.id
      });
    } catch (notifyErr) {
      console.error('Lỗi báo thông báo đổi quyền:', notifyErr.message);
    }
  } catch (err) {
    console.error('=== LOI PUT /api/admin/users/:id/permissions ===', err);
    res.status(500).json({ error: 'Không lưu được phân quyền.' });
  }
});

module.exports = router;
