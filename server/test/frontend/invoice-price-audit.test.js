'use strict';

// Muc 2 "Kiem tra gia ban" cua tab Hoa don (/reports/#invoices): MOT bang, thead dung tu catalog cot cua may chu
// (17 cot nghiep vu, 15 hien mac dinh + cot doi chieu an), bo loc/KPI/phan trang o may chu, sua giai thich + Chot
// theo quyen tung dong, 409, giai thich loi khong gia vo da luu, doi Chot lam dong doi tap loc.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { COLUMNS } = require('../../invoicePriceAudit/priceAuditColumns');

const publicDir = path.join(__dirname, '..', '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
const auditJs = fs.readFileSync(path.join(publicDir, 'invoice-price-audit.js'), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

const META = {
  available: true, windowFrom: '2026-10-14', windowTo: '2026-10-20', lastSuccessAt: '2026-10-20T16:02:00.000Z',
  lastAttemptAt: '2026-10-20T16:02:00.000Z', lastError: null, addedInvoiceCount: 12
};

function line(id, over = {}) {
  return {
    soldAt: '2026-10-19T08:05:00', branch: 'hanoi', invoiceCode: 'HD' + id, saleName: 'Duy Thái', customerName: 'Khách ' + id,
    productCode: 'T100', productName: 'Ly giữ nhiệt', customerLevel: 'Vừa', quantity: '100', totalCodeQuantity: '300',
    fullVat: false, netUnitPrice: '23000', minimumUnitPrice: '24000', unitShortfall: '1000', effectiveAmount: '100000',
    effectiveStatus: 'wrong', saleExplanation: null, decision: null, customerCode: 'KH' + id, customerEmail: '', sourceLineNo: 1,
    originalUnitPrice: '23000', unitDiscount: '0', cartonSizeHn: '100', quantityPriceHn: '23800', levelPriceHn: '24000',
    vatHn: '0', minimumHn: '24000', freightEligible: false, freightPerUnit: '0', cartonSizeSg: null, quantityPriceSg: null,
    levelPriceSg: null, vatSg: null, minimumSg: null, winningSource: 'HN', reason: 'Theo giá quy định', productNoteHn: 'T100 # 1T-24000',
    productNoteSg: null, lineNote: null, invoiceNote: null, originalStatus: 'wrong', originalAmount: '100000', decidedBy: null,
    decidedAt: null, capturedAt: '2026-10-19T16:00:00.000Z', invoiceId: String(id), version: 1,
    canEditExplanation: true, canDecide: true, ...over
  };
}

const pendingOf = r => r.decision == null && r.originalStatus === 'wrong';
function saleSummaryOf(rows) {
  const map = new Map();
  for (const r of rows) {
    const entry = map.get(r.saleName) || { saleName: r.saleName, pendingAmount: 0, penaltyAmount: 0 };
    if (pendingOf(r)) entry.pendingAmount += Number(r.originalAmount);
    if (r.decision === 'penalty') entry.penaltyAmount += Number(r.originalAmount);
    map.set(r.saleName, entry);
  }
  return [...map.values()].filter(e => e.pendingAmount || e.penaltyAmount)
    .map(e => ({ ...e, pendingAmount: String(e.pendingAmount), penaltyAmount: String(e.penaltyAmount) }));
}

// May chu gia co trang thai: loc status/decision, KPI theo toan tap loc, PATCH decision/explanation co version.
function fakeServer({ rows = [line(1001)], meta = META, explanationStatus = 200 } = {}) {
  const server = { rows: rows.map(r => ({ ...r })), meta, explanationStatus, requests: [], editorName: 'Minh Anh' };
  const effective = r => (r.decision === 'ok' ? { ...r, effectiveStatus: 'correct', effectiveAmount: '0', reason: 'Được duyệt Ok' }
    : { ...r, effectiveStatus: r.originalStatus, effectiveAmount: r.originalAmount });
  server.report = params => {
    const status = params.get('status');
    const decision = params.get('decision');
    const all = server.rows.map(effective).filter(r => (!status || r.effectiveStatus === status) &&
      (!decision || (decision === 'pending' ? r.decision == null : r.decision === decision)));
    const pageSize = Number(params.get('pageSize') || 50);
    const page = Number(params.get('page') || 1);
    if (!server.meta.available) {
      return { meta: server.meta, filters: { applied: {}, options: { sales: [] } }, kpis: null, totals: null, rows: [], totalRows: 0, page, pageSize };
    }
    return {
      meta: server.meta, filters: { applied: {}, options: { sales: ['Duy Thái', 'Minh Anh'] } },
      kpis: { invoiceCount: new Set(all.map(r => r.invoiceId)).size, correctLines: all.filter(r => r.effectiveStatus === 'correct').length,
        wrongLines: all.filter(r => r.effectiveStatus === 'wrong').length,
        pendingAmount: String(all.filter(pendingOf).reduce((t, r) => t + Number(r.originalAmount), 0)),
        penaltyAmount: String(all.filter(r => r.decision === 'penalty').reduce((t, r) => t + Number(r.originalAmount), 0)), effectiveAmount: '0' },
      saleSummary: saleSummaryOf(all),
      totals: {}, rows: all.slice((page - 1) * pageSize, page * pageSize), totalRows: all.length, page, pageSize
    };
  };
  return server;
}

function createPage({ permissions = ['reports.invoices', 'reports.invoices.priceAudit', 'reports.export'], server = fakeServer(), confirm = () => true } = {}) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://tokosi.example/reports/#invoices' });
  const w = dom.window;
  w.HTMLCanvasElement.prototype.getContext = () => ({});
  w.Chart = class { static defaults = { font: {}, animation: {}, plugins: { tooltip: {} } }; constructor(c, config) { this.config = config; } destroy() {} };
  w.setInterval = () => 1;
  w.requestAnimationFrame = cb => cb();
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.EventSource = class { addEventListener() {} close() {} };
  const confirms = [];
  w.confirm = message => { confirms.push(message); return confirm(message); };
  w.TKSNav = { authGuard: () => new Promise(() => {}), can: key => permissions.includes(key), handleBranchError: () => false, renderTopSidebar() {} };

  w.fetch = (url, options = {}) => {
    const href = String(url);
    const method = (options.method || 'GET').toUpperCase();
    server.requests.push({ href, method, body: options.body ? JSON.parse(options.body) : null });
    const respond = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });
    if (!href.startsWith('/api/invoice-price-audit')) return new Promise(() => {});
    const [pathPart, query = ''] = href.split('?');
    const params = new URLSearchParams(query);
    if (method === 'GET' && pathPart === '/api/invoice-price-audit') return respond(200, server.report(params));
    const m = pathPart.match(/^\/api\/invoice-price-audit\/(\w+)\/(\d+)\/(\d+)\/(explanation|decision)$/);
    if (m && method === 'PATCH') {
      const row = server.rows.find(r => r.branch === m[1] && r.invoiceId === m[2] && r.sourceLineNo === Number(m[3]));
      const body = JSON.parse(options.body);
      if (body.expectedVersion !== row.version) return respond(409, { error: 'Dòng đã thay đổi.', code: 'VERSION_CONFLICT', row: { ...row } });
      if (m[4] === 'explanation') {
        if (server.explanationStatus !== 200) return respond(server.explanationStatus, { error: 'Không lưu được giải thích.' });
        Object.assign(row, { saleExplanation: body.text, explanationBy: server.editorName,
          explanationAt: '2026-10-22T08:30:00.000Z', version: row.version + 1 });
        return respond(200, { row: { ...row } });
      }
      Object.assign(row, { decision: body.decision, version: row.version + 1 });
      return respond(200, { row: { ...row }, ...server.report(params) });
    }
    return respond(404, {});
  };

  ['pagination.js', 'table-explorer.js'].forEach(file => w.eval(fs.readFileSync(path.join(publicDir, 'js', file), 'utf8')));
  w.MutationObserver = class { observe() {} disconnect() {} }; // These fixtures exercise report requests, not table auto-discovery.
  w.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  w.eval(auditJs);
  [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => s.trim()).forEach(s => w.eval(s));
  const doc = w.document;
  return { dom, w, doc, server, confirms, $: id => doc.getElementById(id), run: code => w.eval(code) };
}

