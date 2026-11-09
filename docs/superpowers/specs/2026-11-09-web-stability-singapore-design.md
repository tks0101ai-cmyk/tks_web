# Ổn định web production và chuyển web sang Render Singapore

Ngày: 09/11/2026 · Trạng thái: đã duyệt thiết kế, chờ duyệt bản viết · Hướng: C (sửa nhanh trước, chuyển vùng sau)

## 1. Bối cảnh và số đo

Số liệu đo thật ngày 09/11/2026 (Render API + Supabase, chỉ đọc), khoảng 02–09/11:

| Hạng mục | Số đo | Đánh giá |
|---|---|---|
| Web `tokosi` (Oregon, gói Pro 2 lõi / 4 GB từ chiều 06/11; trước đó 1 lõi / 2 GB) | CPU p95 0,17 lõi, cao nhất 0,7; RAM trung vị ~540 MB, đỉnh 1,77 GB | Dư phần cứng |
| Worker `tks_web_worker` (Singapore, 0,5 lõi / 512 MB) | RAM ban đêm 440–472 MB | Sát trần |
| Hàng chờ pool DB của web (`poolWaiting`, `PG_POOL_MAX=4`) | 07/11 tối đa 664; 09/11 lúc 09:5x tối đa 56 | Nghẽn |
| API chậm 09/11 07:50–10:00 | `GET /api/product-report` 524 lượt, trung bình 3,9 s, tối đa 48 s; `containers/meta` trung bình 4,2 s; Vòng đời / Nhặt hàng 2,5–4,5 s | Chậm |
| Deploy | 83 lần trong 8 ngày, 75 lần trong giờ làm; mỗi lần khởi động lại cả web lẫn worker | Gây nghẽn sau mỗi deploy |
| Supabase | DB 1,3 GB, 228 bảng, tỉ lệ đọc trúng cache 98%, tỉ lệ dòng chết thấp; `max_connections` 60; Supavisor session mode `pool_size` 15 | Ổn |
| Độ trễ | Web Oregon ↔ Supabase Singapore ~175 ms mỗi vòng; máy VN ↔ Supabase 41–45 ms; VN → VPS netcup Nuremberg 275 ms | Nút thắt chính |

Kết luận: nghẽn nằm ở đường nối web ↔ DB (độ trễ cao × pool 4 kết nối), không phải CPU/RAM.

### Nguyên nhân cụ thể đã xác minh trong code

1. **Deploy trong giờ làm, kể cả commit chỉ sửa tài liệu**: cache nguội, mọi tab kết nối lại cùng lúc, có lúc vượt giới hạn 15 kết nối (EMAXCONNSESSION ngày 07/11).
2. **Kiểm kê** (`server/public/stocktake/stocktake.js`, `stocktakeGrid.js`): mỗi lần ghi ô phát SSE `stocktake-changed`, mọi tab tải lại cả bảng (1–2 MB, ~8 truy vấn). `trailingThrottle` không chờ lượt trước xong. (Máy chủ đã gộp lượt `getBoard` trùng từ commit `4a8b87a1` ngày 07/11 — khóa `board:<id>:<version>` + `invalidateSession`.)
3. **Nút "Cập nhật đơn Kiot"** (`stocktakeOrderRefresh.js`) đã có chặn: mỗi cơ sở 1 lượt cùng lúc + nghỉ 15 s. Nhưng khi có đơn mới nó phát `stocktake-changed`, kéo theo vấn đề số 2.
4. **Bot Telegram duyệt nghỉ phép** (`server/telegram/managerLeaveRuntime.js`, chạy trên web, chu kỳ 5 s): `seedBacklog` đọc lại đơn chờ và `enqueueDelivery` upsert lại mọi cặp (đơn, quản lý) mỗi lượt, khoảng 2,3 lần ghi/giây (8,7 triệu lần từ 13/09), dù 0 tin chờ gửi.
5. **Không giới hạn tải theo người dùng** cho API nặng (chỉ có giới hạn ở quên mật khẩu / đổi liên hệ).
6. **Worker** lên 440–472 MB / 512 MB ban đêm; `--max-old-space-size=400`.

### Bảng tính sẵn có gây rác dữ liệu không

