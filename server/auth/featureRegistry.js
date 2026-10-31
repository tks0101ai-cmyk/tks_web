// ==========================================
// FEATURE REGISTRY — NGUON SU THAT DUY NHAT cho phan quyen theo tinh nang.
//
// Truoc day quyen duoc ma hoa bang nhieu mang vai tro roi rac o CA HAI phia
// (NO_REPORTS_ROLES trong shared-nav.js vs REPORTS_ROLES trong userRepository.js,
// BULK_VIEW_ROLES trong lifecycle/index.html vs ORDER_LIFECYCLE_BULK_ROLES
// trong orderLifecycleRoutes.js...) nen giao dien va API de lech nhau.
//
// Nay CHI con bang FEATURES o duoi:
//   - Server: requireFeature(...) trong authMiddleware.js doc tu day.
//   - Client: khong con mang vai tro nao; /api/auth/me tra ve `permissions`
//     (danh sach key da giai) + `pageFeatures`, shared-nav.js dung menu tu do.
//
// Quyen mac dinh tinh theo VAI TRO; moi tai khoan co the duoc Quan ly ghi de
// tung key mot (cot app_users.feature_permissions, chi luu DELTA so voi mac
// dinh — doi bang mac dinh o day thi tai khoan cu van huong theo).
// ==========================================
'use strict';

const { ROLES, INTERNAL_ROLES, REPORTS_ROLES, isHardcodedAdmin } = require('./userRepository');

const ALL_ROLES = Object.freeze(Object.values(ROLES));
const MANAGER_ONLY = Object.freeze([ROLES.QUAN_LY]);
// Cac tab XEM bao cao (Tong quan, Hang hoa, Hoa don, Khach hang, Cong no) mo them cho
// Nhan vien sale (2026-10-02). Xuat Excel + sua cong no van chi Quan ly + Tro ly
// (REPORTS_ROLES), nen KHONG nhet sale vao REPORTS_ROLES — mang do cap ca 7 key reports.*.
const REPORT_VIEW_ROLES = Object.freeze([...REPORTS_ROLES, ROLES.NHAN_VIEN_SALE]);
// Vong doi don hang (toan bo don): bo Nhan vien mua hang + Nhan vien marketing (2026-10-02)
// va Nhan vien kho (2026-10-03). Ba vai tro nay van con 'shipment.lookup' (tra cuu theo ma).
const NO_LIFECYCLE_ROLES = Object.freeze([ROLES.NHAN_VIEN_KHO, ROLES.NHAN_VIEN_MARKETING, ROLES.NHAN_VIEN_MUA_HANG]);
const LIFECYCLE_ROLES = Object.freeze(INTERNAL_ROLES.filter(r => !NO_LIFECYCLE_ROLES.includes(r)));

const FEATURE_GROUPS = Object.freeze([
  { key: 'reports', label: 'Báo cáo tổng hợp' },
  { key: 'shipment', label: 'Quản lý đơn hàng' },
  { key: 'stockLocations', label: 'Vị trí hàng' },
  { key: 'hr', label: 'Quản lý nhân sự' },
  { key: 'cashbook', label: 'Sổ quỹ' },
  { key: 'accounting', label: 'Kế toán' },
  { key: 'account', label: 'Quản lý tài khoản' },
  { key: 'system', label: 'Hệ thống' }
]);

/**
 * Thu tu trong mang nay = thu tu hien thi trong sidebar VA trong bang phan
 * quyen o /account/. `roles` la mac dinh theo vai tro; `alwaysOn` la quyen
 * khong ai tat duoc (tranh khoa chet nguoi dung ra khoi he thong).
 */
