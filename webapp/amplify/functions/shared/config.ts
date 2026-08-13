/**
 * Non-secret backend configuration for the S3 read handlers (Task 4).
 *
 * Values are injected as Lambda environment variables in `backend.ts`
 * (`HUB_BUCKET`, `MANIFEST_KEY`, `BUSINESS_CONTEXT_KEY`). Defaults mirror
 * `backend.ts` / `.env.example` so local typecheck and unit tests resolve a
 * value without a populated environment. Never put secrets here.
 */
export interface HubConfig {
  /** Hub S3 bucket that stores the manifest and business context. */
  bucket: string;
  /** Key of the collection manifest (`raw/_manifest.json`). */
  manifestKey: string;
  /** Key of the business-context object (`hub/business_context.json`). */
  businessContextKey: string;
}

const DEFAULTS = {
  bucket: 'devops-agent-hub-123456789012-us-east-1',
  manifestKey: 'raw/_manifest.json',
  businessContextKey: 'hub/business_context.json',
} as const;

/** Resolve the hub configuration from the environment, falling back to defaults. */
export function getHubConfig(): HubConfig {
  return {
    bucket: process.env.HUB_BUCKET ?? DEFAULTS.bucket,
    manifestKey: process.env.MANIFEST_KEY ?? DEFAULTS.manifestKey,
    businessContextKey: process.env.BUSINESS_CONTEXT_KEY ?? DEFAULTS.businessContextKey,
  };
}

/**
 * Neptune Analytics configuration for the `GET /graph` handler (Task 8).
 *
 * Values are injected as Lambda environment variables in `backend.ts`
 * (`NEPTUNE_GRAPH_ID`, `NEPTUNE_GRAPH_ENDPOINT`, `HUB_REGION`). Defaults mirror
 * `.env.example` so local typecheck and unit tests resolve a value without a
 * populated environment. Never put secrets here.
 */
export interface GraphConfig {
  /** Graph identifier passed to `neptune-graph:ExecuteQuery` (e.g. `g-abc123`). */
  graphIdentifier: string;
  /** AWS region hosting the graph. */
  region: string;
}

const GRAPH_DEFAULTS = {
  endpoint: 'g-0123456789.us-east-1.neptune-graph.amazonaws.com',
  region: 'us-east-1',
} as const;

/**
 * Derive the graph identifier from an explicit id, or from the graph endpoint
 * host (the leading `g-…` label), falling back to the sample default. The
 * `ExecuteQuery` API takes the graph id, not the full endpoint host.
 */
function resolveGraphIdentifier(): string {
  const explicit = process.env.NEPTUNE_GRAPH_ID;
  if (explicit && explicit.length > 0) return explicit;
  const endpoint = process.env.NEPTUNE_GRAPH_ENDPOINT ?? GRAPH_DEFAULTS.endpoint;
  // Endpoint host looks like `g-0123456789.us-east-1.neptune-graph.amazonaws.com`.
  return endpoint.split('.')[0] ?? endpoint;
}

/** Resolve the graph configuration from the environment, falling back to defaults. */
export function getGraphConfig(): GraphConfig {
  return {
    graphIdentifier: resolveGraphIdentifier(),
    region: process.env.HUB_REGION ?? process.env.AWS_REGION ?? GRAPH_DEFAULTS.region,
  };
}

/**
 * Bedrock managed knowledge-base configuration for the streaming `POST /chat`
 * handler (Task 9).
 *
 * Values are injected as Lambda environment variables in `backend.ts`
 * (`KB_ID`, `KB_CHAT_MODEL_ARN`, `HUB_REGION`). Defaults mirror the repo-root
 * `config.env` / `.env.example` so local typecheck and unit tests resolve a
 * value without a populated environment. The knowledge-base id is resolved at
 * deploy time; the default here is a non-secret placeholder. Never put secrets
 * here.
 */
