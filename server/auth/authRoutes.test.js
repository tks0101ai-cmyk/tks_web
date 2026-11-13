'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
process.env.GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || 'test-client-id.apps.googleusercontent.com';
// Mac dinh server KHOA tu dang ky (config.ALLOW_SELF_REGISTRATION). Cac test cu kiem tra luong dang ky
// nen mo san; nhom test "dang ky bi khoa" o cuoi file dat lai 'false' tung test.
process.env.ALLOW_SELF_REGISTRATION = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AUTH_COOKIE_NAME } = require('./authMiddleware');
const { comparePassword } = require('./authService');
const localUserStore = require('./localUserStore');
const { createFakeAppUsersRepository } = require('./testHelpers/fakeAppUsersRepository');

// authRoutes.js co the goi mot vai ham userRepository khong
// nam trong seam mock cua freshAuthRoutes() ben duoi — cac ham nay roi xuong
// localUserStore that, nen can 1 repository gia (khong can SUPABASE_DB_URL)
// de khong bi loi ket noi CSDL trong test. Repository gia rong la du vi cac
// test nay khong dua vao du lieu user co san.
localUserStore.initStore(null, { repository: createFakeAppUsersRepository() });

function fakeRes() {
  const res = { statusCode: null, body: null, cookies: [] };
  res.status = code => { res.statusCode = code; return res; };
  res.json = payload => { res.body = payload; return res; };
  res.cookie = (name, value, options) => { res.cookies.push({ name, value, options }); return res; };
  res.cleared = [];
  res.clearCookie = (name, options) => { res.cleared.push({ name, options }); return res; };
  return res;
}

function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`Không tìm thấy route: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

/**
 * Chay TOAN BO middleware stack cua 1 route (vd forgotPasswordRateLimit ->
 * handler chinh), khac voi getRouteHandler chi lay handler cuoi cung. Can
 * dung cho cac route co gan middleware (rate limit) truoc handler chinh.
 */
function getRouteStack(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error(`Không tìm thấy route: ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.map(l => l.handle);
}

async function callRoute(router, method, routePath, req, res) {
  const stack = getRouteStack(router, method, routePath);
  for (const handle of stack) {
    let calledNext = false;
    await handle(req, res, () => { calledNext = true; });
    if (!calledNext) break;
  }
}

/**
 * Require lai authRoutes.js VOI cac dependency da mock san. authRoutes.js
 * destructure ham ngay luc require (const { x } = require(...)), nen phai
 * ghi de tren MODULE dependency truoc, roi moi require authRoutes.js fresh
 * de no "chup" dung ham da mock (khong the mock sau khi da require).
 */
function freshAuthRoutes({
  verifyGoogleIdToken,
  findUserByEmail,
  findUserById = async () => null,
  findUserByUsername = async () => null,
  findActiveUserByUsername = async () => null,
  findUserByIdentifier = async () => null,
  createActiveGuest,
  activatePendingGuest = async () => {},
  updateUserFields = async (id, fields) => ({ id, ...fields, trangThai: 'Đang hoạt động' }),
  updateUserProfile = updateUserFields,
  employeeRegistration,
  contactChange,
  resolveEffectiveUser = async user => user
}) {
  ['./authRoutes', './googleAuthService', './userRepository', './userWriteRepository', './otpService', './employeeRegistrationService', './contactChangeService', './effectiveUserResolver', '../config']
    .forEach(id => { delete require.cache[require.resolve(id)]; });

  const googleAuthService = require('./googleAuthService');
  googleAuthService.verifyGoogleIdToken = verifyGoogleIdToken;

  const userRepository = require('./userRepository');
  userRepository.findUserByEmail = findUserByEmail;
  userRepository.findUserById = findUserById;
  userRepository.findUserByUsername = findUserByUsername;
  userRepository.findActiveUserByUsername = findActiveUserByUsername;
  userRepository.findUserByIdentifier = findUserByIdentifier;

  const userWriteRepository = require('./userWriteRepository');
  userWriteRepository.createActiveGuest = createActiveGuest;
  userWriteRepository.activatePendingGuest = activatePendingGuest;
  userWriteRepository.updateUserFields = updateUserFields;
  userWriteRepository.updateUserProfile = updateUserProfile;

  const employeeRegistrationService = require('./employeeRegistrationService');
  employeeRegistrationService.linkVerifiedGoogleIdentity = employeeRegistration && employeeRegistration.linkVerifiedGoogleIdentity
    ? employeeRegistration.linkVerifiedGoogleIdentity
    : async () => null;

  const effectiveUserResolver = require('./effectiveUserResolver');
  effectiveUserResolver.resolveUser = resolveEffectiveUser;

  const contactChangeService = require('./contactChangeService');
  if (contactChange) {
    contactChangeService.beginChange = contactChange.beginChange;
    contactChangeService.confirmChange = contactChange.confirmChange;
  }

  const emailSender = require('../notifications/emailSender');
  emailSender.isConfigured = () => false;

  return require('./authRoutes');
}

const NEVER_CALL = async () => { throw new Error('khong nen goi ham nay'); };

