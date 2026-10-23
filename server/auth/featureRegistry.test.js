'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('./featureRegistry');
const { ROLES, INTERNAL_ROLES, REPORTS_ROLES } = require('./userRepository');

test('Marketing defaults to manager, assistant and Marketing, supports per-user revoke', () => {
  for (const role of Object.values(ROLES)) {
    assert.equal(registry.defaultsForRole(role).includes('reports.marketing'),
      [ROLES.QUAN_LY, ROLES.TRO_LY, ROLES.NHAN_VIEN_MARKETING].includes(role), role);
  }
  assert.ok(!registry.resolvePermissions({vaiTro:ROLES.NHAN_VIEN_MARKETING,
    featurePermissions:{'reports.marketing':false}}).includes('reports.marketing'));
  assert.ok(registry.pageRuleFor('/reports').anyOf.includes('reports.marketing'));
});

test('Sổ quỹ mặc định chỉ cấp quyền xem cho Quản lý', () => {
  for (const role of Object.values(ROLES)) {
    const actual = registry.defaultsForRole(role).filter(key => key.startsWith('cashbook.'));
    assert.deepEqual(actual, role === ROLES.QUAN_LY ? ['cashbook.view'] : [], role);
  }
});

test('quyền chốt số dư cũ đã gỡ: ghi đè còn lưu trong tài khoản bị bỏ qua', () => {
  assert.equal(registry.FEATURES.some(f => f.key === 'cashbook.manage'), false);
  const sale = { vaiTro: ROLES.NHAN_VIEN_SALE, featurePermissions: { 'cashbook.manage': true, 'cashbook.view': true } };
  assert.deepEqual(registry.resolvePermissions(sale).filter(key => key.startsWith('cashbook.')), ['cashbook.view']);
});

test('admin cứng luôn giữ quyền Sổ quỹ khi có ghi đè thu hồi', () => {
  const permissions = registry.resolvePermissions({ username: 'admin', vaiTro: ROLES.KHACH,
    featurePermissions: { 'cashbook.view': false } });
  assert.ok(permissions.includes('cashbook.view'));
});

test('các đường dẫn Sổ quỹ dùng cùng quyền xem và có thể là trang đích', () => {
  for (const url of ['/cashbook', '/cashbook/', '/cashbook/index.html']) {
    assert.deepEqual(registry.pageRuleFor(url), {
      path: '/cashbook', href: '/cashbook/', anyOf: ['cashbook.view']
    });
  }
  assert.equal(registry.landingPathFor(['cashbook.view', 'account.profile']), '/cashbook/');
});

test('Vị trí hàng defaults for every internal role; guest grants are always forbidden', () => {
  for (const vaiTro of INTERNAL_ROLES) assert.ok(registry.defaultsForRole(vaiTro).includes('stockLocations.view'), vaiTro);
  const guest = { vaiTro: ROLES.KHACH, featurePermissions: { 'stockLocations.view': true } };
  assert.ok(!registry.resolvePermissions(guest).includes('stockLocations.view'));
  assert.equal(registry.hasFeature({ ...guest, permissions: ['stockLocations.view'] }, 'stockLocations.view'), false);
  assert.ok(!registry.resolvePermissions({ vaiTro: ROLES.NHAN_VIEN_KHO, featurePermissions: { 'stockLocations.view': false } }).includes('stockLocations.view'));
});

// Cac tap hop vai tro CU (truoc khi co featureRegistry) — giu lai nguyen van o
// day de test bat duoc moi thay doi hanh vi ngoai y muon khi sua bang mac dinh.
// (Nhan vien sale da duoc mo them 5 tab xem bao cao — xem test rieng ben duoi.)
const LEGACY_NO_REPORTS_ROLES = [
  'Khách', 'Lái xe', 'Kế toán', 'Trưởng kho',
  'Nhân viên kho', 'Nhân viên mua hàng'
];

