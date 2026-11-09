# Ổn định web production và chuyển Render Singapore — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hết nghẽn pool DB trên web production bằng cách bỏ deploy thừa, sửa ba nguồn tải (Kiểm kê, bot nghỉ phép, request dồn), rồi chuyển web sang Render Singapore sau tên miền riêng.

**Architecture:** Sửa nhỏ, độc lập trong `server/` (mỗi task code là 1 nhánh + 1 PR vào `main`), thêm hai file mới (`lib/inflightLimit.js`, `redirect.js`) và một script đo (`scripts/renderPerfReport.js`). Phần hạ tầng (Render, tên miền, webhook) là các task vận hành có lệnh và tiêu chí kiểm tra cụ thể.

**Tech Stack:** Node.js 24, Express, CommonJS, `node:test`, PGlite (test DB), jsdom, Render API v1, Supabase Postgres 17.

**Spec:** [docs/superpowers/specs/2026-11-09-web-stability-singapore-design.md](../specs/2026-11-09-web-stability-singapore-design.md)

## Global Constraints

- Không commit/push thẳng lên `main`; mỗi task code: nhánh riêng từ `origin/main` mới nhất → PR. Khi tạo nhánh bằng `git switch -c <ten> origin/main`, chạy ngay `git branch --unset-upstream` để `git push` không trỏ về `main`.
- Web chỉ chạy **1 instance**; ngân sách Supavisor session mode `pool_size` = **15** kết nối cho web + worker + lúc deploy chồng nhau.
- Mọi thao tác trên DB thật trong kế hoạch này là **chỉ đọc**, trừ khi bước ghi rõ khác.
- Thay đổi cấu hình Render, DNS, webhook, Google OAuth là hành động ra bên ngoài: **hỏi người dùng xác nhận ngay trước khi làm**, kể cả khi kế hoạch đã duyệt.
- CommonJS, không thêm thư viện mới; giờ hiển thị theo `Asia/Ho_Chi_Minh`.
- Node v24: chạy test từng file `node --test <file>`; cả bộ `npm test` (trong `server/`).
- Kết thúc mỗi task code: cập nhật `CURRENT.md` (dòng đầu file, có ngày), `server/README.md` nếu thêm file/API, chạy `graphify update .` ở gốc repo, ghi "Cập nhật gần nhất: <ngày>" cuối tài liệu đã sửa.
- Chuỗi hiển thị cho người dùng bằng tiếng Việt có dấu; comment code theo kiểu hiện có (tiếng Việt không dấu).

## File Structure

| File | Trách nhiệm | Task |
|---|---|---|
| `server/scripts/renderPerfReport.js` (mới) | Đọc log Render, tóm tắt `poolWaiting`/RSS theo giờ và `[timing]` theo endpoint | 1 |
| `server/scripts/renderPerfReport.test.js` (mới) | Test hàm tóm tắt thuần | 1 |
| `server/public/stocktake/stocktakeGrid.js` | `trailingThrottle` chờ lượt đang chạy | 3 |
| `server/public/stocktake/stocktake.js` | Tải nền gặp 429 → hẹn lại | 3 (dòng 429 thêm ở Task 5) |
| `server/stocktake/stocktakeGrid.test.js` | Test throttle | 3 |
| `server/telegram/managerLeaveRuntime.js` | `seedBacklog` theo nhịp `backlogIntervalMs` | 4 |
| `server/telegram/managerLeaveStore.js` | `enqueueDelivery` không ghi khi phiên bản không tăng | 4 |
| `server/telegram/managerLeaveRuntime.test.js`, `managerLeaveStore.test.js` | Test | 4 |
| `server/lib/inflightLimit.js` (mới) | Middleware giới hạn GET đang chạy theo người dùng × đường dẫn | 5 |
| `server/lib/inflightLimit.test.js` (mới) | Test middleware | 5 |
| `server/index.js` | Gắn middleware sau `cookieParser()` | 5 |
| `server/redirect.js` (mới) | Server chuyển hướng cho service Oregon | 7 |
| `server/redirect.test.js` (mới) | Test chuyển hướng | 7 |

---

### Task 1: Script đo hiệu năng từ log Render

Dùng ở Task 2 (đo nền), Task 6 (worker), Task 9 và 10 (đo sau chuyển).

**Files:**
- Create: `server/scripts/renderPerfReport.js`
- Test: `server/scripts/renderPerfReport.test.js`

**Interfaces:**
- Produces: `summarizeHourly(entries) → Array<{hour, samples, waitingMax, waitingOver10, rssMaxMb}>`; `summarizeTiming(entries) → Array<{endpoint, count, avgMs, maxMs, over5s}>` (sắp theo tổng thời gian giảm dần); `entries` = `Array<{timestamp: string ISO, message: string}>`. CLI: `node scripts/renderPerfReport.js <serviceId> <soGio>`.

- [ ] **Step 1: Tạo nhánh**

```bash
cd D:/tks_web && git fetch origin && git switch -c chore/render-perf-report origin/main && git branch --unset-upstream
```

- [ ] **Step 2: Viết test thất bại** — `server/scripts/renderPerfReport.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeHourly, summarizeTiming } = require('./renderPerfReport');

test('summarizeHourly: gom theo gio VN, lay poolWaiting lon nhat va RSS lon nhat', () => {
  const rows = summarizeHourly([
    { timestamp: '2026-11-09T02:53:24Z', message: '[Performance] eventLoopP95=21.2ms poolTotal=4 poolIdle=0 poolWaiting=2 cacheHit=0' },
    { timestamp: '2026-11-09T02:54:24Z', message: '[Performance] eventLoopP95=27.3ms poolTotal=4 poolIdle=0 poolWaiting=21 cacheHit=0' },
    { timestamp: '2026-11-09T02:54:24Z', message: '[Memory] rss=590MB heap=296MB external=9MB arrayBuffers=6MB' },
    { timestamp: '2026-11-09T03:01:00Z', message: '[Performance] eventLoopP95=20ms poolTotal=4 poolIdle=4 poolWaiting=0 cacheHit=0' },
    { timestamp: '2026-11-09T03:01:00Z', message: '[timing] GET /api/x total=5ms' }
  ]);
  assert.deepEqual(rows, [
    { hour: '2026-11-09 09', samples: 2, waitingMax: 21, waitingOver10: 1, rssMaxMb: 590 },
    { hour: '2026-11-09 10', samples: 1, waitingMax: 0, waitingOver10: 0, rssMaxMb: 0 }
  ]);
});

test('summarizeTiming: gop so trong duong dan thanh :id, bo query, bo dong trung cua hai logger', () => {
  const rows = summarizeTiming([
    { timestamp: '2026-11-09T02:54:05Z', message: '[timing] GET /api/shipment/pick auth=0.5ms total=19296.7ms' },
    { timestamp: '2026-11-09T02:54:05Z', message: '[timing] GET /api/shipment/pick total=19296.8ms' },
    { timestamp: '2026-11-09T02:55:00Z', message: '[timing] GET /api/stocktake/sessions/4/board total=1000ms' },
    { timestamp: '2026-11-09T02:55:01Z', message: '[timing] GET /api/stocktake/sessions/7/board?x=1 total=3000ms' },
    { timestamp: '2026-11-09T02:55:02Z', message: '[Performance] poolWaiting=3' }
  ]);
  assert.deepEqual(rows, [
    { endpoint: 'GET /api/shipment/pick', count: 1, avgMs: 19297, maxMs: 19297, over5s: 1 },
    { endpoint: 'GET /api/stocktake/sessions/:id/board', count: 2, avgMs: 2000, maxMs: 3000, over5s: 0 }
  ]);
});
```

