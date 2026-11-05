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

test('bảng nghỉ phép có 9 cột: Người gửi, Phòng ban, Cơ sở tách riêng, không còn Mã yêu cầu / Người duyệt', async () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://tokosi.example/humanresources/'
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  window.Chart = class FakeChart { destroy() {} };
  window.TKSNav = {
    authGuard: async () => ({ username: 'manager', vaiTro: 'Quản lý' }),
    can: fakeCan('Quản lý'),
    renderTopSidebar() {}
  };
  window.fetch = async url => {
    const text = String(url);
    const payload = text.includes('/summary/') ? { summary: [] }
        : { requests: [{
          canManage: true, decision_version: '0', request_id: 'NP-20260822-001',
          ho_ten: 'Nguyễn Văn A',
          chuc_vu: 'Trưởng kho',
          bo_phan: 'Kho vận',
          co_so: 'Hà Nội',
          ly_do: 'Việc gia đình',
          thoi_gian_gui: '2026-08-22T08:00:00.000Z',
          thoi_gian_bat_dau: 'Sáng 23/08/2026',
          thoi_gian_ket_thuc: 'Chiều 23/08/2026',
          tong_buoi_nghi: 2,
          tong_ngay_nghi: 1,
          nguoi_ban_giao: 'Trần B',
          trang_thai: 'Chưa duyệt',
          nguoi_duyet: ''
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

  const headers = [...window.document.querySelectorAll('#leaveTable thead th')].map(th => th.textContent.replace(/[↕↑↓▲▼]/g, '').trim());
  assert.equal(headers.length, 9, 'Bảng phải có đúng 9 cột');
  assert.equal(headers[headers.length - 1], 'Trạng thái', 'Cột cuối cùng phải là Trạng thái');
  assert.ok(!headers.includes('Hành động'), 'Không còn cột Hành động riêng biệt');
  assert.ok(!headers.includes('Mã yêu cầu'), 'Không còn cột Mã yêu cầu');
  assert.ok(!headers.includes('Người duyệt'), 'Không còn cột Người duyệt');
  assert.deepEqual(headers.slice(0, 3), ['Người gửi', 'Phòng ban', 'Cơ sở']);

  const cells = [...window.document.querySelectorAll('#leaveTableBody tr[data-request-id] td')].map(td => td.textContent.trim());
  assert.equal(cells[0], 'Nguyễn Văn A', 'Ô Người gửi chỉ có tên (không kèm chức vụ)');
  assert.equal(cells[1], 'Kho vận');
  assert.equal(cells[2], 'Hà Nội');

  // Kiểm tra Quản lý thấy dropdown select trạng thái
  const statusSelect = window.document.querySelector('#leaveTableBody select.status-select');
  assert.ok(statusSelect, 'Quản lý phải thấy select dropdown ở cột Trạng thái');
  assert.equal(statusSelect.value, 'Chưa duyệt', 'Trạng thái ban đầu là Chưa duyệt');

  const options = [...statusSelect.options].map(o => o.value);
  assert.ok(options.includes('Chưa duyệt'), 'Dropdown có tùy chọn Chưa duyệt');
  assert.ok(options.includes('Đã duyệt'), 'Dropdown có tùy chọn Đã duyệt');
  assert.ok(options.includes('Từ chối'), 'Dropdown có tùy chọn Từ chối');

  dom.window.close();
});

test('tài khoản không có quyền duyệt nghỉ phép chỉ thấy badge nhãn trạng thái tĩnh', async () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://tokosi.example/humanresources/'
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  window.Chart = class FakeChart { destroy() {} };
  window.TKSNav = {
    authGuard: async () => ({ username: 'nhanvien', vaiTro: 'Nhân viên kho' }),
    can: fakeCan('Nhân viên kho'),
    renderTopSidebar() {}
  };
  window.fetch = async url => {
    const text = String(url);
    const payload = text.includes('/summary/') ? { summary: [] }
        : { requests: [{
          canManage: false, decision_version: '0', request_id: 'NP-20260822-002',
          ho_ten: 'Lê C',
          chuc_vu: 'Kho',
          ly_do: 'Ốm',
          thoi_gian_gui: '2026-08-22T08:00:00.000Z',
          thoi_gian_bat_dau: 'Sáng 23/08/2026',
          thoi_gian_ket_thuc: 'Chiều 23/08/2026',
          tong_buoi_nghi: 2,
          tong_ngay_nghi: 1,
          nguoi_ban_giao: 'Trần B',
          trang_thai: 'Chưa duyệt',
          nguoi_duyet: ''
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

  const select = window.document.querySelector('#leaveTableBody select.status-select');
  assert.equal(select, null, 'Nhân viên kho không được hiển thị dropdown sửa trạng thái');

  const pill = window.document.querySelector('#leaveTableBody .status-pill.leave-pending');
  assert.ok(pill, 'Nhân viên kho thấy badge trạng thái tĩnh');
  assert.equal(pill.textContent.trim(), 'Chưa duyệt');

  dom.window.close();
});

test('Quản lý thay đổi trạng thái gọi API PATCH và cập nhật Người duyệt ngay trên giao diện', async () => {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://tokosi.example/humanresources/'
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  window.Chart = class FakeChart { destroy() {} };
  window.TKSNav = {
    authGuard: async () => ({ username: 'manager1', hoTen: 'Nguyễn Quản Lý', vaiTro: 'Quản lý' }),
    can: fakeCan('Quản lý'),
    renderTopSidebar() {}
  };

  let patchCalled = false;
  let patchBody = null;

  window.fetch = async (url, options) => {
    const text = String(url);
    if (options && options.method === 'PATCH') {
      patchCalled = true;
      patchBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => ({
          request: {
            canManage: true, decision_version: '0', request_id: 'NP-20260822-003',
            trang_thai: patchBody.status,
            nguoi_duyet: 'Nguyễn Quản Lý'
          }
        }),
        text: async () => JSON.stringify({})
      };
    }
    const payload = text.includes('/summary/') ? { summary: [] }
        : { requests: [{
          canManage: true, decision_version: '0', request_id: 'NP-20260822-003',
          ho_ten: 'Phạm D',
          start_date: '2099-08-23', end_date: '2099-08-23',
          chuc_vu: 'Kế toán',
          ly_do: 'Đi khám',
          thoi_gian_gui: '2026-08-22T08:00:00.000Z',
          thoi_gian_bat_dau: 'Sáng 23/08/2026',
          thoi_gian_ket_thuc: 'Chiều 23/08/2026',
          tong_buoi_nghi: 2,
          tong_ngay_nghi: 1,
          nguoi_ban_giao: 'Lê E',
          trang_thai: 'Chưa duyệt',
          nguoi_duyet: ''
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

  const select = window.document.querySelector('#leaveTableBody select.status-select');
  assert.ok(select);
  select.value = 'Đã duyệt';
  await window.handleStatusSelectChange(select, 'NP-20260822-003');

  assert.equal(patchCalled, true, 'Phải gọi API PATCH khi thay đổi trạng thái');
  assert.equal(patchBody.status, 'Đã duyệt', 'Body gửi lên phải có status: Đã duyệt');

  assert.equal('note' in patchBody, false, 'Duyệt (không phải Từ chối) không gửi lý do');
  assert.equal(window.document.getElementById('statApproved').textContent, '1', 'KPI Đã duyệt cập nhật ngay');

  dom.window.close();
});

// Trang cho Quan ly voi 1 don Chua duyet; ghi lai cac lan PATCH.
async function loadManagerPage() {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://tokosi.example/humanresources/'
  });
  const { window } = dom;
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  window.Chart = class FakeChart { destroy() {} };
  window.TKSNav = {
    authGuard: async () => ({ username: 'manager1', hoTen: 'Nguyễn Quản Lý', vaiTro: 'Quản lý' }),
    can: fakeCan('Quản lý'),
    renderTopSidebar() {}
  };

  const patches = [];
  window.fetch = async (url, options) => {
    const text = String(url);
    let payload;
    if (options && options.method === 'PATCH') {
      const body = JSON.parse(options.body);
      patches.push(body);
      payload = { request: { canManage: true, decision_version: '0', request_id: 'NP-R1', trang_thai: body.status, nguoi_duyet: 'Nguyễn Quản Lý' } };
    } else if (text.includes('/summary/')) {
      payload = { summary: [] };
    } else {
      payload = { requests: [{
        canManage: true, decision_version: '0', request_id: 'NP-R1',
        ho_ten: 'Phạm D',
        chuc_vu: 'Kế toán',
        bo_phan: 'Văn phòng',
        co_so: 'Hà Nội',
        ly_do: 'Đi khám',
        thoi_gian_gui: '2026-08-22T08:00:00.000Z',
        thoi_gian_bat_dau: 'Sáng 23/08/2026',
        thoi_gian_ket_thuc: 'Chiều 23/08/2026',
        tong_buoi_nghi: 2,
        tong_ngay_nghi: 1,
        nguoi_ban_giao: 'Lê E',
        trang_thai: 'Chưa duyệt',
        nguoi_duyet: 'Trần Duyệt Cũ',
        thoi_diem_duyet: '2026-08-22T09:30:00.000Z',
        ghi_chu_duyet: 'BI-MAT-KHONG-HIEN'
      }] };
    }
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
  return { dom, window, patches };
}

function pickReject(window) {
  const select = window.document.querySelector('#leaveTableBody select.status-select');
  select.value = 'Từ chối';
  const pending = window.handleStatusSelectChange(select, 'NP-R1');
  return { select, pending };
}

test('chọn Từ chối mở panel nhập lý do, chưa gọi API; OK gửi kèm lý do đã nhập', async () => {
  const { dom, window, patches } = await loadManagerPage();
  const { pending } = pickReject(window);
  await pending;

  assert.equal(window.document.getElementById('rejectReasonModal').hidden, false, 'panel lý do phải hiện');
  assert.equal(patches.length, 0, 'chưa gọi PATCH khi chưa xác nhận');

  window.document.getElementById('rejectReasonInput').value = '  Thiếu người trực ca  ';
  await window.confirmRejectReason(true);

  assert.equal(window.document.getElementById('rejectReasonModal').hidden, true);
  assert.deepEqual(patches, [{ status: 'Từ chối', expectedVersion: '0', note: 'Thiếu người trực ca' }]);
  dom.window.close();
});

test('Bỏ qua = từ chối không cần lý do (note rỗng)', async () => {
  const { dom, window, patches } = await loadManagerPage();
  const { pending } = pickReject(window);
  await pending;

  window.document.getElementById('rejectReasonInput').value = 'sẽ bị bỏ qua';
  await window.confirmRejectReason(false);

  assert.deepEqual(patches, [{ status: 'Từ chối', expectedVersion: '0', note: '' }]);
  dom.window.close();
});

test('đóng panel lý do (✕ / Esc) hủy việc từ chối: không PATCH, dropdown về trạng thái cũ', async () => {
  const { dom, window, patches } = await loadManagerPage();
  const { select, pending } = pickReject(window);
  await pending;

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));

  assert.equal(window.document.getElementById('rejectReasonModal').hidden, true);
  assert.equal(patches.length, 0);
  assert.equal(select.value, 'Chưa duyệt');
  assert.ok(select.classList.contains('leave-pending'));
  dom.window.close();
});

test('bấm dòng mở hộp chi tiết đủ Mã yêu cầu, Người duyệt, Thời điểm duyệt; không lộ lý do từ chối', async () => {
  const { dom, window } = await loadManagerPage();
  const row = window.document.querySelector('#leaveTableBody tr[data-request-id="NP-R1"]');
  // jsdom "outside-only" khong chay onclick inline -> goi thang handler.
  window.handleLeaveRowClick({ target: row.querySelector('td') });

  const modal = window.document.getElementById('leaveDetailModal');
  assert.equal(modal.hidden, false);
  const text = modal.textContent;
  assert.match(text, /NP-R1/);
  assert.match(text, /Kế toán/);
  assert.match(text, /Văn phòng/);
  assert.match(text, /Trần Duyệt Cũ/);
  assert.match(text, /22\/08\/2026 \d{2}:\d{2}/);
  assert.doesNotMatch(text, /BI-MAT-KHONG-HIEN/);

  window.closeLeaveDetail();
  assert.equal(modal.hidden, true);

  // Bam vao dropdown trang thai khong mo hop chi tiet.
  window.handleLeaveRowClick({ target: window.document.querySelector('#leaveTableBody select.status-select') });
  assert.equal(modal.hidden, true);
  dom.window.close();
});

test('hộp chi tiết nghỉ phép: hàng chỉ số tổng quan (trạng thái, số ngày, thời gian, loại, nhãn thời hạn) + 3 khối Nội dung / Người gửi / Duyệt đơn', async () => {
  const { dom, window } = await loadManagerPage();
  const row = window.document.querySelector('#leaveTableBody tr[data-request-id="NP-R1"]');
  window.handleLeaveRowClick({ target: row.querySelector('td') });

  const doc = window.document;
  const stats = Object.fromEntries([...doc.querySelectorAll('#leaveDetailStats .dp-stat')].map(el => [
    el.querySelector('.dp-stat-label').textContent,
    { value: el.querySelector('.dp-stat-value').textContent, sub: (el.querySelector('.dp-stat-sub') || { textContent: '' }).textContent }
  ]));
  assert.deepEqual(Object.keys(stats), ['Thời gian nghỉ', 'Trạng thái', 'Thời hạn']);
  assert.match(stats['Thời gian nghỉ'].sub, /ngày · .+ buổi$/);
  assert.match(doc.getElementById('leaveDetailSubtitle').textContent, /^Mã NP-R1/);
  assert.ok(doc.getElementById('leaveDetailHeading').textContent.length > 0);
  assert.deepEqual([...doc.querySelectorAll('#leaveDetailBody .dp-section-title')].map(el => el.textContent), ['Nội dung nghỉ', 'Người gửi', 'Thông tin phê duyệt']);
  assert.equal(doc.querySelector('#leaveDetailModal .tks-columns-button'), null);
  dom.window.close();
});
