# Kiểm kê: gọn hộp chi tiết, dòng đếm, đủ sản phẩm, xuất thống kê — Kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bảng Kiểm kê hiện đủ hàng đang hoạt động, hộp chi tiết chỉ còn dòng đếm (sửa được Khu, Quy cách, sort được) và lịch sử, có file thống kê kèm cột Kiểm quy cách.

**Architecture:** Hàm thuần trong `stocktakeCompute`, `stocktakeStatus`, `stocktakeGrid`, `stocktakeExport`; service thêm `getLineExport`; route mới `export-lines`; frontend vanilla trong `public/stocktake/`. Spec: `docs/superpowers/specs/2026-11-05-stocktake-detail-products-stats-design.md`.

**Tech Stack:** Node.js CommonJS, Express, Postgres (PGlite trong test), ExcelJS, `node:test`, vanilla JS/CSS.

## Global Constraints

- Không migration. Không ghi gì lên DB thật hoặc KiotViet khi kiểm thử.
- Giữ API `PUT .../note`, `PUT .../tag`.
- Giao diện hỗ trợ sáng/tối và 375px. Tăng `?v=` khi đổi file tĩnh.
- Chạy test từ `server/`: `node --test --test-concurrency=1 <file>`.

---

### Task 1: Hiện đủ sản phẩm, thẻ Chưa XL

**Files:** `server/stocktake/stocktakeCompute.js`, `stocktakeService.js`, `public/stocktake/stocktakeStatus.js`, `public/stocktake/stocktake.js`; test `stocktakeCompute.test.js`, `stocktakeService.test.js`, `stocktakeStatus.test.js`.

**Interfaces:** `products[].active: boolean`; `Status.isIdle(row) -> boolean`.

- [ ] **Step 1: Test hỏng**

```js
// stocktakeCompute.test.js
test('hang dang hoat dong 0/0 co trong bang, khong la Quen KK; hang ngung 0/0 khong co', () => {
  const board = buildBoard({
    lines: [{ orderId: 1, lineNo: 0, productCode: 'DEM', quantity: 5 }],
    products: [
      { code: 'RONG', stock: 0, cost: 1, active: true }, { code: 'NGUNG', stock: 0, cost: 1, active: false },
      { code: 'NGUNGTON', stock: 3, cost: 1, active: false }, { code: 'DEM', stock: 0, cost: 2, active: false }
    ]
  });
  assert.deepEqual(board.rows.map(row => row.code).sort(), ['DEM', 'NGUNGTON', 'RONG']);
  const row = code => board.rows.find(item => item.code === code);
  assert.equal(row('RONG').forgotten, false);
  assert.equal(row('RONG').diffQty, 0);
  assert.equal(row('DEM').diffQty, 5);
  assert.equal(board.totals.mismatched, 2);
});

// stocktakeStatus.test.js
test('summarize + isIdle: ma 0/0 chua co trang thai khong tinh vao Chua XL', () => {
  const rows = [{ counted: 0, stock: 0, diffValue: 0 }, { counted: 0, stock: 5, diffValue: -5 }, { counted: 0, stock: 0, diffValue: 0, note: { statusText: 'OK' } }];
  const totals = Status.summarize(rows);
  assert.equal(totals.get('pending').count, 1);
  assert.equal(totals.get('ok').count, 1);
  assert.deepEqual(rows.map(Status.isIdle), [true, false, false]);
});
```

Trong `stocktakeService.test.js` thêm hàng `('hanoi', 5, 'DDD4', 'Hàng D', '{"inventories":[{"onHand":0,"cost":9}]}')` và hàng ngừng + mã nhường trong test riêng, kiểm `getBoard` có `DDD4`, không có hàng `is_active=false` 0/0 và mã chứa `#`.

- [ ] **Step 2: Chạy, xác nhận hỏng.**

- [ ] **Step 3: Cài đặt**

`buildBoard`: `if (num(product.stock) !== 0 || product.active === true) entry(code);`

`PRODUCTS_SQL`: thêm `p.is_active IS NOT FALSE AS active` và `AND p.code NOT LIKE '%#%'`. `loadInputs` map thêm `active: row.active`.

`stocktakeStatus.js`:

```js
  // Ma khong ai dem, khong co ton, chua co trang thai: khong can xu ly nen khong tinh vao "Chua XL".
  function isIdle(row) {
    return Boolean(row) && Number(row.counted) === 0 && Number(row.stock) === 0 && classify(row.note ? row.note.statusText : '') === 'pending';
  }
```

