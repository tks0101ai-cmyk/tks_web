-- Employee label colors are presentation metadata for the purchase workspace.
ALTER TABLE purchase_employees
 ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '#2563EB'
 CHECK (color IN ('#2563EB','#0891B2','#059669','#65A30D','#D97706','#EA580C','#DC2626','#DB2777','#9333EA','#475569'));
