import type { CSSProperties } from 'react';
import type { LastSyncDate } from '@devops-observatory/shared-types';
import { freshnessDisplay, LAST_SYNC_LABEL } from '../lib/viewState';

/**
 * Shared Last_Sync_Date indicator for the primary data views (Task 17 —
 * Requirements 4.1, 4.3, 4.4).
 *
 * Renders the Last_Sync_Date (manifest `collectedAt`) as a UTC date-time with an
 * explicit "UTC" time-zone indicator (4.1). When the value is missing, stale, or
 * invalid it shows an explicit "data freshness unknown" indicator instead of a
 * blank, placeholder, cached, or invalid timestamp (4.3, 4.4) — the decision is
 * made by {@link freshnessDisplay}, so every view renders freshness identically
 * (Correctness Property 3).
 *
 * The unknown state is coloured with a warning tone so it reads as a caveat
 * rather than data. Pass `compact` for the smaller, in-card placement used by
 * the Space_View account headers.
 */
export function FreshnessIndicator({
  value,
  label = LAST_SYNC_LABEL,
  compact = false,
  style,
}: {
  value: LastSyncDate | null | undefined;
  label?: string;
  compact?: boolean;
  style?: CSSProperties;
}): JSX.Element {
  const { known, text } = freshnessDisplay(value);
  // Known freshness uses a muted body tone; the unknown indicator uses a warning
  // tone so it is clearly a caveat (Requirements 4.3, 4.4). Compact placements
  // use the muted grey to fit inside a card header.
  const knownColor = compact ? '#667085' : '#475467';
  const base: CSSProperties = compact
    ? { margin: '0.5rem 0 0', fontSize: '0.8125rem' }
    : { marginTop: '1.5rem', fontSize: '0.9375rem' };
  return (
    <p style={{ ...base, color: known ? knownColor : '#93370d', ...style }}>
      <strong style={{ fontWeight: 600 }}>{label}:</strong> {text}
    </p>
  );
}