const FEATURES = Object.freeze([
  { key: 'reports.products.expected.otherNote', groupKey: 'reports', label: 'Dự kiến hàng về: Xem Ghi chú khác', roles: MANAGER_ONLY, requires: 'reports.products.expected' },
  // --- Bao cao tong hop ---
  { key: 'reports.overview', groupKey: 'reports', label: 'Tổng quan', roles: REPORT_VIEW_ROLES },
  { key: 'reports.overview.containers.full', groupKey: 'reports', label: 'Xem đầy đủ chi tiết CONT (cần Hàng hóa)', roles: MANAGER_ONLY, requires: 'reports.products' },
  { key: 'reports.products', groupKey: 'reports', label: 'Hàng hóa: xem Báo cáo hàng hóa và Kiểm tra đứt hàng', roles: REPORT_VIEW_ROLES },
  { key: 'reports.products.growth', groupKey: 'reports', label: 'Hàng hóa: xem Tăng trưởng mã hàng', roles: REPORT_VIEW_ROLES },
  // Nhan vien marketing giu quyen cu: khong xem tab Hang hoa. Quyen nay chi tach rieng cac thong tin
  // suy ra duoc don gia (doanh so 90 ngay, mo ta bang gia, doanh so khach lon nhat) cho nguoi da co reports.products.
  { key: 'reports.products.sales', groupKey: 'reports', label: 'Hàng hóa: xem doanh số, mô tả bảng giá và doanh số theo khách (cần Hàng hóa)', roles: REPORT_VIEW_ROLES, requires: 'reports.products' },
  // 2026-10-17: cot Don gia HN/SG cua Bao cao hang hoa (gia ban chung KiotViet); mac dinh chi Quan ly + Tro ly.
  { key: 'reports.products.price', groupKey: 'reports', label: 'Hàng hóa: xem đơn giá HN / SG (cần Hàng hóa)', roles: REPORTS_ROLES, requires: 'reports.products' },
  // Du kien hang ve: moi vai tro noi bo; doc lap voi Bao cao hang hoa va Tang truong ma hang.
  { key: 'reports.products.expected', groupKey: 'reports', label: 'Hàng hóa: xem bảng Dự kiến hàng về', roles: INTERNAL_ROLES },
  { key: 'reports.invoices', groupKey: 'reports', label: 'Hóa đơn', roles: REPORT_VIEW_ROLES },
  // 2026-10-20: Kiem tra gia ban (tab Hoa don, server/invoicePriceAudit). Giai thich chi Sale dung nhom khach HIEN TAI
  // (kiem tra o server moi lan ghi); Chot mac dinh chi Quan ly, KHONG tu cap Tro ly; quyen Chot khong kem quyen giai thich.
  // escalationExempt cho giai thich: giong Sale phan hoi cong no (Tro ly van tao / dat lai mat khau TK Sale duoc).
  { key: 'reports.invoices.priceAudit', groupKey: 'reports', label: 'Hóa đơn: xem Kiểm tra giá bán (cần Hóa đơn)', roles: REPORT_VIEW_ROLES, requires: 'reports.invoices' },
  { key: 'reports.invoices.priceAudit.explain', groupKey: 'reports', label: 'Kiểm tra giá bán: điền / sửa Sale giải thích trên mọi hóa đơn (cần Kiểm tra giá bán)', roles: [ROLES.NHAN_VIEN_SALE], requires: 'reports.invoices.priceAudit', escalationExempt: true },
  { key: 'reports.invoices.priceAudit.decide', groupKey: 'reports', label: 'Kiểm tra giá bán: Chốt Ok / Phạt (cần Kiểm tra giá bán)', roles: MANAGER_ONLY, requires: 'reports.invoices.priceAudit' },
  // 2026-10-24: Bang Gia duyet (ap thay gia toi thieu khi kiem tra gia). Bang nay NHAY CAM nen xem cung la quyen rieng:
  // mac dinh chi Quan ly (Tro ly / Sale khong thay muc nay neu khong duoc cap); tao / sua / xoa can them quyen .manage.
  { key: 'reports.invoices.approvedPrice', groupKey: 'reports', label: 'Hóa đơn: xem Bảng giá duyệt (cần Hóa đơn)', roles: MANAGER_ONLY, requires: 'reports.invoices' },
  { key: 'reports.invoices.approvedPrice.manage', groupKey: 'reports', label: 'Bảng giá duyệt: tạo / sửa / xóa (cần xem Bảng giá duyệt)', roles: MANAGER_ONLY, requires: 'reports.invoices.approvedPrice' },
  // 2026-10-07: Bao cao kinh doanh (tang truong Sale/Khach/Ma hang theo thang). Spec:
  // docs/superpowers/specs/2026-10-07-business-report-design.md.
  // 2026-10-16: tab nay thay tab Khach hang cu (da go, quyen reports.customers bo) nen hien ten "Khách hàng";
  // giu nguyen khoa `reports.business` de khong mat quyen da cap.
  { key: 'reports.business', groupKey: 'reports', label: 'Khách hàng', roles: REPORT_VIEW_ROLES },
  { key: 'reports.business.refreeze', groupKey: 'reports', label: 'Khách hàng: tính lại tháng đã chốt (cần Khách hàng)', roles: MANAGER_ONLY, requires: 'reports.business' },
  // 2026-10-16: Quan ly doi team cua tung sale ngay tren bang "Tang truong Sale" (bang sale_teams).
  { key: 'reports.business.editTeam', groupKey: 'reports', label: 'Khách hàng: sửa team của sale (cần Khách hàng)', roles: MANAGER_ONLY, requires: 'reports.business' },
  // 2026-10-22: Ghi chu / thong tin theo khach tren bang "Doanh so theo khach" (server/businessReport/customerProfile*).
  // Xem = Quan ly + Tro ly + Sale; sua Tiep khach lan cuoi, gan nguoi sua va sua moi khach chi Quan ly.
  // Nguoi duoc Quan ly gan (customer_editors) sua duoc Thong tin chung + Note cua dung khach do.
  { key: 'reports.business.customerNotes', groupKey: 'reports', label: 'Khách hàng: xem ghi chú và tiếp khách (cần Khách hàng)', roles: REPORT_VIEW_ROLES, requires: 'reports.business' },
  { key: 'reports.business.customerManage', groupKey: 'reports', label: 'Khách hàng: sửa tiếp khách lần cuối, gán người sửa ghi chú (cần Ghi chú khách)', roles: MANAGER_ONLY, requires: 'reports.business.customerNotes' },
  { key: 'reports.debt', groupKey: 'reports', label: 'Công nợ', roles: REPORT_VIEW_ROLES },
  // 2026-10-13: cong no theo lich TT (server/debtSchedule). Moi cot sua duoc la 1 quyen
  // rieng: Sale phan hoi (mac dinh Nhan vien sale), QL phan hoi + Trang thai + Lich TT (mac
  // dinh Quan ly). Quan ly cap them tung tai khoan o /account/.
  { key: 'reports.debt.saleFeedback', groupKey: 'reports', label: 'Công nợ: điền Sale phản hồi (cần Công nợ)', roles: [ROLES.NHAN_VIEN_SALE], requires: 'reports.debt', escalationExempt: true },
  { key: 'reports.debt.managerFeedback', groupKey: 'reports', label: 'Công nợ: điền QL phản hồi (cần Công nợ)', roles: MANAGER_ONLY, requires: 'reports.debt' },
  { key: 'reports.debt.edit', groupKey: 'reports', label: 'Công nợ: đổi trạng thái xử lý (cần Công nợ)', roles: MANAGER_ONLY, requires: 'reports.debt' },
  { key: 'reports.debt.schedule', groupKey: 'reports', label: 'Công nợ: sửa lịch thanh toán (cần Công nợ)', roles: MANAGER_ONLY, requires: 'reports.debt' },
  { key: 'reports.debt.penalty', groupKey: 'reports', label: 'Công nợ: điền tiền phạt phiên này (cần Công nợ)', roles: MANAGER_ONLY, requires: 'reports.debt' },
  { key: 'reports.debt.refresh', groupKey: 'reports', label: 'Công nợ: tính lại công nợ tại thời điểm bấm (cần Công nợ)', roles: MANAGER_ONLY, requires: 'reports.debt' },
  { key: 'reports.marketing', groupKey: 'reports', label: 'Báo cáo Marketing', roles: [...REPORTS_ROLES, ROLES.NHAN_VIEN_MARKETING] },
  // 2026-10-08: sua 2 cot Khach moi/Ghi chu cua BC thang Marketing va ghi nguoc Google Sheets.
  { key: 'reports.marketing.edit', groupKey: 'reports', label: 'Báo cáo Marketing: quản lý BC tháng và ánh xạ nhân viên (chỉ Quản lý)', roles: MANAGER_ONLY, forbiddenRoles: ALL_ROLES.filter(role => role !== ROLES.QUAN_LY), requires: 'reports.marketing' },
  { key: 'reports.export', groupKey: 'reports', label: 'Xuất Excel báo cáo', roles: REPORTS_ROLES },

  // --- Quan ly don hang ---
  // 2026-10-03: Tra cuu theo ma, Lich su, Xuat Excel, Ghi de deu GAN vao Vong doi don hang
  // (`requires`): thieu 'shipment.lifecycle' thi cac quyen nay bi bo du vai tro/ghi de co cap.
  { key: 'shipment.lifecycle', groupKey: 'shipment', label: 'Vòng đời đơn hàng (toàn bộ đơn)', roles: LIFECYCLE_ROLES },
  { key: 'shipment.lookup', groupKey: 'shipment', label: 'Tra cứu đơn theo mã (cần Vòng đời đơn hàng)', roles: LIFECYCLE_ROLES, requires: 'shipment.lifecycle' },
  { key: 'shipment.history', groupKey: 'shipment', label: 'Lịch sử cập nhật (cần Vòng đời đơn hàng)', roles: LIFECYCLE_ROLES, requires: 'shipment.lifecycle' },
  // 2026-10-02: chi Quan ly xuat duoc file (truoc day moi vai tro noi bo); Quan ly van cap them tung tai khoan duoc.
  { key: 'shipment.export', groupKey: 'shipment', label: 'Xuất Excel đơn hàng (cần Vòng đời đơn hàng)', roles: MANAGER_ONLY, requires: 'shipment.lifecycle' },
  // 2026-10-03: Ke toan khong con duoc ghi de mac dinh; Quan ly cap rieng tung tai khoan khi can.
  { key: 'shipment.override', groupKey: 'shipment', label: 'Ghi đè trạng thái đơn (cần Vòng đời đơn hàng)', roles: MANAGER_ONLY, requires: 'shipment.lifecycle' },
  // 2026-10-27: Chi dinh vi tri hang cho don "Da gui ke toan" (giu cho, in phieu nhat, xac nhan / huy nhat = tru / hoan tac thung that
  // trong VT Ha Noi / VT Sai Gon). Chi Quan ly mac dinh; Quan ly cap rieng tung tai khoan khi can.
  { key: 'shipment.pick', groupKey: 'shipment', label: 'Chỉ định vị trí hàng cho đơn (cần Vòng đời đơn hàng)', roles: MANAGER_ONLY, requires: 'shipment.lifecycle' },

  // 2026-10-30: VT Ha Noi / VT Sai Gon (bang stock_positions) la module Vi tri hang DUY NHAT (module doc Google Sheets cu da go,
  // khoa stockLocations.view bo; ghi de cu con luu trong tai khoan bi sanitizeOverrides bo qua).
  // Xem + Xuat Excel mac dinh mo cho MOI vai tro ke ca Khach (Khach nam trong GUEST_ALLOWED_KEYS), Quan ly van tat duoc tung tai khoan.
  // escalationExempt: ai cung co mac dinh nen Tro ly duoc uy quyen (da bi tat xem/xuat) van tao / dat lai mat khau tai khoan duoc.
  { key: 'stockLocationsV2.view', groupKey: 'stockLocations', label: 'Xem VT Hà Nội / VT Sài Gòn', roles: ALL_ROLES, escalationExempt: true },
  { key: 'stockLocationsV2.edit', groupKey: 'stockLocations', label: 'Sửa / thêm / xóa / import VT Hà Nội / VT Sài Gòn (cần xem VT)', roles: MANAGER_ONLY, forbiddenRoles: [ROLES.KHACH], requires: 'stockLocationsV2.view' },
  { key: 'stockLocationsV2.export', groupKey: 'stockLocations', label: 'Xuất Excel VT Hà Nội / VT Sài Gòn (cần xem)', roles: ALL_ROLES, requires: 'stockLocationsV2.view', escalationExempt: true },
  { key: 'stockLocationsV2.historyDelete', groupKey: 'stockLocations', label: 'Xóa lịch sử VT Hà Nội / VT Sài Gòn (cần xem VT)', roles: MANAGER_ONLY, forbiddenRoles: [ROLES.KHACH], requires: 'stockLocationsV2.view' },

  // --- Quan ly nhan su ---
  { key: 'hr.rules', groupKey: 'hr', label: 'Quy định công ty', roles: ALL_ROLES },
  { key: 'hr.rules.manage', groupKey: 'hr', label: 'Tải lên / gỡ tài liệu quy định', roles: MANAGER_ONLY },
  { key: 'hr.employees', groupKey: 'hr', label: 'Danh sách nhân sự', roles: INTERNAL_ROLES },
  { key: 'hr.employees.manage', groupKey: 'hr', label: 'Thêm / sửa nhân sự, đổi trạng thái làm việc (cần Danh sách nhân sự)', roles: MANAGER_ONLY, requires: 'hr.employees' },
  { key: 'hr.leave', groupKey: 'hr', label: 'Nghỉ phép (xem)', roles: ALL_ROLES },
  { key: 'hr.leave.manage', groupKey: 'hr', label: 'Duyệt nghỉ phép', roles: MANAGER_ONLY },

  { key: 'hr.leave.absence.manage', groupKey: 'hr', label: 'Ghi nhận tự ý nghỉ', roles: MANAGER_ONLY },
  { key: 'hr.leave.submit', groupKey: 'hr', label: 'Tự gửi đơn nghỉ phép', roles: [], dynamic: true },

  // --- Sổ quỹ: chỉ xem/xuất; tồn quỹ tự tính từ KiotViet nên không còn quyền chốt số dư ---
  { key: 'cashbook.view', groupKey: 'cashbook', label: 'Xem sổ quỹ', roles: MANAGER_ONLY },

  // --- Ke toan: Nhap VAT (port vat-draft-app, 2026-10-17). Mac dinh chi Quan ly (+ admin cung);
  // Quan ly bat rieng cho tung tai khoan Ke toan o /account/ — KHONG cap theo vai tro Ke toan.
  // 2026-10-17: tab Tra cuu nguon da go; Tao QR tach thanh quyen rieng mo cho Nhan vien sale
  // (sale chi thay tab Tao QR, khong vao duoc Xu ly hoa don). Ai co accounting.vatDraft van dung Tao QR.
  // escalationExempt: Tro ly duoc uy quyen van tao / dat lai mat khau TK Sale duoc (chi tao anh QR).
  { key: 'accounting.vatDraft', groupKey: 'accounting', label: 'Nháp VAT (Xử lý hóa đơn, Tạo QR)', roles: MANAGER_ONLY, forbiddenRoles: [ROLES.KHACH] },
  { key: 'accounting.qr', groupKey: 'accounting', label: 'Tạo QR chuyển khoản', roles: [ROLES.QUAN_LY, ROLES.NHAN_VIEN_SALE], forbiddenRoles: [ROLES.KHACH], escalationExempt: true },
  // 2026-10-23: Tra cuu VAT (thay app Apps Script Tra cứu VAT, server/vatLookup): ton VAT + hang sap ve.
  // Chi doc, cung nhom vai tro voi ORDER VAT; mien kiem tra leo thang de Tro ly van tao TK Sale / Ke toan.
  { key: 'accounting.vatLookup', groupKey: 'accounting', label: 'Tra cứu VAT (tồn VAT, hàng sắp về)', roles: [ROLES.QUAN_LY, ROLES.KE_TOAN, ROLES.NHAN_VIEN_SALE], forbiddenRoles: [ROLES.KHACH], escalationExempt: true },
  // 2026-10-20: Yeu cau xuat VAT (thay sheet ORDER VAT 1, server/vatRequests). Moi nguoi co quyen xem ca bang
  // (chi doc), tao va sua yeu cau CUA MINH khi chua khoa; quyen Xu ly sua trang thai / ghi chu KT / ngay ve.
  // Quyen xem/tao duoc mien kiem tra leo thang de Tro ly van tao duoc TK Sale / Ke toan.
  // Quyen xu ly chi mac dinh cho Quan ly; tung Ke toan duoc cap rieng tai /account/.
  { key: 'accounting.vatRequest', groupKey: 'accounting', label: 'ORDER VAT (xem, tạo yêu cầu)', roles: [ROLES.QUAN_LY, ROLES.KE_TOAN, ROLES.NHAN_VIEN_SALE], forbiddenRoles: [ROLES.KHACH], escalationExempt: true },
  { key: 'accounting.vatRequestProcess', groupKey: 'accounting', label: 'ORDER VAT: xử lý trạng thái, ghi chú KT, ngày về (cần ORDER VAT)', roles: MANAGER_ONLY, forbiddenRoles: [ROLES.KHACH], requires: 'accounting.vatRequest' },

  // --- Quan ly tai khoan ---
  { key: 'account.profile', groupKey: 'account', label: 'Quản lý hồ sơ', roles: ALL_ROLES, alwaysOn: true },
  { key: 'account.users', groupKey: 'account', label: 'Quản lý người dùng (xem)', roles: MANAGER_ONLY },
  { key: 'account.users.manage', groupKey: 'account', label: 'Thêm / sửa / khóa / xóa tài khoản', roles: MANAGER_ONLY },
  { key: 'account.permissions', groupKey: 'account', label: 'Phân quyền chi tiết', roles: MANAGER_ONLY },

  // --- He thong ---
  { key: 'system.syncStatus', groupKey: 'system', label: 'Trạng thái đồng bộ KiotViet', roles: MANAGER_ONLY }
]);

