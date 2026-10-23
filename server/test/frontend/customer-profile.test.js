'use strict';

// Bang "Doanh so theo khach" (tab Khach hang): cot Ghi chu (nut Chi tiet) + Tiep khach lan cuoi, hop Chi tiet khach
// (Thong tin chung / Note kieu tin nhan / khoi Quan ly) va lich chon nhieu ngay. API gia lap theo dung hop dong
// /api/business-report/customer-meta va /customer-profile* (backend lam song song).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const svc = require('../../businessReport/businessReportService');
const { serviceSnapshot } = require('../../businessReport/testFixtures');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(r => setImmediate(r)); };
const KEY = 'chị a';
const openPages = [];
test.afterEach(() => openPages.splice(0).forEach(dom => dom.window.close()));

function baseProfile(overrides = {}) {
  return Object.assign({
    key: KEY, name: 'Chị A', today: '2026-10-06', canEdit: true, canManage: true,
    profile: { warehouseLocation: 'Kho Cầu Giấy', warehouseCount: 2, area: '250 m²', warehouseScale: 'small', competitor: 'Tem X', salesChannels: ['san'] },
    images: [{ id: 'img1', url: '/api/business-report/customer-profile/images/img1', contentType: 'image/jpeg', byteSize: 10, createdAt: '2026-10-01T03:00:00.000Z' }],
    notes: [
      { id: 'n2', noteDate: '2026-10-06', body: 'Hôm nay gọi khách', authorId: 'u1', authorName: 'Khang', createdAt: '2026-10-06T03:05:00.000Z', updatedAt: '2026-10-06T03:05:00.000Z', editable: true },
      { id: 'n1', noteDate: '2026-10-01', body: 'Note cũ', authorId: 'u2', authorName: 'Trinh', createdAt: '2026-10-01T02:00:00.000Z', updatedAt: '2026-10-01T02:00:00.000Z', editable: false }
    ],
    visitDays: ['2026-10-01', '2026-10-03'], lastVisit: '2026-10-03', editors: [{ userId: 'u9', userName: 'Sale Một' }]
  }, overrides);
}

function createPage({ can = () => true, profile = baseProfile(), meta, metaFails = false, hash = '#business' } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/reports/' + hash });
  openPages.push(dom);
  const win = dom.window;
  win.HTMLCanvasElement.prototype.getContext = () => ({});
  win.Chart = class FakeChart {
    static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } };
    constructor(context, config) { this.config = config; }
    destroy() {}
  };
  win.setInterval = () => 1;
  win.requestAnimationFrame = cb => { if (win.document) cb(); };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  win.confirm = () => true;
  win.TKSNav = { authGuard: () => new Promise(() => {}), can, handleBranchError: () => false, renderTopSidebar() {} };
  win.TKSImageCompress = { compress: async file => new win.Blob(['jpeg-bytes'], { type: 'image/jpeg' }) };

  const server = {
    profile, requests: [],
    meta: meta || { [KEY]: { lastVisit: '2026-10-03', noteCount: 2 }, 'anh b': { lastVisit: null, noteCount: 0 } },
    users: [{ id: 'u9', hoTen: 'Sale Một', vaiTro: 'Nhân viên Sale' }, { id: 'u8', hoTen: 'Sale Hai', vaiTro: 'Nhân viên Sale' }],
    failNext: null
  };
  const snap = serviceSnapshot();
  const respond = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(body)) });
  win.fetch = (url, opts = {}) => {
    const href = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    server.requests.push({ href, method, opts });
    const [pathname] = href.split('?');
    if (!href.startsWith('/api/business-report/')) return new Promise(() => {});
    if (server.failNext && server.failNext.test(method + ' ' + pathname)) {
      const failure = server.failNext.response;
      server.failNext = null;
      return respond(failure.status, failure.body);
    }
    const sub = pathname.slice('/api/business-report/'.length);
    if (sub === 'customer-meta') return metaFails ? respond(500, { error: 'boom' }) : respond(200, { customers: server.meta });
    if (sub === 'sales') return respond(200, svc.buildSaleReport(snap));
    if (sub === 'customers') return respond(200, svc.buildCustomerReport(snap));
    if (sub === 'products') return respond(200, svc.buildProductReport(snap));
    if (sub === 'overview') return respond(200, svc.buildOverview(snap));
    if (sub === 'customer-profile' && method === 'GET') return respond(200, server.profile);
    if (sub === 'customer-profile' && method === 'PUT') {
      const body = JSON.parse(opts.body);
      Object.assign(server.profile.profile, { warehouseLocation: body.warehouseLocation, warehouseCount: body.warehouseCount, area: body.area, competitor: body.competitor, salesChannels: body.salesChannels });
      return respond(200, { profile: server.profile.profile });
    }
    if (sub === 'customer-profile/scale' && method === 'PUT') {
      const body = JSON.parse(opts.body);
      server.profile.profile.warehouseScale = body.warehouseScale;
      return respond(200, { warehouseScale: body.warehouseScale });
    }
    if (sub === 'customer-profile/notes' && method === 'POST') {
      const body = JSON.parse(opts.body);
      const note = { id: 'n3', noteDate: server.profile.today, body: body.body, authorId: 'u1', authorName: 'Khang', createdAt: '2026-10-06T04:00:00.000Z', updatedAt: '2026-10-06T04:00:00.000Z', editable: true };
      server.profile.notes.unshift(note);
      return respond(201, { note });
    }
    if (sub.startsWith('customer-profile/notes/') && method === 'PUT') {
      const id = sub.split('/').pop();
      const body = JSON.parse(opts.body);
      const note = server.profile.notes.find(n => n.id === id);
      note.body = body.body;
      return respond(200, { note });
    }
    if (sub === 'customer-profile/images' && method === 'POST') {
      const image = { id: 'img2', url: '/api/business-report/customer-profile/images/img2', contentType: 'image/jpeg', byteSize: 10, createdAt: '2026-10-06T04:10:00.000Z' };
      server.profile.images.push(image);
      return respond(201, { image });
    }
    if (sub.startsWith('customer-profile/images/') && method === 'DELETE') {
      const id = sub.split('/').pop();
      server.profile.images = server.profile.images.filter(i => i.id !== id);
      return respond(200, { ok: true });
    }
    if (sub === 'customer-profile/visits' && method === 'PUT') {
      const body = JSON.parse(opts.body);
      const days = body.dates.slice().sort();
      server.profile.visitDays = days;
      server.profile.lastVisit = days[days.length - 1] || null;
      return respond(200, { visitDays: days, lastVisit: server.profile.lastVisit });
    }
    if (sub === 'customer-profile/editors' && method === 'PUT') {
      const body = JSON.parse(opts.body);
      const editors = body.userIds.map(id => ({ userId: id, userName: (server.users.find(u => u.id === id) || {}).hoTen || id }));
      return respond(200, { editors });
    }
    if (sub === 'customer-profile/assignable-users') return respond(200, { users: server.users });
    return new Promise(() => {});
  };

  ['pagination.js', 'table-explorer.js'].forEach(file => win.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8')));
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).filter(script => script.trim())
    .forEach(script => win.eval(script));

  const doc = win.document;
  return { dom, win, doc, server, $: id => doc.getElementById(id), run: code => win.eval(code) };
}

