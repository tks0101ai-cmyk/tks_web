# Kiểm kê: gom đúng đơn TEAM và đồng bộ giá vốn — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tổng kiểm gom đúng đơn của khách `TEAM + số` theo ngày VN và tự cập nhật; giá vốn trên web khớp KiotViet, không còn lệch do giá cũ và do làm tròn.

**Architecture:** Sửa SQL trong `stocktakeService`, thêm sửa ngày đợt và API `order-status`, thêm entity đồng bộ `product_costs` chỉ ghi `cost`, trang `/stocktake/` hỏi `order-status` mỗi 30 giây và tải lại nền khi đổi. Spec: `docs/superpowers/specs/2026-11-05-stocktake-team-orders-cost-design.md`.

**Tech Stack:** Node.js CommonJS, Express, Postgres (PGlite trong test), `node:test`, vanilla JS/CSS.

## Global Constraints

- Không migration. Không ghi gì lên DB thật hoặc KiotViet khi kiểm thử; đối chiếu thật chỉ đọc.
- `orders.order_date` lưu giờ VN gắn nhãn UTC: luôn đổi bằng `AT TIME ZONE 'UTC'`.
- Mẫu tên khách: `~* '^TEAM[[:space:]]*[0-9]'` sau `btrim`.
- `product_costs` chỉ đổi trường `cost` trong `inventories`, không đụng `onHand`, `reserved`, `onOrder`.
- Giao diện hỗ trợ sáng/tối và 375px. Tăng `?v=` khi đổi `stocktake.js`, `stocktake.css`.
- Chạy test từ `server/`: `node --test --test-concurrency=1 <file>`.

---

### Task 1: Gom đơn đúng ngày, đúng tên; giá vốn đủ số lẻ

**Files:**
- Modify: `server/stocktake/stocktakeService.js` (`TEAM_LINES_SQL`, `PRODUCTS_SQL`)
- Test: `server/stocktake/stocktakeService.test.js`

**Interfaces:**
- Produces: hằng `TEAM_NAME_MATCH_SQL` dùng lại ở Task 2.

- [ ] **Step 1: Đổi fixture về đúng cách lưu thật và viết test hỏng**

Trong `fixture()`, các giá trị `order_date` đổi từ `+07` sang `+00` (cột lưu giờ VN gắn nhãn UTC). Thêm vào cuối file test:

```js
test('gom don: don 23:30 van thuoc ngay do, chi tinh khach TEAM + so, gia von giu so le', async () => {
  const { db, service, session } = await fixture();
  await db.exec(`
    INSERT INTO products (branch, id, code, name, raw) VALUES ('hanoi', 4, 'LE1', 'Hàng lẻ', '{"inventories":[{"onHand":1000,"cost":511.41}]}');
    INSERT INTO customers (branch, id, code, name, raw) VALUES
      ('hanoi', 13, 'KH3', 'KH Team Hàng Lỗi', '{}'), ('hanoi', 14, 'KH4', 'Team Lỗi', '{}'), ('hanoi', 15, 'KH5', 'team5 kho', '{}');
    INSERT INTO orders (branch, id, code, order_date, customer_id, raw) VALUES
      ('hanoi', 105, 'DH105', '2026-10-29 10:00+00', 13, '{}'), ('hanoi', 106, 'DH106', '2026-10-29 10:00+00', 14, '{}'), ('hanoi', 107, 'DH107', '2026-10-29 10:00+00', 15, '{}');
    INSERT INTO order_details (branch, order_id, line_no, product_id, quantity, raw) VALUES
      ('hanoi', 105, 1, 3, 7, '{"productCode":"CCC3","quantity":7}'), ('hanoi', 106, 1, 3, 7, '{"productCode":"CCC3","quantity":7}'), ('hanoi', 107, 1, 3, 2, '{"productCode":"CCC3","quantity":2}');
  `);
  const board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').lines.some(l => l.orderId === 102), true, 'don 23:30 thuoc ngay 29/10');
  assert.equal(rowOf(board, 'CCC3').counted, 3.5, 'chi 1.5 + team5 2, bo 2 khach team loi');
  assert.equal(rowOf(board, 'LE1').cost, 511.41);
  assert.equal(rowOf(board, 'LE1').diffValue, -511410);
});
```

