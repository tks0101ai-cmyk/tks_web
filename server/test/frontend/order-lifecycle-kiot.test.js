'use strict';

// Trang Vong doi don hang SAU KHI gop MOI don dat hang cua KiotViet (2026-10-02, mo rong tu "Phieu tam"): cot
// "Gia tri don" / "Gia tri co ban" / "Ghi chu" / "Trang thai KiotViet", bo loc Trang thai KiotViet, hop "Cot hien thi",
// dong chi co o Kiot (chi doc, khong ghi de), khoa dong theo co so + ma, LOC / SAP XEP / PHAN TRANG 100 dong/trang do
// MAY CHU (test dung may chu gia lifecycleFakeServer.js, goi chinh module loc cua may chu that), hop chi tiet nap dong
// hang tu Kiot, xuat Excel gui BO LOC dang ap dung. Chay trang that trong JSDOM voi fetch gia.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { defaultsForRole } = require('../../auth/featureRegistry');
const { lifecycleResponse, isListUrl } = require('./lifecycleFakeServer');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'shipment', 'lifecycle', 'index.html'), 'utf8');

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };

function fakeCan(vaiTro) {
  const permissions = defaultsForRole(vaiTro);
  return (...keys) => keys.some(key => (Array.isArray(key) ? key : [key]).some(k => permissions.includes(k)));
}

// Dong tu sheet (co moc thoi gian, KHONG co don Kiot) — branch/summary nhu server tra ve.
function sheetOrder(code, extra = {}) {
  return {
    orderCode: code, branch: 'HN', saleName: 'Sale A', customerName: 'KH Sheet', saleSentAt: '01/10/2026 08:00', warning: false,
    summary: { code: 'DELIVERING', label: 'Đơn đang được giao', at: '01/10/2026 09:00' },
    source: 'sheet', kiotStatus: '', sellableValue: null, orderTotal: null, orderDate: '', note: '',
    ...extra
  };
}

// Don chi co o Kiot (mac dinh Phieu tam): trang thai "chua gui ke toan", cac moc rong.
function kiotOnlyOrder(code, extra = {}) {
  return {
    orderCode: code, branch: 'HN', saleName: 'Sale Kiot', customerName: 'KH Kiot', saleSentAt: '', warning: false,
    summary: { code: 'NOT_SENT', label: 'Đơn chưa gửi kế toán', actor: null, at: null },
    source: 'kiotviet', kiotStatus: 'Phiếu tạm', sellableValue: 1500000, orderTotal: 2000000, orderDate: '01/10/2026 13:14', note: '',
    ...extra
  };
}

async function renderPage({ orders = [], kiot = { ok: true, stale: false, fetchedAt: null, count: 0 }, vaiTro = 'Quản lý', fetchImpl, hiddenColumns } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/shipment/lifecycle/' });
  const { window } = dom;
  const calls = [];
  const source = { orders }; // test co the doi `page.source.orders` roi goi loadBulkOrders(true) de gia lap du lieu moi
  window.setInterval = () => 1;
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8'));
  const readCachedJSON = window.TKSNav.readCachedJSON;
  window.TKSNav = {
    readCachedJSON,
    authGuard: () => Promise.resolve({ vaiTro }),
    can: fakeCan(vaiTro),
    handleBranchError: () => false
  };
  window.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (fetchImpl) {
      const custom = await fetchImpl(String(url), options, window);
      if (custom) return custom;
    }
    if (isListUrl(url)) {
      const body = lifecycleResponse(String(url), source.orders, kiot);
      return { ok: true, status: 200, json: async () => body };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.alert = () => {};
  if (hiddenColumns) window.localStorage.setItem('tks-lifecycle-hidden-columns', JSON.stringify(hiddenColumns));
  window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(fs.readFileSync(path.join(__dirname, '../../public/shared/table-controls.js'), 'utf8'));
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).forEach(script => window.eval(script));
  await settle();
  return { dom, window, document: window.document, calls, source };
}

const rowsOf = document => [...document.querySelectorAll('#bulkBody tr')];
const codesOf = document => rowsOf(document).map(row => row.cells[0].textContent);
const cellOf = (row, key) => row.querySelector(`[data-col="${key}"]`);
const headerNamed = (document, key) => document.querySelector(`#bulkHeadRow th[data-sort="${key}"]`);
const setValue = (window, element, value) => { element.value = value; element.dispatchEvent(new window.Event('change', { bubbles: true })); };
const listCalls = page => page.calls.filter(call => isListUrl(call.url));
const lastListParams = page => new URL(listCalls(page).at(-1).url, 'https://tokosi.example').searchParams;
const columnKeys = document => [...document.querySelectorAll('#bulkHeadRow th')].map(th => th.dataset.col);

// ---------------------------------------------------------------------------
// Cac cot cua don Kiot: Gia tri don, Gia tri co ban, Ghi chu, Trang thai KiotViet
// ---------------------------------------------------------------------------

test('cột "Giá trị đơn" hiện với MỌI đơn Kiot; "Giá trị có bán" chỉ đơn Phiếu tạm; dòng chỉ có ở Sheet hiện "—"', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('A', { orderDate: '03/10/2026 10:00', sellableValue: 21750000, orderTotal: 32000000 }),
    kiotOnlyOrder('B', { orderDate: '02/10/2026 10:00', kiotStatus: 'Hoàn thành', sellableValue: null, orderTotal: 5000000 }),
    kiotOnlyOrder('C', { orderDate: '01/10/2026 10:00', sellableValue: 0, orderTotal: 2000000 }),
    sheetOrder('D')
  ] });
  const rows = rowsOf(page.document); // mac dinh: don moi dat nhat truoc, dong khong co ngay dat cuoi cung
  assert.deepEqual(codesOf(page.document), ['A', 'B', 'C', 'D']);
  assert.deepEqual(rows.map(row => cellOf(row, 'sellableValue').textContent), ['21,750,000', '—', '0', '—'],
    'chi Phieu tam co gia tri co ban; Phieu tam co gia tri 0 van hien 0 (khac "khong co gia tri")');
  assert.deepEqual(rows.map(row => cellOf(row, 'orderTotal').textContent), ['32,000,000', '5,000,000', '2,000,000', '—'],
    'don Hoan thanh van co Gia tri don; dong chi co o Sheet thi khong');
  page.dom.window.close();
});

test('cột "Trạng thái KiotViet": badge theo trạng thái, dòng không có đơn Kiot hiện "—"', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('A', { kiotStatus: 'Phiếu tạm', orderDate: '04/10/2026 10:00' }),
    kiotOnlyOrder('B', { kiotStatus: 'Hoàn thành', orderDate: '03/10/2026 10:00' }),
    kiotOnlyOrder('C', { kiotStatus: 'Đã hủy', orderDate: '02/10/2026 10:00' }),
    sheetOrder('D')
  ] });
  const cells = rowsOf(page.document).map(row => cellOf(row, 'kiotStatus'));
  assert.deepEqual(cells.map(cell => cell.textContent), ['Phiếu tạm', 'Hoàn thành', 'Đã hủy', '—']);
  assert.ok(cells[0].querySelector('.lc-badge.badge-sent'));
  assert.ok(cells[1].querySelector('.lc-badge.badge-delivered'));
  assert.ok(cells[2].querySelector('.lc-badge.badge-cancelled'));
  assert.equal(cells[3].querySelector('.lc-badge'), null);
  page.dom.window.close();
});

test('cột "Ghi chú" nằm ngay bên phải "Giá trị có bán": hiện ghi chú của đơn Kiot (tooltip đủ nội dung), trống hiện "—"; nội dung được thoát HTML', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('A', { orderDate: '03/10/2026 10:00', note: 'Giao sớm\ngọi chị Hằng <b>0989</b>' }),
    kiotOnlyOrder('B', { orderDate: '02/10/2026 10:00', note: '' })
  ] });
  const keys = columnKeys(page.document);
  assert.equal(keys.indexOf('note'), keys.indexOf('sellableValue') + 1);
  const [a, b] = rowsOf(page.document).map(row => cellOf(row, 'note'));
  assert.equal(a.textContent, 'Giao sớm\ngọi chị Hằng <b>0989</b>', 'chu <b> hien nguyen van, khong thanh the HTML');
  assert.equal(a.querySelector('b'), null);
  assert.equal(a.querySelector('.lc-note-text').getAttribute('title'), 'Giao sớm\ngọi chị Hằng <b>0989</b>');
  assert.equal(b.textContent, '—');
  page.dom.window.close();
});

test('đơn chỉ có ở Kiot: nhãn "Đơn chưa gửi kế toán", mốc rỗng "—"; Quản lý (được ghi đè) KHÔNG có ô chọn trạng thái cho đơn Kiot, nhưng vẫn có cho dòng sheet', async () => {
  const page = await renderPage({ orders: [sheetOrder('DH1', { orderDate: '03/10/2026 08:00' }), kiotOnlyOrder('DH2')] });
  const [sheetRow, kiotRow] = rowsOf(page.document);
  assert.ok(sheetRow.querySelector('select.status-select'), 'dong sheet: o chon trang thai (ghi de)');
  assert.equal(kiotRow.querySelector('select'), null, 'don Kiot chua co dong trong Sheet: ghi de se 404 nen khong hien o chon');
  assert.equal(cellOf(kiotRow, 'status').textContent.trim(), 'Đơn chưa gửi kế toán');
  assert.ok(cellOf(kiotRow, 'status').querySelector('.lc-badge.badge-not-sent'));
  assert.equal(cellOf(kiotRow, 'saleSentAt').textContent, '—', 'Sale ra don trong');
  assert.equal(cellOf(kiotRow, 'at').textContent, '—', 'Cap nhat gan nhat trong');
  assert.equal(cellOf(kiotRow, 'warning').textContent, '', 'khong canh bao');
  page.dom.window.close();
});

test('khóa dòng theo CƠ SỞ + MÃ: cùng mã DH ở HN và SG đều hiện (không bị gộp thành 1 dòng)', async () => {
  const page = await renderPage({ orders: [
    sheetOrder('DH018717', { branch: 'HN' }),
    kiotOnlyOrder('DH018717', { branch: 'SG' })
  ] });
  assert.equal(rowsOf(page.document).length, 2);
  page.dom.window.close();
});

