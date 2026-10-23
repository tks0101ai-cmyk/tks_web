'use strict';

// Chup hoa don + doc bang "Kiem tra gia ban" tren PGlite voi schema THAT (migration 0001-0006, 0012, 0064, 0077).

const test = require('node:test');
const assert = require('node:assert/strict');
const { captureUnseenInvoices, createPriceAuditRepository, SOURCE_NOT_READY } = require('./priceAuditRepository');
const { HN_NOTE, FREIGHT_NAME, newDb: newFixtureDb, product, customer, invoice } = require('./priceAuditFixtures');

const DAY = '2026-10-20';
const NOW = new Date('2026-10-20T16:00:00Z'); // 23:00 VN

const newDb = ({ measuresSynced = true } = {}) => newFixtureDb({ measuresSynced, syncedAt: NOW });
async function capture(db, day = DAY) {
  return db.transaction(tx => captureUnseenInvoices({ day, client: tx, now: NOW }));
}
async function lines(db, where = 'TRUE') {
  const { rows } = await db.query(`SELECT invoice_id::text AS id, source_line_no AS no, product_code,
      minimum_unit_price::text AS min, unit_shortfall::text AS short, original_amount::text AS amount, original_status AS status,
      reason, winning_source, customer_level, total_code_quantity::text AS total, full_vat, freight_per_unit::text AS freight,
      minimum_hn::text AS min_hn, minimum_sg::text AS min_sg, vat_hn::text AS vat_hn, vat_sg::text AS vat_sg,
      net_unit_price::text AS net, sale_name, customer_name
    FROM invoice_price_audit_lines WHERE ${where} ORDER BY branch, invoice_id, source_line_no`);
  return rows;
}
const pick = (rows, keys) => rows.map(r => Object.fromEntries(keys.map(k => [k, r[k]])));

test('local level changes affect new captures across HN/SG; email edits never alter old snapshots', async () => {
  const db = await newDb();
  try {
    await product(db,'hanoi',1,'T100','Ly',HN_NOTE);
    await product(db,'saigon',1,'T100','Ly',HN_NOTE);
    await customer(db,'hanoi',1,'Cùng Khách',{email:'lon@x'});
    await customer(db,'saigon',2,'cùng  khách',{email:'lon@x'});
    const detail = [{productId:1,code:'T100',name:'Ly',qty:1,price:1}];
    await invoice(db,{id:901,customerId:1,lines:detail});
    await capture(db);
    const before = (await db.query('SELECT * FROM invoice_price_audit_lines WHERE invoice_id=901')).rows;
    await db.query("UPDATE customer_price_levels SET level='vip',version=version+1 WHERE customer_key='cùng khách'");
    await db.query("UPDATE customers SET raw=jsonb_set(raw,'{email}','\"vua@x\"')");
    await invoice(db,{branch:'saigon',id:902,customerId:2,lines:detail});
    await capture(db);
    assert.deepEqual((await db.query('SELECT * FROM invoice_price_audit_lines WHERE invoice_id=901')).rows,before);
    assert.equal((await lines(db,'invoice_id=902'))[0].customer_level,'VIP');
    assert.equal((await lines(db,'invoice_id=902'))[0].min,'23600');
    await db.query('UPDATE customer_price_level_state SET initialized_at=NULL WHERE id');
    await invoice(db,{id:903,customerId:1,lines:detail});
    await assert.rejects(capture(db),{code:SOURCE_NOT_READY});
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_price_audit_invoices WHERE invoice_id=903')).rows[0].n,0);
  } finally { await db.close(); }
});

// Khach chuan HN cap Vua.
async function baseHn(db) {
  await product(db, 'hanoi', 1, 'T100', 'Ly giu nhiet', HN_NOTE);
  await customer(db, 'hanoi', 1, 'Khach Vua', { groups: 'Duy Thái' });
}

test('Nguong: tong SL cung ma quyet dinh bac (1..1001)', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    const qtys = [1, 99, 100, 299, 300, 499, 500, 999, 1000, 1001];
    for (const [i, qty] of qtys.entries()) {
      await invoice(db, { id: 100 + i, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty, price: 1 }] });
    }
    const res = await capture(db);
    assert.deepEqual(res, { addedInvoices: 10, addedLines: 10 });
    assert.deepEqual((await lines(db)).map(r => r.min),
      ['24000', '24000', '24000', '24000', '23800', '23800', '23600', '23600', '23000', '23000']);
  } finally { await db.close(); }
});