- [ ] **Step 2: Chạy, xác nhận hỏng.** `node --test --test-concurrency=1 stocktake/stocktakeService.test.js`

- [ ] **Step 3: Sửa SQL**

```js
// Khach dem kiem ke ten "TEAM <so> ..." (khong gom "Team Loi", "KH Team Hang Loi").
const TEAM_NAME_MATCH_SQL = `btrim(COALESCE(NULLIF(c.name, ''), o.raw->>'customerName', '')) ~* '^TEAM[[:space:]]*[0-9]'`;
```

Trong `TEAM_LINES_SQL` thay 2 dòng điều kiện ngày và tên bằng:

```js
    AND o.order_date >= ($2::date)::timestamp AT TIME ZONE 'UTC'
    AND o.order_date < ($3::date + 1)::timestamp AT TIME ZONE 'UTC'
    AND ${TEAM_NAME_MATCH_SQL}
```

Trong `PRODUCTS_SQL` đổi `ROUND(AVG((inv->>'cost')::numeric))` thành `AVG((inv->>'cost')::numeric)`.

- [ ] **Step 4: Chạy lại, sửa mọi fixture `+07` còn lại trong file nếu vỡ.** Kỳ vọng xanh.

- [ ] **Step 5: Commit** `fix(kiem-ke): gom don TEAM + so theo dung ngay VN, giu so le gia von`

### Task 2: Sửa ngày đợt và API order-status

**Files:**
- Modify: `server/stocktake/stocktakeService.js`, `server/stocktake/stocktakeRoutes.js`
- Test: `server/stocktake/stocktakeService.test.js`, `server/stocktake/stocktakeRoutes.test.js`

**Interfaces:**
- Consumes: `TEAM_NAME_MATCH_SQL`.
- Produces: `updateSession(ctx, id, {dateFrom?, dateTo?, version})`; `getOrderStatus(ctx, id) -> { revision: string, inRange: number, outOfRange: { count: number, from: string|null, to: string|null } }`; `GET /api/stocktake/sessions/:id/order-status`.

- [ ] **Step 1: Viết test hỏng (service)**

```js
test('sua ngay dot dang mo: ghi lich su, kiem tra ngay + version, dot da dong bi chan', async () => {
  const { db, service, session } = await fixture();
  const { session: updated } = await service.updateSession(ctx(), session.id, { dateFrom: '2026-10-29', dateTo: '2026-10-30', version: session.version });
  assert.deepEqual([updated.dateFrom, updated.dateTo], ['2026-10-29', '2026-10-30']);
  const board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'BBB2').counted, 99, 'don 30/10 nay duoc tinh');
  const { rows } = await db.query(`SELECT before, after FROM stocktake_history WHERE action = 'session_update'`);
  assert.equal(rows[0].before.dateTo, '2026-10-29');
  assert.equal(rows[0].after.dateTo, '2026-10-30');
  await assert.rejects(service.updateSession(ctx(), session.id, { dateFrom: '2026-10-31', version: updated.version }), { statusCode: 400 });
  await assert.rejects(service.updateSession(ctx(), session.id, { dateTo: 'x', version: updated.version }), { statusCode: 400 });
  await assert.rejects(service.updateSession(ctx(), session.id, { dateTo: '2026-10-29', version: 99 }), { code: 'STOCKTAKE_CONFLICT' });
  await service.closeSession(ctx(), session.id, { version: updated.version });
  await assert.rejects(service.updateSession(ctx(), session.id, { dateTo: '2026-10-29', version: updated.version + 1 }), { code: 'STOCKTAKE_CLOSED' });
});

test('order-status: dem trong khoang, ngoai khoang bo don huy va qua 14 ngay, revision theo synced_at', async () => {
  const { db, service, session } = await fixture();
  await db.exec(`
    INSERT INTO orders (branch, id, code, order_date, customer_id, raw) VALUES
      ('hanoi', 108, 'DH108', '2026-11-05 08:15+00', 11, '{"statusValue":"Phiếu tạm"}'),
      ('hanoi', 109, 'DH109', '2026-11-06 08:15+00', 11, '{"statusValue":"Đã hủy"}'),
      ('hanoi', 110, 'DH110', '2026-12-30 08:15+00', 11, '{"statusValue":"Phiếu tạm"}');
  `);
  const status = await service.getOrderStatus(ctx(), session.id);
  assert.equal(status.inRange, 2, 'DH101 + DH102 da huy');
  // DH104 ngay 30/10 + DH108 ngay 05/11; DH109 da huy, DH110 qua 14 ngay.
  assert.deepEqual(status.outOfRange, { count: 2, from: '2026-10-30', to: '2026-11-05' });
  await db.exec(`UPDATE orders SET synced_at = now() + interval '1 hour' WHERE id = 101`);
  assert.notEqual((await service.getOrderStatus(ctx(), session.id)).revision, status.revision);
  await assert.rejects(service.getOrderStatus(ctx(QL, ['saigon']), session.id), { code: 'BRANCH_OUT_OF_SCOPE' });
});
```

