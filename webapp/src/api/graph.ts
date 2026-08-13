import type { GraphResponse } from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * `GET /graph` client (Task 8 backend, consumed by the Task 14 Graph_View).
 *
 * Returns the enriched topology: nodes (each with a human-friendly
 * `displayLabel`, type, business metadata, and optional Business_Unit) and edges
 * (cross-account `TARGETS_ACCOUNT` links flagged with `crossAccount: true`) —
 * Requirements 7.1–7.6, 9.1–9.9.
 *
 * When the graph cannot be produced the backend never returns a blank payload:
 * it responds 200 with an empty `nodes`/`edges` set plus an `unavailableReason`
 * category (`empty` = no data available; `graph_unavailable` / `query_failed` =
 * load failure) so the view can show a reason rather than a blank canvas
 * (Requirement 7.7). No AWS credentials are used in the browser — all access is
 * server-side behind the API's JWT authorizer.
 */
export function fetchGraph(): Promise<GraphResponse> {
  return apiFetch<GraphResponse>('/graph');
}