test('profile exposes the Telegram ID read from the database', async () => {
  const router = freshAuthRoutes({ findUserById: async () => ({ id: 'u1', telegramId: '9007199254740993' }) });
  const res = fakeRes();
  await getRouteHandler(router, 'get', '/api/auth/profile')({ user: { id: 'u1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.telegramId, '9007199254740993');
});

test('profile saves a normalized Telegram ID only to the authenticated account (Quan ly)', async () => {
  const calls = [];
  const current = { id: 'u1', hoTen: 'A', email: 'a@example.com', vaiTro: 'Quản lý', telegramId: '123' };
  const router = freshAuthRoutes({ findUserById: async () => current,
    updateUserProfile: async (id, fields) => { calls.push({ id, fields }); return { ...current, ...fields }; } });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/profile')({ user: { id: 'u1' }, body: {
    id: 'someone-else', hoTen: 'A', email: 'a@example.com', telegramId: ' 9007199254740993 ' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.telegramId, '9007199254740993');
  assert.deepEqual(calls, [{ id: 'u1', fields: { hoTen: 'A', telegramId: '9007199254740993' } }]);
});

test('profile rejects malformed Telegram IDs before any writes', async () => {
  let writes = 0;
  const router = freshAuthRoutes({ findUserById: async () => ({ id: 'u1', email: 'a@example.com' }),
    updateUserFields: async () => { writes++; }, updateUserProfile: async () => { writes++; } });
  for (const telegramId of ['@username', '-123', '0', '1.5', '1e10', '123 456', '1'.repeat(21), 123, {}, null]) {
    const res = fakeRes();
    await getRouteHandler(router, 'post', '/api/auth/profile')({ user: { id: 'u1' }, body: { hoTen: 'A', email: 'a@example.com', telegramId } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(telegramId));
  }
  assert.equal(writes, 0);
});

test('profile allows a manager to clear the Telegram ID and preserves it when omitted', async () => {
  const calls = [];
  const current = { id: 'u1', email: 'a@example.com', vaiTro: 'Quản lý', telegramId: '123' };
  const router = freshAuthRoutes({ findUserById: async () => current,
    updateUserProfile: async (id, fields) => { calls.push(fields); return { ...current, ...fields }; } });
  for (const extra of [{ telegramId: '' }, {}]) {
    const res = fakeRes();
    await getRouteHandler(router, 'post', '/api/auth/profile')({ user: { id: 'u1' }, body: { hoTen: 'A', email: 'a@example.com', ...extra } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.telegramId, extra.telegramId === '' ? '' : '123');
  }
  assert.deepEqual(calls, [{ hoTen: 'A', telegramId: '' }, { hoTen: 'A' }]);
});

test('profile: nhan vien KHONG tu them/sua/xoa duoc ID Telegram (403), gui lai gia tri cu thi bo qua', async () => {
  for (const current of [
    { id: 'u1', hoTen: 'A', email: 'a@example.com', vaiTro: 'Nhân viên sale', telegramId: '123' },
    { id: 'u1', hoTen: 'A', email: 'a@example.com', vaiTro: 'Nhân viên sale', telegramId: '' }
  ]) {
    const calls = [];
    const router = freshAuthRoutes({ findUserById: async () => current,
      updateUserProfile: async (id, fields) => { calls.push(fields); return { ...current, ...fields }; } });
    const handler = getRouteHandler(router, 'post', '/api/auth/profile');
    for (const telegramId of ['999', current.telegramId ? '' : '456']) {
      const res = fakeRes();
      await handler({ user: { id: 'u1' }, body: { hoTen: 'A', email: 'a@example.com', telegramId } }, res);
      assert.equal(res.statusCode, 403, `${current.telegramId}->${telegramId}`);
      assert.equal(res.body.code, 'TELEGRAM_ID_LOCKED');
    }
    assert.deepEqual(calls, [], 'bi chan thi khong ghi gi ca (ke ca ho ten / email)');

    const same = fakeRes();
    await handler({ user: { id: 'u1' }, body: { hoTen: 'A', email: 'a@example.com', telegramId: current.telegramId } }, same);
    assert.equal(same.statusCode, 200);
    const omitted = fakeRes();
    await handler({ user: { id: 'u1' }, body: { hoTen: 'A', email: 'a@example.com' } }, omitted);
    assert.equal(omitted.statusCode, 200);
    assert.deepEqual(calls, [{ hoTen: 'A' }, { hoTen: 'A' }],
      'ID Telegram khong bao gio nam trong lenh ghi cua nhan vien');
  }
});

test('profile: admin cung duoc sua ID Telegram o ho so cua minh; GET /profile bao telegramEditable', async () => {
  const admin = { id: 'u1', hoTen: 'A', email: 'thangnnv2003@gmail.com', username: 'thangnnv2003@gmail.com', vaiTro: 'Nhân viên kho', telegramId: '' };
  const calls = [];
  const router = freshAuthRoutes({ findUserById: async () => admin,
    updateUserProfile: async (id, fields) => { calls.push(fields); return { ...admin, ...fields }; } });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/profile')({ user: { id: 'u1' }, body: { hoTen: 'A', email: admin.email, telegramId: '777' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(calls[0].telegramId, '777');

  for (const [vaiTro, expected] of [['Quản lý', true], ['Nhân viên sale', false], ['Kế toán', false]]) {
    const r = freshAuthRoutes({ findUserById: async () => ({ id: 'u2', email: 'x@example.com', vaiTro }) });
    const out = fakeRes();
    await getRouteHandler(r, 'get', '/api/auth/profile')({ user: { id: 'u2' } }, out);
    assert.equal(out.body.telegramEditable, expected, vaiTro);
  }
});

test('profile returns a Telegram conflict as a useful 409 response', async () => {
  const router = freshAuthRoutes({ findUserById: async () => ({ id: 'u1', email: 'a@example.com', vaiTro: 'Quản lý' }),
    updateUserProfile: async () => { throw Object.assign(new Error('ID Telegram này đã được sử dụng.'), { statusCode: 409, code: 'TELEGRAM_ID_EXISTS' }); } });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/profile')({ user: { id: 'u1' }, body: { hoTen: 'A', email: 'a@example.com', telegramId: '123' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'TELEGRAM_ID_EXISTS');
});

test('profile: TK nhan su (hrManaged) KHONG tu doi email duoc (403), DB khong doi', async () => {
  const current = { id: 'u1', hoTen: 'A', email: 'a@example.com', vaiTro: 'Nhân viên sale', hrManaged: true };
  const calls = [];
  const router = freshAuthRoutes({ findUserById: async () => current, findUserByEmail: NEVER_CALL,
    updateUserFields: async (id, fields) => { calls.push(fields); return { ...current, ...fields }; },
    updateUserProfile: async (id, fields) => { calls.push(fields); return { ...current, ...fields }; } });
  for (const email of ['boss@example.com', 'manager@tokosi.vn', 'not-an-email']) {
    const res = fakeRes();
    await getRouteHandler(router, 'post', '/api/auth/profile')({ user: { id: 'u1' }, body: { hoTen: 'A', email } }, res);
    assert.equal(res.statusCode, 403, email);
    assert.equal(res.body.code, 'EMAIL_CHANGE_LOCKED');
    assert.equal(res.body.error, 'Email của tài khoản nhân sự chỉ Quản lý được đổi. Vui lòng liên hệ Quản lý.');
    assert.equal(res.cookies.length, 0, 'bi chan thi khong cap lai phien');
  }
  assert.deepEqual(calls, [], 'khong ghi gi xuong DB');
  assert.equal(current.email, 'a@example.com');
});

test('profile: TK thuong doi email phai qua OTP (409 EMAIL_CHANGE_REQUIRES_OTP), khong ghi DB', async () => {
  const current = { id: 'u1', hoTen: 'A', email: 'a@example.com', vaiTro: 'Khách hàng', hrManaged: false };
  const calls = [];
  const router = freshAuthRoutes({ findUserById: async () => current, findUserByEmail: NEVER_CALL,
    updateUserProfile: async (id, fields) => { calls.push(fields); return { ...current, ...fields }; } });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/profile')({ user: { id: 'u1' }, body: { hoTen: 'A', email: 'b@example.com' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'EMAIL_CHANGE_REQUIRES_OTP');
  assert.equal(res.body.error, 'Đổi email cần xác minh mã OTP gửi tới email mới.');
  assert.deepEqual(calls, []);
});

test('profile: doi ho ten giu email (khac hoa/khoang trang) hoac khong gui email -> 200, email khong nam trong lenh ghi', async () => {
  for (const hrManaged of [true, false]) {
    const current = { id: 'u1', hoTen: 'A', email: 'a@example.com', vaiTro: 'Nhân viên sale', hrManaged };
    const calls = [];
    const router = freshAuthRoutes({ findUserById: async () => current, findUserByEmail: NEVER_CALL,
      updateUserProfile: async (id, fields) => { calls.push(fields); return { ...current, ...fields }; } });
    const handler = getRouteHandler(router, 'post', '/api/auth/profile');
    for (const extra of [{ email: ' A@Example.com ' }, {}, { email: '' }]) {
      const res = fakeRes();
      await handler({ user: { id: 'u1' }, body: { hoTen: 'Tên mới', ...extra } }, res);
      assert.equal(res.statusCode, 200, `${hrManaged} ${JSON.stringify(extra)}`);
      assert.equal(res.body.email, 'a@example.com');
      assert.equal(res.body.hoTen, 'Tên mới');
    }
    assert.deepEqual(calls, [{ hoTen: 'Tên mới' }, { hoTen: 'Tên mới' }, { hoTen: 'Tên mới' }]);
  }
});

test('recovery: gui soDienThoai (rong hoac so khac) -> 400 PHONE_CHANGE_NOT_ALLOWED, SDT trong DB khong doi', async () => {
  const current = { id: 'u1', email: 'a@example.com', soDienThoai: '0912345678', passwordHash: '' };
  const calls = [];
  const router = freshAuthRoutes({ findUserById: async () => current,
    updateUserFields: async (id, fields) => { calls.push(fields); return { ...current, ...fields }; } });
  for (const soDienThoai of ['', '0987654321', null, '0912345678']) {
    const res = fakeRes();
    await getRouteHandler(router, 'post', '/api/auth/recovery')({ user: { id: 'u1' }, body: { soDienThoai, emailKhoiPhuc: 'r@example.com' } }, res);
    assert.equal(res.statusCode, 400, JSON.stringify(soDienThoai));
    assert.equal(res.body.code, 'PHONE_CHANGE_NOT_ALLOWED');
    assert.equal(res.body.error, 'Không thể đổi số điện thoại tại đây. Vui lòng liên hệ Quản lý.');
  }
  assert.deepEqual(calls, []);
  assert.equal(current.soDienThoai, '0912345678');
});

test('recovery: doi email khoi phuc van 200 va khong dong toi SDT chinh', async () => {
  const { hashPassword } = require('./authService');
  const current = { id: 'u1', email: 'a@example.com', soDienThoai: '0912345678', passwordHash: await hashPassword('Secret123!') };
  const calls = [];
  const router = freshAuthRoutes({ findUserById: async () => current,
    updateUserFields: async (id, fields) => { calls.push(fields); return { ...current, ...fields }; } });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/recovery')({ user: { id: 'u1' }, body: { matKhauXacNhan: 'Secret123!', emailKhoiPhuc: ' R@Example.com ' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.profile.emailKhoiPhuc, 'r@example.com');
  assert.equal(res.body.profile.soDienThoai, '0912345678');
  assert.deepEqual(calls, [{ emailKhoiPhuc: 'r@example.com' }]);
});

test('luong dang ky nhan su bang OTP da go: /register/{channels,send-otp,verify} khong con route (404), /register van con', () => {
  const router = freshAuthRoutes({ verifyGoogleIdToken: NEVER_CALL, findUserByEmail: NEVER_CALL, createActiveGuest: NEVER_CALL });
  const paths = router.stack.filter(l => l.route).map(l => l.route.path);
  for (const removed of ['/api/auth/register/channels', '/api/auth/register/send-otp', '/api/auth/register/verify']) {
    assert.equal(paths.includes(removed), false, removed);
  }
  assert.ok(getRouteHandler(router, 'post', '/api/auth/register'));
});

test('logout: xoa ca cookie dang nhap tks_auth va cookie co so tks_branch', () => {
  const router = freshAuthRoutes({ verifyGoogleIdToken: NEVER_CALL, findUserByEmail: NEVER_CALL, createActiveGuest: NEVER_CALL });
  const res = fakeRes();
  getRouteHandler(router, 'post', '/api/auth/logout')({}, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.cleared.map(c => c.name).sort(), ['tks_auth', 'tks_branch']);
  for (const c of res.cleared) assert.deepEqual(c.options, { path: '/' });
});

test('password login returns the live role resolved from HR instead of the stored role', async () => {
  const passwordHash = await require('./authService').hashPassword('Password123');
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findActiveUserByUsername: async () => ({
      id: 'u1', username: 'a@example.com', email: 'a@example.com', passwordHash,
      vaiTro: 'Khách', coSo: '', trangThai: 'Đang hoạt động'
    }),
    resolveEffectiveUser: async user => ({ ...user, vaiTro: 'Kế toán', coSo: 'Hà Nội' })
  });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/login')({ body: { username: 'a@example.com', password: 'Password123' }, cookies: { tks_branch: 'Sài Gòn' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.vaiTro, 'Kế toán');
  assert.equal(res.body.coSo, 'Hà Nội');
  assert.equal(res.cookies.find(cookie => cookie.name === 'tks_branch').value, 'Cả hai');
});

test('password login can reactivate an HR-removed account after it reappears in the sheet', async () => {
  const passwordHash = await require('./authService').hashPassword('Password123');
  const locked = {
    id: 'u1', username: 'a@example.com', email: 'a@example.com', passwordHash,
    vaiTro: 'Kế toán', coSo: 'Cả hai', trangThai: 'Khóa', lockReason: 'hr_removed', hrManaged: true
  };
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findActiveUserByUsername: async () => null,
    findUserByIdentifier: async () => locked,
    resolveEffectiveUser: async user => ({ ...user, trangThai: 'Đang hoạt động', lockReason: '' })
  });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/login')({ body: { username: 'a@example.com', password: 'Password123' } }, res);
  assert.equal(res.statusCode, 200);
});

