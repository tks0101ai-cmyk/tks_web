'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions, PAGE_FEATURES } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'stock-locations/index.html'), 'utf8');
const code = fs.readFileSync(path.join(publicDir, 'stock-locations/stock-locations.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const row = (code, name = 'Hàng') => ({ code, name, totalQuantity: '0', notes: 'Dòng 1\nDòng 2', location: '' });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('arrival date is displayed verbatim on both branches and available in mobile column picker', async t => {
  const data = { HN: [{ ...row('HN'), arrivalDate: 'KK 25.7' }], SG: [{ ...row('SG'), arrivalDate: '03/10/2026' }] };
  const { doc, changeTab, setWidth } = await setup(t, { data });
  assert.equal(doc.querySelector('td[data-field="arrivalDate"]').textContent, 'KK 25.7');
  assert.equal(doc.querySelector('th[data-field="arrivalDate"] span').textContent, 'Ngày về');
  await changeTab('sg');
  assert.equal(doc.querySelector('td[data-field="arrivalDate"]').textContent, '03/10/2026');
  setWidth(390);
  assert.equal(doc.querySelector('th[data-field="arrivalDate"]:not(.tks-column-hidden)'), null);
  doc.getElementById('locationColumnsButton').click();
  assert.ok(doc.querySelector('input[data-column-key="arrivalDate"]'));
});

test('symbol pager navigates first and last pages within filtered results', async t => {
  const data = { HN: Array.from({ length: 205 }, (_, index) => row(String(index))), SG: [] };
  const { doc, window } = await setup(t, { data });
  for (const [id, symbol] of [['First', '<<'], ['Previous', '<'], ['Next', '>'], ['Last', '>>']]) {
    assert.equal(doc.getElementById('location' + id).textContent, symbol);
    assert.ok(doc.getElementById('location' + id).getAttribute('aria-label'));
  }
  assert.equal(doc.getElementById('locationFirst').disabled, true);
  doc.getElementById('locationLast').click();
  assert.match(doc.getElementById('locationPage').textContent, /Trang 3 \/ 3/);
  assert.equal(doc.querySelector('#locationRows td').textContent, '200');
  assert.equal(doc.getElementById('locationLast').disabled, true);
  doc.getElementById('locationPrevious').click();
  assert.match(doc.getElementById('locationPage').textContent, /Trang 2/);
  doc.getElementById('locationFirst').click();
  assert.match(doc.getElementById('locationPage').textContent, /Trang 1/);
  const search = doc.getElementById('locationSearch');
  search.value = '204';
  search.dispatchEvent(new window.Event('input'));
  assert.equal(doc.getElementById('locationLast').disabled, true);
  assert.match(doc.getElementById('locationPage').textContent, /Trang 1 \/ 1/);
});

async function setup(t, { branch = 'Cả hai', hash = '', data = { HN: [row('001')], SG: [row('SG01')] }, fetcher, width = 1024, savedColumns } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/stock-locations/' + hash, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true });
  const mediaListeners = [];
  const media = { matches: width <= 600, addEventListener: (event, listener) => mediaListeners.push(listener) };
  window.matchMedia = () => media;
  if (savedColumns !== undefined) window.localStorage.setItem('tks-stock-locations-columns-v2', JSON.stringify(savedColumns));
  window.HTMLDialogElement.prototype.showModal = function() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function() { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const user = { vaiTro: 'Nhân viên kho', branch, permissions: resolvePermissions({ vaiTro: 'Nhân viên kho' }), pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return { ok: true, status: 200, json: async () => ({ tables: {} }) };
    const target = parsed.searchParams.get('branch');
    calls.push({ target, options });
    return fetcher ? fetcher(target) : { ok: true, json: async () => ({ branch: target, rows: data[target] }) };
  };
  window.eval(code);
  await window.TKSStockLocations.init();
  return {
    window, calls, doc: window.document,
    setWidth: value => { window.innerWidth = value; media.matches = value <= 600; mediaListeners.forEach(listener => listener({ matches: media.matches })); window.TKSTables.refreshAll(); },
    changeTab: async tab => {
      const event = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true }));
      window.location.hash = tab;
      await event;
      await tick();
    }
  };
}

