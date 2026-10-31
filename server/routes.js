const express = require('express');
const CONFIG = require('./config');
const {
  getDashboardData,
  searchCustomerDirectory,
  getCustomerProductRevenueReport
} = require('./dashboard/dashboardData');

const router = express.Router();

const { getExportFields, createExport, buildExportErrorBody } = require('./dashboard/exportService');
const {
  getProductReport, getProductReportCustomers, getProductReportVersion, PRODUCT_REPORT_PRICE_KEYS, PRODUCT_REPORT_SALES_KEYS
} = require('./dashboard/productReportRepository');
const containerRepository = require('./productContainers/repository');
const { getInventoryValueHistory } = require('./dashboard/inventoryValueHistory');
const { getInvoiceDetail } = require('./dashboard/documentDetailRepository');
const authRoutes = require('./auth/authRoutes');
const adminUserRoutes = require('./auth/adminUserRoutes');
const { requireAuth, requireFeature } = require('./auth/authMiddleware');
const { startTiming, markTiming } = require('./lib/requestTiming');
const { REPORT_VIEW_FEATURES, permissionsHave, hasFeature } = require('./auth/featureRegistry');
const { parseViewsParam, VIEW_FEATURE } = require('./dashboard/dashboardViews');
const { filterDashboardForUser } = require('./dashboard/dashboardPermissionFilter');
const { resolveBranch } = require('./branch/branchMiddleware');
const { branchLabelToCode, resolveBranchScope } = require('./branch/branches');
const branchRoutes = require('./branch/branchRoutes');
const { getPool } = require('./db/pool');
const hrLeaveRoutes          = require('./hr/hrLeaveRoutes');
const hrRuleDocumentRoutes   = require('./hr/hrRuleDocumentRoutes');
const notificationRoutes     = require('./notifications/notificationRoutes');
const roleChangeRequestRoutes = require('./auth/roleChangeRequestRoutes');
const stockoutCheckRoutes    = require('./dashboard/stockoutCheck/stockoutCheckRoutes');
const kiotvietWebhookRoutes  = require('./kiotviet/kiotvietWebhookRoutes');
const { createManagerLeaveWebhook } = require('./telegram/managerLeaveWebhook');
const { createManagerLeaveMiniApp } = require('./telegram/managerLeaveMiniApp');
const { getConfiguredManagerLeaveRuntime } = require('./telegram/managerLeaveRuntime');
const managerLeaveRuntime = getConfiguredManagerLeaveRuntime();
const kiotvietSyncStatusRoutes = require('./kiotvietSync/kiotvietSyncStatusRoutes');
const debtManagementRoutes = require('./dashboard/debtManagementRoutes');
const orderLifecycleRoutes = require('./shipment/orderLifecycleRoutes');
const { createBotLifecycleIntegrationRouter, findKiotIdentity } = require('./shipment/botLifecycleIntegrationRoutes');
const orderLifecycleService = require('./shipment/orderLifecycleService');
const pickAssignmentsRoutes = require('./pickAssignments/pickAssignmentsRoutes');
const stockPositionsRoutes = require('./stockPositions/stockPositionsRoutes');
const cashbookRoutes = require('./cashbook/cashbookRoutes');
const { createVatDraftRouter } = require('./vatDraft/vatDraftRoutes');
const { createVatRequestRouter } = require('./vatRequests/routes');
const { createVatLookupRouter } = require('./vatLookup/vatLookupRoutes');
const { createBusinessReportRouter } = require('./businessReport/businessReportRoutes');
const { createExpectedArrivalsRouter } = require('./productContainers/expectedRoutes');
const { createPriceAuditRouter } = require('./invoicePriceAudit/priceAuditRoutes');
const { createApprovedPriceRouter } = require('./invoicePriceAudit/approvedPriceRoutes');
const { createMarketingReportRouter } = require('./marketingReport/marketingReportRoutes');
const { createUserTablePrefsRouter } = require('./userTablePrefs/routes');
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
// Bot lai xe dung token rieng, chi doc cac cot doi chieu vong doi don. Route
// nay phai nam truoc guard JWT chung vi bot khong co phien dang nhap website.
router.use('/api/integrations/driver-orders', createBotLifecycleIntegrationRouter({
  token: CONFIG.BOT_LIFECYCLE_API_TOKEN,
  findOrder: (code, branch) => findKiotIdentity(code, branch, require('./shipment/kiotOrdersRepository').kiotOrders)
}));
router.use(createManagerLeaveWebhook({
  enabled: !!managerLeaveRuntime,
  secret: CONFIG.HR_MANAGER_TELEGRAM_WEBHOOK_SECRET,
  store: managerLeaveRuntime && managerLeaveRuntime.store,
  acknowledge: update => managerLeaveRuntime.acknowledgeUpdate(update),
  wake: () => managerLeaveRuntime.drain()
}));

