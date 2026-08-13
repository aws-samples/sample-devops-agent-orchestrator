import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AccountSpaces, SpaceRow, SpacesDTO } from '@devops-observatory/shared-types';
import { createSpace, fetchSpaces } from '../api/spaces';
import { fetchA2aConfiguredSpaces } from '../api/a2a';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { formatNullableMetric, UNKNOWN_METRIC_HINT } from '../lib/format';
import { NO_ACCOUNT_DATA_MESSAGE, resolveErrorMessage } from '../lib/viewState';
import { LoadingMessage, ErrorMessage, EmptyMessage } from '../components/StateMessage';
import { FreshnessIndicator } from '../components/FreshnessIndicator';
import { Pager } from '../components/Pager';
import { paginate } from '../lib/pagination';
import {
  defaultSpaceName,
  isCreateSpaceFormValid,
  validateCreateSpaceForm,
} from '../lib/createSpaceForm';
import {
  getPendingSpaceAccounts,
  markSpacesPending,
  reconcilePendingSpaces,
} from '../lib/pendingSpaces';
import {
  accountIdentity,
  accountsWithSpaceIds,
  filterSpaceAccounts,
  hasNoSpaces,
  spaceCapabilityEntries,
  spaceCountEntries,
  statusLabel,
} from '../lib/spacesView';

/** Accounts shown per page in the Space_View (Requirement 3.9). */
const SPACES_PAGE_SIZE = 20;

/**
 * Space_View (Task 12 — Requirements 3.1–3.6).
 *
 * Lists each Linked_Account present in the Manifest with its Agent_Spaces
 * grouped underneath (3.1). For every space it shows the space name — or the
 * `agentSpaceId` when unnamed — with the space's activity counts (3.2). Each
 * account shows a collected/incomplete data-completeness status (3.3), the
 * Last_Sync_Date rendered in UTC (3.4), the business-context display name /
 * Business_Unit as the primary identifier with the raw AWS account id kept as a
 * secondary reference (3.5), and a "no agent spaces" notice when the account has
 * none (3.6).
 *
 * Data comes exclusively from `GET /spaces` (no AWS credentials in the browser).
 * If the manifest is unavailable the API returns an error and this view renders
 * an error state instead of a partial listing (Requirement 3.7, owned by the
 * API + cross-cutting Task 17).
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; spaces: SpacesDTO }
  | { status: 'error'; message: string };

export function SpaceView(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  // Accounts with a pending (asynchronous) space creation. We intentionally do
  // NOT re-fetch after a create — the new space only appears after the next data
  // refresh — so these accounts show a "Pending refresh" badge until then.
  const [pending, setPending] = useState<Set<string>>(() => getPendingSpaceAccounts());
  // Space ids that have an A2A token configured (shown as an "A2A" badge). Best
  // effort — if this fails the listing still renders, just without badges.
  const [a2aSpaceIds, setA2aSpaceIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    fetchSpaces()
      .then((spaces) => {
        if (!active) return;
        setState({ status: 'ready', spaces });
        // Clear any pending marker for accounts that now actually have spaces.
        setPending(reconcilePendingSpaces(accountsWithSpaceIds(spaces.accounts)));
      })
      .catch((err: unknown) => {
        if (!active) {
          return;
        }
        const message = resolveErrorMessage(
          err,
          'Unable to load agent spaces right now. Please try again.',
        );
        setState({ status: 'error', message });
      });
    fetchA2aConfiguredSpaces()
      .then((res) => {
        if (active) setA2aSpaceIds(new Set(res.spaces.map((s) => s.agentSpaceId)));
      })
      .catch(() => {
        /* badges are best-effort */
      });
    return () => {
      active = false;
    };
  }, []);

  // Record a pending create without re-fetching (Requirement: mark "Pending
  // refresh", do not refresh on every creation).
  const markPending = (accountId: string) => {
    markSpacesPending([accountId]);
    setPending((prev) => new Set(prev).add(accountId));
  };

  return (
    <section aria-labelledby="spaces-heading">
      <h2 id="spaces-heading" style={{ marginTop: 0 }}>
        Spaces
      </h2>
      <p style={{ color: '#475467', marginTop: '-0.25rem' }}>
        Agent spaces grouped by linked account, with collection status and data freshness.
      </p>

      {state.status === 'loading' && <LoadingMessage>Loading agent spaces…</LoadingMessage>}

      {state.status === 'error' && <ErrorMessage>{state.message}</ErrorMessage>}

      {state.status === 'ready' && (
        <SpacesList
          spaces={state.spaces}
          pending={pending}
          onCreated={markPending}
          a2aSpaceIds={a2aSpaceIds}
        />
      )}
    </section>
  );
}

