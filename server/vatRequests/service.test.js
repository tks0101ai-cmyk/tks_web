'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const registry = require('../auth/featureRegistry');
const { ROLES } = require('../auth/userRepository');
const { createVatRequestService } = require('./service');
const { parseStockRecords, parseMappingRecords, defaultStockConfig, createStockSource } = require('./stockSource');
const { parseCsv } = require('../vatDraft/csv');

const MIGRATIONS = ['0018_product_report.sql', '0053_product_containers.sql', '0076_vat_requests.sql', '0079_vat_request_sort_rank.sql', '0083_vat_request_status_vat_ready.sql'];

function poolFor(db) {
  const query = (sql, params) => db.query(sql, params);
  return { query, connect: async () => ({ query, release() {} }) };
}

async function fixture({ stock, migrations = MIGRATIONS } = {}) {
  const db = new PGlite();
  for (const file of migrations) await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  await db.exec(`INSERT INTO product_report(product_code, product_name) VALUES ('014XOAN', 'Bát inox 2 lớp XOẮN 14cm'), ('26DAQUAN', 'Đồng hồ treo tường DẠ QUANG')`);
  const stockSource = { get: async () => { if (!stock) throw new Error('Sheet không còn chia sẻ công khai'); return stock; } };
  const service = createVatRequestService({ pool: poolFor(db), stockSource, now: () => new Date('2026-10-20T03:00:00Z') });
  return { db, service };
}

function user(id, vaiTro, extra = {}) {
  const base = { id, username: id, hoTen: `Tên ${id}`, email: `${id}@x.vn`, vaiTro, trangThai: 'Đang hoạt động', ...extra };
  return { ...base, permissions: registry.resolvePermissions(base) };
}
const SALE = user('sale-1', ROLES.NHAN_VIEN_SALE);
const SALE2 = user('sale-2', ROLES.NHAN_VIEN_SALE);
const KT = user('kt-1', ROLES.KE_TOAN, { featurePermissions: { 'accounting.vatRequestProcess': true } });
const KT_UNGRANTED = user('kt-2', ROLES.KE_TOAN);
const QL = user('ql-1', ROLES.QUAN_LY);

const NEW_REQUEST = { customerName: 'KH A Thắng Thanh Trì', productCode: '014xoan', quantity: 400, unitPrice: 11400, fullVat: true, saleNote: '' };

async function setStatus(db, id, status) {
  await db.query('UPDATE vat_requests SET status = $2, version = version + 1 WHERE id = $1', [id, status]);
  const { rows } = await db.query('SELECT version FROM vat_requests WHERE id = $1', [id]);
  return rows[0].version;
}

test('sale tao yeu cau: he thong gan nguoi tao, status pending, version 1, ma SP chuan theo product_report', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    assert.equal(row.createdBy, 'sale-1');
    assert.equal(row.createdByName, 'Tên sale-1');
    assert.equal(row.status, 'pending');
    assert.equal(row.version, 1);
    assert.equal(row.productCode, '014XOAN');
    assert.equal(row.productName, 'Bát inox 2 lớp XOẮN 14cm');
    assert.equal(row.totalAmount, 4560000);
    assert.equal(row.fullVat, true);
    assert.equal(row.isLockedForSale, false);
    assert.equal(row.canEditSale, true);
    const history = await service.history(SALE, row.id);
    assert.deepEqual(history.map(h => h.action), ['create']);
  } finally { await db.close(); }
});

test('payload co created_by / status / truong la khi tao -> 403, khong tao dong nao', async () => {
  const { db, service } = await fixture();
  try {
    await assert.rejects(service.create(SALE, { ...NEW_REQUEST, createdBy: 'kt-1' }), { statusCode: 403, code: 'FIELD_FORBIDDEN' });
    await assert.rejects(service.create(SALE, { ...NEW_REQUEST, status: '1' }), { statusCode: 403, code: 'FIELD_FORBIDDEN' });
    await assert.rejects(service.create(SALE, { ...NEW_REQUEST, quantity: 0 }), { statusCode: 400 });
    await assert.rejects(service.create(SALE, { ...NEW_REQUEST, quantity: 1.5 }), { statusCode: 400 });
    await assert.rejects(service.create(SALE, { ...NEW_REQUEST, productCode: 'KHONGCO' }), { statusCode: 400, code: 'PRODUCT_NOT_FOUND' });
    await assert.rejects(service.create(SALE, { productCode: '014XOAN', quantity: 1, unitPrice: 1 }), { statusCode: 400 });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM vat_requests');
    assert.equal(rows[0].n, 0);
  } finally { await db.close(); }
});

test('sale sua yeu cau cua sale khac -> 403', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    await assert.rejects(service.update(SALE2, row.id, { version: 1, quantity: 10 }), { statusCode: 403, code: 'NOT_OWNER' });
    await assert.rejects(service.remove(SALE2, row.id, 1), { statusCode: 403, code: 'NOT_OWNER' });
  } finally { await db.close(); }
});

test('sale bi khoa o 0/1/2, sua duoc o pending/3/4; sua o 3/4 tu ve pending', async () => {
  const { db, service } = await fixture();
  try {
    for (const status of ['0', '1', '2']) {
      const row = await service.create(SALE, NEW_REQUEST);
      const version = await setStatus(db, row.id, status);
      const viewed = await service.get(SALE, row.id);
      assert.equal(viewed.isLockedForSale, true);
      assert.equal(viewed.canEditSale, false);
      await assert.rejects(service.update(SALE, row.id, { version, quantity: 10 }), { statusCode: 403, code: 'LOCKED' }, status);
      await assert.rejects(service.remove(SALE, row.id, version), { statusCode: 403, code: 'LOCKED' }, status);
    }
    const pending = await service.create(SALE, NEW_REQUEST);
    const updated = await service.update(SALE, pending.id, { version: 1, quantity: 500, saleNote: 'gấp' });
    assert.equal(updated.quantity, 500);
    assert.equal(updated.status, 'pending');
    assert.equal(updated.version, 2);
    for (const status of ['3', '4']) {
      const row = await service.create(SALE, NEW_REQUEST);
      const version = await setStatus(db, row.id, status);
      const result = await service.update(SALE, row.id, { version, quantity: 450 });
      assert.equal(result.status, 'pending', status);
      const history = await service.history(SALE, row.id);
      const statusChange = history.find(h => h.field === 'status');
      assert.deepEqual([statusChange.oldValue, statusChange.newValue], [status, 'pending']);
    }
  } finally { await db.close(); }
});

