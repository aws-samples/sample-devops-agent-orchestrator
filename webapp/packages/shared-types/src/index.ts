/**
 * Shared type contracts for the DevOps Observatory Web App.
 *
 * These interfaces are the API/data contracts shared between the React SPA
 * (`src/`) and the Amplify backend Lambda handlers (`amplify/`). They are
 * derived from the data models in the design document. Later tasks (4–10, 12–17)
 * fill in the handlers and views that produce/consume these shapes; this file
 * is the single source of truth for the DTOs.
 *
 * NOTE: This is a scaffold (Task 1). Fields marked with TODO comments reference
 * the task that finalizes their behavior. Do not add feature logic here.
 */

// ---------------------------------------------------------------------------
// Common primitives
// ---------------------------------------------------------------------------

/** Freshness marker: an ISO-8601 timestamp string, or the literal "unknown". */
export type LastSyncDate = string | 'unknown';

/** Roles supported by the Auth_Service (Requirement 2.1). */
export type UserRole = 'Executive' | 'Admin';

/** Cognito group names — mirror {@link UserRole}. Defined in Task 2. */
export type CognitoGroup = 'Executive' | 'Admin';

// ---------------------------------------------------------------------------
// Manifest (existing hub artifact: raw/_manifest.json) — read-only
// ---------------------------------------------------------------------------

/**
 * Per-space activity counts recorded in the manifest.
 *
 * `incidents` and `investigations` are the SAME concept in AWS DevOps Agent —
 * an "investigation" is the agent's investigation of an operational incident,
 * modeled as an `INVESTIGATION` backlog task. The collector records the count of
 * those tasks and sets `incidents` and `investigations` to the same value, so
 * either term can be surfaced (they never diverge). `recommendations` is a
 * distinct metric (prevention recommendations), not folded into incidents.
 */
export interface ManifestSpaceCounts {
  associations: number;
  assets: number;
  /** Count of INVESTIGATION backlog tasks (incidents). Equals `incidents`. */
  investigations: number;
  /** Incidents in the space; equals `investigations` (same underlying tasks). */
  incidents: number;
  recommendations: number;
  // -- Configured capabilities (counts only, no per-config detail). The
  // collector buckets the space's association configurations into the
  // console's capability categories. Each capability metric is `number | null`:
  // `null` means UNKNOWN — the collector could not retrieve the metric
  // (permission gap, API error, non-enumerable operator-app access mode) or
  // the manifest predates capability tracking. UNKNOWN is rendered as such and
  // is NEVER coerced to 0, so the UI stays aligned with what actually happened
  // in the backend. --
  /** Telemetry integrations (Datadog, Dynatrace, New Relic, Splunk, Grafana). */
  telemetry: number | null;
  /** Code/CI-CD pipeline integrations (GitHub, GitLab, Azure DevOps). */
  pipelines: number | null;
  /** Communication channels (Slack, ServiceNow, PagerDuty). */
  communications: number | null;
  /** Customer-managed MCP server integrations. */
  mcpServers: number | null;
  /** Remote agent integrations. */
  remoteAgents: number | null;
  /** Webhooks configured across the space's associations. */
  webhooks: number | null;
  /** CloudWatch Logs delivery endpoints configured for the space. */
  logDeliveries: number | null;
  /**
   * Users assigned to the space's operator app. Enumerable only for the IAM
   * Identity Center access mode; other modes and lookup failures are `null`
   * (unknown). A space with no operator app is a true 0.
   */
  users: number | null;
}

/** A single agent space entry within a manifest account. */
export interface ManifestSpace {
  agentSpaceId: string;
  name?: string;
  counts: ManifestSpaceCounts;
}

/** A single linked account entry within the manifest. */
export interface ManifestAccount {
  account: string;
  name?: string;
  /** Present when collection for this account failed or was incomplete. */
  error?: string;
  spaces: ManifestSpace[];
  /** Monthly account usage from GetAccountUsage (null = not collected). */
  usage: AccountUsage | null;
}

/**
 * Monthly DevOps Agent account usage from GetAccountUsage. Hours are the
 * current billing month's cumulative usage. `null` at the account level means
 * the metric could not be retrieved; here it's always populated when present.
 */
