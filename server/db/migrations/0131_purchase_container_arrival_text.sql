ALTER TABLE product_containers
  ALTER COLUMN arrival_date TYPE TEXT USING arrival_date::text;