test('branch selection filters page and sidebar tabs and normalizes incompatible/unknown hashes', async t => {
  for (const [branch, hash, expected] of [['Hà Nội', '#sg', ['hn']], ['Sài Gòn', '#hn', ['sg']], ['Cả hai', '#invalid', ['hn', 'sg']]]) {
    const { doc, calls, window } = await setup(t, { branch, hash });
    assert.deepEqual([...doc.querySelectorAll('[data-location-tab]')].filter(link => !link.hidden).map(link => link.dataset.locationTab), expected);
    assert.deepEqual([...doc.querySelectorAll('[data-stock-location-tab]')].map(link => link.dataset.stockLocationTab), expected);
    assert.equal(window.location.hash, '#' + expected[0]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].target, expected[0].toUpperCase());
    assert.equal(calls[0].options.cache, 'no-store');
  }
});

test('sorting covers all filtered rows before pagination, uses numeric quantities and cycles back to source order', async t => {
  const data = { HN: Array.from({ length: 105 }, (_, i) => ({ ...row('HN' + i, 'Đèn'), totalQuantity: String(105 - i) })), SG: [] };
  data.HN[0].totalQuantity = '1.000,5';
  const { doc } = await setup(t, { data });
  const button = doc.querySelector('[data-sort-field="totalQuantity"]');
  button.click();
  assert.equal(doc.querySelector('#locationRows [data-field="totalQuantity"]').textContent, '1');
  assert.equal(doc.querySelector('#locationRows [data-field="code"]').textContent, 'HN104');
  assert.equal(button.closest('th').getAttribute('aria-sort'), 'ascending');
  doc.getElementById('locationNext').click();
  assert.match(doc.getElementById('locationPage').textContent, /Trang 2/);
  button.click();
  assert.equal(doc.querySelector('#locationRows [data-field="totalQuantity"]').textContent, '1.000,5');
  assert.match(doc.getElementById('locationPage').textContent, /Trang 1/);
  button.click();
  assert.equal(doc.querySelector('#locationRows [data-field="code"]').textContent, 'HN0');
  assert.equal(button.closest('th').getAttribute('aria-sort'), 'none');
});

test('text and position sort naturally, preserve equal rows and keep empty quantities last in either direction', async t => {
  const { window } = await setup(t);
  const rows = [
    { ...row('1'), location: 'Kệ 10', totalQuantity: '' },
    { ...row('2'), location: 'Kệ 2', totalQuantity: '2,5' },
    { ...row('3'), location: 'Kệ 2', totalQuantity: '10' },
    { ...row('4'), location: '', totalQuantity: '1.000' }
  ];
  const sorted = window.TKSStockLocations.sortRows(rows, 'location', 'asc');
  assert.deepEqual(Array.from(sorted, value => value.code), ['2', '3', '1', '4']);
  assert.deepEqual(Array.from(window.TKSStockLocations.sortRows(rows, 'totalQuantity', 'asc'), value => value.code), ['2', '3', '4', '1']);
  assert.deepEqual(Array.from(window.TKSStockLocations.sortRows(rows, 'totalQuantity', 'desc'), value => value.code), ['4', '3', '2', '1']);
  assert.equal(rows[0].code, '1', 'source row order must not be mutated');
});

test('each branch retains its own sort state when switching and rereading tabs', async t => {
  const data = { HN: [row('B'), row('A')], SG: [row('D'), row('C')] };
  const { doc, changeTab } = await setup(t, { data });
  doc.querySelector('[data-sort-field="code"]').click();
  assert.equal(doc.querySelector('#locationRows td').textContent, 'A');
  await changeTab('sg');
  assert.equal(doc.querySelector('#locationRows td').textContent, 'D');
  await changeTab('hn');
  assert.equal(doc.querySelector('#locationRows td').textContent, 'A');
  assert.equal(doc.querySelector('th[data-field="code"]').getAttribute('aria-sort'), 'ascending');
});

test('mobile defaults and shared picker choices last for this session, independently of desktop', async t => {
  const { doc, window, setWidth } = await setup(t, { width: 390 });
  const fields = () => Array.from(doc.querySelectorAll('#locationTable th:not(.tks-column-hidden)'), th => th.dataset.field);
  assert.deepEqual(fields(), ['name', 'totalQuantity', 'location']);
  doc.getElementById('locationColumnsButton').click();
  const picker = doc.querySelector('.tks-columns-picker:not([hidden])');
  assert.ok(picker);
  assert.equal(picker.querySelector('input[data-column-key="name"]').disabled, true);
  const codeBox = picker.querySelector('input[data-column-key="code"]');
  codeBox.checked = true;
  codeBox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(fields(), ['code', 'name', 'totalQuantity', 'location']);
  assert.equal(window.localStorage.getItem('tks-stock-locations-columns-v2'), null);
  setWidth(1200);
  assert.equal(fields().length, 6);
  setWidth(390);
  assert.equal(fields().length, 4);
  doc.getElementById('locationColumnsButton').click();
  doc.querySelector('.tks-columns-picker:not([hidden]) [data-action="show-all"]').click();
  assert.equal(fields().length, 6);
  doc.querySelector('.tks-columns-picker:not([hidden]) [data-action="close"]').click();
  assert.equal(doc.querySelector('.tks-columns-picker:not([hidden])'), null);
  assert.equal(doc.activeElement, doc.getElementById('locationColumnsButton'));
  const reloaded = await setup(t, { width: 390 });
  assert.deepEqual(Array.from(reloaded.doc.querySelectorAll('#locationTable th:not(.tks-column-hidden)'), th => th.dataset.field), ['name', 'totalQuantity', 'location']);
});

