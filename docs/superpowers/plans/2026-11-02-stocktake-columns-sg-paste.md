# Kiểm kê: đủ cột T10, Sài Gòn, dán cột — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bảng kiểm kê có đủ 23 cột đúng thứ tự tab "KIỂM KÊ HN T10", sort mọi cột, chạy cho cả Sài Gòn với cột Kiểm SG/HN đối chiếu chéo, dán cột từ sheet theo mã, và web test bằng dữ liệu thật.

**Architecture:** Cột tính thêm (Count, 3 tỷ lệ, L/M ưu tiên số dán tay) nằm trong hàm thuần `stocktakeCompute.deriveColumns`, dùng chung cho đợt mở và đợt đóng. Service thêm đợt đối chiếu (`counterpart_session_id`), 4 trường ghi chú, bản chụp `prev_diff`/`other_diff`, và `pasteColumn` ghi theo lô bằng `jsonb_to_recordset`. Phần hiểu dữ liệu dán là module UMD `public/stocktake/stocktakePaste.js`, trình duyệt và server cùng dùng (tiền lệ: `cashbookRoutes.js` require `public/shared/fuzzy-search.js`).

**Tech Stack:** Node 24, Express, CommonJS, PGlite cho test, `node:test`, ExcelJS, HTML/CSS/JS thuần, `table-controls.js`.

**Spec:** [2026-11-02-stocktake-columns-sg-paste-design.md](../specs/2026-11-02-stocktake-columns-sg-paste-design.md)

## Global Constraints

- Migration `0103` CHƯA áp DB: sửa thẳng `server/db/migrations/0103_stocktake.sql`, không tạo migration mới. Không áp lên DB thật.
- Không push, không mở PR, không đụng `main`. Làm trên nhánh `claude/inventory-feature-analysis-1ab808`.
- DB thật và Google Sheets chỉ ĐỌC (service account scope `spreadsheets.readonly`; script thử chỉ chạy SELECT).
- Số lượng/tiền: `NUMERIC` trong DB. Giờ: `Asia/Ho_Chi_Minh`.
- Node 24: không chạy `node --test <thư mục>`; truyền từng file. Chạy test từ thư mục `server/`.
- Comment trong file `.js` backend viết tiếng Việt KHÔNG dấu (theo code hiện có); chuỗi hiển thị cho người dùng có dấu.
- Tỷ lệ Q/R/S lưu dạng phân số (2.3313 = 233%), trống (`null`) khi mẫu số trống hoặc 0; trong R, L trống tính là 0.
- Khóa cấu hình bảng: `stocktake-board-v2`.
- Tăng `?v=` của `stocktake.js`, `stocktake.css`, thêm `stocktakePaste.js` trong `public/stocktake/index.html` khi đổi.
- Commit message kết thúc bằng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Trách nhiệm |
|---|---|
| `server/db/migrations/0103_stocktake.sql` | Thêm cột: `counterpart_session_id`, 4 cột ghi chú, `prev_diff`/`other_diff`, action `paste`/`session_update` |
| `server/public/stocktake/stocktakePaste.js` (mới) | UMD thuần: `parseVnNumber`, `parseComboFlag`, `foldName`, `parsePasteText`, `PASTE_COLUMNS`, `planPaste` |
| `server/stocktake/stocktakeCompute.js` | `deriveColumns`, `totalsOf`; `buildBoard` nhận `counterpart`, ưu tiên số dán tay; `toResults` thêm `prevDiff`/`otherDiff` |
| `server/stocktake/stocktakeService.js` | Đợt đối chiếu (tạo, `updateSession`), ghi chú 4 trường, M từ đợt đối chiếu, bản chụp, `pasteColumn` |
| `server/stocktake/stocktakeSheetImport.js` | `parseSheet` theo `LAYOUTS` (t10, sg), `importSheet`, nối đối chiếu chéo |
| `server/stocktake/stocktakeRoutes.js` | `PATCH /sessions/:id`, `POST /sessions/:id/paste`, import nhận `source` |
| `server/stocktake/stocktakeExport.js` | 24 cột đúng thứ tự, tên cột M/S theo cơ sở, tỷ lệ `0%` |
| `server/public/stocktake/{index.html, stocktake.js, stocktake.css}` | Cột mới + thứ tự, sort tiêu đề, form ghi chú, đợt đối chiếu, dán cột, nút nạp SG |
| scratchpad `stocktake-real-preview.js` | Web test: PGlite + dữ liệu chép từ DB thật + nạp 2 tab sheet |

---

### Task 1: Module hiểu dữ liệu dán (`stocktakePaste.js`)

**Files:**
- Create: `server/public/stocktake/stocktakePaste.js`
- Test: `server/stocktake/stocktakePaste.test.js`

**Interfaces:**
- Produces (dùng ở Task 4 và Task 7):
  - `parseVnNumber(text: string|number) -> number|null` — `null` khi không đọc được hoặc rỗng.
  - `parseComboFlag(text) -> boolean`.
  - `foldName(text) -> string` (bỏ dấu, `đ`→`d`, thường, gộp khoảng trắng).
  - `PASTE_COLUMNS: { [key]: { label, kind: 'text'|'number'|'combo'|'recheck', max? } }` với key `statusText, reasonText, printPage, printTime, recheck, cluster, combo, prevDiffManual, otherDiffManual`.
  - `parsePasteText(text, { isKnownCode(code) -> bool, column }) -> { rows: [{code, value}], duplicates: number }` — `value` là chuỗi gốc đã cắt khoảng trắng.
  - `normalizeValue(column, raw) -> { ok: true, value, empty: bool } | { ok: false }` — `value` theo kiểu cột: chuỗi / số / boolean / chuỗi tên.

- [ ] **Step 1: Viết test lỗi**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVnNumber, parseComboFlag, foldName, parsePasteText, normalizeValue, PASTE_COLUMNS } = require('../public/stocktake/stocktakePaste');

test('parseVnNumber: kieu VN, kieu thuong, rong / chu', () => {
  assert.equal(parseVnNumber('1.234'), 1234);
  assert.equal(parseVnNumber('-1.234.567'), -1234567);
  assert.equal(parseVnNumber('-1,5'), -1.5);
  assert.equal(parseVnNumber('1234'), 1234);
  assert.equal(parseVnNumber('12.5'), 12.5, 'mot dau cham, khong du 3 so sau -> thap phan');
  assert.equal(parseVnNumber(' -326 '), -326);
  assert.equal(parseVnNumber(42), 42);
  assert.equal(parseVnNumber(''), null);
  assert.equal(parseVnNumber('abc'), null);
  assert.equal(parseVnNumber('#DIV/0!'), null);
});

test('parseComboFlag + foldName', () => {
  for (const yes of ['x', 'X', 'TRUE', 'true', '1', 'có', 'Co']) assert.equal(parseComboFlag(yes), true, yes);
  for (const no of ['', '0', 'false', 'không']) assert.equal(parseComboFlag(no), false, no);
  assert.equal(foldName('  Thái   KHO '), 'thai kho');
  assert.equal(foldName('Đông'), 'dong');
});

test('parsePasteText: tab, bo tieu de, bo dong trong, ma lap lay dong cuoi', () => {
  const known = new Set(['LUMI3M', 'LUMI3T']);
  const text = 'Mã SP\tKK Trước Sai\r\nlumi3m\t-326\n\n LUMI3T \t-170\nLUMI3M\t-300\n';
  const { rows, duplicates } = parsePasteText(text, { isKnownCode: code => known.has(code), column: 'prevDiffManual' });
  assert.deepEqual(rows, [{ code: 'LUMI3T', value: '-170' }, { code: 'LUMI3M', value: '-300' }]);
  assert.equal(duplicates, 1);
});

test('parsePasteText: dong dau la du lieu that thi giu', () => {
  const { rows } = parsePasteText('LUMI3M\tmất ko thấy', { isKnownCode: () => true, column: 'statusText' });
  assert.deepEqual(rows, [{ code: 'LUMI3M', value: 'mất ko thấy' }]);
});