- [ ] **Step 2: Viết test hỏng (route)**, thêm `getOrderStatus: record('getOrderStatus')` vào service giả của `start()`:

```js
test('order-status: nguoi chi co quyen xem goi duoc', async t => {
  const viewer = { id: 'v', vaiTro: 'Nhân viên kho', featurePermissions: { 'stocktake.view': true } };
  const { base, calls } = await start(t, { user: viewer });
  assert.equal((await fetch(base + '/sessions/7/order-status')).status, 200);
  assert.deepEqual(calls.at(-1).slice(0, 2), ['getOrderStatus', 7]);
});
```

- [ ] **Step 3: Chạy, xác nhận hỏng.**

- [ ] **Step 4: Cài đặt `getOrderStatus` và route**

```js
const ORDER_STATUS_SQL = `
  SELECT count(*) FILTER (WHERE in_range)::int AS in_range, max(synced_at) FILTER (WHERE in_range) AS max_synced,
         count(*) FILTER (WHERE NOT in_range AND status <> 'Đã hủy')::int AS out_count,
         (min(day) FILTER (WHERE NOT in_range AND status <> 'Đã hủy'))::text AS out_from,
         (max(day) FILTER (WHERE NOT in_range AND status <> 'Đã hủy'))::text AS out_to
  FROM (
    SELECT o.synced_at, COALESCE(o.raw->>'statusValue', '') AS status, (o.order_date AT TIME ZONE 'UTC')::date AS day,
           o.order_date >= ($2::date)::timestamp AT TIME ZONE 'UTC' AND o.order_date < ($3::date + 1)::timestamp AT TIME ZONE 'UTC' AS in_range
    FROM orders o
    LEFT JOIN customers c ON c.branch = o.branch AND c.id = o.customer_id
    WHERE o.branch = $1
      AND o.order_date >= ($2::date - 14)::timestamp AT TIME ZONE 'UTC'
      AND o.order_date < ($3::date + 15)::timestamp AT TIME ZONE 'UTC'
      AND ${TEAM_NAME_MATCH_SQL}
  ) t`;

  async function getOrderStatus(ctx, sessionId) {
    const db = getDb();
    const session = await readSession(db, ctx, sessionId);
    const row = (await db.query(ORDER_STATUS_SQL, [session.branch, session.dateFrom, session.dateTo])).rows[0];
    return {
      revision: `${row.in_range}:${isoOf(row.max_synced) || ''}`,
      inRange: row.in_range,
      outOfRange: { count: row.out_count, from: row.out_from, to: row.out_to }
    };
  }
```

Route, đặt cạnh `/board`:

```js
  router.get('/api/stocktake/sessions/:id/order-status', handle(async (req, res) => {
    res.json(await svc().getOrderStatus(ctxOf(req), idOf(req)));
  }));
```

Thêm `getOrderStatus` vào object service trả về.

- [ ] **Step 5: Cài đặt sửa ngày trong `updateSession`**

