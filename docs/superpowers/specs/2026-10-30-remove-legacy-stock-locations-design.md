# Gỡ module Vị trí hàng cũ (đọc Google Sheets), VT Hà Nội / VT Sài Gòn là module duy nhất

Ngày: 2026-10-30. Trạng thái: mã đã sửa trong working tree, chưa commit/deploy. Không migration.

## Bối cảnh
Từ 03/10/2026 hệ thống có module Vị trí hàng đọc hai sheet `Vị trí HN`/`Vị trí SG` của một workbook Google Sheets (từ 17/10/2026 qua bảng `stock_location_lines`, job `sheetSnapshots/sync.js`, migration `0064`): trang `/stock-locations/`, API `GET /api/stock-locations`, quyền `stockLocations.view`. Ngày 27/10/2026 thêm cơ sở dữ liệu Vị trí hàng mới trong Postgres (`stock_positions`, migration `0095`, trang `/vt-positions/`, quyền `stockLocationsV2.*`), seed một lần từ `stock_location_lines` rồi ngắt khỏi Google Sheets, chạy song song hai tab cũ. Chỉ định vị trí trên Vòng đời đơn hàng, prototype nhặt đơn và các báo cáo tồn theo vị trí đều chuyển sang `stock_positions`; hai tab cũ chỉ còn là dữ liệu đóng băng không ai bảo trì nên quyết định gỡ để một nguồn sự thật duy nhất.

## Phạm vi gỡ
- Trang `server/public/stock-locations/` (index.html, stock-locations.js, stock-locations.css) và test giao diện `test/frontend/stock-locations.test.js`.
- Thư mục `server/stockLocations/` (routes, service và test), route `router.use(stockLocationsRoutes)` trong `routes.js`; `GET /api/stock-locations` nay trả 404.
- Khóa quyền `stockLocations.view` và mục `PAGE_FEATURES` `/stock-locations` trong `auth/featureRegistry.js`.
- Hai nguồn đồng bộ `stock_locations_hn`/`stock_locations_sg` trong `sheetSnapshots/sync.js`: `SOURCES` chỉ còn `shipping_measures` (sheet `CÂN ĐO`); `parseMeasureRows` và `normalizeHeader` lấy từ `shipment/measureSheet.js` (xuất thêm `normalizeHeader`).
- Cấu hình `STOCK_LOCATIONS_SHEET_HN`/`_SG` trong `config.js`.
- Mục sidebar "Vị trí HN"/"Vị trí SG" trong `shared-nav.js`; nhóm "Vị trí hàng" chỉ còn "VT Hà Nội"/"VT Sài Gòn" (theo cơ sở người dùng).
- Tài liệu `docs/stock-locations-setup.md` và ghi chú trang `design-system/tks-dashboard/pages/stock-locations.md` (thay bằng `pages/vt-positions.md`).

## Giữ lại / thêm
- Link cũ `/stock-locations`, `/stock-locations/`, `/stock-locations/index.html` → 302 `/vt-positions/` (`legacyPageRedirect` trong `auth/pageGuard.js`, bảng `LEGACY_PAGE_REDIRECTS`, gắn ở `index.js` trước `pageGuard`; chỉ GET/HEAD, header `Cache-Control: no-store`, không chuyển tài nguyên tĩnh; 302 để không ghi nhớ vĩnh viễn).
- Biến `STOCK_LOCATIONS_SPREADSHEET_ID` là tên di sản: `SHIPPING_MEASURE_SPREADSHEET_ID` dự phòng sang nó, workbook nay chỉ phục vụ sheet `CÂN ĐO`. Giữ tên để không làm hỏng cấu hình đã deploy.
- Bảng `stock_location_lines` (migration `0064`, `0095` đọc nó một lần để seed) và hai hàng `stock_locations_hn`/`stock_locations_sg` của `sheet_snapshot_sync` vẫn nằm trong DB, không còn job ghi/đọc.
- `public/vt-positions/vt-base.css` (mới) là CSS khung bảng/tab/thanh tìm chuyển từ `stock-locations.css`; `index.html` của VT tải nó trước `vt-positions.css`.
- Prototype nhặt đơn (`public/prototypes/order-picking/` và `TOKOSI-prototype-nhat-don.html`) đọc `GET /api/stock-positions?branch=HN|SG` (quyền demo `stockLocationsV2.view`) thay cho `/api/stock-locations`; README prototype đã sửa chuỗi tương ứng.

