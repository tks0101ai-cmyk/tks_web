# Nhập liệu trực tiếp bảng VT + điều hướng mũi tên dùng chung — kế hoạch phần còn lại

Code đã viết (chưa commit): `server/public/vt-positions/vt-positions.js` (startEdit/finishEdit/inlineKeydown/neighborCell, bindTable), `vt-positions.css` (`input.vt-inline` trông như chữ thường), `server/public/shared/table-controls.js` (`onGridKeydown`: mũi tên trong input/textarea của bảng), và tăng `?v=` của table-controls.js (10 trang) + vt-positions.js/css.

## Global Constraints
- Node CommonJS, frontend HTML/JS/CSS thuần, KHÔNG thêm framework. Test dùng `node --test` (cần glob `test/frontend/*.test.js`), chạy từ thư mục `server/`.
- KHÔNG đổi giao diện/màu ô; ô nhập chỉ hiện con trỏ. KHÔNG sửa code sản xuất ở Task 1–2 trừ khi test lộ lỗi thật (khi đó báo lại, nêu rõ).
- 3 test VT lỗi sẵn ở HEAD (bộ lọc cảnh báo ×2, nút Xuất Excel) và 2 test `account-work-assignment` lỗi sẵn: không sửa, không tính là lỗi mới.
- Bình luận code tiếng Việt, cùng phong cách với file xung quanh. Không commit, không push.

## Task 1: Test ô nhập trực tiếp bảng VT
File mới `server/test/frontend/vt-positions-inline-edit.test.js`, bắt chước cách `vt-positions.test.js` / `vt-positions-detail.test.js` dựng trang (trích code từ HTML, fake fetch). Phủ:
1. Bấm ô Ghi chú/Ngày về/Vị trí (có quyền sửa) → có `input.vt-inline`, KHÔNG mở `vtDetailDialog`; bấm cột khác (VD Tên hàng) → mở hộp chi tiết.
2. Chỉ xem (không quyền sửa) bấm ô Ghi chú → mở hộp chi tiết, không có input.
3. Gõ giá trị mới + Enter → gọi PATCH `/api/stock-positions/:id` đúng `version` và chỉ trường đã đổi; Vị trí được chuẩn hóa (bỏ khoảng trắng, hoa).
4. Không đổi giá trị → không gọi PATCH. Esc → hủy, không PATCH, ô trả về chữ cũ.
5. Mũi tên Down/Up chuyển sang input cùng cột ở dòng kề và ô cũ tự lưu; Right chỉ chuyển khi con trỏ ở cuối chữ; Left tương tự ở đầu chữ.
6. Làm mới nền (render background) không ghi đè ô đang gõ.
Chạy: `node --test test/frontend/vt-positions-inline-edit.test.js` → xanh.

## Task 2: Test điều hướng mũi tên dùng chung
File mới `server/test/frontend/table-controls-arrow-nav.test.js`, bắt chước `table-controls-integration.test.js`. Phủ: Up/Down sang cùng cột ở dòng kề (bỏ qua dòng không có input); Left/Right chỉ chuyển khi con trỏ ở mép; input type=number Up/Down chuyển ô; textarea Up/Down chỉ chuyển khi con trỏ ở đầu/cuối chữ; `select`/readOnly/disabled/ô đã `preventDefault` thì bỏ qua; không có ô kề thì không `preventDefault`.
Chạy: file mới + `table-controls*.test.js` → xanh.

## Task 3: Tài liệu + graphify
Theo `.agents/skills/update-file/SKILL.md` và CLAUDE.md mục 3: ghi ngắn (không dài dòng) vào `CURRENT.md`, `README.md` (danh sách cập nhật gần nhất), `server/README.md` nếu có mô tả trang VT/table-controls, và ngày cập nhật cuối tài liệu liên quan; sửa câu hướng dẫn `.vt-hint` trong `server/public/vt-positions/index.html` cho đúng hành vi mới (bấm ô Ghi chú/Ngày về/Vị trí để gõ trực tiếp, bấm cột khác để xem chi tiết). Chạy `graphify update .` ở thư mục gốc. Chạy lại `node --test test/frontend/*.test.js` và đối chiếu: chỉ còn các lỗi có sẵn nêu ở Global Constraints.
