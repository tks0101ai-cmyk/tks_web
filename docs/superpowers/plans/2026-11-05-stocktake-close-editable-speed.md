# Kiểm kê: đóng đợt vẫn sửa được, sửa file xuất, luật tên, tăng tốc — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Đóng đợt chốt dữ liệu KiotViet nhưng vẫn sửa được số đếm; file xuất đúng định dạng và có cột Đơn; gom mọi khách có từ `team`; nút Cập nhật đơn Kiot và bảng Sài Gòn nhanh hơn.

**Architecture:** Bảng mới `stocktake_session_lines` giữ dòng đơn lúc đóng, `loadInputs` chọn nguồn theo `lines_frozen_at` rồi dùng chung `buildBoard`; ghi trên đợt đã chốt cập nhật lại `stocktake_session_results` theo mã bị đụng. Ghi đơn gộp một `INSERT`, sắp dòng ngoài giao dịch, cache số đối chiếu, gộp tải lại, đo thời gian. Spec: `docs/superpowers/specs/2026-11-05-stocktake-close-editable-speed-design.md`.

**Tech Stack:** Node.js CommonJS, Express, Postgres (PGlite trong test), ExcelJS, `node:test`, vanilla JS/CSS.

## Global Constraints

- Migration `0114` có file gỡ trong `db/rollbacks/`; chỉ áp DB thật khi người dùng đồng ý, trước khi deploy.
- Không ghi lên DB thật hoặc KiotViet khi kiểm thử.
- Đợt nạp từ sheet và đợt không có `lines_frozen_at` vẫn chỉ đọc.
- Giao diện hỗ trợ sáng/tối và 375px. Tăng `?v=` khi đổi file tĩnh.
- Chạy test từ `server/`: `node --test --test-concurrency=1 <file>`.

---

### Task 1: File xuất, cột Đơn, luật tên

**Files:** `server/stocktake/stocktakeExport.js`, `stocktakeService.js`, `stocktakeOrderRefresh.js`, `public/stocktake/index.html`; test `stocktakeExport.test.js`, `stocktakeOrderRefresh.test.js`, `stocktakeService.test.js`.

**Interfaces:** `numberFormat(value) -> '#,##0' | '#,##0.##'`; `statsHeaders()` thêm `Đơn` ở cuối.

- [ ] Test hỏng: `numberFormat(60) === '#,##0'`, `numberFormat(1.5) === '#,##0.##'`; ô Số lượng trong file đọc lại đúng `numFmt`; cột Đơn có `DH…` và `Thêm tay`; Xuất Excel cột Tổng kiểm dùng cùng quy tắc. `isTeamOrder` và SQL: nhận `TEAM 1`, `TEAM1`, `KH Team Hàng Lỗi`, `team-5`; bỏ `Steam`, `Teamwork`.
- [ ] Chạy, xác nhận hỏng.
- [ ] Cài đặt:

```js
const numberFormat = value => (Number.isInteger(Number(value)) ? '#,##0' : NUMBER);
```

`createStocktakeWorkbook`, `createStatsWorkbook` gán `cell.numFmt = numberFormat(value)` cho cột số. `TEAM_NAME_MATCH_SQL` dùng `'(^|[^[:alpha:]])team([^[:alpha:]]|$)'`; `TEAM_ORDER_NAME = /(^|[^\p{L}])team([^\p{L}]|$)/iu`. Sửa chữ trong hộp Tạo đợt.
- [ ] Chạy lại, xanh. Commit `fix(kiem-ke): bo dau cham thua, them cot Don, gom moi khach co tu team`.

### Task 2: Tăng tốc phía máy chủ

**Files:** `server/kiotvietSync/entities/orders.js`, `documentEntityFactory.js`, `server/stocktake/stocktakeOrderRefresh.js`, `stocktakeService.js`, `stocktakeRoutes.js`; test `kiotvietSync/entities/orders.test.js`, `stocktakeOrderRefresh.test.js`, `stocktakeService.test.js`, `stocktakeRoutes.test.js`.

**Interfaces:** entity có `prepareItems(branch, items)`; `upsertPage(client, branch, items, { prepared })`.

- [ ] Test hỏng:
  - Đơn 3 dòng ghi đúng 1 câu `INSERT INTO order_details`, `line_no` 0, 1, 2.
  - `upsertPage(..., { prepared: true })` không gọi sắp dòng.
  - Refresher gọi `prepareItems` trước `BEGIN`.
  - Đợt đối chiếu đang mở: 2 lần `getBoard` chỉ đọc `TEAM_LINES_SQL` của đợt kia 1 lần; ghi vào đợt kia thì đọc lại.
  - Route có `Server-Timing`, `/events` không có.
