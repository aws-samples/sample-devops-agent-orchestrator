import { defineFunction } from '@aws-amplify/backend';

/**
 * `POST /refresh` handler (Admin-only) — starts the refresh state machine
 * asynchronously (Task 10.2). Own execution role; `states:StartExecution` on the
 * refresh state machine, plus `REFRESH_STATE_MACHINE_ARN` / `HUB_REGION` env,
 * are wired in `backend.ts`.
 */
export const refresh = defineFunction({
  name: 'refresh',
  entry: './handler.ts',
});
