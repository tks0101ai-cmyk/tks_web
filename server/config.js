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
  SHEET_SUPPLIERS: 'Nhà cung cấp',
  SHEET_PURCHASES: 'Nhập hàng',

  DEBT_MANAGEMENT_SHEET_HN: 'Công nợ HN',
  DEBT_MANAGEMENT_SHEET_SG: 'Công nợ SG',

  // ==========================================
  // VONG DOI DON HANG — spreadsheet RIENG (2 tab DonHang_HN/DonHang_SG trong
  // CUNG 1 spreadsheet). Server CHI DOC 2 tab do.
  // Tab "Lich su cap nhat" (ORDER_LIFECYCLE_SHEET_HISTORY) la NGOAI LE: do
  // server tu tao/ghi (ghi de trang thai thu cong cua Quan ly/Ke toan).
  // ==========================================
  ORDER_LIFECYCLE_SPREADSHEET_ID: process.env.ORDER_LIFECYCLE_SPREADSHEET_ID || null,
  ORDER_LIFECYCLE_SHEET_HN: 'DonHang_HN',
  ORDER_LIFECYCLE_SHEET_SG: 'DonHang_SG',
  ORDER_LIFECYCLE_SHEET_HISTORY: 'Lịch sử cập nhật',

  // ==========================================
  // QUAN LY NHAN SU — Spreadsheet rieng (HR_*)
  // ==========================================
  // Optional — neu chua set thi log canh bao khi module HR duoc goi, khong
  // lam crash server hien tai.
  HR_SPREADSHEET_ID: process.env.HR_SPREADSHEET_ID || null,
  // Nguon nhan su rieng cua co so Sai Gon (se cung cap sau) — bo trong thi tab
  // "Quan ly nhan su" o co so Sai Gon bao "Chua duoc cau hinh".
  HR_SPREADSHEET_ID_SG: process.env.HR_SPREADSHEET_ID_SG || null,

  HR_SHEET_EMPLOYEES: 'Danh sách nhân sự',

  // Co "nghi gap": tin nhan gui tu gio nay tro di (gio Bangkok, 0-23) VA ca
  // nghi bat dau ngay hom sau lien ke thi tu dong gan co, chi de canh bao,
  // khong tu tu choi.
  HR_URGENT_LATE_NIGHT_HOUR: Number(process.env.HR_URGENT_LATE_NIGHT_HOUR) || 22,
  // So lan nghi gap/thang vuot nguong nay thi hien badge canh bao cho Quan ly.
  HR_URGENT_FLAG_MONTHLY_THRESHOLD: Number(process.env.HR_URGENT_FLAG_MONTHLY_THRESHOLD) || 2,

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
  // Chu ky toi thieu giua 2 lan quet TOAN BO ton kho (/productOnHands, xem
  // kiotvietSync/entities/productOnHandsSnapshot.js). Mac dinh 10 phut.
  KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS: Number(process.env.KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS) > 0
    ? Number(process.env.KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS) : 10 * 60 * 1000,
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
  DASHBOARD_PREWARM: process.env.DASHBOARD_PREWARM !== 'false'
};

module.exports = CONFIG;
