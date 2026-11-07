'use strict';

// Trang tai khoan: Quan ly THUONG (khong phai cap cao) mo dong cua Quan ly KHAC thi chi con sua
// ho ten/co so — an "Sua quyen", "Khoa tai khoan", khoa email/SDT va an doi mat khau (server
// accountPolicy.checkProtectedManager chan that; giao dien chi de khoi nham). Quan ly cap cao
// (isSeniorAdmin trong /api/auth/me) va thao tac tren nhan vien thuong / chinh minh khong bi anh huong.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const htmlPath = path.join(__dirname, '..', '..', 'public', 'account', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

const USERS = [
  { id: 'ql-1', username: 'quanly1', hoTen: 'Quản lý 1', email: 'ql1@example.com', soDienThoai: '', vaiTro: 'Quản lý', coSo: 'Cả hai', trangThai: 'Đang hoạt động', ngayTao: '01/01/2026' },
  { id: 'ql-2', username: 'quanly2', hoTen: 'Quản lý 2', email: 'ql2@example.com', soDienThoai: '0912345678', vaiTro: 'Quản lý', coSo: 'Cả hai', trangThai: 'Đang hoạt động', ngayTao: '02/01/2026' },
  { id: 'nv-1', username: 'nhanvien1', hoTen: 'Nhân viên 1', email: 'nv1@example.com', soDienThoai: '', telegramId: '9007199254740993', vaiTro: 'Nhân viên kho', coSo: 'Hà Nội', trangThai: 'Đang hoạt động', ngayTao: '03/01/2026' }
];

