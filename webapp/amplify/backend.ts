import { defineBackend } from '@aws-amplify/backend';
import { Stack } from 'aws-cdk-lib';
import {
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  type IHttpRouteAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Function as LambdaFunction, type IFunction } from 'aws-cdk-lib/aws-lambda';
import { CfnOutput } from 'aws-cdk-lib';

import {
  OAuthScope,
  UserPoolClientIdentityProvider,
  type UserPool,
} from 'aws-cdk-lib/aws-cognito';

import { auth } from './auth/resource';
import { summary } from './functions/summary/resource';
import { spaces } from './functions/spaces/resource';
import { dashboard } from './functions/dashboard/resource';
import { graph } from './functions/graph/resource';
import { context } from './functions/context/resource';
import { chat } from './functions/chat/resource';
import { mcpTools } from './functions/mcp-tools/resource';
import { mcpExternal } from './functions/mcp-external/resource';
import { chatHistory } from './functions/chat-history/resource';
import { settings } from './functions/settings/resource';
import { refresh } from './functions/refresh/resource';
import { refreshStatus } from './functions/refresh-status/resource';
import { createSpace } from './functions/create-space/resource';
import { a2a } from './functions/a2a/resource';

import { CognitoJwtAuthorizer } from './api/jwt-authorizer';
import { LambdaProxyIntegration } from './api/lambda-integration';
import { RefreshPipeline } from './refresh/resource';
import { CreateSpaceWorker } from './spaces/resource';
import { McpGateway } from './mcp/resource';
import { ExternalMcpGateway } from './mcp-external/resource';
import { InvestigateDurableFunction } from './investigate/resource';

/**
 * Amplify Gen 2 backend — API layer shell (Task 3, Requirements 1.2, 2.2–2.6).
 *
 * This wires the cross-cutting auth/authz skeleton for the serverless API:
 *   - An API Gateway HTTP API whose DEFAULT authorizer is a Cognito JWT
 *     authorizer bound to the Task 2 user pool, so EVERY route requires a valid
 *     access token and unauthenticated requests are rejected before any handler
 *     runs (Req 1.2, 2.6).
 *   - Route stubs for the planned routes (Task 4–10 fill in the logic). Admin
 *     routes (`PUT /context`, `POST /refresh`, `GET /refresh/status`) also
 *     assert the `Admin` group claim in-handler via the shared authz helper
 *     (Req 2.3–2.5).
 *   - A streaming Lambda Function URL for `/chat` (response streaming enabled),
 *     the transport shell for the Bedrock chat stream (full proxy in Task 9).
 *   - A per-function (per-route) least-privilege IAM role. Amplify gives each
 *     `defineFunction` its own execution role; the scoped policy statements
 *     below are minimal placeholders tightened in each route's own task.
 */
export const backend = defineBackend({
  auth,
  summary,
  spaces,
  dashboard,
  graph,
  context,
  chat,
  mcpTools,
  mcpExternal,
  chatHistory,
  settings,
  refresh,
  refreshStatus,
  createSpace,
  a2a,
});

// ---------------------------------------------------------------------------
// Backend resource config (non-secret ids; source of truth is repo config.env
// / the hosting env). Defaults mirror `.env.example` so synth/typecheck work
// without a populated environment. Never put secrets here.
// ---------------------------------------------------------------------------
const apiStack = backend.createStack('api');
const { account, region } = Stack.of(apiStack);