test('normalizeValue theo kieu cot', () => {
  assert.deepEqual(normalizeValue('prevDiffManual', '-1.234'), { ok: true, value: -1234, empty: false });
  assert.deepEqual(normalizeValue('prevDiffManual', ''), { ok: true, value: null, empty: true });
  assert.deepEqual(normalizeValue('prevDiffManual', 'abc'), { ok: false });
  assert.deepEqual(normalizeValue('combo', 'x'), { ok: true, value: true, empty: false });
  assert.deepEqual(normalizeValue('combo', ''), { ok: true, value: false, empty: true });
  assert.deepEqual(normalizeValue('printPage', 'a'.repeat(51)), { ok: false });
  assert.deepEqual(normalizeValue('statusText', '  ok  '), { ok: true, value: 'ok', empty: false });
  assert.deepEqual(normalizeValue('recheck', 'THÁI KHO'), { ok: true, value: 'THÁI KHO', empty: false });
  assert.equal(PASTE_COLUMNS.reasonText.max, 1000);
});
```

- [ ] **Step 2: Chạy test, phải lỗi**

Run: `node --test stocktake/stocktakePaste.test.js`
Expected: FAIL `Cannot find module '../public/stocktake/stocktakePaste'`

- [ ] **Step 3: Viết module**

```js
/* Hieu du lieu dan tu Google Sheets cho trang Kiem ke (2 cot: Ma SP + gia tri, cach nhau bang tab).
   Dung chung trinh duyet (window.TKSStocktakePaste) va server (require) de hai ben hieu giong nhau. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakePaste = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PASTE_COLUMNS = Object.freeze({
    statusText: { label: 'Trạng thái', kind: 'text', max: 200 },
    reasonText: { label: 'Chi tiết lý do', kind: 'text', max: 1000 },
    printPage: { label: 'Trang in', kind: 'text', max: 50 },
    printTime: { label: 'Giờ in', kind: 'text', max: 50 },
    recheck: { label: 'Người kiểm lại', kind: 'recheck', max: 200 },
    cluster: { label: 'Cụm SP', kind: 'text', max: 200 },
    combo: { label: 'Combo', kind: 'combo' },
    prevDiffManual: { label: 'KK trước sai', kind: 'number' },
    otherDiffManual: { label: 'Kiểm SG / Kiểm HN', kind: 'number' }
  });
  const MAX_ABS = 1e12;
  const COMBO_YES = new Set(['x', 'true', '1', 'co']);

  const codeKey = value => String(value ?? '').replace(/\s+/gu, '').toUpperCase();
  const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
  const foldName = value => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/gu, '').replace(/[đĐ]/gu, 'd').toLowerCase();

  // "1.234" / "-1.234.567" (cham hang nghin), "-1,5" (phay thap phan), "1234", "12.5".
  function parseVnNumber(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let text = String(value ?? '').replace(/\s+/gu, '');
    if (!text) return null;
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/u.test(text)) text = text.replace(/\./gu, '').replace(',', '.');
    else if (/^-?\d+,\d+$/u.test(text)) text = text.replace(',', '.');
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/u.test(text)) text = text.replace(/,/gu, '');
    if (!/^-?\d+(\.\d+)?$/u.test(text)) return null;
    const n = Number(text);
    return Number.isFinite(n) && Math.abs(n) <= MAX_ABS ? n : null;
  }

  const parseComboFlag = value => COMBO_YES.has(foldName(value));

  function normalizeValue(column, raw) {
    const spec = PASTE_COLUMNS[column];
    if (!spec) return { ok: false };
    const text = clean(raw);
    if (spec.kind === 'number') {
      if (!text) return { ok: true, value: null, empty: true };
      const n = parseVnNumber(text);
      return n === null ? { ok: false } : { ok: true, value: n, empty: false };
    }
    if (spec.kind === 'combo') return { ok: true, value: parseComboFlag(text), empty: !text };
    if (spec.max && text.length > spec.max) return { ok: false };
    return { ok: true, value: text, empty: !text };
  }

  // Dong dau la tieu de khi o ma khong phai ma da biet VA o gia tri khong hop le voi cot dich.
  function parsePasteText(text, { isKnownCode = () => true, column } = {}) {
    const lines = String(text ?? '').split(/\r?\n/u);
    const byCode = new Map();
    let duplicates = 0;
    lines.forEach((line, index) => {
      if (!line.trim()) return;
      const cells = line.split('\t');
      const code = codeKey(cells[0]);
      const value = clean(cells.slice(1).join(' '));
      if (!code) return;
      if (index === 0 && !isKnownCode(code)) {
        const check = normalizeValue(column, value);
        if (!check.ok || PASTE_COLUMNS[column].kind !== 'number') return;
      }
      if (byCode.has(code)) { duplicates += 1; byCode.delete(code); }
      byCode.set(code, value);
    });
    return { rows: [...byCode].map(([code, value]) => ({ code, value })), duplicates };
  }

  return { PASTE_COLUMNS, codeKey, foldName, parseVnNumber, parseComboFlag, normalizeValue, parsePasteText };
});
```

Mã lặp: `byCode.delete` rồi `set` nên dòng cuối thắng và mã đó xuống cuối danh sách (đúng kỳ vọng test).

Dòng tiêu đề với cột chữ (ví dụ `Mã SP\tTrạng thái`): ô mã "MÃSP" không phải mã đã biết, cột chữ thì giá trị nào cũng hợp lệ, nên dòng đầu bị bỏ (nhánh `kind !== 'number'` trả về). Với cột số, dòng đầu chỉ bị bỏ khi giá trị cũng không đọc được.

- [ ] **Step 4: Chạy test, phải qua**

Run: `node --test stocktake/stocktakePaste.test.js`
Expected: PASS 5 tests

- [ ] **Step 5: Commit**

```bash
git add server/public/stocktake/stocktakePaste.js server/stocktake/stocktakePaste.test.js
git commit -m "feat(stocktake): module hieu du lieu dan cot tu sheet

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Cột tính thêm trong `stocktakeCompute`

**Files:**
- Modify: `server/stocktake/stocktakeCompute.js`
- Test: `server/stocktake/stocktakeCompute.test.js`

**Interfaces:**
- Consumes: không.
- Produces:
  - `deriveColumns(rows) -> rows` (sửa tại chỗ và trả lại). Đọc `diffQty, cluster, prevDiff, otherDiff`; ghi `clusterCount, clusterDiff, prevRatio, clusterPrevRatio, otherRatio`.
  - `totalsOf(rows) -> { codes, mismatched, forgotten, diffValue }`.
  - `buildBoard({ ..., previous, counterpart })`: `counterpart: [{ code, diffQty }]`. Mỗi dòng thêm `prevDiffAuto, prevDiffManual (bool), otherDiff, otherDiffAuto, otherDiffManual (bool)` cùng các cột của `deriveColumns`.
  - Ghi chú (`note`) có thể có `prevDiffManual: number|null`, `otherDiffManual: number|null`, `printPage`, `printTime`.
  - `toResults(board)` thêm `prevDiff, otherDiff`.
  - `ratio(numerator, denominator) -> number|null`.

- [ ] **Step 1: Thêm test lỗi** (cuối `stocktakeCompute.test.js`)

```js
test('deriveColumns: Count, chenh cum, 3 ty le; mau so 0 / trong -> null', () => {
  const rows = deriveColumns([
    { code: 'A', diffQty: -434, cluster: 'Tủ LUMI3', prevDiff: -326, otherDiff: null },
    { code: 'B', diffQty: 45, cluster: 'tủ lumi3 ', prevDiff: null, otherDiff: 0 },
    { code: 'C', diffQty: -5, cluster: '', prevDiff: 0, otherDiff: -10 }
  ]);
  const [a, b, c] = rows;
  assert.equal(a.clusterCount, 2);
  assert.equal(a.clusterDiff, -389);
  assert.equal(a.prevRatio, 2.3313, '(E+L)/L = (-434-326)/-326');
  assert.equal(a.clusterPrevRatio, 1.838, '(-389 + -326) / -389, L trong tinh 0');
  assert.equal(b.clusterPrevRatio, 1.838);
  assert.equal(b.prevRatio, null, 'L trong');
  assert.equal(b.otherRatio, null, 'M = 0');
  assert.equal(c.clusterCount, null);
  assert.equal(c.clusterDiff, null);
  assert.equal(c.clusterPrevRatio, null);
  assert.equal(c.prevRatio, null, 'L = 0');
  assert.equal(c.otherRatio, 1.5, '(-5 + -10) / -10');
});

test('buildBoard: so dan tay uu tien hon so tu lay cho L va M', () => {
  const { rows } = buildBoard({
    products: [{ code: 'A', name: 'A', stock: 10, cost: 1 }, { code: 'B', name: 'B', stock: 3, cost: 1 }],
    previous: [{ code: 'A', diffQty: -2 }, { code: 'B', diffQty: -1 }],
    counterpart: [{ code: 'A', diffQty: 4 }],
    notes: [{ code: 'B', prevDiffManual: -7, otherDiffManual: 5, statusText: '', reasonText: '', version: 1 }]
  });
  const byCode = Object.fromEntries(rows.map(r => [r.code, r]));
  assert.deepEqual([byCode.A.prevDiff, byCode.A.prevDiffManual, byCode.A.otherDiff], [-2, false, 4]);
  assert.deepEqual([byCode.B.prevDiff, byCode.B.prevDiffAuto, byCode.B.prevDiffManual], [-7, -1, true]);
  assert.deepEqual([byCode.B.otherDiff, byCode.B.otherDiffAuto, byCode.B.otherDiffManual], [5, null, true]);
  const results = toResults({ rows });
  assert.deepEqual(results.find(r => r.code === 'B').prevDiff, -7);
  assert.deepEqual(results.find(r => r.code === 'B').otherDiff, 5);
});
```

Sửa dòng require đầu file test thành:
`const { codeKey, applyLineEdits, buildBoard, toResults, deriveColumns } = require('./stocktakeCompute');`

- [ ] **Step 2: Chạy test, phải lỗi**

Run: `node --test stocktake/stocktakeCompute.test.js`
Expected: FAIL `deriveColumns is not a function`

- [ ] **Step 3: Sửa `stocktakeCompute.js`**

Thêm sau `editKey`:

```js
// Ty le kieu cot "Do KK truoc" cua sheet: tra phan so lam tron 4 so (2.3313 = 233%); mau so trong/0 -> null (sheet ra #DIV/0!).
const ratio = (numerator, denominator) => (
  denominator === null || denominator === undefined || denominator === 0 || numerator === null || numerator === undefined
    ? null : Math.round((numerator / denominator) * 10000) / 10000);
const manualOf = value => (value === null || value === undefined || value === '' ? null : num(value));
const clusterKeyOf = cluster => String(cluster || '').trim().toUpperCase();

/**
 * Cot tinh them giong tab T10: Count (O), Chenh cum (P), Do KK truoc (Q), Lan + KK truoc (R), Do kiem SG/HN (S).
 * rows: [{ diffQty, cluster, prevDiff, otherDiff }] — sua tai cho.
 */
function deriveColumns(rows) {
  const clusters = new Map();
  for (const row of rows) {
    const key = clusterKeyOf(row.cluster);
    if (!key) continue;
    const sum = clusters.get(key) || { count: 0, diff: 0, prev: 0 };
    sum.count += 1;
    sum.diff = round(sum.diff + num(row.diffQty));
    sum.prev = round(sum.prev + num(row.prevDiff));
    clusters.set(key, sum);
  }
  for (const row of rows) {
    const sum = clusters.get(clusterKeyOf(row.cluster));
    row.clusterCount = sum ? sum.count : null;
    row.clusterDiff = sum ? sum.diff : null;
    row.clusterPrevRatio = sum ? ratio(round(sum.diff + sum.prev), sum.diff) : null;
    row.prevRatio = row.prevDiff === null || row.prevDiff === undefined ? null : ratio(round(row.diffQty + row.prevDiff), row.prevDiff);
    row.otherRatio = row.otherDiff === null || row.otherDiff === undefined ? null : ratio(round(row.diffQty + row.otherDiff), row.otherDiff);
  }
  return rows;
}

function totalsOf(rows) {
  return rows.reduce((sum, row) => {
    sum.codes += 1;
    if (row.diffQty !== 0) sum.mismatched += 1;
    if (row.forgotten) sum.forgotten += 1;
    sum.diffValue += row.diffValue;
    return sum;
  }, { codes: 0, mismatched: 0, forgotten: 0, diffValue: 0 });
}
```

Trong `buildBoard`: chữ ký thành `function buildBoard({ lines = [], edits = [], products = [], positions = [], tags = [], notes = [], previous = [], counterpart = [] } = {})`; thêm sau `previousByCode`:

```js
  const counterpartByCode = new Map(counterpart.map(item => [codeKey(item.code), num(item.diffQty)]));
```

Trong `rows.map`, thay dòng `prevDiff: ...` bằng:

```js
      ...pickDiffs(noteByCode.get(row.code), previousByCode.get(row.code), counterpartByCode.get(row.code)),
```

và thêm hàm (ngoài `buildBoard`, trước nó):

```js
// L (KK truoc sai) va M (Kiem SG/HN): so dan tay tren ghi chu ma uu tien hon so tu lay.
function pickDiffs(note, prevAuto, otherAuto) {
  const prevManual = manualOf(note && note.prevDiffManual);
  const otherManual = manualOf(note && note.otherDiffManual);
  const auto = value => (value === undefined ? null : value);
  return {
    prevDiff: prevManual !== null ? prevManual : auto(prevAuto),
    prevDiffAuto: auto(prevAuto),
    prevDiffManual: prevManual !== null,
    otherDiff: otherManual !== null ? otherManual : auto(otherAuto),
    otherDiffAuto: auto(otherAuto),
    otherDiffManual: otherManual !== null
  };
}
```

Bỏ trường `clusterDiff: null,` trong object dòng (deriveColumns ghi). Thay khối "Ma bi lan gom thanh Cum SP…" cùng hai vòng `clusterSum` và khối `totals` bằng:

```js
  deriveColumns(rows);
  rows.sort((a, b) => a.code.localeCompare(b.code));
  return { rows, totals: totalsOf(rows) };
```

`toResults`:

```js
const toResults = board => board.rows.map(row => ({
  code: row.code, name: row.name, counted: row.counted, stock: row.stock, cost: row.cost, diffQty: row.diffQty, diffValue: row.diffValue,
  prevDiff: row.prevDiff, otherDiff: row.otherDiff
}));
```

Export: `module.exports = { codeKey, applyLineEdits, buildBoard, toResults, deriveColumns, totalsOf, pickDiffs, ratio };`
Cập nhật comment JSDoc của `buildBoard`: thêm dòng `counterpart: [{ code, diffQty }] — SL chenh cua dot doi chieu (co so kia).`

- [ ] **Step 4: Chạy test, phải qua**

Run: `node --test stocktake/stocktakeCompute.test.js`
Expected: PASS 10 tests (8 cũ + 2 mới)

- [ ] **Step 5: Commit**

```bash
git add server/stocktake/stocktakeCompute.js server/stocktake/stocktakeCompute.test.js
git commit -m "feat(stocktake): Count, 3 ty le va uu tien so dan tay trong bang doi chieu

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Schema + service: đợt đối chiếu, ghi chú 4 trường, bản chụp

**Files:**
- Modify: `server/db/migrations/0103_stocktake.sql`
- Modify: `server/stocktake/stocktakeService.js`
- Test: `server/stocktake/stocktakeService.test.js`

**Interfaces:**
- Consumes: `buildBoard`, `deriveColumns`, `totalsOf`, `toResults`, `pickDiffs` (Task 2).
- Produces:
  - `shapeSession(row)` thêm `counterpartSessionId: number|null`.
  - `createSession(ctx, { ..., counterpartSessionId })`; 400 `INVALID_COUNTERPART` khi đợt không tồn tại hoặc cùng cơ sở.
  - `updateSession(ctx, id, { counterpartSessionId, version }) -> { session }` (chỉ đợt mở, khóa version, history `session_update`).
  - `saveNote` nhận thêm `printPage`, `printTime` (chữ ≤ 50), `prevDiffManual`, `otherDiffManual` (số hoặc `null`).
  - `shapeNote` thêm `printPage, printTime, prevDiffManual, otherDiffManual`.
  - `getBoard` trả thêm `counterpart: { id, name, branch, status } | null` và mỗi dòng có cột Task 2.
  - `loadInputs(db, session, { fresh, withCounterpart = true })`.

- [ ] **Step 1: Sửa migration `0103`**

Trong `stocktake_sessions`, sau dòng `source_ref TEXT,`:
```sql
  -- Dot cua co so kia de doi chieu cot "Kiem SG" / "Kiem HN" (SL chenh cung ma o dot do).
  counterpart_session_id BIGINT REFERENCES stocktake_sessions (id) ON DELETE SET NULL,
```
Trong `stocktake_code_notes`, sau `recheck_name ...`:
```sql
  print_page          TEXT        NOT NULL DEFAULT '',
  print_time          TEXT        NOT NULL DEFAULT '',
  -- So dan tay de len so tu lay: KK truoc sai (L) va Kiem SG/HN (M). NULL = dung so tu lay.
  prev_diff_manual    NUMERIC,
  other_diff_manual   NUMERIC,
```
Trong `stocktake_session_results`, sau `diff_value ...,`:
```sql
  prev_diff    NUMERIC,
  other_diff   NUMERIC,
```
Action check của `stocktake_history`:
```sql
  action        TEXT        NOT NULL CHECK (action IN ('session_create', 'session_update', 'session_close', 'sheet_import', 'line_edit', 'line_add', 'note', 'tag', 'paste')),
```

- [ ] **Step 2: Viết test lỗi** (thêm vào `stocktakeService.test.js`; fixture thêm sản phẩm SG)

Trong `fixture()`, thêm vào khối `INSERT INTO products`:
```sql
      ('saigon', 1, 'AAA1', 'Hàng A', '{"inventories":[{"onHand":7,"cost":1000}]}'),
```
và thêm khách + đơn SG:
```sql
    INSERT INTO customers (branch, id, code, name, raw) VALUES ('saigon', 21, 'KS1', 'TEAM 2 : SG', '{}');
    INSERT INTO orders (branch, id, code, order_date, customer_id, raw) VALUES ('saigon', 201, 'DS201', '2026-10-29 09:00+07', 21, '{}');
    INSERT INTO order_details (branch, order_id, line_no, product_id, quantity, raw) VALUES ('saigon', 201, 1, 1, 4, '{"productCode":"AAA1","quantity":4}');
```

