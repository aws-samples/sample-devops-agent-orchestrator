import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAdmin, getCaller, isAdmin } from './authz';
import { AuthenticationRequiredError, InsufficientPermissionsError } from './errors';
import type { ApiEvent } from './http';

/**
 * Unit tests for the authorization helpers (`shared/authz.ts`, Task 3).
 *
 * The Cognito JWT authorizer validates the access token before any handler
 * runs, so these tests exercise the trusted-claims path: deriving the caller
 * identity from `requestContext.authorizer.jwt.claims`, normalizing the
 * `cognito:groups` claim across the shapes API Gateway may deliver, and the
 * Admin gate used by every mutating route (`PUT /context`, `POST /refresh`,
 * `GET /refresh/status`).
 *
 * Requirements: 2.1 (exactly-one-role assignment surfaced via group membership),
 * 2.3/2.5 (an authenticated Executive is denied Admin-only actions with an
 * authorization error and no state change), 2.6 (an unauthenticated caller is
 * denied). Because {@link assertAdmin} throws before a handler mutates any
 * state, the "no state changed on denial" invariant holds structurally.
 *
 * Run with: `node --import tsx --test amplify/functions/shared/authz.test.ts`
 */

// ---------------------------------------------------------------------------
// Event helper
// ---------------------------------------------------------------------------

type Claims = Record<string, string | number | boolean | string[]>;

/** Build an HTTP API event. `claims: null` models a missing authorizer context. */
function makeEvent(claims: Claims | null): ApiEvent {
  const authorizer = claims === null ? undefined : { jwt: { claims } };
  return {
    requestContext: { http: { method: 'GET' }, authorizer },
  } as unknown as ApiEvent;
}

// ---------------------------------------------------------------------------
// getCaller — identity extraction (Req 2.6)
// ---------------------------------------------------------------------------

test('getCaller extracts the user id, username, and groups from valid claims', () => {
  const caller = getCaller(
    makeEvent({ sub: 'user-123', 'cognito:username': 'jdoe', 'cognito:groups': ['Admin'] }),
  );
  assert.equal(caller.userId, 'user-123');
  assert.equal(caller.username, 'jdoe');
  assert.deepEqual(caller.groups, ['Admin']);
});

test('getCaller falls back to the email claim for the username', () => {
  const caller = getCaller(makeEvent({ sub: 'u1', email: 'exec@example.com' }));
  assert.equal(caller.username, 'exec@example.com');
});

test('getCaller returns an empty group list when the claim is absent (Executive-by-default)', () => {
  const caller = getCaller(makeEvent({ sub: 'u1' }));
  assert.deepEqual(caller.groups, []);
  assert.equal(caller.username, undefined);
});

test('getCaller throws AuthenticationRequiredError when the authorizer context is missing (Req 2.6)', () => {
  assert.throws(() => getCaller(makeEvent(null)), AuthenticationRequiredError);
});

test('getCaller throws when the jwt has no claims (Req 2.6)', () => {
  const event = { requestContext: { http: { method: 'GET' }, authorizer: { jwt: {} } } } as unknown as ApiEvent;
  assert.throws(() => getCaller(event), AuthenticationRequiredError);
});

test('getCaller throws when the sub claim is missing or empty (Req 2.6)', () => {
  assert.throws(() => getCaller(makeEvent({ 'cognito:groups': ['Admin'] })), AuthenticationRequiredError);
  assert.throws(() => getCaller(makeEvent({ sub: '' })), AuthenticationRequiredError);
});

// ---------------------------------------------------------------------------
// cognito:groups normalization — every shape API Gateway may deliver
// ---------------------------------------------------------------------------

test('parses a real string array of groups', () => {
  assert.deepEqual(getCaller(makeEvent({ sub: 'u1', 'cognito:groups': ['Admin', 'Executive'] })).groups, [
    'Admin',
    'Executive',
  ]);
});

test('parses a bracketed string like "[Admin]"', () => {
  assert.deepEqual(getCaller(makeEvent({ sub: 'u1', 'cognito:groups': '[Admin]' })).groups, ['Admin']);
});

test('parses a bracketed, space/comma-separated string like "[Admin, Executive]"', () => {
  assert.deepEqual(
    getCaller(makeEvent({ sub: 'u1', 'cognito:groups': '[Admin, Executive]' })).groups,
    ['Admin', 'Executive'],
  );
});

