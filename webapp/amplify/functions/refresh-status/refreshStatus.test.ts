import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import {
  DescribeExecutionCommand,
  DescribeMapRunCommand,
  ListMapRunsCommand,
  SFNClient,
} from '@aws-sdk/client-sfn';
import { handler } from './handler';
import {
  extractFailedStage,
  mapCountsToProgress,
  mapExecutionToStatus,
  type ExecutionDescription,
} from '../shared/refresh';
import type { ApiEvent, ApiResult } from '../shared/http';

/**
 * Tests for the `GET /refresh/status` handler + the pure status mapping
 * (Task 10.2).
 *
 * Step Functions is mocked at the `SFNClient.prototype.send` level so the shared
 * refresh module runs for real against a controllable `DescribeExecution`
 * result.
 *
 * Requirements: 10.2/2.3/2.5/2.6 (Admin gate), 10.4 (in-progress + completed +
 * failed state mapping), 10.6 (successful completion timestamp), 10.8 (failed
 * state carries a stage-specific error).
 *
 * Run with: `node --import tsx --test amplify/functions/refresh-status/refreshStatus.test.ts`
 */

const EXECUTION_ARN =
  'arn:aws:states:us-east-1:123456789012:execution:RefreshStateMachine:run-1';

// --- Controllable mock state -----------------------------------------------
let describeResult: ExecutionDescription | undefined;
let describeShouldFail: boolean;
// Distributed Map progress (only consulted while RUNNING). Default: no map run.
let mapRunArn: string | undefined;
let mapRunResult: { status?: string; itemCounts?: Record<string, number> } | undefined;

mock.method(SFNClient.prototype, 'send', async function send(command: unknown) {
  if (command instanceof DescribeExecutionCommand) {
    if (describeShouldFail) throw new Error('simulated DescribeExecution failure');
    return describeResult ?? {};
  }
  if (command instanceof ListMapRunsCommand) {
    return { mapRuns: mapRunArn ? [{ mapRunArn }] : [] };
  }
  if (command instanceof DescribeMapRunCommand) {
    return mapRunResult ?? {};
  }
  throw new Error(`unexpected command in test: ${String(command)}`);
});

beforeEach(() => {
  describeResult = undefined;
  describeShouldFail = false;
  mapRunArn = undefined;
  mapRunResult = undefined;
});

// --- Event + response helpers ----------------------------------------------
function makeEvent(opts: { groups?: string[]; executionArn?: string }): ApiEvent {
  const authorizer =
    opts.groups === undefined
      ? undefined
      : { jwt: { claims: { sub: 'user-1', 'cognito:groups': opts.groups } } };
  return {
    requestContext: { http: { method: 'GET' }, authorizer },
    queryStringParameters:
      opts.executionArn === undefined ? undefined : { executionArn: opts.executionArn },
  } as unknown as ApiEvent;
}

function parse(res: ApiResult): { status: number; json: any } {
  const structured = res as { statusCode: number; body: string };
  return { status: structured.statusCode, json: JSON.parse(structured.body) };
}

// ---------------------------------------------------------------------------
// Admin gate (Req 2.3, 2.5, 2.6)
// ---------------------------------------------------------------------------

test('GET status by an unauthenticated caller is rejected 401 (Req 2.6)', async () => {
  const { status, json } = parse(await handler(makeEvent({ executionArn: EXECUTION_ARN })));
  assert.equal(status, 401);
  assert.equal(json.code, 'UNAUTHENTICATED');
});

test('GET status by an Executive is rejected 403 (Req 2.3)', async () => {
  const { status, json } = parse(
    await handler(makeEvent({ groups: ['Executive'], executionArn: EXECUTION_ARN })),
  );
  assert.equal(status, 403);
  assert.equal(json.code, 'FORBIDDEN');
});

test('GET status without an executionArn is rejected 400', async () => {
  const { status, json } = parse(await handler(makeEvent({ groups: ['Admin'] })));
  assert.equal(status, 400);
  assert.equal(json.code, 'VALIDATION');
});

// ---------------------------------------------------------------------------
// State mapping through the handler (Req 10.4, 10.6, 10.8)
// ---------------------------------------------------------------------------

test('GET status maps a RUNNING execution to the in-progress state (Req 10.4)', async () => {
  describeResult = {
    executionArn: EXECUTION_ARN,
    status: 'RUNNING',
    startDate: new Date('2026-07-03T10:00:00Z'),
  };
  const { status, json } = parse(
    await handler(makeEvent({ groups: ['Admin'], executionArn: EXECUTION_ARN })),
  );
  assert.equal(status, 200);
  assert.equal(json.state, 'RUNNING');
  assert.equal(json.executionId, EXECUTION_ARN);
  assert.equal(json.startedAt, '2026-07-03T10:00:00.000Z');
  assert.equal(json.finishedAt, undefined);
  assert.equal(json.errorMessage, undefined);
});

test('GET status reports collect progress from a RUNNING map run (Req 10.12)', async () => {
  describeResult = { executionArn: EXECUTION_ARN, status: 'RUNNING' };
  mapRunArn = `${EXECUTION_ARN}/mapRun-1`;
  mapRunResult = {
    status: 'RUNNING',
    itemCounts: { total: 1000, succeeded: 620, failed: 5, pending: 375, running: 0 },
  };
  const { status, json } = parse(
    await handler(makeEvent({ groups: ['Admin'], executionArn: EXECUTION_ARN })),
  );
  assert.equal(status, 200);
  assert.equal(json.state, 'RUNNING');
  assert.equal(json.currentStage, 'collect');
  assert.deepEqual(json.progress, { stage: 'collect', total: 1000, completed: 625, failed: 5 });
});