```js
      const has = field => Object.hasOwn(body, field);
      const changesDates = has('dateFrom') || has('dateTo');
      if (!has('counterpartSessionId') && !has('previousSessionId') && !changesDates) throw fail(400, 'VALIDATION', 'Không có gì để cập nhật.');
      const dateFrom = has('dateFrom') ? dateField(body.dateFrom, 'dateFrom', 'Từ ngày') : session.dateFrom;
      const dateTo = has('dateTo') ? dateField(body.dateTo, 'dateTo', 'Đến ngày') : session.dateTo;
      if (dateTo < dateFrom) throw fail(400, 'VALIDATION', 'Đến ngày phải sau hoặc bằng Từ ngày.', { field: 'dateTo' });
```

`UPDATE` thêm `date_from = $4, date_to = $5`, tham số `[session.id, counterpartId, previousId, dateFrom, dateTo]`. Lịch sử:

```js
      if (changesDates) {
        before.dateFrom = session.dateFrom; before.dateTo = session.dateTo;
        after.dateFrom = dateFrom; after.dateTo = dateTo;
      }
```

- [ ] **Step 6: Chạy test service và routes.** Kỳ vọng xanh.

- [ ] **Step 7: Commit** `feat(kiem-ke): sua ngay dot dang mo, API order-status`

### Task 3: Lượt đồng bộ giá vốn

**Files:**
- Create: `server/kiotvietSync/entities/productCosts.js`, `server/kiotvietSync/entities/productCosts.test.js`
- Modify: `server/kiotvietSync/scheduler.js` (`slowEntities`)

**Interfaces:**
- Produces: entity `{ entity: 'product_costs', endpoint: 'products', listQuery, pollFullSnapshot: true, upsertPage(client, branch, items) -> { received, updated } }`.

- [ ] **Step 1: Viết test hỏng** (PGlite, migration `0001_core_master_data.sql`)

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');
const productCosts = require('./productCosts');

const INV = cost => [{ branchId: 7, cost, onHand: 60, reserved: 2, onOrder: 5 }];

async function fixture() {
  const db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, '../../db/migrations/0001_core_master_data.sql'), 'utf8'));
  await db.query(`INSERT INTO products (branch, id, code, name, raw, synced_at) VALUES
    ('hanoi', 1, 'A', 'A', $1, '2026-01-01Z'), ('hanoi', 2, 'B', 'B', $2, '2026-01-01Z'), ('saigon', 1, 'A', 'A', $1, '2026-01-01Z')`,
    [JSON.stringify({ description: 'mo ta', inventories: INV(1000) }), JSON.stringify({ inventories: INV(511) })]);
  return db;
}
const read = async (db, branch, id) => (await db.query('SELECT raw, synced_at FROM products WHERE branch = $1 AND id = $2', [branch, id])).rows[0];

test('khai bao entity: quet toan bo /products, checkpoint rieng', () => {
  assert.equal(productCosts.entity, 'product_costs');
  assert.equal(productCosts.endpoint, 'products');
  assert.equal(productCosts.pollFullSnapshot, true);
  assert.equal(productCosts.listQuery.includeInventory, 'true');
});

test('chi doi cost dung co so, giu ton va cac truong khac', async () => {
  const db = await fixture();
  const result = await productCosts.upsertPage(db, 'hanoi', [{ id: 1, inventories: [{ branchId: 7, cost: 3300, onHand: 999, reserved: 99 }] }]);
  assert.deepEqual(result, { received: 1, updated: 1 });
  const row = await read(db, 'hanoi', 1);
  assert.deepEqual(row.raw, { description: 'mo ta', inventories: INV(3300) });
  assert.notEqual(row.synced_at.toISOString(), new Date('2026-01-01Z').toISOString());
  assert.equal((await read(db, 'saigon', 1)).raw.inventories[0].cost, 1000);
});

