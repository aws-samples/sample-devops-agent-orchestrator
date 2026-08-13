import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  ExecuteQueryCommand,
  NeptuneGraphClient,
} from '@aws-sdk/client-neptune-graph';
import { handler } from './handler';
import type { ApiEvent, ApiResult } from '../shared/http';

/**
 * Integration tests for the `GET /graph` handler (Task 8).
 *
 * Neptune Analytics `ExecuteQuery` is mocked at `NeptuneGraphClient.prototype.send`
 * and S3 at `S3Client.prototype.send`, so the real query module + business-context
 * loader + enrichment core run against controllable payloads.
 *
 * Requirements: 7.1 (enriched node/edge JSON), 7.3 (human-friendly labels),
 * 7.6 (cross-account TARGETS_ACCOUNT flag), 7.7 (unavailable reason categories),
 * 9.9 (latest business-context overlay at query time).
 *
 * Run with: `node --import tsx --test amplify/functions/graph/graph.test.ts`
 */

const CONTEXT_KEY = 'hub/business_context.json';

// --- Controllable mock state -----------------------------------------------
let nodePayload: string;
let edgePayload: string;
/** When set, the Neptune client rejects with an error of this name. */
let queryError: { name: string } | undefined;
let contextText: string | undefined;

function body(text: string): { transformToString: (enc?: string) => Promise<string> } {
  return { transformToString: async () => text };
}

/** Build an openCypher JSON payload envelope from result rows. */
function results(rows: unknown[]): string {
  return JSON.stringify({ results: rows });
}

mock.method(NeptuneGraphClient.prototype, 'send', async function send(command: unknown) {
  if (queryError) {
    const err = new Error('simulated neptune failure');
    err.name = queryError.name;
    throw err;
  }
  if (command instanceof ExecuteQueryCommand) {
    const query = command.input.queryString ?? '';
    if (query.includes('id(n)')) return { payload: body(nodePayload) };
    if (query.includes('-[r]->')) return { payload: body(edgePayload) };
  }
  throw new Error(`unexpected neptune command in test: ${String(command)}`);
});

mock.method(S3Client.prototype, 'send', async function send(command: unknown) {
  if (command instanceof GetObjectCommand) {
    if (command.input.Key === CONTEXT_KEY) {
      if (contextText === undefined) throw new Error('NoSuchKey');
      return { Body: body(contextText) };
    }
  }
  throw new Error(`unexpected s3 command in test: ${String(command)}`);
});

beforeEach(() => {
  queryError = undefined;
  contextText = undefined;
  // Default topology: acct:A owns space:S -> assoc:X -> TARGETS_ACCOUNT acct:B.
  nodePayload = results([
    { id: 'acct:345678901234', labels: ['Account'], properties: { accountId: '345678901234' } },
    { id: 'space:S', labels: ['AgentSpace'], properties: { name: 'Ops Space' } },
    { id: 'assoc:X', labels: ['Association'], properties: { status: 'ACTIVE' } },
    { id: 'acct:111111111111', labels: ['Account'], properties: { accountId: '111111111111' } },
  ]);
  edgePayload = results([
    { source: 'acct:345678901234', target: 'space:S', type: 'HAS_SPACE' },
    { source: 'space:S', target: 'assoc:X', type: 'HAS_ASSOCIATION' },
    { source: 'assoc:X', target: 'acct:111111111111', type: 'TARGETS_ACCOUNT' },
  ]);
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

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test('returns enriched node/edge JSON with a 200 (Req 7.1)', async () => {
  const { status, json } = parse(await handler(makeEvent()));
  assert.equal(status, 200);
  assert.equal(json.nodes.length, 4);
  assert.equal(json.edges.length, 3);
  assert.equal(json.unavailableReason, undefined);
});

test('every node is labelled with a human-friendly label, never the raw UUID (Req 7.3)', async () => {
  const { json } = parse(await handler(makeEvent()));
  for (const n of json.nodes) {
    assert.ok(typeof n.displayLabel === 'string' && n.displayLabel.length > 0);
    assert.notEqual(n.displayLabel, n.id);
  }
  const space = json.nodes.find((n: { id: string }) => n.id === 'space:S');
  assert.equal(space.displayLabel, 'Ops Space');
});

test('cross-account TARGETS_ACCOUNT edge is flagged crossAccount: true (Req 7.6)', async () => {
  const { json } = parse(await handler(makeEvent()));
  const cross = json.edges.find((e: { type: string }) => e.type === 'TARGETS_ACCOUNT');
  assert.equal(cross.crossAccount, true);
  // Structural edges stay false.
  const hasSpace = json.edges.find((e: { type: string }) => e.type === 'HAS_SPACE');
  assert.equal(hasSpace.crossAccount, false);
});

test('overlays the latest business-context labels at query time (Req 9.9)', async () => {
  contextText = JSON.stringify({
    version: 3,
    updatedAt: '2026-07-10T00:00:00Z',
    businessUnits: [{ name: 'Payments Platform', accounts: ['345678901234'] }],
    accountDisplayNames: { '345678901234': 'Payments Prod' },
  });
  const { json } = parse(await handler(makeEvent()));
  const account = json.nodes.find((n: { id: string }) => n.id === 'acct:345678901234');
  // Newest display name + Business_Unit appear without any graph reload.
  assert.equal(account.displayLabel, 'Payments Prod');
  assert.equal(account.businessUnit, 'Payments Platform');
});

// ---------------------------------------------------------------------------
// Unavailable reason categories (Requirement 7.7)
// ---------------------------------------------------------------------------

test('an empty graph returns the "empty" reason, never a blank canvas (Req 7.7)', async () => {
  nodePayload = results([]);
  edgePayload = results([]);
  const { status, json } = parse(await handler(makeEvent()));
  assert.equal(status, 200);
  assert.deepEqual(json.nodes, []);
  assert.deepEqual(json.edges, []);
  assert.equal(json.unavailableReason, 'empty');
});

test('a rejected/unprocessable query yields the "query_failed" reason (Req 7.7)', async () => {
  queryError = { name: 'ValidationException' };
  const { status, json } = parse(await handler(makeEvent()));
  assert.equal(status, 200);
  assert.equal(json.unavailableReason, 'query_failed');
  assert.deepEqual(json.nodes, []);
});

test('a missing graph / access failure yields the "graph_unavailable" reason (Req 7.7)', async () => {
  queryError = { name: 'ResourceNotFoundException' };
  const { status, json } = parse(await handler(makeEvent()));
  assert.equal(status, 200);
  assert.equal(json.unavailableReason, 'graph_unavailable');
});

test('the graph still loads when business context is absent (fail-open overlay)', async () => {
  contextText = undefined; // no business context object
  const { status, json } = parse(await handler(makeEvent()));
  assert.equal(status, 200);
  const account = json.nodes.find((n: { id: string }) => n.id === 'acct:345678901234');
  // Falls back to the typed account label; no businessUnit.
  assert.equal(account.displayLabel, 'Account …78901234');
  assert.equal(account.businessUnit, undefined);
});
