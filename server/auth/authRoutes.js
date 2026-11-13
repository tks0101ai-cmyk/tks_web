// ==========================================
// AUTH ROUTES — dang nhap mat khau/Google, dang ky Khach (email/SDT), dang xuat,
// reset mat khau qua OTP, quan ly thong tin khoi phuc va doc thong tin phien.
// ==========================================
const express = require('express');
const crypto = require('crypto');
const CONFIG = require('../config');
const { hashPassword, comparePassword } = require('./authService');
const {
  findActiveUserByUsername,
  findUserByUsername,
  findUserByEmail,
  findUserByIdentifier,
  findUserById,
  ACTIVE_STATUS,
  INACTIVE_STATUS,
  PENDING_STATUS,
  LOCKED_STATUS,
  ROLES,
  normalizePhone,
  isHardcodedAdmin
} = require('./userRepository');
const { formatDateVN } = require('./localUserStore');
const { createActiveGuest, activatePendingGuest, updateUserFields, updateUserProfile } = require('./userWriteRepository');
const { verifyGoogleIdToken } = require('./googleAuthService');
const { AUTH_COOKIE_NAME, requireAuth } = require('./authMiddleware');
const { publicUser, issueSession } = require('./authSession');
const { selectableBranches, defaultBranch } = require('../branch/branches');
const { currentBranchFor, BRANCH_COOKIE_NAME, branchCookieOptions } = require('../branch/branchMiddleware');
const otpService = require('./otpService');
const employeeRegistrationService = require('./employeeRegistrationService');
const effectiveUserResolver = require('./effectiveUserResolver');
const featureRegistry = require('./featureRegistry');
const accountPolicy = require('./accountPolicy');
const contactChangeService = require('./contactChangeService');

const router = express.Router();

// Rate limit & Lockout tracker: theo doi so lan dang nhap sai
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 phut
const failedLogins = new Map(); // Map<normalizedIdentifier, { count: number, lockedUntil: number }>

function clearFailedLogins(identifier) {
  if (identifier) {
    failedLogins.delete(String(identifier).trim().toLowerCase());
    const phone = normalizePhone(identifier);
    if (phone) failedLogins.delete(phone);
  } else {
    failedLogins.clear();
  }
}

// Rate limit cho cac route quen mat khau (channels/send-otp/verify): gioi han
// theo ca identifier va IP de chan vua do 1 tai khoan vua do nhieu tai khoan
// tu cung 1 nguon.
const FORGOT_PW_WINDOW_MS = 10 * 60 * 1000; // 10 phut
const FORGOT_PW_MAX_PER_IDENTIFIER = 8;
const FORGOT_PW_MAX_PER_IP = 20;
const forgotPwHitsByIdentifier = new Map(); // Map<string, { count, windowStart }>
const forgotPwHitsByIp = new Map(); // Map<string, { count, windowStart }>

// Rate limit cho doi email qua OTP (begin + verify dung chung bo dem), theo
// user da dang nhap va theo IP. Lop chan som; gioi han that (so lan sai OTP /
// so lan gui ma theo user trong 1 gio) nam o contactChangeService.
const CONTACT_CHANGE_WINDOW_MS = 10 * 60 * 1000; // 10 phut
const CONTACT_CHANGE_MAX_PER_USER = 20;
const CONTACT_CHANGE_MAX_PER_IP = 60;
const contactChangeHitsByUser = new Map(); // Map<userId, { count, windowStart }>
const contactChangeHitsByIp = new Map(); // Map<ip, { count, windowStart }>

// failedLogins/forgotPwHits* duoc key bang chuoi do NGUOI DUNG CHUA XAC THUC
// tu chon (username/identifier/IP bat ky, ke ca tai khoan khong ton tai) —
// khong don dep thi ke tan cong co the lam 3 Map nay phinh to vo han
// (memory-exhaustion DoS). Quet "lazy" theo request that (toi da 1 lan/5
// phut) thay vi dung setInterval, vi authRoutes.test.js xoa require-cache
// va require lai module nay lien tuc — moi setInterval o module-scope se
// bi "mo coi" (khong the clearInterval) nhung van chay ngam vinh vien.
const MAP_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastMapSweepAt = 0;

function sweepStaleAuthState(now) {
  if (now - lastMapSweepAt < MAP_SWEEP_INTERVAL_MS) return;
  lastMapSweepAt = now;

  for (const [key, rec] of failedLogins) {
    const stillLocked = rec.lockedUntil && now < rec.lockedUntil;
    const idleMs = now - (rec.lastAttemptAt || 0);
    if (!stillLocked && idleMs > LOCKOUT_DURATION_MS) failedLogins.delete(key);
  }
  for (const [key, rec] of forgotPwHitsByIdentifier) {
    if (now - rec.windowStart > FORGOT_PW_WINDOW_MS) forgotPwHitsByIdentifier.delete(key);
  }
  for (const [key, rec] of forgotPwHitsByIp) {
    if (now - rec.windowStart > FORGOT_PW_WINDOW_MS) forgotPwHitsByIp.delete(key);
  }
  for (const map of [contactChangeHitsByUser, contactChangeHitsByIp]) {
    for (const [key, rec] of map) {
      if (now - rec.windowStart > CONTACT_CHANGE_WINDOW_MS) map.delete(key);
    }
  }
}