const FEATURE_KEYS = Object.freeze(FEATURES.map(f => f.key));
const FEATURE_BY_KEY = new Map(FEATURES.map(f => [f.key, f]));
const ALWAYS_ON_KEYS = Object.freeze(FEATURES.filter(f => f.alwaysOn).map(f => f.key));

/** Moi key `reports.*` — dung cho cac endpoint dung chung (/api/dashboard, /api/debug). */
const REPORT_VIEW_FEATURES = Object.freeze([
  'reports.overview', 'reports.invoices',
  'reports.debt', 'reports.business'
]);
// (2026-10-20: bo 'reports.products' — tab Hang hoa co API rieng /api/product-report, khong dung /api/dashboard;
// neu giu, tai khoan chi co Hang hoa (Nhan vien marketing) se nhan duoc `kpi` tong hop cua tab Tong quan.)
const ANY_REPORTS_FEATURES = Object.freeze(FEATURE_KEYS.filter(k => k.startsWith('reports.')));

/**
 * Trang noi bo -> quyen can co de MO duoc trang. Dung chung boi pageGuard.js
 * (chan that o server) va shared-nav.js authGuard (dieu huong UX) — client
 * nhan bang nay qua /api/auth/me chu KHONG chep lai.
 *
 * Thu tu = thu tu uu tien khi phai chon "trang dau tien user vao duoc".
 */
