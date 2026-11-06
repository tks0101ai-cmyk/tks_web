# Thu mua — phát hành qua GitHub PR

## Bản phát hành đầu tiên

Route /thu-mua/dat-hang/, API /api/purchase-orders, sidebar/phân quyền và bộ công thức được đưa lên bằng branch feat/purchase-module → PR → kiểm tra → merge main. Render triển khai tự động theo cấu hình hiện tại; không sửa Render dashboard, credentials, worker hay nguồn Kiot.

Ứng dụng khởi tạo riêng 0110_purchase_orders.sql, 0111_purchase_operations.sql, 0112_purchase_requests.sql và 0113_purchase_freight.sql trước khi nhận HTTP. Chỉ bốn file này được chạy, trong một transaction có advisory lock dùng chung với ghi cont; migration đã có được bỏ qua. Lỗi khởi tạo rollback và không chặn các module khác; API Thu mua trả 503 nếu chưa có schema. Không chạy toàn bộ pending migrations khi startup. Số 0101–0109 đã dùng trên main và không được thay đổi.

Nguồn ghi vẫn là Sheets (purchase_settings.source_mode='sheets') sau khởi tạo. Bản phát hành không seed, không chuyển nguồn, không xóa read models hiện có, không tăng tồn kho. Trang hiển thị rõ chưa bật ghi; dữ liệu canonical chỉ có sau bước nạp nguồn được đối soát. Đây là phát hành module, không phải xác nhận chuyển dữ liệu nghiệp vụ.

## Nạp dữ liệu và bật ghi — bước riêng

1. Sao lưu database hoặc ít nhất các bảng product_container_lines, product_container_sync, product_container_expected, product_container_expected_state và toàn bộ purchase_* / product_containers nếu đã có dữ liệu; ghi nhận phiên bản nguồn. Backup code Git không thay thế backup database.
2. Chốt snapshot Sheet, chuẩn hóa đủ cột theo purchase-columns.js; ánh xạ cont/khóa dòng/ngày giờ/NV legacy. Không nhập dữ liệu thử của mockup vào production; không tự ghép tên nhân viên trùng.
3. Nhập thử bản canonical và xuất snapshot theo dạng {rows,containers}. Chạy node purchaseOrders/purchaseOrdersReconcile.js sheet-snapshot.json web-snapshot.json; xử lý tất cả lỗi dữ liệu gốc. Chênh lệch do công thức cước mới phải được giải thích riêng, không ghi đè cước cũ một cách âm thầm.
4. Chỉ khi số liệu đã được kiểm và có backup phục hồi mới chuyển source_mode sang web. Web và job Sheet dùng chung advisory lock 20531015; job Sheet dừng ghi khi source web. Từ đó canonical project hai read models trong cùng giao dịch.
5. Cấp quyền Thu mua cho nhân viên qua cơ chế phân quyền hiện có và kiểm hai tài khoản. Mặc định chỉ Quản lý thấy/sửa module. Không có API công khai chuyển nguồn hoặc nhận secret.

## Kiểm sau merge

- Kiểm GitHub Actions tại đúng SHA đã merge. CI thành công không phải bằng chứng Render đã deploy.
- Mở https://tokosi.onrender.com/thu-mua/dat-hang/ bằng tài khoản được phép; kiểm sidebar, nguồn dữ liệu, bộ lọc cá nhân, số liệu và log.
- Kiểm Vòng đời đơn hàng/Dự kiến hàng về tiếp tục dùng nguồn cũ khi chưa cutover.
- Người dùng quản lý Render thực hiện nếu cần xác minh migration/log runtime; agent không thao tác dashboard theo yêu cầu người dùng.

## Phục hồi

Trước cutover: revert PR code hoặc deploy commit main trước merge; để nguyên các bảng mới chưa dùng, không chạy DROP TABLE. Các read models cũ không bị thay đổi bởi lần khởi tạo schema.
Sau cutover: khóa ghi mới, xuất toàn bộ thay đổi web và audit, đối soát rồi mới phục hồi backup/chọn lại nguồn. Không chỉ đổi cờ về Sheets vì job có thể thay read models và làm mất dấu thay đổi mới. Không xóa dữ liệu/lịch sử bất biến khi rollback.

Code mockup và fixture thử dữ liệu nghiệp vụ không nằm trong PR production. Bản sao code trước ghép được giữ cục bộ ở .codex_tmp/purchase-pr-backup-2026-11-05T02-50-06-076Z, không đưa lên repository.

## Nạp bản chụp nguồn (06/11/2026)

`node purchaseOrders/importSourceRows.js <file.json> [--replace] [--dry-run] [--year=2026]` chỉ chạy khi `purchase_settings.source_mode` còn là `sheets`, và chỉ khi `purchase_orders` rỗng (trừ `--replace`).

Thứ tự kiểm bắt buộc sau mỗi lần nạp:

1. `--dry-run` trước: đọc mục `anomalies`. `reason='NGAY_KHONG_TON_TAI'` là ô ngày không tồn tại trong lịch (bộ đọc không tự cuộn sang tháng sau), ô có hai ngày dính nhau thì lấy ngày đầu. Mỗi ô báo ở đây phải được quyết định bằng tay trước khi nạp thật.
2. Lệnh nạp thật trả thêm `keySeq` — giá trị `purchase_order_key_seq` sau khi nạp. Phải lớn hơn hoặc bằng khóa gốc lớn nhất trong `purchase_orders`; nếu không, khóa cấp tiếp theo cho dòng mới sẽ trùng dòng đã có. Kiểm lại bằng `SELECT last_value FROM purchase_order_key_seq` và `SELECT max(split_part(row_key,'.',1)) FROM purchase_orders`. `setval` dùng `GREATEST` nên không bao giờ kéo sequence lui, kể cả khi nạp bản chụp cũ hơn.
3. Nếu lệnh dừng với `CONTAINER_NAME_AMBIGUOUS`: trên DB đang có hai cont mà tên chuẩn hóa về một (`containerNames.normalizeName`). Không ghi dòng nào. Gộp hoặc đổi tên hai cont đó trước, rồi nạp lại — script không tự gộp vì mỗi cont có thể đang giữ dòng khác nhau.
4. Cont đã có trên DB được dùng lại theo tên chuẩn hóa và `name_key` được đưa về chuẩn; không tạo bản trùng.

Chỉ sau khi ba bước trên sạch mới tới bước đối soát (`purchaseOrdersReconcile.js`) và đổi nguồn ghi.
