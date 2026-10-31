# TÀI LIỆU SƠ ĐỒ QUY TRÌNH NGHIỆP VỤ

*(Business Process Model and Notation – BPMN)*

**HỆ THỐNG DASHBOARD NỘI BỘ — TOKOSI**

| **Thông tin**      | **Nội dung**                                                         |
|--------------------|----------------------------------------------------------------------|
| Tên dự án          | Hệ thống Dashboard nội bộ TOKOSI                                    |
| Phiên bản          | 3.0                                                                  |
| Ngày tạo           | 27/07/2026                                                           |
| Ngày cập nhật      | 30/10/2026 (riêng Luồng G Vị trí hàng; các luồng khác giữ nguyên rà soát 05/10/2026) |
| Tài liệu liên quan | BRD v2.2 · SRS v3.0 · Implementation Plan (cập nhật 05/10/2026) · CSNS-NP-01 · Design System MASTER · `server/db/SCHEMA.md` |
| Trạng thái         | Khớp code tại HEAD `11751c4` (migration `0001`–`0030`). Tên file giữ nguyên `…_GoogleSheets.md` vì lý do lịch sử; nguồn dữ liệu chính nay là Supabase PostgreSQL. |

> **Ghi chú v3.0 (05/10/2026):** viết lại toàn bộ so với v2.1. Các luồng cũ gắn với Apps Script, tab `HR_Leaves`, endpoint `/api/hr/leave/*`, `/api/auth/request-reset-otp`… không còn tồn tại trong code và đã được thay bằng mô tả đúng hiện trạng. Thêm luồng F (Vòng đời đơn hàng) và G (Vị trí hàng).

---

# 1. Giới thiệu

Tài liệu mô tả các luồng quy trình vận hành của Dashboard TOKOSI theo BPMN 2.0 (text diagram + bảng bước). Bảy luồng chính:

- **Luồng A:** Đồng bộ KiotViet → Supabase PostgreSQL (polling là nguồn dữ liệu; webhook chỉ lưu thô) và các job tổng hợp nền.
- **Luồng B:** Người dùng xem Báo cáo tổng hợp theo tab, lọc theo bảng, xuất file, kiểm tra đứt hàng (kể cả upload Trả NCC).
- **Luồng C:** Cấu hình và triển khai (Render.com + Supabase migrations).
- **Luồng D:** Xác thực, quản lý tài khoản, khóa tự đăng ký, ID Telegram và khôi phục mật khẩu OTP.
- **Luồng E:** Nghỉ phép nhân sự: bot xin nghỉ (ngoài repo), duyệt trên web, bot Telegram riêng cho quản lý.
- **Luồng F:** Vòng đời đơn hàng (đơn KiotViet ghép Google Sheet).
- **Luồng G:** Vị trí hàng (VT Hà Nội / VT Sài Gòn, đọc/ghi Postgres `stock_positions`; module cũ đọc Google Sheets đã gỡ 30/10/2026).

---

# 2. Bể và làn quy trình (Pools & Lanes)

| **Vai trò (Lane)**         | **Mô tả trách nhiệm**                                                                                                           |
|----------------------------|---------------------------------------------------------------------------------------------------------------------------------|
| KiotViet Public API        | Nguồn dữ liệu bán hàng. Phục vụ polling (GET); gửi webhook POST nhưng webhook hiện chỉ được lưu thô.                          |
| Node.js Sync Engine        | `server/kiotvietSync/` chạy cùng tiến trình Express: polling fast/slow, rollup, CN1/CN3/CN7, báo cáo hàng hóa, chụp tồn kho. |
| Supabase PostgreSQL        | Kho dữ liệu trung tâm: dữ liệu KiotViet, rollup, `app_users`, `hr_*`, nghỉ phép, trạng thái công nợ, Trả NCC, tài liệu quy định. |
| Google Sheets              | Nguồn bổ trợ: Bảng Công nợ (đọc), Vòng đời đơn hàng (`DonHang_HN`/`DonHang_SG` đọc, `Lịch sử cập nhật` ghi), sheet CÂN ĐO (đọc, qua job `sheetSnapshots`). |
| Backend (Express)          | REST API, xác thực JWT, phân quyền theo tính năng, cache, tính KPI/bảng, xuất Excel/HTML, SSE, bot Telegram quản lý.          |
| Bot xin nghỉ (ngoài repo)  | Tiến trình riêng của nhân viên: nhận tin xin nghỉ, ghi thẳng vào `hr_leave_requests`, báo kết quả qua `decision_notified_at`.  |
| Telegram (bot quản lý)     | Bot riêng cho quản lý, chạy trong Express, nhận webhook `POST /api/telegram/manager-leave/webhook`.                            |
| Người dùng / Frontend      | HTML/CSS/JS thuần trong `server/public/`; Chart.js; tải dữ liệu theo tab, lọc/sắp xếp/tìm trong từng bảng.                    |

---

# 3. Chú giải ký hiệu

