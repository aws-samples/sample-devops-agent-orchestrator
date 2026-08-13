import type { GraphEdge, GraphNode } from '@devops-observatory/shared-types';

/**
 * Pure helpers for the reactive graph filter sidebar (Task 40).
 *
 * Each filter dimension extracts unique values from the graph response at load
 * time. The active filter state is a set of CHECKED values per dimension;
 * unchecked values are HIDDEN. A node is visible when its value for every
 * dimension is checked (a blank value = the dimension doesn't apply to that
 * node, so it always passes). Edges survive only when both endpoints are visible.
 */

/** The filterable dimensions (dimension key → how to read the value from a node). */
export type FilterDimension = 'businessUnit' | 'account' | 'type' | 'space';

/** Edge filter dimension — filter by edge/relationship type. */
export type EdgeFilterDimension = 'edgeType';

/** Read the filter-relevant value from a node for a given dimension. */
export function dimensionValue(node: GraphNode, dim: FilterDimension): string {
  switch (dim) {
    case 'businessUnit':
      return node.businessUnit ?? '';
    case 'type':
      return node.type;
    case 'account': {
      // Only Account nodes populate this dimension (so the filter lists accounts,
      // not every node that happens to have an accountId in metadata).
      if (node.type === 'Account') return node.displayLabel || node.id;
      // Child nodes belong to an account via their metadata — used for
      // filtering (hide an account = hide its children too).
      const meta = node.metadata as Record<string, unknown> | undefined;
      const v = meta?.accountId ?? meta?.account;
      return typeof v === 'string' ? v : '';
    }
    case 'space': {
      // Only AgentSpace nodes populate this dimension's value list. The
      // displayLabel is the human-friendly space name (not the UUID).
      if (node.type === 'AgentSpace') return node.displayLabel || '';
      // Child nodes (Asset, Investigation, etc.) belong to a space — read the
      // parent space name so filtering a space hides its children too.
      const meta = node.metadata as Record<string, unknown> | undefined;
      const v = meta?.spaceName ?? meta?.space;
      return typeof v === 'string' ? v : '';
    }
  }
}

/**
 * Extract sorted unique non-empty values for a dimension from graph nodes.
 *
 * For the `account` and `space` dimensions, values are derived ONLY from nodes
 * of the matching type (Account / AgentSpace) — so the filter list shows account
 * ids and space names, not every child node that happens to carry the field.
 * Child nodes still resolve to their parent's value via {@link dimensionValue}
 * so they are hidden when their parent is unchecked.
 */
export function uniqueDimensionValues(nodes: GraphNode[], dim: FilterDimension): string[] {
  const set = new Set<string>();
  for (const node of nodes) {
    // For account/space: only the "header" node type contributes unique values.
    if (dim === 'account' && node.type !== 'Account') continue;
    if (dim === 'space' && node.type !== 'AgentSpace') continue;
    const v = dimensionValue(node, dim);
    if (v) set.add(v);
  }
  return [...set].sort();
}

/** Filter state: the checked (visible) values per dimension. */
export type FilterState = Record<FilterDimension, Set<string>> & Record<EdgeFilterDimension, Set<string>>;

/** Extract sorted unique edge types from all graph edges. */
export function uniqueEdgeTypes(edges: GraphEdge[]): string[] {
  const set = new Set<string>();
  for (const edge of edges) {
    if (edge.type) set.add(edge.type);
  }
  return [...set].sort();
}

/** Build the initial filter state: all values checked (everything visible). */
export function initialFilterState(nodes: GraphNode[], edges: GraphEdge[]): FilterState {
  return {
    businessUnit: new Set(uniqueDimensionValues(nodes, 'businessUnit')),
    account: new Set(uniqueDimensionValues(nodes, 'account')),
    type: new Set(uniqueDimensionValues(nodes, 'type')),
    space: new Set(uniqueDimensionValues(nodes, 'space')),
    edgeType: new Set(uniqueEdgeTypes(edges)),
  };
}

/** True when a node passes all active filters (visible on the graph). */
export function nodePassesFilter(node: GraphNode, state: FilterState): boolean {
  for (const dim of Object.keys(state) as FilterDimension[]) {
    const checked = state[dim];
    if (checked.size === 0) continue; // dimension has no values → no constraint
    const val = dimensionValue(node, dim);
    if (!val) continue; // dimension not relevant to this node → passes
    if (!checked.has(val)) return false;
  }
  return true;
}

/** Compute the set of visible node ids + visible edge count. */
export function computeVisibility(
  nodes: GraphNode[],
  edges: GraphEdge[],
  state: FilterState,
): { visibleNodeIds: Set<string>; visibleEdgeCount: number } {
  const visibleNodeIds = new Set<string>();
  for (const node of nodes) {
    if (nodePassesFilter(node, state)) visibleNodeIds.add(node.id);
  }
  const checkedEdgeTypes = state.edgeType;
  let visibleEdgeCount = 0;
  for (const edge of edges) {
    const endpointsVisible = visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to);
    const typeVisible = checkedEdgeTypes.size === 0 || checkedEdgeTypes.has(edge.type);
    if (endpointsVisible && typeVisible) visibleEdgeCount++;
  }
  return { visibleNodeIds, visibleEdgeCount };
}

/** Check if a specific edge is visible given the current filter state + visible nodes. */
export function edgeIsVisible(
  edge: GraphEdge,
  visibleNodeIds: Set<string>,
  state: FilterState,
): boolean {
  const endpointsVisible = visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to);
  const checkedEdgeTypes = state.edgeType;
  const typeVisible = checkedEdgeTypes.size === 0 || checkedEdgeTypes.has(edge.type);
  return endpointsVisible && typeVisible;
}

/** Human-friendly labels for the dimensions (used as sidebar headings). */
export const DIMENSION_LABELS: Record<FilterDimension | EdgeFilterDimension, string> = {
  businessUnit: 'Business Unit',
  account: 'Account',
  type: 'Node Type',
  space: 'Agent Space',
  edgeType: 'Edge Type',
};

/** Ordered dimensions for the sidebar. */
export const FILTER_DIMENSIONS: readonly FilterDimension[] = [
  'businessUnit',
  'account',
  'type',
  'space',
];
