# Kiểm kê: tự cuộn khi kéo chọn, màu cột sửa được, nhấn đúp sửa ô — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trang Kiểm kê tự cuộn khi kéo chọn ô tới mép khung, tiêu đề cột sửa được có màu riêng, nhấn đúp ô sửa được thì ra con trỏ để sửa (chữ dài xuống dòng), còn chi tiết sản phẩm chỉ mở bằng nhấn đúp ô Mã hàng hoặc menu chuột phải.

**Architecture:** Mọi thay đổi nằm ở giao diện: `server/public/stocktake/stocktake.js`, `stocktakeGrid.js` (hàm thuần mới `edgeScrollDelta`) và `stocktake.css`. Một bộ cuộn-tự-động dùng chung cho kéo chọn ô và kéo nút điền. Màu tiêu đề điều khiển bằng class `st-th-edit` cộng thuộc tính `data-editable` trên bảng. Test hồi quy chạy trên jsdom bằng fixture bảng thật (mock `fetch`).

**Tech Stack:** Vanilla JS (IIFE, không bundler), CSS thuần, `node:test` + `jsdom`. Thiết kế: [docs/superpowers/specs/2026-11-07-stocktake-grid-interactions-design.md](../specs/2026-11-07-stocktake-grid-interactions-design.md).

## Global Constraints

- Chỉ Vanilla HTML/CSS/JS, CommonJS cho phần Node; không thêm thư viện, không TailwindCSS.
- Không đụng máy chủ, API, migration.
- Giao diện phải đúng ở chế độ Sáng và Tối và ở 375px.
- Cột sửa được lấy từ `Grid.EDIT_COLUMNS` (không viết danh sách thứ hai).
- Giá trị lưu của ô chữ vẫn là một dòng (xuống dòng đổi thành khoảng trắng).
- Không thêm `.skip`/`todo`; hai test lỗi nền đã biết (mục 4.1 `CLAUDE.md`: `hr-leave-deadlines`, `lifecycle-pick-performance`) không điều tra và không tính vào kết quả.
- Lệnh test chạy từ thư mục `server/` (Node v24: truyền đường dẫn file rõ ràng, không truyền thư mục trần).

## Cấu trúc file

| File | Thay đổi |
|---|---|
| `server/public/stocktake/stocktakeGrid.js` | Thêm hàm thuần `edgeScrollDelta` vào API xuất |
| `server/public/stocktake/stocktake.js` | Bộ cuộn-tự-động dùng chung; class `st-th-edit` + `data-editable`; `dblclick` mới; menu chuột phải; `<textarea>` cho cột chữ; xuất thêm `selection` cho test |
| `server/public/stocktake/stocktake.css` | Màu tiêu đề cột sửa được; kiểu menu chuột phải; kiểu `textarea.st-editor` |
| `server/stocktake/stocktakeInteractions.test.js` | **Mới.** Fixture bảng + toàn bộ test hồi quy của kế hoạch này |
| `server/stocktake/stocktakeGrid.test.js` | Sửa fixture hai test cũ có `dblclick` (thêm `data-col="0"`) |
| `CURRENT.md`, `graphify-out/` | Ghi kết quả phiên, cập nhật đồ thị |

---

### Task 1: Hàm thuần `edgeScrollDelta` và fixture test

**Files:**
- Modify: `server/public/stocktake/stocktakeGrid.js` (thêm hàm trước `return {…}` cuối file, thêm vào API xuất)
- Create: `server/stocktake/stocktakeInteractions.test.js`

**Interfaces:**
- Produces: `Grid.edgeScrollDelta(pointer, low, high, { edge = 40, max = 28 } = {}) -> number` (px cần cuộn: âm = lên/trái, dương = xuống/phải, 0 = không cuộn).
- Produces (trong test file): `pageFixture(t, { rowCount = 3, status = 'open', canEdit = true, fetchHandler } = {}) -> Promise<{ w, app, scroller, tbody, headCol(key), cell(row, key), mouse(type, init), sleep(ms), posts }>` — dùng ở Task 2–5. `cell(row, key)` trả `<td>` của dòng chỉ số `row` và cột có `data-field=key`. `posts` là mảng body JSON của mọi lệnh `POST`/`PATCH`.

- [ ] **Step 1: Viết test thất bại cho `edgeScrollDelta` và dựng fixture**