test('mac dinh theo vai tro: reports.* khop dung REPORTS_ROLES cu', () => {
  for (const role of REPORTS_ROLES) {
    const defaults = registry.defaultsForRole(role);
    for (const key of registry.ANY_REPORTS_FEATURES) {
      // Tinh lai thang chot (2026-10-07) va sua Khach moi/Ghi chu Marketing (2026-10-08) chi danh cho Quan ly.
      if (['reports.business.refreeze', 'reports.business.editTeam', 'reports.business.customerManage', 'reports.marketing.edit', 'reports.overview.containers.full', 'reports.products.expected.otherNote'].includes(key) && role !== ROLES.QUAN_LY) continue;
      // Cong no theo lich TT (2026-10-13): Sale phan hoi mac dinh chi Nhan vien sale; QL phan hoi, trang thai, lich TT chi Quan ly.
      if (key === 'reports.debt.saleFeedback' || key === 'reports.invoices.priceAudit.explain') continue;
      if (key === 'reports.invoices.priceAudit.decide' && role !== ROLES.QUAN_LY) continue;
      if (['reports.debt.managerFeedback', 'reports.debt.edit', 'reports.debt.schedule', 'reports.debt.penalty', 'reports.debt.refresh'].includes(key) && role !== ROLES.QUAN_LY) continue;
      assert.ok(defaults.includes(key), `${role} phai co ${key}`);
    }
  }
  for (const role of LEGACY_NO_REPORTS_ROLES) {
    const defaults = registry.defaultsForRole(role);
    // 2026-10-20: bang Du kien hang ve mo cho Ke toan / Mua hang / Kho; ngoai ra khong co reports.* nao.
    const reportKeys = defaults.filter(key => key.startsWith('reports.') && key !== 'reports.products.expected');
    assert.deepEqual(reportKeys, [], `${role} khong duoc co quyen reports.* nao`);
  }
});

test('mac dinh theo vai tro: hr.* danh cho moi vai tro noi bo, account.users chi Quan ly', () => {
  for (const role of INTERNAL_ROLES) {
    const defaults = registry.defaultsForRole(role);
    assert.ok(defaults.includes('hr.rules'), role);
    assert.ok(defaults.includes('hr.employees'), role);
    assert.ok(defaults.includes('hr.leave'), role);
    assert.equal(defaults.includes('account.users'), role === ROLES.QUAN_LY, role);
  }
  const guest = registry.defaultsForRole(ROLES.KHACH);
  assert.deepEqual(guest, ['hr.rules', 'hr.leave', 'account.profile']);
});

test('chi Quan ly moi co cac quyen quan tri mac dinh', () => {
  const managerOnly = ['hr.leave.manage', 'hr.rules.manage', 'account.users', 'account.users.manage', 'account.permissions', 'system.syncStatus', 'reports.products.expected.otherNote'];
  for (const key of managerOnly) {
    assert.ok(registry.defaultsForRole(ROLES.QUAN_LY).includes(key), `Quản lý phai co ${key}`);
    for (const role of Object.values(ROLES)) {
      if (role === ROLES.QUAN_LY) continue;
      assert.ok(!registry.defaultsForRole(role).includes(key), `${role} khong duoc co ${key}`);
    }
  }
});

test('xuat Excel don hang (Vong doi don hang) mac dinh chi danh cho Quan ly', () => {
  assert.ok(registry.defaultsForRole(ROLES.QUAN_LY).includes('shipment.export'));
  for (const role of Object.values(ROLES)) {
    if (role === ROLES.QUAN_LY) continue;
    assert.ok(!registry.defaultsForRole(role).includes('shipment.export'), `${role} khong duoc co shipment.export`);
  }
  // Quan ly van cap them duoc cho tung tai khoan (ghi de theo tai khoan).
  const granted = registry.resolvePermissions({ vaiTro: ROLES.KE_TOAN, featurePermissions: { 'shipment.export': true } });
  assert.ok(granted.includes('shipment.export'));
});

test('ghi de trang thai don hang mac dinh chi danh cho Quan ly (Ke toan khong con)', () => {
  for (const role of Object.values(ROLES)) {
    assert.equal(registry.defaultsForRole(role).includes('shipment.override'), role === ROLES.QUAN_LY, role);
  }
  // Quan ly van cap rieng cho Ke toan duoc (Ke toan co Vong doi don hang).
  const granted = registry.resolvePermissions({ vaiTro: ROLES.KE_TOAN, featurePermissions: { 'shipment.override': true } });
  assert.ok(granted.includes('shipment.override'));
});

