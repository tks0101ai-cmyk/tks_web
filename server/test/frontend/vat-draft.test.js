'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions, PAGE_FEATURES } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'vat-draft/index.html'), 'utf8');
const code = fs.readFileSync(path.join(publicDir, 'vat-draft/vat-draft.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const GIA_NHAP = 'GIÁ NHÁP\n(Giá bán/(1+%VAT))';

const ALLOC_COLUMNS = ['Trạng thái', 'MÃ SP', 'TÊN SP', 'Mã VAT', 'TÊN VAT', 'Mã hóa đơn', 'Ghi chú hàng hóa', 'Ghi chú tổng',
  'NGUỒN', 'TỒN CÒN NHÁP', 'Giá bán', 'TÊN KẾ TOÁN', 'ĐVT', 'SL', GIA_NHAP, '%VAT', 'Thành tiền'];
const allocRow = (status, maSp, sl, nguon, reason = '') => ({
  values: [status, maSp, 'Tên ' + maSp, 'VAT01', 'Tên VAT', 'HD1', 'màu xanh', 'giao sáng', nguon, 150, 10800, 'KT1', 'Cái', sl, 10000, 8.000000000000002, 2160000],
  reason
});

function api(overrides = {}) {
  return {
    'GET /meta': { masterData: { loadedAt: '2026-10-17T02:00:00Z', stale: false, stockRows: 8432, mappingRows: 2998, error: null },
      sync: [{ branch: 'hanoi', entity: 'invoices', syncedAt: new Date().toISOString() }],
      vietqr: { template: 'compact2', commonBankCodes: 'VCB, MB', accounts: [{ key: 'tks_group', label: 'MB TKS — MB 606266688888' }, { key: 'shc', label: 'MB SHC — MB 525345345' }] } },
    'POST /documents/resolve': { found: [
      { kind: 'invoice', branch: 'hanoi', code: 'HD028345', date: '16/10/2026 14:54', customerName: 'KH A', customerCode: 'KH1', note: 'thắng thức 16/10', status: 'Hoàn thành', orderCode: 'DH1', total: 82582000, selectable: true, warning: '' },
      { kind: 'order', branch: 'saigon', code: 'DH044391', date: '16/10/2026 11:00', customerName: 'Chị Lan', customerCode: '', note: '', status: 'Phiếu tạm', orderCode: '', total: 45000, selectable: true, warning: 'Đơn đã xuất hóa đơn: HD028345' }
    ], notFound: ['HD999'], ambiguous: [], invalid: ['ABC'] },
    'GET /documents/detail': { detail: { kind: 'invoice', code: 'HD028345', date: '16/10/2026 14:54', customerName: 'KH A', customerCode: 'KH1', seller: 'Võ Nữ Hồng Trinh',
      status: 'Hoàn thành', orderCode: 'DH1', total: 13140000, discount: 0, paid: 0, note: 'giao giúp e', lineCount: 2, totalQuantity: 260,
      lines: [{ productCode: 'KTHQ1M4', productName: 'Khăn tắm bông', quantity: 200, price: 14900, discount: 0, amount: 2980000, note: '' },
        { productCode: '40CCS', productName: 'Chổi chà sàn', quantity: 60, price: 11100, discount: 200, amount: 654000, note: 'màu xanh' }] } },
    'POST /allocate': { hasMeta: true, columns: ALLOC_COLUMNS,
      rows: [allocRow('OK', 'SP01', 150, 'TKS THẤP'), allocRow('OK', 'SP01', 50, 'VC'), allocRow('Không có mã', 'KHONGCO', 10, '', "Không tìm thấy Mã SP 'KHONGCO'.")],
      metrics: { inputCount: 2, okProducts: 1, shortageProducts: 0, missingCount: 1 },
      qr: { transferContent: 'HD028345 DH050000',
        bySource: [{ nguon: 'TKS THẤP', soDong: 1, tongGiaNhap: 1500000, thieuDonGia: false, defaultAccountKey: 'tks_group', defaultAmount: 1500000 },
          { nguon: 'VC', soDong: 1, tongGiaNhap: 500000, thieuDonGia: true, defaultAccountKey: 'shc', defaultAmount: 500000 }],
        total: { soDong: 2, tongGiaBan: 2160000, thieuDonGia: false, defaultAccountKey: 'tks_group', defaultAmount: 2160000 } },
      masterData: { stockRows: 8432, mappingRows: 2998 } },
    'POST /qr/url': { url: 'https://img.vietqr.io/image/MB-606266688888-compact2.png?amount=1500000', amount: 1500000, accountLabel: 'MB TKS', addInfo: 'HD028345 DH050000' },
    ...overrides
  };
}

async function setup(t, { hash = '#xu-ly', responses = api(), vaiTro = 'Quản lý' } = {}) {
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vat-draft/' + hash, runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const window = dom.window;
  window.HTMLElement.prototype.scrollIntoView = function () {};
  window.URL.createObjectURL = () => 'blob:x';
  window.URL.revokeObjectURL = () => {};
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const user = { vaiTro, branch: 'Cả hai', permissions: resolvePermissions({ vaiTro }), pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return { ok: true, status: 200, json: async () => ({ tables: {} }) };
    const key = `${options.method || 'GET'} ${parsed.pathname.replace('/api/vat-draft', '')}`;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ key, query: Object.fromEntries(parsed.searchParams), body });
    const data = responses[key];
    return {
      ok: data !== undefined, status: data !== undefined ? 200 : 404,
      headers: { get: () => key === 'POST /export' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/json' },
      json: async () => data ?? { error: 'Không có' },
      blob: async () => new window.Blob(['x'])
    };
  };
  window.eval(fs.readFileSync(path.join(publicDir, 'vat-draft/cell-select.js'), 'utf8'));
  window.eval(code);
  await window.TKSVatDraft.init();
  await tick();
  return { window, doc: window.document, calls };
}

/** Dan ma vao o + bam Xu ly (tra ma roi phan bo luon). */
async function pasteAndRun(doc, text = 'HD999 HD028345 abc DH044391') {
  doc.getElementById('vdCodesInput').value = text;
  doc.getElementById('vdRunCodes').click();
  await tick(); await tick(); await tick();
}

test('tai trang: trang thai Sheets/KiotViet; chi con o dan ma + Co so + Xu ly, khong con bang tick chon / bo loc', async t => {
  const { doc, calls } = await setup(t);
  assert.match(doc.getElementById('vdSheetsStatus').textContent, /Gộp VAT 8,432 dòng · Khớp mã 2,998 dòng/);
  assert.deepEqual(calls.map(c => c.key), ['GET /meta'], 'khong tai danh sach chung tu luc mo trang');
  assert.equal(doc.getElementById('vdBranch').value, 'all', 'user Ca hai -> Co so ca hai');
  assert.equal(doc.getElementById('vdDocList').hidden, true);
  for (const id of ['vdDocsTable', 'vdKind', 'vdFrom', 'vdTo', 'vdSearch', 'vdDocsExport', 'vdDocsPager', 'vdChips', 'vdRunDocs', 'vdAddCodes']) {
    assert.equal(doc.getElementById(id), null, id + ' da bo');
  }
  assert.equal(doc.querySelector('.vd-tabs [aria-current="page"]').dataset.vatDraftTab, 'xu-ly');
  assert.ok(doc.querySelector('#sidebar a[href="/vat-draft/#xu-ly"]'), 'sidebar co nhom Ke toan');
});

test('dan ma + Xu ly: tra ma roi phan bo luon cac chung tu hop le; danh sach theo thu tu dan, dong loi co ly do', async t => {
  const { doc, calls } = await setup(t);
  await pasteAndRun(doc);
  const resolve = calls.find(c => c.key === 'POST /documents/resolve');
  assert.deepEqual([resolve.query.branch, resolve.body], ['all', { text: 'HD999 HD028345 abc DH044391' }]);
  assert.deepEqual(calls.find(c => c.key === 'POST /allocate').body, { source: 'documents', documents: [
    { kind: 'invoice', branch: 'hanoi', code: 'HD028345' }, { kind: 'order', branch: 'saigon', code: 'DH044391' }
  ] });
  assert.equal(doc.getElementById('vdDocList').hidden, false);
  const rows = [...doc.querySelectorAll('#vdDocListRows tr')];
  assert.deepEqual(rows.map(r => r.cells[0].textContent), ['HD999', 'HD028345', 'ABC', 'DH044391']);
  assert.deepEqual(rows.map(r => r.dataset.tone || ''), ['error', '', 'error', 'warning']);
  assert.deepEqual(rows.map(r => r.hasAttribute('data-open')), [false, true, false, true]);
  assert.match(rows[0].textContent, /Không tìm thấy/);
  assert.match(rows[2].textContent, /Không phải mã HD\/DH/);
  assert.match(rows[3].textContent, /Phiếu tạmĐơn đã xuất hóa đơn: HD028345/);
  assert.deepEqual([...rows[1].cells].map(c => c.textContent), ['HD028345', 'Hà Nội', 'KH A · KH1', '16/10/2026 14:54', 'Hoàn thành · DH1', '82,582,000']);
  assert.match(doc.getElementById('vdDocListCount').textContent, /4 mã · 2 mã lỗi/);
  assert.match(doc.getElementById('vdCodesMessage').textContent, /Xử lý 2 chứng từ · bỏ qua 2 mã lỗi/);
  assert.equal(doc.getElementById('vdAllocResult').hidden, false);
});

test('dan ma: o trong -> nhac; ma co o ca 2 co so -> dung lai, khong phan bo, nhac chon Co so', async t => {
  const responses = api({ 'POST /documents/resolve': { found: [], notFound: [], invalid: [],
    ambiguous: [{ code: 'HD016024', matches: [{ branch: 'hanoi' }, { branch: 'saigon' }] }] } });
  const { doc, window, calls } = await setup(t, { responses });
  doc.getElementById('vdRunCodes').click();
  await tick();
  assert.equal(doc.getElementById('vdCodesMessage').textContent, 'Hãy dán ít nhất một mã chứng từ.');
  assert.ok(!calls.some(c => c.key === 'POST /documents/resolve'));
  // Ctrl+Enter trong o dan ma = bam Xu ly.
  doc.getElementById('vdCodesInput').value = 'HD016024';
  doc.getElementById('vdCodesInput').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
  await tick(); await tick(); await tick();
  assert.ok(calls.some(c => c.key === 'POST /documents/resolve'));
  assert.ok(!calls.some(c => c.key === 'POST /allocate'), 'ma trung -> khong xu ly');
  assert.match(doc.getElementById('vdCodesMessage').textContent, /HD016024 có ở cả Hà Nội lẫn Sài Gòn — chọn Cơ sở/);
  assert.match(doc.querySelector('#vdDocListRows tr').textContent, /chọn Cơ sở rồi bấm Xử lý lại/);
  assert.equal(doc.activeElement, doc.getElementById('vdBranch'));
});

test('bam dong hoa don da dan -> hop chi tiet giong dashboard (the tong tien, thong tin chung, hang hoa); Esc dong', async t => {
  const { doc, window, calls } = await setup(t);
  await pasteAndRun(doc);
  doc.querySelector('#vdDocListRows tr:nth-child(1)').click(); // dong loi: khong mo
  assert.equal(doc.getElementById('vdDocModal').hidden, true);
  const row = doc.querySelector('#vdDocListRows tr:nth-child(2)');
  row.click();
  await tick(); await tick();
  assert.deepEqual(calls.find(c => c.key === 'GET /documents/detail').query, { kind: 'invoice', branch: 'hanoi', code: 'HD028345' });
  assert.equal(doc.getElementById('vdDocModal').hidden, false);
  assert.equal(doc.getElementById('vdDocModalTitle').textContent, 'Chi tiết giao dịch HD028345');
  assert.equal(doc.getElementById('vdDocModalSubtitle').textContent, 'Cơ sở Hà Nội');
  const body = doc.getElementById('vdDocModalBody');
  assert.deepEqual([...body.querySelectorAll('.dp-stat-value')].map(e => e.textContent), ['13,140,000₫', '0₫', '13,140,000₫']);
  assert.match(body.querySelector('.dp-meta').textContent, /Võ Nữ Hồng Trinh/);
  assert.match(body.querySelector('.dp-meta').textContent, /Từ đơn đặt hàngDH1/);
  assert.equal(body.querySelectorAll('.dp-table tbody tr').length, 2);
  assert.match(body.querySelector('.dp-table thead').textContent, /Giảm giá/, 'co dong giam gia -> hien cot Giam gia');
  assert.match(body.querySelector('.dp-table tfoot').textContent, /Cộng hàng hóa260/);
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.getElementById('vdDocModal').hidden, true);
  assert.equal(doc.activeElement, row, 'tra focus ve dong vua bam');
  // Enter tren dong don dat hang -> tieu de "Chi tiet don dat hang", goi dung co so.
  doc.querySelector('#vdDocListRows tr:nth-child(4)').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(); await tick();
  assert.deepEqual(calls.filter(c => c.key === 'GET /documents/detail').pop().query, { kind: 'order', branch: 'saigon', code: 'DH044391' });
  assert.match(doc.getElementById('vdDocModalTitle').textContent, /^Chi tiết đơn đặt hàng DH044391$/);
});

