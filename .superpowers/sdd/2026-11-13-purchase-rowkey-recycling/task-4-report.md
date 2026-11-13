# Task 4 — Snapshot import and browser reservation lifecycle

## Changes

- `commitImport` records each omitted row's retired key before soft-delete, releases each fully inactive root family once, then allocates keys for blank-key creates from the pool in the same transaction. Preview validation, revision checks, idempotent replay, and transaction rollback remain intact.
- Discard rejects while a write or autosave is in flight. When idle, it clears the scheduled autosave before awaiting reservation release, and clears local drafts only after release succeeds.
- Row history now requests `/history?orderId=<immutable id>`.
- Added PGlite regressions for omission/key reuse ordering, projection-failure rollback, stale revision preserving both rows and pool, and operation-less history isolation after reuse/restore. Added jsdom assertions for release, autosave cancellation, in-flight write rejection, retained delta-resurrection coverage, and ID-based history lookup.

## Verification

Test-only environment values used: `GOOGLE_SERVICE_ACCOUNT_JSON={}` and `JWT_SECRET=test-only-secret`.

- Focused Task 4 regressions: 7 passed, 0 failed.
- Required command: `node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js purchaseOrders/purchaseOrdersRealtimePage.integration.test.js purchaseOrders/purchaseOrdersLive.test.js`
- Required command totals: 206 tests, 169 passed, 37 failed, 0 cancelled, 0 skipped; duration 121.3 seconds.
- All Task 4 regressions passed in the full run. The other 37 failures are listed below; no clean-baseline run was done, so they are reported without attributing them as pre-existing.
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
21. container ratio is total tons divided by total cubic meters
22. pinned container sits under filters and shows only the five compact columns
23. integrated refresh updates another cell during numeric expression typing, retaining baseline/caret and navigation mode
24. SSE refresh loads newly added employees while retaining draft baseline and tolerating absent or failed directory responses
25. pristine focused input retains its original comparison value/version when first edited after remote refresh
26. input burst avoids repeated synchronous cont/task rebuilds while keeping draft and totals current
27. successful save closes before delta refresh finishes and later applies authoritative row delta
28. automatic invalidation uses changes and only reset falls back to full snapshot
29. successful outbox retry closes modal without waiting for background delta
30. Đối chiếu overrides are directly editable and sent through the normal versioned row patch
31. measurement inputs show agreed precision and focus/blur alone creates no draft
32. calculated ratio is shown as a rounded percentage in edit and view modes
33. percentage overrides edit in displayed percentage points; blank clears a value override
34. staged override changes and clears recalculate dependent comparison fields from fallback
35. a hung employee directory cannot block first rows or subsequent row refresh
36. automatic invalidation checks lightweight revision and skips full rows when already current
37. background refresh preserves row order and selected stable ids while new rows remain in their container group
