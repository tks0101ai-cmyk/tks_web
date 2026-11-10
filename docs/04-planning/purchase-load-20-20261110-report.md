# Thử tải Thu mua: 20 worker — 10/11/2026

## Kết luận

Các kiểm chứng dữ liệu của phép thử local đạt. 20 worker với 500 dòng đạt ngưỡng độ trễ local đề xuất; 5.000 dòng không đạt khi vừa lưu vừa tải lại toàn bảng. Chưa đủ bằng chứng nghiệm thu sức tải production. Không merge/deploy hay đổi cơ chế lưu trong tác vụ này.

## Môi trường và giới hạn

- Thời điểm kết thúc: 2026-11-10T01:57:37.099Z. Node v24.19.0, win32; CPU 11th Gen Intel(R) Core(TM) i5-11400F @ 2.60GHz, 12 logical CPUs, RAM máy 15.9 GiB.
- Working tree chưa commit, HEAD 867fb5ce, branch fix/expected-arrivals-inactive-product-name. Bao gồm các thay đổi Thu mua từ phiên trước; không phải benchmark main sạch.
- API Express, phân quyền feature, router, service, transaction, audit, idempotency, SQL và SSE thật. 20 danh tính HTTP độc lập, giữ 20 stream trong suốt lượt thử; xác thực phiên được tiêm, không đo đăng nhập/JWT thực.
- Database PGlite mới hoàn toàn trong RAM. Một lease độc quyền cho cả transaction để tránh trộn BEGIN/COMMIT. Do đó đây là request đồng thời nhưng DB tuần tự, không chứng minh khóa/deadlock trên PostgreSQL nhiều connection.
- integration_enabled=false đúng chế độ cách ly đang phát triển; chưa đo projection sang các module chung khi bật tích hợp.
- Client phát tải, parse JSON, API và PGlite cùng process. CPU/RAM/event-loop sau đây là tổng harness, không phải riêng web production. Không TLS/proxy/compression/full app middleware, không WAN, không 20 browser render DOM, không bài soak kéo dài.
- Workers phát request theo vòng kín: chờ phản hồi rồi gửi tiếp; ca mixed mỗi worker lưu ô rồi tải snapshot, 3 vòng, không mô phỏng chính xác scheduler frontend. Không xác định ngưỡng RPS bền vững bằng phép thử ngắn này.

## Kết quả từng ca

p95 nghĩa là 95% request trong ca có thời gian nhỏ hơn hoặc bằng giá trị này; thời gian ms, RSS MiB. HTTP 409 là xung đột dự kiến, không phải lỗi server.

| Ca | Requests | HTTP | p50 ms | p95 ms | p99 ms | req/s | RSS peak MiB |
|---|---:|---|---:|---:|---:|---:|---:|
| idle-20-SSE-9-seconds | 0 | {} | 0.0 | 0.0 | 0.0 | 0.0 | 410.8 |
| 20-workers-own-row-20-saves-each | 400 | {"200":400} | 130.2 | 168.9 | 188.1 | 146.9 | 429.9 |
| 20-workers-same-cell | 20 | {"200":1,"409":19} | 83.1 | 83.2 | 83.3 | 235.3 | 430.9 |
| different-cells-same-stale-row | 2 | {"200":2} | 8.1 | 14.8 | 14.8 | 132.9 | 430.5 |
| 20-duplicates-one-actor-one-idempotency-key | 20 | {"200":20} | 46.9 | 47.2 | 47.2 | 412.1 | 430.9 |
| 20-workers-mixed-save-refresh-500-rows | 120 | {"200":120} | 224.6 | 473.3 | 524.8 | 63.2 | 523.4 |
| 20-workers-read-500-rows-3-times | 60 | {"200":60} | 515.9 | 526.3 | 531.1 | 38.3 | 530.6 |
| 20-workers-revision-500-rows-10-times | 200 | {"200":200} | 19.2 | 26.1 | 27.0 | 985.1 | 521.1 |
| 20-workers-mixed-save-refresh-5000-rows | 120 | {"200":120} | 384.2 | 4262.8 | 4323.2 | 9.1 | 840.0 |
| 20-workers-read-5000-rows-3-times | 60 | {"200":60} | 4184.3 | 4568.8 | 4614.8 | 4.7 | 923.0 |
| 20-workers-revision-5000-rows-10-times | 200 | {"200":200} | 17.4 | 23.5 | 24.2 | 1049.3 | 913.4 |

Trong ca mixed, thời gian lưu và đọc được tách riêng (p95 tổng hợp không đại diện một thao tác cụ thể):

| Ca | Method | Requests | p95 ms |
|---|---|---:|---:|
| 20-workers-mixed-save-refresh-500-rows | PATCH | 60 | 219.3 |
| 20-workers-mixed-save-refresh-500-rows | GET | 60 | 498.3 |
| 20-workers-mixed-save-refresh-5000-rows | PATCH | 60 | 349.7 |
| 20-workers-mixed-save-refresh-5000-rows | GET | 60 | 4294.3 |

## Tính đúng dữ liệu và đồng bộ

