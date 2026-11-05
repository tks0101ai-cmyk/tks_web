# KiotViet Public API — Endpoint Reference (Phase 1)

> Tài liệu nguồn bắt buộc theo `source-driven-development`: mọi entity sync module trong
> `server/kiotvietSync/entities/*.js` phải trỏ về đây thay vì đoán tham số từ trí nhớ.
> Không sửa file này dựa trên "tôi nghĩ API chắc hỗ trợ X" — chỉ sửa khi có bằng chứng mới
> (live probe hoặc tài liệu chính thức), và phải ghi lại nguồn.

## Auth

```
POST https://id.kiotviet.vn/connect/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<id>&client_secret=<secret>&scopes=PublicApi.Access
```

Nguồn xác thực hiện tại: `server/kiotviet/kiotVietApiClient.js` — cùng
implementation đã copy đúng vào `kiotVietApiClient.js:getAccessToken` (trích xuất từ
`server/dashboard/stockoutCheck/kiotVietClient.js`, đã di dời — không còn file cũ).

Response: `{ access_token, expires_in, token_type }`. `expires_in` thực tế ~3600s. Client cache
token, refresh khi còn ~60s trước hết hạn hoặc khi gặp `401`.

Mỗi chi nhánh (Hà Nội/Sài Gòn) là 1 tài khoản KiotViet riêng — lấy token riêng bằng
`KIOTVIET_CLIENT_ID`/`_SECRET` tương ứng, không dùng chung.

## Request chung cho mọi endpoint danh sách

```
GET https://public.kiotapi.com/{endpoint}?pageSize=100&currentItem=N&<query riêng entity>
Authorization: Bearer <access_token>
Retailer: <CHhanoi | CHsaigon>
```

Response: `{ total: number, data: [...] }`. Lặp `currentItem += pageSize` cho đến khi
`currentItem >= total` hoặc trang trả về rỗng (guard chống vòng lặp vô hạn nếu `total` sai).
Nguồn: `fetchAllPages()` trong `kiotVietApiClient.js`, hành vi giữ nguyên từ file gốc đã di dời
(`stockoutCheck/kiotVietClient.js`, xem lịch sử git nếu cần đối chiếu).

## Bảng endpoint từng entity

Cột "Tham số incremental" là tham số dùng để lọc theo `sinceIso` (checkpoint) — **đã xác minh
bằng live GET probe (chỉ đọc) ngày 2026-08-30 trên tài khoản Hà Nội thật**, phương pháp: so
sánh `total` khi gọi không filter vs. filter = một ngày trong tương lai (`2027-01-01T00:00:00`).
Nếu tham số được API tôn trọng, `total` phải về 0.

