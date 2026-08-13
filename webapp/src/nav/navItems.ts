import type { UserRole } from '@devops-observatory/shared-types';

/**
 * Navigation registry for the SPA shell (Task 11 — Requirements 11.3, 11.4).
 *
 * A single, ordered source of truth for the persistent navigation control that
 * is shared across every view. Keeping it pure (no React) lets the shell render
 * it consistently in the same screen position across views and lets us unit-test
 * the visibility/role rules with the repo's `node:test` convention.
 *
 * Admin-only entries (Context_Manager, Refresh) are declared here but only
 * surfaced to Admin users; the backend still enforces authorization on those
 * routes (Requirements 2.3–2.5). Tasks 12–16 build out each view's content.
 */

/** Stable identifier for each top-level view. */
export type ViewId =
  | 'summary'
  | 'spaces'
  | 'dashboard'
  | 'graph'
  | 'chat'
  | 'context'
  | 'refresh'
  | 'settings';

export interface NavItem {
  id: ViewId;
  /** Business-oriented label shown in the nav (never a raw id). */
  label: string;
  /** Short description for tooltip / accessibility context. */
  description: string;
  /** When true, only visible to Admin users (Requirement 2.1). */
  adminOnly?: boolean;
}

/**
 * The default view presented immediately after sign-in, before any detailed
 * view is opened (Requirement 11.1).
 */
export const DEFAULT_VIEW: ViewId = 'summary';

/** Ordered navigation entries, rendered top-to-bottom in the persistent nav. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    id: 'summary',
    label: 'Summary',
    description: 'High-level totals and data freshness across all accounts.',
  },
  {
    id: 'spaces',
    label: 'Spaces',
    description: 'Agent spaces grouped by account and business unit.',
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    description: 'Incident, investigation, and usage breakdowns.',
  },
  {
    id: 'graph',
    label: 'Graph',
    description: 'Cross-account topology of accounts, spaces, and services.',
  },
  {
    id: 'chat',
    label: 'Chat',
    description: 'Ask questions about the DevOps knowledge base.',
  },
  {
    id: 'context',
    label: 'Context Manager',
    description: 'Define business units and account display names.',
    adminOnly: true,
  },
  {
    id: 'refresh',
    label: 'Refresh',
    description: 'Trigger and monitor a data refresh.',
    adminOnly: true,
  },
  {
    // Visible to every user since Task 39: the "Connect your AI app" (external
    // MCP) instructions live here for Executives too. Admin-only configuration
    // inside the view (retention, external-access toggle, A2A tokens) is gated
    // per-section by role, and the backend re-asserts Admin on every write.
    id: 'settings',
    label: 'Settings',
    description: 'Connect your AI app, and (Admins) configure application settings.',
  },
] as const;

/**
 * The navigation entries visible to a given role: Admins see every entry;
 * Executives see all non-admin entries (Requirement 2.1). Order is preserved.
 */
export function visibleNavItems(role: UserRole): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.adminOnly || role === 'Admin');
}

/**
 * Resolve a requested view to one the given role may actually see. Falls back
 * to {@link DEFAULT_VIEW} when the target is unknown or not permitted, so an
 * Executive can never land on an Admin-only view.
 */
export function resolveVisibleView(role: UserRole, requested: ViewId): ViewId {
  return visibleNavItems(role).some((item) => item.id === requested)
    ? requested
    : DEFAULT_VIEW;
}
