'use strict';

// Sua VT ngay trong hop Chi dinh vi tri (public/shipment/lifecycle/pick/pick-assign.js): nut sua/xoa/them vi tri theo quyen
// canEditPositions, xem truoc ghi chu so thung, PATCH/POST/DELETE /api/shipment/pick/positions, chi goi y lai ma vua sua,
// xu ly loi (WOULD_AUTO_DELETE, BELOW_HELD, VERSION_CONFLICT, loi mang), don Dang nhat sua vi tri cua chinh don -> chua luu.
// Chay trang Vong doi THAT trong JSDOM voi fetch gia (harness nhu lifecycle-pick.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const { lifecycleResponse, isListUrl } = require('./lifecycleFakeServer');
const carton = require('../../public/shared/carton.js');

const publicDir = path.join(__dirname, '..', '..', 'public');
const pickDir = path.join(publicDir, 'shipment', 'lifecycle', 'pick');
const html = fs.readFileSync(path.join(publicDir, 'shipment', 'lifecycle', 'index.html'), 'utf8');
const read = file => fs.readFileSync(file, 'utf8');

const settle = async () => { for (let i = 0; i < 16; i++) await new Promise(resolve => setImmediate(resolve)); };
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
    lines: [{ productCode: 'A', productName: 'Hàng A', quantity: 100, price: 1000, discount: 0, amount: 100000, isService: false, onHand: 200, inTransit: 0, sellableQty: 100, sellableAmount: 100000, measure: { status: 'ok', m3: 1, kg: 10, cartons: 2 } }],
    freight: { unavailable: true, message: 'Không tính được' }
  };
}

const position = (id, code, location, notes, extra = {}) => {
  const qty = carton.parseSpec(notes)?.quantity ?? null;
  const held = extra.held || 0;
  return { positionId: id, code, name: 'Hàng ' + code, location, notes, version: 1, onHand: qty, held, available: qty === null ? null : Math.max(0, qty - held), warnings: carton.warnings(notes), ...extra };
};

function makeAssignment(status, extra = {}) {
  return {
    id: 7, branch: 'HN', orderCode: 'DH1', status, version: 1, assignedByName: 'Quản lý A', assignedAt: '2026-10-27T03:00:00.000Z',
    snapshot: { customerName: 'KH A', saleName: 'Sale A', orderDate: '01/10/2026 13:14', lines: [{ productCode: 'A', productName: 'Hàng A', quantity: 100, price: 1000, discount: 0 }], invoiceDiscount: 0, priorDebt: 0 },
    lines: [{ id: 1, productCode: 'A', positionId: 11, location: 'A07', plannedQty: 100, reservedQty: status === 'picking' ? 100 : 0, stCartons: 2, stText: '2Tx50', pickedQty: status === 'confirmed' ? 100 : null, specBefore: '4T x 50', specAfter: status === 'confirmed' ? '2T x 50' : null }],
    history: [], ...extra
  };
}

// Don 2 ma: A can 100 (A07 4T x 50, B02 2T x 25), B can 30 (C01 2T x 20, C02 1T x 30).
function newStore(extra = {}) {
  return {
    order: {
      branch: 'HN', orderCode: 'DH1', customerName: 'KH A', saleName: 'Sale A', orderDate: '01/10/2026 13:14', status: { code: 'SENT_TO_ACCOUNTANT', label: 'Đã gửi kế toán' }, eligible: true,
      lines: [{ productCode: 'A', productName: 'Hàng A', quantity: 100, price: 1000, discount: 0 }, { productCode: 'B', productName: 'Hàng B', quantity: 30, price: 1000, discount: 0 }]
    },
    candidates: {
      a: [position(11, 'A', 'A07', '4T x 50'), position(12, 'A', 'B02', '2T x 25')],
      b: [position(21, 'B', 'C01', '2T x 20'), position(22, 'B', 'C02', '1T x 30')]
    },
    canEditPositions: true, assignment: null, posted: [], posCalls: [], posQueue: [], candidateCalls: 0, nextId: 99,
    ...extra
  };
}
const oneLine = store => { store.order.lines = store.order.lines.slice(0, 1); delete store.candidates.b; return store; };