test('old stored column choices are ignored and hiding a sorted column clears sort', async t => {
  const { doc, window } = await setup(t, { savedColumns: { desktop: ['code', 'totalQuantity', 'unknown'] } });
  assert.equal(doc.querySelectorAll('#locationTable th:not(.tks-column-hidden)').length, 6);
  doc.querySelector('[data-sort-field="code"]').click();
  doc.getElementById('locationColumnsButton').click();
  const checkbox = doc.querySelector('.tks-columns-picker input[data-column-key="code"]');
  checkbox.checked = false;
  checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.equal(doc.querySelector('[aria-sort="ascending"]'), null);
  assert.ok(doc.querySelector('#locationRows [data-field="code"]').classList.contains('tks-column-hidden'));
  assert.equal(doc.querySelectorAll('#locationRows td:not(.tks-column-hidden)').length, 5);
});

test('search is accent/case insensitive, includes rows beyond first page, and ignores notes', async t => {
  const data = { HN: [...Array.from({ length: 104 }, (_, i) => row('MA' + i, 'Thùng')), row('0009', 'ĐÈN điện')], SG: [] };
  const { doc } = await setup(t, { data });
  assert.equal(doc.querySelectorAll('#locationRows tr').length, 100);
  doc.getElementById('locationNext').click();
  assert.match(doc.getElementById('locationPage').textContent, /Trang 2/);
  const input = doc.getElementById('locationSearch');
  input.value = 'den DIEN';
  input.dispatchEvent(new doc.defaultView.Event('input'));
  assert.equal(doc.querySelectorAll('#locationRows tr').length, 1);
  assert.equal(doc.querySelector('#locationRows td').textContent, '0009');
  assert.match(doc.getElementById('locationPage').textContent, /Trang 1/);
  assert.equal(doc.querySelectorAll('#locationRows td')[3].textContent, 'Dòng 1\nDòng 2');
  input.value = 'Dòng 1';
  input.dispatchEvent(new doc.defaultView.Event('input'));
  assert.equal(doc.querySelectorAll('#locationRows tr').length, 0);
  assert.match(doc.getElementById('locationStatus').textContent, /Không tìm thấy/);
});

test('search includes position even if its column is hidden and resets pagination', async t => {
  const data = { HN: [...Array.from({ length: 101 }, (_, i) => row('HN' + i)), { ...row('TARGET', 'Ấm'), location: 'KỆ số 36' }], SG: [] };
  const { doc, window } = await setup(t, { data, savedColumns: { desktop: ['code', 'name'] } });
  doc.getElementById('locationColumnsButton').click();
  const locationBox = doc.querySelector('.tks-columns-picker input[data-column-key="location"]');
  locationBox.checked = false;
  locationBox.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.ok(doc.querySelector('th[data-field="location"]').classList.contains('tks-column-hidden'));
  doc.getElementById('locationNext').click();
  const input = doc.getElementById('locationSearch');
  input.value = 'ke SO 36';
  input.dispatchEvent(new window.Event('input'));
  assert.equal(doc.querySelectorAll('#locationRows tr').length, 1);
  assert.equal(doc.querySelector('#locationRows [data-field="code"]').textContent, 'TARGET');
  assert.match(doc.getElementById('locationPage').textContent, /Trang 1/);
});

