import type { CSSProperties, ReactNode } from 'react';

/**
 * Shared, reusable state-message components for the primary data views
 * (Task 17 — cross-cutting).
 *
 * The Summary, Space_View, and Dashboard previously each re-declared identical
 * loading / error / no-data markup inline. Centralising them here keeps the
 * loading, error, and empty states visually and semantically consistent across
 * every view (Requirements 3.7, 6.8), with the correct ARIA roles so assistive
 * technology announces them (`status` for loading/empty, `alert` for errors).
 */

/** In-progress indicator shown while a data view is loading. */
export function LoadingMessage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p role="status" aria-live="polite" style={{ color: '#475467' }}>
      {children}
    </p>
  );
}

/**
 * Error banner shown when a data load fails. Uses `role="alert"` so the failure
 * is announced, and never leaves the view blank without an explanation.
 */
export function ErrorMessage({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p
      role="alert"
      style={{
        color: '#b42318',
        background: '#fef3f2',
        border: '1px solid #fecdca',
        borderRadius: 8,
        padding: '0.875rem 1rem',
      }}
    >
      {children}
    </p>
  );
}

/**
 * No-data / empty-state notice. Used both for a fully empty view (e.g. no
 * accounts, no dashboard rows — Requirement 6.8) and for a per-item zero-data
 * indication (e.g. an account with no collected spaces — Requirements 3.6,
 * 12.4). Pass `compact` for the inline, in-card variant.
 */
export function EmptyMessage({
  children,
  compact = false,
  style,
}: {
  children: ReactNode;
  compact?: boolean;
  style?: CSSProperties;
}): JSX.Element {
  const base: CSSProperties = compact
    ? {
        margin: 0,
        padding: '0.75rem 1rem',
        border: '1px dashed #d0d5dd',
        borderRadius: 8,
        color: '#667085',
        background: '#fcfcfd',
        fontSize: '0.9375rem',
      }
    : {
        marginTop: '1.5rem',
        padding: '1rem 1.25rem',
        border: '1px dashed #d0d5dd',
        borderRadius: 12,
        color: '#667085',
        background: '#fcfcfd',
      };
  return (
    <p role="status" style={{ ...base, ...style }}>
      {children}
    </p>
  );
}
