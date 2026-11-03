# Benchmark cục bộ — 03/11/2026

Lệnh trong `server/`: `node scripts/benchmarkPicking.js --baseline=439fdab5 --latency-ms=2`.

PGlite cục bộ, transaction tuần tự, 5 người dùng giả lập, mỗi mẫu gọi candidates rồi assign. Mỗi truy vấn thêm 2ms độ trễ giả lập. So sánh mã trước thay đổi với bản tối ưu. Mỗi case chỉ 5 mẫu; đây là phép đo minh họa chi phí round-trip, KHÔNG phải p95 production, Redis cold/warm hoặc thời gian trình duyệt/máy in.

| Dòng | Lượt | p50 trước/sau (ms) | p95 trước/sau (ms) | SQL trước/sau (5 người) | INSERT dòng trước/sau |
|---|---|---:|---:|---:|---:|
| 1 | Đầu | 1454 / 1161 | 1551 / 1252 | 75 / 75 | 5 / 5 |
| 1 | Lặp | 1424 / 1164 | 1452 / 1217 | 75 / 75 | 5 / 5 |
| 20 | Đầu | 2761 / 1185 | 2800 / 1251 | 170 / 75 | 100 / 5 |
| 20 | Lặp | 2785 / 1180 | 2815 / 1248 | 170 / 75 | 100 / 5 |
| 100 | Đầu | 15098 / 1151 | 15167 / 1198 | 570 / 75 | 500 / 5 |
| 100 | Lặp | 10728 / 1199 | 10761 / 1265 | 570 / 75 | 500 / 5 |

Không dùng bảng này để giảm cấu hình web hoặc xác nhận đạt SLO. Cần benchmark staging với PostgreSQL/Redis thật và browser (1/20/100 dòng, cold/warm, concurrency5), rồi theo dõi production 48h sau cutover.
