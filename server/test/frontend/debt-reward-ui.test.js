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

const baseRow = {
  sale: 'Lan', branches: ['hanoi', 'saigon'], points: 40, ratio: 2500, rank: 7,
  total: 100000, grossPenalty: 100000, payablePenalty: 0, rankReward: 800000,
  pointsReward: 700000, reward: 1500000, penaltyDays: 2, lastDayCustomers: 1,
  customerCount: 2, totalCurrentDebt: 800000, totalOverdue: 100000, overdueRatio: 0.05, actionCount: 1,
  days: [{ cycleDate: '2026-10-14', customers: 1, amount: 25000, live: false },
    { cycleDate: '2026-10-13', customers: 2, amount: 75000, live: false }],
  scoreCustomers: [{ branch: 'hanoi', code: 'KH1', name: 'Khách lịch sử', invoiceCount: 40,
    netRevenue: -500000, invoicePoints: 6, revenuePoints: -1, points: 5 }]
};
function boardPayload(overrides = {}) {
  const payload = { month: '2026-10', openCycleDate: '2026-10-14', days: [],
    rows: [baseRow, { ...baseRow, sale: 'Mai', rank: null, points: 29, ratio: 1000,
      grossPenalty: 25000, total: 25000, payablePenalty: 25000, reward: 0, rankReward: 0, pointsReward: 0 },
      { ...baseRow, sale: 'Chưa phân nhóm', rank: null, points: 0, ratio: null, grossPenalty: 0, total: 0,
        payablePenalty: 0, reward: 0, rankReward: 0, pointsReward: 0 }],
    summary: { grossPenalty: 125000, payablePenalty: 25000, pool: 3000000, penaltyFund: 20000,
      companyTopUp: 2980000, allocatedReward: 3000000, recipientCount: 2 },
    coverage: { from: '2026-10-01', to: '2026-10-14', missingDays: ['2026-10-02'], complete: false },
    status: 'provisional', closedAt: null, ruleVersion: 'debt-reward-v1', months: ['2026-10', '2026-09'], ...overrides };
  return payload;
}
function serve(dom, payload) { dom.window.fetch = async () => ({ ok: true, json: async () => payload }); }

test('equal server ranks remain shared in rendered rows and rule text explains boundary ties',async()=>{
 const dom=createDashboard();
 serve(dom,boardPayload({rows:[{...baseRow,sale:'An',rank:1},{...baseRow,sale:'Bình',rank:1}]}));
 await dom.window.loadDebtPenaltyBoard();
 assert.deepEqual([...dom.window.document.querySelectorAll('#debtPenaltyRows tr.doc-row')].map(tr=>tr.cells[0].textContent.trim()),['1','1']);
 assert.match(dom.window.document.querySelector('.debt-reward-rules').textContent,/1–2–2–4/);
 dom.window.close();
});

test('penalty ratio rounds displayed dong per point without changing the source used for ranking',async()=>{
 const dom=createDashboard();
 serve(dom,boardPayload({rows:[{...baseRow,points:192,grossPenalty:25000,ratio:25000/192}]}));
 await dom.window.loadDebtPenaltyBoard();
 const cell=dom.window.document.querySelector('#debtPenaltyRows tr.doc-row').cells[4];
 assert.equal(cell.textContent.trim(),'130');
 assert.match(cell.title,/25,000.*192.*130.208.*đồng\/điểm/);
 assert.match(cell.title,/làm tròn/);
 assert.match(dom.window.document.querySelector('#debtPenaltyTable th[data-column-key="phat-moi-diem"]').textContent,/đồng/);
 dom.window.close();
});