`summarize` thêm `if (isIdle(row)) continue;` đầu vòng lặp; export `isIdle`. `visibleRows` trong `stocktake.js`: lọc `state.status` thì `if (state.status === 'pending' && Status.isIdle(row)) return false;`.

- [ ] **Step 4: Chạy lại, xanh. Commit** `feat(kiem-ke): hien du hang dang hoat dong, the Chua XL bo ma 0/0`

### Task 2: Xuất file thống kê, cột Kiểm quy cách

**Files:** `server/stocktake/stocktakeExport.js`, `stocktakeService.js`, `stocktakeRoutes.js`; test mới `stocktakeExport.test.js`, thêm `stocktakeService.test.js`, `stocktakeRoutes.test.js`.

**Interfaces:** `checkSpec(spec, quantity) -> { status: 'ok'|'diff'|'unreadable'|'blank', computed?: number, text: string }`; `createStatsWorkbook({ session, rows }) -> { buffer, fileName, mimeType }`; `service.getLineExport(ctx, id) -> { session, rows }`; `GET /api/stocktake/sessions/:id/export-lines`.

- [ ] **Step 1: Test hỏng**

```js
// stocktakeExport.test.js
const { checkSpec, createStatsWorkbook, statsHeaders } = require('./stocktakeExport');
test('checkSpec: khop, lech, khong nhan duoc, trong', () => {
  assert.equal(checkSpec('3Tx40+1Tx17', 137).status, 'ok');
  assert.equal(checkSpec('1T x 40c', 40).text, '');
  assert.equal(checkSpec('3T x 100 - 20', 280).status, 'ok');
  assert.deepEqual(checkSpec('8t*30', 210), { status: 'diff', computed: 240, text: 'Lệch: quy cách 240, SL 210' });
  assert.equal(checkSpec('12tx30 chưa thay vỏ', 360).text, 'Không nhân được quy cách');
  assert.equal(checkSpec('1t', 1).status, 'unreadable');
  assert.equal(checkSpec('  ', 5).text, 'Thiếu quy cách');
  assert.equal(checkSpec('1t x 26', 0.72).text, 'Lệch: quy cách 26, SL 0.72');
});
```

Thêm test đọc lại workbook bằng ExcelJS: đúng tiêu đề và thứ tự, bỏ dòng `removed`, sắp theo tên hàng rồi team rồi khu, ô lệch tô `FFFECACA`, ô không nhân được tô `FFFEF3C7`, `safeText` chặn `=`; service: cộng theo mã bằng `counted`, có dòng tay, đợt `sheet_import` báo `STOCKTAKE_NO_LINES`; route: 200, `content-disposition` chứa `kiem-ke-thong-ke-`, người chỉ xem gọi được.

- [ ] **Step 2: Chạy, xác nhận hỏng.**

- [ ] **Step 3: Cài đặt `stocktakeExport.js`**

```js
const { parseSpec } = require('../public/shared/carton');
const LABEL_FILL = { diff: 'FFFECACA', unreadable: 'FFFEF3C7', blank: 'FFFEF3C7' };

function checkSpec(spec, quantity) {
  if (!String(spec ?? '').trim()) return { status: 'blank', text: 'Thiếu quy cách' };
  const parsed = parseSpec(spec);
  if (!parsed) return { status: 'unreadable', text: 'Không nhân được quy cách' };
  const qty = Number(quantity) || 0;
  if (Math.abs(parsed.quantity - qty) < 0.000001) return { status: 'ok', computed: parsed.quantity, text: '' };
  return { status: 'diff', computed: parsed.quantity, text: `Lệch: quy cách ${parsed.quantity}, SL ${qty}` };
}
```

`createStatsWorkbook` trải `rows[].lines` (bỏ `removed`), sắp theo tên, team, khu với `localeCompare('vi', { numeric: true })`, cột `Tên khách hàng, Ghi chú, Mã hàng, Tên hàng, Ghi chú hàng hóa, Số lượng, Kiểm quy cách, Trang in`, autoFilter, `frozenNoGridlinesView(1)`, `applyFullTableBorder`, `HEADER_FONT`, tên file `kiem-ke-thong-ke-<tên>.xlsx`. Tách hàm `safeFileName` dùng chung với `createStocktakeWorkbook`.

