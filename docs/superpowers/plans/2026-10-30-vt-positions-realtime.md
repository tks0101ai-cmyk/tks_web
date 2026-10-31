# VT Positions Realtime (SSE) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bảng `/vt-positions/` tự cập nhật số liệu khi người khác thay đổi, không dựng lại bảng, giữ nguyên bộ lọc, cột, trang, vị trí cuộn, focus và hộp chi tiết đang mở.

**Architecture:** Mọi giao dịch ghi `stock_positions` đi qua `withTransaction` + `lockBranch` (cả `stockPositionsService` lẫn `pickAssignmentsService`). Sau `COMMIT`, hook phát `stock-positions-changed {branch}` trên `dashboardRollupEvents`, bus này đã có cầu Postgres NOTIFY giữa `worker.js` và web nên job Kiot chạy ở worker vẫn tới được trình duyệt. Route SSE `GET /api/stock-positions/events` chuyển tín hiệu (không kèm dữ liệu). Client nhận tín hiệu, tải nền danh sách, rồi đối chiếu `<tbody>` theo `data-id`: giữ node không đổi, chỉ sửa ô khác nhau.

**Tech Stack:** Node.js CommonJS + Express, `node:test`, PGlite (test service), JSDOM (test client), Vanilla JS/CSS. Không thêm thư viện.

**Spec:** `docs/superpowers/specs/2026-10-30-vt-positions-realtime-design.md`

## Global Constraints

- CommonJS (`require`/`module.exports`), không framework client, không Tailwind.
- Comment trong file server viết tiếng Việt KHÔNG dấu (theo các file server hiện có); comment trong `public/vt-positions/*.js` viết tiếng Việt có dấu.
- Cơ sở trong payload và query là `HN` | `SG`.
- Tên sự kiện nội bộ: `stock-positions-changed`. Tên sự kiện SSE gửi trình duyệt: `positions-changed`. Payload SSE: `{"branch":"HN"}`.
- SSE: header `Content-Type: text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`; heartbeat 25000 ms; `req.socket.setTimeout(0)`; gọi `res.flush()` nếu có.
- Client: debounce 300 ms, tải bù mỗi 60000 ms khi SSE lỗi, nháy ô 1600 ms, tắt nháy khi `prefers-reduced-motion`.
- Chỉ 1 instance web (+ tối đa 1 worker): không thêm Redis hay hạ tầng mới.
- Chạy test từ `D:\Web TKS Dashboard\server` bằng đường dẫn file cụ thể (`node --test <file>`), không dùng glob trần.
- Commit kết thúc bằng dòng `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Trách nhiệm |
|---|---|
| `server/stockPositions/stockPositionsEvents.js` (tạo) | Hằng sự kiện + `announceChanged(branch)` trên bus dùng chung |
| `server/stockPositions/stockPositionsService.js` (sửa) | `lockBranch` ghi nhớ cơ sở; `withTransaction` phát sau COMMIT |
| `server/stockPositions/stockPositionsRoutes.js` (sửa) | Route SSE `GET /api/stock-positions/events` |
| `server/public/vt-positions/vt-positions.js` (sửa) | Đối chiếu tbody, tải nền, EventSource, dải cảnh báo hộp chi tiết |
| `server/public/vt-positions/index.html` (sửa) | Dải "dòng vừa được sửa" trong hộp chi tiết |
| `server/public/vt-positions/vt-positions.css` (sửa) | Nháy ô, dải cảnh báo |
| `server/stockPositions/stockPositionsService.test.js` (sửa) | Test phát sự kiện |
| `server/stockPositions/stockPositionsRoutes.test.js` (sửa) | Test route SSE |
| `server/test/frontend/vt-positions-live.test.js` (tạo) | Test client |

---

### Task 1: Phát tín hiệu sau COMMIT

**Files:**
- Create: `server/stockPositions/stockPositionsEvents.js`
- Modify: `server/stockPositions/stockPositionsService.js:1-20` (require), `:93-108` (`withTransaction`, `lockBranch`)
- Test: `server/stockPositions/stockPositionsService.test.js`

**Interfaces:**
- Produces: `require('./stockPositionsEvents')` → `{ events, CHANGED, announceChanged(branch) }`. `events` là `dashboardRollupEvents`; `CHANGED === 'stock-positions-changed'`. Task 2 dùng `events` và `CHANGED`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `server/stockPositions/stockPositionsService.test.js` (import `events`, `CHANGED` ở đầu file cùng các `require` khác: `const { events, CHANGED } = require('./stockPositionsEvents');`):

```js
function collectChanges(t) {
  const seen = [];
  const listener = payload => seen.push(payload.branch);
  events.on(CHANGED, listener);
  t.after(() => events.off(CHANGED, listener));
  return seen;
}

test('phat tin hieu doi sau khi COMMIT, dung co so, khong phat khi doc', async t => {
  const { db, service } = await fixture();
  const seen = collectChanges(t);
  try {
    await service.list(ctx(), 'HN');
    assert.deepEqual(seen, []);
    await service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 10', location: 'Z1' });
    assert.deepEqual(seen, ['HN']);
    await service.create(ctx(), 'SG', { code: 'AAA1', notes: '1T x 10', location: 'Z2' });
    assert.deepEqual(seen, ['HN', 'SG']);
  } finally { await db.close(); }
});

test('khong phat tin hieu khi giao dich ROLLBACK', async t => {
  const { db, service } = await fixture();
  const seen = collectChanges(t);
  try {
    await assert.rejects(service.create(ctx(), 'HN', { code: 'AAA1', notes: '1T x 10', location: 'Z1', arrivalDate: 123 }));
    await assert.rejects(service.update(ctx(), 999999, { version: 1, notes: '1T x 5' }));
    assert.deepEqual(seen, []);
  } finally { await db.close(); }
});
```

> Nếu `create` với `arrivalDate: 123` không bị từ chối, đổi sang đầu vào sai khác đã có test từ chối trong file (grep `assert.rejects` trong file này để lấy một ví dụ) — mục đích là một lần ghi bị lỗi trước COMMIT.

- [ ] **Step 2: Chạy để thấy thất bại**

Run: `cd "D:/Web TKS Dashboard/server" && node --test stockPositions/stockPositionsService.test.js`
Expected: FAIL (`Cannot find module './stockPositionsEvents'`).

- [ ] **Step 3: Tạo module sự kiện**

`server/stockPositions/stockPositionsEvents.js`:

```js
'use strict';

