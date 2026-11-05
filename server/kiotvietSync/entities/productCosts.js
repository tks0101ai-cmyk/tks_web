'use strict';
const { value, array } = require('./entityUtils');

// Luot rieng chi cap nhat Gia von. Doi gia von tren KiotViet thuong khong doi modifiedDate nen poll
// tang dan /products bo sot; /productOnHands khong tra cost; doi soat 24 gio co y giu nguyen inventories.
// So sanh ngay trong Postgres, dong khong doi khong ghi (tranh WAL, xem project-tokosi-supabase-io-incident).
// Khong dung onHand/reserved cua /products: cac truong do do productOnHands(+Snapshot) quan ly.
// $2 = JSON [{id, inv:[{branchId, cost}]}].
const UPDATE_COSTS_SQL = `
  WITH incoming AS (
    SELECT (r->>'id')::bigint AS id, e->>'branchId' AS branch_id, (e->>'cost')::numeric AS cost
    FROM jsonb_array_elements($2::jsonb) r
    CROSS JOIN LATERAL jsonb_array_elements(r->'inv') e
  ), changed AS (
    SELECT p.id, jsonb_agg(
      CASE WHEN i.cost IS NOT NULL AND (inv.elem->>'cost')::numeric IS DISTINCT FROM i.cost
           THEN inv.elem || jsonb_build_object('cost', i.cost) ELSE inv.elem END ORDER BY inv.ord) AS inventories
    FROM products p
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(p.raw->'inventories') = 'array' THEN p.raw->'inventories' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS inv(elem, ord)
    LEFT JOIN incoming i ON i.id = p.id AND i.branch_id = COALESCE(inv.elem->>'branchId', inv.elem->>'BranchId')
    WHERE p.branch = $1 AND p.id IN (SELECT id FROM incoming)
    GROUP BY p.id
    HAVING bool_or(i.cost IS NOT NULL AND (inv.elem->>'cost')::numeric IS DISTINCT FROM i.cost)
  )
  UPDATE products p SET raw = jsonb_set(p.raw, '{inventories}', c.inventories), synced_at = now()
  FROM changed c WHERE p.branch = $1 AND p.id = c.id`;

function costsOf(item) {
  const inv = array(item, 'Inventories', 'inventories')
    .map(entry => ({ branchId: value(entry, 'branchId', 'BranchId'), cost: value(entry, 'cost', 'Cost') }))
    .filter(entry => entry.branchId !== null && entry.cost !== null && Number.isFinite(Number(entry.cost)));
  return { id: value(item, 'Id', 'id', 'ProductId', 'productId'), inv };
}

module.exports = {
  entity: 'product_costs',
  endpoint: 'products',
  listQuery: { includeInventory: 'true', orderBy: 'id', orderDirection: 'ASC' },
  pollFullSnapshot: true,
  incrementalParam: null,
  hasUpperBound: false,
  async upsertPage(pgClient, branch, items) {
    const rows = items.map(costsOf).filter(row => row.id !== null && row.inv.length);
    if (!rows.length) return { received: items.length, updated: 0 };
    const result = await pgClient.query(UPDATE_COSTS_SQL, [branch, JSON.stringify(rows)]);
    // pg tra rowCount, PGlite tra affectedRows.
    return { received: items.length, updated: Number(result.rowCount ?? result.affectedRows ?? 0) };
  }
};
