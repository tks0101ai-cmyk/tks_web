# Design System Master File — TKS Dashboard

> **LOGIC:** Khi xây dựng một trang hoặc component cụ thể, luôn kiểm tra `design-system/tks-dashboard/pages/[page-name].md` (nếu có).
> Nếu file trang tồn tại, các quy tắc trong đó sẽ **ghi đè (override)** file Master này.
> Nếu không, bắt buộc tuân thủ nghiêm ngặt toàn bộ nguyên tắc và tokens trong file Master bên dưới.

> **📋 Audit toàn diện gần nhất:** 2026-09-15 — rà soát 100% giao diện (7 trang: `index`, `account`, `humanresources`,
> `login`, `register`, `shipment`, `404` + `shared.css`). **Cập nhật 2026-10-05:** trang tra cứu vòng đời nay là
> `shipment/lifecycle/index.html` (trước là `shipment/index.html`) và có thêm trang `stock-locations/` (Vị trí hàng; ĐÃ GỠ 2026-10-30, thay bằng `vt-positions/` — xem `pages/vt-positions.md`)
> và (2026-10-06) `cashbook/` (Sổ quỹ — dựng theo khuôn tab Báo cáo, xem `pages/cashbook.md`);
> trạng thái hiện tại của từng mục nợ ở mục 12 đã được kiểm tra lại bằng grep (bảng "Trạng thái kiểm tra lại" đầu mục 12). Các component mới phát hiện đã được chuẩn hoá vào mục 5;
> sai lệch/nợ thiết kế phát hiện được liệt kê đầy đủ ở **mục 12**. Chi tiết theo từng trang: `pages/*.md`.
> **Cập nhật 2026-10-12:** Thiết kế lại toàn bộ hộp "Xem chi tiết" bằng `public/shared/detail-panel.css` (`.dp-*`), áp dụng cho `index.html`, `shipment/lifecycle/index.html`, `humanresources/index.html`; phân trang chuẩn (`table-controls.js`) cho bảng nhân sự và quản trị tài khoản; 5 luồng vòng đời đơn hàng + 6 cảnh báo có tên + dải KPI đầu trang. **Cập nhật 2026-10-15:** Gỡ nút "Lịch làm việc" khỏi tab Nghỉ phép; Vòng đời bổ sung luồng thứ 6 Kế toán/Chứng từ (`KeToan_ChungTu`) và cột Thể tích + giá cước nhà xe; Tab Công nợ có bảng thưởng/phạt sale đầy đủ.

---

## 1. Metadata & Design DNA

- **Project:** TKS Dashboard (TOKOSI · Live Operations & Inventory Dashboard)
- **Category:** Inventory & Stock Management (Keywords: inventory, stock, warehouse, product, barcode, supply, sku, real-time analytics)
- **Dashboard Style:** Real-Time Monitoring + Data-Dense + Premium Operations
- **Design Dials:** 
  - **Variance:** `6/10` (Modern, Balanced, Curated)
  - **Motion:** `5/10` (Standard, Tactile Micro-Interactions, 150–300ms)
  - **Density:** `8/10` (Dense / Real-time Data Grid)
- **Visual Aesthetic:** **Rich Aesthetics & Visual Excellence** — Tận dụng tối đa bảng màu HSL/HEX tinh lọc, Dark Mode chiều sâu Obsidian, hiệu ứng Glassmorphism & Subtle Gradients và chuyển động Micro-animations sống động. Chiều sâu tạo bằng màu, bóng đổ và khoảng trắng — **không** bằng biến đổi 3D (xem mục 7).

---

## 2. Nguyên Tắc Thiết Kế Cốt Lõi (Core Design Principles)

### 2.1 Rich Aesthetics & Visual Excellence (Thẩm mỹ Cao cấp & Đẳng cấp)
- **Ấn tượng thị giác mạnh mẽ (WOW factor):** Giao diện phải mang lại cảm giác hiện đại, chỉn chu ngay từ cái nhìn đầu tiên với chiều sâu không gian, gradient tinh tế và đường viền phát sáng nhẹ (ambient glow/subtle border).
- **Tránh màu sắc thô, đơn điệu (No Generic Colors):** Tuyệt đối không dùng các màu cơ bản (plain red, plain blue, plain green). Bắt buộc sử dụng bảng màu được phối hợp hài hòa (Curated Palettes: Deep Sapphire, Emerald Green, Warm Amber, Slate Obsidian).
- **Typography hiện đại:** Sử dụng bộ font thương hiệu chuẩn quốc tế kết hợp hỗ trợ tiếng Việt tối đa (`Be Vietnam Pro` cho tiêu đề, `Inter` cho nội dung, `Roboto` cho số liệu tài chính/tồn kho).
- **Không sử dụng hình ảnh/icon tạm bợ (No Placeholders):** Tuyệt đối không dùng emoji làm icon hoặc placeholder sơ sài. Mọi icon phải là SVG chuẩn (Heroicons / Lucide phong cách đồng nhất).

### 2.2 Dynamic & Alive (Giao diện Sống động & Phản hồi Tức thì)
- **Tương tác có chiều sâu (Tactile Micro-interactions):** Mọi nút bấm, thẻ thông tin (card), và hàng trong bảng phải có trạng thái hover, focus, active rõ ràng (lún nút nhẹ, đổi màu nền mượt 150–200ms, viền phát sáng).
- **Phản hồi thời gian thực (Real-Time Feedback):** Trạng thái đồng bộ dữ liệu, spinner tải trang, đồng hồ cập nhật (`last updated`) luôn hiển thị trực quan ở vị trí cố định.

### 2.3 Premium Quality & Data Density (Chất lượng Hoàn thiện & Mật độ Dữ liệu)
- **Tối ưu mật độ thông tin:** Bố cục dạng Dashboard Dense (8/10), thông tin phân cấp mạch lạc, các chỉ số KPI quan trọng nhất (tồn kho nguy cấp, đơn hàng cần xuất) luôn nằm ở vị trí dễ quan sát nhất (above the fold).
- **Không vỡ bố cục khi co giãn:** Layout responsive mượt mà từ Mobile (375px), Tablet (768px), Laptop (1024px) đến Wide Desktop (1440px+).

---

## 3. Technology Stack & Implementation Standards

1. **Cấu trúc & Ngôn ngữ Cốt lõi:**
   - **HTML5:** Cấu trúc ngữ nghĩa chuẩn (Semantic HTML: `<header>`, `<nav>`, `<main>`, `<aside>`, `<section>`, `<article>`, `<footer>`).
   - **CSS:** **Vanilla CSS** với hệ thống CSS Variables (`:root`), Flexbox/Grid, Native Dialog/Popover, `color-mix()`, `:has()`, `:focus-visible`. *Tránh sử dụng TailwindCSS trừ khi có yêu cầu đặc biệt từ người dùng.*
   - **JavaScript:** Vanilla JS ES6+ (không bundler), module hóa rõ ràng, xử lý tác vụ bất đồng bộ tối ưu (`scheduler.yield`, `requestAnimationFrame`, `debounce`/`throttle`).
2. **Hiệu năng & Khả năng tiếp cận (Performance & a11y):**
   - Tuân thủ chuẩn WCAG AA: Độ tương phản văn bản chữ ≥ 4.5:1; viền điều khiển UI ≥ 3:1.
   - Hỗ trợ đầy đủ `@media (prefers-reduced-motion: reduce)` để tắt hoàn toàn hoạt họa phức tạp cho người dùng nhạy cảm chuyển động.
   - Các phần tử tương tác phải có `id` định danh duy nhất phục vụ kiểm thử tự động và điều hướng bàn phím.

---

## 4. Global Design Tokens (Hệ Thống Token Toàn Cục)

### 4.1 Color System (Hệ Màu Chuẩn)

