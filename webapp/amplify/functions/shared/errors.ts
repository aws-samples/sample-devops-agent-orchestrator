import type { ApiError, ApiErrorCode } from '@devops-observatory/shared-types';

/**
 * Typed error hierarchy for the API layer (Task 3).
 *
 * Handlers throw these and the response helpers ({@link ./http}) translate them
 * into the standard {@link ApiError} envelope with the correct HTTP status.
 * Auth/authz denials (401/403) MUST change no state (Requirements 2.3, 2.5, 2.6);
 * because these are thrown before any mutation runs, that invariant holds.
 */
export class ApiLayerError extends Error {
  readonly code: ApiErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ApiErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiLayerError';
    this.code = code;
    this.details = details;
  }

  /** The standard wire body for this error. */
  toApiError(): ApiError {
    return this.details
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message };
  }
}

/** Authentication-required (401) — no valid identity on the request (Req 1.2, 2.6). */
export class AuthenticationRequiredError extends ApiLayerError {
  constructor(message = 'Authentication is required to access this resource.') {
    super('UNAUTHENTICATED', message);
    this.name = 'AuthenticationRequiredError';
  }
}

/** Insufficient-permissions (403) — authenticated caller lacks the role (Req 2.3, 2.5). */
export class InsufficientPermissionsError extends ApiLayerError {
  constructor(message = 'You do not have permission to perform this action.') {
    super('FORBIDDEN', message);
    this.name = 'InsufficientPermissionsError';
  }
}

/** Not-implemented (501) — route stub whose full logic lands in a later task. */
export class NotImplementedError extends ApiLayerError {
  constructor(route: string) {
    super('NOT_IMPLEMENTED', `${route} is not implemented yet.`);
    this.name = 'NotImplementedError';
  }
}

/**
 * Validation (400) — the request body failed a business rule (Req 5.1, 5.2, 5.7).
 * Used by `PUT /context` when submitted business context is malformed or refers
 * to an account absent from the manifest. Thrown before any write, so the
 * previously persisted context is left unchanged (Requirement 5.4). `details`
 * carries the structured list of issues so the caller can surface them.
 */
export class ValidationError extends ApiLayerError {
  constructor(message = 'The request is not valid.', details?: Record<string, unknown>) {
    super('VALIDATION', message, details);
    this.name = 'ValidationError';
  }
}

/**
 * Upstream-unavailable (502) — a hub data source could not be read or parsed.
 * Used by `GET /spaces` when the manifest is missing/invalid so the view shows
 * an "account data unavailable" error rather than a partial listing (Req 3.7).
 */
export class UpstreamUnavailableError extends ApiLayerError {
  constructor(message = 'The requested data is currently unavailable.') {
    super('UPSTREAM_UNAVAILABLE', message);
    this.name = 'UpstreamUnavailableError';
  }
}

/**
 * Conflict (409) — the request conflicts with current state. Used by
 * `POST /refresh` when a refresh is already in progress: the new request is
 * rejected and nothing is started, so Last_Sync_Date is unchanged
 * (Requirement 10.5).
 */
export class ConflictError extends ApiLayerError {
  constructor(message = 'The request conflicts with the current state.') {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}
