# MEMORY: BỘ NHỚ DÀI HẠN DỰ ÁN TOKOSI DASHBOARD

> **Thời hạn giá trị:** Ít nhất 3 tháng (Q4/2026 – Q1/2027).  
> **Cập nhật gần nhất:** 30/10/2026.  
> **Quy tắc:** Chỉ lưu trữ các nguyên tắc cốt lõi, kiến trúc bất biến, quy ước chuẩn hóa và bài học kinh nghiệm dài hạn. Không ghi deadline ngắn hạn hay task vụn vặt vào file này.
>
> **Nguyên tắc tiên quyết:** với chức năng chưa quen thuộc, đừng viết từ con số 0 — tìm các dự án mã nguồn mở trên GitHub để so sánh ý tưởng trước khi bắt tay làm (xem mục 0 của [CLAUDE.md](CLAUDE.md)).

---

- **Vị trí hàng chỉ còn VT Hà Nội / VT Sài Gòn (30/10/2026):** nguồn sự thật là bảng Postgres `stock_positions` (module `stockPositions/`, trang `/vt-positions/`, quyền `stockLocationsV2.*`); module cũ đọc Google Sheets (`stockLocations/`, `/api/stock-locations`, khóa `stockLocations.view`, nguồn đồng bộ `stock_locations_hn/sg`) đã gỡ — ĐỪNG dựng lại. Link `/stock-locations*` chuyển 302 sang `/vt-positions/`. `stockLocationsV2.view` + `.export` mở cho mọi vai trò kể cả Khách (`GUEST_ALLOWED_KEYS`), `.edit` + `.historyDelete` chỉ Quản lý. Biến `STOCK_LOCATIONS_SPREADSHEET_ID` là tên di sản của workbook CÂN ĐO; bảng `stock_location_lines` còn trong DB nhưng không còn job ghi (chưa DROP, chờ người dùng duyệt).
- **Tên khách/hàng trong báo cáo (24/10/2026):** báo cáo dùng TÊN HIỆN TẠI (`customers.name`, `products.name` theo cơ sở + id), không dùng tên ghi trên chứng từ (`raw->>'customerName'`/`'productName'`); khách trong `product_report_customers` gộp theo tên chuẩn hóa. Đổi tên trên KiotViet chỉ cần chạy lại job tính sẵn (`customerInvoiceLinesRefresh`, `productReportRefresh`), không đồng bộ lại hóa đơn. Bảng tháng đã chốt `business_monthly_*` giữ tên lúc chốt.
- **Khách hoạt động trong Công nợ (15/10/2026):** danh sách/KPI/điểm/phạt/xuất file chỉ dùng khách hiện còn hoạt động. KiotViet retail không trả cờ hoạt động trong các payload khách đã kiểm tra và bỏ qua query `isActive`; đồng bộ chuẩn hóa `customers.raw.isActive` từ cờ rõ ràng nếu có, danh sách hiện hành và `removedIds`. Đối soát đầy đủ lần đầu/mỗi ngày, không đánh dấu vắng mặt khi thiếu trang/tổng thay đổi/trùng ID/lỗi giữa chừng; không xóa dữ liệu nguồn hoặc audit. Lọc hoạt động trước chọn ID mới nhất của cơ sở+mã. Kết quả thưởng tháng đã chốt bất biến.

