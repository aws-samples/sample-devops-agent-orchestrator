import { defineFunction } from '@aws-amplify/backend';

/**
 * `GET /dashboard` handler (Task 3 shell; full logic in Task 4.3).
 * Own execution role; S3 read policy scaffolded in `backend.ts`.
 */
export const dashboard = defineFunction({
  name: 'dashboard',
  entry: './handler.ts',
});