- Dung lượng: ~36 bảng tính sẵn chiếm ~160 MB / 1,3 GB; autovacuum dọn tốt. Phần lớn dung lượng là cột `raw` JSON của KiotViet (~330 MB ở `orders`, `order_details`, `invoices`, `cash_flows`).
- Rủi ro thật là **dòng cũ sai số liệu** khi nguồn bị hủy (ví dụ TVPAMS -3750, sửa ở nhánh `fix/rollup-stale-product-sales`).
- Ghi lặp từng rất lớn (`daily_product_sales` 115 triệu lần cập nhật), nay đã chỉ ghi khi đổi (`IS DISTINCT FROM`).
- Quyết định: giữ cách tính sẵn; mỗi bảng tính sẵn phải có bước xóa dòng không còn trong kết quả mới.

### Vì sao không chuyển sang VPS `v2202610335927535769.nicesrv.de`

VPS là netcup Nuremberg (Đức). Đức ↔ Singapore cũng ~160–180 ms, không giải nút thắt; người dùng VN chịu 275 ms; nhóm phải tự lo backup, TLS, bảo mật, giám sát. Thay vào đó tạo web Render ở Singapore (cùng vùng DB).

## 2. Mục tiêu và tiêu chí thành công

- Một tuần làm việc bình thường sau giai đoạn 1: `poolWaiting` ≤ 10 mọi mẫu `[Performance]`.
- Bot nghỉ phép ghi `hr_leave_manager_messages` < 100 lần/giờ khi không có đơn mới.
- Không có 429 báo nhầm (người dùng thao tác bình thường không gặp).
- Sau giai đoạn 2: trung bình `GET /api/product-report` < 1 s trong giờ cao điểm; không mất webhook KiotViet/Telegram.
- Worker đỉnh RAM < 400 MB, hoặc đã nâng gói.

Ngoài phạm vi: chuyển DB, đổi Supavisor sang transaction mode, VPS/Docker, chạy nhiều instance web.

## 3. Giai đoạn 0 — dọn nhanh (cấu hình + merge) — ĐÃ LÀM 09/11/2026

1. **Render Build Filters** cho web và worker: `paths` = `server/**`; `ignoredPaths` = `server/**/*.md`, `server/**/*.test.js`, `server/test/**`. Đã xác minh: dù `rootDir=server`, commit chỉ sửa `graphify-out/` (ví dụ `ec2c5c8a`, `02e448ae`) vẫn deploy; commit chỉ sửa `server/README.md` (`329919e7`) hay test (`c08e183b`) cũng deploy. Commit có code vẫn tự deploy như cũ (giữ khả năng sửa nóng trong giờ).
   Thêm **Health Check Path** `/health` cho web (hiện để trống): Render chỉ chuyển lưu lượng sang bản mới khi bản mới trả lời được.
2. Bản sửa `fix/rollup-stale-product-sales` (commit `1ea0f25a`) đã nằm trên `main`: chỉ kiểm lại TVPAMS = 150 − 1950 trong `daily_product_sales` (chỉ đọc).
3. **Xóa biến thừa**: chỉ `DATABASE_URL` trên web và worker (trỏ Render Postgres đã xóa). **Giữ `KIOTVIET_SYNC_ENABLED=true` trên web**: web vẫn đọc biến này — `server/kiotviet/kiotvietWebhookRoutes.js` dùng nó để bật các route webhook KiotViet, `server/cashbook/cashbookRepository.js` dùng nó cho trạng thái đồng bộ sổ quỹ. (Ban đầu spec định xóa biến này khỏi web; đã xóa nhầm và khôi phục ngay trước mọi deploy.)

## 4. Giai đoạn 1 — sửa code (mỗi mục 1 PR, viết test trước)

### 1.1 Kiểm kê: tải lại bảng

- **Trình duyệt**: `trailingThrottle` nhận `run` trả về Promise; không lên lịch lượt mới khi lượt hiện tại chưa xong. Tín hiệu đến trong lúc chạy → đánh dấu và chạy đúng 1 lượt sau khi xong, vẫn tôn trọng khoảng cách `RELOAD_GAP_MS`.
- **Máy chủ**: không đổi (đã gộp trên `main`).
- Tải nền gặp 429 (mục 1.3) thì lặng lẽ hẹn lại một lượt qua throttle, không hiện lỗi.
- Test: throttle không chồng lượt khi `run` chậm; tín hiệu đến lúc đang chạy → đúng 1 lượt sau.

### 1.2 Bot Telegram duyệt nghỉ phép

