# Thu mua: Tái sử dụng Mã dòng — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reuse the smallest available root Mã dòng after deletion while keeping old orders, split families, history, undo, and concurrent reservations tied to immutable database IDs.
**Architecture:** Add one additive migration that gives each split family a stable `root_order_id`, permits duplicate row keys only among soft-deleted records, and stores free keys and expiring reservations. Keep allocation and every create/delete/restore/import/undo operation inside the existing purchase transaction and advisory lock; use immutable `purchase_orders.id` and `root_order_id` for history lookups.
**Tech Stack:** Node.js 22 CommonJS, Express, PostgreSQL, PGlite, node:test, vanilla JavaScript.

## Global Constraints

- Work directly on `main`; do not create a branch or worktree.
- Do not change or delete an already applied migration; add `server/db/migrations/0125_purchase_recyclable_row_keys.sql`.
- Do not physically delete order or audit history as part of this feature.
- Keep visible key format `D#####` and split suffixes `.01` / `.02`.
- Keep `purchase_orders.id` immutable; all internal family/history identity uses `id` / `root_order_id`, never a reusable display key.
- The smallest free root key is allocated before `nextval('purchase_order_key_seq')`; never decrement or reset the sequence.
- A root key returns to the pool only after every active branch with the same `root_order_id` is soft-deleted.
- Import remains a full snapshot: process omitted rows and allocate keys for blank-key creates in one transaction; stale revisions still fail without writes.
- Restore/undo must never take a key from an active order. If an old key has been reused, preserve the old internal order and allocate a new root key for its family.
- Validate route permissions and reservation ownership at the server boundary; reservation expiry is 30 minutes.
- No new dependency or runtime module is needed.

---

## File Map

