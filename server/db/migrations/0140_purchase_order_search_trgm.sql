-- Accelerate the grid's accent-insensitive contains search without changing
-- which rows match. PostgreSQL can use this GIN index for LIKE '%term%'
-- searches containing at least three characters.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS purchase_orders_active_search_trgm_idx
  ON purchase_orders USING GIN (
    (translate(
      lower(COALESCE(row_key || ' ', '') || COALESCE(source_sheet || ' ', '') ||
        COALESCE(product_code || ' ', '') || COALESCE(product_name || ' ', '') ||
        COALESCE(product_name_cn || ' ', '') || COALESCE(supplier || ' ', '') ||
        COALESCE(sale_note || ' ', '') || COALESCE(buy_note || ' ', '') ||
        COALESCE(extra_note || ' ', '')),
      'àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ',
      'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'
    )) gin_trgm_ops
  )
  WHERE deleted_at IS NULL AND inactive_at IS NULL;