test('hop chi tiet: loi may chu hien trong hop + nut Thu lai', async t => {
  const responses = api();
  delete responses['GET /documents/detail'];
  const { doc, calls } = await setup(t, { responses });
  await pasteAndRun(doc);
  doc.querySelector('#vdDocListRows tr[data-open]').click();
  await tick(); await tick();
  assert.match(doc.getElementById('vdDocModalBody').textContent, /Không có/);
  doc.querySelector('[data-doc-retry]').click();
  await tick(); await tick();
  assert.equal(calls.filter(c => c.key === 'GET /documents/detail').length, 2);
  doc.getElementById('vdDocModalClose').click();
  assert.equal(doc.getElementById('vdDocModal').hidden, true);
});

test('xu ly chung tu: bang co Ghi chu tong canh Ghi chu hang hoa, ly do khi re chuot, QR dien san ma chung tu', async t => {
  const { doc, calls } = await setup(t);
  await pasteAndRun(doc);
  assert.equal(doc.getElementById('vdAllocResult').hidden, false);
  const headers = [...doc.querySelectorAll('#vdAllocTable thead th')].map(th => th.querySelector('.sort-label') ? th.querySelector('.sort-label').textContent : th.textContent);
  assert.equal(headers.indexOf('Ghi chú tổng'), headers.indexOf('Ghi chú hàng hóa') + 1);
  assert.ok([...doc.querySelectorAll('#vdAllocTable thead th')].every(th => th.dataset.columnKey));
  const missing = doc.querySelector('#vdAllocRows tr:nth-child(3) td');
  assert.equal(missing.className, 'vd-status-missing');
  assert.equal(missing.title, "Không tìm thấy Mã SP 'KHONGCO'.");
  assert.equal(doc.getElementById('vdMetricMissing').textContent, '1');
  assert.match(doc.getElementById('vdAllocBanner').textContent, /1 OK · 1 không có mã/);
  assert.equal(doc.getElementById('vdTransfer').value, 'HD028345 DH050000');
  const cards = doc.querySelectorAll('[data-qr-card]');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].querySelector('[data-qr-amount]').value, '1,500,000 đ');
  assert.equal(cards[1].querySelector('[data-qr-account]').value, 'shc');
  assert.match(cards[1].textContent, /thiếu Giá bán/);
  doc.querySelector('[data-qr-mode="khong_vat"]').click();
  assert.equal(doc.querySelectorAll('[data-qr-card]').length, 1);
  assert.equal(doc.querySelector('[data-qr-amount]').value, '2,160,000 đ');
  doc.querySelector('[data-qr-generate]').click();
  await tick(); await tick();
  assert.deepEqual(calls.find(c => c.key === 'POST /qr/url').body, { accountKey: 'tks_group', amount: '2160000', addInfo: 'HD028345 DH050000' });
  assert.ok(doc.querySelector('[data-qr-result] img').src.startsWith('https://img.vietqr.io/'));

  // Bam anh QR -> phong to; Esc dong; nut Tai ma QR tai anh ve.
  doc.querySelector('[data-qr-zoom]').click();
  const viewer = doc.getElementById('vdQrViewer');
  assert.equal(viewer.hidden, false);
  assert.equal(doc.getElementById('vdQrViewerImg').src, 'https://img.vietqr.io/image/MB-606266688888-compact2.png?amount=1500000');
  assert.match(doc.getElementById('vdQrViewerCaption').textContent, /Tất cả nguồn — 1,500,000đ/);
  doc.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(viewer.hidden, true);
  doc.querySelector('[data-qr-download]').click();
  await tick(); await tick();
  assert.ok(calls.some(c => c.key.startsWith('GET /image/MB-606266688888-compact2.png')), 'tai anh QR ve');
});

