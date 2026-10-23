-- Schema only: initialize-customer-price-levels.js --apply archives source levels and enables cutover atomically.
CREATE TABLE IF NOT EXISTS customer_price_level_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id), initialized_at timestamptz
);
INSERT INTO customer_price_level_state(id) VALUES (true) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS customer_price_level_sources (
  branch text NOT NULL, customer_id bigint NOT NULL, customer_code text, customer_name text NOT NULL,
  customer_key text NOT NULL, source_email text NOT NULL, source_level text NOT NULL CHECK (source_level IN ('medium','large','vip')),
  archived_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(branch, customer_id)
);
CREATE TABLE IF NOT EXISTS customer_price_levels (
  customer_key text PRIMARY KEY, level text NOT NULL CHECK (level IN ('medium','large','vip')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0), updated_by_id text,
  updated_by_name text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customer_price_level_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, customer_key text NOT NULL,
  old_level text NOT NULL CHECK (old_level IN ('medium','large','vip')),
  new_level text NOT NULL CHECK (new_level IN ('medium','large','vip')),
  version integer NOT NULL, actor_id text, actor_name text NOT NULL DEFAULT '',
  changed_at timestamptz NOT NULL DEFAULT now(), UNIQUE(customer_key, version)
);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reporting_readonly') THEN
    REVOKE ALL ON customer_price_level_state, customer_price_level_sources, customer_price_levels, customer_price_level_history FROM reporting_readonly;
  END IF;
END $$;