function checkAndBumpRateLimit(map, key, max, now, windowMs = FORGOT_PW_WINDOW_MS) {
  if (!key) return true;
  const entry = map.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    map.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= max) return false;
  entry.count += 1;
  return true;
}

function forgotPasswordRateLimit(req, res, next) {
  const now = Date.now();
  sweepStaleAuthState(now);
  const identifierKey = String((req.body && req.body.identifier) || '').trim().toLowerCase();
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const idOk = checkAndBumpRateLimit(forgotPwHitsByIdentifier, identifierKey, FORGOT_PW_MAX_PER_IDENTIFIER, now);
  const ipOk = checkAndBumpRateLimit(forgotPwHitsByIp, ip, FORGOT_PW_MAX_PER_IP, now);
  if (!idOk || !ipOk) {
    return res.status(429).json({ error: 'Bạn thao tác quá nhiều lần, vui lòng thử lại sau ít phút.' });
  }
  next();
}

// Dat SAU requireAuth (can req.user.id).
function contactChangeRateLimit(req, res, next) {
  const now = Date.now();
  sweepStaleAuthState(now);
  const userKey = req.user && req.user.id !== undefined && req.user.id !== null ? String(req.user.id) : '';
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const userOk = checkAndBumpRateLimit(contactChangeHitsByUser, userKey, CONTACT_CHANGE_MAX_PER_USER, now, CONTACT_CHANGE_WINDOW_MS);
  const ipOk = checkAndBumpRateLimit(contactChangeHitsByIp, ip, CONTACT_CHANGE_MAX_PER_IP, now, CONTACT_CHANGE_WINDOW_MS);
  if (!userOk || !ipOk) {
    const starts = [
      !userOk && contactChangeHitsByUser.get(userKey),
      !ipOk && contactChangeHitsByIp.get(ip)
    ].filter(Boolean).map(entry => entry.windowStart);
    const waitSeconds = Math.max(1, Math.ceil((Math.max(...starts) + CONTACT_CHANGE_WINDOW_MS - now) / 1000));
    return res.status(429).json({
      error: 'Bạn thao tác quá nhiều lần, vui lòng thử lại sau ít phút.',
      code: 'RATE_LIMITED',
      waitSeconds
    });
  }
  next();
}

/**
 * Sinh danh sach kenh OTP gia, deterministic theo identifier, dung cho tai
 * khoan khong ton tai de tranh lo thong tin qua enumeration (response giong
 * het tai khoan that ve hinh dang va tinh on dinh giua cac lan goi).
 */
function fakeChannelsForIdentifier(identifier) {
  const hash = crypto.createHash('sha256').update(String(identifier || '')).digest('hex');
  const maskedUser = hash.slice(0, 2);
  return [
    {
      channel: 'email',
      label: 'Email chính',
      targetMasked: `${maskedUser}***@••••.com`,
      targetRaw: null
    }
  ];
}

const FAKE_CHANNEL_LABELS = {
  email: 'Email chính',
  recovery_email: 'Email khôi phục'
};

function fakeSendOtpResponse(identifier, channelType) {
  const label = FAKE_CHANNEL_LABELS[channelType] || 'kênh liên hệ';
  const hash = crypto.createHash('sha256').update(`${String(identifier || '')}|${channelType}`).digest('hex');
  const targetMasked = channelType.includes('email')
    ? `${hash.slice(0, 2)}***@••••.com`
    : `${hash.slice(0, 2)}****${hash.slice(2, 5)}`;
  return {
    ok: true,
    message: `Mã xác nhận OTP đã được gửi đến ${label.toLowerCase()} (${targetMasked}).`,
    targetMasked,
    channel: channelType,
    expiresInSeconds: Math.floor(otpService.OTP_TTL_MS / 1000)
  };
}

// ID Telegram ca nhan chi Quan ly (hoac admin cung) duoc them/sua. Nhan vien khong tu doi
// duoc o ho so cua minh — Quan ly nhap ho trong "Quan ly nguoi dung" (adminUserRoutes.js).
function canEditOwnTelegram(user) {
  return !!user && (user.vaiTro === ROLES.QUAN_LY || isHardcodedAdmin(user.email) || isHardcodedAdmin(user.username));
}

function publicProfile(user) {
  return {
    id: user.id,
    username: user.username,
    hoTen: user.hoTen,
    vaiTro: user.vaiTro,
    coSo: user.coSo,
    email: user.email || '',
    soDienThoai: user.soDienThoai || '',
    telegramId: user.telegramId || '',
    telegramEditable: canEditOwnTelegram(user),
    emailKhoiPhuc: user.emailKhoiPhuc || '',
    sdtKhoiPhuc: user.sdtKhoiPhuc || '',
    hasPassword: !!user.passwordHash,
    hrManaged: !!user.hrManaged,
    hrSourceBranch: user.hrSourceBranch || '',
    sheetVaiTro: user.sheetVaiTro || '',
    sheetCoSo: user.sheetCoSo || '',
    vaiTroOverride: user.vaiTroOverride || '',
    coSoOverride: user.coSoOverride || '',
    roleSource: user.roleSource || (user.hrManaged ? 'sheet' : 'local')
  };
}

