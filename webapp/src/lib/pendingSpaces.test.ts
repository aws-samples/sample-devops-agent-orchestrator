import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getPendingSpaceAccounts,
  markSpacesPending,
  reconcilePendingSpaces,
  withAdded,
  withResolved,
} from './pendingSpaces';

/**
 * Tests for the "pending refresh" space markers. Under node:test there is no
 * `localStorage`, so the module uses its in-memory fallback — which also
 * exercises the read/write/reconcile round trip end-to-end.
 */

// --- pure helpers --------------------------------------------------------------

test('withAdded unions and de-duplicates, preserving order', () => {
  assert.deepEqual(withAdded(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
});

test('withResolved drops ids whose account now has spaces', () => {
  assert.deepEqual(withResolved(['a', 'b', 'c'], ['b']), ['a', 'c']);
});

// --- storage round trip (in-memory fallback) -----------------------------------

test('mark then get returns the pending accounts; reconcile clears resolved ones', () => {
  // Clean slate for this process.
  reconcilePendingSpaces([...getPendingSpaceAccounts()]);
  assert.equal(getPendingSpaceAccounts().size, 0);

  markSpacesPending(['111111111111', '222222222222']);
  markSpacesPending(['222222222222', '333333333333']); // dedupes 222…

  const pending = getPendingSpaceAccounts();
  assert.deepEqual([...pending].sort(), ['111111111111', '222222222222', '333333333333']);

  // 222… now actually has spaces → reconciled away.
  const remaining = reconcilePendingSpaces(['222222222222']);
  assert.deepEqual([...remaining].sort(), ['111111111111', '333333333333']);
  assert.equal(getPendingSpaceAccounts().has('222222222222'), false);
});
