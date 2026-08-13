import type {
  A2aConfiguredSpace,
  A2aConfiguredSpacesResponse,
  A2aStatus,
} from '@devops-observatory/shared-types';
import { assertAdmin, getCaller } from '../shared/authz';
import { UpstreamUnavailableError, ValidationError } from '../shared/errors';
import { loadManifest } from '../shared/hubData';
import {
  deleteStoredToken,
  getStoredToken,
  listConfiguredSpaceIds,
  putStoredToken,
  requireSpaceId,
  toStatus,
  validateChatRequest,
  validateTokenRequest,
} from '../shared/a2a';
import {
  approveInvestigation,
  getInvestigationStatus,
  rejectInvestigation,
  startInvestigation,
} from '../shared/a2aInvestigate';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * Agent-to-Agent (A2A) routes for talking to an individual DevOps Agent Space
 * (Task 36, reworked in Task 37). One Lambda serving five routes:
 *
 *   Any authenticated user:
 *     - `GET  /a2a/spaces`                    — list spaces that have a token stored
 *     - `POST /spaces/{spaceId}/a2a/chat`     — ask the space's `chat` skill
 *   Admin only (token management, done from the Settings view):
 *     - `PUT    /spaces/{spaceId}/a2a-token`  — store/replace the space's Bearer token
 *     - `DELETE /spaces/{spaceId}/a2a-token`  — remove the stored token
 *     - `GET    /spaces/{spaceId}/a2a-status` — is a token stored? + metadata (no value)
 *
 * Chat and the configured-list are available to any signed-in user so the main
 * Chat view can talk to a space and the Spaces view can show an "A2A" icon;
 * storing/removing a token is Admin-only. The token value is write-only — it is
 * kept in Secrets Manager and never returned by any route.
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  const method = event.requestContext.http.method.toUpperCase();
  const path = event.rawPath ?? event.requestContext.http.path ?? '';

  // `GET /a2a/spaces` — no space id; any authenticated user. Powers the Spaces
  // icon + Chat selector.
  if (path.endsWith('/a2a/spaces')) {
    getCaller(event); // authenticated (any role)
    if (method !== 'GET') throw new ValidationError('Use GET for the A2A spaces list.');
    return handleListConfigured();
  }

  const spaceId = requireSpaceId(event.pathParameters?.spaceId);

  // Async `chat` (start/status) — any authenticated user. The DevOps Agent chat
  // is synchronous but often slower than the API Gateway 30s limit, so it runs
  // in the durable function and the browser polls for the answer.
  if (path.includes('/a2a/chat')) {
    getCaller(event);
    await assertSpaceKnown(spaceId);
    return handleChat(spaceId, method, event);
  }

  // Async `investigate` (start/status/approve/reject) — any authenticated user,
  // same as chat. Long-running, so it runs in a durable function the browser
  // polls (see functions/a2a-investigate + shared/a2aInvestigate).
  if (path.includes('/a2a/investigate')) {
    getCaller(event);
    await assertSpaceKnown(spaceId);
    return handleInvestigate(spaceId, method, path, event);
  }

  // Token management (store/remove/status) is Admin-only — denials change
  // nothing and reach no space (Requirements 2.3, 2.5, 2.6).
  assertAdmin(event);
  await assertSpaceKnown(spaceId);
  switch (method) {
    case 'GET':
      return handleStatus(spaceId);
    case 'PUT':
      return handlePutToken(spaceId, event);
    case 'DELETE':
      return handleDeleteToken(spaceId);
    default:
      throw new ValidationError(`Unsupported method ${method} for the A2A token route.`);
  }
});

/** Load the manifest or throw a clear upstream error. */
async function requireManifest() {
  const load = await loadManifest();
  if (load.status !== 'ok') {
    throw new UpstreamUnavailableError(
      'The collected data manifest is unavailable, so the agent space cannot be verified.',
    );
  }
  return load.manifest;
}

/** Confirm the space id appears in some manifest account (throws otherwise). */
async function assertSpaceKnown(spaceId: string): Promise<void> {
  const manifest = await requireManifest();
  const known = manifest.accounts.some((a) => a.spaces.some((s) => s.agentSpaceId === spaceId));
  if (!known) {
    throw new ValidationError(`Agent space ${spaceId} is not present in the collected manifest.`);
  }
}

/**
 * `GET /a2a/spaces` — the configured (token-holding) spaces joined with their
 * manifest name/account, so the Chat selector can label them. Only spaces that
 * both have a token AND exist in the manifest are returned.
 */
