import type { GraphResponse } from '@devops-observatory/shared-types';

/**
 * Compact, bounded textual summary of the enriched topology graph for GraphRAG
 * (Task 29.4, Requirement 15.1) — the "graph" leg of the org chat's grounding.
 *
 * The org chat is grounded in three sources: the managed KB (via
 * AgenticRetrieve), the admin business context, and the Neptune topology. The KB
 * docs do not richly encode relationships, so this renders the graph's
 * structural facts (entity counts, cross-account links, and per-account
 * adjacency) as text that the chat handler injects as read-only reference
 * context. Pure and deterministic so it is unit-testable without Neptune.
 *
 * The output is HARD-BOUNDED to {@link MAX_TOPOLOGY_CHARS} so a large estate can
 * never blow the model context window — it truncates with an explicit marker.
 */

/** Upper bound on the injected topology-facts block (characters). */
export const MAX_TOPOLOGY_CHARS = 4000;
/** Max accounts enumerated with their adjacency before summarizing the rest. */
const MAX_ACCOUNTS_LISTED = 40;
/** Max neighbors listed per account. */
const MAX_NEIGHBORS_PER_ACCOUNT = 15;
/** Max cross-account links enumerated. */
const MAX_CROSS_ACCOUNT_LINKS = 40;

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…(topology truncated)`;
}

/**
 * Render a compact topology summary. Returns `''` for an empty/absent graph so
 * the caller can simply skip injection (graceful degradation, Requirement 15.4).
 */
export function summarizeTopology(
  graph: GraphResponse,
  opts: { lastSyncDate?: string; maxChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? MAX_TOPOLOGY_CHARS;
  if (graph.nodes.length === 0) return '';

  const labelOf = new Map<string, string>();
  const typeOf = new Map<string, string>();
  for (const n of graph.nodes) {
    labelOf.set(n.id, n.displayLabel || n.label || n.id);
    typeOf.set(n.id, n.type);
  }

  const lines: string[] = [];
  if (opts.lastSyncDate && opts.lastSyncDate !== 'unknown') {
    lines.push(`Topology as of ${opts.lastSyncDate} (UTC).`);
  }

  // 1) Entity counts by type.
  const typeCounts = new Map<string, number>();
  for (const n of graph.nodes) typeCounts.set(n.type, (typeCounts.get(n.type) ?? 0) + 1);
  lines.push(
    `Entity counts: ${[...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([t, c]) => `${t} ${c}`)
      .join(', ')}.`,
  );

  // 2) Relationship counts by edge type.
  const edgeCounts = new Map<string, number>();
  for (const e of graph.edges) edgeCounts.set(e.type, (edgeCounts.get(e.type) ?? 0) + 1);
  if (edgeCounts.size > 0) {
    lines.push(
      `Relationships: ${[...edgeCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `${t} ${c}`)
        .join(', ')}.`,
    );
  }

  // 3) Cross-account links (explicitly flagged by enrichment) — high signal.
  const cross = graph.edges.filter((e) => e.crossAccount);
  if (cross.length > 0) {
    lines.push(`Cross-account links (${cross.length}):`);
    for (const e of cross.slice(0, MAX_CROSS_ACCOUNT_LINKS)) {
      lines.push(`- ${labelOf.get(e.from) ?? e.from} ${e.type} ${labelOf.get(e.to) ?? e.to}`);
    }
    if (cross.length > MAX_CROSS_ACCOUNT_LINKS) {
      lines.push(`- …and ${cross.length - MAX_CROSS_ACCOUNT_LINKS} more`);
    }
  }

  // 4) Per-account adjacency (undirected) so relationship questions are grounded.
  const neighbors = new Map<string, Set<string>>();
  const addNeighbor = (a: string, b: string) => {
    if (!neighbors.has(a)) neighbors.set(a, new Set());
    neighbors.get(a)!.add(b);
  };
  for (const e of graph.edges) {
    addNeighbor(e.from, e.to);
    addNeighbor(e.to, e.from);
  }
  const accountIds = graph.nodes.filter((n) => n.type === 'Account').map((n) => n.id);
  if (accountIds.length > 0) {
    lines.push('Accounts and connected resources:');
    for (const id of accountIds.slice(0, MAX_ACCOUNTS_LISTED)) {
      const ns = [...(neighbors.get(id) ?? new Set<string>())];
      const shown = ns
        .slice(0, MAX_NEIGHBORS_PER_ACCOUNT)
        .map((nid) => `${labelOf.get(nid) ?? nid} (${typeOf.get(nid) ?? '?'})`);
      const extra = ns.length > MAX_NEIGHBORS_PER_ACCOUNT ? `, …+${ns.length - MAX_NEIGHBORS_PER_ACCOUNT}` : '';
      lines.push(`- ${labelOf.get(id) ?? id}: ${shown.join(', ')}${extra}`);
    }
    if (accountIds.length > MAX_ACCOUNTS_LISTED) {
      lines.push(`- …and ${accountIds.length - MAX_ACCOUNTS_LISTED} more accounts`);
    }
  }

  return truncate(lines.join('\n'), maxChars);
}
