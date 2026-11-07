'use strict';

// Bang "Gia duyet" (migration 0091) tren PGlite voi schema THAT: migration, quy tac dau vao, repository (tao / sua / xoa,
// ten theo Kiot, tinh lai Kiem tra gia ban), ap gia duyet khi chup hoa don, va HTTP qua express that.

const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET ||= 'fixture';
process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||= '{}';
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const ExcelJS = require('exceljs');
const { resolvePermissions } = require('../auth/featureRegistry');
const rules = require('./approvedPriceRules');
const { createApprovedPriceRepository } = require('./approvedPriceRepository');
const { createApprovedPriceRouter } = require('./approvedPriceRoutes');
const { runDailyAudit } = require('./priceAuditRefresh');
const { HN_NOTE, newDb, product, customer, invoice, pgliteAsPool } = require('./priceAuditFixtures');

const at23 = day => new Date(`${day}T16:00:00Z`);
const quiet = { error() {}, info() {}, warn() {}, log() {} };
const NOW = at23('2026-10-20');

// Hoa don 1 dong T100 x 10 gia 23700 (HN_NOTE: cap Vua min 24000 => SAI, chenh 300/chiec = 3.000).
async function setup() {
  const db = await newDb();
  await product(db, 'hanoi', 1, 'T100', 'Ly giu nhiet', HN_NOTE);
  await product(db, 'hanoi', 2, 'T200', 'Binh nuoc', 'T200 # 1T-50000');
  await customer(db, 'hanoi', 1, 'Khach Vua', { groups: 'Duy Thái' });
  await customer(db, 'hanoi', 2, 'Khach Ngung', { isActive: 'false' });
  await customer(db, 'saigon', 9, 'Khach SG');
  await product(db, 'saigon', 9, 'T100', 'Ly SG', 'T100 # 1T-30000');
  return db;
}
async function addInvoice(db, id, purchaseDate, price = 23700, customerId = 1) {
  await invoice(db, { id, purchaseDate, customerId, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 10, price }] });
}
const line = async (db, id = 1) => (await db.query(
  'SELECT original_status, minimum_unit_price::text AS min, original_amount::text AS amount, winning_source, reason, calculation FROM invoice_price_audit_lines WHERE invoice_id = $1', [id])).rows[0];
const valid = (over = {}) => ({ branch: 'hanoi', customerId: '1', productId: '1', priceNoVat: '23500', approver: 'Anh Quân', approvedOn: '2026-10-19', ...over });

test('migration 0091: chay lai an toan, unique, CHECK gia > 0, nhat ky bat bien', async () => {
  const db = await setup();
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0091_invoice_approved_prices.sql'), 'utf8');
    const sql92 = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '0092_invoice_approved_prices_vat_split.sql'), 'utf8');
    await db.exec(sql); // lan 2
    await db.exec(sql92); // 0092 chay lai an toan (cot cu da bo)
    const repo = createApprovedPriceRepository({ pool: pgliteAsPool(db), now: () => NOW });
    await repo.create(valid(), 'QL');
    await assert.rejects(repo.create(valid(), 'QL'), e => e.statusCode === 409 && e.code === 'DUPLICATE');
    await assert.rejects(db.query("INSERT INTO invoice_approved_prices (branch,customer_id,product_id,price_no_vat,approver,approved_on,created_by,updated_by) VALUES ('hanoi',1,1,0,'x','2026-10-19','a','a')"));
    await assert.rejects(db.query("UPDATE invoice_approved_price_changes SET actor = 'x'"), /immutable/);
    await assert.rejects(db.query('DELETE FROM invoice_approved_price_changes'), /immutable/);
  } finally { await db.close(); }
});

test('rules: gia / ngay / nguoi duyet / co so / khoa sort chi nhan gia tri hop le', () => {
  assert.equal(rules.parsePrice(23500), '23500');
  assert.equal(rules.parsePrice('023500.50'), '23500.50');
  for (const bad of [0, '0', -1, '', null, undefined, 'abc', '1e3', '1,000', '1.23456', true, Infinity]) {
    assert.throws(() => rules.parsePrice(bad), e => e.code === 'INVALID_PRICE', String(bad));
  }
  assert.ok(rules.isValidDay('2026-10-19'));
  assert.ok(!rules.isValidDay('2026-02-30'));
  assert.ok(!rules.isValidDay('19/10/2026'));
  assert.throws(() => rules.parseCreate(valid({ approver: 'Anh Ba' })), e => e.code === 'INVALID_APPROVER');
  assert.throws(() => rules.parseCreate(valid({ branch: 'both' })), e => e.code === 'INVALID_BRANCH');
  assert.throws(() => rules.parseCreate(valid({ customerId: 'x' })), e => e.code === 'INVALID_ID');
  assert.throws(() => rules.parseCreate(valid({ approvedOn: '2026-13-01' })), e => e.code === 'INVALID_DATE');
  assert.throws(() => rules.parseCreate({ ...valid(), extra: 1 }), e => e.statusCode === 400);
  assert.throws(() => rules.parseUpdate(valid()), e => /expectedVersion/.test(e.message));
  assert.equal(rules.parseUpdate({ ...valid(), expectedVersion: 2 }).expectedVersion, 2);
  assert.throws(() => rules.parseListQuery({ sort: 'id; DROP TABLE x' }), e => e.code === 'INVALID_SORT');
  assert.throws(() => rules.parseListQuery({ from: '2026-10-20', to: '2026-10-01' }), e => e.code === 'INVALID_RANGE');
  assert.deepEqual(rules.APPROVERS, ['Anh Quân', 'Anh Duy', 'Anh Duy Khánh']);
});

