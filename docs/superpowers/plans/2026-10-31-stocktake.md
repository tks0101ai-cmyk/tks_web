# Kế hoạch triển khai: Kiểm kê (đối chiếu Hà Nội)

Spec: [2026-10-31-stocktake-design.md](../specs/2026-10-31-stocktake-design.md). Nhánh `claude/inventory-feature-analysis-1ab808` (đã gộp `origin/main` 31/10, migration cuối là `0102`).

**Mục tiêu:** trang `/stocktake/` cho Quản lý và Thắng, Quân, Hưng: tạo đợt kiểm kê Hà Nội, xem bảng đối chiếu số đếm từ đơn TEAM với tồn KiotViet, sửa số đếm, giao người kiểm lại, ghi lý do, đóng đợt.

**Mẫu bám theo:** `server/stockPositions/` (router có `dependencies` để test, `handle()` trả lỗi 4xx kèm `latest`, khóa lạc quan `version`, lịch sử chỉ thêm, SSE qua `dashboardRollupEvents`) và `public/vt-positions/`.

**Không làm trong kế hoạch này:** Sài Gòn, chia team, thưởng/phạt. Prototype `public/prototypes/order-picking/stocktake.js` (tồn đầu theo vị trí cho soạn hàng) là chuyện khác, không dùng chung.

**Lưu ý:** server local chạy theo cấu hình chỉ đọc (`.claude/launch.json`). Migration `0103` chỉ áp lên DB thật khi bạn đồng ý.

---

## Bước 1 — Migration `0103_stocktake.sql`

File: `server/db/migrations/0103_stocktake.sql`.

- `stocktake_sessions`: `id BIGSERIAL`, `branch TEXT CHECK (branch IN ('hanoi','saigon'))`, `name`, `date_from DATE`, `date_to DATE`, `status TEXT CHECK (status IN ('open','closed'))`, `source TEXT DEFAULT 'web'` (`'sheet_import'` cho đợt T10), `created_by_user_id`, `created_by_name`, `created_at`, `closed_by_*`, `closed_at`, `version INT`.
- `stocktake_line_edits`: `session_id FK`, khóa dòng gốc `(order_id, line_no)` NULL cho dòng thêm tay; `quantity NUMERIC`, `spec`, `zone`, `team`, `product_code` (dòng tay), `removed BOOLEAN`; `version`, `updated_by_*`, `updated_at`. Unique `(session_id, order_id, line_no)` cho dòng gốc.
- `stocktake_code_notes`: PK `(session_id, product_code)`; `status_text`, `reason_text`, `recheck_employee_id FK hr_employees`; `version`, `updated_by_*`, `updated_at`.
- `stocktake_product_tags`: PK `(branch, product_code)`; `cluster TEXT`, `is_combo BOOLEAN`; `version`, `updated_by_*`, `updated_at`.
- `stocktake_history`: `id`, `session_id`, `product_code`, `action` (CHECK danh sách cố định), `before JSONB`, `after JSONB`, `actor_*`, `created_at`. Trigger chặn UPDATE/DELETE như `stock_position_history`.
- `stocktake_session_results`: PK `(session_id, product_code)`; `name`, `counted NUMERIC`, `stock NUMERIC`, `cost NUMERIC`, `diff_qty NUMERIC`, `diff_value NUMERIC`.
- Chỉ mục hỗ trợ gom đơn TEAM: kiểm `EXPLAIN` truy vấn ở bước 3 trên dữ liệu thật (chỉ đọc) rồi mới quyết định có thêm chỉ mục không.

Test: `db/migrate.integration.test.js` vẫn xanh; thêm test bảng lịch sử từ chối UPDATE.

## Bước 2 — Quyền

File: `server/auth/featureRegistry.js` (+ test).

