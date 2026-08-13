import type {
  AccountSpaces,
  CollectionStatus,
  ManifestSpaceCounts,
} from '@devops-observatory/shared-types';

/**
 * Pure, DOM-free presentation helpers for the Space_View (Task 12).
 *
 * Kept separate from the React component so the identifier, label, and count
 * logic can be unit-tested with the repo's `node:test` + tsx convention and
 * reused without pulling in the view. All functions are deterministic and
 * side-effect free.
 *
 * Requirements: 3.2 (space name/id + counts), 3.3 (collected/incomplete
 * status), 3.5 (business label as the primary identifier with the raw AWS
 * account id retained as a secondary reference), 3.6 (no-spaces indicator).
 */

/** Human-readable label for an account's data-completeness status (Req 3.3). */
export const STATUS_LABELS: Record<CollectionStatus, string> = {
  collected: 'Collected',
  incomplete: 'Incomplete',
};

/** The account identity shown in the Space_View. */
export interface AccountIdentity {
  /** The human-friendly label shown as the primary identifier (Req 3.5). */
  primary: string;
  /**
   * The raw AWS account id, retained as a secondary reference only when it
   * differs from the primary label (i.e. business context provided a display
   * name). When no friendly label exists the primary already IS the raw id, so
   * this is undefined to avoid showing the same value twice (Req 3.5).
   */
  secondary?: string;
}

/**
 * Resolve the primary/secondary identifiers for an account.
 *
 * The backend already overlays the business-context display name onto
 * `displayName` (falling back to the raw id). This helper decides when to also
 * surface the raw AWS account id as a secondary reference: only when a friendly
 * label is actually in use.
 */
export function accountIdentity(account: AccountSpaces): AccountIdentity {
  const primary =
    account.displayName && account.displayName.length > 0
      ? account.displayName
      : account.account;
  return primary === account.account ? { primary } : { primary, secondary: account.account };
}

/** Label for an account's collection status (Req 3.3). */
export function statusLabel(status: CollectionStatus): string {
  return STATUS_LABELS[status] ?? STATUS_LABELS.collected;
}

/**
 * Case-insensitive match of an account against a search term (Requirement 3.9).
 * Matches the raw AWS account id, the resolved display name, the collector's
 * org name, the assigned Business_Unit, and any of the account's space names or
 * ids — so an executive can find an account by whatever they remember it as.
 */
export function accountMatchesQuery(account: AccountSpaces, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return true;
  const haystacks: Array<string | undefined> = [
    account.account,
    account.displayName,
    account.orgName,
    account.businessUnit,
    ...account.spaces.flatMap((s) => [s.displayName, s.agentSpaceId]),
  ];
  return haystacks.some((h) => typeof h === 'string' && h.toLowerCase().includes(q));
}

/**
 * Filter accounts by a search term, preserving input order. An empty/blank
 * query returns every account. Deterministic and DOM-free for unit testing.
 */
export function filterSpaceAccounts(
  accounts: AccountSpaces[],
  query: string,
): AccountSpaces[] {
  const q = query.trim();
  if (q.length === 0) return accounts;
  return accounts.filter((a) => accountMatchesQuery(a, q));
}

/** True when the account has no Agent_Spaces and the no-spaces notice applies (Req 3.6). */
export function hasNoSpaces(account: AccountSpaces): boolean {
  // Trust the backend flag, but fall back to the array so the notice is shown
  // consistently even if the flag were ever omitted.
  return account.hasNoSpaces || account.spaces.length === 0;
}

/**
 * Accounts that have no agent spaces, preserving input order. These are the
 * candidates for the batch space-creation table (Refresh view).
 */
export function accountsWithoutSpaces(accounts: AccountSpaces[]): AccountSpaces[] {
  return accounts.filter(hasNoSpaces);
}

/** The set of account ids that currently have at least one space (for pending reconcile). */
export function accountsWithSpaceIds(accounts: AccountSpaces[]): string[] {
  return accounts.filter((a) => !hasNoSpaces(a)).map((a) => a.account);
}

/**
 * The ordered activity-count fields shown for each Agent_Space (Req 3.2).
 *
 * - "Investigations" is the number of the space's investigations — the agent's
 *   investigations of operational incidents (in AWS DevOps Agent an
 *   investigation IS an incident, so this is also the per-space incident count).
 * - "Integrations" is the number of the space's associations — the AWS account
 *   sources and third-party service integrations (GitHub, Slack, …) connected to
 *   the space. NOTE: this is NOT the console's "Relationships mapped" figure,
 *   which is the agent's internal raw topology count and is not exposed by the
 *   DevOps Agent API.
 */
export const SPACE_COUNT_FIELDS: ReadonlyArray<{
  key: keyof ManifestSpaceCounts;
  label: string;
}> = [
  { key: 'investigations', label: 'Investigations' },
  { key: 'associations', label: 'Integrations' },
  { key: 'recommendations', label: 'Recommendations' },
  { key: 'assets', label: 'Assets' },
];

/**
 * The ordered capability-count fields shown for each Agent_Space: how many of
 * each capability are configured (counts only — no per-configuration detail),
 * plus the space's log-delivery endpoints and operator-app user access count.
 */
export const SPACE_CAPABILITY_FIELDS: ReadonlyArray<{
  key: keyof ManifestSpaceCounts;
  label: string;
}> = [
  { key: 'telemetry', label: 'Telemetry' },
  { key: 'pipelines', label: 'Pipelines' },
  { key: 'communications', label: 'Communications' },
  { key: 'mcpServers', label: 'MCP servers' },
  { key: 'remoteAgents', label: 'Remote agents' },
  { key: 'webhooks', label: 'Webhooks' },
  { key: 'logDeliveries', label: 'Log deliveries' },
  { key: 'users', label: 'Users with access' },
];

/** A single labelled activity count for rendering. */
export interface SpaceCountEntry {
  key: keyof ManifestSpaceCounts;
  label: string;
  /**
   * The metric value. Activity counts are always numbers; capability metrics
   * may be `null` = unknown (the collector could not retrieve the metric),
   * which the UI renders as "—", never as a false 0.
   */
  value: number | null;
}

/**
 * Flatten a space's counts into an ordered list of labelled entries for
 * display. Non-finite/negative values are coerced to a safe `0` so a metric is
 * always shown as a number (Req 3.2).
 */
export function spaceCountEntries(counts: ManifestSpaceCounts): SpaceCountEntry[] {
  return SPACE_COUNT_FIELDS.map(({ key, label }) => {
    const raw = counts[key];
    const value =
      typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
    return { key, label, value };
  });
}

/**
 * Flatten a space's capability counts (telemetry, pipelines, communications,
 * MCP servers, remote agents, webhooks, log deliveries, users with access)
 * into an ordered list of labelled entries for display. A known value gets the
 * same safe-integer coercion as {@link spaceCountEntries}; `null`/absent means
 * UNKNOWN (the collector could not retrieve the metric) and is preserved so
 * the UI renders it as "—" rather than a false 0.
 */
export function spaceCapabilityEntries(counts: ManifestSpaceCounts): SpaceCountEntry[] {
  return SPACE_CAPABILITY_FIELDS.map(({ key, label }) => {
    const raw = counts[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return { key, label, value: null };
    }
    return { key, label, value: raw > 0 ? Math.trunc(raw) : 0 };
  });
}
