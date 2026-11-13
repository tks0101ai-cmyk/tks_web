# CURRENT — Trạng thái dự án
> 10/11/2026 — **Bộ canh event loop (PR #70 đã merge/deploy, không migration):** `server/lib/loopStallWatch.js` ghi request đang chạy và vừa xong khi event loop đứng ≥ `LOOP_STALL_WARN_MS` (mặc định 1000 ms, `0` tắt; bỏ qua SSE). Kiểm chứng 9 test mới và thử server thật. **Việc tiếp theo:** rà log `[loop-stall]` sau một ngày để xác định request gây khối 1–12 s.
> 10/11/2026 — **Thu mua: đồng bộ lưới (đã có trên main, commit `a4748410`):** gộp polling/revision, giữ nháp và vùng chọn, copy/paste/fill/undo trong session; kiểm thử cục bộ 288/288 và kiểm tra hai phiên IAB dữ liệu giả lập. Báo cáo `docs/04-planning/purchase-grid-sync-20261110-test-report.md`. Chưa xác minh UI trên production.

> 10/11/2026 — **Dự kiến hàng về: tên SP dự phòng cho mã ngừng kinh doanh (PR #71 đã merge vào main, commit `a7c2d58d`; chưa xác minh production):** `product_container_expected.product_name` trước chỉ lấy từ `product_report` (bảng này chỉ giữ mã ĐANG kinh doanh ở ít nhất một cơ sở, migration 0055) nên mã ngừng kinh doanh (`products.is_active=false` cả hai cơ sở) luôn ra tên rỗng dù vẫn còn dòng hàng trong sheet CONT — không phải bị chặn tìm theo MÃ (mã vẫn tìm ra bình thường, không có is_active ở bất kỳ bước đồng bộ/API nào), mà tên rỗng khiến sale khó nhận diện đúng hàng khi chỉ biết tên. Sửa `expectedRefresh.js` (`STAGE_SQL`): thêm `LEFT JOIN` dự phòng sang `products` (bảng gốc KiotViet, còn cả mã không hoạt động) theo `lower(btrim(mã))`, `min(name)`; ưu tiên `product_report` trước, không có mới lấy `products`, không có ở cả hai thì vẫn `''` như cũ. Không đổi cột/bảng/quyền/cách tính version. Test fixture `expectedRefresh.test.js` thêm migration `0001_core_master_data.sql` (bảng `products`) + 1 ca mới xác nhận mã ngừng kinh doanh lấy đúng tên; 13/13 test file này và 84/84 toàn bộ `productContainers/*.test.js` đạt. Đã đồng bộ `server/db/SCHEMA.md`. Chưa commit/deploy; chưa kiểm trên trình duyệt thật/DB production.
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

- [ ] 10/11 — Nhân sự: sửa hồ sơ trùng số sổ bảo hiểm báo 500 (nhánh `fix/hr-employee-insurance-duplicate`, không migration) — merge + deploy, rồi rà `hr_employees` xem còn số bảo hiểm trùng nào do import cũ để lại
- [ ] 10/11 — Bộ canh event loop (PR #70, đã deploy 10/11) — 11/11 lọc log `[loop-stall]` trên Render để tìm request gây khối 1–12 s
- [ ] 10/11 — Nhân sự: sửa hồ sơ trùng số sổ bảo hiểm báo 500 (PR #74 đã merge, không migration) — xác minh deploy rồi rà `hr_employees` xem còn số bảo hiểm trùng nào do import cũ để lại
- [ ] 10/11 — Vòng đời đơn hàng: đo lại thời gian tải 14–16h; > 2 s thì làm cache `latestStatuses`
- [ ] 09/11 — Ổn định web, phần còn lại (kế hoạch ở nhánh local `docs/web-stability-singapore`, chưa push): đo RAM worker 3 đêm; tạo web service Singapore + chuyển tên miền (web hiện vẫn ở Oregon, DB ở Singapore)
- [ ] 05–10/11 — Rà trạng thái PR còn tồn: #47 (bảng Thu mua bị đẩy xuống), #41 (bộ lọc facet = 0 ở Vòng đời)
- [ ] 30/10 — Bảng cũ `stock_location_lines` (15.302 dòng) và 2 dòng `stock_locations_hn/sg` trong `sheet_snapshot_sync` không còn dùng (ngừng đồng bộ từ 30/10) — quyết định viết migration DROP
- [ ] 10/11 — Xuất kho Excel (`POST /stock-positions/stock-out`) cho xuất khi Đang bốc + cho xuất âm, `planStockOut` (không migration) — deploy rồi thử file có mã đang bốc và mã vượt tồn trên VT thật
- [ ] 19/10 — Quản lý rà soát 3 tài khoản sau vá phân quyền (danh sách trong file lưu trữ, mục 3)
- [ ] 10/11 — Nguồn 3 trang VAT đổi sang file trung gian "cúc cu test" (nhánh `claude/brainstorm-error-cause-fix-bb0ebf`) — merge + deploy; sau đó cân nhắc lưu bản đọc tốt gần nhất vào Postgres để deploy không mất cache
- [ ] 12/11 — 3 trang VAT đọc file gốc VAT TKS làm dự phòng khi tab trung gian lỗi `#REF!` (nhánh `claude/sheet-ref-error-3eeb99`, không migration) — merge + deploy

- [ ] 11/11 — Vị trí hàng cho xác nhận bốc âm, đổi tên vị trí đồng bộ đơn chỉ định và đối soát đơn Kiot hoàn thành (không migration) — deploy web/worker rồi kiểm số đơn chuyển và số còn lỗi đối soát
- [ ] 12/11 — Hiệu năng: PR #77–#79 đã deploy (khựng ~50–60 → ~16 lần/giờ); đợt 4 (nghỉ phép, Excel worker, trả bản cũ khi làm mới — nhánh `claude/friendly-ride-y0uwwk`, không migration) — merge + deploy (ngoài giờ cao điểm), rồi đọc `[loop-stall]`/`[timing]`
- [ ] 12/11 — Thu mua: endpoint delta + client đồng bộ sau SSE/revision/lưu, giữ version/draft và reset fallback (không migration) — kiểm nhiều tab/reconnect, deploy rồi đo p50/p95 và payload production; xem [kế hoạch](docs/superpowers/plans/2026-11-12-purchase-delta-sync.md)
- [ ] 12/11 — Thu mua: import Excel snapshot đã push `main` (`725e73d5`) và Render đã phục vụ JS mới — người dùng thử workbook thật và đồng bộ giữa 2 phiên; xem [kế hoạch](docs/superpowers/plans/2026-11-12-purchase-excel-snapshot-import.md)

## Chỉ người vận hành làm được

- Deploy Render; nhập biến môi trường/token (AI không được nhập token).
- Áp migration lên DB thật: `npm run db:migrate` ngoài giờ cao điểm.

- [ ] 12/11 — Lịch sử công nợ: hai lần sửa trạng thái liên tiếp của 1 khách chạy song song làm dòng phạt đã chốt lệch trạng thái thật (đã vá bằng khóa advisory trong `saveHistoricalStatus`, chưa commit/deploy) — deploy rồi chạy `node server/debtSchedule/debtHistoryRepair.js` (dry-run) → `--apply` để sửa 19 dòng phạt + 15 số phiên lệch (−475.000đ)

---
Cập nhật: 12/11/2026