export interface AccountUsage {
  investigationHours: number;
  evaluationHours: number;
  systemLearningHours: number;
  onDemandHours: number;
  periodStart: string;
  periodEnd: string;
}

/** Shape of `raw/_manifest.json` in the hub bucket. */
export interface Manifest {
  /** Collection timestamp — the source of Last_Sync_Date (Requirement 4.1). */
  collectedAt: string;
  region: string;
  accounts: ManifestAccount[];
}

// ---------------------------------------------------------------------------
// Business context (new hub artifact: hub/business_context.json)
// ---------------------------------------------------------------------------

/** An administrator-defined grouping of one or more linked accounts. */
export interface BusinessUnit {
  /** 1–128 chars (Requirement 5.1). */
  name: string;
  /** ≤1024 chars (Requirement 5.2). */
  description?: string;
  /** Account IDs — each must exist in the manifest (Requirement 5.7). */
  accounts: string[];
}

/**
 * Shape of `hub/business_context.json`.
 * Validation rules are enforced by the context API in Task 5.1.
 */
export interface BusinessContext {
  version: number;
  /** ISO-8601 timestamp of the last successful save. */
  updatedAt: string;
  businessUnits: BusinessUnit[];
  /** Map of accountId -> human-friendly display name (1–128 chars). */
  accountDisplayNames: Record<string, string>;
  /**
   * Map of accountId -> free-text descriptive context about the account
   * (≤4096 chars, Requirement 5.2). This is richer, admin-authored context
   * beyond the display name (e.g. purpose, owning team, environment, notes)
   * that enriches the knowledge base and in-app labels. Persisted in the same
   * durable business-context object so a single save is atomic.
   */
  accountContext: Record<string, string>;
  /**
   * Admin-authored organization-wide chat guidance (≤
   * {@link ORG_SYSTEM_PROMPT_MAX_LENGTH} chars, Requirement 5.16). Establishes
   * the executive persona/tone/scope for the org-wide chat. Applied on top of a
   * built-in governed safety/grounding layer that it CANNOT remove; when unset,
   * a built-in default executive guidance is used. Absent/blank = not set.
   */
  orgSystemPrompt?: string;
}

/** Max length of the admin-authored org-wide chat system prompt (Requirement 5.16). */
export const ORG_SYSTEM_PROMPT_MAX_LENGTH = 8000;

// ---------------------------------------------------------------------------
// Aggregate DTOs — /summary and /dashboard
// ---------------------------------------------------------------------------

/**
 * Core totals surfaced on the landing/summary and dashboard views.
 * Incident mapping (design decision): incidents = investigations + open
 * recommendations (Requirements 6.1, 11.1).
 */
export interface AggregateTotals {
  incidents: number;
  investigations: number;
  agentSpaces: number;
  // -- Capability rollups (sum of per-space counts across the scope). Present
  // at every grouping level: organization totals, per-Business_Unit and
  // per-account breakdown rows. A per-space metric that is `null` (unknown —
  // the collector could not retrieve it) is treated as 0 in the rollup so
  // that totals always show the measurable portion of the fleet. The "—"
  // indicator stays visible at the individual space level only. --
  telemetry: number;
  pipelines: number;
  communications: number;
  mcpServers: number;
  remoteAgents: number;
  webhooks: number;
  logDeliveries: number;
  users: number;
  // -- Monthly usage rollups (sum of per-account GetAccountUsage hours). --
  investigationHours: number;
  evaluationHours: number;
  systemLearningHours: number;
  onDemandHours: number;
}

/** A single breakdown row, keyed by business unit or account. */
export interface BreakdownRow {
  /** Business_Unit name, account display name/id, or "Unassigned". */
  key: string;
  totals: AggregateTotals;
}

/** Response for `GET /summary` (Task 4.1). */
export interface SummaryDTO {
  totals: AggregateTotals;
  lastSyncDate: LastSyncDate;
}

/** How a dashboard breakdown is grouped (Requirements 6.7, 12.5–12.7). */
export type DashboardGrouping = 'businessUnit' | 'account';

