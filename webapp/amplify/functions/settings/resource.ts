import { defineFunction } from '@aws-amplify/backend';

/**
 * Application settings route (`GET /settings` any, `PUT /settings` Admin).
 *
 * Backs the admin-configurable chat-history retention window. Served over the
 * JWT-authorized HTTP API; the PUT path re-asserts the Admin group in-handler.
 * Own execution role; least-privilege S3 access to the singleton app-settings
 * object in the hub bucket is granted in `backend.ts`.
 */
export const settings = defineFunction({
  name: 'settings',
  entry: './handler.ts',
  timeoutSeconds: 15,
});
