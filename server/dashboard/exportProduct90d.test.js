'use strict';

// Xuat Excel + HTML cho muc 4 "Hang hoa 90 ngay" (tableKey products.product90d): du lieu that tu PGlite qua dung
// duong exportService -> product90dReportRepository.getProduct90dReportForExport; file xlsx doc lai bang ExcelJS,
// file HTML mo trong JSDOM de kiem bieu do "Xu huong 3 ky" + KPI tinh lai theo tu khoa.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { JSDOM } = require('jsdom');
const { PGlite } = require('@electric-sql/pglite');
const repository = require('./product90dReportRepository');
const exportService = require('./exportService');

const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/0106_product_90d_report.sql'), 'utf8');
const ALLOWED = { canViewProducts: true, canViewSales: true };
const original = repository.getProduct90dReportForExport;

async function setup({ withState = true, filler = 205 } = {}) {
  const db = new PGlite();
  await db.exec(migration);
  if (withState) {
    await db.exec(`INSERT INTO product_90d_report_state (id, as_of_date, window_start, window_end, computed_at, row_count, version)
      VALUES (1, '2026-11-04', '2026-08-06', '2026-11-03', '2026-11-03T19:00:05.123Z', 208, 3)`);
  }
  const put = async (code, name, values = {}) => {
    const cols = ['product_key', 'product_code', 'product_name', ...Object.keys(values)];
    const params = [code.toLowerCase(), code, name, ...Object.values(values).map(v => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v))];
    await db.query(`INSERT INTO product_90d_report (${cols.join(',')}) VALUES (${params.map((_, i) => '$' + (i + 1)).join(',')})`, params);
  };
  await put('SP1', 'Bình giữ nhiệt Lock', {
    qty_61_90d: 10, revenue_61_90d: 1000, invoice_count_61_90d: 2, avg_price_61_90d: 100,
    qty_31_60d: 5, revenue_31_60d: 600, invoice_count_31_60d: 1, avg_price_31_60d: 120,
    qty_1_30d: -2, revenue_1_30d: -200, invoice_count_1_30d: 1, avg_price_1_30d: 100,
    qty_1_90d: 13, revenue_1_90d: 1400, invoice_count_1_90d: 4, avg_price_1_90d: 107.69230769, customer_count_1_90d: 2,
    top_customers_1_90d: [
      { name: 'Khách A|<b>', share: 0.622, revenue: 870.8, quantity: 6 },
      { name: 'Khách Không', share: 0, revenue: 0, quantity: 0 },
      { name: '', share: 0.1, revenue: 140, quantity: -1 }
    ]
  });
  await put('SP2', 'Đặng Mỹ Thọ cốc', {
    qty_61_90d: 0.5, revenue_61_90d: 50.25, invoice_count_61_90d: 1,
    qty_31_60d: 1, revenue_31_60d: 100, invoice_count_31_60d: 1,
    qty_1_30d: 3, revenue_1_30d: 330, invoice_count_1_30d: 2,
    qty_1_90d: 4.5, revenue_1_90d: 480.25, avg_price_1_90d: null, invoice_count_1_90d: 4,
    top_customers_1_90d: [{ name: 'Chỉ trả 0', share: 0, revenue: 0, quantity: 0 }]
  });
  await put('SP3', 'Ấm đun nước', {});
  for (let i = 0; i < filler; i += 1) await put(`ZZ${String(i).padStart(3, '0')}`, `Hàng phụ ${i}`, { qty_1_90d: i });
  repository.getProduct90dReportForExport = args => original({ ...args, pool: db });
  return db;
}

async function teardown(db) {
  repository.getProduct90dReportForExport = original;
  await db.close();
}

const ALL_KEYS = ['product_code', 'product_name', ...repository.PERIODS.flatMap(p =>
  ['qty', 'revenue', 'avg_price', 'customer_count', 'invoice_count', 'top_customers'].map(m => `${m}_${p.key}`))];

function payload(extra = {}) {
  return { tableKey: 'products.product90d', columns: { product_90d: ALL_KEYS }, ...extra };
}

async function dataset(extra) {
  return exportService.getExportDataset(payload(extra), 'Hà Nội', ALLOWED);
}

// ---------- Quyen ----------

