# TOKOSI Dashboard

Dashboard nội bộ cho hai cơ sở Hà Nội và Sài Gòn.

23/10/2026 — Bảng Khách hàng bổ sung bộ lọc hình thức bán hàng/quy mô, xuất thông tin Chi tiết (trừ Note) và dropdown level nội bộ dùng chung HN/SG theo tên khách. Mã cục bộ; migration `0087` và bước khởi tạo nguồn **chưa áp DB thật**. Xem [thiết kế](docs/superpowers/specs/2026-10-23-customer-filters-local-price-level-design.md), [kế hoạch](docs/superpowers/plans/2026-10-23-customer-filters-local-price-level.md). Sau migration, chạy `node scripts/initialize-customer-price-levels.js` trong `server` để xem trước; `--apply` sao lưu nguồn và bật level nội bộ. Hóa đơn đã chụp giữ nguyên.

Tiến độ, kiến trúc chi tiết và checklist vận hành: [CURRENT.md](CURRENT.md).

## Kiến trúc hiện tại

Ứng dụng Node.js/Express dùng Supabase PostgreSQL làm nguồn dữ liệu chính; KiotViet và một số Google Sheets cung cấp dữ liệu đồng bộ. Các module chính gồm báo cáo, công nợ, nhân sự, quản lý tài khoản, vòng đời đơn hàng và các công cụ kế toán. Chi tiết kiến trúc và tiến độ theo tính năng nằm trong [CURRENT.md](CURRENT.md).

Các bảng web và file HTML hỗ trợ chọn cột và kéo chỉnh độ rộng; Excel/PDF giữ định dạng xuất hiện có.

## Chạy local

```bash
cd server
npm install
copy .env.example .env
npm run db:migrate
npm test
npm run dev
```

Mở `http://localhost:3000`.

## Biến môi trường chính