test('Tra cuu / Lich su / Xuat / Ghi de GAN vao Vong doi don hang: thieu lifecycle thi mat het', () => {
  const LINKED = ['shipment.lookup', 'shipment.history', 'shipment.export', 'shipment.override'];
  // Mac dinh: ai co Vong doi don hang thi co Tra cuu + Lich su (cung nhom vai tro).
  for (const role of Object.values(ROLES)) {
    const keys = registry.defaultsForRole(role);
    for (const key of ['shipment.lookup', 'shipment.history']) {
      assert.equal(keys.includes(key), keys.includes('shipment.lifecycle'), `${role} ${key}`);
    }
  }
  // Cap rieng quyen phu cho tai khoan khong co Vong doi don hang -> van khong co.
  const noLifecycle = registry.resolvePermissions({
    vaiTro: ROLES.NHAN_VIEN_KHO,
    featurePermissions: Object.fromEntries(LINKED.map(key => [key, true]))
  });
  for (const key of LINKED) assert.ok(!noLifecycle.includes(key), key);
  // Thu hoi lifecycle cua Ke toan keo theo ca quyen phu da cap rieng.
  const revoked = registry.resolvePermissions({
    vaiTro: ROLES.KE_TOAN,
    featurePermissions: { 'shipment.lifecycle': false, 'shipment.override': true, 'shipment.export': true }
  });
  for (const key of ['shipment.lifecycle', ...LINKED]) assert.ok(!revoked.includes(key), key);
  // Cap lifecycle cho vai tro khong co -> Tra cuu/Lich su van phai cap them tung cai.
  const grantedOnlyLifecycle = registry.resolvePermissions({
    vaiTro: ROLES.NHAN_VIEN_KHO, featurePermissions: { 'shipment.lifecycle': true, 'shipment.lookup': true }
  });
  assert.ok(grantedOnlyLifecycle.includes('shipment.lifecycle'));
  assert.ok(grantedOnlyLifecycle.includes('shipment.lookup'));
  assert.ok(!grantedOnlyLifecycle.includes('shipment.history'));
});

const SALE_REPORT_VIEW_KEYS = ['reports.overview', 'reports.products', 'reports.products.growth', 'reports.products.sales', 'reports.products.expected', 'reports.invoices', 'reports.invoices.priceAudit', 'reports.business', 'reports.business.customerNotes', 'reports.debt'];
const SALE_REPORT_WRITE_KEYS = ['reports.debt.saleFeedback', 'reports.invoices.priceAudit.explain'];

test('Nhan vien sale xem du 5 tab bao cao mac dinh + dien Sale phan hoi cong no, KHONG co xuat Excel / sua trang thai cong no', () => {
  const reportKeys = registry.defaultsForRole(ROLES.NHAN_VIEN_SALE).filter(key => key.startsWith('reports.'));
  assert.deepEqual(reportKeys.filter(key => !SALE_REPORT_WRITE_KEYS.includes(key)), SALE_REPORT_VIEW_KEYS);
  assert.ok(reportKeys.includes('reports.invoices.priceAudit.explain'));
  assert.ok(!reportKeys.includes('reports.invoices.priceAudit.decide'));
  assert.ok(reportKeys.includes('reports.debt.saleFeedback'));
  assert.ok(!reportKeys.includes('reports.debt.managerFeedback'));
  assert.ok(!reportKeys.includes('reports.debt.schedule'));
  assert.ok(!reportKeys.includes('reports.export'));
  assert.ok(!reportKeys.includes('reports.debt.edit'));
  // Cac vai tro con lai khong thuoc REPORTS_ROLES van KHONG co reports.overview.
  for (const role of LEGACY_NO_REPORTS_ROLES) {
    assert.ok(!registry.defaultsForRole(role).includes('reports.overview'), role);
  }
});

const SHIPMENT_LIFECYCLE_GROUP = ['shipment.lifecycle', 'shipment.lookup', 'shipment.history'];

test('Nhan vien marketing has own report, other permissions match sale excluding general reports, lifecycle, Tao QR Yeu cau xuat VAT and Tra cuu VAT', () => {
  assert.deepEqual(
    registry.defaultsForRole(ROLES.NHAN_VIEN_MARKETING).filter(key=>key!=='reports.marketing' && key!=='reports.products.expected'),
    registry.defaultsForRole(ROLES.NHAN_VIEN_SALE).filter(key => !SALE_REPORT_VIEW_KEYS.includes(key) && !SALE_REPORT_WRITE_KEYS.includes(key) && key !== 'accounting.qr' && key !== 'accounting.vatRequest' && key !== 'accounting.vatLookup' && !SHIPMENT_LIFECYCLE_GROUP.includes(key))
  );
});