test('gui lai dung gia tri cu khong tang version, khong ve pending', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    const version = await setStatus(db, row.id, '3');
    const result = await service.update(SALE, row.id, { version, quantity: '400', unitPrice: 11400, customerName: ' KH A Thắng Thanh Trì ' });
    assert.equal(result.status, '3');
    assert.equal(result.version, version);
  } finally { await db.close(); }
});

test('KT khong sua truong cua sale; sua ghi chu KT khi da khoa; lui 1 -> 3 mo khoa cho sale', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    await assert.rejects(service.update(KT, row.id, { version: 1, quantity: 1 }), { statusCode: 403 });
    await assert.rejects(service.update(KT, row.id, { version: 1, unitPrice: 1 }), { statusCode: 403 });
    await assert.rejects(service.update(SALE, row.id, { version: 1, status: '1' }), { statusCode: 403, code: 'FEATURE_FORBIDDEN' });
    await assert.rejects(service.update(SALE, row.id, { version: 1, accountantNote: 'x' }), { statusCode: 403, code: 'FEATURE_FORBIDDEN' });
    await assert.rejects(service.update(KT, row.id, { version: 1, createdBy: 'kt-1' }), { statusCode: 403, code: 'FIELD_FORBIDDEN' });
    await assert.rejects(service.update(KT, row.id, { version: 1, status: '9' }), { statusCode: 400 });

    const done = await service.update(KT, row.id, { version: 1, status: '1', accountantNote: 'CONT 10-6V', arrivalDate: '2026-10-25' });
    assert.equal(done.status, '1');
    assert.equal(done.arrivalDate, '2026-10-25');
    const noted = await service.update(KT, row.id, { version: done.version, accountantNote: 'CONT 10-7G' });
    assert.equal(noted.accountantNote, 'CONT 10-7G');
    assert.equal(noted.status, '1');

    const reopened = await service.update(KT, row.id, { version: noted.version, status: '3' });
    assert.equal((await service.get(SALE, row.id)).canEditSale, true);
    const saleEdit = await service.update(SALE, row.id, { version: reopened.version, quantity: 300 });
    assert.equal(saleEdit.status, 'pending');
  } finally { await db.close(); }
});

test('Ke toan chua duoc cap quyen chi xem, khong xu ly tung dong hay hang loat', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    const listed = await service.list(KT_UNGRANTED);
    assert.equal(listed.rows.length, 1);
    assert.equal(listed.viewer.canProcess, false);
    assert.equal(listed.rows[0].canProcess, false);
    for (const changes of [{ status: '1' }, { accountantNote: 'Đã duyệt' }, { arrivalDate: '2026-10-25' }]) {
      await assert.rejects(service.update(KT_UNGRANTED, row.id, { version: 1, ...changes }), { statusCode: 403, code: 'FEATURE_FORBIDDEN' });
    }
    await assert.rejects(service.bulkUpdate(KT_UNGRANTED, { items: [{ id: row.id, version: 1 }], changes: { status: '1' } }), { statusCode: 403, code: 'FEATURE_FORBIDDEN' });
    assert.equal((await service.get(SALE, row.id)).status, 'pending');
    assert.equal((await service.get(KT, row.id)).canProcess, true);
  } finally { await db.close(); }
});

test('Quan ly sua duoc truong sale cua yeu cau da khoa va xu ly trang thai', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    const version = await setStatus(db, row.id, '1');
    const result = await service.update(QL, row.id, { version, quantity: 999, status: '2' });
    assert.equal(result.quantity, 999);
    assert.equal(result.status, '2');
  } finally { await db.close(); }
});

test('hai nguoi luu cung version: nguoi sau nhan 409 kem du lieu moi nhat', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    await service.update(KT, row.id, { version: 1, status: '1' });
    await assert.rejects(service.update(SALE, row.id, { version: 1, quantity: 10 }), error => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'VERSION_CONFLICT');
      assert.equal(error.latest.status, '1');
      assert.equal(error.latest.version, 2);
      return true;
    });
    await assert.rejects(service.update(SALE, row.id, { quantity: 10 }), { statusCode: 400, code: 'VERSION_REQUIRED' });
    const { rows } = await db.query('SELECT quantity FROM vat_requests WHERE id = $1', [row.id]);
    assert.equal(Number(rows[0].quantity), 400);
  } finally { await db.close(); }
});

test('lich su ghi dung gia tri cu va moi cho tung truong; bang lich su khong sua duoc', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    await service.update(SALE, row.id, { version: 1, quantity: 500, fullVat: false, productCode: '26DAQUAN' });
    const history = await service.history(SALE, row.id);
    const byField = Object.fromEntries(history.filter(h => h.field).map(h => [h.field, [h.oldValue, h.newValue]]));
    assert.deepEqual(byField, {
      quantity: ['400', '500'],
      full_vat: ['true', 'false'],
      product_code: ['014XOAN', '26DAQUAN']
    });
    assert.equal(history[0].changedBy, 'sale-1');
    const after = await service.get(SALE, row.id);
    assert.equal(after.productName, 'Đồng hồ treo tường DẠ QUANG');
    await assert.rejects(db.query('UPDATE vat_request_history SET new_value = $1', ['x']), /immutable/);
  } finally { await db.close(); }
});

test('xoa mem: an khoi danh sach, ghi lich su', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    await service.remove(SALE, row.id, 1);
    assert.equal((await service.list(SALE)).rows.length, 0);
    const { rows } = await db.query('SELECT is_deleted FROM vat_requests WHERE id = $1', [row.id]);
    assert.equal(rows[0].is_deleted, true);
    await assert.rejects(service.get(SALE, row.id), { statusCode: 404 });
  } finally { await db.close(); }
});

