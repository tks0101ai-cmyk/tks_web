'use strict';

const { getPool } = require('../db/pool');
const { projectContainers } = require('./purchaseOrdersProjection');
const { invalidateContainerDetails } = require('../productContainers/repository');
const { dashboardRollupEvents } = require('../kiotvietSync/dashboardRollupEvents');

const PROJECTION_LOCK_KEY = 20531074;
const EXPECTED_LOCK_KEY = 20531073;
const INTERVAL_MS = 750;
let timer = null;
let running = null;

async function processPending({ pool = getPool(), project = projectContainers, events = dashboardRollupEvents, log = console, projectionLockKey = PROJECTION_LOCK_KEY, expectedLockKey = EXPECTED_LOCK_KEY } = {}) {
  if (running) return running;
  running = processOnce({ pool, project, events, log, projectionLockKey, expectedLockKey });
  try { return await running; } finally { running = null; }
}

async function processOnce({ pool, project, events, log, projectionLockKey, expectedLockKey }) {
  const client = await pool.connect();
  let active = false;
  let target = null;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const projectionLock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [projectionLockKey]);
    if (projectionLock.rows[0]?.locked !== true) {
      await client.query('ROLLBACK');
      return { status: 'busy' };
    }
    // expectedRefresh uses this second lock. The shared projection may proceed
    // beside canonical writes, but only one reader may replace expected rows.
    const expectedLock = await client.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [expectedLockKey]);
    if (expectedLock.rows[0]?.locked !== true) {
      await client.query('ROLLBACK');
      return { status: 'busy' };
    }
    const settings = (await client.query('SELECT source_mode,integration_enabled FROM purchase_settings WHERE id=1')).rows[0];
    if (settings?.source_mode !== 'web' || settings?.integration_enabled !== true) {
      await client.query('COMMIT');
      return { status: 'inactive' };
    }
    target = (await client.query('SELECT max(id)::text AS id FROM purchase_projection_queue')).rows[0]?.id;
    if (target == null) {
      await client.query('COMMIT');
      return { status: 'idle' };
    }
    active = true;
    await project(client);
    const deleted = await client.query('DELETE FROM purchase_projection_queue WHERE id <= $1', [target]);
    await client.query('COMMIT');
    try {
      invalidateContainerDetails(pool);
      events.emit('containersChanged', { source: 'purchase-projection' });
    } catch (error) {
      log.error('[Purchase projection] Read-model invalidation failed:', error.message || error);
    }
    log.log(`[Purchase projection] Processed through ${target}; coalesced ${deleted.rowCount || 0} requests`);
    return { status: 'processed', through: target, coalesced: deleted.rowCount || 0 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (active) {
      await pool.query('UPDATE purchase_projection_queue SET last_error=$1 WHERE id <= $2', [String(error.message || error).slice(0, 1000), target]).catch(() => {});
      log.error('[Purchase projection] Background projection failed; will retry:', error.message || error);
    }
    return { status: active ? 'failed' : 'error', error };
  } finally {
    client.release();
  }
}

function startPurchaseProjectionQueue({ pool = getPool(), intervalMs = INTERVAL_MS, log = console } = {}) {
  if (timer) return { stop: stopPurchaseProjectionQueue };
  let retryAfter = 0;
  const tick = async () => {
    if (running) return;
    const result = await processPending({ pool, log });
    retryAfter = ['failed', 'error', 'inactive'].includes(result.status) ? Date.now() + 5000 : 0;
    if (result.status === 'error') log.error('[Purchase projection] Queue unavailable; will retry:', result.error?.message || result.error);
  };
  timer = setInterval(() => { if (Date.now() >= retryAfter) tick().catch(error => log.error('[Purchase projection] Scheduler error:', error.message || error)); }, intervalMs);
  timer.unref?.();
  tick().catch(error => log.error('[Purchase projection] Initial run failed:', error.message || error));
  return { stop: stopPurchaseProjectionQueue };
}

function stopPurchaseProjectionQueue() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { processPending, startPurchaseProjectionQueue, stopPurchaseProjectionQueue, __test__: { state: () => ({ running: !!running, started: !!timer }) } };