async function opened(options) {
  const page = createPage(options);
  await page.w.TKSPriceAudit.load(true);
  await settle();
  return page;
}
// Mac dinh bang vao o Ket qua = Sai gia; test can thay ca dong Dung gia thi bo loc ve Tat ca.
async function openedAll(options) {
  const page = await opened(options);
  change(page, 'priceAuditStatusFilter', '');
  await settle();
  return page;
}

const headLabels = page => [...page.$('priceAuditHead').querySelectorAll('th')].map(th => (th.querySelector('.sort-label') || th).textContent.trim());
const bodyRows = page => [...page.$('priceAuditRows').querySelectorAll('tr[data-row-key]')];
const cell = (page, tr, key) => tr.cells[COLUMNS.findIndex(c => c.key === key)];
const change = (page, id, value) => { const el = page.$(id); el.value = value; el.dispatchEvent(new page.w.Event('change', { bubbles: true })); };
const gets = page => page.server.requests.filter(r => r.method === 'GET' && r.href.startsWith('/api/invoice-price-audit'));

test('muc 1 Kiem tra gia ban nam truoc Giao dich trong tab Hoa don, chi MOT bang chi tiet kiem tra gia', () => {
  const page = createPage();
  const sections = [...page.$('view-invoices').querySelectorAll(':scope > section.section')];
  assert.deepEqual(sections.map(s => s.querySelector('.section-head h2').firstChild.textContent.trim()), ['Kiểm tra giá bán', 'Giao dịch']); // Bảng giá duyệt bị gỡ khỏi trang vì tài khoản không có quyền riêng reports.invoices.approvedPrice
  assert.equal(sections[0].id, 'priceAuditSection');
  assert.equal(page.doc.querySelectorAll('table[data-table-key="dashboard-table-price-audit"]').length, 1);
  // Muc 1 co them bang tong hop tien phat theo sale (cot phai khung KPI), van la cung mot muc.
  assert.equal(page.$('priceAuditSection').querySelectorAll('table').length, 2);
  assert.equal(page.doc.querySelectorAll('#priceAuditSection table[data-table-key="dashboard-table-price-audit-sales"]').length, 1);
});

