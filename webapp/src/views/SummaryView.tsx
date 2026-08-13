import { useEffect, useState } from 'react';
import type { SummaryDTO } from '@devops-observatory/shared-types';
import { fetchSummary } from '../api/summary';
import { capabilityEntries, usageEntries } from '../lib/dashboardView';
import { formatHours, formatNullableMetric, UNKNOWN_METRIC_HINT } from '../lib/format';
import { resolveErrorMessage } from '../lib/viewState';
import { LoadingMessage, ErrorMessage } from '../components/StateMessage';
import { FreshnessIndicator } from '../components/FreshnessIndicator';

/**
 * Default Summary landing view (Task 11 — Requirement 11.1).
 *
 * This is the view presented immediately after sign-in, before any detailed
 * view is opened. It surfaces the high-level totals — total Incident count,
 * total Investigation count, and Agent_Space usage — plus the Last_Sync_Date,
 * all read from `GET /summary`.
 *
 * Freshness handling (Requirements 4.3, 4.4): the backend returns a
 * freshness-unknown marker with zeroed totals when the manifest is unavailable,
 * and {@link formatLastSync} renders "Data freshness unknown" rather than a
 * stale or blank timestamp.
 *
 * Requirement 11.2 (enriched labels): this view shows only aggregate counts and
 * a human-readable date — no raw AWS account ids or UUIDs. Business-oriented
 * breakdowns by Business_Unit/account are built in the Dashboard (Task 13).
 */
type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; summary: SummaryDTO }
  | { status: 'error'; message: string };

export function SummaryView(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    fetchSummary()
      .then((summary) => {
        if (active) {
          setState({ status: 'ready', summary });
        }
      })
      .catch((err: unknown) => {
        if (!active) {
          return;
        }
        const message = resolveErrorMessage(
          err,
          'Unable to load the summary right now. Please try again.',
        );
        setState({ status: 'error', message });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section aria-labelledby="summary-heading">
      <h2 id="summary-heading" style={{ marginTop: 0 }}>
        Summary
      </h2>
      <p style={{ color: '#475467', marginTop: '-0.25rem' }}>
        A high-level view of activity across all linked accounts.
      </p>

      {state.status === 'loading' && <LoadingMessage>Loading summary…</LoadingMessage>}

      {state.status === 'error' && <ErrorMessage>{state.message}</ErrorMessage>}

      {state.status === 'ready' && <SummaryMetrics summary={state.summary} />}
    </section>
  );
}

function SummaryMetrics({ summary }: { summary: SummaryDTO }): JSX.Element {
  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
          marginTop: '1.5rem',
        }}
      >
        <MetricCard
          label="Incidents"
          value={summary.totals.incidents}
          hint="Investigations plus open recommendations"
        />
        <MetricCard
          label="Investigations"
          value={summary.totals.investigations}
          hint="Across all agent spaces"
        />
        <MetricCard
          label="Agent space usage"
          value={summary.totals.agentSpaces}
          hint="Total agent spaces in scope"
        />
      </div>

      {/* Organization-wide capability rollups: number of each capability
          configured across all agent spaces (counts only), plus log-delivery
          endpoints and operator-app user access. */}
      <h3 style={{ margin: '1.75rem 0 0', fontSize: '1rem', color: '#101828' }}>
        Capabilities configured
      </h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
          marginTop: '0.75rem',
        }}
      >
        {capabilityEntries(summary.totals).map((entry) => (
          <MetricCard
            key={entry.key}
            label={entry.label}
            value={entry.value}
            hint={entry.hint}
          />
        ))}
      </div>

      {/* Monthly usage (current billing period) across all accounts. */}
      <h3 style={{ margin: '1.75rem 0 0', fontSize: '1rem', color: '#101828' }}>
        Monthly usage (current billing period)
      </h3>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: '1rem',
          marginTop: '0.75rem',
        }}
      >
        {usageEntries(summary.totals).map((entry) => (
          <MetricCard
            key={entry.key}
            label={entry.label}
            value={entry.value}
            hint={entry.hint}
            isHours
          />
        ))}
      </div>

      <FreshnessIndicator value={summary.lastSyncDate} />
    </>
  );
}

function MetricCard({
  label,
  value,
  hint,
  isHours,
}: {
  label: string;
  /** null = unknown (not collected): rendered as "—", never a false 0. */
  value: number | null;
  hint: string;
  isHours?: boolean;
}): JSX.Element {
  return (
    <div
      style={{
        border: '1px solid #eaecf0',
        borderRadius: 12,
        padding: '1.25rem',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(16, 24, 40, 0.05)',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: '0.8125rem',
          fontWeight: 600,
          color: '#475467',
          textTransform: 'uppercase',
          letterSpacing: '0.02em',
        }}
      >
        {label}
      </p>
      <p
        style={{ margin: '0.5rem 0 0', fontSize: '2rem', fontWeight: 700, color: '#101828' }}
        {...(value === null ? { title: UNKNOWN_METRIC_HINT } : {})}
      >
        {value === null ? formatNullableMetric(value) : isHours ? formatHours(value) : formatNullableMetric(value)}
      </p>
      <p style={{ margin: '0.375rem 0 0', fontSize: '0.8125rem', color: '#667085' }}>
        {value === null ? UNKNOWN_METRIC_HINT : hint}
      </p>
    </div>
  );
}
