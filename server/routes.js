const express = require('express');
const {
  getDashboardData,
  searchDashboardRecords,
  searchCustomerDirectory,
  searchTopCustomersByProducts,
  getCustomerProductRevenueReport
} = require('./dashboard/dashboardData');

const router = express.Router();

const { getExportFields, createExport, buildExportErrorBody } = require('./dashboard/exportService');
const { getProductReport } = require('./dashboard/productReportRepository');
const authRoutes = require('./auth/authRoutes');
const adminUserRoutes = require('./auth/adminUserRoutes');
const { requireAuth, requireFeature } = require('./auth/authMiddleware');
const { ANY_REPORTS_FEATURES, permissionsHave } = require('./auth/featureRegistry');
const { parseViewsParam, VIEW_FEATURE } = require('./dashboard/dashboardViews');
const {
  filterDashboardForUser,
  searchFeatureForView,
  allowedSearchEntities
} = require('./dashboard/dashboardPermissionFilter');
const { resolveBranch } = require('./branch/branchMiddleware');
const { branchLabelToCode, resolveBranchScope } = require('./branch/branches');
const branchRoutes = require('./branch/branchRoutes');
const { getPool } = require('./db/pool');
const hrLeaveRoutes          = require('./hr/hrLeaveRoutes');
const notificationRoutes     = require('./notifications/notificationRoutes');
const roleChangeRequestRoutes = require('./auth/roleChangeRequestRoutes');
const stockoutCheckRoutes    = require('./dashboard/stockoutCheck/stockoutCheckRoutes');
const kiotvietWebhookRoutes  = require('./kiotviet/kiotvietWebhookRoutes');
const kiotvietSyncStatusRoutes = require('./kiotvietSync/kiotvietSyncStatusRoutes');
const debtManagementRoutes = require('./dashboard/debtManagementRoutes');
const orderLifecycleRoutes = require('./shipment/orderLifecycleRoutes');
const { dashboardRollupEvents } = require('./kiotvietSync/dashboardRollupEvents');

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.post('/api/client-log', express.text({ type: '*/*' }), (req, res) => {
  console.warn('[Browser Client Error]', req.body);
  res.status(200).json({ ok: true });
});

// Webhook tu KiotViet (nguoi goi la KiotViet, khong phai nguoi dung dang
// nhap) — mount TRUOC moi guard auth/co so. Xem server/kiotviet/kiotvietWebhookRoutes.js.
router.use(kiotvietWebhookRoutes);

// /api/auth/* mount truoc — POST /login va POST /logout khong doi hoi da dang
// nhap (do chinh la noi de dang nhap); GET /me tu bao ve bang requireAuth ben trong.
router.use(authRoutes);
router.use(adminUserRoutes);

// Xem/doi co so dang lam viec — /api/branch. KHONG gan resolveBranch o day:
// chinh hai route nay quyet dinh gia tri cookie ma resolveBranch se doc.
router.use(branchRoutes);

// Toan bo /api/hr/* la du lieu THEO CO SO — gan resolveBranch truoc router con.
router.use('/api/hr', requireAuth, resolveBranch);

// Cac endpoint quan ly nhan su (nghi phep) — /api/hr/* — phan quyen rieng
// tung route ben trong hrLeaveRoutes.js (xem het ho so vs chi Quan ly duyet).
router.use(hrLeaveRoutes);

// Chuong thong bao dung chung cho MOI tai khoan — /api/notifications/*.
router.use(notificationRoutes);

// Yeu cau doi vai tro tu than — /api/role-requests/* — Quan ly duyet/tu choi.
router.use(roleChangeRequestRoutes);

// PATCH trạng thái công nợ tự mang auth/role/branch guard bên trong router.
router.use(debtManagementRoutes);

// Trang thai sync chi danh cho ai co quyen 'system.syncStatus' (mac dinh:
// Quan ly); route tu fail-soft 503 neu chua co DB.
router.use('/api/internal/kiotviet-sync/status', requireAuth, requireFeature('system.syncStatus'));
router.use(kiotvietSyncStatusRoutes);

// Tra cuu & quan ly vong doi don hang — Khach (xem don cua minh) + vai tro noi bo.
router.use('/api/shipment/lifecycle', requireAuth, orderLifecycleRoutes);