- `seedBacklog` chạy lúc khởi động rồi 10 phút/lần (hằng số cấu hình được), không chạy mỗi 5 s. Đơn mới vẫn đi qua hàng sự kiện (`claimEvents` → `processEvent`) nên không chậm thông báo.
- `enqueueDelivery`: `ON CONFLICT ... DO UPDATE ... WHERE hr_leave_manager_messages.desired_version < EXCLUDED.desired_version`; không đổi thì không ghi.
- Hệ quả chấp nhận: quản lý mới được gán Telegram nhận các đơn chờ cũ trễ tối đa 10 phút; nơi gọi hiện không dùng giá trị trả về của `enqueueDelivery`.
- Test: hai lượt liên tiếp không đổi phiên bản → 0 lần cập nhật; phiên bản tăng → cập nhật; backlog chỉ chạy theo nhịp mới.

### 1.3 Giới hạn tải theo người dùng

- Middleware giới hạn **số request GET đang chạy cùng lúc**: mỗi người dùng × mỗi đường dẫn (số trong đường dẫn gộp thành `:id`) tối đa 4. Lý do không lấy 2/nhóm: trang Báo cáo hàng hóa gửi song song trang chính + 2 trang tải trước + `containers/meta` + `customer-growth`. Request thứ 5 → `429` `{ code: 'TOO_MANY_INFLIGHT', error: 'Đang xử lý yêu cầu trước, vui lòng chờ' }` + `Retry-After: 2`.
- Không tính kết nối SSE (đường dẫn kết thúc `/events`), vì chúng mở suốt phiên xem trang.
- Nhóm (theo tiền tố đường dẫn): Báo cáo hàng hóa `/api/product-report`; bảng Kiểm kê `/api/stocktake/sessions/:id/board` và `/order-status`; Vòng đời `/api/shipment/lifecycle`; Nhặt hàng `/api/shipment/pick`.
- Khóa người dùng lấy từ phiên đăng nhập (sau auth); không có thì theo IP thật (`trust proxy` đã cấu hình trong `index.js`).
- Bộ đếm trong bộ nhớ tiến trình (web chỉ chạy 1 instance). Trả suất khi handler gọi `res.end` (xử lý xong thật); trình duyệt hủy giữa chừng thì vẫn giữ suất tới khi handler xong, tối đa 120 s, để bấm làm mới liên tục không đè DB.
- Trình duyệt: các trang đã hiện `payload.error` nên câu báo 429 tự hiện; tải trước trang lân cận đã bỏ qua lỗi; riêng Kiểm kê xử lý tải nền như mục 1.1.
- Test: 5 request song song cùng người cùng đường dẫn → 1 bị 429; khác người hoặc khác đường dẫn không ảnh hưởng; POST không bị giới hạn; client hủy thì suất giữ tới khi handler xong.

### 1.4 Worker

- Đọc log `[Memory]` của worker quanh 00:00–01:00 VN để xác định job làm RAM tăng; sửa job đó theo hướng đọc/ghi theo lô thay vì nạp toàn bộ.
- Nếu sau sửa đỉnh vẫn > 400 MB: nâng worker lên Standard (1 lõi / 2 GB, $25). Render không có gói 1 GB.

## 5. Giai đoạn 2 — chuyển web sang Singapore + tên miền

Tên miền: mua `.com` (Cloudflare Registrar hoặc nhà đăng ký VN), dùng subdomain `app.<ten>.com`. Không giữ được `tokosi.onrender.com` cho service mới (service cũ còn tồn tại; tài liệu Render không cam kết lấy lại subdomain đã xóa).

Hai webhook bên ngoài phải đăng ký lại: KiotViet (`/api/kiotviet/webhook/<secret>`, cả 2 cơ sở) và Telegram (`/api/telegram/manager-leave/webhook`).

### Chuẩn bị (trong giờ, không ảnh hưởng người dùng)

1. Mua tên miền; CNAME `app.<ten>.com` → `tokosi-sg.onrender.com` (Cloudflare: DNS only).
2. Tạo web service `tokosi-sg`, vùng Singapore, gói Pro, repo/nhánh `main`, cùng build/start command. Chép biến môi trường từ `tokosi`, trừ khi chạy thử:
   - `PG_POOL_MAX=2` (ngân sách: Oregon 4+1, SG 2+1, worker 2 = 10 < 15).
   - `HR_MANAGER_TELEGRAM_ENABLED=false`, `HR_LEAVE_DB_REALTIME_ENABLED=false`, `SPECIAL_DAYS_NOTIFY_ENABLED=false`, `VAT_REQUEST_NOTIFY_ENABLED=false`, `HR_LEAVE_BELL_NOTIFY_ENABLED=false`, `PICK_KIOT_RECONCILE_ENABLED=false`.
   - Trong thời gian chạy song song, không deploy `main` dồn dập (mỗi deploy có 2 web cùng khởi động lại).