- [ ] **Step 3: Chạy để thấy fail**

Run (trong `server/`): `node --test scripts/renderPerfReport.test.js`
Expected: FAIL `Cannot find module './renderPerfReport'`.

- [ ] **Step 4: Viết script** — `server/scripts/renderPerfReport.js`

```js
'use strict';
// Doc log Render (web hoac worker) va tom tat: hang cho pool DB + RSS theo gio VN, thoi gian [timing] theo endpoint.
// Dung: node scripts/renderPerfReport.js <serviceId> <soGio>   (can RENDER_API_KEY trong server/.env)
const OWNER_ID = 'tea-d9k155u417fc73duhjgg';
const VN_OFFSET_MS = 7 * 3600 * 1000;

const vnHour = ts => new Date(Date.parse(ts) + VN_OFFSET_MS).toISOString().slice(0, 13).replace('T', ' ');
const numberAfter = (message, name) => {
  const match = new RegExp('(?:^|\\s)' + name + '=([\\d.]+)').exec(message);
  return match ? Number(match[1]) : null;
};
const normalizePath = path => path.replace(/\?.*$/, '').split('/').map(seg => (/\d/.test(seg) ? ':id' : seg)).join('/');

function summarizeHourly(entries) {
  const byHour = new Map();
  const bucket = hour => {
    if (!byHour.has(hour)) byHour.set(hour, { hour, samples: 0, waitingMax: 0, waitingOver10: 0, rssMaxMb: 0 });
    return byHour.get(hour);
  };
  for (const { timestamp, message } of entries) {
    if (message.startsWith('[Performance]')) {
      const waiting = numberAfter(message, 'poolWaiting');
      if (waiting === null) continue;
      const row = bucket(vnHour(timestamp));
      row.samples += 1;
      row.waitingMax = Math.max(row.waitingMax, waiting);
      if (waiting > 10) row.waitingOver10 += 1;
    } else if (message.startsWith('[Memory] rss=')) {
      const match = /rss=(\d+)MB/.exec(message);
      if (match) { const row = bucket(vnHour(timestamp)); row.rssMaxMb = Math.max(row.rssMaxMb, Number(match[1])); }
    }
  }
  return [...byHour.values()].sort((a, b) => a.hour.localeCompare(b.hour));
}

function summarizeTiming(entries) {
  const seen = new Set();
  const byEndpoint = new Map();
  for (const { timestamp, message } of entries) {
    const match = /^\[timing\] (\S+) (\S+)/.exec(message);
    const total = numberAfter(message, 'total');
    if (!match || total === null) continue;
    const endpoint = match[1] + ' ' + normalizePath(match[2]);
    // Mot request co the in 2 dong [timing] (logger route + logger chung) lech nhau 0.1ms.
    const dedupeKey = endpoint + '|' + timestamp.slice(0, 19) + '|' + Math.round(total);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const row = byEndpoint.get(endpoint) || { endpoint, count: 0, sumMs: 0, maxMs: 0, over5s: 0 };
    row.count += 1;
    row.sumMs += total;
    row.maxMs = Math.max(row.maxMs, total);
    if (total > 5000) row.over5s += 1;
    byEndpoint.set(endpoint, row);
  }
  return [...byEndpoint.values()]
    .sort((a, b) => b.sumMs - a.sumMs)
    .map(({ endpoint, count, sumMs, maxMs, over5s }) => ({ endpoint, count, avgMs: Math.round(sumMs / count), maxMs: Math.round(maxMs), over5s }));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchLogs({ apiKey, serviceId, text, hours, maxPages = 40, fetchImpl = fetch }) {
  const entries = [];
  let end = new Date();
  const start = new Date(end.getTime() - hours * 3600 * 1000);
  for (let page = 0; page < maxPages; page += 1) {
    const url = 'https://api.render.com/v1/logs?' + new URLSearchParams({
      ownerId: OWNER_ID, resource: serviceId, startTime: start.toISOString(), endTime: end.toISOString(),
      limit: '100', direction: 'backward', text
    });
    let response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + apiKey, Accept: 'application/json' } });
      if (response.status !== 429) break;
      await sleep(5000); // Render API gioi han toc do: cho roi thu lai
    }
    if (!response.ok) throw new Error('Render API ' + response.status + ': ' + (await response.text()).slice(0, 200));
    const body = await response.json();
    for (const log of body.logs || []) entries.push({ timestamp: log.timestamp, message: log.message });
    if (!body.hasMore) break;
    end = new Date(body.nextEndTime);
    await sleep(400);
  }
  return entries;
}

async function main() {
  require('dotenv').config({ path: require('node:path').join(__dirname, '../.env') });
  const [serviceId, hoursText] = process.argv.slice(2);
  const hours = Number(hoursText);
  if (!/^srv-/.test(serviceId || '') || !(hours > 0)) throw new Error('Dung: node scripts/renderPerfReport.js <srv-...> <soGio>');
  const apiKey = process.env.RENDER_API_KEY;
  if (!apiKey) throw new Error('Thieu RENDER_API_KEY trong server/.env');
  const perf = await fetchLogs({ apiKey, serviceId, hours, text: '[Performance]' });
  const memory = await fetchLogs({ apiKey, serviceId, hours, text: '[Memory] rss=' });
  const timing = await fetchLogs({ apiKey, serviceId, hours, text: '[timing]' });
  console.log('== Hang cho pool DB va RSS theo gio (gio VN)');
  console.table(summarizeHourly([...perf, ...memory]));
  console.log('== [timing] theo endpoint (20 dong ton thoi gian nhat)');
  console.table(summarizeTiming(timing).slice(0, 20));
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });

module.exports = { summarizeHourly, summarizeTiming, fetchLogs };
```

- [ ] **Step 5: Chạy test**

Run: `node --test scripts/renderPerfReport.test.js`
Expected: PASS 2/2.

- [ ] **Step 6: Chạy thật để có số đo nền (chỉ đọc log)**

Run: `node scripts/renderPerfReport.js srv-d9k1ikp42hec739su3j0 24`
Expected: bảng theo giờ có cột `waitingMax`; bảng endpoint có `GET /api/product-report` ở nhóm đầu. Lưu kết quả vào mô tả PR làm số đo nền.

- [ ] **Step 7: Tài liệu + commit + PR**

Thêm vào `server/README.md` (mục script vận hành) một dòng: ``node scripts/renderPerfReport.js <serviceId> <soGio>`` — tóm tắt `poolWaiting`, RSS theo giờ và `[timing]` theo endpoint từ log Render. Thêm dòng đầu `CURRENT.md`. Chạy `graphify update .` ở gốc repo.

