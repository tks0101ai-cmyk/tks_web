'use strict';

process.env.GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
// Test khong bao gio duoc cham DB that (readRowsByCodes/getDashboardData deu bi stub).
process.env.SUPABASE_DB_URL = '';

const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const CONFIG = require('../config');
const dashboardData = require('./dashboardData');
const dashboardPgReader = require('./dashboardPgReader');
const productReportRepository = require('./productReportRepository');
const catalog = require('./exportFieldCatalog');
const exportService = require('./exportService');

// 35 cột Báo cáo hàng hóa theo ĐÚNG thứ tự sheet BC CHUNG (= thứ tự cột bảng trên màn hình): [khóa, nhãn, kiểu].
const PRODUCT_REPORT_SPEC = [
  ['code', 'Mã sản phẩm', 'text'], ['name', 'Tên sản phẩm', 'general'],
  ['loadedQty', 'Đã bốc', 'number'], ['unloadedQty', 'Chưa bốc', 'number'],
  ['availableValueHanoi', 'Giá trị có bán Hà Nội', 'number'], ['qtySold30dHanoi', 'Số lượng bán 30 ngày Hà Nội', 'number'],
  ['stockHanoi', 'Tồn thực Hà Nội', 'number'], ['availableHanoi', 'Có bán Hà Nội', 'number'],
  ['transferRequest', 'Yêu cầu điều chuyển', 'number'],
  ['inTransit', 'Điều chuyển SG', 'number'], ['stockSaigon', 'Tồn thực Sài Gòn', 'number'], ['availableSaigon', 'Có bán Sài Gòn', 'number'],
  ['qtySold30dSaigon', 'Số lượng bán 30 ngày Sài Gòn', 'number'], ['availableValueSaigon', 'Giá trị có bán Sài Gòn', 'number'],
  ['totalStock', 'Tổng tồn thực và điều chuyển', 'number'], ['availableToSell', 'Tổng có bán và điều chuyển', 'number'],
  ['qtySold30d', 'Số lượng bán 30 ngày', 'number'],
  ['stockoutDaysHanoi', 'Số ngày đứt hàng Hà Nội', 'number'], ['stockoutDaysSaigon', 'Số ngày đứt hàng Sài Gòn', 'number'],
  ['daysToOrder', 'Ngày cần đặt', 'number'], ['daysSaigonTransit', 'Ngày bán hết Sài Gòn và điều chuyển', 'number'],
  ['daysHanoi', 'Ngày bán hết Hà Nội', 'number'], ['daysBothBranches', 'Ngày bán hết hai miền', 'number'],
  ['revenue90d', 'Doanh số 90 ngày', 'number'], ['customerCount90d', 'Số lượng khách mua', 'number'],
  ['orders90d', 'Số lượng đơn 90 ngày', 'number'], ['orders30d', 'Số lượng đơn 30 ngày', 'number'], ['ordersGrowth', 'Tăng trưởng', 'percent'],
  ['topCustomerRevenue90d', 'Doanh số khách lớn nhất', 'number'], ['topCustomerName', 'Khách lớn nhất', 'text'],
  ['topCustomerShare', 'Tỉ trọng khách lớn nhất', 'percent'],
  ['priceHanoi', 'Đơn giá Hà Nội', 'number'], ['priceSaigon', 'Đơn giá Sài Gòn', 'number'],
  ['descriptionHanoi', 'Mô tả Hà Nội', 'text'], ['descriptionSaigon', 'Mô tả Sài Gòn', 'text']
];
const PRODUCT_REPORT_KEYS = PRODUCT_REPORT_SPEC.map(item => item[0]);
const PRODUCT_REPORT_SENSITIVE_KEYS = ['availableValueHanoi', 'availableValueSaigon', 'priceHanoi', 'priceSaigon'];

test('product report export has exactly 35 columns in BC CHUNG order with full labels, explicit types and one shared sensitive-key list', async () => {
  assert.equal(PRODUCT_REPORT_SPEC.length, 35);
  assert.deepEqual(Array.from(productReportRepository.PRODUCT_REPORT_PRICE_KEYS).sort(), PRODUCT_REPORT_SENSITIVE_KEYS.slice().sort());
  const fields = (await exportService.getExportFields({ tableKey: 'overview.productReport' }, undefined, { canViewPrice: true })).worksheets[0].fields;
  assert.deepEqual(fields.map(field => field.key), PRODUCT_REPORT_KEYS);
  assert.deepEqual(fields.map(field => field.label), PRODUCT_REPORT_SPEC.map(item => item[1]));
  assert.deepEqual(fields.map(field => field.type), PRODUCT_REPORT_SPEC.map(item => item[2]));
  assert.ok(fields.every(field => field.description && field.description.length > 10), 'moi cot co mo ta');
  // Cột có chữ "ngày" không bị suy ra thành kiểu ngày tháng; Tăng trưởng/Tỉ trọng là phân số.
  fields.filter(field => /ngày/i.test(field.label)).forEach(field => assert.equal(field.type, 'number', field.label));
  // Cột nhạy cảm ghi rõ ai được xuất; ba cột Ngày mới nêu công thức theo từng cơ sở.
  PRODUCT_REPORT_SENSITIVE_KEYS.forEach(key => assert.match(fields.find(field => field.key === key).description, /Chỉ Quản lý và Trợ lý được xuất/, key));
  assert.match(fields.find(field => field.key === 'ordersGrowth').description, /nhân 3/);
  assertStandardLabels([{ key: 'product_report', fields }], 'overview.productReport');
});

test('product report export drops all four sensitive columns without the price flag, in field list, workbook and typed-in keys', async () => {
  const original = productReportRepository.getProductReport;
  productReportRepository.getProductReport = async () => ({
    containerSync: { available: false },
    rows: [{ code: '001', name: 'Một', priceHanoi: 10, priceSaigon: 20, availableValueHanoi: 100, availableValueSaigon: 200, availableHanoi: 10, qtySold30dHanoi: 3 }]
  });
  try {
    const keysOf = metadata => metadata.worksheets[0].fields.map(field => field.key);
    assert.deepEqual(keysOf(await exportService.getExportFields({ tableKey: 'overview.productReport' })), PRODUCT_REPORT_KEYS.filter(key => !PRODUCT_REPORT_SENSITIVE_KEYS.includes(key)));
    assert.deepEqual(keysOf(await exportService.getExportFields({ tableKey: 'overview.productReport' }, undefined, { canViewPrice: false })), PRODUCT_REPORT_KEYS.filter(key => !PRODUCT_REPORT_SENSITIVE_KEYS.includes(key)));
    assert.deepEqual(keysOf(await exportService.getExportFields({ tableKey: 'overview.productReport' }, undefined, { canViewPrice: true })), PRODUCT_REPORT_KEYS);
    for (const key of PRODUCT_REPORT_SENSITIVE_KEYS) {
      await assert.rejects(
        () => exportService.createExportWorkbook({ tableKey: 'overview.productReport', columns: { product_report: ['code', key] } }),
        error => error.code === 'EXPORT_FIELD_NOT_ALLOWED', key
      );
      await assert.rejects(
        () => exportService.createExportHtml({ tableKey: 'overview.productReport', columns: { product_report: ['code', key] } }),
        error => error.code === 'EXPORT_FIELD_NOT_ALLOWED', key
      );
    }
    // Có quyền: cả 4 cột xuất ra đúng giá trị, cột không nhạy cảm xuất bình thường khi không có quyền.
    const allowed = { canViewPrice: true };
    const request = { tableKey: 'overview.productReport', columns: { product_report: ['code', 'availableValueHanoi', 'availableValueSaigon', 'priceHanoi', 'priceSaigon'] } };
    const sheet = (await new ExcelJS.Workbook().xlsx.load((await exportService.createExportWorkbook(request, undefined, allowed)).buffer)).getWorksheet('Báo cáo hàng hóa');
    assert.deepEqual(sheet.getRow(2).values.slice(1), ['001', 100, 200, 10, 20]);
    const plain = (await new ExcelJS.Workbook().xlsx.load((await exportService.createExportWorkbook({ tableKey: 'overview.productReport', columns: { product_report: ['code', 'qtySold30dHanoi'] } })).buffer)).getWorksheet('Báo cáo hàng hóa');
    assert.deepEqual(plain.getRow(2).values.slice(1), ['001', 3]);
  } finally { productReportRepository.getProductReport = original; }
});

test('product report export: Ngay/Dut/Tang truong values keep numeric types, growth is a percent-formatted fraction, blanks stay blank', async () => {
  const original = productReportRepository.getProductReport;
  productReportRepository.getProductReport = async () => ({
    containerSync: { available: false },
    rows: [
      { code: '001', name: 'Một', stockoutDaysHanoi: 4, stockoutDaysSaigon: 0, daysHanoi: 12.5, daysSaigonTransit: 3.2, daysBothBranches: 8, orders90d: 30, orders30d: 18, ordersGrowth: 0.8 },
      { code: '002', name: 'Hai', stockoutDaysHanoi: 0, stockoutDaysSaigon: 0, daysHanoi: null, daysSaigonTransit: null, daysBothBranches: null, orders90d: null, orders30d: null, ordersGrowth: null },
      { code: '003', name: 'Ba', ordersGrowth: -1 }
    ]
  });
  try {
    const keys = ['code', 'stockoutDaysHanoi', 'stockoutDaysSaigon', 'daysHanoi', 'daysSaigonTransit', 'daysBothBranches', 'orders90d', 'orders30d', 'ordersGrowth'];
    const request = { tableKey: 'overview.productReport', columns: { product_report: keys } };
    const sheet = (await new ExcelJS.Workbook().xlsx.load((await exportService.createExportWorkbook(request)).buffer)).getWorksheet('Báo cáo hàng hóa');
    assert.deepEqual(sheet.getRow(1).values.slice(1), [
      'Mã sản phẩm', 'Số ngày đứt hàng Hà Nội', 'Số ngày đứt hàng Sài Gòn', 'Ngày bán hết Hà Nội', 'Ngày bán hết Sài Gòn và điều chuyển',
      'Ngày bán hết hai miền', 'Số lượng đơn 90 ngày', 'Số lượng đơn 30 ngày', 'Tăng trưởng'
    ]);
    assert.deepEqual(sheet.getRow(2).values.slice(1), ['001', 4, 0, 12.5, 3.2, 8, 30, 18, 0.8]);
    assert.equal(typeof sheet.getCell('D2').value, 'number', 'Ngày bán hết là số, không phải ngày tháng');
    assert.deepEqual(sheet.getRow(3).values.slice(1, 3), ['002', 0], 'Đứt = 0 vẫn xuất số 0');
    assert.equal(sheet.getCell('D3').value, null);
    assert.equal(sheet.getCell('I3').value, null);
    assert.equal(sheet.getCell('I4').value, -1);
    assert.equal(sheet.getColumn(9).numFmt, '0.00%', 'Tăng trưởng định dạng phần trăm');
  } finally { productReportRepository.getProductReport = original; }
});

test('product report HTML report keeps the same three KPI metrics and does not add Ngay/Tang truong/Gia tri as additive KPIs', async () => {
  const original = productReportRepository.getProductReport;
  productReportRepository.getProductReport = async () => ({
    containerSync: { available: false },
    rows: [
      { code: '001', name: 'Một', revenue90d: 1000, topCustomerRevenue90d: 400, qtySold30d: 20, qtySold30dHanoi: 12, qtySold30dSaigon: 8, availableValueHanoi: 500, daysHanoi: 9, daysBothBranches: 7, ordersGrowth: 0.5, stockoutDaysHanoi: 2 },
      { code: '002', name: 'Hai', revenue90d: 500, topCustomerRevenue90d: 100, qtySold30d: 5, qtySold30dHanoi: 5, qtySold30dSaigon: 0, availableValueHanoi: 300, daysHanoi: 4, daysBothBranches: 3, ordersGrowth: -0.2, stockoutDaysHanoi: 0 }
    ]
  });
  try {
    const dataset = await exportService.getExportDataset({ tableKey: 'overview.productReport', columns: { product_report: PRODUCT_REPORT_KEYS } }, undefined, { canViewPrice: true });
    const worksheet = dataset.worksheets[0];
    const { createReportKit } = require('./exportHtmlReport').__test__;
    const kit = createReportKit();
    const columns = worksheet.columns.map(column => ({ key: column.key, label: column.label, type: column.type }));
    const rows = worksheet.rows.map(row => columns.map(column => row[column.key]));
    const plan = kit.planFor(columns, rows, worksheet.summaryKeys, worksheet.hints);
    assert.deepEqual(plan.metrics.map(index => columns[index].key), ['revenue90d', 'topCustomerRevenue90d', 'qtySold30d']);
    assert.equal(columns[plan.label].key, 'name');
    // Cột Ngày / Tăng trưởng / Giá trị / Đơn giá không bao giờ là ứng viên chỉ số cộng dồn (cộng lại vô nghĩa hoặc nhạy cảm):
    // chỉ còn Doanh số 90 ngày khi bảng chỉ có các cột này.
    const suspicious = ['daysToOrder', 'daysHanoi', 'daysSaigonTransit', 'daysBothBranches', 'availableValueHanoi', 'availableValueSaigon', 'priceHanoi', 'priceSaigon', 'ordersGrowth', 'topCustomerShare'];
    const subset = columns.filter(column => suspicious.includes(column.key) || column.key === 'revenue90d' || column.key === 'name');
    const subsetRows = rows.map(row => subset.map(column => row[columns.indexOf(columns.find(item => item.key === column.key))]));
    const subsetPlan = kit.planFor(subset, subsetRows);
    assert.deepEqual(subsetPlan.metrics.map(index => subset[index].key), ['revenue90d']);
    // Nhãn mới không bị chọn nhầm làm cột phân loại hay cột nhãn của biểu đồ Top.
    assert.equal(subset[subsetPlan.label].key, 'name');
    assert.ok(plan.category < 0 || !suspicious.includes(columns[plan.category].key));
  } finally { productReportRepository.getProductReport = original; }
});

test('product report export includes numeric container quantities before stock and preserve unavailable blanks', async () => {
  const original = productReportRepository.getProductReport;
  productReportRepository.getProductReport = async () => ({
    computedAt: '2026-10-14T17:05:00.000Z',
    containerSync: { available: true, version: 'v1', lastSuccessAt: '2026-10-15T01:00:00.000Z', stale: true, lastError: 'read failed' },
    rows: [
      { code: '001', name: 'Một', unloadedQty: 150.5, loadedQty: 30.25, stockHanoi: 7, stockSaigon: 8 },
      { code: '002', name: 'Hai', unloadedQty: null, loadedQty: null },
      { code: '003', name: 'Ba', unloadedQty: 0, loadedQty: 0 }
    ]
  });
  try {
    const request = { tableKey: 'overview.productReport' };
    const fields = (await exportService.getExportFields(request)).worksheets[0].fields;
    // Không có cờ quyền giá: 31 trong 35 cột (bỏ 4 cột nhạy cảm), vẫn đúng thứ tự sheet BC CHUNG.
    assert.deepEqual(fields.map(field => field.key), PRODUCT_REPORT_KEYS.filter(key => !PRODUCT_REPORT_SENSITIVE_KEYS.includes(key)));
    assert.ok(['unloadedQty', 'loadedQty'].every(key => fields.find(field => field.key === key).selected && fields.find(field => field.key === key).type === 'number'));
    const byKey = key => fields.find(field => field.key === key);
    // Nhãn có chữ "ngày" sẽ bị suy ra thành kiểu ngày tháng nếu không khai báo tường minh.
    assert.equal(byKey('daysToOrder').type, 'number');
    assert.equal(byKey('daysToOrder').label, 'Ngày cần đặt');
    assert.ok(['descriptionHanoi', 'descriptionSaigon'].every(key => byKey(key).type === 'text'));
    request.columns = { product_report: ['code', 'unloadedQty', 'loadedQty', 'stockHanoi'] };
    const file = await exportService.createExportWorkbook(request);
    const workbook = await new ExcelJS.Workbook().xlsx.load(file.buffer);
    const sheet = workbook.getWorksheet('Báo cáo hàng hóa');
    assert.deepEqual(sheet.getRow(1).values.slice(1), ['Mã sản phẩm', 'Chưa bốc', 'Đã bốc', 'Tồn thực Hà Nội']);
    assert.equal(sheet.getCell('A2').value, '001');
    assert.equal(sheet.getCell('B2').value, 150.5);
    assert.equal(sheet.getCell('C2').value, 30.25);
    assert.equal(sheet.getCell('B3').value, null);
    assert.equal(sheet.getCell('C3').value, null);
    assert.equal(sheet.getCell('B4').value, 0);
    const notes = workbook.getWorksheet('Thông tin hàng dự kiến');
    assert.ok(notes);
    assert.match(notes.getColumn(2).values.join(' '), /15\/10\/2026.*08:00:00/);
    assert.match(notes.getColumn(2).values.join(' '), /cũ/);
    const htmlFile = await exportService.createExportHtml(request);
    const document = new JSDOM(htmlFile.buffer.toString('utf8')).window.document;
    assert.match(document.querySelector('header .meta').textContent, /15\/10\/2026.*08:00:00/);
    assert.match(document.querySelector('header .meta').textContent, /cũ/);
    const dataset = await exportService.getExportDataset(request);
    assert.equal(dataset.worksheets[0].rows[1].unloadedQty, null);
  } finally { productReportRepository.getProductReport = original; }
});