async function openBusiness(options) {
  const page = createPage(options);
  page.run("switchView('business')");
  await settle();
  return page;
}

const customerRow = page => [...page.$('businessCustomersRows').querySelectorAll('tr.doc-row')].find(tr => tr.dataset.tableItemId === KEY);
const detailButton = page => customerRow(page).querySelector('.cp-detail-btn');
const calendarButton = page => customerRow(page).querySelector('.cp-cal-btn');
const sent = (page, method, suffix) => page.server.requests.filter(r => r.method === method && r.href.split('?')[0] === '/api/business-report/' + suffix);
const jsonOf = request => JSON.parse(request.opts.body);
const visitCell = page => customerRow(page).querySelector('.cp-visit-wrap');
const fireChange = (page, el) => el.dispatchEvent(new page.win.Event('change', { bubbles: true }));
const fireInput = (page, el, value) => { el.value = value; el.dispatchEvent(new page.win.Event('input', { bubbles: true })); };

async function openProfile(options) {
  const page = await openBusiness(options);
  detailButton(page).click();
  await settle();
  return page;
}

test('co reports.business.customerNotes: 2 cot moi sau Level gia, moi th co data-column-key, so o = so tieu de; ngay trong o + badge so note', async () => {
  const page = await openBusiness();
  const table = page.$('businessCustomersRows').closest('table');
  const ths = [...table.querySelectorAll('thead th')];
  assert.deepEqual(ths.slice(0, 5).map(th => th.dataset.columnKey), ['customer', 'sale', 'priceLevel', 'notes', 'lastVisit']);
  ths.forEach(th => {
    assert.ok(th.dataset.columnKey, 'th thieu data-column-key');
    assert.match(th.getAttribute('style') || '', /width:\s*\d+px/);
  });
  const rows = [...page.$('businessCustomersRows').querySelectorAll('tr.doc-row')];
  assert.ok(rows.length >= 2);
  rows.forEach(tr => assert.equal(tr.cells.length, ths.length, 'so o moi dong = so tieu de'));

  assert.equal(customerRow(page).querySelector('.cp-badge').textContent, '2');
  assert.equal(visitCell(page).querySelector('.cp-visit-date').textContent, '03/10/2026');
  const noMeta = rows.find(tr => tr.dataset.tableItemId === 'anh b');
  assert.equal(noMeta.querySelector('.cp-visit-empty').textContent, 'dd/mm/yyyy');
  assert.equal(noMeta.querySelector('.cp-badge'), null);
  assert.equal(calendarButton(page), null, 'cot ngay chi hien ngay, Quan ly cung khong co nut lich');
});

