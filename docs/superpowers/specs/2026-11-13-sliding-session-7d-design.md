# Phiên đăng nhập trượt 7 ngày — thiết kế

Ngày: 2026-11-13 · Nhánh: `claude/extend-session-timeout-63d7e1`

## Vấn đề

Hiện JWT trong cookie `tks_auth` sống **cố định 12 giờ** kể từ lúc đăng nhập (`CONFIG.JWT_EXPIRES_IN = '12h'`, `AUTH_COOKIE_MAX_AGE_MS` viết cứng 12h ở `server/auth/authMiddleware.js`). Không có cơ chế gia hạn, nên sáng nào nhân viên cũng phải đăng nhập lại.

Thêm một lỗi tiềm ẩn: hạn JWT đọc từ biến môi trường, còn hạn cookie viết cứng — đặt `JWT_EXPIRES_IN=30d` thì cookie vẫn chết sau 12h.

## Mục tiêu

- Phiên **trượt**: chỉ hết hạn khi tài khoản **không dùng web 7 ngày liên tục**. Dùng hằng ngày thì không phải đăng nhập lại.
- Một nguồn cấu hình duy nhất cho hạn JWT và hạn cookie.
- Không thêm bảng/migration.

## Ngoài phạm vi

- Đổi/quên mật khẩu đăng xuất các thiết bị khác (cần cột đếm phiên + migration) — để việc sau.
- Trần tối đa tuyệt đối cho phiên (vd 90 ngày).
- Cặp access/refresh token.

Khóa tài khoản / xóa tài khoản vẫn có hiệu lực ngay như hiện nay vì `requireAuth` đối chiếu DB mỗi request.

## Thiết kế

### 1. Cấu hình (`server/config.js`)

- Thêm `AUTH_SESSION_IDLE_DAYS`: đọc `process.env.AUTH_SESSION_IDLE_DAYS`, số nguyên dương, mặc định `7`; giá trị không hợp lệ → `7`.
- Thêm `AUTH_SESSION_TTL_MS = AUTH_SESSION_IDLE_DAYS * 24 * 60 * 60 * 1000`.
- **Bỏ** `JWT_EXPIRES_IN`. Hạn JWT ký bằng `expiresIn: Math.floor(AUTH_SESSION_TTL_MS / 1000)` (giây).

### 2. Module mới `server/auth/authSession.js`

Gom phần cấp phiên đang nằm rải trong `authRoutes.js` để `authMiddleware.js` dùng lại được mà không tạo vòng `require`:

- `publicUser(user)` — chuyển nguyên từ `authRoutes.js` (payload JWT, không chứa `passwordHash`).
- `authCookieOptions()` — `httpOnly`, `sameSite: 'lax'`, `secure` khi production, `path: '/'`, `maxAge: CONFIG.AUTH_SESSION_TTL_MS`.
- `issueSession(res, user)` — ký token từ `publicUser(user)`, ghi cookie `tks_auth`, trả về `publicUser(user)`.
- `SESSION_REFRESH_AFTER_MS = 24h` — ngưỡng gia hạn.
- `shouldRefresh(tokenPayload, now, refreshAfterMs)` — `true` khi `now - iat*1000 >= refreshAfterMs`; thiếu `iat` → `false` (JWT do server ký luôn có `iat`, token không có thì không gia hạn).
- `refreshSession(req, res, user)` — `issueSession` + ghi lại cookie cơ sở (xem mục 3).

`authSession.js` chỉ phụ thuộc `authService` (signToken), `config`, và `branch/branchMiddleware` (tên + options cookie cơ sở). `AUTH_COOKIE_NAME` được định nghĩa ở `authSession.js`; `authMiddleware.js` import và re-export nó (giữ nguyên export hiện có để test/route không phải đổi). `AUTH_COOKIE_MAX_AGE_MS` bị xóa khỏi `authMiddleware.js`.

`authRoutes.js`: `signIn()` gọi `issueSession()`; xóa `cookieOptions()`/`publicUser()` cục bộ, import từ `authSession`. Hành vi các route đăng nhập không đổi (ngoài hạn cookie).

### 3. Gia hạn trong `requireAuth` (`server/auth/authMiddleware.js`)

Trong `createRequireAuth`, **sau** khi đã xác minh `storedUser` tồn tại và `effectiveUser` không bị khóa, trước `next()`:

```
if (shouldRefresh(tokenUser, now())) refreshSession(req, res, effectiveUser)
```