#### Dark Mode (Theme Mặc Định — Obsidian Slate)
| Role | Hex / Value | CSS Variable | Mục đích sử dụng |
|------|-------------|--------------|------------------|
| Background | `#090D16` | `--bg` | Nền canvas toàn trang (Deep Obsidian) |
| Panel / Card | `#111827` | `--panel` | Nền card chính, container, table container |
| Panel 2 | `#1E293B` | `--panel-2` | Nền input, sidebar, dropdown menu, table hover |
| Panel 3 | `#334155` | `--panel-3` | Trạng thái active, chip hover, divider đậm |
| Border | `#26334D` | `--border` | Đường viền chính cho card, table, input |
| Border Subtle | `rgba(255,255,255,0.06)` | `--border-subtle` | Viền ngăn cách nhẹ bên trong card |
| Border Focus / Ring | `#3B82F6` | `--border-focus` / `--blue` | Viền focus bàn phím & active ring |
| Primary Blue | `#3B82F6` | `--primary` | Màu nhấn thương hiệu chính (Sapphire) |
| Primary Gradient | `linear-gradient(135deg, #3B82F6 0%, #2563EB 100%)` | `--primary-gradient` | Nút CTA chính, header highlight |
| Primary Hover | `linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)` | `--primary-hover` | Nút CTA khi hover |
| On Primary Text | `#FFFFFF` | `--primary-text` | Chữ trên nền primary gradient |
| Text Primary | `#F8FAFC` | `--text` | Văn bản chính (Crisp Slate 50, contrast > 10:1) |
| Text Secondary | `#CBD5E1` | `--text-secondary` | Văn bản phụ, nhãn cột (Slate 300) |
| Muted | `#94A3B8` | `--muted` | Ghi chú, placeholder, timestamp (WCAG AA ≥ 4.5:1) |
| Accent Amber | `#F59E0B` | `--amber` | Cảnh báo, tồn kho thấp, scanner barcode |
| Accent Green | `#10B981` | `--green` | Thành công, còn hàng, tăng trưởng dương |
| Accent Red | `#EF4444` | `--red` | Hết hàng, lỗi, thao tác nguy hiểm (Destructive) |
| Accent Purple | `#8B5CF6` | `--purple` | Vai trò Quản lý, badge cấp cao |
| Ambient Glow 1 | `rgba(59,130,246,0.08)` | `--ambient-1` | Vùng sáng xanh nền dịu nhẹ |
| Ambient Glow 2 | `rgba(16,185,129,0.05)` | `--ambient-2` | Vùng sáng xanh lá dịu nhẹ |

#### Light Mode (`:root[data-theme="light"]`)
| Role | Hex / Value | CSS Variable | Mục đích sử dụng |
|------|-------------|--------------|------------------|
| Background | `#F8FAFC` | `--bg` | Nền canvas sáng (Slate 50) |
| Panel / Card | `#FFFFFF` | `--panel` | Nền card trắng tinh |
| Panel 2 | `#F1F5F9` | `--panel-2` | Nền input, hover list, header table |
| Panel 3 | `#E2E8F0` | `--panel-3` | Nền active, chip nền xám |
| Border | `#E2E8F0` | `--border` | Đường viền sáng |
| Border Subtle | `#F1F5F9` | `--border-subtle` | Viền ngăn cách phụ |
| Border Focus / Ring | `#2563EB` | `--border-focus` | Viền focus sáng |
| Primary Blue | `#2563EB` | `--primary` | Xanh dương đậm nét |
| Primary Gradient | `linear-gradient(135deg, #2563EB 0%, #1D4ED8 100%)` | `--primary-gradient` | Nút CTA sáng |
| Primary Hover | `linear-gradient(135deg, #1D4ED8 0%, #1E40AF 100%)` | `--primary-hover` | Nút CTA hover |
| Text Primary | `#0F172A` | `--text` | Văn bản chính (Slate 900) |
| Text Secondary | `#334155` | `--text-secondary` | Văn bản phụ (Slate 700) |
| Muted | `#64748B` | `--muted` | Ghi chú, placeholder (Slate 500) |
| Accent Amber | `#D97706` | `--amber` | Cảnh báo sáng |
| Accent Green | `#059669` | `--green` | Thành công sáng |
| Accent Red | `#DC2626` | `--red` | Hết hàng / Lỗi sáng |
| Accent Purple | `#7C3AED` | `--purple` | Vai trò quản lý sáng |

---

### 4.2 Typography (Hệ Thống Phông Chữ)

- **Display & Heading Font:** `Be Vietnam Pro` (Weights: 600, 700, 800) — Thiết kế cho các tiêu đề `<h1>`–`<h4>`, Action Buttons, Modal Headers; hỗ trợ hoàn hảo dấu tiếng Việt.
- **Body Font:** `Inter` (Weights: 400, 500, 600, 700) — Dành cho văn bản hiển thị chung, nhãn form, bảng dữ liệu mô tả.
- **Data & Numeric Font:** `Roboto` (Weights: 400, 500, 600, 700) — Dành cho số lượng kho, mã SKU, barcode, đơn giá tiền tệ VNĐ, tỷ lệ %, đồng hồ thời gian thực (`font-variant-numeric: tabular-nums`).

```html
<!-- Google Fonts Embed Link -->
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@500;600;700;800&family=IBM+Plex+Mono:wght@500;600;700&family=Inter:wght@400;500;600;700&family=Roboto:wght@400;500;600;700&display=swap" rel="stylesheet">
```

```css
:root {
  --font-display: 'Be Vietnam Pro', sans-serif;
  --font-body: 'Inter', sans-serif;
  --font-data: 'Roboto', sans-serif;
}
```

#### Typography Scale
| Token / Element | Size | Weight | Line Height | Letter Spacing | Font Family |
|-----------------|------|--------|-------------|----------------|-------------|
| `Page Title (h1)` | `22px–26px` | `700–800` | `1.2` | `-0.02em` | `--font-display` |
| `Section Title (h2)` | `18px–20px` | `700` | `1.3` | `-0.01em` | `--font-display` |
| `Card Title (h3)` | `15px–16px` | `600` | `1.4` | `0` | `--font-display` |
| `Body Standard` | `14px` | `400 / 500` | `1.5` | `0` | `--font-body` |
| `Body Small / Meta` | `12px–13px` | `500` | `1.4` | `0` | `--font-body` |
| `KPI Metric Big` | `24px–32px` | `700` | `1.1` | `-0.02em` | `--font-data` |
| `Table Numeric Cell`| `13px–14px` | `600` | `1.4` | `0` | `--font-data` |
| `Badge / Tag Label` | `11px–12px` | `600–700`| `1.0` | `+0.03em` | `--font-body` |

*Quy tắc ngặt nghèo: Không dùng cỡ chữ dưới 12px trên toàn bộ hệ thống để đảm bảo tính dễ đọc.*

---

### 4.3 Spacing Variables (Hệ Thống Khoảng Cách — 8pt/4pt Grid)

| Token | Value | Ứng dụng chính |
|-------|-------|----------------|
| `--space-xs` | `2px` / `0.125rem` | Khoảng cách siêu nhỏ (viền đôi, chấm status) |
| `--space-sm` | `4px` / `0.25rem` | Khoảng cách giữa icon và chữ nhỏ, inline badge |
| `--space-md` | `8px` / `0.5rem` | Khoảng đệm chip, cell bảng dense, gap icon chuẩn |
| `--space-lg` | `12px` / `0.75rem` | Padding input, khoảng cách form-group nhỏ |
| `--space-xl` | `16px` / `1rem` | Padding thẻ Card, khoảng cách giữa các phần tử |
| `--space-2xl` | `24px` / `1.5rem` | Padding container chính, margin header |
| `--space-3xl` | `32px` / `2rem` | Khoảng cách phân cách giữa các Section lớn |

---

### 4.4 Border Radius Scale (Bo Góc)

```css
:root {
  --radius-xs: 6px;    /* Chips, mini badges */
  --radius-sm: 8px;    /* Inputs, select fields, action buttons */
  --radius-md: 10px;   /* Tab buttons, dropdown menus */
  --radius-lg: 12px;   /* KPI cards, data cards */
  --radius-xl: 14px;   /* Large panels, modal dialogs */
  --radius-2xl: 20px;  /* Auth card (login/register), trang lỗi 404 — xem 5.10 */
  --radius-pill: 9999px; /* Status pills, avatar circles, filter pills */
}
```

> ⚠️ **Sai lệch đã phát hiện (audit 2026-09-15):** `index.html` tự định nghĩa một thang bo góc số
> (`--radius-2/4/5/6/7/8/9/10/12/14`) song song với thang ngữ nghĩa ở trên, và `--radius-pill` ở đó
> có giá trị `999px` thay vì `9999px`. Trang mới không được lặp lại kiểu đặt tên số này — luôn dùng
> thang ngữ nghĩa (`--radius-xs…2xl`, `--radius-pill`). Xem mục 12.3.

### 4.4b Token Kênh Màu RGB (RGB-Channel Tokens) — Mẫu dùng cho `rgba(var(--x-rgb), alpha)`

