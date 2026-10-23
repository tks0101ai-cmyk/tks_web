'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const ExcelJS = require('exceljs');
const svc = require('./businessReportService');
const { createExportFile, filterRows, exportFieldsFor, resolveColumnKeys, MAX_EXPORT_ROWS } = require('./businessReportExport');
const { serviceSnapshot } = require('./testFixtures');

function customerRows() {
  return svc.buildCustomerReport(serviceSnapshot()).rows;
}

test('profile-filtered export uses the same fuzzy word matching as the customer table', () => {
  const rows=[{name:'Chị Hoa Hà Nội',saleName:'Mai',active:true,salesChannels:['san'],warehouseScale:'large',
    priceLevel:'vip',refs:[{branch:'hanoi',code:'KH123'}],series:{'2026-10-01':87654},warehouseLocation:'Kho bí mật',editors:[{userName:'Người ẩn'}]}];
  assert.equal(filterRows('customers',rows,{q:'noi hoa',salesChannel:'san',warehouseScale:'large'}).length,1);
  assert.equal(filterRows('customers',rows,{q:'hoa noi sai',salesChannel:'san'}).length,1);
  for (const q of ['vip','KH123','87654']) assert.equal(filterRows('customers',rows,{q}).length,1,q);
  for (const q of ['bí mật','Người ẩn']) assert.equal(filterRows('customers',rows,{q}).length,0,q);
});

test('customer profile filters use contains, empty defaults and AND with other filters', () => {
  const rows = [
    { key: 'a', name: 'Chị A', active: true, saleName: 'Mai', priceLevel: 'VIP', salesChannels: ['san', 'khac'], warehouseScale: 'large' },
    { key: 'b', name: 'Chị B', active: true, saleName: 'Mai', priceLevel: 'VIP', salesChannels: ['khac'], warehouseScale: 'large' },
    { key: 'c', active: true }, { key: 'd', active: false, salesChannels: [], warehouseScale: 'none' }
  ];
  assert.deepEqual(filterRows('customers', rows, { salesChannel: 'san', warehouseScale: 'large', sale: 'Mai', level: 'VIP', q: 'chi' }).map(r => r.key), ['a']);
  assert.deepEqual(filterRows('customers', rows, { salesChannel: 'san', warehouseScale: 'small' }), []);
  assert.deepEqual(filterRows('customers', rows, { warehouseScale: 'none' }).map(r => r.key), ['c']);
  assert.deepEqual(filterRows('customers', rows, { salesChannel: 'none', warehouseScale: 'none' }).map(r => r.key), ['c']);
  assert.deepEqual(filterRows('customers', rows, { salesChannel: 'none', warehouseScale: 'none', inactive: '1' }).map(r => r.key), ['c', 'd']);
  assert.equal(filterRows('products', rows, { salesChannel: 'san', warehouseScale: 'small' }).length, 4);
});

test('profile export fields require profile permission and format labels, dates, URLs and safe text', async () => {
  const base = svc.buildCustomerReport(serviceSnapshot());
  assert.throws(() => resolveColumnKeys('customers', base, 'salesChannels'), { code: 'INVALID_COLUMNS' });
  const report = { ...base, withCustomerProfile: true, withLastVisit: true };
  const keys = ['warehouseLocation', 'warehouseCount', 'area', 'competitor', 'salesChannels', 'warehouseScale', 'editors', 'visitDays', 'images'];
  const fields = exportFieldsFor('customers', report, []).worksheets[0].fields;
  assert.ok(keys.every(key => fields.some(f => f.key === key)));
  assert.ok(!fields.some(f => f.key === 'notes'));
  assert.ok(!exportFieldsFor('sales', report, []).worksheets[0].fields.some(f => keys.includes(f.key)));
  const rows = [{ warehouseLocation: '=CMD()', warehouseCount: 2, area: '200m2', competitor: 'X', salesChannels: ['san', 'fb_ads', 'khac'], warehouseScale: 'very_large', editors: [{ userId: '1', userName: 'Mai' }, { userId: '2', userName: 'Hoa' }], visitDays: ['2026-10-01', '2026-10-02'], images: [{ url: 'https://tks.test/api/images/1' }, 'https://tks.test/api/images/2'], notes: ['PRIVATE'] }, {}];
  const file = await createExportFile('customers', 'xlsx', report, rows, keys);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const sheet = wb.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Định vị kho', 'Số lượng kho', 'Diện tích', 'Đối thủ', 'Hình thức bán hàng', 'Quy mô khách', 'Người được sửa', 'Các ngày tiếp khách', 'Ảnh kho']);
  assert.deepEqual(sheet.getRow(2).values.slice(1), ["'=CMD()", 2, '200m2', 'X', 'Bán sàn, FB ads, Khác', 'Rất to', 'Mai, Hoa', '01/10/2026, 02/10/2026', 'https://tks.test/api/images/1\nhttps://tks.test/api/images/2']);
  assert.ok(sheet.getRow(3).getCell(2).value == null || sheet.getRow(3).getCell(2).value === '');
  assert.equal(sheet.getRow(3).getCell(6).value, 'Chưa có');
  const html = await createExportFile('customers', 'html', report, rows, keys);
  const b64 = /<script type="application\/octet-stream" id="report-data"[^>]*>([^<]*)<\/script>/.exec(html.buffer.toString())[1];
  const ws = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64'))).worksheets[0];
  assert.equal(ws.rows[0][4], 'Bán sàn, FB ads, Khác');
  assert.equal(ws.rows[0][7], '01/10/2026, 02/10/2026');
});

