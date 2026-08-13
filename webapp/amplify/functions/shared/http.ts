import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { API_ERROR_STATUS, type ApiError } from '@devops-observatory/shared-types';
import { ApiLayerError } from './errors';

/** The JWT-authorized HTTP API event shape used by every non-streaming route. */
export type ApiEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

/** Alias for the structured result returned by HTTP API handlers. */
export type ApiResult = APIGatewayProxyResultV2;

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

/** Build a JSON success response with the given status code (default 200). */
export function jsonResponse(body: unknown, statusCode = 200): ApiResult {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

/** Build a JSON error response from a standard {@link ApiError} envelope. */
export function errorResponse(error: ApiError): ApiResult {
  return {
    statusCode: API_ERROR_STATUS[error.code],
    headers: JSON_HEADERS,
    body: JSON.stringify(error),
  };
}

/**
 * Translate any thrown value into the standard error envelope. Known
 * {@link ApiLayerError}s (including auth/authz denials) map to their declared
 * code/status; anything else becomes a generic 500 without leaking internals.
 */
export function toErrorResponse(err: unknown): ApiResult {
  if (err instanceof ApiLayerError) {
    return errorResponse(err.toApiError());
  }
  return errorResponse({ code: 'INTERNAL', message: 'An unexpected error occurred.' });
}

/**
 * Wrap a handler so any thrown {@link ApiLayerError} (auth-required,
 * insufficient-permissions, not-implemented, validation, …) is rendered as the
 * standard JSON error envelope. Keeps every route's error shape consistent
 * (Requirements 2.3, 2.5, 2.6).
 */
export function withErrorHandling(
  handler: (event: ApiEvent) => Promise<ApiResult>,
): (event: ApiEvent) => Promise<ApiResult> {
  return async (event) => {
    try {
      return await handler(event);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}