```bash
git add server/scripts/renderPerfReport.js server/scripts/renderPerfReport.test.js server/README.md CURRENT.md graphify-out
git commit -m "chore(ops): script tom tat hieu nang tu log Render"
git push -u origin chore/render-perf-report
gh pr create --base main --title "chore(ops): script tom tat hieu nang tu log Render" --body "Script doc log Render, tom tat poolWaiting/RSS theo gio va [timing] theo endpoint. Kem so do nen 24h.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 2: Giai đoạn 0 — Build Filters, health check, dọn biến (vận hành)

**Files:** không sửa repo (chỉ cấu hình Render). Ghi kết quả vào `CURRENT.md` ở PR của task kế tiếp.

**Interfaces:** không.

- [ ] **Step 1: Hỏi người dùng xác nhận** sẽ đổi cấu hình 2 service `tokosi` (srv-d9k1ikp42hec739su3j0) và `tks_web_worker` (srv-dbc0vcrncjis73fv7m4g).

- [ ] **Step 2: Đặt Build Filters (cả 2 service)**

Cách 1 — Dashboard: Service → Settings → Build & Deploy → Build Filters. Included Paths: `server/**`. Ignored Paths: `server/**/*.md`, `server/**/*.test.js`, `server/test/**`.

Cách 2 — API (chạy trong `server/`, đọc key từ `.env`, không in key):

```bash
node -e "
require('dotenv').config();
const body={buildFilter:{paths:['server/**'],ignoredPaths:['server/**/*.md','server/**/*.test.js','server/test/**']}};
(async()=>{for(const id of ['srv-d9k1ikp42hec739su3j0','srv-dbc0vcrncjis73fv7m4g']){
 const r=await fetch('https://api.render.com/v1/services/'+id,{method:'PATCH',headers:{Authorization:'Bearer '+process.env.RENDER_API_KEY,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});
 const j=await r.json();console.log(id,r.status,JSON.stringify(j.buildFilter||j.message))}})()"
```

Expected: mỗi service in `200` và `{"paths":["server/**"],"ignoredPaths":[...]}`.

- [ ] **Step 3: Đặt Health Check Path `/health` cho web `tokosi`**

Dashboard: Settings → Health & Alerts → Health Check Path = `/health`. Kiểm tra trước: `curl -s -o /dev/null -w "%{http_code}\n" https://tokosi.onrender.com/health` → `200`.

- [ ] **Step 4: Xóa biến thừa**

Dashboard → Environment: xóa `DATABASE_URL` trên cả web và worker; xóa `KIOTVIET_SYNC_ENABLED` trên **web** (giữ trên worker). Chọn "Save, rebuild and deploy" **ngoài giờ làm**, hoặc "Save only" để áp ở lần deploy kế tiếp.

- [ ] **Step 5: Kiểm tra số liệu TVPAMS (chỉ đọc)**

```bash
node -e "
require('dotenv').config();const {Client}=require('pg');
(async()=>{const c=new Client({connectionString:process.env.SUPABASE_DB_URL,ssl:{rejectUnauthorized:false}});await c.connect();
await c.query('SET default_transaction_read_only=on');
const r=await c.query(\"SELECT s.branch,s.sale_date::text,s.qty::text FROM daily_product_sales s JOIN products p ON p.branch=s.branch AND p.id=s.product_id WHERE p.code='TVPAMS' AND s.sale_date BETWEEN '2026-10-07' AND '2026-10-10' ORDER BY 1,2\");
console.table(r.rows);await c.end()})()"
```

Expected: không còn dòng `-1950` ngày `2026-10-08`; chỉ còn dòng ngày `2026-10-09`.

- [ ] **Step 6: Kiểm tra Build Filters có tác dụng** — sau commit chỉ sửa tài liệu kế tiếp trên `main`, deploy list (`GET /v1/services/<id>/deploys?limit=3`) không có deploy mới cho commit đó.

---

### Task 3: Kiểm kê — throttle chờ lượt đang chạy

**Files:**
- Modify: `server/public/stocktake/stocktakeGrid.js` (hàm `trailingThrottle`, ~dòng 180–198)
- Modify: `server/public/stocktake/stocktake.js` (`loadBoard`, ~dòng 151–170) và `server/public/stocktake/index.html` (tăng `?v=`)
- Test: `server/stocktake/stocktakeGrid.test.js` (test `trailingThrottle`, ~dòng 306–332)

**Interfaces:**
- Consumes: không.
- Produces: `trailingThrottle(run, gapMs, opts) → { trigger(), cancel() }`; `run` có thể trả Promise; không bao giờ có 2 lượt `run` chồng nhau.

- [ ] **Step 1: Tạo nhánh**

```bash
cd D:/tks_web && git fetch origin && git switch -c fix/stocktake-reload-await origin/main && git branch --unset-upstream
```

- [ ] **Step 2: Sửa test cũ thành async và thêm test mới** — thay toàn bộ test `'trailingThrottle: goi lien tuc chi chay 1 lan moi khoang, co lan cuoi, huy duoc'` trong `server/stocktake/stocktakeGrid.test.js` bằng:

```js
const flush = () => new Promise(resolve => setImmediate(resolve));

function fakeTimers() {
  const clock = { now: 0, pending: null };
  return {
    clock,
    opts: {
      now: () => clock.now,
      setTimer: (fn, wait) => { clock.pending = { fn, at: clock.now + wait }; return clock.pending; },
      clearTimer: () => { clock.pending = null; }
    },
    async advance() { clock.now = clock.pending.at; const { fn } = clock.pending; clock.pending = null; fn(); await flush(); }
  };
}

test('trailingThrottle: goi lien tuc chi chay 1 lan moi khoang, co lan cuoi, huy duoc', async () => {
  const t = fakeTimers();
  let runs = 0;
  const gate = trailingThrottle(() => { runs += 1; }, 3000, t.opts);
  gate.trigger();
  assert.equal(t.clock.pending.at, 400, 'lan dau chi cho ngan');
  gate.trigger();
  gate.trigger();
  await t.advance();
  assert.equal(runs, 1);
  t.clock.now = 1000;
  gate.trigger();
  assert.equal(t.clock.pending.at, 3400, 'chua du 3 giay tu lan chay truoc');
  gate.trigger();
  await t.advance();
  assert.equal(runs, 2);
  gate.trigger();
  gate.cancel();
  assert.equal(t.clock.pending, null);
  assert.equal(runs, 2);
});

test('trailingThrottle: run cham thi khong chong luot, tin hieu luc dang chay -> dung 1 luot sau', async () => {
  const t = fakeTimers();
  let runs = 0;
  let finish = null;
  const gate = trailingThrottle(() => { runs += 1; return new Promise(resolve => { finish = resolve; }); }, 3000, t.opts);
  gate.trigger();
  await t.advance();
  assert.equal(runs, 1);
  t.clock.now = 20000; // luot dau keo dai 20 giay
  gate.trigger();
  gate.trigger();
  assert.equal(t.clock.pending, null, 'dang chay thi khong hen luot moi');
  finish();
  await flush();
  assert.equal(t.clock.pending.at, 20400, 'xong luot cham -> hen ngay (da qua 3 giay)');
  await t.advance();
  assert.equal(runs, 2, 'chi 1 luot bu cho nhieu tin hieu');
  finish();
  await flush();
  assert.equal(t.clock.pending, null, 'khong co tin hieu moi thi dung');
});

test('trailingThrottle: huy luc dang chay thi khong chay luot bu', async () => {
  const t = fakeTimers();
  let runs = 0;
  let finish = null;
  const gate = trailingThrottle(() => { runs += 1; return new Promise(resolve => { finish = resolve; }); }, 3000, t.opts);
  gate.trigger();
  await t.advance();
  gate.trigger();
  gate.cancel();
  finish();
  await flush();
  assert.equal(t.clock.pending, null);
  assert.equal(runs, 1);
});
```

- [ ] **Step 3: Chạy để thấy fail**

Run (trong `server/`): `node --test stocktake/stocktakeGrid.test.js`
Expected: test `run cham thi khong chong luot` FAIL ở `'dang chay thi khong hen luot moi'` (throttle cũ hẹn luôn lượt mới).

- [ ] **Step 4: Sửa `trailingThrottle`** — thay hàm trong `server/public/stocktake/stocktakeGrid.js`:

```js
  // Goi run nhieu nhat 1 lan moi gapMs, co lan cuoi de khong bo sot; goi lien tuc chi ton 1 lan chay.
  // run tra Promise (tai bang): cho luot dang chay xong moi hen luot sau, khong de cac luot cham chong len nhau.
  function trailingThrottle(run, gapMs, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, minDelayMs = 400 } = {}) {
    let last = -Infinity;
    let timer = null;
    let running = false;
    let again = false;
    function schedule() {
      timer = setTimer(fire, Math.max(minDelayMs, gapMs - (now() - last)));
    }
    async function fire() {
      timer = null;
      running = true;
      last = now();
      try { await run(); } catch (error) { /* run tu bao loi tren trang */ }
      running = false;
      if (again) { again = false; schedule(); }
    }
    return {
      trigger() {
        if (running) { again = true; return; }
        if (timer !== null) return;
        schedule();
      },
      cancel() {
        if (timer !== null) clearTimer(timer);
        timer = null;
        again = false;
      }
    };
  }
