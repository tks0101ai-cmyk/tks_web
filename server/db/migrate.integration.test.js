'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const CONFIG = require('../config');
const { runMigrations } = require('./migrate');

const TEST_DB_URL = process.env.SUPABASE_TEST_DB_URL || '';
const TEST_DB_IS_PRODUCTION = Boolean(TEST_DB_URL && CONFIG.SUPABASE_DB_URL && TEST_DB_URL === CONFIG.SUPABASE_DB_URL);

const EXPECTED_TABLES = [
  'product_containers',
  'purchase_orders',
  'purchase_history',
  'purchase_departures',
  'purchase_key_history',
  'purchase_import_previews',
  'purchase_settings',
  'purchase_presence',
  'purchase_requests',
  'purchase_operations',
  'purchase_operation_rows',
  'purchase_undo_expected',
  'cash_book_accounts',
  'cash_book_checkpoints',
  'cash_flows',
  'categories',
  'customers',
  'debt_collection_statuses',
  'hr_leave_requests',
  'hr_telegram_links',
  'hr_telegram_sessions',
  'invoice_details',
  'invoice_payments',
  'invoices',
  'order_details',
  'orders',
  'products',
  'purchase_details',
  'purchases',
  'return_details',
  'returns',
  'staff',
  'sync_checkpoints',
  'webhook_events_raw'
];

const EXPECTED_INTEGER_COLUMNS = [
  ['purchase_orders', 'carton_count', 'numeric'],
  ['purchase_orders', 'qty_per_carton', 'numeric'],
  ['purchase_orders', 'unit_price_cny', 'numeric'],
  ['purchase_orders', 'freight_amount', 'numeric'],
  ['product_containers', 'max_ton', 'numeric'],
  ['cash_flows', 'account_id', 'bigint'],
  ['cash_flows', 'amount', 'numeric'],
  ['cash_flows', 'status', 'integer'],
  ['customers', 'debt', 'numeric'],
  ['customers', 'total_revenue', 'numeric'],
  ['invoice_details', 'discount', 'numeric'],
  ['invoice_details', 'price', 'numeric'],
  ['invoice_details', 'quantity', 'numeric'],
  ['invoice_payments', 'amount', 'numeric'],
  ['invoices', 'total', 'numeric'],
  ['invoices', 'total_payment', 'numeric'],
  ['order_details', 'discount', 'numeric'],
  ['order_details', 'price', 'numeric'],
  ['order_details', 'quantity', 'numeric'],
  ['orders', 'total', 'numeric'],
  ['products', 'base_price', 'numeric'],
  ['purchase_details', 'price', 'numeric'],
  ['purchase_details', 'quantity', 'numeric'],
  ['purchases', 'total', 'numeric'],
  ['return_details', 'price', 'numeric'],
  ['return_details', 'quantity', 'numeric'],
  ['returns', 'total', 'numeric']
];

test('migrations create the complete KiotViet schema on configured Supabase', {
  skip: !TEST_DB_URL
    ? 'SUPABASE_TEST_DB_URL chưa cấu hình — bỏ qua test tích hợp'
    : TEST_DB_IS_PRODUCTION
      ? 'SUPABASE_TEST_DB_URL trùng production — từ chối chạy migration test'
      : false
}, async (t) => {
  const pool = new Pool({
    connectionString: TEST_DB_URL,
    max: 2,
    ssl: CONFIG.PGSSL ? { rejectUnauthorized: false } : false
  });
  t.after(() => pool.end());

  await runMigrations({ pool, logger: { log() {} } });

  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY($1::text[])
    ORDER BY table_name
  `, [EXPECTED_TABLES]);
  assert.deepEqual(tables.rows.map((row) => row.table_name), EXPECTED_TABLES);

  const productPrimaryKey = await pool.query(`
    SELECT kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.constraint_schema = kcu.constraint_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'products'
      AND tc.constraint_type = 'PRIMARY KEY'
    ORDER BY kcu.ordinal_position
  `);
  assert.deepEqual(productPrimaryKey.rows.map((row) => row.column_name), ['branch', 'id']);

  const invoiceDetailsForeignKey = await pool.query(`
    SELECT ccu.table_name AS referenced_table
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON tc.constraint_name = ccu.constraint_name
     AND tc.constraint_schema = ccu.constraint_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name = 'invoice_details'
      AND tc.constraint_type = 'FOREIGN KEY'
  `);
  assert.deepEqual(
    [...new Set(invoiceDetailsForeignKey.rows.map((row) => row.referenced_table))],
    ['invoices']
  );

  const integerColumns = await pool.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        SELECT value->>0, value->>1
        FROM jsonb_array_elements($1::jsonb) AS value
      )
    ORDER BY table_name, column_name
  `, [JSON.stringify(EXPECTED_INTEGER_COLUMNS)]);
  assert.deepEqual(
    integerColumns.rows.map((row) => [row.table_name, row.column_name, row.data_type]),
    EXPECTED_INTEGER_COLUMNS
  );
});

const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
test('cash book migration backfills across 20k cash-only rows, retains historical IDs and creates usable checkpoint tables', async t => {
 const db=new PGlite();t.after(()=>db.close());
 await db.exec('CREATE TABLE cash_flows(branch text,id bigint,amount numeric,raw jsonb,trans_date timestamptz,PRIMARY KEY(branch,id))');
 await db.exec(`INSERT INTO cash_flows SELECT 'hanoi',n,-12.5,'{"status":0}'::jsonb,now() FROM generate_series(1,20001) n; INSERT INTO cash_flows VALUES ('saigon',1,-20.5,'{"accountId":-1,"status":1}',now()),('saigon',2,5,'{"AccountId":123,"Status":0}',now());`);
 await db.exec(fs.readFileSync(path.join(__dirname,'migrations/0033_cash_book.sql'),'utf8'));
 const rows=(await db.query("SELECT id,account_id,status,amount FROM cash_flows WHERE branch='saigon' ORDER BY id")).rows;
 assert.deepEqual(rows.map(x=>[x.account_id,x.status,Number(x.amount)]),[[-1,1,-20.5],[123,0,5]]);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM cash_flows WHERE account_id IS NULL AND status=0')).rows[0].n,20001);
 await db.exec(`INSERT INTO cash_book_checkpoints(account_id,checkpoint_at,balance,created_by) VALUES(NULL,now(),12.25,'manager'),(-1,now(),-2.5,'manager');`);
 const cps=(await db.query('SELECT account_id,balance FROM cash_book_checkpoints ORDER BY id')).rows;
 assert.equal(cps[0].account_id,null);assert.equal(Number(cps[0].balance),12.25);assert.equal(cps[1].account_id,-1);
 const indexes=(await db.query("SELECT indexname FROM pg_indexes WHERE indexname IN ('idx_cash_flows_account_date','idx_cash_book_checkpoints_account')")).rows;
 assert.equal(indexes.length,2);
});
