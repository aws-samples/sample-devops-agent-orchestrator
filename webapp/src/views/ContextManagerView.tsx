import { useEffect, useMemo, useRef, useState } from 'react';
import type { BusinessContext, SpacesDTO } from '@devops-observatory/shared-types';
import { fetchContext, saveContext } from '../api/context';
import { fetchSpaces } from '../api/spaces';
import { ApiRequestError } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { AdminOnly } from '../auth/AdminOnly';
import { Pager } from '../components/Pager';
import { paginate } from '../lib/pagination';
import {
  ACCOUNT_CONTEXT_MAX_LENGTH,
  accountsForBusinessUnit,
  accountsForDisplayNameEditor,
  addBusinessUnit,
  applyCsvToDraft,
  assignAccountToBusinessUnit,
  availableAccounts,
  buildDraft,
  businessUnitNameForAccount,
  configuredAccountIds,
  draftToContext,
  draftToCsv,
  filterAccounts,
  isDraftValid,
  issuesForAccount,
  issuesForBusinessUnit,
  knownAccountIds,
  METADATA_MAX_LENGTH,
  ORG_SYSTEM_PROMPT_MAX_LENGTH,
  removeBusinessUnit,
  setAccountContext,
  setAccountDisplayName,
  setOrgSystemPrompt,
  unassignAccount,
  updateBusinessUnitField,
  validateDraft,
  type AccountOption,
  type ContextDraft,
  type CsvImportError,
  type DraftBusinessUnit,
  type DraftIssue,
} from '../lib/contextManagerView';

/** Accounts shown per page in the Context_Manager account table (Req 5.12). */
const ACCOUNTS_PAGE_SIZE = 25;

/**
 * Admin-only Context_Manager (Task 16 — Requirements 2.3, 5.1, 5.2, 5.6, 5.7).
 *
 * Lets an Admin create/edit/remove Business_Unit groupings (each mapping one or
 * more Linked_Accounts to exactly one BU, name 1–128 chars), assign per-account
 * display names (1–128) and descriptive metadata (the BU description, ≤1024),
 * and save via the Admin-only `PUT /context` API. Validation errors are shown
 * inline before the round-trip, including rejecting an account absent from the
 * manifest and naming it (Requirement 5.7). On a save failure the Admin's
 * unsaved edits are retained and the previously persisted context is unchanged
 * (Requirement 5.4). After saving, navigating to the Space_View, Dashboard, or
 * Graph_View reloads them so updated groupings/labels appear (Requirement 5.6).
 *
 * The whole view is wrapped in {@link AdminOnly}: an Executive who somehow
 * reaches it sees an access-denied notice and no editing UI, and the backend
 * independently rejects any non-Admin `PUT /context` (Requirement 2.3).
 */
export function ContextManagerView(): JSX.Element {
  const { user } = useAuth();
  return (
    <AdminOnly role={user?.role} feature="Context Manager">
      <ContextManager />
    </AdminOnly>
  );
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; accounts: AccountOption[]; known: Set<string> }
  | { status: 'error'; message: string };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved'; at: string }
  | { status: 'error'; message: string };

