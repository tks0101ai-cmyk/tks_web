# Purchase row key recycling — Task 2 report

Implementation commit: `5bdca52031bf324ee6ff93ede56a520844d126b2`
Fix-round commit: `593d3785caf444cb1cbb535ea30a0d984fb07ca0`.

## Fix-round changes

- /plan returns `createdRows: [{clientId,id,rowKey}]`; the UI matches local create requests using `clientId` and later edits using the immutable row ID.
- An owned, matching expired reservation returns `RESERVATION_EXPIRED` with its `clientId`. Autosave reserves a replacement key, preserves the local values, rebuilds the create entry, and retries that batch once. Other token failures do not trigger recovery.
- The ID-race integration regression confirms the pending edit follows returned ID `42` when row ID `99` has the same display code, and the UI never sends the edit to ID `99`.

## Focused Task 2 checks

- Expired reservation ownership/service mapping and created-row identity service tests: 2 passed, 0 failed.
- Expired-draft retry and same-key/different-ID browser integration tests: 2 passed, 0 failed.

## Required three-file command

`node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js purchaseOrders/purchaseOrdersRealtimePage.integration.test.js` — 117 tests, 96 passed, 21 failed. Failures and TAP assertion output:

- page size 10 slices the table and keeps next-page navigation — Expected values to be strictly equal:  1 !== 10
- Ctrl+Z undoes a grid paste but leaves native undo alone in the search field — The expression evaluated to a falsy value:  assert.ok(p.drafts()['1'])
- container ratio is total tons divided by total cubic meters — Expected values to be strictly equal:  '—' !== '0.8%'
- pinned container sits under filters and shows only the five compact columns — Expected values to be strictly equal:  6 !== 5
- integrated refresh updates another cell during numeric expression typing, retaining baseline/caret and navigation mode — Expected values to be strictly equal: + actual - expected  + 'Old' - 'Remote supplier'
- SSE refresh loads newly added employees while retaining draft baseline and tolerating absent or failed directory responses — 'valid'
- pristine focused input retains its original comparison value/version when first edited after remote refresh — The input did not match the regular expression /Remote/. Input:  'Old'
- input burst avoids repeated synchronous cont/task rebuilds while keeping draft and totals current — Expected values to be strictly deep-equal: + actual - expected  [ '1', +   '0.00', +   '0.00' -   '0.13', -   '1.30' ]
- successful save closes before delta refresh finishes and later applies authoritative row delta — The input did not match the regular expression /Đang đồng bộ/. Input:  ''
- automatic invalidation uses changes and only reset falls back to full snapshot — Expected values to be strictly equal:  0 !== 1
- successful outbox retry closes modal without waiting for background delta — The input did not match the regular expression /Đang đồng bộ/. Input:  'Chưa xác định kết quả lưu. Bản nháp còn giữ; bấm Kiểm tra lần lưu. Ambiguous server failure'
- discarded local row is not resurrected by an otherwise empty delta — Expected values to be strictly equal:  0 !== 1
- Đối chiếu overrides are directly editable and sent through the normal versioned row patch — "Cannot read properties of undefined (reading 'changes')"
- measurement inputs show agreed precision and focus/blur alone creates no draft — kgPerCarton initial  '' !== '14.0'
- calculated ratio is shown as a rounded percentage in edit and view modes — editable  '' !== '20.9%'
- percentage overrides edit in displayed percentage points; blank clears a value override — Expected values to be strictly equal:  '' !== '-3.0%'
- staged override changes and clears recalculate dependent comparison fields from fallback — Expected values to be strictly equal:  '' !== '+50.0%'
- a hung employee directory cannot block first rows or subsequent row refresh — Expected values to be strictly equal: + actual - expected  + 'Old' - 'Fresh rows'
- automatic invalidation checks lightweight revision and skips full rows when already current — Expected values to be strictly equal:  1 !== 2
- background refresh preserves row order and selected stable ids while new rows remain in their container group — Expected values to be strictly deep-equal: + actual - expected  [ -   '9', '1' ]
- snapshot download requires import permission and returns a workbook with headers — Expected values to be strictly equal:  500 !== 200

## Required combined command

`node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js purchaseOrders/purchaseOrdersRealtimePage.integration.test.js purchaseOrders/purchaseOrdersLive.test.js` — 187 tests, 148 passed, 39 failed. Failures and TAP assertion output:

