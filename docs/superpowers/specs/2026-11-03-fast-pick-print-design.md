# Vòng đời đơn hàng: in phiếu nhặt nhanh hơn (bớt chờ khi mở đơn, Thay đổi chỉ định, Hủy nhặt)

Ngày: 03/11/2026 · Nhánh: `perf/fast-pick-print` (tạo từ `origin/main`) · Trang: `/shipment/lifecycle/`

## Bối cảnh

Kế toán in phiếu nhặt theo luồng: bấm đơn trong Vòng đời đơn hàng → chờ chi tiết + nút "Thay đổi chỉ định" → bấm nút → chờ hộp chỉ định → bấm "Hủy nhặt" → chờ → chỉ định lại → "Xác nhận & In phiếu nhặt". Mỗi bước chờ 1–2 giây.

### Nguyên nhân (đo 03/11/2026)

- Web service `tokosi` chạy ở Render **Oregon**, DB Supabase `TOKOSI` ở **Singapore**: mỗi lượt truy vấn DB ≈ 170 ms đường truyền (ước lượng theo khoảng cách vùng). Thời gian chạy truy vấn trên Supabase chỉ 1–8 ms (`pg_stat_statements`) → chậm do **số lượt gọi nối tiếp**, không do SQL.
- Trình duyệt (VN) → Render: TTFB ≈ 280 ms cho trang tĩnh → mỗi request ≈ 250 ms.
- Bấm đơn: `loadKiotLines` gọi `/api/shipment/lifecycle/order-detail` (3–4 lượt DB) **rồi mới** `GET /api/shipment/pick` (`readLatestId` → đầu chỉ định → SĐT sale → dòng → lịch sử: 4–5 lượt). Nút chỉ hiện khi cả hai xong.
- `GET /api/shipment/pick/candidates`: `defaultLoadOrder` gọi `findMergedOrder` (đọc lại 6 tab Google Sheet khi cache 15 s hết hạn) → `readOrderDetail` (kèm cước/thể tích/tồn mà hộp chỉ định không dùng) → SĐT sale (gọi API KiotViet `/users` khi cache 5 phút hết hạn) → vị trí → giữ chỗ → `readLatest` (4–5 lượt). Khoảng 10 lượt nối tiếp.
- Hủy nhặt: `POST /:id/cancel` (transaction ≈ 7 lượt + `readAssignment` 4–5 lượt) rồi client gọi lại toàn bộ `/candidates`.
- `[timing]` (`server/lib/requestTiming.js`) chỉ gắn cho `/api/product-report`, `/api/invoice-detail` → không có số đo cho các API này trên Render; gói Render hiện không có log request / HTTP metrics.

### Ngoài phạm vi

- Chuyển web service sang Singapore (hạ tầng) — để việc riêng nếu cần.
- Đổi cách khóa / kiểm `version` trong transaction chỉ định, xác nhận, hủy.
- Đổi hành vi nghiệp vụ của nút (Hủy nhặt vẫn còn, gợi ý sau Hủy nhặt vẫn như cũ).

## 1. Mở chi tiết đơn: tải song song, hiện nút ngay

File: `server/public/shipment/lifecycle/index.html`, `server/public/shipment/lifecycle/pick/pick-assign.js`.

- `loadKiotLines(order)`: khi `window.TKSPick && canPick && order.pickStatus`, gọi `readDetailJSON('/order-detail…')` và `TKSPick.loadAssignment(order)` **cùng lúc** (`Promise.all`), giữ kiểm `requestId !== detailRequestId` như cũ. Lỗi/404 của `/order-detail` xử lý như hiện nay; `loadAssignment` vẫn trả `null` khi lỗi.
- Gắn nút ngay khi hộp mở: `loadKiotLines`, trước khi gọi mạng, gọi hàm mới `TKSPick.attachButton({ order, buttonHost, canPick, status: order.pickStatus })` vẽ nút "Thay đổi chỉ định" / "Chỉ định vị trí" vào `#lcDetailPickActions`. `attach(opts)` hiện có tiếp tục vẽ chip "✓ Đã chỉ định · …" và gắn lại nút khi bảng hàng về (dùng chung một hàm tạo nút để không lệch nhãn/tiêu đề).
- Bấm nút trước khi bảng hàng về vẫn mở được hộp chỉ định (hộp tự tải dữ liệu riêng).

## 2. Tải trước hộp chỉ định (prefetch)

File: `pick-assign.js`, `index.html`.

