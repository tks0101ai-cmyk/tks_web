'use strict';

// Ham thuan cua product-90d-report.js (dinh dang NULL/0/am/le, Top 3, khoang ngay, chuoi truy van, ngu canh xuat file): file nay con
// duoc exportService.js require cho xuat file Hang hoa 90 ngay cu. Giao dien muc 4 da chuyen sang product-customer-growth.js
// (xem product-customer-growth.test.js); test bang/markup cu da go cung giao dien cu.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const publicDir = path.join(__dirname, '..', '..', 'public');
const H = require(path.join(publicDir, 'product-90d-report.js'));

// ---------- ham thuan ----------
test('formatValue: NULL -> "—", 0 -> "0", so am va lam tron so nguyen theo en-US', () => {
  assert.equal(H.formatValue(null), '—');
  assert.equal(H.formatValue(undefined), '—');
  assert.equal(H.formatValue(''), '—');
  assert.equal(H.formatValue('abc'), '—');
  assert.equal(H.formatValue(0), '0');
  assert.equal(H.formatValue(-0), '0');
  assert.equal(H.formatValue('0'), '0');
  assert.equal(H.formatValue(-3), '-3');
  assert.equal(H.formatValue(-1250.5), '-1,251');
  assert.equal(H.formatValue(2.5), '3');
  assert.equal(H.formatValue(-2.5), '-3', 'nua ra xa so 0');
  assert.equal(H.formatValue(31933.3333), '31,933');
  assert.equal(H.formatValue(-0.5), '-1');
  assert.equal(H.formatValue(0.125), '0');
  assert.equal(H.formatValue(-0.2), '0');
  assert.equal(H.formatValue(1234567.5), '1,234,568');
  assert.equal(H.formatValue('12.3456789'), '12');
  assert.equal(H.formatValue(100000.0238), '100,000');
  assert.equal(H.formatValue(1.123456789), '1');
  assert.equal(H.formatValue(2.50000000), '3');
  assert.equal(H.formatValue(1500000), '1,500,000');
});

test('formatShare: ty le 0-1 thanh %, NULL -> "—"', () => {
  assert.equal(H.formatShare(0.4523), '45.2%');
  assert.equal(H.formatShare(1), '100%');
  assert.equal(H.formatShare(0), '0%');
  assert.equal(H.formatShare(null), '—');
});

test('formatPeriodRange + formatStamp (gio Viet Nam)', () => {
  assert.equal(H.formatPeriodRange('2026-08-06', '2026-09-04'), '06/08–04/09/2026');
  assert.equal(H.formatPeriodRange('2025-12-15', '2026-01-13'), '15/12/2025–13/01/2026');
  assert.equal(H.formatPeriodRange(null, '2026-01-13'), '');
  assert.equal(H.formatStamp('2026-11-03T19:05:00.000Z'), '02:05 04/11/2026');
  assert.equal(H.formatStamp('khong-phai-ngay'), '');
  assert.equal(H.formatStamp(null), '');
});

test('topCustomerLines: moi khach 1 dong "Ten|%DS|DS" (khong SL, khong phan cach nghin), bo khach SL = 0', () => {
  assert.deepEqual(H.topCustomerLines([
    { name: 'HN C Vương Ninh HN', share: 0.1, revenue: 45000000, quantity: 3 },
    { name: 'Khách B', share: 0.622, revenue: 10300000, quantity: 1 },
    { name: 'Khách C', share: 0.125, revenue: 300000.5, quantity: 1.5 }
  ]), ['HN C Vương Ninh HN|10%|45000000', 'Khách B|62.2%|10300000', 'Khách C|12.5%|300001']);
  // SL 0 (ke ca dong toan so 0) bi bo; SL am (tra hang) giu; ten rong -> "Khách lẻ"; share NULL -> "—"; doanh so am giu.
  assert.deepEqual(H.topCustomerLines([
    { name: 'Không mua', share: 0, revenue: 0, quantity: 0 },
    { name: '', share: null, revenue: -1250.5, quantity: -2 },
    { name: 'Chỉ SL 0', share: 0.3, revenue: 500, quantity: '0' }
  ]), ['Khách lẻ|—|-1251']);
  assert.deepEqual(H.topCustomerLines([{ name: 'A', share: 0, revenue: 0, quantity: 0 }]), [], 'loc het -> rong');
  assert.deepEqual(H.topCustomerLines(null), []);
  // Chi lay toi da 3 khach dau (du lieu da xep san).
  assert.equal(H.topCustomerLines([1, 2, 3, 4].map(i => ({ name: 'K' + i, share: 0.1, revenue: i, quantity: 1 }))).length, 3);
});