- quantity and container drafts recalculate container totals immediately and cancel restores them — Expected values to be strictly equal:  '0.00' !== '2.00'
- remote updates preserve draft and private filter; same field conflict remains visible and unsaved — The expression evaluated to a falsy value:  assert.ok(p.w.document.querySelector('.conflict'))
- resolving same-cell conflict requires explicit choice and another confirmation — The input did not match the regular expression /Đối chiếu/. Input:  'Thu muaXác nhận 1 dòng×Cont chờ xếp · 1 mã tác động · +0.00 T / +0.00 m³Sau lưu: 0.00 T · 0.00 m³Chi tiết thay đổiD00001 · AC305 · Cont chờ xếp → Cont chờ xếp · 10 → 10 thùngNCC: A → BLưu thay đổi Không lưu được. Kiểm tra thông báo và thử lại.'
- paste is validated before any stage and is undoable as one operation — "Cannot read properties of null (reading 'click')"
- reorder creates private rows and quick filters do not issue writes — "Cannot read properties of null (reading 'click')"
- typing digits is one undo unit while focused and revisiting starts a new edit — "Cannot read properties of null (reading 'click')"
- reorder of an assigned row always stages waiting even while its container is pinned — "Cannot read properties of null (reading 'click')"
- large list renders one page and does not build hidden packing tables — Expected values to be strictly equal:  50 !== 1
- live order headers stay below the watched row and release the offset on unpin — Expected values to be strictly equal:  '' !== '120px'
- container freight formula tracks unsaved order volume immediately — Expected values to be strictly equal:  '0' !== '5,941,176'
- pinned freight input uses the same container update endpoint — "Cannot set properties of null (setting 'value')"
- live measurement differences round to percentages until focused and preserve full precision while editing — Expected values to be strictly equal:  '' !== '-2.7%'
- purchase CNY display toggles exact total in the cell and resets on blur — Expected values to be strictly equal:  '' !== '3.10'
- saved filter reload, accent-insensitive search and export use the same selected rows — Expected values to be strictly deep-equal: + actual - expected  + [] - [ -   '1' - ]
- remote changes never silently remove a personal filter even when its last matching value disappears — Expected values to be strictly equal:  1 !== 0
- source metadata remains searchable without exposing a source filter or column — ten nguon duoc tim qua o tim kiem + actual - expected  [ +   'D00001', +   'D00010', +   'D00011', 'D00012' ]
- range scalar paste is one private undo unit and keyed paste uses rowKey even for duplicate product codes — "Cannot read properties of null (reading 'click')"
- Ctrl+D reads current typed draft rather than stale rendered row and remains a private undo step — "Cannot read properties of null (reading 'click')"
- page size 10 slices the table and keeps next-page navigation — Expected values to be strictly equal:  1 !== 10
- Ctrl+Z undoes a grid paste but leaves native undo alone in the search field — The expression evaluated to a falsy value:  assert.ok(p.drafts()['1'])
- container ratio is total tons divided by total cubic meters — Expected values to be strictly equal:  '—' !== '0.8%'
- pinned container sits under filters and shows only the five compact columns — Expected values to be strictly equal:  6 !== 5
- integrated refresh updates another cell during numeric expression typing, retaining baseline/caret and navigation mode — Expected values to be strictly equal: + actual - expected  + 'Old' - 'Remote supplier'
- SSE refresh loads newly added employees while retaining draft baseline and tolerating absent or failed directory responses — 'valid'
- pristine focused input retains its original comparison value/version when first edited after remote refresh — The input did not match the regular expression /Remote/. Input:  'Old'
- input burst avoids repeated synchronous cont/task rebuilds while keeping draft and totals current — Expected values to be strictly deep-equal: + actual - expected  [ '1', +   '0.00', +   '0.00' -   '0.13', -   '1.30' ]
- successful save closes before delta refresh finishes and later applies authoritative row delta — The input did not match the regular expression /Đang đồng bộ/. Input:  ''
- automatic invalidation uses changes and only reset falls back to full snapshot — Expected values to be strictly equal:  0 !== 1
- successful outbox retry closes modal without waiting for background delta — The input did not match the regular expression /Đang đồng bộ/. Input:  'Chưa xác định kết quả lưu. Bản nháp còn giữ; bấm Kiểm tra lần lưu. Ambiguous server failure'
- discarded local row is not resurrected by an otherwise empty delta — Expected values to be strictly equal:  0 !== 1
- Đối chiếu overrides are directly editable and sent through the normal versioned row patch — "Cannot read properties of undefined (reading 'changes')"
- measurement inputs show agreed precision and focus/blur alone creates no draft — kgPerCarton initial  '' !== '14.0'
- calculated ratio is shown as a rounded percentage in edit and view modes — editable  '' !== '20.9%'
- percentage overrides edit in displayed percentage points; blank clears a value override — Expected values to be strictly equal:  '' !== '-3.0%'
- staged override changes and clears recalculate dependent comparison fields from fallback — Expected values to be strictly equal:  '' !== '+50.0%'
- a hung employee directory cannot block first rows or subsequent row refresh — Expected values to be strictly equal: + actual - expected  + 'Old' - 'Fresh rows'
- automatic invalidation checks lightweight revision and skips full rows when already current — Expected values to be strictly equal:  1 !== 2
- background refresh preserves row order and selected stable ids while new rows remain in their container group — Expected values to be strictly deep-equal: + actual - expected  [ -   '9', '1' ]
- snapshot download requires import permission and returns a workbook with headers — Expected values to be strictly equal:  500 !== 200

