'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions, PAGE_FEATURES } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'vt-positions/index.html'), 'utf8');
const code = fs.readFileSync(path.join(publicDir, 'vt-positions/vt-positions.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

const row = (id, extra = {}) => ({
  id, code: 'MA' + id, name: 'Hàng ' + id, notes: '2T x 100', arrivalDate: '', location: 'K' + id,
  quantity: 200, held: 0, available: 200, kiotQuantity: 350, warnings: [], updatedByName: 'Quản lý', updatedAt: '2026-10-27T02:30:00.000Z', version: 3, ...extra
});
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

// handlers: hàm (url, options, parsed) trả về response giả cho các lệnh không phải GET danh sách.
async function setup(t, { branch = 'Cả hai', hash = '', data = { HN: [row(1)], SG: [row(2)] }, canEdit = true, canExport = false, permissions, handler, width = 1024, eventSource } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vt-positions/' + hash, runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true });
  const media = { matches: width <= 600, addEventListener() {} };
  window.matchMedia = () => media;
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/carton.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const base = resolvePermissions({ vaiTro: 'Quản lý' });
  const user = {
    vaiTro: 'Quản lý', branch,
    permissions: permissions || [...new Set([...base, 'stockLocationsV2.view', 'stockLocationsV2.edit'])],
    pageFeatures: PAGE_FEATURES
  };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return json({ tables: {} });
    const method = options.method || 'GET';
    calls.push({ method, path: parsed.pathname, query: parsed.searchParams, options });
    if (handler) { const answer = await handler(url, options, parsed); if (answer) return answer; }
    if (method === 'GET' && parsed.pathname === '/api/stock-positions') {
      const target = parsed.searchParams.get('branch');
      const all = data[target];
      let rows = all.filter(row => [row.code,row.name,row.location].join(' ').toLowerCase().includes((parsed.searchParams.get('q') || '').toLowerCase()));
      const sorts = JSON.parse(parsed.searchParams.get('sorts') || '[]');
      if(sorts.length) rows = rows.slice().sort((a,b)=>(a[sorts[0].key]-b[sorts[0].key])*(sorts[0].dir==='desc'?-1:1));
      const pageSize = Number(parsed.searchParams.get('pageSize')) || 100;
      const page = Math.min(Number(parsed.searchParams.get('page')) || 1,Math.max(1,Math.ceil(rows.length/pageSize)));
      return json({ branch: target, canEdit, canExport, rows: rows.slice((page-1)*pageSize,page*pageSize), totalRows:rows.length,page,pageSize,summary:{totalRows:all.length,warned:0,valid:all.length},warningCounts:{} });
    }
    if (method === 'POST' && parsed.pathname === '/api/stock-positions/export') {
      return { ok: true, status: 200, headers: { get: name => (name === 'Content-Disposition' ? 'attachment; filename="VT-HN-2026.xlsx"' : null) }, blob: async () => ({ size: 3 }) };
    }
    if (handler) { const answer = await handler(url, options, parsed); if (answer) return answer; }
    return json({ error: 'Không có mock', code: 'NO_MOCK' }, 500);
  };
  if (eventSource) { window.EventSource = eventSource; Object.defineProperty(window.document, 'hidden', { value: false, configurable: true }); }
  window.eval(code);
  window.TKSVtPositions.live.debounceMs = 10;
  await window.TKSVtPositions.init();
  return {
    window, calls, doc: window.document,
    changeTab: async tab => {
      const event = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true }));
      window.location.hash = tab;
      await event;
      await tick();
    }
  };
}


test('remote VT list pages and sorts all matches, searches late hits and exports full query', async t => {
 const rows=Array.from({length:205},(_,i)=>row(i+1,{quantity:i+1,available:i+1}));
 const {window,doc,calls}=await setup(t,{data:{HN:rows,SG:[]},canExport:true});
 assert.equal(doc.querySelectorAll('#vtRows tr').length,100);
 assert.match(doc.getElementById('vtCount').textContent,/205/);
 doc.getElementById('vtNext').click();await settle();
 assert.equal(doc.querySelector('#vtRows tr').dataset.id,'101');
 doc.querySelector('[data-sort-field="quantity"]').click();await settle();
 doc.querySelector('[data-sort-field="quantity"]').click();await settle();
 assert.equal(doc.querySelector('#vtRows tr').dataset.id,'205');
 const input=doc.getElementById('vtSearch');input.value='K205';input.dispatchEvent(new window.Event('input'));
 await new Promise(resolve=>setTimeout(resolve,350));await settle();
 assert.equal(doc.querySelectorAll('#vtRows tr').length,1);
 assert.equal(doc.querySelector('#vtRows tr').dataset.id,'205');
 window.URL.createObjectURL=()=> 'blob:test';window.URL.revokeObjectURL=()=>{};window.HTMLAnchorElement.prototype.click=function(){};
 doc.getElementById('vtExportButton').click();await settle();
 const exported=calls.find(call=>call.path.endsWith('/export'));
 assert.equal(JSON.parse(exported.options.body).query.q,'K205');
 assert.equal(JSON.parse(exported.options.body).ids,undefined);
});

