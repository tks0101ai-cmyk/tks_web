# SDD ledger — plan: docs/superpowers/plans/2026-11-13-purchase-rowkey-recycling.md

- Base commit: `6d49ed4fc4df2e1c740040fecde089482a3c36dc` on `main`.
- The working tree already contains unrelated purchase grid shortcut changes. Preserve them; stage and commit only files/hunks for this plan.
- The user explicitly authorized direct work on `main` and delegated code to GPT-6 Luna. Do not create branches/worktrees; do not deploy or run production migration.
- Existing unresolved shortcut review issue remains separate; do not touch that work.

## Plan task status

- Task 1: complete (commits `fbb1f4c`..`2126fc9`, review clean except one deferred minor).
- Task 2: implementation complete (commits `5bdca52`, `593d378`, `9bda2ee`), scoped review passed; broader suite has 39 failures with baseline unverified.
- Task 3: complete (commits `5c6625e`, `ebba3bd`, `a897939`, `fa092b9`); final scoped review passed after four fix rounds, service+route suite 92/92 green.
- Task 4: complete (commits `6995749`, `cbe5cda`); seven focused regressions pass, independent review passed. Required 4-file suite 169/206 pass, 37 failures with baseline unverified.
- Task 5: complete (commits `0b9b1c8`, `6d1fd63`, plus final verification note update); documentation/spec/plan committed. Full `npm test` 5,052/5,109 pass, 53 fail, 4 skipped, exit 1; focused row-key suite 92/92; Graphify unavailable. No migration/deploy.

## Review log

- Task 1 fix round 1: corrected 0123 family/snapshot backfills and pool seeding; pre-0123 PGlite migration regression passes (78/78 targeted tests).
- Task 1: minor (deferred): migration fixture does not cover non-null `after_row` JSON backfill; unchanged SQL path mirrors tested `before_row` path and will be triaged by final review.
- Task 2 fix round 1 review: fixed expired owned-reservation recovery and create reconciliation by immutable ID; review then found the reclaimed-token and multi-draft expiry gap.
- Task 2 fix round 2: both `RESERVATION_EXPIRED` and `ROW_KEY_UNKNOWN` reacquire keys for the whole create batch and retry once. Focused regressions pass 3/3; required 3-file suite 99/120 pass and combined suite 151/190 pass (39 failures, baseline not established). Independent scoped review passed. Replaced but still-live reservations remain until expiry; Task 4 release lifecycle covers cancellation/discard.
- Task 3: initial 86/86 service+route tests passed, but independent review found three edge cases; fixes preserve removed-row history by ID, guard pool release against active owners/reservations and ambiguous legacy history, and recycle the displaced replacement key after undoing a collision-remapped restore. Final suite 89/89 passed; independent final review passed.
- Task 3 final audit: expired reservation cleanup could re-pool a key after a family restored it. Cleanup now deletes expired reservations but returns a key to pool only if no active root owns it. Failure-first regression plus create/split safety pass; service+route suite 92/92; independent review passed.
- Task 4 review round 1 found import deletion didn't retire key history, discard raced autosave, and the older delta-resurrection regression had been replaced. Fix records retirements before pool release; discard stops timers, refuses in-flight writes and preserves drafts on release failure; original delta test is restored. Focused 7/7 passed, required suite 169/206 passed (37 failures, baseline unverified), independent re-review passed.
- Task 5: docs specify schema/API/business rules and migration-before-deploy; plan checkboxes updated while retaining the deferred `after_row` fixture gap. Full suite output was truncated/not persisted; no failure is attributed to baseline. Migration 0123 remains unapplied; staging/copy validation and deployment are outstanding operator work.