test('sap xep 2 cot nhu app cu, xuat Excel theo dung thu tu dang hien thi', async t => {
  const { doc, window, calls } = await setup(t);
  await pasteAndRun(doc);
  const choose = (id, value) => { doc.getElementById(id).value = value; doc.getElementById(id).dispatchEvent(new window.Event('change')); };
  const column = name => [...doc.querySelectorAll('#vdAllocRows tr')].map(tr => tr.children[ALLOC_COLUMNS.indexOf(name)].firstChild.textContent);
  // Chi chon cot phu -> nhac chon cot chinh truoc, chua sap xep.
  choose('vdSortSecondary', 'SL');
  assert.match(doc.getElementById('vdSortNote').textContent, /Chọn cột sắp xếp chính trước/);
  assert.deepEqual(column('SL'), ['150', '50', '10']);
  // Chinh: Trang thai giam dan, phu: SL tang dan.
  choose('vdSortPrimary', 'Trạng thái');
  choose('vdSortPrimaryDir', 'desc');
  assert.deepEqual(column('Trạng thái'), ['OK', 'OK', 'Không có mã']);
  assert.deepEqual(column('SL'), ['50', '150', '10']);
  assert.match(doc.getElementById('vdSortNote').textContent, /Đang sắp xếp theo cột đã chọn/);
  choose('vdSortPrimary', 'SL');
  choose('vdSortPrimaryDir', 'asc');
  assert.equal(doc.querySelector('#vdAllocTable thead th[title="GIÁ NHÁP (Giá bán/(1+%VAT))"]').dataset.defaultWidth, '96');
  doc.getElementById('vdAllocExcel').click();
  await tick();
  const exported = calls.find(c => c.key === 'POST /export').body;
  assert.equal(exported.view, 'allocation');
  const slIndex = exported.columns.indexOf('SL');
  assert.deepEqual(exported.rows.map(r => r[slIndex]), [10, 50, 150]);
});