function signIn(res, user, resetBranch = false) {
  const safeUser = issueSession(res, user);
  if (resetBranch) {
    res.cookie(BRANCH_COOKIE_NAME, defaultBranch(user), branchCookieOptions());
  }
  return safeUser;
}

/**
 * Ghi nhan 1 lan dang nhap sai cho `normIdentifier` — dung CHUNG cho ca 2
 * truong hop "tai khoan khong ton tai" va "sai mat khau" (ghi nhan ngay ca
 * khi khong tim thay user de tranh do pass qua enumeration). Tra ve
 * { status, body } de route goi res.status(...).json(...) truc tiep.
 */
function registerFailedLoginAttempt(identifier, normIdentifier, now) {
  let rec = failedLogins.get(normIdentifier) || { count: 0, lockedUntil: 0, lastAttemptAt: 0 };
  const lockExpired = rec.lockedUntil && now >= rec.lockedUntil;
  // Chua tung bi khoa nhung khong hoat dong qua lau -> coi nhu reset (tranh
  // cong don loi nhap sai cach nhau hang thang, thang nam).
  const idleTooLong = !rec.lockedUntil && rec.lastAttemptAt && now - rec.lastAttemptAt > LOCKOUT_DURATION_MS;
  if (lockExpired || idleTooLong) rec = { count: 0, lockedUntil: 0, lastAttemptAt: 0 };

  rec.count += 1;
  rec.lastAttemptAt = now;

  if (rec.count >= MAX_FAILED_ATTEMPTS) {
    rec.lockedUntil = now + LOCKOUT_DURATION_MS;
    failedLogins.set(normIdentifier, rec);
    const remainingSec = Math.ceil(LOCKOUT_DURATION_MS / 1000);
    return {
      status: 423,
      body: {
        error: 'Bạn đã nhập sai mật khẩu quá 5 lần. Tài khoản bị tạm khóa 5 phút. Vui lòng đặt lại mật khẩu qua OTP.',
        locked: true,
        lockoutRemainingSeconds: remainingSec,
        suggestReset: true,
        identifier
      }
    };
  }

  failedLogins.set(normIdentifier, rec);
  const remaining = MAX_FAILED_ATTEMPTS - rec.count;
  return {
    status: 401,
    body: { error: `Tài khoản hoặc mật khẩu không đúng. (Còn ${remaining} lần thử)` }
  };
}

