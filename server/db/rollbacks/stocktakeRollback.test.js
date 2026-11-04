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

test('0106: chay lai duoc; down tra ve schema 0105, that bai (khong doi gi) neu lich su da co action moi', async () => {
  const UP_0106 = fs.readFileSync(path.join(MIGRATIONS, '0106_stocktake_previous_cancel.sql'), 'utf8');
  const DOWN_0106 = fs.readFileSync(path.join(__dirname, '0106_stocktake_previous_cancel.down.sql'), 'utf8');
  const db = new PGlite();
  for (const file of ['0001_core_master_data.sql', '0003_orders.sql', '0009_app_users_hr_employees.sql', '0041_hr_employee_status.sql']) {
    await db.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  await db.exec(`CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  await db.exec(UP);
  await db.exec(UP_0106);
  await db.exec(UP_0106); // idempotent
  await db.exec(`INSERT INTO schema_migrations (filename) VALUES ('0105_stocktake.sql'), ('0106_stocktake_previous_cancel.sql');
                 INSERT INTO stocktake_sessions (id, branch, name, date_from, date_to) VALUES (1, 'hanoi', 'thu', '2026-10-03', '2026-10-03');`);
  await assert.rejects(db.exec(`UPDATE stocktake_sessions SET previous_session_id = 1 WHERE id = 1`), /previous_not_self/u);

  const columns = async () => (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'stocktake_sessions' ORDER BY column_name`)).rows.map(r => r.column_name);
  await db.exec(`INSERT INTO stocktake_history (session_id, branch, action) VALUES (1, 'hanoi', 'session_cancel')`);
  await assert.rejects(db.exec(DOWN_0106), /stocktake_history_action_check/u);
  await db.exec('ROLLBACK');
  assert.ok((await columns()).includes('cancelled_at'), 'rollback that bai khong doi gi');

  const fresh = new PGlite();
  for (const file of ['0001_core_master_data.sql', '0003_orders.sql', '0009_app_users_hr_employees.sql', '0041_hr_employee_status.sql']) {
    await fresh.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
  }
  await fresh.exec(`CREATE TABLE schema_migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());`);
  await fresh.exec(UP);
  await fresh.exec(UP_0106);
  await fresh.exec(`INSERT INTO schema_migrations (filename) VALUES ('0105_stocktake.sql'), ('0106_stocktake_previous_cancel.sql')`);
  await fresh.exec(DOWN_0106);
  const left = (await fresh.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'stocktake_sessions'`)).rows.map(r => r.column_name);
  assert.ok(!left.includes('previous_session_id') && !left.includes('cancelled_at'));
  assert.deepEqual((await fresh.query(`SELECT filename FROM schema_migrations`)).rows.map(r => r.filename), ['0105_stocktake.sql']);
  await assert.rejects(fresh.exec(`INSERT INTO stocktake_history (branch, action) VALUES ('hanoi', 'session_cancel')`), /action_check/u);
  await fresh.exec(UP_0106); // ap lai duoc sau khi go
});
