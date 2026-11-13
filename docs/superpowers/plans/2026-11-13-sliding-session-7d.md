# Phiên đăng nhập trượt 7 ngày — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phiên đăng nhập chỉ hết khi tài khoản không dùng web 7 ngày liên tục (thay cho 12 giờ cố định).

**Architecture:** Một cấu hình `AUTH_SESSION_IDLE_DAYS` (mặc định 7) quyết định cả hạn JWT lẫn `maxAge` cookie. Module mới `server/auth/authSession.js` gom việc cấp phiên (`publicUser`, `authCookieOptions`, `issueSession`, `shouldRefresh`, `refreshSession`). `requireAuth` cấp lại phiên (tối đa 1 lần/24h) sau khi đã xác minh user còn tồn tại và không bị khóa.

**Tech Stack:** Node.js (CommonJS), Express, `jsonwebtoken`, `node:test` + `node:assert/strict`.

**Spec:** [docs/superpowers/specs/2026-11-13-sliding-session-7d-design.md](../specs/2026-11-13-sliding-session-7d-design.md)

## Global Constraints

- CommonJS (`require` / `module.exports`), không thêm dependency.
- Không migration, không đổi API công khai, không đổi tên cookie (`tks_auth`, `tks_branch`).
- Hạn phiên mặc định: 7 ngày (`AUTH_SESSION_IDLE_DAYS=7`); ngưỡng gia hạn: 24 giờ.
- Tài khoản bị khóa / không tồn tại / lỗi DB không bao giờ được gia hạn.
- Lỗi khi gia hạn không được làm hỏng request (log `console.warn`, vẫn `next()`).
- Bỏ hẳn `JWT_EXPIRES_IN` khỏi code, `.env.example` và tài liệu.
- Comment trong code viết tiếng Việt không dấu (theo phong cách file hiện có); tài liệu `.md` tiếng Việt có dấu.
- Làm trên nhánh `claude/extend-session-timeout-63d7e1`, không đụng `main`.

## Chuẩn bị môi trường test (làm 1 lần trước Task 1)

Worktree chưa có `node_modules`. Chạy trong `server/`:

```bash
cd server && npm ci
```

Mọi lệnh test dưới đây chạy từ thư mục `server/`. Nếu Node v24 báo không tìm thấy file khi truyền thư mục, truyền đường dẫn file cụ thể như trong plan.

## File Structure

| File | Việc |
|---|---|
| `server/config.js` | Thêm `AUTH_SESSION_IDLE_DAYS`, `AUTH_SESSION_TTL_MS`; bỏ `JWT_EXPIRES_IN` |
| `server/auth/authService.js` | `signToken` ký với hạn `AUTH_SESSION_TTL_MS` |
| `server/auth/authSession.js` (mới) | Cấp / gia hạn phiên, định nghĩa `AUTH_COOKIE_NAME` |
| `server/auth/authSession.test.js` (mới) | Test module trên |
| `server/auth/authRoutes.js` | `signIn` dùng `issueSession`; bỏ `cookieOptions`/`publicUser` cục bộ |
| `server/auth/authMiddleware.js` | Gia hạn phiên trong `createRequireAuth`; re-export `AUTH_COOKIE_NAME` |
| `server/branch/branchMiddleware.js` | Hạn cookie cơ sở = `AUTH_SESSION_TTL_MS` |
| Tài liệu | README, server/README, `.env.example`, SRS, BPMN, CURRENT.md |

---

### Task 1: Cấu hình hạn phiên + hạn JWT

**Files:**
- Modify: `server/config.js:8-12` (thêm helper), `server/config.js:38` (thay `JWT_EXPIRES_IN`)
- Modify: `server/auth/authService.js:24-26`
- Test: `server/auth/authService.test.js` (thêm cuối file)

