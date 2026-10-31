# Supabase schema cho đồng bộ KiotViet

## Migration 0102 — Nhật ký ghi ngược lên đơn KiotViet (30/10/2026, chưa áp DB)

`0102_order_kiot_edit_log.sql`: bảng `order_kiot_edit_log` (`id`, `created_at`, `branch` HN|SG, `order_code`, `action` `remove_line|set_quantity|rollback`, `summary JSONB` {productCode/quantities, before[], after[] hoặc problems/restored}, `actor_user_id`, `actor_name`); trigger chặn UPDATE/DELETE; thu hồi `reporting_readonly`; index `(branch, lower(btrim(order_code)), id)`. Ghi bởi `kiotviet/kiotOrderEditor.js`, fail-soft khi bảng chưa tồn tại.

## Migration 0101 — VT: hành động lịch sử Xuất kho (30/10/2026, chưa áp DB)

`0101_stock_position_stock_out_action.sql`: chỉ mở rộng CHECK `stock_position_history_action_check` thêm `stock_out` (xóa rồi tạo lại ràng buộc, giữ nguyên toàn bộ giá trị của `0099`). Không thêm cột/bảng/trigger. Chi tiết ở mục cuối.

## Migration 0099 — VT: Đã sửa + xóa lịch sử có kiểm soát (28/10/2026, chưa áp DB)

`0099_stock_position_ack_and_history_purge.sql`: thêm `stock_positions.format_ack`, mở CHECK action lịch sử, viết lại trigger chặn. Chi tiết ở mục cuối.

## Migration 0098 — Đã xử lý cảnh báo Lệch SL bốc (27/10/2026, chưa áp DB)

`0098_order_pick_history_mismatch_ack.sql` chỉ mở rộng CHECK `order_pick_history.action` thêm `mismatch_ack` (xóa rồi tạo lại ràng buộc `order_pick_history_action_check`). Không thêm cột/bảng; `summary` của dòng này mang `signature` (JSON các `[mã hàng, picked, ordered]` lúc bấm Đã xử lý) và `items`. Chi tiết ở mục “0098” cuối tài liệu.

## Migration 0097 — Dấu vết phiếu chỉ định (27/10/2026, chưa áp DB)

`0097_order_pick_assignment_snapshots.sql` thêm `order_pick_lines.allocation_snapshot JSONB` nullable, ghi lúc chỉ định để kiểm mã/vị trí/quy cách và cách lấy trên phiếu dưới khóa trước xác nhận. Dấu vết này tách với `position_snapshot` ghi lúc trừ tồn để hoàn tác. Không backfill từ tồn hiện tại hoặc sửa lịch sử cũ.

## Migration 0096 — Chỉ định vị trí trên Vòng đời đơn hàng (27/10/2026, chưa áp DB)

Bảng `order_pick_assignments`, `order_pick_lines`, `order_pick_history` (chỉ thêm) và mở rộng CHECK `stock_position_history.action` (`pick`, `pick_revert`). Chi tiết ở mục “0096” cuối tài liệu. Schema hiện có migration `0001` đến `0098`.

## Migration 0095 — Vị trí hàng mới: `stock_positions` (27/10/2026, chưa commit/migrate/deploy)

Bảng `stock_positions` + `stock_position_history`; dữ liệu đầu sao chép từ `stock_location_lines`; SL kho tính từ ghi chú bằng `carton.js`; khóa lạc quan `version`; lịch sử chỉ thêm. Chi tiết ở mục cuối.

## Migration 0094 — Cá nhân hủy đơn nghỉ phép (26/10/2026, chưa áp DB thật)

`hr_leave_cancellation_jobs`, `hr_leave_approver_recipients`; hàm `hr_cancel_own_leave`; FK `hr_leave_submissions.request_id` đổi sang ON DELETE CASCADE; guard chặn INSERT chuông trễ trong `notifications`. Chi tiết ở mục 0094 phía cuối.

## Migration 0093 — Chuông thông báo (24/10/2026, chưa áp DB thật)

`0093_notifications.sql` tạo bảng `notifications`: `id UUID PRIMARY KEY` (server sinh), `seq BIGINT GENERATED ALWAYS AS IDENTITY` (thứ tự chèn, phân xử trùng `created_at`), `recipient_user_id TEXT NOT NULL` (= `app_users.id`, không FK vì admin cứng không có UUID), `type TEXT NOT NULL` (khác rỗng), `title`, `message` (`TEXT NOT NULL DEFAULT ''`), `related_type`, `related_id` (TEXT, NULL được), `is_read BOOLEAN NOT NULL DEFAULT false`, `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`. Index `(recipient_user_id, created_at DESC, seq DESC)` và index một phần `(recipient_user_id) WHERE NOT is_read`. Thu hồi quyền `reporting_readonly`. Thay cho file `data/notifications.json` (mất mỗi lần deploy Render); dữ liệu cũ không chuyển.

## Migration 0091–0092 — Bảng giá duyệt (24/10/2026, chưa áp DB thật)

`0091_invoice_approved_prices.sql` thêm 2 bảng `invoice_approved_prices` và `invoice_approved_price_changes`; `0092_invoice_approved_prices_vat_split.sql` tách cột giá `approved_price` thành `price_no_vat` + `price_with_vat`; hợp đồng chi tiết ở mục "Bảng giá duyệt — migration 0091 và 0092" bên dưới (sau mục Kiểm tra giá bán 0077). Áp CẢ HAI TRƯỚC khi deploy mã.

## Migration 0089–0090 — Khách mới, SĐT, địa chỉ (24/10/2026, chưa áp DB thật)

`0089`: `customer_price_levels.new_customer TEXT NOT NULL DEFAULT ''`; `customer_price_level_history.old_new_customer/new_new_customer`. `0090`: `customer_profiles.phone/address TEXT NOT NULL DEFAULT ''`.

## Migration 0087 — level giá nội bộ (23/10/2026, chưa áp DB thật)

`0087_customer_price_levels.sql` thêm `customer_price_level_state(id BOOLEAN PRIMARY KEY CHECK(id), initialized_at)`, `customer_price_levels(customer_key TEXT PRIMARY KEY, level medium/large/vip, version INTEGER > 0, updated_by_id/name, updated_at)`, `customer_price_level_sources` (khóa `(branch,customer_id)`, lưu mã/tên/khóa khách/email và level nguồn lúc chuyển đổi), `customer_price_level_history` (khóa identity, unique `(customer_key,version)`, level cũ/mới, người sửa, thời gian). Không cấp quyền đọc cho `reporting_readonly`.

Schema không tự bật cutover. Script `scripts/initialize-customer-price-levels.js --apply` chụp mọi nguồn và tạo level gộp trong giao dịch trước khi đánh dấu khởi tạo; giữ nguyên dữ liệu đã có khi chạy lại. Khách mới chưa có dòng level dùng Lớn, phiên bản 0 cho lần ghi đầu. Giá trị level nội bộ thay email khi đọc báo cáo và chụp hóa đơn. Không cập nhật `invoice_price_audit_*` lịch sử.

24/10/2026 — Bảng giá duyệt (migration `0091_invoice_approved_prices.sql`) với 2 bảng `invoice_approved_prices` và `invoice_approved_price_changes`; `0092_invoice_approved_prices_vat_split.sql` tách giá thành `price_no_vat` / `price_with_vat`.

23/10/2026 — Kiểm tra giá bán (migration `0077_invoice_price_audit.sql`) với 4 bảng `invoice_price_audit_*` và cột `shipping_measures.freight_per_unit`. ORDER VAT trạng thái "VAT sẵn nhiều" (`0083_vat_request_status_vat_ready.sql`).

22/10/2026 — `hr_employees.insurance_number TEXT NOT NULL DEFAULT ''` (migration `0078_hr_employee_insurance_number.sql`), unique index trên số không rỗng của hồ sơ chưa xóa mềm; chỉ quyền `hr.employees.manage` nhận từ API/Excel. Server áp riêng migration này trước khi nhận request, có advisory lock cho nhiều instance và không chạy migration khác đang chờ.

Tài liệu này mô tả schema Postgres được tạo bởi `db/migrations/0001` đến `0095` (0087, 0089–0095 chưa áp DB thật). Mọi module đồng bộ ở Giai đoạn 2/3 phải đọc cả tài liệu này và `kiotviet/API_ENDPOINTS.md` trước khi ánh xạ payload.

## Quy ước chung

- Mọi bảng nghiệp vụ dùng `branch` với đúng hai giá trị nội bộ: `hanoi` và `saigon`.
- ID KiotViet chỉ duy nhất trong phạm vi một gian hàng, nên khóa chính luôn bắt đầu bằng `branch`.
- Cột tiền và số lượng dùng `NUMERIC` (đổi từ `BIGINT`/`INTEGER` ở migration `0012`, 2026-09-16). Giả định ban đầu "tiền/số lượng luôn là số nguyên" sai với dữ liệu thật — KiotViet trả giá/chiết khấu có phần lẻ xu và số lượng hàng bán theo cân không phải số nguyên (ví dụ `7.5`).
- Các entity lấy trực tiếp từ KiotViet lưu toàn bộ object nguồn trong `raw JSONB`; các cột first-class dùng để join, lọc và sắp xếp.
- Ngoại lệ chuẩn hóa trạng thái khách (15/10/2026): `customers.raw.isActive` là boolean do đồng bộ chuẩn hóa từ `isActive`/`IsActive` nếu có, danh sách khách hiện hành và metadata `removedIds`/`removeIds`/`removeId`. Danh sách khách đang trả về mặc định hoạt động; khách vắng mặt chỉ đánh dấu false sau đối soát đầy đủ được xác nhận. Marker `sync_checkpoints.note.activeCustomersReconciledAt` buộc đối soát lần đầu và mỗi 24 giờ; không xóa hồ sơ. Công nợ lọc `COALESCE(raw->>'isActive',raw->>'IsActive','true') <> 'false'`; fallback dành cho dữ liệu cũ, lần đối soát đầu sẽ chuẩn hóa toàn bộ.
- `status` giữ nguyên mã `SMALLINT` từ KiotViet, không suy diễn nhãn trong tầng lưu trữ.
- `synced_at` là thời điểm bản ghi được ghi vào Postgres, không thay thế `created_date` hoặc `modified_date` của KiotViet.
- 3 bảng rollup báo cáo Dashboard (migration `0013`, `daily_purchase_summary` đã bỏ ở `0026`) là ngoại lệ: không có `raw`, không theo quy ước `branch` là cột đầu PK duy nhất (khóa chính của chúng ghép thêm ngày/mã hàng vì là bảng tổng hợp, không phải bản sao 1-1 của KiotViet).

## Ánh xạ định danh cơ sở

| `branch` trong Postgres | Nhãn `BRANCHES` của Dashboard Sheets | Biến môi trường retailer KiotViet |
|---|---|---|
| `hanoi` | `Hà Nội` | `KIOTVIET_RETAILER` |
| `saigon` | `Sài Gòn` | `KIOTVIET_RETAILER_SG` |

Ba hệ định danh này khác nhau. Code sync phải nhận `branch` rõ ràng từ cấu hình tác vụ và không suy ra nó bằng cách so sánh nhãn hiển thị.

## Danh sách bảng

| Bảng | Mục đích | Khóa chính | Cột first-class chính |
|---|---|---|---|
| `categories` | Nhóm hàng | `(branch, id)` | `parent_id`, `name`, `rank`, `modified_date` |
| `products` | Hàng hóa và trạng thái hoạt động | `(branch, id)` | `code`, `name`, `category_id`, `base_price`, `unit`, `is_active`, các ngày |
| `customers` | Khách hàng | `(branch, id)` | `code`, `name`, `phone`, `group_id`, `debt`, `total_revenue`, các ngày |
| `staff` | Nhân viên suy luận từ các entity khác | `(branch, id)` | `name`, `first_seen_at`, `last_seen_at` |
| `sync_checkpoints` | Tiến độ từng entity của từng cơ sở | `(branch, entity)` | `last_synced_at`, `last_success_at`, `note` |
| `invoices` | Hóa đơn | `(branch, id)` | `code`, `purchase_date`, `customer_id`, `sold_by_id`, tiền, `status`, các ngày |
| `invoice_details` | Dòng hàng của hóa đơn | `(branch, invoice_id, line_no)` | `product_id`, `quantity`, `price`, `discount` |
| `invoice_payments` | Thanh toán của hóa đơn | `(branch, invoice_id, line_no)` | `method`, `amount`, `trans_date` |
| `orders` | Đơn hàng | `(branch, id)` | `code`, `order_date`, `customer_id`, `sold_by_id`, `total`, `status`, các ngày |
| `order_details` | Dòng hàng của đơn hàng | `(branch, order_id, line_no)` | `product_id`, `quantity`, `price`, `discount` |
| `returns` | Phiếu trả hàng | `(branch, id)` | `code`, `return_date`, `invoice_id`, `customer_id`, `sold_by_id`, `total`, `status`, các ngày |
| `return_details` | Dòng hàng của phiếu trả | `(branch, return_id, line_no)` | `product_id`, `quantity`, `price` |
| `purchases` | Phiếu nhập hàng từ endpoint `/purchaseorders` | `(branch, id)` | `code`, `purchase_date`, `supplier_id`, `total`, `status`, các ngày , `raw_hash` (0044) |
| `purchase_details` | Dòng hàng của phiếu nhập | `(branch, purchase_id, line_no)` | `product_id`, `quantity`, `price` |
| `order_suppliers` | Phiếu **Đặt hàng nhập** (PDN…) từ endpoint `/ordersuppliers` (migration `0024`) — khác `purchases` (Nhập hàng) | `(branch, id)` | `code`, `order_date`, `supplier_id`, `total`, `status`, `created_date` (payload không có `modifiedDate`) |
| `order_supplier_details` | Dòng hàng của phiếu đặt hàng nhập | `(branch, order_supplier_id, line_no)` | `product_id`, `quantity`, `price` (payload chỉ có `productId`, không có `productCode`) |
| `inventory_value_snapshots` | Giá trị tồn kho **mỗi ngày, mỗi cơ sở** (migration `0025`) — ảnh chụp lúc 23:59 giờ VN từ 2026-09-30, nguồn biểu đồ "Giá trị tồn kho theo ngày" (tab Tổng quan) | `(snapshot_date, branch)` | `stock_value`, `captured_at` (thời điểm chụp thật; chụp bù thì > 23:59) |
| `cash_flows` | Toàn bộ phiếu thu và phiếu chi | `(branch, id)` | `code`, `is_receipt`, `amount`, `method`, đối tác/người dùng, `trans_date` |
| `webhook_events_raw` | Payload webhook thô để phân tích ở Task 7b | `id` | `received_at`, `payload` |
| `backfill_progress` | Tiến độ backfill lịch sử (Giai đoạn 3), độc lập với `sync_checkpoints` | `(branch, entity, chunk_key)` | `status`, `next_item`, `records_synced`, `last_error` |
| `cash_book_accounts` | Danh mục tài khoản ngân hàng / tiền mặt dùng chung toàn công ty (0033) | `id` | `bank_name`, `account_no`, `description`, `raw` |
| `cash_book_checkpoints` | Mốc chốt số dư tài khoản Sổ quỹ (0033) | `id` | `account_id`, `checkpoint_at`, `balance`, `system_balance`, `diff` |
| `cash_book_account_banks` | Tên ngân hàng tùy chỉnh do Quản lý nhập theo số tài khoản (0034) | `account_no` | `bank`, `updated_by`, `updated_at` |
| `business_monthly_customer_sales` | Doanh số từng khách theo tháng đã chốt (0036) | `(month, branch, customer_code)` | `customer_id`, `customer_name`, `net_revenue`, `invoice_amount`, `return_amount` |
| `business_monthly_customer_product_sales` | Doanh số khách × mã hàng theo tháng đã chốt (0036) | `(month, branch, customer_code, product_code)` | `product_name`, `net_revenue`, `net_qty` |
| `business_monthly_product_sales` | Doanh số từng mã hàng theo tháng đã chốt gộp cả 2 cơ sở (0036) | `(month, product_code)` | `product_name`, `net_revenue`, `net_qty` |
| `business_monthly_sale_sales` | Doanh số từng sale theo tháng đã chốt (0036) | `(month, sale_name)` | `net_revenue`, `customer_count`, `refreshed_at` |
| `business_monthly_state` | Trạng thái chốt cứng và hash nhóm sale của từng tháng (0036) | `month` | `frozen_at`, `net_revenue`, `group_hash` |
| `sale_teams` | Phân chia Team cho từng sale (0037) | `sale_name` | `team_name`, `updated_at` |
| `hr_leave_work_schedules` | Lịch làm việc theo ngày; từ 0077 theo tài khoản (`user_id`), `employee_id` chỉ còn dữ liệu cũ (0038, 0077) | duy nhất `(user_id, work_date)` và `(employee_id, work_date)` (một phần, khi khác NULL) | `user_id`, `morning_start`, `afternoon_start`, `version` |
| `hr_leave_submissions` | Lịch sử gửi đơn nghỉ phép bất biến kèm hạn nộp và snapshot (0038, 0042, 0077) | `(request_id, submission_revision)` | `user_id` (0077), `hr_employee_id` (lịch sử), `leave_sessions`, `timing_status`, `thoi_gian_gui` |
| `account_audit_log` | Nhật ký thao tác quản trị tài khoản bất biến (0040) | `id` | `action`, `actor_username`, `target_username`, `changes`, `created_at` |
| `special_day_notice_log` | Đánh dấu ngày lễ/sinh nhật đã báo lên chuông thông báo (0043) | `(day_key, event_key)` | `sent_at` |
| `product_stockout_days` | Số ngày đứt hàng 30 ngày gần nhất theo mã và cơ sở, cho cột Đứt HN/SG của Báo cáo hàng hóa (0067) | `product_key` | `product_code`, `days_hanoi`, `days_saigon`, `hanoi_scanned_at`, `saigon_scanned_at` |
| `business_current_month_customer_sales` | Doanh số THÁNG HIỆN TẠI theo khách (phản chiếu `business_monthly_customer_sales`, bảng tạm cho tháng chưa chốt; 0068) | `(month, branch, customer_code)` | `customer_id`, `customer_name`, `invoice_amount`, `return_amount`, `net_revenue`, `invoice_count`, `return_count` |
| `business_current_month_customer_product_sales` | Doanh số tháng hiện tại theo khách × mã hàng (phản chiếu `business_monthly_customer_product_sales`; 0068) | `(month, branch, customer_code, product_code)` | `product_name`, `net_revenue`, `net_qty` |
| `business_current_month_state` | Trạng thái tính sẵn tháng hiện tại, đúng 1 dòng (0068) | `id` (=1) | `month`, `computed_at`, `cutoff`, `last_full_at`, `customers_synced_at`, `version` |
| `marketing_ads_costs` | Chi phí ADS đọc từ Google Sheets theo chu kỳ (0069): mỗi dòng = 1 dòng ngày (`daily`) hoặc 1 dòng tổng tháng (`total`) của `parseCosts()` | `row_key` | `sheet_order`, `block`, `source_row`, `kind`, `sheet`, `page`, `month`, `date_text`, `ad_cost`, `total_cost`, `messages`, `cost_per_message`, `phones`, `cost_per_phone`, `total_label` |
| `marketing_ads_sync_state` | Trạng thái đồng bộ chi phí ADS, đúng 1 dòng (0069); chưa có `last_success_at` = chưa đồng bộ → báo cáo lùi về Sheets | `id` (=1) | `last_attempt_at`, `last_success_at`, `last_error`, `row_count`, `version` |
| `marketing_phone_summary` | Kết quả gộp SĐT Pancake độc lập, mỗi `(page_id, phone_key)` 1 dòng (0069); chỉ giữ trường THÔ, chưa ánh xạ nhân viên | `(page_id, phone_key)` | `first_order`, `phone`, `first_employee`, `current_employee`, `repeat_employee`, `first_at`, `current_at`, `repeat_at`, `trace` (JSONB mảng gọn) |
| `marketing_phone_summary_state` | Trạng thái bản gộp SĐT, đúng 1 dòng (0069); `max_source_order` lệch bảng quan sát → bản cũ → lùi về gộp JS | `id` (=1) | `built_at`, `max_source_order`, `observation_count`, `phone_count`, `periods`, `employee_raws`, `version` |

Ngoài 19 bảng nghiệp vụ trên còn có bảng raw webhook, bảng tiến độ backfill, và runner quản lý bảng kỹ thuật `schema_migrations(filename, applied_at)` để mỗi file SQL chỉ được áp dụng một lần.

### Tài khoản đăng nhập và nhân sự (migration `0009`)

| Bảng | Mục đích | Khóa chính | Cột first-class chính |
|---|---|---|---|
| `hr_employees` | Danh sách nhân sự (thay tab "Danh sách nhân sự" Sheets) | `id` (BIGSERIAL) | `branch`, `ho_ten`, `bo_phan`, `email`, `so_dien_thoai`, `is_active`, `employment_status` |
| `app_users` | Tài khoản đăng nhập ứng dụng (thay tab "Users" Sheets) | `id` (UUID, sinh ở app bằng `crypto.randomUUID()`, không dùng `pgcrypto`) | `username`, `password_hash`, `vai_tro`, `co_so`, `work_branch`/`bo_phan` (0076, nguồn chính cho cơ sở/bộ phận công tác), `trang_thai`, `hr_employee_id` (chỉ còn đối chiếu lịch sử), `telegram_id` |