| Entity | Endpoint | `listQuery` cố định | Tham số incremental | Nguồn xác minh |
|---|---|---|---|---|
| categories | `/categories` | `hierachicalData=false` (đúng chính tả lỗi của KiotViet — không sửa) | `lastModifiedFrom` | Live probe: total 98→0. `modifiedFrom` bị thử và **không hoạt động** (total không đổi) — không dùng tên này. |
| products | `/products` | `includeInventory=true&includeQuantity=true&IncludeProductShelves=true&includeSoftDeletedAttribute=false` | `lastModifiedFrom` | Live probe: total 10378→0. Cấu hình hiện nằm trong engine `server/kiotvietSync/`. **Cập nhật 2026-09-18**: đã bỏ `includePricebook`/`IncludeSerials`/`IncludeBatchExpires`/`includeWarranties`/`includeMaterial` (có trong bản listQuery trước đây) vì làm `products.raw` phình lên ~35MB/13.949 dòng, làm chậm các câu JOIN với `products` — không có chỗ nào trong repo đọc các trường này. Xem ghi chú quyết định tại `server/kiotvietSync/entities/products.js`. Muốn dùng lại dữ liệu bảng giá theo kênh/serial/hạn dùng lô/bảo hành/vật liệu phải bật lại tham số tương ứng **và backfill lại toàn bộ `products`**. **Cập nhật 2026-10-29**: thêm đối soát đầy đủ mỗi 24 giờ (`orderBy=id&orderDirection=ASC`, `requireComplete`) và lượt tăng dần cũng sắp `orderBy=id` + chồng lấn 5 phút — xem mục "Phân trang `lastModifiedFrom`" bên dưới. `includeRemoveIds=true` được `/products` chấp nhận và trả khóa `removedIds` (mẫu rỗng), chưa được dùng. |
| customers | `/customers` | `includeTotal=true&includeCustomerGroup=true&includeCustomerSocial=true&includeRemoveIds=true`; lượt đầy đủ thêm `orderBy=id&orderDirection=ASC` | `lastModifiedFrom` | Live probe: total 5246→0. Metadata thực tế `removedIds` (hỗ trợ thêm `removeIds`/`removeId`); chuẩn hóa `raw.isActive`, đối soát đầy đủ lần đầu/mỗi 24 giờ và luôn quét đầy đủ trước bản chốt công nợ 15:00/nút Tính lại công nợ (21/10/2026). Kiểm 20/10/2026: thứ tự mặc định lặp ID tại ranh giới trang; sắp theo ID tăng dần trả đủ 5.741 ID HN + 2.428 ID SG, không trùng. Query `isActive=true/false` đã thử và bị API bỏ qua, không dùng làm bộ lọc trạng thái. **Cập nhật 2026-10-29**: lượt tăng dần cũng thêm `orderBy=id&orderDirection=ASC` và chồng lấn 5 phút (mặc định `/customers` sắp theo `modifiedDate`) — xem mục "Phân trang `lastModifiedFrom`". |
| ~~suppliers~~ | `/suppliers` | | | **Đã bỏ đồng bộ (migration `0026`)**: tab Nhà cung cấp không còn trên dashboard; tên NCC của phiếu nhập lấy từ `purchases.raw`. |
| invoices | `/invoices` | `includePayment=true&includeInvoiceDelivery=true&IncludeSaleChannel=true` | `lastModifiedFrom` | Live probe: total 23988→0. `fromPurchaseDate`/`toPurchaseDate` lọc theo *ngày bán*, không bắt được hóa đơn cũ bị **sửa**; dùng `lastModifiedFrom` cho checkpoint incremental. Line items nằm trong `InvoiceDetails[]`/`invoiceDetails[]` của cùng response. |
| orders | `/orders` | `includePayment=true&includeOrderDelivery=true` | `lastModifiedFrom` | **Live probe: `fromOrderDate` bị API bỏ qua hoàn toàn (total không đổi khi set = ngày tương lai) — khác giả định ban đầu trong PlanDB-Phase1-Spec.md §9.1.** `lastModifiedFrom` được xác nhận hoạt động (total 34972→0). Dùng `lastModifiedFrom`, không dùng `fromOrderDate`/`toOrderDate`. |
| returns | `/returns` | `includePayment=true` | `lastModifiedFrom` | Live probe: total 1348→0. Khớp cách `server/dashboard/stockoutCheck/stockoutEventLoader.js` đã gọi `client.fetchAllPages('returns', { lastModifiedFrom: fromDate }, ...)` trong production. |
| purchases | `/purchaseorders` (**không phải** `/purchases`) | `includePayment=true&includeOrderDelivery=true` | Đối soát danh sách từ mốc sàn đứt hàng, dùng `fromPurchaseDate` | Probe 28/09/2026: `lastModifiedFrom` bỏ sót phiếu tạo lại giữ ngày nhập cũ (PN002517). Không dùng bộ lọc này để chứng minh dữ liệu đầy đủ. Xem phần đối soát cuối tài liệu. |
| order_suppliers | `/ordersuppliers` (**"Đặt hàng nhập"**, khác `/purchaseorders` = "Nhập hàng") | *(không có)* | **Không dùng** — đối soát toàn bộ danh sách mỗi lượt (`pollFullSnapshot`) | Live probe 2026-09-29 (tài khoản Sài Gòn thật): 348 phiếu; `lastModifiedFrom=2027-01-01` vẫn trả `total=348` ⇒ **bị API bỏ qua**. Mỗi phiếu có `id, code, orderDate, status, statusValue, supplierId, total, createdDate, orderSupplierDetails[]`, **không có `modifiedDate`**; dòng chi tiết `{productId, quantity, price, ...}` **không có `productCode`** (phải nối `products` theo `productId`). `status` 1 = "Đã xác nhận NCC", 3 = "Hoàn thành", 4 = "Đã hủy" (nhưng luôn lọc theo chuỗi `statusValue`). |
| cash_flows | `/cashflow` | `includeAccount=true&includeBranch=true&includeUser=true` | `startDate` + `endDate` (**`lastModifiedFrom` bị API bỏ qua** — live probe xác nhận total không đổi) | Gọi **2 lần**: `isReceipt=true` và `isReceipt=false`, gộp kết quả; cùng scope `PublicApi.Access`. |
| staff | *(không gọi endpoint riêng)* | — | — | Suy ra từ `SoldById`/`CreatedById`/`UserId`... trong response của invoices/orders/returns/purchases/cash_flows qua `staffSync.upsertStaffFromEntity()`. Quyết định giữ nguyên như spec dù `GET /users` đã xác nhận tồn tại (xem ghi chú bên dưới). |
| product_on_hands | `/productOnHands` (**endpoint chuyên ton kho, KHAC** `/products`) | *(không có — xem ghi chú bên dưới)* | `lastModifiedFrom` | Live probe 2026-09-23 (mã `010GDYE`, tài khoản Hà Nội thật): total 0 khi `lastModifiedFrom=2027-01-01` → tham số hoạt động đúng. |