test('server reward rows retain global rank, eligibility, ratio and filtered totals', async () => {
  const dom = createDashboard();
  serve(dom, boardPayload({ status: 'finalized' }));
  await dom.window.loadDebtPenaltyBoard();
  const doc = dom.window.document;
  const rows = [...doc.querySelectorAll('#debtPenaltyRows tr.doc-row')].map(tr => [...tr.cells].map(td => td.textContent.trim()));
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].slice(0, 5), ['7', 'Lan', 'Chưa có team', '40', '2,500']);
  assert.match(rows[1][0], /Chưa đủ 30 điểm/);
  assert.equal(rows[2][0], '—');
  assert.equal(rows[2][4], '—');
  assert.match(rows[0][7], /100,000/);
  assert.match(rows[0][9], /1,500,000/);
  for (const id of ['debtPenaltyNote', 'debtRewardSummary', 'debtRewardCoverage']) assert.equal(doc.getElementById(id), null, id);
  assert.ok(doc.querySelector('.debt-penalty-wrap.tks-table-scroll #debtPenaltyTable'), 'bảng phải nằm trực tiếp trong khung cuộn để tiêu đề sticky hoạt động');
  assert.equal(doc.querySelectorAll('.debt-penalty-wrap .tks-table-scroll').length, 0);
  const search = dom.window.getTableSearchState('debtPenalty');
  search.query = 'Mai';
  dom.window.renderDebtPenaltyBoard();
  assert.equal(doc.querySelectorAll('#debtPenaltyRows tr.doc-row').length, 1);
  const foot = doc.querySelector('#debtPenaltyFoot tr').cells;
  assert.equal(foot[7].textContent.trim(), '25,000');
  assert.equal(foot[8].textContent.trim(), '25,000');
  assert.equal(foot[9].textContent.trim(), '0');
  dom.window.close();
});

test('monthly selector loads and exports selected history month; stale response is ignored', async () => {
  const dom = createDashboard();
  serve(dom, boardPayload());
  await dom.window.loadDebtPenaltyBoard();
  const doc = dom.window.document;
  const selector = doc.getElementById('debtRewardMonth');
  assert.ok(selector);
  assert.deepEqual([...selector.options].map(o => o.value), ['2026-10', '2026-09']);
  const responses = [];
  const urls = [];
  dom.window.fetch = url => { urls.push(url); return new Promise(resolve => responses.push(resolve)); };
  selector.value = '2026-09';
  const older = dom.window.loadDebtPenaltyBoard('2026-09');
  assert.match(doc.getElementById('debtPenaltyRows').textContent, /Đang tải/);
  const latest = dom.window.loadDebtPenaltyBoard('2026-10');
  responses[1]({ ok: true, json: async () => boardPayload() });
  await latest;
  responses[0]({ ok: true, json: async () => boardPayload({ month: '2026-09', status: 'finalized' }) });
  await older;
  assert.equal(selector.value, '2026-10');
  assert.equal(dom.window.buildExportPayload('debt.penalty').context.debtRewardMonth, '2026-10');
  serve(dom, boardPayload({ month: '2026-09', status: 'finalized', closedAt: '2026-10-01T08:00:00Z', coverage: { complete: true, missingDays: [] } }));
  await dom.window.loadDebtPenaltyBoard('2026-09');
  assert.equal(dom.window.buildExportPayload('debt.penalty').context.debtRewardMonth, '2026-09');
  assert.match(doc.getElementById('debtRewardStatus').textContent, /Đã chốt/);
  assert.deepEqual(urls, ['/api/debt-management/penalty-board?month=2026-09', '/api/debt-management/penalty-board?month=2026-10']);
  dom.window.close();
});

test('reward board clearly renders funding, missing coverage and failed request without fabricated ranks', async () => {
  const dom = createDashboard();
  serve(dom, boardPayload({ status: 'finalized' }));
  await dom.window.loadDebtPenaltyBoard();
  const doc = dom.window.document;
  assert.match(doc.getElementById('debtRewardStatus').textContent, /Đã chốt/);
  dom.window.fetch = async () => ({ ok: false, status: 503 });
  await dom.window.loadDebtPenaltyBoard();
  assert.match(doc.getElementById('debtPenaltyRows').textContent, /Không tải được bảng thưởng/);
  assert.equal(doc.querySelectorAll('#debtPenaltyRows tr.doc-row').length, 0);
  assert.ok(doc.querySelector('#debtPenaltyRows button'));
  dom.window.close();
});

test('sale detail uses frozen metrics and shows daily penalties, reward split and customer point audit', async () => {
  const dom = createDashboard({ available: true, customers: [{ sale: 'Lan', currentDebt: 9999999, overdueDebt: 9999999 }], kpi: {} });
  serve(dom, boardPayload({ status: 'finalized' }));
  await dom.window.loadDebtPenaltyBoard();
  const doc = dom.window.document;
  doc.querySelector('#debtPenaltyRows tr[data-sale="Lan"]').click();
  const stats = Object.fromEntries([...doc.querySelectorAll('#docModalBody .dp-stat')]
    .map(el => [el.querySelector('.dp-stat-label').textContent, el.querySelector('.dp-stat-value').textContent]));
  assert.match(stats['Tổng nợ hiện tại'], /800,000/);
  assert.match(stats['Thưởng theo hạng'], /800,000/);
  assert.match(stats['Thưởng theo điểm'], /700,000/);
  assert.equal(stats['Quá hạn / Doanh số'], '5%');
  assert.match(doc.getElementById('docModalBody').textContent, /Khách lịch sử.*40.*-500,000.*6.*-1.*5/);
  assert.match(doc.getElementById('docModalBody').textContent, /14\/10/);
  assert.doesNotMatch(doc.getElementById('docModalBody').textContent, /đang tạm tính/);
  dom.window.close();
});