## Phân quyền
| Khóa | Trước | Sau |
|---|---|---|
| `stockLocationsV2.view` | chỉ Quản lý, Khách bị cấm | **mọi vai trò kể cả Khách** (`roles: ALL_ROLES`, `escalationExempt`) |
| `stockLocationsV2.export` | chỉ Quản lý, cần xem | **mọi vai trò kể cả Khách**, vẫn `requires: stockLocationsV2.view` |
| `stockLocationsV2.edit` | chỉ Quản lý | giữ chỉ Quản lý, Khách cấm tường minh (`forbiddenRoles`) |
| `stockLocationsV2.historyDelete` | chỉ Quản lý | giữ chỉ Quản lý, Khách cấm tường minh |

- Khách trước đây bị chặn mọi khóa ngoài `account.profile`, `hr.rules`, `hr.leave`, `hr.leave.submit`; nay danh sách đó là `GUEST_ALLOWED_KEYS` và thêm `stockLocationsV2.view`, `stockLocationsV2.export` (không thêm `edit`/`historyDelete`).
- `escalationExempt` cho `.view`/`.export`: ai cũng có mặc định nên Trợ lý được ủy quyền (đã bị Quản lý tắt xem/xuất) vẫn tạo / đặt lại mật khẩu tài khoản được, không bị chặn leo thang.
- Quản lý vẫn tắt được từng tài khoản trong trang Tài khoản; tắt `.view` thì `.export`, `.edit`, `.historyDelete` mất theo vì `requires`.
- Khóa cũ `stockLocations.view` còn trong `app_users.feature_permissions` bị `sanitizeOverrides` bỏ qua vô hại; không cần migration dọn.
- **Hành vi hiện tại cần biết:** Khách xem được toàn bộ cột VT (SL KiotViet, giữ chỗ/Có thể bốc, ghi chú số thùng, lịch sử chỉnh sửa kèm tên người sửa) theo phạm vi cơ sở của cookie `tks_branch`. Nếu sau này cần giấu bớt cột hoặc tên người sửa với Khách thì phải làm ở API `stockPositionsRoutes.js`, không chỉ ở giao diện.

## Việc treo (chờ người dùng quyết)
1. Migration DROP `stock_location_lines` và `DELETE FROM sheet_snapshot_sync WHERE source IN ('stock_locations_hn','stock_locations_sg')` — chưa làm vì `0064`/`0095` còn nhắc bảng này và bảng là bản lưu lịch sử dữ liệu nguồn của đợt seed.
2. Đổi tên biến `STOCK_LOCATIONS_SPREADSHEET_ID` nếu muốn (phải đổi đồng thời cấu hình Render).
3. 7 test nền đang đỏ, lỗi có từ trước và không do đợt gỡ này (chi tiết ở `CURRENT.md` mục 3): `vt-positions.test.js`/`vt-positions-live.test.js` lệch code VT hiện tại (bộ lọc cảnh báo `#vtWarnFilter`, Xuất Excel GET→POST, SSE tải bù 150ms), `account-work-assignment.test.js` (2 ca), `dashboard-per-view-loading.test.js` (1 ca).

## Kiểm chứng đề xuất sau deploy
- Mở `/stock-locations/`, `/stock-locations/index.html` → 302 sang `/vt-positions/` (giữ nguyên `#hn|#sg` phía trình duyệt); `GET /api/stock-locations` → 404.
- Tài khoản Khách: thấy mục VT trên sidebar, xem và xuất Excel được, không có nút Thêm/Import/Lưu/Xóa/Xóa lịch sử; `PATCH`/`POST import`/`DELETE history` trả 403.
- Tài khoản nhân viên đã bị tắt `stockLocationsV2.view`: trang chuyển về trang được phép đầu tiên; sidebar không có nhóm Vị trí hàng.
- Job `sheetSnapshots` chỉ còn ghi `shipping_measures`; hộp chi tiết đơn Vòng đời vẫn tính được thể tích/cước.

Cập nhật gần nhất: 2026-10-30.