test('product report export includes Don gia HN/SG only for accounts allowed to see prices', async () => {
  const original = productReportRepository.getProductReport;
  productReportRepository.getProductReport = async () => ({
    containerSync: { available: false },
    rows: [
      { code: '001', name: 'Một', priceHanoi: 125000, priceSaigon: 130000 },
      { code: '002', name: 'Hai', priceHanoi: 0, priceSaigon: null }
    ]
  });
  try {
    const keysOf = metadata => metadata.worksheets[0].fields.map(field => field.key);
    // Không cờ quyền = không thấy cột giá, và tự gõ khóa cột giá bị từ chối.
    const withoutPrice = await exportService.getExportFields({ tableKey: 'overview.productReport' });
    assert.ok(!keysOf(withoutPrice).some(key => key.startsWith('price')));
    await assert.rejects(
      () => exportService.createExportWorkbook({ tableKey: 'overview.productReport', columns: { product_report: ['code', 'priceHanoi'] } }),
      error => error.code === 'EXPORT_FIELD_NOT_ALLOWED'
    );

    const allowed = { canViewPrice: true };
    const fields = (await exportService.getExportFields({ tableKey: 'overview.productReport' }, undefined, allowed)).worksheets[0].fields;
    assert.deepEqual(fields.map(field => field.key), PRODUCT_REPORT_KEYS);
    // Đơn giá nằm SAU Tỉ trọng khách lớn nhất (cột 32-33), không còn đứng ngay sau Tên sản phẩm.
    assert.deepEqual(fields.slice(31, 33).map(field => field.key), ['priceHanoi', 'priceSaigon']);
    assert.ok(PRODUCT_REPORT_SENSITIVE_KEYS.every(key => fields.find(field => field.key === key).type === 'number'));

    const request = { tableKey: 'overview.productReport', columns: { product_report: ['code', 'priceHanoi', 'priceSaigon'] } };
    const file = await exportService.createExportWorkbook(request, undefined, allowed);
    const sheet = (await new ExcelJS.Workbook().xlsx.load(file.buffer)).getWorksheet('Báo cáo hàng hóa');
    assert.deepEqual(sheet.getRow(1).values.slice(1), ['Mã sản phẩm', 'Đơn giá Hà Nội', 'Đơn giá Sài Gòn']);
    assert.equal(sheet.getCell('B2').value, 125000);
    assert.equal(sheet.getCell('C2').value, 130000);
    assert.equal(sheet.getCell('B3').value, 0);
    assert.equal(sheet.getCell('C3').value, null);

    const htmlFile = await exportService.createExportHtml(request, undefined, allowed);
    assert.ok(htmlFile.buffer.length > 0);
    // Báo cáo HTML dựng từ cùng dataset (dữ liệu bảng được nén trong file) nên kiểm cột/dòng ở tầng dataset.
    const dataset = await exportService.getExportDataset(request, undefined, allowed);
    assert.deepEqual(dataset.worksheets[0].columns.map(column => column.label), ['Mã sản phẩm', 'Đơn giá Hà Nội', 'Đơn giá Sài Gòn']);
    assert.deepEqual(dataset.worksheets[0].rows.map(row => [row.priceHanoi, row.priceSaigon]), [[125000, 130000], [0, null]]);
  } finally { productReportRepository.getProductReport = original; }
});

test('product report export notes distinguish missing container snapshots from zero quantities', async () => {
  const original = productReportRepository.getProductReport;
  productReportRepository.getProductReport = async () => ({ rows: [{ code: '001', unloadedQty: null, loadedQty: null }], containerSync: { available: false } });
  try {
    const request = { tableKey: 'overview.productReport', columns: { product_report: ['code', 'unloadedQty', 'loadedQty'] } };
    const htmlFile = await exportService.createExportHtml(request);
    const document = new JSDOM(htmlFile.buffer.toString('utf8')).window.document;
    assert.match(document.querySelector('header .meta').textContent, /chưa sẵn sàng/i);
    const file = await exportService.createExportWorkbook(request);
    const workbook = await new ExcelJS.Workbook().xlsx.load(file.buffer);
    assert.equal(workbook.getWorksheet('Báo cáo hàng hóa').getCell('B2').value, null);
    assert.match(workbook.getWorksheet('Thông tin hàng dự kiến').getColumn(2).values.join(' '), /chưa sẵn sàng/i);
  } finally { productReportRepository.getProductReport = original; }
});

test('product report export carries per-branch stock, descriptions and the days-to-order number; blanks stay blank', async () => {
  const original = productReportRepository.getProductReport;
  productReportRepository.getProductReport = async () => ({
    containerSync: { available: true, version: 'v1', lastSuccessAt: '2026-10-15T01:00:00.000Z' },
    rows: [
      {
        code: '001', name: 'Một', stockHanoi: 799, availableHanoi: -20, inTransit: 5, stockSaigon: 200, availableSaigon: 10,
        descriptionHanoi: 'T50 # 30/9 # 1T -37200 | VAT+3200đ', descriptionSaigon: '', totalStock: 1004, availableToSell: 650,
        qtySold30d: 3500, daysToOrder: 32.6
      },
      { code: '002', name: 'Hai', availableHanoi: null, availableSaigon: null, daysToOrder: null }
    ]
  });
  try {
    const keys = ['code', 'availableHanoi', 'availableSaigon', 'descriptionHanoi', 'descriptionSaigon', 'totalStock', 'daysToOrder'];
    const request = { tableKey: 'overview.productReport', columns: { product_report: keys } };
    const file = await exportService.createExportWorkbook(request);
    const sheet = (await new ExcelJS.Workbook().xlsx.load(file.buffer)).getWorksheet('Báo cáo hàng hóa');
    assert.deepEqual(sheet.getRow(1).values.slice(1), [
      'Mã sản phẩm', 'Có bán Hà Nội', 'Có bán Sài Gòn', 'Mô tả Hà Nội', 'Mô tả Sài Gòn', 'Tổng tồn thực và điều chuyển', 'Ngày cần đặt'
    ]);
    assert.equal(sheet.getCell('B2').value, -20, 'có bán âm giữ nguyên dấu');
    assert.equal(sheet.getCell('C2').value, 10);
    assert.equal(sheet.getCell('D2').value, 'T50 # 30/9 # 1T -37200 | VAT+3200đ');
    assert.equal(sheet.getCell('F2').value, 1004);
    assert.equal(sheet.getCell('G2').value, 32.6, 'Ngày cần đặt là số, không phải ngày tháng');
    assert.equal(typeof sheet.getCell('G2').value, 'number');
    assert.equal(sheet.getCell('B3').value, null, 'chưa tính lại => ô trống, không giả thành 0');
    assert.equal(sheet.getCell('G3').value, null);
    // Mô tả dài (bảng giá) phải xuống dòng trong ô Excel thay vì kéo tràn.
    const columns = (await exportService.getExportDataset(request)).worksheets[0].columns;
    assert.deepEqual(['descriptionHanoi', 'descriptionSaigon'].map(key => columns.find(item => item.key === key).wrapText), [true, true]);
  } finally { productReportRepository.getProductReport = original; }
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

// ---------- Du lieu gia lap ----------

// Dong nguon theo ALIAS cua catalogue (gia tri rong = null nhu Postgres tra ve).
function sourceRow(sourceKey, values) {
  const row = {};
  catalog.getSourceFields(sourceKey).forEach(item => { row[item.key] = null; });
  return Object.assign(row, values);
}

function buildRowsBySheet() {
  return {
    [CONFIG.SHEET_PRODUCTS]: [
      sourceRow('products', { ma_hang: '00123', ten_hang: '=Tên có công thức', gia_ban: 150000, ngay_tao: '14/08/2026 08:00' })
    ],
    [CONFIG.SHEET_INVOICES]: [
      sourceRow('invoices', { ma_hoa_don: 'HD-01', ngay_ban: '14/08/2026 09:00', khach_hang: 'Khách A', tong_tien_hang: 300000 })
    ],
    [CONFIG.SHEET_ORDERS]: [
      sourceRow('orders', { ma_dat_hang: 'DH-01', ngay_dat: '14/08/2026 09:10', khach_hang: 'Khách A', tong_tien: 250000 })
    ],
    [CONFIG.SHEET_RETURNS]: [
      sourceRow('returns', { ma_tra_hang: 'TH-01', ngay_tra: '14/08/2026 10:00', khach_hang: 'Khách A', tong_tien_tra: 50000 })
    ],
    [CONFIG.SHEET_CUSTOMERS]: [
      sourceRow('customers', { ma_khach_hang: 'KH-01', ten_khach_hang: 'Khách A', dien_thoai: '0900123456', no_hien_tai: 100000 })
    ]
  };
}

function buildDashboard() {
  return {
    products: {
      newProducts: { products: [{ code: '00123' }] },
      topSellingProducts: [{ code: '00123', qty: 2, revenue: 300000 }],
      topSellingParentCategories: [{ name: 'Áo', qty: 2, revenue: 300000, productCount: 1 }],
      newlyImported: { products: [{ code: '00123', firstImportDate: '14/08/2026', daysOnHand: 1, revenue: 300000 }] }
    },
    invoices: {
      transactionsReport: { transactions: [{ code: 'HD-01', quantity: 2, quantityKnown: true }] }
    },
    debtManagement: {
      available: true,
      sourceSheet: 'Công nợ HN',
      customers: [
        {
          customerKey: 'khach-a', customerName: 'Khách A', sale: 'Lan', paymentSchedule: '1',
          inScheduleDebt: 300000, currentDebt: 800000, overdueDebt: 500000,
          currentDebtToSalesRatio: 0.4, overdueToSalesRatio: 0.25,
          alertCodes: ['uncollected', 'overdue'], dataIssues: [],
          workflowStatus: 'Chưa xử lý', needsAction: true,
          updatedBy: '=Người cập nhật', updatedAt: '14/08/2026 10:00:00'
        },
        {
          customerKey: 'khach-b', customerName: 'Khách B', sale: 'Minh', paymentSchedule: '7',
          inScheduleDebt: null, currentDebt: 1200000, overdueDebt: 0,
          currentDebtToSalesRatio: null, overdueToSalesRatio: null,
          alertCodes: [], dataIssues: ['duplicate_customer_name'],
          workflowStatus: 'Đã xử lý', needsAction: false,
          updatedBy: 'Quản lý', updatedAt: '15/08/2026 08:30:00'
        }
      ]
    }
  };
}

/**
 * Thay getDashboardData + readRowsByCodes bang stub (du lieu dashboard bi deep-freeze
 * de lo moi hanh vi sua cache dung chung). Tra ve { calls, dashboard, restore }.
 */
function installStubs(options = {}) {
  const calls = { dashboard: [], rows: [], rowOptions: [] };
  const dashboard = deepFreeze(options.dashboard || buildDashboard());
  const rowsBySheet = options.rowsBySheet || buildRowsBySheet();
  const originals = {
    getDashboardData: dashboardData.getDashboardData,
    readRowsByCodes: dashboardPgReader.readRowsByCodes
  };
  dashboardData.getDashboardData = async (...args) => {
    calls.dashboard.push(args);
    if (options.onDashboard) await options.onDashboard(...args);
    return dashboard;
  };
  dashboardPgReader.readRowsByCodes = async (sheetName, branch, codes, readOptions) => {
    calls.rows.push({ sheetName, branch, codes: Array.from(codes) });
    calls.rowOptions.push(readOptions);
    if (options.onRows) await options.onRows(sheetName, branch, codes);
    const source = catalog.getSourceBySheetName(sheetName);
    const wanted = new Set(codes);
    return {
      columns: source.fields.map(item => item.key),
      rows: (rowsBySheet[sheetName] || []).filter(row => wanted.has(row[source.codeKey])).map(row => ({ ...row }))
    };
  };
  return {
    calls,
    dashboard,
    restore() {
      dashboardData.getDashboardData = originals.getDashboardData;
      dashboardPgReader.readRowsByCodes = originals.readRowsByCodes;
    }
  };
}

async function withStubs(options, fn) {
  const stubs = installStubs(options);
  try {
    return await fn(stubs);
  } finally {
    stubs.restore();
  }
}

const FIXED_TABLES = [
  'overview.transactions',
  'debt.management'
];

const FIXED_CONTEXT = { productAnalysis: 'product', debtQueue: 'all' };
const PRODUCT_COLUMNS = ['ma_hoa_don', 'khach_hang', 'tong_tien_hang'];

const STOCKOUT_ROWS = [{
  code: 'SP001', name: 'Ao thun', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6,
  stockoutCount: 1, totalStockoutDays: 6, currentOnHand: 3, hasUnreliableData: false,
  periods: [{ fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 }]
}];

// Payload hop le cho MOI tableKey de kiem tra buoc lay truong.
function payloadFor(tableKey, extra = {}) {
  const payload = { tableKey, filters: {}, context: { ...FIXED_CONTEXT }, ...extra };
  if (tableKey === 'customers.productDetail') {
    payload.context = { customerProductCustomerCode: 'KH-01', customerProductCustomerName: 'Khách A' };
  }
  if (tableKey === 'stockout.recentScan') payload.recentStockoutResult = { branch: 'Hà Nội', rows: STOCKOUT_ROWS };
  if (tableKey === 'stockout.check90d') payload.stockout90dResult = { branch: 'Hà Nội', rows: STOCKOUT_ROWS };
  if (tableKey === 'stockout.check30d') payload.stockout30dResult = { branch: 'Hà Nội', rows: STOCKOUT_ROWS };
  return payload;
}

const ALL_STATIC_TABLES = exportService.__test__.TABLE_SPEC_KEYS;
// Hàng hóa 90 ngày đòi cờ quyền tường minh (reports.products + reports.products.sales) — xem test riêng ở exportProduct90d.test.js.
const accessFor = tableKey => (tableKey === 'products.product90d' ? { canViewProducts: true, canViewSales: true } : undefined);

function fixedEnv(stubs, branch = 'Hà Nội') {
  return { dashboard: stubs.dashboard, branch };
}

async function loadWorkbook(file) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  return workbook;
}

// ---------- Bang co dinh: dataset, loc, purchases, cong no ----------

test('registry dung du cac bang co dinh va tao duoc dataset voi cot lay tu catalogue', async () => {
  await withStubs({}, async stubs => {
    assert.deepEqual(ALL_STATIC_TABLES.filter(key => FIXED_TABLES.includes(key)).sort(), FIXED_TABLES.slice().sort());
    for (const tableKey of FIXED_TABLES) {
      const dataset = await exportService.__test__.buildFixedDataset(tableKey, fixedEnv(stubs), FIXED_CONTEXT);
      assert.equal(dataset.tableKey, tableKey);
      assert.ok(dataset.worksheets.length >= 1, `${tableKey} phai co worksheet`);
      dataset.worksheets.forEach(worksheet => assert.ok(worksheet.columns.length >= 1));
    }
  });
});

test('cot tho cua bang co dinh lay theo catalogue: khoa la alias, nhan/kieu/mo ta tu catalogue', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('overview.transactions', fixedEnv(stubs), {});
    const columns = dataset.worksheets[0].columns;
    const catalogFields = catalog.getSourceFields('invoices');
    assert.deepEqual(columns.slice(0, catalogFields.length).map(column => column.key), catalogFields.map(item => item.key));
    columns.slice(0, catalogFields.length).forEach((column, index) => {
      assert.equal(column.label, catalogFields[index].label);
      assert.equal(column.type, catalogFields[index].type);
      assert.equal(column.description, catalogFields[index].description);
    });
    assert.equal(columns[columns.length - 1].label, 'Số lượng');
    assert.equal(dataset.worksheets[0].codeKey, 'ma_hoa_don');
    const row = dataset.worksheets[0].rows[0];
    assert.equal(row.ma_hoa_don, 'HD-01');
    assert.equal(row.tong_tien_hang, 300000);
    assert.equal(row.d_quantity, 2);
  });
});

