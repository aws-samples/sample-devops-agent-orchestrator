import { buildDashboard, unavailableDashboard } from '../shared/aggregation';
import { loadBusinessContext, loadManifest } from '../shared/hubData';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * `GET /dashboard` (Task 4.3) — aggregated counts across all manifest accounts.
 *
 * Sums incidents (investigations + open recommendations), investigations, and
 * agent-space usage over the full manifest scope, and provides a breakdown by
 * Business_Unit when business context assigns any account (else by account),
 * with unassigned accounts grouped under "Unassigned" (Requirements 6.4–6.5,
 * 12.5–12.7). Zero metrics are returned as the integer 0, never omitted
 * (Requirement 6.7).
 *
 * When the manifest is unavailable it returns zeroed totals, an empty breakdown
 * (the UI's no-data signal, Requirement 6.8), and a freshness-unknown marker.
 * Authentication is enforced by the Cognito JWT authorizer before this runs.
 */
export const handler = withErrorHandling(async (_event: ApiEvent): Promise<ApiResult> => {
  const load = await loadManifest();
  if (load.status !== 'ok') {
    return jsonResponse(unavailableDashboard());
  }
  const context = await loadBusinessContext();
  return jsonResponse(buildDashboard(load.manifest, context));
});
