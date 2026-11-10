'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHrEmployeeAdminService, LOCK_REASON_RESIGNED } = require('./hrEmployeeAdminService');
const { roleForDepartment, normalizeEmail } = require('./employeeDirectory');
const accountPolicy = require('../auth/accountPolicy');
const localUserStore = require('../auth/localUserStore');

const MANAGER = { id: 'm1', vaiTro: 'Quản lý', coSo: 'Cả hai', username: 'quanly@x.com', email: 'quanly@x.com' };

function mapRow(row) {
  return {
    sourceBranch: row.branch === 'hanoi' ? 'Hà Nội' : 'Sài Gòn',
    rowIndex: row.id,
    hoTen: row.hoTen, boPhan: row.boPhan, email: row.email, soDienThoai: row.soDienThoai,
    employmentStatus: row.employmentStatus, createdAt: row.createdAt || '',
    insuranceNumber: row.insuranceNumber || '',
    sheetVaiTro: roleForDepartment(row.boPhan)
  };
}

function setup({ rows, users = [] } = {}) {
  const db = rows || [
    { id: 1, branch: 'hanoi', hoTen: 'An', boPhan: 'KHO', email: 'an@x.com', soDienThoai: '0900000001', employmentStatus: 'active', createdAt: '2026-01-01T00:00:00Z' },
    { id: 2, branch: 'saigon', hoTen: 'Bình', boPhan: 'SALE', email: 'binh@x.com', soDienThoai: '0900000002', employmentStatus: 'active', createdAt: '2026-01-02T00:00:00Z' }
  ];
  const calls = { audit: [], userUpdates: [] };
  const repo = {
    async insertEmployee(input) {
      const row = { id: 99, hoTen: input.hoTen, boPhan: input.boPhan, branch: input.branch, email: input.email, soDienThoai: input.soDienThoai, employmentStatus: input.employmentStatus, createdAt: '2026-10-09T00:00:00Z' };
      db.push(row);
      return row;
    },
    async updateEmployeeById(id, input) {
      const row = db.find(r => r.id === id);
      if (!row) return null;
      Object.assign(row, input);
      return row;
    },
    async updateExtendedById(id, input) {
      const row = db.find(r => r.id === id);
      if (row) Object.assign(row, input);
      return row || null;
    }
  };
  const directory = {
    normalizeEmail, roleForDepartment,
    clearCache() {},
    async getSnapshot() { return { employees: db.map(mapRow) }; }
  };
  const store = users.map(u => ({ ...u }));
  const userStore = {
    ...localUserStore,
    async getAllUsers() { return store.map(u => ({ ...u })); },
    async updateUser(id, updates) {
      const user = store.find(u => String(u.id) === String(id));
      Object.assign(user, updates);
      calls.userUpdates.push({ id, updates });
      return { ...user };
    }
  };
  const auditLog = {
    ACTIONS: { UPDATE: 'update' },
    diffUser: () => [{ field: 'trangThai' }],
    async record(entry) { calls.audit.push(entry); }
  };
  const service = createHrEmployeeAdminService({ repo, directory, userStore, policy: accountPolicy, auditLog });
  return { service, db, store, calls };
}

const valid = { hoTen: 'Chi', boPhan: 'KHO', coSo: 'Hà Nội', soDienThoai: '0911111111', email: 'Chi@X.com', trangThai: 'active' };

test('thêm nhân sự: chuẩn hóa email, trả về nhân sự mới, mặc định Đang làm việc', async () => {
  const { service, db } = setup();
  const { employee } = await service.createEmployee(MANAGER, { ...valid, trangThai: '' });
  assert.equal(employee.email, 'chi@x.com');
  assert.equal(employee.employmentStatus, 'active');
  assert.equal(db.length, 3);
});

test('thêm/sửa: thiếu tên, cơ sở sai, email sai bị từ chối 400', async () => {
  const { service } = setup();
  await assert.rejects(service.createEmployee(MANAGER, { ...valid, hoTen: ' ' }), { statusCode: 400, code: 'INVALID_NAME' });
  await assert.rejects(service.createEmployee(MANAGER, { ...valid, coSo: 'Cả hai' }), { statusCode: 400, code: 'INVALID_BRANCH' });
  await assert.rejects(service.createEmployee(MANAGER, { ...valid, email: 'khong-hop-le' }), { statusCode: 400, code: 'INVALID_EMAIL' });
  await assert.rejects(service.createEmployee(MANAGER, { ...valid, trangThai: 'abc' }), { statusCode: 400, code: 'INVALID_EMPLOYMENT_STATUS' });
});

