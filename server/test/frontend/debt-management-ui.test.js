'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const indexPath = path.join(__dirname, '..', '..', 'public', 'index.html');
const navPath = path.join(__dirname, '..', '..', 'public', 'shared', 'shared-nav.js');

function html() {
  return fs.readFileSync(indexPath, 'utf8');
}

function createDashboard(payload) {
  const source = html();
  const dom = new JSDOM(source, { runScripts: 'outside-only', url: 'https://tokosi.example/#debt' });
  if (payload) {
    dom.window.sessionStorage.setItem('tksDashboardCache', JSON.stringify({
      data: { debtManagement: payload },
      days: 30,
      filters: {
        overview: { mode: 'days', days: 30 },
        products: { mode: 'days', days: 30 },
        invoices: { mode: 'days', days: 30 },
        customers: { mode: 'all' }
      },
      productStatus: 'all'
    }));
  }
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.Chart = class FakeChart {
    static instances = [];
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; FakeChart.instances.push(this); }
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => { if (dom.window.document) callback(); };
  dom.window.TKSNav = {
    authGuard: () => new Promise(() => {}),
    // Trang bao cao goi TKSNav.can('reports.<tab>') de biet tab nao duoc xem
    // (nguon: user.permissions tu /api/auth/me) — test nay khong kiem tra phan
    // quyen nen mo het.
    can: () => true,
    handleBranchError: () => false,
    renderTopSidebar() {}
  };
  dom.window.fetch = () => new Promise(() => {});
  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', file), 'utf8'));
  });
  [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim())
    .forEach(script => dom.window.eval(script));
  return dom;
}

function debtPayload() {
  const base = {
    sale: 'Lan', paymentSchedule: '7', openingDebt: 0,
    currentDebtToSalesRatio: 0.5, overdueToSalesRatio: 0,
    alertCodes: ['overdue'], dataIssues: [], workflowStatus: 'Chưa xử lý',
    needsAction: true, canEditStatus: true, alertSignature: 'a'.repeat(64),
    updatedBy: '', updatedAt: null
  };
  return {
    available: true, sourceSheet: 'Công nợ HN', dataWarnings: [],
    kpi: { totalCurrentDebt: 1200000, totalOverdueDebt: 500000, actionCustomerCount: 1, overdueToSalesRatio: 0.25 },
    bySale: [{ sale: 'Lan', totalCurrentDebt: 1200000, totalOverdueDebt: 500000 }],
    byPaymentSchedule: [{ paymentSchedule: '7', totalCurrentDebt: 1200000, totalOverdueDebt: 500000 }],
    topCurrentDebt: [], topOverdueDebt: [],
    customers: [
      { ...base, customerKey: 'b'.repeat(64), customerName: 'Khách A', currentDebt: 500000, overdueDebt: 0 },
      { ...base, customerKey: 'c'.repeat(64), customerName: 'Khách B', currentDebt: 700000, overdueDebt: 500000, workflowStatus: 'Đã xử lý', needsAction: false }
    ]
  };
}

