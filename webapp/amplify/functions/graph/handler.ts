import {
  buildGraphResponse,
  isEmptyGraph,
  unavailableGraph,
} from '../shared/graphEnrichment';
import { loadBusinessContext } from '../shared/hubData';
import { loadGraph } from '../shared/neptuneGraph';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * `GET /graph` (Task 8) — the enriched topology graph for the Graph_View.
 *
 * At query time the handler:
 *   1. Runs the Neptune Analytics `ExecuteQuery` openCypher projections for all
 *      nodes and relationships (Requirement 7.1).
 *   2. Loads the latest `hub/business_context.json` and overlays it onto the
 *      nodes so the newest display names / Business_Unit labels appear without a
 *      full graph reload (Requirement 9.9).
 *   3. Derives each node's human-friendly `displayLabel` (typed fallback, never
 *      the raw UUID) and flags cross-account `TARGETS_ACCOUNT` edges
 *      (Requirements 7.3, 7.6, 9.1, 9.8).
 *
 * The response never leaves the Graph_View blank: when the graph cannot be read
 * it returns an empty node/edge set plus a reason category (`graph_unavailable`
 * / `query_failed`), and when the graph loads but has no nodes it returns the
 * `empty` reason (Requirement 7.7). Authentication is enforced by the Cognito
 * JWT authorizer before this runs.
 */
export const handler = withErrorHandling(async (_event: ApiEvent): Promise<ApiResult> => {
  // Business context is loaded in parallel with the graph query; it fails closed
  // to `null`, in which case nodes fall back to raw ids / typed labels.
  const [context, load] = await Promise.all([loadBusinessContext(), loadGraph()]);

  if (load.status !== 'ok') {
    return jsonResponse(unavailableGraph(load.reason));
  }

  const response = buildGraphResponse(load.nodes, load.edges, context);
  if (isEmptyGraph(response)) {
    // The query succeeded but the graph has no data — the "no data available"
    // case, surfaced as a reason so the view shows a message (Requirement 7.7).
    return jsonResponse(unavailableGraph('empty'));
  }
  return jsonResponse(response);
});
