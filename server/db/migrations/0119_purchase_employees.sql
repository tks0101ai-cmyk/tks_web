-- Independent purchase catalog; buyer remains a historical name snapshot.
CREATE TABLE IF NOT EXISTS purchase_employees (
 id BIGSERIAL PRIMARY KEY,
 name TEXT NOT NULL CHECK (btrim(name)<>'' AND length(name)<=200),
 is_active BOOLEAN NOT NULL DEFAULT true,
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_employees_name_key ON purchase_employees(lower(btrim(name)));
INSERT INTO purchase_employees(name)
 SELECT DISTINCT ON (lower(btrim(buyer))) btrim(buyer)
 FROM purchase_orders WHERE buyer IS NOT NULL AND btrim(buyer)<>''
 ORDER BY lower(btrim(buyer)),btrim(buyer)
 ON CONFLICT DO NOTHING;
