import { fetchAuthSession } from 'aws-amplify/auth';
import type { ApiError } from '@devops-observatory/shared-types';
import { getCustomOutputs } from '../amplifyConfig';

/**
 * Authenticated API client for the SPA (introduced in Task 11 for `GET /summary`,
 * reused by later data views).
 *
 * Credential safety (design): the browser never holds AWS credentials. Every
 * request carries only the caller's Cognito access token (JWT) as a bearer
 * token; all AWS access happens server-side in the Lambda handlers behind the
 * API's JWT authorizer. This module never touches AWS SDK clients.
 */

/** Error thrown by {@link apiFetch} carrying the API's standard error envelope. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly body: ApiError | undefined;

  constructor(message: string, status: number, body?: ApiError) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Resolve the API base URL.
 *
 * Preference order:
 *  1. `VITE_API_BASE_URL` (local dev override against a deployed/sandbox API).
 *  2. The `custom.apiBaseUrl` value published into `amplify_outputs.json` by the
 *     backend (see `amplify/backend.ts` `addOutput`), loaded via `Amplify.getConfig()`.
 */
function resolveApiBaseUrl(): string {
  const override = import.meta.env.VITE_API_BASE_URL as string | undefined;
  if (override) {
    return override.replace(/\/+$/, '');
  }
  const fromOutputs = getCustomOutputs()?.apiBaseUrl;
  if (typeof fromOutputs === 'string' && fromOutputs.length > 0) {
    return fromOutputs.replace(/\/+$/, '');
  }
  throw new ApiRequestError(
    'API endpoint is not configured. Run `npm run sandbox` (or set VITE_API_BASE_URL) to wire the API base URL.',
    0,
  );
}

/** Fetch the current Cognito access token for the Authorization header. */
async function authorizationHeader(): Promise<Record<string, string>> {
  const session = await fetchAuthSession();
  const token = session.tokens?.accessToken?.toString();
  if (!token) {
    // The route guard (RequireAuth) prevents this in practice; fail closed.
    throw new ApiRequestError('Not authenticated.', 401);
  }
  return { authorization: `Bearer ${token}` };
}

/**
 * Perform an authenticated JSON request against an API route (e.g. `/summary`)
 * and parse the JSON response. Non-2xx responses are surfaced as an
 * {@link ApiRequestError} carrying the standard {@link ApiError} envelope when
 * the body provides one.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const baseUrl = resolveApiBaseUrl();
  const auth = await authorizationHeader();
  const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;

  const response = await fetch(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...auth,
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    let body: ApiError | undefined;
    try {
      body = (await response.json()) as ApiError;
    } catch {
      body = undefined;
    }
    throw new ApiRequestError(
      body?.message ?? `Request to ${path} failed (${response.status}).`,
      response.status,
      body,
    );
  }

  return (await response.json()) as T;
}
