# CURRENT — Trạng thái dự án
> 10/11/2026 — **Bộ canh event loop (nhánh `perf/loop-stall-watch`, chưa merge/deploy, không migration):** thêm `server/lib/loopStallWatch.js` + biến `LOOP_STALL_WARN_MS` (mặc định 1000 ms, `0` tắt). Khi event loop đứng ≥ ngưỡng, log `[loop-stall] lag=… inflight=N […] done=[…]` liệt kê request đang chạy và request xong trong khoảng đứng (bỏ qua SSE). Kiểm chứng: 9 test mới; 18 file test lib + test nạp config/index: 304 đạt, 3 bỏ qua (cần Redis thật), 0 lỗi; thử server thật với route chặn CPU 1,5 s → log đúng `done=[GET /api/heavy 1503ms]`, SSE không lọt vào, Set rỗng sau khi xong. **Việc tiếp theo:** merge + deploy, chạy một ngày, lọc log `[loop-stall]` để biết request nào gây khối 1,1–1,7 s (10/11 sáng) và 10–12 s (09/11).
> 10/11/2026 — **Thu mua: áp dụng bài học Kiểm kê (cục bộ, chưa merge/deploy):** scheduler gộp3giây/visibility/trailing, coordinator không starvation; revision nhẹ + gộp roster/history polling, NV không chặn bảng. Thêm purchase-grid.js và purchase-grid-ui.js: Shift/range/copy/TSV/rowKey/Ctrl+D/kéo điền/tổng vùng, Escape hủy ô hoặc bỏ vùng theo chế độ; một thao tác vùng một undo, không tự lưu. Giữ focus/mốc/version/chờ xếp, chặn paste sai vị trí và phí cha đang tách. Reviewer xác nhận hai phát hiện đã sửa. Test288/288 đạt + nhóm focus9/9 + Escape vùng1/1; hai phiên IAB dữ liệu giả lập giữ vùng/nháp khi remote đổi dòng khác. Báo cáo docs/04-planning/purchase-grid-sync-20261110-test-report.md. graphify không có lệnh, chưa cập nhật; không chạm production.

> 10/11/2026 — **Dự kiến hàng về: tên SP dự phòng cho mã ngừng kinh doanh, để sale tìm/đặt được (không migration, chưa commit/deploy):** `product_container_expected.product_name` trước chỉ lấy từ `product_report` (bảng này chỉ giữ mã ĐANG kinh doanh ở ít nhất một cơ sở, migration 0055) nên mã ngừng kinh doanh (`products.is_active=false` cả hai cơ sở) luôn ra tên rỗng dù vẫn còn dòng hàng trong sheet CONT — không phải bị chặn tìm theo MÃ (mã vẫn tìm ra bình thường, không có is_active ở bất kỳ bước đồng bộ/API nào), mà tên rỗng khiến sale khó nhận diện đúng hàng khi chỉ biết tên. Sửa `expectedRefresh.js` (`STAGE_SQL`): thêm `LEFT JOIN` dự phòng sang `products` (bảng gốc KiotViet, còn cả mã không hoạt động) theo `lower(btrim(mã))`, `min(name)`; ưu tiên `product_report` trước, không có mới lấy `products`, không có ở cả hai thì vẫn `''` như cũ. Không đổi cột/bảng/quyền/cách tính version. Test fixture `expectedRefresh.test.js` thêm migration `0001_core_master_data.sql` (bảng `products`) + 1 ca mới xác nhận mã ngừng kinh doanh lấy đúng tên; 13/13 test file này và 84/84 toàn bộ `productContainers/*.test.js` đạt. Đã đồng bộ `server/db/SCHEMA.md`. Chưa commit/deploy; chưa kiểm trên trình duyệt thật/DB production.
>
> 10/11/2026 — **Nghiên cứu Kiểm kê → Thu mua (chỉ đọc mã, không sửa chức năng):** báo cáo docs/04-planning/stocktake-purchase-lessons-20261110.md. Đã kiểm tra SSE/throttle/visibility, expected/version, editor, copy/paste/fill/undo, queue và singleflight; nhóm test nghiên cứu115/115 đạt. Ưu tiên đề xuất Thu mua: gộp tải + tabẩn, tách danh mục NV khỏi đường tải bảng, revision snapshot thống nhất, giữ vùng chọn theo rowKey/id, tái sử dụng TSV/editor; giữ drafts/outbox/idempotency và đối chiếu của Thu mua. Không sao chép auto-save/undo ghi DB hoặc bus nội bộ Kiểm kê. Chưa triển khai đề xuất, chưa kiểm production.

