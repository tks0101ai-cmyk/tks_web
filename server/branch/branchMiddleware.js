// ==========================================
// BRANCH MIDDLEWARE — quyet dinh CO SO cho moi request du lieu, PHAI dat sau
// requireAuth (can req.user).
//
// Cookie tks_branch chi la GOI Y ve co so dang xem: gia tri luon duoc kiem tra
// lai (chi nhan Hà Nội / Sài Gòn / Cả hai), sai thi rot ve co so mac dinh cua
// tai khoan (luon la Cả hai).
// ==========================================
const CONFIG = require('../config');
const { BRANCHES, isBranchSelectable, defaultBranch } = require('./branches');

const BRANCH_COOKIE_NAME = 'tks_branch';
const BRANCH_COOKIE_MAX_AGE_MS = CONFIG.AUTH_SESSION_TTL_MS; // song cung phien dang nhap (authSession gia han ca hai)

function branchCookieOptions() {
  return {
    // KHONG httpOnly: thanh dieu huong phia client can doc de hien dung co so
    // dang chon. Gia tri nay khong phai bi mat va luon duoc server xac thuc lai.
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: BRANCH_COOKIE_MAX_AGE_MS
  };
}

/**
 * Co so dang duoc chon cua 1 request (chi doc, khong ghi cookie) — dung chung
 * cho GET /api/branch va GET /api/auth/me de ba noi khong lech logic.
 */
function currentBranchFor(req, user) {
  const target = user || req.user;
  const fromCookie = (req.cookies && req.cookies[BRANCH_COOKIE_NAME]) || null;
  if (fromCookie && isBranchSelectable(target, fromCookie)) return fromCookie;
  return defaultBranch(target);
}

/**
 * Gan req.branch = co so dang xem (cookie hop le, khong thi co so mac dinh).
 */
function resolveBranch(req, res, next) {
  const fromCookie = (req.cookies && req.cookies[BRANCH_COOKIE_NAME]) || null;
  if (fromCookie && isBranchSelectable(req.user, fromCookie)) {
    req.branch = fromCookie;
    return next();
  }

  // Cookie thieu / bi sua tay => rot ve co so mac dinh va viet lai cookie.
  req.branch = defaultBranch(req.user);
  res.cookie(BRANCH_COOKIE_NAME, req.branch, branchCookieOptions());
  return next();
}

/**
 * Ban "mem" cua resolveBranch cho cac route KHONG danh rieng cho nhan vien —
 * vd tra cuu trang thai hoa don cua khach hang (vai tro "Khách" khong duoc gan
 * co so nao). Khong bao gio tra 403: cookie hop le thi dung, khong thi ve co so
 * mac dinh cua tai khoan, va cuoi cung la Ha Noi.
 */
function resolveBranchOptional(req, res, next) {
  req.branch = currentBranchFor(req, req.user) || BRANCHES.HANOI;
  return next();
}

module.exports = {
  BRANCH_COOKIE_NAME,
  resolveBranchOptional,
  BRANCH_COOKIE_MAX_AGE_MS,
  branchCookieOptions,
  currentBranchFor,
  resolveBranch
};
