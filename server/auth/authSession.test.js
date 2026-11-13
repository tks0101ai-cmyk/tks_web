'use strict';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const CONFIG = require('../config');
const { verifyToken } = require('./authService');
const {
  AUTH_COOKIE_NAME,
  SESSION_REFRESH_AFTER_MS,
  publicUser,
  authCookieOptions,
  issueSession,
  shouldRefresh,
  refreshSession
} = require('./authSession');
const { BRANCH_COOKIE_NAME, BRANCH_COOKIE_MAX_AGE_MS } = require('../branch/branchMiddleware');

function fakeRes() {
  const res = { cookies: [] };
  res.cookie = (name, value, options) => { res.cookies.push({ name, value, options }); return res; };
  return res;
}

const USER = {
  id: 'u1', username: 'nv1', hoTen: 'Nhân Viên', vaiTro: 'Nhân viên sale', coSo: 'Hà Nội',
  passwordHash: 'bi-mat', email: 'nv1@example.com'
};

test('authSession: ten cookie va nguong gia han', () => {
  assert.equal(AUTH_COOKIE_NAME, 'tks_auth');
  assert.equal(SESSION_REFRESH_AFTER_MS, 24 * 60 * 60 * 1000);
});

test('SESSION_REFRESH_AFTER_MS: TTL 1 ngay -> nguong gia han bang nua TTL (12h) de van truot', () => {
  const paths = ['../config', './authSession', './authService', '../branch/branchMiddleware'].map(p => require.resolve(p));
  const saved = process.env.AUTH_SESSION_IDLE_DAYS;
  const clear = () => paths.forEach(p => { delete require.cache[p]; });
  clear();
  process.env.AUTH_SESSION_IDLE_DAYS = '1';
  try {
    assert.equal(require('./authSession').SESSION_REFRESH_AFTER_MS, 12 * 60 * 60 * 1000);
  } finally {
    if (saved === undefined) delete process.env.AUTH_SESSION_IDLE_DAYS;
    else process.env.AUTH_SESSION_IDLE_DAYS = saved;
    clear();
    paths.forEach(p => { try { require(p); } catch (_) { /* nap lai ban mac dinh */ } });
  }
});

test('authCookieOptions: maxAge bang AUTH_SESSION_TTL_MS, httpOnly, path /', () => {
  const options = authCookieOptions();
  assert.equal(options.maxAge, CONFIG.AUTH_SESSION_TTL_MS);
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'lax');
  assert.equal(options.path, '/');
});

test('cookie co so song cung phien dang nhap', () => {
  assert.equal(BRANCH_COOKIE_MAX_AGE_MS, CONFIG.AUTH_SESSION_TTL_MS);
});

test('publicUser: khong lo passwordHash', () => {
  const safe = publicUser(USER);
  assert.equal('passwordHash' in safe, false);
  assert.equal(safe.username, 'nv1');
  assert.equal(safe.assignedCoSo, 'Hà Nội');
});

test('issueSession: ghi cookie tks_auth chua JWT hop le, tra ve publicUser', () => {
  const res = fakeRes();
  const safe = issueSession(res, USER);
  assert.equal(res.cookies.length, 1);
  assert.equal(res.cookies[0].name, AUTH_COOKIE_NAME);
  assert.deepEqual(res.cookies[0].options, authCookieOptions());
  const decoded = verifyToken(res.cookies[0].value);
  assert.equal(decoded.id, 'u1');
  assert.equal('passwordHash' in decoded, false);
  assert.deepEqual(safe, publicUser(USER));
});

test('shouldRefresh: bien 24h va thieu iat', () => {
  const iat = 1_700_000_000;
  const issuedMs = iat * 1000;
  assert.equal(shouldRefresh({ iat }, issuedMs + SESSION_REFRESH_AFTER_MS - 1), false);
  assert.equal(shouldRefresh({ iat }, issuedMs + SESSION_REFRESH_AFTER_MS), true);
  assert.equal(shouldRefresh({ iat }, issuedMs + 1000, 500), true);
  assert.equal(shouldRefresh({}, issuedMs + 10 * SESSION_REFRESH_AFTER_MS), false);
  assert.equal(shouldRefresh(null, issuedMs), false);
});

test('refreshSession: cap lai tks_auth va giu nguyen co so dang chon hop le', () => {
  const res = fakeRes();
  refreshSession({ cookies: { [BRANCH_COOKIE_NAME]: 'Sài Gòn' } }, res, USER);
  assert.deepEqual(res.cookies.map(c => c.name), [AUTH_COOKIE_NAME, BRANCH_COOKIE_NAME]);
  assert.equal(res.cookies[1].value, 'Sài Gòn');
  assert.equal(res.cookies[1].options.maxAge, CONFIG.AUTH_SESSION_TTL_MS);
});

test('refreshSession: cookie co so thieu hoac sai -> chi cap lai tks_auth', () => {
  for (const cookies of [{}, { [BRANCH_COOKIE_NAME]: 'Đà Nẵng' }, undefined]) {
    const res = fakeRes();
    refreshSession({ cookies }, res, USER);
    assert.deepEqual(res.cookies.map(c => c.name), [AUTH_COOKIE_NAME]);
  }
});