Test mới:
```js
test('dot doi chieu: Kiem SG tu dot SG dang mo / da dong, sai co so bi tu choi, doi bang PATCH', async () => {
  const { service, session } = await fixture();
  await assert.rejects(service.createSession(ctx(), { branch: 'hanoi', name: 'x', dateFrom: '2026-10-29', dateTo: '2026-10-29', counterpartSessionId: session.id }),
    { statusCode: 400, code: 'INVALID_COUNTERPART' });
  const { session: sg } = await service.createSession(ctx(), { branch: 'saigon', name: 'SG 29/10', dateFrom: '2026-10-29', dateTo: '2026-10-29', counterpartSessionId: session.id });
  assert.equal(sg.counterpartSessionId, session.id);
  const { session: hn } = await service.updateSession(ctx(), session.id, { counterpartSessionId: sg.id, version: session.version });
  assert.equal(hn.counterpartSessionId, sg.id);
  assert.equal(hn.version, session.version + 1);
  await assert.rejects(service.updateSession(ctx(), session.id, { counterpartSessionId: null, version: session.version }), { statusCode: 409 });

  let board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').otherDiff, -3, 'SG: dem 4, ton 7');
  assert.equal(rowOf(board, 'AAA1').otherRatio, ratioOf(2 + -3, -3));
  assert.deepEqual(board.counterpart, { id: sg.id, name: 'SG 29/10', branch: 'saigon', status: 'open' });

  await service.closeSession(ctx(), sg.id, { version: sg.version });
  board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').otherDiff, -3, 'tu ban chup dot SG');
});

test('ghi chu: trang in, gio in, so dan tay L/M; dong dot luu prev_diff / other_diff', async () => {
  const { db, service, session } = await fixture();
  const { note } = await service.saveNote(ctx(), session.id, 'AAA1', { printPage: '12', printTime: '14:30 03/10', prevDiffManual: -326, otherDiffManual: '-1,5' });
  assert.deepEqual([note.printPage, note.printTime, note.prevDiffManual, note.otherDiffManual], ['12', '14:30 03/10', -326, -1.5]);
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { printPage: 'x'.repeat(51), version: note.version }), { statusCode: 400 });
  await assert.rejects(service.saveNote(ctx(), session.id, 'AAA1', { prevDiffManual: 'abc', version: note.version }), { statusCode: 400 });
  let board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').prevDiff, rowOf(board, 'AAA1').prevDiffManual], [-326, true]);

  const fresh = await service.getBoard(ctx(), session.id);
  await service.closeSession(ctx(), session.id, { version: fresh.session.version });
  const stored = (await db.query(`SELECT prev_diff::float8 AS p, other_diff::float8 AS o FROM stocktake_session_results WHERE product_code = 'AAA1'`)).rows[0];
  assert.deepEqual([stored.p, stored.o], [-326, -1.5]);
  board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').prevDiff, rowOf(board, 'AAA1').otherDiff], [-326, -1.5]);
  assert.equal(rowOf(board, 'AAA1').prevRatio, ratioOf(2 + -326, -326));
});
```
Thêm helper đầu file: `const ratioOf = (a, b) => Math.round((a / b) * 10000) / 10000;`

- [ ] **Step 3: Chạy test, phải lỗi**

Run: `node --test stocktake/stocktakeService.test.js`
Expected: FAIL (`updateSession is not a function` / `INVALID_COUNTERPART` không ném)

- [ ] **Step 4: Sửa service**

Đầu file: `const { codeKey, buildBoard, toResults, deriveColumns, totalsOf, pickDiffs } = require('./stocktakeCompute');`
`const { parseVnNumber, foldName } = require('../public/stocktake/stocktakePaste');` (Task 4 dùng `foldName`).
`const MAX = Object.freeze({ name: 120, text: 200, note: 1000, print: 50 });`

Hằng cột:
```js
const SESSION_COLUMNS = `id, branch, name, date_from, date_to, status, source, version, counterpart_session_id, created_by_name, created_at, closed_by_name, closed_at`;
const NOTE_COLUMNS = `product_code, status_text, reason_text, recheck_employee_id, recheck_name, print_page, print_time,
  prev_diff_manual::float8 AS prev_diff_manual, other_diff_manual::float8 AS other_diff_manual, version, updated_by_name, updated_at`;
```
`shapeSession` thêm `counterpartSessionId: row.counterpart_session_id === null || row.counterpart_session_id === undefined ? null : Number(row.counterpart_session_id),`.
`shapeNote` thêm:
```js
  printPage: row.print_page || '',
  printTime: row.print_time || '',
  prevDiffManual: row.prev_diff_manual === null || row.prev_diff_manual === undefined ? null : Number(row.prev_diff_manual),
  otherDiffManual: row.other_diff_manual === null || row.other_diff_manual === undefined ? null : Number(row.other_diff_manual),
```

Hàm đọc số chênh (sau `quantityOf`):
```js
// So chenh dan tay (co the am, le). '' / null = xoa (dung so tu lay).
function diffOf(value, field) {
  if (value === null || value === '') return null;
  const n = parseVnNumber(value);
  if (n === null || Math.abs(n) > MAX_QUANTITY) throw fail(400, 'VALIDATION', 'Số chênh phải là số.', { field });
  return n;
}
```

Trong factory, thêm:
```js
  // Dot doi chieu phai thuoc co so kia; null = bo doi chieu.
  async function counterpartOf(db, branch, value) {
    if (value === undefined || value === null || value === '') return null;
    const id = Number(value);
    const row = Number.isInteger(id) ? (await db.query('SELECT id, branch FROM stocktake_sessions WHERE id = $1', [id])).rows[0] : null;
    if (!row || row.branch === branch) throw fail(400, 'INVALID_COUNTERPART', 'Đợt đối chiếu phải là một đợt của cơ sở kia.', { field: 'counterpartSessionId' });
    return id;
  }

  // SL chenh tung ma cua dot doi chieu: da dong -> ban chup, dang mo -> tinh truc tiep (khong lay tiep doi chieu cua no).
  async function counterpartResults(db, session) {
    if (!session.counterpartSessionId) return { counterpartInfo: null, counterpart: [] };
    const row = (await db.query(`SELECT ${SESSION_COLUMNS} FROM stocktake_sessions WHERE id = $1`, [session.counterpartSessionId])).rows[0];
    if (!row) return { counterpartInfo: null, counterpart: [] };
    const other = shapeSession(row);
    const counterpartInfo = { id: other.id, name: other.name, branch: other.branch, status: other.status };
    if (other.status === 'closed') {
      const { rows } = await db.query(`SELECT product_code, diff_qty::float8 AS diff_qty FROM stocktake_session_results WHERE session_id = $1`, [other.id]);
      return { counterpartInfo, counterpart: rows.map(r => ({ code: r.product_code, diffQty: Number(r.diff_qty) })) };
    }
    const board = buildBoard(await loadInputs(db, other, { withCounterpart: false }));
    return { counterpartInfo, counterpart: board.rows.map(r => ({ code: r.code, diffQty: r.diffQty })) };
  }
```

`createSession`: sau validate ngày, trong transaction trước INSERT: `const counterpartId = await counterpartOf(client, branch, body.counterpartSessionId);` và INSERT thêm cột `counterpart_session_id` = `$7`; history `after` thêm `counterpartSessionId: counterpartId`.

`updateSession` (thêm sau `createSession`):
```js
  async function updateSession(ctx, sessionId, body = {}) {
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      if (versionOf(body.version) !== session.version) throw fail(409, 'STOCKTAKE_CONFLICT', 'Đợt kiểm kê vừa được cập nhật. Tải lại rồi thử lại.', { latest: session });
      const counterpartId = await counterpartOf(client, session.branch, body.counterpartSessionId);
      const { rows } = await client.query(
        `UPDATE stocktake_sessions SET counterpart_session_id = $2, version = version + 1 WHERE id = $1 RETURNING ${SESSION_COLUMNS}`,
        [session.id, counterpartId]);
      const updated = shapeSession(rows[0]);
      await writeHistory(client, updated, actor, '', 'session_update', { counterpartSessionId: session.counterpartSessionId }, { counterpartSessionId: counterpartId });
      return { session: updated };
    }, sessionId);
  }
```

`loadInputs(db, session, { fresh = false, withCounterpart = true } = {})`: thêm vào `Promise.all` phần tử cuối `withCounterpart ? counterpartResults(db, session) : { counterpartInfo: null, counterpart: [] }` và trả `{ lines, edits, products, positions, tags, notes, ...prev, ...other }` (đặt tên biến `other`).

`closedBoard`: SELECT thêm `prev_diff::float8 AS prev_diff, other_diff::float8 AS other_diff`; `Promise.all` thêm `counterpartResults(db, session)`; dựng dòng:
```js
    const otherByCode = new Map(other.counterpart.map(item => [item.code, item.diffQty]));
    const rows = results.map(row => {
      const tag = tagByCode.get(row.product_code);
      const note = noteByCode.get(row.product_code) || null;
      // Ban chup luu L/M luc dong; dot nap tu sheet chua co M -> lay tu dot doi chieu.
      const prevStored = row.prev_diff === null ? (prevByCode.has(row.product_code) ? prevByCode.get(row.product_code) : null) : Number(row.prev_diff);
      const otherStored = row.other_diff === null ? (otherByCode.has(row.product_code) ? otherByCode.get(row.product_code) : null) : Number(row.other_diff);
      return {
        code: row.product_code, name: row.name, inKiot: true, counted: Number(row.counted), stock: Number(row.stock), cost: Number(row.cost),
        diffQty: Number(row.diff_qty), diffValue: Number(row.diff_value), forgotten: Number(row.counted) === 0 && Number(row.stock) !== 0,
        cluster: (tag && tag.cluster) || '', isCombo: Boolean(tag && tag.isCombo), tagVersion: tag ? tag.version : null,
        prevDiff: prevStored, prevDiffAuto: prevStored, prevDiffManual: Boolean(note && note.prevDiffManual !== null),
        otherDiff: otherStored, otherDiffAuto: otherStored, otherDiffManual: Boolean(note && note.otherDiffManual !== null),
        latestPosition: positionByCode.get(row.product_code) || null, note, lines: []
      };
    });
    deriveColumns(rows);
    return { rows, totals: totalsOf(rows), previousSessionId: prev.previousSessionId, counterpart: other.counterpartInfo };
```
Xóa hai vòng `clusterSum` và khối `totals` cũ trong `closedBoard`. Đợt đóng cũng hiện vị trí kho: thêm vào `Promise.all` `cached('positions:' + session.branch, …)` giống `loadInputs` (tách thành hàm `loadPositions(db, branch)` dùng chung) và `positionByCode` lấy dòng đầu mỗi mã: `{ location, arrivalDate }`.

`getBoard`: nhánh mở thành `loadInputs(db, session).then(inputs => ({ ...buildBoard(inputs), previousSessionId: inputs.previousSessionId, counterpart: inputs.counterpartInfo }))`.

`saveNote`: thêm sau `reasonText`:
```js
      const printPage = body.printPage === undefined ? (before ? before.printPage : '') : textOf(body, 'printPage', 'Trang in', MAX.print);
      const printTime = body.printTime === undefined ? (before ? before.printTime : '') : textOf(body, 'printTime', 'Giờ in', MAX.print);
      const prevDiffManual = body.prevDiffManual === undefined ? (before ? before.prevDiffManual : null) : diffOf(body.prevDiffManual, 'prevDiffManual');
      const otherDiffManual = body.otherDiffManual === undefined ? (before ? before.otherDiffManual : null) : diffOf(body.otherDiffManual, 'otherDiffManual');
```
INSERT/UPSERT thêm 4 cột (`$8..$11`) và `EXCLUDED.*` tương ứng; tham số thêm `printPage, printTime, prevDiffManual, otherDiffManual`.
Lưu ý `textOf` trả lỗi khi > max; với `diffOf` `body.prevDiffManual` có thể là số → `parseVnNumber` nhận số.

`closeSession`: INSERT kết quả thêm `prev_diff, other_diff`:
```js
          `INSERT INTO stocktake_session_results (session_id, product_code, name, counted, stock, cost, diff_qty, diff_value, prev_diff, other_diff)
           SELECT $1, r.code, r.name, r.counted, r.stock, r.cost, r.diff_qty, r.diff_value, r.prev_diff, r.other_diff
           FROM jsonb_to_recordset($2::jsonb) AS r(code text, name text, counted numeric, stock numeric, cost numeric, diff_qty numeric, diff_value numeric, prev_diff numeric, other_diff numeric)`,
          [session.id, JSON.stringify(results.map(r => ({ code: r.code, name: r.name || '', counted: r.counted, stock: r.stock, cost: r.cost,
            diff_qty: r.diffQty, diff_value: r.diffValue, prev_diff: r.prevDiff, other_diff: r.otherDiff })))]);
```

`return` của factory thêm `updateSession`. Bỏ import `pickDiffs` nếu không dùng trong service.

- [ ] **Step 5: Chạy test, phải qua**

Run: `node --test stocktake/stocktakeService.test.js stocktake/stocktakeCompute.test.js stocktake/stocktakeSheetImport.test.js`
Expected: PASS hết (service 10, compute 10, import 2)

- [ ] **Step 6: Commit**

