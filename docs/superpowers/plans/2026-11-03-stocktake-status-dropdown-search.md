# Kiểm kê: trạng thái dạng danh sách + thẻ tổng, ô xuống dòng, bỏ Vị trí kho, tìm kiếm chặt — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trang `/stocktake/`: Trạng thái chọn từ 7 loại cố định có màu tự động + hàng thẻ tổng giá trị chênh theo loại (bấm để lọc); ô dữ liệu xuống dòng; bỏ cột Vị trí kho gần nhất; tìm kiếm theo tên chặt hơn, tìm mờ chỉ khi không có kết quả.

**Architecture:** Module UMD mới `stocktakeStatus.js` (danh sách loại, xếp loại chữ cũ, tên chuẩn, màu, tổng) dùng chung cho trình duyệt, service và xuất Excel. Server kiểm tra trạng thái mới phải là tên chuẩn theo cơ sở (giữ chữ cũ không đổi), bỏ đọc vị trí kho. Trang web vẽ thẻ + lọc theo loại, ô Trạng thái mở danh sách chọn thay ô nhập; `stocktakeSearch.js` đổi luật khớp và trả `{ rows, fuzzy }`.

**Tech Stack:** Node 24, Express, CommonJS, PGlite + `node:test`, ExcelJS, vanilla JS/CSS, Fuse.js 7.1.0 (`/vendor/fuse.min.js`).

**Spec:** `docs/superpowers/specs/2026-11-03-stocktake-status-dropdown-search-design.md`

## Global Constraints

- CommonJS (`require` / `module.exports`), vanilla HTML/CSS/JS; không TailwindCSS, không framework client.
- Module dùng chung trình duyệt + Node theo khuôn UMD của `server/public/stocktake/stocktakeGrid.js`.
- 7 loại, đúng thứ tự, tên và màu: Mất `#F87171` · KK trước `#C8963E` · OK `#EEFF41` · Nhầm SG (đợt `saigon`: Nhầm HN) `#C4B5FD` · Thừa `#F9A8D4` · Lẫn `#67E8F9` · Chưa XL `#FFFFFF`. Chữ không xếp được loại → "Khác" (không màu).
- "Chưa XL" = trạng thái trống; không bao giờ lưu chữ "Chưa XL".
- Không migration. Cột `stocktake_code_notes.status_color` không còn được ghi (CHECK 0105 chỉ nhận tên màu cũ); màu hiển thị luôn tính từ chữ trạng thái.
- Chữ trạng thái cũ (đợt nạp từ sheet) giữ nguyên trong DB; lưu lại đúng chữ cũ (không đổi) vẫn được nhận.
- Thẻ tổng tính trên toàn đợt (`state.board.rows`), không theo tìm kiếm/bộ lọc; tổng giá trị chênh cộng có dấu.
- Tìm kiếm: số cuối cụm khớp trọn số (10 không khớp 100); mỗi từ gõ (tách theo khoảng trắng) là một cụm phải liền nhau và bắt đầu ở đầu một từ; Fuse chỉ chạy khi mức 1–7 không ra gì.
- Chạy test từ thư mục `server/`, từng file: `node --test stocktake/<tên>.test.js` (Node 24 không nhận thư mục). KHÔNG chạy `npm test` trong task (controller chạy).
- Không kết nối DB thật, không sửa `server/public/prototypes/**`.
- Giao diện hỗ trợ sáng/tối và 375px; vùng bấm tối thiểu ~32px.
- Commit message kết thúc bằng dòng `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Module trạng thái dùng chung `stocktakeStatus.js`

**Files:**
- Create: `server/public/stocktake/stocktakeStatus.js`
- Test: `server/stocktake/stocktakeStatus.test.js`

**Interfaces:**
- Produces (dùng ở Task 3, 4, 5): `require('../public/stocktake/stocktakeStatus')` / `window.TKSStocktakeStatus` với
  `STATUS_TYPES` (mảng `{ key, label, labelSaigon?, color }`), `OTHER` (`{ key: 'other', label: 'Khác', color: '' }`),
  `fold(text) → string`, `labelFor(key, branch) → string`, `optionsFor(branch) → [{ key, label, color }]` (7 dòng),
  `classify(text) → 'lost'|'previous'|'ok'|'wrong'|'surplus'|'mixed'|'pending'|'other'`,
  `canonical(text, branch) → string|null`, `isValid(text, branch) → boolean`, `colorOf(text) → '#RRGGBB'|''`,
  `summarize(rows) → Map<key, { count, diffValue }>` (7 loại theo thứ tự, thêm `'other'` cuối nếu có).

- [ ] **Step 1: Viết test (thất bại)** — `server/stocktake/stocktakeStatus.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Status = require('../public/stocktake/stocktakeStatus');

test('7 loai dung thu tu, ten theo co so, mau co dinh', () => {
  assert.deepEqual(Status.STATUS_TYPES.map(t => t.key), ['lost', 'previous', 'ok', 'wrong', 'surplus', 'mixed', 'pending']);
  assert.deepEqual(Status.optionsFor('hanoi').map(o => o.label), ['Mất', 'KK trước', 'OK', 'Nhầm SG', 'Thừa', 'Lẫn', 'Chưa XL']);
  assert.deepEqual(Status.optionsFor('saigon').map(o => o.label), ['Mất', 'KK trước', 'OK', 'Nhầm HN', 'Thừa', 'Lẫn', 'Chưa XL']);
  assert.deepEqual(Status.optionsFor('hanoi').map(o => o.color), ['#F87171', '#C8963E', '#EEFF41', '#C4B5FD', '#F9A8D4', '#67E8F9', '#FFFFFF']);
  assert.equal(Status.labelFor('other', 'hanoi'), 'Khác');
  assert.equal(Status.labelFor('bogus', 'hanoi'), '');
});

test('classify: ten chuan, chu cu T10 theo tu khoa som nhat, trong = Chua XL, khong khop = Khac', () => {
  const cases = {
    '': 'pending', '   ': 'pending', 'Chưa XL': 'pending', 'chua xl': 'pending',
    'Mất': 'lost', 'KK trước': 'previous', 'OK': 'ok', 'ok': 'ok', 'Nhầm SG': 'wrong', 'Nhầm HN': 'wrong', 'Thừa': 'surplus', 'Lẫn': 'mixed',
    'lẫn bình giữ nhiệt': 'mixed', 'Lẫn+kk trước': 'mixed', 'KK trước + lẫn': 'previous', 'đã kiểm lại thừa': 'surplus',
    'mất ko thấy': 'lost', 'Mất do thẻ kho xuất sai': 'lost', 'Nhầm SG + KK': 'wrong', 'xác nhận thừa đã có ảnh': 'surplus',
    'LẪN HỘP CƠM': 'mixed', 'KK Trước': 'previous', 'Lẻ': 'other', 'tìm thấy': 'other'
  };
  for (const [text, key] of Object.entries(cases)) assert.equal(Status.classify(text), key, JSON.stringify(text));
  assert.equal(Status.classify(null), 'pending');
});

test('canonical / isValid: ten chuan theo co so, Chua XL -> trong, Khac -> null', () => {
  assert.equal(Status.canonical('lẫn bình giữ nhiệt', 'hanoi'), 'Lẫn');
  assert.equal(Status.canonical('nhầm sg', 'saigon'), 'Nhầm HN');
  assert.equal(Status.canonical('Nhầm HN', 'hanoi'), 'Nhầm SG');
  assert.equal(Status.canonical('Chưa XL', 'hanoi'), '');
  assert.equal(Status.canonical('', 'hanoi'), '');
  assert.equal(Status.canonical('Lẻ', 'hanoi'), null);
  assert.equal(Status.isValid('Lẫn', 'hanoi'), true);
  assert.equal(Status.isValid('', 'hanoi'), true);
  assert.equal(Status.isValid('lẫn', 'hanoi'), false);
  assert.equal(Status.isValid('Nhầm HN', 'hanoi'), false);
  assert.equal(Status.isValid('Nhầm HN', 'saigon'), true);
  assert.equal(Status.isValid('Chưa XL', 'hanoi'), false);
});

test('colorOf: mau theo loai, Chua XL / Khac khong to', () => {
  assert.equal(Status.colorOf('mất ko thấy'), '#F87171');
  assert.equal(Status.colorOf('Lẫn'), '#67E8F9');
  assert.equal(Status.colorOf(''), '');
  assert.equal(Status.colorOf('Lẻ'), '');
});

