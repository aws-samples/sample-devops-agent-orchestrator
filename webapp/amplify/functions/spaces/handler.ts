import { buildSpaces } from '../shared/aggregation';
import { UpstreamUnavailableError } from '../shared/errors';
import { loadBusinessContext, loadManifest } from '../shared/hubData';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * `GET /spaces` (Task 4.2) — per-account agent spaces for the Space_View.
 *
 * Lists every account in the manifest with its spaces grouped underneath,
 * each space's name (or `agentSpaceId` when unnamed) and activity counts, the
 * account's collected/incomplete status (from the manifest `error` field), and
 * the per-account Last_Sync_Date. Business-context display names / Business_Unit
 * labels are overlaid when present (Requirements 3.1–3.6).
 *
 * If the manifest cannot be retrieved or parsed, this returns an
 * "account data unavailable" error and NO partial listing (Requirement 3.7).
 * Authentication is enforced by the Cognito JWT authorizer before this runs.
 */
export const handler = withErrorHandling(async (_event: ApiEvent): Promise<ApiResult> => {
  const load = await loadManifest();
  if (load.status !== 'ok') {
    throw new UpstreamUnavailableError(
      'Account data is currently unavailable. Please try again once collection completes.',
    );
  }
  const context = await loadBusinessContext();
  return jsonResponse(buildSpaces(load.manifest, context));
});
