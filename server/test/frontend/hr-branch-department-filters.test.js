'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

// TKSNav that dung TKSNav.can(<quyen>) (nguon: user.permissions tu /api/auth/me)
// thay cho kiem tra vai tro cung — mock phai co ham do, lay dung quyen mac dinh
// cua vai tro tu server/auth/featureRegistry.js.
const { defaultsForRole } = require('../../auth/featureRegistry');
function fakeCan(vaiTro) {
  const permissions = defaultsForRole(vaiTro);
  return (...keys) => keys.some(key => (Array.isArray(key) ? key : [key]).some(k => permissions.includes(k)));
}


const htmlPath = path.join(__dirname, '..', '..', 'public', 'humanresources', 'index.html');

const EMPLOYEES = [
  { hoTen: 'An Kho', boPhan: 'KHO', coSo: 'Hà Nội', soDienThoai: '0900000001', email: 'a@x.com' },
  { hoTen: 'Bình Sale', boPhan: 'SALE', coSo: 'Hà Nội', soDienThoai: '0900000002', email: 'b@x.com' },
  { hoTen: 'Cường Kho', boPhan: 'KHO ', coSo: 'Sài Gòn', soDienThoai: '0900000003', email: 'c@x.com' },
  { hoTen: 'Dũng Trợ Lý', boPhan: 'TRỢ LÝ', coSo: 'Sài Gòn', soDienThoai: '0900000004', email: 'd@x.com' },
  { hoTen: 'Em Kho', boPhan: 'kho', coSo: 'Hà Nội', soDienThoai: '0900000005', email: 'e@x.com' }
];

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

async function openPage({ branches = ['Hà Nội', 'Sài Gòn'] } = {}) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/humanresources/' });
  const { window } = dom;
  const requestedUrls = [];
  window.TKSNav = {
    authGuard: async () => ({ username: 'manager', vaiTro: 'Quản lý', branches }),
    can: fakeCan('Quản lý'),
    renderTopSidebar() {}
  };
  window.fetch = async url => {
    const text = String(url);
    requestedUrls.push(text);
    const payload = text.startsWith('/api/hr/employees') ? { employees: EMPLOYEES }
      : text.includes('/summary/') ? { summary: [] }
        : { requests: [] };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload, text: async () => JSON.stringify(payload) };
  };
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.trim())
    .forEach(script => window.eval(script));
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
  await tick();
  await tick();
  return { dom, window, requestedUrls };
}

const optionValues = select => [...select.options].map(option => option.value);

test('thống kê chỉ đếm đơn còn buổi nghỉ từ hôm nay theo giờ Việt Nam', async () => {
  const { dom, window } = await openPage();
  try {
    const RealDate = window.Date;
    window.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ['2026-11-04T17:05:00Z'])); }
    };
    const row = { bo_phan: 'KHO', trang_thai: 'Đã duyệt', start_date: '2026-11-01', end_date: '2026-11-10' };
    const requests = [
      { ...row, end_date: '2026-11-04' },
      { ...row, leave_sessions: [{ date: '2026-11-04' }] },
      { ...row, leave_sessions: [{ date: '2026-11-05' }] },
      { ...row, leave_sessions: [{ date: '2026-11-04' }, { date: '2026-11-08' }] },
      { ...row },
      { ...row, trang_thai: 'Chưa duyệt', start_date: '2026-11-06' },
      { ...row, trang_thai: 'Từ chối', timing_status: 'Vi phạm', start_date: '2026-11-06' }
    ];
    window.renderStats(requests);
    const doc = window.document;
    assert.equal(doc.getElementById('statApproved').textContent, '3');
    assert.equal(doc.getElementById('statPending').textContent, '1');
    assert.equal(doc.getElementById('statRejected').textContent, '1');
    assert.equal(doc.getElementById('statViolation').textContent, '1');
    assert.match(doc.getElementById('leaveDeptStats').textContent, /5đơn/);
    assert.match(doc.getElementById('leaveDeptRange').textContent, /Từ hôm nay/);
    assert.equal(window.visibleLeaveRequests(requests).length, 1, 'bảng vẫn dùng bộ lọc trạng thái hiện có');

    doc.getElementById('fromDateFilter').value = '2026-11-07';
    doc.getElementById('toDateFilter').value = '2026-11-07';
    window.renderStats(requests);
    assert.equal(doc.getElementById('statApproved').textContent, '1', 'đơn cách quãng không có buổi ngày 7 bị loại');
    doc.getElementById('toDateFilter').value = '2026-11-04';
    window.renderStats(requests);
    assert.equal(doc.getElementById('statApproved').textContent, '0');
  } finally { dom.window.close(); }
});
const listUrls = urls => urls.filter(url => url.startsWith('/api/hr/leave-requests?'));