test('khong ghi khi cost khong doi (511 = 511.00), bo qua hang la, cost rong, kho la', async () => {
  const db = await fixture();
  const result = await productCosts.upsertPage(db, 'hanoi', [
    { id: 2, inventories: [{ branchId: 7, cost: 511.0 }] },
    { id: 999, inventories: [{ branchId: 7, cost: 5 }] },
    { id: 1, inventories: [{ branchId: 7 }, { branchId: 8, cost: 77 }] }
  ]);
  assert.deepEqual(result, { received: 3, updated: 0 });
  assert.equal((await read(db, 'hanoi', 2)).synced_at.toISOString(), new Date('2026-01-01Z').toISOString());
  assert.deepEqual((await read(db, 'hanoi', 1)).raw.inventories, INV(1000));
});

test('so le va dong chua co inventories khong gay loi', async () => {
  const db = await fixture();
  await db.exec(`INSERT INTO products (branch, id, code, name, raw) VALUES ('hanoi', 3, 'C', 'C', '{}')`);
  const result = await productCosts.upsertPage(db, 'hanoi', [{ id: 2, inventories: [{ branchId: 7, cost: 511.41 }] }, { id: 3, inventories: [{ branchId: 7, cost: 1 }] }]);
  assert.deepEqual(result, { received: 2, updated: 1 });
  assert.equal((await read(db, 'hanoi', 2)).raw.inventories[0].cost, 511.41);
  assert.deepEqual((await read(db, 'hanoi', 3)).raw, {});
});
```

- [ ] **Step 2: Chạy, xác nhận hỏng** (`Cannot find module`).

- [ ] **Step 3: Cài đặt**

```js
'use strict';
const { value, array } = require('./entityUtils');

// /productOnHands khong tra cost, doi soat 24 gio giu nguyen inventories, va doi gia von tren KiotViet
// thuong khong doi modifiedDate -> luot rieng nay quet /products va CHI cap nhat cost.
// So sanh trong Postgres, dong khong doi khong ghi (tranh WAL, xem project-tokosi-supabase-io-incident).
// $2 = JSON [{id, inv:[{branchId, cost}]}].
const UPDATE_COSTS_SQL = `
  WITH incoming AS (
    SELECT (r->>'id')::bigint AS id, e->>'branchId' AS branch_id, (e->>'cost')::numeric AS cost
    FROM jsonb_array_elements($2::jsonb) r
    CROSS JOIN LATERAL jsonb_array_elements(r->'inv') e
  ), changed AS (
    SELECT p.id, jsonb_agg(
      CASE WHEN i.cost IS NOT NULL AND (inv.elem->>'cost')::numeric IS DISTINCT FROM i.cost
           THEN inv.elem || jsonb_build_object('cost', i.cost) ELSE inv.elem END ORDER BY inv.ord) AS inventories
    FROM products p
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.raw->'inventories') = 'array' THEN p.raw->'inventories' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS inv(elem, ord)
    LEFT JOIN incoming i ON i.id = p.id AND i.branch_id = COALESCE(inv.elem->>'branchId', inv.elem->>'BranchId')
    WHERE p.branch = $1 AND p.id IN (SELECT id FROM incoming)
    GROUP BY p.id
    HAVING bool_or(i.cost IS NOT NULL AND (inv.elem->>'cost')::numeric IS DISTINCT FROM i.cost)
  )
  UPDATE products p SET raw = jsonb_set(p.raw, '{inventories}', c.inventories), synced_at = now()
  FROM changed c WHERE p.branch = $1 AND p.id = c.id`;

function costsOf(item) {
  const inv = array(item, 'Inventories', 'inventories')
    .map(entry => ({ branchId: value(entry, 'branchId', 'BranchId'), cost: value(entry, 'cost', 'Cost') }))
    .filter(entry => entry.branchId !== null && entry.cost !== null && Number.isFinite(Number(entry.cost)));
  return { id: value(item, 'Id', 'id', 'ProductId', 'productId'), inv };
}