test('summarize: du 7 loai, Khac chi khi co, cong co dau, dong khong note = Chua XL', () => {
  const rows = [
    { note: { statusText: 'Mất' }, diffValue: -1000 },
    { note: { statusText: 'mất ko thấy' }, diffValue: -500 },
    { note: { statusText: 'Thừa' }, diffValue: 300 },
    { note: null, diffValue: 20 },
    { note: { statusText: '' }, diffValue: -5 }
  ];
  const totals = Status.summarize(rows);
  assert.deepEqual([...totals.keys()], ['lost', 'previous', 'ok', 'wrong', 'surplus', 'mixed', 'pending']);
  assert.deepEqual(totals.get('lost'), { count: 2, diffValue: -1500 });
  assert.deepEqual(totals.get('surplus'), { count: 1, diffValue: 300 });
  assert.deepEqual(totals.get('pending'), { count: 2, diffValue: 15 });
  assert.deepEqual(totals.get('ok'), { count: 0, diffValue: 0 });
  const withOther = Status.summarize([...rows, { note: { statusText: 'Lẻ' }, diffValue: 7 }]);
  assert.deepEqual([...withOther.keys()].at(-1), 'other');
  assert.deepEqual(withOther.get('other'), { count: 1, diffValue: 7 });
});
```

- [ ] **Step 2: Chạy test, phải FAIL**

Run (trong `server/`): `node --test stocktake/stocktakeStatus.test.js`
Expected: FAIL — `Cannot find module '../public/stocktake/stocktakeStatus'`.

- [ ] **Step 3: Viết module** — `server/public/stocktake/stocktakeStatus.js`:

```js
/* Trang thai kiem ke: 7 loai co dinh (mau tu dong), xep loai chu cu (dot nap tu sheet), ten chuan khi luu, tong theo loai cho the.
   Dung chung trinh duyet (window.TKSStocktakeStatus), server va xuat Excel (require) de hai ben hieu giong nhau. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakeStatus = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Thu tu hien thi (the, danh sach chon, bo loc). 'pending' (Chua XL) = o trong, khong luu chu "Chưa XL".
  const STATUS_TYPES = Object.freeze([
    Object.freeze({ key: 'lost', label: 'Mất', color: '#F87171' }),
    Object.freeze({ key: 'previous', label: 'KK trước', color: '#C8963E' }),
    Object.freeze({ key: 'ok', label: 'OK', color: '#EEFF41' }),
    Object.freeze({ key: 'wrong', label: 'Nhầm SG', labelSaigon: 'Nhầm HN', color: '#C4B5FD' }),
    Object.freeze({ key: 'surplus', label: 'Thừa', color: '#F9A8D4' }),
    Object.freeze({ key: 'mixed', label: 'Lẫn', color: '#67E8F9' }),
    Object.freeze({ key: 'pending', label: 'Chưa XL', color: '#FFFFFF' })
  ]);
  const OTHER = Object.freeze({ key: 'other', label: 'Khác', color: '' });
  const BY_KEY = new Map(STATUS_TYPES.map(type => [type.key, type]));
  // Tu khoa nguyen tu (sau khi gap chu); chu cu nhieu y ("Lẫn+kk trước") lay tu khoa xuat hien som nhat.
  const KEYWORDS = Object.freeze([
    ['ok', 'ok'], ['mat', 'lost'], ['kk truoc', 'previous'], ['kk', 'previous'], ['nham', 'wrong'], ['thua', 'surplus'], ['lan', 'mixed']
  ]);

  // "Lẫn+KK trước" -> "lan kk truoc": thuong, bo dau, d, ky tu khac chu/so -> khoang trang.
  const fold = value => String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, ' ').trim();

  function labelFor(key, branch) {
    if (key === OTHER.key) return OTHER.label;
    const type = BY_KEY.get(key);
    if (!type) return '';
    return branch === 'saigon' && type.labelSaigon ? type.labelSaigon : type.label;
  }

  const optionsFor = branch => STATUS_TYPES.map(type => ({ key: type.key, label: labelFor(type.key, branch), color: type.color }));

  function classify(text) {
    const folded = fold(text);
    if (!folded || folded === 'chua xl') return 'pending';
    if (folded === 'nham sg' || folded === 'nham hn') return 'wrong';
    const exact = STATUS_TYPES.find(type => fold(type.label) === folded);
    if (exact) return exact.key;
    const padded = ' ' + folded + ' ';
    let best = null;
    for (const [word, key] of KEYWORDS) {
      const at = padded.indexOf(' ' + word + ' ');
      if (at >= 0 && (!best || at < best.at)) best = { at, key };
    }
    return best ? best.key : OTHER.key;
  }

  // Chu de luu khi nguoi dung chon / dan / keo: ten chuan theo co so; Chua XL -> ''; khong xep duoc loai -> null.
  function canonical(text, branch) {
    const key = classify(text);
    if (key === 'pending') return '';
    return key === OTHER.key ? null : labelFor(key, branch);
  }

  const isValid = (text, branch) => text === '' || canonical(text, branch) === text;

  function colorOf(text) {
    const key = classify(text);
    return key === 'pending' || key === OTHER.key ? '' : BY_KEY.get(key).color;
  }

  // Tong theo loai tren moi dong (khong theo bo loc): so ma + tong gia tri chenh co dau.
  function summarize(rows) {
    const totals = new Map(STATUS_TYPES.map(type => [type.key, { count: 0, diffValue: 0 }]));
    for (const row of rows || []) {
      const key = classify(row && row.note ? row.note.statusText : '');
      if (!totals.has(key)) totals.set(key, { count: 0, diffValue: 0 });
      const entry = totals.get(key);
      entry.count += 1;
      entry.diffValue += Number(row && row.diffValue) || 0;
    }
    return totals;
  }

  return { STATUS_TYPES, OTHER, fold, labelFor, optionsFor, classify, canonical, isValid, colorOf, summarize };
});
```

- [ ] **Step 4: Chạy test, phải PASS**

Run: `node --test stocktake/stocktakeStatus.test.js`
Expected: 5 test pass.

- [ ] **Step 5: Commit**

```bash
git add server/public/stocktake/stocktakeStatus.js server/stocktake/stocktakeStatus.test.js
git commit -m "feat(kiem-ke): module trang thai dung chung (7 loai, xep loai chu cu, tong theo loai)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Tìm kiếm chặt hơn (`stocktakeSearch.js`) + nơi gọi trên trang

**Files:**
- Modify: `server/public/stocktake/stocktakeSearch.js` (toàn file)
- Modify: `server/public/stocktake/stocktake.js` (`visibleRows`, `render`)
- Modify: `server/public/stocktake/index.html` (phiên bản script)
- Test: `server/stocktake/stocktakeSearch.test.js` (viết lại)

**Interfaces:**
- Produces: `search(index, query) → { rows: Row[], fuzzy: boolean }` (trước đây trả mảng). `buildIndex`, `normalizeText`, `normalizeCode`, `FUZZY_LIMIT` giữ nguyên.

- [ ] **Step 1: Viết lại test (thất bại)** — thay toàn bộ `server/stocktake/stocktakeSearch.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeText, normalizeCode, buildIndex, search, FUZZY_LIMIT } = require('../public/stocktake/stocktakeSearch');
const FuseModule = require('../public/vendor/fuse.min.js');
const Fuse = FuseModule.default || FuseModule;

const item = (code, name, extra = '') => ({ row: { code }, code, name, extra });
const codes = result => result.rows.map(row => row.code);

test('chuan hoa giong tra-cuu-vi-tri: bo dau, tach so khoi chu, bo ky tu la', () => {
  assert.equal(normalizeText('Băng keo chống thấm 20cm (T9) (10KG)'), 'bang keo chong tham 20 cm t 9 10 kg');
  assert.equal(normalizeText('  Đèn LED-12V  '), 'den led 12 v');
  assert.equal(normalizeCode(' bk-20 '), 'bk20');
  assert.equal(normalizeCode('Đ.10'), 'd10');
});

test('"băng keo 10kg" chi ra hang 10KG (ten that), khong 11KG/19KG/15.5KG, khong ket qua mo', () => {
  const index = buildIndex([
    item('B10', 'Băng keo chống thấm 15cm (T12) (10KG)'),
    item('B10T', 'Băng keo chống thấm 20cm (Thùng 9 cuộn) (10kg/thùng)'),
    item('B11', 'Băng keo chống thấm 10cm (T18) (11KG)'),
    item('B19', 'Băng keo chống thấm X2000 10cm (T18) - 19KG'),
    item('B155', 'Băng keo X2000 size 10cm (Thùng 18 cuộN/15.5KG) (OD)'),
    item('O10', 'Ổ điện VÀNG 4 Ổ 10m')
  ], { Fuse });
  const result = search(index, 'băng keo 10kg');
  assert.deepEqual(codes(result), ['B10', 'B10T']);
  assert.equal(result.fuzzy, false);
  assert.deepEqual(codes(search(index, 'BANG KEO 10KG')), ['B10', 'B10T']);
});

test('so khop tron so, chu cuoi duoc la tien to tu, cum go lien phai lien', () => {
  const index = buildIndex([item('C10', 'Cuộn 10m'), item('C100', 'Cuộn 100m'), item('BK', 'Băng keo'), item('KG', 'Thùng 10 cái 5kg')]);
  assert.deepEqual(codes(search(index, 'cuộn 10')), ['C10']);
  assert.deepEqual(codes(search(index, 'bang ke')), ['BK']);
  assert.deepEqual(codes(search(index, '10kg')), [], '"10" va "kg" khong dung lien');
  assert.deepEqual(codes(search(index, '10 kg')), ['KG'], 'go tach thi moi tu khop rieng');
});

test('thu tu muc khop 1-7 nhu tool', () => {
  const index = buildIndex([
    item('ZZ1', 'Có chứa bk10 ở giữa'),   // 6: ten chua nguyen cum (bk 10)
    item('XBK10', 'Hàng X'),              // 5: ma chua
    item('BK10A', 'Hàng A'),              // 3: ma bat dau bang
    item('Q1', 'bk10 đầu tên'),           // 4: ten bat dau bang
    item('BK10', 'Hàng gốc'),             // 1: ma khop dung
    item('Q2', 'bk 10'),                  // 2: ten khop dung
    item('Q3', 'Hàng', 'cụm ghi chú bk10') // 7: du moi cum trong ten + phu
  ]);
  assert.deepEqual(codes(search(index, 'bk10')), ['BK10', 'Q2', 'BK10A', 'Q1', 'XBK10', 'ZZ1', 'Q3']);
});

test('khop chac chan khong bi cat; co ket qua khop thi khong them ket qua mo', () => {
  const many = Array.from({ length: 150 }, (_, i) => item('K' + i, 'Keo dán số ' + i));
  const result = search(buildIndex(many, { Fuse }), 'keo');
  assert.equal(result.rows.length, 150);
  assert.equal(result.fuzzy, false);

  const few = [item('B1', 'Băng keo loại 1'), item('T1', 'Bnag keoo 1')];
  assert.deepEqual(codes(search(buildIndex(few, { Fuse }), 'bang keo')), ['B1']);
});

test('khong co ma khop: Fuse bu toi da FUZZY_LIMIT va bao fuzzy; khong co Fuse thi rong', () => {
  const rows = [item('BK20', 'Băng keo chống thấm'), item('DN1', 'Đèn ngủ')];
  const fuzzy = search(buildIndex(rows, { Fuse }), 'bang keoo');
  assert.deepEqual(codes(fuzzy), ['BK20']);
  assert.equal(fuzzy.fuzzy, true);
  assert.deepEqual(search(buildIndex(rows), 'bang keoo'), { rows: [], fuzzy: false });
  const typos = Array.from({ length: 150 }, (_, i) => item('T' + i, 'Bnag keoo ' + i));
  assert.equal(search(buildIndex(typos, { Fuse }), 'bang keo').rows.length, FUZZY_LIMIT);
});

test('tu khoa rong: tra moi dong theo thu tu dua vao', () => {
  const index = buildIndex([item('A', 'a'), item('B', 'b')], { Fuse });
  assert.deepEqual(search(index, '   '), { rows: [{ code: 'A' }, { code: 'B' }], fuzzy: false });
});
```

- [ ] **Step 2: Chạy test, phải FAIL**

Run: `node --test stocktake/stocktakeSearch.test.js`
Expected: FAIL (vd `result.rows` undefined vì `search` còn trả mảng).

- [ ] **Step 3: Viết lại `server/public/stocktake/stocktakeSearch.js`** (toàn file):

```js
/* Tim kiem trang Kiem ke, chuyen tu tool tra-cuu-vi-tri (Index.html: normalizeText / searchProducts), khop ten chat hon:
   moi tu go la 1 cum phai lien nhau va bat dau o dau 1 tu, so cuoi cum khop tron so; Fuse chi khi khong co ma khop.
   Dung chung trinh duyet (window.TKSStocktakeSearch) va Node (test). Fuse.js truyen vao tu ngoai (window.Fuse). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TKSStocktakeSearch = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const FUZZY_LIMIT = 100;
  const FUSE_OPTIONS = Object.freeze({
    includeScore: true, shouldSort: true, threshold: 0.36, distance: 100, ignoreLocation: true, minMatchCharLength: 2,
    keys: [{ name: 'code', weight: 0.25 }, { name: 'name', weight: 0.60 }, { name: 'extra', weight: 0.15 }]
  });
  const strip = value => String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
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
  // Vi tri dau tien cum `phrase` bat dau o dau 1 tu cua `text`; cum ket thuc bang so thi sau do khong duoc la chu so
  // ("10" khong khop "100"), ket thuc bang chu thi duoc la tien to tu ("ke" khop "keo"). Khong co -> -1.
  function findPhrase(text, phrase) {
    if (!phrase) return -1;
    const wholeNumber = /\d$/.test(phrase);
    let from = 0;
    for (;;) {
      const at = text.indexOf(phrase, from);
      if (at < 0) return -1;
      const next = text[at + phrase.length];
      if ((at === 0 || text[at - 1] === ' ') && (!wholeNumber || next === undefined || !/\d/.test(next))) return at;
      from = at + 1;
    }
  }
  // 1 ma dung · 2 ten dung · 3 ma bat dau · 4 ten bat dau (theo tu) · 5 ma chua · 6 ten chua ca cum (theo tu) · 7 du moi cum go.
  function rank(entry, queryText, queryCode, groups) {
    const { code, name, text } = entry;
    if (queryCode && code === queryCode) return [1, code.length];
    if (queryText && name === queryText) return [2, name.length];
    if (queryCode && code.startsWith(queryCode)) return [3, code.length];
    const inName = queryText ? findPhrase(name, queryText) : -1;
    if (inName === 0) return [4, name.length];
    if (queryCode && code.includes(queryCode)) return [5, code.indexOf(queryCode)];
    if (inName > 0) return [6, inName];
    if (!groups.length) return null;
    let tie = 0;
    for (const group of groups) {
      const at = findPhrase(text, group);
      if (at < 0) return null;
      tie += at;
    }
    return [7, tie];
  }
  function search(index, query) {
    const queryText = normalizeText(query);
    const queryCode = normalizeCode(query);
    if (!queryText && !queryCode) return { rows: index.entries.map(entry => entry.row), fuzzy: false };
    // Moi tu go (tach theo khoang trang) la 1 cum: "10kg" -> "10 kg" phai dung lien.
    const groups = String(query ?? '').split(/\s+/).map(normalizeText).filter(Boolean);
    const ranked = [];
    for (const entry of index.entries) {
      const hit = rank(entry, queryText, queryCode, groups);
      if (hit) ranked.push({ entry, priority: hit[0], tie: hit[1] });
    }
    ranked.sort((a, b) => a.priority - b.priority || a.tie - b.tie || a.entry.order - b.entry.order);
    if (ranked.length || !index.fuse) return { rows: ranked.map(item => item.entry.row), fuzzy: false };
    const fuzzy = new Map();
    const add = value => {
      if (!value) return;
      for (const hit of index.fuse.search(value, { limit: FUZZY_LIMIT * 2 })) {
        const score = hit.score ?? 1;
        const old = fuzzy.get(hit.item);
        if (old === undefined || score < old) fuzzy.set(hit.item, score);
      }
    };
    add(queryText);
    if (queryCode !== queryText) add(queryCode);
    const rows = [...fuzzy].sort((a, b) => a[1] - b[1] || a[0].order - b[0].order).slice(0, FUZZY_LIMIT).map(([entry]) => entry.row);
    return { rows, fuzzy: rows.length > 0 };
  }
  return { FUZZY_LIMIT, normalizeText, normalizeCode, buildIndex, search };
});
```

- [ ] **Step 4: Chạy test, phải PASS**

Run: `node --test stocktake/stocktakeSearch.test.js`
Expected: 7 test pass. Nếu test thứ tự 1–7 lệch, kiểm lại `rank` đúng thứ tự trên (mức 4 trước mức 5).

- [ ] **Step 5: Sửa nơi gọi trong `server/public/stocktake/stocktake.js`**

Thêm biến sau dòng `const view = { rows: [], drawn: 0, observer: null, order: null };`:

```js
  // Lan tim gan nhat chi ra ma gan giong (khong co ma khop dung) -> bao duoi thanh cong cu.
  let searchFuzzy = false;
```

Trong `visibleRows()`, thay 3 dòng cuối:

```js
    if (!state.query.trim()) return sortRows(rows);
    const allowed = new Set(rows);
    const found = Search.search(searchIndex(), state.query).filter(row => allowed.has(row));
    return state.sortKey && state.sortDir ? sortRows(found) : found;
```

bằng:

```js
    searchFuzzy = false;
    if (!state.query.trim()) return sortRows(rows);
    const allowed = new Set(rows);
    const result = Search.search(searchIndex(), state.query);
    searchFuzzy = result.fuzzy;
    const found = result.rows.filter(row => allowed.has(row));
    return state.sortKey && state.sortDir ? sortRows(found) : found;
```

(dòng `searchFuzzy = false;` đặt ngay sau `if (!state.board) return [];`, trước `const rows = …` cũng được — miễn là mỗi lần gọi đều đặt lại.)

Trong `render()`, thay:

```js
    if (board && !view.rows.length) $('stStatus').textContent = 'Không có mã nào khớp bộ lọc.';
    else if (board && $('stStatus').dataset.error !== 'true') $('stStatus').textContent = '';
```

bằng:

```js
    if (board && !view.rows.length) $('stStatus').textContent = 'Không có mã nào khớp bộ lọc.';
    else if (board && searchFuzzy) { $('stStatus').textContent = 'Không có mã khớp đúng, đang hiện mã gần giống.'; $('stStatus').dataset.error = 'false'; }
    else if (board && $('stStatus').dataset.error !== 'true') $('stStatus').textContent = '';
```

- [ ] **Step 6: Đổi phiên bản script** — `server/public/stocktake/index.html`: `stocktakeSearch.js?v=20261103-1` → `?v=20261103-2`, `stocktake.js?v=20261103-7` → `?v=20261103-8`.

- [ ] **Step 7: Kiểm tra cú pháp + test**

Run: `node --check public/stocktake/stocktake.js && node --test stocktake/stocktakeSearch.test.js`
Expected: không lỗi, 7 test pass.

- [ ] **Step 8: Commit**

```bash
git add server/public/stocktake/stocktakeSearch.js server/stocktake/stocktakeSearch.test.js server/public/stocktake/stocktake.js server/public/stocktake/index.html
git commit -m "feat(kiem-ke): tim kiem chat hon (cum lien, so tron), tim mo chi khi khong co ma khop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Máy chủ — bỏ vị trí kho, kiểm tra trạng thái, màu Excel theo loại

**Files:**
- Modify: `server/stocktake/stocktakeCompute.js` (`buildBoard`, chú thích JSDoc phía trên)
- Modify: `server/stocktake/stocktakeService.js` (import, `POSITIONS_SQL`, `POSITION_BRANCH`, `loadPositions`, `loadInputs`, `closedBoard`, `getBoard`, `saveNote`, `saveCells`)
- Modify: `server/stocktake/stocktakeExport.js`
- Test: `server/stocktake/stocktakeCompute.test.js`, `server/stocktake/stocktakeService.test.js`, `server/stocktake/stocktakeRoutes.test.js`

**Interfaces:**
- Consumes: `require('../public/stocktake/stocktakeStatus')` (Task 1): `isValid`, `optionsFor`, `colorOf`.
- Produces: dòng board không còn `latestPosition`; `board.suggestions` chỉ còn `{ reason: [...] }`; `saveCells` đếm trạng thái sai vào `skipped.invalid`; `saveNote` ném `400 VALIDATION` (`field: 'statusText'`) khi trạng thái mới không hợp lệ; `boardColumnHeaders(branch)` còn 23 cột (không còn "Vị trí kho gần nhất").
- KHÔNG xóa `STATUS_COLORS` khỏi `stocktakePaste.js` ở task này (trang web còn dùng tới Task 5).

- [ ] **Step 1: Sửa test trước (thất bại)**

`server/stocktake/stocktakeCompute.test.js`, test `'chenh theo Cum SP, KK truoc, vi tri, ghi chu'`: đổi tên thành `'chenh theo Cum SP, KK truoc, ghi chu; khong con vi tri kho'`, xóa dòng `positions: [...]` khỏi đối số `buildBoard`, thay dòng `assert.deepEqual(rows.A.latestPosition, ...)` bằng:

```js
  assert.equal('latestPosition' in rows.A, false);
```

`server/stocktake/stocktakeService.test.js`:
- Test đầu (`'bang doi chieu: …'`): thay `assert.deepEqual(rowOf(board, 'AAA1').latestPosition, { location: 'G1-15', arrivalDate: 'KK 4.10' });` bằng `assert.equal('latestPosition' in rowOf(board, 'AAA1'), false, 'khong con vi tri kho');`. Giữ dòng `INSERT INTO stock_positions …` trong fixture.
- Test `'ghi chu ma + nguoi kiem lai, goi y trang thai; …'`: dòng `statusText: 'ok', version: 99` → `statusText: 'OK', version: 99`; thay `assert.deepEqual(board.suggestions.status, ['KK trước']);` bằng:

```js
  assert.deepEqual(board.suggestions, { reason: ['lẫn mã'] });
```

- Thay TOÀN BỘ test `'mau trang thai: luu theo ma, mau la bi tu choi, sua tren bang giu nguyen mau'` bằng:

```js
test('trang thai: chi nhan 7 loai theo co so, giu chu cu khong doi, bo qua mau gui len', async () => {
  const { db, service, session } = await fixture();
  // Chu cu kieu dot nap tu sheet + mau cu nam san trong DB.
  await db.exec(`INSERT INTO stocktake_code_notes (session_id, product_code, status_text, status_color) VALUES (${session.id}, 'BBB2', 'lẫn bình giữ nhiệt', 'red')`);
  const cells = list => service.saveCells(ctx(), session.id, { cells: list });

  // Ten chuan duoc nhan; chu tu do bi bo qua (invalid), o khac cung lan van ghi
  let result = await cells([
    { code: 'AAA1', column: 'statusText', value: 'Lẫn' },
    { code: 'CCC3', column: 'statusText', value: 'lẫn bình' },
    { code: 'CCC3', column: 'reasonText', value: 'ghi chú' }
  ]);
  assert.deepEqual(result.applied.map(a => [a.code, a.column, a.after]), [['AAA1', 'statusText', 'Lẫn'], ['CCC3', 'reasonText', 'ghi chú']]);
  assert.equal(result.skipped.invalid, 1);
  // Ten co so kia va chu "Chưa XL" khong luu; trong (= Chua XL) thi duoc
  result = await cells([{ code: 'AAA1', column: 'statusText', value: 'Nhầm HN' }, { code: 'CCC3', column: 'statusText', value: 'Chưa XL' }]);
  assert.deepEqual([result.applied.length, result.skipped.invalid], [0, 2]);
  result = await cells([{ code: 'AAA1', column: 'statusText', value: '' }]);
  assert.deepEqual(result.applied.map(a => a.after), ['']);

  // Chu cu khong doi: gui lai dung chu cu = unchanged, cot khac cung ma van luu; mau cu giu nguyen
  result = await cells([{ code: 'BBB2', column: 'statusText', value: 'lẫn bình giữ nhiệt' }, { code: 'BBB2', column: 'printPage', value: '3' }]);
  assert.deepEqual([result.skipped.unchanged, result.applied.map(a => a.column)], [1, ['printPage']]);
  let b = rowOf(await service.getBoard(ctx(), session.id), 'BBB2').note;
  assert.deepEqual([b.statusText, b.statusColor, b.printPage], ['lẫn bình giữ nhiệt', 'red', '3']);

  // saveNote: giu chu cu + sua ly do duoc; chu tu do moi -> 400; statusColor gui len bi bo qua
  ({ note: b } = await service.saveNote(ctx(), session.id, 'BBB2', { statusText: 'lẫn bình giữ nhiệt', reasonText: 'lý do', statusColor: 'blue', version: b.version }));
  assert.deepEqual([b.statusText, b.reasonText, b.statusColor], ['lẫn bình giữ nhiệt', 'lý do', 'red']);
  await assert.rejects(service.saveNote(ctx(), session.id, 'BBB2', { statusText: 'mất ko thấy', version: b.version }),
    { statusCode: 400, code: 'VALIDATION', field: 'statusText' });
  ({ note: b } = await service.saveNote(ctx(), session.id, 'BBB2', { statusText: 'Mất', version: b.version }));
  assert.deepEqual([b.statusText, b.statusColor], ['Mất', 'red']);
  const cBefore = rowOf(await service.getBoard(ctx(), session.id), 'CCC3').note; // CCC3 da co ghi chu (ly do) -> can version
  const { note: c } = await service.saveNote(ctx(), session.id, 'CCC3', { statusText: 'Thừa', statusColor: 'blue', version: cBefore.version });
  assert.deepEqual([c.statusText, c.statusColor], ['Thừa', '']);

  // Dot Sai Gon: "Nhầm HN" moi dung ten
  const sg = (await service.createSession(ctx(), { branch: 'saigon', name: 'SG', dateFrom: '2026-10-29', dateTo: '2026-10-29' })).session;
  result = await service.saveCells(ctx(), sg.id, { cells: [{ code: 'AAA1', column: 'statusText', value: 'Nhầm HN' }] });
  assert.deepEqual(result.applied.map(a => a.after), ['Nhầm HN']);
  result = await service.saveCells(ctx(), sg.id, { cells: [{ code: 'AAA1', column: 'statusText', value: 'Nhầm SG' }] });
  assert.equal(result.skipped.invalid, 1);
});
```

- Đổi giá trị trạng thái trong các test còn lại sang tên chuẩn (giữ nguyên ý nghĩa test):
  - `'sua tren bang: nguoi kiem lai khop / …'`: `value: 'sau'` → `value: 'Thừa'`.
  - `'sua tren bang: nhieu cot cung ma …'`: `value: 'mất', expected: ''` → `value: 'Mất', expected: ''`; trong `assert.deepEqual(result.applied…)` `['AAA1', 'statusText', '', 'mất']` → `['AAA1', 'statusText', '', 'Mất']`; trong assert cuối `['mất', 'lý do', …]` → `['Mất', 'lý do', …]`. Giữ `{ code: 'ZZZ9', column: 'statusText', value: 'x' }` (mã lạ, đếm notFound trước khi kiểm trạng thái).
  - `'sua tren bang: expected lech -> conflict …'`:
    - `{ code: 'AAA1', column: 'statusText', value: 'mất', expected: '' }` → `value: 'Mất'`.
    - `service.saveNote(ctx(HUNG), session.id, 'AAA1', { statusText: 'Hưng sửa', statusColor: 'red', version: a.note.version })` → `{ statusText: 'Lẫn', version: a.note.version }`.
    - `{ code: 'AAA1', column: 'statusText', value: 'của tôi', expected: 'mất' }` → `{ …, value: 'Thừa', expected: 'Mất' }`.
    - `current: 'Hưng sửa'` → `current: 'Lẫn'`.
    - `assert.deepEqual([a.note.statusText, a.note.statusColor, a.note.printPage], ['Hưng sửa', 'red', '12'], 'mau trang thai giu nguyen');` → `assert.deepEqual([a.note.statusText, a.note.printPage], ['Lẫn', '12']);`
    - Khối cuối: `value: 'cu'` → `'KK trước'`, `value: 'moi'` → `'Thừa'`, `{ code: 'AAA1', column: 'statusText', value: 'Hưng sửa' }` → `value: 'Lẫn'`; `[1.234, 'moi']` → `[1.234, 'Thừa']`.
  - Giữ `value: 'x'` trong test `'sua tren bang: kiem tra dau vao, dot da dong'` (bị chặn trước khi kiểm trạng thái).

`server/stocktake/stocktakeRoutes.test.js`:
- Trong mảng dòng giả (đầu file): xóa `latestPosition: { location: 'G1' }, ` và `latestPosition: null, `; ở note của AAA1 xóa `statusColor: 'red', ` (giữ `statusText: 'ok'`).
- Test `'Xuat Excel: …'`: `assert.equal(boardColumnHeaders('hanoi').length, 24);` → `23`; thay `assert.equal(rows.getRow(2).getCell(22).value, 'G1');` bằng:

```js
  assert.ok(!boardColumnHeaders('hanoi').includes('Vị trí kho gần nhất'));
  assert.equal(rows.getRow(2).getCell(22).value, 1000, 'cot 22 nay la Gia von');
  assert.equal(rows.getRow(2).getCell(7).fill.fgColor.argb, 'FFEEFF41', 'o Trang thai to theo loai (ok -> OK, vang neon)');
  const plain = rows.getRow(3).getCell(7).fill;
  assert.ok(!plain || plain.pattern !== 'solid', 'khong co trang thai -> khong to');
```

(Nếu thứ tự dòng 2/3 trong file xuất khác — kiểm `getRow(2).getCell(1).value` là `'AAA1'` trước, các assert khác trong test đã dùng dòng 2 = AAA1.)

- [ ] **Step 2: Chạy test, phải FAIL**

Run: `node --test stocktake/stocktakeCompute.test.js stocktake/stocktakeService.test.js stocktake/stocktakeRoutes.test.js`
Expected: FAIL ở các assert mới (`latestPosition` còn, `suggestions.status` còn, trạng thái tự do vẫn lưu, 24 cột…).

- [ ] **Step 3: `stocktakeCompute.js` — bỏ vị trí kho**

- JSDoc trên `buildBoard`: `products: [{ code, name, stock, cost }]; positions: [{ code, location, arrivalDate }] (dong dau tien cua ma = moi nhat);` → `products: [{ code, name, stock, cost }];`.
- Chữ ký: `function buildBoard({ lines = [], edits = [], products = [], positions = [], tags = [], notes = [], previous = [], counterpart = [] } = {})` → bỏ `positions = [], `.
- Xóa khối:

```js
  const positionByCode = new Map();
  for (const position of positions) {
    const code = codeKey(position.code);
    if (code && !positionByCode.has(code)) positionByCode.set(code, position);
  }
```

- Trong `rows.map`: xóa `const position = positionByCode.get(row.code);` và dòng `latestPosition: position ? { … } : null,`.

- [ ] **Step 4: `stocktakeService.js` — bỏ vị trí kho**

- Xóa `POSITIONS_SQL` (cùng chú thích "stock_positions dung ma co so…"), `POSITION_BRANCH`, hàm `loadPositions` (cùng chú thích).
- `loadInputs`: trong `if (fresh)` xóa `cache.delete('positions:' + session.branch);`; bỏ `positions` khỏi `const [lines, edits, products, positions, tags, …]`, xóa phần tử `loadPositions(db, session.branch),` trong `Promise.all`, và bỏ `positions` khỏi `return { lines, edits, products, positions, tags, notes, ...prev, ...other };`.
- `closedBoard`: bỏ `positions` khỏi destructuring và phần tử `loadPositions(db, session.branch)` (nhớ xóa dấu phẩy thừa ở phần tử trước); xóa khối `const positionByCode = new Map(); for (const item of positions) {…}`; xóa `latestPosition: positionByCode.get(row.product_code) || null, ` (giữ `note, lines: []`).
- `getBoard`: thay khối gợi ý bằng:

```js
    // Goi y Chi tiet ly do: cac gia tri da dung trong dot (Trang thai nay la danh sach co dinh, xem stocktakeStatus.js).
    const reasons = new Set();
    for (const row of board.rows) {
      if (row.note && row.note.reasonText) reasons.add(row.note.reasonText);
    }
    return { session, ...board, employees, suggestions: { reason: [...reasons].sort() } };
```

- [ ] **Step 5: `stocktakeService.js` — kiểm tra trạng thái**

- Import: dòng `const { PASTE_COLUMNS, STATUS_COLORS, normalizeValue, … } = require('../public/stocktake/stocktakePaste');` bỏ `STATUS_COLORS, `; thêm ngay dưới:

```js
const Status = require('../public/stocktake/stocktakeStatus');
```

- Thêm hàm cạnh `textOf`:

```js
// Trang thai moi phai la ten chuan theo co so (stocktakeStatus.js) hoac trong (= Chua XL).
const statusInvalid = branch => `Trạng thái phải là một trong: ${Status.optionsFor(branch).map(option => option.label).join(', ')}.`;
```

- `saveNote`: thay 3 dòng

```js
      const statusText = body.statusText === undefined ? (before ? before.statusText : '') : textOf(body, 'statusText', 'Trạng thái');
      const statusColor = body.statusColor === undefined ? (before ? before.statusColor : '') : String(body.statusColor ?? '');
      if (statusColor && !Object.hasOwn(STATUS_COLORS, statusColor)) throw fail(400, 'VALIDATION', 'Màu trạng thái không hợp lệ.', { field: 'statusColor' });
```

bằng:

```js
      const statusText = body.statusText === undefined ? (before ? before.statusText : '') : textOf(body, 'statusText', 'Trạng thái');
      // Giu nguyen chu cu (dot nap tu sheet) thi khong kiem; doi thi phai la ten chuan.
      if (statusText !== (before ? before.statusText : '') && !Status.isValid(statusText, session.branch)) {
        throw fail(400, 'VALIDATION', statusInvalid(session.branch), { field: 'statusText' });
      }
      // Mau hien thi tinh tu chu trang thai (Status.colorOf); cot status_color chi giu gia tri cu, bo qua statusColor gui len.
      const statusColor = before ? before.statusColor : '';
```

- `saveCells`, trong vòng `for (const cell of latest.values())`, ngay sau dòng `if (cell.check && !sameValue(cell.column, current, cell.expected)) { … continue; }` thêm:

```js
        // Trang thai: chi ten chuan theo co so hoac trong; gui lai dung chu cu (khong doi) thi de sameRecord tinh unchanged.
        if (cell.column === 'statusText' && parsed.value !== current && !Status.isValid(parsed.value, session.branch)) { skipped.invalid += 1; continue; }
```

- [ ] **Step 6: `stocktakeExport.js` — bỏ cột vị trí, màu theo loại**

- Thay `const { STATUS_COLORS } = require('../public/stocktake/stocktakePaste');` bằng `const Status = require('../public/stocktake/stocktakeStatus');`.
- Xóa dòng `{ header: 'Vị trí kho gần nhất', … },`.
- Thay

```js
    // To o Trang thai theo mau nguoi dung chon tren web.
    const color = row.note && STATUS_COLORS[row.note.statusColor];
    if (color) added.getCell(statusColumn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color.argb } };
```

bằng

```js
    // To o Trang thai theo loai (stocktakeStatus.js); Chua XL / Khac khong to.
    const color = Status.colorOf(row.note ? row.note.statusText : '');
    if (color) added.getCell(statusColumn).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + color.slice(1).toUpperCase() } };
```

- [ ] **Step 7: Chạy test, phải PASS**

Run: `node --test stocktake/stocktakeCompute.test.js stocktake/stocktakeService.test.js stocktake/stocktakeRoutes.test.js stocktake/stocktakeSheetImport.test.js stocktake/stocktakePaste.test.js stocktake/stocktakeStatus.test.js`
Expected: tất cả pass. Thêm: `node --test db/rollbacks/stocktakeRollback.test.js` pass.

- [ ] **Step 8: Không còn tham chiếu vị trí kho ở máy chủ**

Run (trong `server/`): `grep -rn "latestPosition\|loadPositions\|POSITIONS_SQL" stocktake/`
Expected: không có kết quả.

- [ ] **Step 9: Commit**

```bash
git add server/stocktake/stocktakeCompute.js server/stocktake/stocktakeService.js server/stocktake/stocktakeExport.js server/stocktake/stocktakeCompute.test.js server/stocktake/stocktakeService.test.js server/stocktake/stocktakeRoutes.test.js
git commit -m "feat(kiem-ke): may chu chi nhan trang thai theo danh sach, bo vi tri kho, to Excel theo loai

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Trang web — bỏ cột Vị trí kho, ô xuống dòng, tô màu theo loại, thẻ tổng + lọc theo loại

**Files:**
- Modify: `server/public/stocktake/stocktake.js`
- Modify: `server/public/stocktake/index.html`
- Modify: `server/public/stocktake/stocktake.css`

**Interfaces:**
- Consumes: `window.TKSStocktakeStatus` (Task 1): `classify`, `colorOf`, `labelFor`, `optionsFor`, `summarize`, `STATUS_TYPES`, `OTHER`. Board từ Task 3: không còn `latestPosition`, `suggestions` chỉ còn `reason`.
- Produces: `state.status` giờ là key loại (`'lost'`…`'pending'`, `'other'`) hoặc `''`; phần tử `#stStatusCards`; ô Trạng thái có `data-status` + biến CSS `--st-status`.

Không có test Node cho DOM trang này; kiểm bằng `node --check` + controller kiểm trên server test.

- [ ] **Step 1: `index.html`**

- Thêm script sau dòng `stocktakeGrid.js`: `<script src="/stocktake/stocktakeStatus.js?v=20261103-1"></script>`.
- `stocktake.js?v=20261103-8` → `?v=20261103-9`; `stocktake.css?v=20261103-7` → `?v=20261103-8`.
- Trong `<section class="locations-panel" aria-labelledby="stTableTitle">`, ngay sau `</div>` đóng `.locations-toolbar` (trước `<p id="stStatus" …>`), thêm:

```html
        <div class="st-status-cards" id="stStatusCards" role="group" aria-label="Tổng giá trị chênh theo trạng thái"></div>
```

- [ ] **Step 2: `stocktake.js` — bỏ cột Vị trí kho**

- Xóa dòng `{ key: 'position', label: 'Vị trí kho gần nhất', width: 130, type: 'text' },` khỏi `COLUMNS`.
- `sortValue`: xóa `case 'position': …`. `cellText`: xóa `case 'position': …`.
- `renderHead`: `key: 'stocktake-board-v4'` → `key: 'stocktake-board-v5'`.
- `renderDetail`: thay `$('stDetailSubtitle').textContent = [row.name, row.latestPosition && ('Vị trí: ' + row.latestPosition.location)].filter(Boolean).join(' · ');` bằng `$('stDetailSubtitle').textContent = row.name || '';`.

- [ ] **Step 3: `stocktake.js` — tô màu theo loại, lọc theo loại**

- Thêm sau `const Paste = window.TKSStocktakePaste;`: `const Status = window.TKSStocktakeStatus;`.
- `rowElement`: thay dòng `if (column.key === 'status' && row.note && STATUS_COLORS[row.note.statusColor]) td.dataset.color = row.note.statusColor;` bằng:

```js
      if (column.key === 'status') {
        // Mau theo loai trang thai (chu cu T10 cung xep loai); Chua XL / Khac khong to.
        const color = Status.colorOf(row.note ? row.note.statusText : '');
        if (color) {
          td.dataset.status = Status.classify(row.note.statusText);
          td.style.setProperty('--st-status', color);
        }
      }
```

- `visibleRows`: thay `if (state.status && (row.note ? row.note.statusText : '') !== state.status) return false;` bằng `if (state.status && Status.classify(row.note ? row.note.statusText : '') !== state.status) return false;`.
- `renderFilters()` đổi thành nhận `summary`:

```js
  function renderFilters(summary) {
    const entries = [...recheckCounts()].map(([key, entry]) => [key, entry.label]).sort((a, b) => a[1].localeCompare(b[1]));
    fillSelect($('stRecheckFilter'), 'Mọi người kiểm lại', entries, state.recheck);
    state.recheck = $('stRecheckFilter').value;
    // Loc Trang thai theo loai (dong bo voi the tong); "Khác" chi khi dot co chu khong xep duoc loai.
    const branch = state.board ? state.board.session.branch : 'hanoi';
    const kinds = Status.optionsFor(branch).map(option => [option.key, option.label]);
    if (summary && summary.has(Status.OTHER.key)) kinds.push([Status.OTHER.key, Status.OTHER.label]);
    fillSelect($('stStatusFilter'), 'Mọi trạng thái', kinds, state.status);
    state.status = $('stStatusFilter').value;
  }
```

(xóa `const board = state.board;` cũ trong hàm nếu không còn dùng.)

- [ ] **Step 4: `stocktake.js` — thẻ tổng theo trạng thái**

Thêm hàm ngay sau `renderStats`:

```js
  // The tong theo trang thai: tinh tren toan dot (khong theo tim kiem / loc); bam = loc theo loai, bam lai = bo loc.
  function renderStatusCards(summary) {
    const box = $('stStatusCards');
    box.textContent = '';
    if (!summary) return;
    const branch = state.board.session.branch;
    for (const [key, total] of summary) {
      const type = Status.STATUS_TYPES.find(t => t.key === key);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'st-status-card';
      button.dataset.statusKey = key;
      if (type) button.style.setProperty('--st-status', type.color);
      button.setAttribute('aria-pressed', String(state.status === key));
      const name = document.createElement('span');
      name.className = 'st-status-name';
      name.textContent = Status.labelFor(key, branch);
      const count = document.createElement('span');
      count.className = 'st-status-count';
      count.textContent = num(total.count) + ' mã';
      const value = document.createElement('b');
      value.textContent = num(total.diffValue);
      if (total.diffValue < 0) value.className = 'st-neg';
      button.append(name, count, value);
      box.appendChild(button);
    }
  }
```

Trong `render()`, thay `renderFilters();` bằng:

```js
    const summary = board ? Status.summarize(board.rows) : null;
    renderFilters(summary);
    renderStatusCards(summary);
```

Trong `bindTable()`, sau dòng `$('stStatusFilter').addEventListener(…)`, thêm:

```js
    $('stStatusCards').addEventListener('click', event => {
      const card = event.target.closest('[data-status-key]');
      if (!card) return;
      state.status = state.status === card.dataset.statusKey ? '' : card.dataset.statusKey;
      $('stStatusFilter').value = state.status;
      rerender();
    });
```

- [ ] **Step 5: `stocktake.css`**

Thay khối cuối file (chú thích "Tiêu đề và ô một dòng…" và dòng `#stTable th,#stTable td{white-space:nowrap !important;overflow:hidden;overflow-wrap:normal !important;text-overflow:clip !important}`) bằng:

```css
/* Tiêu đề một dòng: cột hẹp hơn chữ thì chữ bị cắt ở mép ô (cột bên phải như đè lên, giống Excel).
   Ô dữ liệu xuống dòng để luôn thấy hết chữ (từ quá dài ngắt giữa từ), hàng cao theo ô dài nhất.
   Ghi đè table-controls (white-space:normal; overflow-wrap:anywhere) chỉ cho bảng kiểm kê. */