test('Tra cuu VAT: Sale + Ke toan + Quan ly mac dinh; Kho / Marketing / Khach khong co; mien kiem tra leo thang', () => {
  for (const role of [ROLES.NHAN_VIEN_SALE, ROLES.KE_TOAN, ROLES.QUAN_LY]) {
    assert.ok(registry.defaultsForRole(role).includes('accounting.vatLookup'), role);
  }
  for (const role of [ROLES.NHAN_VIEN_KHO, ROLES.NHAN_VIEN_MARKETING, ROLES.KHACH]) {
    assert.ok(!registry.defaultsForRole(role).includes('accounting.vatLookup'), role);
  }
  assert.ok(registry.isEscalationExempt('accounting.vatLookup'));
});

test('Yeu cau xuat VAT: Sale + Ke toan + Quan ly xem/tao; Ke toan chi xu ly khi duoc cap rieng', () => {
  for (const role of [ROLES.NHAN_VIEN_SALE, ROLES.KE_TOAN, ROLES.QUAN_LY]) {
    assert.ok(registry.defaultsForRole(role).includes('accounting.vatRequest'), role);
  }
  assert.ok(!registry.defaultsForRole(ROLES.NHAN_VIEN_SALE).includes('accounting.vatRequestProcess'));
  assert.ok(!registry.defaultsForRole(ROLES.KE_TOAN).includes('accounting.vatRequestProcess'));
  assert.ok(registry.defaultsForRole(ROLES.QUAN_LY).includes('accounting.vatRequestProcess'));
  for (const role of [ROLES.NHAN_VIEN_KHO, ROLES.NHAN_VIEN_MARKETING, ROLES.KHACH]) {
    assert.ok(!registry.defaultsForRole(role).includes('accounting.vatRequest'), role);
  }
  const keToanGranted = { username: 'kt', vaiTro: ROLES.KE_TOAN, trangThai: 'Đang hoạt động', featurePermissions: { 'accounting.vatRequestProcess': true } };
  assert.ok(registry.resolvePermissions(keToanGranted).includes('accounting.vatRequestProcess'));
  const keToanNoBase = { ...keToanGranted, featurePermissions: { 'accounting.vatRequest': false, 'accounting.vatRequestProcess': true } };
  assert.ok(!registry.resolvePermissions(keToanNoBase).includes('accounting.vatRequestProcess'));
  assert.ok(!registry.resolvePermissions({ ...keToanGranted, featurePermissions: { 'accounting.vatRequestProcess': false } }).includes('accounting.vatRequestProcess'));
  assert.ok(registry.isEscalationExempt('accounting.vatRequest'));
  assert.ok(!registry.isEscalationExempt('accounting.vatRequestProcess'));
  assert.ok(registry.PAGE_FEATURES.some(page => page.path === '/vat-request' && page.anyOf.includes('accounting.vatRequest')));
});

test('Nhan vien kho + mua hang + marketing + Khach KHONG co Vong doi don hang va cac quyen gan kem', () => {
  for (const role of [ROLES.NHAN_VIEN_KHO, ROLES.NHAN_VIEN_MUA_HANG, ROLES.NHAN_VIEN_MARKETING, ROLES.KHACH]) {
    const keys = registry.defaultsForRole(role);
    for (const key of SHIPMENT_LIFECYCLE_GROUP) assert.ok(!keys.includes(key), `${role} ${key}`);
  }
});

test('ghi de theo tai khoan: true them quyen, false thu hoi, key vang mat = theo vai tro', () => {
  const base = registry.resolvePermissions({ vaiTro: ROLES.KE_TOAN });
  assert.ok(!base.includes('reports.overview'));
  assert.ok(base.includes('hr.leave'));

  const overridden = registry.resolvePermissions({
    vaiTro: ROLES.KE_TOAN,
    featurePermissions: { 'reports.overview': true, 'hr.leave': false }
  });
  assert.ok(overridden.includes('reports.overview'), 'quyen duoc cap them');
  assert.ok(!overridden.includes('hr.leave'), 'quyen bi thu hoi');
  assert.ok(overridden.includes('shipment.lifecycle'), 'quyen khong dong toi van theo mac dinh');
});

test('quyen alwaysOn khong the bi thu hoi', () => {
  const permissions = registry.resolvePermissions({
    vaiTro: ROLES.KHACH,
    featurePermissions: { 'account.profile': false }
  });
  assert.ok(permissions.includes('account.profile'));
  assert.deepEqual(registry.sanitizeOverrides({ 'account.profile': false }), {});
});