`index.html` giới thiệu một kỹ thuật hữu ích chưa được chuẩn hoá: khai báo riêng phần kênh màu
(không có `rgba()` bọc ngoài) để tái sử dụng ở nhiều độ mờ khác nhau ngay trong CSS, thay vì lặp lại
hằng số màu ở dạng chuỗi. **Khuyến nghị áp dụng chính thức lên `shared.css`:**

```css
:root {
  --shadow-rgb: 0, 0, 0;
  --overlay-rgb: 0, 0, 0;
  --primary-rgb: 59, 130, 246;
  --glow-green-rgb: 16, 185, 129;
  --glow-red-rgb: 239, 68, 68;
}
/* Dùng: box-shadow: 0 8px 20px -8px rgba(var(--shadow-rgb), 0.45); */
```

Đây là cách chuẩn để tạo box-shadow/glow ở nhiều độ mờ khác nhau **mà không hardcode lại mã màu** —
ưu tiên kỹ thuật này thay vì viết `rgba(61, 214, 140, .13)` hay các giá trị rgba rời rạc không truy
được về token nào (xem các vi phạm cụ thể ở mục 12.2).

### 4.4c Token Chữ Tương Phản Trên Nền Đặc (Contrast Text Tokens)

Một số nút/pill dùng nền đặc màu amber hoặc green (không phải nền mờ 12–18%) và cần chữ tối màu để
đủ tương phản. Giá trị này hiện bị hardcode rải rác (`#1B1206` lặp lại 3 lần, `#07150d` 1 lần) —
**chuẩn hoá thành token:**

```css
:root {
  --amber-contrast-text: #1B1206; /* chữ trên nền --amber đặc (nút active period-toggle, search-submit) */
  --green-contrast-text: #07150d; /* chữ trên nền --green đặc (nút export-confirm) */
}
```

---

### 4.5 Elevation, Shadows & Glassmorphism

```css
:root {
  /* Dark Mode Shadows & Elevation */
  --card-shadow: 0 12px 32px -8px rgba(0, 0, 0, 0.5), 0 0 1px 1px rgba(255, 255, 255, 0.06);
  --shadow-modal: 0 20px 50px rgba(0, 0, 0, 0.6), 0 0 1px 1px rgba(255, 255, 255, 0.1);
  --shadow-toast: 0 8px 24px rgba(0, 0, 0, 0.4);
  --shadow-focus-blue: 0 0 0 3px rgba(59, 130, 246, 0.35), 0 0 20px rgba(59, 130, 246, 0.25);
  --shadow-brand: 0 4px 14px rgba(37, 99, 235, 0.35);

  /* Glassmorphism & Backdrop */
  --glass-bg: rgba(17, 24, 39, 0.75);
  --glass-border: rgba(255, 255, 255, 0.08);
  --glass-blur: blur(12px);
}
```

---

## 5. Quy Cách Component Chuẩn (Component Specs)

### 5.1 Buttons (Nút Bấm)

```css
/* Primary CTA Button */
.btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-md);
  padding: 10px 18px;
  background: var(--primary-gradient);
  color: var(--primary-text);
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  border: none;
  border-radius: var(--radius-sm);
  box-shadow: var(--primary-shadow);
  cursor: pointer;
  transition: transform 150ms ease, box-shadow 150ms ease, opacity 150ms ease;
  user-select: none;
}
.btn-primary:hover {
  background: var(--primary-hover);
  transform: translateY(-1px);
  box-shadow: 0 6px 20px 0 rgba(37, 99, 235, 0.45);
}
.btn-primary:active {
  transform: translateY(1px);
  box-shadow: 0 2px 8px 0 rgba(37, 99, 235, 0.3);
}
.btn-primary:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus-blue);
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
  box-shadow: none;
}

/* Secondary Outlined Button */
.btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-md);
  padding: 10px 16px;
  background: var(--panel-2);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 150ms ease, border-color 150ms ease, transform 150ms ease;
}
.btn-secondary:hover {
  background: var(--panel-3);
  border-color: var(--muted);
  transform: translateY(-1px);
}
.btn-secondary:active {
  transform: translateY(1px);
}
```

### 5.2 Cards / Panels / KPI Blocks

```css
.card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: var(--space-xl);
  box-shadow: var(--card-shadow);
  position: relative;
  transition: border-color 200ms ease, transform 200ms ease, box-shadow 200ms ease;
}
.card:hover {
  border-color: rgba(59, 130, 246, 0.35);
}

/* KPI Stat Metric Card */
.kpi-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: var(--space-xs);
}
.kpi-card .kpi-label {
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}
.kpi-card .kpi-value {
  font-family: var(--font-data);
  font-size: 26px;
  font-weight: 700;
  color: var(--text);
}
```

### 5.3 Status Badges & Pills (Kho Hàng & Vận Hành)

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-xs);
  padding: 3px 10px;
  border-radius: var(--radius-pill);
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* Tồn kho an toàn / Đã xuất */
.badge-success, .badge-in-stock {
  color: #34d399;
  background: rgba(16, 185, 129, 0.14);
  border: 1px solid rgba(16, 185, 129, 0.3);
}

/* Tồn kho thấp / Cảnh báo */
.badge-warning, .badge-low-stock {
  color: #fbbf24;
  background: rgba(245, 158, 11, 0.14);
  border: 1px solid rgba(245, 158, 11, 0.3);
}

/* Hết hàng / Lỗi / Hủy */
.badge-danger, .badge-out-of-stock {
  color: #f87171;
  background: rgba(239, 68, 68, 0.14);
  border: 1px solid rgba(239, 68, 68, 0.3);
}

/* Thông tin / Đang xử lý */
.badge-info, .badge-pending {
  color: #60a5fa;
  background: rgba(59, 130, 246, 0.14);
  border: 1px solid rgba(59, 130, 246, 0.3);
}
```

### 5.4 Form Controls & Inputs

```css
.form-input, .form-select {
  width: 100%;
  padding: 10px 14px;
  background: var(--panel-2);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: none;
  transition: border-color 150ms ease, box-shadow 150ms ease;
}
.form-input:focus, .form-select:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.2);
}
.form-input::placeholder {
  color: var(--muted);
}
.form-input:disabled {
  opacity: 0.6;
  background: var(--panel-3);
  cursor: not-allowed;
}
```

### 5.5 Data Tables (Bảng Dữ Liệu Dense)

- **Sticky Header:** Cố định tiêu đề bảng khi cuộn dọc (`position: sticky; top: 0; z-index: 10;`).
- **Nền Header:** Sử dụng `var(--panel-2)` với chữ `var(--text-secondary)`, `font-weight: 600`, viết hoa nhẹ (`text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em;`).
- **Dòng dữ liệu (Row Hover):** Hover đổi nền mượt mà sang `var(--panel-2)` hoặc `var(--surface-hover)`. Không tạo bóng nâng dòng làm lệch layout.
- **Cột Số liệu & Mã:** Căn phải (`text-align: right;`), dùng `font-family: var(--font-data); font-variant-numeric: tabular-nums;`.
- **Target tương tác:** Nút xem chi tiết, sao chép mã SKU, thao tác phải có kích thước tối thiểu 40×40px (desktop) và 44×44px (mobile).

```css
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-family: var(--font-body);
  font-size: 13px;
}
.data-table th {
  position: sticky;
  top: 0;
  background: var(--panel-2);
  color: var(--text-secondary);
  font-weight: 600;
  text-transform: uppercase;
  font-size: 11px;
  letter-spacing: 0.05em;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}
.data-table td {
  padding: 10px 14px;
  border-bottom: 1px solid var(--row-divider);
  color: var(--text);
  vertical-align: middle;
}
.data-table tbody tr {
  transition: background-color 100ms ease;
}
.data-table tbody tr:hover {
  background: var(--panel-2);
}
.data-table .col-numeric {
  text-align: right;
  font-family: var(--font-data);
  font-weight: 600;
}
```

### 5.6 Role Badges & Status Pills (Huy Hiệu Vai Trò & Trạng Thái)

Các token màu theo vai trò/trạng thái (`--role-*-bg/fg/border`, `--status-*-bg`) đã tồn tại toàn cục
trong `shared.css` `:root`, nhưng component (`.role-badge`, `.status-pill` và các biến thể) hiện bị
**lặp lại y hệt** ở `account/index.html` và `humanresources/index.html`. Chuẩn hoá tại đây, khuyến
nghị đưa nguyên khối này vào `shared.css` để chỉ còn một nguồn duy nhất:

```css
.role-badge, .status-pill {
  display: inline-flex; align-items: center; gap: var(--space-xs);
  padding: 3px 10px; border-radius: var(--radius-pill);
  font-size: 12px; font-weight: 600; border: 1px solid transparent;
}
.role-quan-ly { background: var(--role-quan-ly-bg); color: var(--role-quan-ly-fg); border-color: var(--role-quan-ly-border); }
/* ... một khối tương tự cho: ke-toan, truong-kho, tro-ly, lai-xe,
   nhan-vien-kho, nhan-vien-sale, nhan-vien-mua-hang, khach ── xem token đầy đủ ở mục 4.1 */