test('filterRows khach: mac dinh chi giu khach hoat dong, inactive=1 giu tat ca', () => {
  const rows = customerRows();
  const active = filterRows('customers', rows, {});
  assert.ok(active.length > 0 && active.every(r => r.active));
  assert.ok(active.length < rows.length);
  assert.equal(filterRows('customers', rows, { inactive: '1' }).length, rows.length);
});

test('filterRows: loc theo sale va tim khong dau trong ten', () => {
  const rows = customerRows();
  assert.deepEqual(filterRows('customers', rows, { sale: 'Khang' }).map(r => r.key).sort(), ['anh b', 'chị a']);
  assert.deepEqual(filterRows('customers', rows, { q: 'chi a' }).map(r => r.key), ['chị a']);
  assert.deepEqual(filterRows('customers', rows, { q: 'anh', sale: 'Khang' }).map(r => r.key), ['anh b']);
});

test('filterRows bang sale: loc theo team, ket hop voi tim kiem', () => {
  const rows = svc.buildSaleReport(serviceSnapshot()).rows;
  assert.deepEqual(filterRows('sales', rows, { team: 'Team Khang' }).map(r => r.saleName), ['Khang']);
  assert.deepEqual(filterRows('sales', rows, { team: 'Chưa có team' }).map(r => r.saleName), ['Chưa phân nhóm']);
  assert.deepEqual(filterRows('sales', rows, { team: 'Team Khang', q: 'trinh' }), []);
  assert.deepEqual(filterRows('sales', rows, { team: '' }).length, rows.length);
});

test('XLSX bang sale: tieu de co dinh, thang giam dan (bo thang hien tai), tang truong null ghi "—", chan cong thuc', async () => {
  const report = svc.buildSaleReport(serviceSnapshot());
  const rows = report.rows.map(r => ({ ...r }));
  rows[0].saleName = '=CMD()';
  const file = await createExportFile('sales', 'xlsx', report, rows);
  assert.equal(file.fileName, 'TKS_Bao_cao_kinh_doanh_sales.xlsx');
  assert.match(file.mimeType, /spreadsheetml/);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const sh = wb.worksheets[0];
  assert.deepEqual(sh.getRow(1).values.slice(1),
    ['Sale', 'Team', 'SL Khách', 'TB 4 tháng', 'Tăng trưởng', 'Tháng hiện tại (đến 06/10)', 'T9/26', 'T8/26', 'T7/26']);
  assert.equal(sh.getCell('A2').value, "'=CMD()");
  const growthIdx = 5;
  const cells = rows.map((r, i) => sh.getRow(i + 2).getCell(growthIdx).value);
  rows.forEach((r, i) => {
    if (r.growth == null) assert.equal(cells[i], '—');
    else assert.equal(cells[i], r.growth / 100);
  });
  assert.ok(rows.some(r => r.growth == null) && rows.some(r => r.growth != null));
  assert.equal(sh.getCell('E2').numFmt, '0%');
  assert.ok(sh.views[0].state === 'frozen');
});

test('XLSX bang khach da gop theo ten: khong co cot ma KH / co so, co level gia; thang chua co so lieu ghi 0', async () => {
  const report = svc.buildCustomerReport(serviceSnapshot());
  const file = await createExportFile('customers', 'xlsx', report, filterRows('customers', report.rows, { inactive: '1' }));
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const sh = wb.worksheets[0];
  assert.deepEqual(sh.getRow(1).values.slice(1, 4), ['Tên khách', 'Sale', 'Level giá']);
  const a = [2, 3, 4, 5].map(i => sh.getRow(i).values.slice(1)).find(v => v[0] === 'Chị A');
  assert.ok(a);
  assert.equal(a[2], 'Level 2');
});

