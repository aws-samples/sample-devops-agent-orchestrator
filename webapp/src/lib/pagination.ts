/**
 * Pure, DOM-free client-side pagination (Requirement 3.9, 5.12).
 *
 * The Manifest can list thousands of Linked_Accounts, so the Space_View and the
 * Context_Manager never render the whole list at once — they page through it.
 * This helper is deterministic and side-effect free so it can be unit-tested
 * with the repo's `node:test` + tsx convention and reused by any view.
 */

/** Default number of items shown per page across the paginated views. */
export const DEFAULT_PAGE_SIZE = 25;

/** A single page of results plus the metadata a pager needs to render. */
export interface Page<T> {
  /** The items on the (clamped) current page. */
  items: T[];
  /** The clamped, 1-based current page number. */
  page: number;
  /** The page size actually applied. */
  pageSize: number;
  /** Total number of items across all pages (before slicing). */
  totalItems: number;
  /** Total number of pages (at least 1, even when empty). */
  totalPages: number;
  /** True when a previous page exists. */
  hasPrev: boolean;
  /** True when a next page exists. */
  hasNext: boolean;
  /** 1-based index of the first item shown (0 when empty). */
  startIndex: number;
  /** 1-based index of the last item shown (0 when empty). */
  endIndex: number;
}

/**
 * Slice `items` to the requested page. The requested `page` is clamped into the
 * valid range so an out-of-bounds page (e.g. after the list shrinks from a
 * search) never yields an empty view when items exist. A non-positive
 * `pageSize` falls back to {@link DEFAULT_PAGE_SIZE}.
 */
export function paginate<T>(
  items: T[],
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE,
): Page<T> {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.trunc(pageSize) : DEFAULT_PAGE_SIZE;
  const totalItems = items.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / size));
  const requested = Number.isFinite(page) && page > 0 ? Math.trunc(page) : 1;
  const current = Math.min(requested, totalPages);
  const start = (current - 1) * size;
  const pageItems = items.slice(start, start + size);
  return {
    items: pageItems,
    page: current,
    pageSize: size,
    totalItems,
    totalPages,
    hasPrev: current > 1,
    hasNext: current < totalPages,
    startIndex: totalItems === 0 ? 0 : start + 1,
    endIndex: start + pageItems.length,
  };
}