test('tao: khach / san pham khong co (hoac khach ngung hoat dong, sai co so) thi khong tao duoc', async () => {
  const db = await setup();
  try {
    const repo = createApprovedPriceRepository({ pool: pgliteAsPool(db), now: () => NOW });
    await assert.rejects(repo.create(valid({ customerId: '999' }), 'QL'), e => e.statusCode === 422 && e.code === 'CUSTOMER_NOT_FOUND');
    await assert.rejects(repo.create(valid({ customerId: '2' }), 'QL'), e => e.code === 'CUSTOMER_NOT_FOUND');
    await assert.rejects(repo.create(valid({ customerId: '9' }), 'QL'), e => e.code === 'CUSTOMER_NOT_FOUND'); // KH SG o co so HN
    await assert.rejects(repo.create(valid({ productId: '999' }), 'QL'), e => e.statusCode === 422 && e.code === 'PRODUCT_NOT_FOUND');
    assert.equal((await repo.list(rules.parseListQuery({}))).totalRows, 0);
    const { row } = await repo.create(valid(), 'Quan Ly A');
    assert.equal(row.customerName, 'Khach Vua');
    assert.equal(row.productCode, 'T100');
    assert.equal(row.productName, 'Ly giu nhiet');
    assert.equal(row.branchLabel, 'Hà Nội');
    assert.equal(row.priceNoVat, '23500');
    assert.equal(row.version, 1);
    const log = (await db.query('SELECT action, actor, before_value, after_value FROM invoice_approved_price_changes')).rows;
    assert.equal(log.length, 1);
    assert.equal(log[0].action, 'create');
    assert.equal(log[0].after_value.priceNoVat, '23500');
  } finally { await db.close(); }
});

test('ten khach / ma + ten SP lay theo Kiot luc doc: Kiot doi ten thi bang cap nhat theo', async () => {
  const db = await setup();
  try {
    const repo = createApprovedPriceRepository({ pool: pgliteAsPool(db), now: () => NOW });
    await repo.create(valid(), 'QL');
    await db.query("UPDATE customers SET name = 'Khach Vua (doi ten)', code = 'KH-MOI' WHERE branch = 'hanoi' AND id = 1");
    await db.query("UPDATE products SET name = 'Ly moi', code = 'T100X' WHERE branch = 'hanoi' AND id = 1");
    const { rows } = await repo.list(rules.parseListQuery({}));
    assert.equal(rows[0].customerName, 'Khach Vua (doi ten)');
    assert.equal(rows[0].customerCode, 'KH-MOI');
    assert.equal(rows[0].productCode, 'T100X');
    assert.equal(rows[0].productName, 'Ly moi');
  } finally { await db.close(); }
});

test('loc theo nguoi duyet / khoang ngay, sort moi cot hai chieu, phan trang va tie-break on dinh', async () => {
  const db = await setup();
  try {
    await customer(db, 'hanoi', 3, 'An Khach');
    await product(db, 'hanoi', 3, 'A001', 'Zeta', 'A001 # 1T-1000');
    const repo = createApprovedPriceRepository({ pool: pgliteAsPool(db), now: () => NOW });
    await repo.create(valid({ approver: 'Anh Quân', approvedOn: '2026-10-10', priceNoVat: '100' }), 'QL');
    await repo.create(valid({ productId: '3', approver: 'Anh Duy', approvedOn: '2026-10-15', priceNoVat: '300' }), 'QL');
    await repo.create(valid({ customerId: '3', productId: '3', approver: 'Anh Duy Khánh', approvedOn: '2026-10-20', priceNoVat: '200' }), 'QL');
    await repo.create({ ...valid({ branch: 'saigon', customerId: '9', productId: '9', approver: 'Anh Duy', approvedOn: '2026-10-15', priceNoVat: '150' }) }, 'QL');
    const q = extra => rules.parseListQuery(extra);
    const ids = async extra => (await repo.list(q(extra))).rows.map(r => r.priceNoVat);
    assert.deepEqual(await ids({sorts: JSON.stringify([{key:'approver',dir:'asc'},{key:'priceNoVat',dir:'desc'}])}), ['300','150','200','100']);
    assert.deepEqual(await ids({}), ['200', '150', '300', '100']); // mac dinh: ngay duyet moi nhat truoc, cung ngay -> id giam
    assert.equal((await repo.list(q({ approver: 'Anh Duy' }))).totalRows, 2);
    assert.deepEqual(await ids({ from: '2026-10-12', to: '2026-10-16' }), ['150', '300']);
    assert.deepEqual(await ids({ from: '2026-10-16' }), ['200']);
    assert.deepEqual(await ids({ sort: 'priceNoVat', dir: 'asc' }), ['100', '150', '200', '300']);
    assert.deepEqual(await ids({ sort: 'priceNoVat', dir: 'desc' }), ['300', '200', '150', '100']);
    assert.deepEqual((await repo.list(q({ sort: 'customerName' }))).rows[0].customerName, 'An Khach');
    assert.deepEqual((await repo.list(q({ sort: 'productName', dir: 'desc' }))).rows[0].productName, 'Zeta');
    assert.equal((await repo.list(q({ sort: 'productCode' }))).rows[0].productCode, 'A001');
    assert.equal((await repo.list(q({ sort: 'branch', dir: 'desc' }))).rows[0].branch, 'saigon');
    assert.equal((await repo.list(q({ sort: 'approver' }))).rows[0].approver, 'Anh Duy');
    assert.equal((await repo.list(q({ sort: 'approvedOn' }))).rows[0].approvedOn, '2026-10-10');
    const p1 = await repo.list(q({ pageSize: 3, page: 1 }));
    const p2 = await repo.list(q({ pageSize: 3, page: 2 }));
    assert.equal(p1.rows.length, 3);
    assert.equal(p2.rows.length, 1);
    assert.equal(p1.totalRows, 4);
    assert.equal((await repo.list(q({ approver: 'Anh Duy' }), { all: true })).rows.length, 2);
  } finally { await db.close(); }
});

