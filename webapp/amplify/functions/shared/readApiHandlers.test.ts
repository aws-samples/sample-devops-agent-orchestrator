import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { handler as summaryHandler } from '../summary/handler';
import { handler as spacesHandler } from '../spaces/handler';
import { handler as dashboardHandler } from '../dashboard/handler';
import type { ApiEvent, ApiResult } from './http';

/**
 * Integration tests for the S3 read-API handlers (`GET /summary`, `GET /spaces`,
 * `GET /dashboard`) against a mocked S3 (Task 4 handlers, Task 18 coverage).
 *
 * S3 is mocked at `S3Client.prototype.send`, so the real `hubData` loaders +
 * `aggregation` core run end-to-end against controllable manifest / business-
 * context objects — exercising the handler wiring the pure unit tests
 * (`summary.test.ts`, `dashboard.test.ts`) do not.
 *
 * Requirements:
 *   - 12.1  scope completeness: `/spaces` represents every manifest account
 *           (count == manifest accounts), including zero-data accounts (12.4).
 *   - 4.4   manifest missing `collectedAt` / invalid date-time → Last_Sync_Date
 *           "unknown" while the account listing is preserved.
 *   - 3.7   `/spaces` returns an "account data unavailable" error and NO partial
 *           listing when the manifest cannot be retrieved or parsed.
 *   - 6.6   snapshot isolation: counts come only from the most recently loaded
 *           manifest, with nothing carried over from a prior snapshot.
 *   - 6.4/5 business-context grouping + display-name overlay end-to-end.
 *
 * Run with: `node --import tsx --test amplify/functions/shared/readApiHandlers.test.ts`
 */

const MANIFEST_KEY = 'raw/_manifest.json';
const CONTEXT_KEY = 'hub/business_context.json';

// --- Controllable mock state -----------------------------------------------
/** Raw manifest text; `undefined` = object cannot be read; used verbatim (may be invalid JSON). */
let manifestText: string | undefined;
let contextText: string | undefined;

function body(text: string): { transformToString: (enc?: string) => Promise<string> } {
  return { transformToString: async () => text };
}

