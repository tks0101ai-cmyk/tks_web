# Thu mua full snapshot Excel import Implementation Plan

> **For agentic workers:** Execute inline task-by-task in this session. Use the red-green-refactor cycle for each behavior; no production code before a failing test.

**Goal:** Require downloading the current complete purchase workbook, then let the user edit and upload it as an atomic snapshot with visible creates, updates, and soft deletes.
**Architecture:** Extend the existing purchase workbook helpers with a documented snapshot sheet and a hidden revision manifest. The existing import preview/confirm service validates the manifest against a consistent database revision, plans the full replacement, and soft-deletes omitted rows only after explicit confirmation. The current dialog becomes a download-first drop/select/upload flow with real XHR upload progress.
**Tech Stack:** Node.js 22/CommonJS, Express, PostgreSQL/PGlite, existing SheetJS `xlsx`, Vanilla JS/CSS, `node:test` and jsdom.

## Global Constraints

- Only use `.xlsx`; keep the server limit at 10 MB and the workbook limit at 10,000 data rows.
- A snapshot download contains every active purchase row and every writable catalog field, independent of filters and pagination.
- A missing row key is a new row; a present row key updates that active row; an omitted active row is soft-deleted; a blank writable cell clears its value.
- No create/update/delete writes before a valid preview is explicitly confirmed; any error or stale revision rejects the entire snapshot.
- Reuse existing permissions, transaction, audit, projection and realtime behavior; no physical deletes and no schema migration.
- Do not import or delete real production data during implementation.

## File map

| File | Responsibility |
|---|---|
| `server/public/shared/purchase-workbook.js` | Generate full snapshot workbook and parse its hidden revision manifest plus complete writable headers. |
| `server/purchaseOrders/purchaseOrdersImport.js` | Plan snapshot row creates, updates, unchanged rows and omitted-row deletes; preserve blank-as-clear. |
| `server/purchaseOrders/purchaseOrdersService.js` | Read consistent snapshot/revision, reject stale preview/commit, atomically apply create/update/soft-delete and audit. |
| `server/purchaseOrders/purchaseOrdersRoutes.js` | Add permission-protected snapshot download route; keep preview/revise/confirm contracts safe. |
| `server/public/thu-mua/dat-hang/{index.html,workspace.css,purchase.js}` | Download-first dialog, drop/select, upload progress, processing state, preview counts and stale-file recovery. |
| Existing import/workbook/service/routes/UI/realtime tests | Regression coverage for workbook, transaction, route, progress, permissions and two-session deletion sync. |
| `README.md`, `server/README.md`, SRS, BRD, implementation plan, `CURRENT.md` | Describe the deployed workflow/API and update the one active task line. |

## Task 1 — Generate and parse authoritative workbooks

**Interfaces:** Add `purchaseWorkbook.exportImportSnapshot({ rows, columns, revision }) -> Buffer` and `purchaseWorkbook.parseImportSnapshot(buffer, columns) -> { revision, rows, fields }`. Snapshot sheets are `Đặt hàng`, `Hướng dẫn`, and hidden `__TOKOSI`; `Đặt hàng` uses catalog captions and every writable field; the guide lists each field's required status/type/format and row rules with an example outside the data sheet.

1. In `server/purchaseOrders/purchaseOrdersImport.test.js`, add a failing round-trip test that generates a workbook from a row with an empty optional field, verifies the guide sheet includes each writable caption, and parses revision plus all fields. Run `cd server; node --test purchaseOrders/purchaseOrdersImport.test.js` and confirm failure because the snapshot helpers do not exist.
2. Implement workbook generation/parsing in `server/public/shared/purchase-workbook.js`, deriving captions, types, and read-only/formula exclusions from `purchase-columns.js`. Require `Đặt hàng`, all writable headers exactly once, and a valid manifest revision; do not infer a snapshot from an ordinary export or blank template.
3. Add failing parser tests for missing/duplicate writable headers, absent manifest, bad revision, invalid XLSX, and a guide/example row accidentally appearing on the data sheet. Run the same focused test and confirm each new expectation fails.
4. Implement the smallest parser checks and guide rows, then rerun the focused test and `node --test test/frontend/purchase-workbook.test.js` if present. Confirm the ordinary export/import workbook behavior remains intact.

## Task 2 — Plan a full replacement with race protection

**Interfaces:** Extend `prepareRows(sourceRows, existingRows, { listedAt, snapshot: true })` to include `counts.delete` and delete operations for active keys absent from the snapshot. `prepareWorkbook(buffer, existingRows, { snapshotRevision, currentRevision })` uses the snapshot parser and rejects mismatched revisions as `IMPORT_SNAPSHOT_STALE` before planning.