- [ ] **Step 4: Cài đặt service + route**

```js
  async function getLineExport(ctx, sessionId) {
    const db = getDb();
    const session = await readSession(db, ctx, sessionId);
    if (session.source === 'sheet_import') throw fail(409, 'STOCKTAKE_NO_LINES', 'Đợt nạp từ sheet không có dòng đơn nên không xuất được thống kê.');
    const { rows } = buildBoard(await loadInputs(db, session, { withCounterpart: false, withPrevious: false }));
    return { session, rows };
  }
```

```js
  router.get('/api/stocktake/sessions/:id/export-lines', handle(async (req, res) => {
    const { session, rows } = await svc().getLineExport(ctxOf(req), idOf(req));
    const file = await createStatsWorkbook({ session, rows });
    res.set('Content-Type', file.mimeType);
    res.set('Content-Disposition', `attachment; filename="${file.fileName}"`);
    res.send(file.buffer);
  }));
```

- [ ] **Step 5: Chạy lại, xanh. Commit** `feat(kiem-ke): xuat file thong ke kem cot Kiem quy cach`

### Task 3: Gọn hộp chi tiết, sửa và sort dòng đếm

**Files:** `server/public/stocktake/index.html`, `stocktake.js`, `stocktake.css`, `stocktakeGrid.js`; test `stocktakeGrid.test.js`.

**Interfaces:** `Grid.sortLines(lines, key, dir) -> line[]`, `key` thuộc `team|zone|spec|quantity|order|updated`, `dir` là `asc|desc|null`.

- [ ] **Step 1: Test hỏng**

```js
test('sortLines: so tu nhien, tang giam, bo sort giu thu tu goc, o trong cuoi', () => {
  const a = { team: 'TEAM 10', zone: 'G2', quantity: 5, orderCode: 'DH2' };
  const b = { team: 'TEAM 2', zone: '', quantity: 50, orderCode: 'DH1' };
  const c = { team: 'TEAM 1', zone: 'G10', quantity: 7, manual: true, edit: { updatedByName: 'Hưng' } };
  const codes = list => list.map(line => line.team);
  assert.deepEqual(codes(sortLines([a, b, c], 'team', 'asc')), ['TEAM 1', 'TEAM 2', 'TEAM 10']);
  assert.deepEqual(codes(sortLines([a, b, c], 'team', 'desc')), ['TEAM 10', 'TEAM 2', 'TEAM 1']);
  assert.deepEqual(codes(sortLines([a, b, c], 'zone', 'asc')), ['TEAM 10', 'TEAM 1', 'TEAM 2']);
  assert.deepEqual(codes(sortLines([a, b, c], 'zone', 'desc')), ['TEAM 1', 'TEAM 10', 'TEAM 2']);
  assert.deepEqual(codes(sortLines([a, b, c], 'quantity', 'desc')), ['TEAM 2', 'TEAM 1', 'TEAM 10']);
  assert.deepEqual(codes(sortLines([a, b, c], 'updated', 'asc')), ['TEAM 1', 'TEAM 10', 'TEAM 2']);
  assert.deepEqual(codes(sortLines([a, b, c], 'team', null)), ['TEAM 10', 'TEAM 2', 'TEAM 1']);
});
```

- [ ] **Step 2: Chạy, xác nhận hỏng.**

- [ ] **Step 3: Cài đặt `sortLines`**

```js
  const LINE_SORT = {
    team: line => line.team, zone: line => line.zone, spec: line => line.spec, quantity: line => line.quantity,
    order: line => (line.manual ? 'Thêm tay' : line.orderCode), updated: line => (line.edit ? line.edit.updatedByName : '')
  };
  function sortLines(lines, key, dir) {
    const read = LINE_SORT[key];
    if (!read || !dir) return [...lines];
    const factor = dir === 'desc' ? -1 : 1;
    const blank = value => value === null || value === undefined || value === '';
    return [...lines].sort((a, b) => {
      const x = read(a);
      const y = read(b);
      if (blank(x) || blank(y)) return blank(x) === blank(y) ? 0 : blank(x) ? 1 : -1;
      const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'vi', { numeric: true });
      return diff * factor;
    });
  }
```

- [ ] **Step 4: HTML + bỏ form**

