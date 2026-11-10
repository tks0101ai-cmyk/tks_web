# Thu mua: điều phối đồng bộ và thao tác vùng ô

Goal: áp dụng báo cáo stocktake-purchase-lessons-20261110 mà giữ drafts/xác nhận lưu/audit/idempotency.
Architecture: điều phối tự động dùng throttle và visibility, snapshot hàng không đợi directory; module thuần cho TSV và vùng theo id/field. Vanilla JS/CommonJS, không thêm framework/migration.

- [x] Đồng bộ: purchase-realtime.js/.test.js — createScheduler({refresh,isHidden,gapMs,onError,setTimer,clearTimer,now}) → trigger(), visible(), destroy(). Gom sự kiện3giây, không chồng lượt, có lượt cuối, tab ẩn chỉ ghi dirty. Coordinator phải render lượt hiện tại kể cả pending rồi theo sau; không bỏ dữ liệu mãi khi request chậm.
- [x] Bảng thuần: purchase-grid.js/.test.js — parseTSV(text), planPaste({text,rows,columns,anchor,focus}), range({rows,columns,anchor,focus}), fill({rows,columns,anchor,focus,target}), summarize(cells). id/field ổn định; rowKey cho dán có mã; mã trùng/không khớp báo lỗi trước sửa. Ô1×1 điền cả vùng. Không cho sửa cột tính/NV bằng dán.
- [x] Tích hợp purchase.js/index/workspace.css: SSE/poll qua scheduler; visible/online/pagehide cleanup; directory không block snapshot. Shift/click và kéo chọn vùng; copy TSV; paste một bước undo; fill qua nút kéo hoặc Ctrl+D; giữ nháp và chờ xếp ưu tiên.
- [x] Backend: gộp đọc history/roster theo tick process thay vì query theo từng connection, presence vẫn quản lý riêng; snapshot revision cùng fingerprint history; không bỏ quyền truy cập.
- [x] Test: burst100events, response5giây không starve, tabẩn, directorytreo, TSVquoted, rowKeytrùng, vùngneo quarefresh, copy/paste/undo, hai phiên. Chạy suite liên quan và cập nhật báo cáo/CURRENT, không merge/deploy.

Kết quả:288/288 bộ toàn phần và các hồi quy focus bổ sung đạt; không merge/deploy. Xem docs/04-planning/purchase-grid-sync-20261110-test-report.md. graphify chưa có trong môi trường.
