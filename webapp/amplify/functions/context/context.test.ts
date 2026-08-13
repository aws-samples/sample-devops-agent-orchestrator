import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { BusinessContext } from '@devops-observatory/shared-types';
import { handler } from './handler';
import type { ApiEvent, ApiResult } from '../shared/http';

/**
 * Tests for the `GET /context` and `PUT /context` handler (Task 5.2).
 *
 * S3 is mocked at the `S3Client.prototype.send` level so the shared hubData
 * loaders/saver run for real against controllable object contents.
 *
 * Requirements: 5.3 (durable save + success confirmation), 5.4 (save failure
 * preserves prior context), 5.7 (account-existence validation), 2.3/2.5/2.6
 * (Admin gate before any state change).
 *
 * Run with: `node --import tsx --test amplify/functions/context/context.test.ts`
 */

const MANIFEST_KEY = 'raw/_manifest.json';
const CONTEXT_KEY = 'hub/business_context.json';

// --- Controllable mock state -----------------------------------------------
let manifestText: string | undefined;
let contextText: string | undefined;
let putShouldFail: boolean;
let putBodies: string[];

function manifestWith(accountIds: string[]): string {
  return JSON.stringify({
    collectedAt: '2026-07-01T12:00:00Z',
    region: 'us-east-1',
    accounts: accountIds.map((account) => ({ account, spaces: [] })),
  });
}

function body(text: string): { transformToString: (enc: string) => Promise<string> } {
  return { transformToString: async () => text };
}

mock.method(S3Client.prototype, 'send', async function send(command: unknown) {
  if (command instanceof PutObjectCommand) {
    if (putShouldFail) throw new Error('simulated S3 PutObject failure');
    putBodies.push(String(command.input.Body));
    return {};
  }
  if (command instanceof GetObjectCommand) {
    const key = command.input.Key;
    if (key === MANIFEST_KEY) {
      if (manifestText === undefined) throw new Error('NoSuchKey');
      return { Body: body(manifestText) };
    }
    if (key === CONTEXT_KEY) {
      if (contextText === undefined) throw new Error('NoSuchKey');
      return { Body: body(contextText) };
    }
  }
  throw new Error(`unexpected command in test: ${String(command)}`);
});

beforeEach(() => {
  manifestText = manifestWith(['345678901234', '111111111111']);
  contextText = undefined;
  putShouldFail = false;
  putBodies = [];
});

// --- Event + response helpers ----------------------------------------------
function makeEvent(opts: {
  method: string;
  groups?: string[];
  body?: unknown;
  rawBody?: string;
}): ApiEvent {
  const authorizer =
    opts.groups === undefined
      ? undefined
      : { jwt: { claims: { sub: 'user-1', 'cognito:groups': opts.groups } } };
  const bodyStr =
    opts.rawBody !== undefined
      ? opts.rawBody
      : opts.body !== undefined
        ? JSON.stringify(opts.body)
        : undefined;
  return {
    requestContext: { http: { method: opts.method }, authorizer },
    body: bodyStr,
    isBase64Encoded: false,
  } as unknown as ApiEvent;
}

function parse(res: ApiResult): { status: number; json: any } {
  const structured = res as { statusCode: number; body: string };
  return { status: structured.statusCode, json: JSON.parse(structured.body) };
}

const validContext: Partial<BusinessContext> = {
  version: 1,
  businessUnits: [{ name: 'Payments Platform', description: 'Prod', accounts: ['345678901234'] }],
  accountDisplayNames: { '111111111111': 'Core' },
};

// ---------------------------------------------------------------------------
// GET /context
// ---------------------------------------------------------------------------

test('GET returns the persisted context when present', async () => {
  contextText = JSON.stringify({
    version: 1,
    updatedAt: '2026-07-02T00:00:00Z',
    businessUnits: [{ name: 'Payments Platform', accounts: ['345678901234'] }],
    accountDisplayNames: { '345678901234': 'Payments Prod' },
  });
  const { status, json } = parse(await handler(makeEvent({ method: 'GET', groups: ['Executive'] })));
  assert.equal(status, 200);
  assert.equal(json.businessUnits[0].name, 'Payments Platform');
  assert.equal(json.accountDisplayNames['345678901234'], 'Payments Prod');
});