#stTable thead th{white-space:nowrap !important;overflow:hidden;overflow-wrap:normal !important;text-overflow:clip !important}
#stTable tbody td{white-space:normal !important;overflow-wrap:anywhere !important;text-overflow:clip !important;vertical-align:top}
```

(giữ nguyên các dòng `#stTable thead th{padding…}`, `#stTable tbody td{padding…}` và các luật `.sort-button` / `.sort-indicator` / `.sort-label` phía sau.)

Thêm cuối file:

```css
/* Ô Trạng thái tô theo loại (màu lấy từ stocktakeStatus.js qua --st-status); chữ tối trên mọi nền màu, cả giao diện tối. */
.st-table td[data-field="status"][data-status]{background:var(--st-status);color:#111;font-weight:600}
/* Thẻ tổng theo trạng thái: một hàng, cuộn ngang trên màn hình hẹp. */
.st-status-cards{display:flex;gap:8px;padding:0 16px 12px;overflow-x:auto}
.st-status-cards:empty{display:none}
.st-status-card{flex:0 0 auto;display:grid;grid-template-columns:auto auto;align-items:baseline;gap:2px 10px;min-width:132px;min-height:44px;padding:8px 12px 8px 12px;border:1px solid var(--border);border-left:6px solid var(--st-status,var(--muted));border-radius:var(--radius-sm);background:var(--panel-2);color:var(--text);font:13px var(--font-body);text-align:left;cursor:pointer}
.st-status-card[data-status-key="pending"]{border-left-color:var(--muted)}
.st-status-card .st-status-name{font-weight:600}
.st-status-card .st-status-count{color:var(--muted);font-size:12px;text-align:right}
.st-status-card b{grid-column:1 / -1;font:600 15px var(--font-data);font-variant-numeric:tabular-nums}
.st-status-card b.st-neg{color:var(--red)}
.st-status-card[aria-pressed="true"]{border-color:var(--text);border-left-color:var(--st-status,var(--muted));box-shadow:inset 0 0 0 1px var(--text)}
.st-status-card[data-status-key="pending"][aria-pressed="true"]{border-left-color:var(--muted)}
.st-status-card:focus-visible{outline:2px solid var(--blue);outline-offset:2px}
```