test('ap gia duyet khi chup hoa don: thay gia toi thieu, hieu luc theo ngay duyet, lay ban moi nhat', async () => {
  const db = await setup();
  const pool = pgliteAsPool(db);
  try {
    const repo = createApprovedPriceRepository({ pool, now: () => NOW });
    // Khong co gia duyet: 23700 < 24000 => sai.
    await addInvoice(db, 1, '2026-10-18 10:00:00+00');
    await addInvoice(db, 2, '2026-10-20 10:00:00+00');
    await runDailyAudit({ day: '2026-10-20', pool, now: NOW, logger: quiet });
    assert.equal((await line(db, 1)).original_status, 'wrong');
    assert.equal((await line(db, 2)).original_status, 'wrong');

    // Gia duyet 23500 tu 19/10: hoa don 18/10 (truoc ngay duyet) khong doi; hoa don 20/10 thanh dung gia.
    const created = await repo.create(valid({ priceNoVat: '23500', approvedOn: '2026-10-19' }), 'QL');
    assert.equal(created.recalc.status, 'applied');
    assert.equal((await line(db, 1)).original_status, 'wrong');
    const l2 = await line(db, 2);
    assert.equal(l2.original_status, 'correct');
    assert.equal(l2.min, '23500');
    assert.equal(l2.winning_source, 'Giá duyệt');
    assert.equal(l2.reason, 'Theo giá duyệt');
    assert.equal(l2.calculation.approvedPrice.price, '23500');
    assert.equal(l2.calculation.approvedPrice.approvedOn, '2026-10-19');

    // Gia duyet moi hon 25000 tu 20/10 thay the ban cu: 23700 < 25000 => sai, chenh 1.300 x 10.
    await repo.create(valid({ priceNoVat: '25000', approvedOn: '2026-10-20' }), 'QL');
    const l2b = await line(db, 2);
    assert.equal(l2b.original_status, 'wrong');
    assert.equal(l2b.min, '25000');
    assert.equal(Number(l2b.amount), 13000);

    // Sua gia ve 23000 -> dung; xoa het -> tro lai tinh theo mo ta (sai).
    const second = (await repo.list(rules.parseListQuery({}))).rows[0];
    const upd = await repo.update(second.id, { ...valid({ priceNoVat: '23000', approvedOn: '2026-10-20' }), expectedVersion: second.version }, 'QL');
    assert.equal(upd.recalc.status, 'applied');
    assert.equal((await line(db, 2)).original_status, 'correct');
    const del = await repo.remove(second.id, upd.row.version, 'QL');
    assert.equal(del.recalc.status, 'applied');
    assert.equal((await line(db, 2)).min, '23500'); // quay lai ban 19/10
    await repo.remove(created.row.id, null, 'QL');
    const l2c = await line(db, 2);
    assert.equal(l2c.original_status, 'wrong');
    assert.equal(l2c.winning_source, 'HN');
    assert.equal(l2c.calculation.approvedPrice, null);
  } finally { await db.close(); }
});

test('gia duyet khong dong vao khach / san pham / co so khac; giu giai thich + Chot cua dong', async () => {
  const db = await setup();
  const pool = pgliteAsPool(db);
  try {
    const repo = createApprovedPriceRepository({ pool, now: () => NOW });
    await customer(db, 'hanoi', 3, 'Khach Khac');
    await addInvoice(db, 1, '2026-10-20 10:00:00+00');
    await addInvoice(db, 2, '2026-10-20 10:00:00+00', 23700, 3);
    await runDailyAudit({ day: '2026-10-20', pool, now: NOW, logger: quiet });
    await db.query("UPDATE invoice_price_audit_lines SET sale_explanation = 'ghi chu', decision = 'penalty', decided_by = 'QL', version = 4 WHERE invoice_id = 1");
    await repo.create(valid({ priceNoVat: '23000', approvedOn: '2026-10-20' }), 'QL');
    assert.equal((await line(db, 1)).original_status, 'correct');
    assert.equal((await line(db, 2)).original_status, 'wrong'); // khach khac khong bi anh huong
    const kept = (await db.query('SELECT sale_explanation, decision, version FROM invoice_price_audit_lines WHERE invoice_id = 1')).rows[0];
    assert.deepEqual([kept.sale_explanation, kept.decision, kept.version], ['ghi chu', 'penalty', 4]);
    // Gia duyet cua co so Sai Gon khong ap cho hoa don Ha Noi cung ma SP.
    await repo.create(valid({ branch: 'saigon', customerId: '9', productId: '9', priceNoVat: '1' }), 'QL');
    assert.equal((await line(db, 2)).original_status, 'wrong');
  } finally { await db.close(); }
});

test('sua: version lech -> 409 kem dong hien tai; chi doi nguoi duyet thi khong tinh lai; doi khach tinh lai ca hai', async () => {
  const db = await setup();
  const pool = pgliteAsPool(db);
  try {
    const repo = createApprovedPriceRepository({ pool, now: () => NOW });
    await customer(db, 'hanoi', 3, 'Khach Khac');
    await addInvoice(db, 1, '2026-10-20 10:00:00+00');
    await addInvoice(db, 2, '2026-10-20 10:00:00+00', 23700, 3);
    await runDailyAudit({ day: '2026-10-20', pool, now: NOW, logger: quiet });
    const { row } = await repo.create(valid({ priceNoVat: '23000', approvedOn: '2026-10-20' }), 'QL');
    await assert.rejects(repo.update(row.id, { ...valid({ approvedOn: '2026-10-20' }), expectedVersion: 7 }, 'QL'),
      e => e.statusCode === 409 && e.code === 'VERSION_CONFLICT' && e.row.id === row.id);
    await assert.rejects(repo.update('99999', { ...valid(), expectedVersion: 1 }, 'QL'), e => e.statusCode === 404);
    await assert.rejects(repo.update(row.id, { ...valid({ customerId: '999', approvedOn: '2026-10-20' }), expectedVersion: 1 }, 'QL'),
      e => e.code === 'CUSTOMER_NOT_FOUND');
    const same = await repo.update(row.id, { ...valid({ priceNoVat: '23000', approvedOn: '2026-10-20', approver: 'Anh Duy' }), expectedVersion: 1 }, 'QL');
    assert.equal(same.recalc.status, 'skipped');
    assert.equal(same.row.version, 2);
    assert.equal(same.row.approver, 'Anh Duy');
    // Doi sang khach 3: hoa don khach 1 tro lai sai, khach 3 thanh dung.
    const moved = await repo.update(row.id, { ...valid({ customerId: '3', priceNoVat: '23000', approvedOn: '2026-10-20' }), expectedVersion: 2 }, 'QL');
    assert.equal(moved.recalc.status, 'applied');
    assert.equal((await line(db, 1)).original_status, 'wrong');
    assert.equal((await line(db, 2)).original_status, 'correct');
    const actions = (await db.query('SELECT action FROM invoice_approved_price_changes ORDER BY id')).rows.map(r => r.action);
    assert.deepEqual(actions, ['create', 'update', 'update']);
    await assert.rejects(repo.remove(row.id, 1, 'QL'), e => e.statusCode === 409);
    await repo.remove(row.id, 3, 'QL');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_approved_prices')).rows[0].n, 0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM invoice_approved_price_changes WHERE action = 'delete'")).rows[0].n, 1);
  } finally { await db.close(); }
});

