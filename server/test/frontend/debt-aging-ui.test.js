'use strict';

// Muc 3 tab Cong no "Tuoi no theo hoa don": doc /api/debt-management/aging (bang tinh san), loc,
// sap xep, phan trang va bo do Con han <= 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');

const AGING = {
  available: true, asOfDay: '2026-10-17', refreshedAt: '2026-10-17T03:05:00.000Z',
  customers: [
    { customerKey: 'hanoi:1', branchCode: 'hanoi', customerId: '1', branch: 'HN', customerName: 'Anh Bình', sale: 'Duy Thái', paymentSchedule: '5', scheduleDays: 5,
      currentDebt: 600000, overdueDebt: 300000, payoffDay: '2026-10-10', beyondHistory: false, equivalentDays: 7, remainingDays: -2 },
    { customerKey: 'hanoi:2', branchCode: 'hanoi', customerId: '2', branch: 'HN', customerName: 'Chị An', sale: 'Duy Thái', paymentSchedule: '1', scheduleDays: 1,
      currentDebt: 0, overdueDebt: 0, payoffDay: null, beyondHistory: false, equivalentDays: null, remainingDays: null },
    { customerKey: 'saigon:1', branchCode: 'saigon', customerId: '1', branch: 'SG', customerName: 'Anh Sài', sale: 'Tú Uyên', paymentSchedule: '7', scheduleDays: 7,
      currentDebt: 50000, overdueDebt: 0, payoffDay: '2026-10-15', beyondHistory: false, equivalentDays: 2, remainingDays: 5 },
    { customerKey: 'saigon:2', branchCode: 'saigon', customerId: '2', branch: 'SG', customerName: 'Chị Xa', sale: 'Tú Uyên', paymentSchedule: '3', scheduleDays: 3,
      currentDebt: 9000000, overdueDebt: 9000000, payoffDay: '2025-10-18', beyondHistory: true, equivalentDays: 364, remainingDays: -361 }
  ]
};

function createDashboard(agingPayload) {
  const source = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const dom = new JSDOM(source, { runScripts: 'outside-only', url: 'https://tokosi.example/#debt' });
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => { if (dom.window.document) callback(); };
  dom.window.TKSNav = { authGuard: () => new Promise(() => {}), can: () => true, handleBranchError: () => false, renderTopSidebar() {} };
  const requests = [];
  dom.window.fetch = url => {
    requests.push(String(url));
    if (String(url).startsWith('/api/debt-management/aging')) {
      return Promise.resolve({ ok: true, json: async () => typeof agingPayload === 'function' ? agingPayload(String(url)) : agingPayload });
    }
    return new Promise(() => {});
  };
  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim())
    .forEach(script => dom.window.eval(script));
  return { dom, requests };
}

function rowTexts(document) {
  return [...document.querySelectorAll('#debtAgingRows tr')].map(row => [...row.cells].map(cell => cell.textContent.trim()));
}

test('server aging preserves full facets/count and sends filter/sort/page to API', async () => {
  const {dom,requests} = createDashboard(url=>{
    const query = new URL(url,'https://tokosi.example').searchParams;
    return {...AGING,customers:[AGING.customers[0]],rows:[AGING.customers[0]],totalRows:205,page:Number(query.get('page')||1),pageSize:100,
      filters:{teams:['Remote team'],sales:['Remote sale'],schedules:['30']}};
  });
  await dom.window.loadDebtAging();
  const doc = dom.window.document;
  assert.equal(doc.getElementById('tagDebtAging').textContent,'205');
  assert.ok([...doc.getElementById('debtAgingSaleFilter').options].some(o=>o.value==='Remote sale'));
  doc.getElementById('debtAgingNextPage').click();
  for(let i=0;i<8;i++) await new Promise(r=>setImmediate(r));
  assert.match(doc.getElementById('debtAgingPageLabel').textContent,/2\/3/);
  dom.window.setTableSort('debtAgingRows',9);
  for(let i=0;i<8;i++) await new Promise(r=>setImmediate(r));
  const q = new URL(requests.at(-1),'https://tokosi.example').searchParams;
  assert.equal(q.get('page'),'1');
  assert.deepEqual(JSON.parse(q.get('sorts')),[{key:'remainingDays',dir:'asc'}]);
});