function ContextManager(): JSX.Element {
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [draft, setDraft] = useState<ContextDraft | null>(null);
  const [save, setSave] = useState<SaveState>({ status: 'idle' });
  // Only surface field-level issues once the Admin has attempted a save, so the
  // form is not noisy on first render.
  const [showIssues, setShowIssues] = useState(false);
  // Feedback from the most recent CSV import (applied count + row problems).
  const [importFeedback, setImportFeedback] = useState<{
    applied: number;
    errors: CsvImportError[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    setLoad({ status: 'loading' });
    Promise.all([fetchContext(), fetchSpaces()])
      .then(([context, spaces]: [BusinessContext, SpacesDTO]) => {
        if (!active) return;
        setDraft(buildDraft(context));
        setLoad({
          status: 'ready',
          accounts: availableAccounts(spaces),
          known: knownAccountIds(spaces),
        });
      })
      .catch((err: unknown) => {
        if (!active) return;
        const message =
          err instanceof ApiRequestError
            ? err.message
            : 'Unable to load business context right now. Please try again.';
        setLoad({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, []);

  const known = load.status === 'ready' ? load.known : new Set<string>();
  const issues = useMemo(
    () => (draft ? validateDraft(draft, known) : []),
    [draft, known],
  );

  // Any edit invalidates a prior "saved" confirmation and clears save errors.
  function mutate(next: ContextDraft): void {
    setDraft(next);
    setSave({ status: 'idle' });
  }

  /** Download the current draft as an editable CSV (client-side, no API call). */
  function handleDownloadCsv(): void {
    if (!draft || load.status !== 'ready') return;
    const csv = draftToCsv(draft, load.accounts);
    // Prepend a UTF-8 BOM so Excel opens non-ASCII context correctly.
    const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'account-context.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** Parse an uploaded CSV into the draft for review; the admin then Saves. */
  async function handleUploadCsv(file: File): Promise<void> {
    if (!draft || load.status !== 'ready') return;
    let text: string;
    try {
      text = await file.text();
    } catch {
      setImportFeedback({ applied: 0, errors: [{ line: 0, message: 'The file could not be read.' }] });
      return;
    }
    const result = applyCsvToDraft(draft, text, load.known);
    setDraft(result.draft);
    setSave({ status: 'idle' });
    // Surface any field-level validation (e.g. too-long values) from the import.
    setShowIssues(true);
    setImportFeedback({ applied: result.applied, errors: result.errors });
  }

  async function handleSave(): Promise<void> {
    if (!draft || load.status !== 'ready') return;
    setShowIssues(true);
    if (!isDraftValid(draft, load.known)) {
      // Block the round-trip; inline errors are now shown (Req 5.1, 5.2, 5.7).
      setSave({
        status: 'error',
        message: 'Please fix the highlighted validation errors before saving.',
      });
      return;
    }
    setSave({ status: 'saving' });
    try {
      const result = await saveContext(draftToContext(draft));
      // Rebase the draft on the persisted context so the confirmation reflects
      // exactly what was stored (Requirement 5.3).
      setDraft(buildDraft(result.context));
      setShowIssues(false);
      setSave({ status: 'saved', at: result.context.updatedAt });
    } catch (err: unknown) {
      // Save failure: retain the Admin's unsaved edits (do NOT touch `draft`)
      // and surface an error; prior persisted context is unchanged (Req 5.4).
      const message =
        err instanceof ApiRequestError
          ? err.message
          : 'The context could not be saved. Your changes were kept; the previously saved context is unchanged.';
      setSave({ status: 'error', message });
    }
  }

  return (
    <section aria-labelledby="context-heading">
      <h2 id="context-heading" style={{ marginTop: 0 }}>
        Context Manager
      </h2>
      <p style={{ color: '#475467', marginTop: '-0.25rem' }}>
        Group linked accounts into business units and assign human-friendly display names. Changes
        appear in the Space, Dashboard, and Graph views after the next data load.
      </p>

      {load.status === 'loading' && (
        <p role="status" aria-live="polite" style={{ color: '#475467' }}>
          Loading business context…
        </p>
      )}

      {load.status === 'error' && (
        <p role="alert" style={errorBannerStyle}>
          {load.message}
        </p>
      )}

      {load.status === 'ready' && draft && (
        <>
          <SaveBanner save={save} />

          <BulkCsvToolbar
            onDownload={handleDownloadCsv}
            onPickFile={() => fileInputRef.current?.click()}
            feedback={importFeedback}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleUploadCsv(file);
              // Reset so re-selecting the same file re-triggers onChange.
              e.target.value = '';
            }}
          />

          <BusinessUnitsSection
            draft={draft}
            accounts={load.accounts}
            issues={showIssues ? issues : []}
            onChange={mutate}
          />

          <DisplayNamesSection
            draft={draft}
            accounts={load.accounts}
            issues={showIssues ? issues : []}
            onChange={mutate}
          />

          <OrgSystemPromptSection
            draft={draft}
            issues={showIssues ? issues : []}
            onChange={mutate}
          />

          <div style={{ marginTop: '2rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={save.status === 'saving'}
              style={primaryButtonStyle(save.status === 'saving')}
            >
              {save.status === 'saving' ? 'Saving…' : 'Save context'}
            </button>
            {showIssues && issues.length > 0 && (
              <span role="status" style={{ color: '#b42318', fontSize: '0.875rem' }}>
                {issues.length} validation {issues.length === 1 ? 'error' : 'errors'} to fix.
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function SaveBanner({ save }: { save: SaveState }): JSX.Element | null {
  if (save.status === 'saved') {
    return (
      <p role="status" style={successBannerStyle}>
        Business context saved. It is now available across sessions and to backend processing.
      </p>
    );
  }
  if (save.status === 'error') {
    return (
      <p role="alert" style={errorBannerStyle}>
        {save.message}
      </p>
    );
  }
  return null;
}

function BulkCsvToolbar({
  onDownload,
  onPickFile,
  feedback,
}: {
  onDownload: () => void;
  onPickFile: () => void;
  feedback: { applied: number; errors: CsvImportError[] } | null;
}): JSX.Element {
  return (
    <div style={{ margin: '1.25rem 0 0' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.875rem 1rem',
          border: '1px solid #eaecf0',
          borderRadius: 12,
          background: '#fcfcfd',
        }}
      >
        <div style={{ flex: 1, minWidth: 220 }}>
          <p style={{ margin: 0, fontWeight: 600, fontSize: '0.9375rem' }}>Bulk edit (CSV)</p>
          <p style={{ margin: '0.125rem 0 0', color: '#667085', fontSize: '0.8125rem' }}>
            Download every account's display name, business unit, and context as a spreadsheet, edit
            offline, then upload to load your changes for review before saving.
          </p>
        </div>
        <button type="button" onClick={onDownload} style={secondaryButtonStyle}>
          Download CSV
        </button>
        <button type="button" onClick={onPickFile} style={secondaryButtonStyle}>
          Upload CSV
        </button>
      </div>
      {feedback && (
        <div
          role="status"
          style={{
            marginTop: '0.5rem',
            padding: '0.75rem 1rem',
            borderRadius: 8,
            border: `1px solid ${feedback.errors.length > 0 ? '#fec84b' : '#a6f4c5'}`,
            background: feedback.errors.length > 0 ? '#fffaeb' : '#ecfdf3',
            color: '#344054',
            fontSize: '0.875rem',
          }}
        >
          <p style={{ margin: 0 }}>
            Imported changes for <strong>{feedback.applied}</strong>{' '}
            {feedback.applied === 1 ? 'account' : 'accounts'}. Review below and click{' '}
            <strong>Save context</strong> to persist.
            {feedback.errors.length > 0 && (
              <>
                {' '}
                <strong>{feedback.errors.length}</strong>{' '}
                {feedback.errors.length === 1 ? 'row was' : 'rows were'} skipped or need attention:
              </>
            )}
          </p>
          {feedback.errors.length > 0 && (
            <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
              {feedback.errors.slice(0, 20).map((err, i) => (
                <li key={`${err.line}-${i}`} style={{ fontSize: '0.8125rem' }}>
                  Line {err.line}
                  {err.account ? ` (account ${err.account})` : ''}: {err.message}
                </li>
              ))}
              {feedback.errors.length > 20 && (
                <li style={{ fontSize: '0.8125rem' }}>
                  …and {feedback.errors.length - 20} more.
                </li>
              )}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function BusinessUnitsSection({
  draft,
  accounts,
  issues,
  onChange,
}: {
  draft: ContextDraft;
  accounts: AccountOption[];
  issues: DraftIssue[];
  onChange: (next: ContextDraft) => void;
}): JSX.Element {
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={subheadingStyle}>Business units</h3>
        <button
          type="button"
          onClick={() => onChange(addBusinessUnit(draft))}
          style={secondaryButtonStyle}
        >
          + Add business unit
        </button>
      </div>

      {draft.businessUnits.length === 0 ? (
        <p style={emptyHintStyle}>
          No business units defined. Add one to group accounts; accounts left ungrouped appear under
          “Unassigned” in the dashboard.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '1rem' }}>
          {draft.businessUnits.map((bu) => (
            <li key={bu.id}>
              <BusinessUnitCard
                bu={bu}
                accounts={accounts}
                issues={issuesForBusinessUnit(issues, bu.id)}
                onChange={onChange}
                draft={draft}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function BusinessUnitCard({
  bu,
  accounts,
  issues,
  draft,
  onChange,
}: {
  bu: DraftBusinessUnit;
  accounts: AccountOption[];
  issues: DraftIssue[];
  draft: ContextDraft;
  onChange: (next: ContextDraft) => void;
}): JSX.Element {
  return (
    <div style={cardStyle}>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <label style={fieldLabelStyle} htmlFor={`${bu.id}-name`}>
            Business unit name
          </label>
          <input
            id={`${bu.id}-name`}
            type="text"
            value={bu.name}
            maxLength={128}
            placeholder="e.g. Payments Platform"
            onChange={(e) => onChange(updateBusinessUnitField(draft, bu.id, 'name', e.target.value))}
            style={inputStyle}
          />
        </div>
        <button
          type="button"
          aria-label={`Remove business unit ${bu.name || '(unnamed)'}`}
          onClick={() => onChange(removeBusinessUnit(draft, bu.id))}
          style={dangerButtonStyle}
        >
          Remove
        </button>
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <label style={fieldLabelStyle} htmlFor={`${bu.id}-desc`}>
          Descriptive metadata (optional, ≤{METADATA_MAX_LENGTH} characters)
        </label>
        <textarea
          id={`${bu.id}-desc`}
          value={bu.description}
          rows={2}
          onChange={(e) =>
            onChange(updateBusinessUnitField(draft, bu.id, 'description', e.target.value))
          }
          style={{ ...inputStyle, resize: 'vertical' }}
        />
        <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#98a2b3' }}>
          {bu.description.length}/{METADATA_MAX_LENGTH}
        </p>
      </div>

      <div style={{ marginTop: '0.75rem' }}>
        <span style={fieldLabelStyle}>Accounts in this unit</span>
        <AccountSelector bu={bu} accounts={accounts} draft={draft} onChange={onChange} />
      </div>

      <IssueList issues={issues} />
    </div>
  );
}

/**
 * Searchable, bounded account selector for a Business_Unit. Built for orgs with
 * thousands of linked accounts: it renders the accounts already assigned to the
 * unit as removable chips, and a search box that filters candidates by account
 * id OR display name, showing only the top {@link ACCOUNT_RESULT_LIMIT} matches
 * (with a "showing N of M" note) so the DOM never holds thousands of rows.
 * Typing a full account id surfaces it first (exact-id fast path).
 */
function AccountSelector({
  bu,
  accounts,
  draft,
  onChange,
}: {
  bu: DraftBusinessUnit;
  accounts: AccountOption[];
  draft: ContextDraft;
  onChange: (next: ContextDraft) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const assigned = new Set(bu.accounts);
  const selected = accountsForBusinessUnit(draft, bu.id, accounts);
  const { matches, total, truncated } = filterAccounts(accounts, query);

  return (
    <div>
      {/* Selected accounts as removable chips (independent of the search page). */}
      {selected.length === 0 ? (
        <p style={{ margin: '0.25rem 0 0.5rem', color: '#98a2b3', fontSize: '0.8125rem' }}>
          No accounts assigned yet. Search below to add some.
        </p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', margin: '0.25rem 0 0.625rem' }}>
          {selected.map((account) => (
            <span key={account.account} style={chipStyle}>
              <span>
                {account.manifestLabel}
                {account.manifestLabel !== account.account && (
                  <span style={{ color: '#98a2b3' }}> ({account.account})</span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Remove account ${account.account} from ${bu.name || 'this unit'}`}
                onClick={() => onChange(unassignAccount(draft, bu.id, account.account))}
                style={chipRemoveStyle}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        type="search"
        value={query}
        placeholder="Search accounts by id or name…"
        aria-label={`Search accounts to add to ${bu.name || 'this business unit'}`}
        onChange={(e) => setQuery(e.target.value)}
        style={inputStyle}
      />

      <div style={candidateListStyle}>
        {matches.length === 0 ? (
          <p style={{ margin: 0, padding: '0.5rem 0.25rem', color: '#98a2b3', fontSize: '0.8125rem' }}>
            No accounts match “{query}”.
          </p>
        ) : (
          matches.map((account) => {
            const checked = assigned.has(account.account);
            return (
              <label
                key={account.account}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.25rem 0.25rem',
                  fontSize: '0.875rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() =>
                    onChange(
                      checked
                        ? unassignAccount(draft, bu.id, account.account)
                        : assignAccountToBusinessUnit(draft, bu.id, account.account),
                    )
                  }
                />
                <span>
                  {account.manifestLabel}
                  {account.manifestLabel !== account.account && (
                    <span style={{ color: '#98a2b3' }}> ({account.account})</span>
                  )}
                </span>
              </label>
            );
          })
        )}
      </div>
      {truncated && (
        <p style={resultCountStyle}>
          Showing {matches.length} of {total} matching accounts. Refine your search to narrow the
          list.
        </p>
      )}
    </div>
  );
}

function DisplayNamesSection({
  draft,
  accounts,
  issues,
  onChange,
}: {
  draft: ContextDraft;
  accounts: AccountOption[];
  issues: DraftIssue[];
  onChange: (next: ContextDraft) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  // Snapshot which accounts are "configured" for STABLE ordering. Captured when
  // the loaded account set changes (a fresh /spaces load or a post-save reload),
  // NOT on every keystroke — so typing into an account's display name or context
  // never reorders the rows mid-edit. `draftRef` reads the current draft at
  // snapshot time without making the memo depend on live edits.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const pinnedIds = useMemo(() => configuredAccountIds(draftRef.current), [accounts]);
  const matched = useMemo(
    () => accountsForDisplayNameEditor(accounts, query, pinnedIds),
    [accounts, query, pinnedIds],
  );
  const pageData = paginate(matched, page, ACCOUNTS_PAGE_SIZE);

  return (
    <div style={{ marginTop: '2rem' }}>
      <h3 style={subheadingStyle}>Account details &amp; context</h3>
      <p style={{ margin: '0 0 0.75rem', color: '#667085', fontSize: '0.875rem' }}>
        For each account, set a friendly display name (1–128 characters) shown instead of the raw
        account id, see which business unit it belongs to, and add free-text context (up to{' '}
        {ACCOUNT_CONTEXT_MAX_LENGTH} characters — purpose, owning team, environment, notes) that
        enriches the knowledge base and chat answers. Accounts that already have a name or context
        are listed first; search to find others by id or name, and page through the rest.
      </p>
      {accounts.length === 0 ? (
        <p style={emptyHintStyle}>No linked accounts were found in the collected data manifest.</p>
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
              placeholder="Search accounts by id or name…"
              aria-label="Search accounts to configure"
              onChange={(e) => {
                setQuery(e.target.value);
                setPage(1);
              }}
              style={{ ...inputStyle, maxWidth: 420 }}
            />
            <span style={{ color: '#667085', fontSize: '0.8125rem' }}>
              {matched.length} of {accounts.length} accounts
            </span>
          </div>
          {matched.length === 0 ? (
            <p style={emptyHintStyle}>No accounts match “{query}”.</p>
          ) : (
            <>
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th scope="col" style={thStyle}>
                        Account
                      </th>
                      <th scope="col" style={thStyle}>
                        Display name
                      </th>
                      <th scope="col" style={thStyle}>
                        Business unit
                      </th>
                      <th scope="col" style={thStyle}>
                        Context
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageData.items.map((account) => {
                      const accountIssues = issuesForAccount(issues, account.account);
                      const businessUnit = businessUnitNameForAccount(draft, account.account);
                      const contextValue = draft.accountContext[account.account] ?? '';
                      return (
                        <tr key={account.account}>
                          <th scope="row" style={rowHeaderStyle}>
                            {account.account}
                            {account.orgName && (
                              <span
                                style={{
                                  display: 'block',
                                  fontWeight: 400,
                                  fontSize: '0.75rem',
                                  color: '#667085',
                                }}
                              >
                                {account.orgName}
                              </span>
                            )}
                          </th>
                          <td style={tdStyle}>
                            <input
                              type="text"
                              aria-label={`Display name for account ${account.account}`}
                              value={draft.accountDisplayNames[account.account] ?? ''}
                              maxLength={128}
                              placeholder={account.orgName || account.manifestLabel}
                              onChange={(e) =>
                                onChange(setAccountDisplayName(draft, account.account, e.target.value))
                              }
                              style={{ ...inputStyle, maxWidth: 240 }}
                            />
                          </td>
                          <td style={tdStyle}>
                            {businessUnit ? (
                              <span style={buChipStyle}>{businessUnit}</span>
                            ) : (
                              <span style={{ color: '#98a2b3', fontSize: '0.8125rem' }}>
                                Unassigned
                              </span>
                            )}
                          </td>
                          <td style={tdStyle}>
                            <textarea
                              aria-label={`Context for account ${account.account}`}
                              value={contextValue}
                              rows={2}
                              maxLength={ACCOUNT_CONTEXT_MAX_LENGTH}
                              placeholder="e.g. Prod payments workloads, owned by the Payments team"
                              onChange={(e) =>
                                onChange(setAccountContext(draft, account.account, e.target.value))
                              }
                              style={{ ...inputStyle, minWidth: 240, resize: 'vertical' }}
                            />
                            <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#98a2b3' }}>
                              {contextValue.length}/{ACCOUNT_CONTEXT_MAX_LENGTH}
                            </p>
                            <IssueList issues={accountIssues} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pager page={pageData} onPageChange={setPage} unit="accounts" />
            </>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Org-wide chat system prompt editor (Requirement 5.16). The admin authors the
 * executive persona/tone/scope for the org-wide chat. The built-in governed
 * safety/grounding layer is always applied on top and cannot be removed here;
 * when left blank, a built-in default executive guidance is used.
 */
function OrgSystemPromptSection({
  draft,
  issues,
  onChange,
}: {
  draft: ContextDraft;
  issues: DraftIssue[];
  onChange: (next: ContextDraft) => void;
}): JSX.Element {
  const promptIssues = issues.filter((i) => i.ref === 'orgSystemPrompt');
  const value = draft.orgSystemPrompt;
  return (
    <div style={{ marginTop: '2rem' }}>
      <h3 style={subheadingStyle}>Org-wide chat guidance</h3>
      <p style={{ margin: '0 0 0.75rem', color: '#667085', fontSize: '0.875rem' }}>
        Guidance applied to the organization-wide chat — set the persona, tone, and scope for
        executive answers (up to {ORG_SYSTEM_PROMPT_MAX_LENGTH} characters). A built-in safety and
        grounding layer is always applied on top of this and cannot be removed. Leave blank to use
        the default executive guidance.
      </p>
      <label style={fieldLabelStyle} htmlFor="org-system-prompt">
        System prompt
      </label>
      <textarea
        id="org-system-prompt"
        value={value}
        rows={6}
        maxLength={ORG_SYSTEM_PROMPT_MAX_LENGTH}
        placeholder="e.g. You advise the VP of Platform Engineering. Lead with business impact and risk across business units; keep technical detail brief unless asked."
        onChange={(e) => onChange(setOrgSystemPrompt(draft, e.target.value))}
        style={{ ...inputStyle, resize: 'vertical' }}
      />
      <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#98a2b3' }}>
        {value.length}/{ORG_SYSTEM_PROMPT_MAX_LENGTH}
      </p>
      <IssueList issues={promptIssues} />
    </div>
  );
}

function IssueList({ issues }: { issues: DraftIssue[] }): JSX.Element | null {
  if (issues.length === 0) return null;
  return (
    <ul style={{ margin: '0.5rem 0 0', padding: '0 0 0 1.25rem', color: '#b42318' }}>
      {issues.map((issue, i) => (
        <li key={`${issue.ref}-${i}`} style={{ fontSize: '0.8125rem' }}>
          {issue.message}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Inline styles (consistent with the other views)
// ---------------------------------------------------------------------------

const subheadingStyle = { margin: '0 0 0.75rem', fontSize: '1rem', color: '#101828' } as const;

const cardStyle = {
  border: '1px solid #eaecf0',
  borderRadius: 12,
  padding: '1.25rem',
  background: '#fff',
  boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
} as const;

const fieldLabelStyle = {
  display: 'block',
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.02em',
  color: '#667085',
  marginBottom: '0.25rem',
} as const;

const inputStyle = {
  width: '100%',
  padding: '0.5rem 0.75rem',
  borderRadius: 6,
  border: '1px solid #d0d5dd',
  fontSize: '0.9375rem',
  boxSizing: 'border-box',
  fontFamily: 'inherit',
} as const;

const tableWrapStyle = {
  border: '1px solid #eaecf0',
  borderRadius: 12,
  background: '#fff',
  boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
  overflowX: 'auto',
} as const;

const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: '0.9375rem' } as const;

const thStyle = {
  textAlign: 'left',
  padding: '0.625rem 1rem',
  borderBottom: '1px solid #eaecf0',
  fontSize: '0.75rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.02em',
  color: '#667085',
} as const;

const rowHeaderStyle = {
  textAlign: 'left',
  padding: '0.625rem 1rem',
  borderBottom: '1px solid #f2f4f7',
  fontWeight: 600,
  color: '#101828',
  fontVariantNumeric: 'tabular-nums',
} as const;

const tdStyle = {
  textAlign: 'left',
  padding: '0.625rem 1rem',
  borderBottom: '1px solid #f2f4f7',
  color: '#344054',
} as const;

const emptyHintStyle = {
  margin: '0.5rem 0 0',
  padding: '0.875rem 1rem',
  border: '1px dashed #d0d5dd',
  borderRadius: 8,
  color: '#667085',
  background: '#fcfcfd',
  fontSize: '0.9375rem',
} as const;

const chipStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '0.375rem',
  padding: '0.25rem 0.5rem',
  borderRadius: 16,
  background: '#eff4ff',
  border: '1px solid #b2ccff',
  color: '#175cd3',
  fontSize: '0.8125rem',
} as const;

const buChipStyle = {
  display: 'inline-block',
  padding: '0.125rem 0.5rem',
  borderRadius: 12,
  background: '#f4f3ff',
  border: '1px solid #d9d6fe',
  color: '#5925dc',
  fontSize: '0.8125rem',
  whiteSpace: 'nowrap',
} as const;

const chipRemoveStyle = {
  border: 'none',
  background: 'transparent',
  color: '#175cd3',
  cursor: 'pointer',
  fontSize: '1rem',
  lineHeight: 1,
  padding: 0,
} as const;

const candidateListStyle = {
  marginTop: '0.5rem',
  maxHeight: 220,
  overflowY: 'auto',
  border: '1px solid #eaecf0',
  borderRadius: 8,
  padding: '0.25rem 0.5rem',
  background: '#fcfcfd',
} as const;

const resultCountStyle = {
  margin: '0.375rem 0 0',
  fontSize: '0.75rem',
  color: '#98a2b3',
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

function primaryButtonStyle(disabled: boolean) {
  return {
    padding: '0.5rem 1rem',
    borderRadius: 6,
    border: 'none',
    background: disabled ? '#98a2b3' : '#175cd3',
    color: '#fff',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.9375rem',
    fontWeight: 600,
  } as const;
}

const secondaryButtonStyle = {
  padding: '0.375rem 0.75rem',
  borderRadius: 6,
  border: '1px solid #d0d5dd',
  background: '#fff',
  cursor: 'pointer',
  fontSize: '0.875rem',
} as const;

const dangerButtonStyle = {
  padding: '0.375rem 0.75rem',
  borderRadius: 6,
  border: '1px solid #fecdca',
  background: '#fff',
  color: '#b42318',
  cursor: 'pointer',
  fontSize: '0.875rem',
  flexShrink: 0,
} as const;