| Biến | Mục đích |
|---|---|
| `SUPABASE_DB_URL` | PostgreSQL dùng cho dữ liệu KiotViet, tài khoản, nhân sự, nghỉ phép và workflow |
| `KIOTVIET_CLIENT_ID`, `KIOTVIET_CLIENT_SECRET`, `KIOTVIET_RETAILER` | KiotViet Hà Nội |
| `KIOTVIET_CLIENT_ID_SG`, `KIOTVIET_CLIENT_SECRET_SG`, `KIOTVIET_RETAILER_SG` | KiotViet Sài Gòn |
| `KIOTVIET_SYNC_ENABLED` | Công tắc chính của engine đồng bộ KiotViet → Supabase (mặc định tắt); kèm `KIOTVIET_SYNC_FAST_INTERVAL_MS` (7 phút), `KIOTVIET_SYNC_SLOW_INTERVAL_MS` (20 phút), `KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS` (10 phút) |
| `KIOTVIET_CASHBOOK_SYNC_ENABLED` | Bật riêng đồng bộ Sổ quỹ khi engine tổng tắt. Khi engine tổng bật, Sổ quỹ cũng chạy. `KIOTVIET_CASHBOOK_SYNC_INTERVAL_MS` mặc định/tối thiểu 60 giây; giao diện kiểm tra mốc đồng bộ mỗi 15 giây khi đang hiển thị |
| `KIOTVIET_WEBHOOK_SECRET` | Bí mật gắn vào đường dẫn webhook `/api/kiotviet/webhook/<secret>`; đường dẫn cũ không secret tắt bằng `KIOTVIET_WEBHOOK_LEGACY_PATH_ENABLED=false` |
| `SPREADSHEET_ID`, `SPREADSHEET_ID_SG` | Di sản — không còn module nào đọc (Trả NCC đã chuyển sang upload Excel vào Postgres `supplier_return_imports`); bỏ trống vẫn chạy được |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Service account Google (bắt buộc khi khởi động). Quyền Viewer cho Công nợ và Vị trí hàng; **Editor** cho workbook Vòng đời đơn hàng (ghi tab `Lịch sử cập nhật`) |
| `DEBT_MANAGEMENT_SPREADSHEET_ID` | (Không còn dùng từ 13/10/2026 — tab Công nợ tính từ KiotViet + lịch TT trong Postgres) |
| `STOCK_LOCATIONS_SPREADSHEET_ID` | Workbook vị trí hàng HN/SG dùng chung, chỉ đọc |
| `PRODUCT_CONTAINER_SPREADSHEET_ID` | Workbook TKS2 ĐẶT CONT; chỉ đọc 7 sheet CONT mỗi 600.000 ms; service account cần Viewer |
| `SHIPPING_MEASURE_SPREADSHEET_ID` | Workbook có sheet `CÂN ĐO` (thể tích/cước đơn), chỉ đọc (job `sheetSnapshots` đồng bộ vào `shipping_measures` mỗi 5 phút); để trống = dùng `STOCK_LOCATIONS_SPREADSHEET_ID` |
| `MARKETING_REPORT_SPREADSHEET_ID`, `MARKETING_PHONES_SPREADSHEET_ID`, `MARKETING_ADS_SPREADSHEET_ID` | Ba workbook Báo cáo Marketing, chỉ đọc; service account cần Viewer trên cả ba |
| `MARKETING_ADS_SYNC_INTERVAL_MS`, `MARKETING_ADS_READ_MAX_AGE_MS` | Chi phí ADS được job `marketingAdsSync.js` đồng bộ từ Sheets vào `marketing_ads_costs` (migration `0069`) — chu kỳ mặc định 30 phút (tối thiểu 5 phút); job chạy cùng vòng đời job Pancake nên chỉ hoạt động khi `PANCAKE_MARKETING_SYNC_ENABLED=true`. Bảng cũ hơn `MARKETING_ADS_READ_MAX_AGE_MS` (mặc định 3 giờ) thì báo cáo lùi về đọc Sheets |
| `BUSINESS_CURRENT_MONTH_ENABLED`, `BUSINESS_CURRENT_MONTH_MIN_INTERVAL_MS` | Tính sẵn doanh số **tháng hiện tại** của Báo cáo kinh doanh vào `business_current_month_*` (migration `0068`). Mặc định bật (thiếu migration thì tự bỏ qua), `false` để tắt (báo cáo lại tính live); sàn giữa hai lượt tính nhanh mặc định 600000 ms (10 phút) |
| `ORDER_LIFECYCLE_SPREADSHEET_ID` | Workbook vòng đời đơn hàng (`DonHang_HN`, `DonHang_SG`, `DonHang_MienNam` = đơn Bắc-Nam tính như đơn Hà Nội, `Khách_HN`/`Khách_SG` = khách/ship lấy tại kho, `KeToan_ChungTu` = đơn kế toán/chứng từ dùng chung HN+SG, `Lịch sử cập nhật`) |
| `HR_SPREADSHEET_ID`, `HR_SPREADSHEET_ID_SG` | **Đã gỡ khỏi `config.js` và `.env.example` (2026-10-05)** — danh sách nhân sự nay ở Postgres `hr_employees`; biến còn trong môi trường cũ thì bỏ qua được |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Ký phiên đăng nhập (bắt buộc / mặc định `12h`) |
| `GOOGLE_CLIENT_ID` | Đăng nhập Google (tùy chọn; thiếu thì ẩn nút) |
| `ALLOW_SELF_REGISTRATION` | `true` để mở lại tự đăng ký tài khoản; mặc định khóa từ 2026-10-03 |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_APP_PASSWORD`, `SMTP_FROM_NAME` | Gửi email OTP (thiếu thì OTP ghi ra console) |
| `HR_MANAGER_TELEGRAM_ENABLED` | Bật bot riêng cho quản lý; mặc định `false` |
| `HR_MANAGER_TELEGRAM_BOT_TOKEN`, `HR_MANAGER_TELEGRAM_WEBHOOK_SECRET` | Token bot mới và secret xác thực webhook Telegram; giữ trong môi trường máy chủ |
| `HR_MANAGER_TELEGRAM_WEB_URL` | HTTPS origin công khai của dashboard, dùng cho webhook và nút mở web |
| `HR_MANAGER_TELEGRAM_SCAN_INTERVAL_MS` | Chu kỳ quét đơn/sự kiện trong Postgres; mặc định `5000` ms (giới hạn 1.000–60.000) |
| `HR_LEAVE_DB_REALTIME_ENABLED` | Cầu thay đổi Postgres → SSE của HR, mặc định `true`, độc lập với công tắc bot |
| `SPECIAL_DAYS_NOTIFY_ENABLED` | Báo ngày lễ/sinh nhật lên chuông thông báo; mặc định `true`, `false` để tắt |
| `VAT_REQUEST_NOTIFY_ENABLED` | Báo chuông cho sale ~10 phút sau khi kế toán ngừng sửa yêu cầu ORDER VAT của họ; mặc định `true`, `false` để tắt (cần migration `0080`) |
| `BACKGROUND_JOBS` | `inline` (mặc định): job nền chạy chung web; `worker`: web chỉ nghe sự kiện, job chạy ở `npm run worker` (`worker.js`) |
| `INVOICE_PRICE_AUDIT_ENABLED` | Bật job 23:00 (giờ Việt Nam) của **Kiểm tra giá bán**: chụp hóa đơn chưa quét trong cửa sổ 7 ngày và đối chiếu giá min; mặc định `false`. Rollout: áp migration `0077` → deploy khi còn `false` → chạy tay lần đầu `npm run invoices:price-audit -- --date <hôm nay> --apply` → mới bật `true` |
| `DASHBOARD_PREWARM` | Nạp sẵn cache nguồn lúc khởi động; mặc định bật, `false` để tắt |
| `MEMORY_MONITOR` / `MEMORY_LOG_INTERVAL_MS` / `MEMORY_LIMIT_MB` | Log bộ nhớ định kỳ; mặc định bật, 60000 ms, trần cảnh báo 2048 MB (`MEMORY_MONITOR=false` để tắt) |
| `XKIRO_API_KEY`, `XKIRO_BASE_URL`, `INVOICE_VISION_MODEL`, `INVOICE_VISION_FALLBACK_MODEL` | AI đọc ảnh hóa đơn ở tab Tạo QR (xKiro, chuẩn OpenAI). Thiếu key = tắt, trang báo nhập tay; mặc định model `qwen/qwen3.8-max:free`, dự phòng `qwen/qwen3-vl-plus:free` |
| `VAT_REQUEST_STOCK_SHEET_ID`, `VAT_REQUEST_STOCK_GID`, `VAT_REQUEST_STOCK_COLUMN`, `VAT_REQUEST_MAPPING_SHEET_ID`, `VAT_REQUEST_MAPPING_GID` | Nguồn cột **Tồn VAT** của ORDER VAT: tab GỘP MỚI (cột I `TỒN ĐẦU NGÀY`) + Khớp mã, sheet phải chia sẻ công khai. Bỏ trống = tab GỘP MỚI (`gid=39032`) + Khớp mã của sheet Nháp VAT; nếu Render đã đặt GID cũ thì đổi thành `39032` |
| `PG_POOL_MAX` | Trần kết nối pool `pg` mỗi instance (mặc định 7; 2 × giá trị ≤ 15 của Supabase session pooler) |

Xem [server/.env.example](server/.env.example) để biết đầy đủ cấu hình.

## Cấu trúc chính

```text
server/
├── auth/                 # Tài khoản, phân quyền, OTP, Google OAuth
├── branch/               # Phân tách Hà Nội / Sài Gòn
├── businessReport/       # Báo cáo kinh doanh: SQL doanh số tháng, repository (tháng đã chốt + tháng hiện tại tính sẵn business_current_month_*, lùi về live), service, API, xuất Excel/HTML
│   ├── customerProfileRepository.js  # Ghi chú / thông tin theo khách của bảng Doanh số theo khách (22/10/2026, migration 0080): Thông tin chung, ảnh kho (BYTEA), note kiểu tin nhắn, ngày đã đi tiếp khách, người được gán sửa; fail-soft khi chưa có bảng
│   └── customerProfileRules.js       # Luật thuần (không DB) kiểm tra đầu vào: quy mô kho, hình thức bán hàng, note ≤ 2000 ký tự, ngày đã đi, người sửa
├── cashbook/             # Sổ quỹ toàn công ty: số dư, sổ chi tiết, lịch sử chốt và xuất Excel/HTML; repository đọc qua view v_cash_book_transactions (0070, lùi về subquery nếu thiếu view)
├── dashboard/            # Tổng hợp dashboard (dashboardData + dashboardViews: API theo tab), xuất Excel/HTML, kiểm tra đứt hàng
│   ├── documentDetailRepository.js  # Chi tiết hóa đơn (popup bảng Chi tiết giao dịch) và chi tiết đơn đặt hàng (trang Vòng đời đơn hàng)
│   └── stockoutCheck/    # Engine kiểm tra đứt hàng + upload Trả NCC Excel; stockoutDaysStore.js lưu số ngày đứt 30 ngày theo cơ sở vào product_stockout_days (cột Đứt HN/SG của Báo cáo hàng hóa)
├── data/                 # Dữ liệu lưu trữ local (users.json, notifications.json, ...)
├── db/                   # Migration Supabase và SCHEMA.md (trạng thái áp dụng xem CURRENT.md)
├── hr/                   # Nhân sự, nghỉ phép tự gửi, phạm vi duyệt chung, tài liệu quy định, nhập Excel và cầu Postgres → SSE
├── invoicePriceAudit/    # Kiểm tra giá bán (20/10/2026): priceNoteParser.js + priceAuditRules.js (đọc mô tả giá, VAT, cấp khách), priceAuditSql.js (tính NUMERIC), priceAuditRepository.js (chụp hóa đơn, đọc bảng, sửa giải thích / Chốt có version), priceAuditRefresh.js + priceAuditScheduler.js (job 23:00 và cửa sổ 7 ngày), priceAuditService.js / priceAuditRoutes.js / priceAuditAccess.js (API `/api/invoice-price-audit`, quyền) và kiểm thử PGlite; sale có quyền sửa giải thích mọi hóa đơn, hiện tên người lưu gần nhất, giữ lâu dài qua các phiên chạy; bảng dùng nhãn cột rút gọn
├── kiotviet/             # KiotViet API client và webhook receiver
├── kiotvietSync/         # Webhook, polling, backfill và rollup; businessCurrentMonthRefresh.js tính sẵn doanh số tháng hiện tại cho Báo cáo kinh doanh (0068)
├── lib/                  # Thư viện tiện ích nội bộ (TTL cache, ...)
├── marketingReport/      # Báo cáo Marketing: đọc 3 workbook Google Sheets, đối chiếu doanh số KiotViet theo tên khách, cập nhật ngược Sheets, xuất Excel/HTML; tính sẵn trong DB (0069): marketingAdsSync.js (chi phí ADS), marketingSummaryRefresh.js (gộp SĐT Pancake), view v_marketing_customer_revenue (doanh số theo tên)
├── notifications/        # Chuông thông báo, gửi email OTP và job báo ngày lễ/sinh nhật (specialDayNotifier.js)
├── productContainers/    # Parser CONT, snapshot repository, đồng bộ Sheets chỉ đọc mỗi 10 phút (ghi khác biệt) và kiểm thử; bảng Dự kiến hàng về (20/10/2026): expectedRefresh.js (job dựng bảng tính sẵn), expectedRepository.js (đọc + cache theo version), expectedRoutes.js (/api/expected-arrivals), expectedExport.js (xuất Excel/HTML); từ 21/10/2026 route trả `fullAccess` và bỏ trường giá khi thiếu quyền `reports.overview.containers.full`, xuất file thêm cột giá theo quyền
├── public/               # Frontend HTML/CSS/JS
│   ├── cashbook/         # Trang Sổ quỹ: bộ lọc/hash, số dư, chốt và xuất chọn cột
│   ├── vat-draft/        # Trang Kế toán – Nháp VAT: dán mã HD/DH → Xử lý luôn (danh sách đã dán + hộp chi tiết) hoặc dán dữ liệu, kết quả phân bổ + Ghi chú tổng, QR; Tạo QR từ PDF (2 cột, QR to bên phải; sale dùng được qua accounting.qr); cell-select.js chọn ô kiểu Google Sheet + Ctrl+C
│   ├── vat-lookup/       # Trang Kế toán – Tra cứu VAT: 2 tab Hàng VAT có sẵn / Hàng sắp về, dán nhiều mã; thanh tab Kế toán chung (TKSNav.renderAccountingTabs)
│   ├── vat-request/      # Trang Kế toán – ORDER VAT: sale tạo/sửa yêu cầu của mình, KT được cấp quyền riêng mới xử lý trạng thái/ghi chú/ngày về; vat-request-grid.js = chọn ô / copy / kéo nhân bản / dán kiểu Google Sheet
│   ├── vendor/pdfjs/     # pdf.js 4.10.38 (legacy build) đọc text hóa đơn PDF ngay trong trình duyệt
│   └── shared/
│       ├── fuzzy-search.js # Tìm gần đúng theo từ dùng chung (UMD, window.TKSFuzzySearch: fold/tokens/score/matches/filter)
│       ├── fuzzy-search.test.js # Kiểm thử luật tìm gần đúng
│       └── detail-panel.css # Khung xem chi tiết dùng chung (.dp-): chỉ số tổng quan, bảng 1 khung cuộn, tắt nút chọn cột
├── scripts/              # Script thủ công (migrate dữ liệu, cài đặt ban đầu)
├── shared/               # Tiện ích dùng chung phía máy chủ: fuzzySearch.js (CommonJS, createMatcher — tìm gần đúng theo từ, cùng luật với public/shared/fuzzy-search.js) và fuzzySql.js (cùng luật trong SQL)
├── sheets/               # Google Sheets client (Công nợ, Vòng đời, Vị trí hàng, lưu ý `hrSheetsClient.js` là mã chết chờ xóa tay)
├── sheetSnapshots/       # Job đọc Google Sheets (Vị trí HN/SG, CÂN ĐO) theo chu kỳ vào Postgres, ghi khác biệt; kiểm thử PGlite
├── stockLocations/       # Đọc vị trí hàng HN/SG từ DB (cache theo lần đồng bộ), ánh xạ cột và API chỉ đọc
├── shipment/             # Vòng đời đơn hàng: đơn KiotViet (Postgres) ghép Google Sheet, lọc/phân trang ở máy chủ
├── telegram/             # Bot quản lý nghỉ phép, webhook, giao tin bền vững + đăng ký webhook
├── vatDraft/             # Kế toán – Nháp VAT (port vat-draft-app): phân bổ nguồn nháp, VietQR, đọc ảnh hóa đơn bằng AI (invoiceVision.js, xKiro), đọc 2 Google Sheet công khai, chứng từ HD/DH từ Postgres
├── vatLookup/            # Kế toán – Tra cứu VAT (port app Apps Script logic v12): lookupModel.js (ghép Khớp mã + Gộp VAT + DK về 2, tìm kiếm), lookupSource.js (3 CSV công khai, cache 10 phút / stale 6 giờ), vatLookupRoutes.js (/api/vat-lookup)
├── vatRequests/          # ORDER VAT: quyền/khóa/version/lịch sử; xuất Excel (export.js); gợi ý khách và giá từ yêu cầu gần nhất; Tồn VAT/Dự kiến về tính live
├── index.js
├── jobs.js               # Danh sách job nền (sync KiotViet, sheet, container, Pancake)
├── worker.js             # Tiến trình job nền riêng khi BACKGROUND_JOBS=worker
└── routes.js
```

## Dữ liệu công nợ CN1/CN3/CN7

Migration `0014_customer_debt_activity_periods.sql` tạo bảng tổng hợp ba kỳ 1/3/7 ngày (CN1/CN3/CN7). Scheduler gọi `customerDebtReportRefresh.js`; dashboard đọc bảng này qua `customerDebtActivityRepository.js`, không đọc Google Sheets.

Migration `0015_app_users_telegram_id.sql` thêm `app_users.telegram_id` để bot có thể liên kết trực tiếp qua Supabase Postgres. Giao diện/API tạo mã liên kết cũ không còn đọc hoặc ghi tab `_HR_TELEGRAM_LINKS`.

## Tiến độ dự án

Trạng thái, lịch sử cập nhật và checklist vận hành: [CURRENT.md](CURRENT.md).