test('buildFixedDataset loc tim thuong va nhieu ma truoc khi tao worksheet', async () => {
  await withStubs({}, async stubs => {
    const noMatch = await exportService.__test__.buildFixedDataset(
      'overview.transactions', fixedEnv(stubs), {}, { mode: 'normal', query: 'không tồn tại' }
    );
    assert.equal(noMatch.worksheets[0].rows.length, 0);

    const codes = await exportService.__test__.buildFixedDataset(
      'overview.transactions', fixedEnv(stubs), {}, { mode: 'codes', query: 'HD-01 HD-404' }
    );
    const codeColumn = codes.worksheets[0].columns.find(column => column.label === 'Mã hóa đơn');
    assert.ok(codeColumn);
    assert.deepEqual(codes.worksheets[0].rows.map(row => row[codeColumn.key]), ['HD-01']);

    const blank = await exportService.__test__.buildFixedDataset('overview.transactions', fixedEnv(stubs), {}, { mode: 'normal', query: '' });
    assert.equal(blank.worksheets[0].rows.length, 1);
  });
});

test('tim kiem thuong quet ca cot khong nam trong danh sach cot da chon roi moi cat con cot da chon', async () => {
  await withStubs({}, async stubs => {
    // "Khách A" chi xuat hien o cot khach_hang; chi chon 1 cot ma_hoa_don van phai tim thay.
    const dataset = await exportService.__test__.buildFixedDataset(
      'overview.transactions', fixedEnv(stubs), {}, { mode: 'normal', query: 'khach a' }, { transactions: ['ma_hoa_don'] }
    );
    assert.deepEqual(dataset.worksheets[0].rows, [{ ma_hoa_don: 'HD-01' }]);
  });
});

test('Quản lý công nợ xuất đúng một worksheet, lọc và sort trên toàn bộ tập khách', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('debt.management', fixedEnv(stubs), {
      debtQueue: 'all',
      debtSale: '',
      debtSchedule: '',
      debtSearch: '',
      debtSort: { columnIndex: 5, direction: 'desc' }
    });
    assert.equal(dataset.worksheets.length, 1);
    assert.equal(dataset.worksheets[0].name, 'Công nợ HN');
    assert.deepEqual(dataset.worksheets[0].rows.map(row => row.customerName), ['Khách B', 'Khách A']);
    assert.equal(dataset.worksheets[0].columns.length, 19, '17 cot man hinh (gom Cơ sở, So phien, 2 cot Tien phat, 2 cot phan hoi) + 2 cot cap nhat tuy chon');
    assert.equal(dataset.worksheets[0].columns.filter(column => column.selected !== false).length, 17);

    const matched = await exportService.__test__.buildFixedDataset('debt.management', fixedEnv(stubs), {
      debtQueue: 'overdue', debtSale: 'Lan', debtSchedule: '1', debtSearch: 'khách a'
    });
    assert.deepEqual(matched.worksheets[0].rows.map(row => row.customerName), ['Khách A']);

    const empty = await exportService.__test__.buildFixedDataset('debt.management', fixedEnv(stubs), {
      debtQueue: 'needsAction', debtSearch: 'không có'
    });
    assert.equal(empty.worksheets[0].rows.length, 0);
  });
});

test('Quản lý công nợ phản ánh đủ bốn bộ lọc hàng chờ', async () => {
  await withStubs({}, async stubs => {
    const names = async queue => (await exportService.__test__.buildFixedDataset('debt.management', fixedEnv(stubs), { debtQueue: queue }))
      .worksheets[0].rows.map(row => row.customerName);
    assert.deepEqual(await names('needsAction'), ['Khách A']);
    assert.deepEqual(await names('currentDebt'), ['Khách A', 'Khách B']);
    assert.deepEqual(await names('overdue'), ['Khách A']);
    assert.deepEqual(await names('all'), ['Khách A', 'Khách B']);
  });
});

test('Quản lý công nợ mặc định chọn 17 cột hiển thị (kèm Cơ sở, Số phiên, 2 cột Tiền phạt, 2 cột phản hồi) và để 2 cột cập nhật là tùy chọn', async () => {
  const metadata = await exportService.getExportFields({ tableKey: 'debt.management', context: { debtQueue: 'all' } }, 'Hà Nội');
  const fields = metadata.worksheets[0].fields;
  assert.equal(fields.length, 19);
  assert.equal(fields[1].label, 'Cơ sở');
  assert.equal(fields.filter(field => field.selected).length, 17);
  assert.equal(fields.find(field => field.key === 'overdueStreak').selected, true);
  assert.equal(fields.find(field => field.key === 'updatedBy').selected, false);
  assert.equal(fields.find(field => field.key === 'updatedAt').selected, false);
});

// ---------- Buoc lay truong: tinh, khong I/O ----------

test('buoc lay truong KHONG goi getDashboardData/readRowsByCodes voi moi bang co dinh (dem = 0), rowCount = null', async () => {
  const originals = {
    report: dashboardData.getCustomerProductRevenueReport
  };
  const forbidden = () => { throw new Error('khong duoc goi khi lay danh sach truong'); };
  dashboardData.getCustomerProductRevenueReport = forbidden;
  try {
    await withStubs({}, async stubs => {
      for (const tableKey of ALL_STATIC_TABLES) {
        const metadata = await exportService.getExportFields(payloadFor(tableKey), 'Hà Nội', accessFor(tableKey));
        assert.equal(metadata.tableKey, tableKey);
        assert.equal(metadata.selectionMode, 'custom');
        assert.ok(metadata.worksheets.length >= 1, tableKey);
        metadata.worksheets.forEach(worksheet => {
          assert.equal(worksheet.rowCount, null, `${tableKey}/${worksheet.key}`);
          assert.ok(worksheet.fields.length >= 1);
          worksheet.fields.forEach(field => {
            assert.ok(typeof field.description === 'string' && field.description.length > 0, `${tableKey}.${field.key} thieu chu thich`);
          });
        });
      }
      assert.equal(stubs.calls.dashboard.length, 0);
      assert.equal(stubs.calls.rows.length, 0);
    });
  } finally {
    dashboardData.getCustomerProductRevenueReport = originals.report;
  }
});

test('buoc lay truong van validate re: bang khong hop le, thieu khach/tu khoa, thieu ket qua stockout', async () => {
  await assert.rejects(exportService.getExportFields({ tableKey: 'khong.co' }), error => error.code === 'EXPORT_TABLE_NOT_ALLOWED' && error.statusCode === 400);
  await assert.rejects(
    exportService.getExportFields({ tableKey: 'customers.productDetail', context: {} }),
    error => error.statusCode === 400 && error.code === 'EXPORT_NO_CUSTOMER_SELECTED'
  );
  await assert.rejects(
    exportService.getExportFields({ tableKey: 'stockout.recentScan', recentStockoutResult: { rows: [] } }),
    error => error.statusCode === 400 && error.code === 'EXPORT_NO_DATA'
  );
  await assert.rejects(
    exportService.getExportFields({ tableKey: 'stockout.check90d' }),
    error => error.code === 'EXPORT_NO_DATA'
  );
  await assert.rejects(
    exportService.getExportFields({
      tableKey: 'stockout.check90d', tableSearch: { mode: 'normal', query: 'khong co' }, stockout90dResult: { rows: STOCKOUT_ROWS }
    }),
    error => error.statusCode === 404 && error.code === 'EXPORT_NO_DATA'
  );
});

test('cot o buoc lay truong == cot cua dataset o buoc xuat cho moi bang co dinh', async () => {
  const debtScheduleService = require('../debtSchedule/debtScheduleService');
  const originals = {
    report: dashboardData.getCustomerProductRevenueReport,
    productReport: productReportRepository.getProductReport,
    debtAging: debtScheduleService.buildDebtAging
  };
  debtScheduleService.buildDebtAging = async () => ({ available: true, customers: [
    { branch: 'HN', customerName: 'Khách A', sale: 'Sale A', paymentSchedule: '1', currentDebt: 1, overdueDebt: 0,
      payoffDay: '2026-10-17', beyondHistory: false, equivalentDays: 0, remainingDays: 1 }
  ] });
  dashboardData.getCustomerProductRevenueReport = async () => ({
    products: [{ code: 'SP-01', name: 'Sản phẩm một', quantity: 3, revenue: 300, month1Revenue: 1, month2Revenue: 2, month3Revenue: 3 }]
  });
  productReportRepository.getProductReport = async () => ({
    rows: [{
      code: 'SP-01', name: 'Sản phẩm một', stockHanoi: 1, stockSaigon: 2, availableToSell: 3, qtySold30d: 4,
      revenue90d: 5, customerCount90d: 6, topCustomerRevenue90d: 7, topCustomerName: 'Khách A', topCustomerShare: 0.5
    }],
    computedAt: '2026-09-23T00:05:00.000Z'
  });
  try {
    await withRewardService(async () => historicalRewardBoard(), () => withStubs({}, async () => {
      // Hàng hóa 90 ngày cố ý đổi nhãn sang nhãn có ngày thật của kỳ trong file (khóa/kiểu giữ nguyên) — test riêng.
      const payloads = ALL_STATIC_TABLES.filter(tableKey => tableKey !== 'products.product90d').map(tableKey => payloadFor(tableKey));
      for (const payload of payloads) {
        const metadata = await exportService.getExportFields(payload, 'Hà Nội');
        const dataset = await exportService.__test__.buildExportDataset(payload, 'Hà Nội');
        const where = `${payload.tableKey} ${JSON.stringify(payload.context)}`;
        assert.equal(dataset.worksheets.length, metadata.worksheets.length, where);
        dataset.worksheets.forEach((worksheet, index) => {
          const fields = metadata.worksheets[index].fields;
          assert.equal(worksheet.key, metadata.worksheets[index].key, where);
          assert.deepEqual(worksheet.columns.map(column => column.key), fields.map(field => field.key), where);
          assert.deepEqual(worksheet.columns.map(column => column.label), fields.map(field => field.label), where);
          assert.deepEqual(worksheet.columns.map(column => column.type), fields.map(field => field.type), where);
        });
      }
    }));
  } finally {
    dashboardData.getCustomerProductRevenueReport = originals.report;
    productReportRepository.getProductReport = originals.productReport;
    debtScheduleService.buildDebtAging = originals.debtAging;
  }
});

// ---------- Nhan chuan hoa cho ca cot derived/aggregate ----------

const FORBIDDEN_ENGLISH_TOKENS = new Set([
  'id', 'api', 'date', 'total', 'code', 'name', 'status', 'created', 'updated', 'price', 'quantity',
  'raw', 'sold', 'by', 'is', 'active', 'purchase', 'payment', 'customer', 'supplier', 'branch',
  'invoice', 'order', 'return', 'product', 'note', 'phone', 'address', 'debt', 'discount', 'fee'
]);
const FORBIDDEN_ABBREVIATIONS = new Set(['SL', 'DS', 'KH', 'NCC', 'SP', 'TT', 'HD', 'SĐT', 'SDT', 'TB', 'HN', 'SG']);

function assertStandardLabels(worksheets, where) {
  worksheets.forEach(worksheet => {
    const labels = new Set();
    const keys = new Set();
    worksheet.fields.forEach(field => {
      const label = field.label;
      const spot = `${where}/${worksheet.key}.${field.key} "${label}"`;
      assert.equal(typeof label, 'string', spot);
      assert.ok(label.length > 0 && label.length <= 40, `${spot}: do dai ${label.length}`);
      assert.equal(label, label.normalize('NFC').trim(), spot);
      assert.doesNotMatch(label, /\s{2,}/, spot);
      // Kỳ "90 ngày" của Hàng hóa 90 ngày bắt đầu bằng số đúng như tiêu đề nhóm trên màn hình.
      assert.match(label, where === 'products.product90d' ? /^[\p{Lu}\p{N}]/u : /^\p{Lu}/u, `${spot}: phai viet hoa chu dau`);
      // The requested Phạt/điểm column uses slash as division, valid in an Excel cell header.
      const debtRatioLabel = where === 'debt.penalty' && field.key === 'ratio' && label === 'Phạt/điểm';
      assert.doesNotMatch(label, debtRatioLabel ? /[\[\]:*?\\]/ : /[\[\]:*?/\\]/, `${spot}: ky tu khong hop le cho header`);
      assert.doesNotMatch(label, /^[=+\-@]/, spot);
      [['label', label], ['description', field.description]].forEach(([part, text]) => {
        if (typeof text !== 'string') return;
        assert.doesNotMatch(text, /_/, `${spot} ${part}: snake_case`);
        assert.doesNotMatch(text, /(^|\s)T\.(\s|$)/, `${spot} ${part}: viet tat "T."`);
        text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).forEach(token => {
          assert.ok(!FORBIDDEN_ENGLISH_TOKENS.has(token.toLowerCase()), `${spot} ${part}: tu tieng Anh "${token}"`);
          // Inventory uses the approved compact branch labels from the UI (2026-10-09).
          const inventoryBranchLabel = where === 'products.inventory' && part === 'label' &&
            ({ inTransit: 'Vận chuyển SG', availableHanoi: 'Có bán HN', availableSaigon: 'Có bán SG' })[field.key] === label &&
            ['HN', 'SG'].includes(token.toUpperCase());
          const requestedTransferLabel = where === 'overview.productReport' && field.key === 'inTransit' && label === 'Điều chuyển SG' && token.toUpperCase() === 'SG';
          // Hàng hóa 90 ngày giữ đúng nhãn cột của màn hình (SL, DS, Giá TB) theo yêu cầu; mô tả vẫn phải viết đầy đủ.
          const product90dScreenLabel = where === 'products.product90d' && part === 'label' && ['SL', 'DS', 'TB'].includes(token.toUpperCase());
          assert.ok(!FORBIDDEN_ABBREVIATIONS.has(token.toUpperCase()) || inventoryBranchLabel || requestedTransferLabel || product90dScreenLabel, `${spot} ${part}: viet tat "${token}"`);
        });
      });
      assert.ok(!labels.has(label), `${spot}: nhan trung trong worksheet`);
      assert.ok(!keys.has(field.key), `${spot}: key trung trong worksheet`);
      labels.add(label);
      keys.add(field.key);
    });
  });
}

test('moi nhan cua moi bang co dinh (ca cot derived/aggregate) dat chuan hoa', async () => {
  const payloads = ALL_STATIC_TABLES.map(tableKey => payloadFor(tableKey));
  for (const payload of payloads) {
    const metadata = await exportService.getExportFields(payload, 'Hà Nội', accessFor(payload.tableKey));
    assertStandardLabels(metadata.worksheets, payload.tableKey);
  }
});

test('nhan derived/aggregate da doi theo quy uoc chuan hoa', async () => {
  const labelsOf = async (tableKey, extra) => {
    const metadata = await exportService.getExportFields(payloadFor(tableKey, extra), 'Hà Nội');
    return metadata.worksheets[0].fields.map(field => field.label);
  };
  assert.deepEqual(await labelsOf('customers.productDetail'),
    ['Tên hàng', 'Số lượng', 'Doanh thu', 'Doanh thu tháng này', 'Doanh thu tháng trước', 'Doanh thu 2 tháng trước']);
  const debt = await labelsOf('debt.management');
  assert.ok(debt.includes('Nhân viên phụ trách (Sale)'));
  assert.ok(debt.includes('Lịch thanh toán'));
  assert.deepEqual((await labelsOf('stockout.recentScan')).slice(0, 2), ['Mã hàng', 'Tên hàng']);
  assert.ok((await labelsOf('stockout.check90d')).includes('Số ngày đứt hàng trung bình'));
});

// ---------- Tao file xlsx ----------