- [ ] **Step 6: Kiểm tra**

Run (trong `server/`): `node --check public/stocktake/stocktake.js && grep -n "latestPosition\|'position'\|stocktake-board-v4" public/stocktake/stocktake.js`
Expected: `node --check` không lỗi; grep không có kết quả.

- [ ] **Step 7: Commit**

```bash
git add server/public/stocktake/stocktake.js server/public/stocktake/index.html server/public/stocktake/stocktake.css
git commit -m "feat(kiem-ke): the tong theo trang thai, loc theo loai, o du lieu xuong dong, bo cot vi tri kho

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Trang web — sửa Trạng thái bằng danh sách chọn, dán/kéo theo loại, hộp chi tiết, bỏ chọn màu

**Files:**
- Modify: `server/public/stocktake/stocktake.js`
- Modify: `server/public/stocktake/index.html`
- Modify: `server/public/stocktake/stocktake.css`
- Modify: `server/public/stocktake/stocktakePaste.js` (xóa `STATUS_COLORS`)
- Test: `server/stocktake/stocktakePaste.test.js` (xóa test `STATUS_COLORS`)

**Interfaces:**
- Consumes: `Status` (đã khai báo ở Task 4): `optionsFor`, `classify`, `canonical`, `isValid`, `fold`. `editor` object hiện có (`input`, `code`, `column`, `start`, `expected`, `sessionId`).
- Produces: `editor.options` (mảng lựa chọn, chỉ khi đang mở danh sách Trạng thái), `editor.index`, `editor.typed`, `editor.typedAt`. `stocktakePaste.js` không còn export `STATUS_COLORS`.

- [ ] **Step 1: Xóa `STATUS_COLORS` khỏi `stocktakePaste.js` + test (thất bại trước)**

`server/stocktake/stocktakePaste.test.js`: thay test `'STATUS_COLORS: bang mau trang thai dung chung'` bằng:

```js
test('STATUS_COLORS da bo: mau trang thai tinh theo loai (stocktakeStatus.js)', () => {
  assert.equal('STATUS_COLORS' in require('../public/stocktake/stocktakePaste'), false);
});
```

Run: `node --test stocktake/stocktakePaste.test.js` → FAIL.

Trong `server/public/stocktake/stocktakePaste.js`: xóa chú thích `// Mau danh dau Trang thai …` và khối `const STATUS_COLORS = Object.freeze({ … });`, bỏ `STATUS_COLORS, ` khỏi `return { … }`.