test('key la bi loai khoi ghi de va duoc bao cao lai', () => {
  assert.deepEqual(registry.sanitizeOverrides({ 'khong.ton.tai': true, 'hr.leave': false }), { 'hr.leave': false });
  assert.deepEqual(registry.unknownOverrideKeys({ 'khong.ton.tai': true, 'hr.leave': false }), ['khong.ton.tai']);
  assert.deepEqual(registry.sanitizeOverrides(null), {});
  assert.deepEqual(registry.sanitizeOverrides({ 'hr.leave': null }), {}, 'null = quay ve mac dinh');
});

test('Quan tri vien he thong (hardcoded admin) luon co du moi quyen', () => {
  const permissions = registry.resolvePermissions({
    username: 'thangnnv2003@gmail.com',
    vaiTro: ROLES.KHACH,
    featurePermissions: { 'account.permissions': false }
  });
  assert.deepEqual(permissions, registry.FEATURE_KEYS.filter(key => key !== 'hr.leave.submit'));
});

test('hasFeature/permissionsHave dung ngu nghia HOAC', () => {
  const user = { vaiTro: ROLES.KHACH };
  assert.equal(registry.hasFeature(user, 'reports.debt', 'account.profile'), true);
  assert.equal(registry.hasFeature(user, 'reports.debt', 'hr.employees'), false);
  assert.equal(registry.permissionsHave(['a', 'b'], 'b'), true);
  assert.equal(registry.permissionsHave(undefined, 'b'), false);
});

test('guest permissions remain restricted even with stored or session overrides', () => {
  const guest = { vaiTro: ROLES.KHACH, trangThai: 'Đang hoạt động', workCoSo: 'Hà Nội', boPhan: 'Marketing', featurePermissions: Object.fromEntries(registry.FEATURE_KEYS.map(key => [key, true])) };
  assert.deepEqual(registry.resolvePermissions(guest), ['hr.rules', 'hr.leave', 'hr.leave.submit', 'account.profile']);
  for (const key of registry.FEATURE_KEYS.filter(key => !['hr.rules', 'hr.leave', 'hr.leave.submit', 'account.profile'].includes(key))) {
    assert.equal(registry.hasFeature({ ...guest, permissions: [key] }, key), false, key);
  }
});

test('pageRuleFor chuan hoa duong dan, "/" tuong duong "/reports"', () => {
  assert.equal(registry.normalizePagePath('/'), '/reports');
  assert.equal(registry.normalizePagePath('/index.html'), '/reports');
  assert.equal(registry.normalizePagePath('/account/'), '/account');
  assert.equal(registry.normalizePagePath('/account/index.html'), '/account');
  assert.equal(registry.pageRuleFor('/reports/').path, '/reports');
  assert.equal(registry.pageRuleFor('/shipment/lifecycle').path, '/shipment/lifecycle');
  assert.equal(registry.pageRuleFor('/khong-ton-tai'), null);
});

test('landingPathFor tra ve trang dau tien tai khoan vao duoc', () => {
  assert.equal(registry.landingPathFor(registry.defaultsForRole(ROLES.QUAN_LY)), '/reports/');
  assert.equal(registry.landingPathFor(registry.defaultsForRole(ROLES.KE_TOAN)), '/shipment/lifecycle/');
  // Sale co quyen Tong quan nen trang dau tien vao duoc la bao cao (thu tu PAGE_FEATURES).
  assert.equal(registry.landingPathFor(registry.defaultsForRole(ROLES.NHAN_VIEN_SALE)), '/reports/');
  // Marketing now has its own report; guest still only enters account.
  assert.equal(registry.landingPathFor(registry.defaultsForRole(ROLES.NHAN_VIEN_MARKETING)), '/reports/');
  assert.equal(registry.landingPathFor(registry.defaultsForRole(ROLES.KHACH)), '/humanresources/');
  assert.equal(registry.landingPathFor([]), '/account/');
});

test('moi tinh nang co nhan tieng Viet va thuoc mot nhom da khai bao', () => {
  const groupKeys = registry.FEATURE_GROUPS.map(g => g.key);
  for (const feature of registry.FEATURES) {
    assert.ok(feature.label && feature.label.trim(), feature.key);
    assert.ok(groupKeys.includes(feature.groupKey), `${feature.key} thuoc nhom la: ${feature.groupKey}`);
  }
  assert.equal(new Set(registry.FEATURE_KEYS).size, registry.FEATURE_KEYS.length, 'khong duoc trung key');
});

