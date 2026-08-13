import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { RefreshStatus } from '@devops-observatory/shared-types';
import {
  ALREADY_RUNNING_MESSAGE,
  inProgressDetail,
  isAlreadyRunningError,
  isAlreadyRunningStatus,
  isFailure,
  isInProgress,
  isTerminal,
  refreshStatusView,
  REFRESH_POLL_INTERVAL_MS,
  startFailureMessage,
} from './refreshControl';

/**
 * Tests for the Refresh control logic (Task 16).
 *
 * Run with: `node --import tsx --test src/lib/refreshControl.test.ts`
 *
 * Requirements: 10.3 (async accept / running), 10.4 (in-progress indicator kept
 * until terminal), 10.5 (concurrent request rejected — "already running"),
 * 10.8 (stage-specific failure message).
 */

function status(overrides: Partial<RefreshStatus> = {}): RefreshStatus {
  return { executionId: 'arn:exec:run-1', state: 'RUNNING', ...overrides };
}

// ---------------------------------------------------------------------------
// State classification (Req 10.3, 10.4, 10.8)
// ---------------------------------------------------------------------------

test('isInProgress is true only for RUNNING (Req 10.3, 10.4)', () => {
  assert.equal(isInProgress('RUNNING'), true);
  assert.equal(isInProgress('SUCCEEDED'), false);
  assert.equal(isInProgress('FAILED'), false);
});

test('isTerminal is the complement of in-progress (Req 10.4)', () => {
  assert.equal(isTerminal('RUNNING'), false);
  for (const s of ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'] as const) {
    assert.equal(isTerminal(s), true);
  }
});

test('isFailure covers FAILED / TIMED_OUT / ABORTED (Req 10.8)', () => {
  assert.equal(isFailure('FAILED'), true);
  assert.equal(isFailure('TIMED_OUT'), true);
  assert.equal(isFailure('ABORTED'), true);
  assert.equal(isFailure('SUCCEEDED'), false);
  assert.equal(isFailure('RUNNING'), false);
});

test('the poll interval is a positive number of milliseconds', () => {
  assert.ok(REFRESH_POLL_INTERVAL_MS > 0);
});

// ---------------------------------------------------------------------------
// In-progress view (Req 10.4)
// ---------------------------------------------------------------------------

test('a RUNNING status yields an in-progress view kept visible (Req 10.4)', () => {
  const view = refreshStatusView(status({ state: 'RUNNING', currentStage: 'transform' }));
  assert.equal(view.tone, 'running');
  assert.equal(view.inProgress, true);
  assert.match(view.detail, /transform/);
});

test('a RUNNING status without a stage still shows a generic in-progress detail', () => {
  const view = refreshStatusView(status({ state: 'RUNNING' }));
  assert.equal(view.inProgress, true);
  assert.match(view.title, /in progress/i);
});

// ---------------------------------------------------------------------------
// Success view (Req 10.6 surfaced to the user)
// ---------------------------------------------------------------------------

test('a SUCCEEDED status yields a success view that is no longer in progress', () => {
  const view = refreshStatusView(status({ state: 'SUCCEEDED', finishedAt: '2026-07-03T10:05:00Z' }));
  assert.equal(view.tone, 'success');
  assert.equal(view.inProgress, false);
  assert.match(view.title, /complete/i);
});

// ---------------------------------------------------------------------------
// Already-running rejection (Req 10.5)
// ---------------------------------------------------------------------------

test('isAlreadyRunningStatus detects the concurrency rejection (failure, no stage, "in progress" msg) (Req 10.5)', () => {
  const s = status({
    state: 'FAILED',
    errorMessage: 'A refresh is already in progress; concurrent refreshes are rejected.',
  });
  assert.equal(isAlreadyRunningStatus(s), true);
  const view = refreshStatusView(s);
  assert.equal(view.tone, 'error');
  assert.match(view.title, /already running/i);
  assert.equal(view.detail, ALREADY_RUNNING_MESSAGE);
});

