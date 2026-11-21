# VAT stock and ORDER VAT separate release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release VAT stock and ORDER VAT handoff in invoice / lifecycle detail, independently from the future invoice-request workflow.

**Architecture:** Apply selected existing code to a fresh branch based on origin/main, preserving main's shared VAT sources, background refresh and ORDER VAT behavior. No invoiceRequests module, draft deductions, new migrations or sandbox code enters this branch. Reuse a shared browser module for both detail panels.

**Tech Stack:** Node 22/24, CommonJS Express, vanilla JS/CSS/HTML, node:test and jsdom.

## Global Constraints

- Approved spec: `docs/superpowers/specs/2026-11-21-vat-stock-order-release-design.md`.
- Workspace: `C:/Users/chumi/.codex/worktrees/vat-stock-order-release/invoice-processing-workflow-c671f3`, branch `codex/vat-stock-order-release`, base `origin/main` (refresh before final delivery).
- Reference checkout READ ONLY: `D:/tks_web/.claude/worktrees/invoice-processing-workflow-c671f3`, branch `claude/vat-stock-document-detail`. Never change its code, staging, server or running sandbox.
- No migrations, new dependencies, environment files, production DB writes, Sheets writes, invoiceRequests runtime code, sandbox code, push, merge or deploy during implementation.
- Preserve these seven files exactly as main: README.md, server/README.md, CURRENT.md, docs/02-srs/SRS_Dashboard_GoogleSheets.md, docs/01-brd/BRD_Dashboard_GoogleSheets.md, docs/04-planning/implementation_plan.md, server/db/SCHEMA.md. Collect documentation changes in this release's design doc.
- JS comments in Vietnamese without accents; UI messages in Vietnamese with accents. Preserve light/dark, mobile and existing table controls.
- Bump changed browser assets with `?v=20261121-1` in every page loading them.
- Tests from server with dummy `GOOGLE_SERVICE_ACCOUNT_JSON={}`, `JWT_SECRET=vat-release-test-only` and no real DB credentials. node_modules junction is already prepared, do not commit it.

## File map

Task 1: modify `server/vatLookup/lookupModel.js`, `vatLookupRoutes.js` and their tests. Model maps exact product codes to VAT availability; route exposes a read-only endpoint using main's existing source.

Task 2: create `server/public/shared/vat-stock.js`, `vat-stock.css`, `vat-handoff.js`, `server/test/frontend/vat-stock.test.js`; modify `server/public/vat-request/vat-request.js`, `vat-request-batch.js`, `index.html`, corresponding `vat-request.test.js` and `vat-request-batch.test.js`. Shared module calculates shortages; handoff transports selected rows to existing batch form.

Task 3: modify `server/public/index.html`, `server/public/shipment/lifecycle/index.html`, tests `document-detail-panel.test.js`, `order-lifecycle-kiot.test.js`, `invoice-price-audit.test.js` as needed. Wire the shared UI into both existing panels without changing report section order. Complete scope audit and release documentation in the design doc.

### Task 1: Independent VAT stock API

**Interfaces:** Consumes main lookup model `products`, `tonCoTheNhapByMaVat`, `normalizeCode`. Produces exported `stockForCodes(model, codes)` returning `{ [requestedCode]: { vatCode, stock } }` and authenticated `POST /api/vat-lookup/stock` body `{codes}` returning `{meta,items}`.

- [ ] Step 1: Run baseline `node --test "vatLookup/*.test.js"`; record failures separately before modifying code.
- [ ] Step 2: Use `git show b3a2a3c6 -- server/vatLookup/lookupModel.js server/vatLookup/vatLookupRoutes.js server/vatLookup/lookupModel.test.js server/vatLookup/vatLookupRoutes.test.js` to inspect the self-contained original addition. Port tests first onto main's existing tests; do not replace whole files.
- [ ] Step 3: Assert exact normalized match, missing code returns nulls, first valid VAT code selected and stock summed across companies. Test route auth / feature denial, deduplication, blank / oversized codes, empty request, stale metadata, source failure and shared source reuse. Run focused tests to verify absence of endpoint fails.
- [ ] Step 4: Port the original stockForCodes and request validation. Wire directly to `await source.get()`; keep `/search`, `/refresh`, source injection and cache behavior from main. Do not import `applyDraftDeductions` or draftStock.

```js
router.post('/stock', ...guard, handle(async (req, res) => {
  const codes = parseStockCodes(req.body);
  const snapshot = await source.get();
  res.json({ meta: meta(snapshot), items: stockForCodes(snapshot, codes) });
}));
```

- [ ] Step 5: Run `node --test "vatLookup/*.test.js"`, inspect diff for accidental source/cache rewrites, commit only task files with message `feat(vat): expose independent stock lookup for document detail`.

### Task 2: Shared VAT UI and ORDER VAT handoff

