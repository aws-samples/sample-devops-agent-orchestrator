import { defineFunction } from '@aws-amplify/backend';

/**
 * `POST /chat` handler — Bedrock knowledge-base chat proxy.
 *
 * Served over the JWT-authorized HTTP API (wired in `backend.ts`), NOT a public
 * streaming Function URL: this deployment's environment blocks unauthenticated
 * (`AuthType=NONE`) Function URLs, so chat reuses the Cognito JWT authorizer in
 * front of every other route. The handler returns the full answer as a single
 * JSON response.
 *
 * Own execution role; a least-privilege `bedrock:InvokeModel*` + KB agentic
 * retrieve policy scoped to the KB and chat-model ARNs is granted in
 * `backend.ts`. The handler caps answer generation at 27s (below the HTTP API's
 * 30s integration timeout); the function timeout sits just above it so a clean
 * upstream-timeout error is returned before Lambda kills the invocation.
 */
export const chat = defineFunction({
  name: 'chat',
  entry: './handler.ts',
  timeoutSeconds: 29,
});