- API mới `TKSPick.prefetch(order)`: bắt đầu `GET /api/shipment/pick/candidates?branch&order` và lưu `{ key: branch + '|' + mã đơn chuẩn hóa, at, promise }` (chỉ giữ **một** mục — đơn đang xem gần nhất).
- `index.html` gọi `prefetch` khi mở chi tiết đơn nếu `canPick` (người có quyền `shipment.pick`), cùng lúc với bước 1.
- `load()` trong `pick-assign.js`: nếu có mục prefetch cùng `key` và `Date.now() - at ≤ 30 000` ms thì dùng `promise` đó (đang chạy dở thì chờ chính request đó, không gọi trùng); dùng xong thì xóa mục (lần tải sau — Tải lại, sau lỗi ghi, mở lại hộp — luôn gọi mạng mới). Prefetch lỗi (mạng / `!ok`) → bỏ mục và gọi mạng mới như hiện nay.
- An toàn dữ liệu: tồn trong prefetch có thể cũ ≤ 30 s; khi lưu, `assign` vẫn khóa cơ sở, kiểm `version` và tồn thật như hiện nay, lệch thì trả `REFETCH_CODES` → client tải lại.
- Đóng hộp chi tiết / chuyển sang đơn khác → mục prefetch cũ bị thay hoặc hết hạn; không cần hủy request.

## 3. Hủy nhặt không tải lại `/candidates`

File: `pick-assign.js` (`changeStatus`).

- `heldByPosition` luôn bỏ qua giữ chỗ của **chính đơn đang xem** (`lower(btrim(a.order_code)) <> $3`), nên tồn khả dụng trong `state.cand` không đổi khi đơn này bị hủy.
- Sau `write(…/cancel)` thành công: không gọi `reloadCurrent`; thay bằng hàm cục bộ `applyCancelled()` làm đúng nhánh "không có chỉ định đang hiệu lực" của `load()`: `state.assignment = null`, `state.reassignOf = null`, `state.removed = new Set()`, `state.needs = editedNeeds({})`, `state.allocations = {}`, rồi `suggest()` nếu `state.order.eligible !== false`, rồi `render()`.
- `write()` vẫn cập nhật `state.latest` (đã hủy) và gọi `notify()` như cũ để danh sách/hộp chi tiết đổi trạng thái.

## 4. Máy chủ: bớt lượt gọi DB

### 4.1 `readLatest` / `readAssignment` (`server/pickAssignments/pickAssignmentsService.js`)

- `readLatest(db, branch, orderCode)`: một truy vấn `SELECT * FROM order_pick_assignments WHERE branch = $1 AND lower(btrim(order_code)) = $2 ORDER BY id DESC LIMIT 1`, rồi dựng kết quả từ hàng đó (không truy vấn lại theo id).
- Tách `readAssignment(db, id)` thành: đọc `head` (khi chưa có) + `shapeAssignment(db, head)`; trong `shapeAssignment`, ba việc **song song** (`Promise.all`): SĐT sale (chỉ khi snapshot thiếu), `order_pick_lines`, `order_pick_history`.
- Bỏ `readLatestId` (chỉ `readLatest` dùng). Hình dạng JSON trả về không đổi.
- Trong transaction (`client` đơn), `Promise.all` trên cùng một client vẫn đúng (pg xếp hàng), chỉ không nhanh hơn.

### 4.2 `candidates`

- `requireOrder(branch, code)` và `readLatest(db, branch, code)` chạy **song song**. Nếu `order.orderCode` (mã chuẩn từ nguồn) khác `code` theo `codeKey`, đọc lại `readLatest` theo `order.orderCode` (trường hợp hiếm, giữ đúng như hiện nay).
- Gộp đọc vị trí + giữ chỗ thành **một** câu SQL:
  ```sql
  SELECT p.<ROW_COLUMNS>, COALESCE(h.held, 0) AS held
    FROM stock_positions p
    LEFT JOIN (SELECT l.position_id, SUM(l.reserved_qty) AS held
                 FROM order_pick_lines l JOIN order_pick_assignments a ON a.id = l.assignment_id
                WHERE a.status = 'picking' AND a.branch = $1 AND lower(btrim(a.order_code)) <> $3
                GROUP BY l.position_id) h ON h.position_id = p.id
   WHERE p.branch = $1 AND lower(btrim(p.code)) = ANY($2::text[])
   ORDER BY p.id
  ```
  `heldByPosition` giữ nguyên cho `assign` (trong transaction).
- Trả về giữ đúng hình dạng `{ order, candidates, assignment }` + `canEditPositions` từ route.

### 4.3 Tải đơn cho chỉ định (`defaultLoadOrder`)

- Nhận thêm `{ allowStale }` (mặc định `false`). `candidates` truyền `allowStale: true`; `assign`, `positionScope` giữ `false`.
- `findMergedOrder(branch, code, { kiot, allowStale })` và `kiot.readOrderDetail({ branch, code, lite: true })` chạy **song song** với mã người dùng gửi. Nếu `row.orderCode` khác `code` (khác chữ hoa/thường hoặc khoảng trắng) thì đọc lại chi tiết theo `row.orderCode` như hiện nay.
- `readOrderDetail({ …, lite: true })` (`server/shipment/kiotOrdersRepository.js`): bỏ đọc tồn thực / đang vận chuyển (`readOnHandByKey`, `readInTransit`) và cước/thể tích (`lookupMeasures`); các trường đó trả `null`/không có. Hộp chỉ định và phiếu in không dùng các trường này (đã kiểm `pickAssignments/*`, `public/shipment/lifecycle/pick/*`). `/order-detail` của hộp chi tiết **không** dùng `lite`.

