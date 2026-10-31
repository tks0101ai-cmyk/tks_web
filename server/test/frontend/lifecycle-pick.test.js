'use strict';

// Chi dinh vi tri tren trang Vong doi don hang THAT (public/shipment/lifecycle/pick/*): popup chon vi tri, validate, giu cho,
// phieu in, nut theo trang thai (Dang nhat / Xac nhan nhat / Huy nhat), cot ST, loc + nhan tren danh sach, an theo quyen.
// Chay trang that trong JSDOM voi fetch gia (hop dong API /api/shipment/pick/*).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { lifecycleResponse, isListUrl } = require('./lifecycleFakeServer');

const publicDir = path.join(__dirname, '..', '..', 'public');
const pickDir = path.join(publicDir, 'shipment', 'lifecycle', 'pick');
const html = fs.readFileSync(path.join(publicDir, 'shipment', 'lifecycle', 'index.html'), 'utf8');
const read = file => fs.readFileSync(file, 'utf8');

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)); };
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

function orderRow(code, extra = {}) {
  return {
    orderCode: code, branch: 'HN', saleName: 'Sale A', customerName: 'KH A', saleSentAt: '01/10/2026 08:00', warning: false,
    summary: { code: 'SENT_TO_ACCOUNTANT', label: 'Đã gửi kế toán', at: '01/10/2026 09:00' },
    source: 'kiotviet', kiotStatus: 'Phiếu tạm', sellableValue: 100000, orderTotal: 100000, orderDate: '01/10/2026 13:14', note: '', pickStatus: null,
    ...extra
  };
}

function kiotDetail(code) {
  return {
    code, branch: 'HN', date: '01/10/2026 13:14', status: 'Phiếu tạm', total: 100000, phieuTam: true, sellableValue: 100000,
    lines: [
      { productCode: 'A', productName: 'Hàng A', quantity: 100, price: 1000, discount: 0, amount: 100000, isService: false, onHand: 200, inTransit: 0, sellableQty: 100, sellableAmount: 100000, measure: { status: 'ok', m3: 1, kg: 10, cartons: 2 } },
      { productCode: 'VATDA44', productName: 'VAT', quantity: 1, price: 5000, discount: 0, amount: 5000, isService: true, onHand: null, inTransit: null, sellableQty: null, sellableAmount: null, measure: { status: 'service', m3: null, kg: null, cartons: null } }
    ],
    freight: { unavailable: true, message: 'Không tính được' }
  };
}

const position = (id, location, notes, available, extra = {}) => ({ positionId: id, code: 'A', name: 'Hàng A', location, notes, version: 1, onHand: available, held: 0, available, warnings: [], ...extra });

function makeAssignment(status, extra = {}) {
  return {
    id: 7, branch: 'HN', orderCode: 'DH1', status, version: 1, assignedByName: 'Quản lý A', assignedAt: '2026-10-27T03:00:00.000Z',
    snapshot: {
      customerName: 'KH A', saleName: 'Sale A', saleTelegramId: '123456', orderDate: '01/10/2026 13:14',
      lines: [{ productCode: 'A', productName: 'Hàng A', quantity: 100, price: 1000, discount: 0 }], invoiceDiscount: 0, priorDebt: 0
    },
    lines: [{ id: 1, productCode: 'A', positionId: 11, location: 'A07', plannedQty: 100, reservedQty: status === 'picking' ? 100 : 0, stCartons: 2, stText: '2Tx50', pickedQty: status === 'confirmed' ? 100 : null, specBefore: '4T x 50', specAfter: status === 'confirmed' ? '2T x 50' : null }],
    history: [], ...extra
  };
}

// Kho gia cua cac API Chi dinh vi tri; test doi `store.*` de dieu khien phan hoi.
function newStore(extra = {}) {
  return {
    order: { branch: 'HN', orderCode: 'DH1', customerName: 'KH A', saleName: 'Sale A', saleTelegramId: '123456', orderDate: '01/10/2026 13:14', status: { code: 'SENT_TO_ACCOUNTANT', label: 'Đã gửi kế toán' }, eligible: true, lines: [{ productCode: 'A', productName: 'Hàng A', quantity: 100, price: 1000, discount: 0 }] },
    candidates: { a: [position(11, 'A07', '4T x 50', 200), position(12, 'B02', '2T x 25', 50)] },
    assignment: null, posted: [], statusCalls: [], candidateCalls: 0, postError: null, statusError: null,
    ...extra
  };
}

