import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import {
  DescribeExecutionCommand,
  ListExecutionsCommand,
  SFNClient,
  StartExecutionCommand,
} from '@aws-sdk/client-sfn';
import { handler } from './handler';
import type { ApiEvent, ApiResult } from '../shared/http';

/**
 * Tests for the `POST /refresh` handler (Task 10.2).
 *
 * Step Functions is mocked at the `SFNClient.prototype.send` level so the shared
 * refresh module runs for real against a controllable `StartExecution` result.
 *
 * Requirements: 10.2 (Admin-only; non-Admin rejected, nothing started),
 * 10.3 (async accept with an execution id), 10.7 (start failure surfaces a
 * "did not start" error and changes no state / Last_Sync_Date).
 *
 * Run with: `node --import tsx --test amplify/functions/refresh/refresh.test.ts`
 */

const STATE_MACHINE_ARN =
  'arn:aws:states:us-east-1:123456789012:stateMachine:RefreshStateMachine';

// --- Controllable mock state -----------------------------------------------
let startShouldFail: boolean;
let alreadyRunning: boolean;
let startCommands: StartExecutionCommand[];
let listCommands: ListExecutionsCommand[];

mock.method(SFNClient.prototype, 'send', async function send(command: unknown) {
  // Single-flight check runs first: return a RUNNING execution when simulating
  // an in-progress refresh, else none.
  if (command instanceof ListExecutionsCommand) {
    listCommands.push(command);
    return { executions: alreadyRunning ? [{ executionArn: 'run-existing', status: 'RUNNING' }] : [] };
  }
  if (command instanceof StartExecutionCommand) {
    startCommands.push(command);
    if (startShouldFail) throw new Error('simulated StartExecution failure');
    return {
      executionArn: `${STATE_MACHINE_ARN.replace(':stateMachine:', ':execution:')}:run-1`,
      startDate: new Date('2026-07-03T10:00:00Z'),
    };
  }
  // POST /refresh must not describe executions.
  if (command instanceof DescribeExecutionCommand) {
    throw new Error('unexpected DescribeExecution in POST /refresh test');
  }
  throw new Error(`unexpected command in test: ${String(command)}`);
});

beforeEach(() => {
  process.env.REFRESH_STATE_MACHINE_ARN = STATE_MACHINE_ARN;
  startShouldFail = false;
  alreadyRunning = false;
  startCommands = [];
  listCommands = [];
});

// --- Event + response helpers ----------------------------------------------
function makeEvent(opts: { groups?: string[] }): ApiEvent {
  const authorizer =
    opts.groups === undefined
      ? undefined
      : { jwt: { claims: { sub: 'user-1', 'cognito:groups': opts.groups } } };
  return {
    requestContext: { http: { method: 'POST' }, authorizer },
  } as unknown as ApiEvent;
}

function parse(res: ApiResult): { status: number; json: any } {
  const structured = res as { statusCode: number; body: string };
  return { status: structured.statusCode, json: JSON.parse(structured.body) };
}

// ---------------------------------------------------------------------------
// Admin gate (Req 2.3, 2.5, 2.6, 10.2)
// ---------------------------------------------------------------------------

test('POST by an unauthenticated caller is rejected 401 and starts nothing (Req 2.6, 10.2)', async () => {
  const { status, json } = parse(await handler(makeEvent({})));
  assert.equal(status, 401);
  assert.equal(json.code, 'UNAUTHENTICATED');
  assert.equal(startCommands.length, 0, 'no state machine execution was started');
});

test('POST by an Executive is rejected 403 and starts nothing (Req 2.3, 10.2)', async () => {
  const { status, json } = parse(await handler(makeEvent({ groups: ['Executive'] })));
  assert.equal(status, 403);
  assert.equal(json.code, 'FORBIDDEN');
  assert.equal(startCommands.length, 0, 'no state machine execution was started');
});

// ---------------------------------------------------------------------------
// Async accept (Req 10.3)
// ---------------------------------------------------------------------------

test('POST by an Admin starts the refresh and returns 202 with the execution id (Req 10.3)', async () => {
  const { status, json } = parse(await handler(makeEvent({ groups: ['Admin'] })));
  assert.equal(status, 202);
  assert.equal(json.state, 'RUNNING');
  assert.match(json.executionId, /:execution:.*:run-1$/);
  // Exactly one execution was started, against the configured state machine.
  assert.equal(startCommands.length, 1);
  assert.equal(startCommands[0]!.input.stateMachineArn, STATE_MACHINE_ARN);
});

test('POST does not wait for the pipeline — it returns as soon as the start is accepted (Req 10.3)', async () => {
  const startedAt = Date.now();
  await handler(makeEvent({ groups: ['Admin'] }));
  // StartExecution returns immediately; the handler must not block on the run.
  assert.ok(Date.now() - startedAt < 5000, 'accepted well within the 5s budget');
});

// ---------------------------------------------------------------------------
// Start failure (Req 10.7)
// ---------------------------------------------------------------------------

test('POST surfaces a "did not start" error when StartExecution fails (Req 10.7)', async () => {
  startShouldFail = true;
  const { status, json } = parse(await handler(makeEvent({ groups: ['Admin'] })));
  assert.equal(status, 502);
  assert.equal(json.code, 'UPSTREAM_UNAVAILABLE');
  // The message makes clear the refresh did not start and freshness is unchanged.
  assert.match(json.message, /did not start|unchanged/i);
});

// ---------------------------------------------------------------------------
// Single-flight rejection (Req 10.5)
// ---------------------------------------------------------------------------

test('POST while a refresh is already running is rejected 409 and starts nothing (Req 10.5)', async () => {
  alreadyRunning = true;
  const { status, json } = parse(await handler(makeEvent({ groups: ['Admin'] })));
  assert.equal(status, 409);
  assert.equal(json.code, 'CONFLICT');
  assert.match(json.message, /already running/i);
  // The single-flight check ran, and NO new execution was started.
  assert.equal(listCommands.length, 1);
  assert.equal(startCommands.length, 0, 'no new execution was started while one is running');
});