### 4.4 Google Sheet đọc được bản cũ (chỉ cho `/candidates`)

- `server/sheets/orderLifecycleSheetsClient.js` + `orderLifecycleHistoryClient.js`: `getValues(sheetName, { allowStale } = {})`. `allowStale` và cache hết hạn nhưng còn dữ liệu → trả dữ liệu cũ ngay và làm mới ở nền (một lượt làm mới mỗi tab, dùng chung `loading`; lỗi nền chỉ ghi log, giữ dữ liệu cũ). Không có dữ liệu → chờ đọc như hiện nay. Không truyền `allowStale` → hành vi cũ. Client lịch sử xóa cache ngay sau mỗi lần ghi đè trạng thái, nên sau khi ghi luôn phải chờ bản mới (không trả bản trước khi ghi).
- `orderLifecycleRepository.readAll(opts)` / `readOverrideHistory(opts)` chuyển `allowStale` xuống; `orderLifecycleService.loadMergedRows(kiot, opts)` / `findMergedOrder(…, { kiot, allowStale })` chuyển tiếp. Danh sách, xuất Excel, ghi đè trạng thái giữ hành vi cũ.

### 4.5 SĐT sale (`server/pickAssignments/pickKiotData.js`)

- `createSellerPhoneLookup`: cache hết hạn nhưng đã có bản đọc thành công → trả bản cũ ngay, làm mới ở nền (một lượt mỗi key). Chỉ khi chưa từng đọc được mới phải chờ (timeout 5 s như cũ). Lần lỗi giữ bản cũ thay vì thay bằng `Map` rỗng.

## 5. Đo trên Render

- `server/routes.js`: gắn `startTiming` trước `/api/shipment/lifecycle` và `/api/shipment/pick` (giống `/api/product-report`). Request ≥ 500 ms (`REQUEST_TIMING_SLOW_MS`) ghi một dòng `[timing] <METHOD> <path> … total=…ms` để so trước/sau.

## 6. Kiểm thử

Thêm/sửa test (`node --test`, theo file test sẵn có cạnh mỗi module):

- `pickAssignmentsService.test.js`:
  - `readLatest` chạy 1 truy vấn đầu chỉ định + dòng/lịch sử/SĐT song song (db giả ghi thứ tự, dùng deferred để chứng minh 3 truy vấn cùng đang chờ).
  - `candidates` gọi `loadOrder` và đọc chỉ định cùng lúc; dùng câu SQL gộp vị trí + giữ chỗ; `available` = tồn − giữ chỗ của đơn khác; giữ chỗ của chính đơn không bị trừ; mã chuẩn khác mã gửi → đọc lại chỉ định theo mã chuẩn.
  - `loadOrder` nhận `allowStale: true` từ `candidates`, `false` từ `assign`.
- `kiotOrdersRepository.test.js`: `readOrderDetail({ lite: true })` không gọi `lookupMeasures` / truy vấn tồn; không `lite` thì như cũ.
- Test client Sheets (cache): `allowStale` trả bản cũ + làm mới nền đúng một lần; không `allowStale` chờ bản mới.
- `pickKiotData` test: hết hạn trả bản cũ + làm mới nền; lỗi giữ bản cũ.
- Test giao diện `pick-assign.js` (`server/test/frontend/lifecycle-pick*.test.js`):
  - `prefetch` + `open` cùng đơn trong 30 s → chỉ 1 lần `GET /candidates`; quá 30 s hoặc khác đơn → gọi mới; prefetch lỗi → gọi mới.
  - Hủy nhặt thành công → không gọi lại `/candidates`, trạng thái "Hủy nhặt", có gợi ý mới, sửa được ngay.
- Test trang Vòng đời (`server/test/frontend/lifecycle-pick.test.js`): mở chi tiết đơn có `pickStatus` → `/order-detail` và `GET /api/shipment/pick` được gửi trước khi cái nào trả về; nút hiện trước khi bảng hàng về.
- `cd server && npm test` xanh 100%.

## 7. Kết quả mong đợi

| Bước | Trước | Sau |
|---|---|---|
| Bấm đơn → thấy nút | ~1.9 s | ngay; bảng hàng ~0.9 s |
| Thay đổi chỉ định | 1.5–2 s+ | ≈ 0 nếu đã prefetch xong; ~0.9 s nếu chưa |
| Hủy nhặt | 2 s+ (2 request) | 1 request ~1.2–1.5 s |

Hủy nhặt còn ~1.2 s vì transaction cần khoảng 7 lượt đi-về Oregon ↔ Singapore; chỉ giảm mạnh hơn nếu chuyển server sang Singapore. Kế toán có thể bỏ bước Hủy nhặt: đơn Đang nhặt sửa trực tiếp rồi bấm "Cập nhật chỉ định & In phiếu" (một giao dịch).

## 8. Tài liệu đồng bộ

Theo `CLAUDE.md` §3: `server/README.md` (ghi chú `[timing]` cho `/api/shipment/*`), `CURRENT.md`, ngày cập nhật cuối tài liệu. Không có migration, không đổi schema.
