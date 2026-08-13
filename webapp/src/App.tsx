import { RequireAuth } from './auth/RequireAuth';
import { NavShell } from './nav/NavShell';

/**
 * Application shell.
 *
 * Auth gating (Requirements 1.2, 1.7) is enforced by the reusable
 * {@link RequireAuth} route guard (Task 2.3): while the session is checking,
 * unauthenticated, or expired, the guard renders the loading/sign-in resources
 * and never mounts the protected subtree, so no hub-derived data view renders
 * or fetches. Only once authenticated does {@link NavShell} render.
 *
 * Task 11 delivers the persistent navigation shell + the default Summary
 * landing view ({@link NavShell}). Later tasks (12–17) fill in the remaining
 * views, which are routed as placeholders inside the same shell for now.
 */
function App(): JSX.Element {
  return (
    <RequireAuth>
      <NavShell />
    </RequireAuth>
  );
}

export default App;
