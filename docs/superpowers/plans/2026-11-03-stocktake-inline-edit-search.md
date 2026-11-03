# Kiểm kê: sửa trong ô như sheet + tìm kiếm kiểu tra-cuu-vi-tri — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trên trang `/stocktake/`, sửa 9 cột nhập tay ngay trong ô (gõ / Ctrl+V khối / Delete / kéo nút góc / Ctrl+Z), giữ thứ tự dòng khi sửa, và tìm kiếm theo thuật toán tool `D:\tra-cuu\tra-cuu-vi-tri`.

**Architecture:** Mọi thao tác ghi đi qua một endpoint mới `POST /api/stocktake/sessions/:id/cells` (danh sách `{code, column, value, expected}`), dùng lại `nextRecord` / `sameRecord` / `upsertNotes` / `upsertTags` của "Dán cột"; lịch sử ghi bằng action `'paste'` có sẵn với `source: 'cells'` nên **không có migration**. Logic thuần (so giá trị cột, tách TSV, tính ô dán / ô kéo, chuẩn hóa + xếp hạng tìm kiếm) nằm trong 3 module UMD dùng chung trình duyệt + Node để test bằng `node:test`; `stocktake.js` chỉ lo DOM.

**Tech Stack:** Node 24, Express, CommonJS, vanilla JS/CSS, PGlite + `node:test`, Fuse.js 7.1.0 (UMD, lưu sẵn).

**Spec:** `docs/superpowers/specs/2026-11-03-stocktake-inline-edit-search-design.md`

## Global Constraints

