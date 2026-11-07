// ==========================================
// ADMIN USER EXPORT SERVICE — xuat Excel danh sach tai khoan (Quan ly tai khoan)
// voi tap truong do nguoi dung chon. Khong bao gio xuat passwordHash.
// ==========================================
'use strict';

const ExcelJS = require('exceljs');
const featureRegistry = require('./featureRegistry');
const fuzzy = require('../shared/fuzzySearch');
const { HEADER_FONT, frozenNoGridlinesView, applyFullTableBorder } = require('../excelTableStyle');

const EXCEL_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const SOURCE_LABELS = { sheet: 'Danh sách nhân sự', override: 'Ghi đè thủ công', local: 'Tạo thủ công' };

const featureLabelByKey = new Map(featureRegistry.FEATURES.map(f => [f.key, f.label]));

function overridesText(user, wanted) {
  const overrides = featureRegistry.sanitizeOverrides(user.featurePermissions);
  return Object.keys(overrides)
    .filter(key => overrides[key] === wanted)
    .map(key => featureLabelByKey.get(key) || key)
    .join('; ');
}

// key -> { label, width, value(user) }. Thu tu o day la thu tu cot trong file.
const EXPORT_FIELDS = [
  { key: 'hoTen', label: 'Họ và tên', width: 26, value: u => u.hoTen || '' },
  { key: 'username', label: 'Tên tài khoản', width: 24, value: u => u.username || '' },
  { key: 'email', label: 'Email', width: 30, value: u => u.email || '' },
  { key: 'soDienThoai', label: 'Số điện thoại', width: 16, value: u => u.soDienThoai || '' },
  { key: 'telegramId', label: 'ID Telegram', width: 18, value: u => u.telegramId || '' },
  { key: 'vaiTro', label: 'Vai trò', width: 20, value: u => u.vaiTro || '' },
  { key: 'boPhan', label: 'Bộ phận nhân sự', width: 24, value: u => u.boPhan || '' },
  { key: 'leaveApprovalDepartments', label: 'Phòng ban được duyệt nghỉ', width: 36, value: u => (u.leaveApprovalDepartments || []).join('; ') },
  { key: 'coSo', label: 'Cơ sở', width: 12, value: u => u.coSo || '' },
  { key: 'trangThai', label: 'Trạng thái', width: 18, value: u => u.trangThai || '' },
  { key: 'lockReason', label: 'Lý do khóa', width: 16, value: u => (u.lockReason === 'manual' ? 'Khóa thủ công' : u.lockReason || '') },
  { key: 'ngayTao', label: 'Ngày tạo', width: 18, value: u => u.ngayTao || '' },
  { key: 'dangNhapGanNhat', label: 'Đăng nhập gần nhất', width: 20, value: u => u.dangNhapGanNhat || '' },
  { key: 'emailKhoiPhuc', label: 'Email khôi phục', width: 30, value: u => u.emailKhoiPhuc || '' },
  { key: 'sdtKhoiPhuc', label: 'SĐT khôi phục', width: 16, value: u => u.sdtKhoiPhuc || '' },
  { key: 'nguon', label: 'Nguồn tài khoản', width: 22, value: u => (u.hrManaged ? 'Đồng bộ HR' : 'Tạo thủ công') },
  { key: 'hrSourceBranch', label: 'Cơ sở nhân sự (HR)', width: 18, value: u => u.hrSourceBranch || '' },
  { key: 'sheetVaiTro', label: 'Vai trò theo HR', width: 20, value: u => u.sheetVaiTro || '' },
  { key: 'sheetCoSo', label: 'Cơ sở theo HR', width: 16, value: u => u.sheetCoSo || '' },
  { key: 'vaiTroOverride', label: 'Vai trò ghi đè', width: 20, value: u => u.vaiTroOverride || '' },
  { key: 'coSoOverride', label: 'Cơ sở ghi đè', width: 16, value: u => u.coSoOverride || '' },
  { key: 'roleSource', label: 'Nguồn vai trò', width: 20, value: u => SOURCE_LABELS[u.roleSource || (u.hrManaged ? 'sheet' : 'local')] || '' },
  { key: 'hasPassword', label: 'Đã đặt mật khẩu', width: 16, value: u => (u.passwordHash ? 'Có' : 'Không') },
  { key: 'permissionsGranted', label: 'Quyền cấp thêm', width: 40, value: u => overridesText(u, true) },
  { key: 'permissionsRevoked', label: 'Quyền thu hồi', width: 40, value: u => overridesText(u, false) },
  { key: 'id', label: 'ID tài khoản', width: 38, value: u => String(u.id || '') }
];