| **Ký hiệu văn bản**     | **Ý nghĩa**                                                                              |
|-------------------------|------------------------------------------------------------------------------------------|
| [Start]                 | Sự kiện Bắt đầu.                                                                         |
| [End]                   | Sự kiện Kết thúc.                                                                        |
| [Event]                 | Sự kiện trung gian / mốc quan trọng.                                                     |
| [Task]                  | Tác vụ.                                                                                  |
| [Decision]              | Cổng quyết định loại trừ (đi đúng 1 nhánh).                                              |
| ->                      | Luồng tuần tự chính.                                                                     |
| -->                     | Luồng ngoại lệ / vòng lặp / kích hoạt bất đồng bộ.                                       |

---

# 4. Sơ đồ tổng quan

```
Luồng A (nền):      KiotViet --polling--> Sync Engine --> Supabase PostgreSQL --> rollup/job nền --> SSE "dashboard-updated"
                    KiotViet --webhook--> hàng đợi --> chỉ ghi webhook_events_raw (không upsert nghiệp vụ)

Luồng B (yêu cầu):  Người dùng -> Frontend -> GET /api/dashboard?view=<tab> -> cache -> Postgres (+ Sheet công nợ cho tab Công nợ)
Luồng C (một lần):  IT Admin: biến môi trường Render + `npm run db:migrate` + webhook KiotViet
Luồng D (sự kiện):  Đăng nhập / OTP quên mật khẩu / hồ sơ / Quản lý tạo-sửa tài khoản & phân quyền
Luồng E (sự kiện):  Bot xin nghỉ -> hr_leave_requests -> web + chuông + bot quản lý -> Phê duyệt / Từ chối
Luồng F (yêu cầu):  Người dùng -> /api/shipment/lifecycle (đơn Kiot trong Postgres + Google Sheet) -> 1 trang 100 dòng
Luồng G (yêu cầu):  Người dùng -> /api/stock-positions?branch= -> Postgres stock_positions (+ SL Kiot từ products)
```

Luồng A độc lập với các luồng còn lại. Luồng B/F/G chỉ **đọc** dữ liệu; chỉ Quản lý công nợ, ghi đè vòng đời đơn hàng, upload Trả NCC và các thao tác tài khoản/nghỉ phép mới ghi.

---

# 5. Luồng A — Đồng bộ KiotViet → Supabase PostgreSQL

Chạy liên tục khi `KIOTVIET_SYNC_ENABLED=true`, không phụ thuộc người dùng web.

```
[A0] [Start] Server khởi động -> chạy ngay 1 lượt fast + 1 lượt slow nền từ checkpoint gần nhất (bù khoảng trống khi redeploy)

--- Nhánh A1: Polling (nguồn dữ liệu thật) ---
[A1] [Event] Mỗi 7 phút: nhóm fast = invoices, orders, product_on_hands, product_on_hands_snapshot, order_suppliers
[A2] [Task] Với mỗi cơ sở (HN, SG): gọi KiotViet API (lastModifiedFrom theo checkpoint; riêng order_suppliers và snapshot tồn kho quét toàn bộ),
            upsert vào Postgres; checkpoint chỉ tiến sau khi MỌI trang thành công
[A3] [Decision] Lỗi?
     |-- Có -> ghi lỗi vào sync_checkpoints.note, giữ mốc cũ để replay lần sau
     `-- Không -> [A4]
[A4] [Task] Tính ngay rollup "nóng" 7 ngày (daily_invoice_summary, daily_product_sales) rồi phát SSE `dashboard-updated`
[A5] [Event] Mỗi 20 phút: nhóm slow = categories, products, customers, returns, purchases (đối soát toàn bộ từ mốc sàn đứt hàng 01/02/2026), cash_flows

--- Nhánh A6: Webhook ---
[A6] [Event] KiotViet POST /api/kiotviet/webhook/<KIOTVIET_WEBHOOK_SECRET> (secret sai -> 404)
[A7] [Task] Trả 200 ngay, đưa vào hàng đợi nền; worker chỉ INSERT payload thô vào webhook_events_raw (không cập nhật bảng nghiệp vụ)

