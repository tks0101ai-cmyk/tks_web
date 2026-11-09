# Thiết kế: tab "VT Hà Nội" và "VT Sài Gòn" (cơ sở dữ liệu vị trí hàng mới)

Ngày: 2026-10-27. Nhánh: `codex/order-picking-prototype`.

## Mục tiêu
Hai tab tra vị trí mới, chạy song song với hai tab cũ "Vị trí HN/SG" (giữ nguyên, vẫn đọc Google Sheets) để thử nghiệm. Về sau đây là cơ sở dữ liệu chính của Vị trí hàng: thêm, bớt, sửa dữ liệu trực tiếp trên web. Dữ liệu đầu sao chép một lần từ Vị trí HN/SG. Trước mắt chỉ Quản lý và người được phân quyền mới xem được.

## Nằm ngoài phạm vi
- Luồng chỉ định vị trí / Đang nhặt / Xác nhận / Hủy / cột ST trên đơn vòng đời (giai đoạn sau). Spec này chỉ để sẵn quy tắc "về 0 thì tự xóa dòng" cho giai đoạn đó dùng.
- Đổi hoặc bỏ hai tab cũ và đồng bộ Google Sheets.

## 1. Dữ liệu (migration 0095)
- `stock_positions`: `id BIGSERIAL`, `branch` (`HN`|`SG`), `code`, `name`, `notes`, `arrival_date` (TEXT, có thể rỗng, ví dụ "KK 4.10", "16/10"), `version` (khóa lạc quan), `location`, `updated_by_user_id`, `updated_by_name`, `updated_at TIMESTAMPTZ DEFAULT now()`, `created_at`. Chỉ số theo `(branch, lower(btrim(code)))` và `(branch, location)`. Không có ràng buộc UNIQUE trên (mã, vị trí): dữ liệu đầu có thể có dòng trùng, giữ nguyên và không cảnh báo; nhập mới/import trùng (mã, vị trí) thì tự cộng ghi chú vào dòng cũ (xem mục 4, 5).
- Số lượng và cảnh báo **không lưu**, luôn tính từ ghi chú bằng `server/public/shared/carton.js` (`parseSpec`, `normalizeNote`, `warnings`).
- Dữ liệu đầu: câu lệnh `INSERT ... SELECT` từ `stock_location_lines` (HN/SG) ngay trong migration, `updated_by_name='Nhập dữ liệu đầu'`, `updated_at = now()`. Ngày về chuyển từ TEXT sang DATE nếu đọc được, không đọc được thì để null và giữ chuỗi gốc vào bản ghi lịch sử nhập đầu. Tên hàng lấy từ sheet làm giá trị khởi đầu.
- `stock_position_history` (chỉ thêm, trigger chặn UPDATE/DELETE, không khóa ngoại, theo `0040_account_audit_log` và `0076`): `id`, `created_at`, `branch`, `position_id`, `code`, `location`, `action` (`import_replace`, `import_add`, `edit`, `create`, `delete`, `auto_delete`, `seed`), `field`, `old_value`, `new_value`, `summary JSONB` (số dòng thêm/đổi/xóa/lỗi cho import), `actor_user_id`, `actor_name`. `REVOKE SELECT ... FROM reporting_readonly`.
- Tên SP và SL KiotViet đọc theo mã từ `products` (`code`, `name`, tổng `raw->'inventories'[].onHand` theo cơ sở): tái dùng và xuất `readOnHandByKey` từ `server/shipment/kiotOrdersRepository.js`. Khi `products` không có mã đó: tên lấy từ `stock_positions.name`, SL KiotViet để trống, cảnh báo "Mã SP lạ". SL KiotViet có thể chậm vài phút (ghi chú trên giao diện).