Hai bảng này **khác** quy ước `branch` 2 giá trị nội bộ ở cột `co_so` của `app_users`: `co_so` có 3 trạng thái + rỗng (`hanoi`/`saigon`/`both`/`''`) và chỉ là **cơ sở mặc định** lúc đăng nhập (mọi tài khoản xem được cả hai cơ sở; rỗng = mặc định `Cả hai`) — không nhầm với `branch` (chỉ `hanoi`/`saigon`) dùng ở `hr_employees` và mọi bảng KiotViet khác. `app_users.hr_employee_id` là FK tới `hr_employees(id)` (`ON DELETE SET NULL`) — thay cho cặp con trỏ sheet cũ `(hrSourceBranch, hrRowIndex)`; xoá nhân sự dùng `is_active = false` (soft-delete), không `DELETE` vật lý. Cơ chế tự khóa tài khoản khi nhân sự bị gỡ (`lock_reason = 'hr_removed'`) đã bỏ; `effectiveUserResolver.js` chỉ còn mở khóa các tài khoản từng bị khóa theo cơ chế đó khi họ đăng nhập lại. Từ migration 0041, `hr_employees.employment_status` (`active` = Đang làm việc / `resigned` = Đã nghỉ việc) là trạng thái làm việc hiển thị ở tab Danh sách nhân sự, tách khỏi `is_active` (xóa mềm); đổi sang `resigned` khóa tài khoản liên kết với `lock_reason = 'hr_resigned'` (giá trị riêng, KHÔNG dùng `hr_removed` vì resolver tự mở khóa giá trị đó), đổi lại `active` chỉ mở khóa đúng loại khóa này (`hr/hrEmployeeAdminService.js`).

Migration `0015` thêm `app_users.telegram_id` dạng `TEXT` để không phụ thuộc giới hạn số nguyên JavaScript và hỗ trợ Telegram ID dài. ID khác rỗng là duy nhất giữa các tài khoản chưa xoá. Từ migration `0016`, cột này là **bản đọc** được trigger đồng bộ từ `hr_telegram_links` (xem mục "Nghỉ phép và bot Telegram"); nguồn sự thật của liên kết Telegram là bảng đó. Tab `_HR_TELEGRAM_LINKS` trên Google Sheets không còn được ứng dụng sử dụng.

### Hạn đăng ký nghỉ phép (migration `0038`)

Migration 0038 adds per-date `hr_leave_work_schedules` (employee/date primary key, nullable morning/afternoon starts, incrementing version), authoritative timing/calendar/schedule snapshots on `hr_leave_requests`, and immutable `hr_leave_submissions`. Submission time is the database clock. New leave requests always start `Chưa duyệt`; `timing_status` independently stores `Đúng hạn`, `Xin muộn`, or `Vi phạm`. Old rows remain unclassified with revision 0, without backfilling events or schedules. Both new tables revoke BI SELECT access.

The external employee bot must supply a trusted employee/account/linked Telegram identity and use a date with a configured first-session start. Missing configuration rejects INSERT atomically; it never defaults to old fixed session hours. The database overrides supplied timestamps and snapshots. Direct range-only bot edits regenerate selected sessions; any calendar resend resets approval and bumps decision version while retaining immutable prior submission history. The additive `submission_nonce` UUID signals an explicit same-calendar resend. Approval and notifier marker updates preserve timing. See [rollout and bot contract](../../docs/hr-leave-deadlines.md) before applying this migration or updating the external bot.

### Nghỉ phép và bot Telegram (migration `0016`)

Thay 3 tab Google Sheets (`Yêu cầu nghỉ phép`, `_HR_TELEGRAM_LINKS`, `_HR_TELEGRAM_SESSIONS`). Bot **xin nghỉ của nhân viên** chạy **ngoài repo này** (VPS riêng) và đọc/ghi thẳng 3 bảng bằng SQL; web đọc `hr_leave_requests`, tự gửi đơn từ HR hoạt động, nhập tay "tự ý nghỉ" bằng quyền riêng và đổi trạng thái. Cả 3 bảng đã `REVOKE SELECT` khỏi `reporting_readonly` (PII/nội dung tin nhắn).

| Bảng | Mục đích | Khóa chính | Ai ghi |
|---|---|---|---|
| `hr_leave_requests` | Đơn xin nghỉ / bản ghi tự ý nghỉ | `id` (BIGSERIAL), `request_id` UNIQUE | bot (đơn Telegram), web (tự gửi + nhập tay + duyệt) |
| `hr_telegram_links` | Liên kết Telegram chat ↔ tài khoản (`app_users`) | `id` | bot |
| `hr_telegram_sessions` | Trạng thái hội thoại xin nghỉ đang dở, mỗi chat một dòng | `telegram_chat_id` | bot |

**`hr_leave_requests`** — bot chỉ cần `INSERT` các cột không có DEFAULT: `branch` (`hanoi`/`saigon`), `start_date`, `start_session`, `end_date`, `end_session`, `tong_buoi_nghi`. Mọi cột còn lại có DEFAULT, kể cả:
- `request_id` DB tự sinh dạng `NP-YYYYMMDD-NNNN` (sequence, không trùng) — **bot không tự tạo mã**.
- `tong_ngay_nghi` là cột `GENERATED` = `tong_buoi_nghi / 2` — không `INSERT` được.
- Khoảng nghỉ lưu bằng ngày (`DATE`) + buổi (`'Sáng'`/`'Chiều'`); mỗi ngày 2 buổi, khoảng tính gồm cả buổi đầu và cuối. CHECK `hr_leave_requests_range_check` chặn `end < start` và "Chiều → Sáng" cùng ngày. Web dựng lại chuỗi `"Sáng 22/08/2026"` khi trả API — DB không lưu chuỗi đó.
- `ho_ten`, `chuc_vu`, `web_username` là **bản chụp** tại thời điểm gửi; `user_id`/`hr_employee_id` là khóa thật (`ON DELETE SET NULL`), bot nên điền cả hai. `source` mặc định `'telegram'`.
- `co_nghi_gap`/`co_tu_y_nghi` là boolean; `tin_nhan` giữ nguyên văn tin nhắn gốc; `thoi_gian_gui` là giờ nhận tin (khác `created_at` = giờ ghi DB).
- `trang_thai` ∈ `Chưa duyệt | Đã duyệt | Từ chối | Vi phạm` (migration 0030 đã gỡ `Tạm duyệt`, đơn cũ chuyển về `Chưa duyệt`; bot nhân viên ngoài repo không được ghi giá trị này nữa); `loai_yeu_cau` ∈ `Xin nghỉ phép | Tự ý nghỉ (HR ghi nhận)`.
- `ghi_chu_duyet` giữ người xử lý và lý do từ chối nếu có. Bỏ qua lý do vẫn lưu người/thời điểm; đổi sang trạng thái khác xóa phần lý do từ chối. Web không hiển thị cột này; bot xin nghỉ ngoài repo không ghi nó.

**Báo kết quả duyệt cho nhân viên** (thay cho việc bot cũ quét Sheet): hàng cần báo là

```sql
SELECT * FROM hr_leave_requests
 WHERE thoi_diem_duyet IS NOT NULL AND decision_notified_at IS NULL;
```

Sau khi nhắn Telegram thành công, bot `UPDATE ... SET decision_notified_at = now()`. Trigger `hr_leave_requests_before_update` tự đặt lại `decision_notified_at = NULL` mỗi khi `trang_thai` đổi (trừ khi câu `UPDATE` tự đặt giá trị), nên đổi ý duyệt → từ chối được báo lại. Bản ghi web nhập tay đã duyệt sẵn được đánh dấu đã báo ngay từ đầu. Index từng phần `hr_leave_requests_pending_notice_idx` phục vụ đúng truy vấn này.

**`hr_telegram_links`** — vòng đời `pending` (có `link_code` + `code_expires_at`, chờ nhân viên gõ mã) → `linked` (có `telegram_chat_id`, `linked_at`) → `revoked` (bị thay/huỷ); hoặc `pending` → `expired`. Bot cũng có thể tạo thẳng dòng `linked` với `link_method = 'hr_directory'` khi `telegram_chat_id` khớp `hr_employees.telegram_id` (không cần mã). Ràng buộc: mỗi chat chỉ `linked` cho 1 tài khoản, mỗi tài khoản chỉ 1 chat `linked`, mã `pending` duy nhất — muốn đổi liên kết phải `revoke` dòng cũ **trước** (cùng transaction) rồi thêm dòng `linked` mới. Trigger `hr_telegram_links_sync_app_user` giữ `app_users.telegram_id` khớp với dòng `linked` (đặt khi `linked`, xoá khi `revoked`/xoá dòng) → bot không cần ghi `app_users`. `telegram_chat_id` là `TEXT` (kiểu chuỗi tránh mất chính xác số lớn).

**`hr_telegram_sessions`** — `step` (tên bước của bot, không CHECK vì thuộc về bot), `data JSONB` (ngày lưu dạng chuỗi ISO), `expires_at` mặc định +60 phút; bot gia hạn `expires_at` mỗi lần ghi, coi dòng quá hạn là không tồn tại và dọn định kỳ bằng `DELETE FROM hr_telegram_sessions WHERE expires_at < now()`. Ghi phiên bằng `INSERT ... ON CONFLICT (telegram_chat_id) DO UPDATE`.

Trang hồ sơ cá nhân và hộp hồ sơ dùng chung đọc `telegramId` (và cờ `telegramEditable`) từ `GET /api/auth/profile`. Từ 2026-10-03 chỉ **Quản lý** (hoặc admin cứng) được thêm/sửa ID ở hồ sơ của chính mình: khi người dùng lưu ID qua `POST /api/auth/profile`, server chỉ cập nhật tài khoản đang đăng nhập, còn vai trò khác gửi ID khác giá trị hiện tại bị từ chối 403 `TELEGRAM_ID_LOCKED` (nhân viên nhờ Quản lý nhập hộ). ID là chuỗi số nguyên dương tối đa 20 chữ số; chuỗi rỗng hủy liên kết, không gửi trường này thì giữ ID hiện tại. `appUsersRepository.updateProfileRow` lưu hồ sơ, thu hồi liên kết cũ/các mã chờ, tạo liên kết `manual` mới và đồng bộ `hr_employees.telegram_id` của nhân sự đã gắn tài khoản trong một transaction. ID trùng tài khoản, liên kết bot hoặc nhân sự đang hoạt động khác trả HTTP 409 và rollback toàn bộ. Không cần migration mới.

Quản lý cũng có thể xem ID trong `GET /api/admin/users` và đổi/xóa ID qua `PUT /api/admin/users/:id` hoặc hộp sửa thông tin nhân viên. Luồng này dùng cùng transaction đồng bộ ID, liên kết bot và danh bạ nhân sự; các thông tin tài khoản được gửi kèm cũng lưu trong transaction đó. Quyền `account.users.manage` và chính sách bảo vệ tài khoản vẫn áp dụng: đổi ID của quản lý khác chỉ dành cho quản lý cấp cao, thao tác chiếm định danh không vượt quyền người sửa. Không gửi `telegramId` thì giữ liên kết hiện tại.

`updated_at` của cả 3 bảng do trigger tự đặt, bot không cần set.

### Bot Telegram riêng cho quản lý (migration `0029`)

`0029_hr_manager_telegram.sql` bổ sung `hr_leave_requests.decision_version` và 5 bảng kỹ thuật cho bot quản lý chạy cùng Express. Bot xin nghỉ ngoài repo tiếp tục ghi đơn vào bảng hiện có; trigger DB ghi sự kiện tạo đơn/đổi quyết định kể cả khi nguồn ghi là bot đó.

| Bảng / cột | Mục đích | Quyền sở hữu |
|---|---|---|
| `hr_leave_requests.decision_version` | BIGINT NOT NULL DEFAULT 0; đổi trạng thái/lý do/người quyết định/thời điểm làm tăng phiên bản để từ chối nút và hội thoại cũ | DB + service quyết định dùng chung |
| `hr_leave_change_events` | Sự kiện tạo đơn/đổi quyết định bền vững, nguồn phát hiện thay đổi từ mọi nguồn ghi | Trigger DB; runtime đọc/xử lý |
| `hr_leave_manager_messages` | Theo dõi bản tin theo đơn/quản lý/chat, message ID, lease xử lý và retry; hỗ trợ cập nhật các bản tin đã gửi | Bot quản lý |
| `hr_manager_telegram_sessions` | Phiên nhập lý do từ chối, gắn chat/quản lý/đơn/phiên bản và tin nhắn nhắc nhập; hết hạn 15 phút | Bot quản lý |
| `hr_manager_telegram_updates` | Inbox bền vững theo Telegram `update_id`; giữ hiệu ứng cần xử lý lại để chống cập nhật trùng khi retry/restart | Webhook + runtime bot quản lý |
| `hr_manager_telegram_state` | Một dòng lưu mốc bật bot lần đầu, phân biệt lịch sử kết thúc cũ và đơn thật sự mới; không chứa dữ liệu nghiệp vụ người dùng | Runtime bot quản lý |

**Khóa và cột kỹ thuật:**

- `hr_leave_change_events`: PK `id BIGSERIAL`, FK `request_id` → đơn, UNIQUE `(request_id, decision_version)`; `event_type` nhận `CREATE`/`DECISION`. Index hàng chưa `completed_at` theo `(available_at, id)`. Migration chỉ seed đơn Xin nghỉ phép Chưa duyệt hiện có, không gửi lại các quyết định kết thúc cũ.
- `hr_leave_manager_messages`: PK `id BIGSERIAL`, FK `request_id`/`user_id`, UNIQUE `(request_id, user_id, telegram_chat_id)`; chat ID là TEXT, message ID BIGINT. `desired_version` mặc định 0, `sent_version` mặc định -1; index hàng `NOT blocked AND desired_version > sent_version` để giao/cập nhật tin còn thiếu.
- `hr_manager_telegram_sessions`: PK `telegram_chat_id TEXT`, `session_id UUID` UNIQUE; FK `user_id`/`request_id`, `expected_version`, `prompt_message_id`, `expires_at` mặc định +15 phút. Index `expires_at` hỗ trợ tìm phiên hết hạn.
- `hr_manager_telegram_updates`: PK `update_id BIGINT`, `payload JSONB`, `chat_key TEXT GENERATED` lấy chat từ callback/message (fallback update ID), `effects JSONB` dạng mảng, `effects_done`, `handled_at`, `completed_at`. Hai index một phần cho hàng chưa hoàn tất: `(available_at, update_id)` và `(chat_key, update_id)`. Claim không vượt update trước chưa hoàn tất trong cùng chat, kể cả update trước đang retry hoặc còn lease.
- `hr_manager_telegram_state`: PK `singleton BOOLEAN CHECK (singleton)` cho một dòng, `first_enabled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()` lưu mốc bật lần đầu qua restart/tắt-bật. Lịch sử kết thúc trước mốc này không được gửi mới; đơn tạo sau mốc vẫn gửi thông tin hiện tại dù đã được duyệt trên web trước lượt quét.
- Event, bản tin và inbox có `available_at`, `attempts`, `lease_token UUID`, `lease_until`, `last_error` để claim và retry công việc. Các FK tới đơn/tài khoản dùng `ON DELETE CASCADE`.

Bốn bảng sự kiện/giao tin/phiên/inbox chứa định danh Telegram/nội dung nghiệp vụ nội bộ nên thu hồi `SELECT` khỏi `reporting_readonly`. Bảng singleton trạng thái không chứa dữ liệu nghiệp vụ người dùng; migration cũng thu hồi SELECT của role này trên bảng đó. Không dùng chung `hr_telegram_sessions` của bot nhân viên để lưu hội thoại từ chối.

**Quyết định dùng chung:** service web/Telegram cập nhật cùng hàng `hr_leave_requests` trong transaction. Callback Telegram phải khớp `decision_version` mới nhất và người thao tác vẫn hoạt động, có Telegram ID, `hr.leave.manage` và phòng ban/cơ sở được gán phù hợp, hoặc được chọn làm quản trị dự phòng. Telegram không đổi tiếp đơn `Đã duyệt`/`Từ chối`; web vẫn được thay đổi/mở lại theo quyền hiện hành. Lý do từ chối trim, tối đa 500 ký tự; bỏ qua lưu rỗng, đổi sang trạng thái khác xóa lý do.

**Giao tin:** nhận các đơn `Xin nghỉ phép` mới và bù các đơn `Chưa duyệt` chưa gửi cho quản lý phù hợp; bỏ qua `Tự ý nghỉ (HR ghi nhận)`. Lease và trạng thái retry giữ việc đang dở qua restart, chống nhiều lượt quét cùng nhận một việc. Tin nhắn đã gửi được đồng bộ theo quyết định cuối cùng trong DB.

**Tương thích bot nhân viên:** `decision_notified_at` tiếp tục là cột bot xin nghỉ bên ngoài dùng để báo kết quả cho nhân viên. Bot quản lý không đánh dấu nó; trigger reset cột này khi đổi trạng thái vẫn giữ nguyên hợp đồng migration `0016`.

**Cầu DB → SSE:** `hr/hrLeaveDbRealtime.js` quét bản chụp/phiên bản dùng chung, tránh phụ thuộc cursor event tăng dần vì transaction có thể commit khác thứ tự ID. Tạo/đổi đơn bên ngoài repo được đưa vào SSE HR; kết nối/kết nối lại tải lại danh sách. `HR_LEAVE_DB_REALTIME_ENABLED=true` mặc định, độc lập với bot quản lý.

Phải áp migration này **trước khi chạy bản web mới**, kể cả khi bot quản lý tắt, vì repository đọc `decision_version`.

### Vai trò chỉ-đọc `reporting_readonly` (migration `0010`)

Role Postgres cấp cho nhân viên dùng SQL client/BI tool để truy vấn trực tiếp — xem chi tiết và cách đặt mật khẩu trong `0010_reporting_readonly_role.sql`. Role này được `GRANT SELECT` trên các bảng báo cáo KiotViet (liệt kê rõ tên bảng, không dùng `GRANT ... ON ALL TABLES`), **tuyệt đối không** trên `app_users` (chứa `password_hash`) hoặc `hr_employees` (PII nhân sự).

**Bắt buộc cho mọi migration tương lai**: vì migration `0010` có `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO reporting_readonly`, bất kỳ bảng mới nào chứa dữ liệu nhạy cảm (PII, secret, hash...) phải tự thêm `REVOKE SELECT ON <bảng> FROM reporting_readonly;` ngay trong migration tạo bảng đó — mặc định sẽ tự động được cấp quyền đọc nếu không revoke.

### Trạng thái xử lý công nợ (migration `0011`)

| Bảng | Mục đích | Khóa chính | Cột chính |
|---|---|---|---|
| `debt_collection_statuses` | Trạng thái thu nợ do Quản lý/Trợ lý cập nhật, tách khỏi workbook Google Sheets chỉ đọc | `(branch, customer_key)` | `status`, `alert_signature`, `updated_by_user_id`, `updated_by_name`, `updated_at` *(Không còn dùng từ 0047.)* |

- `branch` chỉ nhận `hanoi` hoặc `saigon`; route lấy giá trị từ session/middleware, không nhận cơ sở từ body client.
- `status` chỉ nhận `Chưa xử lý`, `Đang xử lý`, `Đã xử lý`, `Bỏ qua`.
- `alert_signature` là SHA-256 64 ký tự hex của cảnh báo và số nợ hiện tại. Khi chữ ký nguồn thay đổi, trạng thái kết thúc (`Đã xử lý`/`Bỏ qua`) không còn hiệu lực và dashboard mở lại khách ở `Chưa xử lý`.
- Migration thu hồi quyền `SELECT` của `reporting_readonly` trên bảng này vì có định danh người cập nhật; bảng không thuộc nguồn BI.

### Rollup báo cáo Dashboard theo ngày (migration `0013`)

| Bảng | Mục đích | Khóa chính | Cột chính |
|---|---|---|---|
| `daily_invoice_summary` | Doanh thu/số hóa đơn theo ngày, dùng cho biểu đồ "Doanh thu theo ngày" ở tab Tổng quan/Hóa đơn | `(branch, sale_date)` | `revenue`/`invoice_count` (chỉ `raw->>'statusValue' = 'Hoàn thành'`), `cancelled_count` (`statusValue = 'Đã hủy'`). **Doanh thu thực tế** hiển thị = `revenue` trừ tiền trả hàng `returns.total` (`statusValue = 'Đã trả'`, theo ngày trả) — tính lúc đọc trong `getInvoiceRevenueByDay`, KHÔNG lưu vào bảng này |
| `daily_product_sales` | Số lượng/doanh thu bán theo ngày của từng mã hàng, dùng cho "Top sản phẩm bán chạy" và doanh thu theo nhóm hàng | `(branch, sale_date, product_id)` | `qty`, `revenue` (mọi hóa đơn `statusValue != 'Đã hủy'`, tức gồm cả Phiếu tạm/Đang xử lý — **khác** điều kiện `daily_invoice_summary`) **đã TRỪ hàng khách trả**: mỗi dòng `return_details` của phiếu trả `Đã trả` là một dòng âm (số lượng + giá trị) vào đúng ngày trả của mã hàng đó, nên `qty`/`revenue` là số ròng và có thể âm ở ngày chỉ có trả hàng |

**Quan trọng — không được lọc theo số `status` trực tiếp**: mã số không có ý nghĩa cố định giữa các entity/cửa hàng (đối chiếu dữ liệu thật 2026-09-18 xác nhận `invoices.status=1` là "Hoàn thành", KHÔNG PHẢI `status=3` như giả định ban đầu — `status=3` thực ra là "Đang xử lý"). Luôn lọc qua `raw->>'statusValue'` (chuỗi thật từ KiotViet), không suy diễn số.
| `product_first_purchase` | Ngày nhập hàng đầu tiên của từng mã hàng (toàn bộ lịch sử, không giới hạn cửa sổ refresh) | `(branch, product_id)` | `first_purchase_date` (MIN, giữ mốc cũ hơn khi `ON CONFLICT` qua `LEAST`) |

