'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registry = require('../auth/featureRegistry');
const { ROLES } = require('../auth/userRepository');
const { BRANCH_COOKIE_NAME } = require('../branch/branchMiddleware');
const { createVatDraftRouter } = require('./vatDraftRoutes');
const { resolveInvoiceTotal } = require('./vatDraftService');

const stock = (rowIndex, nguon, maVat, tenKt, ton, thueVat = 0.08) => ({
  rowIndex, nguon, maKiotDaiDien: '', tenKiotDaiDien: '', maVatKiot: maVat, tenVatKiot: 'Tên VAT', tenKeToan: tenKt, donViTinh: 'Cái',
  tonDauNgay: ton, giaBan: 0, thueVat, thueNk: null, tongThueMat: null, tongDangNhap: 0, tonCoTheNhap: ton,
  maVatKiotNorm: maVat.toLowerCase(), tenKeToanNorm: tenKt.toLowerCase(), donViTinhNorm: 'cái'
});
const mapping = (maSp, maVat) => ({ rowIndex: 2, maSp, tenSp: `Tên ${maSp}`, maVatKiot: maVat, tenTruocVat: '', maSpNorm: maSp.toLowerCase(), maVatKiotNorm: maVat.toLowerCase() });

const MASTER = {
  stockRows: [stock(2, 'TKS THẤP', 'VAT01', 'KT1', 150), stock(3, 'VC', 'VAT01', 'KT2', 100), stock(4, 'SHC', 'VAT02', 'KT3', 5)],
  mappingRows: [mapping('SP01', 'VAT01'), mapping('SP02', 'VAT02')],
  warnings: [],
  loadedAt: Date.parse('2026-10-17T02:00:00Z'),
  stale: false
};

function fakeRepository(overrides = {}) {
  const calls = {};
  return {
    calls,
    resolveCodes: async args => { calls.resolve = args; return { found: [], notFound: args.codes, ambiguous: [] }; },
    readDocumentLines: async selections => {
      calls.read = selections;
      return [
        { kind: 'invoice', branch: 'hanoi', code: 'HD1', status: 'Hoàn thành', docNote: 'giao sáng', lines: [
          { productCode: 'SP01', productName: 'Sản phẩm 1', quantity: '200', unitPrice: '10800', lineTotal: '2160000', note: 'màu xanh' },
          { productCode: '', productName: 'dòng trống', quantity: '1', unitPrice: '1', lineTotal: '1', note: '' }
        ] },
        { kind: 'order', branch: 'hanoi', code: 'DH2', status: 'Phiếu tạm', docNote: '', lines: [
          { productCode: 'SP02', productName: 'Sản phẩm 2', quantity: '50', unitPrice: '9000', lineTotal: '450000', note: '' },
          { productCode: 'KHONGCO', productName: 'Không có', quantity: '10', unitPrice: '8000', lineTotal: '80000', note: '' }
        ] }
      ];
    },
    syncStatus: async () => [{ branch: 'hanoi', entity: 'invoices', syncedAt: '2026-10-17T02:00:00Z' }],
    ...overrides
  };
}

function fakeMaster({ fail = false } = {}) {
  return {
    get: async () => { if (fail) { const e = new Error('Sheet không còn chia sẻ công khai'); e.statusCode = 503; e.code = 'SHEET_NOT_PUBLIC'; throw e; } return MASTER; },
    refresh: async () => ({ ...MASTER, loadedAt: Date.parse('2026-10-17T03:00:00Z') })
  };
}

function userFor(vaiTro, featurePermissions) {
  const user = { username: 'u1', vaiTro, featurePermissions, trangThai: 'Đang hoạt động' };
  return { ...user, permissions: registry.resolvePermissions(user) };
}

function fakeVision(result, { configured = true } = {}) {
  const calls = [];
  return {
    calls,
    configured,
    extractInvoice: async (buffer, mimeType) => {
      calls.push({ size: buffer.length, mimeType });
      if (result instanceof Error) throw result;
      return result;
    }
  };
}

function imageForm(type = 'image/jpeg', bytes = 'fake-image') {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), 'hoa-don.jpg');
  return form;
}