test('moi bang co dinh tao duoc file xlsx tu danh sach truong API tra ve', async () => {
  await withStubs({}, async stubs => {
    for (const tableKey of FIXED_TABLES) {
      const payload = { tableKey, filters: {}, context: { ...FIXED_CONTEXT } };
      const metadata = await exportService.getExportFields(payload);
      payload.columns = Object.fromEntries(metadata.worksheets.map(worksheet => [
        worksheet.key,
        worksheet.fields.map(field => field.key)
      ]));
      if (tableKey === 'debt.management') {
        assert.equal(metadata.worksheets[0].fields.filter(field => field.selected).length, 17);
      } else {
        assert.ok(metadata.worksheets.every(worksheet => worksheet.fields.every(field => field.selected)));
      }
      const file = await exportService.createExportWorkbook(payload);
      const workbook = await loadWorkbook(file);
      assert.equal(workbook.worksheets.length, metadata.worksheets.length, tableKey);
      workbook.worksheets.forEach((worksheet, index) => {
        assert.deepEqual(
          worksheet.getRow(1).values.slice(1),
          metadata.worksheets[index].fields.map(field => field.label),
          `${tableKey}: header Excel phai khop nhan buoc lay truong`
        );
      });
    }
  });
});

test('file Quản lý công nợ giữ kiểu số/phần trăm/text, freeze, AutoFilter và tên theo cơ sở', async () => {
  await withStubs({}, async () => {
    const payload = {
      tableKey: 'debt.management', context: { debtQueue: 'all' },
      columns: { debt_management: ['customerName', 'inScheduleDebt', 'currentDebtToSalesRatio', 'updatedBy', 'updatedAt'] }
    };
    const hn = await exportService.createExportWorkbook(payload, 'Hà Nội');
    assert.match(hn.fileName, /^HN_Quan_ly_cong_no_\d{8}_\d{4}\.xlsx$/);
    const workbook = await loadWorkbook(hn);
    const worksheet = workbook.worksheets[0];
    assert.equal(worksheet.name, 'Công nợ HN');
    assert.equal(worksheet.getCell('B2').value, 300000);
    assert.equal(worksheet.getCell('C2').value, 0.4);
    assert.equal(worksheet.getColumn(3).numFmt, '0.00%');
    assert.equal(worksheet.getCell('D2').value, "'=Người cập nhật");
    assert.ok(worksheet.getCell('E2').value instanceof Date);
    assert.equal(worksheet.views[0].ySplit, 1);
    assert.ok(worksheet.autoFilter);
  });

  const sgDashboard = buildDashboard();
  sgDashboard.debtManagement.sourceSheet = 'Công nợ SG';
  await withStubs({ dashboard: sgDashboard }, async () => {
    const sg = await exportService.createExportWorkbook({
      tableKey: 'debt.management', context: { debtQueue: 'all' },
      columns: { debt_management: ['customerName'] }
    }, 'Sài Gòn');
    assert.match(sg.fileName, /^SG_Quan_ly_cong_no_\d{8}_\d{4}\.xlsx$/);
    const workbook = await loadWorkbook(sg);
    assert.equal(workbook.worksheets[0].name, 'Công nợ SG');
  });
});

test('Quản lý công nợ: debtCycleDate rỗng = bản mới nhất; có ngày thì đọc bản chốt cũ, ghi ngày vào tên file', async () => {
  const debtScheduleService = require('../debtSchedule/debtScheduleService');
  const original = debtScheduleService.buildDebtManagement;
  const calls = [];
  const oldReport = buildDashboard().debtManagement;
  oldReport.sourceSheet = 'Chốt lúc 15:00 11/10';
  oldReport.customers = oldReport.customers.map(customer => ({ ...customer, customerName: `${customer.customerName} (cu)` }));
  debtScheduleService.buildDebtManagement = async (branchLabels, viewer, options) => { calls.push({ branchLabels, options }); return oldReport; };
  try {
    await withStubs({}, async () => {
      const base = { tableKey: 'debt.management', columns: { debt_management: ['customerName'] } };
      const latest = await exportService.createExportWorkbook({ ...base, context: { debtQueue: 'all' } }, 'Hà Nội');
      assert.equal(calls.length, 0, 'khong chon ngay -> khong dung duong doc ban cu');
      assert.match(latest.fileName, /^HN_Quan_ly_cong_no_\d{8}_\d{4}\.xlsx$/);

      const file = await exportService.createExportWorkbook({ ...base, context: { debtQueue: 'all', debtCycleDate: '2026-10-11' } }, 'Hà Nội');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].branchLabels, ['Hà Nội']);
      assert.equal(calls[0].options.cycleDate, '2026-10-11');
      assert.match(file.fileName, /^HN_Quan_ly_cong_no_chot_20261011_\d{8}_\d{4}\.xlsx$/);
      const worksheet = (await loadWorkbook(file)).worksheets[0];
      assert.match(String(worksheet.getCell('A2').value), /\(cu\)$/, 'du lieu lay tu ban chot cu');

      const both = await exportService.createExportWorkbook({ ...base, context: { debtQueue: 'all', debtCycleDate: '2026-10-11' } }, 'Cả hai');
      assert.deepEqual(calls[1].branchLabels, ['Hà Nội', 'Sài Gòn']);
      assert.match(both.fileName, /^TKS_Quan_ly_cong_no_chot_20261011_/);
    });
  } finally {
    debtScheduleService.buildDebtManagement = original;
  }
});

test('workbook giu ma co so 0 dau, chan chuoi cong thuc va bat freeze/autofilter', async () => {
  const rows = buildRowsBySheet();
  rows[CONFIG.SHEET_INVOICES][0].ma_hoa_don = '00123';
  rows[CONFIG.SHEET_INVOICES][0].khach_hang = '=Tên có công thức';
  const dashboard = buildDashboard();
  dashboard.invoices.transactionsReport.transactions[0].code = '00123';
  await withStubs({ rowsBySheet: rows, dashboard }, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'overview.transactions',
      filters: {},
      columns: { transactions: PRODUCT_COLUMNS }
    });
    assert.match(file.fileName, /^TKS_Chi_tiet_giao_dich_\d{8}_\d{4}\.xlsx$/);
    const workbook = await loadWorkbook(file);
    const worksheet = workbook.worksheets[0];
    assert.equal(worksheet.getCell('A2').value, '00123');
    assert.equal(worksheet.getCell('B2').value, "'=Tên có công thức");
    assert.equal(worksheet.getCell('C2').value, 300000);
    assert.equal(worksheet.views[0].ySplit, 1);
    assert.ok(worksheet.autoFilter);
  });
});

test('cot number toan gia tri so nguyen thi khong hien .00', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'overview.transactions',
      filters: {},
      columns: { transactions: PRODUCT_COLUMNS }
    });
    const workbook = await loadWorkbook(file);
    assert.equal(workbook.worksheets[0].getColumn(3).numFmt, '#,##0;[Red]-#,##0');
  });
});

test('cot number co it nhat 1 gia tri thap phan thi van hien .00', async () => {
  const rows = buildRowsBySheet();
  rows[CONFIG.SHEET_INVOICES][0].tong_tien_hang = 300000.5;
  await withStubs({ rowsBySheet: rows }, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'overview.transactions',
      filters: {},
      columns: { transactions: PRODUCT_COLUMNS }
    });
    const workbook = await loadWorkbook(file);
    assert.equal(workbook.worksheets[0].getColumn(3).numFmt, '#,##0;[Red]-#,##0');
  });
});

test('header khong to mau nen, chu den, an gridline', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'overview.transactions',
      filters: {},
      columns: { transactions: PRODUCT_COLUMNS }
    });
    const worksheet = (await loadWorkbook(file)).worksheets[0];
    const header = worksheet.getRow(1);
    assert.equal(header.font.color.argb, 'FF000000');
    header.eachCell(cell => {
      assert.equal(cell.fill === undefined || cell.fill.pattern === 'none', true);
      assert.ok(cell.border && cell.border.top && cell.border.left && cell.border.bottom && cell.border.right);
    });
    assert.equal(worksheet.views[0].showGridLines, false);
    worksheet.getRow(2).eachCell(cell => {
      assert.ok(cell.border && cell.border.top && cell.border.left && cell.border.bottom && cell.border.right);
    });
  });
});

test('ten file gan tien to HN_/SG_ theo co so dang xuat', async () => {
  await withStubs({}, async () => {
    const payload = { tableKey: 'overview.transactions', filters: {}, columns: { transactions: PRODUCT_COLUMNS } };
    const hn = await exportService.createExportWorkbook(payload, 'Hà Nội');
    assert.match(hn.fileName, /^HN_Chi_tiet_giao_dich_\d{8}_\d{4}\.xlsx$/);
    const sg = await exportService.createExportWorkbook(payload, 'Sài Gòn');
    assert.match(sg.fileName, /^SG_Chi_tiet_giao_dich_\d{8}_\d{4}\.xlsx$/);
  });
});

test('createExportWorkbook chi ghi cot da chon (thu tu theo yeu cau khong quan trong, theo cot nguon)', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExportWorkbook({
      tableKey: 'overview.transactions',
      columns: { transactions: ['ma_hoa_don', 'tong_tien_hang'] }
    });
    const workbook = await loadWorkbook(file);
    assert.equal(workbook.worksheets.length, 1);
    assert.deepEqual(workbook.worksheets[0].getRow(1).values.slice(1), ['Mã hóa đơn', 'Tổng tiền hàng']);
    assert.equal(workbook.worksheets[0].getCell('A2').value, 'HD-01');
    assert.equal(workbook.worksheets[0].getCell('B2').value, 300000);
  });
});

// ---------- Nguon du lieu: dung ma, dung bo loc, khong sua cache ----------

test('normalizeFilters: chi con bo loc invoices; bo loc cua tab Hang hoa/Khach hang cu va orders/returns bi bo qua', () => {
  const { normalizeFilters } = exportService.__test__;
  const own = normalizeFilters({
    products: { mode: 'days', days: 7 }, invoices: { mode: 'all' }, customers: { mode: 'all' },
    newlyImported: { mode: 'days', days: 90 }, orders: { mode: 'days', days: 14 }, returns: { mode: 'range', from: '2026-07-01', to: '2026-07-31' }
  });
  assert.deepEqual(own, { invoices: { mode: 'all' } });
});

test('readRowsByCodes nhan dung tab, co so va danh sach ma logic; getDashboardData nhan dung bo loc', async () => {
  await withStubs({}, async stubs => {
    await exportService.createExportWorkbook({
      tableKey: 'overview.transactions',
      filters: {
        invoices: { mode: 'range', from: '2026-01-01T00:00:00', to: '2026-01-31' },
        overview: { mode: 'days', days: 7 } // bo loc cu da bo -> bi bo qua
      },
      columns: { transactions: ['ma_hoa_don'] }
    }, 'Sài Gòn');
    assert.equal(stubs.calls.dashboard.length, 1);
    const [filters, branch, viewer] = stubs.calls.dashboard[0];
    assert.equal(branch, 'Sài Gòn');
    assert.equal(viewer, undefined, 'viewer bo trong = khong quyen sua cong no');
    assert.deepEqual(filters.invoices, { mode: 'range', from: '2026-01-01', to: '2026-01-31' });
    assert.equal('overview' in filters, false, 'bo loc overview (ov*) da bo');
    assert.deepEqual(stubs.calls.rows, [{ sheetName: CONFIG.SHEET_INVOICES, branch: 'Sài Gòn', codes: ['HD-01'] }]);
  });
});

test('bang khong co ma logic thi khong query Postgres', async () => {
  const dashboard = buildDashboard();
  dashboard.invoices.transactionsReport.transactions = [];
  await withStubs({ dashboard }, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('overview.transactions', fixedEnv(stubs), {});
    assert.equal(dataset.worksheets[0].rows.length, 0);
    assert.equal(stubs.calls.rows.length, 0);
  });
});

test('dong logic khong co dong tho tuong ung van duoc xuat voi cot rong (giu hanh vi cu)', async () => {
  const dashboard = buildDashboard();
  dashboard.invoices.transactionsReport.transactions = [
    { code: 'HD-01', quantity: 2, quantityKnown: true }, { code: 'KHONG-CO', quantity: 4, quantityKnown: true }
  ];
  await withStubs({ dashboard }, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset('overview.transactions', fixedEnv(stubs), {});
    assert.equal(dataset.worksheets[0].rows.length, 2);
    assert.equal(dataset.worksheets[0].rows[1].ma_hoa_don, '');
    assert.equal(dataset.worksheets[0].rows[1].d_quantity, 4);
  });
});

test('ghep dong tho theo ma da chuan hoa (NFC, hoa/thuong, dau cach thua) nhung van truyen dung ma goc cho Postgres', async () => {
  const base = buildDashboard();
  const dashboard = deepFreeze({ ...base, invoices: { transactionsReport: { transactions: [{ code: ' hd-á ', quantity: 1, quantityKnown: true }] } } });
  const originals = { getDashboardData: dashboardData.getDashboardData, readRowsByCodes: dashboardPgReader.readRowsByCodes };
  const requested = [];
  dashboardPgReader.readRowsByCodes = async (sheetName, branch, codes) => {
    requested.push(Array.from(codes));
    // Postgres luu ma dang NFD + viet hoa (HD-A + dau sac roi): chi khop khi ghep theo ma da chuan hoa.
    return { columns: [], rows: [sourceRow('invoices', { ma_hoa_don: 'HD-Á', khach_hang: 'Khách A' })] };
  };
  try {
    const dataset = await exportService.__test__.buildFixedDataset('overview.transactions', { dashboard, branch: 'Hà Nội' }, {});
    assert.deepEqual(requested, [[' hd-á ']]);
    assert.equal(dataset.worksheets[0].rows.length, 1);
    assert.equal(dataset.worksheets[0].rows[0].khach_hang, 'Khách A');
  } finally {
    dashboardData.getDashboardData = originals.getDashboardData;
    dashboardPgReader.readRowsByCodes = originals.readRowsByCodes;
  }
});

test('xuat file khong sua ket qua dashboard dung chung (du lieu stub bi deep-freeze)', async () => {
  await withStubs({}, async stubs => {
    assert.ok(Object.isFrozen(stubs.dashboard));
    for (const tableKey of FIXED_TABLES) {
      const payload = { tableKey, context: { ...FIXED_CONTEXT, debtSort: { columnIndex: 5, direction: 'desc' } }, tableSearch: { mode: 'normal', query: 'a' } };
      const metadata = await exportService.getExportFields(payload);
      payload.columns = Object.fromEntries(metadata.worksheets.map(worksheet => [worksheet.key, worksheet.fields.map(field => field.key)]));
      await exportService.createExportWorkbook(payload, 'Hà Nội');
    }
    assert.deepEqual(stubs.dashboard, buildDashboard());
  });
});

// ---------- Validate cot truoc khi cham DB ----------

test('API dich vu tu choi bang search.results (da go /api/search) va tu choi khi khong chon truong', async () => {
  assert.equal(Object.prototype.hasOwnProperty.call(exportService.TABLE_TITLES, 'search.results'), false);
  await assert.rejects(
    exportService.getExportFields({ tableKey: 'search.results', search: { view: 'products', query: 'abc' } }),
    error => error.code === 'EXPORT_TABLE_NOT_ALLOWED'
  );

  await withStubs({}, async () => {
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'overview.transactions', columns: { transactions: [] } }),
      error => error.code === 'EXPORT_NO_FIELDS_SELECTED'
    );
  });
});

test('createExportWorkbook validate danh sach cot TRUOC khi nap du lieu (khong cham getDashboardData/Postgres)', async () => {
  await withStubs({}, async stubs => {
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'overview.transactions', columns: { transactions: ['khong_co_cot_nay'] } }),
      error => error.statusCode === 400 && error.code === 'EXPORT_FIELD_NOT_ALLOWED'
    );
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'overview.transactions', columns: {} }),
      error => error.statusCode === 400 && error.code === 'EXPORT_FIELDS_REQUIRED'
    );
    await assert.rejects(
      exportService.createExportWorkbook({ tableKey: 'overview.transactions' }),
      error => error.code === 'EXPORT_FIELDS_REQUIRED'
    );
    await assert.rejects(exportService.createExportWorkbook({ tableKey: 'bang.la' }), error => error.code === 'EXPORT_TABLE_NOT_ALLOWED');
    await assert.rejects(exportService.createExportWorkbook(undefined), error => error.code === 'EXPORT_TABLE_NOT_ALLOWED');
    assert.equal(stubs.calls.dashboard.length, 0);
    assert.equal(stubs.calls.rows.length, 0);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('chi nap cot da chon: dong dataset chi co cac khoa cot da chon', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.__test__.buildFixedDataset(
      'overview.transactions', fixedEnv(stubs), {}, {}, { transactions: ['ma_hoa_don', 'd_quantity'] }
    );
    assert.deepEqual(Object.keys(dataset.worksheets[0].rows[0]), ['ma_hoa_don', 'd_quantity']);
    assert.equal(dataset.worksheets[0].columns.length > 2, true, 'danh sach cot day du van giu de validate allowlist');
  });
});