// -------------------------------------------------------------
// POST /api/auth/login
// -------------------------------------------------------------
router.post('/api/auth/login', async (req, res) => {
  try {
    const username = req.body && req.body.username;
    const password = req.body && req.body.password;
    if (!username || !password) {
      return res.status(400).json({ error: 'Vui lòng nhập tài khoản và mật khẩu.' });
    }

    const normIdentifier = String(username).trim().toLowerCase();
    const now = Date.now();
    sweepStaleAuthState(now);

    // Kiem tra trang thai tam khoa
    const lockRecord = failedLogins.get(normIdentifier);
    if (lockRecord && lockRecord.lockedUntil && now < lockRecord.lockedUntil) {
      const remainingSec = Math.ceil((lockRecord.lockedUntil - now) / 1000);
      return res.status(423).json({
        error: `Tài khoản tạm thời bị khóa do nhập sai quá 5 lần. Vui lòng thử lại sau ${remainingSec} giây hoặc đổi mật khẩu qua OTP.`,
        locked: true,
        lockoutRemainingSeconds: remainingSec,
        suggestReset: true,
        identifier: username
      });
    }

    let user = await findActiveUserByUsername(username);
    if (!user) {
      const lockedCandidate = await findUserByIdentifier(username);
      if (lockedCandidate && lockedCandidate.lockReason === 'hr_removed') {
        user = await effectiveUserResolver.resolveUser(lockedCandidate);
      }
    }
    if (!user) {
      const failResult = registerFailedLoginAttempt(username, normIdentifier, now);
      return res.status(failResult.status).json(failResult.body);
    }

    const passwordOk = await comparePassword(password, user.passwordHash);
    if (!passwordOk) {
      const failResult = registerFailedLoginAttempt(username, normIdentifier, now);
      return res.status(failResult.status).json(failResult.body);
    }

    // Dang nhap thanh cong -> xoa bo dem loi
    clearFailedLogins(username);
    if (user.username) clearFailedLogins(user.username);
    if (user.email) clearFailedLogins(user.email);
    if (user.soDienThoai) clearFailedLogins(user.soDienThoai);

    const isTargetAdmin = isHardcodedAdmin(user.email) || isHardcodedAdmin(user.username);
    if (isTargetAdmin) {
      user.vaiTro = ROLES.QUAN_LY;
      user.trangThai = ACTIVE_STATUS;
    }

    const updates = {
      dangNhapGanNhat: formatDateVN(new Date())
    };
    if (user.trangThai === INACTIVE_STATUS || user.trangThai === 'Không hoạt động' || user.trangThai === PENDING_STATUS) {
      updates.trangThai = ACTIVE_STATUS;
    }

    // Neu dang nhap bang email ma tai khoan chua co truong email -> cap nhat vao ho so
    if (normIdentifier.includes('@') && !user.email) {
      updates.email = normIdentifier;
    }
    const updated = await updateUserFields(user.id, updates);
    if (updated) user = { ...user, ...updates, ...updated };
    user = await effectiveUserResolver.resolveUser(user);
    if (user.trangThai === LOCKED_STATUS || user.trangThai === 'Khóa') {
      if (user.lockReason === 'hr_resigned') {
        return res.status(403).json({ error: 'Tài khoản đã bị khóa do nhân sự đã nghỉ việc.', code: 'ACCOUNT_HR_RESIGNED' });
      }
      return res.status(403).json({ error: 'Tài khoản đã bị khóa.', code: user.lockReason === 'hr_removed' ? 'ACCOUNT_HR_REMOVED' : 'ACCOUNT_LOCKED' });
    }

    res.status(200).json(signIn(res, user, true));
  } catch (err) {
    if (err && err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    if (err && err.code === 'HR_DIRECTORY_UNAVAILABLE') {
      return res.status(503).json({ error: err.message, code: err.code });
    }
    console.error('=== LOI /api/auth/login ===');
    console.error(err.stack);
    console.error('===========================');
    res.status(500).json({ error: 'Không đăng nhập được, vui lòng thử lại.' });
  }
});

// -------------------------------------------------------------
// POST /api/auth/register (chi Email)
// -------------------------------------------------------------
const REGISTRATION_DISABLED_RESPONSE = Object.freeze({
  error: 'Đăng ký tài khoản mới đã bị khóa. Vui lòng liên hệ Quản lý để được cấp tài khoản.',
  code: 'REGISTRATION_DISABLED'
});

// Admin cung (HARDCODED_ADMINS) luon dang ky/dang nhap duoc de khong bi khoa chet khoi he thong.
function registrationLocked(email) {
  return !CONFIG.ALLOW_SELF_REGISTRATION && !isHardcodedAdmin(email);
}

router.post('/api/auth/register', async (req, res) => {
  try {
    const hoTen = String((req.body && req.body.hoTen) || '').trim();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    if (registrationLocked(email)) {
      return res.status(403).json(REGISTRATION_DISABLED_RESPONSE);
    }

    if (!hoTen) {
      return res.status(400).json({ error: 'Vui lòng nhập họ và tên.' });
    }
    if (hoTen.length > 100) {
      return res.status(400).json({ error: 'Họ tên không được dài quá 100 ký tự.' });
    }

    if (!email) {
      return res.status(400).json({ error: 'Vui lòng nhập email để đăng ký.' });
    }

    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Email không hợp lệ.' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 8 ký tự.' });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: 'Mật khẩu không được dài quá 128 ký tự.' });
    }

    // Kiem tra trung lap
    const existingByEmail = await findUserByEmail(email);
    const existingByUsername = existingByEmail ? null : await findUserByUsername(email);
    if (existingByEmail || existingByUsername) {
      return res.status(409).json({ error: 'Email này đã được đăng ký.' });
    }

    const passwordHash = await hashPassword(password);
    const username = email;
    const isTargetAdmin = isHardcodedAdmin(email) || isHardcodedAdmin(username);
    const user = {
      id: crypto.randomUUID(),
      username,
      hoTen,
      email,
      soDienThoai: '',
      vaiTro: isTargetAdmin ? ROLES.QUAN_LY : ROLES.KHACH,
      coSo: isTargetAdmin ? 'Cả hai' : ''
    };

    try {
      await createActiveGuest({ ...user, passwordHash });
    } catch (err) {
      if (err && err.code === 'USER_EXISTS') {
        return res.status(409).json({ error: err.message || 'Tài khoản này đã được đăng ký.' });
      }
      throw err;
    }

    res.status(201).json(signIn(res, user, true));
  } catch (err) {
    console.error('=== LOI /api/auth/register ===');
    console.error(err.stack);
    console.error('=============================');
    res.status(500).json({ error: 'Không đăng ký được, vui lòng thử lại.' });
  }
});

// -------------------------------------------------------------
// FORGOT PASSWORD / OTP ROUTES
// -------------------------------------------------------------

/**
 * Tra ve cac kenh nhan OTP kha dung cho tai khoan (Email / SDT da che mo)
 */