test('thieu customerNotes: khong co 2 cot, khong co nut, khong goi customer-meta; thieu customerManage: khong co bieu tuong lich', async () => {
  const none = await openBusiness({ can: k => k !== 'reports.business.customerNotes' && k !== 'reports.business.customerManage' });
  const headers = [...none.$('businessCustomersRows').closest('table').querySelectorAll('thead th')].map(th => th.dataset.columnKey);
  assert.equal(headers.includes('notes'), false);
  assert.equal(headers.includes('lastVisit'), false);
  assert.equal(none.$('businessCustomersRows').querySelectorAll('.cp-detail-btn, .cp-cal-btn').length, 0);
  assert.equal(none.server.requests.some(r => r.href.includes('customer-meta')), false);
  [...none.$('businessCustomersRows').querySelectorAll('tr.doc-row')].forEach(tr => assert.equal(tr.cells.length, headers.length));

  const viewer = await openBusiness({ can: k => k !== 'reports.business.customerManage' });
  assert.ok(detailButton(viewer));
  assert.equal(viewer.$('businessCustomersRows').querySelectorAll('.cp-cal-btn').length, 0);
  assert.equal(customerRow(viewer).querySelector('.cp-visit-date').textContent, '03/10/2026');
});

test('customer-meta loi: bang van hien day du, cot hien o trong (fail-soft)', async () => {
  const page = await openBusiness({ metaFails: true });
  assert.ok(customerRow(page), 'bang van ve');
  assert.equal(visitCell(page).querySelector('.cp-visit-empty').textContent, 'dd/mm/yyyy');
  assert.equal(customerRow(page).querySelector('.cp-badge'), null);
});

test('bam Chi tiet: mo hop Chi tiet khach (GET customer-profile?key=), KHONG mo hop chi tiet so lieu; dong hop tra focus ve nut', async () => {
  const page = await openBusiness();
  const button = detailButton(page);
  button.focus();
  button.click();
  await settle();
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.equal(page.server.requests.some(r => r.href.startsWith('/api/business-report/detail')), false, 'khong goi hop so lieu');
  assert.ok(page.server.requests.some(r => r.href === '/api/business-report/customer-profile?key=' + encodeURIComponent(KEY)));
  assert.match(page.$('docModalTitle').textContent, /Chi tiết khách · Chị A/);
  const modal = page.doc.querySelector('#docModalBackdrop .doc-modal');
  assert.ok(modal.classList.contains('is-wide'));
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(page.$('docModalBody').querySelector('.business-summary'), null);

  page.run('closeDocumentDetail()');
  assert.equal(page.$('docModalBackdrop').hidden, true);
  assert.equal(page.doc.activeElement, detailButton(page), 'focus tra ve nut Chi tiet');

  // Bam vung khac cua dong van mo hop so lieu.
  customerRow(page).querySelector('td').click();
  await settle();
  assert.ok(page.server.requests.some(r => r.href.startsWith('/api/business-report/detail?kind=customer')));
});

test('hop Chi tiet: Thong tin chung dien san, nhan hien thi, kenh ban hang la dropdown tick nhieu o', async () => {
  const page = await openProfile();
  const body = page.$('docModalBody');
  const labels = [...body.querySelectorAll('#cpProfileForm label[for], #cpProfileForm .cp-label')].map(l => l.textContent.trim());
  assert.deepEqual(labels, ['Định vị kho', 'Số lượng kho', 'Diện tích', 'Đối thủ (để ý tem)', 'Hình thức bán hàng']);
  assert.equal(page.$('cpWarehouseLocation').value, 'Kho Cầu Giấy');
  assert.equal(page.$('cpWarehouseCount').value, '2');
  assert.equal(page.$('cpWarehouseScale').value, 'small');
  assert.equal(page.$('cpArea').value, '250 m²');
  assert.equal(page.$('cpWarehouseScale').closest('#cpProfileForm'), null);
  assert.deepEqual([...page.$('cpWarehouseScale').options].map(o => o.textContent), ['Chưa có', 'Nhỏ', 'Vừa', 'To', 'Rất to']);
  assert.equal(page.$('cpChannelsBtn').textContent.trim().startsWith('Bán sàn'), true);
  assert.deepEqual([...page.$('cpChannelsPop').querySelectorAll('label')].map(l => l.textContent.trim()),
    ['Bán sàn', 'Bán cửa hàng', 'FB ads', 'FB live', 'Sang tay', 'Kho buôn', 'Khác']);
  const img = body.querySelector('.cp-images img');
  assert.equal(img.getAttribute('loading'), 'lazy');
  assert.ok(img.getAttribute('width') && img.getAttribute('height'));
  assert.ok(body.querySelector('.cp-img-del'));
});