```

- [ ] **Step 5: Chạy test**

Run: `node --test stocktake/stocktakeGrid.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 6: `loadBoard` trả Promise cho throttle và lặng lẽ hẹn lại khi 429** — trong `server/public/stocktake/stocktake.js`, ngay sau dòng `if (version !== state.loadVersion) return;` (sau `await request(API + '/sessions/' + sessionId + '/board')`) thêm:

```js
      // May chu dang ban (gioi han request dang chay): tai nen thi hen lai 1 luot, khong hien loi.
      if (response.status === 429 && background && live.reload) { live.reload.trigger(); return; }
```

Kiểm tra `startLive` vẫn truyền hàm trả Promise: `Grid.trailingThrottle(() => loadBoard({ background: true }), RELOAD_GAP_MS)` (giữ nguyên — `loadBoard` là `async`). Trong `server/public/stocktake/index.html` tăng `stocktakeGrid.js?v=` và `stocktake.js?v=` lên `20261110-1`.

- [ ] **Step 7: Chạy các test Kiểm kê liên quan**

Run: `node --test stocktake/stocktakeGrid.test.js stocktake/stocktakeInteractions.test.js stocktake/stocktakeRoutes.test.js stocktake/stocktakeService.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 8: Tài liệu + commit + PR**

Dòng đầu `CURRENT.md`: Kiểm kê tải lại nền không còn chồng lượt; tải nền gặp 429 tự hẹn lại. Chạy `graphify update .`.

```bash
git add server/public/stocktake/stocktakeGrid.js server/public/stocktake/stocktake.js server/public/stocktake/index.html server/stocktake/stocktakeGrid.test.js CURRENT.md graphify-out
git commit -m "fix(stocktake): tai lai bang nen cho luot truoc xong, khong chong luot"
git push -u origin fix/stocktake-reload-await
gh pr create --base main --title "fix(stocktake): tai lai bang nen khong chong luot" --body "trailingThrottle cho luot dang chay xong; nhieu tin hieu luc dang tai -> dung 1 luot bu. Nguyen nhan nghen 07/11 (1.115 luot board/15 phut).

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 4: Bot duyệt nghỉ phép — bỏ ghi lặp mỗi 5 giây

**Files:**
- Modify: `server/telegram/managerLeaveRuntime.js` (tham số `createManagerLeaveRuntime`, `drainDeliveries`)
- Modify: `server/telegram/managerLeaveStore.js:201-207` (`enqueueDelivery`)
- Test: `server/telegram/managerLeaveRuntime.test.js`, `server/telegram/managerLeaveStore.test.js`

**Interfaces:**
- Produces: `createManagerLeaveRuntime({ ..., backlogIntervalMs = 10 * 60 * 1000 })`; `store.enqueueDelivery(...)` trả `null` khi phiên bản không tăng (nơi gọi không dùng giá trị trả về).

- [ ] **Step 1: Tạo nhánh**

```bash
cd D:/tks_web && git fetch origin && git switch -c fix/leave-bot-backlog-churn origin/main && git branch --unset-upstream
```

- [ ] **Step 2: Viết test thất bại cho runtime** — thêm vào cuối `server/telegram/managerLeaveRuntime.test.js`:

```js
test('seedBacklog chi chay lai sau backlogIntervalMs, khong chay moi nhip 5 giay', async () => {
  let clock = 0, reads = 0;
  const store = { activate: async () => new Date(0), claimUpdates: async () => [], requeueStaleCards: async () => {}, claimEvents: async () => [], claimDeliveries: async () => [], enqueueDelivery: async () => {} };
  const runtime = createManagerLeaveRuntime({ store, telegram: { call: async () => ({}) }, loadManagers: async () => [],
    leaveRepo: { getLeaveRequests: async () => { reads += 1; return []; } }, now: () => clock, logger: { error() {} } });
  await runtime.drain();
  assert.equal(reads, 2, 'lan dau doc 2 trang thai (Chua duyet, Vi pham)');
  await runtime.drain();
  clock = 10 * 60 * 1000 - 1;
  await runtime.drain();
  assert.equal(reads, 2, 'chua toi 10 phut thi khong quet lai');
  clock = 10 * 60 * 1000;
  await runtime.drain();
  assert.equal(reads, 4);
});
```

Trong test có sẵn `'managers are not loaded on idle ticks and are cached for the TTL when work exists'`, thêm `backlogIntervalMs: 0,` vào object truyền cho `createManagerLeaveRuntime` (test đó kiểm cache quản lý, cần quét mỗi lượt như cũ).

- [ ] **Step 3: Viết test thất bại cho store** — thêm vào cuối `server/telegram/managerLeaveStore.test.js`:

```js
test('enqueueDelivery cung hoac thap phien ban thi khong ghi lai dong', async () => {
  const { db, store } = await fixture();
  try {
    const xmin = async () => (await db.query('SELECT xmin::text AS x, desired_version::text AS v FROM hr_leave_manager_messages')).rows[0];
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '1' });
    const before = await xmin();
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '1' });
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '0' });
    assert.deepEqual(await xmin(), before, 'khong co phien ban dong moi');
    await store.enqueueDelivery({ requestId: 'NP-TEST', userId: USER, chatId: CHAT, version: '2' });
    const after = await xmin();
    assert.notEqual(after.x, before.x);
    assert.equal(after.v, '2');
  } finally { await db.close(); }
});
```

- [ ] **Step 4: Chạy để thấy fail**

Run (trong `server/`): `node --test telegram/managerLeaveRuntime.test.js telegram/managerLeaveStore.test.js`
Expected: 2 test mới FAIL (`reads` = 4 thay vì 2; `xmin` đổi).

- [ ] **Step 5: Sửa runtime** — trong `server/telegram/managerLeaveRuntime.js`:

Thêm tham số vào danh sách của `createManagerLeaveRuntime` (dòng `managersTtlMs = 5 * 60 * 1000, now = Date.now`):

```js
  managersTtlMs = 5 * 60 * 1000, now = Date.now,
  // Don moi da di qua hang su kien (claimEvents); quet lai don cho chi de bu quan ly moi gan Telegram.
  backlogIntervalMs = 10 * 60 * 1000
```

Ngay trên `async function drainDeliveries()` thêm `let backlogAt = -Infinity;` và trong thân hàm thay `await seedBacklog(lazyManagers);` bằng:

```js
if(now()-backlogAt>=backlogIntervalMs){await seedBacklog(lazyManagers);backlogAt=now();}
```

- [ ] **Step 6: Sửa store** — thay câu lệnh trong `enqueueDelivery` (`server/telegram/managerLeaveStore.js`):