.status-active  { background: var(--status-active-bg);  color: var(--green); }
.status-locked  { background: var(--status-locked-bg);  color: var(--red); }
.status-pending { background: var(--status-pending-bg); color: var(--amber); }
```

> ⚠️ `account/index.html` dùng `.status-inactive{ background:rgba(148,163,184,.12); border:1px solid
> rgba(148,163,184,.25); }` — màu này **không tham chiếu token nào**. Khi chuẩn hoá component, bổ
> sung `--status-inactive-bg: rgba(148,163,184,.12)` vào `shared.css :root` thay vì giữ giá trị rời.

#### 5.6b Editable Status Select (Trạng thái có thể chỉnh sửa trực tiếp)

Pattern mới, chất lượng tốt, xuất hiện ở `humanresources/index.html`: một `<select>` gốc được style
lại (`appearance:none` + mũi tên SVG data-URI riêng cho từng màu trạng thái) để trông như status pill
nhưng vẫn thao tác được bằng bàn phím/chuột như select thường — **ưu tiên pattern này** cho mọi nơi
cần đổi trạng thái ngay trong bảng (thay vì mở modal riêng).

```css
.status-select {
  appearance: none; -webkit-appearance: none;
  padding: 4px 28px 4px 10px; border-radius: var(--radius-pill);
  font-size: 12px; font-weight: 600; cursor: pointer;
  background-repeat: no-repeat; background-position: right 8px center; background-size: 12px;
  border: 1px solid color-mix(in srgb, var(--accent-color) 40%, transparent);
}
/* .leave-pending, .leave-approved, .leave-rejected, .leave-violation:
   mỗi biến thể đổi --accent-color (var(--amber)/--green/--red) + SVG chevron cùng màu */
```

Kỹ thuật `border-color: color-mix(in srgb, var(--X) 40%, transparent)` được **chấp thuận chính thức**
làm cách tạo viền/nền tinh chỉnh độ mờ từ token màu gốc — ưu tiên hơn viết `rgba()` cố định mới.

### 5.7 Modal Dialog (Hộp Thoại — Chuẩn Chung)

Bốn nơi (`account`, `humanresources`, `login`, `index` — export modal) đang tự triển khai modal
gần như giống hệt nhau (`.modal-overlay/.modal-box/.modal-header/.modal-body/.modal-footer`), tách
biệt với modal hồ sơ cá nhân dùng chung (`.tks-profile-overlay/.tks-profile-dialog` trong
`shared.css`). **Chuẩn hoá một component modal duy nhất** và đưa vào `shared.css`:

```css
.modal-overlay{
  position: fixed; inset: 0; z-index: 200;
  background: var(--overlay-bg); /* KHÔNG backdrop-filter — xem mục 7.1 và 12.1 */
  display: flex; align-items: center; justify-content: center; padding: var(--space-xl);
}
.modal-box{
  width: 100%; max-width: 480px; max-height: calc(100vh - var(--space-3xl) * 2);
  overflow-y: auto; background: var(--panel); border: 1px solid var(--border);
  border-radius: var(--radius-xl); box-shadow: var(--shadow-modal);
}
.modal-header{ display:flex; align-items:center; justify-content:space-between;
  padding: var(--space-lg) var(--space-xl); border-bottom: 1px solid var(--border); }
.modal-body{ padding: var(--space-xl); }
.modal-footer{ display:flex; justify-content:flex-end; gap: var(--space-md);
  padding: var(--space-lg) var(--space-xl); border-top: 1px solid var(--border); }
```

**Quy tắc bắt buộc:** `.modal-overlay` chỉ dùng `background: var(--overlay-bg)` (nền đặc/bán trong
suốt), **tuyệt đối không thêm `backdrop-filter`** — đây là overlay toàn màn hình, thuộc đúng nhóm bị
cấm ở mục 7.1. Bốn bản triển khai hiện tại của `.modal-overlay` đều đang vi phạm quy tắc này bằng
`backdrop-filter: blur(3px)` (xem mục 12.1 để biết vị trí chính xác cần sửa).

### 5.8 Toast Notifications (Thông Báo Nổi)

Thay thế `window.alert()`, xuất hiện độc lập ở `index.html` (`.tks-toast-*`), `account` và
`humanresources` (`.toast-*`) — cùng ý tưởng, tên class khác nhau. Chuẩn hoá:

```css
.toast-container{ position: fixed; top: var(--space-xl); right: var(--space-xl); z-index: 500;
  display: flex; flex-direction: column; gap: var(--space-md); }
.toast{
  min-width: 260px; max-width: 360px; padding: var(--space-lg) var(--space-xl);
  border-radius: var(--radius-md); box-shadow: var(--shadow-toast);
  font-size: 13px; font-weight: 600;
  animation: toastSlideIn .25s var(--ease-out);
}
.toast-success{ background: var(--toast-success-bg); color: var(--toast-success-fg); border: 1px solid var(--toast-success-border); }
.toast-error{ background: var(--toast-error-bg); color: var(--toast-error-fg); border: 1px solid var(--toast-error-border); }
@keyframes toastSlideIn{ from{ opacity:0; transform: translateY(20px); } to{ opacity:1; transform: translateY(0); } }
```

Animation chỉ dùng `opacity` + `translateY` — tuân thủ mục 6.1. Khi ẩn toast bằng JS, luôn liệt kê
thuộc tính cụ thể (`transition: opacity .3s, transform .3s`), không dùng `transition: all`.

### 5.9 Sub-nav Tabs (Tab Gạch Chân)

Pattern tab chuyển view trong cùng một trang (VD: `account-subnav`, `hr-subnav`), dùng chung ý tưởng
gạch chân dưới tab active — xuất hiện độc lập ở `account` và `humanresources`, nên chuẩn hoá 1 lần:

```css
.subnav-tabs{ display:flex; gap: var(--space-xl); border-bottom: 1px solid var(--canvas-subnav-border); margin-bottom: var(--space-xl); }
.subnav-tab{
  padding: var(--space-md) 0; border: none; border-bottom: 2px solid transparent;
  border-radius: var(--radius-xs) var(--radius-xs) 0 0;
  background: none; color: var(--canvas-text); font-family: var(--font-body); font-size: 13.5px; font-weight: 600;
  cursor: pointer; transition: color .15s ease, border-color .15s ease, opacity .15s ease;
}
.subnav-tab.active{ color: var(--canvas-text); border-bottom-color: var(--blue); font-weight: 700; }
```

`account/index.html` và `humanresources/index.html` dùng 2 tên class song song
(`account-subnav-item`/`subnav-tab`, `hr-subnav-item`/`subnav-tab`) — giữ `subnav-tab` làm tên chuẩn
duy nhất khi viết trang mới; các tên cũ chỉ nên còn lại như alias tương thích ngược.

### 5.10 Auth Card (Khung Thẻ Xác Thực — Login / Register / 404)

`login-card`, `register-card` và `card-404` đều dùng chung một "khung" thị giác — bo góc 20px, đệm
rộng, đổ bóng sâu, backdrop-blur nhẹ (không phải overlay toàn màn hình nên `backdrop-filter` ở đây
được **chấp nhận**, khác với modal ở mục 5.7). Chuẩn hoá làm `--radius-2xl` (mục 4.4):

```css
.auth-card{
  width:100%; max-width: 400px;
  padding: 36px 30px 30px; border-radius: var(--radius-2xl);
  background: var(--panel); border: 1px solid var(--border);
  box-shadow: var(--card-shadow); backdrop-filter: blur(12px);
}
```

**Khối "buộc sáng" (forced-light):** `login-card` ghi đè ~25 biến `:root[data-theme="light"]` ngay
trên chính nó để card luôn hiển thị sáng bất kể theme trang đang là gì — trong khi `register` đạt
cùng hiệu ứng đơn giản hơn bằng `<html data-theme="light">` toàn trang. **Khuyến nghị:** hợp nhất về
một cách duy nhất (ưu tiên cách của `register` — gắn `data-theme="light"` ở gốc trang — vì không phải
lặp lại thủ công toàn bộ bảng token màu sáng mỗi khi bảng màu gốc thay đổi).

### 5.11 OTP Input (Ô Nhập Mã OTP)

```css
.otp-code-input{
  font-family: var(--font-data); font-size: 22px; font-weight: 700;
  letter-spacing: 6px; text-align: center;
}
```

Component sạch, dùng đúng font số liệu — giữ nguyên làm chuẩn cho mọi luồng xác thực 2 bước sau này.

### 5.12 Textarea (Vùng Nhập Nhiều Dòng)

`shared.css` mục 5.4 mới chỉ định nghĩa `.form-input`/`.form-select`, thiếu biến thể `<textarea>`.
Chuẩn hoá bổ sung (đồng bộ với input, không tạo bo góc/breakpoint riêng như `shipment` đang làm với
`border-radius:12px` lệch thang):

```css
.form-textarea{
  width: 100%; min-height: 130px; padding: 10px 14px;
  background: var(--panel-2); color: var(--text); font-family: var(--font-data);
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  resize: vertical; transition: border-color .15s ease, box-shadow .15s ease;
}
.form-textarea:focus{ border-color: var(--border-focus); box-shadow: var(--shadow-focus-blue); }
```

### 5.13 Sortable Table Header (Cột Bảng Có Thể Sắp Xếp)

Xuất hiện độc lập ở `index.html` và `humanresources/index.html` — chuẩn hoá:

```css
th.sortable{ cursor: pointer; }
.sort-button{ display:inline-flex; align-items:center; gap:4px; background:none; border:none;
  color: var(--text-secondary); font: inherit; cursor: pointer; transition: color .15s ease; }