test('dropdown Hinh thuc ban hang: mo/dong bang nut, Esc chi dong danh sach (khong dong hop), bam ngoai dong lai', async () => {
  const page = await openProfile();
  const pop = page.$('cpChannelsPop');
  const btn = page.$('cpChannelsBtn');
  assert.equal(pop.hidden, true);
  btn.click();
  assert.equal(pop.hidden, false);
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  pop.querySelector('input').dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(pop.hidden, true);
  assert.equal(page.$('docModalBackdrop').hidden, false, 'Esc chi dong dropdown');
  btn.click();
  page.doc.body.dispatchEvent(new page.win.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(pop.hidden, true, 'bam ra ngoai dong dropdown');
});

test('Luu thong tin chung: PUT dung payload (nhieu kenh, so luong kho la so), nut vo hieu khi dang gui, toast thanh cong', async () => {
  const page = await openProfile();
  fireInput(page, page.$('cpWarehouseLocation'), '  Kho Hà Đông ');
  fireInput(page, page.$('cpWarehouseCount'), '5');
  fireInput(page, page.$('cpArea'), ' Kho chính 300 m²\nKho phụ 100 m² ');
  fireInput(page, page.$('cpCompetitor'), 'Tem Y');
  page.$('cpChannelsBtn').click();
  const boxes = [...page.$('cpChannelsPop').querySelectorAll('input')];
  boxes.find(b => b.value === 'fb_live').checked = true;
  fireChange(page, boxes.find(b => b.value === 'fb_live'));
  boxes.find(b => b.value === 'kho_buon').checked = true;
  fireChange(page, boxes.find(b => b.value === 'kho_buon'));
  assert.match(page.$('cpChannelsBtn').textContent, /Bán sàn, FB live, Kho buôn/);
  assert.equal(page.$('cpChannelsBtn').querySelector('.cp-ms-count').textContent, '3');

  page.$('cpProfileSave').click();
  assert.equal(page.$('cpProfileSave').disabled, true, 'dang gui -> vo hieu');
  await settle();
  const put = sent(page, 'PUT', 'customer-profile');
  assert.equal(put.length, 1);
  assert.deepEqual(jsonOf(put[0]), {
    key: KEY, warehouseLocation: 'Kho Hà Đông', warehouseCount: 5, area: 'Kho chính 300 m²\nKho phụ 100 m²', competitor: 'Tem Y',
    salesChannels: ['san', 'fb_live', 'kho_buon']
  });
  assert.match(page.doc.getElementById('tksToastStack').textContent, /Đã lưu thông tin chung/);
  assert.equal(page.$('cpProfileSave').disabled, false);
  page.$('businessCustomersSalesChannel').value = 'fb_live';
  fireChange(page, page.$('businessCustomersSalesChannel'));
  assert.deepEqual(Array.from(page.run('businessFilteredCustomers().map(r => r.key)')), [KEY]);
});

test('so luong kho am: bao loi ngay o form, khong goi PUT', async () => {
  const page = await openProfile();
  fireInput(page, page.$('cpWarehouseCount'), '-3');
  page.$('cpProfileSave').click();
  await settle();
  assert.equal(sent(page, 'PUT', 'customer-profile').length, 0);
  assert.equal(page.$('cpProfileError').hidden, false);
  assert.match(page.$('cpProfileError').textContent, /không âm/);
});

test('Note: sap xep moi nhat tren cung, note hom nay co nhan + nut Sua, note cu chi doc, thay khung soan bang goi y', async () => {
  const page = await openProfile();
  const bubbles = [...page.$('cpNotes').querySelectorAll('.cp-bubble')];
  assert.equal(bubbles.length, 2);
  assert.ok(bubbles[0].classList.contains('is-today'));
  assert.match(bubbles[0].textContent, /Hôm nay – có thể sửa/);
  assert.match(bubbles[0].textContent, /Khang/);
  assert.match(bubbles[0].textContent, /06\/10\/2026 10:05/, 'gio Viet Nam (UTC+7)');
  assert.ok(bubbles[0].querySelector('[data-note-action="edit"]'));
  assert.equal(bubbles[1].querySelector('[data-note-action="edit"]'), null);
  assert.equal(page.$('cpNoteForm'), null);
  assert.equal(page.$('cpNoteHint').textContent.trim(), 'Hôm nay đã có note – bạn có thể sửa');
});

test('tao note: chua co note hom nay -> khung soan + Tao note; POST roi hien o dau, doi khung soan thanh goi y, cap nhat badge o bang', async () => {
  const profile = baseProfile();
  profile.notes = profile.notes.slice(1);
  const page = await openProfile({ profile });
  assert.ok(page.$('cpNoteForm'));
  assert.equal(page.$('cpNoteCreate').textContent, 'Tạo note');
  page.$('cpNoteCreate').click();
  await settle();
  assert.equal(sent(page, 'POST', 'customer-profile/notes').length, 0, 'note rong khong gui');
  assert.equal(page.$('cpNoteError').hidden, false);

  page.$('cpNoteBody').value = 'Khách hẹn thứ 6';
  page.$('cpNoteCreate').click();
  assert.equal(page.$('cpNoteCreate').disabled, true);
  await settle();
  const post = sent(page, 'POST', 'customer-profile/notes');
  assert.deepEqual(jsonOf(post[0]), { key: KEY, body: 'Khách hẹn thứ 6' });
  const bubbles = [...page.$('cpNotes').querySelectorAll('.cp-bubble')];
  assert.equal(bubbles[0].querySelector('.cp-bubble-body').textContent, 'Khách hẹn thứ 6');
  assert.equal(page.$('cpNoteForm'), null);
  assert.ok(page.$('cpNoteHint'));
  assert.equal(customerRow(page).querySelector('.cp-badge').textContent, '2', 'badge = so note hien co');
});

test('409 NOTE_EXISTS_TODAY: bao than thien va tai lai danh sach (hien nut Sua thay vi khung soan)', async () => {
  const profile = baseProfile();
  const todayNote = profile.notes.shift();
  const page = await openProfile({ profile });
  assert.ok(page.$('cpNoteForm'));
  // Nguoi khac vua tao note hom nay.
  profile.notes.unshift(todayNote);
  page.server.failNext = Object.assign(/^POST \/api\/business-report\/customer-profile\/notes$/, { response: { status: 409, body: { error: 'Hôm nay đã có note', code: 'NOTE_EXISTS_TODAY' } } });
  page.$('cpNoteBody').value = 'Trùng ngày';
  page.$('cpNoteCreate').click();
  await settle();
  assert.match(page.doc.getElementById('tksToastStack').textContent, /đã có note/);
  assert.equal(page.$('cpNoteForm'), null);
  assert.ok(page.$('cpNotes').querySelector('[data-note-action="edit"]'));
});

test('sua note hom nay: Sua -> PUT /notes/:id; 409 NOTE_LOCKED bao note da qua ngay va tai lai', async () => {
  const page = await openProfile();
  page.$('cpNotes').querySelector('[data-note-action="edit"]').click();
  const field = page.$('cpNoteEdit');
  assert.equal(field.value, 'Hôm nay gọi khách');
  field.value = 'Đã sửa nội dung';
  page.$('cpNotes').querySelector('.cp-edit-form button[type="submit"]').click();
  await settle();
  const put = sent(page, 'PUT', 'customer-profile/notes/n2');
  assert.deepEqual(jsonOf(put[0]), { key: KEY, body: 'Đã sửa nội dung' });
  assert.equal(page.$('cpNotes').querySelector('.cp-bubble.is-today .cp-bubble-body').textContent, 'Đã sửa nội dung');

  page.$('cpNotes').querySelector('[data-note-action="edit"]').click();
  page.$('cpNoteEdit').value = 'Quá muộn';
  page.server.profile.notes[0].editable = false;
  page.server.failNext = Object.assign(/^PUT \/api\/business-report\/customer-profile\/notes\/n2$/, { response: { status: 409, body: { error: 'locked', code: 'NOTE_LOCKED' } } });
  page.$('cpNotes').querySelector('.cp-edit-form button[type="submit"]').click();
  await settle();
  assert.match(page.doc.getElementById('tksToastStack').textContent, /qua ngày/);
  assert.equal(page.$('cpNotes').querySelector('.cp-edit-form'), null, 'thoat che do sua');
  assert.equal(page.$('cpNotes').querySelector('[data-note-action="edit"]'), null);
});

test('khong co quyen sua (canEdit=false): Thong tin chung chi doc, khong khung soan note/nut Sua/them anh/xoa anh/Luu', async () => {
  const profile = baseProfile({ canEdit: false, canManage: false });
  const page = await openProfile({ profile, can: k => k !== 'reports.business.customerManage' });
  const body = page.$('docModalBody');
  assert.equal(body.querySelector('form'), null);
  assert.equal(body.querySelector('#cpProfileSave'), null);
  assert.match(page.$('cpInfo').textContent, /Kho Cầu Giấy/);
  assert.match(page.$('cpInfo').textContent, /Bán sàn/);
  assert.equal(body.querySelector('[data-note-action="edit"]'), null);
  assert.equal(body.querySelector('#cpNoteForm'), null);
  assert.equal(body.querySelector('#cpImageAdd'), null);
  assert.equal(body.querySelector('.cp-img-del'), null);
  assert.ok(body.querySelector('.cp-img-open'), 'van phong to anh xem');
});

test('khoi Quan ly (nguoi duoc sua + lich) chi hien khi canManage; nguoi duoc gan sua van thay form nhung khong thay khoi Quan ly', async () => {
  const editor = await openProfile({ profile: baseProfile({ canEdit: true, canManage: false }) });
  assert.ok(editor.$('cpProfileForm'));
  assert.equal(editor.$('cpManager'), null);
  assert.equal(editor.server.requests.some(r => r.href.includes('assignable-users')), false);

  const manager = await openProfile();
  assert.ok(manager.$('cpManager'));
  assert.ok(manager.$('cpCalendarHost').querySelector('.cp-cal'));
  assert.ok(manager.server.requests.some(r => r.href === '/api/business-report/customer-profile/assignable-users'));
});

test('Nguoi duoc sua: dropdown tu assignable-users (ten + vai tro), PUT editors gui danh sach userIds', async () => {
  const page = await openProfile();
  const options = [...page.$('cpEditorsMsPop').querySelectorAll('label')].map(l => l.querySelector('span').textContent + ' | ' + l.querySelector('small').textContent);
  assert.deepEqual(options, ['Sale Một | Nhân viên Sale', 'Sale Hai | Nhân viên Sale']);
  assert.equal(page.$('cpEditorsMs').querySelector('input[value="u9"]').checked, true, 'dang duoc gan');
  const hai = page.$('cpEditorsMs').querySelector('input[value="u8"]');
  hai.checked = true;
  fireChange(page, hai);
  page.$('cpEditorsSave').click();
  await settle();
  const put = sent(page, 'PUT', 'customer-profile/editors');
  assert.deepEqual(jsonOf(put[0]), { key: KEY, userIds: ['u9', 'u8'] });
  assert.match(page.doc.getElementById('tksToastStack').textContent, /Đã lưu người được sửa/);
});

test('lich nhieu ngay: luoi bat dau Thu Hai, ngay tuong lai bi khoa, chon ngay co dau tich, ngay lon nhat danh dau Gan nhat', async () => {
  const page = await openProfile();
  const cal = page.$('cpCalendarHost');
  assert.deepEqual([...cal.querySelectorAll('.cp-cal-wd')].map(e => e.textContent), ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']);
  assert.equal(cal.querySelector('.cp-cal-title').textContent, 'Tháng 10/2026');
  // 01/10/2026 la Thu Nam -> 3 o trong (T2, T3, T4) truoc ngay 1.
  assert.equal(cal.querySelectorAll('.cp-day-none').length, 3);
  const day = iso => cal.querySelector('.cp-day[data-date="' + iso + '"]');
  assert.equal(day('2026-10-07').disabled, true, 'sau hom nay bi khoa');
  assert.equal(day('2026-10-06').disabled, false);
  assert.equal(day('2026-10-01').getAttribute('aria-pressed'), 'true');
  assert.ok(day('2026-10-01').querySelector('svg'), 'ngay da chon co dau tich SVG');
  assert.equal(day('2026-10-02').querySelector('svg'), null);
  assert.equal(cal.querySelector('.cp-cal-step[data-step="1"]').disabled, true, 'khong sang thang tuong lai');
  const chips = [...cal.querySelectorAll('.cp-chip')];
  assert.deepEqual(chips.map(c => c.querySelector('span').textContent), ['03/10/2026', '01/10/2026']);
  assert.match(chips[0].textContent, /Gần nhất/);
  assert.equal(chips[1].textContent.includes('Gần nhất'), false);
});

test('bam ngay tren lich bat/tat; Luu -> PUT visits {key, dates} sap tang dan; o bang va hop cap nhat ngay lon nhat', async () => {
  const page = await openProfile();
  const cal = page.$('cpCalendarHost');
  assert.equal(cal.querySelector('[data-act="save"]').disabled, true, 'chua doi gi thi chua cho luu');
  cal.querySelector('.cp-day[data-date="2026-10-05"]').click();
  cal.querySelector('.cp-day[data-date="2026-10-01"]').click();
  assert.equal(cal.querySelector('.cp-day[data-date="2026-10-05"]').getAttribute('aria-pressed'), 'true');
  assert.equal(cal.querySelector('.cp-day[data-date="2026-10-01"]').getAttribute('aria-pressed'), 'false');
  assert.equal(cal.querySelector('[data-act="save"]').disabled, false);
  cal.querySelector('[data-act="save"]').click();
  assert.equal(cal.querySelector('[data-act="save"]').disabled, true, 'dang gui -> vo hieu');
  await settle();
  const put = sent(page, 'PUT', 'customer-profile/visits');
  assert.deepEqual(jsonOf(put[0]), { key: KEY, dates: ['2026-10-03', '2026-10-05'] });
  assert.equal(visitCell(page).querySelector('.cp-visit-date').textContent, '05/10/2026', 'cot bang hien ngay lon nhat');
  assert.match(page.$('cpVisitSummary').textContent, /05\/10\/2026/);
  assert.match(page.$('docModalSubtitle').textContent, /05\/10\/2026/);
  assert.match(page.doc.getElementById('tksToastStack').textContent, /Đã lưu ngày tiếp khách/);
  assert.equal(page.$('docModalBackdrop').hidden, false, 'trong hop Chi tiet thi giu hop mo');
});

test('cot ngay khong co thao tac lich; Quan ly sua ngay trong Chi tiet', async () => {
  const page = await openProfile();
  assert.equal(calendarButton(page), null);
  assert.ok(page.$('cpCalendarHost'));
  assert.deepEqual([...page.doc.querySelector('.cp-manager-grid').children].map(el => el.id), ['cpEditors', 'cpScale', 'cpVisits']);
});

test('lich: Huy trong hop Chi tiet bo thay doi; dong hop khi con thay doi chua luu thi hoi xac nhan', async () => {
  const page = await openProfile();
  const cal = page.$('cpCalendarHost');
  cal.querySelector('.cp-day[data-date="2026-10-04"]').click();
  assert.equal(page.$('cpCalendarHost').querySelector('.cp-day[data-date="2026-10-04"]').getAttribute('aria-pressed'), 'true');
  page.$('cpCalendarHost').querySelector('[data-act="cancel"]').click();
  assert.equal(page.$('cpCalendarHost').querySelector('.cp-day[data-date="2026-10-04"]').getAttribute('aria-pressed'), 'false');

  page.$('cpCalendarHost').querySelector('.cp-day[data-date="2026-10-04"]').click();
  let asked = 0;
  page.win.confirm = () => { asked++; return false; };
  page.run('closeDocumentDetail()');
  assert.equal(asked, 1);
  assert.equal(page.$('docModalBackdrop').hidden, false, 'tu choi bo thay doi -> van mo');
  page.win.confirm = () => true;
  page.run('closeDocumentDetail()');
  assert.equal(page.$('docModalBackdrop').hidden, true);
});

test('dan anh (Ctrl+V) khi hop mo: nen bang TKSImageCompress, POST multipart field file, them vao luoi; chu thuong khong bi chan', async () => {
  const page = await openProfile();
  let compressed = 0;
  page.win.TKSImageCompress = { compress: async file => { compressed++; return new page.win.Blob(['jpg'], { type: 'image/jpeg' }); } };
  const file = new page.win.File(['png'], 'dan.png', { type: 'image/png' });
  const paste = new page.win.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] } });
  page.doc.dispatchEvent(paste);
  assert.equal(paste.defaultPrevented, true);
  await settle();
  assert.equal(compressed, 1);
  const post = sent(page, 'POST', 'customer-profile/images');
  assert.equal(post.length, 1);
  assert.match(post[0].href, /\?key=/);
  assert.ok(post[0].opts.body instanceof page.win.FormData);
  assert.ok(post[0].opts.body.get('file'), 'field file');
  assert.equal(page.$('cpImageList').querySelectorAll('.cp-img').length, 2);

  const text = new page.win.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(text, 'clipboardData', { value: { items: [{ kind: 'string', type: 'text/plain' }], files: [] } });
  page.doc.dispatchEvent(text);
  assert.equal(text.defaultPrevented, false);
});