test('Google login uses the HR multi-identifier linker before creating a guest', async () => {
  let createGuestCalled = false;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'a@example.com', emailVerified: true, name: 'A' }),
    findUserByEmail: async () => null,
    createActiveGuest: async () => { createGuestCalled = true; },
    employeeRegistration: {
      linkVerifiedGoogleIdentity: async () => ({
        id: 'u1', username: '0912345678', email: 'a@example.com', soDienThoai: '0912345678',
        hoTen: 'A', vaiTro: 'Kế toán', coSo: 'Cả hai', trangThai: 'Đang hoạt động'
      })
    }
  });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/google')({ body: { credential: 'token' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.vaiTro, 'Kế toán');
  assert.equal(createGuestCalled, false);
});

test('TK thuong doi email qua contact-change: gui OTP roi xac nhan', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    contactChange: {
      beginChange: async (user, field, value) => ({ challengeId: 'cc1', userId: user.id, field, value }),
      confirmChange: async user => ({ ...user, email: 'new@example.com', verifiedEmail: true })
    }
  });
  let res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/profile/contact-change')({
    user: { id: 'u1', hrManaged: false }, body: { field: 'email', value: 'new@example.com' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.challengeId, 'cc1');

  res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/profile/contact-change/verify')({
    user: { id: 'u1', hrManaged: false }, body: { challengeId: 'cc1', otp: '123456' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.email, 'new@example.com');
});

