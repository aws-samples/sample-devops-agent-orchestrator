import type {
  BusinessContext,
  ChatCitation,
  GraphResponse,
} from '@devops-observatory/shared-types';

/**
 * Pure core for the Enterprise DevOps Observatory (EDO) MCP tools (Task 29,
 * Requirement 15 — snapshot plane, read-only).
 *
 * These are the tools an AgentCore Gateway exposes as an MCP server so an agent
 * (the future org-wide executive agent, or any MCP client) can ground answers
 * in EDO's aggregated snapshot WITHOUT touching AWS credentials directly:
 *   - `search_kb`             — grounded answer + citations from the managed KB.
 *   - `query_topology_graph`  — the enriched Neptune topology (optionally filtered).
 *   - `get_business_context`  — the admin-authored business context (BUs,
 *                               display names, Account_Context, target SLA).
 *
 * All three are READ-ONLY. This module is deterministic and dependency-injected
 * (no AWS SDK imports) so the dispatch + shaping logic is unit-testable; the
 * Lambda handler wires the real implementations (KB retrieve, Neptune query, S3
 * read) as {@link ToolDeps}.
 */

/**
 * AgentCore prefixes the visible tool name with the gateway target name using
 * this delimiter (`${target}___${tool}`), so the handler strips it to recover
 * the bare tool name.
 */
export const TOOL_NAME_DELIMITER = '___';

/** The bare tool names this target exposes. */
export const TOOL_NAMES = {
  searchKb: 'search_kb',
  queryTopologyGraph: 'query_topology_graph',
  getBusinessContext: 'get_business_context',
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/**
 * MCP tool definitions (name + description + JSON-schema input), used both as
 * documentation here and as the AgentCore Gateway target's inline tool schema
 * in `amplify/mcp/resource.ts`, so the wire contract has a single source.
 */
export const TOOL_SCHEMAS = [
  {
    name: TOOL_NAMES.searchKb,
    description:
      'Search the DevOps knowledge base and return a concise answer grounded in the ' +
      'collected topology, investigations, and business context, with cited sources. ' +
      'Use for "what/why/how" questions about the AWS estate.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The natural-language question to answer from the knowledge base.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: TOOL_NAMES.queryTopologyGraph,
    description:
      'Return the enriched cross-account topology graph (accounts, agent spaces, ' +
      'investigations, recommendations, services and their relationships). Optionally ' +
      'filter to nodes matching a search term. Use for structural/relationship questions ' +
      '(what connects to what, cross-account blast radius).',
    inputSchema: {
      type: 'object',
      properties: {
        search: {
          type: 'string',
          description:
            'Optional case-insensitive term to filter nodes by label, type, or business unit.',
        },
      },
    },
  },
  {
    name: TOOL_NAMES.getBusinessContext,
    description:
      'Return the administrator-authored business context: business-unit groupings, ' +
      'account display names, per-account free-text context, and any recorded target ' +
      'SLA/SLO. Use to translate raw account ids into business terms.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
] as const;

/**
 * Recover the bare tool name from the gateway's prefixed name
 * (`${target}___${tool}`). Returns the input unchanged when the delimiter is
 * absent (e.g. a direct/test invocation using the bare name).
 */
export function parseToolName(raw: string | undefined): string {
  if (!raw) return '';
  const idx = raw.indexOf(TOOL_NAME_DELIMITER);
  return idx === -1 ? raw : raw.slice(idx + TOOL_NAME_DELIMITER.length);
}

/** Injectable implementations of the three tools (wired in the handler). */
export interface ToolDeps {
  searchKb(query: string): Promise<{ answer: string; citations: ChatCitation[] }>;
  getTopologyGraph(): Promise<GraphResponse>;
  getBusinessContext(): Promise<BusinessContext | null>;
}

/** Raised for an unknown tool name so the handler can shape a clean error. */
export class UnknownToolError extends Error {
  constructor(toolName: string) {
    super(`Unknown tool: ${toolName || '(empty)'}`);
    this.name = 'UnknownToolError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Filter an enriched graph to nodes matching a case-insensitive term (by
 * display label, raw label, type, or business unit), keeping only edges whose
 * endpoints both survive. A blank term returns the graph unchanged. Pure so it
 * can be unit-tested independently of Neptune.
 */
export function filterGraphBySearch(graph: GraphResponse, search: string | undefined): GraphResponse {
  const q = (search ?? '').trim().toLowerCase();
  if (q.length === 0) return graph;
  const nodes = graph.nodes.filter((n) =>
    [n.displayLabel, n.label, n.type, n.businessUnit].some(
      (v) => typeof v === 'string' && v.toLowerCase().includes(q),
    ),
  );
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  return {
    nodes,
    edges,
    ...(graph.unavailableReason ? { unavailableReason: graph.unavailableReason } : {}),
  };
}

/**
 * Dispatch an MCP tool call to its implementation and return a JSON-serializable
 * result. `toolName` may be the gateway-prefixed name (it is normalized here).
 * Arguments are read defensively from `args` since they arrive from an external
 * MCP client. Throws {@link UnknownToolError} for an unrecognized tool.
 */
export async function runTool(
  toolName: string,
  args: unknown,
  deps: ToolDeps,
): Promise<unknown> {
  const name = parseToolName(toolName);
  const input = isRecord(args) ? args : {};

  switch (name) {
    case TOOL_NAMES.searchKb: {
      const query = typeof input.query === 'string' ? input.query.trim() : '';
      if (query.length === 0) {
        return { error: 'The "query" argument is required and must be a non-empty string.' };
      }
      return deps.searchKb(query);
    }
    case TOOL_NAMES.queryTopologyGraph: {
      const search = typeof input.search === 'string' ? input.search : undefined;
      const graph = await deps.getTopologyGraph();
      return filterGraphBySearch(graph, search);
    }
    case TOOL_NAMES.getBusinessContext: {
      const context = await deps.getBusinessContext();
      return context ?? { message: 'No business context has been configured yet.' };
    }
    default:
      throw new UnknownToolError(name);
  }
}