test('CSV giu dinh dang so cua pandas (repr float), BOM, xuong dong trong o duoc bao nhay kep', async t => {
  const { window } = await setup(t);
  const { pyFloatRepr, csvCell } = window.TKSVatDraft;
  assert.equal(pyFloatRepr(150), '150.0');
  assert.equal(pyFloatRepr(8.000000000000002), '8.000000000000002');
  assert.equal(pyFloatRepr(10648.15), '10648.15');
  assert.equal(csvCell(GIA_NHAP, GIA_NHAP), '"GIÁ NHÁP\n(Giá bán/(1+%VAT))"');
  assert.equal(csvCell('Ghi chú hàng hóa', 'a, "b"'), '"a, ""b"""');
  assert.equal(csvCell('SL', null), '');
});

test('tab Tao QR: tai khoan nhap tay can du ma ngan hang + so TK, hash doi tab', async t => {
  const { doc, window } = await setup(t, { hash: '#tao-qr' });
  assert.equal(doc.getElementById('vdInputPanel').hidden, true);
  assert.equal(doc.getElementById('vdQrPage').hidden, false);
  // Tra cuu nguon da go: chi con 2 tab tren trang va trong menu.
  assert.deepEqual([...doc.querySelectorAll('.vd-tabs [data-vat-draft-tab]')].map(a => a.dataset.vatDraftTab), ['xu-ly', 'tao-qr']);
  assert.deepEqual([...doc.querySelectorAll('#sidebar a[href^="/vat-draft/"]')].map(a => a.getAttribute('href')), ['/vat-draft/#xu-ly', '/vat-draft/#tao-qr']);
  assert.equal(doc.getElementById('vdLookupResult'), null);
  const select = doc.getElementById('vdManualAccount');
  // Mac dinh chua chon tai khoan: nut khoa, chi nhac ly do, KHONG bao loi khi chua thao tac.
  assert.equal(select.value, '');
  assert.equal(doc.getElementById('vdManualGenerate').disabled, true);
  assert.equal(doc.getElementById('vdManualInvalid').hidden, true);
  assert.match(doc.getElementById('vdQrBlocker').textContent, /Chọn tài khoản nhận tiền/);
  // Tab Tao QR: an trang thai Sheets/KiotViet (chi phuc vu Xu ly hoa don).
  assert.equal(doc.getElementById('vdSourceBar').hidden, true);
  select.value = '__manual__';
  select.dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('vdManualFields').hidden, false);
  assert.equal(doc.getElementById('vdManualGenerate').disabled, true);
  doc.getElementById('vdManualBank').value = 'ACB';
  doc.getElementById('vdManualBank').dispatchEvent(new window.Event('input'));
  doc.getElementById('vdManualNo').value = '123456';
  doc.getElementById('vdManualNo').dispatchEvent(new window.Event('input'));
  assert.equal(doc.getElementById('vdManualGenerate').disabled, false);
  select.value = 'shc';
  select.dispatchEvent(new window.Event('change'));
  assert.equal(doc.getElementById('vdManualFields').hidden, true);
  const changed = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true }));
  window.location.hash = 'xu-ly';
  await changed;
  assert.equal(doc.getElementById('vdInputPanel').hidden, false);
  assert.equal(doc.getElementById('vdQrPage').hidden, true);
  assert.equal(doc.getElementById('vdSourceBar').hidden, false);
  assert.equal(doc.getElementById('vdSourceBar').dataset.tone, 'ok');
  assert.match(doc.getElementById('vdStatusSummary').textContent, /Dữ liệu cập nhật/);
});