test('TK nhan su goi contact-change -> 403 EMAIL_CHANGE_LOCKED tu service', async () => {
  const { ContactChangeError } = require('./contactChangeService');
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    contactChange: {
      beginChange: async () => { throw new ContactChangeError('Email của tài khoản nhân sự chỉ Quản lý được đổi. Vui lòng liên hệ Quản lý.', 'EMAIL_CHANGE_LOCKED', 403); },
      confirmChange: NEVER_CALL
    }
  });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/profile/contact-change')({
    user: { id: 'u1', hrManaged: true }, body: { field: 'email', value: 'boss@example.com' }
  }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'EMAIL_CHANGE_LOCKED');
});

test('POST /api/auth/google: linkVerifiedGoogleIdentity nem loi 4xx (HR_IDENTITY_CONFLICT) -> tra dung status/code, khong 500, khong dang nhap', async () => {
  const conflict = Object.assign(new Error('Nhân sự này đang khớp với một tài khoản web khác.'), {
    code: 'HR_IDENTITY_CONFLICT', statusCode: 409
  });
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'staff@example.com', emailVerified: true, name: 'Staff' }),
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    employeeRegistration: { linkVerifiedGoogleIdentity: async () => { throw conflict; } }
  });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/google')({ body: { credential: 'token' } }, res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'HR_IDENTITY_CONFLICT');
  assert.equal(res.body.error, conflict.message);
  assert.equal(res.cookies.length, 0);
});

// Chay stack cua route nhung bo requireAuth (test gan san req.user).
async function callRouteAsUser(router, method, routePath, req, res) {
  const { requireAuth } = require('./authMiddleware');
  const stack = getRouteStack(router, method, routePath).filter(handle => handle !== requireAuth);
  for (const handle of stack) {
    let calledNext = false;
    await handle(req, res, () => { calledNext = true; });
    if (!calledNext) break;
  }
}

test('contact-change + verify co rate limit theo user (dung chung 2 route), user/IP khac khong bi anh huong', async () => {
  let beginCalls = 0;
  let confirmCalls = 0;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    contactChange: {
      beginChange: async () => { beginCalls++; return { challengeId: 'cc1' }; },
      confirmChange: async user => { confirmCalls++; return { ...user, email: 'new@example.com' }; }
    }
  });
  let limited = null;
  for (let i = 0; i < 60 && !limited; i++) {
    const path = i % 2 ? '/api/auth/profile/contact-change/verify' : '/api/auth/profile/contact-change';
    const res = fakeRes();
    await callRouteAsUser(router, 'post', path, {
      user: { id: 'spammer' }, ip: '10.0.0.1', body: { field: 'email', value: 'x@example.com', challengeId: 'cc1', otp: '000000' }
    }, res);
    if (res.statusCode === 429) limited = res;
  }
  assert.ok(limited, 'phai bi chan 429');
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.ok(limited.body.waitSeconds > 0);
  assert.ok(beginCalls + confirmCalls < 60);

  const before = beginCalls;
  const res = fakeRes();
  await callRouteAsUser(router, 'post', '/api/auth/profile/contact-change', {
    user: { id: 'someone-else' }, ip: '10.0.0.2', body: { field: 'email', value: 'y@example.com' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(beginCalls, before + 1);
});

test('contact-change: rate limit theo IP chan nhieu user tu cung 1 nguon', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    contactChange: {
      beginChange: async () => ({ challengeId: 'cc1' }),
      confirmChange: NEVER_CALL
    }
  });
  let limited = false;
  for (let i = 0; i < 100 && !limited; i++) {
    const res = fakeRes();
    await callRouteAsUser(router, 'post', '/api/auth/profile/contact-change', {
      user: { id: `u${i % 50}` }, ip: '10.9.9.9', body: { field: 'email', value: 'z@example.com' }
    }, res);
    if (res.statusCode === 429) limited = true;
  }
  assert.equal(limited, true);
});

