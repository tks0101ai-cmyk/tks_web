-- One complete raw-cell bundle shared by all VAT consumers. Only the worker reads Google.
CREATE TABLE IF NOT EXISTS vat_sheet_snapshot (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  records JSONB,
  loaded_at TIMESTAMPTZ,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
INSERT INTO vat_sheet_snapshot(id) VALUES (1) ON CONFLICT DO NOTHING;
ALTER TABLE vat_sheet_snapshot ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON vat_sheet_snapshot FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_readonly') THEN
    REVOKE ALL ON vat_sheet_snapshot FROM reporting_readonly;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON vat_sheet_snapshot FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON vat_sheet_snapshot FROM authenticated;
  END IF;
END $$;
