import {
  ExecuteQueryCommand,
  NeptuneGraphClient,
} from '@aws-sdk/client-neptune-graph';
import type { GraphUnavailableReason } from '@devops-observatory/shared-types';
import { getGraphConfig } from './config';
import type { RawGraphNode, RawGraphEdge } from './graphEnrichment';

/**
 * Reads the hub topology graph for `GET /graph` (Task 8).
 *
 * The handler runs two openCypher queries via Neptune Analytics
 * `neptune-graph:ExecuteQuery` — one projecting every node, one projecting every
 * relationship — and shapes the raw rows into {@link RawGraphNode} /
 * {@link RawGraphEdge} for the pure enrichment core in {@link ./graphEnrichment}.
 *
 * Like the S3 loaders in {@link ./hubData}, this FAILS CLOSED: a missing graph,
 * an access/connection error, or a query error resolves to an "unavailable"
 * result carrying a reason category rather than throwing, so the handler can
 * return an explicit unavailable-graph response instead of a blank canvas
 * (Requirement 7.7).
 */

/** openCypher projection of every node: id, labels, and the full property map. */
const NODE_QUERY =
  'MATCH (n) RETURN id(n) AS id, labels(n) AS labels, properties(n) AS properties';

/** openCypher projection of every relationship: endpoints + type. */
const EDGE_QUERY =
  'MATCH (a)-[r]->(b) RETURN id(a) AS source, id(b) AS target, type(r) AS type';

/** Result of attempting to read the topology graph. */
export type GraphLoad =
  | { status: 'ok'; nodes: RawGraphNode[]; edges: RawGraphEdge[] }
  | { status: 'unavailable'; reason: GraphUnavailableReason };

let cachedClient: NeptuneGraphClient | undefined;

/** Lazily construct a single Neptune Analytics client per warm container. */
function client(): NeptuneGraphClient {
  if (!cachedClient) {
    cachedClient = new NeptuneGraphClient({ region: getGraphConfig().region });
  }
  return cachedClient;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Extract the `results` row array from a Neptune openCypher JSON payload. The
 * ExecuteQuery payload is a JSON document of the form `{ "results": [ … ] }`;
 * anything else (or invalid JSON) yields an empty row list.
 */
function parseResultRows(payload: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) return [];
  return parsed.results.filter(isRecord);
}

/** Coerce a value into an array of graph labels (non-empty strings only). */
function toLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((label): label is string => typeof label === 'string' && label.length > 0);
}

/**
 * Shape node rows from {@link NODE_QUERY} into {@link RawGraphNode}s. Rows
 * without a usable string id are skipped; missing labels/properties default to
 * empty so the enrichment core can still derive a typed fallback label.
 */
export function parseNodeResults(payload: string): RawGraphNode[] {
  const nodes: RawGraphNode[] = [];
  for (const row of parseResultRows(payload)) {
    const id = row.id;
    if (typeof id !== 'string' || id.length === 0) continue;
    nodes.push({
      id,
      labels: toLabels(row.labels),
      properties: isRecord(row.properties) ? row.properties : {},
    });
  }
  return nodes;
}

/**
 * Shape edge rows from {@link EDGE_QUERY} into {@link RawGraphEdge}s. Rows
 * missing an endpoint or type are skipped so a malformed row never produces a
 * dangling edge.
 */
export function parseEdgeResults(payload: string): RawGraphEdge[] {
  const edges: RawGraphEdge[] = [];
  for (const row of parseResultRows(payload)) {
    const from = row.source;
    const to = row.target;
    const type = row.type;
    if (
      typeof from !== 'string' ||
      from.length === 0 ||
      typeof to !== 'string' ||
      to.length === 0 ||
      typeof type !== 'string' ||
      type.length === 0
    ) {
      continue;
    }
    edges.push({ from, to, type });
  }
  return edges;
}

/**
 * Map a thrown error to an unavailable reason category. A missing/unresolvable
 * graph or an access failure is a load problem (`graph_unavailable`); a rejected
 * or unprocessable query is a `query_failed`. Anything else is treated as a
 * load failure so the view still shows a reason (Requirement 7.7).
 */
function reasonForError(err: unknown): GraphUnavailableReason {
  const name = err instanceof Error ? err.name : '';
  if (
    name === 'ValidationException' ||
    name === 'UnprocessableException' ||
    name === 'ConflictException'
  ) {
    return 'query_failed';
  }
  return 'graph_unavailable';
}

/** Run one openCypher query and return the payload as a UTF-8 string. */
async function executeQuery(queryString: string): Promise<string> {
  const { graphIdentifier } = getGraphConfig();
  const res = await client().send(
    new ExecuteQueryCommand({ graphIdentifier, queryString, language: 'OPEN_CYPHER' }),
  );
  return (await res.payload.transformToString('utf-8')) ?? '';
}

/**
 * Load the full topology graph (all nodes + relationships) from Neptune
 * Analytics. Fails closed to an `{ status: 'unavailable', reason }` result on
 * any client/query error so `GET /graph` can render an explanatory message
 * rather than a blank canvas (Requirement 7.7).
 */
export async function loadGraph(): Promise<GraphLoad> {
  try {
    const [nodePayload, edgePayload] = await Promise.all([
      executeQuery(NODE_QUERY),
      executeQuery(EDGE_QUERY),
    ]);
    return {
      status: 'ok',
      nodes: parseNodeResults(nodePayload),
      edges: parseEdgeResults(edgePayload),
    };
  } catch (err) {
    return { status: 'unavailable', reason: reasonForError(err) };
  }
}