async function loadPage({ isSeniorAdmin, savedColumns, userId = 'ql-1' }) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual:true, url: 'https://tokosi.example/account/#users' });
  const { window } = dom;
  const permissions = ['account.profile', 'account.users', 'account.users.manage', 'account.permissions'];
  const me = { id: userId, username: 'quanly1', hoTen: 'Quản lý 1', vaiTro: 'Quản lý', isSeniorAdmin, permissions, branches: ['Hà Nội', 'Sài Gòn', 'Cả hai'] };
  window.TKSNav = {
    authGuard: async () => me,
    can: (...keys) => keys.some(key => permissions.includes(key)),
    renderTopSidebar() {},
    renderAccountChip() {},
    logout() {}
  };
  if (savedColumns) window.localStorage.setItem('tks-account-table-columns:' + userId, JSON.stringify(savedColumns));
  window.fetch = async url => {
    const target = String(url);
    if (target.includes('/api/admin/users/export/fields')) return { ok: true, status: 200, json: async () => ({ fields: require('../../auth/adminUserExportService').EXPORT_FIELDS.map(f => ({ key: f.key, label: f.label })), defaults: ['hoTen', 'username', 'email'] }) };
    if (target.includes('/api/admin/users')) return { ok: true, status: 200, json: async () => ({ users: USERS }) };
    if (target.includes('/api/admin/permissions/catalog')) return { ok: true, status: 200, json: async () => ({ groups: [], features: [], roleDefaults: {}, departments: ['KHO', 'KẾ TOÁN'] }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  window.eval(fs.readFileSync(path.join(__dirname,'../../public/shared/table-controls.js'),'utf8'));
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(script => script.trim() && !script.includes('src='))
    .forEach(script => window.eval(script));
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
  await settle();
  return dom;
}

function actionLabels(window, userId) {
  window.openUserActionModal(userId);
  // Moi nut: <span>Nhan<small>goi y</small></span> — chi lay phan nhan (text node dau tien).
  return [...window.document.querySelectorAll('#userActionList .action-menu-item')]
    .map(button => button.querySelector('span').firstChild.textContent.trim());
}

test('Quản lý thường mở dòng Quản lý khác: chỉ còn "Sửa thông tin cá nhân" (ẩn Sửa quyền và Khóa tài khoản)', async () => {
  const dom = await loadPage({ isSeniorAdmin: false });
  const labels = actionLabels(dom.window, 'ql-2');
  assert.deepEqual(labels, ['Sửa thông tin cá nhân']);
  dom.window.close();
});

test('Quản lý thường với nhân viên thường: đủ Sửa quyền / Sửa thông tin / Khóa như cũ', async () => {
  const dom = await loadPage({ isSeniorAdmin: false });
  const labels = actionLabels(dom.window, 'nv-1');
  assert.deepEqual(labels, ['Sửa quyền', 'Sửa thông tin cá nhân', 'Khóa tài khoản']);
  dom.window.close();
});

test('Quản lý cấp cao mở dòng Quản lý khác: đủ mọi thao tác', async () => {
  const dom = await loadPage({ isSeniorAdmin: true });
  const labels = actionLabels(dom.window, 'ql-2');
  assert.deepEqual(labels, ['Sửa quyền', 'Sửa thông tin cá nhân', 'Khóa tài khoản']);
  dom.window.close();
});

test('Quản lý thường: hộp sửa thông tin của Quản lý khác khóa email/SĐT và ẩn đặt lại mật khẩu; tự sửa mình thì không', async () => {
  const dom = await loadPage({ isSeniorAdmin: false });
  const { window } = dom;
  const doc = window.document;
  const passwordGroupHidden = () => doc.getElementById('editNewPassword').closest('.form-group').style.display === 'none'
    && doc.getElementById('editConfirmPassword').closest('.form-group').style.display === 'none';

  window.openEditUserModal('ql-2');
  assert.equal(doc.getElementById('editEmail').disabled, true);
  assert.equal(doc.getElementById('editPhone').disabled, true);
  assert.equal(doc.getElementById('editTelegramId').disabled, true);
  assert.equal(passwordGroupHidden(), true);
  assert.equal(doc.getElementById('editHoTen').disabled, false, 'van sua duoc ho ten');

  // Mo lai cho chinh minh (hoac nhan vien) phai tra ve trang thai binh thuong.
  window.openEditUserModal('ql-1');
  assert.equal(doc.getElementById('editEmail').disabled, false);
  assert.equal(doc.getElementById('editTelegramId').disabled, false);
  assert.equal(passwordGroupHidden(), false);
  window.openEditUserModal('ql-2');
  window.openEditUserModal('nv-1');
  assert.equal(doc.getElementById('editPhone').disabled, false);
  assert.equal(doc.getElementById('editTelegramId').disabled, false);
  assert.equal(passwordGroupHidden(), false);
  dom.window.close();
});

test('Quản lý cấp cao: hộp sửa thông tin của Quản lý khác vẫn đủ email/SĐT/mật khẩu', async () => {
  const dom = await loadPage({ isSeniorAdmin: true });
  const doc = dom.window.document;
  dom.window.openEditUserModal('ql-2');
  assert.equal(doc.getElementById('editEmail').disabled, false);
  assert.equal(doc.getElementById('editPhone').disabled, false);
  assert.equal(doc.getElementById('editTelegramId').disabled, false);
  assert.notEqual(doc.getElementById('editNewPassword').closest('.form-group').style.display, 'none');
  dom.window.close();
});

test('manager loads and saves or clears an employee Telegram ID without losing digits', async () => {
  const dom = await loadPage({ isSeniorAdmin: false });
  const { window } = dom;
  try {
    window.openEditUserModal('nv-1');
    const input = window.document.getElementById('editTelegramId');
    assert.ok(input);
    assert.equal(input.value, '9007199254740993');
    assert.equal(input.type, 'text');
    const posted = [];
    window.fetch = async (url, options = {}) => {
      if (options.method === 'PUT') {
        posted.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ user: { ...USERS[2], ...posted.at(-1).body } }) };
      }
      return { ok: true, json: async () => ({ users: USERS }) };
    };
    input.value = ' 6205968899 ';
    window.handleSaveEditUser({ preventDefault() {} });
    await settle();
    assert.equal(posted[0].url, '/api/admin/users/nv-1');
    assert.equal(posted[0].body.telegramId, '6205968899');
    window.openEditUserModal('nv-1');
    input.value = '';
    window.handleSaveEditUser({ preventDefault() {} });
    await settle();
    assert.equal(posted[1].body.telegramId, '');
    window.openEditUserModal('ql-2');
    window.handleSaveEditUser({ preventDefault() {} });
    await settle();
    assert.equal(Object.hasOwn(posted[2].body, 'telegramId'), false, 'disabled Telegram ID must not be submitted');
  } finally { window.close(); }
});


