(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PurchaseDraftHistory = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Snapshots and keys must be JSON data. The caller owns the committed stack,
  // its size limit, persistence and restoration; this module never writes data.
  function create({ snapshot, remember, state = null }) {
    let active = state == null ? null : clone(state);

    // Call before mutating the draft, on focus or the first input. Repeated
    // calls for the same key keep the original full-draft baseline.
    function begin(key) {
      if (active && same(active.key, key)) return;
      flush();
      active = { key: clone(key), before: clone(snapshot()) };
    }

    // Call before taking an explicit structural snapshot, and at edit commit.
    function flush(label = 'Sửa ô') {
      if (!active) return false;
      const pending = active;
      active = null;
      if (same(pending.before, snapshot())) return false;
      remember(pending.before, label);
      return true;
    }

    // Returns a detached snapshot, or undefined if neither active nor committed
    // history has a change. pop returns an existing { before, label } entry.
    // Clear active BEFORE the caller restores/renders, including the no-op case.
    function undo(pop) {
      const pending = active;
      active = null;
      if (pending && !same(pending.before, snapshot())) return clone(pending.before);
      const entry = pop();
      return entry == null ? undefined : clone(entry.before);
    }

    // Persist alongside draftUndo after each draft mutation. Hydrate with state
    // only after restoring the matching draft and undo stack from that session.
    function exportState() { return active == null ? null : clone(active); }
    function reset() { active = null; }
    return { begin, flush, undo, exportState, reset };
  }
  return { create };
});