const shapeRow = c => ({ id: c.positionId, code: c.code, location: c.location, notes: c.notes, version: c.version, quantity: c.onHand, held: c.held, available: c.available });
function setNotes(c, notes) {
  const qty = carton.parseSpec(notes)?.quantity ?? null;
  Object.assign(c, { notes, version: c.version + 1, onHand: qty, available: qty === null ? null : Math.max(0, qty - c.held), warnings: carton.warnings(notes) });
}

// API gia /api/shipment/pick/positions: gop ghi chu khi trung vi tri, ve 0 thi doi confirmEmpty roi xoa; posQueue = phan hoi ep cho lan goi ke tiep.
function positionsApi(store, u, options) {
  const method = options.method || 'GET';
  const body = options.body ? JSON.parse(options.body) : null;
  store.posCalls.push({ method, url: u.pathname + u.search, body });
  if (store.posQueue.length) { const next = store.posQueue.shift(); if (next instanceof Error) throw next; return json(next.body, next.status); }
  const all = Object.values(store.candidates).flat();
  const id = Number((u.pathname.match(/\/positions\/(\d+)$/) || [])[1]);
  const drop = target => { for (const key of Object.keys(store.candidates)) store.candidates[key] = store.candidates[key].filter(c => c !== target); };
  if (method === 'POST') {
    const list = store.candidates[body.productCode.toLowerCase()] || (store.candidates[body.productCode.toLowerCase()] = []);
    const same = list.find(c => c.location === body.location);
    if (same) { setNotes(same, carton.mergeNotes(same.notes, body.notes)); return json({ row: shapeRow(same), merged: true }); }
    const created = position(store.nextId++, body.productCode, body.location, body.notes);
    list.push(created);
    return json({ row: shapeRow(created), merged: false }, 201);
  }
  const target = all.find(c => c.positionId === id);
  if (!target) return json({ error: 'Không tìm thấy vị trí.', code: 'NOT_FOUND' }, 404);
  if (method === 'DELETE') { drop(target); return json({ deleted: true, id }); }
  const qty = carton.parseSpec(body.notes)?.quantity;
  if (qty === 0 && !body.confirmEmpty) return json({ error: 'Số lượng về 0 sẽ xóa vị trí.', code: 'WOULD_AUTO_DELETE' }, 409);
  if (qty === 0) { drop(target); return json({ deleted: true, id }); }
  setNotes(target, body.notes);
  return json({ row: shapeRow(target) });
}

async function renderPage({ orders = [orderRow('DH1')], store = newStore(), permissions = ['shipment.lifecycle', 'shipment.pick'] } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/shipment/lifecycle/' });
  const { window } = dom;
  const calls = [];
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
    const u = new URL(href, 'https://tokosi.example');
    if (isListUrl(href)) return json(lifecycleResponse(href, orders, { ok: true, stale: false, fetchedAt: null, count: 0 }));
    if (u.pathname === '/api/shipment/lifecycle/order-detail') return json({ detail: kiotDetail(u.searchParams.get('code')) });
    if (u.pathname === '/api/shipment/pick/candidates') {
      store.candidateCalls++;
      return json(JSON.parse(JSON.stringify({ order: store.order, candidates: store.candidates, assignment: store.assignment, canEditPositions: store.canEditPositions })));
    }
    if (u.pathname.startsWith('/api/shipment/pick/positions')) return positionsApi(store, u, options);
    if (u.pathname === '/api/shipment/pick' && (options.method || 'GET') === 'GET') return json({ assignment: store.assignment });
    if (u.pathname === '/api/shipment/pick' && options.method === 'POST') {
      store.posted.push(JSON.parse(options.body));
      store.assignment = makeAssignment('picking', { version: (store.assignment?.version || 0) + 1 });
      return json({ assignment: store.assignment }, 201);
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
  window.confirm = () => true;
  window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(read(path.join(publicDir, 'shared/table-controls.js')));
  ['shared/carton.js', 'shared/pick-rules.js', 'shipment/lifecycle/pick/invoice.js', 'shipment/lifecycle/pick/print-tools.js', 'shipment/lifecycle/pick/pick-assign.js']
    .forEach(file => window.eval(read(path.join(publicDir, file))));
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]).forEach(script => window.eval(script));
  await settle();
  return { dom, window, document: window.document, calls, store };
}