test('quyen: can CA reports.products va reports.products.sales (thieu co = chan), khoa khong lo ra danh sach truong', async () => {
  for (const options of [undefined, {}, { canViewSales: true }, { canViewProducts: true }, { canViewProducts: true, canViewSales: false }, { canViewProducts: false, canViewSales: true }]) {
    await assert.rejects(exportService.getExportFields(payload(), 'Hà Nội', options),
      error => error.statusCode === 403 && error.code === 'EXPORT_TABLE_NOT_ALLOWED', JSON.stringify(options));
    await assert.rejects(exportService.createExport(payload({ format: 'html' }), 'Hà Nội', options),
      error => error.statusCode === 403 && error.code === 'EXPORT_TABLE_NOT_ALLOWED', JSON.stringify(options));
  }
  const fields = await exportService.getExportFields(payload(), 'Hà Nội', ALLOWED);
  assert.equal(fields.title, 'Hàng hóa 90 ngày');
  assert.deepEqual(fields.worksheets[0].fields.map(f => f.key), ALL_KEYS, '26 cot dung thu tu man hinh');
  assert.equal(fields.worksheets[0].fields[2].label, 'T.trc nữa – SL');
  assert.equal(fields.worksheets[0].fields[25].label, '90 ngày – Top 3 khách');
  assert.equal(new Set(fields.worksheets[0].fields.map(f => f.label)).size, 26, 'nhan duy nhat');
  await assert.rejects(exportService.getExportFields(payload({ tableSearch: { query: 'x'.repeat(201) } }), 'Hà Nội', ALLOWED), { statusCode: 400 });
});

test('quyen o route that: /api/export/fields + /api/export tra 403 khi thieu reports.products hoac reports.products.sales', async () => {
  const router = require('../routes');
  const layer = routePath => router.stack.find(item => item.route && item.route.path === routePath && item.route.methods.post);
  const fakeRes = () => ({ statusCode: null, body: null, headers: {}, on() {}, setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; }, send(body) { this.body = body; return this; } });
  const errors = console.error;
  console.error = () => {};
  try {
    for (const featurePermissions of [{ 'reports.products.sales': false }, { 'reports.products': false }]) {
      for (const routePath of ['/api/export/fields', '/api/export']) {
        const res = fakeRes();
        await layer(routePath).route.stack.at(-1).handle({ user: { vaiTro: 'Quản lý', featurePermissions }, body: payload(), branch: 'Hà Nội' }, res);
        assert.equal(res.statusCode, 403, `${routePath} ${JSON.stringify(featurePermissions)}`);
        assert.equal(res.body.code, 'EXPORT_TABLE_NOT_ALLOWED');
      }
    }
    const ok = fakeRes();
    await layer('/api/export/fields').route.stack.at(-1).handle({ user: { vaiTro: 'Quản lý' }, body: payload(), branch: 'Hà Nội' }, ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.worksheets[0].fields.length, 26);
  } finally { console.error = errors; }
  // Guard chung /api/export (reports.export) van nam truoc handler.
  assert.ok(router.stack.some(item => !item.route && item.regexp && item.regexp.test('/api/export')));
});

// ---------- Dataset ----------

test('dataset: TOAN BO dong (> 200), nhan co ngay that cua ky, NULL/0/am/le giu nguyen, Top 3 1 dong/khach bo SL 0, ghi chu snapshot', async () => {
  const db = await setup();
  try {
    const data = await dataset();
    const sheet = data.worksheets[0];
    assert.equal(sheet.rows.length, 208, 'khong bi cat 200 dong/trang');
    assert.deepEqual(sheet.columns.map(c => c.key), ALL_KEYS);
    assert.deepEqual(sheet.columns.slice(0, 4).map(c => c.label), ['Mã hàng', 'Tên hàng', 'T.trc nữa (06/08–04/09) – SL', 'T.trc nữa (06/08–04/09) – DS']);
    assert.equal(sheet.columns.find(c => c.key === 'qty_1_30d').label, 'T.này (05/10–03/11) – SL');
    assert.equal(sheet.columns.find(c => c.key === 'top_customers_1_90d').label, '90 ngày (06/08–03/11) – Top 3 khách');
    assert.equal(new Set(sheet.columns.map(c => c.label)).size, 26);
    const [sp1, sp2, sp3] = sheet.rows;
    assert.equal(sp1.product_code, 'SP1');
    assert.equal(sp1.qty_1_30d, -2);
    assert.equal(sp1.avg_price_1_90d, 107.69230769);
    assert.equal(sp2.qty_61_90d, 0.5);
    assert.equal(sp2.avg_price_1_90d, null, 'NULL khong thanh 0');
    assert.equal(sp3.qty_1_90d, 0, '0 giu 0');
    assert.equal(sp1.top_customers_1_90d, 'Khách A|<b>|62.2%|870.8\nKhách lẻ|10%|140');
    assert.equal(sp2.top_customers_1_90d, null, 'chi con khach SL 0 -> o trong');
    assert.equal(sp1.top_customers_61_90d, null);
    assert.equal(data.meta.title, 'Hàng hóa 90 ngày');
    assert.equal(data.meta.branch, 'Cả hai');
    assert.match(data.meta.fileBase, /^TKS_Hang_hoa_90_ngay_/);
    const notes = Object.fromEntries(data.meta.reportNotes);
    assert.equal(notes['Dữ liệu cập nhật lúc'], '02:00 04/11/2026');
    assert.equal(notes['Kỳ T.này'], '05/10/2026 – 03/11/2026');
    assert.equal(notes['Kỳ 90 ngày'], '06/08/2026 – 03/11/2026');
    assert.equal(data.meta.reportNotesTitle, 'Thông tin báo cáo');
    assert.equal(sheet.periodTrend.points.map(p => p.range).join(','), '06/08–04/09,05/09–04/10,05/10–03/11');
    assert.deepEqual(sheet.searchKeys, ['product_code', 'product_name']);
  } finally { await teardown(db); }
});