- Làm trên nhánh `claude/inventory-feature-analysis-1ab808` (PR #27); không commit thẳng `main`.
- Không migration mới; không ghi DB thật / sheet thật (chỉ PGlite và server test `stocktake-real-preview`).
- 9 cột sửa được, ánh xạ cố định: `status→statusText`, `reason→reasonText`, `printPage→printPage`, `printTime→printTime`, `recheck→recheck`, `prevDiff→prevDiffManual`, `otherDiff→otherDiffManual`, `cluster→cluster`, `combo→combo`.
- Tối đa 10.000 ô mỗi request (`MAX_PASTE_ROWS`).
- Undo tối đa 50 bước, chỉ trong bộ nhớ trang.
- Tìm kiếm: Fuse `threshold 0.36, distance 100, ignoreLocation true, minMatchCharLength 2`, trọng số mã 0.25 / tên 0.60 / phụ 0.15; mức 1–7 không cắt; Fuse chỉ bù tới tổng 100 dòng.
- Fuse.js **7.1.0** `dist/fuse.min.js` (7.5.0 mà tool ghi không có bản UMD cho trình duyệt; đã kiểm tra trên jsdelivr 03/11/2026).
- Vanilla JS, không framework; giữ Light/Dark (dùng biến CSS sẵn có).
- Chạy test từ thư mục `server/`: Node 24 không chạy `node --test <thư mục>`, phải truyền tên tệp.
- Commit kết thúc bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| Tệp | Trách nhiệm |
|---|---|
| `server/public/stocktake/stocktakePaste.js` (sửa) | Thêm `columnValue`, `sameValue`, `rawOf`; `normalizeValue` nhận số thật cho cột số. |
| `server/public/stocktake/stocktakeSearch.js` (mới) | `normalizeText`, `normalizeCode`, `buildIndex`, `search`. |
| `server/public/vendor/fuse.min.js` (mới) | Fuse.js 7.1.0 UMD. |
| `server/public/stocktake/stocktakeGrid.js` (mới) | `EDIT_COLUMNS`, `parseClipboard`, `planPaste`, `planFill`, `moveIndex`. |
| `server/stocktake/stocktakeService.js` (sửa) | `saveCells`; tách `insertPasteHistory` dùng chung với `pasteColumn`. |
| `server/stocktake/stocktakeRoutes.js` (sửa) | `POST /api/stocktake/sessions/:id/cells`. |
| `server/public/stocktake/stocktake.js` (sửa) | Gọi tìm kiếm, giữ thứ tự, ô nhập, phím, dán, kéo, undo, nhãn lịch sử. |
| `server/public/stocktake/stocktake.css` (sửa) | `.st-editor`, `.st-fill`, `.st-fill-preview`, con trỏ ô sửa được. |
| `server/public/stocktake/index.html` (sửa) | Nạp 3 script mới, tăng `?v=`. |
| Tests | `server/stocktake/stocktakePaste.test.js`, `stocktakeSearch.test.js` (mới), `stocktakeGrid.test.js` (mới), `stocktakeService.test.js`, `stocktakeRoutes.test.js`. |

---

### Task 1: Hàm giá trị cột dùng chung (`stocktakePaste.js`)

**Files:**
- Modify: `server/public/stocktake/stocktakePaste.js`
- Test: `server/stocktake/stocktakePaste.test.js`

**Interfaces:**
- Produces:
  - `columnValue(column: string, note: object|null, tag: {cluster, isCombo}|null, nameOf: (id) => string): string|number|null|boolean` — giá trị hiện tại cùng dạng `normalizeValue().value` (chữ; số hoặc `null` cho 2 cột số tay; boolean cho combo; tên hiển thị cho recheck).
  - `sameValue(column, a, b): boolean` — so theo kiểu cột (số: `===` sau `?? null`; combo: boolean; recheck: `foldName`; chữ: `clean`).
  - `rawOf(column, value): string|number` — đảo `normalizeValue` để gửi lại khi hoàn tác (combo → `'x'`/`''`; `null` → `''`; số giữ kiểu number; chữ giữ nguyên).
  - `normalizeValue(column, raw)` nhận thêm `raw` kiểu number cho cột số (không qua `parseVnNumber`, tránh `1.234` bị hiểu là 1234).

- [ ] **Step 1: Viết test hỏng** — thêm vào cuối `server/stocktake/stocktakePaste.test.js`:

```js
test('columnValue / sameValue / rawOf: dang gia tri cot dung chung trinh duyet + server', () => {
  const { columnValue, sameValue, rawOf } = require('../public/stocktake/stocktakePaste');
  const note = { statusText: 'mất', reasonText: '', printPage: '12', printTime: '', recheckEmployeeId: 502, recheckName: '', prevDiffManual: -1234, otherDiffManual: null };
  const nameOf = id => (id === 502 ? 'Thái Kho' : '');
  assert.equal(columnValue('statusText', note, null, nameOf), 'mất');
  assert.equal(columnValue('reasonText', null, null, nameOf), '');
  assert.equal(columnValue('recheck', note, null, nameOf), 'Thái Kho');
  assert.equal(columnValue('recheck', { recheckEmployeeId: null, recheckName: 'CẬN' }, null, nameOf), 'CẬN');
  assert.equal(columnValue('prevDiffManual', note, null, nameOf), -1234);
  assert.equal(columnValue('otherDiffManual', note, null, nameOf), null);
  assert.equal(columnValue('otherDiffManual', null, null, nameOf), null);
  assert.equal(columnValue('cluster', null, { cluster: 'Cụm 1', isCombo: true }, nameOf), 'Cụm 1');
  assert.equal(columnValue('combo', null, { cluster: '', isCombo: true }, nameOf), true);
  assert.equal(columnValue('combo', null, null, nameOf), false);

  assert.equal(sameValue('statusText', ' mất  ', 'mất'), true);
  assert.equal(sameValue('recheck', 'thai kho', 'Thái Kho'), true);
  assert.equal(sameValue('prevDiffManual', null, undefined), true);
  assert.equal(sameValue('prevDiffManual', 0, null), false);
  assert.equal(sameValue('combo', false, ''), true);
  assert.equal(sameValue('bogus', 'a', 'a'), false);

  assert.equal(rawOf('combo', true), 'x');
  assert.equal(rawOf('combo', false), '');
  assert.equal(rawOf('prevDiffManual', null), '');
  assert.equal(rawOf('prevDiffManual', 1.234), 1.234);
  assert.equal(rawOf('statusText', 'mất'), 'mất');
});

test('normalizeValue: so that cho cot so khong qua parseVnNumber', () => {
  assert.deepEqual(normalizeValue('prevDiffManual', 1.234), { ok: true, value: 1.234, empty: false });
  assert.deepEqual(normalizeValue('prevDiffManual', '1.234'), { ok: true, value: 1234, empty: false });
  assert.equal(normalizeValue('prevDiffManual', Infinity).ok, false);
  assert.equal(normalizeValue('prevDiffManual', 1e13).ok, false);
});
```

- [ ] **Step 2: Chạy để thấy hỏng**

Run (trong `server/`): `node --test stocktake/stocktakePaste.test.js`
Expected: FAIL — `columnValue is not a function` và `normalizeValue('prevDiffManual', 1.234)` trả `value: 1234`.

- [ ] **Step 3: Viết code** — trong `server/public/stocktake/stocktakePaste.js`:

Trong `normalizeValue`, ngay sau dòng `if (!spec) return { ok: false };` thêm:

```js
    // Hoan tac gui lai so that (vd 1.234): khong doc lai bang parseVnNumber (se thanh 1234).
    if (spec.kind === 'number' && typeof raw === 'number') {
      return Number.isFinite(raw) && Math.abs(raw) <= MAX_ABS ? { ok: true, value: raw, empty: false } : { ok: false };
    }
```

Thêm 3 hàm ngay trước dòng `// Dong dau la tieu de khi o ma ...`:

```js
  // Gia tri hien tai cua 1 cot dan tren 1 ma, cung dang normalizeValue().value.
  // note: ban ghi ghi chu (hoac null), tag: { cluster, isCombo } (hoac null), nameOf: id nhan su -> ten.
  function columnValue(column, note, tag, nameOf = () => '') {
    const n = note || {};
    switch (column) {
      case 'recheck': {
        const id = n.recheckEmployeeId;
        return (id !== null && id !== undefined && nameOf(id)) || n.recheckName || '';
      }
      case 'cluster': return (tag && tag.cluster) || '';
      case 'combo': return Boolean(tag && tag.isCombo);
      case 'prevDiffManual': case 'otherDiffManual': return n[column] === null || n[column] === undefined ? null : n[column];
      default: return n[column] || '';
    }
  }

  function sameValue(column, a, b) {
    const spec = PASTE_COLUMNS[column];
    if (!spec) return false;
    if (spec.kind === 'number') return (a ?? null) === (b ?? null);
    if (spec.kind === 'combo') return Boolean(a) === Boolean(b);
    if (spec.kind === 'recheck') return foldName(a) === foldName(b);
    return clean(a) === clean(b);
  }

  // Nguoc cua normalizeValue: gia tri -> du lieu tho gui lai server (hoan tac).
  function rawOf(column, value) {
    const spec = PASTE_COLUMNS[column];
    if (spec && spec.kind === 'combo') return value ? 'x' : '';
    if (value === null || value === undefined) return '';
    return spec && spec.kind === 'number' ? value : String(value);
  }
```

Sửa dòng `return { ... }` cuối module thành:

```js
  return { PASTE_COLUMNS, STATUS_COLORS, codeKey, foldName, parseVnNumber, parseComboFlag, normalizeValue, parsePasteText, columnValue, sameValue, rawOf };
```

- [ ] **Step 4: Chạy để thấy đạt**

Run: `node --test stocktake/stocktakePaste.test.js`
Expected: PASS toàn bộ (test cũ + 2 test mới).

- [ ] **Step 5: Commit**

```bash
git add server/public/stocktake/stocktakePaste.js server/stocktake/stocktakePaste.test.js
git commit -m "feat(kiem-ke): ham gia tri cot dung chung cho sua tren bang va hoan tac

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Module tìm kiếm + Fuse.js

**Files:**
- Create: `server/public/vendor/fuse.min.js`
- Create: `server/public/stocktake/stocktakeSearch.js`
- Test: `server/stocktake/stocktakeSearch.test.js`

**Interfaces:**
- Produces (`window.TKSStocktakeSearch` / `require`):
  - `normalizeText(value): string`, `normalizeCode(value): string`
  - `buildIndex(items: Array<{row, code, name, extra}>, { Fuse }?): Index` — `Fuse` là class Fuse (bỏ qua nếu không phải function).
  - `search(index: Index, query: string): Array<row>` — query rỗng trả mọi `row` theo thứ tự đưa vào.
  - `FUZZY_LIMIT = 100`

- [ ] **Step 1: Tải Fuse.js 7.1.0**

```bash
curl -sSfL "https://cdn.jsdelivr.net/npm/fuse.js@7.1.0/dist/fuse.min.js" -o server/public/vendor/fuse.min.js
head -c 120 server/public/vendor/fuse.min.js
node -e "const F=require('./server/public/vendor/fuse.min.js'); const C=F.default||F; console.log(typeof C, new C([{a:'bang keo'}],{keys:['a']}).search('bang').length)"
```

Expected: dòng đầu `/**\n * Fuse.js v7.1.0`, rồi `function 1`. Tệp giữ nguyên header bản quyền Apache-2.0.

- [ ] **Step 2: Viết test hỏng** — tạo `server/stocktake/stocktakeSearch.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeText, normalizeCode, buildIndex, search, FUZZY_LIMIT } = require('../public/stocktake/stocktakeSearch');
const FuseModule = require('../public/vendor/fuse.min.js');
const Fuse = FuseModule.default || FuseModule;

const item = (code, name, extra = '') => ({ row: { code }, code, name, extra });
const codes = rows => rows.map(row => row.code);

test('chuan hoa giong tra-cuu-vi-tri: bo dau, tach so khoi chu, bo ky tu la', () => {
  assert.equal(normalizeText('Băng keo chống thấm 20cm (T9) (10KG)'), 'bang keo chong tham 20 cm t 9 10 kg');
  assert.equal(normalizeText('  Đèn LED-12V  '), 'den led 12 v');
  assert.equal(normalizeCode(' bk-20 '), 'bk20');
  assert.equal(normalizeCode('Đ.10'), 'd10');
});

test('"băng keo 10kg" ra dung san pham du cac tu nam lon xon', () => {
  const index = buildIndex([item('BK20', 'Băng keo chống thấm 20cm (T9) (10KG)'), item('KEO1', 'Keo dán sắt 1kg')], { Fuse });
  assert.equal(search(index, 'băng keo 10kg')[0].code, 'BK20');
  assert.equal(search(index, 'BANG KEO 10 KG')[0].code, 'BK20');
});

test('thu tu muc khop 1-7 nhu tool', () => {
  const index = buildIndex([
    item('ZZ1', 'Có chứa bk10 ở giữa'),   // 6: ten chua nguyen cum (bk 10)
    item('XBK10', 'Hàng X'),              // 5: ma chua
    item('BK10A', 'Hàng A'),              // 3: ma bat dau bang
    item('Q1', 'bk10 đầu tên'),           // 4: ten bat dau bang
    item('BK10', 'Hàng gốc'),             // 1: ma khop dung
    item('Q2', 'bk 10'),                  // 2: ten khop dung
    item('Q3', 'Hàng', 'cụm bk ghi chú 10') // 7: du moi tu trong ten + phu
  ]);
  assert.deepEqual(codes(search(index, 'bk10')), ['BK10', 'Q2', 'BK10A', 'Q1', 'XBK10', 'ZZ1', 'Q3']);
});

test('muc 1-7 khong bi cat 100; Fuse chi bu toi tong 100', () => {
  const many = Array.from({ length: 150 }, (_, i) => item('K' + i, 'Keo dán số ' + i));
  assert.equal(search(buildIndex(many, { Fuse }), 'keo').length, 150);

  const few = Array.from({ length: 98 }, (_, i) => item('B' + i, 'Băng keo loại ' + i));
  const typos = Array.from({ length: 10 }, (_, i) => item('T' + i, 'Bnag keoo ' + i));
  const result = search(buildIndex([...few, ...typos], { Fuse }), 'bang keo');
  assert.equal(result.length, FUZZY_LIMIT);
  assert.deepEqual(codes(result.slice(0, 98)), codes(few.map(x => x.row)));
  assert.ok(result.slice(98).every(row => row.code.startsWith('T')));
});

test('go sai chinh ta: Fuse van ra; khong co Fuse thi chi muc 1-7', () => {
  const rows = [item('BK20', 'Băng keo chống thấm'), item('DN1', 'Đèn ngủ')];
  assert.deepEqual(codes(search(buildIndex(rows, { Fuse }), 'bang keoo')), ['BK20']);
  assert.deepEqual(codes(search(buildIndex(rows), 'bang keoo')), []);
  assert.deepEqual(codes(search(buildIndex(rows), 'bang keo')), ['BK20']);
});

test('tu khoa rong: tra moi dong theo thu tu dua vao', () => {
  const index = buildIndex([item('A', 'a'), item('B', 'b')], { Fuse });
  assert.deepEqual(codes(search(index, '   ')), ['A', 'B']);
});
```

- [ ] **Step 3: Chạy để thấy hỏng**

Run: `node --test stocktake/stocktakeSearch.test.js`
Expected: FAIL — `Cannot find module '../public/stocktake/stocktakeSearch'`.

- [ ] **Step 4: Viết code** — tạo `server/public/stocktake/stocktakeSearch.js`:

```js
/* Tim kiem trang Kiem ke, chuyen tu tool tra-cuu-vi-tri (Index.html: normalizeText / searchProducts).
   Dung chung trinh duyet (window.TKSStocktakeSearch) va Node (test). Fuse.js truyen vao tu ngoai (window.Fuse). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakeSearch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Khop mo chi bu cho du FUZZY_LIMIT dong; khop chac chan (muc 1-7) khong bi cat.
  const FUZZY_LIMIT = 100;
  const FUSE_OPTIONS = Object.freeze({
    includeScore: true, shouldSort: true, threshold: 0.36, distance: 100, ignoreLocation: true, minMatchCharLength: 2,
    keys: [{ name: 'code', weight: 0.25 }, { name: 'name', weight: 0.60 }, { name: 'extra', weight: 0.15 }]
  });

  const strip = value => String(value ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd');
  // "Băng keo 20cm (T9) (10KG)" -> "bang keo 20 cm t 9 10 kg"
  function normalizeText(value) {
    return strip(value)
      .replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const normalizeCode = value => strip(value).replace(/[^a-z0-9]+/g, '');

  // Chuan hoa 1 lan khi tai bang, khong lam lai moi lan go.
  function buildIndex(items, { Fuse } = {}) {
    const entries = items.map((item, order) => {
      const name = normalizeText(item.name);
      const extra = normalizeText(item.extra);
      return { row: item.row, code: normalizeCode(item.code), name, extra, text: [name, extra].filter(Boolean).join(' '), order };
    });
    return { entries, fuse: typeof Fuse === 'function' ? new Fuse(entries, FUSE_OPTIONS) : null };
  }

  // 1 ma dung · 2 ten dung · 3 ma bat dau · 4 ten bat dau · 5 ma chua · 6 ten chua ca cum · 7 du moi tu · roi Fuse.
  function rank(entry, queryText, queryCode, tokens) {
    const { code, name, text } = entry;
    if (queryCode && code === queryCode) return [1, code.length];
    if (queryText && name === queryText) return [2, name.length];
    if (queryCode && code.startsWith(queryCode)) return [3, code.length];
    if (queryText && name.startsWith(queryText)) return [4, name.length];
    if (queryCode && code.includes(queryCode)) return [5, code.indexOf(queryCode)];
    if (queryText && name.includes(queryText)) return [6, name.indexOf(queryText)];
    if (tokens.length && tokens.every(token => text.includes(token))) return [7, tokens.reduce((sum, token) => sum + text.indexOf(token), 0)];
    return null;
  }

  function search(index, query) {
    const queryText = normalizeText(query);
    const queryCode = normalizeCode(query);
    if (!queryText && !queryCode) return index.entries.map(entry => entry.row);
    const tokens = queryText.split(' ').filter(Boolean);
    const ranked = [];
    for (const entry of index.entries) {
      const hit = rank(entry, queryText, queryCode, tokens);
      if (hit) ranked.push({ entry, priority: hit[0], tie: hit[1] });
    }
    ranked.sort((a, b) => a.priority - b.priority || a.tie - b.tie || a.entry.order - b.entry.order);
    const result = ranked.map(item => item.entry.row);
    if (index.fuse && result.length < FUZZY_LIMIT) {
      const seen = new Set(ranked.map(item => item.entry));
      const fuzzy = new Map();
      const add = value => {
        if (!value) return;
        for (const hit of index.fuse.search(value, { limit: FUZZY_LIMIT * 2 })) {
          if (seen.has(hit.item)) continue;
          const score = hit.score ?? 1;
          const old = fuzzy.get(hit.item);
          if (old === undefined || score < old) fuzzy.set(hit.item, score);
        }
      };
      add(queryText);
      if (queryCode !== queryText) add(queryCode);
      const extra = [...fuzzy].sort((a, b) => a[1] - b[1] || a[0].order - b[0].order).slice(0, FUZZY_LIMIT - result.length);
      result.push(...extra.map(([entry]) => entry.row));
    }
    return result;
  }

  return { FUZZY_LIMIT, normalizeText, normalizeCode, buildIndex, search };
});
```

- [ ] **Step 5: Chạy để thấy đạt**

Run: `node --test stocktake/stocktakeSearch.test.js`
Expected: PASS 6/6. Nếu test "thu tu muc khop" lệch: in `search(index,'bk10')` ra so với chú thích từng dòng — sửa dữ liệu test cho đúng mức, **không** đổi thứ tự mức trong `rank`. Nếu test "Fuse chi bu toi tong 100" lệch vì Fuse không khớp đủ 2 dòng "Bnag keoo" (điểm Fuse phụ thuộc phiên bản): in `index.fuse.search('bang keo')` ra, đổi tên dòng gõ sai cho gần hơn (vd. "Bang keoo"), **không** nới `threshold`.

- [ ] **Step 6: Commit**

```bash
git add server/public/vendor/fuse.min.js server/public/stocktake/stocktakeSearch.js server/stocktake/stocktakeSearch.test.js
git commit -m "feat(kiem-ke): module tim kiem kieu tra-cuu-vi-tri + Fuse.js 7.1.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Module lưới thuần (`stocktakeGrid.js`)

**Files:**
- Create: `server/public/stocktake/stocktakeGrid.js`
- Test: `server/stocktake/stocktakeGrid.test.js`

**Interfaces:**
- Produces (`window.TKSStocktakeGrid` / `require`):
  - `EDIT_COLUMNS: { [tableKey]: pasteColumn }` (9 cột, xem Global Constraints)
  - `parseClipboard(text: string): string[][]`
  - `planPaste(block: string[][], rect: {top,bottom,left,right}, { rowCount, visibleCols: number[] }): Array<{row, col, raw}>`
  - `planFill(rect, to: number, cols: number[]): Array<{row, col, fromRow}>`
  - `moveIndex(list: number[], current: number, step: number): number` — phần tử kế bên trong `list` (danh sách cột đang hiện), kẹp ở hai đầu.

- [ ] **Step 1: Viết test hỏng** — tạo `server/stocktake/stocktakeGrid.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EDIT_COLUMNS, parseClipboard, planPaste, planFill, moveIndex } = require('../public/stocktake/stocktakeGrid');
const { PASTE_COLUMNS } = require('../public/stocktake/stocktakePaste');

test('EDIT_COLUMNS: 9 cot, deu la cot dan hop le', () => {
  assert.equal(Object.keys(EDIT_COLUMNS).length, 9);
  for (const column of Object.values(EDIT_COLUMNS)) assert.ok(PASTE_COLUMNS[column], column);
});

test('parseClipboard: tab / xuong dong, CRLF, dong trong cuoi, o boc ngoac kep', () => {
  assert.deepEqual(parseClipboard('a\tb\r\nc\td\r\n'), [['a', 'b'], ['c', 'd']]);
  assert.deepEqual(parseClipboard('mot'), [['mot']]);
  assert.deepEqual(parseClipboard(''), []);
  assert.deepEqual(parseClipboard('"dong 1\ndong 2"\tx\n"co ""ngoac"""\ty'), [['dong 1 dong 2', 'x'], ['co "ngoac"', 'y']]);
  assert.deepEqual(parseClipboard('a\t\tc'), [['a', '', 'c']]);
});

test('planPaste: khoi tu o tren-trai, bo cot an, bo dong vuot cuoi', () => {
  const rect = { top: 3, bottom: 3, left: 6, right: 6 };
  const targets = planPaste([['x', 'y', 'z'], ['p', 'q', 'r']], rect, { rowCount: 5, visibleCols: [0, 1, 6, 8, 9] });
  assert.deepEqual(targets, [
    { row: 3, col: 6, raw: 'x' }, { row: 3, col: 8, raw: 'y' }, { row: 3, col: 9, raw: 'z' },
    { row: 4, col: 6, raw: 'p' }, { row: 4, col: 8, raw: 'q' }, { row: 4, col: 9, raw: 'r' }
  ]);
  assert.deepEqual(planPaste([['a'], ['b'], ['c']], { top: 4, bottom: 4, left: 6, right: 6 }, { rowCount: 5, visibleCols: [6] }), [{ row: 4, col: 6, raw: 'a' }]);
  assert.deepEqual(planPaste([['a', 'b']], { top: 0, bottom: 0, left: 9, right: 9 }, { rowCount: 5, visibleCols: [6, 9] }), [{ row: 0, col: 9, raw: 'a' }]);
  assert.deepEqual(planPaste([], rect, { rowCount: 5, visibleCols: [6] }), []);
});

test('planPaste: 1 o vao vung nhieu o thi dien ca vung (bo cot an)', () => {
  const targets = planPaste([['ok']], { top: 1, bottom: 2, left: 6, right: 8 }, { rowCount: 10, visibleCols: [6, 8] });
  assert.deepEqual(targets, [{ row: 1, col: 6, raw: 'ok' }, { row: 1, col: 8, raw: 'ok' }, { row: 2, col: 6, raw: 'ok' }, { row: 2, col: 8, raw: 'ok' }]);
});

test('planFill: keo xuong / len lap mau theo vong, giu cot', () => {
  const rect = { top: 2, bottom: 3, left: 6, right: 6 };
  assert.deepEqual(planFill(rect, 6, [6]), [
    { row: 4, col: 6, fromRow: 2 }, { row: 5, col: 6, fromRow: 3 }, { row: 6, col: 6, fromRow: 2 }
  ]);
  assert.deepEqual(planFill(rect, 0, [6]), [{ row: 1, col: 6, fromRow: 3 }, { row: 0, col: 6, fromRow: 2 }]);
  assert.deepEqual(planFill(rect, 3, [6]), []);
  assert.deepEqual(planFill({ top: 0, bottom: 0, left: 6, right: 8 }, 1, [6, 8]), [{ row: 1, col: 6, fromRow: 0 }, { row: 1, col: 8, fromRow: 0 }]);
});

test('moveIndex: di trong cot dang hien, kep hai dau', () => {
  assert.equal(moveIndex([0, 1, 6, 8], 1, 1), 6);
  assert.equal(moveIndex([0, 1, 6, 8], 8, 1), 8);
  assert.equal(moveIndex([0, 1, 6, 8], 0, -1), 0);
  assert.equal(moveIndex([0, 1, 6, 8], 7, 1), 8, 'cot hien tai bi an: lay cot hien gan nhat ben phai');
  assert.equal(moveIndex([0, 1, 6, 8], 7, -1), 6);
});
```

- [ ] **Step 2: Chạy để thấy hỏng**

Run: `node --test stocktake/stocktakeGrid.test.js`
Expected: FAIL — `Cannot find module '../public/stocktake/stocktakeGrid'`.

- [ ] **Step 3: Viết code** — tạo `server/public/stocktake/stocktakeGrid.js`:

```js
/* Phan thuan (khong DOM) cua viec sua tren bang Kiem ke: cot sua duoc, tach du lieu dan, tinh o dan / o keo.
   Dung chung trinh duyet (window.TKSStocktakeGrid) va Node (test). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakeGrid = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Khoa cot bang (COLUMNS.key) -> cot dan (PASTE_COLUMNS) ma /cells hieu.
  const EDIT_COLUMNS = Object.freeze({
    status: 'statusText', reason: 'reasonText', printPage: 'printPage', printTime: 'printTime', recheck: 'recheck',
    prevDiff: 'prevDiffManual', otherDiff: 'otherDiffManual', cluster: 'cluster', combo: 'combo'
  });

  // TSV tu Google Sheets: o co tab / xuong dong duoc boc "..." ("" = 1 dau ngoac kep). Xuong dong trong o -> dau cach.
  function parseClipboard(text) {
    const source = String(text ?? '').replace(/\r\n?/g, '\n');
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (quoted) {
        if (ch === '"' && source[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"' && cell === '') quoted = true;
      else if (ch === '\t') { row.push(cell); cell = ''; }
      else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows.map(cells => cells.map(value => value.replace(/[\t\n]+/g, ' ')));
  }

  // Khoi dan -> o dich. 1 o + vung nhieu o = dien ca vung; con lai dat khoi tu o tren-trai, bo cot an, bo dong vuot cuoi.
  function planPaste(block, rect, { rowCount, visibleCols }) {
    if (!block.length) return [];
    const inRect = visibleCols.filter(col => col >= rect.left && col <= rect.right);
    if (!inRect.length) return [];
    const targets = [];
    if (block.length === 1 && block[0].length === 1 && (rect.bottom > rect.top || inRect.length > 1)) {
      for (let row = rect.top; row <= Math.min(rect.bottom, rowCount - 1); row++) {
        for (const col of inRect) targets.push({ row, col, raw: block[0][0] });
      }
      return targets;
    }
    const start = visibleCols.indexOf(inRect[0]);
    block.forEach((cells, i) => {
      const row = rect.top + i;
      if (row >= rowCount) return;
      cells.forEach((raw, j) => {
        const col = visibleCols[start + j];
        if (col !== undefined) targets.push({ row, col, raw });
      });
    });
    return targets;
  }

  // Keo nut goc tu vung rect toi dong `to`: moi dong moi lay dong nguon theo vong, dem tu mep vung chon ra ngoai.
  function planFill(rect, to, cols) {
    const height = rect.bottom - rect.top + 1;
    const pairs = [];
    if (to > rect.bottom) for (let row = rect.bottom + 1; row <= to; row++) pairs.push([row, rect.top + ((row - rect.bottom - 1) % height)]);
    else if (to < rect.top) for (let row = rect.top - 1; row >= to; row--) pairs.push([row, rect.bottom - ((rect.top - 1 - row) % height)]);
    const targets = [];
    for (const [row, fromRow] of pairs) {
      for (const col of cols) if (col >= rect.left && col <= rect.right) targets.push({ row, col, fromRow });
    }
    return targets;
  }

  // Cot ke ben trong danh sach cot dang hien (tang dan); cot hien tai bi an thi lay cot hien gan nhat theo huong di.
  function moveIndex(list, current, step) {
    if (!list.length) return current;
    let at = list.indexOf(current);
    if (at === -1) {
      const next = list.findIndex(col => col > current);
      if (step > 0) return next === -1 ? list[list.length - 1] : list[next];
      return next === -1 ? list[list.length - 1] : list[Math.max(0, next - 1)];
    }
    at = Math.max(0, Math.min(list.length - 1, at + step));
    return list[at];
  }

  return { EDIT_COLUMNS, parseClipboard, planPaste, planFill, moveIndex };
});
```

- [ ] **Step 4: Chạy để thấy đạt**

Run: `node --test stocktake/stocktakeGrid.test.js`
Expected: PASS 6/6.

- [ ] **Step 5: Commit**

```bash
git add server/public/stocktake/stocktakeGrid.js server/stocktake/stocktakeGrid.test.js
git commit -m "feat(kiem-ke): module luoi thuan cho dan khoi, keo nhan ban, di chuyen o

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Endpoint `POST /sessions/:id/cells`

**Files:**
- Modify: `server/stocktake/stocktakeService.js` (import dòng 9; `pasteColumn` ~606–650; export dòng 721)
- Modify: `server/stocktake/stocktakeRoutes.js` (sau route `/paste`, ~dòng 110)
- Test: `server/stocktake/stocktakeService.test.js`, `server/stocktake/stocktakeRoutes.test.js`

**Interfaces:**
- Consumes: `columnValue`, `sameValue` (Task 1).
- Produces: `service.saveCells(ctx, sessionId, { cells: Array<{code, column, value, expected?}> })` →
  `{ applied: Array<{code, column, before, after}>, conflicts: Array<{code, column, current}>, skipped: { notFound, invalid, unchanged } }`
  (`before`/`after`/`current` cùng dạng `columnValue`). HTTP: `POST /api/stocktake/sessions/:id/cells` cần quyền `edit`, trả JSON trên.

- [ ] **Step 1: Viết test service hỏng** — thêm vào cuối `server/stocktake/stocktakeService.test.js`:

```js
test('sua tren bang: nhieu cot cung ma (ghi chu + tag) 1 giao dich, ma la / gia tri sai, lich su source cells', async () => {
  const { db, service, session, announced } = await fixture();
  await db.exec(`INSERT INTO hr_employees (id, branch, ho_ten) VALUES (502, 'hanoi', 'Thái Kho')`);
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });
  const result = await cells([
    { code: 'aaa1', column: 'statusText', value: 'mất', expected: '' },
    { code: 'AAA1', column: 'reasonText', value: 'lý do', expected: '' },
    { code: 'AAA1', column: 'cluster', value: 'Cụm 1', expected: '' },
    { code: 'AAA1', column: 'combo', value: 'x', expected: false },
    { code: 'AAA1', column: 'recheck', value: 'thai kho', expected: '' },
    { code: 'AAA1', column: 'prevDiffManual', value: '-1.234', expected: null },
    { code: 'ZZZ9', column: 'statusText', value: 'x' },
    { code: 'BBB2', column: 'otherDiffManual', value: 'abc' }
  ]);
  assert.deepEqual(result.skipped, { notFound: 1, invalid: 1, unchanged: 0 });
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.applied.map(a => [a.code, a.column, a.before, a.after]), [
    ['AAA1', 'statusText', '', 'mất'], ['AAA1', 'reasonText', '', 'lý do'], ['AAA1', 'cluster', '', 'Cụm 1'],
    ['AAA1', 'combo', false, true], ['AAA1', 'recheck', '', 'Thái Kho'], ['AAA1', 'prevDiffManual', null, -1234]
  ]);
  assert.equal(announced.at(-1), session.id);
  const a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.note.statusText, a.note.reasonText, a.cluster, a.isCombo, a.note.recheckEmployeeId, a.prevDiff, a.prevDiffManual],
    ['mất', 'lý do', 'Cụm 1', true, 502, -1234, true]);
  const { history } = await service.codeHistory(ctx(), session.id, 'AAA1');
  const own = history.filter(h => h.action === 'paste' && h.after.source === 'cells');
  assert.equal(own.length, 6);
  assert.ok(own.some(h => h.after.column === 'cluster' && h.after.cluster === 'Cụm 1'));
});

test('sua tren bang: expected lech -> conflict khong ghi, o khac van ghi; hoan tac; trong = xoa; so that; o lap', async () => {
  const { service, session } = await fixture();
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });
  await cells([{ code: 'AAA1', column: 'statusText', value: 'mất', expected: '' }, { code: 'AAA1', column: 'combo', value: 'x', expected: false }]);
  let a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  await service.saveNote(ctx(HUNG), session.id, 'AAA1', { statusText: 'Hưng sửa', statusColor: 'red', version: a.note.version });

  let result = await cells([
    { code: 'AAA1', column: 'statusText', value: 'của tôi', expected: 'mất' },
    { code: 'AAA1', column: 'printPage', value: '12', expected: '' }
  ]);
  assert.deepEqual(result.conflicts, [{ code: 'AAA1', column: 'statusText', current: 'Hưng sửa' }]);
  assert.deepEqual(result.applied.map(x => x.column), ['printPage']);
  a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.note.statusText, a.note.statusColor, a.note.printPage], ['Hưng sửa', 'red', '12'], 'mau trang thai giu nguyen');

  // hoan tac: gui lai before, expected = after
  result = await cells([{ code: 'AAA1', column: 'combo', value: '', expected: true }, { code: 'AAA1', column: 'printPage', value: '', expected: '12' }]);
  assert.deepEqual(result.applied.map(x => [x.column, x.after]), [['combo', false], ['printPage', '']], 'theo thu tu gui');
  a = rowOf(await service.getBoard(ctx(), session.id), 'AAA1');
  assert.deepEqual([a.isCombo, a.note.printPage], [false, '']);

  // so that tu hoan tac khong bi doc thanh nghin; khong expected = khong kiem; o lap lay o cuoi; khong doi = unchanged
  result = await cells([
    { code: 'BBB2', column: 'otherDiffManual', value: 1.234 },
    { code: 'BBB2', column: 'statusText', value: 'cu' },
    { code: 'bbb2', column: 'statusText', value: 'moi' },
    { code: 'AAA1', column: 'statusText', value: 'Hưng sửa' }
  ]);
  assert.deepEqual(result.skipped, { notFound: 0, invalid: 0, unchanged: 1 });
  const b = rowOf(await service.getBoard(ctx(), session.id), 'BBB2');
  assert.deepEqual([b.otherDiff, b.note.statusText], [1.234, 'moi']);
});

test('sua tren bang: kiem tra dau vao, dot da dong', async () => {
  const { service, session } = await fixture();
  const send = body => service.saveCells(ctx(), session.id, body);
  await assert.rejects(send({ cells: [] }), { statusCode: 400 });
  await assert.rejects(send({}), { statusCode: 400 });
  await assert.rejects(send({ cells: Array(10001).fill({ code: 'AAA1', column: 'statusText', value: 'x' }) }), { statusCode: 400 });
  await assert.rejects(send({ cells: [{ code: 'AAA1', column: 'bogus', value: 'x' }] }), { statusCode: 400 });
  const fresh = await service.getBoard(ctx(), session.id);
  await service.closeSession(ctx(), session.id, { version: fresh.session.version });
  await assert.rejects(send({ cells: [{ code: 'AAA1', column: 'statusText', value: 'x' }] }), { statusCode: 409, code: 'STOCKTAKE_CLOSED' });
});
```

Ghi chú: `applied` theo thứ tự gặp đầu tiên của từng khóa (mã, cột) — `latest` là `Map` giữ thứ tự chèn lần đầu, ô lặp chỉ thay giá trị.

- [ ] **Step 2: Chạy để thấy hỏng**

Run: `node --test stocktake/stocktakeService.test.js`
Expected: FAIL 3 test mới — `service.saveCells is not a function`.

- [ ] **Step 3: Viết code service** — trong `server/stocktake/stocktakeService.js`:

Dòng 9 đổi thành:

```js
const { PASTE_COLUMNS, STATUS_COLORS, normalizeValue, parseVnNumber, foldName, columnValue, sameValue } = require('../public/stocktake/stocktakePaste');
```

Trong `pasteColumn`, thay khối `await client.query(\`INSERT INTO stocktake_history ... 'paste' ...\`, [...])` bằng:

```js
        await insertPasteHistory(client, session, actor, changes.map(c => ({ code: c.code, before: c.before, after: { column, ...c.next } })));
```

Thêm ngay sau hàm `pasteColumn`:

```js
  // Lich su dan cot / sua tren bang: action 'paste' (co san trong CHECK), 1 dong moi (ma, cot).
  async function insertPasteHistory(client, session, actor, items) {
    if (!items.length) return;
    await client.query(
      `INSERT INTO stocktake_history (session_id, branch, product_code, action, before, after, actor_user_id, actor_name)
       SELECT $1, $2, r.code, 'paste', r.before, r.after, $4, $5 FROM jsonb_to_recordset($3::jsonb) AS r(code text, before jsonb, after jsonb)`,
      [session.id, session.branch, JSON.stringify(items), actor.id, actor.name]);
  }

  // Sua tren bang (go / dan khoi / xoa / keo / hoan tac): nhieu (ma, cot) trong 1 giao dich.
  // expected khac gia tri hien tai -> conflicts (khong ghi o do); thieu expected = khong kiem.
  async function saveCells(ctx, sessionId, body = {}) {
    const input = Array.isArray(body.cells) ? body.cells : null;
    if (!input || !input.length || input.length > MAX_PASTE_ROWS) throw fail(400, 'VALIDATION', `Cần từ 1 đến ${MAX_PASTE_ROWS} ô.`, { field: 'cells' });
    for (const cell of input) {
      if (!PASTE_COLUMNS[String((cell && cell.column) || '')]) throw fail(400, 'VALIDATION', 'Cột sửa không hợp lệ.', { field: 'column' });
    }
    const actor = actorOf(ctx);
    return withTransaction(async client => {
      const session = await openSessionForWrite(client, ctx, sessionId);
      const inputs = await loadInputs(client, session, { withCounterpart: false });
      const known = new Set([...buildBoard(inputs).rows.map(r => r.code), ...inputs.products.map(p => codeKey(p.code))]);
      const allEmployees = await loadEmployees(client);
      const employees = allEmployees.filter(e => e.branch === session.branch);
      const names = new Map(allEmployees.map(e => [e.id, e.name]));
      const nameOf = id => names.get(id) || '';
      const notes = new Map(inputs.notes.map(note => [note.code, note]));
      const tags = new Map(inputs.tags.map(tag => [tag.code, tag]));
      const skipped = { notFound: 0, invalid: 0, unchanged: 0 };
      // (ma, cot) lap trong 1 lan gui: giu o cuoi, vi tri theo lan gap dau.
      const latest = new Map();
      for (const cell of input) {
        const code = codeKey(cell.code);
        if (!code || !known.has(code)) { skipped.notFound += 1; continue; }
        latest.set(code + '\u0000' + cell.column, { code, column: cell.column, value: cell.value, expected: cell.expected, check: Object.hasOwn(cell, 'expected') });
      }
      const applied = [];
      const conflicts = [];
      const byStore = { note: new Map(), tag: new Map() };
      for (const cell of latest.values()) {
        const parsed = normalizeValue(cell.column, cell.value);
        if (!parsed.ok) { skipped.invalid += 1; continue; }
        const kind = TAG_FIELDS[cell.column] ? 'tag' : 'note';
        const original = (kind === 'tag' ? tags : notes).get(cell.code) || null;
        const entry = byStore[kind].get(cell.code) || { code: cell.code, before: original, next: original, columns: [] };
        const valueOf = record => columnValue(cell.column, kind === 'note' ? record : null, kind === 'tag' ? record : null, nameOf);
        const current = valueOf(entry.next);
        if (cell.check && !sameValue(cell.column, current, cell.expected)) { conflicts.push({ code: cell.code, column: cell.column, current }); continue; }
        const next = nextRecord(cell.column, entry.next, parsed.value, employees);
        if (sameRecord(cell.column, entry.next, next)) { skipped.unchanged += 1; continue; }
        entry.next = next;
        entry.columns.push(cell.column);
        byStore[kind].set(cell.code, entry);
        applied.push({ code: cell.code, column: cell.column, before: current, after: valueOf(next) });
      }
      const noteChanges = [...byStore.note.values()];
      const tagChanges = [...byStore.tag.values()];
      if (noteChanges.length) await upsertNotes(client, session.id, noteChanges, actor);
      if (tagChanges.length) await upsertTags(client, session.branch, tagChanges, actor);
      await insertPasteHistory(client, session, actor, [...noteChanges, ...tagChanges].flatMap(entry =>
        entry.columns.map(column => ({ code: entry.code, before: entry.before, after: { column, source: 'cells', ...entry.next } }))));
      return { applied, conflicts, skipped };
    }, sessionId);
  }
```

Dòng `return { listSessions, ... }` cuối cùng thêm `saveCells` sau `pasteColumn`.

- [ ] **Step 4: Chạy test service**

Run: `node --test stocktake/stocktakeService.test.js`
Expected: PASS toàn bộ (cả 2 test "dan cot" cũ — xác nhận `insertPasteHistory` không đổi hành vi).

- [ ] **Step 5: Viết test route hỏng** — trong `server/stocktake/stocktakeRoutes.test.js`:
  - Trong object `service` của `start()`, thêm `saveCells: record('saveCells'),` sau `pasteColumn: record('pasteColumn'),`.
  - Trong test có dòng `.../sessions/7/paste' ... status, 200)`, thêm ngay sau nó:

```js
  assert.equal((await fetch(base + '/sessions/7/cells', { method: 'POST', ...json({ cells: [] }) })).status, 200);
```

  - Trong mảng kỳ vọng `calls.slice(1).map(...)` của test đó, chèn `['saveCells', 7]` ngay sau `['pasteColumn', 7]`.
  - Trong test `'Khong co quyen sua: khong dan cot, khong doi dot doi chieu'`, thêm:

```js
  assert.equal((await fetch(base + '/sessions/7/cells', { method: 'POST', ...json({ cells: [] }) })).status, 403);
```

  và đổi điều kiện cuối thành `c[0] === 'pasteColumn' || c[0] === 'updateSession' || c[0] === 'saveCells'`.

- [ ] **Step 6: Chạy để thấy hỏng**

Run: `node --test stocktake/stocktakeRoutes.test.js`
Expected: FAIL — `/cells` trả 404.

- [ ] **Step 7: Thêm route** — trong `server/stocktake/stocktakeRoutes.js`, ngay sau route `/paste`:

```js
  // Sua tren bang: go / dan khoi / xoa / keo nhan ban / hoan tac (nhieu ma x cot, kiem expected tung o).
  router.post('/api/stocktake/sessions/:id/cells', edit, handle(async (req, res) => {
    res.json(await svc().saveCells(ctxOf(req), idOf(req), req.body || {}));
  }));
```

- [ ] **Step 8: Chạy toàn bộ test module kiểm kê**

Run: `node --test stocktake/stocktakeRoutes.test.js stocktake/stocktakeService.test.js stocktake/stocktakePaste.test.js stocktake/stocktakeCompute.test.js stocktake/stocktakeSheetImport.test.js`
Expected: PASS toàn bộ.

- [ ] **Step 9: Commit**

```bash
git add server/stocktake/stocktakeService.js server/stocktake/stocktakeRoutes.js server/stocktake/stocktakeService.test.js server/stocktake/stocktakeRoutes.test.js
git commit -m "feat(kiem-ke): POST /sessions/:id/cells sua nhieu o 1 giao dich, kiem expected tung o

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Trang — tìm kiếm mới, giữ thứ tự dòng, nhãn lịch sử, nạp script

**Files:**
- Modify: `server/public/stocktake/index.html` (dòng 229–230)
- Modify: `server/public/stocktake/stocktake.js` (`state`/`view` ~43–50; `render` ~307–343; `visibleRows` ~209–221; `resetView` ~407; `loadBoard` ~116–138; `ACTION_LABELS`/`historyText` ~724–735 + dòng 749; `bindTable` ~957)

**Interfaces:**
- Consumes: `TKSStocktakeSearch.buildIndex/search` (Task 2), `window.Fuse`.
- Produces: `render({ keepOrder })`; `view.order: string[]|null`; `loadBoard({ background })` vẽ lại bằng `keepOrder: background`.

- [ ] **Step 1: Nạp script** — trong `index.html` thay 2 dòng:

```html
  <script src="/stocktake/stocktakePaste.js?v=20261102-3"></script>
  <script src="/stocktake/stocktake.js?v=20261102-11"></script>
```

bằng:

```html
  <script src="/vendor/fuse.min.js?v=7.1.0"></script>
  <script src="/stocktake/stocktakePaste.js?v=20261103-1"></script>
  <script src="/stocktake/stocktakeSearch.js?v=20261103-1"></script>
  <script src="/stocktake/stocktakeGrid.js?v=20261103-1"></script>
  <script src="/stocktake/stocktake.js?v=20261103-1"></script>
```

- [ ] **Step 2: Tìm kiếm** — trong `stocktake.js`:

Sau dòng `const STATUS_COLORS = ...` thêm:

```js
  const Search = window.TKSStocktakeSearch;
  // Chi muc tim kiem dung lai cho den khi bang tai lai (4.000 ma x Fuse, khong lap lai moi lan go).
  const finder = { board: null, index: null };
  function searchIndex() {
    if (finder.board !== state.board) {
      finder.board = state.board;
      finder.index = Search.buildIndex(state.board.rows.map(row => ({
        row, code: row.code, name: row.name,
        extra: [row.cluster, row.note && row.note.statusText, row.note && row.note.reasonText].filter(Boolean).join(' ')
      })), { Fuse: window.Fuse });
    }
    return finder.index;
  }
```

Thay toàn bộ `visibleRows()` bằng:

```js
  // Loc theo bo loc truoc; co tu khoa thi xep theo muc khop (tra-cuu-vi-tri), tru khi da bam sort cot.
  function visibleRows() {
    if (!state.board) return [];
    const rows = state.board.rows.filter(row => {
      if (state.filter === 'forgotten' && !row.forgotten) return false;
      if (state.filter === 'noted' && !row.note) return false;
      if (state.recheck && recheckKey(row.note) !== state.recheck) return false;
      if (state.status && (row.note ? row.note.statusText : '') !== state.status) return false;
      return true;
    });
    if (!state.query.trim()) return sortRows(rows);
    const allowed = new Set(rows);
    const found = Search.search(searchIndex(), state.query).filter(row => allowed.has(row));
    return state.sortKey && state.sortDir ? sortRows(found) : found;
  }
```

Nếu sau đó `fold` không còn được dùng ở đâu (`grep -n "fold(" server/public/stocktake/stocktake.js`), xóa dòng khai báo `const fold = ...`.

Trong `bindTable`, thay dòng `$('stSearch').addEventListener('input', ...)` bằng:

```js
    let searchTimer = null;
    $('stSearch').addEventListener('input', event => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = setTimeout(() => { state.query = value; rerender(); }, 150);
    });
```

- [ ] **Step 3: Giữ thứ tự dòng** — trong `stocktake.js`:

Đổi `const view = { rows: [], drawn: 0, observer: null };` thành:

```js
  // view.order: ma theo thu tu dang hien; tai nen (sau luu / SSE) giu nguyen thu tu nay de dong vua sua khong nhay cho.
  const view = { rows: [], drawn: 0, observer: null, order: null };
```

Thêm trước `function render()`:

```js
  // Giu tap dong + thu tu dang hien voi du lieu moi; ma moi them cuoi, ma khong con trong dot bi bo.
  function keptRows() {
    const byCode = new Map(state.board.rows.map(row => [row.code, row]));
    const known = new Set(view.order);
    const kept = view.order.filter(code => byCode.has(code)).map(code => byCode.get(code));
    return kept.concat(visibleRows().filter(row => !known.has(row.code)));
  }
```

Đổi chữ ký `function render() {` thành `function render({ keepOrder = false } = {}) {` và thay dòng `view.rows = visibleRows();` bằng:

```js
    view.rows = keepOrder && view.order && board ? keptRows() : visibleRows();
    view.order = view.rows.map(row => row.code);
```

Trong `resetView()` thêm dòng `view.order = null;`.

Trong `loadBoard`, thay `render();` (trong khối `try`) bằng `render({ keepOrder: background });`.

- [ ] **Step 4: Nhãn lịch sử** — trong `stocktake.js`:

Thay dòng `if (item.action === 'paste') return 'Dán cột ' + ...;` bằng:

```js
    if (item.action === 'paste') {
      const label = (window.TKSStocktakePaste.PASTE_COLUMNS[after.column] || {}).label || after.column;
      return after.source === 'cells' ? label : 'Dán cột ' + label;
    }
```

Thêm sau `const ACTION_LABELS = {...};`:

```js
  const actionLabel = item => (item.action === 'paste' && item.after && item.after.source === 'cells' ? 'Sửa trên bảng' : ACTION_LABELS[item.action] || item.action);
```

Ở dòng `head.textContent = (ACTION_LABELS[item.action] || item.action) + ' — ' + ...`, thay `(ACTION_LABELS[item.action] || item.action)` bằng `actionLabel(item)`.

- [ ] **Step 5: Kiểm tra cú pháp + test**

Run: `node --check public/stocktake/stocktake.js && node --test stocktake/stocktakeSearch.test.js`
Expected: không lỗi, PASS.

- [ ] **Step 6: Kiểm tra trên trình duyệt** — khởi động lại server test (preview `stocktake-real-preview`, cổng 3989; script `C:/Users/chumi/AppData/Local/Temp/claude/D--tks-web/05ed4419-9dfc-44f6-93b5-3a018814821a/scratchpad/stocktake-real-preview.js`), mở `http://localhost:3989/stocktake/#dot=2`:
  - Gõ `băng keo 10kg` → dòng "Băng keo chống thấm 20cm (T9) (10KG)" (nếu có trong đợt) nằm trên cùng; `read_console_messages` không có lỗi.
  - Gõ `bang keo` → số mã ở `#stCount` ≥ số mã khớp chắc chắn, không bị cắt 100.
  - Bấm sort "Giá trị chênh" khi đang tìm → thứ tự theo cột.
  - Kiểm tra `typeof window.Fuse === 'function'` bằng `javascript_tool`.

- [ ] **Step 7: Commit**

```bash
git add server/public/stocktake/index.html server/public/stocktake/stocktake.js
git commit -m "feat(kiem-ke): tim kiem kieu tra-cuu-vi-tri, giu thu tu dong khi tai nen, nhan lich su sua tren bang

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Trang — ô nhập, phím, Delete, lưu `/cells`, Ctrl+Z

**Files:**
- Modify: `server/public/stocktake/stocktake.js`
- Modify: `server/public/stocktake/stocktake.css`
- Modify: `server/public/stocktake/index.html` (tăng `?v=` css + js)

**Interfaces:**
- Consumes: `TKSStocktakeGrid.EDIT_COLUMNS/moveIndex` (Task 3), `TKSStocktakePaste.columnValue/normalizeValue/rawOf` (Task 1), `POST /cells` (Task 4), `render({keepOrder})` (Task 5).
- Produces (dùng ở Task 7): `editColumnOf(col): string|null`, `canWrite(): boolean`, `cellAt(pos): HTMLTableCellElement|null`, `visibleColumnIndexes(): number[]`, `writeTargets(targets: Array<{row,col,raw}>, verb: string, { countIgnored = true } = {}): Promise<void>`, `selectRect(top, left, bottom, right)`.

- [ ] **Step 1: CSS** — thêm cuối `server/public/stocktake/stocktake.css`:

```css
/* Sua tren bang kieu sheet: o nhap de len o, nut keo goc vung chon, vien vung se dien. */
.st-scroll{position:relative}
.st-table td[data-editable]{cursor:cell}
.st-editor{position:absolute;z-index:6;box-sizing:border-box;margin:0;padding:4px 6px;border:2px solid #06b6d4;border-radius:0;background:var(--panel);color:var(--text);font:13px var(--font-body);outline:none;box-shadow:0 4px 12px rgba(0,0,0,.25)}
.st-fill{position:absolute;z-index:5;width:8px;height:8px;margin:0;padding:0;border:1px solid var(--panel);background:#06b6d4;cursor:crosshair}
.st-fill[hidden]{display:none}
.st-table td.st-fill-preview{outline:1px dashed #06b6d4;outline-offset:-2px}
```

- [ ] **Step 2: Hằng + trạng thái** — trong `stocktake.js`, sau khối `const Search = ...` (Task 5) thêm:

```js
  const Grid = window.TKSStocktakeGrid;
  const Paste = window.TKSStocktakePaste;
  const MAX_CELLS = 10000;
  const UNDO_LIMIT = 50;
  // O nhap dang mo (de len 1 o) va cac buoc hoan tac cua chinh minh (chi trong bo nho trang).
  const editor = { input: null };
  const undoStack = [];
```

- [ ] **Step 3: Đánh dấu ô sửa được + focus vào khung cuộn** — trong `rowElement`:
  - Xóa dòng `tr.tabIndex = 0;`.
  - Sau `if (column.num) td.className = 'num';` thêm `if (Grid.EDIT_COLUMNS[column.key]) td.dataset.editable = '';`.

Trong `bindSelection`, ở handler `mousedown` của `tbody`:
  - thay `td.parentElement.focus({ preventScroll: true });` bằng `document.querySelector('.st-scroll').focus({ preventScroll: true });`
  - ngay sau `event.preventDefault(); // không bôi đen chữ khi kéo` thêm `if (editor.input) closeEditor(true); // preventDefault chặn blur nên tự đóng ô nhập` (nhấp sang ô khác = lưu, như Sheets).

Trong `bindDetail`, xóa nguyên handler `$('stRows').addEventListener('keydown', ...)` (Enter / Space mở chi tiết) và sửa chú thích dòng trên thành `// Nhấp một lần = chọn ô (như sheet); nhấp đúp = mở chi tiết mã.`

- [ ] **Step 4: Hàm trợ giúp ô** — thêm sau `function bindSelection() {...}`:

```js
  // ---------- Sửa trên bảng ----------
  const editColumnOf = col => (COLUMNS[col] && Grid.EDIT_COLUMNS[COLUMNS[col].key]) || null;
  const cellAt = pos => {
    const tr = pos && $('stRows').rows[pos.row];
    return tr && tr.dataset.code ? tr.cells[pos.col] || null : null;
  };
  const expectedOf = (row, column) => Paste.columnValue(column, row.note, row, employeeName);
  function visibleColumnIndexes() {
    return visibleColumnsIn({ left: 0, right: COLUMNS.length - 1 });
  }
  function canWrite() {
    if (editable()) return true;
    const closed = state.board && state.board.session.status === 'closed';
    notify(closed ? 'Đợt đã đóng, không sửa được.' : 'Bạn không có quyền sửa đợt này.', true);
    return false;
  }
  function selectRect(top, left, bottom, right) {
    selection.anchor = { row: top, col: left };
    selection.focus = { row: bottom, col: right };
    paintSelection();
  }
  // O trong bang nam o vi tri nao trong khung cuon (de dat o nhap / nut keo).
  function boxIn(td) {
    const scroller = document.querySelector('.st-scroll');
    const box = td.getBoundingClientRect();
    const base = scroller.getBoundingClientRect();
    return { scroller, left: box.left - base.left + scroller.scrollLeft, top: box.top - base.top + scroller.scrollTop, width: box.width, height: box.height };
  }
```

- [ ] **Step 5: Gửi ô + thông báo + hoàn tác** — thêm tiếp:

```js
  function cellsMessage(verb, payload, ignored) {
    const s = payload.skipped || {};
    const parts = [verb + ' ' + num(payload.applied.length) + ' ô'];
    const bad = ignored + (s.invalid || 0) + (s.notFound || 0);
    if (bad) parts.push(num(bad) + ' ô bỏ qua (cột không sửa được / giá trị sai)');
    if (payload.conflicts.length) parts.push(num(payload.conflicts.length) + ' ô người khác vừa sửa nên không ghi');
    return parts.join(' · ') + '.';
  }

  // Gui /cells; thanh cong thi day buoc hoan tac (tru khi dang hoan tac) va tai nen bang (giu thu tu dong).
  async function sendCells(cells, { undo = false } = {}) {
    if (!cells.length) return null;
    if (cells.length > MAX_CELLS) { notify('Tối đa ' + num(MAX_CELLS) + ' ô mỗi lần.', true); return null; }
    const sessionId = state.sessionId;
    const { response, payload } = await request(API + '/sessions/' + sessionId + '/cells', jsonOptions('POST', { cells }));
    if (!response.ok) { notify(payload.error || 'Không lưu được.', true); return null; }
    if (!undo && payload.applied.length) {
      undoStack.push({ sessionId, cells: payload.applied });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    }
    await loadBoard({ background: true, forms: true });
    return payload;
  }

  // targets: [{ row, col, raw }] theo chi so view.rows / COLUMNS. O cot khong sua duoc / gia tri sai -> bo qua.
  async function writeTargets(targets, verb, { countIgnored = true } = {}) {
    const cells = [];
    let ignored = 0;
    for (const target of targets) {
      const column = editColumnOf(target.col);
      const row = view.rows[target.row];
      if (!column || !row || !Paste.normalizeValue(column, target.raw).ok) { ignored += 1; continue; }
      cells.push({ code: row.code, column, value: target.raw, expected: expectedOf(row, column) });
    }
    if (!cells.length) { notify('Không có ô nào sửa được trong vùng này.', true); return; }
    const payload = await sendCells(cells);
    if (payload) notify(cellsMessage(verb, payload, countIgnored ? ignored : 0), payload.conflicts.length > 0);
  }

  async function undo() {
    const step = undoStack.pop();
    if (step && step.sessionId !== state.sessionId) undoStack.length = 0;
    if (!step || step.sessionId !== state.sessionId) { notify('Không còn gì để hoàn tác.'); return; }
    if (!canWrite()) { undoStack.push(step); return; }
    const payload = await sendCells(step.cells.map(cell => ({
      code: cell.code, column: cell.column, value: Paste.rawOf(cell.column, cell.before), expected: cell.after
    })), { undo: true });
    if (payload) {
      notify(cellsMessage('Đã hoàn tác', payload, 0).replace('nên không ghi', 'nên không hoàn tác được'), payload.conflicts.length > 0);
    } else undoStack.push(step);
  }

  function clearSelectionCells() {
    const rect = selectionRect();
    if (!rect || !canWrite()) return;
    const targets = [];
    for (let row = rect.top; row <= rect.bottom; row++) {
      for (const col of visibleColumnsIn(rect)) if (editColumnOf(col)) targets.push({ row, col, raw: '' });
    }
    writeTargets(targets, 'Đã xóa', { countIgnored: false });
  }
```

- [ ] **Step 6: Ô nhập + di chuyển** — thêm tiếp:

```js
  // Mo o nhap de len o dang chon. initial: ky tu vua go (thay noi dung); khong co = sua noi dung hien tai.
  function openEditor(initial) {
    const pos = selection.focus;
    if (!pos || editor.input || !canWrite()) return;
    const column = editColumnOf(pos.col);
    if (!column) { notify('Cột "' + labelOf(COLUMNS[pos.col], state.headBranch) + '" không sửa được.', true); return; }
    const td = cellAt(pos);
    const row = view.rows[pos.row];
    if (!td || !row) return;
    const start = cellText(row, COLUMNS[pos.col].key);
    const box = boxIn(td);
    const input = document.createElement('input');
    input.className = 'st-editor';
    input.value = initial === undefined ? start : initial;
    Object.assign(input.style, { left: box.left + 'px', top: box.top + 'px', width: Math.max(box.width, 140) + 'px', height: Math.max(box.height, 30) + 'px' });
    Object.assign(editor, { input, code: row.code, column, start, expected: expectedOf(row, column), sessionId: state.sessionId });
    box.scroller.appendChild(input);
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    input.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); closeEditor(true, [1, 0]); }
      else if (event.key === 'Tab') { event.preventDefault(); closeEditor(true, [0, event.shiftKey ? -1 : 1]); }
      else if (event.key === 'Escape') { event.preventDefault(); closeEditor(false); }
    });
    input.addEventListener('blur', () => closeEditor(true));
  }

  async function closeEditor(save, move) {
    const { input, code, column, start, expected, sessionId } = editor;
    if (!input) return;
    editor.input = null;
    const value = input.value;
    input.remove();
    document.querySelector('.st-scroll').focus({ preventScroll: true });
    if (move) moveFocus(move[0], move[1], false);
    if (!save || value === start || sessionId !== state.sessionId) return;
    const payload = await sendCells([{ code, column, value, expected }]);
    if (!payload) return;
    if (payload.conflicts.length) notify('Người khác vừa sửa ô này — bảng đang hiện giá trị của họ.', true);
    else if (payload.skipped.invalid) notify('Giá trị không hợp lệ cho cột ' + labelOf(COLUMNS.find(c => Grid.EDIT_COLUMNS[c.key] === column), state.headBranch) + '.', true);
  }

  // Doi o chon (mui ten / Enter / Tab); extend = Shift (mo rong vung). Dong chua ve thi ve them.
  function moveFocus(dr, dc, extend) {
    if (!view.rows.length) return;
    const from = selection.focus || { row: 0, col: 0 };
    const row = Math.max(0, Math.min(view.rows.length - 1, from.row + dr));
    const col = dc ? Grid.moveIndex(visibleColumnIndexes(), from.col, dc) : from.col;
    if (row >= view.drawn) drawMore(row - view.drawn + CHUNK);
    selection.focus = { row, col };
    if (!extend || !selection.anchor) selection.anchor = selection.focus;
    paintSelection();
    const td = cellAt(selection.focus);
    if (td) td.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
```

Đổi đợt: trong handler `change` của `$('stSession')` (trong `bindSessions`; tìm bằng `grep -n "stSession').addEventListener" server/public/stocktake/stocktake.js`) gọi `if (editor.input) closeEditor(false); undoStack.length = 0;` trước khi tải đợt mới.

- [ ] **Step 7: Bàn phím** — trong `bindSelection`, thay handler `document.addEventListener('keydown', ...)` (Escape) bằng:

```js
    // Phim kieu sheet tren o dang chon. Khong chay khi dang mo o nhap, hop thoai, hoac focus o o nhap khac.
    document.addEventListener('keydown', event => {
      if (editor.input || document.querySelector('dialog[open]')) return;
      const active = document.activeElement;
      if (active && /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(active.tagName)) return;
      const ctrl = event.ctrlKey || event.metaKey;
      if (ctrl && !event.shiftKey && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); return; }
      if (!selection.focus) return;
      if (event.key === 'Escape') { selection.anchor = selection.focus = null; paintSelection(); return; }
      if (ctrl || event.altKey) return;
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (arrows[event.key]) { event.preventDefault(); moveFocus(arrows[event.key][0], arrows[event.key][1], event.shiftKey); return; }
      if (event.key === 'Tab') { event.preventDefault(); moveFocus(0, event.shiftKey ? -1 : 1, false); return; }
      if (event.key === 'Enter' || event.key === 'F2') { event.preventDefault(); openEditor(); return; }
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); clearSelectionCells(); return; }
      // Bo go tieng Viet kieu IME (Windows Telex) bao key "Process": mo o nhap rong, de phim roi vao o nhap.
      if (event.key === 'Process' || event.isComposing) { openEditor(''); return; }
      if (event.key.length === 1) { event.preventDefault(); openEditor(event.key); }
    });
```

- [ ] **Step 8: Tăng phiên bản tài nguyên** — trong `index.html`: `stocktake.css?v=20261102-6` → `?v=20261103-1`; `stocktake.js?v=20261103-1` → `?v=20261103-2`.

- [ ] **Step 9: Kiểm tra cú pháp**

Run: `node --check public/stocktake/stocktake.js`
Expected: không lỗi.

- [ ] **Step 10: Kiểm tra trên trình duyệt** (server test, đợt mở `#dot=3`, người dùng `/mock/as/ql`):
  - Nhấp ô Trạng thái → gõ `a` → ô nhập hiện chữ "a"; gõ tiếp `bc`, Enter → ô lưu "abc", ô chọn xuống dòng dưới. `read_network_requests` có `POST .../cells` 200.
  - Enter trên ô vừa sửa → ô nhập có "abc"; Esc → không gửi request.
  - Tab lưu rồi sang phải; mũi tên di chuyển; Shift+mũi tên mở rộng vùng; mũi tên xuống quá 200 dòng vẽ thêm.
  - Chọn 3 ô Trạng thái + 2 cột → Delete → các ô sửa được trống, thông báo "Đã xóa N ô".
  - Ctrl+Z → giá trị quay lại; Ctrl+Z hết bước → "Không còn gì để hoàn tác."
  - Gõ vào ô Tồn KIOT → thông báo "Cột "Tồn KIOT" không sửa được."
  - Nhấp đúp ô bất kỳ → mở hộp chi tiết; lịch sử có dòng "Sửa trên bảng — …".
  - Sort theo Trạng thái, sửa trạng thái 1 dòng → dòng không nhảy chỗ.
  - Hai tab (QL + `/mock/as/hung`): tab A mở ô nhập, tab B sửa cùng ô, tab A Enter → thông báo "Người khác vừa sửa ô này".
  - Đợt đã đóng (`#dot=2`) gõ → "Đợt đã đóng, không sửa được."; người `sale` gõ → "Bạn không có quyền sửa đợt này."
  - Light/Dark: ô nhập đọc được ở cả hai chế độ.
  - `read_console_messages` không có lỗi.

- [ ] **Step 11: Commit**

```bash
git add server/public/stocktake/stocktake.js server/public/stocktake/stocktake.css server/public/stocktake/index.html
git commit -m "feat(kiem-ke): go / Enter / F2 / Delete sua ngay trong o, phim mui ten, Ctrl+Z hoan tac

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Trang — Ctrl+V dán khối + kéo nút góc nhân bản

**Files:**
- Modify: `server/public/stocktake/stocktake.js`
- Modify: `server/public/stocktake/index.html` (tăng `?v=` js)

**Interfaces:**
- Consumes: `Grid.parseClipboard/planPaste/planFill` (Task 3), `writeTargets`, `canWrite`, `editColumnOf`, `cellAt`, `visibleColumnIndexes`, `selectRect`, `boxIn`, `editor` (Task 6).

- [ ] **Step 1: Dán** — trong `bindSelection`, sau handler `copy`, thêm:

```js
    // Ctrl+V kieu Sheets: khoi tu o tren-trai vung chon (hoac 1 o dien ca vung), ghi 1 lan /cells.
    document.addEventListener('paste', event => {
      const active = document.activeElement;
      const rect = selectionRect();
      if (editor.input || !rect || (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)) || document.querySelector('dialog[open]')) return;
      event.preventDefault();
      if (!canWrite()) return;
      const block = Grid.parseClipboard(event.clipboardData.getData('text/plain'));
      const targets = Grid.planPaste(block, rect, { rowCount: view.rows.length, visibleCols: visibleColumnIndexes() });
      if (!targets.length) return;
      const rows = targets.map(t => t.row);
      const cols = targets.map(t => t.col);
      const bottom = Math.max(...rows);
      if (bottom >= view.drawn) drawMore(bottom - view.drawn + 1);
      selectRect(Math.min(...rows), Math.min(...cols), bottom, Math.max(...cols));
      writeTargets(targets, 'Đã dán');
    });
```

- [ ] **Step 2: Nút kéo — vẽ** — thêm sau hàm `moveFocus` (Task 6):

```js
  // ---------- Kéo nút góc (fill handle) ----------
  const fill = { handle: null, active: false, rect: null, to: null, painted: [], scrollTimer: null, lastY: 0 };
  function fillHandle() {
    if (!fill.handle) {
      fill.handle = document.createElement('button');
      fill.handle.type = 'button';
      fill.handle.className = 'st-fill';
      fill.handle.hidden = true;
      fill.handle.tabIndex = -1;
      fill.handle.setAttribute('aria-label', 'Kéo để nhân bản giá trị');
      document.querySelector('.st-scroll').appendChild(fill.handle);
      fill.handle.addEventListener('mousedown', startFill);
    }
    return fill.handle;
  }
  function positionFill() {
    const handle = fillHandle();
    const rect = selectionRect();
    const td = rect && cellAt({ row: rect.bottom, col: rect.right });
    const show = Boolean(td && editable() && !fill.active && visibleColumnsIn(rect).some(editColumnOf));
    handle.hidden = !show;
    if (!show) return;
    const box = boxIn(td);
    handle.style.left = box.left + box.width - 5 + 'px';
    handle.style.top = box.top + box.height - 5 + 'px';
  }
```

Ở cuối hàm `paintSelection()` (sau vòng lặp, và cả nhánh `if (!rect) return;` — đổi thành `if (!rect) { positionFill(); return; }`), thêm `positionFill();`.

- [ ] **Step 3: Nút kéo — kéo + thả** — thêm tiếp:

```js
  function paintFillPreview() {
    for (const td of fill.painted) td.classList.remove('st-fill-preview');
    fill.painted = [];
    if (fill.to === null) return;
    const cols = visibleColumnsIn(fill.rect);
    for (const target of Grid.planFill(fill.rect, fill.to, cols)) {
      const td = cellAt({ row: target.row, col: target.col });
      if (td) { td.classList.add('st-fill-preview'); fill.painted.push(td); }
    }
  }
  function startFill(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (!canWrite()) return;
    Object.assign(fill, { active: true, rect: selectionRect(), to: null, lastY: event.clientY });
    fill.handle.hidden = true;
    // Gan mep tren / duoi khung cuon thi tu cuon (dong chua ve se ve khi cuon toi canh).
    const scroller = document.querySelector('.st-scroll');
    fill.scrollTimer = setInterval(() => {
      const box = scroller.getBoundingClientRect();
      if (fill.lastY > box.bottom - 30) scroller.scrollTop += 24;
      else if (fill.lastY < box.top + 50) scroller.scrollTop -= 24;
    }, 50);
  }
  async function endFill() {
    if (!fill.active) return;
    clearInterval(fill.scrollTimer);
    fill.active = false;
    const { rect, to } = fill;
    fill.to = null;
    paintFillPreview();
    if (to === null || (to >= rect.top && to <= rect.bottom)) { positionFill(); return; }
    const cols = visibleColumnsIn(rect);
    const targets = Grid.planFill(rect, to, cols)
      .filter(target => editColumnOf(target.col))
      .map(target => ({ row: target.row, col: target.col, raw: cellText(view.rows[target.fromRow], COLUMNS[target.col].key) }));
    selectRect(Math.min(rect.top, to), rect.left, Math.max(rect.bottom, to), rect.right);
    if (targets.length) await writeTargets(targets, 'Đã nhân bản', { countIgnored: false });
  }
```

Trong `bindSelection`:
  - Ở đầu handler `mouseover` của `tbody`, thêm trước `if (!selection.dragging) return;`:

```js
      if (fill.active) {
        const cell = event.target.closest('td[data-col]');
        if (cell) { fill.to = cellPos(cell).row; paintFillPreview(); }
        return;
      }
```

  - Đổi `document.addEventListener('mouseup', () => { selection.dragging = false; });` thành:

```js
    document.addEventListener('mouseup', () => { selection.dragging = false; endFill(); });
    document.addEventListener('mousemove', event => { if (fill.active) fill.lastY = event.clientY; });
```

(`drawMore` và `render` đều gọi `paintSelection()` nên nút tự cập nhật sau khi vẽ / tải lại.)

Đổi kích thước cửa sổ làm nút lệch: thêm vào cuối `bindSelection`:

```js
    window.addEventListener('resize', positionFill);
```

- [ ] **Step 4: Tăng phiên bản** — `index.html`: `stocktake.js?v=20261103-2` → `?v=20261103-3`.

- [ ] **Step 5: Kiểm tra cú pháp**

Run: `node --check public/stocktake/stocktake.js`
Expected: không lỗi.

- [ ] **Step 6: Kiểm tra trên trình duyệt** (server test, `#dot=3`, QL). Clipboard trong trình duyệt pane có thể không đọc được từ máy; dùng `javascript_tool` tạo sự kiện:

```js
const dt = new DataTransfer();
dt.setData('text/plain', 'đã kiểm\tlý do 1\nmất\tlý do 2\n');
document.querySelector('.st-scroll').focus();
document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
```

  - Chọn ô Trạng thái dòng 1 → chạy đoạn trên → dòng 1–2 cột Trạng thái + Chi tiết lý do đổi; thông báo "Đã dán 4 ô."; vùng chọn = 2×2.
  - Chọn 5 ô Trạng thái → dán `'OK'` (1 ô) → cả 5 ô "OK".
  - Chọn ô Tồn KIOT → dán `'1\t2'` → "Không có ô nào sửa được trong vùng này." hoặc chỉ ghi phần rơi vào cột sửa được, phần còn lại báo bỏ qua.
  - Nút vuông nhỏ hiện ở góc dưới-phải vùng chọn (chụp `computer screenshot` + `zoom`), ẩn khi chọn ô Tồn KIOT.
  - Kéo nút (dùng `left_click_drag` từ nút xuống 10 dòng) → viền nét đứt khi kéo, thả → 10 dòng nhận giá trị; chọn 2 dòng giá trị khác nhau rồi kéo → lặp mẫu; kéo lên cũng chạy.
  - Ctrl+Z sau dán / kéo → trả lại toàn bộ giá trị cũ trong một bước.
  - Kéo xuống sát mép dưới → bảng tự cuộn.
  - Cuộn bảng → nút vẫn bám đúng ô.
  - Console không lỗi; kiểm tra lại ở 375px (`resize_window mobile`) không vỡ bố cục (nút có thể nhỏ, chấp nhận).

- [ ] **Step 7: Commit**

```bash
git add server/public/stocktake/stocktake.js server/public/stocktake/index.html
git commit -m "feat(kiem-ke): Ctrl+V dan khoi nhu Sheets va keo nut goc nhan ban gia tri

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Tài liệu, test toàn bộ, kiểm chứng dữ liệu thật, push

**Files:**
- Modify: `README.md` (mục cập nhật gần nhất), `server/README.md` (bảng API stocktake), `docs/02-srs/SRS_Dashboard_GoogleSheets.md` (FR-ST), `CURRENT.md`

- [ ] **Step 1: `server/README.md`** — trong bảng API kiểm kê, ngay sau dòng `POST /api/stocktake/sessions/:id/paste`, thêm dòng cùng định dạng bảng hiện có:

`POST /api/stocktake/sessions/:id/cells` — quyền `stocktake.edit`; body `{ cells: [{ code, column, value, expected? }] }` (1–10.000 ô, `column` thuộc 9 cột dán); 1 giao dịch; `expected` khác giá trị hiện tại → ô vào `conflicts`, không ghi; trả `{ applied, conflicts, skipped }`; lịch sử action `paste` + `source: 'cells'`. Dùng cho gõ / dán / xóa / kéo / hoàn tác trên bảng.

(Đọc bảng trước bằng `grep -n "stocktake/sessions/:id/paste" server/README.md` để giữ đúng số cột / dấu `|`.)

- [ ] **Step 2: SRS** — trong `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, sau mục FR-ST cuối cùng (`grep -n "FR-ST" docs/02-srs/SRS_Dashboard_GoogleSheets.md`), thêm `FR-ST.9`:

```markdown
- **FR-ST.9 Sửa trên bảng như sheet (03/11/2026):** 9 cột nhập tay (Trạng thái, Chi tiết lý do, Trang in, Giờ in, Người kiểm lại, KK trước sai, Kiểm SG/HN, Cụm SP, Combo) sửa ngay trong ô: chọn ô rồi gõ (Enter/F2 sửa nội dung, Enter lưu + xuống, Tab lưu + sang phải, Esc hủy), Delete xóa vùng chọn, Ctrl+V dán khối từ Google Sheets (1 ô vào vùng nhiều ô = điền cả vùng), kéo nút vuông góc vùng chọn để nhân bản lên/xuống (lặp mẫu), Ctrl+Z hoàn tác tối đa 50 bước của chính mình. Ô người khác vừa sửa không bị ghi đè (báo xung đột). Thứ tự dòng giữ nguyên sau khi sửa cho tới khi đổi sort/lọc/tìm. Nhấp đúp mở hộp chi tiết. Tìm kiếm theo thuật toán tool tra-cuu-vi-tri: bỏ dấu, tách số khỏi chữ, đủ mọi từ là khớp (không cần thứ tự), xếp theo mức khớp, thêm khớp mờ Fuse.js tới 100 kết quả.
```

Cập nhật dòng ngày cuối tài liệu thành `03/11/2026`.

- [ ] **Step 3: README + CURRENT** — `README.md`: thêm 1 dòng đầu mục "cập nhật gần nhất" tóm tắt FR-ST.9 + thêm `stocktakeSearch.js`, `stocktakeGrid.js` vào cây thư mục `public/stocktake/` và `vendor/fuse.min.js` vào `public/vendor/` (`grep -n "stocktakePaste.js" README.md` để tìm chỗ). `CURRENT.md`: chèn một câu **Cập nhật 03/11/2026 (sửa trên bảng + tìm kiếm):** vào mục Kiểm kê (dòng 1) ngay trước "**Việc kế tiếp:**", gồm tóm tắt + kết quả test của Step 4. Cập nhật ngày cuối các tài liệu đã sửa.

- [ ] **Step 4: Test toàn bộ**

Run (trong `server/`): `npm test 2>&1 | tail -40`
Expected: không có lỗi mới so với danh sách lỗi có sẵn trên `origin/main` ghi trong `CURRENT.md` (`vt-positions.test.js` ×3, `account-work-assignment.test.js` ×2, `dashboard-per-view-loading.test.js` ×1, `business-report.test.js` ×3, `auth/adminUserExportService.test.js` ×1, `vt-positions-live.test.js` chập chờn). Mọi test `stocktake*` đạt. Lỗi nào ngoài danh sách → dừng, điều tra bằng superpowers:systematic-debugging.

- [ ] **Step 5: Đồ thị mã**

Run (gốc repo): `graphify update .` (nếu launcher bị chặn: `python -m graphify update .`)
Expected: chạy xong không lỗi.

- [ ] **Step 6: Kiểm chứng dữ liệu thật** — khởi động lại server test `stocktake-real-preview`, chạy lại nhanh checklist Task 5 Step 6, Task 6 Step 10, Task 7 Step 6 trên đợt "HN 01–03/10" và "SG 01–03/10"; chụp màn hình bảng sau khi dán + kéo làm bằng chứng.

- [ ] **Step 7: Commit + push**

```bash
git add README.md server/README.md docs/02-srs/SRS_Dashboard_GoogleSheets.md CURRENT.md
git ls-files --error-unmatch graphify-out >/dev/null 2>&1 && git add graphify-out   # chi khi graphify-out duoc git theo doi
git commit -m "docs(kiem-ke): sua tren bang nhu sheet va tim kiem kieu tra-cuu-vi-tri

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push origin claude/inventory-feature-analysis-1ab808
```

Expected: PR #27 nhận các commit mới; không cần migration nên không có bước DB.