Tạo `server/stocktake/stocktakeInteractions.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { edgeScrollDelta, EDIT_COLUMNS } = require('../public/stocktake/stocktakeGrid');

const root = path.join(__dirname, '../public/stocktake');

// Bang that trong jsdom: mock fetch tra 1 dot + rowCount dong. Moi lenh ghi (POST/PATCH) duoc ghi vao `posts`.
async function pageFixture(t, { rowCount = 3, status = 'open', canEdit = true, fetchHandler } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), {
    url: 'https://tokosi.test/stocktake/', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.matchMedia = () => ({ matches: false });
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.eval(fs.readFileSync(path.join(root, '../shared/table-controls.js'), 'utf8'));
  w.TKSNav = { authGuard: async () => ({}), renderTopSidebar() {} };
  const session = { id: 1, name: 'T11', branch: 'hanoi', status, cancelled: false, source: 'web' };
  const rows = Array.from({ length: rowCount }, (_, i) => ({ code: 'SP' + (i + 1), name: 'Hàng ' + (i + 1), counted: i + 1, stock: i + 1, note: null, lines: [] }));
  const posts = [];
  w.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (method !== 'GET') posts.push(JSON.parse(options.body));
    const custom = fetchHandler && fetchHandler(url, options);
    const body = custom || (/\/board/.test(url) ? { session, rows, totals: { diffValue: 0 }, canEdit, canClose: false }
      : /\/cells/.test(url) ? { applied: [], conflicts: [], skipped: {}, notes: [], tags: [] }
      : /\/sessions(\?|$)/.test(url) ? { sessions: [session], canEdit, canClose: false }
      : { history: [], lines: [] });
    return { ok: true, json: async () => body };
  };
  for (const file of ['stocktakePaste.js', 'stocktakeSearch.js', 'stocktakeGrid.js', 'stocktakeStatus.js', 'stocktake.js']) {
    w.eval(fs.readFileSync(path.join(root, file), 'utf8'));
  }
  await w.TKSStocktake.init();
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  await sleep(20);
  const heads = Array.from(w.document.querySelectorAll('#stTable thead th'));
  const headCol = key => heads.findIndex(th => th.dataset.field === key);
  const tbody = w.document.getElementById('stRows');
  return {
    w, app: w.TKSStocktake, posts, sleep, tbody, heads, headCol,
    scroller: w.document.querySelector('.st-scroll'),
    cell: (row, key) => tbody.rows[row].cells[headCol(key)],
    mouse: (type, init = {}) => new w.MouseEvent(type, Object.assign({ bubbles: true, cancelable: true }, init))
  };
}

test('edgeScrollDelta: 0 giua khung, tang theo muc vao vung nguong, co tran hai dau', () => {
  const d = pointer => edgeScrollDelta(pointer, 0, 300);
  assert.equal(d(150), 0);
  assert.equal(d(260), 0);
  assert.equal(d(280), 14);
  assert.equal(d(299), 28);
  assert.equal(d(900), 28);
  assert.equal(d(40), 0);
  assert.equal(d(20), -14);
  assert.equal(d(-500), -28);
});

test('fixture: ve du dong va cot theo khoa', async t => {
  const f = await pageFixture(t, { rowCount: 5 });
  assert.equal(f.tbody.rows.length, 5);
  assert.equal(f.cell(0, 'code').textContent, 'SP1');
  assert.ok(f.headCol('reason') > f.headCol('code'));
  assert.ok(Object.keys(EDIT_COLUMNS).every(key => f.headCol(key) >= 0));
});
```

- [ ] **Step 2: Chạy test, xác nhận `edgeScrollDelta` thất bại**

Run: `node --test stocktake/stocktakeInteractions.test.js`
Expected: test `edgeScrollDelta` FAIL với `edgeScrollDelta is not a function`; test `fixture` PASS (nếu fixture hỏng thì sửa fixture trước khi đi tiếp).

- [ ] **Step 3: Thêm hàm vào `stocktakeGrid.js`**

Trong `server/public/stocktake/stocktakeGrid.js`, ngay trước dòng `return { EDIT_COLUMNS, parseClipboard, …`:

```js
  // Khoang can cuon (px) khi keo chuot: pointer o trong [low + edge, high - edge] thi 0; di vao vung nguong thi tang dan,
  // ra ngoai khung thi dat tran `max`. Am = len / trai, duong = xuong / phai.
  function edgeScrollDelta(pointer, low, high, { edge = 40, max = 28 } = {}) {
    if (pointer < low + edge) return -Math.min(max, Math.ceil(((low + edge - pointer) / edge) * max));
    if (pointer > high - edge) return Math.min(max, Math.ceil(((pointer - (high - edge)) / edge) * max));
    return 0;
  }

```

Và đổi dòng `return` cuối thành:

```js
  return { EDIT_COLUMNS, parseClipboard, planPaste, planPasteByCode, planFill, moveIndex, matchesFilter, summarizeCells, waitForConfirm, sortLines, trailingThrottle, edgeScrollDelta };
```

- [ ] **Step 4: Chạy lại, xác nhận đạt**

Run: `node --test stocktake/stocktakeInteractions.test.js stocktake/stocktakeGrid.test.js`
Expected: tất cả PASS (23 test cũ + 2 test mới).

- [ ] **Step 5: Commit**

```bash
git add server/public/stocktake/stocktakeGrid.js server/stocktake/stocktakeInteractions.test.js
git commit -m "feat(stocktake): edgeScrollDelta helper and jsdom board fixture"
```

---

### Task 2: Tự cuộn khi kéo chọn ô (và dùng chung cho nút điền)

**Files:**
- Modify: `server/public/stocktake/stocktake.js` (khối `bindSelection` ~663–744, khối fill ~1066–1125, dòng xuất cuối file)
- Test: `server/stocktake/stocktakeInteractions.test.js`

**Interfaces:**
- Consumes: `Grid.edgeScrollDelta` (Task 1); `pageFixture` (Task 1).
- Produces: `window.TKSStocktake.selection` (đối tượng `{ anchor, focus, dragging, painted }` sẵn có, nay được xuất cho test); trong IIFE: `drag`, `startEdgeScroll(onTick)`, `stopEdgeScroll()`, `cellUnderPointer()`, `dragTick()`.

