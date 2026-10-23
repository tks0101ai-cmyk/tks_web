'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const repo = require('./repository');
const { createUserTablePrefsRouter } = require('./routes');

const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/0085_user_table_prefs.sql'), 'utf8')
  .replace(/REVOKE SELECT[^;]*;/g, '');

async function makePool(t) {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(sql);
  return db;
}

test('sanitizePrefs giữ cấu hình hợp lệ và làm tròn độ rộng', () => {
  assert.deepEqual(
    repo.sanitizePrefs({ columns: { code: { width: 130.4, hidden: false }, name: { hidden: true }, junk: {} }, extra: 1 }),
    { columns: { code: { width: 130, hidden: false }, name: { hidden: true } } }
  );
});

test('sanitizePrefs từ chối đầu vào sai', () => {
  for (const bad of [null, {}, { columns: [] }, { columns: { a: { width: 5 } } }, { columns: { a: { width: 99999 } } },
    { columns: { a: { width: NaN } } }, { columns: { a: { width: '100' } } }, { columns: { a: { hidden: 'yes' } } },
    { columns: { a: 5 } }, { columns: { ['x'.repeat(201)]: { width: 100 } } }]) {
    assert.throws(() => repo.sanitizePrefs(bad), { statusCode: 400 });
  }
  const many = {}; for (let i = 0; i < 201; i++) many['c' + i] = { width: 100 };
  assert.throws(() => repo.sanitizePrefs({ columns: many }), { statusCode: 400 });
});

test('sanitizePrefs giữ sắp xếp hợp lệ, bỏ qua null và từ chối sai', () => {
  assert.deepEqual(repo.sanitizePrefs({ columns: {}, sort: { key: 'qty', dir: 'desc', x: 1 } }), { columns: {}, sort: { key: 'qty', dir: 'desc' } });
  assert.deepEqual(repo.sanitizePrefs({ columns: {}, sort: null }), { columns: {} });
  for (const bad of ['qty', [], { key: 'qty' }, { key: 'qty', dir: 'up' }, { key: '', dir: 'asc' }, { dir: 'asc' }]) {
    assert.throws(() => repo.sanitizePrefs({ columns: {}, sort: bad }), { statusCode: 400 });
  }
});

test('savePrefs ghi đè theo (tài khoản, bảng, chế độ) và listForUser cô lập tài khoản', async t => {
  const pool = await makePool(t);
  await repo.savePrefs(pool, 'u1', 'orders', 'desktop', { columns: { code: { width: 200 } } });
  await repo.savePrefs(pool, 'u1', 'orders', 'desktop', { columns: { code: { width: 300, hidden: true } } });
  await repo.savePrefs(pool, 'u1', 'orders', 'mobile', { columns: { code: { width: 90 } } });
  await repo.savePrefs(pool, 'u2', 'orders', 'desktop', { columns: { code: { width: 111 } } });
  assert.deepEqual(await repo.listForUser(pool, 'u1'), {
    orders: { desktop: { columns: { code: { width: 300, hidden: true } } }, mobile: { columns: { code: { width: 90 } } } }
  });
  assert.deepEqual(await repo.listForUser(pool, 'u2'), { orders: { desktop: { columns: { code: { width: 111 } } } } });
  assert.deepEqual(await repo.listForUser(pool, 'nobody'), {});
  await assert.rejects(() => repo.savePrefs(pool, 'u1', 'orders', 'tablet', { columns: {} }), { statusCode: 400 });
  await assert.rejects(() => repo.savePrefs(pool, 'u1', '', 'desktop', { columns: {} }), { statusCode: 400 });
});

function handlerOf(router, method, routePath) {
  const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
function fakeRes() {
  const res = {};
  res.status = c => { res.statusCode = c; return res; };
  res.json = b => { res.body = b; return res; };
  return res;
}

test('route lấy user_id từ phiên, không từ body, và trả 400 khi dữ liệu sai', async t => {
  const pool = await makePool(t);
  const router = createUserTablePrefsRouter({ getPool: () => pool });
  const put = handlerOf(router, 'put', '/:tableKey/:mode');
  const get = handlerOf(router, 'get', '/');

  const ok = fakeRes();
  await put({ user: { id: 'u1' }, params: { tableKey: 't', mode: 'desktop' }, body: { userId: 'u9', columns: { a: { width: 150 } } } }, ok);
  assert.equal(ok.statusCode, 200);
  const bad = fakeRes();
  await put({ user: { id: 'u1' }, params: { tableKey: 't', mode: 'desktop' }, body: { columns: { a: { width: 1 } } } }, bad);
  assert.equal(bad.statusCode, 400);

  const mine = fakeRes(); await get({ user: { id: 'u1' } }, mine);
  assert.deepEqual(mine.body.tables, { t: { desktop: { columns: { a: { width: 150 } } } } });
  const other = fakeRes(); await get({ user: { id: 'u9' } }, other);
  assert.deepEqual(other.body.tables, {});
});

test('router yêu cầu đăng nhập cho mọi route', () => {
  const router = createUserTablePrefsRouter({ getPool: () => null });
  assert.equal(router.stack[0].name, 'liveAuthGuard');
});