test('remote VT history searches beyond loaded page and counts full matches', async t => {
 const entry={id:1,createdAt:'2026-11-01T00:00:00Z',code:'AAA1',location:'K1',action:'edit',field:'notes',oldValue:'1Tx10',newValue:'2Tx10',actorName:'Nguyễn An'};
 const {window,doc,calls}=await setup(t,{handler:async(url,options,parsed)=>{
   if(parsed.pathname==='/api/stock-positions/history') return json({rows:parsed.searchParams.get('q')?[entry]:[],totalRows:parsed.searchParams.get('q')?1:205,page:1,pageSize:200,nextBefore:null});
 }});
 doc.getElementById('vtHistoryButton').click();await settle();
 const input=doc.getElementById('vtHistorySearch');input.value='Nguyen An';input.dispatchEvent(new window.Event('input'));
 await new Promise(resolve=>setTimeout(resolve,350));await settle();
 const query=calls.filter(call=>call.path.endsWith('/history')).at(-1).query;
 assert.equal(query.get('q'),'Nguyen An');assert.equal(query.get('page'),'1');
 assert.match(doc.getElementById('vtHistoryRows').textContent,/Nguyễn An/);
 assert.match(doc.getElementById('vtHistorySubtitle').textContent,/1 thay đổi/);
});

class FakeEventSource {
 constructor(url) { this.url = url; this.listeners = {}; FakeEventSource.instances.push(this); }
 addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
 close() { this.closed = true; }
 emit(type) { (this.listeners[type] || []).forEach(fn => fn({})); }
}

test('remote VT SSE refresh keeps page, search and sort of the current query', async t => {
 FakeEventSource.instances = [];
 const rows = Array.from({ length: 205 }, (_, i) => row(i + 1, { quantity: i + 1, available: i + 1 }));
 const { window, doc, calls } = await setup(t, { data: { HN: rows, SG: [] }, eventSource: FakeEventSource });
 doc.querySelector('[data-sort-field="quantity"]').click(); await settle();
 doc.getElementById('vtNext').click(); await settle();
 const input = doc.getElementById('vtSearch'); input.value = 'K1'; input.dispatchEvent(new window.Event('input'));
 await new Promise(resolve => setTimeout(resolve, 350)); await settle();
 doc.getElementById('vtNext').click(); await settle();
 const before = calls.filter(call => call.method === 'GET' && call.path === '/api/stock-positions').length;
 rows[150].kiotQuantity = 999;
 FakeEventSource.instances.at(-1).emit('positions-changed');
 await new Promise(resolve => setTimeout(resolve, 60)); await settle();
 const lists = calls.filter(call => call.method === 'GET' && call.path === '/api/stock-positions');
 assert.equal(lists.length, before + 1, 'one background reload');
 const query = lists.at(-1).query;
 assert.equal(query.get('page'), '2');
 assert.equal(query.get('q'), 'K1');
 assert.deepEqual(JSON.parse(query.get('sorts')), [{ key: 'quantity', dir: 'asc' }]);
 assert.equal(doc.getElementById('vtSearch').value, 'K1');
 assert.match(doc.getElementById('vtCount').textContent, /101–111 \/ 111/);
});

test('remote VT version conflict on page 2 reloads the same page and query, never page 1', async t => {
 const rows = Array.from({ length: 205 }, (_, i) => row(i + 1));
 const { doc, calls } = await setup(t, { data: { HN: rows, SG: [] }, handler: async (url, options, parsed) => {
   if (options.method === 'PATCH') return json({ error: 'Dòng đã bị người khác sửa.', code: 'VERSION_CONFLICT' }, 409);
 } });
 doc.getElementById('vtNext').click(); await settle();
 const td = doc.querySelector('#vtRows tr[data-id="101"] td[data-field="notes"]');
 td.click(); await settle();
 const input = td.querySelector('input.vt-inline');
 input.value = '5T x 100';
 input.blur(); await settle(); await settle();
 const patch = calls.find(call => call.method === 'PATCH');
 assert.equal(patch.path, '/api/stock-positions/101');
 assert.equal(JSON.parse(patch.options.body).version, 3);
 const reload = calls.filter(call => call.method === 'GET' && call.path === '/api/stock-positions').at(-1);
 assert.equal(reload.query.get('page'), '2');
 assert.equal(doc.querySelector('#vtRows tr').dataset.id, '101');
 assert.match(doc.getElementById('vtNotice')?.textContent || doc.body.textContent, /người khác sửa/);
});