test('Cong dong: 200 + 100 cung ma trong 1 hoa don cung xet 300; hai hoa don rieng khong cong; SL <= 0 khong chup', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    await product(db, 'hanoi', 2, 'B200', 'Binh', 'T10 # 1T-5000');
    await invoice(db, { id: 1, customerId: 1, lines: [
      { productId: 1, code: 'T100', name: 'Ly', qty: 200, price: 23800 },
      { productId: 2, code: 'B200', name: 'Binh', qty: 0, price: 1 },
      { productId: 2, code: 'B200', name: 'Binh', qty: 50, price: 5000 },
      { productId: 1, code: ' t100 ', name: 'Ly', qty: 100, price: 23800 }] });
    await invoice(db, { id: 2, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 200, price: 23800 }] });
    await invoice(db, { id: 3, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 100, price: 23800 }] });
    assert.deepEqual(await capture(db), { addedInvoices: 3, addedLines: 5 });
    assert.deepEqual(pick(await lines(db), ['id', 'no', 'total', 'min', 'status']), [
      { id: '1', no: 1, total: '300', min: '23800', status: 'correct' },
      { id: '1', no: 3, total: '50', min: '5000', status: 'correct' },
      { id: '1', no: 4, total: '300', min: '23800', status: 'correct' },
      { id: '2', no: 1, total: '200', min: '24000', status: 'wrong' },
      { id: '3', no: 1, total: '100', min: '24000', status: 'wrong' }
    ]);
  } finally { await db.close(); }
});

test('Cap khach: Vua du bac Lon huong gia Lon; VIP mua it huong VIP; bac 4 cho moi cap; email trong = Lon, email la = Vua', async () => {
  const db = await newDb();
  try {
    await product(db, 'hanoi', 1, 'T100', 'Ly', HN_NOTE);
    await customer(db, 'hanoi', 1, 'Vua', { email: 'abc@gmail.com' });
    await customer(db, 'hanoi', 2, 'Vip', { Email: ' VIP @tokosi.vn' });
    await customer(db, 'hanoi', 3, 'Lon', { email: 'Lớn@x.vn' });
    await customer(db, 'hanoi', 4, 'Rong', { email: '' });
    const ln = qty => [{ productId: 1, code: 'T100', name: 'Ly', qty, price: 1 }];
    await invoice(db, { id: 1, customerId: 1, lines: ln(300) });
    await invoice(db, { id: 2, customerId: 2, lines: ln(10) });
    await invoice(db, { id: 3, customerId: 3, lines: ln(10) });
    await invoice(db, { id: 4, customerId: 4, lines: ln(10) });
    await invoice(db, { id: 5, customerId: 1, lines: ln(1000) });
    await invoice(db, { id: 6, customerId: 2, lines: ln(1000) });
    await invoice(db, { id: 7, customerId: null, customerName: 'Khách lẻ', lines: ln(10) });
    await capture(db);
    assert.deepEqual(pick(await lines(db), ['id', 'customer_level', 'min']), [
      { id: '1', customer_level: 'Vừa', min: '23800' },
      { id: '2', customer_level: 'VIP', min: '23600' },
      { id: '3', customer_level: 'Lớn', min: '23800' },
      { id: '4', customer_level: 'Lớn', min: '23800' },
      { id: '5', customer_level: 'Vừa', min: '23000' },
      { id: '6', customer_level: 'VIP', min: '23000' },
      { id: '7', customer_level: 'Lớn', min: '23800' }
    ]);
  } finally { await db.close(); }
});