router.use(createManagerLeaveMiniApp({enabled:!!managerLeaveRuntime,token:CONFIG.HR_MANAGER_TELEGRAM_BOT_TOKEN,getManager:id=>managerLeaveRuntime.getManager(id)}));

// /api/auth/* mount truoc — POST /login va POST /logout khong doi hoi da dang
// nhap (do chinh la noi de dang nhap); GET /me tu bao ve bang requireAuth ben trong.
router.use(authRoutes);
router.use(adminUserRoutes);

// Xem/doi co so dang lam viec — /api/branch. KHONG gan resolveBranch o day:
// chinh hai route nay quyet dinh gia tri cookie ma resolveBranch se doc.
router.use(branchRoutes);
// VT Hà Nội / VT Sài Gòn (module Vị trí hàng duy nhất, sửa trực tiếp + import): quyền stockLocationsV2.*.
router.use(stockPositionsRoutes);
// Sổ quỹ toàn công ty: không áp cookie hoặc middleware chọn cơ sở.
router.use('/api/cashbook', cashbookRoutes);
// Kế toán – Nháp VAT (port vat-draft-app): chứng từ theo cookie cơ sở, gắn resolveBranch trong router.
router.use('/api/vat-draft', createVatDraftRouter());
// Kế toán – ORDER VAT (thay sheet ORDER VAT 1): toàn công ty, không áp cookie cơ sở (gợi ý khách tự gắn resolveBranch).
router.use('/api/vat-requests', createVatRequestRouter());
// Kế toán – Tra cứu VAT (thay app Apps Script): đọc 3 tab Sheet công khai, toàn công ty, không áp cookie cơ sở.
router.use('/api/vat-lookup', createVatLookupRouter());
// Báo cáo kinh doanh (tăng trưởng Sale/Khách/Mã hàng): gộp HN + SG, cũng không áp cookie cơ sở.
router.use('/api/business-report', createBusinessReportRouter());
// Bang "Du kien hang ve" (tab Hang hoa): quyen rieng reports.products.expected, KHONG di qua guard /api/product-report.
router.use('/api/expected-arrivals', createExpectedArrivalsRouter());
// Kiem tra gia ban (tab Hoa don): quyen rieng reports.invoices.priceAudit(.explain/.decide); co so theo cookie gan trong router.
router.use('/api/invoice-price-audit', createPriceAuditRouter());
router.use('/api/invoice-approved-prices', createApprovedPriceRouter());
router.use('/api/marketing-report', createMarketingReportRouter());
router.use('/api/me/table-prefs', createUserTablePrefsRouter());

// Toan bo /api/hr/* la du lieu THEO CO SO — gan resolveBranch truoc router con.
router.use('/api/hr', requireAuth, resolveBranch);

// Cac endpoint quan ly nhan su (nghi phep) — /api/hr/* — phan quyen rieng
// tung route ben trong hrLeaveRoutes.js (xem het ho so vs chi Quan ly duyet).
router.use(hrLeaveRoutes);

// Tai lieu "Quy dinh cong ty" (PDF Quan ly tai len) — /api/hr/rules/documents*,
// phan quyen rieng tung route (hr.rules xem, hr.rules.manage tai len/go).
router.use(hrRuleDocumentRoutes);

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
// Chi dinh vi tri hang cho don (giu cho / in phieu nhat / xac nhan, huy nhat): quyen shipment.pick (mac dinh chi Quan ly).
router.use('/api/shipment/pick', pickAssignmentsRoutes);