test('banner cảnh báo khi nguồn Kiot lỗi (kiot.ok=false); không hiện khi bình thường', async () => {
  const failed = await renderPage({ orders: [sheetOrder('DH1')], kiot: { ok: false, stale: false, fetchedAt: null, count: 0 } });
  const notice = failed.document.getElementById('lcKiotNotice');
  assert.equal(notice.hidden, false);
  assert.match(notice.textContent, /Chưa lấy được đơn từ Kiot/);
  failed.dom.window.close();

  const stale = await renderPage({ orders: [sheetOrder('DH1')], kiot: { ok: true, stale: true, fetchedAt: null, count: 1 } });
  assert.equal(stale.document.getElementById('lcKiotNotice').hidden, false);
  assert.match(stale.document.getElementById('lcKiotNotice').textContent, /chưa mới nhất/);
  stale.dom.window.close();

  const fine = await renderPage({ orders: [sheetOrder('DH1')] });
  assert.equal(fine.document.getElementById('lcKiotNotice').hidden, true);
  fine.dom.window.close();
});

// ---------------------------------------------------------------------------
// Bo loc "Trang thai KiotViet" (mac dinh Tat ca) — ket hop voi bo loc trang thai chinh
// ---------------------------------------------------------------------------

const MIXED = () => [
  kiotOnlyOrder('P1', { orderDate: '05/10/2026 10:00', kiotStatus: 'Phiếu tạm' }),
  kiotOnlyOrder('H1', { orderDate: '04/10/2026 10:00', kiotStatus: 'Hoàn thành', sellableValue: null }),
  kiotOnlyOrder('P2', { orderDate: '03/10/2026 10:00', kiotStatus: 'Phiếu tạm' }),
  kiotOnlyOrder('X1', { orderDate: '02/10/2026 10:00', kiotStatus: 'Đã hủy', sellableValue: null }),
  kiotOnlyOrder('H2', { orderDate: '01/10/2026 10:00', kiotStatus: 'Hoàn thành', sellableValue: null,
    summary: { code: 'DELIVERING', label: 'Đơn đang được giao', at: '02/10/2026 09:00' } })
];

test('bộ lọc "Trạng thái KiotViet": mặc định Tất cả (không gửi tham số); luôn đủ 5 trạng thái của Kiot (kể cả khi dữ liệu chưa có đơn nào ở trạng thái đó)', async () => {
  const page = await renderPage({ orders: MIXED() });
  const select = page.document.getElementById('bulkKiotStatusFilter');
  assert.deepEqual([...select.options].map(option => option.value), ['', 'Phiếu tạm', 'Đã xác nhận', 'Đang giao hàng', 'Hoàn thành', 'Đã hủy']);
  assert.equal([...select.options][0].textContent, 'Tất cả');
  assert.equal(select.value, '', 'mac dinh Tat ca');
  assert.equal(lastListParams(page).has('kiotStatus'), false);
  assert.deepEqual(codesOf(page.document), ['P1', 'H1', 'P2', 'X1', 'H2'], 'mac dinh thay MOI trang thai, ke ca hoan thanh / da huy');
  page.dom.window.close();
});

test('chọn "Trạng thái KiotViet": gửi kiotStatus lên máy chủ, chỉ còn đơn đó, đếm "đã lọc / tổng"; chọn lại Tất cả thì đủ đơn', async () => {
  const page = await renderPage({ orders: MIXED() });
  const { window, document } = page;
  const select = document.getElementById('bulkKiotStatusFilter');

  setValue(window, select, 'Hoàn thành');
  await settle();
  assert.equal(lastListParams(page).get('kiotStatus'), 'Hoàn thành');
  assert.deepEqual(codesOf(document), ['H1', 'H2']);
  assert.equal(document.getElementById('bulkCount').textContent, '2 / 5 đơn');
  assert.deepEqual([...select.options].map(option => option.value), ['', 'Phiếu tạm', 'Đã xác nhận', 'Đang giao hàng', 'Hoàn thành', 'Đã hủy'], 'danh sach trang thai khong co lai sau khi loc');
  assert.equal(select.value, 'Hoàn thành');

  setValue(window, select, '');
  await settle();
  assert.equal(codesOf(document).length, 5);
  assert.equal(lastListParams(page).has('kiotStatus'), false);
  page.dom.window.close();
});

test('bộ lọc trạng thái chính vẫn dùng được và kết hợp với Trạng thái KiotViet', async () => {
  const page = await renderPage({ orders: MIXED() });
  const { window, document } = page;
  setValue(window, document.getElementById('bulkStatusFilter'), 'DELIVERING');
  await settle();
  assert.equal(lastListParams(page).get('status'), 'DELIVERING');
  assert.deepEqual(codesOf(document), ['H2']);

  setValue(window, document.getElementById('bulkKiotStatusFilter'), 'Phiếu tạm');
  await settle();
  assert.deepEqual(codesOf(document), [], 'DELIVERING + Phieu tam khong co don nao');
  assert.equal(document.getElementById('bulkEmpty').hidden, false);
  page.dom.window.close();
});

// ---------------------------------------------------------------------------
// Hop "Cot hien thi" — tick an/hien cot
// ---------------------------------------------------------------------------

const ALL_COLUMNS = ['orderCode', 'branch', 'orderDate', 'saleName', 'customerName', 'orderTotal', 'sellableValue', 'note', 'saleSentAt', 'kiotStatus', 'status', 'pickStatus', 'at', 'warning'];

const DEFAULT_HIDDEN = ['branch', 'note', 'kiotStatus', 'pickStatus']; // Trạng thái bốc mặc định ẩn

const hiddenKeys = document => Array.from(document.querySelectorAll('#bulkHeadRow th.tks-column-hidden'), th => th.dataset.col);
function openPicker(page) { page.document.getElementById('bulkColumnsBtn').click(); return page.document.querySelector('.tks-columns-picker:not([hidden])'); }
test('default lifecycle columns share fixed widths and order with data cells', async () => {
  const page = await renderPage({ orders: [kiotOnlyOrder('A')] });
  assert.deepEqual(columnKeys(page.document), ALL_COLUMNS);
  assert.deepEqual([...rowsOf(page.document)[0].cells].map(td => td.dataset.col), ALL_COLUMNS);
  assert.deepEqual(hiddenKeys(page.document), DEFAULT_HIDDEN);
  assert.equal(page.document.querySelectorAll('#bulkTable .tks-column-resizer').length, ALL_COLUMNS.length);
  assert.equal(page.document.querySelectorAll('#bulkTable colgroup col').length, ALL_COLUMNS.length - DEFAULT_HIDDEN.length);
  page.dom.window.close();
});

test('old stored lifecycle choices are ignored on a fresh page', async () => {
  const page = await renderPage({ orders: [kiotOnlyOrder('A')], hiddenColumns: ['at', 'orderCode', 'unknown'] });
  assert.deepEqual(hiddenKeys(page.document), DEFAULT_HIDDEN);
  page.dom.window.close();
});

test('shared picker reuses lifecycle button, locks order code and returns focus on close', async () => {
  const page = await renderPage({ orders: [kiotOnlyOrder('A')] });
  const picker = openPicker(page);
  assert.ok(picker);
  const inputs = Array.from(picker.querySelectorAll('input[data-column-key]'));
  assert.deepEqual(inputs.map(input => input.dataset.columnKey), ALL_COLUMNS);
  assert.deepEqual(inputs.filter(input => !input.checked).map(input => input.dataset.columnKey), DEFAULT_HIDDEN);
  assert.deepEqual(inputs.filter(input => input.disabled).map(input => input.dataset.columnKey), ['orderCode']);
  picker.querySelector('[data-action="close"]').click();
  assert.equal(picker.hidden, true);
  assert.equal(page.document.activeElement, page.document.getElementById('bulkColumnsBtn'));
  page.dom.window.close();
});

test('shared visibility survives paging and refreshing without browser storage writes', async () => {
  const orders = Array.from({ length: 150 }, (_, i) => kiotOnlyOrder('DH' + String(i + 1).padStart(4, '0'), { note: 'ghi chu ' + i }));
  const page = await renderPage({ orders });
  const picker = openPicker(page);
  picker.querySelector('[data-action="show-all"]').click();
  const note = picker.querySelector('input[data-column-key="note"]');
  note.checked = false;
  note.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  assert.deepEqual(hiddenKeys(page.document), ['note']);
  const next = page.document.getElementById('bulkNextPage');
  next.click(); await settle();
  assert.ok(cellOf(rowsOf(page.document)[0], 'note').classList.contains('tks-column-hidden'));
  assert.equal(page.window.localStorage.getItem('tks-lifecycle-hidden-columns'), null);
  note.checked = true;
  note.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  assert.deepEqual(hiddenKeys(page.document), []);
  page.dom.window.close();
});

test('show all and hide all retain the locked lifecycle identifier', async () => {
  const page = await renderPage({ orders: [kiotOnlyOrder('A')] });
  const picker = openPicker(page);
  picker.querySelector('[data-action="hide-all"]').click();
  assert.deepEqual(hiddenKeys(page.document), ALL_COLUMNS.slice(1));
  picker.querySelector('[data-action="show-all"]').click();
  assert.deepEqual(hiddenKeys(page.document), []);
  page.dom.window.close();
});

// ---------------------------------------------------------------------------
// Sap xep / loc (do may chu) theo gia tri co ban (SO) va ngay dat hang (THOI GIAN THAT)
// ---------------------------------------------------------------------------

test('mặc định sắp theo "Thời gian đặt hàng" mới nhất trước (tiêu đề cột báo ▲ giảm dần, không gửi tham số sort)', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('CU', { orderDate: '30/09/2026 23:30' }),
    kiotOnlyOrder('MOI', { orderDate: '05/01/2027 09:00' }),
    kiotOnlyOrder('GIUA', { orderDate: '01/10/2026 07:00' })
  ] });
  assert.deepEqual(codesOf(page.document), ['MOI', 'GIUA', 'CU'], 'theo thoi gian that, khong theo chuoi dd/MM/yyyy');
  assert.equal(lastListParams(page).has('sort'), false);
  const header = headerNamed(page.document, 'orderDate');
  assert.ok(header.classList.contains('sort-active'));
  assert.equal(header.querySelector('.sort-indicator').textContent, '▲', 'giam dan = ▲ (tang dan ▼, chua sap ▲▼)');
  assert.equal(header.getAttribute('aria-sort'), 'descending');
  assert.equal(headerNamed(page.document, 'orderCode').querySelector('.sort-indicator').textContent, '▲▼');
  page.dom.window.close();
});