test('absence permission defaults to managers and self submission follows account workplace', () => {
  assert.ok(registry.defaultsForRole(ROLES.QUAN_LY).includes('hr.leave.absence.manage'));
  const linked = { vaiTro: ROLES.NHAN_VIEN_SALE, workCoSo: 'Hà Nội', boPhan: 'Kế toán', hrManaged: false, trangThai: 'Đang hoạt động' };
  assert.ok(registry.resolvePermissions(linked).includes('hr.leave.submit'), 'moi vai tro noi bo da gan nhan su deu xin nghi duoc');
  for (const role of registry.INTERNAL_ROLES || [ROLES.QUAN_LY, ROLES.KE_TOAN, ROLES.NHAN_VIEN_KHO, ROLES.NHAN_VIEN_MARKETING, ROLES.NHAN_VIEN_MUA_HANG, ROLES.TRO_LY, ROLES.TRUONG_KHO, ROLES.LAI_XE]) assert.ok(registry.resolvePermissions({ ...linked, vaiTro: role }).includes('hr.leave.submit'), role);
  assert.ok(registry.resolvePermissions({ ...linked, vaiTro: ROLES.KHACH }).includes('hr.leave.submit'), 'Khách có thông tin công tác được xin nghỉ');
  assert.ok(!registry.resolvePermissions({ ...linked, trangThai: 'Khóa' }).includes('hr.leave.submit'));
  assert.ok(!registry.resolvePermissions({ vaiTro: ROLES.KHACH, featurePermissions: { 'hr.leave.submit': true } }).includes('hr.leave.submit'));
});



test('self submission requires valid account workplace and ignores linked HR data', () => {
  const user = { vaiTro: ROLES.TRO_LY, workCoSo: 'Hà Nội', boPhan: 'Kế toán', trangThai: 'Đang hoạt động', hrEmployeeActive: false, hrVerificationRequired: true };
  assert.ok(registry.resolvePermissions(user).includes('hr.leave.submit'));
  for (const patch of [{ workCoSo: '' }, { workCoSo: 'Cả hai' }, { boPhan: '' }, { boPhan: 'Sale SG' }, { isDeleted: true }, { trangThai: 'Khóa' }]) {
    assert.ok(!registry.resolvePermissions({ ...user, ...patch, featurePermissions: { 'hr.leave.submit': true } }).includes('hr.leave.submit'));
  }
});

test('reports.products.cost da go cung tab Hang hoa cu: khong con trong registry, quyen ghi de cu bi bo qua', () => {
  assert.ok(!registry.FEATURE_KEYS.includes('reports.products.cost'));
  const resolved = registry.resolvePermissions({ vaiTro: ROLES.QUAN_LY, featurePermissions: { 'reports.products.cost': true } });
  assert.ok(!resolved.includes('reports.products.cost'));
});

test('bao cao kinh doanh: xem theo vai tro xem bao cao, tinh lai thang chi Quan ly', () => {
  const view = registry.FEATURES.find(f => f.key === 'reports.business');
  const refreeze = registry.FEATURES.find(f => f.key === 'reports.business.refreeze');
  assert.ok(view && refreeze);
  assert.equal(refreeze.requires, 'reports.business');
  assert.ok(registry.REPORT_VIEW_FEATURES.includes('reports.business'));
  assert.ok(registry.resolvePermissions({ vaiTro: ROLES.NHAN_VIEN_SALE }).includes('reports.business'));
  assert.ok(!registry.resolvePermissions({ vaiTro: ROLES.NHAN_VIEN_SALE }).includes('reports.business.refreeze'));
  assert.ok(registry.resolvePermissions({ vaiTro: ROLES.QUAN_LY }).includes('reports.business.refreeze'));
});

test('hr.employees.manage: mặc định chỉ Quản lý, cần hr.employees', () => {
  assert.ok(registry.defaultsForRole('Quản lý').includes('hr.employees.manage'));
  assert.ok(!registry.defaultsForRole('Kế toán').includes('hr.employees.manage'));
  assert.ok(!registry.defaultsForRole('Nhân viên kho').includes('hr.employees.manage'));
  const feature = registry.FEATURES.find(f => f.key === 'hr.employees.manage');
  assert.equal(feature.requires, 'hr.employees');
});