The combined test run in the earlier Task 2 report recorded 184 tests, 145 passed, and 39 failed. No baseline run established whether any failures predate this work, so this report does not attribute failures to pre-existing state.

No migration or deployment was run.

## Fix round 2 — reclaimed reservation recovery

- Autosave recovers a local create batch on `RESERVATION_EXPIRED` or `ROW_KEY_UNKNOWN` by requesting a fresh reservation for every create in that batch, updating local row state, rebuilding the plan, and retrying once. Other errors still propagate without retry.
- The service regression expires reservation A, calls `reserveKey()` as another actor to reclaim/remove A, then verifies A's old key/token is rejected with `ROW_KEY_UNKNOWN`.
- Browser regressions verify a reclaimed single-row reservation is replaced, and two local creates both receive fresh keys/tokens before retry. Both retain their supplier values.

Focused checks: reclaimed-token service test 1 passed, 0 failed; browser reclaimed-token and two-row batch tests 2 passed, 0 failed.

Required three-file command (`node --test purchaseOrders/purchaseOrdersService.test.js purchaseOrders/purchaseOrdersRoutes.test.js purchaseOrders/purchaseOrdersRealtimePage.integration.test.js`): 120 tests, 99 passed, 21 failed. Failing test names:

- page size 10 slices the table and keeps next-page navigation
- Ctrl+Z undoes a grid paste but leaves native undo alone in the search field
- container ratio is total tons divided by total cubic meters
- pinned container sits under filters and shows only the five compact columns
- integrated refresh updates another cell during numeric expression typing, retaining baseline/caret and navigation mode
- SSE refresh loads newly added employees while retaining draft baseline and tolerating absent or failed directory responses
- pristine focused input retains its original comparison value/version when first edited after remote refresh
- input burst avoids repeated synchronous cont/task rebuilds while keeping draft and totals current
- successful save closes before delta refresh finishes and later applies authoritative row delta
- automatic invalidation uses changes and only reset falls back to full snapshot
- successful outbox retry closes modal without waiting for background delta
- discarded local row is not resurrected by an otherwise empty delta
- Đối chiếu overrides are directly editable and sent through the normal versioned row patch
- measurement inputs show agreed precision and focus/blur alone creates no draft
- calculated ratio is shown as a rounded percentage in edit and view modes
- percentage overrides edit in displayed percentage points; blank clears a value override
- staged override changes and clears recalculate dependent comparison fields from fallback
- a hung employee directory cannot block first rows or subsequent row refresh
- automatic invalidation checks lightweight revision and skips full rows when already current
- background refresh preserves row order and selected stable ids while new rows remain in their container group
- snapshot download requires import permission and returns a workbook with headers

Required combined command (adds `purchaseOrders/purchaseOrdersLive.test.js`): 190 tests, 151 passed, 39 failed. All 21 failures above remained; the additional 18 failures were:

- quantity and container drafts recalculate container totals immediately and cancel restores them
- remote updates preserve draft and private filter; same field conflict remains visible and unsaved
- resolving same-cell conflict requires explicit choice and another confirmation
- paste is validated before any stage and is undoable as one operation
- reorder creates private rows and quick filters do not issue writes
- typing digits is one undo unit while focused and revisiting starts a new edit
- reorder of an assigned row always stages waiting even while its container is pinned
- large list renders one page and does not build hidden packing tables
- live order headers stay below the watched row and release the offset on unpin
- container freight formula tracks unsaved order volume immediately
- pinned freight input uses the same container update endpoint
- live measurement differences round to percentages until focused and preserve full precision while editing
- purchase CNY display toggles exact total in the cell and resets on blur
- saved filter reload, accent-insensitive search and export use the same selected rows
- remote changes never silently remove a personal filter even when its last matching value disappears
- source metadata remains searchable without exposing a source filter or column
- range scalar paste is one private undo unit and keyed paste uses rowKey even for duplicate product codes
- Ctrl+D reads current typed draft rather than stale rendered row and remains a private undo step

No baseline attribution is made for these failures. No production migration or deployment was run.