// ==========================================
// CAU HINH — doc tu bien moi truong (khong commit secret)
// ==========================================
if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (e) { /* dotenv là tùy chọn trong môi trường production */ }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const CONFIG = {
  // Workbook "Bảng Công nợ" dùng chung cho hai cơ sở, server chỉ đọc hai
  // tab Công nợ HN/SG. Optional để thiếu cấu hình không làm sập dashboard.
  DEBT_MANAGEMENT_SPREADSHEET_ID: process.env.DEBT_MANAGEMENT_SPREADSHEET_ID || null,
  STOCK_LOCATIONS_SPREADSHEET_ID: process.env.STOCK_LOCATIONS_SPREADSHEET_ID || null,
  // Pancake daily sync is independent of KiotViet and the report source switch.
  PANCAKE_MARKETING_SYNC_ENABLED: process.env.PANCAKE_MARKETING_SYNC_ENABLED === 'true',
  // Job 23:00 VN "Kiểm tra giá bán" (tab Hóa đơn): tắt mặc định để rollout có kiểm soát, bật sau nghiệm thu.
  INVOICE_PRICE_AUDIT_ENABLED: process.env.INVOICE_PRICE_AUDIT_ENABLED === 'true',
  MARKETING_REPORT_SOURCE: ['postgres','pancake'].includes(process.env.MARKETING_REPORT_SOURCE) ? process.env.MARKETING_REPORT_SOURCE : 'sheets',
  MARKETING_REPORT_SPREADSHEET_ID: process.env.MARKETING_REPORT_SPREADSHEET_ID || null,
  MARKETING_PHONES_SPREADSHEET_ID: process.env.MARKETING_PHONES_SPREADSHEET_ID || null,
  MARKETING_ADS_SPREADSHEET_ID: process.env.MARKETING_ADS_SPREADSHEET_ID || null,
  // Sheet "CÂN ĐO" (kich thuoc/can nang thung) de tinh the tich + cuoc trong hop chi tiet Vong doi don.
  // De trong = dung chung STOCK_LOCATIONS_SPREADSHEET_ID. Ten bien do la DI SAN cua module Vi tri hang doc Google Sheets (da go
  // 2026-10-30): workbook do nay CHI con phuc vu sheet CAN DO; giu nguyen ten bien de khong lam hong cau hinh da deploy.
  SHIPPING_MEASURE_SPREADSHEET_ID: process.env.SHIPPING_MEASURE_SPREADSHEET_ID || process.env.STOCK_LOCATIONS_SPREADSHEET_ID || null,
  SHIPPING_MEASURE_SHEET: 'CÂN ĐO',
  GOOGLE_SERVICE_ACCOUNT_JSON: required('GOOGLE_SERVICE_ACCOUNT_JSON'),
  PORT: process.env.PORT || 3000,

  // Dang nhap/phan quyen — xem server/auth/. JWT_SECRET bat buoc de tranh
  // token gia mao; khong co gia tri mac dinh vi day la secret bao mat.
  JWT_SECRET: required('JWT_SECRET'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '12h',

  // Dang nhap bang Google (server/auth/googleAuthService.js). OAuth Client ID
  // loai "Web application" tren Google Cloud Console — KHONG phai secret (se
  // duoc tra ve qua GET /api/auth/google-config cho trang login doc), nen
  // khong dung required(): thieu bien nay chi tat tinh nang Google, khong
  // lam sap server. Khong can GOOGLE_CLIENT_SECRET vi dung ID token flow
  // (Google Identity Services), khong dung authorization-code flow.
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID || null,

  // Tu dang ky tai khoan moi (form /register, dang ky nhan su qua OTP, Google tao tai khoan
  // lan dau) BI KHOA tu 2026-10-03: tai khoan moi do Quan ly tao trong trang Quan ly nguoi dung.
  // Dat ALLOW_SELF_REGISTRATION=true de mo lai. Tai khoan da co van dang nhap binh thuong.
  ALLOW_SELF_REGISTRATION: process.env.ALLOW_SELF_REGISTRATION === 'true',

  // ==========================================
  // GUI OTP QUEN MAT KHAU — Email (Gmail SMTP)
  // OPTIONAL: thieu bien nao thi tu dong fallback ve console.log (che do dev),
  // KHONG lam sap server. Xem server/notifications/.
  // ==========================================
  // Gmail SMTP: bat 2FA cho tai khoan Gmail dung de gui, roi tao "App
  // Password" 16 ky tu tai https://myaccount.google.com/apppasswords —
  // KHONG dung mat khau Gmail that.
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: Number(process.env.SMTP_PORT) || 465,
  SMTP_USER: process.env.SMTP_USER || null,
  SMTP_APP_PASSWORD: process.env.SMTP_APP_PASSWORD || null,
  SMTP_FROM_NAME: process.env.SMTP_FROM_NAME || 'TOKOSI Dashboard',

  // ==========================================
  SHEET_CATEGORIES: 'Nhóm hàng',
  SHEET_PRODUCTS: 'Hàng hóa',
  SHEET_INVOICES: 'Hóa đơn',
  SHEET_INVOICE_DETAILS: 'Chi tiết hóa đơn',
  SHEET_ORDERS: 'Đặt hàng',
  SHEET_RETURNS: 'Trả hàng',
  SHEET_CUSTOMERS: 'Khách hàng',
  SHEET_CUSTOMER_REPORT: 'Báo cáo bán hàng',
  SHEET_CUSTOMER_BY_PRODUCT_REPORT: 'Khách theo hàng hóa',

  DEBT_MANAGEMENT_SHEET_HN: 'Công nợ HN',
  DEBT_MANAGEMENT_SHEET_SG: 'Công nợ SG',

  // ==========================================
  // VONG DOI DON HANG — spreadsheet RIENG (5 tab DonHang_HN/DonHang_SG/
  // DonHang_MienNam/Khách_HN/Khách_SG trong CUNG 1 spreadsheet). Server CHI DOC 5 tab do.
  // DonHang_MienNam = don Bac-Nam (don cua Kiot Ha Noi, tinh nhu don HN).
  // Tab "Lich su cap nhat" (ORDER_LIFECYCLE_SHEET_HISTORY) la NGOAI LE: do
  // server tu tao/ghi (ghi de trang thai thu cong cua Quan ly/Ke toan).
  // ==========================================
  ORDER_LIFECYCLE_SPREADSHEET_ID: process.env.ORDER_LIFECYCLE_SPREADSHEET_ID || null,
  // Token rieng cho bot lai xe goi API doi chieu don. Khong dung JWT nguoi dung
  // va khong bao gio tra token qua endpoint nao.
  BOT_LIFECYCLE_API_TOKEN: process.env.BOT_LIFECYCLE_API_TOKEN || null,
  ORDER_LIFECYCLE_SHEET_HN: 'DonHang_HN',
  ORDER_LIFECYCLE_SHEET_SG: 'DonHang_SG',
  ORDER_LIFECYCLE_SHEET_NORTH_SOUTH: 'DonHang_MienNam',
  // Khach/Ship lay hang tai kho (2026-10-12): tach khoi DonHang_HN/SG.
  ORDER_LIFECYCLE_SHEET_PICKUP_HN: 'Khách_HN',
  ORDER_LIFECYCLE_SHEET_PICKUP_SG: 'Khách_SG',
  // Don ke toan/chung tu (2026-10-15): 1 tab DUNG CHUNG HN+SG (khong co cot co so) — xem orderLifecycleRepository.
  ORDER_LIFECYCLE_SHEET_ACCOUNTING: 'KeToan_ChungTu',
  ORDER_LIFECYCLE_SHEET_HISTORY: 'Lịch sử cập nhật',

  // ==========================================
  // QUAN LY NHAN SU — du lieu nhan su/nghi phep nam o Postgres (hr_employees,
  // hr_leave_requests); khong con doc spreadsheet nhan su.
  // ==========================================
  // Co "nghi gap": tin nhan gui tu gio nay tro di (gio Bangkok, 0-23) VA ca
  // nghi bat dau ngay hom sau lien ke thi tu dong gan co, chi de canh bao,
  // khong tu tu choi.
  HR_URGENT_LATE_NIGHT_HOUR: Number(process.env.HR_URGENT_LATE_NIGHT_HOUR) || 22,
  // So lan nghi gap/thang vuot nguong nay thi hien badge canh bao cho Quan ly.
  HR_URGENT_FLAG_MONTHLY_THRESHOLD: Number(process.env.HR_URGENT_FLAG_MONTHLY_THRESHOLD) || 2,

  // Bot rieng cho Quan ly; token KHAC bot nhan don xin nghi hien tai.
  HR_MANAGER_TELEGRAM_ENABLED: process.env.HR_MANAGER_TELEGRAM_ENABLED === 'true',
  HR_MANAGER_TELEGRAM_BOT_TOKEN: process.env.HR_MANAGER_TELEGRAM_BOT_TOKEN || null,
  HR_MANAGER_TELEGRAM_WEBHOOK_SECRET: process.env.HR_MANAGER_TELEGRAM_WEBHOOK_SECRET || null,
  HR_MANAGER_TELEGRAM_WEB_URL: process.env.HR_MANAGER_TELEGRAM_WEB_URL || null,
  HR_MANAGER_TELEGRAM_SCAN_INTERVAL_MS: Math.min(60000, Math.max(1000, Number(process.env.HR_MANAGER_TELEGRAM_SCAN_INTERVAL_MS) || 5000)),
  HR_LEAVE_DB_REALTIME_ENABLED: process.env.HR_LEAVE_DB_REALTIME_ENABLED !== 'false',
  // Bao ngay le / sinh nhat len chuong thong bao (notifications/specialDayNotifier.js).
  SPECIAL_DAYS_NOTIFY_ENABLED: process.env.SPECIAL_DAYS_NOTIFY_ENABLED !== 'false',
  // Bao chuong cho sale ~10 phut sau khi KT ngung sua yeu cau ORDER VAT (vatRequests/saleNotifier.js, migration 0080).
  VAT_REQUEST_NOTIFY_ENABLED: process.env.VAT_REQUEST_NOTIFY_ENABLED !== 'false',
  // Bao chuong nguoi duyet khi don nghi phep den tu Telegram (hr/hrLeaveBellNotifier.js).
  HR_LEAVE_BELL_NOTIFY_ENABLED: process.env.HR_LEAVE_BELL_NOTIFY_ENABLED !== 'false',
  // Trang thai boc hang tu dong theo Kiot: Dang boc + Kiot hoan thanh -> Da boc, + Kiot huy -> Chua boc
  // (pickAssignments/pickKiotReconcileJob.js; doc bang orders da dong bo, khong goi API Kiot). Mac dinh bat, chu ky 2 phut.
  PICK_KIOT_RECONCILE_ENABLED: process.env.PICK_KIOT_RECONCILE_ENABLED !== 'false',
  PICK_KIOT_RECONCILE_INTERVAL_MS: Math.min(30 * 60 * 1000, Math.max(30 * 1000, Number(process.env.PICK_KIOT_RECONCILE_INTERVAL_MS) || 2 * 60 * 1000)),

  // ==========================================
  // SUPABASE POSTGRES — dong bo KiotViet, xem
  // docs/04-planning/2026-09-14-roadmap-supabase-kiotviet-sync.md
  // ==========================================
  // Optional — fail-soft: engine dong bo mac dinh TAT
  // (KIOTVIET_SYNC_ENABLED=false), thieu bien nay khong duoc lam sap server.
  SUPABASE_DB_URL: process.env.SUPABASE_DB_URL || null,
  // Optional — mac dinh true khi production (Supabase Postgres can SSL), false
  // khi dev local (Postgres qua Docker thuong khong bat SSL).
  PGSSL: process.env.PGSSL ? process.env.PGSSL === 'true' : process.env.NODE_ENV === 'production',
  // Tran so ket noi cua pool pg TREN MOI INSTANCE. Supabase session pooler chi
  // co pool_size 15 dung chung; khi deploy, instance cu + moi chay chong nhau
  // (~30s) nen 2 x max phai <= 15 (7 x 2 = 14), neu khong se dinh
  // EMAXCONNSESSION. Chi tang khi da doi sang transaction pooler / them ket noi.
  PG_POOL_MAX: Number(process.env.PG_POOL_MAX) > 0 ? Number(process.env.PG_POOL_MAX) : 7,
  // Cong tac chinh cua toan bo engine dong bo KiotViet->Supabase (webhook +
  // polling). Mac dinh TAT tuong minh — khong co logic tu bat theo NODE_ENV.
  KIOTVIET_SYNC_ENABLED: process.env.KIOTVIET_SYNC_ENABLED === 'true',
  KIOTVIET_SYNC_FAST_INTERVAL_MS: Number(process.env.KIOTVIET_SYNC_FAST_INTERVAL_MS) > 0
    ? Number(process.env.KIOTVIET_SYNC_FAST_INTERVAL_MS) : 7 * 60 * 1000,
  KIOTVIET_SYNC_SLOW_INTERVAL_MS: Number(process.env.KIOTVIET_SYNC_SLOW_INTERVAL_MS) > 0
    ? Number(process.env.KIOTVIET_SYNC_SLOW_INTERVAL_MS) : 20 * 60 * 1000,
  // Sổ quỹ có thể đồng bộ riêng khi engine tổng đang tắt.
  KIOTVIET_CASHBOOK_SYNC_ENABLED: process.env.KIOTVIET_CASHBOOK_SYNC_ENABLED === 'true',
  KIOTVIET_CASHBOOK_SYNC_INTERVAL_MS: Number.isFinite(Number(process.env.KIOTVIET_CASHBOOK_SYNC_INTERVAL_MS))
    ? Math.max(60000, Number(process.env.KIOTVIET_CASHBOOK_SYNC_INTERVAL_MS) || 60000) : 60000,
  // Chu ky toi thieu giua 2 lan quet TOAN BO ton kho (/productOnHands, xem
  // kiotvietSync/entities/productOnHandsSnapshot.js). Mac dinh 10 phut.
  KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS: Number(process.env.KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS) > 0
    ? Number(process.env.KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS) : 10 * 60 * 1000,
  // Chu ky quet TOAN BO hang hoa (/products, xem kiotvietSync/entities/products.js):
  // poll tang dan theo lastModifiedFrom bo sot dong khi sua hang loat / khong bump
  // modifiedDate (vd chi sua Mo ta). Mac dinh 24 gio.
  KIOTVIET_SYNC_PRODUCT_RECONCILE_INTERVAL_MS: Number(process.env.KIOTVIET_SYNC_PRODUCT_RECONCILE_INTERVAL_MS) > 0
    ? Number(process.env.KIOTVIET_SYNC_PRODUCT_RECONCILE_INTERVAL_MS) : 24 * 60 * 60 * 1000,
  // Bi mat gan vao duong dan webhook KiotViet: cau hinh ben KiotViet tro toi
  // /api/kiotviet/webhook/<secret>. Bat buoc de nhan su kien — de trong thi
  // duong dan co secret bi tat hoan toan (404).
  KIOTVIET_WEBHOOK_SECRET: process.env.KIOTVIET_WEBHOOK_SECRET || '',
  // Duong dan cu KHONG co secret (/api/kiotviet/webhook) — giu bat trong giai
  // doan chuyen tiep de khong mat su kien truoc khi doi cau hinh ben KiotViet.
  // Doi URL ben KiotViet xong thi dat bien nay = 'false'.
  KIOTVIET_WEBHOOK_LEGACY_PATH_ENABLED: process.env.KIOTVIET_WEBHOOK_LEGACY_PATH_ENABLED !== 'false',

  // Nap san cache "nguon re" cho dashboard luc server khoi dong, tranh nguoi
  // dung dau tien sau restart/redeploy phai cho doc 7 tab (~13.5s). Mac dinh
  // BAT — tat bang DASHBOARD_PREWARM=false (vd moi truong dev khong can).
  DASHBOARD_PREWARM: process.env.DASHBOARD_PREWARM !== 'false',
  // Job nen (sync KiotViet, sheet snapshot, container, Pancake) chay o dau: 'inline' (mac dinh, chung
  // tien trinh web nhu cu) hoac 'worker' (web KHONG chay job, chi nghe su kien qua Postgres LISTEN;
  // job chay o tien trinh rieng `npm run worker` — Render Background Worker). Xem jobs.js.
  BACKGROUND_JOBS: process.env.BACKGROUND_JOBS === 'worker' ? 'worker' : 'inline',
  // Read-only incoming goods snapshot, independent from KiotViet sync.
  PRODUCT_CONTAINER_SPREADSHEET_ID: process.env.PRODUCT_CONTAINER_SPREADSHEET_ID || null,
  // Bao cao doanh thu theo khach / hang hoa lam moi TANG DAN sau moi luot sync (mac dinh TAT => chot dem).
  REPORTS_INCREMENTAL_ENABLED: String(process.env.REPORTS_INCREMENTAL_ENABLED || '').toLowerCase() === 'true',

  // Bao cao kinh doanh: tinh san doanh so THANG HIEN TAI vao business_current_month_* (migration 0068) sau moi luot
  // sync fast (kiotvietSync/businessCurrentMonthRefresh.js). Mac dinh BAT (thieu migration thi tu bo qua);
  // tat bang BUSINESS_CURRENT_MONTH_ENABLED=false => bao cao lai tinh live. San toi thieu giua 2 luot nhanh: 10 phut.
  BUSINESS_CURRENT_MONTH_ENABLED: String(process.env.BUSINESS_CURRENT_MONTH_ENABLED || '').toLowerCase() !== 'false',
  BUSINESS_CURRENT_MONTH_MIN_INTERVAL_MS: Number(process.env.BUSINESS_CURRENT_MONTH_MIN_INTERVAL_MS) || 10 * 60 * 1000,

  // Log bo nho (rss/heap/external/arrayBuffers) moi chu ky + canh bao khi RSS > 75% tran.
  // Mac dinh BAT — tat bang MEMORY_MONITOR=false.
  MEMORY_MONITOR: process.env.MEMORY_MONITOR !== 'false',
  MEMORY_LOG_INTERVAL_MS: Number(process.env.MEMORY_LOG_INTERVAL_MS) || 60000,
  // Tran RAM cua instance (MB) de tinh nguong canh bao; mac dinh 2048 (goi Render 2GB).
  MEMORY_LIMIT_MB: Number(process.env.MEMORY_LIMIT_MB) || 2048,

  // Doc anh hoa don (tab Tao QR) bang AI vision qua xKiro (chuan OpenAI). Thieu key = tat,
  // trang van tao QR nhap tay. Model du phong chi goi khi model chinh loi 429/5xx/timeout.
  XKIRO_API_KEY: process.env.XKIRO_API_KEY || '',
  XKIRO_BASE_URL: process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1',
  INVOICE_VISION_MODEL: process.env.INVOICE_VISION_MODEL || 'qwen/qwen3.8-max:free',
  INVOICE_VISION_FALLBACK_MODEL: process.env.INVOICE_VISION_FALLBACK_MODEL ?? 'qwen/qwen3-vl-plus:free',

  // Cot "Tồn VAT" cua Yeu cau xuat VAT = TỒN ĐẦU NGÀY tab Gộp VAT (file VAT TKS, doc bang service
  // account). *_SHEET_ID = ID file, *_GID = sheetId cua tab. Bo trong = tab Gộp VAT + Khớp mã cua
  // file VAT TKS (vatDraftConfig).
  VAT_REQUEST_STOCK_SHEET_ID: process.env.VAT_REQUEST_STOCK_SHEET_ID || '',
  VAT_REQUEST_STOCK_GID: process.env.VAT_REQUEST_STOCK_GID || '',
  VAT_REQUEST_STOCK_COLUMN: process.env.VAT_REQUEST_STOCK_COLUMN || '',
  VAT_REQUEST_MAPPING_SHEET_ID: process.env.VAT_REQUEST_MAPPING_SHEET_ID || '',
  VAT_REQUEST_MAPPING_GID: process.env.VAT_REQUEST_MAPPING_GID || ''
};

module.exports = CONFIG;
