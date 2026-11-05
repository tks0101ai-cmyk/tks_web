-- Preserve existing explicitly entered freight; new containers use formula in service.
ALTER TABLE product_containers ADD COLUMN IF NOT EXISTS freight_mode TEXT NOT NULL DEFAULT 'manual' CHECK(freight_mode IN ('manual','formula'));
ALTER TABLE product_containers ADD COLUMN IF NOT EXISTS freight_base NUMERIC NOT NULL DEFAULT 202000000 CHECK(freight_base>=0);
ALTER TABLE product_containers ADD COLUMN IF NOT EXISTS freight_capacity NUMERIC NOT NULL DEFAULT 170 CHECK(freight_capacity>0);