test('Bac thieu: -T -- khong tao gia 0; mo ta trong = Dung gia, ly do khong co gia; thieu chiec/thung van dung gia cap', async () => {
  const db = await newDb();
  try {
    await product(db, 'hanoi', 1, 'T30', 'Coc', 'T30 # 1T -24000 | -T -- | 5T- 23000');
    await product(db, 'hanoi', 2, 'NOP', 'Khong gia', '');
    await product(db, 'hanoi', 3, 'NOC', 'Khong thung', '1T-24000 | 3T-23800');
    await customer(db, 'hanoi', 1, 'Lon', { email: 'lon@x' });
    await customer(db, 'hanoi', 2, 'Vip', { email: 'vip@x' });
    await invoice(db, { id: 1, customerId: 1, lines: [
      { productId: 1, code: 'T30', name: 'Coc', qty: 10, price: 20000 },
      { productId: 2, code: 'NOP', name: 'Khong gia', qty: 10, price: 1 },
      { productId: 3, code: 'NOC', name: 'Khong thung', qty: 1000, price: 23800 }] });
    await invoice(db, { id: 2, customerId: 2, lines: [{ productId: 3, code: 'NOC', name: 'Khong thung', qty: 5, price: 1 }] });
    await capture(db);
    assert.deepEqual(pick(await lines(db), ['id', 'no', 'min', 'short', 'amount', 'status', 'reason', 'winning_source']), [
      { id: '1', no: 1, min: '24000', short: '4000', amount: '40000', status: 'wrong', reason: 'Theo giá quy định', winning_source: 'HN' },
      { id: '1', no: 2, min: null, short: null, amount: '0', status: 'correct', reason: 'Không có giá quy định', winning_source: 'Không xét' },
      { id: '1', no: 3, min: '23800', short: '0', amount: '0', status: 'correct', reason: 'Theo giá quy định', winning_source: 'HN' },
      { id: '2', no: 1, min: null, short: null, amount: '0', status: 'correct', reason: 'Không có giá quy định', winning_source: 'Không xét' }
    ]);
  } finally { await db.close(); }
});

test('VAT: ghi chu dong chi ap dong do; ghi chu don ap moi dong; thieu VAT = 0', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    await product(db, 'hanoi', 2, 'NV', 'Khong VAT', 'T10 # 1T-5000');
    const l = (note, pid = 1) => ({ productId: pid, code: pid === 1 ? 'T100' : 'NV', name: 'x', qty: 1, price: 1, note });
    await invoice(db, { id: 1, customerId: 1, lines: [l('khach lay FULLVAT'), l('')] });
    await invoice(db, { id: 2, customerId: 1, note: 'xuat   Full   Vat  nhe', lines: [l(''), l('', 2)] });
    await invoice(db, { id: 3, customerId: 1, lines: [l('fullvatx')] });
    await capture(db);
    assert.deepEqual(pick(await lines(db), ['id', 'no', 'full_vat', 'vat_hn', 'min']), [
      { id: '1', no: 1, full_vat: true, vat_hn: '2000', min: '26000' },
      { id: '1', no: 2, full_vat: false, vat_hn: '0', min: '24000' },
      { id: '2', no: 1, full_vat: true, vat_hn: '2000', min: '26000' },
      { id: '2', no: 2, full_vat: true, vat_hn: '0', min: '5000' },
      { id: '3', no: 1, full_vat: false, vat_hn: '0', min: '24000' }
    ]);
  } finally { await db.close(); }
});

test('Bo qua (OD)/(PK): du gia ban thap van Dung, tien 0; chu OD tran khong loai', async () => {
  const db = await newDb();
  try {
    await customer(db, 'hanoi', 1, 'K', {});
    await product(db, 'hanoi', 1, 'A', 'Ly (od) mau', HN_NOTE);
    await product(db, 'hanoi', 2, 'B', 'Ly ( PK )', HN_NOTE);
    await product(db, 'hanoi', 3, 'C', 'Ly OD PK', HN_NOTE);
    await invoice(db, { id: 1, customerId: 1, lines: [
      { productId: 1, code: 'A', name: 'Ly (od) mau', qty: 10, price: 1000 },
      { productId: 2, code: 'B', name: 'Ly ( PK )', qty: 10, price: 1000 },
      { productId: 3, code: 'C', name: 'Ly OD PK', qty: 10, price: 1000 }] });
    await capture(db);
    assert.deepEqual(pick(await lines(db), ['no', 'min', 'amount', 'status', 'reason', 'winning_source']), [
      { no: 1, min: '24000', amount: '0', status: 'correct', reason: 'Không xét OD', winning_source: 'Không xét' },
      { no: 2, min: '24000', amount: '0', status: 'correct', reason: 'Không xét PK', winning_source: 'Không xét' },
      { no: 3, min: '24000', amount: '230000', status: 'wrong', reason: 'Theo giá quy định', winning_source: 'HN' }
    ]);
  } finally { await db.close(); }
});

test('Giam gia: 25000 - 2000/dv voi min 24000 thieu 1000/dv; giam chung don khong tac dong', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    await invoice(db, { id: 1, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 100, price: 25000, discount: 2000 }] });
    await db.query("UPDATE invoices SET raw = raw || '{\"discount\": 500000}'::jsonb WHERE id = 1");
    await capture(db);
    assert.deepEqual(pick(await lines(db), ['net', 'min', 'short', 'amount', 'status']),
      [{ net: '23000', min: '24000', short: '1000', amount: '100000', status: 'wrong' }]);
  } finally { await db.close(); }
});