async function request(path, { user = userFor(ROLES.QUAN_LY), method = 'GET', body, form, repository = fakeRepository(), masterData = fakeMaster(), vision = fakeVision({}) } = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use((req, res, next) => {
    req.user = user;
    req.effectiveUserResolved = !!user;
    req.cookies = { [BRANCH_COOKIE_NAME]: 'Cả hai' };
    next();
  });
  app.use('/api/vat-draft', createVatDraftRouter({ repository, masterData, vision }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/vat-draft${path}`, {
      method,
      headers: form ? {} : { 'Content-Type': 'application/json' },
      body: form || (body === undefined ? undefined : JSON.stringify(body))
    });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, type, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  } finally {
    server.close();
  }
}

test('phan quyen: chua dang nhap 401; Ke toan 403; Ke toan duoc cap rieng / Quan ly / admin 200; Khach du cap van 403', async () => {
  assert.equal((await request('/meta', { user: null })).status, 401);
  const accountant = await request('/meta', { user: userFor(ROLES.KE_TOAN) });
  assert.equal(accountant.status, 403);
  assert.equal(accountant.body.code, 'FEATURE_FORBIDDEN');
  assert.equal((await request('/meta', { user: userFor(ROLES.KE_TOAN, { 'accounting.vatDraft': true }) })).status, 200);
  assert.equal((await request('/meta')).status, 200);
  const admin = { username: 'admin', vaiTro: ROLES.KE_TOAN };
  assert.equal((await request('/meta', { user: { ...admin, permissions: registry.resolvePermissions(admin) } })).status, 200);
  assert.equal((await request('/meta', { user: userFor(ROLES.KHACH, { 'accounting.vatDraft': true }) })).status, 403);
});

test('Nhan vien sale (accounting.qr): chi dung duoc Tao QR, /meta chi tra danh sach tai khoan', async () => {
  const sale = userFor(ROLES.NHAN_VIEN_SALE);
  const meta = await request('/meta', { user: sale });
  assert.equal(meta.status, 200);
  assert.deepEqual(Object.keys(meta.body), ['vietqr']);
  assert.equal(meta.body.vietqr.accounts.length, 18);
  const shc = meta.body.vietqr.accounts.find(a => a.key === 'shc');
  assert.deepEqual([shc.bankId, shc.accountNo, shc.accountName, shc.group], ['MB', '525345345', 'CONG TY SHC', 'company']);
  const groups = meta.body.vietqr.accounts.map(a => a.group);
  assert.deepEqual([groups.filter(g => g === 'company').length, groups.filter(g => g === 'personal').length], [5, 13]);
  assert.equal((await request('/qr/url', { method: 'POST', user: sale, body: { accountKey: 'shc', amount: '1000' } })).status, 200);
  assert.equal((await request('/qr/parse-image', { method: 'POST', user: sale, form: imageForm() })).status, 200);
  assert.equal((await request('/documents/resolve', { method: 'POST', user: sale, body: { text: 'HD1' } })).status, 403);
  assert.equal((await request('/allocate', { method: 'POST', user: sale, body: { source: 'paste', text: 'SP01' } })).status, 403);
  assert.equal((await request('/export', { method: 'POST', user: sale, body: { view: 'allocation', columns: ['SL'], rows: [] } })).status, 403);
  assert.equal((await request('/master-data/refresh', { method: 'POST', user: sale })).status, 403);
  // Quan ly tat Tao QR cua mot sale -> 403.
  assert.equal((await request('/qr/url', { method: 'POST', user: userFor(ROLES.NHAN_VIEN_SALE, { 'accounting.qr': false }), body: { accountKey: 'shc' } })).status, 403);
});

test('GET /meta: chi danh sach tai khoan + ngan hang, tra ngay ke ca khi Google Sheets dang treo', async () => {
  const hanging = { get: () => new Promise(() => {}), refresh: () => new Promise(() => {}) };
  const started = Date.now();
  const res = await request('/meta', { masterData: hanging });
  assert.equal(res.status, 200);
  assert.ok(Date.now() - started < 2000, 'khong cho Sheets');
  assert.deepEqual(Object.keys(res.body), ['vietqr']);
  assert.equal(res.body.vietqr.accounts.length, 18);
  assert.deepEqual(res.body.vietqr.banks.find(b => b.code === 'VCB'), { bin: '970436', code: 'VCB', shortName: 'Vietcombank' });
});

test('GET /master-data/status: trang thai Sheets + dong bo; Sheets loi van 200; sale 403', async () => {
  const res = await request('/master-data/status');
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.masterData.stockRows, res.body.masterData.mappingRows, res.body.masterData.error], [3, 2, null]);
  assert.equal(res.body.sync[0].entity, 'invoices');
  assert.equal(res.body.vietqr, undefined);
  const broken = await request('/master-data/status', { masterData: fakeMaster({ fail: true }) });
  assert.equal(broken.status, 200);
  assert.match(broken.body.masterData.error, /chia sẻ công khai/);
  assert.equal((await request('/master-data/status', { user: userFor(ROLES.NHAN_VIEN_SALE) })).status, 403);
});

test('POST /documents/resolve: o Co so tren trang uu tien hon cookie (Ca hai -> hanoi + saigon)', async () => {
  const repository = fakeRepository();
  const res = await request('/documents/resolve?branch=hanoi', { method: 'POST', body: { text: 'hd1, HD2 abc' }, repository });
  assert.deepEqual(repository.calls.resolve.branchCodes, ['hanoi']);
  assert.deepEqual(repository.calls.resolve.codes, ['HD1', 'HD2']);
  assert.deepEqual(res.body.invalid, ['ABC']);
  await request('/documents/resolve?branch=all', { method: 'POST', body: { text: 'HD1' }, repository });
  assert.deepEqual(repository.calls.resolve.branchCodes, ['hanoi', 'saigon']);
  await request('/documents/resolve?branch=xyz', { method: 'POST', body: { text: 'HD1' }, repository });
  assert.deepEqual(repository.calls.resolve.branchCodes, ['hanoi', 'saigon'], 'gia tri la -> theo cookie');
});

test('GET /documents (bang tick chon chung tu) da bo', async () => {
  assert.equal((await request('/documents?from=2026-10-10&to=2026-10-17')).status, 404);
});

function fakeDocumentDetail() {
  const calls = [];
  const load = kind => async args => {
    calls.push({ kind, ...args });
    if (args.code === 'HD404') throw Object.assign(new Error('Không tìm thấy hóa đơn này.'), { statusCode: 404 });
    return { kind, code: args.code, total: 1000, lines: [] };
  };
  return { calls, getInvoiceDetail: load('invoice'), getOrderDetail: load('order') };
}

async function requestDetail(path, { user, documentDetail = fakeDocumentDetail() } = {}) {
  const app = express();
  app.use((req, res, next) => { req.user = user === undefined ? userFor(ROLES.QUAN_LY) : user; req.effectiveUserResolved = !!req.user; req.cookies = {}; next(); });
  app.use('/api/vat-draft', createVatDraftRouter({ repository: fakeRepository(), masterData: fakeMaster(), vision: fakeVision({}), documentDetail }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/vat-draft${path}`);
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

test('GET /documents/detail: hoa don / don dat hang theo co so vat ly; sai tham so 400; khong co 404; chi quyen Nhap VAT', async () => {
  const documentDetail = fakeDocumentDetail();
  const invoice = await requestDetail('/documents/detail?kind=invoice&branch=saigon&code=HD016035', { documentDetail });
  assert.deepEqual([invoice.status, invoice.body.detail.code], [200, 'HD016035']);
  const order = await requestDetail('/documents/detail?kind=order&branch=hanoi&code=DH021036', { documentDetail });
  assert.equal(order.body.detail.kind, 'order');
  assert.deepEqual(documentDetail.calls, [
    { kind: 'invoice', code: 'HD016035', branchCode: 'saigon' },
    { kind: 'order', code: 'DH021036', branchCode: 'hanoi' }
  ]);
  assert.equal((await requestDetail('/documents/detail?kind=return&branch=hanoi&code=HD1')).status, 400);
  assert.equal((await requestDetail('/documents/detail?kind=invoice&branch=Hà Nội&code=HD1')).status, 400);
  const missing = await requestDetail('/documents/detail?kind=invoice&branch=hanoi&code=HD404');
  assert.deepEqual([missing.status, missing.body.error], [404, 'Không tìm thấy hóa đơn này.']);
  // Ke toan duoc cap Nhap VAT xem duoc (khong can quyen Bao cao hoa don); sale (chi Tao QR) bi chan.
  assert.equal((await requestDetail('/documents/detail?kind=invoice&branch=hanoi&code=HD1', { user: userFor(ROLES.KE_TOAN, { 'accounting.vatDraft': true }) })).status, 200);
  assert.equal((await requestDetail('/documents/detail?kind=invoice&branch=hanoi&code=HD1', { user: userFor(ROLES.NHAN_VIEN_SALE) })).status, 403);
  assert.equal((await requestDetail('/documents/detail?kind=invoice&branch=hanoi&code=HD1', { user: null })).status, 401);
});

test('POST /allocate tu chung tu: cot co Ma hoa don + Ghi chu tong canh Ghi chu hang hoa, ly do loi, QR dien san ma', async () => {
  const repository = fakeRepository();
  const res = await request('/allocate', { method: 'POST', repository, body: { source: 'documents', documents: [{ kind: 'invoice', branch: 'hanoi', code: 'hd1' }, { kind: 'order', branch: 'hanoi', code: 'DH2' }] } });
  assert.equal(res.status, 200);
  assert.deepEqual(repository.calls.read.map(s => s.code), ['HD1', 'DH2']);
  const { columns, rows, metrics, qr } = res.body;
  const col = name => columns.indexOf(name);
  assert.equal(col('Ghi chú tổng'), col('Ghi chú hàng hóa') + 1);
  assert.deepEqual(rows.map(r => [r.values[col('Trạng thái')], r.values[col('Mã hóa đơn')], r.values[col('NGUỒN')], r.values[col('SL')], r.values[col('Ghi chú tổng')]]), [
    ['OK', 'HD1', 'TKS THẤP', 150, 'giao sáng'],
    ['OK', 'HD1', 'VC', 50, 'giao sáng'],
    ['Thiếu tồn', 'DH2', 'SHC', 50, ''],
    ['Không có mã', 'DH2', '', 10, '']
  ]);
  assert.equal(rows[0].values[col('Ghi chú hàng hóa')], 'màu xanh');
  assert.equal(rows[3].reason, "Không tìm thấy Mã SP 'KHONGCO'.");
  assert.deepEqual(metrics, { inputCount: 3, okProducts: 1, shortageProducts: 1, missingCount: 1 });
  assert.equal(qr.transferContent, 'HD1 DH2');
  assert.deepEqual(qr.bySource.map(s => [s.nguon, s.defaultAccountKey, s.defaultAmount]), [['TKS THẤP', 'tks_group', 1500000], ['VC', 'mb_vc_ex', 500000]]);
  assert.equal(qr.total.defaultAmount, 2160000);
});

test('POST /allocate dan tay: bo cot cu, khong noi dung CK; loi dau vao 400; sheet loi 503', async () => {
  const res = await request('/allocate', { method: 'POST', body: { source: 'paste', text: 'SP01\tSản phẩm 1\t100\t10800' } });
  assert.equal(res.status, 200);
  assert.ok(!res.body.columns.includes('Ghi chú tổng') && !res.body.columns.includes('Mã hóa đơn'));
  assert.equal(res.body.qr.transferContent, '');
  assert.equal((await request('/allocate', { method: 'POST', body: { source: 'paste', text: '  ' } })).status, 400);
  assert.equal((await request('/allocate', { method: 'POST', body: { source: 'documents', documents: [] } })).status, 400);
  const down = await request('/allocate', { method: 'POST', body: { source: 'paste', text: 'SP01\t\t1' }, masterData: fakeMaster({ fail: true }) });
  assert.equal(down.status, 503);
  assert.equal(down.body.code, 'SHEET_NOT_PUBLIC');
});

test('Tra cuu nguon da go: POST /lookup khong con', async () => {
  assert.equal((await request('/lookup', { method: 'POST', body: { source: 'paste', text: 'SP01' } })).status, 404);
});

test('POST /export tra file xlsx; cot la bi tu choi', async () => {
  const ok = await request('/export', { method: 'POST', body: { view: 'allocation', columns: ['SL', 'MÃ SP', 'TÊN SP'], rows: [[1, '=HYPERLINK("x")', 'A']] } });
  assert.equal(ok.status, 200);
  assert.match(ok.type, /spreadsheetml/);
  assert.equal(ok.body.subarray(0, 2).toString(), 'PK');
  const bad = await request('/export', { method: 'POST', body: { view: 'allocation', columns: ['password'], rows: [] } });
  assert.equal(bad.status, 400);
  assert.equal((await request('/export', { method: 'POST', body: { view: 'lookup', columns: ['SL'], rows: [] } })).status, 400);
});

test('POST /qr/url: tai khoan cau hinh, nhap tay doi ve BIN, noi dung chuan hoa', async () => {
  const res = await request('/qr/url', { method: 'POST', body: { accountKey: 'shc', amount: '1.134.000 đ', addInfo: 'HD1 HD2' } });
  assert.equal(res.body.url, 'https://img.vietqr.io/image/MB-525345345-compact2.svg?amount=1134000&addInfo=HD1%20HD2&accountName=CONG%20TY%20SHC');
  const manual = await request('/qr/url', { method: 'POST', body: { manual: { bankId: 'acb', accountNo: '123456' }, amount: '0' } });
  assert.equal(manual.status, 200);
  assert.equal(manual.body.url, 'https://img.vietqr.io/image/970416-123456-compact2.svg?amount=&addInfo=');
  assert.equal(manual.body.accountLabel, 'ACB - 123456');
  const hsbc = await request('/qr/url', { method: 'POST', body: { manual: { bankId: 'HSBC', accountNo: '001234567' }, amount: '0' } });
  assert.equal(hsbc.status, 200);
  assert.ok(hsbc.body.url.startsWith('https://img.vietqr.io/image/458761-001234567-compact2.svg?'));
  const accented = await request('/qr/url', { method: 'POST', body: { accountKey: 'shc', addInfo: 'Hóa đơn HD1, chị Lan' } });
  assert.equal(accented.body.addInfo, 'Hoa don HD1 chi Lan');
  assert.ok(accented.body.url.includes('addInfo=Hoa%20don%20HD1%20chi%20Lan'));
});

test('POST /qr/url: thieu / sai thong tin -> 400, khong tra URL', async () => {
  const bad = async (body, code) => {
    const res = await request('/qr/url', { method: 'POST', body });
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.code, code);
    assert.equal(res.body.url, undefined);
  };
  await bad({ accountKey: 'khong_co' }, 'VAT_DRAFT_INVALID');
  await bad({}, 'VAT_DRAFT_INVALID');
  await bad({ manual: { bankId: 'VCB/x', accountNo: '1' } }, 'VAT_DRAFT_QR_BANK');
  await bad({ manual: { bankId: 'Ngân hàng lạ', accountNo: '1' } }, 'VAT_DRAFT_QR_BANK');
  await bad({ manual: { bankId: 'VCB', accountNo: '1'.repeat(20) } }, 'VAT_DRAFT_QR_ACCOUNT_NO');
  await bad({ manual: { bankId: 'VCB', accountNo: '' } }, 'VAT_DRAFT_QR_ACCOUNT_NO');
  await bad({ accountKey: 'shc', amount: '12345678901234' }, 'VAT_DRAFT_QR_AMOUNT');
  await bad({ accountKey: 'shc', amount: 1e21 }, 'VAT_DRAFT_QR_AMOUNT'); // JSON number -> "1e+21" khong duoc doc thanh "121"
  await bad({ accountKey: 'shc', amount: -5 }, 'VAT_DRAFT_QR_AMOUNT');
  await bad({ accountKey: 'shc', addInfo: Array.from({ length: 8 }, (_, i) => `HD02834${i}`).join(' ') }, 'VAT_DRAFT_QR_CONTENT');
  const ok = await request('/qr/url', { method: 'POST', body: { accountKey: 'shc', amount: '9999999999999', addInfo: 'x'.repeat(50) } });
  assert.equal(ok.status, 200, 'dung 13 chu so va dung 50 ky tu van duoc');
});

test('POST /allocate: nguon khong co tai khoan cau hinh va che do gop -> khong chon san tai khoan', async () => {
  const strange = {
    get: async () => ({ ...MASTER, stockRows: [MASTER.stockRows[0], MASTER.stockRows[1], stock(4, 'NGUỒN LẠ', 'VAT02', 'KT3', 100)] }),
    refresh: async () => MASTER
  };
  const res = await request('/allocate', { method: 'POST', masterData: strange, body: { source: 'documents', documents: [{ kind: 'invoice', branch: 'hanoi', code: 'HD1' }, { kind: 'order', branch: 'hanoi', code: 'DH2' }] } });
  assert.equal(res.status, 200);
  const byName = Object.fromEntries(res.body.qr.bySource.map(s => [s.nguon, s.defaultAccountKey]));
  assert.deepEqual(byName, { 'TKS THẤP': 'tks_group', VC: 'mb_vc_ex', 'NGUỒN LẠ': null });
  assert.equal(res.body.qr.total.defaultAccountKey, null);
});

test('POST /qr/parse-image: AI doc anh -> so tien + tai khoan cong ty goi y', async () => {
  const vision = fakeVision({ sellerName: 'CÔNG TY CỔ PHẦN THƯƠNG MẠI TỔNG HỢP SHC GROUP', totalPayment: '1.320.002', totalBeforeVat: '1.222.224', vatAmount: '97.778' });
  const res = await request('/qr/parse-image', { method: 'POST', form: imageForm('image/jpeg', 'abc'), vision });
  assert.equal(res.status, 200);
  assert.deepEqual(vision.calls, [{ size: 3, mimeType: 'image/jpeg' }]);
  assert.deepEqual([res.body.totalPayment, res.body.matchedAccountKeys, res.body.warnings, 'serialNo' in res.body], [1320002, ['shc'], [], false]);

  const tks = await request('/qr/parse-image', { method: 'POST', form: imageForm(), vision: fakeVision({ sellerName: 'Công ty CP TM XNK TKS Group', totalPayment: 9732220 }) });
  assert.deepEqual([tks.body.totalPayment, tks.body.matchedAccountKeys], [9732220, ['vcb_tks_group', 'tks_group']]);

  const mismatch = await request('/qr/parse-image', { method: 'POST', form: imageForm(), vision: fakeVision({ sellerName: 'LUCKY HOUSE', totalPayment: '9.732.220', totalBeforeVat: '9.011.315', vatAmount: '700.000' }) });
  assert.equal(mismatch.body.warnings.length, 1);
  assert.deepEqual(mismatch.body.matchedAccountKeys, ['lucky_house']);

  const unreadable = await request('/qr/parse-image', { method: 'POST', form: imageForm(), vision: fakeVision({ sellerName: null, totalPayment: null }) });
  assert.ok(unreadable.body.error);
  assert.deepEqual(unreadable.body.matchedAccountKeys, []);
});

test('POST /qr/parse-image: AI doc nham tong (10.953.056) -> sua theo Cong tien hang + Thue va so bang chu', async () => {
  const vision = fakeVision({
    sellerName: 'CÔNG TY CỔ PHẦN THƯƠNG MẠI XUẤT NHẬP KHẨU TKS GROUP', totalPayment: '10.953.056', totalBeforeVat: '10.123.200', vatAmount: '809.856',
    amountInWords: 'Mười triệu chín trăm ba mươi ba nghìn không trăm năm mươi sáu đồng'
  });
  const res = await request('/qr/parse-image', { method: 'POST', form: imageForm(), vision });
  assert.deepEqual([res.body.totalPayment, res.body.amountStatus, res.body.warnings.length], [10933056, 'corrected', 1]);
  assert.deepEqual(res.body.amountSources, { aiTotal: 10953056, subtotalPlusVat: 10933056, words: 10933056, wordsText: 'Mười triệu chín trăm ba mươi ba nghìn không trăm năm mươi sáu đồng' });
  assert.match(res.body.warnings[0], /10\.953\.056đ.*10\.933\.056đ/);
});

test('POST /qr/parse-text: PDF co lop chu doc thang (khong goi AI), doi chieu so bang chu, sale duoc dung', async () => {
  // Chu trich tu PDF 8 trang (VC EXPRESS): Tong thanh toan nam o trang 7, trang cuoi chi co chan trang.
  const text = 'Ký hiệu   (Serial No) :   1C26TVC\nĐơn vị bán hàng   (Seller) :   CÔNG TY CỔ PHẦN THƯƠNG MẠI VC EXPRESS\n'
    + 'Mã số thuế/Mã đơn vị quan hệ ngân sách (Tax code): 0111302750\n'
    + '...trang 2-6...\nCộng tiền hàng   (Total amount) :   317.008.640\nTiền thuế GTGT   (VAT amount) :   25.360.691\n'
    + 'Tổng cộng tiền thanh toán   (Total payment) :   342.369.331\n'
    + 'Số tiền viết bằng chữ   (In words) :   Ba trăm bốn mươi hai triệu ba trăm sáu mươi chín nghìn ba trăm ba mươi mốt đồng\n'
    + '(Cần kiểm tra đối chiếu khi lập, giao, nhận hóa đơn)';
  const vision = fakeVision({});
  const res = await request('/qr/parse-text', { method: 'POST', user: userFor(ROLES.NHAN_VIEN_SALE), body: { text }, vision });
  assert.equal(res.status, 200);
  assert.equal(vision.calls.length, 0);
  assert.deepEqual([res.body.source, res.body.totalPayment, res.body.amountStatus, res.body.matchedAccountKeys, res.body.error],
    ['pdf-text', 342369331, 'ok', ['mb_vc_ex'], null]);
  assert.equal(res.body.amountSources.words, 342369331);

  const scan = await request('/qr/parse-text', { method: 'POST', body: { text: '' } });
  assert.deepEqual([scan.status, !!scan.body.error, scan.body.matchedAccountKeys], [200, true, []]);
});

test('resolveInvoiceTotal: khop / sua / khong doi chieu duoc', () => {
  const r = (totalPayment, totalBeforeVat, vatAmount, wordsAmount) => resolveInvoiceTotal({ totalPayment, totalBeforeVat, vatAmount, wordsAmount });
  assert.deepEqual(r(1320002, 1222224, 97778, null), { amount: 1320002, status: 'ok', warning: null });
  assert.deepEqual(r(1320002, null, null, 1320002), { amount: 1320002, status: 'ok', warning: null });
  assert.equal(r(11094063, 10272280, 821782, null).status, 'ok'); // le dong lam tron, lech <= 2d
  assert.deepEqual([r(null, 10123200, 809856, 10933056).amount, r(null, 10123200, 809856, 10933056).status], [10933056, 'corrected']);
  const unsure = r(10953056, 10123200, 809856, null); // chi co tong + tong thanh phan, lech nhau
  assert.deepEqual([unsure.amount, unsure.status, !!unsure.warning], [10953056, 'unverified', true]);
  const only = r(532499, null, null, null);
  assert.deepEqual([only.amount, only.status], [532499, 'unverified']);
  assert.deepEqual(r(null, null, null, null), { amount: null, status: 'unverified', warning: null });
});

test('POST /qr/parse-image: sai loai file 400, thieu file 400, chua cau hinh / AI loi 503', async () => {
  const vision = fakeVision({});
  assert.equal((await request('/qr/parse-image', { method: 'POST', form: imageForm('application/pdf'), vision })).status, 400);
  assert.equal((await request('/qr/parse-image', { method: 'POST', form: new FormData(), vision })).status, 400);
  assert.equal(vision.calls.length, 0);
  const off = await request('/qr/parse-image', { method: 'POST', form: imageForm(), vision: fakeVision({}, { configured: false }) });
  assert.deepEqual([off.status, off.body.code], [503, 'INVOICE_AI_NOT_CONFIGURED']);
  const down = Object.assign(new Error('AI lỗi'), { statusCode: 503, code: 'INVOICE_AI_UNAVAILABLE' });
  const failed = await request('/qr/parse-image', { method: 'POST', form: imageForm(), vision: fakeVision(down) });
  assert.deepEqual([failed.status, failed.body.code], [503, 'INVOICE_AI_UNAVAILABLE']);
});
