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

async function calendarPage(t) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://tokosi.example/humanresources/#leave' });
  const { window } = dom;
  const RealDate = window.Date;
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : ['2026-10-02T01:00:00Z'])); }
  };
  t.after(async () => {
    window.dispatchEvent(new window.Event('pagehide'));
    await new Promise(resolve => setTimeout(resolve, 0));
    window.close();
  });
  const sources = [];
  const urls = [];
  const regular = {
    request_id: 'regular', ho_ten: 'Nguyễn A', web_username: 'nguyena', bo_phan: 'SALE', co_so: 'Hà Nội',
    trang_thai: 'Chưa duyệt', start_date: '2026-10-02', end_date: '2026-10-04',
    start_session: 'Sáng', end_session: 'Chiều', tong_buoi_nghi: 6, tong_ngay_nghi: 3
  };
  const requests = [regular, { ...regular, request_id: 'gap', leave_sessions: [
    { date: '2026-10-02', session: 'Sáng' }, { date: '2026-10-04', session: 'Chiều' }
  ] }, { ...regular, request_id: 'approved', trang_thai: 'Đã duyệt' }];
  window.fetch = async url => {
    urls.push(String(url));
    const payload = String(url).includes('/summary/') ? { summary: [] } : { requests };
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload };
  };
  window.EventSource = class { constructor() { sources.push(this); } close() { this.closed = true; } };
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/shared/shared-nav.js'), 'utf8'));
  window.TKSNav._now = () => new Date(2026, 9, 2);
  const user = { username: 'manager', permissions: ['hr.leave', 'hr.leave.manage'], branches: ['Hà Nội', 'Sài Gòn'] };
  window.TKSNav.setPermissions(user);
  window.TKSNav.authGuard = async () => user;
  window.TKSNav.renderTopSidebar = () => {};
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(script => script.trim()).forEach(script => window.eval(
      script + (script.includes('const leavePaging') ? '\nwindow.__testLeavePaging = leavePaging;' : '')
    ));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { window, document: window.document, sources, urls, regular };
}

test('embedded day click keeps filters, resets pagination and excludes actual session gaps from table and KPIs', async t => {
  const { window, document, urls } = await calendarPage(t);
  assert.equal(document.getElementById('fromDateFilter').value, '');
  assert.equal(document.getElementById('statusFilter').value, 'Chưa duyệt');
  document.getElementById('employeeSearchInput').value = 'Nguyễn';
  document.getElementById('branchFilter').value = 'Hà Nội';
  document.getElementById('departmentFilter').innerHTML += '<option value="SALE">SALE</option>';
  document.getElementById('departmentFilter').value = 'SALE';
  window.__testLeavePaging.page = 4;
  document.querySelector('#leaveCalendar [data-date="2026-10-03"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.getElementById('fromDateFilter').value, '2026-10-03');
  assert.equal(document.getElementById('toDateFilter').value, '2026-10-03');
  assert.equal(window.__testLeavePaging.page, 1);
  const query = new URL(urls.filter(url => url.startsWith('/api/hr/leave-requests?')).at(-1), window.location.origin).searchParams;
  assert.equal(query.get('employee'), null);
  assert.equal(query.get('branch'), 'Hà Nội');
  assert.equal(query.get('department'), 'SALE');
  assert.equal(document.getElementById('statusFilter').value, 'Chưa duyệt');
  assert.deepEqual([...document.querySelectorAll('#leaveTableBody [data-request-id]')].map(row => row.dataset.requestId), ['regular']);
  assert.equal(document.getElementById('statPending').textContent, '1');
  assert.equal(document.getElementById('statApproved').textContent, '1');
});

test('manual single-day filters synchronize calendar; multiple days clear selection; leaving subtab stops calendar', async t => {
  const { window, document, sources } = await calendarPage(t);
  document.getElementById('fromDateFilter').value = '2027-02-05';
  document.getElementById('toDateFilter').value = '2027-02-05';
  window.handleFilterChange();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.querySelector('#leaveCalendar .is-selected').dataset.date, '2027-02-05');
  document.getElementById('toDateFilter').value = '2027-02-06';
  window.handleFilterChange();
  assert.equal(document.querySelector('#leaveCalendar .is-selected'), null);
  window.TKSNav.setPermissions({ permissions: ['hr.leave', 'hr.rules'] });
  window.switchHrSubtab('quydinh');
  assert.equal(sources[0].closed, true);
  const count = sources.length;
  window.switchHrSubtab('leave');
  assert.equal(sources.length, count + 1);
});

