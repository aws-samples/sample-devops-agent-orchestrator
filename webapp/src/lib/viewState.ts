import type { LastSyncDate } from '@devops-observatory/shared-types';
import { FRESHNESS_UNKNOWN_LABEL, formatLastSync, isFreshnessKnown } from './format';

/**
 * Cross-cutting, DOM-free presentation helpers for data-freshness display and
 * consistent no-data / error messaging across the primary views (Task 17).
 *
 * These back the shared React components in `src/components/` and are kept pure
 * so they can be unit-tested with the repo's `node:test` + tsx convention
 * (no Amplify/DOM imports). They centralise behaviour that the Summary,
 * Space_View, and Dashboard previously duplicated inline.
 *
 * Requirements: 4.1 (Last_Sync_Date with date, time, and an explicit time-zone
 * indicator), 4.3/4.4 (never show a blank, placeholder, cached, or invalid
 * timestamp — show "data freshness unknown" instead), 12.4 (a zero-data
 * account is represented rather than aborting the load).
 */

// ---------------------------------------------------------------------------
// Consistent, reusable copy for the shared state components
// ---------------------------------------------------------------------------

/** Default label preceding a Last_Sync_Date value (Requirement 4.1). */
export const LAST_SYNC_LABEL = 'Last sync date';

/** Generic fallback shown when a data load fails (Requirements 3.7, 6.8). */
export const GENERIC_LOAD_ERROR = 'Something went wrong loading this data. Please try again.';

/** Shown per account when it has no collected spaces/data (Requirements 3.6, 12.4). */
export const NO_ACCOUNT_DATA_MESSAGE = 'No agent spaces were found for this account.';

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** Resolved freshness for rendering: whether it is known and the text to show. */
export interface FreshnessDisplay {
  /** True when the value is a real, displayable timestamp. */
  known: boolean;
  /**
   * The text to render: a UTC date-time with an explicit "UTC" time-zone
   * indicator when known (Requirement 4.1), or {@link FRESHNESS_UNKNOWN_LABEL}
   * when the value is missing, cached-but-stale, or invalid (Requirements 4.3,
   * 4.4). Never blank and never the raw/invalid input.
   */
  text: string;
}

/**
 * Resolve a {@link LastSyncDate} into a display decision.
 *
 * This is the single source of truth for freshness rendering (Correctness
 * Property 3): the returned `text` is either the manifest `collectedAt`
 * formatted in UTC with a time-zone indicator, or the explicit
 * "data freshness unknown" label — never blank, cached, or the invalid value.
 */
export function freshnessDisplay(value: LastSyncDate | null | undefined): FreshnessDisplay {
  const known = isFreshnessKnown(value);
  return { known, text: known ? formatLastSync(value) : FRESHNESS_UNKNOWN_LABEL };
}

// ---------------------------------------------------------------------------
// Error message resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a user-facing error message from a caught value.
 *
 * When the value is an {@link import('../api/client').ApiRequestError} (matched
 * structurally by its `name` so this helper stays free of the Amplify-backed
 * api client and remains unit-testable), its message is used; otherwise the
 * provided fallback is returned. This centralises the `err instanceof
 * ApiRequestError ? err.message : fallback` pattern the views repeated.
 */
export function resolveErrorMessage(err: unknown, fallback: string = GENERIC_LOAD_ERROR): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const named = err as { name?: unknown; message?: unknown };
    if (named.name === 'ApiRequestError' && typeof named.message === 'string' && named.message.length > 0) {
      return named.message;
    }
  }
  return fallback;
}