router.post('/api/auth/forgot-password/channels', forgotPasswordRateLimit, async (req, res) => {
  try {
    const identifier = req.body && req.body.identifier;
    if (!identifier) {
      return res.status(400).json({ error: 'Vui lòng nhập tên tài khoản, email hoặc số điện thoại.' });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      // Tra ve kenh gia thay vi 404 de tranh lo thong tin tai khoan nao ton tai (user enumeration)
      return res.status(200).json({
        identifier,
        channels: fakeChannelsForIdentifier(identifier)
      });
    }

    const channels = otpService.getAvailableChannels(user);
    if (!channels || channels.length === 0) {
      return res.status(400).json({
        error: 'Tài khoản chưa có Email hoặc Số điện thoại xác minh để nhận mã OTP. Vui lòng liên hệ quản trị viên.'
      });
    }

    res.status(200).json({
      identifier: user.username,
      channels
    });
  } catch (err) {
    console.error('=== LOI /api/auth/forgot-password/channels ===', err);
    res.status(500).json({ error: 'Không lấy được phương thức gửi mã, vui lòng thử lại.' });
  }
});

/**
 * Gui ma OTP den kenh da chon
 */
router.post('/api/auth/forgot-password/send-otp', forgotPasswordRateLimit, async (req, res) => {
  try {
    const identifier = req.body && req.body.identifier;
    const channelType = req.body && req.body.channel; // 'email' | 'phone' | 'recovery_email' | 'recovery_phone'
    if (!identifier || !channelType) {
      return res.status(400).json({ error: 'Thiếu thông tin tài khoản hoặc kênh gửi mã OTP.' });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      // Tra ve response gia giong het tai khoan that de tranh lo user enumeration
      return res.status(200).json(fakeSendOtpResponse(identifier, channelType));
    }

    const channels = otpService.getAvailableChannels(user);
    const chosen = channels.find(c => c.channel === channelType);
    if (!chosen) {
      return res.status(400).json({ error: 'Kênh gửi mã không hợp lệ cho tài khoản này.' });
    }

    const otpResult = await otpService.generateResetOtp(user.username, chosen.targetRaw, chosen.channel);
    if (!otpResult.success) {
      if (otpResult.cooldown) {
        return res.status(429).json({ error: `Vui lòng đợi ${otpResult.waitSeconds} giây trước khi yêu cầu mã mới.` });
      }
      return res.status(502).json({ error: otpResult.error || 'Không gửi được mã OTP, vui lòng thử lại.' });
    }

    res.status(200).json({
      ok: true,
      message: `Mã xác nhận OTP đã được gửi đến ${chosen.label.toLowerCase()} (${chosen.targetMasked}).`,
      targetMasked: chosen.targetMasked,
      channel: chosen.channel,
      expiresInSeconds: otpResult.expiresInSeconds
    });
  } catch (err) {
    console.error('=== LOI /api/auth/forgot-password/send-otp ===', err);
    res.status(500).json({ error: 'Không gửi được mã OTP, vui lòng thử lại.' });
  }
});

/**
 * Xac thuc ma OTP va cap nhat mat khau moi
 */
router.post('/api/auth/forgot-password/verify', forgotPasswordRateLimit, async (req, res) => {
  try {
    const identifier = req.body && req.body.identifier;
    const otp = req.body && req.body.otp;
    const newPassword = String((req.body && req.body.newPassword) || '');

    if (!identifier || !otp) {
      return res.status(400).json({ error: 'Vui lòng nhập tài khoản và mã OTP.' });
    }

    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });
    }
    if (newPassword.length > 128) {
      return res.status(400).json({ error: 'Mật khẩu mới không được dài quá 128 ký tự.' });
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      // Cung status/message nhu OTP sai/het han de khong lo enumeration qua buoc verify
      return res.status(400).json({ error: 'Mã OTP không tồn tại hoặc đã hết hạn. Vui lòng yêu cầu mã mới.' });
    }

    const verifyResult = otpService.verifyResetOtp(user.username, otp);
    if (!verifyResult.valid) {
      return res.status(400).json({ error: verifyResult.error });
    }

    const passwordHash = await hashPassword(newPassword);
    await updateUserFields(user.id, { passwordHash });

    // Xoa OTP va xoa lockout neu co
    otpService.clearResetOtp(user.username);
    clearFailedLogins(user.username);
    if (user.email) clearFailedLogins(user.email);
    if (user.soDienThoai) clearFailedLogins(user.soDienThoai);

    res.status(200).json({
      ok: true,
      message: 'Đặt lại mật khẩu thành công! Bạn có thể đăng nhập bằng mật khẩu mới.'
    });
  } catch (err) {
    console.error('=== LOI /api/auth/forgot-password/verify ===', err);
    res.status(500).json({ error: 'Không đặt lại được mật khẩu, vui lòng thử lại.' });
  }
});

// -------------------------------------------------------------
// GOOGLE AUTH
// -------------------------------------------------------------
router.get('/api/auth/google-config', (req, res) => {
  // registrationOpen: trang login/register dua vao day de an link + khoa form khi tu dang ky bi khoa.
  res.status(200).json({ clientId: CONFIG.GOOGLE_CLIENT_ID || null, registrationOpen: !!CONFIG.ALLOW_SELF_REGISTRATION });
});

