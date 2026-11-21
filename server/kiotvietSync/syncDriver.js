'use strict';

const { getPool } = require('../db/pool');
const checkpointRepository = require('./checkpointRepository');
const { dashboardRollupEvents } = require('./dashboardRollupEvents');

// Bao cho cache Dashboard (dashboardData.js) biet bang invoices vua thuc su co
// dong duoc ghi (SAU COMMIT) — cache Hoa don/Chi tiet hoa don chi het han khi
// co tin hieu nay + rollup 'updated' ke tiep, khong het han theo nhip timer.
function notifyInvoicesWritten(events, entityModule, branch, items) {
  if (entityModule.entity !== 'invoices' || !items || !items.length) return;
  events.emit('invoicesChanged', { branch, count: items.length });
}

const INCREMENTAL_OVERLAP_MS = 5 * 60 * 1000;

function createSyncDriver({ pool = getPool(), checkpointRepository: checkpoints = checkpointRepository, now = Date.now, logger = console, events = dashboardRollupEvents } = {}) {
  async function inTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await work(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function pollCashFlows(kiotVietClient, branch, entityModule, checkpoint, runEndIso) {
    if (entityModule.reconcileIntervalMs) {
      let lastReconciledAt;
      try { lastReconciledAt = JSON.parse(checkpoint?.note || '{}').reconciledAt; } catch (_) {}
      const lastMs = Date.parse(lastReconciledAt);
      const full = !Number.isFinite(lastMs) || Date.parse(runEndIso) - lastMs >= entityModule.reconcileIntervalMs;
      // startDate filters transaction time, not modification time. Replay recent
      // days between daily complete sweeps so old edits/cancellations are repaired.
      const range = full ? {startDate:'1970-01-01T00:00:00.000Z',endDate:runEndIso} : {
        startDate: new Date(Math.min(Date.parse(checkpoint.last_synced_at) || Date.parse(runEndIso), Date.parse(runEndIso) - entityModule.replayWindowMs)).toISOString(),
        endDate: runEndIso
      };
      const seenIds = new Set();
      for (const isReceipt of ['true','false']) {
        const streamIds = new Set();
        let expectedTotal;
        await kiotVietClient.fetchAllPages(entityModule.endpoint, {...entityModule.listQuery,...range,isReceipt}, async (page,info)=>{
          if (info?.total != null) expectedTotal = Number(info.total);
          for (const item of page) {
            const id = String(item.Id ?? item.id);
            streamIds.add(id);
            seenIds.add(id);
          }
          const items=page.map(item=>({...item,IsReceipt:isReceipt==='true'}));
          await inTransaction(client=>(entityModule.reconcilePage || entityModule.upsertPage)(client,branch,items));
        });
        if (Number.isFinite(expectedTotal) && streamIds.size !== expectedTotal)
          throw new Error(`Incomplete cash flow snapshot: ${branch}/${isReceipt}, ${streamIds.size}/${expectedTotal} unique IDs`);
      }
      // Preserve historical rows; only flag missing source IDs after a complete
      // sweep. Publish that flag and the completed marker in the same transaction.
      await inTransaction(async client=>{
        if (full && entityModule.markMissing)
          await entityModule.markMissing(client,branch,[...seenIds],runEndIso);
        await checkpoints.advanceCheckpoint(branch,entityModule.entity,runEndIso,{
          client,note:JSON.stringify({windowEnd:runEndIso,reconciledAt:full?runEndIso:lastReconciledAt})
        });
      });
      return;
    }
    const noteDate = checkpoint?.note && Date.parse(checkpoint.note);
    const startDate = Number.isFinite(noteDate)
      ? new Date(noteDate).toISOString()
      : checkpoint?.last_synced_at
        ? new Date(checkpoint.last_synced_at).toISOString()
        : new Date(Date.parse(runEndIso) - 60 * 60 * 1000).toISOString();
    const items = [];
    for (const isReceipt of ['true', 'false']) {
      await kiotVietClient.fetchAllPages(entityModule.endpoint, {
        ...entityModule.listQuery, startDate, endDate: runEndIso, isReceipt
      }, async (pageItems) => {
        // API khong tra field phan biet thu/chi trong item - phai gan tu
        // query da dung de lay item nay, khong doc tu item.
        items.push(...pageItems.map((item) => ({ ...item, IsReceipt: isReceipt === 'true' })));
      });
    }
    await inTransaction(async (client) => {
      await entityModule.upsertPage(client, branch, items);
      await checkpoints.advanceCheckpoint(branch, entityModule.entity, runEndIso, { client, note: runEndIso });
    });
  }

  // Entity dang "tang dan + doi soat day du dinh ky" (customers, products): poll tang
  // dan theo lastModifiedFrom, moi `reconcileIntervalMs` quet TOAN BO mot lan de vua
  // cac dong tang dan bo sot (nhieu dong cung modifiedDate khi sua hang loat lam
  // phan trang theo vi tri truot dong) va danh dau dong da het ton tai o nguon.
  // Entity khai bao: reconcileMarkerKey (khoa luu moc quet day du trong
  // sync_checkpoints.note), snapshotLabel (cho thong bao loi), changeEvent (tuy chon),
  // fullScanQuery (tham so them khi quet day du), reconcilePage (tuy chon, thay
  // upsertPage khi quet day du), applyPageMetadata (tuy chon), markMissing.
  async function pollReconciled(api, branch, entity, checkpoint, runEndIso) {
    const markerKey = entity.reconcileMarkerKey;
    const label = entity.snapshotLabel || entity.entity;
    let reconciledAt;
    try { reconciledAt = JSON.parse(checkpoint?.note || '{}')[markerKey]; } catch (_) {}
    const lastFullMs = Date.parse(reconciledAt);
    const full = !Number.isFinite(lastFullMs) || Date.parse(runEndIso) - lastFullMs >= entity.reconcileIntervalMs;
    const query = { ...entity.listQuery };
    // Many rows share modifiedDate; sorting by a unique, immutable ID
    // prevents tied rows moving across offset pages during a scan.
    const stableOrder = { orderBy: 'id', orderDirection: 'ASC' };
    if (full) Object.assign(query, entity.fullScanQuery || stableOrder);
    // Poll tang dan cung sap theo id: mac dinh customers sap theo modifiedDate, dong vua quet
    // bi sua lai (sua hang loat dang dien ra) nhay xuong cuoi lam trang ke tiep truot 1 dong,
    // ma dong bi truot co modifiedDate cu hon moc checkpoint nen khong bao gio duoc doc lai.
    // Chong lan 5 phut: moc la gio BAT DAU luot truoc theo dong ho may minh (lech KiotViet ~2s,
    // them thoi gian quet va tre hien thi); upsert idempotent nen doc lai vai dong la re.
    else Object.assign(query, stableOrder, {
      [entity.incrementalParam]: new Date(Date.parse(checkpoint.last_synced_at) - INCREMENTAL_OVERLAP_MS).toISOString()
    });
    const writePage = full && entity.reconcilePage ? entity.reconcilePage : entity.upsertPage;
    const seenIds = new Set();
    let expectedTotal;
    await api.fetchAllPages(entity.endpoint, query, async (items, info) => {
      if (full) {
        const total = Number(info?.total);
        if (info?.total == null || !Number.isInteger(total) || total <= 0 || !items.length
          || (expectedTotal !== undefined && expectedTotal !== total)) {
          throw new Error(`Incomplete ${label} snapshot: ${branch}, invalid or empty page/total`);
        }
        expectedTotal = total;
        for (const item of items) {
          const id = String(item.Id ?? item.id ?? item.CustomerId ?? item.customerId ?? item.ProductId ?? item.productId ?? '');
          if (!/^[1-9]\d*$/.test(id) || seenIds.has(id)) throw new Error(`Incomplete ${label} snapshot: ${branch}, missing/duplicate ID`);
          seenIds.add(id);
        }
      }
      await inTransaction(async client => {
        await writePage(client, branch, items);
        if (entity.applyPageMetadata) await entity.applyPageMetadata(client, branch, info);
      });
    }, { requireComplete: full });
    if (full && (expectedTotal === undefined || seenIds.size !== expectedTotal)) {
      throw new Error(`Incomplete ${label} snapshot: ${branch}, ${seenIds.size}/${expectedTotal} unique IDs`);
    }
    // Only a complete, validated scan may flag absences. The completion marker
    // commits with those flags, so failures retry the full scan on the next poll.
    await inTransaction(async client => {
      if (full) await entity.markMissing(client, branch, [...seenIds], runEndIso);
      await checkpoints.advanceCheckpoint(branch, entity.entity, runEndIso, {
        client, note: JSON.stringify({ windowEnd: runEndIso, [markerKey]: full ? runEndIso : reconciledAt })
      });
    });
    if (entity.changeEvent) events.emit(entity.changeEvent, { branch });
  }

  // Entity co minIntervalMs (vd product_on_hands_snapshot: quet toan bo, nang) chi
  // chay khi lan thanh cong truoc da du cu, va khong bao gio chay chong nhau.
  const inFlight = new Set();
  const reconcileInFlight = new Map();

  async function pollEntityOnce(kiotVietClient, branch, entityModule) {
    if (entityModule.reconcileMarkerKey) {
      const key = `${branch}:${entityModule.entity}`;
      if (reconcileInFlight.has(key)) return reconcileInFlight.get(key);
      const running = pollEntityNow(kiotVietClient, branch, entityModule);
      reconcileInFlight.set(key, running);
      try { return await running; }
      finally { reconcileInFlight.delete(key); }
    }
    if (!entityModule.minIntervalMs) return pollEntityNow(kiotVietClient, branch, entityModule);
    const key = `${branch}:${entityModule.entity}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      const checkpoint = await checkpoints.getCheckpoint(branch, entityModule.entity);
      const lastMs = checkpoint?.last_synced_at ? new Date(checkpoint.last_synced_at).getTime() : NaN;
      if (Number.isFinite(lastMs) && now() - lastMs < entityModule.minIntervalMs) return;
      return await pollEntityNow(kiotVietClient, branch, entityModule);
    } finally {
      inFlight.delete(key);
    }
  }

  async function pollEntityNow(kiotVietClient, branch, entityModule) {
    const checkpoint = await checkpoints.getCheckpoint(branch, entityModule.entity);
    const runEndIso = new Date(now()).toISOString();
    if (entityModule.entity === 'cash_flows') {
      return pollCashFlows(kiotVietClient, branch, entityModule, checkpoint, runEndIso);
    }
    if (entityModule.reconcileMarkerKey && entityModule.reconcileIntervalMs) {
      return pollReconciled(kiotVietClient, branch, entityModule, checkpoint, runEndIso);
    }
    const neverSynced = !checkpoint?.last_synced_at;
    // Entity CHUA TUNG dong bo thanh cong (checkpoint rong) va khong can
    // chunk theo thang (khong co backfillRangeParam - dang "snapshot" nhu
    // categories/products/customers/product_on_hands, giong tieu
    // chi backfillPlan.js dung de goi 1 chunk 'full' khong loc ngay): quet
    // TOAN BO du lieu hien tai ngay trong lan poll dau tien, thay vi fallback
    // "1 gio gan nhat" (fallback nay chi hop ly cho truong hop da co checkpoint
    // cu, dung de bu khoang trong ngan do server restart/redeploy - ap dung
    // no cho entity moi hoan toan se bo sot toan bo du lieu cu, dung nguyen
    // nhan gay sai lech ton kho hang loat 2026-09-23, xem product_on_hands).
    // Entity co backfillRangeParam (vd invoices, log giao dich lon) van giu
    // fallback 1 gio - lan dau cho entity dang nay phai chay qua CLI
    // backfill.js (co chunk theo thang) de tranh 1 request khong gioi han.
    if (entityModule.pollFullSnapshot || (neverSynced && !entityModule.backfillRangeParam)) {
      logger.log(`[KiotViet Sync] ${branch}/${entityModule.entity}: doi soat toan bo danh sach.`);
      const query = { ...entityModule.listQuery, ...entityModule.pollQuery };
      await kiotVietClient.fetchAllPages(entityModule.endpoint, query, async (items) => {
        await inTransaction(async (client) => {
          await (entityModule.reconcilePage || entityModule.upsertPage)(client, branch, items);
        });
        notifyInvoicesWritten(events, entityModule, branch, items);
      });
      await inTransaction(client => checkpoints.advanceCheckpoint(branch, entityModule.entity, runEndIso, { client }));
      return;
    }
    // Orders can become visible after a successful poll while their source timestamp
    // is already older than our checkpoint (clock skew/API delay). Replay the same
    // bounded overlap used for reconciled entities; document upserts are idempotent.
    const overlapMs = entityModule.entity === 'orders' ? INCREMENTAL_OVERLAP_MS : 0;
    const sinceIso = checkpoint?.last_synced_at
      ? new Date(new Date(checkpoint.last_synced_at).getTime() - overlapMs).toISOString()
      : new Date(Date.parse(runEndIso) - 60 * 60 * 1000).toISOString();
    const query = { ...entityModule.listQuery, [entityModule.incrementalParam]: sinceIso };
    await kiotVietClient.fetchAllPages(entityModule.endpoint, query, async (items) => {
      await inTransaction(async (client) => {
        await entityModule.upsertPage(client, branch, items);
      });
      notifyInvoicesWritten(events, entityModule, branch, items);
    });
    // A timestamp is a completed window, not a page cursor. If a later page
    // fails, replay the old window (upserts are idempotent) on the next poll.
    await inTransaction(client => checkpoints.advanceCheckpoint(branch, entityModule.entity, runEndIso, { client }));
  }

  return { pollEntityOnce };
}

const driver = createSyncDriver();
module.exports = { ...driver, createSyncDriver };