// JSDOM (runScripts: 'outside-only') không chạy thuộc tính onchange inline, nên chạy đúng
// handler khai báo trên phần tử để mô phỏng người dùng đổi lựa chọn.
function choose(window, id, value) {
  const select = window.document.getElementById(id);
  select.value = value;
  window.eval(select.getAttribute('onchange'));
}

test('tab Nghỉ phép có bộ lọc Cơ sở và Phòng ban, mặc định "Tất cả" và không gửi tham số lọc', async () => {
  const { dom, window, requestedUrls } = await openPage();
  const branch = window.document.getElementById('branchFilter');
  const department = window.document.getElementById('departmentFilter');

  assert.equal(branch.value, '');
  assert.equal(department.value, '');
  assert.equal(branch.options[0].textContent, 'Tất cả cơ sở');
  assert.equal(department.options[0].textContent, 'Tất cả phòng ban');
  assert.deepEqual(optionValues(branch), ['', 'Hà Nội', 'Sài Gòn'], 'cơ sở lấy từ các cơ sở tài khoản được xem');
  assert.deepEqual(optionValues(department), ['', 'KHO', 'SALE', 'TRỢ LÝ'], 'phòng ban gộp KHO/"KHO "/kho, sắp xếp theo tên');

  const query = new URL(listUrls(requestedUrls)[0], window.location.origin).searchParams;
  assert.equal(query.has('branch'), false);
  assert.equal(query.has('department'), false);
  dom.window.close();
});

test('tab Nghỉ phép gửi cơ sở/phòng ban đã chọn lên API và giới hạn phòng ban theo cơ sở', async () => {
  const { dom, window, requestedUrls } = await openPage();

  choose(window, 'departmentFilter', 'SALE');
  await tick();
  let query = new URL(listUrls(requestedUrls).at(-1), window.location.origin).searchParams;
  assert.equal(query.get('department'), 'SALE');
  assert.equal(query.has('branch'), false);

  choose(window, 'branchFilter', 'Sài Gòn');
  await tick();
  assert.deepEqual(optionValues(window.document.getElementById('departmentFilter')), ['', 'KHO', 'TRỢ LÝ'], 'chỉ phòng ban của Sài Gòn');
  assert.equal(window.document.getElementById('departmentFilter').value, '', 'SALE không thuộc Sài Gòn nên quay về Tất cả');
  query = new URL(listUrls(requestedUrls).at(-1), window.location.origin).searchParams;
  assert.equal(query.get('branch'), 'Sài Gòn');
  assert.equal(query.has('department'), false);

  choose(window, 'departmentFilter', 'KHO');
  await tick();
  query = new URL(listUrls(requestedUrls).at(-1), window.location.origin).searchParams;
  assert.equal(query.get('branch'), 'Sài Gòn');
  assert.equal(query.get('department'), 'KHO');
  dom.window.close();
});

