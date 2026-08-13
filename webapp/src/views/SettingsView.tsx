import { useEffect, useState } from 'react';
import {
  CHAT_HISTORY_MAX_RETENTION_DAYS,
  CHAT_HISTORY_MIN_RETENTION_DAYS,
} from '@devops-observatory/shared-types';
import { fetchSettings, saveSettings } from '../api/settings';
import { deleteA2aToken, fetchA2aConfiguredSpaces, storeA2aToken } from '../api/a2a';
import { fetchSpaces } from '../api/spaces';
import { ApiRequestError } from '../api/client';
import { getCustomOutputs } from '../amplifyConfig';
import { useAuth } from '../auth/AuthContext';
import { validateRetentionDays } from '../lib/settingsView';

/**
 * Settings view.
 *
 * Since Task 39 this view is visible to EVERY authenticated user:
 *   - All users get "Connect your AI app" — the external MCP endpoint, OAuth
 *     client id, and ready-to-paste client config (Requirement 16.8). These are
 *     public identifiers, not secrets; each user authenticates the OAuth flow
 *     with their own EDO credentials.
 *   - Admins additionally get the application settings: chat-memory retention,
 *     the external AI access (MCP) enable/disable toggle (Requirement 16.6),
 *     and the A2A token manager. The backend re-asserts the Admin group on
 *     every write, so an Executive can change nothing.
 */
