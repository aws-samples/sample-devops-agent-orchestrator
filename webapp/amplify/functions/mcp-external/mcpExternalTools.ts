import type { ChatCitation } from '@devops-observatory/shared-types';
import {
  TOOL_SCHEMAS,
  TOOL_NAMES,
  parseToolName,
  runTool,
  UnknownToolError,
  type ToolDeps,
} from '../mcp-tools/mcpTools';

/**
 * Pure core for the EXTERNAL MCP tools (Task 39, Requirement 16).
 *
 * External AI applications (Kiro, Claude, chatbots — any MCP client) connect to
 * a dedicated AgentCore Gateway (CUSTOM_JWT against the app's Cognito user
 * pool) whose Lambda target dispatches through this module. It exposes the
 * three internal snapshot tools PLUS three external-facing tools:
 *   - `ask_devops_observatory` — one-call answer grounded in the KB + business
 *     context + topology facts (the same three-source grounding as the webapp
 *     chat, Requirement 16.4a), for simple bots that don't orchestrate tools.
 *   - `list_agent_spaces`      — which agent spaces are A2A-enabled.
 *   - `ask_agent_space`        — relay a question to a space's A2A `chat` skill
 *     using the Admin-stored, SERVER-HELD Bearer token (Requirement 16.5; the
 *     token never reaches the external client). Chat skill only — never
 *     investigate or any action (Requirement 16.9).
 *
 * KILL SWITCH (Requirements 16.6, 16.7): every dispatch first consults
 * `deps.isExternalAccessEnabled()`. When the Admin has disabled external MCP
 * access, EVERY tool call returns a clear "disabled by administrator" error
 * WITHOUT touching any data source. This module serves only the external
 * Lambda, so the flag cannot affect the internal gateway or the webapp chat.
 *
 * Like `mcpTools.ts`, this module is deterministic and dependency-injected (no
 * AWS SDK imports) so the gating + dispatch + validation logic is unit-testable;
 * the Lambda handler wires the real implementations.
 */

/** The bare names of the external-only tools. */
export const EXTERNAL_TOOL_NAMES = {
  askDevopsObservatory: 'ask_devops_observatory',
  listAgentSpaces: 'list_agent_spaces',
  askAgentSpace: 'ask_agent_space',
} as const;

/** Bound on an externally-submitted question (mirrors the webapp chat bound). */
export const EXTERNAL_QUESTION_MAX_LENGTH = 1000;

/** Agent-space id shape (UUID) — mirrors `shared/a2a.ts`'s SPACE_ID_RE. */
const AGENT_SPACE_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The message every tool returns while external access is disabled (Req 16.7). */
export const EXTERNAL_ACCESS_DISABLED_MESSAGE =
  'External AI access to DevOps Observatory is currently disabled by an administrator. ' +
  'An admin can enable it in the web app under Settings → External AI access (MCP).';

/**
 * Full tool schema for the external gateway target: the three snapshot tools
 * (single source of truth in `mcpTools.ts`) plus the three external tools.
 * Used as the AgentCore Gateway target's inline tool schema in
 * `amplify/mcp-external/resource.ts`.
 */
export const EXTERNAL_TOOL_SCHEMAS = [
  ...TOOL_SCHEMAS,
  {
    name: EXTERNAL_TOOL_NAMES.askDevopsObservatory,
    description:
      'Ask Enterprise DevOps Observatory a natural-language question and get one answer ' +
      'grounded in the organization-wide DevOps knowledge base, the admin-authored business ' +
      'context (business units, display names, SLAs), and the live cross-account topology ' +
      'graph — with cited sources. The best first choice for any question about the AWS estate.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The natural-language question to answer (up to 1,000 characters).',
        },
      },
      required: ['question'],
    },
  },
  {
    name: EXTERNAL_TOOL_NAMES.listAgentSpaces,
    description:
      'List the AWS DevOps Agent Spaces this observatory can talk to live over Agent-to-Agent ' +
      '(A2A). Returns each connectable space\u2019s id, name, and AWS account. Use before ' +
      'ask_agent_space to discover valid agentSpaceId values.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: EXTERNAL_TOOL_NAMES.askAgentSpace,
    description:
      'Ask a specific AWS DevOps Agent Space a question LIVE over Agent-to-Agent (A2A) chat. ' +
      'Use for current, per-workload questions (active incidents, latest findings in one ' +
      'account) that the aggregated snapshot may not cover. Can take up to 2 minutes. ' +
      'Read-only conversation — this never starts investigations or takes actions.',
    inputSchema: {
      type: 'object',
      properties: {
        agentSpaceId: {
          type: 'string',
          description: 'The agent space id (UUID) — discover valid values with list_agent_spaces.',
        },
        question: {
          type: 'string',
          description: 'The question to ask the space (up to 1,000 characters).',
        },
      },
      required: ['agentSpaceId', 'question'],
    },
  },
] as const;