test('POST /api/auth/register: thieu du lieu, email sai hoac mat khau ngan -> 400', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/register');
  for (const body of [
    {},
    { hoTen: 'A', email: 'email-sai', password: '12345678' },
    { hoTen: 'A', email: 'a@example.com', password: '1234567' }
  ]) {
    const res = fakeRes();
    await handler({ body }, res);
    assert.equal(res.statusCode, 400);
  }
});

test('POST /api/auth/register: email da ton tai -> 409, khong ghi user', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: async () => ({ id: 'old' }),
    createActiveGuest: NEVER_CALL
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/register');
  const res = fakeRes();
  await handler({ body: { hoTen: 'A', email: 'a@example.com', password: '12345678' } }, res);
  assert.equal(res.statusCode, 409);
});

test('POST /api/auth/register: tao Khach, bam mat khau va set cookie', async () => {
  let createdWith = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: async () => null,
    findUserByUsername: async () => null,
    createActiveGuest: async args => { createdWith = args; }
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/register');
  const res = fakeRes();
  await handler({ body: { hoTen: ' Khách A ', email: ' KHACH@Example.com ', password: 'MatKhau123' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.username, 'khach@example.com');
  assert.equal(res.body.vaiTro, 'Khách');
  assert.equal(createdWith.email, 'khach@example.com');
  assert.notEqual(createdWith.passwordHash, 'MatKhau123');
  assert.equal(await comparePassword('MatKhau123', createdWith.passwordHash), true);
  assert.equal(res.cookies[0].name, AUTH_COOKIE_NAME);
});

test('POST /api/auth/google: thieu credential -> 400', async () => {
  const router = freshAuthRoutes({ verifyGoogleIdToken: NEVER_CALL, findUserByEmail: NEVER_CALL, createActiveGuest: NEVER_CALL });
  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: {} }, res);
  assert.equal(res.statusCode, 400);
});

test('POST /api/auth/google: GOOGLE_CLIENT_ID chua cau hinh -> 500, khong goi Google', async () => {
  const original = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = '';
  try {
    const router = freshAuthRoutes({ verifyGoogleIdToken: NEVER_CALL, findUserByEmail: NEVER_CALL, createActiveGuest: NEVER_CALL });
    const handler = getRouteHandler(router, 'post', '/api/auth/google');
    const res = fakeRes();
    await handler({ body: { credential: 'tok' } }, res);
    assert.equal(res.statusCode, 500);
  } finally {
    process.env.GOOGLE_CLIENT_ID = original;
  }
});

test('POST /api/auth/google: token khong xac thuc duoc -> 401', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => { throw new Error('invalid_token'); },
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'bad-token' } }, res);
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/google: email Google chua xac minh -> 401', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'a@gmail.com', emailVerified: false, name: 'A' }),
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 401);
});

test('POST /api/auth/google: email chua co -> tao Khach hoat dong va dang nhap ngay', async () => {
  let createdWith = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'nguoimoi@gmail.com', emailVerified: true, name: 'Người Mới' }),
    findUserByEmail: async () => null,
    createActiveGuest: async args => { createdWith = args; }
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.vaiTro, 'Khách');
  assert.equal(createdWith.email, 'nguoimoi@gmail.com');
  assert.equal(createdWith.hoTen, 'Người Mới');
  assert.equal(res.cookies.length, 2);
  assert.equal(res.cookies.find(cookie => cookie.name === 'tks_branch').value, 'Cả hai');
});

test('POST /api/auth/google: tai khoan dang "Chờ duyệt" -> kich hoat thanh Khach', async () => {
  let createCalled = false;
  let activatedWith = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'cho@gmail.com', emailVerified: true, name: 'Chờ' }),
    findUserByEmail: async () => ({ id: '1', username: 'cho@gmail.com', hoTen: 'Chờ', vaiTro: 'Trợ lý', coSo: '', trangThai: 'Chờ duyệt' }),
    createActiveGuest: async () => { createCalled = true; },
    activatePendingGuest: async args => { activatedWith = args; }
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.vaiTro, 'Khách');
  assert.equal(createCalled, false);
  assert.deepEqual(activatedWith, { email: 'cho@gmail.com', hoTen: 'Chờ' });
});

test('POST /api/auth/google: tai khoan bi khoa -> 403, khong co pending flag', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'khoa@gmail.com', emailVerified: true, name: 'Khóa' }),
    findUserByEmail: async () => ({ id: '1', username: 'khoa@gmail.com', hoTen: 'Khóa', vaiTro: 'Trợ lý', coSo: '', trangThai: 'Khóa' }),
    createActiveGuest: NEVER_CALL
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.pending, undefined);
});

test('POST /api/auth/google: tai khoan dang hoat dong -> 200, set cookie tks_auth, tra ve user (khong lo passwordHash)', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'quanly@gmail.com', emailVerified: true, name: 'Quản Lý A' }),
    findUserByEmail: async () => ({
      id: '1', username: 'quanly@gmail.com', hoTen: 'Quản Lý A', vaiTro: 'Quản lý', coSo: 'Sài Gòn',
      trangThai: 'Đang hoạt động', passwordHash: 'khong-duoc-lo-ra'
    }),
    createActiveGuest: NEVER_CALL
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'tok' }, cookies: { tks_branch: 'Hà Nội' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.username, 'quanly@gmail.com');
  assert.equal(res.body.vaiTro, 'Quản lý');
  assert.equal(res.body.passwordHash, undefined);
  assert.equal(res.cookies.length, 2);
  assert.equal(res.cookies.find(cookie => cookie.name === 'tks_branch').value, 'Cả hai');
  assert.equal(res.cookies[0].name, AUTH_COOKIE_NAME);
});