// Toan bo API "Bao cao tong hop" ben duoi day duoc gac bang QUYEN TINH NANG
// (server/auth/featureRegistry.js), khong con bang mang vai tro. Mac dinh chi
// Quan ly + Tro ly co cac quyen reports.*, nhung Quan ly co the cap/thu tung
// quyen cho tung tai khoan tai /account/#users. Day la ranh gioi bao mat that
// su; shared-nav.js chi dung menu tu danh sach quyen server tra ve.
// Khach chi duoc dung route tra cuu vong doi don hang o tren. Trang tra cuu
// cong khai cho khach hang (Phase 1) se nam o route rieng, KHONG qua requireAuth.
const reportsUser = (...features) => [requireAuth, requireFeature(...features), resolveBranch];
// /api/dashboard phuc vu CA 4 tab bao cao nen chi doi hoi "co it nhat mot
// quyen reports.*"; phan du lieu cua tung tab duoc cat bot sau do
// (dashboardPermissionFilter.js). Cac endpoint rieng cua tung tab thi doi hoi
// dung quyen cua tab do.
router.use('/api/debug', ...reportsUser(...REPORT_VIEW_FEATURES));
router.use('/api/dashboard', ...reportsUser(...REPORT_VIEW_FEATURES));
// Bao cao doanh thu theo khach nam o dau tab Khach hang (chuyen tu Tong quan 2026-10-16) nen 2 API CHI DOC
// goi y khach / doanh thu theo khach mo theo quyen Khach hang (reports.business). Bao cao hang hoa
// (/api/product-report) nam o tab Hang hoa nen chi doi reports.products; phan ghi/nang (quet dut hang,
// nhap Tra NCC) duoi '/api/products' cung chi reports.products.
router.use('/api/customer-suggest', ...reportsUser('reports.business'));
router.use('/api/customer-product-revenue', ...reportsUser('reports.business'));
router.use('/api/product-report', startTiming, ...reportsUser('reports.products'), markTiming('auth'));
router.use('/api/inventory-value-history', ...reportsUser('reports.overview'));
router.use('/api/invoice-detail', startTiming, ...reportsUser('reports.invoices'), markTiming('auth'));
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

// Doc bo loc thoi gian rieng cho 1 tab tu query string, vd prefix "in" doc
// inMode/inDays/inFrom/inTo. legacyDays la fallback cho tham so "days" cu (khi
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

// ?view=<tab> (overview|products|invoices|debt, co the nhieu
// tab cach nhau dau phay): CHI doc/tinh/tra phan cua tab do — trang bao cao goi
// khi nguoi dung mo tung tab (xem dashboardViews.js). Bo trong = ca 4 tab nhu
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
      // (Bo loc `ov*` cua Tong quan da bo 2026-10-05: tab Tong quan dung bo loc `in*`.)
      // (2026-10-16: bo cac bo loc `pr`/`np`/`ni` cung tab Hang hoa cu; tham so cu bi bo qua.)
      invoices: parseFilterSpec(req.query, 'in', legacyDays)
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

// Goi y ten/ma khach hang cho o tim kiem "Bao cao doanh thu theo khach" (tab
// Tong quan) — nguon rieng, NHE (chi bang "customers"), khong dung cache
// 9-tab dashboard de khong bi cham theo cac tab khac.
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
    // Don gia HN/SG + Gia tri co ban HN/SG chi Quan ly + Tro ly (reports.products.price): tai khoan khac khong nhan
    // cac truong nay (PRODUCT_REPORT_PRICE_KEYS) trong payload. Dong cua bo doc la cache dung chung nen tao ban sao,
    // khong xoa truong tren dong goc.
    const hiddenKeys = [
      ...(hasFeature(req.user, 'reports.products.price') ? [] : PRODUCT_REPORT_PRICE_KEYS),
      ...(hasFeature(req.user, 'reports.products.sales') ? [] : PRODUCT_REPORT_SALES_KEYS)
    ];
    if (hiddenKeys.length) {
      data.rows = data.rows.map((row) => {
        const copy = { ...row };
        hiddenKeys.forEach((key) => { delete copy[key]; });
        return copy;
      });
    }
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

router.get('/api/product-report/containers/meta', async (req, res) => {
  try {
    // reportVersion: phien ban bao cao hang hoa (chi tang khi du lieu that su doi, migration 0055); client so
    // voi phien ban da tai de quyet dinh co tai lai ca bang khong. null = chua co che do tang dan.
    const meta = await containerRepository.getContainerMeta();
    res.status(200).json({ ...meta, reportVersion: await getProductReportVersion() });
  } catch {
    res.status(503).json({ error: 'Không lấy được trạng thái cập nhật CONT.' });
  }
});

router.get('/api/product-report/containers', async (req, res) => {
  try {
    const data = await containerRepository.getContainerDetails({
      code: req.query.code,
      fullAccess: hasFeature(req.user, 'reports.overview.containers.full')
    });
    res.status(200).json(data);
  } catch (error) {
    const status = [400,404,503].includes(error.statusCode) ? error.statusCode : 503;
    res.status(status).json({
      error: error.statusCode ? error.message : 'Không lấy được dữ liệu Hàng dự kiến.',
      ...(error.code && error.statusCode ? { code:error.code } : {}),
      ...(error.containerSync ? { containerSync:error.containerSync } : {})
    });
  }
});

