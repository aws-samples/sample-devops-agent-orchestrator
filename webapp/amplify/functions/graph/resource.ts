import { defineFunction } from '@aws-amplify/backend';

/**
 * `GET /graph` handler (Task 8).
 * Own least-privilege execution role: read-only Neptune Analytics query
 * (`neptune-graph:ReadDataViaQuery` via `ExecuteQuery`) on the graph ARN plus
 * S3 read on `hub/business_context.json` for the query-time label overlay —
 * wired in `backend.ts`.
 */
export const graph = defineFunction({
  name: 'graph',
  entry: './handler.ts',
});