test('tab Danh sách nhân sự hiện cột Cơ sở và lọc theo cơ sở/phòng ban, mặc định Tất cả', async () => {
  const { dom, window } = await openPage();
  const doc = window.document;
  const names = () => [...doc.querySelectorAll('#employeeDirectoryTableBody tr')].map(tr => tr.cells[0].textContent);

  const headers = [...doc.querySelectorAll('#employeeDirectoryTable thead th')].filter(th => !th.hidden).map(th => th.textContent.replace(/[↕▲▼]/g, '').trim());
  assert.deepEqual(headers, ['Họ và tên', 'Bộ phận', 'Cơ sở', 'Số điện thoại', 'Trạng thái']);
  assert.equal(doc.getElementById('employeeBranchFilter').value, '');
  assert.equal(doc.getElementById('employeeDepartmentFilter').value, '');
  assert.deepEqual(names(), ['An Kho', 'Bình Sale', 'Cường Kho', 'Dũng Trợ Lý', 'Em Kho']);
  assert.equal(doc.querySelector('#employeeDirectoryTableBody tr').cells[2].textContent, 'Hà Nội');

  choose(window, 'employeeDepartmentFilter', 'KHO');
  assert.deepEqual(names(), ['An Kho', 'Cường Kho', 'Em Kho'], 'KHO, "KHO " và kho là cùng một phòng ban');

  choose(window, 'employeeBranchFilter', 'Sài Gòn');
  assert.deepEqual(names(), ['Cường Kho']);

  choose(window, 'employeeBranchFilter', 'Hà Nội');
  assert.deepEqual(optionValues(doc.getElementById('employeeDepartmentFilter')), ['', 'KHO', 'SALE']);
  assert.deepEqual(names(), ['An Kho', 'Em Kho']);

  choose(window, 'employeeDepartmentFilter', '');
  choose(window, 'employeeBranchFilter', '');
  assert.equal(names().length, 5, 'chọn lại Tất cả thì hiện đủ');
  dom.window.close();
});

test('hai tab lọc độc lập: đổi bộ lọc ở Danh sách nhân sự không đổi bộ lọc Nghỉ phép', async () => {
  const { dom, window } = await openPage();
  choose(window, 'employeeBranchFilter', 'Sài Gòn');
  assert.equal(window.document.getElementById('branchFilter').value, '');
  dom.window.close();
});

test('xuất Excel gửi kèm cơ sở/phòng ban đang lọc', async () => {
  const { dom, window, requestedUrls } = await openPage();
  choose(window, 'employeeBranchFilter', 'Hà Nội');
  choose(window, 'employeeDepartmentFilter', 'SALE');

  window.fetch = async (url, options) => {
    requestedUrls.push(String(url));
    window.__lastOptions = options;
    return { ok: false, status: 500, headers: { get: () => 'application/json' }, json: async () => ({ error: 'stop' }), text: async () => '{}' };
  };
  await window.exportEmployeeDirectoryExcel();
  const exportUrl = requestedUrls.at(-1);
  const params = new URL(exportUrl, window.location.origin).searchParams;
  assert.equal(params.get('branch'), 'Hà Nội');
  assert.equal(params.get('department'), 'SALE');

  choose(window, 'branchFilter', 'Sài Gòn');
  choose(window, 'departmentFilter', 'KHO');
  await window.exportLeaveExcel();
  const payload = JSON.parse(window.__lastOptions.body);
  assert.equal(payload.branch, 'Sài Gòn');
  assert.equal(payload.department, 'KHO');
  dom.window.close();
});

test('matchesLeaveScope: sự kiện realtime ngoài cơ sở/phòng ban đang lọc không chen vào bảng', async () => {
  const { dom, window } = await openPage();
  const row = { co_so: 'Sài Gòn', bo_phan: 'kho ' };

  assert.equal(window.matchesLeaveScope(row), true, 'mặc định Tất cả nhận mọi đơn');
  choose(window, 'branchFilter', 'Hà Nội');
  assert.equal(window.matchesLeaveScope(row), false);
  choose(window, 'branchFilter', 'Sài Gòn');
  choose(window, 'departmentFilter', 'KHO');
  assert.equal(window.matchesLeaveScope(row), true);
  assert.equal(window.matchesLeaveScope({ co_so: 'Sài Gòn', bo_phan: 'SALE' }), false);
  dom.window.close();
});

// ---------------------------------------------------------------------------
// /api/auth/me tra `branches` = selectableBranches(user), tuc co ca "Cả hai"
// cho tai khoan hai co so. Day la LUA CHON GIAO DIEN cua thanh dieu huong,
// khong phai mot co so loc duoc — server tu choi no bang 400 INVALID_BRANCH.
// ---------------------------------------------------------------------------

const BRANCHES_WITH_BOTH = ['Hà Nội', 'Sài Gòn', 'Cả hai'];

