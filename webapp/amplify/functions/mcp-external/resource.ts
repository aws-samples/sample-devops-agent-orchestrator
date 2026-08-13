import { defineFunction } from '@aws-amplify/backend';

/**
 * EXTERNAL MCP tools Lambda — the CUSTOM_JWT AgentCore Gateway's target
 * (Task 39, Requirement 16).
 *
 * A separate function from the internal `mcp-tools` target so the Admin
 * enable/disable flag enforced here cannot affect the internal gateway or the
 * webapp chat, and so the timeout can cover the ~2-minute A2A relay
 * (`ask_agent_space`). Exposes the three read-only snapshot tools plus
 * `ask_devops_observatory`, `list_agent_spaces`, and `ask_agent_space`.
 * Least-privilege grants (KB retrieve + model invoke, read-only Neptune, S3
 * manifest/context/settings read, A2A secret read) are in `backend.ts`.
 */
export const mcpExternal = defineFunction({
  name: 'mcp-external',
  entry: './handler.ts',
  // ask_agent_space relays an A2A chat that can take ~120s; the AgentCore
  // Gateway invocation timeout (15 min) is not the binding constraint.
  timeoutSeconds: 150,
  memoryMB: 512,
});
