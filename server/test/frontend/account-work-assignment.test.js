'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../../public/account/index.html'), 'utf8');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
async function page() {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/account/#users' });
  const w = dom.window;
  const permissions = ['account.profile', 'account.users', 'account.users.manage', 'account.permissions'];
  const user = { id: 'staff', username: 'staff', hoTen: 'Assistant', vaiTro: 'Trợ lý', coSo: 'Cả hai', workCoSo: 'Hà Nội', boPhan: 'Kế toán', trangThai: 'Đang hoạt động', featurePermissions: { 'hr.leave.manage': true }, leaveApprovalDepartments: ['Kho HN'] };
  const guest = { id: 'guest', username: 'guest', hoTen: 'Guest', vaiTro: 'Khách', coSo: '', workCoSo: '', boPhan: '', trangThai: 'Đang hoạt động' };
  const catalog = { features: [], groups: [], roleDefaults: { 'Quản lý': ['hr.leave.manage'], 'Trợ lý': [] }, departments: ['Kế toán', 'Kho HN', 'Kho SG'], departmentsByBranch: { 'Hà Nội': ['Kế toán', 'Kho HN'], 'Sài Gòn': ['Kho SG', 'Sale SG'] }, suggestedDepartmentByRole: { 'Hà Nội': { 'Kế toán': 'Kế toán', 'Nhân viên kho': 'Kho HN' }, 'Sài Gòn': { 'Nhân viên kho': 'Kho SG' } } };
  w.TKSNav = { authGuard: async () => ({ id: 'admin', username: 'admin', vaiTro: 'Quản lý', isSeniorAdmin: true, permissions }), can: (...keys) => keys.some(key => permissions.includes(key)), renderTopSidebar() {}, renderAccountChip() {} };
  const posted = [];
  w.fetch = async (url, opts = {}) => {
    if (opts.method === 'POST' || opts.method === 'PUT') { posted.push(JSON.parse(opts.body)); return { ok: true, status: 200, json: async () => ({ user: { ...user, ...posted.at(-1) } }) }; }
    return { ok: true, status: 200, json: async () => String(url).includes('/permissions/catalog') ? catalog : String(url).includes('/api/admin/users') ? { users: [user, guest] } : {} };
  };
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) w.eval(match[1]);
  w.dispatchEvent(new w.Event('DOMContentLoaded'));
  await settle();
  return { dom, w, doc: w.document, posted };
}
test('create selects independent workplace and department, refreshes branch options, and submits both', async () => {
  const { dom, w, doc, posted } = await page();
  try {
    w.openCreateUserModal(); await settle();
    assert.ok(doc.getElementById('createWorkCoSo'), 'physical workplace select');
    assert.ok(doc.getElementById('createBoPhan'), 'membership select');
    assert.equal(doc.querySelector('label[for="createCoSo"]').textContent, 'Phạm vi phụ trách');
    const role = doc.getElementById('createVaiTro');
    role.value = 'Trợ lý'; role.dispatchEvent(new w.Event('change'));
    const branch = doc.getElementById('createWorkCoSo');
    branch.value = 'Hà Nội'; branch.dispatchEvent(new w.Event('change'));
    const department = doc.getElementById('createBoPhan');
    department.value = 'Kế toán';
    role.value = 'Kế toán'; role.dispatchEvent(new w.Event('change'));
    assert.equal(department.value, 'Kế toán', 'role change preserves membership');
    branch.value = 'Sài Gòn'; branch.dispatchEvent(new w.Event('change'));
    assert.equal(department.value, '', 'new branch requires selection');
    assert.deepEqual([...department.options].map(option => option.value), ['', 'Kho SG', 'Sale SG']);
    branch.value = 'Hà Nội'; branch.dispatchEvent(new w.Event('change')); department.value = 'Kế toán';
    for (const [id, value] of Object.entries({ createUsername: 'assistant', createPassword: 'password123', createHoTen: 'Assistant', createCoSo: 'Cả hai' })) doc.getElementById(id).value = value;
    w.handleCreateUser({ preventDefault() {} }); await settle();
    assert.equal(posted[0].workCoSo, 'Hà Nội'); assert.equal(posted[0].boPhan, 'Kế toán'); assert.equal(posted[0].coSo, 'Cả hai');
    role.value = 'Khách'; role.dispatchEvent(new w.Event('change'));
    assert.equal(branch.value, 'Hà Nội'); assert.equal(department.value, 'Kế toán'); assert.equal(branch.required, false);
  } finally { dom.window.close(); }
});
test('edit preloads account workplace and keeps approval scope separate in payload', async () => {
  const { dom, w, doc, posted } = await page();
  try {
    w.openEditUserModal('staff'); await settle();
    assert.equal(doc.getElementById('editWorkCoSo')?.value, 'Hà Nội');
    assert.equal(doc.getElementById('editBoPhan')?.value, 'Kế toán');
    assert.equal(doc.getElementById('editLeaveDepartments').closest('.form-group').hidden, true);
    w.handleSaveEditUser({ preventDefault() {} }); await settle();
    assert.equal(posted[0].workCoSo, 'Hà Nội'); assert.equal(posted[0].boPhan, 'Kế toán');
    assert.deepEqual(posted[0].leaveApprovalDepartments, ['Kho HN']);
  } finally { dom.window.close(); }
});

