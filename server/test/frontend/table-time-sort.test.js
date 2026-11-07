'use strict';

// Cot thoi gian phai sap theo THOI GIAN that (khong phai chuoi: "30/09/2026" dung SAU "01/10/2026" neu so sanh chu)
// va sap tren TOAN BO du lieu da loc, khong phu thuoc trang dang xem.
//  - Dashboard (index.html): getTableSortValue doc o chi gom 1 moc thoi gian (dd/MM/yyyy[ HH:mm[:ss]], yyyy-MM-dd[ HH:mm[:ss]]);
//    "Chi tiet giao dich" hien gio KHONG co nam nen server gui them timeMs va dong bang gan data-sort-value.
//  - Trang Tai khoan: thu tu mac dinh "tai khoan moi tao truoc" (ngayTao dd/MM/yyyy) khong duoc so sanh chuoi.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const dashboardHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const accountHtml = fs.readFileSync(path.join(publicDir, 'account', 'index.html'), 'utf8');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
const pad = value => String(value).padStart(2, '0');

function createDashboard({ data, hash = '#overview' } = {}) {
  const dom = new JSDOM(dashboardHtml, { runScripts: 'outside-only', url: 'https://tokosi.example/' + hash });
  if (data) {
    dom.window.sessionStorage.setItem('tksDashboardCache', JSON.stringify({
      data,
      days: 30,
      filters: { products: { mode: 'days', days: 30 }, invoices: { mode: 'days', days: 30 } }
    }));
  }
  dom.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom.window.HTMLElement.prototype.scrollIntoView = function () {};
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  dom.window.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; }
    destroy() {}
  };
  dom.window.setInterval = () => 1;
  dom.window.requestAnimationFrame = callback => callback();
  dom.window.TKSNav = { authGuard: () => new Promise(() => {}), can: () => true, handleBranchError: () => false, renderTopSidebar() {} };
  dom.window.fetch = () => new Promise(() => {});
  ['pagination.js', 'table-explorer.js'].forEach(file => {
    dom.window.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8'));
  });
  [...dashboardHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(script => script.trim())
    .forEach(script => dom.window.eval(script));
  return dom;
}

function invoicesPayload(transactions) {
  return {
    kpi: {
      totalStock: 0, totalProducts: 0, lowStockCount: 0,
      totalCustomers: 0, customersWithDebt: 0, totalDebt: 0, inStockCodes: 0, totalInventoryValue: 0
    },
    filters: { products: { label: '30 ngày' }, invoices: { label: '30 ngày' } },
    invoices: {
      periodRevenue: 0, periodInvoices: 0, periodCancelledInvoices: 0, revenueByDay: [],
      transactionsReport: { transactions, topTransactions: [], summary: { quantity: 0, quantityKnown: true, revenue: 0, discount: 0, paid: 0 } }
    },
    products: {
      newProducts: { label: '30 ngày', count: 0, dateColumnAvailable: true, products: [] },
      topSellingProducts: [], topSellingParentCategories: [], childCategorySalesByParent: {}, availableParentCategories: [],
      allSellingProducts: [],
      newlyImported: { products: [], salesRevenue: 0, salesQty: 0 }
    },
    endOfDay: [],
    customers: { topDebt: [], topRevenue: { top15: [], all: [], label: 'Tất cả' } }
  };
}

const ALL_PRODUCTS_IDS = {
  tbody: 'endOfDayRows', pagination: 'endOfDayPagination',
  firstBtn: 'endOfDayFirstPage', prevBtn: 'endOfDayPrevPage',
  nextBtn: 'endOfDayNextPage', lastBtn: 'endOfDayLastPage', label: 'endOfDayPageLabel'
};

// Cot chi co chuoi hien thi, KHONG co data-sort-value: dung lai dung truong hop cua cac o thoi gian chua duoc danh dau.
const plainDateRow = item => `<tr><td>${item.code}</td><td>${item.when}</td></tr>`;

const secondColumn = doc => [...doc.querySelectorAll('#endOfDayRows tr td:nth-child(2)')].map(td => td.textContent.trim());