test('HTML bang ma hang la dashboard dung chung bo dung (co DOCTYPE + Chart + du lieu nhung)', async () => {
  const report = svc.buildProductReport(serviceSnapshot());
  const file = await createExportFile('products', 'html', report, report.rows);
  assert.equal(file.fileName, 'TKS_Bao_cao_kinh_doanh_products.html');
  assert.match(file.mimeType, /text\/html/);
  const html = file.buffer.toString();
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.ok(html.includes('Chart'));
  const b64 = /<script type="application\/octet-stream" id="report-data"[^>]*>([^<]*)<\/script>/.exec(html)[1];
  const ws = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64'))).worksheets[0];
  assert.deepEqual(ws.columns.slice(0, 2).map(c => c.label), ['Mã hàng', 'Tên hàng']);
  assert.equal(ws.rows[0][0], 'SP1');
});

test('xuat qua gioi han 20.000 dong, dinh dang/loai bang khong hop le thi bao loi 400', async () => {
  const report = svc.buildProductReport(serviceSnapshot());
  const many = Array.from({ length: MAX_EXPORT_ROWS + 1 }, () => report.rows[0]);
  await assert.rejects(() => createExportFile('products', 'xlsx', report, many), e => e.statusCode === 400 && e.code === 'TOO_MANY_ROWS');
  await assert.rejects(() => createExportFile('products', 'pdf', report, []), e => e.statusCode === 400);
  await assert.rejects(() => createExportFile('nope', 'xlsx', report, []), e => e.statusCode === 400);
});

test('exportFieldsFor: danh sach truong cho hop thoai Xuat file = dung cac cot cua file, mac dinh chon het, co so dong', () => {
  const report = svc.buildSaleReport(serviceSnapshot());
  const meta = exportFieldsFor('sales', report, report.rows);
  assert.equal(meta.selectionMode, 'custom');
  assert.match(meta.title, /Sale/);
  assert.equal(meta.worksheets.length, 1);
  const ws = meta.worksheets[0];
  assert.equal(ws.key, 'sales');
  assert.equal(ws.rowCount, report.rows.length);
  assert.deepEqual(ws.fields.map(f => f.key),
    ['saleName', 'team', 'activeCustomers', 'avg4', 'growth', 'current', 'm_2026_09', 'm_2026_08', 'm_2026_07']);
  assert.deepEqual(ws.fields.map(f => f.label),
    ['Sale', 'Team', 'SL Khách', 'TB 4 tháng', 'Tăng trưởng', 'Tháng hiện tại (đến 06/10)', 'T9/26', 'T8/26', 'T7/26']);
  assert.ok(ws.fields.every(f => f.selected === true));
  const customers = svc.buildCustomerReport(serviceSnapshot());
  assert.deepEqual(exportFieldsFor('customers', customers, []).worksheets[0].fields.slice(0, 3).map(f => f.key),
    ['name', 'saleName', 'priceLevel']);
  assert.throws(() => exportFieldsFor('nope', report, []), e => e.statusCode === 400);
});

test('resolveColumnKeys: khong truyen = tat ca; danh sach rong / khoa la / dang object => 400; giu thu tu chuan, bo trung', () => {
  const report = svc.buildSaleReport(serviceSnapshot());
  assert.equal(resolveColumnKeys('sales', report, undefined), null);
  assert.deepEqual(resolveColumnKeys('sales', report, 'm_2026_09,saleName,saleName, avg4'), ['saleName', 'avg4', 'm_2026_09']);
  assert.deepEqual(resolveColumnKeys('sales', report, ['current', 'saleName']), ['saleName', 'current']);
  const bad = e => e.statusCode === 400 && e.code === 'INVALID_COLUMNS';
  assert.throws(() => resolveColumnKeys('sales', report, ''), bad);
  assert.throws(() => resolveColumnKeys('sales', report, ' , '), bad);
  assert.throws(() => resolveColumnKeys('sales', report, 'saleName,code'), bad);
  assert.throws(() => resolveColumnKeys('sales', report, 'saleName;DROP TABLE x'), bad);
  assert.throws(() => resolveColumnKeys('sales', report, { a: 'saleName' }), bad);
});