- Cả 3 bảng không có cột `raw`, chỉ lưu số đã tổng hợp — tên/nhóm hàng/trạng thái hiện tại luôn join trực tiếp với `products`/`categories` tại thời điểm đọc, không lưu lại (bake) vào rollup để tránh phải tính lại khi đổi tên/nhóm.
- Refresh bởi `server/kiotvietSync/dashboardRollupRefresh.js`: lượt "nóng" 7 ngày sau mỗi lượt sync fast, lượt đầy đủ cửa sổ 400 ngày mỗi 30 phút cho `daily_invoice_summary`/`daily_product_sales`. `product_first_purchase` cần toàn bộ lịch sử `purchases` (ngày nhập đầu tiên có thể xa hơn 400 ngày) nên bản quét đầy đủ chỉ chạy lúc khởi động và mỗi 6 giờ; giữa hai lần đó chỉ xét phiếu nhập trong cửa sổ ngày gần đây.
- **Chỉ ghi dòng thật sự đổi**: mỗi cầu SQL gộp trước rồi `LEFT JOIN` vào bảng đích và bỏ dòng có giá trị y hệt (`IS DISTINCT FROM`), nên `updated_at` là "lần thay đổi gần nhất", không phải "lần tính lại gần nhất". Đừng đổi lại thành `ON CONFLICT DO UPDATE` vô điều kiện (kể cả thêm `WHERE` trong `DO UPDATE` cũng chưa đủ — Postgres vẫn khoá từng dòng trùng khoá và ghi WAL): bản cũ từng UPDATE ~115 triệu lần trên 62.000 dòng, sinh ~37GB WAL + ~115GB tệp tạm trong 34 ngày làm cạn Disk IO Budget của Supabase (2026-09-28).
- Bộ lọc ngày so sánh thẳng cột gốc với mốc `TIMESTAMPTZ` (không bọc `(cột AT TIME ZONE 'UTC')::date`) để dùng được các index ngày (migration `0021`).
- Không `REVOKE SELECT FROM reporting_readonly` trên 3 bảng này — dữ liệu chỉ là số tổng hợp, không nhạy cảm.

### Hoạt động công nợ theo kỳ CN1/CN3/CN7 (migration `0014`)

| Bảng | Mục đích | Khóa chính | Cột chính |
|---|---|---|---|
| `customer_debt_activity_periods` | Khách hàng có phát sinh giao dịch trong 1/3/7 ngày gần nhất (CN1/CN3/CN7, trước đây gọi là HN1/HN3/HN7), thay thế các tab Google Sheets cũ | `(branch, period_days, customer_id)` | `customer_name`, `refreshed_at` |

- Làm mới mỗi 5 phút bằng upsert-khi-đổi-tên + xoá dòng không còn trong tập hiện tại (không xoá hết rồi nạp lại), nên `refreshed_at` là "lần thay đổi gần nhất" của dòng.

### Index ngày cho job định kỳ (migration `0021`)

`idx_invoices_purchase_date (branch, purchase_date)`, `idx_purchases_purchase_date (branch, purchase_date)`, `idx_returns_return_date (branch, return_date)` — phục vụ rollup Dashboard và làm mới công nợ 1/3/7 ngày chỉ cần đọc vài ngày gần nhất (cùng `idx_cash_flows_trans_date` từ `0006`).

- `period_days` nhận một trong ba giá trị: `1`, `3`, `7` tương ứng kỳ CN1, CN3, CN7.
- Index lookup: `(branch, period_days, customer_name)`.
- Bảng chỉ lưu tập tên/ID cần thiết phục vụ cảnh báo "Chưa thu" trên màn hình Quản lý công nợ Dashboard; dữ liệu nguồn tính trực tiếp từ các bảng KiotViet (`invoices`, `returns`, `cash_flows`, `customers`) trong PostgreSQL.
- Làm mới tự động bởi scheduler job `server/kiotvietSync/customerDebtReportRefresh.js`.

### Xuất Excel đọc trực tiếp bảng nào

`POST /api/export` không đọc Google Sheets. Sau khi lấy danh sách mã dòng từ `getDashboardData()`, `dashboardPgReader.readRowsByCodes(tab, cơ sở, mã)` chạy một truy vấn lọc theo mã (`code = ANY($2::text[])`, mã là tham số) trên các bảng dưới đây; chỉ 5 nguồn sau được phép xuất (`EXPORT_SHEET_NAMES`), nguồn khác bị từ chối `EXPORT_SOURCE_NOT_ALLOWED`. Giao diện hiện dùng Hàng hóa, Hóa đơn và Khách hàng; Đặt hàng/Trả hàng vẫn đọc được ở tầng reader nhưng bảng xuất tương ứng đã bỏ cùng hai bảng của tab Hóa đơn (2026-10-01). Các bảng xuất tính sẵn (công nợ, báo cáo hàng hóa, tồn kho theo sản phẩm, đứt hàng…) không đi qua `readRowsByCodes` — xem `server/dashboard/exportService.js` (`TABLE_TITLES`). Nhãn/kiểu/mô tả cột nằm ở `server/dashboard/exportFieldCatalog.js`.

| Tab xuất | Bảng đọc chính | Bảng ghép thêm |
|---|---|---|
| Hàng hóa | `products` | (không; nhóm hàng, tồn kho lấy từ cột `raw` của chính bảng) |
| Hóa đơn | `invoices` | `staff` |
| Đặt hàng | `orders` | |
| Trả hàng | `returns` | |
| Khách hàng | `customers` | |

## Quan hệ và index

- Các bảng `invoice_details`, `invoice_payments`, `order_details`, `return_details`, `purchase_details` có foreign key ghép tới bảng cha cùng `branch`, với `ON DELETE CASCADE`.
- `returns.invoice_id` không có foreign key tới `invoices`, vì hai entity có thể được đồng bộ song song và phiếu trả có thể tới trước hóa đơn gốc.
- Index `(branch, modified_date)` tồn tại trên `invoices`, `orders`, `returns`, `purchases`.
- `cash_flows` dùng index `(branch, trans_date)`.

## Ba lưu ý bắt buộc cho Giai đoạn 2

1. `branch` là định danh nội bộ (`hanoi`/`saigon`), khác nhãn tiếng Việt trong `BRANCHES` và khác retailer code dùng để gọi API. Không trộn ba giá trị này.
2. `line_no` là vị trí phần tử trong mảng payload, đánh số từ 0, không phải ID KiotViet. Khi cập nhật một entity cha, phải xóa toàn bộ dòng con cũ rồi chèn lại. Nếu payload thật có ID dòng ổn định, chỉ thay đổi chiến lược bằng một migration mới sau khi đã xác minh.
3. `cash_flows` không có `modified_date`. Đồng bộ entity này phải dùng cửa sổ `startDate`/`endDate`; trạng thái cửa sổ được lưu trong `sync_checkpoints.note`, không dùng cơ chế `lastModifiedFrom` của các entity khác. Từ 07/10/2026, note là JSON `{windowEnd,reconciledAt}`: đối soát toàn lịch sử mỗi ngày, replay 7 ngày giữa các lần đối soát. Timestamp API không có zone được ghi với +07:00; đối soát tự sửa các cột chiếu account_id/status/trans_date bị phiên server cũ ghi sai.

## Một lưu ý bắt buộc cho Giai đoạn 3 (backfill)

`backfill_progress` (migration `0008`) lưu tiến độ chạy `backfill.js` theo `(branch, entity, chunk_key)`,
`chunk_key` là `'YYYY-MM'` cho entity có `backfillRangeParam` (chia theo tháng) hoặc `'full'` cho entity
chạy 1 lượt duy nhất. Bảng này **độc lập hoàn toàn** với `sync_checkpoints` — polling (Giai đoạn 2) không
đọc/ghi bảng này, và backfill không đọc/ghi `sync_checkpoints`. Ghi trùng dữ liệu nghiệp vụ giữa 2 tiến
trình là an toàn vì mọi bảng dùng `UPSERT` theo `(branch, id)`.

### Báo cáo hàng hóa (migration `0018`)

`product_report` là bảng tổng hợp cho tab "Tổng quan" — cùng ngoại lệ như các bảng rollup ở migration `0013` (không có `raw`, khóa chính không bắt đầu bằng `branch` vì mỗi dòng gộp dữ liệu **cả 2 cơ sở** cho 1 mã hàng). Khóa chính là `product_code`. Được `TRUNCATE` + nạp lại toàn bộ **đúng 1 lần/đêm** bởi `server/kiotvietSync/productReportRefresh.js` (không phải mỗi 5 phút như các rollup khác — truy vấn quét 90 ngày hóa đơn cả 2 cơ sở là nặng, xem comment đầu file đó), route `GET /api/product-report` chỉ đọc thẳng bảng này.

Cột `available_to_sell` (công thức **Tồn có thể bán**) = tồn 2 cơ sở **trừ** số lượng đang bị giữ trong **đơn đặt hàng Phiếu tạm của khách** (bảng `orders`, `raw->>'statusValue' = 'Phiếu tạm'`). Từ 2026-10-06 KHÔNG còn cộng hàng đang vận chuyển (giai đoạn 2026-10-01→05 có cộng phiếu "Đặt hàng nhập" `order_suppliers` trạng thái `Đã xác nhận NCC`; SQL đó vẫn nằm ở `server/dashboard/inTransitSource.js` cho cột Vận chuyển / Vòng đời đơn hàng). Trước 2026-10-01 công thức là tồn − Khách đặt (3 trạng thái `Phiếu tạm`/`Đang xử lý`/`Đã xác nhận`); file migration `0018` KHÔNG sửa, công thức hiện hành nằm ở `productReportRefresh.js`. Cột không kẹp về 0 (hàng bị giữ quá tồn hiện số âm). Cột `qty_sold_30d`/`revenue_90d` cộng từ `daily_product_sales` (migration `0013`) trong cửa sổ kết thúc **hôm qua** theo lịch VN (không tính hôm nay). Cột `customer_count_90d`/`top_customer_*` tính trực tiếp từ `invoice_details`/`invoices`/`customers` trong 90 ngày, dùng chung định nghĩa "hóa đơn hợp lệ" (`statusValue != 'Đã hủy'`) với `revenue_90d` để `top_customer_share` không bao giờ vượt 100%.

`product_report_customers` (migration `0023`) là bảng phụ của `product_report`: doanh số 90 ngày của **từng khách theo từng mã hàng**, phục vụ khung "Chi tiết" dưới bảng "Báo cáo hàng hóa" (`GET /api/product-report/customers?code=`). Khóa chính `(product_key, customer_key)` với `product_key = lower(btrim(mã hàng))`, `customer_key` = `code:<mã khách>` hoặc `name:<tên khách>` (khách không có mã, gồm cả "Khách lẻ"). Được ghi **trong cùng 1 câu lệnh** `INSERT` của `productReportRefresh.js` (CTE `customer_agg` `MATERIALIZED` đọc 2 lần) nên khớp tuyệt đối với `customer_count_90d`/`top_customer_*` và không quét thêm 90 ngày hóa đơn. Bảng rỗng đến khi job đêm chạy sau khi áp migration — sau khi deploy chạy tay `node kiotvietSync/productReportRefresh.js` (trong `server/`).

### Lịch sử giá trị tồn kho (migration `0025`)

`inventory_value_snapshots` lưu `stock_value` của từng cơ sở theo từng ngày lịch VN. Tồn kho trong DB (`products.raw->'inventories'`) chỉ là trạng thái hiện tại nên không dựng lại được quá khứ; job `kiotvietSync/inventoryValueSnapshot.js` chụp **1 lần/ngày lúc 23:59 giờ VN** (kiểm tra mỗi phút, `INSERT ... ON CONFLICT DO NOTHING` nên chạy trùng vô hại). Bắt đầu từ tối 2026-09-30; trước đó không có số liệu.

- Công thức giữ nguyên KPI "Giá trị tồn kho" của tab Hàng hóa: mỗi mã hàng `max(tổng onHand, 0) × max(giá vốn trung bình, 0)`, chỉ hàng đang kinh doanh (`is_active IS NOT FALSE`), bỏ mã bắt đầu `VAT`. Tổng hai cơ sở = số "Cả hai".
- Lỡ 23:59 (server tắt): khi chạy lại, nếu bảng đã có dữ liệu, thiếu bản chụp của hôm qua và giờ VN < 12:00 thì chụp bù và gán `snapshot_date` = hôm qua (`captured_at` là thời điểm thật). Qua 12:00 thì để trống ngày đó.
- Đọc qua `GET /api/inventory-value-history?from=&to=` (quyền `reports.overview`, lọc theo cơ sở đang xem); bảng chưa tồn tại (chưa áp migration) thì API trả rỗng.

### Chi tiết hóa đơn 90 ngày theo khách (migration `0022`)

`customer_invoice_lines_90d` là bảng tổng hợp phục vụ "Báo cáo doanh thu theo khách" (mục 2 của tab Tổng quan, `GET /api/customer-product-revenue`; tab Khách hàng cũ đã gỡ 2026-10-16). Mỗi dòng là **1 dòng chi tiết hóa đơn** (`invoice_details`) của hóa đơn `Hoàn thành` đã gắn sẵn mã khách, **cộng thêm các dòng ÂM của phiếu trả `Đã trả`** (`return_details`, theo ngày trả, `invoice_id = -returns.id`, `invoice_code` = mã phiếu trả) để doanh thu/số lượng theo khách là số ròng; sau khi đổi logic này cần chạy lại `node kiotvietSync/customerInvoiceLinesRefresh.js` một lần (job đêm chỉ dựng 1 lần/ngày); khóa chính `(branch, invoice_id, line_no)`, index tra cứu `(branch, customer_code)`. Không có `raw` (không phải bản sao 1-1 từ KiotViet). `customer_invoice_lines_state` chỉ có 1 dòng (`id = 1`): cửa sổ `window_start..window_end`, `row_count`, `computed_at`; dòng này chưa tồn tại nghĩa là bảng **chưa từng được dựng** và API tự quay về cách tính cũ từ sheet.

- Được dựng lại **1 lần/đêm** bởi `server/kiotvietSync/customerInvoiceLinesRefresh.js` (kiểm tra mỗi 5 phút, chỉ chạy khi chưa dựng cho ngày VN hôm nay **và** đã qua 00:10 VN để hóa đơn cuối ngày kịp đồng bộ; khởi động lại giữa ngày mà bảng cũ từ hôm qua thì dựng bù ngay). Cũng chạy tay được: `node kiotvietSync/customerInvoiceLinesRefresh.js` (trong `server/`).
- Cửa sổ là 90 ngày kết thúc **hôm qua** theo lịch VN (khác luồng sheet cũ, cửa sổ kết thúc hôm nay) nên hóa đơn phát sinh trong ngày chỉ hiện từ đêm sau; giao diện ghi rõ "90 ngày đến hết dd/mm/yyyy".
- Không `TRUNCATE` + nạp lại: nạp vào bảng tạm rồi chỉ `DELETE` dòng đã mất/đã đổi và `INSERT` dòng mới, trong 1 giao dịch (lý do IO: xem sự cố Supabase 2026-09-28). Đọc song song vẫn thấy bản cũ tới lúc COMMIT.
- `customer_code` giữ đúng luồng cũ: `raw->>'customerCode'` trên hóa đơn; nếu trống thì đối chiếu **tên khách chuẩn hóa** (NFKC, bỏ ký tự rỗng, gộp khoảng trắng, chữ thường) với bảng `customers` cùng cơ sở (trùng tên ⇒ mã lớn nhất). Bước đối chiếu theo SĐT của luồng cũ không còn vì cột "SĐT khách" của tab Hóa đơn luôn rỗng trong Postgres.
- `sold_date` theo "giờ treo tường VN mang nhãn UTC" của `purchase_date`; `revenue` dùng `DETAIL_AMOUNT_SQL` (`subTotal` nếu có, không thì giá × SL − giảm giá); `item_code`/`item_name` lưu giá trị thô, phía đọc tự trim và thay bằng `—` khi trống.
- Không REVOKE SELECT khỏi `reporting_readonly` (không lưu SĐT; mã/tên khách và doanh thu vốn đã đọc được qua `invoices`/`customers`).

### Trả NCC upload Excel (migration `0017`)

`supplier_return_imports` là bảng phẳng lưu dữ liệu xuất từ KiotViet ("Trả hàng nhập") do người dùng tự upload file Excel. Không có quan hệ parent+detail như `invoices`/`purchases`.

| Cột | Kiểu | Ghi chú |
|---|---|---|
| `id` | BIGSERIAL PK | |
| `branch` | TEXT | `hanoi`/`saigon` |
| `product_code` | TEXT | Mã hàng KiotViet |
| `product_name` | TEXT | Tên hàng tại thời điểm import |
| `return_date` | DATE | Ngày trả |
| `quantity` | NUMERIC | Số lượng trả |
| `imported_at` | TIMESTAMPTZ | Thời điểm import |
| `imported_by` | TEXT | Tên/username người thực hiện upload |
| `source_file` | TEXT | Tên file Excel nguồn |

- Mỗi lần upload cho 1 cơ sở **thay thế toàn bộ** dữ liệu cũ của cơ sở đó (`DELETE` rồi `INSERT` lại — xem `supplierReturnImportService.js`).
- Index `(branch, product_code, return_date)` phục vụ pipeline kiểm tra đứt hàng (`stockoutPgSource.js`).
- Không REVOKE SELECT khỏi `reporting_readonly` (không chứa PII, tương tự `purchases`/`returns`).

### Phân quyền tính năng theo tài khoản (migration `0019`–`0020`)

**Migration `0019`**: Bổ sung vai trò `Nhân viên marketing` vào constraint CHECK `app_users.vai_tro`. Constraint cũ bị DROP và tạo lại với danh sách đầy đủ: `Quản lý`, `Kế toán`, `Trưởng kho`, `Trợ lý`, `Lái xe`, `Nhân viên kho`, `Nhân viên sale`, `Nhân viên marketing`, `Nhân viên mua hàng`, `Khách`.

**Migration `0020`**: Thêm cột `app_users.feature_permissions JSONB NOT NULL DEFAULT '{}'` để lưu **delta** quyền tính năng so với mặc định của vai trò. Ví dụ `{"reports.debt": false, "reports.overview": true}`. Logic phân quyền thực tế nằm ở `server/auth/featureRegistry.js` — bảng chỉ lưu phần override cá nhân, không snapshot toàn bộ quyền của vai trò.

### Dọn dẹp suppliers và rollup mua hàng (migration `0026`)

Gỡ bỏ tab "Nhà cung cấp" khỏi dashboard:
- `DROP TABLE IF EXISTS daily_purchase_summary;`
- `DROP TABLE IF EXISTS suppliers;`
- Xóa bản ghi tiến độ trong `sync_checkpoints` và `backfill_progress` với `entity = 'suppliers'`.
- Các bảng `purchases`, `purchase_details`, `product_first_purchase` vẫn được giữ nguyên để phục vụ tab Hàng hóa và cảnh báo đứt hàng.

### Quản lý tài liệu quy định công ty (migration `0027`)

Bảng `hr_rule_documents` lưu trữ tài liệu quy định công ty (tài liệu dựng sẵn, file PDF upload, và từ migration `0060` là tài liệu Quản lý gõ trực tiếp):
- `kind`: `builtin` (dựng sẵn, `builtin_key` NOT NULL, `content`/`body` NULL), `pdf` (tài liệu tải lên, lưu trong `content` BYTEA) hoặc `text` (Quản lý gõ tay, lưu HTML đã lọc trong `body`, `content`/`file_name`/`size_bytes`/`sha256` NULL). Hình dạng mỗi `kind` ép bằng CHECK `hr_rule_documents_kind_shape`.
- Gồm `title`, `sort_order`, `file_name`, `size_bytes`, `sha256`, `body`, `uploaded_by_user_id`, `uploaded_by_name`, `updated_at`, `updated_by_name` (2 cột cuối chỉ dùng cho `kind='text'` — tài liệu gõ tay sửa tại chỗ qua `PUT .../:id/text`, khác PDF chỉ thay-mới-xóa-cũ).
- Seed 4 tài liệu mặc định: `gio-giac` (Giờ giấc làm việc, sort 10), `nghi-phep` (Quy định nghỉ phép, sort 20) và `phuc-loi` (Chi tiêu & Phúc lợi, sort 30 — thêm ở migration 0039) và `treo-hang` (Quy định treo hàng, sort 40 — thêm ở migration 0049).
- Thu hồi quyền `SELECT` của `reporting_readonly` do chứa tài liệu nội bộ.

