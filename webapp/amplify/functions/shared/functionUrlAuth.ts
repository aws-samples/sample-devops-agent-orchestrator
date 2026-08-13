import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { getAuthConfig } from './config';
import { AuthenticationRequiredError } from './errors';

/** Claims decoded from a verified Cognito access token on the `/chat` URL. */
export interface DecodedClaims {
  sub?: string;
  [claim: string]: unknown;
}

/**
 * Verifies a bearer token and returns its claims. Abstracted behind an
 * interface so tests can inject a fake verifier without reaching the network
 * (JWKS fetch), while production uses the real Cognito verifier.
 */
export interface TokenVerifier {
  verify(token: string): Promise<DecodedClaims>;
}

/** Case-insensitively read a header from a Function URL event. */
function getHeader(event: LambdaFunctionURLEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * Extract the raw bearer token from the `Authorization` header. Throws an
 * {@link AuthenticationRequiredError} (401) when the header is missing or is not
 * a well-formed `Bearer <token>` value (Requirements 1.2, 2.6, 8.8).
 */
export function extractBearerToken(event: LambdaFunctionURLEvent): string {
  const authorization = getHeader(event, 'authorization');
  if (!authorization) {
    throw new AuthenticationRequiredError();
  }
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) {
    throw new AuthenticationRequiredError('Expected a Bearer authentication token.');
  }
  return match[1].trim();
}

let cachedVerifier: TokenVerifier | undefined;

/**
 * Lazily build (and cache per warm container) the real Cognito access-token
 * verifier. It validates the token's signature against the user pool JWKS plus
 * the issuer, `token_use` (`access`), `client_id`, and expiry, so a forged or
 * expired token is rejected. The pool id + client id come from
 * {@link getAuthConfig}.
 */
function defaultVerifier(): TokenVerifier {
  if (!cachedVerifier) {
    const { userPoolId, userPoolClientId } = getAuthConfig();
    const verifier = CognitoJwtVerifier.create({
      userPoolId,
      tokenUse: 'access',
      clientId: userPoolClientId,
    });
    cachedVerifier = {
      verify: (token) => verifier.verify(token) as Promise<DecodedClaims>,
    };
  }
  return cachedVerifier;
}

/**
 * Enforce authentication on the streaming `/chat` Function URL and return the
 * caller's verified claims (Requirements 1.2, 2.6, 8.8).
 *
 * The Function URL is created with `authType: NONE` and sits outside the HTTP
 * API's JWT authorizer, so this helper is the sole gate on the endpoint. It
 * requires a `Bearer` token in the `Authorization` header and then
 * cryptographically verifies it as a Cognito access token (signature via the
 * pool JWKS, issuer, `token_use`, `client_id`, expiry). Any missing, malformed,
 * forged, or expired token is rejected with a 401 before any Bedrock call is
 * made, so no downstream request runs for an unauthenticated caller.
 *
 * `verifier` is injectable purely as a test seam; production uses the real
 * Cognito verifier from {@link defaultVerifier}.
 */
export async function requireAuthenticatedCaller(
  event: LambdaFunctionURLEvent,
  verifier?: TokenVerifier,
): Promise<DecodedClaims> {
  // Parse the header first so a missing/malformed token fails without ever
  // constructing the (network-backed) verifier.
  const token = extractBearerToken(event);
  const resolved = verifier ?? defaultVerifier();
  let claims: DecodedClaims;
  try {
    claims = await resolved.verify(token);
  } catch {
    throw new AuthenticationRequiredError('Invalid or expired authentication token.');
  }
  if (!claims.sub) {
    throw new AuthenticationRequiredError();
  }
  return claims;
}
