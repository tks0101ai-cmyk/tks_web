const path = require('path');
const express = require('express');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const CONFIG = require('./config');
const routes = require('./routes');
const localUserStore = require('./auth/localUserStore');
// Nap scheduler ngay ca khi job chay o worker: module dang ky listener xoa cache web
// (customersChanged, debtScheduleChanged) va nut "Tinh lai cong no" dung syncCustomers.
require('./kiotvietSync/scheduler');
const { startBackgroundJobs } = require('./jobs');
const { prewarmDashboardCaches } = require('./dashboard/dashboardData');
const { captureWebhookRawBody, webhookJsonErrorHandler } = require('./kiotviet/kiotvietWebhookRoutes');
const { pageGuard, legacyPageRedirect } = require('./auth/pageGuard');
const { createLeaveDbRealtime } = require('./hr/hrLeaveDbRealtime');
const { getConfiguredManagerLeaveRuntime } = require('./telegram/managerLeaveRuntime');
const { startSpecialDayNotifySchedule } = require('./notifications/specialDayNotifier');
const { startLeaveBellSchedule } = require('./hr/hrLeaveBellNotifier');
const { startSaleNotifySchedule } = require('./vatRequests/saleNotifier');
const { ensureHrInsuranceSchema } = require('./db/ensureHrInsuranceSchema');

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled rejection at:', promise, 'reason:', reason);
});

const app = express();

// App chay sau reverse proxy (Render, co the co
// Cloudflare phia truoc) — khong set trust proxy thi req.ip luon la IP cua
// proxy (giong het nhau cho MOI request), khien rate-limit theo IP trong
// authRoutes.js (forgotPasswordRateLimit) gop chung toan bo nguoi dung vao
// 1 bucket va khoa nham ca site chi sau vai chuc request.
app.set('trust proxy', 1);

app.use(compression());
// Mac dinh express.json() gioi han 100kb — khong du cho payload xuat Excel
// ket qua kiem tra dut hang (hang tram dong, moi dong kem chi tiet cac dot dut hang).
app.use(express.json({ limit: '10mb', verify: captureWebhookRawBody }));
// KiotViet cannot benefit from retrying permanently malformed JSON. Acknowledge
// it and let the raw-event queue preserve the body for later inspection.
app.use(webhookJsonErrorHandler);
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// Ngan Cloudflare/Render cache response API — du lieu bao cao phai luon lay tu
// Google Sheets moi nhat, khong duoc phep tra ban cache cu tu edge/CDN.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// API + auth routes TRUOC static (tranh express.static chop mat /api/*)
app.use(routes);

// Chan mo TRANG HTML noi bo ngay o server (xem server/auth/pageGuard.js) —
// dat TRUOC ca route /reports lan express.static de bookmark/tab cu khong con
// tai duoc trang ma tai khoan khong co quyen. Tai nguyen tinh (/shared/*,
// /js/*, /vendor/*) va trang dang nhap/dang ky khong bi anh huong.
// Link/bookmark cu cua cac trang da go chuyen sang trang thay the (vd /stock-locations -> /vt-positions/); trang dich van qua pageGuard.
app.use(legacyPageRedirect);
app.use(pageGuard);

// "/reports" la duong dan tuong duong "tab lon" cua trang bao cao tong hop
// (public/index.html o thu muc goc), de khop pattern URL "tab lon/#tab nho"
// giong /shipment/lifecycle/, /humanresources/, /account/ — khong doi ten/vi
// tri file de tranh vo cac test doc truc tiep public/index.html.
app.get(['/reports', '/reports/'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Static files (html, css, js, images...)
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.includes(`${path.sep}vendor${path.sep}`)) {
      // Vendor lib (chart.umd.min.js, three.min.js) hiem khi doi thu cong
      res.setHeader('Cache-Control', 'public, max-age=86400'); // 1 ngay
    } else if (/\.(js|css)$/.test(filePath) && res.req.query.v) {
      // URL co ?v= -> cho trinh duyet + Cloudflare edge giu 1 gio, khoi hoi lai
      // origin moi lan chuyen trang.
      // ponytail: 1 gio vi ?v= tang tay va tung bi quen (cdddb2f); doi sang
      // immutable 1 nam khi ?v= duoc sinh tu dong theo hash noi dung file.
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (/\.(js|css)$/.test(filePath)) {
      // /shared/*, /js/* — luon revalidate de cap nhat UI tuc thi khi sua code
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (/\.jfif$/i.test(filePath)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else if (/\.(png|jpg|jpeg|svg|webp|ico)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 ngay
    }
    // HTML: khong set — giu mac dinh (ETag revalidate), vi day la entry point
    // can luon lay ban moi nhat khi co deploy.
  }
}));

// ── 404 handlers ─────────────────────────────────────────────────────────────
// Phai dat SAU routes va static de chi bat nhung request khong khop gi ca.

