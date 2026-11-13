# Task 4 — Snapshot import and browser reservation lifecycle

## Changes

- `commitImport` now soft-deletes all omitted rows, releases each fully inactive root family once, then allocates keys for blank-key creates from the pool in the same transaction. Preview validation, revision checks, idempotent replay, and transaction rollback remain intact.
- Discarding local new-row drafts releases their reservation before clearing local state. Current UI does not put new-row creation itself on the undo stack, so discard is the only present user action that removes a new row.
- Row history now requests `/history?orderId=<immutable id>`.
- Added PGlite regression for omission/key reuse ordering, projection-failure rollback, and stale revision preserving both rows and pool; added jsdom assertions for discard release and ID-based history lookup.

## Verification

Test-only environment values used: `GOOGLE_SERVICE_ACCOUNT_JSON={}` and `JWT_SECRET=test-only-secret`.

- Focused Task 4 regressions: 3 passed, 0 failed.
- Required command: `node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js purchaseOrders/purchaseOrdersRealtimePage.integration.test.js purchaseOrders/purchaseOrdersLive.test.js`
- Required command totals: 202 tests, 164 passed, 38 failed, 0 cancelled, 0 skipped; duration 120.5 seconds.
- The Task 4 regressions passed in the full run. The 38 failures were in live/page UI tests; no clean-baseline run was done, so they are reported without attributing them as pre-existing.
- `git diff --check` passed.

Failed test names from the required run:

1. quantity and container drafts recalculate container totals immediately and cancel restores them
2. remote updates preserve draft and private filter; same field conflict remains visible and unsaved
3. resolving same-cell conflict requires explicit choice and another confirmation
4. paste is validated before any stage and is undoable as one operation
5. reorder creates private rows and quick filters do not issue writes
6. typing digits is one undo unit while focused and revisiting starts a new edit
7. reorder of an assigned row always stages waiting even while its container is pinned
8. large list renders one page and does not build hidden packing tables
9. live order headers stay below the watched row and release the offset on unpin
10. container freight formula tracks unsaved order volume immediately
11. pinned freight input uses the same container update endpoint
12. live measurement differences round to percentages until focused and preserve full precision while editing
13. purchase CNY display toggles exact total in the cell and resets on blur
14. saved filter reload, accent-insensitive search and export use the same selected rows
15. remote changes never silently remove a personal filter even when its last matching value disappears
16. source metadata remains searchable without exposing a source filter or column
17. range scalar paste is one private undo unit and keyed paste uses rowKey even for duplicate product codes
18. Ctrl+D reads current typed draft rather than stale rendered row and remains a private undo step
19. page size 10 slices the table and keeps next-page navigation
20. Ctrl+Z undoes a grid paste but leaves native undo alone in the search field
21. Ctrl+Z undoes an edited input before it loses focus
22. container ratio is total tons divided by total cubic meters
23. pinned container sits under filters and shows only the five compact columns
24. integrated refresh updates another cell during numeric expression typing, retaining baseline/caret and navigation mode
25. SSE refresh loads newly added employees while retaining draft baseline and tolerating absent or failed directory responses
26. pristine focused input retains its original comparison value/version when first edited after remote refresh
27. input burst avoids repeated synchronous cont/task rebuilds while keeping draft and totals current
28. successful save closes before delta refresh finishes and later applies authoritative row delta
29. automatic invalidation uses changes and only reset falls back to full snapshot
30. successful outbox retry closes modal without waiting for background delta
31. Đối chiếu overrides are directly editable and sent through the normal versioned row patch
32. measurement inputs show agreed precision and focus/blur alone creates no draft
33. calculated ratio is shown as a rounded percentage in edit and view modes
34. percentage overrides edit in displayed percentage points; blank clears a value override
35. staged override changes and clears recalculate dependent comparison fields from fallback
36. a hung employee directory cannot block first rows or subsequent row refresh
37. automatic invalidation checks lightweight revision and skips full rows when already current
38. background refresh preserves row order and selected stable ids while new rows remain in their container group