- [ ] **Step 1: Viết test thất bại**

Thêm vào cuối `stocktakeInteractions.test.js`:

```js
test('keo chon o toi mep duoi: bang tu cuon, vung chon di theo, tha chuot thi dung', async t => {
  const f = await pageFixture(t, { rowCount: 60 });
  const { w, app, scroller } = f;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800 });
  w.document.elementFromPoint = () => f.cell(25, 'counted');
  f.cell(0, 'counted').dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 299, buttons: 1 }));
  await f.sleep(150);
  assert.ok(scroller.scrollTop > 28, 'scrollTop=' + scroller.scrollTop);
  assert.equal(app.selection.focus.row, 25);
  assert.equal(app.selection.anchor.row, 0);
  w.document.dispatchEvent(f.mouse('mouseup'));
  const stopped = scroller.scrollTop;
  await f.sleep(100);
  assert.equal(scroller.scrollTop, stopped);
});

test('keo chon o giua khung: khong cuon', async t => {
  const f = await pageFixture(t, { rowCount: 60 });
  f.scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800 });
  f.cell(0, 'counted').dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  f.w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 150, buttons: 1 }));
  await f.sleep(100);
  assert.equal(f.scroller.scrollTop, 0);
  f.w.document.dispatchEvent(f.mouse('mouseup'));
});

test('nha chuot ngoai cua so (mousemove buttons=0) thi dung cuon', async t => {
  const f = await pageFixture(t, { rowCount: 60 });
  f.scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800 });
  f.cell(0, 'counted').dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  f.w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 299, buttons: 1 }));
  await f.sleep(80);
  f.w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 299, buttons: 0 }));
  const stopped = f.scroller.scrollTop;
  await f.sleep(100);
  assert.equal(f.scroller.scrollTop, stopped);
  assert.equal(f.app.selection.dragging, false);
});

test('keo nut dien toi mep duoi: bang cung tu cuon', async t => {
  const f = await pageFixture(t, { rowCount: 60 });
  const { w, scroller } = f;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 300, left: 0, right: 800 });
  w.document.elementFromPoint = () => null; // to = null -> tha chuot khong ghi gi
  f.cell(0, 'reason').dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  w.document.dispatchEvent(f.mouse('mouseup'));
  const handle = w.document.querySelector('.st-fill');
  assert.ok(handle, 'co nut dien');
  handle.dispatchEvent(f.mouse('mousedown', { clientX: 100, clientY: 100 }));
  w.document.dispatchEvent(f.mouse('mousemove', { clientX: 100, clientY: 299, buttons: 1 }));
  await f.sleep(150);
  assert.ok(scroller.scrollTop > 28, 'scrollTop=' + scroller.scrollTop);
  w.document.dispatchEvent(f.mouse('mouseup'));
  const stopped = scroller.scrollTop;
  await f.sleep(100);
  assert.equal(scroller.scrollTop, stopped);
  assert.equal(f.posts.length, 0);
});
```

- [ ] **Step 2: Chạy, xác nhận thất bại**

Run: `node --test stocktake/stocktakeInteractions.test.js`
Expected: các test mới FAIL (`app.selection` undefined / `scrollTop` = 0); test nút điền có thể đã chạy được một phần nhưng `scrollTop` vẫn 0 hoặc thiếu `lastY` do không có `mousemove` cập nhật — chấp nhận cả hai kiểu FAIL.

- [ ] **Step 3: Cài bộ cuộn-tự-động dùng chung**

Trong `stocktake.js`, ngay trước `function bindSelection() {` thêm:

```js
  // ---------- Cuộn tự động khi kéo (chọn ô / nút điền) ----------
  const drag = { x: 0, y: 0, timer: null };
  // Khung cuộn + mép trên thực sự dùng được (đã trừ hàng tiêu đề dính trên).
  function scrollBox() {
    const scroller = document.querySelector('.st-scroll');
    const box = scroller.getBoundingClientRect();
    const head = scroller.querySelector('thead');
    return { scroller, box, top: box.top + (head ? head.getBoundingClientRect().height : 0) };
  }
  // Ô dưới con trỏ; con trỏ ra ngoài khung thì lấy ô sát mép trong (nội dung đang trôi dưới con trỏ đứng yên).
  function cellUnderPointer() {
    if (typeof document.elementFromPoint !== 'function') return null;
    const { box, top } = scrollBox();
    const x = Math.min(Math.max(drag.x, box.left + 1), box.right - 1);
    const y = Math.min(Math.max(drag.y, top + 1), box.bottom - 1);
    const hit = document.elementFromPoint(x, y);
    return hit ? hit.closest('td[data-col]') : null;
  }
  // Mỗi nhịp: cập nhật đích của lượt kéo đang chạy (vùng chọn hoặc vùng điền) theo ô dưới con trỏ.
  function dragTick() {
    const td = selection.dragging || fill.active ? cellUnderPointer() : null;
    if (!td) return;
    const pos = cellPos(td);
    if (selection.dragging) {
      if (selection.focus && pos.row === selection.focus.row && pos.col === selection.focus.col) return;
      selection.focus = pos;
      paintSelection();
    } else {
      fill.to = pos.row;
      paintFillPreview();
    }
  }
  function startEdgeScroll(onTick) {
    stopEdgeScroll();
    drag.timer = setInterval(() => {
      const { scroller, box, top } = scrollBox();
      const dy = Grid.edgeScrollDelta(drag.y, top, box.bottom);
      const dx = Grid.edgeScrollDelta(drag.x, box.left, box.right);
      if (dy) scroller.scrollTop += dy;
      if (dx) scroller.scrollLeft += dx;
      // Dòng chưa vẽ: vẽ thêm ngay khi gần cuối, không chờ bộ quan sát.
      if (dy > 0 && view.drawn < view.rows.length && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 600) drawMore(CHUNK);
      onTick();
    }, 30);
  }
  function stopEdgeScroll() {
    clearInterval(drag.timer);
    drag.timer = null;
  }

```

