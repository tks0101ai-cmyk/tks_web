# Bảng Khách hàng theo sản phẩm: ba mức màu cho cột Tăng trưởng

Ngày: 06/11/2026 · Trạng thái: chờ người dùng duyệt spec · Bổ sung cho
`2026-11-06-product-customer-growth-section-design.md` (gọi tắt là "spec gốc"); phần nào mâu thuẫn thì spec này thắng.

## 1. Vì sao đổi

Spec gốc chỉ có một mức đỏ: tăng trưởng < −50% thì chữ đỏ kèm nhãn "Cần check". Trên dữ liệu thật (06/11/2026), 19.407 trong
36.909 dòng (53%) rơi vào mức này, phần lớn là khách đã mua ở hai kỳ trước nhưng T.này = 0 (−100%). Vì kỳ là **30 ngày cuốn
chiếu**, không phải tháng dương lịch, T.này = 0 là tín hiệu mạnh nhất và phải tách riêng. Người dùng chốt: ba mức màu, chỉ hiện %,
bỏ nhãn "Cần check", thêm mục lọc "giảm hết 100%".

## 2. Phân nhóm (thay mục 3 của spec gốc)

`prior` = T.trước + T.trước nữa (= 2 × trung bình hai kỳ trước). Chỉ xét khi cả ba kỳ khác NULL. Tất cả so sánh bằng NUMERIC nhân chéo
trong SQL, không dùng số thực.

| Nhóm (`growth_state`) | Điều kiện | Tăng trưởng | Màu chữ |
|---|---|---|---|
| `lost` | `prior > 0` và `r1 <= 0` | ≤ −100% | đỏ |
| `check` | `prior > 0` và `r1 > 0` và `4·r1 < prior` | −100% < g < −50% | cam |
| `drop` | `prior > 0` và `4·r1 >= prior` và `2·r1 < prior` | −50% ≤ g < 0 | vàng |
| `up` | `prior > 0` và `2·r1 >= prior` | g ≥ 0 | không màu |
| `new` | `prior <= 0` và `r1 > 0` | không tính | không màu, nhãn "Mới" |
| NULL | còn lại (`prior <= 0` và `r1 <= 0`, hoặc có kỳ NULL) | không tính | "—" |

- Ranh giới: đúng −50% là vàng (không cam); đúng −100% (T.này = 0) là đỏ; T.này **âm** (trả hàng) với `prior > 0` cũng là đỏ (g < −100%).
- Giá trị `growth` vẫn là `r1·2/prior − 1` (NUMERIC), `NULL` khi `prior <= 0`.
- Các nhóm loại trừ nhau; mỗi dòng thuộc nhiều nhất một nhóm.

## 3. Dropdown "Tăng trưởng" (thay mục 4 của spec gốc)

Sáu mục theo thứ tự, giá trị gửi API trong ngoặc: Tất cả (`all`) · Giảm hết 100% (`lost`) · Giảm hơn 50% (`check`) ·
Giảm dưới 50% (`drop`) · Đang tăng (`up`) · Khách mới (`new`). Mục cũ "Cần check (giảm quá 50%)" đổi tên thành "Giảm hơn 50%" và nay
chỉ là phần cam. Muốn xem cả đỏ lẫn cam thì chọn lần lượt hai mục.

## 4. Hiển thị

- Ô Tăng trưởng chỉ hiện %, bỏ nhãn "Cần check"; giữ nhãn "Mới". Ô có `title` mô tả mức: "Giảm hết 100%", "Giảm hơn 50%", "Giảm dưới 50%".
  Màu chỉ đi kèm số %, không thay thế nó (không dựa riêng vào màu).