// Tin hieu "bang vi tri cua co so X vua doi" (khong kem du lieu). Dung chung bus voi dashboard
// (kiotvietSync/dashboardRollupEvents.js) de job chay o worker.js cung toi duoc web qua cau Postgres NOTIFY.
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');

const CHANGED = 'stock-positions-changed';

function announceChanged(branch) {
  dashboardRollupEvents.emit(CHANGED, { branch });
}

module.exports = { events: dashboardRollupEvents, CHANGED, announceChanged };
```

- [ ] **Step 4: Móc vào `withTransaction` / `lockBranch`**

Trong `stockPositionsService.js` thêm sau các `require` hiện có:

```js
const { announceChanged } = require('./stockPositionsEvents');
```

Thay khối `withTransaction` và `lockBranch` (dòng 93-108) bằng:

```js
// Co so ma giao dich dang giu khoa (lockBranch) -> phat tin hieu "da doi" sau COMMIT, khong phat khi ROLLBACK.
const touchedBranches = new WeakMap();

function announceTouched(client) {
  const branches = touchedBranches.get(client);
  touchedBranches.delete(client);
  if (!branches) return;
  for (const branch of branches) {
    try { announceChanged(branch); } catch (error) { console.error('[stock-positions] khong phat duoc tin hieu doi:', error.message); }
  }
}

async function withTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    announceTouched(client);
    return result;
  } catch (error) {
    touchedBranches.delete(client);
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

const lockBranch = (client, branch) => {
  const branches = touchedBranches.get(client) || touchedBranches.set(client, new Set()).get(client);
  branches.add(branch);
  return client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['stock_positions:' + branch]);
};
```

- [ ] **Step 5: Chạy test**

Run: `cd "D:/Web TKS Dashboard/server" && node --test stockPositions/stockPositionsService.test.js pickAssignments/pickAssignmentsService.test.js pickAssignments/pickStatusFlow.test.js pickAssignments/pickKiotReconcileJob.test.js`
Expected: PASS toàn bộ (pick dùng chung `withTransaction`/`lockBranch` nên được phủ gián tiếp; `grep -n "withTransaction\|lockBranch" pickAssignments/pickAssignmentsService.js` xác nhận nó import từ service chứ không định nghĩa riêng).

- [ ] **Step 6: Commit**

```bash
cd "D:/Web TKS Dashboard" && git add server/stockPositions/stockPositionsEvents.js server/stockPositions/stockPositionsService.js server/stockPositions/stockPositionsService.test.js
git commit -m "feat(vt-positions): phat tin hieu doi sau COMMIT cho moi duong ghi vi tri

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Route SSE `/api/stock-positions/events`

**Files:**
- Modify: `server/stockPositions/stockPositionsRoutes.js:10` (require), `:49-52` (thêm route sau `GET /api/stock-positions`)
- Test: `server/stockPositions/stockPositionsRoutes.test.js`

**Interfaces:**
- Consumes: `events`, `CHANGED` từ `./stockPositionsEvents` (Task 1).
- Produces: `GET /api/stock-positions/events?branch=HN|SG` → stream `:ok`, rồi `event: positions-changed\ndata: {"branch":"HN"}\n\n`, heartbeat `:heartbeat`. 403 `BRANCH_FORBIDDEN` khi cơ sở nằm ngoài phạm vi cookie. Task 4 dùng đường dẫn và tên sự kiện này.

- [ ] **Step 1: Viết test thất bại**

Trong `stockPositionsRoutes.test.js`: thêm `const { EventEmitter } = require('node:events'); const { CHANGED } = require('./stockPositionsEvents');` ở đầu, sửa `start` nhận thêm `events` và truyền vào router:

```js
async function start(t, { user = MANAGER, scope = 'Cả hai', events } = {}) {
```
```js
  app.use(createStockPositionsRouter({
    requireAuth: (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Chưa đăng nhập.' })),
    resolveBranch: (req, res, next) => { req.branch = scope; next(); },
    service,
    ...(events ? { events } : {})
  }));
```

Thêm test:

```js
async function readUntil(reader, text) {
  const decoder = new TextDecoder();
  let buffer = '';
  while (!buffer.includes(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  return buffer;
}

test('GET /events: mở SSE, chỉ nhận tín hiệu đúng cơ sở, dọn listener khi đóng', async t => {
  const events = new EventEmitter();
  const { base } = await start(t, { events });
  const res = await fetch(base + '/events?branch=HN');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const reader = res.body.getReader();
  await readUntil(reader, ':ok');
  assert.equal(events.listenerCount(CHANGED), 1);
  events.emit(CHANGED, { branch: 'SG' });
  events.emit(CHANGED, { branch: 'HN' });
  const chunk = await readUntil(reader, 'positions-changed');
  assert.match(chunk, /event: positions-changed\ndata: \{"branch":"HN"\}\n\n/);
  assert.ok(!chunk.includes('SG'));
  await reader.cancel();
  for (let i = 0; i < 20 && events.listenerCount(CHANGED) > 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(events.listenerCount(CHANGED), 0);
});

test('GET /events: ngoài phạm vi cơ sở 403, thiếu quyền 403, chưa đăng nhập 401, cơ sở lạ 403', async t => {
  const events = new EventEmitter();
  const sg = await start(t, { scope: 'Sài Gòn', events });
  const forbidden = await fetch(sg.base + '/events?branch=HN');
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).code, 'BRANCH_FORBIDDEN');
  assert.equal((await fetch(sg.base + '/events?branch=XX')).status, 403);
  assert.equal((await fetch((await start(t, { user: { vaiTro: 'Nhân viên kho' }, events })).base + '/events?branch=HN')).status, 403);
  assert.equal((await fetch((await start(t, { user: null, events })).base + '/events?branch=HN')).status, 401);
  assert.equal(events.listenerCount(CHANGED), 0);
});
```

- [ ] **Step 2: Chạy để thấy thất bại**

Run: `cd "D:/Web TKS Dashboard/server" && node --test stockPositions/stockPositionsRoutes.test.js`
Expected: FAIL (route chưa có: 404 / `content-type` sai).

- [ ] **Step 3: Thêm route**

Trong `stockPositionsRoutes.js` thêm `require` sau dòng 10:

```js
const { events: defaultEvents, CHANGED } = require('./stockPositionsEvents');
```

Thêm ngay sau `router.get('/api/stock-positions', ...)` (trước `code-suggestions`):