```js
  async function enqueueDelivery({ requestId, userId, chatId, version }) {
    // Chi ghi khi phien ban tang: bot goi lai moi luot quet, ghi de vo dieu kien tung tao ~2 dong chet/giay.
    const { rows } = await pool.query(`INSERT INTO hr_leave_manager_messages
      (request_id, user_id, telegram_chat_id, desired_version) VALUES ($1, $2::uuid, $3, $4::bigint)
      ON CONFLICT (request_id, user_id, telegram_chat_id) DO UPDATE
        SET desired_version = EXCLUDED.desired_version, updated_at = now()
        WHERE hr_leave_manager_messages.desired_version < EXCLUDED.desired_version
      RETURNING *`, [requestId, userId, String(chatId), String(version)]);
    return normalizeRow(rows[0]);
  }
```

- [ ] **Step 7: Chạy toàn bộ test Telegram + HR nghỉ phép**

Run: `node --test telegram/*.test.js hr/hrLeave*.test.js`
Expected: PASS toàn bộ (gồm `'delivery retries, blocked chats, version refresh and ownership survive duplicate enqueue'`). Nếu một test cũ khác gọi `drain()` nhiều lần và trông vào việc `seedBacklog` chạy mỗi lượt, thêm `backlogIntervalMs: 0` vào runtime của test đó (giữ nguyên ý định test), ghi lý do trong commit.

- [ ] **Step 8: Tài liệu + commit + PR**

Dòng đầu `CURRENT.md`: bot nghỉ phép quét hàng chờ 10 phút/lần; `enqueueDelivery` chỉ ghi khi phiên bản tăng (trước: ~2,3 lần ghi/giây). Chạy `graphify update .`.

```bash
git add server/telegram/managerLeaveRuntime.js server/telegram/managerLeaveStore.js server/telegram/managerLeaveRuntime.test.js server/telegram/managerLeaveStore.test.js CURRENT.md graphify-out
git commit -m "fix(telegram): bot nghi phep khong ghi lai hang cho moi 5 giay"
git push -u origin fix/leave-bot-backlog-churn
gh pr create --base main --title "fix(telegram): bot nghi phep khong ghi lai hang cho moi 5 giay" --body "seedBacklog 10 phut/lan; enqueueDelivery chi UPDATE khi desired_version tang. Do that 09/11: ~2,3 lan ghi/giay tren pool 4 ket noi cua web du 0 tin cho gui.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 9: Sau deploy, đo lại (chỉ đọc)** — hai ảnh chụp `pg_stat_user_tables` cách nhau 10 phút:

```sql
SELECT n_tup_ins + n_tup_upd AS writes FROM pg_stat_user_tables WHERE relname = 'hr_leave_manager_messages';
```

Expected: chênh lệch < 20 trong 10 phút khi không có đơn mới (trước sửa ~1.400).

---

### Task 5: Giới hạn request GET đang chạy theo người dùng

**Files:**
- Create: `server/lib/inflightLimit.js`
- Test: `server/lib/inflightLimit.test.js`
- Modify: `server/index.js` (sau dòng `app.use(cookieParser());`)

**Interfaces:**
- Consumes: `verifyToken(token)` từ `server/auth/authService.js`; cookie `tks_auth`.
- Produces: `createInflightLimit({ prefixes, max = 4, holdAfterCloseMs = 120000, identify = identifyRequest, logger = console }) → express middleware` (bỏ qua đường dẫn kết thúc bằng `/events` — kết nối SSE mở suốt phiên); `identifyRequest(req) → 'u:<id>' | 'ip:<ip>'`; `routeKey(path) → string`; `DEFAULT_PREFIXES`.

- [ ] **Step 1: Tạo nhánh**

```bash
cd D:/tks_web && git fetch origin && git switch -c feat/inflight-limit origin/main && git branch --unset-upstream
```

- [ ] **Step 2: Viết test thất bại** — `server/lib/inflightLimit.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createInflightLimit, routeKey } = require('./inflightLimit');

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

async function startApp(t, options) {
  const gates = [];
  const app = express();
  app.use(createInflightLimit({ identify: req => 'u:' + (req.headers['x-user'] || 'a'), logger: { warn() {} }, ...options }));
  const slow = async (req, res) => { const gate = deferred(); gates.push(gate); await gate.promise; res.json({ ok: true }); };
  app.get('/api/product-report', slow);
  app.get('/api/product-report/containers/meta', slow);
  app.get('/api/stocktake/sessions/:id/board', slow);
  app.post('/api/product-report', slow);
  app.get('/api/other', slow);
  app.get('/api/stocktake/sessions/:id/events', slow);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = (path, { user = 'a', method = 'GET', signal } = {}) => fetch(base + path, { method, headers: { 'x-user': user }, signal });
  const waitGates = async n => { while (gates.length < n) await new Promise(r => setTimeout(r, 5)); };
  const openAll = () => { for (const gate of gates.splice(0)) gate.resolve(); };
  return { call, waitGates, openAll, gates };
}

test('routeKey gop doan co so thanh :id', () => {
  assert.equal(routeKey('/api/stocktake/sessions/4/board'), '/api/stocktake/sessions/:id/board');
  assert.equal(routeKey('/api/shipment/lifecycle/DH022541/override'), '/api/shipment/lifecycle/:id/override');
});

test('request GET thu 5 cung nguoi cung duong dan bi 429, nguoi khac / duong dan khac / POST khong bi', async t => {
  const app = await startApp(t, { max: 4 });
  const first = [1, 2, 3, 4].map(() => app.call('/api/product-report'));
  await app.waitGates(4);
  const blocked = await app.call('/api/product-report');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '2');
  assert.equal((await blocked.json()).code, 'TOO_MANY_INFLIGHT');
  const others = [app.call('/api/product-report', { user: 'b' }), app.call('/api/product-report/containers/meta'),
    app.call('/api/product-report', { method: 'POST' }), app.call('/api/other')];
  await app.waitGates(8);
  app.openAll();
  for (const res of await Promise.all([...first, ...others])) assert.equal(res.status, 200);
  const again = app.call('/api/product-report');
  await app.waitGates(1);
  app.openAll();
  assert.equal((await again).status, 200, 'xong thi tra suat');
});

test('SSE /events khong bi tinh: mo nhieu tab cung dot van duoc', async t => {
  const app = await startApp(t, { max: 1 });
  const streams = [1, 2, 3].map(() => app.call('/api/stocktake/sessions/4/events'));
  await app.waitGates(3);
  app.openAll();
  for (const res of await Promise.all(streams)) assert.equal(res.status, 200);
});

test('client huy giua chung thi van giu suat toi khi handler xong', async t => {
  const app = await startApp(t, { max: 1 });
  const controller = new AbortController();
  const aborted = app.call('/api/stocktake/sessions/4/board', { signal: controller.signal }).catch(error => error);
  await app.waitGates(1);
  controller.abort();
  await aborted;
  await new Promise(r => setTimeout(r, 30));
  assert.equal((await app.call('/api/stocktake/sessions/9/board')).status, 429, 'handler cu chua xong');
  app.openAll();
  await new Promise(r => setTimeout(r, 30));
  const next = app.call('/api/stocktake/sessions/9/board');
  await app.waitGates(1);
  app.openAll();
  assert.equal((await next).status, 200);
});

