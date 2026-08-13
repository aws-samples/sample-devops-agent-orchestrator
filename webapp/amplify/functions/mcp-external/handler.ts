import type { Context } from 'aws-lambda';
import type { GraphResponse } from '@devops-observatory/shared-types';
import { getStoredToken, listConfiguredSpaceIds, sendChat } from '../shared/a2a';
import { resolveLastSyncDate } from '../shared/aggregation';
import { answerChatOnce, buildMessages, composeSystemPrompt } from '../shared/bedrockChat';
import { getSettings } from '../shared/chatHistory';
import { summarizeTopology } from '../shared/graphContext';
import { buildGraphResponse, unavailableGraph } from '../shared/graphEnrichment';
import { loadBusinessContext, loadManifest } from '../shared/hubData';
import { loadGraph } from '../shared/neptuneGraph';
import {
  runExternalTool,
  UnknownToolError,
  type ExternalAgentSpace,
  type ExternalToolDeps,
} from './mcpExternalTools';

/**
 * AgentCore Gateway Lambda target for the EXTERNAL MCP tools (Task 39,
 * Requirement 16).
 *
 * External AI applications reach this Lambda through the CUSTOM_JWT gateway
 * (`amplify/mcp-external/resource.ts`) — the gateway has already validated the
 * caller's Cognito JWT (existing user pool, external app client) before this
 * runs (Requirement 16.10). A SEPARATE Lambda from the internal `mcp-tools`
 * target so that:
 *   1. the Admin kill switch enforced here cannot affect the internal gateway
 *      or the webapp chat (Requirement 16.6), and
 *   2. the timeout can accommodate the ~2-minute A2A relay (`ask_agent_space`),
 *      which the 29s internal target cannot.
 *
 * Tool calls arrive one per invocation: the `event` is the tool's input
 * arguments and the tool name is in
 * `context.clientContext.custom.bedrockAgentCoreToolName`
 * (`${targetName}___${toolName}`). The gateway does NOT forward the caller's
 * JWT claims to Lambda targets, so per-user attribution lives in the gateway's
 * own logs; this handler logs each tool call for usage visibility.
 *
 * All tools are READ-ONLY (Requirement 16.9). The A2A relay uses the
 * Admin-stored, server-held Bearer token — it never reaches the client
 * (Requirement 16.5) — and only the conversational `chat` skill.
 */

/**
 * Cache the enable flag briefly so a burst of tool calls costs one S3 read,
 * while an Admin toggle still applies within seconds (Requirement 16.6).
 */
const FLAG_CACHE_TTL_MS = 10_000;
let flagCache: { value: boolean; readAt: number } | undefined;

async function isExternalAccessEnabled(): Promise<boolean> {
  const now = Date.now();
  if (flagCache && now - flagCache.readAt < FLAG_CACHE_TTL_MS) {
    return flagCache.value;
  }
  // `getSettings` fails soft to defaults — and the flag's default is FALSE, so
  // a settings-store outage fails CLOSED for external access.
  const settings = await getSettings();
  flagCache = { value: settings.externalMcpEnabled, readAt: now };
  return flagCache.value;
}

/** Real implementations of the external tools, reusing the shared modules. */
const deps: ExternalToolDeps = {
  isExternalAccessEnabled,

  // --- snapshot tools (identical to the internal target) --------------------
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

  // --- ask_devops_observatory: the SAME three-source grounding as the webapp
  // chat (Requirement 16.4a): governed prompt + admin org prompt + GraphRAG
  // topology facts, answered over the managed KB with citations. Graph and
  // manifest fail soft — the answer degrades to KB-only, never fails outright.
  async askObservatory(question: string) {
    const [context, graphLoad, manifestLoad] = await Promise.all([
      loadBusinessContext(),
      loadGraph(),
      loadManifest(),
    ]);
    let systemPrompt = composeSystemPrompt(context?.orgSystemPrompt);
    if (graphLoad.status === 'ok') {
      const graph = buildGraphResponse(graphLoad.nodes, graphLoad.edges, context);
      const lastSyncDate =
        manifestLoad.status === 'ok' ? resolveLastSyncDate(manifestLoad.manifest) : undefined;
      const facts = summarizeTopology(graph, { lastSyncDate });
      if (facts.length > 0) {
        systemPrompt += `\n\nTOPOLOGY FACTS (read-only reference; use alongside the knowledge base and cite freshness):\n${facts}`;
      }
    }
    // 60s budget: external callers poll no stream, and this Lambda's timeout
    // (150s) leaves ample headroom.
    return answerChatOnce(buildMessages(question, [], systemPrompt), { timeoutMs: 60_000 });
  },

  // --- agent-space tools -----------------------------------------------------
  async listAgentSpaces(): Promise<ExternalAgentSpace[]> {
    const [configured, manifestLoad] = await Promise.all([
      listConfiguredSpaceIds(),
      loadManifest(),
    ]);
    if (manifestLoad.status !== 'ok') {
      // Without the manifest we cannot label or scope-check spaces; return the
      // bare configured ids so the tool remains useful.
      return [...configured].map((agentSpaceId) => ({ agentSpaceId }));
    }
    const spaces: ExternalAgentSpace[] = [];
    for (const account of manifestLoad.manifest.accounts) {
      for (const space of account.spaces) {
        if (configured.has(space.agentSpaceId)) {
          spaces.push({
            agentSpaceId: space.agentSpaceId,
            ...(space.name ? { name: space.name } : {}),
            account: account.account,
          });
        }
      }
    }
    return spaces;
  },

  async askAgentSpace(agentSpaceId: string, question: string) {
    // The Admin-stored token is read server-side and used for one outbound A2A
    // `chat` call; it never appears in the tool result (Requirement 16.5).
    const stored = await getStoredToken(agentSpaceId);
    if (!stored) {
      throw new Error(
        'This agent space is not connected for live A2A chat. Use list_agent_spaces for connectable spaces.',
      );
    }
    const { answer } = await sendChat(stored, question);
    return { answer };
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
  // Usage visibility (Requirement 16.10): per-user attribution lives in the
  // gateway logs; here we record which tool ran (never argument contents that
  // could carry sensitive question text at full length).
  console.info('[mcp-external] tool call:', toolName || '(unknown)');
  try {
    return await runExternalTool(toolName, event, deps);
  } catch (err) {
    if (err instanceof UnknownToolError) {
      // Model-readable error so the client can pick a valid tool.
      return { error: err.message };
    }
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error('[mcp-external] tool execution failed:', detail, err);
    // Surface actionable upstream messages (e.g. "space not connected", token
    // rejected) — they contain no secrets — else a generic failure.
    const message =
      err instanceof Error && err.message.length > 0
        ? err.message
        : 'The tool could not be completed. Please try again.';
    return { error: message };
  }
};
