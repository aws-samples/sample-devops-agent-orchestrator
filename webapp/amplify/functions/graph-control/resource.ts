import { defineFunction } from '@aws-amplify/backend';

/**
 * Graph control route (`GET /graph/control` any, `POST /graph/control` Admin).
 *
 * Starts/stops the Neptune Analytics topology graph and reports its status +
 * timing metrics for the Admin Settings view. Served over the JWT-authorized
 * HTTP API; the POST path re-asserts the Admin group in-handler. Own execution
 * role; least-privilege `neptune-graph` + S3 access is granted in `backend.ts`.
 *
 * Neptune Analytics has no pause/resume — stop deletes the graph (with a final
 * snapshot) and start recreates it (see `../shared/graphControl.ts`) — so the
 * timeout is generous enough for the ListGraphs/GetGraph/snapshot lookups the
 * status call makes, while the create/delete calls themselves return quickly.
 */
export const graphControl = defineFunction({
  name: 'graph-control',
  entry: './handler.ts',
  timeoutSeconds: 30,
});
