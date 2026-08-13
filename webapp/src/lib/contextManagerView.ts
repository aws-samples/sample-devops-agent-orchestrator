import {
  ORG_SYSTEM_PROMPT_MAX_LENGTH,
  type BusinessContext,
  type BusinessUnit,
  type SpacesDTO,
} from '@devops-observatory/shared-types';
import { parseCsv, stringifyCsv } from './csv';

export { ORG_SYSTEM_PROMPT_MAX_LENGTH };

/**
 * Pure, DOM-free logic for the Admin-only Context_Manager (Task 16).
 *
 * Kept separate from the React component so the editable draft model, its
 * mutations, client-side validation, and the draft→payload conversion can be
 * unit-tested with the repo's `node:test` + tsx convention and reused without
 * pulling in the view. Every function is deterministic and side-effect free.
 *
 * The rules mirror the backend validator (`amplify/functions/shared/
 * businessContextValidation.ts`) so the UI can surface problems before the
 * `PUT /context` round-trip (the server remains the authority):
 *   - Business_Unit name: non-empty, 1–128 characters (Requirement 5.1).
 *   - Each Linked_Account maps to exactly one Business_Unit (Requirement 5.1).
 *   - Account display name: 1–128 characters when set (Requirement 5.2).
 *   - Descriptive metadata (the Business_Unit `description`): ≤1024 characters
 *     (Requirement 5.2) — the schema's free-form metadata field.
 *   - Every referenced account MUST exist in the collected-data manifest; an
 *     unrecognized account is rejected with an issue naming it (Requirement 5.7).
 */

/** Inclusive bounds shared with the backend validator. */
export const BU_NAME_MIN_LENGTH = 1;
export const BU_NAME_MAX_LENGTH = 128;
export const DISPLAY_NAME_MIN_LENGTH = 1;
export const DISPLAY_NAME_MAX_LENGTH = 128;
export const METADATA_MAX_LENGTH = 1024;
/**
 * Max length of per-account free-text context (Requirement 5.2). Larger than the
 * Business_Unit description ({@link METADATA_MAX_LENGTH}) so an admin can capture
 * rich per-account context. Mirrors the backend `ACCOUNT_CONTEXT_MAX_LENGTH`.
 */
export const ACCOUNT_CONTEXT_MAX_LENGTH = 4096;

// ---------------------------------------------------------------------------
// Draft model — the editable in-memory shape the Context_Manager binds to
// ---------------------------------------------------------------------------

/** An editable Business_Unit with a stable local id for React keys/editing. */
export interface DraftBusinessUnit {
  /** Client-only stable id (not persisted). */
  id: string;
  name: string;
  /** Descriptive metadata (≤1024 chars) — persisted as the BU `description`. */
  description: string;
  /** Assigned account ids; an account belongs to exactly one BU. */
  accounts: string[];
}

/** One selectable Linked_Account, sourced from the manifest via `GET /spaces`. */
export interface AccountOption {
  /** Raw AWS account id. */
  account: string;
  /** Business-oriented label from `/spaces` (display name, else org name, else id). */
  manifestLabel: string;
  /**
   * The AWS Organizations account name captured by the collector (Requirement
   * 3.8), when present. Used as the display-name input placeholder so an Admin
   * sees the org name they are overriding.
   */
  orgName?: string;
}

/** The full editable draft the Context_Manager renders and mutates. */
export interface ContextDraft {
  version: number;
  businessUnits: DraftBusinessUnit[];
  /** Editable per-account display names (accountId → name; '' = unset). */
  accountDisplayNames: Record<string, string>;
  /** Editable per-account free-text context (accountId → text; '' = unset). */
  accountContext: Record<string, string>;
  /** Editable org-wide chat system prompt ('' = unset → built-in default). */
  orgSystemPrompt: string;
}

// ---------------------------------------------------------------------------
// Deriving available accounts (Requirement 5.7 scope)
// ---------------------------------------------------------------------------

/**
 * The set of accounts an Admin may reference, taken from the collected-data
 * manifest surfaced by `GET /spaces`. This is the authoritative account scope
 * for validation (Requirement 5.7): only these accounts may be assigned to a
 * Business_Unit or given a display name.
 */
export function availableAccounts(spaces: SpacesDTO): AccountOption[] {
  return spaces.accounts
    .map((a) => ({
      account: a.account,
      manifestLabel: a.displayName || a.account,
      ...(a.orgName ? { orgName: a.orgName } : {}),
    }))
    .sort((x, y) => x.manifestLabel.localeCompare(y.manifestLabel));
}

