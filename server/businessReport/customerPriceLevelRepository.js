'use strict';

const { getPool } = require('../db/pool');
const { nameKey, PRICE_LEVEL_LABELS, RETAIL_NAME, UNGROUPED_SALE } = require('./businessMonths');
const { buildCustomerReport } = require('./businessReportService');
const { customerLevelFromEmail } = require('../invoicePriceAudit/priceAuditRules');
const { httpError } = require('./customerProfileRules');

const pending = () => httpError(503, 'MIGRATION_PENDING', 'Level giá nội bộ chưa sẵn sàng. Cần sao lưu và khởi tạo level giá trước.');
const fromLabel = label => Object.keys(PRICE_LEVEL_LABELS).find(k => PRICE_LEVEL_LABELS[k] === label);

async function assertInitialized(client) {
  const { rows } = await client.query('SELECT initialized_at FROM customer_price_level_state WHERE id');
  if (!rows[0]?.initialized_at) throw pending();
}

// Capture supplies its own repeatable-read client so all invoices see the same level versions.
async function readCustomerPriceLevels(client, keys) {
  try {
    await assertInitialized(client);
    const unique = [...new Set(keys)];
    const { rows } = await client.query('SELECT customer_key, level, version FROM customer_price_levels WHERE customer_key = ANY($1::text[])', [unique]);
    const result = Object.fromEntries(unique.map(key => [key, { level: 'large', version: 0 }]));
    for (const r of rows) result[r.customer_key] = { level: r.level, version: Number(r.version) };
    return result;
  } catch (err) {
    if (err.code === '42P01' || err.code === '42703') throw pending();
    throw err;
  }
}

function createCustomerPriceLevelRepository({ pool = null } = {}) {
  const db = () => pool || getPool();
  async function transaction(fn) {
    const client = await db().connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '42P01' || err.code === '42703') throw pending();
      if (err.code === '40001' || err.code === '23505') throw httpError(409, 'PRICE_LEVEL_CONFLICT', 'Level giá đã thay đổi. Vui lòng tải lại bảng.');
      throw err;
    } finally { client.release(); }
  }
  // Revenue snapshot is used only to preserve the merged level selection. Directory/email are
  // re-read and archived inside this transaction; a completed initialization is never repeated.
  async function initialize(snapshot) {
    return transaction(async client => {
      const state = (await client.query('SELECT initialized_at FROM customer_price_level_state WHERE id FOR UPDATE')).rows[0];
      if (state?.initialized_at) return { alreadyInitialized: true };
      // Prevent a source sync from changing the directory between archive and cutover.
      await client.query('LOCK TABLE customers IN SHARE MODE');
      const { rows } = await client.query(`SELECT branch, id::text AS id, code, COALESCE(name,'') AS name,
        COALESCE(raw->>'email', raw->>'Email','') AS email, COALESCE(NULLIF(btrim(raw->>'groups'),''),$1) AS sale_name,
        COALESCE(raw->>'isActive',raw->>'IsActive','true') <> 'false' AS is_active
        FROM customers ORDER BY branch, id DESC`, [UNGROUPED_SALE]);
      const directory = [], seen = new Set(), candidates = new Map(), sources = [];
      for (const r of rows) {
        const key = nameKey(r.name) || nameKey(RETAIL_NAME);
        const level = customerLevelFromEmail(r.email);
        sources.push({ branch:r.branch, customer_id:r.id, customer_code:r.code, customer_name:r.name,
          customer_key:key, source_email:r.email, source_level:level });
        if (!candidates.has(key) || candidates.get(key) === 'medium') candidates.set(key, level);
        const ref = JSON.stringify([r.branch, String(r.code || '').trim()]);
        if (!seen.has(ref)) {
          seen.add(ref);
          if (r.is_active && r.code) directory.push({ branch:r.branch, code:String(r.code).trim(), name:r.name, saleName:r.sale_name, priceLevel:PRICE_LEVEL_LABELS[level] });
        }
      }
      // Active report rows follow precisely the existing aggregation/selection rule.
      for (const row of buildCustomerReport({ ...snapshot, directory }).rows) {
        candidates.set(row.key, fromLabel(row.priceLevel) || 'medium');
      }
      await client.query(`INSERT INTO customer_price_level_sources
        (branch,customer_id,customer_code,customer_name,customer_key,source_email,source_level)
        SELECT branch,customer_id::bigint,customer_code,customer_name,customer_key,source_email,source_level
        FROM jsonb_to_recordset($1::jsonb) AS x(branch text,customer_id text,customer_code text,
          customer_name text,customer_key text,source_email text,source_level text) ON CONFLICT DO NOTHING`, [JSON.stringify(sources)]);
      await client.query(`INSERT INTO customer_price_levels(customer_key,level)
        SELECT customer_key,level FROM jsonb_to_recordset($1::jsonb) AS x(customer_key text,level text)
        ON CONFLICT DO NOTHING`, [JSON.stringify([...candidates].map(([customer_key,level]) => ({ customer_key,level })))]);
      await client.query('UPDATE customer_price_level_state SET initialized_at = now() WHERE id');
      return { archivedSources: rows.length, customerLevels: candidates.size };
    });
  }
  async function saveLevel(key, level, version, actor = {}) {
    if (!Object.hasOwn(PRICE_LEVEL_LABELS, level) || !Number.isSafeInteger(version) || version < 0) {
      throw httpError(400, 'INVALID_PRICE_LEVEL', 'Level giá hoặc phiên bản không hợp lệ.');
    }
    return transaction(async client => {
      await assertInitialized(client);
      const existing = (await client.query('SELECT level,version FROM customer_price_levels WHERE customer_key=$1 FOR UPDATE', [key])).rows[0];
      if ((existing ? Number(existing.version) : 0) !== version) throw httpError(409, 'PRICE_LEVEL_CONFLICT', 'Level giá đã thay đổi. Vui lòng tải lại bảng.');
      if (existing?.level === level) return { level, version };
      const nextVersion = version + 1;
      const actorId = actor.id == null ? null : String(actor.id), actorName = String(actor.name || '');
      await client.query(`INSERT INTO customer_price_levels(customer_key,level,version,updated_by_id,updated_by_name)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT(customer_key) DO UPDATE SET level=EXCLUDED.level,
        version=EXCLUDED.version,updated_by_id=EXCLUDED.updated_by_id,updated_by_name=EXCLUDED.updated_by_name,updated_at=now()`,
      [key,level,nextVersion,actorId,actorName]);
      await client.query(`INSERT INTO customer_price_level_history(customer_key,old_level,new_level,version,actor_id,actor_name)
        VALUES ($1,$2,$3,$4,$5,$6)`, [key,existing?.level || 'large',level,nextVersion,actorId,actorName]);
      return { level, version: nextVersion };
    });
  }
  return { initialize, getLevels: keys => transaction(client => readCustomerPriceLevels(client,keys)), saveLevel };
}

module.exports = { createCustomerPriceLevelRepository, readCustomerPriceLevels };