test('GET status marks the finalize phase once the collect map run has finished', async () => {
  describeResult = { executionArn: EXECUTION_ARN, status: 'RUNNING' };
  mapRunArn = `${EXECUTION_ARN}/mapRun-1`;
  mapRunResult = { status: 'SUCCEEDED', itemCounts: { total: 10, succeeded: 10, failed: 0 } };
  const { json } = parse(
    await handler(makeEvent({ groups: ['Admin'], executionArn: EXECUTION_ARN })),
  );
  assert.equal(json.state, 'RUNNING');
  assert.equal(json.currentStage, 'finalizing');
  // Progress is only surfaced while the map is still collecting.
  assert.equal(json.progress, undefined);
});

test('GET status maps a SUCCEEDED execution with the completion timestamp (Req 10.6)', async () => {
  describeResult = {
    executionArn: EXECUTION_ARN,
    status: 'SUCCEEDED',
    startDate: new Date('2026-07-03T10:00:00Z'),
    stopDate: new Date('2026-07-03T10:30:00Z'),
  };
  const { status, json } = parse(
    await handler(makeEvent({ groups: ['Admin'], executionArn: EXECUTION_ARN })),
  );
  assert.equal(status, 200);
  assert.equal(json.state, 'SUCCEEDED');
  assert.equal(json.finishedAt, '2026-07-03T10:30:00.000Z');
  assert.equal(json.errorMessage, undefined);
  assert.equal(json.errorStage, undefined);
});

test('GET status maps a FAILED execution to a stage-specific error (Req 10.8)', async () => {
  describeResult = {
    executionArn: EXECUTION_ARN,
    status: 'FAILED',
    startDate: new Date('2026-07-03T10:00:00Z'),
    stopDate: new Date('2026-07-03T10:05:00Z'),
    error: 'RefreshPipelineFailed',
    cause: 'Container exited: ::pipeline::failed::transform',
  };
  const { status, json } = parse(
    await handler(makeEvent({ groups: ['Admin'], executionArn: EXECUTION_ARN })),
  );
  assert.equal(status, 200);
  assert.equal(json.state, 'FAILED');
  assert.equal(json.errorStage, 'transform');
  assert.match(json.errorMessage, /transform/);
  assert.match(json.errorMessage, /unchanged/i);
});

test('GET status of an unknown/undescribable execution surfaces an unavailable error', async () => {
  describeShouldFail = true;
  const { status, json } = parse(
    await handler(makeEvent({ groups: ['Admin'], executionArn: EXECUTION_ARN })),
  );
  assert.equal(status, 502);
  assert.equal(json.code, 'UPSTREAM_UNAVAILABLE');
});

// ---------------------------------------------------------------------------
// Pure mapping — mapExecutionToStatus / extractFailedStage
// ---------------------------------------------------------------------------

test('mapExecutionToStatus treats PENDING_REDRIVE as in-progress', () => {
  const status = mapExecutionToStatus({ executionArn: EXECUTION_ARN, status: 'PENDING_REDRIVE' });
  assert.equal(status.state, 'RUNNING');
});

test('mapExecutionToStatus surfaces a generic failure when no stage marker is present (Req 10.8)', () => {
  const status = mapExecutionToStatus({
    executionArn: EXECUTION_ARN,
    status: 'FAILED',
    error: 'RefreshPipelineFailed',
    cause: 'The refresh pipeline task failed; see the task logs for the failing stage.',
  });
  assert.equal(status.state, 'FAILED');
  assert.equal(status.errorStage, undefined);
  assert.match(status.errorMessage!, /unchanged/i);
});

test('mapExecutionToStatus reports a concurrent-refresh rejection distinctly (Req 10.5 surfacing)', () => {
  const status = mapExecutionToStatus({
    executionArn: EXECUTION_ARN,
    status: 'FAILED',
    error: 'RefreshAlreadyRunning',
    cause: 'A refresh is already in progress; concurrent refreshes are rejected.',
  });
  assert.equal(status.state, 'FAILED');
  assert.equal(status.errorStage, undefined);
  assert.match(status.errorMessage!, /already in progress/i);
});

test('mapExecutionToStatus maps TIMED_OUT and ABORTED to failure states with a message', () => {
  for (const raw of ['TIMED_OUT', 'ABORTED'] as const) {
    const status = mapExecutionToStatus({ executionArn: EXECUTION_ARN, status: raw });
    assert.equal(status.state, raw);
    assert.match(status.errorMessage!, /unchanged/i);
  }
});

test('extractFailedStage recognises both marker formats and validates the stage name', () => {
  assert.equal(extractFailedStage('foo ::pipeline::failed::graph_reload bar'), 'graph_reload');
  assert.equal(extractFailedStage('::stage::kb_sync::failed'), 'kb_sync');
  // Unknown stage names are not accepted.
  assert.equal(extractFailedStage('::pipeline::failed::bogus'), undefined);
  assert.equal(extractFailedStage(undefined, 'no marker here'), undefined);
});

test('mapCountsToProgress folds aborted/timedOut into failed and sums completed', () => {
  const p = mapCountsToProgress({ total: 100, succeeded: 80, failed: 3, aborted: 1, timedOut: 1 });
  assert.deepEqual(p, { stage: 'collect', total: 100, completed: 85, failed: 5 });
});

test('mapCountsToProgress defaults missing counts to zero', () => {
  assert.deepEqual(mapCountsToProgress({}), { stage: 'collect', total: 0, completed: 0, failed: 0 });
});