test('them anh bang input file (nhieu tep) + xoa anh co xac nhan -> DELETE; phong to anh mo lightbox, Esc dong lightbox truoc', async () => {
  const page = await openProfile();
  const input = page.$('cpImageInput');
  const files = [new page.win.File(['a'], 'a.png', { type: 'image/png' }), new page.win.File(['b'], 'b.png', { type: 'image/png' })];
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireChange(page, input);
  await settle();
  assert.equal(sent(page, 'POST', 'customer-profile/images').length, 2);
  assert.equal(page.$('cpImageList').querySelectorAll('.cp-img').length, 3);

  page.$('cpImages').querySelector('.cp-img-open').click();
  const box = page.doc.querySelector('.cp-lightbox');
  assert.ok(box);
  assert.equal(box.getAttribute('role'), 'dialog');
  box.dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(page.doc.querySelector('.cp-lightbox'), null);
  assert.equal(page.$('docModalBackdrop').hidden, false, 'Esc chi dong lightbox');

  page.$('cpImages').querySelector('.cp-img-del').click();
  await settle();
  const del = sent(page, 'DELETE', 'customer-profile/images/img1');
  assert.equal(del.length, 1);
  assert.match(del[0].href, /\?key=/);
  assert.equal(page.$('cpImageList').querySelectorAll('.cp-img').length, 2);
});

