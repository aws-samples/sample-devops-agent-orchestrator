import type {
  RefreshStartResponse,
  RefreshStatus,
} from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * Refresh API client (Task 10.2 backend, consumed by the Task 16 Admin-only
 * Refresh control).
 *
 * - {@link startRefresh} — Admin-only `POST /refresh`. The backend asserts the
 *   Admin group before starting anything (Requirements 2.3, 10.2) and returns a
 *   202 acceptance with the execution id well within 5 seconds without waiting
 *   for the pipeline (Requirement 10.3). A concurrent start is rejected by the
 *   single-execution lock and surfaces as a 409 `ApiRequestError`
 *   (Requirement 10.5); a start failure surfaces as an upstream error while
 *   leaving the Last_Sync_Date unchanged (Requirement 10.7).
 * - {@link fetchRefreshStatus} — Admin-only `GET /refresh/status`. Polled while
 *   a refresh is running to drive the in-progress indicator and the terminal
 *   completed/failed state, including a stage-specific error on failure
 *   (Requirements 10.4, 10.8).
 *
 * Credential safety: the browser never holds AWS credentials — every request
 * carries only the caller's Cognito access token behind the API's JWT
 * authorizer.
 */

/** Admin-only `POST /refresh` — start the pipeline asynchronously. */
export function startRefresh(): Promise<RefreshStartResponse> {
  return apiFetch<RefreshStartResponse>('/refresh', { method: 'POST' });
}

/**
 * Admin-only `GET /refresh/status` — describe the execution started by
 * {@link startRefresh}. The execution id is passed as the `executionArn` query
 * parameter (the backend also accepts `executionId`).
 */
export function fetchRefreshStatus(executionId: string): Promise<RefreshStatus> {
  const query = new URLSearchParams({ executionArn: executionId }).toString();
  return apiFetch<RefreshStatus>(`/refresh/status?${query}`);
}
