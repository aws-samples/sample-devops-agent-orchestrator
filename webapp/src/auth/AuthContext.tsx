import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  fetchAuthSession,
  getCurrentUser,
  signIn as amplifySignIn,
  signOut as amplifySignOut,
} from 'aws-amplify/auth';
import { Hub } from 'aws-amplify/utils';
import type { UserRole } from '@devops-observatory/shared-types';
import { useIdleTimer } from './useIdleTimer';

/**
 * Amplify Auth integration for the SPA (Task 2.2 — Requirements 1.3–1.7).
 *
 * Responsibilities:
 *  - Sign-in with valid credentials establishes an authenticated session and
 *    resolves the user's single effective role from the `cognito:groups`
 *    access-token claim (Requirement 1.3).
 *  - Invalid credentials leave no session, keep the user on the sign-in view,
 *    and surface an authentication error (Requirement 1.4).
 *  - Sign-out terminates and invalidates the Cognito session (global sign-out)
 *    and returns the user to the sign-in state (Requirement 1.5).
 *  - A 30-minute inactivity window expires the session and forces
 *    re-authentication (Requirement 1.6).
 *  - While unauthenticated or expired, the app renders only sign-in resources;
 *    no hub-derived data is loaded (Requirement 1.7 — enforced by the consuming
 *    UI gating on `status`).
 *
 * Credential safety (design): the browser holds only the Cognito session (JWT)
 * managed by Amplify. No AWS credentials are stored or used here.
 */

/** Auth lifecycle status the UI gates rendering on. */
export type AuthStatus = 'checking' | 'authenticated' | 'unauthenticated';

/** Reason the user was returned to the sign-in state, for messaging. */
export type SignedOutReason = 'idle_expired' | 'signed_out' | null;

export interface AuthUser {
  userId: string;
  username: string;
  role: UserRole;
}

export interface AuthContextValue {
  status: AuthStatus;
  user: AuthUser | null;
  /** Last authentication error message (e.g. invalid credentials). */
  error: string | null;
  /** True while a sign-in request is in flight. */
  signingIn: boolean;
  /** Why the session ended, so the sign-in view can explain (e.g. idle). */
  signedOutReason: SignedOutReason;
  /** Attempt sign-in. Returns true on success, false on failure. */
  signIn: (email: string, password: string) => Promise<boolean>;
  /** Sign out and invalidate the session. */
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * Resolve the user's single effective role from the access token's
 * `cognito:groups` claim. Groups are declared least-privileged first
 * (Executive before Admin, see amplify/auth/resource.ts), so a user in `Admin`
 * gets Admin; otherwise the role fails safe to the read-only Executive role.
 */
async function resolveRole(): Promise<UserRole> {
  const session = await fetchAuthSession();
  const claim = session.tokens?.accessToken?.payload?.['cognito:groups'];
  const groups: string[] = Array.isArray(claim)
    ? claim.filter((g): g is string => typeof g === 'string')
    : [];
  return groups.includes('Admin') ? 'Admin' : 'Executive';
}

function toMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as { name: unknown }).name);
    // Cognito returns these for bad username/password combinations.
    if (
      name === 'NotAuthorizedException' ||
      name === 'UserNotFoundException'
    ) {
      return 'The credentials you entered were not accepted. Please try again.';
    }
    if (name === 'UserNotConfirmedException') {
      return 'This account is not yet confirmed. Contact your administrator.';
    }
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return 'Sign-in failed. Please try again.';
}

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [status, setStatus] = useState<AuthStatus>('checking');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const [signedOutReason, setSignedOutReason] = useState<SignedOutReason>(null);

  // Guards against setting state after unmount during async auth calls.
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadUser = useCallback(async (): Promise<void> => {
    try {
      const current = await getCurrentUser();
      const role = await resolveRole();
      if (!mountedRef.current) {
        return;
      }
      setUser({
        userId: current.userId,
        username: current.username,
        role,
      });
      setStatus('authenticated');
    } catch {
      if (!mountedRef.current) {
        return;
      }
      setUser(null);
      setStatus('unauthenticated');
    }
  }, []);

  // Restore any existing session on first mount (e.g. page refresh). Until this
  // resolves, status is 'checking' and no data views render (Requirement 1.7).
  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  const clearSession = useCallback(
    async (reason: SignedOutReason): Promise<void> => {
      try {
        // Global sign-out revokes tokens so the session cannot be reused
        // (Requirement 1.5).
        await amplifySignOut({ global: true });
      } catch {
        // Even if the network call fails, drop local session state so the app
        // returns to the sign-in view and no hub data is served.
      }
      if (!mountedRef.current) {
        return;
      }
      setUser(null);
      setStatus('unauthenticated');
      setSignedOutReason(reason);
    },
    [],
  );

  const signIn = useCallback(
    async (email: string, password: string): Promise<boolean> => {
      setSigningIn(true);
      setError(null);
      setSignedOutReason(null);
      try {
        const result = await amplifySignIn({
          username: email,
          password,
        });

        if (!result.isSignedIn) {
          // A next step (e.g. new-password/MFA challenge) means no session was
          // established. Keep the user on the sign-in view (Requirement 1.4).
          if (mountedRef.current) {
            setError(
              'Additional sign-in steps are required. Contact your administrator.',
            );
          }
          return false;
        }

        await loadUser();
        return true;
      } catch (err) {
        // Invalid credentials: no session, stay on sign-in, show error
        // (Requirement 1.4).
        if (mountedRef.current) {
          setError(toMessage(err));
          setStatus('unauthenticated');
          setUser(null);
        }
        return false;
      } finally {
        if (mountedRef.current) {
          setSigningIn(false);
        }
      }
    },
    [loadUser],
  );

  const signOut = useCallback(async (): Promise<void> => {
    await clearSession('signed_out');
  }, [clearSession]);

  // 30-minute idle expiry (Requirement 1.6): only armed while authenticated.
  const handleIdle = useCallback(() => {
    void clearSession('idle_expired');
  }, [clearSession]);

  useIdleTimer({
    onIdle: handleIdle,
    enabled: status === 'authenticated',
  });

  // React to auth events raised elsewhere (e.g. token revocation/expiry).
  useEffect(() => {
    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      switch (payload.event) {
        case 'signedIn':
          void loadUser();
          break;
        case 'signedOut':
          if (mountedRef.current) {
            setUser(null);
            setStatus('unauthenticated');
          }
          break;
        case 'tokenRefresh_failure':
          // Expired/invalid refresh token — force re-authentication.
          void clearSession('idle_expired');
          break;
        default:
          break;
      }
    });
    return unsubscribe;
  }, [loadUser, clearSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      error,
      signingIn,
      signedOutReason,
      signIn,
      signOut,
    }),
    [status, user, error, signingIn, signedOutReason, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an <AuthProvider>');
  }
  return ctx;
}
