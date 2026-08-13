import {
  ADMIN_GROUP,
  COGNITO_GROUPS_CLAIM,
  type CognitoGroup,
} from '@devops-observatory/shared-types';
import { AuthenticationRequiredError, InsufficientPermissionsError } from './errors';
import type { ApiEvent } from './http';

/** The verified identity of a caller, derived from validated JWT claims. */
export interface CallerIdentity {
  /** Cognito `sub` — the user's unique id. */
  userId: string;
  /** Username / email if present on the token. */
  username?: string;
  /** Group memberships from the `cognito:groups` claim. */
  groups: CognitoGroup[];
  /** Raw JWT claims for handlers that need additional fields. */
  claims: Record<string, string | number | boolean | string[]>;
}

/**
 * Normalize the `cognito:groups` claim into a string array. API Gateway may pass
 * it as a real array, a bracketed string like `"[Admin]"`, or a single value.
 */
function parseGroups(raw: string | number | boolean | string[] | undefined): CognitoGroup[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw as CognitoGroup[];
  const asString = String(raw).trim();
  if (asString === '') return [];
  const unwrapped = asString.startsWith('[') && asString.endsWith(']')
    ? asString.slice(1, -1)
    : asString;
  return unwrapped
    .split(/[\s,]+/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0) as CognitoGroup[];
}

/**
 * Extract the verified caller identity from an HTTP API event.
 *
 * The Cognito JWT authorizer validates the access token before the handler runs
 * (Requirements 1.2, 2.6), so the claims on `requestContext.authorizer.jwt` are
 * trusted here. If the authorizer context is absent (which should not happen on
 * an authorized route), we fail closed with an authentication error.
 */
export function getCaller(event: ApiEvent): CallerIdentity {
  const jwt = event.requestContext.authorizer?.jwt;
  if (!jwt || !jwt.claims) {
    throw new AuthenticationRequiredError();
  }
  const claims = jwt.claims;
  const sub = claims.sub;
  if (sub === undefined || String(sub).length === 0) {
    throw new AuthenticationRequiredError();
  }
  const username = claims.username ?? claims['cognito:username'] ?? claims.email;
  return {
    userId: String(sub),
    username: username === undefined ? undefined : String(username),
    groups: parseGroups(claims[COGNITO_GROUPS_CLAIM]),
    claims,
  };
}

/** True when the caller belongs to the `Admin` group (Requirement 2.1). */
export function isAdmin(caller: CallerIdentity): boolean {
  return caller.groups.includes(ADMIN_GROUP);
}

/**
 * Assert the caller is an authenticated Admin, returning their identity.
 *
 * Reusable guard for Admin-only routes (`PUT /context`, `POST /refresh`,
 * `GET /refresh/status`). Throws {@link AuthenticationRequiredError} when there
 * is no valid identity and {@link InsufficientPermissionsError} when an
 * authenticated Executive attempts the action — in both cases the caller throws
 * before any state change, satisfying Requirements 2.3, 2.5, 2.6.
 */
export function assertAdmin(event: ApiEvent): CallerIdentity {
  const caller = getCaller(event);
  if (!isAdmin(caller)) {
    throw new InsufficientPermissionsError(
      'This action requires the Admin role and is not permitted for the Executive role.',
    );
  }
  return caller;
}