Bỏ `#stDetailStats`, hai `section` Kiểm lại và Cụm SP / Combo. Tiêu đề bảng dòng đếm thành nút `<button type="button" class="st-line-sort" data-line-sort="team">Team</button>` cho Team, Khu, Quy cách, SL, Đơn, Sửa bởi. Xóa khỏi `stocktake.js`: `checkStale`, `fillStatusSelect`, phần form trong `renderDetail`, listener `stNoteForm`, `stTagForm`, đối số `forms` của `renderDetail`/`loadBoard`.

- [ ] **Step 5: `renderLines` mới**

Ô Khu, Quy cách là `input type="text"` có `data-field`, `maxlength="200"`, `change` gọi `saveLine(line, { zone })`/`{ spec }`; dòng có `line.original` khác giá trị hiện tại thì thêm `<small>gốc …</small>`. `tr.dataset.lineKey = lineKey(line)`; `lineKey = line.manual ? 'e' + line.edit.id : line.orderId + ':' + line.lineNo`.

Trước khi xóa `tbody`, ghi nhớ ô đang focus (khóa dòng, `data-field`, giá trị, vị trí con trỏ với ô chữ); dựng xong thì tìm lại đúng ô, trả giá trị và focus. Dùng `Grid.sortLines(row.lines, lineSort.key, lineSort.dir)`.

- [ ] **Step 6: `saveLine` xếp hàng**

Đợi tải lại bảng mới cập nhật `version` thì Tab nhanh sang ô sau sẽ báo xung đột giả. Xếp các lần lưu nối tiếp, nhớ `version` từ phản hồi, tải lại nền sau cùng:

```js
  const lineSaves = { queue: Promise.resolve(), versions: new Map(), timer: null };
  function saveLine(line, patch) {
    lineSaves.queue = lineSaves.queue.then(() => sendLine(line, patch));
    return lineSaves.queue;
  }
  async function sendLine(line, patch) {
    const key = lineKey(line);
    const version = Math.max(lineSaves.versions.get(key) || 0, line.edit ? line.edit.version : 0) || null;
    const base = line.manual ? { editId: line.edit.id } : { orderId: line.orderId, lineNo: line.lineNo };
    setDetailError('');
    const { response, payload } = await request(API + '/sessions/' + state.sessionId + '/lines', jsonOptions('PATCH', Object.assign(base, patch, { version })));
    if (!response.ok) { handleWriteError(payload); return; }
    lineSaves.versions.set(key, payload.edit.version);
    $('stConflict').hidden = true;
    clearTimeout(lineSaves.timer);
    lineSaves.timer = setTimeout(async () => { await loadBoard({ background: true }); loadHistory(); }, 300);
  }
```

`openDetail` đặt lại `lineSort`. Listener trên `thead` đổi trạng thái sort tăng → giảm → bỏ, cập nhật `aria-sort`, gọi `renderLines`.

- [ ] **Step 7: Nút Xuất thống kê**

Thêm `#stExportStatsButton` cạnh `#stExportButton`. Tách `saveDownload(response)` dùng chung cho hai nút; lỗi đọc `error` từ JSON rồi `notify(..., true)`. Tăng `?v=20261105-4` cho css, js, grid, status.

- [ ] **Step 8: Chạy test `stocktakeGrid`, `node --check`. Commit** `feat(kiem-ke): gon hop chi tiet, sua va sort dong dem, nut Xuat thong ke`

### Task 4: Xem trên trình duyệt, đối chiếu, tài liệu

- [ ] **Step 1:** Server PGlite dữ liệu giả: hộp gọn; sửa Khu, Tab sang Quy cách không báo xung đột, không mất chữ khi tải nền; sort; mã 0/0 cuối bảng; thẻ và lọc Chưa XL; tải file; sáng/tối; 375px; tài khoản chỉ xem.
- [ ] **Step 2:** Đối chiếu chỉ đọc với DB thật: số mã HN, SG; cộng dòng thống kê theo mã bằng Tổng kiểm.
- [ ] **Step 3:** Cập nhật `README.md`, `server/README.md`, `docs/04-planning/implementation_plan.md`, SRS, BRD, `CURRENT.md`.
- [ ] **Step 4:** `npm test` trong `server/`, so với `origin/main`. `graphify update .`.
- [ ] **Step 5: Commit** `docs(kiem-ke): cap nhat tai lieu hop chi tiet, du san pham, xuat thong ke`