test('parseSortableDateText: doc dung dd/MM/yyyy[ HH:mm[:ss]] va yyyy-MM-dd[ HH:mm[:ss]] thanh epoch ms (khong lech mui gio)', () => {
  const dom = createDashboard();
  const parse = dom.window.parseSortableDateText;
  assert.equal(parse('30/09/2026'), Date.UTC(2026, 8, 30));
  assert.equal(parse('01/10/2026 09:05'), Date.UTC(2026, 9, 1, 9, 5));
  assert.equal(parse('18/09/2026 14:28:07'), Date.UTC(2026, 8, 18, 14, 28, 7));
  assert.equal(parse('2026-09-30'), Date.UTC(2026, 8, 30));
  assert.equal(parse('2026-10-01 09:05'), Date.UTC(2026, 9, 1, 9, 5));
  assert.equal(parse('2026-10-01T09:05:30'), Date.UTC(2026, 9, 1, 9, 5, 30));
  assert.equal(parse('  1/2/2026  '), Date.UTC(2026, 1, 1), 'ngay/thang khong dem 0 va khoang trang thua van doc duoc');

  assert.ok(parse('30/09/2026 10:00') < parse('01/10/2026 09:00'), '30/09 truoc 01/10 theo thoi gian that');
  assert.ok(parse('31/12/2025') < parse('01/01/2026'), 'qua ranh gioi nam');
  assert.ok('30/09/2026 10:00' > '01/10/2026 09:00', 'doi chieu: so sanh CHUOI se xep nguoc');
  dom.window.close();
});

test('parseSortableDateText: chi nhan khi CA O la moc thoi gian hop le, con lai tra null (giu cach so sanh cu)', () => {
  const dom = createDashboard();
  const parse = dom.window.parseSortableDateText;
  [
    '', '—', 'abc', '21/09 09:08', '09:08', '21/09', '2026', '12345',   // thieu nam / khong phai thoi gian
    '31/02/2026', '30/13/2026', '00/01/2026', '2026-13-01', '2026-02-30', // ngay khong ton tai
    '30/09/2026 24:00', '30/09/2026 10:60', '30/09/2026 10:00:60',       // gio khong hop le
    'Đơn 30/09/2026', '30/09/2026 (hôm qua)', 'HD013586', 'SP-2026-01-01', '+84 912 345 678'
  ].forEach(text => assert.equal(parse(text), null, JSON.stringify(text)));
  assert.equal(parse(null), null);
  assert.equal(parse(undefined), null);
  dom.window.close();
});

test('getTableSortValue: data-sort-value van thang; o thoi gian khong co data-sort-value duoc doc thanh so; o trong/"—" la empty', () => {
  const dom = createDashboard();
  const doc = dom.window.document;
  const cell = (text, sortValue) => {
    const td = doc.createElement('td');
    td.textContent = text;
    if (sortValue !== undefined) td.setAttribute('data-sort-value', sortValue);
    return td;
  };
  const get = dom.window.getTableSortValue;

  assert.deepEqual({ ...get(cell('150.000 ₫', '150000')) }, { empty: false, number: 150000, text: '' }, 'data-sort-value thang');
  assert.equal(get(cell('30/09/2026 10:00')).number, Date.UTC(2026, 8, 30, 10, 0));
  assert.equal(get(cell('30/09/2026 10:00')).empty, false);
  assert.equal(get(cell('01/10/2026')).number, Date.UTC(2026, 9, 1));
  assert.deepEqual({ ...get(cell('Khay giấy bạc')) }, { empty: false, number: null, text: 'Khay giấy bạc' }, 'chu thuong van so sanh chuoi');
  assert.deepEqual({ ...get(cell('21/09 09:08')) }, { empty: false, number: null, text: '21/09 09:08' }, 'gio khong co nam khong doan nam');
  assert.equal(get(cell('—')).empty, true);
  assert.equal(get(cell('   ')).empty, true);
  assert.equal(get(cell('', 'NaN')).empty, true, 'data-sort-value khong phai so -> empty');
  dom.window.close();
});

