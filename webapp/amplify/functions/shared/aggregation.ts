import type {
  AccountSpaces,
  AggregateTotals,
  BreakdownRow,
  BusinessContext,
  CollectionStatus,
  DashboardDTO,
  DashboardGrouping,
  LastSyncDate,
  Manifest,
  ManifestAccount,
  ManifestSpace,
  SpaceRow,
  SpacesDTO,
  SummaryDTO,
} from '@devops-observatory/shared-types';

/**
 * Pure aggregation core for the S3 read APIs (Task 4).
 *
 * Every function here is deterministic and side-effect free so it can be unit /
 * property tested in isolation (Task 18). The handlers load the manifest +
 * business context and delegate all shaping to these helpers.
 *
 * Incident mapping (Requirements 6.1, 11.1): in AWS DevOps Agent an *Incident*
 * and an *Investigation* are the same thing — the agent runs an INVESTIGATION
 * backlog task to investigate an operational incident. The collector records
 * that task count once and mirrors it into both `counts.incidents` and
 * `counts.investigations`, so the Incident total equals the Investigation total
 * and Recommendations remain a separate metric (NOT folded into incidents).
 * This mapping is computed once here and reused by the Summary and Dashboard so
 * the two views never disagree.
 */

const UNASSIGNED_BUSINESS_UNIT = 'Unassigned';

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * Resolve the Last_Sync_Date for the loaded manifest: the `collectedAt`
 * timestamp when it is a valid date-time, otherwise the literal `"unknown"`.
 * Never returns a blank, placeholder, or invalid value (Requirements 4.3, 4.4).
 */
export function resolveLastSyncDate(manifest: Manifest): LastSyncDate {
  const raw = manifest.collectedAt;
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown';
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 'unknown' : raw;
}

// ---------------------------------------------------------------------------
// Incident mapping + per-account / totals aggregation
// ---------------------------------------------------------------------------

function sumSpaces(spaces: ManifestSpace[], pick: (c: ManifestSpace['counts']) => number): number {
  return spaces.reduce((total, space) => total + pick(space.counts), 0);
}

/** Total collected Investigations for an account (Requirement 6.2). */
export function investigationsForAccount(account: ManifestAccount): number {
  return sumSpaces(account.spaces, (c) => c.investigations);
}

/** Total (open) Recommendations for an account. */
export function recommendationsForAccount(account: ManifestAccount): number {
  return sumSpaces(account.spaces, (c) => c.recommendations);
}

/**
 * Incident count for a single account: the number of collected incidents
 * (INVESTIGATION backlog tasks). Equals {@link investigationsForAccount} since
 * an incident and an investigation are the same thing (Requirement 6.1).
 */
export function incidentsForAccount(account: ManifestAccount): number {
  return sumSpaces(account.spaces, (c) => c.incidents);
}

/**
 * Per-space capability metrics rolled up into every aggregation scope
 * (account, Business_Unit, organization). Keys are shared between
 * {@link ManifestSpaceCounts} and {@link AggregateTotals} so the rollup is a
 * plain per-key sum of the per-space counts.
 */
const CAPABILITY_KEYS = [
  'telemetry',
  'pipelines',
  'communications',
  'mcpServers',
  'remoteAgents',
  'webhooks',
  'logDeliveries',
  'users',
] as const satisfies ReadonlyArray<keyof ManifestSpace['counts'] & keyof AggregateTotals>;

/**
 * Null-as-zero addition for capability rollups: a `null` (unknown) space
 * metric is treated as 0 in the rollup so that the total reflects the sum of
 * what was successfully measured. The "—" (unknown) indicator stays visible at
 * the individual space level only — the Dashboard/Summary totals always show a
 * real number (the measurable portion of the fleet).
 */
function addNullable(a: number | null, b: number | null): number {
  return (a ?? 0) + (b ?? 0);
}

/**
 * Sum a capability metric across spaces, treating null (unknown) as 0 so
 * rollups always produce a number. An empty scope is a true 0 — no spaces
 * means genuinely nothing configured.
 */
function sumNullable(
  spaces: ManifestSpace[],
  pick: (c: ManifestSpace['counts']) => number | null,
): number {
  return spaces.reduce<number>((total, space) => addNullable(total, pick(space.counts)), 0);
}

