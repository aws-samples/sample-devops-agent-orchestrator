import { defineFunction } from '@aws-amplify/backend';

/**
 * Chat memory route (`GET /chat/history`, `DELETE /chat/history`).
 *
 * Returns / clears the CALLER'S OWN persisted chat memory (scoped to their
 * Cognito `sub`), so a user's conversation survives across sessions and
 * devices within the admin-configured retention window. Served over the
 * JWT-authorized HTTP API; own execution role with least-privilege S3 access to
 * the caller's per-user history object in the hub bucket granted in `backend.ts`.
 */
export const chatHistory = defineFunction({
  name: 'chat-history',
  entry: './handler.ts',
  timeoutSeconds: 15,
});