const PAGE_FEATURES = Object.freeze([
  // landingAnyOf: quyen tinh cho 'trang dau tien vao duoc' — KHONG tinh reports.products.expected de Ke toan / Mua hang / Kho
  // (chi co bang Du kien hang ve) van dang nhap vao trang cu (Vong doi don / Nhan su), nhung van MO duoc /reports.
  { path: '/reports', href: '/reports/', anyOf: ANY_REPORTS_FEATURES, landingAnyOf: ANY_REPORTS_FEATURES.filter(k => k !== 'reports.products.expected') },
  { path: '/shipment/lifecycle', href: '/shipment/lifecycle/', anyOf: ['shipment.lifecycle'] },
  { path: '/humanresources', href: '/humanresources/', anyOf: ['hr.rules', 'hr.employees', 'hr.leave', 'hr.leave.submit'] },
  { path: '/vt-positions', href: '/vt-positions/', anyOf: ['stockLocationsV2.view'] },
  { path: '/cashbook', href: '/cashbook/', anyOf: ['cashbook.view'] },
  { path: '/vat-draft', href: '/vat-draft/', anyOf: ['accounting.vatDraft', 'accounting.qr'] },
  { path: '/vat-lookup', href: '/vat-lookup/', anyOf: ['accounting.vatLookup'] },
  { path: '/vat-request', href: '/vat-request/', anyOf: ['accounting.vatRequest'] },
  { path: '/account', href: '/account/', anyOf: ['account.profile'] }
]);