test('P chi cong yeu cau cung ma o 3/4; Q/R tu CONT chua ve; O tu sheet ton theo Khop ma', async () => {
  const config = defaultStockConfig();
  const stockCsv = 'CTY,Mã kiot đại diện,Tên,MÃ VAT KIOT,TÊN VAT,Tên hàng,ĐVT,x,TỒN ĐẦU NGÀY\n'
    + 'TKS THẤP,014XOAN,,VAT1,,,Cái,,"1,200"\nVC,,,VAT1,,,Cái,,300\nSHC,26DAQUAN,,VAT2,,,Cái,,50\n';
  const mappingCsv = 'CHECK TỒN BÊN SHEET VAT\nMã SP,Tên SP,,,,,,,,Mã vat kiot\n014xoan,Bát,,,,,,,,VAT1\n';
  const stock = { ...parseStockRecords(parseCsv(stockCsv), config), vatByProduct: parseMappingRecords(parseCsv(mappingCsv), config), loadedAt: Date.now() };
  const { db, service } = await fixture({ stock });
  try {
    for (const status of ['pending', '0', '1', '2', '3', '4']) {
      const row = await service.create(SALE, { ...NEW_REQUEST, quantity: 100 });
      if (status !== 'pending') await setStatus(db, row.id, status);
    }
    await db.exec(`INSERT INTO product_container_lines(sheet_name,sheet_order,container_row,source_row,product_code,product_key,container_name,status,status_label,quantity,eta)
      VALUES ('YIWU',0,1,2,'014XOAN','014xoan','CONT A',1,'1. Chưa lịch',100,'DK 14-16/11'),
             ('YIWU',0,3,4,'014XOAN','014xoan','CONT B',3,'3. Đã bốc',50,'DK 28/10'),
             ('SD',1,1,2,'014XOAN','014xoan','CONT C',4,'4. Đã về',999,'DK 1/10')`);
    const data = await service.list(KT);
    const m = data.metrics['014xoan'];
    assert.equal(m.pendingInsertQty, 200);
    assert.equal(m.incomingContainer, 'CONT B', 'cont chua ve som nhat, bo qua cont da ve (4)');
    assert.equal(m.containerStatus, '3. Đã bốc', 'trang thai cua cont chua ve som nhat');
    assert.equal(m.containerEta, 'DK 28/10');
    assert.equal(m.nearestArrivalDate, '2026-10-28');
    assert.equal(m.vatStock.total, 1500);
    assert.deepEqual(m.vatStock.byCompany.map(c => c.company), ['TKS THẤP', 'VC']);
    assert.equal(data.stockStatus.available, true);

    const metrics = await service.productMetrics(KT, '26daquan');
    assert.equal(metrics.productCode, '26DAQUAN');
    assert.equal(metrics.vatStock.total, 50, 'khong co trong Khop ma -> tra theo Mã kiot đại diện');
    assert.equal(metrics.incomingContainer, '');
    assert.equal(metrics.containerStatus, '');
    assert.equal(metrics.containerEta, '');
    assert.equal(metrics.nearestArrivalDate, null);

    // Sale (khong co quyen xu ly): khong nhan 4 so O/P/Q/R o bat ky API nao.
    const saleData = await service.list(SALE);
    assert.equal(saleData.rows.length, 6);
    assert.deepEqual(saleData.metrics, {});
    assert.equal(saleData.stockStatus, null);
    assert.deepEqual(await service.productMetrics(SALE, '014xoan'), { productCode: '014XOAN', productName: 'Bát inox 2 lớp XOẮN 14cm', stockStatus: null });
    const { results, stockStatus } = await service.lookupProducts(SALE, ['014xoan']);
    assert.equal(stockStatus, null);
    assert.deepEqual(Object.keys(results['014xoan']).sort(), ['found', 'latestOrder', 'productCode', 'productName']);
  } finally { await db.close(); }
});

test('het cont chua ve: Trang thai / ngay ve lay cont "4. Da ve" gan nhat, Du kien hang ve de trong', async () => {
  const { db, service } = await fixture();
  try {
    await service.create(SALE, NEW_REQUEST);
    await db.exec(`INSERT INTO product_container_lines(sheet_name,sheet_order,container_row,source_row,product_code,product_key,container_name,status,status_label,quantity,eta)
      VALUES ('YIWU',0,1,2,'014XOAN','014xoan','CONT OLD',4,'4.Đã về',10,'VỀ 25/9'),
             ('YIWU',0,3,4,'014XOAN','014xoan','CONT NEW',4,'4.Đã về',10,'19/10 VỀ'),
             ('SD',1,1,2,'014XOAN','014xoan','CONT HUY',5,'5. Hủy',10,'DK 30/10')`);
    const m = (await service.list(KT)).metrics['014xoan'];
    assert.equal(m.incomingContainer, '');
    assert.equal(m.containerStatus, '4.Đã về');
    assert.equal(m.containerEta, '19/10 VỀ');
    assert.equal(m.nearestArrivalDate, '2026-10-19');
  } finally { await db.close(); }
});

test('trang thai 5 "VAT san nhieu": KT chon duoc, khoa sale nhu 0', async () => {
  const { db, service } = await fixture();
  try {
    const row = await service.create(SALE, NEW_REQUEST);
    const updated = await service.update(KT, row.id, { version: 1, status: '5' });
    assert.equal(updated.statusLabel, 'VAT sẵn nhiều');
    assert.equal(updated.isLockedForSale, true);
    assert.equal((await service.get(SALE, row.id)).canEditSale, false);
    const list = await service.list(SALE);
    assert.deepEqual(list.statuses.map(s => s.value), ['pending', '0', '5', '1', '2', '3', '4']);
    assert.equal(list.statuses.find(s => s.value === '5').locksSale, true);
  } finally { await db.close(); }
});

test('migration 0083: chuyen dong 0 co note KHOP NGUYEN san / ton nhieu / con sang 5, ghi lich su he thong; chay lai khong doi', async () => {
  const { db, service } = await fixture({ migrations: MIGRATIONS.filter(file => !file.startsWith('0083')) });
  try {
    const notes = { ' SẴN ': '5', 'TỒN NHIỀU': '5', 'CÒN': '5', 'còn tồn nhiều': '5', 'sẵn VAT': '0', 'còn 2000': '0', 'không còn': '0', 's': '0', 'khai sau': '0' };
    const ids = {};
    for (const note of Object.keys(notes)) {
      const row = await service.create(SALE, NEW_REQUEST);
      await db.query("UPDATE vat_requests SET status = '0', accountant_note = $2 WHERE id = $1", [row.id, note]);
      ids[note] = row.id;
    }
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/0083_vat_request_status_vat_ready.sql'), 'utf8');
    await db.exec(sql);
    await db.exec(sql);
    for (const [note, status] of Object.entries(notes)) {
      const { rows } = await db.query('SELECT status FROM vat_requests WHERE id = $1', [ids[note]]);
      assert.equal(rows[0].status, status, note);
    }
    const { rows: history } = await db.query("SELECT changed_by, changed_by_name FROM vat_request_history WHERE field = 'status' AND new_value = '5'");
    assert.equal(history.length, 4, 'moi dong 1 lich su, chay lai khong ghi them');
    assert.ok(history.every(h => h.changed_by === null && h.changed_by_name === 'Hệ thống'));
  } finally { await db.close(); }
});

test('sheet ton loi: van tra danh sach, O = null, bao trang thai nguon', async () => {
  const { db, service } = await fixture();
  try {
    await service.create(SALE, NEW_REQUEST);
    const data = await service.list(KT);
    assert.equal(data.rows.length, 1);
    assert.equal(data.metrics['014xoan'].vatStock, null);
    assert.equal(data.stockStatus.available, false);
  } finally { await db.close(); }
});