async function renderPage({ orders = [orderRow('DH1')], store = newStore(), permissions = ['shipment.lifecycle', 'shipment.pick'], fetchImpl } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/shipment/lifecycle/' });
  const { window } = dom;
  const calls = [];
  const source = { orders };
  window.setInterval = () => 1;
  window.eval(read(path.join(publicDir, 'shared/shared-nav.js')));
  const readCachedJSON = window.TKSNav.readCachedJSON;
  window.TKSNav = {
    readCachedJSON, authGuard: () => Promise.resolve({ vaiTro: 'Quản lý' }),
    can: (...keys) => keys.some(key => (Array.isArray(key) ? key : [key]).some(k => permissions.includes(k))), handleBranchError: () => false
  };
  window.fetch = async (url, options = {}) => {
    const href = String(url);
    calls.push({ url: href, options });
    if (fetchImpl) { const custom = await fetchImpl(href, options, window); if (custom) return custom; }
    const u = new URL(href, 'https://tokosi.example');
    if (isListUrl(href)) return json(lifecycleResponse(href, source.orders, { ok: true, stale: false, fetchedAt: null, count: 0 }));
    if (u.pathname === '/api/shipment/lifecycle/order-detail') return json({ detail: kiotDetail(u.searchParams.get('code')) });
    if (u.pathname === '/api/shipment/pick/candidates') { store.candidateCalls++; return json({ order: store.order, candidates: store.candidates, assignment: store.assignment }); }
    if (u.pathname === '/api/shipment/pick' && (options.method || 'GET') === 'GET') return json({ assignment: store.assignment });
    if (u.pathname === '/api/shipment/pick' && options.method === 'POST') {
      store.posted.push(JSON.parse(options.body));
      if (store.postError) return json(store.postError.body, store.postError.status);
      store.assignment = makeAssignment('picking');
      return json({ assignment: store.assignment }, 201);
    }
    const action = u.pathname.match(/^\/api\/shipment\/pick\/(\d+)\/(confirm|cancel)$/);
    if (action && options.method === 'POST') {
      store.statusCalls.push({ id: action[1], action: action[2], body: JSON.parse(options.body) });
      if (store.statusError) return json(store.statusError.body, store.statusError.status);
      store.assignment = makeAssignment(action[2] === 'confirm' ? 'confirmed' : 'cancelled', { version: store.assignment.version + 1 });
      return json({ assignment: store.assignment });
    }
    if (u.pathname === '/shipment/lifecycle/pick/order-template.tpl') return { ok: true, status: 200, text: async () => read(path.join(pickDir, 'order-template.tpl')) };
    if (u.pathname === '/shipment/lifecycle/pick/invoice-a4.css') return { ok: true, status: 200, text: async () => read(path.join(pickDir, 'invoice-a4.css')) };
    if (u.pathname.startsWith('/shipment/lifecycle/pick/invoice-assets/')) return { ok: true, status: 200, blob: async () => new window.Blob(['jpg'], { type: 'image/jpeg' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  window.URL.createObjectURL = () => 'blob:test';
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = () => {};
  window.HTMLCanvasElement.prototype.getContext = () => null;
  window.alert = () => {};
  window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(read(path.join(publicDir, 'shared/table-controls.js')));
  // Cac script ngoai cua trang (jsdom 'outside-only' khong tu nap): nap theo dung thu tu trong index.html.
  ['shared/carton.js', 'shared/pick-rules.js', 'shipment/lifecycle/pick/invoice.js', 'shipment/lifecycle/pick/print-tools.js', 'shipment/lifecycle/pick/pick-assign.js']
    .forEach(file => window.eval(read(path.join(publicDir, file))));
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).forEach(script => window.eval(script));
  await settle();
  return { dom, window, document: window.document, calls, source, store };
}

const rowsOf = document => [...document.querySelectorAll('#bulkBody tr')];
const openDetail = async page => { rowsOf(page.document)[0].click(); await settle(); };
const openPopup = async page => { await openDetail(page); page.document.getElementById('openPickingBtn').click(); await settle(); };
const text = (page, id) => page.document.getElementById(id).textContent;
const visible = (page, id) => !page.document.getElementById(id).hidden;
const click = async (page, id) => { page.document.getElementById(id).click(); await settle(); };
// Đổi phân bổ của DH1 từ A07 x 100 sang A07 x 50 + B02 x 50 (tổng vẫn 100) để đơn Đang nhặt có thay đổi chưa lưu.
const makeDirty = async page => {
  const { document, window } = page;
  const input = document.querySelector('[data-qty][data-qloc="11"]');
  input.value = '50';
  input.dispatchEvent(new window.Event('change', { bubbles: true }));
  for (let i = 0; i < 2; i++) { document.querySelector('[data-step="1"][data-qloc="12"]').click(); }
  await settle();
};

// ---------------------------------------------------------------------------

test('quyền shipment.pick: có quyền + đơn Đã gửi kế toán thì có nút Chỉ định vị trí; không quyền thì không nút và ẩn ô lọc chỉ định', async () => {
  const withPick = await renderPage();
  await openDetail(withPick);
  assert.ok(withPick.document.querySelector('#lcDetailPickActions #openPickingBtn'), 'nút Chỉ định vị trí ở đầu hộp');
  assert.equal(withPick.document.getElementById('lcDetailPickActions').nextElementSibling.id, 'lcDetailClose', 'nút chỉ định bên trái dấu X');
  assert.equal(withPick.document.querySelector('#lcDetailKiot #openPickingBtn'), null);
  assert.equal(withPick.document.getElementById('bulkPickWrap').hidden, false);

  const without = await renderPage({ permissions: ['shipment.lifecycle'] });
  await openDetail(without);
  assert.equal(without.document.getElementById('openPickingBtn'), null);
  assert.equal(without.document.getElementById('bulkPickWrap').hidden, true);
  assert.equal(without.document.getElementById('pickingDialog'), null, 'popup chỉ tạo khi mở');
  [withPick, without].forEach(page => page.dom.window.close());
});

test('đơn chưa gửi kế toán và chưa có chỉ định: không có nút; đã có chỉ định thì vẫn mở được để xem/in', async () => {
  const notSent = await renderPage({ orders: [orderRow('DH1', { summary: { code: 'NOT_SENT', label: 'Chưa gửi', at: null } })] });
  await openDetail(notSent);
  assert.equal(notSent.document.getElementById('pickingActions'), null);

  const store = newStore({ assignment: makeAssignment('confirmed') });
  const assigned = await renderPage({ orders: [orderRow('DH1', { summary: { code: 'DELIVERING', label: 'Đang giao', at: null }, pickStatus: 'confirmed' })], store });
  await openDetail(assigned);
  assert.ok(assigned.document.getElementById('openPickingBtn'));
  assert.match(assigned.document.querySelector('.picking-confirmed').textContent, /Đã chỉ định · Xác nhận nhặt/);
  [notSent, assigned].forEach(page => page.dom.window.close());
});

test('mở chỉ định, sửa số lượng rồi đóng không ghi chỉ định hoặc chuyển Đang bốc; chỉ Xác nhận & In mới chuyển', async () => {
  const page = await renderPage();
  try {
    const status = () => rowsOf(page.document)[0].querySelector('[data-col="pickStatus"] .lc-pick-state').dataset.pickStatus;
    await openPopup(page);
    assert.equal(status(), 'none');
    page.document.querySelector('[data-step="-1"][data-qloc="11"]').click();
    assert.equal(status(), 'none');
    await click(page, 'pickingClose');
    assert.equal(status(), 'none');
    assert.equal(page.store.assignment, null);
    assert.equal(page.calls.filter(c => c.method === 'POST').length, 0);
    await click(page, 'openPickingBtn');
    assert.equal(status(), 'none');
    await click(page, 'pickingConfirm');
    assert.equal(page.store.posted.length, 1);
    assert.equal(status(), 'picking');
  } finally { page.dom.window.close(); }
});

test('popup gọi candidates đúng cơ sở + mã đơn, hiện 7 cột và gợi ý tròn thùng; Xác nhận bật khi phân bổ đủ', async () => {
  const page = await renderPage();
  await openPopup(page);
  const call = page.calls.find(c => c.url.startsWith('/api/shipment/pick/candidates'));
  assert.equal(call.url, '/api/shipment/pick/candidates?branch=HN&order=DH1');
  assert.deepEqual([...page.document.querySelectorAll('#pickingDialog thead th')].map(th => th.querySelector('button').firstChild.textContent.trim()), ['Mã hàng', 'Tên hàng', 'Ghi chú', 'Cần nhặt', 'ST', 'Có thể bốc', 'Vị trí kho']);
  assert.equal(page.document.querySelectorAll('#pickingRows tr').length, 1, 'dòng VAT bị bỏ');
  assert.equal(text(page, 'pickingTitle'), 'DH1 · Hà Nội');
  // gợi ý: 100 = 2 thùng x 50 tại A07
  const selected = [...page.document.querySelectorAll('.picking-loc.selected')];
  assert.equal(selected.length, 1);
  assert.match(selected[0].textContent, /A07/);
  assert.equal(selected[0].querySelector('[data-qty]').value, '100');
  assert.equal(page.document.querySelector('.picking-st').dataset.st, '2', 'ST = 2 thùng');
  assert.equal(text(page, 'pickingProgress'), '1/1 mã hàng đã phân bổ đủ');
  assert.equal(page.document.getElementById('pickingConfirm').disabled, false);
  assert.equal(text(page, 'pickingOrderStatus'), 'Chưa chỉ định');
  assert.equal(page.document.getElementById('pickingConfirmPick').hidden, true);
  page.dom.window.close();
});

test('hộp chỉ định: dòng có SL chọn khác SL khách đặt bôi đỏ; cột Ghi chú hiện ghi chú dòng hàng; cột kéo được độ rộng', async () => {
  const store = newStore();
  store.order.lines[0].note = 'full vat';
  const page = await renderPage({ store });
  await openPopup(page);
  const { document } = page;
  const row = () => document.querySelector('#pickingRows tr');
  assert.equal(row().querySelector('.picking-note').textContent, 'full vat');
  assert.equal(row().classList.contains('picking-mismatch'), false, 'chọn đủ 100/100 thì không đỏ');
  document.querySelector('[data-step="-1"][data-qloc="11"]').click();
  assert.equal(row().classList.contains('picking-mismatch'), true, 'thiếu 50/100 → đỏ');
  document.querySelector('[data-step="1"][data-qloc="11"]').click();
  assert.equal(row().classList.contains('picking-mismatch'), false, 'trở lại 100/100 → hết đỏ');
  const input = document.querySelector('[data-qty][data-qloc="12"]');
  input.value = '25';
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  assert.equal(row().classList.contains('picking-mismatch'), true, 'thừa 125/100 → đỏ');
  const table = document.querySelector('#pickingDialog .picking-table');
  assert.equal(table.dataset.tableControls, undefined, 'bảng không còn tắt table-controls');
  assert.equal(table.querySelectorAll('thead th .tks-column-resizer').length, 7, 'mỗi cột có tay kéo độ rộng');
  const css = fs.readFileSync(path.join(publicDir, 'shipment/lifecycle/pick/pick-assign.css'), 'utf8');
  assert.match(css, /tr\.picking-mismatch>td\{background:rgba\(239,68,68/);
  page.dom.window.close();
});

test('Cần nhặt sửa tay: ô nhập số, dòng đỏ theo SL đã sửa, hiện SL Kiot khi khác, gửi needs khi chỉ định; về SL Kiot thì bỏ needs', async () => {
  const page = await renderPage();
  await openPopup(page);
  const { document, window } = page;
  const need = () => document.querySelector('#pickingRows [data-need]');
  const row = () => document.querySelector('#pickingRows tr');
  const setNeed = value => { need().value = value; need().dispatchEvent(new window.Event('change', { bubbles: true })); };
  assert.equal(need().value, '100');
  assert.equal(row().classList.contains('picking-mismatch'), false);
  assert.equal(document.querySelector('.picking-kiot'), null, 'chưa sửa thì không có dòng Kiot');
  // Sửa 100 -> 60: đang chọn 100 nên lệch -> đỏ, hiện SL Kiot.
  setNeed('60');
  assert.equal(row().classList.contains('picking-mismatch'), true);
  assert.equal(document.querySelector('.picking-kiot').textContent, 'Kiot: 100');
  assert.match(document.querySelector('.picking-need small[data-allocated]').textContent, /Đã phân bổ 100\/60/);
  // Bớt một thùng (50): chọn 50 vẫn lệch 60 -> đỏ; sửa cần nhặt = 50 -> khớp -> hết đỏ.
  document.querySelector('[data-step="-1"][data-qloc="11"]').click();
  assert.equal(row().classList.contains('picking-mismatch'), true);
  setNeed('50');
  assert.equal(row().classList.contains('picking-mismatch'), false);
  assert.equal(document.querySelector('.picking-kiot').textContent, 'Kiot: 100');
  // Giá trị không hợp lệ bị từ chối, giữ nguyên số cũ.
  setNeed('0');
  assert.match(text(page, 'pickingStatus'), /nguyên dương/u);
  assert.equal(need().value, '50');
  // Chỉ định gửi needs (chỉ mã đã sửa khác Kiot) và phân bổ theo SL mới; SL sửa sẽ GHI LÊN KIOT nên phải xác nhận trước.
  let askedText = '';
  page.window.confirm = message => { askedText = message; return true; };
  await click(page, 'pickingConfirm');
  assert.match(askedText, /Ghi lên đơn KiotViet[\s\S]*A: 100 → 50/u);
  assert.equal(page.store.posted.length, 1);
  assert.deepEqual(page.store.posted[0].needs, { A: 50 });
  assert.deepEqual(page.store.posted[0].allocations, [{ productCode: 'A', positionId: 11, qty: 50 }]);
  page.dom.window.close();

  // Sửa về đúng SL Kiot thì không gửi needs.
  const again = await renderPage();
  await openPopup(again);
  const input = again.document.querySelector('#pickingRows [data-need]');
  input.value = '80'; input.dispatchEvent(new again.window.Event('change', { bubbles: true }));
  const back = again.document.querySelector('#pickingRows [data-need]');
  back.value = '100'; back.dispatchEvent(new again.window.Event('change', { bubbles: true }));
  assert.equal(again.document.querySelector('.picking-kiot'), null);
  await click(again, 'pickingConfirm');
  assert.equal('needs' in again.store.posted[0], false);
  again.dom.window.close();
});

test('Cần nhặt: nút tăng giảm giữ phân bổ, giới hạn tối thiểu 1, trạng thái đủ và lệch rõ ràng', async () => {
  const page = await renderPage();
  await openPopup(page);
  const { document, window } = page;
  const input = () => document.querySelector('[data-need]');
  const step = value => document.querySelector(`[data-need-step="${value}"]`).click();
  const status = () => document.querySelector('.picking-allocation');
  assert.equal(status().classList.contains('picking-good'), true);
  step(1);
  assert.equal(input().value, '101');
  assert.equal(status().dataset.allocated, '100');
  assert.equal(status().classList.contains('picking-bad'), true);
  assert.equal(document.activeElement.dataset.needStep, '1');
  step(-1);
  assert.equal(input().value, '100');
  assert.equal(status().classList.contains('picking-good'), true);
  assert.equal(document.querySelector('.picking-kiot'), null);
  input().value = '1';
  input().dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('[data-need-step="-1"]').disabled, true);
  step(-1);
  assert.equal(input().value, '1');
  page.dom.window.close();
});

test('Đang nhặt: SL cần nhặt lấy từ snapshot đã lưu; sửa "Cần nhặt" là thay đổi chưa lưu (khóa Xác nhận nhặt, bật Cập nhật)', async () => {
  const store = newStore({ assignment: makeAssignment('picking') });
  store.assignment.snapshot.lines[0].quantity = 100; // snapshot = Kiot 100
  const page = await renderPage({ store, orders: [orderRow('DH1', { pickStatus: 'picking' })] });
  await openPopup(page);
  const { document, window } = page;
  assert.equal(document.getElementById('pickingConfirm').disabled, false, 'chưa đổi gì vẫn chỉ định lại được');
  const input = document.querySelector('#pickingRows [data-need]');
  input.value = '90'; input.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(document.getElementById('pickingConfirm').disabled, false, 'đổi Cần nhặt = có thay đổi chưa lưu');
  assert.equal(document.getElementById('pickingConfirmPick').disabled, true);
  page.dom.window.close();

  // Chỉ định đã lưu với SL sửa 90 (Kiot 100): mở lại hiện 90 + "Kiot: 100", chưa thay đổi.
  const saved = newStore({ assignment: makeAssignment('picking', { lines: [{ id: 1, productCode: 'A', positionId: 11, location: 'A07', plannedQty: 90, reservedQty: 90, stCartons: 1.8, stText: '1Tx50-10' }] }) });
  saved.assignment.snapshot.lines[0].quantity = 90;
  const reopened = await renderPage({ store: saved, orders: [orderRow('DH1', { pickStatus: 'picking' })] });
  await openPopup(reopened);
  assert.equal(reopened.document.querySelector('#pickingRows [data-need]').value, '90');
  assert.equal(reopened.document.querySelector('.picking-kiot').textContent, 'Kiot: 100');
  assert.equal(reopened.document.querySelector('#pickingRows tr').classList.contains('picking-mismatch'), false, 'chọn 90 = cần nhặt 90');
  assert.equal(reopened.document.getElementById('pickingConfirmPick').disabled, false, 'chưa có thay đổi chưa lưu');
  reopened.dom.window.close();
});

test('ST ghi đầy đủ gộp mọi vị trí (cùng SL/thùng cộng thùng, phần thiếu cộng dồn) và Có thể bốc có dòng Còn sau chỉ định', async () => {
  const store = newStore();
  store.order.lines[0].quantity = 250;
  store.candidates = { a: [position(11, 'A07', '3T x 100', 300), position(12, 'B02', '2T x 100', 200), position(13, 'C01', '2T x 50', 100)] };
  const page = await renderPage({ store });
  await openPopup(page);
  const { document } = page;
  const setQty = id => value => { const input = document.querySelector('[data-qty][data-qloc="' + id + '"]'); input.value = value; input.dispatchEvent(new page.window.Event('change', { bubbles: true })); };
  // 200 từ A07 (2T x 100) + 50 từ C01 (1T x 50) = 250
  setQty(11)('0'); setQty(12)('0'); setQty(13)('0');
  setQty(11)('200'); setQty(13)('50');
  const cell = document.querySelector('.picking-st');
  assert.equal(cell.dataset.stText, '2T x 100 + 1T x 50', 'gộp thùng 100 của vị trí A07 với thùng 50 của C01');
  assert.equal(cell.dataset.st, '3');
  assert.equal(cell.querySelector('strong').textContent, '2T x 100 + 1T x 50');
  assert.match(cell.querySelector('small').textContent, /Tổng 3 thùng/);
  // Có thể bốc = tồn kho (600) trừ SL đang chọn (250)
  const total = document.querySelector('.picking-total');
  assert.match(total.querySelector('strong').textContent, /600/);
  assert.equal(total.querySelector('.picking-pickable').dataset.pickable, '350');
  assert.match(total.querySelector('.picking-pickable').textContent, /Còn sau chỉ định: 350/);
  // Hai vị trí cùng SL/thùng + phần thiếu: A07 nhặt 150 = 2T x 100 - 50, B02 nhặt 100 = 1T x 100 → 3T x 100 - 50
  setQty(11)('0'); setQty(13)('0'); setQty(11)('150'); setQty(12)('100');
  assert.equal(document.querySelector('.picking-st').dataset.stText, '3T x 100 - 50');
  assert.ok(document.querySelector('.picking-st strong').classList.contains('picking-st-frac'), 'có phần thiếu thì hiện đỏ');
  page.dom.window.close();
});

test('validate: SL phân bổ thiếu vẫn mở Xác nhận kèm cảnh báo; bấm − / + theo bước thùng; không vượt tồn khả dụng', async () => {
  const page = await renderPage();
  await openPopup(page);
  const { document } = page;
  const confirmBtn = document.getElementById('pickingConfirm');
  const minus = document.querySelector('[data-step="-1"][data-qloc="11"]');
  minus.click();
  assert.equal(document.querySelector('[data-qty][data-qloc="11"]').value, '50', 'trừ đúng một thùng (50)');
  assert.equal(confirmBtn.disabled, false, 'thiếu 50/100 vẫn chỉ định được (có cảnh báo)');
  assert.match(document.getElementById('pickingSource').textContent, /thiếu 50/);
  assert.equal(document.querySelector('.picking-need small').dataset.allocated, '50');
  // nhập tay quá tồn khả dụng của vị trí B02 (50): bị chặn về 50
  const typed = document.querySelector('[data-qty][data-qloc="12"]');
  typed.value = '999';
  typed.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  assert.equal(document.querySelector('[data-qty][data-qloc="12"]').value, '50');
  assert.equal(confirmBtn.disabled, false, '50 (A07) + 50 (B02) = 100');
  // bấm "Gợi ý lại" khôi phục gợi ý ban đầu
  await click(page, 'pickingSuggest');
  assert.equal(document.querySelector('[data-qty][data-qloc="11"]').value, '100');
  page.dom.window.close();
});

test('chọn vị trí mới bổ sung 360 còn thiếu và giữ nguyên vị trí đã chọn 40', async () => {
  const store = newStore();
  store.order.lines[0].quantity = 400;
  store.candidates = { a: [position(11, 'A07', '1T x 40', 40), position(12, 'B02', '2T x 400', 800)] };
  const page = await renderPage({ store });
  try {
    await openPopup(page);
    // Xóa gợi ý để chọn lần lượt vị trí nhỏ trước, vị trí lớn sau.
    for (const input of [...page.document.querySelectorAll('[data-qty]')]) {
      input.value = '0';
      input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
    }
    page.document.querySelector('[data-location="11"]').click();
    assert.equal(page.document.querySelector('[data-qty][data-qloc="11"]').value, '40');
    page.document.querySelector('[data-location="12"]').click();
    assert.equal(page.document.querySelector('[data-qty][data-qloc="11"]').value, '40');
    assert.equal(page.document.querySelector('[data-qty][data-qloc="12"]').value, '360');
    assert.equal(page.document.querySelector('.picking-need small').dataset.allocated, '400');
  } finally { page.dom.window.close(); }
});

test('vị trí ghi chú sai định dạng (không có SL) bị khóa và hiện nhãn cảnh báo', async () => {
  const store = newStore({ candidates: { a: [position(11, 'A07', '4T x 50', 200), position(13, 'C01', 'abc', null, { onHand: null, available: null, warnings: ['unreadable'] })] } });
  const page = await renderPage({ store });
  await openPopup(page);
  const button = page.document.querySelector('[data-location="13"]');
  assert.equal(button.disabled, true);
  assert.match(button.textContent, /Ghi chú sai định dạng/);
  const total = page.document.querySelector('.picking-total');
  assert.equal(total.querySelector('strong').textContent, '200 (chưa xác định)');
  assert.equal(total.querySelector('.picking-pickable').textContent, 'Còn sau chỉ định: 100 (chưa xác định)');
  const input = page.document.querySelector('[data-qty][data-qloc="11"]');
  input.value = '50';
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  assert.equal(page.document.querySelector('.picking-pickable').textContent, 'Còn sau chỉ định: 150 (chưa xác định)');
  page.dom.window.close();
});

test('Xác nhận & In: POST đúng phân bổ, đóng popup, mở phiếu in có vị trí/ST và chip Đã chỉ định · Đang nhặt', async () => {
  const page = await renderPage();
  await openPopup(page);
  await click(page, 'pickingConfirm');
  assert.deepEqual(page.store.posted, [{ branch: 'HN', orderCode: 'DH1', allocations: [{ productCode: 'A', positionId: 11, qty: 100 }] }]);
  assert.equal(page.document.getElementById('pickingDialog').hasAttribute('open'), false, 'popup đóng');
  const print = page.document.getElementById('pickingPrintDialog');
  assert.equal(print.hasAttribute('open'), true, 'phiếu nhặt mở');
  const sheet = page.document.getElementById('pickingPrintSheet').textContent;
  assert.match(sheet, /DH1/);
  assert.match(sheet, /KH A/);
  assert.match(sheet, /Sale A - 123456/, 'tên sale kèm ID Telegram');
  assert.match(sheet, /A07/);
  assert.match(sheet, /2T x 50/);
  assert.equal(page.document.querySelector('#pickingPrintSheet td.invoice-actual').textContent.trim(), '', 'Thực tế nhặt để trống');
  assert.match(page.document.querySelector('#lcDetailKiot .picking-confirmed').textContent, /Đã chỉ định · Đang nhặt/);
  // dòng đơn trên danh sách có nhãn trạng thái ngay trong ô mã đơn (không thêm cột)
  assert.equal(rowsOf(page.document)[0].querySelector('[data-col="pickStatus"] .lc-pick-state').dataset.pickStatus, 'picking');
  // đơn đã có chỉ định (đang nhặt): bảng hàng hóa có thêm cột ST = 2
  const heads = [...page.document.querySelectorAll('#lcDetailKiot table.lc-lines thead th')].map(th => th.textContent);
  assert.equal(heads.length, 10);
  assert.match(heads[3], /^ST/, 'cột ST ngay sau SL đặt');
  assert.equal(page.document.querySelector('#lcDetailKiot td.lc-st').dataset.st, '2');
  page.dom.window.close();
});

test('bảng hàng hóa mặc định giữ 9 cột (không ST) khi đơn chưa có chỉ định hoặc đã Hủy nhặt', async () => {
  const page = await renderPage();
  await openDetail(page);
  assert.equal(page.document.querySelectorAll('#lcDetailKiot table.lc-lines thead th').length, 9);
  assert.equal(page.document.querySelector('#lcDetailKiot td.lc-st'), null);

  const cancelled = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'cancelled' })], store: newStore({ assignment: makeAssignment('cancelled') }) });
  await openDetail(cancelled);
  assert.equal(cancelled.document.querySelectorAll('#lcDetailKiot table.lc-lines thead th').length, 9);
  [page, cancelled].forEach(p => p.dom.window.close());
});