**Rich text (migration `0061`):** `body` của `kind='text'` từ chỗ văn bản thuần (hiển thị `textContent`) nâng thành HTML đã lọc qua whitelist XSS (`hr/hrRuleDocumentSanitizer.js`, thư viện `sanitize-html`) rồi hiển thị bằng `innerHTML` — an toàn vì mọi nội dung đã qua lọc trước khi lưu, không phải chèn thẳng input người dùng vào DOM. Thẻ cho phép: `p div br hr b strong i em u s strike h1 h2 h3 h4 ul ol li span a table thead tbody tr th td img` (soạn Word-style: tiêu đề h1-h4, gạch ngang hr, bảng, ảnh — thêm `div/h3/h4/hr` để hỗ trợ toàn bộ nội dung 4 tài liệu dựng sẵn chuyển sang ở migration `0065`); `style` chỉ nhận `color`/`background-color`/`font-weight`/`font-style`/`text-decoration` trên `span` và `text-align` trên các thẻ khối (`p/div/h1-h4`); `<a href>` chỉ http/https, luôn ép `rel="noopener noreferrer" target="_blank"`; `<img src>` chỉ nhận đúng dạng `/api/hr/rules/documents/:id/images/:imageId` (chặn ảnh từ domain ngoài — tránh rò IP người xem qua request ảnh). `script/style/iframe/object/embed/svg/form/noscript` bị loại cả thẻ lẫn nội dung bên trong (`nonTextTags`), các thẻ khác ngoài whitelist bị loại thẻ nhưng giữ chữ bên trong.
- `body_check` CHECK nâng từ 20.000 lên **200.000 ký tự** (HTML tốn chỗ hơn văn bản thuần; ảnh đã tách khỏi `body` nên không tính vào giới hạn này).
- Dữ liệu `kind='text'` có sẵn trước `0061` được chính migration chuyển sang HTML tương đương: thoát `& < > "` rồi đổi `\n` → `<br>`, không mất nội dung.
- Bảng mới `hr_rule_document_images`: `id`, `document_id` (FK `hr_rule_documents(id)` `ON DELETE CASCADE`), `content` BYTEA, `content_type` (`image/png|jpeg|gif|webp`), `size_bytes` (CHECK ≤ 5.242.880 = 5 MB), `sha256` (ETag), `created_at`. Ảnh gửi lên dạng Data URI, server tách ra bảng này rồi thay `src` bằng đường dẫn thật (`hr/hrRuleDocumentImages.js`) **trong cùng 1 transaction** với việc lưu/sửa `hr_rule_documents` — tạo tài liệu mới chèn placeholder `body='<p></p>'` lấy `id` trước, sửa tài liệu khóa dòng bằng `SELECT ... FOR UPDATE` và xác nhận tồn tại trước khi tách ảnh (tránh vi phạm FK thành lỗi 500 thay vì 404 khi sửa id không tồn tại). Ảnh không còn được nhắc tới trong `body` mới bị xóa tự động khi sửa tài liệu (`pruneUnreferencedImages`). Thu hồi quyền `SELECT` của `reporting_readonly`.
- API tạo/sửa (`POST`/`PUT .../text`) gọi `repo.isRichTextReady()` (kiểm `to_regclass('public.hr_rule_document_images') IS NOT NULL` **và** cột `icon_key` tồn tại — xem migration `0062`) trước khi ghi, trả `503 RULE_DOC_RICH_TEXT_NOT_READY` nếu `0061`/`0062` chưa áp đủ cả hai — tránh code rich text deploy trước migration ghi dữ liệu không khớp schema.

**Icon tài liệu (migration `0062`):** cột `icon_key` (TEXT, CHECK enum 8 giá trị cố định: `clock calendar gift box info warning document users`) trên `hr_rule_documents`, chỉ dùng cho `kind='text'`. Hoàn toàn tách khỏi `body` — người dùng CHỌN từ danh sách có sẵn (như chọn emoji), không gõ tay được, nên **không đi qua bộ lọc XSS và không tăng bề mặt tấn công** dù giá trị cuối cùng được dùng để chọn SVG hiển thị. Validate qua `hr/hrRuleDocumentIcons.js` (`normalizeIconKey`, giá trị không hợp lệ/rỗng → `NULL`, không báo lỗi). Danh sách SVG thật nằm trong code frontend (`ICON_DEFS` ở `public/humanresources/index.html`) — markup tin cậy do lập trình viên viết, không phải dữ liệu người dùng. Sửa danh sách icon phải đổi đồng thời 3 nơi: CHECK của migration, `ALLOWED_ICON_KEYS` và `ICON_DEFS`.

**Chuyển 4 tài liệu dựng sẵn sang `kind='text'` (migration `0065`, 17/10/2026):** để Quản lý sửa được qua web (trước đây 4 tài liệu `gio-giac/nghi-phep/phuc-loi/treo-hang` là HTML tĩnh hard-code trong `public/humanresources/index.html`, chỉ sửa được bằng deploy code). Mỗi `UPDATE` set `kind='text'`, `builtin_key=NULL`, `icon_key` tương ứng (`clock/calendar/gift/box` — giữ nguyên icon cũ), `body` là HTML gốc đã chạy qua `sanitizeRuleDocumentHtml()` thật. `DEFAULT_BUILTIN_DOCUMENTS` rút về rỗng để không tạo lại dòng trùng sau chuyển đổi; `LEGACY_BUILTIN_DOCUMENTS`, bốn khối HTML tĩnh và `RULE_DOC_BUILTINS` được giữ riêng làm fallback chỉ đọc. Vì vậy code có thể deploy trước migration hoặc chạy local không có DB mà vẫn hiển thị đủ nội dung cũ; chỉ thao tác sửa/lưu bị khóa cho tới khi DB sẵn sàng.

**Dọn artifact table-controls trong rich text (migration `0066`, 19/10/2026):** một số bảng trong editor từng bị tiện ích chung chèn nút “Cột hiển thị”. Sanitizer cũ bỏ button/svg nhưng giữ chữ thành `<div>Cột hiển thị</div>`, khiến nhãn giao diện bị lưu vào `body`. Migration chỉ xóa phần tử `div/p/span` độc lập có đúng nhãn này; câu văn hợp lệ có cùng cụm từ không bị thay đổi. Frontend và sanitizer cũng chặn tái phát.

### Lịch sử chỉnh sửa tài khoản (migration `0040`)

Bảng `account_audit_log` ghi thao tác **quản trị** tài khoản ở `auth/adminUserRoutes.js` (module `auth/accountAuditLog.js`), đọc ở tab "Lịch sử chỉnh sửa" (`/account/#history`, `GET /api/admin/audit-log`, quyền `account.users`):
- `action`: `create` / `update` / `reset_password` / `delete` / `permissions`.
- Người sửa (`actor_user_id`, `actor_username`, `actor_name`) và tài khoản bị sửa (`target_*`) được **chụp lại lúc ghi**, không FK tới `app_users` để lịch sử còn sau khi xóa tài khoản.
- `changes` JSONB mảng `{field, label, before, after}`; sửa quyền ghi `{field: "permissions", added, removed}` theo nhãn quyền tiếng Việt (quyền hiệu lực trước/sau). Không bao giờ chứa mật khẩu.
- Chỉ thêm: trigger `account_audit_log_guard` chặn UPDATE/DELETE. Thu hồi `SELECT` của `reporting_readonly` (chứa email/SĐT).
- Không ghi: tự sửa hồ sơ, duyệt yêu cầu đổi vai trò, thay đổi do hệ thống (đồng bộ nhân sự).

### Chỉ mục đơn Phiếu tạm cho Vòng đời đơn hàng (migration `0028`)

`idx_orders_phieu_tam` là chỉ mục **một phần** `ON orders (branch, id) WHERE raw->>'statusValue' = 'Phiếu tạm'`. Trang Vòng đời đơn hàng (`shipment/kiotOrdersRepository.js`) đọc dòng hàng của mọi đơn Phiếu tạm của Kiot HN + SG (~1.000 đơn, ~2.500 dòng hàng ở thời điểm 2026-10-01); bảng `orders` có ~46K dòng JSON lớn nên không có chỉ mục thì mỗi lần đọc nguội mất vài giây (đo ~4 giây, vì quét tuần tự). (Từ 2026-10-02 trang còn đọc **đầu đơn của mọi trạng thái** ~60K dòng bằng một truy vấn quét toàn bảng ~2 giây — truy vấn đó không dùng được chỉ mục này nên được cache 2 phút thay vì lọc ở DB.) Điều kiện `WHERE` của truy vấn phải giữ **y hệt** biểu thức trên (so chuỗi `statusValue`, không so số `status`) thì planner mới chọn được chỉ mục. Code chạy đúng cả khi chưa áp migration, chỉ chậm hơn; kết quả đọc được cache 60 giây trong tiến trình.

### Gỡ trạng thái "Tạm duyệt" của đơn nghỉ phép (migration `0030`)

`0030_drop_leave_provisional_status.sql` chuyển mọi đơn `hr_leave_requests.trang_thai = 'Tạm duyệt'` về `Chưa duyệt` (trigger sẵn có tự tăng `decision_version` và xóa `decision_notified_at` nên bot quản lý/nhân viên nhận lại đúng trạng thái), rồi đặt lại CHECK `hr_leave_requests_trang_thai_check` chỉ còn `Chưa duyệt`, `Đã duyệt`, `Từ chối`, `Vi phạm`. Mã web và bot quản lý đã bỏ `Tạm duyệt` khỏi danh sách hợp lệ nên migration phải áp **trước** khi chạy bản web mới. Bot xin nghỉ ngoài repo không được ghi giá trị này nữa.

### Phạm vi duyệt và snapshot phòng ban (migration `0031`)

- `app_users.leave_approval_departments TEXT[] NOT NULL DEFAULT '{}'`: grant rõ ràng, chuẩn hóa NFC/khoảng trắng/không phân biệt hoa thường. Cấp quản lý hiện có toàn bộ phòng ban một lần; nhân viên đã có quyền cấp phòng ban hồ sơ hiện tại. Không tự đổi theo hồ sơ.
- `hr_leave_requests.bo_phan TEXT NOT NULL DEFAULT ''`: bổ sung đơn cũ từ HR hiện tại. Trigger BEFORE INSERT điền từ `hr_employee_id` hoặc HR của `user_id` khi trống; BEFORE UPDATE giữ snapshot cũ. Bot nhân viên tiếp tục INSERT hợp đồng cũ. Không xác định phòng ban dùng dự phòng. Index `(branch,bo_phan,thoi_gian_gui DESC)` từng phần cho chờ/Vi phạm.
- `hr_manager_telegram_cards`: card `/donnghi`, FK đơn/tài khoản, PK `(telegram_chat_id,message_id)`, `expected_version BIGINT`, `created_at`; tách khỏi lease/bản tin tự động. REVOKE SELECT từ `reporting_readonly`.
- Người duyệt đang hoạt động, có `hr.leave.manage`, phòng ban được cấp và cơ sở được gán phù hợp với đơn; nhân viên được cấp quyền cũng được duyệt và được tự duyệt. Gửi tất cả người phù hợp, một quyết định thành công chốt phiên bản. Nếu không có người phù hợp, dùng quản trị cao nhất đang hoạt động; thiếu cả dự phòng thì giữ chờ và cảnh báo. Telegram ID/Start chỉ quyết định khả năng giao tin, không quyết định có người duyệt web.
- Đơn web tự gửi `source=web`, `user_id`/`hr_employee_id`, tên/phòng ban/cơ sở do server xác định; sự kiện DB tạo hàng giao Telegram sau. Web và Telegram đều yêu cầu phiên bản, web mở lại được, Telegram khóa kết quả.

Đơn tự gửi web lấy `telegram_chat_id` từ liên kết tài khoản trên server. Khi quyết định đơn `source=web` không có chat, service đặt `decision_notified_at` để bot nhân viên không thử gửi tới chat rỗng; thông báo web vẫn được tạo. Với đơn có chat và đơn từ bot nhân viên, chu kỳ NULL → gửi kết quả → đánh dấu và reset khi đổi trạng thái giữ nguyên.

Migration `0032_hr_department_groups.sql` gộp `BAN QUẢN LÝ`/`TRƯỞNG CHI NHÁNH` thành `BAN QUẢN TRỊ`, `HẬU CẦN`/`BẢO VỆ` thành `HẬU CẦN - BẢO VỆ` trong nhân sự, snapshot đơn nghỉ và phạm vi duyệt phép (gộp mục trùng). Vai trò tài khoản và quyền tính năng giữ nguyên; Ban quản trị suy ra Quản lý, Hậu cần - Bảo vệ suy ra Khách theo chính sách hiện tại. Chạy migration trước khi khởi động bản web mới.

## Sổ quỹ — migration 0033

- cash_flows thêm account_id BIGINT và status INTEGER (0 đã thanh toán, 1 đã hủy); amount giữ NUMERIC đã có dấu theo 0012. Backfill raw AccountId/accountId và Status/status theo lô 20.000 dòng, chỉ UPDATE account_id IS NULL; con trỏ (branch,id) vẫn tiến qua phiếu tiền mặt.
- cash_book_accounts: id BIGINT PRIMARY KEY; bank_name/account_no/description TEXT; raw JSONB NOT NULL; synced_at TIMESTAMPTZ NOT NULL DEFAULT now(). Danh mục chung toàn công ty, lấy cả endpoint HN và SG khi bảng trống lúc startup và mỗi 24 giờ. Không đặt tên giả cho tài khoản thiếu danh mục.
- cash_book_checkpoints: id BIGSERIAL PRIMARY KEY; account_id BIGINT nullable (NULL = tiền mặt); checkpoint_at TIMESTAMPTZ NOT NULL; balance NUMERIC NOT NULL; system_balance/diff NUMERIC nullable; note TEXT; created_by TEXT NOT NULL; created_at TIMESTAMPTZ NOT NULL DEFAULT now(). Không có FK tài khoản để giữ ID lịch sử, kể cả -1.
- Index idx_cash_flows_account_date (account_id,trans_date), idx_cash_book_checkpoints_account (account_id,checkpoint_at DESC).
- Reconcile tài khoản đối chiếu tập ID hiện tại từ retailer được chọn với bảng chung; tài khoản retailer khác và ID lịch sử không làm sai số đếm.

## Sổ quỹ — migration 0034

- cash_book_account_banks: account_no TEXT PRIMARY KEY; bank TEXT NOT NULL; updated_by TEXT; updated_at TIMESTAMPTZ NOT NULL DEFAULT now(). Tên ngân hàng do Quản lý nhập tay trên trang Sổ quỹ (KiotViet bankaccounts chỉ có bankName = tên chủ TK, không có ngân hàng). Khóa theo số tài khoản nên HN và SG cùng số TK dùng chung một giá trị; đồng bộ KiotViet không ghi đè. Không FK tới cash_book_accounts.

## Sổ quỹ — migration 0035

- `cash_flows.source_missing_at TIMESTAMPTZ` mặc định NULL. Đối soát đủ ID đánh dấu các ID nguồn đã thay thế/loại bỏ trong đúng cơ sở và tới đúng thời điểm; giữ nguyên toàn bộ lịch sử và raw, không xóa bản ghi. Các truy vấn Sổ quỹ và hoạt động công nợ bỏ qua dòng có dấu này. Upsert nguồn tự đặt lại NULL nếu ID xuất hiện lại.
- Cash nhận diện theo method (có thể vẫn giữ account_id lịch sử); phương thức khác thiếu tài khoản ở nhóm unassigned. Timestamp cash_flows là thời điểm UTC thật, khác hợp đồng giờ tường của invoices/returns; hoạt động công nợ chuyển riêng trans_date sang giờ tường +7 giờ trước khi ghép các nguồn.

## Báo cáo kinh doanh — migration 0036

Doanh số **theo tháng đã chốt cứng** cho tab "Báo cáo kinh doanh" (Báo cáo tổng hợp). Doanh số = tổng hóa đơn `Hoàn thành` (`invoices.total`, đã trừ giảm giá cả đơn) − tổng phiếu trả `Đã trả` (`returns.total`) theo tháng của ngày bán/ngày trả. `month` luôn là **ngày 1** của tháng lịch VN (CHECK `EXTRACT(DAY FROM month) = 1`). Tháng hiện tại KHÔNG nằm trong các bảng này: API tính trực tiếp bằng cùng câu SQL. Chốt tháng vừa qua lúc ≥ 00:10 VN ngày mùng 1 và backfill từ 2026-03 lần đầu. Khách = `(branch, customer_code)`: cùng mã ở HN và SG là 2 khách khác nhau; `customer_code = ''` là Khách lẻ / không đối chiếu được. Sale KHÔNG lưu ở bảng khách: lịch sử đi theo nhóm HIỆN TẠI (`customers.raw->>'groups'`), bảng sale được dựng lại khi nhóm đổi. Không cần GRANT riêng (`ALTER DEFAULT PRIVILEGES` ở `0010`).

| Bảng | Mục đích | Khóa chính | Cột chính |
|---|---|---|---|
| `business_monthly_customer_sales` | Doanh số từng khách theo tháng | `(month, branch, customer_code)` | `customer_id` (BIGINT, nullable; khách hiện tại cùng cơ sở/mã trim, ID mới nhất), `customer_name`, `invoice_amount`, `return_amount`, `net_revenue`, `invoice_count`, `return_count`; `branch` ∈ `hanoi`/`saigon` |
| `business_monthly_customer_product_sales` | Doanh số khách × mã hàng theo tháng — tổng chung từ được phân bổ cho từng dòng theo tỷ lệ thành tiền nên tổng theo mã = tổng theo khách (lệch vài đồng do làm tròn) | `(month, branch, customer_code, product_code)` | `product_name`, `net_revenue`, `net_qty`; index `business_monthly_cps_product_idx (product_code, month)` cho panel "top khách của 1 mã hàng" |
| `business_monthly_product_sales` | Doanh số từng mã hàng theo tháng (gộp cả 2 cơ sở) | `(month, product_code)` | `product_name`, `net_revenue`, `net_qty` |
| `business_monthly_sale_sales` | Doanh số từng sale theo tháng | `(month, sale_name)` | `net_revenue`, `customer_count` (số khách có doanh số ≠ 0 trong tháng; "SL Khách" trên UI là số khách hoạt động = TB 4 tháng > 0, tính lúc đọc), `refreshed_at` |
| `business_monthly_state` | 1 dòng / tháng đã chốt; không có dòng = tháng chưa chốt (API tính trực tiếp) | `month` | `frozen_at`, `customer_rows`, `customer_product_rows`, `net_revenue`, `group_hash` (TEXT nullable) |

- Job ghi: `kiotvietSync/businessMonthlyRefresh.js`. Module đọc: `businessReport/businessReportRepository.js`.
- Spec: `docs/superpowers/specs/2026-10-07-business-report-design.md`.

- `group_hash` bam nhom hieu luc theo (branch, btrim(code)), ID moi nhat; nhom rong la "Chua phan nhom" (nhan UI giu nguyen). Freeze/refreeze ghi khach, ma hang, sale, state va hash trong mot giao dich REPEATABLE READ; loi bat ky buoc nao rollback toan bo, lan sau thu lai. Kiem tra dinh ky chi dung sale khi hash doi. Khoa state/khach thang cung thu tu de tuan tu hoa freeze/rebuild; snapshot giu nguon va nhom/hash nhat quan, khong khoa bang nguon customers de chan sync. State cu co hash NULL/khong hop le bao notReady; API gom sale tu doanh so khach da chot va nhom hien tai cho den khi job sua hash. Reader doc state/khach/ma/sale/danh ba trong mot giao dich REPEATABLE READ READ ONLY, ROLLBACK/release sau doc; moi cap truy van live dung mot giao dich doc rieng cung che do. SAVEPOINT chi khoi phuc loi thieu bang monthly; loi nguon/quyen/ket noi van truyen ra. Restart giu hash nen khong dung lai khi nhom giu nguyen.

## Team của sale — migration 0037

Bảng `sale_teams` (`sale_name` PK, `team_name`, `updated_at`) cho cột **Team** và bộ lọc team ở bảng "Doanh số theo sale" của tab Báo cáo kinh doanh. `sale_name` = tên nhóm khách trên KiotViet; so khớp theo khóa chuẩn hóa (NFKC, gộp khoảng trắng, chữ thường) nên "BÍCH TRÂN" khớp "Bích Trân" và hai nhóm gộp làm một dòng sale. Sale không có trong bảng (kể cả "Chưa phân nhóm") hiện team **"Chưa có team"**; bảng chưa migrate thì mọi sale ở "Chưa có team" (báo cáo vẫn chạy). Migration nạp sẵn 58 dòng từ file `chia team.xlsx` (2026-10-07). Cập nhật khi đổi team: `node scripts/importSaleTeams.js <file.xlsx>` (trong `server/`; cột A = Sale, cột B = Team, THAY TOÀN BỘ bảng trong 1 giao dịch, sẽ ghi đè chỉnh tay). Từ 2026-10-16 Quản lý (quyền `reports.business.editTeam`) đổi team từng sale bằng dropdown ở bảng Tăng trưởng Sale (`PUT /api/business-report/sale-team`: xóa các dòng cùng khóa chuẩn hóa rồi chèn lại; team rỗng/"Chưa có team" = xóa dòng); `updated_at` lấy mặc định `now()`.

Cùng đợt: khách ở bảng "Doanh số theo khách" được **gộp theo tên chuẩn hóa** (HN + SG, nhiều mã) — không lưu trong DB, gộp ở `businessReportService.js`; bảng `business_monthly_*` vẫn khóa theo `(branch, customer_code)`. Spec: `docs/superpowers/specs/2026-10-07-business-report-teams-merge-design.md`.

## Trạng thái làm việc của nhân sự — migration 0041

Cột `hr_employees.employment_status TEXT NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'resigned'))` tách biệt trạng thái làm việc thực tế khỏi cờ xóa mềm `is_active`:
- `active` = Đang làm việc (mặc định cho toàn bộ nhân sự hiện tại).
- `resigned` = Đã nghỉ việc. Nhân sự đã nghỉ việc vẫn hiển thị trên tab Danh sách nhân sự với nhãn "Đã nghỉ việc", vẫn giữ email và SĐT để tránh tạo trùng hồ sơ.
- Cơ chế khóa tài khoản tự động: khi chuyển trạng thái nhân sự sang `resigned`, service `hrEmployeeAdminService.js` tự động tìm tài khoản đăng nhập liên kết (`app_users.hr_employee_id`) và khóa với `trang_thai = 'Bị khóa'`, `lock_reason = 'hr_resigned'`. Khi chuyển lại sang `active`, hệ thống chỉ tự động mở khóa các tài khoản bị khóa đúng do lý do `hr_resigned`, bảo toàn các tài khoản bị khóa vì lý do khác.

## Đơn nghỉ phép cho tài khoản nội bộ chưa gắn nhân sự — migration 0042

