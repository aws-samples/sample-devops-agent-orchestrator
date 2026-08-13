import { useMemo, useState, type CSSProperties } from 'react';
import { useAuth } from '../auth/AuthContext';
import { SummaryView } from '../views/SummaryView';
import { SpaceView } from '../views/SpaceView';
import { DashboardView } from '../views/DashboardView';
import { GraphView } from '../views/GraphView';
import { ChatView } from '../views/ChatView';
import { ContextManagerView } from '../views/ContextManagerView';
import { RefreshView } from '../views/RefreshView';
import { SettingsView } from '../views/SettingsView';
import {
  DEFAULT_VIEW,
  resolveVisibleView,
  visibleNavItems,
  type NavItem,
  type ViewId,
} from './navItems';

/**
 * SPA navigation shell (Task 11 — Requirements 11.2, 11.3, 11.4).
 *
 * Renders a persistent navigation control that keeps the same screen position
 * across every view (a fixed left sidebar) with a selectable link to each view
 * (Requirement 11.3), and visually marks the active view (Requirement 11.4).
 * The Summary view is shown by default, before any detailed view is opened
 * (Requirement 11.1).
 *
 * View switching is client-side state (no router dependency): selecting a nav
 * link swaps the content region while the nav itself stays mounted in place, so
 * its position is identical across views. Admin-only links are only shown to
 * Admin users (Requirement 2.1); the backend still authorizes those routes.
 *
 * Enriched labels (Requirement 11.2): the shell shows the signed-in user's name
 * and role, and each nav entry uses a business-oriented label — no raw AWS
 * account ids or UUIDs appear in the chrome.
 */
export function NavShell(): JSX.Element {
  const { user, signOut } = useAuth();
  const role = user?.role ?? 'Executive';
  const items = useMemo(() => visibleNavItems(role), [role]);
  const [activeView, setActiveView] = useState<ViewId>(DEFAULT_VIEW);

  // Guard against ever showing a view the current role may not access.
  const active = resolveVisibleView(role, activeView);

  return (
    <div
      style={{
        fontFamily: 'system-ui, sans-serif',
        minHeight: '100vh',
        display: 'flex',
        color: '#101828',
        background: '#f9fafb',
      }}
    >
      <nav
        aria-label="Primary"
        style={{
          width: 240,
          flexShrink: 0,
          borderRight: '1px solid #eaecf0',
          background: '#fff',
          padding: '1.5rem 1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '1.5rem',
          position: 'sticky',
          top: 0,
          alignSelf: 'flex-start',
          height: '100vh',
          boxSizing: 'border-box',
        }}
      >
        <div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: '1.0625rem' }}>Enterprise DevOps Observatory</p>
          <p style={{ margin: '0.25rem 0 0', fontSize: '0.75rem', color: '#667085' }}>
            Cross-account insights
          </p>
        </div>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.25rem' }}>
          {items.map((item) => (
            <li key={item.id}>
              <NavLink
                item={item}
                isActive={item.id === active}
                onSelect={() => setActiveView(item.id)}
              />
            </li>
          ))}
        </ul>

        <div style={{ marginTop: 'auto' }}>
          <p style={{ margin: '0 0 0.5rem', fontSize: '0.8125rem', color: '#475467' }}>
            <span style={{ fontWeight: 600 }}>{user?.username}</span>
            <br />
            <span style={{ color: '#667085' }}>{user?.role}</span>
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            style={{
              width: '100%',
              padding: '0.5rem 0.875rem',
              borderRadius: 6,
              border: '1px solid #d0d5dd',
              background: '#fff',
              cursor: 'pointer',
              fontSize: '0.875rem',
            }}
          >
            Sign out
          </button>
        </div>
      </nav>

      <main style={{ flex: 1, padding: '2rem 2.5rem', maxWidth: 1100 }}>
        <ActiveView view={active} />
      </main>
    </div>
  );
}

function NavLink({
  item,
  isActive,
  onSelect,
}: {
  item: NavItem;
  isActive: boolean;
  onSelect: () => void;
}): JSX.Element {
  const baseStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '0.5rem 0.75rem',
    borderRadius: 6,
    border: 'none',
    cursor: 'pointer',
    fontSize: '0.9375rem',
    fontWeight: isActive ? 600 : 500,
    background: isActive ? '#eff4ff' : 'transparent',
    color: isActive ? '#175cd3' : '#344054',
  };
  return (
    <button
      type="button"
      onClick={onSelect}
      title={item.description}
      // Marks the active view for assistive tech (Requirement 11.4).
      aria-current={isActive ? 'page' : undefined}
      style={baseStyle}
    >
      {item.label}
    </button>
  );
}

/** Map the active view id to its content. The Admin-only Context_Manager and
 * Refresh views (Task 16) are only reachable when {@link resolveVisibleView}
 * permits them for the current role, and each re-asserts the Admin role itself. */
function ActiveView({ view }: { view: ViewId }): JSX.Element {
  switch (view) {
    case 'summary':
      return <SummaryView />;
    case 'spaces':
      return <SpaceView />;
    case 'dashboard':
      return <DashboardView />;
    case 'graph':
      return <GraphView />;
    case 'chat':
      return <ChatView />;
    case 'context':
      return <ContextManagerView />;
    case 'refresh':
      return <RefreshView />;
    case 'settings':
      return <SettingsView />;
    default:
      return <SummaryView />;
  }
}