router.post('/api/auth/google', async (req, res) => {
  try {
    const credential = req.body && req.body.credential;
    if (!credential) {
      return res.status(400).json({ error: 'Thiếu thông tin đăng nhập Google.' });
    }
    if (!CONFIG.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ error: 'Đăng nhập bằng Google chưa được cấu hình.' });
    }

    let profile;
    try {
      profile = await verifyGoogleIdToken(credential);
    } catch (err) {
      return res.status(401).json({ error: 'Không xác thực được với Google, vui lòng thử lại.' });
    }
    if (!profile.email || !profile.emailVerified) {
      return res.status(401).json({ error: 'Email Google chưa được xác minh.' });
    }

    const email = profile.email.toLowerCase().trim();
    const googleName = (profile.name || '').trim();
    const isTargetAdmin = isHardcodedAdmin(email);

    let user = isTargetAdmin
      ? null
      : await employeeRegistrationService.linkVerifiedGoogleIdentity({
        email, hoTen: googleName, allowCreate: !!CONFIG.ALLOW_SELF_REGISTRATION
      });
    if (!user) user = await findUserByEmail(email);

    if (!user) {
      if (registrationLocked(email)) {
        return res.status(403).json(REGISTRATION_DISABLED_RESPONSE);
      }
      const assignedRole = isTargetAdmin ? ROLES.QUAN_LY : ROLES.KHACH;
      const created = await createActiveGuest({
        email,
        hoTen: googleName || email,
        username: email,
        vaiTro: assignedRole
      });
      user = created || {
        id: crypto.randomUUID(),
        username: email,
        hoTen: googleName || email,
        email,
        vaiTro: assignedRole,
        coSo: isTargetAdmin ? 'Cả hai' : '',
        trangThai: ACTIVE_STATUS,
        dangNhapGanNhat: formatDateVN(new Date())
      };
      if (user && user.id) {
        await updateUserFields(user.id, { dangNhapGanNhat: formatDateVN(new Date()) });
      }
    } else {
      if (isTargetAdmin || isHardcodedAdmin(user.username)) {
        user.vaiTro = ROLES.QUAN_LY;
        user.trangThai = ACTIVE_STATUS;
      }
      if (user.trangThai === LOCKED_STATUS || user.trangThai === 'Khóa') {
        return res.status(403).json({ error: 'Tài khoản đã bị khóa.' });
      }

      // Tai khoan da ton tai -> dong bo ten, email va dangNhapGanNhat tu Google vao ho so nguoi dung
      const updates = {
        dangNhapGanNhat: formatDateVN(new Date())
      };
      if (!user.email || user.email.toLowerCase() !== email) {
        updates.email = email;
      }
      if (!user.hrManaged && googleName && (!user.hoTen || user.hoTen === user.username || user.hoTen === user.email || user.hoTen !== googleName)) {
        updates.hoTen = googleName;
      }
      if (isTargetAdmin || isHardcodedAdmin(user.username)) {
        updates.vaiTro = ROLES.QUAN_LY;
        updates.trangThai = ACTIVE_STATUS;
      } else if (user.trangThai === PENDING_STATUS) {
        await activatePendingGuest({ email, hoTen: googleName || user.hoTen });
        updates.vaiTro = ROLES.KHACH;
        updates.trangThai = ACTIVE_STATUS;
      } else if (user.trangThai === INACTIVE_STATUS || user.trangThai === 'Không hoạt động') {
        updates.trangThai = ACTIVE_STATUS;
      }
      if (Object.keys(updates).length > 0) {
        const updated = await updateUserFields(user.id, updates);
        user = { ...user, ...updates, ...(updated || {}) };
      }
    }

    if (user.trangThai !== ACTIVE_STATUS) {
      return res.status(403).json({ error: 'Tài khoản đã bị khóa.' });
    }

    clearFailedLogins(email);
    res.status(200).json(signIn(res, user, true));
  } catch (err) {
    // Loi nghiep vu co status (vd linkVerifiedGoogleIdentity -> 409 HR_IDENTITY_CONFLICT).
    if (err && err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('=== LOI /api/auth/google ===');
    console.error(err.stack);
    console.error('=============================');
    res.status(500).json({ error: 'Không đăng nhập được, vui lòng thử lại.' });
  }
});

router.post('/api/auth/logout', (req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, { path: '/' });
  res.status(200).json({ ok: true });
});

