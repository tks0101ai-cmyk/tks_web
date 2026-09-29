'use strict';
const { isDeepStrictEqual } = require('node:util');
const { value, array } = require('./entityUtils');

// KiotViet co san endpoint /productOnHands chuyen ve ton kho: nhe hon /products
// (khong keo ten/gia/category). Xac nhan qua live probe 2026-09-23 (xem
// server/kiotviet/API_ENDPOINTS.md). Ghi chu quan trong tu du lieu that 2026-09-29:
// `lastModifiedFrom` cua endpoint nay KHONG phan anh dung ban hang/nhap hang —
// sau khi dong bo, 0/47 ma Sai Gon va 0/4 ma Ha Noi co hoa don moi duoc lam moi
// ton (MCRY301 SG: ton DB 0 trong khi KiotViet 2.250). Vi vay ngoai lan poll
// tang dan nay, con co productOnHandsSnapshot.js quet TOAN BO dinh ky.
//
// Poll rieng bang checkpoint entity 'product_on_hands' (khac 'products').
// CHI UPDATE raw->'inventories' cua dong products tuong ung (branch, id) —
// KHONG insert dong moi, vi response thieu name/code/gia... Neu id chua co
// trong products, bo qua; lan sync /products ke tiep se tao dong.
//
// Response chi co {branchId, onHand, reserved} moi kho, trong khi
// inventories tu /products con `cost` (Gia von), `onOrder`... Ban cu ghi de
// ca mang nen lam mat `cost` (2026-09-29: 6.786 dong Ha Noi, 1.300 dong Sai
// Gon mat gia von). Nay GOP theo branchId: giu field cu, chi de onHand/reserved
// moi; va chi UPDATE dong thuc su doi (tranh ghi WAL vo ich khi quet toan bo,
// xem project-tokosi-supabase-io-incident).
function mergeInventories(current, incoming) {
  const existing = Array.isArray(current) ? current : [];
  return incoming.map((next) => {
    const nextBranch = value(next, 'branchId', 'BranchId');
    const old = existing.find((inv) => String(value(inv, 'branchId', 'BranchId')) === String(nextBranch));
    return old ? { ...old, ...next } : next;
  });
}

const CURRENT_SQL = `
  SELECT id, raw->'inventories' AS inventories
  FROM products
  WHERE branch = $1 AND id = ANY($2::bigint[])`;

const UPDATE_SQL = `
  UPDATE products p
  SET raw = jsonb_set(p.raw, '{inventories}', u.inv::jsonb), synced_at = now()
  FROM unnest($2::bigint[], $3::text[]) AS u(id, inv)
  WHERE p.branch = $1 AND p.id = u.id`;

module.exports = {
  entity: 'product_on_hands',
  endpoint: 'productOnHands',
  listQuery: {},
  incrementalParam: 'lastModifiedFrom',
  hasUpperBound: true,
  mergeInventories,
  async upsertPage(pgClient, branch, items) {
    const rows = items
      .map((item) => ({ id: value(item, 'Id', 'id', 'ProductId', 'productId'), inventories: array(item, 'Inventories', 'inventories') }))
      .filter((row) => row.id !== null);
    if (!rows.length) return { received: items.length, updated: 0 };

    const current = await pgClient.query(CURRENT_SQL, [branch, rows.map((row) => row.id)]);
    const currentById = new Map(((current && current.rows) || []).map((row) => [String(row.id), row.inventories]));

    const changedIds = [];
    const changedInventories = [];
    for (const row of rows) {
      const key = String(row.id);
      if (!currentById.has(key)) continue;
      const merged = mergeInventories(currentById.get(key), row.inventories);
      if (isDeepStrictEqual(merged, currentById.get(key) || [])) continue;
      changedIds.push(row.id);
      changedInventories.push(JSON.stringify(merged));
    }
    if (changedIds.length) await pgClient.query(UPDATE_SQL, [branch, changedIds, changedInventories]);
    return { received: items.length, updated: changedIds.length };
  }
};