test('GET returns an empty default context when none is stored', async () => {
  contextText = undefined; // not found
  const { status, json } = parse(await handler(makeEvent({ method: 'GET', groups: ['Executive'] })));
  assert.equal(status, 200);
  assert.deepEqual(json, {
    version: 1,
    updatedAt: '',
    businessUnits: [],
    accountDisplayNames: {},
    accountContext: {},
  });
});

// ---------------------------------------------------------------------------
// PUT /context — Admin gate (Req 2.3, 2.5, 2.6)
// ---------------------------------------------------------------------------

test('PUT by an unauthenticated caller is rejected 401 and writes nothing (Req 2.6)', async () => {
  const { status, json } = parse(await handler(makeEvent({ method: 'PUT', body: validContext })));
  assert.equal(status, 401);
  assert.equal(json.code, 'UNAUTHENTICATED');
  assert.equal(putBodies.length, 0);
});

test('PUT by an Executive is rejected 403 and writes nothing (Req 2.3, 2.5)', async () => {
  const { status, json } = parse(
    await handler(makeEvent({ method: 'PUT', groups: ['Executive'], body: validContext })),
  );
  assert.equal(status, 403);
  assert.equal(json.code, 'FORBIDDEN');
  assert.equal(putBodies.length, 0);
});

// ---------------------------------------------------------------------------
// PUT /context — successful save (Req 5.3)
// ---------------------------------------------------------------------------

test('PUT by an Admin validates, persists durably, and confirms success (Req 5.3)', async () => {
  const { status, json } = parse(
    await handler(makeEvent({ method: 'PUT', groups: ['Admin'], body: validContext })),
  );
  assert.equal(status, 200);
  assert.equal(json.saved, true);
  assert.equal(putBodies.length, 1, 'exactly one PutObject was made');
  const persisted = JSON.parse(putBodies[0]!);
  assert.equal(persisted.businessUnits[0].name, 'Payments Platform');
  // updatedAt is stamped at save time.
  assert.ok(typeof persisted.updatedAt === 'string' && persisted.updatedAt.length > 0);
  assert.notEqual(persisted.updatedAt, '');
});

// ---------------------------------------------------------------------------
// PUT /context — validation rejection preserves prior context (Req 5.7, 5.4)
// ---------------------------------------------------------------------------

test('PUT with an account absent from the manifest is rejected 400 and writes nothing (Req 5.7)', async () => {
  const { status, json } = parse(
    await handler(
      makeEvent({
        method: 'PUT',
        groups: ['Admin'],
        body: { businessUnits: [{ name: 'Ghost BU', accounts: ['999999999999'] }] },
      }),
    ),
  );
  assert.equal(status, 400);
  assert.equal(json.code, 'VALIDATION');
  // The offending account is identified in the returned issues (Req 5.7).
  assert.ok(
    Array.isArray(json.details?.issues) &&
      json.details.issues.some((i: { account?: string }) => i.account === '999999999999'),
  );
  // No write occurred, so any previously persisted context is unchanged (Req 5.4).
  assert.equal(putBodies.length, 0);
});

test('PUT with an invalid JSON body is rejected 400 and writes nothing', async () => {
  const { status, json } = parse(
    await handler(makeEvent({ method: 'PUT', groups: ['Admin'], rawBody: '{ not json' })),
  );
  assert.equal(status, 400);
  assert.equal(json.code, 'VALIDATION');
  assert.equal(putBodies.length, 0);
});

// ---------------------------------------------------------------------------
// PUT /context — manifest unavailable (cannot validate account existence)
// ---------------------------------------------------------------------------

test('PUT is rejected when the manifest is unavailable and writes nothing', async () => {
  manifestText = undefined; // manifest cannot be read
  const { status, json } = parse(
    await handler(makeEvent({ method: 'PUT', groups: ['Admin'], body: validContext })),
  );
  assert.equal(status, 502);
  assert.equal(json.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(putBodies.length, 0);
});

// ---------------------------------------------------------------------------
// PUT /context — save failure preserves prior context (Req 5.4)
// ---------------------------------------------------------------------------

test('PUT surfaces a save-failure error when the S3 write fails (Req 5.4)', async () => {
  putShouldFail = true;
  const { status, json } = parse(
    await handler(makeEvent({ method: 'PUT', groups: ['Admin'], body: validContext })),
  );
  assert.equal(status, 502);
  assert.equal(json.code, 'UPSTREAM_UNAVAILABLE');
  assert.match(json.message, /unchanged/i);
});
