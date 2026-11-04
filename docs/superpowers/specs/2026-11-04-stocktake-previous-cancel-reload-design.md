# Kiểm kê: chọn đợt KK trước, hủy đợt, nạp lại sheet (đợt 1)

Ngày: 04/11/2026 · Nhánh: `claude/awesome-cerf-yycv0b` · Trang: `/stocktake/` · Migration mới: `0106_stocktake_previous_cancel.sql`

## Bối cảnh

Hai đợt nạp từ sheet ("Kiểm kê HN T10 (sheet)" và "Kiểm kê SG T10 (sheet)") đang làm nguồn "KK trước sai" và "Kiểm SG/HN". Hiện tại có bốn vấn đề:

1. Số liệu của hai đợt này **cũ**, còn trước cả đợt kiểm gần nhất. Nạp sheet chỉ chạy **một lần**: `source_ref` là UNIQUE, nạp lại báo `409 ALREADY_IMPORTED`.
2. Không có cách **bỏ** một đợt sai. Không có API xóa, mà xóa thẳng trong DB thì `ON DELETE CASCADE` làm mất kết quả, ghi chú và dòng sửa.
3. "KK trước" được **chọn tự động** theo ngày (`previousSessionIdOf`: đợt đóng gần nhất cùng cơ sở có `date_to <= date_from`). Người dùng không chỉ định được đợt khác.
4. Đợt đã đóng không sửa được. Việc này để đợt 3 (sửa bản chụp), không thuộc bản thiết kế này.

## Mục tiêu đợt 1

| # | Chức năng | Ai dùng |
|---|---|---|
| A | Chọn tay **Đợt KK trước** cho đợt đang mở; để trống thì tự chọn như cũ | `stocktake.edit` |
| B | **Hủy đợt** (ẩn, không xóa vật lý) và **Khôi phục** đợt đã hủy | `stocktake.close` (Quản lý) |
| C | **Nạp lại** đợt nạp từ sheet: đọc lại tab và thay bản chụp, giữ nguyên id đợt | `stocktake.close` (Quản lý) |

Ngoài phạm vi: nhập CSV/XLSX hoặc tab sheet tùy chọn (đợt 2), sửa bản chụp hoặc mở lại đợt đã đóng (đợt 3), tự đồng bộ liên tục với sheet. Tự đồng bộ bị loại hẳn: đợt đã đóng là số liệu tại một thời điểm và không được tự trôi.

## 1. Migration `0106_stocktake_previous_cancel.sql`

```sql
ALTER TABLE stocktake_sessions
  ADD COLUMN IF NOT EXISTS previous_session_id BIGINT REFERENCES stocktake_sessions (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by_user_id TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by_name   TEXT,
  ADD COLUMN IF NOT EXISTS cancel_reason       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reloaded_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reloaded_by_name    TEXT;
ALTER TABLE stocktake_sessions ADD CONSTRAINT stocktake_sessions_previous_not_self CHECK (previous_session_id IS NULL OR previous_session_id <> id);

-- Them action moi cho lich su.
ALTER TABLE stocktake_history DROP CONSTRAINT IF EXISTS stocktake_history_action_check;
ALTER TABLE stocktake_history ADD CONSTRAINT stocktake_history_action_check CHECK (action IN (
  'session_create', 'session_update', 'session_close', 'sheet_import', 'line_edit', 'line_add', 'note', 'tag', 'paste',
  'session_cancel', 'session_restore', 'sheet_reload'));
```

- Rollback `server/db/rollbacks/0106_stocktake_previous_cancel.down.sql`: bỏ các cột mới và trả CHECK action về danh sách cũ. Rollback sẽ thất bại nếu lịch sử đã có action mới; ghi rõ điều này trong file.
- **Hủy dùng cột `cancelled_at`, không thêm giá trị `status`.** Lý do: giao diện có khoảng 10 chỗ kiểm `status === 'closed'` / `'open'`. Thêm `cancelled` vào `status` sẽ làm sai các chỗ đó, và khi khôi phục còn phải nhớ trạng thái cũ. Với cột riêng, khôi phục chỉ cần xóa `cancelled_at`.

## 2. A — Chọn đợt KK trước

### Quy tắc

