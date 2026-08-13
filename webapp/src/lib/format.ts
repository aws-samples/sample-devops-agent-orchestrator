import type { LastSyncDate } from '@devops-observatory/shared-types';

/**
 * Presentation helpers for the SPA (Task 11).
 *
 * These are pure, DOM-free formatters so they can be unit-tested with the
 * repo's `node:test` + tsx convention and reused across views.
 */

/** Shown whenever Last_Sync_Date is missing/invalid (Requirements 4.3, 4.4). */
export const FRESHNESS_UNKNOWN_LABEL = 'Data freshness unknown';

/**
 * Render a {@link LastSyncDate} as a human-friendly string.
 *
 * Returns {@link FRESHNESS_UNKNOWN_LABEL} for the literal `"unknown"`, an empty
 * value, or any string that does not parse to a real date — the UI must never
 * show a stale or blank timestamp (Requirements 4.3, 4.4, 11.1). A valid
 * ISO-8601 timestamp is formatted in UTC for a stable, locale-independent
 * display.
 */
export function formatLastSync(value: LastSyncDate | null | undefined): string {
  if (value == null || value === 'unknown' || value === '') {
    return FRESHNESS_UNKNOWN_LABEL;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return FRESHNESS_UNKNOWN_LABEL;
  }
  return `${date.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
    hour12: false,
  })} UTC`;
}

/** True when a Last_Sync_Date is a real, displayable timestamp. */
export function isFreshnessKnown(value: LastSyncDate | null | undefined): boolean {
  return formatLastSync(value) !== FRESHNESS_UNKNOWN_LABEL;
}

/** Format an integer metric with thousands separators (e.g. 1234 -> "1,234"). */
export function formatMetric(value: number): string {
  if (!Number.isFinite(value)) {
    return '0';
  }
  return Math.trunc(value).toLocaleString('en-US');
}

/** Format a usage-hours metric with 2 decimal places (e.g. 2.7553 -> "2.76"). */
export function formatHours(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '0.00';
  return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Shown for a capability metric the collector could not retrieve. */
export const UNKNOWN_METRIC_LABEL = '—';

/** Tooltip/title explaining an unknown capability metric. */
export const UNKNOWN_METRIC_HINT =
  'Not collected — the metric could not be retrieved during the last refresh.';

/**
 * Format a nullable capability metric. `null` means UNKNOWN — the collector
 * could not retrieve the metric (permission gap, API error, non-enumerable
 * operator-app mode) or the data predates capability tracking — and renders as
 * {@link UNKNOWN_METRIC_LABEL} instead of a false 0, keeping the UI aligned
 * with what actually happened in the backend.
 */
export function formatNullableMetric(value: number | null): string {
  return value === null ? UNKNOWN_METRIC_LABEL : formatMetric(value);
}
