'use strict';

// API Bao cao kinh doanh (/api/business-report): tang truong Sale / Khach / Ma hang theo
// thang, gop HN + SG (khong theo co so dang chon nen khong dung reportsUser/resolveBranch).

const express = require('express');
const multer = require('multer');
const { requireAuth, requireFeature } = require('../auth/authMiddleware');
const { hasFeature } = require('../auth/featureRegistry');
const { createRepository } = require('./businessReportRepository');
const svc = require('./businessReportService');
const { createExportFile, filterRows, sortRowsByLabel, exportFieldsFor, resolveColumnKeys } = require('./businessReportExport');
const { nameKey, RETAIL_NAME, UNGROUPED_SALE, vnToday, PRICE_LEVEL_LABELS } = require('./businessMonths');
const { createCustomerPriceLevelRepository } = require('./customerPriceLevelRepository');
const { createCustomerProfileRepository } = require('./customerProfileRepository');
const rules = require('./customerProfileRules');

const BUILDERS = { sales: svc.buildSaleReport, customers: svc.buildCustomerReport, products: svc.buildProductReport };
const CUSTOMER_NOTES = 'reports.business.customerNotes';
const CUSTOMER_MANAGE = 'reports.business.customerManage';
const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;

// customerProfiles: ghi chu / thong tin theo khach (migration 0080); now: gio hien tai (test dong bang ngay VN).
function createBusinessReportRouter({ repository = createRepository(), customerProfiles = createCustomerProfileRepository(),
  customerPriceLevels = createCustomerPriceLevelRepository(), now = () => new Date() } = {}) {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const view = [requireAuth, requireFeature('reports.business')];
  const kindPermission = (req, res, next) => requireFeature(
    req.query.kind === 'products' || req.query.kind === 'product' ? 'reports.products.growth' : 'reports.business'
  )(req, res, next);
  const sendError = (req, res, e) => {
    // 503 MIGRATION_PENDING: ghi chu khach chua co bang (deploy code truoc migration 0080).
    if (e.statusCode && (e.statusCode < 500 || e.code === 'MIGRATION_PENDING')) return res.status(e.statusCode).json({ error: e.message, code: e.code });
    console.error(`[business-report ${req.method} ${req.path}]`, e);
    return res.status(500).json({ error: 'Lỗi hệ thống, vui lòng thử lại sau.', code: 'BUSINESS_REPORT_ERROR' });
  };
  const handle = fn => async (req, res) => {
    try { await fn(req, res); } catch (e) { return sendError(req, res, e); }
  };

  for (const kind of Object.keys(BUILDERS)) {
    router.get(`/${kind}`, requireAuth, requireFeature(kind === 'products' ? 'reports.products.growth' : 'reports.business'), handle(async (req, res) => {
      const report = BUILDERS[kind](await repository.snapshot());
      res.json(kind === 'customers' ? await enrichCustomers(req, report) : report);
    }));
  }

  router.get('/overview', ...view, handle(async (req, res) => res.json(svc.buildOverview(await repository.snapshot()))));

  router.get('/detail', requireAuth, kindPermission, handle(async (req, res) => {
    const kind = String(req.query.kind || '');
    const key = String(req.query.key || '');
    const snap = await repository.snapshot();
    // Dung truoc (extra rong) de bao 404/400 som, khong truy van top hang/khach cho key khong ton tai.
    const detail = svc.buildDetail(kind, key, snap, {});
    const months = svc.last4Months(snap);
    if (kind === 'customer') {
      const levels = await customerPriceLevels.getLevels([detail.customer.key]);
      detail.customer.priceLevel = PRICE_LEVEL_LABELS[levels[detail.customer.key].level];
      // Khach da gop theo ten: top ma hang cong don tren moi ho so (co so, ma KH) cua khach.
      const byProduct = new Map();
      for (const ref of detail.customer.refs) {
        for (const r of await repository.customerProducts({ branch: ref.branch, customerCode: ref.code, months })) {
          const t = byProduct.get(r.productCode) || { productCode: r.productCode, productName: r.productName, revenue: 0, qty: 0 };
          t.revenue += Number(r.revenue) || 0;
          t.qty += Number(r.qty) || 0;
          if (r.productName) t.productName = r.productName;
          byProduct.set(r.productCode, t);
        }
      }
      detail.topProducts = [...byProduct.values()].sort((x, y) => y.revenue - x.revenue).slice(0, 50);
    } else if (kind === 'product') {
      // Top khach cua ma hang: gop theo ten khach (HN + SG), khong con co so / ma KH.
      const names = new Map(snap.directory.map(d => [`${d.branch}:${d.code}`, d.name]));
      const byName = new Map();
      for (const r of await repository.productCustomers({ productCode: key, months })) {
        const name = (r.customerCode && names.get(`${r.branch}:${r.customerCode}`)) || r.customerName || r.customerCode || RETAIL_NAME;
        const k = nameKey(name) || nameKey(RETAIL_NAME);
        const t = byName.get(k) || { customerName: name, revenue: 0, qty: 0 };
        t.revenue += Number(r.revenue) || 0;
        t.qty += Number(r.qty) || 0;
        byName.set(k, t);
      }
      detail.topCustomers = [...byName.values()].sort((x, y) => y.revenue - x.revenue).slice(0, 50);
    }
    res.json(detail);
  }));

  router.post('/refreeze', requireAuth, requireFeature('reports.business.refreeze'), express.json(),
    handle(async (req, res) => res.json(await repository.refreeze(req.body && req.body.month))));

  // Doi team cua 1 sale (dropdown cot Team bang Tang truong Sale). team rong / 'Chua co team' = bo khoi team.
  router.put('/sale-team', requireAuth, requireFeature('reports.business.editTeam'), express.json(), handle(async (req, res) => {
    const body = req.body || {};
    const saleName = String(body.saleName == null ? '' : body.saleName).trim();
    const teamName = String(body.teamName == null ? '' : body.teamName).trim().replace(/\s+/g, ' ');
    const bad = message => { const e = new Error(message); e.statusCode = 400; e.code = 'INVALID_SALE_TEAM'; return e; };
    if (!saleName || saleName === UNGROUPED_SALE) throw bad('Sale không hợp lệ.');
    if (teamName.length > 60) throw bad('Tên team tối đa 60 ký tự.');
    // Chi nhan sale dang co trong bang (khong de ghi khoa tuy y vao sale_teams).
    const known = svc.buildSaleReport(await repository.snapshot()).rows.some(r => r.key === saleName);
    if (!known) { const e = new Error('Không tìm thấy sale này.'); e.statusCode = 404; throw e; }
    res.json(await repository.setSaleTeam(saleName, teamName));
  }));

  // ---- Ghi chu / thong tin theo khach (bang "Doanh so theo khach", migration 0080) ----
  const customerView = [requireAuth, requireFeature(CUSTOMER_NOTES)];
  const customerManage = [requireAuth, requireFeature(CUSTOMER_NOTES), requireFeature(CUSTOMER_MANAGE)];
  const jsonBody = express.json({ limit: '64kb' });
  const fail = (statusCode, code, message) => rules.httpError(statusCode, code, message);
  const actorOf = user => ({ id: user && user.id !== undefined && user.id !== null ? user.id : null, name: (user && (user.hoTen || user.username)) || '' });

  // key phai la 1 khach co trong bang bao cao (cung tra cuu voi /detail); tra ten hien thi.
  async function customerOf(rawKey) {
    const key = String(rawKey == null ? '' : rawKey);
    if (!key) throw fail(400, 'INVALID_CUSTOMER_KEY', 'Thiếu khách hàng.');
    const row = svc.buildCustomerReport(await repository.snapshot()).rows.find(r => r.key === key);
    if (!row) throw fail(404, 'CUSTOMER_NOT_FOUND', 'Không tìm thấy khách hàng này.');
    return { key, name: row.name };
  }
  // Quyen sua hieu luc = customerManage HOAC (customerNotes VA nam trong customer_editors cua khach nay).
  async function accessOf(req, key) {
    const canManage = hasFeature(req.user, CUSTOMER_MANAGE);
    const canEdit = canManage || (hasFeature(req.user, CUSTOMER_NOTES) && await customerProfiles.isEditor(key, req.user && req.user.id));
    return { canManage, canEdit: !!canEdit };
  }
  async function editableCustomer(req, rawKey) {
    const customer = await customerOf(rawKey);
    if (!(await accessOf(req, customer.key)).canEdit) throw fail(403, 'CUSTOMER_EDIT_FORBIDDEN', 'Bạn không có quyền sửa thông tin khách hàng này.');
    return customer;
  }
  const noteView = (note, canEdit, today) => ({ ...note, editable: canEdit && note.noteDate === today });

  // Revenue is cached, editable metadata is fresh. Batch reads avoid per-row queries.
  async function enrichCustomers(req, report, exporting = false) {
    const keys = report.rows.map(r => r.key);
    const levels = await customerPriceLevels.getLevels(keys);
    const canView = hasFeature(req.user, CUSTOMER_NOTES);
    const profiles = canView ? await customerProfiles.getReportProfiles(keys) : {};
    return { ...report, withLastVisit: canView, withCustomerProfile: canView,
      rows: report.rows.map(row => {
        const meta = profiles[row.key] || {};
        const local = levels[row.key];
        const canEdit = canView && (hasFeature(req.user, CUSTOMER_MANAGE) ||
          (meta.editors || []).some(e => String(e.userId) === String(req.user.id)));
        const profile = !canView ? {} : exporting ? {
          ...meta, images:(meta.images || []).map(img => ({ ...img, url: new URL(img.url, `${req.protocol}://${req.get('host')}`).href }))
        } : { salesChannels:meta.salesChannels || [], warehouseScale:meta.warehouseScale || 'none' };
        return { ...row, ...profile, priceLevel:PRICE_LEVEL_LABELS[local.level],
          priceLevelVersion:local.version, canEditPriceLevel:canEdit,
          ...(canView ? { lastVisit:meta.lastVisit || (meta.visitDays || []).slice(-1)[0] || '' } : {}) };
      }) };
  }

  router.put('/customer-price-level', ...customerView, jsonBody, handle(async (req, res) => {
    const body = req.body || {};
    const customer = await editableCustomer(req, body.key);
    const saved = await customerPriceLevels.saveLevel(customer.key,body.level,body.version,actorOf(req.user));
    res.json({ priceLevel:PRICE_LEVEL_LABELS[saved.level],priceLevelVersion:saved.version });
  }));

  router.get('/customer-meta', ...customerView, handle(async (req, res) => {
    res.json({ customers: await customerProfiles.getMeta() });
  }));

  router.get('/customer-profile', ...customerView, handle(async (req, res) => {
    const customer = await customerOf(req.query.key);
    const [data, access] = await Promise.all([customerProfiles.getProfile(customer.key), accessOf(req, customer.key)]);
    const today = vnToday(now());
    res.json({
      key: customer.key, name: customer.name, today,
      canEdit: access.canEdit, canManage: access.canManage,
      profile: data.profile, images: data.images,
      notes: data.notes.map(n => noteView(n, access.canEdit, today)),
      visitDays: data.visitDays, lastVisit: data.lastVisit, editors: data.editors
    });
  }));

  router.put('/customer-profile', ...customerView, jsonBody, handle(async (req, res) => {
    const body = req.body || {};
    const customer = await editableCustomer(req, body.key);
    const input = rules.normalizeProfileInput(body);
    res.json({ profile: await customerProfiles.saveProfile(customer.key, customer.name, input, actorOf(req.user)) });
  }));

  router.put('/customer-profile/scale', ...customerManage, jsonBody, handle(async (req, res) => {
    const body = req.body || {};
    const customer = await customerOf(body.key);
    const scale = rules.normalizeScale(body.warehouseScale);
    const profile = await customerProfiles.saveScale(customer.key, customer.name, scale, actorOf(req.user));
    res.json({ warehouseScale: profile.warehouseScale });
  }));

  router.post('/customer-profile/notes', ...customerView, jsonBody, handle(async (req, res) => {
    const body = req.body || {};
    const customer = await editableCustomer(req, body.key);
    const text = rules.normalizeNoteBody(body.body);
    const note = await customerProfiles.createNote(customer.key, text, actorOf(req.user));
    res.status(201).json({ note: noteView(note, true, vnToday(now())) });
  }));

  router.put('/customer-profile/notes/:id', ...customerView, jsonBody, handle(async (req, res) => {
    const body = req.body || {};
    const customer = await editableCustomer(req, body.key);
    if (!rules.UUID_RE.test(String(req.params.id))) throw fail(404, 'NOTE_NOT_FOUND', 'Không tìm thấy note.');
    const text = rules.normalizeNoteBody(body.body);
    const note = await customerProfiles.updateNote(customer.key, req.params.id, text, actorOf(req.user));
    res.json({ note: noteView(note, true, vnToday(now())) });
  }));

  // Anh kho: kiem quyen (key tren query) TRUOC khi doc file de khong nhan 5MB cua nguoi khong co quyen.
  const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_UPLOAD_BYTES, files: 1, fields: 4 } });
  const guardImageEdit = async (req, res, next) => {
    try { req.customer = await editableCustomer(req, req.query.key); } catch (e) { return sendError(req, res, e); }
    return next();
  };
  const readImageFile = (req, res, next) => imageUpload.single('file')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Ảnh quá lớn, tối đa 5 MB.', code: 'IMAGE_TOO_LARGE' });
    return res.status(400).json({ error: 'Không đọc được file tải lên.', code: 'IMAGE_UPLOAD_FAILED' });
  });
  router.post('/customer-profile/images', ...customerView, guardImageEdit, readImageFile, handle(async (req, res) => {
    if (!req.file) throw fail(400, 'IMAGE_MISSING', 'Thiếu file ảnh.');
    const image = await customerProfiles.addImage(req.customer.key, req.file.buffer, actorOf(req.user));
    res.status(201).json({ image });
  }));

  router.delete('/customer-profile/images/:id', ...customerView, handle(async (req, res) => {
    const customer = await editableCustomer(req, req.query.key);
    if (!rules.UUID_RE.test(String(req.params.id))) throw fail(404, 'IMAGE_NOT_FOUND', 'Không tìm thấy ảnh.');
    await customerProfiles.deleteImage(customer.key, req.params.id);
    res.json({ ok: true });
  }));

  // Anh bat bien (xoa/them = dong moi) nen cache dai; ETag = sha256 de hoi lai bang 304.
  router.get('/customer-profile/images/:id', ...customerView, handle(async (req, res) => {
    const id = String(req.params.id);
    if (!rules.UUID_RE.test(id)) throw fail(404, 'IMAGE_NOT_FOUND', 'Không tìm thấy ảnh.');
    const meta = await customerProfiles.getImageMeta(id);
    if (!meta) throw fail(404, 'IMAGE_NOT_FOUND', 'Không tìm thấy ảnh.');
    res.set({ 'Content-Type': meta.contentType, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${meta.sha256}"` });
    if (req.fresh) return res.status(304).end();
    const content = await customerProfiles.getImageContent(id);
    if (!content) throw fail(404, 'IMAGE_NOT_FOUND', 'Không tìm thấy ảnh.');
    res.set('Content-Length', String(content.length));
    res.status(200).end(content);
  }));

  router.put('/customer-profile/visits', ...customerManage, jsonBody, handle(async (req, res) => {
    const body = req.body || {};
    const customer = await customerOf(body.key);
    const dates = rules.normalizeVisitDates(body.dates, vnToday(now()));
    res.json(await customerProfiles.setVisitDays(customer.key, dates, actorOf(req.user)));
  }));

  router.put('/customer-profile/editors', ...customerManage, jsonBody, handle(async (req, res) => {
    const body = req.body || {};
    const customer = await customerOf(body.key);
    const userIds = rules.normalizeUserIds(body.userIds);
    res.json({ editors: await customerProfiles.setEditors(customer.key, userIds, actorOf(req.user)) });
  }));

  router.get('/customer-profile/assignable-users', ...customerManage, handle(async (req, res) => {
    res.json({ users: await customerProfiles.listAssignableUsers() });
  }));

  // Xuat can quyen xem tung muc (products.growth hoac business) va reports.export.
  const exportGuard = [requireAuth, kindPermission, requireFeature('reports.export')];
  const exportReport = async req => {
    const kind = String(req.query.kind || '');
    if (!BUILDERS[kind]) { const e = new Error('Bảng xuất không hợp lệ.'); e.statusCode = 400; throw e; }
    let report = BUILDERS[kind](await repository.snapshot());
    if (kind === 'customers') {
      if ((req.query.salesChannel || req.query.warehouseScale) && !hasFeature(req.user, CUSTOMER_NOTES)) {
        throw fail(403,'CUSTOMER_PROFILE_FORBIDDEN','Bạn không có quyền lọc thông tin chi tiết khách hàng.');
      }
      report = await enrichCustomers(req,report,true);
    }
    const rows = sortRowsByLabel(kind, report, filterRows(kind, report.rows, req.query), req.query);
    return { kind, report, rows };
  };

  // Danh sach truong cho hop thoai "Xuat file" dung chung (cung dang /api/export/fields).
  router.get('/export/fields', ...exportGuard, handle(async (req, res) => {
    const { kind, report, rows } = await exportReport(req);
    res.json(exportFieldsFor(kind, report, rows));
  }));

  // columns=khoa1,khoa2,... (whitelist theo bang, sai => 400); bo trong tham so = xuat tat ca cot.
  router.get('/export', ...exportGuard, handle(async (req, res) => {
    const { kind, report, rows } = await exportReport(req);
    const columnKeys = resolveColumnKeys(kind, report, req.query.columns);
    const file = await createExportFile(kind, String(req.query.format || 'xlsx'), report, rows, columnKeys);
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
  }));

  return router;
}

module.exports = { createBusinessReportRouter };
