import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import {
  AGENT_SPACE_DESCRIPTION_MAX_LENGTH,
  AGENT_SPACE_NAME_MAX_LENGTH,
  AGENT_SPACE_NAME_MIN_LENGTH,
  BATCH_CREATE_SPACES_MAX,
  type CreatedSpace,
  type CreateSpaceRequest,
} from '@devops-observatory/shared-types';
import {
  ConflictError,
  UpstreamUnavailableError,
  ValidationError,
} from './errors';

/** Default starter-space name for an account (matches the CLI + single-create). */
export function defaultSpaceName(accountId: string): string {
  return `devops-agent-${accountId}`;
}

/**
 * Create-agent-space orchestration for the Admin-only `POST /spaces` route.
 *
 * The DevOps Agent API is only available in the recent boto3 supplied by the
 * refresh boto3 layer, so the actual `create_agent_space` call runs in a Python
 * worker Lambda (`scripts/create_space_worker.py`, provisioned by
 * `amplify/spaces/resource.ts`). This Node module validates the request, invokes
 * that worker synchronously, and maps its structured result to the API response
 * / typed errors. The pure helpers ({@link validateCreateSpaceInput},
 * {@link mapWorkerResult}) are unit-tested without the SDK.
 */

/** The worker Lambda's result shape (mirrors `create_space_worker.create_space`). */
export interface WorkerResult {
  ok: boolean;
  accountId?: string;
  agentSpaceId?: string;
  name?: string;
  primaryAccountConfigured?: boolean;
  warning?: string;
  code?: 'validation' | 'create_denied' | 'conflict' | 'error';
  error?: string;
}

/** An account-id must be a 12-digit AWS account number. */
const ACCOUNT_ID_RE = /^\d{12}$/;

/**
 * Validate + normalize the POST /spaces body. Pure and SDK-free. Returns the
 * normalized {@link CreateSpaceRequest} on success, or a message on failure.
 * Account existence (against the manifest) is checked separately by the handler.
 */
export function validateCreateSpaceInput(
  body: unknown,
): { valid: true; request: CreateSpaceRequest } | { valid: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, message: 'A request body is required.' };
  }
  const raw = body as Record<string, unknown>;
  const accountId = typeof raw.accountId === 'string' ? raw.accountId.trim() : '';
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const descriptionRaw = typeof raw.description === 'string' ? raw.description.trim() : '';

  if (!ACCOUNT_ID_RE.test(accountId)) {
    return { valid: false, message: 'A valid 12-digit AWS account id is required.' };
  }
  if (name.length < AGENT_SPACE_NAME_MIN_LENGTH || name.length > AGENT_SPACE_NAME_MAX_LENGTH) {
    return {
      valid: false,
      message: `The space name must be ${AGENT_SPACE_NAME_MIN_LENGTH}-${AGENT_SPACE_NAME_MAX_LENGTH} characters.`,
    };
  }
  if (descriptionRaw.length > AGENT_SPACE_DESCRIPTION_MAX_LENGTH) {
    return {
      valid: false,
      message: `The description must be at most ${AGENT_SPACE_DESCRIPTION_MAX_LENGTH} characters.`,
    };
  }
  const request: CreateSpaceRequest = { accountId, name };
  if (descriptionRaw.length > 0) request.description = descriptionRaw;
  return { valid: true, request };
}

/**
 * Map the worker's structured result to a {@link CreatedSpace} or a typed API
 * error. Pure and SDK-free.
 *   - `ok`            → the created space.
 *   - `validation`    → 400 ValidationError (defensive; the route validates first).
 *   - `conflict`      → 409 ConflictError (a space with that name already exists).
 *   - `create_denied` → 502 UpstreamUnavailableError with an actionable message
 *                       (the collector role lacks aidevops:CreateAgentSpace).
 *   - `error`/other   → 502 UpstreamUnavailableError.
 */
export function mapWorkerResult(result: WorkerResult): CreatedSpace {
  if (result.ok && result.agentSpaceId && result.accountId) {
    return {
      accountId: result.accountId,
      agentSpaceId: result.agentSpaceId,
      ...(result.name ? { name: result.name } : {}),
      ...(typeof result.primaryAccountConfigured === 'boolean'
        ? { primaryAccountConfigured: result.primaryAccountConfigured }
        : {}),
      ...(result.warning ? { warning: result.warning } : {}),
    };
  }
  const message = result.error ?? 'The agent space could not be created.';
  switch (result.code) {
    case 'validation':
      throw new ValidationError(message);
    case 'conflict':
      throw new ConflictError(message);
    case 'create_denied':
    case 'error':
    default:
      throw new UpstreamUnavailableError(message);
  }
}

