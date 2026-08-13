import type { Context } from 'aws-lambda';
import type { GraphResponse } from '@devops-observatory/shared-types';
import { answerChatOnce, buildMessages } from '../shared/bedrockChat';
import { buildGraphResponse, unavailableGraph } from '../shared/graphEnrichment';
import { loadBusinessContext } from '../shared/hubData';
import { loadGraph } from '../shared/neptuneGraph';
import { runTool, UnknownToolError, type ToolDeps } from './mcpTools';

/**
 * AgentCore Gateway Lambda target for the EDO MCP tools (Task 29, Requirement
 * 15 — snapshot plane, read-only).
 *
 * The gateway invokes this Lambda once per tool call: the `event` is the tool's
 * input arguments (a map of the tool's `inputSchema` properties), and the tool
 * name arrives in the client context as
 * `context.clientContext.custom.bedrockAgentCoreToolName` in the form
 * `${targetName}___${toolName}`. The bare tool name is recovered and dispatched
 * to the shared read-only logic (KB retrieve, Neptune topology, business
 * context). The return value is the tool result, which the gateway wraps into
 * the MCP tool-call response.
 *
 * The tool implementations reuse the exact same shared modules as the `POST
 * /chat` and `GET /graph` handlers, so behavior and least-privilege stay
 * consistent. All three tools are read-only; there is no action-triggering here.
 */

/** Real implementations of the tools, reusing the shared read/query modules. */
const deps: ToolDeps = {
  async searchKb(query: string) {
    return answerChatOnce(buildMessages(query, []), { timeoutMs: 27_000 });
  },
  async getTopologyGraph(): Promise<GraphResponse> {
    const [context, load] = await Promise.all([loadBusinessContext(), loadGraph()]);
    if (load.status !== 'ok') {
      return unavailableGraph(load.reason);
    }
    return buildGraphResponse(load.nodes, load.edges, context);
  },
  async getBusinessContext() {
    return loadBusinessContext();
  },
};

/** Read the gateway-provided tool name from the Lambda client context. */
function toolNameFromContext(context: Context): string {
  const custom = context.clientContext?.custom as Record<string, unknown> | undefined;
  const raw = custom?.bedrockAgentCoreToolName;
  return typeof raw === 'string' ? raw : '';
}

export const handler = async (event: unknown, context: Context): Promise<unknown> => {
  const toolName = toolNameFromContext(context);
  try {
    return await runTool(toolName, event, deps);
  } catch (err) {
    if (err instanceof UnknownToolError) {
      // Surface a clean, model-readable error rather than a 500 so the agent can
      // recover (e.g. pick a valid tool) instead of failing the whole turn.
      return { error: err.message };
    }
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[mcp-tools] tool execution failed:', detail, err);
    return { error: 'The tool could not be completed. Please try again.' };
  }
};