test('sale xem duoc toan bo bang (chi doc dong cua nguoi khac); loc theo trang thai / nguoi tao / tu khoa', async () => {
  const { db, service } = await fixture();
  try {
    const mine = await service.create(SALE, NEW_REQUEST);
    const other = await service.create(SALE2, { ...NEW_REQUEST, productCode: '26DAQUAN', customerName: 'Tưởng hà đông' });
    await setStatus(db, other.id, '3');
    const all = await service.list(SALE);
    assert.equal(all.rows.length, 2);
    const otherRow = all.rows.find(r => r.id === other.id);
    assert.equal(otherRow.canEditSale, false);
    assert.equal(otherRow.isMine, false);
    assert.equal(all.rows.find(r => r.id === mine.id).canEditSale, true);
    assert.equal(all.viewer.canProcess, false);
    assert.deepEqual(all.sales.map(s => s.id).sort(), ['sale-1', 'sale-2']);
    assert.deepEqual((await service.list(SALE, { statuses: ['3', '4'] })).rows.map(r => r.id), [other.id]);
    assert.deepEqual((await service.list(SALE, { createdBy: 'sale-1' })).rows.map(r => r.id), [mine.id]);
    assert.deepEqual((await service.list(SALE, { q: 'tưởng' })).rows.map(r => r.id), [other.id]);
  } finally { await db.close(); }
});

test('xuat Excel: chi KT co quyen xu ly va quan ly; dung bo loc nhu list', async () => {
  const { db, service } = await fixture();
  try {
    const mine = await service.create(SALE, NEW_REQUEST);
    const other = await service.create(SALE2, { ...NEW_REQUEST, productCode: '26DAQUAN' });
    await setStatus(db, other.id, '3');
    await assert.rejects(service.exportList(SALE), { statusCode: 403, code: 'FEATURE_FORBIDDEN' });
    await assert.rejects(service.exportList(KT_UNGRANTED), { statusCode: 403 });
    assert.deepEqual((await service.exportList(KT, { statuses: ['3'] })).rows.map(r => r.id), [other.id]);
    assert.deepEqual((await service.exportList(QL)).rows.map(r => r.id).sort(), [mine.id, other.id].sort());
  } finally { await db.close(); }
});

test('KT doi trang thai hang loat; 1 dong lech version -> huy ca lo', async () => {
  const { db, service } = await fixture();
  try {
    const a = await service.create(SALE, NEW_REQUEST);
    const b = await service.create(SALE2, NEW_REQUEST);
    await assert.rejects(service.bulkUpdate(SALE, { items: [{ id: a.id, version: 1 }], changes: { status: '2' } }), { statusCode: 403 });
    await assert.rejects(service.bulkUpdate(KT, { items: [{ id: a.id, version: 1 }], changes: { quantity: 1 } }), { statusCode: 403, code: 'FIELD_FORBIDDEN' });
    const result = await service.bulkUpdate(KT, { items: [{ id: a.id, version: 1 }, { id: b.id, version: 1 }], changes: { status: '2', accountantNote: 'CONT 10-7G' } });
    assert.equal(result.updated, 2);
    assert.deepEqual((await service.list(KT)).rows.map(r => [r.status, r.accountantNote]), [['2', 'CONT 10-7G'], ['2', 'CONT 10-7G']]);
    await assert.rejects(service.bulkUpdate(KT, { items: [{ id: a.id, version: 2 }, { id: b.id, version: 1 }], changes: { status: '1' } }), error => {
      assert.equal(error.statusCode, 409);
      assert.deepEqual(error.conflictIds, [b.id]);
      return true;
    });
    assert.equal((await service.get(KT, a.id)).status, '2', 'ca lo bi huy');
  } finally { await db.close(); }
});

test('KT keo / dan kieu Sheet: bulk nhan changes rieng tung dong, tron voi changes chung, tra rows ban moi', async () => {
  const { db, service } = await fixture();
  try {
    const a = await service.create(SALE, NEW_REQUEST);
    const b = await service.create(SALE2, NEW_REQUEST);
    const c = await service.create(SALE, NEW_REQUEST);
    const result = await service.bulkUpdate(KT, { changes: { arrivalDate: '2026-10-28' }, items: [
      { id: a.id, version: 1, changes: { accountantNote: 'CONT A', status: '3' } },
      { id: b.id, version: 1, changes: { accountantNote: 'CONT B', arrivalDate: null } },
      { id: c.id, version: 1 }
    ] });
    assert.equal(result.updated, 3);
    assert.deepEqual(result.rows.map(r => [r.id, r.status, r.accountantNote, r.arrivalDate, r.version]),
      [[a.id, '3', 'CONT A', '2026-10-28', 2], [b.id, 'pending', 'CONT B', null, 2], [c.id, 'pending', '', '2026-10-28', 2]]);
    const history = await service.history(KT, a.id);
    assert.deepEqual(history.filter(h => h.action === 'update').map(h => h.field).sort(), ['accountant_note', 'arrival_date', 'status']);

    const unchanged = await service.bulkUpdate(KT, { items: [{ id: a.id, version: 2, changes: { accountantNote: 'CONT A' } }, { id: b.id, version: 2, changes: { accountantNote: 'CONT B2' } }] });
    assert.deepEqual([unchanged.updated, unchanged.rows.map(r => r.id)], [1, [b.id]], 'dong khong doi gia tri thi bo qua');

    await assert.rejects(service.bulkUpdate(KT, { items: [{ id: a.id, version: 2, changes: { quantity: 1 } }] }), { statusCode: 403, code: 'FIELD_FORBIDDEN' });
    await assert.rejects(service.bulkUpdate(KT, { items: [{ id: a.id, version: 2 }] }), { statusCode: 400 });
    await assert.rejects(service.bulkUpdate(KT, { items: [{ id: a.id, version: 2, changes: { accountantNote: 'x' } }, { id: b.id, version: 2, changes: { accountantNote: 'y' } }] }),
      error => { assert.equal(error.statusCode, 409); assert.deepEqual(error.conflictIds, [b.id]); return true; });
    assert.equal((await service.get(KT, a.id)).accountantNote, 'CONT A', 'lech version -> huy ca lo');
  } finally { await db.close(); }
});

test('goi y san pham theo ma / ten, uu tien khop dau ma', async () => {
  const { db, service } = await fixture();
  try {
    assert.deepEqual((await service.suggestProducts('xoan')).map(r => r.code), ['014XOAN']);
    assert.deepEqual((await service.suggestProducts('đồng hồ')).map(r => r.code), ['26DAQUAN']);
    assert.deepEqual(await service.suggestProducts('  '), []);
  } finally { await db.close(); }
});

