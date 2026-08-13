import type { Page } from '../lib/pagination';

/**
 * Shared pagination control (Requirements 3.9, 5.12).
 *
 * Renders a "Showing X–Y of N" range with Previous / Next buttons, driven by a
 * {@link Page} produced by the pure `paginate` helper. Kept presentational and
 * reusable so the Space_View and Context_Manager page through potentially
 * thousands of Linked_Accounts with identical, accessible controls. Renders
 * nothing when everything fits on a single page.
 */
export function Pager<T>({
  page,
  onPageChange,
  unit = 'items',
}: {
  page: Page<T>;
  onPageChange: (page: number) => void;
  /** Plural noun for the range label, e.g. "accounts". */
  unit?: string;
}): JSX.Element | null {
  if (page.totalPages <= 1) return null;

  return (
    <nav
      aria-label="Pagination"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.5rem 1rem',
        marginTop: '1rem',
      }}
    >
      <span role="status" aria-live="polite" style={{ color: '#667085', fontSize: '0.8125rem' }}>
        Showing {page.startIndex}–{page.endIndex} of {page.totalItems} {unit}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <button
          type="button"
          onClick={() => onPageChange(page.page - 1)}
          disabled={!page.hasPrev}
          aria-label="Previous page"
          style={pagerButtonStyle(!page.hasPrev)}
        >
          ← Previous
        </button>
        <span style={{ color: '#344054', fontSize: '0.8125rem', minWidth: 88, textAlign: 'center' }}>
          Page {page.page} of {page.totalPages}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(page.page + 1)}
          disabled={!page.hasNext}
          aria-label="Next page"
          style={pagerButtonStyle(!page.hasNext)}
        >
          Next →
        </button>
      </div>
    </nav>
  );
}

function pagerButtonStyle(disabled: boolean) {
  return {
    padding: '0.375rem 0.75rem',
    borderRadius: 6,
    border: '1px solid #d0d5dd',
    background: disabled ? '#f9fafb' : '#fff',
    color: disabled ? '#98a2b3' : '#344054',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: '0.875rem',
  } as const;
}