// Toan bo API "Bao cao tong hop" ben duoi day duoc gac bang QUYEN TINH NANG
// (server/auth/featureRegistry.js), khong con bang mang vai tro. Mac dinh chi
// Quan ly + Tro ly co cac quyen reports.*, nhung Quan ly co the cap/thu tung
// quyen cho tung tai khoan tai /account/#users. Day la ranh gioi bao mat that
// su; shared-nav.js chi dung menu tu danh sach quyen server tra ve.
// Khach chi duoc dung route tra cuu vong doi don hang o tren. Trang tra cuu
// cong khai cho khach hang (Phase 1) se nam o route rieng, KHONG qua requireAuth.
const reportsUser = (...features) => [requireAuth, requireFeature(...features), resolveBranch];
// /api/dashboard va /api/search phuc vu CA 6 tab bao cao nen chi doi hoi "co it
// nhat mot quyen reports.*"; phan du lieu cua tung tab duoc cat bot sau do
// (dashboardPermissionFilter.js). Cac endpoint rieng cua tung tab thi doi hoi
// dung quyen cua tab do.
router.use('/api/debug', ...reportsUser(...ANY_REPORTS_FEATURES));
router.use('/api/dashboard', ...reportsUser(...ANY_REPORTS_FEATURES));
router.use('/api/search', ...reportsUser(...ANY_REPORTS_FEATURES));
router.use('/api/customer-suggest', ...reportsUser('reports.customers'));
router.use('/api/customer-product-top', ...reportsUser('reports.customers'));
router.use('/api/customer-product-revenue', ...reportsUser('reports.customers'));
router.use('/api/product-report', ...reportsUser('reports.products'));
router.use('/api/export', ...reportsUser('reports.export'));
router.use('/api/products', ...reportsUser('reports.products'));

// Kiem tra dut hang, doi chieu truc tiep KiotViet API — /api/products/stockout-recent/*, /api/products/stockout-90d/*
router.use(stockoutCheckRoutes);

// Route kiem tra ket noi nhanh — chi xem duoc tren server, KHONG expose secret
router.get('/api/debug', async (req, res) => {
  // "Cả hai" khong phai ma co so trong DB — doi ra pham vi co so VAT LY roi
  // dem gop, thay vi gui chuoi rong xuong Postgres va luon thay 0 hoa don.
  const branchCodes = resolveBranchScope(req.branch).map(branchLabelToCode);
  const checks = {
    branch: req.branch,
    databaseTest: null,
    databaseError: null
  };
  try {
    const result = await getPool().query('SELECT COUNT(*)::int AS count FROM invoices WHERE branch = ANY($1::text[])', [branchCodes]);
    checks.databaseTest = `OK — ${result.rows[0].count} hóa đơn từ Supabase`;
  } catch (e) {
    checks.databaseError = { message: e.message };
  }
  res.json(checks);
});

// Doc bo loc thoi gian rieng cho 1 tab tu query string, vd prefix "ov" doc
// ovMode/ovDays/ovFrom/ovTo. legacyDays la fallback cho tham so "days" cu (khi
// dashboard chi co 1 bo loc dung chung cho Tong quan+Hoa don) de link cu/API
// cu khong bi vo neu con noi nao goi lai kieu cu.
function parseFilterSpec(query, prefix, legacyDays) {
  return {
    mode: query[prefix + 'Mode'],
    days: query[prefix + 'Days'] || legacyDays,
    from: query[prefix + 'From'],
    to: query[prefix + 'To']
  };
}