router.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    let user = await findUserById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: 'Tài khoản không tồn tại hoặc đã bị xóa.' });
    }
    if (isHardcodedAdmin(user.email) || isHardcodedAdmin(user.username)) {
      user.vaiTro = ROLES.QUAN_LY;
      user.trangThai = ACTIVE_STATUS;
    }
    if (user.trangThai !== ACTIVE_STATUS) {
      return res.status(403).json({ error: 'Tài khoản đã bị tạm khóa.' });
    }
    // Tự động làm mới cookie token nếu vai trò hoặc thông tin có cập nhật mới
    if (user.vaiTro !== req.user.vaiTro || user.hoTen !== req.user.hoTen || user.coSo !== req.user.coSo) {
      signIn(res, user);
    }
    // Kem danh sach co so duoc phep + co so dang chon: thanh dieu huong dua vao
    // day de quyet dinh co hien nut chon co so hay khong (chi khi co >= 2).
    //
    // `permissions` + `pageFeatures` la NGUON DUY NHAT cho phia client dung
    // menu va dieu huong (shared-nav.js khong con mang vai tro nao). CO Y
    // KHONG dua vao JWT: token song toi 7 ngay (phien truot), con quyen phai co hieu luc ngay khi
    // Quan ly bat/tat, giong nhu doi vai tro.
    // `isSeniorAdmin`: Quan ly cap cao (admin cung) — giao dien tai khoan dua vao day de an
    // cac thao tac len Quan ly khac doi voi Quan ly thuong (server accountPolicy van la ranh gioi that).
    res.status(200).json(Object.assign(publicUser(user), {
      branches: selectableBranches(user),
      branch: currentBranchFor(req, user),
      permissions: featureRegistry.resolvePermissions(user),
      pageFeatures: featureRegistry.PAGE_FEATURES,
      isSeniorAdmin: accountPolicy.isSeniorAdmin(user)
    }));
  } catch (err) {
    // Duong fail-soft: dung publicUser() chu KHONG tra thang req.user — object
    // do la ban ghi day du tu localUserStore (co ca passwordHash).
    res.status(200).json(Object.assign(publicUser(req.user), {
      permissions: req.user.permissions || featureRegistry.resolvePermissions(req.user),
      pageFeatures: featureRegistry.PAGE_FEATURES,
      isSeniorAdmin: accountPolicy.isSeniorAdmin(req.user)
    }));
  }
});

// -------------------------------------------------------------
// PROFILE & RECOVERY CONTACTS
// -------------------------------------------------------------
router.get('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    }
    res.status(200).json(publicProfile(user));
  } catch (err) {
    console.error('=== LOI GET /api/auth/profile ===', err);
    res.status(500).json({ error: 'Không tải được hồ sơ, vui lòng thử lại.' });
  }
});

function sendContactChangeError(res, err) {
  if (err && err.statusCode) {
    const body = { error: err.message, code: err.code };
    if (err.waitSeconds) body.waitSeconds = err.waitSeconds;
    return res.status(err.statusCode).json(body);
  }
  console.error('=== LOI DOI EMAIL QUA OTP ===', err);
  return res.status(500).json({ error: 'Không cập nhật được thông tin liên hệ.', code: 'CONTACT_CHANGE_FAILED' });
}

router.post('/api/auth/profile/contact-change', requireAuth, contactChangeRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const result = await contactChangeService.beginChange(req.user, body.field, body.value);
    res.status(200).json(result);
  } catch (err) {
    sendContactChangeError(res, err);
  }
});

router.post('/api/auth/profile/contact-change/verify', requireAuth, contactChangeRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const updated = await contactChangeService.confirmChange(req.user, body.challengeId, body.otp);
    const effective = await effectiveUserResolver.resolveUser(updated);
    signIn(res, effective);
    res.status(200).json(publicProfile(effective));
  } catch (err) {
    sendContactChangeError(res, err);
  }
});

/**
 * Cap nhat ho so (ho ten, ID Telegram neu duoc phep). Route nay KHONG BAO GIO
 * doi email: email la dinh danh de suy vai tro tu hr_employees, doi tuy y se
 * cho phep chiem quyen nhan su khac. TK nhan su (hrManaged) chi Quan ly doi
 * duoc o trang quan tri; TK thuong doi qua OTP (/api/auth/profile/contact-change).
 * Body van co the gui kem email hien tai (form cu) — trung thi bo qua.
 */
router.post('/api/auth/profile', requireAuth, async (req, res) => {
  try {
    const hoTen = String((req.body && req.body.hoTen) || '').trim();
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const fields = { hoTen };
    if (Object.hasOwn(req.body || {}, 'telegramId')) {
      if (typeof req.body.telegramId !== 'string') {
        return res.status(400).json({ error: 'ID Telegram phải là chuỗi chữ số.', code: 'INVALID_TELEGRAM_ID' });
      }
      const telegramId = req.body.telegramId.trim();
      if (telegramId && !/^[1-9]\d{0,19}$/.test(telegramId)) {
        return res.status(400).json({ error: 'ID Telegram phải là số nguyên dương, tối đa 20 chữ số.', code: 'INVALID_TELEGRAM_ID' });
      }
      fields.telegramId = telegramId;
    }

    if (!hoTen) {
      return res.status(400).json({ error: 'Vui lòng nhập họ tên.' });
    }
    if (hoTen.length > 100) {
      return res.status(400).json({ error: 'Họ tên không được dài quá 100 ký tự.' });
    }

    const current = await findUserById(req.user.id);
    if (!current) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    }
    if (email && email !== String(current.email || '').trim().toLowerCase()) {
      if (current.hrManaged) {
        return res.status(403).json({ error: 'Email của tài khoản nhân sự chỉ Quản lý được đổi. Vui lòng liên hệ Quản lý.', code: 'EMAIL_CHANGE_LOCKED' });
      }
      return res.status(409).json({ error: 'Đổi email cần xác minh mã OTP gửi tới email mới.', code: 'EMAIL_CHANGE_REQUIRES_OTP' });
    }
    if (Object.hasOwn(fields, 'telegramId') && !canEditOwnTelegram(current)) {
      if (fields.telegramId !== (current.telegramId || '')) {
        return res.status(403).json({ error: 'Chỉ Quản lý mới được thêm hoặc sửa ID Telegram. Vui lòng liên hệ Quản lý.', code: 'TELEGRAM_ID_LOCKED' });
      }
      delete fields.telegramId;
    }

    const updated = await updateUserProfile(current.id, fields);
    signIn(res, updated);
    res.status(200).json(publicProfile(updated));
  } catch (err) {
    if (err.statusCode && err.statusCode < 500) {
      return res.status(err.statusCode).json({ error: err.message, code: err.code });
    }
    console.error('=== LOI POST /api/auth/profile ===', err);
    res.status(500).json({ error: 'Không cập nhật được hồ sơ, vui lòng thử lại.' });
  }
});