**Interfaces:**
- Produces: `CONFIG.AUTH_SESSION_IDLE_DAYS` (number, nguyên dương, mặc định 7), `CONFIG.AUTH_SESSION_TTL_MS` (number, ms). `signToken(payload)` giữ nguyên chữ ký, token có `exp - iat === AUTH_SESSION_TTL_MS / 1000`.

- [ ] **Step 1: Viết test thất bại** — thêm cuối `server/auth/authService.test.js`:

```js
const CONFIG = require('../config');

test('signToken: han JWT bang AUTH_SESSION_TTL_MS', () => {
  const decoded = verifyToken(signToken({ id: '1' }));
  assert.equal(decoded.exp - decoded.iat, Math.floor(CONFIG.AUTH_SESSION_TTL_MS / 1000));
});

function loadConfigWithIdleDays(value) {
  const configPath = require.resolve('../config');
  const saved = process.env.AUTH_SESSION_IDLE_DAYS;
  delete require.cache[configPath];
  if (value === undefined) delete process.env.AUTH_SESSION_IDLE_DAYS;
  else process.env.AUTH_SESSION_IDLE_DAYS = value;
  try {
    return require('../config');
  } finally {
    delete require.cache[configPath];
    if (saved === undefined) delete process.env.AUTH_SESSION_IDLE_DAYS;
    else process.env.AUTH_SESSION_IDLE_DAYS = saved;
  }
}

test('config: AUTH_SESSION_IDLE_DAYS mac dinh 7 ngay', () => {
  const cfg = loadConfigWithIdleDays(undefined);
  assert.equal(cfg.AUTH_SESSION_IDLE_DAYS, 7);
  assert.equal(cfg.AUTH_SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000);
});

test('config: AUTH_SESSION_IDLE_DAYS hop le duoc dung', () => {
  const cfg = loadConfigWithIdleDays('30');
  assert.equal(cfg.AUTH_SESSION_IDLE_DAYS, 30);
  assert.equal(cfg.AUTH_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

test('config: AUTH_SESSION_IDLE_DAYS rac -> 7', () => {
  for (const bad of ['', 'abc', '0', '-3', '1.5']) {
    assert.equal(loadConfigWithIdleDays(bad).AUTH_SESSION_IDLE_DAYS, 7, `gia tri ${JSON.stringify(bad)}`);
  }
});

test('config: khong con JWT_EXPIRES_IN', () => {
  assert.equal('JWT_EXPIRES_IN' in loadConfigWithIdleDays(undefined), false);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run: `node --test auth/authService.test.js`
Expected: FAIL ở 5 ca mới — `CONFIG.AUTH_SESSION_TTL_MS` và `AUTH_SESSION_IDLE_DAYS` đang là `undefined`, `JWT_EXPIRES_IN` vẫn còn trong config.

- [ ] **Step 3: Sửa `server/config.js`**

Thêm ngay sau hàm `required` (sau dòng 12):

```js
function positiveIntOr(raw, fallback) {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Phien dang nhap TRUOT: chi het khi khong dung web qua so ngay nay
// (server/auth/authSession.js gia han moi lan dung, toi da 1 lan/ngay).
const AUTH_SESSION_IDLE_DAYS = positiveIntOr(process.env.AUTH_SESSION_IDLE_DAYS, 7);
```

Thay dòng `JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '12h',` bằng:

```js
  // Mot nguon duy nhat cho han JWT va maxAge cookie tks_auth / tks_branch.
  AUTH_SESSION_IDLE_DAYS,
  AUTH_SESSION_TTL_MS: AUTH_SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000,
```

- [ ] **Step 4: Sửa `server/auth/authService.js`** — thay thân `signToken`:

```js
function signToken(payload) {
  return jwt.sign(payload, CONFIG.JWT_SECRET, { expiresIn: Math.floor(CONFIG.AUTH_SESSION_TTL_MS / 1000) });
}
```

- [ ] **Step 5: Chạy test, xác nhận đạt**

Run: `node --test auth/authService.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 6: Kiểm tra không còn chỗ dùng `JWT_EXPIRES_IN` trong code**

Run: `git grep -n "JWT_EXPIRES_IN" -- "server/*.js" "server/**/*.js"`
Expected: chỉ còn comment ở `server/auth/authMiddleware.js:12` và `server/branch/branchMiddleware.js:12` (Task 2–3 xóa).

- [ ] **Step 7: Commit**

```bash
git add server/config.js server/auth/authService.js server/auth/authService.test.js
git commit -m "feat(auth): cau hinh AUTH_SESSION_IDLE_DAYS thay JWT_EXPIRES_IN"
```

---

### Task 2: Module `authSession.js` + chuyển `authRoutes`/`branchMiddleware` sang dùng

**Files:**
- Create: `server/auth/authSession.js`
- Create: `server/auth/authSession.test.js`
- Modify: `server/auth/authRoutes.js:8`, `:26`, `:189-211`, `:243-250`, `:746-748` (comment)
- Modify: `server/auth/authMiddleware.js:11-12`, `:113`
- Modify: `server/branch/branchMiddleware.js:9-12`

**Interfaces:**
- Consumes: `CONFIG.AUTH_SESSION_TTL_MS` (Task 1), `signToken` từ `./authService`, `BRANCH_COOKIE_NAME` + `branchCookieOptions` từ `../branch/branchMiddleware`, `isBranchSelectable(user, branch)` từ `../branch/branches`.
- Produces (từ `server/auth/authSession.js`):
  - `AUTH_COOKIE_NAME = 'tks_auth'`
  - `SESSION_REFRESH_AFTER_MS = 86400000`
  - `publicUser(user) -> { id, username, hoTen, email, vaiTro, coSo, assignedCoSo, boPhan, leaveApprovalDepartments }`
  - `authCookieOptions() -> { httpOnly, sameSite, secure, maxAge, path }`
  - `issueSession(res, user) -> publicUser(user)` (gọi `res.cookie`)
  - `shouldRefresh(tokenPayload, now = Date.now(), refreshAfterMs = SESSION_REFRESH_AFTER_MS) -> boolean`
  - `refreshSession(req, res, user) -> void`
- `authMiddleware` vẫn export `AUTH_COOKIE_NAME` (giá trị lấy từ `authSession`); **xóa** export `AUTH_COOKIE_MAX_AGE_MS`.

- [ ] **Step 1: Viết test thất bại** — tạo `server/auth/authSession.test.js`:

```js
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
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run: `node --test auth/authSession.test.js`
Expected: FAIL — `Cannot find module './authSession'`.

- [ ] **Step 3: Tạo `server/auth/authSession.js`**

```js
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
const SESSION_REFRESH_AFTER_MS = 24 * 60 * 60 * 1000;

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
```

- [ ] **Step 4: Sửa `server/branch/branchMiddleware.js`** — thay dòng 9–12:

```js
const CONFIG = require('../config');
const { BRANCHES, isBranchSelectable, defaultBranch } = require('./branches');

const BRANCH_COOKIE_NAME = 'tks_branch';
const BRANCH_COOKIE_MAX_AGE_MS = CONFIG.AUTH_SESSION_TTL_MS; // song cung phien dang nhap (authSession gia han ca hai)
```

- [ ] **Step 5: Sửa `server/auth/authMiddleware.js`**

Thay dòng 11–12:

```js
const { AUTH_COOKIE_NAME } = require('./authSession');
```

Dòng export cuối file thành:

```js
module.exports = { AUTH_COOKIE_NAME, createRequireAuth, requireAuth, requireRole, requireFeature };
```

- [ ] **Step 6: Sửa `server/auth/authRoutes.js`**

Dòng 8: `const { hashPassword, comparePassword } = require('./authService');`

Dòng 26: `const { AUTH_COOKIE_NAME, requireAuth } = require('./authMiddleware');`
Thêm ngay dưới: `const { publicUser, issueSession } = require('./authSession');`

Xóa nguyên hai hàm `cookieOptions()` (dòng 189–197) và `publicUser(user)` (dòng 199–211).

Thay `signIn` (dòng 243–250):

```js
function signIn(res, user, resetBranch = false) {
  const safeUser = issueSession(res, user);
  if (resetBranch) {
    res.cookie(BRANCH_COOKIE_NAME, defaultBranch(user), branchCookieOptions());
  }
  return safeUser;
}
```

Trong `/api/auth/me`, sửa comment `KHONG dua vao JWT: token song 12h, con quyen...` thành `KHONG dua vao JWT: token song toi 7 ngay (phien truot), con quyen...`.

- [ ] **Step 7: Kiểm tra không còn tham chiếu cũ**

Run: `git grep -n "AUTH_COOKIE_MAX_AGE_MS\|cookieOptions()" -- server ":!server/node_modules"`
Expected: chỉ còn `authCookieOptions()` / `branchCookieOptions()`; không còn `AUTH_COOKIE_MAX_AGE_MS`.

- [ ] **Step 8: Chạy test, xác nhận đạt**

Run: `node --test auth/authSession.test.js auth/authRoutes.test.js auth/authMiddleware.test.js auth/authService.test.js`
Expected: PASS toàn bộ (authRoutes vẫn thấy cookie `tks_auth` khi đăng nhập/đăng ký).

- [ ] **Step 9: Commit**

```bash
git add server/auth/authSession.js server/auth/authSession.test.js server/auth/authRoutes.js server/auth/authMiddleware.js server/branch/branchMiddleware.js
git commit -m "refactor(auth): tach authSession.js, cookie dang nhap va co so song theo AUTH_SESSION_TTL_MS"
```

---

### Task 3: Gia hạn phiên trong `requireAuth`

**Files:**
- Modify: `server/auth/authMiddleware.js` (`createRequireAuth`, khoảng dòng 23–70)
- Test: `server/auth/authMiddleware.test.js` (thêm cuối file)

**Interfaces:**
- Consumes: `shouldRefresh`, `refreshSession`, `SESSION_REFRESH_AFTER_MS`, `AUTH_COOKIE_NAME` từ `./authSession` (Task 2).
- Produces: `createRequireAuth(dependencies)` nhận thêm `dependencies.now` (`() => number`, mặc định `Date.now`), `dependencies.refreshAfterMs` (number, mặc định `SESSION_REFRESH_AFTER_MS`), `dependencies.refreshSession` (mặc định hàm của `authSession`).

- [ ] **Step 1: Viết test thất bại** — thêm cuối `server/auth/authMiddleware.test.js`:

```js
const { SESSION_REFRESH_AFTER_MS } = require('./authSession');
const { BRANCH_COOKIE_NAME } = require('../branch/branchMiddleware');

const NOW = 1_800_000_000_000;
const OLD_IAT = Math.floor((NOW - SESSION_REFRESH_AFTER_MS - 60_000) / 1000);
const FRESH_IAT = Math.floor((NOW - 60_000) / 1000);

function cookieRes() {
  const res = fakeRes();
  res.cookies = [];
  res.cookie = (name, value, options) => { res.cookies.push({ name, value, options }); return res; };
  return res;
}

function slidingMiddleware({ iat, storedUser, resolveUser, refreshSession } = {}) {
  const user = { id: 'u1', username: 'nv1', hoTen: 'NV', vaiTro: 'Nhân viên sale', coSo: 'Hà Nội' };
  return createRequireAuth({
    verifyToken: () => ({ id: 'u1', iat }),
    findUserById: async () => (storedUser === undefined ? user : storedUser),
    resolveUser: resolveUser || (async u => u),
    now: () => NOW,
    ...(refreshSession ? { refreshSession } : {})
  });
}

test('requireAuth: token cap qua 24h -> cap lai tks_auth va giu co so dang chon', async () => {
  const req = { cookies: { [AUTH_COOKIE_NAME]: 'valid', [BRANCH_COOKIE_NAME]: 'Sài Gòn' } };
  const res = cookieRes();
  let nextCalled = false;
  await slidingMiddleware({ iat: OLD_IAT })(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.deepEqual(res.cookies.map(c => c.name), [AUTH_COOKIE_NAME, BRANCH_COOKIE_NAME]);
  assert.equal(res.cookies[1].value, 'Sài Gòn');
});

test('requireAuth: token con moi (< 24h) -> khong ghi cookie', async () => {
  const res = cookieRes();
  let nextCalled = false;
  await slidingMiddleware({ iat: FRESH_IAT })({ cookies: { [AUTH_COOKIE_NAME]: 'valid' } }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.cookies.length, 0);
});

test('requireAuth: tai khoan bi khoa -> 403, khong gia han', async () => {
  const localUserStore = require('./localUserStore');
  const res = cookieRes();
  await slidingMiddleware({
    iat: OLD_IAT,
    resolveUser: async u => ({ ...u, trangThai: localUserStore.LOCKED_STATUS })
  })({ cookies: { [AUTH_COOKIE_NAME]: 'valid' } }, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 403);
  assert.equal(res.cookies.length, 0);
});

test('requireAuth: tai khoan khong ton tai -> 401, khong gia han', async () => {
  const res = cookieRes();
  await slidingMiddleware({ iat: OLD_IAT, storedUser: null })(
    { cookies: { [AUTH_COOKIE_NAME]: 'valid' } }, res, () => assert.fail('must not continue'));
  assert.equal(res.statusCode, 401);
  assert.equal(res.cookies.length, 0);
});

test('requireAuth: loi khi gia han khong lam hong request', async () => {
  const res = cookieRes();
  let nextCalled = false;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await slidingMiddleware({
      iat: OLD_IAT,
      refreshSession: () => { throw new Error('ky token loi'); }
    })({ cookies: { [AUTH_COOKIE_NAME]: 'valid' } }, res, () => { nextCalled = true; });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, null);
});

test('requireAuth: request da xu ly (effectiveUserResolved) -> khong gia han lan hai', async () => {
  const res = cookieRes();
  const req = { cookies: { [AUTH_COOKIE_NAME]: 'valid' }, user: { id: 'u1' }, effectiveUserResolved: true };
  let nextCalled = false;
  await slidingMiddleware({ iat: OLD_IAT })(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(res.cookies.length, 0);
});

test('requireAuth: token that do signToken cap qua 24h duoc gia han (khong mock verify)', async () => {
  const realToken = signToken({ id: 'u1' });
  const middleware = createRequireAuth({
    findUserById: async () => ({ id: 'u1', username: 'nv1', vaiTro: 'Nhân viên sale', coSo: 'Hà Nội' }),
    resolveUser: async u => u,
    now: () => Date.now() + SESSION_REFRESH_AFTER_MS + 1000
  });
  const res = cookieRes();
  await middleware({ cookies: { [AUTH_COOKIE_NAME]: realToken } }, res, () => {});
  assert.deepEqual(res.cookies.map(c => c.name), [AUTH_COOKIE_NAME]);
});
```

- [ ] **Step 2: Chạy test, xác nhận thất bại**

Run: `node --test auth/authMiddleware.test.js`
Expected: FAIL ở 2 ca "token cap qua 24h ..." và "token that do signToken ..." (không có cookie nào được ghi); các ca còn lại có thể đã đạt.

- [ ] **Step 3: Sửa `createRequireAuth` trong `server/auth/authMiddleware.js`**

Dòng import đầu file (thay dòng `const { AUTH_COOKIE_NAME } = require('./authSession');` của Task 2):

```js
const { AUTH_COOKIE_NAME, SESSION_REFRESH_AFTER_MS, shouldRefresh, refreshSession } = require('./authSession');
```

Trong `createRequireAuth`, ngay sau dòng `const ensureTelegramLink = ...`, thêm:

```js
  const now = dependencies.now || Date.now;
  const refreshAfterMs = dependencies.refreshAfterMs ?? SESSION_REFRESH_AFTER_MS;
  const refresh = dependencies.refreshSession || refreshSession;
```

Thay đoạn:

```js
      req.effectiveUserResolved = true;
      return next();
```

bằng:

```js
      req.effectiveUserResolved = true;
      // Phien TRUOT: user con ton tai + khong bi khoa va token da cap qua 24h
      // thi cap lai du han (authSession). Loi o day khong duoc chan request.
      if (shouldRefresh(tokenUser, now(), refreshAfterMs)) {
        try {
          refresh(req, res, effectiveUser);
        } catch (refreshErr) {
          console.warn('[Auth] Khong gia han duoc phien dang nhap:', refreshErr.message);
        }
      }
      return next();
```

- [ ] **Step 4: Chạy test, xác nhận đạt**

Run: `node --test auth/authMiddleware.test.js auth/authSession.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add server/auth/authMiddleware.js server/auth/authMiddleware.test.js
git commit -m "feat(auth): gia han phien dang nhap truot trong requireAuth (toi da 1 lan/ngay)"
```

---

### Task 4: Hồi quy rộng + tài liệu

**Files:**
- Modify: `server/.env.example:79-80`
- Modify: `README.md:135` (bảng biến môi trường) + thêm mục mới cuối file
- Modify: `server/README.md:279`
- Modify: `docs/02-srs/SRS_Dashboard_GoogleSheets.md:275` (FR-08.1)
- Modify: `docs/03-process/BPMN_Dashboard_GoogleSheets.md:242`
- Modify: `CURRENT.md` (thêm 1 dòng cuối mục "Đang dở / chờ")

**Interfaces:** không có (chỉ tài liệu + chạy test).

- [ ] **Step 1: Chạy toàn bộ test có dùng auth/branch**

Run:
```bash
node --test auth/*.test.js branch/*.test.js test/overview-endpoints-access.test.js shipment/orderLifecycleRoutes.test.js vatDraft/vatDraftRoutes.test.js test/frontend/branch-switcher.test.js
```
Expected: PASS, 0 lỗi mới. Nếu có ca lỗi, chạy lại đúng file đó trên commit gốc `6d49ed4f` (`git worktree add <thư-mục-tạm> 6d49ed4f`, không dùng `git stash`) để biết lỗi có sẵn từ trước hay do thay đổi này — chỉ lỗi mới mới phải sửa.

- [ ] **Step 2: Chạy toàn bộ bộ test server**

Run: `npm test` (trong `server/`)
Expected: không có lỗi mới so với trước thay đổi. Ghi lại số đạt/lỗi để đưa vào mô tả PR.

- [ ] **Step 3: `server/.env.example`** — thay hai dòng 79–80:

```
# Tuy chon — so ngay KHONG dung web thi phien dang nhap het han (phien truot,
# moi lan dung duoc gia han, toi da 1 lan/ngay). Mac dinh 7.
AUTH_SESSION_IDLE_DAYS=7
```

- [ ] **Step 4: `README.md`**

Dòng 135 thay bằng:

```
| `JWT_SECRET`, `AUTH_SESSION_IDLE_DAYS` | Ký phiên đăng nhập (bắt buộc) / số ngày không dùng web thì phiên hết hạn (mặc định `7`, phiên trượt) |
```

Thêm cuối file:

```markdown
## Phiên đăng nhập trượt 7 ngày (13/11/2026)

Trước đây phiên (cookie `tks_auth`) sống cố định 12 giờ nên ngày nào cũng phải đăng nhập lại. Nay phiên **trượt**: `requireAuth` cấp lại token đủ hạn khi token đã cấp quá 24 giờ và tài khoản vẫn tồn tại, không bị khóa; chỉ khi không dùng web `AUTH_SESSION_IDLE_DAYS` ngày (mặc định 7) mới phải đăng nhập lại. Cookie cơ sở `tks_branch` sống và gia hạn cùng phiên. Module mới `server/auth/authSession.js` (cấp/gia hạn phiên). Bỏ biến `JWT_EXPIRES_IN` — **xóa biến này trên Render nếu có**. Không migration. Đổi mật khẩu chưa đăng xuất thiết bị khác (việc sau).

Cập nhật gần nhất: 13/11/2026.
```

- [ ] **Step 5: `server/README.md:279`** — thay `JWT cookie \`tks_auth\`;` bằng `JWT cookie \`tks_auth\`, phiên trượt: hết hạn sau \`AUTH_SESSION_IDLE_DAYS\` ngày không dùng (mặc định 7), \`requireAuth\` gia hạn tối đa 1 lần/ngày (\`auth/authSession.js\`);`. Cập nhật dòng "Cập nhật gần nhất" cuối file thành 13/11/2026 nếu có.

- [ ] **Step 6: SRS FR-08.1 (`docs/02-srs/SRS_Dashboard_GoogleSheets.md:275`)** — thay `(mặc định 12 giờ, \`httpOnly\`)` bằng `(\`httpOnly\`, phiên trượt: hết hạn sau 7 ngày không dùng — \`AUTH_SESSION_IDLE_DAYS\`, tự gia hạn tối đa 1 lần/ngày)`. Cập nhật ngày cuối tài liệu.

- [ ] **Step 7: BPMN (`docs/03-process/BPMN_Dashboard_GoogleSheets.md:242`)** — thay `(mặc định 12 giờ)` bằng `(phiên trượt 7 ngày không dùng)`. Cập nhật ngày cuối tài liệu.

- [ ] **Step 8: `CURRENT.md`** — thêm cuối mục "Đang dở / chờ":

```
- [ ] 13/11 — Phiên đăng nhập trượt 7 ngày (nhánh `claude/extend-session-timeout-63d7e1`, không migration) — merge + deploy, xóa biến `JWT_EXPIRES_IN` trên Render (web + worker) nếu có
```

- [ ] **Step 9: Kiểm tra không còn "12 giờ"/`JWT_EXPIRES_IN` trong tài liệu đang dùng**

Run: `git grep -n "JWT_EXPIRES_IN\|tks_auth.*12 giờ\|mặc định 12 giờ" -- ":!docs/archive" ":!docs/superpowers"`
Expected: không còn kết quả (trừ dòng CURRENT.md nhắc xóa biến trên Render và đoạn README mới nói "Bỏ biến `JWT_EXPIRES_IN`").

- [ ] **Step 10: Commit**

```bash
git add README.md server/README.md server/.env.example docs/02-srs/SRS_Dashboard_GoogleSheets.md docs/03-process/BPMN_Dashboard_GoogleSheets.md CURRENT.md
git commit -m "docs(auth): phien dang nhap truot 7 ngay, bo JWT_EXPIRES_IN"
```

- [ ] **Step 11: (máy local, không commit) cập nhật graphify**

Run: `graphify update .` (ở gốc worktree). Bỏ qua nếu lệnh không có trên máy và ghi chú lại.

---

## Kiểm chứng thủ công sau deploy (ghi vào mô tả PR, không thuộc task code)

- Đăng nhập, mở DevTools → Application → Cookies: `tks_auth` có Expires ≈ +7 ngày.
- Hôm sau mở web (cùng trình duyệt): vẫn vào được, `tks_auth` Expires dời thêm ≈ +7 ngày tính từ hôm nay.
