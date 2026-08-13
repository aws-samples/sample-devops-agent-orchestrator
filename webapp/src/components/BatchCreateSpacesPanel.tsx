import { useEffect, useMemo, useState } from 'react';
import type { AccountSpaces, SpacesDTO } from '@devops-observatory/shared-types';
import { batchCreateSpaces, fetchSpaces } from '../api/spaces';
import { ApiRequestError } from '../api/client';
import { resolveErrorMessage } from '../lib/viewState';
import { LoadingMessage, ErrorMessage, EmptyMessage } from './StateMessage';
import { Pager } from './Pager';
import { paginate } from '../lib/pagination';
import {
  getPendingSpaceAccounts,
  markSpacesPending,
  reconcilePendingSpaces,
} from '../lib/pendingSpaces';
import {
  accountIdentity,
  accountMatchesQuery,
  accountsWithoutSpaces,
  accountsWithSpaceIds,
} from '../lib/spacesView';

/** Accounts shown per page in the batch table. */
const PAGE_SIZE = 25;

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; accounts: AccountSpaces[] }
  | { status: 'error'; message: string };

/**
 * Admin-only batch agent-space creation (Refresh section).
 *
 * Lists the linked accounts that have NO agent space, with per-row checkboxes
 * and a select-all control, and creates a starter space in every selected
 * account in one action (`POST /spaces/batch`). Creation is asynchronous and
 * can target hundreds of accounts, so the panel does not re-fetch: it marks the
 * selected accounts "Pending refresh" (they appear after the next data refresh).
 * The backend independently authorizes the batch route, so this is UX only.
 */