- [ ] **Step 4: Nối vào kéo chọn**

Trong `bindSelection`:

(a) Trong handler `mousedown` của `tbody`, ngay sau `selection.dragging = true;` thêm:

```js
      drag.x = event.clientX;
      drag.y = event.clientY;
      startEdgeScroll(dragTick);
```

(b) Thay hai dòng `document.addEventListener('mouseup', …)` và `document.addEventListener('mousemove', …)` bằng:

```js
    document.addEventListener('mouseup', () => { selection.dragging = false; stopEdgeScroll(); endFill(); });
    document.addEventListener('mousemove', event => {
      drag.x = event.clientX;
      drag.y = event.clientY;
      // Nhả chuột ngoài cửa sổ trình duyệt thì không có mouseup: dừng kéo khi không còn giữ nút trái.
      if (selection.dragging && !(event.buttons & 1)) { selection.dragging = false; stopEdgeScroll(); }
    });
```

- [ ] **Step 5: Nối vào nút điền (bỏ bộ cuộn riêng)**

(a) Đổi khai báo `fill` thành (bỏ `scrollTimer`, `lastY`):

```js
  const fill = { handle: null, active: false, rect: null, to: null, painted: [] };
```

(b) Trong `startFill`, thay

```js
    Object.assign(fill, { active: true, rect: selectionRect(), to: null, lastY: event.clientY });
    fill.handle.hidden = true;
    // Gan mep tren / duoi khung cuon thi tu cuon (dong chua ve se ve khi cuon toi canh).
    const scroller = document.querySelector('.st-scroll');
    fill.scrollTimer = setInterval(() => {
      const box = scroller.getBoundingClientRect();
      if (fill.lastY > box.bottom - 30) scroller.scrollTop += 24;
      else if (fill.lastY < box.top + 50) scroller.scrollTop -= 24;
    }, 50);
```

bằng

```js
    Object.assign(fill, { active: true, rect: selectionRect(), to: null });
    drag.x = event.clientX;
    drag.y = event.clientY;
    fill.handle.hidden = true;
    startEdgeScroll(dragTick); // gần mép khung thì tự cuộn; dòng chưa vẽ được vẽ thêm khi cuộn tới
```

(c) Trong `endFill`, thay `clearInterval(fill.scrollTimer);` bằng `stopEdgeScroll();`.

(d) Dòng cuối file: `window.TKSStocktake = { init, visibleRows, cellText, sortRows, state, selection };`

- [ ] **Step 6: Chạy, xác nhận đạt**

Run: `node --test stocktake/stocktakeInteractions.test.js stocktake/stocktakeGrid.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 7: Commit**

```bash
git add server/public/stocktake/stocktake.js server/stocktake/stocktakeInteractions.test.js
git commit -m "feat(stocktake): auto-scroll while drag-selecting and fill-dragging"
```

---

### Task 3: Màu tiêu đề cột sửa được

**Files:**
- Modify: `server/public/stocktake/stocktake.js` (`renderHead` ~351, `render` ~449)
- Modify: `server/public/stocktake/stocktake.css` (sau khối `#stTable thead th[data-sort-active…]`, dòng ~63–66)
- Test: `server/stocktake/stocktakeInteractions.test.js`

**Interfaces:**
- Consumes: `pageFixture`, `EDIT_COLUMNS` (Task 1).
- Produces: class `st-th-edit` trên `th` của cột trong `Grid.EDIT_COLUMNS`; thuộc tính `data-editable="true|false"` trên `#stTable`.

- [ ] **Step 1: Viết test thất bại**

```js
test('tieu de cot sua duoc co class st-th-edit va bang bao dang sua duoc', async t => {
  const f = await pageFixture(t);
  const marked = f.heads.filter(th => th.classList.contains('st-th-edit')).map(th => th.dataset.field).sort();
  assert.deepEqual(marked, Object.keys(EDIT_COLUMNS).sort());
  assert.equal(f.w.document.getElementById('stTable').dataset.editable, 'true');
});

test('dot da dong hoac tai khoan chi xem: bang khong bao sua duoc (tieu de khong to mau)', async t => {
  for (const options of [{ status: 'closed' }, { canEdit: false }]) {
    const f = await pageFixture(t, options);
    assert.equal(f.w.document.getElementById('stTable').dataset.editable, 'false', JSON.stringify(options));
  }
});

test('CSS: tieu de cot sua duoc dung nen ho phach, tieu de dang sap xep dam hon', () => {
  const css = fs.readFileSync(path.join(root, 'stocktake.css'), 'utf8');
  assert.match(css, /#stTable\[data-editable="true"\] thead th\.st-th-edit\{[^}]*background:#b45309/);
  assert.match(css, /th\.st-th-edit\[data-sort-active="true"\]\{[^}]*background:#92400e/);
});
```