export interface ChatConfig {
  /** Knowledge base id queried by `AgenticRetrieveStream`. */
  knowledgeBaseId: string;
  /** ARN of the Bedrock chat model (inference profile) that synthesizes answers. */
  modelArn: string;
  /** AWS region hosting the knowledge base + model. */
  region: string;
}

const CHAT_DEFAULTS = {
  knowledgeBaseId: 'PLACEHOLDER_KB_ID',
  // config.env: KB_CHAT_MODEL_ARN — a cross-region inference profile.
  modelArn:
    'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  region: 'us-east-1',
} as const;

/** Resolve the chat configuration from the environment, falling back to defaults. */
export function getChatConfig(): ChatConfig {
  return {
    knowledgeBaseId: process.env.KB_ID ?? CHAT_DEFAULTS.knowledgeBaseId,
    modelArn: process.env.KB_CHAT_MODEL_ARN ?? CHAT_DEFAULTS.modelArn,
    region: process.env.HUB_REGION ?? process.env.AWS_REGION ?? CHAT_DEFAULTS.region,
  };
}

/**
 * Cognito user-pool configuration for verifying the caller's access token on
 * the streaming `POST /chat` Function URL (Task 9, Requirements 1.2, 2.6, 8.8).
 *
 * The Function URL sits outside the HTTP API's JWT authorizer, so the chat
 * handler must cryptographically verify the Cognito access token itself. Values
 * are injected as Lambda environment variables in `backend.ts` (`USER_POOL_ID`,
 * `USER_POOL_CLIENT_ID`). The defaults are non-secret, well-formed placeholders
 * (the pool id keeps the `<region>_<id>` shape so the verifier can be
 * constructed without throwing in unconfigured local/test environments). Never
 * put secrets here.
 */
export interface AuthConfig {
  /** Cognito user pool id (issuer), e.g. `us-east-1_ab12CD34`. */
  userPoolId: string;
  /** Cognito app client id accepted as the access token's `client_id`. */
  userPoolClientId: string;
}

const AUTH_DEFAULTS = {
  userPoolId: 'us-east-1_PLACEHOLDER',
  userPoolClientId: 'PLACEHOLDER_CLIENT_ID',
} as const;

/** Resolve the auth configuration from the environment, falling back to defaults. */
export function getAuthConfig(): AuthConfig {
  return {
    userPoolId: process.env.USER_POOL_ID ?? AUTH_DEFAULTS.userPoolId,
    userPoolClientId: process.env.USER_POOL_CLIENT_ID ?? AUTH_DEFAULTS.userPoolClientId,
  };
}

/**
 * Refresh-orchestration configuration for the `POST /refresh` and
 * `GET /refresh/status` handlers (Task 10.2, Requirements 10.3, 10.4).
 *
 * The refresh state machine (Task 10.1) is wired in `backend.ts`, which injects
 * `REFRESH_STATE_MACHINE_ARN` and `HUB_REGION` as Lambda environment variables
 * on both refresh handlers. Defaults are non-secret, well-formed placeholders so
 * local typecheck and unit tests resolve a value without a populated
 * environment. Never put secrets here.
 */
export interface RefreshConfig {
  /** ARN of the refresh Step Functions state machine (`StartExecution` target). */
  stateMachineArn: string;
  /** AWS region hosting the state machine. */
  region: string;
}

const REFRESH_DEFAULTS = {
  stateMachineArn:
    'arn:aws:states:us-east-1:123456789012:stateMachine:PLACEHOLDER_REFRESH_STATE_MACHINE',
  region: 'us-east-1',
} as const;

/** Resolve the refresh configuration from the environment, falling back to defaults. */
export function getRefreshConfig(): RefreshConfig {
  return {
    stateMachineArn: process.env.REFRESH_STATE_MACHINE_ARN ?? REFRESH_DEFAULTS.stateMachineArn,
    region: process.env.HUB_REGION ?? process.env.AWS_REGION ?? REFRESH_DEFAULTS.region,
  };
}