/**
 * Cap nhat Email khoi phuc. BAT BUOC nhap dung mat khau hien tai (neu TK co mat khau).
 * Route nay KHONG doi SDT chinh: SDT la dinh danh de suy vai tro tu hr_employees,
 * doi/xoa chi bang mat khau se cho phep chiem quyen hoac ne kiem tra xung dot.
 * Body co khoa soDienThoai (ke ca rong) -> 400 PHONE_CHANGE_NOT_ALLOWED.
 */
router.post('/api/auth/recovery', requireAuth, async (req, res) => {
  try {
    if (Object.hasOwn(req.body || {}, 'soDienThoai')) {
      return res.status(400).json({ error: 'Không thể đổi số điện thoại tại đây. Vui lòng liên hệ Quản lý.', code: 'PHONE_CHANGE_NOT_ALLOWED' });
    }
    const current = await findUserById(req.user.id);
    if (!current) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    }

    const matKhauXacNhan = String((req.body && req.body.matKhauXacNhan) || '');
    const emailKhoiPhuc = String((req.body && req.body.emailKhoiPhuc) || '').trim().toLowerCase();

    // Neu tai khoan co mat khau -> bat buoc xac thuc mat khau
    if (current.passwordHash) {
      if (!matKhauXacNhan) {
        return res.status(400).json({ error: 'Vui lòng nhập mật khẩu hiện tại để xác nhận thay đổi.' });
      }
      const passwordOk = await comparePassword(matKhauXacNhan, current.passwordHash);
      if (!passwordOk) {
        return res.status(401).json({ error: 'Mật khẩu xác nhận không chính xác.' });
      }
    }

    // Validate email khoi phuc
    if (emailKhoiPhuc) {
      if (emailKhoiPhuc.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailKhoiPhuc)) {
        return res.status(400).json({ error: 'Email khôi phục không đúng định dạng.' });
      }
    }

    const updated = await updateUserFields(current.id, { emailKhoiPhuc });
    res.status(200).json({
      ok: true,
      message: 'Đã cập nhật thông tin khôi phục thành công.',
      profile: publicProfile(updated)
    });
  } catch (err) {
    if (err && err.code === 'USER_EXISTS') {
      return res.status(409).json({ error: err.message });
    }
    console.error('=== LOI POST /api/auth/recovery ===', err);
    res.status(500).json({ error: 'Không cập nhật được thông tin khôi phục, vui lòng thử lại.' });
  }
});

router.post('/api/auth/change-password', requireAuth, async (req, res) => {
  try {
    const matKhauHienTai = String((req.body && req.body.matKhauHienTai) || '');
    const matKhauMoi = String((req.body && req.body.matKhauMoi) || '');

    const current = await findUserById(req.user.id);
    if (!current) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản.' });
    }

    if (current.passwordHash) {
      if (!matKhauHienTai) {
        return res.status(400).json({ error: 'Vui lòng nhập mật khẩu hiện tại.' });
      }
      const passwordOk = await comparePassword(matKhauHienTai, current.passwordHash);
      if (!passwordOk) {
        return res.status(401).json({ error: 'Mật khẩu hiện tại không đúng.' });
      }
    }

    if (matKhauMoi.length < 8) {
      return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 8 ký tự.' });
    }
    if (matKhauMoi.length > 128) {
      return res.status(400).json({ error: 'Mật khẩu mới không được dài quá 128 ký tự.' });
    }

    const passwordHash = await hashPassword(matKhauMoi);
    await updateUserFields(current.id, { passwordHash });
    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('=== LOI POST /api/auth/change-password ===', err);
    res.status(500).json({ error: 'Không đổi được mật khẩu, vui lòng thử lại.' });
  }
});

module.exports = router;
module.exports.clearFailedLogins = clearFailedLogins;
module.exports.failedLogins = failedLogins;