const openPopup = async page => {
  page.document.querySelector('#bulkBody tr').click(); await settle();
  page.document.getElementById('openPickingBtn').click(); await settle();
};
const $ = (page, selector) => page.document.querySelector(selector);
const text = (page, id) => page.document.getElementById(id).textContent;
const qty = (page, id) => $(page, `[data-qty][data-qloc="${id}"]`).value;
const click = async (page, selector) => { $(page, selector).click(); await settle(); };
const type = (page, field, value) => {
  const input = $(page, `[data-pos-editor] [data-pos-input="${field}"]`);
  input.value = value;
  input.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  return input;
};
const preview = page => $(page, '[data-pos-editor] [data-pos-preview]').textContent;
const saveBtn = page => $(page, '[data-pos-editor] [data-pos-save]');
const setPick = (page, id, value) => {
  const input = $(page, `[data-qty][data-qloc="${id}"]`);
  input.value = value;
  input.dispatchEvent(new page.window.Event('change', { bubbles: true }));
};

// ---------------------------------------------------------------------------

test('nút ✎/🗑/+ Thêm vị trí chỉ hiện khi máy chủ gửi canEditPositions; Đã bốc thì ẩn; không phụ thuộc đơn đủ điều kiện', async () => {
  const without = await renderPage({ store: newStore({ canEditPositions: false }) });
  try {
    await openPopup(without);
    assert.equal(without.document.querySelectorAll('[data-pos-edit],[data-pos-delete],[data-pos-add]').length, 0, 'không quyền sửa VT: không nút');
    assert.equal($(without, '[data-qty][data-qloc="11"]').value, '100', 'hộp vẫn hoạt động như cũ');
  } finally { without.dom.window.close(); }

  const page = await renderPage();
  try {
    await openPopup(page);
    assert.equal(page.document.querySelectorAll('[data-pos-edit]').length, 4, 'mỗi thẻ vị trí một nút ✎');
    assert.equal(page.document.querySelectorAll('[data-pos-delete]').length, 4);
    assert.equal(page.document.querySelectorAll('[data-pos-add]').length, 2, 'mỗi dòng mã hàng một nút + Thêm vị trí');
    assert.match($(page, '#pickingDialog .dp-subtitle').textContent, /✎ \/ 🗑 \/ \+ Thêm vị trí/);
  } finally { page.dom.window.close(); }

  const confirmed = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'confirmed' })], store: oneLine(newStore({ assignment: makeAssignment('confirmed') })) });
  try {
    await openPopup(confirmed);
    assert.equal(confirmed.document.querySelectorAll('[data-pos-edit],[data-pos-delete],[data-pos-add]').length, 0, 'Đã bốc chỉ xem');
  } finally { confirmed.dom.window.close(); }

  const store = newStore();
  store.order.eligible = false;
  store.candidates.b = [];
  const ineligible = await renderPage({ store });
  try {
    await openPopup(ineligible);
    assert.ok($(ineligible, '[data-pos-edit][data-pos-id="11"]'), 'đơn chưa đủ điều kiện vẫn sửa được VT');
    const empty = ineligible.document.querySelectorAll('#pickingRows tr')[1];
    assert.match(empty.textContent, /Chưa tìm thấy vị trí của mã này\./);
    assert.ok(empty.querySelector('[data-pos-add]'), 'mã chưa có vị trí vẫn có nút + Thêm vị trí');
  } finally { ineligible.dom.window.close(); }
});

