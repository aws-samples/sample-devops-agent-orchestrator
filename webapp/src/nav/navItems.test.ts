import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_VIEW,
  NAV_ITEMS,
  resolveVisibleView,
  visibleNavItems,
} from './navItems';

/**
 * Tests for the persistent-navigation registry (Task 11).
 *
 * Run with: `node --import tsx --test src/nav/navItems.test.ts`
 *
 * Requirements: 11.1 (Summary is the default landing view), 11.3 (a shared,
 * ordered set of links to each view), 2.1 (Admin-only entries hidden from
 * Executives).
 */

test('the default landing view is the Summary view (Req 11.1)', () => {
  assert.equal(DEFAULT_VIEW, 'summary');
});

test('the Summary view is present and listed first', () => {
  assert.equal(NAV_ITEMS[0]?.id, 'summary');
});

test('every nav item has a unique id and a non-empty label (Req 11.3)', () => {
  const ids = new Set<string>();
  for (const item of NAV_ITEMS) {
    assert.ok(item.label.trim().length > 0, `label missing for ${item.id}`);
    assert.ok(!ids.has(item.id), `duplicate id ${item.id}`);
    ids.add(item.id);
  }
});

test('the four core views are always available to every role (Req 11.3)', () => {
  for (const role of ['Executive', 'Admin'] as const) {
    const ids = visibleNavItems(role).map((item) => item.id);
    for (const core of ['summary', 'spaces', 'dashboard', 'graph', 'chat'] as const) {
      assert.ok(ids.includes(core), `${core} should be visible to ${role}`);
    }
  }
});

test('Executives do not see Admin-only entries; Admins see everything (Req 2.1)', () => {
  const execIds = visibleNavItems('Executive').map((item) => item.id);
  assert.ok(!execIds.includes('context'));
  assert.ok(!execIds.includes('refresh'));

  const adminIds = visibleNavItems('Admin').map((item) => item.id);
  assert.equal(adminIds.length, NAV_ITEMS.length);
  assert.ok(adminIds.includes('context'));
  assert.ok(adminIds.includes('refresh'));
});

test('visibleNavItems preserves the declared order', () => {
  const adminIds = visibleNavItems('Admin').map((item) => item.id);
  assert.deepEqual(
    adminIds,
    NAV_ITEMS.map((item) => item.id),
  );
});

test('resolveVisibleView falls back to the default for disallowed/unknown views', () => {
  // Executive cannot land on an Admin-only view.
  assert.equal(resolveVisibleView('Executive', 'context'), DEFAULT_VIEW);
  assert.equal(resolveVisibleView('Executive', 'refresh'), DEFAULT_VIEW);
  // Permitted views pass through unchanged.
  assert.equal(resolveVisibleView('Executive', 'dashboard'), 'dashboard');
  assert.equal(resolveVisibleView('Admin', 'context'), 'context');
});