test('handler khong bao gio xong sau khi client huy: tra suat sau holdAfterCloseMs', async t => {
  const app = await startApp(t, { max: 1, holdAfterCloseMs: 50 });
  const controller = new AbortController();
  const aborted = app.call('/api/product-report', { signal: controller.signal }).catch(error => error);
  await app.waitGates(1);
  controller.abort();
  await aborted;
  await new Promise(r => setTimeout(r, 120));
  const next = app.call('/api/product-report');
  await app.waitGates(2);
  app.openAll();
  assert.equal((await next).status, 200);
});
```

- [ ] **Step 3: Chạy để thấy fail**

Run (trong `server/`): `node --test lib/inflightLimit.test.js`
Expected: FAIL `Cannot find module './inflightLimit'`.

- [ ] **Step 4: Viết middleware** — `server/lib/inflightLimit.js`

```js
'use strict';
// Gioi han so request GET DANG CHAY cung luc cua 1 nguoi dung tren 1 duong dan API nang.
// Bam lam moi lien tuc / mo nhieu tab khong the xep hang chuc truy van vao pool DB 4 ket noi.
// Bo dem trong bo nho tien trinh: web chi chay 1 instance (xem README).
// Tra suat khi handler goi res.end (xu ly xong that); client huy giua chung thi van giu suat
// toi khi handler xong, toi da holdAfterCloseMs, vi truy van DB van dang chay.
const { verifyToken } = require('../auth/authService');

const DEFAULT_PREFIXES = ['/api/product-report', '/api/stocktake/sessions/', '/api/shipment/lifecycle', '/api/shipment/pick'];

const routeKey = path => path.split('/').map(seg => (/\d/.test(seg) ? ':id' : seg)).join('/');

function identifyRequest(req) {
  const token = req.cookies && req.cookies.tks_auth;
  if (token) {
    try { return 'u:' + verifyToken(token).id; } catch (error) { /* token hong: tinh theo IP */ }
  }
  return 'ip:' + req.ip;
}

function createInflightLimit({ prefixes = DEFAULT_PREFIXES, max = 4, holdAfterCloseMs = 120000, identify = identifyRequest, logger = console } = {}) {
  const counts = new Map();
  const release = key => {
    const left = (counts.get(key) || 1) - 1;
    if (left > 0) counts.set(key, left); else counts.delete(key);
  };
  return function inflightLimit(req, res, next) {
    // SSE (/events) mo suot phien xem trang: khong tinh, neu khong tab thu 5 cung dot bi chan.
    if (req.method !== 'GET' || req.path.endsWith('/events') || !prefixes.some(prefix => req.path.startsWith(prefix))) return next();
    const key = identify(req) + ' ' + routeKey(req.path);
    const current = counts.get(key) || 0;
    if (current >= max) {
      logger.warn('[inflightLimit] 429 ' + key);
      res.set('Retry-After', '2');
      return res.status(429).json({ code: 'TOO_MANY_INFLIGHT', error: 'Đang xử lý yêu cầu trước, vui lòng chờ.' });
    }
    counts.set(key, current + 1);
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      release(key);
    };
    const end = res.end;
    res.end = function patchedEnd(...args) { finish(); return end.apply(this, args); };
    res.once('close', () => {
      if (done) return;
      timer = setTimeout(finish, holdAfterCloseMs);
      if (timer.unref) timer.unref();
    });
    return next();
  };
}

