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

> Chuyển nguyên từ mục "Hành động tiếp theo" của file cũ ngày 10/11/2026, **chưa rà lại**: nhiều việc có thể đã xong. Ai nắm việc nào thì xóa hoặc cập nhật dòng đó. Chi tiết từng việc xem file lưu trữ.

- [ ] 31/10 — Chỉ định vị trí: thêm/sửa/xóa VT trong hộp — commit + deploy, báo kho về chặn `BELOW_HELD`
- [ ] 30/10 — Sau khi gỡ module Vị trí hàng cũ — chờ duyệt migration DROP `stock_location_lines`
- [ ] 29/10 — Sync KiotViet: đối soát `products` + tăng dần theo id — push/deploy
- [ ] 27/10 — Trạng thái bốc + phiếu in mới + cột Có thể bốc — kiểm thử lại, deploy
- [ ] 24/10 — Bảng giá duyệt — áp migration `0091`, `0092`, deploy
- [ ] 23/10 — Kiểm tra giá bán — các bước production (áp `0077`…)
- [ ] 20/10 — Yêu cầu xuất VAT (`feature/vat-requests`) — xác nhận đã lên production
- [ ] 19/10 — Tạo QR bằng AI — biến môi trường trên Render
- [ ] 19/10 — Tính sẵn báo cáo trong DB (`0068`–`0070`) — deploy, đo lại
- [ ] 19/10 — Đối chiếu lệch `schema_migrations` (`0014_customer_debt_report_lines.sql`)
- [ ] 19/10 — Quản lý rà soát 3 tài khoản sau vá phân quyền
- [ ] 12/10 — Pancake Marketing — bật job, đối soát ≥ 3 đêm rồi mới đặt `MARKETING_REPORT_SOURCE=postgres`
- [ ] 19/10 — Báo cáo hàng hóa 34 cột (`0067`) — deploy
- [ ] 19/10 — Giảm egress Supabase đợt 2 (`0066`) — đo lại `pg_stat_statements` sau ≥ 7 ngày
- [ ] Báo cáo hàng hóa 19 cột (`0057`) — deploy
- [ ] Vận hành: backfill Báo cáo kinh doanh (`node kiotvietSync/businessMonthlyRefresh.js`), nạp Team sale, đăng ký webhook Telegram bot nghỉ phép

## Chỉ người vận hành làm được

- Deploy Render; nhập biến môi trường/token (AI không được nhập token).
- Áp migration lên DB thật: `npm run db:migrate` ngoài giờ cao điểm.

---
Cập nhật: 10/11/2026