- `stocktake.view` — "Xem kiểm kê", `MANAGER_ONLY`, `forbiddenRoles: [KHACH]`.
- `stocktake.edit` — "Sửa kiểm kê (cần xem)", `MANAGER_ONLY`, `requires: 'stocktake.view'`.
- `stocktake.close` — "Đóng đợt / nạp số liệu sheet (cần xem)", `MANAGER_ONLY`, không thuộc nhóm cấp lẻ mặc định. Admin không cấp quyền này cho Thắng/Quân/Hưng, nên chỉ Quản lý bấm được.
- Thêm `groupKey: 'stocktake'` và nhãn nhóm; đăng ký trang `/stocktake/` với `pageGuard` và `shared-nav.js`.

Test: quyền mặc định theo vai trò, `requires`, Khách bị chặn.

## Bước 3 — Bộ tính đối chiếu (thuần, không DB)

File: `server/stocktake/stocktakeCompute.js` (+ `.test.js`).

Đầu vào: dòng đếm gốc, phần sửa, danh sách sản phẩm (tồn, giá vốn, tên), vị trí, tag, ghi chú, kết quả đợt trước. Đầu ra theo mã:
`code, name, counted, stock, cost, diffQty, diffValue, cluster, clusterDiff, isCombo, prevDiff, latestPosition, note, forgotten, lines[]`.

Quy tắc phải có test:
- Đơn đã hủy vẫn được tính.
- Dòng sửa đè SL/quy cách/khu; dòng `removed` bị loại; dòng thêm tay được cộng.
- Danh sách mã = có đếm ∪ tồn ≠ 0; `forgotten` khi tồn ≠ 0 mà không có dòng đếm.
- `clusterDiff` = tổng `diffQty` các mã cùng cụm.
- Mã hàng so khớp không phân biệt hoa/thường, bỏ khoảng trắng hai đầu.
- Số lượng dùng chuỗi `NUMERIC` → số an toàn, không làm tròn sai.

## Bước 4 — Repository và service

Files: `server/stocktake/stocktakeRepository.js`, `server/stocktake/stocktakeService.js` (+ test với DB giả như `stockPositionsService.test.js`).

- `listTeamLines(branch, dateFrom, dateTo)`: `orders` JOIN `order_details`, khách có tên bắt đầu `TEAM` (lấy từ `raw->>'customerName'`, kiểm tên trường trên dữ liệu thật), ngày theo giờ VN; lấy ghi chú đơn (khu) và ghi chú dòng (quy cách) từ `raw`.
- Đọc `products` (tồn, giá vốn theo cơ sở), `stock_positions` (vị trí gần nhất, `branch = 'HN'`), `hr_employees` đang làm.
- Service: `listSessions`, `createSession`, `getBoard(sessionId)` (đợt mở → tính trực tiếp; đợt đóng → đọc `session_results`), `saveLineEdit`, `addManualLine`, `saveCodeNote`, `saveProductTag`, `getCodeHistory`, `closeSession`.
- Mọi lệnh ghi: khóa dòng, so `version`; lệch thì lỗi 409 `STOCKTAKE_CONFLICT` kèm `latest` (bản mới, người sửa, giờ sửa). Ghi lịch sử trong cùng transaction. Đợt đã đóng: lỗi 409 `STOCKTAKE_CLOSED`.
- `closeSession`: tính bảng một lần, ghi toàn bộ vào `session_results`, đổi trạng thái, trong một transaction.
- Kết quả `getBoard` của đợt mở cache ngắn theo đợt, xóa cache khi có ghi hoặc khi job đồng bộ báo đơn/sản phẩm đổi.

## Bước 5 — Routes và SSE

Files: `server/stocktake/stocktakeRoutes.js`, `server/stocktake/stocktakeEvents.js`; gắn trong `server/routes.js`.

| Method | Đường dẫn | Quyền |
|---|---|---|
| GET | `/api/stocktake/sessions` | view |
| POST | `/api/stocktake/sessions` | edit |
| GET | `/api/stocktake/sessions/:id/board` | view |
| GET | `/api/stocktake/sessions/:id/events` (SSE) | view |
| PATCH | `/api/stocktake/sessions/:id/lines/:orderId/:lineNo` | edit |
| POST | `/api/stocktake/sessions/:id/lines` (dòng tay) | edit |
| PUT | `/api/stocktake/sessions/:id/codes/:code/note` | edit |
| PUT | `/api/stocktake/tags/:branch/:code` | edit |
| GET | `/api/stocktake/sessions/:id/codes/:code/history` | view |
| POST | `/api/stocktake/sessions/:id/close` | close |
| POST | `/api/stocktake/import-sheet` (đợt T10) | close |
| GET | `/api/stocktake/sessions/:id/export` | view |