test('XLSX/HTML chi chua cac cot da chon (thu tu chuan)', async () => {
  const report = svc.buildSaleReport(serviceSnapshot());
  const file = await createExportFile('sales', 'xlsx', report, report.rows, ['saleName', 'current', 'm_2026_08']);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer);
  const sh = wb.worksheets[0];
  assert.deepEqual(sh.getRow(1).values.slice(1), ['Sale', 'Tháng hiện tại (đến 06/10)', 'T8/26']);
  const khang = report.rows.find(r => r.saleName === 'Khang');
  const row = [...Array(report.rows.length).keys()].map(i => sh.getRow(i + 2).values.slice(1)).find(v => v[0] === 'Khang');
  assert.deepEqual(row, ['Khang', khang.current, khang.series['2026-08-01'] || 0]);

  const products = svc.buildProductReport(serviceSnapshot());
  const html = (await createExportFile('products', 'html', products, products.rows, ['code', 'avg4'])).buffer.toString();
  const b64 = /<script type="application\/octet-stream" id="report-data"[^>]*>([^<]*)<\/script>/.exec(html)[1];
  const ws = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64'))).worksheets[0];
  assert.deepEqual(ws.columns.map(c => c.key), ['code', 'avg4']);
  assert.ok(html.includes('Chart'), 'HTML van co bieu do');
});

test('filterRows: chi bang khach an dong khong hoat dong mac dinh; bang sale va ma hang giu het (khop man hinh)', () => {
  const inactive = { key: 'x', code: 'X', name: 'Cu', saleName: 'Trinh', active: false };
  const live = { key: 'y', code: 'Y', name: 'Moi', saleName: 'Khang', active: true };
  for (const kind of ['sales', 'products']) {
    assert.equal(filterRows(kind, [inactive, live], {}).length, 2, kind);
  }
  assert.deepEqual(filterRows('customers', [inactive, live], {}).map(r => r.key), ['y']);
  assert.equal(filterRows('customers', [inactive, live], { inactive: '1' }).length, 2);
  // Ca bang khach lan sale/ma hang van ap bo loc tim kiem / sale.
  assert.deepEqual(filterRows('products', [inactive, live], { q: 'cu' }).map(r => r.key), ['x']);
});

test('cot Tiep khach lan cuoi (customers): chi co khi report.withLastVisit, dd/mm/yyyy, HTML + XLSX, khoa la bi chan khi tat', async () => {
  const base = svc.buildCustomerReport(serviceSnapshot());
  assert.ok(!exportFieldsFor('customers', base, base.rows).worksheets[0].fields.some(f => f.key === 'lastVisit'));
  assert.throws(() => resolveColumnKeys('customers', base, 'lastVisit'), { code: 'INVALID_COLUMNS' });
  assert.ok(!exportFieldsFor('sales', { ...svc.buildSaleReport(serviceSnapshot()), withLastVisit: true }, []).worksheets[0].fields.some(f => f.key === 'lastVisit'));

  const report = { ...base, withLastVisit: true };
  const rows = base.rows.map((r, i) => ({ ...r, lastVisit: i === 0 ? '2026-10-05' : '' }));
  const fields = exportFieldsFor('customers', report, rows).worksheets[0].fields;
  assert.deepEqual(fields.slice(0, 4).map(f => f.label), ['Tên khách', 'Sale', 'Level giá', 'Tiếp khách lần cuối']);
  assert.deepEqual(resolveColumnKeys('customers', report, 'lastVisit,name'), ['name', 'lastVisit']);

  const xlsx = await createExportFile('customers', 'xlsx', report, rows, ['name', 'lastVisit']);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(xlsx.buffer);
  const sheet = wb.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values.slice(1), ['Tên khách', 'Tiếp khách lần cuối']);
  assert.equal(sheet.getRow(2).getCell(2).value, '05/10/2026');
  assert.ok(sheet.getRow(3).getCell(2).value === null || sheet.getRow(3).getCell(2).value === '');

  const html = await createExportFile('customers', 'html', report, rows, ['name', 'lastVisit']);
  const b64 = /<script type="application\/octet-stream" id="report-data"[^>]*>([^<]*)<\/script>/.exec(html.buffer.toString())[1];
  const ws = JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64'))).worksheets[0];
  assert.deepEqual(ws.columns.map(c => c.label), ['Tên khách', 'Tiếp khách lần cuối']);
  assert.equal(ws.rows[0][1], '05/10/2026');
});
