'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { edgeScrollDelta, EDIT_COLUMNS } = require('../public/stocktake/stocktakeGrid');

const root = path.join(__dirname, '../public/stocktake');

// Bang that trong jsdom: mock fetch tra 1 dot + rowCount dong. Moi lenh ghi (POST/PATCH) duoc ghi vao `posts`.
async function pageFixture(t, { rowCount = 3, status = 'open', canEdit = true, fetchHandler } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://tokosi.test/stocktake/', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.eval(fs.readFileSync(path.join(root, '../shared/table-controls.js'), 'utf8'));
  w.TKSNav = { authGuard: async () => ({}), renderTopSidebar() {} };
  const session = { id: 1, name: 'T11', branch: 'hanoi', status, cancelled: false, source: 'web' };
  const rows = Array.from({ length: rowCount }, (_, i) => ({ code: 'SP' + (i + 1), name: 'Hàng ' + (i + 1), counted: i + 1, stock: i + 1, note: null, lines: [] }));
  const posts = [];
  w.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method !== 'GET') posts.push(JSON.parse(options.body));
    const custom = fetchHandler && fetchHandler(url, options);
    const body = custom || (/\/board/.test(url) ? { session, rows, totals: { diffValue: 0 }, canEdit, canClose: false }
      : /\/cells/.test(url) ? { applied: [], conflicts: [], skipped: {}, notes: [], tags: [] }
      : /\/sessions(\?|$)/.test(url) ? { sessions: [session], canEdit, canClose: false }
      : { history: [], lines: [] });
    return { ok: true, json: async () => body };
  };
  for (const file of ['stocktakePaste.js', 'stocktakeSearch.js', 'stocktakeGrid.js', 'stocktakeStatus.js', 'stocktake.js']) {
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  await w.TKSStocktake.init();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await sleep(20);
  const heads = Array.from(w.document.querySelectorAll('#stTable thead th'));
  const headCol = key => heads.findIndex(th => th.dataset.field === key);
  const tbody = w.document.getElementById('stRows');
  return {
    w, app: w.TKSStocktake, posts, sleep, tbody, heads, headCol,
    scroller: w.document.querySelector('.st-scroll'),
    cell: (row, key) => tbody.rows[row].cells[headCol(key)],
    // jsdom tinh style cham nen mot nhip ve vung chon co the mat >100ms: cho den khi dieu kien dung (toi da 2s).
    until: async condition => { for (let i = 0; i < 100 && !condition(); i++) await sleep(20); },
    mouse: (type, init = {}) => new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init))
  };
}

test('edgeScrollDelta: 0 giua khung, tang theo muc vao vung nguong, co tran hai dau', () => {
  const d = pointer => edgeScrollDelta(pointer, 0, 300);
  assert.equal(d(150), 0);
  assert.equal(d(260), 0);
  assert.equal(d(280), 14);
  assert.equal(d(299), 28);
  assert.equal(d(900), 28);
  assert.equal(d(40), 0);
  assert.equal(d(20), -14);
  assert.equal(d(-500), -28);
});

test('fixture: ve du dong va cot theo khoa', async t => {
  const f = await pageFixture(t, { rowCount: 5 });
  assert.equal(f.tbody.rows.length, 5);
  assert.equal(f.cell(0, 'code').textContent, 'SP1');
  assert.ok(f.headCol('reason') > f.headCol('code'));
  assert.ok(Object.keys(EDIT_COLUMNS).every(key => f.headCol(key) >= 0));
});

test('keo chon o toi mep duoi: bang tu cuon, vung chon di theo, tha chuot thi dung', async t => {
  const f = await pageFixture(t, { rowCount: 60 });
  const { w, app, scroller } = f;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800 });
  w.document.elementFromPoint = () => f.cell(25, 'counted');
  f.cell(0, 'counted').dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 299, buttons: 1 }));
  await f.until(() => scroller.scrollTop > 28);
  assert.ok(scroller.scrollTop > 28, 'scrollTop=' + scroller.scrollTop);
  assert.equal(app.selection.focus.row, 25);
  assert.equal(app.selection.anchor.row, 0);
  w.document.dispatchEvent(f.mouse('mouseup'));
  const stopped = scroller.scrollTop;
  await f.sleep(100);
  assert.equal(scroller.scrollTop, stopped);
});

test('keo chon o giua khung: khong cuon', async t => {
  const f = await pageFixture(t, { rowCount: 60 });
  f.scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800 });
  f.cell(0, 'counted').dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  f.w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 150, buttons: 1 }));
  await f.sleep(100);
  assert.equal(f.scroller.scrollTop, 0);
  f.w.document.dispatchEvent(f.mouse('mouseup'));
});

test('nha chuot ngoai cua so (mousemove buttons=0) thi dung cuon', async t => {
  const f = await pageFixture(t, { rowCount: 60 });
  f.scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800 });
  f.cell(0, 'counted').dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  f.w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 299, buttons: 1 }));
  await f.sleep(80);
  f.w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 299, buttons: 0 }));
  const stopped = f.scroller.scrollTop;
  await f.sleep(100);
  assert.equal(f.scroller.scrollTop, stopped);
  assert.equal(f.app.selection.dragging, false);
});

test('keo nut dien toi mep duoi: bang cung tu cuon', async t => {
  const f = await pageFixture(t, { rowCount: 60 });
  const { w, scroller } = f;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800 });
  w.document.elementFromPoint = () => null; // to = null -> tha chuot khong ghi gi
  f.cell(0, 'reason').dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  w.document.dispatchEvent(f.mouse('mouseup'));
  const handle = w.document.querySelector('.st-fill');
  assert.ok(handle, 'co nut dien');
  handle.dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 299, buttons: 1 }));
  await f.until(() => scroller.scrollTop > 28);
  assert.ok(scroller.scrollTop > 28, 'scrollTop=' + scroller.scrollTop);
  w.document.dispatchEvent(f.mouse('mouseup'));
  const stopped = scroller.scrollTop;
  await f.sleep(100);
  assert.equal(scroller.scrollTop, stopped);
  assert.equal(f.posts.length, 0);
});

test('tieu de cot sua duoc co class st-th-edit va bang bao dang sua duoc', async t => {
  const f = await pageFixture(t);
  const marked = f.heads.filter(th => th.classList.contains('st-th-edit')).map(th => th.dataset.field).sort();
  assert.deepEqual(marked, Object.keys(EDIT_COLUMNS).sort());
  assert.equal(f.w.document.getElementById('stTable').dataset.editable, 'true');
});

test('dot da dong hoac tai khoan chi xem: bang khong bao sua duoc (tieu de khong to mau)', async t => {
  for (const options of [{ status: 'closed' }, { canEdit: false }]) {
    const f = await pageFixture(t, options);
    assert.equal(f.w.document.getElementById('stTable').dataset.editable, 'false', JSON.stringify(options));
  }
});

test('CSS: tieu de cot sua duoc dung nen ho phach, tieu de dang sap xep dam hon', () => {
  const css = fs.readFileSync(path.join(root, 'stocktake.css'), 'utf8');
  assert.match(css, /#stTable\[data-editable="true"\] thead th\.st-th-edit\{[^}]*background:#b45309/);
  assert.match(css, /th\.st-th-edit\[data-sort-active="true"\]\{[^}]*background:#92400e/);
});