- **Form phiếu in dùng chung (28/10/2026):** người dùng yêu cầu một người chỉnh form thì mọi người dùng cùng định dạng ở các phiên sau, trên máy khác cũng vậy. Bỏ ô chọn font/cỡ chữ/nhập độ rộng; kéo viền chỉnh cột/hàng, bôi đen rồi Ctrl+] / Ctrl+[ đổi cỡ chữ. Lưu PostgreSQL riêng mẫu `order`/`delivery` (`shared_print_layouts`, migration 0100), không lưu riêng theo tài khoản/trình duyệt. Nội dung và số liệu luôn chỉ đọc.

- **Phiếu in theo khu (28/10/2026):** cột Thùng căn giữa; chỉ gộp thông minh trong cùng khu/vị trí, khác khu giữ cộng nối (`2Tx50+3Tx50`, không thành `5Tx50`), phần thiếu giữ riêng. Lời lưu ý cuối phiếu đi sát khối ký, không dùng min-height A4/margin tự đẩy đáy gây tách trang khi in 120%.

- **Định dạng hàng phiếu in (28/10/2026):** chiều cao và cỡ chữ phần hàng hóa đồng bộ toàn tbody; thead riêng. Căn lề/đậm/nghiêng theo cột chọn cho mọi hàng cùng nhóm. Ctrl+L/R/E trái/phải/giữa, Ctrl+B/I đậm/nghiêng; Ctrl+[/] cỡ chữ. Mọi định dạng lưu form chung trên máy chủ cho mọi người/phiên/máy; số dòng khác vẫn nhận. Chỉ bắt phím khi có vùng bôi chọn trong phiếu, không sửa số liệu.

## 1. Hồ sơ dự án (Project Profile)

- **Tên dự án:** TOKOSI Dashboard (Web TKS Dashboard).
- **Mục đích:** Hệ thống điều hành & báo cáo nội bộ tập trung cho 2 cơ sở phân phối sỉ: **Hà Nội (HN)** và **Sài Gòn (SG)**.
- **Công nghệ nền tảng:**
  - **Backend:** Node.js (v22/v24), Express REST API.
  - **Database:** Supabase PostgreSQL (Production / Staging), PGlite (Unit / Integration testing cục bộ).
  - **Frontend:** Vanilla HTML5, CSS3 (Design token, CSS variables, Dark/Light theme, responsive), Vanilla JavaScript (không dùng Tailwind, React, Vue).
  - **Dữ liệu nguồn:**
    - KiotViet API (bán hàng, kho, khách hàng, hóa đơn, thu chi) đồng bộ qua Node.js engine (`server/kiotvietSync/`).
    - Google Sheets API (chỉ đọc cho CÂN ĐO qua job `sheetSnapshots` vào Postgres — module Vị trí hàng cũ đọc Sheets đã gỡ 30/10/2026, Báo cáo Marketing; đọc/ghi tab `Lịch sử cập nhật` Vòng đời đơn hàng và sửa trực tiếp Khách mới/Ghi chú của Báo cáo Marketing).
  - **Bot & Thông báo:** Telegram Bot quản lý duyệt nghỉ phép (`server/telegram/`), Server-Sent Events (SSE) phát sóng thời gian thực cho trình duyệt.

---

## 2. Nguyên tắc kiến trúc & Quy tắc bất biến (Do's & Don'ts)

- **Quy tắc Git do người dùng yêu cầu (20/10/2026):** Mọi thay đổi được thực hiện trực tiếp trên nhánh `main`. Không tự tạo nhánh hoặc worktree dùng nhánh khác; chỉ tạo nhánh khi người dùng yêu cầu rõ ràng.

### 2.1. Quy ước cơ sở & dữ liệu
- **`branch` chỉ có 2 giá trị:** `hanoi` và `saigon` trong Postgres. Khóa chính của mọi bảng nghiệp vụ KiotViet luôn bắt đầu bằng `(branch, id)`.
- **`Cả hai` (`both` / rỗng) chỉ là phạm vi xem trên UI:** Không có cơ sở `both` trong database. Khi chọn `Cả hai`, server ghép kết quả hoặc hiển thị từng dòng riêng theo từng cơ sở.
- **Tiền tệ & số lượng luôn dùng `NUMERIC`:** Đã chuyển đổi từ `BIGINT`/`INTEGER` ở migration `0012`. KiotViet có giá lẻ xu và số lượng cân nặng thập phân (ví dụ `7.5`).
- **Múi giờ chuẩn:** Toàn bộ hệ thống quy chuẩn theo **`Asia/Ho_Chi_Minh` (UTC+7)** cho ngày hôm nay, bucket ngày và mốc báo cáo, độc lập với timezone của máy chủ Render.
- **TUYỆT ĐỐI KHÔNG CÒN APPS SCRIPT:** Toàn bộ Google Apps Script cũ (`src-dashboard`, `.clasp.json`) đã bị xóa và nghỉ hưu hoàn toàn; không bao giờ tạo lại hay phụ thuộc vào Apps Script.

### 2.2. Tài khoản, Bảo mật & Phân quyền
- **Khóa tự đăng ký tài khoản:** Tự đăng ký (`/register`, OTP nhân sự, tạo Khách tự động qua Google) bị khóa từ 2026-10-03 (`ALLOW_SELF_REGISTRATION=false`). Mọi tài khoản mới do Quản lý tạo tại `/account/#users`. Bảng tài khoản có phân trang chuẩn (`table-controls.js`).
- **Bảo vệ tài khoản Quản lý cấp cao:** Quản lý thường không được sửa thông tin, đặt lại mật khẩu, hạ vai trò hay xóa Quản lý khác. Chỉ Admin cứng (`HARDCODED_ADMINS`) mới có toàn quyền (`accountPolicy.checkProtectedManager`).
- **Phân quyền theo tính năng (`featureRegistry.js`):** Quyền mặc định theo vai trò kết hợp cờ ghi đè từng tài khoản (`app_users.feature_permissions JSONB`). Mọi quyền con phụ thuộc quyền cha thông qua `requires`.
- **Bảo mật hồ sơ cá nhân:** Người dùng thường không tự đổi email/SĐT qua form hồ sơ. Đổi email tài khoản thường phải xác minh qua OTP gửi tới email mới; tài khoản nhân sự chỉ Quản lý mới được đổi.
- **Nhật ký chỉnh sửa tài khoản (`account_audit_log`):** Mọi thao tác quản trị tài khoản được ghi nhận bất biến (migration `0040`), thu hồi `SELECT` khỏi role báo cáo.

### 2.3. Nhân sự & Nghỉ phép
- **Trạng thái nhân sự (`employment_status`):** Tách biệt trạng thái làm việc `active` (Đang làm việc) và `resigned` (Đã nghỉ việc) khỏi xóa mềm `is_active` (migration `0041`). Chuyển sang `resigned` tự động khóa tài khoản liên kết (`lock_reason = 'hr_resigned'`); chuyển lại `active` tự động mở khóa.
- **Lịch làm việc & Hạn nộp đơn:** Giờ làm việc cố định toàn công ty là sáng **07:45** và chiều **12:30** (`hr_leave_work_schedules`, migration `0038`). Đơn tự động phân loại `timing_status` (`Đúng hạn`, `Xin muộn`, `Vi phạm`).
- **Tài khoản nội bộ chưa gắn nhân sự gửi đơn:** Mọi tài khoản nội bộ hoạt động (trừ Khách) dù chưa liên kết `hr_employee_id` vẫn được phép gửi đơn nghỉ web (migration `0042`).
- **Ngày đặc biệt:** danh mục ngày lễ (thêm Quốc tế Nam giới 19/11) + sinh nhật 27/10 ở `public/shared/special-days.js` (UMD, giờ VN); `notifications/specialDayNotifier.js` báo chuông cho tài khoản có `hr.leave` (bảng `special_day_notice_log` chống trùng, cờ `SPECIAL_DAYS_NOTIFY_ENABLED`); `shooting-star.js` đổi sang `fireworks.js` vào các ngày này (`?fireworks=1` để xem thử). Lịch nghỉ phép không đổi.
- **Bot quản lý nghỉ phép:** Chạy webhook trong Express với secret header; gửi thông báo duyệt/từ chối kèm Mini App lý do; chống tranh chấp bằng `decision_version`. Cache danh sách quản lý 5 phút, nạp lazy; realtime polling `getLeaveVersions` giảm egress Supabase.
- **Phân trang bảng HR:** Bảng nhân sự, chấm công và nghỉ phép được trang bị phân trang chuẩn (`table-controls.js`).

### 2.4. Sổ quỹ, Báo cáo & Hàng hóa
- **Sổ quỹ (`/cashbook/`):** Tồn quỹ = tổng phiếu thu trừ phiếu chi chưa hủy; gom quỹ ngân hàng HN + SG cùng số tài khoản; phân loại theo 5 nhóm tài khoản (`account_balance_groups`). Không dùng cache; kiểm tra revision tự động mỗi 15 giây khi tab đang xem.
- **Tab Hàng hóa (20/10/2026 thêm mục 2 "Dự kiến hàng về": bảng tính sẵn `product_container_expected` migration 0075 từ `product_container_lines` bằng job `productContainers/expectedRefresh.js`, API `/api/expected-arrivals`, quyền `reports.products.expected` cho 7 vai trò không kéo theo `reports.products`; chưa áp DB/commit) = Báo cáo hàng hóa (từ Tổng quan) + Dự kiến hàng về + Tăng trưởng mã hàng (từ Khách hàng, hiện khi có `reports.business`); `/api/dashboard` chỉ còn view overview/invoices/debt; đã gỡ quyền `reports.products.cost`. Từ 16/10/2026 Báo cáo hàng hóa có 19 cột theo file HÀNG HÓA.xlsx (Có bán/Mô tả theo từng cơ sở, migration 0057; khung nhìn mặc định Sale/Quản lý bằng khóa phiên `TKSTables.enhance`; hộp chi tiết Hàng dự kiến đứng trên Doanh số theo khách).**
- **Tab Khách hàng (id nội bộ `business`, `/reports/#business`; trước là "Báo cáo kinh doanh", tab Khách hàng cũ đã gỡ 16/10/2026 — bỏ `reports.customers`, `view=customers`, `customers.revenue/debt`; `#customers` tự chuyển sang `#business`; khóa quyền giữ `reports.business`):** Doanh số tháng = Hóa đơn Hoàn thành − Phiếu trả Đã trả (giờ VN). Tháng đã qua chốt cứng vào `business_monthly_*` (migration `0036`); tháng hiện tại tính live SQL; sale đi theo nhóm khách hàng hiện tại; team nạp từ `sale_teams` (migration `0037`). Bảng Doanh số theo khách có thêm Ghi chú / Tiếp khách lần cuối theo khách (22/10/2026, migration `0080`, quyền `reports.business.customerNotes` xem + `reports.business.customerManage` Quản lý): khóa `customer_key = nameKey(tên)` nên khách đổi tên mất liên kết; người sửa hiệu lực = `customerManage` hoặc người được Quản lý gán trong `customer_editors`; 1 note/khách/ngày chỉ sửa trong ngày VN; code fail-soft trước migration (ghi trả 503 `MIGRATION_PENDING`).
- **Báo cáo Marketing (`/reports/#marketing`):** Đọc 3 workbook Google Sheets, đối chiếu doanh số KiotViet theo tên khách hàng; hỗ trợ sửa trực tiếp Khách mới / Ghi chú ngược lại Sheets và xuất file XLSX/HTML.
- **Hàng hóa & Tồn kho:** "Tồn có thể bán" = Tồn thực tế − Đặt hàng Phiếu tạm (không cộng hàng đang vận chuyển). Ẩn đơn giá và giá trị tồn đối với nhân viên không có quyền `reports.products.cost`.

- **Kế toán – Nháp VAT (`/vat-draft/`, 17/10/2026):** port 1:1 vat-draft-app (Python) — **không sửa thuật toán** trong `server/vatDraft/allocation.js`/`nameMatching.js` (Tra cứu nguồn + `sourceLookup.js` đã gỡ 17/10/2026); mọi phép số/chuỗi kiểu Python đi qua `pyCompat.js` (round banker's, sum Neumaier, casefold, float()). Master data = 2 Google Sheet **công khai** "Gộp VAT"/"Khớp mã" đọc qua CSV export (không service account), parse theo chữ cái cột trong `vatDraftConfig.js` (kèm 17 tài khoản VietQR). Chứng từ HD/DH đọc Postgres, "Ghi chú tổng" = `raw->>'description'` chỉ gắn lúc hiển thị. Quyền `accounting.vatDraft` mặc định chỉ Quản lý (Kế toán phải được bật riêng, Khách bị cấm). Quyền `accounting.qr` (chỉ tab Tạo QR) mặc định Quản lý + Nhân viên sale, `escalationExempt`; route `/qr/*` + `/meta` nhận một trong hai quyền.
- **Tìm kiếm gần đúng theo từ (21/10/2026):** mọi ô tìm văn bản thường dùng `public/shared/fuzzy-search.js` (frontend, `window.TKSFuzzySearch`) và `shared/fuzzySearch.js` / `shared/fuzzySql.js` (server) — bỏ dấu/hoa thường; 1 từ phải khớp, 2 từ khớp cả 2, ≥3 từ khớp quá nửa; xếp theo số từ khớp, nguyên cụm đầu. Ô tìm theo mã chính xác giữ nguyên. Ô tìm lọc ngay khi gõ qua sự kiện `input` (không nút Tìm); KPI của bảng tính trên toàn bộ dòng đã lọc (hook `afterRender` ở frontend, `countSummary` ở Vòng đời đơn hàng). Vòng đời đơn hàng mặc định tìm "Theo tên khách" (server `parseParams` vẫn `mode='code'`). Không tự viết luật khớp riêng cho ô tìm mới — dùng helper chung.

### 2.5. Vòng đời đơn hàng & Khung chi tiết dùng chung
- **Khung chi tiết dùng chung (`public/shared/detail-panel.css` — `.dp-*`):** Áp dụng đồng bộ cho các hộp Chi tiết giao dịch, Báo cáo hàng hóa theo khách, Báo cáo kinh doanh (Sale/Khách/Mã hàng), Chi tiết đơn Vòng đời, Chi tiết nghỉ phép và Chi tiết Marketing. Thiết kế gồm hàng **chỉ số tổng quan** (`.dp-stats`), 1 khung cuộn thống nhất, tiêu đề dính, **tắt hoàn toàn nút Cột hiển thị** trong hộp (`data-table-controls="off"`), hỗ trợ Light/Dark mode.
- **Vòng đời đơn hàng (`/shipment/lifecycle/`):**
  - Hợp nhất ~60k đơn KiotViet với Google Sheets `ORDER_LIFECYCLE_SPREADSHEET_ID`.
  - Hỗ trợ 5 luồng: Đơn HN, Đơn SG, Đơn Bắc-Nam (`DonHang_MienNam`, tính như HN, 4 mốc thời gian, không cảnh báo 24h), Khách/Ship lấy tại kho (`Khách_HN`, `Khách_SG`).
  - 6 loại cảnh báo có tên: Kế toán sót đơn, Lái xe chưa chụp đơn, Lái xe quên chụp, Chưa nhận đơn quá 6 giờ, Khách/Ship chưa lấy, Chưa chụp bill tàu. Quy tắc: cảnh báo "Kế toán sót đơn" chỉ áp dụng khi trạng thái hiệu lực là "Đơn đã gửi kế toán" (đơn đã sang giao/nhận hoặc ghi đè thì bỏ).
  - Dải thẻ chỉ số tổng quát và lọc nhanh đầu trang (`kpis`: Chưa gửi KT chỉ tính Phiếu tạm, Đã gửi KT, Đang giao và số đơn theo từng loại cảnh báo). Bấm thẻ để lọc nhanh bảng.

---

## 3. Bản đồ Migration Cơ sở dữ liệu (0001 – 0086)

| Dải Migration | Phân hệ & Nội dung chính |
|---|---|
| `0001–0008` | Dữ liệu nền KiotViet: nhóm hàng, hàng hóa, hóa đơn, đơn hàng, trả hàng, nhập hàng, thu chi, webhook raw, backfill. |
| `0009–0012` | Tài khoản `app_users`, nhân sự `hr_employees`, role `reporting_readonly`, trạng thái thu nợ, chuẩn hóa tiền `NUMERIC`. |
| `0013–0015` | Rollup dashboard, công nợ `customer_debt_activity_periods` (CN1/CN3/CN7), `app_users.telegram_id`. |
| `0016–0017` | 3 bảng nghỉ phép & bot Telegram, `supplier_return_imports` (Trả NCC upload Excel). |
| `0018–0021` | `product_report`, vai trò `Nhân viên marketing`, phân quyền `feature_permissions JSONB`, index ngày. |
| `0022–0025` | `customer_invoice_lines_90d`, `product_report_customers`, phiếu đặt hàng nhập `order_suppliers`, `inventory_value_snapshots`. |
| `0026–0028` | Gỡ `suppliers`/`daily_purchase_summary`, tài liệu quy định `hr_rule_documents`, index đơn phiếu tạm `idx_orders_phieu_tam`. |
| `0029–0031` | Bot Telegram quản lý nghỉ phép (`decision_version`), gỡ `Tạm duyệt`, phạm vi duyệt phòng ban & card Telegram. |
| `0032–0035` | Chuẩn hóa bộ phận, Sổ quỹ (`cash_book_accounts`, `cash_book_checkpoints`, `cash_book_account_banks`, `source_missing_at`). |
| `0036–0037` | Báo cáo kinh doanh tháng chốt cứng (`business_monthly_*`), bảng phân chia Team sale `sale_teams`. |
| `0038–0040` | Lịch làm việc & hạn nộp nghỉ phép (`hr_leave_work_schedules`, `hr_leave_submissions`), tài liệu Phúc lợi `phuc-loi`, `account_audit_log`. |
| `0041–0042` | Trạng thái nhân sự `employment_status` (`active`/`resigned`), đơn nghỉ phép cho tài khoản nội bộ chưa gắn nhân sự (`hr_employee_id` nullable). |
| `0043` | `special_day_notice_log` — chống gửi trùng thông báo ngày lễ/sinh nhật. |
| `0044` | `purchases.raw_hash` — băm raw phiếu nhập đối soát không cần tải lại cột `raw`, giảm egress Supabase. |
| `0057` | `product_report` thêm `available_hanoi`/`available_saigon`/`description_hanoi`/`description_saigon` (Có bán + Mô tả theo từng cơ sở). |
| `0058` | Index `orders(branch, order_date)` cho danh sách đơn đặt hàng chưa xuất HĐ của Kế toán – Nháp VAT. |
| `0068–0070` | Tính sẵn Báo cáo kinh doanh (`business_current_month_*`), Báo cáo Marketing (`marketing_ads_costs`, `marketing_phone_summary`), view Sổ quỹ (`v_cash_book_transactions`). |
| `0075` | `product_container_expected` — Bảng tính sẵn Hàng dự kiến theo Cont từ `product_container_lines`. |
| `0076` | `vat_requests` + `vat_request_history` — Bảng Kế toán ORDER VAT. |
| `0077` | `invoice_price_audit_*` — Bảng kiểm tra sai giá hóa đơn HN/SG trong cửa sổ 7 ngày. |
| `0078` | `product_container_expected` thêm cột giá: `listed_at`, `unit_price_cny`, `vietnam_price`. |
| `0079` | `vat_requests.sort_rank` NUMERIC — Thứ tự ưu tiên dòng ORDER VAT khi kéo thả. |
| `0080` | `customer_profiles`, `customer_notes`, `customer_visit_days` (Ghi chú / Tiếp khách); `vat_request_notice_state` (chuông ORDER VAT). |
| `0081–0082` | Tách tài khoản khỏi HR (`app_users.work_branch`, `hr_leave_work_schedules.user_id`, `hr_leave_submissions.user_id`). |
| `0083` | `vat_requests` trạng thái 5 ("VAT sẵn nhiều"). |
| `0084` | `customer_profiles.area`, mở rộng `warehouse_scale` (very_large) và `sales_channels` (khac). |
| `0085` | `user_table_prefs` — Ghi nhớ độ rộng và ẩn/hiện cột theo tài khoản (desktop/mobile). |
| `0086` | `product_container_other_note` — Ghi chú khác của CONT từ cột G. |

---

## 4. Quy ước Frontend & Trải nghiệm người dùng (UI Standards)

1. **Điều khiển bảng dùng chung (`public/shared/table-controls.js`):**
   - Nút **Cột hiển thị** mở menu chọn cột, lưu tùy chọn trong phiên.
   - Tay kéo chỉnh độ rộng cột ở mép phải tiêu đề, nội dung dài xuống dòng.
   - Ô tìm kiếm tích hợp nút xóa nhanh (`search-clear`).
   - Phân trang chuẩn 100 dòng/trang, hỗ trợ chuyển trang mượt mà (áp dụng cho Báo cáo, Vòng đời đơn hàng, Sổ quỹ, Nhân sự, Tài khoản).
   - Tắt điều khiển cột đối với các bảng quy định/chính sách tĩnh.
2. **Khung xem chi tiết dùng chung (`public/shared/detail-panel.css`):**
   - Tiền tố `.dp-*`: `.dp-head`, `.dp-stats`, `.dp-card`, `.dp-section`, `.dp-table-wrap`, `.dp-table`.
   - Có dải thẻ **chỉ số tổng quan** (`.dp-stats`), 1 khung cuộn duy nhất, tiêu đề bảng dính trên.
   - **Tắt nút Cột hiển thị** (`data-table-controls="off"`), không làm rối khung xem chi tiết.
3. **Không dùng framework nặng:** Giữ thuần JavaScript và CSS variables để tối đa tốc độ tải trang và phản hồi dưới 100ms.
4. **Thẩm mỹ cao cấp:** Màu sắc hài hòa theo bảng màu định sẵn trong `shared.css`, hỗ trợ cả giao diện Sáng và Tối, responsive hoàn chỉnh trên thiết bị di động.

## Marketing Pancake — bất biến 12/10/2026

`PANCAKE_MARKETING_SYNC_ENABLED=false` mặc định; chỉ bật sau khi khôi phục ID và thử đồng bộ đạt. `MARKETING_REPORT_SOURCE=sheets` mặc định; đặt `postgres` sau ít nhất ba đợt hằng ngày đối soát đủ sáu page. Token `PANCAKE_PAGE_TOKEN_<pageId>` chỉ ở phía máy chủ, không commit hoặc trả API. Giữ riêng Tạo lúc và ngày ghi nhận thành công Việt Nam; lịch sử giữ ngày cũ. ADS luôn đọc Sheets (kể cả Quảng Châu); doanh số luôn lấy KiotViet theo tên, bán trừ trả hàng HN+SG.

Không đổi hoặc xóa lịch sử khi nguồn thiếu ID; mơ hồ phải đối soát bản xuất gốc. Lịch sử numeric/string SĐT vẫn nguyên trạng, không tự gộp số mất 0. Migration runner theo tên đầy đủ: `0044_pancake_marketing.sql` đã áp, giữ nguyên tên; `0044_purchases_raw_hash.sql` của Claude là migration khác và được bảo toàn.

### 14/10/2026 — Thưởng/phạt sale Công nợ

Điểm theo từng khách (cơ sở + mã): số hóa đơn Hoàn thành và doanh số sau trừ trả hàng trong tháng; >=30 điểm mới xếp hạng chung HN + SG theo phạt gốc/điểm tăng dần, điểm giảm dần; bằng tỷ lệ và điểm thì đồng hạng kiểu 1–2–2–4, tên chỉ dùng sắp dòng hiển thị. Top 1–20 miễn phạt; Top 10 nhận quỹ max(80% phạt phải nộp, 3 triệu), 50% theo trọng số hạng 19–17–15–13–11–9–7–5–3–1 và 50% theo tỷ trọng điểm; thiếu 10 người chuẩn hóa trọng số, chia hết quỹ đến đồng. Sửa phạt chỉ thay phạt gốc từng khách; miễn phạt áp ở mức sale. GET /api/debt-management/penalty-board?month=YYYY-MM trả bảng từ backend (mặc định tháng chu kỳ đang mở), lọc cơ sở sau khi tính hạng/quỹ toàn công ty. Giao diện, hộp chi tiết và xuất Excel/HTML dùng cùng kết quả; context.debtRewardMonth chọn tháng xuất. Kết quả tháng cũ lưu bất biến trong debt_reward_months sau bản chốt 15:00 đầu tháng mới, khi đã chốt hết sổ phạt và doanh số tháng. Lỗi chốt thử lại mỗi phút; thiếu lịch sử phạt có cảnh báo rõ, không bù thành 0. Migration 0051/0052 đã áp trên DB dùng chung; code hoàn tất trên main, chưa push/deploy. Tháng đầu chỉ có lịch sử phạt còn lưu được, hiển thị ngày thiếu.

Điều chỉnh 15/10/2026: trong tháng hiển thị điểm/hạng, thưởng tạm tính và tổng phạt từ các ngày ĐÃ CHỐT, không cộng chu kỳ đang mở. Lúc 14:59 giờ Việt Nam lưu bản cuối của chu kỳ 15:00 hôm trước–14:59 hôm sau, mỗi chu kỳ đúng một lần và không ghi đè; 15:00 mới reset. Nhiều lần Tính lại trong chu kỳ chỉ cập nhật bản đang mở, không cộng thành nhiều ngày. Tiền thưởng hiện mỗi ngày với nhãn Thưởng tạm tính, thay đổi theo điểm và tổng phạt đã chốt ngày; chỉ chốt/lưu thưởng chính thức một lần khi kết thúc tháng. Web, hộp chi tiết và file xuất đều phân biệt tạm tính/đã chốt.

Đồng hạng (15/10/2026): bằng Phạt gốc/Điểm và tổng điểm thì cùng hạng, xếp 1–2–2–4. Tất cả đồng hạng 10 nhận thưởng, đồng hạng 20 miễn phạt. Nhóm đồng hạng gộp trọng số các vị trí chiếm trong Top 10 rồi chia đều, các vị trí ngoài 10 không thêm trọng số; giữ nguyên tổng quỹ, thưởng theo điểm chia trong toàn bộ nhóm nhận thưởng. Bản tháng đã chốt giữ nguyên quy tắc cũ; bản mới dùng debt-reward-2026-10-v2-shared-ranks.