test('bộ lọc Cơ sở không chào "Cả hai" (đã có sẵn "Tất cả cơ sở")', async () => {
  const { dom, window } = await openPage({ branches: BRANCHES_WITH_BOTH });

  assert.deepEqual(optionValues(window.document.getElementById('branchFilter')), ['', 'Hà Nội', 'Sài Gòn']);
  assert.deepEqual(optionValues(window.document.getElementById('employeeBranchFilter')), ['', 'Hà Nội', 'Sài Gòn']);
  dom.window.close();
});

test('bộ lọc Cơ sở nhận giá trị "Cả hai": hiểu là Tất cả, không gửi tham số branch lên API', async () => {
  const { dom, window, requestedUrls } = await openPage({ branches: BRANCHES_WITH_BOTH });
  const select = window.document.getElementById('branchFilter');
  // Mo phong gia tri "Cả hai" lot vao o loc (vd tu ban HTML cu dang mo trong tab khac).
  select.insertAdjacentHTML('beforeend', '<option value="Cả hai">Cả hai</option>');
  choose(window, 'branchFilter', 'Cả hai');
  await tick();

  const query = new URL(listUrls(requestedUrls).at(-1), window.location.origin).searchParams;
  assert.equal(query.has('branch'), false, '"Cả hai" không được gửi xuống server');
  assert.deepEqual(
    optionValues(window.document.getElementById('departmentFilter')),
    ['', 'KHO', 'SALE', 'TRỢ LÝ'],
    'phòng ban vẫn gộp cả hai cơ sở'
  );
  dom.window.close();
});

test('matchesLeaveScope: đang lọc "Cả hai" vẫn nhận sự kiện realtime của cả hai cơ sở', async () => {
  const { dom, window } = await openPage({ branches: BRANCHES_WITH_BOTH });
  const select = window.document.getElementById('branchFilter');
  select.insertAdjacentHTML('beforeend', '<option value="Cả hai">Cả hai</option>');
  choose(window, 'branchFilter', 'Cả hai');

  assert.equal(window.matchesLeaveScope({ co_so: 'Hà Nội', bo_phan: 'KHO' }), true);
  assert.equal(window.matchesLeaveScope({ co_so: 'Sài Gòn', bo_phan: 'KHO' }), true);
  dom.window.close();
});

test('xuất Excel khi đang lọc "Cả hai": không gửi cơ sở "Cả hai" xuống server', async () => {
  const { dom, window, requestedUrls } = await openPage({ branches: BRANCHES_WITH_BOTH });
  ['branchFilter', 'employeeBranchFilter'].forEach(id => {
    const select = window.document.getElementById(id);
    select.insertAdjacentHTML('beforeend', '<option value="Cả hai">Cả hai</option>');
  });
  choose(window, 'employeeBranchFilter', 'Cả hai');
  choose(window, 'branchFilter', 'Cả hai');
  await tick();

  window.fetch = async (url, options) => {
    requestedUrls.push(String(url));
    window.__lastOptions = options;
    return { ok: false, status: 500, headers: { get: () => 'application/json' }, json: async () => ({ error: 'stop' }), text: async () => '{}' };
  };
  await window.exportEmployeeDirectoryExcel();
  assert.equal(new URL(requestedUrls.at(-1), window.location.origin).searchParams.has('branch'), false);

  await window.exportLeaveExcel();
  assert.equal(JSON.parse(window.__lastOptions.body).branch, '');
  dom.window.close();
});

test('danh sách nhân sự lọc "Cả hai": hiện nhân sự của cả hai cơ sở', async () => {
  const { dom, window } = await openPage({ branches: BRANCHES_WITH_BOTH });
  const doc = window.document;
  doc.getElementById('employeeBranchFilter').insertAdjacentHTML('beforeend', '<option value="Cả hai">Cả hai</option>');
  choose(window, 'employeeBranchFilter', 'Cả hai');

  const names = [...doc.querySelectorAll('#employeeDirectoryTableBody tr')].map(tr => tr.cells[0].textContent);
  assert.deepEqual(names, ['An Kho', 'Bình Sale', 'Cường Kho', 'Dũng Trợ Lý', 'Em Kho']);
  dom.window.close();
});