- 400 lần lưu trên 20 dòng riêng: đúng giá trị cuối từng worker trước khi chạy mixed; tất cả thành công.
- 20 worker sửa cùng ô từ cùng baseline: 1 thành công, 19 nhận 409; không âm thầm ghi đè.
- 2 worker sửa hai cột khác nhau của cùng dòng từ version cũ: cả hai giá trị được giữ. Chưa kiểm tra 20 cột khác nhau cùng dòng.
- 20 lần gửi lại cùng actor/key/body: trả cùng version, chỉ một mutation thực tế.
- Mixed 500 và 5.000 dòng: 120 mutation thêm; mỗi lần đọc kiểm tra giá trị chính worker vừa lưu.
- Tổng 524 audit records, khớp số mutation kỳ vọng; không trùng audit do gửi lại.
- Mỗi SSE stream nhận đúng 524 thông báo mutation trực tiếp, tách khỏi thông báo revision của heartbeat. p95 thời gian từ event bus emit đến parser SSE trong cùng process: 105.3 ms. Không phải thời gian đến lúc ô hiển thị trên trình duyệt.
- 20 endpoint revision cùng kết quả; 20 SSE stream đều quan sát final revision trước khi đóng. Chưa kiểm tra 20 bản sao bảng frontend thực tế.
- Mỗi stream thấy 20 danh tính; sau đóng hết còn 0 lease.

## Ngưỡng đánh giá local

Ngưỡng đề xuất cho phép thử này, chưa phải SLA được người dùng duyệt: PATCH p95 ≤1.000 ms; GET toàn bảng p95 ≤2.000 ms. Chức năng đúng và sức tải được đánh giá riêng; script exit 2 nếu có ngưỡng tốc độ không đạt.

| Ca | Method | p95 ms | Ngưỡng ms | Kết quả |
|---|---|---:|---:|---|
| 20-workers-own-row-20-saves-each | PATCH | 168.9 | 1000 | Đạt |
| 20-workers-mixed-save-refresh-500-rows | PATCH | 219.3 | 1000 | Đạt |
| 20-workers-mixed-save-refresh-500-rows | GET | 498.3 | 2000 | Đạt |
| 20-workers-read-500-rows-3-times | GET | 526.3 | 2000 | Đạt |
| 20-workers-mixed-save-refresh-5000-rows | PATCH | 349.7 | 1000 | Đạt |
| 20-workers-mixed-save-refresh-5000-rows | GET | 4294.3 | 2000 | Không đạt |
| 20-workers-read-5000-rows-3-times | GET | 4568.8 | 2000 | Không đạt |

## Tài nguyên và điểm nghẽn

- 20 SSE đứng yên trong khoảng 9 giây tạo 69 truy vấn, tương đương 7.7 query/s. Đây là số đo; cơ chế heartbeat hiện tại gồm 20 renew + 3 truy vấn roster/revision mỗi 3 giây.
- RSS cao nhất toàn harness 923.0 MiB. Không thể lấy số này làm RAM tối thiểu production: gồm engine WASM DB, client buffer/parse và server; sample 25 ms có thể bỏ lỡ peak khi event loop bị chặn. Không có kết luận leak/OOM hay dự báo chi phí hosting.
- Snapshot 5.000 dòng khoảng 3.0 MiB JSON chưa nén mỗi phản hồi. 20 người mỗi lượt tương đương khoảng 60.3 MiB; đây là body bytes, không gồm TLS/header/compression.
- GET list đọc tất cả purchase_orders; frontend phân trang không làm giảm payload API. Revision nhẹ giúp tránh snapshot khi không thay đổi, nhưng thay đổi liên tục vẫn gây tải lại nhiều dữ liệu.
- Mọi mutation lấy cùng pg_advisory_xact_lock và khóa purchase_settings: trong PostgreSQL thật, các lần lưu cũng tuần tự theo transaction; DB/network chậm sẽ kéo dài hàng chờ. Pool mặc định trong code là 7, không xác nhận số connection đang cấu hình trên production. Không tăng pool một cách máy móc vì không bỏ được khóa chung.
- CPUOneCorePct và eventLoopP95Ms chi tiết nằm trong JSON. CPU có thể >100% vì tính theo một core và có luồng của engine DB; độ trễ event-loop không phải FPS browser. DB wait trong adapter không đại diện wait pool PostgreSQL.

## Ưu tiên tiếp theo trước nghiệm thu production

1. Giảm dữ liệu tải lại: API thay đổi theo revision hoặc phân trang phía server, tránh 20 client nhận toàn bộ 5.000 dòng sau thay đổi nhỏ; giữ baseline/conflict hiện tại.
2. Đo lại với PostgreSQL staging cách ly và cấu hình web giống triển khai, bật/tắt integration, nhiều connection thực; đo lock wait, pool wait, server CPU/RSS tách khỏi driver, DB latency và response compression.
3. Kiểm tra 20 browser độc lập với scheduler thật, bản nháp/selection/undo, hội tụ dữ liệu hiển thị, mất mạng/kết nối lại. Chạy soak và tải theo nhịp cố định để xác định backlog, không chỉ vòng kín.

## Chạy lại và bằng chứng

Từ gốc repo: node server/scripts/purchase-load-20.cjs. Không dùng DB_URL cấu hình. JSON: .codex_tmp/purchase-load-20-results.json; stdout: .codex_tmp/purchase-load-20-run.log (hai artifact tạm có thể bị ghi đè khi chạy lại). Script: server/scripts/purchase-load-20.cjs. Exit 0 đạt toàn bộ; 2 chức năng đạt nhưng capacity gate không đạt; 1 lỗi chạy/assertion. Report cũ bị vô hiệu hóa thành running/failed khi bắt đầu hoặc thất bại.

Review độc lập đã kiểm tra giới hạn PGlite, SSE counter, capacity gate, stale report, phân tách thời gian PATCH/GET; các điểm liên quan đã xử lý hoặc ghi rõ giới hạn. graphify chưa có trong PATH nên không tạo được dependency graph mới. Không sửa file runtime/tính năng trong lượt thử tải.