test('form nhieu dong: gui 1 lan tao nhieu yeu cau, moi dong 1 khach / 1 ma, ghi lich su tung yeu cau', async () => {
  const { db, service } = await fixture();
  try {
    const result = await service.createMany(SALE, { submissionId: 'sub-1', items: [
      { ...NEW_REQUEST },
      { customerName: 'Tưởng hà đông', productCode: '26daquan', quantity: 280, unitPrice: 37870, fullVat: false, saleNote: 'gấp' }
    ] });
    assert.equal(result.created, 2);
    assert.equal(result.duplicate, false);
    const rows = (await service.list(SALE)).rows;
    assert.deepEqual(rows.map(r => [r.productCode, r.customerName, r.status, r.createdBy]).sort(),
      [['014XOAN', 'KH A Thắng Thanh Trì', 'pending', 'sale-1'], ['26DAQUAN', 'Tưởng hà đông', 'pending', 'sale-1']]);
    const { rows: history } = await db.query("SELECT count(*)::int AS n FROM vat_request_history WHERE action = 'create'");
    assert.equal(history[0].n, 2);
  } finally { await db.close(); }
});

test('form nhieu dong: 1 dong loi -> 400 kem loi theo tung dong, khong ghi dong nao', async () => {
  const { db, service } = await fixture();
  try {
    await assert.rejects(service.createMany(SALE, { submissionId: 'sub-2', items: [
      { ...NEW_REQUEST },
      { ...NEW_REQUEST, productCode: 'KHONGCO' },
      { ...NEW_REQUEST, quantity: 0, customerName: '' },
      { ...NEW_REQUEST, status: '1' },
      { customerName: 'KH E', productCode: '014XOAN', quantity: 1, unitPrice: 1000 }
    ] }), error => {
      assert.equal(error.statusCode, 400);
      assert.equal(error.code, 'BATCH_INVALID');
      assert.deepEqual(error.errors.map(e => [e.row, e.field]), [[2, 'productCode'], [3, 'customerName'], [3, 'quantity'], [4, 'status'], [5, 'fullVat']]);
      assert.match(error.errors[4].message, /chưa chọn Full VAT/);
      assert.match(error.message, /4 dòng chưa hợp lệ/);
      return true;
    });
    const { rows } = await db.query('SELECT count(*)::int AS n FROM vat_requests');
    assert.equal(rows[0].n, 0);
    await assert.rejects(service.createMany(SALE, { submissionId: 'x', items: [] }), { statusCode: 400 });
    await assert.rejects(service.createMany(SALE, { submissionId: 'x', items: Array.from({ length: 201 }, () => NEW_REQUEST) }), { statusCode: 400 });
    await assert.rejects(service.createMany(SALE, { items: [NEW_REQUEST] }), { statusCode: 400 });
  } finally { await db.close(); }
});

test('form nhieu dong: gui lai cung submissionId khong tao trung; loi thi cho gui lai', async () => {
  const { db, service } = await fixture();
  try {
    await assert.rejects(service.createMany(SALE, { submissionId: 'retry', items: [{ ...NEW_REQUEST, productCode: 'KHONGCO' }] }), { statusCode: 400 });
    const first = await service.createMany(SALE, { submissionId: 'retry', items: [NEW_REQUEST, NEW_REQUEST] });
    const [again, parallel] = await Promise.all([
      service.createMany(SALE, { submissionId: 'retry', items: [NEW_REQUEST, NEW_REQUEST] }),
      service.createMany(SALE, { submissionId: 'retry', items: [NEW_REQUEST, NEW_REQUEST] })
    ]);
    assert.equal(again.duplicate, true);
    assert.deepEqual(again.ids, first.ids);
    assert.deepEqual(parallel.ids, first.ids);
    const other = await service.createMany(SALE2, { submissionId: 'retry', items: [NEW_REQUEST] });
    assert.equal(other.duplicate, false, 'ma lan gui tach theo tai khoan');
    const { rows } = await db.query('SELECT count(*)::int AS n FROM vat_requests');
    assert.equal(rows[0].n, 3);
  } finally { await db.close(); }
});

test('tra nhieu ma cung luc: ten SP, so lieu va gia VAT gan nhat; ma khong co -> found=false', async () => {
  const { db, service } = await fixture();
  try {
    await service.createMany(SALE, { submissionId: 's', items: [{ ...NEW_REQUEST, unitPrice: 12000 }] });
    const { results } = await service.lookupProducts(KT, ['014XOAN', ' 26daquan ', 'KHONGCO']);
    assert.equal(results['014xoan'].productName, 'Bát inox 2 lớp XOẮN 14cm');
    assert.equal(results['014xoan'].latestOrder.price, 12000);
    assert.equal(results['014xoan'].pendingInsertQty, 0);
    assert.equal(results['26daquan'].found, true);
    assert.equal(results['26daquan'].latestOrder, null);
    assert.deepEqual(results.khongco, { found: false });
  } finally { await db.close(); }
});

test('KT keo dong: dong moi len dau; keo len giua / len dau / xuong cuoi; sale bi chan; khong doi version, khong ghi lich su', async () => {
  const { db, service } = await fixture();
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await service.create(SALE, NEW_REQUEST)).id);
    const [a, b, c, d] = ids;
    const order = async (user = KT) => (await service.list(user)).rows.map(r => r.id);
    assert.deepEqual(await order(), [d, c, b, a], 'mac dinh moi nhat truoc');
    assert.equal((await service.list(KT)).rowOrder, true);

    await service.move(KT, { ids: [a], belowId: c }); // a len ngay tren c
    assert.deepEqual(await order(), [d, a, c, b]);
    await service.move(KT, { ids: [b], belowId: d }); // b len dau
    assert.deepEqual(await order(), [b, d, a, c]);
    await service.move(KT, { ids: [d], aboveId: c }); // d xuong cuoi
    assert.deepEqual(await order(), [b, a, c, d]);
    assert.deepEqual(await order(SALE), [b, a, c, d], 'thu tu chung cho moi nguoi');

    const e = (await service.create(SALE2, NEW_REQUEST)).id;
    assert.deepEqual(await order(), [e, b, a, c, d], 'yeu cau moi len dau, dong da xep giu nguyen');

    assert.equal((await service.get(KT, a)).version, 1, 'keo dong khong doi version');
    assert.deepEqual((await service.history(KT, a)).map(h => h.action), ['create']);

    await assert.rejects(service.move(SALE, { ids: [a], belowId: b }), { statusCode: 403 });
    await assert.rejects(service.move(KT_UNGRANTED, { ids: [a], belowId: b }), { statusCode: 403 });
    await assert.rejects(service.move(KT, { ids: [a] }), { statusCode: 400 });
    await assert.rejects(service.move(KT, { ids: [a], belowId: b, aboveId: c }), { statusCode: 400 });
    await assert.rejects(service.move(KT, { ids: [a], belowId: a }), { statusCode: 400 });
    await assert.rejects(service.move(KT, { ids: [a], belowId: 999 }), { statusCode: 404 });
    await service.remove(SALE, c, 1);
    await assert.rejects(service.move(KT, { ids: [a], aboveId: c }), { statusCode: 404, code: 'NOT_FOUND' });
  } finally { await db.close(); }
});