- [ ] **Step 2: Chạy, xác nhận thất bại**

Run: `node --test stocktake/stocktakeInteractions.test.js`
Expected: 3 test mới FAIL (class chưa có, `dataset.editable` undefined, CSS chưa có).

- [ ] **Step 3: Thêm class ở `renderHead`**

Trong vòng `for (const column of COLUMNS)` của `renderHead`, ngay sau dòng `if (column.num) th.className = 'num';` thêm:

```js
      if (Grid.EDIT_COLUMNS[column.key]) th.classList.add('st-th-edit');
```

- [ ] **Step 4: Đặt `data-editable` ở `render`**

Trong `render`, ngay sau `if (session && session.branch !== state.headBranch) renderHead(session.branch);` thêm:

```js
    $('stTable').dataset.editable = String(Boolean(editable())); // tiêu đề cột sửa được chỉ tô màu khi thật sự sửa được
```

- [ ] **Step 5: Thêm CSS**

Trong `stocktake.css`, ngay sau dòng `#stTable thead th[data-sort-active="true"] .sort-indicator{color:#a5f3fc}` (dòng 66) thêm:

```css
/* Cột sửa được (chỉ khi đợt còn sửa được): nền hổ phách + biểu tượng bút để phân biệt với cột chỉ đọc. */
#stTable[data-editable="true"] thead th.st-th-edit{background:#b45309;border-bottom-color:#92400e}
#stTable[data-editable="true"] thead th.st-th-edit[data-sort-active="true"]{background:#92400e}
#stTable[data-editable="true"] thead th.st-th-edit[data-sort-active="true"] .sort-indicator{color:#fde68a}
#stTable[data-editable="true"] thead th.st-th-edit .sort-label::before{content:"\270E\00a0";font-size:10px;opacity:.85}
```

- [ ] **Step 6: Chạy, xác nhận đạt**

Run: `node --test stocktake/stocktakeInteractions.test.js stocktake/stocktakeGrid.test.js`
Expected: PASS toàn bộ. Nếu `th.classList` không còn class sau `TKSTables.enhance`, kiểm tra enhance có dựng lại `th` hay không rồi thêm class sau lệnh enhance.

- [ ] **Step 7: Commit**

```bash
git add server/public/stocktake/stocktake.js server/public/stocktake/stocktake.css server/stocktake/stocktakeInteractions.test.js
git commit -m "feat(stocktake): color headers of editable columns"
```

---

### Task 4: Nhấn đúp sửa ô, chi tiết ở ô Mã hàng, menu chuột phải

**Files:**
- Modify: `server/public/stocktake/stocktake.js` (`bindDetail` ~1551, khởi tạo ~1984–1988)
- Modify: `server/public/stocktake/stocktake.css` (cuối file)
- Modify: `server/stocktake/stocktakeGrid.test.js` (fixture hai test cũ)
- Test: `server/stocktake/stocktakeInteractions.test.js`

**Interfaces:**
- Consumes: `openEditor()`, `openDetail(code)`, `editColumnOf(col)`, `cellPos(td)`, `paintSelection()`, `closeEditor(save)`, `selection` (đều có sẵn); `pageFixture` (Task 1).
- Produces: `bindContextMenu()` (gọi trong `init`), class `.st-context-menu` chứa nút `[role="menuitem"]` "Chi tiết sản phẩm".

- [ ] **Step 1: Viết test thất bại**

