import type { RefreshStartResponse } from '@devops-observatory/shared-types';
import { assertAdmin } from '../shared/authz';
import { ConflictError, UpstreamUnavailableError } from '../shared/errors';
import { ALREADY_RUNNING, startRefresh } from '../shared/refresh';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * `POST /refresh` (Admin only) — Task 10.2.
 *
 * {@link assertAdmin} runs BEFORE anything else and throws 401/403 for missing
 * identities / Executive callers, so a non-Admin refusal starts no pipeline and
 * changes no state (Requirements 2.3, 2.5, 2.6, 10.2). For an authenticated
 * Admin it starts the refresh state machine asynchronously and confirms
 * acceptance with the new execution id — `StartExecution` returns immediately,
 * so the response lands well within 5s without waiting for the pipeline
 * (Requirement 10.3).
 *
 * A start failure surfaces a "refresh did not start" error; because nothing
 * here writes the manifest, Last_Sync_Date is left unchanged (Requirement 10.7).
 * The single-execution lock (Requirement 10.5) is enforced by the state machine
 * itself (Task 10.1); `GET /refresh/status` reports the resulting state.
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  assertAdmin(event); // authz gate — denials start nothing and change no state

  let started;
  try {
    started = await startRefresh();
  } catch (err) {
    // A refresh already in progress is rejected with 409; nothing is started and
    // Last_Sync_Date is unchanged (Requirement 10.5).
    if (err instanceof Error && err.message === ALREADY_RUNNING) {
      throw new ConflictError(
        'A refresh is already running. Wait for it to finish before starting another.',
      );
    }
    // Otherwise the start failed — no execution exists. Report that the refresh
    // did not start; Last_Sync_Date is unchanged (Requirement 10.7).
    throw new UpstreamUnavailableError(
      'The refresh could not be started. No refresh is running and the last sync date is unchanged.',
    );
  }

  const body: RefreshStartResponse = {
    executionId: started.executionArn,
    state: 'RUNNING',
  };
  // 202 Accepted — the pipeline runs asynchronously (Requirement 10.3).
  return jsonResponse(body, 202);
});