test('sắp xếp cột "Giá trị có bán" theo SỐ (không theo chuỗi); đơn không có giá trị luôn cuối', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('A', { sellableValue: 9000000 }),
    kiotOnlyOrder('B', { sellableValue: 10000000 }), // chuoi "10..." < "9..." nhung so lon hon
    sheetOrder('C'),
    kiotOnlyOrder('D', { sellableValue: 250000 })
  ] });
  const header = headerNamed(page.document, 'sellableValue');
  header.click();
  await settle();
  assert.equal(lastListParams(page).get('sort'), 'sellableValue');
  assert.equal(lastListParams(page).get('dir'), 'asc');
  assert.deepEqual(codesOf(page.document), ['D', 'A', 'B', 'C'], 'tang dan theo so, khong co gia tri cuoi');
  header.click();
  await settle();
  assert.equal(lastListParams(page).get('dir'), 'desc');
  assert.deepEqual(codesOf(page.document), ['B', 'A', 'D', 'C'], 'giam dan, khong co gia tri VAN cuoi');
  page.dom.window.close();
});

test('sắp xếp theo "Trạng thái KiotViet" và "Ghi chú"; lần thứ ba bỏ sắp xếp về mặc định', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('A', { orderDate: '03/10/2026 10:00', kiotStatus: 'Hoàn thành', note: 'beta' }),
    kiotOnlyOrder('B', { orderDate: '02/10/2026 10:00', kiotStatus: 'Phiếu tạm', note: 'alpha' }),
    kiotOnlyOrder('C', { orderDate: '01/10/2026 10:00', kiotStatus: 'Đã hủy', note: '' })
  ] });
  const { document } = page;
  headerNamed(document, 'note').click();
  await settle();
  assert.deepEqual(codesOf(document), ['B', 'A', 'C'], 'ghi chu A-Z, ghi chu trong luon cuoi');
  headerNamed(document, 'kiotStatus').click();
  await settle();
  assert.deepEqual(codesOf(document), ['C', 'A', 'B'], 'Da huy < Hoan thanh < Phieu tam (A-Z khong dau)');
  headerNamed(document, 'kiotStatus').click();
  headerNamed(document, 'kiotStatus').click(); // lan thu ba: bo sap xep
  await settle();
  assert.equal(lastListParams(page).has('sort'), false);
  assert.deepEqual(codesOf(document), ['A', 'B', 'C'], 've mac dinh: don moi dat nhat truoc');
  assert.ok(headerNamed(document, 'orderDate').classList.contains('sort-active'));
  page.dom.window.close();
});

test('nút "Bỏ sắp xếp" chỉ hiện khi đang sắp theo cột; bấm → về mặc định, không gửi tham số sort', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('A', { orderDate: '03/10/2026 10:00', note: 'beta' }),
    kiotOnlyOrder('B', { orderDate: '02/10/2026 10:00', note: 'alpha' })
  ] });
  const { document } = page;
  const clearBtn = document.getElementById('bulkClearSort');
  assert.equal(clearBtn.hidden, true, 'mac dinh chua sap theo cot -> an');
  headerNamed(document, 'note').click();
  await settle();
  assert.equal(clearBtn.hidden, false);
  assert.deepEqual(codesOf(document), ['B', 'A']);
  clearBtn.click();
  await settle();
  assert.equal(clearBtn.hidden, true);
  assert.equal(lastListParams(page).has('sort'), false);
  assert.deepEqual(codesOf(document), ['A', 'B']);
  assert.ok(headerNamed(document, 'orderDate').classList.contains('sort-active'));
  page.dom.window.close();
});

test('lọc thời gian theo "Ngày đặt hàng (Kiot)" đúng thời gian thật; dòng sheet không có ngày đặt bị loại khi đã chọn khoảng', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('DA', { orderDate: '30/09/2026 23:30' }),
    kiotOnlyOrder('DB', { orderDate: '01/10/2026 07:00' }),
    kiotOnlyOrder('DC', { orderDate: '05/01/2027 09:00' }),
    sheetOrder('DD')
  ] });
  const { window, document } = page;
  setValue(window, document.getElementById('bulkDateField'), 'orderDate');
  setValue(window, document.getElementById('bulkDateFrom'), '2026-10-01');
  setValue(window, document.getElementById('bulkDateTo'), '2026-10-01');
  await settle();
  assert.deepEqual(codesOf(document), ['DB']);
  assert.equal(lastListParams(page).get('dateField'), 'orderDate');
  setValue(window, document.getElementById('bulkDateTo'), '2027-01-05');
  await settle();
  assert.deepEqual(codesOf(document), ['DC', 'DB']);
  page.dom.window.close();
});

// ---------------------------------------------------------------------------
// Phan trang 100 dong/trang (may chu cat trang) — sap xep TOAN BO danh sach truoc khi cat trang
// ---------------------------------------------------------------------------

function manyOrders(count) {
  // Dong i co saleSentAt GIAM dan theo i (dong 1 moi nhat, dong `count` cu nhat) -> thu tu goc != thu tu tang dan.
  return Array.from({ length: count }, (_, i) => {
    const day = String(28 - Math.floor(i / 10)).padStart(2, '0');
    return sheetOrder('DH' + String(i + 1).padStart(4, '0'), {
      saleSentAt: `${day}/09/2026 ${String(8 + (i % 10)).padStart(2, '0')}:00`,
      summary: { code: 'DELIVERING', label: 'Đơn đang được giao', at: '29/09/2026 08:00' }
    });
  });
}

test('phân trang 100 dòng/trang: nhãn "Trang 1/3", nút trang đầu/trước bị khóa ở trang 1, đếm theo tổng số đơn; trình duyệt chỉ nhận 1 trang', async () => {
  const page = await renderPage({ orders: manyOrders(250) });
  const { document } = page;
  assert.equal(rowsOf(document).length, 100);
  assert.equal(lastListParams(page).get('page'), '1');
  assert.equal(lastListParams(page).get('pageSize'), '100');
  assert.equal(document.getElementById('bulkPagination').hidden, false);
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 1/3');
  assert.equal(document.getElementById('bulkFirstPage').disabled, true);
  assert.equal(document.getElementById('bulkPrevPage').disabled, true);
  assert.equal(document.getElementById('bulkNextPage').disabled, false);
  assert.equal(document.getElementById('bulkCount').textContent, '250 đơn');
  assert.equal(codesOf(document)[0], 'DH0001');

  document.getElementById('bulkNextPage').click();
  await settle();
  assert.equal(lastListParams(page).get('page'), '2');
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 2/3');
  assert.equal(codesOf(document)[0], 'DH0101');
  assert.equal(codesOf(document).length, 100);

  document.getElementById('bulkLastPage').click();
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 3/3');
  assert.equal(rowsOf(document).length, 50);
  assert.equal(document.getElementById('bulkNextPage').disabled, true);
  assert.equal(document.getElementById('bulkLastPage').disabled, true);

  document.getElementById('bulkPrevPage').click();
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 2/3');
  document.getElementById('bulkFirstPage').click();
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 1/3');
  page.dom.window.close();
});

test('dưới 100 đơn: không hiện thanh phân trang', async () => {
  const page = await renderPage({ orders: manyOrders(40) });
  assert.equal(page.document.getElementById('bulkPagination').hidden, true);
  assert.equal(rowsOf(page.document).length, 40);
  page.dom.window.close();
});

test('số đơn lớn hiển thị có dấu chấm ngăn cách nghìn', async () => {
  const page = await renderPage({ orders: manyOrders(1250) });
  assert.equal(page.document.getElementById('bulkCount').textContent, '1,250 đơn');
  assert.equal(page.document.getElementById('bulkPageLabel').textContent, 'Trang 1/13');
  page.dom.window.close();
});

test('sắp xếp cột thời gian áp cho TOÀN BỘ bảng, không chỉ trang đang xem; đổi sắp xếp về trang 1', async () => {
  const orders = manyOrders(250); // DH0250 co saleSentAt som nhat nhung nam o TRANG 3 theo thu tu goc
  const page = await renderPage({ orders });
  const { document } = page;
  const earliest = orders.reduce((best, o) => (
    // so sanh theo thoi gian that: ngay (thang 9) roi gio
    (o.saleSentAt.slice(0, 2) + o.saleSentAt.slice(11, 16)) < (best.saleSentAt.slice(0, 2) + best.saleSentAt.slice(11, 16)) ? o : best
  ), orders[0]);

  document.getElementById('bulkLastPage').click(); // dang o trang 3
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 3/3');

  headerNamed(document, 'saleSentAt').click(); // tang dan
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 1/3', 'doi sap xep ve trang 1');
  assert.equal(codesOf(document)[0], earliest.orderCode, 'dong som nhat (von o trang cuoi) len dau trang 1');

  // Trang 3 sau khi sap tang dan chua cac dong MUON nhat — kiem tra thu tu tang dan xuyen suot cac trang.
  const timeOf = code => {
    const o = orders.find(x => x.orderCode === code);
    return Date.UTC(2026, 8, Number(o.saleSentAt.slice(0, 2)), Number(o.saleSentAt.slice(11, 13)));
  };
  const collected = [];
  for (let p = 1; p <= 3; p++) {
    if (p > 1) { document.getElementById('bulkNextPage').click(); await settle(); }
    collected.push(...codesOf(document));
  }
  assert.equal(collected.length, 250);
  for (let i = 1; i < collected.length; i++) {
    assert.ok(timeOf(collected[i - 1]) <= timeOf(collected[i]), `thu tu thoi gian xuyen cac trang tai vi tri ${i}`);
  }
  page.dom.window.close();
});

