# Task 3 report — purchase row-key lifecycle

Implemented the Task 3 create/split/delete/restore/undo/history behavior in the purchase service and route.

- Root inserts receive `root_order_id` from migration 0123's before-insert default; split descendants inherit that ID.
- Split and delete retirement append immutable `purchase_key_history` assignments. A root key enters the pool only after no active row in its `root_order_id` family remains; insertion is idempotent.
- Restore and undo preserve internal order IDs. If another active family or unexpired reservation owns the old root code, all stored rows in the old family are remapped to a newly allocated root code, with suffixes and `split_from_key` preserved. Partial restore activates only requested rows.
- History now resolves family events using `orderId` and `purchase_operation_rows.root_order_id`; the route rejects missing, malformed, zero, negative, and old `rowKey`-only selectors.
- The service and route test harnesses cover root release, split-family release only after the last branch, duplicate visible-code assignment history, family history isolation, restore and undo collision remapping, partial restore, undo-create release, permission checks, and route ID validation.

## Verification

Command (from `server`, using test-only `GOOGLE_SERVICE_ACCOUNT_JSON='{}'` and `JWT_SECRET='test'`):

```text
node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js
```

Result: **86 tests passed, 0 failed, 0 skipped** (includes 3 nested migration assertions). The two initial new service regressions failed before implementation because reservation returned `D00002` instead of recycled `D00001`; both pass after implementation. A full run initially exposed a route-test mock omission (`service.importSnapshot is not a function`); the mock now includes `importSnapshot`, and the full suite passes.

## Handoff / scope

The existing browser history caller in `server/public/thu-mua/dat-hang/purchase.js` still sends `rowKey`; Task 4 must switch it to `orderId` before this route change is deployed. That file was already dirty and was intentionally left untouched. No production migration or deploy was run.

## Review follow-up fix

A follow-up review found three lifecycle gaps, now fixed:

- History by an `orderId` continues to work after undo-create physically removes the row by resolving `root_order_id` from immutable `purchase_operation_rows` snapshots. Reused display codes remain isolated by family ID.
- Releasing an inactive family key now checks for another active family or an unexpired reservation using that code. Undoing a restore cannot put another family's live key back into the pool.
- Legacy history entries without `operationId` are included only when candidate keys from current orders and immutable key assignments resolve to exactly one distinct `root_order_id`. Once another family has used that visible key, the legacy event is omitted for both families rather than attributed by display code alone.

Failure-first results before the fix: all 3 new regressions failed (missing undo-create history, active D00001 incorrectly entered the pool after undo-restore, and unambiguous legacy history was omitted). After the fix, the focused regressions pass **3/3**.

Final command result: **89 passed, 0 failed, 0 skipped** for `node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js` (includes 3 nested migration assertions). No production migration or deployment was run.
