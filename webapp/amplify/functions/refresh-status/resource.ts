import { defineFunction } from '@aws-amplify/backend';

/**
 * `GET /refresh/status` handler (Admin-only) — describes a refresh execution for
 * the in-progress / completed / failed indicator (Task 10.2). Own execution
 * role; `states:DescribeExecution` on the refresh state machine's executions,
 * plus `REFRESH_STATE_MACHINE_ARN` / `HUB_REGION` env, are wired in `backend.ts`.
 */
export const refreshStatus = defineFunction({
  name: 'refresh-status',
  entry: './handler.ts',
});