Migration `0042_hr_leave_unlinked_accounts.sql` gỡ bỏ ràng buộc bắt buộc có hồ sơ nhân sự khi gửi đơn xin nghỉ:
- `ALTER TABLE hr_leave_submissions ALTER COLUMN hr_employee_id DROP NOT NULL;`
- Cập nhật trigger `hr_leave_submission_snapshot()`:
  - Cho phép tài khoản nội bộ đang hoạt động (`source = 'web'`, `user_id` hợp lệ, không phải tài khoản Khách) tự gửi đơn xin nghỉ phép ngay cả khi `hr_employee_id` là NULL.
  - Cơ sở của đơn được lấy trực tiếp từ `NEW.branch` do người gửi chọn trên form web.
  - Áp dụng giờ bắt đầu ca làm việc cố định toàn công ty: ca Sáng lúc **07:45**, ca Chiều lúc **12:30** (dòng lịch riêng trong `hr_leave_work_schedules` nếu có sẽ ghi đè).
  - Tự động tính hạn nộp và gán nhãn `timing_status` (`Đúng hạn`, `Xin muộn`, `Vi phạm`) đồng bộ với toàn bộ quy tắc nghỉ phép hiện hành.

## Ngày đặc biệt — migration 0043

Migration `0043_special_day_notice_log.sql` tạo bảng `special_day_notice_log(day_key DATE, event_key TEXT, sent_at TIMESTAMPTZ DEFAULT now())`, khóa chính `(day_key, event_key)`. Không chứa dữ liệu cá nhân.

- Danh mục ngày lễ/sinh nhật nằm trong code (`public/shared/special-days.js`), không lưu DB.
- Job `notifications/specialDayNotifier.js` chỉ gửi khi `INSERT ... ON CONFLICT DO NOTHING RETURNING` chèn được dòng; gửi lỗi hoặc chưa có người nhận thì xóa dòng để lần quét sau thử lại.
- Thông báo lưu ở bảng `notifications` (0093; trước đó là `data/notifications.json`), nên bảng này mới là nguồn chống gửi trùng — người dùng xóa thông báo cũng không khiến job gửi lại.

## Marketing Pancake — migration 0044

Migration `0044_pancake_marketing.sql` bổ sung nguồn PostgreSQL cho Marketing; repository ở `marketingReport/marketingRepository.js`, dùng `pg`/`getPool`. Migration chưa tự chuyển nguồn API/UI hoặc chạy nhập dữ liệu. Chỉ sáu Facebook page trong kế hoạch được lưu; CHECK/FK chặn page khác và Zalo.

| Bảng | Mục đích và khóa |
|---|---|
| `marketing_pages` | Sáu page đã seed; trạng thái lần thử, lỗi an toàn và thời điểm thành công gần nhất |
| `marketing_import_batches` | Batch nhập bất biến; `batch_key` duy nhất, SHA-256 nội dung, workbook và snapshot người nhập |
| `marketing_history_rows` | Giữ nguyên từng dòng THÔ; duy nhất `(workbook_id,source_tab,source_row)`, không gộp theo phone; JSONB gốc, `phone` nguyên văn, `phone_key` do importer chọn, employee raw, timestamp nullable và ngày lịch sử riêng |
| `marketing_employee_aliases` | Nhiều `raw_name` trỏ một `report_employee`; không sửa tên trong dữ liệu nguồn, chỉ ánh xạ sau chọn đầu/cuối |
| `marketing_sync_runs` / `marketing_sync_pages` | `run_key` duy nhất; sáu kết quả theo page với số đầu vào, fact mới và observation mới, retry cùng payload không tăng lại |
| `marketing_pancake_facts` | Duy nhất `(page_id,source_key)`; ngày ghi nhận đầu tiên, hash trạng thái mới nhất và liên kết tùy chọn một dòng lịch sử (`historical_row_id` duy nhất) |
| `marketing_pancake_observations` | Các phiên bản nguồn bất biến; giữ employee raw đầy đủ (kể cả nhiều tên/rỗng), timestamp UTC, raw API và ngày ghi nhận thành công theo Việt Nam; cùng payload không thêm phiên bản |
| `marketing_monthly_rows` | BC tháng có `report_year`/`report_month` tách khỏi `closed_at`, khách KiotViet (tên và ID tùy chọn), sale, phone, page, status, nguồn data, khách mới, note; provenance Sheets/manual và version BIGINT |
| `marketing_monthly_audit` | Nhật ký bất biến `(row_id,version)`; người sửa và before/after JSONB; cùng giao dịch với tạo/sửa/import |

- Sequence chung `marketing_source_order` giữ thứ tự THÔ và observation. Nhập THÔ theo page/tab/số dòng, API theo thứ tự mảng đã sắp của caller; không sắp lại theo timestamp khi đọc. Sequence có thể hổng sau rollback nhưng thứ tự các dòng đã commit giữ nguyên. Cùng phone khác page độc lập.
- `phone` lưu đúng chuỗi cell/nguồn, không tự chuẩn hóa hoặc tách cell nhiều số. `phone_key` là khóa gom nhóm do caller cung cấp (mặc định bằng phone); giữ cả hai để chính sách chuẩn hóa không phá provenance.
- Lịch sử có ngày/timestamp thiếu được lưu NULL, chuỗi gốc nằm ở `source_created_text`/`raw`; không gán ngày chuyển đổi. BC tháng lịch sử thiếu page (đặc biệt tháng 6) có `page_id` NULL và nguyên văn `page`/`source_raw`, không đoán page. Khi có page ID, FK vẫn chặn ngoài sáu page.
- Baseline API có thể nhận `historicalRowId` do caller đối chiếu không mơ hồ. Repository kiểm tra page + phone key + timestamp; seed fact bằng ngày lịch sử. Cùng nhân viên không thêm observation; thay đổi nhân viên đã xác minh thêm observation vào ngày đồng bộ thành công, không đổi ngày fact lịch sử. Những thay đổi nguồn sau đó thêm phiên bản vào ngày sync thành công, không sửa/xóa dòng lịch sử.
- Ghi page khóa run/page, commit nguyên page; lỗi SQL rollback toàn bộ nguồn page rồi ghi trạng thái lỗi riêng, giữ lần thành công cũ. Các page khác không bị rollback. Job phải bảo đảm một đợt hoạt động tại một thời điểm; số thứ tự các lần chạy do job quản lý.
- Import workbook, raw, alias và BC tháng trong một giao dịch; batch/source identity cùng nội dung bỏ qua, nội dung khác xung đột 409 và rollback. Sửa BC tháng yêu cầu version, khóa dòng và ghi audit nguyên tử; không lưu doanh số làm sự thật (doanh số tính từ KiotViet). Số tiền gốc có thể nằm trong JSON provenance, không được dùng làm doanh số.
- Snapshot dùng REPEATABLE READ READ ONLY để raw/alias/fact/BC tháng/trạng thái nhất quán. Trigger chặn UPDATE/DELETE lịch sử, observation, batch và audit. Thu hồi SELECT của `reporting_readonly` trên toàn bộ bảng Marketing do chứa SĐT/dữ liệu cá nhân.
## Băm raw phiếu nhập — migration 0044

Migration `0044_purchases_raw_hash.sql` thêm `purchases.raw_hash TEXT` (nullable). Đối soát phiếu nhập so băm thay vì tải lại cột `raw` (giảm egress Supabase). `NULL` = chưa có hash; lượt quét đầu sau migration ghi lại toàn bộ phiếu một lần rồi ổn định.

## Băm raw phiếu thu/chi — migration 0066 (19/10/2026, đã áp DB — có trong `schema_migrations`, xác minh 19/10)

`0066_cash_flows_raw_hash.sql` thêm `cash_flows.raw_hash TEXT` (nullable). Đối soát phiếu thu/chi (`kiotvietSync/entities/cashFlows.js`, `reconcilePage`) so băm (`rawHash`/`stableStringify` trong `entities/entityUtils.js`) thay vì tải lại cột `raw` (~700 B/dòng mỗi nhịp 60 giây; `cash_flows.raw` ~25 GB egress/35 ngày). `NULL` = chưa có hash; lượt quét đầu sau migration ghi lại toàn bộ phiếu một lần rồi ổn định (giống `0044`). Phải áp migration trước khi deploy code vì code SELECT/ghi `raw_hash`. Không đổi hợp đồng các cột khác của `cash_flows`.

## Marketing canonical input — migration 0045

`0045_pancake_current_input.sql` thêm JSONB nullable `marketing_pancake_facts.current_input` với CHECK object, giữ canonical API state khi adoption không tạo observation. Không chứa dữ liệu đếm riêng; lịch sử/observation vẫn bất biến. Snapshot báo cáo `includeRaw:false` bỏ field này và JSON nguồn. Khóa advisory riêng giữ một job xuyên instance; thời điểm ghi nhận được lấy cuối transaction, qua nửa đêm rollback/thử lại để không cập nhật observation bất biến.

## Tiền phạt công nợ + số phiên liên tiếp — migration 0048

`0048_debt_penalty.sql` (2026-10-13): `debt_cycle_customers` thêm `overdue_debt`, `overdue_streak` (số phiên liên tiếp quá hạn ≥ 400k tại bản chốt); bảng `debt_cycle_penalties (cycle_date, branch, customer_id)` lưu tiền phạt Quản lý điền (không FK, không bị dọn 7 ngày; SELECT của `reporting_readonly` bị thu hồi); `debt_feedback_history.field` thêm `penalty`; `debt_cycle_feedback.status` bỏ `Đang xử lý` (dữ liệu cũ → `Chưa xử lý`).

## Sổ phạt công nợ theo ngày — migration 0051

`0051_debt_penalty_ledger.sql` (2026-10-14): bảng `debt_penalty_daily (cycle_date, branch, customer_id)` lưu tiền phạt ĐÃ CHỐT SỔ của từng khách theo chu kỳ (`amount > 0`, kèm `sale`, `customer_code/name`, `overdue_debt`, `overdue_streak`, `is_manual`, `status` đóng băng tại lúc chốt; giữ vĩnh viễn, không FK vì `debt_cycle_*` chỉ giữ 7 ngày) và `debt_penalty_cycles (cycle_date)` đánh dấu chu kỳ đã chốt sổ (chu kỳ đang mở chưa có dòng). SELECT của `reporting_readonly` bị thu hồi (có tên khách). Nguồn của bảng thưởng/phạt sale (`GET /api/debt-management/penalty-board`). Khi đọc (15/10/2026) `debtRewardService` chỉ tính 1 lần mỗi khách cùng tên ở cả 2 cơ sở trong cùng ngày (lấy mức phạt cao nhất); dữ liệu trong bảng không đổi, không migration.

## Công nợ theo lịch thanh toán — migration 0047

`0047_debt_schedule_report.sql` (2026-10-13). Khóa nghiệp vụ của công nợ là **(cơ sở, khách KiotViet)**.

| Bảng | Mục đích |
|---|---|
| `debt_payment_schedules` | Lịch TT (số ngày nợ tối đa, 1–30; CHECK DB vẫn cho tới 90 nhưng ứng dụng chặn ở 30) theo `(branch, customer_id)`. Không có dòng = 1 ngày. |
| `debt_payment_schedule_log` | Nhật ký sửa lịch TT (`source` = `import`/`web`), chỉ thêm (trigger chặn UPDATE/DELETE), giữ vĩnh viễn. |
| `debt_cycle_runs` | Mốc chốt 15:00 VN mỗi ngày (`cycle_date` PK). Bản mới nhất = chu kỳ hiện tại. `refreshed_at` / `refreshed_by_name` (0050): lần Tính lại bằng tay gần nhất — ghi đè `debt_cycle_customers`/`debt_cycle_amounts` của chu kỳ đang mở, giữ phản hồi/trạng thái/tiền phạt, không cộng phiên. Tiền theo ngày cắt tại lúc chốt/tính lại thật, không cắt cứng 15:00. |
| `debt_cycle_customers` | TOÀN BỘ khách 2 cơ sở tại bản chốt (kể cả nợ 0, từ 13/10): `current_debt`, `opening_debt` (nợ của bản chốt trước), `avg_revenue_4m`. FK CASCADE theo run. |
| `debt_cycle_amounts` | Tổng hóa đơn `Hoàn thành` / phiếu trả "Đã trả" theo ngày VN, 30 ngày tới 15:00 — để tính nợ trong lịch theo lịch TT hiện tại. |
| `debt_cycle_feedback` | Sale phản hồi / QL phản hồi / Trạng thái của chu kỳ (`cycle_date, branch, customer_id`). |
| `debt_feedback_history` | Lịch sử mọi thay đổi trên giao diện công nợ (`field` = `sale`/`manager`/`status`/`schedule`), theo chu kỳ. |

Job chốt xóa run/feedback/history cũ hơn 7 ngày. SELECT của `reporting_readonly` bị thu hồi trên nhật ký lịch TT, phản hồi và lịch sử. Bảng `debt_collection_statuses` (0011) không còn được dùng.

## Marketing định danh lịch sử — migration 0046

`0046_pancake_history_identity.sql` thêm `marketing_history_identities` (dòng lịch sử → ID tin nhắn Pancake; nhiều dòng có thể cùng một ID, một dòng có thể thuộc nhóm tương đương nhiều ID; `resolution` = unique / verified-notation / equivalent, kèm `group_key` và `evidence` JSONB không chứa SĐT) và `marketing_baseline_messages` (tin trong kỳ nền Sheets nhưng Sheets chưa từng tính, ghi sổ riêng để đồng bộ không coi là mới). Cả hai bất biến (trigger) và thu hồi SELECT của `reporting_readonly`. Bỏ UNIQUE của `marketing_pancake_facts.historical_row_id` vì cặp tin tương đương dùng chung một dòng neo. Lịch sử không bị sửa hay gộp.

## Kết quả thưởng sale theo tháng — migration 0052

`debt_reward_months`: `month DATE` khóa chính (ngày 01), `rule_version TEXT`, `finalized_at TIMESTAMPTZ`, `result JSONB` chứa summary, coverage, rows cùng audit điểm/chi tiết phạt. Không FK theo bản chốt công nợ, giữ vĩnh viễn. Dịch vụ chỉ INSERT ON CONFLICT DO NOTHING; khóa advisory theo tháng trong transaction, retry serialization 40001; không cập nhật lại kết quả đã chốt. Phạt tháng cũ phải chốt hết và `business_monthly_state` phải có tháng doanh số trước khi lưu.

## Làm mới tăng dần doanh thu theo khách — migration 0054 (đã áp Supabase 16/10/2026)

`0054_customer_invoice_lines_incremental.sql`: thêm `customer_invoice_lines_state.last_full_at TIMESTAMPTZ` (NULL = chưa dựng đầy đủ ở chế độ tăng dần ⇒ job dựng đầy đủ trước; không backfill) và hai index `idx_invoices_synced_at (branch, synced_at)`, `idx_returns_synced_at (branch, synced_at)` để lượt tăng dần chỉ đọc đuôi index. Ở chế độ tăng dần `computed_at` là lần kiểm tra gần nhất (nhãn "cập nhật lúc" của giao diện) còn `window_end` = hôm nay. Mã chịu thiếu migration: thiếu cột/bảng (`42703`/`42P01`) thì bỏ qua lượt tăng dần và giữ luồng chốt đêm. Lý do dùng `synced_at` thay `modified_date`: đo 16/10/2026 có 43.074/47.141 hóa đơn và 1.896/2.794 phiếu trả với `modified_date` NULL.

## Trạng thái báo cáo hàng hóa tăng dần — migration 0055 (đã áp Supabase 16/10/2026)

`0055_product_report_state.sql` tạo `product_report_state` (1 dòng, `id = 1`): `computed_at` = lần kiểm tra/làm mới gần nhất (nhãn "Dữ liệu cập nhật lúc"), `version BIGINT` chỉ tăng khi `product_report`/`product_report_customers` có dòng thật sự đổi (client và cache máy chủ dựa vào đây), `last_full_at` = lần gần nhất chạy phần nặng (NULL = chưa). Ở chế độ tăng dần `product_report.computed_at` từng dòng chỉ còn là "lần đổi gần nhất" và bảng chỉ giữ mã đang kinh doanh ở ít nhất một cơ sở (trước đó lọc lúc đọc). Thêm `idx_customers_synced_at` và (IF NOT EXISTS) `idx_invoices_synced_at`, `idx_returns_synced_at` cho cổng "có chứng từ mới" của job. Mã chịu thiếu migration (`42P01`/`42703`): bỏ qua, giữ luồng chốt đêm TRUNCATE.

## Báo cáo hàng hóa theo từng cơ sở — migration 0057 (đã áp Supabase 16/10/2026)

`0057_product_report_branch_columns.sql` thêm 4 cột **nullable, không DEFAULT** vào `product_report`: `available_hanoi NUMERIC`, `available_saigon NUMERIC` (Có bán từng cơ sở = `stock_hanoi`/`stock_saigon` trừ số lượng đang giữ trong đơn đặt hàng **Phiếu tạm của chính cơ sở đó**; không kẹp về 0; cộng hai cột luôn bằng `available_to_sell` đã lưu, cột này giữ nguyên công thức và điều chuyển SG vẫn cộng lúc đọc) và `description_hanoi TEXT`, `description_saigon TEXT` (trường *Mô tả* của sản phẩm KiotViet, `products.raw->>'description'` của từng cơ sở, cắt khoảng trắng/tab/xuống dòng hai đầu, rỗng → NULL). NULL nghĩa là dòng chưa được tính lại sau migration: API trả `null` (giao diện hiện "—"), không giả thành 0. `productReportRefresh.js` (`REFRESH_SQL`: `pending_orders` tách `qty_hanoi`/`qty_saigon` bằng `FILTER`, hai CTE sản phẩm lấy `description`) và `productReportIncremental.js` (`PRODUCT_COLUMNS`) cùng ghi 4 cột; ở chế độ chốt đêm, `refreshProductReportIfDue` tính lại ngay khi còn dòng `available_hanoi IS NULL` (thiếu cột `42703` thì giữ hành vi cũ). **Thứ tự triển khai: áp 0057 trước khi chạy mã mới** (đã áp DB, xác minh schema_migrations 19/10/2026; mã mới INSERT các cột này; nếu chưa áp thì lượt tính lại lỗi `42703` và rollback, bảng cũ vẫn được đọc bình thường). API `GET /api/product-report` cộng thêm `totalStock`, `daysToOrder` khi đọc (không lưu).

## Đơn giá theo cơ sở của Báo cáo hàng hóa — migration 0063 (17/10/2026, đã áp DB, xác minh schema_migrations 19/10/2026)

`0063_product_report_price_columns.sql` thêm 2 cột **nullable, không DEFAULT** vào `product_report`: `price_hanoi NUMERIC`, `price_saigon NUMERIC` (giá bán chung `products.base_price (cũ; từ 19/10/2026 là giá vốn = AVG raw.inventories[].cost)` của mã hàng ở từng cơ sở). `price_hanoi` luôn có số sau khi tính lại (danh sách mã lấy theo Hà Nội, thiếu giá coi như 0); `price_saigon` NULL khi Sài Gòn không có mã. NULL ở cả hai cột = chưa tính lại sau migration (giao diện hiện "—"). Job đêm (`productReportRefresh`) và lượt tăng dần (`productReportIncremental`) cùng ghi; job đêm tự tính lại khi còn dòng `price_hanoi IS NULL`. Chỉ `GET /api/product-report` trả `priceHanoi`/`priceSaigon` và chỉ khi tài khoản có quyền `reports.products.price`; từ 19/10/2026 hai trường này cũng có trong file Excel/HTML xuất (cùng điều kiện quyền). Từ migration `0067` Đơn giá HN/SG là hai cột cuối nhóm số của bảng 34 cột (xem mục 0067 bên dưới).

## Báo cáo hàng hóa theo sheet BC CHUNG — migration 0067 (19/10/2026, đã áp DB 19/10/2026, xác minh schema_migrations)

`0067_product_report_bc_chung.sql` làm hai việc, đều additive:

1. Thêm 4 cột **NUMERIC nullable, không DEFAULT** vào `product_report` (đúng mẫu `0057`/`0063`): `qty_sold_30d_hanoi`, `qty_sold_30d_saigon` (SL bán 30 ngày từng cơ sở từ rollup `daily_product_sales`, cộng hai cột = `qty_sold_30d`; cùng CTE `sales_30d` nên cũng được tính ở lượt nhẹ của job tăng dần), `orders_30d`, `orders_90d` (số hóa đơn khác nhau, không phải "Đã hủy", cả hai cơ sở, có chứa mã hàng; đếm theo mã hàng `lower(btrim(mã))` chứ không theo `product_id`; dòng hàng trả lại không tính; đơn của khách ngừng hoạt động vẫn tính). NULL = chưa tính lại sau migration: API trả `null`, giao diện hiện "—". `orders_*` chỉ được tính ở **lượt nặng** (job đêm hoặc lượt nặng của `productReportIncremental`, qua bảng tạm `pr_orders_new`); lượt nhẹ giữ giá trị cũ của dòng. Cổng `GATE_SQL` thêm điều kiện còn dòng `orders_90d IS NULL` (lý do `thieu-so-don`) nên lần chạy đầu sau khi áp migration job tăng dần tự chạy lượt nặng; job đêm (`refreshProductReportIfDue`) tự tính lại khi còn dòng `qty_sold_30d_hanoi IS NULL OR orders_90d IS NULL`.
2. Tạo bảng `product_stockout_days`: `product_key TEXT PRIMARY KEY` (= `lower(btrim(mã hàng))`), `product_code TEXT NOT NULL`, `days_hanoi INTEGER NOT NULL DEFAULT 0`, `days_saigon INTEGER NOT NULL DEFAULT 0`, `hanoi_scanned_at TIMESTAMPTZ`, `saigon_scanned_at TIMESTAMPTZ`. Lưu **tổng số ngày đứt hàng trong 30 ngày gần nhất** (`totalStockoutDays` của lượt "Quét đứt hàng 30 ngày") cho cột Đứt HN/SG. Bảng riêng, không phải cột `product_report`, vì job đêm cũ `TRUNCATE product_report` sẽ xóa cột còn kết quả quét thì không được mất. Người ghi duy nhất: `dashboard/stockoutCheck/stockoutDaysStore.js` (`persistStockoutDays`), gọi sau MỖI lần quét 30 ngày của một cơ sở (route `POST /api/products/stockout-30d/scan`, "Cả hai" gọi lần lượt từng cơ sở): trong một transaction, khóa advisory `pg_advisory_xact_lock(20531056)`, đặt `days_<cơ sở> = 0` + `<cơ sở>_scanned_at = now()` cho cả bảng (mã vắng trong kết quả = hết đứt), rồi ghi đè mã có đứt bằng `UNNEST` + `ON CONFLICT (product_key) DO UPDATE`, rồi `UPDATE product_report_state SET version = version + 1` (nếu bảng state tồn tại) để cache đọc thấy ngay. Chỉ đụng cột của cơ sở vừa quét. Không có lịch tự chạy; chưa quét lần nào thì không có dòng nào (đọc ra 0). Lỗi lưu chỉ thành cảnh báo trong kết quả quét, không làm hỏng job.