async function handleListConfigured(): Promise<ApiResult> {
  const [configured, manifest] = await Promise.all([listConfiguredSpaceIds(), requireManifest()]);
  const spaces: A2aConfiguredSpace[] = [];
  for (const account of manifest.accounts) {
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
  return jsonResponse({ spaces } satisfies A2aConfiguredSpacesResponse);
}

/** `GET /a2a-status` — report whether a token is stored + its metadata. */
async function handleStatus(spaceId: string): Promise<ApiResult> {
  const stored = await getStoredToken(spaceId);
  const status: A2aStatus = stored ? toStatus(stored) : { configured: false };
  return jsonResponse(status);
}

/** `PUT /a2a-token` — validate + store/replace the Bearer token. */
async function handlePutToken(spaceId: string, event: ApiEvent): Promise<ApiResult> {
  const parsed = validateTokenRequest(parseBody(event), process.env.HUB_REGION ?? 'us-east-1');
  if (!parsed.valid) {
    throw new ValidationError(parsed.message);
  }
  await putStoredToken(spaceId, parsed.value);
  return jsonResponse(toStatus(parsed.value));
}

/** `DELETE /a2a-token` — remove the stored token. */
async function handleDeleteToken(spaceId: string): Promise<ApiResult> {
  await deleteStoredToken(spaceId);
  return jsonResponse({ configured: false } satisfies A2aStatus);
}

/**
 * Dispatch the async `chat` sub-routes (durable run, `skill: 'chat'`):
 *   - `POST /spaces/{id}/a2a/chat`            — start (returns an execution name)
 *   - `GET  /spaces/{id}/a2a/chat/{execName}` — status/answer
 * Chat has no approval step, so there are no approve/reject routes.
 */
async function handleChat(spaceId: string, method: string, event: ApiEvent): Promise<ApiResult> {
  const execName = event.pathParameters?.execName;

  // Start — no execName in the path.
  if (!execName) {
    if (method !== 'POST') throw new ValidationError('Use POST to start an A2A chat.');
    const parsed = validateChatRequest(parseBody(event));
    if (!parsed.valid) throw new ValidationError(parsed.message);
    // Fail fast if the space has no token, before starting a durable execution.
    const stored = await getStoredToken(spaceId);
    if (!stored) {
      throw new ValidationError(
        'No A2A access token is configured for this agent space. An admin can add one in Settings.',
      );
    }
    return jsonResponse(await startInvestigation(spaceId, parsed.message, 'chat'));
  }

  // Status/answer.
  if (method !== 'GET') throw new ValidationError('Use GET for A2A chat status.');
  return jsonResponse(await getInvestigationStatus(requireExecName(execName)));
}

/** A durable-execution name minted by {@link startInvestigation} (`inv-…`/`chat-…`). */
const EXEC_NAME_RE = /^(?:inv|chat)-[0-9a-zA-Z-]{1,120}$/;

/** Validate the `{execName}` path parameter, or throw a 400. */
function requireExecName(execName: string | undefined): string {
  const name = (execName ?? '').trim();
  if (!EXEC_NAME_RE.test(name)) {
    throw new ValidationError('A valid run id is required in the path.');
  }
  return name;
}

/**
 * Dispatch the `investigate` sub-routes:
 *   - `POST /spaces/{id}/a2a/investigate`                    — start
 *   - `GET  /spaces/{id}/a2a/investigate/{execName}`         — status/result
 *   - `POST /spaces/{id}/a2a/investigate/{execName}/approve` — acknowledge findings
 *   - `POST /spaces/{id}/a2a/investigate/{execName}/reject`  — dismiss findings
 */
async function handleInvestigate(
  spaceId: string,
  method: string,
  path: string,
  event: ApiEvent,
): Promise<ApiResult> {
  const execName = event.pathParameters?.execName;

  // Start — no execName in the path.
  if (!execName) {
    if (method !== 'POST') throw new ValidationError('Use POST to start an investigation.');
    const parsed = validateChatRequest(parseBody(event));
    if (!parsed.valid) throw new ValidationError(parsed.message);
    // Fail fast if the space has no token, before starting a durable execution.
    const stored = await getStoredToken(spaceId);
    if (!stored) {
      throw new ValidationError(
        'No A2A access token is configured for this agent space. An admin can add one in Settings.',
      );
    }
    return jsonResponse(await startInvestigation(spaceId, parsed.message));
  }

  const name = requireExecName(execName);

  if (path.endsWith('/approve')) {
    if (method !== 'POST') throw new ValidationError('Use POST to approve an investigation.');
    await approveInvestigation(name);
    return jsonResponse(await getInvestigationStatus(name));
  }
  if (path.endsWith('/reject')) {
    if (method !== 'POST') throw new ValidationError('Use POST to reject an investigation.');
    const body = parseOptionalBody(event);
    const reason =
      typeof (body as { reason?: unknown })?.reason === 'string'
        ? ((body as { reason: string }).reason)
        : undefined;
    await rejectInvestigation(name, reason);
    return jsonResponse(await getInvestigationStatus(name));
  }

  // Status/result.
  if (method !== 'GET') throw new ValidationError('Use GET for investigation status.');
  return jsonResponse(await getInvestigationStatus(name));
}

/** Like {@link parseBody} but tolerates an empty body (returns `{}`). */
function parseOptionalBody(event: ApiEvent): unknown {
  const raw = event.body ?? '';
  const decoded = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
  if (decoded.trim() === '') return {};
  try {
    return JSON.parse(decoded);
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
}

/** Parse + JSON-decode the request body, tolerating base64 transport encoding. */
function parseBody(event: ApiEvent): unknown {
  const raw = event.body ?? '';
  const decoded = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
  if (decoded.trim() === '') {
    throw new ValidationError('A request body is required.');
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
}
