'use strict';

// Xuat Excel + HTML cho bang "Khach hang theo san pham" (tableKey products.productCustomerGrowth): du lieu that tu PGlite qua
// dung duong exportService -> productCustomerGrowthRepository.getProductCustomerGrowthForExport.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const ExcelJS = require('exceljs');
const { PGlite } = require('@electric-sql/pglite');
const repository = require('./productCustomerGrowthRepository');
const exportService = require('./exportService');

const migration = name => fs.readFileSync(path.join(__dirname, '../db/migrations', name), 'utf8');
const ALLOWED = { canViewProducts: true, canViewSales: true };
const original = repository.getProductCustomerGrowthForExport;
const KEYS = ['productCode', 'productName', 'customerName', 'revenue', 'revenue1_30d', 'revenue31_60d', 'revenue61_90d', 'share', 'growth', 'status'];

async function setup({ withState = true } = {}) {
  const db = new PGlite();
  await db.exec(migration('0018_product_report.sql'));
  await db.exec(migration('0023_product_report_customers.sql'));
  await db.exec(`CREATE TABLE product_report_state (
    id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1), computed_at TIMESTAMPTZ NOT NULL, version BIGINT NOT NULL DEFAULT 1, last_full_at TIMESTAMPTZ)`);
  await db.exec(migration('0108_product_customer_periods.sql'));
  if (withState) {
    await db.exec(`INSERT INTO product_report_state (id, computed_at, version, customer_window_end)
      VALUES (1, '2026-11-05T19:00:05.123Z', 7, '2026-11-05')`);
  }
  await db.exec(`INSERT INTO product_report (product_code, product_name) VALUES ('SP1', 'Bình giữ nhiệt'), ('SP2', 'Cốc sứ')`);
  const pair = (key, customer, revenue, r1, r2, r3) => db.query(
    `INSERT INTO product_report_customers (product_key, customer_key, customer_name, revenue, revenue_1_30d, revenue_31_60d, revenue_61_90d)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`, [key, 'name:' + customer.toLowerCase(), customer, revenue, r1, r2, r3]);
  await pair('sp1', 'Khách A', 200, 40, 60, 100);   // dung -50% -> Giam duoi 50%
  await pair('sp1', 'Khách B|<b>', 210, 10, 100, 100); // -90% -> Can check (ky tu dac biet phai an toan)
  await pair('sp1', 'Khách mới D', 70, 70, 0, 0);   // Moi
  await pair('sp2', 'Khách H', 15, 5, 5, 5);        // 0% -> Dang tang
  repository.getProductCustomerGrowthForExport = args => original({ ...args, pool: db });
  return db;
}
async function teardown(db) {
  repository.getProductCustomerGrowthForExport = original;
  await db.close();
}

const payload = (extra = {}) => ({ tableKey: 'products.productCustomerGrowth', columns: { product_customer_growth: KEYS }, ...extra });
const dataset = extra => exportService.getExportDataset(payload(extra), 'Hà Nội', ALLOWED);

test('quyen: can CA reports.products va reports.products.sales; khoa khong lo ra danh sach truong', async () => {
  for (const options of [undefined, {}, { canViewSales: true }, { canViewProducts: true }, { canViewProducts: true, canViewSales: false }]) {
    await assert.rejects(exportService.getExportFields(payload(), 'Hà Nội', options),
      error => error.statusCode === 403 && error.code === 'EXPORT_TABLE_NOT_ALLOWED', JSON.stringify(options));
    await assert.rejects(exportService.createExport(payload({ format: 'html' }), 'Hà Nội', options),
      error => error.statusCode === 403 && error.code === 'EXPORT_TABLE_NOT_ALLOWED', JSON.stringify(options));
  }
  const fields = await exportService.getExportFields(payload(), 'Hà Nội', ALLOWED);
  assert.equal(fields.title, 'Khách hàng theo sản phẩm 90 ngày');
  assert.deepEqual(fields.worksheets[0].fields.map(f => f.key), KEYS);
  assert.deepEqual(fields.worksheets[0].fields.map(f => f.label),
    ['Mã hàng', 'Tên hàng', 'Khách hàng', 'DS 90 ngày', 'T.này', 'T.trước', 'T.trước nữa', '% của SP', 'Tăng trưởng', 'Trạng thái']);
  assert.equal(fields.worksheets[0].fields[7].type, 'percent');
  assert.equal(fields.worksheets[0].fields[8].type, 'percent');
});

test('bo loc o ngu canh bi kiem tra truoc khi xin slot: sai -> 400', async () => {
  for (const context of [{ growthGroup: 'xxx' }, { productQuery: 'x'.repeat(201) }, { customerQuery: 5 }, { sortKey: 'constructor' }, { sortDir: 'up', sortKey: 'revenue' }]) {
    await assert.rejects(exportService.getExportFields(payload({ context }), 'Hà Nội', ALLOWED), { statusCode: 400 }, JSON.stringify(context));
  }
});

