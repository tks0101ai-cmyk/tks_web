# CURRENT — Trạng thái dự án

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

## Chỉ người vận hành làm được

- Deploy Render; nhập biến môi trường/token (AI không được nhập token).
- Áp migration lên DB thật: `npm run db:migrate` ngoài giờ cao điểm.

---
Cập nhật: 10/11/2026