export function BatchCreateSpacesPanel(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [pending, setPending] = useState<Set<string>>(() => getPendingSpaceAccounts());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetchSpaces()
      .then((spaces: SpacesDTO) => {
        if (!active) return;
        setState({ status: 'ready', accounts: accountsWithoutSpaces(spaces.accounts) });
        setPending(reconcilePendingSpaces(accountsWithSpaceIds(spaces.accounts)));
      })
      .catch((err: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          message: resolveErrorMessage(err, 'Unable to load accounts right now. Please try again.'),
        });
      });
    return () => {
      active = false;
    };
  }, []);

  // Candidates: accounts without spaces, minus those already pending a create.
  const candidates = useMemo(() => {
    if (state.status !== 'ready') return [];
    return state.accounts.filter((a) => !pending.has(a.account));
  }, [state, pending]);

  const filtered = useMemo(
    () => candidates.filter((a) => accountMatchesQuery(a, query)),
    [candidates, query],
  );
  const pageData = paginate(filtered, page, PAGE_SIZE);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((a) => selected.has(a.account));

  const toggleOne = (accountId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) next.delete(accountId);
      else next.add(accountId);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filtered.forEach((a) => next.delete(a.account));
      } else {
        filtered.forEach((a) => next.add(a.account));
      }
      return next;
    });
  };

  const submit = async (): Promise<void> => {
    const accountIds = [...selected];
    if (accountIds.length === 0) return;
    setSubmitting(true);
    setError(null);
    setNote(null);
    try {
      const res = await batchCreateSpaces({ accountIds });
      markSpacesPending(res.accountIds);
      setPending((prev) => {
        const next = new Set(prev);
        res.accountIds.forEach((id) => next.add(id));
        return next;
      });
      setSelected(new Set());
      setNote(
        `Requested ${res.accepted} agent space${res.accepted === 1 ? '' : 's'}. ` +
          'They will appear after the next data refresh.',
      );
    } catch (err: unknown) {
      setError(
        err instanceof ApiRequestError
          ? err.message
          : 'The spaces could not be requested. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section aria-labelledby="batch-spaces-heading" style={{ marginTop: '2.5rem' }}>
      <h3 id="batch-spaces-heading" style={{ marginBottom: '0.25rem' }}>
        Create agent spaces
      </h3>
      <p style={{ color: '#475467', marginTop: 0 }}>
        Accounts with no agent space. Select accounts and create a starter space in each — you can
        create hundreds at once. Creation runs in the background; the new spaces appear after the
        next data refresh.
      </p>

      {state.status === 'loading' && <LoadingMessage>Loading accounts…</LoadingMessage>}
      {state.status === 'error' && <ErrorMessage>{state.message}</ErrorMessage>}

      {state.status === 'ready' && (
        <>
          {note && (
            <p
              role="status"
              style={{
                padding: '0.75rem 1rem',
                borderRadius: 8,
                border: '1px solid #a6f4c5',
                background: '#ecfdf3',
                color: '#027a48',
                fontSize: '0.9375rem',
              }}
            >
              {note}
            </p>
          )}
          {error && (
            <p
              role="alert"
              style={{
                padding: '0.75rem 1rem',
                borderRadius: 8,
                border: '1px solid #fecdca',
                background: '#fef3f2',
                color: '#b42318',
                fontSize: '0.9375rem',
              }}
            >
              {error}
            </p>
          )}

          {candidates.length === 0 ? (
            <EmptyMessage>
              Every collected account already has an agent space (or has a pending creation).
            </EmptyMessage>
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '0.75rem',
                  alignItems: 'center',
                  marginBottom: '0.75rem',
                }}
              >
                <input
                  type="search"
                  value={query}
                  placeholder="Search accounts by id, name, or business unit…"
                  aria-label="Search accounts without spaces"
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
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={submitting || selected.size === 0}
                  style={createButtonStyle(!submitting && selected.size > 0)}
                >
                  {submitting
                    ? 'Requesting…'
                    : `Create ${selected.size} space${selected.size === 1 ? '' : 's'}`}
                </button>
              </div>

              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9375rem' }}>
                <thead>
                  <tr style={{ textAlign: 'left', borderBottom: '1px solid #eaecf0' }}>
                    <th style={thStyle}>
                      <input
                        type="checkbox"
                        aria-label="Select all matching accounts"
                        checked={allFilteredSelected}
                        onChange={toggleAllFiltered}
                        disabled={submitting || filtered.length === 0}
                      />
                    </th>
                    <th style={thStyle}>Account</th>
                    <th style={thStyle}>Business unit</th>
                  </tr>
                </thead>
                <tbody>
                  {pageData.items.map((account) => {
                    const identity = accountIdentity(account);
                    const checked = selected.has(account.account);
                    return (
                      <tr key={account.account} style={{ borderBottom: '1px solid #f2f4f7' }}>
                        <td style={tdStyle}>
                          <input
                            type="checkbox"
                            aria-label={`Select account ${account.account}`}
                            checked={checked}
                            onChange={() => toggleOne(account.account)}
                            disabled={submitting}
                          />
                        </td>
                        <td style={tdStyle}>
                          <span style={{ fontWeight: 600, color: '#101828' }}>{identity.primary}</span>
                          {identity.secondary && (
                            <span style={{ color: '#98a2b3', marginLeft: '0.5rem' }}>
                              <code>{identity.secondary}</code>
                            </span>
                          )}
                        </td>
                        <td style={{ ...tdStyle, color: '#667085' }}>{account.businessUnit ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' }}>
                <span style={{ color: '#667085', fontSize: '0.8125rem' }}>
                  {selected.size} selected · {filtered.length} of {candidates.length} without spaces
                </span>
                <Pager page={pageData} onPageChange={setPage} unit="accounts" />
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}

const thStyle = {
  padding: '0.5rem 0.75rem',
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'uppercase' as const,
  letterSpacing: '0.02em',
  color: '#667085',
};

const tdStyle = { padding: '0.625rem 0.75rem', verticalAlign: 'top' as const };

function createButtonStyle(enabled: boolean) {
  return {
    padding: '0.5rem 1.25rem',
    borderRadius: 6,
    border: 'none',
    background: enabled ? '#175cd3' : '#98a2b3',
    color: '#fff',
    cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: '0.9375rem',
    fontWeight: 600,
  } as const;
}
