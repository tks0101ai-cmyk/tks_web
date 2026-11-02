'use strict';

// Danh sach thao tac (cong no): bam dong khach mo hop lich su 7 ngay; sua trang thai ngay cu.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const indexPath = path.join(__dirname, '..', '..', 'public', 'index.html');

function createDashboard(payload) {
  const source = fs.readFileSync(indexPath, 'utf8');
  const dom = new JSDOM(source, { runScripts: 'outside-only', url: 'https://tokosi.example/#debt' });
  dom.window.sessionStorage.setItem('tksDashboardCache', JSON.stringify({
    data: { debtManagement: payload },
    days: 30,
    filters: {
      overview: { mode: 'days', days: 30 }, products: { mode: 'days', days: 30 },
      invoices: { mode: 'days', days: 30 }, customers: { mode: 'all' }
    },
    productStatus: 'all'
  }));
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor() {}
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => { if (dom.window.document) callback(); };
  dom.window.TKSNav = { authGuard: () => new Promise(() => {}), can: () => true, handleBranchError: () => false, renderTopSidebar() {} };
  dom.window.fetch = () => new Promise(() => {});
  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', file), 'utf8'));
  });
  [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim())
    .forEach(script => dom.window.eval(script));
  return dom;
}

function debtPayload(canEditStatus = true) {
  return { available: true, cycleDate: '2026-11-01', kpi: {}, customers: [{
    customerKey: 'hanoi:1', customerId: '1', branch: 'HN', branchCode: 'hanoi', customerName: 'Khách A', sale: 'Lan',
    workflowStatus: 'Chưa xử lý', needsAction: true, alertCodes: ['overdue'], canEditStatus, canEditSchedule: true,
    scheduleDays: 7, paymentSchedule: '7', penaltyAmount: 150000, currentDebt: 500000, overdueDebt: 500000
  }] };
}

const day = (cycleDate, over = {}) => ({
  cycleDate, takenAt: cycleDate + 'T08:00:00Z', present: true, currentDebt: 500000, overdueDebt: 500000,
  overdueStreak: 1, status: 'Chưa xử lý', statusBy: '', statusAt: null, penalty: 25000, locked: false, ...over
});

function historyPayload() {
  return {
    customer: { branch: 'hanoi', customerId: '1', customerName: 'Khách A', sale: 'Lan', scheduleDays: 7 },
    days: [day('2026-10-30', { overdueStreak: 3, penalty: 50000, locked: true }), day('2026-10-31', { overdueStreak: 4, penalty: 100000 }),
      day('2026-11-01', { overdueStreak: 5, penalty: 150000, status: 'Bỏ qua', statusBy: 'Quản lý A', statusAt: '2026-11-01T09:00:00Z' })],
    totalPenalty: 300000
  };
}

async function openHistory(dom, payload = historyPayload()) {
  const requests = [];
  dom.window.fetch = async url => { requests.push(url); return { ok: true, json: async () => payload }; };
  const row = dom.window.document.querySelector('#debtManagementRows tr.doc-row');
  assert.ok(row, 'dong khach co class doc-row');
  row.click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return { row, requests };
}

test('bam dong khach mo hop lich su: moi nhat truoc, tong phat, sua duoc ngay chua khoa', async () => {
  const dom = createDashboard(debtPayload());
  const { requests } = await openHistory(dom);
  assert.deepEqual(requests, ['/api/debt-management/customer-history?branch=hanoi&customerId=1']);
  const doc = dom.window.document;
  assert.equal(doc.getElementById('docModalBackdrop').hidden, false);
  assert.match(doc.getElementById('docModalTitle').textContent, /Lịch sử công nợ.*Khách A/);
  const rows = [...doc.querySelectorAll('#docModalBody tbody tr')];
  assert.deepEqual(rows.map(row => row.cells[0].textContent), ['01/11/2026', '31/10/2026', '30/10/2026']);
  assert.match(doc.getElementById('docModalBody').textContent, /300,000/);
  assert.equal(rows[0].querySelector('select').value, 'Bỏ qua');
  assert.ok(rows[1].querySelector('select'));
  assert.equal(rows[2].querySelector('select'), null, 'ngay thuoc thang da chot chi xem');
});

test('ngay thuoc thang da chot (locked) chi xem; khong co quyen thi khong co select', async () => {
  const dom = createDashboard(debtPayload());
  await openHistory(dom);
  const selects = [...dom.window.document.querySelectorAll('#docModalBody select.debt-status-select')];
  assert.deepEqual(selects.map(select => select.dataset.cycleDate), ['2026-11-01', '2026-10-31']);
  const viewer = createDashboard(debtPayload(false));
  await openHistory(viewer);
  assert.equal(viewer.window.document.querySelectorAll('#docModalBody select').length, 0);
});

test('bam vao o nhap / chon trong dong khong mo hop lich su', async () => {
  const dom = createDashboard(debtPayload());
  const requests = [];
  dom.window.fetch = async url => { requests.push(url); return { ok: true, json: async () => historyPayload() }; };
  const input = dom.window.document.querySelector('#debtManagementRows .debt-schedule-input');
  const select = dom.window.document.querySelector('#debtManagementRows .debt-status-select');
  assert.ok(input && select);
  input.click();
  select.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, []);
  assert.equal(dom.window.document.getElementById('docModalBackdrop').hidden, true);
});

test('doi trang thai mot ngay cu gui PATCH historical voi cycleDate cua ngay do roi tai lai hop', async () => {
  const dom = createDashboard(debtPayload());
  await openHistory(dom);
  const calls = [];
  dom.window.fetch = async (url, options) => {
    calls.push([url, options && options.method, options && options.body]);
    if (options && options.method === 'PATCH') return { ok: true, json: async () => ({ status: 'Đã xử lý', changed: true }) };
    return { ok: true, json: async () => historyPayload() };
  };
  const select = dom.window.document.querySelector('#docModalBody select[data-cycle-date="2026-10-31"]');
  select.value = 'Đã xử lý';
  await dom.window.handleDebtHistoryStatusChange(select);
  await new Promise(resolve => setImmediate(resolve));
  const patch = calls.find(call => call[1] === 'PATCH');
  assert.equal(patch[0], '/api/debt-management/status');
  assert.deepEqual(JSON.parse(patch[2]), { branch: 'hanoi', customerId: '1', cycleDate: '2026-10-31', status: 'Đã xử lý', historical: true });
  assert.ok(calls.some(call => String(call[0]).startsWith('/api/debt-management/customer-history')), 'hop duoc tai lai');
  dom.window.close();
});

test('loi 409 khi sua ngay cu tra select ve gia tri cu', async () => {
  const dom = createDashboard(debtPayload());
  await openHistory(dom);
  dom.window.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'Ngày này thuộc tháng đã chốt thưởng/phạt nên không sửa được.', code: 'DEBT_MONTH_FINALIZED' }) });
  const select = dom.window.document.querySelector('#docModalBody select[data-cycle-date="2026-10-31"]');
  select.value = 'Đã xử lý';
  await dom.window.handleDebtHistoryStatusChange(select);
  assert.equal(select.value, 'Chưa xử lý');
  assert.equal(select.disabled, false);
  dom.window.close();
});