test('dataset: tim kiem (khong dau) + sap xep theo nhan cot ap tren toan bo dong; khong khop / chua co snapshot -> EXPORT_NO_DATA', async () => {
  const db = await setup();
  try {
    const codes = async extra => (await dataset(extra)).worksheets[0].rows.map(r => r.product_code);
    assert.deepEqual(await codes({ tableSearch: { mode: 'normal', query: 'dang my' } }), ['SP2']);
    assert.deepEqual(await codes({ tableSearch: { query: 'Bình' } }), ['SP1']);
    const desc = await codes({ tableSort: { label: 'T.này – DS', direction: 'desc' } });
    assert.equal(desc.length, 208);
    assert.equal(desc[0], 'SP2');
    assert.equal(desc.at(-1), 'SP1', 'so am cuoi khi giam dan');
    assert.deepEqual(await codes({ tableSort: { label: 'T.này (05/10–03/11) – DS', direction: 'desc' } }), desc, 'nhan co ngay cung duoc');
    const asc = await codes({ tableSort: { label: '90 ngày – SL', direction: 'asc' } });
    assert.deepEqual(asc.slice(0, 3), ['SP3', 'ZZ000', 'ZZ001']);
    assert.deepEqual(await codes({ tableSort: { label: 'T.này – Top 3 khách', direction: 'desc' } }), await codes({}), 'cot khong sap duoc -> thu tu mac dinh');
    await assert.rejects(dataset({ tableSearch: { query: 'khongtontai' } }), e => e.statusCode === 404 && e.code === 'EXPORT_NO_DATA' && /khongtontai/.test(e.message));
  } finally { await teardown(db); }
  const empty = await setup({ withState: false, filler: 0 });
  try {
    await assert.rejects(dataset(), e => e.statusCode === 404 && e.code === 'EXPORT_NO_DATA' && /Chưa nạp/.test(e.message));
    await assert.rejects(exportService.createExport(payload(), 'Hà Nội', ALLOWED), e => e.code === 'EXPORT_NO_DATA');
  } finally { await teardown(empty); }
});

// ---------- Excel ----------