test('đổi bộ lọc/tìm kiếm về trang 1; số đơn hiển thị là "đã lọc / tổng"', async () => {
  const orders = manyOrders(250);
  orders[240] = sheetOrder('KHAC-TIM-THAY', { saleName: 'Nguyen Tim Thay' });
  const page = await renderPage({ orders });
  const { window, document } = page;
  document.getElementById('bulkNextPage').click();
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 2/3');

  assert.equal(lastListParams(page).get('mode'), null, 'chua go gi thi khong gui mode');
  document.querySelector('#bulkSearchModes [data-mode="code"]').click(); // mac dinh la "Theo ten khach"
  const input = document.getElementById('bulkSearchInput');
  input.value = 'khac-tim';
  document.getElementById('bulkSearchForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
  assert.equal(lastListParams(page).get('q'), 'khac-tim');
  assert.equal(lastListParams(page).get('mode'), 'code');
  assert.deepEqual(codesOf(document), ['KHAC-TIM-THAY']);
  assert.equal(document.getElementById('bulkPagination').hidden, true);
  assert.equal(document.getElementById('bulkCount').textContent, '1 / 250 đơn');
  page.dom.window.close();
});

test('tìm theo tên sale / khách: đổi kiểu tìm gửi mode tương ứng (chỉ khi có chữ đang nhập)', async () => {
  const page = await renderPage({ orders: [
    sheetOrder('A', { saleName: 'Nguyễn Văn An', customerName: 'Cửa hàng Hoa' }),
    sheetOrder('B', { saleName: 'Trần Thị Bình', customerName: 'Cửa hàng An Phát' })
  ] });
  const { window, document } = page;
  const before = listCalls(page).length;
  document.querySelector('#bulkSearchModes [data-mode="sale"]').click();
  await settle();
  assert.equal(listCalls(page).length, before, 'o tim kiem rong: doi kieu khong goi lai may chu');

  assert.equal(document.querySelector('#bulkSearchModes .active').dataset.mode, 'sale');
  document.getElementById('bulkSearchInput').value = 'nguyen van an'; // khong dau cung khop
  document.querySelector('#bulkSearchModes [data-mode="customer"]').click();
  await settle();
  assert.equal(lastListParams(page).get('mode'), 'customer');
  assert.deepEqual(codesOf(document), [], 'khong co khach ten "nguyen van an"');
  document.querySelector('#bulkSearchModes [data-mode="sale"]').click();
  await settle();
  assert.deepEqual(codesOf(document), ['A']);
  assert.ok(window);
  page.dom.window.close();
});

test('tự làm mới (silent) giữ nguyên trang đang xem; kẹp lại nếu số trang giảm', async () => {
  const page = await renderPage({ orders: manyOrders(250) });
  const { window, document } = page;
  document.getElementById('bulkNextPage').click();
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 2/3');

  // Mo phong lan tu lam moi 60s (visibilitychange kich hoat loadBulkOrders(true)) — du lieu van 250 dong.
  window.eval('loadBulkOrders(true)');
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 2/3', 'giu trang');
  assert.equal(lastListParams(page).get('page'), '2');

  page.source.orders = manyOrders(120); // con 2 trang -> trang hien tai van hop le
  window.eval('loadBulkOrders(true)');
  await settle();
  assert.equal(document.getElementById('bulkPageLabel').textContent, 'Trang 2/2');

  page.source.orders = manyOrders(30); // con 1 trang -> may chu kep ve trang 1
  window.eval('loadBulkOrders(true)');
  await settle();
  assert.equal(document.getElementById('bulkPagination').hidden, true);
  assert.equal(rowsOf(document).length, 30);
  page.dom.window.close();
});

test('đổi bộ lọc liên tiếp: chỉ phản hồi của lần gọi MỚI NHẤT được hiển thị (phản hồi cũ đến muộn bị bỏ)', async () => {
  const pending = [];
  const orders = MIXED();
  const page = await renderPage({
    orders,
    fetchImpl: url => (isListUrl(url)
      ? new Promise(resolve => pending.push({ url, resolve }))
      : null)
  });
  // Lan tai dau tien chua tra ve; nguoi dung da kip loc theo trang thai "Dang duoc giao".
  assert.equal(pending.length, 1);
  setValue(page.window, page.document.getElementById('bulkStatusFilter'), 'DELIVERING');
  assert.equal(pending.length, 2);
  const answer = ({ url, resolve }) => {
    const body = lifecycleResponse(url, orders, { ok: true });
    resolve({ ok: true, status: 200, json: async () => body });
  };
  answer(pending[1]); // moi nhat ve truoc
  await settle();
  assert.deepEqual(codesOf(page.document), ['H2']);
  answer(pending[0]); // cu ve sau — khong duoc de len
  await settle();
  assert.deepEqual(codesOf(page.document), ['H2']);
  page.dom.window.close();
});

// ---------------------------------------------------------------------------
// Xuat Excel: gui BO LOC dang ap dung; chi Quan ly (quyen shipment.export) thay nut
// ---------------------------------------------------------------------------

test('xuất Excel gửi BỘ LỌC + cách sắp xếp đang áp dụng (không gửi danh sách mã, không gửi trang)', async () => {
  let exportBody = null;
  const page = await renderPage({
    orders: MIXED(),
    fetchImpl: (url, options, window) => {
      if (!url.endsWith('/export')) return null;
      exportBody = JSON.parse(options.body);
      return { ok: true, status: 200, headers: { get: () => 'attachment; filename="x.xlsx"' }, blob: async () => new window.Blob(['x']) };
    }
  });
  const { window, document } = page;
  setValue(window, document.getElementById('bulkKiotStatusFilter'), 'Hoàn thành');
  await settle();
  headerNamed(document, 'orderCode').click(); // A-Z
  headerNamed(document, 'orderCode').click(); // Z-A
  await settle();
  document.getElementById('bulkExportBtn').click();
  await settle();
  assert.deepEqual(exportBody, { kiotStatus: 'Hoàn thành', sort: 'orderCode', dir: 'desc' });
  assert.equal('codes' in exportBody, false);
  assert.equal('page' in exportBody, false);
  page.dom.window.close();
});

test('nút Xuất Excel: Quản lý thấy; vai trò khác (kể cả Trợ lý, Kế toán) KHÔNG thấy; bảng không có dòng thì nút bị khóa', async () => {
  const manager = await renderPage({ orders: [kiotOnlyOrder('A')], vaiTro: 'Quản lý' });
  assert.equal(manager.document.getElementById('bulkExportBtn').hidden, false);
  assert.equal(manager.document.getElementById('bulkExportBtn').disabled, false);
  manager.dom.window.close();

  for (const vaiTro of ['Kế toán', 'Trợ lý', 'Nhân viên sale', 'Trưởng kho']) {
    const other = await renderPage({ orders: [kiotOnlyOrder('A')], vaiTro });
    assert.equal(other.document.getElementById('bulkExportBtn').hidden, true, vaiTro);
    other.dom.window.close();
  }

  const empty = await renderPage({ orders: [], vaiTro: 'Quản lý' });
  assert.equal(empty.document.getElementById('bulkExportBtn').disabled, true);
  empty.dom.window.close();
});

// ---------------------------------------------------------------------------
// Hop chi tiet don: nap dong hang tu Kiot
// ---------------------------------------------------------------------------

function kiotDetail(overrides = {}) {
  return {
    code: 'DH041173', branch: 'HN', date: '01/10/2026 13:14', status: 'Phiếu tạm', total: 855000, phieuTam: true, sellableValue: 550000,
    lines: [
      // SL dat 500, ton 40 -> co ban 40 (cong thuc moi min(SL dat, ton kho)); hang dieu chuyen SG 160 chi de tham khao.
      { productCode: 'A', productName: 'Hàng A', quantity: 500, price: 1000, discount: 0, amount: 500000, isService: false, onHand: 40, inTransit: 160, sellableQty: 40, sellableAmount: 40000, measure: { status: 'ok', m3: 1.5, kg: 20, cartons: 5 } },
      { productCode: 'B', productName: 'Hàng B', note: 'Dán tem 3 màu', quantity: 70, price: 5000, discount: 0, amount: 350000, isService: false, onHand: 800, inTransit: 0, sellableQty: 70, sellableAmount: 350000, measure: { status: 'ok', m3: 0.25, kg: 3, cartons: 1 } },
      { productCode: 'VATDA44', productName: 'VAT', quantity: 1, price: 5000, discount: 0, amount: 5000, isService: true, onHand: null, inTransit: null, sellableQty: null, sellableAmount: null, measure: { status: 'service', m3: null, kg: null, cartons: null } }
    ],
    freight: {
      unavailable: false, totals: { m3: 1.75, kg: 23, cartons: 6 }, missingCodes: [],
      carriers: {
        DM: { carrier: 'DM', label: 'Đức Mạnh', note: 'Ghi chú ĐM', freight: 962500, surcharge: 0, total: 962500, steps: [{ label: 'Theo thể tích', amount: 962500 }] },
        VL: { carrier: 'VL', label: 'Việt Linh', note: 'Ghi chú VL', freight: 813750, surcharge: 200000, total: 1013750, steps: [{ label: 'm³ × 465.000', amount: 813750 }, { label: 'Phụ thu', amount: 200000 }],
          withChanh: { carrier: 'VL', label: 'Việt Linh', note: 'Ghi chú VL', freight: 857500, surcharge: 270000, total: 1127500, steps: [{ label: 'm³ × 490.000', amount: 857500 }, { label: 'Phụ thu', amount: 200000 }, { label: 'Vé chành', amount: 70000 }] } },
        JT: { carrier: 'JT', label: 'J&T', note: 'Ghi chú JT', freight: 1200000, surcharge: 0, total: 1200000, steps: [{ label: 'A: 5 thùng × 240.000', amount: 1200000 }] }
      }
    },
    ...overrides
  };
}

test('bấm dòng: mở hộp chi tiết, gọi order-detail đúng mã/cơ sở và hiện bảng hàng hóa kèm tồn kho + Điều chuyển SG + có bán', async () => {
  const page = await renderPage({
    orders: [kiotOnlyOrder('DH041173', { branch: 'HN' })],
    fetchImpl: url => (url.includes('/order-detail')
      ? { ok: true, status: 200, json: async () => ({ detail: kiotDetail() }) }
      : null)
  });
  const { document } = page;
  rowsOf(document)[0].click();
  assert.equal(document.getElementById('lcDetailOverlay').hidden, false);
  await settle();

  const detailCall = page.calls.find(call => call.url.includes('/order-detail'));
  assert.equal(detailCall.url, '/api/shipment/lifecycle/order-detail?code=DH041173&branch=HN');
  assert.ok(document.querySelector('.lc-detail-dialog').classList.contains('is-wide'));

  const headers = [...document.querySelectorAll('.lc-lines thead th')].map(th => th.querySelector('.sort-label').textContent);
  assert.deepEqual(headers, ['Mã hàng', 'Tên hàng', 'Ghi chú', 'SL đặt', 'Đơn giá', 'Thành tiền', 'Tồn HN', 'Điều chuyển SG', 'Có bán', 'Thành tiền có bán']);
  assert.ok(!headers.includes('Đang vận chuyển'), 'cot da doi ten');
  const rows = [...document.querySelectorAll('.lc-lines tbody tr')].map(tr => [...tr.cells].map(td => td.textContent));
  assert.deepEqual(rows[0], ['A', 'Hàng A', '', '500', '1,000', '500,000', '40', '160', '40', '40,000']);
  assert.deepEqual(rows[1], ['B', 'Hàng B', 'Dán tem 3 màu', '70', '5,000', '350,000', '800', '0', '70', '350,000']);
  assert.deepEqual(rows[2].slice(6), ['—', '—', '—', '—'], 'dong thue VAT khong co ton/co ban');
  assert.ok(document.querySelectorAll('.lc-lines tbody tr')[2].classList.contains('is-service'));
  const text = document.getElementById('lcDetailBody').textContent;
  assert.match(text, /Giá trị đơn \(Kiot\)855,000₫/);
  assert.match(text, /Giá trị có bán550,000₫/);
  assert.match(text, /min\(số lượng đặt, tồn kho\) × đơn giá/, 'cong thuc moi khong con "+ dang van chuyen"');
  assert.doesNotMatch(text, /tồn kho \+ đang vận chuyển/);
  assert.match(text, /không tính dòng VAT/);
  page.dom.window.close();
});

test('đơn không còn Phiếu tạm: bảng hàng hóa không có tồn/có bán và ghi chú giải thích', async () => {
  const detail = kiotDetail({
    status: 'Hoàn thành', phieuTam: false, sellableValue: null,
    lines: [{ productCode: 'A', productName: 'Hàng A', quantity: 5, price: 1000, discount: 0, amount: 5000, isService: false, onHand: null, inTransit: null, sellableQty: null, sellableAmount: null }]
  });
  const page = await renderPage({
    orders: [sheetOrder('DH1')],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: true, status: 200, json: async () => ({ detail }) } : null)
  });
  rowsOf(page.document)[0].click();
  await settle();
  const cells = [...page.document.querySelectorAll('.lc-lines tbody tr')[0].cells].map(td => td.textContent);
  assert.deepEqual(cells.slice(6), ['—', '—', '—', '—']);
  const text = page.document.getElementById('lcDetailBody').textContent;
  assert.match(text, /không còn ở trạng thái Phiếu tạm/);
  assert.doesNotMatch(text, /Giá trị có bán/);
  page.dom.window.close();
});