test('tab Tao QR: nhom tai khoan, tom tat truoc khi tao, Enter tao QR, doi so tien thi QR cu bi vo hieu', async t => {
  const meta = api()['GET /meta'];
  const responses = api({ 'GET /meta': { ...meta, vietqr: { ...meta.vietqr, accounts: [
    { key: 'shc', label: 'MB SHC — MB 525345345 (CONG TY SHC)', bankId: 'MB', accountNo: '525345345', accountName: 'CONG TY SHC', group: 'company' },
    { key: 'acb_a_quan', label: 'ACB QUÂN — ACB 48206877 (NGUYEN VAN QUAN)', bankId: 'ACB', accountNo: '48206877', accountName: 'NGUYEN VAN QUAN', group: 'personal' }
  ] } } });
  const { doc, window, calls } = await setup(t, { hash: '#tao-qr', responses });
  const groups = [...doc.querySelectorAll('#vdManualAccount optgroup')].map(g => g.label);
  assert.deepEqual(groups, ['Tài khoản công ty', 'Tài khoản cá nhân', 'Khác']);
  const select = doc.getElementById('vdManualAccount');
  select.value = 'shc';
  select.dispatchEvent(new window.Event('change'));
  assert.match(doc.getElementById('vdAccountDetail').textContent, /CONG TY SHC.*MB · 525345345/s);
  assert.equal(doc.getElementById('vdQrPanel').dataset.state, 'ready');
  const amount = doc.getElementById('vdManualAmount');
  amount.value = '1320002';
  amount.dispatchEvent(new window.Event('input'));
  assert.equal(doc.getElementById('vdSumAmount').textContent, '1,320,002 đ');
  assert.equal(doc.getElementById('vdSumBank').textContent, 'MB · 525345345');
  // Enter trong o Số tiền = tao QR
  amount.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick(); await tick();
  assert.equal(amount.value, '1,320,002');
  assert.deepEqual(calls.filter(c => c.key === 'POST /qr/url').map(c => [c.body.accountKey, c.body.amount]), [['shc', '1320002']]);
  assert.equal(doc.getElementById('vdQrPanel').dataset.state, 'success');
  assert.equal(doc.getElementById('vdQrActions').hidden, false);
  assert.equal(doc.getElementById('vdQrCta').hidden, true);
  // Sua so tien sau khi tao: QR cu bi danh dau het hieu luc, an nut tai, nut chinh doi thanh Tạo lại
  amount.value = '1320000';
  amount.dispatchEvent(new window.Event('input'));
  assert.equal(doc.getElementById('vdQrPanel').dataset.state, 'stale');
  assert.equal(doc.getElementById('vdQrActions').hidden, true);
  assert.equal(doc.querySelector('#vdManualResult .vd-qr-stale').hidden, false);
  assert.equal(doc.getElementById('vdGenerateLabel').textContent, 'Tạo lại mã QR');
  // Doi lai dung so cu: QR hop le tro lai
  amount.value = '1,320,002';
  amount.dispatchEvent(new window.Event('input'));
  assert.equal(doc.getElementById('vdQrPanel').dataset.state, 'success');
  // Tao QR moi: xoa het, ve trang thai ban dau
  doc.getElementById('vdQrNew').click();
  assert.deepEqual([select.value, amount.value, doc.getElementById('vdQrPanel').dataset.state], ['', '', 'empty']);
});