test('nút theo trạng thái: Đang nhặt = Xác nhận nhặt / Hủy nhặt / In đơn và sửa được ngay; Xác nhận nhặt (trạng thái cuối) = chỉ In đơn và khóa; Hủy nhặt = sửa được; không còn nút Chỉ định lại', async () => {
  const expectations = {
    picking: { confirmPick: true, cancelPick: true, reprint: true, editable: true },
    confirmed: { confirmPick: false, cancelPick: false, reprint: true, editable: false },
    cancelled: { confirmPick: false, cancelPick: false, reprint: false, editable: true }
  };
  for (const [status, want] of Object.entries(expectations)) {
    const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: status })], store: newStore({ assignment: makeAssignment(status) }) });
    await openPopup(page);
    assert.equal(page.document.getElementById('pickingReopen').hidden, status !== 'confirmed', 'nút Chỉ định lại chỉ hiện với Đã bốc');
    assert.equal(text(page, 'pickingOrderStatus'), { picking: 'Đang nhặt', confirmed: 'Xác nhận nhặt', cancelled: 'Hủy nhặt' }[status]);
    assert.deepEqual(
      { confirmPick: visible(page, 'pickingConfirmPick'), cancelPick: visible(page, 'pickingCancelPick'), reprint: visible(page, 'pickingReprint'), editable: !page.document.querySelector('[data-qty][data-qloc="11"]').disabled },
      want, status);
    assert.equal(page.document.getElementById('pickingSuggest').disabled, !want.editable);
    assert.equal(page.document.querySelector('[data-qty][data-qloc="11"]').value, '100', status === 'cancelled' ? 'đã hủy: gợi ý mới' : 'hiện lại đúng phân bổ đã chỉ định');
    // Đang nhặt và Đã hủy chỉ định (lại) được ngay; Đã bốc khóa tới khi bấm Chỉ định lại.
    assert.equal(page.document.getElementById('pickingConfirm').disabled, status === 'confirmed', status);
    page.dom.window.close();
  }
});