- Chỉ đặt được khi đợt **đang mở** và chưa hủy. Đợt đã đóng thì `prev_diff` đã chụp cứng, đổi cũng không có tác dụng.
- Đợt được chọn phải: **cùng cơ sở**, **đã đóng**, **chưa hủy**, khác chính nó. Không bắt buộc về ngày, để người dùng chọn được cả đợt nạp sheet có ngày lệch. Nếu `date_to` của đợt được chọn lớn hơn `date_from` của đợt hiện tại thì hiện cảnh báo vàng "Đợt KK trước kết thúc sau ngày bắt đầu đợt này", nhưng vẫn cho chọn.
- `null` = **Tự động**: giữ đúng quy tắc hiện nay và bổ sung điều kiện `cancelled_at IS NULL`.
- Nếu đợt đã chọn sau đó bị hủy thì coi như `null` (tự động) và hiện chú thích "Đợt KK trước đã chọn bị hủy, đang dùng tự động". Không tự xóa `previous_session_id`, để khôi phục đợt kia thì lựa chọn trở lại.

### Code (`server/stocktake/stocktakeService.js`)

- `SESSION_COLUMNS` và `shapeSession`: thêm `previousSessionId`, `cancelledAt`, `cancelledByName`, `cancelReason`, `reloadedAt`, `reloadedByName`.
- `previousSessionIdOf(db, session)`:
  1. Nếu `session.previousSessionId` trỏ tới đợt cùng cơ sở, đã đóng, chưa hủy thì trả id đó (`mode: 'manual'`).
  2. Nếu không, chạy truy vấn tự động hiện có, thêm `AND cancelled_at IS NULL` (`mode: 'auto'`).
  3. Trả `{ id, mode, manualInvalid }`. `manualInvalid = true` khi có chọn tay nhưng đợt đó không dùng được.
- `previousResults` và `closedBoard` dùng kết quả mới. `getBoard` trả thêm `previous: { id, name, mode, manualInvalid }` thay cho `previousSessionId` trần. Giữ `previousSessionId` để tương thích.
- `updateSession`: nhận thêm `previousSessionId` (cùng `version`). Kiểm tra bằng hàm mới `previousOf(db, ctx, session, value)` theo các quy tắc trên. Lỗi `400 INVALID_PREVIOUS`. Ghi lịch sử `session_update` với before/after `{ previousSessionId }`. Chỉ cập nhật trường nào có trong body, để đổi đối chiếu không xóa mất KK trước và ngược lại.
- `createSession`: nhận `previousSessionId` tùy chọn, kiểm tra như trên.
- `closeSession`: không đổi. `loadInputs` đã dùng `previousResults` nên bản chụp lấy đúng đợt đã chọn.

### Giao diện (`server/public/stocktake/stocktake.js` + `index.html`)

- Cạnh ô "Đợt đối chiếu" (`stCounterpartField`) thêm ô chọn **"Đợt KK trước"**:
  - Lựa chọn đầu: `Tự động — <tên đợt đang được chọn tự động>` (hoặc `Tự động — chưa có` nếu không có).
  - Các đợt cùng cơ sở đã đóng, chưa hủy, mới nhất trước: `tên · dd/mm/yyyy · Sheet/Web`.
  - Bị khóa khi đợt đã đóng hoặc không có `canEdit`. Khi đợt đã đóng, chỉ hiện tên đợt đã dùng.
- Đổi lựa chọn thì `PATCH /api/stocktake/sessions/:id { previousSessionId, version }`, rồi tải lại bảng. Lỗi 409 xử lý như đối chiếu hiện nay.
- Placeholder ô nhập tay KK trước (`stPrevManualLabel`) ghi rõ nguồn: "Để trống = tự lấy từ đợt <tên>: <số>".
- Hộp tạo đợt có thêm ô chọn này (mặc định Tự động).

## 3. B — Hủy đợt / Khôi phục

### Quy tắc

- Hủy được cả đợt **đang mở** và **đã đóng**. Bắt buộc nhập lý do (1–500 ký tự). Phải gửi `version`.
- Đợt đã hủy:
  - **Ẩn** khỏi danh sách mặc định. Có công tắc "Hiện đợt đã hủy" (chỉ Quản lý thấy) để xem, khi đó đợt hiện chữ gạch ngang và nhãn "Đã hủy".
  - **Chỉ đọc**: mọi lệnh ghi (`openSessionForWrite`, `saveTag` qua `readSession`, `updateSession`, `closeSession`, nạp lại) bị chặn với `409 STOCKTAKE_CANCELLED`.
  - Không được chọn làm KK trước hay đối chiếu, kể cả khi tự động.
  - Các đợt khác đang trỏ `counterpart_session_id` tới nó thì coi như không có đối chiếu (`counterpartResults` và `counterpartInfoOf` kiểm `cancelled_at`) và hiện chú thích "Đợt đối chiếu đã bị hủy".
