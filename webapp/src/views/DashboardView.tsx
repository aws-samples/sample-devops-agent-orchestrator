import { useEffect, useState } from 'react';
import type { DashboardDTO, SpacesDTO } from '@devops-observatory/shared-types';
import { fetchDashboard } from '../api/dashboard';
import { fetchSpaces } from '../api/spaces';
import { formatHours, formatMetric } from '../lib/format';
import { resolveErrorMessage } from '../lib/viewState';
import { LoadingMessage, ErrorMessage, EmptyMessage } from '../components/StateMessage';
import { FreshnessIndicator } from '../components/FreshnessIndicator';
import {
  AGENT_SPACE_ACTIVITY_FIELDS,
  agentSpaceActivityRows,
  capabilityEntries,
  DASHBOARD_BREAKDOWN_FIELDS,
  groupingColumnLabel,
  groupingDescription,
  hasNoData,
  totalEntries,
  usageEntries,
} from '../lib/dashboardView';

/**
 * Dashboard view (Task 13 — Requirements 6.1–6.5, 6.7, 6.8, 11.5).
 *
 * Presents tabular summaries of the hub data across all Linked_Accounts:
 *  - Headline totals: Incidents, Investigations, and Agent_Spaces (6.1–6.3).
 *  - A breakdown grouped by Business_Unit when business context assigns any
 *    account (with an "Unassigned" bucket), else grouped by account (6.4, 6.5).
 *  - Per-Agent_Space activity counts — Recommendations, Associations, Assets
 *    (6.3).
 * Every metric is rendered as an explicit integer, so a zero shows as `0`
 * rather than blank (6.7), and all figures are presented in tables rather than
 * unformatted text (11.5).
 *
 * Totals and the breakdown come from `GET /dashboard`; the per-space activity
 * counts (which the dashboard DTO does not carry) come from `GET /spaces`. No
 * AWS credentials are used in the browser — all data flows through the API.
 *
 * No-data handling (6.8): when the dashboard has no breakdown rows (no hub data
 * loaded) the view shows a clear "no data available" message and no fabricated
 * or partial counts. The per-space section is best-effort: if `GET /spaces`
 * fails while the dashboard loads, the rest of the view still renders.
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; dashboard: DashboardDTO; spaces: SpacesDTO | null }
  | { status: 'error'; message: string };

export function DashboardView(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    // The dashboard is required; per-space activity is best-effort so a
    // /spaces failure never blocks the totals/breakdown from rendering.
    Promise.all([fetchDashboard(), fetchSpaces().catch(() => null)])
      .then(([dashboard, spaces]) => {
        if (active) {
          setState({ status: 'ready', dashboard, spaces });
        }
      })
      .catch((err: unknown) => {
        if (!active) {
          return;
        }
        const message = resolveErrorMessage(
          err,
          'Unable to load the dashboard right now. Please try again.',
        );
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="dashboard-heading">
      <h2 id="dashboard-heading" style={{ marginTop: 0 }}>
        Dashboard
      </h2>
      <p style={{ color: '#475467', marginTop: '-0.25rem' }}>
        Incident, investigation, and agent-space usage summaries across all linked accounts.
      </p>

      {state.status === 'loading' && <LoadingMessage>Loading dashboard…</LoadingMessage>}

      {state.status === 'error' && <ErrorMessage>{state.message}</ErrorMessage>}

      {state.status === 'ready' && (
        <DashboardContent dashboard={state.dashboard} spaces={state.spaces} />
      )}
    </section>
  );
}

function DashboardContent({
  dashboard,
  spaces,
}: {
  dashboard: DashboardDTO;
  spaces: SpacesDTO | null;
}): JSX.Element {
  if (hasNoData(dashboard)) {
    return (
      <>
        <EmptyMessage>
          No data available. Load hub data with a refresh to populate the dashboard.
        </EmptyMessage>
        <FreshnessIndicator value={dashboard.lastSyncDate} />
      </>
    );
  }

  const spaceRows = spaces ? agentSpaceActivityRows(spaces) : [];

  return (
    <>
      <TotalsTable dashboard={dashboard} />
      <BreakdownTable dashboard={dashboard} />
      <AgentSpaceActivityTable rows={spaceRows} spacesAvailable={spaces !== null} />
      <FreshnessIndicator value={dashboard.lastSyncDate} />
    </>
  );
}

function TotalsTable({ dashboard }: { dashboard: DashboardDTO }): JSX.Element {
  return (
    <>
      <MetricCardGrid title="Totals" entries={totalEntries(dashboard.totals)} />
      <MetricCardGrid
        title="Capabilities configured"
        entries={capabilityEntries(dashboard.totals)}
      />
      <MetricCardGrid
        title="Monthly usage (current billing period)"
        entries={usageEntries(dashboard.totals)}
      />
    </>
  );
}

function MetricCardGrid({
  title,
  entries,
}: {
  title: string;
  entries: ReturnType<typeof totalEntries>;
}): JSX.Element {
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h3 style={subheadingStyle}>{title}</h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
          gap: '1rem',
        }}
      >
        {entries.map((entry) => (
          <div key={entry.key} style={cardStyle}>
            <p style={cardLabelStyle}>{entry.label}</p>
            <p style={{ margin: '0.5rem 0 0', fontSize: '2rem', fontWeight: 700, color: '#101828' }}>
              {entry.isHours ? formatHours(entry.value) : formatMetric(entry.value)}
            </p>
            <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem', color: '#667085' }}>
              {entry.hint}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownTable({ dashboard }: { dashboard: DashboardDTO }): JSX.Element {
  const groupLabel = groupingColumnLabel(dashboard.grouping);
  return (
    <div style={{ marginTop: '2rem' }}>
      <h3 style={subheadingStyle}>Breakdown by {groupLabel.toLowerCase()}</h3>
      <p style={{ margin: '0 0 0.75rem', color: '#667085', fontSize: '0.875rem' }}>
        {groupingDescription(dashboard.grouping)}
      </p>
      <div style={tableWrapStyle}>
        <table style={tableStyle}>
          <caption style={captionStyle}>
            Incident, investigation, agent-space, and configured-capability counts by{' '}
            {groupLabel.toLowerCase()}.
          </caption>
          <thead>
            <tr>
              <th scope="col" style={thStyle}>
                {groupLabel}
              </th>
              {DASHBOARD_BREAKDOWN_FIELDS.map((field) => (
                <th key={field.key} scope="col" style={thNumStyle}>
                  {field.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {dashboard.breakdown.map((r) => (
              <tr key={r.key}>
                <th scope="row" style={rowHeaderStyle}>
                  {r.key}
                </th>
                {DASHBOARD_BREAKDOWN_FIELDS.map((field) => (
                  <td key={field.key} style={tdNumStyle}>
                    {formatMetric(r.totals[field.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" style={{ ...rowHeaderStyle, fontWeight: 700 }}>
                Total
              </th>
              {DASHBOARD_BREAKDOWN_FIELDS.map((field) => (
                <td key={field.key} style={{ ...tdNumStyle, fontWeight: 700 }}>
                  {formatMetric(dashboard.totals[field.key])}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function AgentSpaceActivityTable({
  rows,
  spacesAvailable,
}: {
  rows: ReturnType<typeof agentSpaceActivityRows>;
  spacesAvailable: boolean;
}): JSX.Element {
  return (
    <div style={{ marginTop: '2rem' }}>
      <h3 style={subheadingStyle}>Agent space activity</h3>
      {!spacesAvailable ? (
        <EmptyMessage compact>Per-agent-space activity is unavailable right now.</EmptyMessage>
      ) : rows.length === 0 ? (
        <EmptyMessage compact>No agent spaces were found across the linked accounts.</EmptyMessage>
      ) : (
        <div style={tableWrapStyle}>
          <table style={tableStyle}>
            <caption style={captionStyle}>
              Recommendations, associations, and assets for each agent space.
            </caption>
            <thead>
              <tr>
                <th scope="col" style={thStyle}>
                  Agent space
                </th>
                <th scope="col" style={thStyle}>
                  Account
                </th>
                {AGENT_SPACE_ACTIVITY_FIELDS.map((field) => (
                  <th key={field.key} scope="col" style={thNumStyle}>
                    {field.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row" style={rowHeaderStyle}>
                    {row.spaceName}
                  </th>
                  <td style={tdStyle}>{row.accountLabel}</td>
                  {AGENT_SPACE_ACTIVITY_FIELDS.map((field) => (
                    <td key={field.key} style={tdNumStyle}>
                      {formatMetric(row.counts[field.key])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared inline styles (kept consistent with the Summary and Space views)
// ---------------------------------------------------------------------------

const subheadingStyle = {
  margin: '0 0 0.75rem',
  fontSize: '1rem',
  color: '#101828',
} as const;

const cardStyle = {
  border: '1px solid #eaecf0',
  borderRadius: 12,
  padding: '1.25rem',
  background: '#fff',
  boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
} as const;

const cardLabelStyle = {
  margin: 0,
  fontSize: '0.8125rem',
  fontWeight: 600,
  color: '#475467',
  textTransform: 'uppercase',
  letterSpacing: '0.02em',
} as const;

const tableWrapStyle = {
  border: '1px solid #eaecf0',
  borderRadius: 12,
  background: '#fff',
  boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
  overflowX: 'auto',
} as const;

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: '0.9375rem',
} as const;

const captionStyle = {
  captionSide: 'top',
  textAlign: 'left',
  padding: '0.75rem 1rem 0',
  fontSize: '0.75rem',
  color: '#98a2b3',
} as const;

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

const thNumStyle = { ...thStyle, textAlign: 'right' } as const;

const rowHeaderStyle = {
  textAlign: 'left',
  padding: '0.625rem 1rem',
  borderBottom: '1px solid #f2f4f7',
  fontWeight: 600,
  color: '#101828',
} as const;

const tdStyle = {
  textAlign: 'left',
  padding: '0.625rem 1rem',
  borderBottom: '1px solid #f2f4f7',
  color: '#344054',
} as const;

const tdNumStyle = {
  ...tdStyle,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  color: '#101828',
} as const;