test('Đang nhặt sửa ngay: chưa đổi thì Xác nhận nhặt/In đơn dùng được; có thay đổi chưa lưu thì khóa chúng, nút lưu là Cập nhật chỉ định; Gợi ý lại khôi phục thứ tự theo thuật toán', async () => {
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store: newStore({ assignment: makeAssignment('picking') }) });
  await openPopup(page);
  const { document } = page;
  assert.equal(text(page, 'pickingConfirm'), 'Cập nhật chỉ định & In phiếu');
  assert.equal(document.getElementById('pickingConfirmPick').disabled, false);
  assert.equal(document.getElementById('pickingReprint').disabled, false);
  await makeDirty(page);
  assert.equal(document.getElementById('pickingConfirm').disabled, false);
  assert.equal(document.getElementById('pickingConfirmPick').disabled, true, 'chưa lưu thì không xác nhận bản cũ');
  assert.equal(document.getElementById('pickingReprint').disabled, true);
  assert.match(text(page, 'pickingSource'), /thay đổi chưa lưu/);
  await click(page, 'pickingSuggest');
  assert.equal(document.querySelector('[data-qty][data-qloc="11"]').value, '100');
  page.dom.window.close();
});

test('thứ tự vị trí trong hộp chỉ định theo ưu tiên của thuật toán (vị trí được gợi ý trước), không theo tên kho', async () => {
  const store = newStore();
  // A01 hết hàng, A02 chỉ có 40, Z99 và M05 đều đủ 100 theo thùng nguyên; thuật toán gợi ý Z99 (vừa đủ, ít dư).
  store.candidates = { a: [position(21, 'A01', '', 0), position(22, 'A02', '1T x 40', 40), position(23, 'M05', '10T x 50', 500), position(24, 'Z99', '2T x 50', 100)] };
  const page = await renderPage({ store });
  await openPopup(page);
  const order = [...page.document.querySelectorAll('.picking-location')].map(button => button.dataset.location);
  assert.deepEqual(order, ['24', '23', '22', '21'], 'được gợi ý (Z99) → còn hàng đủ SL (M05) → còn hàng thiếu (A02) → hết hàng (A01)');
  page.dom.window.close();
});

test('Xác nhận nhặt gọi đúng API kèm version và là trạng thái cuối (hết nút Hủy nhặt / Chỉ định lại); Hủy nhặt đơn Đang nhặt gọi đúng API', async () => {
  const store = newStore({ assignment: makeAssignment('picking') });
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store });
  await openPopup(page);
  await click(page, 'pickingConfirmPick');
  assert.deepEqual(store.statusCalls, [{ id: '7', action: 'confirm', body: { version: 1 } }]);
  assert.equal(text(page, 'pickingOrderStatus'), 'Xác nhận nhặt');
  assert.match(page.document.querySelector('#lcDetailKiot .picking-confirmed').textContent, /Xác nhận nhặt/);
  assert.equal(rowsOf(page.document)[0].querySelector('[data-col="pickStatus"] .lc-pick-state').dataset.pickStatus, 'confirmed');
  assert.equal(visible(page, 'pickingCancelPick'), false, 'Đã bốc: không hủy được nữa');

  const cancelStore = newStore({ assignment: makeAssignment('picking') });
  const cancelPage = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store: cancelStore });
  await openPopup(cancelPage);
  await click(cancelPage, 'pickingCancelPick');
  assert.deepEqual(cancelStore.statusCalls, [{ id: '7', action: 'cancel', body: { version: 1 } }]);
  assert.equal(text(cancelPage, 'pickingOrderStatus'), 'Hủy nhặt');
  assert.equal(rowsOf(cancelPage.document)[0].querySelector('[data-col="pickStatus"] .lc-pick-state').dataset.pickStatus, 'cancelled');
  assert.equal(cancelPage.document.querySelectorAll('#lcDetailKiot table.lc-lines thead th').length, 9, 'Hủy nhặt: bỏ cột ST');
  [page, cancelPage].forEach(p => p.dom.window.close());
});

test('Đã hủy chỉ định mới ngay (không reassign); Đang nhặt đổi rồi lưu bằng MỘT lệnh reassign (không gọi hủy riêng); Đã bốc khóa', async () => {
  const cancelled = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'cancelled' })], store: newStore({ assignment: makeAssignment('cancelled') }) });
  await openPopup(cancelled);
  assert.equal(cancelled.document.getElementById('pickingConfirm').disabled, false, 'chọn lại được ngay');
  await click(cancelled, 'pickingConfirm');
  assert.equal(cancelled.store.posted[0].reassign, undefined, 'đơn Đã hủy: chỉ định mới thường, không reassign');

  const store = newStore({ assignment: makeAssignment('picking', { version: 3 }) });
  const picking = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store });
  await openPopup(picking);
  await makeDirty(picking);
  await click(picking, 'pickingConfirm');
  assert.equal(store.posted.length, 1);
  assert.equal(store.posted[0].reassign, true);
  assert.equal(store.posted[0].version, 3, 'kèm version của lượt đang bốc để khóa lạc quan');
  assert.deepEqual(store.posted[0].allocations, [{ productCode: 'A', positionId: 11, qty: 50 }, { productCode: 'A', positionId: 12, qty: 50 }]);
  assert.equal(store.statusCalls.length, 0, 'không hủy riêng: lượt cũ chỉ bị hủy cùng giao dịch với lượt mới');
  assert.equal(text(picking, 'pickingOrderStatus'), 'Đang nhặt');

  const confirmed = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'confirmed' })], store: newStore({ assignment: makeAssignment('confirmed') }) });
  await openPopup(confirmed);
  assert.equal(confirmed.document.getElementById('pickingConfirm').disabled, true);
  assert.ok([...confirmed.document.querySelectorAll('[data-qty],[data-step],[data-location]')].every(el => el.disabled));
  [cancelled, picking, confirmed].forEach(p => p.dom.window.close());
});