.sort-button:focus-visible{ outline:2px solid var(--blue); outline-offset:2px; }
th[aria-sort="ascending"] .sort-button,
th[aria-sort="descending"] .sort-button{ color: var(--amber); font-weight:700; }
```

### 5.14 Dashboard Grid System (`.grid` / `.col-*`)

`index.html` định nghĩa một hệ lưới 12 cột dùng xuyên suốt dashboard, chưa có trong tài liệu — chuẩn
hoá làm hệ lưới chính thức cho mọi trang data-dense mới:

```css
.grid{ display:grid; grid-template-columns: repeat(12, 1fr); gap: var(--space-xl); }
.col-3{ grid-column: span 3; } .col-4{ grid-column: span 4; } .col-5{ grid-column: span 5; }
.col-6{ grid-column: span 6; } .col-7{ grid-column: span 7; } .col-8{ grid-column: span 8; }
.col-12{ grid-column: span 12; }
@media (max-width: 1180px){ [class^="col-"]{ grid-column: span 6; } }
@media (max-width: 760px){ [class^="col-"]{ grid-column: span 12; } }
```

Kỹ thuật CSS Grid `subgrid` (`grid-template-rows: subgrid`) dùng trong `.filterbar` để canh hàng
label/input theo cột — được **chấp thuận** làm kỹ thuật nâng cao cho các thanh filter phức tạp.

### 5.15 Chart Container Heights (Khung Biểu Đồ)

`index.html` hiện dùng 7 giá trị chiều cao cố định khác nhau cho `.chart-box` (220/260/300/340/380/
420/460px) không theo thang nào. **Chuẩn hoá 4 mức** cho trang mới, tránh phát sinh thêm số lẻ:

| Modifier | Height | Dùng cho |
|---|---|---|
| `.chart-box.small` | `240px` | Biểu đồ phụ, sparkline trong card |
| `.chart-box` (mặc định) | `300px` | Biểu đồ tiêu chuẩn 1 cột |
| `.chart-box.wide` | `340px` | Biểu đồ 2 cột (grid-2) |
| `.chart-box.tall` | `420px` | Biểu đồ chi tiết, nhiều series |

### 5.16 Row Update Flash (Hiệu Ứng Nhấp Nháy Dòng Vừa Cập Nhật)

```css
@keyframes rowPulseHighlight{
  0%{ background-color: var(--accent-blue-18); }
  100%{ background-color: transparent; }
}
.row-highlight-update{ animation: rowPulseHighlight 1.2s ease-out; }
```

Chỉ animate `background-color` — an toàn về hiệu năng trên bảng nhiều dòng, dùng làm phản hồi trực
quan chuẩn khi một dòng dữ liệu vừa được cập nhật qua real-time sync (khớp mục 2.2).

### 5.17 Trang "Tài liệu in" (Printable Document Surface) — Ngoại lệ có chủ đích

`humanresources/index.html` có khối `.doc-page` hiển thị văn bản chính sách (VD: Chính sách nghỉ
phép) mô phỏng một trang giấy in — dùng `font-family:'Noto Serif', Georgia, serif` và bảng màu
**hardcode cố định** (`#fdfcf9`, `#23262f`, `#14161c`, `#d8d5cb`...) thay vì token `--panel`/`--text`.
**Đây là ngoại lệ được chấp thuận, không phải lỗi**: nội dung dạng "giấy in" phải giữ nguyên màu sắc
bất kể Dark/Light Mode của app, giống nguyên tắc "buộc sáng" ở mục 5.10. Không áp token theme lên
`.doc-page` và các phần tử con của nó.

### 5.18 Detail Panel (Khung "Xem Chi Tiết" Dùng Chung — `detail-panel.css`)

Áp dụng đồng bộ cho các hộp xem chi tiết pop-up/slide-over trên toàn hệ thống (Báo cáo tổng hợp, Vòng đời đơn hàng, Nhân sự, Báo cáo Marketing, Báo cáo kinh doanh):
- **File:** `server/public/shared/detail-panel.css` — import bằng thẻ `<link>` trong trang cần dùng, không chép vào `<style>` nội tuyến.
- **Tiền tố lớp (Prefix):** `.dp-*`
  - `.dp-head`: Đầu hộp gồm kicker (`.dp-kicker`), tiêu đề (`.dp-title`), phân loại (`.dp-title-kind`), phụ đề (`.dp-subtitle`) và nút đóng (`.dp-close`).
  - `.dp-stats`: Dải thẻ **chỉ số tổng quan** ở đầu thân hộp (`.dp-stat`, `.dp-stat-label`, `.dp-stat-value`, `.dp-stat-sub`; hỗ trợ modifier màu `.is-green`, `.is-amber`, `.is-red`, `.is-blue`).
  - `.dp-card` / `.dp-section`: Các khối thông tin, thuộc tính (`.dp-meta`), ghi chú (`.dp-note-text`).
  - `.dp-table-wrap` / `.dp-table`: Bảng dữ liệu trong hộp.
- **Quy tắc bắt buộc:**
  1. **Một khung cuộn duy nhất:** Bảng bên trong hộp có tiêu đề dính (`position: sticky; top: 0`), không tạo hai thanh cuộn lồng nhau.
  2. **Tắt nút Cột hiển thị:** Mọi bảng trong panel chi tiết bắt buộc đặt `data-table-controls="off"` — không hiển thị nút "Cột hiển thị" để giữ giao diện xem chi tiết tinh gọn và tập trung.
  3. **Không dùng hiệu ứng 3D:** Sử dụng biến token màu và bo góc có sẵn của hệ thống (`shared.css`), tự động tương thích Dark/Light Mode.
  4. **Responsive điện thoại:** Panel tự co thành bottom-sheet hoặc full-screen trên màn ≤ 600px; bảng cuộn ngang trong `.dp-table-wrap` khi thiếu chiều rộng.

### 5.19 Lifecycle KPI Strip (Dải Thẻ Chỉ Số Tổng Quan — Vòng Đời Đơn Hàng)

Pattern xuất hiện ở `shipment/lifecycle/index.html`: dải thẻ đếm nhanh đầu bảng, bấm thẻ = lọc bảng, bấm lại = bỏ lọc.

