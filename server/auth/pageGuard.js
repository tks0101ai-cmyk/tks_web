// ==========================================
// PAGE GUARD — chan mo TRANG HTML noi bo ngay o server.
//
// Truoc day moi trang duoi server/public/ deu tai duoc cong khai; viec chan
// hoan toan do shared-nav.js authGuard lam sau khi trang da tai (bookmark/tab
// cu van mo duoc, chi bi JS day di sau). Middleware nay dung CHUNG bang
// PAGE_FEATURES voi client (featureRegistry.js) de chan that:
//   - chua dang nhap            -> 302 /login/?next=<duong dan>
//   - thieu quyen cho trang do  -> 302 toi trang dau tien tai khoan vao duoc
//
// FAIL-SOFT co chu y: loi DB/HR (5xx) thi CHO QUA — shared-nav.js authGuard
// van la lop thu hai. Mot su co Postgres khong duoc lam chet ca site.
// ==========================================
'use strict';

const { verifyToken } = require('./authService');
const localUserStore = require('./localUserStore');
const effectiveUserResolver = require('./effectiveUserResolver');
const featureRegistry = require('./featureRegistry');

const AUTH_COOKIE_NAME = 'tks_auth';

// Duong dan KHONG BAO GIO bi chan: trang dang nhap/dang ky, tai nguyen tinh,
// API (da co requireFeature rieng) va trang 404.
const PUBLIC_PREFIXES = Object.freeze([
  '/api/',
  '/login',
  '/register',
  '/shared/',
  '/js/',
  '/vendor/',
  '/health'
]);
const PUBLIC_EXACT = Object.freeze(['/404.html', '/favicon.ico']);

/**
 * Chi gac cac request DIEU HUONG (mo mot trang), khong gac tai nguyen:
 * duong dan khong co phan mo rong, hoac ket thuc bang .html.
 */
function isPageRequest(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = String(req.path || '');
  if (PUBLIC_EXACT.includes(pathname)) return false;
  if (PUBLIC_PREFIXES.some(prefix => pathname === prefix.replace(/\/$/, '') || pathname.startsWith(prefix))) return false;
  const lastSegment = pathname.split('/').pop() || '';
  if (!lastSegment) return true;               // thu muc, vd '/account/'
  if (lastSegment.endsWith('.html')) return true;
  return !lastSegment.includes('.');           // '/reports' — khong co phan mo rong
}

// Trang CU da go -> trang thay the. Chi chuyen huong chinh trang HTML (khong chuyen tai nguyen tinh: tra 404 dung hon tra HTML cho
// <script>). Phan #fragment trinh duyet tu giu. Dat TRUOC pageGuard: trang cu khong con quy tac quyen nen pageGuard se bo qua no.
// 302 (khong 301) de trinh duyet khong ghi nho vinh vien neu sau nay doi duong dan.
//   /stock-locations (module Vi tri hang doc Google Sheets, go 2026-10-30) -> /vt-positions/ (VT Ha Noi / VT Sai Gon)
const LEGACY_PAGE_REDIRECTS = Object.freeze([
  { from: '/stock-locations', to: '/vt-positions/' }
]);

function legacyPageRedirect(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const pathname = String(req.path || '').toLowerCase().replace(/\/index\.html$/, '').replace(/\/+$/, '');
  const rule = LEGACY_PAGE_REDIRECTS.find(item => item.from === pathname);
  if (!rule) return next();
  res.setHeader('Cache-Control', 'no-store');
  return res.redirect(302, rule.to);
}

function createPageGuard(dependencies = {}) {
  const verify = dependencies.verifyToken || verifyToken;
  const findUserById = dependencies.findUserById || localUserStore.getUserById;
  const resolveUser = dependencies.resolveUser || effectiveUserResolver.resolveUser;

  return async function pageGuard(req, res, next) {
    if (!isPageRequest(req)) return next();

    const rule = featureRegistry.pageRuleFor(req.path);
    if (!rule) return next();

    // Trang duoc bao ve khong duoc nam trong cache CDN/proxy: hai tai khoan
    // khac quyen se nhan cung mot ban.
    res.setHeader('Cache-Control', 'no-store');

    const redirectToLogin = () => {
      const next = encodeURIComponent(req.originalUrl || req.path);
      res.redirect(302, `/login/?next=${next}`);
    };

    const token = req.cookies && req.cookies[AUTH_COOKIE_NAME];
    if (!token) return redirectToLogin();

    let tokenUser;
    try {
      tokenUser = verify(token);
    } catch (err) {
      return redirectToLogin();
    }

    let user;
    try {
      const storedUser = await findUserById(tokenUser.id);
      if (!storedUser) return redirectToLogin();
      user = await resolveUser(storedUser);
    } catch (err) {
      if (err && err.statusCode && err.statusCode < 500) {
        // Tai khoan bi khoa / da bi go khoi Danh sach nhan su: de trang tu tai
        // roi shared-nav.js hien thong bao loi cu the tu /api/auth/me.
        return next();
      }
      console.error('[PageGuard] Bo qua vi khong doi chieu duoc quyen:', err.message);
      return next();
    }

    if (user.trangThai === localUserStore.LOCKED_STATUS) return next();

    const permissions = featureRegistry.resolvePermissions(user);
    if (featureRegistry.permissionsHave(permissions, ...rule.anyOf)) return next();

    return res.redirect(302, featureRegistry.landingPathFor(permissions));
  };
}

module.exports = {
  AUTH_COOKIE_NAME,
  PUBLIC_PREFIXES,
  PUBLIC_EXACT,
  isPageRequest,
  LEGACY_PAGE_REDIRECTS,
  legacyPageRedirect,
  createPageGuard,
  pageGuard: createPageGuard()
};