export function SettingsView(): JSX.Element {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  // The external-access flag is LIFTED here so the "Connect your AI app"
  // status badge updates the moment an Admin toggles it (no page refresh):
  // AdminSettings reports changes up via onExternalChange.
  const [externalEnabled, setExternalEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    fetchSettings()
      .then((s) => {
        if (active) setExternalEnabled(s.externalMcpEnabled);
      })
      .catch(() => {
        /* the status badge just won't show */
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="settings-heading">
      <h2 id="settings-heading" style={{ marginTop: 0 }}>
        Settings
      </h2>
      <p style={{ color: '#475467', marginTop: '-0.25rem' }}>
        {isAdmin
          ? 'Manage application-wide settings and connect external AI applications.'
          : 'Connect your AI applications to DevOps Observatory.'}
      </p>
      {isAdmin && <AdminSettings onExternalChange={setExternalEnabled} />}
      <ConnectAiAppSection enabled={externalEnabled} />
    </section>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

function AdminSettings({
  onExternalChange,
}: {
  /** Reports the (persisted) external-access flag up so shared UI stays in sync. */
  onExternalChange: (enabled: boolean) => void;
}): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [retention, setRetention] = useState('');
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  // External AI access (MCP) flag (Task 39, Requirement 16.6) — toggled and
  // saved independently of the retention field.
  const [extEnabled, setExtEnabled] = useState(false);
  const [extSave, setExtSave] = useState<SaveState>({ status: 'idle' });

  useEffect(() => {
    let active = true;
    setLoad({ status: 'loading' });
    fetchSettings()
      .then((settings) => {
        if (!active) return;
        setRetention(String(settings.chatHistoryRetentionDays));
        setExtEnabled(settings.externalMcpEnabled);
        setLoad({ status: 'ready' });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiRequestError
            ? err.message
            : 'Unable to load settings right now. Please try again.';
        setLoad({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, []);

  const validation = validateRetentionDays(retention);

  async function handleSave(): Promise<void> {
    if (!validation.ok) {
      setSave({ status: 'error', message: validation.error });
      return;
    }
    setSave({ status: 'saving' });
    try {
      const saved = await saveSettings({ chatHistoryRetentionDays: validation.days });
      setRetention(String(saved.chatHistoryRetentionDays));
      setSave({ status: 'saved' });
    } catch (err: unknown) {
      const message =
        err instanceof ApiRequestError
          ? err.message
          : 'The settings could not be saved. The previously saved settings are unchanged.';
      setSave({ status: 'error', message });
    }
  }

  /** Toggle + persist the external MCP flag; revert the switch on failure. */
  async function handleToggleExternal(next: boolean): Promise<void> {
    setExtEnabled(next);
    setExtSave({ status: 'saving' });
    try {
      const saved = await saveSettings({ externalMcpEnabled: next });
      setExtEnabled(saved.externalMcpEnabled);
      onExternalChange(saved.externalMcpEnabled); // sync the connect-section badge
      setExtSave({ status: 'saved' });
    } catch (err: unknown) {
      setExtEnabled(!next); // revert — nothing was persisted
      const message =
        err instanceof ApiRequestError
          ? err.message
          : 'The setting could not be saved. The previous value is unchanged.';
      setExtSave({ status: 'error', message });
    }
  }

  return (
    <div>
      {load.status === 'loading' && (
        <p role="status" aria-live="polite" style={{ color: '#475467' }}>
          Loading settings…
        </p>
      )}

      {load.status === 'error' && (
        <p role="alert" style={errorBannerStyle}>
          {load.message}
        </p>
      )}

      {load.status === 'ready' && (
        <div style={{ marginTop: '1.5rem', maxWidth: 520 }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: '#101828' }}>Chat memory</h3>
          <p style={{ margin: '0 0 0.75rem', color: '#667085', fontSize: '0.875rem' }}>
            How long each user's chat conversation is remembered before it automatically expires.
            Allowed range: {CHAT_HISTORY_MIN_RETENTION_DAYS}–{CHAT_HISTORY_MAX_RETENTION_DAYS} days.
          </p>

          <label
            htmlFor="retention-days"
            style={{
              display: 'block',
              fontSize: '0.75rem',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.02em',
              color: '#667085',
              marginBottom: '0.25rem',
            }}
          >
            Retention (days)
          </label>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <input
              id="retention-days"
              type="number"
              min={CHAT_HISTORY_MIN_RETENTION_DAYS}
              max={CHAT_HISTORY_MAX_RETENTION_DAYS}
              value={retention}
              aria-invalid={!validation.ok}
              onChange={(e) => {
                setRetention(e.target.value);
                if (save.status !== 'idle') setSave({ status: 'idle' });
              }}
              style={{
                width: 120,
                padding: '0.5rem 0.75rem',
                borderRadius: 6,
                border: `1px solid ${validation.ok ? '#d0d5dd' : '#fda29b'}`,
                fontSize: '0.9375rem',
              }}
            />
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={save.status === 'saving' || !validation.ok}
              style={{
                padding: '0.5rem 1rem',
                borderRadius: 6,
                border: 'none',
                background: save.status === 'saving' || !validation.ok ? '#98a2b3' : '#175cd3',
                color: '#fff',
                cursor: save.status === 'saving' || !validation.ok ? 'not-allowed' : 'pointer',
                fontSize: '0.9375rem',
                fontWeight: 600,
              }}
            >
              {save.status === 'saving' ? 'Saving…' : 'Save'}
            </button>
          </div>

          {!validation.ok && retention.trim().length > 0 && (
            <p role="alert" style={{ margin: '0.5rem 0 0', color: '#b42318', fontSize: '0.875rem' }}>
              {validation.error}
            </p>
          )}
          {save.status === 'saved' && (
            <p role="status" style={{ ...successBannerStyle, marginTop: '0.75rem' }}>
              Settings saved.
            </p>
          )}
          {save.status === 'error' && (
            <p role="alert" style={{ ...errorBannerStyle, marginTop: '0.75rem' }}>
              {save.message}
            </p>
          )}
        </div>
      )}

      {load.status === 'ready' && (
        <div style={{ marginTop: '2.5rem', maxWidth: 640 }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: '#101828' }}>
            External AI access (MCP)
          </h3>
          <p style={{ margin: '0 0 0.75rem', color: '#667085', fontSize: '0.875rem' }}>
            Allow users to connect external AI applications (Kiro, Claude, chatbots) to DevOps
            Observatory via the MCP endpoint (see &quot;Connect your AI app&quot; below). Turning
            this off blocks every external tool call immediately; the web app&apos;s own chat is
            not affected.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', fontSize: '0.9375rem', color: '#101828' }}>
            <input
              type="checkbox"
              checked={extEnabled}
              disabled={extSave.status === 'saving'}
              onChange={(e) => void handleToggleExternal(e.target.checked)}
            />
            External AI access is <strong>{extEnabled ? 'enabled' : 'disabled'}</strong>
            {extSave.status === 'saving' && <span style={{ color: '#667085' }}> (saving…)</span>}
          </label>
          {extSave.status === 'saved' && (
            <p role="status" style={{ ...successBannerStyle, marginTop: '0.75rem' }}>
              Setting saved. It takes effect within seconds.
            </p>
          )}
          {extSave.status === 'error' && (
            <p role="alert" style={{ ...errorBannerStyle, marginTop: '0.75rem' }}>
              {extSave.message}
            </p>
          )}
        </div>
      )}

      <A2aTokenSection />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connect your AI app (external MCP access, Task 39 — all users)
// ---------------------------------------------------------------------------

/** Build the Kiro / Claude Desktop `mcpServers` config for the EDO endpoint. */
function buildMcpClientConfig(mcpUrl: string, clientId: string): string {
  const clientInfo = JSON.stringify({
    client_id: clientId,
    redirect_uris: ['http://localhost:3334/oauth/callback'],
    scope: 'openid email profile',
  });
  return JSON.stringify(
    {
      mcpServers: {
        'devops-observatory': {
          command: 'npx',
          args: ['-y', 'mcp-remote', mcpUrl, '3334', '--static-oauth-client-info', clientInfo],
        },
      },
    },
    null,
    2,
  );
}

/**
 * "Connect your AI app" — visible to EVERY authenticated user (Requirement
 * 16.8). Shows the external MCP endpoint, the OAuth client id, and a
 * ready-to-paste config snippet (Kiro `mcp.json`; the same shape works for
 * Claude Desktop and Cursor). Connecting pops the EDO sign-in in the browser —
 * each user authenticates with their own EDO credentials, so no secrets appear
 * here. Also surfaces whether an Admin has external access enabled.
 */
function ConnectAiAppSection({ enabled }: { enabled: boolean | null }): JSX.Element {
  const outputs = getCustomOutputs();
  const mcpUrl = typeof outputs?.externalMcpUrl === 'string' ? outputs.externalMcpUrl : '';
  const clientId =
    typeof outputs?.externalMcpClientId === 'string' ? outputs.externalMcpClientId : '';
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(label: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((prev) => (prev === label ? null : prev)), 2000);
    } catch {
      /* clipboard unavailable — user can select the text manually */
    }
  }

  if (!mcpUrl || !clientId) {
    return (
      <div style={{ marginTop: '2.5rem', maxWidth: 640 }}>
        <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: '#101828' }}>
          Connect your AI app
        </h3>
        <p style={{ color: '#667085', fontSize: '0.875rem' }}>
          The external MCP endpoint is not available in this deployment yet.
        </p>
      </div>
    );
  }

  const snippet = buildMcpClientConfig(mcpUrl, clientId);

  return (
    <div style={{ marginTop: '2.5rem', maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
        <h3 style={{ margin: 0, fontSize: '1rem', color: '#101828' }}>Connect your AI app</h3>
        {enabled !== null && (
          <span
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              borderRadius: 999,
              padding: '0.125rem 0.5rem',
              color: enabled ? '#067647' : '#b42318',
              background: enabled ? '#ecfdf3' : '#fef3f2',
            }}
          >
            {enabled ? 'Enabled' : 'Disabled by administrator'}
          </span>
        )}
      </div>
      <p style={{ margin: '0.5rem 0 0.75rem', color: '#667085', fontSize: '0.875rem' }}>
        Use DevOps Observatory from Kiro, Claude Desktop, or any MCP-capable AI app. Your app gets
        read-only tools grounded in the knowledge base, topology graph, business context, and live
        agent spaces. When connecting, a browser window asks you to sign in with your DevOps
        Observatory account — no keys or secrets to paste.
      </p>

      <ConnectField
        label="MCP endpoint"
        value={mcpUrl}
        copied={copied === 'url'}
        onCopy={() => void copy('url', mcpUrl)}
      />
      <ConnectField
        label="OAuth client id"
        value={clientId}
        copied={copied === 'client'}
        onCopy={() => void copy('client', clientId)}
      />

      <p style={{ margin: '0.875rem 0 0.375rem', fontSize: '0.8125rem', fontWeight: 600, color: '#344054' }}>
        Kiro — add to <code>~/.kiro/settings/mcp.json</code> (same shape works for Claude Desktop
        and Cursor):
      </p>
      <div style={{ position: 'relative' }}>
        <pre
          style={{
            margin: 0,
            padding: '0.75rem',
            background: '#f9fafb',
            border: '1px solid #eaecf0',
            borderRadius: 8,
            fontSize: '0.75rem',
            overflowX: 'auto',
            whiteSpace: 'pre',
          }}
        >
          {snippet}
        </pre>
        <button
          type="button"
          onClick={() => void copy('snippet', snippet)}
          style={{ ...smallButtonStyle, position: 'absolute', top: 8, right: 8 }}
        >
          {copied === 'snippet' ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <p style={{ margin: '0.5rem 0 0', fontSize: '0.8125rem', color: '#98a2b3' }}>
        Requires Node.js (for <code>npx mcp-remote</code>). If port 3334 is in use, change both the
        port argument and the redirect URI port together — they must match.
      </p>
    </div>
  );
}

/** A labeled, copyable read-only value row for the connect section. */
function ConnectField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}): JSX.Element {
  return (
    <div style={{ marginBottom: '0.5rem' }}>
      <span style={{ display: 'block', fontSize: '0.75rem', fontWeight: 600, color: '#667085', textTransform: 'uppercase', letterSpacing: '0.02em' }}>
        {label}
      </span>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <code
          style={{
            flex: 1,
            padding: '0.375rem 0.5rem',
            background: '#f9fafb',
            border: '1px solid #eaecf0',
            borderRadius: 6,
            fontSize: '0.8125rem',
            overflowX: 'auto',
            whiteSpace: 'nowrap',
          }}
        >
          {value}
        </code>
        <button type="button" onClick={onCopy} style={smallButtonStyle}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent-to-Agent (A2A) access tokens (Task 37)
// ---------------------------------------------------------------------------

interface A2aSpaceListItem {
  agentSpaceId: string;
  name?: string;
  account: string;
  configured: boolean;
}

/**
 * Admin-only section to configure each Agent Space's A2A Bearer access token.
 * Tokens are created MANUALLY in the DevOps Agent web app (Settings → Access
 * Tokens, `agent` client type) and pasted here; they are stored in Secrets
 * Manager and NEVER shown again. A configured space gets an "A2A" badge in the
 * Spaces view and becomes selectable in the Chat view.
 */
function A2aTokenSection(): JSX.Element {
  const [items, setItems] = useState<A2aSpaceListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = () => {
    setError(null);
    Promise.all([fetchSpaces(), fetchA2aConfiguredSpaces()])
      .then(([spacesDto, configured]) => {
        const configuredIds = new Set(configured.spaces.map((s) => s.agentSpaceId));
        const list: A2aSpaceListItem[] = [];
        for (const account of spacesDto.accounts) {
          for (const space of account.spaces) {
            list.push({
              agentSpaceId: space.agentSpaceId,
              name: space.displayName,
              account: account.account,
              configured: configuredIds.has(space.agentSpaceId),
            });
          }
        }
        list.sort((a, b) => Number(b.configured) - Number(a.configured) || (a.name ?? '').localeCompare(b.name ?? ''));
        setItems(list);
      })
      .catch((err: unknown) =>
        setError(err instanceof ApiRequestError ? err.message : 'Unable to load agent spaces.'),
      );
  };

  useEffect(load, []);

  const setConfigured = (spaceId: string, configured: boolean) => {
    setItems((prev) =>
      prev
        ? prev.map((it) => (it.agentSpaceId === spaceId ? { ...it, configured } : it))
        : prev,
    );
  };

  const filtered = (items ?? []).filter((it) => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return true;
    return (
      (it.name ?? '').toLowerCase().includes(q) ||
      it.agentSpaceId.toLowerCase().includes(q) ||
      it.account.includes(q)
    );
  });

  return (
    <div style={{ marginTop: '2.5rem', maxWidth: 640 }}>
      <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem', color: '#101828' }}>
        Agent-to-Agent (A2A) access tokens
      </h3>
      <p style={{ margin: '0 0 0.75rem', color: '#667085', fontSize: '0.875rem' }}>
        Store a per-space access token so the app can talk to a space live from the Chat view.
        Create an <strong>agent</strong>-type token in the DevOps Agent web app (Settings → Access
        Tokens), then paste it here. Tokens are stored securely and never shown again.
      </p>

      {error && <p role="alert" style={errorBannerStyle}>{error}</p>}
      {items === null && !error && (
        <p role="status" style={{ color: '#475467' }}>Loading agent spaces…</p>
      )}

      {items !== null && items.length === 0 && (
        <p style={{ color: '#667085', fontSize: '0.875rem' }}>
          No agent spaces are available yet. Run a data refresh first.
        </p>
      )}

      {items !== null && items.length > 0 && (
        <>
          <input
            type="search"
            name="a2a-space-search"
            value={query}
            placeholder="Search spaces by name, id, or account…"
            aria-label="Search agent spaces"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '0.5rem 0.75rem',
              borderRadius: 6,
              border: '1px solid #d0d5dd',
              fontSize: '0.9375rem',
              marginBottom: '0.75rem',
            }}
          />
          <div style={{ display: 'grid', gap: '0.625rem' }}>
            {filtered.map((it) => (
              <A2aSpaceRow key={it.agentSpaceId} item={it} onConfiguredChange={setConfigured} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** One space row with an inline add/replace/remove token control. */
function A2aSpaceRow({
  item,
  onConfiguredChange,
}: {
  item: A2aSpaceListItem;
  onConfiguredChange: (spaceId: string, configured: boolean) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [token, setToken] = useState('');
  const [tokenName, setTokenName] = useState('');
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (token.trim().length === 0) {
      setError('Paste the access token value.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await storeA2aToken(item.agentSpaceId, {
        token: token.trim(),
        ...(tokenName.trim() ? { tokenName: tokenName.trim() } : {}),
        ...(scope.trim() ? { scope: scope.trim() } : {}),
      });
      setToken('');
      setEditing(false);
      onConfiguredChange(item.agentSpaceId, true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to store the token.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deleteA2aToken(item.agentSpaceId);
      onConfiguredChange(item.agentSpaceId, false);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Unable to remove the token.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ border: '1px solid #eaecf0', borderRadius: 8, padding: '0.75rem 0.875rem', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontWeight: 600, color: '#101828', fontSize: '0.9375rem' }}>
            {item.name ?? item.agentSpaceId}
            {item.configured && (
              <span
                style={{
                  marginLeft: '0.5rem',
                  fontSize: '0.625rem',
                  fontWeight: 700,
                  color: '#067647',
                  background: '#ecfdf3',
                  border: '1px solid #abefc6',
                  borderRadius: 999,
                  padding: '0.0625rem 0.375rem',
                  verticalAlign: 'middle',
                }}
              >
                Configured
              </span>
            )}
          </p>
          <p style={{ margin: '0.125rem 0 0', fontSize: '0.75rem', color: '#98a2b3' }}>
            account {item.account}
          </p>
        </div>
        {!editing && (
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
            <button type="button" onClick={() => setEditing(true)} disabled={busy} style={smallButtonStyle}>
              {item.configured ? 'Replace' : 'Add token'}
            </button>
            {item.configured && (
              <button type="button" onClick={() => void remove()} disabled={busy} style={smallButtonStyle}>
                {busy ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div
          style={{
            display: 'grid',
            gap: '0.625rem',
            marginTop: '0.75rem',
            paddingTop: '0.75rem',
            borderTop: '1px solid #eaecf0',
          }}
        >
          <label
            style={{
              display: 'grid',
              gap: '0.25rem',
              fontSize: '0.75rem',
              fontWeight: 600,
              color: '#344054',
            }}
          >
            Access token
            {/* Plain text (not type=password) so the browser's password-manager
                overlay never covers the Save button directly below it. */}
            <input
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
              placeholder="Paste access token (aidevops_v1_…)"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              /* eslint-disable-next-line jsx-a11y/no-autofocus */
              autoFocus
              style={{ ...tokenInputStyle, fontFamily: 'monospace' }}
            />
          </label>

          {/* Token's OWN save/cancel controls — immediately under the token
              field so they can't be confused with the Chat-memory Save above. */}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" onClick={() => void save()} disabled={busy} style={primarySmallButtonStyle}>
              {busy ? 'Saving…' : 'Save token'}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setToken('');
                setTokenName('');
                setScope('');
                setError(null);
              }}
              disabled={busy}
              style={smallButtonStyle}
            >
              Cancel
            </button>
          </div>

          {error && <p role="alert" style={{ margin: 0, color: '#b42318', fontSize: '0.8125rem' }}>{error}</p>}

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <input
              type="text"
              value={tokenName}
              onChange={(e) => setTokenName(e.target.value)}
              disabled={busy}
              placeholder="Name (optional)"
              autoComplete="off"
              style={{ ...tokenInputStyle, flex: 1 }}
            />
            <input
              type="text"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              disabled={busy}
              placeholder="Scope (optional)"
              autoComplete="off"
              style={{ ...tokenInputStyle, width: 160 }}
            />
          </div>
        </div>
      )}
      {!editing && error && (
        <p role="alert" style={{ margin: '0.5rem 0 0', color: '#b42318', fontSize: '0.8125rem' }}>{error}</p>
      )}
    </div>
  );
}

const smallButtonStyle = {
  padding: '0.375rem 0.75rem',
  borderRadius: 6,
  border: '1px solid #d0d5dd',
  background: '#fff',
  color: '#344054',
  cursor: 'pointer',
  fontSize: '0.8125rem',
  fontWeight: 600,
} as const;

const primarySmallButtonStyle = {
  ...smallButtonStyle,
  border: 'none',
  background: '#175cd3',
  color: '#fff',
} as const;

const tokenInputStyle = {
  padding: '0.5rem 0.625rem',
  borderRadius: 6,
  border: '1px solid #d0d5dd',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  boxSizing: 'border-box' as const,
  width: '100%',
} as const;

const successBannerStyle = {
  color: '#027a48',
  background: '#ecfdf3',
  border: '1px solid #a6f4c5',
  borderRadius: 8,
  padding: '0.875rem 1rem',
} as const;

const errorBannerStyle = {
  color: '#b42318',
  background: '#fef3f2',
  border: '1px solid #fecdca',
  borderRadius: 8,
  padding: '0.875rem 1rem',
} as const;