- `refreshSession`: gọi `issueSession(res, effectiveUser)`; đồng thời nếu cookie `tks_branch` của request hợp lệ (`isBranchSelectable`) thì ghi lại cookie đó với hạn mới (giữ nguyên giá trị). Cookie cơ sở không hợp lệ/thiếu thì bỏ qua — `resolveBranch` sẽ tự ghi lại.
- Lỗi khi gia hạn (ký token, ghi cookie) **không** được làm hỏng request: bắt lỗi, `console.warn`, vẫn `next()`.
- `now` và ngưỡng gia hạn nhận qua `dependencies` (mặc định `Date.now`, `SESSION_REFRESH_AFTER_MS`) để test.
- Nhánh `req.effectiveUserResolved && req.user` (đã xử lý trong cùng request) không gia hạn lần hai.
- Token mới mang thông tin user mới nhất (`effectiveUser`), tức vai trò/họ tên/cơ sở cũng được làm mới theo.

Tài khoản bị khóa (403), không tồn tại (401), lỗi DB (5xx) → không bao giờ tới bước gia hạn.

### 4. Cookie cơ sở (`server/branch/branchMiddleware.js`)

`BRANCH_COOKIE_MAX_AGE_MS` lấy `CONFIG.AUTH_SESSION_TTL_MS` thay cho 12h viết cứng, để lựa chọn cơ sở sống cùng phiên.

### 5. `pageGuard`

Không đổi. Mọi trang tải xong đều gọi `/api/auth/me` (qua `shared-nav.js` `authGuard`) → đi qua `requireAuth` → được gia hạn. Tab để mở nhiều ngày vẫn gọi API nên vẫn được gia hạn.

`/api/auth/me` hiện tự `signIn` lại khi vai trò/họ tên/cơ sở đổi — giữ nguyên; nếu cùng request đó `requireAuth` đã gia hạn thì cookie bị ghi hai lần với nội dung tương đương, vô hại.

## Ảnh hưởng triển khai

- Token 12h cũ không bao giờ chạm ngưỡng gia hạn 24h nên không được gia hạn: người đang đăng nhập dùng tiếp đến khi token cũ hết, đăng nhập lại 1 lần là sang chế độ mới. Chấp nhận.
- Kiểm tra biến `JWT_EXPIRES_IN` trên Render (web + worker); nếu có thì xóa vì không còn tác dụng. Muốn đổi số ngày thì đặt `AUTH_SESSION_IDLE_DAYS`.
- Không migration, không đổi API công khai.

## Kiểm thử

Unit test (node --test):

- `authSession`: `authCookieOptions().maxAge === AUTH_SESSION_TTL_MS`; token ký ra có `exp - iat` bằng TTL tính theo giây; `shouldRefresh` đúng ở biên 24h, thiếu `iat` → không gia hạn.
- `authMiddleware`:
  - token `iat` cách hiện tại > 24h, user hợp lệ → response có `Set-Cookie tks_auth` mới, `next()` được gọi.
  - token còn mới (< 24h) → không ghi cookie.
  - user bị khóa → 403, không ghi cookie.
  - user không tồn tại → 401, không ghi cookie.
  - có `tks_branch` hợp lệ → cookie cơ sở được ghi lại cùng giá trị; không hợp lệ → không ghi.
  - lỗi khi ký token → vẫn `next()`.
- `config`: `AUTH_SESSION_IDLE_DAYS` mặc định 7, giá trị rác → 7.
- Chạy lại toàn bộ test sẵn có: `authRoutes.test.js`, `authMiddleware.test.js`, `pageGuard.test.js`, `authService.test.js` và các test dùng `signToken`/`AUTH_COOKIE_NAME` (`overview-endpoints-access.test.js`, `orderLifecycleRoutes.test.js`).

## Tài liệu cần cập nhật

- `README.md`: bảng biến môi trường (`JWT_EXPIRES_IN` → `AUTH_SESSION_IDLE_DAYS`, mặc định 7 ngày trượt), cây thư mục thêm `authSession.js`, mục cập nhật gần nhất.
- `server/.env.example`: thay `JWT_EXPIRES_IN=12h` bằng `AUTH_SESSION_IDLE_DAYS=7`.
- `docs/02-srs/SRS_Dashboard_GoogleSheets.md` FR-08.1 và `docs/03-process/BPMN_Dashboard_GoogleSheets.md`: "mặc định 12 giờ" → "trượt 7 ngày không hoạt động".
- `server/README.md` nếu có mô tả cookie/phiên.
- Comment trong `authRoutes.js` dòng "token song 12h" → cập nhật.

_Cập nhật: 2026-11-13_
