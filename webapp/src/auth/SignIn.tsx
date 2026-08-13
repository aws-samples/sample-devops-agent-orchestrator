import { useState, type FormEvent } from 'react';
import { useAuth } from './AuthContext';

/**
 * Sign-in view (Requirements 1.4, 1.7).
 *
 * This is the only resource served while a session is unauthenticated or
 * expired — it renders no hub-derived data. On invalid credentials it stays
 * mounted and shows the authentication error from the auth layer. When the
 * previous session expired from inactivity, it explains that re-authentication
 * is required (Requirement 1.6).
 */
export function SignIn(): JSX.Element {
  const { signIn, error, signingIn, signedOutReason } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    await signIn(email.trim(), password);
  };

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
      }}
    >
      <section
        style={{
          width: '100%',
          maxWidth: 360,
          border: '1px solid #d0d5dd',
          borderRadius: 8,
          padding: '2rem',
        }}
      >
        <h1 style={{ marginTop: 0, fontSize: '1.5rem' }}>Enterprise DevOps Observatory</h1>
        <p style={{ color: '#475467', marginTop: 0 }}>
          Sign in to access cross-account DevOps insights.
        </p>

        {signedOutReason === 'idle_expired' && (
          <p
            role="status"
            style={{
              background: '#fffaeb',
              border: '1px solid #fedf89',
              color: '#93370d',
              padding: '0.75rem',
              borderRadius: 6,
              fontSize: '0.875rem',
            }}
          >
            Your session expired after 30 minutes of inactivity. Please sign in
            again.
          </p>
        )}

        <form onSubmit={onSubmit} noValidate>
          <label htmlFor="email" style={labelStyle}>
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={signingIn}
            style={inputStyle}
          />

          <label htmlFor="password" style={labelStyle}>
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={signingIn}
            style={inputStyle}
          />

          {error && (
            <p
              role="alert"
              style={{
                color: '#b42318',
                fontSize: '0.875rem',
                margin: '0.75rem 0 0',
              }}
            >
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={signingIn || email.trim() === '' || password === ''}
            style={{
              marginTop: '1.25rem',
              width: '100%',
              padding: '0.625rem',
              borderRadius: 6,
              border: 'none',
              background: signingIn ? '#98a2b3' : '#175cd3',
              color: '#fff',
              fontSize: '0.9375rem',
              cursor: signingIn ? 'default' : 'pointer',
            }}
          >
            {signingIn ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}

const labelStyle = {
  display: 'block',
  fontSize: '0.8125rem',
  fontWeight: 600,
  color: '#344054',
  margin: '1rem 0 0.375rem',
} as const;

const inputStyle = {
  width: '100%',
  padding: '0.5rem 0.625rem',
  borderRadius: 6,
  border: '1px solid #d0d5dd',
  fontSize: '0.9375rem',
  boxSizing: 'border-box',
} as const;