/** '/' phuc vu chinh public/index.html giong '/reports' — xem server/index.js. */
const ROOT_PATH_ALIAS = '/reports';

function isFeatureKey(key) {
  return FEATURE_BY_KEY.has(String(key || ''));
}

/** Quyen mac dinh cua mot vai tro (khong tinh ghi de theo tai khoan). */
function defaultsForRole(vaiTro) {
  const role = String(vaiTro || '').trim();
  return FEATURES
    .filter(f => f.alwaysOn || f.roles.includes(role))
    .map(f => f.key);
}

/**
 * Loc object ghi de tho (tu DB hoac tu body request) ve dang { key: boolean }.
 * Key khong ton tai bi bo; gia tri null/undefined bi bo (nghia la "quay ve
 * mac dinh theo vai tro"); key alwaysOn khong cho ghi de.
 */
function sanitizeOverrides(raw) {
  const result = {};
  if (!raw || typeof raw !== 'object') return result;
  for (const [key, value] of Object.entries(raw)) {
    if (!isFeatureKey(key)) continue;
    if (FEATURE_BY_KEY.get(key).alwaysOn || FEATURE_BY_KEY.get(key).dynamic) continue;
    if (value === null || value === undefined) continue;
    result[key] = !!value;
  }
  return result;
}