- **Khôi phục**: xóa `cancelled_at`, `cancelled_by_*`, `cancel_reason`; tăng `version`; ghi lịch sử `session_restore`. Đợt trở lại đúng trạng thái mở/đóng như trước khi hủy.
- **Tag (Cụm SP / Combo) không bị gỡ** khi hủy đợt nạp sheet, vì tag giữ theo cơ sở qua các đợt và có thể đã được sửa trên web. Hộp xác nhận ghi rõ điều này.
- **Cảnh báo phụ thuộc**: trước khi hủy, API `GET /api/stocktake/sessions/:id/dependents` trả danh sách đợt đang dùng nó:
  - đợt **mở** dùng nó làm KK trước (chọn tay hoặc tự động) hoặc làm đối chiếu → "số KK trước / Kiểm SG của các đợt này sẽ đổi";
  - đợt **đã đóng** từng dùng nó → "đã chụp cứng, không đổi".
  Đợt đã đóng không lưu id đợt KK trước lúc đóng, nên với đợt đóng chỉ xét được đối chiếu. Xem mục 6, ý 3.

### API (`server/stocktake/stocktakeRoutes.js`, quyền `close`)

| Phương thức | Đường dẫn | Body | Trả |
|---|---|---|---|
| `POST` | `/api/stocktake/sessions/:id/cancel` | `{ version, reason }` | `{ session }` |
| `POST` | `/api/stocktake/sessions/:id/restore` | `{ version }` | `{ session }` |
| `GET` | `/api/stocktake/sessions/:id/dependents` | — | `{ previousOf: [...], counterpartOf: [...] }` |

`GET /api/stocktake/sessions` nhận thêm `?includeCancelled=1`. Tham số này chỉ có tác dụng với người có `stocktake.close`; người khác luôn bị lọc `cancelled_at IS NULL`.

Mỗi lệnh dùng `withTransaction`: khóa dòng đợt (`FOR UPDATE`), so `version`, ghi `stocktake_history` trong cùng giao dịch, rồi phát SSE `announceChanged`. Bảng đang mở ở tab khác sẽ tải lại và thấy nhãn "Đã hủy".

### Giao diện

- Menu đợt (cạnh nút Đóng đợt) thêm **"Hủy đợt…"** (chữ đỏ). Hộp xác nhận gồm: tên đợt, danh sách phụ thuộc, ô lý do bắt buộc, nút "Hủy đợt".
- Khi đang xem đợt đã hủy: dải cảnh báo trên cùng "Đã hủy bởi <tên> lúc <giờ> — <lý do>" và nút **"Khôi phục"**.

## 4. C — Nạp lại đợt nạp từ sheet

### Quy tắc

- Chỉ áp dụng cho đợt `source = 'sheet_import'`, chưa hủy. Đọc lại đúng tab theo `source_ref`. Phải gửi `version`.
- **Giữ nguyên `id` đợt**, để các lựa chọn KK trước và đối chiếu đang trỏ tới vẫn đúng.
- Cho sửa luôn **tên** và **ngày kiểm** (`date_from = date_to`) trong cùng lệnh. Số liệu cũ một phần là do ngày cố định `2026-10-03`; sau khi nạp lại, ngày nên khớp với lần kiểm thật mà tab đang chứa.
- Trong 1 giao dịch:
  1. Khóa đợt, so `version`.
  2. Đọc sheet và parse bằng `parseSheet` (dùng chung với nạp lần đầu). Lỗi định dạng hoặc tab rỗng thì dừng, **không đổi gì**.
  3. `DELETE FROM stocktake_session_results WHERE session_id = $1`, rồi chèn bản mới.
  4. `DELETE FROM stocktake_code_notes WHERE session_id = $1`, rồi chèn ghi chú từ sheet. Đợt đã đóng không có ghi chú sửa trên web nên không mất gì.
  5. Tag: vẫn `ON CONFLICT DO NOTHING`, không ghi đè tag đã có.
  6. Cập nhật `name`, `date_from`, `date_to`, `reloaded_at`, `reloaded_by_name`, `version + 1`.
  7. Ghi lịch sử `sheet_reload` với `before = { codes, mismatched, name, date }` và `after = { codes, mismatched, name, date, added, removed, changed }`. `changed` là số mã có `diff_qty` khác với bản cũ. Không lưu toàn bộ bản chụp cũ vào lịch sử để tránh dòng JSONB quá lớn; muốn giữ thì xuất Excel trước khi nạp lại (hộp xác nhận nhắc việc này).