**Interfaces:** Consumes Task 1 endpoint. Produces browser `TKSVatStock` (`permissions`, `showsColumns`, `showsBar`, `headHtml`, `cellsHtml`, `barHtml`, `loadStock`, `attach`, pure `computeVatShortages`) and `TKSVatHandoff` (`writeOrderVat`, `takeOrderVat`, `orderVatTsv`); batch form `prefill(rows,source)`.

- [ ] Step 1: Read the reference checkout's current shared modules and VAT stock / ORDER VAT handoff tests. Copy only these three shared files as starting points, then remove invoice request URL helpers, permissions, actions, wording and exports. Retain current shortage precision, red-specific CSS class, async stale-result guards and tick clearing fixes.
- [ ] Step 2: Adapt behavioral tests in reference `vat-stock.test.js` before enabling UI. No test may expect an invoice-request button or require that module. Use tests for repeated VAT codes, fractional quantities, skipped VAT fee / nonpositive / blank-code rows, missing mapping, source error, stale data, cancelled documents, async panel replacement and permissions. Include:

```js
const result = api.computeVatShortages(
  [{productCode:'A',quantity:30},{productCode:'B',quantity:20}],
  {A:{vatCode:'VAT1',stock:35},B:{vatCode:'VAT1',stock:35}}
);
assert.deepEqual(result.lines.map(x => x.shortage), [0,15]);
assert.equal(result.enough, false);
```

- [ ] Step 3: Shared `permissions` returns only stock/order; order requires both `accounting.vatLookup` and `accounting.vatRequest`. `showsBar` must support stock status/error notices; no invoice action remains. Keep 200-code batches and one-use handoff expiring after 10 minutes. `onOrder` opens `/vat-request/?handoff=1`; form submission remains a separate explicit action.
- [ ] Step 4: Port only `prefill` from reference batch form and `consumeHandoff` plus its initialization call from reference VAT request JS. Preserve main's source loading message, `scheduleStockRetry`, pagination, filters and unrelated changes. Load vat-handoff before VAT request code and bump versions.
- [ ] Step 5: Port / adapt handoff tests: append to saved draft, fill correct shortage/customer/price, preserve Full VAT selection step, limits/skipped rows, consume once, expiry, localStorage failure, cancelled docs and no automatic POST create. Run `node --test test/frontend/vat-stock.test.js test/frontend/vat-request.test.js test/frontend/vat-request-batch.test.js test/frontend/vat-request-server-pagination.test.js` then commit task files with message `feat(vat): add stock shortage UI and Order VAT handoff`.

### Task 3: Connect both detail panels and verify release boundary

**Interfaces:** Consumes Task 2 shared API and existing detail data `{productCode,quantity,...}` / document metadata. Produces stock and order columns in existing invoice and lifecycle panels, with controller cleanup on close / replacement.

- [ ] Step 1: Inspect reference commits `d4b811e8`, `5c7c047f`, `fc2a4749`, `913305b2`, `2e78170b`. Use only VAT integration / relevant corrections. Preserve main's section order, server pagination, click behavior and latest lifecycle features. Do not include prototypes or navigation to invoice-request.
- [ ] Step 2: Port focused detail tests first onto main: invoice panel stock request once per document; correct branch/customer/quantity/unitPrice; batch over 200 codes; invisible without permission; cancelled document can't order; late response after close/change ignored; server-paginated invoice row still opens correct detail. Lifecycle tests cover repeated rerender/destroy, correct stock table slots, order button and cancelled status.
- [ ] Step 3: Add CSS / JS includes in both pages and adapt panel rendering using main's existing methods. Call `TKSVatStock.attach({root,lines,doc,perms,stock,isCurrent})` with stock Promise scoped to the active document. Remove all invoice-request-specific callbacks/permissions and any explanatory text for that future workflow. Bump each changed page's browser assets.
- [ ] Step 4: Run focused detail tests and invoice-price-audit tests. Then `node --test --test-concurrency=4 "vatLookup/*.test.js" "vatRequests/*.test.js" "test/frontend/*.test.js"`. Diagnose any failures against baseline; do not overwrite main's tests with older complete files.
- [ ] Step 5: Run `graphify update .`, inspect neighbors for touched modules, run newly indicated tests if necessary. `git diff --check` must pass. Check `git diff --name-only origin/main` has no migrations, invoiceRequests, sandbox files or seven protected docs. Search new production diff for `invoiceRequest`, `draftStock`, `applyDraftDeductions`, `/invoice-request` and confirm none introduces the future workflow.
- [ ] Step 6: Update design doc with actual file list, test results and remaining manual verification. Commit task code and docs separately as appropriate. A fresh broad review must assess scope isolation and behavior before delivery. No production writes, push, merge or deploy are part of this task; deliver a concrete reviewable branch ready for the next publishing action.

## Self-review of plan

Coverage: API source independence (Task 1), shortage / permissions / one-use editable handoff (Task 2), both panels / existing main behavior / runtime isolation (Task 3). No new migrations or environment requirements. Exact implementation is ported from named existing code, not newly invented logic. Shared signatures above are the task boundaries; no unresolved product choices remain.

Cập nhật gần nhất: 21/11/2026.