test('Đã bốc: bấm Chỉ định lại (hỏi xác nhận) thì mở khóa; lưu bằng MỘT lệnh reassign kèm version; từ chối hỏi thì vẫn khóa', async () => {
  const store = newStore({ assignment: makeAssignment('confirmed', { version: 4 }) });
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'confirmed' })], store });
  await openPopup(page);
  const { document, window } = page;
  assert.equal(document.getElementById('pickingReopen').hidden, false);
  assert.equal(document.getElementById('pickingConfirm').disabled, true);
  window.confirm = () => false;
  await click(page, 'pickingReopen');
  assert.equal(document.getElementById('pickingConfirm').disabled, true, 'từ chối thì vẫn khóa');
  window.confirm = () => true;
  await click(page, 'pickingReopen');
  assert.equal(document.getElementById('pickingReopen').hidden, true);
  assert.equal(document.getElementById('pickingConfirm').disabled, false);
  assert.equal(text(page, 'pickingConfirm'), 'Chỉ định lại & In phiếu');
  assert.ok([...document.querySelectorAll('[data-location]')].some(el => !el.disabled), 'chọn lại được vị trí');
  await click(page, 'pickingConfirm');
  assert.equal(store.posted.length, 1);
  assert.equal(store.posted[0].reassign, true);
  assert.equal(store.posted[0].version, 4);
  assert.equal(store.statusCalls.length, 0);
  page.dom.window.close();
});

test('reassign gặp 409 ALREADY_CONFIRMED (người khác vừa bốc xong): báo rõ đơn đã bốc, tải lại, hiện Đã bốc và khóa chọn', async () => {
  const store = newStore({ assignment: makeAssignment('picking'), postError: { status: 409, body: { error: 'Đơn đã bốc xong, không in lại hoặc chỉ định lại được.', code: 'ALREADY_CONFIRMED' } } });
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store });
  await openPopup(page);
  await makeDirty(page);
  store.assignment = makeAssignment('confirmed', { version: 2 });
  const before = store.candidateCalls;
  await click(page, 'pickingConfirm');
  assert.match(text(page, 'pickingStatus'), /đã bốc xong/);
  assert.match(text(page, 'pickingStatus'), /Đã tải lại/);
  assert.equal(store.candidateCalls, before + 1, 'tải lại candidates');
  assert.equal(text(page, 'pickingOrderStatus'), 'Xác nhận nhặt');
  assert.equal(page.document.getElementById('pickingConfirm').disabled, true);
  page.dom.window.close();
});

test('lỗi 409 hiện thông báo trong popup và tải lại dữ liệu (không đóng popup, không đổi trạng thái)', async () => {
  const store = newStore({ postError: { status: 409, body: { error: 'Vị trí A07 không đủ hàng khả dụng.', code: 'INSUFFICIENT_AVAILABLE' } } });
  const page = await renderPage({ store });
  await openPopup(page);
  const before = store.candidateCalls;
  await click(page, 'pickingConfirm');
  assert.match(text(page, 'pickingStatus'), /không đủ hàng khả dụng/);
  assert.match(text(page, 'pickingStatus'), /Đã tải lại/);
  assert.equal(page.document.getElementById('pickingStatus').dataset.error, 'true');
  assert.equal(store.candidateCalls, before + 1, 'tải lại candidates');
  assert.equal(page.document.getElementById('pickingDialog').hasAttribute('open'), true);
  assert.equal(page.document.getElementById('pickingPrintDialog').hasAttribute('open'), false);

  const picking = newStore({ assignment: makeAssignment('picking'), statusError: { status: 409, body: { error: 'Chỉ định đã bị đổi.', code: 'VERSION_CONFLICT' } } });
  const conflict = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store: picking });
  await openPopup(conflict);
  await click(conflict, 'pickingConfirmPick');
  assert.match(text(conflict, 'pickingStatus'), /Chỉ định đã bị đổi/);
  assert.equal(text(conflict, 'pickingOrderStatus'), 'Đang nhặt');
  [page, conflict].forEach(p => p.dom.window.close());
});

test('đơn không còn đủ điều kiện (eligible=false) và chưa chỉ định: popup chỉ báo, khóa chọn', async () => {
  const store = newStore();
  store.order.eligible = false;
  const page = await renderPage({ store });
  await openPopup(page);
  assert.match(text(page, 'pickingSource'), /chưa đủ điều kiện/);
  assert.equal(page.document.getElementById('pickingConfirm').disabled, true);
  assert.equal(page.document.getElementById('pickingSuggest').disabled, true);
  page.dom.window.close();
});

test('danh sách: người có quyền chỉ định có cột Trạng thái bốc (14 cột); ô lọc gửi pickStatus và có đủ 5 lựa chọn', async () => {
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' }), orderRow('DH2')] });
  const { document, window } = page;
  assert.equal(document.querySelectorAll('#bulkHeadRow th').length, 14, '13 cột + cột Trạng thái bốc');
  const rows = rowsOf(document);
  const stateOf = row => row.querySelector('[data-col="pickStatus"] .lc-pick-state');
  assert.equal(stateOf(rows[0]).value, 'picking');
  assert.equal(stateOf(rows[0]).selectedOptions[0].textContent, 'Đang bốc');
  assert.equal(stateOf(rows[1]).textContent, 'Chưa bốc');
  assert.equal(stateOf(rows[1]).dataset.pickStatus, 'none');
  assert.deepEqual([...document.getElementById('bulkPickStatusFilter').options].map(o => o.value), ['', 'none', 'picking', 'confirmed', 'cancelled']);
  const select = document.getElementById('bulkPickStatusFilter');
  select.value = 'confirmed';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  const lastList = page.calls.filter(c => isListUrl(c.url)).at(-1).url;
  assert.equal(new URL(lastList, 'https://tokosi.example').searchParams.get('pickStatus'), 'confirmed');
  select.value = '';
  select.dispatchEvent(new window.Event('change', { bubbles: true }));
  await settle();
  assert.equal(new URL(page.calls.filter(c => isListUrl(c.url)).at(-1).url, 'https://tokosi.example').searchParams.has('pickStatus'), false);
  page.dom.window.close();
});

test('làm mới danh sách: pickStatus đổi thì dòng vẽ lại nhãn (có trong chữ ký dòng)', async () => {
  const page = await renderPage({ orders: [orderRow('DH1')] });
  assert.equal(rowsOf(page.document)[0].querySelector('[data-col="pickStatus"] .lc-pick-state').dataset.pickStatus, 'none');
  page.source.orders = [orderRow('DH1', { pickStatus: 'confirmed' })];
  page.window.eval('loadBulkOrders(true)');
  await settle();
  assert.equal(rowsOf(page.document)[0].querySelector('[data-col="pickStatus"] .lc-pick-state').dataset.pickStatus, 'confirmed');
  page.dom.window.close();
});

test('Esc khi popup mở chỉ đóng popup, hộp chi tiết đơn bên dưới vẫn mở', async () => {
  const page = await renderPage();
  await openPopup(page);
  page.document.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(page.document.getElementById('lcDetailOverlay').hidden, false, 'hộp chi tiết còn mở');
  page.dom.window.close();
});

test('in lại (In đơn) mở phiếu từ bản ghi chỉ định; Hủy nhặt thì phiếu không in ST', async () => {
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'confirmed' })], store: newStore({ assignment: makeAssignment('confirmed') }) });
  await openPopup(page);
  await click(page, 'pickingReprint');
  assert.equal(page.document.getElementById('pickingPrintDialog').hasAttribute('open'), true);
  assert.match(page.document.getElementById('pickingPrintTitle').textContent, /PHIẾU ĐẶT HÀNG · DH1/);
  assert.match(page.document.getElementById('pickingPrintSheet').textContent, /2T x 50/);
  // phiếu của đơn đã hủy: không còn ST
  await page.window.PickingInvoice.show({ ...makeAssignment('cancelled').snapshot, orderCode: 'DH1', branch: 'HN' }, makeAssignment('cancelled'));
  assert.doesNotMatch(page.document.getElementById('pickingPrintSheet').textContent, /2T x 50/);
  page.dom.window.close();
});

test('phiếu in: ST nối cộng từng khu (2T x 200 + 3T x 200 + 1T x 50 - 30), đỏ khi có phần thiếu', async () => {
  const page = await renderPage();
  await openPopup(page);
  const job = (id, location, plannedQty, stCartons, stText) => ({ id, productCode: 'A', positionId: id, location, plannedQty, reservedQty: plannedQty, stCartons, stText });
  const record = makeAssignment('picking', { lines: [job(1, '1', 400, 2, '2Tx200'), job(2, '24', 600, 3, '3Tx200'), job(3, 'SSP1', 20, 1, '1Tx50-30')] });
  const snapshot = { ...record.snapshot, lines: [{ productCode: 'A', productName: 'Hàng A', quantity: 1020, price: 1000, discount: 0 }] };
  await page.window.PickingInvoice.show({ ...snapshot, orderCode: 'DH1', branch: 'HN' }, record);
  const st = page.document.querySelector('#pickingPrintSheet tbody td.invoice-st');
  assert.equal(st.textContent.trim(), '2T x 200 + 3T x 200 + 1T x 50 - 30');
  assert.ok(st.classList.contains('invoice-st-frac'));
  page.dom.window.close();
});