// ?view=<tab> (overview|products|invoices|customers|suppliers|debt, co the nhieu
// tab cach nhau dau phay): CHI doc/tinh/tra phan cua tab do — trang bao cao goi
// khi nguoi dung mo tung tab (xem dashboardViews.js). Bo trong = ca 6 tab nhu
// truoc day. Tab tai khoan khong co quyen xem bi bo qua NGAY (khong doc/tinh gi):
// tra payload rong thay vi 403, giong viec filterDashboardForUser() cat ban day du.
router.get('/api/dashboard', async (req, res) => {
  let requestedViews;
  try {
    requestedViews = parseViewsParam(req.query.view);
  } catch (err) {
    return res.status(err.statusCode || 400).json({ error: err.message, code: err.code });
  }
  const allowedViews = requestedViews === null
    ? null
    : requestedViews.filter(view => permissionsHave(req.user.permissions, VIEW_FEATURE[view]));
  if (allowedViews && !allowedViews.length) {
    return res.status(200).json({ filters: {}, kpi: {} });
  }
  try {
    const legacyDays = req.query.days;
    const filters = {
      overview: parseFilterSpec(req.query, 'ov', legacyDays),
      products: {
        ...parseFilterSpec(req.query, 'pr'),
        status: req.query.prStatus
      },
      invoices: parseFilterSpec(req.query, 'in', legacyDays),
      // Tab Khách hàng mặc định xem toàn thời gian; cùng bo loc cuMode/cuDays/
      // cuFrom/cuTo duoc dung cho Top khach doanh thu va API top theo san pham.
      customers: {
        ...parseFilterSpec(req.query, 'cu'),
        mode: req.query.cuMode || 'all'
      },
      newPurchases: parseFilterSpec(req.query, 'pu'),
      // Tab Hang hoa phan 5 "Hang moi nhap" co bo loc thoi gian rieng.
      newlyImported: parseFilterSpec(req.query, 'ni'),
      newProducts: parseFilterSpec(req.query, 'np')
    };
    const data = await getDashboardData(filters, req.branch, req.user, allowedViews ? { views: allowedViews } : undefined);
    // Object tra ve co the den tu cache dung chung — filterDashboardForUser()
    // dung object MOI, khong sua data tai cho (xem dashboardPermissionFilter.js).
    res.status(200).json(filterDashboardForUser(data, req.user.permissions));
  } catch (err) {
    const googleStatus = err?.response?.status;
    const googleMessage = err?.response?.data?.error?.message || err?.response?.data;
    console.error('=== LOI /api/dashboard ===');
    console.error('Message:', err.message);
    console.error('Google API status:', googleStatus);
    console.error('Google API message:', JSON.stringify(googleMessage));
    console.error('Stack:', err.stack);
    console.error('=========================');
    res.status(err.statusCode || 500).json({
      error: err.statusCode && err.statusCode < 500 ? err.message : 'Khong lay duoc du lieu dashboard.',
      detail: err.message,
      googleStatus,
      googleMessage,
      code: err.code
    });
  }
});

// Server-Sent Events: bao cho trinh duyet biet ngay khi rollup Dashboard vua
// refresh xong (moi 5 phut, xem dashboardRollupRefresh.js) de trang "Bao cao
// tong hop" tu goi lai /api/dashboard, khong can F5 hay poll lien tuc. CHI
// bao "co du lieu moi" (khong keo payload) - frontend tu goi lai voi bo loc
// va quyen/co so cua chinh phien dang nhap do, nen khong can phat rieng theo
// co so o day.
router.get('/api/dashboard/events', (req, res) => {
  req.socket.setTimeout(0); // Node mac dinh timeout socket sau ~2 phut khong hoat dong
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no' // tat buffer o Cloudflare/Render de event toi ngay, khong bi giu lai
  });

  const write = (chunk) => {
    res.write(chunk);
    // compression() (server/index.js) boc res trong 1 stream gzip co buffer
    // rieng - khong flush thu cong thi event co the bi giu lai vai KB trong
    // buffer thay vi toi trinh duyet ngay.
    if (typeof res.flush === 'function') res.flush();
  };

  write(':ok\n\n');
  const onUpdated = (payload) => write(`event: dashboard-updated\ndata: ${JSON.stringify(payload)}\n\n`);
  dashboardRollupEvents.on('updated', onUpdated);

  // Giu ket noi song qua proxy hay tu ngat sau vai chuc giay khong co byte nao.
  const heartbeat = setInterval(() => write(':heartbeat\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    dashboardRollupEvents.off('updated', onUpdated);
  });
});

router.get('/api/search', async (req, res) => {
  try {
    const viewFeature = searchFeatureForView(req.query.view);
    if (!req.user.permissions.includes(viewFeature)) {
      return res.status(403).json({
        error: 'Tài khoản không có quyền sử dụng tính năng này.',
        code: 'FEATURE_FORBIDDEN',
        feature: viewFeature
      });
    }
    const filterSpec = req.query.view === 'customers' ? parseFilterSpec(req.query, 'cu') : undefined;
    // view 'overview' quet moi nhom du lieu — gioi han lai theo quyen de nguoi
    // bi chan tab Khach hang/Nha cung cap khong tim thay du lieu do qua day.
    const data = await searchDashboardRecords(
      req.query.view, req.query.q, req.query.limit, req.query.mode, filterSpec, req.branch,
      allowedSearchEntities(req.user.permissions)
    );
    res.status(200).json(data);
  } catch (err) {
    const googleStatus = err?.response?.status;
    console.error('=== LOI /api/search ===');
    console.error('Message:', err.message);
    console.error('Google API status:', googleStatus);
    console.error('Stack:', err.stack);
    console.error('=====================');
    res.status(err.statusCode || 500).json({
      error: 'Khong tim kiem duoc du lieu dashboard.',
      detail: err.message,
      code: err.code,
      googleStatus
    });
  }
});

