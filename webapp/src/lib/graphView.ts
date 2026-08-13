import type {
  GraphEdge,
  GraphNode,
  GraphNodeType,
  GraphResponse,
  GraphUnavailableReason,
} from '@devops-observatory/shared-types';

/**
 * Pure, DOM-free presentation helpers for the Graph_View (Task 14).
 *
 * Kept separate from the React component (which owns the vis-network canvas) so
 * the per-type indicator registry, fallback-label derivation, cross-account edge
 * styling, node metadata flattening, and unavailable-graph messaging can be
 * unit-tested with the repo's `node:test` + tsx convention and reused without
 * pulling in the DOM or the vis-network library.
 *
 * Requirements: 7.2 (per-type indicator + legend covering every node type),
 * 7.3/7.4 (human-friendly label, typed fallback — never the raw UUID alone),
 * 7.5 (business-meaningful metadata for the node-select panel), 7.6 (visually
 * distinct cross-account edges), 7.7 (unavailable-graph message with reason
 * category — never a blank view), 11.2 (enriched labels everywhere).
 */

// ---------------------------------------------------------------------------
// Per-type node indicators + legend (Requirement 7.2)
// ---------------------------------------------------------------------------

/** A visual indicator (color + shape) plus a human label for one node type. */
export interface NodeTypeStyle {
  /** Business-oriented label shown in the legend for this node type. */
  label: string;
  /** Distinct fill color for the node/legend swatch. */
  color: string;
  /** vis-network node shape, chosen to be distinct per type. */
  shape: 'dot' | 'box' | 'diamond' | 'triangle' | 'star' | 'hexagon' | 'square' | 'ellipse';
}

/**
 * The indicator registry: every {@link GraphNodeType} maps to a visually
 * distinct color + shape (Requirement 7.2). The legend is derived directly from
 * this registry so it always covers exactly the supported node types.
 */
export const NODE_TYPE_STYLES: Readonly<Record<GraphNodeType, NodeTypeStyle>> = {
  Account: { label: 'Account', color: '#175cd3', shape: 'box' },
  AgentSpace: { label: 'Agent space', color: '#7839ee', shape: 'hexagon' },
  Association: { label: 'Association', color: '#0086c9', shape: 'dot' },
  ExternalTarget: { label: 'External target', color: '#dd2590', shape: 'triangle' },
  Investigation: { label: 'Investigation', color: '#e04f16', shape: 'diamond' },
  Recommendation: { label: 'Recommendation', color: '#099250', shape: 'star' },
  Asset: { label: 'Asset', color: '#475467', shape: 'square' },
  AwsService: { label: 'AWS service', color: '#dc6803', shape: 'ellipse' },
};

/** All supported node types, in a stable display order (drives the legend). */
export const GRAPH_NODE_TYPES: readonly GraphNodeType[] = [
  'Account',
  'AgentSpace',
  'Association',
  'ExternalTarget',
  'Investigation',
  'Recommendation',
  'Asset',
  'AwsService',
];

/** A single legend row: a node type mapped to its visual indicator. */
export interface LegendEntry {
  type: GraphNodeType;
  label: string;
  color: string;
  shape: NodeTypeStyle['shape'];
}

/** The indicator used when a node's type is not one of the known types. */
const UNKNOWN_TYPE_STYLE: NodeTypeStyle = { label: 'Other', color: '#98a2b3', shape: 'dot' };

/** Resolve the visual indicator for a node type, falling back for unknown types. */
export function nodeTypeStyle(type: string): NodeTypeStyle {
  return NODE_TYPE_STYLES[type as GraphNodeType] ?? UNKNOWN_TYPE_STYLE;
}

/**
 * The legend rows, one per supported node type, mapping each indicator to its
 * type (Requirement 7.2). Order matches {@link GRAPH_NODE_TYPES}.
 */
export function legendEntries(): LegendEntry[] {
  return GRAPH_NODE_TYPES.map((type) => {
    const style = NODE_TYPE_STYLES[type];
    return { type, label: style.label, color: style.color, shape: style.shape };
  });
}

// ---------------------------------------------------------------------------
// Node labels (Requirements 7.3, 7.4, 11.2)
// ---------------------------------------------------------------------------

