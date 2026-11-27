// ==========================================
// HR DEPARTMENT CATALOG — danh sách Bộ phận cố định theo cơ sở (file PHÒNG BAN.xlsx).
// Không nhập tay nữa: form nhân sự chỉ chọn trong danh sách này.
// Ban sao phia trinh duyet: nhan qua API GET /api/hr/employees (truong `departments`).
// ==========================================
'use strict';

const DEPARTMENTS_BY_BRANCH = Object.freeze({
  hanoi: Object.freeze(['Ban quản trị', 'Trợ lý', 'Đặt hàng', 'Kế toán', 'Marketing', 'Sale HN', 'Kho HN', 'Lái xe HN', 'Hậu cần - Bảo vệ']),
  saigon: Object.freeze(['Quản lý-KT SG', 'Sale SG', 'Kho SG', 'Lái xe SG', 'Hậu cần - Bảo vệ'])
});

function key(value) {
  return String(value == null ? '' : value)
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd')
    .replace(/\s*-\s*/g, '-').replace(/\s+/g, ' ').trim().toUpperCase();
}

// Ten cu (truoc khi chuan hoa) -> ten chuan, theo co so.
const LEGACY_ALIASES = Object.freeze({
  hanoi: { 'SALE': 'Sale HN', 'KHO': 'Kho HN', 'LAI XE': 'Lái xe HN' },
  saigon: {
    'SALE': 'Sale SG', 'KHO': 'Kho SG', 'LAI XE': 'Lái xe SG',
    'BAN QUAN TRI': 'Quản lý-KT SG', 'TRUONG CHI NHANH': 'Quản lý-KT SG', 'KE TOAN': 'Quản lý-KT SG'
  }
});

function departmentsFor(branch) {
  return DEPARTMENTS_BY_BRANCH[branch] ? [...DEPARTMENTS_BY_BRANCH[branch]] : [];
}

/** Tra ve ten chuan (khong phan biet hoa thuong/dau, nhan ca ten cu) hoac null neu khong thuoc danh sach. */
function canonicalDepartment(branch, value) {
  const wanted = key(value);
  if (!wanted || !DEPARTMENTS_BY_BRANCH[branch]) return null;
  const exact = DEPARTMENTS_BY_BRANCH[branch].find(name => key(name) === wanted);
  return exact || (LEGACY_ALIASES[branch] && LEGACY_ALIASES[branch][wanted]) || null;
}

// Gợi ý Bộ phận theo Vai trò (chỉ để điền sẵn trên form tài khoản; người dùng vẫn chọn lại được).
const SUGGESTED_DEPARTMENT_BY_ROLE = Object.freeze({
  hanoi: Object.freeze({
    'Quản lý': 'Ban quản trị', 'Kế toán': 'Kế toán', 'Trợ lý': 'Trợ lý', 'Nhân viên mua hàng': 'Đặt hàng',
    'Nhân viên marketing': 'Marketing', 'Nhân viên sale': 'Sale HN', 'Trưởng kho': 'Kho HN',
    'Nhân viên kho': 'Kho HN', 'Lái xe': 'Lái xe HN'
  }),
  saigon: Object.freeze({
    'Quản lý': 'Quản lý-KT SG', 'Kế toán': 'Quản lý-KT SG', 'Nhân viên sale': 'Sale SG',
    'Trưởng kho': 'Kho SG', 'Nhân viên kho': 'Kho SG', 'Lái xe': 'Lái xe SG'
  })
});

function suggestedDepartmentsByRole(branch) {
  return { ...(SUGGESTED_DEPARTMENT_BY_ROLE[branch] || {}) };
}

module.exports = { DEPARTMENTS_BY_BRANCH, departmentsFor, canonicalDepartment, suggestedDepartmentsByRole };
