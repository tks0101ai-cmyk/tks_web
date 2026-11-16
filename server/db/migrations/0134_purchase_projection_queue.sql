-- Durable coalesced signal for rebuilding the shared container projection.
-- Canonical purchase writes insert an outbox row in their own transaction;
-- a background worker deletes only rows covered by its projection snapshot.
CREATE TABLE IF NOT EXISTS purchase_projection_queue (
  id BIGSERIAL PRIMARY KEY,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT
);