**Cột suy ra khi đọc, không lưu** (`productReportRepository.js`, hàm `compose`; kết quả cache theo `product_report_state.version`; mẫu số ≤ 0 hoặc thiếu → null, giữ số âm): `availableValueHanoi/Saigon` = Có bán × Đơn giá cùng cơ sở; `daysHanoi` = Có bán HN ÷ `qty_sold_30d_hanoi` × 30; `daysSaigonTransit` = (Điều chuyển SG + Có bán SG) ÷ `qty_sold_30d_saigon` × 30; `transferRequest` (21/10/2026, không lưu cột) = SUM(`order_details.quantity`) theo mã của `orders` có `branch='hanoi'`, `raw->>'statusValue'='Phiếu tạm'`, `raw->>'customerCode'='KH010020'`, cộng vào `availableToSell`/`totalStock`; `daysBothBranches` = Tổng có bán + ĐC (đã gồm `transferRequest`) ÷ `qty_sold_30d` × 30 (làm tròn 1 chữ số thập phân); `ordersGrowth` = `orders_30d` × 3 ÷ `orders_90d` − 1. Bộ đọc `LEFT JOIN product_stockout_days` theo `lower(btrim(product_code))` với `COALESCE(..., 0)`, **fail-soft** khi bảng chưa tồn tại (`42P01` → truy vấn cũ, Đứt = 0).

API `GET /api/product-report` và xuất Excel/HTML dùng chung hằng `PRODUCT_REPORT_PRICE_KEYS` = `priceHanoi`, `priceSaigon`, `availableValueHanoi`, `availableValueSaigon`; thiếu quyền `reports.products.price` thì cả 4 khóa bị bóc. **Thứ tự triển khai: áp 0067 trước khi chạy mã mới** (đã áp DB 19/10/2026, xác minh schema_migrations; job tăng dần/job đêm INSERT các cột mới; nếu chưa áp thì lượt tính lại lỗi `42703` và rollback, bảng cũ vẫn đọc bình thường). Sau khi áp, chạy "Quét đứt hàng 30 ngày" cơ sở "Cả hai" một lần để có dữ liệu Đứt HN/SG.

## Hàng dự kiến — migration 0053 (15/10/2026)

`0053_product_containers.sql` tạo snapshot hiện hành độc lập với `product_report`/`product_report_customers` chốt ban đêm. Đã áp lên DB dùng chung lúc 16:26 ngày 15/10/2026 theo yêu cầu người dùng; đã xác minh hai bảng, NUMERIC, singleton và thu hồi SELECT của reporting_readonly.

| Bảng | Hợp đồng dữ liệu |
|---|---|
| `product_container_sync` | Một dòng `singleton=true`; `version UUID`, `last_success_at`, `last_attempt_at` kiểu TIMESTAMPTZ, `last_error TEXT`, `warnings JSONB` mặc định `[]`. Version null = chưa có snapshot thành công. |
| `product_container_lines` | PK `(sheet_name, source_row)`; giữ `sheet_order`, `container_row`, mã gốc và `product_key` chuẩn hóa, tên CONT, `status SMALLINT` 1–5, nhãn trạng thái, ngày về/ngày lên list nguyên văn, màu, ghi chú sale, người đặt. `quantity NUMERIC NOT NULL CHECK >=0`; `units_per_package`, `package_count`, `vietnam_price` NUMERIC nullable. Index `(product_key,status)`. |

Đồng bộ chỉ đọc đủ 6 sheet mỗi 2 tiếng, khóa advisory chống chạy chồng. Dòng và metadata thành công được thay trong cùng transaction; lỗi giữ snapshot cũ, cập nhật mốc thử/lỗi riêng. Không lưu lịch sử từng lần đồng bộ; vẫn giữ trạng thái 4/5 ở snapshot hiện tại để người có quyền đầy đủ xem. Tổng hợp chỉ cộng trạng thái 1/2 (Chưa bốc) và 3 (Đã bốc), giữ NUMERIC khi cộng.

Migration thu hồi ALL trên cả hai bảng khỏi `reporting_readonly` nếu role tồn tại; truy cập thông qua API ứng dụng có kiểm tra quyền `reports.overview.containers.full`. Không cấp SELECT mặc định cho bảng chứa người đặt/giá/cảnh báo nguồn.

## 0056 — Pancake độc lập (đã áp Supabase 16/10/2026)
marketing_pancake_independent_page_state lưu trạng thái/coverage sáu page; marketing_pancake_independent_facts định danh page + message và ngày tạo bất biến; marketing_pancake_independent_observations lưu nhật ký assignment chỉ từ Pancake. Lịch sử marketing_history_rows, baseline và observations cũ được giữ riêng. Các bảng mới chứa dữ liệu cá nhân, không cấp reporting_readonly.

## Index ngày đặt hàng cho Kế toán – Nháp VAT — migration 0058 (17/10/2026, đã áp DB, xác minh schema_migrations 19/10/2026)

`0058_orders_order_date_index.sql`: `CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders (branch, order_date)`. Chỉ thêm index, không đổi dữ liệu. Phục vụ danh sách "đơn đặt hàng chưa xuất hóa đơn" của trang `/vat-draft/` (`server/vatDraft/documentsRepository.js`) — lọc `orders.order_date` theo khoảng ngày kế toán chọn; trước index phải quét cả bảng `orders` (~65.000 dòng, cột `raw` rộng, ~650 ms/lần khi lọc 90 ngày, EXPLAIN ANALYZE 16/10/2026). Trang đọc ghi chú tổng ở `invoices.raw->>'description'` / `orders.raw->>'description'` và ghi chú dòng ở `invoice_details.raw->>'note'` / `order_details.raw->>'note'`; đơn đã có hóa đơn so khớp qua `invoices.raw->>'orderCode'`. Áp trước hay sau khi deploy đều được.

## Tuổi nợ theo hóa đơn — migration 0059 (17/10/2026, đã áp DB, xác minh schema_migrations 19/10/2026)

`0059_debt_aging.sql`: bảng KẾT QUẢ tính sẵn, web chỉ đọc. `debt_aging_customers (branch, customer_id)` — 1 dòng/khách đang hoạt động/cơ sở: `customer_code`, `customer_name`, `sale` (nhãn hiển thị, "Chưa phân nhóm" khi trống), `schedule_days`, `has_stored_schedule`, `current_debt NUMERIC` (= `customers.debt`), `overdue_debt NUMERIC` (nợ hiện tại − hóa đơn Hoàn thành trong N ngày tới hôm nay, không âm), `payoff_day DATE` (ngày hết nợ), `beyond_history` (trừ hết 30 ngày hóa đơn vẫn còn nợ → `payoff_day` = ngày đầu khoảng tra cứu), `equivalent_days`, `remaining_days` (NULL khi nợ ≤ 0). `debt_aging_state (id = 1)`: `as_of_day` (ngày VN đã tính), `refreshed_at`, `customers_synced_at` (`max(customers.synced_at)`), `version` (tăng khi nội dung đổi). Ghi bởi `server/debtSchedule/debtAgingRefresh.js` theo mẫu ghi khác biệt (LEFT JOIN bảng đích + `IS DISTINCT FROM` ở SELECT, xóa khách không còn; đọc ra 0 khách thì không xóa). Nguồn: `customers` (lọc `isActive`), `debt_payment_schedules`, `invoices` (`raw->>'statusValue' = 'Hoàn thành'`, `purchase_date >= ngày::timestamp AT TIME ZONE 'UTC'` để dùng index `(branch, purchase_date)`), chỉ khách `debt > 0`. Nếu chưa áp thì API trả `available: false`, job bỏ qua lỗi `42P01` (hiện đã áp).

## Bản chụp Google Sheets: Vị trí hàng + CÂN ĐO — migration 0064 (17/10/2026, đã áp DB, xác minh schema_migrations 19/10/2026; Vị trí hàng cũ đã gỡ 30/10/2026)

`0064_sheet_snapshots.sql` chỉ thêm 3 bảng; web chỉ đọc, `server/sheetSnapshots/sync.js` là nơi duy nhất ghi (ghi khác biệt, dòng không đổi không bị ghi lại).

**30/10/2026 — gỡ module Vị trí hàng cũ (không migration):** `sync.js` chỉ còn nguồn `shipping_measures` (sheet CÂN ĐO); hai nguồn `stock_locations_hn`/`stock_locations_sg` và module `stockLocations/` đã bỏ. Bảng `stock_location_lines` và hai hàng `stock_locations_hn`/`stock_locations_sg` của `sheet_snapshot_sync` **vẫn nằm trong DB nhưng không còn job nào ghi/đọc** (dữ liệu đóng băng ở lần đồng bộ cuối; `0095` chỉ đọc `stock_location_lines` một lần để seed `stock_positions`, và `0064` cùng `0095` vẫn tham chiếu nó nên không sửa các file migration cũ). **Chưa có migration DROP** — việc treo chờ người dùng duyệt (nếu xóa: tạo migration mới `DROP TABLE stock_location_lines` và `DELETE FROM sheet_snapshot_sync WHERE source IN ('stock_locations_hn','stock_locations_sg')`).

- `sheet_snapshot_sync (source PK)`: `last_success_at`, `last_attempt_at`, `last_error`. `source` hoạt động duy nhất là `shipping_measures` (hai giá trị cũ `stock_locations_hn`, `stock_locations_sg` còn hàng di sản, không còn job cập nhật). `last_attempt_at` là cổng "chưa đến hạn" dùng chung giữa các instance.
- `stock_location_lines (branch 'HN'|'SG', source_row)` — **bảng di sản, không còn job ghi từ 30/10/2026**: `code`, `name`, `total_quantity`, `notes`, `location`, `arrival_date` (đều TEXT, giữ nguyên giá trị hiển thị của sheet, kể cả mã có số 0 đầu). `source_row` là thứ tự dòng đã lọc của sheet, dùng để đọc đúng thứ tự nguồn; gồm cả dòng trùng mã và SL = 0.
- `shipping_measures (code_key PK)`: `per_carton`, `m3_per_unit`, `kg_per_unit` (NUMERIC, NULL khi sheet thiếu dữ liệu). `code_key` = `lower(trim(mã))`; mã trùng lấy dòng đầu.

## Doanh số tháng hiện tại tính sẵn — migration 0068 (19/10/2026, đã áp DB 19/10/2026, xác minh schema_migrations; chưa deploy)

`0068_business_current_month.sql` thêm 3 bảng (chỉ thêm, `IF NOT EXISTS`): `business_current_month_customer_sales` (PK `(month, branch, customer_code)`; `month` là ngày 01, `branch` ∈ `hanoi`/`saigon`; `customer_id BIGINT`, `customer_name`, `invoice_amount`, `return_amount`, `net_revenue` NUMERIC, `invoice_count`, `return_count` INTEGER) và `business_current_month_customer_product_sales` (PK `(month, branch, customer_code, product_code)`; `product_name`, `net_revenue`, `net_qty` NUMERIC; index `business_current_month_cps_product_idx (product_code, month)` cho panel "top khách của một mã hàng") — phản chiếu `business_monthly_customer_sales` / `business_monthly_customer_product_sales` (0036) nhưng là bảng TẠM cho tháng chưa chốt: không ghi vào `business_monthly_*` vì một dòng trong `business_monthly_state` nghĩa là "đã chốt". `business_current_month_state` đúng 1 dòng (`id = 1`): `month`, `computed_at` (lần tính gần nhất — để repository biết độ cũ), `cutoff` (thời điểm dữ liệu hóa đơn tính tới), `last_full_at` (lần quét đầy đủ gần nhất), `customers_synced_at` (mốc nhóm/khách để phát hiện đổi), `version` (chỉ tăng khi dữ liệu đổi). Ghi bởi `kiotvietSync/businessCurrentMonthRefresh.js` bằng đúng câu SELECT chốt tháng (`businessMonthlySql.js`) nên số tính sẵn = số live; ghi khác biệt (LEFT JOIN + `IS DISTINCT FROM`), khóa advisory `20531068`. Dòng tháng cũ chỉ bị xóa khi `business_monthly_state` đã có tháng đó. Repository chỉ dùng bảng khi `state.month` là tháng hiện tại và `computed_at` không quá 30 phút, ngược lại lùi về `live()`. Không GRANT riêng (ALTER DEFAULT PRIVILEGES ở 0010).

## Tính sẵn Báo cáo Marketing — migration 0069 (19/10/2026, đã áp DB 19/10/2026, xác minh schema_migrations; áp sau 0068; chưa deploy)

`0069_marketing_precompute.sql` chỉ THÊM đối tượng mới (`IF NOT EXISTS` / `CREATE OR REPLACE`, không `CONCURRENTLY`). (a) `marketing_ads_costs` (PK `row_key` = `record.key` của parser, JSON `[tên tab, số dòng, khối]`; `sheet_order SMALLINT`, `block SMALLINT`, `source_row INTEGER` giữ đúng thứ tự đọc Sheets; `kind` CHECK `daily`/`total`; `sheet`, `page`, `month SMALLINT`, `date_text`, `ad_cost`, `total_cost`, `messages`, `cost_per_message`, `phones`, `cost_per_phone` NUMERIC, `total_label`; index `marketing_ads_costs_month_idx (month, sheet_order, block, source_row)`) và `marketing_ads_sync_state` (id=1: `last_attempt_at`, `last_success_at`, `last_error`, `row_count`, `version`), ghi bởi `marketingReport/marketingAdsSync.js` (khóa advisory `20531104`, ghi khác biệt, chốt an toàn khi số dòng tụt dưới 70%); đọc fail-soft `readAdsCosts()` trả `null` (→ lùi về Sheets) khi thiếu bảng, chưa đồng bộ, rỗng hoặc cũ hơn `MARKETING_ADS_READ_MAX_AGE_MS` (3 giờ). (b) Hàm `tks_name_key(text)` `IMMUTABLE PARALLEL SAFE`: NFKC, bỏ ký tự độ rộng bằng không (U+200B–U+200D, U+FEFF), gộp khoảng trắng, trim, chữ thường — cùng công thức `nameKey()` JS (`businessMonths.js`, nay cũng bỏ ký tự độ rộng bằng không) và `normalizedNameSql()`; view `v_marketing_customer_revenue(month, name_key, net_revenue, known)` = doanh số (bán − trả) từng tháng theo TÊN khách gộp HN+SG: tháng đã chốt lấy từ `business_monthly_customer_sales` (chỉ tháng có dòng `business_monthly_state`), tháng hiện tại từ `business_current_month_customer_sales` (chỉ khi `business_current_month_state` cùng tháng; độ cũ do phía đọc kiểm qua `computed_at`). Ngữ nghĩa giữ như đường RAM cũ: khách trong danh bạ đang hoạt động nhưng không bán trong tháng → `net_revenue 0, known = true`; tên ngoài danh bạ nhưng có doanh số → `known = false`; không có ở cả hai → không có dòng; khách KHÔNG hoạt động (`customers.raw isActive = false`) bị loại. (c) `marketing_phone_summary` (PK `(page_id, phone_key)`; `first_order BIGINT`, `phone`, `first_employee`, `current_employee`, `repeat_employee`, `first_at`/`current_at`/`repeat_at` DATE, `trace JSONB` mảng gọn `[id, source_order, fact_id, run_id, source_key, observed_at]`; 3 index `_order_idx (first_order)`, `_first_at_idx`, `_repeat_at_idx` một phần) và `marketing_phone_summary_state` (id=1: `built_at`, `max_source_order`, `observation_count`, `phone_count`, `periods TEXT[]`, `employee_raws TEXT[]`, `version`), dựng lại bởi `marketingReport/marketingSummaryRefresh.js` (khóa advisory `20531105`, ghi khác biệt) ở cuối mỗi lượt đồng bộ Pancake độc lập; phía đọc lùi về gộp JS khi thiếu bảng hoặc `max_source_order` lệch bảng quan sát. Hai bảng SĐT bị `REVOKE SELECT` khỏi `reporting_readonly` (nếu role tồn tại). Sau khi deploy: lượt Pancake kế tiếp (hoặc chạy tay `node scripts/sync-pancake-marketing.js`) dựng `marketing_phone_summary` và `marketing_ads_costs`.

## ORDER VAT — migration 0076 (20/10/2026, đã áp DB)

`0076_vat_requests.sql` thay Google Form + sheet ORDER VAT 1. Luật quyền theo trường / khóa theo trạng thái nằm ở `server/vatRequests/service.js`; bảng chỉ giữ ràng buộc dữ liệu.

| Bảng | Hợp đồng dữ liệu |
|---|---|
| `vat_requests` | `id BIGSERIAL`; `created_at TIMESTAMPTZ` (mặc định `now()`, NULL chỉ với dòng cũ ghi "X"), `updated_at`; người tạo `created_by TEXT` (= `app_users.id`, không FK vì admin cứng có id không phải UUID) + `created_by_name` / `created_by_email` chụp lúc tạo; `customer_name`, `customer_code` (mã KiotViet nếu chọn gợi ý); `product_code`, `product_key` GENERATED `lower(btrim(product_code))`, `product_name` chụp lúc tạo (hiển thị ưu tiên `product_report`); `quantity NUMERIC > 0`, `unit_price_excl_vat NUMERIC > 0`, `total_amount` GENERATED = SL × giá; `full_vat BOOLEAN`; `sale_note`; `status TEXT CHECK IN ('pending','0','1','2','3','4')`; `accountant_note`, `arrival_date DATE`; `version INT` (+1 mỗi lần sửa); `is_deleted` (xóa mềm); `is_legacy` + `legacy_row` (dòng sheet cũ, UNIQUE khi khác NULL). CHECK `vat_requests_new_row_complete`: dòng không phải import phải đủ thời gian, người tạo, mã SP, SL, giá. Index `(product_key,status)`, `(status,created_at DESC)`, `(created_by)` — đều `WHERE NOT is_deleted`. |
| `vat_request_history` | `request_id → vat_requests`, `changed_at`, `changed_by` / `changed_by_name`, `action` (`create`/`update`/`delete`/`import`), `field`, `old_value` / `new_value` (TEXT). Chỉ ghi thêm: trigger `vat_request_history_guard` chặn UPDATE/DELETE. |

Migration thu hồi ALL cả hai bảng khỏi `reporting_readonly` (có giá bán + tên khách); chỉ đọc qua API. Cột Tồn VAT / Dự kiến hàng về / Ngày về gần nhất KHÔNG lưu — tính live từ Google Sheets và `product_container_lines` (0053).

## View Sổ quỹ — migration 0070 (19/10/2026, đã áp DB 19/10/2026, xác minh schema_migrations; chưa deploy)

`0070_cash_book_transactions_view.sql`: view thường `v_cash_book_transactions` = `cash_flows c LEFT JOIN cash_book_accounts a ON a.id = c.account_id`, gồm `branch`, `id`, `code`, `trans_date`, `is_receipt`, `amount`, `method`, `status`, `account_id`, `user_id`, `description`, `source_missing_at`, `fund_key` (`'cash'` nếu `method = 'Cash'`, `'unassigned'` nếu thiếu `account_id`, còn lại `account_id::text`), `account_no`, `account_name` (= `bank_name`), `account_desc`, và các trường rút sẵn từ `raw` (PascalCase trước, camelCase sau): `cash_group_id`, `cash_group_name`, `partner_id`, `partner_name`, `partner_phone`, `created_by`, `user_name`, `raw_user_id`, `used_for_financial_reporting`. Cột `raw` KHÔNG được lộ ra view. Không bảng/index/generated column mới; `GRANT SELECT` cho `reporting_readonly` chỉ khi role tồn tại. `cashbookRepository.js` đọc qua view và lùi về subquery cùng nội dung (`CASH_BOOK_TRANSACTIONS_SELECT`) khi gặp `42P01`, thử lại view sau 5 phút; test `db/cashBookViewMigration.test.js` bắt buộc hai bản giống hệt. `cash_book_account_banks` (0034) không còn được dùng, chờ dọn (chưa `DROP`). Việc mở: cân nhắc index `cash_flows(trans_date) WHERE source_missing_at IS NULL` sau khi đo (seq scan ~80k dòng ~120–230 ms).

## Dự kiến hàng về — migration 0075 (20/10/2026, đã áp DB)

`0075_product_container_expected.sql` thêm 2 bảng mới (IF NOT EXISTS, không CONCURRENTLY), thu hồi quyền `reporting_readonly` (có Người đặt):