mock.method(S3Client.prototype, 'send', async function send(command: unknown) {
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

// --- Fixture builders -------------------------------------------------------
interface SpaceSpec {
  agentSpaceId: string;
  name?: string;
  investigations?: number;
  recommendations?: number;
  associations?: number;
  assets?: number;
}

function manifestJson(
  accounts: Array<{ account: string; name?: string; error?: string; spaces?: SpaceSpec[] }>,
  collectedAt: string | null = '2026-07-01T12:00:00Z',
): string {
  const raw: Record<string, unknown> = {
    region: 'us-east-1',
    accounts: accounts.map((a) => ({
      account: a.account,
      name: a.name,
      error: a.error ?? null,
      spaces: (a.spaces ?? []).map((s) => ({
        agentSpaceId: s.agentSpaceId,
        name: s.name,
        counts: {
          associations: s.associations ?? 0,
          assets: s.assets ?? 0,
          investigations: s.investigations ?? 0,
          recommendations: s.recommendations ?? 0,
        },
      })),
    })),
  };
  if (collectedAt !== null) raw.collectedAt = collectedAt;
  return JSON.stringify(raw);
}

beforeEach(() => {
  manifestText = manifestJson([
    { account: '111111111111', spaces: [{ agentSpaceId: 's1', name: 'Ops', investigations: 2, recommendations: 3 }] },
    { account: '222222222222', spaces: [{ agentSpaceId: 's2', investigations: 10, recommendations: 0 }] },
  ]);
  contextText = undefined;
});

// --- Helpers ---------------------------------------------------------------
function makeEvent(): ApiEvent {
  return {
    requestContext: { http: { method: 'GET' }, authorizer: { jwt: { claims: { sub: 'u1' } } } },
  } as unknown as ApiEvent;
}

function parse(res: ApiResult): { status: number; json: any } {
  const structured = res as { statusCode: number; body: string };
  return { status: structured.statusCode, json: JSON.parse(structured.body) };
}

/** Fully-zeroed aggregate totals (activity + capability rollups). */
function zeroTotals() {
  return {
    incidents: 0,
    investigations: 0,
    agentSpaces: 0,
    telemetry: 0,
    pipelines: 0,
    communications: 0,
    mcpServers: 0,
    remoteAgents: 0,
    webhooks: 0,
    logDeliveries: 0,
    users: 0,
 investigationHours: 0,
 evaluationHours: 0,
 systemLearningHours: 0,
 onDemandHours: 0,
  };
}

// ---------------------------------------------------------------------------
// Scope completeness — every manifest account is represented (Req 12.1, 12.4)
// ---------------------------------------------------------------------------

test('/spaces represents every manifest account, count == manifest accounts (Req 12.1)', async () => {
  manifestText = manifestJson([
    { account: '111111111111', spaces: [{ agentSpaceId: 's1', name: 'Ops' }] },
    { account: '222222222222', spaces: [{ agentSpaceId: 's2', name: 'Sec' }] },
    { account: '333333333333', spaces: [{ agentSpaceId: 's3' }] },
  ]);
  const { status, json } = parse(await spacesHandler(makeEvent()));
  assert.equal(status, 200);
  assert.equal(json.accounts.length, 3);
  assert.deepEqual(
    json.accounts.map((a: { account: string }) => a.account).sort(),
    ['111111111111', '222222222222', '333333333333'],
  );
});

test('/spaces includes a zero-data account with a no-spaces indication (Req 12.4, 3.6)', async () => {
  manifestText = manifestJson([
    { account: '111111111111', spaces: [{ agentSpaceId: 's1', name: 'Ops' }] },
    { account: '999999999999', spaces: [] }, // in scope, no collected spaces
  ]);
  const { json } = parse(await spacesHandler(makeEvent()));
  assert.equal(json.accounts.length, 2);
  const zero = json.accounts.find((a: { account: string }) => a.account === '999999999999');
  assert.equal(zero.hasNoSpaces, true);
  assert.deepEqual(zero.spaces, []);
});

test('a newly added manifest account appears with no code change (Req 12.3)', async () => {
  const before = parse(await spacesHandler(makeEvent()));
  assert.equal(before.json.accounts.length, 2);

  manifestText = manifestJson([
    { account: '111111111111', spaces: [{ agentSpaceId: 's1', name: 'Ops' }] },
    { account: '222222222222', spaces: [{ agentSpaceId: 's2' }] },
    { account: '444444444444', spaces: [{ agentSpaceId: 's4', name: 'New' }] },
  ]);
  const after = parse(await spacesHandler(makeEvent()));
  assert.equal(after.json.accounts.length, 3);
  assert.ok(after.json.accounts.some((a: { account: string }) => a.account === '444444444444'));
});

test('/spaces reports collected vs incomplete status from the manifest error field (Req 3.3)', async () => {
  manifestText = manifestJson([
    { account: '111111111111', spaces: [{ agentSpaceId: 's1' }] },
    { account: '222222222222', error: 'AccessDenied collecting spaces', spaces: [] },
  ]);
  const { json } = parse(await spacesHandler(makeEvent()));
  const ok = json.accounts.find((a: { account: string }) => a.account === '111111111111');
  const bad = json.accounts.find((a: { account: string }) => a.account === '222222222222');
  assert.equal(ok.status, 'collected');
  assert.equal(bad.status, 'incomplete');
});

// ---------------------------------------------------------------------------
// Freshness handling: missing / invalid collectedAt (Req 4.4)
// ---------------------------------------------------------------------------

test('/spaces preserves the account listing but reports freshness unknown when collectedAt is missing (Req 4.4)', async () => {
  manifestText = manifestJson(
    [{ account: '111111111111', spaces: [{ agentSpaceId: 's1', name: 'Ops' }] }],
    null, // no collectedAt key at all
  );
  const { status, json } = parse(await spacesHandler(makeEvent()));
  assert.equal(status, 200);
  // Listing is preserved (accounts still represented)…
  assert.equal(json.accounts.length, 1);
  // …but freshness is explicitly "unknown", never a blank/placeholder value.
  assert.equal(json.lastSyncDate, 'unknown');
  assert.equal(json.accounts[0].lastSyncDate, 'unknown');
});

test('/dashboard reports freshness unknown for an invalid collectedAt while still aggregating (Req 4.4)', async () => {
  manifestText = manifestJson(
    [{ account: '111111111111', spaces: [{ agentSpaceId: 's1', investigations: 4, recommendations: 5 }] }],
    'not-a-real-timestamp',
  );
  const { status, json } = parse(await dashboardHandler(makeEvent()));
  assert.equal(status, 200);
  assert.equal(json.lastSyncDate, 'unknown');
  // Aggregation still runs over the (valid) accounts: 4 investigations == 4
  // incidents (recommendations are a separate metric, not folded in).
  assert.equal(json.totals.incidents, 4);
});

test('/summary surfaces a valid collectedAt verbatim as Last_Sync_Date (Req 4.1, 11.1)', async () => {
  const { json } = parse(await summaryHandler(makeEvent()));
  assert.equal(json.lastSyncDate, '2026-07-01T12:00:00Z');
});

// ---------------------------------------------------------------------------
// Manifest unavailable / unparseable (Req 3.7, 4.3)
// ---------------------------------------------------------------------------

test('/spaces returns an "unavailable" error and NO partial listing when the manifest is missing (Req 3.7)', async () => {
  manifestText = undefined; // object cannot be read
  const { status, json } = parse(await spacesHandler(makeEvent()));
  assert.equal(status, 502);
  assert.equal(json.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(json.accounts, undefined, 'no partial account listing is returned');
});

test('/spaces returns an "unavailable" error when the manifest is unparseable JSON (Req 3.7)', async () => {
  manifestText = '{ this is : not json';
  const { status, json } = parse(await spacesHandler(makeEvent()));
  assert.equal(status, 502);
  assert.equal(json.code, 'UPSTREAM_UNAVAILABLE');
});

test('/summary and /dashboard return freshness-unknown (not an error) when the manifest is unavailable (Req 4.3, 6.8)', async () => {
  manifestText = undefined;
  const summary = parse(await summaryHandler(makeEvent()));
  assert.equal(summary.status, 200);
  assert.equal(summary.json.lastSyncDate, 'unknown');
  assert.deepEqual(summary.json.totals, zeroTotals());

  const dashboard = parse(await dashboardHandler(makeEvent()));
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.json.lastSyncDate, 'unknown');
  assert.deepEqual(dashboard.json.breakdown, []); // empty breakdown == UI no-data signal
});

// ---------------------------------------------------------------------------
// Snapshot isolation — no carryover between loads (Req 6.6)
// ---------------------------------------------------------------------------

test('/dashboard counts come only from the most recently loaded snapshot (Req 6.6)', async () => {
  // Snapshot A: a single account with 2 investigations (incident == investigation).
  manifestText = manifestJson([
    { account: '111111111111', spaces: [{ agentSpaceId: 's1', investigations: 2, recommendations: 3 }] },
  ]);
  const first = parse(await dashboardHandler(makeEvent()));
  assert.equal(first.json.totals.incidents, 2);
  assert.equal(first.json.totals.investigations, 2);
  assert.equal(first.json.totals.agentSpaces, 1);

  // Snapshot B (a refresh): different accounts + counts entirely.
  manifestText = manifestJson([
    { account: '222222222222', spaces: [{ agentSpaceId: 's2', investigations: 1, recommendations: 1 }] },
    { account: '333333333333', spaces: [{ agentSpaceId: 's3', investigations: 0, recommendations: 0 }] },
  ]);
  const second = parse(await dashboardHandler(makeEvent()));
  // Totals reflect ONLY snapshot B — nothing from A is carried over.
  assert.equal(second.json.totals.incidents, 1);
  assert.equal(second.json.totals.investigations, 1);
  assert.equal(second.json.totals.agentSpaces, 2);
  assert.deepEqual(
    second.json.breakdown.map((r: { key: string }) => r.key).sort(),
    ['222222222222', '333333333333'],
  );
  // The account from snapshot A must not appear in snapshot B's breakdown.
  assert.ok(!second.json.breakdown.some((r: { key: string }) => r.key === '111111111111'));
});

test('/summary totals also reflect only the latest snapshot (Req 6.6)', async () => {
  manifestText = manifestJson([
    { account: '111111111111', spaces: [{ agentSpaceId: 's1', investigations: 7, recommendations: 1 }] },
  ]);
  assert.equal(parse(await summaryHandler(makeEvent())).json.totals.incidents, 7);

  manifestText = manifestJson([{ account: '111111111111', spaces: [] }]);
  const after = parse(await summaryHandler(makeEvent()));
  assert.deepEqual(after.json.totals, zeroTotals());
});

// ---------------------------------------------------------------------------
// Business-context grouping + display-name overlay (Req 6.4, 5.6, 12.6, 12.7)
// ---------------------------------------------------------------------------

test('/dashboard groups by Business_Unit with an Unassigned bucket when context assigns accounts (Req 6.4, 12.7)', async () => {
  manifestText = manifestJson([
    { account: '111111111111', spaces: [{ agentSpaceId: 's1', investigations: 2, recommendations: 1 }] },
    { account: '999999999999', spaces: [{ agentSpaceId: 's2', investigations: 5, recommendations: 5 }] },
  ]);
  contextText = JSON.stringify({
    version: 1,
    updatedAt: '2026-07-01T00:00:00Z',
    businessUnits: [{ name: 'Payments Platform', accounts: ['111111111111'] }],
    accountDisplayNames: {},
  });
  const { json } = parse(await dashboardHandler(makeEvent()));
  assert.equal(json.grouping, 'businessUnit');
  const platform = json.breakdown.find((r: { key: string }) => r.key === 'Payments Platform');
  const unassigned = json.breakdown.find((r: { key: string }) => r.key === 'Unassigned');
  // incident == investigation: Payments Platform inv 2, Unassigned inv 5.
  assert.equal(platform.totals.incidents, 2);
  assert.equal(unassigned.totals.incidents, 5);
});

test('/spaces overlays business-context display name + Business_Unit onto accounts (Req 5.6, 3.5)', async () => {
  contextText = JSON.stringify({
    version: 1,
    updatedAt: '2026-07-01T00:00:00Z',
    businessUnits: [{ name: 'Payments Platform', accounts: ['111111111111'] }],
    accountDisplayNames: { '111111111111': 'Payments Prod' },
  });
  const { json } = parse(await spacesHandler(makeEvent()));
  const acct = json.accounts.find((a: { account: string }) => a.account === '111111111111');
  assert.equal(acct.displayName, 'Payments Prod'); // human-friendly primary label
  assert.equal(acct.businessUnit, 'Payments Platform');
  assert.equal(acct.account, '111111111111'); // raw id retained as secondary reference
});

test('/spaces surfaces the AWS Organizations account name as the display fallback + orgName (Req 3.8)', async () => {
  manifestText = manifestJson([
    { account: '111111111111', name: 'payments-prod', spaces: [{ agentSpaceId: 's1', name: 'Ops' }] },
    { account: '222222222222', spaces: [{ agentSpaceId: 's2' }] }, // no org name
  ]);
  contextText = undefined; // no admin display names
  const { json } = parse(await spacesHandler(makeEvent()));
  const named = json.accounts.find((a: { account: string }) => a.account === '111111111111');
  const unnamed = json.accounts.find((a: { account: string }) => a.account === '222222222222');
  // Org name is surfaced automatically, ahead of the raw id (Req 3.8).
  assert.equal(named.orgName, 'payments-prod');
  assert.equal(named.displayName, 'payments-prod');
  // Without an org name, the display falls back to the raw id and orgName is absent.
  assert.equal(unnamed.displayName, '222222222222');
  assert.equal(unnamed.orgName, undefined);
});

test('/spaces prefers an Admin display name over the org name (Req 3.5 > 3.8)', async () => {
  manifestText = manifestJson([
    { account: '111111111111', name: 'payments-prod', spaces: [{ agentSpaceId: 's1', name: 'Ops' }] },
  ]);
  contextText = JSON.stringify({
    version: 1,
    updatedAt: '2026-07-01T00:00:00Z',
    businessUnits: [],
    accountDisplayNames: { '111111111111': 'Payments Prod' },
  });
  const { json } = parse(await spacesHandler(makeEvent()));
  const acct = json.accounts.find((a: { account: string }) => a.account === '111111111111');
  assert.equal(acct.displayName, 'Payments Prod'); // admin label wins
  assert.equal(acct.orgName, 'payments-prod'); // org name still exposed for search/placeholder
});

test('/dashboard falls back to by-account grouping when no business context exists (Req 6.5)', async () => {
  contextText = undefined;
  const { json } = parse(await dashboardHandler(makeEvent()));
  assert.equal(json.grouping, 'account');
  assert.deepEqual(
    json.breakdown.map((r: { key: string }) => r.key).sort(),
    ['111111111111', '222222222222'],
  );
});