test('bang >100 dong: cot thoi gian sort theo THOI GIAN that tren TOAN BO du lieu, dong som nhat o trang cuoi len dau trang 1', () => {
  const dom = createDashboard();
  const doc = dom.window.document;
  // 250 dong, dong dau la moi nhat (01/10/2026) lui dan moi dong 1 ngay -> dong cuoi (trang 3) la som nhat.
  const base = Date.UTC(2026, 9, 1);
  const items = Array.from({ length: 250 }, (_, index) => {
    const date = new Date(base - index * 86400000);
    return { code: 'SP' + index, when: `${pad(date.getUTCDate())}/${pad(date.getUTCMonth() + 1)}/${date.getUTCFullYear()} 08:30` };
  });
  const chronological = items.map(item => item.when).reverse(); // som nhat -> moi nhat

  dom.window.renderPaginatedRows('endOfDay', ALL_PRODUCTS_IDS, items, plainDateRow, 2, 'Không có dữ liệu');
  assert.deepEqual(secondColumn(doc).slice(0, 2), [items[0].when, items[1].when], 'chua sort: giu thu tu nguon');

  dom.window.setTableSort('endOfDayRows', 1); // tang dan
  assert.deepEqual(secondColumn(doc), chronological.slice(0, 100), 'trang 1 = 100 moc som nhat theo dung thu tu thoi gian');
  assert.match(doc.getElementById('endOfDayPageLabel').textContent, /Trang 1\/3/);
  doc.getElementById('endOfDayLastPage').click();
  assert.deepEqual(secondColumn(doc), chronological.slice(200), 'trang cuoi = 50 moc moi nhat');

  dom.window.setTableSort('endOfDayRows', 1); // giam dan
  doc.getElementById('endOfDayFirstPage').click();
  assert.deepEqual(secondColumn(doc), chronological.slice().reverse().slice(0, 100), 'giam dan: trang 1 bat dau tu moc moi nhat');
  assert.equal(secondColumn(doc)[0], '01/10/2026 08:30');
  dom.window.close();
});

test('o thoi gian dang yyyy-MM-dd va dd/MM/yyyy cung sort dung; o trong/"—" luon o cuoi ca tang dan lan giam dan', () => {
  const dom = createDashboard();
  const doc = dom.window.document;
  const items = [
    { code: 'A', when: '2026-10-01' },
    { code: 'B', when: '—' },
    { code: 'C', when: '2025-12-31' },
    { code: 'D', when: '30/09/2026' },
    { code: 'E', when: '' },
    { code: 'F', when: '2026-01-05 07:00' }
  ];
  dom.window.renderPaginatedRows('endOfDay', ALL_PRODUCTS_IDS, items, plainDateRow, 2, 'Không có dữ liệu');
  const codes = () => [...doc.querySelectorAll('#endOfDayRows tr td:nth-child(1)')].map(td => td.textContent.trim());

  const lastTwo = () => codes().slice(4).sort();

  dom.window.setTableSort('endOfDayRows', 1);
  assert.deepEqual(codes().slice(0, 4), ['C', 'F', 'D', 'A'], 'tang dan: 31/12/2025 < 05/01/2026 < 30/09/2026 < 01/10/2026');
  assert.deepEqual(lastTwo(), ['B', 'E'], 'tang dan: 2 o trong (— va rong) nam cuoi');
  dom.window.setTableSort('endOfDayRows', 1);
  assert.deepEqual(codes().slice(0, 4), ['A', 'D', 'F', 'C'], 'giam dan');
  assert.deepEqual(lastTwo(), ['B', 'E'], 'giam dan: o trong van o cuoi');
  dom.window.close();
});

test('bang khong phan trang (sortTableRows) cung sort o thoi gian theo thoi gian that', () => {
  const dom = createDashboard();
  const doc = dom.window.document;
  const tbody = doc.getElementById('endOfDayRows');
  tbody.innerHTML = ['30/09/2026 10:00', '01/10/2026 09:00', '15/02/2026 23:59', '—']
    .map((when, index) => `<tr><td>R${index}</td><td>${when}</td></tr>`).join('');
  dom.window.sortTableRows('endOfDayRows', 1, 'asc');
  assert.deepEqual([...tbody.rows].map(row => row.cells[0].textContent), ['R2', 'R0', 'R1', 'R3']);
  dom.window.sortTableRows('endOfDayRows', 1, 'desc');
  assert.deepEqual([...tbody.rows].map(row => row.cells[0].textContent), ['R1', 'R0', 'R2', 'R3']);
  dom.window.close();
});