// ---------- Tim kiem, bao cao khach, stockout ----------

test('Bao cao doanh thu theo khach: xuat bang chi tiet (gom ca cot so sanh thang), loc theo san pham khi co chon, tu choi khi chua chon khach', async () => {
  const originalReport = dashboardData.getCustomerProductRevenueReport;
  dashboardData.getCustomerProductRevenueReport = async (code, name) => ({
    customer: { code, name: name || code },
    products: [
      { code: 'SP-01', name: 'Sản phẩm một', quantity: 3, revenue: 300, month1Revenue: 100, month2Revenue: 100, month3Revenue: 100 },
      { code: 'SP-02', name: 'Sản phẩm hai', quantity: 1, revenue: 100, month1Revenue: 100, month2Revenue: 0, month3Revenue: 0 }
    ]
  });
  try {
    const detailDataset = await exportService.__test__.buildExportDataset({
      tableKey: 'customers.productDetail',
      context: { customerProductCustomerCode: 'KH-01', customerProductCustomerName: 'Khách A' }
    });
    assert.equal(detailDataset.worksheets[0].rows.length, 2);
    assert.deepEqual(detailDataset.worksheets[0].columns.map(c => c.label),
      ['Tên hàng', 'Số lượng', 'Doanh thu', 'Doanh thu tháng này', 'Doanh thu tháng trước', 'Doanh thu 2 tháng trước']);

    const monthlyDataset = await exportService.__test__.buildExportDataset({
      tableKey: 'customers.productDetail',
      context: { customerProductCustomerCode: 'KH-01', customerProductCode: 'SP-02' }
    });
    assert.equal(monthlyDataset.worksheets[0].rows.length, 1, 'chon 1 san pham thi chi xuat 1 dong');
    assert.equal(monthlyDataset.worksheets[0].rows[0].name, 'Sản phẩm hai');
    assert.equal(monthlyDataset.worksheets[0].rows[0].month1Revenue, 100);

    const selectedWithSearch = await exportService.__test__.buildExportDataset({
      tableKey: 'customers.productDetail',
      context: { customerProductCustomerCode: 'KH-01', customerProductCode: 'SP-02' },
      tableSearch: { mode: 'normal', query: 'SP-02' }
    });
    assert.equal(selectedWithSearch.worksheets[0].rows.length, 1, 'ma san pham da chon khong bi loc mat khi worksheet an cot ma');

    await assert.rejects(
      exportService.__test__.buildExportDataset({ tableKey: 'customers.productDetail', context: {} }),
      error => error.statusCode === 400 && error.code === 'EXPORT_NO_CUSTOMER_SELECTED'
    );

    const file = await exportService.createExportWorkbook({
      tableKey: 'customers.productDetail',
      context: { customerProductCustomerCode: 'KH-01' },
      columns: { customer_product_detail: ['name', 'month1Revenue'] }
    });
    assert.equal((await loadWorkbook(file)).worksheets[0].getCell('B2').value, 100);
  } finally {
    dashboardData.getCustomerProductRevenueReport = originalReport;
  }
});

test('buildExportDataset: stockout.recentScan tra dung worksheet', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      branch: 'Hà Nội',
      rows: [{
        code: 'SP001', name: 'Ao thun', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, hasUnreliableData: true,
        periods: [
          { fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 },
          { fromDate: '2026-01-10', toDate: '2026-01-15', days: 6 }
        ]
      }]
    }
  });

  assert.equal(dataset.tableKey, 'stockout.recentScan');
  assert.equal(dataset.title, 'Hàng đứt gần đây');
  assert.equal(dataset.sourceBranch, 'Hà Nội');
  assert.equal(dataset.worksheets.length, 1);
  assert.deepEqual(dataset.worksheets[0].columns.map((c) => c.key), ['code', 'name', 'lastOutOfStockDate', 'daysOutOfStock', 'periods']);
  assert.equal(dataset.worksheets[0].rows[0].code, 'SP001');
  assert.equal(dataset.worksheets[0].rows[0].periods, '01/01/2026 -> 05/01/2026\n10/01/2026 -> 15/01/2026');
});

test('buildExportDataset loc ket qua stockout theo tableSearch hien tai', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.recentScan',
    tableSearch: { mode: 'normal', query: 'chổi lau nhà' },
    recentStockoutResult: {
      rows: [
        { code: 'SP001', name: 'Chổi lau nhà lớn', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, periods: [] },
        { code: 'SP002', name: 'Nước lau sàn', lastOutOfStockDate: '2026-01-06', daysOutOfStock: 7, periods: [] }
      ]
    }
  });

  assert.deepEqual(dataset.worksheets[0].rows.map(row => row.code), ['SP001']);
});

test('createExportWorkbook: file stockout.recentScan dung ten co so LUC QUET (result.branch), khong phai co so dang xuat hien tai', async () => {
  const file = await exportService.createExportWorkbook({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      branch: 'Hà Nội',
      rows: [{ code: 'SP001', name: 'Ao thun', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, periods: [] }]
    },
    columns: { recent_stockout_result: ['code', 'name', 'lastOutOfStockDate', 'daysOutOfStock', 'periods'] }
  }, 'Sài Gòn'); // req.branch hien tai la Sai Gon, nhung ban quet duoc chay o Ha Noi
  assert.match(file.fileName, /^HN_/);
});

test('buildExportDataset: stockout.recentScan khong co dong nao thi bao loi EXPORT_NO_DATA', async () => {
  await assert.rejects(
    exportService.__test__.buildExportDataset({ tableKey: 'stockout.recentScan', recentStockoutResult: { rows: [] } }),
    /EXPORT_NO_DATA|Chưa có kết quả/
  );
});

test('buildExportDataset: stockout.check90d tra dung worksheet', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.check90d',
    stockout90dResult: {
      branch: 'Sài Gòn',
      rows: [{
        code: 'SP001', name: 'Ao thun', stockoutCount: 2, totalStockoutDays: 10, currentOnHand: 3, hasUnreliableData: false,
        periods: [
          { fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 },
          { fromDate: '2026-01-10', toDate: '2026-01-14', days: 5 }
        ]
      }]
    }
  });

  assert.equal(dataset.tableKey, 'stockout.check90d');
  assert.equal(dataset.title, 'Kiểm tra đứt hàng 90 ngày');
  assert.equal(dataset.sourceBranch, 'Sài Gòn');
  assert.equal(dataset.worksheets.length, 1);
  assert.deepEqual(dataset.worksheets[0].columns.map((c) => c.key), ['code', 'name', 'stockoutCount', 'totalStockoutDays', 'avgStockoutDays', 'currentOnHand', 'periods']);
  assert.equal(dataset.worksheets[0].rows[0].code, 'SP001');
  assert.equal(dataset.worksheets[0].rows[0].avgStockoutDays, 5);
  assert.equal(dataset.worksheets[0].rows[0].periods, '01/01/2026 -> 05/01/2026\n10/01/2026 -> 14/01/2026');
});

test('buildExportDataset: stockout.check30d tra dung worksheet', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.check30d',
    stockout30dResult: {
      branch: 'Sài Gòn',
      rows: [{
        code: 'SP001', name: 'Ao thun', stockoutCount: 2, totalStockoutDays: 10, currentOnHand: 3, hasUnreliableData: false,
        periods: [
          { fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 },
          { fromDate: '2026-01-10', toDate: '2026-01-14', days: 5 }
        ]
      }]
    }
  });

  assert.equal(dataset.tableKey, 'stockout.check30d');
  assert.equal(dataset.title, 'Kiểm tra đứt hàng 30 ngày');
  assert.equal(dataset.sourceBranch, 'Sài Gòn');
  assert.equal(dataset.worksheets.length, 1);
  assert.deepEqual(dataset.worksheets[0].columns.map((c) => c.key), ['code', 'name', 'stockoutCount', 'totalStockoutDays', 'avgStockoutDays', 'currentOnHand', 'periods']);
  assert.equal(dataset.worksheets[0].rows[0].code, 'SP001');
  assert.equal(dataset.worksheets[0].rows[0].avgStockoutDays, 5);
  assert.equal(dataset.worksheets[0].rows[0].periods, '01/01/2026 -> 05/01/2026\n10/01/2026 -> 14/01/2026');
});

test('buildExportDataset: stockout.check30d khong co dong nao thi bao loi EXPORT_NO_DATA', async () => {
  await assert.rejects(
    exportService.__test__.buildExportDataset({ tableKey: 'stockout.check30d', stockout30dResult: { rows: [] } }),
    /EXPORT_NO_DATA|Chưa có kết quả/
  );
});

test('file Excel stockout bật wrap text cho cột Các đợt đứt hàng', async () => {
  const file = await exportService.createExportWorkbook({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      rows: [{
        code: 'SP001', name: 'Áo thun', lastOutOfStockDate: '2026-01-01', daysOutOfStock: 10,
        periods: [
          { fromDate: '2026-01-01', toDate: '2026-01-05', days: 5 },
          { fromDate: '2026-01-10', toDate: '2026-01-14', days: 5 }
        ]
      }]
    },
    columns: { recent_stockout_result: ['code', 'name', 'lastOutOfStockDate', 'daysOutOfStock', 'periods'] }
  });
  const workbook = await loadWorkbook(file);
  const periodsColumn = workbook.worksheets[0].getColumn(5);
  assert.equal(periodsColumn.alignment.wrapText, true);
  assert.match(workbook.worksheets[0].getCell('E2').value, /\n/);
});

test('buildExportDataset: stockout.check90d khong co dong nao thi bao loi EXPORT_NO_DATA', async () => {
  await assert.rejects(
    exportService.__test__.buildExportDataset({ tableKey: 'stockout.check90d', stockout90dResult: { rows: [] } }),
    /EXPORT_NO_DATA|Chưa có kết quả/
  );
});

// ---------- Gioi han tai ----------