## 2. Quyền và điều hướng
- `featureRegistry.js`: `stockLocationsV2.view` (`roles: MANAGER_ONLY`, `forbiddenRoles: [Khách]`), `stockLocationsV2.edit` (`requires: 'stockLocationsV2.view'`, `roles: MANAGER_ONLY`). Cả hai tự hiện trong trang Tài khoản để cấp thêm cho từng người.
- `PAGE_FEATURES`: `/vt-positions` -> `anyOf: ['stockLocationsV2.view']`.
- `shared-nav.js`: hai mục "VT Hà Nội" và "VT Sài Gòn" (`#hn`, `#sg`) kèm `feature: 'stockLocationsV2.view'`, đặt cạnh nhóm Vị trí hàng. Chỉ hiển thị tab của cơ sở người dùng được phép (`user.branch`) như trang cũ.
- Route `server/stockPositions/stockPositionsRoutes.js` mount trong `routes.js`: `requireAuth`, `requireFeature`, `resolveBranch`, kiểm phạm vi cơ sở (`BRANCH_OUT_OF_SCOPE`).

## 3. Bảng
Mỗi tab một bảng (`TKSTables.enhance`, tìm kiếm mờ, sắp xếp, phân trang 100): Mã SP, Tên SP, Số lượng, SL KiotViet, Ghi chú, Ngày về, Vị trí, Người cập nhật, TG cập nhật (giờ Việt Nam), Cảnh báo. Số theo en-US.
- Cảnh báo là nhãn ngắn: "Nhiều quy cách", "Trừ lẻ", "Sai định dạng", "Số thùng sai", "Mã SP lạ". Dòng có cảnh báo **đổi chữ sang màu đỏ** (không tô nền), bằng biến CSS hợp chế độ sáng/tối.
- Dòng sai định dạng/số không nguyên: Số lượng để trống.
- Chip lọc "Cảnh báo (n)" từng tab.
- Số lượng của dòng ghi chú rỗng = 0 và không cảnh báo (nhưng xem quy tắc tự xóa ở mục 4).

## 4. Sửa trực tiếp (cần `stockLocationsV2.edit`)
- Sửa tại chỗ Ghi chú, Ngày về, Vị trí. Số lượng và cảnh báo tính lại ngay; Người/TG cập nhật tự ghi. Lưu bằng `PATCH /api/stock-positions/:id` kèm `version`/`updated_at` để phát hiện sửa chồng (409, giống VAT request).
- Ghi chú được chuẩn hóa khi lưu (`1t*11` -> `1T x 11`, gộp cùng SL/thùng, ` + `, ` - N`).
- Thêm dòng: nhập Mã SP, Ghi chú, Ngày về, Vị trí; Tên SP tự tra từ `products`; trùng (cơ sở, Mã SP, Vị trí) thì **tự cộng thông minh** ghi chú vào dòng cũ (cùng SL/thùng thì gộp thùng: `5T x 100` + `2T x 100` = `7T x 100`; khác thì nối ` + `), Ngày về lấy theo lần nhập nếu có. Sửa Vị trí của một dòng sang vị trí đã có mã đó thì báo lỗi, dùng Thêm dòng để cộng.
- Xuất Excel (`GET /api/stock-positions/export`, quyền `stockLocationsV2.export`): toàn bộ dòng của cơ sở, 9 cột như bảng.
- Xóa dòng bằng nút, có hộp xác nhận.
- **Tự xóa khi hết:** sau mọi lần lưu (sửa tay, import, và về sau là trừ do nhặt hàng), nếu số lượng tính ra bằng 0 (ghi chú rỗng, `Hết hàng` hoặc tổng bằng 0) thì dòng bị xóa và ghi lịch sử `auto_delete`. Hộp xác nhận khi sửa tay làm hết hàng để tránh xóa nhầm.
- Mọi thay đổi ghi `stock_position_history` trong cùng giao dịch với thay đổi dữ liệu; không ghi khi giá trị không đổi (kể cả chỉ khác khoảng trắng).

