'use strict';
// Doi soat don hang DANG MO voi KiotViet.
//
// Vi sao can: dong bo orders chi UPSERT theo `lastModifiedFrom` (documentEntityFactory.js) va
// khong he co duong xu ly huy/xoa. Mot don bi huy tren KiotViet khong quay lai trong danh sach
// tang dan nua - du vi API loc bo don huy hay vi modifiedDate khong duoc bump - nen dong cu nam
// im vinh vien voi trang thai cu ("Phieu tam"). Module Vong doi hieu dung 'Da huy', no chi khong
// bao gio nhan duoc du lieu do.
//
// Cach lam: hoi THANG tung don theo id (GET /orders/{id}) thay vi dua vao danh sach. Duong detail
// tra ve ca don da huy, nen cach nay dung cho ca hai nguyen nhan tren.
const { getPool } = require('../db/pool');

// Trang thai ket thuc: khong doi nua nen khong can hoi lai.
const TERMINAL_STATUSES = Object.freeze(['Hoàn thành', 'Đã hủy']);
const DEFAULT_LIMIT = 200;

const statusOf = (raw) => String((raw && raw.statusValue) || '').trim();

// Hàm thuần: quyết định phải làm gì với một dòng sau khi hỏi KiotViet.
// Khong tu bia trang thai: 404 chi bao 'missing' de nguoi that xem, khong suy ra 'Da huy'.
function planUpdate(row, result) {
  if (!result || result.found === false) return { action: 'missing', id: row.id, code: row.code };
  const fetched = result.order || {};
  const next = statusOf(fetched);
  const current = statusOf(row.raw);
  if (!next) return { action: 'skip', id: row.id, code: row.code, reason: 'api khong tra statusValue' };
  if (next === current) return { action: 'unchanged', id: row.id, code: row.code, status: next };
  return { action: 'update', id: row.id, code: row.code, from: current, to: next, order: fetched };
}

// Hàm thuần: các trạng thái còn phải theo dõi (mọi thứ chưa kết thúc, kể cả rỗng/lạ).
function isOpenStatus(status) {
  return !TERMINAL_STATUSES.includes(String(status || '').trim());
}

const CANDIDATE_SQL = `
  SELECT branch, id, code, raw, synced_at
  FROM orders
  WHERE COALESCE(raw->>'statusValue', '') <> ALL($1::text[])
    AND ($2::text IS NULL OR branch = $2)
  ORDER BY synced_at ASC NULLS FIRST
  LIMIT $3`;

async function reconcileOpenOrders({
  pool = getPool(),
  client,
  branch = null,
  limit = DEFAULT_LIMIT,
  logger = console,
} = {}) {
  if (!client || typeof client.fetchOrderById !== 'function') {
    throw new Error('reconcileOpenOrders can mot KiotViet client co fetchOrderById.');
  }
  const candidates = (await pool.query(CANDIDATE_SQL, [TERMINAL_STATUSES, branch, limit])).rows;
  const summary = { checked: candidates.length, updated: 0, unchanged: 0, missing: 0, skipped: 0, changes: [], missingCodes: [] };

  for (const row of candidates) {
    // Mot don loi khong duoc lam hong ca luot: ghi nhan roi di tiep.
    let plan;
    try {
      plan = planUpdate(row, await client.fetchOrderById(row.id));
    } catch (error) {
      summary.skipped += 1;
      logger.warn(`[ReconcileOrders] ${row.code}: ${error.code || error.message}`);
      continue;
    }
    if (plan.action === 'unchanged') { summary.unchanged += 1; continue; }
    if (plan.action === 'skip') { summary.skipped += 1; continue; }
    if (plan.action === 'missing') {
      summary.missing += 1;
      summary.missingCodes.push(plan.code);
      continue;
    }
    await pool.query(
      `UPDATE orders
         SET raw = $3::jsonb,
             status = COALESCE(($3::jsonb->>'status')::smallint, status),
             modified_date = COALESCE(($3::jsonb->>'modifiedDate')::timestamptz, modified_date),
             synced_at = now()
       WHERE branch = $1 AND id = $2`,
      [row.branch, row.id, JSON.stringify(plan.order)],
    );
    summary.updated += 1;
    summary.changes.push({ code: plan.code, from: plan.from, to: plan.to });
  }

  if (summary.updated || summary.missing) {
    logger.log(`[ReconcileOrders] kiem ${summary.checked}, cap nhat ${summary.updated}, khong con tren API ${summary.missing}`);
  }
  return summary;
}

module.exports = { reconcileOpenOrders, planUpdate, isOpenStatus, TERMINAL_STATUSES, CANDIDATE_SQL, DEFAULT_LIMIT };