test('keo 30 lan vao cung 1 khe van dung thu tu (trung diem khong trung); Excel theo thu tu da keo', async () => {
  const { db, service } = await fixture();
  try {
    const ids = [];
    for (let i = 0; i < 32; i++) ids.push((await service.create(SALE, NEW_REQUEST)).id);
    // Dang hien moi nhat truoc: ids[31] ... ids[0]. Lan luot dua ids[0..29] vao ngay tren ids[30] (sat duoi ids[31]).
    for (let i = 0; i < 30; i++) await service.move(KT, { ids: [ids[i]], belowId: ids[30] });
    const rows = (await service.list(KT)).rows.map(r => r.id);
    assert.deepEqual(rows, [ids[31], ...ids.slice(0, 30), ids[30]]);
    assert.deepEqual((await service.exportList(KT)).rows.map(r => r.id), rows);
  } finally { await db.close(); }
});

test('chua ap migration 0079: danh sach xep theo thoi gian tao, rowOrder=false, keo dong bao 409', async () => {
  const { db, service } = await fixture({ migrations: MIGRATIONS.filter(file => !file.startsWith('0079')) });
  try {
    const a = await service.create(SALE, NEW_REQUEST);
    const b = await service.create(SALE, NEW_REQUEST);
    const data = await service.list(KT);
    assert.equal(data.rowOrder, false);
    assert.deepEqual(data.rows.map(r => r.id), [b.id, a.id]);
    await assert.rejects(service.move(KT, { ids: [a.id], belowId: b.id }), { statusCode: 409, code: 'ROW_ORDER_UNAVAILABLE' });
  } finally { await db.close(); }
});

test('KT keo nhieu dong 1 lan: dong roi nhau gom thanh 1 khoi tai cho tha, giu thu tu ids; keo lap lai cung khe van dung', async () => {
  const { db, service } = await fixture();
  try {
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push((await service.create(SALE, NEW_REQUEST)).id);
    const order = async () => (await service.list(KT)).rows.map(r => r.id);
    const shown = await order(); // moi nhat truoc
    assert.deepEqual(shown, ids.slice().reverse());
    const [r0, r1, r2, r3, r4, r5, r6, r7] = shown;
    // Chon 3 dong roi nhau (r1, r4, r6) keo len ngay tren r0 (dau bang)
    await service.move(KT, { ids: [r1, r4, r6], belowId: r0 });
    assert.deepEqual(await order(), [r1, r4, r6, r0, r2, r3, r5, r7]);
    // Keo khoi (r0, r2) xuong cuoi
    await service.move(KT, { ids: [r0, r2], aboveId: r7 });
    assert.deepEqual(await order(), [r1, r4, r6, r3, r5, r7, r0, r2]);
    // 25 lan dua khoi 3 dong vao cung 1 khe giua r1 va r4 -> chia khe chinh xac, khong trung hang
    for (let i = 0; i < 25; i++) {
      const group = i % 2 ? [r6, r3, r5] : [r3, r5, r6];
      await service.move(KT, { ids: group, belowId: r4 });
    }
    assert.deepEqual(await order(), [r1, r3, r5, r6, r4, r7, r0, r2]);
    const { rows } = await db.query('SELECT count(DISTINCT sort_rank)::int AS n, count(*)::int AS total FROM vat_requests');
    assert.equal(rows[0].n, rows[0].total, 'khong co 2 dong trung hang');

    await assert.rejects(service.move(KT, { ids: [], belowId: r0 }), { statusCode: 400 });
    await assert.rejects(service.move(KT, { ids: [r1, r1], belowId: r0 }), { statusCode: 400 });
    await assert.rejects(service.move(KT, { ids: [r1, r0], belowId: r0 }), { statusCode: 400, code: 'VALIDATION' });
    await assert.rejects(service.move(KT, { ids: Array.from({ length: 501 }, (_, i) => i + 1000), belowId: r0 }), { statusCode: 400 });
    await assert.rejects(service.move(KT, { ids: [r1, 99999], belowId: r0 }), { statusCode: 404 });
    assert.deepEqual((await order()).slice(0, 2), [r1, r3], '404 khong doi gi (huy ca lo)');
  } finally { await db.close(); }
});

test('keep: dong vua doi trang thai van nam trong danh sach dang loc, dung vi tri; bo loc khac khong keo them dong la', async () => {
  const { db, service } = await fixture();
  try {
    const a = await service.create(SALE, NEW_REQUEST);
    const b = await service.create(SALE, NEW_REQUEST);
    const c = await service.create(SALE, NEW_REQUEST);
    const todo = { statuses: ['pending', '3', '4'] };
    await service.update(KT, b.id, { version: 1, status: '1' });
    assert.deepEqual((await service.list(KT, todo)).rows.map(r => r.id), [c.id, a.id], 'khong keep: dong da xong bien mat');
    const kept = (await service.list(KT, { ...todo, keep: [b.id] })).rows;
    assert.deepEqual(kept.map(r => r.id), [c.id, b.id, a.id], 'keep: dong o lai dung cho');
    assert.equal(kept.find(r => r.id === b.id).status, '1');
    assert.deepEqual((await service.list(KT, { keep: [b.id] })).rows.map(r => r.id), [c.id, b.id, a.id], 'khong loc thi keep khong doi gi');
    assert.deepEqual((await service.list(KT, { statuses: ['0'], keep: [] })).rows, []);
  } finally { await db.close(); }
});

test('keo dong tra hang cu / moi; restoreRanks dat lai dung thu tu (hoan tac / lam lai); chan sai quyen / du lieu sai', async () => {
  const { db, service } = await fixture();
  try {
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push((await service.create(SALE, NEW_REQUEST)).id);
    const order = async () => (await service.list(KT)).rows.map(r => r.id);
    const original = await order();
    const [r0, r1, r2, r3] = original;
    const moved = await service.move(KT, { ids: [r3, r1], belowId: r0 });
    assert.deepEqual(Object.keys(moved.before).map(Number).sort(), [r1, r3].sort());
    assert.deepEqual(Object.keys(moved.after).map(Number).sort(), [r1, r3].sort());
    const afterMove = await order();
    assert.deepEqual(afterMove, [r3, r1, r0, r2]);
    assert.deepEqual(await service.restoreRanks(KT, { ranks: moved.before }), { ok: true, updated: 2 });
    assert.deepEqual(await order(), original, 'hoan tac ve dung thu tu cu');
    await service.restoreRanks(KT, { ranks: moved.after });
    assert.deepEqual(await order(), afterMove, 'lam lai');
    await assert.rejects(service.restoreRanks(SALE, { ranks: moved.before }), { statusCode: 403 });
    await assert.rejects(service.restoreRanks(KT, { ranks: {} }), { statusCode: 400 });
    await assert.rejects(service.restoreRanks(KT, { ranks: { [r0]: '1; DROP TABLE x' } }), { statusCode: 400 });
    await assert.rejects(service.restoreRanks(KT, { ranks: { abc: '1' } }), { statusCode: 400 });
  } finally { await db.close(); }
});