test('parses a single bare group value', () => {
  assert.deepEqual(getCaller(makeEvent({ sub: 'u1', 'cognito:groups': 'Executive' })).groups, [
    'Executive',
  ]);
});

test('treats an empty groups string as no groups', () => {
  assert.deepEqual(getCaller(makeEvent({ sub: 'u1', 'cognito:groups': '' })).groups, []);
  assert.deepEqual(getCaller(makeEvent({ sub: 'u1', 'cognito:groups': '[]' })).groups, []);
});

// ---------------------------------------------------------------------------
// isAdmin (Req 2.1)
// ---------------------------------------------------------------------------

test('isAdmin is true only when the Admin group is present (Req 2.1)', () => {
  assert.equal(isAdmin(getCaller(makeEvent({ sub: 'u1', 'cognito:groups': ['Admin'] }))), true);
  assert.equal(isAdmin(getCaller(makeEvent({ sub: 'u1', 'cognito:groups': ['Executive'] }))), false);
  assert.equal(isAdmin(getCaller(makeEvent({ sub: 'u1' }))), false);
});

test('isAdmin is true when a caller belongs to both groups', () => {
  assert.equal(
    isAdmin(getCaller(makeEvent({ sub: 'u1', 'cognito:groups': ['Executive', 'Admin'] }))),
    true,
  );
});

// ---------------------------------------------------------------------------
// assertAdmin — the Admin gate (Req 2.3, 2.5, 2.6)
// ---------------------------------------------------------------------------

test('assertAdmin returns the caller identity for an authenticated Admin (Req 2.4)', () => {
  const caller = assertAdmin(makeEvent({ sub: 'admin-1', 'cognito:groups': ['Admin'] }));
  assert.equal(caller.userId, 'admin-1');
  assert.ok(isAdmin(caller));
});

test('assertAdmin denies an authenticated Executive with a FORBIDDEN error (Req 2.3, 2.5)', () => {
  assert.throws(
    () => assertAdmin(makeEvent({ sub: 'exec-1', 'cognito:groups': ['Executive'] })),
    (err: unknown) => {
      assert.ok(err instanceof InsufficientPermissionsError);
      assert.equal(err.code, 'FORBIDDEN');
      // The message makes clear the action is not permitted for the Executive role.
      assert.match(err.message, /Admin|Executive/);
      return true;
    },
  );
});

test('assertAdmin denies a caller with no groups (Req 2.3, 2.5)', () => {
  assert.throws(() => assertAdmin(makeEvent({ sub: 'u1' })), InsufficientPermissionsError);
});

test('assertAdmin denies an unauthenticated caller with an auth-required error (Req 2.6)', () => {
  assert.throws(() => assertAdmin(makeEvent(null)), AuthenticationRequiredError);
});

test('assertAdmin checks authentication before role: no identity → 401, not 403 (Req 2.6)', () => {
  // A missing authorizer must surface as "authentication required" (401), never
  // as "insufficient permissions" (403).
  assert.throws(() => assertAdmin(makeEvent(null)), (err: unknown) => {
    assert.ok(err instanceof AuthenticationRequiredError);
    assert.equal((err as AuthenticationRequiredError).code, 'UNAUTHENTICATED');
    return true;
  });
});

// ---------------------------------------------------------------------------
// Property-style invariant (deterministic, no extra deps) — Property 2
// ---------------------------------------------------------------------------

test('invariant: assertAdmin succeeds iff the verified caller is in the Admin group', () => {
  // Simple seeded PRNG (mulberry32) for deterministic, reproducible runs.
  let seed = 0x51ed270b;
  const rand = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const candidates: Array<'Admin' | 'Executive'> = ['Admin', 'Executive'];

  for (let iter = 0; iter < 200; iter++) {
    const groups = candidates.filter(() => rand() < 0.5);
    const event = makeEvent({ sub: `u-${iter}`, 'cognito:groups': groups });
    const shouldPass = groups.includes('Admin');

    if (shouldPass) {
      const caller = assertAdmin(event);
      assert.equal(caller.userId, `u-${iter}`);
    } else {
      assert.throws(() => assertAdmin(event), InsufficientPermissionsError);
    }
    // isAdmin must always agree with group membership.
    assert.equal(isAdmin(getCaller(event)), shouldPass);
  }
});