## Nhóm polling trong `scheduler.js` (cập nhật 2026-10-05)

| Nhóm | Entity | Nhịp mặc định |
|---|---|---|
| fast | `invoices`, `orders`, `product_on_hands`, `product_on_hands_snapshot`, `order_suppliers` | 7 phút (`KIOTVIET_SYNC_FAST_INTERVAL_MS`); sau mỗi lượt chạy ngay rollup "nóng" 7 ngày |
| slow | `categories`, `products`, `customers`, `returns`, `purchases`, `cash_flows` | 20 phút (`KIOTVIET_SYNC_SLOW_INTERVAL_MS`) |

`staff` không có endpoint riêng (suy ra từ các entity trên) và `suppliers` đã bỏ khỏi scheduler (migration `0026`; file `entities/suppliers.js` chỉ còn lại như mã chết có test). Webhook KiotViet gọi `POST /api/kiotviet/webhook/<KIOTVIET_WEBHOOK_SECRET>` (secret nằm trên đường dẫn; sai → 404) và hiện **chỉ được lưu thô** vào `webhook_events_raw`, không upsert dữ liệu nghiệp vụ — nguồn dữ liệu thật là polling ở bảng trên.

## Phân trang `lastModifiedFrom` cho `/products` và `/customers` (thăm dò 2026-10-29)

Thăm dò chỉ đọc (GET, ~650 request, không gặp 429) trên cả hai cơ sở, nguyên nhân từ vụ `products` thiếu hàng sau sửa hàng loạt:

