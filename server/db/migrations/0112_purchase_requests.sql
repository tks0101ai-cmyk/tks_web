-- Every successful write and its replay result commit together.
CREATE TABLE IF NOT EXISTS purchase_requests (
 actor_id TEXT NOT NULL,request_key UUID NOT NULL,fingerprint TEXT NOT NULL,result JSONB NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(actor_id,request_key)
);
