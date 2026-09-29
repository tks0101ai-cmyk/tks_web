# TOKOSI Dashboard Server

Express backend cho dashboard TOKOSI.

## Nguồn dữ liệu

- KiotViet dashboard: Supabase PostgreSQL qua `dashboard/dashboardPgReader.js`.
- CN1/CN3/CN7: bảng `customer_debt_activity_periods` trong Supabase (công nợ 1/3/7 ngày, trước đây gọi là HN1/HN3/HN7).
- Trả NCC: người dùng tự upload file Excel xuất từ KiotViet; server nạp vào bảng Postgres `supplier_return_imports` (migration `0017`) — **không còn đọc tab Google Sheets Trả NCC**.
- Công nợ quản lý: workbook `DEBT_MANAGEMENT_SPREADSHEET_ID` (Google Sheets, chỉ đọc).
- Nhân sự và nghỉ phép: 3 bảng Postgres (`hr_leave_requests`, `hr_telegram_links`, `hr_telegram_sessions`, migration `0016`); workbook HR riêng dùng cho `HR_SPREADSHEET_ID`/`HR_SPREADSHEET_ID_SG`.
- Vòng đời đơn hàng: Google Sheets workbook `ORDER_LIFECYCLE_SPREADSHEET_ID` (`DonHang_HN`, `DonHang_SG`, `Lịch sử cập nhật`).
- Tài khoản và Telegram ID: PostgreSQL `app_users`; không dùng tab `Users` hoặc `_HR_TELEGRAM_LINKS` để liên kết.

Không còn Apps Script KiotViet. Đã gỡ bỏ tính năng vận chuyển cũ (chỉ giữ lại tính năng vòng đời đơn hàng).

## API báo cáo tổng hợp theo tab

`GET /api/dashboard?view=<tab>` chỉ đọc/tính/trả phần của **một tab** (`overview`, `products`, `invoices`, `customers`, `suppliers`, `debt`; có thể ghép nhiều tab bằng dấu phẩy). Trang `/reports/` gọi khi người dùng mở từng tab, mỗi tab kèm đúng bộ lọc của nó; bỏ trống `view` = cả 6 tab như trước (giữ tương thích).

- Khai báo tab (bảng nguồn, rollup, bộ lọc, phần payload) ở `dashboard/dashboardViews.js`; cache bảng nguồn theo từng bảng + cache kết quả theo (cơ sở, tab, bộ lọc của tab) ở `dashboard/dashboardData.js`.
- Tab tài khoản không có quyền xem trả `{ "filters": {}, "kpi": {} }` (không đọc/tính gì); tên tab sai trả 400 `INVALID_VIEW`.
- Thêm/đổi trường payload của một tab: sửa `VIEW_PAYLOAD` trong `dashboardViews.js` (test "tung tab: payload y het lat cat cua ban day du" sẽ báo nếu tab không tính đủ trường đã khai báo).
- Bộ lọc thời gian theo khối: `pr*` = Tổng quan (doanh thu theo nhóm hàng), `ni*` = Hàng hóa › Hàng mới nhập, `np*` = Hàng hóa › Mã mới tạo; `prStatus` là trạng thái kinh doanh dùng chung Tổng quan + Hàng hóa. Hàng hóa › Phân tích doanh thu luôn 90 ngày gần nhất (`PRODUCT_ANALYSIS_DAYS`), không nhận bộ lọc.

## Lệnh

```bash
npm install
npm run db:migrate
npm test
npm run dev
```

Các job đồng bộ:

```bash
npm run kiotviet-sync:preflight
npm run kiotviet-sync:backfill
npm run kiotviet-sync:reconcile
```

Khi `KIOTVIET_SYNC_ENABLED=true`, service chạy một lượt catch-up nền ngay lúc
khởi động từ checkpoint gần nhất, sau đó tiếp tục polling theo
`KIOTVIET_SYNC_FAST_INTERVAL_MS` và `KIOTVIET_SYNC_SLOW_INTERVAL_MS`.

## Cấu hình Sheets

Server **không còn đọc tab Trả NCC** từ Google Sheets HN/SG (đã chuyển sang upload Excel vào Postgres `supplier_return_imports`). Service account vẫn cần quyền:
- **Viewer** trên workbook `DEBT_MANAGEMENT_SPREADSHEET_ID` (Công nợ HN/SG).
- **Viewer** trên workbook `ORDER_LIFECYCLE_SPREADSHEET_ID` (tra cứu vòng đời đơn hàng — server đọc tab `DonHang_HN`, `DonHang_SG`; ghi tab `Lịch sử cập nhật` nên cần **Editor**).
- **Viewer** (hoặc không cần) trên workbook HR — chỉ đọc `HR_SHEET_EMPLOYEES` để đồng bộ nhân sự.

Hai file Kiot HN/SG **không còn** được server truy cập.

## Cấu hình Supabase

Đặt `SUPABASE_DB_URL`, sau đó chạy `npm run db:migrate`. Danh sách migration:

| Migration | Mục đích |
|---|---|
| `0001–0008` | Bảng master data, hóa đơn, đơn hàng, trả hàng, nhập hàng, cash flows, webhook raw, backfill progress |
| `0009` | `hr_employees` + `app_users` (tài khoản đăng nhập thay tab "Users" Sheets) |
| `0010` | Role `reporting_readonly` cho SQL client/BI |
| `0011` | `debt_collection_statuses` (trạng thái thu nợ) |
| `0012` | Đổi cột tiền/số lượng từ `BIGINT`→`NUMERIC` |
| `0013` | 4 bảng rollup Dashboard (`daily_invoice_summary`, `daily_product_sales`, `daily_purchase_summary`, `product_first_purchase`) |
| `0014` | `customer_debt_activity_periods` — CN1/CN3/CN7 |
| `0015` | `app_users.telegram_id` |
| `0016` | 3 bảng nghỉ phép + bot Telegram (`hr_leave_requests`, `hr_telegram_links`, `hr_telegram_sessions`) |
| `0017` | `supplier_return_imports` — Trả NCC upload Excel thay tab Google Sheets |
| `0018` | `product_report` — báo cáo hàng hóa tổng hợp 2 cơ sở |
| `0019` | Thêm vai trò `Nhân viên marketing` vào CHECK `app_users.vai_tro` |
| `0020` | `app_users.feature_permissions JSONB` — phân quyền theo tính năng từng tài khoản |
| `0021` | Index ngày `invoices`/`purchases`/`returns` cho rollup Dashboard và làm mới công nợ 1/3/7 ngày |
| `0022` | `customer_invoice_lines_90d` + `customer_invoice_lines_state` — chi tiết hóa đơn 90 ngày gắn sẵn mã khách, dựng lại 1 lần/đêm cho báo cáo doanh thu theo khách |

Bot Telegram chạy ngoài repo và đọc/ghi 3 bảng nghỉ phép trực tiếp — hợp đồng dữ liệu ở `db/SCHEMA.md`.