```css
.lc-kpi-grid  { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: var(--space-md); }
.lc-kpi-card  { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-md);
                padding: 10px 14px; cursor: pointer; transition: border-color .15s ease, background .15s ease; }
.lc-kpi-card:hover { border-color: rgba(59,130,246,.4); background: var(--panel-2); }
.lc-kpi-card.is-active { border-color: var(--primary); background: rgba(59,130,246,.1); }
.lc-kpi-card .kpi-label { font-size: 11px; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: .05em; }
.lc-kpi-card .kpi-value { font-family: var(--font-data); font-size: 22px; font-weight: 700; color: var(--text); }
```

Quy tắc: API luôn trả `kpis: { status, warnings }` kèm kết quả chính; thẻ trạng thái bỏ lọc `status`, thẻ cảnh báo bỏ lọc `warning` — tính trong RAM, không truy vấn DB thêm.

---

## 6. Motion & Micro-Interactions (Chuyển Động & Hiệu Ứng)

**Cập nhật được duyệt 24/10/2026:** `public/shared/motion.js` thêm hiệu ứng xuất hiện trên các trang hiện có. Chỉ thêm chuyển động, giữ nguyên toàn bộ ảnh nền/hiệu ứng nền, CSS, màu, bố cục, cấu trúc bảng và dữ liệu. Tiêu đề rơi/nảy từng chữ 40ms; KPI lật Y lần đầu, cách nhau 150ms; panel/dòng bảng hiện nhẹ. Count-up là lớp hiển thị tạm, không sửa số liệu thật; tự dọn khi dữ liệu đổi. Chỉ chạy lần đầu khi phần tử xuất hiện, dòng bảng tối đa 12, tôn trọng `prefers-reduced-motion`. Ngoại lệ duy nhất cho mục 7.1 là phép lật KPI ngắn bằng Web Animations API; không thêm 3D vào CSS, hover, nền hoặc dòng bảng; không giữ layer/transform sau hiệu ứng.

### 6.1 Chuẩn Hoạt Họa Giao Diện
- **Thời lượng tiêu chuẩn:** `150ms – 300ms` (không vượt quá 300ms cho các tương tác UI nhằm tránh cảm giác chậm chạp).
- **Ngoại lệ — Hoạt họa xuất hiện trang (page-entrance):** hoạt họa chạy **một lần duy nhất** khi trang
  vừa tải (VD: `.card-404` dùng `cardIn .55s`) được phép vượt trần 300ms vì không phải phản hồi tương
  tác lặp lại; luôn dùng `var(--ease-out)` và luôn tôn trọng `prefers-reduced-motion` (mục 6.2).
- **Easing Curve:** `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)` cho phản hồi tự nhiên, sắc nét. Luôn
  tham chiếu `var(--ease-out)`, không hardcode lại chuỗi `cubic-bezier(...)` (xem mục 12.3).
- **Giới hạn Transform:** Chỉ sử dụng `translateY(-1px đến -2px)`, `scale(0.98)` (active), `opacity` và `backgroundColor`. Tuyệt đối tránh scale lớn làm biến dạng bố cục lưới.
- **Nền màu hover tinh chỉnh độ mờ:** dùng `color-mix(in srgb, var(--token) X%, var(--panel-2))` để tạo
  nền hover pha trộn (VD: `.clear-button:hover`) — **được chấp thuận**, ưu tiên hơn viết một giá trị
  `rgba()` mới không truy được về token gốc.

### 6.2 Hỗ Trợ Giảm Chuyển Động (Reduced Motion)
Bắt buộc áp dụng toàn diện trên tất cả các file CSS và Script:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 7. Ràng Buộc Hiệu Năng Giao Diện (Frontend Performance Constraints)

Hệ thống **từng có** một lớp "Progressive Enhancement 3D" (Three.js particle background, card tilt,
3D loading cube, FPS monitor). Lớp này **đã bị gỡ bỏ hoàn toàn khỏi mã nguồn** vì làm dashboard
giật nặng trên máy cấu hình phổ thông. Mọi thiết kế mới phải tuân thủ các ràng buộc dưới đây.

### 7.1. Cấm trong CSS

| Cấm | Lý do |
|---|---|
| `transform-style: preserve-3d` | Đẩy phần tử thành compositor layer riêng. Rule cũ áp lên `tbody tr` (100 dòng/trang) là thủ phạm giật nặng nhất. |
| `perspective`, `perspective-origin` | Tạo ngữ cảnh 3D, kéo theo chi phí layer như trên. |
| `translateZ()`, `rotateX()`, `rotateY()`, `perspective()` | Biến đổi 3D trên phần tử lặp lại nhiều lần. |
| `background-attachment: fixed` | Buộc vẽ lại toàn viewport (kể cả scale lại ảnh cover) trên **mỗi frame cuộn**. |
| `backdrop-filter` trên overlay toàn màn hình | Blur cả viewport; `.loading-veil` hiện lên ở mỗi lần auto-refresh. |
| `transition: all` | Buộc trình duyệt kiểm tra mọi thuộc tính animatable mỗi khi style đổi. Luôn liệt kê tên thuộc tính cụ thể. |

### 7.2. Cách làm thay thế

- **Hover card/KPI:** `box-shadow` + `border-color`. Không transform.
- **Hover dòng bảng:** chỉ `background-color`. Bảng ở đây thường xuyên 100 dòng — đây là rule CSS "nóng" nhất trang.
- **Focus input:** `box-shadow: 0 0 0 3px <màu>` làm focus ring. Không scale, không glow nhiều lớp.
- **Nút bấm:** `translateY(-2px)` khi hover và `translateY(1px)` khi `:active` là chấp nhận được — transform 2D
  trên số lượng phần tử nhỏ, được compositor xử lý rẻ.
- **Nền trang:** vẽ một lần vào lớp `body::before` (`position: fixed; z-index: -1`), không dùng
  `background-attachment: fixed` trên `<body>`.
- **Loading:** spinner CSS xoay đơn giản (`.loader-spinner` trong `shared.css`), markup tĩnh trong HTML —
  không sinh bằng JS lúc runtime.

### 7.3. Khóa bằng test

Các ràng buộc mục 7.1 được kiểm tra tự động ở
[`server/test/frontend/no-3d-effects.test.js`](../../server/test/frontend/no-3d-effects.test.js).
Test quét toàn bộ `shared.css` và 9 trang HTML; thêm lại bất kỳ khai báo nào ở trên sẽ làm test fail.

---

## 8. Quy Trình Thực Hiện (Implementation Workflow)

Mỗi khi phát triển hoặc cập nhật trang/component mới, tuân thủ 5 bước chuẩn hóa:

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Plan & Understand                                        │
│    - Xác định rõ yêu cầu nghiệp vụ, vai trò người dùng       │
│    - Phân tích bố cục Data-Dense & các chỉ số KPI ưu tiên   │
├─────────────────────────────────────────────────────────────┤
│ 2. Build the Foundation                                     │
│    - Sử dụng chuẩn CSS variables từ MASTER.md & shared.css  │
│    - Định hình Typography, Grid Layout, Spacing Tokens      │
├─────────────────────────────────────────────────────────────┤
│ 3. Create Components                                        │
│    - Viết các component tái sử dụng (Button, Card, Badge)   │
│    - Không dùng style inline ad-hoc; tuân thủ token chuẩn   │
├─────────────────────────────────────────────────────────────┤
│ 4. Assemble Pages & Responsive Layout                       │
│    - Tích hợp vào khung tổng thể (Sidebar + Header + Body)  │
│    - Kiểm thử hiển thị trên 375px, 768px, 1024px, 1440px    │
├─────────────────────────────────────────────────────────────┤
│ 5. Polish, Optimize & Accessibility                         │
│    - Thêm micro-interactions & feedback xúc giác            │
│    - Kiểm tra WCAG AA ≥ 4.5:1, keyboard navigation, INP/LCP │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Tiêu Chuẩn SEO & Web Standards

Áp dụng tự động trên toàn bộ các trang:
- **Heading Structure:** Duy nhất một thẻ `<h1>` trên mỗi trang biểu thị tiêu đề chức năng chính; các tiêu đề phụ phân cấp hợp lý `<h2>` → `<h3>` → `<h4>`.
- **Title & Meta Tags:** `<title>` mô tả chính xác trang (Ví dụ: `Tồn Kho & Quản Lý SKU | TKS Dashboard`); có thẻ `<meta name="description">` tóm tắt mục đích trang.
- **Semantic HTML5:** Sử dụng đúng thẻ ngữ nghĩa (`<main>`, `<nav>`, `<aside>`, `<section>`, `<article>`, `<header>`, `<footer>`).
- **Unique IDs:** Đảm bảo tất cả các nút bấm, input, modal, menu trigger đều có `id` duy nhất phục vụ điều hướng a11y và automation testing.
- **Tối ưu tốc độ tải trang:** Giảm thiểu blocking render, nén tài nguyên hình ảnh, dùng font-display swap.