test('"Chi tiet giao dich" hien gio KHONG co nam: dong bang dung timeMs lam data-sort-value, sort dung ranh gioi thang', () => {
  const transactions = [
    { code: 'HD-NEW', branch: 'Hà Nội', time: '01/10 09:00', timeMs: Date.parse('2026-10-01T09:00:00+07:00'), customer: 'KH', employee: 'NV', quantity: 1, quantityKnown: true, revenue: 1, discount: 0, paid: 1, status: 'Hoàn thành' },
    { code: 'HD-OLD', branch: 'Hà Nội', time: '30/09 10:00', timeMs: Date.parse('2026-09-30T10:00:00+07:00'), customer: 'KH', employee: 'NV', quantity: 1, quantityKnown: true, revenue: 1, discount: 0, paid: 1, status: 'Hoàn thành' },
    { code: 'HD-NONE', branch: 'Hà Nội', time: '—', timeMs: null, customer: 'KH', employee: 'NV', quantity: 1, quantityKnown: true, revenue: 1, discount: 0, paid: 1, status: 'Hoàn thành' }
  ];
  const dom = createDashboard({ data: invoicesPayload(transactions), hash: '#invoices' });
  const doc = dom.window.document;
  const rows = () => [...doc.querySelectorAll('#endOfDayRows tr.doc-row')];
  const codes = () => rows().map(row => row.cells[0].textContent.trim());

  assert.deepEqual(codes(), ['HD-NEW', 'HD-OLD', 'HD-NONE'], 'chua sort: thu tu server (moi nhat truoc)');
  assert.equal(rows()[0].cells[1].getAttribute('data-sort-value'), String(transactions[0].timeMs));
  assert.equal(rows()[1].cells[1].getAttribute('data-sort-value'), String(transactions[1].timeMs));
  assert.equal(rows()[2].cells[1].hasAttribute('data-sort-value'), false, 'khong co timeMs -> khong gan 0/1970');

  dom.window.setTableSort('endOfDayRows', 1); // tang dan theo cot "Thoi gian"
  assert.deepEqual(codes(), ['HD-OLD', 'HD-NEW', 'HD-NONE'], '30/09 truoc 01/10 (so sanh chuoi se xep nguoc), dong khong co gio o cuoi');
  dom.window.setTableSort('endOfDayRows', 1); // giam dan
  assert.deepEqual(codes(), ['HD-NEW', 'HD-OLD', 'HD-NONE'], 'giam dan: dong khong co gio van o cuoi');
  dom.window.close();
});