```js
const dialogOf = f => f.w.document.getElementById('stDetailDialog');

test('nhan dup o Ma hang: mo chi tiet san pham', async t => {
  const f = await pageFixture(t);
  f.cell(0, 'code').dispatchEvent(f.mouse('dblclick'));
  assert.equal(dialogOf(f).open, true);
});

test('nhan dup o sua duoc: ra o nhap (con tro), khong mo chi tiet', async t => {
  const f = await pageFixture(t);
  f.cell(1, 'reason').dispatchEvent(f.mouse('dblclick'));
  const editor = f.scroller.querySelector('.st-editor');
  assert.ok(editor, 'co o nhap');
  assert.equal(f.w.document.activeElement, editor);
  assert.equal(dialogOf(f).open, false);
  assert.equal(f.app.selection.focus.row, 1);
});

test('nhan dup o chi doc (Tong kiem): khong lam gi', async t => {
  const f = await pageFixture(t);
  f.cell(0, 'counted').dispatchEvent(f.mouse('dblclick'));
  assert.equal(f.scroller.querySelector('.st-editor'), null);
  assert.equal(dialogOf(f).open, false);
});

test('nhan dup o sua duoc khi dot da dong: bao khong sua duoc, khong mo gi', async t => {
  const f = await pageFixture(t, { status: 'closed' });
  f.cell(0, 'reason').dispatchEvent(f.mouse('dblclick'));
  assert.equal(f.scroller.querySelector('.st-editor'), null);
  assert.equal(dialogOf(f).open, false);
  assert.match(f.w.document.getElementById('stNotice').textContent, /đã đóng/);
});

test('chuot phai vao dong: menu "Chi tiet san pham" mo dung ma, dong khi chon', async t => {
  const f = await pageFixture(t);
  const event = f.mouse('contextmenu', { clientX: 50, clientY: 60 });
  f.cell(2, 'counted').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  const item = f.w.document.querySelector('.st-context-menu [role="menuitem"]');
  assert.equal(item.textContent, 'Chi tiết sản phẩm');
  item.click();
  assert.equal(dialogOf(f).open, true);
  assert.match(f.w.document.getElementById('stDetailTitle').textContent, /SP3/);
  assert.equal(f.w.document.querySelector('.st-context-menu'), null);
});

test('menu chuot phai dong khi bam ra ngoai hoac nhan Esc', async t => {
  const f = await pageFixture(t);
  f.cell(0, 'counted').dispatchEvent(f.mouse('contextmenu', { clientX: 10, clientY: 10 }));
  assert.ok(f.w.document.querySelector('.st-context-menu'));
  f.w.document.body.dispatchEvent(f.mouse('mousedown'));
  assert.equal(f.w.document.querySelector('.st-context-menu'), null);
  f.cell(0, 'counted').dispatchEvent(f.mouse('contextmenu', { clientX: 10, clientY: 10 }));
  f.w.document.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(f.w.document.querySelector('.st-context-menu'), null);
});
```

Ghi chú: `openDetail` đặt tiêu đề hộp (`#stDetailTitle`) có chứa mã hàng; nếu assert tiêu đề thất bại vì định dạng khác, in `textContent` ra rồi sửa regex cho khớp định dạng thật (không bỏ assert).

- [ ] **Step 2: Chạy, xác nhận thất bại**

Run: `node --test stocktake/stocktakeInteractions.test.js`
Expected: các test mới FAIL (nhấn đúp ô sửa được vẫn mở chi tiết, không có menu).

- [ ] **Step 3: Thay handler `dblclick` trong `bindDetail`**

Thay

```js
    // Nhấp một lần = chọn ô (như sheet); nhấp đúp = mở chi tiết mã.
    $('stRows').addEventListener('dblclick', event => {
      const tr = event.target.closest('tr[data-code]');
      if (tr) openDetail(tr.dataset.code);
    });
```

bằng

```js
    // Nhấp một lần = chọn ô (như sheet). Nhấp đúp: ô Mã hàng = mở chi tiết mã; ô sửa được = mở ô nhập (như F2); ô khác = không làm gì.
    $('stRows').addEventListener('dblclick', event => {
      const td = event.target.closest('td[data-col]');
      const tr = td && td.parentElement;
      if (!tr || !tr.dataset.code) return;
      const col = Number(td.dataset.col);
      if (COLUMNS[col] && COLUMNS[col].key === 'code') { openDetail(tr.dataset.code); return; }
      if (!editColumnOf(col)) return;
      selection.anchor = selection.focus = cellPos(td);
      paintSelection();
      openEditor();
    });
```

- [ ] **Step 4: Thêm `bindContextMenu` và gọi trong `init`**

Ngay sau hàm `bindDetail` (trước `}` đóng của nó thì không; đặt thành hàm riêng ngay sau hàm đó) thêm:

```js
  // Menu chuột phải trên dòng: một mục "Chi tiết sản phẩm".
  function bindContextMenu() {
    let menu = null;
    const close = () => { if (menu) { menu.remove(); menu = null; } };
    $('stRows').addEventListener('contextmenu', event => {
      const td = event.target.closest('td[data-col]');
      const tr = td && td.parentElement;
      if (!tr || !tr.dataset.code) return;
      event.preventDefault();
      close();
      if (editor.input) closeEditor(!editor.options);
      selection.anchor = selection.focus = cellPos(td);
      paintSelection();
      const code = tr.dataset.code;
      menu = document.createElement('div');
      menu.className = 'st-context-menu';
      menu.setAttribute('role', 'menu');
      const item = document.createElement('button');
      item.type = 'button';
      item.setAttribute('role', 'menuitem');
      item.textContent = 'Chi tiết sản phẩm';
      item.addEventListener('click', () => { close(); openDetail(code); });
      menu.appendChild(item);
      document.body.appendChild(menu);
      // Giữ menu trong khung nhìn (đảo sang trái / lên trên khi sát mép).
      const width = menu.offsetWidth || 160;
      const height = menu.offsetHeight || 40;
      menu.style.left = Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)) + 'px';
      menu.style.top = Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)) + 'px';
      item.focus();
    });
    document.addEventListener('mousedown', event => { if (menu && !menu.contains(event.target)) close(); });
    document.addEventListener('keydown', event => { if (menu && event.key === 'Escape') { event.preventDefault(); close(); } });
    window.addEventListener('resize', close);
    document.querySelector('.st-scroll').addEventListener('scroll', close);
  }
```