| File | Responsibility |
|---|---|
| `server/db/migrations/0125_purchase_recyclable_row_keys.sql` | Add stable split-family identity, recyclable key pool, expiring reservations, active-only row-key uniqueness, and cycle-safe key history; backfill existing data. |
| `server/db/ensurePurchaseSchema.js` | Register migration 0125 in the purchase-only startup migration allowlist. |
| `server/purchaseOrders/importSourceRows.js` | Keep the Sheets source importer compatible with the active-only partial unique index. |
| `server/purchaseOrders/importSourceRows.test.js` | Verify duplicate active source rows are still safely ignored under partial uniqueness. |
| `server/purchaseOrders/purchaseOrdersService.js` | Allocate/reserve/claim/release keys and update create, split, delete, restore, undo, history, and snapshot import transaction paths. |
| `server/purchaseOrders/purchaseOrdersRoutes.js` | Add authorized reservation-release API and address history by stable order identity. |
| `server/purchaseOrders/purchaseOrdersService.test.js` | PGlite coverage for key lifecycle, import, split family, restore, undo, audit isolation, and concurrent reservation. |
| `server/purchaseOrders/purchaseOrdersRoutes.test.js` | Reservation release and history route validation/permission coverage. |
| `server/public/thu-mua/dat-hang/purchase.js` | Carry reservation ID through local new-row draft/save; release unused reservations and request history using stable identity. |
| `server/README.md`, `server/db/SCHEMA.md`, `README.md` | Migration list, API contract, schema and recent-change entries. |
| `docs/04-planning/implementation_plan.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `docs/01-brd/BRD_Dashboard_GoogleSheets.md` | Record the approved allocation, import and historical-identity behavior. |
| `CURRENT.md` | Keep one current status line until migration and production rollout are complete. |

## Interfaces

- `service.reserveKey(user)` returns `{ rowKey, reservationId, expiresAt }`; it claims the smallest key in `purchase_key_pool`, or allocates a never-issued sequence key, and persists an actor-owned 30-minute reservation.
- `service.releaseKey(user, { reservationId })` releases only an unconsumed reservation belonging to that actor; unknown, expired, consumed, or other-user reservations do not free another user’s key.
- `POST /api/purchase-orders/next-key` keeps returning the reserve result and requires `purchase.edit`.
- `POST /api/purchase-orders/release-key` accepts `{ reservationId }`, requires `purchase.edit`, and returns `{ released: boolean }`.
- `POST /api/purchase-orders/plan` create entries carry `{ values, reservationId }`; `claimKey(client, userId, values.rowKey, reservationId)` consumes the matching reservation exactly once. Legacy callers without a reservation ID may create only through server allocation when no row key is supplied; a supplied key without a valid reservation is rejected.
- `GET /api/purchase-orders/history` accepts `{ orderId }` and resolves the full family by `root_order_id`. The frontend sends the selected row’s immutable `id`. `rowKey` is no longer accepted as an identity selector.
- Each `purchase_orders` row has `root_order_id BIGINT NOT NULL REFERENCES purchase_orders(id) DEFERRABLE INITIALLY DEFERRED`; a before-insert trigger defaults a new root row to its generated `id`, and split descendants explicitly inherit the original root row ID.
- Migration tables: `purchase_key_pool(row_key TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())`; `purchase_key_reservations(reservation_id UUID PRIMARY KEY, row_key TEXT NOT NULL UNIQUE, actor_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL)`. Change `purchase_key_history` from `row_key` primary key to immutable assignment rows with `id BIGSERIAL PRIMARY KEY`, `row_key`, `order_id`, `root_order_id`, `root_key`, and `retired_at`; duplicate visible keys are allowed across reuse cycles. Add `root_order_id` to `purchase_operation_rows` and backfill old snapshots so audit history still distinguishes families after an undone create physically removes its row. Expired reservations are reclaimed atomically by `reserveKey`; explicit release returns their key to the pool.

## Task 1 — Schema migration and legacy backfill

**Files:** create `server/db/migrations/0125_purchase_recyclable_row_keys.sql`; modify `server/db/ensurePurchaseSchema.js`, `server/purchaseOrders/importSourceRows.js`, `server/purchaseOrders/importSourceRows.test.js`, `server/purchaseOrders/purchaseOrdersService.js` (only the legacy `ON CONFLICT(row_key)` insert compatibility), and `server/purchaseOrders/purchaseOrdersService.test.js`.

**Interfaces:** `purchase_orders.root_order_id`; `purchase_operation_rows.root_order_id`; `purchase_key_pool`; `purchase_key_reservations`; partial unique index `purchase_orders_active_row_key_uq` on `row_key WHERE deleted_at IS NULL`.

1. [ ] Add migration assertions against a PGlite database migrated only through 0122, then populated with legacy root/split rows, imported `.01/.02` siblings without a root row/history record, an undoable operation with old JSON snapshots, and deleted/active families. Apply 0125 and assert family IDs are consistent, old undo JSON gains `root_order_id`, active+deleted keys can coexist, duplicate-history assignment rows work, and only fully inactive families seed the pool. **Deferred:** the non-null legacy `after_row` snapshot fixture is not included yet, so this complete assertion substep remains unchecked.
2. [x] Create migration 0125: add nullable `root_order_id`; backfill all order rows by existing `root_key` family (prefer legacy root-key history, then a root row, then the minimum row ID in the same root_key family), so imported `.01/.02` siblings without a root row/history share one stable ID. Set `NOT NULL` and the deferred self-FK. Add the before-insert trigger that defaults a root’s family ID to its generated `id`. Drop the table-wide `purchase_orders.row_key` unique constraint and create a partial unique index for active rows. Replace the `purchase_key_history.row_key` primary key with an identity primary key and add `root_order_id`, retaining every legacy history row; temporarily remove and restore its immutable trigger around this one-time backfill. Add/backfill `purchase_operation_rows.root_order_id`, and write it into `before_row`, `after_row`, and `purchase_undo_expected.expected_row` JSON so exact undo comparison remains valid after 0125. Create the pool/reservation tables and expiry index; seed only root keys whose entire `root_order_id` family has no active rows; register 0125 in `ensurePurchaseSchema.FILES`. Change the split-history insert’s `ON CONFLICT(row_key)` to a conflict-safe form supported without that primary key; no other allocator/service behavior belongs in this task.
3. [x] Seed the pool with each root key from soft-deleted families that have no active rows, using a grouped query by `root_order_id`; do not seed any currently active root. Add a migration test that runs the seed twice and confirms idempotence and exact pool contents.
4. [x] Change the Sheets source insert from `ON CONFLICT(row_key) DO NOTHING` to the conflict target matching the active partial index; add/adjust its test so a repeated active source key is ignored. Run `node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/importSourceRows.test.js` and verify migration, backfill, duplicate-history, uniqueness and source-import assertions pass.
5. [x] Commit as `feat(purchase): add recyclable row key schema`.

## Task 2 — Transactional allocator and reservation API

**Files:** modify `server/purchaseOrders/purchaseOrdersService.js`, `server/purchaseOrders/purchaseOrdersRoutes.js`, `server/purchaseOrders/purchaseOrdersService.test.js`, `server/purchaseOrders/purchaseOrdersRoutes.test.js`, and `server/public/thu-mua/dat-hang/purchase.js`.

**Interfaces:** `reserveKey(user) -> {rowKey,reservationId,expiresAt}`; `releaseKey(user,{reservationId}) -> {released}`; `claimKey(client,userId,rowKey,reservationId)`; routes `POST /next-key`, `POST /release-key`. Frontend new-row draft stores `reservationId` and sends it separately from order values in the create entry posted to `/plan`. `/plan` returns `createdRows:[{clientId,id,rowKey}]`; the browser reconciles pending edits by immutable `id`, never by reusable `rowKey`.

1. [x] Add the reservation service test; the pre-implementation assertion was verified to fail, then the implemented reservation/release behavior was verified.
2. [x] Implement reserve/release in a standalone transaction using the existing purchase advisory lock (so reservations do not create empty undo operations). Reject reservations unless source mode is `web`. Delete expired reservations and return their keys to the pool; atomically take the lowest numeric root key from the pool or call `newKey(client)` when the pool is empty; insert the actor-owned reservation with 30-minute expiry. Consume a reservation once and verify actor, key, expiry, and unused status before insert. For an unsaved browser draft, `RESERVATION_EXPIRED` or `ROW_KEY_UNKNOWN` triggers one fresh reservation for every create in that current batch, followed by one retry; invalid tokens remain rejected by the server. Server-internal creates with no requested row key allocate a pool key directly; any caller supplying a row key must present its reservation ID.
3. [x] Add route tests asserting release route requires `purchase.edit`, forwards actor and reservation ID, and returns the service result; add invalid/missing-ID response assertion. Implement the route and request validation.
4. [x] Update the add-row form and autosave payload: retain `{rowKey,reservationId}` in local new-row state, keep reservation ID out of order values, and send `{clientId,values,reservationId}` per create. The server returns `{clientId,id,rowKey}` per create. Reconcile later local edits by returned immutable `id`, never by display code. Add jsdom integration assertions for token carry-through, reservation-expiry replacement, and a same-key/different-ID row appearing before the post-save refresh.
5. [x] Run the four-file service/route/realtime/live suite and report its result: 39 passed, 37 failed; the 37 failures remain unverified and are not classified as pre-existing. Do not describe this broad suite as passing.
6. [x] Commit as `feat(purchase): reserve recycled row keys safely`.

## Task 3 — Create, split, delete, restore, undo, and family history

**Files:** modify `server/purchaseOrders/purchaseOrdersService.js`, `server/purchaseOrders/purchaseOrdersService.test.js`, `server/purchaseOrders/purchaseOrdersRoutes.js`, `server/purchaseOrders/purchaseOrdersRoutes.test.js`.

**Interfaces:** root inserts set `root_order_id=id`; split inserts inherit source `root_order_id`; key reclamation is `releaseInactiveFamilyKey(client, rootOrderId)`; `history(user, orderId)`.

1. [x] Add the lifecycle/history failing assertions and verify they fail before implementation.
2. [x] Update root creation and split insertion to set `root_order_id`. On every row-key retirement (split or delete), append an immutable `purchase_key_history` assignment with `order_id` and `root_order_id`; never upsert by display key. After soft deletion, query active family branches and add the root key to `purchase_key_pool` only when none remain; use `ON CONFLICT DO NOTHING` to make repeated release idempotent.
3. [x] Update `restore`: keep the original family ID; if its old root key is available, remove it from pool and restore with existing keys; if an active family already owns that visible key, allocate a new free root key and remap every stored key in the old family while keeping every internal row ID, then restore only the requested row IDs. Update `undo` to perform the same collision-safe remap when reversing delete, and to avoid restoring a created row key over an active row.
4. [x] Change `history` to select by `root_order_id`; update route to require a positive `orderId` and reject old rowKey-only lookup. Add route test for malformed ID and use the internal ID end-to-end.
5. [x] Run `node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js`; final service+route verification passed 92/92 after the expired-reservation cleanup fix.
6. [x] Commit as `feat(purchase): recycle keys across order lifecycle`.

## Task 4 — Snapshot import and browser reservation lifecycle

**Files:** modify `server/purchaseOrders/purchaseOrdersService.js`, `server/purchaseOrders/purchaseOrdersService.test.js`, and `server/public/thu-mua/dat-hang/purchase.js`.

**Interfaces:** `commitImport` releases omitted families before creating blank-key rows in the same transaction; browser releases unconsumed reservations when an unsaved new row is removed/discarded and queries row history by immutable `orderId`.

1. [x] Add the snapshot-recycle failing service test and verify it fails before implementation.
2. [x] In `commitImport`, lock allocator through the existing transaction, soft-delete omissions and release root keys before allocating create rows. Preserve current stale-snapshot check and idempotent preview result; roll back releases if validation or insert fails.
3. [x] Update the browser removal/discard flow to release unconsumed reservations when an unsaved new row is removed or its draft is discarded. Keep reservation ID out of persisted order fields and imported workbook data. Switch row history click to send immutable row `id` as `orderId`.
4. [x] Add regression assertions that removal calls `/release-key` and row history requests `/history?orderId=<id>` using the existing jsdom purchase page test harness.
5. [x] Run the four-file service/route/realtime/live suite and report its result: 39 passed, 37 failed; the 37 failures remain unverified and are not classified as pre-existing. Do not describe this broad suite as passing.
6. [x] Commit as `feat(purchase): recycle keys during snapshot import`.

## Task 5 — Docs, full verification, and rollout note

**Files:** update `README.md`, `server/README.md`, `server/db/SCHEMA.md`, `docs/04-planning/implementation_plan.md`, `docs/02-srs/SRS_Dashboard_GoogleSheets.md`, `docs/01-brd/BRD_Dashboard_GoogleSheets.md`, and `CURRENT.md`.

**Interfaces:** document migration 0125, reservation/release/history API behavior, snapshot reuse semantics, active-only uniqueness, and the requirement to apply the migration before deploying the app code.

1. [x] Update migration index, database table contracts, API behavior, and latest-update dates in README/server README/SCHEMA. Add the business behavior to BRD/SRS and the local `main` implementation state to `implementation_plan.md`.
2. [x] Keep one `CURRENT.md` line stating implementation is ready for migration rollout; explicitly note migration 0125 must be applied before web deployment. Preserve the separate unfinished shortcuts line.
3. [x] Run `npm test` from `server` and check `graphify update .` availability from repository root. Full suite: 5,109 tests; 5,052 pass, 53 fail, 4 skipped, 0 cancelled/todo; exit 1. The completed tool output was truncated and not retained, so individual full-suite failure names cannot be enumerated from this run. A follow-up focused row-key service+route run passed 92/92 after the expired-reservation cleanup fix. `graphify` command unavailable; no graph files generated.
4. [x] Inspect `git diff --check`, `git status --short`, and `git diff --stat`; stage/commit only the approved docs and rowkey plan/spec. Fresh PGlite migration validation and staging/copy family backfill validation remain pre-rollout gates; do not run a staging/production migration or deploy in this task.
5. [x] Commit the approved docs and rowkey plan/spec as `docs(purchase): document recyclable row keys`. Report test failures accurately; this docs commit does not authorize staging/production migration or deployment.

## Coverage self-check

| Approved requirement | Task |
|---|---|
| Smallest free number, then never-issued sequence | 1, 2 |
| Release only when entire split family is inactive | 3 |
| Full snapshot frees omitted codes before blank-key creates | 4 |
| Restoring after reuse assigns a new code without changing internal identity | 3 |
| History/undo/audit remain isolated across reused display keys | 3 |
| Safe multi-user reservations and cancellation/expiry | 2, 4 |
| Preserve soft-delete and migration history; active-only uniqueness | 1, 3 |
| API, browser, docs, migration rollout order | 2, 4, 5 |

**Risk:** migration backfill depends on `purchase_key_history` mapping the original unsuffixed root code to its immutable root order ID. Validate every legacy split family against production/staging data before applying migration 0125. Production migration and deployment are intentionally not part of this code implementation plan.

**Task 5 verification (13/11/2026):** Full `npm test` used test-only `GOOGLE_SERVICE_ACCOUNT_JSON='{}'` and `JWT_SECRET='test'`; 5,109 tests total, 5,052 pass, 53 fail, 4 skipped; exit code 1. The full output was not persisted by the test runner and the final tool response was truncated, so the 53 names are not available to list here; failures must not be treated as pre-existing without separate verification. `node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js` with the same test-only environment passed 92/92 after the expired-reservation cleanup fix, including migration 0125 backfill/seed, reservation ownership/release and lifecycle cases. `graphify` was unavailable in PATH, and no graph output was generated. Migration 0125 has not been applied to staging or production; staging/copy validation and operator migration-before-deploy remain rollout gates.