---

## 10. Anti-Patterns (Những Điều TUYỆT ĐỐI KHÔNG Làm)

- ❌ **Không dùng Emojis thay cho icons:** Luôn sử dụng icon SVG (Heroicons/Lucide phong cách nhất quán).
- ❌ **Không quên `cursor: pointer`:** Tất cả phần tử có tương tác click (nút, tab, hàng bảng có thể mở chi tiết, chip filter) bắt buộc phải có `cursor: pointer`.
- ❌ **Không dùng màu sắc cơ bản sơ sài (Plain Colors):** Tránh các mã màu nguyên bản `#ff0000`, `#00ff00`, `#0000ff`. Phải dùng đúng hệ token (`--red`, `--green`, `--blue`).
- ❌ **Không gây giật bố cục khi Hover (Layout-shifting):** Tuyệt đối không dùng `margin`/`padding`/`border-width` biến thiên khi hover; chỉ dùng `transform` hoặc `backgroundColor`.
- ❌ **Không tạo độ tương phản kém (Low Contrast):** Màu chữ trên nền phải đạt tối thiểu `4.5:1` (WCAG AA).
- ❌ **Không ẩn outline Focus bàn phím:** Giữ nguyên `:focus-visible` với vòng sáng xanh rõ nét (`var(--shadow-focus-blue)`).
- ❌ **Không dùng biến đổi 3D hoặc `background-attachment: fixed`:** Xem danh sách cấm đầy đủ và lý do ở mục 7.1.

---

## 11. Pre-Delivery Checklist (Bảng Kiểm Tra Trước Khi Bàn Giao UI)

Trước khi nghiệm thu bất kỳ giao diện nào, lập trình viên phải kiểm tra đủ các mục sau:

- [ ] **Icon đồng bộ:** Toàn bộ icon là SVG nội tuyến hoặc SVG sprite, không có emoji.
- [ ] **Màu sắc & Token:** 100% màu sắc và khoảng cách sử dụng CSS Variables chuẩn từ `MASTER.md` / `shared.css`.
- [ ] **Độ tương phản:** Đạt chuẩn WCAG AA (chữ thường ≥ 4.5:1, chữ lớn & icon ≥ 3:1).
- [ ] **Tương tác chuột:** `cursor: pointer` đầy đủ trên mọi phần tử bấm được.
- [ ] **Tương tác bàn phím:** Điều hướng phím Tab mượt mà, `:focus-visible` sáng rõ.
- [ ] **Hoạt họa:** Mượt mà (150–300ms), hỗ trợ tắt tức thì khi có `prefers-reduced-motion: reduce`.
- [ ] **Responsive:** Kiểm thử hiển thị không lỗi và không tràn màn hình ngang trên `375px`, `768px`, `1024px`, `1440px`.
- [ ] **Touch Target:** Kích thước vùng bấm trên Mobile tối thiểu `44×44px`.
- [ ] **Ngữ nghĩa HTML:** Có 1 thẻ `<h1>` duy nhất, cấu trúc thẻ semantic chuẩn.
- [ ] **Hiệu năng:** Không có `preserve-3d`/`perspective`/`translateZ`/`background-attachment: fixed`/`transition: all` (mục 7.1); `npm --prefix server test` xanh, gồm cả `no-3d-effects.test.js`.

---

## 12. Nợ Thiết Kế & Sai Lệch Cần Khắc Phục (Audit Toàn Diện 2026-09-15)

### Trạng thái kiểm tra lại 2026-10-15

Kiểm tra bằng `grep` trên `server/public/` (chưa đo lại bằng trình duyệt). Các mục không có trong bảng chưa được kiểm tra lại — coi như theo audit gốc bên dưới.

| Mục (audit 2026-09-15) | Trạng thái 2026-10-15 |
|---|---|
| 12.1 `index.html` `.export-modal-backdrop` có `backdrop-filter` + nền hardcode | **Đã sửa phần blur**: không còn `backdrop-filter` (có chú thích lý do); nền vẫn là `rgba(5,10,18,.74)` hardcode, chưa dùng `--overlay-bg` |
| 12.1 `account/index.html` `.modal-overlay` | **Còn**: `backdrop-filter:blur(3px)` (dòng ~255) |
| 12.1 `humanresources/index.html` `.modal-overlay` | **Còn**: `blur(3px)` (dòng ~315) và thêm `blur(6px)` ở khối khác (dòng ~280) |
| 12.1 `login/index.html` `.modal-overlay` (OTP) | **Còn**: `blur(3px)` (dòng ~305); thẻ đăng nhập và `register/index.html` dùng `blur(12px)` cho card (không phải overlay toàn màn hình) |
| 12.1 `shared.css` `.backdrop` (drawer mobile) | **Còn**: `blur(2px)` |
| 12.2 `.login-error`/`.login-pending`/`.form-error` hardcode rgba | `login/index.html` đã dùng `--alert-error-bg`; `register/index.html` `.form-error` chưa kiểm tra lại giá trị màu |
| 12.2 `.lookup-message.error` (trang vòng đời) | **Còn** hardcode `rgba(239,68,68,.12)` (nay ở `shipment/lifecycle/index.html`) |
| 12.2 `.status-pill.status-inactive` (`account`) | **Còn**: `rgba(148,163,184,.12)` rời |
| 12.2 `.pill.ok`/`.bad`/`.warn` (`index.html`) | **Còn** rgba cũ (`61,214,140` / `241,97,106` / `240,166,58`) |
| 12.2 chữ trên nền đặc `#1B1206` | **Đã hết**; còn `#07150d` ở `.export-confirm` |
| 12.2 `404.html` `.blob-1`/`.blob-2` | **Còn** hardcode rgba |
| 12.3 `.form-control` thay vì `.form-input` | **Còn** (`account/index.html`) |
| 12.3 thang `--radius-N` riêng và `--radius-pill:999px` của `index.html` | **Còn** (10 token `--radius-N`) |
| 12.3 `.tks-profile-*` khai báo ở cả `index.html` và `shared.css` | **Còn** (2 nguồn) |
| 12.4 `account` `.users-table` thiếu sticky `<th>`/hover | **Đã sửa** (có `position:sticky` và `tr.row-clickable:hover`) |
| 12.4 `.action-icon-btn` 32×32 | Selector không còn trong `account/index.html` |
| 5.18 `.dp-*` áp đủ 3 trang | **Hoàn thành** (12/10/2026): `index.html`, `shipment/lifecycle/index.html`, `humanresources/index.html` đều dùng `detail-panel.css` |
| Phân trang bảng `humanresources` + `account` | **Hoàn thành** (12/10/2026): `table-controls.js` áp cho bảng nhân sự, chấm công, nghỉ phép và quản trị người dùng |
| Gỡ "Lịch làm việc" (`PUT /api/hr/leave-work-schedules/:id`) | **Hoàn thành** (15/10/2026): nút/hộp gỡ khỏi tab Nghỉ phép, giữ `GET` và giờ mặc định 07:45 / 12:30 |


Danh sách này ghi nhận **hiện trạng thực tế** của mã nguồn so với các quy tắc ở trên, phát hiện qua
audit toàn bộ 7 trang HTML + `shared.css`. Đây là backlog kỹ thuật, không phải lỗi chặn release —
ưu tiên xử lý khi chạm vào các file liên quan; không tự ý sửa hàng loạt nếu không nằm trong phạm vi
task đang làm.

### 12.1 Mức Cao — Vi phạm quy tắc chống hiệu năng kém (mục 7.1)

`backdrop-filter` trên overlay toàn màn hình (`position:fixed; inset:0`) xuất hiện ở **4 vị trí**,
đều vi phạm quy tắc cấm ở mục 7.1 (lý do: buộc trình duyệt blur lại toàn viewport mỗi lần overlay
hiện/ẩn — cùng nhóm lỗi đã khiến `.loading-veil` bị gỡ 3D trước đây):