test('cột "Thời gian đặt hàng" nằm cạnh Mã đơn trên bảng; đơn không có thời gian đặt hiện "—"', async () => {
  const page = await renderPage({ orders: [kiotOnlyOrder('DH1'), sheetOrder('DH2')] });
  const heads = [...page.document.querySelectorAll('#bulkHeadRow th')].map(th => th.textContent.replace(/[▲▼]/g, '').trim());
  assert.deepEqual(heads.slice(0, 3), ['Mã đơn', 'Cơ sở', 'Thời gian đặt hàng']);
  const rows = rowsOf(page.document);
  assert.equal(cellOf(rows[0], 'orderDate').textContent, '01/10/2026 13:14');
  assert.equal(cellOf(rows[1], 'orderDate').textContent, '—');
  page.dom.window.close();
});

test('hộp chi tiết của dòng bảng: "Thời gian đặt hàng" ngay sau Mã đơn, kèm Trạng thái KiotViet và Ghi chú (giữ xuống dòng); tra cứu cho Khách (không có các trường này) thì không hiện', async () => {
  const page = await renderPage({
    orders: [kiotOnlyOrder('DH1', { kiotStatus: 'Hoàn thành', note: 'Dòng 1\nDòng 2' })],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: false, status: 404, json: async () => ({ error: 'x' }) } : null)
  });
  rowsOf(page.document)[0].click();
  const labels = [...page.document.querySelectorAll('#lcDetailBody .lc-detail-label')].map(el => el.textContent);
  assert.deepEqual(labels.slice(0, 5), ['Mã đơn hàng', 'Thời gian đặt hàng', 'Trạng thái KiotViet', 'Nhân viên bán hàng', 'Khách hàng']);
  assert.equal(labels[5], 'Ghi chú');
  const values = [...page.document.querySelectorAll('#lcDetailBody .lc-detail-value')].map(el => el.textContent);
  assert.equal(values[1], '01/10/2026 13:14');
  assert.equal(values[2], 'Hoàn thành');
  assert.equal(values[5], 'Dòng 1\nDòng 2');
  assert.ok(page.document.querySelectorAll('#lcDetailBody .lc-detail-value')[5].classList.contains('is-note'));

  // Khu A (tra cuu cho Khach): chi tiet khong co orderDate/kiotStatus/note -> cac dong do khong hien.
  page.window.eval("openDetailModal({ orderCode: 'DH9', saleName: 'S', customerName: 'K' })");
  const guestLabels = [...page.document.querySelectorAll('#lcDetailBody .lc-detail-label')].map(el => el.textContent);
  assert.ok(!guestLabels.includes('Ghi chú') && !guestLabels.includes('Trạng thái KiotViet') && !guestLabels.includes('Thời gian đặt hàng'));
  page.dom.window.close();
});

test('order-detail trả 404 (dòng chỉ có trong Sheet): chỉ còn các trường sheet, không hiện bảng hàng hóa và không rộng hộp', async () => {
  const page = await renderPage({
    orders: [sheetOrder('HD000013', { branch: 'SG' })],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: false, status: 404, json: async () => ({ error: 'Không tìm thấy', code: 'ORDER_NOT_FOUND' }) } : null)
  });
  rowsOf(page.document)[0].click();
  await settle();
  assert.equal(page.document.querySelector('.lc-lines'), null);
  assert.equal(page.document.querySelector('.lc-detail-dialog').classList.contains('is-wide'), false);
  assert.match(page.document.getElementById('lcDetailBody').textContent, /Mã đơn hàng/);
  assert.doesNotMatch(page.document.getElementById('lcDetailBody').textContent, /Lỗi|Không tìm thấy/);
  page.dom.window.close();
});

test('lỗi khác (500/mạng) khi tải chi tiết hàng hóa: hiện thông báo nhỏ, hộp vẫn dùng được', async () => {
  const page = await renderPage({
    orders: [kiotOnlyOrder('DH1')],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: false, status: 500, json: async () => ({ error: 'Lỗi hệ thống, vui lòng thử lại sau.' }) } : null)
  });
  rowsOf(page.document)[0].click();
  await settle();
  assert.match(page.document.getElementById('lcDetailBody').textContent, /Lỗi hệ thống/);
  assert.equal(page.document.getElementById('lcDetailOverlay').hidden, false);
  page.dom.window.close();
});

test('phản hồi chi tiết đến muộn sau khi đóng hộp / mở đơn khác bị bỏ qua (không chèn nhầm đơn)', async () => {
  const resolvers = [];
  const page = await renderPage({
    orders: [kiotOnlyOrder('DH1', { orderDate: '02/10/2026 10:00' }), kiotOnlyOrder('DH2', { orderDate: '01/10/2026 10:00' })],
    fetchImpl: url => (url.includes('/order-detail')
      ? new Promise(resolve => resolvers.push(body => resolve({ ok: true, status: 200, json: async () => ({ detail: body }) })))
      : null)
  });
  const { document } = page;
  rowsOf(document)[0].click();
  await settle();
  document.getElementById('lcDetailClose').click();
  rowsOf(document)[1].click();
  await settle();
  assert.equal(resolvers.length, 2);

  resolvers[0](kiotDetail({ code: 'DH1', lines: [{ productCode: 'CU', productName: 'Don cu', quantity: 1, price: 1, discount: 0, amount: 1, isService: false, onHand: 1, inTransit: 0, sellableQty: 1, sellableAmount: 1 }] }));
  await settle();
  assert.equal(page.document.querySelector('.lc-lines'), null, 'phan hoi cua don DH1 (da dong) khong duoc hien');

  resolvers[1](kiotDetail({ code: 'DH2' }));
  await settle();
  assert.ok(page.document.querySelector('.lc-lines'));
  assert.equal([...document.querySelectorAll('.lc-lines tbody tr')][0].cells[0].textContent, 'A');
  page.dom.window.close();
});

test('tra cứu 1 đơn (Khu A) và hộp từ tab Lịch sử KHÔNG gọi API Kiot — chỉ bấm dòng của bảng toàn bộ đơn mới gọi', async () => {
  const page = await renderPage({ orders: [sheetOrder('DH1')] });
  page.window.eval("openDetailModal({ orderCode: 'DH1', branch: 'HN' })"); // khong co opts.withKiot
  await settle();
  assert.equal(page.calls.some(call => call.url.includes('/order-detail')), false);
  page.dom.window.close();
});