test('khong dan anh khi khong co quyen sua; hop dong roi thi go bo bat su kien dan', async () => {
  const page = await openProfile({ profile: baseProfile({ canEdit: false, canManage: false }) });
  const file = new page.win.File(['png'], 'x.png', { type: 'image/png' });
  const paste = new page.win.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] } });
  page.doc.dispatchEvent(paste);
  await settle();
  assert.equal(paste.defaultPrevented, false);
  assert.equal(sent(page, 'POST', 'customer-profile/images').length, 0);

  const editable = await openProfile();
  editable.run('closeDocumentDetail()');
  const after = new editable.win.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(after, 'clipboardData', { value: { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] } });
  editable.doc.dispatchEvent(after);
  await settle();
  assert.equal(after.defaultPrevented, false);
  assert.equal(sent(editable, 'POST', 'customer-profile/images').length, 0);
});

test('Tab bi giu trong hop (focus trap) va Esc dong hop; sau do bang van dung duoc', async () => {
  const page = await openProfile();
  const modal = page.doc.querySelector('#docModalBackdrop .doc-modal');
  const focusables = [...modal.querySelectorAll('button, input, select, textarea')].filter(el => !el.disabled && el.tabIndex >= 0 && !el.closest('[hidden]'));
  const last = focusables[focusables.length - 1];
  last.focus();
  const tab = new page.win.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
  last.dispatchEvent(tab);
  assert.equal(tab.defaultPrevented, true);
  assert.equal(page.doc.activeElement, focusables[0]);

  page.doc.dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(page.$('docModalBackdrop').hidden, true);
});