test('✎ sửa ghi chú: xem trước SL, PATCH đúng body; chỉ mã đó được gợi ý lại, mã khác giữ phân bổ tay', async () => {
  const page = await renderPage();
  try {
    await openPopup(page);
    // Mã B: người dùng chọn tay C01 x 30 thay cho gợi ý C02.
    setPick(page, 22, '0');
    setPick(page, 21, '30');
    await settle();
    assert.equal(qty(page, 21), '30');
    assert.equal(qty(page, 11), '100');
    await click(page, '[data-pos-edit][data-pos-id="11"]');
    assert.ok($(page, '[data-pos-editor][data-pos-id="11"]'), 'thẻ A07 thành ô sửa');
    assert.equal($(page, '[data-pos-input="notes"]').value, '4T x 50', 'giá trị ban đầu = ghi chú hiện tại');
    const input = type(page, 'notes', '1t x 50');
    assert.equal(preview(page), '= 50 chiếc · 1 thùng');
    assert.equal(saveBtn(page).disabled, false);
    assert.equal(page.document.activeElement, input, 'gõ không vẽ lại bảng, giữ con trỏ');
    const before = page.store.candidateCalls;
    await click(page, '[data-pos-save]');
    assert.deepEqual(page.store.posCalls.map(c => [c.method, c.url, c.body]), [['PATCH', '/api/shipment/pick/positions/11', { branch: 'HN', orderCode: 'DH1', notes: '1T x 50', version: 1 }]]);
    assert.equal(page.store.candidateCalls, before + 1, 'tải lại tồn một lần');
    assert.equal($(page, '[data-pos-editor]'), null, 'đóng ô sửa');
    assert.equal(text(page, 'pickingStatus'), 'Đã lưu VT A07: 1T x 50.');
    // A gợi ý lại theo tồn mới: A07 còn 50 → thêm B02 50; B giữ nguyên C01 x 30 chọn tay.
    assert.deepEqual([qty(page, 11), qty(page, 12)], ['50', '50']);
    assert.deepEqual([qty(page, 21), qty(page, 22)], ['30', '0']);
    assert.equal($(page, '[data-pos-edit][data-pos-id="11"]').closest('.picking-loc').querySelector('.picking-location span').textContent, '50');
  } finally { page.dom.window.close(); }
});

test('gõ "+1T x 50" = cộng thêm bằng mergeNotes: xem trước ghi chú gộp, gửi ghi chú đã gộp; phần cộng sai định dạng khóa Lưu', async () => {
  const page = await renderPage();
  try {
    await openPopup(page);
    assert.equal(typeof page.window.PickingCarton.mergeNotes, 'function');
    await click(page, '[data-pos-edit][data-pos-id="11"]');
    type(page, 'notes', '+abc');
    assert.match(preview(page), /sai định dạng/);
    assert.equal(saveBtn(page).disabled, true);
    type(page, 'notes', '+1T x 50');
    assert.equal(preview(page), 'Sau khi cộng: 5T x 50 = 250 chiếc · 5 thùng');
    assert.equal(saveBtn(page).disabled, false);
    await click(page, '[data-pos-save]');
    assert.equal(page.store.posCalls[0].body.notes, '5T x 50');
    assert.equal(page.store.candidates.a[0].notes, '5T x 50');
  } finally { page.dom.window.close(); }
});

test('về 0: xem trước báo sẽ xóa, máy chủ 409 WOULD_AUTO_DELETE → hỏi rồi gửi lại confirmEmpty; từ chối thì giữ ô sửa', async () => {
  const page = await renderPage();
  try {
    await openPopup(page);
    await click(page, '[data-pos-edit][data-pos-id="12"]');
    type(page, 'notes', '0');
    assert.match(preview(page), /0 → vị trí sẽ bị xóa/, 'gõ "0" = hết hàng, không phải sai định dạng');
    type(page, 'notes', '');
    assert.match(preview(page), /0 → vị trí sẽ bị xóa/);
    const asked = [];
    page.window.confirm = message => { asked.push(message); return false; };
    await click(page, '[data-pos-save]');
    assert.equal(page.store.posCalls.length, 1);
    assert.match(asked[0], /B02 của mã A sẽ bị XÓA khỏi VT/);
    assert.ok($(page, '[data-pos-editor][data-pos-id="12"]'), 'từ chối: ô sửa vẫn mở');
    page.window.confirm = message => { asked.push(message); return true; };
    await click(page, '[data-pos-save]');
    assert.deepEqual(page.store.posCalls.map(c => c.body.confirmEmpty), [undefined, undefined, true]);
    assert.equal($(page, '[data-location="12"]'), null, 'vị trí đã bị xóa khỏi hộp');
    assert.equal(text(page, 'pickingStatus'), 'Đã xóa vị trí B02 của mã A khỏi VT.');
  } finally { page.dom.window.close(); }
});