| Vị trí | Selector | Trạng thái |
|---|---|---|
| `server/public/account/index.html` | `.modal-overlay` (4 modal: tạo/sửa user, đổi mật khẩu, yêu cầu vai trò) | `backdrop-filter: blur(3px)` |
| `server/public/login/index.html` | `.modal-overlay` (modal OTP) | `backdrop-filter: blur(3px)` |
| `server/public/humanresources/index.html` | `.modal-overlay` (duyệt/từ chối nghỉ phép) | `backdrop-filter: blur(3px)` |
| `server/public/index.html` | `.export-modal-backdrop` | `backdrop-filter: blur(3px)` + nền hardcode `rgba(5,10,18,.68)` không đổi theo Light Mode |

**Cách sửa chuẩn:** áp dụng component `.modal-overlay` thống nhất ở mục 5.7 — bỏ hẳn
`backdrop-filter`, chỉ dùng `background: var(--overlay-bg)`. `no-3d-effects.test.js` hiện chỉ quét
`shared.css` + danh sách cố định, **chưa bắt được** 4 vi phạm này vì chúng nằm trong `<style>` nội
tuyến của từng trang — cân nhắc mở rộng phạm vi quét của test này.

Ngoài ra, `.backdrop` (drawer sidebar mobile, trong `shared.css`) cũng dùng `backdrop-filter:
blur(2px)` — tần suất kích hoạt thấp hơn nhiều (chỉ khi mở menu mobile, không phải mỗi lần
auto-refresh), nhưng về nguyên tắc nên thống nhất một câu trả lời chung cho "overlay toàn màn hình
có được blur hay không" thay vì mỗi nơi một kiểu.

### 12.2 Mức Trung Bình — Màu hardcode thay vì dùng token

Token tương ứng đã tồn tại sẵn trong `shared.css :root` nhưng không được dùng:

- **Hộp cảnh báo lỗi/chờ xử lý** hardcode `rgba(239,68,68,.12)` / `rgba(59,130,246,.12)` thay vì
  `var(--alert-error-bg)` / `var(--alert-warning-bg)` đã có sẵn — đây là lỗi **lặp lại nhiều lần
  nhất** trong toàn bộ audit: `.login-error`, `.login-pending` (`login/index.html`), `.form-error`
  (`register/index.html`), `.lookup-message.error` (`shipment/index.html`).
- `account/index.html`: `.status-inactive` dùng `rgba(148,163,184,.12)` rời, không truy được về token
  nào — nên thêm `--status-inactive-bg` vào `shared.css` (xem mục 5.6).
- `index.html`: "amber cũ" `rgba(240,166,58,…)` lệch hẳn với `--amber` (`#F59E0B`) hiện tại, dùng ở
  `.suggestion-source`, `.search-result-source`, `.pill.warn` — nên đổi về `var(--amber)`/
  `rgba(var(--glow-amber-rgb),…)` để đồng bộ khi đổi bảng màu.
- `index.html`: `.pill.ok` (`rgba(61,214,140,.13)`) và `.pill.bad` (`rgba(241,97,106,.13)`) không
  khớp `--green`/`--red` hiện hành — nên đổi sang `rgba(var(--glow-green-rgb),.13)` /
  `rgba(var(--glow-red-rgb),.13)` (xem token mới ở mục 4.4b).
- `index.html`: chữ trên nền đặc hardcode `#1B1206` (×3: `.search-submit`, `.period-toggle
  button.active`, `.mini-filter-range.active .mini-filter-apply`) và `#07150d` (`.export-confirm`)
  — chuẩn hoá thành `var(--amber-contrast-text)` / `var(--green-contrast-text)` (mục 4.4c).
- `404.html`: `.blob-1`/`.blob-2` hardcode `rgba(59,130,246,.28)`/`rgba(139,92,246,.2)` thay vì tái
  dùng `--ambient-1`/`--ambient-2` đã có sẵn cho đúng mục đích "vùng sáng nền dịu nhẹ".
- `login/index.html`: `.login-brand .brand-mark` tự set shadow `0 4px 14px rgba(0,0,0,.14)` thay vì
  `var(--shadow-brand)`; focus ring của `.field input` dùng `rgba(59,130,246,.22)` lệch nhẹ so với
  spec `rgba(59,130,246,.2)` ở mục 5.4 — nên hợp nhất về một token `--shadow-focus-input` dùng chung.

### 12.3 Mức Trung Bình — Trùng lặp component / đặt tên khác nhau cho cùng một thứ

- **Class input form:** `MASTER.md` §5.4 định nghĩa `.form-input`, nhưng `account`, `login`,
  `register` đều dùng `.form-control`/`.field input` với box model gần giống nhưng viết lại từ đầu.
  Cần chọn **một** tên chuẩn (khuyến nghị giữ `.form-input` vì đã có trong tài liệu) khi viết mới;
  không bắt buộc đổi tên hàng loạt code cũ.
- **Radius lệch thang:** `.profile-card` (account) dùng `--radius-xl` (14px) trong khi `.card` chuẩn
  ở §5.2 dùng `--radius-lg` (12px); `.end-day-stat` (index) dùng `--radius-9` trong khi `.kpi-card`
  cùng vai trò dùng `--radius-12`; `.lookup-panel textarea` (shipment) dùng `border-radius:12px` —
  không khớp bậc nào trong thang §4.4. `index.html` còn tự tạo thang số riêng (`--radius-2…14`) song
  song với thang ngữ nghĩa — xem cảnh báo ở mục 4.4.
- **Badge trạng thái tự chế:** `shipment/index.html` có `.status-found`/`.status-missing` làm lại y
  hệt ý tưởng `.badge-success`/`.badge` (§5.3) bằng tên riêng và padding hơi khác (`4px 10px` thay vì
  `3px 10px`) — nên dùng thẳng `.badge`/`.badge-success` khi viết trang mới.
- **Avatar tròn:** `.user-avatar` (account) dùng `border-radius:50%` thay vì `var(--radius-pill)` —
  tương đương về hình dạng nhưng nên dùng token cho nhất quán khi grep toàn bộ codebase theo token.
- `.tks-profile-*` (modal hồ sơ cá nhân) bị **khai báo lại y hệt** trong `index.html` dù đã tồn tại ở
  `shared.css` — không phải lỗi hiển thị nhưng là 2 nguồn cho cùng 1 component, dễ lệch khi 1 nơi
  được sửa mà quên nơi kia.
- `.export-button` được `humanresources/index.html` khai báo lại đầy đủ (gradient/shadow/hover) dù
  `shared.css` đã có sẵn cùng selector trong nhóm dùng chung (dòng 654–723) — giá trị trùng khớp nên
  không gây lỗi hiển thị, nhưng là code thừa.

### 12.4 Mức Thấp — Thiếu sót so với quy tắc tương tác

- `account/index.html`: `.action-icon-btn` (nút thao tác trong bảng) chỉ **32×32px**, dưới ngưỡng bắt
  buộc 40×40px desktop ở mục 5.5.
- `account/index.html`: bảng `.users-table` **không có** `position:sticky` trên `<th>` và **không có**
  `tbody tr:hover` — cả hai đều là yêu cầu bắt buộc của mục 5.5 cho bảng dữ liệu dày đặc.
- `account/index.html`: `.profile-card` không có trạng thái `:hover` nào — chưa đạt yêu cầu "mọi thẻ
  thông tin phải có phản hồi hover rõ ràng" ở mục 2.2.
- `shipment/index.html`: `.int-nav-card:hover` tự thêm `transform:translateY(-2px)` cục bộ, xung đột
  với quy ước "card hover chỉ dùng box-shadow/border-color, không transform" đã ghi rõ trong comment
  của chính `shared.css` (dòng ~863) — không phải lỗi 3D nhưng nên bỏ để nhất quán với card khác.

### 12.5 Việc cần làm khi có thời gian (không khẩn cấp)

Danh sách component nên chuyển từ "khai báo cục bộ trong `<style>` từng trang" sang `shared.css`
dùng chung, vì đã xuất hiện ở ≥ 2 trang với nội dung gần như giống hệt: role badges + status pills
(§5.6), modal dialog chuẩn (§5.7), toast notification (§5.8), sub-nav tabs (§5.9), auth card (§5.10).
Việc hợp nhất giúp một lần sửa (VD: bỏ `backdrop-filter` khỏi modal) áp dụng ngay cho mọi trang thay
vì phải sửa lặp lại 4 chỗ như hiện tại ở mục 12.1.

Cập nhật gần nhất: 2026-10-30 (ghi chú trang Vị trí hàng đổi từ `stock-locations` sang `vt-positions`).