function editableDebt() {
  return { available: true, cycleDate: '2026-10-14', customers: [{ customerKey: 'hanoi:1', customerId: '1', branch: 'HN', branchCode: 'hanoi',
    customerName: 'Khách A', sale: 'Lan', workflowStatus: 'Chưa xử lý', needsAction: true, alertCodes: ['overdue'],
    canEditStatus: true, canEditSchedule: true, scheduleDays: 7, paymentSchedule: '7',
    penaltyAmount: 25000, suggestedPenaltyAmount: 25000, currentDebt: 500000, overdueDebt: 100000 }], kpi: {} };
}
for (const kind of ['status', 'schedule']) {
  test(kind + ' PATCH refreshes reward board even while dashboard refresh is pending', async () => {
    const dom = createDashboard(editableDebt());
    serve(dom, boardPayload());
    await dom.window.loadDebtPenaltyBoard();
    const doc = dom.window.document;
    const calls = [];
    dom.window.fetch = async (url, options) => {
      calls.push(url);
      if (url.startsWith('/api/dashboard?')) return new Promise(() => {});
      if (url.startsWith('/api/debt-management/penalty-board')) return { ok: true, json: async () => boardPayload({ rows: [{ ...baseRow, points: 55 }] }) };
      assert.equal(options.method, 'PATCH');
      return { ok: true, json: async () => ({ status: 'Đã xử lý' }) };
    };
    const selector = kind === 'status' ? '.debt-status-select' : '.debt-schedule-input';
    const input = doc.querySelector('#debtManagementRows ' + selector);
    assert.ok(input);
    input.value = kind === 'status' ? 'Đã xử lý' : '9';
    await dom.window[kind === 'status' ? 'handleDebtStatusChange' : 'handleDebtScheduleChange'](input);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(calls.some(url => url.startsWith('/api/debt-management/penalty-board')));
    assert.equal(doc.querySelector('#debtPenaltyRows tr.doc-row').cells[3].textContent, '55');
    assert.equal(calls.filter(url => url.includes('/penalty-board')).length, 1, 'rendering alone must not fetch again');
    dom.window.close();
  });
}

test('dashboard refresh reloads selected reward month even when dashboard fingerprint stays unchanged', async () => {
  const dom = createDashboard(editableDebt());
  serve(dom, boardPayload({ month: '2026-09', status: 'finalized' }));
  await dom.window.loadDebtPenaltyBoard('2026-09');
  let score = 50;
  let boardRequests = 0;
  dom.window.fetch = async url => {
    if (url.startsWith('/api/dashboard?')) return { ok: true, json: async () => ({ debtManagement: editableDebt() }) };
    assert.equal(url, '/api/debt-management/penalty-board?month=2026-09');
    boardRequests++;
    return { ok: true, json: async () => boardPayload({ month: '2026-09', rows: [{ ...baseRow, points: score }] }) };
  };
  dom.window.loadData(undefined, false, 'debt');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.window.document.querySelector('#debtPenaltyRows tr.doc-row').cells[3].textContent, '50');
  score = 60;
  dom.window.loadData(undefined, false, 'debt');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(dom.window.document.querySelector('#debtPenaltyRows tr.doc-row').cells[3].textContent, '60');
  assert.equal(boardRequests, 2);
  dom.window.close();
});