test('thead tu catalog: 17 cot nghiep vu gon, 15 hien mac dinh, bo cot thua', async () => {
  const page = await opened();
  const labels = headLabels(page);
  assert.deepEqual(labels.slice(0, 17), ['TGian', 'Cơ sở', 'Mã HĐ', 'Sale phụ trách', 'Khách', 'Mã hàng', 'Tên hàng',
    'Level khách', 'Tổng SL', 'Full VAT', 'Giá sau giảm', 'Giá min', 'Chênh/ĐV', 'Tiền chênh / phạt',
    'Kết quả', 'Sale giải thích', 'Chốt']);
  assert.equal(labels.length, COLUMNS.length);
  const ths = [...page.$('priceAuditHead').querySelectorAll('th')];
  const visible = ths.filter(th => th.dataset.columnDefaultHidden !== 'true');
  assert.equal(visible.length, 15);
  assert.ok(ths.slice(17).every(th => th.dataset.columnDefaultHidden === 'true'));
  assert.equal(labels.length, 40);
  for (const key of ['quantity', 'customerEmail', 'sourceLineNo', 'winningSource', 'reason', 'capturedAt']) {
    assert.ok(!ths.some(th => th.dataset.columnKey === key), key + ' khong con trong bo chon cot');
  }
  assert.equal(ths.find(th => th.dataset.columnKey === 'customerName').style.width, '150px');
  // thead tinh phai khop DUNG catalog may chu (nguon duy nhat cho bang + xuat file)
  assert.deepEqual(ths.map(th => [th.dataset.columnKey, (th.querySelector('.sort-label') || th).textContent.trim(), th.dataset.colType, th.dataset.columnDefaultHidden !== 'true']),
    COLUMNS.map(c => [c.key, c.label, c.type, c.defaultVisible]));
  assert.ok(ths.every(th => /^\d+px$/.test(th.style.width)), 'moi cot co do rong px');
});

test('khong co quyen xem: muc an va khong goi API', async () => {
  const page = createPage({ permissions: ['reports.invoices'] });
  await page.w.TKSPriceAudit.load(true);
  await settle();
  assert.equal(page.$('priceAuditSection').hidden, true);
  assert.equal(page.server.requests.filter(r => r.href.startsWith('/api/invoice-price-audit')).length, 0);
});

test('chua chay kiem tra gia: thong diep, khong hien KPI 0', async () => {
  const page = await opened({ server: fakeServer({ rows: [], meta: { available: false, message: 'Chưa chạy kiểm tra giá', windowFrom: null, windowTo: null } }) });
  assert.match(page.$('priceAuditStatus').textContent, /Chưa chạy kiểm tra giá/);
  assert.equal(page.$('priceAuditKpis').querySelectorAll('.kpi-card').length, 0);
  assert.match(page.$('priceAuditRows').textContent, /Chưa chạy kiểm tra giá/);
});

test('dau bang: cua so, lan chay thanh cong, so hoa don bo sung; lan chay loi -> canh bao du lieu cu', async () => {
  const ok = await opened();
  const text = ok.$('priceAuditStatus').textContent;
  assert.match(text, /14\/10\/2026/);
  assert.match(text, /20\/10\/2026/);
  assert.match(text, /12 hóa đơn/);
  assert.equal(ok.$('priceAuditStatus').querySelector('.price-audit-stale'), null);
  const failed = await opened({ server: fakeServer({ meta: { ...META, lastAttemptAt: '2026-10-21T16:00:00.000Z', lastError: 'Nguồn sản phẩm chưa sẵn sàng' } }) });
  const warn = failed.$('priceAuditStatus').querySelector('.price-audit-stale');
  assert.ok(warn, 'phai co canh bao');
  assert.match(warn.textContent, /lỗi/i);
  assert.match(warn.textContent, /Nguồn sản phẩm chưa sẵn sàng/);
});

test('KPI theo toan tap loc tu may chu (so hoa don phan biet, dong dung/sai)', async () => {
  const page = await openedAll({ server: fakeServer({ rows: [line(1), line(1, { sourceLineNo: 2 }), line(2, { originalStatus: 'correct', originalAmount: '0' })] }) });
  const cards = [...page.$('priceAuditKpis').querySelectorAll('.kpi-card')].map(c => [c.querySelector('.eyebrow').textContent, c.querySelector('.value').textContent]);
  assert.deepEqual(cards.slice(0, 3), [['Số hóa đơn', '2'], ['Dòng đúng giá', '1'], ['Dòng sai giá', '2']]);
});