- Lớp CSS trên `td`: `is-lost` (đỏ), `is-check` (cam), `is-drop` (vàng); chữ đậm cho `is-lost` và `is-check`.
- Màu dùng token trang, không hard-code hex trong CSS bảng. Trang hiện chỉ có `--red`, `--amber` (và `--green`), nên thêm vào
  `server/public/shared/shared.css` hai token mới, mỗi cái có bản Tối (khối biến đầu file, cạnh `--amber`) và bản Sáng (khối biến chế độ Sáng, cạnh `--amber` thứ hai):
  `--orange` (Tối `#FB923C`, Sáng `#C2410C`) và `--yellow` (Tối `#FACC15`, Sáng `#A16207`). Bản Sáng dùng vàng đậm để đủ tương phản trên nền sáng; cam bản Sáng cũng được làm đậm thành #C2410C vì tương phản (≈5,2:1 trên nền trắng; giá trị đầu #EA580C chỉ ≈3,6:1).
  Đỏ dùng `--red`.
- Dòng trạng thái: `N dòng khớp · A giảm hết 100% · B giảm hơn 50%` (A = số dòng `lost`, B = số dòng `check`, tính trên toàn bộ kết quả đã lọc).
  Không còn chữ "cần check".

## 5. API và xuất file

- `growth_state` có thêm giá trị `lost`; `check` đổi nghĩa như bảng ở mục 2. Tham số `growth` nhận `all|lost|check|drop|up|new`.
- `summary` có `totalRows`, `lostRows` (số dòng `lost`, đỏ) và `checkRows` (giữ tên cũ nhưng nay chỉ đếm `check`, cam). Hai số đếm
  trên toàn bộ kết quả đã lọc, cùng cách đếm `count(*) FILTER` hiện có. Trạng thái "không có dữ liệu" trả `{totalRows:0, lostRows:0, checkRows:0}`.
- Xuất file: `context.growthGroup` nhận `lost`; cột "Trạng thái": Giảm hết 100% / Giảm hơn 50% / Giảm dưới 50% / Đang tăng / Mới;
  ghi chú đầu file thay dòng "Cần check" bằng hai dòng "Giảm hết 100%" và "Giảm hơn 50%" (số dòng); ghi chú "Nhóm tăng trưởng" dùng cùng nhãn.
  `GROWTH_STATUS_LABELS` thêm `lost`, đổi nhãn `check`.
- Thứ tự sắp xếp, độ trễ gõ tìm và các phần còn lại của spec gốc **giữ nguyên** (người dùng chưa chọn đổi sắp xếp phụ hay 300 ms).

## 6. Kiểm thử

- Repository: dữ liệu mẫu thêm ca T.này = 0 (→ `lost`), T.này âm với `prior > 0` (→ `lost`), một ca đúng −50% (→ `drop`), một ca
  −51% (→ `check`); kiểm tra bộ lọc `lost`/`check` loại trừ nhau, `summary.lostRows`/`checkRows`, và `new`/NULL không đổi. Các test cũ
  dùng `check` cho ca −90% và −100% phải sửa theo ý nghĩa mới.
- Giao diện: `growthCellHtml` cho `lost`/`check`/`drop` trả đúng lớp và `title`, không còn `.pcg-flag`; dropdown 6 mục khớp `GROWTH_OPTIONS`;
  `buildQuery`/`exportContext` chấp nhận `lost`; dòng trạng thái mới; test CSS xác nhận ba lớp dùng `var(--red|--orange|--yellow)` và không hex.
- Xuất file: nhãn trạng thái, `growthGroup: 'lost'` hợp lệ, ghi chú đầu file.
- Test khóa token: hai token mới có mặt ở cả khối Tối và Sáng của `shared.css`.
- Kiểm tra trên trình duyệt (server local chỉ đọc): ba màu hiện đúng ở Sáng và Tối, lọc "Giảm hết 100%" ra đúng số dòng, so với `lostRows`.

## 7. Tài liệu cần cập nhật

`CURRENT.md`, `README.md`, `server/README.md` (bảng API: `growth` nhận `lost`, `summary`), `server/db/SCHEMA.md` (không đổi schema),
`docs/04-planning/implementation_plan.md`, SRS, BRD; sửa mục 3–5 của spec gốc bằng một dòng trỏ sang spec này; chạy `graphify update .`.

## 8. Ngoài phạm vi

Đổi sắp xếp phụ khi tăng trưởng hòa nhau; đổi độ trễ gõ tìm; thêm `statement_timeout`; đổi công thức tăng trưởng hay cách tính kỳ.
