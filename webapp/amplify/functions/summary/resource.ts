import { defineFunction } from '@aws-amplify/backend';

/**
 * `GET /summary` handler (Task 3 shell; full logic in Task 4.1).
 *
 * Behind the HTTP API Cognito JWT authorizer, so only authenticated callers
 * reach it. Amplify gives this function its own execution role; least-privilege
 * S3 read policy for `raw/_manifest.json` + `hub/business_context.json` is
 * scaffolded in `backend.ts` and tightened in Task 4.1.
 */
export const summary = defineFunction({
  name: 'summary',
  entry: './handler.ts',
});
