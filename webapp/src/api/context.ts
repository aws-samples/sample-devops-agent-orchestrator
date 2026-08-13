import type { BusinessContext } from '@devops-observatory/shared-types';
import { apiFetch } from './client';

/**
 * Business-context API client (Task 5.2 backend, consumed by the Task 16
 * Admin-only Context_Manager).
 *
 * - {@link fetchContext} — `GET /context`, available to any authenticated user.
 *   The backend returns a well-formed empty context when none is stored, so the
 *   Context_Manager always has something to render.
 * - {@link saveContext} — Admin-only `PUT /context`. The backend re-asserts the
 *   Admin group before any write (Requirements 2.3, 2.5): an Executive caller
 *   gets a 403 and nothing is persisted. On success the durable object is
 *   written and echoed back as confirmation (Requirement 5.3). On a save
 *   failure the previously persisted context is left unchanged and an error
 *   envelope is surfaced (Requirement 5.4), which {@link apiFetch} throws as an
 *   `ApiRequestError` the view can present while retaining the unsaved edits.
 *
 * Credential safety: the browser never holds AWS credentials — every request
 * carries only the caller's Cognito access token behind the API's JWT
 * authorizer.
 */

/** Response body for a successful `PUT /context` save. */
export interface SaveContextResponse {
  saved: boolean;
  context: BusinessContext;
}

/** `GET /context` — the persisted business context, or an empty default. */
export function fetchContext(): Promise<BusinessContext> {
  return apiFetch<BusinessContext>('/context');
}

/**
 * Admin-only `PUT /context` — validate + persist the business context. The
 * caller supplies the full context payload (version, businessUnits,
 * accountDisplayNames); `updatedAt` is stamped authoritatively by the backend
 * at save time. Rejections (validation, authorization, or upstream save
 * failure) surface as an `ApiRequestError`.
 */
export function saveContext(context: BusinessContext): Promise<SaveContextResponse> {
  return apiFetch<SaveContextResponse>('/context', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(context),
  });
}