module.exports = {
  entity: 'product_costs',
  endpoint: 'products',
  listQuery: { includeInventory: 'true', orderBy: 'id', orderDirection: 'ASC' },
  pollFullSnapshot: true,
  incrementalParam: null,
  hasUpperBound: false,
  async upsertPage(pgClient, branch, items) {
    const rows = items.map(costsOf).filter(row => row.id !== null && row.inv.length);
    if (!rows.length) return { received: items.length, updated: 0 };
    const result = await pgClient.query(UPDATE_COSTS_SQL, [branch, JSON.stringify(rows)]);
    return { received: items.length, updated: Number(result.rowCount ?? result.affectedRows ?? 0) };
  }
};
```

Trong `scheduler.js` thêm `require('./entities/productCosts')` vào cuối `slowEntities`.

- [ ] **Step 4: Chạy test entity + `kiotvietSync/scheduler.test.js` + `kiotvietSync/syncDriver.test.js`.** Kỳ vọng xanh.

- [ ] **Step 5: Commit** `feat(sync): luot rieng cap nhat gia von tu /products`

### Task 4: Giao diện

**Files:**
- Modify: `server/public/stocktake/index.html`, `server/public/stocktake/stocktake.js`, `server/public/stocktake/stocktake.css`

**Interfaces:**
- Consumes: `GET .../order-status`, `PATCH .../sessions/:id` với `dateFrom`, `dateTo`, `version`.

- [ ] **Step 1: HTML**

Thêm sau `#stSessionMeta`: `<button class="locations-columns-button vt-btn" id="stEditDatesButton" type="button" hidden>Sửa ngày</button>`.

Thêm trước `#stPreviousNote`:

```html
<div class="st-previous-note st-orders-note" id="stOrdersNote" role="status" hidden>
  <span id="stOrdersNoteText"></span>
  <button class="locations-columns-button vt-btn" id="stOrdersNoteButton" type="button" hidden>Sửa ngày</button>
</div>
```

Thêm hộp thoại `#stDatesDialog` theo mẫu `#stCancelDialog`, form `#stDatesForm` có 2 ô `dateFrom`, `dateTo`, `<p class="vt-form-error" id="stDatesError" role="alert"></p>`, nút Hủy (`data-st-close`) và Lưu. Đổi phụ đề hộp Tạo đợt thành `khách "TEAM + số"`. Tăng `?v=20261105-1` cho css và js.

- [ ] **Step 2: CSS**

```css
.st-orders-note{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 12px}
```

- [ ] **Step 3: JS**

`cellText`: `case 'cost': return num(row.cost);`. Thêm trạng thái và các hàm:

```js
  // Kiem tra don TEAM moi: dot dang mo, tab dang hien; revision doi thi tai lai nen.
  const ORDER_POLL_MS = 30000;
  const orders = { sessionId: null, revision: null, data: null, timer: null, checking: false };
  const sessionIsLive = id => { const s = state.sessions.find(item => item.id === id); return Boolean(s && s.status === 'open' && !s.cancelled); };
  async function fetchOrderStatus(sessionId) {
    try {
      const { response, payload } = await request(API + '/sessions/' + sessionId + '/order-status');
      return response.ok ? payload : null;
    } catch (error) { return null; }
  }
  function applyOrderStatus(sessionId, status) {
    orders.sessionId = sessionId;
    orders.revision = status ? status.revision : null;
    orders.data = status;
  }
  function renderOrdersInfo(session) {
    const note = $('stOrdersNote');
    const out = orders.data && orders.sessionId === (session && session.id) ? orders.data.outOfRange : null;
    note.hidden = !(out && out.count > 0);
    if (note.hidden) return;
    const range = out.from === out.to ? dateVn(out.from) : dateVn(out.from) + ' – ' + dateVn(out.to);
    $('stOrdersNoteText').textContent = 'Có ' + num(out.count) + ' đơn TEAM chưa tính vì nằm ngoài khoảng ngày (' + range + ').';
    $('stOrdersNoteButton').hidden = !state.canEdit;
  }
  async function pollOrderStatus() {
    const sessionId = state.sessionId;
    if (!sessionId || document.hidden || orders.checking || !sessionIsLive(sessionId)) return;
    orders.checking = true;
    const status = await fetchOrderStatus(sessionId);
    orders.checking = false;
    if (!status || sessionId !== state.sessionId) return;
    const changed = orders.sessionId === sessionId && orders.revision !== null && status.revision !== orders.revision;
    const sameOut = JSON.stringify(status.outOfRange) === JSON.stringify(orders.data && orders.data.outOfRange);
    applyOrderStatus(sessionId, status);
    if (changed) loadBoard({ background: true });
    else if (!sameOut && state.board) renderOrdersInfo(state.board.session);
  }
```