test('tab Tao QR: QR hien o cot phai, thay cho dong "Mã QR sẽ hiện ở đây"', async t => {
  const { doc, calls } = await setup(t, { hash: '#tao-qr' });
  const preview = doc.querySelector('#vdQrPage .vd-qr-preview');
  assert.ok(preview && preview.contains(doc.getElementById('vdManualResult')));
  assert.equal(doc.getElementById('vdQrPlaceholder').hidden, false);
  assert.equal(doc.getElementById('vdQrPanel').dataset.state, 'empty');
  assert.equal(doc.getElementById('vdManualResult').hidden, true);
  const select = doc.getElementById('vdManualAccount');
  select.value = 'tks_group';
  select.dispatchEvent(new doc.defaultView.Event('change'));
  doc.getElementById('vdManualGenerate').click();
  await tick(); await tick();
  assert.equal(calls.find(c => c.key === 'POST /qr/url').body.accountKey, 'tks_group');
  assert.equal(doc.getElementById('vdQrPlaceholder').hidden, true);
  assert.ok(preview.querySelector('figure img').src.startsWith('https://img.vietqr.io/'));
  assert.ok(preview.querySelector('[data-qr-download]'));
});

test('Nhan vien sale: chi thay Tao QR, khong tai chung tu, hash #xu-ly van o Tao QR', async t => {
  const responses = api({ 'GET /meta': { vietqr: api()['GET /meta'].vietqr } });
  const { doc, calls } = await setup(t, { hash: '#xu-ly', responses, vaiTro: 'Nhân viên sale' });
  assert.equal(doc.getElementById('vdQrPage').hidden, false);
  assert.equal(doc.getElementById('vdInputPanel').hidden, true);
  // Thanh tab Ke toan van hien voi sale, chi thieu Xu ly hoa don.
  assert.equal(doc.querySelector('.vd-tabs').hidden, false);
  assert.deepEqual([...doc.querySelectorAll('.vd-tabs a')].map(a => a.getAttribute('href')), ['/vat-draft/#tao-qr', '/vat-lookup/', '/vat-request/']);
  assert.equal(doc.getElementById('vdSourceBar').hidden, true);
  assert.equal(doc.getElementById('vdTitle').textContent, 'Tạo QR chuyển khoản');
  assert.deepEqual(calls.map(c => c.key), ['GET /meta'], 'sale chi tai /meta');
  assert.deepEqual([...doc.querySelectorAll('#sidebar a[href^="/vat-draft/"]')].map(a => a.getAttribute('href')), ['/vat-draft/#tao-qr']);
  assert.ok(doc.getElementById('vdManualAccount').querySelector('option[value="tks_group"]'), 'van co danh sach tai khoan');
});