test('ô lọc Trạng thái KiotViet có đủ 5 trạng thái ngay cả khi Kiot lỗi / chưa có đơn; trạng thái lạ từ máy chủ được nối thêm', async () => {
  const failed = await renderPage({ orders: [sheetOrder('A')], kiot: { ok: false, stale: false, fetchedAt: null, count: 0 } });
  assert.deepEqual([...failed.document.getElementById('bulkKiotStatusFilter').options].map(o => o.value), ['', 'Phiếu tạm', 'Đã xác nhận', 'Đang giao hàng', 'Hoàn thành', 'Đã hủy']);
  failed.dom.window.close();
  const extra = await renderPage({ orders: [kiotOnlyOrder('B', { kiotStatus: 'Trạng thái mới' })] });
  assert.deepEqual([...extra.document.getElementById('bulkKiotStatusFilter').options].map(o => o.value).slice(-2), ['Đã hủy', 'Trạng thái mới']);
  extra.dom.window.close();
});

test('cột "Cơ sở": hiện Hà Nội / Sài Gòn theo từng dòng (cùng mã ở 2 cơ sở), sắp xếp được theo cột này', async () => {
  const page = await renderPage({ orders: [
    kiotOnlyOrder('DH1', { branch: 'SG', orderDate: '03/10/2026 10:00' }),
    kiotOnlyOrder('DH1', { branch: 'HN', orderDate: '02/10/2026 10:00' })
  ] });
  assert.deepEqual(rowsOf(page.document).map(row => cellOf(row, 'branch').textContent), ['Sài Gòn', 'Hà Nội']);
  headerNamed(page.document, 'branch').click();
  await settle();
  assert.equal(lastListParams(page).get('sort'), 'branch');
  assert.deepEqual(rowsOf(page.document).map(row => cellOf(row, 'branch').textContent), ['Hà Nội', 'Sài Gòn']);
  page.dom.window.close();
});

// ---------------------------------------------------------------------------
// Bo loc dang dropdown tuy bien (2026-10-03): <select> goc an, nut + danh sach thay the; Co so la dropdown (khong con 3 nut)
// ---------------------------------------------------------------------------

const DROPDOWN_IDS = ['bulkStatusFilter', 'bulkKiotStatusFilter', 'bulkBranchFilter', 'bulkDateField', 'historyStatusFilter', 'historyBranchFilter'];

const ddOf = (document, id) => document.getElementById(id).closest('.dd');
const ddListOf = (document, dd) => document.getElementById(dd.querySelector('.dd-button').getAttribute('aria-controls'));
const clickEl = (window, el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const ddOptionTexts = dd => [...dd.querySelectorAll('.dd-option')].map(li => li.textContent);

test('mọi bộ lọc là dropdown tùy biến: select gốc ẩn, nút hiện đúng lựa chọn; Cơ sở là dropdown, không còn 3 nút', async () => {
  const page = await renderPage({ orders: MIXED() });
  const { document } = page;
  for (const id of DROPDOWN_IDS) {
    const select = document.getElementById(id);
    const dd = ddOf(document, id);
    assert.ok(dd, id + ' phai nam trong .dd');
    assert.equal(select.hidden, true, id);
    const button = dd.querySelector('.dd-button');
    assert.equal(button.textContent, select.options[select.selectedIndex].textContent, id);
    assert.equal(button.getAttribute('aria-expanded'), 'false', id);
    assert.equal(dd.querySelector('.dd-list').hidden, true, id);
  }
  assert.equal(document.querySelectorAll('[data-branch]').length, 0, 'khong con nut Ha Noi / Sai Gon');
  assert.deepEqual(ddOptionTexts(ddOf(document, 'bulkBranchFilter')), ['Tất cả cơ sở', 'Hà Nội', 'Sài Gòn']);
  page.dom.window.close();
});

test('bộ lọc trạng thái của Toàn bộ đơn hàng có đủ mã như tab Lịch sử, kể cả Sự cố và Đã hủy', async () => {
  const page = await renderPage({ orders: MIXED() });
  const { window, document } = page;
  const codes = id => [...document.getElementById(id).options].map(o => o.value);
  // Bộ lọc tổng quan ẩn DELIVERED (không còn tự suy ra); lịch sử vẫn giữ vì nhật ký ghi đè có thể chứa nó.
  assert.deepEqual(codes('bulkStatusFilter'), codes('historyStatusFilter').filter(c => c !== 'DELIVERED'));
  assert.ok(ddOptionTexts(ddOf(document, 'bulkStatusFilter')).includes('Sự cố'));
  assert.ok(ddOptionTexts(ddOf(document, 'bulkStatusFilter')).includes('Đã hủy'));

  setValue(window, document.getElementById('bulkStatusFilter'), 'CANCELLED');
  await settle();
  assert.equal(lastListParams(page).get('status'), 'CANCELLED');
  page.dom.window.close();
});

test('chọn Cơ sở bằng dropdown: gửi branch lên máy chủ, nút đổi chữ, danh sách đóng; chọn lại Tất cả cơ sở thì bỏ tham số', async () => {
  const page = await renderPage({ orders: MIXED() });
  const { window, document } = page;
  const dd = ddOf(document, 'bulkBranchFilter');
  const button = dd.querySelector('.dd-button');

  clickEl(window, button);
  assert.equal(ddListOf(document, dd).hidden, false);
  assert.equal(ddListOf(document, dd).parentNode, document.body, 'mo thi danh sach ra <body> (khong bi khung cha cat)');
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  clickEl(window, [...ddListOf(document, dd).querySelectorAll('.dd-option')][2]);
  await settle();
  assert.equal(lastListParams(page).get('branch'), 'SG');
  assert.equal(document.getElementById('bulkBranchFilter').value, 'SG');
  assert.equal(button.textContent, 'Sài Gòn');
  assert.equal(ddListOf(document, dd).hidden, true, 'chon xong thi dong');
  assert.equal(ddListOf(document, dd).parentNode, dd, 'dong thi danh sach ve lai trong .dd');
  assert.equal(dd.querySelector('.dd-option[aria-selected="true"]').textContent, 'Sài Gòn');

  clickEl(window, button);
  clickEl(window, [...ddListOf(document, dd).querySelectorAll('.dd-option')][0]);
  await settle();
  assert.equal(lastListParams(page).has('branch'), false);
  assert.equal(button.textContent, 'Tất cả cơ sở');
  page.dom.window.close();
});

test('dropdown: bàn phím (↓ mở, ↓ ↓ chọn bằng Enter, Esc đóng) và bấm ra ngoài thì đóng', async () => {
  const page = await renderPage({ orders: MIXED() });
  const { window, document } = page;
  const dd = ddOf(document, 'bulkKiotStatusFilter');
  const button = dd.querySelector('.dd-button');
  const press = key => button.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

  press('ArrowDown');
  assert.equal(ddListOf(document, dd).hidden, false, 'mui xuong mo danh sach');
  press('ArrowDown');
  press('ArrowDown');
  press('Enter');
  await settle();
  assert.equal(lastListParams(page).get('kiotStatus'), 'Đã xác nhận', 'Tat ca -> Phieu tam -> Da xac nhan');
  assert.equal(button.textContent, 'Đã xác nhận');

  press('ArrowDown');
  press('Escape');
  assert.equal(ddListOf(document, dd).hidden, true);

  press('ArrowDown');
  document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(ddListOf(document, dd).hidden, true, 'bam ra ngoai thi dong');
  page.dom.window.close();
});

test('dropdown Trạng thái KiotViet theo dõi option do trang thêm vào và giá trị gán bằng code', async () => {
  const page = await renderPage({ orders: MIXED() });
  const { document, window } = page;
  const select = document.getElementById('bulkKiotStatusFilter');
  const dd = ddOf(document, 'bulkKiotStatusFilter');
  assert.deepEqual(ddOptionTexts(dd), ['Tất cả', 'Phiếu tạm', 'Đã xác nhận', 'Đang giao hàng', 'Hoàn thành', 'Đã hủy']);

  const extra = document.createElement('option');
  extra.value = extra.textContent = 'Trạng thái mới';
  select.appendChild(extra);
  await settle();
  assert.deepEqual(ddOptionTexts(dd).slice(-1), ['Trạng thái mới'], 'MutationObserver dong bo danh sach');

  select.value = 'Hoàn thành'; // gan bang code (khong ban su kien change)
  assert.equal(dd.querySelector('.dd-button').textContent, 'Hoàn thành');
  assert.equal(window.getComputedStyle(select).display, 'none');
  page.dom.window.close();
});

// ---------------------------------------------------------------------------
// Hop chi tiet don: khung .dp-* — hang chi so tong quan, tien trinh theo moc, khong co nut "Cot hien thi"
// ---------------------------------------------------------------------------

const detailStats = document => Object.fromEntries([...document.querySelectorAll('#lcDetailBody .dp-stat')].map(el => [
  el.querySelector('.dp-stat-label').textContent,
  {
    value: el.querySelector('.dp-stat-value').textContent,
    sub: (el.querySelector('.dp-stat-sub') || { textContent: '' }).textContent,
    tone: [...el.classList].find(name => name.startsWith('is-')) || ''
  }
]));

test('hộp chi tiết: hàng chỉ số tổng quan (trạng thái, tiến trình, giá trị đơn/có bán, mặt hàng, dòng thiếu hàng) + tiến trình xử lý theo mốc + cảnh báo', async () => {
  const page = await renderPage({
    orders: [kiotOnlyOrder('DH041173', {
      summary: { code: 'SENT_TO_ACCOUNTANT', label: 'Đơn đã gửi kế toán', at: '01/10/2026 15:00' },
      saleSentAt: '01/10/2026 14:00', accountantApprovedOrderAt: '01/10/2026 15:00', driverName: 'Lái A',
      warning: true, warnings: ['ACCOUNTANT_LATE']
    })],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: true, status: 200, json: async () => ({ detail: kiotDetail() }) } : null)
  });
  const { document } = page;
  rowsOf(document)[0].click();

  // Truoc khi Kiot tra loi: chi so lay tu dong bang, chua co mat hang / dong thieu hang.
  let stats = detailStats(document);
  assert.equal(stats['Trạng thái đơn'].value, 'Đơn đã gửi kế toán');
  assert.equal(stats['Trạng thái đơn'].sub, 'Cập nhật 01/10/2026 15:00');
  assert.equal(stats['Tiến trình'].value, '2/5 mốc');
  assert.equal(stats['Tiến trình'].sub, 'Kế toán duyệt đơn');
  assert.equal(stats['Giá trị đơn (Kiot)'].value, '2,000,000₫');
  assert.equal(stats['Mặt hàng'], undefined);

  await settle();
  stats = detailStats(document);
  assert.equal(stats['Giá trị đơn (Kiot)'].value, '855,000₫', 'ket qua order-detail ghi de gia tri dong bang');
  assert.equal(stats['Giá trị có bán'].value, '550,000₫');
  assert.equal(stats['Giá trị có bán'].sub, '64% giá trị đơn');
  assert.equal(stats['Giá trị có bán'].tone, 'is-amber');
  assert.equal(stats['Mặt hàng'].value, '2', 'dong VAT (dich vu) khong tinh la mat hang');
  assert.equal(stats['Mặt hàng'].sub, '570 sản phẩm');
  assert.equal(stats['Dòng thiếu hàng'].value, '1/2');
  assert.equal(stats['Dòng thiếu hàng'].tone, 'is-red');

  const steps = [...document.querySelectorAll('#lcDetailBody .lc-step')];
  assert.equal(steps.length, 6, 'don khong co flow -> luong DonHang_HN/SG, khong con node Ship nhan don');
  assert.deepEqual(steps.filter(step => step.classList.contains('is-done')).map(step => step.querySelector('.lc-step-label').textContent),
    ['Sale gửi đơn cho kế toán', 'Kế toán duyệt đơn', 'Lái xe']);
  assert.equal(steps[0].querySelector('.lc-step-value').textContent, '01/10/2026 14:00');
  assert.equal(steps[3].querySelector('.lc-step-value').textContent, 'Chưa có');

  assert.match(document.querySelector('#lcDetailBody .lc-detail-alert').textContent, /Kế toán sót đơn/);
  assert.equal(document.getElementById('lcDetailTitle').textContent, 'DH041173');
  assert.equal(document.getElementById('lcDetailSubtitle').textContent, 'Cơ sở Hà Nội · 01/10/2026 13:14');
  page.dom.window.close();
});

