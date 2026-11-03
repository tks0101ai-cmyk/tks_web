# Kiểm kê: bỏ Dán cột, tiêu đề cột gọn không xuống dòng, bộ lọc mới

Ngày: 03/11/2026 · Nhánh: `claude/inventory-feature-analysis-1ab808` (PR #28) · Trang: `/stocktake/`

Tiếp nối `2026-11-03-stocktake-inline-edit-search-design.md` (sửa trên bảng như sheet).

## 1. Bỏ "Dán cột" (giao diện + máy chủ)

Dán Ctrl+V trên bảng (`POST /cells`) đã thay hoàn toàn hộp "Dán cột từ sheet".

Bỏ:
- `index.html`: nút `#stPasteButton`, hộp `#stPasteDialog` (form, textarea, preview, lỗi).
- `stocktake.js`: `paste` state, `pasteColumnLabel`, `currentValue` (chỉ hộp dán dùng), `previewPaste`, `bindPaste` và lời gọi trong `init`, dòng `$('stPasteButton').hidden = …` trong `render`.
- `stocktake.css`: luật `#stPasteText`, `.st-paste-preview` và luật chỉ dùng cho hộp dán.
- `stocktakePaste.js`: `parsePasteText` (chỉ hộp dán dùng). Giữ `PASTE_COLUMNS`, `STATUS_COLORS`, `codeKey`, `foldName`, `parseVnNumber`, `parseComboFlag`, `normalizeValue`, `columnValue`, `sameValue`, `rawOf` (bảng, máy chủ, xuất Excel đang dùng).
- `stocktakeRoutes.js`: route `POST /api/stocktake/sessions/:id/paste`.
- `stocktakeService.js`: `pasteColumn` và export của nó. Giữ `insertPasteHistory`, `lockTags`, `upsertNotes`, `upsertTags`, `nextRecord`, `sameRecord`, `MAX_PASTE_ROWS` (dùng bởi `saveCells`).

Giữ nguyên: action lịch sử `'paste'` (lịch sử cũ "Dán cột …" và `source: 'cells'` vẫn hiện như nay), `codeHistory` lọc `'paste'` cho tag ở đợt khác.

Test:
- `stocktakePaste.test.js`: bỏ test `parsePasteText`.
- `stocktakeRoutes.test.js`: bỏ `pasteColumn` khỏi service giả và các assert `/paste`.
- `stocktakeService.test.js`: bỏ 2 test "dan cot …" và phần `pasteColumn` của test "mau trang thai …" và test prototype-key của `pasteColumn`. Các hành vi còn cần giữ được chuyển sang `saveCells`:
  - màu trạng thái giữ nguyên khi đổi chữ Trạng thái (đã có trong test "sua tren bang: expected lech …"),
  - Người kiểm lại: khớp đúng 1 nhân sự cùng cơ sở thì gắn id; 2 nhân sự trùng tên sau bỏ dấu → giữ chữ; nhân sự cơ sở khác không tính,
  - Combo `''` → không combo; Cụm SP dùng chung 2 mã → `clusterCount` = 2,
  - xóa (giá trị trống) số dán tay KK trước sai → `prevDiffManual` = false.

## 2. Tiêu đề và độ rộng cột

Nguyên nhân hiện tại: `shared/table-controls.css` đặt cho mọi bảng điều khiển `white-space:normal; overflow-wrap:anywhere` ở `th`, `td` và nhãn sort → co cột thì chữ vỡ dòng ở ký tự bất kỳ. `.st-table{--locations-min-width:1900px}` ép bảng rộng ≥ 1900px.

Mới — chỉ cho `#stTable` (không đổi bảng khác, không sửa `table-controls`):
- `th`, `td`, `.sort-button`, `.sort-label`: `white-space:nowrap !important; overflow:hidden; overflow-wrap:normal !important; text-overflow:clip`. Cột hẹp hơn chữ thì phần thừa bị cắt ở mép ô → nhìn như cột bên phải đè lên (kiểu Excel). Biểu tượng ▲▼ vẫn dính mép phải tiêu đề.
- Tiêu đề: cỡ chữ 11px, padding dọc 6px, một dòng.
- Bỏ `--locations-min-width:1900px` (đặt `0`) — bảng rộng bằng tổng các cột, vẫn tối thiểu bằng khung (table-controls).
- Độ rộng mặc định mới (px): Mã hàng 96 · Tên hàng 200 · Tổng kiểm 84 · Tồn KIOT 84 · SL chênh 84 · Giá trị chênh 110 · Trạng thái 110 · Chi tiết lý do 170 · Trang in 64 · Giờ in 70 · Người kiểm lại 110 · KK trước sai 84 · Kiểm SG/HN 84 · Cụm SP 110 · Count 64 · Chênh cụm 84 · Do KK trước 72 · Lẫn + KK trước 84 · Do kiểm SG/HN 72 · Quên KK 64 · Combo 64 · Vị trí kho gần nhất 110 · Giá vốn 84 · Cập nhật 120.
- Khóa lưu cấu hình bảng `stocktake-board-v3` → `stocktake-board-v4` để độ rộng mới có hiệu lực (độ rộng / ẩn cột đã chỉnh trước đó trở về mặc định một lần).
- Kéo hẹp tối thiểu 64px (mức của `table-controls`, không đổi).
- Ô nhập khi sửa (`.st-editor`) vẫn rộng tối thiểu 140px như hiện nay, nên cột hẹp vẫn gõ được đủ chữ.

## 3. Bộ lọc

`#stFilter` có đúng 5 lựa chọn (bỏ "Đã ghi chú"):

| value | Nhãn | Điều kiện trên dòng |
|---|---|---|
| `all` | Tất cả mã | mọi dòng |
| `forgotten` | Quên KK | `row.forgotten` |
| `statusOnly` | Chỉ có trạng thái | Trạng thái có chữ và Trang in trống |
| `printOnly` | Chỉ có trang in | Trang in có chữ và Trạng thái trống |
| `neither` | Không có cả hai | Trạng thái trống và Trang in trống |

"Có chữ" = `String(x).trim() !== ''` trên `row.note.statusText` / `row.note.printPage` (không có note = trống). Màu trạng thái và Giờ in không tính.

Hàm thuần `matchesFilter(row, filter)` đặt trong `stocktakeGrid.js` (UMD, đã có test Node), `visibleRows()` gọi hàm này. Giá trị lạ → coi như `all`. Bộ lọc kết hợp với tìm kiếm, lọc Người kiểm lại, lọc Trạng thái như hiện nay; đổi bộ lọc vẫn `rerender` (bỏ thứ tự giữ). Sau khi sửa một ô, dòng không rời khỏi danh sách dù không còn khớp bộ lọc (giữ thứ tự như thiết kế trước) cho tới khi đổi lọc/sort/tìm/đợt.

## 4. Tài liệu

README (cập nhật gần nhất + bỏ nhắc "Dán cột"), server/README (bỏ `/paste` khỏi mô tả API kiểm kê), SRS FR-ST (FR-ST.8 ghi đã thay bằng FR-ST.9; thêm bộ lọc mới), CURRENT.md. Chạy `npm test` + `graphify update .`.

## 5. Kiểm thử

- `stocktakeGrid.test.js`: `matchesFilter` 5 giá trị + giá trị lạ + note null + chữ toàn khoảng trắng.
- Test máy chủ như mục 1; toàn bộ test `stocktake/` đạt.
- Server test dữ liệu thật: không còn nút Dán cột; tiêu đề một dòng; kéo hẹp cột tới khi chữ bị cắt (tiêu đề + ô); từng lựa chọn bộ lọc ra đúng số mã (đối chiếu đếm bằng JS trên dữ liệu bảng); sáng/tối; 375px.
