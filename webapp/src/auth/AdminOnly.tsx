import type { ReactNode } from 'react';
import type { UserRole } from '@devops-observatory/shared-types';

/**
 * Client-side Admin gate for Admin-only features (Task 16 — Requirements 2.3,
 * 2.4). Renders its children only for the Admin role; any other role (or an
 * absent role) sees an access-denied notice and none of the protected UI.
 *
 * This is defense-in-depth layered on top of the navigation registry, which
 * already hides Admin-only entries from Executives (`visibleNavItems`) and
 * refuses to route them to an Admin view (`resolveVisibleView`). The backend
 * independently authorizes every Admin-only route (`PUT /context`,
 * `POST /refresh`, `GET /refresh/status`), so even if this gate were bypassed
 * no state could change (Requirement 2.3).
 */
export function AdminOnly({
  role,
  feature,
  children,
}: {
  role: UserRole | undefined;
  /** Human-readable feature name shown in the denial notice. */
  feature: string;
  children: ReactNode;
}): JSX.Element {
  if (role === 'Admin') {
    return <>{children}</>;
  }
  return (
    <section aria-labelledby="admin-denied-heading">
      <h2 id="admin-denied-heading" style={{ marginTop: 0 }}>
        {feature}
      </h2>
      <p
        role="alert"
        style={{
          marginTop: '1rem',
          padding: '1rem 1.25rem',
          borderRadius: 12,
          border: '1px solid #fecdca',
          background: '#fef3f2',
          color: '#b42318',
        }}
      >
        You do not have permission to access this feature. It is available to administrators only.
      </p>
    </section>
  );
}
