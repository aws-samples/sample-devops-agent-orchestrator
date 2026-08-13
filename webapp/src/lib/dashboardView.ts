import type {
  AggregateTotals,
  DashboardDTO,
  DashboardGrouping,
  ManifestSpaceCounts,
  SpacesDTO,
} from '@devops-observatory/shared-types';

/**
 * Pure, DOM-free presentation helpers for the Dashboard (Task 13).
 *
 * Kept separate from the React component so the grouping labels, no-data
 * detection, and count-flattening logic can be unit-tested with the repo's
 * `node:test` + tsx convention and reused without pulling in the view. All
 * functions are deterministic and side-effect free.
 *
 * Requirements: 6.1–6.3 (totals + per-Agent_Space activity counts), 6.4/6.5
 * (by-Business_Unit vs by-account breakdown), 6.7 (zero rendered as 0),
 * 6.8 (no-data handling), 11.5 (tabular/chart presentation).
 */

/** Coerce a raw count to a safe non-negative integer (mirrors the Space_View). */
function safeCount(raw: number): number {
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 0;
}

// ---------------------------------------------------------------------------
// Aggregate totals (Requirements 6.1–6.3)
// ---------------------------------------------------------------------------

/** The ordered aggregate-total fields shown as the Dashboard's headline metrics. */
export const DASHBOARD_TOTAL_FIELDS: ReadonlyArray<{
  key: keyof AggregateTotals;
  label: string;
  hint: string;
}> = [
  {
    key: 'incidents',
    label: 'Incidents',
    hint: 'Investigations plus open recommendations',
  },
  {
    key: 'investigations',
    label: 'Investigations',
    hint: 'Across all agent spaces',
  },
  {
    key: 'agentSpaces',
    label: 'Agent spaces',
    hint: 'Total agent spaces in scope',
  },
] as const;

/**
 * The ordered capability rollups shown as organization-wide totals: how many
 * of each capability are configured across all agent spaces (counts only),
 * plus log-delivery endpoints and operator-app user access.
 */
export const DASHBOARD_CAPABILITY_FIELDS: ReadonlyArray<{
  key: keyof AggregateTotals;
  label: string;
  hint: string;
}> = [
  { key: 'telemetry', label: 'Telemetry', hint: 'Telemetry integrations configured' },
  { key: 'pipelines', label: 'Pipelines', hint: 'Pipeline integrations configured' },
  { key: 'communications', label: 'Communications', hint: 'Communication channels configured' },
  { key: 'mcpServers', label: 'MCP servers', hint: 'MCP server integrations configured' },
  { key: 'remoteAgents', label: 'Remote agents', hint: 'Remote agent integrations configured' },
  { key: 'webhooks', label: 'Webhooks', hint: 'Webhooks configured across associations' },
  { key: 'logDeliveries', label: 'Log deliveries', hint: 'Log delivery endpoints configured' },
  { key: 'users', label: 'Users with access', hint: 'Operator-app users across spaces' },
] as const;

/**
 * The ordered metric columns of the Dashboard breakdown table (per
 * Business_Unit or per account): activity totals followed by the capability
 * rollups, so each BU/account row carries the same metrics as the org totals.
 */
export const DASHBOARD_BREAKDOWN_FIELDS: ReadonlyArray<{
  key: keyof AggregateTotals;
  label: string;
}> = [
  { key: 'incidents', label: 'Incidents' },
  { key: 'investigations', label: 'Investigations' },
  { key: 'agentSpaces', label: 'Agent spaces' },
  ...DASHBOARD_CAPABILITY_FIELDS.map(({ key, label }) => ({ key, label })),
] as const;

/**
 * Monthly usage metric fields shown as organization/BU/account rollups.
 * These are hours from GetAccountUsage, summed across accounts in scope.
 */
export const DASHBOARD_USAGE_FIELDS: ReadonlyArray<{
  key: keyof AggregateTotals;
  label: string;
  hint: string;
}> = [
  { key: 'investigationHours', label: 'Investigation hours', hint: 'Monthly investigation hours used' },
  { key: 'evaluationHours', label: 'Evaluation hours', hint: 'Monthly evaluation hours used' },
  { key: 'systemLearningHours', label: 'System learning hours', hint: 'Monthly system learning hours used' },
  { key: 'onDemandHours', label: 'On-demand hours', hint: 'Monthly on-demand hours used' },
] as const;

/** Flatten usage rollups into an ordered list of labelled entries. */
export function usageEntries(totals: AggregateTotals): TotalEntry[] {
  return DASHBOARD_USAGE_FIELDS.map(({ key, label, hint }) => ({
    key,
    label,
    hint,
    value: typeof totals[key] === 'number' && Number.isFinite(totals[key]) ? totals[key] : 0,
    isHours: true,
  }));
}

