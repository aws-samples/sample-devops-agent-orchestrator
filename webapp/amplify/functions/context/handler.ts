import { assertAdmin } from '../shared/authz';
import {
  emptyBusinessContext,
  validateBusinessContext,
} from '../shared/businessContextValidation';
import { UpstreamUnavailableError, ValidationError } from '../shared/errors';
import {
  loadBusinessContext,
  loadManifest,
  saveBusinessContext,
} from '../shared/hubData';
import { jsonResponse, withErrorHandling, type ApiEvent, type ApiResult } from '../shared/http';

/**
 * Business-context route (Task 5.2).
 *
 * - `GET /context` — any authenticated user. Reads `hub/business_context.json`
 *   and returns it; a missing or unreadable object yields a well-formed empty
 *   context rather than an error, so the Context_Manager always has something
 *   to render.
 * - `PUT /context` — Admin only. {@link assertAdmin} runs BEFORE any state
 *   change and throws 401/403 for missing identities / Executive callers
 *   (Requirements 2.3, 2.5, 2.6). The body is validated against the manifest
 *   (BU/display-name bounds and account existence, Requirements 5.1, 5.2, 5.7);
 *   on failure nothing is written. On success the context is persisted durably
 *   to the hub bucket and echoed back as confirmation (Requirement 5.3). A
 *   write failure surfaces a save-not-completed error while leaving the
 *   previously persisted context unchanged (Requirement 5.4).
 */
export const handler = withErrorHandling(async (event: ApiEvent): Promise<ApiResult> => {
  const method = event.requestContext.http.method.toUpperCase();
  if (method === 'PUT') {
    return handlePut(event);
  }
  return handleGet();
});

/** `GET /context` — return the persisted context or a default empty one. */
async function handleGet(): Promise<ApiResult> {
  const context = await loadBusinessContext();
  return jsonResponse(context ?? emptyBusinessContext());
}

/** `PUT /context` — Admin-only validated persistence of the business context. */
async function handlePut(event: ApiEvent): Promise<ApiResult> {
  assertAdmin(event); // authz gate — denials change no state (Req 2.3, 2.5, 2.6)

  const body = parseBody(event);

  // The manifest is the authoritative account scope for validation (Req 5.7).
  // If it cannot be read we cannot confirm account existence, so we reject the
  // save rather than persist an unvalidated context; the prior context stands.
  const manifestLoad = await loadManifest();
  if (manifestLoad.status !== 'ok') {
    throw new UpstreamUnavailableError(
      'The collected data manifest is unavailable, so business context cannot be validated or saved. The previously saved context is unchanged.',
    );
  }
  const validAccountIds = new Set(manifestLoad.manifest.accounts.map((a) => a.account));

  const result = validateBusinessContext(body, validAccountIds);
  if (!result.valid) {
    throw new ValidationError('The business context is not valid and was not saved.', {
      issues: result.issues,
    });
  }

  const toPersist = { ...result.context, updatedAt: new Date().toISOString() };
  try {
    await saveBusinessContext(toPersist);
  } catch {
    // A failed PutObject does not mutate the stored object, so the previously
    // persisted context remains intact (Requirement 5.4).
    throw new UpstreamUnavailableError(
      'The business context could not be saved. The previously saved context is unchanged.',
    );
  }

  return jsonResponse({ saved: true, context: toPersist });
}

/** Parse and JSON-decode the request body, tolerating base64 transport encoding. */
function parseBody(event: ApiEvent): unknown {
  const raw = event.body ?? '';
  const decoded = event.isBase64Encoded ? Buffer.from(raw, 'base64').toString('utf-8') : raw;
  if (decoded.trim() === '') {
    throw new ValidationError('A business context body is required.');
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw new ValidationError('The request body must be valid JSON.');
  }
}
