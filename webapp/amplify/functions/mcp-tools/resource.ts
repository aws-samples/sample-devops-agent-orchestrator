import { defineFunction } from '@aws-amplify/backend';

/**
 * EDO MCP tools Lambda — the AgentCore Gateway Lambda target (Task 29,
 * Requirement 15, snapshot plane).
 *
 * Exposes three read-only tools (`search_kb`, `query_topology_graph`,
 * `get_business_context`) that the gateway aggregates into an MCP server. Its
 * own least-privilege execution role (Bedrock KB agentic retrieve + model
 * invoke, read-only Neptune Analytics query, and S3 read of the business
 * context / manifest) is granted in `backend.ts`, mirroring the `chat` and
 * `graph` handlers it reuses. Timeout sits just above the 27s KB answer cap.
 */
export const mcpTools = defineFunction({
  name: 'mcp-tools',
  entry: './handler.ts',
  timeoutSeconds: 29,
});