/** Response for `GET /dashboard` (Task 4.3). */
export interface DashboardDTO {
  totals: AggregateTotals;
  grouping: DashboardGrouping;
  /** Empty array => UI shows a no-data message (Requirement 6.8). */
  breakdown: BreakdownRow[];
  lastSyncDate: LastSyncDate;
}

// ---------------------------------------------------------------------------
// Spaces DTO — /spaces
// ---------------------------------------------------------------------------

/** Collection status for a space/account (Requirements 3.4, 3.5). */
export type CollectionStatus = 'collected' | 'incomplete';

/** A single space row within an account for the Space_View. */
export interface SpaceRow {
  agentSpaceId: string;
  /** Space name, or the id when unnamed (Requirement 3.3). */
  displayName: string;
  counts: ManifestSpaceCounts;
  status: CollectionStatus;
}

/** An account with its grouped spaces for the Space_View (Task 4.2). */
export interface AccountSpaces {
  account: string;
  /** Display name / BU label applied from business context (Requirement 3.2). */
  displayName: string;
  /**
   * The AWS Organizations account name captured by the collector (Requirement
   * 3.8). Surfaced so the UI can show a friendly org name even when no Admin
   * display name is set, and used as the display-name fallback ahead of the raw
   * account id. Absent when the org listing did not provide a name.
   */
  orgName?: string;
  businessUnit?: string;
  spaces: SpaceRow[];
  /** True when the account has no spaces (Requirement 3.6). */
  hasNoSpaces: boolean;
  status: CollectionStatus;
  lastSyncDate: LastSyncDate;
}

/** Response for `GET /spaces` (Task 4.2). */
export interface SpacesDTO {
  accounts: AccountSpaces[];
  lastSyncDate: LastSyncDate;
}

// ---------------------------------------------------------------------------
// Create agent space — POST /spaces (Admin only)
// ---------------------------------------------------------------------------

/** Inclusive bounds for a new agent space's name. */
export const AGENT_SPACE_NAME_MIN_LENGTH = 1;
export const AGENT_SPACE_NAME_MAX_LENGTH = 128;
/** Max length of the optional agent-space description. */
export const AGENT_SPACE_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Request body for `POST /spaces` (Admin only) — create a new AWS DevOps Agent
 * Space in a linked/hub account. The account must exist in the manifest. The
 * name is bounded by {@link AGENT_SPACE_NAME_MIN_LENGTH}/
 * {@link AGENT_SPACE_NAME_MAX_LENGTH}; the description (if given) by
 * {@link AGENT_SPACE_DESCRIPTION_MAX_LENGTH}.
 */
export interface CreateSpaceRequest {
  /** AWS account id the space is created in (must exist in the manifest). */
  accountId: string;
  /** New agent space name. */
  name: string;
  /** Optional human description. */
  description?: string;
}

/** A newly created agent space, echoed back on success. */
export interface CreatedSpace {
  accountId: string;
  agentSpaceId: string;
  /** The name the service recorded (may be normalized from the request). */
  name?: string;
  /**
   * Whether the hosting account was attached as the space's primary (monitor)
   * account. A space with no primary account monitors nothing, so this is the
   * minimum useful configuration; when false, {@link CreatedSpace.warning}
   * explains why it could not be attached (the space still exists).
   */
  primaryAccountConfigured?: boolean;
  /** Present when the space was created but the primary account was not attached. */
  warning?: string;
}

/** Response body for a successful `POST /spaces`. */
export interface CreateSpaceResponse {
  created: true;
  space: CreatedSpace;
}

/** Max accounts a single batch create request may target. */
export const BATCH_CREATE_SPACES_MAX = 1000;

/**
 * Request body for `POST /spaces/batch` (Admin only) — create a starter agent
 * space in each listed account (named `devops-agent-<accountId>`). Every account
 * must exist in the manifest. Creation is fanned out asynchronously (fire and
 * forget), so the response only confirms how many were accepted; the new spaces
 * appear after the next data refresh (until then the UI marks them "pending").
 */
export interface BatchCreateSpacesRequest {
  accountIds: string[];
}

