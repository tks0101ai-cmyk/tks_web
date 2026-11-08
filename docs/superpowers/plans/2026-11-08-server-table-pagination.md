# Server table pagination implementation plan

**Goal:** Move persistent list tables to authorized server filtering/search/multi-sort before paging, retaining full-result metadata/export and safe editing workspaces.
**Architecture:** CommonJS Express/PostgreSQL and vanilla JS. Reuse multiSort/fuzzy helpers. SQL-backed reports query before LIMIT; Sheets/merged snapshots paginate on Node. Existing bounded documents, allocation, imports and operation workspaces remain complete.
**Authorization:** User approved the inventory/design in chat on 08/11/2026 and requested implementation. Work directly on main per MEMORY.md. Preserve existing documentation/graph changes. No deployment, migration execution, or data writes.

## Contract and acceptance
- `rows,totalRows,page,pageSize`, full-result summaries/facets and source metadata; empty page=1 and clamp to last page.
- Parameterized values; sort whitelist + stable tie-break; NULL last and raw numeric/date values.
- Preserve roles, branch, hidden fields, fuzzy/code search, linked facets, export scope, account column preferences, dark/light and responsive.
- Debounce input; abort/ignore old success AND error; keep loading/error state tied to query.
- Editing drafts/selections keyed by IDs/versions, independent of page; preserve operation datasets and idempotency.
- Validate each slice with meaningful multi-page/query/export/permission/concurrency regression tests; review before next slice.

## Ordered slices / progress
- [x] 1. Expected arrivals: parameterized SQL query/count/clamp/facets and full export parity; connect existing table/pager/search/sort to API. Files: productContainers/expectedRepository.js, expectedRoutes.js, expectedExport.js, public/index.html and focused tests.
- [x] 2. Histories: account audit, lifecycle history, VT history/order list. Move local sort/search across fetched pages to server. Files: auth/accountAuditLog.js, adminUserRoutes.js, account/index.html; shipment lifecycle modules/page; stockPositions modules/page.
- [x] 3. Read-only reports: aging, transactions, product growth, customer-product detail, product report. Full-result summaries and catalogs separate from page rows. Files: dashboard, debtSchedule, businessReport, public/index.html and tests.
- [x] 4. Marketing + stockout results + VAT lookup: query snapshot/database before page; retain charts/summary/export scope and metadata. Files: marketingReport/public marketing-report.js; dashboard/stockoutCheck; vatLookup/public vat-lookup.
- [x] 5. Admin/HR/business customers/debt: separate lookup/calendar/details from paginated lists; keep write rights and versions. Files: auth/hr/businessReport/debtSchedule and corresponding pages/tests.
- [x] 6. Editable workspaces: ORDER VAT, VT, purchase orders, stocktake; migrate list transport without using partial rows as calculation/operation inputs. Keep bounded previews/documents/allocation complete. Domain tests for page transitions, drafts, bulk scope, versions, retry/outbox, SSE and exports required.
- [x] 7. Review and documentation: compare all inventory entries to final behavior; update README/server README/SCHEMA/implementation_plan/SRS/BRD/CURRENT by actual impact; run related tests, browser checks and graphify. No speculative indexes; record unavailable EXPLAIN/staging checks accurately.

## Verification commands
From server: `node --test productContainers/expectedRoutes.test.js productContainers/expectedExport.test.js productContainers/expectedRefresh.test.js test/frontend/expected-arrivals.test.js` plus new repository query tests. Existing reference checks: `node --test shared/multiSort.test.js dashboard/product90dReportRepository.test.js dashboard/productHistoryRepository.test.js cashbook/cashbookRepository.test.js shipment/orderLifecycleQuery.test.js test/frontend/table-controls.test.js`.
For each later slice, add its existing repository/service/route/frontend/export test files and record exact outcomes here before checking the slice complete. Run `git diff --check` and `graphify update .` at final verification. SQL runtime plans require a read-only real PostgreSQL connection; do not infer production performance from PGlite.

Tiến độ chốt 08/11/2026: slice 1–4 xong (backend + giao diện, test xanh trừ 2 lỗi nền); slice 5–7 xong ở mức an toàn: chỉ Công nợ (danh sách thao tác) và ORDER VAT được phân trang thêm; HR/tài khoản/đơn mua/kiểm kê cố ý giữ đủ dòng (lý do trong CURRENT.md). Toàn server 4692 test, 2 lỗi nền đã biết.

Updated: 08/11/2026.