```js
  // SSE: bao "bang vi tri co so X vua doi" (khong keo du lieu) de trinh duyet tu tai nen; client lay du lieu bang GET list
  // voi quyen/co so cua chinh phien do. Ket noi giu mo -> proxy phai khong buffer (X-Accel-Buffering) va co heartbeat.
  router.get('/api/stock-positions/events', (req, res) => {
    const branch = String(req.query.branch || '').toUpperCase();
    if (!ctxOf(req).scope.includes(branch)) {
      return res.status(403).json({ error: 'Không có quyền xem vị trí hàng của cơ sở này.', code: 'BRANCH_FORBIDDEN' });
    }
    req.socket.setTimeout(0); // Node mac dinh ngat socket khong hoat dong sau ~2 phut
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const write = chunk => {
      try {
        res.write(chunk);
        // compression() boc res trong stream gzip co buffer rieng: khong flush thi su kien bi giu lai.
        if (typeof res.flush === 'function') res.flush();
      } catch { /* client da roi */ }
    };
    write(':ok\n\n');
    const bus = dependencies.events || defaultEvents;
    const onChanged = payload => {
      if (payload && payload.branch === branch) write(`event: positions-changed\ndata: ${JSON.stringify({ branch })}\n\n`);
    };
    bus.on(CHANGED, onChanged);
    const heartbeat = setInterval(() => write(':heartbeat\n\n'), 25000);
    req.on('close', () => {
      clearInterval(heartbeat);
      bus.off(CHANGED, onChanged);
    });
  });
```

- [ ] **Step 4: Chạy test**

Run: `cd "D:/Web TKS Dashboard/server" && node --test stockPositions/stockPositionsRoutes.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
cd "D:/Web TKS Dashboard" && git add server/stockPositions/stockPositionsRoutes.js server/stockPositions/stockPositionsRoutes.test.js
git commit -m "feat(vt-positions): route SSE /api/stock-positions/events bao bang vi tri doi

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Client đối chiếu bảng tại chỗ + tải nền

**Files:**
- Modify: `server/public/vt-positions/vt-positions.js` (`buildRow` :221-267, `render` :269-323, thêm hàm sau `render`, export :1522)
- Modify: `server/public/vt-positions/vt-positions.css` (cuối khối bảng, sau dòng 63)
- Test: `server/test/frontend/vt-positions-live.test.js` (tạo)

**Interfaces:**
- Produces trong `vt-positions.js`: `render(options)` với `options.background === true` nghĩa là cập nhật nền (nháy ô, không gọi `TKSTables.refresh` nếu không đổi); `refreshInBackground(tab)` → `Promise<void>`; export `window.TKSVtPositions.refresh()` = `refreshInBackground(activeTab)`. Task 4 gọi hai hàm này.
- Hằng: `const LIVE = { debounceMs: 300, fallbackMs: 60000, flashMs: 1600 }` (Task 4 dùng thêm hai trường đầu; export `TKSVtPositions.live = LIVE`).

- [ ] **Step 1: Viết test thất bại (khung dùng chung + các test đối chiếu)**

Tạo `server/test/frontend/vt-positions-live.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { resolvePermissions, PAGE_FEATURES } = require('../../auth/featureRegistry');