let cachedClient: LambdaClient | undefined;
function lambda(): LambdaClient {
  if (!cachedClient) {
    cachedClient = new LambdaClient({ region: process.env.HUB_REGION });
  }
  return cachedClient;
}

/** ARN/name of the Python worker Lambda, injected by `backend.ts`. */
function workerFunction(): string {
  const arn = process.env.CREATE_SPACE_WORKER_ARN;
  if (!arn) {
    throw new UpstreamUnavailableError(
      'The create-space worker is not configured. Agent spaces cannot be created right now.',
    );
  }
  return arn;
}

/**
 * Invoke the Python worker synchronously to create the space, returning the
 * created space or throwing a typed API error. A transport/function error (the
 * Lambda itself failing) surfaces as an upstream-unavailable error.
 */
export async function invokeCreateSpace(request: CreateSpaceRequest): Promise<CreatedSpace> {
  let out;
  try {
    out = await lambda().send(
      new InvokeCommand({
        FunctionName: workerFunction(),
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );
  } catch {
    throw new UpstreamUnavailableError(
      'The agent space could not be created because the worker could not be reached.',
    );
  }

  // A Lambda FunctionError (unhandled exception in the worker) means we cannot
  // trust the payload — treat it as an upstream failure.
  if (out.FunctionError) {
    throw new UpstreamUnavailableError('The agent space could not be created (worker error).');
  }

  let parsed: WorkerResult;
  try {
    const text = out.Payload ? Buffer.from(out.Payload).toString('utf-8') : '';
    parsed = JSON.parse(text) as WorkerResult;
  } catch {
    throw new UpstreamUnavailableError('The agent space creation returned an unreadable result.');
  }
  return mapWorkerResult(parsed);
}

// ---------------------------------------------------------------------------
// Batch creation — POST /spaces/batch (Admin only)
// ---------------------------------------------------------------------------

/**
 * Validate + normalize the batch body against the known (manifest) accounts.
 * Pure and SDK-free. De-duplicates account ids, requires 1..MAX ids, and that
 * every id is a 12-digit account present in `knownAccounts`. Returns the list
 * of per-account create requests (named `devops-agent-<id>`) on success.
 */
export function validateBatchCreateInput(
  body: unknown,
  knownAccounts: ReadonlySet<string>,
): { valid: true; requests: CreateSpaceRequest[]; accountIds: string[] } | { valid: false; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, message: 'A request body is required.' };
  }
  const raw = (body as Record<string, unknown>).accountIds;
  if (!Array.isArray(raw)) {
    return { valid: false, message: 'accountIds must be an array of account ids.' };
  }
  // Trim + de-duplicate while preserving order.
  const seen = new Set<string>();
  const accountIds: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    accountIds.push(id);
  }
  if (accountIds.length === 0) {
    return { valid: false, message: 'Select at least one account.' };
  }
  if (accountIds.length > BATCH_CREATE_SPACES_MAX) {
    return {
      valid: false,
      message: `A batch may target at most ${BATCH_CREATE_SPACES_MAX} accounts (got ${accountIds.length}).`,
    };
  }
  const unknown = accountIds.filter((id) => !ACCOUNT_ID_RE.test(id) || !knownAccounts.has(id));
  if (unknown.length > 0) {
    return {
      valid: false,
      message: `These accounts are not in the collected manifest: ${unknown.slice(0, 5).join(', ')}${
        unknown.length > 5 ? '…' : ''
      }.`,
    };
  }
  const requests = accountIds.map((accountId) => ({ accountId, name: defaultSpaceName(accountId) }));
  return { valid: true, requests, accountIds };
}

/**
 * Fire-and-forget async invoke of the worker for one account (InvocationType
 * `Event`). Used by the batch path so hundreds of creations fan out to Lambda's
 * async concurrency instead of blocking the route. Never throws — a failed
 * enqueue is reported via the returned flag so the caller can count acceptances.
 */
async function invokeCreateSpaceAsync(request: CreateSpaceRequest): Promise<boolean> {
  try {
    await lambda().send(
      new InvokeCommand({
        FunctionName: workerFunction(),
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(request)),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Enqueue async creation for many accounts with bounded concurrency (so a large
 * batch doesn't open hundreds of sockets at once). Returns the account ids that
 * were successfully enqueued. The actual creates run asynchronously in the
 * worker; results surface after the next data refresh (Requirement: pending).
 */
export async function batchCreateSpaces(
  requests: CreateSpaceRequest[],
  concurrency = 20,
): Promise<string[]> {
  const accepted: string[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, requests.length) }, async () => {
    while (cursor < requests.length) {
      const index = cursor++;
      const request = requests[index];
      if (await invokeCreateSpaceAsync(request)) {
        accepted.push(request.accountId);
      }
    }
  });
  await Promise.all(workers);
  return accepted;
}