/** Key la (khong co trong registry) — de API tra loi 400 co ich. */
function unknownOverrideKeys(raw) {
  if (!raw || typeof raw !== 'object') return [];
  return Object.keys(raw).filter(key => !isFeatureKey(key));
}

/**
 * Quyen hieu luc cua mot tai khoan: mac dinh theo vai tro, ap ghi de rieng,
 * luon giu cac key alwaysOn. Tai khoan Quan tri vien he thong (hardcoded
 * admin) luon co du moi quyen — giong cach effectiveUserResolver.js luon ep
 * ho ve vai tro Quan ly.
 */
function resolvePermissions(user) {
  if (!user) return [];
  if (isHardcodedAdmin(user.email) || isHardcodedAdmin(user.username)) {
    return FEATURE_KEYS.filter(key => key !== 'hr.leave.submit' || canSubmitOwnLeave(user));
  }
  const granted = new Set(defaultsForRole(user.vaiTro));
  const overrides = sanitizeOverrides(user.featurePermissions);
  for (const [key, allowed] of Object.entries(overrides)) {
    if (allowed) granted.add(key);
    else granted.delete(key);
  }
  for (const key of ALWAYS_ON_KEYS) granted.add(key);
  if (canSubmitOwnLeave(user)) granted.add('hr.leave.submit');
  else granted.delete('hr.leave.submit');
  // Quyen phu thuoc (`requires`): thieu quyen goc thi bo luon, bat ke vai tro/ghi de.
  for (const f of FEATURES) {
    if (f.requires && !granted.has(f.requires)) granted.delete(f.key);
  }
  // Tra theo thu tu registry de output on dinh (de so sanh trong test/cache).
  return FEATURE_KEYS.filter(key => granted.has(key) && !isFeatureForbiddenForRole(key, user.vaiTro));
}

