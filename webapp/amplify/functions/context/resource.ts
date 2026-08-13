import { defineFunction } from '@aws-amplify/backend';

/**
 * `GET /context` (any) and `PUT /context` (Admin-only) handler (Task 5.2).
 *
 * The PUT path asserts the caller's `Admin` group before any write
 * (Requirements 2.3, 2.5), validates the body against the manifest
 * (Requirements 5.1, 5.2, 5.7), and persists `hub/business_context.json`
 * durably (Requirement 5.3). Its execution role gets S3 read+write on the
 * business-context object plus S3 read on the manifest (for account-existence
 * validation), wired in `backend.ts`.
 */
export const context = defineFunction({
  name: 'context',
  entry: './handler.ts',
});
