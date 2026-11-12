'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions, PAGE_FEATURES } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'vat-lookup/index.html'), 'utf8');
const code = fs.readFileSync(path.join(publicDir, 'vat-lookup/vat-lookup.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const META = { loadedAt: '2026-10-23T02:00:00Z', stale: false, products: 3142, source: 'Gộp VAT 8435 dòng · Khớp mã 2998 dòng · DK về 2 8052 dòng' };

function searchResponse(extra = {}) {
  return {
    meta: META, queries: ['TALEWS'], ignoredCount: 0, productCount: 1, matchedQueries: ['TALEWS'], notFoundQueries: [],
    vat: { total: 1, rows: [{ maKiot: 'TALEWS', tenKiot: 'BÚT NHUỘM TÓC SUAKE (OD)', maVat: 'VAT11629', tenVat: 'Bút VAT', tenHang: 'Bút chấm chân tóc', dvt: 'Cái', tongThueMat: '8.00%', tonDauNgay: 2268, tonCoTheNhap: 1200.5, conVAT: true, hasIncoming: true }] },
    incoming: { total: 1, extraKeys: [], debug: [], rows: [{ cont: '10-10Y', maKiot: 'TALEWS', tenKiot: 'BÚT NHUỘM TÓC SUAKE (OD)', trangThaiSo: 1, trangThai: 'Đang chờ khai', soLuong: 972, hasSoLuong: true, extra: {} }] },
    ...extra
  };
}

async function setup(t, { vaiTro = 'Nhân viên sale', featurePermissions = {}, responses = {} } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vat-lookup/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const user = { id: 'u1', vaiTro, branch: 'Cả hai', permissions: resolvePermissions({ vaiTro, featurePermissions }), pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  const handlers = { 'GET /meta': { status: 200, data: META }, 'POST /refresh': { status: 200, data: META }, 'POST /search': { status: 200, data: searchResponse() }, ...responses };
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    const key = `${options.method || 'GET'} ${parsed.pathname.replace('/api/vat-lookup', '')}`;
    const body = options.body ? JSON.parse(options.body) : undefined;
    // Chi ghi lai API cua trang; API dung chung khac (vd /api/me/table-prefs cua table-controls) tra 404.
    if (parsed.pathname.startsWith('/api/vat-lookup')) calls.push({ key, body });
    const handler = handlers[key];
    const result = (typeof handler === 'function' ? handler(body) : handler) || { status: 404, data: {} };
    return { ok: result.status < 400, status: result.status, json: async () => JSON.parse(JSON.stringify(result.data)) };
  };
  window.eval(code);
  await window.TKSVatLookup.init();
  await tick();
  return { window, doc: window.document, calls };
}

async function submit(window, doc, value) {
  doc.getElementById('vlQuery').value = value;
  doc.getElementById('vlForm').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await tick();
  await tick();
}

test('mo trang: doc truoc sheet (khong hien dong nguon / nut Cap nhat), o tim kiem trong thi hien huong dan; thanh tab Ke toan cua Sale', async t => {
  const { doc, calls } = await setup(t);
  assert.deepEqual(calls.map(c => c.key), ['GET /meta']);
  assert.equal(doc.getElementById('vlSource'), null);
  assert.equal(doc.getElementById('vlRefresh'), null);
  assert.match(doc.getElementById('vlResults').textContent, /Nhập mã Kiot hoặc tên Kiot/);
  // Sale khong co Xu ly hoa don: thanh tab con Tao QR / Tra cuu VAT / ORDER VAT, dang o Tra cuu VAT.
  assert.deepEqual([...doc.querySelectorAll('#vlTabs a')].map(a => a.getAttribute('href')), ['/vat-draft/#tao-qr', '/vat-lookup/', '/vat-request/']);
  assert.equal(doc.querySelector('#vlTabs [aria-current="page"]').getAttribute('href'), '/vat-lookup/');
  assert.ok(doc.querySelector('#sidebar a[href="/vat-lookup/"]'), 'menu Ke toan co muc Tra cuu VAT');
});

test('tim kiem: gui nguyen noi dung o tim kiem, ve bang Hang VAT co san voi badge va so dinh dang en-US', async t => {
  const { window, doc, calls } = await setup(t);
  await submit(window, doc, 'TALEWS');
  assert.deepEqual(calls.at(-1), { key: 'POST /search', body: { q: 'TALEWS',vatPage:1,vatPageSize:100,vatSorts:[],incomingPage:1,incomingPageSize:100,incomingSorts:[] } });
  const table = doc.querySelector('#vlResults table');
  assert.equal(table.dataset.tableKey, 'vat-lookup-vat-v2');
  const cells = [...table.querySelectorAll('tbody td')].map(td => td.textContent.trim());
  assert.deepEqual(cells.slice(0, 9), ['TALEWS', 'BÚT NHUỘM TÓC SUAKE (OD)', 'VAT11629', 'Bút VAT', 'Bút chấm chân tóc', 'Cái', '8.00%', '2,268', '1,200.5']);
  assert.match(cells[9], /Còn VAT/);
  assert.match(cells[9], /Chuẩn bị về/);
  assert.equal(doc.getElementById('vlCountVat').textContent, '1');
  assert.equal(doc.getElementById('vlCountIncoming').textContent, '1');
});

test('tab Hang sap ve: doi tab khong goi lai server', async t => {
  const { window, doc, calls } = await setup(t);
  await submit(window, doc, 'TALEWS');
  const before = calls.length;
  doc.getElementById('vlTabIncoming').click();
  assert.equal(calls.length, before);
  assert.equal(doc.getElementById('vlTabIncoming').getAttribute('aria-selected'), 'true');
  const cells = [...doc.querySelectorAll('#vlResults tbody td')].map(td => td.textContent.trim());
  assert.deepEqual(cells, ['10-10Y', 'TALEWS', 'BÚT NHUỘM TÓC SUAKE (OD)', 'Đang chờ khai', '972']);
});

test('khong co hang sap ve: liet ke dong DK ve 2 de thay ly do; tu khoa khong tim thay duoc bao', async t => {
  const data = searchResponse({
    queries: ['BDC-PT1B', 'khongco'], matchedQueries: ['BDC-PT1B'], notFoundQueries: ['khongco'],
    incoming: { total: 0, rows: [], extraKeys: [], debug: [{ maKiot: 'BDC-PT1B', trangThai: '10. Đã nhập Kiot', rowNumber: 6 }] }
  });
  const { window, doc } = await setup(t, { responses: { 'POST /search': { status: 200, data } } });
  await submit(window, doc, 'BDC-PT1B\nkhongco');
  assert.match(doc.getElementById('vlResults').textContent, /Không tìm thấy 1:\s*khongco/);
  doc.getElementById('vlTabIncoming').click();
  const text = doc.getElementById('vlResults').textContent;
  assert.match(text, /10\. Đã nhập Kiot/);
  assert.match(text, /Không có hàng chuẩn bị về/);
});

test('Enter de tim, Ctrl+Enter xuong dong', async t => {
  const { window, doc, calls } = await setup(t);
  const input = doc.getElementById('vlQuery');
  input.value = 'A';
  input.setSelectionRange(1, 1);
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.equal(input.value, 'A\n');
  assert.ok(!calls.some(c => c.key === 'POST /search'));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await tick();
  assert.ok(calls.some(c => c.key === 'POST /search'));
});

test('Sheets loi: hien thong bao loi cua server, khong ve bang', async t => {
  const failure = { status: 503, data: { error: "Sheet 'DK về 2' chỉ trả về lỗi công thức #REF!", code: 'DK_VE_REF_ERROR' } };
  const { window, doc } = await setup(t, { responses: { 'POST /search': failure } });
  await submit(window, doc, 'TALEWS');
  assert.match(doc.getElementById('vlResults').textContent, /#REF!/);
  assert.equal(doc.querySelector('#vlResults table'), null);
});

test('Sheets loi nhung con ban da luu: bao ngay tren ket qua', async t => {
  const data = searchResponse({ meta: { ...META, stale: true } });
  const { window, doc } = await setup(t, { responses: { 'POST /search': { status: 200, data } } });
  await submit(window, doc, 'TALEWS');
  assert.match(doc.querySelector('#vlResults .vl-feedback').textContent, /Sheets đang lỗi/);
  assert.ok(doc.querySelector('#vlResults table'));
});

test('file trung gian loi, da doc file goc: bao tab nao doc tu file goc', async t => {
  const data = searchResponse({ meta: { ...META, fallbackTabs: ['Gộp VAT', 'DK về 2'] } });
  const { window, doc } = await setup(t, { responses: { 'POST /search': { status: 200, data } } });
  await submit(window, doc, 'TALEWS');
  assert.match(doc.querySelector('#vlResults .vl-feedback').textContent, /File trung gian đang lỗi, Gộp VAT, DK về 2 đọc từ file gốc VAT TKS/);
  assert.ok(doc.querySelector('#vlResults table'));
});

test('thanh tab Ke toan: Quan ly thay du 4 muc; thieu quyen ORDER VAT thi an muc do', async t => {
  const { doc } = await setup(t, { vaiTro: 'Quản lý' });
  assert.deepEqual([...doc.querySelectorAll('#vlTabs a')].map(a => a.textContent.trim()), ['Xử lý hóa đơn', 'Tạo QR', 'Tra cứu VAT', 'ORDER VAT']);
  const limited = await setup(t, { featurePermissions: { 'accounting.vatRequest': false } });
  assert.equal(limited.doc.querySelector('#vlTabs a[href="/vat-request/"]'), null);
  assert.equal(limited.doc.getElementById('vlOrderLink'), null, 'bo nut ORDER VAT o dau trang (da co trong thanh tab)');
});

test('bang tren may tinh co data-table-fit=fill de vua khung lan dau (khong co thanh cuon ngang)', async t => {
  const { window, doc } = await setup(t);
  await submit(window, doc, 'TALEWS');
  assert.equal(doc.querySelector('#vlResults table').dataset.tableFit, 'fill');
  doc.getElementById('vlTabIncoming').click();
  assert.equal(doc.querySelector('#vlResults table').dataset.tableFit, 'fill');
});

test('nut Cot hien thi o hang tab, an khi chua co bang; khong con dong tom tat ket qua', async t => {
  const { window, doc } = await setup(t);
  const columns = doc.getElementById('vlColumns');
  assert.equal(columns.hidden, true);
  await submit(window, doc, 'TALEWS');
  assert.equal(columns.hidden, false);
  assert.ok(columns.classList.contains('tks-columns-button'), 'table-controls gan nut vao #vlColumns');
  assert.equal(doc.querySelector('#vlResults .tks-table-tools'), null, 'khong tao them hang cong cu tren bang');
  assert.doesNotMatch(doc.querySelector('.vl-panel').textContent, /Tìm thấy 1 sản phẩm/);
});


test('remote VAT tables page independently, send full input/multi-sort, keep total badges and shared column preferences',async t=>{
  const {window,doc,calls}=await setup(t,{responses:{'POST /search':body=>{
    const result=searchResponse();
    result.vat={...result.vat,total:640,totalRows:640,page:body.vatPage,pageSize:100};
    result.incoming={...result.incoming,total:630,totalRows:630,page:body.incomingPage,pageSize:100,extraKeys:['Late column']};
    return {status:200,data:result};
  }}});
  await submit(window,doc,'TALEWS\nOTHER');
  assert.equal(doc.getElementById('vlCountVat').textContent,'640');assert.equal(doc.getElementById('vlCountIncoming').textContent,'630');
  assert.equal(doc.querySelector('#vlResults table').hasAttribute('data-table-sort'),false);
  doc.querySelector('#vlResults [aria-label="Trang sau"]').click();await tick();await tick();
  assert.equal(calls.at(-1).body.vatPage,2);assert.equal(calls.at(-1).body.incomingPage,1);assert.equal(calls.at(-1).body.q,'TALEWS\nOTHER');
  doc.querySelector('#vlResults [data-sort="tonCoTheNhap"]').click();await tick();await tick();
  assert.deepEqual(calls.at(-1).body.vatSorts,[{key:'tonCoTheNhap',dir:'asc'}]);assert.equal(calls.at(-1).body.vatPage,1);
  doc.querySelector('#vlResults [data-sort="maKiot"]').dispatchEvent(new window.MouseEvent('click',{bubbles:true,shiftKey:true}));await tick();await tick();
  assert.deepEqual(calls.at(-1).body.vatSorts,[{key:'tonCoTheNhap',dir:'asc'},{key:'maKiot',dir:'asc'}]);
  const before=calls.length;doc.getElementById('vlTabIncoming').click();assert.equal(calls.length,before);
  assert.match(doc.querySelector('#vlResults table thead').textContent,/Late column/);
  doc.querySelector('#vlResults [aria-label="Trang cuối"]').click();await tick();await tick();
  assert.equal(calls.at(-1).body.incomingPage,7);assert.equal(calls.at(-1).body.vatPage,1);
  assert.equal(doc.getElementById('vlQuery').value,'TALEWS\nOTHER');assert.ok(doc.getElementById('vlColumns').classList.contains('tks-columns-button'));
});

test('typing VAT input debounces requests and clearing/new searches discard stale success and errors',async t=>{
  const {window,doc}=await setup(t), requests=[], delayed=new Map();
  const original=window.fetch;
  window.fetch=async(url,options)=>{
    if(!url.endsWith('/search'))return original(url,options);
    const body=JSON.parse(options.body);requests.push({body,signal:options.signal});
    if(body.q.startsWith('slow'))return new Promise(resolve=>delayed.set(body.q,resolve));
    return {ok:true,status:200,json:async()=>searchResponse({queries:[body.q],vat:{total:1,totalRows:1,page:1,pageSize:100,rows:[{maKiot:body.q,tonDauNgay:1,tonCoTheNhap:1}]}})};
  };
  const input=doc.getElementById('vlQuery'),type=value=>{input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}));};
  const pause=()=>new Promise(resolve=>setTimeout(resolve,300));
  type('s');type('sl');type('slow-success');assert.equal(requests.length,0);await pause();assert.equal(requests.length,1);
  type('');assert.equal(requests[0].signal.aborted,true);assert.match(doc.getElementById('vlResults').textContent,/Nhập mã Kiot/);
  delayed.get('slow-success')({ok:true,status:200,json:async()=>searchResponse()});await tick();assert.match(doc.getElementById('vlResults').textContent,/Nhập mã Kiot/);assert.equal(doc.getElementById('vlSubmit').disabled,false);
  type('slow-error');await pause();type('latest');await pause();
  assert.match(doc.querySelector('#vlResults tbody').textContent,/latest/);
  delayed.get('slow-error')({ok:false,status:503,json:async()=>({error:'STALE ERROR'})});await tick();
  assert.doesNotMatch(doc.getElementById('vlResults').textContent,/STALE ERROR/);assert.match(doc.querySelector('#vlResults tbody').textContent,/latest/);
  assert.equal(requests.at(-1).body.vatPage,1);assert.equal(doc.getElementById('vlSubmit').disabled,false);
});
