-- Nguon goc cua tung dong Thu mua: ten sheet va so dong o ban nguon.
--
-- Vi sao can: ban nguon TKS nam tren 7 sheet (YIWU, VK-DUNG, HÀ BẮC, SD, GDONG,
-- KHÁC, CONT TKS1). Sau khi nap len web, nguoi dung can loc va lam viec theo
-- tung luong do, va duong nap can biet dong nao da nap de khong nap trung khi
-- nap bo sung tung sheet.
--
-- source_sheet/source_row do DUONG NAP ghi, khong phai nguoi dung: cot nay mang
-- co `ro` trong purchase-columns.js nen khong nam trong tap cot ghi duoc cua
-- API sua dong lan import Excel. 552 dong nap truoc migration nay de NULL.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS source_sheet TEXT,
  ADD COLUMN IF NOT EXISTS source_row   INTEGER;

-- Chong nap trung khi nap bo sung: moi (sheet, dong) chi ton tai mot lan. Dong
-- cu (NULL) va dong tao tay tren web khong bi rang buoc nay.
CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_source_unique
  ON purchase_orders (source_sheet, source_row)
  WHERE source_sheet IS NOT NULL AND source_row IS NOT NULL;

-- Loc theo nguon la thao tac thuong xuyen tren bang Dat hang.
CREATE INDEX IF NOT EXISTS purchase_orders_source_sheet_idx
  ON purchase_orders (source_sheet) WHERE source_sheet IS NOT NULL;