test('chua chay kiem tra gia lan nao: van luu gia duyet (recalc not_published); nguon loi -> luu van thanh cong, recalc failed', async () => {
  const db = await setup();
  const pool = pgliteAsPool(db);
  try {
    const repo = createApprovedPriceRepository({ pool, now: () => NOW });
    // Ngay duyet 21/10 (sau hoa don 20/10) nen chua ap cho hoa don nao.
    const first = await repo.create(valid({ approvedOn: '2026-10-21' }), 'QL');
    assert.equal(first.recalc.status, 'not_published');
    await addInvoice(db, 1, '2026-10-20 10:00:00+00');
    await runDailyAudit({ day: '2026-10-20', pool, now: NOW, logger: quiet });
    await db.query("DELETE FROM sheet_snapshot_sync WHERE source = 'shipping_measures'"); // nguon Can do chua san sang
    const second = await repo.create(valid({ approvedOn: '2026-10-20', priceNoVat: '22000' }), 'QL');
    assert.equal(second.recalc.status, 'failed');
    assert.match(second.recalc.message, /Cân đo|chưa/i);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_approved_prices')).rows[0].n, 2);
    assert.equal((await line(db, 1)).original_status, 'wrong'); // chua tinh lai
  } finally { await db.close(); }
});

test('goi y khach / san pham: loc gan dung bo dau theo co so, bo khach ngung hoat dong', async () => {
  const db = await setup();
  try {
    await customer(db, 'hanoi', 3, 'Nguyễn Văn Á');
    await product(db, 'hanoi', 3, 'ABC9', 'Bình giữ nhiệt', '');
    const repo = createApprovedPriceRepository({ pool: pgliteAsPool(db), now: () => NOW });
    assert.deepEqual((await repo.suggestCustomers('hanoi', 'nguyen van a')).map(r => r.name), ['Nguyễn Văn Á']);
    assert.deepEqual((await repo.suggestCustomers('hanoi', 'khach')).map(r => r.name).sort(), ['Khach Vua']); // Khach Ngung bi loai
    assert.deepEqual((await repo.suggestCustomers('saigon', 'khach')).map(r => r.name), ['Khach SG']);
    const [p] = await repo.suggestProducts('hanoi', 'binh giu');
    assert.deepEqual([p.code, p.name, typeof p.id], ['ABC9', 'Bình giữ nhiệt', 'string']);
    assert.equal((await repo.suggestProducts('hanoi', 'abc9'))[0].code, 'ABC9');
    assert.deepEqual(await repo.suggestProducts('hanoi', 'khong-co'), []);
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- HTTP

function makeApp({ repository, users }) {
  const requireAuth = (req, res, next) => {
    const stored = users[req.headers['x-user']];
    if (!stored) return res.status(401).json({ error: 'Chưa đăng nhập.' });
    req.user = { ...stored, permissions: resolvePermissions(stored) };
    return next();
  };
  const app = express();
  app.use('/api/invoice-approved-prices', createApprovedPriceRouter({ repository, requireAuth }));
  return app;
}
async function withServer(app, fn) {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/invoice-approved-prices`;
  try { return await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}
const call = async (base, p, { user, method = 'GET', body, raw } = {}) => {
  const headers = { 'content-type': 'application/json' };
  if (user) headers['x-user'] = user;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
};
const USERS = {
  ql: { id: 'ql', vaiTro: 'Quản lý', hoTen: 'Quản Lý A', featurePermissions: {} },
  tl: { id: 'tl', vaiTro: 'Trợ lý', hoTen: 'Trợ Lý', featurePermissions: {} },
  sale: { id: 'sale', vaiTro: 'Nhân viên sale', hoTen: 'Duy Thái', featurePermissions: {} },
  kt: { id: 'kt', vaiTro: 'Kế toán', hoTen: 'Kế Toán', featurePermissions: {} },
  viewer: { id: 'viewer', vaiTro: 'Trợ lý', hoTen: 'Trợ Lý Xem', featurePermissions: { 'reports.invoices.approvedPrice': true } },
  viewerSale: { id: 'viewerSale', vaiTro: 'Nhân viên sale', hoTen: 'Sale Xem', featurePermissions: { 'reports.invoices.approvedPrice': true } },
  manageOnly: { id: 'manageOnly', vaiTro: 'Trợ lý', hoTen: 'Chi Sua', featurePermissions: { 'reports.invoices.approvedPrice.manage': true } }
};

test('HTTP: quyen xem / tao-sua-xoa, no-store, tao 201, sua + xoa co xac nhan version, xuat Excel theo bo loc va sort', async () => {
  const db = await setup();
  try {
    const users = JSON.parse(JSON.stringify(USERS));
    const app = makeApp({ repository: createApprovedPriceRepository({ pool: pgliteAsPool(db), now: () => NOW }), users });
    await withServer(app, async base => {
      assert.equal((await call(base, '/')).status, 401);
      assert.equal((await call(base, '/', { user: 'kt' })).status, 403);
      // Bang nhay cam: Tro ly / Sale (du xem duoc Kiem tra gia ban) KHONG xem duoc neu khong duoc cap quyen rieng.
      for (const u of ['sale', 'tl']) {
        for (const p of ['/', '/export', '/customer-suggest?branch=hanoi&q=a', '/product-suggest?branch=hanoi&q=a']) {
          assert.equal((await call(base, p, { user: u })).status, 403, u + ' ' + p);
        }
      }
      // Duoc cap rieng quyen xem: chi xem, van khong tao / sua / xoa / goi y.
      for (const u of ['viewer', 'viewerSale']) {
        const view = await call(base, '/', { user: u });
        assert.equal(view.status, 200, u);
        assert.equal(view.headers.get('cache-control'), 'no-store');
        assert.equal(view.body.canManage, false);
        assert.deepEqual(view.body.options.approvers, ['Anh Quân', 'Anh Duy', 'Anh Duy Khánh']);
        assert.equal((await call(base, '/', { user: u, method: 'POST', body: valid() })).status, 403, u);
        assert.equal((await call(base, '/1', { user: u, method: 'PUT', body: { ...valid(), expectedVersion: 1 } })).status, 403, u);
        assert.equal((await call(base, '/1', { user: u, method: 'DELETE' })).status, 403, u);
        assert.equal((await call(base, '/customer-suggest?branch=hanoi&q=a', { user: u })).status, 403, u);
      }
      // Chi cap quyen tao / sua / xoa ma khong cap quyen xem thi quyen do bi vo hieu (requires).
      assert.equal((await call(base, '/', { user: 'manageOnly', method: 'POST', body: valid() })).status, 403);
      assert.equal((await call(base, '/', { user: 'ql' })).body.canManage, true);

      assert.equal((await call(base, '/', { user: 'ql', method: 'POST', body: valid({ customerId: '999' }) })).status, 422);
      assert.equal((await call(base, '/', { user: 'ql', method: 'POST', body: valid({ approver: 'Ai do' }) })).status, 400);
      const created = await call(base, '/', { user: 'ql', method: 'POST', body: valid() });
      assert.equal(created.status, 201);
      assert.equal(created.body.row.customerName, 'Khach Vua');
      assert.equal((await call(base, '/', { user: 'ql', method: 'POST', body: valid() })).status, 409);
      const id = created.body.row.id;
      assert.equal((await call(base, `/${id}`, { user: 'ql', method: 'PUT', body: { ...valid({ priceNoVat: 23600 }), expectedVersion: 5 } })).status, 409);
      const put = await call(base, `/${id}`, { user: 'ql', method: 'PUT', body: { ...valid({ priceNoVat: 23600 }), expectedVersion: 1 } });
      assert.equal(put.status, 200);
      assert.equal(put.body.row.priceNoVat, '23600');
      assert.equal(put.body.row.version, 2);
      assert.equal((await call(base, '/abc', { user: 'ql', method: 'DELETE' })).status, 400);

      const sug = await call(base, '/customer-suggest?branch=hanoi&q=khach', { user: 'ql' });
      assert.deepEqual(sug.body.results.map(r => r.name), ['Khach Vua']);
      assert.equal((await call(base, '/customer-suggest?branch=xx&q=a', { user: 'ql' })).status, 400);
      assert.equal((await call(base, '/product-suggest?branch=hanoi&q=T200', { user: 'ql' })).body.results[0].code, 'T200');

      // Loc + sort qua query; tham so sai -> 400.
      await call(base, '/', { user: 'ql', method: 'POST', body: valid({ productId: '2', approver: 'Anh Duy', approvedOn: '2026-10-21', priceNoVat: '50000' }) });
      const filtered = await call(base, '/?approver=Anh%20Duy&sort=priceNoVat&dir=desc', { user: 'viewer' });
      assert.equal(filtered.body.totalRows, 1);
      assert.equal(filtered.body.rows[0].priceNoVat, '50000');
      assert.equal((await call(base, '/?sort=hack', { user: 'viewer' })).status, 400);
      assert.equal((await call(base, '/?approver=Ai', { user: 'viewer' })).status, 400);

      // Xuat Excel: can reports.export (Sale khong co), dung tap loc + thu tu sort.
      assert.equal((await call(base, '/export', { user: 'viewerSale' })).status, 403);
      const xlsx = await call(base, '/export?sort=priceNoVat&dir=asc', { user: 'ql', raw: true });
      assert.equal(xlsx.status, 200);
      assert.match(xlsx.headers.get('content-disposition'), /TKS_Gia_duyet\.xlsx/);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(xlsx.buffer);
      const sheet = wb.getWorksheet('Giá duyệt');
      assert.deepEqual(sheet.getRow(1).values.slice(1), ['Khách hàng', 'Mã KH', 'Cơ sở', 'Mã SP', 'Tên SP', 'Giá không VAT', 'Giá có VAT', 'Người duyệt', 'Ngày duyệt']);
      assert.equal(sheet.rowCount, 3);
      assert.deepEqual([1, 2, 3, 4, 5, 6, 8, 9].map(c => sheet.getRow(2).getCell(c).value), ['Khach Vua', 'KH1', 'Hà Nội', 'T100', 'Ly giu nhiet', 23600, 'Anh Quân', '19/10/2026']);
      assert.equal(sheet.getRow(2).getCell(7).value, null, 'giá có VAT để trống thì ô trống');
      assert.equal(sheet.getRow(3).getCell(6).value, 50000);
      const onlyDuy = await call(base, '/export?approver=Anh%20Duy', { user: 'ql', raw: true });
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.load(onlyDuy.buffer);
      assert.equal(wb2.getWorksheet('Giá duyệt').rowCount, 2);

      const del = await call(base, `/${id}?expectedVersion=2`, { user: 'ql', method: 'DELETE' });
      assert.equal(del.status, 200);
      assert.equal((await call(base, `/${id}`, { user: 'ql', method: 'DELETE' })).status, 404);
      // Thu hoi quyen co hieu luc ngay.
      users.ql.featurePermissions = { 'reports.invoices.approvedPrice.manage': false };
      assert.equal((await call(base, '/', { user: 'ql', method: 'POST', body: valid() })).status, 403);
    });
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- 2 gia: khong VAT / co VAT (migration 0092)

test('rules: 2 gia tuy chon, can it nhat 1; de trong = null; gia co nhap phai > 0', () => {
  const base = { branch: 'hanoi', customerId: '1', productId: '1', approver: 'Anh Quân', approvedOn: '2026-10-19' };
  assert.deepEqual([rules.parseCreate({ ...base, priceNoVat: '23500' }).priceNoVat, rules.parseCreate({ ...base, priceNoVat: '23500' }).priceWithVat], ['23500', null]);
  const withVat = rules.parseCreate({ ...base, priceNoVat: '', priceWithVat: 25850 });
  assert.deepEqual([withVat.priceNoVat, withVat.priceWithVat], [null, '25850']);
  const both = rules.parseCreate({ ...base, priceNoVat: '23500', priceWithVat: '25850.5' });
  assert.deepEqual([both.priceNoVat, both.priceWithVat], ['23500', '25850.5']);
  for (const body of [{}, { priceNoVat: null, priceWithVat: null }, { priceNoVat: '', priceWithVat: '' }]) {
    assert.throws(() => rules.parseCreate({ ...base, ...body }), e => e.code === 'PRICE_REQUIRED', JSON.stringify(body));
  }
  for (const bad of [0, '0', -5, 'abc', '1,000']) {
    assert.throws(() => rules.parseCreate({ ...base, priceNoVat: '100', priceWithVat: bad }), e => e.code === 'INVALID_PRICE', String(bad));
    assert.throws(() => rules.parseCreate({ ...base, priceNoVat: bad }), e => e.code === 'INVALID_PRICE', String(bad));
  }
  assert.throws(() => rules.parseCreate({ ...base, priceNoVat: '1', approvedPrice: '1' }), e => e.statusCode === 400, 'khoa cu approvedPrice khong con');
  assert.ok(rules.SORT_KEYS.includes('priceNoVat') && rules.SORT_KEYS.includes('priceWithVat') && !rules.SORT_KEYS.includes('approvedPrice'));
});

test('DB: CHECK it nhat 1 gia > 0; ban ghi cu (approved_price) duoc doi sang ca 2 cot khi chay 0092', async () => {
  const db = await setup();
  try {
    await assert.rejects(db.query("INSERT INTO invoice_approved_prices (branch,customer_id,product_id,approver,approved_on,created_by,updated_by) VALUES ('hanoi',1,1,'x','2026-10-19','a','a')"));
    await assert.rejects(db.query("INSERT INTO invoice_approved_prices (branch,customer_id,product_id,price_with_vat,approver,approved_on,created_by,updated_by) VALUES ('hanoi',1,1,0,'x','2026-10-19','a','a')"));
    await db.query("INSERT INTO invoice_approved_prices (branch,customer_id,product_id,price_with_vat,approver,approved_on,created_by,updated_by) VALUES ('hanoi',1,1,100,'x','2026-10-19','a','a')");
  } finally { await db.close(); }
  // Lo trinh that: DB da co 0091 voi 1 ban ghi cu 1 gia -> 0092 giu hanh vi (ap cho ca 2 loai hoa don).
  const { PGlite } = require('@electric-sql/pglite');
  const old = new PGlite();
  try {
    const sqlOf = file => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8');
    await old.exec(sqlOf('0091_invoice_approved_prices.sql'));
    await old.query("INSERT INTO invoice_approved_prices (branch,customer_id,product_id,approved_price,approver,approved_on,created_by,updated_by) VALUES ('hanoi',1,1,23500,'Anh Duy','2026-10-19','a','a')");
    await old.exec(sqlOf('0092_invoice_approved_prices_vat_split.sql'));
    await old.exec(sqlOf('0092_invoice_approved_prices_vat_split.sql'));
    const r = (await old.query('SELECT price_no_vat::text AS a, price_with_vat::text AS b FROM invoice_approved_prices')).rows[0];
    assert.deepEqual([r.a, r.b], ['23500', '23500']);
    const cols = (await old.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'invoice_approved_prices'")).rows.map(c => c.column_name);
    assert.ok(!cols.includes('approved_price'));
  } finally { await old.close(); }
});

// HN_NOTE: cap Vua min 24000, VAT +2000 -> hoa don Full VAT min 26000. Ghi chu hoa don co "VAT" => Full VAT.
async function addVatInvoice(db, id, purchaseDate, price) {
  await invoice(db, { id, purchaseDate, customerId: 1, note: 'Full VAT', lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 10, price }] });
}

test('hoa don Full VAT dung gia CO VAT, hoa don khong VAT dung gia KHONG VAT; loai gia de trong thi KHONG ap', async () => {
  const db = await setup();
  const pool = pgliteAsPool(db);
  try {
    const repo = createApprovedPriceRepository({ pool, now: () => NOW });
    await addInvoice(db, 1, '2026-10-20 10:00:00+00', 23700);          // khong VAT: min 24000 -> sai
    await addVatInvoice(db, 2, '2026-10-20 11:00:00+00', 25500);      // Full VAT: min 26000 -> sai
    await runDailyAudit({ day: '2026-10-20', pool, now: NOW, logger: quiet });
    assert.equal((await line(db, 1)).original_status, 'wrong');
    assert.equal((await line(db, 2)).original_status, 'wrong');
    assert.equal((await line(db, 2)).min, '26000');

    // Chi nhap gia KHONG VAT 23500: hoa don khong VAT thanh dung; hoa don Full VAT KHONG duoc ap (van min 26000).
    const only = await repo.create(valid({ priceNoVat: '23500', priceWithVat: null, approvedOn: '2026-10-20' }), 'QL');
    assert.equal(only.recalc.status, 'applied');
    const a1 = await line(db, 1);
    assert.deepEqual([a1.original_status, a1.min, a1.winning_source, a1.calculation.approvedPrice.kind], ['correct', '23500', 'Giá duyệt', 'no_vat']);
    const a2 = await line(db, 2);
    assert.deepEqual([a2.original_status, a2.min, a2.winning_source, a2.calculation.approvedPrice], ['wrong', '26000', 'HN', null]);

    // Sua them gia CO VAT 25800: hoa don Full VAT (25500 < 25800) van sai nhung theo gia duyet, chenh 300 x 10.
    const upd = await repo.update(only.row.id, { ...valid({ priceNoVat: '23500', priceWithVat: '25800', approvedOn: '2026-10-20' }), expectedVersion: 1 }, 'QL');
    assert.equal(upd.recalc.status, 'applied');
    const b2 = await line(db, 2);
    assert.deepEqual([b2.original_status, b2.min, Number(b2.amount), b2.winning_source, b2.reason, b2.calculation.approvedPrice.kind],
      ['wrong', '25800', 3000, 'Giá duyệt', 'Theo giá duyệt', 'vat']);
    // Doi gia co VAT xuong 25500: hoa don Full VAT dung gia.
    await repo.update(only.row.id, { ...valid({ priceNoVat: '23500', priceWithVat: '25500', approvedOn: '2026-10-20' }), expectedVersion: 2 }, 'QL');
    assert.equal((await line(db, 2)).original_status, 'correct');
    // Bo gia KHONG VAT (chi con co VAT): hoa don khong VAT tro lai tinh theo mo ta.
    await repo.update(only.row.id, { ...valid({ priceNoVat: null, priceWithVat: '25500', approvedOn: '2026-10-20' }), expectedVersion: 3 }, 'QL');
    assert.equal((await line(db, 1)).original_status, 'wrong');
    assert.equal((await line(db, 1)).winning_source, 'HN');
    assert.equal((await line(db, 2)).original_status, 'correct');
  } finally { await db.close(); }
});

test('moi loai gia xet rieng: ban ghi moi hon de trong loai gia can dung thi lay ban cu hon co loai gia do', async () => {
  const db = await setup();
  const pool = pgliteAsPool(db);
  try {
    const repo = createApprovedPriceRepository({ pool, now: () => NOW });
    await addInvoice(db, 1, '2026-10-20 10:00:00+00', 23700);
    await addVatInvoice(db, 2, '2026-10-20 11:00:00+00', 25500);
    await runDailyAudit({ day: '2026-10-20', pool, now: NOW, logger: quiet });
    await repo.create(valid({ priceNoVat: '23000', priceWithVat: '25000', approvedOn: '2026-10-10' }), 'QL');   // ca hai
    await repo.create(valid({ priceNoVat: null, priceWithVat: '26500', approvedOn: '2026-10-15' }), 'QL');      // moi hon, chi co VAT
    const l1 = await line(db, 1);   // khong VAT: ban 15/10 khong co gia khong VAT -> lay ban 10/10
    assert.deepEqual([l1.original_status, l1.min, l1.calculation.approvedPrice.approvedOn], ['correct', '23000', '2026-10-10']);
    const l2 = await line(db, 2);   // Full VAT: ban 15/10 moi nhat va co gia co VAT
    assert.deepEqual([l2.original_status, l2.min, l2.calculation.approvedPrice.approvedOn], ['wrong', '26500', '2026-10-15']);
  } finally { await db.close(); }
});

test('HTTP: tao chi voi gia co VAT / ca 2 gia, ca 2 de trong -> 400, sort + loc theo 2 cot gia', async () => {
  const db = await setup();
  try {
    const app = makeApp({ repository: createApprovedPriceRepository({ pool: pgliteAsPool(db), now: () => NOW }), users: JSON.parse(JSON.stringify(USERS)) });
    await withServer(app, async base => {
      const post = body => call(base, '/', { user: 'ql', method: 'POST', body });
      const none = await post({ branch: 'hanoi', customerId: '1', productId: '1', approver: 'Anh Duy', approvedOn: '2026-10-19' });
      assert.equal(none.status, 400);
      assert.equal(none.body.code, 'PRICE_REQUIRED');
      assert.equal((await post({ branch: 'hanoi', customerId: '1', productId: '1', priceNoVat: '', priceWithVat: '', approver: 'Anh Duy', approvedOn: '2026-10-19' })).status, 400);
      const vatOnly = await post({ branch: 'hanoi', customerId: '1', productId: '1', priceNoVat: null, priceWithVat: '25850', approver: 'Anh Duy', approvedOn: '2026-10-19' });
      assert.equal(vatOnly.status, 201);
      assert.deepEqual([vatOnly.body.row.priceNoVat, vatOnly.body.row.priceWithVat], [null, '25850']);
      const both = await post({ branch: 'hanoi', customerId: '1', productId: '2', priceNoVat: '49000', priceWithVat: '53900', approver: 'Anh Quân', approvedOn: '2026-10-20' });
      assert.equal(both.status, 201);
      const asc = await call(base, '/?sort=priceNoVat&dir=asc', { user: 'ql' });
      assert.deepEqual(asc.body.rows.map(r => r.priceNoVat), ['49000', null], 'giá để trống xếp cuối');
      const desc = await call(base, '/?sort=priceWithVat&dir=desc', { user: 'ql' });
      assert.deepEqual(desc.body.rows.map(r => r.priceWithVat), ['53900', '25850']);
      assert.equal((await call(base, '/?sort=approvedPrice', { user: 'ql' })).status, 400);
    });
  } finally { await db.close(); }
});

// ---------------------------------------------------------------- import file

async function sheetBuffer(rows, header = ['Mã KH', 'Cơ sở', 'Mã SP', 'Giá không VAT', 'Giá có VAT', 'Người duyệt', 'Ngày duyệt']) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Giá duyệt');
  ws.addRow(header);
  rows.forEach(r => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function postImport(base, user, buffer, { commit = false, name = 'gia-duyet.xlsx' } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  const res = await fetch(`${base}/import${commit ? '?commit=1' : ''}`, { method: 'POST', headers: { 'x-user': user }, body: form });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('import: doc file + kiem tra tung dong (ten cot linh hoat, so/ngay Excel, cac gia tri sai)', async () => {
  const { parseImportWorkbook, validateRow } = require('./approvedPriceImport');
  const buf = await sheetBuffer([
    ['kh1', 'HN', 't100', 23500, '', 'anh quan', new Date(Date.UTC(2026, 9, 19))],
    ['KH1', 'Sài Gòn', 'T100', '23.500', '25,850', 'Anh Duy', '19/10/2026'],
    ['', '', '', '', '', '', '']
  ]);
  const rows = parseImportWorkbook(buf, { fileName: 'a.xlsx' });
  assert.equal(rows.length, 2, 'dong trong bi bo');
  assert.deepEqual(validateRow(rows[0]), { ok: true, value: { branch: 'hanoi', customerCode: 'kh1', productCode: 't100',
    priceNoVat: '23500', priceWithVat: null, approver: 'Anh Quân', approvedOn: '2026-10-19' } });
  const v2 = validateRow(rows[1]);
  assert.equal(v2.ok, true);
  assert.deepEqual([v2.value.branch, v2.value.priceNoVat, v2.value.priceWithVat, v2.value.approvedOn], ['saigon', '23500', '25850', '2026-10-19']);
  assert.match(validateRow({ ...rows[0], branch: 'Da Nang' }).message, /Cơ sở/);
  assert.match(validateRow({ ...rows[0], approver: 'Ai do' }).message, /Người duyệt/);
  assert.match(validateRow({ ...rows[0], approvedOn: '2026-02-30' }).message, /Ngày duyệt/);
  assert.match(validateRow({ ...rows[0], priceNoVat: '', priceWithVat: '' }).message, /ít nhất một/);
  assert.match(validateRow({ ...rows[0], priceNoVat: '-5' }).message, /Giá không VAT/);
  assert.throws(() => parseImportWorkbook(buf.subarray(0, 40), { fileName: 'a.xlsx' }), e => e.code === 'IMPORT_UNREADABLE');
  const noPrice = await sheetBuffer([['KH1', 'HN', 'T100', 'Anh Duy', '2026-10-19']], ['Mã KH', 'Cơ sở', 'Mã SP', 'Người duyệt', 'Ngày duyệt']);
  assert.throws(() => parseImportWorkbook(noPrice, { fileName: 'a.xlsx' }), e => e.code === 'IMPORT_HEADERS_MISSING' && /Giá không VAT hoặc Giá có VAT/.test(e.message));
});

test('HTTP import: xem truoc khong ghi; commit tao + ghi de + bo dong loi, tinh lai Kiem tra gia 1 lan; quyen manage', async () => {
  const db = await setup();
  try {
    await addInvoice(db, 1, '2026-10-19 08:00:00+00'); // sai 3.000 neu khong co gia duyet (min 24000, ban 23700)
    await runDailyAudit({ day: '2026-10-20', pool: pgliteAsPool(db), now: NOW, logger: quiet });
    assert.equal((await line(db, 1)).original_status, 'wrong');
    const repo = createApprovedPriceRepository({ pool: pgliteAsPool(db), now: () => NOW });
    const app = makeApp({ repository: repo, users: JSON.parse(JSON.stringify(USERS)) });
    await withServer(app, async base => {
      const buf = await sheetBuffer([
        ['KH1', 'Hà Nội', 'T100', 23500, '', 'Anh Quân', '19/10/2026'],     // tao
        ['KH1', 'Hà Nội', 'T200', 49000, '', 'Anh Duy', '19/10/2026'],       // tao
        ['KH999', 'Hà Nội', 'T100', 1000, '', 'Anh Duy', '19/10/2026'],      // loi: khach khong co
        ['KH2', 'Hà Nội', 'T100', 1000, '', 'Anh Duy', '19/10/2026'],        // loi: khach ngung hoat dong
        ['KH1', 'Hà Nội', 'T100', 23900, '', 'Anh Quân', '19/10/2026'],      // loi: trung dong 1 trong file
        ['KH9', 'Sài Gòn', 'T100', 29000, 31000, 'Anh Quân', '19/10/2026']   // tao SG
      ]);
      assert.equal((await postImport(base, 'viewer', buf)).status, 403, 'chi xem khong nhap duoc');
      assert.equal((await postImport(base, 'sale', buf)).status, 403);
      assert.equal((await postImport(base, 'ql', buf, { name: 'x.txt' })).status, 400);

      const preview = await postImport(base, 'ql', buf);
      assert.equal(preview.status, 200);
      assert.equal(preview.body.commit, false);
      assert.deepEqual(preview.body.summary, { total: 6, create: 3, update: 0, unchanged: 0, error: 3 });
      assert.deepEqual(preview.body.rows.map(r => r.status), ['create', 'create', 'error', 'error', 'error', 'create']);
      assert.match(preview.body.rows[2].message, /KH999/);
      assert.match(preview.body.rows[3].message, /ngừng hoạt động/);
      assert.match(preview.body.rows[4].message, /Trùng dòng 2/);
      assert.equal(preview.body.rows[0].customerName, 'Khach Vua');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_approved_prices')).rows[0].n, 0, 'xem truoc khong ghi');
      assert.equal((await line(db, 1)).original_status, 'wrong');

      const done = await postImport(base, 'ql', buf, { commit: true });
      assert.equal(done.status, 200);
      assert.deepEqual(done.body.summary, { total: 6, create: 3, update: 0, unchanged: 0, error: 3 });
      assert.equal(done.body.recalc.status, 'applied');
      assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_approved_prices')).rows[0].n, 3);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM invoice_approved_price_changes WHERE action = 'create'")).rows[0].n, 3);
      const l = await line(db, 1);
      assert.deepEqual([l.original_status, l.min, l.reason], ['correct', '23500', 'Theo giá duyệt']);

      // Nhap lai: giong het -> khong doi; doi gia + nguoi duyet -> ghi de (version + 1, nhat ky 'update', tinh lai).
      const again = await postImport(base, 'ql', await sheetBuffer([
        ['KH1', 'Hà Nội', 'T100', 23500, '', 'Anh Quân', '19/10/2026'],
        ['kh1', 'HN', 't200', 50000, 54000, 'Anh Duy Khánh', '2026-10-19']
      ]), { commit: true });
      assert.deepEqual(again.body.summary, { total: 2, create: 0, update: 1, unchanged: 1, error: 0 });
      const t200 = (await db.query('SELECT price_no_vat::text AS nv, price_with_vat::text AS wv, approver, version FROM invoice_approved_prices WHERE product_id = 2')).rows[0];
      assert.deepEqual([t200.nv, t200.wv, t200.approver, Number(t200.version)], ['50000', '54000', 'Anh Duy Khánh', 2]);
      assert.equal((await db.query("SELECT count(*)::int AS n FROM invoice_approved_price_changes WHERE action = 'update'")).rows[0].n, 1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_approved_prices')).rows[0].n, 3, 'ghi de, khong tao ban ghi trung');
    });
  } finally { await db.close(); }
});