/** Response body for `POST /spaces/batch` — count accepted for async creation. */
export interface BatchCreateSpacesResponse {
  accepted: number;
  /** The account ids accepted for creation (echoed for the pending markers). */
  accountIds: string[];
}

// ---------------------------------------------------------------------------
// Agent-to-Agent (A2A) integration — /spaces/{spaceId}/a2a-token, /a2a/chat
// ---------------------------------------------------------------------------
//
// The DevOps Agent A2A remote server (`https://connect.aidevops.{region}.api.aws`)
// lets this app talk to an individual Agent Space using a per-space Bearer
// access token. Because the spaces live in different accounts, a token (created
// MANUALLY in the DevOps Agent web app and scoped to one space) is far simpler
// than cross-account SigV4. The token is stored server-side in AWS Secrets
// Manager (one secret per space) and NEVER returned to the browser.

/** Max length of a stored A2A access token (guards against pasted junk). */
export const A2A_TOKEN_MAX_LENGTH = 512;
/** Bounds for an A2A chat message sent to a space's `chat` skill. */
export const A2A_MESSAGE_MIN_LENGTH = 1;
export const A2A_MESSAGE_MAX_LENGTH = 4000;

/**
 * `PUT /spaces/{spaceId}/a2a-token` (Admin) — store/replace the Bearer access
 * token for a space. The token value is write-only (never echoed back); the
 * optional metadata is what the Admin recorded when creating the token in the
 * DevOps Agent console, surfaced later on the status endpoint.
 */
export interface A2aTokenRequest {
  /** The access token value (created manually in the DevOps Agent web app). */
  token: string;
  /** Region of the space's remote server (defaults to the hub region). */
  region?: string;
  /** Admin-recorded token name (for display; matches the console token name). */
  tokenName?: string;
  /** Admin-recorded scope: `read` or `operate`. */
  scope?: string;
  /** Admin-recorded expiry (ISO-8601), for an at-a-glance "expiring soon" hint. */
  expiresAt?: string;
}

/**
 * `GET /spaces/{spaceId}/a2a-status` (Admin) — whether an A2A token is stored
 * for the space and its non-sensitive metadata. NEVER includes the token value.
 */
export interface A2aStatus {
  /** True when a token secret exists for this space. */
  configured: boolean;
  region?: string;
  tokenName?: string;
  scope?: string;
  expiresAt?: string;
  /** ISO-8601 timestamp the token was last stored/updated in the app. */
  updatedAt?: string;
}

/** A configured A2A space (has a stored token) joined with its manifest name. */
export interface A2aConfiguredSpace {
  agentSpaceId: string;
  name?: string;
  account?: string;
}

/**
 * `GET /a2a/spaces` (any authenticated user) — the spaces that have an A2A token
 * stored, joined with their manifest name/account. Powers the Spaces-view "A2A"
 * icon and the Chat-view space selector. Never includes any token value.
 */
export interface A2aConfiguredSpacesResponse {
  spaces: A2aConfiguredSpace[];
}

/** `POST /spaces/{spaceId}/a2a/chat` — ask the space's `chat` skill (any user). */
export interface A2aChatRequest {
  message: string;
}

/** Response from the A2A `chat` skill. */
export interface A2aChatResponse {
  /** The agent's answer text (concatenated from the task's artifacts). */
  answer: string;
  /** The A2A task id (for traceability / future async follow-up). */
  taskId?: string;
  /** The A2A task terminal state (e.g. `TASK_STATE_COMPLETED`). */
  state?: string;
}

// ---------------------------------------------------------------------------
// A2A `investigate` skill (async, durable) —
//   POST   /spaces/{spaceId}/a2a/investigate            (start)
//   GET    /spaces/{spaceId}/a2a/investigate/{execName} (status/result)
//   POST   /spaces/{spaceId}/a2a/investigate/{execName}/approve|reject
// ---------------------------------------------------------------------------
//
// Unlike `chat` (which answers in seconds), the DevOps Agent `investigate` skill
// runs a long, multi-step analysis. The app starts it inside a Lambda DURABLE
// FUNCTION that reliably runs to completion (starting the investigation, then
// polling the A2A task with a durable `waitForCondition`), then PAUSES on a
// durable callback for a human to review the findings before the execution is
// closed (human-in-the-loop — the app never auto-acts on the agent's analysis).
// The browser starts the durable execution and polls its status; no request is
// held open for minutes.

