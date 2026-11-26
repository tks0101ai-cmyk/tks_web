# Shared VAT snapshot and product report columns

Approved approach: existing Render worker reads VAT Sheets every five minutes; web consumers read PostgreSQL only. User approved 2026-11-25.

## Intent
Sales need total VAT stock (Gop VAT I) and stock available for a new order (O, already subtracting drafts). Never subtract drafts again. Insert Ton VAT thuc and Ton VAT co ban after Co ban SG, with company breakdown, sorting, column controls and exports.

## Approaches
Separate caches duplicate requests. A shared in-process cache does not coordinate processes or survive restarts. Chosen: one durable PostgreSQL snapshot refreshed by the existing worker, with persisted scheduling and an expiring claim that prevents simultaneous readers.

## Design
- Snapshot preserves raw formatted cells for Gop VAT A:P, Khop ma A:K and MUA VAT SIDA A:E. Existing parsing/allocation rules remain unchanged. Include configured ORDER VAT source overrides, deduplicated by spreadsheet and tab.
- Worker reads sequentially, shares metadata per workbook and spaces calls. Validate required columns, formula errors and unexpected row loss before publishing the complete bundle atomically. On failure retain the previous bundle, persist bounded exponential backoff, and log safe error codes only.
- Web uses a short shared in-process database cache (not a Google cache). Preserve actual loadedAt and mark stale beyond five minutes. Expire use after six hours; never show missing or invalid data as zero. Manual refresh requests enqueue work, coalesce and respect persisted cooldown/backoff.
- All default VAT sources use the same raw bundle; injected readers remain available for tests. No web fallback to Google.
- Product report maps products with existing stockSource matching rules. I and O use the same mapped VAT codes and sum companies once. Null remains unknown; zero and negative stock remain numbers. Company detail is included only on report rows, numeric fields are exported. VAT timestamp/warnings remain visible independently of the main report timestamp.

## Constraints and rollout
CommonJS, Node 22, vanilla JS and shared table controls. No new service or dependency. Migration is additive and must precede worker/web rollout; before migration, report VAT is unavailable and other default VAT reads return a controlled unavailable error. Do not modify live data, Render configuration or deploy automatically in this development step. Preserve unrelated dirty prototype files.

Updated: 2026-11-25.


## Main integration — 2026-11-26

Integrated against origin/main 245a2ce7. Preserved intermediary workbook, original-workbook fallback (performed by worker), fallbackTabs metadata, API timeout/retry settings and invoice/order VAT stock routes. Migration 0146 is additive and has not run on any live DB. Safety stash codex-vat-stock-20261126-before-main retains all original changes. Integrated suite passed 531/531, graph-dependent regressions passed 64/64 (overlapping service tests). See the implementation plan for release steps and verification details.

Updated: 2026-11-26.