test('thêm nhân sự trùng email hoặc SĐT với nhân sự khác (kể cả đã nghỉ) → 409', async () => {
  const { service } = setup();
  await assert.rejects(service.createEmployee(MANAGER, { ...valid, email: 'AN@x.com' }), { statusCode: 409, code: 'HR_IDENTITY_CONFLICT' });
  await assert.rejects(service.createEmployee(MANAGER, { ...valid, soDienThoai: '+84 900 000 002' }), { statusCode: 409 });
});

// Index hr_employees_insurance_number_unique (migration 0078) khong duoc tien kiem
// nen sua nhan su trung so bao hiem roi thang xuong Postgres -> 23505 -> 500.
test('trùng số sổ bảo hiểm với nhân sự khác → 409 nêu đúng tên người giữ số đó', async () => {
  const rows = [
    { id: 1, branch: 'hanoi', hoTen: 'An', boPhan: 'KHO', email: 'an@x.com', soDienThoai: '0900000001', employmentStatus: 'active', insuranceNumber: 'BH-001' },
    { id: 2, branch: 'hanoi', hoTen: 'Bình', boPhan: 'KHO', email: 'binh@x.com', soDienThoai: '0900000002', employmentStatus: 'active', insuranceNumber: 'BH-002' }
  ];
  const { service } = setup({ rows });
  await assert.rejects(
    service.updateEmployee(MANAGER, 2, { ...valid, hoTen: 'Bình', email: 'binh@x.com', soDienThoai: '0900000002', insuranceNumber: 'BH-001' }),
    error => error.statusCode === 409 && error.code === 'HR_INSURANCE_CONFLICT' && /An/.test(error.message)
  );
});

test('số sổ bảo hiểm để trống thì nhiều nhân sự cùng trống vẫn lưu được', async () => {
  const rows = [
    { id: 1, branch: 'hanoi', hoTen: 'An', boPhan: 'KHO', email: 'an@x.com', soDienThoai: '0900000001', employmentStatus: 'active', insuranceNumber: '' },
    { id: 2, branch: 'hanoi', hoTen: 'Bình', boPhan: 'KHO', email: 'binh@x.com', soDienThoai: '0900000002', employmentStatus: 'active', insuranceNumber: '' }
  ];
  const { service } = setup({ rows });
  const { employee } = await service.updateEmployee(MANAGER, 2, { ...valid, hoTen: 'Bình', email: 'binh@x.com', soDienThoai: '0900000002', insuranceNumber: '' });
  assert.equal(employee.hoTen, 'Bình');
});

test('giữ nguyên số bảo hiểm của chính mình khi sửa các trường khác', async () => {
  const rows = [
    { id: 1, branch: 'hanoi', hoTen: 'An', boPhan: 'KHO', email: 'an@x.com', soDienThoai: '0900000001', employmentStatus: 'active', insuranceNumber: 'BH-001' }
  ];
  const { service } = setup({ rows });
  const { employee } = await service.updateEmployee(MANAGER, 1, { ...valid, hoTen: 'An sửa', email: 'an@x.com', soDienThoai: '0900000001', insuranceNumber: 'BH-001' });
  assert.equal(employee.hoTen, 'An sửa');
});

test('chốt chặn leo thang: người không phải Quản lý không được tạo dòng "BAN QUẢN TRỊ" hoặc dùng email admin cứng', async () => {
  const { service } = setup();
  const limited = { id: 'u9', vaiTro: 'Kế toán', coSo: 'Cả hai', username: 'ketoan', email: 'kt@x.com', permissions: ['hr.employees', 'hr.employees.manage'] };
  await assert.rejects(service.createEmployee(limited, { ...valid, boPhan: 'BAN QUẢN TRỊ' }), { statusCode: 403, code: 'HR_ROLE_ESCALATION' });
  const adminEmail = [...localUserStore.HARDCODED_ADMINS][0];
  if (adminEmail) {
    await assert.rejects(service.createEmployee(limited, { ...valid, email: String(adminEmail) }), { statusCode: 403, code: 'PROTECTED_IDENTITY' });
  }
});