test('đơn khác giữ chỗ: hạ dưới phần giữ bị khóa ở máy khách, 🗑 khóa; máy chủ BELOW_HELD giữ ô sửa kèm lỗi, không tải lại', async () => {
  const store = newStore();
  store.candidates.a[1] = position(12, 'A', 'B02', '2T x 25', { held: 30 });
  const page = await renderPage({ store });
  try {
    await openPopup(page);
    const del = $(page, '[data-pos-delete][data-pos-id="12"]');
    assert.equal(del.disabled, true);
    assert.match(del.title, /đang giữ 30/);
    await click(page, '[data-pos-edit][data-pos-id="12"]');
    type(page, 'notes', '1T x 25');
    assert.match(preview(page), /không hạ dưới 30/);
    assert.equal(saveBtn(page).disabled, true);
    page.document.querySelector('[data-pos-input="notes"]').dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    assert.equal(store.posCalls.length, 0, 'Enter cũng không gửi khi bị khóa');

    await click(page, '[data-pos-cancel]');
    await click(page, '[data-pos-edit][data-pos-id="11"]');
    type(page, 'notes', '1T x 50');
    store.posQueue.push({ status: 409, body: { error: 'Đơn DH9 đang giữ 120 tại vị trí này, không hạ dưới 120.', code: 'BELOW_HELD', orders: ['DH9'], held: 120 } });
    const before = store.candidateCalls;
    await click(page, '[data-pos-save]');
    assert.ok($(page, '[data-pos-editor][data-pos-id="11"]'), 'ô sửa vẫn mở');
    assert.equal($(page, '[data-pos-input="notes"]').value, '1T x 50', 'giữ nội dung đang gõ');
    assert.match($(page, '[data-pos-error]').textContent, /DH9 đang giữ 120/);
    assert.equal(page.document.getElementById('pickingStatus').dataset.error, 'true');
    assert.equal(store.candidateCalls, before, 'không tải lại');
  } finally { page.dom.window.close(); }
});

test('VERSION_CONFLICT: đóng ô sửa và tải lại; lỗi mạng: đóng ô sửa, tải lại, không tự gửi lại', async () => {
  const page = await renderPage();
  try {
    await openPopup(page);
    await click(page, '[data-pos-edit][data-pos-id="11"]');
    type(page, 'notes', '3T x 50');
    page.store.posQueue.push({ status: 409, body: { error: 'Vị trí vừa được người khác sửa.', code: 'VERSION_CONFLICT' } });
    let before = page.store.candidateCalls;
    await click(page, '[data-pos-save]');
    assert.equal($(page, '[data-pos-editor]'), null);
    assert.equal(page.store.candidateCalls, before + 1);
    assert.match(text(page, 'pickingStatus'), /người khác sửa.*Đã tải lại/);

    await click(page, '[data-pos-edit][data-pos-id="11"]');
    type(page, 'notes', '3T x 50');
    page.store.posQueue.push(new Error('mất mạng'));
    before = page.store.candidateCalls;
    await click(page, '[data-pos-save]');
    assert.equal(page.store.posCalls.length, 2, 'không gửi lại lần ghi');
    assert.equal($(page, '[data-pos-editor]'), null);
    assert.equal(page.store.candidateCalls, before + 1);
    assert.match(text(page, 'pickingStatus'), /Chưa xác định được kết quả/);

    // Mất quyền sửa VT: đóng ô sửa, ẩn nút, báo lỗi, không tải lại.
    await click(page, '[data-pos-edit][data-pos-id="11"]');
    type(page, 'notes', '3T x 50');
    page.store.posQueue.push({ status: 403, body: { error: 'Không có quyền sửa VT.', code: 'FEATURE_FORBIDDEN' } });
    before = page.store.candidateCalls;
    await click(page, '[data-pos-save]');
    assert.equal($(page, '[data-pos-editor]'), null);
    assert.equal(page.document.querySelectorAll('[data-pos-edit],[data-pos-add]').length, 0);
    assert.equal(text(page, 'pickingStatus'), 'Không có quyền sửa VT.');
    assert.equal(page.store.candidateCalls, before);
  } finally { page.dom.window.close(); }
});