test('muc 3 co du 10 cot, Ngay het no mac dinh an, nut Xuat file debt.aging', () => {
  const source = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const { dom } = createDashboard(AGING);
  const table = dom.window.document.querySelector('[data-debt-aging-table]');
  const headers = [...table.tHead.rows[0].cells];
  assert.deepEqual(headers.map(cell => cell.dataset.columnKey), [
    'co-so', 'khach-hang', 'sale', 'sale-team', 'lich-tt', 'no-hien-tai', 'no-qua-han', 'ngay-het-no', 'ngay-no-tuong-duong', 'con-han'
  ]);
  assert.deepEqual(headers.filter(cell => cell.dataset.columnDefaultHidden === 'true').map(cell => cell.dataset.columnKey), ['ngay-het-no']);
  assert.match(source, /openExportDialog\('debt\.aging'\)/);
});

test('tai bang tinh san, hien so, to mau Con han va dau ≥/≤ khi vuot lich su', async () => {
  const { dom, requests } = createDashboard(AGING);
  const { window } = dom;
  await window.loadDebtAging();
  assert.ok(requests.some(url=>url.startsWith('/api/debt-management/aging?')));
  const document = window.document;
  assert.equal(document.getElementById('tagDebtAging').textContent, '4');
  const rows = rowTexts(document);
  assert.deepEqual(rows[0].slice(0, 2), ['HN', 'Anh Bình']);
  assert.deepEqual(rows[0].slice(7), ['10/10/2026', '7', '-2']);
  assert.deepEqual(rows[1].slice(7), ['—', '—', '—']);
  assert.deepEqual(rows[3].slice(7), ['trước 18/10/2025', '≥ 364', '≤ -361']);
  const tones = [...document.querySelectorAll('#debtAgingRows [class^="debt-aging-"]')].map(el => [el.className, el.textContent]);
  assert.deepEqual(tones, [['debt-aging-neg', '-2'], ['debt-aging-pos', '5'], ['debt-aging-neg', '≤ -361']]);
  assert.match(window.debtAgingDaysHtml({ remainingDays: 0 }, 'remainingDays'), /debt-aging-zero/);
  assert.match(document.getElementById('debtAgingSourceLabel').textContent, /^tính lúc /);
});

test('loc Sale / Lich / Tim va sap xep Con han tang dan', async () => {
  const { dom } = createDashboard(AGING);
  const { window } = dom;
  const document = window.document;
  await window.loadDebtAging();
  document.getElementById('debtAgingSaleFilter').value = 'Tú Uyên';
  window.handleDebtAgingFilterChange();
  assert.deepEqual(rowTexts(document).map(row => row[1]), ['Anh Sài', 'Chị Xa']);
  document.getElementById('debtAgingSaleFilter').value = '';
  document.getElementById('debtAgingSearch').value = 'bình';
  window.handleDebtAgingFilterChange();
  assert.deepEqual(rowTexts(document).map(row => row[1]), ['Anh Bình']);
  document.getElementById('debtAgingSearch').value = '';
  window.handleDebtAgingFilterChange();
  window.setTableSort('debtAgingRows', 9);
  // Con han trong (khach het no) xep cuoi.
  assert.deepEqual(rowTexts(document).map(row => row[1]), ['Chị Xa', 'Anh Bình', 'Anh Sài', 'Chị An']);
  const payload = window.buildExportPayload('debt.aging');
  assert.deepEqual(JSON.parse(JSON.stringify(payload.context.debtAgingSort)), { columnIndex: 9, direction: 'asc' });
});

test('chua tinh lan nao -> canh bao, bang trong', async () => {
  const { dom } = createDashboard({ available: false, customers: [] });
  await dom.window.loadDebtAging();
  const document = dom.window.document;
  assert.equal(document.getElementById('debtAgingWarning').hidden, false);
  assert.match(document.getElementById('debtAgingRows').textContent, /Chưa có số liệu tuổi nợ/);
});