--- Nhánh A8: Job tổng hợp nền ---
[A8]  Mỗi 30 phút: rollup đầy đủ 400 ngày (+ product_first_purchase)
[A9]  Mỗi 5 phút: customerDebtReportRefresh -> customer_debt_activity_periods (CN1/CN3/CN7, chỉ ghi dòng đổi)
[A10] Kiểm tra mỗi 5 phút, tính 1 lần/đêm: productReportRefresh -> product_report + product_report_customers
[A11] Kiểm tra mỗi 5 phút, dựng 1 lần/đêm sau 00:10 VN: customerInvoiceLinesRefresh -> customer_invoice_lines_90d
[A12] Kiểm tra mỗi phút, chụp lúc 23:59 VN (bù trước 12:00 hôm sau nếu server tắt): inventoryValueSnapshot -> inventory_value_snapshots
[A13] [End] Database luôn có dữ liệu mới nhất cho Luồng B
```

| **Bước** | **Vai trò**           | **Mô tả**                                                                                           | **Tham chiếu** |
|----------|-----------------------|-----------------------------------------------------------------------------------------------------|----------------|
| A0       | Sync Engine           | Catch-up nền khi khởi động, HTTP vẫn nhận request trong lúc đồng bộ.                               | FR-06.3        |
| A1–A5    | Sync Engine           | Polling nhóm fast/slow, checkpoint, rollup nóng, SSE.                                               | FR-06.1–06.3, FR-06.6 |
| A6–A7    | Webhook queue         | Chỉ lưu thô; polling mới là nguồn cập nhật.                                                         | FR-06.2        |
| A8–A12   | Scheduler             | Rollup, CN1/CN3/CN7, báo cáo hàng hóa, chi tiết hóa đơn 90 ngày, giá trị tồn kho.                  | FR-06.6–06.11  |

---

# 6. Luồng B — Sử dụng Báo cáo tổng hợp

```
[B0] [Start] Người dùng mở /reports/ (sidebar: Tổng quan, Hàng hóa, Hóa đơn, Khách hàng, Quản lý công nợ, Báo cáo kinh doanh — chỉ hiện tab có quyền reports.*; Báo cáo kinh doanh đi theo luồng 6.4)
[B1] [Task] Frontend gọi GET /api/dashboard?view=<tab đang mở>&<bộ lọc của tab> (mỗi tab tải khi được mở, mỗi bảng có bộ lọc Từ–Đến riêng)
[B2] [Decision] requireAuth + requireFeature + resolveBranch: có quyền xem tab?
     |-- Không -> trả payload rỗng { filters: {}, kpi: {} } (không đọc/tính gì)
     `-- Có -> [B3]
[B3] [Decision] Cache kết quả theo (cơ sở, tab, bộ lọc) còn hạn (90 giây)?
     |-- Có -> trả ngay
     `-- Không -> đọc các bảng nguồn của tab (cache theo từng bảng, TTL 90 giây, tối đa stale 10 phút) + rollup song song
              + tab Công nợ: đọc Bảng Công nợ (Google Sheets) + trạng thái xử lý (Postgres) + CN1/CN3/CN7
[B4] [Task] computeDashboardData() tính KPI, bảng, biểu đồ; "Cả hai" gộp hai cơ sở (hàng hóa/giao dịch giữ khóa (cơ sở, mã), khách gộp theo tên)
[B5] [Task] filterDashboardForUser() cắt phần ngoài quyền -> HTTP 200 JSON
[B6] [Task] Frontend render KPI, biểu đồ (Chart.js 2D), bảng phân trang 100 dòng; tìm kiếm/sắp xếp (cột thời gian sắp theo thời gian thật) trên toàn bộ dữ liệu đã lọc
[B7] [Event] Dashboard sẵn sàng
```

**Cập nhật gần thời gian thực (thay cho tự gọi lại mỗi 10 phút của bản cũ):**

```
[B8]  [Event] Sau mỗi lượt sync fast + rollup, server phát SSE `dashboard-updated` trên GET /api/dashboard/events (heartbeat 25 giây)
[B9]  [Task] Trình duyệt đánh dấu mọi tab đã tải là cũ, tải lại tab đang xem sau độ trễ ngẫu nhiên 0–3 giây; tab khác tải lại khi được mở
[B10] [Event] Tab trở lại trạng thái hiển thị sau >= 60 giây -> tải lại; SSE lỗi 5 lần liên tiếp -> thử nối lại sau 1, 5, 15 phút
[B11] [Task] Nút "Làm mới" tải lại tab hiện tại; chỉ render lại khi dữ liệu nghiệp vụ thực sự đổi (so fingerprint)
```

## 6.1. Luồng Xuất file

```
[B12] [Task] Người dùng bấm "Xuất Excel" (hoặc "Xuất HTML") trên một bảng -> mở modal (hủy được: X / Hủy / Esc / bấm nền)
[B13] [Task] POST /api/export/fields (tableKey + filters + context, timeout 30 giây) -> danh sách worksheet/trường từ từ điển tĩnh, không chạm DB
              (bảng search.results đã gỡ 05/10/2026 cùng GET /api/search)
[B14] [Task] Người dùng chọn trường -> POST /api/export (timeout 180 giây)
[B15] [Task] Backend kiểm tra bảng/trường hợp lệ -> xin 1 trong 2 chỗ xuất file (hàng đợi tối đa 8, vượt -> 503 EXPORT_BUSY)
              -> lấy mã dòng đã lọc từ getDashboardData() -> readRowsByCodes() đọc đúng các mã đó từ Postgres (bảng tổng hợp dùng dữ liệu đã tính)
              -> ExcelJS ghi .xlsx (hàng tiêu đề cố định, AutoFilter, ép text cho mã/SĐT, vô hiệu chuỗi công thức) hoặc dựng báo cáo HTML tự chứa
[B16] [End] Trình duyệt tải file; hủy/ngắt kết nối thì server dừng và nhả chỗ xuất
```

Bảng xuất được: Chi tiết giao dịch, Danh sách mã mới, Sản phẩm bán chạy, Tất cả mã hàng, Hàng mới nhập, Chi tiết tồn kho theo sản phẩm, Doanh thu theo khách, Chi tiết khách nợ, Bảng chi tiết sản phẩm theo khách, Báo cáo hàng hóa, Quản lý công nợ, Hàng đứt gần đây, Kiểm tra đứt hàng 90/30 ngày.

## 6.2. Luồng Kiểm tra đứt hàng và Trả NCC (tab Tổng quan, quyền `reports.products`)

```
[B17] [Task] Người dùng upload file Excel "Trả hàng nhập" xuất từ KiotViet cho 1 cơ sở -> POST /api/products/supplier-returns/import
[B18] [Task] Server thay TOÀN BỘ dữ liệu cũ của cơ sở đó trong supplier_return_imports bằng dữ liệu file (GET .../import-status cho biết lần nạp gần nhất)
[B19] [Task] Người dùng chạy quét: "Hàng đứt gần đây" / "30 ngày" / "90 ngày" -> POST /api/products/stockout-{recent|30d|90d}/scan -> jobId
[B20] [Task] Frontend hỏi tiến độ mỗi 1,5 giây (GET .../:jobId/progress) -> khi xong lấy kết quả (GET .../:jobId/result)
              Nguồn: hóa đơn, nhập hàng, khách trả, Trả NCC đã đồng bộ/nạp trong Postgres. Ở "Cả hai" quét tuần tự hai cơ sở; một cơ sở lỗi thì cả job báo lỗi