Trong `init`, sau `bindSelection();` thêm `bindContextMenu();`.

- [ ] **Step 5: Thêm CSS menu**

Cuối `stocktake.css`:

```css
/* Menu chuột phải trên dòng bảng. */
.st-context-menu{position:fixed;z-index:40;min-width:160px;padding:4px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--panel);box-shadow:0 6px 18px rgba(0,0,0,.25)}
.st-context-menu button{display:block;width:100%;padding:8px 12px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--text);font:13px var(--font-body);text-align:left;cursor:pointer}
.st-context-menu button:hover,.st-context-menu button:focus-visible{background:var(--panel-2);outline:none}
```

- [ ] **Step 6: Sửa fixture hai test cũ**

Trong `server/stocktake/stocktakeGrid.test.js` có ba chỗ dựng hàng giả bằng `'<tr data-code="A"><td>A</td></tr>'` (hai trong test `detail quantity`, một trong `detail header sorting`). Đổi cả ba thành `'<tr data-code="A"><td data-col="0">A</td></tr>'` (ô Mã hàng là cột 0). Dùng tìm kiếm: `<tr data-code="A"><td>A</td></tr>` → `<tr data-code="A"><td data-col="0">A</td></tr>`.

- [ ] **Step 7: Chạy, xác nhận đạt**

Run: `node --test stocktake/stocktakeInteractions.test.js stocktake/stocktakeGrid.test.js`
Expected: PASS toàn bộ, gồm hai test cũ về hộp chi tiết.

- [ ] **Step 8: Commit**

```bash
git add server/public/stocktake/stocktake.js server/public/stocktake/stocktake.css server/stocktake/stocktakeGrid.test.js server/stocktake/stocktakeInteractions.test.js
git commit -m "feat(stocktake): dblclick edits cells, detail via code cell or context menu"
```

---

### Task 5: Ô nhập cột chữ là `<textarea>` tự giãn

**Files:**
- Modify: `server/public/stocktake/stocktake.js` (`openEditor` ~931–958, `closeEditor` ~1040)
- Modify: `server/public/stocktake/stocktake.css` (cạnh `.st-editor`, dòng 87)
- Test: `server/stocktake/stocktakeInteractions.test.js`

**Interfaces:**
- Consumes: `pageFixture`, `posts` (Task 1); `openEditor` (Task 4 gọi qua nhấn đúp).
- Produces: ô nhập `.st-editor` là `<textarea>` cho cột có `type: 'text'` trong `COLUMNS`; `<input>` cho cột còn lại.

- [ ] **Step 1: Viết test thất bại**

```js
test('o nhap cot chu (Chi tiet ly do) la textarea tu gian theo noi dung', async t => {
  const f = await pageFixture(t);
  f.cell(0, 'reason').dispatchEvent(f.mouse('dblclick'));
  const editor = f.scroller.querySelector('.st-editor');
  assert.equal(editor.tagName, 'TEXTAREA');
  Object.defineProperty(editor, 'scrollHeight', { value: 90, configurable: true });
  editor.value = 'Lý do rất dài '.repeat(10);
  editor.dispatchEvent(new f.w.Event('input', { bubbles: true }));
  assert.equal(editor.style.height, '94px');
});

test('o nhap cot so (KK truoc sai) van la input mot dong', async t => {
  const f = await pageFixture(t);
  f.cell(0, 'prevDiff').dispatchEvent(f.mouse('dblclick'));
  assert.equal(f.scroller.querySelector('.st-editor').tagName, 'INPUT');
});

test('textarea: Enter luu mot dong (xuong dong -> khoang trang), Esc huy', async t => {
  const f = await pageFixture(t, { fetchHandler: url => /\/cells/.test(url)
    ? { applied: [{ code: 'SP1', column: 'reasonText', after: 'dòng một dòng hai' }], conflicts: [], skipped: {}, notes: [], tags: [] } : null });
  f.cell(0, 'reason').dispatchEvent(f.mouse('dblclick'));
  let editor = f.scroller.querySelector('.st-editor');
  editor.value = 'dòng một\ndòng hai';
  editor.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await f.sleep(30);
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].cells[0].value, 'dòng một dòng hai');
  assert.equal(f.scroller.querySelector('.st-editor'), null);

  f.cell(1, 'reason').dispatchEvent(f.mouse('dblclick'));
  editor = f.scroller.querySelector('.st-editor');
  editor.value = 'se bi huy';
  editor.dispatchEvent(new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await f.sleep(30);
  assert.equal(f.posts.length, 1);
});
```

- [ ] **Step 2: Chạy, xác nhận thất bại**

Run: `node --test stocktake/stocktakeInteractions.test.js`
Expected: test đầu và test Enter FAIL (`INPUT` thay vì `TEXTAREA`); test `input` cho KK trước sai có thể đã PASS.

- [ ] **Step 3: Sửa `openEditor`**

Thay

```js
    const input = document.createElement('input');
    input.className = 'st-editor';
```

bằng

```js
    // Cột chữ (Chi tiết lý do, Cụm SP...): textarea tự giãn để thấy hết chữ dài; cột số / giờ giữ ô một dòng.
    const multiline = COLUMNS[pos.col].type === 'text';
    const input = document.createElement(multiline ? 'textarea' : 'input');
    input.className = 'st-editor';
    if (multiline) input.rows = 1;
```