test('dong OD / PK / thieu gia: "—" cho null, 0 cho 0, ket qua Dung gia', async () => {
  const rows = [
    line(11, { productName: 'Ly (OD)', effectiveAmount: '0', originalAmount: '0', originalStatus: 'correct', unitShortfall: '0', reason: 'Không xét OD', winningSource: 'Không xét', canDecide: false }),
    line(12, { productName: 'Nắp (pk)', effectiveAmount: '0', originalAmount: '0', originalStatus: 'correct', unitShortfall: '0', reason: 'Không xét PK', canDecide: false }),
    line(13, { minimumUnitPrice: null, unitShortfall: null, effectiveAmount: '0', originalAmount: '0', originalStatus: 'correct', reason: 'Không có giá quy định', canDecide: false })
  ];
  const page = await openedAll({ server: fakeServer({ rows }) });
  const trs = bodyRows(page);
  assert.equal(trs.length, 3);
  assert.equal(cell(page, trs[0], 'productName').textContent.trim(), 'Ly (OD)');
  assert.equal(cell(page, trs[0], 'effectiveStatus').textContent.trim(), 'Đúng giá');
  assert.equal(cell(page, trs[0], 'effectiveAmount').textContent.trim(), '0');
  assert.equal(cell(page, trs[0], 'minimumUnitPrice').textContent.trim(), '24,000');
  assert.equal(cell(page, trs[2], 'minimumUnitPrice').textContent.trim(), '—');
  assert.equal(cell(page, trs[2], 'unitShortfall').textContent.trim(), '—');
  assert.equal(cell(page, trs[2], 'effectiveAmount').textContent.trim(), '0');
  assert.equal(cell(page, trs[0], 'branch').textContent.trim(), 'HN');
  assert.equal(cell(page, trs[0], 'soldAt').textContent.trim(), '19/10/2026 08:05');
  assert.equal(cell(page, trs[0], 'decision').querySelector('select'), null, 'dong dung gia goc: Chot bi khoa');
  assert.equal(cell(page, trs[0], 'customerLevel').textContent.trim(), 'Vừa');
});

test('mac dinh Ket qua = Sai gia: select, tham so gui may chu va Tat ca bo tham so', async () => {
  const rows = [line(31), line(32, { originalStatus: 'correct', originalAmount: '0', effectiveStatus: 'correct' })];
  const page = await opened({ server: fakeServer({ rows }) });
  assert.equal(page.$('priceAuditStatusFilter').value, 'wrong');
  const first = new URLSearchParams(gets(page)[0].href.split('?')[1]);
  assert.equal(first.get('status'), 'wrong');
  assert.equal(bodyRows(page).length, 1, 'chi dong sai gia');
  change(page, 'priceAuditStatusFilter', '');
  await settle();
  const all = new URLSearchParams(gets(page).at(-1).href.split('?')[1]);
  assert.ok(!all.has('status'), 'Tat ca = bo tham so');
  assert.equal(bodyRows(page).length, 2);
});

test('o Sale giai thich cua Sai gia dung ma o Cong no: textarea debt-feedback-input luon hien, Luu/Huy chi hien khi sua', async () => {
  const rows = [line(21), line(22, { canEditExplanation: false, canDecide: false, saleExplanation: 'Khách quen' })];
  const page = await opened({ server: fakeServer({ rows }) });
  const [a, b] = bodyRows(page);
  const boxA = cell(page, a, 'saleExplanation');
  assert.ok(boxA.querySelector('textarea.debt-feedback-input'));
  assert.equal(boxA.querySelector('.price-audit-edit-actions').hidden, true);
  boxA.querySelector('textarea').value = 'đang sửa';
  boxA.querySelector('textarea').dispatchEvent(new page.w.Event('input', { bubbles: true }));
  assert.equal(boxA.querySelector('.price-audit-edit-actions').hidden, false);
  assert.ok(cell(page, a, 'decision').querySelector('select[data-action="decision"]'));
  assert.equal(cell(page, b, 'saleExplanation').querySelector('textarea'), null);
  assert.ok(cell(page, b, 'saleExplanation').querySelector('.debt-feedback-text'));
  assert.equal(cell(page, b, 'saleExplanation').textContent.trim(), 'Khách quen');
  assert.equal(cell(page, b, 'decision').querySelector('select'), null);
  assert.equal(cell(page, b, 'decision').textContent.trim(), 'Chưa chốt');
});

