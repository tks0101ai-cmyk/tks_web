# Sửa lỗi tạo mã QR chuyển khoản (Kế toán – Nháp VAT)

Ngày: 13/11/2026 · Trang: `/vat-draft/` (tab **Tạo QR** và thẻ QR trong tab **Xử lý hóa đơn**)

## 1. Vấn đề

### 1.1 Ô "Tài khoản nhận tiền" không có tài khoản nào

Người dùng thấy nhãn "Gợi ý từ hóa đơn" nhưng ô chọn chỉ có "Tài khoản khác (nhập tay)…".

Nguyên nhân: danh sách tài khoản trả chung request `GET /api/vat-draft/meta` với trạng thái Google Sheets
(`server/vatDraft/vatDraftRoutes.js`). Với người có quyền `accounting.vatDraft`, route chờ
`masterData.get()` xong mới trả:

- Cache master data chỉ tươi 10 phút, không làm mới ngầm (`sheetsSource.js`, `backgroundRefresh` tắt).
  Hết hạn hoặc vừa khởi động lại server → request phải chờ đọc Sheets (tới 15 giây file trung gian
  + 45 giây file gốc VAT TKS khi dự phòng).
- Trong lúc chờ, `state.meta` = null → `accountOptions()` không có tài khoản. Hóa đơn đọc xong vẫn
  đặt `matchedAccounts` nhưng không có option tương ứng → ô chọn rỗng, tự tạo QR không chạy.
- `loadMeta()` lỗi (mạng / quá thời gian) không thử lại → ô chọn trống tới khi tải lại trang.
- Người chỉ có quyền `accounting.qr` (sale) không bị vì nhánh của họ trả ngay.

### 1.2 Khách quét mã QR không được

Quy định của VietQR Quick Link: `addInfo` **tối đa 50 ký tự, không ký tự đặc biệt**; `ACCOUNT_NO`
**tối đa 19 ký tự** chữ/số; `amount` số dương **tối đa 13 chữ số**; `BANK_ID` là BIN, short name hoặc
mã ngân hàng trong danh sách VietQR. Hệ thống hiện vi phạm:

- Nội dung chuyển khoản: ô nhập `maxlength="200"`, máy chủ cắt 200 ký tự, giữ nguyên dấu tiếng Việt
  và ký tự đặc biệt. Gợi ý ô nhập là "mã hóa đơn, tên khách" (dễ có dấu, dấu phẩy). Tab Xử lý tự ghép
  mọi mã chứng từ (`transferContent`) → nhiều hóa đơn là quá 50 ký tự. Nhiều app ngân hàng từ chối QR.
- Nhập tay: mã ngân hàng nhận chuỗi chữ/số bất kỳ (2–25), số tài khoản tới 25 ký tự → mã ngân hàng
  sai vẫn ra ảnh QR nhưng không quét được. Nhập tay lại là lựa chọn duy nhất khi gặp lỗi 1.1.

### 1.3 Tab Xử lý tự gán VCB TKS

`allocate()` gán `defaultAccountKey = accountKeys[0]` (VCB TKS) cho nguồn không có trong
`sourceAccountMap` và cho chế độ gộp (không VAT), không báo gì → dễ tạo QR vào nhầm tài khoản.

## 2. Quyết định đã chốt

1. QR **không có số tiền vẫn cho tạo** (người chuyển tự nhập) — giữ như hiện nay.
2. Nội dung sau khi chuẩn hóa **dài quá 50 ký tự thì chặn**, bắt người dùng rút gọn (không tự cắt).
3. Nguồn không có tài khoản cấu hình và chế độ gộp không VAT: **bắt chọn tài khoản tay**.
4. Sửa lỗi 1.1 theo hướng **tách danh sách tài khoản khỏi việc đọc Google Sheets**.

## 3. Thiết kế

### 3.1 Danh sách tài khoản luôn có ngay

Máy chủ (`vatDraftRoutes.js`):

- `GET /meta` (qrGuard): luôn trả `{ vietqr: service.accountsMeta() }` ngay, không đọc Sheets, không
  đọc trạng thái đồng bộ — giống nhau cho mọi quyền.
- Thêm `GET /master-data/status` (guard `accounting.vatDraft`): trả `{ masterData, sync }` như phần
  `/meta` cũ đang trả cho Kế toán (`masterDataStatus(false)` + `repository.syncStatus()`).

Trang (`public/vat-draft/vat-draft.js`):