test('Bao cuoc: HN full VAT min(26500; 24800) = 24800; SG khong cong; thieu O = 0; thieu SG dung HN + cuoc; HN khong gia khong xet', async () => {
  const db = await newDb();
  try {
    await product(db, 'hanoi', 1, 'T100', 'Ly', 'T100 # 1T-24000 | VAT+2000');
    await product(db, 'saigon', 91, ' t100', 'Ly SG', 'T100 # 1T-23800 | VAT+1000');
    await product(db, 'hanoi', 2, 'HNONLY', 'Chi HN', 'T10 # 1T-10000');
    await product(db, 'hanoi', 3, 'NOFREIGHT', 'Khong cuoc', 'T10 # 1T-10000');
    await product(db, 'saigon', 93, 'NOFREIGHT', 'SG', 'T10 # 1T-12000');
    await product(db, 'hanoi', 4, 'NOHN', 'HN trong', '');
    await product(db, 'saigon', 94, 'NOHN', 'SG co', 'T10 # 1T-100');
    await db.query("INSERT INTO shipping_measures (code_key, freight_per_unit) VALUES ('t100', 500), ('hnonly', 300), ('nofreight', NULL)");
    await customer(db, 'hanoi', 1, `  sg   TÍN phong shop `, {});
    await customer(db, 'hanoi', 2, 'Khach thuong', {});
    await customer(db, 'saigon', 1, FREIGHT_NAME, {});
    const t100 = { productId: 1, code: 'T100', name: 'Ly', qty: 10, price: 1, note: 'full vat' };
    await invoice(db, { id: 1, customerId: 1, lines: [t100,
      { productId: 2, code: 'HNONLY', name: 'Chi HN', qty: 1, price: 1 },
      { productId: 3, code: 'NOFREIGHT', name: 'Khong cuoc', qty: 1, price: 1 },
      { productId: 4, code: 'NOHN', name: 'HN trong', qty: 1, price: 1 }] });
    await invoice(db, { id: 2, customerId: 2, lines: [t100] });
    await invoice(db, { branch: 'saigon', id: 3, customerId: 1, lines: [{ ...t100, productId: 91 }] });
    await capture(db);
    assert.deepEqual(pick(await lines(db), ['id', 'no', 'min', 'winning_source', 'min_hn', 'min_sg', 'vat_hn', 'vat_sg', 'freight']), [
      { id: '1', no: 1, min: '24800', winning_source: 'SG', min_hn: '26000', min_sg: '24800', vat_hn: '2000', vat_sg: '1000', freight: '500' },
      { id: '1', no: 2, min: '10300', winning_source: 'HN + cước', min_hn: '10000', min_sg: null, vat_hn: '0', vat_sg: '0', freight: '300' },
      { id: '1', no: 3, min: '10000', winning_source: 'HN + cước', min_hn: '10000', min_sg: '12000', vat_hn: '0', vat_sg: '0', freight: '0' },
      { id: '1', no: 4, min: null, winning_source: 'Không xét', min_hn: null, min_sg: '100', vat_hn: '0', vat_sg: '0', freight: '0' },
      { id: '2', no: 1, min: '26000', winning_source: 'HN', min_hn: '26000', min_sg: null, vat_hn: '2000', vat_sg: null, freight: '0' },
      { id: '3', no: 1, min: '24800', winning_source: 'SG', min_hn: null, min_sg: '24800', vat_hn: null, vat_sg: '1000', freight: '0' }
    ]);
    const flags = await db.query('SELECT invoice_id::text AS id, bool_and(freight_eligible) AS f FROM invoice_price_audit_lines GROUP BY 1 ORDER BY 1');
    assert.deepEqual(flags.rows, [{ id: '1', f: true }, { id: '2', f: false }, { id: '3', f: false }]);
  } finally { await db.close(); }
});

test('Ranh gioi + NUMERIC: bang min dung, cao hon khong am, SL/gia le tinh chinh xac', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    await invoice(db, { id: 1, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 5, price: 24000 }] });
    await invoice(db, { id: 2, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 5, price: 30000 }] });
    await invoice(db, { id: 3, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: '2.5', price: '23999.9' }] });
    await invoice(db, { id: 4, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 3, price: '24000', discount: '0.1' }] });
    await capture(db);
    assert.deepEqual(pick(await lines(db), ['id', 'short', 'amount', 'status']), [
      { id: '1', short: '0', amount: '0', status: 'correct' },
      { id: '2', short: '0', amount: '0', status: 'correct' },
      { id: '3', short: '0.1', amount: '0.25', status: 'wrong' },
      { id: '4', short: '0.1', amount: '0.3', status: 'wrong' }
    ]);
  } finally { await db.close(); }
});