test('phiếu in: dòng giữ đúng thứ tự đơn Kiot (không sắp theo vị trí); TT 1, 2, 3…; vị trí trong một dòng vẫn theo tên', async () => {
  const page = await renderPage();
  await openPopup(page);
  const line = (code, quantity) => ({ productCode: code, productName: 'Hàng ' + code, quantity, price: 1000, discount: 0 });
  const job = (id, code, location, plannedQty) => ({ id, productCode: code, positionId: id, location, plannedQty, reservedQty: plannedQty, stCartons: 1, stText: '1Tx' + plannedQty });
  const record = makeAssignment('picking', {
    lines: [job(1, 'P1', 'K05', 10), job(2, 'P2', 'H02', 10), job(3, 'P3', 'K09', 5), job(4, 'P3', 'H01', 5), job(5, 'P4', '', 10)]
  });
  const snapshot = { ...record.snapshot, lines: [line('P1', 10), line('P2', 10), line('P3', 10), line('P4', 10)] };
  await page.window.PickingInvoice.show({ ...snapshot, orderCode: 'DH1', branch: 'HN' }, record);
  const rows = [...page.document.querySelectorAll('#pickingPrintSheet table.invoice-goods tbody tr')];
  assert.deepEqual(rows.map(tr => tr.cells[0].textContent.trim()), ['1', '2', '3', '4']);
  assert.deepEqual(rows.map(tr => tr.cells[1].textContent.trim()), ['Hàng P1', 'Hàng P2', 'Hàng P3', 'Hàng P4'], 'đúng thứ tự dòng đơn Kiot; chỉ in tên hàng');
  assert.ok(rows.every(tr=>!tr.textContent.includes('(P')), 'không in mã hàng trong ngoặc');
  const p3Location = rows[2].querySelector('td.invoice-location').textContent;
  assert.ok(p3Location.indexOf('H01') < p3Location.indexOf('K09'), 'nhiều vị trí trong một dòng vẫn theo tên');
  page.dom.window.close();
});

test('lỗi tải ban đầu hết bận, cho tải lại mà không gửi lệnh ghi', async () => {
  let offline = true;
  const page = await renderPage({ fetchImpl: async url => {
    if (url.includes('/pick/candidates') && offline) throw new TypeError('offline');
  } });
  await openPopup(page);
  assert.equal(page.window.TKSPick._state.busy, false);
  assert.equal(page.window.TKSPick._state.needsSync, true);
  assert.equal(page.document.getElementById('pickingConfirm').disabled, true);
  assert.equal(page.document.getElementById('pickingReload').hidden, false);
  offline = false;
  await click(page, 'pickingReload');
  assert.equal(page.window.TKSPick._state.needsSync, false);
  assert.equal(page.document.getElementById('pickingConfirm').disabled, false);
  assert.equal(page.store.posted.length, 0);
  page.dom.window.close();
});

test('mất phản hồi sau confirm đồng bộ bản đã commit, không gửi POST lần hai', async () => {
  const store = newStore({ assignment: makeAssignment('picking') });
  let writes = 0;
  const page = await renderPage({ store, fetchImpl: async (url, options) => {
    if (url.endsWith('/7/confirm') && options.method === 'POST') {
      writes++;
      store.assignment = makeAssignment('confirmed', { version: 2 });
      throw new TypeError('lost response');
    }
  } });
  await openPopup(page);
  await click(page, 'pickingConfirmPick');
  assert.equal(page.window.TKSPick._state.busy, false);
  assert.equal(page.window.TKSPick._state.needsSync, false);
  assert.equal(page.window.TKSPick._state.assignment.version, 2);
  assert.equal(text(page, 'pickingOrderStatus'), 'Xác nhận nhặt');
  assert.equal(writes, 1);
  page.dom.window.close();
});

test('POST reject và đọc lại lỗi: khóa ghi, vẫn đóng/tải lại được', async () => {
  let offline = false, writes = 0;
  const page = await renderPage({ fetchImpl: async (url, options) => {
    if (url === '/api/shipment/pick' && options.method === 'POST') {
      offline = true; writes++; throw new TypeError('offline');
    }
    if (url.includes('/pick/candidates') && offline) throw new TypeError('offline');
  } });
  await openPopup(page);
  await click(page, 'pickingConfirm');
  assert.equal(page.window.TKSPick._state.busy, false);
  assert.equal(page.window.TKSPick._state.needsSync, true);
  assert.equal(page.document.getElementById('pickingConfirm').disabled, true);
  assert.equal(page.document.getElementById('pickingReload').disabled, false);
  await click(page, 'pickingConfirm');
  assert.equal(writes, 1);
  offline = false;
  await click(page, 'pickingReload');
  assert.equal(page.window.TKSPick._state.needsSync, false);
  await click(page, 'pickingClose');
  assert.equal(page.document.getElementById('pickingDialog').open, false);
  page.dom.window.close();
});

test('JSON hỏng sau ghi được coi là kết quả chưa rõ và tải lại', async () => {
  const store = newStore();
  const page = await renderPage({ store, fetchImpl: async (url, options) => {
    if (url === '/api/shipment/pick' && options.method === 'POST') {
      store.assignment = makeAssignment('picking');
      return { ok:true, status:201, json:async () => { throw new SyntaxError('invalid JSON'); } };
    }
  } });
  await openPopup(page);
  await click(page, 'pickingConfirm');
  assert.equal(page.window.TKSPick._state.busy, false);
  assert.equal(page.window.TKSPick._state.latest.id, 7);
  assert.equal(page.window.TKSPick._state.needsSync, false);
  assert.equal(page.document.getElementById('pickingDialog').open, true);
  page.dom.window.close();
});

test('đổi đơn khi GET đang chờ không bị phản hồi cũ ghi đè', async () => {
  let finishOld;
  const page = await renderPage({ fetchImpl: async url => {
    if (url.includes('/pick/candidates') && new URL(url, 'https://test').searchParams.get('order') === 'OLD') {
      return await new Promise(resolve => { finishOld = resolve; });
    }
  } });
  const old = page.window.TKSPick.open({ branch:'HN', orderCode:'OLD' });
  await settle();
  await page.window.TKSPick.open({ branch:'HN', orderCode:'DH1' });
  finishOld(json({ order:{ ...page.store.order, orderCode:'OLD' }, candidates:{}, assignment:null }));
  await old;
  assert.equal(page.window.TKSPick._state.order.orderCode, 'DH1');
  assert.match(text(page, 'pickingTitle'), /DH1/);
  assert.equal(page.window.TKSPick._state.busy, false);
  page.dom.window.close();
});

test('số chiếc nhập tay không được lẻ; lỗi nguồn hiện rõ, vẫn cho hủy bản cũ', async () => {
  const page = await renderPage();
  await openPopup(page);
  const input = page.document.querySelector('[data-qty]');
  assert.equal(input.getAttribute('step'), '1');
  input.value = '0.4';
  input.dispatchEvent(new page.window.Event('change', { bubbles:true }));
  assert.match(text(page, 'pickingStatus'), /số nguyên/i);
  assert.equal(page.window.TKSPick._state.allocations[0][0].quantity, 100);
  const store = newStore({ assignment:makeAssignment('picking') });
  store.order.eligible = false;
  store.order.validationErrors = ['A: số lượng phải là số nguyên dương'];
  const legacy = await renderPage({ store });
  await openPopup(legacy);
  assert.match(text(legacy, 'pickingSource'), /số nguyên/);
  assert.equal(legacy.document.getElementById('pickingCancelPick').disabled, false);
  [page, legacy].forEach(p => p.dom.window.close());
});

test('chỉ định lại (reassign) bị mất phản hồi: tải trạng thái thật, không tự gửi lần nữa', async () => {
  const store = newStore({ assignment:makeAssignment('picking') });
  let posts=0;
  const page=await renderPage({ store, fetchImpl:async (url,options) => {
    if(url==='/api/shipment/pick'&&options.method==='POST'){
      posts++;
      store.assignment=makeAssignment('picking',{id:8,version:3});
      throw new TypeError('lost reassign response');
    }
  } });
  await openPopup(page);
  await makeDirty(page);
  await click(page,'pickingConfirm');
  assert.equal(posts,1);
  assert.equal(store.statusCalls.length,0);
  assert.equal(page.window.TKSPick._state.latest.id,8,'hiện lượt mới đã được ghi trên máy chủ');
  assert.equal(page.window.TKSPick._state.latest.status,'picking');
  assert.equal(page.window.TKSPick._state.busy,false);
  assert.equal(page.window.TKSPick._state.needsSync,false);
  assert.equal(page.document.getElementById('pickingConfirm').disabled,false,'Đang nhặt luôn chỉ định lại được');
  page.dom.window.close();
});

test('đóng popup khi POST đang chờ không cho phản hồi cũ ghi đè lần mở mới', async () => {
  let finishPost;
  const page=await renderPage({ fetchImpl:async (url,options) => {
    if(url==='/api/shipment/pick'&&options.method==='POST')return await new Promise(resolve=>{finishPost=resolve;});
  } });
  await openPopup(page);
  await click(page,'pickingConfirm');
  assert.equal(page.window.TKSPick._state.busy,true);
  await click(page,'pickingClose');
  await page.window.TKSPick.open({branch:'HN',orderCode:'DH1'});
  finishPost(json({assignment:makeAssignment('picking')}));
  await settle();
  assert.equal(page.window.TKSPick._state.assignment,null);
  assert.equal(page.window.TKSPick._state.busy,false);
  assert.equal(page.document.getElementById('pickingDialog').open,true);
  assert.equal(page.document.getElementById('pickingPrintDialog').open,false);
  page.dom.window.close();
});