test('GET /api/auth/google-config: tra ve clientId da cau hinh', () => {
  const router = freshAuthRoutes({ verifyGoogleIdToken: NEVER_CALL, findUserByEmail: NEVER_CALL, createActiveGuest: NEVER_CALL });
  const handler = getRouteHandler(router, 'get', '/api/auth/google-config');
  const res = fakeRes();
  handler({}, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.clientId, process.env.GOOGLE_CLIENT_ID);
});

test('GET /api/auth/google-config: chua cau hinh -> clientId null (de trang login an nut)', () => {
  const original = process.env.GOOGLE_CLIENT_ID;
  process.env.GOOGLE_CLIENT_ID = '';
  try {
    const router = freshAuthRoutes({ verifyGoogleIdToken: NEVER_CALL, findUserByEmail: NEVER_CALL, createActiveGuest: NEVER_CALL });
    const handler = getRouteHandler(router, 'get', '/api/auth/google-config');
    const res = fakeRes();
    handler({}, res);
    assert.equal(res.body.clientId, null);
  } finally {
    process.env.GOOGLE_CLIENT_ID = original;
  }
});

test('POST /api/auth/register: tu choi dang ky chi bang so dien thoai', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    findUserByUsername: NEVER_CALL,
    createActiveGuest: NEVER_CALL
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/register');
  const res = fakeRes();
  await handler({ body: { hoTen: 'Khách Phone', soDienThoai: '0912345678', password: 'Password123' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /email/i);
  assert.equal(res.cookies.length, 0);
});

test('GET /api/auth/me exposes selectable branches and keeps an authorized Ca hai cookie', async () => {
  const dualBranchUser = {
    id: 'u1', username: 'a@example.com', hoTen: 'A', email: 'a@example.com',
    vaiTro: 'Kế toán', coSo: 'Cả hai', trangThai: 'Đang hoạt động'
  };
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findUserById: async () => dualBranchUser
  });
  const res = fakeRes();
  await getRouteHandler(router, 'get', '/api/auth/me')({
    user: dualBranchUser,
    cookies: { tks_branch: 'Cả hai' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.branches, ['Hà Nội', 'Sài Gòn', 'Cả hai']);
  assert.equal(res.body.branch, 'Cả hai');
  assert.equal(res.body.isSeniorAdmin, false, 'tai khoan thuong khong phai Quan ly cap cao');
});

test('GET /api/auth/me bao isSeniorAdmin: true voi admin cung, false voi Quan ly thuong', async () => {
  const asRoute = async user => {
    const router = freshAuthRoutes({
      verifyGoogleIdToken: NEVER_CALL,
      findUserByEmail: NEVER_CALL,
      createActiveGuest: NEVER_CALL,
      findUserById: async () => user
    });
    const res = fakeRes();
    await getRouteHandler(router, 'get', '/api/auth/me')({ user, cookies: {} }, res);
    return res.body;
  };
  const ordinaryManager = { id: 'm1', username: 'ql1', hoTen: 'QL', email: 'ql1@example.com', vaiTro: 'Quản lý', coSo: 'Cả hai', trangThai: 'Đang hoạt động' };
  const seniorAdmin = { id: 'a1', username: 'admin', hoTen: 'Admin', email: 'admin@tokosi.vn', vaiTro: 'Quản lý', coSo: 'Cả hai', trangThai: 'Đang hoạt động' };
  assert.equal((await asRoute(ordinaryManager)).isSeniorAdmin, false);
  assert.equal((await asRoute(seniorAdmin)).isSeniorAdmin, true);
});

test('POST /api/auth/login: nhap sai 5 lan -> 423 Locked kem lockoutRemainingSeconds va suggestReset', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL
  });
  const { clearFailedLogins } = require('./authRoutes');
  clearFailedLogins('lockoutuser');

  const userRepository = require('./userRepository');
  userRepository.findActiveUserByUsername = async () => null; // User khong ton tai hoac sai pass

  const handler = getRouteHandler(router, 'post', '/api/auth/login');

  // 4 lan dau -> 401
  for (let i = 0; i < 4; i++) {
    const res = fakeRes();
    await handler({ body: { username: 'lockoutuser', password: 'wrongpassword' } }, res);
    assert.equal(res.statusCode, 401);
  }

  // Lan 5 -> 423
  const res5 = fakeRes();
  await handler({ body: { username: 'lockoutuser', password: 'wrongpassword' } }, res5);
  assert.equal(res5.statusCode, 423);
  assert.equal(res5.body.locked, true);
  assert.equal(res5.body.suggestReset, true);
  assert.ok(res5.body.lockoutRemainingSeconds > 0);

  clearFailedLogins('lockoutuser');
});

test('POST /api/auth/google: cap nhat ten va email vao tai khoan nguoi dung', async () => {
  let updatedFields = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'existing@gmail.com', emailVerified: true, name: 'Nguyễn Văn A' }),
    findUserByEmail: async () => ({
      id: 'user-123',
      username: 'existing@gmail.com',
      hoTen: 'existing@gmail.com',
      email: '',
      vaiTro: 'Khách',
      coSo: '',
      trangThai: 'Đang hoạt động'
    }),
    createActiveGuest: NEVER_CALL,
    updateUserFields: async (id, fields) => {
      updatedFields = fields;
      return { id, username: 'existing@gmail.com', hoTen: fields.hoTen, email: fields.email, vaiTro: 'Khách', coSo: '', trangThai: 'Đang hoạt động' };
    }
  });

  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.email, 'existing@gmail.com');
  assert.equal(res.body.hoTen, 'Nguyễn Văn A');
  assert.equal(updatedFields.email, 'existing@gmail.com');
  assert.equal(updatedFields.hoTen, 'Nguyễn Văn A');
  assert.ok(updatedFields.dangNhapGanNhat);
});