// Self-service follows active accounts (including guests) with valid workplace data.
function canSubmitOwnLeave(user) {
  if (!user || !Object.values(ROLES).includes(user.vaiTro) || user.trangThai !== 'Đang hoạt động' || user.isDeleted || !user.workCoSo || !user.boPhan) return false;
  try {
    require('./accountWorkAssignment').normalizeWorkAssignment(user);
    return true;
  } catch { return false; }
}

/** Quyen tu dong theo tai khoan (dynamic): khong phai thu de cap cho nguoi khac, nen khong tinh vao luat chong nang quyen. */
function isDynamicFeature(key) {
  return !!FEATURE_BY_KEY.get(key)?.dynamic;
}

// Quyen KHONG tinh la 'cao hon' khi so sanh chong leo thang (accountPolicy): quyen dong, va quyen
// chi ghi ghi chu nghiep vu (vd Sale phan hoi cong no — mac dinh chi Nhan vien sale, nhung Tro ly
// duoc uy quyen van phai tao / dat lai mat khau tai khoan Sale duoc).
function isEscalationExempt(key) {
  const feature = FEATURE_BY_KEY.get(key);
  return !!(feature && (feature.dynamic || feature.escalationExempt));
}

// Quyen tai khoan Khach duoc huong (mac dinh hoac ghi de); moi key khac bi chan cung voi Khach.
// Vi tri hang chi mo phan XEM + XUAT EXCEL; sua / import / xoa lich su van chi noi bo.
const GUEST_ALLOWED_KEYS = Object.freeze([
  'account.profile', 'hr.rules', 'hr.leave', 'hr.leave.submit',
  'stockLocationsV2.view', 'stockLocationsV2.export'
]);

