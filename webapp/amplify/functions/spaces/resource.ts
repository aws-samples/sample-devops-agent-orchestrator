import { defineFunction } from '@aws-amplify/backend';

/**
 * `GET /spaces` handler (Task 3 shell; full logic in Task 4.2).
 * Own execution role; S3 read policy scaffolded in `backend.ts`.
 */
export const spaces = defineFunction({
  name: 'spaces',
  entry: './handler.ts',
});
