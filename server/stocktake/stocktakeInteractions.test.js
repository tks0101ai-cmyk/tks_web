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