/** Bounds for an A2A investigate prompt (same ceiling as chat). */
export const A2A_INVESTIGATE_MESSAGE_MIN_LENGTH = A2A_MESSAGE_MIN_LENGTH;
export const A2A_INVESTIGATE_MESSAGE_MAX_LENGTH = A2A_MESSAGE_MAX_LENGTH;

/**
 * A2A skill run through the durable async runner. Both `chat` and `investigate`
 * use the same start/status plumbing so a slow `chat` (the DevOps Agent chat is
 * synchronous and can exceed the API Gateway 30s timeout) isn't cut off — it
 * runs in the durable function and the browser polls for the answer. `chat` has
 * no approval step; `investigate` keeps the human-in-the-loop gate.
 */
export type A2aRunSkill = 'chat' | 'investigate';

/**
 * Normalized status of an investigate durable execution, as surfaced to the SPA.
 * Maps the Lambda durable-execution status plus our own `AWAITING_APPROVAL`
 * phase (the durable function is paused on the human-in-the-loop callback):
 *   - `RUNNING`            — starting / polling the A2A task
 *   - `AWAITING_APPROVAL`  — findings are ready and awaiting a human decision
 *   - `SUCCEEDED`          — findings were acknowledged and the execution closed
 *   - `REJECTED`           — findings were dismissed by the reviewer
 *   - `FAILED`/`TIMED_OUT`/`STOPPED` — the execution did not complete
 *   - `NOT_FOUND`          — no such execution (or its history was retained out)
 */
export type A2aInvestigateState =
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'SUCCEEDED'
  | 'REJECTED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'STOPPED'
  | 'NOT_FOUND';

/** `POST /spaces/{spaceId}/a2a/investigate` — start an async investigation. */
export interface A2aInvestigateStartRequest {
  /** The incident / question to investigate. */
  message: string;
}

/** Response to starting a run (poll `GET .../{skill}/{execName}`). */
export interface A2aInvestigateStartResponse {
  /** Durable-execution name (opaque id used in the status/approve/reject URLs). */
  executionName: string;
  /** ARN of the started durable execution (used server-side to poll status). */
  executionArn: string;
  /** Initial status (always `RUNNING` right after start). */
  status: A2aInvestigateState;
  /** Which skill this run drives (`chat` = no approval; `investigate` = gated). */
  skill?: A2aRunSkill;
}

/** `GET /spaces/{spaceId}/a2a/{skill}/{execName}` — current status + result. */
export interface A2aInvestigateStatusResponse {
  executionName: string;
  status: A2aInvestigateState;
  /** Which skill this run drives. `chat` runs never reach `AWAITING_APPROVAL`. */
  skill?: A2aRunSkill;
  /** The original prompt (echoed for display). */
  question?: string;
  /** The underlying A2A task id, once the investigation has started. */
  taskId?: string;
  /**
   * The agent's findings text. Present once findings are ready — both while
   * `AWAITING_APPROVAL` (for the reviewer to read) and after `SUCCEEDED`.
   */
  findings?: string;
  /** Human-readable error when the execution did not complete. */
  error?: string;
  /** ISO-8601 start / end timestamps when known. */
  startedAt?: string;
  endedAt?: string;
}

/**
 * `POST /spaces/{spaceId}/a2a/investigate/{execName}/reject` — optional reason.
 * (The `approve` route needs no body.)
 */
