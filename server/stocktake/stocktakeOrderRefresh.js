'use strict';

// Nut "Cap nhat don Kiot" tren trang Kiem ke: lay ngay cac don vua sua tren KiotViet, chi ghi don TEAM + so.
// KHONG doi checkpoint: luot nen van tu quet lai cua so cua no, ghi de cung noi dung (upsert lap lai vo hai).
// Khong dung syncDriver.pollEntityOnce vi ham do tien checkpoint va se ghi ca don khong lien quan.
const { getPool } = require('../db/pool');

const MIN_INTERVAL_MS = 15 * 1000;
const OVERLAP_MS = 5 * 60 * 1000; // dong ho KiotViet lech vai giay so voi may chu
const NO_CHECKPOINT_WINDOW_MS = 60 * 60 * 1000;
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const TEAM_ORDER_NAME = /^\s*TEAM\s*[0-9]/iu; // cung y nghia voi TEAM_NAME_MATCH_SQL trong stocktakeService.js

const isTeamOrder = item => TEAM_ORDER_NAME.test(String((item && (item.customerName || item.CustomerName)) || ''));

function failure(code, message) {
  return Object.assign(new Error(message), { statusCode: 424, code });
}

function createOrderRefresher({
  getDb = getPool,
  getBranches = () => require('../kiotvietSync/config').getConfiguredBranches({ warn: () => {} }),
  createClient = require('../kiotviet/kiotVietApiClient').createKiotVietClient,
  ordersEntity = require('../kiotvietSync/entities/orders'),
  now = Date.now,
  logger = console
} = {}) {
  const running = new Map(); // branch -> promise
  const last = new Map(); // branch -> { at, result }

  async function sinceOf(db, branch) {
    const { rows } = await db.query(`SELECT last_synced_at FROM sync_checkpoints WHERE branch = $1 AND entity = 'orders'`, [branch]);
    const synced = rows[0] && rows[0].last_synced_at ? new Date(rows[0].last_synced_at).getTime() : NaN;
    const from = Number.isFinite(synced) ? Math.min(synced, now()) - OVERLAP_MS : now() - NO_CHECKPOINT_WINDOW_MS;
    return new Date(Math.max(from, now() - MAX_WINDOW_MS)).toISOString();
  }

  // Chi giu don chua co hoac da doi so voi DB: luot nen thuong da ghi phan lon, ghi lai ton nhieu vong toi Supabase.
  async function changedOnly(db, branch, items) {
    const ids = items.map(item => item.id ?? item.Id);
    const { rows } = await db.query(`SELECT id, raw->>'modifiedDate' AS modified FROM orders WHERE branch = $1 AND id = ANY($2::bigint[])`, [branch, ids]);
    const known = new Map(rows.map(row => [String(row.id), row.modified || null]));
    return items.filter(item => {
      const id = String(item.id ?? item.Id);
      return !known.has(id) || known.get(id) !== (item.modifiedDate ?? item.ModifiedDate ?? null);
    });
  }

  async function writePage(db, branch, items) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await ordersEntity.upsertPage(client, branch, items);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function run(branch) {
    const config = getBranches().find(item => item.branch === branch);
    if (!config) throw failure('KIOT_NOT_CONFIGURED', 'Cơ sở này chưa cấu hình kết nối KiotViet.');
    const db = getDb();
    let fetched = 0;
    let teamOrders = 0;
    try {
      const client = createClient({ ...config, requestOptions: { maxRetries: 2, timeoutMs: 15000 } });
      const query = { ...ordersEntity.listQuery, lastModifiedFrom: await sinceOf(db, branch) };
      await client.fetchAllPages(ordersEntity.endpoint, query, async items => {
        fetched += items.length;
        const team = items.filter(isTeamOrder);
        if (!team.length) return;
        const changed = await changedOnly(db, branch, team);
        if (!changed.length) return;
        await writePage(db, branch, changed);
        teamOrders += changed.length;
      });
    } catch (error) {
      logger.error('[stocktake] cap nhat don Kiot loi:', error.message);
      throw failure('KIOT_READ_FAILED', 'Không cập nhật được đơn từ KiotViet. Thử lại sau ít phút.');
    }
    const result = { fetched, teamOrders, refreshedAt: new Date(now()).toISOString(), cached: false };
    last.set(branch, { at: now(), result });
    return result;
  }

  return function refresh(branch) {
    const inFlight = running.get(branch);
    if (inFlight) return inFlight;
    const recent = last.get(branch);
    if (recent && now() - recent.at < MIN_INTERVAL_MS) return Promise.resolve({ ...recent.result, cached: true });
    const work = run(branch).finally(() => running.delete(branch));
    running.set(branch, work);
    return work;
  };
}

module.exports = { createOrderRefresher, isTeamOrder, refreshTeamOrders: createOrderRefresher() };