- **Xem trước**: `POST .../reload-sheet?dryRun=1` chạy bước 1–2 rồi trả `{ codes, mismatched, added, removed, changed, sample: [10 mã thay đổi nhiều nhất] }` mà không ghi. Giao diện hiện bảng này trước khi xác nhận.

### Code

- `server/stocktake/stocktakeSheetImport.js`: tách phần chèn kết quả và ghi chú thành `writeSnapshot(client, session, rows, actor)`, dùng chung cho `importSheet` và hàm mới `reloadSheet(ctx, sessionId, body)`. Tìm `SOURCES` theo `source_ref` (`sheet:<spreadsheetId>:<sheetId>`).
- Route `POST /api/stocktake/sessions/:id/reload-sheet` (quyền `close`), body `{ version, name?, date?, dryRun? }`.
- Giao diện: khi xem đợt `sheet_import`, menu đợt có **"Nạp lại từ sheet…"**. Hộp gồm tên, ngày kiểm, nút "Xem trước", bảng thay đổi, nút "Nạp lại".

## 5. Kiểm thử (`node:test`)

| File | Ca kiểm |
|---|---|
| `stocktakeService.test.js` | KK trước chọn tay dùng đúng đợt; chọn tay đợt bị hủy → tự động + `manualInvalid`; tự động bỏ qua đợt hủy; chặn chọn đợt khác cơ sở / đang mở / chính nó / đã hủy (`400 INVALID_PREVIOUS`); đổi KK trước không xóa đối chiếu và ngược lại; đóng đợt chụp `prev_diff` từ đợt chọn tay; hủy/khôi phục đúng `version` (409 khi lệch); mọi lệnh ghi lên đợt hủy → `409 STOCKTAKE_CANCELLED`; đối chiếu trỏ tới đợt hủy → không có đối chiếu; `listSessions` lọc đợt hủy, `includeCancelled` chỉ có tác dụng với Quản lý; `dependents` đúng |
| `stocktakeSheetImport.test.js` | Nạp lại giữ id, thay kết quả và ghi chú, không ghi đè tag; lỗi parse → rollback, không đổi gì; `dryRun` không ghi; đếm `added/removed/changed` đúng; chặn đợt `web` và đợt hủy; đổi tên/ngày |
| `stocktakeRoutes.test.js` | Quyền: `cancel`/`restore`/`reload-sheet` cần `stocktake.close`; `PATCH previousSessionId` cần `stocktake.edit`; phạm vi cơ sở (`BRANCH_OUT_OF_SCOPE`) |
| `server/db/rollbacks/stocktakeRollback.test.js` | Migration 0106 chạy lại được (idempotent); rollback trả về schema 0105 |

Kiểm tra trên trình duyệt: chọn KK trước → cột "KK trước sai" đổi; hủy đợt T10 → đợt mở chuyển sang tự động hoặc trống; khôi phục → trở lại; nạp lại T10 với ngày mới → xem trước rồi xác nhận. Kiểm tra cả giao diện sáng/tối và di động.

## 6. Rủi ro và quyết định đã chốt

1. **Nạp lại làm số KK trước của đợt đang mở đổi theo.** Đây là điều cần có. Hộp xác nhận liệt kê các đợt mở bị ảnh hưởng (dùng `dependents`).
2. **Đợt đã đóng không đổi** khi đợt KK trước của nó bị hủy hoặc nạp lại, vì `prev_diff` đã chụp lúc đóng. Muốn sửa thì chờ đợt 3 (sửa bản chụp).
3. Đợt đã đóng không lưu "lúc đóng đã dùng đợt nào làm KK trước". Đề xuất: khi đóng, ghi id đó vào `stocktake_history` (`session_close.after.previousSessionId`). Việc này không cần cột mới; danh sách phụ thuộc của đợt đã đóng đọc từ lịch sử này (chỉ có với các đợt đóng sau khi triển khai).
4. Không có xóa vật lý trong đợt 1. Nếu sau này cần dọn hẳn, làm một script riêng cho Admin, không làm nút trên web.

## 7. Tài liệu cần cập nhật khi code (skill `update-file`)

`README.md`, `server/README.md` (migration 0106 + 4 route mới), `server/db/SCHEMA.md` (cột mới của `stocktake_sessions`, action lịch sử mới, phạm vi 0001–0106), `docs/04-planning/implementation_plan.md`, `docs/02-srs/…`, `docs/01-brd/…`, `CURRENT.md`, `CLAUDE.md` (dòng "0001–0105").

_Cập nhật: 04/11/2026_