| Bảng | Hợp đồng |
|---|---|
| `product_container_expected` | PK `(sheet_name, source_row)` (1 dòng = 1 dòng hàng sheet CONT, không gộp). `sheet_order`, `container_row` INTEGER; `container_name`, `status SMALLINT`, `status_label` (cột B), `eta` (cột C), `schedule_label` = `btrim(B || ' ' || C)` một dấu cách, `product_code`, `product_key`, `product_name` (từ `product_report` theo `lower(btrim(product_code))`, `min()`; không có thì ''), `color`, `sale_note`, `ordered_by` TEXT; `units_per_package`, `package_count` NUMERIC nullable; `quantity` NUMERIC. |
| `product_container_expected_state` | 1 dòng `id = 1`: `version BIGINT` (chỉ tăng khi có dòng thêm/đổi/xóa), `source_version UUID` (= `product_container_sync.version` lúc tính), `computed_at`, `row_count`. |

Dựng bởi `productContainers/expectedRefresh.js`, web chỉ SELECT (`expectedRepository.js`, cache theo `version`). Chưa áp migration thì API trả bảng rỗng, job bỏ qua. Sau khi áp, chạy tay `node productContainers/expectedRefresh.js` một lần.

## Kiểm tra giá bán — migration 0077 (20/10/2026, CHƯA áp DB dùng chung)

`0077_invoice_price_audit.sql` thêm 4 bảng mới và 2 cột (idempotent, không CONCURRENTLY, không FK sang `invoices` / `invoice_details`: đồng bộ nguồn không xóa/sửa bản ghi nhận). Luật tính nằm ở `server/invoicePriceAudit/`; bảng chỉ giữ dữ liệu đã chụp.

| Bảng | Hợp đồng dữ liệu |
|---|---|
| `invoice_price_audit_invoices` | Sổ hóa đơn ĐÃ QUÉT (kể cả hóa đơn không có dòng sai), PK `(branch, invoice_id)`; `invoice_code`, `sold_day DATE`, `captured_at`, `run_day`, `source_hash`, `source_modified_at`. Index `sold_day`. Giữ lâu dài qua các phiên chạy; cửa sổ 7 ngày chỉ giới hạn truy vấn hiển thị. FK ON DELETE CASCADE vẫn có nhưng job không xóa dòng hết cửa sổ |
| `invoice_price_audit_lines` | 1 dòng = 1 dòng hàng của hóa đơn, PK `(branch, invoice_id, source_line_no)`, FK → bảng sổ. Nhận diện: `invoice_code`, `sold_at` (giờ Kiot gắn nhãn UTC, như `invoices.purchase_date`), `sold_day`, **`customer_id BIGINT`** (nhận diện khách nguồn; quyền giải thích không còn phụ thuộc sale phụ trách), `customer_code/name/email`, `customer_level` (Vừa/Lớn/VIP), `sale_name` (nhóm khách lúc ghi nhận), `product_code/name`. Số: `quantity`, `total_code_quantity`, `original_unit_price`, `unit_discount`, `net_unit_price`, `full_vat BOOLEAN` — tất cả `NUMERIC`. Đối chiếu từng miền: `carton_size_*`, `quantity_price_*`, `level_price_*`, `vat_*`, `minimum_*` (`_hn` / `_sg`, NULL = không có), `freight_eligible`, `freight_per_unit`. Kết quả: `winning_source`, `reason`, `minimum_unit_price` (NULL = thiếu giá), `unit_shortfall`, `original_amount`, `original_status` (`correct`/`wrong`), `calculation JSONB`. Ghi chú nguồn: `product_note_hn/sg`, `line_note`, `invoice_note`. Sau chụp: `sale_explanation`, `explanation_by/at`, `decision` (`ok`/`penalty`/NULL), `decided_by/at`, `version INTEGER` (khóa lạc quan), `captured_at`. Index theo `(sold_day DESC, branch)`, `(decision, sale_name)`, `(original_status, sold_day DESC)` |
| `invoice_price_audit_state` | 1 dòng `id = TRUE`: `published_day`, `window_from`, `window_to`, `last_success_at`, `last_attempt_at`, `last_error`, `added_invoice_count`, `version`. Web chỉ hiện dữ liệu khi có `published_day` |
| `invoice_price_audit_changes` | Nhật ký sửa giải thích / Chốt: `id` identity, `(branch, invoice_id, source_line_no)` FK → dòng chụp (CASCADE), `actor`, `action` (`explanation`/`decision`/`recalc` — `recalc` do lệnh `--recalc` ghi, actor `system:price-audit-recalc`, before/after gồm `customerLevel`, `originalStatus`, `originalAmount`, `minimumUnitPrice`, `version` không đổi), `changed_at`, `before_value` / `after_value JSONB`, `version_before` / `version_after`. Giữ lâu dài cùng dòng chụp, không bị job xóa khi dịch cửa sổ |
| `shipping_measures.freight_per_unit` | **Cột mới `NUMERIC NULL`**: cột O "Cước 1 Sp" của sheet CÂN ĐO, đọc trực tiếp (không tính lại từ kg/m3); NULL = ô trống (luật đối chiếu áp 0). Không ảnh hưởng m3/kg của Vòng đời đơn |
| `sheet_snapshot_sync.freight_error` | **Cột mới `TEXT NULL`**, chỉ dùng cho nguồn `shipping_measures`: tiêu đề cột O sai/thiếu → đồng bộ Cân đo vẫn ghi m3/kg, mọi `freight_per_unit` = NULL và cột này lưu thông báo lỗi; lượt đồng bộ thành công với tiêu đề đúng đặt lại NULL. Khác NULL → job kiểm tra giá báo `PRICE_AUDIT_SOURCE_NOT_READY`, giữ bản công bố cũ |

Nguồn chưa sẵn sàng khác (không ghi gì, giữ bản cũ): dòng SL > 0 có `invoice_details.price` NULL (giảm giá NULL vẫn = 0). Hóa đơn chưa có dòng chi tiết nào không được ghi vào `invoice_price_audit_invoices` (lượt sau chụp lại); hóa đơn mọi dòng SL ≤ 0 vẫn ghi sổ, không có dòng chụp.

Migration **thu hồi ALL** 4 bảng mới khỏi `reporting_readonly` (có giải thích của sale, quyết định phạt và nhật ký; guard `pg_roles`); chỉ đọc qua API. Thứ tự: áp `0077` TRƯỚC khi deploy bản sync Cân đo mới (INSERT `freight_per_unit` cần cột này).

## Bảng giá duyệt — migration 0091 và 0092 (24/10/2026, CHƯA áp DB dùng chung)

`0091_invoice_approved_prices.sql` thêm 2 bảng (idempotent, không CONCURRENTLY); `0092_invoice_approved_prices_vat_split.sql` (idempotent, giữ nguyên `0091`) thêm `price_no_vat` và `price_with_vat`, chuyển dữ liệu cũ bằng cách chép `approved_price` vào CẢ HAI cột (giữ hành vi cũ), bỏ cột `approved_price` rồi thay CHECK. Không có FK sang `customers` / `products`: tên khách và sản phẩm được JOIN lúc đọc nên KiotViet đổi tên thì bảng giá duyệt tự theo. Bảng phục vụ mục Bảng giá duyệt của tab Hóa đơn và được Kiểm tra giá bán (`invoicePriceAudit/`) đọc khi chụp/tính lại.

| Bảng | Hợp đồng dữ liệu |
|---|---|
| `invoice_approved_prices` | `id` identity PK. `branch` (`hanoi`/`saigon`), `customer_id BIGINT` = `customers.id` cùng cơ sở, `product_id BIGINT` = `products.id` cùng cơ sở, `price_no_vat NUMERIC` ("Giá không VAT", cho phép NULL) và `price_with_vat NUMERIC` ("Giá có VAT", cho phép NULL) (từ `0092`, thay cột `approved_price NUMERIC > 0` của `0091`; CHECK: ít nhất 1 trong 2 giá khác NULL và mỗi giá khác NULL phải > 0), `approver TEXT` (danh sách cố định Anh Quân / Anh Duy / Anh Duy Khánh, kiểm ở `approvedPriceRules.js`), `approved_on DATE` (ngày theo giờ Việt Nam), `version INT` (khóa lạc quan; lệch trả 409), `created_by`/`created_at`/`updated_by`/`updated_at`. UNIQUE `(branch, customer_id, product_id, approved_on)`; index `approved_on DESC`. Sự tồn tại khách/sản phẩm hoạt động trong cơ sở kiểm ở tầng ứng dụng (422 `CUSTOMER_NOT_FOUND` / `PRODUCT_NOT_FOUND`) |
| `invoice_approved_price_changes` | Nhật ký bất biến (trigger chặn UPDATE/DELETE): `price_id`, `action` (`create`/`update`/`delete`), `actor`, `changed_at`, `before_value` / `after_value` JSONB. Không FK tới `invoice_approved_prices` để lịch sử của bản ghi đã xóa còn nguyên |

Luật dùng giá duyệt (`priceAuditSql.js`): hóa đơn có `sold_day >= approved_on` của cùng `(branch, customer_id, product_id)` dùng giá duyệt THAY cho mức tối thiểu theo mô tả. Dòng Full VAT (`hasFullVat`, ghi chú có VAT) dùng `price_with_vat`, dòng không Full VAT dùng `price_no_vat`; loại giá cần dùng mà trống thì KHÔNG áp giá duyệt (rơi về mức tối thiểu theo mô tả). Mỗi loại giá chọn riêng: trong các bản ghi có `approved_on` không quá ngày bán, lấy bản mới nhất CÓ loại giá đó (bản mới hơn để trống loại đó bị bỏ qua). Giá chọn là giá cuối cùng (đã gồm VAT/cước như đã nhập). Dòng kết quả ghi `winning_source` = `Giá duyệt`, lý do `Theo giá duyệt`, `calculation.approvedPrice` JSON có thêm `kind` = `vat` | `no_vat`. Ảnh chụp nhật ký `before_value` / `after_value` chứa `priceNoVat` / `priceWithVat`. Ghi bảng giá duyệt tính lại có phạm vi các dòng `invoice_price_audit_lines` đã chụp trong SAVEPOINT (kết quả `applied`/`skipped`/`not_published`/`busy`/`failed`; lỗi tính lại không hoàn tác bản ghi đã lưu). Kiểm tra giá bán dò bảng bằng `to_regclass` và cột `price_no_vat` qua `information_schema`, chưa migrate thì chạy như cũ (êm bỏ qua giá duyệt).

Migration **thu hồi ALL** cả 2 bảng khỏi `reporting_readonly` (có tên người duyệt và nhật ký; guard `pg_roles`); chỉ đọc qua API `/api/invoice-approved-prices`. Thứ tự: áp `0091` VÀ `0092` TRƯỚC khi deploy; chưa áp thì API bảng trả 503 `NOT_MIGRATED` (cả khi Postgres báo lỗi 42703).

Cập nhật: 24/10/2026.

## Dự kiến hàng về: thêm giá — migration 0078 (21/10/2026, CHƯA áp DB dùng chung)

`0078_product_container_expected_prices.sql` chỉ thêm cột vào `product_container_expected` (idempotent `ADD COLUMN IF NOT EXISTS`, không đổi dữ liệu cũ, không bảng mới, không đổi quyền `reporting_readonly`):

| Cột mới | Kiểu | Hợp đồng |
|---|---|---|
| `listed_at` | `TEXT NOT NULL DEFAULT ''` | Ngày lên list nguyên văn của dòng hàng (sao từ `product_container_lines.listed_at`). |
| `unit_price_cny` | `NUMERIC` nullable | Giá SP (tệ), sao từ `product_container_lines.unit_price_cny`. |
| `vietnam_price` | `NUMERIC` nullable | Giá hàng về VN, sao từ `product_container_lines.vietnam_price`. |

`status SMALLINT` (1–5) đã có từ `0075` và là khóa gom KPI tổng số lượng theo từng trạng thái ở hộp chi tiết mới. `productContainers/expectedRefresh.js` thêm 3 cột vào `STAGE_SQL`/`VALUE_COLUMNS` (so khác biệt `IS DISTINCT FROM`, nên dòng cũ tự được cập nhật). `expectedRepository.js` đọc thêm `status`, `listedAt`, `unitPriceCny`, `vietnamPrice` và chịu được DB chưa migrate (bắt lỗi `42703`, trả giá rỗng). Cache giữ bản đầy đủ; việc bỏ trường giá theo quyền `reports.overview.containers.full` làm ở lớp route, trên bản sao từng dòng.

Thứ tự triển khai: áp `0078` TRƯỚC khi deploy, sau đó chạy tay `node productContainers/expectedRefresh.js` đúng một lần để đổ giá vào các dòng đã có (chưa chạy thì Giá SP (tệ) / Giá hàng về VN để trống).

Cập nhật: 21/10/2026.


### Cập nhật 21/10/2026 — Nhóm sale trong Công nợ

`sale_teams` tiếp tục là nguồn nhóm sale duy nhất cho Khách hàng và Công nợ. Không thêm migration/cột bản sao vào bảng công nợ; nhóm được ghép tại thời điểm đọc, kể cả tháng thưởng/phạt đã chốt.

## ORDER VAT: thứ tự ưu tiên chung — migration 0079 (22/10/2026, CHƯA áp DB dùng chung)

`0079_vat_request_sort_rank.sql` thêm `vat_requests.sort_rank NUMERIC NOT NULL` (mặc định = mili-giây hiện tại `extract(epoch FROM clock_timestamp()) * 1000`, nên yêu cầu mới tự lên đầu) và index `(sort_rank DESC, id DESC) WHERE NOT is_deleted`. Backfill giữ nguyên thứ tự cũ: `COALESCE(epoch(created_at) * 1000, 0) + id * 1e-9` (dòng import thiếu thời gian nằm cuối). Chỉ thêm cột, idempotent, không đổi quyền `reporting_readonly`. Danh sách ORDER VAT xếp `sort_rank DESC, id DESC`; KT kéo dòng chỉ đổi `sort_rank` của 1 dòng thành trung điểm với dòng kề (`* 0.5`, NUMERIC không làm tròn) — không tăng `version`, không ghi `vat_request_history`. Code chịu được DB chưa áp (bắt `42703`: xếp theo `created_at`, ẩn tay nắm kéo).

Thứ tự triển khai: deploy được trước khi áp (thứ tự như cũ, không có tay nắm kéo); áp `0079` bằng `npm run db:migrate` khi được duyệt, sau đó tải lại trang.

## Ghi chú / thông tin theo khách — migration 0080 (22/10/2026, đã áp DB dùng chung)

`0080_customer_notes.sql` thêm 5 bảng (idempotent `CREATE TABLE IF NOT EXISTS`, chỉ thêm, không đổi bảng cũ) cho cột **Ghi chú** và **Tiếp khách lần cuối** của bảng "Doanh số theo khách" (tab Khách hàng). Luật quyền và ngày VN nằm ở `server/businessReport/customerProfileRepository.js` / `customerProfileRules.js`; bảng giữ các ràng buộc dữ liệu.

**Khóa khách:** `customer_key` = `nameKey(tên khách)` (`businessReport/businessMonths.js`: NFKC, bỏ ký tự rỗng, gộp khoảng trắng, chữ thường) — đúng khóa `key` của hàng bảng báo cáo, vì hàng bảng không có id bền (gộp HN + SG theo tên). `customer_name` chỉ là bản chụp tên lúc ghi. **Hạn chế đã biết:** khách đổi tên trên KiotViet thì `key` đổi, mọi ghi chú / ảnh / ngày đi / người sửa gắn khóa cũ không còn hiển thị cho khách đó (dữ liệu vẫn nằm trong bảng, không tự di chuyển). Mọi cột người dùng (`updated_by_id`, `author_id`, `set_by_id`, `user_id`, `assigned_by_id`) là `app_users.id` dạng TEXT, KHÔNG FK (admin cứng có id không phải UUID; xóa mềm tài khoản không làm mất ghi chú cũ, tiền lệ `0076`), kèm tên chụp lúc ghi.

| Bảng | Hợp đồng dữ liệu |
|---|---|
| `customer_profiles` | Thông tin chung, 1 dòng / khách. PK `customer_key`; `customer_name`; `warehouse_location TEXT` (định vị kho); `warehouse_count NUMERIC` (CHECK NULL hoặc ≥ 0); `warehouse_scale TEXT` (CHECK `none`/`small`/`medium`/`large`, mặc định `none` = Chưa có); `competitor TEXT` (đối thủ, để ý tem); `sales_channels TEXT[]` (CHECK ⊆ `san`, `cua_hang`, `fb_ads`, `fb_live`, `sang_tay`, `kho_buon`); `updated_by_id` / `updated_by_name`, `updated_at`. |
| `customer_profile_images` | Ảnh kho, lưu `data BYTEA` như `hr_rule_document_images` (0061). PK `id UUID` (server sinh bằng `crypto.randomUUID()`, không `gen_random_uuid()`); `customer_key`; `content_type` (CHECK png/jpeg/gif/webp, kiểm magic byte ở server); `byte_size` (CHECK 1…5242880 = 5 MB); `sha256 CHAR(64)` (CHECK hex thường, dùng làm ETag); `created_by_id` / `created_by_name`, `created_at`. Index `(customer_key, created_at)`. Tối đa 10 ảnh / khách do server kiểm trong cùng câu INSERT. |
| `customer_notes` | Note kiểu tin nhắn. PK `id UUID`; `customer_key`; `note_date DATE` (ngày VN do server tính, không `CURRENT_DATE`); `body TEXT` (CHECK `btrim(body) <> ''`, server giới hạn 2000 ký tự); `author_id` / `author_name`; `created_at`, `updated_at`. `UNIQUE (customer_key, note_date)` (`customer_notes_key_date_key`) = tối đa 1 note / khách / ngày; chỉ sửa được khi `note_date` = hôm nay (VN), qua ngày thì khóa. |
| `customer_visit_days` | Các ngày "đã đi" tiếp khách. PK `(customer_key, visit_date DATE)`; `set_by_id` / `set_by_name`, `set_at`. Tiếp khách lần cuối = `max(visit_date)`. Chỉ người có `reports.business.customerManage` (Quản lý) thay cả tập ngày; không nhận ngày tương lai. |
| `customer_editors` | Người được Quản lý gán quyền sửa Thông tin chung + Note của từng khách. PK `(customer_key, user_id TEXT)`; `user_name` (chụp lúc gán); `assigned_by_id`, `assigned_at`. Người sửa hiệu lực = `customerManage` HOẶC (`customerNotes` VÀ có dòng ở đây). |

Migration thu hồi ALL cả 5 bảng khỏi `reporting_readonly` (ghi chú nội bộ + ảnh kho; guard `pg_roles`); chỉ đọc qua API `/api/business-report/customer-*`. Không đi qua snapshot cache / bảng tính sẵn của báo cáo kinh doanh; ghép vào bảng ở client qua `GET /customer-meta`.

Thứ tự triển khai: **code deploy được trước khi áp migration** (fail-soft: các route đọc bắt `42P01`/`42703` và trả rỗng, `customer-meta` → `{}`; các route ghi trả 503 `MIGRATION_PENDING`; cột Ghi chú / Tiếp khách lần cuối vẫn hiện nhưng trống). Áp `0080` bằng `npm run db:migrate` khi được duyệt rồi mới dùng. Không có job nền hay bước backfill.

Cập nhật: 22/10/2026.
## ORDER VAT: con trỏ thông báo sale — migration 0080 (22/10/2026, CHƯA áp DB dùng chung)

`0080_vat_request_notice_state.sql`: bảng `vat_request_notice_state(sale_id TEXT PK, last_history_id BIGINT NOT NULL, updated_at)` — con trỏ id lịch sử đã xét của từng sale; dòng mốc `sale_id='*'` = `max(vat_request_history.id)` lúc áp để không báo lại các lần sửa cũ. Chỉ thêm bảng, idempotent, thu hồi quyền `reporting_readonly`. Dùng bởi `server/vatRequests/saleNotifier.js`. Chưa áp thì job gặp `42P01`, ghi log một lần và bỏ qua; web chạy bình thường.

## Tách tài khoản khỏi hồ sơ nhân sự — migration 0081, 0082 (nhánh `feat/tach-tai-khoan-nhan-su`, CHƯA áp DB)

- **Nguồn chính:** `app_users` quyết định vai trò, quyền chi tiết (`feature_permissions`, giữ nguyên), cơ sở (`co_so`), cơ sở công tác (`work_branch`), bộ phận công tác (`bo_phan`) và phạm vi duyệt (`leave_approval_departments`). Đăng nhập không còn đọc/đồng bộ `hr_employees` (chỉ còn gỡ khóa `hr_removed` cũ).
- **0081:** thêm `work_branch` (CHECK `hanoi`/`saigon`/'') và `bo_phan`; sao một lần từ hồ sơ HR đang liên kết; tài khoản không có HR lấy `work_branch` từ `co_so` nếu là cơ sở vật lý; chốt `vai_tro`/`co_so` hiệu lực cho `hr_managed`.
- **0082:** lịch theo `user_id` (sao lịch cũ sang mọi tài khoản liên kết, giữ `version`/`updated_at`); `hr_leave_submissions.user_id` (không khóa ngoại vì bảng bất biến); trigger `hr_leave_submission_snapshot()` mới:
  - định danh: `user_id`, hoặc `hr_telegram_links` theo `telegram_chat_id`, hoặc `hr_employee_id` cũ khi trỏ đúng MỘT tài khoản đang hoạt động; không có → `LEAVE_IDENTITY_MISMATCH`;
  - tài khoản phải đang hoạt động, chưa xóa, `work_branch` thuộc `hanoi`/`saigon` và bằng `branch` của đơn;
  - đơn mới: `bo_phan` = `app_users.bo_phan`; không tự điền `hr_employee_id` (giá trị bot gửi được giữ, phải khớp liên kết của tài khoản);
  - giờ bắt đầu: `hr_leave_work_schedules` theo `user_id` + `start_date`, mặc định 07:45/12:30; chuẩn hóa buổi, hạn nộp, `timing_status`, `submission_revision`, lịch sử như 0038/0042.
  - Sửa đơn: định danh và `hr_employee_id` giữ nguyên (lịch sử), tính lại theo lịch của tài khoản.