- **Không truyền `orderBy`**: duyệt đủ `total`, không trùng/thiếu, ổn định giữa 2 lần trên dữ liệu đứng yên. `/customers` mặc định sắp theo `modifiedDate` tăng dần (khớp 100%); `/products` mặc định không theo `id`/`modifiedDate`/`createdDate` (thứ tự cố định nhưng không rõ khóa). Rủi ro sót nằm ở dữ liệu ĐANG ĐỔI: dòng đã đọc bị sửa lại nhảy xuống cuối làm trang kế trượt một dòng, dòng bị trượt có `modifiedDate` cũ hơn checkpoint nên không bao giờ được đọc lại.
- **`orderBy=id&orderDirection=ASC` kết hợp được với `lastModifiedFrom`** ở cả 4 tổ hợp (HN/SG × customers/products): sắp `id` tăng dần đúng 100%, đủ `total`, không trùng, ổn định. `orderBy=modifiedDate` cũng được; `id` và `Id` đều chạy. Engine dùng `orderBy=id` cho cả lượt đầy đủ và lượt tăng dần của `customers`/`products`.
- **Cửa sổ `lastModifiedFrom` là bao gồm (`>=`)**, độ chính xác mili-giây (đo tại đúng `modifiedDate` của một dòng: tổng giảm khi lệch +1 ms). Chuỗi ISO có `Z` được hiểu là UTC thật và đổi sang giờ VN để so với `modifiedDate` KiotViet (giờ VN không kèm múi giờ), nên `toISOString()` trong `syncDriver` là đúng.
- **Lệch đồng hồ**: máy chạy nhanh hơn đồng hồ KiotViet khoảng 1,8–2,6 giây (header `Date`). Mốc checkpoint là giờ BẮT ĐẦU lượt chạy theo máy mình nên engine trừ thêm **5 phút** (`INCREMENTAL_OVERLAP_MS` trong `syncDriver.js`); upsert idempotent nên đọc lại vài dòng là rẻ.
- **Giá vốn (`inventories[].cost`) không làm đổi `modifiedDate`** (đo 05/11/2026 trên 33 mã lệch giá: DB khác KiotViet trong khi `modifiedDate` nhìn chung giống nhau). `/productOnHands` không trả `cost`. Danh sách `/products?includeInventory=true&orderBy=id&orderDirection=ASC` trả giá mới; quét toàn bộ HN ~45 giây (112 trang), SG ~11 giây. Entity `product_costs` dùng cách này mỗi 20 phút.
- **`/products` bản nhẹ**: bỏ `includeInventory`/`includeQuantity`/`IncludeProductShelves` thì `name`/`code`/`description`/`modifiedDate` giống 100% (payload nhẹ hơn ~25%, độ trễ HN 5,6 s → 0,6 s/trang) nhưng làm `raw` mất `inventories`/`productShelves` mà dashboard đang đọc. Đối soát hiện vẫn dùng `listQuery` đầy đủ và GIỮ `raw->'inventories'` có sẵn; muốn dùng bản nhẹ phải hợp nhất `raw`, không ghi đè.
- **`pageSize`**: `pageSize=500` thực tế bị cắt còn 200 dòng/trang; client cố định 100 và `requireComplete` đòi đủ 100 dòng mỗi trang (không phải trang cuối).
- **Bẫy cột `modified_date`**: DB lưu số giờ VN nhưng gắn nhãn UTC (lệch 7 giờ) vì cột `timestamptz` nhận chuỗi không có múi giờ; so với checkpoint (UTC thật) phải dùng `raw->>'modifiedDate'` hoặc cộng/trừ 7 giờ.
- **Số liệu đối chiếu DB 2026-10-29**: `products` thiếu 35 hàng HN + 10 hàng SG (cụm trùng `modifiedDate` của đợt sửa hàng loạt 22/10), 9 hàng HN đã xóa bên KiotViet mà DB còn; mô tả (`description`) của hàng đã có không lệch và sửa mô tả làm `modifiedDate` đổi. `customers` 0 sai lệch thật. Đã nạp bù và đánh dấu ngừng.

## Bổ sung 29/10/2026 — số Zalo trên phiếu in

Theo yêu cầu mới, phần phiếu nhặt đọc `/users` theo retailer để lấy `mobilePhone`, ghép `id` với `orders.sold_by_id`. Cache 5 phút, single-flight; lỗi chờ 30 giây trước thử lại; request tối đa 5 giây, một lần thử. Chỉ lưu số cần in vào snapshot mới; bản cũ bổ sung ở response, không sửa lịch sử. Không thay đổi thiết kế bảng staff hoặc checkpoint đồng bộ Phase 1.

## Ghi chú quan trọng: `GET /users`

Live probe xác nhận `GET /users` **tồn tại và trả dữ liệu thật** (status 200, `total=113` nhân
viên, tài khoản Hà Nội). `GET /employees` trả 404 (không tồn tại).

