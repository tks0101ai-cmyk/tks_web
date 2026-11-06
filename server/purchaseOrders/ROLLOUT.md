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

## Dọn dữ liệu đã nạp bằng bản cũ (06/11/2026 — ĐÃ CHẠY trên production)

552 dòng trên production được nạp bằng bản `importSourceRows.js` trước khi có hai bản sửa dưới đây, nên dữ liệu mang đúng hai lỗi đó. Đã chạy trên production ngày 06/11/2026 và xác minh; ghi lại để biết vì sao, và để chạy lại nếu có môi trường khác nạp bằng bản cũ.

**1. Sequence khóa dòng.** `purchase_order_key_seq` còn ở `last_value=1` trong khi khóa gốc lớn nhất là `D00552`. Hệ quả: bấm **Thêm mã** sẽ lấy khóa `D00001` đã tồn tại, `claimKey` từ chối với `ROW_KEY_UNKNOWN`, và **không tạo được dòng mới nào**.

```sql
SELECT setval('purchase_order_key_seq', GREATEST(
  (SELECT last_value FROM purchase_order_key_seq),
  COALESCE((SELECT max(replace(split_part(row_key,'.',1),'D','')::bigint) FROM purchase_orders), 0)
));
```

`GREATEST` nên câu này không bao giờ kéo sequence lui; chạy lại nhiều lần vô hại. Kiểm: `SELECT last_value FROM purchase_order_key_seq` phải >= khóa gốc lớn nhất.

**2. `name_key` của cont.** Bản nạp cũ dùng `lower(btrim(name))`, khác hàm `containerNames.normalizeName` mà mọi đường ghi của web dùng. Hệ quả: `UNIQUE(name_key)` không chặn được cont trùng tên — tạo cont `CONT BẾP GA` sinh khóa `CONTBẾPGA`, không đụng `cont bếp ga` đang có, ra hai cont cùng tên.

```sql
UPDATE product_containers c
   SET name_key = upper(replace(regexp_replace(btrim(c.name), '\s+', '', 'g'), '.', '-'))
 WHERE c.name_key <> upper(replace(regexp_replace(btrim(c.name), '\s+', '', 'g'), '.', '-'))
   AND NOT EXISTS (SELECT 1 FROM product_containers x
                    WHERE x.id <> c.id
                      AND x.name_key = upper(replace(regexp_replace(btrim(c.name), '\s+', '', 'g'), '.', '-')));
```

Điều kiện `NOT EXISTS` để không bao giờ vấp `UNIQUE`: cont nào chuẩn hóa ra khóa đã có người giữ thì **bị bỏ lại** chứ không làm câu lệnh thất bại. Kiểm sau khi chạy: số cont còn lệch phải bằng 0.

```sql
SELECT count(*) FROM product_containers
 WHERE name_key <> upper(replace(regexp_replace(btrim(name), '\s+', '', 'g'), '.', '-'));
```

Nếu số đó vẫn > 0 thì có cont trùng tên sau chuẩn hóa: gộp hoặc đổi tên tay rồi chạy lại. Không migration nào làm việc này, vì áp tự động lúc startup mà vấp dữ liệu thật thì làm hỏng lượt khởi tạo schema.

**Không cần chạy `purchase:sample:remove`** trên production: đã kiểm, không có dòng mẫu `D90001`–`D99999` nào.

### Các lỗi dữ liệu còn lại, cần bản deploy mới

- **11 dòng VC trước âm** đã lưu được trong DB (vì `0114`/`0115` đã áp) nhưng bản đang chạy vẫn chặn ở hàm tính tiền và kiểm Excel, nên Tổng tệ của các dòng đó hiện trống và sửa ô khác trên dòng đó bị từ chối. Bản sửa nằm trong `purchase-calculations.js` — cần deploy.
- **2 dòng thiếu ngày lên list.** Nhập tay trên web sau khi bật ghi.

## Bật chức năng ở chế độ cách ly (06/11/2026)

Thứ tự bắt buộc. Đổi cờ TRƯỚC khi deploy mã mới là sai: bản cũ không biết `integration_enabled`, nên `source_mode='web'` sẽ dừng job đọc Sheet và đẩy projection sang read model dùng chung.

1. **Merge và deploy trước.** `ensurePurchaseSchema` tự áp `0110`–`0117` lúc web startup; kiểm log có `[Purchase] Initialized … 0117_purchase_isolated_workflow.sql`, hoặc:

   ```sql
   SELECT filename FROM schema_migrations WHERE filename LIKE '011%_purchase%' ORDER BY 1;
   ```

2. **Xóa dữ liệu mẫu seed** (các dòng `D90001`–`D99999` và cont `MẪU — `), chạy trên máy chủ có `SUPABASE_DB_URL`:

   ```bash
   npm run purchase:sample:remove
   ```

3. **Bật ghi, giữ cách ly.** Một câu, hai cờ, để không có khoảng thời gian nào `web` mà chưa cách ly:

   ```sql
   UPDATE purchase_settings SET source_mode='web', integration_enabled=false WHERE id=1;
   ```

4. **Xác minh ngay sau khi bật** — ba điều phải đúng:

   | Kiểm | Kỳ vọng |
   |---|---|
   | Mở `/thu-mua/dat-hang/` | Bảng báo `CÁCH LY · …`; các nút Thêm mã / Lưu / Import mở |
   | Sửa một ô rồi lưu | Dòng đổi thật, Nhật ký có bản ghi, và `SELECT count(*) FROM product_container_lines WHERE sheet_name='THU MUA'` **không tăng** |
   | Log job cont sau 10 phút | Vẫn có lượt đọc Sheet (không phải `web-source`); Dự kiến hàng về không đổi số |

5. **Khi nào mới bật `integration_enabled=true`:** sau khi bản chụp nguồn đã đầy đủ và đã đối soát (`purchaseOrdersReconcile.js`). Bật cờ này làm job đọc Sheet dừng hẳn và Thu mua tiếp quản read model — không còn là bước thử nghiệm.

### Quay lui

Chỉ cần một câu, hiệu lực ở lượt ghi tiếp theo, không mất dữ liệu đã nhập:

```sql
UPDATE purchase_settings SET source_mode='sheets' WHERE id=1;
```

Trang Thu mua trở lại chỉ xem, job đọc Sheet vẫn chạy như trước. Dữ liệu và lịch sử đã ghi được giữ nguyên (audit của Thu mua là bất biến).

### Dọn schema dùng thử (không bắt buộc)

Chế độ dùng thử đã gỡ khỏi mã nguồn nên schema `purchase_trial` không còn nơi nào đọc; để lại cũng vô hại. Muốn dọn thì chạy tay, sau khi đã deploy bản không còn `purchaseOrdersTrial.js`:

```sql
DROP SCHEMA IF EXISTS purchase_trial CASCADE;
```