// Snapshot that tu createStockSource (co danh muc ma): CBBCM chi co o Gộp VAT cot B, VATCB chi la MÃ VAT KIOT,
// BATSG chi co o Khớp mã — ca 3 deu khong co trong product_report.
async function sheetStock() {
  const config = defaultStockConfig();
  const tabs = {
    [config.stockSheet.sheetId]: parseCsv('CTY,Mã kiot đại diện,Tên kiot đại diện,MÃ VAT KIOT,TÊN VAT KIOT,Tên hàng,ĐVT,x,TỒN ĐẦU NGÀY\n'
      + 'TKS THẤP,CBBCM,Cốc bỏ bia cao mỏng,VATCB,Cốc thủy tinh VAT,,Cái,,500\nVC,,,VATCB,,,Cái,,20\n'),
    [config.mappingSheet.sheetId]: [[], ['Mã SP', 'Tên SP', '', '', '', '', '', '', '', 'Mã vat kiot'], ['BATSG', 'Bát Sài Gòn', '', '', '', '', '', '', '', 'VATCB']]
  };
  return createStockSource({ config, readValues: async sheet => tabs[sheet.sheetId] }).get();
}

test('ma khong co trong product_report nhung co trong sheet Gộp VAT / Khớp mã: sale order duoc, ten lay tu sheet', async () => {
  const { db, service } = await fixture({ stock: await sheetStock() });
  try {
    const row = await service.create(SALE, { ...NEW_REQUEST, productCode: ' cbbcm ' });
    assert.equal(row.productCode, 'CBBCM');
    assert.equal(row.productName, 'Cốc bỏ bia cao mỏng');

    const batch = await service.createMany(SALE, { submissionId: 'sheet', items: [
      { ...NEW_REQUEST, productCode: 'vatcb' }, { ...NEW_REQUEST, productCode: 'BATSG' }
    ] });
    const [vatRow, mapRow] = await Promise.all(batch.ids.map(id => service.get(SALE, id)));
    assert.deepEqual([vatRow.productCode, vatRow.productName], ['VATCB', 'Cốc thủy tinh VAT']);
    assert.deepEqual([mapRow.productCode, mapRow.productName], ['BATSG', 'Bát Sài Gòn']);

    const { results } = await service.lookupProducts(KT, ['CBBCM', 'VATCB', 'KHONGCO']);
    assert.equal(results.cbbcm.found, true);
    assert.equal(results.cbbcm.vatStock.total, 520);
    assert.equal(results.vatcb.vatStock.total, 520, 'nhap thang MÃ VAT KIOT van ra ton');
    assert.deepEqual(results.khongco, { found: false });

    assert.equal((await service.productMetrics(KT, 'cbbcm')).productCode, 'CBBCM');
    assert.deepEqual((await service.suggestProducts('cbb')).map(r => r.code), ['CBBCM']);
    assert.deepEqual((await service.suggestProducts('xoan')).map(r => r.code), ['014XOAN'], 'ma KiotViet van dung truoc');
    await assert.rejects(service.create(SALE, { ...NEW_REQUEST, productCode: 'KHONGCO' }), { statusCode: 400, code: 'PRODUCT_NOT_FOUND' });
  } finally { await db.close(); }
});

test('sheet loi: ma chi co trong sheet bi bao khong tim thay, ma KiotViet van order binh thuong', async () => {
  const { db, service } = await fixture();
  try {
    await assert.rejects(service.create(SALE, { ...NEW_REQUEST, productCode: 'CBBCM' }), { statusCode: 400, code: 'PRODUCT_NOT_FOUND' });
    assert.equal((await service.create(SALE, NEW_REQUEST)).productCode, '014XOAN');
    assert.deepEqual((await service.suggestProducts('cbb')), []);
  } finally { await db.close(); }
});