function isFeatureForbiddenForRole(key, role) {
  if (String(role || '').trim() === ROLES.KHACH && !GUEST_ALLOWED_KEYS.includes(key)) return true;
  return !!FEATURE_BY_KEY.get(key)?.forbiddenRoles?.includes(String(role || '').trim());
}

/** Kiem tra tren MANG quyen da giai (req.user.permissions). */
function permissionsHave(permissions, ...keys) {
  if (!Array.isArray(permissions)) return false;
  return keys.some(key => permissions.includes(key));
}

/** Kiem tra tren OBJECT user — dung lai req.user.permissions neu da co. */
function hasFeature(user, ...keys) {
  if (!user) return false;
  const permissions = Array.isArray(user.permissions) ? user.permissions : resolvePermissions(user);
  return permissionsHave(permissions, ...keys.filter(key => !isFeatureForbiddenForRole(key, user.vaiTro) && (key !== 'hr.leave.submit' || canSubmitOwnLeave(user))));
}

function normalizePagePath(pathname) {
  const cleaned = String(pathname || '')
    .split('?')[0]
    .split('#')[0]
    .replace(/\/index\.html$/, '')
    .replace(/\/+$/, '');
  if (!cleaned || cleaned === '') return ROOT_PATH_ALIAS;
  return cleaned;
}

/** Quy tac bao ve cua mot duong dan trang, hoac null neu trang khong can quyen. */
function pageRuleFor(pathname) {
  const normalized = normalizePagePath(pathname);
  return PAGE_FEATURES.find(rule => rule.path === normalized) || null;
}

/** Trang dau tien user co the vao — dung khi phai dieu huong ho di noi khac. */
function landingPathFor(permissions) {
  const rule = PAGE_FEATURES.find(r => permissionsHave(permissions, ...(r.landingAnyOf || r.anyOf)));
  return rule ? rule.href : '/account/';
}

module.exports = {
  FEATURE_GROUPS,
  FEATURES,
  FEATURE_KEYS,
  ALWAYS_ON_KEYS,
  ANY_REPORTS_FEATURES,
  REPORT_VIEW_FEATURES,
  PAGE_FEATURES,
  ROOT_PATH_ALIAS,
  isFeatureKey,
  defaultsForRole,
  sanitizeOverrides,
  unknownOverrideKeys,
  resolvePermissions,
  permissionsHave,
  hasFeature,
  isFeatureForbiddenForRole,
  isDynamicFeature,
  isEscalationExempt,
  normalizePagePath,
  pageRuleFor,
  landingPathFor
};