/** One A2A-connectable space, as returned by `list_agent_spaces`. */
export interface ExternalAgentSpace {
  agentSpaceId: string;
  name?: string;
  account?: string;
}

/**
 * Injectable implementations for the external dispatcher: the snapshot tool
 * deps plus the external tools and the enable flag (wired in the handler).
 */
export interface ExternalToolDeps extends ToolDeps {
  /** The Admin kill switch — read per call so a change applies instantly. */
  isExternalAccessEnabled(): Promise<boolean>;
  /** One-call, three-source-grounded answer (KB + business context + graph). */
  askObservatory(question: string): Promise<{ answer: string; citations: ChatCitation[] }>;
  /** The A2A-configured spaces (id + manifest name/account). */
  listAgentSpaces(): Promise<ExternalAgentSpace[]>;
  /** Relay to the space's A2A `chat` skill with the server-held token. */
  askAgentSpace(agentSpaceId: string, question: string): Promise<{ answer: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read + bound a required question argument, or return an error message. */
function readQuestion(input: Record<string, unknown>, field: string): string | { error: string } {
  const raw = input[field];
  const question = typeof raw === 'string' ? raw.trim() : '';
  if (question.length === 0) {
    return { error: `The "${field}" argument is required and must be a non-empty string.` };
  }
  if (Array.from(question).length > EXTERNAL_QUESTION_MAX_LENGTH) {
    return { error: `The "${field}" argument must be ${EXTERNAL_QUESTION_MAX_LENGTH} characters or fewer.` };
  }
  return question;
}

/**
 * Dispatch an external MCP tool call. Order of operations (Requirement 16.7):
 *   1. The enable flag is checked FIRST — when external access is disabled,
 *      every tool (including the snapshot tools) returns the disabled message
 *      and no data source is touched.
 *   2. External-only tools are handled here; anything else falls through to the
 *      shared snapshot dispatcher (`runTool`), so the three internal tools keep
 *      one implementation.
 * Arguments are read defensively — they arrive from an external MCP client.
 */
export async function runExternalTool(
  toolName: string,
  args: unknown,
  deps: ExternalToolDeps,
): Promise<unknown> {
  if (!(await deps.isExternalAccessEnabled())) {
    return { error: EXTERNAL_ACCESS_DISABLED_MESSAGE };
  }

  const name = parseToolName(toolName);
  const input = isRecord(args) ? args : {};

  switch (name) {
    case EXTERNAL_TOOL_NAMES.askDevopsObservatory: {
      const question = readQuestion(input, 'question');
      if (typeof question !== 'string') return question;
      return deps.askObservatory(question);
    }
    case EXTERNAL_TOOL_NAMES.listAgentSpaces: {
      const spaces = await deps.listAgentSpaces();
      return {
        spaces,
        ...(spaces.length === 0
          ? { message: 'No agent spaces are connected for live A2A chat yet.' }
          : {}),
      };
    }
    case EXTERNAL_TOOL_NAMES.askAgentSpace: {
      const rawId = typeof input.agentSpaceId === 'string' ? input.agentSpaceId.trim() : '';
      if (!AGENT_SPACE_ID_RE.test(rawId)) {
        return {
          error:
            'The "agentSpaceId" argument must be an agent space id (UUID). ' +
            'Use list_agent_spaces to discover valid values.',
        };
      }
      const question = readQuestion(input, 'question');
      if (typeof question !== 'string') return question;
      return deps.askAgentSpace(rawId, question);
    }
    default:
      // The three snapshot tools (and the unknown-tool error) share the
      // internal dispatcher — one implementation, one behavior.
      return runTool(name, input, deps);
  }
}

export { TOOL_NAMES, UnknownToolError };