[B21] [End] Hiện bảng kết quả (xuất được ra Excel)
```

## 6.3. Luồng Quản lý công nợ (tab Công nợ)

```
[B22] [Task] Backend đọc Bảng Công nợ (tab Công nợ HN/SG, chỉ đọc), đối chiếu CN1/CN3/CN7 -> cảnh báo "Chưa thu"/"Quá hạn"
[B23] [Task] Người có quyền reports.debt.edit (mặc định Quản lý, Trợ lý) PATCH /api/debt-management/status (cơ sở lấy từ session, không từ body)
              Ở "Cả hai": ghi cả hai cơ sở trong 1 transaction, mỗi cơ sở lưu chữ ký cảnh báo riêng; lỗi -> ROLLBACK, cache chỉ xóa sau COMMIT
[B24] [End] Khách đã xử lý rời hàng chờ; trạng thái tự hết hiệu lực khi chữ ký cảnh báo (loại cảnh báo + số nợ) đổi
```

## 6.4. Luồng Báo cáo kinh doanh (tab `#business`, quyền `reports.business`)

```
[B25] [Timer] Mỗi 5 phút job businessMonthlyRefresh.js đọc business_monthly_state
[B26] [Decision] Còn tháng đã qua (từ T3/2026) chưa chốt, và đã qua 00:10 VN ngày mùng 1?
     |-- Có -> chốt từng tháng: DELETE + INSERT ... SELECT bảng khách / khách × mã / mã + ghi state, trong 1 giao dịch (lỗi -> ROLLBACK, lượt sau thử lại)
     `-- Không -> [B27]
[B27] [Decision/Task] Có state và hash nhóm hiện tại khác group_hash đã lưu (NULL sau chốt/chốt lại)? Có -> dựng sale + ghi hash cùng giao dịch; lỗi rollback cả hai. Không -> bỏ dựng sale (khách không nhóm -> "Chưa phân nhóm")
[B28] [Task] Người dùng mở /reports/#business -> GET /api/business-report/sales|customers|products (gộp HN + SG, không theo bộ chọn cơ sở)
              Tháng đã chốt đọc bảng business_monthly_*; tháng hiện tại/chưa chốt tính trực tiếp bằng cùng SQL (cache 60 giây)
[B29] [Task] Server tính quy đổi 30 ngày, tăng trưởng, TB 4 tháng, khách hoạt động -> frontend vẽ 3 bảng; bấm dòng -> GET /api/business-report/detail (panel + biểu đồ cột)
[B30] [Task] (Tùy chọn) Quản lý bấm "Tính lại tháng" -> POST /api/business-report/refreeze { month } -> chốt lại tháng đó + dựng lại bảng sale
[B31] [End] Bấm "Xuất file" -> hộp thoại chọn trường (GET /api/business-report/export/fields) -> Xuất Excel/HTML: GET /api/business-report/export?columns=... (cần thêm reports.export)
```

| **Bước** | **Vai trò**    | **Mô tả**                                                                                           | **Tham chiếu**      |
|----------|----------------|-----------------------------------------------------------------------------------------------------|---------------------|
| B1–B5    | Frontend/Backend | Tải theo tab, phân quyền, cache hai tầng (nguồn theo bảng + kết quả theo bộ lọc).                  | FR-01, FR-03, NFR-01 |
| B6       | Frontend       | Phân trang 100 dòng, tìm/sắp xếp từng bảng, bộ lọc Từ–Đến theo bảng.                                | FR-04, FR-07        |
| B8–B11   | Backend/Frontend | SSE `dashboard-updated`, tải bù khi quay lại tab.                                                   | FR-05               |
| B12–B16  | Người dùng/Backend | Xuất Excel/HTML, giới hạn 2 file đồng thời.                                                        | FR-07.5–07.8, NFR-13, NFR-14 |
| B17–B21  | Người dùng/Backend | Upload Trả NCC và quét đứt hàng.                                                                    | FR-03.12            |
| B22–B24  | Quản lý/Trợ lý | Quản lý công nợ.                                                                                    | FR-11, FR-12.6      |
| B25–B31  | Job/Người dùng/Quản lý | Chốt doanh số tháng, Báo cáo kinh doanh, tính lại tháng.                                    | FR-16, FR-06.13     |

---

# 7. Luồng C — Thiết lập hệ thống

```
[C0] [Start] Triển khai lần đầu hoặc cấu hình lại
[C1] [Task] IT Admin tạo Web Service Render.com + Database Supabase (dùng "Direct connection" cổng 5432, không dùng pooler)
[C2] [Task] Đặt biến môi trường bắt buộc: SUPABASE_DB_URL, GOOGLE_SERVICE_ACCOUNT_JSON, JWT_SECRET
             KiotViet: KIOTVIET_CLIENT_ID/SECRET/RETAILER (+ hậu tố _SG cho Sài Gòn), KIOTVIET_SYNC_ENABLED, KIOTVIET_WEBHOOK_SECRET
             Google Sheets: DEBT_MANAGEMENT_SPREADSHEET_ID, ORDER_LIFECYCLE_SPREADSHEET_ID (Editor), STOCK_LOCATIONS_SPREADSHEET_ID (workbook CÂN ĐO, tên di sản)
             Tùy chọn: GOOGLE_CLIENT_ID, SMTP_*, ALLOW_SELF_REGISTRATION, HR_MANAGER_TELEGRAM_* (xem README.md)
