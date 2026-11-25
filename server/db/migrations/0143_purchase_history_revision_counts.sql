-- Keep an exact, transactionally maintained count for the purchase change cursor.
-- The previous cursor ran COUNT(*) over the immutable audit log on every list,
-- refresh and polling request. 64 shards spread concurrent writes while keeping
-- reads bounded to a few dozen rows.
CREATE TABLE IF NOT EXISTS purchase_history_revision_counts (
  shard SMALLINT PRIMARY KEY CHECK (shard >= 0 AND shard < 64),
  row_count BIGINT NOT NULL CHECK (row_count >= 0)
);

INSERT INTO purchase_history_revision_counts(shard,row_count)
SELECT shards.shard,CASE WHEN shards.shard=0 THEN history.total ELSE 0 END
FROM generate_series(0,63) AS shards(shard)
CROSS JOIN (SELECT count(*)::bigint AS total FROM purchase_history) AS history
ON CONFLICT(shard) DO NOTHING;

CREATE OR REPLACE FUNCTION purchase_history_count_insert() RETURNS trigger AS $$
DECLARE shard_id SMALLINT;
DECLARE operation_key TEXT;
BEGIN
  operation_key := NULLIF(current_setting('purchase.operation_id',true),'');
  shard_id := (((hashtextextended(COALESCE(operation_key,txid_current()::text),0) % 64)+64) % 64)::smallint;
  UPDATE purchase_history_revision_counts
  SET row_count=row_count+1
  WHERE shard=shard_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Purchase history revision counter shard % is missing',shard_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS purchase_history_count_insert ON purchase_history;
CREATE TRIGGER purchase_history_count_insert
AFTER INSERT ON purchase_history
FOR EACH ROW EXECUTE FUNCTION purchase_history_count_insert();

CREATE OR REPLACE FUNCTION purchase_history_count_truncate() RETURNS trigger AS $$
BEGIN
  UPDATE purchase_history_revision_counts SET row_count=0;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS purchase_history_count_truncate ON purchase_history;
CREATE TRIGGER purchase_history_count_truncate
AFTER TRUNCATE ON purchase_history
FOR EACH STATEMENT EXECUTE FUNCTION purchase_history_count_truncate();