// Khung "Chi tiet" cua bang "Bao cao hang hoa": doanh so 90 ngay tung khach theo 1 ma hang.
// Nam duoi /api/product-report nen ke thua guard `reports.products` o tren.
router.get('/api/product-report/customers', requireFeature('reports.products.sales'), async (req, res) => {
  try {
    const data = await getProductReportCustomers({ code: req.query.code });
    res.status(200).json(data);
  } catch (err) {
    console.error('=== LOI /api/product-report/customers ===');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
    console.error('==========================================');
    res.status(err.statusCode || 500).json({
      error: err.statusCode && err.statusCode < 500 ? err.message : 'Không lấy được doanh số khách theo mã hàng.',
      detail: err.message,
      code: err.code
    });
  }
});

// Bieu do cot "Gia tri ton kho theo ngay" (tab Tong quan, muc 1 Xu huong): ban chup 23:59 hang
// ngay cua tung co so (bang inventory_value_snapshots), loc theo co so dang xem va ?from=&to=.
router.get('/api/inventory-value-history', async (req, res) => {
  try {
    const branchCodes = resolveBranchScope(req.branch).map(branchLabelToCode);
    const data = await getInventoryValueHistory({ branchCodes, from: req.query.from, to: req.query.to });
    res.status(200).json(data);
  } catch (err) {
    console.error('=== LOI /api/inventory-value-history ===');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
    console.error('=========================================');
    res.status(err.statusCode || 500).json({
      error: err.statusCode && err.statusCode < 500 ? err.message : 'Không lấy được lịch sử giá trị tồn kho.',
      detail: err.message,
      code: err.code
    });
  }
});

// Hop chi tiet khi bam 1 dong bang "Chi tiet giao dich" (tab Hoa don).
// Ma chung tu chi duy nhat trong 1 co so nen can ?branch=<nhan co so>; o che do 1 co so
// co the bo trong. Co so phai nam trong pham vi dang xem cua nguoi dung.
function resolveDocumentBranchCode(req) {
  const scope = resolveBranchScope(req.branch);
  const requested = typeof req.query.branch === 'string' ? req.query.branch.trim() : '';
  const label = requested || (scope.length === 1 ? scope[0] : '');
  if (!label) {
    const error = new Error('Thiếu cơ sở của chứng từ.');
    error.statusCode = 400;
    throw error;
  }
  if (!scope.includes(label)) {
    const error = new Error('Cơ sở không nằm trong phạm vi đang xem.');
    error.statusCode = 400;
    throw error;
  }
  return branchLabelToCode(label);
}

function documentDetailHandler(loader, logName, fallbackMessage) {
  return async (req, res) => {
    try {
      const data = await loader({ code: req.query.code, branchCode: resolveDocumentBranchCode(req) });
      res.status(200).json(data);
    } catch (err) {
      console.error(`=== LOI ${logName} ===`);
      console.error('Message:', err.message);
      console.error('Stack:', err.stack);
      console.error('==============================');
      res.status(err.statusCode || 500).json({
        error: err.statusCode && err.statusCode < 500 ? err.message : fallbackMessage,
        detail: err.message,
        code: err.code
      });
    }
  };
}

// (2026-10-01: /api/order-detail va /api/return-detail da bo cung 2 bang Dat hang / Tra hang cua tab
// Hoa don. Chi tiet dong hang don Phieu tam nay o /api/shipment/lifecycle/order-detail.)
router.get('/api/invoice-detail', documentDetailHandler(getInvoiceDetail, '/api/invoice-detail', 'Không lấy được chi tiết hóa đơn.'));

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
    const metadata = await getExportFields(req.body || {}, req.branch, { canViewPrice: hasFeature(req.user, 'reports.products.price'), canViewSales: hasFeature(req.user, 'reports.products.sales') });
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
    const file = await createExport(req.body || {}, req.branch, {
      signal: abortController.signal,
      // Cột Đơn giá HN/SG của Báo cáo hàng hóa chỉ xuất cho tài khoản có quyền xem giá (cùng quyền với GET /api/product-report).
      canViewPrice: hasFeature(req.user, 'reports.products.price'),
      canViewSales: hasFeature(req.user, 'reports.products.sales')
    });
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