test('topCustomersHtml: 1 dong / khach + title cung chu, rong hoac loc het -> "—", ten co | va ky tu HTML duoc escape', () => {
  assert.match(H.topCustomersHtml([]), /—/);
  assert.doesNotMatch(H.topCustomersHtml([]), /<ol/);
  assert.match(H.topCustomersHtml(null), /—/);
  assert.match(H.topCustomersHtml([{ name: 'X', share: 0, revenue: 0, quantity: 0 }]), /—/, 'chi co khach SL 0 -> "—"');
  const dom = new JSDOM('<div id="x"></div>');
  const box = dom.window.document.getElementById('x');
  box.innerHTML = H.topCustomersHtml([
    { name: 'Đặng <An> | "Cty"', share: 0.5, revenue: 1200000, quantity: 12 },
    { name: 'Bỏ vì SL 0', share: 0, revenue: 0, quantity: 0 },
    { name: 'Khách C', share: 0.125, revenue: 300000.5, quantity: 1.5 }
  ]);
  const items = [...box.querySelectorAll('li')];
  assert.equal(items.length, 2);
  assert.equal(items[0].textContent, 'Đặng <An> | "Cty"|50%|1200000');
  assert.equal(items[0].title, items[0].textContent);
  assert.equal(box.querySelector('an'), null);
  assert.equal(items[1].textContent, 'Khách C|12.5%|300001');
});

test('exportContext + sortAction: payload Xuat file theo tu khoa da ap dung va nhan cot; nut sap xep bao hanh dong ke tiep', () => {
  assert.deepEqual(H.exportContext({ q: '  binh  ', sort: 'revenue_1_30d', dir: 'desc' }),
    { tableSearch: { mode: 'normal', query: 'binh' }, tableSort: { label: 'T.này – DS', direction: 'desc' } });
  assert.deepEqual(H.exportContext({ q: '', sort: '', dir: '' }), { tableSearch: { mode: 'normal', query: '' } });
  assert.deepEqual(H.exportContext({ q: 'x', sort: 'product_name', dir: 'asc' }).tableSort, { label: 'Tên hàng', direction: 'asc' });
  assert.equal(H.exportContext({ sort: 'top_customers_1_30d', dir: 'asc' }).tableSort, undefined, 'cot khong sap duoc');
  assert.equal(H.exportContext({ q: 'y'.repeat(250) }).tableSearch.query.length, 200);
  assert.equal(H.sortAction('none'), 'Sắp xếp tăng dần');
  assert.equal(H.sortAction('ascending'), 'Sắp xếp giảm dần');
  assert.equal(H.sortAction('descending'), 'Bỏ sắp xếp');
});

test('rowHtml: 22 o theo thu tu cot, 0 -> 0, am/le giu nguyen', () => {
  const row = { product_code: 'SP01', product_name: 'Tên rất dài <b>' };
  H.PERIODS.forEach(p => {
    Object.assign(row, { ['qty_' + p.key]: 0, ['revenue_' + p.key]: 0, ['avg_price_' + p.key]: null,
      ['customer_count_' + p.key]: 0, ['invoice_count_' + p.key]: 0, ['top_customers_' + p.key]: [] });
  });
  row.qty_1_30d = -4; row.revenue_1_30d = -800000; row.qty_1_90d = 2.75; row.avg_price_1_90d = 1234.5;
  const dom = new JSDOM('<table><tbody id="b"></tbody></table>');
  const body = dom.window.document.getElementById('b');
  body.innerHTML = H.rowHtml(row);
  const cells = [...body.rows[0].cells].map(td => td.textContent.trim());
  assert.equal(cells.length, 22);
  const at = key => cells[H.COLUMNS.findIndex(c => c.key === key)];
  assert.equal(at('product_code'), 'SP01');
  assert.equal(at('product_name'), 'Tên rất dài <b>');
  assert.equal(at('qty_61_90d'), '0');
  assert.equal(at('top_customers_61_90d'), '—');
  assert.equal(at('qty_1_30d'), '-4');
  assert.equal(at('revenue_1_30d'), '-800,000');
  assert.equal(at('qty_1_90d'), '3');
});

test('buildQuery bo tham so rong; dir chi di kem sort; relevance khong gui', () => {
  assert.equal(H.buildQuery({ q: '', sort: '', dir: '', page: 1, pageSize: 50 }), 'page=1&pageSize=50');
  assert.equal(H.buildQuery({ q: '  ', sort: '', dir: 'desc', page: 1, pageSize: 50 }), 'page=1&pageSize=50');
  assert.equal(H.buildQuery({ q: ' ốc vít ', sort: 'revenue_1_90d', dir: 'desc', page: 3, pageSize: 100 }),
    'q=%E1%BB%91c+v%C3%ADt&sort=revenue_1_90d&dir=desc&page=3&pageSize=100');
  assert.equal(H.buildQuery({ q: 'a', sort: 'relevance', dir: 'asc', page: 1, pageSize: 50 }), 'q=a&page=1&pageSize=50');
  assert.equal(H.buildQuery({}), '');
  assert.equal(H.buildQuery({ pageSize: 500 }), 'pageSize=200');
});

test('nextSort: tang dan -> giam dan -> bo sap xep', () => {
  assert.deepEqual(H.nextSort({ sort: '', dir: '' }, 'qty_1_30d'), { sort: 'qty_1_30d', dir: 'asc' });
  assert.deepEqual(H.nextSort({ sort: 'qty_1_30d', dir: 'asc' }, 'qty_1_30d'), { sort: 'qty_1_30d', dir: 'desc' });
  assert.deepEqual(H.nextSort({ sort: 'qty_1_30d', dir: 'desc' }, 'qty_1_30d'), { sort: '', dir: '' });
  assert.deepEqual(H.nextSort({ sort: 'qty_1_30d', dir: 'desc' }, 'product_code'), { sort: 'product_code', dir: 'asc' });
});
