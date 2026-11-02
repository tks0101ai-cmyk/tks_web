'use strict';

// File go bo 0105_stocktake: chay migration roi chay file down -> khong con bang/ham stocktake, schema_migrations sach,
// bang co san (orders) khong bi dung; chay lai migration van duoc.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

const MIGRATIONS = path.join(__dirname, '../migrations');
const DOWN = fs.readFileSync(path.join(__dirname, '0105_stocktake.down.sql'), 'utf8');
const UP = fs.readFileSync(path.join(MIGRATIONS, '0105_stocktake.sql'), 'utf8');

test('0105_stocktake.down.sql go sach Kiem ke, khong dung bang khac', async () => {
  const db = new PGlite();
  for (const file of ['0001_core_master_data.sql', '0003_orders.sql', '0009_app_users_hr_employees.sql', '0041_hr_employee_status.sql']) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  await db.exec(`CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
                 INSERT INTO orders (branch, id, code, raw) VALUES ('hanoi', 1, 'DH1', '{}');`);
  await db.exec(UP);
  await db.exec(`INSERT INTO schema_migrations (filename) VALUES ('0104_stock_out_orders.sql'), ('0105_stocktake.sql');
                 INSERT INTO stocktake_sessions (branch, name, date_from, date_to) VALUES ('hanoi', 'thu', '2026-10-03', '2026-10-03');`);
  await db.exec(DOWN);

  const tables = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'stocktake%'`)).rows;
  assert.deepEqual(tables, []);
  const fn = (await db.query(`SELECT 1 FROM pg_proc WHERE proname = 'stocktake_history_guard'`)).rows;
  assert.deepEqual(fn, []);
  const applied = (await db.query(`SELECT filename FROM schema_migrations ORDER BY filename`)).rows.map(r => r.filename);
  assert.deepEqual(applied, ['0104_stock_out_orders.sql']);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n, 1);

  await db.exec(UP); // ap lai duoc sau khi go
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM stocktake_sessions`)).rows[0].n, 0);
});