[C3] [Task] Render deploy từ branch main (npm install; `npm test` chạy cục bộ trước khi push)
[C4] [Task] Áp migration TRƯỚC khi chạy bản web mới: `npm run db:migrate` (0001 -> 0030); riêng 0026 (xóa suppliers) áp SAU khi code mới đã chạy
[C5] [Task] Đăng ký webhook KiotViet trỏ về /api/kiotviet/webhook/<secret>; khi đã đổi xong đặt KIOTVIET_WEBHOOK_LEGACY_PATH_ENABLED=false
[C6] [Task] Khởi động scheduler (KIOTVIET_SYNC_ENABLED=true); chạy backfill/preflight khi cần (`npm run kiotviet-sync:preflight|backfill|reconcile`)
[C7] [Task] Sau migration báo cáo mới: chạy tay `node kiotvietSync/customerInvoiceLinesRefresh.js`, `node kiotvietSync/productReportRefresh.js` để có dữ liệu ngay
[C8] [Task] Bot quản lý (tùy chọn): theo docs/telegram-manager-leave-setup.md (token, secret, origin, `npm run telegram-manager:set-webhook`, quản lý bấm Start)
[C9] [Task] Tài khoản quản trị: admin cứng (HARDCODED_ADMINS) luôn đăng nhập được; tài khoản khác do Quản lý tạo (tự đăng ký đang khóa)
[C10][End] Hệ thống sẵn sàng
```

| **Bước** | **Vai trò**  | **Mô tả**                                                                                       | **Tham chiếu** |
|----------|--------------|-------------------------------------------------------------------------------------------------|----------------|
| C1–C2    | IT Admin     | Hạ tầng và biến môi trường.                                                                     | NFR-02, NFR-03 |
| C4       | IT Admin     | Migration; thứ tự quan trọng với 0026, 0029, 0030.                                              | server/README.md |
| C5–C7    | IT Admin     | Webhook, scheduler, job dựng dữ liệu lần đầu.                                                   | FR-06          |
| C8       | IT Admin     | Bot quản lý nghỉ phép.                                                                          | FR-10.8–10.14  |

---

# 8. Luồng D — Xác thực, tài khoản và khôi phục mật khẩu

```
--- Nhánh D1: Đăng nhập & khóa tạm ---
[D1.1] POST /api/auth/login (tên tài khoản/email/SĐT + mật khẩu)
       |-- Đúng -> cấp JWT cookie `tks_auth` (mặc định 12 giờ), xóa bộ đếm sai
       |-- Tài khoản bị khóa -> 403 ACCOUNT_LOCKED
       `-- Sai -> tăng bộ đếm; sai 5 lần liên tiếp -> khóa đăng nhập 5 phút (trả thời gian đếm ngược)
[D1.2] Đăng nhập Google (POST /api/auth/google, Google Identity ID token): chỉ vào được tài khoản ĐÃ CÓ (liên kết theo email/nhân sự);
       email lạ -> 403 REGISTRATION_DISABLED khi tự đăng ký đang khóa; admin cứng luôn vào được

--- Nhánh D2: Tự đăng ký (đang KHÓA từ 03/10/2026) ---
[D2.1] POST /api/auth/register -> 403 REGISTRATION_DISABLED
       (GET /api/auth/google-config trả registrationOpen=false: trang login ẩn link, trang register khóa form)
[D2.2] ALLOW_SELF_REGISTRATION=true mở lại: Khách đăng ký bằng email+mật khẩu
       (luồng nhân sự đăng ký bằng OTP /register/channels, /send-otp, /verify đã gỡ 05/10/2026)

--- Nhánh D3: Quên mật khẩu bằng OTP 6 số ---
[D3.1] Nhập tên tài khoản/email/SĐT -> POST /api/auth/forgot-password/channels (trả danh sách kênh đã che mờ; định danh lạ trả kênh giả, không lộ tồn tại)
[D3.2] Chọn kênh -> POST /api/auth/forgot-password/send-otp (OTP hiệu lực 5 phút, gửi lại cách nhau >= 60 giây)
[D3.3] Nhập OTP + mật khẩu mới (8–128 ký tự) -> POST /api/auth/forgot-password/verify (tối đa 5 lần nhập OTP) -> đổi mật khẩu, xóa khóa đăng nhập
       Giới hạn tần suất cả 3 bước: 8 yêu cầu/10 phút theo định danh, 20/10 phút theo IP

--- Nhánh D4: Hồ sơ cá nhân ---
[D4.1] Trang /account/#profile và hộp hồ sơ ở mọi trang (shared-nav.js): đổi họ tên (POST /api/auth/profile — không đổi email;
       gửi email khác -> 403 EMAIL_CHANGE_LOCKED với TK nhân sự, 409 EMAIL_CHANGE_REQUIRES_OTP với TK thường); ô email chỉ đọc;
       đổi email khôi phục (POST /api/auth/recovery, xác nhận mật khẩu; body có soDienThoai -> 400 PHONE_CHANGE_NOT_ALLOWED);
       đổi mật khẩu (POST /api/auth/change-password)
[D4.1a] [Decision] Đổi email đăng nhập:
       |-- TK nhân sự (hrManaged) -> giao diện gợi ý "liên hệ Quản lý"; Quản lý đổi ở /account/#users (PUT /api/admin/users/:id, đồng bộ hr_employees)
       `-- TK thường (Khách, nội bộ không gắn nhân sự) -> "Đổi email" mở hộp OTP 2 bước:
           POST /api/auth/profile/contact-change { field:'email', value } -> OTP gửi tới email MỚI -> nhập OTP
           -> POST /api/auth/profile/contact-change/verify { challengeId, otp } -> ghi app_users.email, verifiedEmail=true
           (email trùng TK khác bị từ chối; có giới hạn số lần gửi và nhập sai, vượt -> 429)