// [1] /api/* — tra ve JSON 404 (khong bao gio tra HTML cho API client)
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'Endpoint không tồn tại.',
    path: req.originalUrl,
    status: 404
  });
});

// [2] Tat ca route con lai — tra ve trang 404.html voi HTTP status 404
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// ── Global Error Handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Express Error]', err);
  if (res.headersSent) {
    return next(err);
  }
  const status = err.status || err.statusCode || 500;
  if (req.originalUrl && req.originalUrl.startsWith('/api')) {
    return res.status(status).json({
      error: err.message || 'Lỗi máy chủ nội bộ.',
      status
    });
  }
  res.status(status).send(`<h1>${status} Error</h1><p>${err.message || 'Internal Server Error'}</p>`);
});
// ─────────────────────────────────────────────────────────────────────────────

// Khoi dong bat dong bo: dam bao 2 tai khoan Admin mac dinh ton tai trong
// Postgres (nguon luu tru BEN VUNG — xem localUserStore.js) TRUOC khi bat dau
// nhan request. Ten ham hydrateFromSheets() giu nguyen vi ly do lich su
// (truoc day nap tu Google Sheets) — nay chi con lam nong cache + tao lai
// admin mac dinh neu thieu. Bi loi (mat ket noi Postgres) van fail-soft,
// khong chan server khoi dong.
async function startServer() {
  // The HR write path requires insurance_number. Apply only this additive
  // migration before accepting requests; do not run other pending migrations.
  if (CONFIG.SUPABASE_DB_URL) await ensureHrInsuranceSchema();
  localUserStore.initStore();
  await localUserStore.hydrateFromSheets().catch((err) => {
    console.error('[Users] Lỗi không mong đợi khi khởi tạo tài khoản Admin mặc định:', err.message);
  });

  app.listen(CONFIG.PORT, () => {
    console.log(`TOKOSI dashboard server dang chay tren port ${CONFIG.PORT}`);

    if (CONFIG.HR_LEAVE_DB_REALTIME_ENABLED) createLeaveDbRealtime().start();
    const managerLeaveRuntime = getConfiguredManagerLeaveRuntime();
    if (managerLeaveRuntime) managerLeaveRuntime.start();

    // Ngay le / sinh nhat -> chuong thong bao. Khong nam trong startPollingScheduler vi
    // scheduler do tat khi khong bat KiotViet.
    if (CONFIG.SPECIAL_DAYS_NOTIFY_ENABLED) startSpecialDayNotifySchedule();
    // Job bao sale chay o web (ke ca khi BACKGROUND_JOBS=worker); chuong luu o bang Postgres `notifications` (0093).
    if (CONFIG.VAT_REQUEST_NOTIFY_ENABLED) startSaleNotifySchedule();
    // Don nghi phep tu bot Telegram (ghi thang vao DB) -> chuong cho nguoi duyet.
    if (CONFIG.HR_LEAVE_BELL_NOTIFY_ENABLED) startLeaveBellSchedule();

    if (CONFIG.MEMORY_MONITOR) {
      const memoryMonitor = require('./lib/memoryMonitor').startMemoryMonitor({
        intervalMs: CONFIG.MEMORY_LOG_INTERVAL_MS,
        limitMb: CONFIG.MEMORY_LIMIT_MB
      });
      process.once('SIGTERM', () => memoryMonitor.stop());
      process.once('SIGINT', () => memoryMonitor.stop());
    }

    if (CONFIG.BACKGROUND_JOBS === 'worker') {
      // Job chay o worker.js: chi nghe su kien doi du lieu de xoa cache / day SSE.
      const { Client } = require('pg');
      const { listenToPostgres } = require('./kiotvietSync/dashboardRollupEvents');
      const listener = listenToPostgres(() => new Client({
        connectionString: CONFIG.SUPABASE_DB_URL,
        keepAlive: true,
        ssl: CONFIG.PGSSL ? { rejectUnauthorized: false } : false
      }));
      process.once('SIGTERM', () => listener.stop());
      process.once('SIGINT', () => listener.stop());
    } else {
      startBackgroundJobs();
    }

    // Nap san cache dashboard ngay sau khi server san sang nhan request, KHONG
    // await de khong chan callback nay — chay nen, nguoi dung dau tien van
    // duoc phuc vu ngay (co the cho DB neu prewarm chua xong), chi la khong
    // phai la nguoi kich hoat lan doc 7 tab dau tien. Tat bang
    // DASHBOARD_PREWARM=false (vd moi truong dev khong can).
    if (CONFIG.DASHBOARD_PREWARM) {
      prewarmDashboardCaches({ log: console.log }).catch((err) => {
        console.error('[Dashboard] Prewarm that bai:', err.message);
      });
    }
  });
}

startServer().catch(async (error) => {
  console.error('[Startup] HR insurance migration failed; server will not accept requests:', error);
  try { await require('./db/pool').getPool().end(); } catch (_) {}
  process.exitCode = 1;
});