test('hộp chi tiết: đơn đủ hàng → "Dòng thiếu hàng" 0/N màu xanh; không còn Phiếu tạm → không có thẻ Giá trị có bán / Dòng thiếu hàng', async () => {
  const enough = await renderPage({
    orders: [kiotOnlyOrder('DH1')],
    fetchImpl: url => (url.includes('/order-detail')
      ? { ok: true, status: 200, json: async () => ({ detail: kiotDetail({ lines: [kiotDetail().lines[1]], total: 350000, sellableValue: 350000 }) }) }
      : null)
  });
  rowsOf(enough.document)[0].click();
  await settle();
  const ok = detailStats(enough.document);
  assert.equal(ok['Dòng thiếu hàng'].value, '0/1');
  assert.equal(ok['Dòng thiếu hàng'].tone, 'is-green');
  assert.equal(ok['Giá trị có bán'].tone, 'is-green', 'co ban du 100% gia tri don');
  enough.dom.window.close();

  const done = await renderPage({
    orders: [sheetOrder('DH2')],
    fetchImpl: url => (url.includes('/order-detail')
      ? { ok: true, status: 200, json: async () => ({ detail: kiotDetail({ status: 'Hoàn thành', phieuTam: false, sellableValue: null }) }) }
      : null)
  });
  rowsOf(done.document)[0].click();
  await settle();
  const stats = detailStats(done.document);
  assert.equal(stats['Giá trị đơn (Kiot)'].value, '855,000₫');
  assert.equal(stats['Giá trị có bán'], undefined);
  assert.equal(stats['Dòng thiếu hàng'], undefined);
  assert.equal(stats['Mặt hàng'].value, '2');
  done.dom.window.close();
});

test('tra cứu cho Khách / tab Lịch sử: hộp lấy trạng thái + cơ sở từ kết quả tra cứu; chỉ có thẻ Trạng thái và Tiến trình, không có thẻ giá trị', async () => {
  const page = await renderPage({ orders: [sheetOrder('DH1')] });
  page.window.eval("openDetailModal({ orderCode: 'DH9', saleName: 'S', customerName: 'K', saleSentAt: '01/10/2026 08:00' }, { summary: { code: 'SENT_TO_ACCOUNTANT', label: 'Đơn đã gửi kế toán', at: '01/10/2026 08:05' }, branch: 'SG' })");
  const stats = detailStats(page.document);
  assert.deepEqual(Object.keys(stats), ['Trạng thái đơn', 'Tiến trình']);
  assert.equal(stats['Tiến trình'].value, '1/5 mốc');
  assert.equal(page.document.getElementById('lcDetailSubtitle').textContent, 'Cơ sở Sài Gòn');
  assert.equal(page.document.querySelector('#lcDetailBody .lc-detail-alert'), null, 'khong co canh bao thi khong hien khung canh bao');
  page.dom.window.close();
});

const stepLabels = document => [...document.querySelectorAll('#lcDetailBody .lc-step .lc-step-label')].map(el => el.textContent);

test('hộp chi tiết theo luồng: DELIVERY 6 node, NORTH_SOUTH 3 node, PICKUP 4 node (Kho + Ship/Khách nhận đơn)', async () => {
  const page = await renderPage({ orders: [sheetOrder('DH1')] });
  const open = (flow, extra) => page.window.eval(`openDetailModal(${JSON.stringify(Object.assign({ orderCode: 'DH9', flow }, extra))})`);

  open('DELIVERY');
  assert.deepEqual(stepLabels(page.document), ['Sale gửi đơn cho kế toán', 'Kế toán duyệt đơn', 'Lái xe',
    'Tài xế gửi xác nhận giao hàng', 'Kế toán duyệt giao hàng', 'Đơn đã ký nhận']);

  open('NORTH_SOUTH', { saleSentAt: '01/10/2026 08:00', orderSignedAt: '02/10/2026 08:00' });
  assert.deepEqual(stepLabels(page.document), ['Sale gửi đơn cho kế toán', 'Kế toán duyệt đơn', 'Đơn đã ký nhận']);
  assert.equal(detailStats(page.document)['Tiến trình'].value, '2/3 mốc');

  open('PICKUP', { saleSentAt: '01/10/2026 08:00', driverName: 'Tuấn Anh', shipReceivedAt: '02/10/2026 08:00' });
  assert.deepEqual(stepLabels(page.document), ['Sale gửi đơn cho kế toán', 'Kế toán duyệt đơn', 'Kho', 'Ship/Khách nhận đơn']);
  const values = [...page.document.querySelectorAll('#lcDetailBody .lc-step .lc-step-value')].map(el => el.textContent);
  assert.deepEqual(values, ['01/10/2026 08:00', 'Chưa có', 'Tuấn Anh', '02/10/2026 08:00']);
  assert.equal(detailStats(page.document)['Tiến trình'].value, '2/3 mốc', 'Kho la ten nguoi nen khong tinh la moc');

  open('ACCOUNTING', { accountingSender: 'Kế toán Lan', saleSentAt: '14/10/2026 10:30' });
  assert.deepEqual(stepLabels(page.document), ['Người gửi (kế toán)', 'Thời gian gửi']);
  const accountingValues = [...page.document.querySelectorAll('#lcDetailBody .lc-step .lc-step-value')].map(el => el.textContent);
  assert.deepEqual(accountingValues, ['Kế toán Lan', '14/10/2026 10:30']);
  assert.equal(detailStats(page.document)['Tiến trình'].value, '1/1 mốc', 'luong ke toan: chi Thoi gian gui la moc');

  open(undefined);
  assert.equal(stepLabels(page.document).length, 6, 'thieu flow -> tam hien nhu DonHang_HN/SG');
  page.dom.window.close();
});

test('hộp chi tiết lấy luồng từ kết quả tra cứu (opts.flow) khi detail không kèm flow', async () => {
  const page = await renderPage({ orders: [sheetOrder('DH1')] });
  page.window.eval("openDetailModal({ orderCode: 'DH9' }, { branch: 'HN', flow: 'NORTH_SOUTH' })");
  assert.equal(stepLabels(page.document).length, 3);
  page.dom.window.close();
});

test('hộp chi tiết CÓ sort, thanh kéo độ rộng cột và nút "Cột hiển thị" ở đầu khối Hàng hóa (bảng tính cước giữ nguyên)', async () => {
  const page = await renderPage({
    orders: [kiotOnlyOrder('DH041173')],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: true, status: 200, json: async () => ({ detail: kiotDetail() }) } : null)
  });
  const { document, window } = page;
  assert.ok(document.querySelectorAll('.tks-columns-button').length > 0, 'bang chinh co nut Cot hien thi');
  rowsOf(document)[0].click();
  await settle();
  window.TKSTables.refreshAll();
  const overlay = document.getElementById('lcDetailOverlay');
  const linesTable = overlay.querySelector('.lc-lines');
  assert.equal(linesTable.getAttribute('data-table-controls'), null);

  // nut nam ngay tren dau khoi "Hang hoa trong don", khong them 1 hang cong cu rieng
  const buttons = overlay.querySelectorAll('.tks-columns-button');
  assert.equal(buttons.length, 2);
  assert.ok(buttons[0].parentElement.classList.contains('dp-section-head'));
  assert.equal(overlay.querySelectorAll('.tks-table-tools').length, 0);
  assert.equal(linesTable.querySelectorAll(".tks-column-resizer").length, 10);

  // sort: bam "Thanh tien" -> tang dan (VAT 5.000 < B 350.000 < A 500.000), bam lai -> giam dan, bam lan 3 -> thu tu goc
  const codes = () => [...linesTable.tBodies[0].rows].map(row => row.cells[0].textContent);
  const amount = [...linesTable.tHead.rows[0].cells].find(th => th.querySelector('.sort-label').textContent === 'Thành tiền');
  assert.deepEqual(codes(), ['A', 'B', 'VATDA44']);
  amount.querySelector('.sort-button').click();
  assert.deepEqual(codes(), ['VATDA44', 'B', 'A']);
  assert.equal(amount.querySelector('.sort-indicator').textContent, '▼');
  assert.equal(amount.getAttribute('aria-sort'), 'ascending');
  amount.querySelector('.sort-button').click();
  assert.deepEqual(codes(), ['A', 'B', 'VATDA44']);
  assert.equal(amount.querySelector('.sort-indicator').textContent, '▲');
  amount.querySelector('.sort-button').click();
  assert.deepEqual(codes(), ['A', 'B', 'VATDA44']);
  assert.equal(amount.querySelector('.sort-indicator').textContent, '▲▼');
  // o khong co gia tri luon xuong cuoi ca 2 chieu: "Ton kho" cua dong VAT la —
  const stock = [...linesTable.tHead.rows[0].cells].find(th => th.querySelector('.sort-label').textContent === 'Tồn HN');
  stock.querySelector('.sort-button').click();
  assert.deepEqual(codes(), ['A', 'B', 'VATDA44']);
  stock.querySelector('.sort-button').click();
  assert.deepEqual(codes(), ['B', 'A', 'VATDA44']);

  // bang tinh cuoc la cac buoc noi tiep co dong tong: khong sort / khong chon cot
  const freight = overlay.querySelector('.lc-freight-steps table');
  assert.equal(freight.getAttribute('data-table-controls'), 'off');
  assert.equal(freight.querySelector('.tks-column-resizer, .sort-button'), null);
  page.dom.window.close();
});

