# Kiểm kê: tự cuộn khi kéo chọn, màu cột sửa được, nhấn đúp sửa ô

Ngày: 07/11/2026. Phạm vi: `server/public/stocktake/stocktake.js` và `stocktake.css`. Không đụng máy chủ, API hay migration.

## Vấn đề

1. Kéo chuột chọn nhiều ô xuống mép dưới khung bảng (`.st-scroll`) thì bảng không tự cuộn; người dùng phải lăn chuột. Chỉ nút điền (fill handle) có cuộn tự động (`stocktake.js` quanh dòng 1109–1120).
2. Tiêu đề cột sửa được trông giống cột chỉ đọc (cùng nền xanh ngọc `#0e7490`).
3. Nhấn đúp ở bất kỳ ô nào đều mở hộp chi tiết sản phẩm (`bindDetail`, sự kiện `dblclick` trên `tr`), nên không thể nhấn đúp để sửa ô. Ô nhập hiện là `<input>` một dòng nên chữ dài (Chi tiết lý do) bị cắt.
4. Chưa có menu chuột phải để mở chi tiết.

## Thiết kế

### 1. Tự cuộn khi kéo chọn
- Khi `selection.dragging` và con trỏ cách mép trên/dưới/trái/phải của `.st-scroll` dưới một ngưỡng (khoảng 40px), một vòng `requestAnimationFrame` cuộn khung. Tốc độ tăng theo khoảng cách con trỏ vượt vào vùng ngưỡng hoặc ra ngoài khung, có trần.
- Mỗi nhịp cuộn cập nhật `selection.focus` theo ô nằm dưới tọa độ con trỏ lúc đó (`document.elementFromPoint`), vì `mouseover` không bắn khi con trỏ đứng yên mà nội dung trôi. Cuộn xuống hết phần đã vẽ thì gọi `drawMore(CHUNK)` để vẽ thêm hàng.
- Dừng vòng lặp khi `mouseup`. Hàm cuộn dùng chung với nút điền để không có hai bản mã cuộn tự động.

### 2. Màu tiêu đề cột sửa được
- Cột sửa được = khóa có trong `Grid.EDIT_COLUMNS` (Trạng thái, Chi tiết lý do, Trang in, Giờ in, Người kiểm lại, KK trước sai, Kiểm SG/HN, Cụm SP, Combo). Khi dựng tiêu đề, `th` của các cột đó nhận class `st-th-edit`, kèm biểu tượng bút nhỏ trước nhãn.
- CSS: nền hổ phách (khoảng `#b45309`, đang sắp xếp `#92400e`), chữ trắng, đạt tương phản cho cả Sáng và Tối. Cột chỉ đọc giữ `#0e7490`.
- Chỉ tô khi `editable()` đúng; đợt đã đóng/hủy hoặc tài khoản chỉ xem thì tiêu đề về màu thường.

### 3. Nhấn đúp, menu chuột phải, ô nhập
- Thay hành vi `dblclick`:
  - Ô Mã hàng (cột `code`): mở chi tiết sản phẩm (`openDetail`).
  - Ô sửa được: chọn ô đó rồi gọi `openEditor()` (giống F2): con trỏ ở cuối chữ; cột Trạng thái mở danh sách chọn. Đợt không sửa được thì dùng thông báo có sẵn của `canWrite()`.
  - Ô chỉ đọc khác: không làm gì.
- Menu chuột phải: sự kiện `contextmenu` trên `tr[data-code]` chặn menu trình duyệt, chọn ô vừa bấm, hiện menu nhỏ một mục "Chi tiết sản phẩm" tại vị trí chuột. Đóng khi nhấn ra ngoài, Esc, cuộn hoặc đổi dữ liệu. Có `role="menu"`, hỗ trợ bàn phím (Enter mở, Esc đóng).
- Ô nhập cột chữ (`type: 'text'` trong `EDIT_COLUMNS`) đổi từ `<input>` sang `<textarea>`: rộng ít nhất bằng ô (và tối thiểu 140px như nay), tự giãn chiều cao theo nội dung, tối đa vừa khung bảng. Giữ phím: Enter lưu và xuống ô dưới, Tab sang ô kế, Esc hủy. Không cho xuống dòng thật: chữ chỉ tự ngắt dòng khi hiển thị, giá trị lưu vẫn một dòng như trước (dán chữ có xuống dòng thì đổi thành khoảng trắng).
- Cột số và giờ giữ ô nhập một dòng.

## Xử lý lỗi và ràng buộc
- Hai lần `mousedown` đầu của cú nhấn đúp vẫn chọn ô như hiện nay; `dblclick` chỉ thêm hành động, không đổi vùng chọn.
- Mở ô nhập khi đã có ô nhập khác: `openEditor` đã chặn (`editor.input`).
- Giữ nguyên sort nhiều cột, sao chép/dán, hoàn tác, lọc.
- Giao diện Sáng/Tối và 375px: menu chuột phải nằm trong khung nhìn (đảo vị trí nếu sát mép).

## Kiểm thử
- Test hồi quy giao diện (trong nhóm `server/stocktake` hoặc `server/test/frontend`, theo khuôn test grid hiện có): (a) kéo chọn sát mép dưới làm `scrollTop` tăng và `selection.focus` đi theo; (b) tiêu đề cột trong `EDIT_COLUMNS` có class `st-th-edit`, cột khác không, và không có khi đợt chỉ xem; (c) `dblclick` ô Mã hàng mở chi tiết, ô sửa được mở ô nhập, ô chỉ đọc không làm gì; (d) `contextmenu` hiện mục "Chi tiết sản phẩm" và mở đúng mã; (e) ô nhập cột chữ là `textarea` giãn theo nội dung.
- Chạy lại nhóm test kiểm kê, table-controls, sort-icons. Hai test lỗi nền đã biết (mục 4.1 `CLAUDE.md`) không tính.
- Xem thử trên trình duyệt: Sáng/Tối, 375px, kéo chọn hàng trăm dòng, sửa Chi tiết lý do dài.

## Ngoài phạm vi
Cách sort, chọn nhiều cột, nội dung hộp chi tiết, ghi chú máy chủ.