- `loadAccounts()`: gọi `/meta`, lỗi thì tự thử lại tối đa 3 lần (chờ 1 s, 2 s, 4 s). Hết lượt vẫn lỗi:
  ô chọn hiện option vô hiệu "Không tải được danh sách tài khoản" và hiện nút **Thử lại** cạnh ô chọn.
  Thành công thì `renderAccountSelect()` và vẽ lại thẻ QR tab Xử lý nếu đang hiện.
- `loadSheetsStatus()` (chỉ khi `canProcess`): gọi `/master-data/status`, dùng `renderMeta()` hiện có.
  Chạy song song, không chặn `loadAccounts()`.
- `state.meta` tách thành `state.accounts` (danh sách tài khoản + mã ngân hàng thường gặp) và
  `state.status` (masterData + sync). `refreshSheets()` cập nhật `state.status`.
- Hóa đơn đọc xong trước khi có danh sách: khi danh sách về, `renderAccountSelect()` chọn tài khoản
  gợi ý đầu tiên; không tự tạo QR (người dùng bấm Tạo QR).

### 3.2 Chặn QR thiếu thông tin

QR chỉ được tạo và hiện khi đủ 3 điều kiện. Trang khóa nút tạo; máy chủ (`service.qrUrl`) kiểm tra lại
và trả 400 kèm thông báo tiếng Việt nếu sai.

| Điều kiện | Quy tắc |
|---|---|
| Tài khoản | Tài khoản cấu hình: `accountKey` có trong `config.vietqr.accounts`. Nhập tay: mã ngân hàng có trong danh sách ngân hàng VietQR (khớp `code`, `shortName` hoặc `bin`, không phân biệt hoa/thường; máy chủ đổi về `bin` khi dựng URL); số tài khoản khớp `/^[A-Za-z0-9]{1,19}$/`. |
| Nội dung | Chuẩn hóa (mục 3.3). Sau chuẩn hóa > 50 ký tự → chặn. Rỗng được phép. |
| Số tiền | Rỗng / 0 được phép (người chuyển tự nhập). Có số thì nguyên dương, tối đa 13 chữ số. |

Module mới / thay đổi:

- `server/vatDraft/vietqrBanks.js` (mới): danh sách ngân hàng VietQR tĩnh `{ bin, code, shortName, name }`
  lấy một lần từ `https://api.vietqr.io/v2/banks` khi làm; hàm `findBank(input)` trả ngân hàng hoặc null.
  Không gọi API VietQR lúc chạy.
  Danh sách chỉ gồm ngân hàng có `transferSupported = 1` (48 ngân hàng) — người dùng đã xác nhận ngày 13/11/2026;
  ngân hàng khác bị từ chối khi nhập tay.
- `server/vatDraft/vietqr.js`: thêm `normalizeTransferContent(text)` và `MAX_TRANSFER_CONTENT = 50`;
  `isValidManualField` tách thành `isValidAccountNo` (1–19) và kiểm tra mã ngân hàng qua `findBank`;
  thêm kiểm tra số tiền ≤ 13 chữ số.
- `/meta` trả thêm danh sách ngân hàng rút gọn (`code`, `shortName`, `bin`) để trang kiểm tra trước và
  làm gợi ý (`<datalist>`) cho ô Mã ngân hàng nhập tay. Trang và máy chủ dùng chung một danh sách.
- Hàm chuẩn hóa nội dung ở trang chép đúng logic máy chủ (như `manualFieldsValid` hiện tại); test
  trang so khớp hai bên trên cùng bộ mẫu.

Hành vi giao diện:

- Tab Tạo QR: dưới ô Nội dung hiện "Nội dung trong QR: <nội dung đã chuẩn hóa> (n/50)". Quá 50:
  dòng này chuyển màu cảnh báo, `values.reason` = "Nội dung trong QR tối đa 50 ký tự — rút gọn bớt.",
  nút Tạo QR bị khóa. Bỏ `maxlength="200"`; placeholder đổi thành "VD: mã hóa đơn".
- Mã ngân hàng nhập tay không có trong danh sách: lý do "Mã ngân hàng không có trong danh sách VietQR."
  (chỉ hiện sau khi người dùng rời ô / bấm tạo, như quy tắc báo lỗi hiện có).
- Tab Xử lý: ô Nội dung chuyển khoản dùng chung có cùng dòng xem trước và bộ đếm; quá 50 thì mọi nút
  "Tạo mã QR" trong các thẻ bị khóa kèm lý do. Thẻ có ô tài khoản rỗng thì nút đó bị khóa.
