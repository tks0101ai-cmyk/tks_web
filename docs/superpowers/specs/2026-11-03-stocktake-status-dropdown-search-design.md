# Kiểm kê: trạng thái dạng danh sách + thẻ tổng, ô dữ liệu xuống dòng, bỏ Vị trí kho, tìm kiếm chặt

Ngày: 03/11/2026 · Nhánh: `claude/inventory-feature-analysis-1ab808` · Trang: `/stocktake/`

Tiếp nối `2026-11-03-stocktake-filter-header-trim-design.md` (PR #29 đã merge).

## 1. Bỏ cột "Vị trí kho gần nhất"

- `stocktake.js`: bỏ cột `position` khỏi `COLUMNS`, `cellValue`/`sortValue` của nó. Khóa cấu hình bảng `stocktake-board-v4` → `stocktake-board-v5`.
- `stocktakeExport.js`: bỏ cột "Vị trí kho gần nhất".
- `stocktakeService.js`: bỏ `POSITIONS_SQL`, `POSITION_BRANCH`, `loadPositions`, `cache.delete('positions:…')` và tham số `positions` truyền vào `buildBoard` (cả nhánh đợt mở lẫn đợt đã đóng).
- `stocktakeCompute.js`: bỏ tham số `positions`, `positionByCode` và trường `latestPosition` của dòng.
- Test liên quan sửa theo (không còn `latestPosition`).

## 2. Ô dữ liệu xuống dòng, tiêu đề vẫn bị che

- Tiêu đề (`#stTable thead th`): giữ như hiện nay — 1 dòng, `nowrap`, cắt ở mép ô.
- Ô dữ liệu (`#stTable tbody td`): `white-space:normal !important; overflow-wrap:anywhere !important; text-overflow:clip`. Chữ xuống dòng ở chỗ cách, từ quá dài ngắt giữa từ; hàng cao lên theo ô dài nhất. Không còn chữ bị cắt ở ô dữ liệu.
- Ô vuông nhân bản (`.st-fill`) và ô nhập (`.st-editor`) đã đặt theo `getBoundingClientRect()` nên tự theo chiều cao hàng mới.

## 3. Trạng thái: danh sách cố định, màu tự động

### 3.1 Module dùng chung `server/public/stocktake/stocktakeStatus.js`

UMD (`window.TKSStocktakeStatus` / `module.exports`), giống `stocktakeGrid.js`. Nạp ở `index.html` trước `stocktake.js`; server và xuất Excel `require` trực tiếp.

```js
STATUS_TYPES = [ // thu tu hien thi (the, danh sach, bo loc)
  { key: 'lost',     label: 'Mất',      color: '#F87171' }, // do
  { key: 'previous', label: 'KK trước', color: '#C8963E' }, // vang nau
  { key: 'ok',       label: 'OK',       color: '#EEFF41' }, // vang neon
  { key: 'wrong',    label: 'Nhầm SG',  labelSaigon: 'Nhầm HN', color: '#C4B5FD' }, // tim
  { key: 'surplus',  label: 'Thừa',     color: '#F9A8D4' }, // hong
  { key: 'mixed',    label: 'Lẫn',      color: '#67E8F9' }, // xanh cyan
  { key: 'pending',  label: 'Chưa XL',  color: '#FFFFFF' }  // trang (o trong)
];
OTHER = { key: 'other', label: 'Khác', color: '' }; // chu cu khong xep duoc loai
```

Hàm:
- `labelFor(key, branch)` → tên hiển thị; `wrong` ở `saigon` là "Nhầm HN", còn lại "Nhầm SG".
- `optionsFor(branch)` → 7 lựa chọn `[ {key,label,color} ]` theo cơ sở.
- `classify(text)` → key loại:
  - `String(text ?? '').trim() === ''` → `'pending'`.
  - Gấp chữ: thường, bỏ dấu, `đ`→`d`, ký tự không phải chữ/số → khoảng trắng.
  - Khớp đúng tên loại (gấp chữ) → loại đó; "chua xl" → `pending`; "nham sg" và "nham hn" đều → `wrong`.
  - Không thì tìm từ khóa, nguyên từ (`(^| )từ khóa( |$)`), lấy từ khóa **xuất hiện sớm nhất** trong chữ: `ok`→ok, `mat`→lost, `kk truoc` / `kk`→previous, `nham`→wrong, `thua`→surplus, `lan`→mixed.
  - Không khớp gì → `'other'`.
  - Ví dụ (dữ liệu T10 thật): "lẫn bình giữ nhiệt"→mixed, "Lẫn+kk trước"→mixed, "KK trước + lẫn"→previous, "đã kiểm lại thừa"→surplus, "mất ko thấy"→lost, "Nhầm SG + KK"→wrong, "ok"→ok, "Lẻ"→other, ""→pending.
- `canonical(text, branch)` → chữ để lưu khi người dùng nhập/dán: loại `pending` → `''`; loại thường → `labelFor(key, branch)`; `other` → `null` (không nhận).
- `colorOf(text)` → màu theo `classify` (`pending`/`other` → `''`, không tô).
- `summarize(rows)` → `Map key → { count, diffValue }` trên mọi dòng: loại của `row.note?.statusText`; `diffValue` cộng có dấu `Number(row.diffValue) || 0`. Luôn có đủ 7 loại (count 0 vẫn có); `other` chỉ có khi count > 0.

### 3.2 Hiển thị ô

- Ô Trạng thái hiện **chữ đang lưu** (chữ cũ T10 giữ nguyên, ví dụ "lẫn bình giữ nhiệt"), tô nền theo `colorOf(statusText)`, chữ màu tối `#111` trên mọi nền có màu (cả giao diện tối). `pending`/`other` không tô.
- `td.dataset.color` cũ (theo `statusColor`) bỏ; dùng `td.dataset.status = key` + CSS cho từng key.
- Cột `status_color` trong DB không còn dùng để hiển thị; server ghi `status_color = key` (hoặc `''` cho pending/other) cho nhất quán, không cần migration.
- `STATUS_COLORS` trong `stocktakePaste.js` và phần chọn màu (`#stStatusColors`, `statusColor` trong form, nhãn "màu …" trong lịch sử) bỏ. Lịch sử cũ có `statusColor` chỉ không hiện nhãn màu nữa.

### 3.3 Sửa trên bảng

- Ô Trạng thái chọn sẵn + gõ phím in được / Enter / F2 → mở **danh sách chọn** (`.st-status-menu`) ngay dưới ô, 7 dòng theo `optionsFor(branch)`, mỗi dòng có chấm màu. Dòng đang chọn sẵn = loại hiện tại.
  - ↑/↓ đổi dòng, Enter hoặc bấm chuột → lưu, Esc → đóng không lưu, bấm ra ngoài → đóng không lưu.
  - Gõ chữ khi danh sách mở: nhảy tới lựa chọn đầu tiên có tên (gấp chữ) bắt đầu bằng chuỗi đã gõ (gõ liền trong 800 ms nối thành chuỗi). Phím mở danh sách cũng tính là ký tự đầu.
  - Lưu qua `POST /cells` như các cột khác: `value = canonical label` (`Chưa XL` → `''`), có `expected`, undo, optimistic như hiện nay.
- Delete trên ô Trạng thái → `''` (Chưa XL), như hiện nay.
- Nhân bản (kéo ô vuông) cột Trạng thái: chép chữ ô nguồn qua `canonical`; ô nguồn là chữ cũ → chép loại của nó (vd "lẫn bình giữ nhiệt" → "Lẫn"); ô nguồn `other` → không chép (báo "Bỏ qua N ô trạng thái không thuộc danh sách").
- Dán Ctrl+V vào cột Trạng thái: mỗi ô qua `canonical(text, branch)`; `null` → bỏ qua ô đó, cuối cùng báo "Bỏ qua N ô trạng thái không thuộc danh sách". Các ô khác vẫn lưu.
- Hộp chi tiết (nhấp đúp): ô Trạng thái thành `<select>` 7 lựa chọn. Nếu chữ đang lưu không phải tên chuẩn (chữ cũ), thêm 1 lựa chọn đầu "‹chữ cũ›" được chọn sẵn để lưu lại không đổi. Bỏ datalist `stStatusSuggestions`.

### 3.4 Máy chủ

- `saveCells` (cột `status`) và lưu ghi chú (`PUT /api/stocktake/sessions/:id/codes/:code/note`): `statusText` mới phải là `''` hoặc `labelFor(key, session.branch)` của 1 trong 6 loại có chữ. Bằng đúng chữ đang lưu (chưa đổi) cũng nhận. Còn lại → 400 `VALIDATION` "Trạng thái phải là một trong: Mất, KK trước, OK, Nhầm SG, Thừa, Lẫn, Chưa XL." (`field: 'statusText'`) ở API ghi chú; ở `saveCells` ô sai được đếm vào `skipped.invalid` như giá trị sai hiện nay, các ô khác vẫn lưu.
- `statusColor` gửi lên bị bỏ qua; server tự đặt `status_color` theo `classify`.
- `suggestions.status` thôi tính/gửi (giữ `suggestions.reason`).
- Nạp sheet (`stocktakeSheetImport.js`) không đổi: vẫn lưu chữ gốc.
- Xuất Excel: tô nền ô Trạng thái theo `colorOf(statusText)` (ARGB từ `color`), thay cho `STATUS_COLORS[statusColor]`.

## 4. Thẻ tổng theo trạng thái

- Hàng thẻ `#stStatusCards` nằm trên bảng (dưới thanh công cụ), cuộn ngang trên màn hình hẹp.
- Thứ tự theo `STATUS_TYPES`, thêm thẻ "Khác" cuối nếu có. Mỗi thẻ: dải màu trái theo loại (Chưa XL viền xám), tên loại (theo cơ sở), số mã, tổng giá trị chênh có dấu định dạng tiền VN như cột Giá trị chênh (âm màu đỏ như cột).
- Số tính bằng `summarize(state.board.rows)` — **toàn đợt**, không theo tìm kiếm/bộ lọc khác. Tính lại mỗi lần `render`/sau khi lưu ô (`applyLocally`) và khi tải lại bảng.
- Bấm thẻ → `state.status = key`, `rerender()`; bấm lại thẻ đang chọn → `state.status = ''`. Thẻ đang chọn có viền đậm + `aria-pressed="true"`. Thẻ là `<button>`.
- Ô lọc `#stStatusFilter` đổi nội dung: "Mọi trạng thái" + 7 loại (theo cơ sở) + "Khác"; giá trị = key. Đồng bộ hai chiều với thẻ.
- Lọc dòng: `state.status` khác rỗng → giữ dòng có `classify(row.note?.statusText) === state.status`.

## 5. Tìm kiếm chặt hơn (`stocktakeSearch.js`)

Giữ cách chuẩn hóa `normalizeText` / `normalizeCode` và thứ tự ưu tiên; đổi cách khớp tên:

- Mã (mức 1, 3, 5): như cũ.
- Tên đúng (2): như cũ.
- Tên bắt đầu (4) và tên chứa cả cụm (6): cụm truy vấn phải bắt đầu ở đầu một từ; nếu từ cuối truy vấn là số thì sau nó không được là chữ số (khớp trọn số).
- Đủ mọi từ (7): tách truy vấn gốc theo khoảng trắng; mỗi phần sau `normalizeText` là một **cụm** (vd "10kg" → "10 kg") phải xuất hiện liền nhau trong `text` (tên + extra), bắt đầu ở đầu một từ; phần tử cuối của cụm nếu là số thì phải khớp trọn số, nếu là chữ thì được là tiền tố của từ ("ke" khớp "keo").
- Tìm mờ Fuse chỉ chạy khi mức 1–7 **không ra kết quả nào**; khi đó trả tối đa `FUZZY_LIMIT` (100) và `search` báo cờ `fuzzy: true` để trang hiện dòng "Không có mã khớp đúng, đang hiện mã gần giống". Đổi API: `search(index, query)` trả `{ rows, fuzzy }`; `stocktake.js` sửa nơi gọi.
- Kết quả trên tên hàng thật (HN): "băng keo 10kg" → đúng 6 mã, đều là băng keo 10KG (BKCT20CM10, BKCT10CM10, 1115SD, 10GG8A, 9T84YG, T36T24); không còn 11KG/14KG/19KG/15.5KG, không còn kết quả mờ.

## 6. Tài liệu

README (cập nhật gần nhất), server/README (bỏ vị trí kho khỏi mô tả bảng kiểm kê, ghi luật trạng thái của `POST /cells` / ghi chú), SRS FR-ST (FR-ST.11: trạng thái danh sách + thẻ; FR-ST.9 ghi tìm kiếm chặt), `docs/04-planning/implementation_plan.md`, CURRENT.md. Không migration, SCHEMA.md không đổi. Chạy `npm test` + `graphify update .`.

## 7. Kiểm thử

- `stocktakeStatus.test.js` (mới): `classify` với các ví dụ ở 3.1 + chữ hoa/không dấu; `canonical` theo cơ sở (Nhầm SG/HN, Chưa XL → '', other → null); `colorOf`; `summarize` (đủ 7 loại, Khác chỉ khi có, cộng có dấu, dòng không có note → Chưa XL).
- `stocktakeSearch.test.js`: "băng keo 10kg" không khớp "(11KG)", "(19KG)", "10cm … 15.5KG"; khớp "(10KG)" và "(10kg/thùng)"; "10" không khớp "100"; "ke" khớp "keo"; có kết quả chắc chắn thì không có mờ (`fuzzy:false`); không có thì có mờ (`fuzzy:true`).
- `stocktakeService.test.js`: `saveCells` nhận "Lẫn", "Nhầm HN" ở đợt SG, `''`; từ chối "lẫn bình" (vào `skipped.invalid`) và "Nhầm HN" ở đợt HN; giữ chữ cũ không đổi vẫn lưu được; `status_color` tự đặt; board không còn `latestPosition`; `suggestions` không còn `status`.
- `stocktakeCompute.test.js`, `stocktakeRoutes.test.js`, test xuất Excel: sửa theo bỏ vị trí kho, màu theo loại.
- Server test dữ liệu thật: không còn cột Vị trí kho; ô dài xuống dòng, tiêu đề vẫn 1 dòng; thẻ ở đợt T10 ra số mã/tổng khớp đếm độc lập bằng JS; bấm thẻ lọc đúng, bấm lại bỏ lọc; danh sách chọn trạng thái bằng phím và chuột; nhân bản + dán + undo cột trạng thái; tìm "băng keo 10kg"; sáng/tối; 375px.