/** Aggregate totals (activity + capability rollups) for one account. */
export function totalsForAccount(account: ManifestAccount): AggregateTotals {
  const totals: AggregateTotals = {
    ...zeroTotals(),
    incidents: incidentsForAccount(account),
    investigations: investigationsForAccount(account),
    agentSpaces: account.spaces.length,
  };
  for (const key of CAPABILITY_KEYS) {
    totals[key] = sumNullable(account.spaces, (c) => c[key]);
  }
  // Usage: per-account (not per-space), null-as-0.
  if (account.usage) {
    totals.investigationHours = account.usage.investigationHours;
    totals.evaluationHours = account.usage.evaluationHours;
    totals.systemLearningHours = account.usage.systemLearningHours;
    totals.onDemandHours = account.usage.onDemandHours;
  }
  return totals;
}

function zeroTotals(): AggregateTotals {
  return {
    incidents: 0,
    investigations: 0,
    agentSpaces: 0,
    telemetry: 0,
    pipelines: 0,
    communications: 0,
    mcpServers: 0,
    remoteAgents: 0,
    webhooks: 0,
    logDeliveries: 0,
    users: 0,
    investigationHours: 0,
    evaluationHours: 0,
    systemLearningHours: 0,
    onDemandHours: 0,
  };
}

function addTotals(a: AggregateTotals, b: AggregateTotals): AggregateTotals {
  const sum = zeroTotals();
  for (const key of Object.keys(sum) as Array<keyof AggregateTotals>) {
    sum[key] = a[key] + b[key];
  }
  return sum;
}

/**
 * Sum aggregate totals across every account in the manifest scope
 * (Requirements 6.1–6.3, 12.5). Returns explicit zeros for an empty manifest.
 */
export function totalsForManifest(manifest: Manifest): AggregateTotals {
  return manifest.accounts.reduce((acc, account) => addTotals(acc, totalsForAccount(account)), zeroTotals());
}

// ---------------------------------------------------------------------------
// Business-context labelling
// ---------------------------------------------------------------------------

/** True when at least one account is assigned to a Business_Unit (Requirement 6.4). */
export function hasBusinessUnitAssignments(context: BusinessContext | null): boolean {
  return !!context && context.businessUnits.some((bu) => bu.accounts.length > 0);
}

/**
 * The display name for an account. Fallback order (Requirements 3.5, 3.8):
 *   1. the Admin-authored business-context display name, if set;
 *   2. the AWS Organizations account name captured by the collector, if any;
 *   3. the raw AWS account id.
 * So an org name is surfaced automatically even before an Admin sets a label,
 * and the raw id is only shown when neither friendly name exists.
 */
export function accountDisplayName(
  accountId: string,
  context: BusinessContext | null,
  orgName?: string,
): string {
  const label = context?.accountDisplayNames[accountId];
  if (label && label.length > 0) return label;
  if (orgName && orgName.length > 0) return orgName;
  return accountId;
}

/** The Business_Unit an account belongs to, or undefined when unassigned. */
export function businessUnitForAccount(
  accountId: string,
  context: BusinessContext | null,
): string | undefined {
  if (!context) return undefined;
  const bu = context.businessUnits.find((unit) => unit.accounts.includes(accountId));
  return bu?.name;
}

// ---------------------------------------------------------------------------
// /summary
// ---------------------------------------------------------------------------

/** Build the `GET /summary` DTO from the loaded manifest (Task 4.1). */
export function buildSummary(manifest: Manifest): SummaryDTO {
  return {
    totals: totalsForManifest(manifest),
    lastSyncDate: resolveLastSyncDate(manifest),
  };
}

/** Freshness-unknown summary used when the manifest is unavailable (Requirement 4.3). */
export function unavailableSummary(): SummaryDTO {
  return { totals: zeroTotals(), lastSyncDate: 'unknown' };
}

// ---------------------------------------------------------------------------
// /spaces
// ---------------------------------------------------------------------------

/** A space is "incomplete" when its account recorded a collection error (Requirement 3.3). */
function accountStatus(account: ManifestAccount): CollectionStatus {
  return account.error ? 'incomplete' : 'collected';
}

/** Space name, or the agentSpaceId when unnamed (Requirement 3.2). */
export function spaceDisplayName(space: ManifestSpace): string {
  return space.name && space.name.length > 0 ? space.name : space.agentSpaceId;
}