const publicDir = path.join(__dirname, '../../public');
const html = fs.readFileSync(path.join(publicDir, 'vt-positions/index.html'), 'utf8');
const code = fs.readFileSync(path.join(publicDir, 'vt-positions/vt-positions.js'), 'utf8');
const nav = fs.readFileSync(path.join(publicDir, 'shared/shared-nav.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const row = (id, extra = {}) => ({ id, code: 'MA' + id, name: 'Hàng ' + id, notes: '2T x 100', arrivalDate: '', location: 'K' + id, quantity: 200, available: 200, held: 0, kiotQuantity: 350, warnings: [], rawWarnings: [], acknowledged: false, updatedByName: 'Quản lý', updatedAt: '2026-10-27T02:30:00.000Z', version: 3, ...extra });
const BAD = (id = 1) => row(id, { notes: 'rác', quantity: null, warnings: ['unreadable'], rawWarnings: ['unreadable'] });

class FakeEventSource {
  constructor(url) { this.url = url; this.listeners = {}; this.closed = false; FakeEventSource.instances.push(this); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() { this.closed = true; }
  emit(type) { (this.listeners[type] || []).forEach(fn => fn({})); }
}

// data.rows là nguồn dữ liệu của máy chủ giả; đổi data.rows rồi gọi refresh()/emit để mô phỏng người khác sửa.
async function setup(t, { data = { rows: [row(1), row(2), row(3)] }, withEvents = false } = {}) {
  FakeEventSource.instances = [];
  const dom = new JSDOM(html, { url: 'https://tokosi.test/vt-positions/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const window = dom.window;
  Object.defineProperty(window, 'innerWidth', { value: 1024, writable: true });
  Object.defineProperty(window.document, 'hidden', { value: false, writable: true, configurable: true });
  window.matchMedia = () => ({ matches: false, addEventListener() {} });
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new window.Event('close')); };
  if (withEvents) window.EventSource = FakeEventSource;
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/fuzzy-search.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/carton.js'), 'utf8'));
  window.eval(fs.readFileSync(path.join(publicDir, 'shared/table-controls.js'), 'utf8'));
  window.eval(nav);
  const base = resolvePermissions({ vaiTro: 'Quản lý' });
  const permissions = [...new Set([...base, 'stockLocationsV2.view', 'stockLocationsV2.edit'])];
  const user = { vaiTro: 'Quản lý', branch: 'Cả hai', permissions, pageFeatures: PAGE_FEATURES };
  window.TKSNav.authGuard = async () => { window.TKSNav.setPermissions(user); return user; };
  const calls = [];
  window.fetch = async (url, options = {}) => {
    const parsed = new URL(url, window.location.href);
    if (parsed.pathname === '/api/me/table-prefs') return json({ tables: {} });
    const method = options.method || 'GET';
    calls.push({ method, path: parsed.pathname, query: parsed.searchParams, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions') return json({ branch: parsed.searchParams.get('branch'), canEdit: true, canExport: true, canDeleteHistory: false, rows: data.rows });
    if (method === 'GET' && parsed.pathname === '/api/stock-positions/history') return json({ rows: [], nextBefore: null });
    return json({ error: 'Không có mock' }, 500);
  };
  window.eval(code);
  window.TKSVtPositions.live.debounceMs = 10;
  window.TKSVtPositions.live.fallbackMs = 40;
  await window.TKSVtPositions.init();
  const lists = () => calls.filter(call => call.method === 'GET' && call.path === '/api/stock-positions').length;
  return { window, doc: window.document, calls, data, lists };
}

const cell = (tr, field) => tr.querySelector('td[data-field="' + field + '"]');
const ids = doc => [...doc.querySelectorAll('#vtRows tr')].map(tr => tr.dataset.id);

test('cập nhật nền: giữ nguyên node dòng + focus, chỉ sửa ô đổi và nháy ô đó', async t => {
  const { window, doc, data } = await setup(t);
  const tr1 = doc.querySelector('#vtRows tr[data-id="1"]');
  const tr2 = doc.querySelector('#vtRows tr[data-id="2"]');
  tr2.focus();
  assert.equal(doc.activeElement, tr2);
  data.rows = [row(1), row(2, { kiotQuantity: 999, available: 150, held: 50, version: 4 }), row(3)];
  await window.TKSVtPositions.refresh();
  assert.equal(doc.querySelector('#vtRows tr[data-id="1"]'), tr1);
  assert.equal(doc.querySelector('#vtRows tr[data-id="2"]'), tr2);
  assert.equal(doc.activeElement, tr2);
  assert.equal(cell(tr2, 'kiotQuantity').textContent, '999');
  assert.equal(cell(tr2, 'available').textContent, '150');
  assert.match(cell(tr2, 'available').title, /giữ chỗ 50/);
  assert.ok(cell(tr2, 'kiotQuantity').classList.contains('vt-cell-flash'));
  assert.ok(!cell(tr2, 'code').classList.contains('vt-cell-flash'));
  assert.ok(!cell(tr1, 'kiotQuantity').classList.contains('vt-cell-flash'));
});

test('cập nhật nền: dòng mới chèn đúng chỗ, dòng bị xóa gỡ đi, số đếm và bộ lọc cảnh báo cập nhật tại chỗ', async t => {
  const { window, doc, data } = await setup(t);
  const tr1 = doc.querySelector('#vtRows tr[data-id="1"]');
  const tr3 = doc.querySelector('#vtRows tr[data-id="3"]');
  const warnOption = doc.querySelector('#vtWarnFilter option[value="warn"]');
  assert.match(warnOption.textContent, /Cảnh báo \(0\)/);
  data.rows = [row(1), BAD(4), row(3)];
  await window.TKSVtPositions.refresh();
  assert.deepEqual(ids(doc), ['1', '4', '3']);
  assert.equal(doc.querySelector('#vtRows tr[data-id="1"]'), tr1);
  assert.equal(doc.querySelector('#vtRows tr[data-id="3"]'), tr3);
  assert.match(doc.getElementById('vtCount').textContent, /1–3 \/ 3 dòng/);
  assert.equal(doc.querySelector('#vtWarnFilter option[value="warn"]'), warnOption, 'node option giữ nguyên');
  assert.match(warnOption.textContent, /Cảnh báo \(1\)/);
  assert.ok(doc.querySelector('#vtWarnFilter option[value="type:unreadable"]').textContent.includes('(1)'));
  data.rows = [row(3), row(1)];
  await window.TKSVtPositions.refresh();
  assert.deepEqual(ids(doc), ['3', '1']);
  assert.equal(doc.querySelector('#vtRows tr[data-id="1"]'), tr1);
});

test('cập nhật nền giữ từ khóa tìm, bộ lọc, trang; render thường (gõ tìm) không nháy ô', async t => {
  const { window, doc, data } = await setup(t);
  const search = doc.getElementById('vtSearch');
  search.value = 'MA2';
  search.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(ids(doc), ['2']);
  assert.equal(doc.querySelectorAll('.vt-cell-flash').length, 0);
  data.rows = [row(1), row(2, { kiotQuantity: 5, version: 4 }), row(3)];
  await window.TKSVtPositions.refresh();
  assert.equal(search.value, 'MA2');
  assert.deepEqual(ids(doc), ['2']);
  assert.equal(cell(doc.querySelector('#vtRows tr[data-id="2"]'), 'kiotQuantity').textContent, '5');
});
```

> Các test dùng `window.TKSVtPositions.live` và `.refresh()` — chưa có nên thất bại ở bước này là đúng.

- [ ] **Step 2: Chạy để thấy thất bại**

Run: `cd "D:/Web TKS Dashboard/server" && node --test test/frontend/vt-positions-live.test.js`
Expected: FAIL (`Cannot read properties of undefined (reading 'debounceMs')`).

- [ ] **Step 3: `vt-positions.js` — chữ ký, hằng, tiện ích**

Ngay sau dòng `const collator = ...` (dòng 29) thêm:

```js
  // Cập nhật thời gian thực: debounce tín hiệu SSE, chu kỳ tải bù khi SSE lỗi, thời gian nháy ô vừa đổi.
  const LIVE = { debounceMs: 300, fallbackMs: 60000, flashMs: 1600 };
  // Chữ ký nội dung của dòng/ô lúc dựng (không đọc lại từ DOM vì table-controls có thể thêm thuộc tính).
  const signatures = new WeakMap();
```

Trước `function buildRow` thêm:

```js
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };
```

Cuối `buildRow`, thay `return tr;` (dòng 266) bằng:

```js
    signatures.set(tr, tr.className + '\u0001' + (tr.dataset.warning || ''));
    Array.from(tr.children).forEach(td => signatures.set(td, td.innerHTML + '\u0001' + td.title));
    return tr;
```

- [ ] **Step 4: `vt-positions.js` — đối chiếu tbody**

Thêm ngay trước `function render()`:

```js
  function flashCell(cell) {
    cell.classList.add('vt-cell-flash');
    setTimeout(() => cell.classList.remove('vt-cell-flash'), LIVE.flashMs);
  }

  // Sửa dòng đang có cho khớp bản mới: chỉ ô nào chữ ký khác mới bị thay nội dung. Trả về true nếu có gì đổi.
  function patchRow(node, fresh, flash) {
    let changed = false;
    if (signatures.get(node) !== signatures.get(fresh)) {
      node.className = fresh.className;
      if (fresh.dataset.warning) node.dataset.warning = fresh.dataset.warning; else delete node.dataset.warning;
      signatures.set(node, signatures.get(fresh));
      changed = true;
    }
    Array.from(node.children).forEach((cell, index) => {
      const next = fresh.children[index];
      if (!next || signatures.get(cell) === signatures.get(next)) return;
      cell.replaceChildren(...Array.from(next.childNodes));
      if (next.title) cell.title = next.title; else cell.removeAttribute('title');
      signatures.set(cell, signatures.get(next));
      changed = true;
      if (flash) flashCell(cell);
    });
    return changed;
  }

  // Đối chiếu <tbody> theo data-id thay vì dựng lại: giữ node (focus, hover, cuộn) của dòng không đổi, chèn dòng mới đúng chỗ,
  // gỡ dòng không còn. Trả về true nếu DOM có thay đổi.
  function reconcileRows(body, rows, flash) {
    const existing = new Map();
    Array.from(body.children).forEach(node => existing.set(node.dataset.id, node));
    let cursor = body.firstElementChild;
    let changed = false;
    rows.forEach(row => {
      const fresh = buildRow(row);
      const node = existing.get(String(row.id));
      if (!node) { body.insertBefore(fresh, cursor); changed = true; return; }
      existing.delete(String(row.id));
      if (node === cursor) cursor = cursor.nextElementSibling;
      else { body.insertBefore(node, cursor); changed = true; }
      if (patchRow(node, fresh, flash)) changed = true;
    });
    existing.forEach(node => { node.remove(); changed = true; });
    return changed;
  }

  // Cập nhật nhãn/số đếm của bộ lọc cảnh báo tại chỗ (giữ node <option> để danh sách đang mở không bị đóng).
  function syncWarnOptions(select, current) {
    const wanted = new Set([...Object.keys(WARNING_LABELS), ...current.rows.flatMap(warningsOf)]);
    if (current.warnFilter.startsWith('type:')) wanted.add(current.warnFilter.slice(5));
    const existing = new Map();
    select.querySelectorAll('option[data-warning-type]').forEach(option => existing.set(option.dataset.warningType, option));
    existing.forEach((option, code) => { if (!wanted.has(code)) option.remove(); });
    wanted.forEach(code => {
      let option = existing.get(code);
      if (!option) {
        option = document.createElement('option');
        option.value = 'type:' + code;
        option.dataset.warningType = code;
        select.appendChild(option);
      }
      setText(option, warningLabel(code) + ' (' + formatNumber(current.rows.filter(row => warningsOf(row).includes(code)).length) + ')');
    });
  }
```

- [ ] **Step 5: `vt-positions.js` — sửa `render`**

Đổi chữ ký `function render() {` → `function render(options = {}) {`.

Thay dòng 277-294 (từ comment "Bộ lọc cảnh báo" đến `select.disabled = ...`) bằng:

```js
    // Bộ lọc cảnh báo: số đếm tính trên toàn bộ dòng của cơ sở (không theo từ khóa tìm).
    const select = $('vtWarnFilter');
    const warned = current.rows.filter(row => warningsOf(row).length > 0).length;
    setText(select.querySelector('option[value="warn"]'), 'Cảnh báo (' + formatNumber(warned) + ')');
    setText(select.querySelector('option[value="valid"]'), 'Hợp lệ (' + formatNumber(current.rows.length - warned) + ')');
    syncWarnOptions(select, current);
    if (select.value !== current.warnFilter) select.value = current.warnFilter;
    select.parentElement.dataset.filter = current.warnFilter;
    select.disabled = current.loading || !!current.error;
```

Thay hai dòng 298-299:

```js
    const body = $('vtRows');
    body.replaceChildren();
```
bằng:
```js
    const body = $('vtRows');
```

Thay dòng 309-315:

```js
    $('vtPager').hidden = !ready;
    if (!ready) return;

    const fragment = document.createDocumentFragment();
    rows.slice(start, start + pageSize).forEach(row => fragment.appendChild(buildRow(row)));
    body.appendChild(fragment);
    if (window.TKSTables) window.TKSTables.refresh($('vtTable'));
```
bằng:
```js
    $('vtPager').hidden = !ready;
    if (!ready) { body.replaceChildren(); return; }

    const changed = reconcileRows(body, rows.slice(start, start + pageSize), options.background === true);
    // Cập nhật nền mà không đổi gì thì khỏi áp lại cấu hình bảng.
    if (window.TKSTables && (changed || options.background !== true)) window.TKSTables.refresh($('vtTable'));
```

- [ ] **Step 6: `vt-positions.js` — tải nền + export**

Thêm ngay sau hàm `selectTab` (sau dòng `}` kết thúc ~1331):

```js
  // Tải lại danh sách ở nền (không đặt loading, không xóa dòng) rồi vá bảng tại chỗ. Bỏ kết quả nếu đã đổi tab giữa chừng.
  // Một yêu cầu tại một thời điểm; tín hiệu đến lúc đang tải thì tải thêm một lần sau khi xong.
  const live = { busy: false, pending: false };
  async function refreshInBackground(tab) {
    if (!tab || tab !== activeTab) return;
    if (live.busy) { live.pending = true; return; }
    live.busy = true;
    const version = requestVersion;
    try {
      const { response, payload } = await request(API + '?branch=' + tab.toUpperCase());
      if (version !== requestVersion || tab !== activeTab) return;
      if (!response.ok || payload.branch !== tab.toUpperCase() || !Array.isArray(payload.rows)) return;
      const current = state[tab];
      current.rows = payload.rows;
      current.error = '';
      current.canEdit = typeof payload.canEdit === 'boolean' ? payload.canEdit : null;
      current.canExport = payload.canExport === true;
      current.canDeleteHistory = payload.canDeleteHistory === true;
      render({ background: true });
    } catch (error) { /* lần tải bù sau sẽ thử lại */ } finally {
      live.busy = false;
      if (live.pending) { live.pending = false; refreshInBackground(activeTab); }
    }
  }
```

Đổi dòng export cuối file thành:

```js
  window.TKSVtPositions = { init, normalizeSearch, filterRows, sortRows, formatTime, refresh: () => refreshInBackground(activeTab), live: LIVE };
```

- [ ] **Step 7: CSS nháy ô**

Trong `vt-positions.css` sau dòng 63 (`tr.vt-row:focus-visible td{...}`) thêm:

```css
/* Ô vừa đổi do người khác sửa: nháy nền xanh nhạt rồi tắt. */
.vt-table td.vt-cell-flash{animation:vt-cell-flash 1.6s ease-out}
@keyframes vt-cell-flash{from{background:color-mix(in srgb,var(--blue) 30%,transparent)}to{background:transparent}}
@media (prefers-reduced-motion:reduce){.vt-table td.vt-cell-flash{animation:none}}
```

- [ ] **Step 8: Chạy test**

Run: `cd "D:/Web TKS Dashboard/server" && node --test test/frontend/vt-positions-live.test.js test/frontend/vt-positions.test.js test/frontend/vt-positions-detail.test.js test/frontend/vt-positions-ack-purge.test.js test/frontend/vt-positions-history.test.js test/frontend/vt-positions-nav.test.js`
Expected: PASS toàn bộ. Nếu một test cũ thất bại vì giả định `<tbody>` bị dựng lại (vd giữ tham chiếu tới `tr` cũ), sửa test theo hành vi mới (node được giữ) chứ không hoàn nguyên `render`.

- [ ] **Step 9: Commit**

```bash
cd "D:/Web TKS Dashboard" && git add server/public/vt-positions/vt-positions.js server/public/vt-positions/vt-positions.css server/test/frontend/vt-positions-live.test.js
git commit -m "feat(vt-positions): doi chieu tbody tai cho va tai nen, khong dung lai bang

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Client nghe SSE + hộp chi tiết đang mở

**Files:**
- Modify: `server/public/vt-positions/vt-positions.js` (`detail` :38, `openDetail` :535-557, `selectTab` :1295-1331, `bindDetail` :1423, `init` cuối)
- Modify: `server/public/vt-positions/index.html:260-261` (dải cảnh báo)
- Modify: `server/public/vt-positions/vt-positions.css` (dải cảnh báo)
- Test: `server/test/frontend/vt-positions-live.test.js`

**Interfaces:**
- Consumes: `refreshInBackground`, `LIVE`, `render({background:true})` (Task 3); SSE `GET /api/stock-positions/events?branch=HN|SG`, sự kiện `positions-changed` (Task 2).
- Produces: `startLive(tab)`, `stopLive()`, `syncOpenDetail()`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `vt-positions-live.test.js`:

```js
test('SSE: mở đúng cơ sở, gộp nhiều tín hiệu thành một lần tải, bảng vá tại chỗ', async t => {
  const { window, doc, data, lists } = await setup(t, { withEvents: true });
  assert.equal(FakeEventSource.instances.length, 1);
  assert.match(FakeEventSource.instances[0].url, /\/api\/stock-positions\/events\?branch=HN$/);
  const before = lists();
  const tr1 = doc.querySelector('#vtRows tr[data-id="1"]');
  data.rows = [row(1, { kiotQuantity: 77, version: 4 }), row(2), row(3)];
  const source = FakeEventSource.instances[0];
  source.emit('positions-changed'); source.emit('positions-changed'); source.emit('positions-changed');
  await sleep(80);
  assert.equal(lists(), before + 1);
  assert.equal(doc.querySelector('#vtRows tr[data-id="1"]'), tr1);
  assert.equal(cell(tr1, 'kiotQuantity').textContent, '77');
});

test('SSE: đổi tab đóng nguồn cũ và mở nguồn cơ sở mới; mở lại sau ngắt thì tải bù', async t => {
  const { window, lists } = await setup(t, { withEvents: true });
  const first = FakeEventSource.instances[0];
  first.emit('open');
  const afterFirstOpen = lists();
  first.emit('open'); // nối lại sau khi ngắt -> tải bù
  await sleep(60);
  assert.equal(lists(), afterFirstOpen + 1);
  window.location.hash = 'sg';
  await settle(); await sleep(30);
  assert.equal(first.closed, true);
  const second = FakeEventSource.instances[FakeEventSource.instances.length - 1];
  assert.match(second.url, /branch=SG$/);
});

test('SSE: tab ẩn thì không tải, hiện lại thì tải bù một lần; trình duyệt không có EventSource vẫn chạy', async t => {
  const { window, doc, lists } = await setup(t, { withEvents: true });
  const source = FakeEventSource.instances[0];
  Object.defineProperty(doc, 'hidden', { value: true, configurable: true });
  const before = lists();
  source.emit('positions-changed');
  await sleep(60);
  assert.equal(lists(), before);
  Object.defineProperty(doc, 'hidden', { value: false, configurable: true });
  doc.dispatchEvent(new window.Event('visibilitychange'));
  await sleep(60);
  assert.equal(lists(), before + 1);
  const plain = await setup(t);
  assert.equal(plain.doc.querySelectorAll('#vtRows tr').length, 3);
});

test('SSE lỗi: bật tải bù định kỳ, kết nối lại thì tắt', async t => {
  const { lists } = await setup(t, { withEvents: true });
  const source = FakeEventSource.instances[0];
  const before = lists();
  source.emit('error');
  await sleep(150);
  assert.ok(lists() >= before + 2, 'tải bù lặp theo fallbackMs');
  source.emit('open');
  await sleep(30);
  const settled = lists();
  await sleep(150);
  assert.equal(lists(), settled);
});

test('hộp chi tiết đang mở: không bị đóng/mất chữ đang gõ; dòng đổi hiện dải cảnh báo, Xem bản mới nạp lại', async t => {
  const { window, doc, data } = await setup(t, { withEvents: true });
  doc.querySelector('#vtRows tr[data-id="2"]').click();
  await settle();
  const dialog = doc.getElementById('vtDetailDialog');
  const notes = doc.querySelector('#vtDetailForm [name="notes"]');
  notes.value = '9T x 100';
  notes.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(doc.getElementById('vtDetailStale').hidden, true);
  data.rows = [row(1), row(2, { notes: '5T x 100', version: 4 }), row(3)];
  FakeEventSource.instances[0].emit('positions-changed');
  await sleep(80);
  assert.ok(dialog.hasAttribute('open'), 'hộp vẫn mở');
  assert.equal(notes.value, '9T x 100', 'chữ đang gõ giữ nguyên');
  assert.equal(doc.getElementById('vtDetailStale').hidden, false);
  assert.match(doc.getElementById('vtDetailStaleText').textContent, /người khác sửa/);
  doc.getElementById('vtDetailStaleReload').click();
  await settle();
  assert.equal(notes.value, '5T x 100');
  assert.equal(doc.getElementById('vtDetailStale').hidden, true);
  assert.ok(dialog.hasAttribute('open'));
});

test('hộp chi tiết đang mở: dòng bị xóa thì báo đã xóa và ẩn nút Xem bản mới; version giữ nguyên thì cập nhật số phái sinh', async t => {
  const { doc, data } = await setup(t, { withEvents: true });
  doc.querySelector('#vtRows tr[data-id="2"]').click();
  await settle();
  data.rows = [row(1), row(2, { kiotQuantity: 123 }), row(3)];
  FakeEventSource.instances[0].emit('positions-changed');
  await sleep(80);
  assert.equal(doc.getElementById('vtDetailStale').hidden, true, 'version không đổi: không báo');
  assert.equal(doc.getElementById('vtDetailKiot').textContent, '123');
  data.rows = [row(1), row(3)];
  FakeEventSource.instances[0].emit('positions-changed');
  await sleep(80);
  assert.equal(doc.getElementById('vtDetailStale').hidden, false);
  assert.match(doc.getElementById('vtDetailStaleText').textContent, /xóa/);
  assert.equal(doc.getElementById('vtDetailStaleReload').hidden, true);
});
```

- [ ] **Step 2: Chạy để thấy thất bại**

Run: `cd "D:/Web TKS Dashboard/server" && node --test test/frontend/vt-positions-live.test.js`
Expected: các test mới FAIL (chưa có EventSource, `vtDetailStale` null).

- [ ] **Step 3: HTML + CSS dải cảnh báo**

`index.html`, thêm ngay TRƯỚC dòng `<p class="vt-form-error vt-detail-error" id="vtDetailError" ...>` (dòng 261):

```html
          <div class="vt-detail-stale" id="vtDetailStale" role="status" aria-live="polite" hidden>
            <span id="vtDetailStaleText"></span>
            <button type="button" class="vt-row-button" id="vtDetailStaleReload">Xem bản mới</button>
          </div>
```

`vt-positions.css`, thêm sau khối `vt-cell-flash`:

```css
/* Hộp chi tiết đang mở mà dòng bị người khác sửa/xóa. */
.vt-detail-stale{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:0 0 10px;padding:8px 12px;border:1px solid color-mix(in srgb,var(--blue) 55%,transparent);border-radius:var(--radius-sm);background:color-mix(in srgb,var(--blue) 10%,transparent);font-size:13px}
.vt-detail-stale[hidden]{display:none}
.vt-detail-stale .vt-row-button{margin-right:0}
```

- [ ] **Step 4: `vt-positions.js` — hộp chi tiết**

Dòng 38: thêm `fresh: null` vào `detail`:

```js
  const detail = { id: null, tab: '', row: null, fresh: null, rows: [], nextBefore: null, version: 0, busy: false };
```

Trong `openDetail`, ngay sau `detail.row = row;` thêm `detail.fresh = null;`, ngay sau `setDetailError('');` thêm:

```js
    $('vtDetailStale').hidden = true;
```
và thay `openDialog($('vtDetailDialog'));` (dòng 555) bằng:
```js
    if (!$('vtDetailDialog').open) openDialog($('vtDetailDialog'));
```

Thêm hàm sau `openDetail`:

```js
  // Sau mỗi lần tải nền: hộp chi tiết đang mở KHÔNG bị đóng hay ghi đè. Dòng đổi version -> hiện dải + nút Xem bản mới;
  // dòng bị xóa -> báo đã xóa; version giữ nguyên nhưng số phái sinh (SL Kiot, giữ chỗ) đổi -> cập nhật thẳng.
  function syncOpenDetail() {
    if (detail.id === null || !detail.row || detail.tab !== activeTab) return;
    const fresh = state[activeTab].rows.find(item => String(item.id) === String(detail.id));
    const banner = $('vtDetailStale');
    const reload = $('vtDetailStaleReload');
    if (!fresh) {
      $('vtDetailStaleText').textContent = 'Dòng này vừa bị người khác xóa.';
      reload.hidden = true;
      banner.hidden = false;
      return;
    }
    if (fresh.version !== detail.row.version) {
      detail.fresh = fresh;
      $('vtDetailStaleText').textContent = 'Dòng này vừa được người khác sửa.';
      reload.hidden = false;
      banner.hidden = false;
      return;
    }
    detail.row = fresh;
    renderDetailStats();
  }
```

Trong `refreshInBackground` (Task 3), ngay sau `render({ background: true });` thêm `syncOpenDetail();`.

Trong `bindDetail`, thêm cuối hàm:

```js
    $('vtDetailStaleReload').addEventListener('click', () => { if (detail.fresh) openDetail(detail.fresh); });
```

- [ ] **Step 5: `vt-positions.js` — EventSource, hiện/ẩn tab**

Thêm sau `refreshInBackground`:

```js
  // ---------- Thời gian thực (SSE) ----------
  // Máy chủ chỉ báo "cơ sở này vừa đổi"; ở đây gộp tín hiệu rồi tải nền. SSE lỗi -> tải bù định kỳ cho tới khi nối lại.
  const feed = { source: null, tab: '', debounce: null, fallback: null, opened: false, missed: false };

  function scheduleRefresh() {
    clearTimeout(feed.debounce);
    feed.debounce = setTimeout(() => {
      if (document.hidden) { feed.missed = true; return; }
      refreshInBackground(activeTab);
    }, LIVE.debounceMs);
  }

  function stopFallback() { clearInterval(feed.fallback); feed.fallback = null; }

  function stopLive() {
    if (feed.source) feed.source.close();
    feed.source = null;
    feed.opened = false;
    clearTimeout(feed.debounce);
    stopFallback();
  }

  function startLive(tab) {
    stopLive();
    if (typeof window.EventSource !== 'function') return;
    const source = new window.EventSource(API + '/events?branch=' + tab.toUpperCase());
    feed.source = source;
    feed.tab = tab;
    source.addEventListener('positions-changed', scheduleRefresh);
    source.addEventListener('open', () => {
      stopFallback();
      if (feed.opened) scheduleRefresh(); // nối lại sau khi ngắt: có thể đã lỡ tín hiệu
      feed.opened = true;
    });
    source.addEventListener('error', () => {
      if (!feed.fallback) feed.fallback = setInterval(() => { if (!document.hidden) refreshInBackground(activeTab); }, LIVE.fallbackMs);
    });
  }
```

Trong `selectTab`: ngay sau `const tab = activeTab;` (dòng 1302) thêm `stopLive();`; trong `finally` đổi thành:

```js
    } finally {
      if (version === requestVersion) { current.loading = false; render(); startLive(tab); }
    }
```

Trong `init`, ngay trước `await selectTab(window.location.hash.slice(1));` thêm:

```js
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && feed.missed) { feed.missed = false; refreshInBackground(activeTab); }
    });
    window.addEventListener('pagehide', stopLive);
```

- [ ] **Step 6: Chạy test**

Run: `cd "D:/Web TKS Dashboard/server" && node --test test/frontend/vt-positions-live.test.js test/frontend/vt-positions.test.js test/frontend/vt-positions-detail.test.js test/frontend/vt-positions-ack-purge.test.js test/frontend/vt-positions-history.test.js test/frontend/vt-positions-nav.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 7: Commit**

```bash
cd "D:/Web TKS Dashboard" && git add server/public/vt-positions server/test/frontend/vt-positions-live.test.js
git commit -m "feat(vt-positions): nghe SSE, tai bu khi mat ket noi, bao dong dang mo vua doi

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Kiểm thử tổng, xem thật trên trình duyệt, tài liệu, graphify

**Files:**
- Modify: `README.md`, `server/README.md`, `CURRENT.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`
- Modify: `C:\Users\BOSS\.claude\projects\D--Web-TKS-Dashboard\memory\project-tokosi-vt-positions.md` (+ dòng chỉ mục nếu cần)

- [ ] **Step 1: Chạy bộ test liên quan**

Run: `cd "D:/Web TKS Dashboard/server" && node --test stockPositions/stockPositionsService.test.js stockPositions/stockPositionsRoutes.test.js stockPositions/stockPositionsHistoryLabels.test.js pickAssignments/pickAssignmentsService.test.js pickAssignments/pickStatusFlow.test.js pickAssignments/pickKiotReconcileJob.test.js test/frontend/vt-positions.test.js test/frontend/vt-positions-live.test.js test/frontend/vt-positions-detail.test.js test/frontend/vt-positions-ack-purge.test.js test/frontend/vt-positions-history.test.js test/frontend/vt-positions-nav.test.js auth/featureRegistry.test.js auth/pageGuard.test.js`
Expected: 100% xanh.

- [ ] **Step 2: Kiểm tra thật trên trình duyệt (2 cửa sổ)**

Dùng memory `reference-tokosi-view-pages-without-login.md` (harness express + JWT tổng hợp + router thật) để mở `/vt-positions/` ở hai tab; sửa một dòng ở tab A; xác nhận tab B: ô đổi nháy trong ≤ ~1 giây, header/độ rộng/lọc/tìm/trang/vị trí cuộn không đổi, hộp chi tiết đang mở ở B không đóng và hiện dải. Dùng `read_network_requests` xác nhận kết nối `/events` ở trạng thái mở và `read_console_messages` không lỗi. Kiểm tra cả chế độ Sáng/Tối và màn hình hẹp (nháy ô, dải cảnh báo).

- [ ] **Step 3: Đồng bộ tài liệu (theo skill `update-file`, `.agents/skills/update-file/SKILL.md`)**

- `server/README.md`: thêm dòng bảng API `GET /api/stock-positions/events?branch=` (SSE, quyền `stockLocationsV2.view`, sự kiện `positions-changed`), nêu cầu nối Postgres NOTIFY khi `BACKGROUND_JOBS=worker`.
- `README.md`: thêm `stockPositionsEvents.js` vào cây thư mục `server/stockPositions/`, ghi mục "cập nhật gần nhất".
- `CURRENT.md`: ghi trạng thái (chưa deploy; không có migration mới) và việc kiểm thử còn lại.
- `docs/02-srs/SRS_Dashboard_GoogleSheets.md`: thêm yêu cầu "Bảng VT cập nhật thời gian thực".
- Cập nhật ngày ở cuối các tài liệu trên thành 2026-10-30.
- Không có migration nên `server/db/SCHEMA.md` không đổi.

- [ ] **Step 4: Đồ thị mã nguồn + memory**

Run: `cd "D:/Web TKS Dashboard" && graphify update .`
Cập nhật `project-tokosi-vt-positions.md`: thêm đoạn "Thời gian thực (2026-10-30)": hook phát sau COMMIT trong `withTransaction`/`lockBranch`, bus `dashboardRollupEvents` (cầu worker→web), route SSE, client đối chiếu tbody theo `data-id` + `signatures` WeakMap, dải cảnh báo hộp chi tiết; chưa deploy.

- [ ] **Step 5: Commit**

```bash
cd "D:/Web TKS Dashboard" && git add README.md server/README.md CURRENT.md docs graphify-out
git commit -m "docs(vt-positions): dong bo tai lieu va do thi cho cap nhat thoi gian thuc

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage:** hook sau COMMIT mọi đường ghi (Task 1; pick dùng chung `lockBranch`); route SSE + header/heartbeat/quyền/cơ sở (Task 2); tải nền không loading, gộp 300 ms, `requestVersion` (Task 3-4); đối chiếu theo `data-id`, nháy ô, `prefers-reduced-motion`, giữ filter/cột/trang/cuộn, số đếm tại chỗ (Task 3); hộp chi tiết giữ nguyên + dải + Xem bản mới (Task 4); mất kết nối: tự nối lại, tải bù khi nối lại/focus, fallback 60 giây (Task 4); kiểm thử + tài liệu (Task 5). Cầu worker→web (phát hiện khi lập kế hoạch) được phủ bằng cách dùng chung `dashboardRollupEvents`.
- **Placeholder scan:** không có TBD; hai chú thích có điều kiện (Task 1 Step 1 lấy ví dụ ghi lỗi từ test hiện có; Task 3 Step 8 sửa test cũ nếu giả định dựng lại tbody) nêu rõ cách xử lý.
- **Type consistency:** `CHANGED`/`events`/`announceChanged` (Task 1) khớp Task 2; `LIVE.{debounceMs,fallbackMs,flashMs}` (Task 3) khớp Task 4 và test (`TKSVtPositions.live`); `refreshInBackground`, `render({background})`, `syncOpenDetail`, `feed`, `detail.fresh` nhất quán; id HTML `vtDetailStale`, `vtDetailStaleText`, `vtDetailStaleReload` khớp test.
- **Rủi ro đã biết:** (1) `renderDetailStats` đọc `form.elements.notes` nên cập nhật số phái sinh dùng chữ đang gõ, đúng ý; (2) tải nền chạy ngang một lần lưu của chính người dùng có thể trả bản cũ trong chốc lát, tự lành vì lần lưu cũng phát tín hiệu và gây tải lại; (3) job chạy ở worker cần `BACKGROUND_JOBS=worker` kèm `listenToPostgres` ở web (đã có trong `index.js`).