test('sidebar và tiêu đề thay Công nợ kỳ cũ bằng Công nợ', () => {
  const dashboard = html();
  const nav = fs.readFileSync(navPath, 'utf8');
  assert.match(nav, /view: 'debt', label: 'Công nợ'/);
  assert.match(dashboard, /<div class="view-title">Công nợ<\/div>/);
  assert.doesNotMatch(dashboard, /id="debtPeriodToggle"|setDebtPeriod\(|toggleDebtDetail\(|debt\.period/);
});

test('dashboard công nợ có đủ 4 KPI, không còn biểu đồ và bảng 17 cột (Cơ sở đứng đầu, có DS trong kỳ, không còn Nợ đầu kỳ)', () => {
  const dashboard = html();
  ['dm-current', 'dm-overdue', 'dm-action-count', 'dm-overdue-ratio'].forEach(id => {
    assert.match(dashboard, new RegExp(`id="${id}"`));
  });
  assert.doesNotMatch(dashboard, /chartDebtBySale|chartDebtBySchedule|chartTopCurrentDebt|chartTopOverdueDebt|renderDebtComparisonChart|renderDebtTopChart/);
  const table = dashboard.match(/<table[^>]*data-debt-management-table[\s\S]*?<\/table>/);
  assert.ok(table);
  assert.equal((table[0].match(/<th(?:\s[^>]*)?>/g) || []).length, 17);
  assert.match(table[0], /Cảnh báo<\/th>\s*<th[^>]*>Số phiên liên tiếp<\/th>\s*<th[^>]*>Tiền phạt phiên trước<\/th>\s*<th[^>]*>Tiền phạt phiên này<\/th>\s*<th[^>]*>Sale phản hồi<\/th>\s*<th[^>]*>QL phản hồi<\/th>\s*<th[^>]*>Xử lý/);
  assert.doesNotMatch(dashboard, /Chưa thu/, 'đã bỏ cảnh báo Chưa thu');
  assert.match(table[0], /<tr>\s*<th[^>]*>Cơ sở<\/th>\s*<th[^>]*>Khách hàng<\/th>/, 'Cơ sở là cột đầu');
  assert.match(table[0], /Nợ hiện tại<\/th>\s*<th[^>]*>Nợ quá hạn<\/th>\s*<th[^>]*data-column-default-hidden="true"[^>]*>DS trong kỳ/, 'DS trong kỳ nằm sau Nợ quá hạn, mặc định ẩn');
  assert.doesNotMatch(table[0], /Nợ đầu kỳ/);
  assert.match(table[0], /Khách hàng/);
  assert.match(table[0], /Cảnh báo/);
  assert.match(table[0], /Xử lý/);
});

test('bộ lọc local mặc định Tất cả (không còn Cần xử lý) và hỗ trợ sale, lịch, tìm khách/sale', () => {
  const dashboard = html();
  assert.match(dashboard, /id="debtQueueFilter"[\s\S]*?<option value="all" selected>Tất cả<\/option>/);
  assert.doesNotMatch(dashboard, /<option value="needsAction"/);
  assert.match(dashboard, /id="debtSaleFilter"/);
  assert.match(dashboard, /id="debtScheduleFilter"/);
  assert.match(dashboard, /id="debtManagementSearch"/);
  assert.match(dashboard, /function getFilteredDebtCustomers\(/);
  assert.match(dashboard, /function sortDebtCustomers\(/);
});

test('cập nhật trạng thái dùng PATCH có rollback', () => {
  const dashboard = html();
  assert.match(dashboard, /fetch\('\/api\/debt-management\/status'/);
  assert.match(dashboard, /selectEl\.value = previousStatus/);
  assert.match(dashboard, /row-highlight-update/);
  assert.match(dashboard, /customer\.canEditStatus/);
});

test('script inline của dashboard vẫn biên dịch sau khi thay giao diện', () => {
  const scripts = [...html().matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1])
    .filter(script => script.trim());
  scripts.forEach(script => assert.doesNotThrow(() => new Function(script)));
});

test('lọc mặc định Tất cả, sort toàn tập và PATCH thành công cập nhật trạng thái ngay', async () => {
  const dom = createDashboard(debtPayload());
  const document = dom.window.document;
  assert.equal(document.getElementById('debtQueueFilter').value, 'all');
  assert.equal(document.querySelectorAll('#debtManagementRows tr[data-customer-key]').length, 2, 'mặc định chỉ hiện khách còn nợ');

  const currentDebtHeader = document.querySelectorAll('[data-debt-management-table] thead th')[5].querySelector('button');
  currentDebtHeader.click();
  currentDebtHeader.click();
  assert.equal(document.querySelector('#debtManagementRows tr[data-customer-key] .name-cell').textContent, 'Khách B');

  const select = [...document.querySelectorAll('#debtManagementRows .debt-status-select')].find(el => el.dataset.status === 'Chưa xử lý');
  dom.window.fetch = async url => url.includes('/penalty-board') ? new Promise(() => {}) : ({ ok: true, json: async () => ({ status: 'Đã xử lý', updatedBy: 'Quản lý' }) });
  select.value = 'Đã xử lý';
  await dom.window.handleDebtStatusChange(select);
  assert.equal(document.getElementById('dm-action-count').textContent, '0');
  dom.window.close();
});

test('lọc cả ba trạng thái, kết hợp tìm kiếm và giữ lựa chọn khi render lại', () => {
  const payload = debtPayload();
  payload.customers.push({ ...payload.customers[0], customerKey: 'skip', customerName: 'Khách C', workflowStatus: 'Bỏ qua' });
  const dom = createDashboard(payload);
  const document = dom.window.document;
  const select = document.getElementById('debtStatusFilter');
  const names = () => [...document.querySelectorAll('#debtManagementRows tr[data-customer-key] .name-cell')].map(el => el.textContent);
  assert.equal(select.value, '');
  assert.equal(names().length, 3);
  for (const [status, name] of [['Chưa xử lý', 'Khách A'], ['Đã xử lý', 'Khách B'], ['Bỏ qua', 'Khách C']]) {
    select.value = status;
    dom.window.handleDebtFilterChange();
    assert.deepEqual(names(), [name]);
  }
  dom.window.renderDebtManagement();
  assert.equal(select.value, 'Bỏ qua');
  document.getElementById('debtManagementSearch').value = 'Khách A';
  dom.window.handleDebtFilterChange();
  assert.deepEqual(names(), []);
  select.value = '';
  dom.window.handleDebtFilterChange();
  assert.deepEqual(names(), ['Khách A']);
  dom.window.close();
});

function scheduleDebtPayload() {
  const payload = debtPayload();
  payload.cycleDate = '2026-10-13';
  payload.customers = payload.customers.map((customer, index) => ({
    ...customer, customerKey: 'hanoi:' + (index + 1), customerId: String(index + 1), branchCode: 'hanoi', branch: 'HN',
    saleFeedback: index === 0 ? 'Hẹn thứ 6' : '', saleFeedbackBy: index === 0 ? 'Lan' : '',
    managerFeedback: '', managerFeedbackBy: '',
    canEditSaleFeedback: true, canEditManagerFeedback: false, canEditSchedule: false
  }));
  return payload;
}

test('Sale phản hồi sửa được theo quyền, QL phản hồi chỉ đọc; lưu gửi kèm cơ sở + khách + chu kỳ', async () => {
  const dom = createDashboard(scheduleDebtPayload());
  const document = dom.window.document;
  const row = document.querySelector('#debtManagementRows tr[data-customer-key="hanoi:1"]');
  const cells = row.querySelectorAll('td');
  assert.equal(cells[0].textContent, 'HN', 'cột Cơ sở ghi tắt');
  const saleInput = cells[14].querySelector('textarea.debt-feedback-input');
  assert.ok(saleInput, 'có quyền Sale phản hồi -> ô nhập');
  assert.equal(saleInput.value, 'Hẹn thứ 6');
  assert.equal(cells[15].querySelector('textarea'), null, 'không có quyền QL phản hồi -> chỉ đọc');

  let sent;
  dom.window.fetch = async (url, options) => { sent = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ value: 'Hẹn thứ 7', by: 'Lan' }) }; };
  saleInput.value = 'Hẹn thứ 7';
  await dom.window.handleDebtFeedbackChange(saleInput);
  assert.equal(sent.url, '/api/debt-management/sale-feedback');
  assert.deepEqual(sent.body, { branch: 'hanoi', customerId: '1', cycleDate: '2026-10-13', value: 'Hẹn thứ 7' });
  dom.window.close();
});

test('Lịch sử chỉnh sửa hiển thị mọi loại thay đổi (phản hồi, trạng thái, lịch TT)', async () => {
  const dom = createDashboard(scheduleDebtPayload());
  const document = dom.window.document;
  dom.window.fetch = async () => ({ ok: true, json: async () => ({ cycleDate: '2026-10-13', entries: [
    { id: '3', createdAt: '2026-10-13T09:00:00Z', branch: 'hanoi', customerId: '1', customerName: 'Khách A', field: 'schedule', oldValue: '', newValue: '3', actorName: 'QL' },
    { id: '2', createdAt: '2026-10-13T08:30:00Z', branch: 'saigon', customerId: '2', customerName: 'Khách B', field: 'status', oldValue: 'Chưa xử lý', newValue: 'Bỏ qua', actorName: 'QL' },
    { id: '1', createdAt: '2026-10-13T08:10:00Z', branch: 'hanoi', customerId: '1', customerName: 'Khách A', field: 'sale', oldValue: '', newValue: 'Hẹn', actorName: 'Lan' }
  ] }) });
  await dom.window.openDebtHistory();
  const rows = [...document.querySelectorAll('#docModalBody tbody tr')].map(tr => [...tr.querySelectorAll('td')].slice(3).map(td => td.textContent));
  assert.deepEqual(rows, [
    ['HN', 'Lịch TT', '1 ngày (mặc định)', '3 ngày'],
    ['SG', 'Trạng thái', 'Chưa xử lý', 'Bỏ qua'],
    ['HN', 'Sale phản hồi', '—', 'Hẹn']
  ]);
  assert.match(document.getElementById('docModalSubtitle').textContent, /13\/10 · 3 lần sửa/);
  dom.window.close();
});

test('khung Chỉ số then chốt: 4 chỉ số xếp dọc bên trái, bảng thưởng/phạt sale bên phải', () => {
  const dom = createDashboard();
  const document = dom.window.document;
  // Khung này còn được mục 1 của tab Hóa đơn (Kiểm tra giá bán) dùng lại, nên chọn đúng khung chứa bảng thưởng/phạt.
  const frame = document.querySelector('#debtPenaltyTable').closest('.debt-key-frame');
  assert.ok(frame, 'có khung 2 cột');
  const [stack, board] = frame.children;
  assert.ok(stack.classList.contains('debt-key-stack'));
  assert.deepEqual([...stack.querySelectorAll('.value')].map(el => el.id), ['dm-current', 'dm-overdue', 'dm-action-count', 'dm-overdue-ratio']);
  assert.ok(board.classList.contains('debt-penalty-board'));
  assert.ok(board.querySelector('#debtPenaltyTable'));
  assert.equal(document.querySelectorAll('[data-table-key="dashboard-table-22"]').length, 1);
  dom.window.close();
});


test('management team dropdown combines with sale filter and exports selected group', () => {
  const payload = debtPayload();
  payload.customers[0].saleTeam = 'Team A'; payload.customers[1].saleTeam = 'Team B';
  const dom = createDashboard(payload);
  try {
    const document = dom.window.document;
    document.getElementById('debtTeamFilter').value = 'Team B';
    dom.window.handleDebtFilterChange();
    assert.equal(document.querySelectorAll('#debtManagementRows tr[data-customer-key]').length, 1);
    assert.match(document.getElementById('debtManagementRows').textContent, /Khách B/);
    assert.equal(dom.window.buildExportPayload('debt.management').context.debtTeam, 'Team B');
  } finally { dom.window.close(); }
});

function serverDebtPayload(extra = {}) {
  const payload = scheduleDebtPayload();
  return {
    ...payload, rows: payload.customers, totalRows: 205, page: 1, pageSize: 100,
    summary: { customerCount: 205 }, filters: { teams: ['Chưa có team', 'Team A'], sales: ['Lan', 'Minh'], schedules: ['7', '15'] },
    search: { requestedCodes: [], missingCodes: [] }, ...extra
  };
}

function deferredFetch(dom) {
  const calls = [];
  dom.window.fetch = (url, options) => new Promise((resolve, reject) => {
    const call = { url: String(url), options, resolve, reject };
    calls.push(call);
    if (options && options.signal) options.signal.addEventListener('abort', () => reject(new dom.window.DOMException('aborted', 'AbortError')));
  });
  return calls;
}

const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const respond = (call, debtManagement) => call.resolve({ ok: true, status: 200, json: async () => ({ debtManagement, kpi: {}, filters: {} }) });
const dashboardCalls = calls => calls.filter(call => call.url.startsWith('/api/dashboard?'));
const paramsOf = call => new URL(call.url, 'https://tokosi.example').searchParams;

test('máy chủ phân trang: tổng/trang/bộ lọc lấy từ máy chủ, sort/lọc/tìm gửi lên API, bỏ kết quả cũ', async () => {
  const dom = createDashboard(serverDebtPayload());
  const document = dom.window.document;
  try {
    assert.equal(document.getElementById('tagDebtManagement').textContent, '205', 'tổng theo toàn bộ kết quả, không phải số dòng trang');
    assert.equal(document.getElementById('debtManagementPageLabel').textContent, 'Trang 1/3');
    assert.deepEqual([...document.getElementById('debtSaleFilter').options].map(o => o.value), ['', 'Lan', 'Minh'], 'facet từ máy chủ, có cả sale không nằm trong trang');
    assert.deepEqual([...document.getElementById('debtScheduleFilter').options].map(o => o.textContent), ['Tất cả lịch', '7 ngày', '15 ngày']);

    const calls = deferredFetch(dom);
    document.querySelectorAll('[data-debt-management-table] thead th')[5].querySelector('button').click();
    let request = dashboardCalls(calls).at(-1);
    assert.ok(request, 'sort gọi máy chủ');
    assert.equal(paramsOf(request).get('view'), 'debt');
    assert.equal(paramsOf(request).get('page'), '1');
    assert.deepEqual(JSON.parse(paramsOf(request).get('sorts')).map(sort => sort.key), ['currentDebt']);

    document.getElementById('debtStatusFilter').value = 'Đã xử lý';
    document.getElementById('debtSaleFilter').value = 'Minh';
    dom.window.handleDebtFilterChange();
    request = dashboardCalls(calls).at(-1);
    assert.equal(paramsOf(request).get('debtStatus'), 'Đã xử lý');
    assert.equal(paramsOf(request).get('debtSale'), 'Minh');
    assert.equal(paramsOf(request).get('debtQueue'), null, 'Tất cả không gửi');

    const before = dashboardCalls(calls).length;
    const stale = dashboardCalls(calls).at(-1);
    const search = document.getElementById('debtManagementSearch');
    search.value = 'Khách Z';
    dom.window.handleDebtFilterChange({ type: 'input' }); // oninput="handleDebtFilterChange(event)"
    assert.equal(dashboardCalls(calls).length, before, 'gõ phím chưa gọi ngay (debounce)');
    respond(stale, serverDebtPayload({ totalRows: 999 }));
    await flush();
    assert.equal(document.getElementById('tagDebtManagement').textContent, '205', 'kết quả của truy vấn cũ bị bỏ qua');
    await new Promise(resolve => setTimeout(resolve, 350));
    request = dashboardCalls(calls).at(-1);
    assert.equal(dashboardCalls(calls).length, before + 1);
    assert.equal(paramsOf(request).get('q'), 'Khách Z');
    const page = serverDebtPayload({ totalRows: 1, page: 1 });
    page.customers = page.rows = [page.customers[1]];
    respond(request, page);
    await flush();
    assert.equal(document.getElementById('tagDebtManagement').textContent, '1');
    assert.deepEqual([...document.querySelectorAll('#debtManagementRows tr[data-customer-key]')].map(tr => tr.dataset.customerKey), ['hanoi:2']);
    assert.equal(calls.filter(call => call.url.includes('/penalty-board') || call.url.includes('/aging')).length, 0, 'đổi bảng không tải lại thưởng/phạt + tuổi nợ');
  } finally { dom.window.close(); }
});

test('máy chủ phân trang: sửa trạng thái gửi kèm chu kỳ, cập nhật dòng ngay rồi tải lại trang (KPI không tự cộng trên trang)', async () => {
  const dom = createDashboard(serverDebtPayload());
  const document = dom.window.document;
  try {
    const calls = deferredFetch(dom);
    const select = document.querySelector('#debtManagementRows tr[data-customer-key="hanoi:1"] .debt-status-select');
    select.value = 'Đã xử lý';
    const done = dom.window.handleDebtStatusChange(select);
    const patch = calls.find(call => call.url === '/api/debt-management/status');
    assert.deepEqual(JSON.parse(patch.options.body), { branch: 'hanoi', customerId: '1', cycleDate: '2026-10-13', status: 'Đã xử lý' });
    patch.resolve({ ok: true, status: 200, json: async () => ({ status: 'Đã xử lý', updatedBy: 'QL' }) });
    await done;
    assert.equal(document.querySelector('#debtManagementRows tr[data-customer-key="hanoi:1"] .debt-status-select').value, 'Đã xử lý');
    assert.equal(document.getElementById('dm-action-count').textContent, '1', 'không đếm lại KPI chỉ trên trang đang xem');
    const reload = dashboardCalls(calls).at(-1);
    assert.ok(reload, 'tải lại trang từ máy chủ');
    assert.equal(paramsOf(reload).get('view'), 'debt');
  } finally { dom.window.close(); }
});

test('máy chủ cũ (không có totalRows): quay về lọc/phân trang tại trình duyệt', () => {
  const dom = createDashboard(scheduleDebtPayload());
  try {
    const calls = deferredFetch(dom);
    dom.window.document.getElementById('debtStatusFilter').value = 'Đã xử lý';
    dom.window.handleDebtFilterChange();
    assert.equal(dashboardCalls(calls).length, 0, 'lọc tại chỗ, không gọi máy chủ');
    assert.deepEqual([...dom.window.document.querySelectorAll('#debtManagementRows tr[data-customer-key]')].map(tr => tr.dataset.customerKey), ['hanoi:2']);
    assert.equal(dom.window.document.getElementById('tagDebtManagement').textContent, '1', 'tổng đếm tại trình duyệt');
  } finally { dom.window.close(); }
});