test('Snapshot: doi nguon sau khi chup khong doi dong cu; them/xoa/doi thu tu dong khong chup trung; hoa don muon duoc them', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    await invoice(db, { id: 1, customerId: 1, note: 'ghi chu', modified: '2026-10-20 09:00:00+00', lines: [
      { productId: 1, code: 'T100', name: 'Ly', qty: 10, price: 23000, note: 'a' },
      { productId: 1, code: 'T100', name: 'Ly', qty: 5, price: 24000 }] });
    assert.deepEqual(await capture(db), { addedInvoices: 1, addedLines: 2 });
    const before = (await db.query('SELECT * FROM invoice_price_audit_lines ORDER BY source_line_no')).rows;
    const marker = (await db.query('SELECT source_hash, source_modified_at, run_day::text, captured_at FROM invoice_price_audit_invoices')).rows[0];
    assert.match(marker.source_hash, /^[0-9a-f]{64}$/);
    assert.equal(marker.run_day, DAY);
    assert.equal(new Date(marker.source_modified_at).toISOString(), '2026-10-20T09:00:00.000Z');
    assert.equal(new Date(marker.captured_at).toISOString(), NOW.toISOString());
    // Doi gia hang hoa, SL, ghi chu, VAT, cuoc, email; them/xoa/doi thu tu dong cua hoa don da chup.
    await db.query("UPDATE products SET raw = '{\"description\":\"T1 # 1T-1 | VAT+9\"}'");
    await db.query("UPDATE customers SET raw = '{\"email\":\"vip@x\",\"groups\":\"Khac\"}'");
    await db.query("INSERT INTO shipping_measures (code_key, freight_per_unit) VALUES ('t100', 999)");
    await db.query("UPDATE invoices SET raw = raw || '{\"description\":\"full vat\"}'::jsonb");
    await db.query('DELETE FROM invoice_details');
    await db.query(`INSERT INTO invoice_details (branch, invoice_id, line_no, product_id, quantity, price, discount, raw) VALUES
      ('hanoi', 1, 0, 1, 7, 1, 0, '{}'), ('hanoi', 1, 1, 1, 10, 23000, 0, '{}'), ('hanoi', 1, 2, 1, 3, 1, 0, '{}')`);
    // Hoa don den muon (ngay ban 18/10) + hoa don ngoai cua so.
    await invoice(db, { id: 2, customerId: 1, purchaseDate: '2026-10-18 23:10:00+00', lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 1, price: 1 }] });
    await invoice(db, { id: 3, customerId: 1, purchaseDate: '2026-10-13 23:59:00+00', lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 1, price: 1 }] });
    assert.deepEqual(await capture(db), { addedInvoices: 1, addedLines: 1 });
    assert.deepEqual(await capture(db), { addedInvoices: 0, addedLines: 0 });
    const after = (await db.query('SELECT * FROM invoice_price_audit_lines WHERE invoice_id = 1 ORDER BY source_line_no')).rows;
    assert.deepEqual(after, before);
    const late = await lines(db, 'invoice_id = 2');
    assert.deepEqual(pick(late, ['min', 'customer_level', 'sale_name']), [{ min: '1', customer_level: 'Vừa', sale_name: 'Khac' }]);
  } finally { await db.close(); }
});

test('Cua so va ngay gio: Kiot 00:10 khong dich +7h; D-6 vao, D-7 khong; chua Hoan thanh khong chup', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    const ln = [{ productId: 1, code: 'T100', name: 'Ly', qty: 1, price: 24000 }];
    await invoice(db, { id: 1, customerId: 1, purchaseDate: '2026-10-14 00:10:00+00', lines: ln });
    await invoice(db, { id: 2, customerId: 1, purchaseDate: '2026-10-13 23:50:00+00', lines: ln });
    await invoice(db, { id: 3, customerId: 1, purchaseDate: '2026-10-20 23:59:00+00', lines: ln });
    await invoice(db, { id: 4, customerId: 1, purchaseDate: '2026-10-21 00:05:00+00', lines: ln });
    await invoice(db, { id: 5, customerId: 1, status: 'Đã hủy', lines: ln });
    await invoice(db, { id: 6, customerId: 1, lines: [{ ...ln[0], qty: 0 }] });
    assert.deepEqual(await capture(db), { addedInvoices: 3, addedLines: 2 });
    const { rows } = await db.query(`SELECT invoice_id::text AS id, sold_day::text AS day FROM invoice_price_audit_invoices ORDER BY 1`);
    assert.deepEqual(rows, [{ id: '1', day: '2026-10-14' }, { id: '3', day: '2026-10-20' }, { id: '6', day: '2026-10-20' }]);
    const repo = createPriceAuditRepository({ pool: db });
    await publish(db, '2026-10-14', DAY);
    const report = await repo.readReport({}, null);
    const first = report.rows.find(r => r.invoiceId === '1');
    assert.equal(first.soldAt, '2026-10-14T00:10:00');
    assert.equal(first.soldDay, '2026-10-14');
  } finally { await db.close(); }
});