export interface A2aInvestigateRejectRequest {
  /** Optional reviewer note recorded with the dismissal. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Graph DTOs — /graph
// ---------------------------------------------------------------------------

/** Node types present in the topology graph (Requirement, design "Graph_Data"). */
export type GraphNodeType =
  | 'Account'
  | 'AgentSpace'
  | 'Association'
  | 'ExternalTarget'
  | 'Investigation'
  | 'Recommendation'
  | 'Asset'
  | 'AwsService';

/** An enriched graph node (Requirement 9). */
export interface GraphNode {
  id: string;
  type: GraphNodeType;
  /** Human-friendly label; typed fallback when no business label exists (9.8). */
  displayLabel: string;
  /** Raw label if the query returned one (may equal the id for legacy data). */
  label?: string;
  businessUnit?: string;
  /** Free-form business metadata overlaid at transform/query time. */
  metadata?: Record<string, unknown>;
}

/** An enriched graph edge. */
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  /** True for cross-account TARGETS_ACCOUNT edges (Requirement 7.5, 9.9). */
  crossAccount?: boolean;
}

/** Reason categories when the graph cannot be returned (Requirement 7.7). */
export type GraphUnavailableReason =
  | 'graph_unavailable'
  | 'query_failed'
  | 'empty';

/** Response for `GET /graph` (Task 8). */
export interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Present only when nodes/edges could not be produced. */
  unavailableReason?: GraphUnavailableReason;
}

// ---------------------------------------------------------------------------
// Chat DTOs — POST /chat (streaming)
// ---------------------------------------------------------------------------

/** A single prior turn forwarded for multi-turn context (Requirement 8.5). */
export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Request body for `POST /chat` (Task 9). */
export interface ChatRequest {
  /** Current user question — validated for empty/too-long (Requirement 8.1, 8.9). */
  message: string;
  /** Prior conversation turns, oldest first. */
  history?: ChatTurn[];
}

/** A deduplicated citation returned with a chat answer (Requirement 8.3). */
export interface ChatCitation {
  title?: string;
  uri?: string;
  snippet?: string;
}

/**
 * Discriminated union of events emitted over the chat response stream
 * (Requirements 8.2, 8.6, 8.7). Task 9 finalizes the wire format.
 */
export type ChatStreamEvent =
  | { kind: 'chunk'; text: string }
  | { kind: 'citations'; citations: ChatCitation[] }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/**
 * Response body for the non-streaming `POST /chat` route. The chat endpoint is
 * served over the JWT-authorized HTTP API (not a public streaming Function URL,
 * which this deployment's environment blocks), so the full synthesized answer
 * and its deduplicated citation set are returned in a single JSON response
 * (Requirements 8.2–8.4).
 */
export interface ChatResponse {
  /** The synthesized answer grounded in the knowledge base. */
  answer: string;
  /** Deduplicated cited sources; empty = no sources cited (Requirement 8.4). */
  citations: ChatCitation[];
}

// ---------------------------------------------------------------------------
// Chat history / memory — GET/DELETE /chat/history (persistent chat memory)
// ---------------------------------------------------------------------------

/** Inclusive bounds for the admin-configurable chat-history retention window. */
export const CHAT_HISTORY_MIN_RETENTION_DAYS = 1;
export const CHAT_HISTORY_MAX_RETENTION_DAYS = 30;
export const CHAT_HISTORY_DEFAULT_RETENTION_DAYS = 30;

/**
 * A single persisted chat turn (a user question or an assistant answer),
 * scoped to the requesting user. Persisted server-side so a user's chat memory
 * survives across sessions and devices, subject to the retention window.
 */
export interface ChatHistoryMessage {
  /** Stable id of the stored message (sort-key suffix). */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** Cited sources on an assistant turn (absent/empty for user turns). */
  citations?: ChatCitation[];
  /** ISO-8601 timestamp the message was stored. */
  createdAt: string;
}

/** Response for `GET /chat/history` — the caller's own recent chat memory. */
export interface ChatHistoryResponse {
  /** Ordered oldest-first, already trimmed to the retention window. */
  messages: ChatHistoryMessage[];
  /** The retention window (days) currently applied, for display. */
  retentionDays: number;
}

/** Response for `DELETE /chat/history` — the caller cleared their own memory. */
export interface ClearChatHistoryResponse {
  cleared: boolean;
}

// ---------------------------------------------------------------------------
// Application settings — GET /settings (any), PUT /settings (Admin)
// ---------------------------------------------------------------------------

