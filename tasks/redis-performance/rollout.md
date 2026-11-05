# Runbook Redis + web Singapore

Cập nhật: 03/11/2026. Trạng thái: mã đang hoàn thiện cục bộ; CHƯA tạo Redis, CHƯA chuyển web/deploy. Công cụ browser dừng do không xác định chắc chắn URL Windows; không thao tác tiếp trên UI.

## Kiểm tra trước deploy
- Kiểm chứng hostname DB và region trong Supabase Dashboard; không suy ra chắc chắn từ ghi chú mã nguồn. Không ghi URL/secret vào tài liệu/log.
- Render production đã quan sát: `tokosi` Oregon (1 CPU/2GB), `tks_web_worker` Singapore. Xác minh web `BACKGROUND_JOBS=worker`; worker start `npm run worker`, đúng 1 instance, cùng bản mã.
- Phân biệt thay đổi Redis với các file invoicePriceAudit đang sửa ở phiên khác. Không deploy toàn bộ working tree chưa review.
- Chạy test/bộ benchmark staging và EXPLAIN truy vấn header chuẩn hóa; chưa thêm index nếu chưa thấy cần. Không dùng benchmark local làm SLO production.

## Redis Singapore
Tạo Render Key Value 256MB (~10 USD/tháng theo khảo sát kế hoạch), `allkeys-lru`, persistence Off vì toàn bộ cache tái tạo được, không mở kết nối công khai production.

Web và worker: `REDIS_ENABLED=true`, `REDIS_NAMESPACE=tokosi:production:v1`, `REDIS_URL=<internal URL từ Render>`. Staging dùng namespace khác. Thiếu URL hoặc `REDIS_ENABLED=false` thì dùng cache RAM cục bộ; Redis down thì đọc nguồn. Không cache auth/tồn/giữ chỗ/form in.

Xác minh integration Redis thật trong môi trường TEST riêng với `REDIS_TEST_URL`, chạy `node --test lib/sharedCache.integration.test.js`. Test tạo key namespace ngẫu nhiên; KHÔNG trỏ vào production. Máy hiện tại chưa có Redis/WSL/Docker, test integration đang skip.

## Web Singapore
Render không đổi region tại chỗ: tạo service thay thế, cấu hình 1 CPU/2GB và start command hiện tại. Giữ nguyên secret ký phiên, khóa mã hóa và cấu hình auth hợp lệ; sao chép qua cơ chế secret của Render. Kiểm tra file upload/data đang nằm trên filesystem có cần di chuyển hoặc dùng chung trước cutover.

Trong giai đoạn chạy chồng, đặt pool mỗi web cũ/mới = 4 và worker = 3 nếu giới hạn session pool vẫn 15; thêm 2 LISTEN web = 13 kết nối dự kiến, còn 2 dự phòng. Tính lại nếu có dịch vụ/job/script khác. Không dựa vào con số 7 mỗi instance khi có 3 tiến trình. Rollback phải tính cả kết nối web mới chưa dừng.

Nếu dùng custom domain: kiểm chứng URL tạm, health, login/OAuth callback, cookie, SSE, webhook và phiếu trước chuyển domain/DNS. Nếu chỉ dùng onrender.com: service mới có hostname mới; cập nhật URL/callback/webhook và thông báo đường vào theo hostname thực tế, không giả định giữ hostname cũ được. Không đăng ký lại webhook Telegram vào service mới trong lúc smoke test làm đổi đường nhận của production.

## Nghiệm thu và quay lại
- Staging: đơn 1/20/100 dòng, HN/SG, Accounting trùng mã, version409, hai người cùng giữ vị trí, rollback, chuyển mẫu in, form loading/error/save; Redis disconnect/expiry/eviction/reconnect.
- Thu p50/p95 Server-Timing và PerformanceObserver (`tokosi.pick.*`) cho cả cold/warm, 5 người đồng thời. Không log mã đơn/tên/SĐT. Mục tiêu p95 mở ≤1s, lưu→phiếu ≤2s; giảm ≥50% nếu baseline vượt mục tiêu.
- Theo dõi 48 giờ: RSS/heap, eventLoopP95/Max, poolWaiting, cacheHit/Miss/Error/Bypass, lỗi giao dịch và độ tươi nguồn. Redis errors không được chặn chỉ định; lỗi form phải chặn in nhầm định dạng.
- Redis rollback: `REDIS_ENABLED=false` + redeploy; giữ PostgreSQL nguyên trạng. Web rollback: trả domain/lưu lượng/callback về Oregon; kiểm tra chỉ 1 scheduler. Không đảo tồn hoặc viết lại snapshot để rollback code.
- Giữ Oregon 48h sau cutover thành công; chưa xóa dịch vụ cũ trong phiên này.