test('sửa nhân sự: không tìm thấy → 404; cơ sở ngoài phạm vi → 403', async () => {
  const { service } = setup();
  await assert.rejects(service.updateEmployee(MANAGER, 12345, valid), { statusCode: 404 });
  const hanoiOnly = { ...MANAGER, vaiTro: 'Kế toán', coSo: 'Hà Nội', permissions: [] };
  await assert.rejects(service.updateEmployee(hanoiOnly, 2, { ...valid, coSo: 'Sài Gòn', email: 'z@x.com', soDienThoai: '0922222222' }), { statusCode: 403 });
});

test('đổi sang Đã nghỉ việc khóa tài khoản liên kết bằng hr_resigned và ghi nhật ký; bỏ qua tài khoản đã khóa/được bảo vệ', async () => {
  const { service, store, calls } = setup({
    users: [
      { id: 'a', username: 'an', email: 'an@x.com', soDienThoai: '', hrRowIndex: 1, vaiTro: 'Nhân viên kho', trangThai: 'Đang hoạt động', lockReason: '' },
      { id: 'b', username: 'an2', email: '', soDienThoai: '0900000001', hrRowIndex: '', vaiTro: 'Nhân viên kho', trangThai: 'Khóa', lockReason: 'manual' },
      { id: 'c', username: 'khac', email: 'khac@x.com', soDienThoai: '', hrRowIndex: 2, vaiTro: 'Nhân viên sale', trangThai: 'Đang hoạt động', lockReason: '' }
    ]
  });
  const { accounts, employee } = await service.updateEmployee(MANAGER, 1, { ...valid, hoTen: 'An', email: 'an@x.com', soDienThoai: '0900000001', trangThai: 'Đã nghỉ việc' });
  assert.equal(employee.employmentStatus, 'resigned');
  assert.deepEqual(accounts.locked, ['an']);
  assert.equal(store.find(u => u.id === 'a').lockReason, LOCK_REASON_RESIGNED);
  assert.equal(store.find(u => u.id === 'a').trangThai, 'Khóa');
  assert.equal(store.find(u => u.id === 'b').lockReason, 'manual', 'khóa thủ công giữ nguyên');
  assert.equal(store.find(u => u.id === 'c').trangThai, 'Đang hoạt động', 'tài khoản của người khác không bị đụng');
  assert.equal(calls.audit.length, 1);
});

test('chuyển lại Đang làm việc chỉ mở khóa tài khoản bị khóa vì hr_resigned', async () => {
  const { service, store } = setup({
    rows: [{ id: 1, branch: 'hanoi', hoTen: 'An', boPhan: 'KHO', email: 'an@x.com', soDienThoai: '0900000001', employmentStatus: 'resigned', createdAt: '' }],
    users: [
      { id: 'a', username: 'an', email: 'an@x.com', hrRowIndex: 1, vaiTro: 'Nhân viên kho', trangThai: 'Khóa', lockReason: LOCK_REASON_RESIGNED },
      { id: 'b', username: 'an2', email: 'an@x.com', hrRowIndex: 1, vaiTro: 'Nhân viên kho', trangThai: 'Khóa', lockReason: 'manual' }
    ]
  });
  const { accounts } = await service.updateEmployee(MANAGER, 1, { hoTen: 'An', boPhan: 'KHO', coSo: 'Hà Nội', email: 'an@x.com', soDienThoai: '0900000001', trangThai: 'active' });
  assert.deepEqual(accounts.unlocked, ['an']);
  assert.equal(store.find(u => u.id === 'a').trangThai, 'Đang hoạt động');
  assert.equal(store.find(u => u.id === 'a').lockReason, '');
  assert.equal(store.find(u => u.id === 'b').trangThai, 'Khóa');
});

test('không đổi trạng thái thì không đụng tài khoản', async () => {
  const { service, calls } = setup({
    users: [{ id: 'a', username: 'an', email: 'an@x.com', hrRowIndex: 1, vaiTro: 'Nhân viên kho', trangThai: 'Đang hoạt động', lockReason: '' }]
  });
  await service.updateEmployee(MANAGER, 1, { hoTen: 'An Mới', boPhan: 'KHO', coSo: 'Hà Nội', email: 'an@x.com', soDienThoai: '0900000001', trangThai: 'active' });
  assert.equal(calls.userUpdates.length, 0);
});

