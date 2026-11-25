-- Deleted containers keep their display name and history, but release the
-- normalized name so a clean import can create a fresh active container.
UPDATE product_containers
SET name_key='__DELETED__:'||id::text||':'||md5(name_key)
WHERE deleted_at IS NOT NULL;