Run: `node --test stocktake/stocktakePaste.test.js stocktake/stocktakeService.test.js stocktake/stocktakeRoutes.test.js` → PASS (máy chủ không còn dùng `STATUS_COLORS` sau Task 3; nếu còn tham chiếu, `grep -rn STATUS_COLORS server/stocktake server/public/stocktake` và xóa).

- [ ] **Step 2: `stocktake.js` — bỏ chọn màu và `STATUS_COLORS`**

- Xóa dòng `const STATUS_COLORS = window.TKSStocktakePaste ? window.TKSStocktakePaste.STATUS_COLORS : {};`.
- Xóa hàm `bindStatusColors()` (cùng chú thích "Ô chọn màu cho Trạng thái…") và lời gọi `bindStatusColors();` trong `init`.
- `historyText`: dòng `if (item.action === 'note') return [recheckLabel(after), after.statusText, STATUS_COLORS[after.statusColor] && 'màu ' + …, after.reasonText, …]` → `if (item.action === 'note') return [recheckLabel(after), after.statusText, after.reasonText, after.printPage && 'Trang ' + after.printPage].filter(Boolean).join(' · ');`
- Submit `stNoteForm`: xóa dòng `statusColor: form.elements.statusColor.value || '',`.
- `renderDetail`: xóa dòng `noteForm.elements.statusColor.value = …`; thay `noteForm.elements.statusText.value = note.statusText || '';` bằng `fillStatusSelect(noteForm.elements.statusText, note.statusText || '');`; thay vòng gợi ý