test('a genuine stage failure is NOT treated as an already-running rejection (Req 10.5 vs 10.8)', () => {
  const s = status({
    state: 'FAILED',
    errorStage: 'collect',
    errorMessage: 'The refresh failed during the "collect" stage. The last sync date is unchanged.',
  });
  assert.equal(isAlreadyRunningStatus(s), false);
});

test('isAlreadyRunningError recognises a 409 CONFLICT start rejection (Req 10.5)', () => {
  assert.equal(isAlreadyRunningError({ status: 409 }), true);
  assert.equal(isAlreadyRunningError({ status: 500, body: { code: 'CONFLICT' } }), true);
  assert.equal(isAlreadyRunningError({ status: 502 }), false);
  assert.equal(isAlreadyRunningError(new Error('boom')), false);
  assert.equal(isAlreadyRunningError(null), false);
});

// ---------------------------------------------------------------------------
// Stage-specific failure (Req 10.8)
// ---------------------------------------------------------------------------

test('a stage failure surfaces the failing stage and its message (Req 10.8)', () => {
  const view = refreshStatusView(
    status({
      state: 'FAILED',
      errorStage: 'kb_sync',
      errorMessage: 'The refresh failed during the "kb_sync" stage. The last sync date is unchanged.',
    }),
  );
  assert.equal(view.tone, 'error');
  assert.match(view.title, /failed/i);
  assert.equal(view.stage, 'kb_sync');
  assert.match(view.detail, /kb_sync/);
  assert.match(view.detail, /unchanged/i);
});

test('a failure without a stage or message falls back to a generic failure detail (Req 10.8)', () => {
  const view = refreshStatusView(status({ state: 'FAILED' }));
  assert.equal(view.tone, 'error');
  assert.equal(view.stage, undefined);
  assert.match(view.detail, /failed|unchanged/i);
});

// ---------------------------------------------------------------------------
// Start-failure message (Req 10.7)
// ---------------------------------------------------------------------------

test('startFailureMessage uses the error message when present, else a safe default (Req 10.7)', () => {
  assert.equal(startFailureMessage({ message: 'The refresh could not be started.' }), 'The refresh could not be started.');
  assert.match(startFailureMessage({}), /could not be started|unchanged/i);
  assert.match(startFailureMessage(null), /could not be started|unchanged/i);
});

// ---------------------------------------------------------------------------
// Collect progress detail (Req 10.12)
// ---------------------------------------------------------------------------

test('inProgressDetail shows N of M accounts while collecting (Req 10.12)', () => {
  const detail = inProgressDetail(
    status({ currentStage: 'collect', progress: { stage: 'collect', total: 1000, completed: 625, failed: 0 } }),
  );
  assert.match(detail, /625 of 1000/);
});

test('inProgressDetail notes failed accounts when some collection failed (Req 10.10, 10.12)', () => {
  const detail = inProgressDetail(
    status({ currentStage: 'collect', progress: { stage: 'collect', total: 50, completed: 20, failed: 3 } }),
  );
  assert.match(detail, /20 of 50/);
  assert.match(detail, /3 failed/i);
});

test('inProgressDetail describes the finalize phase when collection is done', () => {
  const detail = inProgressDetail(status({ currentStage: 'finalizing' }));
  assert.match(detail, /knowledge base|neptune|transform/i);
});

test('inProgressDetail falls back to a generic message with no stage/progress', () => {
  assert.match(inProgressDetail(status()), /pipeline is running/i);
});

test('refreshStatusView surfaces collect progress in the running banner detail (Req 10.12)', () => {
  const view = refreshStatusView(
    status({ currentStage: 'collect', progress: { stage: 'collect', total: 200, completed: 10, failed: 0 } }),
  );
  assert.equal(view.tone, 'running');
  assert.equal(view.inProgress, true);
  assert.match(view.detail, /10 of 200/);
});
