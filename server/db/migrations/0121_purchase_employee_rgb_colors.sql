-- Allow any RGB hex color chosen in the purchase employee manager.
ALTER TABLE purchase_employees DROP CONSTRAINT IF EXISTS purchase_employees_color_check;
ALTER TABLE purchase_employees DROP CONSTRAINT IF EXISTS purchase_employees_color_format;
ALTER TABLE purchase_employees ADD CONSTRAINT purchase_employees_color_format CHECK (color ~ '^#[0-9A-Fa-f]{6}$');