/** Coerce a value to a trimmed non-empty string, or `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Typed fallback label `"<Type> …<last 8 of id>"` (Requirement 7.4, design). The
 * raw entity id is the segment after the final `:` in a prefixed graph id (e.g.
 * `acct:345678901234` → `…45678901234` last-8 → `Account …78901234`). Never the
 * bare UUID alone.
 */
export function fallbackNodeLabel(type: string, id: string): string {
  const segments = String(id).split(':');
  const raw = segments[segments.length - 1] ?? String(id);
  return `${type} …${raw.slice(-8)}`;
}

/**
 * The label to show for a node (Requirements 7.3, 7.4). Prefers the backend's
 * enriched `displayLabel`; if that is missing/blank it falls back to the raw
 * `label` when it is human-friendly (i.e. not just the id), and otherwise to the
 * typed fallback — so a node is never rendered as its raw UUID alone.
 */
export function resolveNodeLabel(node: GraphNode): string {
  const display = nonEmptyString(node.displayLabel);
  if (display) return display;
  const raw = nonEmptyString(node.label);
  if (raw && raw !== node.id) return raw;
  return fallbackNodeLabel(node.type, node.id);
}

// ---------------------------------------------------------------------------
// vis-network node/edge shaping
// ---------------------------------------------------------------------------

/** Minimal shape of a vis-network node (kept local to stay DOM/library-free). */
export interface VisNode {
  id: string;
  label: string;
  title: string;
  group: string;
  shape: NodeTypeStyle['shape'];
  color: { background: string; border: string; highlight: { background: string; border: string } };
}

/** Minimal shape of a vis-network edge. */
export interface VisEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  title: string;
  color: { color: string; opacity: number };
  width: number;
  dashes: boolean;
  arrows: string;
}

/** Color used to make cross-account edges visually distinct (Requirement 7.6). */
export const CROSS_ACCOUNT_EDGE_COLOR = '#d92d20';
/** Color used for same-account / regular edges. */
export const SAME_ACCOUNT_EDGE_COLOR = '#98a2b3';

/**
 * Build the vis-network node objects from the enriched graph nodes. Each node
 * carries its human-friendly label (Requirement 7.3/7.4) and its per-type
 * indicator (color + shape, Requirement 7.2); `group` is the node type so the
 * legend and canvas share one classification.
 */
export function buildVisNodes(nodes: GraphNode[]): VisNode[] {
  return nodes.map((node) => {
    const style = nodeTypeStyle(node.type);
    const label = resolveNodeLabel(node);
    return {
      id: node.id,
      label,
      title: `${style.label}: ${label}`,
      group: node.type,
      shape: style.shape,
      color: {
        background: style.color,
        border: style.color,
        highlight: { background: '#fbbf24', border: '#92400e' },
      },
    };
  });
}

/** True for a cross-account edge (Requirement 7.6). */
export function isCrossAccountEdge(edge: GraphEdge): boolean {
  return edge.crossAccount === true;
}

/**
 * Build the vis-network edge objects, styling cross-account `TARGETS_ACCOUNT`
 * links so they are visually distinct from same-account edges: a distinct red,
 * thicker, dashed line (Requirement 7.6). Same-account edges use a neutral,
 * thin, solid line.
 */
export function buildVisEdges(edges: GraphEdge[]): VisEdge[] {
  return edges.map((edge, index) => {
    const crossAccount = isCrossAccountEdge(edge);
    return {
      id: `${edge.from}->${edge.to}:${edge.type}:${index}`,
      from: edge.from,
      to: edge.to,
      label: crossAccount ? 'cross-account' : undefined,
      title: crossAccount ? `${edge.type} (cross-account)` : edge.type,
      color: crossAccount
        ? { color: CROSS_ACCOUNT_EDGE_COLOR, opacity: 0.8 }
        : { color: SAME_ACCOUNT_EDGE_COLOR, opacity: 0.5 },
      width: crossAccount ? 3 : 1,
      dashes: crossAccount,
      arrows: 'to',
    };
  });
}

// ---------------------------------------------------------------------------
// Node metadata panel (Requirement 7.5)
// ---------------------------------------------------------------------------

