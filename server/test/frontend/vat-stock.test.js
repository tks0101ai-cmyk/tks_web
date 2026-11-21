'use strict';

// Ton VAT trong hop chi tiet chung tu (public/shared/vat-stock.js) + du lieu chuyen trang (public/shared/vat-handoff.js).
// Spec: docs/superpowers/specs/2026-11-21-vat-stock-order-release-design.md

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const S = require('../../public/shared/vat-stock.js');
const H = require('../../public/shared/vat-handoff.js');

const publicDir = path.join(__dirname, '..', '..', 'public');
const stockCode = fs.readFileSync(path.join(publicDir, 'shared', 'vat-stock.js'), 'utf8');
const handoffCode = fs.readFileSync(path.join(publicDir, 'shared', 'vat-handoff.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };

function memoryStorage() {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
const L = (productCode, quantity, extra = {}) => ({ productCode, productName: 'Hàng ' + productCode, quantity, price: 30, discount: 3.33, ...extra });

// ---------- Ham thuan ----------

test('computeVatShortages: 1 dong du / thieu / ton am; enough', () => {
  const items = { A: { vatCode: 'V1', stock: 5 }, B: { vatCode: 'V2', stock: -3 } };
  const result = S.computeVatShortages([L('A', 5), L('B', 2)], items);
  assert.deepEqual(result.lines.map(r => [r.status, r.stock, r.shortage]), [['ok', 5, 0], ['short', -3, 2]]);
  assert.equal(result.enough, false);
  assert.equal(S.computeVatShortages([L('A', 4)], items).enough, true);
  assert.equal(S.computeVatShortages([L('A', 6)], items).lines[0].shortage, 1);
});

test('computeVatShortages: nhieu dong cung ma VAT chia ton theo thu tu dong (35 -> 30 du, 20 thieu 15)', () => {
  const items = { A: { vatCode: 'V1', stock: 35 }, C: { vatCode: 'V1', stock: 35 } };
  const result = S.computeVatShortages([L('A', 30), L('C', 20)], items);
  assert.deepEqual(result.lines.map(r => r.shortage), [0, 15]);
  assert.equal(result.enough, false);
});

test('computeVatShortages: bo qua dong phi VAT…, SL <= 0, ma rong; noVat va unknown thieu ca SL', () => {
  const items = { A: { vatCode: null, stock: null } };
  const result = S.computeVatShortages([L('VATDA44', 1), L(' vat01 ', 1), L('A', 3), L('B', -2), L('', 1), L('B', 0)], items);
  assert.deepEqual(result.lines.map(r => r.status), ['skip', 'skip', 'noVat', 'skip', 'skip', 'skip']);
  assert.equal(result.lines[2].shortage, 3);
  assert.equal(result.enough, false);
  const unknown = S.computeVatShortages([L('A', 2.5)], null);
  assert.deepEqual([unknown.lines[0].status, unknown.lines[0].shortage, unknown.enough], ['unknown', 2.5, false]);
  assert.equal(S.computeVatShortages([L('VATDA44', 1)], {}).enough, false, 'chi co dong bi bo qua -> khong du');
  assert.equal(S.hasConsidered([L('VATDA44', 1), L('X', 0)]), false);
  assert.equal(S.hasConsidered([L('X', 1)]), true);
});

test('computeVatShortages: SL le khong sai so cong don', () => {
  const result = S.computeVatShortages([L('A', 0.1), L('A', 0.2)], { A: { vatCode: 'V1', stock: 0.25 } });
  assert.deepEqual(result.lines.map(r => r.shortage), [0, 0.05]);
});

test('permissions: phai co quyen Tra cuu VAT va ORDER VAT de order', () => {
  const can = keys => key => keys.includes(key);
  assert.deepEqual(S.permissions(can(['accounting.vatLookup', 'accounting.vatRequest'])), { stock: true, order: true });
  assert.deepEqual(S.permissions(can(['accounting.vatRequest'])), { stock: false, order: false });
  assert.deepEqual(S.permissions(can(['accounting.vatLookup'])), { stock: true, order: false });
  assert.deepEqual(S.permissions(() => { throw new Error('chua nap quyen'); }), { stock: false, order: false });
});

test('showsBar / showsColumns: quyen xem ton va co dong hang duoc xet', () => {
  const lines = [L('A', 1)];
  const view = { stock: true, order: false };
  assert.equal(S.showsBar(lines, view), true);
  assert.equal(S.showsColumns(lines, view), true);
  assert.equal(S.showsBar([L('VATDA44', 1)], view), false);
  assert.equal(S.showsColumns(lines, { stock: false, order: false }), false);
  assert.equal(S.showsBar(lines, { stock: false, order: false }), false);
  assert.equal(S.showsBar(lines, null), false);
});

test('loadStock: chi gui ma duoc xet, bo trung, chia lo 200 ma va gop ket qua; khong co dong xet -> khong goi; loi -> { error }', async () => {
  const sent = [];
  const post = async codes => { sent.push(codes); return { meta: { loadedAt: 'x', stale: false }, items: Object.fromEntries(codes.map(code => [code, { vatCode: 'V', stock: 1 }])) }; };
  const lines = [L('VATDA44', 1), L('A', 1), L('A', 2), ...Array.from({ length: 449 }, (_, i) => L('M' + i, 1))];
  const data = await S.loadStock(lines, post);
  assert.deepEqual(sent.map(batch => batch.length), [200, 200, 50]);
  assert.equal(sent[0][0], 'A');
  assert.equal(Object.keys(data.items).length, 450);
  assert.deepEqual(data.meta, { loadedAt: 'x', stale: false });
  assert.deepEqual(await S.loadStock([L('VATDA44', 1)], post), { items: {}, meta: null });
  assert.equal(sent.length, 3);
  assert.deepEqual(await S.loadStock([L('A', 1)], async () => { throw new Error('Sheet lỗi'); }), { error: 'Sheet lỗi' });
});

test('headHtml / cellsHtml: cot theo quyen, dong khong xet de trong, thoat HTML ma SP', () => {
  const all = { stock: true, order: true };
  assert.match(S.headHtml(all), /Tồn VAT.*Order VAT/);
  assert.doesNotMatch(S.headHtml({ stock: true, order: false }), /Order VAT/);
  assert.match(S.cellsHtml(L('A<b>', 1), all), /aria-label="Order VAT A&lt;b&gt;"/);
  assert.doesNotMatch(S.cellsHtml(L('VATDA44', 1), all), /data-vat-cell/);
  assert.equal((S.cellsHtml(L('A', 1), { stock: true, order: false }).match(/<td/g) || []).length, 1);
  assert.match(S.barHtml(), /data-vat-bar/);
});

test('vat-handoff: ghi / doc 1 lan roi xoa; qua 10 phut hoac hong -> expired; chan bo nho -> false / none', () => {
  const storage = memoryStorage();
  const rows = [{ customerName: 'KH A', productCode: 'A1', productName: 'Hàng A', quantity: 2, unitPrice: 27, saleNote: 'Từ HD-1' }];
  assert.equal(H.writeOrderVat(storage, { source: 'HD-1', rows }, 1000), true);
  assert.deepEqual(H.takeOrderVat(storage, 1000 + 60000), { status: 'ok', source: 'HD-1', rows });
  assert.equal(storage.getItem(H.ORDER_VAT_KEY), null, 'doc xong la xoa');
  assert.deepEqual(H.takeOrderVat(storage, 2000), { status: 'none', rows: [] });
  H.writeOrderVat(storage, { source: 'HD-1', rows }, 0);
  assert.equal(H.takeOrderVat(storage, H.MAX_AGE_MS + 1).status, 'expired');
  storage.setItem(H.ORDER_VAT_KEY, '{hong');
  assert.equal(H.takeOrderVat(storage).status, 'expired');
  assert.equal(storage.getItem(H.ORDER_VAT_KEY), null);
  assert.equal(H.writeOrderVat(null, { source: 'x', rows }), false);
  assert.deepEqual(H.takeOrderVat(null), { status: 'none', rows: [] });
  assert.equal(H.writeOrderVat({ setItem() { throw new Error('QuotaExceeded'); } }, { source: 'x', rows }), false);
});

test('vat-handoff: TSV dung thu tu cot va thay ky tu xuong dong / tab', () => {
  assert.equal(H.orderVatTsv([{ customerName: 'KH\tA', productCode: 'A1', productName: 'Hàng\nA', quantity: 2, unitPrice: 27, saleNote: 'Từ HD-1' }]),
    'KH A\tA1\tHàng A\t2\t27\tTừ HD-1');
});

// ---------- attach (jsdom) ----------

const ALL = { stock: true, order: true };
const DOC = { kind: 'invoice', code: 'HD-1', branch: 'Hà Nội', status: 'Hoàn thành', customerName: 'KH A' };
const META = { loadedAt: '2026-11-17T03:12:00.000Z', stale: false };

function mount({ lines, perms = ALL, doc = DOC, stock, isCurrent, getStorage, writeClipboard } = {}) {
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>', { runScripts: 'outside-only', url: 'https://tokosi.test/' });
  const { window } = dom;
  window.eval(handoffCode);
  window.eval(stockCode);
  const VS = window.TKSVatStock;
  const host = window.document.getElementById('host');
  host.innerHTML = '<table><thead><tr><th>Mã</th>' + VS.headHtml(perms) + '</tr></thead><tbody>' +
    lines.map((line, i) => '<tr data-vat-line="' + i + '"><td>' + line.productCode + '</td>' + VS.cellsHtml(line, perms) + '</tr>').join('') +
    '</tbody></table>' + VS.barHtml();
  const opened = [];
  const options = { root: host, lines, doc, perms, stock, openTab: url => opened.push(url) };
  if (isCurrent) options.isCurrent = isCurrent;
  if (getStorage) options.getStorage = getStorage;
  if (writeClipboard) options.writeClipboard = writeClipboard;
  VS.attach(options);
  const rows = () => [...host.querySelectorAll('tbody tr')];
  const bar = () => host.querySelector('[data-vat-bar]');
  const tick = index => {
    const box = rows()[index].querySelector('.vat-order-tick');
    box.checked = !box.checked;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  return { dom, window, VS, host, opened, rows, bar, tick };
}

test('attach: so ton, dong thieu do, tick chi o dong thieu, title co ma VAT / thieu / gio cap nhat', async () => {
  const page = mount({ lines: [L('A1', 3), L('B2', 2), L('VATDA44', 1)], stock: Promise.resolve({ meta: META, items: { A1: { vatCode: 'VAT1', stock: 1 }, B2: { vatCode: 'VAT2', stock: 50 } } }) });
  assert.equal(page.rows()[0].querySelector('.vat-stock-cell').textContent, '…', 'dang tai');
  await settle();
  const [a, b, fee] = page.rows();
  assert.equal(a.querySelector('.vat-stock-cell').textContent, '1');
  assert.ok(a.querySelector('.vat-stock-cell').classList.contains('is-vat-short'));
  assert.equal(a.querySelector('.vat-stock-cell').title, 'Mã VAT VAT1 · Thiếu 2 · Cập nhật lúc 10:12');
  assert.equal(a.querySelector('.vat-order-tick').disabled, false);
  assert.equal(b.querySelector('.vat-stock-cell').textContent, '50');
  assert.equal(b.querySelector('.vat-order-tick').disabled, true);
  assert.equal(b.querySelector('.vat-order-tick').title, 'Đủ VAT');
  assert.equal(fee.querySelector('.vat-order-tick'), null);
  assert.equal(page.bar().querySelector('[data-vat-action="order"]'), null, 'chua tick -> chua co nut Order VAT');
  page.dom.window.close();
});

test('attach: tick -> nut Order VAT (n dong); bam -> luu ban chuyen (so thieu, gia sau chiet khau) va mo /vat-request/?handoff=1', async () => {
  const page = mount({ lines: [L('A1', 3), L('B2', 5)], stock: Promise.resolve({ meta: META, items: { A1: { vatCode: 'VAT1', stock: 1 }, B2: { vatCode: null, stock: null } } }) });
  await settle();
  assert.equal(page.rows()[1].querySelector('.vat-stock-cell').textContent, 'Chưa có mã VAT');
  page.tick(0);
  page.tick(1);
  assert.equal(page.bar().hidden, false);
  assert.equal(page.bar().querySelector('[data-vat-action="order"]').textContent, 'Order VAT (2 dòng)');
  page.tick(1);
  assert.equal(page.bar().querySelector('[data-vat-action="order"]').textContent, 'Order VAT (1 dòng)');
  page.tick(1);
  page.bar().querySelector('[data-vat-action="order"]').click();
  assert.deepEqual(page.opened, ['/vat-request/?handoff=1']);
  const saved = JSON.parse(page.window.localStorage.getItem('tks.vatRequest.handoff'));
  assert.equal(saved.source, 'HD-1');
  assert.deepEqual(saved.rows, [
    { customerName: 'KH A', productCode: 'A1', productName: 'Hàng A1', quantity: 2, unitPrice: 27, saleNote: 'Từ HD-1' },
    { customerName: 'KH A', productCode: 'B2', productName: 'Hàng B2', quantity: 5, unitPrice: 27, saleNote: 'Từ HD-1' }
  ]);
  page.dom.window.close();
});

test('attach: sau khi bam Order VAT -> bo tick, an nut, bao "Da mo trang ORDER VAT."; tick lai thi het bao va nut tro lai', async () => {
  const page = mount({ lines: [L('A1', 3)], stock: Promise.resolve({ meta: META, items: { A1: { vatCode: 'VAT1', stock: 1 } } }) });
  await settle();
  page.tick(0);
  page.bar().querySelector('[data-vat-action="order"]').click();
  assert.deepEqual(page.opened, ['/vat-request/?handoff=1']);
  assert.equal(page.rows()[0].querySelector('.vat-order-tick').checked, false);
  assert.equal(page.bar().querySelector('[data-vat-action="order"]'), null);
  assert.match(page.bar().textContent, /Đã mở trang ORDER VAT\./);
  page.tick(0);
  assert.doesNotMatch(page.bar().textContent, /Đã mở trang ORDER VAT/);
  assert.equal(page.bar().querySelector('[data-vat-action="order"]').textContent, 'Order VAT (1 dòng)');
  page.dom.window.close();
});

test('attach: loi doc ton -> "—", dong bao loi, tick mo o moi dong duoc xet, Order lay nguyen SL', async () => {
  const page = mount({ lines: [L('A1', 3), L('B2', 4)], stock: Promise.resolve({ error: 'Sheet lỗi' }) });
  await settle();
  assert.deepEqual(page.rows().map(tr => tr.querySelector('.vat-stock-cell').textContent), ['—', '—']);
  assert.match(page.bar().textContent, /Không đọc được tồn VAT, thử lại sau\./);
  assert.doesNotMatch(page.bar().textContent, /dòng thiếu VAT/);
  page.tick(1);
  page.bar().querySelector('[data-vat-action="order"]').click();
  assert.equal(JSON.parse(page.window.localStorage.getItem('tks.vatRequest.handoff')).rows[0].quantity, 4);
  page.dom.window.close();
});

test('attach: chung tu Da huy -> khong tick, khong nut; thieu quyen -> khong cot Order VAT', async () => {
  const items = { A1: { vatCode: 'VAT1', stock: 0 }, B2: { vatCode: 'VAT2', stock: 9 } };
  const cancelled = mount({ lines: [L('A1', 3)], doc: { ...DOC, status: 'Đã hủy' }, stock: Promise.resolve({ meta: META, items }) });
  await settle();
  assert.equal(cancelled.rows()[0].querySelector('.vat-order-tick').disabled, true);
  assert.equal(cancelled.rows()[0].querySelector('.vat-stock-cell').textContent, '0');
  cancelled.tick(0);
  assert.deepEqual(cancelled.opened, []);
  assert.equal(cancelled.bar().hidden, true);
  const viewOnly = mount({ lines: [L('B2', 3)], perms: { stock: true, order: false }, stock: Promise.resolve({ meta: META, items }) });
  await settle();
  assert.equal(viewOnly.host.querySelector('.vat-order-tick'), null);
  assert.equal(viewOnly.rows()[0].querySelector('.vat-stock-cell').textContent, '9');
  assert.equal(viewOnly.bar().hidden, true);
  cancelled.dom.window.close();
  viewOnly.dom.window.close();
});

test('attach: ket qua ve muon cua lan gan truoc khong ve de len lan gan moi; isCurrent=false thi bo qua', async () => {
  let resolveOld;
  const page = mount({ lines: [L('A1', 3)], stock: new Promise(resolve => { resolveOld = resolve; }) });
  page.VS.attach({ root: page.host, lines: [L('A1', 3)], doc: DOC, perms: ALL, stock: Promise.resolve({ meta: META, items: { A1: { vatCode: 'VAT1', stock: 7 } } }), openTab: () => {} });
  await settle();
  resolveOld({ meta: META, items: { A1: { vatCode: 'VAT1', stock: 1 } } });
  await settle();
  assert.equal(page.rows()[0].querySelector('.vat-stock-cell').textContent, '7');
  const stale = mount({ lines: [L('A1', 3)], isCurrent: () => false, stock: Promise.resolve({ meta: META, items: { A1: { vatCode: 'VAT1', stock: 1 } } }) });
  await settle();
  assert.equal(stale.rows()[0].querySelector('.vat-stock-cell').textContent, '…');
  page.dom.window.close();
  stale.dom.window.close();
});

test('attach: trinh duyet chan luu tam -> khong mo tab, chep TSV vao khay nho va bao', async () => {
  const copied = [];
  const page = mount({
    lines: [L('A1', 3)], getStorage: () => null, writeClipboard: text => { copied.push(text); return Promise.resolve(); },
    stock: Promise.resolve({ meta: META, items: { A1: { vatCode: 'VAT1', stock: 1 } } })
  });
  await settle();
  page.tick(0);
  page.bar().querySelector('[data-vat-action="order"]').click();
  await settle();
  assert.deepEqual(page.opened, []);
  assert.deepEqual(copied, ['KH A\tA1\tHàng A1\t2\t27\tTừ HD-1']);
  assert.match(page.bar().textContent, /Trình duyệt không cho lưu tạm, hãy mở trang ORDER VAT và dán dữ liệu\. Đã chép sẵn các dòng vào khay nhớ\./);
  page.dom.window.close();
});

test('attach: quyen xem ton xem duoc thong bao bao loi va ban cu', async () => {
  const perms = { stock: true, order: false };
  const failed = mount({ lines: [L('A1', 3)], perms, stock: Promise.resolve({ error: 'Sheet lỗi' }) });
  const stale = mount({ lines: [L('A1', 3)], perms, stock: Promise.resolve({
    meta: { ...META, stale: true }, items: { A1: { vatCode: 'VAT1', stock: 1 } }
  }) });
  await settle();
  assert.equal(failed.bar().hidden, false);
  assert.match(failed.bar().textContent, /Không đọc được tồn VAT/);
  assert.match(stale.rows()[0].querySelector('.vat-stock-cell').title, /bản cũ/);
  assert.match(stale.bar().textContent, /bản cũ/);
  failed.dom.window.close();
  stale.dom.window.close();
});

test('attach: destroy xoa tick va thao tac cua chung tu cu', async () => {
  const page = mount({ lines: [L('A1', 3)], stock: Promise.resolve({ items: { A1: { vatCode: 'VAT1', stock: 1 } } }) });
  await settle();
  page.tick(0);
  const action = page.bar().querySelector('[data-vat-action="order"]');
  const checkbox = page.rows()[0].querySelector('.vat-order-tick');
  assert.equal(checkbox.checked, true);
  page.host._tksVatStock.destroy();

  assert.equal(checkbox.checked, false);
  assert.equal(checkbox.disabled, true);
  assert.equal(page.bar().hidden, true);
  assert.equal(page.bar().querySelector('[data-vat-action="order"]'), null);
  action.click();
  assert.deepEqual(page.opened, []);
  assert.equal(page.window.localStorage.getItem(H.ORDER_VAT_KEY), null);
  page.dom.window.close();
});
