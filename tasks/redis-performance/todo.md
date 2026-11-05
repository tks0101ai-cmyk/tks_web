# Redis performance — tiến độ

Cập nhật: 03/11/2026. Kế hoạch: [plan.md](plan.md).

- [x] T1a: timing API/frontend và monitor pool/event-loop/cache.
- [x] T1b: benchmark fixture 1/20/100 dòng, 5 người, so sánh trước/sau (benchmark.md).
- [ ] T1c: baseline API/trình duyệt staging/production cold/warm thực tế.
- [x] T2: đường đọc một đơn, test tương đương lifecycle.
- [x] Checkpoint cục bộ: hồi quy backend và benchmark fixture trước/sau.
- [x] T3a: Redis adapter + seller phones + worker refresh.
- [x] T3b: Sheets/history generation cache + unit tests expiry/outage/corruption.
- [ ] T3c: integration Redis thật (test đã có, skip khi thiếu REDIS_TEST_URL).
- [x] T4a: bulk insert + đọc độc lập song song.
- [x] T4b: prefetch/parallel assets + fresh form/revision gate + timing frontend.
- [x] Checkpoint cục bộ: regression giao dịch/rollback/version/Redis timeout và in phiếu.
- [ ] Checkpoint staging: cạnh tranh PostgreSQL thật, Redis thật và browser thật.
- [ ] T5: kiểm tra cấu hình production, web Singapore/Redis, cutover + rollback.
- [x] T6a: docs và build; graphify update thành công (14489 nodes/32122 edges/609 communities).
- [x] T6b: bộ kiểm thử liên quan cuối 449 đạt/0 lỗi/1 skip; build đạt; review không còn finding quan trọng.
- [ ] T6c: nghiệm thu staging/browser và SLO production.
- [ ] Theo dõi 48 giờ và nghiệm thu p95 production.


## Bằng chứng
- `.codex_tmp/redis-performance-final.log`: 450 ca, 449 đạt, 0 lỗi, 1 skip (thiếu REDIS_TEST_URL), 126.4 giây. Lượt trước bắt gặp regression iframe ở pha RED trong lúc agent sửa; đã sửa revision và lượt cuối này xanh.
- Sau bỏ socket idle timeout gây reconnect không cần thiết: 16/16 ca cache/phone/Sheets/monitor chạy lại đạt; `npm run build` đạt.
- `graphify update .`: lần đầu lỗi WinError1224 do file mapped; lần chạy lại thành công 14489 nodes, 32122 edges, 609 communities.
- Không commit/push; production chưa đổi. Test chạy trên Node24.19.0; Render repo khai báo Node22.x, cần smoke test staging Node22 trước cutover.