test('bo loc gui len may chu; Ket qua + Chot ket hop', async () => {
  const page = await opened();
  change(page, 'priceAuditStatusFilter', 'correct');
  change(page, 'priceAuditDecisionFilter', 'ok');
  change(page, 'priceAuditVatFilter', 'true');
  await settle();
  const params = new URLSearchParams(gets(page).at(-1).href.split('?')[1]);
  assert.equal(params.get('status'), 'correct');
  assert.equal(params.get('decision'), 'ok');
  assert.equal(params.get('vat'), 'true');
  assert.equal(params.get('page'), '1');
  assert.ok(!params.has('freight'), 'Tat ca = bo tham so');
  assert.equal(page.$('priceAuditFrom').min, '2026-10-14');
  assert.equal(page.$('priceAuditTo').max, '2026-10-20');
});

test('doi Chot sang Ok: PATCH dung khoa + version + bo loc; dong roi bo loc Sai gia, xuat hien o Dung gia + Ok, giu so goc', async () => {
  const page = await opened({ server: fakeServer({ rows: [line(1001), line(1002)] }) });
  change(page, 'priceAuditStatusFilter', 'wrong');
  await settle();
  assert.equal(bodyRows(page).length, 2);
  const select = cell(page, bodyRows(page)[0], 'decision').querySelector('select');
  select.value = 'ok';
  select.dispatchEvent(new page.w.Event('change', { bubbles: true }));
  await settle();
  const patch = page.server.requests.find(r => r.method === 'PATCH');
  assert.match(patch.href, /^\/api\/invoice-price-audit\/hanoi\/1001\/1\/decision\?/);
  assert.equal(new URLSearchParams(patch.href.split('?')[1]).get('status'), 'wrong');
  assert.deepEqual(patch.body, { decision: 'ok', expectedVersion: 1 });
  assert.equal(bodyRows(page).length, 1, 'dong Ok roi bo loc Sai gia');
  const wrongCard = [...page.$('priceAuditKpis').querySelectorAll('.kpi-card')].find(c => /sai giá/.test(c.textContent));
  assert.equal(wrongCard.querySelector('.value').textContent, '1');
  change(page, 'priceAuditStatusFilter', 'correct');
  change(page, 'priceAuditDecisionFilter', 'ok');
  await settle();
  const [okRow] = bodyRows(page);
  assert.equal(okRow.dataset.rowKey, 'hanoi/1001/1');
  assert.equal(cell(page, okRow, 'effectiveStatus').textContent.trim(), 'Đúng giá');
  assert.equal(cell(page, okRow, 'effectiveAmount').textContent.trim(), '0');
  assert.equal(cell(page, okRow, 'unitShortfall').textContent.trim(), '1,000', 'chenh goc giu nguyen');
  assert.equal(cell(page, okRow, 'originalAmount').textContent.trim(), '100,000', 'tien chenh goc giu nguyen');
});

// Ô luôn là textarea (như Công nợ); trình soạn tạo ở lần gõ đầu nên các test tự gõ nội dung.
function openEditor(page, tr) {
  return cell(page, tr, 'saleExplanation');
}
function typeInto(page, box, text) {
  const area = box.querySelector('textarea');
  area.value = text;
  area.dispatchEvent(new page.w.Event('input', { bubbles: true }));
}

test('sale sua giai thich cua nguoi khac: hien ten nguoi luu moi nhat sau luu va tai lai', async () => {
  const server = fakeServer({ rows: [line(1001, {
    saleName: 'Sale khác', saleExplanation: 'Nội dung cũ', explanationBy: 'Người điền trước'
  }), line(1002, { saleExplanation: 'Dòng khác', explanationBy: 'Giữ nguyên' })] });
  const page = await opened({ server });
  let savedCell = cell(page, bodyRows(page)[0], 'saleExplanation');
  assert.equal(savedCell.querySelector('.debt-feedback-by').textContent, 'Người điền trước');
  const box = openEditor(page, bodyRows(page)[0]);
  const text = 'Khách <img src=x onerror=alert(1)> & đã thống nhất';
  server.editorName = 'Minh <script>alert(1)</script> Anh';
  typeInto(page, box, text);
  box.querySelector('[data-action="save-explanation"]').click();
  await settle();
  const patch = server.requests.find(r => r.method === 'PATCH');
  assert.deepEqual(patch.body, { text, expectedVersion: 1 }, 'ten nguoi luu do may chu lay tu tai khoan');
  const assertSaved = () => {
    savedCell = cell(page, bodyRows(page)[0], 'saleExplanation');
    assert.equal(savedCell.querySelector('textarea').value, text);
    assert.equal(savedCell.querySelector('.debt-feedback-by').textContent,
      server.editorName + ' · 15:30 22/10/2026');
    assert.equal(savedCell.querySelector('textarea').nextElementSibling.className, 'debt-feedback-by');
    assert.equal(savedCell.querySelector('script, img'), null, 'noi dung va ten duoc escape');
    assert.equal(cell(page, bodyRows(page)[1], 'saleExplanation').querySelector('textarea').value, 'Dòng khác');
    assert.equal(cell(page, bodyRows(page)[1], 'saleExplanation').querySelector('.debt-feedback-by').textContent, 'Giữ nguyên');
  };
  assertSaved();
  await page.w.TKSPriceAudit.load(true);
  await settle();
  assertSaved();
});