test('Nháp VAT (accounting.vatDraft): mặc định chỉ Quản lý, Kế toán chỉ có khi được cấp riêng, Khách không bao giờ có', () => {
  for (const role of Object.values(ROLES)) {
    assert.equal(registry.defaultsForRole(role).includes('accounting.vatDraft'), role === ROLES.QUAN_LY, role);
  }
  assert.ok(!registry.resolvePermissions({ vaiTro: ROLES.KE_TOAN }).includes('accounting.vatDraft'));
  assert.ok(registry.resolvePermissions({ vaiTro: ROLES.KE_TOAN, featurePermissions: { 'accounting.vatDraft': true } }).includes('accounting.vatDraft'));
  assert.ok(!registry.resolvePermissions({ vaiTro: ROLES.KHACH, featurePermissions: { 'accounting.vatDraft': true } }).includes('accounting.vatDraft'));
  assert.ok(registry.resolvePermissions({ username: 'admin', vaiTro: ROLES.KE_TOAN }).includes('accounting.vatDraft'));
  assert.ok(registry.FEATURE_GROUPS.some(g => g.key === 'accounting' && g.label === 'Kế toán'));
  for (const url of ['/vat-draft', '/vat-draft/', '/vat-draft/index.html']) {
    assert.deepEqual(registry.pageRuleFor(url), { path: '/vat-draft', href: '/vat-draft/', anyOf: ['accounting.vatDraft', 'accounting.qr'] });
  }
  // Quan ly van vao /reports/ dau tien nhu cu.
  assert.equal(registry.landingPathFor(registry.defaultsForRole(ROLES.QUAN_LY)), '/reports/');
});

test('Tạo QR (accounting.qr): mặc định Quản lý + Nhân viên sale, Khách không bao giờ có', () => {
  for (const role of Object.values(ROLES)) {
    assert.equal(registry.defaultsForRole(role).includes('accounting.qr'), role === ROLES.QUAN_LY || role === ROLES.NHAN_VIEN_SALE, role);
  }
  const sale = registry.resolvePermissions({ vaiTro: ROLES.NHAN_VIEN_SALE });
  assert.ok(sale.includes('accounting.qr') && !sale.includes('accounting.vatDraft'));
  assert.ok(registry.hasFeature({ permissions: sale, vaiTro: ROLES.NHAN_VIEN_SALE }, 'accounting.vatDraft', 'accounting.qr'));
  assert.ok(!registry.resolvePermissions({ vaiTro: ROLES.KHACH, featurePermissions: { 'accounting.qr': true } }).includes('accounting.qr'));
  // Sale van vao /reports/ dau tien.
  assert.equal(registry.landingPathFor(sale), '/reports/');
});

test('reports.products.price (Don gia HN/SG cua Bao cao hang hoa): mac dinh chi Quan ly + Tro ly, can reports.products', () => {
  assert.ok(registry.defaultsForRole(ROLES.QUAN_LY).includes('reports.products.price'));
  assert.ok(registry.defaultsForRole(ROLES.TRO_LY).includes('reports.products.price'));
  for (const role of Object.values(ROLES).filter(r => r !== ROLES.QUAN_LY && r !== ROLES.TRO_LY)) {
    assert.equal(registry.defaultsForRole(role).includes('reports.products.price'), false, role);
  }
  assert.equal(registry.FEATURES.find(f => f.key === 'reports.products.price').requires, 'reports.products');
});

test('reports.products.expected: moi vai tro noi bo, doc lap voi reports.products', () => {
  const feature = registry.FEATURES.find(f => f.key === 'reports.products.expected');
  assert.ok(feature && !feature.requires);
  assert.deepEqual([...feature.roles].sort(), [...INTERNAL_ROLES].sort());
  assert.ok(!registry.defaultsForRole(ROLES.KHACH).includes('reports.products.expected'));
  for (const role of [ROLES.KE_TOAN, ROLES.NHAN_VIEN_MUA_HANG, ROLES.NHAN_VIEN_KHO]) {
    const permissions = registry.defaultsForRole(role);
    assert.ok(!permissions.includes('reports.products'), role);
    // Mo duoc /reports (de xem bang) nhung landing van la trang cu.
    assert.ok(registry.permissionsHave(permissions, ...registry.pageRuleFor('/reports').anyOf), role);
    assert.notEqual(registry.landingPathFor(permissions), '/reports/', role);
  }
  assert.equal(registry.landingPathFor(['reports.products.expected', 'account.profile']), '/account/');
});

