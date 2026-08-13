import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveVisibleView, visibleNavItems } from './navItems';

/**
 * Task 16 gating tests: the Admin-only Context_Manager and Refresh control are
 * hidden AND blocked for Executive users; only Admins can reach them
 * (Requirement 2.3). This complements the backend authorization on
 * `PUT /context`, `POST /refresh`, and `GET /refresh/status`.
 *
 * Run with: `node --import tsx --test src/nav/adminGating.test.ts`
 */

const ADMIN_VIEWS = ['context', 'refresh'] as const;

test('Executives do not see the Context_Manager or Refresh nav entries (Req 2.3)', () => {
  const execIds = visibleNavItems('Executive').map((i) => i.id);
  for (const view of ADMIN_VIEWS) {
    assert.ok(!execIds.includes(view), `${view} must be hidden from Executives`);
  }
});

test('Admins see the Context_Manager and Refresh nav entries (Req 2.4)', () => {
  const adminIds = visibleNavItems('Admin').map((i) => i.id);
  for (const view of ADMIN_VIEWS) {
    assert.ok(adminIds.includes(view), `${view} must be visible to Admins`);
  }
});

test('direct access to an Admin view by an Executive is blocked and falls back (Req 2.3)', () => {
  for (const view of ADMIN_VIEWS) {
    // An Executive attempting to land on an Admin-only view is redirected away.
    assert.notEqual(resolveVisibleView('Executive', view), view);
  }
});

test('an Admin resolves through to the requested Admin view (Req 2.4)', () => {
  for (const view of ADMIN_VIEWS) {
    assert.equal(resolveVisibleView('Admin', view), view);
  }
});
