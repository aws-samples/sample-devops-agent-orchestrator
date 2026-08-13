import { defineAuth } from '@aws-amplify/backend';

/**
 * Cognito auth resource (Task 2.1 — Requirement 2.1).
 *
 * Defines the Cognito user pool used by the DevOps Observatory SPA with the two
 * roles the system supports (Requirement 2.1):
 *   - `Executive` — read-only access to visualizations, dashboards, and chat.
 *   - `Admin`     — Executive permissions plus business-context management and
 *                   data-refresh actions.
 *
 * Single-group assignment per user (Requirement 2.1):
 *   Cognito user pools technically permit a user to belong to more than one
 *   group, so "exactly one role per user" is an operational + authorization
 *   invariant rather than a hard schema constraint. It is upheld here by:
 *   1. Group precedence ordering. Groups are declared least-privileged first,
 *      so `Executive` receives the highest precedence (lowest numeric value)
 *      and `Admin` the next. Cognito's `cognito:preferred_role` therefore
 *      resolves to the read-only role if a user is ever mistakenly placed in
 *      both groups — failing safe toward least privilege.
 *   2. Authorization checks (later tasks: SPA route guards in 2.3, and the API
 *      JWT authorizer / Admin-group assertion in Task 3) treat the user's role
 *      as a single effective role derived from the `cognito:groups` claim, and
 *      gate Admin-only actions on explicit `Admin` group membership
 *      (Requirements 2.3–2.6).
 *   3. Operationally, administrators assign each user to exactly one of the two
 *      groups when provisioning access.
 *
 * TODO(Task 2.2): Configure session/idle-expiry behavior surfaced to the SPA
 * (30-minute idle expiry, sign-out invalidation) (Requirements 1.4–1.6).
 */
export const auth = defineAuth({
  loginWith: {
    email: true,
  },
  // Declared least-privileged first so `Executive` has the highest group
  // precedence; a user in exactly one group gets that role, and any accidental
  // dual membership fails safe to the read-only Executive role.
  groups: ['Executive', 'Admin'],
});