- [ ] Chạy, xác nhận hỏng.
- [ ] Cài đặt: `batchDetails: true` trong `orders.js`; factory bọc `prepareItems`, bỏ qua khi `prepared`; refresher dùng `timedOperation('kiotFetch' | 'sortLines' | 'writeOrders', ...)`; `counterpartResults` đợt đang mở qua `cached('counterpart:' + other.id, ...)`; `withTransaction` xóa cache `counterpart:<sessionId>` sau `COMMIT`; `refreshOrders` cũng xóa khi có đơn đổi; `closeSession` xóa cache của đợt đối chiếu trước khi chụp. Trong `stocktakeRoutes`:

```js
router.use('/api/stocktake', (req, res, next) => (req.path.endsWith('/events') ? next() : startTiming(req, res, next)), ...);
```
- [ ] Chạy lại, xanh. Commit `perf(kiem-ke): ghi don gop, sap dong ngoai giao dich, cache doi chieu, do thoi gian`.

### Task 3: Migration và chốt dòng khi đóng đợt

**Files:** tạo `server/db/migrations/0114_stocktake_frozen_lines.sql`, `server/db/rollbacks/0114_stocktake_frozen_lines.down.sql`; sửa `stocktakeService.js`, `stocktakeCompute.js`, `db/rollbacks/stocktakeRollback.test.js`, `stocktakeService.test.js`, fixture các test dùng `0109` (thêm `0114`).

**Interfaces:** `shapeSession` thêm `linesFrozenAt`, `frozen`; `toResults` thêm `prevDiffAuto`, `otherDiffAuto`.

- [ ] Test hỏng theo mục Kiểm thử của spec (đóng rồi đổi đơn, khách, tồn không ảnh hưởng; sửa và thêm dòng sau khi đóng; `stocktake_session_results` đổi; KK trước của đợt mở thấy số mới; số nhập tay; đợt nạp sheet, đợt thiếu `lines_frozen_at`, đợt hủy vẫn chặn; rollback).
- [ ] Chạy, xác nhận hỏng.
- [ ] Cài đặt:

```js
const usesSnapshot = session => Boolean(session.linesFrozenAt);
// loadInputs: usesSnapshot -> dong tu stocktake_session_lines, products/previous/counterpart tu stocktake_session_results.
// getBoard: closed && !usesSnapshot -> closedBoard; con lai loadInputs + buildBoard.
// openSessionForWrite(client, ctx, id, { allowFrozen }) cho saveLine, addLine, saveNote, saveCells.
// syncResults(client, session, codes): doc dong + phan sua cua cac ma, buildBoard, upsert counted, diff_qty, diff_value.
```

`closeSession` ghi `inputs.lines` vào `stocktake_session_lines` và đặt `lines_frozen_at = now()`; `prev_diff`, `other_diff` lưu số tự lấy.
- [ ] Chạy lại, xanh. Commit `feat(kiem-ke): dong dot chot dong don va ton, van sua duoc sau khi dong`.

### Task 4: Giao diện

**Files:** `server/public/stocktake/stocktake.js`, `stocktakeGrid.js`, `index.html`; test `stocktakeGrid.test.js`.

**Interfaces:** `Grid.trailingThrottle(run, gapMs, { now, setTimer, clearTimer }) -> { trigger(), cancel() }`.

- [ ] Test hỏng: gọi nhiều lần trong 3 giây chỉ chạy 1 lần, sau khi chạy lại trigger thì chờ đủ khoảng cách, `cancel` bỏ lần đang chờ.
- [ ] Cài đặt: SSE dùng `trailingThrottle(() => loadBoard({ background: true }), 3000)`; tab ẩn đặt `live.dirty`, `visibilitychange` trigger. `bindRefreshOrders` nhả nút ngay khi API trả về, `AbortController` 60 giây, tải bảng nền sau. `editable()`, `canWrite()`, `stLinesSection`, dòng thông tin dùng `session.frozen`, `session.linesFrozenAt`. Sửa hộp xác nhận Đóng đợt. Tăng `?v=`.
- [ ] Chạy test, `node --check`. Commit `feat(kiem-ke): giao dien dot da chot, nut tra loi som, gop tai lai`.

### Task 5: Xem trên trình duyệt, tài liệu

- [ ] Server PGlite: đóng đợt, sửa ô, sửa dòng, thêm dòng, xóa khách trong DB mẫu rồi tải lại, không còn nút thừa, nút trả lời sớm, sáng/tối, 375px, tài khoản chỉ xem.
- [ ] Cập nhật `README.md`, `server/README.md`, `server/db/SCHEMA.md`, `docs/04-planning/implementation_plan.md`, SRS, BRD, `CURRENT.md`.
- [ ] `npm test`, so với `origin/main`. `graphify update .`. Commit `docs(kiem-ke): cap nhat tai lieu dong dot va tang toc`.