test('Đang nhặt sửa vị trí chính đơn đang giữ: báo trước, sau khi lưu hộp "chưa lưu" (khóa Xác nhận nhặt/In đơn) tới khi Cập nhật chỉ định', async () => {
  const store = oneLine(newStore({ assignment: makeAssignment('picking') }));
  const page = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store });
  try {
    await openPopup(page);
    const { document } = page;
    assert.equal(document.getElementById('pickingConfirmPick').disabled, false);
    await click(page, '[data-pos-edit][data-pos-id="11"]');
    assert.match($(page, '[data-pos-hint]').textContent, /đang giữ chỗ cho đơn này: sau khi lưu cần bấm “Cập nhật chỉ định & In phiếu”/);
    type(page, 'notes', '3T x 50');
    await click(page, '[data-pos-save]');
    assert.equal(store.posCalls[0].body.orderCode, 'DH1');
    assert.equal(qty(page, 11), '100', 'phân bổ vẫn 100 tại A07');
    assert.equal(document.getElementById('pickingConfirmPick').disabled, true, 'phải lưu lại chỉ định trước khi Xác nhận nhặt');
    assert.equal(document.getElementById('pickingReprint').disabled, true);
    assert.equal(text(page, 'pickingConfirm'), 'Cập nhật chỉ định & In phiếu');
    assert.equal(document.getElementById('pickingConfirm').disabled, false);
    assert.match(text(page, 'pickingSource'), /vừa được sửa trên VT/);
    // Sửa vị trí không thuộc chỉ định (B02) thì không ép "chưa lưu".
    const fresh = await renderPage({ orders: [orderRow('DH1', { pickStatus: 'picking' })], store: oneLine(newStore({ assignment: makeAssignment('picking') })) });
    try {
      await openPopup(fresh);
      await click(fresh, '[data-pos-edit][data-pos-id="12"]');
      assert.equal($(fresh, '[data-pos-hint]').textContent, '');
      type(fresh, 'notes', '3T x 25');
      await click(fresh, '[data-pos-save]');
      assert.equal(fresh.document.getElementById('pickingConfirmPick').disabled, false);
    } finally { fresh.dom.window.close(); }
    // Lưu chỉ định (reassign) thì hết trạng thái chưa lưu.
    await click(page, '#pickingConfirm');
    assert.equal(store.posted.length, 1);
    assert.equal(store.posted[0].reassign, true);
    assert.equal(page.window.TKSPick._state.touched.size, 0);
  } finally { page.dom.window.close(); }
});

