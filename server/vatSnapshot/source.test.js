'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSnapshotReader, recordsFor } = require('./source');

test('shared DB reader coalesces reads, preserves snapshot age, and refuses expired stock', async () => {
  let time = Date.parse('2026-11-25T08:00:00Z'), calls = 0;
  const loaded = time;
  const pool = { async query() { calls++; return { rows: [{ records: { 'file:7': [['0', '-2']] }, loaded_at: new Date(loaded) }] }; } };
  const reader = createSnapshotReader({ pool, now: () => time });
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => reader.get()));
  assert.equal(calls, 1);
  assert.deepEqual(recordsFor(snapshots[0], { spreadsheetId: 'file', sheetId: 7 }), [['0', '-2']]);
  time += 6 * 60 * 1000;
  assert.equal((await reader.get()).stale, true);
  assert.equal((await reader.get()).loadedAt, loaded);
  time += 6 * 60 * 60 * 1000;
  await assert.rejects(reader.get(), { code: 'VAT_SNAPSHOT_UNAVAILABLE' });
});

test('missing initial snapshot never falls back to Google or invents zeros', async () => {
  const reader = createSnapshotReader({ pool: { query: async () => ({ rows: [] }) } });
  await assert.rejects(reader.get(), { statusCode: 503 });
});
