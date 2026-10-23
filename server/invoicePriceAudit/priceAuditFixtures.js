'use strict';

// Fixture PGlite dung chung cho test "Kiem tra gia ban" (KHONG phai file test: ten khong khop mau node --test).
// Schema THAT: migration 0001-0006, 0012, 0064, 0077, 0087.

const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const MIGRATIONS = ['0001_core_master_data.sql', '0002_invoices.sql', '0003_orders.sql', '0004_returns.sql',
  '0005_purchases.sql', '0006_cash_flows.sql', '0012_numeric_money_quantity_columns.sql',
  '0064_sheet_snapshots.sql', '0077_invoice_price_audit.sql', '0087_customer_price_levels.sql']
  .map(file => fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', file), 'utf8'));

const HN_NOTE = 'T100 # 16/10 # 1T -24000 | 3T- 23800 | 5T- 23600 | 10T-23000 | VAT+2000đ';
const FREIGHT_NAME = 'SG Tín Phong Shop';

async function newDb({ measuresSynced = true, syncedAt = new Date('2026-10-20T16:00:00Z') } = {}) {
  const db = new PGlite();
  for (const sql of MIGRATIONS) await db.exec(sql);
  await db.query('UPDATE customer_price_level_state SET initialized_at=now() WHERE id');
  if (measuresSynced) {
    await db.query("INSERT INTO sheet_snapshot_sync (source, last_success_at) VALUES ('shipping_measures', $1)", [syncedAt]);
  }
  return db;
}

async function product(db, branch, id, code, name, description) {
  await db.query('INSERT INTO products (branch, id, code, name, raw) VALUES ($1,$2,$3,$4,$5)',
    [branch, id, code, name, JSON.stringify(description == null ? {} : { description })]);
}
// Mac dinh khach co email cap Vua; muon "khong co email" (cap Lon) truyen ro { email: '' }.
async function customer(db, branch, id, name, raw = {}) {
  if (!('email' in raw) && !('Email' in raw)) raw = { email: 'vua@x.vn', ...raw };
  await db.query('INSERT INTO customers (branch, id, code, name, raw) VALUES ($1,$2,$3,$4,$5)',
    [branch, id, `KH${id}`, name, JSON.stringify(raw)]);
  // Tests model the one-time archived level explicitly. Runtime capture never parses email.
  const { nameKey } = require('../businessReport/businessMonths');
  const { customerLevelFromEmail } = require('./priceAuditRules');
  await db.query('INSERT INTO customer_price_levels(customer_key,level) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [nameKey(name),customerLevelFromEmail(raw.email ?? raw.Email)]);
}
// lines: [{ productId, code, name, qty, price, discount, note }]
async function invoice(db, { branch = 'hanoi', id, purchaseDate = '2026-10-20 10:00:00+00', customerId = null,
  customerName = '', status = 'Hoàn thành', note = '', modified = null, lines }) {
  await db.query(`INSERT INTO invoices (branch, id, code, purchase_date, customer_id, status, modified_date, raw)
    VALUES ($1,$2,$3,$4,$5,1,$6,$7)`, [branch, id, `HD${id}`, purchaseDate, customerId, modified,
    JSON.stringify({ statusValue: status, description: note, customerName, customerCode: customerId ? `KH${customerId}` : '' })]);
  let no = 0;
  for (const l of lines) {
    await db.query(`INSERT INTO invoice_details (branch, invoice_id, line_no, product_id, quantity, price, discount, raw)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [branch, id, no++, l.productId, String(l.qty), String(l.price),
      String(l.discount ?? 0), JSON.stringify({ productCode: l.code, productName: l.name, note: l.note || '' })]);
  }
}

/**
 * Boc PGlite (1 phien duy nhat) thanh "pool" kieu pg: connect() tra client { query, release } va XEP HANG
 * cac client (mutex) de giao dich cua client nay khong bi lenh cua client khac chen vao giua.
 * pool.query cung di qua hang doi. `released` dem so lan release (release(err) -> broken++).
 */
function pgliteAsPool(db) {
  let tail = Promise.resolve();
  const stats = { connects: 0, released: 0, broken: 0 };
  function acquire() {
    let unlock;
    const next = new Promise(resolve => { unlock = resolve; });
    const ready = tail.then(() => unlock);
    tail = tail.then(() => next);
    return ready;
  }
  return {
    stats,
    async connect() {
      const unlock = await acquire();
      stats.connects += 1;
      let done = false;
      return {
        query: (text, params) => db.query(text, params),
        release(err) {
          if (done) return;
          done = true;
          stats.released += 1;
          if (err) stats.broken += 1;
          unlock();
        }
      };
    },
    async query(text, params) {
      const unlock = await acquire();
      try { return await db.query(text, params); } finally { unlock(); }
    },
    async end() {}
  };
}

module.exports = { MIGRATIONS, HN_NOTE, FREIGHT_NAME, newDb, product, customer, invoice, pgliteAsPool };