```js
    for (const [id, values] of [['stStatusSuggestions', state.board.suggestions.status], ['stReasonSuggestions', state.board.suggestions.reason]]) {
      const list = $(id);
      list.textContent = '';
      for (const value of values) { const option = document.createElement('option'); option.value = value; list.appendChild(option); }
    }
```

bằng

```js
    const reasons = $('stReasonSuggestions');
    reasons.textContent = '';
    for (const value of state.board.suggestions.reason) { const option = document.createElement('option'); option.value = value; reasons.appendChild(option); }
```

- Thêm hàm ngay trước `renderDetail`:

```js
  // Hop chi tiet: 7 loai theo co so ("Chưa XL" = trong); chu cu (khong phai ten chuan) them 1 lua chon dau de luu lai khong doi.
  function fillStatusSelect(select, current) {
    const branch = state.board.session.branch;
    const entries = Status.optionsFor(branch).map(option => [option.key === 'pending' ? '' : option.label, option.label]);
    if (current && !Status.isValid(current, branch)) entries.unshift([current, '‹' + current + '›']);
    select.textContent = '';
    for (const [value, label] of entries) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = current;
  }
```

- [ ] **Step 3: `index.html` — ô Trạng thái của hộp chi tiết thành `<select>`**

Thay hai dòng