test('giai thich luu loi: khong gia vo da luu, giu noi dung dang go va bao loi', async () => {
  const server = fakeServer({ explanationStatus: 500 });
  const page = await opened({ server });
  const box = openEditor(page, bodyRows(page)[0]);
  typeInto(page, box, 'Khách lấy số lượng lớn');
  box.querySelector('textarea').dispatchEvent(new page.w.Event('input', { bubbles: true }));
  box.querySelector('[data-action="save-explanation"]').click();
  await settle();
  const after = cell(page, bodyRows(page)[0], 'saleExplanation');
  assert.ok(after.querySelector('textarea'), 'van o che do sua');
  assert.equal(after.querySelector('textarea').value, 'Khách lấy số lượng lớn');
  assert.match(after.querySelector('.price-audit-edit-error').textContent, /Không lưu được/);
  assert.equal(server.rows[0].saleExplanation, null);
  assert.equal(page.w.TKSPriceAudit.hasUnsaved(), true);
});

test('giai thich luu thanh cong: hien noi dung moi, version tang; 409 -> bao xung dot va tai lai dong', async () => {
  const page = await opened();
  let box = openEditor(page, bodyRows(page)[0]);
  typeInto(page, box, 'Đã báo quản lý');
  box.querySelector('[data-action="save-explanation"]').click();
  await settle();
  const savedBox = cell(page, bodyRows(page)[0], 'saleExplanation');
  assert.equal(savedBox.querySelector('textarea').value, 'Đã báo quản lý');
  assert.equal(savedBox.querySelector('.price-audit-edit-actions').hidden, true, 'luu xong an Luu/Huy');
  assert.equal(page.w.TKSPriceAudit.hasUnsaved(), false);
  // Nguoi khac sua truoc -> 409
  page.server.rows[0].version = 5;
  page.server.rows[0].saleExplanation = 'Bản của người khác';
  box = openEditor(page, bodyRows(page)[0]);
  typeInto(page, box, 'Bản của tôi');
  box.querySelector('[data-action="save-explanation"]').click();
  await settle();
  const after = cell(page, bodyRows(page)[0], 'saleExplanation');
  assert.match(after.querySelector('.price-audit-edit-error').textContent, /thay đổi|cập nhật/);
  assert.equal(after.querySelector('textarea').value, 'Bản của tôi', 'giu ban dang go de nguoi dung quyet dinh');
  assert.match(after.textContent, /Bản của người khác/, 'hien noi dung moi nhat tu may chu');
  // Luu lai lan nua dung version moi
  after.querySelector('[data-action="save-explanation"]').click();
  await settle();
  const last = page.server.requests.filter(r => r.method === 'PATCH').at(-1);
  assert.equal(last.body.expectedVersion, 5);
});

test('giai thich chua luu khi doi bo loc: hoi giu/bo; chon giu thi khong tai lai', async () => {
  let answer = false;
  const page = await opened({ confirm: () => answer });
  const box = openEditor(page, bodyRows(page)[0]);
  typeInto(page, box, 'đang gõ');
  box.querySelector('textarea').dispatchEvent(new page.w.Event('input', { bubbles: true }));
  const before = gets(page).length;
  change(page, 'priceAuditStatusFilter', 'correct');
  await settle();
  assert.equal(page.confirms.length, 1);
  assert.equal(gets(page).length, before, 'giu noi dung -> khong tai lai');
  assert.equal(page.$('priceAuditStatusFilter').value, 'wrong', 'bo loc tro lai gia tri cu (mac dinh Sai gia)');
  assert.equal(cell(page, bodyRows(page)[0], 'saleExplanation').querySelector('textarea').value, 'đang gõ');
  answer = true;
  change(page, 'priceAuditStatusFilter', 'correct');
  await settle();
  assert.equal(gets(page).length, before + 1);
  assert.equal(page.w.TKSPriceAudit.hasUnsaved(), false);
});

test('ma hoa don mo popup chi tiet hoa don hien co kem nhan du lieu Kiot hien tai', async () => {
  const page = await opened();
  const link = cell(page, bodyRows(page)[0], 'invoiceCode').querySelector('[data-action="open-invoice"]');
  assert.ok(link);
  link.click();
  await settle();
  assert.equal(page.$('docModalBackdrop').hidden, false);
  assert.ok(page.server.requests.some(r => r.href.startsWith('/api/invoice-detail?code=HD1001&branch=')), 'goi API chi tiet hoa don hien co');
  const note = page.$('docModalBody').querySelector('.price-audit-popup-note');
  assert.ok(note, 'co nhan phan biet');
  assert.match(note.textContent, /hiện tại/);
});