[D4.1b] SĐT đăng nhập: chỉ Quản lý đổi ở trang quản trị. TK đã gắn một dòng nhân sự (hr_employee_id) không tự gắn sang dòng khác khi
       email/SĐT đổi -> giữ ràng buộc cũ, ghi log cảnh báo
[D4.2] ID Telegram: chỉ Quản lý (hoặc admin cứng) sửa được ID của chính mình; vai trò khác thấy chỉ đọc, ghi bị 403 TELEGRAM_ID_LOCKED

--- Nhánh D5: Quản lý người dùng & phân quyền (/account/#users, quyền account.users*) ---
[D5.1] Quản lý xem danh sách, tạo tài khoản (POST /api/admin/users), sửa thông tin/vai trò/cơ sở mặc định/ID Telegram (PUT), đặt lại mật khẩu, xóa
[D5.2] Quản lý (thường) không đặt lại mật khẩu, đổi email/SĐT/ID Telegram, hạ vai trò, rút quyền, khóa hay xóa Quản lý khác -> 403 ACCOUNT_POLICY_DENIED;
       chỉ Quản lý cấp cao (admin cứng) giữ đủ quyền
[D5.3] Phân quyền chi tiết (account.permissions): xem catalog + quyền hiệu lực, ghi đè từng quyền cho từng tài khoản (chỉ lưu phần lệch so với mặc định vai trò);
       quyền phụ thuộc (requires) tự bị loại khi thiếu quyền gốc; Khách chỉ được các khóa trong GUEST_ALLOWED_KEYS (gồm stockLocationsV2.view / .export), mọi khóa khác bị cấm
[D5.4] Yêu cầu đổi vai trò tự thân: người dùng gửi (POST /api/role-requests), Quản lý duyệt/từ chối (PATCH .../:id/status)

--- Nhánh D6: Bảo vệ trang ---
[D6.1] pageGuard.js chặn truy cập trang theo quyền (reports / shipment/lifecycle / humanresources / vt-positions / account; /stock-locations* chuyển 302 sang /vt-positions/); chưa đăng nhập -> /login/
[D6.2] Sau đăng nhập tới trang đầu tiên tài khoản có quyền (landingPathFor)
```

---

# 9. Luồng E — Nghỉ phép nhân sự và Telegram

```
--- Nhánh E1: Nhân viên xin nghỉ (bot xin nghỉ CHẠY NGOÀI repo) ---
[E1.1] Nhân viên nhắn bot xin nghỉ (chọn ngày/buổi Sáng-Chiều, lý do, người bàn giao)
[E1.2] Bot INSERT thẳng vào hr_leave_requests (DB tự sinh request_id `NP-YYYYMMDD-NNNN`); trigger DB ghi sự kiện vào hr_leave_change_events
       Đơn gửi sau mốc giờ của CSNS-NP-01 (07:45 ca sáng / 12:30 ca chiều của ngày bắt đầu nghỉ) được gắn trạng thái `Vi phạm`

--- Nhánh E2: Web nhận tin ---
[E2.1] hrLeaveDbRealtime.js phát hiện đơn mới/đổi (kể cả do bot ngoài ghi) -> SSE /api/hr/leave-requests/stream + thông báo chuông cho mọi tài khoản
[E2.2] Người có quyền hr.leave mở /humanresources/#leave: bảng nghỉ phép có lọc cơ sở/phòng ban/ngày, phân trang, huy hiệu cảnh báo nghỉ gấp; lịch nghỉ phép ở header (chọn ngày -> ai nghỉ sáng/chiều/cả ngày, ẩn đơn Từ chối)

--- Nhánh E3: Quản lý ghi nhận & duyệt trên web (hr.leave.manage) ---
[E3.1] POST /api/hr/leave-requests: nhập tay "Tự ý nghỉ (HR ghi nhận)" (mặc định Đã duyệt, không gửi bot quản lý); ở "Cả hai" cơ sở suy từ hồ sơ nhân sự, không suy được -> 400 LEAVE_BRANCH_UNRESOLVED
[E3.2] PATCH /api/hr/leave-requests/:id/status: Chưa duyệt / Đã duyệt / Từ chối / Vi phạm (kèm lý do khi Từ chối); đổi trạng thái -> tăng decision_version, xóa decision_notified_at -> bot xin nghỉ báo lại nhân viên
[E3.3] Duyệt/Từ chối ngay trên thông báo chuông (API vẫn kiểm tra quyền); xuất Excel báo cáo nghỉ phép; xuất Danh sách nhân sự (hr.employees)

--- Nhánh E4: Bot Telegram quản lý (HR_MANAGER_TELEGRAM_ENABLED=true) ---
[E4.1] Runtime quét Postgres mỗi 5 giây (mặc định) + nhận webhook (header X-Telegram-Bot-Api-Secret-Token); lưu update vào hr_manager_telegram_updates trước khi xử lý
[E4.2] Gửi mọi đơn "Xin nghỉ phép" mới (kể cả Vi phạm) và bù đơn Chưa duyệt chưa gửi cho quản lý phù hợp: vai trò Quản lý, hoạt động, có Telegram ID, quyền hr.leave.manage,
       cơ sở tài khoản khớp cơ sở đơn ("Cả hai" nhận cả hai; trống không nhận); quản lý phải bấm Start với bot mới
[E4.3] Quản lý bấm Phê duyệt (lưu Đã duyệt) hoặc Từ chối
       |-- Từ chối -> mở phiên 15 phút: reply đúng tin nhắc để nhập lý do (<= 500 ký tự) / Bỏ qua (lý do rỗng) / Hủy (không quyết định)
[E4.4] Quyết định đi qua hrLeaveDecisionService (cùng transaction, kiểm tra decision_version + quyền + cơ sở): nút/phiên cũ bị từ chối
[E4.5] Đã duyệt/Từ chối khóa thao tác Telegram cho mọi quản lý; web vẫn sửa/mở lại; mọi tin đã gửi được cập nhật theo kết quả mới
[E4.6] Tin lỗi được giữ trong hàng đợi (lease/retry); server tắt thì dừng, bật lại thì xử lý tiếp
```

| **Bước** | **Vai trò**       | **Mô tả**                                                                 | **Tham chiếu** |
|----------|-------------------|---------------------------------------------------------------------------|----------------|
| E1       | Bot xin nghỉ      | Ghi đơn trực tiếp vào Postgres (ngoài repo).                              | SCHEMA.md `0016` |
| E2       | Backend/Web       | SSE + chuông + bảng/lịch nghỉ phép.                                        | FR-10.5–10.7, 10.14 |
| E3       | Quản lý           | Nhập tay "Tự ý nghỉ", duyệt/từ chối, xuất báo cáo.                         | FR-10.1–10.4, 10.6 |
| E4       | Bot quản lý       | Giao tin theo cơ sở, Phê duyệt/Từ chối, phiên lý do, đồng bộ tin nhắn.     | FR-10.8–10.14, NFR-16 |

---

# 10. Luồng F — Vòng đời đơn hàng (quyền `shipment.lifecycle`)

```
[F0] [Start] Người dùng có quyền mở /shipment/lifecycle/ (sidebar "Vòng đời đơn hàng"; Nhân viên kho/marketing/mua hàng và Khách không có)
[F1] [Task] GET /api/shipment/lifecycle?branch&status&kiotStatus&dateField&from&to&mode&q&sort&dir&page&pageSize
[F2] [Task] Backend dựng danh sách = MỌI đơn đặt hàng KiotViet của HN + SG (cache 2 phút kiểu stale-while-revalidate, ~60 nghìn đơn)
            ghép với Google Sheet theo (cơ sở, mã đơn): có trên sheet -> lấy trạng thái vòng đời của sheet;
            chỉ có ở Kiot -> "Đơn chưa gửi kế toán" (thấp nhất); dòng sheet không khớp đơn Kiot nào -> bỏ
[F3] [Task] Lọc, sắp xếp, cắt trang ở máy chủ (orderLifecycleQuery.js) -> trả 1 trang (mặc định 100 dòng) + tổng + danh sách trạng thái Kiot + tình trạng nguồn Kiot
[F4] [Decision] Postgres lỗi? -> kiot.ok=false, vẫn trả đơn sheet kèm cảnh báo
[F5] [Task] Bấm 1 dòng: GET /api/shipment/lifecycle/order-detail?code&branch -> dòng hàng, tồn kho, "Điều chuyển SG" (hàng đang vận chuyển, tham khảo), số có bán (đơn Phiếu tạm: min(SL đặt, tồn))
[F6] [Task] Tra cứu theo mã: GET /:orderCode (shipment.lookup; POST /lookup tra nhiều mã đã gỡ 05/10/2026); Lịch sử cập nhật: GET /history (shipment.history)
[F7] [Task] Ghi đè trạng thái (shipment.override, mặc định chỉ Quản lý): POST /:orderCode/override -> ghi 1 dòng vào tab `Lịch sử cập nhật`; 8 trạng thái: 6 tính được
            (Đơn chưa gửi kế toán -> Đã gửi kế toán -> Đang được giao -> Đã giao thành công -> Đã nhận (Tại kho) -> Đã nhận (Đi giao xong)) + Sự cố + Đã hủy (chỉ qua ghi đè);
            bộ lọc trạng thái của bảng "Toàn bộ đơn hàng" có đủ 8 trạng thái (thêm Sự cố, Đã hủy từ 05/10/2026)
[F8] [Task] Xuất Excel (shipment.export, mặc định chỉ Quản lý): POST /export nhận chính bộ lọc, tối đa 20.000 dòng (vượt -> 400 TOO_MANY_ROWS)
[F9] [End]
```

---

# 11. Luồng G — Vị trí hàng (quyền `stockLocationsV2.view`, từ 30/10/2026)

```
[G0] [Start] Người dùng (mọi vai trò kể cả Khách; mở xem mặc định, Quản lý tắt được từng tài khoản) mở /vt-positions/#hn hoặc #sg (nhóm sidebar "Vị trí hàng": mục VT Hà Nội / VT Sài Gòn theo cơ sở người dùng, "Cả hai" hiện cả hai, mặc định HN). Link cũ /stock-locations* -> 302 /vt-positions/
[G1] [Task] GET /api/stock-positions?branch=HN|SG -> kiểm tra đăng nhập + stockLocationsV2.view + cơ sở thuộc phạm vi chọn (400 branch lạ; 403 ngoài phạm vi/thiếu quyền); trả canEdit / canExport / canDeleteHistory theo quyền
[G2] [Task] Đọc stock_positions của cơ sở; SL kho/cảnh báo tính từ ghi chú bằng carton.js, tên + SL Kiot tra theo mã từ products; có thể bốc = SL kho − giữ chỗ của đơn Đang bốc; SSE /api/stock-positions/events báo bảng vừa đổi để trang tự vá số liệu
[G3] [Decision] Có quyền sửa (stockLocationsV2.edit, Quản lý)? Có -> sửa/thêm/xóa/import/Đã sửa/trừ thùng (khóa lạc quan version, lịch sử bất biến); Không -> chỉ xem + xuất Excel (nếu còn stockLocationsV2.export), ẩn nút Lưu/Xóa/Import
[G4] [Task] Frontend: bảng 10 cột, tìm không dấu, lọc Cảnh báo / Hợp lệ / Tất cả, 50/100/200 dòng/trang, bấm dòng mở hộp chi tiết + lịch sử; xuất Excel bảng và lịch sử (stockLocationsV2.export)
[G5] [End]
```

---

# 12. Truy vết yêu cầu

| **Luồng** | **Yêu cầu SRS bao phủ**                                             |
|-----------|---------------------------------------------------------------------|
| Luồng A   | FR-06.x, NFR-09                                                     |
| Luồng B   | FR-01.x, FR-02.x, FR-03.x, FR-04.x, FR-05.x, FR-07.x, FR-11.x, FR-12.x, FR-16.x, NFR-01, NFR-03, NFR-10, NFR-11, NFR-13–15 |
| Luồng C   | FR-06.x, NFR-02, NFR-03, NFR-12                                     |
| Luồng D   | FR-08.x, NFR-03, NFR-12                                             |
| Luồng E   | FR-10.x, NFR-16, CSNS-NP-01                                         |
| Luồng F   | FR-14.x, FR-08.10                                                   |
| Luồng G   | FR-13.x                                                             |

---

# 13. Ghi chú & khuyến nghị

- **Điểm mấu chốt:** polling của Sync Engine là nguồn dữ liệu thật; webhook KiotViet hiện chỉ lưu thô. Báo cáo tổng hợp tải từng tab, cache hai tầng và cập nhật gần thời gian thực bằng SSE sau mỗi lượt sync + rollup.
- **Google Sheets còn dùng:** Vòng đời đơn hàng (đọc + ghi tab Lịch sử), sheet CÂN ĐO (đọc, job `sheetSnapshots`), Báo cáo Marketing (đọc); Vị trí hàng không còn đọc Sheets (30/10/2026). Workbook HR và tab `Trả NCC` **không còn được đọc** (Trả NCC → upload Excel vào Postgres; nhân sự → `hr_employees`).
- **Khả năng suy giảm có kiểm soát:** nguồn Kiot lỗi thì Vòng đời đơn hàng vẫn hiện đơn sheet kèm cảnh báo; workbook công nợ lỗi chỉ làm tab Công nợ báo `available=false`; bảng chưa migrate (vd `inventory_value_snapshots`) trả rỗng thay vì lỗi.
- **Nhất quán thời gian:** ngày "hôm nay", bucket ngày và `updatedAt` tính theo Asia/Ho_Chi_Minh; cột TIMESTAMPTZ của KiotViet lưu "giờ treo tường VN mang nhãn UTC" (xem `dashboardPgReader.js`).
- **Kiểm thử liên tục:** chạy `npm test` trong `server/` trước khi commit/deploy (số lượng test xem SRS mục 2.2).

---

*Hết tài liệu BPMN v3.0*

Cập nhật gần nhất: 30/10/2026 (Luồng G Vị trí hàng: gỡ module cũ đọc Google Sheets, chuyển sang VT Hà Nội/Sài Gòn trên Postgres).