test('edit can promote a guest while assigning the required workplace in the same save', async () => {
  const { dom, w, doc, posted } = await page();
  try {
    w.openEditUserModal('guest'); await settle();
    const role = doc.getElementById('editVaiTro');
    assert.ok(role, 'role selector available alongside workplace');
    assert.equal(doc.getElementById('editWorkCoSo').disabled, false);
    role.value = 'Trợ lý'; role.dispatchEvent(new w.Event('change'));
    const branch = doc.getElementById('editWorkCoSo');
    assert.equal(branch.disabled, false);
    branch.value = 'Hà Nội'; branch.dispatchEvent(new w.Event('change'));
    doc.getElementById('editBoPhan').value = 'Kế toán';
    w.handleSaveEditUser({ preventDefault() {} }); await settle();
    assert.equal(posted[0].vaiTro, 'Trợ lý');
    assert.equal(posted[0].workCoSo, 'Hà Nội'); assert.equal(posted[0].boPhan, 'Kế toán');
  } finally { dom.window.close(); }
});
test('create form orders fields by dependency, marks required work fields and suggests department by role', async () => {
  const { dom, w, doc, posted } = await page();
  try {
    w.openCreateUserModal(); await settle();
    const ids = [...doc.querySelectorAll('#createUserForm [id^="create"]')].map(el => el.id);
    const order = ['createTelegramId', 'createVaiTro', 'createWorkCoSo', 'createBoPhan', 'createCoSo', 'createLeaveDepartments'].map(id => ids.indexOf(id));
    assert.ok(order.every(i => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]), 'role → workplace → department → scope → approval');
    const role = doc.getElementById('createVaiTro');
    const branch = doc.getElementById('createWorkCoSo');
    const department = doc.getElementById('createBoPhan');
    const marks = () => [...doc.querySelectorAll('.req-mark[data-req-for="create"]')].map(mark => mark.hidden);
    assert.deepEqual(marks(), [true, true], 'guest default hides required marks');
    role.value = 'Nhân viên kho'; role.dispatchEvent(new w.Event('change'));
    assert.deepEqual(marks(), [false, false]);
    branch.value = 'Hà Nội'; branch.dispatchEvent(new w.Event('change'));
    assert.equal(department.value, 'Kho HN', 'suggested from role');
    branch.value = 'Sài Gòn'; branch.dispatchEvent(new w.Event('change'));
    assert.equal(department.value, 'Kho SG', 'suggestion follows workplace');
    department.value = 'Sale SG'; department.dispatchEvent(new w.Event('change'));
    role.value = 'Kế toán'; role.dispatchEvent(new w.Event('change'));
    assert.equal(department.value, 'Sale SG', 'manual choice is never overwritten');
    doc.getElementById('createUsername').value = 'kho1';
    doc.getElementById('createPassword').value = 'password123';
    doc.getElementById('createHoTen').value = 'Kho';
    doc.getElementById('createTelegramId').value = ' 6205968899 ';
    w.handleCreateUser({ preventDefault() {} }); await settle();
    assert.equal(posted.at(-1).telegramId, '6205968899');
  } finally { dom.window.close(); }
});
test('approval scope is shown only for managers and preserves selection across role changes', async () => {
  const { dom, w, doc } = await page();
  try {
    w.openCreateUserModal(); await settle();
    const role = doc.getElementById('createVaiTro');
    const group = doc.getElementById('createLeaveDepartments').closest('.form-group');
    for (const value of ['Nhân viên kho', 'Trợ lý', 'Nhân viên sale']) {
      role.value = value; role.dispatchEvent(new w.Event('change'));
      assert.equal(group.hidden, true, value);
      assert.ok([...group.querySelectorAll('input')].some(input => !input.disabled), value);
    }
    role.value = 'Quản lý'; role.dispatchEvent(new w.Event('change'));
    assert.equal(group.hidden, false);
    group.querySelector('input').checked = true;
    role.value = 'Khách'; role.dispatchEvent(new w.Event('change'));
    assert.equal(group.hidden, true);
    assert.ok([...group.querySelectorAll('input')].some(input => !input.disabled && input.checked));
    role.value = 'Nhân viên kho'; role.dispatchEvent(new w.Event('change'));
    assert.ok([...group.querySelectorAll('input')].some(input => !input.disabled));
  } finally { dom.window.close(); }
});