```html
          <label class="vt-field"><span>Trạng thái</span><input name="statusText" type="text" maxlength="200" list="stStatusSuggestions" autocomplete="off"><datalist id="stStatusSuggestions"></datalist></label>
          <fieldset class="st-color-pick st-wide" id="stStatusColors"><legend>Màu trạng thái</legend></fieldset>
```

bằng

```html
          <label class="vt-field"><span>Trạng thái</span><select name="statusText" class="st-select"></select></label>
```

Đổi phiên bản: `stocktakePaste.js?v=20261103-2` → `?v=20261103-3`; `stocktake.js?v=20261103-9` → `?v=20261103-10`; `stocktake.css?v=20261103-8` → `?v=20261103-9`.

- [ ] **Step 4: `stocktake.js` — danh sách chọn Trạng thái trên bảng**

Trong `openEditor(initial)`, ngay sau `if (!td || !row) return;` thêm:

```js
    if (column === 'statusText') { openStatusMenu(td, row, initial); return; }
```

Thêm các hàm ngay sau `openEditor`:

```js
  // O Trang thai: mo danh sach 7 loai (thay o nhap) duoi o. Dung chung `editor` (editor.input = khung danh sach,
  // editor.options = cac lua chon) nen moi cho dang chan khi co o nhap mo cung chan khi danh sach mo.
  function openStatusMenu(td, row, initial) {
    const options = Status.optionsFor(state.board.session.branch);
    const current = Status.classify(row.note ? row.note.statusText : '');
    const box = boxIn(td);
    const list = document.createElement('div');
    list.className = 'st-status-menu';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Chọn trạng thái');
    list.tabIndex = -1;
    options.forEach((option, index) => {
      const item = document.createElement('div');
      item.className = 'st-status-option';
      item.setAttribute('role', 'option');
      item.dataset.index = String(index);
      item.style.setProperty('--st-status', option.color);
      item.textContent = option.label;
      list.appendChild(item);
    });
    Object.assign(list.style, { left: box.left + 'px', top: box.top + box.height + 'px', minWidth: Math.max(box.width, 140) + 'px' });
    Object.assign(editor, {
      input: list, code: row.code, column: 'statusText', start: (row.note && row.note.statusText) || '',
      expected: expectedOf(row, 'statusText'), sessionId: state.sessionId,
      options, index: Math.max(0, options.findIndex(option => option.key === current)), typed: '', typedAt: 0
    });
    box.scroller.appendChild(list);
    list.focus({ preventScroll: true });
    highlightStatusMenu();
    if (initial) typeInStatusMenu(initial);
    positionFill();
    list.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : editor.options.length - 1;
        editor.index = (editor.index + step) % editor.options.length;
        highlightStatusMenu();
      } else if (event.key === 'Enter') { event.preventDefault(); closeEditor(true, [1, 0]); }
      else if (event.key === 'Tab') { event.preventDefault(); closeEditor(true, [0, event.shiftKey ? -1 : 1]); }
      else if (event.key === 'Escape') { event.preventDefault(); closeEditor(false); }
      else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); typeInStatusMenu(event.key); }
    });
    // mousedown + preventDefault: giu focus o danh sach (khong blur) roi luu lua chon vua bam.
    list.addEventListener('mousedown', event => {
      event.preventDefault();
      event.stopPropagation();
      const item = event.target.closest('[data-index]');
      if (!item) return;
      editor.index = Number(item.dataset.index);
      closeEditor(true);
    });
    list.addEventListener('blur', () => closeEditor(false));
  }

  function highlightStatusMenu() {
    editor.input.querySelectorAll('[data-index]').forEach(item => {
      const on = Number(item.dataset.index) === editor.index;
      item.setAttribute('aria-selected', String(on));
      if (on) item.scrollIntoView({ block: 'nearest' });
    });
  }

  // Go chu khi danh sach mo: nhay toi lua chon dau tien bat dau bang chuoi da go (go lien trong 800 ms thi noi chuoi).
  function typeInStatusMenu(key) {
    const now = Date.now();
    editor.typed = (now - editor.typedAt < 800 ? editor.typed : '') + key;
    editor.typedAt = now;
    const wanted = Status.fold(editor.typed);
    const found = editor.options.findIndex(option => Status.fold(option.label).startsWith(wanted));
    if (found >= 0) { editor.index = found; highlightStatusMenu(); }
  }
```

Sửa `closeEditor(save, move)` — thay 4 dòng đầu:

```js
    const { input, code, column, start, expected, sessionId } = editor;
    if (!input) return;
    editor.input = null;
    const value = input.value;
```

bằng:

```js
    const { input, code, column, start, expected, sessionId, options, index } = editor;
    if (!input) return;
    editor.input = null;
    editor.options = null;
    // Danh sach Trang thai: gia tri = ten loai dang chon ("Chưa XL" = trong).
    const value = options ? (options[index].key === 'pending' ? '' : options[index].label) : input.value;
```