File này chỉ trả lời 2 câu: **đang dở gì** và **việc tiếp theo là gì**. Lịch sử chi tiết nằm trong mô tả PR / commit, không chép vào đây.

Lịch sử cũ (đến 10/11/2026): [docs/archive/CURRENT-den-2026-11-10.md](docs/archive/CURRENT-den-2026-11-10.md).

## Cách ghi

- Mỗi việc **1 dòng**: `- [ ] DD/MM — <việc> (nhánh/PR, migration nếu có) — <bước tiếp theo>`.
- Thêm dòng mới vào **cuối** mục tương ứng. Không chèn đoạn dài lên đầu file.
- Xong việc thì **xóa dòng** (git log/PR đã lưu lịch sử), không đánh `[x]` rồi để lại.
- Chi tiết (số liệu, lệnh chạy, kết quả test) để trong mô tả PR hoặc `docs/`, ở đây chỉ dẫn link.
- `.gitattributes` đặt `CURRENT.md merge=union`: merge trên máy (`git merge origin/main`) sẽ giữ dòng của cả hai phía thay vì báo conflict. Sau merge nên liếc lại xem có dòng trùng không.

## Đang dở / chờ

> Rà ngày 10/11/2026: web `tokosi` và worker đều đang chạy `main` mới nhất (`d5e9ceb8`); mọi migration trong repo (đến `0120`) đã áp DB thật. Các việc cũ đã xong được xóa, xem file lưu trữ nếu cần chi tiết.

- [ ] 10/11 — Bộ canh event loop (PR #70, đã deploy 10/11) — 11/11 lọc log `[loop-stall]` trên Render để tìm request gây khối 1–12 s
- [ ] 10/11 — Vòng đời đơn hàng: đo lại thời gian tải 14–16h; > 2 s thì làm cache `latestStatuses`
- [ ] 09/11 — Ổn định web, phần còn lại (kế hoạch ở nhánh local `docs/web-stability-singapore`, chưa push): đo RAM worker 3 đêm; tạo web service Singapore + chuyển tên miền (web hiện vẫn ở Oregon, DB ở Singapore)
- [ ] 05–10/11 — 3 PR đang mở chờ duyệt/merge hoặc đóng: #71 (tên hàng ngừng KD ở Dự kiến hàng về), #47 (bảng Thu mua bị đẩy xuống), #41 (bộ lọc facet = 0 ở Vòng đời)
- [ ] 30/10 — Bảng cũ `stock_location_lines` (15.302 dòng) và 2 dòng `stock_locations_hn/sg` trong `sheet_snapshot_sync` không còn dùng (ngừng đồng bộ từ 30/10) — quyết định viết migration DROP
- [ ] 19/10 — Quản lý rà soát 3 tài khoản sau vá phân quyền (danh sách trong file lưu trữ, mục 3)
- [ ] 10/11 — Nguồn 3 trang VAT đổi sang file trung gian "cúc cu test" (nhánh `claude/brainstorm-error-cause-fix-bb0ebf`) — merge + deploy; sau đó cân nhắc lưu bản đọc tốt gần nhất vào Postgres để deploy không mất cache

## Chỉ người vận hành làm được

- Deploy Render; nhập biến môi trường/token (AI không được nhập token).
- Áp migration lên DB thật: `npm run db:migrate` ngoài giờ cao điểm.

---
Cập nhật: 10/11/2026