test('Nguon chua san sang: Can do chua dong bo, thieu san pham/khach -> loi ro rang, khong ghi gi', async () => {
  const noSync = await newDb({ measuresSynced: false });
  try {
    await assert.rejects(capture(noSync), err => err.code === SOURCE_NOT_READY && /Cân đo/.test(err.message));
  } finally { await noSync.close(); }
  const db = await newDb();
  try {
    await customer(db, 'hanoi', 1, 'K', {});
    await invoice(db, { id: 1, customerId: 1, lines: [{ productId: 77, code: 'X', name: 'X', qty: 1, price: 1 }] });
    await assert.rejects(capture(db), err => err.code === SOURCE_NOT_READY && /sản phẩm/.test(err.message));
    await product(db, 'hanoi', 77, 'X', 'X', '');
    await invoice(db, { id: 2, customerId: 55, lines: [{ productId: 77, code: 'X', name: 'X', qty: 1, price: 1 }] });
    await assert.rejects(capture(db), err => err.code === SOURCE_NOT_READY && /khách/.test(err.message));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_price_audit_invoices')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('Gia NULL tren dong SL > 0 = nguon chua san sang (khong thanh Sai gia); chiet khau NULL = 0', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    await invoice(db, { id: 1, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 1, price: 24000 }] });
    await db.query('UPDATE invoice_details SET discount = NULL');
    await invoice(db, { id: 2, customerId: 1, lines: [
      { productId: 1, code: 'T100', name: 'Ly', qty: 0, price: 1 },
      { productId: 1, code: 'T100', name: 'Ly', qty: 1, price: 24000 }] });
    await db.query("UPDATE invoice_details SET price = NULL WHERE invoice_id = 2 AND line_no = 1");
    await assert.rejects(capture(db), err => err.code === SOURCE_NOT_READY && /HD2/.test(err.message) && /dòng 2/.test(err.message));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_price_audit_invoices')).rows[0].n, 0);
    // Dong SL <= 0 gia NULL khong chan.
    await db.query("UPDATE invoice_details SET price = 24000 WHERE invoice_id = 2 AND line_no = 1");
    await db.query("UPDATE invoice_details SET price = NULL WHERE invoice_id = 2 AND line_no = 0");
    assert.deepEqual(await capture(db), { addedInvoices: 2, addedLines: 2 });
    assert.deepEqual((await lines(db)).map(r => r.status), ['correct', 'correct']);
  } finally { await db.close(); }
});

test('Hoa don chua co dong chi tiet: khong ghi so danh dau, lan sau co chi tiet thi chup; moi dong SL <= 0 van danh dau', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    await invoice(db, { id: 1, customerId: 1, lines: [] });
    await invoice(db, { id: 2, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 0, price: 1 }] });
    assert.deepEqual(await capture(db), { addedInvoices: 1, addedLines: 0 });
    assert.deepEqual((await db.query('SELECT invoice_id::text AS id FROM invoice_price_audit_invoices')).rows, [{ id: '2' }]);
    await db.query(`INSERT INTO invoice_details (branch, invoice_id, line_no, product_id, quantity, price, discount, raw)
      VALUES ('hanoi', 1, 0, 1, 1, 24000, 0, $1)`, [JSON.stringify({ productCode: 'T100', productName: 'Ly' })]);
    assert.deepEqual(await capture(db), { addedInvoices: 1, addedLines: 1 });
  } finally { await db.close(); }
});

