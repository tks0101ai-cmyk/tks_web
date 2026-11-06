-- Pham vi so huu cua Thu mua tren read model dung chung product_container_lines.
--
-- false (mac dinh) — SO HUU MOT PHAN: Thu mua chi so huu nhung cont co trong
--   product_containers. Dong cua sheet khac giu nguyen. Dong "cho xep" cua Thu
--   mua KHONG day sang read model: hang doi cu (423 dong, 404 ma) va hang doi
--   moi (135 dong, 125 ma) chi trung 41 ma — xoa ben cu thi mat 363 ma cua
--   sheet khac, day ca hai vao thi dem doi 41 ma. Giu nguyen ben cu la an toan.
--
-- true — SO HUU TOAN PHAN: Thu mua la nguon duy nhat, moi dong khong thuoc
--   'THU MUA' bi xoa (hanh vi ban dau). Chi bat khi ban chup nguon da day du.
--   Thoi diem nay chua du: read model co 14.312 dong tren hang chuc cont lich
--   su, ban chup moi co 552 dong / 7 cont.
ALTER TABLE purchase_settings
  ADD COLUMN IF NOT EXISTS projection_owns_all BOOLEAN NOT NULL DEFAULT false;
