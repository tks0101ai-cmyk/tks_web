'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { PGlite } = require('@electric-sql/pglite');
const { parseWorksheet, readExcelUpload, normalizeRow, plan, runProfileImport } = require('./customerProfileExcelImport');

const migDir = path.join(__dirname, '../db/migrations');
async function setup() {
  const db = new PGlite();
  for (const prefix of ['0080', '0084', '0090']) {
    const f = fs.readdirSync(migDir).find(x => x.startsWith(prefix));
    await db.exec(fs.readFileSync(path.join(migDir, f), 'utf8'));
  }
  const pool = { query: (q, p) => db.query(q, p) };
  return { db, pool };
}
async function workbookBuffer(header, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Theo khách hàng');
  ws.addRow(header);
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const ACTOR = { id: 7, name: 'Quản lý' };
const FULL = ['Tên khách', 'Điện thoại', 'Địa chỉ', 'Định vị kho', 'Số lượng kho', 'Diện tích', 'Đối thủ', 'Hình thức bán hàng', 'Quy mô khách'];

test('doc file theo ten cot: bo dau nhay dau o, nhan nhan hinh thuc/quy mo, thieu cot Ten khach thi bao loi', async () => {
  const buf = await workbookBuffer([...FULL, 'Cột lạ'], [
    ['Chị A', "'+84333167945", ' 5 Lê Lợi ', 'Kho 1', 3, '200m2', 'Tem X', 'Bán sàn, Kho buôn', 'Rất to', 'x'],
    ['', '0900', '', '', '', '', '', '', '', '']
  ]);
  const { rows, columns } = await readExcelUpload(buf);
  assert.equal(rows.length, 1);
  assert.deepEqual(columns, ['phone', 'address', 'warehouseLocation', 'warehouseCount', 'area', 'competitor', 'salesChannels', 'warehouseScale']);
  assert.deepEqual(normalizeRow(rows[0], columns), {
    phone: '+84333167945', address: '5 Lê Lợi', warehouseLocation: 'Kho 1', area: '200m2', competitor: 'Tem X', warehouseCount: 3,
    salesChannels: ['san', 'kho_buon'], warehouseScale: 'very_large'
  });
  await assert.rejects(readExcelUpload(await workbookBuffer(['Điện thoại'], [['0900']])), { code: 'IMPORT_NO_NAME_COLUMN' });
  await assert.rejects(readExcelUpload(await workbookBuffer(['Tên khách', 'Sale'], [['A', 'B']])), { code: 'IMPORT_NO_INFO_COLUMNS' });
  assert.throws(() => normalizeRow({ salesChannels: 'Không biết' }, ['salesChannels']), { statusCode: 400 });
  assert.throws(() => normalizeRow({ warehouseScale: 'Khổng lồ' }, ['warehouseScale']), { statusCode: 400 });
  assert.throws(() => normalizeRow({ warehouseCount: '-2' }, ['warehouseCount']), { statusCode: 400 });
});

test('plan: fill chi dien o trong, overwrite ghi de, o trong trong file khong xoa, khach la bi bo, dong sai bi loai', () => {
  const columns = ['phone', 'address', 'salesChannels', 'warehouseScale', 'warehouseCount'];
  const validKeys = new Set(['a', 'b', 'c']);
  const existing = new Map([['a', { phone: '0901', address: '', warehouseCount: 2, salesChannels: ['san'], warehouseScale: 'small', warehouseLocation: '', area: '', competitor: '' }]]);
  const rows = [
    { rowNumber: 2, name: 'A', phone: '0999', address: 'HN', salesChannels: 'Kho buôn', warehouseScale: 'Vừa', warehouseCount: 5 },
    { rowNumber: 3, name: 'B', phone: '', address: '', salesChannels: '', warehouseScale: 'Chưa có', warehouseCount: null },
    { rowNumber: 4, name: 'Lạ', phone: '1' },
    { rowNumber: 5, name: 'C', phone: '1', address: '', salesChannels: 'Sai kênh', warehouseScale: '', warehouseCount: null }
  ];
  const fill = plan({ rows, columns, validKeys, existing, mode: 'fill' });
  assert.deepEqual(fill.changes.map(c => [c.name, c.fields.map(f => f.field)]), [['A', ['address']]]);
  assert.equal(fill.unchanged, 1); // B: toan o trong
  assert.deepEqual([fill.unmatched, fill.invalid.length], [['Lạ'], 1]);
  const over = plan({ rows, columns, validKeys, existing, mode: 'overwrite' });
  assert.deepEqual(over.changes[0].fields.map(f => [f.field, f.from, f.to]), [
    ['phone', '0901', '0999'], ['address', '', 'HN'], ['salesChannels', 'Bán sàn', 'Kho buôn'], ['warehouseScale', 'Nhỏ', 'Vừa'], ['warehouseCount', '2', '5']
  ]);
});

test('runProfileImport: xem truoc khong ghi; fill khong de len du lieu tay; overwrite ghi de nhung o trong khong xoa; chay lai khong doi', async () => {
  const { db, pool } = await setup();
  try {
    await db.query(`INSERT INTO customer_profiles(customer_key, customer_name, phone, address, area, warehouse_scale, sales_channels)
      VALUES ('chị a', 'Chị A', '0901', '', '100m2', 'small', '{san}')`);
    const parsed = await readExcelUpload(await workbookBuffer(FULL, [
      ['Chị A', '0999', '5 Lê Lợi', 'Kho 1', 4, '', 'Tem X', 'Kho buôn', 'Vừa'],
      ['Anh B', '0888', '', '', '', '', '', '', ''],
      ['Lạ hoắc', '1', '', '', '', '', '', '', '']
    ]));
    const base = { rows: parsed.rows, columns: parsed.columns, validKeys: new Set(['chị a', 'anh b']), pool, actor: ACTOR };
    const prev = await runProfileImport({ ...base, apply: false });
    assert.deepEqual([prev.mode, prev.matched, prev.wouldChange, prev.unmatched], ['preview', 2, 2, 1]);
    assert.equal((await db.query('SELECT count(*)::int n FROM customer_profiles')).rows[0].n, 1);

    const filled = await runProfileImport({ ...base, apply: true });
    assert.equal(filled.changed, 2);
    const a = (await db.query("SELECT * FROM customer_profiles WHERE customer_key = 'chị a'")).rows[0];
    assert.deepEqual([a.phone, a.address, a.warehouse_location, Number(a.warehouse_count), a.area, a.competitor, a.sales_channels, a.warehouse_scale, a.updated_by_id, a.updated_by_name],
      ['0901', '5 Lê Lợi', 'Kho 1', 4, '100m2', 'Tem X', ['san'], 'small', '7', 'Quản lý']);
    const b = (await db.query("SELECT customer_name, phone FROM customer_profiles WHERE customer_key = 'anh b'")).rows[0];
    assert.deepEqual(b, { customer_name: 'Anh B', phone: '0888' });
    assert.equal((await runProfileImport({ ...base, apply: false })).wouldChange, 0);

    const over = await runProfileImport({ ...base, apply: true, mode: 'overwrite' });
    assert.equal(over.changed, 1);
    const a2 = (await db.query("SELECT phone, area, sales_channels, warehouse_scale FROM customer_profiles WHERE customer_key = 'chị a'")).rows[0];
    assert.deepEqual(a2, { phone: '0999', area: '100m2', sales_channels: ['kho_buon'], warehouse_scale: 'medium' });
    assert.equal((await runProfileImport({ ...base, apply: false, mode: 'overwrite' })).wouldChange, 0);
    await assert.rejects(runProfileImport({ ...base, mode: 'x' }), { statusCode: 400 });
  } finally { await db.close(); }
});

test('runProfileImport: thieu bang => 503 MIGRATION_PENDING', async () => {
  const pool = { query: async () => { const e = new Error('no table'); e.code = '42P01'; throw e; } };
  await assert.rejects(runProfileImport({ rows: [{ name: 'A' }], columns: ['phone'], validKeys: new Set(['a']), pool }), { statusCode: 503, code: 'MIGRATION_PENDING' });
});

test('parseWorksheet duoc xuat tu ExcelJS: dong trang bi bo', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('x');
  ws.addRow(['Tên khách', 'Địa chỉ']);
  ws.addRow(['A', 'HN']);
  ws.addRow([null, 'bo']);
  assert.equal(parseWorksheet(ws).rows.length, 1);
});