```bash
git add server/db/migrations/0103_stocktake.sql server/stocktake/stocktakeService.js server/stocktake/stocktakeService.test.js
git commit -m "feat(stocktake): dot doi chieu co so kia, trang/gio in, so dan tay L/M, ban chup prev/other diff

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Dán cột (`pasteColumn`) + routes mới

**Files:**
- Modify: `server/stocktake/stocktakeService.js`
- Modify: `server/stocktake/stocktakeRoutes.js`
- Test: `server/stocktake/stocktakeService.test.js`, `server/stocktake/stocktakeRoutes.test.js`

**Interfaces:**
- Consumes: `PASTE_COLUMNS`, `normalizeValue`, `foldName`, `codeKey` từ `stocktakePaste.js` (Task 1); `loadInputs`, `buildBoard`, `loadEmployees` (Task 3).
- Produces:
  - `pasteColumn(ctx, sessionId, { column, mode: 'skip'|'clear', rows: [{code, value}] }) -> { changed, skipped: { notFound, invalid, unchanged, empty } }`.
  - Routes: `PATCH /api/stocktake/sessions/:id` → `updateSession` (quyền `edit`); `POST /api/stocktake/sessions/:id/paste` → `pasteColumn` (quyền `edit`); `express.json` limit đổi thành `2mb`.

- [ ] **Step 1: Test service lỗi**

```js
test('dan cot: tung loai cot, bo qua / xoa o trong, ma la, gia tri sai, lich su paste', async () => {
  const { db, service, session, announced } = await fixture();
  await db.exec(`INSERT INTO hr_employees (id, branch, ho_ten) VALUES (502, 'hanoi', 'Thái Kho')`);
  const paste = (column, rows, mode = 'skip') => service.pasteColumn(ctx(), session.id, { column, mode, rows });

  let result = await paste('prevDiffManual', [{ code: 'aaa1', value: '-1.234' }, { code: 'ZZZ9', value: '1' }, { code: 'BBB2', value: 'abc' }, { code: 'CCC3', value: '' }]);
  assert.deepEqual(result, { changed: 1, skipped: { notFound: 1, invalid: 1, unchanged: 0, empty: 1 } });
  assert.deepEqual(announced.at(-1), session.id);
  let board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').prevDiff, rowOf(board, 'AAA1').prevDiffManual], [-1234, true]);

  result = await paste('prevDiffManual', [{ code: 'AAA1', value: '' }], 'clear');
  assert.equal(result.changed, 1);
  board = await service.getBoard(ctx(), session.id);
  assert.equal(rowOf(board, 'AAA1').prevDiffManual, false);

  await paste('recheck', [{ code: 'AAA1', value: 'thai kho' }, { code: 'BBB2', value: 'CẬN' }]);
  await paste('combo', [{ code: 'AAA1', value: 'x' }]);
  await paste('cluster', [{ code: 'AAA1', value: 'Cụm ấm' }, { code: 'BBB2', value: 'cụm ấm' }]);
  result = await paste('statusText', [{ code: 'AAA1', value: 'mất ko thấy' }, { code: 'AAA1x', value: 'x' }]);
  assert.equal(result.skipped.notFound, 1);
  assert.equal((await paste('statusText', [{ code: 'AAA1', value: 'mất ko thấy' }])).skipped.unchanged, 1);

  board = await service.getBoard(ctx(), session.id);
  assert.deepEqual([rowOf(board, 'AAA1').note.recheckEmployeeId, rowOf(board, 'AAA1').note.recheckName], [502, '']);
  assert.deepEqual([rowOf(board, 'BBB2').note.recheckEmployeeId, rowOf(board, 'BBB2').note.recheckName], [null, 'CẬN']);
  assert.equal(rowOf(board, 'AAA1').isCombo, true);
  assert.equal(rowOf(board, 'BBB2').clusterCount, 2);
  assert.equal(rowOf(board, 'AAA1').note.statusText, 'mất ko thấy');
  const { history } = await service.codeHistory(ctx(), session.id, 'AAA1');
  assert.ok(history.filter(h => h.action === 'paste').length >= 5);
  assert.deepEqual(history.find(h => h.action === 'paste').after.column, 'statusText');

  await assert.rejects(paste('bogus', [{ code: 'AAA1', value: '1' }]), { statusCode: 400 });
  await assert.rejects(service.pasteColumn(ctx(), session.id, { column: 'statusText', mode: 'skip', rows: Array(10001).fill({ code: 'AAA1', value: 'x' }) }), { statusCode: 400 });
  const fresh = await service.getBoard(ctx(), session.id);
  await service.closeSession(ctx(), session.id, { version: fresh.session.version });
  await assert.rejects(paste('statusText', [{ code: 'AAA1', value: 'y' }]), { statusCode: 409, code: 'STOCKTAKE_CLOSED' });
});
```

- [ ] **Step 2: Chạy test, phải lỗi**

Run: `node --test stocktake/stocktakeService.test.js`
Expected: FAIL `service.pasteColumn is not a function`

- [ ] **Step 3: Viết `pasteColumn`**

Đầu file: `const { PASTE_COLUMNS, normalizeValue, parseVnNumber, foldName } = require('../public/stocktake/stocktakePaste');`
Hằng: `const MAX_PASTE_ROWS = 10000;` và
```js
// Cot dan -> bang dich + truong trong ban ghi da shape.
const NOTE_FIELDS = Object.freeze({ statusText: 'statusText', reasonText: 'reasonText', printPage: 'printPage', printTime: 'printTime', prevDiffManual: 'prevDiffManual', otherDiffManual: 'otherDiffManual' });
const TAG_FIELDS = Object.freeze({ cluster: 'cluster', combo: 'isCombo' });
```

Trong factory:
```js
  // Dan 1 cot tu sheet theo ma: ghi de co chu dich (khong kiem version), 1 giao dich, 1 dong lich su 'paste' moi ma co doi.
  async function pasteColumn(ctx, sessionId, body = {}) {
    const column = String(body.column || '');
    if (!PASTE_COLUMNS[column]) throw fail(400, 'VALIDATION', 'Cột dán không hợp lệ.', { field: 'column' });
    const mode = body.mode === 'clear' ? 'clear' : 'skip';
    const input = Array.isArray(body.rows) ? body.rows : null;
    if (!input || !input.length || input.length > MAX_PASTE_ROWS) throw fail(400, 'VALIDATION', `Cần từ 1 đến ${MAX_PASTE_ROWS} dòng dán.`, { field: 'rows' });
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      const inputs = await loadInputs(client, session, { withCounterpart: false });
      const known = new Set([...buildBoard(inputs).rows.map(r => r.code), ...inputs.products.map(p => codeKey(p.code))]);
      const skipped = { notFound: 0, invalid: 0, unchanged: 0, empty: 0 };
      const isTag = Boolean(TAG_FIELDS[column]);
      const current = new Map((isTag ? inputs.tags : inputs.notes).map(item => [item.code, item]));
      const employees = column === 'recheck' ? (await loadEmployees(client)).filter(e => e.branch === session.branch || !e.branch) : [];
      const changes = [];
      for (const item of input) {
        const code = codeKey(item && item.code);
        if (!code || !known.has(code)) { skipped.notFound += 1; continue; }
        const parsed = normalizeValue(column, item.value);
        if (!parsed.ok) { skipped.invalid += 1; continue; }
        if (parsed.empty && mode === 'skip') { skipped.empty += 1; continue; }
        const before = current.get(code) || null;
        const next = nextRecord(column, before, parsed.value, employees);
        if (sameRecord(column, before, next)) { skipped.unchanged += 1; continue; }
        changes.push({ code, before, next });
      }
      if (changes.length) {
        if (isTag) await upsertTags(client, session.branch, changes, actor);
        else await upsertNotes(client, session.id, changes, actor);
        await client.query(
          `INSERT INTO stocktake_history (session_id, branch, product_code, action, before, after, actor_user_id, actor_name)
           SELECT $1, $2, r.code, 'paste', r.before, r.after, $4, $5 FROM jsonb_to_recordset($3::jsonb) AS r(code text, before jsonb, after jsonb)`,
          [session.id, session.branch, JSON.stringify(changes.map(c => ({ code: c.code, before: c.before, after: { column, ...c.next } }))), actor.id, actor.name]);
      }
      return { changed: changes.length, skipped };
    }, sessionId);
  }
```

Hàm phụ (ngoài factory):
```js
const EMPTY_NOTE = Object.freeze({ statusText: '', reasonText: '', printPage: '', printTime: '', recheckEmployeeId: null, recheckName: '', prevDiffManual: null, otherDiffManual: null });
const EMPTY_TAG = Object.freeze({ cluster: '', isCombo: false });

// Nguoi kiem lai dan vao: khop dung 1 nhan su cung co so (so ten bo dau) -> gan id; khong -> giu chu.
function recheckOf(value, employees) {
  if (!value) return { recheckEmployeeId: null, recheckName: '' };
  const matches = employees.filter(e => foldName(e.name) === foldName(value));
  return matches.length === 1 ? { recheckEmployeeId: matches[0].id, recheckName: '' } : { recheckEmployeeId: null, recheckName: value };
}

function nextRecord(column, before, value, employees) {
  if (TAG_FIELDS[column]) {
    const base = { cluster: before ? before.cluster : '', isCombo: Boolean(before && before.isCombo) };
    return { ...base, [TAG_FIELDS[column]]: column === 'combo' ? Boolean(value) : value };
  }
  const base = {};
  for (const key of Object.keys(EMPTY_NOTE)) base[key] = before && before[key] !== undefined ? before[key] : EMPTY_NOTE[key];
  if (column === 'recheck') return { ...base, ...recheckOf(value, employees) };
  return { ...base, [NOTE_FIELDS[column]]: value };
}