/** A single labelled metadata row for the node-select panel. */
export interface MetadataEntry {
  label: string;
  value: string;
}

/** Humanize a camelCase / snake_case metadata key into a Start Case label. */
function humanizeKey(key: string): string {
  const spaced = key
    .replace(/[_\-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
  if (spaced.length === 0) return key;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Render a metadata value as a compact display string, or `undefined` to skip. */
function formatMetadataValue(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return nonEmptyString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) {
    const parts = value
      .map((v) => formatMetadataValue(v))
      .filter((v): v is string => v !== undefined);
    return parts.length > 0 ? parts.join(', ') : undefined;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json && json !== '{}' ? json : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The ordered metadata rows to show when a node is selected (Requirement 7.5).
 * Always leads with the human-friendly label and node type, then the
 * Business_Unit (when present), followed by every business-meaningful metadata
 * field the node carries — skipping empty values and the raw id/label fields
 * that would otherwise duplicate the header.
 */
export function nodeMetadataEntries(node: GraphNode): MetadataEntry[] {
  const entries: MetadataEntry[] = [
    { label: 'Name', value: resolveNodeLabel(node) },
    { label: 'Type', value: nodeTypeStyle(node.type).label },
  ];

  const businessUnit = nonEmptyString(node.businessUnit);
  if (businessUnit) {
    entries.push({ label: 'Business unit', value: businessUnit });
  }

  const metadata = node.metadata ?? {};
  // Keys that duplicate the header/label or are internal ids — not shown.
  const skip = new Set(['displayLabel', 'businessUnit', 'id', 'label']);
  for (const key of Object.keys(metadata)) {
    if (skip.has(key)) continue;
    const value = formatMetadataValue(metadata[key]);
    if (value === undefined) continue;
    entries.push({ label: humanizeKey(key), value });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Unavailable-graph messaging (Requirement 7.7)
// ---------------------------------------------------------------------------

/** Broad category of why the graph is unavailable, driving the message tone. */
export type GraphUnavailableCategory = 'no-data' | 'load-failure';

/** A resolved unavailable-graph message with its category (Requirement 7.7). */
export interface GraphUnavailableMessage {
  category: GraphUnavailableCategory;
  title: string;
  detail: string;
}

/**
 * True when a graph response cannot be rendered as a graph: either the backend
 * flagged an `unavailableReason`, or it returned no nodes. The view must show a
 * message in this case and never leave the canvas blank (Requirement 7.7).
 */
export function isGraphUnavailable(response: GraphResponse): boolean {
  return response.unavailableReason !== undefined || response.nodes.length === 0;
}

/**
 * Map a graph response to an unavailable-graph message + reason category
 * (Requirement 7.7). `empty` (or a graph with no nodes and no explicit reason)
 * is the "no data available" case; `graph_unavailable` / `query_failed` are
 * load failures. Returns `null` when the graph is renderable.
 */
export function graphUnavailableMessage(
  response: GraphResponse,
): GraphUnavailableMessage | null {
  if (!isGraphUnavailable(response)) return null;
  const reason: GraphUnavailableReason = response.unavailableReason ?? 'empty';
  return unavailableMessageForReason(reason);
}

/** Resolve the message + category for a specific unavailable reason. */
export function unavailableMessageForReason(
  reason: GraphUnavailableReason,
): GraphUnavailableMessage {
  switch (reason) {
    case 'empty':
      return {
        category: 'no-data',
        title: 'No graph data available',
        detail:
          'The topology graph has no data yet. Load hub data with a refresh to populate it.',
      };
    case 'graph_unavailable':
      return {
        category: 'load-failure',
        title: 'Graph cannot be displayed',
        detail:
          'The topology graph could not be loaded (the graph store is unavailable). Please try again later.',
      };
    case 'query_failed':
      return {
        category: 'load-failure',
        title: 'Graph cannot be displayed',
        detail:
          'The topology graph could not be loaded because the graph query failed. Please try again later.',
      };
    default:
      return {
        category: 'load-failure',
        title: 'Graph cannot be displayed',
        detail: 'The topology graph could not be loaded. Please try again later.',
      };
  }
}