function SpacesList({
  spaces,
  pending,
  onCreated,
  a2aSpaceIds,
}: {
  spaces: SpacesDTO;
  pending: Set<string>;
  onCreated: (accountId: string) => void;
  a2aSpaceIds: Set<string>;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  // Reset to the first page whenever the search term changes so results are
  // never hidden behind a now-out-of-range page.
  const filtered = useMemo(() => filterSpaceAccounts(spaces.accounts, query), [spaces.accounts, query]);
  const pageData = paginate(filtered, page, SPACES_PAGE_SIZE);

  if (spaces.accounts.length === 0) {
    return <EmptyMessage>No linked accounts were found in the manifest.</EmptyMessage>;
  }

  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
        <input
          type="search"
          name="account-search"
          value={query}
          placeholder="Search accounts by id, name, business unit, or space…"
          aria-label="Search linked accounts"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
          style={{
            flex: 1,
            minWidth: 260,
            padding: '0.5rem 0.75rem',
            borderRadius: 6,
            border: '1px solid #d0d5dd',
            fontSize: '0.9375rem',
            boxSizing: 'border-box',
          }}
        />
        <span style={{ color: '#667085', fontSize: '0.8125rem' }}>
          {filtered.length} of {spaces.accounts.length} accounts
        </span>
      </div>

      {filtered.length === 0 ? (
        <EmptyMessage>No linked accounts match “{query}”.</EmptyMessage>
      ) : (
        <>
          <div style={{ display: 'grid', gap: '1rem', marginTop: '1rem' }}>
            {pageData.items.map((account) => (
              <AccountCard
                key={account.account}
                account={account}
                pending={pending.has(account.account)}
                onCreated={onCreated}
                a2aSpaceIds={a2aSpaceIds}
              />
            ))}
          </div>
          <Pager page={pageData} onPageChange={setPage} unit="accounts" />
        </>
      )}
    </div>
  );
}

function AccountCard({
  account,
  pending,
  onCreated,
  a2aSpaceIds,
}: {
  account: AccountSpaces;
  pending: boolean;
  onCreated: (accountId: string) => void;
  a2aSpaceIds: Set<string>;
}): JSX.Element {
  const { user } = useAuth();
  const isAdmin = user?.role === 'Admin';
  const identity = accountIdentity(account);
  const empty = hasNoSpaces(account);

  return (
    <article
      style={{
        border: '1px solid #eaecf0',
        borderRadius: 12,
        background: '#fff',
        boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '0.5rem 1rem',
          padding: '1.125rem 1.25rem',
          borderBottom: '1px solid #f2f4f7',
        }}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: '1.0625rem', color: '#101828' }}>{identity.primary}</h3>
          {identity.secondary && (
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: '#667085' }}>
              AWS account <code>{identity.secondary}</code>
            </p>
          )}
          {account.businessUnit && (
            <p style={{ margin: '0.25rem 0 0', fontSize: '0.8125rem', color: '#667085' }}>
              Business unit: {account.businessUnit}
            </p>
          )}
        </div>
        <div style={{ textAlign: 'right' }}>
          {pending && <PendingRefreshBadge />}
          <StatusBadge status={account.status} />
          <FreshnessIndicator value={account.lastSyncDate} label="Last sync" compact />
        </div>
      </header>

      <div style={{ padding: '1rem 1.25rem 1.25rem' }}>
        {empty ? (
          <EmptyMessage compact>{NO_ACCOUNT_DATA_MESSAGE}</EmptyMessage>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.75rem' }}>
            {account.spaces.map((space) => (
              <li key={space.agentSpaceId}>
                <SpaceItem space={space} a2aConfigured={a2aSpaceIds.has(space.agentSpaceId)} />
              </li>
            ))}
          </ul>
        )}

        {/* Admin-only create control, shown ONLY when the account has no agent
            space yet (Requirement 3.6 — prompt to create when none exist). Once
            an account has at least one space the control is hidden. The backend
            independently authorizes POST /spaces, so this is UX only. */}
        {isAdmin && empty && <CreateSpacePanel account={account} onCreated={onCreated} />}
      </div>
    </article>
  );
}

