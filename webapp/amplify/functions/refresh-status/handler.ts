import { assertAdmin } from '../shared/authz';
import { UpstreamUnavailableError, ValidationError } from '../shared/errors';
import { describeRefresh } from '../shared/refresh';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * `GET /refresh/status` (Admin only) — Task 10.2.
 *
 * {@link assertAdmin} gates access (Requirements 2.3, 2.5, 2.6). The caller
 * passes the `executionArn` (or `executionId`) returned by `POST /refresh` as a
 * query parameter; the handler describes that Step Functions execution and maps
 * it to the {@link import('@devops-observatory/shared-types').RefreshStatus}
 * DTO so the UI can show the in-progress indicator and surface the
 * completed/failed state (Requirement 10.4).
 *
 * On a failed/timed-out/aborted execution the mapping includes a stage-specific
 * error message (Requirement 10.8). This handler never writes the manifest, so
 * a failed refresh leaves Last_Sync_Date unchanged; a successful one exposes the
 * completion timestamp (`finishedAt`) the next data load reflects
 * (Requirements 10.6, 10.7).
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  assertAdmin(event);

  const params = event.queryStringParameters ?? {};
  const executionArn = params.executionArn ?? params.executionId;
  if (!executionArn || executionArn.trim() === '') {
    throw new ValidationError(
      'An executionArn query parameter is required to check refresh status.',
    );
  }

  try {
    const status = await describeRefresh(executionArn);
    return jsonResponse(status);
  } catch {
    // The execution could not be described (unknown ARN or transient upstream
    // failure). Surface an unavailable error rather than a fabricated status;
    // no state is changed.
    throw new UpstreamUnavailableError('The refresh status could not be retrieved.');
  }
});