const config = {
  hubBucket: process.env.HUB_BUCKET ?? 'devops-agent-hub-123456789012-us-east-1',
  manifestKey: 'raw/_manifest.json',
  businessContextKey: 'hub/business_context.json',
  // Neptune Analytics graph endpoint used by GET /graph (Task 8). The handler
  // derives the graph id from this host; a fully-qualified endpoint keeps the
  // config non-secret and mirrors `.env.example`.
  neptuneGraphEndpoint:
    process.env.NEPTUNE_GRAPH_ENDPOINT ?? 'g-0123456789.us-east-1.neptune-graph.amazonaws.com',
  // Bedrock managed knowledge base id + chat model, used by POST /chat (Task 9).
  // The KB id is resolved at deploy time; the default is a non-secret
  // placeholder so synth/typecheck work without a populated environment.
  kbId: process.env.KB_ID ?? 'PLACEHOLDER_KB_ID',
  kbChatModelArn:
    process.env.KB_CHAT_MODEL_ARN ??
    `arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
  // Refresh fan-out config (scalable refresh, Task 26). Non-secret ids mirroring
  // config.env; injected onto the Python worker Lambdas by the RefreshPipeline
  // construct so the reused hub scripts resolve their config from the environment.
  neptuneGraphName: process.env.NEPTUNE_GRAPH_NAME ?? 'devops-agent-topology',
  neptuneLoadRoleName: process.env.NEPTUNE_LOAD_ROLE_NAME ?? 'DevOpsAgentNeptuneLoadRole',
  kbName: process.env.KB_NAME ?? 'devops-agent-kb',
  kbDocsPrefix: process.env.KB_DOCS_PREFIX ?? 'kb/',
  collectorRoleName: process.env.COLLECTOR_ROLE_NAME ?? 'DevOpsAgentCollectorRole',
  externalId: process.env.EXTERNAL_ID ?? 'devops-agent-hub-123456789012',
  mgmtAccountId: process.env.MGMT_ACCOUNT_ID ?? '210987654321',
  // Optional role assumed to list Organizations accounts (management account).
  mgmtRoleArn: process.env.MGMT_ROLE_ARN,
  // Max accounts collected in parallel (throttle bound for the Distributed Map).
  collectMaxConcurrency: Number(process.env.REFRESH_MAX_CONCURRENCY ?? '50'),
} as const;

// Allowed browser origin(s) for CORS on the HTTP API and the /chat Function URL
// (Task 19 deployment wiring). Set `APP_ORIGIN` in the hosting/pipeline
// environment to the deployed SPA origin (comma-separate to allow more than
// one, e.g. a custom domain + the amplifyapp.com URL). Defaults to `*` so a
// sandbox / preview deploy works without extra configuration; tighten it to the
// real origin(s) in production. No credentials cross this boundary — the SPA
// only sends its Cognito JWT — but a scoped origin still limits who may call
// the API from a browser.
const allowedOrigins = (process.env.APP_ORIGIN ?? '*')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const bucketArn = `arn:aws:s3:::${config.hubBucket}`;
const objectArn = (key: string) => `${bucketArn}/${key}`;
// Neptune Analytics graph ARN — narrowed to the specific graph id derived from
// the configured endpoint host (leading `g-…` label), not a wildcard (Task 8).
const neptuneGraphId = config.neptuneGraphEndpoint.split('.')[0] ?? '*';
const neptuneGraphArn = `arn:aws:neptune-graph:${region}:${account}:graph/${neptuneGraphId}`;
// Bedrock KB + model ARNs for POST /chat (Task 9), scoped to the specific
// knowledge base and to Bedrock model/inference-profile invocation.
const knowledgeBaseArn = `arn:aws:bedrock:${region}:${account}:knowledge-base/${config.kbId}`;
const bedrockModelArns = [
  config.kbChatModelArn,
  // A cross-region inference profile (e.g. `us.anthropic…`) routes model
  // invocation to the underlying foundation model in MULTIPLE regions (us-east-1,
  // us-east-2, us-west-2), so InvokeModel must be allowed on the foundation-model
  // ARN in every region the profile spans — not just this one — or the
  // cross-region legs get AccessDenied. Foundation-model ARNs are AWS-owned
  // (account-less) and this grants InvokeModel only.
  `arn:aws:bedrock:*::foundation-model/*`,
  `arn:aws:bedrock:${region}:${account}:inference-profile/*`,
];

// ---------------------------------------------------------------------------
// Refresh orchestration (Task 26) — scalable Distributed Map fan-out.
//
// A Step Functions Standard state machine fans account collection out across a
// Distributed Map (bounded concurrency, per-account isolation), then assembles
// the manifest and runs the finalize stages. All compute is Python Lambda
// (reusing the hub `scripts/`) — no Docker anywhere, so `ampx pipeline-deploy`
// builds it without a Docker daemon. See `refresh/resource.ts`.
// ---------------------------------------------------------------------------
const refreshStack = backend.createStack('refresh');
const refreshPipeline = new RefreshPipeline(refreshStack, 'RefreshPipeline', {
  hubBucket: config.hubBucket,
  hubRegion: region,
  neptuneGraphName: config.neptuneGraphName,
  neptuneLoadRoleName: config.neptuneLoadRoleName,
  kbName: config.kbName,
  kbDocsPrefix: config.kbDocsPrefix,
  collectorRoleName: config.collectorRoleName,
  externalId: config.externalId,
  hubAccountId: account,
  mgmtAccountId: config.mgmtAccountId,
  ...(config.mgmtRoleArn ? { mgmtRoleArn: config.mgmtRoleArn } : {}),
  collectMaxConcurrency: config.collectMaxConcurrency,
});

// ---------------------------------------------------------------------------
// Create-agent-space worker — the Admin-only `POST /spaces` compute.
//
// Like the refresh fan-out, the actual DevOps Agent call runs in a Python
// Lambda (reusing `scripts/create_space_worker.py` + the boto3 layer) because
// the `devops-agent` client only exists in the recent boto3, not the Node SDK.
// The Node `POST /spaces` route authorizes the Admin caller and validates the
// request, then invokes this worker. See `spaces/resource.ts`.
// ---------------------------------------------------------------------------
const spacesStack = backend.createStack('spaces');
const createSpaceWorker = new CreateSpaceWorker(spacesStack, 'CreateSpaceWorker', {
  hubRegion: region,
  collectorRoleName: config.collectorRoleName,
  externalId: config.externalId,
  hubAccountId: account,
  mgmtAccountId: config.mgmtAccountId,
  ...(config.mgmtRoleArn ? { mgmtRoleArn: config.mgmtRoleArn } : {}),
});

// ---------------------------------------------------------------------------
// Async A2A `investigate` skill (Task 38) — Lambda DURABLE FUNCTION.
//
// The DevOps Agent `investigate` skill runs a long, multi-step analysis. Rather
// than hold an API request open for minutes, it runs in a durable function that
// starts the investigation, polls the A2A task with a durable `waitForCondition`
// (no compute charge while waiting), and then PAUSES on a human-in-the-loop
// callback so a reviewer approves/dismisses the findings before the execution
// closes. The `a2a` route lambda starts it (async, named durable execution),
// polls its status (`GetDurableExecution`), and releases the callback. Durable
// config can only be set at create time, so this is a raw CDK construct (not
// `defineFunction`). See `investigate/resource.ts`.
// ---------------------------------------------------------------------------
const investigateStack = backend.createStack('investigate');
const investigate = new InvestigateDurableFunction(investigateStack, 'Investigate', {
  hubBucket: config.hubBucket,
  hubRegion: region,
});

// ---------------------------------------------------------------------------
// Chat memory + app settings store (persistent chat-memory feature).
//
// Storage is S3-backed in the SAME hub bucket as the manifest / business
// context — no separate datastore or extra dependency (reuses the S3 client the
// read APIs already use), which keeps the deployment's dependency tree small
// and `npm ci`-consistent. Layout:
//   - hub/chat_history/<cognitoSub>.json — one object per user: their ordered
//     chat turns. Per-user keys keep each user's memory private (a caller only
//     ever reads/writes their own object).
//   - hub/app_settings.json — the singleton app settings (retention days).
// S3 has no per-item TTL, so the admin-configured retention window (≤30 days)
// is enforced by PRUNING on every read and write (see functions/shared/
// chatHistory.ts): messages older than `now - retentionDays` are dropped and
// never returned.
// ---------------------------------------------------------------------------
const chatHistoryPrefixArn = objectArn('hub/chat_history/*');
const appSettingsArn = objectArn('hub/app_settings.json');

// ---------------------------------------------------------------------------
// Disable public self-service sign-up (admin-create-only).
//
// `defineAuth` leaves the pool's self-service `SignUp` flow ENABLED by default.
// This deployment provisions access administratively (an admin creates each
// user, then assigns them to exactly one of the `Executive` / `Admin` groups —
// see auth/resource.ts), so the public sign-up flow must be off. Setting
// `adminCreateUserConfig.allowAdminCreateUserOnly = true` on the L1 user pool
// blocks the public `SignUp` API / Hosted UI sign-up for EVERYONE (pool-wide,
// not per group); `AdminCreateUser`, sign-in, and group assignment are
// unaffected.
// ---------------------------------------------------------------------------
const { cfnUserPool } = backend.auth.resources.cfnResources;
cfnUserPool.adminCreateUserConfig = {
  allowAdminCreateUserOnly: true,
};

// ---------------------------------------------------------------------------
// Cognito JWT authorizer — validates the access token on every route.
// ---------------------------------------------------------------------------
const { userPool, userPoolClient } = backend.auth.resources;
const jwtAuthorizer: IHttpRouteAuthorizer = new CognitoJwtAuthorizer('ApiJwtAuthorizer', {
  userPoolId: userPool.userPoolId,
  userPoolClientIds: [userPoolClient.userPoolClientId],
  region,
});

// ---------------------------------------------------------------------------
// HTTP API — default authorizer applies to every route unless overridden.
// ---------------------------------------------------------------------------
const httpApi = new HttpApi(apiStack, 'DevOpsObservatoryHttpApi', {
  apiName: 'devops-observatory-api',
  description: 'DevOps Observatory API layer (Cognito-JWT protected).',
  defaultAuthorizer: jwtAuthorizer,
  corsPreflight: {
    allowHeaders: ['authorization', 'content-type'],
    allowMethods: [
      CorsHttpMethod.GET,
      CorsHttpMethod.PUT,
      CorsHttpMethod.POST,
      CorsHttpMethod.DELETE,
      CorsHttpMethod.OPTIONS,
    ],
    // Deployed SPA origin(s) from `APP_ORIGIN` (Task 19 deployment wiring);
    // defaults to `['*']` for sandbox/preview when unset.
    allowOrigins: allowedOrigins,
  },
});

// Register a route with the shared JWT authorizer (default) + a per-route
// Lambda proxy integration.
const route = (path: string, method: HttpMethod, lambda: IFunction, integrationId: string) => {
  httpApi.addRoutes({
    path,
    methods: [method],
    integration: new LambdaProxyIntegration(integrationId, lambda),
  });
};

route('/summary', HttpMethod.GET, backend.summary.resources.lambda, 'SummaryIntegration');
route('/spaces', HttpMethod.GET, backend.spaces.resources.lambda, 'SpacesIntegration');
// Create agent space (Admin, asserted in-handler): invokes the Python worker.
// POST /spaces creates one synchronously; POST /spaces/batch fans creation out
// asynchronously across many accounts (both handled by the create-space fn).
route('/spaces', HttpMethod.POST, backend.createSpace.resources.lambda, 'CreateSpaceIntegration');
route('/spaces/batch', HttpMethod.POST, backend.createSpace.resources.lambda, 'CreateSpaceBatchIntegration');
// Per-space Agent-to-Agent (A2A) routes (Admin only): store/remove/status the
// space's Bearer token and invoke its `chat` skill. Path-parameterized routes
// coexist with the static `/spaces` + `/spaces/batch` above (exact matches win).
const a2aLambda = backend.a2a.resources.lambda;
route('/a2a/spaces', HttpMethod.GET, a2aLambda, 'A2aConfiguredSpacesIntegration');
route('/spaces/{spaceId}/a2a-token', HttpMethod.PUT, a2aLambda, 'A2aTokenPutIntegration');
route('/spaces/{spaceId}/a2a-token', HttpMethod.DELETE, a2aLambda, 'A2aTokenDeleteIntegration');
route('/spaces/{spaceId}/a2a-status', HttpMethod.GET, a2aLambda, 'A2aStatusIntegration');
// A2A chat is async (durable) to bypass the API Gateway 30s integration limit —
// the DevOps Agent chat is synchronous but frequently slower than 30s. Start
// returns an execution name; the browser polls the status route for the answer.
route('/spaces/{spaceId}/a2a/chat', HttpMethod.POST, a2aLambda, 'A2aChatIntegration');
route('/spaces/{spaceId}/a2a/chat/{execName}', HttpMethod.GET, a2aLambda, 'A2aChatStatusIntegration');
// Async `investigate` skill (Task 38): start + poll + human-in-the-loop
// approve/reject. Any authenticated user (same as chat).
route('/spaces/{spaceId}/a2a/investigate', HttpMethod.POST, a2aLambda, 'A2aInvestigateStartIntegration');
route(
  '/spaces/{spaceId}/a2a/investigate/{execName}',
  HttpMethod.GET,
  a2aLambda,
  'A2aInvestigateStatusIntegration',
);
route(
  '/spaces/{spaceId}/a2a/investigate/{execName}/approve',
  HttpMethod.POST,
  a2aLambda,
  'A2aInvestigateApproveIntegration',
);
route(
  '/spaces/{spaceId}/a2a/investigate/{execName}/reject',
  HttpMethod.POST,
  a2aLambda,
  'A2aInvestigateRejectIntegration',
);
route('/dashboard', HttpMethod.GET, backend.dashboard.resources.lambda, 'DashboardIntegration');
route('/graph', HttpMethod.GET, backend.graph.resources.lambda, 'GraphIntegration');
// Business context: GET (any) + PUT (Admin, asserted in-handler) share a handler.
route('/context', HttpMethod.GET, backend.context.resources.lambda, 'ContextGetIntegration');
route('/context', HttpMethod.PUT, backend.context.resources.lambda, 'ContextPutIntegration');
// Chat runs over the JWT-authorized HTTP API (non-streaming) rather than a
// public streaming Function URL, which this deployment's environment blocks.
route('/chat', HttpMethod.POST, backend.chat.resources.lambda, 'ChatIntegration');
// Chat memory (persistent history): GET returns the caller's own history,
// DELETE clears it — both scoped to the caller's Cognito sub in-handler.
route('/chat/history', HttpMethod.GET, backend.chatHistory.resources.lambda, 'ChatHistoryGetIntegration');
route('/chat/history', HttpMethod.DELETE, backend.chatHistory.resources.lambda, 'ChatHistoryDeleteIntegration');
// App settings: GET (any) + PUT (Admin, asserted in-handler) share a handler.
route('/settings', HttpMethod.GET, backend.settings.resources.lambda, 'SettingsGetIntegration');
route('/settings', HttpMethod.PUT, backend.settings.resources.lambda, 'SettingsPutIntegration');
// Refresh (Admin, asserted in-handler): POST starts the fan-out state machine,
// GET describes it (in-progress / progress / completed / failed). Task 26.
route('/refresh', HttpMethod.POST, backend.refresh.resources.lambda, 'RefreshIntegration');
route('/refresh/status', HttpMethod.GET, backend.refreshStatus.resources.lambda, 'RefreshStatusIntegration');

// ---------------------------------------------------------------------------
// Per-route least-privilege IAM (each handler already has its own role).
// These statements are minimal placeholders tightened in Tasks 4, 5, 8, 9, 10.
// ---------------------------------------------------------------------------
const grantS3Read = (fn: typeof backend.summary, keys: string[]) =>
  fn.resources.lambda.addToRolePolicy(
    new PolicyStatement({ actions: ['s3:GetObject'], resources: keys.map(objectArn) }),
  );

// Read handlers: manifest (+ business context for label overlay).
grantS3Read(backend.summary, [config.manifestKey, config.businessContextKey]);
grantS3Read(backend.spaces, [config.manifestKey, config.businessContextKey]);
grantS3Read(backend.dashboard, [config.manifestKey, config.businessContextKey]);
grantS3Read(backend.graph, [config.businessContextKey]);

// /graph — read-only Neptune Analytics openCypher via `ExecuteQuery` (Task 8).
// `neptune-graph:ReadDataViaQuery` is the action `ExecuteQuery` authorizes for a
// read query; scoped to the single graph ARN. No write/delete-via-query grants.
backend.graph.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'neptune-graph:ReadDataViaQuery',
      'neptune-graph:GetGraph',
      'neptune-graph:GetQueryStatus',
    ],
    resources: [neptuneGraphArn],
  }),
);

// /context — read + write the single business-context object (Task 5.2).
backend.context.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [objectArn(config.businessContextKey)],
  }),
);
// PUT /context validates that referenced accounts exist, which requires reading
// the manifest (Requirement 5.7).
backend.context.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [objectArn(config.manifestKey)],
  }),
);

// /refresh — start the state machine (single-flight via ListExecutions) + read
// its status (DescribeExecution) and the collect Distributed Map's progress
// (ListMapRuns / DescribeMapRun). Least-privilege via the CDK grants + a scoped
// ListExecutions statement; the map-run reads are read-only status calls.
const refreshLambda = backend.refresh.resources.lambda;
const refreshStatusLambda = backend.refreshStatus.resources.lambda;
refreshPipeline.stateMachine.grantStartExecution(refreshLambda);
refreshLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['states:ListExecutions'],
    resources: [refreshPipeline.stateMachine.stateMachineArn],
  }),
);
refreshPipeline.stateMachine.grantRead(refreshStatusLambda);
refreshStatusLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['states:ListMapRuns', 'states:DescribeMapRun'],
    resources: ['*'],
  }),
);
for (const fn of [refreshLambda, refreshStatusLambda]) {
  const lambda = fn as LambdaFunction;
  lambda.addEnvironment('REFRESH_STATE_MACHINE_ARN', refreshPipeline.stateMachine.stateMachineArn);
  lambda.addEnvironment('HUB_REGION', region);
}

// POST /spaces (Admin) — read the manifest to verify the target account exists,
// then invoke the Python create-space worker. Least-privilege: manifest read +
// InvokeFunction on the single worker Lambda only.
const createSpaceLambda = backend.createSpace.resources.lambda;
createSpaceLambda.addToRolePolicy(
  new PolicyStatement({ actions: ['s3:GetObject'], resources: [objectArn(config.manifestKey)] }),
);
createSpaceWorker.worker.grantInvoke(createSpaceLambda);
{
  const lambda = createSpaceLambda as LambdaFunction;
  lambda.addEnvironment('HUB_BUCKET', config.hubBucket);
  lambda.addEnvironment('MANIFEST_KEY', config.manifestKey);
  lambda.addEnvironment('CREATE_SPACE_WORKER_ARN', createSpaceWorker.worker.functionArn);
  lambda.addEnvironment('HUB_REGION', region);
}

// A2A routes (Admin) — per-space Bearer tokens live in Secrets Manager under
// `devops-observatory/a2a/*`; the handler reads the manifest to verify the
// space and calls the A2A remote server over HTTPS (no AWS API, so no extra
// grant for the chat call). Least-privilege: manifest read + Secrets Manager
// CRUD scoped to the A2A secret name prefix only.
const a2aLambdaFn = backend.a2a.resources.lambda;
a2aLambdaFn.addToRolePolicy(
  new PolicyStatement({ actions: ['s3:GetObject'], resources: [objectArn(config.manifestKey)] }),
);
a2aLambdaFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'secretsmanager:GetSecretValue',
      'secretsmanager:PutSecretValue',
      'secretsmanager:CreateSecret',
      'secretsmanager:DeleteSecret',
      'secretsmanager:DescribeSecret',
    ],
    // CreateSecret is authorized on the prefix; the trailing `-??????` matches
    // the random suffix Secrets Manager appends to the ARN of a created secret.
    resources: [
      `arn:aws:secretsmanager:${region}:${account}:secret:devops-observatory/a2a/*`,
    ],
  }),
);
// ListSecrets does not support resource-level scoping, so it is granted on `*`.
// It returns metadata only (names) — used to list which spaces have a token.
a2aLambdaFn.addToRolePolicy(
  new PolicyStatement({ actions: ['secretsmanager:ListSecrets'], resources: ['*'] }),
);
// Async `investigate` (Task 38): the a2a lambda starts the durable function
// (async Invoke), polls it (GetDurableExecution), and releases the
// human-in-the-loop callback (Send…CallbackSuccess/Failure). It also reads/
// writes the S3 side-channel index objects the durable function coordinates on.
investigate.alias.grantInvoke(a2aLambdaFn);
a2aLambdaFn.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'lambda:GetDurableExecution',
      'lambda:SendDurableExecutionCallbackSuccess',
      'lambda:SendDurableExecutionCallbackFailure',
    ],
    // Durable-execution actions are authorized against the function ARN with the
    // `:*` qualifier (per the Lambda durable-functions security reference).
    resources: [investigate.fn.functionArn, `${investigate.fn.functionArn}:*`],
  }),
);
a2aLambdaFn.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [objectArn('hub/a2a_investigations/*')],
  }),
);
{
  const lambda = a2aLambdaFn as LambdaFunction;
  lambda.addEnvironment('HUB_BUCKET', config.hubBucket);
  lambda.addEnvironment('MANIFEST_KEY', config.manifestKey);
  lambda.addEnvironment('HUB_REGION', region);
  lambda.addEnvironment('A2A_INVESTIGATE_FUNCTION_ARN', investigate.qualifiedArn);
}

// /chat — least-privilege Bedrock access for the AgenticRetrieveStream proxy
// (Task 9). Two scoped statements:
//   1. Agentic KB retrieval on the single knowledge-base ARN. `AgenticRetrieve`
//      / `Retrieve` cover the streaming and non-streaming retrieve paths.
//   2. Model invocation (`bedrock:InvokeModel*`) on the chat model / inference
//      profile that synthesizes the answer, scoped to Bedrock model ARNs.
// AgenticRetrieveStream / AgenticRetrieve do NOT support resource-level
// permissions (per the Bedrock service authorization reference their Resource
// types column is empty), so Bedrock authorizes them only on Resource:"*".
// Scoping them to the KB ARN yields an implicit deny ("no identity-based policy
// allows the bedrock:AgenticRetrieveStream action"). Grant them on "*" — they
// are Read-only agentic retrieval and the specific KB is selected by the
// request's `retrievers` config (and there is a single KB in this account).
backend.chat.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:AgenticRetrieveStream', 'bedrock:AgenticRetrieve'],
    resources: ['*'],
  }),
);
// Retrieve DOES support resource-level permissions — keep it scoped to the KB.
backend.chat.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:Retrieve'],
    resources: [knowledgeBaseArn],
  }),
);
backend.chat.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: bedrockModelArns,
  }),
);
// The chat model is a cross-region inference profile; the agentic-retrieve flow
// resolves it via GetInferenceProfile before invoking, so grant that read on
// the account's inference profiles.
backend.chat.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:GetInferenceProfile'],
    resources: [`arn:aws:bedrock:${region}:${account}:inference-profile/*`],
  }),
);

// ---------------------------------------------------------------------------
// EDO MCP tools (Task 29, Requirement 15) — the AgentCore Gateway Lambda target.
// It reuses the shared chat (KB agentic retrieve + model invoke), graph
// (read-only Neptune query), and hub-data (S3 read) modules, so its role gets
// the UNION of those least-privilege grants — nothing more (read-only).
// ---------------------------------------------------------------------------
const mcpToolsLambda = backend.mcpTools.resources.lambda;
// KB agentic retrieve (Resource:"*" per the Bedrock authorization reference) +
// scoped Retrieve on the KB + model invoke + inference-profile read.
mcpToolsLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:AgenticRetrieveStream', 'bedrock:AgenticRetrieve'],
    resources: ['*'],
  }),
);
mcpToolsLambda.addToRolePolicy(
  new PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [knowledgeBaseArn] }),
);
mcpToolsLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: bedrockModelArns,
  }),
);
mcpToolsLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:GetInferenceProfile'],
    resources: [`arn:aws:bedrock:${region}:${account}:inference-profile/*`],
  }),
);
// Read-only Neptune Analytics query (same as GET /graph).
mcpToolsLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['neptune-graph:ReadDataViaQuery', 'neptune-graph:GetGraph', 'neptune-graph:GetQueryStatus'],
    resources: [neptuneGraphArn],
  }),
);
// S3 read of the manifest + business context (label overlay + get_business_context).
mcpToolsLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [objectArn(config.manifestKey), objectArn(config.businessContextKey)],
  }),
);
{
  const lambda = mcpToolsLambda as LambdaFunction;
  lambda.addEnvironment('HUB_BUCKET', config.hubBucket);
  lambda.addEnvironment('MANIFEST_KEY', config.manifestKey);
  lambda.addEnvironment('BUSINESS_CONTEXT_KEY', config.businessContextKey);
  lambda.addEnvironment('NEPTUNE_GRAPH_ENDPOINT', config.neptuneGraphEndpoint);
  lambda.addEnvironment('KB_ID', config.kbId);
  lambda.addEnvironment('KB_CHAT_MODEL_ARN', config.kbChatModelArn);
  lambda.addEnvironment('HUB_REGION', region);
}

// AgentCore Gateway exposing the MCP tools Lambda as an MCP server. Its own
// stack keeps the AgentCore resources isolated from the API stack.
const mcpStack = backend.createStack('mcp');
new McpGateway(mcpStack, 'McpGateway', { toolsLambda: mcpToolsLambda });

// ---------------------------------------------------------------------------
// External AI application access via MCP (Task 39, Requirement 16).
//
// A SECOND AgentCore Gateway lets any EDO user connect their own AI app (Kiro,
// Claude, chatbots — any MCP client) with their EXISTING EDO credentials:
//   - The user pool gains a Hosted UI domain + a DEDICATED external app client
//     (public, Authorization Code + PKCE, no secret). A separate client id
//     means external access is scoped/revoked independently of SPA sign-in.
//   - The gateway validates JWTs against the pool's OIDC discovery document
//     with `allowedClients = [external client id]` (Cognito ACCESS tokens
//     carry `client_id`, not `aud`).
//   - Its target is the SEPARATE `mcp-external` Lambda, which enforces the
//     Admin `externalMcpEnabled` flag at request time — so disabling external
//     access never affects the webapp chat or the internal gateway.
// ---------------------------------------------------------------------------
const authUserPool = backend.auth.resources.userPool as UserPool;
const branchName = process.env.AWS_BRANCH ?? 'sandbox';
const branchSuffix =
  branchName.toLowerCase().replace(/[^0-9a-z]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) ||
  'sandbox';

// Hosted UI domain — required for the OAuth Authorization Code + PKCE flow the
// external MCP clients drive. Prefix must be REGION-UNIQUE across all AWS
// customers, lowercase, and must not contain "aws"/"cognito": namespace it with
// the account id + branch.
const hostedUiDomain = authUserPool.addDomain('ExternalMcpDomain', {
  cognitoDomain: { domainPrefix: `edo-mcp-${account}-${branchSuffix}` },
});

// Dedicated EXTERNAL app client: Authorization Code + PKCE (public client — no
// secret; PKCE protects the exchange). Callback = mcp-remote's local listener
// (default port 3334, path /oauth/callback); localhost is the one place Cognito
// allows http callbacks. Scopes: OIDC basics only (NOTE: no `offline_access` —
// Cognito issues refresh tokens for the code flow without it, and requesting an
// unknown scope fails the /authorize call).
const externalMcpClient = authUserPool.addClient('ExternalMcpClient', {
  userPoolClientName: 'edo-external-mcp',
  generateSecret: false,
  supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
  preventUserExistenceErrors: true,
  oAuth: {
    flows: { authorizationCodeGrant: true },
    scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
    callbackUrls: [
      'http://localhost:3334/oauth/callback',
      'http://127.0.0.1:3334/oauth/callback',
    ],
  },
});

const externalMcpStack = backend.createStack('mcpExternal');
const mcpExternalLambda = backend.mcpExternal.resources.lambda;
const externalGateway = new ExternalMcpGateway(externalMcpStack, 'ExternalMcpGateway', {
  toolsLambda: mcpExternalLambda,
  userPoolId: authUserPool.userPoolId,
  externalClientId: externalMcpClient.userPoolClientId,
});

// Least-privilege for the external tools Lambda — the union of what its tools
// need, all read-only:
//   - KB agentic retrieve + scoped Retrieve + model invoke + inference-profile
//     read (search_kb / ask_devops_observatory — same grants as /chat).
//   - Read-only Neptune Analytics query (query_topology_graph + GraphRAG facts).
//   - S3 read of the manifest, business context, and app settings (the
//     enable/disable flag is read per call).
//   - Secrets Manager read of the Admin-stored A2A tokens (ask_agent_space) +
//     ListSecrets (metadata only, for list_agent_spaces).
mcpExternalLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:AgenticRetrieveStream', 'bedrock:AgenticRetrieve'],
    resources: ['*'],
  }),
);
mcpExternalLambda.addToRolePolicy(
  new PolicyStatement({ actions: ['bedrock:Retrieve'], resources: [knowledgeBaseArn] }),
);
mcpExternalLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
    resources: bedrockModelArns,
  }),
);
mcpExternalLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['bedrock:GetInferenceProfile'],
    resources: [`arn:aws:bedrock:${region}:${account}:inference-profile/*`],
  }),
);
mcpExternalLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['neptune-graph:ReadDataViaQuery', 'neptune-graph:GetGraph', 'neptune-graph:GetQueryStatus'],
    resources: [neptuneGraphArn],
  }),
);
mcpExternalLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [
      objectArn(config.manifestKey),
      objectArn(config.businessContextKey),
      appSettingsArn,
    ],
  }),
);
mcpExternalLambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
    resources: [`arn:aws:secretsmanager:${region}:${account}:secret:devops-observatory/a2a/*`],
  }),
);
// ListSecrets does not support resource-level scoping (metadata only).
mcpExternalLambda.addToRolePolicy(
  new PolicyStatement({ actions: ['secretsmanager:ListSecrets'], resources: ['*'] }),
);
{
  const lambda = mcpExternalLambda as LambdaFunction;
  lambda.addEnvironment('HUB_BUCKET', config.hubBucket);
  lambda.addEnvironment('MANIFEST_KEY', config.manifestKey);
  lambda.addEnvironment('BUSINESS_CONTEXT_KEY', config.businessContextKey);
  lambda.addEnvironment('NEPTUNE_GRAPH_ENDPOINT', config.neptuneGraphEndpoint);
  lambda.addEnvironment('KB_ID', config.kbId);
  lambda.addEnvironment('KB_CHAT_MODEL_ARN', config.kbChatModelArn);
  lambda.addEnvironment('HUB_REGION', region);
}

// ---------------------------------------------------------------------------
// Chat memory + settings access (persistent chat-memory feature). S3-backed in
// the hub bucket; least-privilege per route, scoped to the specific objects:
//   - /chat          reads the retention setting + reads/writes the caller's
//                    per-user history object (append is read-modify-write).
//   - /chat/history  reads/writes/deletes the caller's history object + reads
//                    the retention setting (to prune on read).
//   - /settings      reads + writes the singleton settings object.
// Per-user history keys live under `hub/chat_history/*`; a wildcard object ARN
// scopes access to that prefix (the caller can only form its own sub's key).
// ---------------------------------------------------------------------------
backend.chat.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [chatHistoryPrefixArn],
  }),
);
backend.chat.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['s3:GetObject'], resources: [appSettingsArn] }),
);
// Chat applies the admin-authored org system prompt from the business context
// and grounds answers in the Neptune topology (GraphRAG, Task 29.4): read the
// business context + manifest (freshness) and run read-only graph queries.
backend.chat.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject'],
    resources: [objectArn(config.businessContextKey), objectArn(config.manifestKey)],
  }),
);
backend.chat.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['neptune-graph:ReadDataViaQuery', 'neptune-graph:GetGraph', 'neptune-graph:GetQueryStatus'],
    resources: [neptuneGraphArn],
  }),
);
backend.chatHistory.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
    resources: [chatHistoryPrefixArn],
  }),
);
backend.chatHistory.resources.lambda.addToRolePolicy(
  new PolicyStatement({ actions: ['s3:GetObject'], resources: [appSettingsArn] }),
);
backend.settings.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['s3:GetObject', 's3:PutObject'],
    resources: [appSettingsArn],
  }),
);

// ---------------------------------------------------------------------------
// Shared config env for handlers (non-secret ids). Route-specific vars (graph
// endpoint, KB id, state machine ARN) are injected in each route's own task.
// ---------------------------------------------------------------------------
for (const fn of [
  backend.summary,
  backend.spaces,
  backend.dashboard,
  backend.graph,
  backend.context,
]) {
  // Amplify types resources.lambda as IFunction; the instance is a Function.
  const lambda = fn.resources.lambda as LambdaFunction;
  lambda.addEnvironment('HUB_BUCKET', config.hubBucket);
  lambda.addEnvironment('MANIFEST_KEY', config.manifestKey);
  lambda.addEnvironment('BUSINESS_CONTEXT_KEY', config.businessContextKey);
}

// /graph needs the Neptune Analytics endpoint + region to run `ExecuteQuery`
// (the handler derives the graph id from the endpoint host). Injected only on
// the graph function to keep every other role's env minimal.
{
  const graphLambda = backend.graph.resources.lambda as LambdaFunction;
  graphLambda.addEnvironment('NEPTUNE_GRAPH_ENDPOINT', config.neptuneGraphEndpoint);
  graphLambda.addEnvironment('HUB_REGION', region);
}

// /chat needs the knowledge-base id + chat model ARN + region to run
// AgenticRetrieveStream (Task 9). Injected only on the chat function to keep
// every other role's env minimal.
{
  const chatLambda = backend.chat.resources.lambda as LambdaFunction;
  chatLambda.addEnvironment('KB_ID', config.kbId);
  chatLambda.addEnvironment('KB_CHAT_MODEL_ARN', config.kbChatModelArn);
  chatLambda.addEnvironment('HUB_REGION', region);
  // Chat memory persistence (best-effort) reads/writes the S3-backed store.
  chatLambda.addEnvironment('HUB_BUCKET', config.hubBucket);
  // GraphRAG (Task 29.4): the handler derives the graph id from the endpoint.
  chatLambda.addEnvironment('NEPTUNE_GRAPH_ENDPOINT', config.neptuneGraphEndpoint);
  // Auth is enforced by the HTTP API's Cognito JWT authorizer before the
  // handler runs, so no in-handler token verification (and no pool/client env)
  // is needed for the /chat route.
}

// Chat-memory + settings handlers read/write the S3-backed store; they need the
// hub bucket + region.
for (const fn of [backend.chatHistory, backend.settings]) {
  const lambda = fn.resources.lambda as LambdaFunction;
  lambda.addEnvironment('HUB_BUCKET', config.hubBucket);
  lambda.addEnvironment('HUB_REGION', region);
}

// ---------------------------------------------------------------------------
// Outputs for the SPA config wiring (Task 19 consumes these).
// ---------------------------------------------------------------------------
new CfnOutput(apiStack, 'ApiBaseUrl', { value: httpApi.apiEndpoint });

backend.addOutput({
  custom: {
    apiBaseUrl: httpApi.apiEndpoint,
    // External AI access via MCP (Task 39): the Settings view's "Connect your
    // AI app" section renders these into ready-to-paste client config
    // (Requirement 16.8). All three are public identifiers, not secrets.
    externalMcpUrl: externalGateway.gatewayUrl,
    externalMcpClientId: externalMcpClient.userPoolClientId,
    cognitoDomain: hostedUiDomain.baseUrl(),
  },
});