test('user table separates name and username by default while offering every Excel field', async () => {
  const dom = await loadPage({ isSeniorAdmin: true });
  const { window } = dom;
  try {
    assert.equal(window.document.getElementById('userStatusFilter').value, 'Đang hoạt động');
    assert.deepEqual([...window.document.querySelectorAll('#usersTable th:not(.tks-column-hidden)')].map(th => th.dataset.field), ['hoTen', 'username', 'vaiTro', 'coSo', 'trangThai']);
    const row=window.document.querySelector('#usersTableBody tr[data-uid="nv-1"]');
    assert.equal(row.cells[0].querySelector('.user-name').textContent.trim(),'Nhân viên 1');
    assert.equal(row.cells[0].querySelector('.user-username'),null,'Account must not appear below the name');
    assert.equal(row.cells[1].textContent.trim(),'@nhanvien1');
    assert.equal(row.querySelectorAll('td:not(.tks-column-hidden)').length,5);
    window.handleSort('username');
    assert.deepEqual([...window.document.querySelectorAll('#usersTableBody tr')].map(tr=>tr.dataset.uid),['nv-1','ql-1','ql-2']);
    window.document.getElementById('usersColumnsBtn').click();
    const fields = require('../../auth/adminUserExportService').EXPORT_FIELDS;
    assert.equal(window.document.querySelectorAll('.tks-columns-list input').length, fields.length);
    assert.equal(window.document.querySelector('.tks-columns-list input[data-column-key=hoTen]').disabled, true);
    const tools=window.document.getElementById('usersColumnsBtn').parentElement;
    assert.equal(tools.lastElementChild.id,'btnExportUsers');
    assert.ok(tools.closest('.users-table-panel'));
    assert.equal(window.document.querySelectorAll('#usersTable').length,1);
    assert.equal(tools.querySelectorAll('.tks-columns-button').length,1);
    assert.equal(window.document.querySelectorAll('#usersColumnsBtn').length,1);
    assert.equal(window.document.querySelector('[onclick="openUserColumnsModal()"]'),null);
  } finally { dom.window.close(); }
});

test('shared account picker ignores stored choices, keeps session choices through redraw and resets hidden sorting', async () => {
  const dom = await loadPage({ isSeniorAdmin: true, savedColumns: ['email', 'telegramId'] });
  const { window } = dom;
  try {
    const visible=()=>[...window.document.querySelectorAll('#usersTable th:not(.tks-column-hidden)')].map(th=>th.dataset.field);
    assert.deepEqual(visible(),['hoTen','username','vaiTro','coSo','trangThai']);
    window.localStorage.setItem('tks-account-export-fields', '["username"]');
    window.document.getElementById('usersColumnsBtn').click();
    const toggle=key=>window.document.querySelector('.tks-columns-list input[data-column-key='+key+']').click();
    toggle('email');
    window.handleSort('email');
    toggle('email'); toggle('username');
    window.document.querySelector('.tks-columns-picker [data-action=close]').click();
    window.handleFilterUsers();
    assert.deepEqual(visible(),['hoTen','vaiTro','coSo','trangThai']);
    assert.equal(window.document.getElementById('sort-hoTen').textContent, '▲ 1', 'tang dan = ▼ (giam dan ▲, chua sap ▲▼)');
    assert.equal(window.localStorage.getItem('tks-account-export-fields'), '["username"]');
    assert.deepEqual(JSON.parse(window.localStorage.getItem('tks-account-table-columns:ql-1')), ['email', 'telegramId'],'Picker must not write persistent settings');
    const other = await loadPage({ isSeniorAdmin: true, userId: 'different-account' });
    assert.deepEqual([...other.window.document.querySelectorAll('#usersTable th:not(.tks-column-hidden)')].map(th => th.dataset.field), ['hoTen', 'username', 'vaiTro', 'coSo', 'trangThai']);
    other.window.close();
  } finally { dom.window.close(); }
});


test('department selection defaults first staff grant to own department, retains explicit scope, and posts create selection', async () => {
  const dom = await loadPage({ isSeniorAdmin: true });
  const { window } = dom;
  try {
    await window.loadPermissionsCatalog();
    window.renderDepartmentSelection('permLeaveDepartments', { boPhan: 'KẾ TOÁN', leaveApprovalDepartments: [] });
    assert.equal(window.document.querySelector('#permLeaveDepartments input[value="KẾ TOÁN"]').checked, true);
    window.renderDepartmentSelection('editLeaveDepartments', { boPhan: 'KẾ TOÁN', leaveApprovalDepartments: ['KHO'] });
    assert.equal(window.document.querySelector('#editLeaveDepartments input[value=KHO]').checked, true);
    assert.equal(window.document.querySelector('#editLeaveDepartments input[value="KẾ TOÁN"]').checked, false);
    window.openCreateUserModal();
    await settle();
    const doc = window.document;
    doc.getElementById('createUsername').value = 'new-manager';
    doc.getElementById('createPassword').value = 'password123';
    doc.getElementById('createHoTen').value = 'New manager';
    doc.getElementById('createVaiTro').value = 'Quản lý';
    doc.querySelector('#createLeaveDepartments input[value=KHO]').checked = true;
    const posted = [];
    window.fetch = async (url, options = {}) => { if (options.method) posted.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ users: USERS }) }; };
    window.handleCreateUser({ preventDefault() {} });
    await settle();
    assert.deepEqual(posted[0].leaveApprovalDepartments, ['KHO']);
  } finally { dom.window.close(); }
});