function createGate() {
  let open;
  const promise = new Promise(resolve => { open = resolve; });
  return { promise, open };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

const QUICK_EXPORT = { tableKey: 'overview.transactions', columns: { transactions: ['ma_hoa_don'] } };

test('semaphore: 5 export dong thoi chi chay toi da 2, cac yeu cau con lai cho trong hang doi roi van xong het', async () => {
  const gate = createGate();
  let running = 0;
  let maxRunning = 0;
  await withStubs({
    onDashboard: async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await gate.promise;
      running -= 1;
    }
  }, async stubs => {
    const jobs = Array.from({ length: 5 }, () => exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'));
    await tick();
    assert.equal(exportService.EXPORT_MAX_CONCURRENT, 2);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 3 });
    assert.equal(stubs.calls.dashboard.length, 2, 'moi 2 yeu cau dau duoc nap du lieu');
    gate.open();
    const files = await Promise.all(jobs);
    assert.equal(files.length, 5);
    assert.equal(maxRunning, 2);
    assert.equal(stubs.calls.dashboard.length, 5);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('semaphore: hang doi day (2 dang chay + 8 cho) thi yeu cau thu 11 bi tu choi 503 EXPORT_BUSY', async () => {
  const gate = createGate();
  await withStubs({ onDashboard: () => gate.promise }, async () => {
    assert.equal(exportService.EXPORT_MAX_QUEUED, 8);
    const jobs = Array.from({ length: 10 }, () => exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'));
    const overflow = exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội');
    await assert.rejects(overflow, error => error.statusCode === 503 && error.code === 'EXPORT_BUSY'
      && error.message === 'Hệ thống đang xử lý nhiều yêu cầu xuất file, vui lòng thử lại sau ít giây.');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 8 });
    gate.open();
    const files = await Promise.all(jobs);
    assert.equal(files.length, 10);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
    // Sau khi ha tai thi nhan lai duoc yeu cau moi.
    const later = await exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội');
    assert.ok(later.buffer.length > 0);
  });
});

test('semaphore: luon nha slot khi export loi (ca loi nap du lieu lan loi ghi file)', async () => {
  let failNext = 2;
  await withStubs({
    onDashboard: async () => {
      if (failNext > 0) {
        failNext -= 1;
        throw new Error('loi nap du lieu gia lap');
      }
    }
  }, async () => {
    await assert.rejects(exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'), /loi nap du lieu gia lap/);
    await assert.rejects(exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'), /loi nap du lieu gia lap/);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
    const ok = await exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội');
    assert.ok(ok.buffer.length > 0);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('huy: signal da abort thi khong nap du lieu; abort khi dang cho trong hang doi thi bo muc do va khong chay', async () => {
  const gate = createGate();
  await withStubs({ onDashboard: () => gate.promise }, async stubs => {
    const already = new AbortController();
    already.abort();
    await assert.rejects(
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: already.signal }),
      error => error.code === 'EXPORT_ABORTED'
    );
    assert.equal(stubs.calls.dashboard.length, 0);

    const running = [
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội'),
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội')
    ];
    const controller = new AbortController();
    const queued = exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: controller.signal });
    const survivor = exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội');
    await tick();
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 2 });
    controller.abort();
    await assert.rejects(queued, error => error.code === 'EXPORT_ABORTED');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 1 });

    gate.open();
    await Promise.all([...running, survivor]);
    assert.equal(stubs.calls.dashboard.length, 3, 'muc da huy trong hang doi khong bao gio nap du lieu');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('huy: dung ngay sau buoc nap dashboard, khong doc Postgres va nha slot', async () => {
  const controller = new AbortController();
  await withStubs({ onDashboard: async () => { controller.abort(); } }, async stubs => {
    await assert.rejects(
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: controller.signal }),
      error => error.code === 'EXPORT_ABORTED'
    );
    assert.equal(stubs.calls.dashboard.length, 1);
    assert.equal(stubs.calls.rows.length, 0);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });

  const second = new AbortController();
  await withStubs({ onRows: async () => { second.abort(); } }, async stubs => {
    await assert.rejects(
      exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: second.signal }),
      error => error.code === 'EXPORT_ABORTED'
    );
    assert.equal(stubs.calls.rows.length, 1);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

// ---------- Sua loi sau review ----------

test('tableKey trung khoa cua Object.prototype bi tu choi 400 EXPORT_TABLE_NOT_ALLOWED (khong phai TypeError 500)', async () => {
  const isNotAllowed = error => error.statusCode === 400 && error.code === 'EXPORT_TABLE_NOT_ALLOWED';
  for (const tableKey of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    await assert.rejects(exportService.getExportFields({ tableKey, context: {} }, 'Hà Nội'), isNotAllowed, `getExportFields ${tableKey}`);
    await assert.rejects(exportService.createExportWorkbook({ tableKey, context: {} }, 'Hà Nội'), isNotAllowed, `createExportWorkbook ${tableKey}`);
    assert.throws(() => exportService.__test__.getTableSpec(tableKey, {}), isNotAllowed, `getTableSpec ${tableKey}`);
  }
});

test('readRowsByCodes nhan signal cua yeu cau xuat de dung giua cac lo', async () => {
  await withStubs({}, async stubs => {
    const controller = new AbortController();
    await exportService.createExportWorkbook(QUICK_EXPORT, 'Hà Nội', { signal: controller.signal });
    assert.equal(stubs.calls.rowOptions.length, 1);
    assert.strictEqual(stubs.calls.rowOptions[0].signal, controller.signal);
  });
});

test('nhan cot tong hop: ty le no qua han theo doanh so TRUNG BINH, khong viet tat NCC', async () => {
  const metadata = await exportService.getExportFields({ tableKey: 'debt.management', context: { debtQueue: 'all' } }, 'Hà Nội');
  const overdue = metadata.worksheets[0].fields.find(field => field.key === 'overdueToSalesRatio');
  assert.equal(overdue.label, 'Nợ quá hạn trên doanh số trung bình');
  assert.match(overdue.description, /doanh số trung bình/);
});

test('buildExportErrorBody: chi tra detail cho loi da biet (EXPORT_*, INVALID_BRANCH), loi bat ngo dung thong diep mac dinh', () => {
  const known = Object.assign(new Error('Bảng yêu cầu xuất không hợp lệ.'), { statusCode: 400, code: 'EXPORT_TABLE_NOT_ALLOWED' });
  assert.deepEqual(exportService.buildExportErrorBody(known, 'Không thể tạo file Excel.'),
    { error: 'Không thể tạo file Excel.', detail: 'Bảng yêu cầu xuất không hợp lệ.', code: 'EXPORT_TABLE_NOT_ALLOWED' });
  const branch = Object.assign(new Error('Cơ sở không hợp lệ.'), { statusCode: 400, code: 'INVALID_BRANCH' });
  assert.equal(exportService.buildExportErrorBody(branch, 'x').detail, 'Cơ sở không hợp lệ.');

  const pg = Object.assign(new Error('timeout exceeded when trying to connect'), { code: 'ETIMEDOUT' });
  const body = exportService.buildExportErrorBody(pg, 'Không lấy được danh sách trường xuất Excel.');
  assert.equal(body.detail, undefined);
  assert.equal(body.error, 'Không lấy được danh sách trường xuất Excel.');
  assert.equal('googleStatus' in body, false);
  assert.equal(exportService.buildExportErrorBody(new TypeError('Cannot read properties of undefined'), 'x').detail, undefined);
});

// ---------- Ca hai: xuat Excel ----------

const BOTH = 'Cả hai';
const HN = 'Hà Nội';
const SG = 'Sài Gòn';

// Thay readRowsByCodes bang ban theo TUNG CO SO VAT LY: `rowsByBranch` = { [branch]: { [sheetName]: rows } }.
// Ghi lai moi lan goi; tu choi neu bi goi voi bat ky gia tri nao khong phai co so vat ly.
function stubRowsByBranch(rowsByBranch, calls) {
  dashboardPgReader.readRowsByCodes = async (sheetName, branch, codes, readOptions) => {
    if (![HN, SG].includes(branch)) throw new Error(`readRowsByCodes bi goi voi co so khong vat ly: ${branch}`);
    calls.push({ sheetName, branch, codes: Array.from(codes) });
    const source = catalog.getSourceBySheetName(sheetName);
    const wanted = new Set(codes);
    return {
      columns: source.fields.map(item => item.key),
      rows: (((rowsByBranch[branch] || {})[sheetName]) || []).filter(row => wanted.has(row[source.codeKey])).map(row => ({ ...row, co_so: branch }))
    };
  };
}

function worksheetTable(workbook, index = 0) {
  const worksheet = workbook.worksheets[index];
  const rows = [];
  worksheet.eachRow((row, rowNumber) => { if (rowNumber > 1) rows.push(row.values.slice(1)); });
  return { header: worksheet.getRow(1).values.slice(1), rows };
}

test('Cot "Cơ sở" nam san trong catalogue cua moi nguon: buoc lay truong khong nap du lieu, Ca hai va co so vat ly giong nhau', async () => {
  await withStubs({}, async stubs => {
    for (const tableKey of ['overview.transactions']) {
      const both = await exportService.getExportFields(payloadFor(tableKey), BOTH);
      const physical = await exportService.getExportFields(payloadFor(tableKey), HN);
      assert.deepEqual(both, physical, `${tableKey}: Ca hai va co so vat ly cung bo truong`);
      both.worksheets.forEach(worksheet => {
        const facility = worksheet.fields.find(field => field.label === 'Cơ sở');
        assert.ok(facility, `${tableKey}/${worksheet.key}: co cot Cơ sở`);
        assert.equal(facility.selected, true);
        assert.equal(facility.type, 'text');
      });
    }
    const debt = await exportService.getExportFields(payloadFor('debt.management'), BOTH);
    assert.equal(debt.worksheets[0].fields[1].label, 'Cơ sở');
    assert.equal(stubs.calls.dashboard.length, 0);
    assert.equal(stubs.calls.rows.length, 0);
  });
});

test('Ca hai: hoa don trung ma o hai co so ghep dung dong tho theo (co so, ma) va chi truy van co so co ma', async () => {
  const dashboard = {
    invoices: {
      transactionsReport: {
        transactions: [
          { code: 'HD-01', branch: HN, quantity: 2, quantityKnown: true },
          { code: 'HD-01', branch: SG, quantity: 5, quantityKnown: true },
          { code: 'HD-02', branch: SG, quantity: 1, quantityKnown: true }
        ]
      }
    }
  };
  await withStubs({ dashboard }, async stubs => {
    const calls = [];
    stubRowsByBranch({
      [HN]: { [CONFIG.SHEET_INVOICES]: [sourceRow('invoices', { ma_hoa_don: 'HD-01', khach_hang: 'Khách HN', tong_tien_hang: 100 })] },
      [SG]: { [CONFIG.SHEET_INVOICES]: [
        sourceRow('invoices', { ma_hoa_don: 'HD-01', khach_hang: 'Khách SG', tong_tien_hang: 200 }),
        sourceRow('invoices', { ma_hoa_don: 'HD-02', khach_hang: 'Khách SG 2', tong_tien_hang: 300 })
      ] }
    }, calls);
    const file = await exportService.createExportWorkbook({
      tableKey: 'overview.transactions',
      columns: { transactions: ['ma_hoa_don', 'khach_hang', 'tong_tien_hang', 'd_quantity', 'co_so'] }
    }, BOTH);
    const table = worksheetTable(await loadWorkbook(file));
    assert.deepEqual(table.header, ['Mã hóa đơn', 'Khách hàng', 'Tổng tiền hàng', 'Số lượng', 'Cơ sở']);
    assert.deepEqual(table.rows, [
      ['HD-01', 'Khách HN', 100, 2, HN],
      ['HD-01', 'Khách SG', 200, 5, SG],
      ['HD-02', 'Khách SG 2', 300, 1, SG]
    ]);
    assert.deepEqual(calls, [
      { sheetName: CONFIG.SHEET_INVOICES, branch: HN, codes: ['HD-01'] },
      { sheetName: CONFIG.SHEET_INVOICES, branch: SG, codes: ['HD-01', 'HD-02'] }
    ]);
    assert.equal(stubs.calls.dashboard[0][1], BOTH, 'man hinh va xuat cung nap tap Ca hai');
  });

  // Chi mot co so co ma -> khong query co so con lai.
  const onlySaigon = { invoices: { transactionsReport: { transactions: [{ code: 'HD-07', branch: SG, quantity: 1, quantityKnown: true }] } } };
  await withStubs({ dashboard: onlySaigon }, async () => {
    const calls = [];
    stubRowsByBranch({
      [SG]: { [CONFIG.SHEET_INVOICES]: [sourceRow('invoices', { ma_hoa_don: 'HD-07', khach_hang: 'Khách SG' })] },
      [HN]: { [CONFIG.SHEET_INVOICES]: [sourceRow('invoices', { ma_hoa_don: 'HD-07', khach_hang: 'Khách HN' })] }
    }, calls);
    const invoices = worksheetTable(await loadWorkbook(await exportService.createExportWorkbook({
      tableKey: 'overview.transactions', columns: { transactions: ['ma_hoa_don', 'khach_hang', 'co_so'] }
    }, BOTH)));
    assert.deepEqual(invoices.rows, [['HD-07', 'Khách SG', SG]]);
    assert.deepEqual(calls.map(call => call.branch), [SG]);
  });
});


test('Ca hai: loc Quan ly cong no tren hang GOP nhu man hinh, roi moi tach tung co so kem cot "Cơ sở"', async () => {
  const detail = (customerName, branch, currentDebt, needsAction, workflowStatus) => ({
    branch, sourceSheet: `Công nợ ${branch}`, customerName, sale: 'Lan', paymentSchedule: '1',
    inScheduleDebt: 0, currentDebt, overdueDebt: Math.max(currentDebt, 0), alertCodes: [], dataIssues: [], workflowStatus, needsAction,
    updatedBy: '', updatedAt: ''
  });
  // Hang gop nhu mergeDebtManagementSources: cong no cong don, needsAction la OR cua cac co so.
  const merged = (customerName, currentDebt, needsAction, branchDetails) => ({
    customerName, sale: 'Lan', paymentSchedule: '1', inScheduleDebt: 0, currentDebt, overdueDebt: Math.max(currentDebt, 0),
    needsAction, alertCodes: [], dataIssues: [], workflowStatus: 'Đã xử lý', branchDetails
  });
  const dashboard = {
    debtManagement: {
      available: true,
      sourceSheet: 'Công nợ Hà Nội + Công nợ Sài Gòn',
      customers: [
        // A: HN khong can xu ly (100), SG can xu ly (200) -> man hinh: 1 hang 300, needsAction = true.
        merged('Khách A', 300, true, [detail('Khách A', HN, 100, false, 'Đã xử lý'), detail('Khách A', SG, 200, true, 'Chưa xử lý')]),
        // B: cong no HN +500 va SG -500 bu tru nhau -> man hinh: 0, khong thuoc hang "Con no".
        merged('Khách B', 0, false, [detail('Khách B', HN, 500, false, 'Đã xử lý'), detail('Khách B', SG, -500, false, 'Đã xử lý')]),
        // C: cong no lon hon A nhung chi co 1 co so (khong co branchDetails).
        merged('Khách C', 900, false, undefined)
      ]
    }
  };
  const build = context => exportService.__test__.buildFixedDataset('debt.management', { dashboard: dashboard_, branch: BOTH }, context);
  let dashboard_;
  await withStubs({ dashboard }, async stubs => {
    dashboard_ = stubs.dashboard;
    const all = await build({ debtQueue: 'all' });
    assert.equal(all.worksheets[0].columns[1].label, 'Cơ sở');
    assert.deepEqual(all.worksheets[0].rows.map(row => [row.customerName, row.branch, row.currentDebt, row.workflowStatus]), [
      ['Khách A', HN, 100, 'Đã xử lý'], ['Khách A', SG, 200, 'Chưa xử lý'],
      ['Khách B', HN, 500, 'Đã xử lý'], ['Khách B', SG, -500, 'Đã xử lý'],
      ['Khách C', '', 900, 'Đã xử lý']
    ]);

    // needsAction loc theo hang gop (OR cac co so): giu CA HAI dong cua A, khong bo cong no 100 cua Ha Noi.
    const needs = await build({ debtQueue: 'needsAction' });
    assert.deepEqual(needs.worksheets[0].rows.map(row => [row.customerName, row.branch, row.currentDebt]), [
      ['Khách A', HN, 100], ['Khách A', SG, 200]
    ]);

    // currentDebt loc theo tong gop: B (500 - 500 = 0) bi an nhu tren man hinh, ke ca dong Ha Noi +500.
    const owing = await build({ debtQueue: 'currentDebt' });
    assert.deepEqual(owing.worksheets[0].rows.map(row => [row.customerName, row.branch]), [
      ['Khách A', 'Hà Nội'], ['Khách A', 'Sài Gòn'], ['Khách C', '']
    ]);
    const overdue = await build({ debtQueue: 'overdue' });
    assert.deepEqual(overdue.worksheets[0].rows.map(row => row.customerName), ['Khách A', 'Khách A', 'Khách C']);

    // Sap xep theo gia tri GOP (cot "Nợ hiện tại"): C (900) truoc A (300), cac dong co so di cung khach.
    const sorted = await build({ debtQueue: 'currentDebt', debtSort: { columnIndex: 6, direction: 'desc' } });
    assert.deepEqual(sorted.worksheets[0].rows.map(row => [row.customerName, row.branch]), [
      ['Khách C', ''], ['Khách A', HN], ['Khách A', SG]
    ]);
    assert.equal(stubs.calls.rows.length, 0, 'bang cong no khong doc them Postgres');
  });
});

// ---------- Xuat ket qua dut hang quet o "Cả hai" ----------

test('buildExportDataset: ket qua stockout quet o "Cả hai" them cot Co so o dau worksheet', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      branch: 'Cả hai',
      rows: [
        { code: 'SP001', name: 'Ao thun', branch: 'Hà Nội', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, periods: [] },
        { code: 'SP001', name: 'Ao thun', branch: 'Sài Gòn', lastOutOfStockDate: '2026-01-07', daysOutOfStock: 4, periods: [] }
      ]
    }
  });

  assert.equal(dataset.worksheets[0].columns[0].key, 'branch');
  assert.equal(dataset.worksheets[0].columns[0].label, 'Cơ sở');
  assert.deepEqual(dataset.worksheets[0].rows.map(row => row.branch), ['Hà Nội', 'Sài Gòn']);
});

test('buildExportDataset: ket qua stockout quet o mot co so KHONG co cot Co so', async () => {
  const dataset = await exportService.__test__.buildExportDataset({
    tableKey: 'stockout.check90d',
    stockout90dResult: { branch: 'Hà Nội', rows: STOCKOUT_ROWS }
  });

  assert.equal(dataset.worksheets[0].columns.some(column => column.key === 'branch'), false);
});

test('createExportWorkbook: chap nhan truong "branch" khi ket qua stockout quet o "Cả hai"', async () => {
  const file = await exportService.createExportWorkbook({
    tableKey: 'stockout.recentScan',
    recentStockoutResult: {
      branch: 'Cả hai',
      rows: [{ code: 'SP001', name: 'Ao thun', branch: 'Sài Gòn', lastOutOfStockDate: '2026-01-05', daysOutOfStock: 6, periods: [] }]
    },
    columns: { recent_stockout_result: ['branch', 'code', 'name', 'lastOutOfStockDate', 'daysOutOfStock', 'periods'] }
  }, 'Cả hai');

  assert.ok(file.buffer.byteLength > 0);
});

// ---------- Xuat bao cao HTML (renderer thu hai, dung chung tang dataset) ----------

const zlib = require('node:zlib');
const { JSDOM } = require('jsdom');
const exportHtmlReport = require('./exportHtmlReport');

const DEBT_HTML_EXPORT = {
  tableKey: 'debt.management', format: 'html', context: { debtQueue: 'all' },
  columns: { debt_management: ['customerName', 'sale', 'currentDebt', 'overdueDebt', 'currentDebtToSalesRatio', 'workflowStatus'] }
};

/** Doc du lieu nhung (gzip + base64) giong trinh duyet. */
function embeddedData(html) {
  const doc = new JSDOM(html).window.document;
  const node = doc.getElementById('report-data');
  assert.equal(node.getAttribute('data-encoding'), 'gzip-base64');
  return JSON.parse(zlib.gunzipSync(Buffer.from(node.textContent, 'base64')).toString('utf8'));
}

// Mo bao cao trong jsdom; jsdom khong co DecompressionStream/Response nen muon cua Node
// (cung API chuan cua trinh duyet). Cho den khi bang da render xong tu du lieu giai nen.
async function openHtmlReport(file, options = {}) {
  const html = file.buffer.toString('utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(win) {
      win.HTMLCanvasElement.prototype.getContext = () => null; // jsdom khong co canvas
      win.console.error = () => {};
      if (!options.legacyBrowser) {
        win.DecompressionStream = DecompressionStream;
        win.Response = Response;
      }
    }
  });
  const doc = dom.window.document;
  for (let attempt = 0; attempt < 200 && /Đang mở dữ liệu/.test(doc.getElementById('tbody').textContent); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { html, dom, doc };
}