`loadBoard`: gọi `const statusLoad = sessionIsLive(sessionId) ? fetchOrderStatus(sessionId) : Promise.resolve(null);` TRƯỚC request board (đơn về giữa hai lần gọi thì lượt hỏi sau phát hiện được). Sau khi board thành công và trước `render`: `applyOrderStatus(sessionId, await statusLoad);`. Kiểm tra lại `version !== state.loadVersion` sau `await`.

`render`: thêm vào `#stSessionMeta` đoạn `(orders.data && orders.sessionId === session.id ? ' · Đã gom ' + num(orders.data.inRange) + ' đơn TEAM' : '')`; `$('stEditDatesButton').hidden = !(active && session.status === 'open' && state.canEdit);`; gọi `renderOrdersInfo(session)`.

Thêm `bindDates()` trong khối bind, cạnh `bindCancel()`:

```js
  function bindDates() {
    const dialog = $('stDatesDialog');
    const form = $('stDatesForm');
    const open = () => {
      const session = state.board && state.board.session;
      if (!session) return;
      form.elements.dateFrom.value = session.dateFrom;
      form.elements.dateTo.value = session.dateTo;
      $('stDatesError').textContent = '';
      dialog.showModal();
    };
    $('stEditDatesButton').addEventListener('click', open);
    $('stOrdersNoteButton').addEventListener('click', open);
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const session = state.board && state.board.session;
      if (!session) return;
      const { response, payload } = await request(API + '/sessions/' + session.id, jsonOptions('PATCH', {
        dateFrom: form.elements.dateFrom.value, dateTo: form.elements.dateTo.value, version: session.version
      }));
      if (!response.ok) { $('stDatesError').textContent = payload.error || 'Không đổi được ngày của đợt.'; return; }
      dialog.close();
      notify('Đã đổi ngày của đợt ' + session.name + '.');
      await loadSessions(session.id);
    });
  }
```

Khi khởi tạo trang:

```js
    setInterval(pollOrderStatus, ORDER_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) pollOrderStatus(); });
```

- [ ] **Step 4: Kiểm tra trên trình duyệt** với server mẫu PGlite, dữ liệu giả: Sửa ngày, cảnh báo ngoài khoảng, thêm đơn rồi bảng tự cập nhật trong 30 giây, ô đang gõ không mất, Giá vốn `163,502.86` không bị cắt, sáng/tối, 375px.

- [ ] **Step 5: Commit** `feat(kiem-ke): sua ngay, bao don ngoai khoang, tu cap nhat don TEAM, gia von so le`

### Task 5: Đối chiếu, tài liệu, kiểm thử cuối

**Files:**
- Modify: `README.md`, `server/README.md`, `server/kiotviet/API_ENDPOINTS.md`, `docs/04-planning/implementation_plan.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `docs/01-brd/BRD_Dashboard_GoogleSheets.md`, `CURRENT.md`, `graphify-out/`

- [ ] **Step 1: Đối chiếu chỉ đọc** với `kiem-ke-KK-7-11.xlsx`: quét `/products`, tính `round(tồn × giá mới)` so với cột GIÁ TRỊ KIOT, báo số mã còn lệch và nguyên nhân.
- [ ] **Step 2: Tài liệu** theo `.agents/skills/update-file/SKILL.md`: entity `product_costs`, API `order-status`, `PATCH` nhận ngày, mẫu tên khách, cách cập nhật giá vốn.
- [ ] **Step 3: Test** `stocktake/`, `kiotvietSync/`, rollback kiểm kê, frontend liên quan. Chạy `npm test` trong `server/`, so các lỗi với `origin/main`.
- [ ] **Step 4: `graphify update .`**
- [ ] **Step 5: Commit** `docs(kiem-ke): cap nhat tai lieu gom don TEAM va dong bo gia von`