test('+ Thêm vị trí: chuẩn hóa vị trí, hiện tên khu và báo sẽ cộng vào vị trí sẵn có; Enter gửi POST; trùng thì máy chủ gộp', async () => {
  const page = await renderPage();
  try {
    await openPopup(page);
    await click(page, '#pickingRows tr[data-line="0"] [data-pos-add]');
    assert.ok($(page, '[data-pos-editor][data-pos-id="new"]'));
    assert.equal(page.document.activeElement, $(page, '[data-pos-input="location"]'), 'con trỏ ở ô Vị trí');
    assert.equal(saveBtn(page).disabled, true, 'chưa có vị trí');
    type(page, 'location', 'a 07');
    assert.equal($(page, '[data-pos-hint]').textContent, 'Kho chính to · Sẽ cộng vào vị trí A07 sẵn có');
    const notes = type(page, 'notes', '1T x 50');
    assert.equal(preview(page), '= 50 chiếc · 1 thùng');
    notes.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(page.store.posCalls[0], { method: 'POST', url: '/api/shipment/pick/positions', body: { branch: 'HN', orderCode: 'DH1', productCode: 'A', location: 'A07', notes: '1T x 50' } });
    assert.equal(text(page, 'pickingStatus'), 'Đã cộng vào vị trí A07 sẵn có: 5T x 50.');

    await click(page, '#pickingRows tr[data-line="0"] [data-pos-add]');
    type(page, 'location', 'c09');
    assert.equal($(page, '[data-pos-hint]').textContent, 'Sân sau chính');
    type(page, 'notes', 'Hết hàng');
    assert.equal(saveBtn(page).disabled, true, 'thêm mới phải có SL > 0');
    type(page, 'notes', '2 thùng');
    assert.match(preview(page), /sai định dạng/);
    assert.equal(saveBtn(page).disabled, true, 'thêm mới sai định dạng thì khóa');
    type(page, 'notes', '2T x 50');
    await click(page, '[data-pos-save]');
    assert.equal(page.store.posCalls[1].body.location, 'C09');
    assert.ok($(page, '[data-location="99"]'), 'vị trí mới hiện trong hộp');
    assert.equal(text(page, 'pickingStatus'), 'Đã thêm vị trí C09 cho mã A: 2T x 50.');
  } finally { page.dom.window.close(); }
});

test('🗑 xóa vị trí: hỏi kèm ghi chú hiện tại, DELETE kèm branch/order/version, vị trí biến khỏi hộp', async () => {
  const page = await renderPage();
  try {
    await openPopup(page);
    const asked = [];
    page.window.confirm = message => { asked.push(message); return false; };
    await click(page, '[data-pos-delete][data-pos-id="12"]');
    assert.equal(page.store.posCalls.length, 0, 'từ chối thì không xóa');
    assert.match(asked[0], /Xóa vị trí B02 của mã A khỏi VT Hà Nội\?/);
    assert.match(asked[0], /2T x 25/);
    page.window.confirm = () => true;
    await click(page, '[data-pos-delete][data-pos-id="12"]');
    assert.deepEqual(page.store.posCalls.map(c => [c.method, c.url, c.body]), [['DELETE', '/api/shipment/pick/positions/12?branch=HN&order=DH1&version=1', null]]);
    assert.equal($(page, '[data-location="12"]'), null);
    assert.equal(qty(page, 11), '100');
  } finally { page.dom.window.close(); }
});

test('Esc khi đang sửa chỉ đóng ô sửa (chặn cancel của dialog); không sửa thì Esc như cũ', async () => {
  const page = await renderPage();
  try {
    await openPopup(page);
    const { document, window } = page;
    await click(page, '[data-pos-edit][data-pos-id="11"]');
    const cancel = new window.Event('cancel', { cancelable: true });
    document.getElementById('pickingDialog').dispatchEvent(cancel);
    assert.equal(cancel.defaultPrevented, true, 'đang sửa: dialog không bị đóng bởi cancel');
    $(page, '[data-pos-input="notes"]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await settle();
    assert.equal($(page, '[data-pos-editor]'), null, 'Esc đóng ô sửa');
    assert.equal(document.getElementById('pickingDialog').hasAttribute('open'), true, 'hộp chỉ định vẫn mở');
    assert.equal(page.store.posCalls.length, 0);
    await new Promise(resolve => setTimeout(resolve, 10));
    const later = new window.Event('cancel', { cancelable: true });
    document.getElementById('pickingDialog').dispatchEvent(later);
    assert.equal(later.defaultPrevented, false, 'hết sửa thì Esc đóng hộp như cũ');
  } finally { page.dom.window.close(); }
});