/** The set of known account ids (for O(1) membership checks). */
export function knownAccountIds(spaces: SpacesDTO): Set<string> {
  return new Set(spaces.accounts.map((a) => a.account));
}

// ---------------------------------------------------------------------------
// Scalable account selection (organizations with thousands of linked accounts)
// ---------------------------------------------------------------------------

/**
 * Default cap on how many account rows a searchable selector renders at once.
 * The manifest can list thousands of accounts, so the Context_Manager never
 * renders them all — it shows the top matches for the current search term and
 * reports how many more exist. This keeps the DOM small and the UI responsive
 * regardless of org size.
 */
export const ACCOUNT_RESULT_LIMIT = 50;

/** The result of a bounded account search: the visible page + total match count. */
export interface AccountSearchResult {
  /** The matching accounts to render, capped to `limit`. */
  matches: AccountOption[];
  /** Total number of accounts matching the query (before the cap). */
  total: number;
  /** True when `total` exceeds the rendered `matches` (more exist off-screen). */
  truncated: boolean;
}

/** Case-insensitive match of an account by raw id or its business label. */
export function accountMatchesQuery(option: AccountOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  return (
    option.account.toLowerCase().includes(q) ||
    option.manifestLabel.toLowerCase().includes(q) ||
    (option.orgName?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * Filter accounts by a search term (matching account id OR display label) and
 * cap the result to `limit`, reporting the total match count so the UI can show
 * "showing N of M". An exact id match is surfaced first so typing a full
 * account id always brings it to the top. Deterministic and DOM-free for unit
 * testing.
 */
export function filterAccounts(
  accounts: AccountOption[],
  query: string,
  limit: number = ACCOUNT_RESULT_LIMIT,
): AccountSearchResult {
  const q = query.trim().toLowerCase();
  const matched = accounts.filter((a) => accountMatchesQuery(a, q));
  // Surface an exact id match first; otherwise preserve the input order.
  matched.sort((x, y) => {
    const xExact = x.account.toLowerCase() === q ? 0 : 1;
    const yExact = y.account.toLowerCase() === q ? 0 : 1;
    return xExact - yExact;
  });
  const safeLimit = limit > 0 ? limit : matched.length;
  return {
    matches: matched.slice(0, safeLimit),
    total: matched.length,
    truncated: matched.length > safeLimit,
  };
}

/**
 * Resolve an account id to its {@link AccountOption}. Falls back to a
 * label-equals-id option when the id is not in the manifest, so an assigned but
 * unrecognized account still renders (and is flagged by validation, Req 5.7)
 * rather than silently disappearing.
 */
export function resolveAccountOption(
  accounts: AccountOption[],
  account: string,
): AccountOption {
  return (
    accounts.find((a) => a.account === account) ?? { account, manifestLabel: account }
  );
}

/**
 * The {@link AccountOption}s currently assigned to a Business_Unit, in the
 * draft's assignment order — used to render the selected-account chips
 * independently of the (capped, searchable) candidate list.
 */
export function accountsForBusinessUnit(
  draft: ContextDraft,
  buId: string,
  accounts: AccountOption[],
): AccountOption[] {
  const bu = draft.businessUnits.find((u) => u.id === buId);
  if (!bu) return [];
  return bu.accounts.map((id) => resolveAccountOption(accounts, id));
}

/**
 * The set of account ids that currently have a non-blank display name or
 * free-text context in the draft. Used to snapshot which accounts are
 * "configured" so the display-name editor can surface them first WITHOUT
 * re-deriving on every keystroke (which would reorder rows mid-edit).
 */
export function configuredAccountIds(draft: ContextDraft): Set<string> {
  return new Set(
    [
      ...Object.entries(draft.accountDisplayNames),
      ...Object.entries(draft.accountContext),
    ]
      .filter(([, value]) => value.trim().length > 0)
      .map(([id]) => id),
  );
}

/**
 * Accounts to show in the display-name editor for a search term: the accounts
 * in `pinnedIds` (already-configured, snapshotted by the caller) are surfaced
 * first so existing edits stay visible, then the remaining search matches, in a
 * stable order. Returns the FULL matching list (no cap) so the caller can page
 * through it with {@link paginate} rather than truncating (Requirement 5.12).
 *
 * `pinnedIds` is passed in (not derived from the live draft) so that typing into
 * an account's display name or context does NOT reorder the list mid-edit: the
 * caller snapshots the configured set once per load, keeping row order stable
 * during an editing session.
 */
export function accountsForDisplayNameEditor(
  accounts: AccountOption[],
  query: string,
  pinnedIds: Set<string>,
): AccountOption[] {
  const q = query.trim().toLowerCase();
  const matched = accounts.filter((a) => pinnedIds.has(a.account) || accountMatchesQuery(a, q));
  // Pinned (configured) accounts first; Array.prototype.sort is stable, so ties
  // preserve the input (alphabetical-by-label) order.
  matched.sort((x, y) => {
    const xC = pinnedIds.has(x.account) ? 0 : 1;
    const yC = pinnedIds.has(y.account) ? 0 : 1;
    return xC - yC;
  });
  return matched;
}

// ---------------------------------------------------------------------------
// Draft construction + conversion
// ---------------------------------------------------------------------------

let localIdCounter = 0;
/** Generate a stable client-only id for a draft Business_Unit. */
export function nextLocalId(): string {
  localIdCounter += 1;
  return `bu-${localIdCounter}`;
}

/** Build an editable draft from the persisted context (the load path). */
export function buildDraft(context: BusinessContext): ContextDraft {
  return {
    version: context.version || 1,
    businessUnits: context.businessUnits.map((bu) => ({
      id: nextLocalId(),
      name: bu.name,
      description: bu.description ?? '',
      accounts: [...bu.accounts],
    })),
    accountDisplayNames: { ...context.accountDisplayNames },
    accountContext: { ...(context.accountContext ?? {}) },
    orgSystemPrompt: context.orgSystemPrompt ?? '',
  };
}

/** An empty draft used when no context is stored yet. */
export function emptyDraft(): ContextDraft {
  return {
    version: 1,
    businessUnits: [],
    accountDisplayNames: {},
    accountContext: {},
    orgSystemPrompt: '',
  };
}

/**
 * Convert an editable draft to the {@link BusinessContext} payload for
 * `PUT /context`. Empty descriptions and blank display names are omitted so the
 * persisted object stays clean; `updatedAt` is stamped by the backend at save
 * time (Requirement 5.3), so it is left empty here.
 */
export function draftToContext(draft: ContextDraft): BusinessContext {
  const businessUnits: BusinessUnit[] = draft.businessUnits.map((bu) => {
    const trimmedDescription = bu.description.trim();
    return {
      name: bu.name.trim(),
      ...(trimmedDescription.length > 0 ? { description: trimmedDescription } : {}),
      accounts: [...bu.accounts],
    };
  });

  const accountDisplayNames: Record<string, string> = {};
  for (const [account, name] of Object.entries(draft.accountDisplayNames)) {
    const trimmed = name.trim();
    if (trimmed.length > 0) {
      accountDisplayNames[account] = trimmed;
    }
  }

  const accountContext: Record<string, string> = {};
  for (const [account, text] of Object.entries(draft.accountContext)) {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      accountContext[account] = trimmed;
    }
  }

  const orgSystemPrompt = draft.orgSystemPrompt.trim();

  return {
    version: draft.version || 1,
    updatedAt: '',
    businessUnits,
    accountDisplayNames,
    accountContext,
    ...(orgSystemPrompt.length > 0 ? { orgSystemPrompt } : {}),
  };
}

// ---------------------------------------------------------------------------
// Draft mutations (pure — each returns a new draft)
// ---------------------------------------------------------------------------

/** Add a new, empty Business_Unit to the end of the draft. */
export function addBusinessUnit(draft: ContextDraft, name = ''): ContextDraft {
  const bu: DraftBusinessUnit = { id: nextLocalId(), name, description: '', accounts: [] };
  return { ...draft, businessUnits: [...draft.businessUnits, bu] };
}

/** Remove a Business_Unit by its local id (its accounts become unassigned). */
export function removeBusinessUnit(draft: ContextDraft, id: string): ContextDraft {
  return { ...draft, businessUnits: draft.businessUnits.filter((bu) => bu.id !== id) };
}

/** Update a single field of a Business_Unit by local id. */
export function updateBusinessUnitField(
  draft: ContextDraft,
  id: string,
  field: 'name' | 'description',
  value: string,
): ContextDraft {
  return {
    ...draft,
    businessUnits: draft.businessUnits.map((bu) =>
      bu.id === id ? { ...bu, [field]: value } : bu,
    ),
  };
}

/**
 * Assign an account to a Business_Unit, enforcing the "exactly one
 * Business_Unit" rule (Requirement 5.1): the account is added to the target BU
 * and removed from every other BU. No-op if the target id is unknown.
 */
export function assignAccountToBusinessUnit(
  draft: ContextDraft,
  buId: string,
  account: string,
): ContextDraft {
  if (!draft.businessUnits.some((bu) => bu.id === buId)) {
    return draft;
  }
  return {
    ...draft,
    businessUnits: draft.businessUnits.map((bu) => {
      if (bu.id === buId) {
        return bu.accounts.includes(account)
          ? bu
          : { ...bu, accounts: [...bu.accounts, account] };
      }
      // Remove from any other BU so each account maps to exactly one BU.
      return bu.accounts.includes(account)
        ? { ...bu, accounts: bu.accounts.filter((a) => a !== account) }
        : bu;
    }),
  };
}

/** Remove an account from a specific Business_Unit (make it unassigned). */
export function unassignAccount(draft: ContextDraft, buId: string, account: string): ContextDraft {
  return {
    ...draft,
    businessUnits: draft.businessUnits.map((bu) =>
      bu.id === buId ? { ...bu, accounts: bu.accounts.filter((a) => a !== account) } : bu,
    ),
  };
}

/** Set (or clear, when blank) an account's display name. */
export function setAccountDisplayName(
  draft: ContextDraft,
  account: string,
  name: string,
): ContextDraft {
  const next = { ...draft.accountDisplayNames };
  if (name.length === 0) {
    delete next[account];
  } else {
    next[account] = name;
  }
  return { ...draft, accountDisplayNames: next };
}

/** Set (or clear, when blank) an account's free-text context. */
export function setAccountContext(
  draft: ContextDraft,
  account: string,
  text: string,
): ContextDraft {
  const next = { ...draft.accountContext };
  if (text.length === 0) {
    delete next[account];
  } else {
    next[account] = text;
  }
  return { ...draft, accountContext: next };
}

/** Set the org-wide chat system prompt (blank = unset → built-in default). */
export function setOrgSystemPrompt(draft: ContextDraft, value: string): ContextDraft {
  return { ...draft, orgSystemPrompt: value };
}

/**
 * The Business_Unit name an account is assigned to in the draft, or `undefined`
 * when it is unassigned. Used to render the read-only Business_Unit column in
 * the account table (assignment itself is done in the Business Units section).
 */
export function businessUnitNameForAccount(
  draft: ContextDraft,
  account: string,
): string | undefined {
  const bu = draft.businessUnits.find((u) => u.accounts.includes(account));
  return bu?.name.trim() ? bu.name.trim() : undefined;
}

/** Remove an account from every Business_Unit (make it unassigned). */
export function clearBusinessUnitForAccount(draft: ContextDraft, account: string): ContextDraft {
  return {
    ...draft,
    businessUnits: draft.businessUnits.map((bu) =>
      bu.accounts.includes(account)
        ? { ...bu, accounts: bu.accounts.filter((a) => a !== account) }
        : bu,
    ),
  };
}

// ---------------------------------------------------------------------------
// Bulk CSV export / import (Requirement 5.11) — batch edit account context
// ---------------------------------------------------------------------------

/**
 * CSV columns for the account-context export/import. `account_id` is the stable
 * key; the other three mirror the editable columns of the account table. On
 * import, columns are matched by header name (order-independent); `account_id`
 * is required and any unrecognized extra columns are ignored.
 */
export const CONTEXT_CSV_HEADERS = ['account_id', 'display_name', 'business_unit', 'context'] as const;

/**
 * Serialize the current draft to a CSV string with one row per known account
 * (plus the header row). Values come from the draft so an export always
 * reflects unsaved edits. Accounts are ordered by their business label for a
 * readable spreadsheet.
 */
export function draftToCsv(draft: ContextDraft, accounts: AccountOption[]): string {
  const rows: string[][] = [[...CONTEXT_CSV_HEADERS]];
  for (const { account } of accounts) {
    rows.push([
      account,
      draft.accountDisplayNames[account] ?? '',
      businessUnitNameForAccount(draft, account) ?? '',
      draft.accountContext[account] ?? '',
    ]);
  }
  return stringifyCsv(rows);
}

/** A single problem encountered while importing a CSV row. */
export interface CsvImportError {
  /** 1-based line number in the uploaded file (1 = header). */
  line: number;
  /** The offending account id, when the row identified one. */
  account?: string;
  message: string;
}

/** Outcome of applying an uploaded CSV to the draft. */
export interface CsvImportResult {
  /** The new draft with all valid changes applied. */
  draft: ContextDraft;
  /** Problems found; rows/cells with problems are skipped, others still apply. */
  errors: CsvImportError[];
  /** Number of account rows that applied at least one change. */
  applied: number;
}

/** Case-insensitive, trimmed lookup of an existing Business_Unit by name. */
function findBusinessUnitByName(draft: ContextDraft, name: string): DraftBusinessUnit | undefined {
  const target = name.trim().toLowerCase();
  return draft.businessUnits.find((bu) => bu.name.trim().toLowerCase() === target);
}

/**
 * Apply an uploaded CSV to the draft (Requirement 5.11). Matches rows to
 * accounts by `account_id` and updates display name, Account_Context, and
 * Business_Unit membership per row. The result is loaded into the editable
 * draft — it is NOT saved; the admin reviews it and uses the normal validated
 * Save (`PUT /context`), so no state changes without review.
 *
 * Business_Unit handling (per product decision): an EMPTY `business_unit`
 * unassigns the account; a value matching an EXISTING unit assigns it (moving it
 * out of any other unit — exactly one BU); a NON-EMPTY value that does not match
 * any existing unit is reported as an error and the account's membership is left
 * unchanged. Business units are never auto-created and assignment is never
 * forced. Unknown `account_id`s (absent from the manifest) are reported and the
 * whole row is skipped. Field-length limits are not enforced here — they are
 * caught by {@link validateDraft} before save so the admin sees them inline.
 */
export function applyCsvToDraft(
  draft: ContextDraft,
  csvText: string,
  known: Set<string>,
): CsvImportResult {
  const errors: CsvImportError[] = [];
  const rows = parseCsv(csvText);
  if (rows.length === 0) {
    return { draft, errors: [{ line: 1, message: 'The file is empty.' }], applied: 0 };
  }

  // Map header names -> column index (case-insensitive, trimmed).
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const idCol = col('account_id');
  if (idCol === -1) {
    return {
      draft,
      errors: [{ line: 1, message: 'Missing required "account_id" column in the header row.' }],
      applied: 0,
    };
  }
  const displayCol = col('display_name');
  const buCol = col('business_unit');
  const contextCol = col('context');

  let next = draft;
  let applied = 0;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const line = r + 1; // 1-based, header is line 1
    // Skip fully blank lines.
    if (row.every((cell) => cell.trim() === '')) continue;

    const account = (row[idCol] ?? '').trim();
    if (account === '') {
      errors.push({ line, message: 'Missing account_id.' });
      continue;
    }
    if (!known.has(account)) {
      errors.push({
        line,
        account,
        message: `Account "${account}" is not present in the collected data manifest.`,
      });
      continue;
    }

    let changed = false;

    if (displayCol !== -1) {
      next = setAccountDisplayName(next, account, (row[displayCol] ?? '').trim());
      changed = true;
    }
    if (contextCol !== -1) {
      next = setAccountContext(next, account, (row[contextCol] ?? '').trim());
      changed = true;
    }
    if (buCol !== -1) {
      const buName = (row[buCol] ?? '').trim();
      if (buName === '') {
        // Empty => unassigned (allowed).
        next = clearBusinessUnitForAccount(next, account);
        changed = true;
      } else {
        const bu = findBusinessUnitByName(next, buName);
        if (bu) {
          next = assignAccountToBusinessUnit(next, bu.id, account);
          changed = true;
        } else {
          // Unknown BU: do not create, do not force-assign; leave membership as-is.
          errors.push({
            line,
            account,
            message: `Business unit "${buName}" does not exist. Create it first or leave the cell blank; the account's business unit was left unchanged.`,
          });
        }
      }
    }

    if (changed) applied += 1;
  }

  return { draft: next, errors, applied };
}

// ---------------------------------------------------------------------------
// Client-side validation (mirrors the backend; Requirements 5.1, 5.2, 5.7)
// ---------------------------------------------------------------------------

/** A single validation problem; `account` is set for account-existence issues. */
export interface DraftIssue {
  /** Local BU id or account id the issue relates to (for inline display). */
  ref: string;
  message: string;
  /** The unrecognized account id when the issue is an account-existence failure. */
  account?: string;
}

/**
 * Validate a draft against the known manifest accounts. Returns every problem
 * found (validation does not stop at the first) so the UI can show them all and
 * block the save while any exist. On an empty valid draft this returns `[]`.
 */
export function validateDraft(draft: ContextDraft, known: Set<string>): DraftIssue[] {
  const issues: DraftIssue[] = [];

  // Track BU membership to enforce "exactly one Business_Unit" (Req 5.1).
  const buOfAccount = new Map<string, string[]>();

  draft.businessUnits.forEach((bu) => {
    const name = bu.name.trim();
    if (name.length < BU_NAME_MIN_LENGTH) {
      issues.push({ ref: bu.id, message: 'Business unit name is required.' });
    } else if (name.length > BU_NAME_MAX_LENGTH) {
      issues.push({
        ref: bu.id,
        message: `Business unit name must be ${BU_NAME_MIN_LENGTH}–${BU_NAME_MAX_LENGTH} characters.`,
      });
    }

    if (bu.description.length > METADATA_MAX_LENGTH) {
      issues.push({
        ref: bu.id,
        message: `Descriptive metadata must be at most ${METADATA_MAX_LENGTH} characters.`,
      });
    }

    for (const account of bu.accounts) {
      // Every assigned account must exist in the manifest (Req 5.7).
      if (!known.has(account)) {
        issues.push({
          ref: bu.id,
          account,
          message: `Account "${account}" is not present in the collected data manifest.`,
        });
      }
      const list = buOfAccount.get(account) ?? [];
      list.push(bu.id);
      buOfAccount.set(account, list);
    }
  });

  // An account assigned to more than one BU violates "exactly one" (Req 5.1).
  for (const [account, buIds] of buOfAccount) {
    if (buIds.length > 1) {
      issues.push({
        ref: buIds[0] ?? account,
        account,
        message: `Account "${account}" is assigned to more than one business unit; each account maps to exactly one.`,
      });
    }
  }

  // Display names: 1–128 chars when set; the account must exist (Req 5.2, 5.7).
  for (const [account, rawName] of Object.entries(draft.accountDisplayNames)) {
    const name = rawName.trim();
    if (name.length === 0) {
      continue; // blank = unset; nothing persisted
    }
    if (!known.has(account)) {
      issues.push({
        ref: account,
        account,
        message: `Account "${account}" is not present in the collected data manifest.`,
      });
      continue;
    }
    if (name.length < DISPLAY_NAME_MIN_LENGTH || name.length > DISPLAY_NAME_MAX_LENGTH) {
      issues.push({
        ref: account,
        message: `Display name must be ${DISPLAY_NAME_MIN_LENGTH}–${DISPLAY_NAME_MAX_LENGTH} characters.`,
      });
    }
  }

  // Per-account context: ≤ACCOUNT_CONTEXT_MAX_LENGTH when set; account must exist (Req 5.2, 5.7).
  for (const [account, rawText] of Object.entries(draft.accountContext)) {
    const text = rawText.trim();
    if (text.length === 0) {
      continue; // blank = unset; nothing persisted
    }
    if (!known.has(account)) {
      issues.push({
        ref: account,
        account,
        message: `Account "${account}" is not present in the collected data manifest.`,
      });
      continue;
    }
    if (rawText.length > ACCOUNT_CONTEXT_MAX_LENGTH) {
      issues.push({
        ref: account,
        message: `Account context must be at most ${ACCOUNT_CONTEXT_MAX_LENGTH} characters.`,
      });
    }
  }

  // Org system prompt: optional, ≤ORG_SYSTEM_PROMPT_MAX_LENGTH chars (Req 5.16).
  if (draft.orgSystemPrompt.length > ORG_SYSTEM_PROMPT_MAX_LENGTH) {
    issues.push({
      ref: 'orgSystemPrompt',
      message: `Org system prompt must be at most ${ORG_SYSTEM_PROMPT_MAX_LENGTH} characters.`,
    });
  }

  return issues;
}

/** True when the draft has no blocking validation issues and may be saved. */
export function isDraftValid(draft: ContextDraft, known: Set<string>): boolean {
  return validateDraft(draft, known).length === 0;
}

/** The subset of issues that relate to a specific Business_Unit (by local id). */
export function issuesForBusinessUnit(issues: DraftIssue[], buId: string): DraftIssue[] {
  return issues.filter((i) => i.ref === buId);
}

/** The subset of issues that relate to a specific account's display name. */
export function issuesForAccount(issues: DraftIssue[], account: string): DraftIssue[] {
  return issues.filter((i) => i.ref === account);
}
