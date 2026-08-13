import type { ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { SignIn } from './SignIn';

/**
 * Client-side route guard (Task 2.3 — Requirement 1.2).
 *
 * Wraps any protected data view so that unauthenticated or expired sessions are
 * redirected to the sign-in resources *before* the guarded content mounts. This
 * is the single, reusable gate that later navigation/data-view tasks (11–16)
 * compose their views inside of, so no hub-derived data view can render for a
 * visitor who is not authenticated.
 *
 * Rendering rules, in priority order:
 *  1. `checking` — session restore is still in flight. Render the neutral
 *     fallback (never the guarded content), so no data view flashes before auth
 *     resolves (Requirement 1.2, 1.7).
 *  2. unauthenticated / expired / no user — render the sign-in view instead of
 *     the guarded content. In this SPA the "redirect to sign-in" is a render
 *     swap: the protected subtree is never mounted, so its data loaders never
 *     run (Requirement 1.2, 1.7).
 *  3. authenticated — render the guarded content.
 *
 * Credential safety: because the guarded subtree is not rendered until
 * `status === 'authenticated'`, any data fetching those children perform on
 * mount cannot execute while unauthenticated. The guard is the enforcement
 * point, not the individual views.
 */
export interface RequireAuthProps {
  /** Protected content rendered only once the session is authenticated. */
  children: ReactNode;
  /**
   * Optional UI shown while the session is being restored (`checking`).
   * Defaults to a minimal loading screen. Never renders `children`.
   */
  fallback?: ReactNode;
}

export function RequireAuth({ children, fallback }: RequireAuthProps): JSX.Element {
  const { status, user } = useAuth();

  // 1. Session restore in progress — render neither sign-in nor guarded content
  //    so no data view flashes before auth resolves.
  if (status === 'checking') {
    return <>{fallback ?? <AuthCheckingScreen />}</>;
  }

  // 2. Unauthenticated or expired: serve sign-in resources only. The guarded
  //    subtree is not mounted, so no hub-derived data is fetched or rendered.
  if (status !== 'authenticated' || !user) {
    return <SignIn />;
  }

  // 3. Authenticated: render the protected content.
  return <>{children}</>;
}

/** Neutral loading screen shown while the auth session is being restored. */
export function AuthCheckingScreen(): JSX.Element {
  return (
    <main
      role="status"
      aria-live="polite"
      style={{
        fontFamily: 'system-ui, sans-serif',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        color: '#475467',
      }}
    >
      <p>Loading…</p>
    </main>
  );
}