test('bam tieu de cot: tang dan, giam dan, bo sap xep; gui sort/dir len may chu va ve trang 1', async () => {
  const page = await opened();
  const th = page.$('priceAuditHead').querySelector('th[data-sort="invoiceCode"]');
  const last = () => new URLSearchParams(gets(page).pop().href.split('?')[1]);
  th.querySelector('.sort-button').click();
  await settle();
  assert.equal(last().get('sort'), 'invoiceCode');
  assert.equal(last().get('dir'), 'asc');
  assert.equal(th.getAttribute('aria-sort'), 'ascending');
  assert.equal(th.querySelector('.sort-indicator').textContent, '▲1');
  th.querySelector('.sort-button').click();
  await settle();
  assert.equal(last().get('dir'), 'desc');
  assert.equal(th.querySelector('.sort-indicator').textContent, '▼1');
  th.querySelector('.sort-button').click();
  await settle();
  assert.equal(last().get('sort'), null);
  assert.equal(th.getAttribute('aria-sort'), 'none');
});

test('ma hoa don la chu thuong, khong xanh/gach chan', () => {
  const rule = html.match(/.price-audit-link {[^}]*}/)[0];
  assert.ok(!rule.includes('var(--blue)') && !rule.includes('underline'));
});

test('Ngay gio ban sap theo cot thoi gian sold_at, khong theo chu', () => {
  const repo = fs.readFileSync(path.join(__dirname, '..', '..', 'invoicePriceAudit', 'priceAuditRepository.js'), 'utf8');
  assert.match(repo, /soldAt: 'l.sold_at'/);
});

// ---- Muc 1: cot trai 5 khoi KPI doc, cot phai bang tien phat theo sale ----

const salesRowsText = page => [...page.$('priceAuditSalesRows').querySelectorAll('tr')].map(tr => [...tr.cells].map(td => td.textContent.trim()));
const footText = page => [...page.$('priceAuditSalesFoot').rows[0].cells].map(td => td.textContent.trim());
const saleTestRows = () => [
  line(1, { saleName: 'Duy Thái - 1234567890', originalAmount: '100000' }),
  line(2, { saleName: 'Duy Thái - 1234567890', originalAmount: '50000', decision: 'penalty' }),
  line(3, { saleName: 'Minh Anh', originalAmount: '30000', decision: 'penalty' }),
  line(4, { saleName: 'Minh Anh', originalAmount: '999', decision: 'ok' }),
  line(5, { saleName: 'Lan', originalAmount: '7000' })
];