const FIELD_KEYS = EXPORT_FIELDS.map(f => f.key);
const DEFAULT_FIELD_KEYS = ['hoTen', 'username', 'email', 'soDienThoai', 'vaiTro', 'coSo', 'trangThai', 'ngayTao'];

const userSearchText = u => [u.hoTen, u.username, u.email].filter(Boolean).join(' ');

/** Cung quy tac loc voi handleFilterUsers() o trang Tai khoan (o tim: gan dung, bo dau, nhieu tu). */
function filterUsers(users, filters) {
  const q = String(filters.q || '').trim();
  const { role, coSo, trangThai } = filters;
  return users.filter(u => {
    const matchQ = !q || fuzzy.matches(userSearchText(u), q);
    const matchRole = !role || u.vaiTro === role;
    const matchFac = !coSo || u.coSo === coSo || (coSo !== 'Cả hai' && u.coSo === 'Cả hai');
    const matchStatus = !trangThai || u.trangThai === trangThai;
    return matchQ && matchRole && matchFac && matchStatus;
  });
}

/** Tra ve danh sach key hop le theo thu tu cot chuan; rong/khong hop le -> null. */
function parseFieldKeys(raw) {
  const wanted = new Set(String(raw || '').split(',').map(s => s.trim()).filter(Boolean));
  const keys = FIELD_KEYS.filter(k => wanted.has(k));
  return keys.length ? keys : null;
}

/**
 * @param {Object[]} users Tai khoan goc (kem passwordHash) tu localUserStore.getAllUsers().
 * @param {{q?:string, role?:string, coSo?:string, trangThai?:string}} filters
 * @param {string[]} fieldKeys Cac truong can xuat (da qua parseFieldKeys).
 */
async function buildUserWorkbook(users, filters, fieldKeys) {
  const fields = EXPORT_FIELDS.filter(f => fieldKeys.includes(f.key));
  const byName = filterUsers(users, filters || {})
    .slice()
    .sort((a, b) => String(a.hoTen || '').localeCompare(String(b.hoTen || ''), 'vi'));
  // Dang tim: khop nhieu tu / nguyen cum xep truoc (giong bang tren man hinh), con lai theo ten.
  const items = String((filters && filters.q) || '').trim() ? fuzzy.filter(byName, filters.q, userSearchText) : byName;

  let requestedOrder;
  try { requestedOrder=JSON.parse(filters.orderedIds || 'null'); } catch {}
  if (Array.isArray(requestedOrder) && requestedOrder.length) { const order=new Map(requestedOrder.map((id,index)=>[String(id),index])); items.sort((a,b)=>(order.get(String(a.username))??Infinity)-(order.get(String(b.username))??Infinity)); }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'TOKOSI Dashboard';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Danh sách tài khoản');
  sheet.columns = fields.map(f => ({ header: f.label, key: f.key, width: f.width }));

  items.forEach(user => {
    const row = {};
    fields.forEach(f => { row[f.key] = f.value(user); });
    sheet.addRow(row);
  });

  // Cot ID Telegram / SDT la chuoi: giu nguyen so 0 dau va so dai, tranh Excel doi sang so.
  fields.forEach((f, i) => {
    if (f.key === 'telegramId' || f.key === 'soDienThoai' || f.key === 'sdtKhoiPhuc') {
      sheet.getColumn(i + 1).numFmt = '@';
    }
  });

  sheet.views = frozenNoGridlinesView(1);
  sheet.getRow(1).font = HEADER_FONT;
  sheet.getRow(1).alignment = { vertical: 'middle' };
  applyFullTableBorder(sheet, fields.length, items.length + 1);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: fields.length } };

  const buffer = await workbook.xlsx.writeBuffer();
  return { buffer, fileName: 'TKS_danh-sach-tai-khoan.xlsx', mime: EXCEL_MIME, rowCount: items.length };
}

module.exports = { EXPORT_FIELDS, FIELD_KEYS, DEFAULT_FIELD_KEYS, parseFieldKeys, filterUsers, buildUserWorkbook };