test('tab queries/pages are independent, reopening reads fresh and does not poll', async t => {
  const data = { HN: Array.from({ length: 105 }, (_, i) => row('HN' + i, 'Đèn')), SG: [row('SG01', 'Ấm')] };
  const { doc, changeTab, calls } = await setup(t, { data });
  const input = doc.getElementById('locationSearch');
  input.value = 'den';
  input.dispatchEvent(new doc.defaultView.Event('input'));
  doc.getElementById('locationNext').click();
  await changeTab('sg');
  assert.equal(input.value, '');
  assert.equal(doc.querySelector('#locationRows td').textContent, 'SG01');
  await changeTab('hn');
  assert.equal(input.value, 'den');
  assert.match(doc.getElementById('locationPage').textContent, /Trang 2/);
  assert.deepEqual(calls.map(call => call.target), ['HN', 'SG', 'HN']);
  assert.doesNotMatch(code, /setInterval|setTimeout/);
  assert.equal(doc.querySelector('[data-export], .export-btn'), null);
  assert.doesNotMatch(doc.querySelector('main').textContent, /Xuất/);
});

test('late HN response cannot overwrite SG, and sheet content is rendered as text', async t => {
  let releaseHN;
  let hnCalls = 0;
  const { doc, changeTab, window } = await setup(t, { fetcher: async branch => {
    if (branch === 'HN' && ++hnCalls > 1) return new Promise(resolve => { releaseHN = resolve; });
    return { ok: true, json: async () => ({ branch, rows: [row(branch === 'SG' ? '<img src=x onerror=alert(1)>' : 'HN')] }) };
  } });
  doc.querySelector('[data-location-tab="hn"]').click();
  await tick();
  assert.match(doc.getElementById('locationStatus').textContent, /Đang tải/);
  await changeTab('sg');
  releaseHN({ ok: true, json: async () => ({ branch: 'HN', rows: [row('HN-LATE')] }) });
  await tick();
  assert.equal(window.location.hash, '#sg');
  assert.equal(doc.querySelector('#locationRows td').textContent, '<img src=x onerror=alert(1)>');
  assert.equal(doc.querySelector('#locationRows img'), null);
});

test('empty data, failed source and inconsistent response are visibly distinct', async t => {
  const empty = await setup(t, { data: { HN: [], SG: [] } });
  assert.match(empty.doc.getElementById('locationStatus').textContent, /Chưa có dữ liệu/);
  for (const response of [
    { ok: false, json: async () => ({ error: 'Không tìm thấy sheet Vị trí HN.' }) },
    { ok: true, json: async () => ({ branch: 'SG', rows: [row('wrong')] }) }
  ]) {
    const result = await setup(t, { fetcher: async () => response });
    assert.equal(result.doc.getElementById('locationStatus').dataset.error, 'true');
    assert.equal(result.doc.querySelectorAll('#locationRows tr').length, 0);
  }
});

test('guest sidebar never exposes location tabs even with account override', () => {
  const dom = new JSDOM('<nav id="sidebar"></nav>', { url: 'https://tokosi.test/account/', runScripts: 'outside-only' });
  dom.window.eval(nav);
  const user = { vaiTro: 'Khách', branch: 'Cả hai', featurePermissions: { 'stockLocations.view': true } };
  user.permissions = resolvePermissions(user);
  dom.window.TKSNav.renderTopSidebar(dom.window.document.getElementById('sidebar'), 'account', user);
  assert.equal(dom.window.document.querySelector('[data-stock-location-tab]'), null);
  dom.window.close();
});

test('account permissions form disables location grant for guest and permits staff configuration', () => {
  const accountHtml = fs.readFileSync(path.join(publicDir, 'account/index.html'), 'utf8');
  const dom = new JSDOM(accountHtml, { url: 'https://tokosi.test/account/', runScripts: 'outside-only' });
  const window = dom.window;
  window.TKSNav = { can: () => true, authGuard: () => new Promise(() => {}) };
  for (const script of window.document.querySelectorAll('script:not([src])')) {
    if (script.textContent.trim()) window.eval(script.textContent);
  }
  const catalog = { groups: [{ key: 'stockLocations', label: 'Vị trí hàng' }], features: [{ key: 'stockLocations.view', groupKey: 'stockLocations', label: 'Xem vị trí hàng', forbiddenRoles: ['Khách'] }] };
  window.renderPermissionsForm(catalog, { username: 'guest', vaiTro: 'Khách', defaults: [], overrides: { 'stockLocations.view': true } });
  assert.equal(window.document.querySelector('#permGroups select').disabled, true);
  assert.equal(window.document.querySelector('#permGroups .perm-select'), null);
  window.renderPermissionsForm(catalog, { username: 'staff', vaiTro: 'Nhân viên kho', defaults: ['stockLocations.view'], overrides: {} });
  const select = window.document.querySelector('#permGroups .perm-select');
  assert.ok(select);
  assert.equal(select.disabled, false);
  assert.equal(select.value, 'default');
  dom.window.close();
});