test('SSE date changes remove a request that no longer has a session on the selected day', async t => {
  const { window, document, sources, regular } = await calendarPage(t);
  document.querySelector('#leaveCalendar [data-date="2026-10-03"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));
  const tableStream = sources[1];
  tableStream.onmessage({ data: JSON.stringify({ type: 'LEAVE_STATUS_CHANGED', data: {
    ...regular, leave_sessions: [{ date: '2026-10-04', session: 'Sáng' }]
  } }) });
  assert.equal(document.getElementById('leave-row-regular'), null);
  assert.equal(document.getElementById('statPending').textContent, '0');
  tableStream.onmessage({ data: JSON.stringify({ type: 'LEAVE_REQUEST_CREATED', data: {
    ...regular, request_id: 'half', leave_sessions: [{ date: '2026-10-03', session: 'Chiều' }]
  } }) });
  assert.ok(document.getElementById('leave-row-half'));
  assert.equal(document.getElementById('statPending').textContent, '1');
});

test('rapid day selection ignores an older table response arriving after the latest response', async t => {
  const { window, document, regular } = await calendarPage(t);
  const pending = [];
  window.fetch = url => String(url).includes('/summary/')
    ? Promise.resolve({ ok: true, status: 200, json: async () => ({ summary: [] }) })
    : new Promise(resolve => pending.push(resolve));
  document.querySelector('#leaveCalendar [data-date="2026-10-03"]').click();
  document.querySelector('#leaveCalendar [data-date="2026-10-04"]').click();
  const reply = request => ({ ok: true, status: 200, json: async () => ({ requests: [request] }) });
  pending[1](reply({ ...regular, request_id: 'new', start_date: '2026-10-04', end_date: '2026-10-04' }));
  await new Promise(resolve => setTimeout(resolve, 0));
  pending[0](reply({ ...regular, request_id: 'old' }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(document.getElementById('fromDateFilter').value, '2026-10-04');
  assert.ok(document.getElementById('leave-row-new'));
  assert.equal(document.getElementById('leave-row-old'), null);
});

test('người dùng thường mặc định chỉ tải các lịch nghỉ giao với ngày hôm nay', async () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://tokosi.example/humanresources/'
  });
  const { window } = dom;
  const requestedUrls = [];

  window.TKSNav = {
    authGuard: async () => ({ username: 'nhanvien', vaiTro: 'Nhân viên kho' }),
    can: fakeCan('Nhân viên kho'),
    renderTopSidebar() {}
  };
  window.fetch = async url => {
    requestedUrls.push(String(url));
    const payload = String(url).includes('/summary/') ? { summary: [] } : { requests: [] };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    };
  };

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.trim());
  inlineScripts.forEach(script => window.eval(script));
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));

  const initialListUrl = requestedUrls.find(url => url.startsWith('/api/hr/leave-requests?'));
  assert.ok(initialListUrl, 'frontend phải gọi API danh sách yêu cầu nghỉ phép');
  const query = new URL(initialListUrl, window.location.origin).searchParams;

  const pad = n => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  assert.equal(query.get('from'), today, 'mặc định ngày bắt đầu là hôm nay');
  assert.equal(query.get('to'), today, 'mặc định ngày kết thúc là hôm nay');
  assert.equal(window.document.getElementById('fromDateFilter').value, today);
  assert.equal(window.document.getElementById('toDateFilter').value, today);
  assert.equal(window.document.getElementById('statusFilter').value, '', 'người dùng thường không lọc trạng thái');
  // GET /api/hr/telegram/link-status da go khoi server — trang khong duoc goi lai.
  assert.ok(!requestedUrls.some(url => url.includes('/link-status')), 'frontend không gọi link-status');

  dom.window.close();
});

test('Quản lý xem bảng toàn thời gian, lọc đơn Chưa duyệt và KPI đếm mọi trạng thái nghỉ sắp tới', async () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://tokosi.example/humanresources/'
  });
  const { window } = dom;
  const requestedUrls = [];

  window.TKSNav = {
    authGuard: async () => ({ username: 'manager', vaiTro: 'Quản lý' }),
    can: fakeCan('Quản lý'),
    renderTopSidebar() {}
  };
  const base = {
    start_date: '2099-08-22', end_date: '2099-08-22',
    ho_ten: 'A', chuc_vu: 'NV', bo_phan: 'Kho', co_so: 'Hà Nội', ly_do: 'x',
    thoi_gian_gui: '2026-08-22T01:00:00.000Z', thoi_gian_bat_dau: 'Sáng 22/08/2026',
    thoi_gian_ket_thuc: 'Chiều 22/08/2026', tong_buoi_nghi: 2, tong_ngay_nghi: 1
  };
  window.fetch = async url => {
    requestedUrls.push(String(url));
    const text = String(url);
    const payload = text.includes('/summary/') ? { summary: [] }
      : { requests: [
        { ...base, request_id: 'NP-1', trang_thai: 'Chưa duyệt' },
        { ...base, request_id: 'NP-2', trang_thai: 'Đã duyệt' },
        { ...base, request_id: 'NP-3', trang_thai: 'Đã duyệt' }
      ] };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    };
  };

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.trim());
  inlineScripts.forEach(script => window.eval(script));
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));

  const listUrl = requestedUrls.find(url => url.startsWith('/api/hr/leave-requests?'));
  assert.ok(listUrl, 'frontend phải gọi API danh sách yêu cầu nghỉ phép');
  const query = new URL(listUrl, window.location.origin).searchParams;
  assert.equal(query.get('from'), null, 'quản lý không giới hạn ngày (toàn thời gian)');
  assert.equal(query.get('to'), null);
  assert.equal(query.get('status'), null, 'trạng thái lọc phía client, không gửi lên API');
  assert.equal(window.document.getElementById('statusFilter').value, 'Chưa duyệt');

  const rows = window.document.querySelectorAll('#leaveTableBody tr[data-request-id]');
  assert.equal(rows.length, 1, 'chỉ hiện đơn Chưa duyệt');
  assert.equal(rows[0].dataset.requestId, 'NP-1');
  assert.equal(window.document.getElementById('statApproved').textContent, '2', 'KPI vẫn đếm mọi trạng thái');
  assert.ok(!requestedUrls.some(url => url.includes('/link-status')), 'frontend không gọi link-status');

  dom.window.close();
});

