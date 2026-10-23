'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const { createCustomerPriceLevelRepository } = require('./customerPriceLevelRepository');
const { serviceSnapshot } = require('./testFixtures');

async function setup() {
  const db = new PGlite();
  await db.exec('CREATE TABLE customers(branch text, id bigint, code text, name text, raw jsonb)');
  await db.exec(fs.readFileSync(path.join(__dirname, '../db/migrations/0087_customer_price_levels.sql'), 'utf8'));
  const pool = { query: (q, p) => db.query(q, p), connect: async () => ({ query: (q, p) => db.query(q, p), release() {} }) };
  return { db, repo: createCustomerPriceLevelRepository({ pool }) };
}

test('initialization archives every source, preserves displayed merged level and is immutable on repeat', async () => {
  const { db, repo } = await setup();
  try {
    await assert.rejects(repo.getLevels(['chị a']), { code: 'MIGRATION_PENDING' });
    await db.query(`INSERT INTO customers VALUES ('hanoi',1,'KH1','Chị A','{"email":"vip@x"}'),
      ('saigon',2,'KH2','chị  A','{"email":"lon@x"}'), ('hanoi',3,'KH3','Chưa bán','{"email":"vua@x"}')`);
    const snap = serviceSnapshot();
    snap.directory[0].priceLevel = 'vip';
    await repo.initialize(snap);
    assert.equal((await db.query('SELECT * FROM customer_price_level_sources')).rows.length, 3);
    assert.equal((await repo.getLevels(['chị a']))['chị a'].level, 'vip');
    assert.equal((await repo.getLevels(['chưa bán']))['chưa bán'].level, 'medium');
    const saved = await repo.saveLevel('chị a', 'large', 1, { id: 'u1', name: 'Quản lý' });
    assert.equal(saved.version, 2);
    await assert.rejects(repo.saveLevel('chị a', 'medium', 1, {}), { statusCode: 409 });
    await assert.rejects(repo.saveLevel('chị a', 'bad', 2, {}), { statusCode: 400 });
    await db.query(`UPDATE customers SET raw = '{"email":"vua@x"}'`);
    await repo.initialize(snap);
    assert.equal((await repo.getLevels(['chị a']))['chị a'].level, 'large');
    assert.equal((await db.query("SELECT source_email FROM customer_price_level_sources WHERE branch='hanoi' AND customer_id=1")).rows[0].source_email, 'vip@x');
    assert.equal((await db.query('SELECT * FROM customer_price_level_history')).rows.length, 1);
    assert.deepEqual((await repo.getLevels(['khách mới']))['khách mới'], { level: 'large', version: 0 });
    assert.equal((await repo.saveLevel('khách mới', 'vip', 0, {})).version, 1);
  } finally { await db.close(); }
});