test('GET customer-profile loi: hop hien thong bao loi + nut Thu lai goi lai API', async () => {
  const page = await openBusiness();
  page.server.failNext = Object.assign(/^GET \/api\/business-report\/customer-profile$/, { response: { status: 500, body: { error: 'Lỗi máy chủ' } } });
  detailButton(page).click();
  await settle();
  assert.match(page.$('docModalBody').textContent, /Lỗi máy chủ/);
  page.$('cpRetry').click();
  await settle();
  assert.ok(page.$('cpProfileForm'));
});


test('danh gia quy mo luu rieng, khong mat thong tin chung dang nhap; chi Quan ly co dropdown', async () => {
  const page = await openProfile();
  fireInput(page, page.$('cpArea'), 'Dien tich chua luu');
  page.$('cpWarehouseScale').value = 'very_large';
  fireChange(page, page.$('cpWarehouseScale'));
  page.$('cpScaleSave').click();
  assert.equal(page.$('cpScaleSave').disabled, true);
  await settle();
  assert.deepEqual(jsonOf(sent(page, 'PUT', 'customer-profile/scale')[0]), { key: KEY, warehouseScale: 'very_large' });
  assert.equal(sent(page, 'PUT', 'customer-profile').length, 0);
  assert.equal(page.$('cpArea').value, 'Dien tich chua luu');
  page.$('cpProfileSave').click();
  await settle();
  assert.equal(page.$('cpWarehouseScale').value, 'very_large');
  assert.equal(page.server.profile.profile.warehouseScale, 'very_large');
  page.$('businessCustomersScale').value = 'very_large';
  fireChange(page, page.$('businessCustomersScale'));
  assert.deepEqual(Array.from(page.run('businessFilteredCustomers().map(r => r.key)')), [KEY]);
  const editor = await openProfile({ profile: baseProfile({ canManage: false }) });
  assert.equal(editor.$('cpWarehouseScale'), null);
});