test('bam dong khach mo hop hoa don: chi so tong quan, 5 cot, bang co key de sort + Cot hien thi, khach het no bao khong co no', async () => {
  const { dom, requests } = createDashboard(AGING);
  const { window } = dom;
  const document = window.document;
  await window.loadDebtAging();
  const detail = {
    customerName: 'Anh Bình', branch: 'HN', currentDebt: 600000, payoffDay: '2026-10-10', beyondHistory: false,
    equivalentDays: 7, remainingDays: -2, scheduleDays: 5, total: 600000, truncated: false,
    invoices: [
      { code: 'HD10', customerName: 'Anh Bình', seller: 'Nguyễn Hiền', date: '17/10/2026 08:00', amount: 100000 },
      { code: 'HD11', customerName: 'Anh Bình', seller: 'Lê Nam', date: '15/10/2026 09:00', amount: 500000 }
    ]
  };
  const baseFetch = window.fetch;
  window.fetch = url => String(url).startsWith('/api/debt-management/aging/invoices')
    ? (requests.push(String(url)), Promise.resolve({ ok: true, json: async () => detail }))
    : baseFetch(url);
  const rows = [...document.querySelectorAll('#debtAgingRows tr.doc-row')];
  assert.equal(rows.length, 4, 'moi dong khach phai bam duoc');
  rows[0].click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(requests.includes('/api/debt-management/aging/invoices?branch=hanoi&customerId=1'), requests.join('\n'));
  const body = document.getElementById('docModalBody');
  assert.match(document.getElementById('docModalTitle').textContent, /Hóa đơn · Anh Bình/);
  assert.ok(body.querySelector('.dp-stats'), 'co hang chi so tong quan');
  const table = body.querySelector('table.dp-table');
  assert.ok(table.dataset.tableKey, 'bang trong hop can data-table-key de sort/Cot hien thi');
  assert.deepEqual([...table.tHead.rows[0].cells].map(cell => cell.textContent.trim()),
    ['Mã hóa đơn', 'Khách hàng', 'Nhân viên bán hàng', 'Ngày', 'Số tiền']);
  assert.equal(table.tBodies[0].rows.length, 2);
  assert.ok(table.tFoot, 'dong Cong nam trong tfoot de khong bi sort');
  window.closeDocumentDetail();
  window.fetch = url => String(url).startsWith('/api/debt-management/aging/invoices')
    ? Promise.resolve({ ok: true, json: async () => ({ ...detail, currentDebt: 0, payoffDay: null, invoices: [] }) })
    : baseFetch(url);
  rows[1].click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.match(body.textContent, /không có nợ/);
});

test('cot Con han (ke ca dong ≤ -x) duoc table-align.js can phai nhu cac cot so', async () => {
  const { dom } = createDashboard(AGING);
  const { window } = dom;
  const document = window.document;
  await window.loadDebtAging();
  window.requestAnimationFrame = callback => callback();
  window.MutationObserver = function () { this.observe = () => {}; };
  window.eval(fs.readFileSync(path.join(publicDir, 'shared', 'table-align.js'), 'utf8'));
  const table = document.querySelector('[data-debt-aging-table]');
  const aligned = [...table.tHead.rows[0].cells].map(cell => cell.classList.contains('col-num'));
  // Co so, Khach hang, Sale: chu; Lich TT, No hien tai, No qua han, Ngay no tuong duong, Con han: so (Ngay het no la ngay).
  assert.deepEqual(aligned, [false, false, false, false, true, true, true, false, true, true]);
  assert.ok(table.tBodies[0].rows[3].cells[9].classList.contains('col-num'), 'o ≤ -361 cung can phai');
});


test('Nhóm sale filters aging independently and resets pagination', async () => {
  const payload = structuredClone(AGING);
  payload.customers.forEach((r, i) => { r.saleTeam = i < 2 ? 'Team A' : 'Chưa có team'; });
  const { dom } = createDashboard(payload);
  try {
    await dom.window.loadDebtAging();
    const select = dom.window.document.getElementById('debtAgingTeamFilter');
    assert.ok(select);
    select.value = 'Team A';
    dom.window.handleDebtAgingFilterChange();
    assert.equal(dom.window.document.querySelectorAll('#debtAgingRows tr').length, 2);
    assert.ok([...dom.window.document.querySelectorAll('#debtAgingRows tr')].every(r => r.cells[3].textContent === 'Team A'));
  } finally { dom.window.close(); }
});
