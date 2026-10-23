# Customer filters and local price levels Implementation Plan

> **For agentic workers:** Use executing-plans to implement this plan task-by-task in this session.

**Goal:** Add customer profile filters/export and editable local price levels without changing captured invoices.

**Architecture:** A dedicated local level repository owns initialization, versioned writes and history. Customer report routes overlay fresh local levels and batch profile data onto cached revenue reports. Invoice capture reads local levels in its existing repeatable-read transaction.

**Tech Stack:** CommonJS, PostgreSQL/PGlite, Express, ExcelJS, vanilla JS, node:test/JSDOM.

## Global Constraints

- Work on main per MEMORY.md; no production migration or deployment in this implementation.
- Shared nameKey across HN/SG; medium/large/vip levels; new customers default large.
- Capture records remain immutable; no email fallback after cutover.
- Existing customer manager/assigned-editor permissions; server enforcement; version conflict returns 409.
- Preserve dark/light and mobile layouts; no framework or dependency additions.

### Task 1: Local levels and source backup

Files: create `server/db/migrations/0087_customer_price_levels.sql`, `server/businessReport/customerPriceLevelRepository.js` and `.test.js`.

- [x] Write PGlite tests for source backups, name grouping, deterministic initialization, idempotence, version conflicts/history and new customer default.
- [x] Run `node --test businessReport/customerPriceLevelRepository.test.js` and observe missing behavior.
- [x] Implement `initialize(snapshot)`, `getLevels(keys)`, `saveLevel(key, level, version, actor)`; SQL checks constrain levels and stores per-source email backups. Initialization selects current `buildCustomerReport(snapshot)` levels before switching; only inserts missing rows.
- [x] Re-run tests; inspect migration on an empty database and with pre-existing levels.

### Task 2: Report profiles, filters, exports and API

Files: `customerProfileRepository.js`, `businessReportRoutes.js`, `businessReportExport.js`, associated tests.

- [x] Write failing tests for AND filters, exported profile fields without Note, permission denial and version conflict.
- [x] Implement batch `getReportProfiles(keys)` and local-level overlay; GET customer report returns level versions/editability. PUT `/customer-price-level` validates key and checks existing effective edit permission.
- [x] Use shared query values `salesChannel` and `warehouseScale` for UI/export; include Vietnamese labels, image links, editors and visit dates only with profile view permission.
- [x] Run relevant repository/route/export tests and review SQL parameters and text escaping.

### Task 3: Immutable invoice capture integration

Files: `invoicePriceAudit/priceAuditRepository.js`, `.test.js`, `priceAuditFixtures.js`.

- [x] Write failing regression: capture invoice under large; change local level to vip and email to another value; old invoice remains identical, new invoice uses vip.
- [x] Read local levels by normalized customer name using the capture client; require completed initialization. Never parse email to decide live levels.
- [x] Run price audit repository/refresh tests; verify no updates to existing captured rows.

### Task 4: Main table controls

Files: `server/public/index.html`, `server/test/frontend/customer-profile.test.js` and focused frontend tests.

- [x] Test filters, inline dropdown, denied edit, failed save rollback and export query in JSDOM.
- [x] Add filter dropdowns; render editable level selector with version; keep row on save error; refresh filter options on success.
- [x] Verify JS syntax and frontend tests; inspect desktop/mobile with available browser tools.

### Task 5: Documentation and verification

- [x] Update README, server README, SCHEMA, CURRENT, BRD, SRS and implementation_plan with actual behavior and pending migration.
- [x] Run full `npm test -- --test-concurrency=4`, inspect failures, fix regressions and run `git diff --check`.
- [x] Run graphify if available; review final diff against each design requirement; report any environment limitation and deployment prerequisites.

## Verification record — 23/10/2026

- Full suite (Node 24.19.0, test-only configuration, no live DB/SMTP): 3,379 passed, 3 skipped, 0 failed; 3,382 tests. Log: `.codex_tmp/customer-local-level-full-tests-final.log`.
- Chrome with mock data: 1440px desktop and 390px mobile, combined filters, versioned save, 409 rollback, no modal on selector interaction, no horizontal document overflow or page errors. Results: `.codex_tmp/customer-level-browser-results.json`.
- Review resolved the export search mismatch; local level, customer refs and numeric series now match table search, while export-only fields do not affect row selection.
- Stale unrelated fixtures for CONT column/permission and table preferences were aligned with existing runtime behavior; no runtime policy changes were made for those fixes.
- Source/document diff checks passed. Graphify extraction ran, but report rebuild failed on Windows with Errno 22 for GRAPH_REPORT.md; graph completion is not claimed.
- Migration 0087, source archival/cutover command and deployment remain pending for the real database. No operational customer levels or captured invoices were modified by this work.
