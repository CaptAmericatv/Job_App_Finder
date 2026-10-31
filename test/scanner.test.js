import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeResult } from '../src/scanner.js';

test('keeps first-seen dates for jobs still listed', () => {
  const prev = { status: 'jobs', jobs: [{ title: 'Line Cook', firstSeen: '2026-01-01T00:00:00Z' }] };
  const next = { status: 'jobs', jobs: [{ title: 'Line Cook' }, { title: 'Cashier' }] };
  const out = mergeResult(prev, next, '2026-02-01T00:00:00Z');
  assert.deepEqual(out.jobs.map((j) => j.firstSeen), ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z']);
});

test('a site that fails to load keeps its last results', () => {
  const prev = { status: 'jobs', jobs: [{ title: 'Line Cook', firstSeen: 'x' }] };
  const out = mergeResult(prev, { status: 'error', jobs: [], note: 'timeout' }, 'now');
  assert.equal(out.status, 'jobs');
  assert.equal(out.jobs.length, 1);
  assert.equal(out.stale, true);
});

test('jobs that are gone are dropped', () => {
  const prev = { status: 'jobs', jobs: [{ title: 'Line Cook', firstSeen: 'x' }] };
  const out = mergeResult(prev, { status: 'none', jobs: [] }, 'now');
  assert.equal(out.jobs.length, 0);
});