1. Add failing unit tests in `server/purchaseOrders/purchaseOrdersImport.test.js`: (a) omitted active key becomes a soft-delete plan item; (b) empty supplied values clear existing optional values; (c) a present row creates or updates as before; (d) invalid key/duplicate/missing required value blocks all operations; (e) stale, missing-manifest, or incomplete-column workbook is rejected. Run the focused test and confirm the expected failures.
2. Implement snapshot mode in `purchaseOrdersImport.js` without changing legacy callers except the authorized full-import path. Include source row, row key and before-values for deletions so preview and audit can explain them.
3. Extend `server/purchaseOrders/purchaseOrdersService.test.js` with failing cases for snapshot export revision/data consistency, stale-at-preview, stale-after-preview, and valid commit soft-deleting omitted rows atomically. Assert `deleted_at` is set, the row remains restorable, history/audit records include the deleted row key, and the operation emits the normal changed result.
4. Add a read-only repeatable-read snapshot method that returns all active rows and the exact revision from one database snapshot. Store the snapshot revision in the preview token payload. At preview and again under commit locks, compare the current revision; any intervening mutation returns 409 and writes nothing.
5. In `commitImport`, apply creates, changed writable values (including null clears), and soft deletes in one transaction; keep version checks, projections, audit and idempotent result storage. Run import and service focused tests; then existing service tests.

## Task 3 — Expose download and preserve authorization

**Interfaces:** Add `GET /api/purchase-orders/import/snapshot` with `purchase.import`; return the XLSX snapshot attachment. Existing `POST /import/preview`, `/import/revise`, and `/import/confirm` keep their path and token behavior but consume a snapshot workbook.

1. Add failing `purchaseOrdersRoutes.test.js` cases for denied import permission, authorized download content type/name, full snapshot passed to the workbook builder, and preview/confirm behavior unchanged. Run `cd server; node --test purchaseOrders/purchaseOrdersRoutes.test.js` and confirm failures.
2. Add the route using the service snapshot read and workbook builder. Validate the request only through existing authentication/feature middleware; never accept client-provided rows, revision, or delete lists.
3. Rerun routes tests, including the existing view/import permission matrix, and import tests.

## Task 4 — Build the download-first upload dialog

**Interfaces:** Add a small `downloadImportSnapshot()` UI action and an `uploadImportFile(file, onProgress)` helper in `server/public/thu-mua/dat-hang/purchase.js`. The helper posts multipart `file` to the existing preview route using same-origin XHR and resolves the server preview JSON; upload progress uses actual `ProgressEvent.loaded/total` and processing uses an indeterminate state.

1. Add failing UI tests in `server/public/thu-mua/dat-hang/toolbar-ui.test.js` and `purchaseOrdersLive.test.js`: Import opens the dialog, file picker/drop is disabled until a snapshot downloads, template workbook contains download instructions, progress and processing states are distinct, failed/stale upload leaves data untouched and offers re-download, and a successful preview proceeds through existing confirm.
2. Add accessible dialog markup/styles: required **Tải dữ liệu hiện tại + hướng dẫn**, disabled drop/picker until download completes, `.xlsx` only, 10 MB client hint, file name/size, real progress bar, status/error text, and non-dismissible busy state.
3. Replace the direct native file-picker handler with the dialog flow; use the snapshot download route to save the workbook and unlock upload only after success. Use the XHR helper for preview; then call existing `showImport()` on success. On stale revision, explain that data changed and require a fresh snapshot.
4. Extend preview rendering to show create/update/unchanged/delete counts and explicit soft-delete rows; prevent edits to delete entries. Preserve the current all-or-nothing validation and confirm step.
5. Run both focused UI test files and existing purchase live tests; confirm file errors, server errors and cancel/close rules are accessible in dark/light modes.

## Task 5 — Prove sync and document the workflow

1. Add a failing two-session realtime test in the existing purchase realtime integration test: confirm a snapshot deletion appears as a tombstone to the other session, and an edit after download rejects that stale snapshot without discarding either session's data. Verify the failure occurs on current behavior.
2. Use existing delta/SSE handling if it already transports import soft-deletes; otherwise fix the shared delete event path with a failing regression first. Rerun the realtime integration tests.
3. Update `server/README.md` with the snapshot download API, permissions, limits, revision checks and soft-delete behavior; update README/SRS/BRD/implementation plan to describe download-edit-upload semantics. Replace the Thu mua active line in `CURRENT.md` with this task's real remaining deployment/production-sync check.
4. Self-review the spec against every file/task and inspect the full diff. Run focused purchase tests and the full `cd server; npm test` suite as required by the project instructions; run `graphify update .` when available and report clearly if unavailable.
5. Commit on `main`, push directly (no PR per the user's standing instruction), confirm branch head, then verify deployment status and do not claim production data sync unless two authorized sessions actually demonstrate it.

## Execution status — 12/11/2026

- [x] Snapshot workbook/guide, complete column validation, blank-clear and omitted-row soft-delete planning.
- [x] Consistent read-only export revision; reject stale revision at preview, revise, and confirm; apply writes atomically with existing audit/projection/realtime behavior.
- [x] Download route requires `purchase.import`; download-first popup gates file selection and supports drop/select, 10 MB validation, upload progress, processing state, counts and delete preview.
- [x] Unit/service/UI regression tests for workbook, stale snapshots, soft-delete/tombstone delta, route authorization and download gate.
- [x] README, API README, SRS, BRD, implementation plan and CURRENT updated. No schema change.
- [ ] Full server suite and graphify remain unavailable in this environment: the suite hit OOM in unrelated auth tests; `graphify` is not installed. Focused snapshot/import tests pass.
- [ ] Commit/push on `main`, then verify deploy and test synchronization with two authorized sessions; no production data was imported or deleted here.