test('Cot O Can do sai tieu de (freight_error) -> nguon chua san sang, khong ghi gi', async () => {
  const db = await newDb();
  try {
    await baseHn(db);
    await invoice(db, { id: 1, customerId: 1, lines: [{ productId: 1, code: 'T100', name: 'Ly', qty: 1, price: 24000 }] });
    await db.query("UPDATE sheet_snapshot_sync SET freight_error = 'Sheet CÂN ĐO: cột O sai' WHERE source = 'shipping_measures'");
    await assert.rejects(capture(db), err => err.code === SOURCE_NOT_READY && /cột O/.test(err.message));
    assert.equal((await db.query('SELECT count(*)::int AS n FROM invoice_price_audit_invoices')).rows[0].n, 0);
  } finally { await db.close(); }
});

async function publish(db, from, to) {
  await db.query(`INSERT INTO invoice_price_audit_state (id, published_day, window_from, window_to, last_success_at, last_attempt_at, added_invoice_count)
    VALUES (TRUE, $2, $1, $2, $3, $3, 4)
    ON CONFLICT (id) DO UPDATE SET published_day = EXCLUDED.published_day, window_from = EXCLUDED.window_from, window_to = EXCLUDED.window_to`,
  [from, to, NOW]);
}

test('readReport: chua cong bo -> available=false; loc/KPI/sap xep/phan trang; Dung + Ok; readRow', async () => {
  const db = await newDb();
  try {
    const repo = createPriceAuditRepository({ pool: db });
    const empty = await repo.readReport({}, null);
    assert.equal(empty.meta.available, false);
    assert.equal(empty.meta.message, 'Chưa chạy kiểm tra giá');
    assert.deepEqual(empty.rows, []);
    assert.equal(empty.totalRows, 0);

    await baseHn(db);
    await customer(db, 'hanoi', 2, FREIGHT_NAME, { groups: 'Minh Anh' });
    await product(db, 'saigon', 9, 'T100', 'Ly SG', 'T100 # 1T-30000');
    await customer(db, 'saigon', 9, 'Khach SG', { groups: 'Duy Thái' });
    const ln = (qty, price, extra = {}) => ({ productId: 1, code: 'T100', name: 'Ly giu nhiet', qty, price, ...extra });
    await invoice(db, { id: 1, customerId: 1, purchaseDate: '2026-10-19 08:00:00+00', lines: [ln(100, 23000), ln(10, 24000), ln(5, 1000)] });
    await invoice(db, { id: 2, customerId: 2, purchaseDate: '2026-10-20 08:00:00+00', lines: [ln(1, 26000, { note: 'fullvat' })] });
    await invoice(db, { branch: 'saigon', id: 3, customerId: 9, purchaseDate: '2026-10-18 08:00:00+00', lines: [{ ...ln(2, 29000), productId: 9, name: 'Ly SG' }] });
    await capture(db);
    await publish(db, '2026-10-14', DAY);
    // Dong 1/1 sai 100x1000 -> duyet Ok; dong 1/3 sai -> Phat.
    await db.query("UPDATE invoice_price_audit_lines SET decision = 'ok' WHERE invoice_id = 1 AND source_line_no = 1");
    await db.query("UPDATE invoice_price_audit_lines SET decision = 'penalty' WHERE invoice_id = 1 AND source_line_no = 3");
    await db.query(`UPDATE customers SET raw = '{"groups":"Nhom moi"}' WHERE branch = 'hanoi' AND id = 1`);

    const all = await repo.readReport({}, null);
    assert.equal(all.meta.available, true);
    assert.equal(all.meta.windowFrom, '2026-10-14');
    assert.equal(all.meta.windowTo, DAY);
    assert.equal(all.totalRows, 5);
    assert.deepEqual(all.kpis, { invoiceCount: 3, correctLines: 3, wrongLines: 2,
      pendingAmount: '2000', penaltyAmount: '115000', effectiveAmount: '117000' });
    // Sai truoc, roi ngay ban moi nhat
    assert.deepEqual(all.rows.map(r => `${r.branch}/${r.invoiceId}/${r.sourceLineNo}/${r.effectiveStatus}`), [
      'hanoi/1/3/wrong', 'saigon/3/1/wrong', 'hanoi/2/1/correct', 'hanoi/1/1/correct', 'hanoi/1/2/correct']);
    const ok = all.rows.find(r => r.invoiceId === '1' && r.sourceLineNo === 1);
    assert.equal(ok.originalStatus, 'wrong');
    assert.equal(ok.originalAmount, '100000');
    assert.equal(ok.effectiveAmount, '0');
    assert.equal(ok.reason, 'Được duyệt Ok');
    assert.equal(ok.decision, 'ok');
    assert.equal(ok.saleName, 'Duy Thái');
    assert.equal(ok.currentSaleGroup, 'Nhom moi');
    assert.equal(ok.customerLevel, 'Vừa');
    assert.equal(ok.version, 1);
    assert.equal(ok.canEditExplanation, false);
    assert.equal(ok.canDecide, false);
    for (const key of ['soldAt', 'branch', 'invoiceCode', 'saleName', 'customerName', 'productCode', 'productName',
      'customerLevel', 'quantity', 'totalCodeQuantity', 'fullVat', 'netUnitPrice', 'minimumUnitPrice', 'unitShortfall',
      'effectiveAmount', 'effectiveStatus', 'saleExplanation', 'decision', 'customerCode', 'customerEmail', 'sourceLineNo',
      'originalUnitPrice', 'unitDiscount', 'cartonSizeHn', 'quantityPriceHn', 'levelPriceHn', 'vatHn', 'minimumHn',
      'freightEligible', 'freightPerUnit', 'cartonSizeSg', 'quantityPriceSg', 'levelPriceSg', 'vatSg', 'minimumSg',
      'winningSource', 'reason', 'productNoteHn', 'productNoteSg', 'lineNote', 'invoiceNote', 'originalStatus',
      'originalAmount', 'decidedBy', 'decidedAt', 'capturedAt', 'version', 'invoiceId']) {
      assert.ok(Object.hasOwn(ok, key), `thieu khoa ${key}`);
    }

    const correctOk = await repo.readReport({ status: 'correct', decision: 'ok' }, null);
    assert.deepEqual(correctOk.rows.map(r => r.sourceLineNo), [1]);
    assert.equal(correctOk.kpis.invoiceCount, 1);
    const wrong = await repo.readReport({ status: 'wrong' }, null);
    assert.deepEqual(wrong.rows.map(r => r.invoiceId), ['1', '3']);
    const pending = await repo.readReport({ decision: 'pending', status: 'wrong' }, null);
    assert.deepEqual(pending.rows.map(r => r.invoiceId), ['3']);
    assert.equal(pending.kpis.pendingAmount, '2000');
    const penalty = await repo.readReport({ decision: 'penalty' }, null);
    assert.equal(penalty.kpis.penaltyAmount, '115000');
    assert.equal((await repo.readReport({ branch: 'saigon' }, null)).totalRows, 1);
    assert.equal((await repo.readReport({ vat: true }, null)).totalRows, 1);
    assert.equal((await repo.readReport({ freight: true }, null)).rows[0].customerName, FREIGHT_NAME);
    assert.equal((await repo.readReport({ freight: false }, null)).totalRows, 4);
    assert.equal((await repo.readReport({ sale: 'Minh Anh' }, null)).totalRows, 1);
    assert.equal((await repo.readReport({ q: 'hd3' }, null)).totalRows, 1);
    assert.equal((await repo.readReport({ q: 'tín phong' }, null)).totalRows, 1);
    assert.equal((await repo.readReport({ q: 'GIU NHIET' }, null)).totalRows, 4);
    // Tim gan dung: khong dau, khong can nguyen cum; tu khong ton tai thi khong khop; KPI tinh tren tap da loc.
    assert.equal((await repo.readReport({ q: 'tin phong' }, null)).totalRows, 1);
    assert.equal((await repo.readReport({ q: 'giu zzzzqq' }, null)).totalRows, 0);
    const fz = await repo.readReport({ q: 'tin phong' }, null);
    assert.equal(fz.kpis.invoiceCount, 1);
    assert.equal((await repo.readReport({ from: '2026-10-19', to: '2026-10-19' }, null)).kpis.invoiceCount, 1);
    const page2 = await repo.readReport({ page: 2, pageSize: 2 }, null);
    assert.deepEqual(page2.rows.map(r => `${r.invoiceId}/${r.sourceLineNo}`), ['2/1', '1/1']);
    assert.equal(page2.totalRows, 5);
    assert.equal(page2.kpis.invoiceCount, 3);
    assert.deepEqual(all.filters.options.sales, ['Duy Thái', 'Minh Anh']);

    const row = await repo.readRow({ branch: 'hanoi', invoiceId: '1', sourceLineNo: 3 });
    assert.equal(row.decision, 'penalty');
    assert.equal(row.effectiveAmount, '115000');
    assert.equal(await repo.readRow({ branch: 'hanoi', invoiceId: '1', sourceLineNo: 99 }), null);
  } finally { await db.close(); }
});
