import { buildSummary, unavailableSummary } from '../shared/aggregation';
import { loadManifest } from '../shared/hubData';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * `GET /summary` (Task 4.1) — landing metrics + Last_Sync_Date.
 *
 * Reads `raw/_manifest.json` (authoritative account scope, Req 12.2) and the
 * optional `hub/business_context.json`, then returns the aggregate totals
 * (incidents = investigations + open recommendations), agent-space usage, and
 * the manifest `collectedAt` as Last_Sync_Date (Requirements 6.1–6.3, 11.1).
 *
 * When the manifest is unavailable/invalid it returns a freshness-unknown
 * marker with zeroed totals rather than a stale or blank timestamp (Req 4.3).
 * Authentication is enforced by the Cognito JWT authorizer before this runs.
 */
export const handler = withErrorHandling(async (_event: ApiEvent): Promise<ApiResult> => {
  const load = await loadManifest();
  if (load.status !== 'ok') {
    return jsonResponse(unavailableSummary());
  }
  return jsonResponse(buildSummary(load.manifest));
});