Ngay sau dòng `input.setSelectionRange(input.value.length, input.value.length);` thêm:

```js
    if (multiline) {
      const fit = () => {
        input.style.height = 'auto';
        input.style.height = Math.max(input.scrollHeight + 4, box.height, 30) + 'px'; // +4: viền 2px mỗi cạnh (border-box)
      };
      input.addEventListener('input', fit);
      fit();
    }
```

- [ ] **Step 4: Giữ giá trị lưu một dòng trong `closeEditor`**

Thay dòng

```js
    const value = options ? (options[index].key === 'pending' ? '' : options[index].label) : input.value;
```

bằng

```js
    const value = options ? (options[index].key === 'pending' ? '' : options[index].label) : input.value.replace(/[\r\n]+/g, ' ');
```

- [ ] **Step 5: Thêm CSS**

Ngay sau dòng `.st-editor{…}` (dòng 87) thêm:

```css
textarea.st-editor{display:block;resize:none;overflow-y:auto;max-height:min(240px,60vh);line-height:1.35;white-space:pre-wrap;overflow-wrap:anywhere}
```

- [ ] **Step 6: Chạy, xác nhận đạt**

Run: `node --test stocktake/stocktakeInteractions.test.js stocktake/stocktakeGrid.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 7: Commit**

```bash
git add server/public/stocktake/stocktake.js server/public/stocktake/stocktake.css server/stocktake/stocktakeInteractions.test.js
git commit -m "feat(stocktake): multi-line auto-growing editor for text columns"
```

---

### Task 6: Kiểm tra toàn nhóm, trình duyệt thật, tài liệu

**Files:**
- Modify: `CURRENT.md` (thêm mục đầu file)
- Cập nhật: `graphify-out/` (qua lệnh)

**Interfaces:** không.

- [ ] **Step 1: Chạy nhóm test liên quan**

Run (từ `server/`):

```bash
node --test stocktake/*.test.js test/frontend/table-controls.test.js test/frontend/table-controls-integration.test.js test/frontend/table-controls-arrow-nav.test.js test/frontend/sort-icons.test.js test/frontend/table-alignment.test.js test/frontend/vt-positions-nav.test.js
```

Expected: 100% PASS. Test dùng HTTP loopback có thể báo `EACCES` trong sandbox: chạy lại ngoài sandbox, không coi là lỗi mới. Hai test lỗi nền ở mục 4.1 `CLAUDE.md` không nằm trong lệnh này.

- [ ] **Step 2: Xem thử trên trình duyệt thật**

Khởi chạy server cục bộ theo `.claude/launch.json` (chế độ chỉ đọc an toàn, xem memory "Chạy server local an toàn với DB thật"), mở `/stocktake/`, chọn đợt có nhiều dòng rồi kiểm:
1. Nhấn giữ một ô, kéo xuống sát mép dưới khung: bảng tự cuộn, vùng bôi đen nối dài, thanh tổng cập nhật; nhả chuột thì dừng. Thử kéo sang phải/trái khi bảng có cuộn ngang.
2. Tiêu đề 9 cột sửa được màu hổ phách + bút; cột khác xanh ngọc; Sáng và Tối; đợt đã đóng thì tiêu đề về xanh ngọc.
3. Nhấn đúp ô Chi tiết lý do: ra con trỏ; gõ chữ dài thấy ô giãn xuống dòng; Enter lưu; Esc hủy. Nhấn đúp Trạng thái: hiện danh sách chọn.
4. Nhấn đúp ô Mã hàng, và chuột phải → "Chi tiết sản phẩm": mở hộp chi tiết. Chuột phải sát mép phải/dưới: menu không bị cắt.
5. 375px: không vỡ bố cục, không lỗi JS ở console.

Nếu máy không có DB để mở được đợt, dùng trang mẫu với dữ liệu giả theo cách đã làm ở các lượt trước (`.codex_tmp/stocktake-multisort-browser.cjs`) và nói rõ trong `CURRENT.md` rằng đã xem bằng dữ liệu giả.

- [ ] **Step 3: Cập nhật `CURRENT.md`**

Thêm lên đầu file một mục mới, ngày `07/11/2026`, nêu: ba việc đã làm (tự cuộn khi kéo chọn dùng chung với nút điền, màu tiêu đề cột sửa được, nhấn đúp sửa ô + chi tiết ở ô Mã hàng/menu chuột phải + ô nhập chữ xuống dòng), số test (ghi đúng con số lần chạy Step 1), trình duyệt đã xem gì, không migration, chưa commit lên main/chưa deploy nếu đúng thực tế. Liên kết thiết kế và kế hoạch.

- [ ] **Step 4: Cập nhật đồ thị**

Run (từ thư mục gốc repo): `graphify update .`
Expected: hoàn tất không lỗi. Nếu máy không có `graphify`, ghi rõ vào `CURRENT.md`.

- [ ] **Step 5: Commit**

```bash
git add CURRENT.md graphify-out docs/superpowers/plans/2026-11-07-stocktake-grid-interactions.md
git commit -m "docs: record stocktake grid interactions results"
```
