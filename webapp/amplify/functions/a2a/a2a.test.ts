import assert from 'node:assert/strict';
import { test } from 'node:test';

import { handler } from './handler';
import type { ApiEvent, ApiResult } from '../shared/http';

/**
 * A2A route security-gate tests (Task 36). These assert the two guards that run
 * BEFORE any AWS call — so no S3/Secrets Manager/fetch mocking is needed:
 *   - a non-Admin (or unauthenticated) caller is rejected and reaches no space;
 *   - an Admin with a malformed space id is rejected with a 400.
 * The token/chat logic itself is covered by `../shared/a2a.test.ts`.
 */

const SPACE = 'a1b2c3d4-5678-4abc-9def-0123456789ab';

function event(opts: {
  admin?: boolean;
  authed?: boolean;
  method?: string;
  spaceId?: string;
  path?: string;
  body?: string;
}): ApiEvent {
  const claims: Record<string, unknown> = opts.authed === false ? {} : { sub: 'user-1' };
  if (opts.admin) claims['cognito:groups'] = ['Admin'];
  const spaceId = opts.spaceId ?? SPACE;
  const method = opts.method ?? 'GET';
  return {
    rawPath: opts.path ?? `/spaces/${spaceId}/a2a-status`,
    pathParameters: { spaceId },
    body: opts.body,
    requestContext: {
      http: { method, path: opts.path ?? `/spaces/${spaceId}/a2a-status` },
      authorizer: opts.authed === false ? undefined : { jwt: { claims } },
    },
  } as unknown as ApiEvent;
}

function parse(res: ApiResult): { status: number; code?: string } {
  const structured = res as { statusCode: number; body: string };
  const json = structured.body ? JSON.parse(structured.body) : {};
  return { status: structured.statusCode, code: json.code };
}

test('an unauthenticated caller is rejected (401) and reaches no space', async () => {
  const res = parse(await handler(event({ authed: false })));
  assert.equal(res.status, 401);
  assert.equal(res.code, 'UNAUTHENTICATED');
});

test('token-management routes are Admin-only — an Executive is forbidden (403)', async () => {
  for (const [method, path] of [
    ['GET', `/spaces/${SPACE}/a2a-status`],
    ['PUT', `/spaces/${SPACE}/a2a-token`],
    ['DELETE', `/spaces/${SPACE}/a2a-token`],
  ] as const) {
    const res = parse(await handler(event({ admin: false, method, path })));
    assert.equal(res.status, 403, `${method} ${path} should be forbidden for non-Admin`);
    assert.equal(res.code, 'FORBIDDEN');
  }
});

test('an unauthenticated caller is rejected on the configured-spaces list and chat', async () => {
  const list = parse(
    await handler(event({ authed: false, method: 'GET', path: '/a2a/spaces', spaceId: undefined })),
  );
  assert.equal(list.status, 401);
  const chat = parse(
    await handler(event({ authed: false, method: 'POST', path: `/spaces/${SPACE}/a2a/chat` })),
  );
  assert.equal(chat.status, 401);
});

test('an Admin with a malformed space id is rejected (400) before any AWS call', async () => {
  const res = parse(
    await handler(event({ admin: true, spaceId: 'not-a-space', path: '/spaces/not-a-space/a2a-status' })),
  );
  assert.equal(res.status, 400);
  assert.equal(res.code, 'VALIDATION');
});