module.exports = { createInflightLimit, identifyRequest, routeKey, DEFAULT_PREFIXES };
```

- [ ] **Step 5: Chạy test**

Run: `node --test lib/inflightLimit.test.js`
Expected: PASS 5/5.

- [ ] **Step 6: Gắn vào app** — trong `server/index.js`, ngay sau dòng `app.use(cookieParser());` thêm:

```js
// Gioi han GET dang chay cung luc / nguoi dung / duong dan API nang (xem lib/inflightLimit.js).
app.use(require('./lib/inflightLimit').createInflightLimit());
```

- [ ] **Step 7: Chạy test liên quan**

Run: `node --test lib/inflightLimit.test.js stocktake/stocktakeRoutes.test.js "test/frontend/**/*.test.js"`
Sau đó cả bộ: `npm test`
Expected: PASS; không có test nào nhận 429 ngoài ý muốn.

- [ ] **Step 8: Tài liệu + commit + PR**

`server/README.md`: mục middleware thêm `lib/inflightLimit.js` — GET tới `/api/product-report*`, `/api/stocktake/sessions/*`, `/api/shipment/lifecycle*`, `/api/shipment/pick*` tối đa 4 request đang chạy / người dùng / đường dẫn; vượt → 429 `TOO_MANY_INFLIGHT`. `README.md`: thêm file vào cây thư mục. Dòng đầu `CURRENT.md`. Chạy `graphify update .`.

```bash
git add server/lib/inflightLimit.js server/lib/inflightLimit.test.js server/index.js server/README.md README.md CURRENT.md graphify-out
git commit -m "feat(server): gioi han GET dang chay theo nguoi dung tren API nang"
git push -u origin feat/inflight-limit
gh pr create --base main --title "feat(server): gioi han GET dang chay theo nguoi dung tren API nang" --body "Toi da 4 GET dang chay / nguoi dung / duong dan (Bao cao hang hoa, Kiem ke, Vong doi, Nhat hang). Giu suat toi khi handler xong ke ca khi client huy. 429 TOO_MANY_INFLIGHT.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

- [ ] **Step 9: Theo dõi tuần đầu sau deploy** — đếm log `[inflightLimit] 429` mỗi ngày (Render Dashboard → Logs, tìm `inflightLimit`). Nếu một người dùng bình thường bị chặn khi chỉ mở trang (không bấm dồn) → tăng `max` lên 6 trong `index.js` và ghi lý do.

---

### Task 6: Worker — tìm nguồn RAM ban đêm và quyết định nâng gói (vận hành)

**Files:** không sửa repo trừ khi Step 3 chỉ ra job cụ thể (khi đó lập task sửa riêng, có test).

**Interfaces:** dùng `server/scripts/renderPerfReport.js` (Task 1).

- [ ] **Step 1: Đo 3 đêm** (sau khi Task 1 đã merge)

Run (trong `server/`): `node scripts/renderPerfReport.js srv-dbc0vcrncjis73fv7m4g 72`
Ghi lại `rssMaxMb` theo giờ. Số đo 08–09/11: RSS tăng từ ~210 MB lúc 23:50 lên 439 MB lúc 23:59 VN và giữ ~380–440 MB tới sáng.

- [ ] **Step 2: Đối chiếu log quanh 23:50–00:10 VN** — Render Dashboard → `tks_web_worker` → Logs, khung 23:50–00:10. Liệt kê các dòng job chạy ngay trước mỗi bước nhảy `[Memory] rss=`. Ứng viên đã thấy: `product_on_hands_snapshot: doi soat toan bo danh sach` (23:58), `[inventoryValueSnapshot]` (23:59), `[SheetSnapshots]` (23:59).

- [ ] **Step 3: Quyết định**
  - Nếu một job cụ thể đẩy heap > 150 MB: lập task sửa riêng (đọc/ghi theo lô), theo mẫu TDD của các task trên.
  - Nếu không xác định được, hoặc sau sửa đỉnh RSS vẫn > 400 MB: **hỏi người dùng** rồi nâng worker lên Standard (1 lõi / 2 GB, $25/tháng) và đổi start command thành `node --max-old-space-size=1200 worker.js`.

- [ ] **Step 4: Ghi kết quả** vào `CURRENT.md` và memory `background-worker-rollout`.

---

### Task 7: `redirect.js` cho service Oregon

**Files:**
- Create: `server/redirect.js`
- Test: `server/redirect.test.js`

**Interfaces:**
- Produces: `createRedirectServer({ target }) → http.Server`; khi chạy trực tiếp đọc `REDIRECT_TO`, `PORT`.

- [ ] **Step 1: Tạo nhánh**

```bash
cd D:/tks_web && git fetch origin && git switch -c feat/oregon-redirect origin/main && git branch --unset-upstream
```

- [ ] **Step 2: Viết test thất bại** — `server/redirect.test.js`

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRedirectServer } = require('./redirect');

test('GET/HEAD -> 302, phuong thuc khac -> 307, giu duong dan + query; /health tra 200', async t => {
  const server = createRedirectServer({ target: 'https://app.example.com/' });
  await new Promise(resolve => server.listen(0, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;

  let res = await fetch(base + '/stocktake/?dot=4', { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://app.example.com/stocktake/?dot=4');
  assert.equal(res.headers.get('cache-control'), 'no-store');

  res = await fetch(base + '/', { method: 'HEAD', redirect: 'manual' });
  assert.equal(res.status, 302);

  res = await fetch(base + '/api/kiotviet/webhook/abc', { method: 'POST', body: '{}', redirect: 'manual' });
  assert.equal(res.status, 307);
  assert.equal(res.headers.get('location'), 'https://app.example.com/api/kiotviet/webhook/abc');

  res = await fetch(base + '/health');
  assert.equal(res.status, 200);
});

test('REDIRECT_TO phai la https://ten-mien, khong co duong dan', () => {
  assert.throws(() => createRedirectServer({ target: '' }), /REDIRECT_TO/);
  assert.throws(() => createRedirectServer({ target: 'http://app.example.com' }), /REDIRECT_TO/);
  assert.throws(() => createRedirectServer({ target: 'https://app.example.com/x' }), /REDIRECT_TO/);
});
```

- [ ] **Step 3: Chạy để thấy fail**

Run (trong `server/`): `node --test redirect.test.js`
Expected: FAIL `Cannot find module './redirect'`.

- [ ] **Step 4: Viết server** — `server/redirect.js`

```js
'use strict';
// Service Oregon sau khi chuyen web sang Singapore: KHONG ket noi DB, chi chuyen moi request sang ten mien moi.
// 302/307 (tam thoi) thay vi 301/308: trinh duyet khong nho vinh vien, quay lui ve Oregon khong bi ket.
// Start command tren Render: node redirect.js ; bien moi truong: REDIRECT_TO=https://app.<ten-mien>.com
const http = require('node:http');

function createRedirectServer({ target }) {
  const base = String(target || '').replace(/\/+$/, '');
  if (!/^https:\/\/[^/?#]+$/.test(base)) throw new Error('REDIRECT_TO phai co dang https://ten-mien (khong co duong dan).');
  return http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }
    const status = req.method === 'GET' || req.method === 'HEAD' ? 302 : 307;
    res.writeHead(status, { Location: base + (req.url || '/'), 'Cache-Control': 'no-store' });
    res.end();
  });
}

if (require.main === module) {
  const server = createRedirectServer({ target: process.env.REDIRECT_TO });
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log('[redirect] Chuyen huong sang ' + process.env.REDIRECT_TO + ' tren port ' + port));
}

module.exports = { createRedirectServer };
```

- [ ] **Step 5: Chạy test**

Run: `node --test redirect.test.js`
Expected: PASS 2/2.

- [ ] **Step 6: Tài liệu + commit + PR**

`README.md` cây thư mục + `server/README.md`: `redirect.js` — chỉ dùng cho service Oregon sau khi chuyển vùng (Start Command `node redirect.js`, biến `REDIRECT_TO`). Dòng đầu `CURRENT.md`. Chạy `graphify update .`.

```bash
git add server/redirect.js server/redirect.test.js README.md server/README.md CURRENT.md graphify-out
git commit -m "feat(ops): server chuyen huong cho service Oregon"
git push -u origin feat/oregon-redirect
gh pr create --base main --title "feat(ops): server chuyen huong cho service Oregon" --body "Dung khi cat chuyen web sang Singapore: Oregon chay node redirect.js, khong ket noi DB. 302 cho GET/HEAD, 307 cho phuong thuc khac, /health 200.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

---

### Task 8: Chuẩn bị service Singapore và tên miền (vận hành, trong giờ)

Điều kiện bắt đầu: Task 3, 4, 5, 7 đã merge và deploy; số đo Task 1 sau 3 ngày làm việc đã ghi lại.

**Files:** không sửa repo.

- [ ] **Step 1: Người dùng mua tên miền `.com`** và chọn subdomain (mặc định `app`). Ghi lại `<TEN_MIEN>` = `app.<ten>.com`.

- [ ] **Step 2: Kiểm tra webhook KiotViet hiện có (chỉ đọc)** — trong `server/`: `node scripts/kiot-webhook-probe.js list`. Ghi lại id, Type, Url của từng webhook (script che secret). Nếu danh sách rỗng ở cả hai cơ sở thì Task 9 Step 5 phần KiotViet bỏ qua.

- [ ] **Step 3: Tạo service `tokosi-sg` (hỏi người dùng xác nhận)** — Dashboard → New → Web Service, repo `tks0101ai-cmyk/tks_web`, branch `main`, Region **Singapore**, Root Directory `server`, Build `npm install`, Start `npm start`, Instance **Pro** (2 CPU / 4 GB), Health Check Path `/health`, Build Filters như Task 2.

- [ ] **Step 4: Chép biến môi trường từ `tokosi` sang `tokosi-sg`** bằng script tạm (lưu ngoài repo, ví dụ thư mục scratchpad; không in giá trị):

```js
// copy-env.js — chay trong server/: node <duong-dan>/copy-env.js <srv-tokosi-sg>
require('dotenv').config();
const SOURCE = 'srv-d9k1ikp42hec739su3j0';
const target = process.argv[2];
const OVERRIDES = {
  PG_POOL_MAX: '2',
  HR_MANAGER_TELEGRAM_ENABLED: 'false', HR_LEAVE_DB_REALTIME_ENABLED: 'false', SPECIAL_DAYS_NOTIFY_ENABLED: 'false',
  VAT_REQUEST_NOTIFY_ENABLED: 'false', HR_LEAVE_BELL_NOTIFY_ENABLED: 'false', PICK_KIOT_RECONCILE_ENABLED: 'false'
};
const SKIP = new Set(['DATABASE_URL', 'KIOTVIET_SYNC_ENABLED']);
const api = (path, init = {}) => fetch('https://api.render.com/v1' + path, { ...init, headers: { Authorization: 'Bearer ' + process.env.RENDER_API_KEY, Accept: 'application/json', 'Content-Type': 'application/json' } });
(async () => {
  if (!/^srv-/.test(target || '')) throw new Error('Thieu id service dich');
  const rows = await (await api('/services/' + SOURCE + '/env-vars?limit=100')).json();
  const vars = rows.map(r => r.envVar).filter(v => !SKIP.has(v.key)).map(v => ({ key: v.key, value: v.key in OVERRIDES ? OVERRIDES[v.key] : v.value }));
  for (const [key, value] of Object.entries(OVERRIDES)) if (!vars.some(v => v.key === key)) vars.push({ key, value });
  const res = await api('/services/' + target + '/env-vars', { method: 'PUT', body: JSON.stringify(vars) });
  console.log('PUT', res.status, 'so bien', vars.length, 'ghi de', Object.keys(OVERRIDES).join(','));
})().catch(e => { console.error(e.message); process.exitCode = 1; });
```

Expected: `PUT 200`. Sau đó Manual Deploy `tokosi-sg`.

- [ ] **Step 5: Kiểm tra ngân sách kết nối** (chỉ đọc, sau khi `tokosi-sg` chạy):

```sql
SELECT count(*) FROM pg_stat_activity WHERE application_name = 'Supavisor' AND datname = current_database();
```

Expected: ≤ 12 (Oregon 5 + SG 3 + worker 2 + dư). Trong thời gian chạy song song, nhắc nhóm hạn chế merge vào `main` (mỗi merge deploy 2 web).

- [ ] **Step 6: DNS + custom domain** — tại nhà đăng ký: CNAME `app` → `tokosi-sg.onrender.com` (Cloudflare: DNS only). Render → `tokosi-sg` → Settings → Custom Domains → Add `<TEN_MIEN>` → Verify. Expected: trạng thái "Certificate issued"; `curl -s https://<TEN_MIEN>/health` → `ok`/200.

- [ ] **Step 7: Google OAuth** — Google Cloud Console → Credentials → OAuth client đang dùng (`GOOGLE_CLIENT_ID`) → thêm Authorized JavaScript origin `https://<TEN_MIEN>` (giữ `https://tokosi.onrender.com`).

- [ ] **Step 8: Chạy thử chỉ đọc** bằng tài khoản thật trên `https://<TEN_MIEN>`: đăng nhập (mật khẩu + Google), Tổng quan, Báo cáo hàng hóa, Vòng đời, Kiểm kê (chỉ xem). Rồi `node scripts/renderPerfReport.js <srv-tokosi-sg> 2` và so `avgMs` của `GET /api/product-report` với Oregon. Expected: nhanh hơn rõ rệt (mục tiêu < 1 s).

---

### Task 9: Cắt chuyển sang Singapore (vận hành, ngoài giờ, ~30 phút)

**Files:** không sửa repo. Cần: `<TEN_MIEN>`, id `tokosi-sg`, kết quả Task 8 Step 2.

- [ ] **Step 1: Báo nhóm** ngừng merge vào `main` trong 1 giờ; hỏi người dùng xác nhận bắt đầu.

- [ ] **Step 2: Lưu bản sao cấu hình Oregon** (ra file ngoài repo, có giá trị bí mật — không commit, xóa sau 2 tuần):

```bash
node -e "require('dotenv').config();fetch('https://api.render.com/v1/services/srv-d9k1ikp42hec739su3j0/env-vars?limit=100',{headers:{Authorization:'Bearer '+process.env.RENDER_API_KEY}}).then(r=>r.json()).then(j=>require('fs').writeFileSync(process.argv[1],JSON.stringify(j)))" "<scratchpad>/oregon-env-backup.json"
```

- [ ] **Step 3: Oregon sang chế độ chuyển hướng** — Dashboard `tokosi`: Auto-Deploy **Off**; Start Command `node redirect.js`; Environment: xóa `SUPABASE_DB_URL`, thêm `REDIRECT_TO=https://<TEN_MIEN>`; Save + Deploy. Expected: `curl -sI https://tokosi.onrender.com/stocktake/` → `302`, `location: https://<TEN_MIEN>/stocktake/`.

- [ ] **Step 4: Bật job trên `tokosi-sg`** — Environment: với 6 biến `HR_MANAGER_TELEGRAM_ENABLED`, `HR_LEAVE_DB_REALTIME_ENABLED`, `SPECIAL_DAYS_NOTIFY_ENABLED`, `VAT_REQUEST_NOTIFY_ENABLED`, `HR_LEAVE_BELL_NOTIFY_ENABLED`, `PICK_KIOT_RECONCILE_ENABLED`: đặt lại **đúng giá trị trong bản sao Step 2**; biến nào bản sao không có thì xóa (lưu ý: `HR_MANAGER_TELEGRAM_ENABLED` chỉ bật khi đúng chuỗi `true`, năm biến còn lại bật khi khác `false`). Đặt `PG_POOL_MAX=4`, `HR_MANAGER_TELEGRAM_WEB_URL=https://<TEN_MIEN>`; Save + Deploy.

- [ ] **Step 5: Đăng ký lại webhook**
  - Telegram: Render Dashboard → `tokosi-sg` → Shell (đã có sẵn biến môi trường vừa đặt ở Step 4) → `npm run telegram-manager:set-webhook`. Expected: `Đã đăng ký webhook bot quản lý: https://<TEN_MIEN>/api/telegram/manager-leave/webhook`.
  - KiotViet (nếu Task 8 Step 2 có webhook): với mỗi webhook cũ, đăng ký bản mới trỏ `https://<TEN_MIEN>/api/kiotviet/webhook/<secret>` cùng Type, xác nhận nhận được sự kiện, rồi `node scripts/kiot-webhook-probe.js remove <id-cu>`.

- [ ] **Step 6: Kiểm tra sau chuyển**
  - Đăng nhập; chuông thông báo hiện.
  - Kiểm kê: sửa 1 ô ở tab A, tab B tự cập nhật (SSE) — dùng đợt thử hoặc ô ghi chú rồi khôi phục.
  - Telegram: tạo đơn nghỉ phép thử → quản lý nhận thẻ → hủy đơn thử.
  - Log `tokosi-sg` có `[Events] Dang nghe su kien tu worker`; không có `EMAXCONNSESSION`.
  - Sau 15 phút: `node scripts/renderPerfReport.js <srv-tokosi-sg> 1` → `waitingMax` ≤ 10.

- [ ] **Step 7: Hạ Oregon xuống Starter ($7)** — Dashboard `tokosi` → Instance Type → Starter.

- [ ] **Quay lui (chỉ khi Step 6 thất bại)**: `tokosi-sg` đặt lại 6 cờ `=false`; Oregon khôi phục Start Command `npm start` + biến từ bản sao Step 2 (gồm `SUPABASE_DB_URL`), bật Auto-Deploy, Deploy; Telegram: Shell của Oregon (đã khôi phục biến, `HR_MANAGER_TELEGRAM_WEB_URL=https://tokosi.onrender.com`) → `npm run telegram-manager:set-webhook`; webhook KiotViet về URL cũ.

- [ ] **Step 8: Cập nhật tài liệu + memory** — `CURRENT.md`, `README.md` (URL production), memory `tks-web-render-deploy` (service mới, vùng, tên miền). Commit trên nhánh `docs/...` + PR.

---

### Task 10: Đo lại và tối ưu chi phí (1–2 tuần sau Task 9)

- [ ] **Step 1: Đo** — `node scripts/renderPerfReport.js <srv-tokosi-sg> 168`. So với số đo nền Task 1: `waitingMax` theo giờ, `avgMs` của `GET /api/product-report`, `GET /api/shipment/lifecycle`, `GET /api/stocktake/sessions/:id/board`.

- [ ] **Step 2: Hạ gói nếu đạt** — nếu `rssMaxMb` < 1200 suốt 7 ngày và `waitingMax` ≤ 10: hỏi người dùng rồi đổi `tokosi-sg` sang Standard (1 CPU / 2 GB, $25); start script `node --max-old-space-size=1024 index.js` vẫn hợp lệ.

- [ ] **Step 3: Sau 1–2 tháng** — log Oregon không còn dòng request nào trong 14 ngày → hỏi người dùng rồi xóa service `tokosi`; xóa file bản sao biến môi trường.

- [ ] **Step 4: Ghi kết quả** vào `CURRENT.md` và memory `web-db-pool-stalls`.

---

## Thứ tự và phụ thuộc

1 → 2 → (3, 4, 5, 7 song song được, mỗi task 1 PR) → 6 (cần 1) → 8 (cần 3, 4, 5, 7 đã deploy) → 9 → 10.

Cập nhật gần nhất: 09/11/2026.