- Ảnh QR lỗi tải (`img.onerror`): tab Tạo QR chuyển trạng thái `error` với thông báo
  "Không tải được ảnh QR từ VietQR — thử lại."; ẩn khung ảnh, ẩn nút Sao chép / Tải. Thẻ tab Xử lý
  thay ảnh bằng cùng thông báo.
- QR cũ khi thông tin đổi (trạng thái `stale`) giữ như hiện nay: lớp phủ "Thông tin đã thay đổi",
  nút Sao chép / Tải đã ẩn.

### 3.3 Chuẩn hóa nội dung chuyển khoản

`normalizeTransferContent(text)`:

1. `String(text).normalize('NFD')`, bỏ dấu kết hợp (`̀-ͯ`); `đ/Đ` → `d/D`.
2. Mọi ký tự không phải `A-Z a-z 0-9` → dấu cách.
3. Gộp dấu cách liên tiếp, bỏ dấu cách đầu/cuối.
4. Không cắt. Độ dài so với `MAX_TRANSFER_CONTENT` ở bước kiểm tra.

Máy chủ luôn dựng URL từ nội dung đã chuẩn hóa và trả lại `addInfo` đã chuẩn hóa trong response.

### 3.4 Bắt chọn tài khoản tay ở tab Xử lý

- `allocate()`: `defaultAccountKey` = tài khoản theo `sourceAccountMap`, không có thì `null`
  (bỏ dự phòng `accountKeys[0]`). `total.defaultAccountKey` = `null`.
- `accountOptions()` nhận `placeholder: true` cho thẻ QR tab Xử lý → option "— Chọn tài khoản —"
  được chọn khi `accountKey` rỗng. Nguồn có trong cấu hình vẫn tự chọn như cũ.

## 4. Xử lý lỗi

| Tình huống | Hành vi |
|---|---|
| `/meta` lỗi | Thử lại 3 lần, sau đó nút Thử lại. Chưa có danh sách tài khoản lẫn danh sách ngân hàng nên nút Tạo QR khóa (kể cả nhập tay) tới khi tải được. |
| `/master-data/status` chậm / lỗi | Chỉ ảnh hưởng thanh trạng thái Sheets như hiện nay. |
| `/qr/url` trả 400 | Hiện thông báo lỗi của máy chủ ở trạng thái `error`, không hiện ảnh. |
| Ảnh VietQR không tải | Trạng thái `error`, ẩn ảnh và nút Sao chép / Tải. |

## 5. Kiểm thử

Máy chủ (`node --test`):

- `vatDraftRoutes.test.js`: `/meta` trả danh sách tài khoản khi `masterData.get()` không bao giờ xong;
  `/master-data/status` cần quyền `accounting.vatDraft` (sale bị 403); `/qr/url` trả 400 khi nội dung
  quá 50 ký tự sau chuẩn hóa, mã ngân hàng lạ, số tài khoản > 19 ký tự, số tiền > 13 chữ số.
- `vietqr.test.js`: `normalizeTransferContent` (có dấu, `đ`, dấu phẩy, ký tự đặc biệt, nhiều dấu cách,
  chuỗi rỗng); URL dùng nội dung đã chuẩn hóa; mã ngân hàng nhập tay đổi về BIN.
- `vatDraftService` (qua test routes / service): nguồn lạ và chế độ gộp có `defaultAccountKey = null`.

Trang (`server/test/frontend/vat-draft.test.js`):

- Nút Tạo QR khóa khi chưa chọn tài khoản / nội dung quá 50 ký tự; mở khi hợp lệ, kể cả số tiền rỗng.
- `loadAccounts()` thử lại khi `/meta` lỗi rồi thành công.
- Hàm chuẩn hóa nội dung ở trang cho kết quả giống máy chủ trên cùng bộ mẫu.

Chạy thử: server local chế độ chỉ đọc (`.claude/launch.json`), tạo QR với nội dung có dấu, kiểm tra
URL ảnh và trạng thái nút.

## 6. Ngoài phạm vi

- Tài khoản VIB QUÂN số `044345` (6 số, ngắn bất thường): người dùng tự kiểm tra với người phụ trách;
  sai thì sửa `vatDraftConfig.js` ở PR riêng.
- Bật làm mới ngầm cho cache Google Sheets (không cần cho lỗi này).
- Ghi log mỗi lần tạo QR.

## 7. Tài liệu cần cập nhật khi làm

`server/README.md` (bảng API: `/meta` mới, `/master-data/status`), `README.md` (cập nhật gần nhất),
`docs/02-srs/SRS_Dashboard_GoogleSheets.md` (quy tắc tạo QR), `docs/04-planning/implementation_plan.md`.

---
Cập nhật: 13/11/2026