test('POST /api/auth/login: tu dong cap nhat email neu dang nhap bang email ma truong email rong', async () => {
  let updatedFields = null;
  const { hashPassword } = require('./authService');
  const hashedPassword = await hashPassword('password123');

  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findActiveUserByUsername: async () => ({
      id: 'user-456',
      username: 'user_email@domain.com',
      hoTen: 'Người Dùng',
      email: '',
      passwordHash: hashedPassword,
      vaiTro: 'Khách',
      coSo: '',
      trangThai: 'Đang hoạt động'
    }),
    updateUserFields: async (id, fields) => {
      updatedFields = fields;
      return { id, username: 'user_email@domain.com', hoTen: 'Người Dùng', email: fields.email, vaiTro: 'Khách', coSo: '', trangThai: 'Đang hoạt động' };
    }
  });

  const handler = getRouteHandler(router, 'post', '/api/auth/login');
  const res = fakeRes();
  await handler({ body: { username: 'user_email@domain.com', password: 'password123' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.email, 'user_email@domain.com');
  assert.equal(updatedFields.email, 'user_email@domain.com');
  assert.ok(updatedFields.dangNhapGanNhat);
});

test('POST /api/auth/login: tai khoan Không hoạt động dang nhap duoc va chuyen thanh Đang hoạt động', async () => {
  let updatedFields = null;
  const { hashPassword } = require('./authService');
  const hashedPassword = await hashPassword('password123');

  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findActiveUserByUsername: async () => ({
      id: 'user-inactive',
      username: 'inactive_user',
      hoTen: 'Người Dùng Inactive',
      email: 'inactive@tokosi.vn',
      passwordHash: hashedPassword,
      vaiTro: 'Kế toán',
      coSo: 'Hà Nội',
      trangThai: 'Không hoạt động'
    }),
    updateUserFields: async (id, fields) => {
      updatedFields = fields;
      return { id, username: 'inactive_user', hoTen: 'Người Dùng Inactive', email: 'inactive@tokosi.vn', vaiTro: 'Kế toán', coSo: 'Hà Nội', ...fields };
    }
  });

  const handler = getRouteHandler(router, 'post', '/api/auth/login');
  const res = fakeRes();
  await handler({ body: { username: 'inactive_user', password: 'password123' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(updatedFields.trangThai, 'Đang hoạt động');
  assert.ok(updatedFields.dangNhapGanNhat);
});

test('POST /api/auth/google: thangnnv2003@gmail.com mac dinh nhan quyen Quan ly khi tao moi', async () => {
  let createdWith = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'thangnnv2003@gmail.com', emailVerified: true, name: 'Nguyễn Ngọc Việt Thắng' }),
    findUserByEmail: async () => null,
    createActiveGuest: async args => {
      createdWith = args;
      return {
        id: 'thang-id',
        username: args.username,
        hoTen: args.hoTen,
        email: args.email,
        vaiTro: args.vaiTro || 'Quản lý',
        coSo: 'Cả hai',
        trangThai: 'Đang hoạt động'
      };
    }
  });

  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.email, 'thangnnv2003@gmail.com');
  assert.equal(res.body.vaiTro, 'Quản lý');
  assert.equal(createdWith.vaiTro, 'Quản lý');
});

test('POST /api/auth/google: thangnnv2003@gmail.com ton tai tu truoc duoc tu dong nang/giu quyen Quan ly', async () => {
  let updatedFields = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'thangnnv2003@gmail.com', emailVerified: true, name: 'Nguyễn Ngọc Việt Thắng' }),
    findUserByEmail: async () => ({
      id: 'thang-id',
      username: 'thangnnv2003@gmail.com',
      hoTen: 'Nguyễn Ngọc Việt Thắng',
      email: 'thangnnv2003@gmail.com',
      vaiTro: 'Khách',
      coSo: '',
      trangThai: 'Đang hoạt động'
    }),
    createActiveGuest: NEVER_CALL,
    updateUserFields: async (id, fields) => {
      updatedFields = fields;
      return {
        id,
        username: 'thangnnv2003@gmail.com',
        hoTen: 'Nguyễn Ngọc Việt Thắng',
        email: 'thangnnv2003@gmail.com',
        vaiTro: fields.vaiTro || 'Quản lý',
        coSo: 'Cả hai',
        trangThai: 'Đang hoạt động'
      };
    }
  });

  const handler = getRouteHandler(router, 'post', '/api/auth/google');
  const res = fakeRes();
  await handler({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.vaiTro, 'Quản lý');
  assert.equal(updatedFields.vaiTro, 'Quản lý');
  assert.equal(updatedFields.trangThai, 'Đang hoạt động');
});

test('POST /api/auth/register: dang ky bang thangnnv2003@gmail.com duoc gan quyen Quan ly', async () => {
  let createdWith = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: async () => null,
    findUserByUsername: async () => null,
    createActiveGuest: async args => { createdWith = args; }
  });
  const handler = getRouteHandler(router, 'post', '/api/auth/register');
  const res = fakeRes();
  await handler({ body: { hoTen: 'Thắng', email: 'thangnnv2003@gmail.com', password: 'Password123' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(res.body.vaiTro, 'Quản lý');
  assert.equal(createdWith.vaiTro, 'Quản lý');
});

// -------------------------------------------------------------
// FORGOT PASSWORD / OTP — chong user enumeration, khong lo OTP, rate limit
// -------------------------------------------------------------

test('POST /api/auth/forgot-password/channels: tai khoan khong ton tai van tra ve 200 kem kenh gia (chong enumeration)', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findUserByIdentifier: async () => null
  });
  const res = fakeRes();
  await callRoute(router, 'post', '/api/auth/forgot-password/channels', { body: { identifier: 'khong-ton-tai' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.channels) && res.body.channels.length > 0);
  assert.equal(res.body.channels[0].targetRaw, null);
});

test('POST /api/auth/forgot-password/channels: tai khoan ton tai tra ve 200 kem kenh that, cung shape voi tai khoan gia', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findUserByIdentifier: async () => ({ username: 'user1', email: 'user1@example.com' })
  });
  const res = fakeRes();
  await callRoute(router, 'post', '/api/auth/forgot-password/channels', { body: { identifier: 'user1' } }, res);
  assert.equal(res.statusCode, 200);
  assert.ok(Array.isArray(res.body.channels) && res.body.channels.length > 0);
  assert.equal(res.body.channels[0].channel, 'email');
});

test('POST /api/auth/forgot-password/send-otp: tai khoan khong ton tai tra ve 200 gia, khong lo devCode/code', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findUserByIdentifier: async () => null
  });
  const res = fakeRes();
  await callRoute(router, 'post', '/api/auth/forgot-password/send-otp', { body: { identifier: 'khong-ton-tai', channel: 'email' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.devCode, undefined);
  assert.equal(res.body.code, undefined);
});