test('thẻ vị trí trong hộp chỉ định: tên vị trí đậm màu nổi bên trái, tổng SL bên phải, ghi chú thùng ở dòng dưới', async () => {
  const page = await renderPage();
  await openPopup(page);
  const card = page.document.querySelector('.picking-location.selected');
  assert.deepEqual([...card.children].map(el => el.tagName), ['STRONG', 'SPAN'], 'nút chọn chỉ còn vị trí và tổng SL');
  assert.equal(card.children[0].textContent, 'A07');
  assert.equal(card.children[0].getAttribute('title'), 'A07 · Kho chính to', 'tooltip kèm tên kho theo khu vực chính thức');
  assert.equal(card.parentElement.getAttribute('data-zone'), 'A');
  assert.equal(card.children[1].textContent, '200');
  const wrap = card.parentElement;
  assert.deepEqual([...wrap.children].map(el => el.className.split(' ')[0]), ['picking-location', 'picking-qty', 'picking-spec'], 'ghi chú thùng nằm dưới cùng thẻ, sau ô nhập SL');
  assert.equal(wrap.querySelector('.picking-spec').textContent, '4T x 50');
  assert.equal(wrap.querySelector('.picking-loc-st'), null, 'không còn dòng ST n trong thẻ');
  page.dom.window.close();
});

test('khu vực chính thức: CSS có màu cho đủ 12 ký tự HN (A B C F G P V X) và SG (H K L Q), sáng lẫn tối; D/E thử nghiệm đã bỏ', () => {
  const css = read(path.join(pickDir, 'pick-assign.css'));
  for (const z of 'ABCFGPVXHKLQ') {
    assert.ok(css.includes(`.picking-loc[data-zone="${z}"]{`), `thiếu màu tối khu ${z}`);
    assert.ok(css.includes(`:root[data-theme="light"] .picking-loc[data-zone="${z}"]{`), `thiếu màu sáng khu ${z}`);
  }
  assert.doesNotMatch(css, /data-zone="(D|E)"/);
});

test('CSS thẻ vị trí: lưới 2 dòng, ghi chú không còn chen lên trước tên vị trí', () => {
  const css = read(path.join(pickDir, 'pick-assign.css'));
  // Nội dung khai báo của luật CSS có đúng selector này (một dòng, không lồng).
  const rule = selector => { const at = css.indexOf(selector + '{'); return at < 0 ? '' : css.slice(at + selector.length + 1, css.indexOf('}', at)); };
  assert.match(rule('.picking-location'), /display:grid/);
  const name = rule('.picking-location strong');
  assert.match(name, /grid-column:1/);
  assert.match(name, /color:var\(--zone\)/, 'màu nổi theo khu');
  assert.match(name, /font-weight:(700|800)/);
  assert.match(name, /white-space:nowrap/);
  assert.match(rule('.picking-location span'), /grid-column:2/, 'tổng SL góc phải');
  assert.doesNotMatch(rule('.picking-loc'), /--zone:var\(--muted\)/, 'tên vị trí không xám khi không thuộc khu A–E');
  assert.match(rule('.picking-spec'), /display:block/, 'ghi chú thùng là dòng riêng dưới thẻ');
  assert.doesNotMatch(rule('.picking-location strong') + rule('.picking-location span'), /order:/, 'không dùng order: ghi chú (order mặc định 0) sẽ nhảy lên đầu');
});


test('order without pickable stock still enables assignment and printing', async () => {
  const page = await renderPage({store: newStore({candidates: {a: []}})});
  try {
    await openPopup(page);
    assert.equal(page.document.getElementById('pickingConfirm').disabled, false);
    page.dom.window.confirm = () => true;
    page.document.getElementById('pickingConfirm').click();
    await settle();
    assert.deepEqual(page.store.posted, [{branch:'HN',orderCode:'DH1',allocations:[],allowMismatch:true}]);
    assert.ok(page.document.getElementById('pickingPrintDialog').open);
  } finally {page.dom.window.close();}
});


test('after printing or cancelling the browser print dialog returns to the lifecycle list', async () => {
  for (const outcome of ['print', 'cancel']) {
    const page = await renderPage({store: newStore({assignment: makeAssignment('picking')})});
    try {
      await openPopup(page);
      await click(page, 'pickingReprint');
      page.document.getElementById('pickingPrintBtn').click();
      const frame = page.document.getElementById('pickingPrintFrame');
      const printWindow = frame.contentWindow;
      printWindow.focus = () => {};
      let opened = false;
      printWindow.print = () => {opened = true;};
      const onload = frame.onload;
      frame.onload = null;
      await onload();
      assert.ok(opened);
      printWindow.dispatchEvent(new printWindow.Event('afterprint'));
      assert.equal(page.document.getElementById('pickingPrintDialog').open, false, outcome);
      assert.equal(page.document.getElementById('pickingDialog').open, false, outcome);
      assert.equal(page.document.getElementById('lcDetailOverlay').hidden, true, outcome);
    } finally {page.dom.window.close();}
  }
});


test('sort lựa chọn theo chữ/số/vị trí, giữ phân bổ và in cả hai mẫu theo thứ tự đang chọn', async () => {
  const ls=[{productCode:'B',productName:'Bình',note:'Z',quantity:20,price:1000},{productCode:'A',productName:'Ấm',note:'A',quantity:100,price:1000},{productCode:'C',productName:'Chén',note:'M',quantity:3,price:1000}];
  const locations=['A10','A2','B1'];
  const jobs=ls.map((l,i)=>({productCode:l.productCode,positionId:i+11,location:locations[i],plannedQty:l.quantity,stCartons:l.quantity,stText:l.quantity+'Tx1'}));
  const store=newStore();store.order.lines=ls;
  store.candidates=Object.fromEntries(ls.map((l,i)=>[l.productCode.toLowerCase(),[position(i+11,locations[i],'200T x 1',200,{code:l.productCode})]]));
  store.assignment=makeAssignment('picking',{snapshot:{lines:ls},lines:jobs});
  const page=await renderPage({store});
  try{
    await openPopup(page);
    const d=page.document,w=page.window;
    const sort=async key=>{const button=d.querySelector('.picking-table th[data-column-key="'+key+'"] button');assert.ok(button,'có nút sort '+key);button.click();await settle();};
    const codes=()=>[...d.querySelectorAll('#pickingRows tr')].map(r=>r.cells[0].querySelector('.picking-code-text').textContent);
    const allocated=JSON.stringify(w.TKSPick._state.allocations);
    await sort('need');assert.deepEqual(codes(),['C','B','A']);
    await sort('need');assert.deepEqual(codes(),['A','B','C']);
    assert.equal(d.querySelector('.picking-table th[data-column-key="need"]').getAttribute('aria-sort'),'descending');
    await sort('locations');assert.deepEqual(codes(),['A','B','C']);
    await sort('name');assert.deepEqual(codes(),['A','B','C']);
    await sort('note');assert.deepEqual(codes(),['A','C','B']);
    await sort('st');assert.deepEqual(codes(),['C','B','A']);
    await sort('stock');assert.deepEqual(codes(),['B','A','C'],'giá trị bằng nhau giữ thứ tự gốc');
    await sort('code');assert.deepEqual(codes(),['A','B','C']);
    await sort('code');assert.deepEqual(codes(),['C','B','A']);
    assert.equal(JSON.stringify(w.TKSPick._state.allocations),allocated);
    assert.equal(d.getElementById('pickingReprint').disabled,false,'sort không làm bẩn chỉ định');
    const input=d.querySelector('#pickingRows tr:first-child [data-qty]');assert.equal(input.dataset.qline,'2');
    await click(page,'pickingReprint');
    const printed=()=>[...d.querySelectorAll('.invoice-goods tbody tr')].map(r=>r.cells[1].textContent.trim());
    assert.deepEqual(printed(),['Bình','Ấm','Chén'],'phiếu in giữ thứ tự Kiot dù hộp đang sort');
    assert.deepEqual([...d.querySelectorAll('.invoice-goods tbody tr')].map(r=>r.cells[0].textContent.trim()),['1','2','3']);
    await w.PickingInvoice.changeTemplate('delivery');assert.deepEqual(printed(),['Bình','Ấm','Chén']);
    assert.deepEqual(store.assignment.snapshot.lines.map(l=>l.productCode),['B','A','C']);
    input.value='2';input.dispatchEvent(new w.Event('change',{bubbles:true}));await settle();
    assert.equal(w.TKSPick._state.allocations[2][0].quantity,2,'sửa hàng đã sort vẫn trỏ đúng mã C');
    assert.equal(w.TKSPick._state.allocations[0][0].quantity,20);
    assert.deepEqual(codes(),['C','B','A'],'render sau khi sửa vẫn giữ sort');
    await w.TKSPick.open(store.order);assert.deepEqual(codes(),['B','A','C'],'mở đơn bắt đầu theo thứ tự gốc');
  }finally{page.dom.window.close();}
});


