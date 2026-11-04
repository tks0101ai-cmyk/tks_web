# BỘ LUẬT VẬN HÀNH HỆ THỐNG (CLAUDE CODE / AI ASSISTANT GUIDELINES)

Tài liệu quy định phương thức làm việc, quy chuẩn mã nguồn và quy trình phối hợp cho AI Assistant trong dự án **TOKOSI Dashboard**.

---

## 0. Nguyên tắc tiên quyết: Tham khảo mã nguồn mở trước khi làm

Đối với những chức năng chưa quen thuộc, **đừng viết từ con số 0**. Hãy tìm kiếm các dự án mã nguồn mở trên GitHub để so sánh ý tưởng, cách tổ chức và các bẫy thường gặp trước khi bắt tay làm.

---

## 1. Khởi động phiên làm việc (Startup Checklist)

Mỗi khi bắt đầu một phiên làm việc mới, AI Assistant cần:
1. Đọc và nắm vững bối cảnh tại:
   - [MEMORY.md](MEMORY.md): Bản đồ kiến trúc, nguyên tắc bất biến và các điều cấm kỵ.
   - [CURRENT.md](CURRENT.md): Bảng trạng thái thời gian thực của dự án và các đầu việc cần làm.
   - [README.md](README.md) & [server/README.md](server/README.md): Hướng dẫn kiến trúc, biến môi trường và chạy thử.
   - [server/db/SCHEMA.md](server/db/SCHEMA.md): Hợp đồng dữ liệu schema Postgres (0001–0106).
2. Kiểm tra trạng thái Git hiện tại (`git status`) để đảm bảo không làm việc trên trạng thái bẩn ngoài ý muốn.

---

## 2. Tiêu chuẩn mã nguồn & Quy tắc lập trình (Coding Standards)

- **Ngôn ngữ & Môi trường:**
  - Node.js (v22/v24), Express framework, CommonJS module (`require` / `module.exports`).
  - Frontend: Vanilla HTML, Vanilla CSS (CSS variables / design tokens trong `shared.css`), Vanilla JavaScript.
  - **KHÔNG dùng TailwindCSS**, không dùng framework client-side nặng (React, Vue, Vite, Next.js) trừ khi được yêu cầu rõ ràng.
- **Quy tắc cơ sở dữ liệu:**
  - Phân tách cơ sở rõ ràng: `hanoi` và `saigon`.
  - Cột tiền tệ và số lượng dùng `NUMERIC`.
  - Giờ giấc chuẩn hóa theo giờ Việt Nam (`Asia/Ho_Chi_Minh`, UTC+7).
  - Không xóa vật lý dữ liệu nhân sự (dùng soft-delete `is_active = false`).
- **Xử lý giao diện người dùng:**
  - Áp dụng `table-controls.js` cho các bảng dữ liệu để người dùng có thể ẩn/hiện cột, chỉnh độ rộng cột và phân trang.
  - Giữ giao diện hỗ trợ cả 2 chế độ Sáng (Light) và Tối (Dark).
  - Đảm bảo trải nghiệm responsive trên cả màn hình máy tính và thiết bị di động.

---

## 3. Quy trình cập nhật đồng bộ (Sync & Documentation Rules)

Khi có bất kỳ thay đổi nào về cấu trúc thư mục, thêm/xóa file, module backend mới hoặc migration mới:
1. Tuân thủ tuyệt đối kỹ năng **`update-file`** (`.agents/skills/update-file/SKILL.md`).
2. Luôn cập nhật đồng bộ các file liên quan:
   - `README.md` (cây thư mục ASCII, biến môi trường, danh sách cập nhật gần nhất).
   - `server/README.md` (danh sách migration, bảng mô tả API).
   - `server/db/SCHEMA.md` (danh sách bảng, hợp đồng schema).
   - `docs/04-planning/implementation_plan.md` (kiến trúc đã triển khai).
   - `docs/02-srs/SRS_Dashboard_GoogleSheets.md` & `docs/01-brd/BRD_Dashboard_GoogleSheets.md` (tính năng nghiệp vụ).
   - `CURRENT.md` (trạng thái thời gian thực và việc tiếp theo).
3. Luôn cập nhật ngày cập nhật mới nhất ở cuối các tài liệu.

---

## 4. Kiểm tra trước khi kết thúc (Verification & Teardown)

Trước khi kết thúc phiên hoặc commit code:
1. **Chạy unit tests liên quan phần vừa thay đổi và các phần liên quan có thể bị ảnh hưởng (Dựa vào graphify):**

   Yêu cầu: 100% test xanh (không có lỗi mới phát sinh).
2. **Cập nhật đồ thị mã nguồn (Knowledge Graph):**
   ```powershell
   graphify update .
   ```
   Đảm bảo `graphify-out/` đồng bộ với mã nguồn mới nhất.
3. Cập nhật lại [CURRENT.md](CURRENT.md) để phản ánh chính xác kết quả của phiên làm việc.