function sameRecord(column, before, next) {
  const keys = Object.keys(TAG_FIELDS[column] ? EMPTY_TAG : EMPTY_NOTE);
  const empty = TAG_FIELDS[column] ? EMPTY_TAG : EMPTY_NOTE;
  return keys.every(key => (before && before[key] !== undefined ? before[key] : empty[key]) === next[key]);
}
```

Trong factory, hai hàm ghi lô:
```js
  async function upsertNotes(client, sessionId, changes, actor) {
    await client.query(
      `INSERT INTO stocktake_code_notes (session_id, product_code, status_text, reason_text, print_page, print_time, recheck_employee_id, recheck_name,
                                         prev_diff_manual, other_diff_manual, updated_by_user_id, updated_by_name)
       SELECT $1, r.code, r."statusText", r."reasonText", r."printPage", r."printTime", r."recheckEmployeeId", r."recheckName",
              r."prevDiffManual", r."otherDiffManual", $3, $4
       FROM jsonb_to_recordset($2::jsonb) AS r(code text, "statusText" text, "reasonText" text, "printPage" text, "printTime" text,
            "recheckEmployeeId" bigint, "recheckName" text, "prevDiffManual" numeric, "otherDiffManual" numeric)
       ON CONFLICT (session_id, product_code) DO UPDATE SET status_text = EXCLUDED.status_text, reason_text = EXCLUDED.reason_text,
         print_page = EXCLUDED.print_page, print_time = EXCLUDED.print_time, recheck_employee_id = EXCLUDED.recheck_employee_id,
         recheck_name = EXCLUDED.recheck_name, prev_diff_manual = EXCLUDED.prev_diff_manual, other_diff_manual = EXCLUDED.other_diff_manual,
         version = stocktake_code_notes.version + 1, updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
      [sessionId, JSON.stringify(changes.map(c => ({ code: c.code, ...c.next }))), actor.id, actor.name]);
  }

  async function upsertTags(client, branch, changes, actor) {
    await client.query(
      `INSERT INTO stocktake_product_tags (branch, product_code, cluster, is_combo, updated_by_user_id, updated_by_name)
       SELECT $1, r.code, r.cluster, r."isCombo", $3, $4 FROM jsonb_to_recordset($2::jsonb) AS r(code text, cluster text, "isCombo" boolean)
       ON CONFLICT (branch, product_code) DO UPDATE SET cluster = EXCLUDED.cluster, is_combo = EXCLUDED.is_combo,
         version = stocktake_product_tags.version + 1, updated_by_user_id = EXCLUDED.updated_by_user_id,
         updated_by_name = EXCLUDED.updated_by_name, updated_at = now()`,
      [branch, JSON.stringify(changes.map(c => ({ code: c.code, ...c.next }))), actor.id, actor.name]);
  }
```
`recheckEmployeeId` của nhân sự: kiểm `hr_employees.is_active` đã có trong `loadEmployees`. `return` của factory thêm `pasteColumn`.
`codeHistory` đã lọc theo `session_id`, nên lịch sử `paste` của tag (Cụm/Combo) cũng hiện trong đợt đó; với dán tag, thêm điều kiện `OR (action = 'paste' AND branch = $3 AND after->>'column' IN ('cluster','combo'))` vào truy vấn `codeHistory` để giống lịch sử `tag`.

- [ ] **Step 4: Chạy test service, phải qua**

Run: `node --test stocktake/stocktakeService.test.js`
Expected: PASS 11 tests

- [ ] **Step 5: Test routes lỗi** (trong `stocktakeRoutes.test.js`)

Trong `start()`, `service` thêm `updateSession: record('updateSession'), pasteColumn: record('pasteColumn')`; `sheetImport` đổi thành `{ importSheet: record('importSheet') }`. Trong test "Quan ly: xem, sua, dong dot…" thêm trước `close`:
```js
  assert.equal((await fetch(base + '/sessions/7', { method: 'PATCH', ...json({ counterpartSessionId: 9, version: 1 }) })).status, 200);
  assert.equal((await fetch(base + '/sessions/7/paste', { method: 'POST', ...json({ column: 'statusText', rows: [] }) })).status, 200);
```
và danh sách `calls` kỳ vọng thành:
```js
    ['createSession', { name: 'x' }], ['saveLine', 7], ['addLine', 7], ['saveNote', 7], ['saveTag', 7], ['updateSession', 7], ['pasteColumn', 7], ['closeSession', 7], ['importSheet', {}]
```
Test mới:
```js
test('Khong co quyen sua: khong dan cot, khong doi dot doi chieu', async t => {
  const viewer = { id: 'v', vaiTro: 'Nhân viên kho', featurePermissions: { 'stocktake.view': true } };
  const { base, calls } = await start(t, { user: viewer });
  assert.equal((await fetch(base + '/sessions/7/paste', { method: 'POST', ...json({ column: 'statusText', rows: [] }) })).status, 403);
  assert.equal((await fetch(base + '/sessions/7', { method: 'PATCH', ...json({ counterpartSessionId: 9 }) })).status, 403);
  assert.ok(!calls.some(c => c[0] === 'pasteColumn' || c[0] === 'updateSession'));
});
```

- [ ] **Step 6: Sửa routes**

`express.json({ limit: '2mb' })` (10.000 dòng dán).
Sau route `POST /sessions`:
```js
  router.patch('/api/stocktake/sessions/:id', edit, handle(async (req, res) => {
    res.json(await svc().updateSession(ctxOf(req), idOf(req), req.body || {}));
  }));
```
Sau route `tag`:
```js
  // Dan 1 cot tu sheet (Ma + gia tri) — xem truoc lam o trinh duyet, server kiem lai va ghi 1 giao dich.
  router.post('/api/stocktake/sessions/:id/paste', edit, handle(async (req, res) => {
    res.json(await svc().pasteColumn(ctxOf(req), idOf(req), req.body || {}));
  }));
```
Route import: `res.status(201).json(await (dependencies.sheetImport || sheetImport).importSheet(ctxOf(req), req.body || {}));` (đổi comment: `Nap 1 lan dot T10 HN hoac KIEM SG tu sheet kiem ke (body.source = 't10' | 'sg').`) — `importSheet` có ở Task 5; chạy test routes sau Task 5 nếu cần, nhưng test dùng mock nên qua ngay.

- [ ] **Step 7: Chạy test routes, phải qua**

Run: `node --test stocktake/stocktakeRoutes.test.js`
Expected: PASS 7 tests

- [ ] **Step 8: Commit**

```bash
git add server/stocktake/stocktakeService.js server/stocktake/stocktakeService.test.js server/stocktake/stocktakeRoutes.js server/stocktake/stocktakeRoutes.test.js
git commit -m "feat(stocktake): dan cot tu sheet theo ma, doi dot doi chieu qua PATCH

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Nạp sheet: T10 đọc thêm L/I/J, nạp KIỂM SG, nối đối chiếu chéo

**Files:**
- Modify: `server/stocktake/stocktakeSheetImport.js`
- Test: `server/stocktake/stocktakeSheetImport.test.js`

**Interfaces:**
- Consumes: `codeKey` (compute); bảng có cột mới (Task 3).
- Produces:
  - `parseSheet(values, layout) -> { rows }`, `parseT10(values)`, `parseSg(values)`; mỗi dòng thêm `prevDiff: number|null, printPage, printTime`.
  - `SOURCES = { t10: {...}, sg: {...} }` (mỗi nguồn: `spreadsheetId, sheetId, branch, name, date, label`).
  - `importSheet(ctx, { source = 't10', name }) -> { sessionId, codes, mismatched, notes, tags, counterpartSessionId }`; giữ `importT10(ctx, body)` = `importSheet(ctx, { ...body, source: 't10' })`.
  - Giữ export `T10_SOURCE` (= `{ spreadsheetId, sheetId }` của t10) cho test cũ.

- [ ] **Step 1: Test lỗi** (thêm vào `stocktakeSheetImport.test.js`)

Trong `VALUES` dòng `lumi3m` thêm `8: '3', 9: '14:30', 11: -326`. Trong test `parseT10` thêm:
```js
  assert.deepEqual([rows[0].prevDiff, rows[0].printPage, rows[0].printTime], [-326, '3', '14:30']);
  assert.equal(rows[1].prevDiff, null, 'o L trong');
```

Dữ liệu SG + test mới:
```js
const SG_HEADER = ['Mã SP', 'Tên hàng', 'Giá vốn', 'Team 1: Kim Muội + a Hùng', 'Team Lỗi', 'TỔNG KIỂM', 'Tồn KIOT', 'SL Chênh', 'Giá trị chênh',
  'Chắc chắn thừa', 'KK trước sai', 'Lý do', 'Lý do sơ bộ', 'Trang in'];
const SG_VALUES = [
  SG_HEADER,
  ['', '', '', '', '', '', '', '', '-9,085,583'],
  ['TYC20C', 'Củ sạc', 15092, 0, 900, 900, 1900, -1000, -15092000, '', 1900, 'LẪN CÁC LOẠI SẠC VỚI NHAU ', '', ' '],
  ['LUMI3M', 'Tủ', 100, 0, 0, 93, 141, -48, -4800, 'a Chương', 1, 'Check lại ô số 10', 'Thiếu', '7']
];

test('parseSg: doc theo tieu de KIEM SG, Ly do so bo -> trang thai, Chac chan thua -> nguoi kiem lai', () => {
  const { rows } = parseSg(SG_VALUES);
  assert.deepEqual(rows.map(r => r.code), ['TYC20C', 'LUMI3M']);
  const lumi = rows[1];
  assert.deepEqual([lumi.counted, lumi.stock, lumi.diffQty, lumi.diffValue, lumi.cost, lumi.prevDiff], [93, 141, -48, -4800, 100, 1]);
  assert.deepEqual([lumi.statusText, lumi.reasonText, lumi.recheck, lumi.printPage], ['Thiếu', 'Check lại ô số 10', 'a Chương', '7']);
  assert.equal(rows[0].reasonText, 'LẪN CÁC LOẠI SẠC VỚI NHAU');
  assert.equal(rows[0].printPage, '');
});

test('importSheet sg + t10: hai dot dong, noi doi chieu cheo, Kiem SG cua T10 = SL chenh SG', async () => {
  const db = await migrated();
  const importer = createStocktakeSheetImport({
    getDb: () => poolFor(db), announce: () => {},
    readValues: async source => (String(source.sheetId) === String(SOURCES.sg.sheetId) ? SG_VALUES : VALUES)
  });
  const ctx = { user: { id: 'ql', hoTen: 'Quản Lý A' }, scope: ['hanoi', 'saigon'] };
  const sg = await importer.importSheet(ctx, { source: 'sg' });
  assert.equal(sg.counterpartSessionId, null);
  const t10 = await importer.importSheet(ctx, {});
  assert.equal(t10.counterpartSessionId, sg.sessionId);
  await assert.rejects(importer.importSheet(ctx, { source: 'sg' }), { code: 'ALREADY_IMPORTED' });
  await assert.rejects(importer.importSheet(ctx, { source: 'xx' }), { statusCode: 400 });

  const service = createStockTakeService({ getDb: () => poolFor(db), announce: () => {} });
  const hn = await service.getBoard(ctx, t10.sessionId);
  const lumi = hn.rows.find(r => r.code === 'LUMI3M');
  assert.deepEqual([lumi.prevDiff, lumi.otherDiff], [-326, -48]);
  assert.equal(lumi.note.printPage, '3');
  const sgBoard = await service.getBoard(ctx, sg.sessionId);
  assert.equal(sgBoard.session.branch, 'saigon');
  assert.equal(sgBoard.session.counterpartSessionId, t10.sessionId);
  assert.equal(sgBoard.rows.find(r => r.code === 'LUMI3M').otherDiff, -434);
});
```
Tách đoạn tạo PGlite + chạy migration của test import cũ thành `async function migrated()` dùng chung (test cũ gọi `const db = await migrated();`). Require đầu file: `const { parseT10, parseSg, createStocktakeSheetImport, T10_SOURCE, SOURCES } = require('./stocktakeSheetImport');`.

- [ ] **Step 2: Chạy test, phải lỗi**

Run: `node --test stocktake/stocktakeSheetImport.test.js`
Expected: FAIL `parseSg is not a function`

- [ ] **Step 3: Sửa `stocktakeSheetImport.js`**

Thay hằng nguồn + `HEADERS`/`REQUIRED`:
```js
const SPREADSHEET_ID = '1hbYPE1t7vTkpheKdmYpLkD9OyUH4GADcP4xZEoTeF1M';
// KIEM SG la IMPORTRANGE tu file "KIEM KE SG" (service account khong doc duoc file goc) -> doc ban da keo ve trong file HN.
const SOURCES = Object.freeze({
  t10: Object.freeze({ spreadsheetId: SPREADSHEET_ID, sheetId: 1784846530, branch: 'hanoi', name: 'Kiểm kê HN T10 (sheet)', date: '2026-10-03', label: 'T10 Hà Nội' }),
  sg: Object.freeze({ spreadsheetId: SPREADSHEET_ID, sheetId: 1469990159, branch: 'saigon', name: 'Kiểm kê SG T10 (sheet)', date: '2026-10-03', label: 'KIỂM SG' })
});
const T10_SOURCE = Object.freeze({ spreadsheetId: SOURCES.t10.spreadsheetId, sheetId: SOURCES.t10.sheetId });

// Tieu de da bo dau -> truong. Khong co trong tab thi truong do rong.
const LAYOUTS = Object.freeze({
  t10: Object.freeze({
    code: 'ma sp', name: 'ten hang', counted: 'tong kiem', stock: 'ton kiot', diffQty: 'sl chenh', diffValue: 'gia tri chenh',
    statusText: 'trang thai', reasonText: 'chi tiet ly do', printPage: 'trang in', printTime: 'gio in', recheck: 'nguoi kiem lai',
    prevDiff: 'kk truoc sai', cluster: 'cum sp', combo: 'combo', cost: 'gia von'
  }),
  sg: Object.freeze({
    code: 'ma sp', name: 'ten hang', cost: 'gia von', counted: 'tong kiem', stock: 'ton kiot', diffQty: 'sl chenh', diffValue: 'gia tri chenh',
    recheck: 'chac chan thua', prevDiff: 'kk truoc sai', reasonText: 'ly do', statusText: 'ly do so bo', printPage: 'trang in'
  })
});
const REQUIRED = ['code', 'counted', 'stock', 'diffQty'];
```
Thêm `const optionalNumber = value => (text(value) === '' ? null : numberOf(value));`

`parseT10` thành `parseSheet(values, layout)` (dùng `layout` thay `HEADERS`; thông báo thiếu cột dùng `layout[f]`), thêm trường:
```js
      printPage: text(cell(row, 'printPage')).slice(0, 50),
      printTime: text(cell(row, 'printTime')).slice(0, 50),
      prevDiff: col.prevDiff === undefined ? null : optionalNumber(cell(row, 'prevDiff')),
```
và:
```js
const parseT10 = values => parseSheet(values, LAYOUTS.t10);
const parseSg = values => parseSheet(values, LAYOUTS.sg);
```

`importT10` → `importSheet(ctx, body)`:
```js
  async function importSheet(ctx, body = {}) {
    const key = body.source === undefined || body.source === '' ? 't10' : String(body.source);
    const source = SOURCES[key];
    if (!source) throw fail(400, 'VALIDATION', 'Nguồn sheet không hợp lệ (t10 hoặc sg).');
    const branch = source.branch;
    if (ctx.scope && !ctx.scope.includes(branch)) throw fail(403, 'BRANCH_OUT_OF_SCOPE', `Cơ sở ${branch === 'hanoi' ? 'Hà Nội' : 'Sài Gòn'} không thuộc phạm vi đang chọn.`);
    const sourceRef = `sheet:${source.spreadsheetId}:${source.sheetId}`;
    const values = await readValues({ spreadsheetId: source.spreadsheetId, sheetId: source.sheetId }, { valueRenderOption: 'UNFORMATTED_VALUE' });
    const { rows } = parseSheet(values, LAYOUTS[key]);
    ...
```
Thân giữ như cũ, đổi: thông báo `ALREADY_IMPORTED` → `` `Số liệu ${source.label} đã được nạp trước đó.` ``; tên/ngày lấy từ `source`. INSERT results thêm `prev_diff` (`r."prevDiff"`, kiểu `numeric`). INSERT notes thêm `print_page, print_time` (`r."printPage" text, r."printTime" text`) và điều kiện `WHERE ... OR r."printPage" <> '' OR r."printTime" <> ''`. Trước `INSERT INTO stocktake_history`, nối đối chiếu:
```js
      // Dot nap cua co so kia (neu da co) <-> dot nay, chi dien o con trong.
      const other = (await client.query(
        `SELECT id FROM stocktake_sessions WHERE source = 'sheet_import' AND branch <> $1 ORDER BY id DESC LIMIT 1`, [branch])).rows[0];
      const counterpartSessionId = other ? Number(other.id) : null;
      if (counterpartSessionId) {
        await client.query(
          `UPDATE stocktake_sessions SET counterpart_session_id = CASE WHEN id = $1 THEN $2::bigint ELSE $1::bigint END
           WHERE id IN ($1, $2) AND counterpart_session_id IS NULL`, [sessionId, counterpartSessionId]);
      }
```
`summary` thêm `counterpartSessionId`; trả `{ sessionId, ...summary }`.
Factory trả `{ importSheet, importT10: (ctx, body = {}) => importSheet(ctx, { ...body, source: 't10' }) }`.
`module.exports = { parseSheet, parseT10, parseSg, createStocktakeSheetImport, SOURCES, T10_SOURCE, LAYOUTS, ...createStocktakeSheetImport() };`
Sửa comment đầu file: thêm dòng `// Nap them tab "KIEM SG" (dot SG cung ngay), tu noi doi chieu cheo voi dot T10.`

- [ ] **Step 4: Chạy test, phải qua**

Run: `node --test stocktake/stocktakeSheetImport.test.js stocktake/stocktakeRoutes.test.js`
Expected: PASS (import 4, routes 7)

- [ ] **Step 5: Commit**

```bash
git add server/stocktake/stocktakeSheetImport.js server/stocktake/stocktakeSheetImport.test.js
git commit -m "feat(stocktake): nap tab KIEM SG, T10 doc them KK truoc sai / trang in / gio in, noi doi chieu cheo

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Xuất Excel đúng thứ tự cột

**Files:**
- Modify: `server/stocktake/stocktakeExport.js`
- Test: `server/stocktake/stocktakeRoutes.test.js` (đã có test xuất Excel dùng ExcelJS — sửa kỳ vọng tiêu đề)

**Interfaces:**
- Consumes: các trường dòng từ Task 2/3.
- Produces: `createStocktakeWorkbook({ session, rows, employees })` — 24 cột, tên cột 13/19 theo `session.branch`. Hàm `boardColumnHeaders(branch) -> string[]` (export để test).

- [ ] **Step 1: Test lỗi**

Mở `stocktakeRoutes.test.js`, tìm test xuất Excel (đọc `worksheet.getRow(1)`); thay kỳ vọng tiêu đề bằng:
```js
  assert.deepEqual(sheet.getRow(1).values.slice(1), boardColumnHeaders('hanoi'));
  assert.equal(boardColumnHeaders('hanoi')[12], 'Kiểm SG');
  assert.equal(boardColumnHeaders('saigon')[12], 'Kiểm HN');
  assert.equal(boardColumnHeaders('saigon')[18], 'Do kiểm HN');
  assert.equal(boardColumnHeaders('hanoi').length, 24);
```
và `const { boardColumnHeaders } = require('./stocktakeExport');`. Ô kiểm giá trị cũ theo vị trí (vd. cột "Vị trí kho gần nhất" ở cột 3) phải đổi sang vị trí mới: Vị trí = cột 22, Giá vốn = cột 23. Thêm `ROWS[0].prevRatio = 2.3313` và kiểm `sheet.getRow(2).getCell(17).numFmt === '0%'`.

- [ ] **Step 2: Chạy test, phải lỗi**

Run: `node --test stocktake/stocktakeRoutes.test.js`
Expected: FAIL `boardColumnHeaders is not a function`

- [ ] **Step 3: Sửa `stocktakeExport.js`**

```js
const PERCENT = '0%';

// Dung thu tu tab "KIEM KE HN T10" (A->W) + cot Cap nhat. Dot SG: cot M/S doi ten sang Ha Noi.
function columns(employeeName, branch) {
  const other = branch === 'saigon' ? 'HN' : 'SG';
  const note = (row, field) => safeText(row.note ? row.note[field] : '');
  return [
    { header: 'Mã hàng', width: 16, value: row => safeText(row.code) },
    { header: 'Tên hàng', width: 40, value: row => safeText(row.name) },
    { header: 'Tổng kiểm', width: 12, numFmt: NUMBER, value: row => row.counted },
    { header: 'Tồn KIOT', width: 12, numFmt: NUMBER, value: row => row.stock },
    { header: 'SL chênh', width: 12, numFmt: NUMBER, value: row => row.diffQty },
    { header: 'Giá trị chênh', width: 16, numFmt: MONEY, value: row => row.diffValue },
    { header: 'Trạng thái', width: 16, value: row => note(row, 'statusText') },
    { header: 'Chi tiết lý do', width: 36, value: row => note(row, 'reasonText') },
    { header: 'Trang in', width: 10, value: row => note(row, 'printPage') },
    { header: 'Giờ in', width: 12, value: row => note(row, 'printTime') },
    { header: 'Người kiểm lại', width: 20, value: row => safeText(row.note ? employeeName(row.note.recheckEmployeeId) || row.note.recheckName : '') },
    { header: 'KK trước sai', width: 12, numFmt: NUMBER, value: row => row.prevDiff },
    { header: 'Kiểm ' + other, width: 12, numFmt: NUMBER, value: row => row.otherDiff },
    { header: 'Cụm SP', width: 16, value: row => safeText(row.cluster) },
    { header: 'Count', width: 8, numFmt: NUMBER, value: row => row.clusterCount },
    { header: 'Chênh cụm', width: 12, numFmt: NUMBER, value: row => row.clusterDiff },
    { header: 'Do KK trước', width: 12, numFmt: PERCENT, value: row => row.prevRatio },
    { header: 'Lẫn + KK trước', width: 14, numFmt: PERCENT, value: row => row.clusterPrevRatio },
    { header: 'Do kiểm ' + other, width: 12, numFmt: PERCENT, value: row => row.otherRatio },
    { header: 'Quên KK', width: 9, value: row => (row.forgotten ? 'X' : '') },
    { header: 'Combo', width: 8, value: row => (row.isCombo ? 'X' : '') },
    { header: 'Vị trí kho gần nhất', width: 18, value: row => safeText(row.latestPosition ? row.latestPosition.location : '') },
    { header: 'Giá vốn', width: 12, numFmt: MONEY, value: row => row.cost },
    { header: 'Cập nhật', width: 22, value: row => safeText(row.note && row.note.updatedByName ? row.note.updatedByName : '') }
  ];
}
const boardColumnHeaders = branch => columns(() => '', branch).map(col => col.header);
```
`createStocktakeWorkbook`: `const cols = columns(id => ..., session.branch);`. Export `{ createStocktakeWorkbook, boardColumnHeaders }`. Comment đầu file: `// Xuat Excel bang doi chieu kiem ke (dung thu tu cot tab "KIEM KE HN T10").`

- [ ] **Step 4: Chạy test, phải qua**

Run: `node --test stocktake/stocktakeRoutes.test.js`
Expected: PASS 7 tests

- [ ] **Step 5: Commit**

```bash
git add server/stocktake/stocktakeExport.js server/stocktake/stocktakeRoutes.test.js
git commit -m "feat(stocktake): xuat Excel du 24 cot dung thu tu T10, ten cot theo co so

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Giao diện: cột mới, sort, ghi chú, đối chiếu, dán cột, nạp SG

**Files:**
- Modify: `server/public/stocktake/index.html`, `server/public/stocktake/stocktake.js`, `server/public/stocktake/stocktake.css`
- Kiểm bằng tay ở Task 8 (logic thuần đã test ở Task 1; sort kiểm trên web test theo spec).

**Interfaces:**
- Consumes: board từ Task 3 (`counterpart`, các cột mới), `POST …/paste`, `PATCH /sessions/:id`, `POST /import-sheet {source}`, `window.TKSStocktakePaste` (Task 1).
- Produces: `window.TKSStocktake = { init, visibleRows, cellText, sortRows, state }`.

- [ ] **Step 1: `index.html`**

1. Bỏ `<select id="stSort">…</select>`.
2. Nút nạp: thay `stImportButton` bằng hai nút:
```html
          <button class="locations-columns-button vt-btn" id="stImportT10Button" type="button" hidden title="Nạp một lần tab KIỂM KÊ HN T10">Nạp T10 HN từ sheet</button>
          <button class="locations-columns-button vt-btn" id="stImportSgButton" type="button" hidden title="Nạp một lần tab KIỂM SG">Nạp KIỂM SG từ sheet</button>
```
3. Sau `stSessionMeta` thêm ô đối chiếu:
```html
          <label class="st-field st-counterpart" id="stCounterpartField" hidden><span>Đợt đối chiếu</span><select id="stCounterpart" aria-label="Đợt đối chiếu cơ sở kia"></select></label>
```
4. Toolbar bảng, trước `stExportButton`: `<button class="locations-columns-button vt-btn" id="stPasteButton" type="button" hidden>Dán cột</button>`
5. Hộp tạo đợt, sau ô Cơ sở: `<label class="vt-field"><span>Đợt đối chiếu (cơ sở kia)</span><select name="counterpartSessionId"><option value="">— Không —</option></select></label>`
6. Form ghi chú, sau ô Chi tiết lý do:
```html
          <label class="vt-field"><span>Trang in</span><input name="printPage" type="text" maxlength="50" autocomplete="off"></label>
          <label class="vt-field"><span>Giờ in</span><input name="printTime" type="text" maxlength="50" autocomplete="off"></label>
          <label class="vt-field"><span>KK trước sai (dán tay)</span><input name="prevDiffManual" type="text" inputmode="decimal" autocomplete="off" placeholder="Trống = tự lấy"></label>
          <label class="vt-field"><span id="stOtherManualLabel">Kiểm SG (dán tay)</span><input name="otherDiffManual" type="text" inputmode="decimal" autocomplete="off" placeholder="Trống = tự lấy"></label>
```
7. Hộp thoại dán cột (trước `<!-- Xác nhận -->`):
```html
  <dialog class="vt-dialog vt-dialog-wide" id="stPasteDialog" aria-labelledby="stPasteTitle">
    <form id="stPasteForm" novalidate>
      <div class="dp-head">
        <div class="dp-head-text"><h3 class="dp-title" id="stPasteTitle">Dán cột từ sheet</h3><p class="dp-subtitle">Trên sheet bôi đen cột Mã SP và cột cần dán, copy rồi dán vào ô dưới. Web khớp theo mã.</p></div>
        <button type="button" class="dp-close" data-st-close aria-label="Đóng">×</button>
      </div>
      <div class="dp-body">
        <label class="vt-field"><span>Cột cần dán</span><select name="column" id="stPasteColumn"></select></label>
        <label class="vt-field st-wide"><span>Dữ liệu dán (Mã SP ⇥ giá trị)</span><textarea name="text" id="stPasteText" rows="10" spellcheck="false"></textarea></label>
        <fieldset class="st-paste-mode"><legend>Ô trống</legend>
          <label><input type="radio" name="mode" value="skip" checked> Bỏ qua</label>
          <label><input type="radio" name="mode" value="clear"> Xóa giá trị cũ</label>
        </fieldset>
        <div class="st-paste-preview" id="stPastePreview" aria-live="polite"></div>
        <p class="vt-form-error" id="stPasteError" role="alert"></p>
        <div class="vt-dialog-actions">
          <button type="button" class="locations-columns-button" data-st-close>Hủy</button>
          <button type="submit" class="locations-columns-button vt-primary" id="stPasteSave" disabled>Lưu</button>
        </div>
      </div>
    </form>
  </dialog>
```
8. Script: thêm `<script src="/stocktake/stocktakePaste.js?v=20261102-1"></script>` trước `stocktake.js`; `stocktake.js?v=20261102-5`; `stocktake.css?v=20261102-3`.

- [ ] **Step 2: `stocktake.js` — cột, nhãn theo cơ sở, sort**

Thay `COLUMNS`:
```js
  // Đúng thứ tự tab "KIỂM KÊ HN T10" (A→W, bỏ M/S khi chưa đối chiếu vẫn giữ cột); đợt SG đổi nhãn otherDiff/otherRatio.
  const COLUMNS = [
    { key: 'code', label: 'Mã hàng', width: 120, locked: true, type: 'text' },
    { key: 'name', label: 'Tên hàng', width: 240, type: 'text' },
    { key: 'counted', label: 'Tổng kiểm', width: 96, num: true },
    { key: 'stock', label: 'Tồn KIOT', width: 96, num: true },
    { key: 'diffQty', label: 'SL chênh', width: 96, num: true },
    { key: 'diffValue', label: 'Giá trị chênh', width: 120, num: true },
    { key: 'status', label: 'Trạng thái', width: 130, type: 'text' },
    { key: 'reason', label: 'Chi tiết lý do', width: 220, type: 'text' },
    { key: 'printPage', label: 'Trang in', width: 80, type: 'text' },
    { key: 'printTime', label: 'Giờ in', width: 90, type: 'text' },
    { key: 'recheck', label: 'Người kiểm lại', width: 140, type: 'text' },
    { key: 'prevDiff', label: 'KK trước sai', width: 96, num: true },
    { key: 'otherDiff', label: 'Kiểm SG', width: 96, num: true },
    { key: 'cluster', label: 'Cụm SP', width: 140, type: 'text' },
    { key: 'clusterCount', label: 'Count', width: 70, num: true },
    { key: 'clusterDiff', label: 'Chênh cụm', width: 96, num: true },
    { key: 'prevRatio', label: 'Do KK trước', width: 96, num: true, percent: true },
    { key: 'clusterPrevRatio', label: 'Lẫn + KK trước', width: 110, num: true, percent: true },
    { key: 'otherRatio', label: 'Do kiểm SG', width: 96, num: true, percent: true },
    { key: 'forgotten', label: 'Quên KK', width: 80, type: 'flag' },
    { key: 'combo', label: 'Combo', width: 70, type: 'flag' },
    { key: 'position', label: 'Vị trí kho gần nhất', width: 130, type: 'text' },
    { key: 'cost', label: 'Giá vốn', width: 96, num: true },
    { key: 'updated', label: 'Cập nhật', width: 140, type: 'text' }
  ];
  const otherLabel = branch => (branch === 'saigon' ? 'HN' : 'SG');
  const labelOf = (column, branch) => (column.key === 'otherDiff' ? 'Kiểm ' + otherLabel(branch)
    : column.key === 'otherRatio' ? 'Do kiểm ' + otherLabel(branch) : column.label);
```
`state`: bỏ `sort: 'value'`, thêm `sortKey: null, sortDir: null, headBranch: null`.
`pct`: `const pct = value => (value === null || value === undefined ? '' : Math.round(value * 100) + '%');`

`cellText` thêm các case:
```js
      case 'printPage': return note.printPage || '';
      case 'printTime': return note.printTime || '';
      case 'otherDiff': return num(row.otherDiff);
      case 'clusterCount': return num(row.clusterCount);
      case 'prevRatio': return pct(row.prevRatio);
      case 'clusterPrevRatio': return pct(row.clusterPrevRatio);
      case 'otherRatio': return pct(row.otherRatio);
      case 'forgotten': return row.forgotten ? 'Quên' : '';
      case 'cost': return num(row.cost);
```

Giá trị sort + `sortRows`:
```js
  // Giá trị để sort: số -> number, chữ -> chuỗi, đánh dấu -> 1/0; ô trống -> null (luôn nằm cuối).
  function sortValue(row, column) {
    const note = row.note || {};
    switch (column.key) {
      case 'name': return row.name || null;
      case 'status': return note.statusText || null;
      case 'reason': return note.reasonText || null;
      case 'printPage': return note.printPage || null;
      case 'printTime': return note.printTime || null;
      case 'recheck': return recheckLabel(row.note) || null;
      case 'cluster': return row.cluster || null;
      case 'position': return row.latestPosition ? row.latestPosition.location || null : null;
      case 'updated': return note.updatedAt || null;
      case 'forgotten': return row.forgotten ? 1 : 0;
      case 'combo': return row.isCombo ? 1 : 0;
      default: {
        const value = row[column.key];
        return value === null || value === undefined ? null : value;
      }
    }
  }
  const byDefault = (a, b) => Math.abs(b.diffValue) - Math.abs(a.diffValue) || a.code.localeCompare(b.code);
  function sortRows(rows) {
    const column = COLUMNS.find(c => c.key === state.sortKey);
    if (!column || !state.sortDir) return rows.sort(byDefault);
    const factor = state.sortDir === 'desc' ? -1 : 1;
    // Đánh dấu (Quên KK, Combo): "tăng" = có trước.
    const flagFactor = column.type === 'flag' ? -1 : 1;
    return rows.sort((a, b) => {
      const x = sortValue(a, column);
      const y = sortValue(b, column);
      if (x === null || y === null) return x === y ? a.code.localeCompare(b.code) : x === null ? 1 : -1;
      const diff = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'vi');
      return diff * factor * flagFactor || a.code.localeCompare(b.code);
    });
  }
```
`visibleRows()`: thay ba dòng `const by …` + `return rows.sort(by);` bằng `return sortRows(rows);`.

`renderHead(branch)`:
```js
  function renderHead(branch) {
    state.headBranch = branch || 'hanoi';
    const tr = document.querySelector('#stTable thead tr');
    tr.textContent = '';
    for (const column of COLUMNS) {
      const th = document.createElement('th');
      th.dataset.field = column.key;
      if (column.num) th.className = 'num';
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sort-button';
      button.dataset.stSort = column.key;
      const label = document.createElement('span');
      label.className = 'sort-label';
      label.textContent = labelOf(column, state.headBranch);
      const mark = document.createElement('span');
      mark.className = 'sort-indicator';
      mark.setAttribute('aria-hidden', 'true');
      button.append(label, mark);
      th.appendChild(button);
      tr.appendChild(th);
    }
    syncSortHeader();
    if (window.TKSTables) {
      window.TKSTables.enhance($('stTable'), {
        key: 'stocktake-board-v2', button: $('stColumnsButton'), sort: false,
        columns: COLUMNS.map(c => ({ key: c.key, label: labelOf(c, state.headBranch), width: c.width, locked: !!c.locked, hidden: c.key === 'updated' }))
      });
    }
  }
  function syncSortHeader() {
    document.querySelectorAll('#stTable thead th').forEach(th => {
      const on = th.dataset.field === state.sortKey && state.sortDir;
      th.setAttribute('aria-sort', on ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
    });
  }
```
`init`: gọi `renderHead('hanoi')` như cũ. `render()`: đầu hàm thêm `if (session && session.branch !== state.headBranch) renderHead(session.branch);`.
Ô bảng: trong vòng `for (const column of COLUMNS)` của `render`, thêm sau `td.textContent = …`:
```js
        if ((column.key === 'prevDiff' && row.prevDiffManual) || (column.key === 'otherDiff' && row.otherDiffManual)) {
          td.classList.add('st-manual');
          const auto = column.key === 'prevDiff' ? row.prevDiffAuto : row.otherDiffAuto;
          td.title = 'Số dán tay · web tự lấy: ' + (auto === null || auto === undefined ? 'trống' : num(auto));
        }
```
và mở rộng điều kiện tô âm/dương thêm `'prevDiff', 'otherDiff'`.

`bindTable`: bỏ dòng `stSort`; thêm:
```js
    // Bấm tiêu đề: tăng -> giảm -> mặc định (giá trị chênh lớn trước). Sort toàn bộ dòng đã lọc rồi mới chia trang.
    document.querySelector('#stTable thead').addEventListener('click', event => {
      const button = event.target.closest('[data-st-sort]');
      if (!button || event.target.closest('.tks-column-resizer')) return;
      const key = button.dataset.stSort;
      if (state.sortKey !== key) { state.sortKey = key; state.sortDir = 'asc'; }
      else if (state.sortDir === 'asc') state.sortDir = 'desc';
      else { state.sortKey = null; state.sortDir = null; }
      syncSortHeader();
      rerender();
    });
```

- [ ] **Step 3: `stocktake.js` — ghi chú, đối chiếu, nạp, dán**

`renderDetail` (phần forms) thêm:
```js
    noteForm.elements.printPage.value = note.printPage || '';
    noteForm.elements.printTime.value = note.printTime || '';
    noteForm.elements.prevDiffManual.value = note.prevDiffManual === null || note.prevDiffManual === undefined ? '' : String(note.prevDiffManual);
    noteForm.elements.otherDiffManual.value = note.otherDiffManual === null || note.otherDiffManual === undefined ? '' : String(note.otherDiffManual);
    $('stOtherManualLabel').textContent = 'Kiểm ' + otherLabel(state.board.session.branch) + ' (dán tay)';
```
`renderLines` stats thêm `['Kiểm ' + otherLabel(state.board.session.branch), row.otherDiff === null ? '—' : num(row.otherDiff)]`.
Submit `stNoteForm` body thêm:
```js
        printPage: form.elements.printPage.value,
        printTime: form.elements.printTime.value,
        prevDiffManual: form.elements.prevDiffManual.value.trim() === '' ? null : form.elements.prevDiffManual.value,
        otherDiffManual: form.elements.otherDiffManual.value.trim() === '' ? null : form.elements.otherDiffManual.value,
```
`historyText` cho `note` thêm `after.printPage && 'Trang ' + after.printPage`, và:
```js
    if (item.action === 'paste') return 'Dán cột ' + ((window.TKSStocktakePaste.PASTE_COLUMNS[after.column] || {}).label || after.column);
    if (item.action === 'session_update') return 'Đổi đợt đối chiếu';
```
`ACTION_LABELS` thêm `paste: 'Dán cột', session_update: 'Đổi đối chiếu'`.

Đối chiếu — gợi ý + ô chọn:
```js
  // Đợt cơ sở kia có khoảng ngày giao nhau; không có thì đợt có ngày cuối gần ngày bắt đầu nhất.
  function suggestCounterpart(branch, dateFrom, dateTo) {
    const others = state.sessions.filter(s => s.branch !== branch);
    const overlap = others.find(s => s.dateFrom <= dateTo && s.dateTo >= dateFrom);
    if (overlap) return overlap;
    const gap = s => Math.abs(Date.parse(s.dateTo) - Date.parse(dateFrom));
    return others.slice().sort((a, b) => gap(a) - gap(b))[0] || null;
  }
  function fillCounterpartSelect(select, branch, selected) {
    fillSelect(select, '— Không —', state.sessions.filter(s => s.branch !== branch)
      .map(s => [String(s.id), s.name + ' · ' + (s.branch === 'hanoi' ? 'HN' : 'SG')]), selected ? String(selected) : '');
  }
```
`render()` thêm:
```js
    const field = $('stCounterpartField');
    field.hidden = !session;
    if (session) {
      fillCounterpartSelect($('stCounterpart'), session.branch, session.counterpartSessionId);
      $('stCounterpart').disabled = !(state.canEdit && session.status === 'open');
    }
    $('stPasteButton').hidden = !(session && session.status === 'open' && state.canEdit);
```
`bindSessions`:
- Mở hộp tạo đợt: sau khi đặt branch/ngày gọi `const refill = () => { const s = suggestCounterpart(form.elements.branch.value, form.elements.dateFrom.value, form.elements.dateTo.value); fillCounterpartSelect(form.elements.counterpartSessionId, form.elements.branch.value, s && s.id); }; refill();` và gắn `refill` vào sự kiện `change` của `branch`, `dateFrom`, `dateTo` (gắn một lần trong `bindSessions`, không gắn trong click).
- Submit tạo đợt thêm `counterpartSessionId: form.elements.counterpartSessionId.value ? Number(form.elements.counterpartSessionId.value) : null`.
- Đổi đối chiếu:
```js
    $('stCounterpart').addEventListener('change', async event => {
      const session = state.board && state.board.session;
      if (!session) return;
      const { response, payload } = await request(API + '/sessions/' + session.id, jsonOptions('PATCH', {
        counterpartSessionId: event.target.value ? Number(event.target.value) : null, version: session.version
      }));
      if (!response.ok) { notify(payload.error || 'Không đổi được đợt đối chiếu.', true); }
      await loadSessions(session.id);
    });
```
- Nạp sheet: thay handler `stImportButton` bằng
```js
    const importSheet = (source, title, message) => async () => {
      if (!(await confirmAction(title, message, 'Nạp'))) return;
      notify('Đang đọc sheet…');
      const { response, payload } = await request(API + '/import-sheet', jsonOptions('POST', { source }));
      if (!response.ok) { notify(payload.error || 'Không nạp được sheet.', true); return; }
      notify('Đã nạp ' + num(payload.codes) + ' mã (' + num(payload.mismatched) + ' mã lệch).');
      await loadSessions(payload.sessionId);
    };
    $('stImportT10Button').addEventListener('click', importSheet('t10', 'Nạp đợt T10 Hà Nội từ sheet?',
      'Đọc tab KIỂM KÊ HN T10 (chỉ đọc) và lưu thành một đợt đã đóng. Chỉ nạp được một lần.'));
    $('stImportSgButton').addEventListener('click', importSheet('sg', 'Nạp KIỂM SG từ sheet?',
      'Đọc tab KIỂM SG (chỉ đọc) và lưu thành một đợt Sài Gòn đã đóng, tự đối chiếu với đợt T10 Hà Nội. Chỉ nạp được một lần.'));
```
`loadSessions`: thay dòng `stImportButton` bằng
```js
    const imported = branch => state.sessions.some(s => s.source === 'sheet_import' && s.branch === branch);
    $('stImportT10Button').hidden = !state.canClose || imported('hanoi');
    $('stImportSgButton').hidden = !state.canClose || imported('saigon');
```

Dán cột:
```js
  // ---------- Dán cột ----------
  const paste = { rows: [], plan: null };
  function pasteColumnLabel(key) {
    const spec = window.TKSStocktakePaste.PASTE_COLUMNS[key];
    return key === 'otherDiffManual' ? 'Kiểm ' + otherLabel(state.board.session.branch) : spec.label;
  }
  // Giá trị hiện tại của cột trên một dòng, cùng kiểu với normalizeValue để so "sẽ đổi".
  function currentValue(row, column) {
    const note = row.note || {};
    switch (column) {
      case 'recheck': return recheckLabel(row.note);
      case 'cluster': return row.cluster || '';
      case 'combo': return !!row.isCombo;
      case 'prevDiffManual': case 'otherDiffManual': return note[column] === undefined ? null : note[column];
      default: return note[column] || '';
    }
  }
  function previewPaste() {
    const lib = window.TKSStocktakePaste;
    const form = $('stPasteForm');
    const column = form.elements.column.value;
    const mode = form.elements.mode.value;
    const byCode = new Map(state.board.rows.map(row => [row.code, row]));
    const { rows, duplicates } = lib.parsePasteText(form.elements.text.value, { isKnownCode: code => byCode.has(code), column });
    const plan = { send: [], matched: 0, notFound: [], changed: 0, invalid: 0, empty: 0, duplicates };
    for (const item of rows) {
      const row = byCode.get(item.code);
      if (!row) { plan.notFound.push(item.code); plan.send.push(item); continue; } // server tra notFound neu ma khong co tren KiotViet
      plan.matched += 1;
      const parsed = lib.normalizeValue(column, item.value);
      if (!parsed.ok) { plan.invalid += 1; continue; }
      if (parsed.empty && mode === 'skip') { plan.empty += 1; continue; }
      const before = currentValue(row, column);
      const same = column === 'recheck' ? lib.foldName(before) === lib.foldName(parsed.value) : before === parsed.value;
      if (!same) plan.changed += 1;
      plan.send.push(item);
    }
    paste.plan = plan;
    const lines = [
      num(plan.matched) + ' mã khớp với đợt · ' + num(plan.changed) + ' ô sẽ đổi',
      plan.invalid ? num(plan.invalid) + ' ô không hợp lệ (bỏ qua)' : '',
      plan.empty ? num(plan.empty) + ' ô trống (bỏ qua)' : '',
      plan.duplicates ? num(plan.duplicates) + ' mã lặp (lấy dòng cuối)' : '',
      plan.notFound.length ? num(plan.notFound.length) + ' mã không có trong đợt: ' + plan.notFound.slice(0, 20).join(', ') + (plan.notFound.length > 20 ? '…' : '') : ''
    ].filter(Boolean);
    const box = $('stPastePreview');
    box.textContent = '';
    for (const text of lines) { const p = document.createElement('p'); p.textContent = text; box.appendChild(p); }
    $('stPasteSave').disabled = !plan.send.length || (!plan.changed && !plan.notFound.length);
  }
  function bindPaste() {
    $('stPasteButton').addEventListener('click', () => {
      const form = $('stPasteForm');
      form.reset();
      const select = form.elements.column;
      select.textContent = '';
      for (const key of Object.keys(window.TKSStocktakePaste.PASTE_COLUMNS)) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = pasteColumnLabel(key);
        select.appendChild(option);
      }
      $('stPasteError').textContent = '';
      $('stPastePreview').textContent = '';
      $('stPasteSave').disabled = true;
      $('stPasteDialog').showModal();
    });
    $('stPasteForm').addEventListener('input', previewPaste);
    $('stPasteForm').addEventListener('change', previewPaste);
    $('stPasteForm').addEventListener('submit', async event => {
      event.preventDefault();
      if (!paste.plan || !paste.plan.send.length) return;
      const form = event.target;
      $('stPasteSave').disabled = true;
      const { response, payload } = await request(API + '/sessions/' + state.sessionId + '/paste', jsonOptions('POST', {
        column: form.elements.column.value, mode: form.elements.mode.value, rows: paste.plan.send
      }));
      if (!response.ok) { $('stPasteError').textContent = payload.error || 'Không lưu được.'; $('stPasteSave').disabled = false; return; }
      $('stPasteDialog').close();
      const s = payload.skipped || {};
      notify('Đã dán ' + num(payload.changed) + ' ô' + (s.notFound ? ' · ' + num(s.notFound) + ' mã không có' : '') + (s.invalid ? ' · ' + num(s.invalid) + ' ô sai' : '') + '.');
      await loadBoard({ background: true, forms: true });
    });
  }
```
`init` gọi `bindPaste()` sau `bindDetail()`. `window.TKSStocktake = { init, visibleRows, cellText, sortRows, state };`
Tiêu đề hộp thoại xác nhận đóng đợt: thêm "…là số \"KK trước\" cho đợt sau và số \"Kiểm " + otherLabel(...) + "\" của đợt đối chiếu."

- [ ] **Step 4: `stocktake.css`**

```css
.st-table td.st-manual { box-shadow: inset 2px 0 0 var(--accent, #c48a2c); font-style: italic; }
.st-table th .sort-button { width: 100%; justify-content: space-between; }
.st-counterpart select { min-width: 220px; }
.st-paste-mode { display: flex; gap: 16px; border: 0; padding: 0; margin: 0; }
.st-paste-mode legend { font-weight: 600; margin-bottom: 4px; }
.st-paste-preview p { margin: 2px 0; }
#stPasteText { width: 100%; font-family: 'IBM Plex Mono', monospace; font-size: 13px; }
@media (max-width: 720px) { .st-counterpart select { min-width: 0; width: 100%; } }
```
Kiểm `--accent` có trong `shared.css`; nếu không, dùng biến màu nhấn đang dùng ở `stocktake.css` (grep `var(--` trong file).

- [ ] **Step 5: Kiểm cú pháp + test nav**

Run: `node --check public/stocktake/stocktake.js && node --check public/stocktake/stocktakePaste.js && node --test test/frontend/vt-positions-nav.test.js`
Expected: không lỗi; nav PASS

- [ ] **Step 6: Commit**

```bash
git add server/public/stocktake
git commit -m "feat(stocktake): giao dien du cot T10, sort tieu de, doi chieu, dan cot, nap KIEM SG

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Web test bằng dữ liệu thật + kiểm bằng tay

**Files:**
- Create: `C:/Users/chumi/AppData/Local/Temp/claude/D--tks-web/05ed4419-9dfc-44f6-93b5-3a018814821a/scratchpad/stocktake-real-preview.js`
- Modify: `D:/tks_web/.claude/worktrees/inventory-feature-analysis-1ab808/.claude/launch.json` (gitignore; thêm cấu hình `stocktake-real-preview`, cổng 3989)

**Interfaces:**
- Consumes: router/service/import thật; `server/.env` (`SUPABASE_DB_URL`, `GOOGLE_SERVICE_ACCOUNT_JSON`).

- [ ] **Step 1: Dò khoảng ngày kiểm T10 (chỉ đọc)**

Script nhỏ (scratchpad, `NODE_PATH=server/node_modules`), kết nối `pg` với `SUPABASE_DB_URL` (`ssl: { rejectUnauthorized: false }`), `SET default_transaction_read_only = on` rồi:
```sql
SELECT o.branch, (o.order_date AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS d, count(*) AS orders
FROM orders o LEFT JOIN customers c ON c.branch = o.branch AND c.id = o.customer_id
WHERE o.order_date >= '2026-09-25' AND o.order_date < '2026-10-15'
  AND upper(btrim(COALESCE(NULLIF(c.name, ''), o.raw->>'customerName', ''))) LIKE 'TEAM%'
GROUP BY 1, 2 ORDER BY 1, 2;
```
Ghi lại khoảng ngày cho từng cơ sở (ngày có đơn TEAM tập trung quanh 03/10). Nếu SG không có đơn TEAM, ghi nhận để báo người dùng (đợt SG mở sẽ chỉ có Quên KK).

- [ ] **Step 2: Viết script web test**

Dựa trên `stocktake-preview.js` cũ (cùng `USERS`, `/mock/as/:who`, `/api/auth/me`, router với `requireAuth`/`resolveBranch` giả). Khác:
1. Chạy đủ migration như test (`0001…0103`).
2. Kết nối DB thật chỉ đọc (`default_transaction_read_only = on`), chép sang PGlite theo lô 500 dòng bằng `INSERT … SELECT * FROM jsonb_to_recordset`:
   - `products` (`branch, id, code, name, raw`) cả hai cơ sở;
   - `customers` có tên bắt đầu `TEAM` (`branch, id, code, name, raw`);
   - `orders` (`branch, id, code, order_date, customer_id, raw`) và `order_details` (`branch, order_id, line_no, product_id, quantity, raw`) của khách TEAM trong khoảng ngày Step 1;
   - `stock_positions` (`branch, code, location, arrival_date, updated_at`);
   - `hr_employees` đang làm (`id, branch, ho_ten, is_active, employment_status`).
   Đóng kết nối DB thật ngay sau khi chép.
3. Nạp sheet thật qua `createStocktakeSheetImport({ getDb: () => pool })` (đọc `readSheetValuesById` mặc định): `importSheet(ctxQL, { source: 'sg' })` rồi `importSheet(ctxQL, { source: 't10' })`.
4. Tạo 2 đợt mở `Kiểm kê HN (dữ liệu thật)` / `Kiểm kê SG (dữ liệu thật)` theo khoảng ngày Step 1, đối chiếu chéo (`createSession` HN, `createSession` SG với `counterpartSessionId` HN, `updateSession` HN trỏ SG).
5. In ra console: số mã mỗi đợt, tổng giá trị chênh T10 (phải ≈ −242.996.968), tổng giá trị chênh KIỂM SG (≈ −9.085.583 theo dòng tổng của tab).
6. `app.listen(3989)`.

Thêm vào `.claude/launch.json` của worktree:
```json
    {
      "name": "stocktake-real-preview",
      "runtimeExecutable": "node",
      "runtimeArgs": [
        "C:/Users/chumi/AppData/Local/Temp/claude/D--tks-web/05ed4419-9dfc-44f6-93b5-3a018814821a/scratchpad/stocktake-real-preview.js",
        "D:/tks_web/.claude/worktrees/inventory-feature-analysis-1ab808/server"
      ],
      "port": 3989
    }
```

- [ ] **Step 3: Chạy và kiểm trên trình duyệt**

`preview_start { name: 'stocktake-real-preview' }`, rồi kiểm (ghi kết quả từng mục):
1. Đợt T10: 24 cột đúng thứ tự; LUMI3M có E −434, L −326, Q 233%; tổng giá trị chênh khớp sheet; Kiểm SG có số ở các mã có trong KIỂM SG; Do kiểm SG trống khi M = 0.
2. Đợt KIỂM SG: nhãn "Kiểm HN" / "Do kiểm HN"; TYC20C có SL chênh −1.000, KK trước sai 1.900.
3. Sort: bấm Giá trị chênh (tăng/giảm/mặc định), Người kiểm lại (chữ tiếng Việt, ô trống cuối), Combo, Do KK trước (ô trống cuối cả hai chiều); trang 2 nối tiếp đúng thứ tự.
4. Đợt HN mở: Tổng kiểm từng mã so với cột C của T10 (lấy 5 mã ngẫu nhiên + tổng toàn đợt); ghi lệch nếu có.
5. Dán cột: copy 2 cột từ sheet (dán chuỗi tab giả lập qua `form_input`), xem trước số mã khớp/không khớp, lưu, kiểm ô đổi + dấu "dán tay" + lịch sử "Dán cột".
6. Ghi chú: Trang in, Giờ in, KK trước sai tay lưu được; đổi đợt đối chiếu; đóng đợt HN mở rồi xem Kiểm HN trên đợt SG mở cập nhật.
7. Xuất Excel đợt T10: mở file bằng ExcelJS trong script nhỏ, kiểm 24 tiêu đề.
8. Giao diện tối/sáng và độ rộng 375px (resize_window) không vỡ thanh công cụ và hộp thoại dán.
`read_console_messages { onlyErrors: true }` không có lỗi.

- [ ] **Step 4: Sửa lỗi phát hiện (nếu có)** theo superpowers:systematic-debugging, thêm test cho lỗi ở phần server trước khi sửa; commit từng sửa.

---

### Task 9: Tài liệu, test toàn bộ, đồ thị

**Files:**
- Modify: `README.md`, `CURRENT.md`, `server/README.md`, `server/db/SCHEMA.md`, `docs/04-planning/implementation_plan.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `docs/01-brd/BRD_Dashboard_GoogleSheets.md`

- [ ] **Step 1: Cập nhật tài liệu** theo skill `update-file` (`.agents/skills/update-file/SKILL.md`), giữ kiểu xuống dòng của từng file:
  - `server/db/SCHEMA.md` mục Migration 0103: thêm `counterpart_session_id`, `print_page`, `print_time`, `prev_diff_manual`, `other_diff_manual`, `prev_diff`, `other_diff`, action `session_update`, `paste`.
  - `server/README.md`: API `PATCH /api/stocktake/sessions/:id`, `POST /api/stocktake/sessions/:id/paste`, `POST /api/stocktake/import-sheet {source: 't10'|'sg'}`.
  - SRS: FR-ST.2 đủ 23 cột + 3 tỷ lệ; FR-ST.7 Sài Gòn + đối chiếu chéo; FR-ST.8 dán cột.
  - BRD, `implementation_plan.md`, `README.md` (dòng cập nhật gần nhất + cây thư mục thêm `stocktakePaste.js`), `CURRENT.md` (trạng thái + kết quả test).
  - Ngày cập nhật cuối mỗi tài liệu: 02/11/2026.

- [ ] **Step 2: Chạy toàn bộ test**

Run: `npm test` (từ `server/`, chạy nền nếu > 2 phút)
Expected: chỉ còn 6 lỗi có sẵn trên `origin/main` (`vt-positions.test.js` ×3, `account-work-assignment.test.js` ×2, `dashboard-per-view-loading.test.js` ×1) và có thể 1 lỗi chập chờn `vt-positions-live`. Không có lỗi mới. Nếu `npm test` tự build lại `prototypes/order-picking/index.html`, trả file đó về bản đã commit trước khi commit.

- [ ] **Step 3: Cập nhật đồ thị**

Run: `graphify update .` (từ gốc worktree)

- [ ] **Step 4: Commit**

```bash
git add README.md CURRENT.md server/README.md server/db/SCHEMA.md docs graphify-out
git commit -m "docs(stocktake): dong bo tai lieu cot T10, Sai Gon, dan cot

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