test('loi may chu hien ro cho nguoi dung', async t => {
  const responses = api();
  delete responses['POST /allocate'];
  const { doc } = await setup(t, { responses });
  doc.querySelector('[data-input-mode="paste"]').click();
  doc.getElementById('vdPasteInvoice').value = 'SP01\tA\t1';
  doc.getElementById('vdRunPasteInvoice').click();
  await tick(); await tick();
  assert.equal(doc.getElementById('vdRunError').textContent, 'Không có');
});

test('o Co so: doi sang Sai Gon thi dan ma tra theo dung co so', async t => {
  const { doc, calls } = await setup(t);
  doc.getElementById('vdBranch').value = 'saigon';
  await pasteAndRun(doc, 'DH044391');
  assert.equal(calls.find(c => c.key === 'POST /documents/resolve').query.branch, 'saigon');
});

test('bam tieu de bang ket qua: dong bo o "Sắp xếp chính"; so dung dau phay', async t => {
  const { doc } = await setup(t);
  await pasteAndRun(doc);
  const slButton = () => doc.querySelector('#vdAllocTable [data-sort-field="SL"]');
  slButton().click();
  assert.equal(doc.getElementById('vdSortPrimary').value, 'SL');
  assert.equal(doc.getElementById('vdSortPrimaryDir').value, 'asc');
  assert.deepEqual([...doc.querySelectorAll('#vdAllocRows tr')].map(tr => tr.children[13].textContent), ['10', '50', '150']);
  slButton().click();
  assert.equal(doc.getElementById('vdSortPrimaryDir').value, 'desc');
  assert.equal(slButton().querySelector('.sort-indicator').textContent, '▲');
  slButton().click();
  assert.equal(doc.getElementById('vdSortPrimary').value, '');
  assert.equal(doc.querySelector('#vdAllocRows tr td:nth-child(11)').textContent, '10,800');
});

