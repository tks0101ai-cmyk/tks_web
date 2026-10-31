# Page Design Notes — `vt-positions/index.html` (VT Hà Nội / VT Sài Gòn)

> Kế thừa toàn bộ `MASTER.md`. Thay thế ghi chú trang `stock-locations` (module Vị trí hàng cũ đọc Google Sheets, đã gỡ 2026-10-30). Cập nhật 2026-10-30.

## Vai trò trang
Tra cứu và quản lý vị trí hàng Hà Nội / Sài Gòn lưu trong Postgres (`stock_positions`). Đường dẫn `/vt-positions/#hn` hoặc `#sg`; quyền `stockLocationsV2.view` (xem) và `.export` (xuất Excel) mặc định mọi vai trò kể cả Khách; `.edit` và `.historyDelete` chỉ Quản lý. Link cũ `/stock-locations*` chuyển 302 sang trang này. Mô tả nghiệp vụ: `server/README.md` (mục "Vị trí hàng mới") và SRS FR-13.

## Cấu trúc & component
- Hai tab theo cơ sở (chọn Hà Nội/Sài Gòn chỉ hiện tab tương ứng; "Cả hai" hiện cả hai, mặc định HN). Tab con cũng là hai mục trên sidebar (nhóm "Vị trí hàng" trong `shared-nav.js`).
- Bảng tối đa 10 cột: Mã hàng, Tên hàng, SL kho, Có thể bốc, SL Kiot, Ghi chú số thùng, Ngày về, Vị trí, Cập nhật, Người sửa cuối. Sắp xếp ba trạng thái theo quy ước tiêu đề sort chung (`shared.css`), tìm mã/tên/vị trí không dấu, bộ lọc dropdown Cảnh báo / Hợp lệ / Tất cả (kèm loại cảnh báo), chọn 50/100/200 dòng mỗi trang với nút `<<`, `<`, `>`, `>>`. Dòng có cảnh báo đổi chữ sang đỏ (không tô nền); dòng đã đánh dấu Đã sửa hiện nhãn xanh; vị trí dạng pill.
- Thanh công cụ nút icon: Import, Xuất Excel, Thêm dòng (chỉ hiện khi có quyền), Lịch sử, Cột hiển thị (nhớ riêng điện thoại ≤ 600px và máy tính qua `table-controls.js`; Tên hàng luôn hiện).
- Bấm một dòng mở hộp chi tiết dùng khung chung `.dp-*` (`detail-panel.css`): đầu hộp icon + chip cơ sở + chip Vị trí, 4 chỉ số, khối "Thông tin vị trí", lịch sử riêng của dòng, chân hộp Xóa dòng / Hủy / Lưu thay đổi (người chỉ có quyền xem không thấy Lưu/Xóa). Hộp Lịch sử cập nhật chung có Xuất Excel; hộp Import có thanh 3 bước, khung kéo thả và bảng xem trước chỉnh sửa được.
- Tệp riêng của trang: `vt-base.css` (CSS khung bảng/tab/thanh tìm, chuyển từ `stock-locations.css`), `vt-positions.css`, `vt-detail.css`, `vt-history.css`, `vt-positions.js`; còn lại dùng token và component chung của `shared.css`.

## Lưu ý thiết kế
- Mỗi tab giữ từ khóa, thứ tự, bộ lọc và trang riêng; đổi từ khóa/thứ tự về trang 1.
- Bảng tự vá số liệu khi có sự kiện SSE `positions-changed` (không tải lại cả bảng).
- Khách thấy toàn bộ cột (kể cả SL Kiot, ghi chú, lịch sử kèm tên người sửa) nhưng không có nút sửa / import / xóa lịch sử.