- `hr_leave_department_snapshot()` dự phòng đọc `app_users.bo_phan`.
- Quyền duyệt (web và bot Telegram) và quyền tự xin nghỉ chỉ xét trạng thái tài khoản `app_users`, không còn đọc `hr_employees.is_active` (22/10/2026). HR chuyển nghỉ việc thì khóa tài khoản liên kết; admin cấp cao, quản lý được bảo vệ và chính người thao tác không bị tự khóa nên phải khóa tay.
- Thứ tự triển khai: deploy code nhánh → áp 0081 → 0082 (code mới vẫn đọc được trước khi áp vì các cột mới có mặc định; trigger cũ vẫn chạy cho tới khi áp 0082).

## ORDER VAT: trạng thái "VAT sẵn nhiều" — migration 0083 (22/10/2026, đã áp DB dùng chung 22/10/2026)

`0083_vat_request_status_vat_ready.sql`: thay CHECK `vat_requests_status_check` thành `status IN ('pending','0','1','2','3','4','5')`; `'5'` = "VAT sẵn nhiều" (khóa sale như `'0'`). Chuyển 1 lần dòng `'0'` chưa xóa có `accountant_note ~* '^\s*(sẵn|sẵn nhiều|tồn nhiều|còn|còn tồn nhiều)\s*$'` (khớp nguyên note, không tìm từ trong câu) sang `'5'`, `version + 1`, ghi `vat_request_history` (`action 'update'`, `field 'status'`, `'0'→'5'`, `changed_by NULL`, `changed_by_name 'Hệ thống'`). Idempotent (chạy lại không còn dòng khớp). Số 0081/0082 đã dùng trên `main` nên lấy 0083. Áp trước khi deploy mã mới.

## Chi tiết khách — migration 0084 (23/10/2026, đã áp DB dùng chung 23/10/2026)

`0084_customer_profile_details.sql` mở rộng `customer_profiles` sau 0080: thêm `area TEXT NOT NULL DEFAULT ''` (Diện tích, server giới hạn 500 ký tự), bổ sung `very_large` vào CHECK `warehouse_scale`, `khac` vào CHECK `sales_channels`. Không sửa/xóa dữ liệu cũ; chạy lại được. Bảng 0080 phía trên mô tả schema gốc trước nâng cấp.

Thông tin chung và quy mô dùng hai UPSERT cập nhật các cột riêng: PUT profile không thay `warehouse_scale`, PUT `/customer-profile/scale` chỉ Quản lý lưu quy mô và không đổi area/định vị/kênh/đối thủ. Đọc nhận thêm `profile.area`; thiếu cột trước migration giữ cơ chế đọc rỗng/ghi 503 MIGRATION_PENDING. Không có job nền hoặc backfill; migration đã áp thành công lên DB dùng chung 23/10/2026.

## Cấu hình bảng theo tài khoản — migration 0085 (23/10/2026, đã áp DB dùng chung 23/10/2026)

`0085_user_table_prefs.sql` tạo `user_table_prefs(user_id TEXT, table_key TEXT, screen_mode TEXT CHECK desktop/mobile, prefs JSONB CHECK object, updated_at)`, khóa chính `(user_id, table_key, screen_mode)`. `prefs = {"columns": {"<colKey>": {"width": number, "hidden": boolean}}}`, chỉ chứa cột người dùng đã đổi; có thể kèm `"sort": {"key": colKey, "dir": "asc"|"desc"}` cho sắp xếp cục bộ (không có nghĩa là chưa sắp). `user_id` không có FK tới `app_users` (tài khoản có thể nằm ở kho JSON). Đã thu hồi SELECT của `reporting_readonly`. Chạy lại được.

## Ghi chú khác của CONT — migration 0086 (23/10/2026, đã áp DB dùng chung 23/10/2026)

`0086_product_container_other_note.sql` thêm cột `other_note text DEFAULT ''` vào hai bảng `product_container_lines` và `product_container_expected`. Cho phép NULL để tiến trình cũ vẫn ghi được trong lúc chuyển phiên bản. Đã nạp 5.839 ghi chú từ cột G của 7 sheet CONT trên 13.044 dòng mỗi bảng.

## Tên hiện tại của khách/hàng trong bảng tính sẵn (24/10/2026, không migration)

Không đổi cấu trúc bảng, chỉ đổi cách nạp giá trị khi job tính sẵn chạy lại. `customer_invoice_lines_90d.customer_code` / `customer_name` lấy từ `customers` hiện tại (join theo `customer_id`) thay vì tên trên chứng từ. `product_report_customers.customer_key` = `'name:' + normalizedNameSql` (gộp theo tên chuẩn hóa, cùng tên khác mã = 1 khách). Cần chạy lại `customerInvoiceLinesRefresh` và `productReportRefresh` để dữ liệu cũ cập nhật. Bảng tháng đã chốt `business_monthly_*` giữ tên lúc chốt.

Cập nhật gần nhất: 24/10/2026.


## 0094 — Chủ đơn hủy và xóa vĩnh viễn (26/10/2026)

- `hr_leave_cancellation_jobs`: `id` identity PK, `request_id` TEXT không FK, `kind` card/notify, `telegram_chat_id`, `message_id` TEXT, `text`, `attempts`, `available_at`, `lease_token` UUID, `lease_until`, `last_error`; unique `(request_id,kind,telegram_chat_id,message_id)`. Payload xóa khi hoàn tất; lease và retry dùng cùng pattern worker quản lý.
- `hr_leave_approver_recipients`: PK `(request_id,user_id TEXT)`, FK request cascade; trigger nhớ người duyệt từ thời điểm migration, seed người duyệt đang lưu. Không giữ nội dung quyết định; xóa cùng đơn.
- `hr_leave_submissions.request_id` đổi FK sang ON DELETE CASCADE. Guard chỉ cho phép DELETE lồng từ cascade sau parent bị xóa; trực tiếp DELETE/UPDATE vẫn bị chặn.
- `hr_cancel_own_leave(TEXT,TEXT,BIGINT,TEXT[])` kiểm tra owner hoạt động, loại Xin nghỉ phép, phiên bản, snapshot hữu hạn và thời hạn bằng `clock_timestamp()` sau advisory lock + khóa dòng. Tạo chuông/queue, dọn chuông cũ, xóa parent/con nguyên tử. Parent guard yêu cầu context xác thực transaction; function không cấp EXECUTE cho PUBLIC. Chạy bằng role sở hữu migration như các repository hiện có.
- `notifications` có guard chặn INSERT liên quan leaveRequest nếu parent đã xóa, cùng advisory lock theo đơn để ngăn chuông trễ. Chuông hủy `hr_leave_cancelled` không có related_type/related_id.
- Inbox `hr_manager_telegram_updates` dọn payload/effects khi hoàn tất, giữ update_id chống trùng; giao dịch hủy dọn thêm job tham chiếu mã đơn hoặc bản chụp request/delivery, dùng SKIP LOCKED tránh chờ ngược thứ tự khóa. Job đang xử lý dọn khi hoàn tất.
- Reporting role không được truy cập hai bảng mới. Không thay đổi hợp đồng INSERT bot xin nghỉ bên ngoài.

## 0095 — Cơ sở dữ liệu Vị trí hàng mới: `stock_positions` (27/10/2026)

- `stock_positions (id BIGSERIAL)`: `branch` ('HN'|'SG'), `code` (không rỗng), `name` (dự phòng khi `products` chưa có mã), `notes` (ghi chú số thùng, chuẩn hóa khi lưu), `arrival_date` (**TEXT**, có thể rỗng, vd "KK 4.10", "16/10"), `location`, `version` (khóa lạc quan, +1 mỗi lần sửa), `updated_by_user_id`, `updated_by_name`, `updated_at`, `created_at`. Index `(branch, lower(btrim(code)))` và `(branch, location)`. **Không có UNIQUE** (mã, vị trí): dữ liệu đầu có dòng trùng; nhập mới/import trùng (mã, vị trí) thì ứng dụng tự cộng ghi chú vào dòng cũ; dòng trùng sẵn có của dữ liệu đầu giữ nguyên, không cảnh báo.
- **SL kho và cảnh báo KHÔNG lưu**: luôn tính từ `notes` bằng `public/shared/carton.js` (`parseSpec`, `normalizeNote`, `warnings`). Tên SP và SL KiotViet đọc theo mã từ `products` (`code`, `name`, tổng `raw->'inventories'[].onHand`) khi xem.
- `stock_position_history`: nhật ký **chỉ thêm** (trigger chặn UPDATE/DELETE, không khóa ngoại): `id`, `created_at`, `branch`, `position_id`, `code`, `location`, `action` (`seed|create|edit|delete|auto_delete|deduct|import_replace|import_add`, thêm `pick|pick_revert` từ `0096`, `ack|unack|history_purged` từ `0099`, `stock_out` từ `0101`), `field`, `old_value`, `new_value`, `summary JSONB` (số dòng thêm/đổi/xóa/bỏ qua của import), `actor_user_id`, `actor_name`. Thu hồi `reporting_readonly`.
- **Dữ liệu đầu (một lần, chỉ khi bảng rỗng)**: `INSERT … SELECT` từ `stock_location_lines`, `updated_by_name = 'Nhập dữ liệu đầu'`. Gỡ tiền tố "T x " thừa của HN (vd "T x 4T*100" → "4T*100") khi phần sau là "<số>T…"; **bỏ** dòng thiếu mã và dòng hết hàng (ghi chú rỗng / "Hết hàng") vì quy tắc tự xóa khi SL = 0. Sau khi sao chép, hai bảng không còn liên hệ (trước 30/10/2026 Google Sheets còn nuôi hai tab cũ "Vị trí HN/SG", nay đã gỡ). Mỗi cơ sở có một bản ghi lịch sử `seed`.
- Tự xóa khi hết: sau mọi lần lưu, SL tính ra = 0 thì dòng bị xóa và ghi `auto_delete`.
- **27/10/2026 (không migration mới):** `GET /api/stock-positions/history` có thêm tham số `positionId` lọc theo cột `position_id` có sẵn (hộp chi tiết dòng); `GET /api/stock-positions/history/export` đọc cùng bảng `stock_position_history` (trần 50.000 dòng mới nhất). Không đổi cấu trúc bảng/index.

## 0096 — Chỉ định vị trí trên Vòng đời đơn hàng (27/10/2026, chưa áp DB)

- `order_pick_assignments (id BIGSERIAL)`: `branch` ("HN"|"SG"), `order_code`, `status` (`picking|confirmed|cancelled`), `version INTEGER` (khóa lạc quan), `order_snapshot JSONB` (khách, sale, `saleTelegramId`, dòng hàng, giá, chiết khấu — để in lại phiếu đúng nội dung), người/thời điểm chỉ định, xác nhận và hủy, `updated_at`. **Unique một phần** `order_pick_assignments_active_uidx` trên `(branch, lower(btrim(order_code))) WHERE status IN ('picking','confirmed')`: tối đa một chỉ định hoạt động mỗi đơn; chỉ định đã `cancelled` được giữ làm lịch sử.
- `order_pick_lines (id BIGSERIAL)`: `assignment_id` (FK), `product_code`, `position_id` (trỏ `stock_positions.id`, không FK vì dòng có thể bị tự xóa), `location`, `planned_qty`, `reserved_qty`, `st_cartons`, `st_text`, `picked_qty NUMERIC` (NULL trước xác nhận), `spec_before` / `spec_after` (ghi chú vị trí trước/sau khi trừ thùng, để hoàn tác đúng chuỗi), `position_snapshot JSONB` (mã, tên, ghi chú, ngày về, vị trí — để tạo lại dòng đã bị `auto_delete`). UNIQUE `(assignment_id, position_id)`; `planned_qty > 0`, `reserved_qty >= 0`. Index `order_pick_lines_position_idx (position_id)` để cộng giữ chỗ. `position_snapshot` có khóa `{code, name, notes, arrivalDate, location}`.
- `order_pick_history`: nhật ký **chỉ thêm** (trigger chặn UPDATE/DELETE như `stock_position_history_guard`; `REVOKE` khỏi `reporting_readonly`): hành động `assign|confirm|cancel` (thêm `mismatch_ack` từ `0098`), người thực hiện (`actor_user_id`, `actor_name`), `created_at`, `assignment_id`, `branch`, `order_code`, `summary JSONB`. `assignment_id` của lịch sử không có FK; FK của lines có ON DELETE CASCADE.
- **Tra cứu:** `order_pick_assignments_order_idx` trên `(branch, lower(btrim(order_code)), id DESC)`; API đọc chỉ định mới nhất kể cả cancelled. Khớp mã vị trí bằng `lower(btrim(code))`, tách HN/SG.
- **Giữ chỗ không có cột riêng:** tồn khả dụng của vị trí = SL tính từ `stock_positions.notes` − Σ `reserved_qty` của các `order_pick_lines` thuộc chỉ định đang `picking` ở đơn khác. Xác nhận nhặt trừ thùng thật (giữ chỗ hết hiệu lực vì đơn không còn `picking`).
- **`stock_position_history.action`** mở rộng CHECK thêm `pick` (xác nhận nhặt trừ thùng) và `pick_revert` (hoàn tác; giữ trong ràng buộc cho lịch sử cũ, từ 27/10/2026 tối code không còn ghi vì Đã bốc là trạng thái cuối), `summary` mang `{orderCode, assignmentId}`; dòng tự xóa khi trừ hết vẫn ghi `auto_delete`.
- Mọi thao tác ghi chạy trong một giao dịch dưới khóa advisory theo cơ sở của `stockPositions/` + `FOR UPDATE` các dòng vị trí theo thứ tự `id`.

Trạng thái: đang làm trên nhánh `feat/lifecycle-pick-assign`, **chưa merge, chưa migrate (`0096`, `0097`, `0098`), chưa deploy**. Người dùng tự chạy `npm run db:migrate`.

## 0097 — Snapshot lúc chỉ định và tiền phiếu v2 (27/10/2026, chưa áp DB)

- `order_pick_lines.allocation_snapshot JSONB` nullable: mã/vị trí chuẩn hóa, version vị trí, ghi chú/quy cách và phương án lấy lúc giữ chỗ. Xác nhận kiểm dấu vết dưới cùng khóa cơ sở/dòng; version tăng do đơn khác giảm tồn không tự làm phiếu mất hiệu lực nếu cách lấy vẫn đúng và tồn đủ.
- `position_snapshot` giữ nguyên mục đích hoàn tác tại thời điểm xác nhận; không dùng thay dấu vết lúc chỉ định. Dòng cũ có `allocation_snapshot IS NULL` được xem/in/hủy giữ chỗ nhưng không xác nhận bằng dữ liệu hiện tại.
- `order_snapshot` mới dùng `schemaVersion: 2`, giữ dòng gốc theo thứ tự, `amount` mỗi dòng và `goodsTotal`/`payable`/`invoiceDiscount` dưới dạng chuỗi thập phân chuẩn do máy chủ tính. Các dòng cùng mã chỉ gộp để phân bổ; ảnh chụp cũ không được suy dựng lại từ đơn Kiot mới.
- Các cột lượng vẫn là `NUMERIC`; service yêu cầu số chiếc nguyên an toàn trước gộp, trước ghi và trước hoàn. Không cưỡng ép chuyển kiểu trên dữ liệu cũ. Bản đã xác nhận có lượng lẻ hoặc `picked_qty` lệch chênh lệch `spec_before`/`spec_after` cần đối soát, không hoàn tự động.
- Áp `0096` rồi `0097` trước đưa backend/frontend mới vào vận hành; chưa áp DB thật trong phiên sửa này.

## 0098 — Đã xử lý cảnh báo Lệch SL bốc (27/10/2026, chưa áp DB)

- `order_pick_history.action` CHECK mở rộng thành `assign|confirm|cancel|mismatch_ack`. Bảng vẫn chỉ thêm (trigger chặn UPDATE/DELETE).
- Dòng `mismatch_ack` ghi khi người có `shipment.pick` bấm **Đã xử lý**: `summary.signature` = JSON các `[mã chữ thường, picked, ordered]` của số lệch lúc bấm, `summary.items` = `[{productCode, picked, ordered}]`. Chỉ dòng mới nhất của chỉ định hoạt động được xét; còn khớp số lệch hiện tại thì API đánh dấu `handled`. Kiot sửa tiếp hoặc chỉ định mới (`assignment_id` mới) thì không còn khớp.
- **Từ 30/10/2026 ứng dụng không còn ghi `mismatch_ack`** (nút Đã xử lý và route `mismatch-ack` đã bỏ, thay bằng cảnh báo Lệch Kiot / Lệch SL trong đơn tính từ snapshot + `order_pick_lines`, không migration). Migration giữ nguyên; áp hay chưa áp đều không ảnh hưởng. Snapshot đơn (`order_snapshot.lines[]`) có thêm `kiotQuantity` khi SL cần nhặt được sửa tay khác SL Kiot.

## 0099 — VT: Đã sửa + xóa lịch sử (28/10/2026, chưa áp DB)

- `stock_positions.format_ack BOOLEAN NOT NULL DEFAULT false`: người dùng xác nhận cảnh báo của dòng (mọi loại, kể cả mã lạ) đã xử lý; giữ mãi, sửa ghi chú không tự bỏ. Cảnh báo vẫn tính từ `notes` (`carton.js`), cờ chỉ đổi cách hiển thị/đếm (`warnings` rỗng, `rawWarnings` giữ bản gốc).
- `stock_position_history_action_check` mở rộng: thêm `ack`, `unack` (bật/tắt cờ), `history_purged` (dấu vết mỗi lần xóa lịch sử, `summary = {deleted, from, to}`).
- Trigger `stock_position_history_guard`: UPDATE luôn bị chặn; DELETE chỉ qua khi `current_setting('app.history_purge', true) = 'on'` — chỉ `stockPositionsService.purgeHistory` đặt (`set_config('app.history_purge','on',true)`, chỉ có hiệu lực trong giao dịch đó). Lượt trừ tồn do đơn ghi mã đơn vào `actor_name` (và `stock_positions.updated_by_name`); tên người xác nhận ở `summary.confirmedBy`.
- Chưa áp thì danh sách/thêm VT lỗi (thiếu cột `format_ack`) — phải `npm run db:migrate` trước deploy.

Cập nhật gần nhất: 28/10/2026.

## 0100 — Form phiếu in dùng chung (28/10/2026, chưa áp DB)

- `shared_print_layouts`: khóa `template` (`order`/`delivery`); `layout JSONB` chỉ có `widths` (phần trăm, tổng 100), `heights` (px theo hàng), `fonts` (đường dẫn phần tử, offset vùng chữ, cỡ pt), không HTML/nội dung đơn.
- `version INTEGER` tăng mỗi lần ghi, `updated_by TEXT`, `updated_at TIMESTAMPTZ`; PUT có phiên bản cũ trả 409, reset ghi form rỗng với phiên bản mới.
- Dùng chung mọi tài khoản/cơ sở/thiết bị; quyền API `shipment.pick`. Thu hồi SELECT của `reporting_readonly`.
- Cần áp migration trước deploy (`npm run db:migrate`). Cập nhật: 28/10/2026.

28/10/2026 — `shared_print_layouts.layout` (0100) mở rộng tương thích ngược, không đổi DDL: `groups?: {body?: {height?, size?, columns?: {index: {align?, bold?, italic?}}}, header?: ...}`; `height` 16–1200px, `size` 7–36pt, index theo 9/7 cột của mẫu; `blocks?: [{path,align}]`; `fonts` nhận size/bold/italic vùng chữ (ít nhất một), chỉ selector phần tử dạng nth-child, không nhận HTML/CSS tùy ý. Chỉ nhận align left/right/center và boolean cho bold/italic. Giữ định dạng cũ widths/heights/fonts; frontend chuyển heights cũ sang hai nhóm và áp dụng đúng cho mọi số dòng.


29/10/2026 — Shared print layout JSON (0100): goods delivery validates 6 columns (order 9); `groups.body/header.columns[index]` accepts size 7–36pt plus bold/italic/align. Optional `tables` holds independent validated footer layouts: order summary(4), signatures(2), notes(1); delivery deliverySignatures(3), deliveryNote(1). No DDL change. Existing order_snapshot sellerPhone is populated from Kiot users mobilePhone for new assignments; old history is not rewritten.

Cập nhật gần nhất: 30/10/2026 (gỡ module Vị trí hàng cũ: `stock_location_lines` và hàng `stock_locations_hn/sg` của `sheet_snapshot_sync` thành di sản không còn job ghi, chưa DROP; không migration mới).

## 0101 — VT: Xuất kho (30/10/2026, chưa áp DB)

- `stock_position_history_action_check` mở rộng: thêm `stock_out` = một lượt **Xuất kho từ file** trừ SL khỏi một dòng vị trí. Mỗi vị trí bị trừ có đúng một bản ghi: `position_id`, `code`, `location`, `field = 'notes'`, `old_value` = ghi chú trước, `new_value` = ghi chú sau (`NULL` khi dòng về 0 và bị xóa), `summary = {deducted, removed, fileName, fileRows}` (`fileRows` = số dòng Excel đã góp vào lượt trừ), `actor_*` = người bấm Xuất kho.
- Không thêm cột/bảng/trigger; dòng vị trí vẫn dùng `version`, `updated_by_*` như mọi thao tác ghi. Chưa áp migration thì `stockOutFile` lỗi 500 và rollback toàn bộ lượt (CHECK từ chối `stock_out`) — phải `npm run db:migrate` trước deploy.

Cập nhật gần nhất: 30/10/2026.