test('Hang hoa: mac dinh QL/TL/Sale xem ca ba muc, cac vai tro noi bo khac chi xem Du kien', () => {
  for (const role of INTERNAL_ROLES) {
    const permissions = registry.defaultsForRole(role);
    const full = [ROLES.QUAN_LY, ROLES.TRO_LY, ROLES.NHAN_VIEN_SALE].includes(role);
    assert.equal(permissions.includes('reports.products'), full, role);
    assert.equal(permissions.includes('reports.products.growth'), full, role);
    assert.ok(permissions.includes('reports.products.expected'), role);
  }
  const custom = registry.resolvePermissions({ vaiTro: ROLES.NHAN_VIEN_KHO, featurePermissions: { 'reports.products.growth': true } });
  assert.ok(custom.includes('reports.products.growth'));
  assert.ok(!custom.includes('reports.products'));
});

test('Kiem tra gia ban: xem (QL/TL/Sale, can Hoa don), giai thich mac dinh chi Sale, Chot mac dinh chi Quan ly', () => {
  const VIEW = 'reports.invoices.priceAudit';
  const EXPLAIN = 'reports.invoices.priceAudit.explain';
  const DECIDE = 'reports.invoices.priceAudit.decide';
  for (const role of ['Quản lý', 'Trợ lý', 'Nhân viên sale']) assert.ok(registry.defaultsForRole(role).includes(VIEW), role);
  assert.ok(!registry.defaultsForRole('Kế toán').includes(VIEW));
  assert.deepEqual(['Quản lý', 'Trợ lý', 'Nhân viên sale'].filter(r => registry.defaultsForRole(r).includes(EXPLAIN)), ['Nhân viên sale']);
  assert.deepEqual(['Quản lý', 'Trợ lý', 'Nhân viên sale'].filter(r => registry.defaultsForRole(r).includes(DECIDE)), ['Quản lý']);
  // requires: mat quyen xem (hoac mat Hoa don) thi mat ca giai thich / Chot.
  assert.ok(!registry.resolvePermissions({ vaiTro: 'Nhân viên sale', featurePermissions: { 'reports.invoices': false } }).some(k => k.startsWith(VIEW)));
  assert.ok(!registry.resolvePermissions({ vaiTro: 'Quản lý', featurePermissions: { [VIEW]: false } }).includes(DECIDE));
  // Cap rieng cho Tro ly duoc.
  assert.ok(registry.resolvePermissions({ vaiTro: 'Trợ lý', featurePermissions: { [DECIDE]: true } }).includes(DECIDE));
});

test('Ghi chu khach (2026-10-22): xem = Quan ly + Tro ly + Sale, sua tiep khach / gan nguoi sua chi Quan ly, chuoi requires', () => {
  const notes = registry.FEATURES.find(f => f.key === 'reports.business.customerNotes');
  const manage = registry.FEATURES.find(f => f.key === 'reports.business.customerManage');
  assert.equal(notes.requires, 'reports.business');
  assert.equal(manage.requires, 'reports.business.customerNotes');
  for (const role of [ROLES.QUAN_LY, ROLES.TRO_LY, ROLES.NHAN_VIEN_SALE]) {
    assert.ok(registry.resolvePermissions({ vaiTro: role }).includes('reports.business.customerNotes'), `${role} xem duoc ghi chu khach`);
  }
  for (const role of [ROLES.NHAN_VIEN_MARKETING, ROLES.KE_TOAN, ROLES.NHAN_VIEN_KHO, ROLES.KHACH]) {
    assert.ok(!registry.resolvePermissions({ vaiTro: role }).includes('reports.business.customerNotes'), `${role} khong xem ghi chu khach`);
  }
  assert.ok(registry.resolvePermissions({ vaiTro: ROLES.QUAN_LY }).includes('reports.business.customerManage'));
  for (const role of [ROLES.TRO_LY, ROLES.NHAN_VIEN_SALE]) {
    assert.ok(!registry.resolvePermissions({ vaiTro: role }).includes('reports.business.customerManage'), `${role} khong quan ly ghi chu khach`);
  }
  // Tat quyen xem thi quyen quan ly phai bi tat theo.
  const managerWithoutView = registry.resolvePermissions({ vaiTro: ROLES.QUAN_LY, featurePermissions: { 'reports.business.customerNotes': false } });
  assert.ok(!managerWithoutView.includes('reports.business.customerManage'));
});