test('khối Thể tích & cước: mặc định Đức Mạnh, đổi dropdown sang Việt Linh đổi ghi chú, bảng tính và tổng cước', async () => {
  const page = await renderPage({
    orders: [kiotOnlyOrder('DH041173', { branch: 'HN' })],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: true, status: 200, json: async () => ({ detail: kiotDetail() }) } : null)
  });
  const { document } = page;
  rowsOf(document)[0].click();
  await settle();
  let select = document.getElementById('lcCarrierSelect');
  assert.equal(select.value, 'DM');
  let text = document.getElementById('lcFreightBody').textContent;
  assert.match(text, /Tổng thể tích1.750 m³/);
  assert.doesNotMatch(text, /Số thùng/);
  const totals = document.getElementById('lcCarrierTotals').textContent;
  assert.match(totals, /Đức Mạnh962,500 đViệt Linh1,013,750 đJ&T1,200,000 đ/);
  assert.equal(document.querySelector('.lc-measures tbody tr').cells[2].textContent, '20 kg');
  assert.match(text, /Ghi chú ĐM/);
  assert.match(text, /962.500/);
  select.value = 'VL';
  select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  text = document.getElementById('lcFreightBody').textContent;
  assert.match(text, /Ghi chú VL/);
  assert.match(text, /Phụ thu/);
  assert.match(text, /1,013,750/);
  assert.equal(document.getElementById('lcDeliverChanh').checked, false);
  assert.doesNotMatch(text, /Giao ra chànhd/);
  const tick = document.getElementById('lcDeliverChanh');
  tick.checked = true;
  tick.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  text = document.getElementById('lcFreightBody').textContent;
  assert.match(text, /m³ × 490.000857.500/);
  assert.match(text, /Vé chành70.000/);
  assert.match(text, /1,127,500/);
  assert.match(document.getElementById('lcCarrierTotals').textContent, /Việt Linh1,127,500 đ/);
  assert.equal(document.getElementById('lcDeliverChanh').checked, true);
  select = document.getElementById('lcCarrierSelect');
  select.value = 'JT';
  select.dispatchEvent(new page.dom.window.Event('change', { bubbles: true }));
  text = document.getElementById('lcFreightBody').textContent;
  assert.match(text, /Ghi chú JT/);
  assert.match(text, /A: 5 thùng × 240.000/);
  assert.match(text, /1,200,000/);
  assert.equal(document.getElementById('lcDeliverChanh'), null);
  assert.equal(page.calls.filter(call => call.url.includes('/order-detail')).length, 1);
  page.dom.window.close();
});

test('khối Thể tích & cước: thiếu mã -> cảnh báo, không có tổng cước; sheet lỗi -> thông báo nhỏ', async () => {
  const missing = kiotDetail({ freight: { unavailable: false, totals: { m3: 1, kg: 2, cartons: 1 }, missingCodes: ['ZZZ'], carriers: null } });
  let page = await renderPage({
    orders: [kiotOnlyOrder('DH1')],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: true, status: 200, json: async () => ({ detail: missing }) } : null)
  });
  rowsOf(page.document)[0].click();
  await settle();
  let text = page.document.getElementById('lcFreightBody').textContent;
  assert.match(text, /thiếu dữ liệu trong sheet CÂN ĐO cho mã ZZZ/);
  assert.equal(page.document.querySelectorAll('#lcCarrierTotals .dp-stat').length, 3);
  assert.match(page.document.getElementById('lcCarrierTotals').textContent, /Chưa tính được/);
  // Ba ô cước nằm trên đầu khối "Thể tích & cước vận chuyển".
  const freightText = page.document.getElementById('lcFreight').textContent;
  assert.ok(freightText.indexOf('Chưa tính được') < freightText.indexOf('Thể tích & cước vận chuyển'));
  page.dom.window.close();

  const broken = kiotDetail({ freight: { unavailable: true, message: 'Không đọc được sheet CÂN ĐO.' } });
  page = await renderPage({
    orders: [kiotOnlyOrder('DH1')],
    fetchImpl: url => (url.includes('/order-detail') ? { ok: true, status: 200, json: async () => ({ detail: broken }) } : null)
  });
  rowsOf(page.document)[0].click();
  await settle();
  text = page.document.getElementById('lcFreight').textContent;
  assert.match(text, /Không đọc được sheet CÂN ĐO/);
  assert.equal(page.document.getElementById('lcCarrierSelect'), null);
  page.dom.window.close();
});

test('cân đo từng hàng giữ phần đã có, cảnh báo đúng ô và hiển thị ba cước tạm tính', async () => {
  const detail = kiotDetail();
  detail.lines[0].measure = { status: 'missing', kg: 20, m3: null, missingVolume: true, missingWeight: false };
  detail.freight.provisional = true;
  detail.freight.missingCodes = ['A'];
  const page = await renderPage({ orders: [kiotOnlyOrder('DH1', { branch: 'SG' })],
    fetchImpl: url => url.includes('/order-detail') ? { ok:true, status:200, json:async () => ({ detail }) } : null });
  rowsOf(page.document)[0].click();
  await settle();
  const row = page.document.querySelector('.lc-measures tbody tr');
  assert.equal(row.cells[2].textContent, '20 kg');
  assert.equal(row.cells[3].textContent, 'Chưa cân đo');
  assert.equal(page.document.querySelectorAll('#lcCarrierTotals .dp-stat-sub').length, 3);
  assert.match(page.document.querySelector('.lc-lines thead').textContent, /Tồn SG/);
  page.dom.window.close();
});

test('CONT cấp 2 dùng cache, hỗ trợ bàn phím và đóng độc lập với đơn hàng', async () => {
  const page = await renderPage({ orders:[kiotOnlyOrder('DH1')], fetchImpl: url => {
    if(url.includes('/order-detail')) return { ok:true, status:200, json:async () => ({ detail:kiotDetail() }) };
    if(url.includes('/containers?')) return { ok:true, status:200, json:async () => ({ rows:[
      { containerName:'CONT A', status:5, statusLabel:'Đã về', eta:'16/10/2026', quantity:123 }
    ], containerSync:{ stale:true } }) };
  } });
  const { document, window } = page;
  rowsOf(document)[0].click();
  await settle();
  const row = document.querySelector('.lc-lines [data-line-index]');
  row.focus();
  row.dispatchEvent(new window.KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
  await settle();
  const overlay = document.getElementById('lcContainerOverlay');
  assert.equal(overlay.hidden, false);
  assert.match(overlay.textContent, /CONT AĐã về16\/10\/2026123/);
  assert.match(overlay.textContent, /lần đồng bộ thành công gần nhất/);
  assert.equal(document.querySelector('.lc-detail-dialog').inert, true);
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key:'Escape', bubbles:true }));
  assert.equal(overlay.hidden, true);
  assert.equal(document.getElementById('lcDetailOverlay').hidden, false);
  assert.equal(document.activeElement, row);
  row.click();
  await settle();
  document.getElementById('lcContainerClose').click();
  assert.equal(document.getElementById('lcDetailOverlay').hidden, false);
  row.click();
  await settle();
  overlay.click();
  assert.equal(overlay.hidden, true);
  assert.equal(page.calls.filter(call => call.url.includes('/containers?')).length, 1);
  document.getElementById('lcDetailClose').click();
  rowsOf(document)[0].click();
  await settle();
  assert.equal(page.calls.filter(call => call.url.includes('/order-detail')).length, 1);
  page.dom.window.close();
});

test('đổi mã hàng bỏ qua phản hồi CONT cũ; lỗi tải và rỗng giữ nguyên cửa sổ đơn', async () => {
  let resolveA;
  let mode = 'pending';
  const page = await renderPage({ orders:[kiotOnlyOrder('DH1')], fetchImpl: url => {
    if(url.includes('/order-detail')) return { ok:true, status:200, json:async () => ({ detail:kiotDetail() }) };
    if(url.endsWith('code=A')) return { ok:true, status:200, json:() => new Promise(resolve => { resolveA = resolve; }) };
    if(url.includes('/containers?')) return mode === 'empty'
      ? { ok:true, status:200, json:async () => ({ rows:[] }) }
      : { ok:false, status:503, json:async () => ({ error:'Không tải được CONT.' }) };
  } });
  const { document } = page;
  rowsOf(document)[0].click();
  await settle();
  const rows = document.querySelectorAll('.lc-lines [data-line-index]');
  rows[0].click();
  await settle();
  document.getElementById('lcContainerClose').click();
  rows[1].click();
  await settle();
  assert.match(document.getElementById('lcContainerBody').textContent, /Không tải được CONT/);
  resolveA({ rows:[{ containerName:'OLD', quantity:999 }] });
  await settle();
  assert.doesNotMatch(document.getElementById('lcContainerBody').textContent, /OLD/);
  document.getElementById('lcContainerClose').click();
  mode = 'empty';
  rows[1].click();
  await settle();
  assert.match(document.getElementById('lcContainerBody').textContent, /Chưa có CONT/);
  assert.equal(document.getElementById('lcDetailOverlay').hidden, false);
  page.dom.window.close();
});