Trong `bindSelection`, mousedown của `tbody`: `if (editor.input) closeEditor(true);` → `if (editor.input) closeEditor(!editor.options); // nhap chu: luu nhu Sheets; danh sach Trang thai: bam ra ngoai = khong luu`.

- [ ] **Step 5: `stocktake.js` — dán / kéo / xóa cột Trạng thái theo loại**

Thay hàm `writeTargets` bằng:

```js
  const statusSkipText = count => 'Bỏ qua ' + num(count) + ' ô trạng thái không thuộc danh sách.';
  // targets: [{ row, col, raw }] theo chi so view.rows / COLUMNS. O cot khong sua duoc / gia tri sai -> bo qua.
  // Cot Trang thai: chu dan / keo -> ten loai chuan theo co so (chu cu "lẫn bình" -> "Lẫn"); khong xep duoc loai thi bo qua.
  async function writeTargets(targets, verb, { countIgnored = true } = {}) {
    const branch = state.board.session.branch;
    const cells = [];
    let ignored = 0;
    let badStatus = 0;
    for (const target of targets) {
      const column = editColumnOf(target.col);
      const row = view.rows[target.row];
      let raw = target.raw;
      if (column === 'statusText') {
        raw = Status.canonical(raw, branch);
        if (raw === null) { badStatus += 1; continue; }
      }
      if (!column || !row || !Paste.normalizeValue(column, raw).ok) { ignored += 1; continue; }
      cells.push({ code: row.code, column, value: raw, expected: expectedOf(row, column) });
    }
    if (!cells.length) { notify(badStatus ? statusSkipText(badStatus) : 'Không có ô nào sửa được trong vùng này.', true); return; }
    const payload = await sendCells(cells);
    if (payload) {
      const text = cellsMessage(verb, payload, countIgnored ? ignored : 0) + (badStatus ? ' ' + statusSkipText(badStatus) : '');
      notify(text, payload.conflicts.length > 0 || badStatus > 0);
    }
  }
```

(Kéo nhân bản đã lấy giá trị lưu của ô nguồn qua `expectedOf` rồi gọi `writeTargets` → tự qua `canonical`; Delete gửi `''` → `canonical('')` = `''`.)

- [ ] **Step 6: `stocktake.css`**

Xóa các luật màu cũ: dòng chú thích `/* Màu Trạng thái do người dùng chọn. */`, `.st-table td[data-field="status"][data-color]{font-weight:600}`, 8 dòng `[data-color="…"]{--st-color:…}`, `.st-table td[data-field="status"][data-color]{background:color-mix(…)}` và các luật `.st-color-pick…`, `.st-swatch…` (đến hết `.st-swatch input:disabled…`).

Thêm cuối file:

```css
/* Danh sách chọn Trạng thái (gõ / Enter trên ô Trạng thái). */
.st-status-menu{position:absolute;z-index:7;display:flex;flex-direction:column;padding:4px;border:2px solid #06b6d4;background:var(--panel);box-shadow:0 6px 16px rgba(0,0,0,.3);outline:none}
.st-status-option{display:flex;align-items:center;gap:8px;min-height:32px;padding:4px 10px;color:var(--text);font:13px var(--font-body);cursor:pointer;white-space:nowrap}
.st-status-option::before{content:"";flex:0 0 auto;width:12px;height:12px;border-radius:50%;background:var(--st-status);border:1px solid var(--border)}
.st-status-option:hover{background:color-mix(in srgb,#06b6d4 18%,var(--panel))}
.st-status-option[aria-selected="true"]{background:color-mix(in srgb,#06b6d4 32%,var(--panel))}
```

- [ ] **Step 7: Kiểm tra**

Run (trong `server/`):
`node --check public/stocktake/stocktake.js && node --check public/stocktake/stocktakePaste.js && grep -rn "STATUS_COLORS\|statusColor\|stStatusColors\|stStatusSuggestions\|data-color" public/stocktake/ stocktake/stocktakeExport.js`
Expected: `node --check` không lỗi; grep không có kết quả (máy chủ `stocktakeService.js` vẫn đọc cột `status_color` — không nằm trong lệnh grep này).
Run: `node --test stocktake/stocktakePaste.test.js stocktake/stocktakeGrid.test.js stocktake/stocktakeStatus.test.js` → PASS.

- [ ] **Step 8: Commit**

```bash
git add server/public/stocktake/stocktake.js server/public/stocktake/index.html server/public/stocktake/stocktake.css server/public/stocktake/stocktakePaste.js server/stocktake/stocktakePaste.test.js
git commit -m "feat(kiem-ke): o Trang thai chon tu danh sach, dan/keo xep theo loai, bo chon mau

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Tài liệu

**Files:**
- Modify: `README.md`, `server/README.md`, `server/db/SCHEMA.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `docs/04-planning/implementation_plan.md`, `CURRENT.md`

**Interfaces:** chỉ tài liệu. Theo skill `update-file` (`.agents/skills/update-file/SKILL.md`) — đọc trước.

- [ ] **Step 1: README.md** — cây thư mục: thêm `server/public/stocktake/stocktakeStatus.js` (module trạng thái 7 loại dùng chung) và `server/stocktake/stocktakeStatus.test.js` cạnh các file kiểm kê khác; "Cập nhật gần nhất" đầu dòng: `03/11/2026 (Kiểm kê: trạng thái chọn từ 7 loại có màu tự động + thẻ tổng giá trị chênh theo trạng thái, ô dữ liệu xuống dòng, bỏ cột Vị trí kho gần nhất, tìm kiếm chặt hơn; không migration; …)` giữ phần "trước đó" cũ phía sau.
- [ ] **Step 2: server/README.md** — mục API kiểm kê: `POST /api/stocktake/sessions/:id/cells` và `PUT …/codes/:code/note` — Trạng thái chỉ nhận `''` hoặc tên chuẩn theo cơ sở (Mất, KK trước, OK, Nhầm SG / đợt SG: Nhầm HN, Thừa, Lẫn; "Chưa XL" = trống), giữ nguyên chữ cũ không đổi vẫn nhận; `/cells` đếm ô sai vào `skipped.invalid`, `/note` trả 400 `VALIDATION`; `statusColor` gửi lên bị bỏ qua; board không còn `latestPosition`, `suggestions` chỉ còn `reason`; Excel bỏ cột "Vị trí kho gần nhất", ô Trạng thái tô theo loại. Cập nhật dòng "Cập nhật gần nhất".
- [ ] **Step 3: server/db/SCHEMA.md** — ở phần `stocktake_code_notes` (0105): ghi chú `status_color` là cột cũ, web không còn ghi/đọc để hiển thị (màu tính từ `status_text` qua `stocktakeStatus.js`), CHECK giữ nguyên; không migration mới. Cập nhật ngày cuối file.
- [ ] **Step 4: SRS** — thêm FR-ST.11 (trạng thái 7 loại: tên, màu, Nhầm SG/HN theo cơ sở, Chưa XL = trống, chữ cũ xếp loại theo từ khóa sớm nhất / "Khác"; danh sách chọn trên bảng, dán/kéo xếp theo loại, bỏ qua chữ không thuộc loại nào; thẻ tổng toàn đợt, bấm lọc / bấm lại bỏ lọc; ô lọc Trạng thái theo loại); FR-ST.9: tìm kiếm theo tên chặt (cụm liền, số trọn, tìm mờ chỉ khi không có mã khớp + dòng báo); ghi bỏ cột Vị trí kho gần nhất và ô dữ liệu xuống dòng. Cập nhật dòng "Cập nhật gần nhất".
- [ ] **Step 5: docs/04-planning/implementation_plan.md + CURRENT.md** — mô tả ngắn phần đã triển khai (module `stocktakeStatus.js`, kiểm tra trạng thái ở service, thẻ tổng, bỏ vị trí kho, tìm kiếm). CURRENT.md: thêm mục đầu ngày 03/11/2026 cho đợt này (trạng thái nhánh / chưa merge / chưa deploy), không xóa mục cũ.
- [ ] **Step 6: Commit**

```bash
git add README.md server/README.md server/db/SCHEMA.md docs/02-srs/SRS_Dashboard_GoogleSheets.md docs/04-planning/implementation_plan.md CURRENT.md
git commit -m "docs(kiem-ke): trang thai 7 loai + the tong, tim kiem chat, bo vi tri kho

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Kiểm tra cuối (controller)

- Toàn bộ test `server/stocktake/*.test.js` + `db/rollbacks/stocktakeRollback.test.js` xanh; `npm test` (nền) không có lỗi mới ngoài danh sách đỏ sẵn trên main; khôi phục `server/public/prototypes/order-picking/index.html` sau `npm test`.
- Server test dữ liệu thật (`stocktake-real-preview`, cổng 3989): không còn cột Vị trí kho; ô dài xuống dòng, tiêu đề vẫn 1 dòng; thẻ đợt T10 HN ra số mã/tổng khớp đếm độc lập bằng JS (`Status.summarize`); bấm thẻ lọc đúng, bấm lại bỏ lọc, ô lọc đồng bộ; ô Trạng thái: gõ "l" → Lẫn, ↑↓ Enter lưu, Esc / bấm ra ngoài không lưu; kéo nhân bản + dán + Ctrl+Z cột Trạng thái; hộp chi tiết có select 7 loại (+ chữ cũ); tìm "băng keo 10kg"; sáng/tối; 375px.
- `graphify update .`.
