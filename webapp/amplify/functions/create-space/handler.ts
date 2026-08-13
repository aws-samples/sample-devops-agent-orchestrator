import type {
  BatchCreateSpacesResponse,
  CreateSpaceResponse,
} from '@devops-observatory/shared-types';
import { assertAdmin } from '../shared/authz';
import { UpstreamUnavailableError, ValidationError } from '../shared/errors';
import { loadManifest } from '../shared/hubData';
import {
  batchCreateSpaces,
  invokeCreateSpace,
  validateBatchCreateInput,
  validateCreateSpaceInput,
} from '../shared/spaces';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * `POST /spaces` (Admin only) — create a new AWS DevOps Agent Space.
 *
 * {@link assertAdmin} runs BEFORE anything else and throws 401/403 for missing
 * identities / Executive callers, so a non-Admin request creates nothing and
 * changes no state (Requirements 2.3, 2.5, 2.6). The body is validated for a
 * 12-digit account id and a bounded name/description; the account must exist in
 * the manifest (the same authoritative account scope used by `PUT /context`).
 * The actual `create_agent_space` call runs in the Python worker Lambda
 * (`amplify/spaces/resource.ts`) — reached here via {@link invokeCreateSpace} —
 * because the DevOps Agent API is only available in the boto3 layer, not the
 * Node SDK. On success the created space is echoed back (201).
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  assertAdmin(event); // authz gate — denials create nothing and change no state

  const isBatch = (event.rawPath ?? event.requestContext?.http?.path ?? '').endsWith('/batch');
  const body = parseBody(event);

  // The manifest is the authoritative account scope (as for PUT /context): only
  // an account we actually collect can have a space created from here. If it
  // cannot be read we cannot confirm the target, so we reject rather than guess.
  const manifestLoad = await loadManifest();
  if (manifestLoad.status !== 'ok') {
    throw new UpstreamUnavailableError(
      'The collected data manifest is unavailable, so the target account(s) cannot be verified. No space was created.',
    );
  }
  const known = new Set(manifestLoad.manifest.accounts.map((a) => a.account));

  return isBatch ? handleBatch(body, known) : handleSingle(body, known);
});

/** `POST /spaces` — create one space synchronously and echo it back. */
async function handleSingle(body: unknown, known: ReadonlySet<string>): Promise<ApiResult> {
  const parsed = validateCreateSpaceInput(body);
  if (!parsed.valid) {
    throw new ValidationError(parsed.message);
  }
  if (!known.has(parsed.request.accountId)) {
    throw new ValidationError(
      `Account ${parsed.request.accountId} is not present in the collected manifest, so a space cannot be created for it.`,
    );
  }
  const space = await invokeCreateSpace(parsed.request);
  const response: CreateSpaceResponse = { created: true, space };
  return jsonResponse(response, 201);
}

/**
 * `POST /spaces/batch` — fan creation out asynchronously across many accounts
 * (up to the batch cap). Returns 202 with the accepted count/ids; the created
 * spaces surface after the next data refresh (the UI marks them "pending").
 */
async function handleBatch(body: unknown, known: ReadonlySet<string>): Promise<ApiResult> {
  const parsed = validateBatchCreateInput(body, known);
  if (!parsed.valid) {
    throw new ValidationError(parsed.message);
  }
  const accepted = await batchCreateSpaces(parsed.requests);
  const response: BatchCreateSpacesResponse = { accepted: accepted.length, accountIds: accepted };
  return jsonResponse(response, 202);
}

/** Parse and JSON-decode the request body, tolerating base64 transport encoding. */
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