test('phan trang (slice 6): sap / gop / tim tren TOAN BO ket qua roi moi cat trang; so lieu tu nguon day du; Excel khong cat trang', async () => {
  const { db, service } = await fixture();
  try {
    const ids = [];
    // q10 xoan, q20 daquan, q30 xoan, q40 daquan, q50 xoan
    for (let i = 0; i < 5; i++) ids.push((await service.create(SALE, { ...NEW_REQUEST, quantity: (i + 1) * 10, productCode: i % 2 ? '26daquan' : '014xoan' })).id);
    await setStatus(db, ids[0], '3'); // SLG can khai cua 014xoan = 10, dong nay khong nam tren trang dang xem
    await db.query(`UPDATE vat_requests SET arrival_date = '2026-11-01' WHERE id = $1`, [ids[1]]);
    const all = (await service.list(KT)).rows.map(r => r.id);
    assert.equal((await service.list(KT)).totalRows, undefined, 'khong xin trang -> tra du nhu cu');

    const pageOf = async (paging, user = KT, filters = {}) => service.list(user, { ...filters, paging: { pageSize: '2', ...paging } });
    const pages = [];
    for (const page of ['1', '2', '3']) pages.push(...(await pageOf({ page })).rows.map(r => r.id));
    assert.deepEqual(pages, all, 'noi cac trang = dung thu tu danh sach day du');
    const last = await pageOf({ page: '99' });
    assert.deepEqual([last.page, last.totalRows, last.pageSize, last.rows.map(r => r.id)], [3, 5, 2, [all[4]]], 'kep ve trang cuoi');
    const empty = await pageOf({ page: '4' }, KT, { statuses: ['2'] });
    assert.deepEqual([empty.page, empty.totalRows, empty.rows], [1, 0, []]);

    const byQty = await pageOf({ page: '1', sorts: JSON.stringify([{ key: 'quantity', dir: 'desc' }]) });
    assert.deepEqual(byQty.rows.map(r => r.quantity), [50, 40]);
    assert.deepEqual(byQty.sorts, [{ key: 'quantity', dir: 'desc' }]);
    // Ngay ve: co ngay len truoc, o trong cuoi; bang nhau -> id giam dan (on dinh giua cac trang).
    const byArrival = await pageOf({ page: '1', pageSize: '5', sorts: JSON.stringify([{ key: 'arrivalDate', dir: 'desc' }]) });
    assert.deepEqual(byArrival.rows.map(r => r.id), [ids[1], ids[4], ids[3], ids[2], ids[0]]);
    // Cot so lieu: sale khong sap duoc (bo qua), KT sap duoc tren so lieu cua moi dong khop.
    assert.deepEqual((await pageOf({ page: '1', sorts: JSON.stringify([{ key: 'pendingQty', dir: 'desc' }]) }, SALE)).sorts, []);
    const byPending = await pageOf({ page: '1', pageSize: '3', sorts: JSON.stringify([{ key: 'pendingQty', dir: 'desc' }, { key: 'quantity', dir: 'asc' }]) });
    assert.deepEqual(byPending.rows.map(r => r.id), [ids[0], ids[2], ids[4]], 'xoan (can khai 10) truoc daquan (0)');

    // So lieu chi gom ma tren trang nhung tinh tu du lieu day du (dong trang thai 3 o trang khac van duoc cong).
    const top = await pageOf({ page: '1', pageSize: '1', sorts: JSON.stringify([{ key: 'quantity', dir: 'desc' }]) });
    assert.deepEqual(top.rows.map(r => r.id), [ids[4]]);
    assert.deepEqual(Object.keys(top.metrics), ['014xoan']);
    assert.equal(top.metrics['014xoan'].pendingInsertQty, 10);

    // Gop theo ma: dem so yeu cau cua ma tren toan ket qua, khong chi trang nay; sale khong gop duoc.
    const grouped = await pageOf({ page: '1', group: true });
    assert.equal(grouped.group, true);
    assert.deepEqual(grouped.rows.map(r => r.productKey), ['014xoan', '014xoan']);
    assert.deepEqual(grouped.groupCounts, { '014xoan': 3 });
    assert.equal((await pageOf({ page: '1', group: true }, SALE)).group, false);

    // Tim tren toan bo ket qua truoc khi cat trang.
    const found = await pageOf({ page: '1' }, KT, { q: 'quang' });
    assert.deepEqual([found.totalRows, found.rows.map(r => r.productKey)], [2, ['26daquan', '26daquan']]);

    // Dong lay tu trang khac van giu version rieng: version cu -> 409, khong ghi.
    await assert.rejects(service.bulkUpdate(KT, { items: [{ id: ids[0], version: 1, changes: { accountantNote: 'x' } }] }),
      { statusCode: 409, code: 'VERSION_CONFLICT' });

    // Excel luon la toan bo ket qua bo loc, ke ca khi client lo gui trang.
    const exported = await service.exportList(KT, { paging: { page: '2', pageSize: '2' } });
    assert.equal(exported.rows.length, 5);
    assert.equal(exported.totalRows, undefined);
  } finally { await db.close(); }
});

// 14/11/2026: file trung gian loi -> doc file goc VAT TKS mat 1-2 phut; danh sach ORDER VAT khong duoc cho theo.
test('sheet ton dang doc cham: danh sach tra ngay (Ton VAT "dang tai"), lan doc van chay tiep va lan sau co so', async () => {
  const config = defaultStockConfig();
  const stockCsv = 'CTY,Mã kiot đại diện,Tên,MÃ VAT KIOT,TÊN VAT,Tên hàng,ĐVT,x,TỒN ĐẦU NGÀY\nTKS,014XOAN,,VAT1,,,Cái,,70\n';
  const stock = { ...parseStockRecords(parseCsv(stockCsv), config), vatByProduct: new Map(), loadedAt: Date.now() };
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  await db.exec(`INSERT INTO product_report(product_code, product_name) VALUES ('014XOAN', 'Bát inox 2 lớp XOẮN 14cm')`);
  let release;
  let reads = 0;
  const slow = new Promise(resolve => { release = resolve; });
  let ready = null;
  const stockSource = { get: () => { reads++; return ready ? Promise.resolve(ready) : slow; } };
  const service = createVatRequestService({ pool: poolFor(db), stockSource, stockWaitMs: 30, now: () => new Date('2026-10-20T03:00:00Z') });
  try {
    await service.create(SALE, NEW_REQUEST);
    const started = Date.now();
    const data = await service.list(KT);
    assert.ok(Date.now() - started < 2000, 'khong cho sheet');
    assert.equal(data.rows.length, 1);
    assert.equal(data.metrics['014xoan'].vatStock, null);
    assert.deepEqual([data.stockStatus.available, data.stockStatus.loading], [false, true]);
    assert.match(data.stockStatus.error, /Đang tải tồn VAT/);
    const paged = await service.list(KT, { paging: { page: 1, pageSize: 50 } });
    assert.equal(paged.stockStatus.loading, true);
    assert.equal((await service.suggestProducts('014', 5)).length, 1, 'goi y van tra ma KiotViet, khong cho sheet');
    release(stock);
    ready = stock;
    const later = await service.list(KT);
    assert.equal(later.stockStatus.available, true);
    assert.equal(later.metrics['014xoan'].vatStock.total, 70);
    assert.ok(reads >= 2);
  } finally { await db.close(); }
});

test('tao yeu cau voi ma chi co trong sheet van cho doc sheet (khong cat ngang de khong bao sai "khong tim thay ma")', async () => {
  const config = defaultStockConfig();
  const stockCsv = 'CTY,Mã kiot đại diện,Tên,MÃ VAT KIOT,TÊN VAT,Tên hàng,ĐVT,x,TỒN ĐẦU NGÀY\nTKS,CHISHEET,Hàng chỉ có ở sheet,VAT9,,,Cái,,5\n';
  const parsed = parseStockRecords(parseCsv(stockCsv), config);
  const { buildProductCatalog } = require('./stockSource');
  const { representativeCatalog, vatCatalog, ...rest } = parsed;
  const stock = { ...rest, vatByProduct: new Map(), productByCode: buildProductCatalog(new Map(), representativeCatalog, vatCatalog), loadedAt: Date.now() };
  const db = new PGlite();
  for (const file of MIGRATIONS) await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations', file), 'utf8'));
  const stockSource = { get: () => new Promise(resolve => setTimeout(resolve, 80, stock)) };
  const service = createVatRequestService({ pool: poolFor(db), stockSource, stockWaitMs: 10, now: () => new Date('2026-10-20T03:00:00Z') });
  try {
    const row = await service.create(SALE, { ...NEW_REQUEST, productCode: 'chisheet' });
    assert.equal(row.productCode, 'CHISHEET');
  } finally { await db.close(); }
});