test('bang luon vua khung: do rong cot theo ti le %, bang 100%', async t => {
  const { doc, window } = await setup(t);
  await pasteAndRun(doc);
  const table = doc.getElementById('vdDocListTable');
  window.TKSTables.refresh(table);
  assert.equal(table.dataset.tableFit, 'contain');
  assert.equal(table.style.width, '100%');
  const widths = [...table.querySelectorAll(':scope > colgroup > col')].map(col => col.style.width);
  assert.ok(widths.length && widths.every(w => w.endsWith('%')), widths.join());
  const sum = widths.reduce((s, w) => s + parseFloat(w), 0);
  assert.ok(Math.abs(sum - 100) < 0.01, String(sum));
});

test('chon o kieu Google Sheet: keo chuot chon vung, Shift+click noi, Ctrl+C chep TSV khong kem tieu de', async t => {
  const { doc, window } = await setup(t);
  await pasteAndRun(doc);
  const cell = (r, c) => doc.querySelectorAll('#vdAllocRows tr')[r].cells[c];
  const fire = (el, type, init = {}) => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(event);
    return event;
  };
  const down = fire(cell(0, 1), 'mousedown');
  assert.equal(down.defaultPrevented, true);
  fire(cell(1, 2), 'mouseover');
  fire(doc, 'mouseup');
  assert.equal(doc.querySelectorAll('#vdAllocRows td.vd-cell-sel').length, 4);
  assert.ok(cell(0, 1).classList.contains('vd-cell-anchor'));
  fire(cell(2, 2), 'mousedown', { shiftKey: true });
  fire(doc, 'mouseup');
  assert.equal(doc.querySelectorAll('#vdAllocRows td.vd-cell-sel').length, 6);
  let copied = null;
  const copy = new window.Event('copy', { bubbles: true, cancelable: true });
  copy.clipboardData = { setData: (type, text) => { copied = { type, text }; } };
  doc.dispatchEvent(copy);
  assert.equal(copy.defaultPrevented, true);
  assert.deepEqual(copied, { type: 'text/plain', text: 'SP01\tTên SP01\nSP01\tTên SP01\nKHONGCO\tTên KHONGCO' });
  doc.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(doc.querySelectorAll('td.vd-cell-sel').length, 0);
  assert.equal(doc.getElementById('vdDocListTable').dataset.cellSelect, undefined);
});
