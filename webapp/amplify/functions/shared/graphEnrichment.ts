import type {
  BusinessContext,
  GraphEdge,
  GraphNode,
  GraphNodeType,
  GraphResponse,
  GraphUnavailableReason,
} from '@devops-observatory/shared-types';
import { businessUnitForAccount } from './aggregation';

/**
 * Pure graph enrichment core for `GET /graph` (Task 8).
 *
 * Every function here is deterministic and side-effect free so it can be unit
 * tested in isolation. The handler runs the Neptune `ExecuteQuery` openCypher
 * over the hub graph, loads the latest `hub/business_context.json`, and delegates
 * all shaping to {@link buildGraphResponse}.
 *
 * The label rules mirror the transform-time enrichment in
 * `scripts/04_transform_to_graph.py` (`truncate` / `fallback_label` /
 * `display_label_for`) so a node's label is consistent whether it was baked in
 * at transform time or recomputed here at query time (Requirements 7.3, 9.1–9.8).
 * Recomputing at query time is what lets the latest business-context display
 * names / Business_Unit labels appear without a full graph reload (Requirement
 * 9.9): the newest `accountDisplayNames` / `businessUnits` overlay onto the
 * node's properties before the label is derived.
 */

/** Max length of a truncated free-text label — matches `LABEL_MAX` in the transform. */
export const LABEL_MAX = 120;

/** A single node as returned by the openCypher node query, pre-enrichment. */
export interface RawGraphNode {
  /** The graph node id (e.g. `acct:345678901234`). */
  id: string;
  /** The node's graph labels; the first is treated as its {@link GraphNodeType}. */
  labels: string[];
  /** Raw node properties from the graph (may include a baked `displayLabel`). */
  properties: Record<string, unknown>;
}

/** A single relationship as returned by the openCypher edge query, pre-enrichment. */
export interface RawGraphEdge {
  from: string;
  to: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Label helpers — ported from scripts/04_transform_to_graph.py
// ---------------------------------------------------------------------------

/** Coerce a value to a trimmed non-empty string, or `undefined` (Python truthiness). */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Trim free text to at most `limit` chars, appending an ellipsis when the
 * original was longer (Requirements 9.6, 9.7). The ellipsis counts toward the
 * limit so the result never exceeds `limit` characters. Mirrors `truncate`.
 */
export function truncate(text: unknown, limit = LABEL_MAX): string {
  const value = (typeof text === 'string' ? text : '').trim();
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1).trimEnd() + '…';
}

/**
 * Typed fallback label `"<Type> …<last 8 of id>"` (Requirement 9.8). `id` is the
 * prefixed graph id (e.g. `acct:345678901234`); the raw entity id is the segment
 * after the final `:`. Mirrors `fallback_label`.
 */
export function fallbackLabel(type: string, id: string): string {
  const segments = String(id).split(':');
  const raw = segments[segments.length - 1] ?? String(id);
  return `${type} …${raw.slice(-8)}`;
}

/**
 * Compute a node's human-friendly `displayLabel` from its type + properties,
 * falling back to a typed label when no friendly field is present
 * (Requirements 9.1–9.8). Mirrors `display_label_for`.
 */
export function displayLabelFor(
  type: string,
  props: Record<string, unknown>,
  id: string,
): string {
  let base: string | undefined;
  switch (type) {
    case 'Account':
      base = nonEmptyString(props.displayName) ?? nonEmptyString(props.name);
      break;
    case 'AgentSpace':
      base = nonEmptyString(props.name);
      break;
    case 'Asset': {
      const parts = [nonEmptyString(props.assetType), nonEmptyString(props.assetName)].filter(
        (p): p is string => p !== undefined,
      );
      base = parts.length > 0 ? parts.join(': ') : undefined;
      break;
    }
    case 'AwsService':
      base = nonEmptyString(props.name);
      break;
    case 'Investigation': {
      const summary = truncate(props.summary);
      base = summary.length > 0 ? summary : undefined;
      break;
    }
    case 'Recommendation': {
      const title = truncate(props.title);
      base = title.length > 0 ? title : undefined;
      break;
    }
    case 'ExternalTarget': {
      const kind = nonEmptyString(props.kind);
      const ref = nonEmptyString(props.ref);
      base = kind && ref ? `${kind}: ${ref}` : ref ?? kind;
      break;
    }
    default:
      base = undefined;
  }
  return base ?? fallbackLabel(type, id);
}

// ---------------------------------------------------------------------------
// Node / edge shaping
// ---------------------------------------------------------------------------

/** The first graph label, coerced to a {@link GraphNodeType} (unknown labels pass through). */
function nodeType(raw: RawGraphNode): GraphNodeType {
  const first = raw.labels.find((l) => typeof l === 'string' && l.length > 0);
  return (first ?? 'Account') as GraphNodeType;
}

/**
 * True when a node is an agent "memory" asset (`assetType` "memory" or
 * "memory_store"). These are by far the most numerous asset type and clutter
 * the executive topology graph without adding value, so they are filtered out
 * at query time (and skipped at transform time in `04_transform_to_graph.py`).
 */
export function isMemoryAsset(raw: RawGraphNode): boolean {
  if (nodeType(raw) !== 'Asset') return false;
  const assetType = nonEmptyString(raw.properties.assetType);
  return assetType !== undefined && assetType.toLowerCase().startsWith('memory');
}