test('xlsx doc lai: 1 sheet du lieu 26 cot, o so la so that (le/am giu nguyen), NULL = o trong, Top 3 xuong dong, sheet ghi chu', async () => {
  const db = await setup();
  try {
    const file = await exportService.createExport(payload({ tableSearch: { query: 'sp' } }), 'Hà Nội', ALLOWED);
    assert.match(file.fileName, /^TKS_Hang_hoa_90_ngay_\d{8}_\d{4}\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    assert.deepEqual(workbook.worksheets.map(w => w.name), ['Hàng hóa 90 ngày', 'Thông tin báo cáo']);
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values.slice(1);
    assert.equal(header.length, 26);
    assert.equal(header[0], 'Mã hàng');
    assert.equal(header[20], '90 ngày (06/08–03/11) – SL');
    const col = key => ALL_KEYS.indexOf(key) + 1;
    const sp1 = sheet.getRow(2), sp2 = sheet.getRow(3), sp3 = sheet.getRow(4);
    assert.equal(sp1.getCell(1).value, 'SP1');
    assert.equal(sp1.getCell(col('qty_1_30d')).value, -2);
    assert.equal(typeof sp1.getCell(col('revenue_1_90d')).value, 'number');
    assert.equal(sp1.getCell(col('avg_price_1_90d')).value, 107.69230769);
    assert.equal(sp1.getCell(col('avg_price_1_90d')).numFmt, '#,##0.00000000;[Red]-#,##0.00000000');
    assert.equal(sp2.getCell(col('qty_61_90d')).value, 0.5);
    assert.equal(sp2.getCell(col('qty_61_90d')).numFmt, '#,##0.0;[Red]-#,##0.0');
    assert.equal(sp2.getCell(col('revenue_1_30d')).numFmt, '#,##0;[Red]-#,##0', 'so nguyen giu dinh dang cot');
    assert.equal(sp2.getCell(col('avg_price_1_90d')).value, null, 'NULL -> o trong');
    assert.equal(sp3.getCell(col('qty_1_90d')).value, 0);
    const top = sp1.getCell(col('top_customers_1_90d'));
    assert.equal(top.value, 'Khách A|<b>|62.2%|870.8\nKhách lẻ|10%|140');
    assert.equal(top.alignment.wrapText, true);
    assert.ok(sp1.height >= 30, 'dong 2 khach du chieu cao 2 dong');
    const notes = workbook.worksheets[1];
    const noteMap = Object.fromEntries(notes.getSheetValues().slice(2).map(row => [row[1], row[2]]));
    assert.equal(noteMap['Dữ liệu cập nhật lúc'], '02:00 04/11/2026');
    assert.equal(noteMap['Từ khóa tìm'], 'sp');
    assert.equal(sheet.rowCount, 4, 'chi 3 ma khop "sp" (ma/ten, khong dau)');
  } finally { await teardown(db); }
});

// ---------- HTML ----------

async function openHtml(extra) {
  const file = await exportService.createExport(payload({ format: 'html', ...extra }), 'Hà Nội', ALLOWED);
  const html = file.buffer.toString('utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'file:///hang-hoa-90-ngay.html',
    beforeParse(win) {
      win.DecompressionStream = DecompressionStream;
      win.Response = Response;
      win.HTMLCanvasElement.prototype.getContext = () => null;
      win.console.error = () => {};
      win.matchMedia = query => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
      win.fetch = () => { throw new Error('Offline report must not fetch'); };
    }
  });
  const doc = dom.window.document;
  for (let i = 0; i < 200 && /Đang mở dữ liệu/.test(doc.getElementById('tbody').textContent); i += 1) await new Promise(r => setTimeout(r, 5));
  return { file, html, win: dom.window, doc };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 220));
const trendRow = (doc, key) => [...doc.querySelectorAll(`#trendTable tr[data-series="${key}"] td`)].map(td => td.textContent);
const kpis = doc => [...doc.querySelectorAll('#kpis .kpi')].map(k => k.querySelector('.kpi-label').textContent + '=' + k.querySelector('.kpi-value').textContent);

async function search(win, doc, text) {
  const input = doc.getElementById('q');
  input.value = text;
  input.dispatchEvent(new win.Event('input'));
  await settle();
}