/** A single labelled total for rendering. */
export interface TotalEntry {
  key: keyof AggregateTotals;
  label: string;
  hint: string;
  value: number;
  /** When true, format as hours (2 decimal places) instead of integer count. */
  isHours?: boolean;
}

/**
 * Flatten the aggregate totals into an ordered list of labelled entries. Values
 * are coerced to safe non-negative integers so a zero metric always renders as
 * `0` rather than being blank or omitted (Requirement 6.7).
 */
export function totalEntries(totals: AggregateTotals): TotalEntry[] {
  return DASHBOARD_TOTAL_FIELDS.map(({ key, label, hint }) => ({
    key,
    label,
    hint,
    value: safeCount(totals[key]),
  }));
}

/**
 * Flatten the capability rollups into an ordered list of labelled entries.
 * Rollups are always numbers (null space metrics are summed as 0), so the
 * same safe-count coercion applies.
 */
export function capabilityEntries(totals: AggregateTotals): TotalEntry[] {
  return DASHBOARD_CAPABILITY_FIELDS.map(({ key, label, hint }) => ({
    key,
    label,
    hint,
    value: safeCount(totals[key]),
  }));
}

// ---------------------------------------------------------------------------
// Breakdown grouping (Requirements 6.4, 6.5)
// ---------------------------------------------------------------------------

/** Column header for the breakdown's group key, driven by the grouping mode. */
export function groupingColumnLabel(grouping: DashboardGrouping): string {
  return grouping === 'businessUnit' ? 'Business unit' : 'Account';
}

/**
 * Short human-readable description of how the breakdown is grouped, shown as
 * supporting copy above the table (Requirements 6.4, 6.5).
 */
export function groupingDescription(grouping: DashboardGrouping): string {
  return grouping === 'businessUnit'
    ? 'Grouped by business unit; accounts without a business unit are shown under “Unassigned”.'
    : 'Grouped by account; define business units in the Context Manager to group these.';
}

/**
 * True when the dashboard has no breakdown rows to present, i.e. no hub data is
 * loaded. The view renders a "no data available" message in this case and shows
 * no fabricated or partial counts (Requirement 6.8).
 */
export function hasNoData(dto: DashboardDTO): boolean {
  return dto.breakdown.length === 0;
}

// ---------------------------------------------------------------------------
// Per-Agent_Space activity (Requirement 6.3)
// ---------------------------------------------------------------------------

/** The activity-count fields called out by Requirement 6.3. */
export type AgentSpaceActivityKey = 'recommendations' | 'associations' | 'assets';

/**
 * The ordered activity-count fields shown per Agent_Space on the Dashboard.
 * Requirement 6.3 calls out Recommendations, Associations, and Assets.
 */
export const AGENT_SPACE_ACTIVITY_FIELDS: ReadonlyArray<{
  key: AgentSpaceActivityKey;
  label: string;
}> = [
  { key: 'recommendations', label: 'Recommendations' },
  { key: 'associations', label: 'Associations' },
  { key: 'assets', label: 'Assets' },
] as const;

/** A single Agent_Space's activity row for the Dashboard's per-space table. */
export interface AgentSpaceActivityRow {
  /** Stable row key: account id + space id (unique across accounts). */
  key: string;
  /** Agent_Space name, or the id when unnamed (mirrors the Space_View). */
  spaceName: string;
  agentSpaceId: string;
  /** Business-oriented account label (display name / BU), never a raw id alone. */
  accountLabel: string;
  /** The three activity counts called out by Requirement 6.3, as safe integers. */
  counts: Pick<ManifestSpaceCounts, AgentSpaceActivityKey>;
}

/**
 * Flatten every Agent_Space across all accounts into an ordered list of
 * activity rows for the Dashboard's per-space table (Requirement 6.3). Counts
 * are coerced to safe non-negative integers so a zero renders as `0`
 * (Requirement 6.7). Accounts with no spaces contribute no rows.
 */
export function agentSpaceActivityRows(spaces: SpacesDTO): AgentSpaceActivityRow[] {
  const rows: AgentSpaceActivityRow[] = [];
  for (const account of spaces.accounts) {
    for (const space of account.spaces) {
      rows.push({
        key: `${account.account}:${space.agentSpaceId}`,
        spaceName: space.displayName,
        agentSpaceId: space.agentSpaceId,
        accountLabel: account.displayName,
        counts: {
          recommendations: safeCount(space.counts.recommendations),
          associations: safeCount(space.counts.associations),
          assets: safeCount(space.counts.assets),
        },
      });
    }
  }
  return rows;
}
