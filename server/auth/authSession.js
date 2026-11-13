// ==========================================
// AUTH SESSION — cap va gia han phien dang nhap (cookie httpOnly tks_auth chua JWT).
// Phien TRUOT: requireAuth goi refreshSession toi da 1 lan/ngay khi tai khoan con
// dung web, moi lan cap lai du han CONFIG.AUTH_SESSION_TTL_MS. Bo web qua han do
// (mac dinh 7 ngay) thi JWT het han va phai dang nhap lai.
// ==========================================
'use strict';

const CONFIG = require('../config');
const { signToken } = require('./authService');
const { BRANCH_COOKIE_NAME, branchCookieOptions } = require('../branch/branchMiddleware');
const { isBranchSelectable } = require('../branch/branches');

const AUTH_COOKIE_NAME = 'tks_auth';
// Gia han toi da 1 lan/ngay, nhung khong bao gio tre hon nua TTL: TTL ngan (vd 1 ngay)
// van phai truot, neu khong token da het han truoc khi kip gia han.
const SESSION_REFRESH_AFTER_MS = Math.min(24 * 60 * 60 * 1000, Math.floor(CONFIG.AUTH_SESSION_TTL_MS / 2));

/** Payload JWT + du lieu tra ve client. KHONG duoc chua passwordHash. */
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    hoTen: user.hoTen,
    email: user.email || '',
    vaiTro: user.vaiTro,
    coSo: user.coSo,
    assignedCoSo: user.assignedCoSo ?? user.coSo ?? '',
    boPhan: user.boPhan || '',
    leaveApprovalDepartments: user.leaveApprovalDepartments || []
  };
}

function authCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: CONFIG.AUTH_SESSION_TTL_MS,
    path: '/'
  };
}

function issueSession(res, user) {
  const safeUser = publicUser(user);
  res.cookie(AUTH_COOKIE_NAME, signToken(safeUser), authCookieOptions());
  return safeUser;
}

/** Token da cap qua refreshAfterMs thi cap lai. Thieu iat (khong phai token server ky) -> khong gia han. */
function shouldRefresh(tokenPayload, now = Date.now(), refreshAfterMs = SESSION_REFRESH_AFTER_MS) {
  const iat = tokenPayload && tokenPayload.iat;
  if (!Number.isFinite(iat)) return false;
  return now - iat * 1000 >= refreshAfterMs;
}

/**
 * Gia han phien: cap lai tks_auth va keo dai cookie co so dang chon (neu hop le)
 * de lua chon co so khong bi tra ve mac dinh truoc khi phien het.
 */
function refreshSession(req, res, user) {
  issueSession(res, user);
  const branch = req.cookies && req.cookies[BRANCH_COOKIE_NAME];
  if (branch && isBranchSelectable(user, branch)) {
    res.cookie(BRANCH_COOKIE_NAME, branch, branchCookieOptions());
  }
}

module.exports = {
  AUTH_COOKIE_NAME,
  SESSION_REFRESH_AFTER_MS,
  publicUser,
  authCookieOptions,
  issueSession,
  shouldRefresh,
  refreshSession
};