test('HTML: bieu do "Xu huong 3 ky" + KPI 90 ngay tinh lai theo tu khoa (co dau / khong dau / khong khop / xoa)', async t => {
  const db = await setup();
  try {
    const { win, doc, file } = await openHtml();
    t.after(() => win.close());
    assert.match(file.fileName, /\.html$/);
    assert.match(doc.querySelector('.meta').textContent, /Dữ liệu cập nhật lúc\s*02:00 04\/11\/2026/);
    // Toan bo: tong 3 ky cua SP1 + SP2 (ZZ chi co so 90 ngay).
    assert.equal(doc.querySelector('.trend-card h2').textContent, 'Xu hướng 3 kỳ');
    assert.deepEqual([...doc.querySelectorAll('#trendTable thead th')].map(th => th.innerHTML.replace('<br>', ' ')),
      ['Chỉ số', 'T.trc nữa 06/08–04/09', 'T.trc 05/09–04/10', 'T.này 05/10–03/11']);
    assert.deepEqual(trendRow(doc, 'revenue'), ['1,050.25', '700', '130']);
    assert.deepEqual(trendRow(doc, 'qty'), ['10.5', '6', '1']);
    assert.deepEqual(trendRow(doc, 'avgPrice'), ['100.02380952', '116.66666667', '130']);
    assert.deepEqual(trendRow(doc, 'invoices'), ['3', '2', '3']);
    const allKpis = kpis(doc);
    assert.equal(allKpis[0], 'Số dòng dữ liệu=208');
    assert.equal(allKpis[1], 'Doanh số 90 ngày=1,880.25');
    assert.equal(allKpis[2], `Số lượng 90 ngày=${(17.5 + 204 * 205 / 2).toLocaleString('en-US')}`);
    assert.match(allKpis[3], /^Giá TB 90 ngày=/);

    await search(win, doc, 'Bình');
    assert.deepEqual(trendRow(doc, 'revenue'), ['1,000', '600', '-200'], 'co dau');
    assert.ok(doc.querySelector('#trendTable tr[data-series="revenue"] td:last-child').classList.contains('neg'));
    assert.deepEqual(kpis(doc).slice(0, 3), ['Số dòng dữ liệu=1', 'Doanh số 90 ngày=1,400', 'Số lượng 90 ngày=13']);

    await search(win, doc, 'dang my tho');
    assert.deepEqual(trendRow(doc, 'qty'), ['0.5', '1', '3'], 'khong dau');
    assert.equal(kpis(doc)[3], 'Giá TB 90 ngày=106.72', 'binh quan gia quyen 480.25 / 4.5');

    // Tim chi tren ma + ten (searchKeys): ten khach trong Top 3 khong lam khop dong.
    await search(win, doc, 'Khách A');
    assert.equal(doc.querySelector('.trend-card').dataset.trend, 'empty');
    assert.match(doc.getElementById('trendEmpty').textContent, /Không có dòng nào khớp/);
    assert.deepEqual(kpis(doc), ['Số dòng dữ liệu=0', 'Doanh số 90 ngày=—', 'Số lượng 90 ngày=—', 'Giá TB 90 ngày=—']);
    assert.equal(doc.querySelector('#tbody .no-rows').textContent, 'Không có dòng nào khớp bộ lọc.');

    await search(win, doc, '');
    assert.deepEqual(trendRow(doc, 'revenue'), ['1,050.25', '700', '130'], 'xoa tu khoa -> ve toan bo');
    assert.equal(kpis(doc)[0], 'Số dòng dữ liệu=208');

    // Doi chi so cua bieu do: hang dang chon doi theo, gia tri giu nguyen.
    const select = doc.getElementById('trendMetric');
    assert.deepEqual([...select.options].map(o => o.textContent), ['Doanh số', 'Số lượng', 'Giá TB', 'Lượt mua (cộng theo mã)']);
    select.value = 'qty';
    select.dispatchEvent(new win.Event('change', { bubbles: true }));
    assert.equal(doc.querySelector('#trendTable tr.is-selected').dataset.series, 'qty');
    await search(win, doc, 'sp2');
    assert.equal(doc.getElementById('trendMetric').value, 'qty', 'giu chi so da chon khi loc');
    assert.deepEqual(trendRow(doc, 'qty'), ['0.5', '1', '3']);
    // O Top 3 hien dung chu (escape HTML), cot so le hien du chu so.
    await search(win, doc, 'sp1');
    const cells = [...doc.querySelectorAll('#tbody tr')[0].cells].map(td => td.textContent);
    assert.equal(cells[ALL_KEYS.indexOf('top_customers_1_90d')], 'Khách A|<b>|62.2%|870.8\nKhách lẻ|10%|140');
    assert.equal(cells[ALL_KEYS.indexOf('avg_price_1_90d')], '107.69230769');
    assert.equal(doc.querySelectorAll('#tbody b').length, 0);
    assert.equal(doc.getElementById('category').hidden, true, 'khong co bo loc phan loai');
  } finally { await teardown(db); }
});

test('HTML: bo cot can cho bieu do -> chi so do bi bo, khong ve so sai; khong cot nao -> khong co bieu do xu huong', async t => {
  const db = await setup({ filler: 0 });
  try {
    const noQty = ALL_KEYS.filter(key => !/^qty_/.test(key));
    const { win, doc } = await openHtml({ columns: { product_90d: noQty } });
    t.after(() => win.close());
    assert.deepEqual([...doc.getElementById('trendMetric').options].map(o => o.value), ['revenue', 'invoices']);
    assert.deepEqual(trendRow(doc, 'revenue'), ['1,050.25', '700', '130']);
    const bare = await openHtml({ columns: { product_90d: ['product_code', 'product_name'] } });
    t.after(() => bare.win.close());
    assert.equal(bare.doc.querySelector('.trend-card'), null);
  } finally { await teardown(db); }
});