function toSpaceRow(space: ManifestSpace, status: CollectionStatus): SpaceRow {
  return {
    agentSpaceId: space.agentSpaceId,
    displayName: spaceDisplayName(space),
    counts: space.counts,
    status,
  };
}

/** Map a manifest account to its Space_View row (Requirements 3.1–3.6). */
export function toAccountSpaces(
  account: ManifestAccount,
  context: BusinessContext | null,
  lastSyncDate: LastSyncDate,
): AccountSpaces {
  const status = accountStatus(account);
  const orgName = account.name && account.name.length > 0 ? account.name : undefined;
  return {
    account: account.account,
    displayName: accountDisplayName(account.account, context, orgName),
    ...(orgName ? { orgName } : {}),
    businessUnit: businessUnitForAccount(account.account, context),
    spaces: account.spaces.map((space) => toSpaceRow(space, status)),
    hasNoSpaces: account.spaces.length === 0,
    status,
    lastSyncDate,
  };
}

/**
 * Build the `GET /spaces` DTO: every manifest account with grouped spaces,
 * status, per-account Last_Sync_Date, and business-context labels (Task 4.2).
 * The caller only invokes this when the manifest loaded successfully; a parse
 * failure is handled upstream as an error with no partial listing (Req 3.7).
 */
export function buildSpaces(manifest: Manifest, context: BusinessContext | null): SpacesDTO {
  const lastSyncDate = resolveLastSyncDate(manifest);
  return {
    accounts: manifest.accounts.map((account) => toAccountSpaces(account, context, lastSyncDate)),
    lastSyncDate,
  };
}

// ---------------------------------------------------------------------------
// /dashboard
// ---------------------------------------------------------------------------

/** Ordered accumulation of breakdown rows keyed by group name. */
function accumulateBreakdown(
  entries: Array<{ key: string; totals: AggregateTotals }>,
): BreakdownRow[] {
  const order: string[] = [];
  const byKey = new Map<string, AggregateTotals>();
  for (const { key, totals } of entries) {
    const existing = byKey.get(key);
    if (existing) {
      byKey.set(key, addTotals(existing, totals));
    } else {
      order.push(key);
      byKey.set(key, totals);
    }
  }
  return order.map((key) => ({ key, totals: byKey.get(key) ?? zeroTotals() }));
}

/** By-Business_Unit breakdown; unassigned accounts fall into "Unassigned" (Req 12.7). */
export function breakdownByBusinessUnit(
  manifest: Manifest,
  context: BusinessContext | null,
): BreakdownRow[] {
  return accumulateBreakdown(
    manifest.accounts.map((account) => ({
      key: businessUnitForAccount(account.account, context) ?? UNASSIGNED_BUSINESS_UNIT,
      totals: totalsForAccount(account),
    })),
  );
}

/** By-account breakdown; one row per manifest account (Requirement 6.5). */
export function breakdownByAccount(
  manifest: Manifest,
  context: BusinessContext | null,
): BreakdownRow[] {
  return accumulateBreakdown(
    manifest.accounts.map((account) => ({
      key: accountDisplayName(account.account, context, account.name),
      totals: totalsForAccount(account),
    })),
  );
}

/**
 * Build the `GET /dashboard` DTO (Task 4.3). Aggregates across all manifest
 * accounts, grouping by Business_Unit when business context assigns any account
 * (else by account). Totals are always explicit integers, so a zero metric
 * renders as `0` rather than being omitted (Requirement 6.7). An empty manifest
 * yields an empty breakdown, which the UI renders as a no-data message
 * (Requirement 6.8).
 */
export function buildDashboard(manifest: Manifest, context: BusinessContext | null): DashboardDTO {
  const useBusinessUnits = hasBusinessUnitAssignments(context);
  const grouping: DashboardGrouping = useBusinessUnits ? 'businessUnit' : 'account';
  const breakdown = useBusinessUnits
    ? breakdownByBusinessUnit(manifest, context)
    : breakdownByAccount(manifest, context);
  return {
    totals: totalsForManifest(manifest),
    grouping,
    breakdown,
    lastSyncDate: resolveLastSyncDate(manifest),
  };
}

/** Freshness-unknown / no-data dashboard used when the manifest is unavailable. */
export function unavailableDashboard(): DashboardDTO {
  return { totals: zeroTotals(), grouping: 'account', breakdown: [], lastSyncDate: 'unknown' };
}
