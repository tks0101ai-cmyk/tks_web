# Kiểm kê: bỏ Dán cột, tiêu đề gọn, bộ lọc mới — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trên `/stocktake/`: bộ lọc 5 lựa chọn mới, bỏ hẳn tính năng "Dán cột" (giao diện + API), tiêu đề/ô bảng một dòng cắt chữ ở mép ô với độ rộng mặc định nhỏ hơn.

**Architecture:** Điều kiện lọc là hàm thuần `matchesFilter` trong `stocktakeGrid.js` (UMD, test Node). Bỏ `pasteColumn` / route `/paste` / `parsePasteText` / hộp dán; các hành vi máy chủ còn cần (người kiểm lại, combo, cụm, xóa số tay, lịch sử cụm ở đợt khác, giữ màu) được kiểm lại qua `saveCells`. CSS chỉ ghi đè cho `#stTable`, không sửa `shared/table-controls`.

**Tech Stack:** Node 24, Express, CommonJS, vanilla JS/CSS, PGlite + `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-03-stocktake-filter-header-trim-design.md`

## Global Constraints

- Nhánh `claude/inventory-feature-analysis-1ab808` (PR #28 đang mở). Không migration, không ghi DB thật.
- Bộ lọc `#stFilter` đúng 5 giá trị: `all` Tất cả mã · `forgotten` Quên KK · `statusOnly` Chỉ có trạng thái · `printOnly` Chỉ có trang in · `neither` Không có cả hai. "Có chữ" = `String(x ?? '').trim() !== ''` trên `note.statusText` / `note.printPage`; màu trạng thái và Giờ in không tính; giá trị lạ = `all`.
- Giữ action lịch sử `'paste'` và cách hiện lịch sử cũ "Dán cột …".
- Giữ trong `stocktakePaste.js`: `PASTE_COLUMNS`, `STATUS_COLORS`, `codeKey`, `foldName`, `parseVnNumber`, `parseComboFlag`, `normalizeValue`, `columnValue`, `sameValue`, `rawOf`. Giữ trong service: `insertPasteHistory`, `lockTags`, `upsertNotes`, `upsertTags`, `nextRecord`, `sameRecord`, `MAX_PASTE_ROWS`.
- CSS chỉ cho `#stTable` / `.st-table`; tiêu đề 11px; không xuống dòng; cắt chữ ở mép ô (`text-overflow:clip`); `--locations-min-width` = 0.
- Độ rộng mặc định (px): Mã hàng 96 · Tên hàng 200 · Tổng kiểm 84 · Tồn KIOT 84 · SL chênh 84 · Giá trị chênh 110 · Trạng thái 110 · Chi tiết lý do 170 · Trang in 64 · Giờ in 70 · Người kiểm lại 110 · KK trước sai 84 · Kiểm SG/HN 84 · Cụm SP 110 · Count 64 · Chênh cụm 84 · Do KK trước 72 · Lẫn + KK trước 84 · Do kiểm SG/HN 72 · Quên KK 64 · Combo 64 · Vị trí kho gần nhất 110 · Giá vốn 84 · Cập nhật 120. Khóa bảng `stocktake-board-v4`.
- Chạy test từ `server/`, truyền tên tệp (Node 24 không chạy `node --test <thư mục>`). `npm test` tạo lại `server/public/prototypes/order-picking/index.html` → `git checkout --` tệp đó trước khi commit.
- Commit kết thúc bằng `Co-Authored-By: <model thực sự viết commit> <noreply@anthropic.com>`.

---

### Task 1: Bộ lọc 5 lựa chọn

**Files:**
- Modify: `server/public/stocktake/stocktakeGrid.js` (thêm hàm trước dòng `return { EDIT_COLUMNS, … }`, ~dòng 88)
- Modify: `server/public/stocktake/stocktake.js` (`visibleRows`, ~dòng 229–237)
- Modify: `server/public/stocktake/index.html` (`#stFilter`, dòng 78–82; `?v=` dòng 232–233)
- Test: `server/stocktake/stocktakeGrid.test.js`

**Interfaces:**
- Produces: `TKSStocktakeGrid.matchesFilter(row, filter): boolean` — `row` là dòng bảng (`{ forgotten, note: { statusText, printPage } | null }`).

- [ ] **Step 1: Test hỏng** — thêm cuối `server/stocktake/stocktakeGrid.test.js`, và thêm `matchesFilter` vào dòng `require` đầu tệp:

```js
test('matchesFilter: 5 bo loc; note null / chi khoang trang = trong; gia tri la = tat ca', () => {
  const row = (statusText, printPage, forgotten = false) => ({ forgotten, note: statusText === null ? null : { statusText, printPage } });
  const rows = { both: row('mất', '12'), status: row('mất', ''), print: row('  ', '12'), none: row('', ''), noNote: row(null), forgot: row(null, null, true) };
  const pick = filter => Object.keys(rows).filter(key => matchesFilter(rows[key], filter));
  assert.deepEqual(pick('all'), ['both', 'status', 'print', 'none', 'noNote', 'forgot']);
  assert.deepEqual(pick('forgotten'), ['forgot']);
  assert.deepEqual(pick('statusOnly'), ['status']);
  assert.deepEqual(pick('printOnly'), ['print']);
  assert.deepEqual(pick('neither'), ['none', 'noNote', 'forgot']);
  assert.deepEqual(pick('noted'), pick('all'), 'gia tri cu / la = tat ca');
  assert.equal(matchesFilter({ forgotten: false, note: { statusText: 'x', printPage: null } }, 'statusOnly'), true);
});
```

- [ ] **Step 2: Chạy thấy hỏng** — `node --test stocktake/stocktakeGrid.test.js` → FAIL `matchesFilter is not a function`.

- [ ] **Step 3: Code** — trong `stocktakeGrid.js`, trước `return { … }`:

```js
  // Bo loc chinh cua bang. Trang thai / Trang in "co chu" = khac rong sau khi bo khoang trang; mau va Gio in khong tinh.
  function matchesFilter(row, filter) {
    const note = row.note || {};
    const hasStatus = String(note.statusText ?? '').trim() !== '';
    const hasPrint = String(note.printPage ?? '').trim() !== '';
    switch (filter) {
      case 'forgotten': return Boolean(row.forgotten);
      case 'statusOnly': return hasStatus && !hasPrint;
      case 'printOnly': return hasPrint && !hasStatus;
      case 'neither': return !hasStatus && !hasPrint;
      default: return true;
    }
  }
```

và đổi dòng return thành `return { EDIT_COLUMNS, parseClipboard, planPaste, planFill, moveIndex, matchesFilter };`.

- [ ] **Step 4: Chạy thấy đạt** — `node --test stocktake/stocktakeGrid.test.js` → PASS 7/7.

- [ ] **Step 5: Nối vào trang** — trong `visibleRows()` của `stocktake.js`, thay hai dòng

```js
      if (state.filter === 'forgotten' && !row.forgotten) return false;
      if (state.filter === 'noted' && !row.note) return false;
```

bằng

```js
      if (!Grid.matchesFilter(row, state.filter)) return false;
```

Trong `index.html`, thay 3 `<option>` của `#stFilter` bằng:

```html
            <option value="all" selected>Tất cả mã</option>
            <option value="forgotten">Quên KK</option>
            <option value="statusOnly">Chỉ có trạng thái</option>
            <option value="printOnly">Chỉ có trang in</option>
            <option value="neither">Không có cả hai</option>
```

Tăng `?v=`: `stocktakeGrid.js?v=20261103-1` → `?v=20261103-2`; `stocktake.js?v=20261103-3` → `?v=20261103-4`.

- [ ] **Step 6: Kiểm tra** — `node --check public/stocktake/stocktake.js`; `grep -n "'noted'" public/stocktake/stocktake.js` không còn kết quả.

- [ ] **Step 7: Commit**

```bash
git add server/public/stocktake/stocktakeGrid.js server/stocktake/stocktakeGrid.test.js server/public/stocktake/stocktake.js server/public/stocktake/index.html
git commit -m "feat(kiem-ke): bo loc chi co trang thai / chi co trang in / khong co ca hai, bo loc Da ghi chu

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 2: Bỏ "Dán cột" (giao diện + máy chủ)

**Files:**
- Modify: `server/stocktake/stocktakeService.js` (xóa `pasteColumn` ~dòng 614–657; comment `insertPasteHistory` ~659; export dòng 794)
- Modify: `server/stocktake/stocktakeRoutes.js` (xóa route `/paste`, dòng 107–110)
- Modify: `server/public/stocktake/stocktakePaste.js` (xóa `parsePasteText`; comment đầu tệp; export)
- Modify: `server/public/stocktake/stocktake.js` (xóa mục "Dán cột", dòng `stPasteButton` trong `render`, `bindPaste();` trong `init`)
- Modify: `server/public/stocktake/index.html` (nút dòng 85, hộp `#stPasteDialog` dòng 129–150, `?v=`)
- Modify: `server/public/stocktake/stocktake.css` (4 luật dán)
- Test: `server/stocktake/stocktakeService.test.js`, `server/stocktake/stocktakeRoutes.test.js`, `server/stocktake/stocktakePaste.test.js`

**Interfaces:**
- Consumes: `service.saveCells(ctx, sessionId, { cells: [{ code, column, value, expected? }] })` → `{ applied, conflicts, skipped }` (đã có).
- Produces: service không còn `pasteColumn`; router không còn `POST /api/stocktake/sessions/:id/paste`; `TKSStocktakePaste` không còn `parsePasteText`.

- [ ] **Step 1: Chuyển test máy chủ sang `saveCells`** — trong `stocktakeService.test.js`:
  - Xóa nguyên 2 test bắt đầu bằng `test('dan cot: tung loai cot, …` và `test('dan cot: ma lap trong 1 lan dan …` (đến hết `});` của mỗi test).
  - Trong test `'mau trang thai: luu theo ma, mau la bi tu choi, dan cot giu nguyen mau'`: đổi tên thành `'mau trang thai: luu theo ma, mau la bi tu choi, sua tren bang giu nguyen mau'` và thay dòng `await service.pasteColumn(ctx(), session.id, { column: 'statusText', mode: 'skip', rows: [{ code: 'AAA1', value: 'tìm thấy' }] });` bằng `await service.saveCells(ctx(), session.id, { cells: [{ code: 'AAA1', column: 'statusText', value: 'tìm thấy' }] });`.
  - Thêm test mới ngay sau test "mau trang thai":

```js
test('sua tren bang: nguoi kiem lai khop / mo ho / co so khac, combo, cum dung chung, xoa so tay, lich su cum o dot khac', async () => {
  const { db, service, session } = await fixture();
  await db.exec(`INSERT INTO hr_employees (id, branch, ho_ten) VALUES (502, 'hanoi', 'Thái Kho'), (503, 'hanoi', 'Thai Kho'), (504, 'saigon', 'Cận')`);
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });
  const rowNow = async code => rowOf(await service.getBoard(ctx(), session.id), code);

  // Cảnh (501) la nhan su HN duy nhat -> gan id; 'thai kho' trung 2 nhan su sau bo dau -> giu chu; 'Cận' chi co o SG -> giu chu
  await cells([{ code: 'AAA1', column: 'recheck', value: ' cảnh ' }, { code: 'BBB2', column: 'recheck', value: 'thai kho' }, { code: 'CCC3', column: 'recheck', value: 'Cận' }]);
  let a = await rowNow('AAA1');
  assert.deepEqual([a.note.recheckEmployeeId, a.note.recheckName], [501, '']);
  assert.deepEqual([(await rowNow('BBB2')).note.recheckEmployeeId, (await rowNow('BBB2')).note.recheckName], [null, 'thai kho']);
  assert.deepEqual([(await rowNow('CCC3')).note.recheckEmployeeId, (await rowNow('CCC3')).note.recheckName], [null, 'Cận']);

  // combo 'x' -> co, '0' -> khong; cum dung chung 2 ma (khac hoa thuong) -> Count = 2
  await cells([{ code: 'AAA1', column: 'combo', value: 'x' }, { code: 'AAA1', column: 'cluster', value: 'Cụm ấm' }, { code: 'BBB2', column: 'cluster', value: 'cụm ấm' }]);
  assert.equal((await rowNow('AAA1')).isCombo, true);
  assert.equal((await rowNow('BBB2')).clusterCount, 2);
  await cells([{ code: 'AAA1', column: 'combo', value: '0' }]);
  assert.equal((await rowNow('AAA1')).isCombo, false);

  // so dan tay KK truoc sai: ghi roi xoa (trong) -> het "dan tay"
  await cells([{ code: 'AAA1', column: 'prevDiffManual', value: '-1.234' }]);
  a = await rowNow('AAA1');
  assert.deepEqual([a.prevDiff, a.prevDiffManual], [-1234, true]);
  await cells([{ code: 'AAA1', column: 'prevDiffManual', value: '' }]);
  assert.equal((await rowNow('AAA1')).prevDiffManual, false);

  // Cum SP sua o dot nay hien trong lich su cua dot khac cung co so; cot ghi chu thi khong
  await cells([{ code: 'AAA1', column: 'cluster', value: 'Cụm B' }, { code: 'AAA1', column: 'statusText', value: 'sau' }]);
  const other = (await service.createSession(ctx(), { branch: 'hanoi', name: 'Đợt khác', dateFrom: '2026-10-30', dateTo: '2026-10-30' })).session;
  const { history } = await service.codeHistory(ctx(), other.id, 'AAA1');
  assert.ok(history.some(h => h.action === 'paste' && h.after.column === 'cluster' && h.after.cluster === 'Cụm B'));
  assert.ok(!history.some(h => h.action === 'paste' && h.after.column === 'statusText'));
});
```

- [ ] **Step 2: Chạy** — `node --test stocktake/stocktakeService.test.js` → PASS (test mới dùng `saveCells` có sẵn; nếu một assert hỏng, đó là khác biệt hành vi thật giữa `pasteColumn` và `saveCells` — dừng và báo, không sửa assert cho qua).

- [ ] **Step 3: Bỏ máy chủ**
  - `stocktakeService.js`: xóa từ dòng comment `// Dan 1 cot tu sheet theo ma: …` đến hết hàm `pasteColumn` (dòng `}` ngay trước comment `// Lich su dan cot / sua tren bang: …`). Đổi comment đó thành `// Lich su sua tren bang: action 'paste' (co san trong CHECK; truoc day dung cho Dan cot), 1 dong moi (ma, cot).` Trong dòng `return { … }` cuối, bỏ `pasteColumn, `.
  - `stocktakeRoutes.js`: xóa 4 dòng

```js
  // Dan 1 cot tu sheet (Ma + gia tri) - xem truoc lam o trinh duyet, server kiem lai va ghi 1 giao dich.
  router.post('/api/stocktake/sessions/:id/paste', edit, handle(async (req, res) => {
    res.json(await svc().pasteColumn(ctxOf(req), idOf(req), req.body || {}));
  }));
```

  - `stocktakeRoutes.test.js`: bỏ `pasteColumn: record('pasteColumn'), ` khỏi service giả; xóa dòng `assert.equal((await fetch(base + '/sessions/7/paste', …)).status, 200);`; trong mảng kỳ vọng bỏ `['pasteColumn', 7], `; xóa dòng `…'/sessions/7/paste'… .status, 403);`; đổi điều kiện cuối test "Khong co quyen sua" thành `c[0] === 'updateSession' || c[0] === 'saveCells'`. Thêm 1 assert route đã bỏ: ngay sau dòng `/cells` 200, thêm

```js
  assert.equal((await fetch(base + '/sessions/7/paste', { method: 'POST', ...json({ column: 'statusText', rows: [] }) })).status, 404);
```

- [ ] **Step 4: Bỏ `parsePasteText`**
  - `stocktakePaste.js`: xóa comment `// Dong dau la tieu de khi …` và cả hàm `parsePasteText`; bỏ `parsePasteText` khỏi `return { … }`. Đổi 2 dòng comment đầu tệp thành:

```js
/* Gia tri 9 cot nhap tay cua trang Kiem ke (doc so kieu VN, chuan hoa, so sanh, dao nguoc de hoan tac).
   Dung chung trinh duyet (window.TKSStocktakePaste) va server (require) de hai ben hieu giong nhau. */
```

  - `stocktakePaste.test.js`: xóa 4 test `parsePasteText: …` và bỏ `parsePasteText` khỏi `require` dòng 4.

- [ ] **Step 5: Chạy test máy chủ**

`node --test stocktake/stocktakeService.test.js stocktake/stocktakeRoutes.test.js stocktake/stocktakePaste.test.js stocktake/stocktakeGrid.test.js stocktake/stocktakeSearch.test.js stocktake/stocktakeCompute.test.js stocktake/stocktakeSheetImport.test.js db/rollbacks/stocktakeRollback.test.js` → PASS toàn bộ. (Đường dẫn rollback: kiểm `ls server/db/rollbacks/`.)

- [ ] **Step 6: Bỏ giao diện**
  - `stocktake.js`: xóa từ dòng `// ---------- Dán cột ----------` đến hết hàm `bindPaste` (dòng `}` ngay trước `function syncTheme()`); xóa dòng `$('stPasteButton').hidden = !(session && session.status === 'open' && state.canEdit);` trong `render`; xóa dòng `bindPaste();` trong `init`.
  - `index.html`: xóa dòng `<button class="locations-columns-button vt-btn" id="stPasteButton" type="button" hidden>Dán cột</button>` và cả khối `<dialog class="vt-dialog vt-dialog-wide" id="stPasteDialog" …> … </dialog>` (cùng dòng trống thừa). Tăng `?v=`: `stocktakePaste.js` → `20261103-2`, `stocktake.js` → `20261103-5`, `stocktake.css` → `20261103-2`.
  - `stocktake.css`: xóa 4 dòng `.st-paste-mode {…}`, `.st-paste-mode legend {…}`, `.st-paste-preview p {…}`, `#stPasteText {…}`.

- [ ] **Step 7: Kiểm tra sót**

```bash
node --check server/public/stocktake/stocktake.js
grep -rn "stPaste\|pasteColumn\|parsePasteText\|bindPaste\|previewPaste" server --include=*.js --include=*.html --include=*.css | grep -v node_modules
```

Expected: `node --check` OK; grep không còn kết quả.

- [ ] **Step 8: Commit**

```bash
git add server/stocktake server/public/stocktake
git commit -m "refactor(kiem-ke): bo Dan cot (nut, hop dan, API /paste, parsePasteText); kiem lai hanh vi qua /cells

Co-Authored-By: <model> <noreply@anthropic.com>"
```

---

### Task 3: Tiêu đề một dòng, cắt chữ, độ rộng mặc định nhỏ hơn

**Files:**
- Modify: `server/public/stocktake/stocktake.css` (dòng 16 `.st-table{--locations-min-width:1900px}`; thêm khối cuối tệp)
- Modify: `server/public/stocktake/stocktake.js` (`COLUMNS` dòng 12–37; khóa bảng dòng ~301)
- Modify: `server/public/stocktake/index.html` (`?v=`)

- [ ] **Step 1: CSS** — đổi dòng `.st-table{--locations-min-width:1900px}` thành `.st-table{--locations-min-width:0px}` và thêm cuối `stocktake.css`:

```css
/* Tiêu đề và ô một dòng: cột hẹp hơn chữ thì chữ bị cắt ở mép ô (cột bên phải như đè lên, giống Excel),
   không vỡ chữ xuống dòng. Ghi đè table-controls (white-space:normal; overflow-wrap:anywhere) chỉ cho bảng kiểm kê. */
#stTable th,#stTable td{white-space:nowrap !important;overflow:hidden;overflow-wrap:normal !important;text-overflow:clip !important}
#stTable thead th{padding-top:6px;padding-bottom:6px;font-size:11px;line-height:1.3}
#stTable thead th .sort-button,#stTable thead th .sort-button>.sort-label{white-space:nowrap !important;overflow:hidden;overflow-wrap:normal !important;font-size:11px}
#stTable thead th .sort-indicator{flex:none}
```

- [ ] **Step 2: Độ rộng** — trong `COLUMNS` của `stocktake.js` đặt `width` đúng bảng ở Global Constraints (giữ nguyên mọi thuộc tính khác):
  code 96, name 200, counted 84, stock 84, diffQty 84, diffValue 110, status 110, reason 170, printPage 64, printTime 70, recheck 110, prevDiff 84, otherDiff 84, cluster 110, clusterCount 64, clusterDiff 84, prevRatio 72, clusterPrevRatio 84, otherRatio 72, forgotten 64, combo 64, position 110, cost 84, updated 120.
  Đổi `key: 'stocktake-board-v3'` thành `key: 'stocktake-board-v4'`.

- [ ] **Step 3: `?v=`** — `index.html`: `stocktake.css` → `20261103-3`, `stocktake.js` → `20261103-6`.

- [ ] **Step 4: Kiểm tra** — `node --check server/public/stocktake/stocktake.js`; `git diff server/public/stocktake/stocktake.js` chỉ đổi số `width` trong `COLUMNS` và chuỗi khóa `v3`→`v4`.

- [ ] **Step 5: Commit**

```bash
git add server/public/stocktake
git commit -m "style(kiem-ke): tieu de cot 11px mot dong, cat chu o mep o, do rong mac dinh nho hon, khoa bang v4

Co-Authored-By: <model> <noreply@anthropic.com>"
```

- [ ] **Step 6: Kiểm tra trên trình duyệt** (controller, server test dữ liệu thật `stocktake-real-preview` cổng 3989, `/mock/as/ql`, đợt HN mở):
  - Không còn nút "Dán cột"; Ctrl+V trên bảng vẫn dán được.
  - Tiêu đề một dòng; `getComputedStyle(th).whiteSpace === 'nowrap'`; kéo hẹp cột Tên hàng / Chi tiết lý do tới 64px → chữ tiêu đề và ô bị cắt, không xuống dòng, chiều cao hàng không đổi.
  - Bộ lọc: với mỗi giá trị, số mã ở `#stCount` bằng số đếm bằng JS trên `state` (đếm `row.note.statusText`/`printPage` theo đúng định nghĩa) — dùng `fetch('/api/stocktake/sessions/3/board')` để đếm độc lập.
  - Sáng/tối; 375px không tràn ngang trang; console không lỗi.

---

### Task 4: Tài liệu, test toàn bộ, push

**Files:** `README.md`, `server/README.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `CURRENT.md`

- [ ] **Step 1: Tài liệu** (tiếng Việt có dấu, giữ định dạng, cập nhật ngày "Cập nhật" cuối tệp = 03/11/2026):
  - `server/README.md`: trong đoạn API kiểm kê, xóa mô tả `POST /api/stocktake/sessions/:id/paste` (tìm bằng `grep -n "sessions/:id/paste" server/README.md`); thêm câu "(03/11/2026: bỏ `/paste` — dán trên bảng dùng `/cells`)".
  - `docs/02-srs/SRS_Dashboard_GoogleSheets.md`: FR-ST.8 thêm đầu câu "**(Đã thay bằng FR-ST.9 từ 03/11/2026 — bỏ hộp Dán cột.)**"; thêm `FR-ST.10`:

```markdown
- **FR-ST.10 Bộ lọc và tiêu đề bảng (03/11/2026):** bộ lọc chính có 5 lựa chọn: Tất cả mã, Quên KK, Chỉ có trạng thái (Trạng thái có chữ, Trang in trống), Chỉ có trang in (Trang in có chữ, Trạng thái trống), Không có cả hai; màu trạng thái và Giờ in không tính. Tiêu đề và ô bảng một dòng, cột hẹp hơn chữ thì cắt ở mép ô; độ rộng mặc định nhỏ hơn (cấu hình cột lưu trong trình duyệt được đặt lại một lần).
```

  - `README.md`: dòng đầu mục cập nhật gần nhất thêm câu tóm tắt FR-ST.10 + bỏ Dán cột; sửa chỗ nhắc "Dán cột" (`grep -n "Dán cột\|/paste" README.md`) thành ghi chú đã bỏ.
  - `CURRENT.md`: trong mục Kiểm kê dòng 1, trước "**Việc kế tiếp:**", thêm câu "**Cập nhật 03/11/2026 (bộ lọc + tiêu đề, bỏ Dán cột):** …" kèm kết quả Step 2.

- [ ] **Step 2: Test toàn bộ** — từ `server/`: `npm test 2>&1 | tail -40` (≈10 phút, chạy nền nếu cần). Expected: lỗi chỉ nằm trong danh sách có sẵn trên `origin/main` (`vt-positions.test.js` ×3, `account-work-assignment.test.js` ×2, `dashboard-per-view-loading.test.js` ×1, `business-report.test.js` ×3, `auth/adminUserExportService.test.js` ×1, `vt-positions-live.test.js` chập chờn); mọi test `stocktake*` đạt. Khôi phục `server/public/prototypes/order-picking/index.html` nếu bị tạo lại.

- [ ] **Step 3: Đồ thị** — gốc repo: `graphify update .` (hoặc `python -m graphify update .`).

- [ ] **Step 4: Commit + push**

```bash
git add README.md server/README.md docs/02-srs/SRS_Dashboard_GoogleSheets.md CURRENT.md
git ls-files --error-unmatch graphify-out >/dev/null 2>&1 && git add graphify-out
git commit -m "docs(kiem-ke): bo loc moi, tieu de bang gon, bo Dan cot

Co-Authored-By: <model> <noreply@anthropic.com>"
git push origin claude/inventory-feature-analysis-1ab808
```

Expected: PR #28 nhận commit mới.