SSE bắn `stocktake-changed {sessionId}` sau mỗi lệnh ghi; client tự tải lại bảng. Test router theo mẫu `stockPositionsRoutes.test.js`: quyền, 409 kèm `latest`, đợt đóng chỉ đọc.

## Bước 6 — Nạp đợt T10 (3/10)

File: `server/stocktake/stocktakeSheetImport.js` (+ test với file mẫu nhỏ).

- Đọc tab `KIỂM KÊ HN T10` bằng service account sẵn có (chỉ đọc), lấy mã, tên, tổng kiểm, tồn, giá vốn, SL chênh, Cụm SP, Combo.
- Tạo đợt `closed`, `source = 'sheet_import'`, ghi `session_results`; nạp Cụm SP/Combo vào `stocktake_product_tags`.
- Chạy một lần; gọi lại cho cùng sheet thì báo đã nạp, không tạo trùng.

## Bước 7 — Giao diện `/stocktake/`

Files: `server/public/stocktake/index.html`, `stocktake.js`, `stocktake.css` (+ test JSDOM trong `server/test/frontend/`).

- Danh sách đợt: tạo đợt (tên, từ ngày–đến ngày), trạng thái, nút Đóng đợt (chỉ khi có `canClose`).
- Bảng đối chiếu dùng `table-controls.js`: Mã, Tên, Vị trí gần nhất, Tổng kiểm, Tồn KIOT, SL chênh, Giá trị chênh, Cụm SP, Chênh cụm, Combo, KK trước sai, Người kiểm lại, Trạng thái, Chi tiết lý do, Người sửa cuối.
- Bộ lọc: chỉ mã lệch, Quên KK, người kiểm lại, trạng thái, cụm. Bảng đếm số mã theo người kiểm lại.
- Mở một mã: các dòng đếm theo team/khu/quy cách (sửa, bỏ, thêm dòng), lịch sử.
- Sửa tại chỗ gửi `version`; nhận 409 thì hiện "<tên> vừa sửa mã này lúc <giờ>", cho xem bản mới rồi lưu lại.
- Gợi ý Trạng thái/Lý do từ các giá trị đã dùng trong đợt; Người kiểm lại chọn từ danh bạ.
- Sáng/tối theo token trong `shared.css`; dùng được trên điện thoại.

## Bước 8 — Đối chiếu với sheet và kiểm tra trên trình duyệt

- Script chỉ đọc so số đếm web của khoảng ngày 3/10 với cột TỔNG KIỂM của sheet T10. Mong đợi khoảng 1.650 mã khớp, phần lệch giải thích được bằng sửa tay sau kiểm lại.
- Chạy server local (chỉ đọc) và mở `/stocktake/` để kiểm tra bảng, bộ lọc, sáng/tối, di động. Lệnh ghi chỉ thử bằng test hoặc DB thử, không ghi vào DB thật.

## Bước 9 — Tài liệu, test, đồ thị

- `npm test` trong `server/` phải xanh 100%.
- Theo skill `update-file`: README (cây thư mục), `server/README.md` (migration 0103, bảng API), `server/db/SCHEMA.md`, `docs/04-planning/implementation_plan.md`, SRS/BRD, `CURRENT.md`.
- `graphify update .`
- Commit từng bước; push và mở PR vào `main` khi bạn đồng ý.

## Cần bạn quyết định trong lúc làm

- Áp migration `0103` lên DB thật: lúc nào (trước hay cùng lúc deploy).
- Có cần nút xuất Excel bảng đối chiếu theo mẫu import cân bằng kho của KiotViet không. Mình mới để xuất Excel thường.

_Cập nhật: 31/10/2026_
