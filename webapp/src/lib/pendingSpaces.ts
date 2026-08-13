/**
 * Client-side "pending refresh" markers for agent spaces.
 *
 * When an Admin initiates space creation (single or batch) we do NOT re-fetch
 * the listing (creation is asynchronous and the new space only appears after
 * the next data refresh). Instead we record the affected account ids here and
 * show a "Pending refresh" badge until a later spaces fetch shows the account
 * actually has spaces, at which point the marker is reconciled away.
 *
 * Persistence uses `localStorage` so the markers survive a page reload; when
 * `localStorage` is unavailable (SSR / tests) it falls back to an in-memory
 * store. The pure set helpers are exported for unit testing.
 */

const STORAGE_KEY = 'devopsobs.pendingSpaceAccounts';

let memoryFallback: string[] = [];

function hasLocalStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function readRaw(): string[] {
  if (!hasLocalStorage()) return [...memoryFallback];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeRaw(ids: string[]): void {
  if (!hasLocalStorage()) {
    memoryFallback = [...ids];
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage full / disabled — degrade to in-memory so the session still works.
    memoryFallback = [...ids];
  }
}

/** Pure: union of the current ids and the newly-added ids, de-duplicated. */
export function withAdded(current: readonly string[], added: readonly string[]): string[] {
  return Array.from(new Set([...current, ...added]));
}

/** Pure: drop any pending id whose account now has spaces (resolved). */
export function withResolved(
  current: readonly string[],
  accountsWithSpaces: Iterable<string>,
): string[] {
  const resolved = new Set(accountsWithSpaces);
  return current.filter((id) => !resolved.has(id));
}

/** The set of account ids currently marked pending. */
export function getPendingSpaceAccounts(): Set<string> {
  return new Set(readRaw());
}

/** Mark one or more accounts as having a pending space creation. */
export function markSpacesPending(accountIds: readonly string[]): void {
  writeRaw(withAdded(readRaw(), accountIds));
}

/**
 * Reconcile markers against the accounts that now actually have spaces, removing
 * any that are resolved. Returns the remaining pending set for immediate use.
 */
export function reconcilePendingSpaces(accountsWithSpaces: Iterable<string>): Set<string> {
  const remaining = withResolved(readRaw(), accountsWithSpaces);
  writeRaw(remaining);
  return new Set(remaining);
}
