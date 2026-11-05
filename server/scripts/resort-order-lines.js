'use strict';

// SUA DU LIEU CU: sap lai order_details.line_no theo thu tu that cua KiotViet (Id dong, doc qua API noi bo) cho don
// dat hang gan day, roi sap lai snapshot cua cac phieu chi dinh dang mo (picking/confirmed) — phieu in doc snapshot.
//   node scripts/resort-order-lines.js [--days 45] [--dry-run]
// Can KIOTVIET_WEB_USERNAME/PASSWORD (HN) va/hoac _SG trong .env.
const { getPool } = require('../db/pool');
const { createKiotInternalClient, credentialsFor } = require('../kiotviet/kiotInternalClient');
const { orderDetailsByKiotLines } = require('../kiotviet/orderLineOrder');

const args = process.argv.slice(2);
const days = Number(args[args.indexOf('--days') + 1]) || 45;
const dryRun = args.includes('--dry-run');
const PICK_BRANCH = { hanoi: 'HN', saigon: 'SG' };
const key = code => String(code || '').trim().toLowerCase();

async function resortBranch(db, branch) {
  const creds = credentialsFor(branch);
  if (!creds) return console.log(`${branch}: chua cau hinh tai khoan web KiotViet, bo qua.`);
  const client = createKiotInternalClient(creds);
  await client.login();
  const { rows: orders } = await db.query(
    `SELECT o.id, o.code FROM orders o
      WHERE o.branch = $1 AND COALESCE(o.order_date, o.created_date) >= now() - make_interval(days => $2)
        AND (SELECT count(*) FROM order_details d WHERE d.branch = o.branch AND d.order_id = o.id) >= 2
      ORDER BY o.id DESC`, [branch, days]);
  let changed = 0, skipped = 0;
  for (const order of orders) {
   try {
    const { rows: details } = await db.query(
      `SELECT line_no, product_id::text AS product_id, quantity::float8 AS quantity, raw->>'productCode' AS code
         FROM order_details WHERE branch = $1 AND order_id = $2 ORDER BY line_no`, [branch, order.id]);
    let lines;
    try { lines = await client.fetchOrderLines(order.id); } catch (error) {
      console.warn(`${order.code}: ${error.message}`); skipped++; continue;
    }
    const sorted = orderDetailsByKiotLines(details.map(d => ({ ...d, productId: d.product_id })), lines);
    if (!sorted) { skipped++; continue; }
    const order_ = sorted.map(d => d.line_no);
    if (order_.every((lineNo, i) => lineNo === details[i].line_no)) continue;
    changed++;
    if (dryRun) { console.log(`${order.code}: ${sorted.map(d => d.code).join(' ')}`); continue; }
    const tx = await db.connect();
    try {
      await tx.query('BEGIN');
      await tx.query('UPDATE order_details SET line_no = line_no + 100000 WHERE branch = $1 AND order_id = $2', [branch, order.id]);
      for (let i = 0; i < sorted.length; i++) {
        await tx.query('UPDATE order_details SET line_no = $3 WHERE branch = $1 AND order_id = $2 AND line_no = $4',
          [branch, order.id, i, sorted[i].line_no + 100000]);
      }
      await tx.query('COMMIT');
    } catch (error) { await tx.query('ROLLBACK').catch(() => {}); throw error; } finally { tx.release(); }
   } catch (error) {
    // Loi DB/mang o 1 don (timeout...) khong dung ca lan chay; chay lai script se lam tiep don con lech.
    console.warn(`${order.code}: ${error.message}`); skipped++;
   }
  }
  console.log(`${branch}: ${orders.length} don, sap lai ${changed}, bo qua ${skipped}${dryRun ? ' (dry-run)' : ''}.`);

  // Phieu chi dinh dang mo: sap dong snapshot theo thu tu ma hang moi cua don.
  const { rows: picks } = await db.query(
    `SELECT a.id, a.order_code, a.order_snapshot FROM order_pick_assignments a
      WHERE a.branch = $1 AND a.status IN ('picking', 'confirmed')`, [PICK_BRANCH[branch]]);
  let fixed = 0;
  for (const pick of picks) {
    const { rows } = await db.query(
      `SELECT d.raw->>'productCode' AS code FROM order_details d JOIN orders o ON o.branch = d.branch AND o.id = d.order_id
        WHERE o.branch = $1 AND lower(btrim(o.code)) = $2 ORDER BY d.line_no`, [branch, key(pick.order_code)]);
    const rank = new Map();
    rows.forEach((row, i) => { if (!rank.has(key(row.code))) rank.set(key(row.code), i); });
    const lines = Array.isArray(pick.order_snapshot?.lines) ? pick.order_snapshot.lines : [];
    const next = lines.map((line, i) => ({ line, i }))
      .sort((a, b) => (rank.get(key(a.line.productCode)) ?? 1e9) - (rank.get(key(b.line.productCode)) ?? 1e9) || a.i - b.i)
      .map(item => item.line);
    if (next.every((line, i) => line === lines[i])) continue;
    fixed++;
    if (!dryRun) {
      await db.query(`UPDATE order_pick_assignments SET order_snapshot = jsonb_set(order_snapshot, '{lines}', $2::jsonb) WHERE id = $1`,
        [pick.id, JSON.stringify(next)]);
    }
  }
  console.log(`${branch}: ${picks.length} phieu chi dinh dang mo, sap lai ${fixed}${dryRun ? ' (dry-run)' : ''}.`);
}

(async () => {
  // Dung pool (moi cau lenh muon ket noi rieng): giu 1 ket noi qua lau trong luc goi Kiot bi Supabase cat.
  const pool = getPool();
  for (const branch of ['hanoi', 'saigon']) await resortBranch(pool, branch);
})().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(), 100));