/**
 * Admin-only inline control to create a new agent space in an account
 * (Requirement 3.6 — "prompt to create one" when none exist). Collapsed to a
 * button by default; expands to a small form (name prefilled to the CLI-style
 * default, optional description) with client-side validation mirroring the
 * backend bounds. On success it triggers a re-fetch of the listing.
 */
function CreateSpacePanel({
  account,
  onCreated,
}: {
  account: AccountSpaces;
  onCreated: (accountId: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(() => defaultSpaceName(account.account));
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  const issues = validateCreateSpaceForm(name, description);
  const valid = isCreateSpaceFormValid(issues);

  const submit = async (): Promise<void> => {
    setShowErrors(true);
    if (!valid) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const res = await createSpace({
        accountId: account.account,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setShowErrors(false);
      // Mark "Pending refresh" instead of re-fetching — the new space (with its
      // primary account attached) appears after the next data refresh.
      onCreated(account.account);
      // The space was created, but if its primary account could not be attached
      // keep the panel open to surface the warning; otherwise close.
      if (res.space.primaryAccountConfigured === false && res.space.warning) {
        setNotice(res.space.warning);
      } else {
        setOpen(false);
        setDescription('');
      }
    } catch (err: unknown) {
      const message =
        err instanceof ApiRequestError
          ? err.message
          : 'The agent space could not be created. Please try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <div style={{ marginTop: '0.75rem' }}>
        <button type="button" onClick={() => setOpen(true)} style={createButtonStyle(true)}>
          Create an agent space
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        marginTop: '1rem',
        padding: '1rem',
        border: '1px solid #eaecf0',
        borderRadius: 8,
        background: '#fcfcfd',
        display: 'grid',
        gap: '0.75rem',
      }}
    >
      <p style={{ margin: 0, fontWeight: 600, fontSize: '0.9375rem', color: '#101828' }}>
        New agent space in <code>{account.account}</code>
      </p>

      <label style={fieldLabelStyle}>
        Name
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          style={inputStyle}
        />
      </label>
      {showErrors && issues.name && <FieldError>{issues.name}</FieldError>}

      <label style={fieldLabelStyle}>
        Description (optional)
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={submitting}
          rows={2}
          style={{ ...inputStyle, resize: 'vertical' }}
        />
      </label>
      {showErrors && issues.description && <FieldError>{issues.description}</FieldError>}

      {error && <FieldError role="alert">{error}</FieldError>}

      {notice && (
        <p
          role="status"
          style={{
            margin: 0,
            padding: '0.5rem 0.75rem',
            borderRadius: 6,
            border: '1px solid #fedf89',
            background: '#fffaeb',
            color: '#b54708',
            fontSize: '0.8125rem',
          }}
        >
          Space created. {notice}
        </p>
      )}

      <div style={{ display: 'flex', gap: '0.5rem' }}>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          style={createButtonStyle(true)}
        >
          {submitting ? 'Creating…' : 'Create space'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
            setNotice(null);
            setShowErrors(false);
          }}
          disabled={submitting}
          style={cancelButtonStyle}
        >
          {notice ? 'Close' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}

function FieldError({ children, role }: { children: ReactNode; role?: string }): JSX.Element {
  return (
    <p role={role} style={{ margin: 0, color: '#b42318', fontSize: '0.8125rem' }}>
      {children}
    </p>
  );
}

const fieldLabelStyle = {
  display: 'grid',
  gap: '0.25rem',
  fontSize: '0.8125rem',
  fontWeight: 600,
  color: '#344054',
} as const;

const inputStyle = {
  padding: '0.5rem 0.625rem',
  borderRadius: 6,
  border: '1px solid #d0d5dd',
  fontSize: '0.875rem',
  fontFamily: 'inherit',
  boxSizing: 'border-box' as const,
  width: '100%',
};

function createButtonStyle(emphasized: boolean) {
  return {
    padding: '0.5rem 1rem',
    borderRadius: 6,
    border: 'none',
    background: emphasized ? '#175cd3' : '#eff4ff',
    color: emphasized ? '#fff' : '#175cd3',
    cursor: 'pointer',
    fontSize: '0.875rem',
    fontWeight: 600,
  } as const;
}

const cancelButtonStyle = {
  padding: '0.5rem 1rem',
  borderRadius: 6,
  border: '1px solid #d0d5dd',
  background: '#fff',
  color: '#344054',
  cursor: 'pointer',
  fontSize: '0.875rem',
  fontWeight: 600,
} as const;

function SpaceItem({
  space,
  a2aConfigured,
}: {
  space: SpaceRow;
  a2aConfigured: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        border: '1px solid #f2f4f7',
        borderRadius: 8,
        padding: '0.75rem 1rem',
        background: '#fcfcfd',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: '0.25rem 1rem',
        }}
      >
        <p style={{ margin: 0, fontWeight: 600, color: '#101828', fontSize: '0.9375rem' }}>
          {space.displayName}
          {a2aConfigured && <A2aBadge />}
        </p>
      </div>
      {space.displayName !== space.agentSpaceId && (
        <p style={{ margin: '0.125rem 0 0', fontSize: '0.75rem', color: '#98a2b3' }}>
          <code>{space.agentSpaceId}</code>
        </p>
      )}
      <SpaceCountList entries={spaceCountEntries(space.counts)} />

      {/* Configured capabilities: counts only (no per-configuration detail) —
          telemetry, pipelines, communications, MCP servers, remote agents,
          webhooks — plus log-delivery endpoints and users with access. */}
      <p
        style={{
          margin: '0.875rem 0 0',
          fontSize: '0.6875rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          color: '#98a2b3',
        }}
      >
        Configured capabilities
      </p>
      <SpaceCountList entries={spaceCapabilityEntries(space.counts)} />

    </div>
  );
}

function SpaceCountList({
  entries,
}: {
  entries: ReturnType<typeof spaceCountEntries>;
}): JSX.Element {
  return (
    <dl
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '0.75rem 1.5rem',
        margin: '0.625rem 0 0',
      }}
    >
      {entries.map((entry) => (
        <div key={entry.key}>
          <dt
            style={{
              margin: 0,
              fontSize: '0.6875rem',
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.02em',
              color: '#667085',
            }}
          >
            {entry.label}
          </dt>
          {/* null = unknown (not collected): shown as "—" with an explanatory
              tooltip, never as a false 0 (data stays aligned with the backend). */}
          <dd
            style={{ margin: '0.125rem 0 0', fontSize: '1rem', color: '#101828' }}
            {...(entry.value === null ? { title: UNKNOWN_METRIC_HINT } : {})}
          >
            {formatNullableMetric(entry.value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * "Pending refresh" pill shown on an account with an in-flight space creation.
 * Creation is asynchronous, so the space only appears after the next data
 * refresh; this marks the status meanwhile (Requirement: mark "Pending refresh",
 * do not refresh on every creation).
 */
function PendingRefreshBadge(): JSX.Element {
  return (
    <span
      title="A space creation was requested for this account. It will appear after the next data refresh."
      style={{
        display: 'inline-block',
        marginRight: '0.5rem',
        padding: '0.1875rem 0.625rem',
        borderRadius: 999,
        fontSize: '0.75rem',
        fontWeight: 600,
        color: '#175cd3',
        background: '#eff4ff',
        border: '1px solid #b2ccff',
      }}
    >
      Pending refresh
    </span>
  );
}

function StatusBadge({ status }: { status: AccountSpaces['status'] }): JSX.Element {
  const collected = status === 'collected';
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '0.1875rem 0.625rem',
        borderRadius: 999,
        fontSize: '0.75rem',
        fontWeight: 600,
        color: collected ? '#067647' : '#b54708',
        background: collected ? '#ecfdf3' : '#fffaeb',
        border: `1px solid ${collected ? '#abefc6' : '#fedf89'}`,
      }}
    >
      {statusLabel(status)}
    </span>
  );
}

/**
 * Small "A2A" pill shown next to a space name when the space has an A2A access
 * token configured (via Settings). It signals the space can be chatted with
 * live from the Chat view; it does NOT expose any token value.
 */
function A2aBadge(): JSX.Element {
  return (
    <span
      title="Agent-to-Agent enabled — this space can be chatted with live from the Chat view."
      style={{
        display: 'inline-block',
        marginLeft: '0.5rem',
        padding: '0.0625rem 0.375rem',
        borderRadius: 999,
        fontSize: '0.625rem',
        fontWeight: 700,
        letterSpacing: '0.02em',
        color: '#3538cd',
        background: '#eef4ff',
        border: '1px solid #c7d7fe',
        verticalAlign: 'middle',
      }}
    >
      A2A
    </span>
  );
}