test('danh gia chua luu duoc bao ve khi dong hop; loi luu giu lua chon de thu lai', async () => {
  const page = await openProfile();
  page.$('cpWarehouseScale').value = 'very_large';
  fireChange(page, page.$('cpWarehouseScale'));
  let asked = 0;
  page.win.confirm = () => { asked++; return false; };
  page.run('closeDocumentDetail()');
  assert.equal(asked, 1);
  assert.equal(page.$('docModalBackdrop').hidden, false);
  page.server.failNext = Object.assign(/^PUT \/api\/business-report\/customer-profile\/scale$/, { response: { status: 500, body: { error: 'Loi thu nghiem' } } });
  page.$('cpScaleSave').click();
  await settle();
  assert.equal(page.$('cpScaleSave').disabled, false);
  assert.match(page.$('cpScaleError').textContent, /Loi thu nghiem/);
  assert.equal(page.$('cpWarehouseScale').value, 'very_large');
});

test('text dai tu tang chieu cao, lua chon Khac gui cung kenh khac; Note co vung cuon rieng', async () => {
  const profile = baseProfile();
  profile.notes = Array.from({ length: 25 }, (_, i) => ({ ...profile.notes[1], id: 'old' + i, body: ('Noi dung dai ' + i + ' ').repeat(100) }));
  const page = await openProfile({ profile });
  for (const id of ['cpWarehouseLocation', 'cpArea', 'cpCompetitor']) {
    const field = page.$(id);
    assert.equal(field.tagName, 'TEXTAREA');
    Object.defineProperty(field, 'scrollHeight', { value: 130 });
    fireInput(page, field, 'Van ban nhieu dong');
    assert.equal(field.style.height, '130px');
  }
  const other = page.$('cpChannelsPop').querySelector('input[value="khac"]');
  other.checked = true;
  fireChange(page, other);
  page.$('cpProfileSave').click();
  await settle();
  assert.deepEqual(jsonOf(sent(page, 'PUT', 'customer-profile')[0]).salesChannels, ['san', 'khac']);
  const history = page.$('cpNotes').querySelector('.cp-bubbles');
  assert.equal(history.querySelectorAll('.cp-bubble').length, 25);
  assert.equal(history.contains(page.$('cpNoteForm')), false);
  assert.equal(history.getAttribute('tabindex'), '0');
});

test('thu vien anh: mui ten chi trong anh lon, doi dung anh, chan bien, phim trai phai, Esc tra focus', async () => {
  const profile = baseProfile();
  profile.images = ['a', 'b', 'c'].map(id => ({ id, url: '/images/' + id }));
  const page = await openProfile({ profile });
  assert.equal(page.doc.querySelector('.cp-lightbox-prev'), null);
  const trigger = page.$('cpImages').querySelectorAll('.cp-img-open')[1];
  trigger.click();
  const box = page.doc.querySelector('.cp-lightbox');
  assert.equal(box.querySelector('.cp-lightbox-count').textContent, '2 / 3');
  assert.equal(box.querySelector('img').getAttribute('src'), '/images/b');
  box.querySelector('.cp-lightbox-next').focus();
  box.querySelector('.cp-lightbox-next').click();
  assert.ok(box.isConnected, 'nut chuyen anh khong dong lightbox');
  assert.equal(box.querySelector('img').getAttribute('src'), '/images/c');
  assert.equal(box.querySelector('.cp-lightbox-next').disabled, true);
  assert.equal(page.doc.activeElement, box.querySelector('.cp-lightbox-close'), 'giu focus trong anh lon khi nut dang focus bi vo hieu');
  box.dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(box.querySelector('.cp-lightbox-count').textContent, '3 / 3');
  for (let i = 0; i < 2; i++) box.dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(box.querySelector('img').getAttribute('src'), '/images/a');
  assert.equal(box.querySelector('.cp-lightbox-prev').disabled, true);
  box.dispatchEvent(new page.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(page.doc.querySelector('.cp-lightbox'), null);
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.equal(page.doc.activeElement, trigger);
  const single = await openProfile();
  single.$('cpImages').querySelector('.cp-img-open').click();
  assert.equal(single.doc.querySelector('.cp-lightbox-prev'), null);
  assert.equal(single.doc.querySelector('.cp-lightbox-next'), null);
});


test('text dai tang lai chieu cao khi doi chieu rong cua so', async () => {
  const page = await openProfile();
  const field = page.$('cpCompetitor');
  let measuredHeight = 80;
  Object.defineProperty(field, 'scrollHeight', { get: () => measuredHeight });
  fireInput(page, field, 'Noi dung dai');
  assert.equal(field.style.height, '80px');
  measuredHeight = 190;
  page.win.dispatchEvent(new page.win.Event('resize'));
  assert.equal(field.style.height, '190px');
});