test('dataset: toan bo dong, nhan ky co ngay that, tang truong/ti trong la phan so, trang thai bang chu, ghi chu snapshot', async () => {
  const db = await setup();
  try {
    const data = await dataset();
    const sheet = data.worksheets[0];
    assert.equal(sheet.rows.length, 4);
    assert.deepEqual(sheet.columns.map(c => c.key), KEYS);
    assert.deepEqual(sheet.columns.slice(3, 7).map(c => c.label),
      ['DS 90 ngày', 'T.này (07/10–05/11)', 'T.trước (07/09–06/10)', 'T.trước nữa (08/08–06/09)']);
    const byCustomer = name => sheet.rows.find(r => r.customerName === name);
    assert.equal(byCustomer('Khách A').growth, -0.5);
    assert.equal(byCustomer('Khách A').status, 'Giảm dưới 50%');
    assert.equal(byCustomer('Khách B|<b>').status, 'Cần check');
    assert.equal(byCustomer('Khách mới D').growth, null);
    assert.equal(byCustomer('Khách mới D').status, 'Mới');
    assert.equal(byCustomer('Khách H').status, 'Đang tăng');
    assert.equal(byCustomer('Khách H').revenue1_30d, 5);
    assert.equal(data.meta.title, 'Khách hàng theo sản phẩm 90 ngày');
    assert.equal(data.meta.branch, 'Cả hai');
    assert.match(data.meta.fileBase, /^TKS_Khach_hang_theo_san_pham_90_ngay_/);
    const notes = Object.fromEntries(data.meta.reportNotes);
    assert.equal(notes['Dữ liệu cập nhật lúc'], '02:00 06/11/2026');
    assert.equal(notes['Kỳ T.này'], '07/10/2026 – 05/11/2026');
    assert.equal(notes['Số dòng trong file'], '4');
    assert.equal(notes['Cần check'], '1');
  } finally { await teardown(db); }
});

test('dataset: ap dung dung bo loc + sap xep cua man hinh; khong khop / chua co du lieu -> EXPORT_NO_DATA', async () => {
  const db = await setup();
  try {
    const names = async extra => (await dataset(extra)).worksheets[0].rows.map(r => r.customerName);
    assert.deepEqual(await names({ context: { growthGroup: 'check' } }), ['Khách B|<b>']);
    assert.deepEqual(await names({ context: { productQuery: 'coc su' } }), ['Khách H']);
    assert.deepEqual(await names({ context: { customerQuery: 'moi' } }), ['Khách mới D']);
    assert.deepEqual((await names({ context: { sortKey: 'growth', sortDir: 'asc' } })).slice(0, 3), ['Khách B|<b>', 'Khách A', 'Khách H']);
    const filtered = await dataset({ context: { growthGroup: 'drop', productQuery: 'binh' } });
    const notes = Object.fromEntries(filtered.meta.reportNotes);
    assert.equal(notes['Lọc tên sản phẩm'], 'binh');
    assert.equal(notes['Nhóm tăng trưởng'], 'Giảm dưới 50%');
    await assert.rejects(dataset({ context: { productQuery: 'khongtontai' } }),
      e => e.statusCode === 404 && e.code === 'EXPORT_NO_DATA' && /khongtontai/.test(e.message));
  } finally { await teardown(db); }
  const empty = await setup({ withState: false });
  try {
    await assert.rejects(dataset(), e => e.statusCode === 404 && e.code === 'EXPORT_NO_DATA' && /Chưa có dữ liệu/.test(e.message));
    await assert.rejects(exportService.createExport(payload(), 'Hà Nội', ALLOWED), e => e.code === 'EXPORT_NO_DATA');
  } finally { await teardown(empty); }
});

test('xlsx doc lai: o so la so that, tang truong dinh dang %, ten khach chua ky tu dac biet khong vo file', async () => {
  const db = await setup();
  try {
    const file = await exportService.createExport(payload({ context: { sortKey: 'revenue', sortDir: 'desc' } }), 'Hà Nội', ALLOWED);
    assert.match(file.fileName, /^TKS_Khach_hang_theo_san_pham_90_ngay_\d{8}_\d{4}\.xlsx$/);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(file.buffer);
    assert.deepEqual(workbook.worksheets.map(w => w.name), ['Khách theo sản phẩm', 'Thông tin báo cáo']);
    const sheet = workbook.worksheets[0];
    const header = sheet.getRow(1).values.slice(1);
    assert.equal(header.length, 10);
    assert.equal(header[4], 'T.này (07/10–05/11)');
    const row = sheet.getRow(2); // Khach B|<b> co DS 210 lon nhat
    assert.equal(row.getCell(3).value, 'Khách B|<b>');
    assert.equal(typeof row.getCell(4).value, 'number');
    assert.equal(row.getCell(9).value, -0.9);
    assert.equal(row.getCell(9).numFmt, '0.00%');
    assert.equal(row.getCell(10).value, 'Cần check');
    // Khach moi: tang truong trong, trang thai "Mới".
    const fresh = [2, 3, 4, 5].map(i => sheet.getRow(i)).find(r => r.getCell(3).value === 'Khách mới D');
    assert.ok(fresh.getCell(9).value === null || fresh.getCell(9).value === '' || fresh.getCell(9).value === undefined);
    assert.equal(fresh.getCell(10).value, 'Mới');
  } finally { await teardown(db); }
});

test('html: tao duoc bao cao, giai ma duoc du lieu nhung va ky tu dac biet di nguyen ven', async () => {
  const db = await setup();
  try {
    const file = await exportService.createExport(payload({ format: 'html' }), 'Hà Nội', ALLOWED);
    assert.match(file.fileName, /\.html$/);
    const text = file.buffer.toString('utf8');
    assert.match(text, /Khách hàng theo sản phẩm 90 ngày/);
    // Du lieu bao cao nhung trong the <script id="report-data"> dang gzip+base64 (xem exportHtmlTableControls.test.js).
    const embedded = /<script[^>]*id="report-data"[^>]*>([^<]+)<\/script>/.exec(text);
    assert.ok(embedded, 'thieu khoi du lieu report-data');
    const report = JSON.parse(zlib.gunzipSync(Buffer.from(embedded[1], 'base64')).toString('utf8'));
    const customers = report.worksheets[0].rows.map(r => r[2]); // hang nhung la mang theo thu tu cot (customerName = cot 3)
    assert.ok(customers.includes('Khách A'));
    assert.ok(customers.includes('Khách B|<b>'), 'ten khach nam nguyen ven trong du lieu nhung');
  } finally { await teardown(db); }
});