test('Xác nhận & In giữ thứ tự Kiot dù hộp đang sort',async()=>{
  const ls=[{productCode:'B',productName:'Bình',quantity:20,price:1000},{productCode:'A',productName:'Ấm',quantity:100,price:1000}];
  const store=newStore();store.order.lines=ls;
  store.candidates={b:[position(12,'B1','20T x 1',20,{code:'B'})],a:[position(11,'A1','100T x 1',100)]};
  const page=await renderPage({store,fetchImpl:async(url,options)=>{
    if(url==='/api/shipment/pick'&&options.method==='POST'){
      store.posted.push(JSON.parse(options.body));
      return json({assignment:makeAssignment('picking',{snapshot:{lines:ls},lines:[{productCode:'B',positionId:12,location:'B1',plannedQty:20,stCartons:20,stText:'20Tx1'},{productCode:'A',positionId:11,location:'A1',plannedQty:100,stCartons:100,stText:'100Tx1'}]})},201);
    }
  }});
  try{
    await openPopup(page);
    page.document.querySelector('.picking-table th[data-column-key="code"] button').click();
    await click(page,'pickingConfirm');
    assert.equal(store.posted.length,1);
    assert.deepEqual(store.posted[0].allocations.map(p=>[p.productCode,p.qty]),[['B',20],['A',100]]);
    assert.deepEqual([...page.document.querySelectorAll('.invoice-goods tbody tr')].map(r=>r.cells[1].textContent.trim()),['Bình','Ấm']);
  }finally{page.dom.window.close();}
});


test('kéo-thả đổi thứ tự dòng: bảng và phiếu in theo thứ tự mới, phân bổ không đổi, đổi sort hoặc mở lại thì về Kiot', async () => {
  const ls=[{productCode:'B',productName:'Bình',quantity:20,price:1000},{productCode:'A',productName:'Ấm',quantity:100,price:1000},{productCode:'C',productName:'Chén',quantity:3,price:1000}];
  const locations=['A10','A2','B1'];
  const jobs=ls.map((l,i)=>({productCode:l.productCode,positionId:i+11,location:locations[i],plannedQty:l.quantity,stCartons:l.quantity,stText:l.quantity+'Tx1'}));
  const store=newStore();store.order.lines=ls;
  store.candidates=Object.fromEntries(ls.map((l,i)=>[l.productCode.toLowerCase(),[position(i+11,locations[i],'200T x 1',200,{code:l.productCode})]]));
  store.assignment=makeAssignment('picking',{snapshot:{lines:ls},lines:jobs});
  const page=await renderPage({store});
  try{
    await openPopup(page);
    const d=page.document,w=page.window;
    const codes=()=>[...d.querySelectorAll('#pickingRows tr')].map(r=>r.querySelector('.picking-code-text').textContent);
    assert.equal(d.querySelectorAll('#pickingRows .picking-grip').length,3,'mỗi dòng có tay nắm kéo');
    const allocated=JSON.stringify(w.TKSPick._state.allocations);
    assert.equal(w.TKSPick._moveLine('C','B',false),true);   // dưới lên trên
    assert.deepEqual(codes(),['C','B','A']);
    assert.equal(w.TKSPick._moveLine('C','A',true),true);    // trên xuống dưới
    assert.deepEqual(codes(),['B','A','C']);
    assert.equal(w.TKSPick._moveLine('A','A',true),false,'thả lên chính nó không đổi');
    assert.equal(w.TKSPick._moveLine('B','A',false),false,'thả đúng chỗ cũ không đổi');
    assert.equal(w.TKSPick._moveLine('A','B',false),true);
    assert.deepEqual(codes(),['A','B','C']);
    assert.equal(JSON.stringify(w.TKSPick._state.allocations),allocated,'đổi thứ tự không đụng phân bổ');
    // Sửa số lượng ở dòng đã kéo vẫn trỏ đúng mã.
    const input=d.querySelector('#pickingRows tr:first-child [data-qty]');assert.equal(input.dataset.qline,'1');
    await click(page,'pickingReprint');
    const printed=()=>[...d.querySelectorAll('.invoice-goods tbody tr')].map(r=>r.cells[1].textContent.trim());
    assert.deepEqual(printed(),['Ấm','Bình','Chén'],'phiếu in theo thứ tự đã kéo');
    assert.deepEqual([...d.querySelectorAll('.invoice-goods tbody tr')].map(r=>r.cells[0].textContent.trim()),['1','2','3']);
    assert.deepEqual(store.assignment.snapshot.lines.map(l=>l.productCode),['B','A','C'],'bản chỉ định lưu trên máy chủ giữ thứ tự Kiot');
    // Bấm sort cột thì bỏ thứ tự kéo-thả.
    d.getElementById('pickingPrintClose').click();
    d.querySelector('.picking-table th[data-column-key="code"] button').click();await settle();
    assert.equal(w.TKSPick._state.manual,null);assert.deepEqual(codes(),['A','B','C']);
    assert.equal(w.TKSPick._moveLine('C','A',false),true);
    await w.TKSPick.open(store.order);assert.deepEqual(codes(),['B','A','C'],'mở lại về thứ tự Kiot');
  }finally{page.dom.window.close();}
});

test('Xóa dòng hàng: hỏi xác nhận, POST order-lines/remove, tải lại đơn, đơn còn một mã thì không có nút Xóa', async () => {
  const ls=[{productCode:'A',productName:'Ấm',quantity:100,price:1000},{productCode:'B',productName:'Bình',quantity:20,price:1000}];
  const store=newStore();store.order.lines=ls;store.assignment=null;
  store.candidates={a:[position(11,'A1','100T x 1',100)],b:[position(12,'B1','20T x 1',20,{code:'B'})]};
  const removed=[];
  const page=await renderPage({store,fetchImpl:async(url,options)=>{
    if(url==='/api/shipment/pick/order-lines/remove'){
      removed.push(JSON.parse(options.body));
      if(store.removeError)return json(store.removeError,422);
      store.order.lines=store.order.lines.filter(l=>l.productCode!==removed.at(-1).productCode);
      return json({changed:true,assignment:null});
    }
  }});
  try{
    await openPopup(page);
    const d=page.document,w=page.window;
    const codes=()=>[...d.querySelectorAll('#pickingRows tr')].map(r=>r.querySelector('.picking-code-text').textContent);
    assert.equal(d.querySelectorAll('[data-remove-line]').length,2);
    let asked='';w.confirm=message=>{asked=message;return false;};
    d.querySelector('[data-remove-line="0"]').click();await settle();
    assert.equal(removed.length,0,'không đồng ý thì không gọi máy chủ');
    assert.match(asked,/KiotViet[\s\S]*A · Ấm[\s\S]*KHÔNG hoàn tác/u);
    // Kiot từ chối: giữ nguyên bảng, báo lỗi.
    store.removeError={error:'KiotViet không cho sửa đơn này: Đơn đã hoàn thành',code:'KIOT_REJECTED'};
    w.confirm=()=>true;
    d.querySelector('[data-remove-line="0"]').click();await settle();
    assert.deepEqual(codes(),['A','B']);
    assert.match(text(page,'pickingStatus'),/Đơn đã hoàn thành/u);
    assert.equal(d.getElementById('pickingStatus').dataset.error,'true');
    // Thành công.
    store.removeError=null;
    d.querySelector('[data-remove-line="0"]').click();await settle();
    assert.deepEqual(removed.map(r=>[r.branch,r.orderCode,r.productCode]).at(-1),['HN','DH1','A']);
    assert.deepEqual(codes(),['B']);
    assert.match(text(page,'pickingStatus'),/Đã xóa A khỏi đơn KiotViet/u);
    assert.equal(d.querySelectorAll('[data-remove-line]').length,0,'đơn còn một mã hàng không xóa được nữa');
  }finally{page.dom.window.close();}
});


test('chỉ định hiển thị lượng có thể bốc sau giữ chỗ của đơn khác thay vì tồn vị trí', async () => {
  const store = newStore();
  store.order.lines[0].quantity = 30;
  store.candidates = { a: [position(11, 'A07', '2T x 50', 40, { onHand: 100, held: 60 })] };
  const page = await renderPage({ store });
  try {
    await openPopup(page);
    const document = page.document;
    assert.equal(document.querySelector('.picking-total strong').textContent, '40');
    assert.equal(document.querySelector('[data-location="11"] span').textContent, '40');
    assert.equal(document.querySelector('.picking-pickable').textContent, 'Còn sau chỉ định: 10');
  } finally {
    page.dom.window.close();
  }
});


test('Đã bốc: phân bổ đủ không báo thiếu khi tồn vị trí đã giảm hoặc vị trí không còn', async () => {
  for (const candidates of [
    { a: [position(11, 'A07', '1T x 50', 50)] },
    { a: [] }
  ]) {
    const store = newStore({ assignment: makeAssignment('confirmed'), candidates });
    const page = await renderPage({ store });
    try {
      await openPopup(page);
      const allocation = page.document.querySelector('.picking-allocation');
      assert.ok(allocation.classList.contains('picking-good'));
      assert.equal(page.document.getElementById('pickingProgress').textContent, '1/1 mã hàng đã phân bổ đủ');
    } finally {
      page.dom.window.close();
    }
  }
});

test('Đã bốc: phân bổ lưu thiếu so với cần nhặt vẫn báo đỏ', async () => {
  const assignment = makeAssignment('confirmed');
  assignment.lines[0].plannedQty = 80;
  assignment.lines[0].pickedQty = 80;
  const page = await renderPage({ store: newStore({ assignment }) });
  try {
    await openPopup(page);
    assert.ok(page.document.querySelector('.picking-allocation').classList.contains('picking-bad'));
    assert.ok(page.document.querySelector('[data-line="0"]').classList.contains('picking-mismatch'));
  } finally {
    page.dom.window.close();
  }
});