test('bo cuc muc 1: khung KPI doc ben trai, panel tien phat theo sale ben phai (cung khung Chi so then chot cua Cong no)', () => {
  const page = createPage();
  const frame = page.doc.querySelector('#priceAuditSection .debt-key-frame');
  assert.ok(frame, 'dung khung debt-key-frame');
  const [left, right] = [...frame.children];
  assert.equal(left.id, 'priceAuditKpis');
  assert.ok(left.classList.contains('debt-key-stack'));
  assert.ok(right.classList.contains('panel') && right.contains(page.$('priceAuditSalesTable')));
  assert.ok(!page.$('priceAuditTable').closest('.debt-key-frame'), 'bang chi tiet nam ngoai khung');
  assert.deepEqual([...right.querySelectorAll('#priceAuditSalesTable thead th')].map(th => th.querySelector('.sort-label').textContent.trim()),
    ['Tên sale', 'Tiền phạt chưa chốt', 'Tiền phạt đã chốt']);
  assert.ok(right.querySelector('.panel-head > .panel-head-actions .export-button'), 'nut Xuat file o goc phai tren');
  assert.equal(right.querySelector('.table-search-input').placeholder, 'Nhập từ khóa…');
  assert.match(html, /@media \(max-width: 900px\)[\s\S]*?\.price-audit-key-frame\s*\{\s*grid-template-columns: 1fr;/, 'dien thoai: xep chong');
});

test('bang tien phat theo sale: tong moi cot khop KPI, ten sale, dong Tong dang hien thi', async () => {
  const page = await openedAll({ server: fakeServer({ rows: saleTestRows() }) });
  const cards = [...page.$('priceAuditKpis').querySelectorAll('.kpi-card')].map(c => c.querySelector('.value').textContent);
  assert.equal(cards.length, 5);
  assert.equal(cards[3], '107,000');
  assert.equal(cards[4], '80,000');
  assert.deepEqual(salesRowsText(page), [
    ['Duy Thái - 1234567890', '100,000', '50,000'], ['Minh Anh', '0', '30,000'], ['Lan', '7,000', '0']]);
  assert.deepEqual(footText(page), ['Tổng đang hiển thị', '107,000', '80,000']);
  assert.equal(page.$('tagPriceAuditSales').textContent, '3');
});

test('bang tien phat theo sale: tim theo ten sale, tong theo dong dang hien thi, xoa tim kiem, khong goi lai API', async () => {
  const page = await opened({ server: fakeServer({ rows: saleTestRows() }) });
  const before = gets(page).length;
  const search = page.$('priceAuditSalesSearch');
  search.value = 'minh';
  search.dispatchEvent(new page.w.Event('input', { bubbles: true }));
  assert.deepEqual(salesRowsText(page), [['Minh Anh', '0', '30,000']]);
  assert.deepEqual(footText(page), ['Tổng đang hiển thị', '0', '30,000']);
  assert.equal(page.$('tagPriceAuditSales').textContent, '1/3');
  assert.equal(page.$('priceAuditSalesSearchClear').hidden, false);
  search.value = 'zzzz';
  search.dispatchEvent(new page.w.Event('input', { bubbles: true }));
  assert.match(page.$('priceAuditSalesRows').textContent, /Không có sale nào chứa/);
  page.$('priceAuditSalesSearchClear').click();
  assert.equal(search.value, '');
  assert.equal(salesRowsText(page).length, 3);
  assert.equal(gets(page).length, before);
});

test('bang tien phat theo sale: tieu de cot sort theo quy uoc ▲▼ / ▼ / ▲ cua table-controls', async () => {
  const page = await opened({ server: fakeServer({ rows: saleTestRows() }) });
  const head = () => [...page.$('priceAuditSalesTable').querySelectorAll('thead th')];
  assert.ok(head().every(th => th.querySelector('.sort-button .sort-indicator')), 'moi cot co nut sort');
  assert.deepEqual(head().map(th => th.querySelector('.sort-indicator').textContent), ['▲▼', '▲▼', '▲▼']);
  head()[2].querySelector('.sort-button').click();
  assert.deepEqual(salesRowsText(page).map(r => r[0]), ['Lan', 'Minh Anh', 'Duy Thái - 1234567890']);
  assert.equal(head()[2].querySelector('.sort-indicator').textContent, '▲ 1');
  head()[2].querySelector('.sort-button').click();
  assert.deepEqual(salesRowsText(page).map(r => r[0]), ['Duy Thái - 1234567890', 'Minh Anh', 'Lan']);
  assert.equal(head()[2].querySelector('.sort-indicator').textContent, '▼ 1');
});

test('bang tien phat theo sale: nut Xuat file chi hien khi co reports.export va mo hop thoai kem bo loc + o tim kiem', async () => {
  const withExport = await opened({ server: fakeServer({ rows: saleTestRows() }) });
  const calls = [];
  withExport.w.startExportDialog = (payload, source) => { calls.push({ payload, source }); };
  assert.equal(withExport.$('priceAuditSalesExportButton').hidden, false);
  withExport.$('priceAuditSalesSearch').value = 'minh';
  withExport.$('priceAuditSalesSearch').dispatchEvent(new withExport.w.Event('input', { bubbles: true }));
  withExport.$('priceAuditSalesExportButton').click();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.kind, 'priceAuditSales');
  const q = new URLSearchParams(calls[0].payload.query);
  assert.equal(q.get('saleSearch'), 'minh');
  assert.equal(q.get('status'), 'wrong');
  const urls = [];
  withExport.w.exportFetch = url => { urls.push(url); return Promise.resolve({}); };
  calls[0].source.fields(calls[0].payload, {});
  calls[0].source.file({ ...calls[0].payload, format: 'xlsx', columns: { priceAuditSales: ['saleName', 'pendingAmount'] } }, {});
  assert.match(urls[0], /^\/api\/invoice-price-audit\/export\/sales\/fields\?/);
  assert.match(urls[1], /^\/api\/invoice-price-audit\/export\/sales\?/);
  assert.equal(new URLSearchParams(urls[1].split('?')[1]).get('columns'), 'saleName,pendingAmount');
  const noExport = await opened({ permissions: ['reports.invoices', 'reports.invoices.priceAudit'], server: fakeServer({ rows: saleTestRows() }) });
  assert.equal(noExport.$('priceAuditSalesExportButton').hidden, true);
});

test('mau chu trang thai Chot: Ok xanh la, Phat do (token CSS, chi doi mau chu)', async () => {
  const page = await openedAll({ server: fakeServer({ rows: [line(1, { decision: 'ok', originalAmount: '100' }), line(2, { decision: 'penalty', canDecide: false }), line(3, { canDecide: false })] }) });
  const select = page.$('priceAuditRows').querySelector('select.price-audit-decision');
  assert.equal(select.dataset.status, 'Ok');
  const text = [...page.$('priceAuditRows').querySelectorAll('.price-audit-decision-text')].map(el => el.dataset.status);
  assert.deepEqual(text.sort(), ['Chưa chốt', 'Phạt']);
  assert.match(html, /\.price-audit-decision\[data-status="Ok"\][\s\S]*?color: var\(--green\)/);
  assert.match(html, /\.price-audit-decision\[data-status="Phạt"\][\s\S]*?color: var\(--red\)/);
});
