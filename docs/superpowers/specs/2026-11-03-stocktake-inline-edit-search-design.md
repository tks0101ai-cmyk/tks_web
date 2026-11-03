# Kiểm kê: sửa trong ô như sheet + tìm kiếm kiểu tra-cuu-vi-tri

Ngày: 03/11/2026 · Nhánh: `claude/inventory-feature-analysis-1ab808` (PR #27) · Trang: `/stocktake/`

## Mục tiêu

1. Các ô nhập tay sửa trực tiếp trên bảng như Google Sheets (gõ, dán, xóa), không phải mở hộp chi tiết.
2. Kéo nút vuông ở góc vùng chọn để nhân bản giá trị xuống / lên các dòng khác như Excel.
3. Ctrl+Z hoàn tác các lần sửa của chính mình.
4. Tìm kiếm bớt khắt khe, giống tool `D:\tra-cuu\tra-cuu-vi-tri` (Index.html: `normalizeText`, `normalizeCode`, `searchProducts`).
   Ca kiểm: "băng keo 10kg" phải ra "Băng keo chống thấm 20cm (T9) (10KG)".

Ngoài phạm vi: Ctrl+Y (làm lại), đổi màu trạng thái bằng gõ/dán (vẫn ở hộp chi tiết), sửa dòng đếm trên bảng (vẫn ở hộp chi tiết).

## 1. Cột sửa được

Đúng 9 cột "Dán cột" đang hỗ trợ (`PASTE_COLUMNS` trong `stocktakePaste.js`). Ánh xạ khóa bảng → khóa cột dán:

| Cột bảng (`COLUMNS.key`) | Cột dán | Kiểu |
|---|---|---|
| `status` | `statusText` | chữ ≤ 200 |
| `reason` | `reasonText` | chữ ≤ 1000 |
| `printPage` | `printPage` | chữ ≤ 50 |
| `printTime` | `printTime` | chữ ≤ 50 |
| `recheck` | `recheck` | chữ ≤ 200 (khớp đúng 1 nhân sự cùng cơ sở → gán id) |
| `prevDiff` | `prevDiffManual` | số (trống = bỏ số dán tay, số tự động hiện lại) |
| `otherDiff` | `otherDiffManual` | số (như trên) |
| `cluster` | `cluster` | chữ ≤ 200 (tag theo cơ sở) |
| `combo` | `combo` | x / true / 1 / có = có; trống = không |

Ô khác (Mã, Tên, Tồn, Chênh, tỷ lệ, Quên KK, Vị trí, Giá vốn, Cập nhật) chỉ chọn và copy. Giá trị trong ô nhập và giá trị gửi lên dùng đúng `normalizeValue` / `parseVnNumber` của `stocktakePaste.js`, nên gõ, dán ô và "Dán cột" hiểu số giống nhau.

Không sửa được khi: đợt đã đóng, hoặc `canEdit` sai. Lúc đó gõ / dán / Delete / kéo chỉ hiện thông báo "Đợt đã đóng" hoặc "Bạn không có quyền sửa"; chọn và Ctrl+C vẫn dùng được.

## 2. Bàn phím và chuột

Trạng thái mới trong `stocktake.js`: `editor = { input, row, col }` (ô nhập đang mở, hoặc rỗng).

Khi **không** mở ô nhập và không có hộp thoại mở:

| Thao tác | Kết quả |
|---|---|
| Nhấp | Chọn 1 ô (như hiện nay). Kéo chuột = chọn vùng. Shift+nhấp = mở rộng. |
| Nhấp đúp (mọi ô) | Mở hộp chi tiết mã (như hiện nay). |
| Phím chữ / số / dấu (1 ký tự, không Ctrl/Alt/Meta) | Mở ô nhập trên ô đang chọn (ô `focus`), nội dung = ký tự vừa gõ. |
| Enter, F2 | Mở ô nhập với giá trị hiện tại, con trỏ cuối chữ. (Enter không còn mở hộp chi tiết.) |
| Mũi tên | Dời ô chọn 1 ô; Shift+mũi tên = mở rộng vùng. Dời tới dòng chưa vẽ thì vẽ thêm (`drawMore`) và cuộn cho thấy ô. |
| Delete, Backspace | Xóa mọi ô sửa được trong vùng chọn (gửi giá trị trống). |
| Ctrl+V | Dán (mục 3). |
| Ctrl+C | Copy (như hiện nay). |
| Ctrl+Z | Hoàn tác (mục 5). |
| Esc | Bỏ vùng chọn (như hiện nay). |

Khi **đang** mở ô nhập: Enter = lưu và chọn ô dưới; Tab / Shift+Tab = lưu và chọn ô phải / trái; Esc = hủy; nhấp ra ngoài = lưu. Ctrl+V, Ctrl+Z, mũi tên là hành vi mặc định của ô nhập chữ.

Ô nhập là một `<input>` đặt tuyệt đối đè đúng ô (theo `getBoundingClientRect` của `td` trong `.st-scroll`), cùng font; cột Chi tiết lý do dùng cùng `<input>` (không xuống dòng — Sheets cũng vậy khi dán). Giá trị không đổi thì đóng, không gửi.

Hàng (`tr`) không còn `tabIndex` riêng cho từng hàng; bảng (`.st-scroll`) giữ focus để nhận phím.

## 3. Dán Ctrl+V

Bắt sự kiện `paste` trên document (không cần quyền clipboard), bỏ qua khi focus đang ở input / textarea / select hoặc có hộp thoại mở.

1. Đọc `text/plain`, tách dòng `\r?\n` (bỏ 1 dòng trống cuối), tách ô bằng `\t`. Ô Google Sheets có xuống dòng bên trong được bọc `"…"`: gộp lại và đổi xuống dòng thành dấu cách.
2. Nếu dữ liệu là đúng 1 ô và vùng chọn nhiều ô → điền giá trị đó cho mọi ô sửa được trong vùng.
3. Ngược lại → đặt khối bắt đầu từ ô trên-trái vùng chọn; dòng thứ i của khối vào `view.rows[top + i]`, ô thứ j vào cột hiển thị thứ j kể từ cột trái (bỏ qua cột đang ẩn bằng "Cột hiển thị", như copy). Dòng vượt cuối danh sách bị bỏ.
4. Ô rơi vào cột không sửa được, hoặc giá trị không hợp lệ với cột (`normalizeValue().ok === false`), bị bỏ qua.
5. Sau khi dán, vùng chọn = vùng vừa dán. Thanh thông báo: "Đã dán N ô · M ô bỏ qua (cột không sửa được / giá trị sai) · K ô người khác vừa sửa".

## 4. Kéo nút góc (fill handle)

- Ô vuông 7×7 px ở góc dưới-phải của vùng chọn (phần tử `.st-fill` đặt tuyệt đối trong `.st-scroll`, vẽ lại cùng `paintSelection`). Ẩn khi không sửa được hoặc vùng chọn không có cột sửa được.
- Kéo chuột xuống hoặc lên: viền nét đứt hiện vùng sẽ điền (giữ nguyên cột của vùng chọn). Kéo sát mép trên/dưới `.st-scroll` thì tự cuộn; dòng chưa vẽ được vẽ thêm.
- Thả: mỗi dòng mới nhận giá trị của dòng nguồn theo vòng lặp (`source[(i) % sourceRows]`, đếm từ mép vùng chọn ra ngoài). Chọn 1 ô = sao chép đúng giá trị đó. Không tăng số tự động.
- Chỉ ghi các cột sửa được trong vùng; vùng chọn mới = vùng nguồn + vùng điền.

## 5. Ctrl+Z

- `undoStack` (tối đa 50 bước, chỉ trong bộ nhớ trang; đổi đợt hoặc tải lại trang thì mất). Mỗi lần gửi `/cells` thành công là 1 bước: danh sách `{ code, column, before, after }` của các ô **thực sự đã ghi** (máy chủ trả về).
- Ctrl+Z: lấy bước trên cùng, gửi `/cells` với `value = before`, `expected = after`. Ô nào máy chủ báo xung đột (người khác đã sửa sau mình) thì không đổi và thông báo "K ô không hoàn tác được vì người khác đã sửa". Bước hoàn tác không đẩy vào stack.

## 6. API `POST /api/stocktake/sessions/:id/cells`

Quyền như "Dán cột" (`openSessionForWrite`: đợt đang mở, `canEdit`, đúng phạm vi cơ sở). JSON body ≤ 2 MB (giới hạn hiện có).

```json
{ "cells": [ { "code": "BK20", "column": "statusText", "value": "Đã kiểm", "expected": "" } ] }
```

- `column`: khóa trong `PASTE_COLUMNS`. `value`: chuỗi thô (như dán) — máy chủ chuẩn hóa bằng `normalizeValue`. `expected`: giá trị hiện tại trình duyệt đang thấy, cùng dạng `currentValue()` (chữ, số hoặc `null`, boolean cho combo, tên hiển thị cho recheck). Thiếu `expected` = không kiểm.
- 1 ≤ số ô ≤ 10.000 (`MAX_PASTE_ROWS`), ngoài khoảng → 400.
- Xử lý trong 1 giao dịch:
  1. Gộp theo mã. Cùng (mã, cột) xuất hiện 2 lần → lấy lần cuối.
  2. Mã không có trong đợt / KiotViet → `skipped.notFound`. Giá trị sai → `skipped.invalid`.
  3. So `expected` với giá trị hiện tại của cột (chữ: so sau `clean`; recheck: so `foldName`; số: bằng nhau hoặc cùng `null`; combo: boolean). Khác → `conflicts` (không ghi ô đó).
  4. Áp lần lượt các ô của một mã lên bản ghi ghi chú (`nextRecord`) và bản ghi tag riêng; bỏ nếu `sameRecord`.
  5. Ghi bằng `upsertNotes` / `upsertTags` sẵn có. Lịch sử: 1 dòng cho mỗi (mã, cột) có đổi, dùng lại action `'paste'` có sẵn trong CHECK của `stocktake_history` — `before` = bản ghi cũ, `after` = `{ column, source: 'cells', ...bản ghi mới }`. Nhờ vậy **không cần migration mới** (0105 đã chạy trên Supabase 03/11) và `codeHistory` hiện có (lọc `after->>'column' IN ('cluster','combo')` cho tag ở đợt khác) chạy đúng luôn. Hộp chi tiết hiện dòng lịch sử `source: 'cells'` là "Sửa trên bảng" thay cho "Dán cột".
- Trả về: `{ applied: [{ code, column, before, after }], conflicts: [{ code, column, current }], skipped: { notFound, invalid, unchanged } }` với `before`/`after` cùng dạng `currentValue()` để trình duyệt đẩy vào undo stack.
- Phát tín hiệu SSE `stocktake-changed` như các thao tác ghi khác.

## 7. Giữ thứ tự dòng khi sửa

Hiện mỗi lần tải lại bảng (sau khi lưu hoặc do SSE) `render()` lọc + sort lại từ đầu, nên dòng vừa sửa có thể nhảy chỗ (vd. đang sort theo Trạng thái) hoặc biến mất (lọc "Đã ghi chú").

Mới: `view.order` = danh sách mã theo thứ tự đang hiện. `render({ keepOrder: true })` (dùng cho tải nền sau lưu / SSE) giữ nguyên thứ tự và tập dòng: dòng có trong `view.order` giữ chỗ cũ với dữ liệu mới; mã mới xuất hiện thêm vào cuối; mã không còn trong đợt bị bỏ. Lọc / sort / tìm kiếm chỉ chạy lại khi người dùng đổi sort, bộ lọc, ô tìm kiếm hoặc đợt (`resetView` như hiện nay).

## 8. Tìm kiếm

Module chung mới `server/public/stocktake/stocktakeSearch.js` (UMD như `stocktakePaste.js`, `window.TKSStocktakeSearch`), chuyển từ tool:

- `normalizeText`: chữ thường, bỏ dấu, `đ→d`, chèn cách giữa chữ và số (`10kg → 10 kg`, `t9 → t 9`), ký tự khác chữ/số → cách, gộp cách.
- `normalizeCode`: bỏ dấu, chỉ giữ `a-z0-9`.
- `prepare(rows)`: gắn sẵn `_searchCode` (mã), `_searchName` (tên), `_searchExtra` (Cụm SP + Trạng thái + Chi tiết lý do), `_searchText` = tên + phụ. Chạy lại khi bảng tải xong (không chuẩn hóa lại mỗi lần gõ).
- `search(rows, query)` trả danh sách dòng đã xếp hạng:
  1. mã khớp đúng · 2. tên khớp đúng · 3. mã bắt đầu bằng · 4. tên bắt đầu bằng · 5. mã chứa · 6. tên chứa nguyên cụm · 7. mọi từ khóa đều có trong `_searchText` (không cần thứ tự). Cùng mức: như tool (độ dài / vị trí xuất hiện, rồi thứ tự gốc).
  8. Khớp mờ Fuse.js (`threshold 0.36, distance 100, ignoreLocation, minMatchCharLength 2`, trọng số mã 0.25 / tên 0.60 / phụ 0.15), tìm cả `queryText` và `queryCode`, chỉ thêm khi mức 1–7 có ít hơn 100 dòng và chỉ thêm tới khi tổng đủ 100.
  - Khác tool: mức 1–7 **không** bị cắt 100 (bảng cần hiện mọi mã khớp chắc chắn).
- Bộ lọc khác (Quên KK / Đã ghi chú / Người kiểm lại / Trạng thái) áp trước, rồi mới tìm.
- Có từ khóa và chưa bấm sort cột → thứ tự theo mức khớp. Đã bấm sort cột → sort theo cột (như hiện nay).
- Fuse.js 7.x (Apache-2.0) lưu sẵn ở `server/public/vendor/fuse.min.js`, nạp trong `index.html` trước `stocktakeSearch.js`. Thiếu Fuse (tải lỗi) → chỉ chạy mức 1–7.
- Ô tìm kiếm debounce 150 ms (4.000 mã × Fuse).

## 9. Đơn vị và tệp

| Tệp | Thay đổi |
|---|---|
| `server/public/stocktake/stocktakeSearch.js` | Mới: chuẩn hóa + xếp hạng (dùng được ở Node để test). |
| `server/public/vendor/fuse.min.js` | Mới: Fuse.js 7.x. |
| `server/public/stocktake/stocktakeGrid.js` | Mới: phần thuần (không DOM) — tách khối dán TSV, ánh xạ khối → danh sách ô, tính ô điền khi kéo, map cột bảng ↔ cột dán. Test được ở Node. |
| `server/public/stocktake/stocktake.js` | Ô nhập trên bảng, phím, paste, fill handle, undo stack, `keepOrder`, gọi `stocktakeSearch`. Bỏ Enter mở chi tiết. |
| `server/public/stocktake/stocktake.css` | `.st-editor`, `.st-fill`, viền vùng điền, con trỏ ô sửa được. |
| `server/public/stocktake/index.html` | Nạp 3 script mới, tăng `?v=`. |
| `server/stocktake/stocktakeService.js` | `saveCells()` dùng lại `nextRecord` / `sameRecord` / `upsertNotes` / `upsertTags`; lịch sử action `'paste'` + `source: 'cells'`. |
| `server/stocktake/stocktakeRoutes.js` | `POST /sessions/:id/cells`. |
| Tài liệu | README, server/README (API), SRS FR-ST, CURRENT. Không đổi schema → SCHEMA.md không đổi. |

## 10. Lỗi

- `/cells` lỗi mạng / 4xx / 5xx: ô trên bảng giữ giá trị cũ, thanh thông báo hiện lỗi từ máy chủ; không đẩy undo.
- Đang mở ô nhập mà SSE tải lại bảng: không đóng ô nhập; khi lưu, `expected` là giá trị lúc mở ô → nếu người khác vừa sửa, ô báo xung đột, bảng hiện giá trị của người kia.
- Đổi đợt khi đang mở ô nhập: hủy ô nhập, xóa undo stack.

## 11. Kiểm thử

- `stocktakeSearch.test.js`: chuẩn hóa ("10KG" → "10 kg", "(T9)" → "t 9"); "băng keo 10kg" ra "Băng keo chống thấm 20cm (T9) (10KG)"; thứ tự mức 1–7; mức 1–7 không bị cắt 100; Fuse chỉ bù tới 100; thiếu Fuse vẫn chạy.
- `stocktakeGrid.test.js`: tách TSV có ô bọc ngoặc kép; 1 ô → điền cả vùng; khối vượt cuối; bỏ cột ẩn / cột không sửa được; kéo lên / xuống lặp mẫu.
- `stocktakeService.test.js` (PGlite): `/cells` ghi nhiều cột cùng mã (note + tag) trong 1 giao dịch; `expected` khác → conflict, không ghi; mã lạ / giá trị sai → skipped; đợt đóng / không quyền → lỗi giống dán cột; lịch sử `'paste'` có `source: 'cells'`, 1 dòng mỗi (mã, cột); recheck khớp nhân sự; trả `applied` đúng dạng để hoàn tác.
- Thử tay trên server test dữ liệu thật (`stocktake-real-preview`): gõ, Enter/Tab, Delete, dán khối từ Google Sheets, kéo nhân bản 50 dòng, Ctrl+Z, tìm "băng keo 10kg".