// Dung trang voi 1 don "Vi phạm" cho vai tro cho truoc; tra ve { dom, window } sau khi trang tai xong.
async function loadPageWithViolation(vaiTro) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://tokosi.example/humanresources/'
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  window.Chart = class FakeChart { destroy() {} };
  window.TKSNav = {
    authGuard: async () => ({ username: 'user1', vaiTro }),
    can: fakeCan(vaiTro),
    renderTopSidebar() {}
  };
  window.fetch = async url => {
    const text = String(url);
    const payload = text.includes('/summary/') ? { summary: [] }
        : { requests: [{
          canManage: vaiTro === 'Quản lý', decision_version: '0', request_id: 'NP-TEST',
          ho_ten: 'Nguyễn A',
          chuc_vu: 'Nhân viên',
          ly_do: 'Việc gia đình',
          thoi_gian_gui: '2026-08-22T01:00:00.000Z',
          thoi_gian_bat_dau: 'Sáng 22/08/2026',
          thoi_gian_ket_thuc: 'Chiều 22/08/2026',
          tong_buoi_nghi: 2,
          tong_ngay_nghi: 1,
          trang_thai: 'Vi phạm'
        }] };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => payload,
      text: async () => JSON.stringify(payload)
    };
  };

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1])
    .filter(script => script.trim());
  inlineScripts.forEach(script => window.eval(script));
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
  return { dom, window };
}

test('tab nghỉ phép hiển thị thời gian gửi, dữ liệu theo buổi và trạng thái Vi phạm (người dùng thường)', async () => {
  const { dom, window } = await loadPageWithViolation('Nhân viên kho');

  const headers = [...window.document.querySelectorAll('#leaveTable thead th')].map(th => th.textContent.trim());
  assert.ok(headers.some(header => header.includes('Thời gian gửi')));
  assert.ok(headers.some(header => header.includes('Tổng buổi / ngày')));
  assert.match(window.document.querySelector('.date-range-group').textContent, /Thời gian nghỉ/);
  assert.equal(window.document.getElementById('maStartDate').type, 'date');
  assert.equal(window.document.getElementById('maStartSession').tagName, 'SELECT');

  const rowText = window.document.querySelector('#leaveTableBody tr').textContent;
  assert.match(rowText, /22\/08\/2026 08:00/);
  assert.match(rowText, /Sáng 22\/08\/2026/);
  assert.match(rowText, /2 buổi \(1 ngày\)/);
  assert.match(rowText, /Vi phạm/);
  assert.doesNotMatch(rowText, /Mở lại|Tạm duyệt|Duyệt|Từ chối/);
  assert.ok(window.document.querySelector('.status-pill.leave-violation'));
  assert.equal(window.document.querySelector('#leaveTableBody select.status-select'), null);

  dom.window.close();
});

test('Quản lý vẫn duyệt / từ chối được đơn Vi phạm, nhãn Vi phạm vẫn hiện', async () => {
  const { dom, window } = await loadPageWithViolation('Quản lý');

  // Mac dinh Quan ly chi thay "Chua duyet" -> bo loc trang thai de thay don Vi pham.
  window.document.getElementById('statusFilter').value = '';
  window.handleStatusFilterChange();

  const select = window.document.querySelector('#leaveTableBody select.status-select.leave-violation');
  assert.ok(select, 'Quản lý phải có dropdown ở đơn Vi phạm');
  assert.equal(select.value, 'Vi phạm');
  assert.equal(select.options[0].disabled, true, 'Nhãn cũ chỉ để đọc');
  assert.deepEqual([...select.options].filter(o => !o.disabled).map(o => o.value), ['Chưa duyệt', 'Đã duyệt', 'Từ chối']);

  dom.window.close();
});