/** The account id a node represents: its `accountId` property, else the id suffix. */
function accountIdForNode(raw: RawGraphNode): string {
  const explicit = nonEmptyString(raw.properties.accountId);
  if (explicit) return explicit;
  const segments = raw.id.split(':');
  return segments[segments.length - 1] ?? raw.id;
}

/**
 * Enrich one raw node: overlay the latest business context (Account display name
 * + Business_Unit), then derive its `displayLabel` from the merged properties so
 * the newest labels win over anything baked in at transform time (Requirement
 * 9.9). Metadata carries the business-meaningful properties for node selection
 * (Requirement 7.5), excluding the derived label to avoid duplication.
 */
export function enrichNode(raw: RawGraphNode, context: BusinessContext | null): GraphNode {
  const type = nodeType(raw);
  const props: Record<string, unknown> = { ...raw.properties };

  let businessUnit: string | undefined;
  if (type === 'Account') {
    const accountId = accountIdForNode(raw);
    const displayName = context?.accountDisplayNames[accountId];
    if (displayName && displayName.length > 0) props.displayName = displayName;
    businessUnit = businessUnitForAccount(accountId, context);
    if (businessUnit) props.businessUnit = businessUnit;
  } else {
    const existing = nonEmptyString(props.businessUnit);
    if (existing) businessUnit = existing;
  }

  const displayLabel = displayLabelFor(type, props, raw.id);

  // `label` is the raw label the query returned (the baked displayLabel), or the
  // id for legacy data with none. Metadata excludes the labels to avoid dup.
  const rawLabel = nonEmptyString(raw.properties.displayLabel) ?? raw.id;
  const metadata: Record<string, unknown> = { ...props };
  delete metadata.displayLabel;
  delete metadata.businessUnit;

  const node: GraphNode = { id: raw.id, type, displayLabel, label: rawLabel, metadata };
  if (businessUnit) node.businessUnit = businessUnit;
  return node;
}

/**
 * Resolve, for each Association node, the id of the Account that owns it, by
 * walking `Account -HAS_SPACE-> AgentSpace -HAS_ASSOCIATION-> Association`.
 * Used to decide whether a `TARGETS_ACCOUNT` edge crosses account boundaries.
 */
function ownerAccountByAssociation(edges: RawGraphEdge[]): Map<string, string> {
  const spaceByAssoc = new Map<string, string>(); // assocId -> spaceId
  const accountBySpace = new Map<string, string>(); // spaceId -> accountId
  for (const edge of edges) {
    if (edge.type === 'HAS_ASSOCIATION') spaceByAssoc.set(edge.to, edge.from);
    else if (edge.type === 'HAS_SPACE') accountBySpace.set(edge.to, edge.from);
  }
  const ownerByAssoc = new Map<string, string>();
  for (const [assoc, space] of spaceByAssoc) {
    const account = accountBySpace.get(space);
    if (account) ownerByAssoc.set(assoc, account);
  }
  return ownerByAssoc;
}

/**
 * Enrich edges and flag cross-account links. A `TARGETS_ACCOUNT` edge whose
 * owning account (of the source Association) differs from the target Account is
 * `crossAccount: true`; a same-account link is `crossAccount: false`. All other
 * edge types are `false` (Requirement 7.6).
 */
export function enrichEdges(edges: RawGraphEdge[]): GraphEdge[] {
  const ownerByAssoc = ownerAccountByAssociation(edges);
  return edges.map((edge) => {
    let crossAccount = false;
    if (edge.type === 'TARGETS_ACCOUNT') {
      const owner = ownerByAssoc.get(edge.from);
      crossAccount = owner !== undefined && owner !== edge.to;
    }
    return { from: edge.from, to: edge.to, type: edge.type, crossAccount };
  });
}

/**
 * Build the enriched `GET /graph` response from raw query results, overlaying
 * the latest business context onto the nodes (Requirement 9.9) and flagging
 * cross-account `TARGETS_ACCOUNT` edges (Requirement 7.6).
 */
export function buildGraphResponse(
  nodes: RawGraphNode[],
  edges: RawGraphEdge[],
  context: BusinessContext | null,
): GraphResponse {
  // Drop agent "memory" assets and any edges touching them, so the graph shown
  // to executives is not swamped by low-signal memory nodes (the graph may still
  // contain them until the next reload; this filters them at query time).
  const removed = new Set<string>();
  const keptNodes: RawGraphNode[] = [];
  for (const node of nodes) {
    if (isMemoryAsset(node)) removed.add(node.id);
    else keptNodes.push(node);
  }
  const keptEdges =
    removed.size === 0 ? edges : edges.filter((e) => !removed.has(e.from) && !removed.has(e.to));

  return {
    nodes: keptNodes.map((node) => enrichNode(node, context)),
    edges: enrichEdges(keptEdges),
  };
}

/**
 * Response when the graph cannot be shown: never a blank canvas — an empty
 * node/edge set plus the reason category so the Graph_View can explain why
 * (Requirement 7.7). `graph_unavailable` / `query_failed` are load failures;
 * `empty` means the graph loaded but has no data.
 */
export function unavailableGraph(reason: GraphUnavailableReason): GraphResponse {
  return { nodes: [], edges: [], unavailableReason: reason };
}

/** True when a built response contains no nodes (the "no data available" case). */
export function isEmptyGraph(response: GraphResponse): boolean {
  return response.nodes.length === 0;
}