test('createExport: khong gui format -> Excel nhu cu; format sai bi tu choi TRUOC khi cham du lieu', async () => {
  await withStubs({}, async stubs => {
    const xlsx = await exportService.createExport(QUICK_EXPORT, 'Hà Nội');
    assert.match(xlsx.fileName, /^HN_.+\.xlsx$/);
    assert.equal(xlsx.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await assert.rejects(
      exportService.createExport({ ...QUICK_EXPORT, format: 'pdf' }, 'Hà Nội'),
      error => error.statusCode === 400 && error.code === 'EXPORT_FORMAT_INVALID'
    );
    assert.equal(stubs.calls.dashboard.length, 1, 'format sai khong duoc nap du lieu');
  });
});

test('Excel va HTML dung chung getExportDataset: cung cot da chon, cung dong, cung co so', async () => {
  await withStubs({}, async stubs => {
    const dataset = await exportService.getExportDataset(DEBT_HTML_EXPORT, 'Hà Nội');
    assert.deepEqual(dataset.worksheets[0].columns.map(column => column.key), DEBT_HTML_EXPORT.columns.debt_management);
    assert.equal(dataset.worksheets[0].rows.length, 2);
    assert.equal(dataset.meta.branch, 'Hà Nội');

    const file = await exportService.createExport(DEBT_HTML_EXPORT, 'Hà Nội');
    assert.match(file.fileName, /^HN_Quan_ly_cong_no_\d{8}_\d{4}\.html$/);
    assert.equal(file.mimeType, 'text/html; charset=utf-8');
    const embedded = embeddedData(file.buffer.toString('utf8'));
    assert.deepEqual(embedded.worksheets[0].columns.map(column => column.key), DEBT_HTML_EXPORT.columns.debt_management);
    assert.equal(embedded.worksheets[0].rows.length, 2);
    // Cot khong chon (updatedBy) khong duoc lot vao file.
    assert.doesNotMatch(file.buffer.toString('utf8'), /Người cập nhật/);
    assert.deepEqual(stubs.calls.dashboard.map(args => args[1]), ['Hà Nội', 'Hà Nội'], 'dung co so cua req.branch');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('bao cao HTML tu chua: KPI render san, Chart.js inline, khong tai tai nguyen ngoai, co CSP', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExport(DEBT_HTML_EXPORT, 'Sài Gòn');
    const { html, doc } = await openHtmlReport(file);
    assert.doesNotMatch(html, /<script[^>]+src=/i, 'khong script ngoai');
    assert.doesNotMatch(html, /<link[^>]+href=/i, 'khong stylesheet ngoai');
    assert.doesNotMatch(html, /XMLHttpRequest|\/api\//, 'khong goi API sau khi mo');
    assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
    assert.match(html, /Chart\.js v4/, 'thu vien Chart.js nam ngay trong file');
    assert.equal(doc.title, 'Quản lý công nợ · TOKOSI');

    // KPI co trong HTML goc (khong can JS): so dong + tong no hien tai.
    const staticDoc = new JSDOM(html).window.document;
    const kpis = [...staticDoc.querySelectorAll('#kpis .kpi')].map(card => card.textContent);
    assert.ok(kpis.length >= 2 && kpis.length <= 4);
    assert.match(kpis[0], /Số dòng dữ liệu\s*2/);
    assert.ok(kpis.some(text => /Tổng nợ hiện tại/.test(text) && /2,000,000/.test(text)), kpis.join(' | '));

    // Bang render tu du lieu nhung, dinh dang so/phan tram tieng Viet.
    const cells = [...doc.querySelectorAll('#tbody tr')].map(row => [...row.cells].map(cell => cell.textContent));
    assert.equal(cells.length, 2);
    assert.deepEqual(cells[0].slice(0, 5), ['Khách A', 'Lan', '800,000', '500,000', '40%']);
    assert.equal(cells[1][4], '—', 'o trong hien gach ngang');
  });
});

test('bao cao HTML: tim kiem khong dau, loc va sap xep chay hoan toan tren du lieu nhung', async () => {
  await withStubs({}, async () => {
    const file = await exportService.createExport(DEBT_HTML_EXPORT, 'Hà Nội');
    const { dom, doc } = await openHtmlReport(file);
    const win = dom.window;
    const rows = () => [...doc.querySelectorAll('#tbody tr')].map(row => row.cells[0].textContent);
    const input = doc.getElementById('q');
    input.value = 'khach b';
    input.dispatchEvent(new win.Event('input'));
    assert.deepEqual(rows(), ['Khách B']);
    assert.match(doc.getElementById('count').textContent, /Hiển thị 1 \/ 2 dòng/);

    input.value = 'khong co';
    input.dispatchEvent(new win.Event('input'));
    assert.match(doc.getElementById('tbody').textContent, /Không có dòng nào khớp bộ lọc/);

    doc.getElementById('reset').click();
    assert.deepEqual(rows(), ['Khách A', 'Khách B']);
    // Bam tieu de "Nợ hiện tại" -> giam dan (1.200.000 truoc).
    doc.querySelector('#thead button[data-col="2"]').click();
    assert.deepEqual(rows(), ['Khách B', 'Khách A']);
    // Cot phan loai (Sale / Trang thai) duoc dua len bo loc.
    const select = doc.getElementById('category');
    assert.equal(select.hidden, false);
    select.value = [...select.options].find(option => option.value === 'Lan' || option.value === 'Chưa xử lý').value;
    select.dispatchEvent(new win.Event('change'));
    assert.deepEqual(rows(), ['Khách A']);
    win.close();
  });
});

test('bao cao HTML vuot HTML_MAX_CELLS (dong x cot) thi bao loi goi y dung Excel va nha slot', async () => {
  // QUICK_EXPORT chon 1 cot -> so o = so dong.
  const many = Array.from({ length: exportService.HTML_MAX_CELLS + 1 }, (_, index) => ({ code: 'HD' + index, quantity: 1, quantityKnown: true }));
  const dashboard = { ...buildDashboard(), invoices: { transactionsReport: { transactions: many } } };
  await withStubs({ dashboard }, async () => {
    await assert.rejects(
      exportService.createExport({ ...QUICK_EXPORT, format: 'html' }, 'Hà Nội'),
      error => error.statusCode === 413 && error.code === 'EXPORT_HTML_TOO_LARGE' && /Xuất Excel/.test(error.message)
    );
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
    // Excel khong bi gioi han nay.
    const xlsx = await exportService.createExport(QUICK_EXPORT, 'Hà Nội');
    assert.match(xlsx.fileName, /\.xlsx$/);
  });
});

test('bao cao HTML dung chung hang doi voi Excel (khong co hang doi rieng)', async () => {
  const gate = createGate();
  await withStubs({ onDashboard: () => gate.promise }, async () => {
    const jobs = [
      exportService.createExport(QUICK_EXPORT, 'Hà Nội'),
      exportService.createExport({ ...QUICK_EXPORT, format: 'html' }, 'Hà Nội'),
      exportService.createExport({ ...QUICK_EXPORT, format: 'html' }, 'Hà Nội')
    ];
    await tick();
    assert.deepEqual(exportService.__test__.limiterState(), { active: 2, queued: 1 });
    gate.open();
    const files = await Promise.all(jobs);
    assert.deepEqual(files.map(file => file.fileName.split('.').pop()), ['xlsx', 'html', 'html']);
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('du lieu nhung khong the dong the script (chong XSS tu du lieu)', async () => {
  const file = await exportHtmlReport.renderHtmlReport({
    meta: { title: '<img src=x onerror=alert(1)>', branch: 'Hà Nội', generatedAt: new Date(), fileBase: 'HN_X' },
    worksheets: [{ key: 'a', name: 'A', columns: [{ key: 'n', label: '<b>Tên</b>', type: 'text' }], rows: [{ n: '</script><!--' }] }]
  });
  const html = file.buffer.toString('utf8');
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal((html.match(/<\/script>/g) || []).length, 3, 'chi co 3 the script cua chinh bao cao');
  assert.equal(embeddedData(html).worksheets[0].rows[0][0], '</script><!--');
});

test('du lieu nhung duoc nen gzip: nho hon nhieu lan JSON tho va giai nen ra dung du lieu', async () => {
  const rows = Array.from({ length: 20000 }, (_, index) => ({
    code: `SP${index}`, name: `Sản phẩm mẫu số ${index % 500}`, group: ['Áo', 'Quần', 'Mũ'][index % 3], qty: index % 97, amount: (index % 1000) * 1500
  }));
  const columns = [
    { key: 'code', label: 'Mã hàng', type: 'text' }, { key: 'name', label: 'Tên hàng', type: 'text' },
    { key: 'group', label: 'Nhóm hàng', type: 'text' }, { key: 'qty', label: 'Số lượng', type: 'number' },
    { key: 'amount', label: 'Doanh thu', type: 'number' }
  ];
  const file = await exportHtmlReport.renderHtmlReport({
    meta: { title: 'Lớn', branch: 'Hà Nội', generatedAt: new Date(), fileBase: 'HN_L' },
    worksheets: [{ key: 'a', name: 'A', columns, rows }]
  });
  const html = file.buffer.toString('utf8');
  const rawJsonBytes = Buffer.byteLength(JSON.stringify(rows.map(row => columns.map(column => row[column.key]))));
  const embeddedBytes = new JSDOM(html).window.document.getElementById('report-data').textContent.length;
  assert.ok(embeddedBytes * 4 < rawJsonBytes, `nen chua du: ${embeddedBytes} vs ${rawJsonBytes}`);
  const data = embeddedData(html);
  assert.equal(data.worksheets[0].rows.length, 20000);
  assert.deepEqual(data.worksheets[0].rows[19999], ['SP19999', 'Sản phẩm mẫu số 499', 'Quần', 19999 % 97, 999 * 1500]);

  const { dom, doc } = await openHtmlReport(file);
  const input = doc.getElementById('q');
  input.value = 'sp19999 quan';
  input.dispatchEvent(new dom.window.Event('input'));
  assert.match(doc.getElementById('count').textContent, /Hiển thị 1 \/ 20,000 dòng/);
  dom.window.close();
});

test('trinh duyet khong co DecompressionStream thi bao ro thay vi trang trang', async () => {
  const file = await exportHtmlReport.renderHtmlReport({
    meta: { title: 'X', branch: 'Hà Nội', generatedAt: new Date(), fileBase: 'HN_X' },
    worksheets: [{ key: 'a', name: 'A', columns: [{ key: 'n', label: 'Tên', type: 'text' }], rows: [{ n: 'a' }] }]
  });
  const { dom, doc } = await openHtmlReport(file, { legacyBrowser: true });
  assert.match(doc.getElementById('tbody').textContent, /Trình duyệt này quá cũ/);
  dom.window.close();
});

// ---------- Chi tiet ton kho + bo loc thoi gian theo tung bang + KPI HTML theo ky ----------






test('bang co bo loc thoi gian: getDashboardData nhan dung bo loc invoices cua bang do', async () => {
  const filters = { invoices: { mode: 'range', from: '2026-03-01', to: '2026-03-07' } };
  const tableKeys = ['overview.transactions'];
  await withStubs({}, async stubs => {
    for (const tableKey of tableKeys) {
      const metadata = await exportService.getExportFields({ tableKey, filters }, HN);
      const columns = Object.fromEntries(metadata.worksheets.map(worksheet => [worksheet.key, worksheet.fields.map(field => field.key)]));
      await exportService.createExportWorkbook({ tableKey, filters, columns }, HN);
      await exportService.createExportHtml({ tableKey, filters, columns }, HN);
    }
    assert.equal(stubs.calls.dashboard.length, tableKeys.length * 2);
    stubs.calls.dashboard.forEach(([sent]) => {
      Object.keys(filters).forEach(key => assert.deepEqual(sent[key], filters[key], 'bo loc ' + key + ' phai giu nguyen den getDashboardData'));
    });
  });
});

test('debt.penalty: preserves shared reward ranking and searches sale before projecting columns', async () => {
  await withStubs({}, async stubs => {
    const env = fixedEnv(stubs);
    env.dashboard = {
      debtReward: {
        month: '2026-09', status: 'finalized',
        rows: [
          { rank: 1, sale: 'Bình', points: 100, ratio: 0, penaltyDays: 0, lastDayCustomers: 0, total: 0, payablePenalty: 0, reward: 100000 },
          { rank: 2, sale: 'Chi', points: 50, ratio: 1000.6, penaltyDays: 1, lastDayCustomers: 1, total: 50000, payablePenalty: 25000, reward: 50000 },
          { rank: null, sale: 'An', points: 0, ratio: null, penaltyDays: 2, lastDayCustomers: 1, total: 75000, payablePenalty: 75000, reward: 0 }
        ]
      }
    };
    const dataset = await exportService.__test__.buildFixedDataset('debt.penalty', env, {});
    assert.equal(dataset.worksheets[0].rows[1].ratio,1001);
    assert.equal(env.dashboard.debtReward.rows[1].ratio,1000.6);
    assert.deepEqual(dataset.worksheets[0].rows.map(r => [r.rank, r.sale, r.penaltyDays, r.lastDayCustomers, r.total]), [
      [1, 'Bình', 0, 0, 0], [2, 'Chi', 1, 1, 50000], [null, 'An', 2, 1, 75000]
    ]);
    const searched = await exportService.__test__.buildFixedDataset('debt.penalty', env, {}, { mode: 'normal', query: 'chi' }, { debt_penalty: ['rank', 'points', 'reward'] });
    assert.deepEqual(searched.worksheets[0].rows, [{ rank: 2, points: 50, reward: 50000 }]);
  });
});

test('debt.penalty: field selection is query-free and offers reward amounts with null-safe ratio', async () => {
  await withStubs({ onDashboard: () => { throw new Error('field selection queried dashboard'); } }, async () => {
    const fields = await exportService.getExportFields({ tableKey: 'debt.penalty', context: { debtRewardMonth: '2026-09' } }, 'Hà Nội');
    const byKey = new Map(fields.worksheets[0].fields.map(field => [field.key, field]));
    assert.equal(byKey.get('points')?.type, 'number');
    assert.equal(byKey.get('ratio')?.type, 'number');
    assert.equal(byKey.get('total')?.label, 'Phạt gốc');
    assert.equal(byKey.get('payablePenalty')?.label, 'Phạt phải nộp');
    assert.equal(byKey.get('reward')?.label, 'Tiền thưởng');
    assert.equal(byKey.get('rankReward')?.selected, false);
    assert.equal(byKey.get('pointsReward')?.selected, false);
    assert.equal(byKey.get('month')?.label, 'Tháng');
    assert.equal(byKey.get('status')?.label, 'Trạng thái');
  });
});

test('debt.penalty: rejects malformed history month before loading data', async () => {
  await withStubs({ onDashboard: () => { throw new Error('invalid request queried dashboard'); } }, async () => {
    for (const debtRewardMonth of ['2026-13', '2026-00', '26-09', '2026-9', {}, '2026-09-01']) {
      await assert.rejects(exportService.getExportFields({ tableKey: 'debt.penalty', context: { debtRewardMonth } }), error => error.statusCode === 400 && error.code === 'EXPORT_INVALID_REQUEST');
    }
  });
});

test('debt.penalty: HTML displays escaped global reward metadata outside filtered row metrics', async () => {
  const renderer = require('./exportHtmlReport');
  const file = await renderer.renderHtmlReport({
    meta: { title: 'Thưởng/phạt sale theo công nợ', branch: 'Hà Nội', fileBase: 'debt', debtRewardNotes: [
      ['Tháng', '2026-09'], ['Trạng thái', 'Đã chốt'], ['Phạm vi xếp hạng', 'Hà Nội + Sài Gòn'],
      ['Quỹ thưởng toàn hệ thống', '1.000.000đ'], ['Công ty bù', '500.000đ'],
      ['Ngày thiếu bản chốt', '<img src=x onerror=alert(1)>']
    ] },
    worksheets: [{ key: 'debt_penalty', name: 'Thưởng phạt sale', columns: [{ key: 'sale', label: 'Sale', type: 'text' }], rows: [{ sale: 'Chi' }] }]
  });
  const document = new JSDOM(file.buffer.toString('utf8')).window.document;
  const metadata = document.querySelector('header .meta').textContent;
  assert.match(metadata, /2026-09/);
  assert.match(metadata, /Đã chốt/);
  assert.match(metadata, /Hà Nội \+ Sài Gòn/);
  assert.match(metadata, /1\.000\.000đ/);
  assert.match(metadata, /500\.000đ/);
  assert.equal(document.querySelector('header img'), null);
  assert.match(metadata, /<img src=x onerror=alert\(1\)>/);
});

// Replace only the new DB-backed service boundary; export projection/rendering remains real.
async function withRewardService(readBoard, fn) {
  const serviceModule = require('../debtSchedule/debtRewardService');
  const original = serviceModule.getDebtRewardService;
  serviceModule.getDebtRewardService = () => ({ readBoard });
  try { return await fn(); } finally { serviceModule.getDebtRewardService = original; }
}

function historicalRewardBoard() {
  return deepFreeze({
    month: '2026-09', status: 'finalized', closedAt: '2026-10-01T08:00:00Z', ruleVersion: 1,
    months: ['2026-10', '2026-09'], openCycleDate: '2026-10-14', days: [],
    rows: [
      { sale: 'Bình', points: 100, ratio: 0, rank: 1, total: 0, grossPenalty: 0, payablePenalty: 0, rankReward: 700000, pointsReward: 200000, reward: 900000, penaltyDays: 0, lastDayCustomers: 0, branches: ['saigon'], days: [], scoreCustomers: 1 },
      { sale: 'Chi', points: 50, ratio: 1000, rank: 2, total: 50000, grossPenalty: 50000, payablePenalty: 25000, rankReward: 100000, pointsReward: 50000, reward: 150000, penaltyDays: 1, lastDayCustomers: 1, branches: ['hanoi'], days: [], scoreCustomers: 1 },
      { sale: 'An', points: 0, ratio: null, rank: null, total: 75000, grossPenalty: 75000, payablePenalty: 75000, rankReward: 0, pointsReward: 0, reward: 0, penaltyDays: 2, lastDayCustomers: 1, branches: ['hanoi'], days: [], scoreCustomers: 0 }
    ],
    summary: { grossPenalty: 125000, payablePenalty: 100000, pool: 1050000, penaltyFund: 50000, companyTopUp: 1000000, allocatedReward: 1050000, recipientCount: 2 },
    coverage: { from: '2026-09-01', to: '2026-09-30', missingDays: ['2026-09-03'], complete: false }
  });
}

test('debt.penalty: selected historical month and branch use shared board without dashboard or legacy ledger', async () => {
  await withStubs({ onDashboard: () => { throw new Error('legacy dashboard loading'); } }, async () => {
    await withRewardService(async options => {
      assert.deepEqual(options, { month: '2026-09', branches: ['hanoi'] });
      const board = historicalRewardBoard();
      return { ...board, rows: board.rows.filter(row => row.branches.includes('hanoi')) };
    }, async () => {
      const dataset = await exportService.getExportDataset({
        tableKey: 'debt.penalty', context: { debtRewardMonth: '2026-09' }, tableSearch: { mode: 'normal', query: 'chi' },
        columns: { debt_penalty: ['rank', 'points', 'ratio', 'total', 'payablePenalty', 'reward', 'month', 'status'] }
      }, 'Hà Nội');
      assert.deepEqual(dataset.worksheets[0].rows, [{ rank: 2, points: 50, ratio: 1000, total: 50000, payablePenalty: 25000, reward: 150000, month: '2026-09', status: 'Đã chốt' }]);
      assert.equal(dataset.meta.debtReward.month, '2026-09');
      assert.equal(dataset.meta.debtReward.summary.pool, 1050000);
      assert.equal(dataset.meta.debtReward.summary.companyTopUp, 1000000);
      assert.deepEqual(dataset.meta.debtReward.coverage.missingDays, ['2026-09-03']);
      assert.match(dataset.meta.fileBase, /202609/);
    });
  });
});

test('debt.penalty: workbook records global fund and coverage despite sale/branch filtering', async () => {
  await withStubs({ onDashboard: () => { throw new Error('legacy dashboard loading'); } }, async () => {
    await withRewardService(async options => {
      const board = historicalRewardBoard();
      return { ...board, rows: board.rows.filter(row => row.branches.some(branch => options.branches.includes(branch))) };
    }, async () => {
      const file = await exportService.createExportWorkbook({ tableKey: 'debt.penalty', context: { debtRewardMonth: '2026-09' }, tableSearch: { mode: 'normal', query: 'an' }, columns: { debt_penalty: ['rank', 'sale', 'ratio', 'reward'] } }, 'Hà Nội');
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(file.buffer);
      const sheet = workbook.getWorksheet('Thưởng phạt sale');
      assert.deepEqual(sheet.getRow(1).values.slice(1), ['Hạng', 'Sale', 'Phạt/điểm', 'Tiền thưởng']);
      assert.equal(sheet.rowCount, 2);
      assert.equal(sheet.getRow(2).getCell(2).value, 'An');
      assert.equal(sheet.getRow(2).getCell(1).value, null);
      assert.equal(sheet.getRow(2).getCell(3).value, null);
      const metadata = workbook.getWorksheet('Thông tin thưởng phạt');
      assert.ok(metadata, 'Workbook must describe the global pool independently of filtered rows');
      const notes = new Map(metadata.getRows(2, metadata.rowCount - 1).map(row => [row.getCell(1).value, row.getCell(2).value]));
      assert.equal(notes.get('Tháng'), '2026-09');
      assert.equal(notes.get('Trạng thái'), 'Đã chốt');
      assert.equal(notes.get('Phạm vi xếp hạng'), 'Hà Nội + Sài Gòn');
      assert.equal(notes.get('Quỹ thưởng toàn hệ thống'), '1,050,000đ');
      assert.equal(notes.get('Công ty bù'), '1,000,000đ');
      assert.equal(notes.get('Ngày thiếu bản chốt'), '2026-09-03');
    });
  });
});

test('debt.penalty: service errors propagate and release the export slot', async () => {
  const unavailable = Object.assign(new Error('Reward snapshot unavailable'), { statusCode: 503, code: 'DEBT_REWARD_UNAVAILABLE' });
  await withStubs({ onDashboard: () => { throw new Error('legacy dashboard loading'); } }, async () => {
    await withRewardService(async options => {
      assert.deepEqual(options.branches, ['hanoi', 'saigon']);
      throw unavailable;
    }, async () => {
      await assert.rejects(exportService.createExportWorkbook({ tableKey: 'debt.penalty', columns: { debt_penalty: ['sale'] } }), error => error === unavailable);
      assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
    });
  });
});

test('debt.penalty: no debt snapshot rejects with no-data error instead of producing partial results', async () => {
  await withRewardService(async () => ({
    month: null, openCycleDate: null, days: [], rows: [], summary: null, status: 'provisional',
    coverage: { from: null, to: null, missingDays: [], complete: false }, months: [], ruleVersion: 1, closedAt: null
  }), async () => {
    await assert.rejects(exportService.createExportWorkbook({ tableKey: 'debt.penalty', columns: { debt_penalty: ['sale'] } }), error => error.statusCode === 404 && error.code === 'EXPORT_NO_DATA');
    assert.deepEqual(exportService.__test__.limiterState(), { active: 0, queued: 0 });
  });
});

test('debt.penalty: open-month Excel and HTML show numeric provisional rewards with clear status', async () => {
  const finalized = historicalRewardBoard();
  const board = deepFreeze({
    ...finalized, month: '2026-10', status: 'provisional', closedAt: null
  });
  await withRewardService(async () => board, async () => {
    const payload = { tableKey: 'debt.penalty', context: { debtRewardMonth: '2026-10' }, columns: { debt_penalty: ['sale', 'total', 'payablePenalty', 'reward', 'rankReward', 'pointsReward', 'status'] } };
    const excel = await exportService.createExportWorkbook(payload, 'Cả hai');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(excel.buffer);
    const sheet = workbook.getWorksheet('Thưởng phạt sale');
    assert.equal(sheet.getRow(1).getCell(4).value, 'Thưởng tạm tính');
    assert.deepEqual(sheet.getRows(2, 3).map(row => [4, 5, 6].map(column => row.getCell(column).value)), [[900000, 700000, 200000], [150000, 100000, 50000], [0, 0, 0]]);
    assert.equal(sheet.getRow(2).getCell(7).value, 'Thưởng tạm tính');
    assert.equal(sheet.getRow(3).getCell(2).value, 50000);
    const metadata = workbook.getWorksheet('Thông tin thưởng phạt');
    const notes = new Map(metadata.getRows(2, metadata.rowCount - 1).map(row => [row.getCell(1).value, row.getCell(2).value]));
    assert.equal(notes.get('Quỹ thưởng toàn hệ thống'), '1,050,000đ');
    assert.equal(notes.get('Quỹ từ tiền phạt'), '50,000đ');
    assert.equal(notes.get('Công ty bù'), '1,000,000đ');
    assert.equal(notes.get('Tổng thưởng tạm tính'), '1,050,000đ');
    assert.equal(notes.has('Thưởng đã phân bổ'), false);
    assert.equal(notes.get('Số Sale nhận thưởng toàn hệ thống'), '2');
    assert.equal(notes.get('Trạng thái'), 'Thưởng tạm tính');
    assert.equal(notes.get('Tiền thưởng'), 'Thưởng tạm tính, sẽ chốt chính thức vào cuối tháng');
    const html = await exportService.createExportHtml(payload, 'Cả hai');
    const document = new JSDOM(html.buffer.toString('utf8')).window.document;
    assert.match(document.querySelector('header .meta').textContent, /Thưởng tạm tính, sẽ chốt chính thức vào cuối tháng/);
    assert.match(document.querySelector('#kpis').textContent, /thưởng tạm tính1,050,000/i);
    const embedded = embeddedData(html.buffer.toString('utf8')).worksheets[0];
    assert.deepEqual(embedded.rows.map(row => row.slice(3, 6)), [[900000, 700000, 200000], [150000, 100000, 50000], [0, 0, 0]]);
    const opened = await openHtmlReport(html);
    assert.match(opened.doc.querySelector('#tbody').textContent, /Bình/);
    assert.match(opened.doc.querySelector('#kpis').textContent, /thưởng tạm tính1,050,000/i);
    opened.dom.window.close();
  });
});

const DEBT_AGING = {
  available: true, asOfDay: '2026-10-17',
  customers: [
    { branch: 'HN', customerName: 'Anh Bình', sale: 'Duy Thái', paymentSchedule: '5', currentDebt: 600, overdueDebt: 300,
      payoffDay: '2026-10-10', beyondHistory: false, equivalentDays: 7, remainingDays: -2 },
    { branch: 'HN', customerName: 'Chị An', sale: 'Duy Thái', paymentSchedule: '1', currentDebt: 0, overdueDebt: 0,
      payoffDay: null, beyondHistory: false, equivalentDays: null, remainingDays: null },
    { branch: 'SG', customerName: 'Anh Sài', sale: 'Tú Uyên', paymentSchedule: '2', currentDebt: 9000, overdueDebt: 9000,
      payoffDay: '2025-10-18', beyondHistory: true, equivalentDays: 364, remainingDays: -362 }
  ]
};

test('debt.aging: ap bo loc Sale/Lich/Tim + sap xep man hinh, ngay het no dd/mm/yyyy va "Trước" khi vuot lich su', async () => {
  await withStubs({}, async stubs => {
    const env = { ...fixedEnv(stubs), dashboard: { debtAging: DEBT_AGING } };
    const all = await exportService.__test__.buildFixedDataset('debt.aging', env, {});
    assert.deepEqual(all.worksheets[0].rows.map(row => [row.branch, row.customerName, row.payoffDay, row.equivalentDays, row.remainingDays]), [
      ['HN', 'Anh Bình', '10/10/2026', 7, -2], ['HN', 'Chị An', '', null, null], ['SG', 'Anh Sài', 'Trước 18/10/2025', 364, -362]
    ]);
    assert.ok(!('payoffDayKey' in all.worksheets[0].rows[0]), 'khoa sap xep noi bo khong ra file');
    const filtered = await exportService.__test__.buildFixedDataset('debt.aging', env, { debtAgingSale: 'Duy Thái', debtAgingSearch: 'bình' });
    assert.deepEqual(filtered.worksheets[0].rows.map(row => row.customerName), ['Anh Bình']);
    // Cot 6 = Ngay het no: sap theo ngay that, khong theo chuoi dd/mm.
    const sorted = await exportService.__test__.buildFixedDataset('debt.aging', env, { debtAgingSort: { columnIndex: 7, direction: 'asc' } });
    assert.deepEqual(sorted.worksheets[0].rows.map(row => row.customerName), ['Anh Sài', 'Anh Bình', 'Chị An']);
    const remaining = await exportService.__test__.buildFixedDataset('debt.aging', env, { debtAgingSort: { columnIndex: 9, direction: 'asc' } });
    assert.deepEqual(remaining.worksheets[0].rows.map(row => row.customerName), ['Anh Sài', 'Anh Bình', 'Chị An']);
  });
});

test('debt.aging: tao file doc bang tinh san theo co so dang xem', async () => {
  const debtScheduleService = require('../debtSchedule/debtScheduleService');
  const original = debtScheduleService.buildDebtAging;
  const calls = [];
  debtScheduleService.buildDebtAging = async branches => { calls.push(branches); return DEBT_AGING; };
  try {
    await withStubs({}, async () => {
      const file = await exportService.createExportWorkbook({ tableKey: 'debt.aging', context: {}, columns: { debt_aging: ['branch', 'customerName', 'remainingDays'] } }, 'Cả hai');
      assert.deepEqual(calls, [['hanoi', 'saigon']]);
      const worksheet = (await loadWorkbook(file)).worksheets[0];
      assert.equal(worksheet.getCell('A1').value, 'Cơ sở');
      assert.equal(worksheet.rowCount, 4);
    });
  } finally {
    debtScheduleService.buildDebtAging = original;
  }
});


test('debt exports include live team and apply team filters before projecting columns', async () => {
  await withStubs({}, async stubs => {
    const env = fixedEnv(stubs);
    const rows = [{sale: 'An', saleTeam: 'Team A', customerName: 'A', currentDebt: 10, overdueDebt: 5},
      {sale: 'Bình', saleTeam: 'Team B', customerName: 'B', currentDebt: 20, overdueDebt: 2}];
    env.dashboard = {debtManagement: {customers: rows}, debtAging: {customers: rows}, debtReward: {rows, month:'2026-10'}};
    for (const [key, context] of [['debt.management', {debtQueue:'all', debtTeam:'Team A'}],
      ['debt.aging', {debtAgingTeam:'Team A'}], ['debt.penalty', {debtPenaltyTeam:'Team A'}]]) {
      const dataset = await exportService.__test__.buildFixedDataset(key, env, context);
      assert.ok(dataset.worksheets[0].columns.some(c => c.key === 'saleTeam'));
      assert.deepEqual(dataset.worksheets[0].rows.map(r => r.saleTeam), ['Team A']);
    }
  });
});


test('HTML summarizes debt by sale team, including a single team and zero amounts', () => {
  const kit = require('./exportHtmlReport').__test__.createReportKit();
  const columns = [{key:'saleTeam',label:'Nhóm sale',type:'text'},
    {key:'currentDebt',label:'Nợ hiện tại',type:'number'}, {key:'overdueDebt',label:'Nợ quá hạn',type:'number'}];
  const summary = kit.buildSummary(columns, [['Team A',10,2],['Team A',20,3],['Team B',5,0]]);
  const chart = summary.charts.find(c => c.id === 'saleTeam-currentDebt');
  assert.ok(chart);
  assert.deepEqual(chart.labels, ['Team A','Team B']);
  assert.deepEqual(chart.values, [30,5]);
  assert.ok(kit.buildSummary(columns, [['Team A',0,0]]).charts.some(c => c.id === 'saleTeam-overdueDebt'));
});


test('Excel and HTML export the filtered team and HTML displays team charts', async () => {
  await withStubs({}, async () => withRewardService(async () => {
    const board = historicalRewardBoard();
    return {...board, rows: board.rows.map((r, i) => ({...r, saleTeam: i === 0 ? 'Team A' : 'Team B'}))};
  }, async () => {
    const request = {tableKey:'debt.penalty', context:{debtRewardMonth:'2026-09', debtPenaltyTeam:'Team A'},
      columns:{debt_penalty:['sale','saleTeam','payablePenalty','reward']}};
    const excel = await exportService.createExportWorkbook(request, 'Cả hai');
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(excel.buffer);
    const sheet = workbook.getWorksheet('Thưởng phạt sale');
    assert.equal(sheet.getCell('B1').value, 'Nhóm sale');
    assert.equal(sheet.getCell('B2').value, 'Team A');
    assert.equal(sheet.rowCount, 2);
    const html = await exportService.createExportHtml(request, 'Cả hai');
    const embedded = embeddedData(html.buffer.toString('utf8')).worksheets[0];
    assert.deepEqual(embedded.rows.map(r => r[1]), ['Team A']);
    const opened = await openHtmlReport(html);
    try { assert.match(opened.doc.getElementById('charts').textContent, /theo nhóm sale/); }
    finally { opened.dom.window.close(); }
  }));
});