3. Gắn custom domain cho `tokosi-sg`, chờ TLS. Thêm origin mới vào Google OAuth (giữ origin cũ).
4. Chạy thử trên tên miền mới bằng tài khoản thật, chỉ đọc: đăng nhập, Tổng quan, Báo cáo hàng hóa, Vòng đời, Kiểm kê. Đo `[timing]` để so với Oregon.
5. PR riêng thêm `server/redirect.js`: server Node thuần, không đọc DB; GET/HEAD → 302, phương thức khác → 307 (không dùng 301/308 vì trình duyệt nhớ vĩnh viễn, cản quay lui), tới `REDIRECT_TO` + đường dẫn + query giữ nguyên; `/health` trả 200.

### Chuyển đổi (ngoài giờ, ~30 phút, báo nhóm ngừng deploy)

1. Lưu bản sao biến môi trường và start command của `tokosi` (Oregon).
2. Oregon: tắt autoDeploy; Start Command `node redirect.js`; xóa `SUPABASE_DB_URL`; đặt `REDIRECT_TO=https://app.<ten>.com`. Oregon ngừng mọi job và kết nối DB.
3. `tokosi-sg`: bật lại 6 cờ job (xóa các biến `=false` ở trên), `PG_POOL_MAX=4`, `HR_MANAGER_TELEGRAM_WEB_URL=https://app.<ten>.com`.
4. Đăng ký lại webhook: `npm run telegram-manager:set-webhook` (với URL mới); webhook KiotViet cả 2 cơ sở sang `https://app.<ten>.com/api/kiotviet/webhook/<secret>`.
5. Kiểm tra: đăng nhập; chuông thông báo; Kiểm kê cập nhật trực tiếp giữa 2 tab; log có webhook KiotViet; bấm duyệt trên Telegram; `poolWaiting` sau 15 phút.
6. Hạ Oregon xuống Starter ($7).

**Quay lui**: Oregon khôi phục start command `npm start` + biến môi trường đã lưu; tắt 6 cờ job trên `tokosi-sg`; đăng ký webhook về địa chỉ cũ.

**Ảnh hưởng người dùng**: đăng nhập lại 1 lần (phiên lưu theo origin; `JWT_SECRET` giữ nguyên). Cài đặt cột theo tài khoản lưu trên máy chủ nên không mất; tùy chọn chỉ lưu `localStorage` (theo trình duyệt) sẽ về mặc định.

**Chi phí**: Render tính theo giây, gói $85 không mất; chạy song song 1–2 ngày tốn thêm ~$3–6.

## 6. Giai đoạn 3 — đo lại và tối ưu chi phí (sau 1–2 tuần)

- So `poolWaiting` và `[timing]` theo endpoint với số đo mục 1.
- RAM đỉnh `tokosi-sg` < 1,2 GB → hạ xuống Standard (1 lõi / 2 GB, $25).
- Sau 1–2 tháng, log Oregon không còn lượt chuyển hướng → xóa service Oregon.

## 7. Rủi ro

| Rủi ro | Giảm thiểu |
|---|---|
| Hai web cùng chạy job (Telegram, chuông, lịch báo) | 6 cờ tắt trên SG cho tới khi Oregon chuyển sang redirect |
| Vượt 15 kết nối Supabase khi chạy song song | SG `PG_POOL_MAX=2` khi thử; Oregon về 0 kết nối khi chuyển |
| Mất webhook KiotViet trong lúc chuyển | Redirect 307 làm dự phòng; sync định kỳ của worker vẫn quét lại đơn |
| Giới hạn tải chặn nhầm | Giới hạn GET đang chạy (4/người/đường dẫn), không theo số lượt/phút; theo dõi log `[inflightLimit]` tuần đầu |
| Throttle mới làm Kiểm kê chậm cập nhật | Lượt kế chạy ngay khi lượt trước xong nếu đã quá `RELOAD_GAP_MS`; test hồi quy |

Cập nhật gần nhất: 10/11/2026.