test('finalized detail marks unavailable debt snapshot without presenting zero debt as captured metrics', async () => {
  const dom = createDashboard(editableDebt());
  serve(dom, boardPayload({ status: 'finalized', rows: [{ ...baseRow, debtMetricsAvailable: false,
    customerCount: 1, totalCurrentDebt: 0, totalOverdue: 0, overdueRatio: null, actionCount: 0 }] }));
  await dom.window.loadDebtPenaltyBoard();
  const doc = dom.window.document;
  doc.querySelector('#debtPenaltyRows tr[data-sale="Lan"]').click();
  const stats = Object.fromEntries([...doc.querySelectorAll('#docModalBody .dp-stat')]
    .map(el => [el.querySelector('.dp-stat-label').textContent, el.querySelector('.dp-stat-value').textContent]));
  assert.equal(stats['Tổng nợ hiện tại'], '—');
  assert.equal(stats['Tổng nợ quá hạn'], '—');
  assert.equal(stats['Quá hạn / Doanh số'], '—');
  assert.equal(stats['Khách cần xử lý'], '—');
  assert.match(doc.getElementById('docModalBody').textContent, /Không còn bản chốt công nợ để đối chiếu/);
  assert.match(stats['Tiền thưởng'], /1,500,000/);
  assert.match(doc.getElementById('docModalBody').textContent, /Khách lịch sử/);
  assert.match(doc.getElementById('docModalSubtitle').textContent, /1 khách/);
  dom.window.close();
});

test('open month shows daily provisional reward amounts and distinguishes official finalized rewards', async () => {
  const dom = createDashboard(editableDebt());
  serve(dom, boardPayload());
  await dom.window.loadDebtPenaltyBoard();
  const doc = dom.window.document;
  assert.equal(doc.getElementById('debtRewardStatus').textContent, 'Thưởng tạm tính');
  assert.equal(doc.querySelector('#debtPenaltyTable th[data-column-key="tien-thuong"] .sort-button > span').textContent, 'Thưởng tạm tính');
  assert.equal(doc.querySelector('#debtPenaltyRows tr[data-sale="Lan"]').cells[9].textContent.trim(), '1,500,000');
  assert.equal(doc.querySelector('#debtPenaltyFoot tr').cells[9].textContent.trim(), '1,500,000');
  doc.querySelector('#debtPenaltyRows tr[data-sale="Lan"]').click();
  const stats = Object.fromEntries([...doc.querySelectorAll('#docModalBody .dp-stat')]
    .map(el => [el.querySelector('.dp-stat-label').textContent, el.querySelector('.dp-stat-value').textContent]));
  assert.match(stats['Thưởng theo hạng'], /800,000/);
  assert.match(stats['Thưởng theo điểm'], /700,000/);
  assert.match(stats['Thưởng tạm tính'], /1,500,000/);
  assert.match(doc.getElementById('docModalBody').textContent, /Thưởng tạm tính, sẽ chốt chính thức vào cuối tháng/);
  assert.match(stats['Phạt gốc'], /100,000/);
  assert.equal(stats['Điểm'], '40');
  serve(dom, boardPayload({ status: 'finalized' }));
  await dom.window.loadDebtPenaltyBoard();
  assert.equal(doc.getElementById('debtRewardStatus').textContent, 'Đã chốt');
  assert.equal(doc.querySelector('#debtPenaltyTable th[data-column-key="tien-thuong"] .sort-button > span').textContent, 'Tiền thưởng');
  assert.equal(doc.querySelector('#debtPenaltyRows tr[data-sale="Lan"]').cells[9].textContent.trim(), '1,500,000');
  dom.window.close();
});

test('board keeps last finalized penalty date distinct from currently open cycle date', async () => {
  const dom = createDashboard(editableDebt());
  serve(dom, boardPayload({ lastPenaltyDate: '2026-10-13', openCycleDate: '2026-10-14' }));
  await dom.window.loadDebtPenaltyBoard();
  assert.equal(dom.window.buildDebtPenaltyRows().lastDate, '2026-10-13');
  dom.window.close();
});


test('reward team dropdown filters totals and passes the team to exports', async () => {
  const dom = createDashboard();
  try {
    serve(dom, boardPayload({ rows: [{...baseRow, saleTeam:'Team A'}, {...baseRow, sale:'Mai', saleTeam:'Team B', reward:0}] }));
    await dom.window.loadDebtPenaltyBoard();
    dom.window.document.getElementById('debtPenaltyTeamFilter').value = 'Team A';
    dom.window.handleDebtPenaltyTeamChange();
    assert.equal(dom.window.document.querySelectorAll('#debtPenaltyRows tr.doc-row').length, 1);
    assert.equal(dom.window.document.querySelector('#debtPenaltyFoot tr').cells[9].textContent, '1,500,000');
    assert.equal(dom.window.buildExportPayload('debt.penalty').context.debtPenaltyTeam, 'Team A');
  } finally { dom.window.close(); }
});