test('"Chi tiet giao dich" nhieu trang: sort cot "Thoi gian" chay tren toan bo giao dich, khong chi trang dang xem', () => {
  // 150 giao dich, server tra moi nhat truoc: trang 1 = 100 giao dich moi nhat, 50 cu nhat nam o trang 2.
  const newest = Date.parse('2026-10-01T18:00:00+07:00');
  const transactions = Array.from({ length: 150 }, (_, index) => {
    const timeMs = newest - index * 3600 * 1000 * 7; // moi dong cach nhau 7 gio, bat dau tu 01/10 18:00 va lui dan
    const local = new Date(timeMs + 7 * 3600 * 1000);
    return {
      code: 'HD-' + String(index).padStart(3, '0'), branch: 'Hà Nội',
      time: `${pad(local.getUTCDate())}/${pad(local.getUTCMonth() + 1)} ${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
      timeMs, customer: 'KH', employee: 'NV', quantity: 1, quantityKnown: true, revenue: 1, discount: 0, paid: 1, status: 'Hoàn thành'
    };
  });
  const dom = createDashboard({ data: invoicesPayload(transactions), hash: '#invoices' });
  const doc = dom.window.document;
  const codes = () => [...doc.querySelectorAll('#endOfDayRows tr.doc-row')].map(row => row.cells[0].textContent.trim());

  assert.equal(codes()[0], 'HD-000');
  dom.window.setTableSort('endOfDayRows', 1); // tang dan: giao dich cu nhat (HD-149, o trang 2 truoc khi sort) len dau
  assert.equal(codes().length, 100);
  assert.deepEqual(codes().slice(0, 3), ['HD-149', 'HD-148', 'HD-147']);
  assert.match(doc.getElementById('endOfDayPageLabel').textContent, /Trang 1\/2/);
  dom.window.close();
});

test('trang Tai khoan: thu tu mac dinh (ngayTao moi nhat truoc) theo THOI GIAN that, tai khoan khong co ngay tao xuong cuoi', async () => {
  const user = (username, ngayTao) => ({
    id: username, username, hoTen: username, email: username + '@example.com', soDienThoai: '', vaiTro: 'Nhân viên kho', coSo: 'Hà Nội',
    trangThai: 'Đang hoạt động', ngayTao
  });
  // So sanh CHUOI se xep 30/09/2026 TRUOC 01/10/2026 va 31/12/2025 sau 15/02/2026 khi di xuong.
  const users = [user('thang9', '30/09/2026'), user('thang10', '01/10/2026'), user('thang2', '15/02/2026'), user('namtruoc', '31/12/2025'), user('khongngay', '')];

  const dom = new JSDOM(accountHtml, { runScripts: 'outside-only', url: 'https://tokosi.example/account/#users' });
  const { window } = dom;
  const permissions = ['account.profile', 'account.users', 'account.users.manage', 'account.permissions'];
  const me = { id: 'thang10', username: 'thang10', hoTen: 'thang10', vaiTro: 'Quản lý', isSeniorAdmin: false, permissions, branches: ['Hà Nội', 'Sài Gòn', 'Cả hai'] };
  window.TKSNav = {
    authGuard: async () => me,
    can: (...keys) => keys.some(key => permissions.includes(key)),
    renderTopSidebar() {}, renderAccountChip() {}, logout() {}
  };
  window.fetch = async url => {
    const target = String(url);
    if (target.includes('/api/admin/users')) return { ok: true, status: 200, json: async () => ({ users }) };
    if (target.includes('/api/admin/permissions/catalog')) return { ok: true, status: 200, json: async () => ({ groups: [], features: [], roleDefaults: {} }) };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  [...accountHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]).filter(script => script.trim() && !script.includes('src='))
    .forEach(script => window.eval(script));
  window.dispatchEvent(new window.Event('DOMContentLoaded'));
  await settle();

  const usernames = () => [...window.document.querySelectorAll('#usersTableBody .user-username')].map(node => node.textContent.trim().replace(/^@/, ''));
  assert.deepEqual(usernames(), ['thang10', 'thang9', 'thang2', 'namtruoc', 'khongngay'], 'moi nhat truoc: 01/10/2026, 30/09/2026, 15/02/2026, 31/12/2025');

  window.handleSort('ngayTao'); // bo sap xep mac dinh dang giam dan, tra ve thu tu API
  assert.deepEqual(usernames(), users.map(user => user.username));
  window.handleFilterUsers();
  assert.deepEqual(usernames(), users.map(user => user.username), 'loc lai khong bat sort tro lai');
  window.handleSort('ngayTao'); // bat lai: cu nhat truoc, tai khoan khong co ngay tao van o cuoi
  assert.deepEqual(usernames(), ['namtruoc', 'thang2', 'thang9', 'thang10', 'khongngay']);
  window.handleSort('ngayTao');
  assert.deepEqual(usernames(), ['thang10', 'thang9', 'thang2', 'namtruoc', 'khongngay']);
  window.handleSort('ngayTao');
  assert.deepEqual(usernames(), users.map(user => user.username));
  window.handleSort('coSo');
  window.handleSort('username', {shiftKey:true});
  assert.deepEqual(usernames(), ['khongngay','namtruoc','thang2','thang9','thang10']);
  assert.match(window.document.getElementById('sort-username').textContent, /2/);
  window.handleSort('username', {shiftKey:true});
  assert.deepEqual(usernames(), ['thang10','thang9','thang2','namtruoc','khongngay']);
  window.close();
});


test('editable dashboard columns read current fields before stale sort metadata', () => {
  const dom = createDashboard();
  const doc = dom.window.document;
  const get = dom.window.getTableSortValue;
  const cell = html => { const td = doc.createElement('td'); td.innerHTML = html; return td; };
  const number = cell('<input type="number" value="2">');
  number.dataset.sortValue = '999';
  number.querySelector('input').value = '12.5';
  assert.equal(get(number).number, 12.5);
  const choice = cell('<select><option>Zebra</option><option selected>An</option></select>');
  choice.dataset.sortText = 'Old';
  assert.equal(get(choice).text, 'An');
  choice.querySelector('select').selectedIndex = 0;
  assert.equal(get(choice).text, 'Zebra');
  const note = cell('<textarea>Old</textarea>');
  note.querySelector('textarea').value = 'New';
  assert.equal(get(note).text, 'New');
  assert.equal(get(cell('<input type="date" value="2026-10-01">')).number, Date.UTC(2026,9,1));
  assert.equal(get(cell('<input value="">')).empty, true);
  assert.equal(get(cell('<input value="1,234.50">')).number, 1234.5);
  assert.equal(get(cell('<input value="-12,5">')).number, -12.5);
  assert.equal(get(cell('<input value="0901234567">')).number, null);
  const sorted = dom.window.sortItemsByRenderedColumn([{n:100},{n:2}], item=>'<tr><td><input type="number" value="'+item.n+'"></td></tr>',0,'asc');
  assert.deepEqual(Array.from(sorted,item=>item.n),[2,100]);
  dom.window.close();
});

test('editable HR columns read current numbers, dates and selected labels', () => {
  const dom = new JSDOM('<table></table>', {runScripts:'outside-only'});
  const html = fs.readFileSync(path.join(publicDir,'humanresources/index.html'),'utf8');
  const start = html.indexOf('    function getTableSortValue(cell)');
  const end = html.indexOf('    function sortTableRows(', start);
  dom.window.eval(html.slice(start,end));
  const get = dom.window.getTableSortValue;
  const cell = html => {const td=dom.window.document.createElement('td');td.innerHTML=html;return td;};
  assert.equal(get(cell('<input type="number" value="12.5">')).number,12.5);
  assert.equal(get(cell('<input type="date" value="2026-10-01">')).number,Date.UTC(2026,9,1));
  assert.equal(get(cell('<select><option>Z</option><option selected>A</option></select>')).text,'A');
  assert.equal(get(cell('<textarea>Ghi chú</textarea>')).text,'Ghi chú');
  dom.window.close();
});

test('dashboard multi-sort resolves tied primary values across all filtered rows and keeps empty values last', () => {
  const dom = createDashboard();
  const w = dom.window;
  const items = [{ code: 'z', when: 'B' }, { code: 'b', when: 'A' }, { code: 'a', when: 'A' }, { code: 'x', when: '' }];
  const sorts = [{ columnIndex: 1, direction: 'asc' }, { columnIndex: 0, direction: 'desc' }];
  assert.deepEqual(Array.from(w.sortItemsByRenderedColumn(items, plainDateRow, sorts), x => x.code), ['b', 'a', 'z', 'x']);
  dom.window.close();
});

test('dashboard header Shift-click adds priorities and cycles only the selected level', () => {
  const dom=createDashboard();
  const w=dom.window,doc=w.document;
  const body=doc.getElementById('endOfDayRows');
  body.innerHTML='<tr><td>B</td><td>same</td></tr><tr><td>A</td><td>same</td></tr><tr><td>Z</td><td>later</td></tr>';
  const buttons=body.closest('table').querySelectorAll('.sort-button');
  buttons[1].click();
  buttons[0].dispatchEvent(new w.MouseEvent('click',{bubbles:true,shiftKey:true}));
  assert.match(buttons[1].querySelector('.sort-indicator').textContent,/1/);
  assert.match(buttons[0].querySelector('.sort-indicator').textContent,/2/);
  assert.deepEqual(Array.from(body.rows,row=>row.cells[0].textContent),['Z','A','B']);
  buttons[0].dispatchEvent(new w.MouseEvent('click',{bubbles:true,shiftKey:true}));
  assert.deepEqual(Array.from(body.rows,row=>row.cells[0].textContent),['Z','B','A']);
  buttons[0].dispatchEvent(new w.MouseEvent('click',{bubbles:true,shiftKey:true}));
  assert.equal(buttons[0].closest('th').getAttribute('aria-sort'),'none');
  buttons[1].click(); buttons[1].click();
  assert.deepEqual(Array.from(body.rows,row=>row.cells[0].textContent),['B','A','Z']);
  dom.window.close();
});