## 5. Import file
- Nút Import trong từng tab; `POST /api/stock-positions/import?branch=..&mode=replace|add&commit=0|1`, `multer` bộ nhớ, tối đa 8 MB, `.xlsx/.xls/.csv`.
- Đọc bằng SheetJS theo mẫu `dashboard/stockoutCheck/supplierReturnImportService.js`; tìm dòng tiêu đề ở bất kỳ vị trí nào trong 20 dòng đầu; khớp tên cột không phân biệt hoa/thường và dấu bằng `normalizeHeader`/`findColumn` (xuất từ `dashboard/debtManagement.js` hoặc chuyển vào helper dùng chung). 4 cột bắt buộc: Mã SP, Ghi chú, Ngày về, Vị trí (có alias như "Mã sản phẩm", "Mô tả", "Khu"); cột thừa bỏ qua; thiếu cột thì lỗi liệt kê cột thiếu. Ngày đọc `XLSX.SSF.parse_date_code` và dd/MM/yyyy, ISO.
- Hai chế độ, đều có bước xem trước (`commit=0` trả số thêm/đổi/xóa/lỗi và danh sách lỗi theo số dòng Excel, tối đa 50) rồi người dùng bấm xác nhận (`commit=1`):
  - **Thay toàn bộ:** bảng của cơ sở được thay bằng nội dung file (từ 2026-11-07: chỉ áp cho các MÃ có trong file — dòng của mã đó mà vị trí không còn trong file bị xóa; mã có trong DB nhưng không có trong file giữ nguyên; dòng có SL 0 trong file bị bỏ).
  - **Bổ sung thêm SL:** dòng trùng (cơ sở, Mã SP, Vị trí) thì cộng ghi chú file vào ghi chú hiện có rồi gộp cùng quy cách (`5T x 100` + `2T x 100` = `7T x 100`; khác quy cách thì nối bằng ` + ` và cảnh báo "Nhiều quy cách"), Ngày về lấy theo file. Dòng chưa có thì thêm mới. Dòng không có trong file giữ nguyên.
- Toàn bộ trong một giao dịch, khóa advisory theo cơ sở. Mỗi lần import ghi một bản ghi lịch sử tóm tắt (`import_replace`/`import_add`, file, số dòng) cộng bản ghi chi tiết từng dòng đổi.
- Quyền `stockLocationsV2.edit`.

## 6. Lịch sử cập nhật
Nút "Lịch sử cập nhật" mở hộp `.dp-*` giống Công nợ (`index.html` openDebtHistory): bảng Thời gian, Người thực hiện, Hành động, Mã SP/Vị trí, Trường, Trước, Sau, có tìm kiếm và lọc theo hành động. `GET /api/stock-positions/history?branch=..&limit=..&before=..` (phân trang theo id, 1000 dòng gần nhất trước), quyền xem. Lịch sử giữ vĩnh viễn (không xóa sau 7 ngày như công nợ).

## 7. Kiểm thử và tài liệu
- Test: service/repository (PGlite chạy migration thật: nhập đầu, sửa, thêm trùng, tự xóa khi hết, 409), import (cả hai chế độ, thiếu cột, ngày sai, file nhiều cột thừa), quyền (`featureRegistry`, `pageGuard`, `adminUserRoutes`), route, frontend (JSDOM: chữ đỏ, chip lọc đếm riêng từng tab, sửa tại chỗ, hộp lịch sử), migration (regex SQL).
- Tài liệu theo CLAUDE.md §3: `server/db/SCHEMA.md`, `server/README.md`, `README.md`, `CURRENT.md`, `docs/02-srs`, `docs/01-brd`, `docs/04-planning/implementation_plan.md`, ngày cập nhật; `graphify update .`; `npm test` xanh (trừ test đã biết `shared-motion-integration` liên quan prototype, xử lý riêng).
- Người dùng tự chạy `npm run db:migrate`; áp migration trước khi deploy mã.

## Giả định cần theo dõi
- Dữ liệu đầu có dòng trùng và dòng rỗng vị trí: giữ nguyên, không cảnh báo.
- Ngày về lưu nguyên dạng text, không chuyển sang DATE.
- Quyền sửa riêng khỏi quyền xem để cấp cho người chỉ cần tra.