// Goi y ten/ma khach hang cho o tim kiem "Bao cao doanh thu theo khach" (tab
// Tong quan) — nguon rieng, NHE (chi bang "customers"), tach khoi /api/search
// dung chung cache 9-tab dashboard de khong bi cham theo cac tab khac.
router.get('/api/customer-suggest', async (req, res) => {
  try {
    const data = await searchCustomerDirectory(req.branch, req.query.q, req.query.limit);
    res.status(200).json(data);
  } catch (err) {
    console.error('=== LOI /api/customer-suggest ===');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
    console.error('==================================');
    res.status(err.statusCode || 500).json({
      error: 'Khong tim duoc goi y khach hang.',
      detail: err.message,
      code: err.code
    });
  }
});

router.get('/api/customer-product-top', async (req, res) => {
  try {
    const data = await searchTopCustomersByProducts(
      req.query.q,
      {
        ...parseFilterSpec(req.query, 'cu'),
        mode: req.query.cuMode || 'all'
      },
      undefined, // `now` — de mac dinh, tham so tiem cho test
      req.branch
    );
    res.status(200).json(data);
  } catch (err) {
    const googleStatus = err?.response?.status;
    console.error('=== LOI /api/customer-product-top ===');
    console.error('Message:', err.message);
    console.error('Google API status:', googleStatus);
    console.error('Stack:', err.stack);
    console.error('======================================');
    res.status(err.statusCode || 500).json({
      error: 'Khong tim duoc top khach hang theo san pham.',
      detail: err.message,
      code: err.code,
      googleStatus
    });
  }
});

router.get('/api/customer-product-revenue', async (req, res) => {
  try {
    const data = await getCustomerProductRevenueReport(
      req.query.code,
      req.query.name,
      req.branch
    );
    res.status(200).json(data);
  } catch (err) {
    const googleStatus = err?.response?.status;
    console.error('=== LOI /api/customer-product-revenue ===');
    console.error('Message:', err.message);
    console.error('Google API status:', googleStatus);
    console.error('Stack:', err.stack);
    console.error('==========================================');
    res.status(err.statusCode || 500).json({
      error: err.statusCode && err.statusCode < 500 ? err.message : 'Khong lay duoc bao cao doanh thu theo khach.',
      detail: err.message,
      code: err.code,
      googleStatus
    });
  }
});

router.get('/api/product-report', async (req, res) => {
  try {
    const data = await getProductReport();
    res.status(200).json(data);
  } catch (err) {
    console.error('=== LOI /api/product-report ===');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
    console.error('================================');
    res.status(err.statusCode || 500).json({
      error: err.statusCode && err.statusCode < 500 ? err.message : 'Không lấy được báo cáo hàng hóa.',
      detail: err.message,
      code: err.code
    });
  }
});

function sendExportError(res, err, fallbackMessage) {
  console.error('=== LOI XUAT EXCEL ===');
  console.error('Message:', err.message);
  console.error('Code:', err.code);
  console.error('Stack:', err.stack);
  console.error('======================');
  // Luong xuat doc Postgres (khong con Google); chi tra detail cho loi da biet.
  res.status(err.statusCode || 500).json(buildExportErrorBody(err, fallbackMessage));
}

router.post('/api/export/fields', async (req, res) => {
  try {
    const metadata = await getExportFields(req.body || {}, req.branch);
    res.status(200).json(metadata);
  } catch (err) {
    sendExportError(res, err, 'Không lấy được danh sách trường xuất Excel.');
  }
});

// body.format: 'xlsx' (mac dinh, giu hanh vi cu khi khong gui) | 'html' (bao cao tu chua).
// Hai dinh dang dung chung tang dataset, phan quyen/co so (req.branch) va hang doi xuat file.
router.post('/api/export', async (req, res) => {
  // Client ngat ket noi (dong modal/huy) truoc khi ghi xong -> huy viec dang lam
  // de nha slot xuat file; khong tra body cho ket noi da dong.
  const abortController = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abortController.abort();
  });
  try {
    const file = await createExport(req.body || {}, req.branch, { signal: abortController.signal });
    if (abortController.signal.aborted) return;
    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.setHeader('Content-Length', file.buffer.length);
    res.status(200).send(file.buffer);
  } catch (err) {
    if (abortController.signal.aborted) return;
    const isHtml = String((req.body && req.body.format) || '').toLowerCase() === 'html';
    sendExportError(res, err, isHtml ? 'Không thể tạo báo cáo HTML.' : 'Không thể tạo file Excel.');
  }
});

module.exports = router;
