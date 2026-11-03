# Tăng tốc chỉ định vị trí và in phiếu bằng Redis

Ngày: 03/11/2026. Người dùng đã duyệt kế hoạch và yêu cầu triển khai.

## Kiến trúc
- Chuyển web Oregon sang Singapore, tận dụng worker Singapore hiện có; PostgreSQL vẫn là nguồn sự thật cho đơn, tồn và giữ chỗ.
- Redis 256 MB cùng vùng, private URL, allkeys-lru, cache tái tạo được. Node redis CommonJS; cache timeout 150ms, fail-open, không offline queue.
- SĐT sale: phân tách cơ sở/retailer/seller, fresh 5 phút, last-good tối đa 30 phút, worker refresh mỗi 4 phút. Request cold tối đa 1 giây.
- Sheets/lịch sử ghi đè: shared cache 15 giây, generation chống stale refill, invalidate sau ghi kể cả timeout.
- Form in: PostgreSQL/version/409; phiếu từ snapshot sau commit, không cache tồn/giữ chỗ.

## Thứ tự và nghiệm thu
1. T1: timing API/trình duyệt, pool/khóa/giao dịch; baseline 1/20/100 dòng, cold/warm, concurrency 5, p50/p95. Không ghi dữ liệu production để đo tải.
2. T2: đọc đúng một mã đơn, giữ quy tắc lifecycle/Accounting giữa hai cơ sở, không full-merge/cước/điều chuyển. Hồi quy dữ liệu/tiền/snapshot/phân quyền.
3. T3: Redis adapter, SĐT/worker, Sheets/history cache; outage/fresh/stale/generation/branch isolation tests và integration Redis thật.
4. T4: bulk insert cùng giao dịch/khóa, đọc độc lập song song ngoài transaction; prefetch assets và parallel QR; fresh form trước in.
5. T5: xác minh Supabase/worker/env, deploy web Singapore + Redis; tổng kết nối bao gồm LISTEN và overlap; domain/OAuth/cookies/SSE/webhooks/files; rollback Oregon 48h.
6. T6: docs, tests/build, graphify, theo dõi 48h. Không nhận hoàn tất production khi chưa có bằng chứng.

## Mục tiêu
p95 mở chỉ định ≤1s; lưu đến phiếu sẵn sàng ≤2s với ≤100 dòng; cải thiện ≥50% nếu baseline vượt ngưỡng. Không sai tồn/tiền; Redis down vẫn hoạt động. Không cam kết RAM RSS giảm trước khi đo.

## Giới hạn vận hành
Giữ main theo MEMORY; không sửa các thay đổi invoicePriceAudit của phiên khác. Giữ tasks/plan.md và todo.md cũ. Chưa có migration dự kiến. Các bước production phụ thuộc đầy đủ kiểm chứng mã và kiểm tra cấu hình/domain thực tế.