Đây là thông tin mới so với `PlanDB-Phase1-Spec.md §17.3` ("chưa xác minh KiotViet Public API
có endpoint Users/Employees không"). **Quyết định của chủ dự án (2026-08-30): giữ nguyên thiết
kế Phase 1 hiện tại** — không dùng `/users`, `staffSync.js` chỉ là helper suy luận, không có
checkpoint riêng. Việc này chỉ ghi lại ở đây để Phase 3 hoặc một cải tiến sau này có thể cân
nhắc dùng `/users` làm nguồn staff đầy đủ hơn (vai trò, SĐT, trạng thái hoạt động) — **không**
thay đổi phạm vi Phase 1.

## Ghi chú: `GET /productOnHands` — endpoint ton kho chuyen dung, doc lap voi `/products`

Live probe 2026-09-23 (mã `010GDYE`, tài khoản Hà Nội thật, dùng thẳng `fetchProductOnHand()` để
đối chiếu) phát hiện: Postgres (`products`, đồng bộ qua `lastModifiedFrom` trên `/products`) đang
kẹt `onHand=60` (`modified_date` KiotViet = 2026-09-22 08:53 giờ VN, tức bản ghi sản phẩm không
đổi từ lúc đó), trong khi thực tế trên KiotViet UI và `GET /products/code/010GDYE?includeInventory=true`
đều trả `onHand=0`. Nguyên nhân: `modifiedDate` của `/products` chỉ đổi khi đổi **thông tin sản
phẩm** (tên/giá/category...), không đổi khi chỉ có biến động tồn kho (chuyển kho, trả NCC...) —
nên `raw->'inventories'` có thể kẹt dữ liệu cũ vô thời hạn cho các mã như vậy.

`GET /productOnHands` (endpoint **chưa từng dùng ở đâu trong repo** trước bản này) giải quyết
đúng vấn đề này:
- `modifiedDate` của item trong response này cập nhật **độc lập** và **đúng lúc** có biến động
  tồn kho — xác nhận qua probe: tìm đúng mã `010GDYE` với `onHand=0` (đúng) và
  `modifiedDate=2026-09-23T08:38:28`, mới hơn hẳn `modified_date` kẹt ở `/products`.
- `lastModifiedFrom` hoạt động đúng (total 0 khi set tương lai `2027-01-01`).
- **KHÔNG hỗ trợ lọc theo `code`/`codes`** — tham số này bị API bỏ qua hoàn toàn, luôn trả toàn
  bộ danh sách theo trang. Vì vậy `listQuery` không có tham số cố định nào, chỉ dựa vào
  `lastModifiedFrom` + phân trang chuẩn.
- Payload mỗi item **nhẹ hơn nhiều** so với `/products`: `{id, code, createdDate, modifiedDate,
  inventories: [{branchId, onHand, reserved}]}` — không có tên/giá/category, phù hợp để poll tần
  suất cao (nhóm `fastEntities` trong `scheduler.js`) mà không tốn băng thông/dung lượng như
  `/products` đầy đủ.

Entity sync `product_on_hands` (`server/kiotvietSync/entities/productOnHands.js`) dùng checkpoint
riêng (khác `products`) và **chỉ `UPDATE` phần `raw->'inventories'`** của dòng `products` khớp
`(branch, id)` — không `INSERT` dòng mới, vì response thiếu name/code/giá (không đủ để tạo dòng
hợp lệ). Không tạo bảng riêng để không phải sửa lại các nơi đang đọc
`products.raw->'inventories'` (`stockoutPgSource.js`, `dashboardPgReader.js`,
`productReportRefresh.js`).

**Cập nhật 2026-09-29 — `lastModifiedFrom` của `/productOnHands` KHÔNG đủ để giữ tồn "thời gian thực".**
Đo trên DB thật: sau đợt làm mới, 0/47 mã Sài Gòn và 0/4 mã Hà Nội có hóa đơn mới được cập nhật tồn
(MCRY301 SG: DB `onHand=0`, KiotViet 2.250 rồi 2.100), trong khi checkpoint `product_on_hands` vẫn báo
thành công mỗi nhịp. Nghĩa là `modifiedDate` của endpoint này không bump theo bán/nhập hàng. Cách khắc phục:
- Entity `product_on_hands_snapshot` (`entities/productOnHandsSnapshot.js`): quét TOÀN BỘ `/productOnHands`
  (không lọc ngày) tối đa mỗi `KIOTVIET_SYNC_ONHAND_SNAPSHOT_INTERVAL_MS` (mặc định 10 phút; Hà Nội ~108
  request/lượt, Sài Gòn ~36), chạy trong nhóm fast; `syncDriver` bỏ qua khi lần trước còn mới và không chạy chồng.
- `productOnHands.upsertPage` nay GỘP theo `branchId` (giữ `cost`, `onOrder`... của `/products`, chỉ ghi đè
  `onHand`/`reserved`) và chỉ UPDATE dòng thực sự đổi. Bản cũ ghi đè cả mảng nên làm mất `cost` (Giá vốn) của
  6.786 dòng Hà Nội / 1.300 dòng Sài Gòn — phục hồi bằng một lượt đồng bộ lại `products` toàn bộ.

**Quyết định về `fetchProductOnHand()` (`kiotVietApiClient.js`, gọi `/products/code/{code}`):**
giữ lại nguyên trạng — hàm này hiện là dead code trong production (chỉ có test gọi), nhưng vẫn có
giá trị riêng: gọi API cho **đúng 1 mã tại 1 thời điểm** (đọc trực tiếp `/products/code/...`, không
qua `/productOnHands` vốn không lọc theo code), phù hợp cho một tính năng "làm mới tồn kho ngay
lập tức 1 mã cụ thể" sau này nếu cần — nay đã có `product_on_hands` lo phần poll hàng loạt định
kỳ nên không cấp thiết phải xóa hay nối dây hàm này ngay.

## Ghi chú cho `backfill.js`: không có tham số chặn trên (upper bound) cho orders/returns

Live probe 2026-08-30 xác nhận thêm: `lastModifiedTo` và `toModifiedDate` **đều bị API `/orders` và
`/returns` bỏ qua hoàn toàn** (thử kèm `lastModifiedFrom` đã có tác dụng, `total` không đổi khi thêm
tham số chặn trên). Nghĩa là 2 entity này **không có cách nào giới hạn cả 2 đầu ngày qua API** — khác
với `invoices`/`purchaseorders` (có `fromPurchaseDate`/`toPurchaseDate` chặn được cả 2 đầu, đã xác
minh production + live probe) và `cash_flows` (có `startDate`/`endDate`).

Hệ quả cho `backfill.js`: **không chia được theo tháng một cách an toàn** cho `orders`/`returns` —
chia "theo tháng" bằng `lastModifiedFrom=<đầu tháng>` sẽ luôn kéo từ đầu tháng đó **đến hiện tại**
(không bị chặn ở cuối tháng), khiến mỗi "tháng" thực chất tải lại gần như toàn bộ tập dữ liệu — vừa
không giảm được rủi ro trôi trang do phân trang offset-based (PlanDB.md §9) vừa lãng phí gấp nhiều
lần. `backfill.js` xử lý 2 entity này bằng **1 lượt chạy đầy đủ duy nhất** (`lastModifiedFrom = --from`),
chấp nhận rủi ro trôi trang trên tập lớn như một rủi ro tồn dư đã biết trước (spec đã ghi nhận), thay
vì giả vờ chia theo tháng trong khi API không thực sự hỗ trợ.

## UNVERIFIED — chưa xác minh, không hardcode giả định

- **Rate limit thực tế / ngưỡng 429**: chưa đo. `fetchJsonWithRetry` đã có backoff exponential
  cho 429/5xx (giữ nguyên từ `kiotVietClient.js`), nhưng số lần 429 gặp phải khi chạy
  `sync:once`/`backfill` với 2-3 request đồng thời/branch chưa được đo thực tế. Đo qua log khi
  chạy `sync:once` lần đầu, giảm `runWithConcurrencyLimit` xuống 1-2 nếu 429 xuất hiện nhiều.
- **Tính khả dụng dữ liệu lịch sử cho backfill từ 2026-01-01**: chưa test 1 hóa đơn tháng
  3/2026 xem field có bị cắt bớt so với hóa đơn gần đây không. Test trước khi chạy
  `backfill.js` đầy đủ, không phải trước khi code các entity sync module.
- **Mã trạng thái (`status`) hóa đơn/đơn hàng**: đã biết có mâu thuẫn giữa 2 nơi trong code cũ
  (xem `PlanDB.md §9`) — **không** suy diễn nhãn "hoàn thành"/"đã hủy" ở Phase 1, giữ nguyên
  `status SMALLINT` thô như spec đã chốt.

## Đã xác minh nhưng KHÔNG dùng trong Phase 1

- `partnerType=C` trên `/cashflow` (lọc theo khách hàng) —
  Phase 1 lấy **toàn bộ** `cash_flows` (cả khách hàng lẫn nhà cung cấp) vì bảng `cash_flows` có
  cả `customer_id` lẫn `supplier_id`, không lọc `partnerType` ở tầng sync.

## Đối soát phiếu nhập và đứt hàng — 2026-09-28

Kiểm tra trực tiếp thẻ kho MCRY301 tại Hà Nội: PN002517 nhập 4.500 ngày
14/09/2026, nhưng không có trong Postgres. API `/purchaseorders` không lọc
ngày sửa trả đúng phiếu id 16136771 (createdDate 17/09); cùng API với
`lastModifiedFrom=2026-09-16T00:00:00Z` không trả phiếu này. Vì vậy việc
tham số làm thay đổi `total` **không chứng minh đồng bộ tăng dần đầy đủ**.
Tài liệu chính thức mục 2.15.1 chỉ liệt kê fromPurchaseDate/toPurchaseDate,
không cam kết lastModifiedFrom cho phiếu nhập:
https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/public-api/

Trong dữ liệu từ 01/06 đến 28/09, đối chiếu ID phát hiện thiếu 37 phiếu tại
Hà Nội (1.127 mã hàng) và 11 phiếu tại Sài Gòn (427 mã hàng). Các số này là
ảnh chụp lúc kiểm tra, không phải tổng số sai lệch cố định.

Sửa: purchases polling đối soát toàn bộ danh sách từ mốc sàn đứt hàng (`STOCKOUT_DATA_FLOOR_DATE_KEY`, hiện là 01/02/2026; thời điểm viết đoạn này mốc là 01/06/2026), gồm cả phiếu hủy; so
sánh raw để chỉ ghi phiếu mới/thay đổi. Các entity chỉ tiến checkpoint sau
khi **mọi trang** thành công; lỗi giữa chừng giữ mốc cũ để replay an toàn.
Chi phí: mỗi lượt purchases polling cần đọc toàn bộ trang API, nhưng không
viết lại chi tiết của phiếu không thay đổi. Cần khởi động lại server để nạp
logic polling mới. Không sửa chứng từ nguồn trên KiotViet.

## Đối soát Sổ quỹ — 07/10/2026

Live probe HN/SG đối chiếu phương thức Cash và status=0 khớp các tổng trên web KiotViet. Phiếu method=Cash có thể vẫn có accountId, kể cả -1: phân loại tiền mặt theo method. Timestamp trả về không có zone là giờ Việt Nam; query có Z được API chuyển sang giờ Việt Nam (00:00Z–07:00Z cho kết quả giống 07:00–14:00 không zone). Không truyền startDate/endDate chỉ trả một phần phiếu; đối soát đầy đủ dùng startDate=1970-01-01T00:00:00.000Z và endDate của lượt chạy.

startDate/endDate lọc theo transDate, không phát hiện mọi sửa/hủy hoặc nhập lùi ngày. cash_flows đối soát toàn bộ mỗi ngày; giữa các lần đối soát replay 7 ngày. Metadata mốc hoàn tất lưu JSON trong sync_checkpoints.note. Tài liệu API chính thức (2.14.1): https://www.kiotviet.vn/huong-dan-su-dung-kiotviet/retail-ket-noi-api/public-api/

Phân trang cashflow: orderBy=Id/orderDirection=ASC đã xác minh. Theo TransDate có thể trùng/thiếu phiếu cùng giờ. Phát hiện SG TT016464: ID cũ 206806358 không còn trên API (lọc ids trả total=0); cùng mã trả ID mới 206806359. Đối soát cần đánh dấu ID cũ bằng source_missing_at, giữ lịch sử nhưng không cộng trùng. Chỉ đánh dấu sau snapshot đủ ID duy nhất theo total API.

Cập nhật gần nhất: 05/11/2026 (giá vốn không đổi `modifiedDate`, entity `product_costs`); trước đó 29/10/2026 (phân trang lastModifiedFrom, orderBy=id, chồng lấn 5 phút, đối soát đầy đủ products).