/**
 * Admin-managed application settings. Currently the chat-history retention
 * window (1–{@link CHAT_HISTORY_MAX_RETENTION_DAYS} days, default
 * {@link CHAT_HISTORY_DEFAULT_RETENTION_DAYS}), which bounds how long persisted
 * chat memory is retained before expiry.
 */
export interface AppSettings {
  /** Days of chat memory to retain; clamped to the inclusive bounds above. */
  chatHistoryRetentionDays: number;
  /**
   * Whether EXTERNAL AI applications may use the external MCP endpoint
   * (Task 39, Requirement 16.6). Default FALSE — external access is opt-in.
   * Enforced at request time in the external tools Lambda only, so toggling it
   * never affects the webapp's own chat or the internal MCP gateway.
   */
  externalMcpEnabled: boolean;
  /** ISO-8601 timestamp of the last successful settings save. */
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Refresh DTOs — POST /refresh, GET /refresh/status
// ---------------------------------------------------------------------------

/** Lifecycle state of a refresh execution (Requirements 10.4, 10.8). */
export type RefreshState =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'ABORTED';

/** Response for `POST /refresh` — async accept within 5s (Requirement 10.3). */
export interface RefreshStartResponse {
  executionId: string;
  state: RefreshState;
}

/**
 * Collection progress while the refresh is fanning out across accounts
 * (Requirement 10.12). Populated from the Distributed Map run's item counts
 * during the `collect` stage; absent for the other stages.
 */
export interface RefreshProgress {
  /** The stage this progress describes (currently always `collect`). */
  stage: string;
  /** Total accounts being collected in this run. */
  total: number;
  /** Accounts finished (succeeded + failed). */
  completed: number;
  /** Accounts that failed collection (still counted as completed). */
  failed: number;
}

/** Response for `GET /refresh/status` (Task 10.2). */
export interface RefreshStatus {
  executionId: string;
  state: RefreshState;
  /** Pipeline stage in progress or where a failure occurred. */
  currentStage?: string;
  /** Stage-specific message on failure (Requirement 10.8). */
  errorStage?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  /** Per-account collection progress during the fan-out (Requirement 10.12). */
  progress?: RefreshProgress;
}

// ---------------------------------------------------------------------------
// Standard error envelope (auth/authz and handler errors)
// ---------------------------------------------------------------------------

/** Standard error categories returned by the API layer (Task 3). */
export type ApiErrorCode =
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UPSTREAM_UNAVAILABLE'
  | 'NOT_IMPLEMENTED'
  | 'INTERNAL';

/**
 * Standard API error response body. Every non-2xx response from the API layer
 * uses this envelope so the SPA and backend agree on the error shape
 * (Requirements 2.3, 2.5, 2.6). `details` is optional, free-form context.
 */
export interface ApiError {
  code: ApiErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Canonical HTTP status code for each {@link ApiErrorCode}. Backend response
 * helpers and the SPA use this single mapping so status codes stay consistent
 * across the API surface.
 */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  VALIDATION: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UPSTREAM_UNAVAILABLE: 502,
  NOT_IMPLEMENTED: 501,
  INTERNAL: 500,
};

/**
 * Standard authentication-required error (Requirements 1.2, 2.6). Returned when
 * a request reaches the API layer without a valid identity. For HTTP API routes
 * the JWT authorizer rejects these before the handler runs; the streaming
 * `/chat` transport enforces it in-handler. No state is changed on denial.
 */
export const AUTH_REQUIRED_ERROR: ApiError = {
  code: 'UNAUTHENTICATED',
  message: 'Authentication is required to access this resource.',
};

/**
 * Standard insufficient-permissions error (Requirements 2.3, 2.5). Returned when
 * an authenticated non-Admin caller attempts an Admin-only action. The action is
 * denied and no business context or underlying data is changed.
 */
export const FORBIDDEN_ERROR: ApiError = {
  code: 'FORBIDDEN',
  message: 'You do not have permission to perform this action.',
};

/** The Cognito group required for Admin-only actions (Requirement 2.1). */
export const ADMIN_GROUP: CognitoGroup = 'Admin';

/** JWT claim key that carries a user's Cognito group memberships. */
export const COGNITO_GROUPS_CLAIM = 'cognito:groups';
