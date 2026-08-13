import type { RefreshState, RefreshStatus } from '@devops-observatory/shared-types';

/**
 * Pure, DOM-free logic for the Admin-only Refresh control (Task 16).
 *
 * Separated from the React component so the state classification, polling
 * cadence, and message derivation can be unit-tested with the repo's
 * `node:test` + tsx convention. Every function is deterministic and side-effect
 * free.
 *
 * The backend contract (`POST /refresh`, `GET /refresh/status`) drives the UI:
 *   - a started refresh is `RUNNING`; the control shows an in-progress
 *     indicator until a terminal state is reached (Requirement 10.4);
 *   - a concurrent request is rejected — surfaced either as a failed status
 *     carrying an "already running" message (the state machine's single-
 *     execution lock, Requirement 10.5) or, defensively, as a 409 on the start
 *     call;
 *   - a stage failure surfaces a stage-specific error (Requirement 10.8);
 *   - a start failure leaves the Last_Sync_Date unchanged (Requirement 10.7).
 */

/** How often to poll `GET /refresh/status` while a refresh is in progress. */
export const REFRESH_POLL_INTERVAL_MS = 3000;

/** True while a refresh execution is still in progress (Requirement 10.4). */
export function isInProgress(state: RefreshState): boolean {
  return state === 'RUNNING';
}

/** True once a refresh execution has reached a terminal state. */
export function isTerminal(state: RefreshState): boolean {
  return !isInProgress(state);
}

/** True when a terminal state represents a failure (Requirement 10.8). */
export function isFailure(state: RefreshState): boolean {
  return state === 'FAILED' || state === 'TIMED_OUT' || state === 'ABORTED';
}

/**
 * True when a refresh status represents a rejected concurrent refresh
 * (Requirement 10.5). The state machine's single-execution lock ends the new
 * execution in a failure state with an "already running / in progress" message
 * and no failing pipeline stage.
 */
export function isAlreadyRunningStatus(status: RefreshStatus): boolean {
  if (!isFailure(status.state)) {
    return false;
  }
  if (status.errorStage) {
    return false; // a real stage failure, not a concurrency rejection
  }
  const message = status.errorMessage ?? '';
  return /already\s+(running|in progress)|in progress/i.test(message);
}

/**
 * True when a `POST /refresh` rejection indicates a refresh is already running.
 * The current backend enforces concurrency inside the state machine (so the
 * rejection appears via {@link isAlreadyRunningStatus}), but this defensively
 * also recognises a 409 CONFLICT should the start call reject directly.
 *
 * The error is duck-typed (a `status` number and/or `body.code`) rather than
 * checked with `instanceof` so this module stays free of the API client (and
 * its browser-only Amplify dependency) and remains unit-testable in isolation.
 */
export function isAlreadyRunningError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { status?: unknown; body?: { code?: unknown } };
  if (e.status === 409) {
    return true;
  }
  return e.body?.code === 'CONFLICT';
}

/** Standard user-facing message when a refresh is already running (Req 10.5). */
export const ALREADY_RUNNING_MESSAGE =
  'A refresh is already running. Wait for it to finish before starting another.';

/** Visual tone for the status banner. */
export type RefreshTone = 'running' | 'success' | 'error';

/** A view-model summarising a refresh status for rendering. */
export interface RefreshStatusView {
  tone: RefreshTone;
  /** Whether the in-progress indicator should be shown (Requirement 10.4). */
  inProgress: boolean;
  title: string;
  detail: string;
  /** The failing stage, when a stage-specific failure occurred (Req 10.8). */
  stage?: string;
}

/**
 * Derive the banner view-model from a refresh status. In-progress stays visible
 * until a terminal state (Requirement 10.4); a concurrency rejection maps to the
 * "already running" message (Requirement 10.5); a stage failure surfaces the
 * failing stage and its message (Requirement 10.8); success notes that the next
 * data load reflects the new sync date (Requirement 10.6 is applied server-side).
 */
export function inProgressDetail(status: RefreshStatus): string {
  const p = status.progress;
  if (p && p.stage === 'collect' && p.total > 0) {
    const failedNote = p.failed > 0 ? ` (${p.failed} failed so far)` : '';
    return `Collecting accounts: ${p.completed} of ${p.total}${failedNote}…`;
  }
  if (status.currentStage === 'collect') {
    return 'Collecting accounts across the organization…';
  }
  if (status.currentStage === 'finalizing') {
    return 'Finalizing: transforming the graph, syncing the knowledge base, and reloading Neptune…';
  }
  if (status.currentStage) {
    return `Running the "${status.currentStage}" stage…`;
  }
  return 'The data refresh pipeline is running. This can take a while for large organizations.';
}

export function refreshStatusView(status: RefreshStatus): RefreshStatusView {
  if (isInProgress(status.state)) {
    return {
      tone: 'running',
      inProgress: true,
      title: 'Refresh in progress',
      detail: inProgressDetail(status),
    };
  }

  if (status.state === 'SUCCEEDED') {
    return {
      tone: 'success',
      inProgress: false,
      title: 'Refresh complete',
      detail:
        'The data refresh finished successfully. Updated data and last sync date appear on the next load of each view.',
    };
  }

  // Terminal failure states (FAILED / TIMED_OUT / ABORTED).
  if (isAlreadyRunningStatus(status)) {
    return {
      tone: 'error',
      inProgress: false,
      title: 'Refresh already running',
      detail: ALREADY_RUNNING_MESSAGE,
    };
  }

  return {
    tone: 'error',
    inProgress: false,
    title: 'Refresh failed',
    detail:
      status.errorMessage ??
      'The refresh pipeline failed and did not complete. The last sync date is unchanged.',
    ...(status.errorStage ? { stage: status.errorStage } : {}),
  };
}

/** Message for a start (`POST /refresh`) failure that is not a concurrency reject. */
export function startFailureMessage(err: unknown): string {
  if (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string' &&
    (err as { message: string }).message.length > 0
  ) {
    return (err as { message: string }).message;
  }
  return 'The refresh could not be started. No refresh is running and the last sync date is unchanged.';
}