test('POST /api/auth/forgot-password/send-otp: tai khoan that tra ve 200, khong lo devCode/code trong response', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findUserByIdentifier: async () => ({ username: 'user1', email: 'user1@example.com' })
  });
  const res = fakeRes();
  await callRoute(router, 'post', '/api/auth/forgot-password/send-otp', { body: { identifier: 'user1', channel: 'email' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.devCode, undefined);
  assert.equal(res.body.code, undefined);
  assert.equal('devCode' in res.body, false);
});

test('POST /api/auth/forgot-password/verify: tai khoan khong ton tai tra ve 400 giong OTP sai/het han (khong phai 404)', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findUserByIdentifier: async () => null
  });
  const res = fakeRes();
  await callRoute(router, 'post', '/api/auth/forgot-password/verify', { body: { identifier: 'khong-ton-tai', otp: '123456', newPassword: 'MatKhauMoi123' } }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Mã OTP không tồn tại hoặc đã hết hạn/);
});

test('POST /api/auth/forgot-password/send-otp: goi lien tuc vuot nguong bi chan 429', async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findUserByIdentifier: async () => null
  });
  let sawRateLimited = false;
  for (let i = 0; i < 30; i++) {
    const res = fakeRes();
    await callRoute(router, 'post', '/api/auth/forgot-password/send-otp', { body: { identifier: 'spam-target', channel: 'email' } }, res);
    if (res.statusCode === 429) { sawRateLimited = true; break; }
  }
  assert.equal(sawRateLimited, true);
});

// ---------------------------------------------------------------------------
// Tu dang ky bi khoa (ALLOW_SELF_REGISTRATION != 'true')
// ---------------------------------------------------------------------------
async function withRegistrationLocked(fn) {
  const original = process.env.ALLOW_SELF_REGISTRATION;
  process.env.ALLOW_SELF_REGISTRATION = 'false';
  try { await fn(); } finally { process.env.ALLOW_SELF_REGISTRATION = original; }
}

test('khoa dang ky: /register tra 403 va khong ghi gi', () => withRegistrationLocked(async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL
  });
  const body = { hoTen: 'A', email: 'moi@example.com', password: 'MatKhau123' };
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/register')({ body }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'REGISTRATION_DISABLED');
  assert.equal(res.cookies.length, 0);
}));

test('khoa dang ky: admin cung van dang ky duoc (khong bi khoa chet khoi he thong)', () => withRegistrationLocked(async () => {
  let created = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: async () => null,
    findUserByUsername: async () => null,
    createActiveGuest: async args => { created = args; }
  });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/register')({ body: { hoTen: 'Admin', email: 'thangnnv2003@gmail.com', password: 'MatKhau123' } }, res);
  assert.equal(res.statusCode, 201);
  assert.equal(created.vaiTro, 'Quản lý');
}));

test('khoa dang ky: Google lan dau (chua co tai khoan) -> 403, khong tao tai khoan, khong de nhan su HR tu tao', () => withRegistrationLocked(async () => {
  let linkArgs = null;
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'nguoi.moi@gmail.com', emailVerified: true, name: 'Người Mới' }),
    findUserByEmail: async () => null,
    createActiveGuest: NEVER_CALL,
    employeeRegistration: {
      linkVerifiedGoogleIdentity: async args => { linkArgs = args; return null; }
    }
  });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/google')({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, 'REGISTRATION_DISABLED');
  assert.equal(res.cookies.length, 0);
  assert.equal(linkArgs.allowCreate, false, 'nhan su co trong HR cung khong duoc tao tai khoan moi qua Google');
}));

test('khoa dang ky: Google van dang nhap duoc tai khoan DA CO', () => withRegistrationLocked(async () => {
  const router = freshAuthRoutes({
    verifyGoogleIdToken: async () => ({ email: 'cu@gmail.com', emailVerified: true, name: 'Cũ' }),
    findUserByEmail: async () => ({ id: '1', username: 'cu@gmail.com', hoTen: 'Cũ', vaiTro: 'Nhân viên sale', coSo: '', trangThai: 'Đang hoạt động' }),
    createActiveGuest: NEVER_CALL
  });
  const res = fakeRes();
  await getRouteHandler(router, 'post', '/api/auth/google')({ body: { credential: 'tok' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.cookies.length, 2);
}));

test('GET /api/auth/me giu co so da chon khi lam moi token theo ho so', async () => {
  const user = { id: 'u1', username: 'a@example.com', hoTen: 'A', vaiTro: 'Kế toán', coSo: 'Hà Nội', trangThai: 'Đang hoạt động' };
  const router = freshAuthRoutes({
    verifyGoogleIdToken: NEVER_CALL,
    findUserByEmail: NEVER_CALL,
    createActiveGuest: NEVER_CALL,
    findUserById: async () => user
  });
  const res = fakeRes();
  await getRouteHandler(router, 'get', '/api/auth/me')({
    user: { ...user, hoTen: 'Tên cũ' }, cookies: { tks_branch: 'Sài Gòn' }
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.branch, 'Sài Gòn');
  assert.deepEqual(res.cookies.map(cookie => cookie.name), [AUTH_COOKIE_NAME]);
});

test('GET /api/auth/google-config bao registrationOpen theo cau hinh (mac dinh khoa)', () => {
  const router = freshAuthRoutes({ verifyGoogleIdToken: NEVER_CALL, findUserByEmail: NEVER_CALL, createActiveGuest: NEVER_CALL });
  const res = fakeRes();
  getRouteHandler(router, 'get', '/api/auth/google-config')({}, res);
  assert.equal(res.body.registrationOpen, true, 'bien moi truong dang = true trong file test nay');
  return withRegistrationLocked(async () => {
    const locked = freshAuthRoutes({ verifyGoogleIdToken: NEVER_CALL, findUserByEmail: NEVER_CALL, createActiveGuest: NEVER_CALL });
    const out = fakeRes();
    getRouteHandler(locked, 'get', '/api/auth/google-config')({}, out);
    assert.equal(out.body.registrationOpen, false);
  });
});