test('nghỉ việc trong hồ sơ nhân sự khóa tài khoản liên kết nhưng không đổi quyền', async () => {
  const { service, store, calls } = setup({
    users: [{ id: 'account-1', username: 'an', email: 'an@x.com', hrRowIndex: 1, vaiTro: 'Nhân viên kho', trangThai: 'Đang hoạt động', lockReason: '' }]
  });
  const { accounts } = await service.updateEmployee(MANAGER, 1, {
    ...valid, hoTen: 'An', email: 'an@x.com', soDienThoai: '0900000001', trangThai: 'Đã nghỉ việc'
  });
  assert.deepEqual(accounts, { locked: ['an'], unlocked: [], skipped: [] });
  assert.equal(store[0].trangThai, 'Khóa');
  assert.equal(store[0].vaiTro, 'Nhân viên kho');
  assert.equal(calls.userUpdates.length, 1);
});


test('sua nhan su luu day du ho so mo rong', async () => {
  const { service, db } = setup();
  await service.updateEmployee(MANAGER, 1, {
    ...valid, hoTen: 'An', email: 'an@x.com', soDienThoai: '0900000001',
    chucVu: 'Thủ kho', ngayVaoLam: '2024-01-02', ngaySinh: '1995-02-03', soCccd: '012345678901',
    diaChiHienTai: 'Hà Nội', nguoiThanQuanHe: 'Mẹ', nguoiThanHoTen: 'Bà A', nguoiThanSoDienThoai: '0900000009',
    gioiTinh: 'Nam', hoSoDayDu: true, vanTayDaDangKy: true, ngayNghiViec: ''
  });
  assert.equal(db[0].chucVu, 'Thủ kho');
  assert.equal(db[0].soCccd, '012345678901');
  assert.equal(db[0].hoSoDayDu, true);
});

test('số bảo hiểm nhận text tự do và giữ dấu chấm cuối', async () => {
  const { service, db } = setup();
  await service.updateEmployee(MANAGER, 1, {
    ...valid, hoTen: 'An', email: 'an@x.com', soDienThoai: '0900000001',
    insuranceNumber: '  HAN.D10.BVC.26.  '
  });
  assert.equal(db[0].insuranceNumber, 'HAN.D10.BVC.26.');
});

test('bộ phận cố định theo cơ sở: không nhập tay, nhận tên cũ và quy về tên chuẩn', async () => {
  const { service, db } = setup();
  const base = { hoTen: 'Chi', coSo: 'Hà Nội', email: 'chi@x.com', soDienThoai: '0900000003', trangThai: 'active' };
  await assert.rejects(service.createEmployee(MANAGER, { ...base, boPhan: 'Bộ phận tự nghĩ' }), err => err.code === 'INVALID_DEPARTMENT');
  await assert.rejects(service.createEmployee(MANAGER, { ...base, boPhan: 'Sale SG' }), err => err.code === 'INVALID_DEPARTMENT', 'bộ phận của Sài Gòn không dùng cho Hà Nội');
  await service.createEmployee(MANAGER, { ...base, boPhan: 'sale' });
  assert.equal(db.find(r => r.id === 99).boPhan, 'Sale HN');
});

test('sửa nhân sự có bộ phận cũ ngoài danh sách: giữ nguyên nếu không đổi, chặn nếu đổi sang tên tự nhập', async () => {
  const rows = [{ id: 5, branch: 'hanoi', hoTen: 'Dũng', boPhan: 'TRỰC PAGE', email: 'dung@x.com', soDienThoai: '0900000005', employmentStatus: 'active', createdAt: '2026-01-01T00:00:00Z' }];
  const { service, db } = setup({ rows });
  const body = { hoTen: 'Dũng', coSo: 'Hà Nội', email: 'dung@x.com', soDienThoai: '0900000005', trangThai: 'active' };
  await service.updateEmployee(MANAGER, '5', { ...body, boPhan: 'TRỰC PAGE' });
  assert.equal(db[0].boPhan, 'TRỰC PAGE');
  await assert.rejects(service.updateEmployee(MANAGER, '5', { ...body, boPhan: 'Page mới' }), err => err.code === 'INVALID_DEPARTMENT');
  await service.updateEmployee(MANAGER, '5', { ...body, boPhan: 'Marketing' });
  assert.equal(db[0].boPhan, 'Marketing');
});
